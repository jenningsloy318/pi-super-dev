/**
 * Stage 10 — Verify (unified review + fix loop).
 *
 * This is the home of the verify-loop that hardens the implementation. It keeps
 * BOTH reviewers (code-review + adversarial) running in parallel, merges their
 * verdicts, and — if not approved — sends the merged findings to the implementer
 * to fix, then re-reviews. The loop runs until the merged verdict is Approved
 * (with or without comments) or attempts are exhausted (non-fatal: the pipeline
 * proceeds with the best-available code).
 *
 * Phased rollout of the unified implement → review → test loop:
 *  - Phase 1 (this file): review (both reviewers) → fix.   ← you are here
 *  - Phase 2: insert `testStep` (api-tester for servers, ui-tester/Playwright
 *             for UIs) between review and fix; feed test failures into the fix.
 *  - Phase 3: the loop's `until` becomes (reviewApproved AND testsGreen).
 *
 * Research basis (Anthropic SWE-bench agent + SWE-agent): the high-performing
 * pattern is a tight, test-feedback-driven loop where observable results are the
 * convergence signal. This node expresses that loop in our control-flow algebra.
 */

import { loop, sequence, parallel, branch, noop, task } from "../nodes.ts";
import { buildCodeReviewPrompt, buildAdversarialPrompt, buildFixPrompt } from "../prompts.ts";
import type { PipelineState } from "../types.ts";

const setupOf = (s: PipelineState) => s.setup!;

/** Review is approved when the MERGED verdict (code + adversarial) is Approved
 *  (with or without comments). */
const reviewApproved = (s: PipelineState) => {
	const v = s.review?.verdict as string | undefined;
	return v === "Approved" || v === "Approved with Comments";
};

/** Parallel split + sync: BOTH reviewers converge into one merged verdict under
 *  `state.review` (verdict + findings + dimensions). */
const reviewStep = parallel(
	[
		task({
			id: "codeReview",
			label: "Stage 10a — Code Review",
			async run(s, ctx) {
				if (!ctx.budget.check()) return undefined;
				const r = await ctx.agent({ id: "pipeline.verify.code-review", agent: "code-reviewer", prompt: buildCodeReviewPrompt(setupOf(s), s.classify ?? null, ctx.task, s.spec ?? null, s.implementation ?? {}) });
				return r.control ?? {};
			},
		}),
		task({
			id: "adversarialReview",
			label: "Stage 10b — Adversarial Review",
			async run(s, ctx) {
				if (!ctx.budget.check()) return undefined;
				const r = await ctx.agent({ id: "pipeline.verify.adversarial", agent: "adversarial-reviewer", prompt: buildAdversarialPrompt(setupOf(s), s.classify ?? null, ctx.task, s.spec ?? null, s.implementation ?? {}) });
				return r.control ?? {};
			},
		}),
	],
	{
		into: "review",
		join: async (_results, s, ctx) =>
			(await ctx.helper({ name: "merge-review-verdicts", sources: { "code-review": s.codeReview ?? {}, "adversarial-review": s.adversarialReview ?? {} } })).value,
	},
);

// Phase 2 will define `testStep` here:
//   branch(isServer, { yes: apiTestStep })  +  branch(isUi, { yes: uiTestStep })
// running HTTP CRUD/edge suites against the live server, or Playwright against
// the UI, and returning {pass, failures[]} into state. For now it is absent —
// the sequence below inserts it as a single element when Phase 2 lands.

/** If not approved, address the merged findings before the next review round.
 *  (Phase 2 will also fold test failures into the findings passed here.) */
const fixStep = branch(reviewApproved, {
	yes: noop(),
	no: task({
		id: "reviewFix",
		label: "Stage 10c — Address Review Findings",
		async run(s, ctx) {
			if (!ctx.budget.check()) return undefined;
			const findings = (s.review?.findings as unknown[]) ?? [];
			const r = await ctx.agent({ id: "pipeline.verify.fix", agent: "implementer", prompt: buildFixPrompt(setupOf(s), s.classify ?? null, findings) });
			return r.control ?? {};
		},
	}),
});

/** The unified verify-loop: review (both reviewers → merge) → fix, iterating
 *  until approved. `times: 4` gives convergence room (will also cover test
 *  iterations once Phase 2/3 land). Exhaustion is non-fatal. */
export const verifyNode = loop(
	{ until: reviewApproved, times: 4 },
	sequence([
		reviewStep,
		// ── Phase 2 insertion point: add `testStep` here (api/ui testing) ──
		fixStep,
	]),
);
