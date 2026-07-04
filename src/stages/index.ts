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

import { task, sequence, branch, gate, loop, parallel, noop, gateValidator } from "../nodes.ts";
import type { ControlObj, PipelineState, StageContext, Workflow } from "../types.ts";
import { setupStage } from "./setup.ts";
import { classifyStage, cleanupTask, requirementsWriter, bddWriter, researchWriter, debugWriter, assessmentWriter, specWriter, specReviewWriter, docsWriter, mergeWriter } from "./writers.ts";
import { designStage } from "./design.ts";
import { prototypeStage } from "./prototype.ts";
import { implementationStage } from "./implementation.ts";
import { buildCodeReviewPrompt, buildAdversarialPrompt, buildFixPrompt } from "../prompts.ts";

// ─── Predicates ─────────────────────────────────────────────────────────────

const isBug = (s: PipelineState) => s.classify?.taskType === "bug";

/** Merge only when cleanup actually ran AND found nothing blocking. Treating a
 *  missing cleanup result as "safe to merge" is a vacuous pass — cleanup may
 *  simply have failed to produce output. */
const notBlocked = (s: PipelineState) => {
	const c = s.cleanup as { blocked?: boolean } | undefined;
	return !!c && c.blocked !== true;
};

/** Only review when there is actually an implementation to review. */
const hasImplementation = (s: PipelineState) =>
	((s.implementation as { totalPhases?: number } | undefined)?.totalPhases ?? 0) > 0;

/** Research is complete ONLY when it actually produced a report with no open
 *  issues. Treating "no research output" as complete is a vacuous pass — the
 *  agent may have timed out and written nothing (observed in real runs). */
const researchComplete = async (s: PipelineState, ctx: StageContext) => {
	const r = s.research as { docPath?: string; openIssues?: unknown[] } | undefined;
	if (!r || !r.docPath) {
		ctx.log("Research: no report produced (agent returned nothing or timed out)");
		return false;
	}
	const open = (r.openIssues as unknown[]) ?? [];
	if (open.length === 0) return true;
	ctx.log(`Research: ${open.length} open issue(s) remain`);
	return false;
};

/** Code review is approved when the merged verdict is Approved (with or without comments). */
const reviewApproved = (s: PipelineState) => {
	const v = s.review?.verdict as string | undefined;
	return v === "Approved" || v === "Approved with Comments";
};

// ─── Code review: parallel reviewers → merge, in a loop with fixes ──────────

const setupOf = (s: PipelineState) => s.setup!;

const codeReviewNode = loop(
	{ until: reviewApproved, times: 3 },
	sequence([
		// Parallel split + synchronization: two reviewers converge into one merged verdict.
		parallel(
			[
				task({
					id: "codeReview",
					label: "Stage 10a — Code Review",
					async run(s, ctx) {
						if (!ctx.budget.check()) return undefined;
						const r = await ctx.agent({ id: "pipeline.code-review.review", agent: "code-reviewer", prompt: buildCodeReviewPrompt(setupOf(s), s.classify ?? null, ctx.task, s.spec ?? null, s.implementation ?? {}) });
						return r.control ?? {};
					},
				}),
				task({
					id: "adversarialReview",
					label: "Stage 10b — Adversarial Review",
					async run(s, ctx) {
						if (!ctx.budget.check()) return undefined;
						const r = await ctx.agent({ id: "pipeline.code-review.adversarial", agent: "adversarial-reviewer", prompt: buildAdversarialPrompt(setupOf(s), s.classify ?? null, ctx.task, s.spec ?? null, s.implementation ?? {}) });
						return r.control ?? {};
					},
				}),
			],
			{
				into: "review",
				join: async (_results, s, ctx) =>
					(await ctx.helper({ name: "merge-review-verdicts", sources: { "code-review": s.codeReview ?? {}, "adversarial-review": s.adversarialReview ?? {} } })).value,
			},
		),
		// If not approved, address findings before the next review round.
		branch(reviewApproved, {
			yes: noop(),
			no: task({
				id: "reviewFix",
				label: "Stage 10c — Address Review Findings",
				async run(s, ctx) {
					if (!ctx.budget.check()) return undefined;
					const findings = (s.review?.findings as unknown[]) ?? [];
					const r = await ctx.agent({ id: "pipeline.code-review.fix", agent: "implementer", prompt: buildFixPrompt(setupOf(s), s.classify ?? null, findings) });
					return r.control ?? {};
				},
			}),
		}),
	]),
);

// ─── The pipeline ───────────────────────────────────────────────────────────

const pipeline = sequence(
	[
		task(setupStage),
		task(classifyStage),
		// Quality-gate loops: write → validate → re-write until the gate passes.
		// All are fatal: if a gate can't pass in 3 tries, abort honestly rather
		// than limp on to produce a broken/degenerate implementation.
		gate({ validate: gateValidator("gate-requirements", "write-requirements", "requirements"), attempts: 3, fatal: true, fatalMessage: "requirements gate failed after 3 attempts — cannot proceed without requirements" }, task(requirementsWriter)),
		gate({ validate: gateValidator("gate-bdd", "write-bdd", "bdd"), attempts: 3, fatal: true, fatalMessage: "BDD gate failed after 3 attempts — cannot proceed without behavior scenarios" }, task(bddWriter)),
		gate({ validate: researchComplete, attempts: 3, fatal: true, fatalMessage: "research gate failed after 3 attempts — open issues remain" }, task(researchWriter)),
		// Conditional branch: debug analysis only for bug fixes.
		branch(isBug, { yes: task(debugWriter) }),
		task(assessmentWriter),
		task(designStage),
		task(prototypeStage),
		gate({ validate: gateValidator("gate-spec-trace", "write-spec", "spec"), attempts: 3, fatal: true, fatalMessage: "spec gate failed after 3 attempts — no valid phased specification produced" }, task(specWriter)),
		gate({ validate: gateValidator("gate-spec-review", "review-spec", "specReview"), attempts: 3, fatal: true, fatalMessage: "spec review gate failed after 3 attempts — specification rejected" }, task(specReviewWriter)),
		task(implementationStage),
		// Code review only runs when implementation actually produced phases;
		// otherwise we'd burn ~9 spawns reviewing nothing.
		branch(hasImplementation, { yes: codeReviewNode }),
		task(docsWriter),
		task(cleanupTask),
		// Conditional branch: merge only if cleanup found no sensitive data.
		branch(notBlocked, { yes: task(mergeWriter) }),
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
