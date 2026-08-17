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

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
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
	judge: AgentCall[];
	coverage: AgentCall[];
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
	/** Scripted implementer responses (Fix 3/5): per-attempt text + control. */
	implResults?: Array<{ text: string; control: ControlObj | null }>;
	/** Scripted tdd-coverage-classifier controls, consumed in order per call
	 *  (default: trivially all-covered so accepted RED proceeds). */
	coverageControls?: ControlObj[];
	/** Escalate callback (captures the EscalationFailure) for no-progress tests. */
	escalate?: RunOptions["escalate"];
	/** Scripted judge controls (J9-a/J9-b), consumed in order per judge call. */
	judgeResults?: Array<Record<string, unknown> | null>;
} = {}): { ctx: StageContext; calls: CapturedCalls } {
	const calls: CapturedCalls = {
		tdd: [],
		impl: [],
		orch: [],
		judge: [],
		coverage: [],
		helper: 0,
		logs: [],
	};
	const judgeQ = [...(opts.judgeResults ?? [])];
	const reviewQ = [...(opts.reviewVerdicts ?? [])];
	const contradictionQ = [...(opts.reviewContradictions ?? [])];
	const coverageQ = [...(opts.coverageControls ?? [{ allCovered: true, coveredScenarios: [], missingScenarios: [], summary: "all expected scenarios covered" }])];
	const ctx: StageContext = {
		task: "",
		options: { escalate: opts.escalate } as RunOptions,
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
				const scripted = opts.implResults?.shift();
				if (scripted) return { text: scripted.text, control: scripted.control };
				return { text: "", control: { filesModified: ["src/x.ts"] } };
			}
			if (call.agent === "judge") {
				calls.judge.push(call);
				const scripted = judgeQ.shift();
				return { text: "", control: scripted ?? null };
			}
			if (call.agent === "tdd-coverage-classifier") {
				calls.coverage.push(call);
				const scripted = coverageQ.length > 0 ? coverageQ.shift()! : {};
				return { text: "", control: scripted };
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

describe("no-progress escalation evidence conservation (Fix 3 + Fix 5)", () => {
	/** Persistently-failing build gate so consecutive implementer attempts
	 *  produce an identical failure signature → repeatedNoProgress at attempt 2. */
	beforeEach(() => {
		buildGate.mockImplementation(() => ({
			pass: false,
			inScopePass: false,
			ran: ["npm test"],
			errors: ["assert save(1) === 2 — SCENARIO-029 determinism"],
			outOfScopeErrors: [],
		}));
	});

	const PROOF_TEXT = "I have proven the test is unsatisfiable: SCENARIO-029 requires byte-identical samples while SCENARIO-016 requires a G4 error in dimErrs — no conforming implementation can satisfy both.";

	it("Fix 3: proof carried ONLY in implementer text (no structured testDefects) is surfaced in the escalation message + findings", async () => {
		redSeq("red", "red");
		const failures: Array<{ message: string; findings: Array<{ title?: string }> }> = [];
		const escalate = (async (failure: { message: string; findings: Array<{ title?: string }> }) => {
			failures.push(failure);
			return undefined; // dismissed → terminal no-progress break
		}) as unknown as RunOptions["escalate"];
		const { ctx, calls } = mkCtx({
			reviewVerdicts: ["strong"],
			implResults: [
				{ text: PROOF_TEXT, control: { filesModified: ["src/x.ts"] } },
				{ text: PROOF_TEXT, control: { filesModified: ["src/x.ts"] } },
			],
			escalate,
		});
		await (implementationStage as Stage).run(mkState(), ctx);

		expect(calls.impl).toHaveLength(2); // no-progress fired at attempt 2
		expect(failures).toHaveLength(1);
		// The reasoning tail rides along, raw and bounded.
		expect(failures[0].message).toContain("Implementer's latest diagnosis (reasoning tail):");
		expect(failures[0].message).toContain("byte-identical samples");
		// A finding leads with the diagnosis first line.
		expect(failures[0].findings.some((f) => (f.title ?? "").startsWith("implementer diagnosis: I have proven the test is unsatisfiable"))).toBe(true);
	});

	it("Fix 5: the same shape against a CONFIRMED RED logs the text-proof advisory and marks the message text-evidence-only (never auto re-authors)", async () => {
		redSeq("red", "red");
		const failures: Array<{ message: string }> = [];
		const escalate = (async (failure: { message: string }) => {
			failures.push(failure);
			return undefined;
		}) as unknown as RunOptions["escalate"];
		const { ctx, calls } = mkCtx({
			reviewVerdicts: ["strong"],
			implResults: [
				{ text: PROOF_TEXT, control: { filesModified: ["src/x.ts"] } },
				{ text: PROOF_TEXT, control: { filesModified: ["src/x.ts"] } },
			],
			escalate,
		});
		await (implementationStage as Stage).run(mkState(), ctx);

		expect(calls.tdd).toHaveLength(1); // text alone NEVER triggers a re-author
		expect(failures[0].message).toContain("POSSIBLE UNSATISFIABLE RED (text evidence only — unverified)");
		expect(calls.logs.some((l) => /advisory: implementer text matches unsatisfiability markers/.test(l))).toBe(true);
	});

	it("Fix 3 scoping: a tail WITHOUT proof markers is still surfaced, but never flagged as a suspected unsatisfiable RED", async () => {
		redSeq("red", "red");
		const failures: Array<{ message: string }> = [];
		const escalate = (async (failure: { message: string }) => {
			failures.push(failure);
			return undefined;
		}) as unknown as RunOptions["escalate"];
		const { ctx } = mkCtx({
			reviewVerdicts: ["strong"],
			implResults: [
				{ text: "Tried flipping the order of operations; the off-by-one persists in the merge step.", control: { filesModified: ["src/x.ts"] } },
				{ text: "Tried flipping the order of operations; the off-by-one persists in the merge step.", control: { filesModified: ["src/x.ts"] } },
			],
			escalate,
		});
		await (implementationStage as Stage).run(mkState(), ctx);

		expect(failures[0].message).toContain("Implementer's latest diagnosis (reasoning tail):");
		expect(failures[0].message).not.toContain("POSSIBLE UNSATISFIABLE RED");
	});

	it("Fix 3 precedence: structured testDefects take precedence over the text tail (no duplicate diagnosis block)", async () => {
		// MAX_CHALLENGE_REAUTHORS defaults to 2: attempts 1-2's defects are
		// consumed by the challenge re-author loop (the Fix 1 path); after the
		// cap, attempts 3-4 carry the SAME defects into no-progress, where the
		// structured report is the surfaced evidence and the text tail is NOT
		// duplicated (implDiagnosisTail is scoped to the defects-empty case).
		redSeq("red", "red", "red", "red");
		const failures: Array<{ message: string }> = [];
		const escalate = (async (failure: { message: string }) => {
			failures.push(failure);
			return undefined;
		}) as unknown as RunOptions["escalate"];
		const defect = { testFile: "tests/a.test.ts", lines: "606", reason: "SCENARIO-016 vs 029 contradiction" };
		const scripted = { text: PROOF_TEXT, control: { filesModified: ["src/x.ts"], testDefects: [defect] } };
		const { ctx, calls } = mkCtx({
			reviewVerdicts: ["strong"],
			implResults: [scripted, scripted, scripted, scripted],
			escalate,
		});
		await (implementationStage as Stage).run(mkState(), ctx);

		// Initial RED author + 2 challenge re-authors (attempts 1-2).
		expect(calls.tdd).toHaveLength(3);
		expect(failures[0].message).toContain("THE IMPLEMENTER REPORTS THE RED TEST IS UNSATISFIABLE: tests/a.test.ts (606): SCENARIO-016 vs 029 contradiction");
		expect(failures[0].message).not.toContain("reasoning tail");
	});
});
// ─── J9-a / J9-b: judge routing at the Stage 9 no-progress boundaries ────────

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetJudgeBudgets } from "../src/stages/judge.ts";

describe("judge routing layer (J9-a RED no-progress + J9-b implementer no-progress)", () => {
	const QUOTE = "expect(save(1)).toBe(2); // SCENARIO-029 determinism";
	let wt: string;
	beforeEach(() => {
		resetJudgeBudgets();
		delete process.env.SUPER_DEV_DISABLE_JUDGE;
		wt = mkdtempSync(join(tmpdir(), "sd-judge-"));
		mkdirSync(join(wt, "tests"), { recursive: true });
		writeFileSync(join(wt, "tests", "red.test.ts"), `import { save } from "../src/save";\n${QUOTE}\n`);
		redCheck.mockImplementation((_cwd: string, _targets: string[], opts?: { onResult?: (diagnostic: unknown) => void }) => {
			opts?.onResult?.({
				plan: { cwd: wt, argv: ["vitest", "run", "tests/red.test.ts"] },
				language: "backend",
				status: "red",
				exitCode: 1,
				signal: null,
				outputTail: "FAIL tests/red.test.ts > save determinism\n" + QUOTE,
			});
			return "red";
		});
	});
	afterEach(() => {
		try { rmSync(wt, { recursive: true, force: true }); } catch { /* tmp */ }
	});
	const judgeState = (): PipelineState => {
		const base = mkState();
		return { ...base, setup: { ...base.setup!, worktreePath: wt, specDirectory: join(wt, "docs", "specifications", "p3") } };
	};

	it("J9-a: RED ceiling consults the judge; re-author-tests restarts RED with the diagnosis", async () => {
		// Identical broken evidence every try → signature ceiling after MAX_RED_RETRIES.
		redSeq("broken", "broken", "broken", "broken", "broken", "broken", "broken", "broken");
		const { ctx, calls } = mkCtx({
			judgeResults: [{
				diagnosis: "the oracle output format is unknown to the classifier — the tests are fine but reference an unresolved module",
				route: "re-author-tests",
				confidence: 0.9,
				evidence: [{ file: "tests/red.test.ts", quote: QUOTE }],
			}],
		});
		await (implementationStage as Stage).run(judgeState(), ctx);
		// First call routes re-author-tests (RED restarts); the restarted RED stalls
		// identically again and consults the judge a SECOND time — per-signature
		// budget is 2, and with an empty queue the second call degrades to HITL.
		expect(calls.judge).toHaveLength(2);
		expect(calls.tdd.length).toBeGreaterThan(1); // RED loop restarted with the diagnosis
	}, 20_000);

	it("J9-a: a verified escalate-now verdict surfaces the diagnosis in the HITL message", async () => {
		redSeq("broken", "broken", "broken", "broken", "broken", "broken", "broken", "broken");
		const failures: Array<{ message: string }> = [];
		const escalate = (async (failure: { message: string }) => {
			failures.push(failure);
			return undefined;
		}) as unknown as RunOptions["escalate"];
		const { ctx, calls } = mkCtx({
			judgeResults: [{
				diagnosis: "toolchain output unclassifiable; human must decide the test command",
				route: "escalate-now",
				confidence: 0.9,
				evidence: [{ file: "tests/red.test.ts", quote: QUOTE }],
			}],
			escalate,
		});
		await (implementationStage as Stage).run(judgeState(), ctx);
		expect(calls.judge).toHaveLength(1);
		expect(failures).toHaveLength(1);
		expect(failures[0].message).toContain("JUDGE DIAGNOSIS (verified evidence)");
		expect(failures[0].message).toContain("toolchain output unclassifiable");
	}, 20_000);

	it("J9-b: challenge-test synthesizes the defect and re-runs the existing challenge edge", async () => {
		redSeq("red");
		buildGate.mockImplementation(() => ({
			pass: false,
			inScopePass: false,
			ran: ["npm test"],
			errors: ["tests failed identically"],
			outOfScopeErrors: [],
		}));
		const { ctx, calls } = mkCtx({
			judgeResults: [{
				diagnosis: "SCENARIO-029 contradicts SCENARIO-016 — the RED test is unsatisfiable",
				route: "challenge-test",
				confidence: 0.95,
				evidence: [{ file: "tests/red.test.ts", quote: QUOTE }],
			}],
			implResults: [
				{ text: "attempt 1 reasoning", control: { filesModified: ["src/x.ts"] } },
				{ text: "attempt 2 reasoning", control: { filesModified: ["src/x.ts"] } },
				{ text: "attempt 3 reasoning", control: { filesModified: ["src/x.ts"] } },
			],
			escalate: (async () => undefined) as unknown as RunOptions["escalate"],
		});
		await (implementationStage as Stage).run(judgeState(), ctx);
		expect(calls.judge.length).toBeGreaterThanOrEqual(1);
		// The re-author round-trips through tdd-guide with the judge-verified proof.
		const lastTdd = calls.tdd[calls.tdd.length - 1];
		expect(lastTdd.prompt).toContain("judge-verified: SCENARIO-029 contradicts SCENARIO-016");
		// And the implementer gets another attempt (not an immediate HITL stop).
		expect(calls.impl.length).toBeGreaterThanOrEqual(3);
	}, 20_000);

	it("J9-b: judge degraded (no control) keeps today's escalation exactly", async () => {
		redSeq("red");
		buildGate.mockImplementation(() => ({
			pass: false,
			inScopePass: false,
			ran: ["npm test"],
			errors: ["tests failed identically"],
			outOfScopeErrors: [],
		}));
		const failures: Array<{ message: string }> = [];
		const escalate = (async (failure: { message: string }) => {
			failures.push(failure);
			return undefined;
		}) as unknown as RunOptions["escalate"];
		const { ctx, calls } = mkCtx({
			judgeResults: [null],
			implResults: [
				{ text: "r1", control: { filesModified: ["src/x.ts"] } },
				{ text: "r2", control: { filesModified: ["src/x.ts"] } },
			],
			escalate,
		});
		await (implementationStage as Stage).run(judgeState(), ctx);
		expect(calls.judge).toHaveLength(1);
		expect(failures).toHaveLength(1);
		expect(failures[0].message).not.toContain("JUDGE DIAGNOSIS");
	}, 20_000);
});

// ─── AC-06 (spec-28, SCENARIO-013/014): RED scenario-coverage expectations
// read `tasks[].scenarioRefs` as the mapped subset. A multi-phase spec mapped
// ONLY via tasks must give each phase its task subset — never the full
// spec.scenarioRefs set (which demands every phase test every scenario).
// Asserted via the coverage verifier's prompt + missing-list/retry-hint
// content, the same observable surface the tdd-guide retry consumes.

describe("AC-06 — expectedScenariosForPhase reads task.scenarioRefs (SCENARIO-013/014)", () => {
	const mkTaskMappedState = (): PipelineState => ({
		setup: { worktreePath: "/tmp/sd-red-loop", specDirectory: "/tmp/sd", defaultBranch: "main", language: "frontend", isWebUi: false, specIdentifier: "p3", worktreeCreated: false, initializedRepo: false },
		classify: { taskType: "bug", uiScope: "none", language: "frontend", isWebUi: false },
		spec: {
			scenarioRefs: ["SCENARIO-001", "SCENARIO-002", "SCENARIO-003", "SCENARIO-004", "SCENARIO-005"],
			phases: [{ name: "Phase 1" }, { name: "Phase 2" }],
			tasks: [
				{ phase: "Phase 1", description: "auth", scenarioRefs: ["SCENARIO-001", "SCENARIO-002"] },
				{ phase: "Phase 2", description: "billing", scenarioRefs: ["SCENARIO-003"] },
			],
		},
	} as unknown as PipelineState);

	it("SCENARIO-013: each phase's expected set is the task subset, never the full five-scenario spec set", async () => {
		redSeq("red");
		const ALL_FIVE = ["SCENARIO-001", "SCENARIO-002", "SCENARIO-003", "SCENARIO-004", "SCENARIO-005"];
		const { ctx, calls } = mkCtx({
			coverageControls: [
				// phase 1, try 1: nothing covered yet → coverage FAIL → retry hint
				{ allCovered: false, coveredScenarios: [], missingScenarios: [], summary: "no scenario-mapped tests found" },
				// phase 1, try 2 + phase 2, try 1: the verifier reports the union of
				// scenario-mapped tests (the diff filters it to each phase's expected
				// set, so this control is pass-shaped under BOTH the task-subset and
				// the full-spec expectation — the assertions below pin WHICH set the
				// stage demanded in the prompt/hint).
				{ allCovered: true, coveredScenarios: ALL_FIVE, missingScenarios: [], summary: "covered" },
				{ allCovered: true, coveredScenarios: ALL_FIVE, missingScenarios: [], summary: "covered" },
			],
		});

		const res = (await (implementationStage as Stage).run(mkTaskMappedState(), ctx)) as ControlObj;

		expect(res.allGreen).toBe(true);
		expect(calls.coverage).toHaveLength(3); // P1×2 (fail→retry), P2×1
		// The coverage verifier prompt carries the TASK SUBSET per phase…
		expect(calls.coverage[0]!.prompt).toContain("Expected scenarios: SCENARIO-001, SCENARIO-002");
		expect(calls.coverage[0]!.prompt).not.toContain("SCENARIO-003");
		expect(calls.coverage[2]!.prompt).toContain("Expected scenarios: SCENARIO-003");
		expect(calls.coverage[2]!.prompt).not.toContain("SCENARIO-001");
		// …and the retry hint demands exactly the task subset (missing-list +
		// expected-set content), not the full spec set.
		expect(calls.tdd[1]!.prompt).toMatch(/coverage for every expected BDD scenario: SCENARIO-001, SCENARIO-002/);
		expect(calls.tdd[1]!.prompt).not.toMatch(/SCENARIO-005/);
		expect(calls.tdd).toHaveLength(3); // P1 RED + P1 retry + P2 RED
	}, 20_000);

	it("SCENARIO-014: the full spec scenarioRefs set is used only when phase- AND task-level refs are both empty", async () => {
		redSeq("red");
		const state = {
			setup: { worktreePath: "/tmp/sd-red-loop", specDirectory: "/tmp/sd", defaultBranch: "main", language: "frontend", isWebUi: false, specIdentifier: "p3", worktreeCreated: false, initializedRepo: false },
			classify: { taskType: "bug", uiScope: "none", language: "frontend", isWebUi: false },
			spec: {
				scenarioRefs: ["SCENARIO-011", "SCENARIO-012", "SCENARIO-013"],
				phases: [{ name: "Phase 1" }],
				tasks: [{ phase: "Phase 1", description: "a task with no scenario refs of its own" }],
			},
		} as unknown as PipelineState;
		const { ctx, calls } = mkCtx({
			coverageControls: [{ allCovered: true, coveredScenarios: ["SCENARIO-011", "SCENARIO-012", "SCENARIO-013"], missingScenarios: [], summary: "covered" }],
		});

		const res = (await (implementationStage as Stage).run(state, ctx)) as ControlObj;

		expect(res.allGreen).toBe(true);
		expect(calls.coverage[0]!.prompt).toContain("Expected scenarios: SCENARIO-011, SCENARIO-012, SCENARIO-013");
	}, 20_000);
});
