import { existsSync } from "node:fs";
import type { StageContext, PipelineState } from "../../types.ts";
import { appendGateChecked } from "../../runlog.ts";
import { deliverablesAlreadyMet, resetDeliverableCheckCache, runBuildGate, runDeliverableCheck, type DeliverableContract, type GateOptions } from "../../build-runner.ts";
import { phaseStatusUpsert, type PhaseStatusEntry, type PhaseFailureEntry } from "./phase-status.ts";
import type { ChangeTracker } from "../../tracking.ts";
import { listPorcelainPaths } from "../../fault-classification.ts";
import { normalizeRepoPath } from "../inherited-red.ts";

export interface PhaseEntryInput {
	ctx: StageContext;
	state: PipelineState;
	/** setup fields. */
	worktreePath: string;
	defaultBranch: string;
	phaseId: string;
	/** The phase's deliverable contract (caller keeps the const — the attempt loop reads it again). */
	phaseDeliverables: DeliverableContract | undefined;
	/** The active change tracker (caller keeps the const — the attempt loop's probeEnd reads it). */
	tracker: ChangeTracker | null;
	/** By-ref surfaces: status rows upsert in place; failure rows splice in place. */
	phaseStatus: PhaseStatusEntry[];
	lastFailures: PhaseFailureEntry[];
	/** v0.3.85 F2: the persisted first-ever phase-start dirt snapshots (Record<phaseId, string[]>). */
	phaseStartDirt: Record<string, string[]>;
	ensurePhaseRunning: () => void;
	announceActivity: (activity?: string, detail?: string) => void;
	emitPhaseStatus: (status: "running" | "ok" | "failed" | "skipped" | "partial") => void;
}

export type PhaseEntryOutcome =
	| { kind: "skip" }
	| { kind: "enter"; phaseStartSet: Set<string>; attemptErrors: string[]; missingDeliverables: string[] };

/** Increment 23 — the phase-ENTRY work, a boundary closer per the granularity
 *  standard: the resume-only verified no-op adjudication (§F #1) followed by the
 *  phase-start capture (dashboard rows, tracker.begin, the F2 first-ever dirt
 *  snapshot). The caller interprets mechanically: skip ⇒ phasesCompleted++ +
 *  continue; enter ⇒ rebind attemptErrors/missingDeliverables (seeded ONLY on
 *  the resume-rejected arm, [] otherwise) and the returned phaseStartSet.
 *  Byte-faithful to the pre-split stage.ts region (the tracker/phaseDeliverables
 *  consts stay caller-side — the attempt loop re-reads them). */
export function enterPhase(input: PhaseEntryInput): PhaseEntryOutcome {
	const { ctx, state, worktreePath, defaultBranch, phaseId, phaseDeliverables, tracker, phaseStatus, lastFailures, phaseStartDirt, ensurePhaseRunning, announceActivity, emitPhaseStatus } = input;
	let attemptErrors: string[] = [];
	let missingDeliverables: string[] = [];
	// §F #1 — pre-implement no-op detection (the state-confusion root cause):
	// ONLY for explicit resume runs. A fresh run must never count pre-existing
	// files/patterns as a completed phase without TDD + build verification.
	// Even on resume, this is a verified no-op: run the deterministic build gate
	// and full deliverable check before marking the phase green.
	const resumeNoOpAllowed = ctx.options.resume === true || typeof ctx.options.resume === "string";
	if (resumeNoOpAllowed && phaseDeliverables && deliverablesAlreadyMet(worktreePath, phaseDeliverables, defaultBranch) /* sweep-3 CR-R2-7 */) {
		ensurePhaseRunning();
		announceActivity("Resume verification");
		resetDeliverableCheckCache();
		announceActivity("Build gate", "resume verification");
		const gate = runBuildGate(worktreePath, { gate: (state.spec?.gate) as GateOptions | undefined, signal: ctx.signal, defaultBranch });
		appendGateChecked(state, "phase-green:resume-verify", gate, "implementation");
		announceActivity("Deliverable check", "resume verification");
		const deliverableCheck = runDeliverableCheck(worktreePath, phaseDeliverables, { signal: ctx.signal, skipTests: !(gate.pass || gate.inScopePass), defaultBranch });
		if ((gate.pass || gate.inScopePass) && deliverableCheck.pass) {
			ctx.log(`Implementation ${phaseId} no-op: resume deliverables already satisfied and verified — skipping implementer`);
			phaseStatusUpsert(phaseStatus, phaseId, "green");
			emitPhaseStatus("ok");
			const fi = lastFailures.findIndex((f) => f.phaseId === phaseId); if (fi >= 0) lastFailures.splice(fi, 1);
			return { kind: "skip" };
		}
		ctx.log(`Implementation ${phaseId} no-op rejected: resume verification failed (build=${gate.pass || gate.inScopePass}, missing=${deliverableCheck.missing.join("; ") || "none"}) — running implementer`);
		attemptErrors = gate.errors;
		missingDeliverables = deliverableCheck.missing;
	}
	// Pi-native sub-phase subtitle: announce WHICH phase is being implemented
	// AFTER the skip guards (so a skipped/already-green phase never flickers a
	// subtitle it isn't working on). Surfaces "Phase N/M: <name>" as the
	// dashboard header/working-message + a distinct ▶ line under the running
	// stage's live-log section. phase.name falls back to the phase id.
	// Emit the dashboard sub-stage row BEFORE the subtitle so the live-stream sink
	// tags the subtitle/progress under the current implementation phase.
	ensurePhaseRunning();
	announceActivity();
	if (tracker) tracker.begin("phase", phaseId);
	// v0.3.85 F2 (C1): the phase's FIRST-EVER porcelain snapshot — the F2
	// attribution boundary. Persisted across §D convergence iterations via
	// the control (the sd26-F1 lesson runStartDirt already pins: a re-entry
	// must not re-capture after this phase's own prior-iteration edits hit
	// disk, or its own live work would classify as pre-phase/inherited).
	// Dirt present in the first-ever snapshot is PRE-PHASE (earlier phases'
	// leftovers / prior-run state — the C1 poison class); dirt absent from
	// it appeared during THIS phase (the phase's own leak). A git failure
	// degrades to [] — unknown provenance can never support an inherited
	// classification (the safe direction is the Tier-0 own-leak ladder).
	// FIX ROUND 1 (A): the spawn is SKIPPED entirely for an absent worktree
	// (same [] degradation, zero latency) — a git spawn between the F3
	// phase-wall anchor and attempt 1 pre-empted the FIRST attempt under a
	// tiny SUPER_DEV_MAX_PHASE_WALL_MS (the wall bounds ATTEMPTS, never
	// pre-empts attempt 1).
	if (!Object.prototype.hasOwnProperty.call(phaseStartDirt, phaseId)) {
		phaseStartDirt[phaseId] = existsSync(worktreePath) ? listPorcelainPaths(worktreePath).map(normalizeRepoPath) : [];
	} else {
		ctx.log(`Implementation ${phaseId}: reusing persisted first-ever phase-start dirt snapshot (F2 attribution boundary stays the phase's first entry ever)`);
	}
	return { kind: "enter", phaseStartSet: new Set<string>(phaseStartDirt[phaseId] ?? []), attemptErrors, missingDeliverables };
}
