/**
 * Stage 9 — Implementation (per-phase TDD).
 * Self-contained task: iterates the spec's phased task list. For each phase,
 * up to 3 attempts of TDD-write → implement → QA → build-gate; commits on green.
 */

import type { ControlObj, Stage } from "../types.ts";
import { buildTddPrompt, buildImplementPrompt, buildQaPrompt, buildCommitPrompt, buildImplementationSummaryPrompt } from "../prompts.ts";

const MAX_ATTEMPTS = 3;
const pad = (n: number) => String(n).padStart(2, "0");

export const implementationStage: Stage = {
	id: "implementation",
	label: "Stage 9 — Implementation",
	async run(state, ctx) {
		const phases = (state.spec?.phases as Array<{ name: string; description?: string }>) ?? [];
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
				await ctx.agent({ id: `pipeline.implementation.${phaseId}.impl.a${attempt}`, agent: "implementer", prompt: buildImplementPrompt(setup, state.classify ?? null, phase, specialist.value, state.spec ?? null) });
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
			await ctx.agent({ id: "pipeline.implementation.summary", agent: "orchestrator", prompt: buildImplementationSummaryPrompt(setup, state.classify ?? null, control) });
		}
		return control;
	},
};
