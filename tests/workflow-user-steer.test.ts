/**
 * Mid-run user context — durable injection at the realAgent spawn seam.
 *
 * Verifies the delivery path for free-text typed during a run:
 *  - the `userSteerProvider` (atomic drain) is persisted via `appendUserNotes`
 *    (to `.user-notes.json`),
 *  - the accumulated notes (`userNotesForAgent`) are prepended as a
 *    `## User context (added during the run)` block AFTER knowledge,
 *  - draining happens inside `realAgent` (once per fresh spawn; not on a
 *    resume-cache hit),
 *  - empty notes → no block, byte-identical to the no-feature baseline.
 *
 * user-notes is MOCKED here so the wiring is asserted deterministically; the
 * file mechanics (append→read round-trip) are covered by tests/user-notes.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const captured: { prompt?: string } = {};
vi.mock("../src/session-agent.ts", () => ({
	runAgentViaSession: vi.fn(async (opts: { prompt?: string }) => {
		captured.prompt = opts.prompt;
		return { text: "", control: {} };
	}),
	summarizeSlug: vi.fn(async () => "x"),
}));
vi.mock("../src/pi-spawn.ts", async (importOriginal) => ({
	...await importOriginal<typeof import("../src/pi-spawn.ts")>(),
	spawnAgent: vi.fn(async (opts: { prompt?: string }) => {
		captured.prompt = opts.prompt;
		return { text: "", control: {} };
	}),
	isBrowserAgent: vi.fn(() => false),
	needsWebResearch: vi.fn(() => false),
}));
const KNOWLEDGE_BODY = "KNOWLEDGE-FROM-PRIOR-STAGE";
const KNOWLEDGE_MARKER = "## Prior-stage data (auto-injected)\nKNOWLEDGE-FROM-PRIOR-STAGE";
vi.mock("../src/render/knowledge.ts", () => ({
	knowledgeForAgent: vi.fn(() => KNOWLEDGE_BODY),
}));
// user-notes mocked: appendUserNotes records its args; userNotesForAgent returns
// a controlled body (default empty so the baseline path is byte-identical).
vi.mock("../src/render/user-notes.ts", () => ({
	appendUserNotes: vi.fn(),
	userNotesForAgent: vi.fn(() => ""),
}));

import { makeContext } from "../src/workflow.ts";
import { languageDirective } from "../src/render/super-dev-dir.ts";
import { DELEGATION_AUTONOMY_CLAUSE } from "../src/workflow.ts";
import { appendUserNotes, userNotesForAgent } from "../src/render/user-notes.ts";
import type { AgentCall, AgentResult, PipelineState, RunOptions } from "../src/types.ts";

const appendSpy = vi.mocked(appendUserNotes);
const notesSpy = vi.mocked(userNotesForAgent);

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
		callCount: () => calls.length,
		refill: (items: string[]) => {
			queue = [...items];
		},
	};
}

const mkCtx = (state: PipelineState, options: RunOptions = {}) =>
	makeContext(state, "t", options, () => {});

const BASE_CALL: AgentCall = { id: "pipeline.spec", agent: "spec-writer", prompt: "BASE PROMPT" };

describe("workflow agent() durable user-context injection", () => {
	beforeEach(() => {
		captured.prompt = undefined;
		appendSpy.mockClear();
		notesSpy.mockClear();
		notesSpy.mockReturnValue(""); // baseline: no notes
	});

	it("the drain provider is atomic (returns all + clears)", () => {
		const { provider, refill } = makeProviderSpy(["first", "second"]);
		expect(provider()).toEqual(["first", "second"]);
		expect(provider()).toEqual([]);
		refill(["late"]);
		expect(provider()).toEqual(["late"]);
	});

	it("a non-empty drain is PERSISTED via appendUserNotes and the accumulated notes are prepended", async () => {
		notesSpy.mockReturnValue("(1) Add a retry to the fetch\n(2) Log the status code");
		const { provider } = makeProviderSpy(["Add a retry to the fetch", "Log the status code"]);
		await mkCtx({}, { userSteerProvider: provider }).agent({ ...BASE_CALL, prompt: "ORIG PROMPT" });
		// the drained items reached the persistent store
		expect(appendSpy).toHaveBeenCalledTimes(1);
		expect(appendSpy.mock.calls[0]![1]).toEqual(["Add a retry to the fetch", "Log the status code"]);
		// and the accumulated notes are injected under the durable header
		expect(captured.prompt).toMatch(/ORIG PROMPT/);
		expect(captured.prompt).toMatch(/## User context \(added during the run\)/);
		expect(captured.prompt).toMatch(/\(1\) Add a retry to the fetch/);
		expect(captured.prompt).toMatch(/\(2\) Log the status code/);
	});

	it("the user-context block appears AFTER the feedback and knowledge prepends", async () => {
		const state = { __feedback: { spec: ["fix AC-1"] } } as unknown as PipelineState;
		notesSpy.mockReturnValue("(1) steer one");
		const { provider } = makeProviderSpy(["steer one"]);
		await mkCtx(state, { userSteerProvider: provider }).agent(BASE_CALL);
		const p = captured.prompt!;
		const fbIdx = p.indexOf("Previous attempt rejected");
		const knowIdx = p.indexOf(KNOWLEDGE_MARKER);
		const ctxIdx = p.indexOf("## User context (added during the run)");
		expect(fbIdx).toBeGreaterThanOrEqual(0);
		expect(knowIdx).toBeGreaterThan(fbIdx);
		expect(ctxIdx).toBeGreaterThan(knowIdx); // user context is the LAST prepend
	});

	it("empty notes → NO block, byte-identical to the no-feature baseline", async () => {
		// baseline: no provider, userNotesForAgent returns ""
		await mkCtx({}).agent({ ...BASE_CALL, prompt: "NEUTRAL" });
		const baseline = captured.prompt!;
		// with a provider that drains empty + still-empty notes: identical
		const { provider } = makeProviderSpy([]);
		await mkCtx({}, { userSteerProvider: provider }).agent({ ...BASE_CALL, prompt: "NEUTRAL" });
		expect(captured.prompt).toBe(baseline);
		expect(captured.prompt).not.toMatch(/User context/);
		// v0.3.23: the unconditional output-language directive rides at the very
		// end of every prompt; the user-steer baseline is unchanged above it.
		expect(captured.prompt).toBe("NEUTRAL\n\n" + DELEGATION_AUTONOMY_CLAUSE + "\n\n" + KNOWLEDGE_MARKER + "\n\n" + languageDirective());
	});

	it("drains exactly once per fresh spawn (realAgent, not the memoizing wrapper)", async () => {
		const { provider, callCount } = makeProviderSpy(["a", "b"]);
		const ctx = mkCtx({}, { userSteerProvider: provider });
		await ctx.agent(BASE_CALL);
		await ctx.agent({ ...BASE_CALL, id: "pipeline.second" });
		expect(callCount()).toBe(2);
	});

	it("a memoized replay (resume cache hit) does NOT re-drain / re-persist", async () => {
		const cached: AgentResult = { text: "CACHED TEXT", control: {} };
		const resumeCache = new Map<string, AgentResult>([[`${BASE_CALL.id}@root#1`, cached]]);
		const { provider, callCount } = makeProviderSpy(["should-not-persist-on-replay"]);
		const ctx = mkCtx({}, { userSteerProvider: provider, resumeCache });
		const result = await ctx.agent(BASE_CALL);
		expect(result).toBe(cached);
		expect(callCount()).toBe(0);
		expect(appendSpy).not.toHaveBeenCalled();
	});

	it("makeContext tolerates a missing userSteerProvider without throwing", async () => {
		await expect(mkCtx({}).agent(BASE_CALL)).resolves.toBeDefined();
		expect(captured.prompt).not.toMatch(/User context/);
	});
});
