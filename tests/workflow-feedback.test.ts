/**
 * Verifies the retry-convergence wire: when a gate rejects an attempt, it stores
 * errors in state.__feedback[stageId]; workflow.ts's ctx.agent() must prepend
 * those errors to the next attempt's prompt so the agent fixes the specific
 * failure. Mocks the session/subprocess backends to capture the prompt.
 */
import { beforeEach, describe, it, expect, vi } from "vitest";

const captured: { prompt?: string } = {};
vi.mock("../src/agents/delegation-backend.ts", async (importOriginal) => ({
	...await importOriginal<typeof import("../src/agents/delegation-backend.ts")>(),
	runAgentViaDelegation: vi.fn(async (opts: { prompt?: string }) => {
		captured.prompt = opts.prompt;
		return { text: "", control: {} };
	}),
}));
vi.mock("../src/agents/register-agents.ts", async (importOriginal) => ({
	...await importOriginal<typeof import("../src/agents/register-agents.ts")>(),
	delegationOwnerPresent: vi.fn(() => true),
}));


import { makeContext } from "../src/workflow.ts";
import { languageDirective } from "../src/render/super-dev-dir.ts";
import { DELEGATION_AUTONOMY_CLAUSE } from "../src/workflow.ts";
import { recordConvergenceFindings } from "../src/convergence-ledger.ts";
import type { PipelineState } from "../src/types.ts";

const mkCtx = (state: PipelineState) => makeContext(state, "t", { events: {} as never }, () => {});

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
	it("adds ONLY the output-language directive when there is no feedback for the stage", async () => {
		await mkCtx({} as PipelineState).agent({ id: "pipeline.other", agent: "requirements-clarifier", prompt: "PLAIN" });
		// v0.3.23: the configured-language directive is the one unconditional
		// addition; with no feedback the prompt is original + directive, byte-exact.
		expect(captured.prompt).toBe(`PLAIN\n\n${DELEGATION_AUTONOMY_CLAUSE}\n\n${languageDirective()}`);
	});
	it("enforces maxAgents centrally before spawning", async () => {
		const ctx = makeContext({} as PipelineState, "t", { events: {} as never, maxAgents: 0 }, () => {});
		const r = await ctx.agent({ id: "pipeline.too-many", agent: "requirements-clarifier", prompt: "NOPE" });
		expect(r.error).toMatch(/budget exhausted/);
		expect(captured.prompt).not.toBe("NOPE");
	});
});
