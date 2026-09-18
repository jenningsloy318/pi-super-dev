/**
 * The RED acceptance boundary — increment 17 of the stage.ts split.
 *
 * THE BLOCK THIS REPLACES (stage.ts, immediately after the RED while loop):
 * the four terminal blocks and the acceptance — the v0.3.85 F5 ROUTED
 * red-weakening partial (bypasses the unaccepted-RED terminal block — its
 * full changedFiles revert would destroy the surviving new test files), the
 * no-evidence terminal, the GREEN-ALREADY-SATISFIED verification (a MACHINE
 * decision: re-runs the build gate + full deliverable check before the
 * phase may go green on it — A1: the machine decides, never the child's own
 * summary), the v0.3.30 F2 terminal RED block (the fail-closed unknown
 * filter + the v0.3.87 S4(b) research-assist ARMING with its per-phase cap),
 * and the acceptance capture (acceptedRed + the stale-challenge clear + the
 * confirmed-RED snapshot).
 *
 * THE OUTCOME (6 arms — four attempt-loop breaks, the green break, and the
 * acceptance fall-through):
 *  - `red-weakening-partial` — the caller sets the red-generation terminal
 *    pair and breaks (the scoped revert already ran at the escalation site).
 *  - `no-evidence`           — the caller sets the zero-tries terminal pair.
 *  - `already-green`         — the verification's side-effect trio (upsert +
 *    emit + failure splice) ALREADY ran in-module; the caller sets
 *    green=true and breaks.
 *  - `already-fail`          — carries attemptErrors + missingDeliverables.
 *  - `red-terminal`          — carries attemptErrors + terminalRedTries +
 *    terminalStopReason (the budget override applied in-module).
 *  - `accepted`              — carries the acceptedRed context + the fresh
 *    confirmed-RED snapshot; the caller rebinds both, clears
 *    reauthorEvidence (the stale-challenge clear), and falls through to the
 *    GREEN phase.
 */

import type { StageContext, PipelineState } from "../../types.ts";
import { runBuildGate, runDeliverableCheck, resetDeliverableCheckCache, type DeliverableContract, type GateOptions, type RedStatus } from "../../build-runner.ts";
import { appendGateChecked } from "../../runlog.ts";
import { phaseStatusUpsert, type PhaseStatusEntry, type PhaseFailureEntry } from "./phase-status.ts";
import { redEvidenceFailureReasons, redEvidenceLogLine, restoreUnacceptedRedChanges, snapshotFiles, type RedEvidence } from "./red-evidence.ts";
import { RESEARCH_ASSIST_RED_TRIGGER_TRIES, type ResearchAssistRedArm } from "../research-assist.ts";

type StopReason = "budget" | "no-progress" | "failed" | "environment-blocked" | "phase-attempt-cap" | "phase-wall" | "wall-fuse" | "inherited-red" | "declared-handoff" | "red-weakening";

export interface RedAcceptanceInput {
	ctx: StageContext;
	state: PipelineState;
	worktreePath: string;
	defaultBranch: string | undefined;
	phaseId: string;
	attempt: number;
	/** The CURRENT terminalStopReason (the no-progress/environment-blocked preserves). */
	terminalStopReason: StopReason;
	/** RED-loop counters/state. */
	retries: number;
	redEvidence: RedEvidence | null;
	redStatus: RedStatus;
	testFiles: string[];
	redChangedFiles: string[];
	/** The fail-closed unknown flag (v0.3.30 F2). */
	redFailClosedUnknown: boolean;
	phaseDeliverables: DeliverableContract | undefined;
	/** By-ref side-effect surfaces. */
	phaseStatus: PhaseStatusEntry[];
	lastFailures: PhaseFailureEntry[];
	phaseResearchAssistUsed: Record<string, true>;
	redAssistArmed: Record<string, ResearchAssistRedArm>;
	attemptDetail: (attempt: number, extra?: string) => string;
	announceActivity: (activity?: string, detail?: string) => void;
	emitPhaseStatus: (status: "ok") => void;
}

export type RedAcceptanceOutcome =
	| { kind: "red-weakening-partial"; terminalRedTries: number }
	| { kind: "no-evidence" }
	| { kind: "already-green" }
	| { kind: "already-fail"; attemptErrors: string[]; missingDeliverables: string[] }
	| { kind: "red-terminal"; attemptErrors: string[]; terminalRedTries: number; terminalStopReason: StopReason }
	| { kind: "accepted"; acceptedRed: { status: RedStatus; testFiles: string[]; changedFiles: string[] }; /** null = leave the caller's phase-hoisted snapshot UNTOUCHED — 8c5d07bc F1 / 7f682af4 F1: an empty-map rebind would blind the GREEN-boundary oracle's changedSinceSnapshot to implementer edits of the prior confirmed RED. */ redTestSnapshot: Map<string, string | null> | null };

/**
 * Adjudicate the RED outcome after the while loop. Synchronous (the build
 * gate and deliverable check are sync). Never throws on bookkeeping.
 */
export function adjudicateRedAcceptance(input: RedAcceptanceInput): RedAcceptanceOutcome {
	const { ctx, state, worktreePath, defaultBranch, phaseId, attempt, terminalStopReason, retries, redEvidence, redStatus, testFiles, redChangedFiles, redFailClosedUnknown, phaseDeliverables, phaseStatus, lastFailures, phaseResearchAssistUsed, redAssistArmed, attemptDetail, announceActivity, emitPhaseStatus } = input;
	// v0.3.85 F5: a ROUTED red-weakening handoff ends the phase partial with
	// the NAMED reason — bypass the unaccepted-RED terminal block below (its
	// full changedFiles revert would destroy the surviving new test files,
	// and its reason overwrite would bury the handoff row; the scoped revert
	// already ran at the escalation site).
	if (redEvidence && terminalStopReason === "red-weakening") {
		return { kind: "red-weakening-partial", terminalRedTries: retries + 1 };
	}
	if (!redEvidence) {
		ctx.log(`Implementation ${phaseId} RED generation failed after 0 tries`);
		return { kind: "no-evidence" };
	}
	if (redEvidence.status === "green-already-satisfied") {
		resetDeliverableCheckCache();
		announceActivity("Already-satisfied verification", attemptDetail(attempt));
		announceActivity("Build gate", attemptDetail(attempt));
		const gate = runBuildGate(worktreePath, { gate: (state.spec?.gate) as GateOptions | undefined, signal: ctx.signal, defaultBranch });
		appendGateChecked(state, "phase-green:already-satisfied", gate, "implementation");
		announceActivity("Deliverable check", attemptDetail(attempt));
		const deliverableCheck = runDeliverableCheck(worktreePath, phaseDeliverables ?? {}, { signal: ctx.signal, skipTests: !(gate.pass || gate.inScopePass), defaultBranch });
		ctx.log(`Implementation ${phaseId} RED already-satisfied: build=${gate.pass || gate.inScopePass}, deliverables=${deliverableCheck.pass}`);
		if ((gate.pass || gate.inScopePass) && deliverableCheck.pass) {
			phaseStatusUpsert(phaseStatus, phaseId, "green");
			emitPhaseStatus("ok");
			const _gfi = lastFailures.findIndex((f) => f.phaseId === phaseId); if (_gfi >= 0) lastFailures.splice(_gfi, 1);
			return { kind: "already-green" };
		}
		ctx.log(`Implementation ${phaseId} RED already-satisfied verification FAIL: ${[...gate.errors, ...deliverableCheck.missing.map((e) => `deliverable: ${e}`)].join("; ") || "phase gates unmet"}`);
		return { kind: "already-fail", attemptErrors: gate.errors, missingDeliverables: deliverableCheck.missing };
	}
	// v0.3.30 F2: unknown (red-unverified) evidence is only a TERMINAL
	// failure when the fail-closed guard engaged (the phase requires
	// tests). Otherwise the P3 contract holds: unknown falls through to
	// the implementer with an unconfirmed-RED advisory, no stall.
	const redFailures = redEvidenceFailureReasons(redEvidence).filter((r) => redFailClosedUnknown || !r.startsWith("red-unverified:"));
	if (redFailures.length) {
		restoreUnacceptedRedChanges(ctx, worktreePath, phaseId, redEvidence.changedFiles);
		const terminalRedTries = retries + 1;
		// v0.3.87 S4(b) RED side (decision 9): a terminal RED-generation
		// failure with ≥ RESEARCH_ASSIST_RED_TRIGGER_TRIES tries (second RED
		// retry onward) ARMS the engine-mediated assist for this phase's NEXT
		// implementer round — the §D re-entry's first attempt. The dispatch
		// happens at that attempt's corrective-prompt assembly (immediately
		// before the implementer call), so the assist never fires without a
		// following attempt that carries it (never report-only; arming is a
		// zero-cost record, nothing is dispatched here). Per-phase cap ≤1
		// (P8): a spent cap logs honestly and does NOT (re-)arm.
		if (terminalRedTries >= RESEARCH_ASSIST_RED_TRIGGER_TRIES) {
			if (phaseResearchAssistUsed[phaseId]) {
				ctx.log(`Implementation ${phaseId} research-assist trigger (RED: terminalRedTries=${terminalRedTries}) — per-phase assist cap already spent; proceeding WITHOUT assist`);
			} else {
				redAssistArmed[phaseId] = { tries: terminalRedTries, detail: redFailures.slice(0, 6).join("; "), testFiles: [...testFiles] };
				ctx.log(`Implementation ${phaseId} research-assist ARMED (RED: ${terminalRedTries} terminal RED trie(s)) — research-agent will be dispatched before this phase's NEXT implementer round (the §D re-entry attempt)`);
			}
		}
		const stop: StopReason = terminalStopReason !== "no-progress" && terminalStopReason !== "environment-blocked" ? (ctx.budget.check() ? "failed" : "budget") : terminalStopReason;
		ctx.log(`Implementation ${phaseId} RED generation stopped after ${retries + 1} tries${stop === "no-progress" ? " (no progress)" : stop === "budget" ? " (budget exhausted)" : stop === "environment-blocked" ? " (environment-blocked)" : ""}`);
		ctx.log(`Implementation ${phaseId} RED gate FAIL: ${redFailures.join("; ")}`);
		ctx.log(redEvidenceLogLine(redEvidence));
		return { kind: "red-terminal", attemptErrors: redFailures, terminalRedTries, terminalStopReason: stop };
	}
	return {
		kind: "accepted",
		acceptedRed: { status: redStatus, testFiles: [...testFiles], changedFiles: [...redChangedFiles] },
		// inline had no else: a prior confirmed-RED snapshot is PRESERVED when this
		// acceptance is not a fresh red — null keeps it (the caller rebinds
		// conditionally).
		redTestSnapshot: redStatus === "red" && testFiles.length > 0 ? snapshotFiles(worktreePath, testFiles) : null,
	};
}
