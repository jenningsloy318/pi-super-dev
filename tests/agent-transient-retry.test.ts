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
vi.mock("../src/agents/delegation-backend.ts", async (importOriginal) => ({
	...await importOriginal<typeof import("../src/agents/delegation-backend.ts")>(),
	runAgentViaDelegation: vi.fn(async () => responses.shift() ?? { text: "ok", control: {} }),
}));
vi.mock("../src/agents/register-agents.ts", async (importOriginal) => ({
	...await importOriginal<typeof import("../src/agents/register-agents.ts")>(),
	delegationOwnerPresent: vi.fn(() => true),
}));
vi.mock("../src/render/knowledge.ts", () => ({ knowledgeForAgent: vi.fn(() => "") }));

import { makeContext } from "../src/workflow.ts";
import { runAgentViaDelegation } from "../src/agents/delegation-backend.ts";
import { isNonRetryableAgentError, isModelExclusionHit, nonRetryableAgentSummary } from "../src/agent-errors.ts";
import type { AgentCall, PipelineState, RunOptions } from "../src/types.ts";

const CALL: AgentCall = { id: "pipeline.x", agent: "spec-writer", prompt: "p" };
const captured: string[] = [];
const mkCtx = (o: RunOptions = {}) =>
	makeContext({} as PipelineState, "t", { events: {} as never, ...o, progress: { phase() {}, log: () => {}, text() {} } }, (m) => captured.push(m));
const calls = () => vi.mocked(runAgentViaDelegation).mock.calls.length;

describe("transient-error retry in realAgent (429 / overload)", () => {
	beforeEach(() => { responses = []; captured.length = 0; vi.mocked(runAgentViaDelegation).mockClear(); });
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

describe("v0.3.72 N1 — model-not-found is non-retryable (review ADV-N1)", () => {
	it("model-resolution failures fail fast instead of burning 3 rounds per loop (2026-09-04/05 incident shapes)", () => {
		expect(isNonRetryableAgentError("Unknown subagent model zai-coding-cn/glm-does-not-exist")).toBe(true);
		expect(isNonRetryableAgentError("Model zai-coding-cn/glm-5.2:high not found")).toBe(true);
		expect(isNonRetryableAgentError("Requested subagent model zai-coding-cn/glm-5.2 is excluded and cannot be replaced by a fallback (reason: Model zai-coding-cn/glm-5.2:high not found; expires: 2026-09-05T11:44:04.574Z)")).toBe(true);
	});
	it("ordinary agent errors stay retryable", () => {
		expect(isNonRetryableAgentError("tdd guide returned garbage output")).toBe(false);
		expect(isNonRetryableAgentError("reviewer produced no control object")).toBe(false);
		expect(isNonRetryableAgentError(undefined)).toBe(false);
	});
});
describe("v0.3.77 — model-exclusion envelope is non-retryable (incident 2026-09-07T14-10-39-259Z)", () => {
beforeEach(() => { responses = []; captured.length = 0; vi.mocked(runAgentViaDelegation).mockClear(); });
afterAll(() => { delete process.env.SUPER_DEV_TRANSIENT_RETRY_MS; });

const EXCLUSION_429 = 'delegation ended with status failed: Requested subagent model \'zai-coding-cn/glm-5.3\' is excluded and cannot be replaced by a fallback (reason: 429: {"code":"1308","message":"已达到 5 小时的使用上限。您的限额将在 2026-09-07 19:05:39 重置。"}; expires: 2026-09-08T07:11:49.165Z)';

it("classifies the exclusion ENVELOPE as non-retryable regardless of the cached reason (429-quota shape escapes model-not-found)", () => {
	expect(isNonRetryableAgentError(EXCLUSION_429)).toBe(true);
	expect(isModelExclusionHit(EXCLUSION_429)).toBe(true);
});

it("model-not-found exclusion shape stays non-retryable (regression pin)", () => {
	expect(isNonRetryableAgentError("Requested subagent model zai-coding-cn/glm-5.2 is excluded and cannot be replaced by a fallback (reason: Model zai-coding-cn/glm-5.2:high not found; expires: 2026-09-05T11:44:04.574Z)")).toBe(true);
});

it("does NOT transient-retry a cached exclusion even though the reason contains 429 — the throw is a process-local cache hit, retrying can never succeed", async () => {
	process.env.SUPER_DEV_TRANSIENT_RETRY_MS = "1,1,1,1";
	responses = [{ error: EXCLUSION_429 }];
	const r = await mkCtx().agent(CALL);
	expect(calls()).toBe(1); // pre-fix: transient backoff retried the cache hit (production incident log line 26 burned 4x30s; in-harness the drained mock queue ends it at 2)
	expect(r.error ?? "").toMatch(/is excluded and cannot be replaced/);
	expect(captured.some((m) => /transient error/.test(m))).toBe(false);
});

it("nonRetryableAgentSummary names the restart remedy for exclusion hits", () => {
	const s = nonRetryableAgentSummary(EXCLUSION_429);
	expect(s).toContain("non-retryable agent environment failure");
	expect(s).toMatch(/restart pi/i);
	expect(s).toMatch(/model-exclusion/i);
});

it("ordinary errors keep the bare summary (remedy text only on exclusion hits)", () => {
	expect(nonRetryableAgentSummary("spawn pi ENOENT")).toBe("non-retryable agent environment failure: spawn pi ENOENT");
	expect(isModelExclusionHit("429 rate limit (live API, retryable)")).toBe(false);
});
});

describe("v0.3.77 reviews code-F2 — sibling envelope: ALL candidates excluded (no usable subagent models remain)", () => {
	beforeEach(() => { responses = []; captured.length = 0; vi.mocked(runAgentViaDelegation).mockClear(); });
	afterAll(() => { delete process.env.SUPER_DEV_TRANSIENT_RETRY_MS; });

	const EXHAUSTED = 'delegation ended with status failed: No usable subagent models remain after registry, scope, and cached-exclusion filtering. (excluded: zai-coding-cn/glm-5.3 reason: 429: {"code":"1308","message":"quota"}; zai-coding-cn/glm-5.3-flash reason: 429 rate limit)';

	it("classifies the all-candidates-excluded envelope as non-retryable (same never-reloaded registry)", () => {
		expect(isNonRetryableAgentError(EXHAUSTED)).toBe(true);
	});

	it("does not transient-retry it — exactly 1 call, no backoff, despite the embedded 429 reasons", async () => {
		process.env.SUPER_DEV_TRANSIENT_RETRY_MS = "1,1,1,1";
		responses = [{ error: EXHAUSTED }];
		const r = await mkCtx().agent(CALL);
		expect(calls()).toBe(1);
		expect(r.error ?? "").toMatch(/No usable subagent models remain/);
		expect(captured.some((m) => /transient error/.test(m))).toBe(false);
	});

	it("summary names the restart remedy and the auth/billing caveat (reviews adv-F2)", () => {
		const s = nonRetryableAgentSummary(EXHAUSTED);
		expect(s).toMatch(/restart pi/i);
		expect(s).toMatch(/model-exclusion/i);
		expect(s).toMatch(/auth\/billing/i);
	});
});
