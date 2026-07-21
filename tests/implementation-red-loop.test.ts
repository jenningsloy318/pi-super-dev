/**
 * Phase P3 — RED enforcement loop inside implementation.ts — RED phase (TDD).
 *
 * These tests define the AC-02 contract for the Stage 9 implementation stage's
 * bounded RED-enforcement loop BEFORE the wiring exists. Today
 * `src/stages/implementation.ts` calls the `tdd-guide` agent and DISCARDS its
 * result (implementation.ts:70 has no left-hand assignment); `runRedCheck` —
 * delivered in P2 — is never invoked from the stage, and there is no
 * `MAX_RED_RETRIES` constant or `red-oracle` log line. So every assertion here
 * is RED until Phase P3 wires the loop.
 *
 * Contract (spec §B / AC-02 → SCENARIO-006/007/008/009/010):
 *   - After the initial `tdd-guide` call, capture its `control.testFiles` and
 *     call `runRedCheck(worktreePath, testFiles, { signal })` ONCE.
 *   - `while (status === "green" || status === "broken") && retries < MAX_RED_RETRIES`
 *       re-prompt `tdd-guide` (status-specific hint), re-run `runRedCheck`.
 *   - On `"red"` OR `"unknown"` → proceed to the implementer (NO further
 *     re-prompt). `unknown` proceeds immediately (zero re-prompts) so
 *     greenfield pipelines NEVER stall.
 *   - On cap exhaustion (still green/broken after MAX_RED_RETRIES=2 re-prompts)
 *     → proceed to the implementer with a LOUD WARNING log.
 *   - Log EVERY red-oracle outcome as
 *       `Implementation ${phaseId} red-oracle: ${status} (ran: ...)`
 *   - Augment the implementer prompt: when `status === "red"`, tell it the
 *     tests are CONFIRMED-red (goal = green them); when `unknown` /
 *     cap-exhausted, note red could NOT be confirmed.
 *   - The OUTER `MAX_ATTEMPTS = 3` structure and the
 *     `gate.pass || gate.inScopePass` commit condition are UNCHANGED.
 *
 * RED status: because the stage never calls runRedCheck today, every
 * `runRedCheck` call-count assertion sees 0, every "CONFIRMED-red" prompt
 * assertion fails, and no "red-oracle" / "red-oracle WARNING" log line is ever
 * emitted — exactly the RED signal we want.
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
} = {}): { ctx: StageContext; calls: CapturedCalls } {
	const calls: CapturedCalls = {
		tdd: [],
		impl: [],
		orch: [],
		helper: 0,
		logs: [],
	};
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
			},
		} satisfies Budget,
		log(message: string) {
			calls.logs.push(message);
		},
		events: new EventEmitter(),
		results: [],
	};
	return { ctx, calls };
}

/** Sequence runRedCheck to return the given statuses in order, repeating the
 *  last one indefinitely (so cap-exhaustion tests always stay green/broken). */
function redSeq(...statuses: string[]): void {
	let i = 0;
	redCheck.mockImplementation(() => {
		const s = statuses[Math.min(i, statuses.length - 1)];
		i++;
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

	it("augments the implementer prompt with a CONFIRMED-red note when status === 'red'", async () => {
		redSeq("red");
		const { ctx, calls } = mkCtx();
		await (implementationStage as Stage).run(mkState(), ctx);

		expect(calls.impl).toHaveLength(1);
		expect(calls.impl[0].prompt).toMatch(/CONFIRMED-red/i);
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

describe("P3 — RED loop: green/broken triggers a bounded re-prompt (SCENARIO-007)", () => {
	it("green → green → red: re-prompts tdd-guide until red, capped at MAX_RED_RETRIES=2", async () => {
		redSeq("green", "green", "red");
		const { ctx, calls } = mkCtx();

		await (implementationStage as Stage).run(mkState(), ctx);

		// initial runRedCheck + 2 retries = 3 oracle calls (MAX_RED_RETRIES + 1).
		expect(redCheck).toHaveBeenCalledTimes(3);
		// initial tdd-guide + 2 re-prompts = 3 tdd-guide calls.
		expect(calls.tdd).toHaveLength(3);
		// reached red → implementer prompt IS confirmed-red.
		expect(calls.impl).toHaveLength(1);
		expect(calls.impl[0].prompt).toMatch(/CONFIRMED-red/i);
	});

	it("broken is treated identically to green (re-prompts, same cap)", async () => {
		redSeq("broken", "broken", "red");
		const { ctx, calls } = mkCtx();

		await (implementationStage as Stage).run(mkState(), ctx);

		expect(redCheck).toHaveBeenCalledTimes(3);
		expect(calls.tdd).toHaveLength(3);
		expect(calls.impl[0].prompt).toMatch(/CONFIRMED-red/i);
	});

	it("never exceeds MAX_RED_RETRIES re-prompts even if always-green", async () => {
		// Always green: must NOT loop forever — capped at MAX_RED_RETRIES+1 calls.
		redSeq("green");
		const { ctx, calls } = mkCtx();

		await (implementationStage as Stage).run(mkState(), ctx);

		expect(redCheck).toHaveBeenCalledTimes(3); // 1 + MAX_RED_RETRIES(2)
		expect(calls.tdd).toHaveLength(3);
	});
});

describe("P3 — RED loop: cap exhaustion proceeds with a LOUD warning (SCENARIO-009)", () => {
	it("always-green → proceeds to implementer AND logs a red-oracle WARNING", async () => {
		redSeq("green");
		const { ctx, calls } = mkCtx();
		const res = (await (implementationStage as Stage).run(mkState(), ctx)) as ControlObj;

		// cap reached but does NOT stall the pipeline — implementer still runs.
		expect(calls.impl).toHaveLength(1);
		expect(res.phasesCompleted).toBe(1);
		expect(calls.logs.some((l) => /red-oracle WARNING/i.test(l))).toBe(true);
	});

	it("cap-exhausted (not red) does NOT tell the implementer the tests are CONFIRMED-red", async () => {
		redSeq("green");
		const { ctx, calls } = mkCtx();
		await (implementationStage as Stage).run(mkState(), ctx);

		expect(calls.impl[0].prompt).not.toMatch(/CONFIRMED-red/i);
	});
});

describe("P3 — RED loop: logs every red-oracle outcome", () => {
	it("emits one `red-oracle: <status>` log per runRedCheck invocation", async () => {
		redSeq("green", "green", "red");
		const { ctx, calls } = mkCtx();
		await (implementationStage as Stage).run(mkState(), ctx);

		const oracleLogs = calls.logs.filter((l) => /red-oracle:\s*(red|green|broken|unknown)\b/.test(l));
		// one log per runRedCheck call (3 here).
		expect(oracleLogs).toHaveLength(3);
		// ...and the final one is red.
		expect(oracleLogs.some((l) => /red-oracle:\s*red\b/.test(l))).toBe(true);
	});
});

describe("P3 — RED loop does NOT change the outer MAX_ATTEMPTS=3 / commit structure", () => {
	it("when the hard gate fails every attempt, the phase fails after exactly MAX_ATTEMPTS=3", async () => {
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

		// Outer attempt loop is preserved: 3 gate runs, then give up.
		expect(buildGate).toHaveBeenCalledTimes(3);
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
