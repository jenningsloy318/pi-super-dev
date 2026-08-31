/**
 * v0.3.16 — RED-loop timeout honesty (F1–F4).
 *
 * Incident run 2026-08-23T02-59-20-670Z (super-dev v0.3.15, pi-omisis track
 * 07-staged-execution): 15/26 tdd-guide calls died at exactly the 1200 s wall;
 * phases 3/5/6 burned 4–6 tries each on a doom loop with four cooperating
 * defects (see docs/requirements/red-timeout-honesty-v0.3.16.md):
 *
 *  F1 (RC-T1) — stale testFiles echo: on a tdd timeout (control=no/error) the
 *      stage kept the PREVIOUS try's claim, the log printed the lie
 *      "error=timed out ... test files=tests/screen.test.ts", and the oracle
 *      ran vitest on a file the cleanup had deleted ("No test files found" →
 *      misleading red-broken feedback). Fix: a non-completed agent clears the
 *      claim; the log annotates the discard.
 *  F2 (RC-T2) — timeout-coupled file deletion: a RED REVIEW timeout produced
 *      review-weak evidence whose shared restore path DELETED the written
 *      (never-adjudicated) test file. Fix: the "RED review did not complete"
 *      reason template skips restoreUnacceptedRedChanges and logs the skip.
 *  F3 (RC-T3) — buildTddPrompt carries a Deadline-survival block (write the
 *      file early; ~10-call exploration cap; retry-with-timeout-feedback skips
 *      re-exploration).
 *  F4 (RC-T4) — when the previous try died at the wall clock (tdd timeout or
 *      review timeout), the retry hint is prefixed with the honest death
 *      cause + current disk state.
 *
 * Hermeticity: mirrors tests/implementation-red-loop.test.ts — runRedCheck /
 * runBuildGate / renderAndWrite are mocked; ctx.agent is a scripted closure;
 * no pi subprocess, no network, no LLM.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import type {
	AgentCall,
	AgentResult,
	Budget,
	ControlObj,
	HelperResult,
	PipelineState,
	RunOptions,
	Stage,
	StageContext,
} from "../src/types.ts";

vi.mock("../src/build-runner.ts", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return {
		...actual,
		runRedCheck: vi.fn((): string => "unknown"),
		runBuildGate: vi.fn(() => ({
			pass: true,
			inScopePass: false,
			ran: ["npm test"],
			errors: [] as string[],
			outOfScopeErrors: [] as string[],
		})),
		runDeliverableCheck: vi.fn(() => ({ pass: true, missing: [] as string[], ran: [] as string[] })),
		resetDeliverableCheckCache: vi.fn(() => {}),
	};
});

vi.mock("../src/render/render.ts", () => ({
	renderAndWrite: vi.fn(),
}));

import { implementationStage } from "../src/stages/implementation.ts";
import { runRedCheck, runBuildGate } from "../src/build-runner.ts";
import { buildTddPrompt } from "../src/prompts.ts";

const redCheck = runRedCheck as unknown as ReturnType<typeof vi.fn>;
const buildGate = runBuildGate as unknown as ReturnType<typeof vi.fn>;

// ─── Fixtures ───────────────────────────────────────────────────────────────

function mkState(): PipelineState {
	return {
		setup: {
			worktreePath: "/tmp/sd-red-timeout",
			specDirectory: "/tmp/sd",
			defaultBranch: "main",
			language: "frontend",
			isWebUi: false,
			specIdentifier: "t16",
			worktreeCreated: false,
			initializedRepo: false,
		},
		classify: { taskType: "bug", uiScope: "none", language: "frontend", isWebUi: false },
		spec: {
			phases: [{ name: "T16", description: "Timeout honesty", scenarioRefs: ["SCENARIO-001"] }],
		},
	} as unknown as PipelineState;
}

interface CapturedCalls {
	tdd: AgentCall[];
	impl: AgentCall[];
	review: AgentCall[];
	logs: string[];
}

/**
 * Scripted ctx. tddResults are consumed IN ORDER per tdd-guide call so a test
 * can script try 1 success + try 2 timeout etc. reviewResults likewise.
 */
function mkCtx(opts: {
	tddResults?: Array<{ text?: string; control: ControlObj | null; error?: string }>;
	reviewResults?: Array<{ control: ControlObj | null; error?: string }>;
	budgetCheck?: () => boolean;
} = {}): { ctx: StageContext; calls: CapturedCalls } {
	const calls: CapturedCalls = { tdd: [], impl: [], review: [], logs: [] };
	const tddQ = [...(opts.tddResults ?? [{ control: { testFiles: ["tests/red.test.ts"] } }])];
	const reviewQ = [...(opts.reviewResults ?? [{ control: { verdict: "strong", summary: "ok", contradictions: [] } }])];
	const ctx: StageContext = {
		task: "",
		options: {} as RunOptions,
		state: {} as PipelineState,
		async helper(): Promise<HelperResult> {
			return { value: { languageInstructions: "" }, digest: "" };
		},
		async agent(call: AgentCall): Promise<AgentResult> {
			if (call.agent === "tdd-guide") {
				calls.tdd.push(call);
				const scripted = tddQ.length > 0 ? tddQ.shift()! : { control: { testFiles: ["tests/red.test.ts"] } };
				return {
					text: scripted.text ?? "",
					control: scripted.control,
					...(scripted.error ? { error: scripted.error } : {}),
				} as AgentResult;
			}
			if (call.agent === "code-reviewer") {
				calls.review.push(call);
				const scripted = reviewQ.length > 0 ? reviewQ.shift()! : { control: { verdict: "strong", summary: "ok", contradictions: [] } };
				return {
					text: "",
					control: scripted.control,
					...(scripted.error ? { error: scripted.error } : {}),
				} as AgentResult;
			}
			if (call.agent === "tdd-coverage-classifier") {
				return { text: "", control: { allCovered: true, coveredScenarios: ["SCENARIO-001"], missingScenarios: [], summary: "all covered" } };
			}
			if (call.agent === "implementer") {
				calls.impl.push(call);
				return { text: "", control: { filesModified: ["src/x.ts"] } };
			}
			return { text: "", control: {} };
		},
		async parallel(cbs) {
			return Promise.all(cbs.map((c) => c()));
		},
		budget: {
			count: 0,
			check: opts.budgetCheck ?? (() => true),
			spent() {
				this.count++;
				return true;
			},
		} satisfies Budget,
		log(message: string) {
			calls.logs.push(message);
		},
		phase() {},
		events: new EventEmitter(),
		results: [],
	};
	return { ctx, calls };
}

/** Sequence runRedCheck statuses (repeat-last). */
function redSeq(...statuses: string[]): void {
	let i = 0;
	redCheck.mockImplementation(() => {
		const s = statuses[Math.min(i, statuses.length - 1)] ?? "unknown";
		i++;
		return s;
	});
}

beforeEach(() => {
	redCheck.mockReset();
	buildGate.mockReset();
	redCheck.mockImplementation(() => "unknown");
	buildGate.mockImplementation(() => ({
		pass: true,
		inScopePass: false,
		ran: ["npm test"],
		errors: [],
		outOfScopeErrors: [],
	}));
});

// ─── F1 — stale testFiles echo cleared on timeout ──────────────────────────

describe("F1 — tdd timeout discards the previous try's testFiles claim", () => {
	it("a timed-out tdd-guide (error + control=null) logs (none) with the discard annotation and NEVER echoes the prior claim", async () => {
		// try 1: healthy RED delivery; try 2+: timeout deaths.
		const { ctx, calls } = mkCtx({
			tddResults: [
				{ control: { testFiles: ["tests/screen.test.ts"] } },
				{ control: null, error: "timed out after 1200s" },
			],
		});
		// try1: review passes strong; try2's oracle path: unknown → fail-closed (needs tests).
		// Bound retries via budget so the loop terminates.
		let n = 0;
		const ctxB = { ...ctx, budget: { ...ctx.budget, check: () => n++ < 12 } };
		await (implementationStage as Stage).run(mkState(), ctxB as StageContext);

		// The poison line from run 02-59 must NOT appear:
		//   "tdd-guide (try 2) error=timed out after 1200s: test files=tests/screen.test.ts"
		const try2 = calls.logs.find((l) => l.includes("tdd-guide (try 2)"));
		expect(try2).toBeTruthy();
		expect(try2!).not.toMatch(/test files=tests\/screen\.test\.ts/);
		expect(try2!).toMatch(/test files=\(none\)/);
		expect(try2!).toMatch(/agent did not complete — previous claim discarded/);
		// And the fail-closed branch reports the agent, not a ghost-file oracle run.
		expect(calls.logs.some((l) => /RED fail-closed: the TDD agent did not complete \(timed out after 1200s\)/.test(l))).toBe(true);
	});

	it("the oracle is not handed the ghost file: runRedCheck is never called with the stale tests/screen.test.ts after the timeout try", async () => {
		const { ctx } = mkCtx({
			tddResults: [
				{ control: { testFiles: ["tests/screen.test.ts"] } },
				{ control: null, error: "timed out after 1200s" },
			],
		});
		let n = 0;
		const ctxB = { ...ctx, budget: { ...ctx.budget, check: () => n++ < 12 } };
		await (implementationStage as Stage).run(mkState(), ctxB as StageContext);

		const targets = redCheck.mock.calls.map((c) => (c[1] as string[]).join(","));
		// No oracle invocation may carry the stale claim after try 2's timeout:
		// try 2+ oracle calls must be empty-target (unknown) or absent.
		const ghostRuns = targets.filter((t) => t.includes("tests/screen.test.ts"));
		// Only try 1's oracle (legitimate) may reference the file — it must be the FIRST call at most.
		expect(ghostRuns.length).toBeLessThanOrEqual(1);
	});
});

// ─── F2 — review-timeout preserves the written file ─────────────────────────

describe("F2 — RED review timeout does NOT delete the written test file", () => {
	it("review-weak from 'RED review did not complete (…)' SKIPS restoreUnacceptedRedChanges and logs the skip", async () => {
		redSeq("red");
		// vitest-free observation: restore uses git in the real impl; in this mock
		// harness worktreePath is fake so git fails silently — the OBSERVABLE is the
		// skip log line and the ABSENCE of the restore log.
		const { ctx, calls } = mkCtx({
			reviewResults: [{ control: null, error: "timed out after 480s" }],
		});
		let n = 0;
		const ctxB = { ...ctx, budget: { ...ctx.budget, check: () => n++ < 12 } };
		await (implementationStage as Stage).run(mkState(), ctxB as StageContext);

		// v0.3.43 parallel join: a review death surfaces AFTER the concurrent
		// implementer ran — the file stays preserved (never restored/deleted) and
		// the honest rejection line names the incomplete review.
		expect(calls.logs.some((l) => /red-review-rejected: RED review not strong: RED review did not complete \(timed out after 480s\)/.test(l))).toBe(true);
		expect(calls.logs.some((l) => /RED cleanup: restored unaccepted RED change\(s\)/.test(l))).toBe(false);
	});

	it("a REAL weak verdict (review completed, verdict=weak) still restores (no regression of RC8)", async () => {
		// v0.3.0 semantics: explicit weak proceeds advisorially — but the pollution/
		// green-weak arms still restore. Use a weak review whose evidence rides the
		// review-weak path via contradictions=none + weak verdict + a preceding
		// broken-test oracle to force the restore branch's other member.
		redSeq("broken");
		const { ctx, calls } = mkCtx({
			tddResults: [{ control: { testFiles: ["tests/red.test.ts"] } }, { control: { testFiles: ["tests/red.test.ts"] } }],
		});
		let n = 0;
		const ctxB = { ...ctx, budget: { ...ctx.budget, check: () => n++ < 6 } };
		await (implementationStage as Stage).run(mkState(), ctxB as StageContext);
		// broken-test (NOT review-did-not-complete) must keep the restore behavior:
		// on a fake worktree the git restore fails silently, so the honest observable
		// is that NO skip log fired.
		expect(calls.logs.some((l) => /RED cleanup SKIPPED/.test(l))).toBe(false);
	});
});

// ─── F3 — deadline-survival discipline in the RED prompt ────────────────────

describe("F3 — buildTddPrompt carries the deadline-survival block", () => {
	it("contains WRITE THE TEST FILE TO DISK EARLY and the exploration cap", () => {
		const prompt = buildTddPrompt(
			{
				worktreePath: "/tmp/w", specDirectory: "/tmp/s", defaultBranch: "main", language: "frontend",
				isWebUi: false, specIdentifier: "x", worktreeCreated: false, initializedRepo: false,
			} as never,
			null,
			{ name: "P", description: "d" },
			{} as never,
			"",
			null,
		);
		expect(prompt).toMatch(/Deadline survival/);
		expect(prompt).toMatch(/WRITE THE TEST FILE TO DISK EARLY/);
		expect(prompt).toMatch(/~10 tool calls/);
		// order of operations spelled out
		expect(prompt).toMatch(/write it to disk/);
	});
});

// ─── F4 — timeout-aware retry hint ──────────────────────────────────────────

describe("F4 — the retry hint names the wall-clock death and the disk state", () => {
	it("after a tdd timeout, the NEXT tdd-guide prompt carries PREVIOUS TRY DIED AT THE WALL CLOCK and the skip-exploration instruction", async () => {
		const { ctx, calls } = mkCtx({
			tddResults: [
				{ control: { testFiles: ["tests/screen.test.ts"] } },
				{ control: null, error: "timed out after 1200s" },
				{ control: { testFiles: ["tests/screen.test.ts"] } },
			],
		});
		let n = 0;
		const ctxB = { ...ctx, budget: { ...ctx.budget, check: () => n++ < 12 } };
		await (implementationStage as Stage).run(mkState(), ctxB as StageContext);

		// Find the first tdd call issued AFTER the timeout death.
		const retryPrompt = calls.tdd.map((c) => c.prompt).find((p) => p.includes("PREVIOUS TRY DIED AT THE WALL CLOCK"));
		expect(retryPrompt).toBeTruthy();
		expect(retryPrompt!).toMatch(/timed out after 1200s/);
		expect(retryPrompt!).toMatch(/no claimed test file exists on disk|exist\(s\)/);
		expect(retryPrompt!).toMatch(/Skip re-exploration/);
	});

	it("after a review timeout (file preserved), the retry prompt reports the preserved state and names the review death", async () => {
		redSeq("red");
		const { ctx, calls } = mkCtx({
			reviewResults: [{ control: null, error: "timed out after 480s" }],
		});
		let n = 0;
		const ctxB = { ...ctx, budget: { ...ctx.budget, check: () => n++ < 12 } };
		await (implementationStage as Stage).run(mkState(), ctxB as StageContext);

		// v0.3.43: the review death rides the JOIN re-author evidence (the
		// implementer ran concurrently; its work was discarded).
		const retryPrompt = calls.tdd.map((c) => c.prompt).find((p) => p.includes("RED REVIEW REJECTED THE SUITE"));
		expect(retryPrompt).toBeTruthy();
		expect(retryPrompt!).toMatch(/RED review did not complete \(timed out after 480s\)/);
	});

	it("review fix (code F-1/adv F-2): the disk-state line probes the DISK — a file written before the timeout is named even though the claim was cleared", async () => {
		// Real temp worktree: try 1 claims AND the file exists; try 2 times out
		// (control=null) — F1 clears the claim, but the agent may still have
		// written/kept the file on disk. The hint must report it as existing.
		const wt = mkdtempSync(join(tmpdir(), "sd316-wt-"));
		mkdirSync(join(wt, "tests"), { recursive: true });
		writeFileSync(join(wt, "tests", "screen.test.ts"), "import { test } from \"vitest\";\ntest(\"placeholder\", () => { expect(1).toBe(2); });\n");
		const { ctx, calls } = mkCtx({
			tddResults: [
				{ control: { testFiles: ["tests/screen.test.ts"] } },
				{ control: null, error: "timed out after 1200s" },
				{ control: { testFiles: ["tests/screen.test.ts"] } },
			],
		});
		// Point the run at the real worktree.
		const state = mkState();
		(state.setup as { worktreePath?: string }).worktreePath = wt;
		let n = 0;
		const ctxB = { ...ctx, budget: { ...ctx.budget, check: () => n++ < 12 } };
		await (implementationStage as Stage).run(state, ctxB as StageContext);

		const retryPrompt = calls.tdd.map((c) => c.prompt).find((p) => p.includes("PREVIOUS TRY DIED AT THE WALL CLOCK"));
		expect(retryPrompt).toBeTruthy();
		expect(retryPrompt!).toMatch(/tests\/screen\.test\.ts exist\(s\)/);
		// And the misleading stock template must NOT ride along on an agent-death try:
		expect(retryPrompt!).not.toMatch(/Your tests did not compile|failed to compile\/collect because/);
	});
});
