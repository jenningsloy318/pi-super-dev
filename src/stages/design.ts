/**
 * Stage 6A — Design (routed).
 * Self-contained task: route-designer helper picks the specialist designer
 * (or skips for bug fixes), then spawns it.
 */

import type { Stage } from "../types.ts";
import { buildDesignPrompt } from "../prompts.ts";
import { renderAndWrite } from "../render/render.ts";
import { STAGE_MODELS } from "../render/schemas.ts";

export const designStage: Stage = {
	id: "design",
	label: "Stage 6A — Design",
	async run(state, ctx) {
		const routing = await ctx.helper({ name: "route-designer", sources: { "classify-task": state.classify } });
		const designerAgent = (routing.value.designerAgent as string) ?? null;
		if (!designerAgent) {
			// Intentional skip (bug fixes are not redesigned). Return null so
			// state.design stays undefined; the convergence node's `skipped` predicate
			// recognizes this via CLASSIFICATION (taskType==="bug"), NOT via a truthy
			// marker that would pollute prototype/spec downstream.
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
			accessMode: "source-read-only",
			prompt: buildDesignPrompt(setup, state.classify ?? null, ctx.task, state.requirements ?? null, state.research ?? null, state.assessment ?? null, designerAgent),
			schema: STAGE_MODELS["design"]?.schema,
		});
		if (!result.control) {
			// A designer WAS selected but timed out / returned no control: a FAILURE,
			// not a skip. Return null; designConvergenceNode retries (its `skipped`
			// predicate is false for a non-bug task) instead of bypassing the gate.
			ctx.log(`Design: designer ${designerAgent} produced no design artifact${result.error ? ` — ${result.error}` : ""}`);
			return null;
		}
		// renderAndWrite returns the written doc path, or NULL when schema/render
		// validation failed (incomplete control → no NN-design.md on disk). A null
		// here means the design review would run against a MISSING document, so treat
		// it as a failure and retry rather than passing the gate on a phantom design.
		const renderErrors: string[] = [];
		const docPath = renderAndWrite(setup, (m) => ctx.log(m), "design", result.control as Record<string, unknown>, (errs) => renderErrors.push(...errs));
		const stateRec = state as Record<string, unknown>;
		if (!docPath) {
			// v0.3.32 (runs 2026-08-30T00-10-34 / 03-23-40): the convergence loop's
			// generic "no artifact" feedback HID the actual schema errors, so the
			// retrying designer mutated content (reviewResponses, numericConstants)
			// while the real defect (`alternativesConsidered[].alternatives` as a
			// prose string) stayed invisible for every round until the judge
			// escalated on a guess. Record the exact errors where the loop reads them.
			stateRec.__renderErrors = renderErrors;
			ctx.log(`Design: designer ${designerAgent} returned control that failed schema/render — no design doc written; retrying`);
			return null;
		}
		delete stateRec.__renderErrors;
		ctx.log(`Design complete (agent: ${designerAgent})`);
		return result.control;
	},
};
