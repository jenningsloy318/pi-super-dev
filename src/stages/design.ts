/**
 * Stage 6A — Design (routed).
 * Self-contained task: route-designer helper picks the specialist designer
 * (or skips for bug fixes), then spawns it.
 */

import type { Stage } from "../types.ts";
import { buildDesignPrompt } from "../prompts.ts";
import { renderAndWrite } from "../render/render.ts";
import { STAGE_MODELS } from "../render/schemas.ts";
// 059 R1A W1 + §3 R3 delta-5 NEW-3: the design stage's write-time contract
// slice — computed and stamped BEFORE the skip decision so the dual design-skip
// predicate (designConvergenceNode.skipped) and the R4 exemption both read it,
// and so a shared-surface bug fix is DESIGNED instead of skipped.
import { stampContractSlice, writerContractSlice } from "../review/contract-surface.ts";

export const designStage: Stage = {
	id: "design",
	label: "Stage 6A — Design",
	async run(state, ctx) {
		const routing = await ctx.helper({ name: "route-designer", sources: { "classify-task": state.classify } });
		// 059 W1: the design write-time slice (task + upstream controls — the SAME
		// texts designComplete's validator context evaluates). Fresh walk; stamped
		// even on the skip path so the convergence node's skipped predicate can
		// distinguish an empty touched-set from a routed improver run.
		// Adversarial S4a (v0.3.98): task + requirements intent ONLY — the
		// research/assessment corpus enumerates reconnaissance file lists, which
		// the literal-token touched-set match would read as "will touch", forcing
		// architecture-improver on unrelated bug fixes.
		const slice = writerContractSlice(state.setup?.worktreePath, [ctx.task, JSON.stringify(state.requirements ?? {})]);
		if (slice) stampContractSlice(state as Record<string, unknown>, "design", slice);
		let designerAgent = (routing.value.designerAgent as string) ?? null;
		if (!designerAgent && slice && slice.files.length > 0) {
			// 059 §3 R3 delta-5 NEW-3 (dual skip predicate, stage arm): a bug
			// classification only skips design when the write-time touched-set is
			// EMPTY — a shared-surface bug fix must pass the authoritative
			// amendment-family gate, so it routes the architecture-improver instead.
			designerAgent = "architecture-improver";
			ctx.log(`Design NOT skipped (059 dual predicate): bug classification touches shared surfaces (${slice.files.join(", ")}) — routing architecture-improver so the amendment family is declared`);
		}
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
			prompt: buildDesignPrompt(setup, state.classify ?? null, ctx.task, state.requirements ?? null, state.research ?? null, state.assessment ?? null, designerAgent, slice?.block ?? ""),
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
