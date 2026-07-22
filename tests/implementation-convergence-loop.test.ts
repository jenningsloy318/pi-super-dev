/**
 * §D auto-iterate convergence loop (design report §D). Drives implementationStage
 * TWICE over shared state to prove the per-phase green-state carry:
 *  - run 1: phase 1 green, phase 2 fails 3× → allGreen=false; phaseStatus records
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

import { implementationStage } from "../src/stages/implementation.ts";
import type { PipelineState, StageContext, RunOptions, AgentResult, HelperResult } from "../src/types.ts";

const mkState = (): PipelineState => ({
	setup: { worktreePath: "/tmp/sd-conv", specDirectory: "/tmp/sd", defaultBranch: "main", language: "frontend", isWebUi: false, specIdentifier: "d", worktreeCreated: false, initializedRepo: false },
	classify: { taskType: "feature", uiScope: "none", language: "frontend", isWebUi: false },
	spec: { phases: [{ name: "Phase 1" }, { name: "Phase 2" }] },
} as unknown as PipelineState);

/** Captures which phases' implementer was spawned, per run. */
const mkCtx = (runLabel: string) => {
	const implPhases: string[] = [];
	const ctx: StageContext = {
		task: "conv", options: {} as RunOptions, state: {} as PipelineState,
		async helper(): Promise<HelperResult> { return { value: { languageInstructions: "" }, digest: "" }; },
		async agent(call): Promise<AgentResult> {
			if (call.agent === "implementer") {
				const m = /pipeline\.implementation\.(phase-\d+)\.impl/.exec(call.id);
				if (m) implPhases.push(m[1]);
			}
			return { text: "ok", control: {} };
		},
		parallel: async (cs: Array<() => Promise<AgentResult>>) => Promise.all(cs.map((c) => c())),
		budget: { check: () => true, spent: () => {}, count: 0 },
		log: () => {}, phase: () => {}, events: { on: () => () => {}, emit: () => {} } as never, results: [],
	};
	return { ctx, implPhases, runLabel };
};

describe("§D convergence loop — per-phase green-state carry", () => {
	beforeEach(() => { gateQ = []; });

	it("run 1: phase 1 green, phase 2 fails → allGreen=false, phaseStatus + lastFailures recorded", async () => {
		gateQ = [PASS, FAIL, FAIL, FAIL]; // phase1 passes att1; phase2 fails 3×
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
		gateQ = [PASS, FAIL, FAIL, FAIL];
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
});
