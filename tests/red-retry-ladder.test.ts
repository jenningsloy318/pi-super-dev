/**
 * The RED retry/escalation ladder — contract test for the v0.4.44 extraction
 * (increment 16 of the stage.ts split).
 *
 * THE OUTCOME CONTRACT (4 arms): `restart` (judge-routed re-author/environment
 * fix — counters echoed, caller continues), `retry` (retries+1 with the hint,
 * caller continues), `f5-routed` (the red-weakening declared handoff — the
 * terminalStopReason + the append message, caller breaks), `terminal` (the
 * judge's stop class, caller breaks). The routing record echoes every counter
 * on every arm (the v0.4.33 cross-iteration lesson).
 *
 * The RC-3 cycle detector, the F5 escalation's scoped revert, and the RC8
 * cleanup branches are the load-bearing side-effect contracts.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import type { PipelineState, StageContext } from "../src/types.ts";
import type { RedEvidence } from "../src/stages/implementation/red-evidence.ts";
import { redEvidenceSignature, MAX_RED_RETRIES } from "../src/stages/implementation/red-evidence.ts";

vi.mock("../src/stages/implementation/red-judge.ts", async (importOriginal) => {
	const orig = await importOriginal<typeof import("../src/stages/implementation/red-judge.ts")>();
	return {
		...orig,
		routeRedJudge: vi.fn(async () => ({
			kind: "terminal",
			routing: { retries: 1, redJudgeRoutes: 1, redEnvRestarts: 0, redHint: "", redJudgeDiagnosis: "d", redJudgeEvidenceLabel: "e", terminalStopReason: "no-progress" as const },
		})),
	};
});

vi.mock("../src/replan/replan.ts", async (importOriginal) => {
	const orig = await importOriginal<typeof import("../src/replan/replan.ts")>();
	return {
		...orig,
		triggerReplanForFindings: vi.fn(async () => true),
	};
});

vi.mock("../src/stages/implementation/red-evidence.ts", async (importOriginal) => {
	const orig = await importOriginal<typeof import("../src/stages/implementation/red-evidence.ts")>();
	return {
		...orig,
		restoreUnacceptedRedChanges: vi.fn(),
	};
});

import { adjudicateRedRetryLadder } from "../src/stages/implementation/red-retry-ladder.ts";
import { routeRedJudge } from "../src/stages/implementation/red-judge.ts";
import { triggerReplanForFindings } from "../src/replan/replan.ts";
import { restoreUnacceptedRedChanges } from "../src/stages/implementation/red-evidence.ts";

const judgeMock = vi.mocked(routeRedJudge);
const replanMock = vi.mocked(triggerReplanForFindings);
const restoreMock = vi.mocked(restoreUnacceptedRedChanges);

const ctxOf = (out: { logs: string[] }): StageContext => ({
	task: "t", options: {}, state: {} as PipelineState,
	budget: { count: 0, check: () => true, spent: () => true },
	log: (line: string) => { out.logs.push(line); }, phase: () => {}, events: new EventEmitter(), results: [],
} as unknown as StageContext);

const weakEvidence: RedEvidence = {
	status: "green-weak-test",
	reason: "weak assertions",
	testFiles: ["tests/a.test.ts"],
	changedFiles: ["tests/a.test.ts"],
	forbiddenFiles: [],
} as unknown as RedEvidence;

const weakenedEvidence: RedEvidence = {
	status: "weakened-preexisting-test",
	reason: "assertion surface decreased",
	testFiles: ["tests/new.test.ts"],
	changedFiles: ["tests/new.test.ts", "tests/frozen.test.ts"],
	forbiddenFiles: [],
	preexistingTestFiles: ["tests/frozen.test.ts"],
	weakenedFiles: [{ path: "tests/frozen.test.ts", before: 8, after: 3 }],
} as unknown as RedEvidence;

const baseInput = (over: Partial<Parameters<typeof adjudicateRedRetryLadder>[0]> = {}): Parameters<typeof adjudicateRedRetryLadder>[0] => ({
	ctx: ctxOf({ logs: [] }),
	state: {} as PipelineState,
	phaseId: "phase-01",
	phaseName: "wire",
	attempt: 1,
	retries: 0,
	redJudgeRoutes: 0,
	redEnvRestarts: 0,
	redJudgeDiagnosis: "",
	redJudgeEvidenceLabel: "",
	incomingStopReason: "failed" as const,
	retryHint: "add real assertions",
	redEvidence: weakEvidence,
	testFiles: ["tests/a.test.ts"],
	redChangedFiles: ["tests/a.test.ts"],
	tddText: "",
	worktreePath: "/wt",
	specDirectory: "/spec",
	specIdentifier: "spec-x",
	redScaffoldApproved: new Set<string>(),
	redProgressHistory: [] as string[],
	replanAlreadyPending: false,
	runFuseTripped: false,
	...over,
});

beforeEach(() => { vi.clearAllMocks(); replanMock.mockResolvedValue(true); judgeMock.mockResolvedValue({ kind: "terminal", routing: { retries: 1, redJudgeRoutes: 1, redEnvRestarts: 0, redHint: "", redJudgeDiagnosis: "d", redJudgeEvidenceLabel: "e", terminalStopReason: "no-progress" } }); });

describe("red retry ladder (v0.4.44 increment-16 extraction)", () => {
	it("a first-seen signature under the ceiling → the `retry` arm: retries+1, redHint=retryHint, counters echoed", async () => {
		const history: string[] = [];
		const out = await adjudicateRedRetryLadder(baseInput({ redProgressHistory: history }));
		expect(out.kind).toBe("retry");
		if (out.kind !== "retry") throw new Error("narrow");
		expect(out.routing.retries).toBe(1);
		expect(out.routing.redHint).toBe("add real assertions");
		expect(out.routing.terminalStopReason).toBe("failed"); // echoed
		// the four UNTOUCHED counters echo their inputs (rebind is a no-op)
		expect(out.routing.redJudgeRoutes).toBe(0);
		expect(out.routing.redEnvRestarts).toBe(0);
		expect(out.routing.redJudgeDiagnosis).toBe("");
		expect(out.routing.redJudgeEvidenceLabel).toBe("");
		expect(judgeMock).not.toHaveBeenCalled();
		// the RC-3 history carries THIS signature now
		expect(history).toEqual([redEvidenceSignature(weakEvidence)]);
	});

	it("the retry log emits the INCREMENTED count with the failure reasons", async () => {
		const logs: string[] = [];
		await adjudicateRedRetryLadder(baseInput({ ctx: ctxOf({ logs }), retries: 2 }));
		expect(logs.some((l) => l.includes("RED generation retry 3:"))).toBe(true);
	});

	it("hitCeiling (retries+1 >= MAX_RED_RETRIES) routes to the judge — the `terminal` arm with the judge's counters", async () => {
		const out = await adjudicateRedRetryLadder(baseInput({ retries: MAX_RED_RETRIES - 1 }));
		expect(out.kind).toBe("terminal");
		if (out.kind !== "terminal") throw new Error("narrow");
		expect(out.routing.terminalStopReason).toBe("no-progress"); // the judge's, not the echo
		expect(judgeMock).toHaveBeenCalledTimes(1);
	});

	it("seenBefore (a cycle) also routes to the judge even under the ceiling", async () => {
		const history = [redEvidenceSignature(weakEvidence)];
		const out = await adjudicateRedRetryLadder(baseInput({ redProgressHistory: history, retries: 0 }));
		expect(out.kind).toBe("terminal");
		expect(judgeMock).toHaveBeenCalledTimes(1);
	});

	it("the judge's restart route → the `restart` arm carrying redHint + terminalStopReason", async () => {
		judgeMock.mockResolvedValueOnce({ kind: "restart", routing: { retries: 0, redJudgeRoutes: 1, redEnvRestarts: 1, redHint: "judge diagnosis: X", redJudgeDiagnosis: "X", redJudgeEvidenceLabel: "verified", terminalStopReason: "failed" } });
		const out = await adjudicateRedRetryLadder(baseInput({ retries: MAX_RED_RETRIES - 1 }));
		expect(out.kind).toBe("restart");
		if (out.kind !== "restart") throw new Error("narrow");
		expect(out.routing.redHint).toBe("judge diagnosis: X");
		expect(out.routing.redJudgeDiagnosis).toBe("X");
		// 60bb564c F1: the judge-SOURCED counters echo verbatim (the route-cap and
		// env-restart-cap drivers across iterations — the v0.4.33 lesson)
		expect(out.routing.retries).toBe(0);
		expect(out.routing.redJudgeRoutes).toBe(1);
		expect(out.routing.redEnvRestarts).toBe(1);
		expect(out.routing.redJudgeEvidenceLabel).toBe("verified");
	});

	it("F5 escalation: weakened-preexisting-test + ceiling + replan ROUTES → f5-routed with the scoped revert + the append message", async () => {
		const logs: string[] = [];
		const out = await adjudicateRedRetryLadder(baseInput({
			ctx: ctxOf({ logs }),
			retries: MAX_RED_RETRIES - 1,
			redEvidence: weakenedEvidence,
		}));
		expect(out.kind).toBe("f5-routed");
		if (out.kind !== "f5-routed") throw new Error("narrow");
		expect(out.routing.terminalStopReason).toBe("red-weakening");
		expect(out.attemptErrorsAppend).toContain("red-weakening: pre-existing test assertion surface decreased");
		expect(out.attemptErrorsAppend).toContain("sourcePhase:phase-01");
		// 60bb564c NIT-4: the before→after rendering rides the detail
		expect(out.attemptErrorsAppend).toContain("tests/frozen.test.ts 8→3");
		// the scoped revert: preexistingTestFiles ONLY (new files survive)
		expect(restoreMock).toHaveBeenCalledTimes(1);
		expect(restoreMock.mock.calls[0]![3]).toEqual(["tests/frozen.test.ts"]);
		expect(logs.some((l) => l.includes("F5 red-weakening escalation") && l.includes("NO inherited-red sub-cap"))).toBe(true);
		expect(judgeMock).not.toHaveBeenCalled(); // routed — the judge is skipped
	});

	it("F5 escalation DECLINED (replan unavailable) → falls through to the judge", async () => {
		replanMock.mockResolvedValueOnce(false);
		const logs: string[] = [];
		const out = await adjudicateRedRetryLadder(baseInput({
			ctx: ctxOf({ logs }),
			retries: MAX_RED_RETRIES - 1,
			redEvidence: weakenedEvidence,
		}));
		expect(out.kind).toBe("terminal"); // the judge took over
		expect(judgeMock).toHaveBeenCalledTimes(1);
		expect(logs.some((l) => l.includes("declared handoff UNAVAILABLE"))).toBe(true);
	});

	it("the F5 escalation is GUARDED: replan already pending or the fuse tripped → straight to the judge (no revert, no replan call)", async () => {
		const out = await adjudicateRedRetryLadder(baseInput({
			retries: MAX_RED_RETRIES - 1,
			redEvidence: weakenedEvidence,
			replanAlreadyPending: true,
		}));
		expect(out.kind).toBe("terminal");
		expect(restoreMock).not.toHaveBeenCalled();
		expect(replanMock).not.toHaveBeenCalled();
	});

	it("the F5 guard: a TRIPPED RUN FUSE also skips the escalation (straight to the judge)", async () => {
		const out = await adjudicateRedRetryLadder(baseInput({
			retries: MAX_RED_RETRIES - 1,
			redEvidence: weakenedEvidence,
			runFuseTripped: true,
		}));
		expect(out.kind).toBe("terminal");
		expect(restoreMock).not.toHaveBeenCalled();
		expect(replanMock).not.toHaveBeenCalled();
	});

	it("RC8 cleanup: green-weak-test → the FULL changedFiles revert before the retry", async () => {
		await adjudicateRedRetryLadder(baseInput({ redEvidence: weakEvidence }));
		expect(restoreMock).toHaveBeenCalledTimes(1);
		expect(restoreMock.mock.calls[0]![3]).toEqual(["tests/a.test.ts"]);
	});

	it("RC8 cleanup: reviewNeverRan (the review-death template) → PRESERVED, no revert, the honest log", async () => {
		const logs: string[] = [];
		const evidence: RedEvidence = { ...weakEvidence, status: "review-weak", reason: "RED review did not complete (timeout)" } as unknown as RedEvidence;
		await adjudicateRedRetryLadder(baseInput({ ctx: ctxOf({ logs }), redEvidence: evidence }));
		expect(restoreMock).not.toHaveBeenCalled();
		expect(logs.some((l) => l.includes("RED cleanup SKIPPED"))).toBe(true);
	});

	it("RC8 cleanup: weakened-preexisting-test under the ceiling → the SCOPED revert (preexisting only)", async () => {
		await adjudicateRedRetryLadder(baseInput({ redEvidence: weakenedEvidence }));
		expect(restoreMock).toHaveBeenCalledTimes(1);
		expect(restoreMock.mock.calls[0]![3]).toEqual(["tests/frozen.test.ts"]);
	});
});
