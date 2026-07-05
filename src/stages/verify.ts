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

import { loop, sequence, parallel, branch, noop, task, tryCatch } from "../nodes.ts";
import { buildCodeReviewPrompt, buildAdversarialPrompt, buildFixPrompt, buildApiTestPrompt } from "../prompts.ts";
import { withServiceDeps, bringupTask, teardownNode } from "./lifecycle.ts";
import type { PipelineState } from "../types.ts";

const setupOf = (s: PipelineState) => s.setup!;

/** Review is approved when the MERGED verdict (code + adversarial) is Approved
 *  (with or without comments). */
const reviewApproved = (s: PipelineState) => {
	const v = s.review?.verdict as string | undefined;
	return v === "Approved" || v === "Approved with Comments";
};

/** Coerce a model-returned pass value (often the string "true"/"false") to bool. */
const passTrue = (v: unknown): boolean => typeof v === "boolean" ? v : /^(true|yes|1|pass)$/i.test(String(v ?? "").trim());

/** Tests are green when no test ran (vacuously — non-server, or service not up)
 *  OR the latest api test passed. (ui-test folds in the same way once added.) */
const testsGreen = (s: PipelineState) => {
	const t = s.apiTest as { pass?: unknown } | undefined;
	return !t || passTrue(t.pass);
};

/** Loop exits only once review is approved AND tests are green. */
const approvedAndGreen = (s: PipelineState) => reviewApproved(s) && testsGreen(s);

/** Fix whenever not done — either review rejected (findings) or a test failed. */
const needsFix = (s: PipelineState) => !reviewApproved(s) || !testsGreen(s);

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

// ── API TEST (Phase 2b) ────────────────────────────────────────────────────
// Exercises the running API (CRUD + edge bodies) against the spec. Wrapped in
// withServiceDeps(["api"]) so it SKIPS (with a log) if the api service didn't
// come up — no phantom connection-refused failures. Will be wired into verifyNode
// in Phase 2c inside the review-gated test block (ui-tester lands next).
export const apiTestStep = withServiceDeps(["api"],
	task({
		id: "apiTest",
		label: "Stage 10e — API Test",
		requires: ["*-specification.md"],
		async run(s, ctx) {
			if (!ctx.budget.check()) return undefined;
			const api = s.services?.api;
			if (!api) return undefined;
			const r = await ctx.agent({ id: "pipeline.verify.api-test", agent: "api-tester", prompt: buildApiTestPrompt(setupOf(s), s.classify ?? null, s.spec ?? null, api) });
			return r.control ?? {};
		},
	}),
);

// ── TEST BLOCK (Phase 2c) ───────────────────────────────────────────────────
// Runs only when review is APPROVED (no point starting servers / running suites
// on un-reviewed code). bringup starts whatever the app has (api/ui); apiTestStep
// is guarded by withServiceDeps(["api"]) so it self-skips if the api service didn't
// come up. teardown always runs (tryCatch finally) even if a test throws.
const testBlock = tryCatch(
	sequence([task(bringupTask), apiTestStep]),
	{ finally: teardownNode() },
);

/** Fix: implementer addresses review findings AND api-test failures, then
 *  updates the implementation-summary doc (the review/test docs regenerate on
 *  the next iteration). Gathered feedback keeps the loop converging. */
const fixStep = branch(needsFix, {
	yes: task({
		id: "reviewFix",
		label: "Stage 10c — Address Findings",
		async run(s, ctx) {
			if (!ctx.budget.check()) return undefined;
			const findings = (s.review?.findings as unknown[]) ?? [];
			const testFailures = ((s.apiTest as { failures?: unknown[] } | undefined)?.failures) ?? [];
			const r = await ctx.agent({ id: "pipeline.verify.fix", agent: "implementer", prompt: buildFixPrompt(setupOf(s), s.classify ?? null, findings, testFailures) });
			return r.control ?? {};
		},
	}),
	no: noop(),
});

/** The unified verify-loop:
 *    REVIEW → (approved? → bringup+apiTest, teardown always) → (needsFix? → FIX)
 *  iterating until approved AND testsGreen (max 4 rounds, non-fatal). This is the
 *  tight, test-feedback-driven loop: observable test results are the convergence
 *  signal alongside the merged review verdict. */
export const verifyNode = loop(
	{ until: approvedAndGreen, times: 4 },
	sequence([
		reviewStep,
		branch(reviewApproved, { yes: testBlock, no: noop() }),
		fixStep,
	]),
);
