/**
 * The phase tail — increment 15 of the stage.ts split (closing the campaign:
 * the last loop-scoped region of the phase loop).
 *
 * THE BLOCK THIS REPLACES (stage.ts, from `if (!green)` after the attempt
 * loop through the green path's rollback-stash re-apply): the §D failure
 * convergence record (the terminal reasons union — attemptErrors + the
 * judge's verified diagnosis + missing deliverables + claimed-not-changed +
 * hollow files), the v0.3.0 harness-research PARTIAL PRESERVATION (a failed
 * phase NEVER terminates the run — best attempt stash-preserved, pipeline
 * continues; the five track-07 deaths lesson), the partial-status bookkeeping
 * (lastFailureSig + partialReEntries for the same-signal re-entry counter),
 * the S4 pending-stash retention (a partial phase keeps its rollback stash
 * NAMED in git stash list — never silently stranded), the green path's
 * v0.3.43 deterministic commit (with the orchestrator fallback for in-place
 * runs / kill-switch / git failures), and the Wave 3 D-D stash re-apply on
 * top of the fresh committed tree.
 *
 * THE OUTCOME (3 arms — the inline exits):
 *  - `partial`       — the !green arm ran; the caller sets allGreen=false,
 *                      clears the stash if `stashCleared`, and CONTINUES.
 *  - `worktree-gone` — same side effects, then the caller BREAKS (v0.3.57
 *                      liveness: no further phase can run in a deleted tree).
 *  - `green`         — the commit + stash re-apply ran in-module; the caller
 *                      increments phasesCompleted (inline's ++ preceded the
 *                      commit — reorder unobservable: nothing reads it before
 *                      stage close).
 * `stashCleared` rides every arm: the caller alone owns the let.
 */

import type { StageContext, PipelineState } from "../../types.ts";
import { deterministicPhaseCommit, lastFailuresUpsert, phaseStatusUpsert, type PhaseStatusEntry, type PhaseFailureEntry } from "./phase-status.ts";
import { preservePartialPhase } from "./phase-status.ts";
import { recordImplementationConvergenceFailure } from "./red-evidence.ts";
import { reapplyRollbackStash } from "../checkpoint-rollback.ts";
import { buildCommitPrompt } from "../../prompts.ts";
import type { SetupControl } from "../../types.ts";

export interface PhaseTailInput {
	ctx: StageContext;
	state: PipelineState;
	setup: SetupControl;
	phaseId: string;
	phaseName: string;
	/** The RAW phase.name — the commit-fallback prompt takes it, NOT the loop-normalized phaseName. */
	phaseNameRaw: string;
	idx: number;
	totalPhases: number;
	isGreen: boolean;
	terminalStopReason: string;
	terminalFailureKind: "red-generation" | "implementation-gate";
	terminalRedTries: number;
	attemptsRun: number;
	attemptErrors: string[];
	missingDeliverables: string[];
	claimedNotChanged: string[];
	hollowFiles: string[];
	redJudgeDiagnosis: string;
	phaseStatus: PhaseStatusEntry[];
	lastFailures: PhaseFailureEntry[];
	envBlockedPhases: Set<string>;
	/** The pending rollback stash VALUE (the caller owns the let). */
	pendingRollbackStash: { phaseId: string; stashSha: string } | null;
	worktreeGone: boolean;
	emitPhaseStatus: (status: "partial") => void;
	announceActivity: (activity?: string, detail?: string) => void;
}

export type PhaseTailOutcome =
	| { kind: "partial"; stashCleared: boolean }
	| { kind: "worktree-gone"; stashCleared: boolean }
	| { kind: "green"; stashCleared: boolean };

/**
 * Close a phase after its attempt loop. `await` is required (the deterministic
 * commit's orchestrator fallback). Never throws on the bookkeeping paths.
 */
export async function closePhaseTail(input: PhaseTailInput): Promise<PhaseTailOutcome> {
	const { ctx, state, setup, phaseId, phaseName, phaseNameRaw, idx, totalPhases, isGreen, terminalStopReason, terminalFailureKind, terminalRedTries, attemptsRun, attemptErrors, missingDeliverables, claimedNotChanged, hollowFiles, redJudgeDiagnosis, phaseStatus, lastFailures, envBlockedPhases, pendingRollbackStash, worktreeGone, emitPhaseStatus, announceActivity } = input;
	if (!isGreen) {
		// §D: record the failure so the next convergence iteration targets it
		const terminalReasons = [
			...attemptErrors,
			// review-2 F8: the judge's verified diagnosis (fix-environment /
			// no-progress terminal stops) reaches the convergence record —
			// without it, environment-blocked phases surface only generic
			// red-unverified strings downstream.
			...(redJudgeDiagnosis ? [`judge diagnosis: ${redJudgeDiagnosis.slice(0, 400)}`] : []),
			...missingDeliverables.map((e) => `deliverable: ${e}`),
			...claimedNotChanged.map((e) => `claimed-not-changed: ${e}`),
			...hollowFiles.map((e) => `hollow-file: ${e}`),
		];
		recordImplementationConvergenceFailure(state, { phaseId, phaseName, kind: terminalFailureKind, attemptsRun, reasons: terminalReasons });
		// v0.3.0 (harness research): a failed phase NEVER terminates the run
		// anymore. The five track-07 deaths all ended PARTIAL 0/N with hours
		// of green doc/code work discarded; every external harness ends runs
		// with the best attempt preserved (SWE-agent get_best, Anthropic
		// git-per-increment, Ralph workspace-as-memory). The phase is marked
		// `partial`, its best attempt is stash-preserved, and the pipeline
		// CONTINUES to the next phase; the outer §D convergence loop re-enters
		// non-green phases for another bounded pass until allGreen or the
		// global budget fuse.
		preservePartialPhase(ctx, setup, phaseId, phaseName, terminalStopReason === "no-progress" ? "no-progress" : terminalStopReason === "budget" ? "budget" : terminalStopReason === "environment-blocked" ? "environment-blocked" : terminalStopReason === "phase-attempt-cap" ? "phase-attempt-cap" : terminalStopReason === "phase-wall" ? "phase-wall" : terminalStopReason === "wall-fuse" ? "wall-fuse" : terminalStopReason === "inherited-red" ? "inherited-red" : terminalStopReason === "declared-handoff" ? "declared-handoff (f4)" : terminalStopReason === "red-weakening" ? "red-weakening" : "gates-unmet"); // review-2 F8: keep the honest reason (v0.3.85 F3: the three bound reasons pass through verbatim; v0.3.85 F2/F4: the handoff reasons pass through named; v0.3.85 F5: the red-weakening handoff reason passes through named)
		if (terminalStopReason === "environment-blocked") envBlockedPhases.add(phaseId);
		{
			const sig = terminalReasons.join("; ").slice(0, 200);
			const prior = phaseStatus.find((p) => p.id === phaseId);
			const sameSig = prior?.status === "partial" && prior.lastFailureSig === sig;
			phaseStatusUpsert(phaseStatus, phaseId, "partial", attemptsRun); // v0.3.85 S3: peak-attempts metric
			const entry = phaseStatus.find((p) => p.id === phaseId)!;
			entry.lastFailureSig = sig;
			entry.partialReEntries = sameSig ? (prior?.partialReEntries ?? 0) + 1 : 0;
		}
		emitPhaseStatus("partial");
		lastFailuresUpsert(lastFailures, phaseId, [
			...attemptErrors,
			...missingDeliverables.map((e) => `deliverable: ${e}`),
			...claimedNotChanged.map((e) => `claimed-not-changed: ${e}`),
			...hollowFiles.map((e) => `hollow-file: ${e}`),
		]);
		if (terminalFailureKind === "red-generation") {
			ctx.log(`Implementation ${phaseId} partial (RED generation stopped after ${terminalRedTries} tries in attempt ${attemptsRun}${terminalStopReason === "no-progress" ? ", no progress" : terminalStopReason === "budget" ? ", budget exhausted" : terminalStopReason === "environment-blocked" ? ", environment blocked (fix is outside this worktree — judge diagnosis above)" : terminalStopReason === "red-weakening" ? " (red-weakening — declared handoff routed; the run ends status replan)" : ""}) — continuing to the next phase`); // review-2 F8
		} else {
			ctx.log(`Implementation ${phaseId} partial after ${attemptsRun} attempt(s)${terminalStopReason === "no-progress" ? " (no progress)" : terminalStopReason === "budget" ? " (budget exhausted)" : terminalStopReason === "environment-blocked" ? " (environment blocked — judge diagnosis above)" : terminalStopReason === "phase-attempt-cap" ? " (phase-attempt-cap)" : terminalStopReason === "phase-wall" ? " (phase wall budget exhausted)" : terminalStopReason === "wall-fuse" ? " (wall-fuse — run wall budget exhausted; resumable by design)" : terminalStopReason === "inherited-red" ? " (inherited-red — declared handoff routed; the run ends status replan)" : terminalStopReason === "declared-handoff" ? " (declared-handoff (f4) — the run ends status replan)" : ""} — continuing to the next phase`); // review-2 F8
		}
		// Adversarial S4 (v0.3.99 fix): if THIS phase's rollback stash is still
		// pending (the phase went partial before its re-apply point), preserve
		// it honestly — nulling pendingRollbackStash here prevents a later
		// phase's rollback from silently overwriting the SHA and orphaning the
		// stash in git stash list (P10: named, never silently stranded).
		let stashCleared = false;
		if (pendingRollbackStash && pendingRollbackStash.phaseId === phaseId) {
			ctx.log(`Implementation ${phaseId} went partial with a pending rollback stash (${pendingRollbackStash.stashSha.slice(0, 8)}) — the stash is RETAINED in git stash list for manual recovery; it will NOT be re-applied automatically on this pass`);
			stashCleared = true;
		}
		if (worktreeGone) return { kind: "worktree-gone", stashCleared }; // v0.3.57 liveness: no further phase can run in a deleted worktree
		return { kind: "partial", stashCleared };
	}
	// ── the green path ──
	let stashCleared = false;
	if (ctx.budget.check()) {
		announceActivity("Commit");
		// v0.3.43: engine-side deterministic commit (RC4). Falls back to the
		// orchestrator agent for in-place runs / kill-switch / git failures.
		const commitOutcome = deterministicPhaseCommit(setup.worktreePath, {
			phaseIndex: idx + 1,
			totalPhases,
			phaseName,
			worktreeCreated: (setup as { worktreeCreated?: boolean }).worktreeCreated,
			gateSummary: ["build green", "deliverables met", "TDD oracle green"].join("; "),
		});
		if (commitOutcome.status === "committed") {
			ctx.log(`Implementation ${phaseId} deterministic commit: ${commitOutcome.sha ?? "(sha unknown)"} — ${commitOutcome.reason}`);
		} else if (commitOutcome.status === "skipped") {
			ctx.log(`Implementation ${phaseId} commit skipped: ${commitOutcome.reason}`);
		} else {
			ctx.log(`Implementation ${phaseId} deterministic commit fell back to the orchestrator agent: ${commitOutcome.reason}`);
			await ctx.agent({ id: `pipeline.implementation.${phaseId}.commit`, agent: "orchestrator", prompt: buildCommitPrompt(setup, phaseNameRaw) });
		}
	}
	// ── Wave 3 D-D (058 Layer 4): re-apply the rollback stash AFTER this
	// phase's re-execution landed (its deterministic commit just ran — the
	// stash's downstream uncommitted state returns on top of the fresh K
	// tree, best-effort; a conflict DROPS it with an honest P10 log inside
	// reapplyRollbackStash — never an LLM conflict-resolution step).
	if (pendingRollbackStash && pendingRollbackStash.phaseId === phaseId) {
		reapplyRollbackStash({ worktreePath: setup.worktreePath, stashSha: pendingRollbackStash.stashSha, phaseId, log: (line) => ctx.log(line) });
		stashCleared = true;
	}
	return { kind: "green", stashCleared };
}
