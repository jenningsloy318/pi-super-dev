/**
 * v0.3.68 F10-1 — delegation USAGE ACCOUNTING.
 *
 * Anthropic's multi-agent production lessons: multi-agent systems spend ~15×
 * chat tokens, so per-run/per-agent usage must be a first-class governance
 * surface (also LangChain "Govern → Cost"; SDLC playbook "how to measure it").
 * The DelegationUsage fields were parsed and formatted into ONE log line, then
 * dropped: nothing aggregated, RunSummary had no usage block, and the only
 * budget fuse counted agent SPAWNS — unbounded tokens inside the spawn budget.
 *
 * Contract under test:
 *  - SpawnResult carries `usage`; runAgentViaDelegation threads the terminal
 *    response's usage into it (owner bus emits usage on the response).
 *  - makeContext accumulates per-agent and total usage across calls (ctx.usage).
 *  - summarizeUsage() renders the deterministic RunSummary block.
 *  - fail-closed fuses: SUPER_DEV_MAX_RUN_COST / SUPER_DEV_MAX_RUN_TOKENS
 *    (input+output) are checked BEFORE a call launches once the accumulated
 *    total has reached the cap — the call returns an honest error naming the
 *    fuse and the spent/limit numbers (mirroring the spawn budget fuse); no
 *    fuse configured → no limit, and a call whose usage lands OVER the cap is
 *    still counted honestly (the NEXT call fails).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";

vi.mock("../src/render/knowledge.ts", () => ({ knowledgeForAgent: vi.fn(() => "") }));
vi.mock("../src/agents/fleet-visibility.ts", () => ({
	resolveExternalRunsModule: vi.fn(async () => false),
	fleetBegin: vi.fn(), fleetUpdate: vi.fn(), fleetFinish: vi.fn(),
}));
vi.mock("../src/agents/register-agents.ts", () => ({ delegationOwnerPresent: vi.fn(() => null) }));

import { makeContext, summarizeUsage } from "../src/workflow.ts";
import type { AgentCall, PipelineState, RunOptions } from "../src/types.ts";

const mkCtx = (state: PipelineState, options: RunOptions = {}) => makeContext(state, "t", options, () => {});
const CALL: AgentCall = { id: "pipeline.judge.a1", agent: "judge", prompt: "ORIG\n\nOutput <control> JSON with: route." };

/** Owner bus that reports a fixed usage block on every terminal response. */
function usageOwnerBus(usage: Record<string, number>) {
	const bus = new EventEmitter() as any;
	bus.on("prompt-template:subagent:request", (req: any) => {
		queueMicrotask(() => {
			bus.emit("prompt-template:subagent:response", {
				requestId: req.requestId, ownerRunId: req.ownerRunId, nodeId: req.nodeId,
				status: "completed",
				result: { kind: "text", text: 'done <control>{"route":"escalate-now"}</control>' },
				model: "fake/model-1",
				usage,
			});
		});
	});
	return bus;
}

const saveEnv = (keys: string[]) => {
	const saved: Record<string, string | undefined> = {};
	for (const k of keys) { saved[k] = process.env[k]; }
	return () => { for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]!; } };
};

describe("v0.3.68 F10-1 — usage accounting", () => {
	let restore: () => void;
	beforeEach(() => { restore = saveEnv(["SUPER_DEV_MAX_RUN_COST", "SUPER_DEV_MAX_RUN_TOKENS"]); });
	afterEach(() => restore());

	it("SpawnResult carries the terminal usage block (threaded by runAgentViaDelegation)", async () => {
		const bus = usageOwnerBus({ turns: 3, toolCalls: 5, input: 1200, output: 300, cacheRead: 800, cacheWrite: 100, cost: 0.012, durationMs: 4321 });
		const result = await mkCtx({ setup: { specIdentifier: "u1" } as any }, { events: bus } as RunOptions).agent(CALL);
		expect(result.usage).toBeDefined();
		expect(result.usage!.turns).toBe(3);
		expect(result.usage!.input).toBe(1200);
		expect(result.usage!.cost).toBeCloseTo(0.012);
	});

	it("makeContext accumulates per-agent and total usage across calls (ctx.usage)", async () => {
		const bus = usageOwnerBus({ turns: 2, input: 100, output: 50, cost: 0.01, durationMs: 1000 });
		const ctx = mkCtx({ setup: { specIdentifier: "u2" } as any }, { events: bus } as RunOptions);
		await ctx.agent(CALL);
		await ctx.agent({ ...CALL, id: "pipeline.judge.a2", agent: "judge" });
		await ctx.agent({ ...CALL, id: "pipeline.tdd.a1", agent: "tdd-guide" });
		expect(ctx.usage!.totals.calls).toBe(3);
		expect(ctx.usage!.totals.input).toBe(300);
		expect(ctx.usage!.totals.cost).toBeCloseTo(0.03);
		expect(ctx.usage!.byAgent["sd-judge"]?.calls).toBe(2);
		expect(ctx.usage!.byAgent["sd-tdd-guide"]?.calls).toBe(1);
	});

	it("summarizeUsage renders the deterministic summary block (P10 — honest unknowns stay absent)", () => {
		const line = summarizeUsage({ totals: { calls: 2, input: 200, output: 80, cost: 0.02 }, byAgent: {} });
		expect(line).toContain("calls=2");
		expect(line).toContain("input=200");
		expect(line).toContain("cost=0.02");
		// no fabricated fields when the accumulator never saw usage
		const empty = summarizeUsage({ totals: { calls: 0, input: 0, output: 0, cost: 0 }, byAgent: {} });
		expect(empty).toBeNull();
	});

	it("SUPER_DEV_MAX_RUN_COST is a fail-closed pre-call fuse — the call after the breach errors honestly, naming spent/limit", async () => {
		process.env.SUPER_DEV_MAX_RUN_COST = "0.02";
		const bus = usageOwnerBus({ input: 100, output: 10, cost: 0.01 });
		const ctx = mkCtx({ setup: { specIdentifier: "u3" } as any }, { events: bus } as RunOptions);
		const r1 = await ctx.agent(CALL); // cost 0.01 — under
		const r2 = await ctx.agent({ ...CALL, id: "pipeline.judge.a2" }); // cost 0.02 — AT the cap
		expect(r1.error).toBeUndefined();
		expect(r2.error).toBeUndefined();
		const r3 = await ctx.agent({ ...CALL, id: "pipeline.judge.a3" }); // pre-call check trips
		expect(r3.error).toContain("SUPER_DEV_MAX_RUN_COST");
		expect(r3.error).toContain("0.02");
		expect(r3.control).toBeNull();
	});

	it("SUPER_DEV_MAX_RUN_TOKENS counts input+output and fails closed the same way", async () => {
		process.env.SUPER_DEV_MAX_RUN_TOKENS = "250";
		const bus = usageOwnerBus({ input: 100, output: 40, cost: 0 });
		const ctx = mkCtx({ setup: { specIdentifier: "u4" } as any }, { events: bus } as RunOptions);
		await ctx.agent(CALL);            // 140
		await ctx.agent({ ...CALL, id: "pipeline.judge.a2" }); // 280 — at cap
		const r3 = await ctx.agent({ ...CALL, id: "pipeline.judge.a3" });
		expect(r3.error).toContain("SUPER_DEV_MAX_RUN_TOKENS");
		expect(r3.error).toContain("280");
	});

	it("no fuse configured → calls are unlimited by token/cost", async () => {
		const bus = usageOwnerBus({ input: 10_000_000, output: 10_000_000, cost: 5 });
		const ctx = mkCtx({ setup: { specIdentifier: "u5" } as any }, { events: bus } as RunOptions);
		const r = await ctx.agent(CALL);
		expect(r.error).toBeUndefined();
	});

	it("usage-free responses never fabricate usage (P10)", async () => {
		const bus = new EventEmitter() as any;
		bus.on("prompt-template:subagent:request", (req: any) => {
			queueMicrotask(() => bus.emit("prompt-template:subagent:response", {
				requestId: req.requestId, ownerRunId: req.ownerRunId, nodeId: req.nodeId,
				status: "completed", result: { kind: "text", text: 'x <control>{"route":"continue"}</control>' }, model: "m",
			}));
		});
		const ctx = mkCtx({ setup: { specIdentifier: "u6" } as any }, { events: bus } as RunOptions);
		const r = await ctx.agent(CALL);
		expect(r.usage).toBeUndefined();
		expect(ctx.usage!.totals.calls).toBe(0); // nothing counted, nothing invented
	});
});

describe("v0.3.68 F10-1 — RunSummary carries the usage block (wiring)", () => {
	it("the RunSummary construction in runWorkflow composes ctx.usage", async () => {
		const src = await import("node:fs").then((fs) => fs.readFileSync("src/workflow.ts", "utf8"));
		expect(src).toMatch(/usage:\s*ctx\.usage/);
		const types = await import("node:fs").then((fs) => fs.readFileSync("src/types.ts", "utf8"));
		expect(types).toMatch(/usage\?:\s*RunUsage/);
	});
});
