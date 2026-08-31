/**
 * Transient-error retry (root cause of "Research produced no output" /
 * "Impl budget exhausted"): when a model returns a transient error (429 /
 * rate-limit / overload / 5xx), the agent backend retries with backoff INSIDE
 * one agent call, instead of failing the stage (which burned a gate attempt
 * and, across the gate's retries, the budget).
 */
import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";

// A queue of backend responses, drained in order. Each test sets its own.
let responses: Array<{ error?: string; control?: Record<string, unknown> | null; text?: string }> = [];
vi.mock("../src/session-agent.ts", () => ({
	runAgentViaSession: vi.fn(async () => responses.shift() ?? { text: "ok", control: {} }),
	summarizeSlug: vi.fn(async () => "x"),
}));
vi.mock("../src/pi-spawn.ts", async (importOriginal) => ({
	...await importOriginal<typeof import("../src/pi-spawn.ts")>(),
	spawnAgent: vi.fn(async () => ({ text: "ok", control: {} })),
	isBrowserAgent: vi.fn(() => false),
	needsWebResearch: vi.fn(() => false),
}));
vi.mock("../src/render/knowledge.ts", () => ({ knowledgeForAgent: vi.fn(() => "") }));

import { makeContext } from "../src/workflow.ts";
import { runAgentViaSession } from "../src/session-agent.ts";
import type { AgentCall, PipelineState, RunOptions } from "../src/types.ts";

const CALL: AgentCall = { id: "pipeline.x", agent: "spec-writer", prompt: "p" };
const captured: string[] = [];
const mkCtx = (o: RunOptions = {}) =>
	makeContext({} as PipelineState, "t", { ...o, progress: { phase() {}, log: () => {}, text() {} } }, (m) => captured.push(m));
const calls = () => vi.mocked(runAgentViaSession).mock.calls.length;

describe("transient-error retry in realAgent (429 / overload)", () => {
	beforeEach(() => { responses = []; captured.length = 0; vi.mocked(runAgentViaSession).mockClear(); });
	afterAll(() => { delete process.env.SUPER_DEV_TRANSIENT_RETRY_MS; });

	it("retries a 429 transient error with backoff and succeeds", async () => {
		process.env.SUPER_DEV_TRANSIENT_RETRY_MS = "1,1,1";
		responses = [
			{ error: '429: {"message":"该模型当前访问量过大"}' },
			{ error: "HTTP 429 too many requests" },
			{ control: { done: true } },
		];
		const r = await mkCtx().agent(CALL);
		expect(calls()).toBe(3); // 2 failed + 1 success
		expect(r.control).toEqual({ done: true });
		expect(r.error).toBeUndefined();
		expect(captured.some((m) => /transient error.*429/.test(m))).toBe(true);
	});

	it("does NOT retry a non-transient error (surfaces immediately)", async () => {
		process.env.SUPER_DEV_TRANSIENT_RETRY_MS = "1,1,1";
		responses = [{ text: "", control: null, error: "structured_output missing keys" }];
		const r = await mkCtx().agent(CALL);
		expect(calls()).toBe(1); // no retries
		expect(r.error).toMatch(/missing keys/);
	});

	it("counts ONE budget unit regardless of retries (retries are internal)", async () => {
		process.env.SUPER_DEV_TRANSIENT_RETRY_MS = "1,1,1";
		responses = [{ error: "429 rate limit" }, { error: "429" }, { error: "429" }, { error: "429" }];
		const ctx = mkCtx({ maxAgents: 5 });
		await ctx.agent(CALL);
		expect(ctx.budget.count).toBe(1); // not 4
	});

	it("surfaces the transient error after exhausting retries", async () => {
		process.env.SUPER_DEV_TRANSIENT_RETRY_MS = "1,1"; // 2 retries
		responses = Array.from({ length: 5 }, () => ({ error: "429 overloaded" }));
		const r = await mkCtx().agent(CALL);
		expect(r.error).toMatch(/429/);
		expect(calls()).toBe(3); // 1 initial + 2 retries
	});
});
