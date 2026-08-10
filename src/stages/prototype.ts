/**
 * Stage 6B — Prototype (conditional + loop).
 * Self-contained task: only runs when the design declares numeric constants
 * (decided by check-prototype-needed); loops until pass, global budget
 * exhaustion, or repeated no-progress prototype evidence.
 */

import type { ControlObj, Stage } from "../types.ts";
import { buildPrototypePrompt } from "../prompts.ts";
import { renderAndWrite } from "../render/render.ts";
import { STAGE_MODELS } from "../render/schemas.ts";

const pad = (n: number) => String(n).padStart(2, "0");

function prototypeSignature(control: ControlObj | null): string {
	if (!control) return "no-control";
	const c = control as Record<string, unknown>;
	return JSON.stringify({
		verdict: String(c.verdict ?? "unknown"),
		summary: String(c.summary ?? "").replace(/\s+/g, " ").trim().slice(0, 600),
		measurements: Array.isArray(c.measurements) ? c.measurements.map((v) => String(v)).sort() : [],
		adjustments: Array.isArray(c.adjustments) ? c.adjustments.map((v) => String(v)).sort() : [],
	});
}

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
		const signatures: string[] = [];
		for (let round = 1; ctx.budget.check(); round++) {
			const result = await ctx.agent({
				id: `pipeline.prototype.r${pad(round)}`,
				agent: "prototype-runner",
				accessMode: "source-read-only",
				prompt: buildPrototypePrompt(setup, state.classify ?? null, ctx.task, design, constants, round, last),
				schema: STAGE_MODELS["prototype"]?.schema,
			});
			renderAndWrite(setup, (m) => ctx.log(m), "prototype", result.control as Record<string, unknown> | null);
			last = result.control ?? null;
			if (last?.verdict === "pass") {
				ctx.log(`Prototype validation PASS on round ${round}`);
				return last;
			}
			const signature = prototypeSignature(last);
			const noProgress = signatures[signatures.length - 1] === signature;
			signatures.push(signature);
			ctx.log(`Prototype round ${round}: verdict=${last?.verdict ?? "unknown"}`);
			if (noProgress) {
				ctx.log(`Prototype stopped after repeated no-progress evidence on round ${round}`);
				break;
			}
		}
		if (!ctx.budget.check()) ctx.log("Prototype stopped because the global agent budget was exhausted");
		return last;
	},
};
