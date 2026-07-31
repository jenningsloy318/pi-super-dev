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
import { runBuildGate, type GateOptions } from "../build-runner.ts";
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

export function expectedIntegrationRoles(s: PipelineState): Array<"api" | "ui"> {
	if (Array.isArray(s.integrationExpectedTests)) return s.integrationExpectedTests;
	const roles: Array<"api" | "ui"> = [];
	if (s.services?.api || s.apiTest) roles.push("api");
	if (s.services?.ui || s.uiTest) roles.push("ui");
	return roles;
}

export const integrationTestsGreen = (s: PipelineState) => {
	const roles = expectedIntegrationRoles(s);
	if (roles.length === 0) return false;
	const api = s.apiTest as { pass?: unknown } | undefined;
	const ui = s.uiTest as { pass?: unknown } | undefined;
	if (roles.includes("api") && !passTrue(api?.pass)) return false;
	if (roles.includes("ui") && !passTrue(ui?.pass)) return false;
	return true;
};

const buildGreen = (s: PipelineState) => {
	const b = s.buildGate as { pass?: boolean } | undefined;
	return b?.pass === true;
};

function failedReviewControl(kind: "codeReview" | "adversarialReview", reason: string): Record<string, unknown> {
	const title = kind === "codeReview" ? "Code review did not complete" : "Adversarial review did not complete";
	return {
		title,
		date: new Date().toISOString().slice(0, 10),
		verdict: "Changes Requested",
		summary: reason,
		findings: [{ id: `${kind}-agent-failed`, severity: "high", title, detail: reason }],
	};
}

function validReviewControl(control: unknown): control is Record<string, unknown> {
	return !!control && typeof control === "object" && !Array.isArray(control) && typeof (control as { verdict?: unknown }).verdict === "string";
}

function failedTestControl(kind: "apiTest" | "uiTest", reason: string): Record<string, unknown> {
	return { pass: false, skipped: true, failures: [{ reason }], summary: reason };
}

function resetIntegrationAttemptState(s: PipelineState): void {
	delete s.apiTest;
	delete s.uiTest;
	delete s.services;
	delete s.integrationExpectedTests;
}

function markIntegrationNotApplicable(s: PipelineState, ctx: StageContext): NodeResult {
	s.integration = { pass: true, notApplicable: true, summary: "No API/UI service surface detected for integration testing" };
	ctx.log("Stage 11: no integration-test surface detected — marking integration not applicable");
	return { status: "ok" };
}

function markIntegrationPassed(s: PipelineState, ctx: StageContext, message: string): NodeResult {
	s.integration = { pass: true, summary: message, expected: expectedIntegrationRoles(s) };
	ctx.log(message);
	return { status: "ok" };
}

// ─── shared steps ───────────────────────────────────────────────────────────

/** Both reviewers in parallel → merged verdict under state.review. */
const reviewStep = parallel(
	[
		task({
			id: "codeReview",
			label: "Stage 10a — Code Review",
			async run(s, ctx) {
				if (!ctx.budget.check()) return failedReviewControl("codeReview", "Agent budget exhausted before code review");
				const r = await ctx.agent({ id: "pipeline.verify.code-review", agent: "code-reviewer", prompt: buildCodeReviewPrompt(setupOf(s), s.classify ?? null, ctx.task, s.spec ?? null, s.implementation ?? {}), schema: STAGE_MODELS["codeReview"]?.schema });
				const control = r.error
					? failedReviewControl("codeReview", `code-reviewer failed: ${r.error}`)
					: validReviewControl(r.control)
						? r.control
						: failedReviewControl("codeReview", "code-reviewer produced no valid structured review verdict");
				renderAndWrite(s.setup!, (m) => ctx.log(m), "codeReview", control);
				return control;
			},
		}),
		task({
			id: "adversarialReview",
			label: "Stage 10b — Adversarial Review",
			async run(s, ctx) {
				if (!ctx.budget.check()) return failedReviewControl("adversarialReview", "Agent budget exhausted before adversarial review");
				const r = await ctx.agent({ id: "pipeline.verify.adversarial", agent: "adversarial-reviewer", prompt: buildAdversarialPrompt(setupOf(s), s.classify ?? null, ctx.task, s.spec ?? null, s.implementation ?? {}), schema: STAGE_MODELS["adversarialReview"]?.schema });
				const control = r.error
					? failedReviewControl("adversarialReview", `adversarial-reviewer failed: ${r.error}`)
					: validReviewControl(r.control)
						? r.control
						: failedReviewControl("adversarialReview", "adversarial-reviewer produced no valid structured review verdict");
				renderAndWrite(s.setup!, (m) => ctx.log(m), "adversarialReview", control);
				return control;
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
		const r = runBuildGate(setupOf(s).worktreePath, { gate: (s.spec?.gate) as GateOptions | undefined, signal: ctx.signal });
		if (!r.pass && r.ran.length) ctx.log(`build-gate FAIL (ran: ${r.ran.join(", ")}): ${r.errors.join("; ")}`);
		return { pass: r.pass, ran: r.ran, errors: r.errors };
	},
});

// ─── Stage 10 — Review loop ─────────────────────────────────────────────────

/** Fix review findings and deterministic build failures (Stage 10c). */
const fixStepReview = branch((s: PipelineState) => !reviewApproved(s) || (s.buildGate !== undefined && !buildGreen(s)), {
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
	const approvedAndBuildGreen = reviewApproved(s) && buildGreen(s);
	hist.push(sig);
	(s as Record<string, unknown>).__reviewSignatures = hist;
	const stagnant = sig !== "" && hist.length >= 2 && hist[hist.length - 1] === hist[hist.length - 2];
	if (approvedAndBuildGreen) return true;
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
	return false;
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
			if (!ctx.budget.check()) return failedTestControl("apiTest", "Agent budget exhausted before API testing");
			const api = s.services?.api;
			if (!api) return failedTestControl("apiTest", "API service was expected but is not available");
			const r = await ctx.agent({ id: "pipeline.integration.api-test", agent: "api-tester", prompt: buildApiTestPrompt(setupOf(s), s.classify ?? null, s.spec ?? null, api), schema: STAGE_MODELS["apiTest"]?.schema });
			const control = r.error ? failedTestControl("apiTest", `api-tester failed: ${r.error}`) : ((r.control as Record<string, unknown> | null) ?? failedTestControl("apiTest", "api-tester produced no structured test result"));
			renderAndWrite(s.setup!, (m) => ctx.log(m), "apiTest", control);
			return control;
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
		if (!ctx.budget.check()) return failedTestControl("uiTest", "Agent budget exhausted before UI testing");
		const ui = s.services?.ui;
		if (!ui) return failedTestControl("uiTest", "UI service was expected but is not available");
		const api = s.services?.api;
		const r = await ctx.agent({ id: "pipeline.integration.ui-test", agent: "ui-tester", prompt: buildUiTestPrompt(setupOf(s), s.classify ?? null, s.spec ?? null, ui, api), schema: STAGE_MODELS["uiTest"]?.schema });
		const control = r.error ? failedTestControl("uiTest", `ui-tester failed: ${r.error}`) : ((r.control as Record<string, unknown> | null) ?? failedTestControl("uiTest", "ui-tester produced no structured test result"));
		renderAndWrite(s.setup!, (m) => ctx.log(m), "uiTest", control);
		return control;
	},
});
const uiTestStep: Node = {
	kind: "uiTestStep",
	async run(s, ctx) {
		if (ctx.signal?.aborted) return { status: "cancelled" };
		if (!uiReady(s)) {
			ctx.log(`Stage 11: skip ui-test — service not ready`);
			s.uiTest = failedTestControl("uiTest", "UI service was expected but is not ready");
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
 * Custom node (not loop()) because integrationTestsGreen used to be vacuously true before tests ran —
 * a loop's `until` check would exit immediately. This node runs tests FIRST
 * unconditionally, then loops for retries on failure.
 */
export const integrationLoopNode: Node = {
	kind: "integrationLoop",
	async run(state, ctx) {
		if (ctx.signal?.aborted) return { status: "cancelled" };

		// 1. Initial test run (unconditional).
		ctx.log("Stage 11 — Integration Testing: running initial tests");
		resetIntegrationAttemptState(state);
		const initResult = await testBlock.run(state, ctx);
		if (initResult.status === "cancelled") return initResult;
		if (initResult.status === "failed") {
			state.integration = { pass: false, summary: initResult.error ?? "integration bringup/test block failed" };
			return initResult;
		}
		if (expectedIntegrationRoles(state).length === 0) return markIntegrationNotApplicable(state, ctx);
		if (integrationTestsGreen(state) && reviewApproved(state) && buildGreen(state)) {
			return markIntegrationPassed(state, ctx, "Stage 11: integration passed on first run");
		}

		// 2. Retry loop: fix → re-review → build → re-test (max 2 retries = 3 total).
		for (let attempt = 1; attempt <= 2; attempt++) {
			if (ctx.signal?.aborted) return { status: "cancelled" };
			if (!ctx.budget.check()) {
				state.integration = { pass: false, summary: "Budget exhausted during integration retry" };
				return { status: "failed", error: "budget exhausted during integration retry" };
			}

			ctx.log(`Stage 11: integration retry ${attempt}/2 — fix + re-review + re-test`);

			await fixStepIntegration.run(state, ctx);
			await reviewStep.run(state, ctx);
			await buildGateStep.run(state, ctx);
			resetIntegrationAttemptState(state);
			const retryTestResult = await testBlock.run(state, ctx);
			if (retryTestResult.status === "cancelled") return retryTestResult;
			if (retryTestResult.status === "failed") {
				state.integration = { pass: false, summary: retryTestResult.error ?? "integration bringup/test block failed" };
				return retryTestResult;
			}

			if (expectedIntegrationRoles(state).length === 0) return markIntegrationNotApplicable(state, ctx);
			if (integrationTestsGreen(state) && reviewApproved(state) && buildGreen(state)) {
				return markIntegrationPassed(state, ctx, `Stage 11: integration passed on retry ${attempt}`);
			}
		}

		ctx.log("Stage 11: integration testing max retries exhausted (non-fatal)");
		state.integration = { pass: false, summary: "integration testing max retries exhausted", expected: expectedIntegrationRoles(state) };
		return { status: "failed", error: "integration testing max retries exhausted" };
	},
};
