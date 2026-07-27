/**
 * BUG-1 — structural cache identity for parallel branches.
 *
 * The resume cache key is now the call's STRUCTURAL position
 * (`callId@scopePath#occurrence`), not a sequential invocation counter. Two
 * parallel branches get DISTINCT, ORDER-INDEPENDENT keys (`parallel[0]` vs
 * `parallel[1]`) regardless of which `ctx.agent` fires first — so resume
 * fast-forwards correctly instead of re-running branches whose invocation order
 * shifted. (Honest scope: this is a determinism/efficiency fix for resume under
 * parallelism, NOT a wrong-result bug — the callId is in the key, so a branch
 * can never read another branch's result.)
 *
 * Harness mirrors tests/workflow-user-steer.test.ts: backends mocked so no real
 * agent spawns; makeContext provides the real withScope (AsyncLocalStorage).
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("../src/session-agent.ts", () => ({
	runAgentViaSession: vi.fn(async (opts: { id?: string }) => ({ text: "ok", control: { id: opts.id } })),
	summarizeSlug: vi.fn(async () => "x"),
}));
vi.mock("../src/pi-spawn.ts", () => ({
	spawnAgent: vi.fn(async (opts: { id?: string }) => ({ text: "ok", control: { id: opts.id } })),
	isBrowserAgent: vi.fn(() => false),
	needsWebResearch: vi.fn(() => false),
}));
vi.mock("../src/render/knowledge.ts", () => ({ knowledgeForAgent: vi.fn(() => "") }));

import { makeContext } from "../src/workflow.ts";
import { task, parallel } from "../src/nodes.ts";
import type { AgentResult, PipelineState, RunOptions, Stage } from "../src/types.ts";

const mkCtx = (state: PipelineState, options: RunOptions = {}) =>
	makeContext(state, "t", { ...options, maxConcurrency: 2 }, () => {});

/** A stage that calls ctx.agent once with the given call id, storing the result. */
const agentStage = (stageId: string, callId: string): Stage => ({
	id: stageId, label: stageId,
	async run(state, ctx) {
		const r = await ctx.agent({ id: callId, agent: "x", prompt: "p" });
		(state as Record<string, unknown>)[stageId] = r.control;
		return r.control;
	},
});

describe("structural cache keys for parallel branches (BUG-1)", () => {
	it("two parallel branches with the SAME call.id get DISTINCT positional keys", async () => {
		// Same call.id stresses the disambiguation: the OLD `id#seq` scheme keyed
		// them `id#1` / `id#2` in invocation ORDER (order-dependent). The new
		// scheme keys them by branch POSITION (`parallel[0]` / `parallel[1]`) —
		// deterministic regardless of which fires first.
		const cache = new Map<string, AgentResult>();
		const options: RunOptions = { resumeCache: cache };
		const ctx = mkCtx({}, options);
		const wf = parallel([task(agentStage("a", "pipeline.review")), task(agentStage("b", "pipeline.review"))]);
		await wf.run({}, ctx);
		const keys = [...cache.keys()];
		expect(keys).toContain("pipeline.review@parallel[0]#1");
		expect(keys).toContain("pipeline.review@parallel[1]#1");
		expect(keys.length).toBe(2);
	});

	it("re-running with the populated cache fast-forwards both branches (deterministic resume)", async () => {
		// Populate the cache in run 1, then a fresh context (same cache) re-runs
		// the workflow: both branches must HIT (realAgent never called) because
		// the positional keys match exactly — proving order-independent resume.
		const cache = new Map<string, AgentResult>();
		const ctx1 = mkCtx({}, { resumeCache: cache });
		const wf = parallel([task(agentStage("a", "pipeline.r")), task(agentStage("b", "pipeline.r"))]);
		await wf.run({}, ctx1);
		expect(ctx1.budget.count).toBe(2); // both ran (miss)

		const ctx2 = mkCtx({}, { resumeCache: cache });
		await wf.run({}, ctx2);
		expect(ctx2.budget.count).toBe(0); // both HIT — fast-forwarded, no spawns
	});
});
