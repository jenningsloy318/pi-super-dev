import { FatalAbort, gateValidator, task } from "../nodes.ts";
import { clearRetryFeedback, setRetryFeedback, type RetryFeedback } from "../retry-feedback.ts";
import type { ControlObj, Escalate, EscalationFailure, Node, PipelineState, Stage, StageContext } from "../types.ts";
import { isNonRetryableAgentError, nonRetryableAgentSummary } from "../agent-errors.ts";
import { reviewHasBlockingFinding } from "../review-findings.ts";
import { applyRetryDecision, escalationBudgetRemaining, runEscalation } from "../escalation.ts";
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
} from "../convergence-ledger.ts";
import { bddReviewWriter, bddWriter, designReviewWriter, requirementsReviewWriter, requirementsWriter, researchWriter } from "./writers.ts";
import { designStage } from "./design.ts";

type ArtifactValidator = (state: PipelineState, ctx: StageContext) => Promise<{ pass: boolean; errors: string[] }> | { pass: boolean; errors: string[] };

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

export function artifactConvergenceNode(options: ArtifactConvergenceOptions): Node {
	const stageTask = task(options.stage);
	const reviewTask = options.review ? task(options.review.stage) : null;
	return {
		kind: `${options.feedbackKey}-convergence`,
		async run(state: PipelineState, ctx: StageContext) {
			let round = 0;
			let lastErrors: string[] = [];
			let priorBlockingSignature = "";
			while (ctx.budget.check()) {
				round++;
				if (ctx.signal?.aborted) return { status: "cancelled" as const };
				ctx.log(`${options.feedbackKey} convergence: round ${round} starting`);
				if (options.review) delete (state as Record<string, unknown>)[options.review.reviewStateKey];

				const stageResult = await stageTask.run(state, ctx);
				if (stageResult.status === "cancelled") return stageResult;
				if (stageResult.status === "failed") {
					lastErrors = [`${options.feedbackKey} agent failed: ${stageResult.error ?? "unknown error"}`];
					recordArtifactErrors(options, state, lastErrors, `${options.feedbackKey}-agent`);
					setArtifactFeedback(options, state, lastErrors);
					ctx.log(`${options.feedbackKey} convergence: agent failed round ${round} — ${lastErrors.join("; ")}`);
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
					continue;
				}
				ctx.log(`${options.feedbackKey} convergence: deterministic validation passed round ${round}`);

				// Fagan-style LLM review layer (shift-left). Absent ⇒ deterministic-only.
				if (options.review && reviewTask) {
					const review = options.review;
					const reviewResult = await reviewTask.run(state, ctx);
					if (reviewResult.status === "cancelled") return reviewResult;
					if (reviewResult.status === "failed") {
						lastErrors = [`${review.reviewStateKey} review failed: ${reviewResult.error ?? "unknown error"}`];
						setReviewFeedback(options, state, `${options.feedbackKey} review`, lastErrors);
						ctx.log(`${options.feedbackKey} convergence: ✗ review failed round ${round} — ${lastErrors.join("; ")}`);
						if (isNonRetryableAgentError(reviewResult.error)) throw new FatalAbort(nonRetryableAgentSummary(reviewResult.error));
						continue;
					}
					const reviewControl = (state as Record<string, unknown>)[review.reviewStateKey] as ControlObj | undefined;
					// The reviewer's verification of prior findings also updates the ledger
					// (a finding it confirms resolved is marked, so it stops blocking).
					const resolved = markConvergenceFindingsAddressedFromResponses(state, reviewControl?.priorFindingResolutions);
					if (resolved > 0) ctx.log(`${options.feedbackKey} convergence: reviewer resolved ${resolved} prior finding(s)`);
					const approved = reviewVerdictApproves(reviewControl?.verdict) && !reviewHasBlockingFinding(reviewControl);
					if (!approved) {
						recordReviewFindingsFromControl(state, reviewControl, { detectedAtStage: review.reviewStateKey, ownerStage: review.ownerStage, sourceGate: `${options.feedbackKey}-review` });
						lastErrors = compactReviewFindings(reviewControl);
						// Stall detection → HITL escalation. The reviewer keeps flagging the
						// same blocking findings the writer can't fix; ask the user before
						// spinning further (bounded by ESCALATION_RETRY_CAP per stage).
						const signature = blockingSignature(state, review.ownerStage);
						const stalled = signature.length > 0 && signature === priorBlockingSignature;
						priorBlockingSignature = signature;
						if (stalled) {
							const escalate = getEscalate(ctx);
							const failure: EscalationFailure = {
								kind: "stagnation",
								stage: options.feedbackKey,
								message: `${options.feedbackKey} review stalled: the same blocking finding(s) recurred across review rounds — ${lastErrors.join("; ")}`,
								severity: "soft",
								worktreePath: state.setup?.worktreePath,
								specDirectory: state.setup?.specDirectory,
								findings: blockingConvergenceFindings(state).filter((f) => f.ownerStage === review.ownerStage || ownerPrecedes(f.ownerStage, review.ownerStage)).slice(0, 6).map((f) => ({ severity: f.severity, title: f.title })),
							};
							if (escalate && escalationBudgetRemaining(state, failure) > 0) {
								ctx.log(`${options.feedbackKey} convergence: STALL detected — escalating to user (HITL)`);
								const decision = await runEscalation(state, failure, escalate);
								if (decision) {
									applyRetryDecision(state, decision, { worktreePath: state.setup?.worktreePath, specDirectory: state.setup?.specDirectory });
									if (decision.choice === "accept-limitation") {
										clearRetryFeedback(state as Record<string, unknown>, options.feedbackKey);
										ctx.log(`${options.feedbackKey} convergence: user accepted the limitation — proceeding (round ${round})`);
										return { status: "ok" as const, attempts: round };
									}
									if (decision.choice === "abandon") {
										throw new FatalAbort(`${options.feedbackKey} convergence: user abandoned the run at review stall — ${failure.message}`);
									}
									// retry-with-guidance / revise-manually: fall through to another round
									// (guidance was persisted to .user-notes.json for the next attempt).
									priorBlockingSignature = ""; // guidance changes the inputs; reset stall tracking
								}
							}
						}
						setReviewFeedback(options, state, `${options.feedbackKey} review`, lastErrors);
						ctx.log(`${options.feedbackKey} convergence: ✗ review rejected round ${round}${lastErrors.length ? ` — ${lastErrors.join("; ")}` : ""}`);
						continue;
					}
					ctx.log(`${options.feedbackKey} convergence: ✓ review approved round ${round}`);
				}

				clearRetryFeedback(state as Record<string, unknown>, options.feedbackKey);
				markConvergenceFindingsVerified(state, (finding) => (finding.ownerStage === normalizeConvergenceStage(options.feedbackKey, options.feedbackKey) && finding.detectedAtStage === options.feedbackKey) || (options.review ? finding.detectedAtStage === options.review.reviewStateKey : false));
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
