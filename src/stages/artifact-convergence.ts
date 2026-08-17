import { FatalAbort, gateValidator, task } from "../nodes.ts";
import { clearRetryFeedback, setRetryFeedback, type RetryFeedback } from "../retry-feedback.ts";
import type { ControlObj, Escalate, EscalationFailure, Node, PipelineState, Stage, StageContext } from "../types.ts";
import { isNonRetryableAgentError, nonRetryableAgentSummary } from "../agent-errors.ts";
import { enforceReviewerConvergenceDuty, reviewHasBlockingVerdictFinding } from "../review-findings.ts";
import { applyRetryDecision, escalationBudgetRemaining, runEscalation } from "../escalation.ts";
import { runJudge } from "./judge.ts";
import { countStageRounds } from "../resume.ts";
import { triggerReplanForFindings } from "../replan/replan.ts";
import {
	blockingConvergenceFindings,
	convergenceRetryFeedback,
	markConvergenceFindingsAddressedFromResponses,
	markConvergenceFindingsVerified,
	normalizeConvergenceStage,
	ownerPrecedes,
	recordConvergenceFindings,
	recordReviewFindingsFromControl,
	type ConvergenceOwnerStage,
	getConvergenceLedger,
} from "../convergence-ledger.ts";
import { pendingReplanRequests, consumeReplanRequests } from "../replan/replan.ts";
import { bddReviewWriter, bddWriter, designReviewWriter, requirementsReviewWriter, requirementsWriter, researchWriter } from "./writers.ts";
import { designStage } from "./design.ts";

type ArtifactValidator = (state: PipelineState, ctx: StageContext) => Promise<{ pass: boolean; errors: string[] }> | { pass: boolean; errors: string[] };

/** Hard liveness ceiling for every artifact-convergence loop (requirements, bdd,
 *  research, design). Termination normally comes from reviewer approval, the
 *  stall/HITL escalation path, or the global run budget — but a stochastic
 *  reviewer that never approves (and never stalls) would otherwise loop until the
 *  global budget exhausts (and a test with budget.check=()=>true loops forever →
 *  OOM). This cap is the unconditional floor: it FatalAborts exactly like the
 *  global-budget-exhaustion path, deliberately WITHOUT consuming the shared
 *  `stagnation:<feedbackKey>` escalation budget. See
 *  docs/requirements/convergence-loop-unbounded-cap-fix.md. */
export const MAX_CONVERGENCE_ROUNDS = 8;

/** Optional Fagan-style LLM review step layered on top of the deterministic
 *  validate (shift-left): after the artifact passes its deterministic gate, a
 *  reviewer agent judges CONTENT quality across stage-specific dimensions and
 *  returns a verdict. A non-approved verdict (or any blocking finding) feeds the
 *  review findings back into the next writer attempt — same convergence loop, so
 *  a reviewer-only retry can never masquerade as a fix. When the SAME blocking
 *  findings recur unchanged (a stall), the run escalates to the user (HITL). */
interface ArtifactReviewOptions {
	/** The reviewer writer stage (e.g. requirementsReviewWriter). */
	stage: Stage;
	/** State key its control object lands under (e.g. "requirementsReview"). */
	reviewStateKey: string;
	/** Owning stage for recorded findings (e.g. "requirements"). */
	ownerStage: ConvergenceOwnerStage;
}

interface ArtifactConvergenceOptions {
	stage: Stage;
	feedbackKey: "requirements" | "bdd" | "research" | "design";
	/** Deterministic validator. OPTIONAL: the design stage has no deterministic
	 *  gate (its quality is judged only by the LLM review), so it omits this. */
	validate?: ArtifactValidator;
	expected: string;
	nextAction: string;
	ownerForError?: (error: string) => ConvergenceOwnerStage;
	/** OPTIONAL upstream review+fix step. Absent ⇒ deterministic-validate-only
	 *  (byte-identical to today, e.g. research). */
	review?: ArtifactReviewOptions;
	/** OPTIONAL skip predicate: when it returns true after the writer runs, the
	 *  stage produced no artifact (e.g. design skipped for a bug fix) and the node
	 *  converges immediately without review. */
	skipped?: (state: PipelineState) => boolean;
	/** OPTIONAL override of the hard round ceiling (default MAX_CONVERGENCE_ROUNDS).
	 *  Tests use a small value to assert the cap fires; production leaves it unset.
	 *  The cap is a liveness floor, not a quality target. */
	maxRounds?: number;
}

function validResearchSourceCount(r: { sources?: unknown }): number {
	const sources = Array.isArray(r.sources) ? r.sources : [];
	return sources.filter((source) => {
		if (!source || typeof source !== "object" || Array.isArray(source)) return false;
		const url = (source as { url?: unknown }).url;
		return typeof url === "string" && /^https?:\/\//i.test(url.trim());
	}).length;
}

function researchUnavailableDisclosure(r: Record<string, unknown>): boolean {
	const options = Array.isArray(r.options) ? r.options : [];
	const text = [
		r.summary,
		...options.map((o) => typeof o === "object" && o !== null ? `${(o as { name?: unknown }).name ?? ""} ${(o as { tradeoffs?: unknown }).tradeoffs ?? ""}` : o),
	]
		.map((v) => String(v ?? ""))
		.join("\n")
		.toLowerCase();
	const unavailable = /(?:web|search|mcp|firecrawl|anysearch|tavily|tinyfish|network|provider|tool)[\w\s/-]{0,80}(?:unavailable|not configured|unauthorized|failed|blocked|disabled)/i.test(text);
	const unverified = /\bunverified\b|\bnot verified\b|\bunsupported by sources\b/i.test(text);
	return unavailable && unverified;
}

export const requirementsComplete: ArtifactValidator = async (s: PipelineState, ctx: StageContext) => {
	const base = await gateValidator("gate-requirements", "write-requirements", "requirements")(s, ctx);
	const req = s.requirements as ({ openQuestions?: unknown[] } & Record<string, unknown>) | undefined;
	const open = Array.isArray(req?.openQuestions) ? req.openQuestions : [];
	if (open.length === 0) return base;
	const preview = open.slice(0, 3).map((o) => String(o).slice(0, 100)).join("; ");
	ctx.log(`Requirements: ${open.length} open question(s) remain; continuing requirements clarification: ${preview}`);
	return {
		pass: false,
		errors: [...base.errors, `requirements left ${open.length} open question(s): ${preview}`],
	};
};

export const bddComplete: ArtifactValidator = gateValidator("gate-bdd", "write-bdd", "bdd");

/** A research report is complete only when it exists and leaves no answerable
 *  open issues. `openIssues` is reserved for concrete ambiguities that another
 *  research pass should try to resolve; generic caveats and unresolvable limits
 *  belong in the summary/options instead. It must also include real researched
 *  sources unless the report explicitly records unavailable web/search tooling
 *  and marks its claims unverified. */
export const researchComplete: ArtifactValidator = async (s: PipelineState, ctx: StageContext) => {
	const r = s.research as ({ docPath?: string; openIssues?: unknown[]; sources?: unknown } & Record<string, unknown>) | undefined;
	if (!r || !r.docPath) {
		ctx.log("Research: no report produced (agent returned nothing or timed out)");
		return { pass: false, errors: ["no research report produced (agent returned nothing or timed out)"] };
	}
	const sourceCount = validResearchSourceCount(r);
	if (sourceCount === 0 && !researchUnavailableDisclosure(r)) {
		ctx.log("Research: no real source URLs and no explicit web-tool-unavailable/unverified disclosure");
		return { pass: false, errors: ["research must include at least one real http(s) source URL, or explicitly disclose that web/search tools were unavailable and mark claims unverified"] };
	}
	const open = (r.openIssues as unknown[]) ?? [];
	if (open.length > 0) {
		const preview = open.slice(0, 3).map((o) => String(o).slice(0, 80)).join("; ");
		ctx.log(`Research: ${open.length} answerable open issue(s) remain; continuing research: ${preview}`);
		return { pass: false, errors: [`research left ${open.length} answerable open issue(s): ${preview}`] };
	}
	return { pass: true, errors: [] };
};

function setArtifactFeedback(options: ArtifactConvergenceOptions, state: PipelineState, errors: string[]): void {
	const feedback: RetryFeedback = {
		stage: options.feedbackKey,
		gate: `${options.feedbackKey}-convergence`,
		observed: `The latest ${options.feedbackKey} artifact did not pass external validation.`,
		expected: options.expected,
		missing: errors.slice(0, 8),
		diagnostics: errors.slice(8, 12),
		nextAction: options.nextAction,
	};
	setRetryFeedback(state as Record<string, unknown>, options.feedbackKey, [feedback]);
}

function defaultOwnerForError(feedbackKey: ArtifactConvergenceOptions["feedbackKey"], error: string): ConvergenceOwnerStage {
	if (feedbackKey === "bdd" && /No requirements doc|requirements doc has no AC-NN/i.test(error)) return "requirements";
	return normalizeConvergenceStage(feedbackKey, feedbackKey);
}

function recordArtifactErrors(options: ArtifactConvergenceOptions, state: PipelineState, errors: string[], sourceGate: string): void {
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
function compactReviewFindings(review: ControlObj | undefined): string[] {
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
		const recommendation = typeof finding.recommendation === "string" ? ` recommendation=${finding.recommendation}` : "";
		lines.push(`review ${id} severity=${severity}${owner}${status}: ${title}${detail ? ` — ${detail}` : ""}${recommendation}`);
	}
	return lines;
}

/** Set the writer's retry feedback for a rejected REVIEW round: the compacted
 *  review findings PLUS the convergence-ledger's blocking items, so upstream-owned
 *  findings are threaded (not silently retried on the current stage alone). */
function setReviewFeedback(options: ArtifactConvergenceOptions, state: PipelineState, source: string, errors: string[]): void {
	const feedback: RetryFeedback = {
		stage: options.feedbackKey,
		gate: source,
		observed: `The latest ${options.feedbackKey} artifact was rejected by ${source}.`,
		expected: options.expected,
		missing: errors.slice(0, 8),
		diagnostics: errors.slice(8, 12),
		nextAction: options.nextAction,
	};
	setRetryFeedback(state as Record<string, unknown>, options.feedbackKey, [
		feedback,
		...convergenceRetryFeedback(state, { stage: options.feedbackKey, currentStage: normalizeConvergenceStage(options.feedbackKey, options.feedbackKey), gate: source }),
	]);
}

/** A stable signature of this stage's still-active blocking findings. When two
 *  consecutive review rounds produce the SAME signature the reviewer keeps
 *  flagging the same defects the writer cannot fix — a stall worth escalating. */
function blockingSignature(state: PipelineState, owner: ConvergenceOwnerStage): string {
	return blockingConvergenceFindings(state)
		.filter((f) => f.ownerStage === owner || ownerPrecedes(f.ownerStage, owner))
		.map((f) => f.fingerprint)
		.sort()
		.join("|");
}

/** Read the inline HITL escalate callback threaded through ctx.options. */
function getEscalate(ctx: StageContext): Escalate | undefined {
	return (ctx as { options?: { escalate?: Escalate } }).options?.escalate;
}

/** Review-verdict approval for the upstream reviewers. Unlike the strict
 *  `isApprovedVerdict` (which rejects ANY verdict containing "revision"), this
 *  honors the reviewer contract that "APPROVED WITH REVISIONS" is a SUGGESTION-
 *  ONLY pass — approved when the verdict affirmatively approves and is not an
 *  explicit rejection. "REVISIONS NEEDED" / "Changes Requested" / "Rejected"
 *  stay rejected. AND-ed with `!reviewHasBlockingFinding` at the call site so a
 *  blocking finding still blocks regardless of verdict wording. */
function reviewVerdictApproves(verdict: unknown): boolean {
	const v = String(verdict ?? "").trim().toLowerCase();
	if (!v) return false;
	if (/(changes?\s+requested|revisions?\s+needed|reject|contest|blocked|fail|declined)/i.test(v)) return false;
	return /\b(approved|pass|accept)/i.test(v);
}

/** F2 (RC1, run 2026-08-17T02-16-49-478Z): one bounded extension when the loop
 *  is still making STRICT progress at the cap. Research grounding — Refine-n-Judge
 *  (arXiv 2508.01543) and verification-loop practice: a hard cap alone kills
 *  loops that resolve prior findings every round but keep meeting one NEW
 *  reviewer finding; strict-progress detection (open-blocking count strictly
 *  decreasing) separates those from true stalls. */
export const PROGRESS_EXTENSION_ROUNDS = 4;
/** F3: hard cumulative ceiling — replayed + fresh rounds across resumes. Each
 *  resume grants maxRounds fresh rounds (durable-execution continuation), but
 *  the total is bounded at 3× the base cap so a deterministic false-positive
 *  gate cannot ping-pong forever (replan/HITL owns the terminal state by then). */
const MAX_TOTAL_ROUND_MULTIPLE = 3;

export function effectiveRoundCap(maxRounds: number, priorRounds: number): number {
	return Math.min(priorRounds + maxRounds, maxRounds * MAX_TOTAL_ROUND_MULTIPLE);
}

export function artifactConvergenceNode(options: ArtifactConvergenceOptions): Node {
	const stageTask = task(options.stage);
	const reviewTask = options.review ? task(options.review.stage) : null;
	return {
		kind: `${options.feedbackKey}-convergence`,
		async run(state: PipelineState, ctx: StageContext) {
			const maxRounds = options.maxRounds ?? MAX_CONVERGENCE_ROUNDS;
			// F3 (RC2): a resumed run REPLAYS this loop's prior rounds as cache hits
			// (rebuilding retry feedback + ledger state) and must then get FRESH
			// rounds — the old static cap fired right after the replay and re-killed
			// the run before any fresh call (runs 02-47 / 06-02). countStageRounds
			// reads the persisted occurrence count; fresh runs see 0.
			const priorRounds = state.setup?.specDirectory ? countStageRounds(state.setup.specDirectory, `pipeline.${options.stage.id}`) : 0;
			let effectiveCap = effectiveRoundCap(maxRounds, priorRounds);
			if (effectiveCap > maxRounds) ctx.log(`${options.feedbackKey} convergence: resuming after ${priorRounds} recorded round(s) — round budget extended to ${effectiveCap} (replayed rounds do not consume the fresh budget)`);
			let round = 0;
			let lastErrors: string[] = [];
			let priorBlockingSignature = "";
			let convergenceJudgeTried = false;
			// F2: strict-progress tracking — the count of this stage's OWN open
			// blocking findings across consecutive rounds, plus the one-shot
			// extension flag.
			let prevOwnOpen = Number.POSITIVE_INFINITY;
			let lastOwnOpen = Number.POSITIVE_INFINITY;
			let progressExtensionUsed = false;
			const ownStage = normalizeConvergenceStage(options.feedbackKey, options.feedbackKey);
			// G1 (adversarial G1-ROUND-COUNTER-CONFLATION): the duty threshold
			// counts REVIEW passes, not loop iterations — validation-failure
			// rounds run no reviewer and must not consume the reviewer's free
			// early passes.
			let reviewRound = 0;
			while (ctx.budget.check()) {
				round++;
				if (ctx.signal?.aborted) return { status: "cancelled" as const };
			// J10-c (judge routing layer): one round before the cap, ONE verified
			// diagnosis so the fatal message explains WHY convergence failed — the
			// judge can only abort early (escalate-now) with its diagnosis attached,
			// never extend the cap or touch the writer loop.
			// F3 (code-review R4): anchor on the EFFECTIVE cap, not the base cap — a
			// resumed run replays cached rounds 1..k; a judge call cached at base
			// round maxRounds-1 would replay its fatal verdict BEFORE the fresh
			// round budget (effectiveCap) is ever reached. effectiveCap === maxRounds
			// on a fresh run, so behavior there is unchanged.
			if (round === effectiveCap - 1 && !convergenceJudgeTried) {
					convergenceJudgeTried = true;
					try {
						const out = await runJudge(ctx, {
							scope: `stage10.convergence-cap.${options.feedbackKey}`,
							signature: priorBlockingSignature || `${options.feedbackKey}:rounds`,
							worktreePath: state.setup?.worktreePath ?? "",
							specDirectory: state.setup?.specDirectory,
							context: [
								`## Convergence loop: ${options.feedbackKey}`,
								`round ${round} of cap ${maxRounds}; still not converged.`,
								"## Recurring errors across rounds",
								...(lastErrors.length ? lastErrors.slice(0, 8) : ["(none recorded)"]),
							].join("\n"),
							allowedRoutes: ["escalate-now"],
						});
						if ((out.status === "routed" || out.status === "escalate") && out.verdict.route === "escalate-now") {
							ctx.log(`${options.feedbackKey} convergence: JUDGE ESCALATE — ${out.verdict.diagnosis}`);
							throw new FatalAbort(`${options.feedbackKey} convergence did not converge within ${maxRounds} round(s): ${out.verdict.diagnosis}`);
						}
					} catch (err) {
						if (err instanceof FatalAbort) throw err;
						/* INV-6: judge infra failure never blocks the loop */
					}
				}
				if (round > effectiveCap) {
					// F2 (RC1): strict progress at the cap — the loop resolved more of
					// its own blockers than it gained last round. Grant ONE bounded
					// extension instead of killing productive work (run 02-16 resolved
					// findings every round and still hit the cap's FatalAbort).
					if (!progressExtensionUsed && prevOwnOpen !== Number.POSITIVE_INFINITY && lastOwnOpen < prevOwnOpen && lastOwnOpen > 0) {
						progressExtensionUsed = true;
						effectiveCap += PROGRESS_EXTENSION_ROUNDS;
						ctx.log(`${options.feedbackKey} convergence: cap extended to ${effectiveCap} — strict progress (own open blocking ${prevOwnOpen === Number.POSITIVE_INFINITY ? "?" : prevOwnOpen} → ${lastOwnOpen})`);
					} else {
						// F1 (RC3): before the fatal, route upstream-owned blockers back
						// to their owning stages via the replan circuit (bounded restart;
						// the extension auto-resumes). Headless runs previously fell here
						// with no HITL surface and died (run 08-56: BDD-019
						// owner=requirements spun rounds 5-8, then FATAL).
						const upstreamAtCap = blockingConvergenceFindings(state).filter((f) => ownerPrecedes(f.ownerStage, ownStage));
						if (upstreamAtCap.length > 0 && await triggerReplanForFindings(state, ctx, upstreamAtCap as unknown as Array<Record<string, unknown>>, options.feedbackKey, state.setup?.specIdentifier ?? "unknown")) {
							ctx.log(`${options.feedbackKey} convergence: ${upstreamAtCap.length} upstream-owned blocking finding(s) routed back via REPLAN at round cap — the run will restart and the owning stage(s) will revise`);
							throw new FatalAbort(`${options.feedbackKey} convergence: REPLAN at round cap — ${upstreamAtCap.length} upstream-owned blocking finding(s) routed back to their owning stage(s); restarting to revise`);
						}
						// Unconditional liveness floor. The stall path below routes ACTIONABLE
						// stagnation (a recurring blocking finding) to HITL escalation; this cap
						// is the safety net for NON-actionable non-convergence (e.g. a stochastic
						// reviewer that never approves). It FatalAborts exactly like the global-
						// budget-exhaustion path below — deliberately NOT escalating, so it does
						// NOT consume the shared `stagnation:<feedbackKey>` escalation budget
						// (ESCALATION_RETRY_CAP) that the stall path relies on.
						const msg = `${options.feedbackKey} convergence did not converge within ${effectiveCap} round(s)${lastErrors.length ? `: ${lastErrors.join("; ")}` : ""}`;
						ctx.log(`${options.feedbackKey} convergence: ROUND CAP (${effectiveCap}) EXHAUSTED (FATAL — aborting run) — ${msg}`);
						throw new FatalAbort(msg);
					}
				}
				ctx.log(`${options.feedbackKey} convergence: round ${round} starting`);
				if (options.review) delete (state as Record<string, unknown>)[options.review.reviewStateKey];

				// R3 (dsh-09 v3): pending replan requests owned by this stage inject as
				// convergence-ledger findings at round 1 — the EXISTING
				// writer-revises-per-finding machinery performs the revision. Dedup by
				// fingerprint keeps restarts idempotent.
				if (round === 1) {
					const pendingReplan = pendingReplanRequests(state.setup?.specDirectory, options.feedbackKey);
					if (pendingReplan.length > 0) {
						recordConvergenceFindings(state, pendingReplan.map((r) => ({
							id: `replan-${r.id}`,
							title: r.title,
							detail: r.requestedRevision,
							severity: r.severity,
							file: r.file,
							status: "open",
							blocking: true,
						})), { detectedAtStage: "replan", ownerStage: normalizeConvergenceStage(options.feedbackKey, options.feedbackKey), sourceGate: "replan-request" });
						setArtifactFeedback(options, state, pendingReplan.map((r) => `[replan request ${r.id}] ${r.requestedRevision}`));
						ctx.log(`${options.feedbackKey} convergence: ${pendingReplan.length} replan request(s) injected at round 1`);
					}
				}

				const stageResult = await stageTask.run(state, ctx);
				if (stageResult.status === "cancelled") return stageResult;
				if (stageResult.status === "failed") {
					lastErrors = [`${options.feedbackKey} agent failed: ${stageResult.error ?? "unknown error"}`];
					recordArtifactErrors(options, state, lastErrors, `${options.feedbackKey}-agent`);
					setArtifactFeedback(options, state, lastErrors);
					ctx.log(`${options.feedbackKey} convergence: agent failed round ${round} — ${lastErrors.join("; ")}`);
					// F2 (adversarial F2-STALE-PROGRESS): a round that ended without a
					// review produces no fresh blocking-count reading — invalidate the
					// progress signal so the cap extension cannot fire on stale data.
					prevOwnOpen = Number.POSITIVE_INFINITY;
					lastOwnOpen = Number.POSITIVE_INFINITY;
					if (isNonRetryableAgentError(stageResult.error)) throw new FatalAbort(nonRetryableAgentSummary(stageResult.error));
					continue;
				}

				// Stage produced no artifact by design (e.g. design skipped for a bug
				// fix): nothing to validate or review — converge immediately.
				if (options.skipped?.(state)) {
					clearRetryFeedback(state as Record<string, unknown>, options.feedbackKey);
					ctx.log(`${options.feedbackKey} convergence: skipped (no artifact produced) — complete (round ${round})`);
					return { status: "ok" as const, attempts: round };
				}

				// The writer reported ok but produced NO artifact (returned null — e.g. a
				// selected designer timed out). This is a FAILURE, not a skip: retry so a
				// missing artifact never slips past the deterministic + review gates.
				if ((state as Record<string, unknown>)[options.feedbackKey] == null) {
					lastErrors = [`${options.feedbackKey} agent produced no artifact (empty/failed output)`];
					recordArtifactErrors(options, state, lastErrors, `${options.feedbackKey}-empty`);
					setArtifactFeedback(options, state, lastErrors);
					ctx.log(`${options.feedbackKey} convergence: ✗ no artifact produced round ${round} — retrying`);
					// F2 (code-review R1): no artifact = no review = no fresh reading.
					prevOwnOpen = Number.POSITIVE_INFINITY;
					lastOwnOpen = Number.POSITIVE_INFINITY;
					continue;
				}

				// Apply the writer's response matrix to the convergence ledger (mirrors
				// spec-convergence): a prior finding the rewrite claims to have addressed
				// is marked addressed so it stops being re-injected as an active blocker.
				if (options.review) {
					const artifact = (state as Record<string, unknown>)[options.feedbackKey] as ControlObj | undefined;
					const addressed = markConvergenceFindingsAddressedFromResponses(state, artifact?.reviewResponses);
					if (addressed > 0) ctx.log(`${options.feedbackKey} convergence: writer response matrix addressed ${addressed} prior finding(s)`);
				}

				const result = options.validate ? await options.validate(state, ctx) : { pass: true, errors: [] };
				if (!result.pass) {
					lastErrors = result.errors;
					recordArtifactErrors(options, state, lastErrors, `${options.feedbackKey}-validation`);
					setArtifactFeedback(options, state, lastErrors);
					ctx.log(`${options.feedbackKey} convergence: continuing after round ${round}${lastErrors.length ? ` — ${lastErrors.join("; ")}` : ""}`);
					// F2 (adversarial F2-STALE-PROGRESS): same invalidation — see above.
					prevOwnOpen = Number.POSITIVE_INFINITY;
					lastOwnOpen = Number.POSITIVE_INFINITY;
					continue;
				}
				ctx.log(`${options.feedbackKey} convergence: deterministic validation passed round ${round}`);

				// Fagan-style LLM review layer (shift-left). A passed deterministic gate
				// INTENTIONALLY falls through to the reviewer — content quality is judged
				// even when the structural gate passes (a deterministic pass does NOT skip
				// the review). Absent ⇒ deterministic-only.
				if (options.review && reviewTask) {
					const review = options.review;
					const reviewResult = await reviewTask.run(state, ctx);
					if (reviewResult.status === "cancelled") return reviewResult;
					if (reviewResult.status === "failed") {
						lastErrors = [`${review.reviewStateKey} review failed: ${reviewResult.error ?? "unknown error"}`];
						setReviewFeedback(options, state, `${options.feedbackKey} review`, lastErrors);
						ctx.log(`${options.feedbackKey} convergence: ✗ review failed round ${round} — ${lastErrors.join("; ")}`);
						// F2 (code-review R1): review AGENT failure = no fresh reading.
						prevOwnOpen = Number.POSITIVE_INFINITY;
						lastOwnOpen = Number.POSITIVE_INFINITY;
						if (isNonRetryableAgentError(reviewResult.error)) throw new FatalAbort(nonRetryableAgentSummary(reviewResult.error));
						continue;
					}
					const reviewControl = (state as Record<string, unknown>)[review.reviewStateKey] as ControlObj | undefined;
					// The reviewer's verification of prior findings also updates the ledger
					// (a finding it confirms resolved is marked, so it stops blocking).
					const resolved = markConvergenceFindingsAddressedFromResponses(state, reviewControl?.priorFindingResolutions, "reviewer");
					if (resolved > 0) ctx.log(`${options.feedbackKey} convergence: reviewer resolved ${resolved} prior finding(s)`);
					// G1 (run 08-56 moving-target spiral): the convergence-duty
					// contract is enforced DETERMINISTICALLY, not by prompt
					// compliance — from REVIEWER_DUTY_ROUND on, NEW non-High
					// blocking findings become advisory before approval is
					// decided, so a reviewer that ignores the contract can no
					// longer keep the loop open until the cap kills the run.
					reviewRound++;
					const downgraded = enforceReviewerConvergenceDuty(reviewControl, reviewRound, { stage: options.feedbackKey, knownFindingIds: new Set(getConvergenceLedger(state).findings.filter((f) => f.blocking && !f.downgradeReason).map((f) => f.id)) });
					if (downgraded > 0) ctx.log(`${options.feedbackKey} convergence: convergence duty enforced — ${downgraded} new non-High blocking finding(s) downgraded to advisory (round ${round})`);
					// F-A verdict pinning (adversarial G1-NEEDSHUMAN-NOOP): the
					// approval gate uses the VERDICT-layer blocking scan — a
					// needs-human finding pins the verdict only through its own
					// blocking flag / high severity, so the duty downgrade of a
					// late non-high needs-human note actually unblocks approval.
					const approved = (reviewVerdictApproves(reviewControl?.verdict) || downgraded > 0) && !reviewHasBlockingVerdictFinding(reviewControl);
					if (!approved) {
						recordReviewFindingsFromControl(state, reviewControl, { detectedAtStage: review.reviewStateKey, ownerStage: review.ownerStage, sourceGate: `${options.feedbackKey}-review` });
						lastErrors = compactReviewFindings(reviewControl);
						// F2: track this stage's OWN open-blocking count for the
						// strict-progress extension at the cap.
						prevOwnOpen = lastOwnOpen;
						lastOwnOpen = blockingConvergenceFindings(state).filter((f) => f.ownerStage === ownStage).length;
						// HITL escalation triggers (bounded by ESCALATION_RETRY_CAP per stage):
						//  (a) a blocking finding owned by a STRICTLY UPSTREAM stage — the
						//      current writer structurally cannot fix it (e.g. a scope/routing
						//      mismatch owned by `classify`), so escalate IMMEDIATELY rather than
						//      forcing the writer to oscillate for rounds; OR
						//  (b) a STALL — the same blocking signature recurred across rounds.
						const upstreamOwned = blockingConvergenceFindings(state).filter((f) => ownerPrecedes(f.ownerStage, ownStage));
						const signature = blockingSignature(state, review.ownerStage);
						const stalled = signature.length > 0 && signature === priorBlockingSignature;
						priorBlockingSignature = signature;
						if (upstreamOwned.length > 0 || stalled) {
							const escalate = getEscalate(ctx);
							const reason = upstreamOwned.length > 0
								? `${options.feedbackKey} review surfaced blocking finding(s) owned by an upstream stage the ${options.feedbackKey} writer cannot fix: ${upstreamOwned.map((f) => `${f.id} owner=${f.ownerStage}`).join(", ")}`
								: `${options.feedbackKey} review stalled: the same blocking finding(s) recurred across review rounds`;
							const failure: EscalationFailure = {
								kind: "stagnation",
								stage: options.feedbackKey,
								message: `${reason} — ${lastErrors.join("; ")}`,
								severity: "soft",
								worktreePath: state.setup?.worktreePath,
								specDirectory: state.setup?.specDirectory,
								findings: blockingConvergenceFindings(state).filter((f) => f.ownerStage === review.ownerStage || ownerPrecedes(f.ownerStage, ownStage)).slice(0, 6).map((f) => ({ severity: f.severity, title: f.title })),
							};
							let decisionApplied = false;
							if (escalate && escalationBudgetRemaining(state, failure) > 0) {
								ctx.log(`${options.feedbackKey} convergence: ${upstreamOwned.length > 0 ? "UPSTREAM-OWNED blocker" : "STALL"} detected — escalating to user (HITL)`);
							ctx.log(`  blocker: ${failure.message}`);
								const decision = await runEscalation(state, failure, escalate);
								if (decision) {
									decisionApplied = true;
									applyRetryDecision(state, decision, { worktreePath: state.setup?.worktreePath, specDirectory: state.setup?.specDirectory });
									if (decision.choice === "accept-limitation") {
										clearRetryFeedback(state as Record<string, unknown>, options.feedbackKey);
										ctx.log(`${options.feedbackKey} convergence: user accepted the limitation — proceeding (round ${round})`);
										return { status: "ok" as const, attempts: round };
									}
									if (decision.choice === "abandon") {
										throw new FatalAbort(`${options.feedbackKey} convergence: user abandoned the run at review escalation — ${failure.message}`);
									}
									// retry-with-guidance / revise-manually: fall through to another round
									// (guidance was persisted to .user-notes.json for the next attempt).
									priorBlockingSignature = ""; // guidance changes the inputs; reset stall tracking
								}
							}
							// F1 (RC3): headless / dismissed / budget-exhausted escalation
							// returned NO decision — the old code silently continued and the
							// writer oscillated until the round cap killed the run (runs
							// 08-56 / 08-09). Route the upstream-owned blockers back via the
							// replan circuit instead: the run ends "replan", auto-resumes,
							// the OWNING stage revises, and the downstream suffix re-runs.
							if (!decisionApplied && upstreamOwned.length > 0) {
								if (await triggerReplanForFindings(state, ctx, upstreamOwned as unknown as Array<Record<string, unknown>>, options.feedbackKey, state.setup?.specIdentifier ?? "unknown")) {
									ctx.log(`${options.feedbackKey} convergence: ${upstreamOwned.length} upstream-owned blocker(s) routed back via REPLAN (no human decision surface) — restarting to revise the owning stage(s)`);
									throw new FatalAbort(`${options.feedbackKey} convergence: REPLAN — ${upstreamOwned.length} upstream-owned blocker(s) routed back to their owning stage(s); restarting to revise`);
								}
							}
						}
						setReviewFeedback(options, state, `${options.feedbackKey} review`, lastErrors);
						ctx.log(`${options.feedbackKey} convergence: ✗ review rejected round ${round}${lastErrors.length ? ` — ${lastErrors.join("; ")}` : ""}`);
						continue;
					}
					// G1: a downgrade-approval still records the advisory findings
					// (audit trail) before the verified flip discards them.
					if (downgraded > 0) {
						recordReviewFindingsFromControl(state, reviewControl, { detectedAtStage: review.reviewStateKey, ownerStage: review.ownerStage, sourceGate: `${options.feedbackKey}-review` });
						ctx.log(`${options.feedbackKey} convergence: ${downgraded} downgraded finding(s) recorded as advisory on approval`);
					}
					ctx.log(`${options.feedbackKey} convergence: ✓ review approved round ${round}`);
				}

				clearRetryFeedback(state as Record<string, unknown>, options.feedbackKey);
				markConvergenceFindingsVerified(state, (finding) => !finding.downgradeReason && ((finding.ownerStage === normalizeConvergenceStage(options.feedbackKey, options.feedbackKey) && (finding.detectedAtStage === options.feedbackKey || finding.detectedAtStage === "replan")) || (options.review ? finding.detectedAtStage === options.review.reviewStateKey : false)));
				// R3: approval by the owning reviewer VERIFIES the revision — only now
				// may the persisted requests flip to addressed (never on the writer's
				// say-so alone, mirroring the convergence-ledger contract).
				const consumedReplan = consumeReplanRequests(state.setup?.specDirectory, options.feedbackKey);
				if (consumedReplan > 0) ctx.log(`${options.feedbackKey} convergence: ${consumedReplan} replan request(s) verified and marked addressed`);
				ctx.log(`${options.feedbackKey} convergence: complete (round ${round}${round > 1 ? ", after feedback" : ""})`);
				return { status: "ok" as const, attempts: round };
			}

			const msg = `${options.feedbackKey} convergence stopped before all ambiguity/validation issues were resolved because the global agent budget was exhausted after ${round} round(s)${lastErrors.length ? `: ${lastErrors.join("; ")}` : ""}`;
			ctx.log(`${options.feedbackKey} convergence: BUDGET EXHAUSTED (FATAL — aborting run) — ${msg}`);
			throw new FatalAbort(msg);
		},
	};
}

export const requirementsConvergenceNode = artifactConvergenceNode({
	stage: requirementsWriter,
	feedbackKey: "requirements",
	validate: requirementsComplete,
	expected: "An implementation-ready requirements document with concrete AC-NN acceptance criteria, non-functional requirements, and no unresolved open questions.",
	nextAction: "Rewrite the requirements artifact to resolve every open question into explicit acceptance criteria or non-functional constraints before calling structured_output.",
	review: { stage: requirementsReviewWriter, reviewStateKey: "requirementsReview", ownerStage: "requirements" },
});

export const bddConvergenceNode = artifactConvergenceNode({
	stage: bddWriter,
	feedbackKey: "bdd",
	validate: bddComplete,
	expected: "BDD scenarios that cover every requirements AC-NN with no dangling acceptance-criteria references.",
	nextAction: "Rewrite the complete BDD artifact so every AC-NN has scenario coverage, preserving valid scenarios and adding the missing edge/error paths before calling structured_output.",
	review: { stage: bddReviewWriter, reviewStateKey: "bddReview", ownerStage: "bdd" },
});

export const researchConvergenceNode = artifactConvergenceNode({
	stage: researchWriter,
	feedbackKey: "research",
	validate: researchComplete,
	expected: "A source-backed research report with every answerable open issue resolved before downstream assessment/spec work starts.",
	nextAction: "Continue online research until each open issue is answered with source evidence. If a question is genuinely unresolvable because tools are unavailable, explicitly disclose that and mark affected claims unverified instead of leaving it in openIssues.",
});

/** Stage 6 design convergence: the design has no deterministic gate (its quality
 *  is judged only by the design-reviewer's Fagan-style inspection), and it may be
 *  SKIPPED entirely for bug fixes — in which case it produces no artifact and
 *  converges immediately. Otherwise it loops write → review → fix until the
 *  design-reviewer approves (or a stall escalates to the user). */
export const designConvergenceNode = artifactConvergenceNode({
	stage: designStage,
	feedbackKey: "design",
	expected: "A design with defined interface contracts, grounded/feasible architecture, and no requirement/design conflicts, ready for the spec to consume.",
	nextAction: "Revise the design so every module has a defined input/output/error contract, every referenced integration point is grounded in the actual codebase, and it satisfies every requirement without unjustified complexity, before calling structured_output.",
	// Intentional skip is decided by CLASSIFICATION (bug fixes are not redesigned),
	// NOT by `!s.design` — otherwise a designer that timed out (also leaving
	// state.design undefined) would be mistaken for a skip and bypass the review
	// gate. For a non-bug task, an absent design means the designer FAILED → retry.
	skipped: (s) => s.classify?.taskType === "bug",
	review: { stage: designReviewWriter, reviewStateKey: "designReview", ownerStage: "design" },
});
