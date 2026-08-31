import { FatalAbort, gateValidator, task } from "../nodes.ts";
import { clearRetryFeedback, setRetryFeedback, withOmissionNotice, type RetryFeedback } from "../retry-feedback.ts";
import type { ControlObj, Escalate, EscalationFailure, Node, PipelineState, Stage, StageContext } from "../types.ts";
import { isNonRetryableAgentError, nonRetryableAgentSummary } from "../agent-errors.ts";
import { enforceReviewerConvergenceDuty, NEGATED_APPROVAL_RE, reviewBlockingVerdictFindings } from "../review-findings.ts";
import { renderAndWrite } from "../render/render.ts";
import { designContractsErrors, readSpecDoc } from "../doc-validators.ts";
import { priorFindingsForInjection } from "../convergence-ledger.ts";
import { applyRetryDecision, escalationBudgetRemaining, runEscalation } from "../escalation.ts";
import { runJudge } from "./judge.ts";
import { countStageRounds } from "../resume.ts";
import {
	blockingConvergenceFindings,
	carriedConvergenceFindings,
	classSweepRetryFeedback,
	convergenceRetryFeedback,
	isActionableOwnerStage,
	markConvergenceFindingsAddressedFromResponses,
	markConvergenceFindingsVerified,
	normalizeConvergenceStage,
	ownerPrecedes,
	recordConvergenceFindings,
	recordReviewFindingsFromControl,
	type ConvergenceOwnerStage,
	getConvergenceLedger,
} from "../convergence-ledger.ts";
import { pendingReplanRequests, consumeReplanRequests, appendRouteBackRequests } from "../replan/replan.ts";
import { RouteBackSignal, isRoutableOwnerStage } from "../routing/router.ts";
import { appendUserNotes } from "../render/user-notes.ts";
import { fastForwardGate, recordConvergedRevision } from "../routing/revision-gate.ts";
import { planInlineRouteBack, bumpOwnerRevision } from "../routing/walker.ts";
import { autoRouteBackEnabled, routeBackReentry } from "../routing/journal.ts";
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
	/** Deterministic validator. OPTIONAL: since v0.3.2 the design stage carries
	 *  `designComplete` (contract-claims sensor — a no-op when the design
	 *  declares no contracts); research still omits this. */
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
	/** M3 G4 (review round-1): OPT-IN to the revision-gate fast-forward. Set
	 *  ONLY where `validate` is a genuine CROSS-DOC trace gate that re-reads
	 *  CURRENT upstream state (requirements/bdd). research has no validator;
	 *  design's designComplete is a contract-claims sensor that does NOT
	 *  re-check against upstream — both stay OUT (conservative re-run). */
	fastForwardable?: boolean;
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
		diagnostics: withOmissionNotice(errors.slice(8, 12), errors),
		nextAction: options.nextAction,
	};
	setRetryFeedback(state as Record<string, unknown>, options.feedbackKey, [feedback]);
}

/** v0.3.32 (runs 2026-08-30T00-10-34-032Z / 03-23-40-576Z): the writer stages
 *  (design.ts, writerTask) record the EXACT schema/render validation errors on
 *  the state here when renderAndWrite rejects a control. Read-and-clear, so a
 *  slot never leaks into a later round. */
function readRenderErrors(state: PipelineState): string[] {
	const stateRec = state as Record<string, unknown>;
	const v = stateRec.__renderErrors;
	delete stateRec.__renderErrors;
	return Array.isArray(v) ? v.map(String).slice(0, 8) : [];
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
function setReviewFeedback(options: ArtifactConvergenceOptions, state: PipelineState, source: string, errors: string[]): void {
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
export const MAX_TOTAL_ROUND_MULTIPLE = 3;

export function effectiveRoundCap(maxRounds: number, priorRounds: number): number {
	return Math.min(priorRounds + maxRounds, maxRounds * MAX_TOTAL_ROUND_MULTIPLE);
}

/** AC-17 (SCENARIO-037): the one-shot strict-progress extension, re-clamped to
 *  the 3× cumulative ceiling — effectiveCap can NEVER exceed maxRounds × 3
 *  (from 10 it yields 14; from 22 or 24 it yields 24; never 28). */
export function extendedRoundCap(effectiveCap: number, maxRounds: number): number {
	return Math.min(effectiveCap + PROGRESS_EXTENSION_ROUNDS, maxRounds * MAX_TOTAL_ROUND_MULTIPLE);
}

export function artifactConvergenceNode(options: ArtifactConvergenceOptions): Node {
	const stageTask = task(options.stage);
	const reviewTask = options.review ? task(options.review.stage) : null;
	return {
		kind: `${options.feedbackKey}-convergence`,
		// M2 addressable-walker anchor: the routing sub-walk finds this node by id.
		id: options.feedbackKey,
		async run(state: PipelineState, ctx: StageContext) {
			// M3 G4: revision-gate green-skip. After an inline route-back jump,
			// stages between the owner and the thrower already converged this
			// process with an UNCHANGED artifact revision and no pending
			// requests — re-running their full writer+reviewer loop is pure
			// waste. The gate fires only when a jump was journaled (inert on
			// fresh/kill-switch runs) AND the stage's deterministic validator
			// re-passes against CURRENT upstream state (research has no
			// validator → never fast-forwards → conservatively re-runs).
			if (options.fastForwardable === true && await fastForwardGate(state, ctx, options.feedbackKey, state.setup?.specDirectory, options.validate)) {
				return { status: "ok" as const, attempts: 0 };
			}
			const maxRounds = options.maxRounds ?? MAX_CONVERGENCE_ROUNDS;
			// F3 (RC2): a resumed run REPLAYS this loop's prior rounds as cache hits
			// (rebuilding retry feedback + ledger state) and must then get FRESH
			// rounds — the old static cap fired right after the replay and re-killed
			// the run before any fresh call (runs 02-47 / 06-02). countStageRounds
			// reads the persisted occurrence count; fresh runs see 0.
			const priorRounds = state.setup?.specDirectory ? countStageRounds(state.setup.specDirectory, `pipeline.${options.stage.id}`) : 0;
			// v0.3.24 S3: a route-back re-entry is a REVISION walk, not a durable
			// resume — the recorded rounds belong to a PREVIOUS walk segment, and
			// granting them the resume-style `prior + cap` budget inflated run
			// 2026-08-28T13-04-28-485Z's deadlocked requirements loop from its base
			// cap to 8 rounds before the fatal. Reset to segment scope; repeated
			// re-entries stay bounded by the per-edge JUMP budget (the walker's
			// anti-ping-pong bound), not by replayed-round arithmetic.
			const segmentReentry = routeBackReentry(state.setup?.specDirectory, options.feedbackKey);
			let effectiveCap = effectiveRoundCap(maxRounds, segmentReentry ? 0 : priorRounds);
			if (segmentReentry) {
				ctx.log(`${options.feedbackKey} convergence: route-back re-entry (journal) — round budget reset to segment scope (${maxRounds}); jump budget bounds re-entry cycles`);
			} else if (effectiveCap > maxRounds) ctx.log(`${options.feedbackKey} convergence: resuming after ${priorRounds} recorded round(s) — round budget extended to ${effectiveCap} (replayed rounds do not consume the fresh budget)`);
			// AC-17 (SCENARIO-038): the recorded REVIEW rounds of THIS loop — strict
			// progress may only arm on a FRESH (cache-miss) review reading; a replayed
			// reading carries no fresh information and must never earn the extension.
			const priorReviewRounds = options.review && state.setup?.specDirectory
				? countStageRounds(state.setup.specDirectory, `pipeline.${options.review.stage.id}`)
				: 0;
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
							// B4 (D10): an escalate-now verdict may only abort the run when it
							// carries at least one NON-EMPTY evidence entry — an evidence-less
							// diagnosis (the judge's degrade-to-escalate path) is advisory, not
							// fatal; log it and fall through to the normal cap path.
							// v0.3.24 S4-4: widened from quote-only via judgeEscalateEvidencePresent.
							const hasEvidence = judgeEscalateEvidencePresent(out.verdict.evidence);
							if (hasEvidence) {
								ctx.log(`${options.feedbackKey} convergence: JUDGE ESCALATE — ${out.verdict.diagnosis}`);
								// D10: the fatal reports the EFFECTIVE cap (replayed rounds
								// included), never the base maxRounds.
								throw new FatalAbort(`${options.feedbackKey} convergence did not converge within ${effectiveCap} round(s): ${out.verdict.diagnosis}`);
							}
							ctx.log(`${options.feedbackKey} convergence: judge escalate-now verdict carried no verbatim evidence — falling through to the round-cap path`);
						}
					} catch (err) {
						if (err instanceof FatalAbort) throw err;
						/* INV-6: judge infra failure never blocks the loop */
					}
				}
				// AC-17 (SCENARIO-038): the cap gate also requires a FRESH round —
				// replayed rounds (round ≤ priorRounds) never fatal/extend/replan, so at
				// priorRounds ≥ 3×cap exactly ONE fresh writer round (priorRounds + 1)
				// executes before the fatal at priorRounds + 2 (fresh-run behavior is
				// unchanged: priorRounds = 0 ⇒ the gate is round > 1).
				if (round > effectiveCap && round > priorRounds + 1) {
					// F2 (RC1): strict progress at the cap — the loop resolved more of
					// its own blockers than it gained last round. Grant ONE bounded
					// extension instead of killing productive work (run 02-16 resolved
					// findings every round and still hit the cap's FatalAbort).
					if (!progressExtensionUsed && prevOwnOpen !== Number.POSITIVE_INFINITY && lastOwnOpen < prevOwnOpen && lastOwnOpen > 0) {
						progressExtensionUsed = true;
						// AC-17 (SCENARIO-037): the extension is re-clamped to the 3× ceiling.
						effectiveCap = extendedRoundCap(effectiveCap, maxRounds);
						ctx.log(`${options.feedbackKey} convergence: cap extended to ${effectiveCap} — strict progress (own open blocking ${prevOwnOpen === Number.POSITIVE_INFINITY ? "?" : prevOwnOpen} → ${lastOwnOpen})`);
					} else {
						// F1/M5: before the fatal, route upstream-owned blockers back —
						// INLINE only (the emulation is retired for routing; the extension
						// auto-restart survives solely for the RED-site lead and genuine
						// cross-run interruptions). A declined jump proceeds to the honest
						// cap fatal below (the escalation surface already fired in-loop).
						// v0.3.48: non-routable upstream owners (classify) cannot drive a cap
						// route either — exclude them from the cap-escalation predicate (they
						// were downgraded to carried advisory at the review site).
						const upstreamAtCap = blockingConvergenceFindings(state).filter((f) => isRoutableOwnerStage(f.ownerStage) && ownerPrecedes(f.ownerStage, ownStage));
						if (upstreamAtCap.length > 0) {
							const inlineAtCap = planInlineRouteBack(state.setup?.specDirectory, options.feedbackKey, upstreamAtCap);
							if (inlineAtCap) {
								ctx.log(`${options.feedbackKey} convergence: INLINE route-back ${inlineAtCap.from}→${inlineAtCap.to} at round cap (budget checked) — throwing RouteBackSignal for the walker`);
								throw new RouteBackSignal(inlineAtCap);
							}
							ctx.log(`${options.feedbackKey} convergence: ${upstreamAtCap.length} upstream-owned blocker(s) at round cap but the route-back declined (budget/kill-switch) — proceeding to the honest cap fatal`);
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
				// M8 (SCENARIO-039/040): true when THIS round's convergence is a genuine
				// reviewer approval. Defaults to true for review-less loops (research):
				// with no reviewer verdict, the deterministic gate's pass IS the approval
				// and replan consumption keeps its existing behavior.
				let genuineApproval = !options.review;

				// R3 (dsh-09 v3): pending replan requests owned by this stage inject as
				// convergence-ledger findings at round 1 — the EXISTING
				// writer-revises-per-finding machinery performs the revision. Dedup by
				// fingerprint keeps restarts idempotent.
				if (round === 1) {
					// v0.3.3 L1: unresolved BLOCKING findings from a prior run's
					// persisted ledger inject at round 1 (the resume/restart path —
					// the ledger itself restarts empty, but its residue must not).
					// Fingerprint merge in recordConvergenceFindings keeps this
					// idempotent across repeated restarts. sd33 self-audit: feedback
					// calls REPLACE the key's array (setRetryFeedback), so the
					// prior-run lines and the replan lines below must be merged into
					// ONE setArtifactFeedback call or the second wipes the first.
					const round1Lines: string[] = [];
					const prior = priorFindingsForInjection(state.setup?.specDirectory);
					if (prior.findings.length > 0 || prior.omitted > 0) {
						// sd33 ADV-SD33-3: record ALL unresolved rows (the file's
						// completeness survives restarts); cap only the FEEDBACK lines.
						recordConvergenceFindings(state, prior.findings.map((f) => ({
							id: f.id,
							ownerStage: f.ownerStage,
							title: f.title,
							detail: f.detail,
							severity: f.severity,
							evidence: f.evidence,
							recommendation: f.recommendation,
							defectClass: f.defectClass,
							status: f.status,
							blocking: true,
						})), { detectedAtStage: options.feedbackKey, ownerStage: normalizeConvergenceStage(options.feedbackKey, options.feedbackKey), sourceGate: "prior-run-ledger" });
						round1Lines.push(
							// sd33 CODE-SD33-9: prior-run lines capped at 6 so replan
							// directives (below) always fit the feedback `missing` slice.
							...prior.findings.slice(0, 6).map((f) => `[prior-run finding ${f.id}] ${f.title}${f.ownerStage ? ` (owner: ${f.ownerStage})` : ""}`),
							...(prior.omitted > 0 || prior.findings.length > 6 ? [`…(+${Math.max(prior.omitted, prior.findings.length - 6)} more prior-run blocking finding(s) — see .convergence-ledger.json)`] : []),
						);
						ctx.log(`${options.feedbackKey} convergence: ${prior.findings.length} prior-run blocking finding(s) injected at round 1${prior.omitted > 0 ? ` (+${prior.omitted} omitted)` : ""}`);
					}
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
						round1Lines.push(...pendingReplan.map((r) => `[replan request ${r.id}] ${r.requestedRevision}`));
						ctx.log(`${options.feedbackKey} convergence: ${pendingReplan.length} replan request(s) injected at round 1`);
					}
					// Replan directives lead (they are explicit revision orders);
					// prior-run residue follows within the slice budget.
					if (round1Lines.length > 0) setArtifactFeedback(options, state, round1Lines);
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
					recordConvergedRevision(state, options.feedbackKey, state.setup?.specDirectory);
					return { status: "ok" as const, attempts: round };
				}

				// The writer reported ok but produced NO artifact (returned null — e.g. a
				// selected designer timed out). This is a FAILURE, not a skip: retry so a
				// missing artifact never slips past the deterministic + review gates.
				// v0.3.32: when the stage recorded schema/render errors (design.ts /
				// writerTask), surface THOSE — the generic "empty/failed output" line
				// starved the retries of the one actionable fact (which field, which
				// type) in runs 2026-08-30T00-10-34 (aborted after 6 rounds) and
				// 03-23-40 (8 wasted rounds before a lucky valid control).
				const renderErrs = readRenderErrors(state);
				if ((state as Record<string, unknown>)[options.feedbackKey] == null) {
					lastErrors = renderErrs.length > 0
						? [`${options.feedbackKey} control rejected by schema/render validation — fix these exact fields:`, ...renderErrs]
						: [`${options.feedbackKey} agent produced no artifact (empty/failed output)`];
					recordArtifactErrors(options, state, lastErrors, renderErrs.length > 0 ? `${options.feedbackKey}-render` : `${options.feedbackKey}-empty`);
					setArtifactFeedback(options, state, lastErrors);
					ctx.log(`${options.feedbackKey} convergence: ✗ no artifact produced round ${round}${renderErrs.length > 0 ? ` — ${renderErrs.join("; ")}` : " — retrying"}`);
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
				// v0.3.32: a writer control that PASSED validation but FAILED
				// schema/render (writerTask returns the control and renderAndWrite
				// returned null) means NO fresh doc on disk — the gates would keep
				// passing against the STALE doc (the code-review R2 stale-doc hole).
				// Fold the recorded render errors in so the round retries instead.
				if (!result.pass || renderErrs.length > 0) {
					lastErrors = [...result.errors, ...renderErrs];
					recordArtifactErrors(options, state, lastErrors, renderErrs.length > 0 ? `${options.feedbackKey}-render` : `${options.feedbackKey}-validation`);
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
					// AC-17 (SCENARIO-038): a reading past the recorded review rounds is
					// FRESH; a cache-replayed reading carries no fresh information and
					// must never arm the strict-progress extension.
					const freshReviewReading = reviewRound > priorReviewRounds;
					const downgraded = enforceReviewerConvergenceDuty(reviewControl, reviewRound, {
						stage: options.feedbackKey,
						knownFindingIds: new Set(getConvergenceLedger(state).findings.filter((f) => f.blocking && !f.downgradeReason).map((f) => f.id)),
						// M22 (SCENARIO-068): verbatim restatements of live blocking ledger
						// findings are shielded from the downgrade by convergence fingerprint.
						knownBlockingFingerprints: new Set(getConvergenceLedger(state).findings.filter((f) => f.blocking && !f.downgradeReason).map((f) => f.fingerprint)),
						reviewSourceGate: `${options.feedbackKey}-review`,
					});
					if (downgraded > 0) {
						ctx.log(`${options.feedbackKey} convergence: convergence duty enforced — ${downgraded} new non-High blocking finding(s) downgraded to advisory (round ${round})`);
						// B8 (fix-in-pass, SCENARIO-068): the enforcement MUTATED the review
						// control in place — re-render the review doc (per-slug reuse via
						// renderAndWrite, idempotent) so the on-disk artifact matches the
						// enforced classifications instead of the stale agent-authored ones.
						// Best-effort: a schema-invalid control renders nothing (null) and a
						// failed write must never kill the convergence loop.
						try {
							if (state.setup) renderAndWrite(state.setup, (m) => ctx.log(m), options.review.stage.id, reviewControl as Record<string, unknown>);
						} catch { /* best-effort re-render */ }
					}
					// F-A verdict pinning (adversarial G1-NEEDSHUMAN-NOOP): the
					// approval gate uses the VERDICT-layer blocking scan — a
					// needs-human finding pins the verdict only through its own
					// blocking flag / high severity, so the duty downgrade of a
					// late non-high needs-human note actually unblocks approval.
					// M8 (SCENARIO-039/040): a duty override may converge the loop, but it is
					// NOT a reviewer approval — replan consumption and the replan verified-flip
					// below are gated on the GENUINE verdict signal alone.
					genuineApproval = reviewVerdictApproves(reviewControl?.verdict);
					// v0.3.24 S1: the verdict gate is OWNER-AWARE — this loop may only be
					// pinned by findings its own stage (or an upstream route-back) can act
					// on. Blocking findings owned by a DOWNSTREAM stage are carried debt:
					// they persist in the ledger and re-inject at the owner's round 1
					// (the v0.3.3 machinery — how the debt reached this loop at all), so
					// they must not keep THIS loop open. Run 2026-08-28T13-04-28-485Z: six
					// rounds rejected solely on bdd-owned blockers after a v0.3.19
					// auto-route-back re-entry — including a literal "Approved" verdict at
					// round 7 — until ROUND CAP 8 killed the run (a textbook wait-for-graph
					// cycle: this loop waits on bdd; bdd waits for this loop to converge).
					const verdictBlocking = reviewBlockingVerdictFindings(reviewControl);
					const verdictCarried = verdictBlocking.filter((f) => !isActionableOwnerStage((f as { ownerStage?: unknown }).ownerStage, ownStage));
					// actionable verdict-blockers (own/upstream/unknown owner) still pin the
					// verdict exactly as before — ONLY the downstream-owned subset stops
					// pinning (it is carried debt for the owner stage instead).
					const approved = (genuineApproval || downgraded > 0) && (verdictBlocking.length - verdictCarried.length) === 0;
					if (!approved && verdictCarried.length > 0) {
						// v0.3.24 S2: deterministic wait-for-graph resolution — every open
						// blocking finding is owned by a stage this loop cannot reach without
						// exiting. Exit CONVERGED-CARRIED instead of spinning to the cap: the
						// walk continues to the owner, which receives the debt at its round 1.
						const ownActionableOpen = blockingConvergenceFindings(state).filter((f) => isActionableOwnerStage(f.ownerStage, ownStage));
						if (ownActionableOpen.length === 0 && verdictBlocking.length === verdictCarried.length) {
							recordReviewFindingsFromControl(state, reviewControl, { detectedAtStage: review.reviewStateKey, ownerStage: review.ownerStage, sourceGate: `${options.feedbackKey}-review-carried` });
							clearRetryFeedback(state as Record<string, unknown>, options.feedbackKey);
							ctx.log(`${options.feedbackKey} convergence: CONVERGED-CARRIED (round ${round}) — every open blocking finding is owned downstream (${carriedConvergenceFindings(state, ownStage).map((f) => `${f.id} owner=${f.ownerStage}`).join(", ")}); no ${options.feedbackKey} rewrite can close them. The walk continues to the owner stage, where they re-inject at its round 1.`);
							// review-2 F1: DELIVER the debt (pending replan requests + owner
							// revision bump) and deliberately do NOT recordConvergedRevision —
							// this exit is a harness-forced pass with open blockers, and the
							// revision-gate invariant says only a GENUINE approval may make the
							// artifact green-skippable in later sub-walks.
							deliverCarriedDebt(state, ownStage, ctx.log);
							return { status: "ok" as const, attempts: round };
						}
					}
					if (!approved) {
						recordReviewFindingsFromControl(state, reviewControl, { detectedAtStage: review.reviewStateKey, ownerStage: review.ownerStage, sourceGate: `${options.feedbackKey}-review` });
						lastErrors = compactReviewFindings(reviewControl);
						// F2: track this stage's OWN open-blocking count for the
						// strict-progress extension at the cap — FRESH readings only.
						if (freshReviewReading) {
							prevOwnOpen = lastOwnOpen;
							lastOwnOpen = blockingConvergenceFindings(state).filter((f) => f.ownerStage === ownStage).length;
						} else {
							// M7/adv-B/B5: a cache-replayed reading carries no fresh
							// information — the extension can never be granted on it.
							prevOwnOpen = Number.POSITIVE_INFINITY;
							lastOwnOpen = Number.POSITIVE_INFINITY;
						}
						// HITL escalation triggers (bounded by ESCALATION_RETRY_CAP per stage):
						//  (a) a blocking finding owned by a STRICTLY UPSTREAM stage — the
						//      current writer structurally cannot fix it (e.g. a scope/routing
						//      mismatch owned by `classify`), so escalate IMMEDIATELY rather than
						//      forcing the writer to oscillate for rounds; OR
						//  (b) a STALL — the same blocking signature recurred across rounds.
						// v0.3.48 non-routable-owner downgrade: ownerPrecedes accepts ANY
						// strictly-upstream stage, but the routing graph can only re-enter
					// the closed REPLAN_OWNER_STAGES set. A blocker owned by a
					// NON-routable upstream stage (classify is the live case —
					// run 2026-08-31T02-56: task-classifier's deterministic fallback
					// wrote uiScope=none for a UI-heavy app; the reviewer correctly
					// flagged owner=classify; planInlineRouteBack can NEVER route it;
					// headless HITL then aborted the run on a defect the artifact
					// cannot fix). Such findings become carried advisory debt with a
					// loud log — the run continues on its real (routable/own) blockers.
						const routableUpstream = blockingConvergenceFindings(state).filter((f) => isRoutableOwnerStage(f.ownerStage) && ownerPrecedes(f.ownerStage, ownStage));
						const nonRoutableUpstream = blockingConvergenceFindings(state).filter((f) => !isRoutableOwnerStage(f.ownerStage) && ownerPrecedes(f.ownerStage, ownStage));
						if (nonRoutableUpstream.length > 0) {
							for (const f of nonRoutableUpstream) {
								f.blocking = false;
								f.downgradeReason = `owner ${f.ownerStage} is not routable mid-run (v0.3.48) — carried advisory debt; fix the classification in the task/config for the next run`;
							}
							ctx.log(`${options.feedbackKey} convergence: ${nonRoutableUpstream.length} upstream-owned blocker(s) downgraded to CARRIED ADVISORY (owner stage${nonRoutableUpstream.length === 1 ? "" : "s"} ${[...new Set(nonRoutableUpstream.map((f) => f.ownerStage))].join(", ")} not routable mid-run): ${nonRoutableUpstream.map((f) => f.id).join(", ")} — the run continues on its actionable blockers`);
						}
						const upstreamOwned = routableUpstream;
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
								// M4 (G6): exactly-one routable upstream owner → offer
								// "Route back to ⟨owner⟩ (recommended)" first.
								routeBackOwner: [...new Set(upstreamOwned.map((f) => f.ownerStage))]
									.filter((o, _i, arr) => arr.length === 1 && isRoutableOwnerStage(o))[0],
							};
							let decision: import("../types.ts").EscalationDecision | undefined;
							// v0.3.19 AUTO-ROUTE: when the blocker analysis itself already
							// resolves the fix path — exactly ONE routable strictly-upstream
							// owner and a per-edge jump budget that allows it — route DIRECTLY,
							// no human round-trip (run 2026-08-27T00-59-52: a BDD contradiction
							// with a crisp owner=requirements recommendation burned a full HITL
							// wait only for the user to click "route back"). Since M5 the wait
							// was already ceremonial for this shape — every non-run-level choice
							// routes identically; the run-level overrides (accept-limitation /
							// abandon) remain reachable via SUPER_DEV_NO_AUTO_ROUTEBACK=1.
							// Budget-exhausted, multi-owner, non-routable, or kill-switched
							// cases fall through to the HITL escalation below unchanged.
							if (upstreamOwned.length > 0 && autoRouteBackEnabled()) {
								const autoCmd = planInlineRouteBack(state.setup?.specDirectory, options.feedbackKey, upstreamOwned);
								if (autoCmd) {
									// Audit trail: the SAME report surface, decision marked
									// machine-taken (route-back-auto), so the auto-jump is never
									// silent. Best-effort — a report failure must not block recovery.
									try {
									const { writeEscalationReport } = await import("../render/escalation-report.ts");
									writeEscalationReport({ ...failure, message: `[auto-route: single upstream owner "${autoCmd.to}" — routed without HITL; kill-switch SUPER_DEV_NO_AUTO_ROUTEBACK=1 restores the human prompt]\n\n${failure.message}` }, { choice: "route-back-auto" }, state.setup?.specDirectory);
								} catch { /* best-effort audit */ }
								ctx.log(`${options.feedbackKey} convergence: UPSTREAM-OWNED blocker detected — AUTO-ROUTE ${autoCmd.from}→${autoCmd.to} (single routable owner, budget checked, no HITL; SUPER_DEV_NO_AUTO_ROUTEBACK=1 restores the prompt)`);
								ctx.log(`  blocker: ${failure.message}`);
								throw new RouteBackSignal(autoCmd);
							}
							}
							if (escalate && escalationBudgetRemaining(state, failure) > 0) {
								ctx.log(`${options.feedbackKey} convergence: ${upstreamOwned.length > 0 ? "UPSTREAM-OWNED blocker" : "STALL"} detected — escalating to user (HITL)`);
								ctx.log(`  blocker: ${failure.message}`);
								decision = await runEscalation(state, failure, escalate);
							}
							// M5: genuine human overrides are respected FIRST — these two
							// express a decision about the RUN, not about which actuator fixes it.
							if (decision?.choice === "accept-limitation") {
								applyRetryDecision(state, decision, { worktreePath: state.setup?.worktreePath, specDirectory: state.setup?.specDirectory });
								clearRetryFeedback(state as Record<string, unknown>, options.feedbackKey);
								ctx.log(`${options.feedbackKey} convergence: user accepted the limitation — proceeding (round ${round})`);
								return { status: "ok" as const, attempts: round };
							}
							if (decision?.choice === "abandon") {
								throw new FatalAbort(`${options.feedbackKey} convergence: user abandoned the run at review escalation — ${failure.message}`);
							}
							// M5 — the interactive decision suppression is DELETED: upstream-
							// owned blockers route REGARDLESS of the choice (route-back,
							// retry-with-guidance, revise-manually) or the headless no-decision.
							// The run-03-23-47 interactive sibling (retry-with-guidance on an
							// upstream-owned blocker → the writer retried what it cannot fix →
							// oscillation → cap) is dead. A retry-with-guidance decision in
							// hand persists its guidance (the owner reads it at re-entry);
							// applyRetryDecision itself is NOT called (M4 contract: no
							// worktree rollback on the routed path).
							if (upstreamOwned.length > 0) {
								const inlineCmd = planInlineRouteBack(state.setup?.specDirectory, options.feedbackKey, upstreamOwned);
								if (inlineCmd) {
									if (decision?.choice === "retry-with-guidance" && decision.guidance?.trim()) {
										try { appendUserNotes(state.setup?.specDirectory, [decision.guidance.trim()]); } catch { /* best-effort */ }
										ctx.log(`${options.feedbackKey} convergence: retry-with-guidance chosen but the blocker is upstream-owned — routing anyway; guidance persisted for the owner`);
									}
									ctx.log(`${options.feedbackKey} convergence: INLINE route-back ${inlineCmd.from}→${inlineCmd.to} (budget checked)${decision?.choice === "route-back" ? " (user-chosen)" : ""} — throwing RouteBackSignal for the walker`);
									throw new RouteBackSignal(inlineCmd);
								}
								// M5 — the emulation is retired for routing: a declined jump
								// (budget exhausted / kill-switch / scope) is an honest fatal.
								// The escalation surface fired above (interactive choice or
								// headless report); there is NO automatic process restart.
								throw new FatalAbort(`${options.feedbackKey} convergence: route-back declined (edge budget exhausted or kill-switch — ${upstreamOwned.length} upstream-owned blocker(s) persist: ${upstreamOwned.map((f) => f.id).join(", ")}) — the escalation surface was offered when available and no automatic restart remains (M5 retirement) — ${failure.message}`);
							}
							// Stall-only residue: retry-with-guidance / revise-manually keep
							// their same-stage semantics (rollback + persisted guidance).
							if (decision) {
								applyRetryDecision(state, decision, { worktreePath: state.setup?.worktreePath, specDirectory: state.setup?.specDirectory });
								priorBlockingSignature = ""; // guidance changes the inputs; reset stall tracking
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
					// v0.3.24 S1: an approval that carries downstream-owned debt records
					// it too — the ledger is the transport to the owner stage, and the
					// verified flip below now skips downstream rows (they must stay open
					// so the owner's round-1 injection re-arms them).
					if (verdictCarried.length > 0) {
						recordReviewFindingsFromControl(state, reviewControl, { detectedAtStage: review.reviewStateKey, ownerStage: review.ownerStage, sourceGate: `${options.feedbackKey}-review-carried` });
						ctx.log(`${options.feedbackKey} convergence: ✓ review approved round ${round} with ${verdictCarried.length} carried downstream-owned blocking finding(s) — they remain open for the owner stage`);
					} else {
						ctx.log(`${options.feedbackKey} convergence: ✓ review approved round ${round}`);
					}
				}

				clearRetryFeedback(state as Record<string, unknown>, options.feedbackKey);
				markConvergenceFindingsVerified(state, (finding) => !finding.downgradeReason && (
					(finding.ownerStage === ownStage && finding.detectedAtStage === options.feedbackKey) ||
					// v0.3.24 S1: the review-detected flip now requires an ACTIONABLE
					// owner — a downstream-owned finding detected by this review must NOT
					// be verified here (that would erase the carried debt before the
					// owner stage ever sees it; run 13-04-28's bdd rows would have been
					// silently closed by a requirements approval).
					(options.review && isActionableOwnerStage(finding.ownerStage, ownStage) ? finding.detectedAtStage === options.review.reviewStateKey : false) ||
					(genuineApproval && finding.ownerStage === ownStage && finding.detectedAtStage === "replan")
				));
				if (genuineApproval) {
					// R3 (SCENARIO-040): approval by the owning reviewer VERIFIES the revision —
					// only now may the persisted requests flip to addressed (never on the
					// writer's say-so alone, and never on a duty override — SCENARIO-039).
					const consumedReplan = consumeReplanRequests(state.setup?.specDirectory, options.feedbackKey);
					if (consumedReplan > 0) ctx.log(`${options.feedbackKey} convergence: ${consumedReplan} replan request(s) verified and marked addressed`);
				}
				ctx.log(`${options.feedbackKey} convergence: complete (round ${round}${round > 1 ? ", after feedback" : ""})`);
				recordConvergedRevision(state, options.feedbackKey, state.setup?.specDirectory);
				return { status: "ok" as const, attempts: round };
			}

			const msg = `${options.feedbackKey} convergence stopped before all ambiguity/validation issues were resolved because the global agent budget was exhausted after ${round} round(s)${lastErrors.length ? `: ${lastErrors.join("; ")}` : ""}`;
			ctx.log(`${options.feedbackKey} convergence: BUDGET EXHAUSTED (FATAL — aborting run) — ${msg}`);
			throw new FatalAbort(msg);
		},
	};
}

export const requirementsConvergenceNode = artifactConvergenceNode({
	fastForwardable: true,
	stage: requirementsWriter,
	feedbackKey: "requirements",
	validate: requirementsComplete,
	expected: "An implementation-ready requirements document with concrete AC-NN acceptance criteria, non-functional requirements, and no unresolved open questions.",
	nextAction: "Rewrite the requirements artifact to resolve every open question into explicit acceptance criteria or non-functional constraints before calling structured_output.",
	review: { stage: requirementsReviewWriter, reviewStateKey: "requirementsReview", ownerStage: "requirements" },
});

export const bddConvergenceNode = artifactConvergenceNode({
	fastForwardable: true,
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

/** v0.3.2 C1: the design stage's deterministic sensor. Historically the design
 *  had NO deterministic gate (quality judged only by the reviewer) — which is
 *  exactly how run 2026-08-20T06-19-50-494Z died: a machine-checkable contract
 *  inconsistency (over-restrictive artifact-name validation) was discovered by
 *  the reviewer one filename family per round across 4 rounds. When the design
 *  control DECLARES contract claims, this validator checks internal consistency
 *  (pattern compiles; every enumerated value matches its own pattern — ALL
 *  violations at once; source anchor exists; uniqueness holds) AND that the
 *  rendered doc actually carries the Contract Claims section (the
 *  control-had-data-the-template-dropped class, run 2026-08-12). No claims ⇒
 *  pass unchanged (backward-compatible). */
export const designComplete: ArtifactValidator = async (s: PipelineState, ctx: StageContext) => {
	const control = s.design as ControlObj | undefined;
	const rawClaims = (control as { contracts?: unknown } | undefined)?.contracts;
	if (!Array.isArray(rawClaims) || rawClaims.length === 0) return { pass: true, errors: [] };
	const worktreePath = s.setup?.worktreePath ?? "";
	const errors = designContractsErrors(control, worktreePath);
	// Rendered-doc parity: the reviewer reads the RENDERED design — a contracts
	// block the template dropped makes the reviewer blind and the loop spin.
	const doc = readSpecDoc(s.setup?.specDirectory ?? "", control, "*-design.md");
	if (doc && !doc.content.includes("## Contract Claims")) {
		errors.push("design declares contract claims but the rendered design doc has no '## Contract Claims' section — the enumeration must be visible to the reviewer");
	}
	if (errors.length) ctx.log(`Design contracts: ${errors.length} contract-claim error(s): ${errors.slice(0, 2).join("; ")}`);
	return { pass: errors.length === 0, errors };
};

/** Stage 6 design convergence: since v0.3.2 the design carries ONE deterministic
 *  sensor (`designComplete` — contract-claims consistency; a no-op when the
 *  design declares no contracts); overall quality is judged by the
 *  design-reviewer's Fagan-style inspection, and it may be
 *  SKIPPED entirely for bug fixes — in which case it produces no artifact and
 *  converges immediately. Otherwise it loops write → review → fix until the
 *  design-reviewer approves (or a stall escalates to the user). */
export const designConvergenceNode = artifactConvergenceNode({
	stage: designStage,
	feedbackKey: "design",
	// v0.3.2 C1: contract-claims sensor (no-op when the design declares none).
	validate: designComplete,
	expected: "A design with defined interface contracts, grounded/feasible architecture, and no requirement/design conflicts, ready for the spec to consume.",
	nextAction: "Revise the design so every module has a defined input/output/error contract, every referenced integration point is grounded in the actual codebase, and it satisfies every requirement without unjustified complexity, before calling structured_output.",
	// Intentional skip is decided by CLASSIFICATION (bug fixes are not redesigned),
	// NOT by `!s.design` — otherwise a designer that timed out (also leaving
	// state.design undefined) would be mistaken for a skip and bypass the review
	// gate. For a non-bug task, an absent design means the designer FAILED → retry.
	skipped: (s) => s.classify?.taskType === "bug",
	review: { stage: designReviewWriter, reviewStateKey: "designReview", ownerStage: "design" },
});
