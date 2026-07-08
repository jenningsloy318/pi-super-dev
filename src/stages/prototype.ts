/**
 * Stage 6B — Prototype (conditional + loop).
 * Self-contained task: only runs when the design declares numeric constants
 * (decided by check-prototype-needed); loops up to 3 rounds until pass.
 */

import type { ControlObj, Stage } from "../types.ts";
import { buildPrototypePrompt } from "../prompts.ts";
import { renderAndWrite } from "../render/render.ts";
import { STAGE_MODELS } from "../render/schemas.ts";

const MAX_ROUNDS = 3;
const pad = (n: number) => String(n).padStart(2, "0");

export const prototypeStage: Stage = {
	id: "prototype",
	label: "Stage 6B — Prototype",
	async run(state, ctx) {
		const design = state.design ?? null;
		if (!design) return null;
		const check = await ctx.helper({ name: "check-prototype-needed", sources: { design } });
		if (!check.value.needed) {
			ctx.log("Prototype not needed — no numeric constants to validate");
			return null;
		}
		const constants = (check.value.constants as string[]) ?? [];
		const setup = state.setup!;
		let last: ControlObj | null = null;
		for (let round = 1; round <= MAX_ROUNDS; round++) {
			if (!ctx.budget.check()) break;
			const result = await ctx.agent({
				id: `pipeline.prototype.r${pad(round)}`,
				agent: "prototype-runner",
				prompt: buildPrototypePrompt(setup, state.classify ?? null, ctx.task, design, constants, round),
				schema: STAGE_MODELS["prototype"]?.schema,
			});
			renderAndWrite(setup, (m) => ctx.log(m), "prototype", result.control as Record<string, unknown> | null);
			last = result.control ?? null;
			if (last?.verdict === "pass") {
				ctx.log(`Prototype validation PASS on round ${round}`);
				return last;
			}
			ctx.log(`Prototype round ${round}/${MAX_ROUNDS}: verdict=${last?.verdict ?? "unknown"}`);
		}
		return last;
	},
};
