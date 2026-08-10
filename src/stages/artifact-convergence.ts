import { FatalAbort, gateValidator, task } from "../nodes.ts";
import { clearRetryFeedback, setRetryFeedback, type RetryFeedback } from "../retry-feedback.ts";
import type { Node, PipelineState, Stage, StageContext } from "../types.ts";
import { isNonRetryableAgentError, nonRetryableAgentSummary } from "../agent-errors.ts";
import {
	markConvergenceFindingsVerified,
	normalizeConvergenceStage,
	recordConvergenceFindings,
	type ConvergenceOwnerStage,
} from "../convergence-ledger.ts";
import { bddWriter, requirementsWriter, researchWriter } from "./writers.ts";

type ArtifactValidator = (state: PipelineState, ctx: StageContext) => Promise<{ pass: boolean; errors: string[] }> | { pass: boolean; errors: string[] };

interface ArtifactConvergenceOptions {
	stage: Stage;
	feedbackKey: "requirements" | "bdd" | "research";
	validate: ArtifactValidator;
	expected: string;
	nextAction: string;
	ownerForError?: (error: string) => ConvergenceOwnerStage;
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

export function artifactConvergenceNode(options: ArtifactConvergenceOptions): Node {
	const stageTask = task(options.stage);
	return {
		kind: `${options.feedbackKey}-convergence`,
		async run(state: PipelineState, ctx: StageContext) {
			let round = 0;
			let lastErrors: string[] = [];
			while (ctx.budget.check()) {
				round++;
				if (ctx.signal?.aborted) return { status: "cancelled" as const };
				ctx.log(`${options.feedbackKey} convergence: round ${round} starting`);

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

				const result = await options.validate(state, ctx);
				if (result.pass) {
					clearRetryFeedback(state as Record<string, unknown>, options.feedbackKey);
					markConvergenceFindingsVerified(state, (finding) => finding.ownerStage === normalizeConvergenceStage(options.feedbackKey, options.feedbackKey) && finding.detectedAtStage === options.feedbackKey);
					ctx.log(`${options.feedbackKey} convergence: complete (round ${round}${round > 1 ? ", after feedback" : ""})`);
					return { status: "ok" as const, attempts: round };
				}

				lastErrors = result.errors;
				recordArtifactErrors(options, state, lastErrors, `${options.feedbackKey}-validation`);
				setArtifactFeedback(options, state, lastErrors);
				ctx.log(`${options.feedbackKey} convergence: continuing after round ${round}${lastErrors.length ? ` — ${lastErrors.join("; ")}` : ""}`);
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
});

export const bddConvergenceNode = artifactConvergenceNode({
	stage: bddWriter,
	feedbackKey: "bdd",
	validate: bddComplete,
	expected: "BDD scenarios that cover every requirements AC-NN with no dangling acceptance-criteria references.",
	nextAction: "Rewrite the complete BDD artifact so every AC-NN has scenario coverage, preserving valid scenarios and adding the missing edge/error paths before calling structured_output.",
});

export const researchConvergenceNode = artifactConvergenceNode({
	stage: researchWriter,
	feedbackKey: "research",
	validate: researchComplete,
	expected: "A source-backed research report with every answerable open issue resolved before downstream assessment/spec work starts.",
	nextAction: "Continue online research until each open issue is answered with source evidence. If a question is genuinely unresolvable because tools are unavailable, explicitly disclose that and mark affected claims unverified instead of leaving it in openIssues.",
});
