/**
 * Stage 9 — Implementation (per-phase TDD).
 * Self-contained task: iterates the spec's phased task list. For each phase,
 * up to 3 attempts of TDD-write → implement → build-gate; commits on green.
 * The build-gate is the DETERMINISTIC hard oracle (build-runner.ts) that
 * replaces the old QA self-report — no more vacuous pass on "agent said green".
 */

import type { ControlObj, Stage } from "../types.ts";
import { buildTddPrompt, buildImplementPrompt, buildCommitPrompt, buildImplementationSummaryPrompt } from "../prompts.ts";
import { renderAndWrite } from "../render/render.ts";
import { STAGE_MODELS } from "../render/schemas.ts";
import { normalizePhases } from "../doc-validators.ts";
import { runBuildGate } from "../build-runner.ts";

const MAX_ATTEMPTS = 3;
const pad = (n: number) => String(n).padStart(2, "0");

/**
 * Extract referenced crate names from error blocks for the IN-SCOPE GREEN log
 * (AC-05 → SCENARIO-012/025). Reuses the same two markers as the build-gate's
 * `classifyOutOfScopeErrors`: (a) `crates/<pkg>/` path markers and (b) cargo
 * `-p <pkg>` markers. De-duplicates while preserving first-seen order.
 */
function cratesFromErrors(errors: string[]): string[] {
	const crates: string[] = [];
	const pathRe = /crates\/([^/]+)\//g;
	const pkgRe = /(?:^|\s)-p\s+(\S+)/g;
	for (const block of errors) {
		let m: RegExpExecArray | null;
		pathRe.lastIndex = 0;
		while ((m = pathRe.exec(block))) crates.push(m[1]);
		pkgRe.lastIndex = 0;
		while ((m = pkgRe.exec(block))) crates.push(m[1]);
	}
	return Array.from(new Set(crates));
}

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
			let attemptErrors: string[] = [];
			for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
				if (!ctx.budget.check()) {
					allGreen = false;
					return { phasesCompleted, totalPhases: phases.length, allGreen, filesModified, summary: "Budget exhausted" };
				}
				const specialist = await ctx.helper({ name: "route-specialist", sources: { "classify-task": state.classify }, options: { phase } });
				const lang = (specialist.value.languageInstructions as string) ?? "";
				await ctx.agent({ id: `pipeline.implementation.${phaseId}.tdd.a${attempt}`, agent: "tdd-guide", prompt: buildTddPrompt(setup, state.classify ?? null, phase, state.spec ?? null, lang) });
				// Feed the previous attempt's REAL build/test errors into this attempt
				// so the implementer fixes the specific failures instead of resampling.
				const basePrompt = buildImplementPrompt(setup, state.classify ?? null, phase, specialist.value, state.spec ?? null);
				const implPrompt = attemptErrors.length
					? `${basePrompt}\n\n## Previous attempt failed the build/test gate — fix these\n${attemptErrors.map((e) => `- ${e}`).join("\n")}`
					: basePrompt;
				const impl = await ctx.agent({ id: `pipeline.implementation.${phaseId}.impl.a${attempt}`, agent: "implementer", prompt: implPrompt });
				for (const f of ((impl.control as { filesModified?: unknown } | null)?.filesModified as string[] | undefined) ?? []) {
					if (!filesModified.includes(f)) filesModified.push(f);
				}
				// HARD test oracle: actually run build/test/typecheck instead of trusting
				// a QA agent's self-report (vacuous-pass risk). Non-fatal when nothing
				// is detectable (greenfield): ran is empty and pass is true.
				const gate = runBuildGate(setup.worktreePath, { signal: ctx.signal });
				attemptErrors = gate.errors;
				ctx.log(`Implementation ${phaseId} build-gate ${gate.pass ? "PASS" : "FAIL"} (ran: ${gate.ran.join(", ") || "no commands"})`);
				// In-scope verdict (AC-05 → SCENARIO-012/013/014/025/027): the phase is GREEN
				// when the gate fully passed OR when every failure is a pre-existing
				// out-of-scope crate the branch never touched (gate.inScopePass). The
				// `if (!green)` branch below therefore fires ONLY on genuine in-scope
				// failures — neither pass nor inScopePass after MAX_ATTEMPTS — so
				// pre-existing breakage elsewhere can no longer abort green in-scope work.
				if (gate.pass || gate.inScopePass) {
					green = true;
					if (gate.pass) {
						ctx.log(`Implementation ${phaseId} GREEN on attempt ${attempt}`);
					} else {
						ctx.log(`Implementation ${phaseId} IN-SCOPE GREEN on attempt ${attempt} — ${gate.outOfScopeErrors.length} pre-existing out-of-scope failure(s) ignored (crates: ${cratesFromErrors(gate.outOfScopeErrors).join(",")})`);
					}
					break;
				}
				ctx.log(`Implementation ${phaseId} attempt ${attempt}/${MAX_ATTEMPTS} FAIL: ${gate.errors.join("; ")}`);
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
