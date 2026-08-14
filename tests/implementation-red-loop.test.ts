/**
 * Phase P3 — RED enforcement loop inside implementation.ts — RED phase (TDD).
 *
 * These tests define the AC-02 contract for the Stage 9 implementation stage's
 * bounded RED-enforcement loop BEFORE the wiring exists. Today
 * `src/stages/implementation.ts` calls the `tdd-guide` agent and DISCARDS its
 * result (implementation.ts:70 has no left-hand assignment); `runRedCheck` —
 * delivered in P2 — is never invoked from the stage, and there is no
 * `red-oracle` log line. So every assertion here
 * is RED until Phase P3 wires the loop.
 *
 * Contract (spec §B / AC-02 → SCENARIO-006/007/008/009/010):
 *   - After the initial `tdd-guide` call, capture its `control.testFiles` and
 *     call `runRedCheck(worktreePath, testFiles, { signal })` ONCE.
 *   - while the global budget allows and RED evidence is still changing,
 *       re-prompt `tdd-guide` (status-specific hint), re-run `runRedCheck`.
 *   - On `"red"` → proceed to the implementer with a CONFIRMED-red context.
 *   - On `"unknown"` → proceed without stalling, but explicitly tell the
 *     implementer RED could not be confirmed.
 *   - On repeated no-progress RED evidence → HARD-fail the phase
 *     (`red-not-confirmed` / `red-broken`) and do NOT call the implementer.
 *   - Log EVERY red-oracle outcome as
 *       `Implementation ${phaseId} red-oracle: ${status} (ran: ...)`.
 *   - The outer implementation loop remains budget-bounded and no-progress
 *     guarded, while `gate.pass || gate.inScopePass` commit behavior is unchanged.
 *
 * RED status hardening: `green`/`broken` retry exhaustion is no longer a warning
 * path into the implementer. It is the bug this suite prevents: unconfirmed RED
 * stops the phase unless the harness proves deliverables were already satisfied
 * before RED or the runner is genuinely unknown/unavailable.
 *
 * Hermeticity: the ONLY side-effecting imports of the stage are mocked —
 * `runRedCheck`/`runBuildGate` (src/build-runner.ts) and `renderAndWrite`
 * (src/render/render.ts). `ctx.agent` / `ctx.helper` are pure scripted closures.
 * No `pi` subprocess, no network, no LLM, no disk.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
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

// ─── Mocks ──────────────────────────────────────────────────────────────────
// Mock BOTH build-runner entry points the stage touches, so the RED oracle and
// the hard gate are fully scriptable AND never spawn a real process.
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

// Mock the only filesystem-writing side effect of the stage (the summary render)
// so the suite is disk-free and deterministic.
vi.mock("../src/render/render.ts", () => ({
	renderAndWrite: vi.fn(),
}));

import { implementationStage } from "../src/stages/implementation.ts";
import { runRedCheck, runBuildGate } from "../src/build-runner.ts";

const redCheck = runRedCheck as unknown as ReturnType<typeof vi.fn>;
const buildGate = runBuildGate as unknown as ReturnType<typeof vi.fn>;

// ─── Fixtures ───────────────────────────────────────────────────────────────

function mkState(): PipelineState {
	return {
		setup: {
			// Path is irrelevant — runRedCheck/runBuildGate are mocked.
			worktreePath: "/tmp/sd-red-loop",
			specDirectory: "/tmp/sd",
			defaultBranch: "main",
			language: "frontend",
			isWebUi: false,
			specIdentifier: "p3",
			worktreeCreated: false,
			initializedRepo: false,
		},
		classify: { taskType: "bug", uiScope: "none", language: "frontend", isWebUi: false },
		spec: {
			phases: [{ name: "P3", description: "Wire RED enforcement loop" }],
		},
	};
}

interface CapturedCalls {
	tdd: AgentCall[];
	impl: AgentCall[];
	orch: AgentCall[];
	helper: number;
	logs: string[];
}

/**
 * Build a fully-scripted StageContext. The agent() closure routes by `call.agent`
 * and records every call so tests can assert on counts and the implementer
 * prompt (the load-bearing RED-context augmentation).
 */
function mkCtx(opts: {
	tddControl?: ControlObj;
	budgetCheck?: () => boolean;
	/** Tier-2 RED-review verdicts, consumed in order per code-reviewer call.
	 *  Default: always "strong" (review passes → no extra retry). */
	reviewVerdicts?: Array<"strong" | "weak">;
	/** Per-review contradiction lists (parallel queue to reviewVerdicts; Fix 4). */
	reviewContradictions?: Array<Array<{ tests: string; lines?: string; proof: string }>>;
} = {}): { ctx: StageContext; calls: CapturedCalls } {
	const calls: CapturedCalls = {
		tdd: [],
		impl: [],
		orch: [],
		helper: 0,
		logs: [],
	};
	const reviewQ = [...(opts.reviewVerdicts ?? [])];
	const contradictionQ = [...(opts.reviewContradictions ?? [])];
	const ctx: StageContext = {
		task: "",
		options: {} as RunOptions,
		state: {} as PipelineState,
		async helper(): Promise<HelperResult> {
			calls.helper++;
			return { value: { languageInstructions: "" }, digest: "" };
		},
		async agent(call: AgentCall): Promise<AgentResult> {
			if (call.agent === "tdd-guide") {
				calls.tdd.push(call);
				return { text: "", control: opts.tddControl ?? { testFiles: ["tests/red.test.ts"] } };
			}
			if (call.agent === "implementer") {
				calls.impl.push(call);
				return { text: "", control: { filesModified: ["src/x.ts"] } };
			}
			if (call.agent === "code-reviewer") {
				calls.orch.push(call);
				const verdict = reviewQ.shift() ?? "strong";
				const contradictions = contradictionQ.shift() ?? [];
				return { text: "", control: { verdict, summary: verdict === "weak" ? "assertions are tautological" : "ok", contradictions } };
			}
			calls.orch.push(call);
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

/** Sequence runRedCheck to return the given statuses in order, repeating the
 *  last one indefinitely (so cap-exhaustion tests always stay green/broken). */
function redSeq(...statuses: string[]): void {
	let i = 0;
	redCheck.mockImplementation((_cwd: string, _targets: string[], opts?: { onResult?: (diagnostic: unknown) => void }) => {
		const s = statuses[Math.min(i, statuses.length - 1)] ?? "unknown";
		i++;
		opts?.onResult?.({
			plan: { cwd: "/tmp/sd-red-loop", argv: ["node", "--import", "tsx", "--test", "tests/red.test.ts"] },
			language: "backend",
			status: s,
			exitCode: s === "green" ? 0 : 1,
			signal: null,
			outputTail: s === "broken" ? "SyntaxError: Cannot use import statement outside a module" : "AssertionError: expected missing behavior",
		});
		return s;
	});
}

/** Like redSeq but CYCLES the statuses indefinitely (A,B,A,B,…) — used to model
 *  the oscillation livelock (green↔broken) that the old consecutive-identical
 *  no-progress check missed. */
function redCycle(...statuses: string[]): void {
	let i = 0;
	redCheck.mockImplementation((_cwd: string, _targets: string[], opts?: { onResult?: (diagnostic: unknown) => void }) => {
		const s = statuses[i % statuses.length] ?? "unknown";
		i++;
		opts?.onResult?.({
			plan: { cwd: "/tmp/sd-red-loop", argv: ["node", "--import", "tsx", "--test", "tests/red.test.ts"] },
			language: "backend",
			status: s,
			exitCode: s === "green" ? 0 : 1,
			signal: null,
			outputTail: s === "broken" ? "SyntaxError: Cannot use import statement outside a module" : "AssertionError: expected missing behavior",
		});
		return s;
	});
}

beforeEach(() => {
	redCheck.mockReset();
	buildGate.mockReset();
	// Sensible default: gate passes, RED oracle unknown (the greenfield default).
	redCheck.mockImplementation(() => "unknown");
	buildGate.mockImplementation(() => ({
		pass: true,
		inScopePass: false,
		ran: ["npm test"],
		errors: [],
		outOfScopeErrors: [],
	}));
});

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("P3 — RED loop: confirmed-red proceeds immediately (SCENARIO-006/010)", () => {
	it("calls runRedCheck exactly once on a red status and does NOT re-prompt tdd-guide", async () => {
		redSeq("red");
		const { ctx, calls } = mkCtx();
		const res = (await (implementationStage as Stage).run(mkState(), ctx)) as ControlObj;

		expect(redCheck).toHaveBeenCalledTimes(1);
		// initial tdd-guide only — zero RED re-prompts
		expect(calls.tdd).toHaveLength(1);
		expect(calls.impl).toHaveLength(1); // proceeds to implementer
		expect(res.phasesCompleted).toBe(1);
	});

	it("R1 (fail-closed): an UNKNOWN red status for a scenario-requiring phase does NOT proceed to the implementer", async () => {
		redSeq("unknown"); // runner can't classify (e.g. tdd-guide returned no usable tests)
		// A phase that maps a scenario MUST have confirmed RED before implementation.
		const state = {
			setup: { worktreePath: "/tmp/sd-red-loop", specDirectory: "/tmp/sd", defaultBranch: "main", language: "frontend", isWebUi: false, specIdentifier: "p3", worktreeCreated: false, initializedRepo: false },
			classify: { taskType: "bug", uiScope: "none", language: "frontend", isWebUi: false },
			spec: { scenarioRefs: ["SCENARIO-001"], phases: [{ name: "P3", description: "x", scenarioRefs: ["SCENARIO-001"] }] },
		} as unknown as PipelineState;
		// Bound the RED retry loop so the test terminates (no-progress/budget stop).
		let n = 0;
		const { ctx, calls } = mkCtx({ budgetCheck: () => n++ < 8 });
		const res = (await (implementationStage as Stage).run(state, ctx)) as ControlObj;

		// Must NOT ship untested code: implementer never runs, phase not completed.
		expect(calls.impl).toHaveLength(0);
		expect(res.phasesCompleted).toBe(0);
		expect(calls.logs.some((l) => /RED fail-closed/.test(l))).toBe(true);
	});

	it("augments the implementer prompt with a CONFIRMED-red note when status === 'red'", async () => {
		redSeq("red");
		const { ctx, calls } = mkCtx();
		await (implementationStage as Stage).run(mkState(), ctx);

		expect(calls.impl).toHaveLength(1);
		expect(calls.impl[0].prompt).toMatch(/CONFIRMED-red/i);
	});

	it("Tier 2: a WEAK RED review re-prompts tdd-guide before implementation, then proceeds on STRONG", async () => {
		redSeq("red", "red"); // two RED oracle passes (initial + after re-prompt)
		const { ctx, calls } = mkCtx({ reviewVerdicts: ["weak", "strong"] });
		const res = (await (implementationStage as Stage).run(mkState(), ctx)) as ControlObj;

		// WEAK verdict routed back to tdd-guide once → two tdd-guide calls total.
		expect(calls.tdd).toHaveLength(2);
		// The re-prompt carried the reviewer's weakness feedback.
		expect(calls.tdd[1].prompt).toMatch(/WEAK|weak|assertion/);
		// Only proceeds to the implementer after the STRONG verdict.
		expect(calls.impl).toHaveLength(1);
		expect(res.phasesCompleted).toBe(1);
		expect(calls.logs.some((l) => /RED review: NOT STRONG/.test(l))).toBe(true);
	});

	it("Fix 4: a STRONG verdict WITH named contradictions routes back to tdd-guide carrying the impossibility proof", async () => {
		redSeq("red", "red");
		const { ctx, calls } = mkCtx({
			reviewVerdicts: ["strong", "strong"],
			reviewContradictions: [[{ tests: "SCENARIO-016 vs SCENARIO-029", lines: "606", proof: "byte-identical samples cannot differ across validators" }], []],
		});
		const res = (await (implementationStage as Stage).run(mkState(), ctx)) as ControlObj;

		// The contradiction overrides the STRONG verdict: tdd-guide re-authored once.
		expect(calls.tdd).toHaveLength(2);
		// The re-prompt carried the reviewer's contradiction + proof.
		expect(calls.tdd[1].prompt).toMatch(/jointly unsatisfiable/);
		expect(calls.tdd[1].prompt).toMatch(/byte-identical samples cannot differ/);
		// Implementation proceeds only after the clean STRONG (no contradictions).
		expect(calls.impl).toHaveLength(1);
		expect(res.phasesCompleted).toBe(1);
		expect(calls.logs.some((l) => /RED review: CONTRADICTIONS/.test(l))).toBe(true);
	});

	it("Fix 4: a STRONG verdict with contradictions: [] proceeds directly (no re-author)", async () => {
		redSeq("red");
		const { ctx, calls } = mkCtx({ reviewVerdicts: ["strong"], reviewContradictions: [[]] });
		const res = (await (implementationStage as Stage).run(mkState(), ctx)) as ControlObj;
		expect(calls.tdd).toHaveLength(1);
		expect(calls.impl).toHaveLength(1);
		expect(res.phasesCompleted).toBe(1);
	});

	it("Tier 2 (R2, fail-closed): a MISSING/invalid review verdict also routes back to tdd-guide (not treated as pass)", async () => {
		redSeq("red", "red");
		// First review returns no usable verdict (empty ⇒ not "strong"); second is strong.
		const { ctx, calls } = mkCtx({ reviewVerdicts: ["", "strong"] as never });
		const res = (await (implementationStage as Stage).run(mkState(), ctx)) as ControlObj;

		// Non-strong (here: empty/invalid) must NOT fail open → tdd-guide re-prompted.
		expect(calls.tdd).toHaveLength(2);
		expect(calls.impl).toHaveLength(1); // proceeds only after the strong verdict
		expect(res.phasesCompleted).toBe(1);
		expect(calls.logs.some((l) => /RED review: NOT STRONG/.test(l))).toBe(true);
	});

	it("logs the red-oracle outcome as `Implementation phase-01 red-oracle: red (ran: ...)`", async () => {
		redSeq("red");
		const { ctx, calls } = mkCtx();
		await (implementationStage as Stage).run(mkState(), ctx);

		expect(calls.logs.some((l) => /red-oracle:\s*red\b/.test(l))).toBe(true);
	});
});

describe("P3 — RED loop: unknown proceeds immediately, never stalls (SCENARIO-008, AC-06)", () => {
	it("returns unknown → ZERO re-prompts and exactly one runRedCheck call", async () => {
		redSeq("unknown");
		const { ctx, calls } = mkCtx();
		const res = (await (implementationStage as Stage).run(mkState(), ctx)) as ControlObj;

		expect(redCheck).toHaveBeenCalledTimes(1);
		expect(calls.tdd).toHaveLength(1); // initial only
		expect(calls.impl).toHaveLength(1); // proceeds to implementer
		expect(res.phasesCompleted).toBe(1);
	});

	it("does NOT emit a cap-exhaustion WARNING for unknown (only cap-exhaustion warns)", async () => {
		redSeq("unknown");
		const { ctx, calls } = mkCtx();
		await (implementationStage as Stage).run(mkState(), ctx);

		expect(calls.logs.some((l) => /red-oracle WARNING/i.test(l))).toBe(false);
	});

	it("does NOT tell the implementer the tests are CONFIRMED-red when status === 'unknown'", async () => {
		redSeq("unknown");
		const { ctx, calls } = mkCtx();
		await (implementationStage as Stage).run(mkState(), ctx);

		expect(calls.impl[0].prompt).not.toMatch(/CONFIRMED-red/i);
	});
});

describe("P3 — RED loop: green/broken triggers a budgeted no-progress-guarded re-prompt (SCENARIO-007)", () => {
	it("green → red: re-prompts tdd-guide until red while evidence changes", async () => {
		redSeq("green", "red");
		const { ctx, calls } = mkCtx();

		await (implementationStage as Stage).run(mkState(), ctx);

		// this case reaches red after one targeted retry: 1 initial check + 1 retry.
		expect(redCheck).toHaveBeenCalledTimes(2);
		expect(calls.tdd).toHaveLength(2);
		// reached red → implementer prompt IS confirmed-red.
		expect(calls.impl).toHaveLength(1);
		expect(calls.impl[0].prompt).toMatch(/CONFIRMED-red/i);
	});

	it("broken is treated identically to green (re-prompts with the same no-progress guard)", async () => {
		redSeq("broken", "red");
		const { ctx, calls } = mkCtx();

		await (implementationStage as Stage).run(mkState(), ctx);

		expect(redCheck).toHaveBeenCalledTimes(2);
		expect(calls.tdd).toHaveLength(2);
		expect(calls.impl[0].prompt).toMatch(/CONFIRMED-red/i);
	});

	it("broken RED retries include the runner diagnostics in the next tdd-guide prompt", async () => {
		redSeq("broken", "red");
		const { ctx, calls } = mkCtx();

		await (implementationStage as Stage).run(mkState(), ctx);

		expect(calls.tdd).toHaveLength(2);
		expect(calls.tdd[1]!.prompt).toContain("RED runner diagnostics from the last oracle run");
		expect(calls.tdd[1]!.prompt).toContain("node --import tsx --test tests/red.test.ts");
		expect(calls.tdd[1]!.prompt).toContain("SyntaxError: Cannot use import statement outside a module");
		expect(calls.logs.some((l) => l.includes("RED runner diagnostic") && l.includes("SyntaxError"))).toBe(true);
	});

	it("stops on repeated no-progress evidence even if always-green", async () => {
		// Always green with the same test evidence: must NOT loop forever.
		redSeq("green");
		const { ctx, calls } = mkCtx();

		await (implementationStage as Stage).run(mkState(), ctx);

		expect(redCheck).toHaveBeenCalledTimes(2);
		expect(calls.tdd).toHaveLength(2);
		expect(calls.logs.some((l) => /RED generation stopped after 2 tries.*no progress/i.test(l))).toBe(true);
	});

	it("RC-3: stops an A-B-A-B OSCILLATION (green↔broken) within a few tries, not dozens", async () => {
		// The real 47-retry/15h livelock: consecutive signatures always DIFFER, so
		// the old `history[last] === sig` check never fired. Cycle detection must
		// catch the recurrence and stop.
		redCycle("green", "broken");
		const { ctx, calls } = mkCtx();

		await (implementationStage as Stage).run(mkState(), ctx);

		// Must terminate quickly once a prior state recurs — far below the old
		// unbounded behavior (and below MAX_RED_RETRIES=6).
		expect(calls.tdd.length).toBeLessThanOrEqual(6);
		expect(calls.tdd.length).toBeGreaterThanOrEqual(3); // needs ≥3 to observe a cycle
		expect(calls.impl).toHaveLength(0); // never proceeds to implementer
		expect(calls.logs.some((l) => /oscillating|no progress/i.test(l))).toBe(true);
	});
});

describe("P3 — RED loop: no-progress stop is a hard RED gate", () => {
	it("always-green → does NOT proceed to implementer and records red-not-confirmed", async () => {
		redSeq("green");
		const { ctx, calls } = mkCtx();
		const res = (await (implementationStage as Stage).run(mkState(), ctx)) as ControlObj;

		expect(calls.impl).toHaveLength(0);
		expect(res.phasesCompleted).toBe(0);
		expect(res.allGreen).toBe(false);
		expect(calls.logs.some((l) => /RED gate FAIL: red-not-confirmed/i.test(l))).toBe(true);
		expect(calls.logs.some((l) => /stopped before implementation: RED generation stopped after 2 tries.*no progress/i.test(l))).toBe(true);
	});

	it("no-progress stopped RED never tells an implementer to green weak tests", async () => {
		redSeq("green");
		const { ctx, calls } = mkCtx();
		await (implementationStage as Stage).run(mkState(), ctx);

		expect(calls.impl).toHaveLength(0);
	});
});

describe("P3 — RED loop: logs every red-oracle outcome", () => {
	it("emits one `red-oracle: <status>` log per runRedCheck invocation", async () => {
		redSeq("green", "red");
		const { ctx, calls } = mkCtx();
		await (implementationStage as Stage).run(mkState(), ctx);

		const oracleLogs = calls.logs.filter((l) => /red-oracle:\s*(red|green|broken|unknown)\b/.test(l));
		// one log per runRedCheck call (2 here).
		expect(oracleLogs).toHaveLength(2);
		// ...and the final one is red.
		expect(oracleLogs.some((l) => /red-oracle:\s*red\b/.test(l))).toBe(true);
	});
});

describe("P3 — RED loop does NOT change the outer commit structure", () => {
	it("when the hard gate repeats the same failure, the phase stops on no-progress", async () => {
		// RED loop passes immediately each attempt; the OUTER gate is what fails.
		redSeq("red");
		buildGate.mockImplementation(() => ({
			pass: false,
			inScopePass: false,
			ran: ["npm test"],
			errors: ["tests failed"],
			outOfScopeErrors: [],
		}));
		const { ctx } = mkCtx();
		const res = (await (implementationStage as Stage).run(mkState(), ctx)) as ControlObj;

		// Outer attempt loop is no-progress guarded: repeated identical gate evidence stops.
		expect(buildGate).toHaveBeenCalledTimes(2);
		expect(res.allGreen).toBe(false);
		expect(res.phasesCompleted).toBe(0);
	});

	it("gate.inScopePass still counts as green (commit condition unchanged)", async () => {
		// RED confirmed, gate fails overall but every failure is out-of-scope.
		redSeq("red");
		buildGate.mockImplementation(() => ({
			pass: false,
			inScopePass: true,
			ran: ["cargo test"],
			errors: ["pre-existing failure elsewhere"],
			outOfScopeErrors: ["crates/other/..."],
		}));
		const { ctx } = mkCtx();
		const res = (await (implementationStage as Stage).run(mkState(), ctx)) as ControlObj;

		expect(res.phasesCompleted).toBe(1);
		expect(res.allGreen).toBe(true);
	});
});
