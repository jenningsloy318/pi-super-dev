/**
 * The phase tail — contract test for the v0.4.43 extraction (increment 15,
 * the final loop-scoped region of the stage.ts split).
 *
 * THE OUTCOME CONTRACT (3 arms): `partial` (the §D failure record + partial
 * preservation + status bookkeeping + the S4 stash retention all ran
 * in-module; the caller sets allGreen=false, clears the stash when
 * stashCleared, continues), `worktree-gone` (same side effects, then BREAK —
 * v0.3.57 liveness), `green` (the deterministic commit + stash re-apply ran
 * in-module; the caller increments phasesCompleted — inline's ++ preceded the
 * commit but nothing reads it before stage close).
 *
 * `stashCleared` rides every arm — the caller alone owns the let.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";

vi.mock("../src/stages/implementation/red-evidence.ts", async (importOriginal) => {
	const orig = await importOriginal<typeof import("../src/stages/implementation/red-evidence.ts")>();
	return {
		...orig,
		recordImplementationConvergenceFailure: vi.fn(),
	};
});

vi.mock("../src/stages/implementation/phase-status.ts", async (importOriginal) => {
	const orig = await importOriginal<typeof import("../src/stages/implementation/phase-status.ts")>();
	return {
		...orig,
		deterministicPhaseCommit: vi.fn(() => ({ status: "skipped", reason: "mock skip", sha: undefined })),
		preservePartialPhase: vi.fn(),
	};
});

import { closePhaseTail } from "../src/stages/implementation/phase-tail.ts";
import { deterministicPhaseCommit, preservePartialPhase } from "../src/stages/implementation/phase-status.ts";
import { recordImplementationConvergenceFailure } from "../src/stages/implementation/red-evidence.ts";
import { readFileSync } from "node:fs";
import type { PipelineState, StageContext } from "../src/types.ts";

const commitMock = vi.mocked(deterministicPhaseCommit);
const preserveMock = vi.mocked(preservePartialPhase);
const recordMock = vi.mocked(recordImplementationConvergenceFailure);

const repos: string[] = [];

function makeRepo(prefix: string): string {
	const repo = mkdtempSync(join(tmpdir(), prefix));
	const git = (...args: string[]) => spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
	git("init", "-q");
	git("config", "user.email", "t@t");
	git("config", "user.name", "t");
	mkdirSync(join(repo, "src"));
	writeFileSync(join(repo, "src/prod.ts"), "export const A = 1;\n");
	git("add", "-A");
	git("commit", "-qm", "seed");
	repos.push(repo);
	return repo;
}

const ctxOf = (out: { logs: string[] }): StageContext => ({
	task: "t", options: {}, state: {} as PipelineState,
	budget: { count: 0, check: () => true, spent: () => true },
	log: (line: string) => { out.logs.push(line); }, phase: () => {}, events: new EventEmitter(), results: [],
} as unknown as StageContext);

const baseInput = (over: Record<string, unknown> = {}) => ({
	ctx: ctxOf({ logs: [] }),
	state: {} as PipelineState,
	setup: { worktreePath: "", specDirectory: "", defaultBranch: undefined, worktreeCreated: true } as never,
	phaseId: "phase-01",
	phaseName: "wire-prod",
	phaseNameRaw: "wire-prod (raw)",
	idx: 0,
	totalPhases: 2,
	isGreen: false,
	terminalStopReason: "gates-unmet",
	terminalFailureKind: "implementation-gate" as const,
	terminalRedTries: 0,
	attemptsRun: 3,
	attemptErrors: ["tsc error"],
	missingDeliverables: ["src/missing.ts"],
	claimedNotChanged: [],
	hollowFiles: [],
	redJudgeDiagnosis: "env broken upstream",
	tracker: null,
	phaseStatus: [] as never,
	lastFailures: [] as never,
	envBlockedPhases: new Set<string>(),
	pendingRollbackStash: null,
	worktreeGone: false,
	emitPhaseStatus: () => {},
	announceActivity: () => {},
	...over,
});

beforeEach(() => { vi.clearAllMocks(); commitMock.mockReturnValue({ status: "skipped", reason: "mock skip", sha: undefined }); });
afterEach(() => { for (const r of repos.splice(0)) rmSync(r, { recursive: true, force: true }); });

describe("phase-tail caller interpretation (source pins, dcf87f06 NIT-2)", () => {
	it("the 3-arm seam: stash-null-before-kind-branch, allGreen on both non-green arms, phasesCompleted on green only", () => {
		const src = readFileSync("src/stages/implementation/stage.ts", "utf8");
		const callIdx = src.indexOf("const tail = await closePhaseTail({");
		expect(callIdx).toBeGreaterThan(-1);
		const seam = src.slice(callIdx, callIdx + 2200);
		// the caller alone owns the stash let — cleared before the kind branch
		const clearIdx = seam.indexOf("if (tail.stashCleared) pendingRollbackStash = null;");
		const greenIdx = seam.indexOf('if (tail.kind === "green")');
		expect(clearIdx).toBeGreaterThan(-1);
		expect(clearIdx).toBeLessThan(greenIdx);
		// green: ONLY the increment (the commit ran in-module)
		expect(seam).toMatch(/kind === "green"[\s\S]{0,80}phasesCompleted\+\+;/);
		// both non-green arms set allGreen=false; worktree-gone breaks, partial continues
		expect(seam).toMatch(/allGreen = false;[\s\S]{0,200}if \(tail\.kind === "worktree-gone"\) break;[\s\S]{0,80}continue;/);
	});
});

describe("phase tail (v0.4.43 increment-15 extraction)", () => {
	it("the PARTIAL arm: the §D failure record + the terminalReasons union + partial status bookkeeping", async () => {
		const repo = makeRepo("sd-pt-partial-");
		const status: Array<{ id: string; status: string; lastFailureSig?: string; partialReEntries?: number; attempts?: number }> = [];
		const failures: Array<{ phaseId: string; reasons: string[] }> = [];
		const state = {} as PipelineState;
		const out = await closePhaseTail(baseInput({
			worktreePath: repo,
			state,
			setup: { worktreePath: repo, specDirectory: "", defaultBranch: undefined, worktreeCreated: true } as never,
			phaseStatus: status as never,
			lastFailures: failures,
		}) as never);
		expect(out.kind).toBe("partial");
		expect(out.stashCleared).toBe(false);
		// the §D failure record (terminalReasons): attemptErrors + the judge's
		// verified diagnosis + missing deliverables
		expect(recordMock).toHaveBeenCalledTimes(1);
		// dcf87f06 NIT-1: the FULL record args, not just reasons
		expect(recordMock.mock.calls[0]![0]).toBe(state);
		expect(recordMock.mock.calls[0]![1]).toMatchObject({ phaseId: "phase-01", kind: "implementation-gate", attemptsRun: 3 });
		const reasons = recordMock.mock.calls[0]![1].reasons as string[];
		expect(reasons).toContain("tsc error");
		expect(reasons).toContain("judge diagnosis: env broken upstream");
		expect(reasons).toContain("deliverable: src/missing.ts");
		// lastFailuresUpsert carries the WITHOUT-diagnosis union (review-2 F8's
		// split: the diagnosis reaches the convergence record, not the row)
		expect(failures).toHaveLength(1);
		expect(failures[0].reasons).toEqual(["tsc error", "deliverable: src/missing.ts"]);
		// partial status upsert with the same-signal re-entry counter
		expect(status[0]).toMatchObject({ id: "phase-01", status: "partial", attempts: 3, partialReEntries: 0 });
		expect(typeof status[0].lastFailureSig).toBe("string");
		expect(preserveMock).toHaveBeenCalledTimes(1);
		// the honest reason passes through
		expect(preserveMock.mock.calls[0]![4]).toBe("gates-unmet");
	});

	it("the same terminalReasons signature on re-entry increments partialReEntries (the §D re-entry counter)", async () => {
		const repo = makeRepo("sd-pt-reentry-");
		const status = [{ id: "phase-01", status: "partial", lastFailureSig: "tsc error; judge diagnosis: env broken upstream; deliverable: src/missing.ts", partialReEntries: 1 }];
		const failures: Array<{ phaseId: string; reasons: string[] }> = [];
		await closePhaseTail(baseInput({
			worktreePath: repo,
			setup: { worktreePath: repo, specDirectory: "", defaultBranch: undefined, worktreeCreated: true } as never,
			phaseStatus: status as never,
			lastFailures: failures,
		}) as never);
		expect(status[0].partialReEntries).toBe(2); // same signature → incremented
	});

	it("environment-blocked adds the phase to envBlockedPhases + the named preservePartialPhase reason", async () => {
		const repo = makeRepo("sd-pt-envblocked-");
		const envBlocked = new Set<string>();
		const out = await closePhaseTail(baseInput({
			worktreePath: repo,
			setup: { worktreePath: repo, specDirectory: "", defaultBranch: undefined, worktreeCreated: true } as never,
			terminalStopReason: "environment-blocked",
			envBlockedPhases: envBlocked,
		}) as never);
		expect(out.kind).toBe("partial");
		expect(envBlocked.has("phase-01")).toBe(true);
		expect(preserveMock.mock.calls[0]![4]).toBe("environment-blocked");
	});

	it("the named handoff reasons pass through verbatim (declared-handoff → \"declared-handoff (f4)\")", async () => {
		const repo = makeRepo("sd-pt-handoff-");
		await closePhaseTail(baseInput({
			worktreePath: repo,
			setup: { worktreePath: repo, specDirectory: "", defaultBranch: undefined, worktreeCreated: true } as never,
			terminalStopReason: "declared-handoff",
		}) as never);
		expect(preserveMock.mock.calls[0]![4]).toBe("declared-handoff (f4)");
	});

	it("the S4 stash retention: a partial phase KEEPS its pending rollback stash — stashCleared=true, the P10 retention log", async () => {
		const repo = makeRepo("sd-pt-s4-");
		const logs: string[] = [];
		const out = await closePhaseTail(baseInput({
			ctx: ctxOf({ logs }),
			worktreePath: repo,
			setup: { worktreePath: repo, specDirectory: "", defaultBranch: undefined, worktreeCreated: true } as never,
			pendingRollbackStash: { phaseId: "phase-01", stashSha: "abcdef1234567890" },
		}) as never);
		expect(out.kind).toBe("partial");
		expect(out.stashCleared).toBe(true); // the caller nulls the let — the stash itself is NOT dropped
		expect(logs.some((l) => l.includes("pending rollback stash (abcdef12)") && l.includes("RETAINED"))).toBe(true);
	});

	it("the two partial-log variants' nested terminalStopReason ternaries (8480e24a NIT-2 — previously unguarded)", async () => {
		const repo = makeRepo("sd-pt-logvars-");
		const run = async (over: Record<string, unknown>) => {
			const logs: string[] = [];
			await closePhaseTail(baseInput({
				ctx: ctxOf({ logs }),
				worktreePath: repo,
				setup: { worktreePath: repo, specDirectory: "", defaultBranch: undefined, worktreeCreated: true } as never,
				...over,
			}) as never);
			return logs;
		};
		// red-generation variant: the RED-tries count + the named suffixes
		const redGen = await run({ terminalFailureKind: "red-generation", terminalRedTries: 5, terminalStopReason: "no-progress" });
		expect(redGen.some((l) => l.includes("partial (RED generation stopped after 5 tries in attempt 3, no progress) — continuing to the next phase"))).toBe(true);
		const redGenEnv = await run({ terminalFailureKind: "red-generation", terminalStopReason: "environment-blocked" });
		expect(redGenEnv.some((l) => l.includes("partial (RED generation stopped after 0 tries in attempt 3, environment blocked (fix is outside this worktree — judge diagnosis above)) — continuing to the next phase"))).toBe(true);
		// implementation-gate variant: the attempt count + its own suffix set
		const gateWall = await run({ terminalStopReason: "wall-fuse" });
		expect(gateWall.some((l) => l.includes("partial after 3 attempt(s) (wall-fuse — run wall budget exhausted; resumable by design) — continuing to the next phase"))).toBe(true);
		const gateCap = await run({ terminalStopReason: "phase-attempt-cap" });
		expect(gateCap.some((l) => l.includes("partial after 3 attempt(s) (phase-attempt-cap) — continuing to the next phase"))).toBe(true);
		// unmatched reasons fall through to the empty suffix
		const gatePlain = await run({ terminalStopReason: "gates-unmet" });
		expect(gatePlain.some((l) => l.includes("partial after 3 attempt(s) — continuing to the next phase"))).toBe(true);
	});

	it("worktreeGone → the worktree-gone arm (the caller breaks; liveness)", async () => {
		const repo = makeRepo("sd-pt-gone-");
		const out = await closePhaseTail(baseInput({
			worktreePath: repo,
			setup: { worktreePath: repo, specDirectory: "", defaultBranch: undefined, worktreeCreated: true } as never,
			worktreeGone: true,
		}) as never);
		expect(out.kind).toBe("worktree-gone");
	});

	it("the GREEN arm: the deterministic commit runs (phaseIndex/totalPhases/gateSummary), no preservation", async () => {
		const repo = makeRepo("sd-pt-green-");
		commitMock.mockReturnValueOnce({ status: "committed", reason: "mock commit", sha: "deadbeef" });
		const logs: string[] = [];
		const out = await closePhaseTail(baseInput({
			ctx: ctxOf({ logs }),
			worktreePath: repo,
			setup: { worktreePath: repo, specDirectory: "", defaultBranch: undefined, worktreeCreated: true } as never,
			isGreen: true,
		}) as never);
		expect(out.kind).toBe("green");
		expect(commitMock).toHaveBeenCalledTimes(1);
		expect(commitMock.mock.calls[0]![1]).toMatchObject({ phaseIndex: 1, totalPhases: 2, phaseName: "wire-prod" });
		expect(logs.some((l) => l.includes("deterministic commit: deadbeef"))).toBe(true);
		expect(preserveMock).not.toHaveBeenCalled();
	});

	it("the commit FALLBACK: a failed deterministic commit dispatches the orchestrator with the RAW phase.name (not the loop-normalized phaseName)", async () => {
		const repo = makeRepo("sd-pt-fallback-");
		commitMock.mockReturnValueOnce({ status: "fallback", reason: "in-place run" });
		const agent = vi.fn(async (_args: { id: string; agent: string; prompt: string }) => ({ control: null }));
		const out = await closePhaseTail(baseInput({
			ctx: { ...ctxOf({ logs: [] }), agent } as never,
			worktreePath: repo,
			setup: { worktreePath: repo, specDirectory: "", defaultBranch: undefined, worktreeCreated: true } as never,
			isGreen: true,
		}) as never);
		expect(out.kind).toBe("green");
		expect(agent).toHaveBeenCalledTimes(1);
		const prompt = (agent.mock.calls[0]![0] as { prompt: string }).prompt;
		expect(prompt).toContain("wire-prod (raw)"); // the RAW name
		expect(prompt).not.toContain("wire-prod\n"); // not the normalized (they differ only in this fixture)
	});

	it("the green-path stash re-apply: THIS phase's stash is re-applied and stashCleared=true; ANOTHER phase's is not", async () => {
		const repo = makeRepo("sd-pt-reapply-");
		const logs: string[] = [];
		const out = await closePhaseTail(baseInput({
			ctx: ctxOf({ logs }),
			worktreePath: repo,
			setup: { worktreePath: repo, specDirectory: "", defaultBranch: undefined, worktreeCreated: true } as never,
			isGreen: true,
			pendingRollbackStash: { phaseId: "phase-01", stashSha: "0123456789abcdef" },
		}) as never);
		expect(out.kind).toBe("green");
		expect(out.stashCleared).toBe(true);
		// reapplyRollbackStash's honest-missing log for a stash not in the list
		expect(logs.some((l) => l.includes("stash re-apply") && l.includes("01234567"))).toBe(true);
		// another phase's stash: untouched
		const logs2: string[] = [];
		const out2 = await closePhaseTail(baseInput({
			ctx: ctxOf({ logs: logs2 }),
			worktreePath: repo,
			setup: { worktreePath: repo, specDirectory: "", defaultBranch: undefined, worktreeCreated: true } as never,
			isGreen: true,
			pendingRollbackStash: { phaseId: "phase-02", stashSha: "ffffffffffffffff" },
		}) as never);
		expect(out2.stashCleared).toBe(false);
	});

	it("budget-exhausted ctx: the green path SKIPS the commit entirely (the budget gate stays)", async () => {
		const repo = makeRepo("sd-pt-nobudget-");
		const out = await closePhaseTail(baseInput({
			ctx: { ...ctxOf({ logs: [] }), budget: { count: 0, check: () => false, spent: () => false } } as never,
			worktreePath: repo,
			setup: { worktreePath: repo, specDirectory: "", defaultBranch: undefined, worktreeCreated: true } as never,
			isGreen: true,
		}) as never);
		expect(out.kind).toBe("green");
		expect(commitMock).not.toHaveBeenCalled();
	});
});
