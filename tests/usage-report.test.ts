/**
 * v0.3.75 W1 — USAGE ATTRIBUTION DASHBOARD.
 *
 * User ask (2026-09-07): after each run, see total tokens/cost plus a
 * per-stage and per-agent split, "so we know where the money goes and
 * optimize with direction". Evidence motivating it: task-classifier completed
 * a 127-output-token classification on 50,914 input tokens (run
 * 2026-09-07T00-49-33-204Z) — the ~37K ambient skill listing is invisible
 * without attribution.
 *
 * Contract:
 *  - `stageKey(id)` normalizes call ids to stable stage keys (round/attempt
 *    suffixes collapse) — `pipeline.implementation.phase-01.impl.a2` →
 *    `pipeline.implementation.phase-01.impl`.
 *  - every terminal agent call lands ONE JSON row in <specDir>/usage-calls.jsonl
 *    (per-call fs, crash-durable, never throws — same convention as the events
 *    ledger). Failed calls are recorded too (status/error) even without usage.
 *  - UsageAccumulator gains `byStage` (same bucket shape as byAgent).
 *  - close-out renders <specDir>/usage-report.md: totals, per-stage table
 *    (cost-sorted), per-agent table, top-N most expensive calls, cache-hit
 *    share, and the cheapest-observed-prompt "fixed floor" line; plus a
 *    compact summary into the run log.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";

vi.mock("../src/render/knowledge.ts", () => ({ knowledgeForAgent: vi.fn(() => "") }));
vi.mock("../src/agents/fleet-visibility.ts", () => ({
	resolveExternalRunsModule: vi.fn(async () => null),
}));
vi.mock("../src/agents/register-agents.ts", () => ({ delegationOwnerPresent: vi.fn(() => null) }));

import { makeContext } from "../src/workflow.ts";
import { stageKey, appendUsageCallRows, renderUsageReport, writeUsageArtifacts } from "../src/evolution/usage-report.ts";
import type { UsageCallRow } from "../src/types.ts";
import type { AgentCall, PipelineState, RunOptions, UsageAccumulator } from "../src/types.ts";

const mkCtx = (state: PipelineState, options: RunOptions = {}) => makeContext(state, "t", options, () => {});
const CALL: AgentCall = { id: "pipeline.verify.code-review", agent: "code-reviewer", prompt: "ORIG\n\nOutput <control> JSON with: verdict." };

/** Owner bus reporting a fixed usage block on every terminal response. */
function usageOwnerBus(usage?: Record<string, number>) {
	const bus = new EventEmitter() as any;
	bus.on("prompt-template:subagent:request", (req: any) => {
		queueMicrotask(() => {
			bus.emit("prompt-template:subagent:response", {
				requestId: req.requestId, ownerRunId: req.ownerRunId, nodeId: req.nodeId,
				status: "completed",
				result: { kind: "text", text: 'done <control>{"verdict":"Approved"}</control>' },
				model: "fake/model-1",
				usage,
			});
		});
	});
	return bus;
}

/** Owner bus failing every call with an honest error (no usage). */
function failingOwnerBus(error = "delegation ended with status failed: boom") {
	const bus = new EventEmitter() as any;
	bus.on("prompt-template:subagent:request", (req: any) => {
		queueMicrotask(() => {
			bus.emit("prompt-template:subagent:response", {
				requestId: req.requestId, ownerRunId: req.ownerRunId, nodeId: req.nodeId,
				status: "failed",
				error,
				model: "fake/model-1",
			});
		});
	});
	return bus;
}

describe("v0.3.75 W1 — stageKey normalization", () => {
	it("collapses round/attempt/try suffixes, keeps semantic segments", () => {
		expect(stageKey("pipeline.implementation.phase-01.impl.a2")).toBe("pipeline.implementation.phase-01.impl");
		expect(stageKey("pipeline.implementation.phase-01.red-review.a1.t3")).toBe("pipeline.implementation.phase-01.red-review");
		expect(stageKey("pipeline.implementation.phase-01.runner-discovery.a2.t1")).toBe("pipeline.implementation.phase-01.runner-discovery");
		expect(stageKey("pipeline.prototype.r03")).toBe("pipeline.prototype");
		expect(stageKey("pipeline.judge.a1")).toBe("pipeline.judge");
	});
	it("leaves semantic ids untouched", () => {
		expect(stageKey("pipeline.classify")).toBe("pipeline.classify");
		expect(stageKey("pipeline.verify.code-review")).toBe("pipeline.verify.code-review");
		expect(stageKey("red-replan-phase-05")).toBe("red-replan-phase-05");
		expect(stageKey("setup")).toBe("setup");
	});
});

describe("v0.3.75 W1 — per-call ledger", () => {
	let dir: string;
	beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "sd-usage-calls-")); });
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	it("appendUsageCallRows writes one JSON line per row (durable, best-effort)", () => {
		const rows: UsageCallRow[] = [
			{ ts: 1, runId: "r1", id: "pipeline.classify", agent: "task-classifier", model: "m", status: "completed", input: 100, output: 10, cost: 0.001, durationMs: 500 },
			{ ts: 2, runId: "r1", id: "pipeline.judge", agent: "judge", status: "failed", error: "boom" },
		];
		appendUsageCallRows(dir, rows);
		const lines = readFileSync(join(dir, "usage-calls.jsonl"), "utf8").trim().split("\n");
		expect(lines).toHaveLength(2);
		expect(JSON.parse(lines[0]).id).toBe("pipeline.classify");
		expect(JSON.parse(lines[1]).status).toBe("failed");
	});
	it("never throws without a spec dir", () => {
		expect(() => appendUsageCallRows(undefined, [{ ts: 1, runId: "r", id: "x", agent: "a", status: "completed" }])).not.toThrow();
	});

	it("makeContext records one usageCalls row per terminal call — completed AND failed", async () => {
		const ctx = mkCtx({ setup: { specIdentifier: "uc1" } as any }, { events: usageOwnerBus({ input: 100, cost: 0.01 }) } as RunOptions);
		await ctx.agent(CALL);
		const ctx2 = mkCtx({ setup: { specIdentifier: "uc2" } as any }, { events: failingOwnerBus() } as RunOptions);
		await ctx2.agent(CALL);
		expect(ctx.usageCalls).toHaveLength(1);
		expect(ctx.usageCalls![0]).toMatchObject({ id: "pipeline.verify.code-review", agent: "code-reviewer", status: "completed", input: 100, cost: 0.01 });
		expect(typeof ctx.usageCalls![0].ts).toBe("number");
		expect(typeof ctx.usageCalls![0].runId).toBe("string");
		expect(ctx2.usageCalls).toHaveLength(1);
		expect(ctx2.usageCalls![0]).toMatchObject({ status: "failed", error: expect.stringContaining("boom") });
		expect(ctx2.usageCalls![0].input).toBeUndefined(); // no fabrication on failed calls without usage
	});
});

describe("v0.3.75 W1 — byStage accumulation", () => {
	it("makeContext splits usage by stageKey (attempts collapse into one stage)", async () => {
		const bus = usageOwnerBus({ input: 100, output: 10, cost: 0.01, durationMs: 1000 });
		const ctx = mkCtx({ setup: { specIdentifier: "us1" } as any }, { events: bus } as RunOptions);
		await ctx.agent({ ...CALL, id: "pipeline.implementation.phase-01.impl.a1", agent: "implementer" });
		await ctx.agent({ ...CALL, id: "pipeline.implementation.phase-01.impl.a2", agent: "implementer" });
		await ctx.agent({ ...CALL, id: "pipeline.implementation.phase-02.impl.a1", agent: "implementer" });
		expect(ctx.usage!.byStage?.["pipeline.implementation.phase-01.impl"]?.calls).toBe(2);
		expect(ctx.usage!.byStage?.["pipeline.implementation.phase-01.impl"]?.input).toBe(200);
		expect(ctx.usage!.byStage?.["pipeline.implementation.phase-02.impl"]?.calls).toBe(1);
		expect(ctx.usage!.totals.calls).toBe(3);
	});
});

describe("v0.3.75 W1 — usage-report renderer", () => {
	const acc = (byStage: Record<string, any>, byAgent: Record<string, any>): UsageAccumulator => ({
		totals: { calls: 3, turns: 10, toolCalls: 20, input: 3000, output: 400, cacheRead: 6000, cacheWrite: 0, cost: 0.3, durationMs: 100000 },
		byAgent, byStage,
	});
	const rows: UsageCallRow[] = [
		{ ts: 3, runId: "r", id: "pipeline.implementation.phase-01.impl", agent: "implementer", status: "completed", input: 2000, output: 300, cacheRead: 5000, cost: 0.2, durationMs: 80000 },
		{ ts: 2, runId: "r", id: "pipeline.verify.code-review", agent: "code-reviewer", status: "completed", input: 700, output: 70, cacheRead: 1000, cost: 0.08, durationMs: 15000 },
		{ ts: 1, runId: "r", id: "pipeline.classify", agent: "task-classifier", status: "completed", input: 300, output: 30, cacheRead: 0, cost: 0.02, durationMs: 12000 },
	];

	it("renders totals, per-stage and per-agent tables sorted by cost, top calls, cache share, fixed floor", () => {
		const md = renderUsageReport({ runId: "r", status: "partial", wallMs: 600000, usage: acc({
			"pipeline.implementation.phase-01.impl": { calls: 1, turns: 4, toolCalls: 8, input: 2000, output: 300, cacheRead: 5000, cacheWrite: 0, cost: 0.2, durationMs: 80000 },
			"pipeline.verify.code-review": { calls: 1, turns: 3, toolCalls: 6, input: 700, output: 70, cacheRead: 1000, cacheWrite: 0, cost: 0.08, durationMs: 15000 },
			"pipeline.classify": { calls: 1, turns: 2, toolCalls: 2, input: 300, output: 30, cacheRead: 0, cacheWrite: 0, cost: 0.02, durationMs: 12000 },
		}, {
			"sd-implementer": { calls: 1, turns: 4, toolCalls: 8, input: 2000, output: 300, cacheRead: 5000, cacheWrite: 0, cost: 0.2, durationMs: 80000 },
			"sd-code-reviewer": { calls: 1, turns: 3, toolCalls: 6, input: 700, output: 70, cacheRead: 1000, cacheWrite: 0, cost: 0.08, durationMs: 15000 },
			"sd-task-classifier": { calls: 1, turns: 2, toolCalls: 2, input: 300, output: 30, cacheRead: 0, cacheWrite: 0, cost: 0.02, durationMs: 12000 },
		}), calls: rows })!;
		expect(md).toContain("Usage report");
		expect(md).toContain("total:");
		expect(md).toContain("0.3000");
		// per-stage table: cost-sorted, implementer row above classifier row
		expect(md.indexOf("pipeline.implementation.phase-01.impl")).toBeGreaterThan(-1);
		expect(md.indexOf("pipeline.implementation.phase-01.impl")).toBeLessThan(md.indexOf("pipeline.classify"));
		// per-agent table strips the sd- prefix for display
		expect(md).toContain("implementer");
		// top-calls section names the most expensive call
		expect(md).toContain("Top calls");
		// cache-hit share over prompt tokens
		expect(md).toContain("cache");
		// fixed-floor line: cheapest observed prompt ≈ fixed overhead floor
		expect(md).toContain("fixed");
		expect(md).toContain("300 tokens"); // cheapest call input floor (300 + 0 cacheRead)
	});
	it("returns null when no calls were recorded (P10 no fabrication)", () => {
		const md = renderUsageReport({ runId: "r", status: "success", wallMs: 1, usage: { totals: { calls: 0, turns: 0, toolCalls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, durationMs: 0 }, byAgent: {}, byStage: {} }, calls: [] });
		expect(md).toBeNull();
	});
	it("writeUsageArtifacts writes usage-report.md + appends rows + logs a compact summary (never throws)", () => {
		const dir = mkdtempSync(join(tmpdir(), "sd-usage-report-"));
		const logs: string[] = [];
		try {
			writeUsageArtifacts(dir, { runId: "r", status: "partial", wallMs: 600000, usage: acc({
				"pipeline.classify": { calls: 1, turns: 2, toolCalls: 2, input: 300, output: 30, cacheRead: 0, cacheWrite: 0, cost: 0.02, durationMs: 12000 },
			}, { "sd-task-classifier": { calls: 1, turns: 2, toolCalls: 2, input: 300, output: 30, cacheRead: 0, cacheWrite: 0, cost: 0.02, durationMs: 12000 } }), calls: rows.slice(2) }, (m) => logs.push(m));
			expect(existsSync(join(dir, "usage-report.md"))).toBe(true);
			// the LEDGER is written per-call by realAgent only — close-out must NOT
			// duplicate it (no usage-calls.jsonl re-append).
			expect(existsSync(join(dir, "usage-calls.jsonl"))).toBe(false);
			expect(logs.some((l) => l.includes("usage") && l.includes("$"))).toBe(true);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
		expect(() => writeUsageArtifacts(undefined, { runId: "r", status: "x", wallMs: 1, usage: { totals: { calls: 0, turns: 0, toolCalls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, durationMs: 0 }, byAgent: {}, byStage: {} }, calls: [] }, () => {})).not.toThrow();
	});
});

describe("v0.3.75 W1 — workflow close-out wiring (source contract)", () => {
	it("runWorkflow renders usage artifacts at close-out", async () => {
		const src = await import("node:fs").then((fs) => fs.readFileSync("src/workflow.ts", "utf8"));
		expect(src).toMatch(/writeUsageArtifacts\(/);
		expect(src).toMatch(/usageCalls/);
	});
});

/** v0.3.75 review M2: an owner listener that throws synchronously — the
 * events.emit() in delegation-backend propagates it, exec REJECTS (rather
 * than resolving with {error}), and realAgent takes the catch path. */
function throwingOwnerBus() {
	const bus = new EventEmitter() as any;
	bus.on("prompt-template:subagent:request", () => {
		throw new Error("owner listener kaboom");
	});
	return bus;
}

/** v0.3.75 review M3: first attempt fails transiently (429), second succeeds
 * with usage — one logical call, TWO dispatches. */
function transientThenOkBus() {
	const bus = new EventEmitter() as any;
	let attempt = 0;
	bus.on("prompt-template:subagent:request", (req: any) => {
		attempt++;
		queueMicrotask(() => {
			if (attempt === 1) {
				bus.emit("prompt-template:subagent:response", {
					requestId: req.requestId, ownerRunId: req.ownerRunId, nodeId: req.nodeId,
					status: "failed", error: "HTTP 429 rate limit exceeded", model: "fake/model-1",
				});
			} else {
				bus.emit("prompt-template:subagent:response", {
					requestId: req.requestId, ownerRunId: req.ownerRunId, nodeId: req.nodeId,
					status: "completed",
					result: { kind: "text", text: 'done <control>{"verdict":"Approved"}</control>' },
					model: "fake/model-1",
					usage: { input: 100, output: 10, cost: 0.01 },
				});
			}
		});
	});
	return bus;
}

describe("v0.3.75 review fixes — ledger contract (M2) + dispatch attribution (M3)", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "sd-usage-review-"));
		process.env.SUPER_DEV_TRANSIENT_RETRY_MS = "0";
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
		delete process.env.SUPER_DEV_TRANSIENT_RETRY_MS;
	});

	it("M2: a THROWN delegation lands exactly ONE failed ledger row (jsonl + ctx), rethrown to the caller", async () => {
		const ctx = mkCtx({ setup: { specDirectory: dir, specIdentifier: "thr1" } as any }, { events: throwingOwnerBus() } as RunOptions);
		await expect(ctx.agent(CALL)).rejects.toThrow(/owner listener kaboom/);
		expect(ctx.usageCalls).toHaveLength(1);
		expect(ctx.usageCalls![0]).toMatchObject({ id: CALL.id, agent: CALL.agent, status: "failed" });
		expect(ctx.usageCalls![0].error).toContain("owner listener kaboom");
		expect(ctx.usageCalls![0].input).toBeUndefined(); // P10: usage unknown stays absent
		expect(typeof ctx.usageCalls![0].durationMs).toBe("number"); // engine-measured fact
		const lines = readFileSync(join(dir, "usage-calls.jsonl"), "utf8").trim().split("\n");
		expect(lines).toHaveLength(1);
		expect(JSON.parse(lines[0]).status).toBe("failed");
	});

	it("M3: a transient-retried call lands ONE row carrying dispatches=2 (fixed floor burns twice)", async () => {
		const ctx = mkCtx({ setup: { specDirectory: dir, specIdentifier: "tr1" } as any }, { events: transientThenOkBus() } as RunOptions);
		const res = await ctx.agent(CALL);
		expect(res.error).toBeUndefined();
		expect(ctx.usageCalls).toHaveLength(1);
		expect(ctx.usageCalls![0]).toMatchObject({ status: "completed", dispatches: 2, input: 100, cost: 0.01 });
	});
});

describe("v0.3.75 review fixes — report honesty (M4)", () => {
	const emptyTotals = (calls: number) => ({ calls, turns: 0, toolCalls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, durationMs: 0 });

	it("headline counts TERMINAL ROWS, not usage-bearing calls — an all-failed run never reads '0 agent call(s)'", () => {
		const md = renderUsageReport({
			runId: "r", status: "failed", wallMs: 1000,
			usage: { totals: emptyTotals(1), byAgent: {}, byStage: {} },
			calls: [
				{ ts: 1, runId: "r", id: "pipeline.verify.spec-review", agent: "spec-reviewer", status: "failed", error: "timed out after 1800000ms" },
				{ ts: 2, runId: "r", id: "pipeline.classify", agent: "task-classifier", status: "completed", input: 300, cost: 0.02 },
			],
		})!;
		expect(md).toContain("2 agent call(s)");
		expect(md).toContain("1 failed");
		expect(md).toContain("1 without usage data");
		expect(md).not.toContain("0 agent call(s)");
	});

	it("fixed floor needs a REAL prompt measurement — completed-without-usage rows fabricate no '0 tokens' floor", () => {
		const noMeasure: UsageCallRow[] = [
			{ ts: 1, runId: "r", id: "a", agent: "x", status: "completed" },
			{ ts: 2, runId: "r", id: "b", agent: "x", status: "completed", dispatches: 3 },
		];
		const md0 = renderUsageReport({ runId: "r", status: "success", wallMs: 1, usage: { totals: emptyTotals(2), byAgent: {}, byStage: {} }, calls: noMeasure })!;
		expect(md0).not.toContain("Fixed floor");
		const md1 = renderUsageReport({
			runId: "r", status: "success", wallMs: 1,
			usage: { totals: emptyTotals(1), byAgent: {}, byStage: {} },
			calls: [
				{ ts: 1, runId: "r", id: "a", agent: "x", status: "completed" },
				{ ts: 2, runId: "r", id: "b", agent: "x", status: "completed", input: 500, dispatches: 3 },
			],
		})!;
		expect(md1).toContain("500 tokens");
		expect(md1).toContain("Multiply by 4 dispatch(es)");
	});
});
