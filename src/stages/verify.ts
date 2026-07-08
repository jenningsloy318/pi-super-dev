/**
 * Stage 10 — Review (review → fix → re-review loop, max 3).
 * Stage 11 — Integration Testing (test → fix → re-review → re-test loop, max 3).
 *
 * Split from the old combined verify-loop: Stage 10 converges on CODE QUALITY
 * first (no testing until review passes). Stage 11 converges on INTEGRATION
 * (tests run only after review approves; if a fix regresses review, re-review
 * catches it). Each loop is max 3, non-fatal exhaustion.
 *
 * Research basis (SWE-bench agent): tight, feedback-driven loops where
 * observable results are the convergence signal.
 */

import { loop, sequence, parallel, branch, noop, task, tryCatch } from "../nodes.ts";
import { buildCodeReviewPrompt, buildAdversarialPrompt, buildFixPrompt, buildApiTestPrompt, buildUiTestPrompt } from "../prompts.ts";
import { runBuildGate } from "../build-runner.ts";
import { withServiceDeps, bringupTask, teardownNode } from "./lifecycle.ts";
import { renderAndWrite } from "../render/render.ts";
import { STAGE_MODELS } from "../render/schemas.ts";
import type { Node, NodeResult, PipelineState, Stage, StageContext } from "../types.ts";

const setupOf = (s: PipelineState) => s.setup!;

// ─── shared predicates ──────────────────────────────────────────────────────

/** Review is approved when the MERGED verdict is Approved (with or without comments). */
export const reviewApproved = (s: PipelineState) => {
	const v = s.review?.verdict as string | undefined;
	return v === "Approved" || v === "Approved with Comments";
};

const passTrue = (v: unknown): boolean => typeof v === "boolean" ? v : /^(true|yes|1|pass)$/i.test(String(v ?? "").trim());

const testsGreen = (s: PipelineState) => {
	const api = s.apiTest as { pass?: unknown } | undefined;
	const ui = s.uiTest as { pass?: unknown } | undefined;
	if (api && !passTrue(api.pass)) return false;
	if (ui && !passTrue(ui.pass)) return false;
	return true;
};

const buildGreen = (s: PipelineState) => {
	const b = s.buildGate as { pass?: boolean } | undefined;
	return b ? b.pass !== false : true;
};

// ─── shared steps ───────────────────────────────────────────────────────────

/** Both reviewers in parallel → merged verdict under state.review. */
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

/** Build gate (deterministic build/test/typecheck). */
const buildGateStep = task({
	id: "buildGate",
	label: "Build gate",
	requires: ["*-specification.md"],
	async run(s, ctx) {
		if (!ctx.budget.check()) return undefined;
		const r = runBuildGate(setupOf(s).worktreePath, { signal: ctx.signal });
		if (!r.pass && r.ran.length) ctx.log(`build-gate FAIL (ran: ${r.ran.join(", ")}): ${r.errors.join("; ")}`);
		return { pass: r.pass, ran: r.ran, errors: r.errors };
	},
});

// ─── Stage 10 — Review loop ─────────────────────────────────────────────────

/** Fix review findings only (Stage 10c). */
const fixStepReview = branch((s: PipelineState) => !reviewApproved(s), {
	yes: task({
		id: "reviewFix",
		label: "Stage 10c — Address Findings",
		async run(s, ctx) {
			if (!ctx.budget.check()) return undefined;
			const findings = (s.review?.findings as unknown[]) ?? [];
			const buildErrors = ((s.buildGate as { errors?: string[] } | undefined)?.errors) ?? [];
			const baseFix = buildFixPrompt(setupOf(s), s.classify ?? null, findings, []);
			const fixPrompt = buildErrors.length
				? `${baseFix}\n\n## Build/test gate failures (make these pass)\n${buildErrors.map((e) => `- ${e}`).join("\n")}`
				: baseFix;
			const r = await ctx.agent({ id: "pipeline.review.fix", agent: "implementer", prompt: fixPrompt });
			return r.control ?? {};
		},
	}),
	no: noop(),
});

/** Stagnation: same review-findings signature on 2 consecutive rounds → break. */
export const findingsSignature = (s: PipelineState): string => {
	const findings = (s.review?.findings as Array<Record<string, unknown>> | undefined) ?? [];
	if (findings.length === 0) return "";
	return findings.map((f) => `${String(f.file ?? "")}|${String(f.severity ?? "")}|${String(f.title ?? "")}`).sort().join("\n");
};

export const reviewLoopUntil = async (s: PipelineState, ctx: StageContext): Promise<boolean> => {
	const hist = ((s as Record<string, unknown>).__reviewSignatures as string[] | undefined) ?? [];
	const sig = findingsSignature(s);
	hist.push(sig);
	(s as Record<string, unknown>).__reviewSignatures = hist;
	const stagnant = sig !== "" && hist.length >= 2 && hist[hist.length - 1] === hist[hist.length - 2];
	if (stagnant) {
		const findings = (s.review?.findings as Array<Record<string, unknown>> | undefined) ?? [];
		(s as Record<string, unknown>).__stagnated = {
			rounds: hist.length,
			verdict: (s.review as { verdict?: string } | undefined)?.verdict,
			findings: findings.slice(0, 12).map((f) => ({ file: f.file ?? null, severity: f.severity ?? null, title: f.title ?? null })),
		};
		ctx.log(`Stage 10: review findings stagnant across 2 consecutive rounds — breaking early (non-fatal; ${hist.length} rounds)`);
		return true;
	}
	return reviewApproved(s);
};

/** Stage 10 — Review: review → fix → build gate, max 3. */
export const reviewLoopNode = loop(
	{ until: reviewLoopUntil, times: 3 },
	sequence([reviewStep, fixStepReview, buildGateStep]),
);

// ─── Stage 11 — Integration Testing loop ────────────────────────────────────

/** API test (self-skips if no api service). */
const apiTestStep = withServiceDeps(["api"],
	task({
		id: "apiTest",
		label: "Stage 11a — API Testing",
		requires: ["*-specification.md"],
		async run(s, ctx) {
			if (!ctx.budget.check()) return undefined;
			const api = s.services?.api;
			if (!api) return undefined;
			const r = await ctx.agent({ id: "pipeline.integration.api-test", agent: "api-tester", prompt: buildApiTestPrompt(setupOf(s), s.classify ?? null, s.spec ?? null, api), schema: STAGE_MODELS["apiTest"]?.schema });
			renderAndWrite(s.setup!, (m) => ctx.log(m), "apiTest", r.control as Record<string, unknown>);
			return r.control ?? {};
		},
	}),
);

/** UI test (self-skips if no ui service ready). */
const uiReady = (s: PipelineState): boolean => {
	const svcs = s.services ?? {};
	if (!svcs.ui?.ready) return false;
	if (svcs.api && !svcs.api.ready) return false;
	return true;
};
const uiTestTaskNode = task({
	id: "uiTest",
	label: "Stage 11b — UI Testing",
	requires: ["*-specification.md"],
	async run(s, ctx) {
		if (!ctx.budget.check()) return undefined;
		const ui = s.services?.ui;
		if (!ui) return undefined;
		const api = s.services?.api;
		const r = await ctx.agent({ id: "pipeline.integration.ui-test", agent: "ui-tester", prompt: buildUiTestPrompt(setupOf(s), s.classify ?? null, s.spec ?? null, ui, api), schema: STAGE_MODELS["uiTest"]?.schema });
		renderAndWrite(s.setup!, (m) => ctx.log(m), "uiTest", r.control as Record<string, unknown>);
		return r.control ?? {};
	},
});
const uiTestStep: Node = {
	kind: "uiTestStep",
	async run(s, ctx) {
		if (ctx.signal?.aborted) return { status: "cancelled" };
		if (!uiReady(s)) {
			ctx.log(`Stage 11: skip ui-test — service not ready`);
			return { status: "skipped" } satisfies NodeResult;
		}
		return uiTestTaskNode.run(s, ctx);
	},
};

/** Test block: bringup → api test → ui test → teardown (always). */
const testBlock = tryCatch(
	sequence([task(bringupTask), apiTestStep, uiTestStep]),
	{ finally: teardownNode() },
);

/** Fix test failures + any review regression (Stage 11c). */
const fixStepIntegration = task({
	id: "testFix",
	label: "Stage 11c — Address Failures",
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
		const r = await ctx.agent({ id: "pipeline.integration.fix", agent: "implementer", prompt: fixPrompt });
		return r.control ?? {};
	},
});

/**
 * Stage 11 — Integration Testing: test → (fail? fix → re-review → build → re-test), max 3 total.
 *
 * Custom node (not loop()) because testsGreen is vacuously true before tests run —
 * a loop's `until` check would exit immediately. This node runs tests FIRST
 * unconditionally, then loops for retries on failure.
 */
export const integrationLoopNode: Node = {
	kind: "integrationLoop",
	async run(state, ctx) {
		if (ctx.signal?.aborted) return { status: "cancelled" };

		// 1. Initial test run (unconditional).
		ctx.log("Stage 11 — Integration Testing: running initial tests");
		const initResult = await testBlock.run(state, ctx);
		if (initResult.status === "cancelled") return initResult;
		if (testsGreen(state) && reviewApproved(state)) {
			ctx.log("Stage 11: integration passed on first run");
			return { status: "ok" };
		}

		// 2. Retry loop: fix → re-review → build → re-test (max 2 retries = 3 total).
		for (let attempt = 1; attempt <= 2; attempt++) {
			if (ctx.signal?.aborted) return { status: "cancelled" };
			if (!ctx.budget.check()) return { status: "ok" };

			ctx.log(`Stage 11: integration retry ${attempt}/2 — fix + re-review + re-test`);

			await fixStepIntegration.run(state, ctx);
			await reviewStep.run(state, ctx);
			await buildGateStep.run(state, ctx);
			await testBlock.run(state, ctx);

			if (testsGreen(state) && reviewApproved(state)) {
				ctx.log(`Stage 11: integration passed on retry ${attempt}`);
				return { status: "ok" };
			}
		}

		ctx.log("Stage 11: integration testing max retries exhausted (non-fatal)");
		return { status: "ok" };
	},
};
