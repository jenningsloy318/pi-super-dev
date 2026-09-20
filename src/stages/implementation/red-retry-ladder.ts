/**
 * The RED retry/escalation ladder — increment 16 of the stage.ts split.
 *
 * THE BLOCK THIS REPLACES (stage.ts, inside the RED while loop: the
 * `if (retryHint && ...)` block through the loop-body's trailing `break`):
 * the RC-3 cycle/oscillation detection (signature history + the hard retry
 * ceiling — an A→B→A→B livelock evaded the old immediate-previous check),
 * the v0.3.85 F5 ESCALATION (RED-retry exhaustion or persistent weakening
 * rides the declared-handoff circuit with the DISTINCT source:"red-weakening"
 * tag, consuming ONE round of the shared replan pool with NO inherited-red
 * sub-cap; deterministic scoped cleanup runs FIRST — pre-existing test edits
 * reverted, surviving new test files stay on disk), the J9-a judge routing
 * (already extracted: routeRedJudge, red-judge.ts v0.4.32 — this module CALLS
 * it and interprets), the RC8 review-weak cleanup branches (with the v0.3.16
 * F2 reviewNeverRan preservation), and the retries++/redHint retry step.
 *
 * THE OUTCOME (4 arms — the inline exits). The `retryHint && status !==
 * green-already-satisfied` guard stays CALLER-side (P3 pattern — the module
 * never sees the no-retry case; the caller's trailing `break` handles it):
 *  - `restart`   — the judge routed re-author-tests / fix-environment: the RED
 *                  loop restarts with the diagnosis appended (caller continues).
 *  - `retry`     — a hint-carrying rejection: retries++ and re-author
 *                  (caller continues).
 *  - `f5-routed` — the red-weakening declared handoff routed (caller appends
 *                  the error, breaks — the phase ends partial red-weakening).
 *  - `terminal`  — the judge's stop-class verdict (caller breaks).
 *  - `accept`    — no retry: the RED stands (caller breaks out of the while
 *                  into the acceptance blocks).
 * The `routing` record echoes EVERY counter binding on every non-accept arm
 * (the v0.4.33 cross-iteration lesson) — the caller rebinds unconditionally,
 * no observer exists in the window.
 *
 * The F5 Tier-3-adjacent fallback (declared handoff UNAVAILABLE) falls
 * through to the judge + HITL path exactly as inline — no FatalAbort here.
 */

import type { StageContext, PipelineState } from "../../types.ts";
import { triggerReplanForFindings } from "../../replan/replan.ts";
import { routeRedJudge } from "./red-judge.ts";
import { MAX_RED_RETRIES, RED_WEAKENING_SOURCE, redEvidenceFailureReasons, redEvidenceSignature, restoreUnacceptedRedChanges, type RedEvidence } from "./red-evidence.ts";

export interface RedLadderInput {
	ctx: StageContext;
	state: PipelineState;
	phaseId: string;
	phaseName: string;
	attempt: number;
	/** The loop-scoped counters (echoed back on every non-accept arm). */
	retries: number;
	redJudgeRoutes: number;
	redEnvRestarts: number;
	redJudgeDiagnosis: string;
	redJudgeEvidenceLabel: string;
	/** The current attempt's terminalStopReason value (echoed unless an arm owns it). */
	incomingStopReason: "budget" | "no-progress" | "failed" | "environment-blocked" | "phase-attempt-cap" | "phase-wall" | "wall-fuse" | "inherited-red" | "declared-handoff" | "red-weakening" | "already-satisfied-blocked";
	/** The rejection hint (falsy ⇒ accept). */
	retryHint: string;
	redEvidence: RedEvidence;
	testFiles: string[];
	redChangedFiles: string[];
	tddText: string;
	worktreePath: string;
	specDirectory: string;
	specIdentifier: string;
	redScaffoldApproved: Set<string>;
	/** The RED loop's signature history — mutated in place (pushed here). */
	redProgressHistory: string[];
	/** P3 run-state guards (pure reads at the module boundary). */
	replanAlreadyPending: boolean;
	runFuseTripped: boolean;
}

export interface RedLadderRouting {
	retries: number;
	redJudgeRoutes: number;
	redEnvRestarts: number;
	redJudgeDiagnosis: string;
	redJudgeEvidenceLabel: string;
	redHint: string;
	terminalStopReason: "budget" | "no-progress" | "failed" | "environment-blocked" | "phase-attempt-cap" | "phase-wall" | "wall-fuse" | "inherited-red" | "declared-handoff" | "red-weakening" | "already-satisfied-blocked";
}

export type RedLadderOutcome =
	| { kind: "restart"; routing: RedLadderRouting }
	| { kind: "retry"; routing: RedLadderRouting }
	| { kind: "f5-routed"; routing: RedLadderRouting; attemptErrorsAppend: string }
	| { kind: "terminal"; routing: RedLadderRouting };

/**
 * Adjudicate the RED retry ladder. `await` is required (the F5 replan route
 * and the judge dispatch). Never throws on the bookkeeping paths.
 */
export async function adjudicateRedRetryLadder(input: RedLadderInput): Promise<RedLadderOutcome> {
	const { ctx, state, phaseId, phaseName, attempt, retries, redJudgeRoutes, redEnvRestarts, redJudgeDiagnosis, redJudgeEvidenceLabel, incomingStopReason, retryHint, redEvidence, testFiles, redChangedFiles, tddText, worktreePath, specDirectory, specIdentifier, redScaffoldApproved, redProgressHistory } = input;
	const echo: RedLadderRouting = {
		retries,
		redJudgeRoutes,
		redEnvRestarts,
		redJudgeDiagnosis,
		redJudgeEvidenceLabel,
		redHint: "",
		terminalStopReason: incomingStopReason,
	};
	const signature = redEvidenceSignature(redEvidence);
	// Cycle/oscillation detection (RC-3): the previous check only
	// compared the IMMEDIATELY-previous signature, so an A→B→A→B
	// livelock (e.g. red-not-confirmed ↔ red-polluted) evaded it and ran
	// for dozens of retries / hours. Stop when EITHER (a) this exact
	// signature has already been seen this phase (a cycle — the loop is
	// revisiting a state it cannot escape), OR (b) a hard retry ceiling
	// is hit (belt-and-braces against a non-repeating drift the signature
	// hashing might miss). Both are "no-progress": the RED phase is not
	// converging and further blind retries only burn budget.
	const seenBefore = redProgressHistory.includes(signature);
	const hitCeiling = retries + 1 >= MAX_RED_RETRIES;
	redProgressHistory.push(signature);
	if (seenBefore || hitCeiling) {
		// ── v0.3.85 F5 escalation (§9 F5, §14 ADR 8/10) — deterministic-first ──
		// RED-retry exhaustion (hitCeiling) OR persistent weakening
		// (seenBefore — the same weakened signature recurred): the ratchet
		// rejection rides the declared-handoff circuit with a DISTINCT
		// source:"red-weakening" tag, consuming ONE round of the shared
		// SUPER_DEV_MAX_REPLAN_ROUNDS pool — ADR 8's FOURTH consumer, with
		// NO inherited-red sub-cap (it never touches countInheritedRedRows).
		// Deterministic scoped cleanup runs FIRST (F2 Tier-0-at-exhausted-
		// budget doctrine: cleanup is deterministic, no agent call; the
		// surviving new test files stay on disk for the restart). Unroutable
		// (pool exhausted / marker already set / ledger write failure) falls
		// through to the existing judge + HITL path with the honest evidence.
		if (redEvidence.status === "weakened-preexisting-test" && !input.replanAlreadyPending && !input.runFuseTripped) {
			restoreUnacceptedRedChanges(ctx, worktreePath, phaseId, redEvidence.preexistingTestFiles ?? []);
			const f5WeakenedDetail = (redEvidence.weakenedFiles ?? []).map((w) => `${w.path} ${w.before}→${w.after}`).join(", ") || String(redEvidence.reason ?? "unknown");
			const f5Finding: Record<string, unknown> = {
				id: `red-weakening-${phaseId}`,
				file: redEvidence.weakenedFiles?.[0]?.path ?? null,
				severity: "high",
				title: `RED-phase assertion ratchet exhausted at ${phaseId}: pre-existing test surface weakened after ${retries + 1} RED tries`,
				detail: `The RED loop rejected ${retries + 1} tries because pre-existing test file(s) lost assertion surface (F5 grammar: test(/it(/assert/expect/SCENARIO): ${f5WeakenedDetail}. The corrective hint — author an independent NEW test file — did not land, so the work apparently REQUIRES weakening a frozen suite, which is a spec amendment: the declared route. Pre-existing test edits were reverted; surviving new test files stay on disk.`,
				ownerStage: "spec",
				source: RED_WEAKENING_SOURCE,
				sourcePhase: phaseId,
				recommendation: "Amend the spec/plan to declare the pre-existing suite's amendment (co-ownership in any clause form counts, or a phase that owns the atomic test change), so the RED can be authored without weakening the frozen guards.",
			};
			let f5Routed = false;
			try { f5Routed = await triggerReplanForFindings(state, ctx, [f5Finding], "implementation-red", specIdentifier); } catch { f5Routed = false; }
			if (f5Routed) {
				ctx.log(`Implementation ${phaseId} F5 red-weakening escalation: ${seenBefore ? `persistent weakening (the same weakened signature recurred after ${retries + 1} tries)` : `RED retries exhausted (${retries + 1} tries)`} — replan-requests.json row routed via the shared replan pool (source:red-weakening, sourcePhase:${phaseId}, ownerStage:spec; NO inherited-red sub-cap); the phase ends partial (red-weakening) and the run ends status "replan"`);
				return {
					kind: "f5-routed",
					routing: { ...echo, terminalStopReason: "red-weakening" },
					attemptErrorsAppend: `red-weakening: pre-existing test assertion surface decreased (${f5WeakenedDetail}) after ${retries + 1} RED tries — declared handoff routed (source:red-weakening, sourcePhase:${phaseId}); the run ends status "replan"`,
				};
			}
			ctx.log(`Implementation ${phaseId} F5 red-weakening escalation: declared handoff UNAVAILABLE (replan pool exhausted / marker set / ledger write failure) — falling through to the judge + human boundary with the ratchet evidence`);
		}
		// J9-a (judge routing layer): one verified diagnosis before the
		// human boundary. A routed re-author-tests / fix-environment restarts
		// the RED loop with the diagnosis appended (bounded by the judge's
		// per-signature budget of 2, so the third identical stall escalates);
		// escalate-now / discarded / degraded falls through to today's HITL.

		// v0.4.32: the judge hand-off + its four routes extracted to red-judge.ts
		// (increment 5 of the stage.ts split). The block's 4 continue / 3 break
		// against shared loop state became a returned discriminant: restart rebinds
		// the scalars and continues the RED loop, terminal rebinds and breaks. The
		// route set, counters, log text, escalation paths and terminal reasons are
		// byte-identical to the inline block (verified by the red-loop oracle).
		const judgeRoute = await routeRedJudge({
			ctx, state,
			phaseId, phaseName, signature, seenBefore, attempt,
			retries, redJudgeRoutes, redEnvRestarts,
			redEvidence, testFiles, redChangedFiles,
			retryHint,
			redJudgeDiagnosis, redJudgeEvidenceLabel,
			incomingStopReason,
			tddText,
			worktreePath,
			specDirectory,
			specIdentifier,
			redScaffoldApproved,
			redProgressHistory,
		});
		const routing: RedLadderRouting = {
			retries: judgeRoute.routing.retries,
			redJudgeRoutes: judgeRoute.routing.redJudgeRoutes,
			redEnvRestarts: judgeRoute.routing.redEnvRestarts,
			redJudgeDiagnosis: judgeRoute.routing.redJudgeDiagnosis,
			redJudgeEvidenceLabel: judgeRoute.routing.redJudgeEvidenceLabel,
			redHint: judgeRoute.kind === "restart" ? judgeRoute.routing.redHint : echo.redHint,
			terminalStopReason: judgeRoute.routing.terminalStopReason,
		};
		if (judgeRoute.kind === "restart") {
			return { kind: "restart", routing };
		}
		return { kind: "terminal", routing };
	}
	// RC8: review-weak evidence must ALSO restore the rejected RED
	// files before re-authoring (previously rode green-weak-test).
	// v0.3.16 F2 (RC-T2): a review that never RAN must not count as a verdict
	// against the artifact. When the review-weak reason is the agent-error/
	// timeout template ("RED review did not complete (...)" — the reviewer
	// timed out or errored, control=no), the test file is preserved on disk:
	// it was never adjudicated, the retry hint already names the review
	// infrastructure failure, and deleting it forces the next try to rewrite
	// from scratch (run 02-59 try 1 wrote a good file, its review timed out at
	// 480s, cleanup deleted the file, and every later try fought a ghost).
	const reviewNeverRan = redEvidence.status === "review-weak" && /RED review (?:did not complete|returned no usable verdict)/i.test(String(redEvidence.reason ?? ""));
	if (!reviewNeverRan && (redEvidence.status === "green-weak-test" || redEvidence.status === "review-weak" || redEvidence.status === "polluted-red")) {
		restoreUnacceptedRedChanges(ctx, worktreePath, phaseId, redEvidence.changedFiles);
	} else if (redEvidence.status === "weakened-preexisting-test") {
		// v0.3.85 F5: SCOPED revert — pre-existing test-file edits ONLY.
		// The corrective route is an independent NEW test file, so the new
		// files SURVIVE the revert (salvageability, Group 3's non-destructive
		// Tier-0 doctrine) — the full changedFiles revert above would
		// `git clean` them away and force the next try to rewrite from
		// scratch (the v0.3.16 F2 ghost-file lesson).
		restoreUnacceptedRedChanges(ctx, worktreePath, phaseId, redEvidence.preexistingTestFiles ?? []);
	} else if (reviewNeverRan) {
		ctx.log(`Implementation ${phaseId} RED cleanup SKIPPED: the review did not complete (no verdict was rendered) — preserving the written test file(s) on disk for the retry`);
	}
	const nextRetries = retries + 1;
	ctx.log(`Implementation ${phaseId} RED generation retry ${nextRetries}: ${redEvidenceFailureReasons(redEvidence).join("; ") || redEvidence.reason || redEvidence.status}`);
	return { kind: "retry", routing: { ...echo, retries: nextRetries, redHint: retryHint } };
}
