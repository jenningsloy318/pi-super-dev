import {buildErrors, setupOf, verificationRetryFeedbackBlock} from "./evidence.ts";
import {IntegrationOutcome, buildGreen, failedReviewControl, failedTestControl, reviewApproved, specDeclaresTestDeliverables, validReviewControl} from "./boundary.ts";
/** steps — the review/test/build step nodes and both fix steps. Split from verify.ts at v0.4.17c. */
import { execFileSync } from "node:child_process";
import { superDevEnv } from "../../render/super-dev-dir.ts";
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
/** Reviewers in parallel → merged verdict under state.review. Exported for R-2
 *  tests.
 * F-09 (v0.3.86): the three review docs' NUMBERS are pre-reserved at step
 * START — before the parallel spawn — via reserveStageDocs, which records each
 * allocation in the prompts.ts reservation registry. Each task's later
 * renderAndWrite → reserveStageDocs then reuses its reserved name (idempotent)
 * instead of re-reading the dir, so no two review docs can compute the same
 * "next free" index even if allocations race ahead of the writes. */
const reviewParallel = parallel(
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
				// v0.3.73 M3: a valid control closes any codeReview-agent-failed row a
				// prior round's failedReviewControl opened (run 2026-09-05T23-09-55-596Z
				// audit listed the row open·blocking even after round 5 APPROVED).
				if (!r.error && validReviewControl(r.control)) closeAgentFailedFindings(s, "codeReview", "review recovered after agent failure");
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
				if (!r.error && validReviewControl(r.control)) closeAgentFailedFindings(s, "adversarialReview", "review recovered after agent failure");
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
				const control = r.error
					? failedReviewControl("testsReview", `tests-reviewer failed: ${r.error}`)
					: validReviewControl(r.control)
						? r.control
						: failedReviewControl("testsReview", "tests-reviewer produced no valid structured review verdict");
				// v0.3.73 M2 (run 2026-09-05T23-09-55-596Z): render the artifact exactly
				// like code/adversarial review — five completions wrote nothing because
				// this call was missing.
				// v0.3.73 M3: a VALID control closes any agent-failed row a prior round
				// left open — the ledger merge never closes rows a success omits.
				if (!r.error && validReviewControl(r.control)) closeAgentFailedFindings(s, "testsReview", "review recovered after agent failure");
				renderAndWrite(s.setup!, (m) => ctx.log(m), "testsReview", control);
				return control;
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

/** The reviewStep NODE: reserve all three review doc numbers FIRST (F-09),
 *  then delegate to the parallel reviewers. Keeping `.run` identical means
 *  every existing caller (loop body, epilogue, Stage 10/11 retry paths) is
 *  unchanged. */
export const reviewStep: Node = {
	kind: "reviewStep",
	async run(state, ctx) {
		const setup = setupOf(state);
		if (setup?.specDirectory) {
			for (const stageId of ["codeReview", "adversarialReview", "testsReview"]) {
				try { reserveStageDocs(setup, stageId); } catch { /* best-effort — each task's renderAndWrite still allocates on its own */ }
			}
		}
		return reviewParallel.run(state, ctx);
	},
};

/** Build gate (deterministic build/test/typecheck). */
export const buildGateStep = task({
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
export const fixStepReview = branch((s: PipelineState) => {
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
export const detectStagnation = (sig: string, count: number, sigHist: string[], countHist: number[]): boolean => {
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

/** V1 (v0.3.10) — Stage 10 replay-arm budget. On an actual RESUME (the same
 *  `options.resumeSpecIdentifier` signal pipeline.ts uses to preload the
 *  cache — a merely reused track with stale rows is NOT excluded), the
 *  persisted occurrence count of the three review agents bounds how many
 *  leading `reviewLoopUntil` observations are REPLAY-DERIVED (reconstructed
 *  from cache hits, carrying no fresh information): arms = prior + 1 (the +1
 *  is the pre-loop baseline observation, which is never a review outcome in
 *  fresh or resumed runs). Replayed observations reconstruct state but never
 *  arm the terminal exits — the verify-family twin of the writer loops' F3
 *  contract ("replayed rounds do not consume the fresh budget"), grounded in
 *  the durable-execution principle that history is evidence for STATE, not
 *  evidence for TERMINATION. Kill-switch: SUPER_DEV_NO_VERIFY_REPLAY_GUARD=1. */
function reviewReplayArms(state: PipelineState, ctx?: StageContext): number {
	const s = state as unknown as Record<string, unknown>;
	if (s.__verifyReplayArms !== undefined) return s.__verifyReplayArms as number;
	let arms = 0;
	const specDir = state.setup?.specDirectory;
	const marker = ctx?.options?.resumeSpecIdentifier
		?? (state.options as { resumeSpecIdentifier?: string } | undefined)?.resumeSpecIdentifier;
	const resumed = Boolean(marker);
	if (specDir && resumed && !superDevEnv("SUPER_DEV_NO_VERIFY_REPLAY_GUARD")) {
		// max over the review family: a crash that landed mid-round (one reviewer
		// recorded, another not) may over-exclude by one observation — the SAFE
		// direction (delays arming); min would arm on partially-replayed evidence.
		const prior = Math.max(
			countStageRounds(specDir, "pipeline.verify.code-review"),
			countStageRounds(specDir, "pipeline.verify.adversarial"),
			countStageRounds(specDir, "pipeline.verify.tests-review"),
		);
		if (prior > 0) {
			arms = prior + 1;
			ctx?.log(`Stage 10: resuming after ${prior} recorded review round(s) — replayed rounds do not arm stagnation/dead-state exits (fresh evidence required)`);
		}
	}
	s.__verifyReplayArms = arms;
	s.__verifyReplayObs = 0;
	return arms;
}

/** V1 — Stage 11 counterpart: arms = recorded integration rounds (no baseline
 *  offset — the first integration observation IS a test outcome). Exported for
 *  tests. NOTE: side-effecting classifier — it lazily initializes the arm
 *  budget and increments the replay-observation counter on every
 *  replay-derived call (call it exactly ONCE per observation). */
export function classifyIntegrationObservation(state: PipelineState, ctx?: StageContext): boolean {
	const s = state as unknown as Record<string, unknown>;
	if (s.__integrationReplayArms === undefined) {
		let arms = 0;
		const specDir = state.setup?.specDirectory;
		const marker = ctx?.options?.resumeSpecIdentifier
			?? (state.options as { resumeSpecIdentifier?: string } | undefined)?.resumeSpecIdentifier;
		const resumed = Boolean(marker);
		if (specDir && resumed && !superDevEnv("SUPER_DEV_NO_VERIFY_REPLAY_GUARD")) {
			const prior = Math.max(
				countStageRounds(specDir, "pipeline.integration.api-test"),
				countStageRounds(specDir, "pipeline.integration.ui-test"),
			);
			if (prior > 0) {
				arms = prior;
				ctx?.log(`Stage 11: resuming after ${prior} recorded integration round(s) — replayed observations do not arm test stagnation (fresh evidence required)`);
			}
		}
		s.__integrationReplayArms = arms;
		s.__integrationReplayObs = 0;
	}
	const arms = s.__integrationReplayArms as number;
	const histLen = ((s.__testSignatures as string[] | undefined) ?? []).length;
	const replayObs = (s.__integrationReplayObs as number | undefined) ?? 0;
	const callIndex = histLen + replayObs + 1;
	if (callIndex <= arms) {
		s.__integrationReplayObs = replayObs + 1;
		return true; // replay-derived — caller must skip the arming push
	}
	return false;
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
	// V1 (v0.3.10): replay-derived observations (reconstructed from resume cache
	// hits) are STATE, not EVIDENCE — they never arm stagnation or the dead-state
	// break. __reviewSignatures is now the ARMING history (fresh observations
	// only); __verifyReplayObs counts the excluded ones so total observations
	// (and thus the replay boundary) stay derivable from state alone. Approval
	// still exits immediately: a replayed approval is legitimate convergence
	// (the writer loops' green-skip analog).
	const arms = reviewReplayArms(s, ctx);
	const replayObsBefore = ((s as Record<string, unknown>).__verifyReplayObs as number | undefined) ?? 0;
	const callIndex = sigHist.length + replayObsBefore + 1;
	if (callIndex <= arms) {
		(s as Record<string, unknown>).__verifyReplayObs = replayObsBefore + 1;
		if (approvedAndBuildGreen) return true;
		return false; // replayed failure history must never terminate the loop
	}
	// V1: captured BEFORE detectStagnation pushes (never fires at cold start).
	// The arming history is fresh-only post-V1, so this is FRESH completed
	// rounds: identical to the old roundsCompleted>0 guard on fresh runs AND on
	// a post-guidance-reset re-entry (history reset ⇒ 0 ⇒ one completed
	// post-reset round required — round-2 review: VR-4/R2-4).
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

async function escalateReviewStagnationIfStillBlocked(state: PipelineState, ctx: StageContext): Promise<import("../../types.ts").EscalationDecision | undefined> {
	if (reviewApproved(state)) return undefined;
	const escalate = (ctx as { options?: { escalate?: import("../../types.ts").Escalate } }).options?.escalate;
	if (!escalate) return undefined;
	(state as Record<string, unknown>).__escalationAttempted = true;
	try {
		const { runEscalation, applyRetryDecision } = await import("../../escalation.ts");
		const setup = (state as { setup?: { worktreePath?: string; specDirectory?: string } }).setup;
		const findings = ((state as Record<string, unknown>).__stagnated as { findings?: Array<{ file?: unknown; severity?: unknown; title?: unknown }> } | undefined)?.findings ?? [];
		// F-C: the failure kind decides the message. A dead-state break (all
		// findings deferred — advisory / needs-human / cross-stage) is NOT a
		// recurrence and must never tell the human to "fix the implementation":
		// no code fixer is allowed to act on these items.
		const stagKind = ((state as Record<string, unknown>).__stagnated as { kind?: string } | undefined)?.kind;
		const failure: import("../../types.ts").EscalationFailure = {
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
export const testBlock = tryCatch(
	sequence([task(bringupTask), parallel([apiTestStep, uiTestStep], { tolerant: true })]),
	{ finally: teardownNode() },
);

/** Fix test failures + any review regression (Stage 11c). */
export const fixStepIntegration = task({
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

export function inconclusiveIntegrationMessage(outcome: IntegrationOutcome): string {
	if (outcome.status === "skipped-service-unavailable") return "integration service unavailable; stopping without product-code fix";
	if (outcome.status === "skipped-static") return "static site with no startable integration server and review/build not fully green";
	if (outcome.status === "unknown-runner-unavailable") return "integration runner unavailable; stopping without product-code fix";
	return `integration did not pass (${outcome.status})`;
}
