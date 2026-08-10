/**
 * Stage 10 — Verification Convergence
 * (review → fix → review → integration → fix → review → integration, max 5).
 *
 * The main pipeline uses one convergence state machine so every product fix
 * invalidates downstream evidence: a review/build fix must be reviewed before
 * integration; an integration fix must be reviewed before integration is run
 * again. Success means review + build + integration are fresh on the same code
 * state. The older split review/integration nodes are kept as compatibility
 * exports for direct callers and existing tests.
 *
 * Research basis (SWE-bench agent): tight, feedback-driven loops where
 * observable results are the convergence signal.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loop, sequence, parallel, branch, noop, task, tryCatch, isFatalAbort } from "../nodes.ts";
import { buildCodeReviewPrompt, buildAdversarialPrompt, buildFixPrompt, buildApiTestPrompt, buildUiTestPrompt } from "../prompts.ts";
import { runBuildGate, buildGateCorrelationLine, type GateOptions } from "../build-runner.ts";
import { withServiceDeps, bringupTask, teardownNode } from "./lifecycle.ts";
import { renderAndWrite } from "../render/render.ts";
import { STAGE_MODELS } from "../render/schemas.ts";
import { localTimestamp } from "../render/time.ts";
import { buildRedBoundaryPrompt, classifyObviousRedPath, redBoundaryResultFromAgent, redBoundaryResultFromClassifications, type RedBoundaryResult } from "../test-artifacts.ts";
import { WORKFLOW_ATTEMPTS } from "../retry-policy.ts";
import { renderRetryFeedbackBlock, type RetryFeedback } from "../retry-feedback.ts";
import { recordConvergenceFindings, type ConvergenceOwnerStage } from "../convergence-ledger.ts";
import type { Node, NodeResult, PipelineState, Stage, StageContext } from "../types.ts";

const REVIEW_MAX_ROUNDS = WORKFLOW_ATTEMPTS;
const INTEGRATION_MAX_RETRIES = Math.max(0, WORKFLOW_ATTEMPTS - 1);
const VERIFICATION_MAX_ATTEMPTS = WORKFLOW_ATTEMPTS;

const setupOf = (s: PipelineState) => s.setup!;

export interface VerificationAttemptRecord {
	attempt: number;
	startedAt: string;
	endedAt?: string;
	durationMs?: number;
	reviewVerdict?: string;
	reviewFindings: number;
	buildPass?: boolean;
	buildErrors: number;
	integrationStatus?: IntegrationOutcomeStatus;
	integrationExpected: Array<"api" | "ui">;
	failureSignature: string;
	codeBefore: string;
	codeAfter?: string;
	fixKind?: "review" | "integration";
	fixChanged?: boolean;
	terminal?: boolean;
}

function gitText(cwd: string, args: string[]): string {
	try {
		return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
	} catch {
		return "";
	}
}

function gitStatusPaths(cwd: string): string[] {
	return gitText(cwd, ["status", "--porcelain=v1", "--untracked-files=all"])
		.split("\n")
		.map((line) => line.trimEnd())
		.filter(Boolean)
		.map((line) => {
			const raw = line.slice(3).trim();
			return raw.includes(" -> ") ? raw.split(" -> ").pop()!.trim() : raw;
		})
		.filter(Boolean)
		.sort();
}

function snapshotStatusFiles(s: PipelineState): Map<string, string | null> {
	const cwd = s.setup?.worktreePath;
	const out = new Map<string, string | null>();
	if (!cwd) return out;
	for (const path of gitStatusPaths(cwd)) {
		try { out.set(path, readFileSync(join(cwd, path), "utf8")); }
		catch { out.set(path, null); }
	}
	return out;
}

function changedSinceSnapshot(s: PipelineState, before: Map<string, string | null>): string[] {
	const cwd = s.setup?.worktreePath;
	if (!cwd) return [];
	const paths = new Set([...before.keys(), ...gitStatusPaths(cwd)]);
	const changed: string[] = [];
	for (const path of paths) {
		let next: string | null = null;
		try { next = readFileSync(join(cwd, path), "utf8"); } catch { next = null; }
		if (next !== before.get(path)) changed.push(path);
	}
	return changed.sort();
}

export function workingTreeSignature(s: PipelineState): string {
	const cwd = s.setup?.worktreePath;
	if (!cwd) return "no-worktree";
	const status = gitText(cwd, ["status", "--porcelain=v1", "--untracked-files=all"]);
	const staged = gitText(cwd, ["diff", "--cached", "--binary", "--"]);
	const diff = gitText(cwd, ["diff", "--binary", "--"]);
	return createHash("sha256").update(status).update("\n---staged---\n").update(staged).update("\n---diff---\n").update(diff).digest("hex").slice(0, 16);
}

function ensureVerificationAttempts(s: PipelineState): VerificationAttemptRecord[] {
	const key = "__verificationAttempts";
	const existing = (s as Record<string, unknown>)[key];
	if (Array.isArray(existing)) return existing as VerificationAttemptRecord[];
	const created: VerificationAttemptRecord[] = [];
	(s as Record<string, unknown>)[key] = created;
	return created;
}

function buildErrors(s: PipelineState): string[] {
	return ((s.buildGate as { errors?: string[] } | undefined)?.errors ?? []).filter((e): e is string => typeof e === "string");
}

function summarizeReviewFindings(s: PipelineState, max = 8): string[] {
	const findings = (s.review?.findings as Array<Record<string, unknown>> | undefined) ?? [];
	return findings.slice(0, max).map((f) => {
		const file = String(f.file ?? "").trim();
		const title = String(f.title ?? f.detail ?? "review finding").trim();
		const severity = String(f.severity ?? "medium").trim();
		return `${file ? `${file}: ` : ""}[${severity}] ${title}`;
	});
}

function summarizeTestFailures(s: PipelineState, max = 8): string[] {
	const api = ((s.apiTest as { failures?: Array<Record<string, unknown>> } | undefined)?.failures ?? [])
		.map((f) => ({ role: "api", failure: f }));
	const ui = ((s.uiTest as { failures?: Array<Record<string, unknown>> } | undefined)?.failures ?? [])
		.map((f) => ({ role: "ui", failure: f }));
	return [...api, ...ui].slice(0, max).map(({ role, failure }) => {
		const file = String(failure.file ?? failure.path ?? "").trim();
		const title = String(failure.title ?? failure.reason ?? failure.message ?? JSON.stringify(failure)).trim();
		const method = String(failure.method ?? "").trim();
		const subject = [method, file].filter(Boolean).join(" ");
		return `${role}${subject ? ` ${subject}` : ""}: ${title}`;
	});
}

function ownerForVerificationFailure(lines: string[]): ConvergenceOwnerStage {
	const joined = lines.join("\n");
	if (/requirements?|acceptance\s+criteria|\bAC-\d+\b/i.test(joined)) return "requirements";
	if (/BDD|SCENARIO|scenario/i.test(joined)) return "bdd";
	if (/specification|spec\b|phase|task|deliverable/i.test(joined)) return "spec";
	if (/spawn|ENOENT|EACCES|permission denied|command not found|service unavailable|runner unavailable/i.test(joined)) return "environment";
	return "implementation";
}

function recordVerificationConvergenceFinding(
	s: PipelineState,
	args: { title: string; detail: string; evidence: string[]; sourceGate: string; severity?: string },
): void {
	const evidence = args.evidence.filter(Boolean);
	const ownerStage = ownerForVerificationFailure([args.detail, ...evidence]);
	recordConvergenceFindings(s, {
		detectedAtStage: "verification",
		ownerStage,
		severity: args.severity ?? (ownerStage === "environment" ? "fatal" : "high"),
		blocking: true,
		title: args.title,
		detail: args.detail,
		evidence,
		sourceGate: args.sourceGate,
		recommendation: ownerStage === "implementation"
			? "Use the fresh review/build/integration evidence in the next fix, then re-run review before integration."
			: `Route the blocker to ${ownerStage} before another verification fix attempt.`,
	}, { detectedAtStage: "verification", ownerStage, sourceGate: args.sourceGate });
}

function verificationRetryFeedbackBlock(s: PipelineState, kind: "review" | "integration"): string {
	const feedback: RetryFeedback[] = [];
	const lastFix = (s as Record<string, unknown>).__lastVerificationFix as { kind?: unknown; changed?: unknown; before?: unknown; after?: unknown } | undefined;
	if (lastFix) {
		const changed = lastFix.changed === true;
		feedback.push({
			stage: "verification",
			gate: `previous-${String(lastFix.kind ?? "unknown")}-fix`,
			location: "working tree",
			observed: changed ? "previous fix changed repository state, but fresh gates still rejected the result" : "previous fix made no repository-state change",
			expected: "each retry must make a targeted project change or explicitly prove no code edit is needed from the current evidence",
			diagnostics: [`before=${String(lastFix.before ?? "unknown")} after=${String(lastFix.after ?? "unknown")}`],
			nextAction: "Do not repeat the same fix shape. Use the current gate evidence below to make a different, targeted fix and then run the relevant checks.",
		});
	}
	const reviewFindings = summarizeReviewFindings(s);
	const errors = buildErrors(s).slice(0, 8);
	if (kind === "review" && (reviewFindings.length || errors.length)) {
		feedback.push({
			stage: "verification",
			gate: "review-build-evidence",
			location: "fresh code review and deterministic build gate",
			observed: `review=${String((s.review as { verdict?: unknown } | undefined)?.verdict ?? "unknown")}; build=${buildGreen(s) ? "pass" : "fail"}`,
			expected: "review approved and deterministic build/test gate green",
			missing: [...reviewFindings, ...errors],
			nextAction: "Fix these review/build blockers directly. Avoid unrelated edits and re-run the smallest relevant check before reporting completion.",
		});
	}
	const testFailures = summarizeTestFailures(s);
	if (kind === "integration" && (testFailures.length || reviewFindings.length || errors.length)) {
		const outcome = s.integration as { status?: unknown } | undefined;
		feedback.push({
			stage: "verification",
			gate: "integration-evidence",
			location: "fresh integration test result after review/build green evidence",
			observed: `integration=${String(outcome?.status ?? "failed")}; review=${String((s.review as { verdict?: unknown } | undefined)?.verdict ?? "unknown")}; build=${buildGreen(s) ? "pass" : "fail"}`,
			expected: "integration tests pass after a reviewed, build-green fix",
			missing: [...testFailures, ...reviewFindings, ...errors],
			nextAction: "Fix the failing integration behavior first, then preserve review/build correctness before the next test run.",
		});
	}
	return renderRetryFeedbackBlock(feedback, "Verification retry evidence for this fix");
}

function testFailureCount(s: PipelineState): number {
	return (((s.apiTest as { failures?: unknown[] } | undefined)?.failures) ?? []).length +
		(((s.uiTest as { failures?: unknown[] } | undefined)?.failures) ?? []).length;
}

export function verificationFailureSignature(s: PipelineState): string {
	const parts = [
		`review:${findingsSignature(s)}`,
		`build:${buildErrors(s).slice().sort().join("\n")}`,
		`tests:${testFailuresSignature(s)}`,
		`integration:${String((s.integration as { status?: unknown } | undefined)?.status ?? "none")}`,
		`fixChanged:${String(((s as Record<string, unknown>).__lastVerificationFix as { changed?: unknown } | undefined)?.changed ?? "unknown")}`,
	];
	return parts.join("\n---\n");
}

function verificationFailureCount(s: PipelineState): number {
	const findings = (s.review?.findings as unknown[] | undefined) ?? [];
	const integration = s.integration as { status?: IntegrationOutcomeStatus } | undefined;
	const integrationPenalty = integration?.status && integration.status !== "passed" && integration.status !== "skipped-not-applicable" ? 1 : 0;
	return findings.length + buildErrors(s).length + testFailureCount(s) + integrationPenalty;
}

function recordAttemptEnd(s: PipelineState, record: VerificationAttemptRecord, terminal = false): void {
	record.endedAt = localTimestamp();
	record.durationMs = Date.now() - Date.parse(record.startedAt);
	record.reviewVerdict = String((s.review as { verdict?: unknown } | undefined)?.verdict ?? "");
	record.reviewFindings = ((s.review?.findings as unknown[] | undefined) ?? []).length;
	record.buildPass = (s.buildGate as { pass?: boolean } | undefined)?.pass;
	record.buildErrors = buildErrors(s).length;
	const outcome = s.integration as { status?: IntegrationOutcomeStatus; expected?: Array<"api" | "ui"> } | undefined;
	record.integrationStatus = outcome?.status;
	record.integrationExpected = outcome?.expected ?? expectedIntegrationRoles(s);
	record.failureSignature = verificationFailureSignature(s);
	record.codeAfter = workingTreeSignature(s);
	record.terminal = terminal;
}

function recordVerificationStagnation(s: PipelineState, ctx: StageContext, record: VerificationAttemptRecord): boolean {
	const sigHist = ((s as Record<string, unknown>).__verificationSignatures as string[] | undefined) ?? [];
	const countHist = ((s as Record<string, unknown>).__verificationCounts as number[] | undefined) ?? [];
	(s as Record<string, unknown>).__verificationSignatures = sigHist;
	(s as Record<string, unknown>).__verificationCounts = countHist;
	const count = verificationFailureCount(s);
	if (!detectStagnation(record.failureSignature, count, sigHist, countHist)) return false;
	const findings = ((s.review?.findings as Array<Record<string, unknown>> | undefined) ?? [])
		.slice(0, 12)
		.map((f) => ({ file: f.file ?? null, severity: f.severity ?? null, title: f.title ?? null }));
	(s as Record<string, unknown>).__verificationStagnated = {
		rounds: sigHist.length,
		attempt: record.attempt,
		status: (s.integration as { status?: unknown } | undefined)?.status ?? "review-build",
		signature: record.failureSignature,
		findings,
	};
	// Preserve the existing extension summary/report path, which keys off
	// __stagnated for verify-loop blockers.
	(s as Record<string, unknown>).__stagnated = {
		rounds: sigHist.length,
		verdict: (s.review as { verdict?: string } | undefined)?.verdict,
		findings,
	};
	ctx.log(`Stage 10: verification convergence stagnant across 2 consecutive attempts — stopping before another blind fix (attempt ${record.attempt})`);
	recordVerificationConvergenceFinding(s, {
		title: "Verification convergence stagnant",
		detail: `same verification failure signature repeated at attempt ${record.attempt}`,
		evidence: [...summarizeReviewFindings(s), ...buildErrors(s), ...summarizeTestFailures(s)],
		sourceGate: "stagnation",
	});
	return true;
}

async function runVerificationFix(kind: "review" | "integration", node: Node, state: PipelineState, ctx: StageContext): Promise<NodeResult> {
	const before = workingTreeSignature(state);
	const r = await node.run(state, ctx);
	if (r.status === "cancelled") return r;
	const after = workingTreeSignature(state);
	const changed = before !== after;
	(state as Record<string, unknown>).__lastVerificationFix = { kind, changed, before, after, at: localTimestamp() };
	ctx.log(`Stage 10: ${kind} fix ${changed ? "changed repository state" : "made no repository-state change"} (before=${before} after=${after})`);
	return r;
}

async function resolveIntegrationWriteBoundary(args: { ctx: StageContext; state: PipelineState; changedFiles: string[] }): Promise<RedBoundaryResult> {
	const deterministic = args.changedFiles.map(classifyObviousRedPath);
	const ambiguous = deterministic.filter((item) => item.category === "ambiguous" && !item.allowed).map((item) => item.path);
	if (ambiguous.length === 0) return redBoundaryResultFromClassifications(deterministic);
	try {
		const evaluated = await args.ctx.agent({
			id: "pipeline.integration.write-boundary",
			agent: "red-boundary-classifier",
			controlKeys: ["classifications", "forbiddenFiles", "ambiguousFiles", "allAllowed"],
			prompt: buildRedBoundaryPrompt({
				changedFiles: ambiguous,
				testFiles: [],
				phaseName: "Integration Testing",
				phaseDescription: "API/UI tester agents may create or update test-only support and super-dev report artifacts, but must not modify production implementation while observing behavior.",
				redStatus: "integration-test-observation",
			}),
		});
		const agentResult = redBoundaryResultFromAgent(ambiguous, evaluated.control);
		const byPath = new Map(agentResult.classifications.map((item) => [item.path, item]));
		return redBoundaryResultFromClassifications(deterministic.map((item) => byPath.get(item.path) ?? item));
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return redBoundaryResultFromClassifications(deterministic.map((item) => item.category === "ambiguous" ? { ...item, source: "fallback", confidence: 0, reason: `boundary evaluator failed: ${message}` } : item));
	}
}

async function detectIntegrationWriteViolations(state: PipelineState, ctx: StageContext, before: Map<string, string | null>): Promise<string[]> {
	const changed = changedSinceSnapshot(state, before);
	if (changed.length === 0) return [];
	const boundary = await resolveIntegrationWriteBoundary({ ctx, state, changedFiles: changed });
	ctx.log(`Stage 10: integration write-boundary allAllowed=${boundary.allAllowed} forbidden=${boundary.forbiddenFiles.join(", ") || "none"} ambiguous=${boundary.ambiguousFiles.join(", ") || "none"}`);
	return boundary.forbiddenFiles;
}

// ─── shared predicates ──────────────────────────────────────────────────────

/** Review is approved when the MERGED verdict is Approved (with or without comments). */
export const reviewApproved = (s: PipelineState) => {
	const v = s.review?.verdict as string | undefined;
	return v === "Approved" || v === "Approved with Comments";
};

const passTrue = (v: unknown): boolean => typeof v === "boolean" ? v : /^(true|yes|1|pass)$/i.test(String(v ?? "").trim());

export type IntegrationOutcomeStatus =
	| "passed"
	| "failed"
	| "skipped-not-applicable"
	| "skipped-service-unavailable"
	| "unknown-runner-unavailable";

export interface IntegrationOutcome {
	status: IntegrationOutcomeStatus;
	pass: boolean;
	expected: Array<"api" | "ui">;
	roleStatus: Partial<Record<"api" | "ui", IntegrationOutcomeStatus>>;
	summary: string;
}

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

function roleIntegrationStatus(control: unknown): IntegrationOutcomeStatus {
	if (!control || typeof control !== "object" || Array.isArray(control)) return "unknown-runner-unavailable";
	const c = control as { pass?: unknown; skipped?: unknown; failures?: Array<{ reason?: unknown }> };
	if (passTrue(c.pass)) return "passed";
	const reasonText = (c.failures ?? []).map((f) => String(f?.reason ?? "")).join("\n").toLowerCase();
	if (c.skipped === true && /service|not ready|not available|unavailable/.test(reasonText)) return "skipped-service-unavailable";
	return "failed";
}

export function integrationOutcome(s: PipelineState): IntegrationOutcome {
	const expected = expectedIntegrationRoles(s);
	const roleStatus: Partial<Record<"api" | "ui", IntegrationOutcomeStatus>> = {};
	if (expected.length === 0) {
		return {
			status: "skipped-not-applicable",
			pass: true,
			expected,
			roleStatus,
			summary: "No API/UI service surface detected for integration testing",
		};
	}
	for (const role of expected) {
		roleStatus[role] = roleIntegrationStatus(role === "api" ? s.apiTest : s.uiTest);
	}
	let status: IntegrationOutcomeStatus;
	if (Object.values(roleStatus).every((v) => v === "passed")) status = "passed";
	else if (Object.values(roleStatus).some((v) => v === "failed")) status = "failed";
	else if (Object.values(roleStatus).some((v) => v === "skipped-service-unavailable")) status = "skipped-service-unavailable";
	else status = "unknown-runner-unavailable";
	const pass = status === "passed";
	return {
		status,
		pass,
		expected,
		roleStatus,
		summary: status === "passed" ? "Integration tests passed" : `Integration status: ${status}`,
	};
}

function setIntegrationOutcome(s: PipelineState, summary?: string): IntegrationOutcome {
	const outcome = integrationOutcome(s);
	s.integration = { ...outcome, summary: summary ?? outcome.summary };
	return outcome;
}

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
	const unavailable = /service|not ready|not available|unavailable/i.test(reason);
	return {
		pass: false,
		skipped: unavailable,
		status: unavailable ? "skipped-service-unavailable" : "failed",
		failures: [{ reason }],
		summary: reason,
	};
}

function resetIntegrationAttemptState(s: PipelineState): void {
	delete s.apiTest;
	delete s.uiTest;
	delete s.services;
	delete s.integrationExpectedTests;
}

function markIntegrationNotApplicable(s: PipelineState, ctx: StageContext): NodeResult {
	s.integration = {
		pass: true,
		status: "skipped-not-applicable",
		notApplicable: true,
		expected: [],
		roleStatus: {},
		summary: "No API/UI service surface detected for integration testing",
	};
	ctx.log("Stage 11: no integration-test surface detected — marking integration not applicable (skipped-not-applicable)");
	return { status: "ok" };
}

function markIntegrationPassed(s: PipelineState, ctx: StageContext, message: string): NodeResult {
	const outcome = setIntegrationOutcome(s, message);
	s.integration = { ...s.integration, pass: true, status: "passed", expected: outcome.expected, roleStatus: outcome.roleStatus, summary: message };
	ctx.log(`${message} (status=passed)`);
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
		// AR-02: emit the pi session/model correlation tag to the run trace.
		const corr = buildGateCorrelationLine(r);
		if (corr) ctx.log(corr);
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
			const buildBlock = buildErrors.length
				? `## Build/test gate failures (make these pass)\n${buildErrors.map((e) => `- ${e}`).join("\n")}`
				: "";
			const fixPrompt = [baseFix, buildBlock, verificationRetryFeedbackBlock(s, "review")].filter(Boolean).join("\n\n");
			const r = await ctx.agent({ id: "pipeline.review.fix", agent: "implementer", prompt: fixPrompt });
			return r.control ?? {};
		},
	}),
	no: noop(),
});

/**
 * GAP A: stable, order-independent signature over api+ui test failures
 * (s.apiTest.failures + s.uiTest.failures). Mirrors findingsSignature — an
 * empty failure set yields "" so a passing round never counts as a repeat.
 */
export const testFailuresSignature = (s: PipelineState): string => {
	const api = ((s.apiTest as { failures?: Array<Record<string, unknown>> } | undefined)?.failures) ?? [];
	const ui = ((s.uiTest as { failures?: Array<Record<string, unknown>> } | undefined)?.failures) ?? [];
	const all = [...api, ...ui];
	if (all.length === 0) return "";
	return all.map((f) => `${String(f.file ?? "")}|${String(f.title ?? "")}|${String(f.message ?? "")}`).sort().join("\n");
};

/**
 * GAP C: shared stagnation trigger for both loops. A loop is stagnant when the
 * CURRENT non-empty signature byte-matches the previous round's, OR when the
 * current non-zero finding/failure COUNT fails to decrease (n→n or n→n+1 scope
 * drift). A genuinely converging sequence (5→3→1) never triggers. Callers own
 * the history arrays; this pushes the current round then compares the last two.
 */
const detectStagnation = (sig: string, count: number, sigHist: string[], countHist: number[]): boolean => {
	sigHist.push(sig);
	countHist.push(count);
	const n = sigHist.length;
	if (n < 2) return false;
	if (sig !== "" && sigHist[n - 1] === sigHist[n - 2]) return true; // identical-signature trigger
	const prev = countHist[n - 2];
	const cur = countHist[n - 1];
	if (cur > 0 && prev > 0 && cur >= prev) return true; // non-decreasing-count trigger
	return false;
};

/** Stagnation: same review-findings signature on 2 consecutive rounds → break. */
export const findingsSignature = (s: PipelineState): string => {
	const findings = (s.review?.findings as Array<Record<string, unknown>> | undefined) ?? [];
	if (findings.length === 0) return "";
	return findings.map((f) => `${String(f.file ?? "")}|${String(f.severity ?? "")}|${String(f.title ?? "")}`).sort().join("\n");
};

export const reviewLoopUntil = async (s: PipelineState, ctx: StageContext): Promise<boolean> => {
	const sigHist = ((s as Record<string, unknown>).__reviewSignatures as string[] | undefined) ?? [];
	const countHist = ((s as Record<string, unknown>).__reviewCounts as number[] | undefined) ?? [];
	const findings = (s.review?.findings as Array<Record<string, unknown>> | undefined) ?? [];
	const sig = findingsSignature(s);
	// GAP B/C: successful exit requires review approval AND a green build gate;
	// otherwise identical-signature OR non-decreasing-count triggers stagnation.
	const approvedAndBuildGreen = reviewApproved(s) && buildGreen(s);
	const stagnant = detectStagnation(sig, findings.length, sigHist, countHist);
	(s as Record<string, unknown>).__reviewSignatures = sigHist;
	(s as Record<string, unknown>).__reviewCounts = countHist;
	if (approvedAndBuildGreen) return true;
	if (stagnant) {
		// Defer HITL/background escalation until reviewStageNode performs a final
		// safety re-review of the code that was just fixed. The loop checks `until`
		// before each body run, so escalating here can notify a false blocker while
		// the terminal fixed code has not been reviewed yet.
		(s as Record<string, unknown>).__stagnated = {
			rounds: sigHist.length,
			verdict: (s.review as { verdict?: string } | undefined)?.verdict,
			findings: findings.slice(0, 12).map((f) => ({ file: f.file ?? null, severity: f.severity ?? null, title: f.title ?? null })),
		};
		ctx.log(`Stage 10: review findings stagnant across 2 consecutive rounds — breaking for terminal re-review (non-fatal; ${sigHist.length} rounds)`);
		return true;
	}
	return false;
};

/** Stage 10 — Review: review → fix → build gate, max 5. */
export const reviewLoopNode = loop(
	{ until: reviewLoopUntil, times: REVIEW_MAX_ROUNDS },
	sequence([reviewStep, fixStepReview, buildGateStep]),
);

/**
 * GAP D: the composed Stage 10 node = reviewLoopNode + one final
 * budget-checked reviewStep epilogue on max-round exhaustion OR stagnation.
 * The loop checks `until` before each body run, so a review+fix+build round can
 * leave a stale non-approved review in state immediately after the fix. The
 * epilogue refreshes the terminal fixed code before downstream merge gates read
 * `state.review`; if that final review approves after a stagnation marker, the
 * marker is cleared. No extra fix runs; the epilogue is non-fatal (never
 * throws).
 */
async function finalSafetyReReview(state: PipelineState, ctx: StageContext, reason: "max-rounds" | "stagnation"): Promise<void> {
	const label = reason === "stagnation"
		? "Stage 10: stagnation reached after a fix — final safety re-review (non-fatal)"
		: "Stage 10: max rounds exhausted — final safety re-review (non-fatal)";
	ctx.log(label);
	try {
		await reviewStep.run(state, ctx);
		if (reason === "stagnation" && reviewApproved(state) && buildGreen(state)) {
			delete (state as Record<string, unknown>).__stagnated;
			ctx.log("Stage 10: final safety re-review approved after stagnation; clearing stale stagnation marker");
		}
	} catch (err) {
		// FatalAbort (a nested fatal gate's exhaustion) must propagate to
		// runWorkflow — never be swallowed by this non-fatal epilogue.
		if (isFatalAbort(err)) throw err;
		ctx.log(`Stage 10: final re-review threw (non-fatal) — ${err instanceof Error ? err.message : String(err)}`);
	}
}

async function escalateReviewStagnationIfStillBlocked(state: PipelineState, ctx: StageContext): Promise<import("../types.ts").EscalationDecision | undefined> {
	if (reviewApproved(state)) return undefined;
	const escalate = (ctx as { options?: { escalate?: import("../types.ts").Escalate } }).options?.escalate;
	if (!escalate) return undefined;
	(state as Record<string, unknown>).__escalationAttempted = true;
	try {
		const { runEscalation, applyRetryDecision } = await import("../escalation.ts");
		const setup = (state as { setup?: { worktreePath?: string; specDirectory?: string } }).setup;
		const findings = ((state as Record<string, unknown>).__stagnated as { findings?: Array<{ file?: unknown; severity?: unknown; title?: unknown }> } | undefined)?.findings ?? [];
		const failure: import("../types.ts").EscalationFailure = {
			kind: "stagnation",
			message: "Review loop stagnant after final re-review — the same findings recur and automatic fixes did not converge. Inspect recurring findings or provide explicit retry guidance.",
			severity: "soft",
			findings: findings.slice(0, 12).map((f) => ({ file: String(f.file ?? "") || null, severity: String(f.severity ?? "") || null, title: String(f.title ?? "") || null })),
			worktreePath: setup?.worktreePath,
			specDirectory: setup?.specDirectory,
		};
		const decision = await runEscalation(state, failure, escalate);
		if (decision) applyRetryDecision(state, decision, { worktreePath: setup?.worktreePath, specDirectory: setup?.specDirectory });
		return decision;
	} catch {
		return undefined;
	}
}

export const reviewStageNode: Node = {
	kind: "reviewStage",
	async run(state, ctx) {
		let r = await reviewLoopNode.run(state, ctx);
		if (r.status === "cancelled") return r;
		let stagnated = Boolean((state as Record<string, unknown>).__stagnated);
		if (!reviewApproved(state) && ctx.budget.check()) {
			await finalSafetyReReview(state, ctx, stagnated ? "stagnation" : "max-rounds");
		}
		stagnated = Boolean((state as Record<string, unknown>).__stagnated);
		if (stagnated && !reviewApproved(state)) {
			const decision = await escalateReviewStagnationIfStillBlocked(state, ctx);
			if (decision?.choice === "retry-with-guidance") {
				delete (state as Record<string, unknown>).__stagnated;
				(state as Record<string, unknown>).__reviewSignatures = [];
				(state as Record<string, unknown>).__reviewCounts = [];
				r = await reviewLoopNode.run(state, ctx);
				if (r.status === "cancelled") return r;
				if (!reviewApproved(state) && ctx.budget.check()) {
					await finalSafetyReReview(state, ctx, Boolean((state as Record<string, unknown>).__stagnated) ? "stagnation" : "max-rounds");
				}
			}
		}
		return r;
	},
};

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
// api-test and ui-test hit INDEPENDENT running services, are read-only w.r.t.
// the source tree, and write distinct state keys (apiTest/uiTest) — so they run
// CONCURRENTLY (resume-safe via BUG-1's structural cache keys). `tolerant` so a
// failed branch still lets the other land its result; the integration loop's
// testsGreen already tolerates a missing apiTest/uiTest. bringup stays first
// (sequence), teardown in finally regardless.
const testBlock = tryCatch(
	sequence([task(bringupTask), parallel([apiTestStep, uiTestStep], { tolerant: true })]),
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
		const buildBlock = buildErrors.length
			? `## Build/test gate failures (make these pass)\n${buildErrors.map((e) => `- ${e}`).join("\n")}`
			: "";
		const fixPrompt = [baseFix, buildBlock, verificationRetryFeedbackBlock(s, "integration")].filter(Boolean).join("\n\n");
		const r = await ctx.agent({ id: "pipeline.integration.fix", agent: "implementer", prompt: fixPrompt });
		return r.control ?? {};
	},
});

function inconclusiveIntegrationMessage(outcome: IntegrationOutcome): string {
	if (outcome.status === "skipped-service-unavailable") return "integration service unavailable; stopping without product-code fix";
	if (outcome.status === "unknown-runner-unavailable") return "integration runner unavailable; stopping without product-code fix";
	return `integration did not pass (${outcome.status})`;
}

/**
 * Stage 10 — Verification Convergence.
 *
 * This is the main workflow's review/fix/test convergence state machine:
 * review → fix → review → integration → fix → review → integration. A fix is
 * never terminal evidence; the next attempt must re-run semantic review and the
 * deterministic build gate before integration is allowed to run again.
 */
export const verificationConvergenceNode: Node = {
	kind: "verificationConvergence",
	async run(state, ctx) {
		if (ctx.signal?.aborted) return { status: "cancelled" };
		delete (state as Record<string, unknown>).__verificationStagnated;
		delete (state as Record<string, unknown>).__stagnated;
		delete (state as Record<string, unknown>).__lastVerificationFix;
		(state as Record<string, unknown>).__verificationSignatures = [];
		(state as Record<string, unknown>).__verificationCounts = [];
		const attempts = ensureVerificationAttempts(state);

		for (let attempt = 1; attempt <= VERIFICATION_MAX_ATTEMPTS; attempt++) {
			if (ctx.signal?.aborted) return { status: "cancelled" };
			if (!ctx.budget.check()) {
				state.integration = { pass: false, status: "unknown-runner-unavailable", summary: "Budget exhausted before verification convergence attempt" };
				return { status: "failed", error: "budget exhausted before verification convergence attempt" };
			}
			resetIntegrationAttemptState(state);
			delete state.integration;

			const record: VerificationAttemptRecord = {
				attempt,
				startedAt: localTimestamp(),
				reviewFindings: 0,
				buildErrors: 0,
				integrationExpected: [],
				failureSignature: "",
				codeBefore: workingTreeSignature(state),
			};
			attempts.push(record);
			ctx.log(`Stage 10 — Verification convergence attempt ${attempt}/${VERIFICATION_MAX_ATTEMPTS}: review + build`);

			const reviewResult = await reviewStep.run(state, ctx);
			if (reviewResult.status === "cancelled") return reviewResult;
			const buildResult = await buildGateStep.run(state, ctx);
			if (buildResult.status === "cancelled") return buildResult;

			if (!reviewApproved(state) || !buildGreen(state)) {
				recordAttemptEnd(state, record, attempt >= VERIFICATION_MAX_ATTEMPTS);
				ctx.log(`Stage 10: review/build outcome attempt ${attempt}: review=${String(record.reviewVerdict || "unknown")} build=${record.buildPass === true ? "pass" : "fail"} findings=${record.reviewFindings} buildErrors=${record.buildErrors}`);
				if (recordVerificationStagnation(state, ctx, record)) return { status: "failed", error: "verification convergence stagnant" };
				if (attempt >= VERIFICATION_MAX_ATTEMPTS) {
					ctx.log("Stage 10: verification max attempts exhausted after fresh review/build evidence; no final fix will run without re-review");
					recordVerificationConvergenceFinding(state, {
						title: "Verification review/build max attempts exhausted",
						detail: `review=${String(record.reviewVerdict || "unknown")} build=${record.buildPass === true ? "pass" : "fail"} after ${attempt} attempt(s)`,
						evidence: [...summarizeReviewFindings(state), ...buildErrors(state)],
						sourceGate: "review-build-max-attempts",
					});
					return { status: "failed", error: "verification convergence max attempts exhausted" };
				}
				record.fixKind = "review";
				const fixResult = await runVerificationFix("review", fixStepReview, state, ctx);
				record.fixChanged = ((state as Record<string, unknown>).__lastVerificationFix as { changed?: boolean } | undefined)?.changed;
				if (fixResult.status === "cancelled") return fixResult;
				continue;
			}

			ctx.log(`Stage 10 — Verification convergence attempt ${attempt}/${VERIFICATION_MAX_ATTEMPTS}: integration`);
			const integrationWriteSnapshot = snapshotStatusFiles(state);
			const testResult = await testBlock.run(state, ctx);
			if (testResult.status === "cancelled") return testResult;
			const writeViolations = await detectIntegrationWriteViolations(state, ctx, integrationWriteSnapshot);
			if (writeViolations.length > 0) {
				state.integration = {
					pass: false,
					status: "failed",
					summary: `integration tester modified non-test implementation file(s): ${writeViolations.join(", ")}`,
					expected: expectedIntegrationRoles(state),
					failures: writeViolations.map((file) => ({ file, reason: "integration tester modified repository implementation state" })),
				};
				recordAttemptEnd(state, record, true);
				ctx.log(`Stage 10: integration write-boundary violation — ${writeViolations.join(", ")}; stopping without product-code fix`);
				return { status: "failed", error: "integration tester modified implementation files" };
			}
			if (testResult.status === "failed") {
				state.integration = { pass: false, status: "failed", summary: testResult.error ?? "integration bringup/test block failed", expected: expectedIntegrationRoles(state) };
				recordAttemptEnd(state, record, attempt >= VERIFICATION_MAX_ATTEMPTS);
				if (recordVerificationStagnation(state, ctx, record)) return { status: "failed", error: "verification convergence stagnant" };
				if (attempt >= VERIFICATION_MAX_ATTEMPTS) {
					recordVerificationConvergenceFinding(state, {
						title: "Integration test block failed after max attempts",
						detail: testResult.error ?? "integration bringup/test block failed",
						evidence: summarizeTestFailures(state),
						sourceGate: "integration-test-block",
					});
					return { status: "failed", error: testResult.error ?? "integration bringup/test block failed" };
				}
				record.fixKind = "integration";
				const fixResult = await runVerificationFix("integration", fixStepIntegration, state, ctx);
				record.fixChanged = ((state as Record<string, unknown>).__lastVerificationFix as { changed?: boolean } | undefined)?.changed;
				if (fixResult.status === "cancelled") return fixResult;
				continue;
			}

			if (expectedIntegrationRoles(state).length === 0) {
				const r = markIntegrationNotApplicable(state, ctx);
				recordAttemptEnd(state, record, true);
				ctx.log(`Stage 10: verification converged (review/build green; integration not applicable) in ${attempt} attempt(s)`);
				return r;
			}

			const outcome = setIntegrationOutcome(state);
			recordAttemptEnd(state, record, outcome.status === "passed" || attempt >= VERIFICATION_MAX_ATTEMPTS);
			ctx.log(`Stage 10: integration outcome attempt ${attempt}: ${outcome.status} (expected: ${outcome.expected.join(",") || "none"})`);
			if (outcome.status === "passed" && reviewApproved(state) && buildGreen(state)) {
				return markIntegrationPassed(state, ctx, `Stage 10: verification converged after ${attempt} attempt(s)`);
			}

			if (outcome.status !== "failed") {
				ctx.log(`Stage 10: ${inconclusiveIntegrationMessage(outcome)}`);
				recordVerificationConvergenceFinding(state, {
					title: "Verification integration inconclusive",
					detail: inconclusiveIntegrationMessage(outcome),
					evidence: summarizeTestFailures(state),
					sourceGate: "integration-inconclusive",
				});
				return { status: "failed", error: inconclusiveIntegrationMessage(outcome) };
			}
			if (recordVerificationStagnation(state, ctx, record)) return { status: "failed", error: "verification convergence stagnant" };
			if (attempt >= VERIFICATION_MAX_ATTEMPTS) {
				ctx.log("Stage 10: verification max attempts exhausted after fresh integration evidence; no final fix will run without re-review");
				recordVerificationConvergenceFinding(state, {
					title: "Verification integration max attempts exhausted",
					detail: `integration=${outcome.status} after ${attempt} attempt(s)`,
					evidence: [...summarizeTestFailures(state), ...summarizeReviewFindings(state), ...buildErrors(state)],
					sourceGate: "integration-max-attempts",
				});
				return { status: "failed", error: "verification convergence max attempts exhausted" };
			}

			record.fixKind = "integration";
			const fixResult = await runVerificationFix("integration", fixStepIntegration, state, ctx);
			record.fixChanged = ((state as Record<string, unknown>).__lastVerificationFix as { changed?: boolean } | undefined)?.changed;
			if (fixResult.status === "cancelled") return fixResult;
		}

		recordVerificationConvergenceFinding(state, {
			title: "Verification convergence max attempts exhausted",
			detail: "verification loop reached its attempt cap",
			evidence: [...summarizeTestFailures(state), ...summarizeReviewFindings(state), ...buildErrors(state)],
			sourceGate: "verification-max-attempts",
		});
		return { status: "failed", error: "verification convergence max attempts exhausted" };
	},
};

/**
 * Stage 11 — Integration Testing: test → (fail? fix → re-review → build → re-test), max 5 total.
 *
 * Custom node (not loop()) because integrationTestsGreen used to be vacuously true before tests ran —
 * a loop's `until` check would exit immediately. This node runs tests FIRST
 * unconditionally, then loops for retries on failure.
 */
export const integrationLoopNode: Node = {
	kind: "integrationLoop",
	async run(state, ctx) {
		if (ctx.signal?.aborted) return { status: "cancelled" };

		// GAP A/C: per-round test-failure signature + count history. When the same
		// non-empty failure set repeats (or the failure count fails to decrease)
		// across 2 consecutive rounds, record state.__testStagnated and break early
		// (non-fatal). Mirrors reviewLoopUntil/__stagnated.
		const testSigHist = ((state as Record<string, unknown>).__testSignatures as string[] | undefined) ?? [];
		const testCountHist = ((state as Record<string, unknown>).__testCounts as number[] | undefined) ?? [];
		(state as Record<string, unknown>).__testSignatures = testSigHist;
		(state as Record<string, unknown>).__testCounts = testCountHist;
		const testFailureCount = (s: PipelineState): number =>
			(((s.apiTest as { failures?: unknown[] } | undefined)?.failures) ?? []).length +
			(((s.uiTest as { failures?: unknown[] } | undefined)?.failures) ?? []).length;
		const recordTestStagnation = (): boolean => {
			const sig = testFailuresSignature(state);
			if (!detectStagnation(sig, testFailureCount(state), testSigHist, testCountHist)) return false;
			const failures = [
				...(((state.apiTest as { failures?: Array<Record<string, unknown>> } | undefined)?.failures) ?? []),
				...(((state.uiTest as { failures?: Array<Record<string, unknown>> } | undefined)?.failures) ?? []),
			];
			const outcome = setIntegrationOutcome(state, "integration testing stagnated (non-fatal)");
			(state as Record<string, unknown>).__testStagnated = {
				rounds: testSigHist.length,
				signature: sig,
				status: outcome.status,
				failures: failures.slice(0, 12).map((f) => ({ file: f.file ?? null, title: f.title ?? null, message: f.message ?? null })),
			};
			ctx.log(`Stage 11: test failures stagnant across 2 consecutive rounds — breaking early (non-fatal; ${testSigHist.length} rounds; status=${outcome.status})`);
			return true;
		};

		// 1. Initial test run (unconditional).
		ctx.log("Stage 11 — Integration Testing: running initial tests");
		resetIntegrationAttemptState(state);
		const initResult = await testBlock.run(state, ctx);
		if (initResult.status === "cancelled") return initResult;
		if (initResult.status === "failed") {
			state.integration = { pass: false, status: "failed", summary: initResult.error ?? "integration bringup/test block failed", expected: expectedIntegrationRoles(state) };
			return initResult;
		}
		if (expectedIntegrationRoles(state).length === 0) return markIntegrationNotApplicable(state, ctx);
		const initialOutcome = setIntegrationOutcome(state);
		ctx.log(`Stage 11: integration initial outcome ${initialOutcome.status} (expected: ${initialOutcome.expected.join(",") || "none"})`);
		if (initialOutcome.status === "passed" && reviewApproved(state) && buildGreen(state)) {
			return markIntegrationPassed(state, ctx, "Stage 11: integration passed on first run");
		}
		if (recordTestStagnation()) return { status: "failed", error: "integration testing stagnated (non-fatal)" };

		// 2. Retry loop: fix → re-review → build → re-test (max 4 retries = 5 total).
		for (let attempt = 1; attempt <= INTEGRATION_MAX_RETRIES; attempt++) {
			if (ctx.signal?.aborted) return { status: "cancelled" };
			if (!ctx.budget.check()) {
				state.integration = { pass: false, summary: "Budget exhausted during integration retry" };
				return { status: "failed", error: "budget exhausted during integration retry" };
			}

			ctx.log(`Stage 11: integration retry ${attempt}/${INTEGRATION_MAX_RETRIES} — fix + re-review + re-test`);

			await fixStepIntegration.run(state, ctx);
			await reviewStep.run(state, ctx);
			await buildGateStep.run(state, ctx);
			resetIntegrationAttemptState(state);
			const retryTestResult = await testBlock.run(state, ctx);
			if (retryTestResult.status === "cancelled") return retryTestResult;
			if (retryTestResult.status === "failed") {
				state.integration = { pass: false, status: "failed", summary: retryTestResult.error ?? "integration bringup/test block failed", expected: expectedIntegrationRoles(state) };
				return retryTestResult;
			}

			if (expectedIntegrationRoles(state).length === 0) return markIntegrationNotApplicable(state, ctx);
			const retryOutcome = setIntegrationOutcome(state);
			ctx.log(`Stage 11: integration retry ${attempt} outcome ${retryOutcome.status} (expected: ${retryOutcome.expected.join(",") || "none"})`);
			if (retryOutcome.status === "passed" && reviewApproved(state) && buildGreen(state)) {
				return markIntegrationPassed(state, ctx, `Stage 11: integration passed on retry ${attempt}`);
			}
			if (recordTestStagnation()) return { status: "failed", error: "integration testing stagnated (non-fatal)" };
		}

		ctx.log("Stage 11: integration testing max retries exhausted (non-fatal)");
		const outcome = setIntegrationOutcome(state, "integration testing max retries exhausted");
		state.integration = { ...state.integration, pass: false, status: outcome.status === "passed" ? "failed" : outcome.status, summary: "integration testing max retries exhausted", expected: outcome.expected, roleStatus: outcome.roleStatus };
		return { status: "failed", error: "integration testing max retries exhausted" };
	},
};
