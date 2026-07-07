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
import { buildCodeReviewPrompt, buildAdversarialPrompt, buildFixPrompt, buildApiTestPrompt, buildUiTestPrompt } from "../prompts.ts";
import { runBuildGate } from "../build-runner.ts";
import { withServiceDeps, bringupTask, teardownNode } from "./lifecycle.ts";
import { renderAndWrite } from "../render/render.ts";
import { STAGE_MODELS } from "../render/schemas.ts";
import type { Node, NodeResult, PipelineState, Stage, StageContext } from "../types.ts";

const setupOf = (s: PipelineState) => s.setup!;

/** Review is approved when the MERGED verdict (code + adversarial) is Approved
 *  (with or without comments). */
const reviewApproved = (s: PipelineState) => {
	const v = s.review?.verdict as string | undefined;
	return v === "Approved" || v === "Approved with Comments";
};

/** Coerce a model-returned pass value (often the string "true"/"false") to bool. */
const passTrue = (v: unknown): boolean => typeof v === "boolean" ? v : /^(true|yes|1|pass)$/i.test(String(v ?? "").trim());

/** Tests are green when every test that RAN passed (api and/or ui). A test that
 *  didn't run (non-server, standalone UI, or service not up) is not a failure. */
const testsGreen = (s: PipelineState) => {
	const api = s.apiTest as { pass?: unknown } | undefined;
	const ui = s.uiTest as { pass?: unknown } | undefined;
	if (api && !passTrue(api.pass)) return false;
	if (ui && !passTrue(ui.pass)) return false;
	return true;
};

/** Loop exits only once review is approved AND tests are green. */
const approvedAndGreen = (s: PipelineState) => reviewApproved(s) && testsGreen(s) && buildGreen(s);

/** Build gate: non-service apps have no api/ui tests, so `testsGreen` alone is
 *  vacuously true. The deterministic build/test/typecheck gate gives them a
 *  real convergence signal. A missing result (skipped, e.g. budget) is not a
 *  failure — only an explicit FAIL blocks. */
const buildGreen = (s: PipelineState) => {
	const b = s.buildGate as { pass?: boolean } | undefined;
	return b ? b.pass !== false : true;
};

/** Fix whenever not done — review rejected (findings), a test failed, or the
 *  build gate failed. */
const needsFix = (s: PipelineState) => !reviewApproved(s) || !testsGreen(s) || !buildGreen(s);

/** Parallel split + sync: BOTH reviewers converge into one merged verdict under
 *  `state.review` (verdict + findings + dimensions). */
const reviewStep = parallel(
	[
		task({
			id: "codeReview",
			label: "Stage 10a — Code Review",
			async run(s, ctx) {
				if (!ctx.budget.check()) return undefined;
				const r = await ctx.agent({ id: "pipeline.verify.code-review", agent: "code-reviewer", prompt: buildCodeReviewPrompt(setupOf(s), s.classify ?? null, ctx.task, s.spec ?? null, s.implementation ?? {}), schema: STAGE_MODELS["codeReview"]?.schema });
				renderAndWrite(s.setup!, (m) => ctx.log(m), "codeReview", r.control as Record<string, unknown>);
				return r.control ?? {};
			},
		}),
		task({
			id: "adversarialReview",
			label: "Stage 10b — Adversarial Review",
			async run(s, ctx) {
				if (!ctx.budget.check()) return undefined;
				const r = await ctx.agent({ id: "pipeline.verify.adversarial", agent: "adversarial-reviewer", prompt: buildAdversarialPrompt(setupOf(s), s.classify ?? null, ctx.task, s.spec ?? null, s.implementation ?? {}), schema: STAGE_MODELS["adversarialReview"]?.schema });
				renderAndWrite(s.setup!, (m) => ctx.log(m), "adversarialReview", r.control as Record<string, unknown>);
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
			const r = await ctx.agent({ id: "pipeline.verify.api-test", agent: "api-tester", prompt: buildApiTestPrompt(setupOf(s), s.classify ?? null, s.spec ?? null, api), schema: STAGE_MODELS["apiTest"]?.schema });
			renderAndWrite(s.setup!, (m) => ctx.log(m), "apiTest", r.control as Record<string, unknown>);
			return r.control ?? {};
		},
	}),
);

// ── UI TEST (Phase 2d) ─────────────────────────────────────────────────────
// Drives the running UI (CDP via browser_execute, Playwright fallback) through
// the BDD flows. Guarded: needs the ui service ready, AND — for a fullstack app
// — the api service ready too (the UI is meaningless without its backend).
const uiReady = (s: PipelineState): boolean => {
	const svcs = s.services ?? {};
	if (!svcs.ui?.ready) return false;
	if (svcs.api && !svcs.api.ready) return false; // fullstack: api must be up too
	return true;
};
const uiTestStage: Stage = {
	id: "uiTest",
	label: "Stage 10f — UI Test",
	requires: ["*-specification.md"],
	async run(s, ctx) {
		if (!ctx.budget.check()) return undefined;
		const ui = s.services?.ui;
		if (!ui) return undefined;
		const api = s.services?.api; // present for fullstack
		const r = await ctx.agent({ id: "pipeline.verify.ui-test", agent: "ui-tester", prompt: buildUiTestPrompt(setupOf(s), s.classify ?? null, s.spec ?? null, ui, api), schema: STAGE_MODELS["uiTest"]?.schema });
		renderAndWrite(s.setup!, (m) => ctx.log(m), "uiTest", r.control as Record<string, unknown>);
		return r.control ?? {};
	},
};
const uiTestTaskNode = task(uiTestStage);
export const uiTestStep: Node = {
	kind: "uiTestStep",
	async run(s, ctx) {
		if (ctx.signal?.aborted) return { status: "cancelled" };
		if (!uiReady(s)) {
			const why = !s.services?.ui?.ready ? "ui" : "api (fullstack backend)";
			ctx.log(`verify: skip ui-test — service not ready: ${why}`);
			return { status: "skipped" } satisfies NodeResult;
		}
		return uiTestTaskNode.run(s, ctx);
	},
};

// ── TEST BLOCK (Phase 2c/2d) ────────────────────────────────────────────────
// Runs only when review is APPROVED. bringup starts whatever the app has
// (api/ui); apiTestStep self-skips without a ready api; uiTestStep self-skips
// without a ready ui (+ api for fullstack). teardown always runs (finally).
const testBlock = tryCatch(
	sequence([task(bringupTask), apiTestStep, uiTestStep]),
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
			const testFailures = [
				...(((s.apiTest as { failures?: unknown[] } | undefined)?.failures) ?? []),
				...(((s.uiTest as { failures?: unknown[] } | undefined)?.failures) ?? []),
			];
			const buildErrors = ((s.buildGate as { errors?: string[] } | undefined)?.errors) ?? [];
			const baseFix = buildFixPrompt(setupOf(s), s.classify ?? null, findings, testFailures);
			const fixPrompt = buildErrors.length
				? `${baseFix}\n\n## Build/test gate failures (make these pass)\n${buildErrors.map((e) => `- ${e}`).join("\n")}`
				: baseFix;
			const r = await ctx.agent({ id: "pipeline.verify.fix", agent: "implementer", prompt: fixPrompt });
			return r.control ?? {};
		},
	}),
	no: noop(),
});

/** The unified verify-loop:
 *    REVIEW → (approved? → bringup+apiTest, teardown always) → (needsFix? → FIX) → BUILD-GATE
 *  iterating until approved AND testsGreen AND buildGreen (max 4 rounds, non-fatal). This is the
 *  tight, test-feedback-driven loop: observable test/build results are the convergence
 *  signal alongside the merged review verdict. */
const buildGateStep = task({
	id: "buildGate",
	label: "Stage 10d — Build gate",
	requires: ["*-specification.md"],
	async run(s, ctx) {
		if (!ctx.budget.check()) return undefined;
		const r = runBuildGate(setupOf(s).worktreePath, { signal: ctx.signal });
		if (!r.pass && r.ran.length) ctx.log(`verify build-gate FAIL (ran: ${r.ran.join(", ")}): ${r.errors.join("; ")}`);
		return { pass: r.pass, ran: r.ran, errors: r.errors };
	},
});

// ── STAGNATION DETECTION (Gap 4.6) ───────────────────────────────────────────
// Track the merged review-findings signature across loop iterations. The `loop`
// node evaluates `until` at the TOP of each iteration (against the previous
// body's state), so each until-check records that round's signature and then
// compares: if the SAME non-empty findings set recurs on two consecutive
// checks, the fix step didn't move the needle → break early (non-fatal) instead
// of burning all 4 rounds re-fixing the same thing. Exact-set equality (v1).
export const findingsSignature = (s: PipelineState): string => {
	const findings = (s.review?.findings as Array<Record<string, unknown>> | undefined) ?? [];
	if (findings.length === 0) return "";
	const tuples = findings
		.map((f) => `${String(f.file ?? "")}|${String(f.severity ?? "")}|${String(f.title ?? "")}`)
		.sort();
	return tuples.join("\n");
};

export const loopUntil = async (s: PipelineState, ctx: StageContext): Promise<boolean> => {
	const hist = ((s as Record<string, unknown>).__reviewSignatures as string[] | undefined) ?? [];
	const sig = findingsSignature(s);
	hist.push(sig);
	(s as Record<string, unknown>).__reviewSignatures = hist;
	const stagnant = sig !== "" && hist.length >= 2 && hist[hist.length - 1] === hist[hist.length - 2];
	if (stagnant) {
		const findings = (s.review?.findings as Array<Record<string, unknown>> | undefined) ?? [];
		// Surface a structured stagnation record so the post-run escalation (Gap 4.6′-lite)
		// can write a report and, in interactive mode, ask the user how to proceed.
		(s as Record<string, unknown>).__stagnated = {
			rounds: hist.length,
			verdict: (s.review as { verdict?: string } | undefined)?.verdict,
			findings: findings.slice(0, 12).map((f) => ({ file: f.file ?? null, severity: f.severity ?? null, title: f.title ?? null })),
		};
		ctx.log(`verify-loop: review findings stagnant across 2 consecutive rounds — breaking early (non-fatal; ${hist.length} review rounds run)`);
		return true;
	}
	return approvedAndGreen(s);
};

export const verifyNode = loop(
	{ until: loopUntil, times: 4 },
	sequence([
		reviewStep,
		branch(reviewApproved, { yes: testBlock, no: noop() }),
		fixStep,
		buildGateStep,
	]),
);
