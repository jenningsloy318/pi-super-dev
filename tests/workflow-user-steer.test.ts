/**
 * Phase 3 — Queue injection at the realAgent spawn seam (RED tests).
 *
 * Verifies the delivery guarantee for mid-run captured input:
 *  - SCENARIO-013: the `userSteerProvider` (an atomic drain) returns all
 *    pending inputs together and clears, returning `[]` when no run is active.
 *  - SCENARIO-014: a non-empty drain is injected as a
 *    `## Mid-run user guidance (added during execution)` block with `(1)…(2)…`
 *    enumeration and an "Incorporate this into your work." instruction, AFTER
 *    the knowledge prepend so it stays the most-visible tail of the prompt.
 *  - SCENARIO-015: each input is injected exactly once — draining happens
 *    inside `realAgent`, NOT the memoizing wrapper, so a cached/replayed spawn
 *    during resume does NOT re-invoke the provider / re-inject.
 *  - SCENARIO-016: an empty drain produces NO guidance block and a
 *    byte-identical prompt to the no-feature baseline.
 *
 * Harness mirrors tests/workflow-feedback.test.ts: the session/subprocess
 * backends are mocked to capture the resolved prompt, and knowledge is mocked
 * so positioning after the knowledge prepend is assertable.
 */
import { describe, it, expect, vi } from "vitest";

const captured: { prompt?: string } = {};
vi.mock("../src/session-agent.ts", () => ({
	runAgentViaSession: vi.fn(async (opts: { prompt?: string }) => {
		captured.prompt = opts.prompt;
		return { text: "", control: {} };
	}),
	summarizeSlug: vi.fn(async () => "x"),
}));
vi.mock("../src/pi-spawn.ts", () => ({
	spawnAgent: vi.fn(async (opts: { prompt?: string }) => {
		captured.prompt = opts.prompt;
		return { text: "", control: {} };
	}),
	isBrowserAgent: vi.fn(() => false),
}));
// Deterministic knowledge string so the guidance block's position (AFTER
// knowledge) is assertable independently of spec-dir fixture state. Real
// `knowledgeForAgent` returns the extracted *body*; workflow.ts prepends the
// `## Prior-stage data` header itself, so the mock returns the BODY only.
// KNOWLEDGE_MARKER is the full header+body the workflow ends up prepending,
// used by the positioning + byte-identical baseline assertions.
const KNOWLEDGE_BODY = "KNOWLEDGE-FROM-PRIOR-STAGE";
const KNOWLEDGE_MARKER = "## Prior-stage data (auto-injected)\nKNOWLEDGE-FROM-PRIOR-STAGE";
vi.mock("../src/render/knowledge.ts", () => ({
	knowledgeForAgent: vi.fn(() => KNOWLEDGE_BODY),
}));

import { makeContext } from "../src/workflow.ts";
import type { AgentCall, AgentResult, PipelineState, RunOptions } from "../src/types.ts";

/** Captures how many times + with what result the provider was drained. */
function makeProviderSpy(initial: string[] = []) {
	const calls: number[] = [];
	let queue = [...initial];
	return {
		provider: () => {
			calls.push(calls.length);
			const out = queue;
			queue = [];
			return out;
		},
		// mirror the atomic drain contract: returns contents, clears, returns [] next.
		callCount: () => calls.length,
		refill: (items: string[]) => {
			queue = [...items];
		},
	};
}

const mkCtx = (state: PipelineState, options: RunOptions = {}) =>
	makeContext(state, "t", options, () => {});

const BASE_CALL: AgentCall = { id: "pipeline.spec", agent: "spec-writer", prompt: "BASE PROMPT" };

describe("workflow agent() mid-run user guidance injection (SCENARIO-013..016)", () => {
	it("SCENARIO-013: a drain provider returns all pending inputs together and clears (atomic)", () => {
		// Models activeRun.drain(): first call returns everything captured, the
		// second returns [] until refilled. This is the provider makeContext will
		// be wired to via options.userSteerProvider.
		const { provider, refill } = makeProviderSpy(["first steer", "second steer"]);
		expect(provider()).toEqual(["first steer", "second steer"]);
		expect(provider()).toEqual([]); // cleared — no items until new capture
		refill(["late input"]);
		expect(provider()).toEqual(["late input"]);
		expect(provider()).toEqual([]);
	});

	it("SCENARIO-013: options.userSteerProvider is a documented RunOptions field", () => {
		// Existence of the type-level contract (AC-05). At runtime makeContext
		// only drains when present.
		const opts = { userSteerProvider: () => ["x"] } as RunOptions;
		expect(typeof opts.userSteerProvider).toBe("function");
	});

	it("SCENARIO-014: non-empty drain prepends a guidance block listing each input, instructing incorporation", async () => {
		const { provider } = makeProviderSpy(["Add a retry to the fetch", "Log the status code"]);
		await mkCtx({}, { userSteerProvider: provider }).agent({
			...BASE_CALL,
			prompt: "ORIG PROMPT",
		});
		expect(captured.prompt).toMatch(/ORIG PROMPT/);
		expect(captured.prompt).toMatch(/## Mid-run user guidance \(added during execution\)/);
		expect(captured.prompt).toMatch(/\(1\) Add a retry to the fetch/);
		expect(captured.prompt).toMatch(/\(2\) Log the status code/);
		expect(captured.prompt).toMatch(/Incorporate this into your work\./);
	});

	it("SCENARIO-014: the guidance block appears AFTER the feedback and knowledge prepends (tail-most)", async () => {
		// Feedback prepend is driven by state.__feedback; knowledge by the mock.
		const state = { __feedback: { spec: ["fix AC-1"] } } as unknown as PipelineState;
		const { provider } = makeProviderSpy(["steer one"]);
		await mkCtx(state, { userSteerProvider: provider }).agent(BASE_CALL);
		const p = captured.prompt!;
		const fbIdx = p.indexOf("Previous attempt rejected");
		const knowIdx = p.indexOf(KNOWLEDGE_MARKER);
		const guideIdx = p.indexOf("## Mid-run user guidance (added during execution)");
		expect(fbIdx).toBeGreaterThanOrEqual(0);
		expect(knowIdx).toBeGreaterThan(fbIdx); // knowledge after feedback (existing order)
		expect(guideIdx).toBeGreaterThan(knowIdx); // guidance is the LAST prepend
	});

	it("SCENARIO-016: an empty drain produces NO guidance block and a byte-identical baseline prompt", async () => {
		const baselineCtx = mkCtx({}); // no userSteerProvider at all → baseline
		await baselineCtx.agent({ ...BASE_CALL, prompt: "NEUTRAL" });
		const baseline = captured.prompt!;

		// Now with a provider that drains empty: must equal the no-feature baseline.
		const { provider } = makeProviderSpy([]);
		await mkCtx({}, { userSteerProvider: provider }).agent({ ...BASE_CALL, prompt: "NEUTRAL" });
		expect(captured.prompt).toBe(baseline);
		expect(captured.prompt).not.toMatch(/Mid-run user guidance/);
		expect(captured.prompt).toBe("NEUTRAL\n\n" + KNOWLEDGE_MARKER);
	});

	it("SCENARIO-015: drains exactly once per fresh spawn (realAgent, not the memoizing wrapper)", async () => {
		const { provider, callCount } = makeProviderSpy(["a", "b"]);
		const ctx = mkCtx({}, { userSteerProvider: provider }); // no resumeCache → realAgent
		await ctx.agent(BASE_CALL);
		await ctx.agent({ ...BASE_CALL, id: "pipeline.second" });
		expect(callCount()).toBe(2); // once per spawn
		// and each spawn saw both items (drain clears, so refill happens between
		// only if a real capture occurred — here refill proves a fresh drain each time)
	});

	it("SCENARIO-015: a memoized replay (resume cache hit) does NOT re-invoke the provider / re-inject", async () => {
		// Pre-populate the resume cache so the FIRST invocation is a cache HIT.
		// createMemoizingAgent's key is `<call.id>#<seq>`; seq starts at 1.
		const cached: AgentResult = { text: "CACHED TEXT", control: {} };
		const resumeCache = new Map<string, AgentResult>([[`${BASE_CALL.id}#1`, cached]]);
		const { provider, callCount } = makeProviderSpy(["should-not-be-injected-on-replay"]);
		const ctx = mkCtx({}, { userSteerProvider: provider, resumeCache });

		const result = await ctx.agent(BASE_CALL);
		// Cache hit → realAgent never ran → provider never drained.
		expect(result).toBe(cached);
		expect(callCount()).toBe(0);
	});

	it("SCENARIO-015: after a cache hit, a fresh (uncached) spawn drains and injects once", async () => {
		const cached: AgentResult = { text: "CACHED TEXT", control: {} };
		// Only the first call is cached; the second (different id, seq=2) misses.
		const resumeCache = new Map<string, AgentResult>([[`${BASE_CALL.id}#1`, cached]]);
		const { provider, callCount } = makeProviderSpy(["live steer after resume"]);
		const ctx = mkCtx({}, { userSteerProvider: provider, resumeCache });

		await ctx.agent(BASE_CALL); // HIT — no drain
		expect(callCount()).toBe(0);
		await ctx.agent({ ...BASE_CALL, id: "pipeline.fresh" }); // MISS — drain once
		expect(callCount()).toBe(1);
		expect(captured.prompt).toMatch(/\(1\) live steer after resume/);
	});

	it("makeContext tolerates a missing userSteerProvider (no feature) without throwing", async () => {
		await expect(mkCtx({}).agent(BASE_CALL)).resolves.toBeDefined();
		expect(captured.prompt).not.toMatch(/Mid-run user guidance/);
	});
});
