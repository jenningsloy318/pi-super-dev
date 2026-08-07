import { FatalAbort, gateValidator, task } from "../nodes.ts";
import { WORKFLOW_ATTEMPTS } from "../retry-policy.ts";
import { clearRetryFeedback, setRetryFeedback, type RetryFeedback } from "../retry-feedback.ts";
import type { ControlObj, Node, PipelineState, StageContext } from "../types.ts";
import { specReviewWriter, specWriter } from "./writers.ts";

const specTask = task(specWriter);
const specReviewTask = task(specReviewWriter);
const validateSpecTrace = gateValidator("gate-spec-trace", "write-spec", "spec");
const validateSpecReview = gateValidator("gate-spec-review", "review-spec", "specReview");

function setSpecFeedback(state: PipelineState, source: string, attempt: number, max: number, errors: string[]) {
	const feedback: RetryFeedback = {
		stage: "spec",
		attempt,
		gate: source,
		observed: `Spec convergence attempt ${attempt}/${max} was rejected by ${source}.`,
		expected: "A specification that passes deterministic traceability and approved spec review before implementation starts.",
		missing: errors.slice(0, 8),
		diagnostics: errors.slice(8, 12),
		nextAction: "Rewrite the complete specification, implementation plan, and task list; preserve valid content and fix every rejected trace/review item before calling structured_output.",
	};
	setRetryFeedback(state as Record<string, unknown>, "spec", [feedback]);
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
		lines.push(`review ${id} severity=${severity}: ${title}${detail ? ` — ${detail}` : ""}`);
	}
	return lines;
}

/**
 * Stage 7/8 convergence: spec writing, deterministic trace validation, and
 * spec-review approval are one bounded loop. A reviewer-only retry cannot fix a
 * bad spec; review failures must feed back into the next spec-writer attempt.
 */
export const specConvergenceNode: Node = {
	kind: "spec-convergence",
	async run(state: PipelineState, ctx: StageContext) {
		const max = WORKFLOW_ATTEMPTS;
		let lastErrors: string[] = [];
		for (let attempt = 1; attempt <= max; attempt++) {
			if (ctx.signal?.aborted) return { status: "cancelled" as const };
			ctx.log(`spec convergence: attempt ${attempt}/${max} starting`);
			delete state.specReview;

			const specResult = await specTask.run(state, ctx);
			if (specResult.status === "cancelled") return specResult;
			if (specResult.status === "failed") {
				lastErrors = [`spec writer failed: ${specResult.error ?? "unknown error"}`];
				setSpecFeedback(state, "spec writer", attempt, max, lastErrors);
				ctx.log(`spec convergence: ✗ spec writer failed attempt ${attempt}/${max} — ${lastErrors.join("; ")}`);
				continue;
			}

			const trace = await validateSpecTrace(state, ctx);
			if (!trace.pass) {
				lastErrors = trace.errors;
				setSpecFeedback(state, "deterministic trace gate", attempt, max, lastErrors);
				ctx.log(`spec convergence: ✗ trace gate failed attempt ${attempt}/${max}${lastErrors.length ? ` — ${lastErrors.join("; ")}` : ""}`);
				continue;
			}
			ctx.log(`spec convergence: trace gate passed attempt ${attempt}/${max}`);

			const reviewResult = await specReviewTask.run(state, ctx);
			if (reviewResult.status === "cancelled") return reviewResult;
			if (reviewResult.status === "failed") {
				lastErrors = [`spec review failed: ${reviewResult.error ?? "unknown error"}`];
				setSpecFeedback(state, "spec review", attempt, max, lastErrors);
				ctx.log(`spec convergence: ✗ review failed attempt ${attempt}/${max} — ${lastErrors.join("; ")}`);
				continue;
			}

			const review = await validateSpecReview(state, ctx);
			if (review.pass) {
				clearSpecFeedback(state);
				ctx.log(`spec convergence: ✓ trace + review approved (attempt ${attempt}${attempt > 1 ? ", after feedback" : ""})`);
				return { status: "ok" as const, attempts: attempt };
			}

			lastErrors = [...review.errors, ...compactReviewFindings(state.specReview as ControlObj | undefined)];
			setSpecFeedback(state, "spec review", attempt, max, lastErrors);
			ctx.log(`spec convergence: ✗ review gate failed attempt ${attempt}/${max}${lastErrors.length ? ` — ${lastErrors.join("; ")}` : ""}`);
		}

		const msg = `spec convergence could not pass after ${max} attempt(s)${lastErrors.length ? `: ${lastErrors.join("; ")}` : ""}`;
		ctx.log(`spec convergence: EXHAUSTED (FATAL — aborting run) — ${msg}`);
		throw new FatalAbort(msg);
	},
};
