import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

vi.mock("../src/build-runner.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/build-runner.ts")>();
	return { ...actual, deliverablesAlreadyMet: vi.fn(), runBuildGate: vi.fn(), runDeliverableCheck: vi.fn() };
});
vi.mock("../src/runlog.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/runlog.ts")>();
	return { ...actual, appendGateChecked: vi.fn() };
});

const { enterPhase } = await import("../src/stages/implementation/phase-entry.ts");
const { deliverablesAlreadyMet, runBuildGate, runDeliverableCheck } = await import("../src/build-runner.ts");

/** Real git repo so the F2 porcelain snapshot captures real dirt. */
function makeWorktree(): { wt: string; clean: () => void } {
	const wt = mkdtempSync(join(tmpdir(), "inc23-entry-"));
	const git = (args: string[]) => execFileSync("git", ["-C", wt, ...args], { encoding: "utf8" });
	git(["init", "-b", "main"]);
	writeFileSync(join(wt, "seed.txt"), "base\n");
	git(["add", "."]);
	git(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "base"]);
	return { wt, clean: () => rmSync(wt, { recursive: true, force: true }) };
}

function kitOf() {
	const kit = {
		ensurePhaseRunning: vi.fn(),
		announceActivity: vi.fn(),
		emitPhaseStatus: vi.fn(),
	};
	return kit;
}

function baseInput(f: { wt: string }, overrides: Partial<Parameters<typeof enterPhase>[0]> = {}) {
	const kit = kitOf();
	return {
		input: {
			ctx: { options: {}, log: vi.fn(), signal: undefined },
			state: { spec: { gate: undefined } },
			worktreePath: f.wt,
			defaultBranch: "main",
			phaseId: "phase-01",
			phaseDeliverables: { requireContains: [{ file: "docs/a.md", pattern: "anchor" }] },
			tracker: { begin: vi.fn() },
			phaseStatus: [] as Array<{ id: string; status: "green" | "failed" | "partial" }>,
			lastFailures: [] as Array<{ phaseId: string; reasons: string[] }>,
			phaseStartDirt: {} as Record<string, string[]>,
			...kit,
			...overrides,
		} as unknown as Parameters<typeof enterPhase>[0],
		kit,
	};
}

describe("enterPhase — increment 23 (resume no-op adjudication + phase-start capture)", () => {
	let f: { wt: string; clean: () => void };
	beforeEach(() => {
		f = makeWorktree();
		vi.mocked(deliverablesAlreadyMet).mockReset().mockReturnValue(false);
		vi.mocked(runBuildGate).mockReset();
		vi.mocked(runDeliverableCheck).mockReset();
	});
	afterEach(() => f.clean());

	it("fresh run (no resume): straight enter — no resume verification, no gate burn, seeds empty, tracker begins", () => {
		const { input, kit } = baseInput(f);
		const out = enterPhase(input);
		expect(out.kind).toBe("enter");
		if (out.kind !== "enter") return;
		expect(out.attemptErrors).toEqual([]);
		expect(out.missingDeliverables).toEqual([]);
		expect(deliverablesAlreadyMet).not.toHaveBeenCalled(); // the cheap pre-filter is resume-only
		expect(runBuildGate).not.toHaveBeenCalled();
		expect((input.tracker as unknown as { begin: ReturnType<typeof vi.fn> }).begin).toHaveBeenCalledWith("phase", "phase-01");
		expect(kit.ensurePhaseRunning).toHaveBeenCalled();
	});

	it("resume no-op VERIFIED: deliverables met + build gate + full deliverable check green ⇒ skip (upsert, row splice, ok row)", () => {
		vi.mocked(deliverablesAlreadyMet).mockReturnValue(true);
		vi.mocked(runBuildGate).mockReturnValue({ pass: true, inScopePass: true, errors: [], checked: [] } as never);
		vi.mocked(runDeliverableCheck).mockReturnValue({ pass: true, missing: [], hollow: [] } as never);
		const { input, kit } = baseInput(f);
		input.ctx = { ...input.ctx, options: { resume: true } } as never;
		input.lastFailures = [{ phaseId: "phase-01", reasons: ["prior partial"] }] as never;
		const out = enterPhase(input);
		expect(out.kind).toBe("skip");
		expect(input.phaseStatus).toEqual([{ id: "phase-01", status: "green" }]);
		expect(input.lastFailures).toEqual([]); // the stale row spliced in place
		expect(kit.emitPhaseStatus).toHaveBeenCalledWith("ok");
		expect(input.ctx.log).toHaveBeenCalledWith(expect.stringContaining("no-op: resume deliverables already satisfied and verified"));
		expect(runDeliverableCheck).toHaveBeenCalledWith(input.worktreePath, input.phaseDeliverables, expect.objectContaining({ skipTests: false }));
		// the skip path OMISSIONS (vector-A invariant: a skipped phase never gets a
		// subtitle, a tracker bracket, or a first-ever F2 snapshot - moving the return
		// below the capture block would otherwise pass the suite)
		expect((input.tracker as unknown as { begin: ReturnType<typeof vi.fn> }).begin).not.toHaveBeenCalled();
		expect(kit.announceActivity).not.toHaveBeenCalledWith(); // the no-arg subtitle never fires
		expect(input.phaseStartDirt["phase-01"]).toBeUndefined();
	});

	it("resume no-op REJECTED: verification failed ⇒ enter with the gate/check failures seeded into the retry prompt", () => {
		vi.mocked(deliverablesAlreadyMet).mockReturnValue(true);
		vi.mocked(runBuildGate).mockReturnValue({ pass: false, inScopePass: false, errors: ["tsc: 2 errors"], checked: [] } as never);
		vi.mocked(runDeliverableCheck).mockReturnValue({ pass: false, missing: ["docs/a.md: no anchor"], hollow: [] } as never);
		const { input } = baseInput(f);
		input.ctx = { ...input.ctx, options: { resume: "run-id" } } as never; // string resume also allows
		const out = enterPhase(input);
		expect(out.kind).toBe("enter");
		if (out.kind !== "enter") return;
		expect(out.attemptErrors).toEqual(["tsc: 2 errors"]);
		expect(out.missingDeliverables).toEqual(["docs/a.md: no anchor"]);
		expect(input.ctx.log).toHaveBeenCalledWith(expect.stringContaining("no-op rejected: resume verification failed"));
	});

	it("resume no-op REJECTED by the deliverable check alone: gate green but check red still enters (the AND is load-bearing)", () => {
		vi.mocked(deliverablesAlreadyMet).mockReturnValue(true);
		vi.mocked(runBuildGate).mockReturnValue({ pass: true, inScopePass: true, errors: [], checked: [] } as never);
		vi.mocked(runDeliverableCheck).mockReturnValue({ pass: false, missing: ["docs/a.md: anchor absent"], hollow: [] } as never);
		const { input } = baseInput(f);
		input.ctx = { ...input.ctx, options: { resume: true } } as never;
		const out = enterPhase(input);
		expect(out.kind).toBe("enter"); // gate green alone must NOT skip
		if (out.kind !== "enter") return;
		expect(out.missingDeliverables).toEqual(["docs/a.md: anchor absent"]);
		expect(out.attemptErrors).toEqual([]);
	});

	it("resume but deliverables NOT already met: the expensive gates never burn, straight enter with empty seeds", () => {
		vi.mocked(deliverablesAlreadyMet).mockReturnValue(false);
		const { input } = baseInput(f);
		input.ctx = { ...input.ctx, options: { resume: true } } as never;
		const out = enterPhase(input);
		expect(out.kind).toBe("enter");
		expect(runBuildGate).not.toHaveBeenCalled();
		expect(runDeliverableCheck).not.toHaveBeenCalled();
	});

	it("F2 first-ever snapshot: fresh phase captures the porcelain dirt; a §D re-entry REUSES the persisted snapshot", () => {
		writeFileSync(join(f.wt, "dirt.txt"), "uncommitted\n"); // pre-phase dirt
		const { input } = baseInput(f);
		const out1 = enterPhase(input);
		expect(out1.kind).toBe("enter");
		if (out1.kind !== "enter") return;
		expect([...out1.phaseStartSet]).toEqual(["dirt.txt"]); // normalized porcelain path
		expect(input.phaseStartDirt["phase-01"]).toEqual(["dirt.txt"]);
		// §D re-entry: the persisted snapshot must be reused, NOT re-captured
		writeFileSync(join(f.wt, "own-iteration-work.txt"), "later\n"); // edits after the first capture
		const out2 = enterPhase(input);
		expect(out2.kind).toBe("enter");
		if (out2.kind !== "enter") return;
		expect([...out2.phaseStartSet]).toEqual(["dirt.txt"]); // own-iteration work NOT reclassified
		expect(input.ctx.log).toHaveBeenCalledWith(expect.stringContaining("reusing persisted first-ever phase-start dirt snapshot"));
	});

	it("absent worktree: the snapshot degrades to [] without any git spawn", () => {
		const { input } = baseInput({ wt: "/nonexistent/inc23-absent" });
		const out = enterPhase(input);
		expect(out.kind).toBe("enter");
		if (out.kind !== "enter") return;
		expect(out.phaseStartSet.size).toBe(0);
		expect(input.phaseStartDirt["phase-01"]).toEqual([]);
	});
});
