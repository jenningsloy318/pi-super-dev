/**
 * Stage 9 — Implementation (per-phase TDD).
 * Self-contained task: iterates the spec's phased task list. For each phase,
 * up to 3 attempts of TDD-write → implement → QA → build-gate; commits on green.
 */

import type { ControlObj, Stage } from "../types.ts";
import { buildTddPrompt, buildImplementPrompt, buildQaPrompt, buildCommitPrompt, buildImplementationSummaryPrompt } from "../prompts.ts";
import { renderAndWrite } from "../render/render.ts";
import { STAGE_MODELS } from "../render/schemas.ts";
import { normalizePhases } from "../doc-validators.ts";

const MAX_ATTEMPTS = 3;
const pad = (n: number) => String(n).padStart(2, "0");

export const implementationStage: Stage = {
	id: "implementation",
	label: "Stage 9 — Implementation",
	async run(state, ctx) {
		// Defensively normalize: agents sometimes return `phases` as a string or
		// object instead of an array, which crashed `phases.entries()` (Stage 9:
		// "phases.entries is not a function"). Never trust the control shape.
		const phases = normalizePhases(state.spec?.phases);
		if (!Array.isArray(state.spec?.phases) && state.spec?.phases != null) {
			ctx.log(`Implementation: spec.phases was ${typeof state.spec.phases}, expected an array — normalized to ${phases.length} phase(s)`);
		}
		if (phases.length === 0) {
			ctx.log("Implementation: no phases defined in spec — skipping");
			return { phasesCompleted: 0, totalPhases: 0, allGreen: false };
		}
		const setup = state.setup!;
		let phasesCompleted = 0;
		let allGreen = true;
		const filesModified: string[] = [];

		for (const [idx, phase] of phases.entries()) {
			const phaseId = `phase-${pad(idx + 1)}`;
			let green = false;
			for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
				if (!ctx.budget.check()) {
					allGreen = false;
					return { phasesCompleted, totalPhases: phases.length, allGreen, filesModified, summary: "Budget exhausted" };
				}
				await ctx.agent({ id: `pipeline.implementation.${phaseId}.tdd.a${attempt}`, agent: "tdd-guide", prompt: buildTddPrompt(setup, state.classify ?? null, phase, state.spec ?? null) });
				const specialist = await ctx.helper({ name: "route-specialist", sources: { "classify-task": state.classify }, options: { phase } });
				const impl = await ctx.agent({ id: `pipeline.implementation.${phaseId}.impl.a${attempt}`, agent: "implementer", prompt: buildImplementPrompt(setup, state.classify ?? null, phase, specialist.value, state.spec ?? null) });
				for (const f of ((impl.control as { filesModified?: unknown } | null)?.filesModified as string[] | undefined) ?? []) {
					if (!filesModified.includes(f)) filesModified.push(f);
				}
				const qa = await ctx.agent({ id: `pipeline.implementation.${phaseId}.qa.a${attempt}`, agent: "qa-agent", prompt: buildQaPrompt(setup, state.classify ?? null, phase) });
				const qaControl: ControlObj = qa.control ?? {};
				const gate = await ctx.helper({ name: "gate-build", sources: { "qa-check": qaControl } });
				if (gate.value.pass) {
					green = true;
					ctx.log(`Implementation ${phaseId} GREEN on attempt ${attempt}`);
					break;
				}
				ctx.log(`Implementation ${phaseId} attempt ${attempt}/${MAX_ATTEMPTS} FAIL: ${((gate.value.errors as string[]) ?? []).join(", ")}`);
			}
			if (!green) {
				ctx.log(`Implementation ${phaseId} failed after ${MAX_ATTEMPTS} attempts — terminating early`);
				allGreen = false;
				break;
			}
			phasesCompleted++;
			if (ctx.budget.check()) {
				await ctx.agent({ id: `pipeline.implementation.${phaseId}.commit`, agent: "orchestrator", prompt: buildCommitPrompt(setup, phase.name) });
			}
		}
		const control: ControlObj = {
			phasesCompleted,
			totalPhases: phases.length,
			allGreen,
			filesModified,
			summary: allGreen ? `All ${phases.length} phases completed successfully` : `${phasesCompleted}/${phases.length} phases completed`,
		};
		if (ctx.budget.check()) {
			const summaryResult = await ctx.agent({ id: "pipeline.implementation.summary", agent: "orchestrator", prompt: buildImplementationSummaryPrompt(setup, state.classify ?? null, control), schema: STAGE_MODELS["implementationSummary"]?.schema });
			renderAndWrite(setup, (m) => ctx.log(m), "implementationSummary", summaryResult.control as Record<string, unknown> | null);
		}
		return control;
	},
};
