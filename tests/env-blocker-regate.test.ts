/**
 * The environmental-blocker quarantine/re-gate/re-classification — contract
 * test for the v0.4.38 extraction (increment 10 of the stage.ts split).
 *
 * The SIXTH control-flow conversion: the block had ONE `break` (green-through)
 * and two fall-throughs (product re-classification; still-blocked → judge).
 * The break became the green-through variant; the fall-throughs collapsed into
 * one `blocked` variant carrying gate2 (the judge region reads
 * `latestGate = gate2 ?? gate` and the override arm mirrors its errors) and
 * null-or-value re-classification fields the caller assigns ONLY when non-null
 * (the v0.4.33 discipline: a fall-through that re-classified nothing leaves
 * attemptFaultClass / postRegateProductErrors exactly as inline left them).
 *
 * Real git worktrees for the quarantine (a scoped `git stash push -u` — the
 * only worktree mutation); build-runner mocked for the re-run verdicts (the
 * implementation-env-blocker.test.ts pattern). The phase-scoped re-gate grant
 * is an in/out holder consumed ONLY on a successful quarantine (T4.4: a failed
 * quarantine leaves it intact).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";

vi.mock("../src/build-runner.ts", async (importOriginal) => {
	const orig = await importOriginal<typeof import("../src/build-runner.ts")>();
	return {
		...orig,
		runBuildGate: vi.fn(() => ({
			pass: true, buildSuccess: true, allTestsPass: true, typecheckSuccess: true, inScopePass: false,
			ran: ["mock"], errors: [], outOfScopeErrors: [], baselineCheck: undefined,
		})),
		runDeliverableCheck: vi.fn(() => ({ pass: true, missing: [], ran: [] })),
		resetDeliverableCheckCache: vi.fn(),
	};
});
vi.mock("../src/build-runner/baseline.ts", async (importOriginal) => {
	const orig = await importOriginal<typeof import("../src/build-runner/baseline.ts")>();
	return { ...orig, clearBaselineCache: vi.fn() };
});

import { runEnvBlockerRegate } from "../src/stages/implementation/env-blocker-regate.ts";
import { runBuildGate, runDeliverableCheck, resetDeliverableCheckCache, type BuildGateResult } from "../src/build-runner.ts";
import { clearBaselineCache } from "../src/build-runner/baseline.ts";
import type { PipelineState, StageContext } from "../src/types.ts";

const buildGateMock = vi.mocked(runBuildGate);
const deliverableMock = vi.mocked(runDeliverableCheck);
const resetCacheMock = vi.mocked(resetDeliverableCheckCache);
const clearBaselineMock = vi.mocked(clearBaselineCache);

// ─── fixtures ────────────────────────────────────────────────────────────────

function git(cwd: string, ...args: string[]): string {
	return String(spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).stdout ?? "");
}

/** A real git repo with one FOREIGN tracked modification (the quarantine set). */
function makeRepo(prefix: string): { repo: string; foreign: string } {
	const repo = mkdtempSync(join(tmpdir(), prefix));
	git(repo, "init", "-q");
	git(repo, "config", "user.email", "t@t");
	git(repo, "config", "user.name", "t");
	mkdirSync(join(repo, "src"));
	writeFileSync(join(repo, "src/prod.ts"), "export const A = 1;\n");
	writeFileSync(join(repo, "src/foreign.ts"), "export const F = 1;\n"); // committed → tracked
	git(repo, "add", "-A");
	git(repo, "commit", "-qm", "seed");
	writeFileSync(join(repo, "src/foreign.ts"), "PRE-PHASE DIRT\n"); // foreign modification
	return { repo, foreign: "src/foreign.ts" };
}

const ctxOf = (out: { logs: string[] }): StageContext => ({
	task: "t", options: {}, state: {} as PipelineState,
	budget: { count: 0, check: () => true, spent: () => true },
	log: (line: string) => { out.logs.push(line); }, phase: () => {}, events: new EventEmitter(), results: [],
} as unknown as StageContext);

const OWN_SCOPE_GREEN = { changePass: true, symbolPass: true, tddClean: true };

const baseInput = (over: Partial<Parameters<typeof runEnvBlockerRegate>[0]> = {}) => ({
	ctx: ctxOf({ logs: [] }),
	state: {} as PipelineState,
	worktreePath: "",
	specDirectory: "",
	copiedEnvFiles: [] as string[],
	defaultBranch: undefined as string | undefined,
	phaseId: "phase-02",
	attempt: 1,
	foreignDirt: [] as string[],
	runStartSet: new Set<string>(),
	dirtExclusions: [] as string[],
	regateUsed: { used: false },
	bridgedDeliverables: {} as Parameters<typeof runEnvBlockerRegate>[0]["bridgedDeliverables"],
	ownScope: { ...OWN_SCOPE_GREEN },
	phaseStatus: [] as Array<{ id: string; status: string }>,
	lastFailures: [] as Array<{ phaseId: string; reasons: string[] }>,
	announceActivity: () => {},
	emitPhaseStatus: () => {},
	attemptDetail: (n: number) => `attempt ${n}`,
	...over,
});

const RED_GATE = (over: Partial<BuildGateResult> = {}): BuildGateResult => ({
	pass: false, buildSuccess: false, allTestsPass: false, typecheckSuccess: false, inScopePass: false,
	ran: ["mock"], errors: ["FAIL tests/other.test.ts > unrelated"], outOfScopeErrors: ["FAIL tests/other.test.ts > unrelated"],
	baselineCheck: { status: "regression", evidence: "suite passes at baseline" },
	...over,
});

beforeEach(() => { vi.clearAllMocks(); });
afterEach(() => { vi.unstubAllEnvs(); });

describe("env-blocker regate (v0.4.38 increment-10 extraction)", () => {
	it("NO foreign dirt → blocked with NOTHING ran: gate2 null, no re-classification, grant untouched", async () => {
		const out = await runEnvBlockerRegate(baseInput());
		expect(out).toEqual({ kind: "blocked", gate2: null, reRunClassifiedProduct: false, reclassifiedFaultClass: null, postRegateProductErrors: null });
		expect(buildGateMock).not.toHaveBeenCalled(); // no re-run without quarantine
	});

	it("the kill-switch (SUPER_DEV_NO_DIRTY_QUARANTINE=1) skips the quarantine arm entirely — detection never mutates", async () => {
		const { repo, foreign } = makeRepo("sd-regate-ks-");
		vi.stubEnv("SUPER_DEV_NO_DIRTY_QUARANTINE", "1");
		try {
			const regateUsed = { used: false };
			const out = await runEnvBlockerRegate(baseInput({ worktreePath: repo, foreignDirt: [foreign], runStartSet: new Set([foreign]), regateUsed }));
			expect(out.kind).toBe("blocked");
			if (out.kind !== "blocked") return;
			expect(out.gate2).toBeNull();
			expect(buildGateMock).not.toHaveBeenCalled();
			expect(regateUsed.used).toBe(false); // the grant is NEVER consumed without a quarantine
			// the foreign dirt is STILL on disk (detection only)
			expect(git(repo, "status", "--porcelain")).toContain(foreign);
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	});

	it("quarantine + GREEN re-run + green evidence → green-through: the foreign dirt is STASHED, the grant consumed, the baseline memo cleared, in-place mutations land", async () => {
		const { repo, foreign } = makeRepo("sd-regate-green-");
		const specDir = mkdtempSync(join(tmpdir(), "sd-regate-spec-")); // separate: the ledger must NOT dirty the worktree
		const logs: string[] = [];
		const phaseStatus: Array<{ id: string; status: string }> = [];
		const lastFailures = [{ phaseId: "phase-02", reasons: ["old"] }];
		const emitted: string[] = [];
		try {
			const regateUsed = { used: false };
			const out = await runEnvBlockerRegate(baseInput({
				ctx: ctxOf({ logs }),
				worktreePath: repo,
				specDirectory: specDir,
				foreignDirt: [foreign],
				runStartSet: new Set([foreign]),
				regateUsed,
				phaseStatus: phaseStatus as never,
				lastFailures: lastFailures as never,
				emitPhaseStatus: (s) => { emitted.push(s); },
			}));
			expect(out.kind).toBe("green-through");
			if (out.kind !== "green-through") return;
			expect(out.gateErrors).toEqual([]); // the mocked green re-run's errors
			// the quarantine REALLY stashed the foreign dirt (worktree clean, stash exists)
			expect(git(repo, "status", "--porcelain").trim()).toBe("");
			expect(git(repo, "stash", "list")).toContain("stage9 environmental-blocker");
			// the grant is consumed (exactly ONE re-run per phase)
			expect(regateUsed.used).toBe(true);
			// D-1a: the baseline memo was cleared BEFORE the re-run (invocation
			// ORDER, not just call count — a post-run clear would still pass count-only)
			expect(clearBaselineMock).toHaveBeenCalledTimes(1);
			expect(clearBaselineMock.mock.invocationCallOrder[0]).toBeLessThan(buildGateMock.mock.invocationCallOrder[0]!);
			// D-12: the deliverable check re-ran with skipTests:false after a cache reset
			expect(resetCacheMock).toHaveBeenCalledTimes(1);
			expect(deliverableMock).toHaveBeenCalledTimes(1);
			expect(deliverableMock.mock.calls[0]![2]).toMatchObject({ skipTests: false });
			// in-place mutations, exactly where inline did them
			expect(phaseStatus[0]).toMatchObject({ id: "phase-02", status: "green" });
			expect(lastFailures).toEqual([]);
			expect(emitted).toContain("ok");
		} finally {
			rmSync(repo, { recursive: true, force: true });
			rmSync(specDir, { recursive: true, force: true });
		}
	});

	it("re-run STILL RED → OBSERVED-provenance re-classification: product, the re-run's errors become the truth", async () => {
		const { repo, foreign } = makeRepo("sd-regate-red-");
		const specDir = mkdtempSync(join(tmpdir(), "sd-regate-spec-"));
		const logs: string[] = [];
		try {
			buildGateMock.mockReturnValueOnce(RED_GATE());
			const out = await runEnvBlockerRegate(baseInput({
				ctx: ctxOf({ logs }),
				worktreePath: repo,
				specDirectory: specDir,
				foreignDirt: [foreign],
				runStartSet: new Set([foreign]),
			}));
			expect(out.kind).toBe("blocked");
			if (out.kind !== "blocked") return;
			// post-quarantine the foreign dirt is stashed → foreignDirtCount 0 → NOT environmental
			expect(out.reRunClassifiedProduct).toBe(true);
			expect(out.reclassifiedFaultClass).not.toBe("environmental-blocker");
			expect(out.reclassifiedFaultClass).not.toBeNull();
			expect(out.postRegateProductErrors).toEqual(RED_GATE().errors);
			expect(logs.some((l) => l.includes("post-quarantine re-run classified"))).toBe(true);
			expect(logs.some((l) => l.includes("environmental judge skipped"))).toBe(true);
		} finally {
			rmSync(repo, { recursive: true, force: true });
			rmSync(specDir, { recursive: true, force: true });
		}
	});

	it("re-run GREEN but the fresh deliverable check FAILS → adv-F5 re-classification: product (never the environmental judge)", async () => {
		const { repo, foreign } = makeRepo("sd-regate-dfail-");
		const specDir = mkdtempSync(join(tmpdir(), "sd-regate-spec-"));
		const logs: string[] = [];
		try {
			deliverableMock.mockReturnValueOnce({ pass: false, missing: ["missing deliverable: src/out.ts"], ran: [] } as ReturnType<typeof runDeliverableCheck>);
			const out = await runEnvBlockerRegate(baseInput({
				ctx: ctxOf({ logs }),
				worktreePath: repo,
				specDirectory: specDir,
				foreignDirt: [foreign],
				runStartSet: new Set([foreign]),
			}));
			expect(out.kind).toBe("blocked");
			if (out.kind !== "blocked") return;
			expect(out.reRunClassifiedProduct).toBe(true);
			expect(out.reclassifiedFaultClass).not.toBe("environmental-blocker");
			expect(logs.some((l) => l.includes("own-scope evidence not green"))).toBe(true);
		} finally {
			rmSync(repo, { recursive: true, force: true });
			rmSync(specDir, { recursive: true, force: true });
		}
	});

	it("the grant is ONE per phase: already spent → no quarantine, no re-run, blocked with nulls", async () => {
		const { repo, foreign } = makeRepo("sd-regate-spent-");
		try {
			const out = await runEnvBlockerRegate(baseInput({
				worktreePath: repo,
				foreignDirt: [foreign],
				runStartSet: new Set([foreign]),
				regateUsed: { used: true }, // spent in an earlier attempt
			}));
			expect(out).toEqual({ kind: "blocked", gate2: null, reRunClassifiedProduct: false, reclassifiedFaultClass: null, postRegateProductErrors: null });
			expect(buildGateMock).not.toHaveBeenCalled();
			// the foreign dirt was NOT stashed (no second quarantine)
			expect(git(repo, "status", "--porcelain")).toContain(foreign);
			expect(git(repo, "stash", "list").trim()).toBe("");
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	});
});
