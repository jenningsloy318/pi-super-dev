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
import { isNonRetryableAgentError, isModelExclusionHit, nonRetryableAgentSummary, quotaResetHintFromError, assessQuotaReset } from "../src/agent-errors.ts";
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

it("nonRetryableAgentSummary names the persistence-aware remedy for exclusion hits (v0.3.82: restart alone no longer clears the 0.66+ store)", () => {
	const s = nonRetryableAgentSummary(EXCLUSION_429);
	expect(s).toContain("non-retryable agent environment failure");
	expect(s).toMatch(/model-exclusion/i);
	expect(s).toContain("model-exclusions.json"); // names the persisted store
	expect(s).toMatch(/no longer clears/i); // restart-alone caveat
	expect(s).toMatch(/quit pi/i); // the actual remedy sequence
});

it("v0.3.82: a passed provider quota-reset hint marks the persisted entry stale (zai Chinese shape, self-consistent anchors)", () => {
	// Self-consistent incident shape: 429 fired 4h ago (expires = recordedAt + 24h flat TTL),
	// provider said the 5h window resets 1h ago → delta 3h ≤ window → plausible → stale claim fires.
	const failedAt = Date.now() - 4 * 3_600_000;
	const hintAt = new Date(Date.now() - 3_600_000);
	const pad = (n: number) => String(n).padStart(2, "0");
	const fmt = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
	const err = `delegation ended with status failed: Requested subagent model 'zai-coding-cn/glm-5.3' is excluded and cannot be replaced by a fallback (reason: 429: {"code":"1308","message":"已达到 5 小时的使用上限。您的限额将在 ${fmt(hintAt)} 重置。"}; expires: ${new Date(failedAt + 24 * 3_600_000).toISOString()})`;
	expect(Math.abs((quotaResetHintFromError(err)?.getTime() ?? 0) - hintAt.getTime())).toBeLessThan(1_000); // hint format drops milliseconds
	expect(nonRetryableAgentSummary(err)).toMatch(/appears to have reset at .+ \(parsed in this machine's timezone/);
	expect(nonRetryableAgentSummary(err)).toMatch(/Asia\/Shanghai|local/);
});

it("v0.3.82 TZ guard: the REALISTIC misparse shape (provider UTC render, +08 machine → parse 8h early, parsed delta NEGATIVE) is never claimed stale", () => {
	// r2 review (adv-R2-3): realistic mismatch = true reset 6h after failure rendered as a UTC
	// wall clock; a +08 machine parses it 8h EARLY → parsed hint lands BEFORE the failure epoch
	// (negative delta) — the 5h-window validation must reject it.
	const failedAt = Date.now() - 2 * 3_600_000;
	const trueReset = new Date(failedAt + 6 * 3_600_000);
	const utcRender = new Date(trueReset.getTime() - 8 * 3_600_000); // the wall clock zai-UTC would print
	const parsedLocal = new Date(`${utcRender.toISOString().slice(0, 10)}T${utcRender.toISOString().slice(11, 19)}`); // machine re-reads it as +08
	const pad = (n: number) => String(n).padStart(2, "0");
	const fmt = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
	const err = `... is excluded and cannot be replaced by a fallback (reason: 429: {"code":"1308","message":"已达到 5 小时的使用上限。您的限额将在 ${fmt(parsedLocal)} 重置。"}; expires: ${new Date(failedAt + 24 * 3_600_000).toISOString()})`;
	const a = assessQuotaReset(err);
	expect(a.hint).toBeDefined();
	expect(a.recordedAtEst).toBeDefined();
	expect(a.windowHours).toBe(5);
	expect(a.timezonePlausible).toBe(false); // parsed hint precedes the failure — impossible
	expect(a.validated).toBe(false);
	expect(a.stale).toBe(false);
	expect(nonRetryableAgentSummary(err)).toMatch(/timezone inference could not be validated/);
	// sanity: the same incident rendered in LOCAL time (aligned provider) validates the other way
	const aligned = `... is excluded and cannot be replaced by a fallback (reason: 429: {"code":"1308","message":"已达到 5 小时的使用上限。您的限额将在 ${fmt(new Date(failedAt + 4 * 3_600_000))} 重置。"}; expires: ${new Date(failedAt + 24 * 3_600_000).toISOString()})`;
	const a2 = assessQuotaReset(aligned, failedAt + 5 * 3_600_000); // now past the reset
	expect(a2.validated).toBe(true);
	expect(a2.stale).toBe(true);
});

it("v0.3.82 r2 hardening: NO expires anchor or NO stated window ⇒ unvalidated ⇒ never stale (adv-R2-2 shapes F/C′)", () => {
	const failedAt = Date.now() - 4 * 3_600_000;
	const hintAt = new Date(Date.now() - 3_600_000); // past
	const pad = (n: number) => String(n).padStart(2, "0");
	const fmt = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
	// F: no expires anchor
	const noAnchor = `... is excluded and cannot be replaced by a fallback (reason: 429 resets at ${fmt(hintAt)})`;
	const aF = assessQuotaReset(noAnchor);
	expect(aF.hint).toBeDefined();
	expect(aF.recordedAtEst).toBeUndefined();
	expect(aF.validated).toBe(false);
	expect(aF.stale).toBe(false); // unvalidated ⇒ suppressed
	// C′: anchor present but NO stated window (unstated-window quota + skew is the false-early shape)
	const noWindow = `... is excluded and cannot be replaced by a fallback (reason: 429 resets at ${fmt(hintAt)}; expires: ${new Date(failedAt + 24 * 3_600_000).toISOString()})`;
	const aC = assessQuotaReset(noWindow);
	expect(aC.windowHours).toBeUndefined();
	expect(aC.validated).toBe(false);
	expect(aC.stale).toBe(false);
});

it("v0.3.82: a FUTURE reset hint is not called stale; an unparsable hint stays unknown", () => {
	const future = new Date(Date.now() + 3_600_000);
	const pad = (n: number) => String(n).padStart(2, "0");
	const hint = `${future.getFullYear()}-${pad(future.getMonth() + 1)}-${pad(future.getDate())} ${pad(future.getHours())}:${pad(future.getMinutes())}:${pad(future.getSeconds())}`;
	const err = `... is excluded and cannot be replaced by a fallback (reason: 429: 5 hours quota; resets at ${hint}; expires: ${new Date(Date.now() + 20 * 3_600_000).toISOString()})`;
	const a = assessQuotaReset(err);
	expect(a.hint?.getTime()).toBeGreaterThan(Date.now());
	expect(a.stale).toBe(false);
	// non-vacuous (r2 adv-R2-3): pin the ACTUAL stale phrase absence AND that the
	// generic remedy copy still appears — a regression firing the stale note on a
	// future hint would flip both.
	const summary = nonRetryableAgentSummary(err);
	// plausible + future ⇒ NO note at all (neither the stale claim nor the caveat)
	expect(summary).not.toMatch(/appears to have reset at/);
	expect(summary).not.toMatch(/could not be validated/);
	expect(quotaResetHintFromError("429 plain rate limit, no timestamp")).toBeUndefined();
	expect(quotaResetHintFromError(undefined)).toBeUndefined();
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
		expect(s).toMatch(/no longer clears/i); // v0.3.82: restart alone is insufficient (persisted store)
	expect(s).toMatch(/quit pi/i);
		expect(s).toMatch(/model-exclusion/i);
		expect(s).toMatch(/auth\/billing/i);
	});
});
