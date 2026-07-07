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

import { task, sequence, branch, gate, gateValidator } from "../nodes.ts";
import type { ControlObj, PipelineState, Stage, StageContext, Workflow } from "../types.ts";
import { setupStage } from "./setup.ts";
import { classifyStage, cleanupTask, requirementsWriter, bddWriter, researchWriter, debugWriter, assessmentWriter, specWriter, specReviewWriter, docsWriter, mergeWriter } from "./writers.ts";
import { designStage } from "./design.ts";
import { prototypeStage } from "./prototype.ts";
import { runBuildGate } from "../build-runner.ts";
import { implementationStage } from "./implementation.ts";
import { verifyNode } from "./verify.ts";

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
		const r = runBuildGate(setup.worktreePath, { signal: ctx.signal });
		ctx.log(`Pre-merge build-gate ${r.pass ? "PASS" : "FAIL"} (ran: ${r.ran.join(", ") || "no commands"})${r.pass ? "" : " — merge will be skipped"}`);
		return { pass: r.pass, ran: r.ran, errors: r.errors };
	},
};
const canMerge = (s: PipelineState) => {
	if (!notBlocked(s)) return false;
	const b = s.preMergeBuild as { pass?: boolean } | undefined;
	return b?.pass !== false;
};

/** Only review when there is actually an implementation to review. */
const hasImplementation = (s: PipelineState) =>
	((s.implementation as { totalPhases?: number } | undefined)?.totalPhases ?? 0) > 0;

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

/** Code review is approved when the merged verdict is Approved (with or without comments).
 *  (Predicate kept here for any pipeline-level checks; the verify-loop's own
 *  until/fix logic lives in src/stages/verify.ts.) */
const reviewApproved = (s: PipelineState) => {
	const v = s.review?.verdict as string | undefined;
	return v === "Approved" || v === "Approved with Comments";
};

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
		task(implementationStage),
		// Verify (Stage 10) only runs when implementation actually produced phases;
		// otherwise we'd burn spawns reviewing nothing. verifyNode = review (both
		// code-review + adversarial reviewers → merge) → fix, looped until approved.
		branch(hasImplementation, { yes: verifyNode }),
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
