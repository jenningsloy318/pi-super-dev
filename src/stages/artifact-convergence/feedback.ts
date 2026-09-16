import { ArtifactConvergenceOptions } from "./validators.ts";
/** feedback — retry feedback, review compaction, verdict/carried-debt and escalation helpers (split from artifact-convergence.ts at v0.4.17e). */
import { setRetryFeedback, withOmissionNotice, type RetryFeedback } from "../../retry-feedback.ts";
import type { ControlObj, Escalate, PipelineState, StageContext } from "../../types.ts";
import { NEGATED_APPROVAL_RE } from "../../review-findings.ts";
import { renderAndWrite } from "../../render/render.ts";
import { blockingConvergenceFindings, carriedConvergenceFindings, classSweepRetryFeedback, convergenceRetryFeedback, normalizeConvergenceStage, ownerPrecedes, recordConvergenceFindings, type ConvergenceOwnerStage } from "../../convergence-ledger.ts";
import { appendRouteBackRequests } from "../../replan/replan.ts";
import { isRoutableOwnerStage } from "../../routing/router.ts";
import { recordConvergedRevision } from "../../routing/revision-gate.ts";
import { bumpOwnerRevision } from "../../routing/walker.ts";
export function setArtifactFeedback(options: ArtifactConvergenceOptions, state: PipelineState, errors: string[]): void {
	const feedback: RetryFeedback = {
		stage: options.feedbackKey,
		gate: `${options.feedbackKey}-convergence`,
		observed: `The latest ${options.feedbackKey} artifact did not pass external validation.`,
		expected: options.expected,
		missing: errors.slice(0, 8),
		diagnostics: withOmissionNotice(errors.slice(8, 12), errors),
		nextAction: options.nextAction,
	};
	setRetryFeedback(state as Record<string, unknown>, options.feedbackKey, [feedback]);
}

/** v0.3.32 (runs 2026-08-30T00-10-34-032Z / 03-23-40-576Z): the writer stages
 *  (design.ts, writerTask) record the EXACT schema/render validation errors on
 *  the state here when renderAndWrite rejects a control. Read-and-clear, so a
 *  slot never leaks into a later round. */
export function readRenderErrors(state: PipelineState): string[] {
	const stateRec = state as Record<string, unknown>;
	const v = stateRec.__renderErrors;
	delete stateRec.__renderErrors;
	return Array.isArray(v) ? v.map(String).slice(0, 8) : [];
}

function defaultOwnerForError(feedbackKey: ArtifactConvergenceOptions["feedbackKey"], error: string): ConvergenceOwnerStage {
	if (feedbackKey === "bdd" && /No requirements doc|requirements doc has no AC-NN/i.test(error)) return "requirements";
	return normalizeConvergenceStage(feedbackKey, feedbackKey);
}

export function recordArtifactErrors(options: ArtifactConvergenceOptions, state: PipelineState, errors: string[], sourceGate: string): void {
	recordConvergenceFindings(state, errors.map((error) => {
		const ownerStage = options.ownerForError?.(error) ?? defaultOwnerForError(options.feedbackKey, error);
		return {
			detectedAtStage: options.feedbackKey,
			ownerStage,
			severity: "high",
			blocking: true,
			title: error,
			detail: error,
			evidence: [error],
			sourceGate,
			recommendation: options.nextAction,
		};
	}), { detectedAtStage: options.feedbackKey, ownerStage: normalizeConvergenceStage(options.feedbackKey, options.feedbackKey), sourceGate });
}

/** Compact a reviewer control object into feedback lines the next writer attempt
 *  can act on (mirrors spec-convergence.compactReviewFindings). */
export function compactReviewFindings(review: ControlObj | undefined): string[] {
	const lines: string[] = [];
	if (typeof review?.verdict === "string" && review.verdict.trim()) lines.push(`review verdict: ${review.verdict.trim()}`);
	if (typeof review?.summary === "string" && review.summary.trim()) lines.push(`review summary: ${review.summary.trim()}`);
	const findings = Array.isArray(review?.findings) ? review.findings as Array<Record<string, unknown>> : [];
	for (const finding of findings.slice(0, 8)) {
		const id = typeof finding.id === "string" ? finding.id : "finding";
		const severity = typeof finding.severity === "string" ? finding.severity : "unspecified";
		const title = typeof finding.title === "string" ? finding.title : "untitled";
		const detail = typeof finding.detail === "string" ? finding.detail : "";
		const owner = typeof finding.ownerStage === "string" ? ` owner=${finding.ownerStage}` : "";
		const status = typeof finding.status === "string" ? ` status=${finding.status}` : "";
		const cls = typeof finding.defectClass === "string" && finding.defectClass.trim() ? ` class=${finding.defectClass.trim()}` : "";
		const recommendation = typeof finding.recommendation === "string" ? ` recommendation=${finding.recommendation}` : "";
		lines.push(`review ${id} severity=${severity}${owner}${status}${cls}: ${title}${detail ? ` — ${detail}` : ""}${recommendation}`);
		// v0.3.1 F1: evidence passthrough — the writer can re-verify the way the
		// reviewer falsified it (grounding the revision restores forward movement).
		const evidence = Array.isArray(finding.evidence) ? finding.evidence.filter((e): e is string => typeof e === "string") : [];
		for (const item of evidence.slice(0, 2)) {
			const capped = item.length > 240 ? `${item.slice(0, 240)}…(+${item.length - 240} chars)` : item;
			lines.push(`  evidence: ${capped}`);
		}
	}
	// v0.3.1 F1 (cumora truncation accounting): announce every eviction with its
	// exact count — silent drops make the loss unrecoverable for the writer.
	if (findings.length > 8) lines.push(`…(+${findings.length - 8} more findings omitted from this compact view — read the full review document before revising)`);
	return lines;
}

/** Set the writer's retry feedback for a rejected REVIEW round: the compacted
 *  review findings PLUS the convergence-ledger's blocking items, so upstream-owned
 *  findings are threaded (not silently retried on the current stage alone). */
export function setReviewFeedback(options: ArtifactConvergenceOptions, state: PipelineState, source: string, errors: string[]): void {
	const feedback: RetryFeedback = {
		stage: options.feedbackKey,
		gate: source,
		observed: `The latest ${options.feedbackKey} artifact was rejected by ${source}.`,
		expected: options.expected,
		// v0.3.1 F1 (sd31-SD31-3/F-01): re-attach the compact view's truncation
		// announcement so the slice cannot silence it a second time.
		missing: withOmissionNotice(errors.slice(0, 8), errors),
		diagnostics: errors.slice(8, 12),
		nextAction: options.nextAction,
	};
	setRetryFeedback(state as Record<string, unknown>, options.feedbackKey, [
		feedback,
		...convergenceRetryFeedback(state, { stage: options.feedbackKey, currentStage: normalizeConvergenceStage(options.feedbackKey, options.feedbackKey), gate: source }),
		// v0.3.1 F1: class-sweep directive fires on review-rejected rounds when a
		// defect class has recurred (2nd instance, not stagnation round 4).
		...classSweepRetryFeedback(state, { stage: options.feedbackKey, gate: source }),
	]);
}

/** A stable signature of this stage's still-active blocking findings. When two
 *  consecutive review rounds produce the SAME signature the reviewer keeps
 *  flagging the same defects the writer cannot fix — a stall worth escalating. */
export function blockingSignature(state: PipelineState, owner: ConvergenceOwnerStage): string {
	return blockingConvergenceFindings(state)
		.filter((f) => f.ownerStage === owner || ownerPrecedes(f.ownerStage, owner))
		.map((f) => f.fingerprint)
		.sort()
		.join("|");
}

/** Read the inline HITL escalate callback threaded through ctx.options. */
export function getEscalate(ctx: StageContext): Escalate | undefined {
	return (ctx as { options?: { escalate?: Escalate } }).options?.escalate;
}

/** Review-verdict approval for the upstream reviewers. Unlike the strict
 *  `isApprovedVerdict` (which rejects ANY verdict containing "revision"), this
 *  honors the reviewer contract that "APPROVED WITH REVISIONS" is a SUGGESTION-
 *  ONLY pass — approved when the verdict affirmatively approves and is not an
 *  explicit rejection. "REVISIONS NEEDED" / "Changes Requested" / "Rejected"
 *  stay rejected. AND-ed with `!reviewHasBlockingFinding` at the call site so a
 *  blocking finding still blocks regardless of verdict wording.
 *  Exported for the AC-28 verdict tables (tests/artifact-convergence.test.ts). */
export function reviewVerdictApproves(verdict: unknown): boolean {
	const v = String(verdict ?? "").trim().toLowerCase();
	if (!v) return false;
	// M17 (SCENARIO-057): negated approvals ("not approved", "does not pass",
	// "approved: no", …) never approve — the guard fires BEFORE the approve-family
	// match, so the \b(approved|pass|accept)\b heuristic cannot match the word
	// inside the negation.
	if (NEGATED_APPROVAL_RE.test(v)) return false;
	if (/(changes?\s+requested|revisions?\s+needed|reject|contest|blocked|fail|declined)/i.test(v)) return false;
	return /\b(approved|pass|accept)/i.test(v);
}

/** v0.3.24 S2 (review-2 F1): the CONVERGED-CARRIED exit's delivery half —
 *  persist the carried rows as PENDING REPLAN REQUESTS for each routable
 *  owner and bump the owner's revision counter. Without this, the
 *  revision-gate fast-forward could skip the owner's round 1 entirely
 *  (journal + owner converged earlier + revision unchanged + no pending
 *  requests), so the "re-injects at the owner's round 1" contract was not
 *  deterministic. The replan requests defeat fast-forward condition (4) and
 *  ARE the round-1 injection; the revision bump defeats condition (3). The
 *  caller must NOT recordConvergedRevision for the exiting stage (that
 *  would defeat condition (2) the WRONG way — green-skipping a
 *  never-approved artifact in later sub-walks). */
export function deliverCarriedDebt(
	state: PipelineState,
	ownStage: ConvergenceOwnerStage,
	log: (line: string) => void,
): void {
	const specDir = state.setup?.specDirectory;
	const carried = carriedConvergenceFindings(state, ownStage);
	if (specDir && carried.length > 0) {
		const byOwner = new Map<string, typeof carried>();
		for (const f of carried) {
			const owner = normalizeConvergenceStage(String(f.ownerStage), ownStage);
			if (!byOwner.has(owner)) byOwner.set(owner, []);
			byOwner.get(owner)!.push(f);
		}
		const runId = state.setup?.specIdentifier ?? "unknown";
		for (const [owner, rows] of byOwner) {
			if (!isRoutableOwnerStage(owner)) {
				// e.g. a downstream loop-less stage (implementation/verification): the
				// ledger rows still inject into every subsequent agent prompt via the
				// workflow seam — disclose that this is the delivery path.
				log(`CONVERGED-CARRIED delivery: ${rows.length} finding(s) owned by non-routable stage ${owner} stay in the convergence ledger (injected into subsequent agent prompts); no replan request persisted`);
				continue;
			}
			const injected = appendRouteBackRequests(specDir, owner, rows.map((f) => f as unknown as Record<string, unknown>), runId);
			const revision = bumpOwnerRevision(specDir, owner);
			log(`CONVERGED-CARRIED delivery: ${injected} replan request(s) persisted for owner ${owner}; its revision counter bumped to ${revision} (fast-forward disabled — the owner loop re-runs and receives the debt at round 1)`);
		}
	}
}

/** v0.3.24 S4-4: does a judge escalate-now verdict carry actionable evidence?
 * B4 (D10) required a non-empty `evidence[].quote`, but the judge's
 * degrade-to-escalate path legitimately emits notes/text instead — run
 * 2026-08-28T13-04-28-485Z round 6 discarded a correct escalation diagnosis
 * ("route to the bdd stage") purely on the missing `.quote` shape. Accept any
 * non-empty verbatim-ish field on the evidence entries. */
export function judgeEscalateEvidencePresent(evidence: unknown): boolean {
	const rows = Array.isArray(evidence) ? evidence as Array<Record<string, unknown>> : [];
	return rows.some((e) => ["quote", "note", "text", "detail", "finding", "fact"]
		.some((field) => String(e?.[field] ?? "").trim().length > 0));
}