/**
 * Stage 6 — Design (routed).
 * Self-contained task: route-designer helper picks the specialist designer
 * (or skips for bug fixes), then spawns it.
 */

import type { Stage } from "../types.ts";
import { buildDesignPrompt } from "../prompts.ts";
import { renderAndWrite } from "../render/render.ts";
import { STAGE_MODELS } from "../render/schemas.ts";

export const designStage: Stage = {
	id: "design",
	label: "Stage 6 — Design",
	async run(state, ctx) {
		const routing = await ctx.helper({ name: "route-designer", sources: { "classify-task": state.classify } });
		const designerAgent = (routing.value.designerAgent as string) ?? null;
		if (!designerAgent) {
			ctx.log(`Design skipped: ${routing.value.reason as string}`);
			return null;
		}
		if (!ctx.budget.check()) {
			ctx.log("Design: budget exhausted");
			return null;
		}
		const setup = state.setup!;
		const result = await ctx.agent({
			id: "pipeline.design",
			agent: designerAgent,
			prompt: buildDesignPrompt(setup, state.classify ?? null, ctx.task, state.requirements ?? null, state.research ?? null, state.assessment ?? null, designerAgent),
			schema: STAGE_MODELS["design"]?.schema,
		});
		renderAndWrite(setup, (m) => ctx.log(m), "design", result.control as Record<string, unknown> | null);
		ctx.log(`Design complete (agent: ${designerAgent})`);
		return result.control ?? null;
	},
};
