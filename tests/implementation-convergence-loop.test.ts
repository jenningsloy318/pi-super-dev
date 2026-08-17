/**
 * §D auto-iterate convergence loop (design report §D). Drives implementationStage
 * TWICE over shared state to prove the per-phase green-state carry:
 *  - run 1: phase 1 green, phase 2 fails 5× → allGreen=false; phaseStatus records
 *    phase-1 green + phase-2 failed; lastFailures records phase-2 reasons.
 *  - run 2: phase 1 is SKIPPED (its implementer is NOT re-spawned — no
 *    state-confusion churn); phase 2 is re-attempted (seeded with the prior
 *    iteration's failure reasons) and converges → allGreen=true.
 *
 * This is the test the 1372 single-run tests can't cover: the multi-iteration
 * carry/skip/seed behavior that makes the outer convergence loop sound.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// Per-call gate queue (shifted). Seeded per-run below.
let gateQ: Array<{ pass: boolean; inScopePass: boolean; errors: string[]; outOfScopeErrors: string[]; ran: string[] }> = [];
const PASS = { pass: true, inScopePass: true, errors: [], outOfScopeErrors: [], ran: ["npm test"] };
const FAIL = { pass: false, inScopePass: false, errors: ["boom: compile error"], outOfScopeErrors: [], ran: ["npm test"] };
const DELIV_PASS = { pass: true, missing: [], ran: [] };
let userNotes = "";

vi.mock("../src/build-runner.ts", async (orig) => {
	const a = (await orig()) as Record<string, unknown>;
	return {
		...a,
		runRedCheck: () => "unknown",
		runBuildGate: () => gateQ.shift() ?? PASS,
		runDeliverableCheck: () => DELIV_PASS,
		computeChangeGate: () => ({ pass: true, claimedNotChanged: [], changedNotClaimed: [], advisory: [] }),
		resetDeliverableCheckCache: () => {},
	};
});
vi.mock("../src/render/render.ts", () => ({ renderAndWrite: vi.fn() }));
vi.mock("../src/render/reflection.ts", () => ({ runReflectionAsync: vi.fn() }));
vi.mock("../src/render/user-notes.ts", () => ({ userNotesForAgent: vi.fn(() => userNotes) }));

import { implementationStage } from "../src/stages/implementation.ts";
import type { PipelineState, StageContext, RunOptions, AgentResult, AgentCall, ControlObj, HelperResult } from "../src/types.ts";

const mkState = (): PipelineState => ({
	setup: { worktreePath: "/tmp/sd-conv", specDirectory: "/tmp/sd", defaultBranch: "main", language: "frontend", isWebUi: false, specIdentifier: "d", worktreeCreated: false, initializedRepo: false },
	classify: { taskType: "feature", uiScope: "none", language: "frontend", isWebUi: false },
	spec: { phases: [{ name: "Phase 1" }, { name: "Phase 2" }] },
} as unknown as PipelineState);

/** Captures which phases' implementer was spawned, per run. */
const mkCtx = (runLabel: string, opts: {
	/** Scripted implementer controls, CYCLED in order (A,B,A,B,… for
	 *  oscillation fixtures; last entry repeats when the queue drains). */
	implResults?: Array<{ text?: string; control: ControlObj | null }>;
	/** Budget check override (bounds the attempt loop for old-code RED runs). */
	budgetCheck?: () => boolean;
} = {}) => {
	const implPhases: string[] = [];
	const implCalls: AgentCall[] = [];
	const logs: string[] = [];
	const implQueue = [...(opts.implResults ?? [])];
	const ctx: StageContext = {
		task: "conv", options: {} as RunOptions, state: {} as PipelineState,
		async helper(): Promise<HelperResult> { return { value: { languageInstructions: "" }, digest: "" }; },
		async agent(call): Promise<AgentResult> {
			if (call.agent === "implementer") {
				const m = /pipeline\.implementation\.(phase-\d+)\.impl/.exec(call.id);
				if (m) implPhases.push(m[1]);
				implCalls.push(call);
				const scripted = implQueue.length > 1 ? implQueue.shift()! : (implQueue[0] ?? null);
				if (scripted) return { text: scripted.text ?? "", control: scripted.control ?? {} };
				return { text: "ok", control: {} };
			}
			return { text: "ok", control: {} };
		},
		parallel: async (cs: Array<() => Promise<AgentResult>>) => Promise.all(cs.map((c) => c())),
		budget: { check: opts.budgetCheck ?? (() => true), spent: () => true, count: 0 },
		log: (message: string) => { logs.push(message); }, phase: () => {}, events: { on: () => () => {}, emit: () => {} } as never, results: [],
	};
	return { ctx, implPhases, implCalls, logs, runLabel };
};

describe("§D convergence loop — per-phase green-state carry", () => {
	beforeEach(() => { gateQ = []; userNotes = ""; });

	it("run 1: phase 1 green, phase 2 fails → allGreen=false, phaseStatus + lastFailures recorded", async () => {
		gateQ = [PASS, FAIL, FAIL, FAIL, FAIL, FAIL]; // phase1 passes att1; phase2 fails 5×
		const { ctx } = mkCtx("run1");
		const state = mkState();
		const out = await implementationStage.run(state, ctx) as { allGreen: boolean; phasesCompleted: number; totalPhases: number; phaseStatus: Array<{ id: string; status: string }>; lastFailures: Array<{ phaseId: string; reasons: string[] }> };
		expect(out.allGreen).toBe(false);
		expect(out.phasesCompleted).toBe(1);
		expect(out.totalPhases).toBe(2);
		expect(out.phaseStatus).toEqual([{ id: "phase-01", status: "green" }, { id: "phase-02", status: "failed" }]);
		expect(out.lastFailures.map((f) => f.phaseId)).toEqual(["phase-02"]);
		expect(out.lastFailures[0]!.reasons.length).toBeGreaterThan(0);
	});

	it("run 2 (shared state): phase 1 SKIPPED (implementer not re-spawned), phase 2 re-attempted → converges (allGreen=true)", async () => {
		// run 1
		gateQ = [PASS, FAIL, FAIL, FAIL, FAIL, FAIL];
		const r1 = mkCtx("run1");
		const state = mkState();
		const out1 = await implementationStage.run(state, r1.ctx);
		// thread the carry through state (as the outer loop + task node do)
		(state as unknown as Record<string, unknown>).implementation = out1;

		// run 2: phase 2 now passes
		gateQ = [PASS]; // only phase 2 gets a gate call (phase 1 skipped)
		const r2 = mkCtx("run2");
		const out2 = await implementationStage.run(state, r2.ctx) as { allGreen: boolean; phasesCompleted: number; phaseStatus: Array<{ id: string; status: string }> };

		expect(out2.allGreen).toBe(true); // converged
		expect(out2.phasesCompleted).toBe(2);
		// the headline §D invariant: phase 1 was NOT re-implemented on run 2
		expect(r2.implPhases).not.toContain("phase-01");
		expect(r2.implPhases).toContain("phase-02"); // phase 2 was re-attempted
		expect(out2.phaseStatus.every((p) => p.status === "green")).toBe(true);
	});

	it("runtime instructions arriving during implementation force a follow-up pass that reruns earlier green phases", async () => {
		gateQ = [PASS, PASS];
		const state = mkState();
		const r1 = mkCtx("run1");
		// Simulate a user instruction captured after implementation starts. The
		// stage should finish the current pass but report allGreen=false so the
		// outer convergence loop re-enters with the new instruction visible from
		// phase 1 onward.
		const originalAgent = r1.ctx.agent;
		r1.ctx.agent = async (call) => {
			const result = await originalAgent(call);
			if (call.id.includes("phase-01.impl")) userNotes = "(1) switch filters to backend-backed multi-select";
			return result;
		};
		const out1 = await implementationStage.run(state, r1.ctx) as { allGreen: boolean; invalidatedByRuntimeInstructions?: boolean; runtimeInstructionFingerprint?: string };
		expect(out1.allGreen).toBe(false);
		expect(out1.invalidatedByRuntimeInstructions).toBe(true);
		(state as unknown as Record<string, unknown>).implementation = out1;

		gateQ = [PASS, PASS];
		const r2 = mkCtx("run2");
		const out2 = await implementationStage.run(state, r2.ctx) as { allGreen: boolean; invalidatedByRuntimeInstructions?: boolean };
		expect(r2.implPhases).toContain("phase-01");
		expect(r2.implPhases).toContain("phase-02");
		expect(out2.allGreen).toBe(true);
		expect(out2.invalidatedByRuntimeInstructions).toBe(false);
	});

	it("runtime instructions drained by the implementation summary spawn still invalidate the pass", async () => {
		gateQ = [PASS, PASS];
		const state = mkState();
		const r1 = mkCtx("run1");
		const originalAgent = r1.ctx.agent;
		r1.ctx.agent = async (call) => {
			const result = await originalAgent(call);
			if (call.id === "pipeline.implementation.summary") userNotes = "(1) make filters backend-backed multi-select";
			return result;
		};
		const out1 = await implementationStage.run(state, r1.ctx) as { allGreen: boolean; invalidatedByRuntimeInstructions?: boolean };
		expect(out1.allGreen).toBe(false);
		expect(out1.invalidatedByRuntimeInstructions).toBe(true);
		(state as unknown as Record<string, unknown>).implementation = out1;

		gateQ = [PASS, PASS];
		const r2 = mkCtx("run2");
		const out2 = await implementationStage.run(state, r2.ctx) as { allGreen: boolean };
		expect(r2.implPhases).toContain("phase-01");
		expect(r2.implPhases).toContain("phase-02");
		expect(out2.allGreen).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// H3 (spec-28, AC-03 → SCENARIO-006/007): GREEN-loop NON-CONSECUTIVE signature
// recurrence. `repeatedNoProgress` must match ANY earlier history entry (the
// mirror of the RED loop's `redProgressHistory.includes(signature)` at the RC-3
// bound of tests/implementation-red-loop.test.ts:441 — ≤ 6 attempts), not only
// the immediately-preceding one. A↔B oscillation used to slip the consecutive
// check forever (each attempt differs from the last) until budget death.
// ---------------------------------------------------------------------------

describe("H3 — GREEN-loop A↔B recurrence detection (AC-03, SCENARIO-006/007)", () => {
	beforeEach(() => { gateQ = []; userNotes = ""; });

	const singlePhaseState = (): PipelineState => ({
		setup: { worktreePath: "/tmp/sd-conv", specDirectory: "/tmp/sd", defaultBranch: "main", language: "frontend", isWebUi: false, specIdentifier: "d", worktreeCreated: false, initializedRepo: false },
		classify: { taskType: "feature", uiScope: "none", language: "frontend", isWebUi: false },
		spec: { phases: [{ name: "Phase 1" }] },
	} as unknown as PipelineState);

	/** Alternating gate failures: signature A = gate-error set A + footprint A,
	 *  signature B = gate-error set B + footprint B. Both channels alternate so
	 *  each attempt's (failure, footprint) pair reproduces EXACTLY every other
	 *  attempt — the A→B→A→B oscillation shape. */
	const FAIL_A = { pass: false, inScopePass: false, errors: ["gate A: TS2322 type error in src/module-a.ts"], outOfScopeErrors: [] as string[], ran: ["npm test"] };
	const FAIL_B = { pass: false, inScopePass: false, errors: ["gate B: missing export handleB in src/module-b.ts"], outOfScopeErrors: [] as string[], ran: ["npm test"] };
	const IMPL_A = { control: { filesModified: ["src/module-a.ts"] } };
	const IMPL_B = { control: { filesModified: ["src/module-b.ts"] } };

	it("SCENARIO-006: A→B→A→B signature oscillation trips no-progress within the mirror bound (≤6 attempts) — never budget death", async () => {
		// 24 alternating pairs queued: old (consecutive-only) code runs to budget
		// death here; the recurrence detector must stop it at the 3rd attempt.
		gateQ = Array.from({ length: 24 }, (_, i) => (i % 2 === 0 ? FAIL_A : FAIL_B));
		let budgetCalls = 0;
		const budgetCheck = () => ++budgetCalls < 200; // generous: budget is NOT the trip mechanism
		const { ctx, implCalls, logs } = mkCtx("osc", {
			implResults: [IMPL_A, IMPL_B, IMPL_A, IMPL_B, IMPL_A, IMPL_B],
			budgetCheck,
		});

		const out = await implementationStage.run(singlePhaseState(), ctx) as { allGreen: boolean };

		expect(out.allGreen).toBe(false);
		// The existing no-progress branch fires (judge routing / HITL escalation).
		expect(logs.some((l) => /stopped after repeated no-progress failure on attempt/.test(l))).toBe(true);
		// Mirror bound of tests/implementation-red-loop.test.ts:441 — a few tries,
		// not dozens.
		expect(implCalls.length).toBeLessThanOrEqual(6);
		expect(implCalls.length).toBeGreaterThanOrEqual(3); // needs ≥3 to observe a recurrence
		// NEVER budget death as the trip mechanism.
		expect(logs.some((l) => /budget exhausted/.test(l))).toBe(false);
	}, 20_000);

	it("SCENARIO-007: strictly fresh signatures (A,B,C,D,…) never trip no-progress — the loop continues on its normal budget", async () => {
		const distinctFails = [1, 2, 3, 4, 5, 6].map((n) => ({
			pass: false, inScopePass: false,
			errors: [`distinct gate failure #${n}: error kind ${n}`],
			outOfScopeErrors: [] as string[], ran: ["npm test"],
		}));
		const distinctImpls = distinctFails.map((_, i) => ({ control: { filesModified: [`src/fresh-${i + 1}.ts`] } }));
		// Six distinct FAILED attempts, then a PASS: with a healthy detector every
		// distinct signature gets its attempt (6 fails), the 7th goes green, and
		// the no-progress branch NEVER fires. Unbounded budget — the loop is not
		// budget-tripped here.
		gateQ = [...distinctFails, PASS];
		const { ctx, implCalls, logs } = mkCtx("fresh", {
			implResults: [...distinctImpls, { control: { filesModified: ["src/final.ts"] } }],
			budgetCheck: () => true,
		});

		const out = await implementationStage.run(singlePhaseState(), ctx) as { allGreen: boolean };

		expect(out.allGreen).toBe(true); // the fresh run converged on its own
		expect(implCalls).toHaveLength(7); // every distinct signature got its attempt, then green
		expect(logs.some((l) => /stopped after repeated no-progress failure on attempt/.test(l))).toBe(false);
		expect(logs.some((l) => /budget exhausted/.test(l))).toBe(false);
	}, 20_000);

	it("SCENARIO-006 (empty history): the FIRST attempt is never no-progress — identical repeats fire at attempt 2", async () => {
		gateQ = [FAIL_A, FAIL_A, FAIL_A];
		const { ctx, implCalls, logs } = mkCtx("repeat", {
			implResults: [IMPL_A, IMPL_A, IMPL_A],
			budgetCheck: () => true,
		});
		await implementationStage.run(singlePhaseState(), ctx);
		// The pre-existing consecutive-identical behavior is unchanged.
		expect(implCalls).toHaveLength(2);
		expect(logs.some((l) => /stopped after repeated no-progress failure on attempt 2/.test(l))).toBe(true);
	}, 20_000);
});
