/**
 * Verifies the retry-convergence wire: when a gate rejects an attempt, it stores
 * errors in state.__feedback[stageId]; workflow.ts's ctx.agent() must prepend
 * those errors to the next attempt's prompt so the agent fixes the specific
 * failure. Mocks the session/subprocess backends to capture the prompt.
 */
import { beforeEach, describe, it, expect, vi } from "vitest";

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
import { recordConvergenceFindings } from "../src/convergence-ledger.ts";
import type { PipelineState } from "../src/types.ts";

const mkCtx = (state: PipelineState) => makeContext(state, "t", {}, () => {});

describe("workflow agent() feedback injection (retry convergence)", () => {
	beforeEach(() => { delete captured.prompt; });

	it("prepends gate feedback to the retry prompt, keyed by stage id", async () => {
		const state = { __feedback: { mytest: ["missing AC-NN items", "doc too short"] } } as unknown as PipelineState;
		await mkCtx(state).agent({ id: "pipeline.mytest", agent: "requirements-clarifier", prompt: "BASE PROMPT" });
		expect(captured.prompt).toMatch(/Previous attempt rejected/);
		expect(captured.prompt).toMatch(/missing AC-NN items/);
		expect(captured.prompt).toMatch(/doc too short/);
		expect(captured.prompt).toMatch(/BASE PROMPT/);
	});
	it("also injects shared convergence-ledger findings when stage feedback has not already included them", async () => {
		const state = {} as PipelineState;
		recordConvergenceFindings(state, {
			detectedAtStage: "verification",
			ownerStage: "implementation",
			severity: "high",
			blocking: true,
			title: "Review finding still open",
			detail: "Code review found the same stale-session bug twice.",
			evidence: ["auth.ts still forwards stale cookie"],
			sourceGate: "review",
		});

		await mkCtx(state).agent({ id: "pipeline.implementation", agent: "implementer", prompt: "FIX PROMPT" });

		expect(captured.prompt).toMatch(/convergence-ledger/);
		expect(captured.prompt).toMatch(/Review finding still open/);
		expect(captured.prompt).toMatch(/FIX PROMPT/);
	});
	it("passes the prompt through unchanged when there is no feedback for the stage", async () => {
		await mkCtx({} as PipelineState).agent({ id: "pipeline.other", agent: "requirements-clarifier", prompt: "PLAIN" });
		expect(captured.prompt).toBe("PLAIN");
	});
	it("enforces maxAgents centrally before spawning", async () => {
		const ctx = makeContext({} as PipelineState, "t", { maxAgents: 0 }, () => {});
		const r = await ctx.agent({ id: "pipeline.too-many", agent: "requirements-clarifier", prompt: "NOPE" });
		expect(r.error).toMatch(/budget exhausted/);
		expect(captured.prompt).not.toBe("NOPE");
	});
});
