/**
 * Stage 10 — Verification Convergence
 * (review → fix → review → integration → fix → review → integration).
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
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loop, sequence, parallel, branch, noop, task, tryCatch, isFatalAbort } from "../nodes.ts";
import { buildCodeReviewPrompt, buildAdversarialPrompt, buildTestsReviewPrompt, buildFixPrompt, buildApiTestPrompt, buildUiTestPrompt } from "../prompts.ts";
import { runBuildGate, buildGateCorrelationLine, type GateOptions } from "../build-runner.ts";
import { runJudge } from "./judge.ts";
import { toBool } from "../doc-validators.ts";
import { commitWorktreeChanges, isHarnessBookkeepingPath } from "../helpers.ts";
import { RouteBackSignal } from "../routing/router.ts";
import { planInlineRouteBack } from "../routing/walker.ts";
import { appendGateChecked } from "../runlog.ts";
import { withServiceDeps, bringupTask, teardownNode } from "./lifecycle.ts";
import { renderAndWrite } from "../render/render.ts";
import { STAGE_MODELS } from "../render/schemas.ts";
import { localTimestamp } from "../render/time.ts";
import { buildRedBoundaryPrompt, classifyObviousRedPath, redBoundaryResultFromAgent, redBoundaryResultFromClassifications, type RedBoundaryResult } from "../test-artifacts.ts";
import { renderRetryFeedbackBlock, type RetryFeedback } from "../retry-feedback.ts";
import { recordConvergenceFindings, recordReviewFindingsFromControl, type ConvergenceOwnerStage } from "../convergence-ledger.ts";
import { inferReviewFindingStatus, reviewFindingBlocks, reviewFindingSeverity } from "../review-findings.ts";
import type { ControlObj, Node, NodeResult, PipelineState, Stage, StageContext } from "../types.ts";

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

interface VerificationFailureItem {
	fingerprint: string;
	label: string;
	source: "review" | "build" | "integration";
	file?: string | null;
	severity?: string | null;
	title?: string | null;
}

interface VerificationFailureFingerprintRound {
	attempt: number;
	items: VerificationFailureItem[];
	fixKind?: "review" | "integration";
	fixChanged?: boolean;
	recurringFingerprints?: string[];
}

const VERIFICATION_STAGNATION_CHANGED_FIX_ATTEMPT_FLOOR = 3;

function compactText(value: unknown): string {
	if (value == null) return "";
	if (Array.isArray(value)) return value.map(compactText).filter(Boolean).join("; ");
	if (typeof value === "object") return JSON.stringify(value);
	return String(value).replace(/\s+/g, " ").trim();
}

function shortFingerprint(parts: unknown[]): string {
	return createHash("sha256").update(parts.map((part) => compactText(part).toLowerCase()).join("\n")).digest("hex").slice(0, 16);
}

function currentVerificationFailureItems(s: PipelineState): VerificationFailureItem[] {
	const reviewFindings = ((s.review?.findings as Array<Record<string, unknown>> | undefined) ?? [])
		.filter(reviewFindingBlocks)
		.map((finding, index) => {
			const id = compactText(finding.id);
			const file = compactText(finding.file);
			const line = compactText(finding.line);
			const severity = reviewFindingSeverity(finding);
			const title = compactText(finding.title ?? finding.message) || `review finding ${index + 1}`;
			const detail = compactText(finding.detail);
			const status = inferReviewFindingStatus(finding);
			const identity = id ? ["review-id", id, status, title, detail] : ["review", file, line, severity, title, detail];
			const location = file ? `${file}${line ? `:${line}` : ""}: ` : "";
			return {
				fingerprint: shortFingerprint(identity),
				label: `${location}[${severity}] ${title}`,
				source: "review" as const,
				file: file || null,
				severity,
				title,
			};
		});
	const deterministicBuildErrors = buildErrors(s).map((error, index) => ({
		fingerprint: shortFingerprint(["build", error]),
		label: `build ${index + 1}: ${error}`,
		source: "build" as const,
	}));
	const expectedRoles = new Set(expectedIntegrationRoles(s));
	const integrationFailures = [
		...(expectedRoles.has("api") ? (((s.apiTest as { failures?: Array<Record<string, unknown>> } | undefined)?.failures) ?? []).map((failure) => ({ role: "api", failure })) : []),
		...(expectedRoles.has("ui") ? (((s.uiTest as { failures?: Array<Record<string, unknown>> } | undefined)?.failures) ?? []).map((failure) => ({ role: "ui", failure })) : []),
	].map(({ role, failure }, index) => {
		const method = compactText(failure.method);
		const path = compactText(failure.path ?? failure.file);
		const title = compactText(failure.title ?? failure.reason ?? failure.message) || `integration failure ${index + 1}`;
		return {
			fingerprint: shortFingerprint(["integration", role, method, path, title]),
			label: `${role}${method || path ? ` ${[method, path].filter(Boolean).join(" ")}` : ""}: ${title}`,
			source: "integration" as const,
		};
	});
	const outcome = s.integration as { status?: IntegrationOutcomeStatus; summary?: unknown } | undefined;
	const statusFailure = outcome?.status && outcome.status !== "passed" && outcome.status !== "skipped-not-applicable" && integrationFailures.length === 0
		? [{ fingerprint: shortFingerprint(["integration-status", outcome.status, outcome.summary]), label: `integration status: ${outcome.status}`, source: "integration" as const }]
		: [];
	return [...reviewFindings, ...deterministicBuildErrors, ...integrationFailures, ...statusFailure];
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

function rememberVerificationFailureRound(s: PipelineState, record: VerificationAttemptRecord, items: VerificationFailureItem[]): VerificationFailureFingerprintRound[] {
	const history = ((s as Record<string, unknown>).__verificationFailureFingerprintRounds as VerificationFailureFingerprintRound[] | undefined) ?? [];
	(s as Record<string, unknown>).__verificationFailureFingerprintRounds = history;
	const lastFix = (s as Record<string, unknown>).__lastVerificationFix as { kind?: "review" | "integration"; changed?: boolean } | undefined;
	history.push({ attempt: record.attempt, items, fixKind: lastFix?.kind, fixChanged: lastFix?.changed });
	return history;
}

function recurringVerificationFailures(current: VerificationFailureItem[], previous: VerificationFailureItem[] | undefined): VerificationFailureItem[] {
	if (!previous?.length || current.length === 0) return [];
	const previousFingerprints = new Set(previous.map((item) => item.fingerprint));
	const seen = new Set<string>();
	const recurring: VerificationFailureItem[] = [];
	for (const item of current) {
		if (!previousFingerprints.has(item.fingerprint) || seen.has(item.fingerprint)) continue;
		seen.add(item.fingerprint);
		recurring.push(item);
	}
	return recurring;
}

function recordVerificationReviewFindings(s: PipelineState, ctx: StageContext): void {
	const written = recordReviewFindingsFromControl(s, s.review as ControlObj | undefined, {
		detectedAtStage: "verification",
		ownerStage: "implementation",
		sourceGate: "verification-review",
	});
	if (written.length === 0) return;
	const recurring = written.filter((finding) => finding.blocking && finding.seenCount > 1).length;
	ctx.log(`Stage 10: convergence ledger recorded ${written.length} review finding(s) (${recurring} recurring blocker${recurring === 1 ? "" : "s"})`);
}

function recordVerificationStagnation(s: PipelineState, ctx: StageContext, record: VerificationAttemptRecord): boolean {
	const items = currentVerificationFailureItems(s);
	const history = rememberVerificationFailureRound(s, record, items);
	const previous = history.length >= 2 ? history[history.length - 2] : undefined;
	const recurring = recurringVerificationFailures(items, previous?.items);
	const currentRound = history[history.length - 1];
	currentRound.recurringFingerprints = recurring.map((item) => item.fingerprint);
	const lastFix = (s as Record<string, unknown>).__lastVerificationFix as { kind?: "review" | "integration"; changed?: boolean; before?: unknown; after?: unknown } | undefined;
	if (!lastFix || recurring.length === 0) return false;
	const attemptFloor = lastFix.changed === true ? VERIFICATION_STAGNATION_CHANGED_FIX_ATTEMPT_FLOOR : 2;
	if (record.attempt < attemptFloor) {
		ctx.log(`Stage 10: ${recurring.length} recurring blocker(s) after ${String(lastFix.kind ?? "unknown")} fix, but changed fixes require at least ${attemptFloor} verification attempts before stagnation stop`);
		return false;
	}
	const previousRecurring = previous?.recurringFingerprints ?? [];
	const currentRecurring = currentRound.recurringFingerprints;
	const recurringSetShrank = lastFix.changed === true && previousRecurring.length > 0 && currentRecurring.length < previousRecurring.length;
	if (recurringSetShrank) {
		ctx.log(`Stage 10: recurring blocker set shrank ${previousRecurring.length}->${currentRecurring.length} after ${String(lastFix.kind ?? "unknown")} fix — continuing convergence`);
		return false;
	}
	const findings = ((s.review?.findings as Array<Record<string, unknown>> | undefined) ?? [])
		.slice(0, 12)
		.map((f) => ({ file: f.file ?? null, severity: f.severity ?? null, title: f.title ?? null }));
	const recurringFindings = recurring.map((item) => ({ file: item.file ?? null, severity: item.severity ?? null, title: item.title ?? item.label }));
	(s as Record<string, unknown>).__verificationStagnated = {
		rounds: history.length,
		attempt: record.attempt,
		status: (s.integration as { status?: unknown } | undefined)?.status ?? "review-build",
		signature: record.failureSignature,
		findings,
		recurringBlockers: recurring.map((item) => ({ fingerprint: item.fingerprint, source: item.source, label: item.label })),
	};
	// Preserve the existing extension summary/report path, which keys off
	// __stagnated for verify-loop blockers.
	(s as Record<string, unknown>).__stagnated = {
		rounds: history.length,
		verdict: (s.review as { verdict?: string } | undefined)?.verdict,
		findings: recurringFindings,
	};
	ctx.log(`Stage 10: verification convergence stagnant on ${recurring.length} recurring blocker(s) after ${record.attempt - 1} fix cycle(s) — stopping before another blind fix (attempt ${record.attempt})`);
	recordVerificationConvergenceFinding(s, {
		title: "Verification convergence stagnant",
		detail: `${recurring.length} verification blocker fingerprint(s) recurred after a targeted ${String(lastFix.kind ?? "unknown")} fix at attempt ${record.attempt}`,
		evidence: recurring.map((item) => `${item.source}:${item.fingerprint} ${item.label}`).slice(0, 12),
		sourceGate: "stagnation",
	});
	return true;
}

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

async function detectIntegrationWriteViolations(state: PipelineState, ctx: StageContext, before: Map<string, string | null>): Promise<string[]> {
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

function failedReviewControl(kind: "codeReview" | "adversarialReview" | "testsReview", reason: string): Record<string, unknown> {
	const title = kind === "codeReview" ? "Code review did not complete" : kind === "testsReview" ? "Tests review did not complete" : "Adversarial review did not complete";
	return {
		title,
		date: localTimestamp().slice(0, 10),
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

/** Reviewers in parallel → merged verdict under state.review. Exported for R-2 tests. */
export const reviewStep = parallel(
	[
		task({
			id: "codeReview",
			label: "Stage 10a — Code Review",
			async run(s, ctx) {
				if (!ctx.budget.check()) return failedReviewControl("codeReview", "Agent budget exhausted before code review");
				const r = await ctx.agent({ id: "pipeline.verify.code-review", agent: "code-reviewer", accessMode: "source-read-only", prompt: buildCodeReviewPrompt(setupOf(s), s.classify ?? null, ctx.task, s.spec ?? null, s.implementation ?? {}), schema: STAGE_MODELS["codeReview"]?.schema });
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
				const r = await ctx.agent({ id: "pipeline.verify.adversarial", agent: "adversarial-reviewer", accessMode: "source-read-only", prompt: buildAdversarialPrompt(setupOf(s), s.classify ?? null, ctx.task, s.spec ?? null, s.implementation ?? {}), schema: STAGE_MODELS["adversarialReview"]?.schema });
				const control = r.error
					? failedReviewControl("adversarialReview", `adversarial-reviewer failed: ${r.error}`)
					: validReviewControl(r.control)
						? r.control
						: failedReviewControl("adversarialReview", "adversarial-reviewer produced no valid structured review verdict");
				renderAndWrite(s.setup!, (m) => ctx.log(m), "adversarialReview", control);
				return control;
			},
		}),
		task({
			id: "testsReview",
			label: "Stage 10a2 — Tests & Coverage Review",
			async run(s, ctx) {
				// R-2: the tests/validation angle runs ONLY for spec-declared test work.
				// Returning undefined leaves state.testsReview unset so the merge join
				// excludes this source entirely (no phantom third verdict).
				if (!specDeclaresTestDeliverables(s.spec)) return undefined;
				if (!ctx.budget.check()) return failedReviewControl("testsReview", "Agent budget exhausted before tests review");
				const r = await ctx.agent({ id: "pipeline.verify.tests-review", agent: "code-reviewer", accessMode: "source-read-only", prompt: buildTestsReviewPrompt(setupOf(s), s.classify ?? null, ctx.task, s.spec ?? null, s.implementation ?? {}), schema: STAGE_MODELS["codeReview"]?.schema });
				return r.error
					? failedReviewControl("testsReview", `tests-reviewer failed: ${r.error}`)
					: validReviewControl(r.control)
						? r.control
						: failedReviewControl("testsReview", "tests-reviewer produced no valid structured review verdict");
			},
		}),
	],
	{
		into: "review",
		join: async (_results, s, ctx) => {
			const sources: Record<string, unknown> = { "code-review": s.codeReview ?? {}, "adversarial-review": s.adversarialReview ?? {} };
			const tr = s.testsReview as Record<string, unknown> | undefined;
			if (tr && Object.keys(tr).length > 0) sources["tests-review"] = tr;
			const merged = (await ctx.helper({ name: "merge-review-verdicts", sources })).value as {
				verdict: string;
				findings: unknown[];
				deferredFindings: Array<Record<string, unknown>>;
				dimensionsCovered?: string[];
			};
			// R-5: deterministic finding verification (cheap subset of the
			// verify-before-fix pattern): a fix-now finding citing a `file` that does
			// not exist in the worktree cannot be acted on by the implementer — demote
			// it to the ledger with the reason instead of sending the fixer hunting a
			// fabricated path. Findings WITHOUT a file field are untouched (behavior
			// findings are legitimate). NEVER throws; on any check error the finding
			// stays actionable (fail-open toward the fixer, never toward silence).
			try {
				const wt = setupOf(s).worktreePath;
				const fixNow: unknown[] = [];
				const deferred = [...(merged.deferredFindings ?? [])];
				for (const f of merged.findings ?? []) {
					const o = (f ?? {}) as Record<string, unknown>;
					const rawFile = String(o.file ?? "").trim();
					// Authoritative check is the WORKTREE only (plus absolute paths, which
					// join() passes through). NEVER check the process cwd — the pipeline
					// host's own source tree could contain a same-named relative path and
					// false-verify a fabricated location.
					const rel = rawFile.replace(/^\.\//, "");
					if (rel && !existsSync(join(wt, rel))) {
						deferred.push({ ...o, deferralReason: "unverifiable location (file does not exist)" });
					} else {
						fixNow.push(f);
					}
				}
				return { ...merged, findings: fixNow, deferredFindings: deferred };
			} catch {
				return merged;
			}
		},
	},
);

/** Build gate (deterministic build/test/typecheck). */
const buildGateStep = task({
	id: "buildGate",
	label: "Build gate",
	requires: ["*-specification.md"],
	async run(s, ctx) {
		if (!ctx.budget.check()) return undefined;
		const r = runBuildGate(setupOf(s).worktreePath, { gate: (s.spec?.gate) as GateOptions | undefined, signal: ctx.signal, defaultBranch: setupOf(s).defaultBranch });
		appendGateChecked(s, "build-gate", r, "buildGate");
		if (!r.pass && r.ran.length) ctx.log(`build-gate FAIL (ran: ${r.ran.join(", ")}): ${r.errors.join("; ")}`);
		// AR-02: emit the pi session/model correlation tag to the run trace.
		const corr = buildGateCorrelationLine(r);
		if (corr) ctx.log(corr);
		return { pass: r.pass, ran: r.ran, errors: r.errors };
	},
});

// ─── Stage 10 — Review loop ─────────────────────────────────────────────────

/** Fix review findings and deterministic build failures (Stage 10c). */
const fixStepReview = branch((s: PipelineState) => {
	if (reviewApproved(s) && !(s.buildGate !== undefined && !buildGreen(s))) return false;
	// R-1: run the fixer ONLY when there is actionable work. Post-triage
	// `s.review.findings` carries fix-now items only (open ∧ blocking/high);
	// advisory / needs-human / cross-stage residue lives in deferredFindings and
	// must NOT spawn pointless implementer rounds with an empty work list.
	const findings = (s.review?.findings as unknown[]) ?? [];
	const buildErrors = ((s.buildGate as { errors?: string[] } | undefined)?.errors) ?? [];
	return findings.length > 0 || buildErrors.length > 0;
}, {
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
 * Legacy review/integration stagnation trigger. Count growth is not stagnation:
 * a fresh reviewer can legitimately discover new findings after the previous
 * fix. Only an identical non-empty signature repeated across consecutive rounds
 * is treated as no-progress here; Stage 10's main convergence node uses the
 * richer per-finding recurrence detector above.
 */
const detectStagnation = (sig: string, count: number, sigHist: string[], countHist: number[]): boolean => {
	sigHist.push(sig);
	countHist.push(count);
	const n = sigHist.length;
	if (n < 2) return false;
	return sig !== "" && sigHist[n - 1] === sigHist[n - 2];
};

/**
 * J10-a/J10-b (judge routing layer): one verified diagnosis at the Stage 10
 * break boundaries, surfaced INSIDE __stagnated so the escalation prompt shows
 * WHY the loop stopped — not just that it stopped. The judge never overrides
 * the break itself (routes at these wiring points are diagnosis-only:
 * escalate-now is implied, and nothing reroutes the review loop).
 */
async function judgeStage10Diagnosis(s: PipelineState, ctx: StageContext, scope: string, contextLines: string[]): Promise<{ diagnosis: string; evidence: string } | null> {
	try {
		const out = await runJudge(ctx, {
			scope,
			signature: findingsSignature(s) || String((s.review as { verdict?: string } | undefined)?.verdict ?? "unknown"),
			worktreePath: s.setup?.worktreePath ?? "",
			specDirectory: s.setup?.specDirectory,
			context: contextLines.join("\n"),
			allowedRoutes: ["escalate-now"],
		});
		if ((out.status === "routed" || out.status === "escalate") && out.verdict.diagnosis) {
			return {
				diagnosis: out.verdict.diagnosis,
				evidence: out.verdict.evidence.map((e) => `${e.file}: ${e.quote}`).join(" | "),
			};
		}
	} catch { /* INV-6: judge never becomes a new blocker */ }
	return null;
}

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
	// Capture BEFORE detectStagnation (which pushes the current round into the
	// histories): `roundsCompleted` must count FULL body rounds that already
	// ran, so the dead-state break below can never fire at cold start.
	const roundsCompleted = sigHist.length;
	const stagnant = detectStagnation(sig, findings.length, sigHist, countHist);
	(s as Record<string, unknown>).__reviewSignatures = sigHist;
	(s as Record<string, unknown>).__reviewCounts = countHist;
	if (approvedAndBuildGreen) return true;
	// R-1: not approved but NOTHING actionable remains (post-triage findings
	// empty, build green) — the residue is advisory / needs-human / cross-stage
	// ledger items: decisions no code fixer can make. Break immediately for the
	// terminal re-review → HITL escalation instead of burning implementer
	// rounds on an empty work list.
	const deferredFindings = ((s.review as { deferredFindings?: Array<Record<string, unknown>> } | undefined)?.deferredFindings) ?? [];
	// D5 (AC-20): NO visibility cap — the complete deferred ledger rides in
	// __stagnated so HITL sees every awaiting decision (the [deferred: …]
	// title prefix is kept).
	const deferredVisibility = deferredFindings.map((f) => ({
		file: f.file ?? null,
		severity: f.severity ?? null,
		title: `[deferred: ${String(f.deferralReason ?? "advisory")}] ${String(f.title ?? "")}`,
	}));
	// Liveness (R-5 companion): post-triage findings can be EMPTY because R-5
	// demoted every finding to the ledger (unverifiable locations). With no
	// build-error driver either, two dead-state shapes must break for the human
	// boundary instead of spinning forever (stagnation needs a NON-EMPTY
	// signature, so it can never fire on empty findings):
	//   (a) build gate GREEN — original R-1 shortcut (cold start included: a
	//       green gate can persist from Stage 9; only review approval is
	//       missing, which no implementer round can produce);
	//   (b) build gate ABSENT (buildGateStep precondition-skipped — nothing in
	//       the loop body can ever change state) — only after one full round
	//       proved the reviewers produce nothing actionable (roundsCompleted),
	//       because at cold start `s.review` is simply the pre-loop state.
	const noBuildDriver = buildErrors(s).length === 0;
	const deadState = buildGreen(s) || (s.buildGate === undefined && roundsCompleted > 0);
	if (findings.length === 0 && noBuildDriver && deadState) {
		// J10-b: classify the residue (cross-stage blocker vs advisory noise vs
		// spec contradiction) so the human sees a verified why.
		const judged = await judgeStage10Diagnosis(s, ctx, "stage10.no-actionable", [
			"## Review verdict",
			String((s.review as { verdict?: string } | undefined)?.verdict ?? "unknown"),
			"## Deferred ledger (no code fixer can act on these)",
			...deferredFindings.map((f) => `- [${String(f.deferralReason ?? "advisory")}] ${String(f.severity ?? "")} ${String(f.title ?? "")} (${String(f.file ?? "no file")})`),
			"## Build gate",
			s.buildGate ? `pass=${String((s.buildGate as { pass?: boolean }).pass)} errors=${buildErrors(s).length}` : "absent (precondition-skipped)",
		]);
		(s as Record<string, unknown>).__stagnated = {
			kind: "blocked-on-decisions",
			rounds: sigHist.length,
			verdict: (s.review as { verdict?: string } | undefined)?.verdict,
			findings: [
				...(judged ? [{ file: null, severity: null, title: `judge diagnosis: ${judged.diagnosis.slice(0, 200)}` }] : []),
				...deferredVisibility,
			],
		};
		ctx.log(`Stage 10: review not approved but no actionable findings remain (${deferredFindings.length} deferred)${judged ? ` — judge: ${judged.diagnosis}` : ""} — breaking for human decision (non-fatal; ${sigHist.length} rounds)`);
		return true;
	}
	if (stagnant) {
		// Defer HITL/background escalation until reviewStageNode performs a final
		// safety re-review of the code that was just fixed. The loop checks `until`
		// before each body run, so escalating here can notify a false blocker while
		// the terminal fixed code has not been reviewed yet.
		// J10-a: a verified diagnosis of WHY the fixer cannot converge rides in
		// __stagnated (leading finding) so the escalation prompt explains the
		// stall — recurring findings alone say what, never why.
		const judged = await judgeStage10Diagnosis(s, ctx, "stage10.stagnation", [
			"## Recurring findings (identical signature across consecutive rounds)",
			...findings.map((f) => `- ${String(f.severity ?? "")} ${String(f.title ?? "")} (${String(f.file ?? "no file")}) status=${String(f.status ?? "open")}`),
			"## Deferred ledger",
			...deferredFindings.map((f) => `- [${String(f.deferralReason ?? "advisory")}] ${String(f.title ?? "")}`),
			"## Review verdict",
			String((s.review as { verdict?: string } | undefined)?.verdict ?? "unknown"),
		]);
		(s as Record<string, unknown>).__stagnated = {
			rounds: sigHist.length,
			verdict: (s.review as { verdict?: string } | undefined)?.verdict,
			findings: [
				...(judged ? [{ file: null, severity: null, title: `judge diagnosis: ${judged.diagnosis.slice(0, 200)}` }] : []),
				...findings.map((f) => ({ file: f.file ?? null, severity: f.severity ?? null, title: f.title ?? null })),
				...deferredVisibility,
			],
		};
		ctx.log(`Stage 10: review findings stagnant across 2 consecutive rounds${judged ? ` — judge: ${judged.diagnosis}` : ""} — breaking for terminal re-review (non-fatal; ${sigHist.length} rounds)`);
		return true;
	}
	return false;
};

/** Stage 10 — Review: review → fix → build gate, budget + stagnation bounded. */
export const reviewLoopNode = loop(
	{ while: (_s, ctx) => ctx.budget.check(), until: reviewLoopUntil },
	sequence([reviewStep, fixStepReview, buildGateStep]),
);

/**
 * GAP D: the composed Stage 10 node = reviewLoopNode + one final
 * budget-checked reviewStep epilogue on stagnation.
 * The loop checks `until` before each body run, so a review+fix+build round can
 * leave a stale non-approved review in state immediately after the fix. The
 * epilogue refreshes the terminal fixed code before downstream merge gates read
 * `state.review`; if that final review approves after a stagnation marker, the
 * marker is cleared. No extra fix runs; the epilogue is non-fatal (never
 * throws).
 */
async function finalSafetyReReview(state: PipelineState, ctx: StageContext, reason: "budget" | "stagnation"): Promise<void> {
	const label = reason === "stagnation"
		? "Stage 10: stagnation reached after a fix — final safety re-review (non-fatal)"
		: "Stage 10: budget still allows a final safety re-review (non-fatal)";
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
		// F-C: the failure kind decides the message. A dead-state break (all
		// findings deferred — advisory / needs-human / cross-stage) is NOT a
		// recurrence and must never tell the human to "fix the implementation":
		// no code fixer is allowed to act on these items.
		const stagKind = ((state as Record<string, unknown>).__stagnated as { kind?: string } | undefined)?.kind;
		const failure: import("../types.ts").EscalationFailure = {
			kind: "stagnation",
			message: stagKind === "blocked-on-decisions"
				? "Review stopped without actionable findings: every remaining finding is deferred (advisory / needs-human / cross-stage) — no code fixer may act on them. Awaiting human decision: accept the deferred items as known limitations, resolve them manually, or revise the owning upstream artifact and rerun."
				: "Review loop stagnant after final re-review — the same findings recur and automatic fixes did not converge. Inspect recurring findings or provide explicit retry guidance.",
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
			await finalSafetyReReview(state, ctx, stagnated ? "stagnation" : "budget");
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
					await finalSafetyReReview(state, ctx, Boolean((state as Record<string, unknown>).__stagnated) ? "stagnation" : "budget");
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
			const r = await ctx.agent({ id: "pipeline.integration.api-test", agent: "api-tester", accessMode: "source-read-only", prompt: buildApiTestPrompt(setupOf(s), s.classify ?? null, s.spec ?? null, api), schema: STAGE_MODELS["apiTest"]?.schema });
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
		const r = await ctx.agent({ id: "pipeline.integration.ui-test", agent: "ui-tester", accessMode: "source-read-only", prompt: buildUiTestPrompt(setupOf(s), s.classify ?? null, s.spec ?? null, ui, api), schema: STAGE_MODELS["uiTest"]?.schema });
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
		(state as Record<string, unknown>).__verificationFailureFingerprintRounds = [];
		const attempts = ensureVerificationAttempts(state);

		let lastAttempt = 0;
		for (let attempt = 1; ctx.budget.check(); attempt++) {
			lastAttempt = attempt;
			if (ctx.signal?.aborted) return { status: "cancelled" };
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
			ctx.log(`Stage 10 — Verification convergence attempt ${attempt}: review + build`);

			const reviewResult = await reviewStep.run(state, ctx);
			if (reviewResult.status === "cancelled") return reviewResult;
			recordVerificationReviewFindings(state, ctx);
			const buildResult = await buildGateStep.run(state, ctx);
			if (buildResult.status === "cancelled") return buildResult;

			if (!reviewApproved(state) || !buildGreen(state)) {
				recordAttemptEnd(state, record, false);
				ctx.log(`Stage 10: review/build outcome attempt ${attempt}: review=${String(record.reviewVerdict || "unknown")} build=${record.buildPass === true ? "pass" : "fail"} findings=${record.reviewFindings} buildErrors=${record.buildErrors}`);
				// Liveness (R-5 companion): all findings demoted to the ledger +
				// no build errors + gate absent/green → nothing in this loop can
				// change state (fixer has no work, stagnation needs non-empty
				// items). Stop for the human boundary instead of spinning forever.
				if (!reviewApproved(state) && record.reviewFindings === 0 && record.buildErrors === 0 && (state.buildGate === undefined || buildGreen(state))) {
					const deferred = ((state.review as { deferredFindings?: Array<Record<string, unknown>> } | undefined)?.deferredFindings) ?? [];
					// R3 (dsh-09 v3): before falling to the human boundary, try routing the
					// residue back to its OWNING stages — a bounded replan restart re-runs
					// the owning convergence loops and everything downstream they
					// invalidate. When nothing is routable or the budget is exhausted this
					// returns false and today's honest blocked-on-decisions path runs.
					// M4: inline-first — deferred findings carry ownerStage (cross-stage
					// ownership is exactly why they were deferred), so the shared
					// planner can jump instead of restarting the process. Exactly one
					// routable strictly-upstream owner + edge budget → RouteBackSignal
					// for the walker (verify needs no addressable id: the TARGET is the
					// owner). The replan emulation stays the multi-owner/kill-switch/
					// budget-exhausted fallback.
					const inlineCmd = planInlineRouteBack(state.setup?.specDirectory, "verify", deferred);
					if (inlineCmd) {
						// Review round-1 M4-H1: the walker's MP1 protocol injects LEDGER
						// findings matched by cmd.findingIds — deferred findings live only
						// in state.review.deferredFindings. Record them FIRST so the
						// owner's round 1 carries them (and the walker's decline fallback
						// finds them too); without this the owner re-enters BLIND.
						recordConvergenceFindings(state, deferred
							.filter((f) => typeof f.id === "string" && inlineCmd.findingIds.includes(f.id as string))
							.map((f) => ({
								id: String(f.id),
								ownerStage: typeof f.ownerStage === "string" ? f.ownerStage : inlineCmd.to,
								title: String(f.title ?? "deferred finding"),
								detail: String(f.detail ?? f.deferralReason ?? "cross-stage deferred finding"),
								severity: typeof f.severity === "string" ? f.severity : "medium",
								evidence: Array.isArray((f as { evidence?: unknown }).evidence) ? ((f as { evidence: unknown[] }).evidence as unknown[]).map(String) : [],
								recommendation: String((f as { recommendation?: unknown }).recommendation ?? "revise the owning artifact"),
								blocking: true,
							})), { detectedAtStage: "verify", ownerStage: inlineCmd.to, sourceGate: "verify-deferred" });
						ctx.log(`Stage 10: INLINE route-back ${inlineCmd.from}→${inlineCmd.to} for ${inlineCmd.findingIds.length} deferred finding(s) (budget checked; recorded to the ledger for round-1 injection) — throwing RouteBackSignal for the walker`);
						throw new RouteBackSignal(inlineCmd);
					}
					// M5: the emulation is retired for routing — a declined inline
					// plan (multi-owner / kill-switch / budget / OWNER-LESS residue)
					// lands on the honest blocked-on-decisions human boundary below
					// instead of an automatic process restart. (Disposition: deferred
					// findings WITHOUT ownerStage could once be resolved by the replan
					// LEAD (the deleted verify wrapper); M5 narrows routing to structured
					// owners — owner-less residue is surfaced to the human boundary
					// where the [deferred: …] titles carry it; the lead remains
					// reachable from the RED-site exception and genuine resume.)
					(state as Record<string, unknown>).__stagnated = {
						kind: "blocked-on-decisions",
						rounds: attempts.length,
						verdict: (state.review as { verdict?: string } | undefined)?.verdict,
						// D5 (AC-20): the COMPLETE deferred list — no slice(0, 6) cap.
						findings: deferred.map((f) => ({ file: f.file ?? null, severity: f.severity ?? null, title: `[deferred: ${String(f.deferralReason ?? "advisory")}] ${String(f.title ?? "")}` })),
					};
					ctx.log(`Stage 10: no actionable findings remain after triage (${deferred.length} deferred) and no build driver — stopping for human decision (non-fatal; attempt ${attempt})`);
					return { status: "ok" };
				}
				if (recordVerificationStagnation(state, ctx, record)) return { status: "failed", error: "verification convergence stagnant" };
				if (!ctx.budget.check()) {
					record.terminal = true;
					ctx.log("Stage 10: verification budget exhausted after fresh review/build evidence; no final fix will run without re-review");
					recordVerificationConvergenceFinding(state, {
						title: "Verification review/build budget exhausted",
						detail: `review=${String(record.reviewVerdict || "unknown")} build=${record.buildPass === true ? "pass" : "fail"} after ${attempt} attempt(s)`,
						evidence: [...summarizeReviewFindings(state), ...buildErrors(state)],
						sourceGate: "review-build-budget",
					});
					return { status: "failed", error: "verification convergence budget exhausted" };
				}
				record.fixKind = "review";
				const fixResult = await runVerificationFix("review", fixStepReview, state, ctx, `round ${attempt}`);
				record.fixChanged = ((state as Record<string, unknown>).__lastVerificationFix as { changed?: boolean } | undefined)?.changed;
				if (fixResult.status === "cancelled") return fixResult;
				continue;
			}

			ctx.log(`Stage 10 — Verification convergence attempt ${attempt}: integration`);
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
				recordAttemptEnd(state, record, false);
				if (recordVerificationStagnation(state, ctx, record)) return { status: "failed", error: "verification convergence stagnant" };
				if (!ctx.budget.check()) {
					record.terminal = true;
					recordVerificationConvergenceFinding(state, {
						title: "Integration test block failed after budget exhaustion",
						detail: testResult.error ?? "integration bringup/test block failed",
						evidence: summarizeTestFailures(state),
						sourceGate: "integration-test-block",
					});
					return { status: "failed", error: testResult.error ?? "integration bringup/test block failed" };
				}
				record.fixKind = "integration";
				const fixResult = await runVerificationFix("integration", fixStepIntegration, state, ctx, `round ${attempt}`);
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
			recordAttemptEnd(state, record, outcome.status === "passed");
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
			if (!ctx.budget.check()) {
				record.terminal = true;
				ctx.log("Stage 10: verification budget exhausted after fresh integration evidence; no final fix will run without re-review");
				recordVerificationConvergenceFinding(state, {
					title: "Verification integration budget exhausted",
					detail: `integration=${outcome.status} after ${attempt} attempt(s)`,
					evidence: [...summarizeTestFailures(state), ...summarizeReviewFindings(state), ...buildErrors(state)],
					sourceGate: "integration-budget",
				});
				return { status: "failed", error: "verification convergence budget exhausted" };
			}

			record.fixKind = "integration";
			const fixResult = await runVerificationFix("integration", fixStepIntegration, state, ctx, `round ${attempt}`);
			record.fixChanged = ((state as Record<string, unknown>).__lastVerificationFix as { changed?: boolean } | undefined)?.changed;
			if (fixResult.status === "cancelled") return fixResult;
		}

		recordVerificationConvergenceFinding(state, {
			title: "Verification convergence budget exhausted",
			detail: `verification loop exhausted the global agent budget after ${lastAttempt} attempt(s)`,
			evidence: [...summarizeTestFailures(state), ...summarizeReviewFindings(state), ...buildErrors(state)],
			sourceGate: "verification-budget",
		});
		state.integration = { pass: false, status: "unknown-runner-unavailable", summary: "Budget exhausted before verification convergence attempt" };
		return { status: "failed", error: "verification convergence budget exhausted" };
	},
};

/**
 * Stage 11 — Integration Testing: test → (fail? fix → re-review → build → re-test),
 * bounded by the global budget and repeated test-failure stagnation.
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

		// 2. Retry loop: fix → re-review → build → re-test.
		let retryAttempts = 0;
		for (let attempt = 1; ctx.budget.check(); attempt++) {
			retryAttempts = attempt;
			if (ctx.signal?.aborted) return { status: "cancelled" };

			ctx.log(`Stage 11: integration retry ${attempt} — fix + re-review + re-test`);

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

		ctx.log(`Stage 11: integration testing budget exhausted after ${retryAttempts} retry attempt(s) (non-fatal)`);
		const outcome = setIntegrationOutcome(state, "integration testing budget exhausted");
		state.integration = { ...state.integration, pass: false, status: outcome.status === "passed" ? "failed" : outcome.status, summary: "integration testing budget exhausted", expected: outcome.expected, roleStatus: outcome.roleStatus };
		return { status: "failed", error: "integration testing budget exhausted" };
	},
};
