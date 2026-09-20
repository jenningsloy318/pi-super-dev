import { toBool } from "../doc-validators.ts";
import { readRunWallFuseMarker } from "../wall-fuse.ts";
import { agentBudgetStatusReason, readAgentBudgetMarker } from "../agent-budget-fuse.ts";
import type { PipelineState, RunStatus } from "../types.ts";

/** Wave 2 increment 3: the run-status derivation (Sweep-3 G3/G9/G22), a pure
 *  adjudicator extracted from workflow.ts verbatim — one reason to change: the
 *  terminal-status honesty contracts. */

/** One ctx.results row (structural subset — keeps the derivation testable
 *  without a full StageContext). */
export interface StatusDerivationResultRow {
	id: string;
	label?: string;
	status: string;
	error?: string;
}

export interface RunStatusDerivation {
	status: RunStatus;
	/** Stages that ENDED in `failed` (last status per stage id — G3). */
	failedStages: { label: string; error?: string }[];
	/** Honest reasons the run is NOT `success` (G9 surfacing; empty on success). */
	statusReasons: string[];
}

/** Sweep-3 G3/G9/G22: the run-status derivation, extracted pure so the
 *  honesty contracts are unit-pinnable:
 *  - G3 `failedStages` is LAST-status-per-stage — a convergence loop that
 *    failed round 1 and converged round 2 must not permanently block `success`
 *    (the pre-fix first-failure dedupe did exactly that).
 *  - G9 `success` requires an AFFIRMATIVE build gate (`pass === true`); an
 *    ABSENT buildGate is not a vacuous pass — no deterministic build
 *    verification ran and the run is `partial` with the honest reason.
 *  - G22 a final `success` supersedes the mid-loop `__stagnated` marker — the
 *    marker is stale loop state and must never reach formatSummary/HITL. */
export function deriveRunStatus(input: {
	results: StatusDerivationResultRow[];
	state: PipelineState;
	aborted: boolean;
	abortError?: string;
}): RunStatusDerivation {
	const { results, state, aborted, abortError } = input;
	// G3: LAST status per stage id wins (later success of the same stage clears
	// an earlier failure — convergence rounds re-run the same task()).
	const lastByStage = new Map<string, StatusDerivationResultRow>();
	for (const r of results) lastByStage.set(r.id, r);
	const failedStages: { label: string; error?: string }[] = [];
	for (const r of lastByStage.values()) {
		if (r.status === "failed") failedStages.push({ label: r.label || r.id, error: r.error });
	}

	const impl = state.implementation as { totalPhases?: number; phasesCompleted?: number; allGreen?: boolean; convergenceBlocked?: boolean; phaseStatus?: Array<{ id: string; status: string }> } | undefined;
	const review = state.review as { verdict?: string } | undefined;
	const phases = impl?.totalPhases ?? 0;
	const green = impl?.allGreen === true;
	const verdict = review?.verdict;
	const approved = verdict === "Approved" || verdict === "Approved with Comments";
	const reviewRan = review !== undefined;

	// G9: the build gate must AFFIRM pass — absent is not a vacuous pass.
	const buildAffirmed = (state.buildGate as { pass?: boolean } | undefined)?.pass === true;
	const hardGateFailed =
		((state.buildGate as { pass?: boolean } | undefined)?.pass === false) ||
		((state.preMergeBuild as { pass?: boolean } | undefined)?.pass === false) ||
		((state.integration as { pass?: boolean } | undefined)?.pass === false);
	const mergeRequired =
		state.preMergeBuild !== undefined &&
		(state.preMergeBuild as { pass?: boolean }).pass === true &&
		state.cleanup !== undefined &&
		(state.cleanup as { blocked?: boolean }).blocked !== true;
	// A-2 + boolean-drift (run 2026-08-15T13-45-02): tolerant merge read.
	const mergeNotConfirmed = mergeRequired && !toBool((state.merge as { merged?: unknown } | undefined)?.merged);
	// A-3 status honesty: cleanup-blocked ⇒ never a clean success.
	const cleanupBlocked = (state.cleanup as { blocked?: boolean } | undefined)?.blocked === true;

	// R3: replan is a first-class terminal outcome.
	const replanMarker = (state as Record<string, unknown>).__replan as { rounds?: number; owners?: string[] } | undefined;
	// SD-05 (NFR-6): accepted limitations never count as clean success.
	const acceptedLimitations = (state as Record<string, unknown>).__acceptedLimitations as Record<string, unknown> | undefined;
	// A-03 (NFR-6): the replan marker must never MASK a subsequent abort.
	const replanAbort = aborted && abortError !== undefined && abortError.includes("REPLAN at round cap");

	// v0.3.85 F3 (§10 decision 2): the wall-fuse marker makes the run's terminal
	// state `partial (wall-fuse)` — resumable BY DESIGN, deliberately DISTINCT
	// from FatalAbort (bug class: a fuse-blocked agent cascade must never read as
	// a bug). It outranks a plain abort UNLESS the user cancelled (the cancel is
	// then the terminal fact); REPLAN still outranks it (the restart resumes into
	// a fresh fuse window anyway) and a fully-converged run stays success.
	const wallFuseMarker = readRunWallFuseMarker(state);
	const wallFuseEnds = wallFuseMarker !== undefined && abortError !== "workflow cancelled";

	// v0.4.57: the spawn-budget terminal marker — same contract as the wall
	// fuse (first-trip state marker written by nodes.ts task() when the
	// stage-start budget check first fails). A budget-blocked cascade is
	// bounded-by-design and resumable with a FRESH budget: the marker adds its
	// honest reason on the partial branch (and, like the wall fuse, never
	// downgrades a fully-converged success and never outranks REPLAN).
	const agentBudgetMarker = readAgentBudgetMarker(state);

	const statusReasons: string[] = [];
	let status: RunStatus;
	if (replanMarker && (!aborted || replanAbort)) {
		status = "replan";
	} else if ((aborted && !wallFuseEnds) || phases === 0) {
		status = "failed";
	} else if (green && reviewRan && approved && buildAffirmed && !hardGateFailed && !mergeNotConfirmed && !cleanupBlocked && !acceptedLimitations && failedStages.length === 0) {
		status = "success";
	} else {
		status = "partial";
		if (wallFuseEnds) {
			statusReasons.push(`partial (wall-fuse): run wall budget exhausted at ${new Date(wallFuseMarker!.trippedAt).toISOString()} (SUPER_DEV_MAX_RUN_WALL_MS=${wallFuseMarker!.capMs}ms; ${wallFuseMarker!.reason}) — bounded by design: converged phases are committed and a resumed pass continues with a FRESH fuse window`);
		}
		if (agentBudgetMarker !== undefined) {
			statusReasons.push(agentBudgetStatusReason(agentBudgetMarker));
		}
		if (!buildAffirmed && state.buildGate === undefined) statusReasons.push("build gate absent (no deterministic build verification ran)");
		if (!green) statusReasons.push("implementation not all-green");
		if (!reviewRan) statusReasons.push("review never ran");
		else if (!approved) statusReasons.push(`review verdict not approved (${String(verdict)})`);
		if (hardGateFailed) statusReasons.push("a hard gate failed");
		if (mergeNotConfirmed) statusReasons.push("merge not confirmed");
		if (cleanupBlocked) statusReasons.push("cleanup blocked the merge");
		if (acceptedLimitations) statusReasons.push("accepted limitations present");
		for (const f of failedStages) statusReasons.push(`stage ${f.label} ended failed${f.error ? `: ${f.error}` : ""}`);
	}

	// G22: a final success supersedes the mid-loop stagnation marker.
	if (status === "success") {
		delete (state as Record<string, unknown>).__stagnated;
	}
	return { status, failedStages, statusReasons };
}
