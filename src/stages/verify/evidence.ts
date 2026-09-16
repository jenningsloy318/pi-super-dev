import {findingsSignature, testFailuresSignature} from "./steps.ts";
import {IntegrationOutcomeStatus, buildGreen, expectedIntegrationRoles} from "./boundary.ts";
/** evidence — attempt records, signatures, snapshots, stagnation evidence, replay arms. Split from verify.ts at v0.4.17c. */
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

export const setupOf = (s: PipelineState) => s.setup!;

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
	/** v0.3.79 A3 (spec-25): reviewer infra non-completion ("X review did not
	 *  complete") — never counts toward the stagnation decision; tallied
	 *  separately. Set at the source (failedReviewControl) with a defensive
	 *  title-suffix fallback for older rows/resume reconstruction. */
	infra?: boolean;
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
				infra: finding.infra === true || / review did not complete$/i.test(title),
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

export function snapshotStatusFiles(s: PipelineState): Map<string, string | null> {
	const cwd = s.setup?.worktreePath;
	const out = new Map<string, string | null>();
	if (!cwd) return out;
	for (const path of gitStatusPaths(cwd)) {
		try { out.set(path, readFileSync(join(cwd, path), "utf8")); }
		catch { out.set(path, null); }
	}
	return out;
}

export function changedSinceSnapshot(s: PipelineState, before: Map<string, string | null>): string[] {
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

export function ensureVerificationAttempts(s: PipelineState): VerificationAttemptRecord[] {
	const key = "__verificationAttempts";
	const existing = (s as Record<string, unknown>)[key];
	if (Array.isArray(existing)) return existing as VerificationAttemptRecord[];
	const created: VerificationAttemptRecord[] = [];
	(s as Record<string, unknown>)[key] = created;
	return created;
}

export function buildErrors(s: PipelineState): string[] {
	return ((s.buildGate as { errors?: string[] } | undefined)?.errors ?? []).filter((e): e is string => typeof e === "string");
}

export function summarizeReviewFindings(s: PipelineState, max = 8): string[] {
	const findings = (s.review?.findings as Array<Record<string, unknown>> | undefined) ?? [];
	return findings.slice(0, max).map((f) => {
		const file = String(f.file ?? "").trim();
		const title = String(f.title ?? f.detail ?? "review finding").trim();
		const severity = String(f.severity ?? "medium").trim();
		return `${file ? `${file}: ` : ""}[${severity}] ${title}`;
	});
}

export function summarizeTestFailures(s: PipelineState, max = 8): string[] {
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

export function recordVerificationConvergenceFinding(
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

export function verificationRetryFeedbackBlock(s: PipelineState, kind: "review" | "integration"): string {
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

export function testFailureCount(s: PipelineState): number {
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

export function recordAttemptEnd(s: PipelineState, record: VerificationAttemptRecord, terminal = false): void {
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
		// Bound (P8): single pass over the FINITE `current` list — `continue` only
		// skips non-recurring/duplicate items; nothing is re-queued, so the loop
		// terminates at current.length iterations.
		if (!previousFingerprints.has(item.fingerprint) || seen.has(item.fingerprint)) continue;
		seen.add(item.fingerprint);
		recurring.push(item);
	}
	return recurring;
}

export function recordVerificationReviewFindings(s: PipelineState, ctx: StageContext): void {
	const written = recordReviewFindingsFromControl(s, s.review as ControlObj | undefined, {
		detectedAtStage: "verification",
		ownerStage: "implementation",
		sourceGate: "verification-review",
	});
	if (written.length === 0) return;
	const recurring = written.filter((finding) => finding.blocking && finding.seenCount > 1).length;
	ctx.log(`Stage 10: convergence ledger recorded ${written.length} review finding(s) (${recurring} recurring blocker${recurring === 1 ? "" : "s"})`);
}

/** V1 (v0.3.10) — replay-arm budget for the WIRED Stage 10 convergence node.
 *  On a genuine resume (ctx.options.resumeSpecIdentifier — the same signal
 *  pipeline.ts uses to preload the cache; state.options is accepted as a test
 *  fallback), the persisted occurrence count of the three verify review agents
 *  bounds how many leading loop attempts are REPLAY-DERIVED (cache-hit
 *  reconstructions carrying no fresh information). Replayed attempts rebuild
 *  state but never arm the stagnation stop — the wired twin of the writer
 *  loops' F3 contract, grounded in the durable-execution principle that
 *  history is evidence for STATE, not TERMINATION. No baseline offset here:
 *  attempt 1 IS a review outcome (unlike reviewLoopUntil's pre-loop call).
 *  Kill-switch: SUPER_DEV_NO_VERIFY_REPLAY_GUARD=1. */
export function verificationReplayArms(state: PipelineState, ctx?: StageContext): number {
	const s = state as unknown as Record<string, unknown>;
	if (s.__verificationReplayArms !== undefined) return s.__verificationReplayArms as number;
	let arms = 0;
	const specDir = state.setup?.specDirectory;
	const marker = ctx?.options?.resumeSpecIdentifier
		?? (state.options as { resumeSpecIdentifier?: string } | undefined)?.resumeSpecIdentifier;
	const resumed = Boolean(marker);
	if (specDir && resumed && !superDevEnv("SUPER_DEV_NO_VERIFY_REPLAY_GUARD")) {
		// max over the review family: a crash mid-round (one reviewer recorded,
		// another not) over-excludes by one attempt — the SAFE direction.
		const prior = Math.max(
			countStageRounds(specDir, "pipeline.verify.code-review"),
			countStageRounds(specDir, "pipeline.verify.adversarial"),
			countStageRounds(specDir, "pipeline.verify.tests-review"),
		);
		if (prior > 0) {
			arms = prior;
			ctx?.log(`Stage 10: resuming after ${prior} recorded verify round(s) — replayed attempts do not arm the stagnation stop (fresh evidence required)`);
		}
	}
	s.__verificationReplayArms = arms;
	return arms;
}

export async function recordVerificationStagnation(s: PipelineState, ctx: StageContext, record: VerificationAttemptRecord): Promise<boolean> {
	// V1: a replay-derived attempt (resume cache hit) reconstructs state but is
	// not evidence — it must neither push into the arming fingerprint history
	// nor arm the stagnation stop. Single choke point for all three call sites.
	// The attempt number is CUMULATIVE across in-process re-entry (route-back
	// re-enters this node with `attempt` restarted at 1 while the arms memo
	// correctly survives): the persisted __verificationAttempts ledger — which
	// the node does NOT reset at entry — is the authoritative sequence, so a
	// re-entry's attempt 1 with 4 recorded attempts classifies fresh (round-2
	// review: MED-1/R2-1).
	const attemptSeq = Math.max(
		record.attempt,
		((s as Record<string, unknown>).__verificationAttempts as unknown[] | undefined)?.length ?? 0,
	);
	if (attemptSeq <= verificationReplayArms(s, ctx)) {
		ctx.log(`Stage 10: attempt ${record.attempt} is replay-derived (resume cache) — reconstructing only; stagnation not armed on replayed evidence`);
		return false;
	}
	const items = currentVerificationFailureItems(s);
	const history = rememberVerificationFailureRound(s, record, items);
	const previous = history.length >= 2 ? history[history.length - 2] : undefined;
	const recurringAll = recurringVerificationFailures(items, previous?.items);
	// v0.3.79 A3 (spec-25): reviewer infra non-completions NEVER count toward
	// the stagnation decision — runs 00-49/13-23/13-43 stopped PARTIAL on "3
	// recurring blockers" that were all "X review did not complete" while 18
	// fix cycles burned on them. Content recurrence is the stop signal; infra
	// non-completion is tallied and surfaced, never armed.
	const recurring = recurringAll.filter((item) => !item.infra);
	const infraNonCompletions = recurringAll.length - recurring.length;
	if (recurringAll.length > 0 && recurring.length === 0) {
		// ADV-v0379-3: never arming on infra alone removed the loop's cheap stop —
		// a persistently broken reviewer class would burn the WHOLE budget (the
		// v0.3.77 model-exclusion class). Cap consecutive all-infra rounds; past the
		// cap stop for the human with the infra tally (retrying reviews cannot
		// repair reviewer infrastructure).
		const infraOnlyRounds = (((s as Record<string, unknown>).__infraOnlyRounds as number | undefined) ?? 0) + 1;
		(s as Record<string, unknown>).__infraOnlyRounds = infraOnlyRounds;
		if (infraOnlyRounds >= 3) {
			ctx.log(`Stage 10: ${infraOnlyRounds} consecutive all-infra round(s) — reviewer infrastructure cannot complete (non-completion class); stopping for the human (retrying reviews does not repair infra)`);
			(s as Record<string, unknown>).__verificationStagnated = {
				rounds: history.length,
				attempt: record.attempt,
				status: (s.integration as { status?: unknown } | undefined)?.status ?? "review-build",
				signature: record.failureSignature,
				findings: [],
				recurringBlockers: [],
				infraNonCompletions,
				infraOnlyStop: true,
			};
			recordVerificationConvergenceFinding(s, {
				title: "Reviewer infrastructure non-completion persists",
				detail: `${infraOnlyRounds} consecutive verification rounds recurred ONLY reviewer-infra non-completion findings ("review did not complete") — the reviewer agents cannot complete; retrying does not repair infrastructure`,
				evidence: recurringAll.map((item) => `${item.source}:${item.fingerprint} ${item.label}`).slice(0, 12),
				sourceGate: "stagnation",
			});
			return true;
		}
		ctx.log(`Stage 10: ${infraNonCompletions} recurring reviewer-infra non-completion(s) ("review did not complete") — infra, not content stagnation; not arming the stop (${infraOnlyRounds}/3 all-infra rounds)`);
		return false;
	}
	if (recurring.length > 0) (s as Record<string, unknown>).__infraOnlyRounds = 0;
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
		infraNonCompletions,
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
	// v0.3.79 A3 (spec-25 stagnation routing): before the human-decision PARTIAL
	// stop, ONE bounded judge adjudication asks whether the content blockers are
	// within this stage's authority or require plan/spec revision (replan-
	// upstream). A routed replan-upstream triggers the replan machinery — the
	// fix loop attempting design-level work it cannot do (18 fix cycles on
	// behavioral-semantics findings) becomes a plan-revision route instead.
	// Fail-open: judge failure/unavailable leaves today's human stop in place.
	try {
		const specDir = s.setup?.specDirectory;
		const stagnationFrame = [
			"## Stage 10 stagnation — recurring content blockers after targeted fix cycles",
			...recurring.map((item) => `- ${item.label}`),
			`(${history.length} recorded round(s); last fix kind: ${String(lastFix.kind ?? "unknown")})`,
			infraNonCompletions > 0 ? `(${infraNonCompletions} additional reviewer-infra non-completion(s) excluded from this decision)` : "",
			"",
			"These blockers recurred after the fix loop's targeted changes. Decide: are they fixable within this stage's authority (code changes under the current plan), or do they require plan/spec revision? If the plan/spec is the blocker (contradictory requirements, missing acceptance criteria, structural infeasibility), route replan-upstream with the blocking findings quoted. Otherwise escalate-now for the human.",
		].filter(Boolean).join("\n");
		const judgeOut = await runJudge(ctx, {
			scope: "stage10.stagnation.adjudicate",
			signature: `stagnation:${recurring.map((i) => i.fingerprint).sort().join(",")}`,
			worktreePath: s.setup?.worktreePath ?? "",
			specDirectory: specDir,
			context: stagnationFrame,
			allowedRoutes: ["replan-upstream"],
		});
		if (judgeOut.status === "routed" && judgeOut.verdict.route === "replan-upstream") {
			const replanFindings = recurring.map((item) => ({
				file: item.file ?? null,
				severity: item.severity ?? "high",
				title: item.title ?? item.label,
				detail: `stagnation: recurred after ${history.length} verification round(s) and targeted fix cycles — judge-adjudicated as plan/spec-owned (judge: ${judgeOut.verdict.diagnosis.slice(0, 300)})`,
				ownerStage: "spec",
			}));
			const { triggerReplanForFindings } = await import("../../replan/replan.ts");
			const replanned = await triggerReplanForFindings(s, ctx, replanFindings, "verify", s.setup?.specIdentifier ?? "unknown");
			if (replanned) {
				ctx.log(`Stage 10: stagnation routed to REPLAN — the judge adjudicated the ${recurring.length} content blocker(s) as plan/spec-owned (${judgeOut.verdict.diagnosis.slice(0, 200)})`);
			}
		}
	} catch { /* never-throw: the stagnation stop below stands */ }
	return true;
}
