import { FatalAbort, gateValidator, task } from "../nodes.ts";
import { clearRetryFeedback, setRetryFeedback, type RetryFeedback } from "../retry-feedback.ts";
import type { ControlObj, Node, PipelineState, StageContext } from "../types.ts";
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
import { MAX_CONVERGENCE_ROUNDS } from "./artifact-convergence.ts";

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
		nextAction: "Rewrite the complete specification, implementation plan, and task list; preserve valid content and resolve every rejected trace/review/ambiguity item before calling structured_output.",
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
		while (ctx.budget.check()) {
			round++;
			if (ctx.signal?.aborted) return { status: "cancelled" as const };
			if (round > maxRounds) {
				// Hard liveness floor (see artifact-convergence.ts): a stochastic
				// spec-reviewer that never approves must stop here, not loop forever.
				const msg = `spec convergence did not converge within ${maxRounds} round(s)${lastErrors.length ? `: ${lastErrors.join("; ")}` : ""}`;
				ctx.log(`spec convergence: ROUND CAP (${maxRounds}) EXHAUSTED (FATAL — aborting run) — ${msg}`);
				throw new FatalAbort(msg);
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
				if (isNonRetryableAgentError(specResult.error)) throw new FatalAbort(nonRetryableAgentSummary(specResult.error));
				continue;
			}
			const addressed = markConvergenceFindingsAddressedFromResponses(state, (state.spec as ControlObj | undefined)?.reviewResponses);
			if (addressed > 0) ctx.log(`spec convergence: spec response matrix addressed ${addressed} prior finding(s)`);

			const trace = await validateSpecTrace(state, ctx);
			if (!trace.pass) {
				lastErrors = trace.errors;
				recordSpecTraceErrors(state, lastErrors);
				setSpecFeedback(state, "deterministic trace gate", lastErrors);
				ctx.log(`spec convergence: ✗ trace gate failed round ${round}${lastErrors.length ? ` — ${lastErrors.join("; ")}` : ""}`);
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
				if (isNonRetryableAgentError(reviewResult.error)) throw new FatalAbort(nonRetryableAgentSummary(reviewResult.error));
				continue;
			}

			const review = await validateSpecReview(state, ctx);
			if (review.pass) {
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
			setSpecFeedback(state, "spec review", lastErrors);
			ctx.log(`spec convergence: ✗ review gate failed round ${round}${lastErrors.length ? ` — ${lastErrors.join("; ")}` : ""}`);
		}

		const msg = `spec convergence stopped before approval because the global agent budget was exhausted after ${round} round(s)${lastErrors.length ? `: ${lastErrors.join("; ")}` : ""}`;
		ctx.log(`spec convergence: BUDGET EXHAUSTED (FATAL — aborting run) — ${msg}`);
		throw new FatalAbort(msg);
	},
};
