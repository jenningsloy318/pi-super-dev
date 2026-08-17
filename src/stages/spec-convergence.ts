import { FatalAbort, gateValidator, task } from "../nodes.ts";
import { clearRetryFeedback, setRetryFeedback, type RetryFeedback } from "../retry-feedback.ts";
import type { ControlObj, Node, PipelineState, StageContext } from "../types.ts";
import { reviewHasBlockingFinding } from "../review-findings.ts";
import { isNonRetryableAgentError, nonRetryableAgentSummary } from "../agent-errors.ts";
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
import { pendingReplanRequests, consumeReplanRequests } from "../replan/replan.ts";
import { specReviewWriter, specWriter } from "./writers.ts";
import { MAX_CONVERGENCE_ROUNDS, PROGRESS_EXTENSION_ROUNDS } from "./artifact-convergence.ts";
import { countStageRounds } from "../resume.ts";
import { triggerReplanForFindings } from "../replan/replan.ts";

const specTask = task(specWriter);
const specReviewTask = task(specReviewWriter);
const validateSpecTrace = gateValidator("gate-spec-trace", "write-spec", "spec");
const validateSpecReview = gateValidator("gate-spec-review", "review-spec", "specReview");

function setSpecFeedback(state: PipelineState, source: string, errors: string[]) {
	const feedback: RetryFeedback = {
		stage: "spec",
		gate: source,
		observed: `The latest specification was rejected by ${source}.`,
		expected: "A specification that passes deterministic traceability and approved spec review with no unresolved ambiguity before implementation starts.",
		missing: errors.slice(0, 8),
		diagnostics: errors.slice(8, 12),
		nextAction: "Rewrite the complete specification, implementation plan, and task list; preserve valid content and resolve every rejected trace/review/ambiguity item before calling structured_output. When an item concerns out-of-range acceptance-criteria/scenario identifiers, refer to them ONLY generically (e.g. \"out-of-range AC\") — NEVER spell the identifier itself in any section, including reviewResponses prose (the trace gate ignores response sections, but re-quoting teaches the next round to repeat the token).",
	};
	setRetryFeedback(state as Record<string, unknown>, "spec", [
		feedback,
		...convergenceRetryFeedback(state, { stage: "spec", currentStage: "spec", gate: source }),
	]);
}

function clearSpecFeedback(state: PipelineState) {
	clearRetryFeedback(state as Record<string, unknown>, "spec", "specReview");
}

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

function ownerForSpecTraceError(error: string): ConvergenceOwnerStage {
	if (/No requirements doc|requirements doc has no AC-NN/i.test(error)) return "requirements";
	if (/No BDD doc|BDD doc has no SCENARIO/i.test(error)) return "bdd";
	if (/task list|implementation plan|phase|spec\./i.test(error)) return "spec";
	return "spec";
}

function recordSpecTraceErrors(state: PipelineState, errors: string[]) {
	recordConvergenceFindings(state, errors.map((error) => ({
		detectedAtStage: "spec",
		ownerStage: ownerForSpecTraceError(error),
		severity: "high",
		blocking: true,
		title: error,
		detail: error,
		evidence: [error],
		sourceGate: "deterministic-trace",
		recommendation: "Rewrite the owning artifact or its trace mapping so downstream implementation receives a complete, grounded contract.",
	})), { detectedAtStage: "spec", ownerStage: "spec", sourceGate: "deterministic-trace" });
}

function recordSpecWriterFailure(state: PipelineState, source: string, error: string) {
	const environment = isNonRetryableAgentError(error);
	recordConvergenceFindings(state, {
		detectedAtStage: "spec",
		ownerStage: environment ? "environment" : "spec",
		severity: environment ? "fatal" : "high",
		blocking: true,
		title: `${source} failed`,
		detail: environment ? nonRetryableAgentSummary(error) : error,
		evidence: [error],
		sourceGate: source,
		recommendation: environment ? "Fix the local agent runtime/PATH before rerunning." : "Use the failure evidence in the next spec convergence attempt.",
	}, { detectedAtStage: "spec", ownerStage: environment ? "environment" : "spec", sourceGate: source });
}

function upstreamBlockingSummary(state: PipelineState): string[] {
	return blockingConvergenceFindings(state)
		.filter((finding) => ownerPrecedes(finding.ownerStage, "spec"))
		.slice(0, 6)
		.map((finding) => `${finding.id} owner=${finding.ownerStage} status=${finding.status}: ${finding.title}`);
}

/**
 * Stage 7/8 convergence: spec writing, deterministic trace validation, and
 * spec-review approval are one budget-bounded loop. A reviewer-only retry cannot
 * fix a bad spec; review failures must feed back into the next spec-writer
 * attempt. The loop is bounded by the hard MAX_CONVERGENCE_ROUNDS liveness cap
 * (shared with artifact-convergence): termination normally comes from trace+
 * review approval, the global run budget, or cancellation, but a stochastic
 * spec-reviewer that never approves is guaranteed to stop at the cap rather than
 * loop forever. See docs/requirements/convergence-loop-unbounded-cap-fix.md.
 */
export const specConvergenceNode: Node = {
	kind: "spec-convergence",
	async run(state: PipelineState, ctx: StageContext) {
		let lastErrors: string[] = [];
		let round = 0;
		const maxRounds = MAX_CONVERGENCE_ROUNDS;
		// F3 (RC2): grant a resumed run FRESH rounds after its replay — the old
		// static cap fired right after the cache-hit replay and re-killed the run
		// before the user's new guidance could reach the writer (runs 05-46 /
		// 06-02). Hard cumulative ceiling 3× the base cap.
		const priorRounds = state.setup?.specDirectory ? countStageRounds(state.setup.specDirectory, "pipeline.spec") : 0;
		let effectiveCap = Math.min(priorRounds + maxRounds, maxRounds * 3);
		if (effectiveCap > maxRounds) ctx.log(`spec convergence: resuming after ${priorRounds} recorded round(s) — round budget extended to ${effectiveCap}`);
		// F2 (RC1): strict-progress tracking for the one-shot cap extension.
		let prevOwnOpen = Number.POSITIVE_INFINITY;
		let lastOwnOpen = Number.POSITIVE_INFINITY;
		let progressExtensionUsed = false;
		// F1 (RC3): the upstream-owned blocking signature across consecutive
		// review rounds — 2 identical rounds means the spec writer CANNOT resolve
		// it (it tried twice); route back via replan instead of spinning to the
		// cap (run 05-48/06-02: SR findings owner=requirements/bdd for 8 rounds).
		let priorUpstreamSignature = "";
		// F6 (RC6): consecutive IDENTICAL structural trace errors → repair hint.
		let lastTraceError: string | null = null;
		let sameTraceErrorCount = 0;
		while (ctx.budget.check()) {
			round++;
			if (ctx.signal?.aborted) return { status: "cancelled" as const };
			if (round > effectiveCap) {
				// F2: strict progress at the cap — one bounded extension.
				if (!progressExtensionUsed && prevOwnOpen !== Number.POSITIVE_INFINITY && lastOwnOpen < prevOwnOpen && lastOwnOpen > 0) {
					progressExtensionUsed = true;
					effectiveCap += PROGRESS_EXTENSION_ROUNDS;
					ctx.log(`spec convergence: cap extended to ${effectiveCap} — strict progress (own open blocking ${prevOwnOpen === Number.POSITIVE_INFINITY ? "?" : prevOwnOpen} → ${lastOwnOpen})`);
				} else {
					// F1: before the fatal, route upstream-owned blockers back.
					const upstreamAtCap = blockingConvergenceFindings(state).filter((f) => ownerPrecedes(f.ownerStage, "spec"));
					if (upstreamAtCap.length > 0 && await triggerReplanForFindings(state, ctx, upstreamAtCap as unknown as Array<Record<string, unknown>>, "spec", state.setup?.specIdentifier ?? "unknown")) {
						ctx.log(`spec convergence: ${upstreamAtCap.length} upstream-owned blocking finding(s) routed back via REPLAN at round cap — restarting to revise the owning stage(s)`);
						throw new FatalAbort(`spec convergence: REPLAN at round cap — ${upstreamAtCap.length} upstream-owned blocking finding(s) routed back; restarting to revise`);
					}
					// Hard liveness floor (see artifact-convergence.ts): a stochastic
					// spec-reviewer that never approves must stop here, not loop forever.
					const msg = `spec convergence did not converge within ${effectiveCap} round(s)${lastErrors.length ? `: ${lastErrors.join("; ")}` : ""}`;
					ctx.log(`spec convergence: ROUND CAP (${effectiveCap}) EXHAUSTED (FATAL — aborting run) — ${msg}`);
					throw new FatalAbort(msg);
				}
			}
			ctx.log(`spec convergence: round ${round} starting`);
			delete state.specReview;

			// R3 (dsh-09 v3): pending replan requests owned by spec inject as
			// convergence-ledger findings at round 1 (same machinery as the artifact
			// convergence nodes); approval below flips them to addressed.
			if (round === 1) {
				const pendingReplan = pendingReplanRequests(state.setup?.specDirectory, "spec");
				if (pendingReplan.length > 0) {
					recordConvergenceFindings(state, pendingReplan.map((r) => ({
						id: `replan-${r.id}`,
						title: r.title,
						detail: r.requestedRevision,
						severity: r.severity,
						file: r.file,
						status: "open",
						blocking: true,
					})), { detectedAtStage: "replan", ownerStage: "spec", sourceGate: "replan-request" });
					setSpecFeedback(state, "replan-request", pendingReplan.map((r) => `[replan request ${r.id}] ${r.requestedRevision}`));
					ctx.log(`spec convergence: ${pendingReplan.length} replan request(s) injected at round 1`);
				}
			}

			const specResult = await specTask.run(state, ctx);
			if (specResult.status === "cancelled") return specResult;
			if (specResult.status === "failed") {
				lastErrors = [`spec writer failed: ${specResult.error ?? "unknown error"}`];
				recordSpecWriterFailure(state, "spec writer", specResult.error ?? "unknown error");
				setSpecFeedback(state, "spec writer", lastErrors);
				ctx.log(`spec convergence: ✗ spec writer failed round ${round} — ${lastErrors.join("; ")}`);
				// F2 (adversarial F2-STALE-PROGRESS): no review this round → no fresh
				// blocking-count reading → invalidate the progress signal.
				prevOwnOpen = Number.POSITIVE_INFINITY;
				lastOwnOpen = Number.POSITIVE_INFINITY;
				if (isNonRetryableAgentError(specResult.error)) throw new FatalAbort(nonRetryableAgentSummary(specResult.error));
				continue;
			}
			const addressed = markConvergenceFindingsAddressedFromResponses(state, (state.spec as ControlObj | undefined)?.reviewResponses);
			if (addressed > 0) ctx.log(`spec convergence: spec response matrix addressed ${addressed} prior finding(s)`);

			const trace = await validateSpecTrace(state, ctx);
			if (!trace.pass) {
				lastErrors = trace.errors;
				recordSpecTraceErrors(state, lastErrors);
				// F6 (RC6, run 06-39: "spec.phases must be a non-empty array" ×5
				// rounds): after 2 consecutive IDENTICAL structural errors the
				// corrective re-prompt alone is not landing — append the exact JSON
				// shape so the writer can repair the structure mechanically.
				const structural = lastErrors.find((e) => e.includes("spec.phases must be a non-empty array"));
				if (structural) {
					sameTraceErrorCount = structural === lastTraceError ? sameTraceErrorCount + 1 : 1;
					lastTraceError = structural;
					if (sameTraceErrorCount >= 2) {
						lastErrors = [...lastErrors, "STRUCTURAL REPAIR REQUIRED: return `phases` as a JSON ARRAY of objects, each exactly { 'name': string, 'description': string } — e.g. phases: [ { name: 'Backend sync foundation', description: '…' } ]. Do NOT wrap it in an object, do NOT return a map, do NOT omit it. `tasks` must be an array of { phase: <exact phase.name>, description: string }."];
						ctx.log(`spec convergence: structural phases error repeated ${sameTraceErrorCount}× — injected exact-shape repair hint`);
					}
				} else {
					lastTraceError = null;
					sameTraceErrorCount = 0;
				}
				setSpecFeedback(state, "deterministic trace gate", lastErrors);
				ctx.log(`spec convergence: ✗ trace gate failed round ${round}${lastErrors.length ? ` — ${lastErrors.join("; ")}` : ""}`);
				// F2 (adversarial F2-STALE-PROGRESS): same invalidation.
				prevOwnOpen = Number.POSITIVE_INFINITY;
				lastOwnOpen = Number.POSITIVE_INFINITY;
				continue;
			}
			ctx.log(`spec convergence: trace gate passed round ${round}`);

			const reviewResult = await specReviewTask.run(state, ctx);
			if (reviewResult.status === "cancelled") return reviewResult;
			if (reviewResult.status === "failed") {
				lastErrors = [`spec review failed: ${reviewResult.error ?? "unknown error"}`];
				recordSpecWriterFailure(state, "spec review", reviewResult.error ?? "unknown error");
				setSpecFeedback(state, "spec review", lastErrors);
				ctx.log(`spec convergence: ✗ review failed round ${round} — ${lastErrors.join("; ")}`);
				// F2 (code-review R1): review AGENT failure = no fresh reading.
				prevOwnOpen = Number.POSITIVE_INFINITY;
				lastOwnOpen = Number.POSITIVE_INFINITY;
				if (isNonRetryableAgentError(reviewResult.error)) throw new FatalAbort(nonRetryableAgentSummary(reviewResult.error));
				continue;
			}

			const review = await validateSpecReview(state, ctx);
			// Review-finding fix (adversarial F7-GATE-BYPASS): the gate tests the
			// VERDICT only — it never inspects findings. Approving on the gate alone
			// would let an approve-family verdict ("APPROVED WITH REVISIONS", which
			// F7 legitimately accepts) carrying HIGH/blocking findings converge the
			// spec silently — the findings would never even enter the ledger (they
			// are recorded only on the reject path below). Mirror
			// artifact-convergence: verdict approval AND no blocking finding.
			const specReviewControl = state.specReview as ControlObj | undefined;
			const approved = review.pass && !reviewHasBlockingFinding(specReviewControl);
			if (review.pass && !approved) ctx.log("spec convergence: review verdict approved but blocking finding(s) are present — treating as rejection");
			if (approved) {
				markConvergenceFindingsVerified(state, (finding) => {
					const detected = normalizeConvergenceStage(finding.detectedAtStage, "implementation");
					return detected === "spec" || detected === "specReview" || String(finding.detectedAtStage) === "replan";
				});
				clearSpecFeedback(state);
				// R3: the spec reviewer's approval verifies the revision — flip the
				// persisted requests to addressed only now.
				const consumedReplan = consumeReplanRequests(state.setup?.specDirectory, "spec");
				if (consumedReplan > 0) ctx.log(`spec convergence: ${consumedReplan} replan request(s) verified and marked addressed`);
				ctx.log(`spec convergence: ✓ trace + review approved (round ${round}${round > 1 ? ", after feedback" : ""})`);
				return { status: "ok" as const, attempts: round };
			}

			recordReviewFindingsFromControl(state, state.specReview as ControlObj | undefined, { detectedAtStage: "specReview", ownerStage: "spec", sourceGate: "spec-review" });
			lastErrors = [...review.errors, ...compactReviewFindings(state.specReview as ControlObj | undefined)];
			const upstream = upstreamBlockingSummary(state);
			if (upstream.length) lastErrors.push(`upstream-owned blocking findings remain: ${upstream.join("; ")}`);
			// F2: track own open blocking count for the strict-progress extension.
			prevOwnOpen = lastOwnOpen;
			lastOwnOpen = blockingConvergenceFindings(state).filter((f) => f.ownerStage === "spec").length;
			// F1 (RC3): identical upstream-owned signature twice in a row — the
			// spec writer has had its chance; route back to the owning stages via
			// the replan circuit (bounded restart, auto-resume) instead of
			// spinning to the cap. The gate-spec-review path has NO HITL surface
			// at all today (runs 05-48 / 06-02: 4 SR findings owner=requirements
			// re-raised every round to the cap).
			const upstreamFindings = blockingConvergenceFindings(state).filter((f) => ownerPrecedes(f.ownerStage, "spec"));
			const upstreamSignature = upstreamFindings.map((f) => f.fingerprint).sort().join("|");
			if (upstreamSignature.length > 0 && upstreamSignature === priorUpstreamSignature) {
				if (await triggerReplanForFindings(state, ctx, upstreamFindings as unknown as Array<Record<string, unknown>>, "spec", state.setup?.specIdentifier ?? "unknown")) {
					ctx.log(`spec convergence: ${upstreamFindings.length} upstream-owned finding(s) unchanged across 2 review rounds — routed back via REPLAN; restarting to revise the owning stage(s)`);
					throw new FatalAbort(`spec convergence: REPLAN — ${upstreamFindings.length} upstream-owned finding(s) routed back to their owning stage(s); restarting to revise`);
				}
			}
			priorUpstreamSignature = upstreamSignature;
			setSpecFeedback(state, "spec review", lastErrors);
			ctx.log(`spec convergence: ✗ review gate failed round ${round}${lastErrors.length ? ` — ${lastErrors.join("; ")}` : ""}`);
		}

		const msg = `spec convergence stopped before approval because the global agent budget was exhausted after ${round} round(s)${lastErrors.length ? `: ${lastErrors.join("; ")}` : ""}`;
		ctx.log(`spec convergence: BUDGET EXHAUSTED (FATAL — aborting run) — ${msg}`);
		throw new FatalAbort(msg);
	},
};
