/**
 * v0.4.57 — the agent-budget terminal marker (the spawn-budget sibling of the
 * wall-fuse). Contracts:
 *  - first trip wins: the marker is stamped ONCE with the first stage id that
 *    found the budget exhausted; later trips never rewrite it;
 *  - nodes.ts task() stamps it on the budget-death branch (the failed row and
 *    the marker coexist — the row is honest, the marker classifies);
 *  - deriveRunStatus maps the marker to `partial (agent-budget)` with the
 *    fresh-budget resume note — bounded-by-design, distinct from a bug class;
 *  - a fully-converged run still reads success (the marker never downgrades
 *    convergence), and REPLAN keeps first-class precedence.
 */

import { describe, it, expect } from "vitest";
import { EventEmitter } from "node:events";
import {
	RUN_AGENT_BUDGET_MARKER,
	markAgentBudgetExhausted,
	readAgentBudgetMarker,
	agentBudgetStatusReason,
} from "../src/agent-budget-fuse.ts";
import { deriveRunStatus } from "../src/workflow/run-status.ts";
import { task } from "../src/nodes.ts";
import type { PipelineState, StageContext } from "../src/types.ts";

describe("agent-budget marker helpers", () => {
	it("first trip wins — a later trip never rewrites the stage id or count", () => {
		const state: { [key: string]: unknown } = {};
		const first = markAgentBudgetExhausted(state, "verify", 200, 1_000);
		const second = markAgentBudgetExhausted(state, "docs", 200, 2_000);
		expect(second).toBe(first);
		expect(readAgentBudgetMarker(state)).toMatchObject({ stageId: "verify", consumed: 200, trippedAt: 1_000 });
	});
	it("reads tolerate absent and garbage state", () => {
		expect(readAgentBudgetMarker({})).toBeUndefined();
		expect(readAgentBudgetMarker({ [RUN_AGENT_BUDGET_MARKER]: "garbage" })).toBeUndefined();
	});
	it("the reason line names the class, the numbers, and the fresh-budget resume semantics", () => {
		const text = agentBudgetStatusReason({ trippedAt: 0, stageId: "verify", consumed: 200 });
		expect(text).toContain("partial (agent-budget)");
		expect(text).toContain("maxAgents");
		expect(text).toContain("FRESH budget");
		expect(text).toContain('"verify"');
	});
});

describe("nodes.ts task() stamps the marker on the budget-death branch", () => {
	const ctxOf = (budget: { check(): boolean; count: number }): StageContext => ({
		task: "t", options: {}, state: {} as PipelineState,
		budget: budget as never,
		log: () => {}, phase: () => {}, events: new EventEmitter(), results: [],
		agent: async () => ({ control: {} }),
	} as unknown as StageContext);
	it("a stage starting with an exhausted budget fails AND stamps first-trip marker with the consumed count", async () => {
		const state = {} as PipelineState;
		const node = task({ id: "verify", label: "Verify", run: async () => ({ status: "ok" }) });
		const out = await node.run(state, ctxOf({ check: () => false, count: 200 }));
		expect(out).toMatchObject({ status: "failed" });
		expect(readAgentBudgetMarker(state as { [key: string]: unknown })).toMatchObject({ stageId: "verify", consumed: 200 });
	});
	it("a healthy budget stamps nothing", async () => {
		const state = {} as PipelineState;
		const node = task({ id: "verify", label: "Verify", run: async () => ({ status: "ok" }) });
		await node.run(state, ctxOf({ check: () => true, count: 0 }));
		expect(readAgentBudgetMarker(state as { [key: string]: unknown })).toBeUndefined();
	});
});

describe("deriveRunStatus maps the marker to the bounded-by-design terminal state", () => {
	const baseState = () => ({
		implementation: { totalPhases: 3, phasesCompleted: 3, allGreen: true },
		review: { verdict: "Approved" },
		buildGate: { pass: true },
	}) as unknown as PipelineState;
	it("a budget-death run (failed stage rows + marker) derives partial with the agent-budget reason", () => {
		const state = baseState();
		markAgentBudgetExhausted(state as { [key: string]: unknown }, "verificationSkippedReplan", 200);
		const out = deriveRunStatus({
			state,
			aborted: false,
			results: [
				{ id: "implementation", label: "Implementation", status: "ok" },
				{ id: "verificationSkippedReplan", label: "Verification (skipped: REPLAN pending)", status: "failed", error: 'task "verificationSkippedReplan": budget exhausted before stage start' },
			],
		});
		expect(out.status).toBe("partial");
		expect(out.statusReasons.some((r) => r.includes("partial (agent-budget)"))).toBe(true);
	});
	it("a fully-converged run keeps success even with a (stale) marker present", () => {
		const state = baseState();
		markAgentBudgetExhausted(state as { [key: string]: unknown }, "docs", 200);
		const out = deriveRunStatus({
			state,
			aborted: false,
			results: [{ id: "merge", label: "Merge", status: "ok" }],
		});
		expect(out.status).toBe("success");
	});
	it("REPLAN keeps first-class precedence over the budget marker", () => {
		const state = baseState();
		(state as { [key: string]: unknown }).__replan = { rounds: 1, owners: ["spec"] };
		markAgentBudgetExhausted(state as { [key: string]: unknown }, "verify", 200);
		const out = deriveRunStatus({ state, aborted: false, results: [] });
		expect(out.status).toBe("replan");
	});
});
