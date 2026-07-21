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
 *   setup ─► classify ─► gate(requirements) ─► gate(bdd) ─► gate(research) ─►
 *   branch[bug]→debug ─► assessment ─► design ─► prototype ─►
 *   gate(spec) ─► gate(specReview) ─► implementation ─►
 *   loop{ code-review = parallel[review,adversarial]→merge + fix } ─►
 *   docs ─► cleanup ─► branch[!blocked]→merge
 */

import { task, sequence, branch, gate, loop, gateValidator, noop } from "../nodes.ts";
import type { ControlObj, PipelineState, Stage, StageContext, Workflow } from "../types.ts";
import { setupStage } from "./setup.ts";
import { classifyStage, cleanupTask, requirementsWriter, bddWriter, researchWriter, debugWriter, assessmentWriter, specWriter, specReviewWriter, docsWriter, mergeWriter } from "./writers.ts";
import { designStage } from "./design.ts";
import { prototypeStage } from "./prototype.ts";
import { runBuildGate, type GateOptions } from "../build-runner.ts";
import { implementationStage } from "./implementation.ts";
import { reviewLoopNode, integrationLoopNode, reviewApproved } from "./verify.ts";

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
		return { pass: r.pass, ran: r.ran, errors: r.errors };
	},
};
/** Merge is conservative (design report §C / audit Findings 1,2,4b): require an
 *  AFFIRMATIVE build-gate pass (not merely "not failed" — a missing result is a
 *  vacuous pass, the asymmetry the audit flagged vs `notBlocked` which correctly
 *  treats missing as blocking), AND implementation completeness (allGreen), AND
 *  review approval. Defense-in-depth: even if the tolerant sequence let a partial
 *  impl reach here, it cannot merge. */
export const canMerge = (s: PipelineState) => {
	if (!notBlocked(s)) return false;
	const impl = s.implementation as { allGreen?: boolean } | undefined;
	if (impl?.allGreen !== true) return false; // completeness gate
	if (!reviewApproved(s)) return false;     // defense-in-depth
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

/** Research is complete ONLY when a report exists AND all open issues are
 *  resolved. The gate retries (attempts:4, feedback-driven) loop the unresolved
 *  issues back into the next research attempt (Deep Research Mode), so the
 *  agent targets each one. Non-fatal exhaustion: if truly unresolvable after 4
 *  attempts, the pipeline proceeds with them documented. */
const researchComplete = async (s: PipelineState, ctx: StageContext) => {
	const r = s.research as { docPath?: string; openIssues?: unknown[] } | undefined;
	if (!r || !r.docPath) {
		ctx.log("Research: no report produced (agent returned nothing or timed out)");
		return { pass: false, errors: ["no research report produced (agent returned nothing or timed out)"] };
	}
	const open = (r.openIssues as unknown[]) ?? [];
	if (open.length > 0) {
		const preview = open.slice(0, 3).map((o) => String(o).slice(0, 80)).join("; ");
		ctx.log(`Research: ${open.length} open issue(s) unresolved — retrying to resolve: ${preview}`);
		return { pass: false, errors: [`${open.length} open issue(s) must be resolved before proceeding: ${open.map((o) => String(o)).join("; ")}`] };
	}
	return { pass: true, errors: [] };
};

/** §D auto-iterate convergence loop (design report §D): re-run implementation
 *  until all phases are green OR the convergence budget is exhausted. Combined
 *  with the per-phase green-state carry in implementation.ts, a re-run SKIPS
 *  already-green phases and re-attempts only the failed one(s), seeded with the
 *  prior iteration's failure reasons. On exhaustion the run halts at the
 *  `hasImplementation`/`canMerge` gates (partial status; resume is the human
 *  recovery). Env-overridable via SUPER_DEV_MAX_CONVERGE_ITERS (default 2). */
const MAX_CONVERGE_ITERS = Math.max(1, Number.parseInt(process.env.SUPER_DEV_MAX_CONVERGE_ITERS ?? "2", 10) || 2);
const implAllGreen = (s: PipelineState) =>
	((s.implementation as { allGreen?: boolean } | undefined)?.allGreen === true);

// ─── Verify (Stage 10): unified review + fix loop ───────────────────────────
// Extracted to src/stages/verify.ts. BOTH reviewers (code-review + adversarial)
// run in parallel → merged verdict → fix loop. Phase 2 adds the api/ui test step
// inside that loop; Phase 3 makes its `until` require tests-green too.

// ─── The pipeline ───────────────────────────────────────────────────────────

const pipeline = sequence(
	[
		task(setupStage),
		task(classifyStage),
		// Quality-gate loops: write → validate → re-write until the gate passes.
		// Retries CONVERGE (the validator's errors are fed into the next attempt's
		// prompt) and exhaustion is NON-FATAL (the pipeline proceeds with the
		// best-available artifact rather than discarding every prior stage's work).
		// Spec review is intentionally NOT gated — its verdict is signal, not a block.
		gate({ validate: gateValidator("gate-requirements", "write-requirements", "requirements"), feedbackKey: "requirements", attempts: 4 }, task(requirementsWriter)),
		gate({ validate: gateValidator("gate-bdd", "write-bdd", "bdd"), feedbackKey: "bdd", attempts: 4 }, task(bddWriter)),
		gate({ validate: researchComplete, feedbackKey: "research", attempts: 4 }, task(researchWriter)),
		// Conditional branch: debug analysis only for bug fixes.
		branch(isBug, { yes: task(debugWriter) }),
		task(assessmentWriter),
		task(designStage),
		task(prototypeStage),
		gate({ validate: gateValidator("gate-spec-trace", "write-spec", "spec"), feedbackKey: "spec", attempts: 4 }, task(specWriter)),
		// Spec review is SIGNAL, not a gate: a "Changes Requested" verdict is a
		// judgment call whose findings flow forward to implementation/code-review.
		// Blocking on it (the old fatal gate) aborted runs on a subjective verdict.
		task(specReviewWriter),
		// §D auto-iterate convergence loop: re-run implementation until allGreen OR
		// MAX_CONVERGE_ITERS exhausted (default 2). The per-phase green-state carry
		// in implementation.ts skips already-green phases each iteration and seeds
		// failed phases with the prior iteration's reasons. Budget-bounded via the
		// while predicate; a throw inside the stage exits the loop (task → failed).
		loop(
			{ while: (s, c) => !implAllGreen(s) && c.budget.check(), times: MAX_CONVERGE_ITERS },
			task(implementationStage),
		),
		// Verify (Stage 10) only runs when implementation actually produced phases;
		// otherwise we'd burn spawns reviewing nothing. verifyNode = review (both
		// code-review + adversarial reviewers → merge) → fix, looped until approved.
		branch(hasImplementation, { yes: sequence([reviewLoopNode, branch(reviewApproved, { yes: integrationLoopNode, no: noop() })]) }),
		task(docsWriter),
		task(cleanupTask),
		// Pre-merge hard build gate (Gap A): don't merge broken code. Best-effort —
		// a failure here skips merge but does not abort (tolerant sequence).
		task(preMergeBuildStage),
		// Conditional branch: merge only if cleanup found no sensitive data AND
		// the pre-merge build gate did not fail.
		branch(canMerge, { yes: task(mergeWriter) }),
	],
	{ tolerant: true }, // best-effort: a non-setup stage failure is logged, not fatal
);

export const SUPER_DEV_WORKFLOW: Workflow = {
	id: "super-dev",
	description:
		"13-stage development pipeline composed from control-flow nodes: classify → requirements → BDD → research → [debug] → assessment → design → [prototype] → spec → spec-review → implementation (TDD) → code review → docs → cleanup → merge.",
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
export { implementationStage } from "./implementation.ts";
export type { ControlObj };
