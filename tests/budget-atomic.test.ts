/**
 * BUG-4 — budget must be an ATOMIC reservation, not a post-hoc increment.
 *
 * Root cause: `realAgent` called `budget.spent()` (an unconditional increment)
 * with NO check, and stage bodies guarded with a read-only `check()` that
 * spans the await before `ctx.agent`. Two concurrent branches could both pass
 * `check()` (seeing count < max) before either `spent()`, so `maxAgents` was
 * exceeded by up to concurrency−1.
 *
 * Fix: `spent()` is the atomic reservation — it increments only if under the
 * cap and returns whether it succeeded; `realAgent` bails on `false`.
 *
 * Harness mirrors tests/workflow-user-steer.test.ts: backends mocked so no real
 * agent spawns; makeContext exposes the real `ctx.agent` budget path.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("../src/session-agent.ts", () => ({
	runAgentViaSession: vi.fn(async () => ({ text: "ok", control: { ran: true } })),
	summarizeSlug: vi.fn(async () => "x"),
}));
vi.mock("../src/pi-spawn.ts", () => ({
	spawnAgent: vi.fn(async () => ({ text: "ok", control: { ran: true } })),
	isBrowserAgent: vi.fn(() => false),
	needsWebResearch: vi.fn(() => false),
}));
vi.mock("../src/render/knowledge.ts", () => ({ knowledgeForAgent: vi.fn(() => "") }));

import { makeContext } from "../src/workflow.ts";
import type { AgentCall, PipelineState, RunOptions } from "../src/types.ts";

const mkCtx = (state: PipelineState, options: RunOptions = {}) =>
	makeContext(state, "t", options, () => {});

const CALL: AgentCall = { id: "pipeline.x", agent: "spec-writer", prompt: "p" };

describe("budget atomic reservation (BUG-4)", () => {
	it("concurrent ctx.agent calls cannot exceed maxAgents", async () => {
		// maxAgents:1. Fire TWO calls concurrently. Exactly one must proceed; the
		// other must get a budget-exhausted error. Pre-fix: both spent() → count=2.
		const ctx = mkCtx({}, { maxAgents: 1 });
		const [a, b] = await Promise.all([ctx.agent(CALL), ctx.agent(CALL)]);
		const errors = [a, b].filter((r) => r.error).length;
		const oks = [a, b].filter((r) => !r.error).length;
		expect(oks).toBe(1);
		expect(errors).toBe(1);
		expect(ctx.budget.count).toBe(1); // never exceeded
	});

	it("the exhausted call carries a budget error (not a silent success)", async () => {
		const ctx = mkCtx({}, { maxAgents: 1 });
		const [a, b] = await Promise.all([ctx.agent(CALL), ctx.agent(CALL)]);
		const exhausted = [a, b].find((r) => r.error);
		expect(exhausted?.error).toMatch(/budget/i);
		expect(exhausted?.control).toBeNull();
	});

	it("sequential calls under the cap all proceed (no false exhaustion)", async () => {
		const ctx = mkCtx({}, { maxAgents: 3 });
		const a = await ctx.agent(CALL);
		const b = await ctx.agent(CALL);
		const c = await ctx.agent(CALL);
		expect([a, b, c].every((r) => !r.error)).toBe(true);
		expect(ctx.budget.count).toBe(3);
	});
});
