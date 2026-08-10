/**
 * The super-dev workflow, expressed as a tree of control-flow nodes.
 *
 * This is the declarative pipeline definition. To customize:
 *   - Remove a stage: delete the node from the sequence.
 *   - Reorder: move nodes (mind data dependencies — a node reads upstream
 *     artifacts by state key, e.g. `state.spec` is written by the spec stage).
 *   - Add a stage: write a `Stage` (or compose control nodes), insert it.
 *   - Replace a stage: swap the node (keep the same output state key).
 *   - Change control flow: swap a `task` for `branch`/`gate`/`loop`/`parallel`/
 *     `retry`/`map`/`wait`/`tryCatch` from `nodes.ts`.
 *
 * The runner (`workflow.ts`) never changes.
 *
 *   setup ─► classify ─► converge(requirements) ─► converge(bdd) ─► converge(research) ─►
 *   branch[bug]→debug ─► assessment ─► design ─► prototype ─►
 *   spec/review convergence ─► implementation ─►
 *   verification convergence (review/build → integration, restarting at review
 *   after every fix) ─►
 *   branch[verified]→docs ─► cleanup ─► branch[!blocked]→merge
 */

import { task, sequence, branch, loop } from "../nodes.ts";
import type { ControlObj, PipelineState, Stage, Workflow } from "../types.ts";
import { setupStage } from "./setup.ts";
import { classifyStage, cleanupTask, debugWriter, assessmentWriter, specWriter, specReviewWriter, docsWriter, mergeWriter } from "./writers.ts";
import { designStage } from "./design.ts";
import { prototypeStage } from "./prototype.ts";
import { runBuildGate, buildGateCorrelationLine, type GateOptions } from "../build-runner.ts";
import { implementationStage } from "./implementation.ts";
import { verificationConvergenceNode, reviewApproved } from "./verify.ts";
import { specConvergenceNode } from "./spec-convergence.ts";
import { bddConvergenceNode, requirementsConvergenceNode, researchConvergenceNode, researchComplete } from "./artifact-convergence.ts";

// ─── Predicates ─────────────────────────────────────────────────────────────

const isBug = (s: PipelineState) => s.classify?.taskType === "bug";

/** Merge only when cleanup actually ran AND found nothing blocking. Treating a
 *  missing cleanup result as "safe to merge" is a vacuous pass — cleanup may
 *  simply have failed to produce output. */
const notBlocked = (s: PipelineState) => {
	const c = s.cleanup as { blocked?: boolean } | undefined;
	return !!c && c.blocked !== true;
};

/** Pre-merge hard build gate: block merge when the deterministic build/test
 *  gate ran and FAILED. A missing result (tolerant skip, or greenfield with no
 *  manifest → `pass` is true anyway) does not block — we only refuse to merge
 *  code we could actually verify and that failed verification. */
const preMergeBuildStage: Stage = {
	id: "preMergeBuild",
	label: "Pre-merge build gate",
	async run(state, ctx) {
		const setup = state.setup!;
		const r = runBuildGate(setup.worktreePath, { gate: (state.spec?.gate) as GateOptions | undefined, signal: ctx.signal });
		ctx.log(`Pre-merge build-gate ${r.pass ? "PASS" : "FAIL"} (ran: ${r.ran.join(", ") || "no commands"})${r.pass ? "" : " — merge will be skipped"}`);
		// AR-02: emit the pi session/model correlation tag to the run trace so the
		// captured correlation field is observable (not write-only). No-op when the
		// env vars are absent (byte-identical to today).
		const corr = buildGateCorrelationLine(r);
		if (corr) ctx.log(corr);
		return { pass: r.pass, ran: r.ran, errors: r.errors };
	},
};
/** Merge is conservative (design report §C / audit Findings 1,2,4b): require an
 *  AFFIRMATIVE verification + pre-merge build pass (not merely "not failed" — a
 *  missing result is a vacuous pass, the asymmetry the audit flagged vs
 *  `notBlocked` which correctly treats missing as blocking), AND implementation
 *  completeness (allGreen), AND review approval. Defense-in-depth: even if the
 *  tolerant sequence let a partial/failed verification flow onward, it cannot
 *  merge. */
export const canMerge = (s: PipelineState) => {
	if (!notBlocked(s)) return false;
	const impl = s.implementation as { allGreen?: boolean } | undefined;
	if (impl?.allGreen !== true) return false; // completeness gate
	if (!reviewApproved(s)) return false;     // defense-in-depth
	const integration = s.integration as { pass?: boolean } | undefined;
	if (integration?.pass !== true) return false; // Stage 10 verification convergence gate
	const b = s.preMergeBuild as { pass?: boolean } | undefined;
	return b?.pass === true;                   // affirmative pass, not !== false
};

/** Implementation is reviewable ONLY when it is COMPLETE (all phases green).
 *  Design report §C / audit Finding 1: the gate-symmetry hole — every document
 *  stage is wrapped in `gate(validate,attempts)`, but implementation had no
 *  completeness gate, so `allGreen=false` flowed into review/test/merge of
 *  PARTIAL code (the "merged 2/6 phases" false green). Now review/test are
 *  skipped on a partial implementation; the run's status is `partial` and the
 *  caller recovers via RESUME (not via Stage 10c finishing impl work). */
export const hasImplementation = (s: PipelineState) => {
	const i = s.implementation as { totalPhases?: number; allGreen?: boolean } | undefined;
	return (i?.totalPhases ?? 0) > 0 && i?.allGreen === true;
};

/** Downstream write-capable stages may only run after Stage 10 has positively
 *  verified the implementation. A tolerant sequence can carry a failed Stage 10
 *  result forward, so this predicate is the explicit safety boundary for docs,
 *  pre-merge build, cleanup, and merge. */
export const hasVerifiedImplementation = (s: PipelineState) => {
	if (!hasImplementation(s)) return false;
	if (!reviewApproved(s)) return false;
	const integration = s.integration as { pass?: boolean } | undefined;
	if (integration?.pass !== true) return false;
	const build = s.buildGate as { pass?: boolean } | undefined;
	return build?.pass === true;
};

/** §D auto-iterate convergence loop (design report §D): re-run implementation
 *  until all phases are green, the global budget is exhausted, or Stage 9 marks
 *  the phase as no-progress blocked. Combined with the per-phase green-state
 *  carry in implementation.ts, a re-run SKIPS already-green phases and
 *  re-attempts only the failed one(s), seeded with prior failure reasons. */
const implAllGreen = (s: PipelineState) =>
	((s.implementation as { allGreen?: boolean } | undefined)?.allGreen === true);
const implConvergenceBlocked = (s: PipelineState) =>
	((s.implementation as { convergenceBlocked?: boolean } | undefined)?.convergenceBlocked === true);

// ─── Verify (Stage 10): fresh-evidence convergence loop ─────────────────────
// Extracted to src/stages/verify.ts. Each attempt runs fresh review + build
// evidence before integration. Any fix invalidates downstream evidence and the
// next attempt starts at review again: review → fix → review → integration →
// fix → review → integration, bounded by the verification loop's safety policy.

// ─── The pipeline ───────────────────────────────────────────────────────────

const pipeline = sequence(
	[
		task(setupStage),
		task(classifyStage),
		// Foundational artifact convergence: write → validate → rewrite until the
		// artifact is clear, complete, and externally valid. These ambiguity-bearing
		// stages are bounded by the global run budget/cancellation/environment, not by
		// a local N-attempt cap, so they cannot fail merely because the fifth rewrite
		// still had a resolvable gap. Later code-changing loops use the same global
		// budget boundary plus no-progress/stagnation detection.
		requirementsConvergenceNode,
		bddConvergenceNode,
		researchConvergenceNode,
		// Conditional branch: debug analysis only for bug fixes.
		branch(isBug, { yes: task(debugWriter) }),
		task(assessmentWriter),
		task(designStage),
		task(prototypeStage),
		specConvergenceNode,
		// §D auto-iterate convergence loop: re-run implementation until allGreen,
		// global budget exhaustion, or a no-progress block. The per-phase
		// green-state carry in implementation.ts skips already-green phases each
		// iteration and seeds failed phases with prior reasons.
		loop(
			{ while: (s, c) => !implAllGreen(s) && !implConvergenceBlocked(s) && c.budget.check() },
			task(implementationStage),
		),
		// Verify only runs when implementation produced all phases. The convergence
		// node owns review/build/integration freshness; a fix is never terminal
		// evidence and always forces the next attempt to restart at review.
		branch(hasImplementation, { yes: verificationConvergenceNode }),
		// Downstream write-capable close-out stages run only after positive Stage 10
		// verification. A failed/blocking verification in this tolerant sequence must
		// not be followed by docs/cleanup/merge mutations.
		branch(hasVerifiedImplementation, {
			yes: sequence([
				task(docsWriter),
				// Pre-merge hard build gate (Gap A): don't merge broken code. Run BEFORE
				// cleanup so dependency cleanup cannot remove node_modules/toolchains needed
				// by the final verification pass.
				task(preMergeBuildStage),
				task(cleanupTask),
				// Conditional branch: merge only if cleanup found no sensitive data AND
				// the pre-merge build gate did not fail.
				branch(canMerge, { yes: task(mergeWriter) }),
			]),
		}),
	],
	{ tolerant: true }, // best-effort: a non-setup stage failure is logged, not fatal
);

export const SUPER_DEV_WORKFLOW: Workflow = {
	id: "super-dev",
	description:
		"13-stage development pipeline composed from control-flow nodes: classify → requirements/BDD/research artifact convergence → [debug] → assessment → design → [prototype] → spec/review convergence → implementation (TDD) → verification convergence → verified docs → cleanup → merge.",
	root: pipeline,
};

// Re-exports for users composing custom workflows.
export { task, sequence, branch, gate, loop, parallel, noop, gateValidator } from "../nodes.ts";
export { setupStage } from "./setup.ts";
export {
	classifyStage, cleanupTask, requirementsWriter, bddWriter, researchWriter,
	debugWriter, assessmentWriter, specWriter, specReviewWriter, docsWriter, mergeWriter,
} from "./writers.ts";
export { designStage } from "./design.ts";
export { prototypeStage } from "./prototype.ts";
export { specConvergenceNode } from "./spec-convergence.ts";
export { requirementsConvergenceNode, bddConvergenceNode, researchConvergenceNode, researchComplete } from "./artifact-convergence.ts";
export { implementationStage } from "./implementation.ts";
export type { ControlObj };
