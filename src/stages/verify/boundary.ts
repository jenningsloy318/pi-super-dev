import { changedSinceSnapshot, workingTreeSignature } from "./evidence.ts";
/** boundary — runVerificationFix + integration write-boundary + outcome predicates. Split from verify.ts at v0.4.17c. */
import { execFileSync } from "node:child_process";
import { superDevEnv } from "../../render/super-dev-dir.ts";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loop, sequence, parallel, branch, noop, task, tryCatch, isFatalAbort } from "../../nodes.ts";
import { buildCodeReviewPrompt, buildAdversarialPrompt, buildTestsReviewPrompt, buildFixPrompt, buildApiTestPrompt, buildUiTestPrompt } from "../../prompts.ts";
import { runBuildGate, buildGateCorrelationLine, type GateOptions } from "../../build-runner.ts";
import { runJudge } from "../judge.ts";
import { toBool } from "../../doc-validators.ts";
import { commitWorktreeChanges, isHarnessBookkeepingPath } from "../../helpers.ts";
import { RouteBackSignal } from "../../routing/router.ts";
import { planInlineRouteBack } from "../../routing/walker.ts";
import { countStageRounds } from "../../resume.ts";
import { appendGateChecked } from "../../runlog.ts";
import { withServiceDeps, bringupTask, teardownNode } from "../lifecycle.ts";
import { renderAndWrite, reserveStageDocs } from "../../render/render.ts";
import { STAGE_MODELS, FileClassifyControlData } from "../../render/schemas.ts";
import { localTimestamp } from "../../render/time.ts";
import { buildRedBoundaryPrompt, classifyObviousRedPath, redBoundaryResultFromAgent, redBoundaryResultFromClassifications, type RedBoundaryResult } from "../../test-artifacts.ts";
import { renderRetryFeedbackBlock, type RetryFeedback } from "../../retry-feedback.ts";
import { persistConvergenceLedger, getConvergenceLedger, recordConvergenceFindings, recordReviewFindingsFromControl, closeAgentFailedFindings, type ConvergenceOwnerStage } from "../../convergence-ledger.ts";
import { inferReviewFindingStatus, reviewFindingBlocks, reviewFindingSeverity } from "../../review-findings.ts";
import type { ControlObj, Node, NodeResult, PipelineState, Stage, StageContext } from "../../types.ts";
/** Runs a verification fix step (review or integration) and records whether it
 *  changed repository state. Exported for F-B tests. When the fix changed the
 *  worktree, the change is committed DETERMINISTICALLY (no LLM): a verification
 *  fix that stays uncommitted is silently lost at merge time — mergeVerifyTask's
 *  dirty-worktree check backstops any commit failure by reporting the merge
 *  unverified. */
export async function runVerificationFix(kind: "review" | "integration", node: Node, state: PipelineState, ctx: StageContext, label?: string): Promise<NodeResult> {
	const before = workingTreeSignature(state);
	const r = await node.run(state, ctx);
	if (r.status === "cancelled") return r;
	const after = workingTreeSignature(state);
	const changed = before !== after;
	(state as Record<string, unknown>).__lastVerificationFix = { kind, changed, before, after, at: localTimestamp() };
	ctx.log(`Stage 10: ${kind} fix ${changed ? "changed repository state" : "made no repository-state change"} (before=${before} after=${after})`);
	if (changed) {
		const message = `fix(verify): address ${kind} findings${label ? ` (${label})` : ""}`;
		// H7 (AC-10): `git add -A` is only allowed in an isolated worktree; with
		// AC-09's fail-closed worktree-add, worktreeCreated === false ⟺ an
		// explicit skipWorktree run (in-place is deliberate) — the only opt-in.
		const commit = commitWorktreeChanges(state.setup?.worktreePath, message, { allowMainCheckout: state.setup?.worktreeCreated !== true });
		if (commit.committed) ctx.log(`Stage 10: deterministically committed the ${kind} fix — "${commit.subject}"`);
		else if (commit.error) ctx.log(`Stage 10: DETERMINISTIC COMMIT FAILED (${commit.error}) — merge verification will reject the dirty worktree`);
		else ctx.log(`Stage 10: ${kind} fix change already committed (clean worktree)`);
	}
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
			accessMode: "source-read-only",
			controlKeys: ["classifications", "forbiddenFiles", "ambiguousFiles", "allAllowed"],
			// v0.3.70 W3: schema-validated control (structured delegation).
			schema: FileClassifyControlData,
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

/** True when `path` is a harness bookkeeping file inside the run's spec
 *  directory (see helpers.ts isHarnessBookkeepingPath). */
function isHarnessBookkeepingFile(s: PipelineState, path: string): boolean {
	return isHarnessBookkeepingPath(s.setup?.specDirectory, path);
}

export async function detectIntegrationWriteViolations(state: PipelineState, ctx: StageContext, before: Map<string, string | null>): Promise<string[]> {
	const allChanged = changedSinceSnapshot(state, before);
	if (allChanged.length === 0) return [];
	const changed = allChanged.filter((p) => !isHarnessBookkeepingFile(state, p));
	if (changed.length < allChanged.length) {
		ctx.log(`Stage 10: integration write-boundary exempting harness bookkeeping: ${allChanged.filter((p) => changed.indexOf(p) === -1).join(", ")}`);
	}
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

// Boolean control drift (run 2026-08-15T13-45-02 postmortem): one canonical
// coercion for LLM-emitted booleans — doc-validators `toBool` (a strict
// superset of the former local `passTrue`: also accepts "y").
const passTrue = toBool;

export type IntegrationOutcomeStatus =
	| "passed"
	| "failed"
	| "skipped-not-applicable"
	| "skipped-service-unavailable"
	| "skipped-static"
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
	// A STATIC tree (index.html, no package.json — run 2026-08-27T12-33-43-088Z)
	// has no dev-server machinery: an unstartable integration server there is a
	// PROPERTY OF THE PROJECT, not failed verification. Classify it skipped-static
	// so Stage 10 can converge on the deterministic gates without lying (a real
	// test FAILURE still outranks the skip).
	const staticSite = s.bringup?.staticSite === true;
	let status: IntegrationOutcomeStatus;
	if (Object.values(roleStatus).every((v) => v === "passed")) status = "passed";
	else if (Object.values(roleStatus).some((v) => v === "failed")) status = "failed";
	else if (Object.values(roleStatus).some((v) => v === "skipped-service-unavailable")) status = staticSite ? "skipped-static" : "skipped-service-unavailable";
	else status = "unknown-runner-unavailable";
	const pass = status === "passed";
	return {
		status,
		pass,
		expected,
		roleStatus,
		summary: status === "passed" ? "Integration tests passed" : status === "skipped-static" ? "Static site — no integration server startable; deterministic suites are the verification" : `Integration status: ${status}`,
	};
}

export function setIntegrationOutcome(s: PipelineState, summary?: string): IntegrationOutcome {
	const outcome = integrationOutcome(s);
	s.integration = { ...outcome, summary: summary ?? outcome.summary };
	return outcome;
}

export const buildGreen = (s: PipelineState) => {
	const b = s.buildGate as { pass?: boolean } | undefined;
	return b?.pass === true;
};

export function failedReviewControl(kind: "codeReview" | "adversarialReview" | "testsReview", reason: string): Record<string, unknown> {
	const title = kind === "codeReview" ? "Code review did not complete" : kind === "testsReview" ? "Tests review did not complete" : "Adversarial review did not complete";
	return {
		title,
		date: localTimestamp().slice(0, 10),
		verdict: "Changes Requested",
		summary: reason,
		// v0.3.79 A3 (spec-25 runs 00-49/13-23/13-43): "3 recurring blockers" that
		// were ALL reviewer infra non-completions masqueraded as content stagnation
		// and burned 18 fix cycles — infra findings never arm the stagnation stop.
		findings: [{ id: `${kind}-agent-failed`, severity: "high", title, detail: reason, infra: true }],
	};
}

export function validReviewControl(control: unknown): control is Record<string, unknown> {
	return !!control && typeof control === "object" && !Array.isArray(control) && typeof (control as { verdict?: unknown }).verdict === "string";
}

export function failedTestControl(kind: "apiTest" | "uiTest", reason: string): Record<string, unknown> {
	const unavailable = /service|not ready|not available|unavailable/i.test(reason);
	return {
		pass: false,
		skipped: unavailable,
		status: unavailable ? "skipped-service-unavailable" : "failed",
		failures: [{ reason }],
		summary: reason,
	};
}

export function resetIntegrationAttemptState(s: PipelineState): void {
	delete s.apiTest;
	delete s.uiTest;
	delete s.services;
	delete s.integrationExpectedTests;
}

export function markIntegrationNotApplicable(s: PipelineState, ctx: StageContext): NodeResult {
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

export function markIntegrationPassed(s: PipelineState, ctx: StageContext, message: string): NodeResult {
	const outcome = setIntegrationOutcome(s, message);
	s.integration = { ...s.integration, pass: true, status: "passed", expected: outcome.expected, roleStatus: outcome.roleStatus, summary: message };
	ctx.log(`${message} (status=passed)`);
	return { status: "ok" };
}

// ─── shared steps ───────────────────────────────────────────────────────────

/**
 * R-2: deterministic gate for the tests/validation review angle. TRUE when the
 * spec declares test work — any phase deliverables with requireTests /
 * requireScenarios entries, or top-level BDD scenarioRefs. Keys ONLY on the
 * structured spec control (no LLM, language-agnostic). NEVER throws.
 */
export function specDeclaresTestDeliverables(spec: unknown): boolean {
	try {
		const sp = (spec ?? {}) as { scenarioRefs?: unknown; phases?: Array<{ deliverables?: { requireTests?: unknown; requireScenarios?: unknown } } | null> };
		const phases = Array.isArray(sp.phases) ? sp.phases : [];
		const anyPhase = phases.some((p) => {
			const d = (p?.deliverables ?? {}) as { requireTests?: unknown; requireScenarios?: unknown };
			const t = Array.isArray(d.requireTests) ? d.requireTests.length : 0;
			const sc = Array.isArray(d.requireScenarios) ? d.requireScenarios.length : 0;
			return t + sc > 0;
		});
		const topScenarios = Array.isArray(sp.scenarioRefs) ? sp.scenarioRefs.length : 0;
		return anyPhase || topScenarios > 0;
	} catch {
		return false;
	}
}
