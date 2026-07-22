/**
 * Verifies the retry-convergence wire: when a gate rejects an attempt, it stores
 * errors in state.__feedback[stageId]; workflow.ts's ctx.agent() must prepend
 * those errors to the next attempt's prompt so the agent fixes the specific
 * failure. Mocks the session/subprocess backends to capture the prompt.
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
	needsWebResearch: vi.fn(() => false),
}));

import { makeContext } from "../src/workflow.ts";
import type { PipelineState } from "../src/types.ts";

const mkCtx = (state: PipelineState) => makeContext(state, "t", {}, () => {});

describe("workflow agent() feedback injection (retry convergence)", () => {
	it("prepends gate feedback to the retry prompt, keyed by stage id", async () => {
		const state = { __feedback: { mytest: ["missing AC-NN items", "doc too short"] } } as unknown as PipelineState;
		await mkCtx(state).agent({ id: "pipeline.mytest", agent: "requirements-clarifier", prompt: "BASE PROMPT" });
		expect(captured.prompt).toMatch(/Previous attempt rejected/);
		expect(captured.prompt).toMatch(/missing AC-NN items/);
		expect(captured.prompt).toMatch(/doc too short/);
		expect(captured.prompt).toMatch(/BASE PROMPT/);
	});
	it("passes the prompt through unchanged when there is no feedback for the stage", async () => {
		await mkCtx({} as PipelineState).agent({ id: "pipeline.other", agent: "requirements-clarifier", prompt: "PLAIN" });
		expect(captured.prompt).toBe("PLAIN");
	});
});
