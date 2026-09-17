/**
 * Stage 9 — convergence re-entry checkpoint rollback (extracted from stage.ts
 * at v0.4.28).
 *
 * When the §D walk re-enters a non-green phase K after LATER phases already
 * ran, their artifacts contaminate K's convergence ground (the 058 S-B class).
 * This block resets the worktree to latestGreenCommitBefore(K) ?? the
 * stage-entry baseline, stashes downstream uncommitted state, and invalidates
 * the green stamps of K+1..N (their detached deterministic commits are
 * documented as abandoned; recovery is re-execution through the normal walk —
 * never cherry-pick, which would hand conflict resolution to an LLM: the exact
 * defect class this removes).
 *
 * Self-limiting: after the first rollback in a pass the invalidated downstream
 * entries are gone, so later non-green phases no longer match the
 * laterPhasesRan predicate (at most one rollback per §D entry).
 *
 * Extraction contract — the three mutations this performs on run-scope state:
 * `phaseStartDirt` and `phaseProtectionStrikes` are objects, so they are
 * mutated by reference in place; `pendingRollbackStash` is a `let` rebinding,
 * so it is RETURNED and the caller assigns it. Pure function of its inputs
 * apart from those three; no `continue`/`break`, no async.
 */
import type { SetupControl } from "../../types.ts";
import type { PhaseStatusEntry } from "./phase-status.ts";
import { rollbackConvergenceReentry, laterPhasesRan } from "../checkpoint-rollback.ts";
import { resetProtectionStrike } from "../protection-interval.ts";

export interface ConvergenceRollbackInput {
	setup: SetupControl;
	/** 0-based phase index of the phase being re-entered. */
	idx: number;
	totalPhases: number;
	phaseStatus: PhaseStatusEntry[];
	phaseId: string;
	baselineCommit: string;
	phaseStartDirt: Record<string, string[]>;
	phaseProtectionStrikes: Record<string, number>;
	log: (line: string) => void;
}

/**
 * Runs the rollback when later phases already ran. Returns the new
 * `pendingRollbackStash` (null when no rollback happened or it stashed
 * nothing) — the caller rebinds its `let` to this.
 */
export function handleConvergenceRollback(input: ConvergenceRollbackInput): { phaseId: string; stashSha: string } | null {
	if (!laterPhasesRan(input.phaseStatus, input.idx)) return null;
	const rollback = rollbackConvergenceReentry({
		worktreePath: input.setup.worktreePath,
		worktreeCreated: (input.setup as { worktreeCreated?: boolean }).worktreeCreated,
		specDirectory: input.setup.specDirectory,
		phaseIndex: input.idx + 1,
		totalPhases: input.totalPhases,
		phaseStatus: input.phaseStatus,
		baselineCommit: input.baselineCommit,
		log: (line) => input.log(line),
	});
	if (rollback.status !== "rolled-back") return null;
	// Re-baseline phase K's first-ever dirt snapshot on the rolled-back ground
	// (the K-1 tree): unlike the sd26-F1 case, a hard reset to a PREDECESSOR
	// commit legitimately re-anchors the attribution boundary. Invalidated
	// downstream phases lose their snapshots so their re-execution captures
	// fresh (their old ground no longer exists).
	delete input.phaseStartDirt[input.phaseId]; // dropped — the landed phase-entry capture below recaptures fresh on the rolled-back ground (unlike sd26-F1, a reset to a PREDECESSOR commit legitimately re-anchors the attribution boundary)
	for (const inv of rollback.invalidated) {
		delete input.phaseStartDirt[inv];
		resetProtectionStrike(input.phaseProtectionStrikes, inv); // fresh protection interval on re-execution
	}
	return rollback.stashSha ? { phaseId: input.phaseId, stashSha: rollback.stashSha } : null;
}
