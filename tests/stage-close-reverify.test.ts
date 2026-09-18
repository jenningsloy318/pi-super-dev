import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

// The git walk (merge-base/diff/status) runs REAL in a real temp worktree; the
// expensive gates are mocked so the flip adjudication is the unit under test.
vi.mock("../src/build-runner.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/build-runner.ts")>();
	return { ...actual, runBuildGate: vi.fn(), runDeliverableCheck: vi.fn() };
});
vi.mock("../src/stages/implementation/phase-status.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/stages/implementation/phase-status.ts")>();
	return { ...actual, deterministicPhaseCommit: vi.fn() };
});

const { runStageCloseReverify } = await import("../src/stages/implementation/stage-close-reverify.ts");
const { runBuildGate, runDeliverableCheck } = await import("../src/build-runner.ts");
const { deterministicPhaseCommit } = await import("../src/stages/implementation/phase-status.ts");

/** A real git repo whose default branch exists, so merge-base resolves and the
 *  porcelain arm populates the changed-set from uncommitted work. */
function makeWorktree(): { wt: string; clean: () => void } {
	const wt = mkdtempSync(join(tmpdir(), "inc22-reverify-"));
	const git = (args: string[]) => execFileSync("git", ["-C", wt, ...args], { encoding: "utf8" });
	git(["init", "-b", "main"]);
	writeFileSync(join(wt, "seed.txt"), "base\n");
	// docs/a.md is TRACKED (empty) in the base so a later write shows as a
	// modified FILE — porcelain collapses untracked dirs to "?? docs/", which
	// would never match a clause file path.
	mkdirSync(join(wt, "docs"), { recursive: true });
	writeFileSync(join(wt, "docs/a.md"), "");
	git(["add", "."]);
	git(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "base"]);
	return { wt, clean: () => rmSync(wt, { recursive: true, force: true }) };
}

interface Fixture {
	wt: string;
	clean: () => void;
}

function ctxOf(budgetCheck = true) {
	return {
		log: vi.fn(),
		phase: vi.fn(),
		signal: undefined,
		budget: { check: () => budgetCheck },
	} as unknown as Parameters<typeof runStageCloseReverify>[0]["ctx"];
}

function stateOf() {
	return { spec: { gate: undefined } } as unknown as Parameters<typeof runStageCloseReverify>[0]["state"];
}

function baseInput(f: Fixture, phases: unknown[], phaseStatus: Array<{ id: string; status: "green" | "failed" | "partial" }>, lastFailures: Parameters<typeof runStageCloseReverify>[0]["lastFailures"]) {
	return {
		ctx: ctxOf(),
		state: stateOf(),
		worktreePath: f.wt,
		defaultBranch: "main",
		worktreeCreated: true,
		phases,
		phaseStatus,
		envBlockedPhases: new Set<string>(),
		lastFailures,
	};
}

const satisfiedPhase = { name: "p1", deliverables: { requireContains: [{ file: "docs/a.md", pattern: "anchor present" }] } };

describe("runStageCloseReverify — increment 22 (stage-close re-verification, commit fusion)", () => {
	let f: Fixture;
	beforeEach(() => {
		f = { wt: "", clean: () => undefined };
		vi.mocked(runBuildGate).mockReset();
		vi.mocked(runDeliverableCheck).mockReset();
		vi.mocked(deterministicPhaseCommit).mockReset().mockReturnValue({ status: "committed", sha: "abc123", reason: "ok" } as never);
	});
	afterEach(() => f.clean());

	it("no flippable phases: zero flips, failure rows preserved verbatim, no build gate burned", () => {
		f = makeWorktree();
		// every phase GREEN already → reverifyPartialPhases finds nothing flippable
		const rows = [{ phaseId: "phase-01", reasons: ["stale"] }];
		const out = runStageCloseReverify(baseInput(f, [satisfiedPhase], [{ id: "phase-01", status: "green" }], rows));
		expect(out.flipsCompleted).toBe(0);
		expect(out.forceAllGreen).toBe(false);
		expect(out.lastFailuresOut).toBe(rows); // no-flip returns the SAME reference (identity contract)
		expect(out.lastFailuresOut).toEqual(rows);
		expect(runBuildGate).not.toHaveBeenCalled();
		expect(deterministicPhaseCommit).not.toHaveBeenCalled();
	});

	it("flips a partial phase whose clause file changed THIS RUN: upsert green, drop the stale failure row, deterministic close commit", () => {
		f = makeWorktree();
		mkdirSync(join(f.wt, "docs"), { recursive: true });
		writeFileSync(join(f.wt, "docs/a.md"), "anchor present\n"); // uncommitted → porcelain → changedThisRun
		vi.mocked(runBuildGate).mockReturnValue({ pass: true, inScopePass: true, errors: [], checked: [] } as never);
		vi.mocked(runDeliverableCheck).mockReturnValue({ pass: true, missing: [], hollow: [] } as never);
		const phaseStatus: Array<{ id: string; status: "green" | "failed" | "partial" }> = [{ id: "phase-01", status: "partial" }];
		const out = runStageCloseReverify(baseInput(f, [satisfiedPhase], phaseStatus, [
			{ phaseId: "phase-01", reasons: ["gate-window expiry"] },
			{ phaseId: "phase-99", reasons: ["stage-scoped"] }, // a different phase's row → survives the flip
		]));
		expect(out.flipsCompleted).toBe(1);
		expect(phaseStatus[0].status).toBe("green");
		expect(out.lastFailuresOut).toEqual([{ phaseId: "phase-99", reasons: ["stage-scoped"] }]);
		expect(deterministicPhaseCommit).toHaveBeenCalledWith(f.wt, expect.objectContaining({
			phaseIndex: 1,
			totalPhases: 1,
			phaseName: "p1",
			worktreeCreated: true,
			gateSummary: "stage-close re-verification: build green; deliverables met (full check)",
		}));
		// single-phase all-green → forceAllGreen
		expect(out.forceAllGreen).toBe(true);
	});

	it("pre-existing content cannot flip: a NON-EMPTY changed-set without the clause file keeps the phase PARTIAL (the hardening guard, not content absence)", () => {
		f = makeWorktree();
		// the anchor content is COMMITTED at base (deliverablesAlreadyMet passes), and
		// an unrelated uncommitted file makes the changed-set walk return a non-empty
		// set WITHOUT docs/a.md — the flip is blocked by the guard itself
		// (reverifyPartialPhases: "satisfied by pre-existing content"), the strongest
		// form: content satisfied + guard armed. The walk emitting NOTHING would degrade
		// touchedThisRun to true and flip — so this test fails if the walk breaks.
		writeFileSync(join(f.wt, "docs/a.md"), "anchor present\n");
		execFileSync("git", ["-C", f.wt, "add", "docs/a.md"]);
		execFileSync("git", ["-C", f.wt, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "land the anchor"]);
		writeFileSync(join(f.wt, "other.txt"), "unrelated dirt\n");
		const logs: string[] = [];
		const input = baseInput(f, [satisfiedPhase], [{ id: "phase-01", status: "partial" }], []);
		input.ctx = { ...input.ctx, log: ((m: string) => void logs.push(m)) } as never;
		const out = runStageCloseReverify(input);
		expect(out.flipsCompleted).toBe(0);
		expect(runBuildGate).not.toHaveBeenCalled(); // guard rejected before any gate burn
		expect(logs.join("\n")).toContain("satisfied by pre-existing content");
	});

	it("FULL deliverable check failure keeps the phase PARTIAL (honest) — no upsert, no commit", () => {
		f = makeWorktree();
		mkdirSync(join(f.wt, "docs"), { recursive: true });
		writeFileSync(join(f.wt, "docs/a.md"), "anchor present\n");
		vi.mocked(runBuildGate).mockReturnValue({ pass: true, inScopePass: true, errors: [], checked: [] } as never);
		vi.mocked(runDeliverableCheck).mockReturnValue({ pass: false, missing: ["docs/a.md: pattern absent"], hollow: [] } as never);
		const phaseStatus: Array<{ id: string; status: "green" | "failed" | "partial" }> = [{ id: "phase-01", status: "partial" }];
		const logs: string[] = [];
		const input = baseInput(f, [satisfiedPhase], phaseStatus, []);
		input.ctx = { ...input.ctx, log: ((m: string) => void logs.push(m)) } as never;
		const out = runStageCloseReverify(input);
		expect(out.flipsCompleted).toBe(0);
		expect(phaseStatus[0].status).toBe("partial");
		expect(deterministicPhaseCommit).not.toHaveBeenCalled();
		expect(logs.join("\n")).toContain("keeping PARTIAL (honest; requireTests/scenario sweep authoritative)");
	});

	it("stage build gate FAILED: flippable candidates stay PARTIAL (honest)", () => {
		f = makeWorktree();
		mkdirSync(join(f.wt, "docs"), { recursive: true });
		writeFileSync(join(f.wt, "docs/a.md"), "anchor present\n");
		vi.mocked(runBuildGate).mockReturnValue({ pass: false, inScopePass: false, errors: ["tsc: 1 error"], checked: [] } as never);
		const logs: string[] = [];
		const input = baseInput(f, [satisfiedPhase], [{ id: "phase-01", status: "partial" }], []);
		input.ctx = { ...input.ctx, log: ((m: string) => void logs.push(m)) } as never;
		const out = runStageCloseReverify(input);
		expect(out.flipsCompleted).toBe(0);
		expect(vi.mocked(runDeliverableCheck)).not.toHaveBeenCalled();
		expect(logs.join("\n")).toContain("the stage build gate FAILED — keeping PARTIAL (honest)");
	});

	it("review P3: forceAllGreen requires an entry for EVERY phase — a REPLAN-broken subset never claims all-green", () => {
		f = makeWorktree();
		mkdirSync(join(f.wt, "docs"), { recursive: true });
		writeFileSync(join(f.wt, "docs/a.md"), "anchor present\n");
		vi.mocked(runBuildGate).mockReturnValue({ pass: true, inScopePass: true, errors: [], checked: [] } as never);
		vi.mocked(runDeliverableCheck).mockReturnValue({ pass: true, missing: [], hollow: [] } as never);
		const phaseStatus: Array<{ id: string; status: "green" | "failed" | "partial" }> = [{ id: "phase-01", status: "partial" }];
		const out = runStageCloseReverify(baseInput(f, [satisfiedPhase, { name: "p2" }], phaseStatus, []));
		expect(out.flipsCompleted).toBe(1);
		// 1 status entry vs 2 phases — subset, not all-green
		expect(out.forceAllGreen).toBe(false);
	});

	it("budget exhausted: the flip still lands (status + failure splice) but the close commit is skipped", () => {
		f = makeWorktree();
		mkdirSync(join(f.wt, "docs"), { recursive: true });
		writeFileSync(join(f.wt, "docs/a.md"), "anchor present\n");
		vi.mocked(runBuildGate).mockReturnValue({ pass: true, inScopePass: true, errors: [], checked: [] } as never);
		vi.mocked(runDeliverableCheck).mockReturnValue({ pass: true, missing: [], hollow: [] } as never);
		const input = baseInput(f, [satisfiedPhase], [{ id: "phase-01", status: "partial" }], [{ phaseId: "phase-01", reasons: ["x"] }]);
		input.ctx = ctxOf(false);
		const out = runStageCloseReverify(input);
		expect(out.flipsCompleted).toBe(1);
		expect(out.lastFailuresOut).toEqual([]);
		expect(deterministicPhaseCommit).not.toHaveBeenCalled();
	});

	it("judge-owned env-blocked phases are never re-verified (pass-through to reverifyPartialPhases)", () => {
		f = makeWorktree();
		mkdirSync(join(f.wt, "docs"), { recursive: true });
		writeFileSync(join(f.wt, "docs/a.md"), "anchor present\n");
		const input = baseInput(f, [satisfiedPhase], [{ id: "phase-01", status: "partial" }], []);
		input.envBlockedPhases = new Set(["phase-01"]);
		const out = runStageCloseReverify(input);
		expect(out.flipsCompleted).toBe(0);
		expect(runBuildGate).not.toHaveBeenCalled();
	});
});
