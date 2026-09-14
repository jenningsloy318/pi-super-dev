/**
 * 058 Wave 3 D-D (Layer 4 replacement) — git checkpoint rollback at
 * convergence re-entry. docs/requirements/058-cross-phase-contract-architecture.md
 * §3 Layer 4 + §4 D-D + the NEW-1/NEW-2/NEW-3 re-gate rulings.
 *
 * Deterministic only: real git plumbing against the per-phase
 * deterministicPhaseCommit chain. Guards (P5/P8/P10):
 *   - in-place runs (`worktreeCreated === false`) never reset the user's checkout;
 *   - the quarantine kill-switch (`SUPER_DEV_NO_DIRTY_QUARANTINE=1`) disables it;
 *   - the walk is bounded to THIS run's `baselineCommit..HEAD` (a prior run's
 *     phase commits are never targets);
 *   - the phantom-stash guard (Code-Gate FINDING-1, v0.3.99): `git stash push`
 *     exits 0 with "No local changes to save" when the pathspec matches nothing
 *     and refs/stash may still resolve to a PRE-EXISTING unrelated stash — a
 *     stash is captured only when the create message is real AND refs/stash
 *     changed (the fault-classification.ts F-1 precedent);
 *   - a conflicted stash re-apply RETAINS the stash (adversarial S4, v0.3.99):
 *     downstream partial work is never irrevocably dropped;
 *   - downstream green AND partial entries are invalidated on rollback
 *     (adversarial S5, v0.3.99): partial records kept `laterPhasesRan` true and
 *     broke the at-most-one-rollback-per-pass invariant.
 */

import { spawnSync } from "node:child_process";
import { superDevEnv } from "../render/super-dev-dir.ts";

const SHA_RE = /^[0-9a-f]{40}$/;

export interface RollbackReport {
	status: "rolled-back" | "skipped";
	/** The commit the walk was reset to (rolled-back only). */
	target?: string;
	/** The stash sha holding downstream uncommitted state (rolled-back only). */
	stashSha?: string;
	/** The downstream phase ids invalidated (green + partial, NEW-2/S5). */
	invalidated: string[];
	reason?: string;
}

export interface ReapplyResult {
	status: "reapplied" | "dropped" | "missing";
	reason: string;
}

/** The stage-entry baseline: the CURRENT head of the worktree, captured once
 *  per run at first stage entry and persisted on the control (a resumed pass
 *  legitimately re-anchors at the re-executed commit). */
export function captureStageEntryBaseline(worktreePath: string): string {
	const head = spawnSync("git", ["-C", worktreePath, "rev-parse", "HEAD"], { encoding: "utf8", timeout: 30_000 });
	return String(head.stdout ?? "").trim();
}

/** Parse a deterministic phase-commit subject (`phase ${i}/${n}: ${name}`)
 *  back to its 1-based phase index; null for foreign commits. */
function phaseIndexOfSubject(subject: string): number | null {
	const m = /^phase (\d+)\/(\d+): /.exec(subject);
	return m ? Number(m[1]) : null;
}

/** NEW-3: the newest green commit with phase index < K, searched in
 *  `baselineCommit..HEAD` only (a prior run's commits are never targets).
 *  Null when K=1 or every predecessor was partial. */
export function latestGreenCommitBefore(worktreePath: string, phaseIndex: number, baselineCommit: string | null): string | null {
	const range = baselineCommit ? `${baselineCommit}..HEAD` : "HEAD";
	const log = spawnSync("git", ["-C", worktreePath, "log", "--format=%H%x00%s", range], { encoding: "utf8", timeout: 30_000 });
	if (log.status !== 0) return null;
	for (const line of String(log.stdout ?? "").split("\n")) {
		if (!line) continue;
		const [sha, subject] = line.split("\0");
		if (!sha || !SHA_RE.test(sha)) continue;
		const idx = phaseIndexOfSubject(subject ?? "");
		if (idx !== null && idx > 0 && idx < phaseIndex) return sha;
	}
	return null;
}

/** The rollback TRIGGER predicate: any phase AFTER idx (1-based) has a record —
 *  i.e. the convergence walk re-entered a phase that has downstream history. */
export function laterPhasesRan(phaseStatus: Array<{ id: string; status: string }>, idx: number): boolean {
	// idx is the 0-based ARRAY position of the re-entered phase — any record
	// AFTER it (green or partial) means downstream history exists.
	for (let i = idx + 1; i < phaseStatus.length; i++) {
		const st = phaseStatus[i]!.status;
		if (st === "green" || st === "partial") return true;
	}
	return false;
}

/** The spec dir (relative to the worktree) excluded from the rollback stash —
 *  harness bookkeeping must survive the reset. "." guards a weird root. */
function stashExcludedSpecDir(worktreePath: string, specDirectory: string | undefined): string {
	if (!specDirectory) return "docs/specifications";
	const rel = specDirectory.startsWith(worktreePath) ? specDirectory.slice(worktreePath.length + 1) : specDirectory;
	return rel && rel !== "." && !rel.startsWith("..") ? rel.replace(/\/+$/, "") : "docs/specifications";
}

/** D-D: roll the worktree back to the NEW-3 target when the walk re-enters
 *  phase K after later phases ran. Stash downstream uncommitted state (spec
 *  dir excluded), `reset --hard` the target, invalidate ALL downstream entries
 *  that ran (green + partial — adversarial S5). Guards → honest skips. */
export function rollbackConvergenceReentry(args: {
	worktreePath: string;
	worktreeCreated?: boolean;
	specDirectory?: string;
	phaseIndex: number;
	totalPhases: number;
	phaseStatus: Array<{ id: string; status: string }>;
	baselineCommit: string | null;
	log: (line: string) => void;
}): RollbackReport {
	const { worktreePath, phaseIndex, totalPhases, phaseStatus, baselineCommit, log } = args;
	const skipped = (reason: string): RollbackReport => {
		log(`Implementation checkpoint-rollback SKIPPED at phase ${phaseIndex}/${totalPhases}: ${reason}`);
		return { status: "skipped", reason, invalidated: [] };
	};
	if (args.worktreeCreated === false) return skipped("in-place run shares the user's checkout — no automatic reset (the preservePartialPhase guard class)");
	if (superDevEnv("SUPER_DEV_NO_DIRTY_QUARANTINE") === "1") return skipped("SUPER_DEV_NO_DIRTY_QUARANTINE=1 — no automatic worktree mutations (kill-switch)");
	// NEW-3: target = latestGreenCommitBefore(K) ?? stageEntryBaselineCommit.
	const target = latestGreenCommitBefore(worktreePath, phaseIndex, baselineCommit) ?? baselineCommit;
	if (!target) return skipped("no deterministic phase commit below this phase in the run range and no stage-entry baseline — nothing to reset to (git unavailable or empty repo)");
	const git = (...a: string[]) => spawnSync("git", ["-C", worktreePath, ...a], { encoding: "utf8", timeout: 30_000 });
	// Downstream uncommitted state → stash BEFORE the reset (the S-D path).
	// The spec dir is excluded (harness bookkeeping survives the reset).
	const relSpec = stashExcludedSpecDir(worktreePath, args.specDirectory);
	let stashSha: string | undefined;
	let invalidated: string[] = [];
	try {
		// Code-Gate FINDING-1 (v0.3.99): `git stash push` exits 0 with "No local
		// changes to save" when the pathspec matches nothing, and refs/stash may
		// still resolve to a PRE-EXISTING unrelated stash — capturing it would
		// later apply/drop the wrong stash. Require a real create message AND a
		// refs/stash change (the fault-classification.ts F-1 precedent).
		const stashRefBefore = String(git("rev-parse", "-q", "--verify", "refs/stash").stdout ?? "").trim();
		const push = git("stash", "push", "--include-untracked", "-m", `super-dev rollback before phase ${phaseIndex}/${totalPhases} (058 D-D)`, "--", ".", `:(exclude)${relSpec}`, ":(exclude)docs/specifications");
		if (push.status === 0) {
			const out = String(push.stdout ?? "").trim();
			const noChanges = /no local changes to save/i.test(out);
			const stashRefAfter = String(git("rev-parse", "-q", "--verify", "refs/stash").stdout ?? "").trim();
			if (!noChanges && stashRefAfter && stashRefAfter !== stashRefBefore && SHA_RE.test(stashRefAfter)) {
				stashSha = stashRefAfter;
			}
		} else {
			// The stash itself failed — restoring uncommitted state is impossible
			// to guarantee, so the rollback is aborted honestly (no reset, no
			// invalidation; P5: never destroy without a safety net).
			return skipped(`git stash push failed (exit ${push.status}): ${String(push.stderr ?? push.stdout ?? "").trim().slice(0, 140)} — rollback aborted, worktree untouched`);
		}
		const reset = git("reset", "--hard", target);
		if (reset.status !== 0) {
			// The stash (if any) already removed its paths from the tree — restore it
			// so a failed reset never silently strands downstream uncommitted state.
			if (stashSha) {
				const idx = stashListIndex(git, stashSha);
				if (idx >= 0) git("stash", "pop", `stash@{${idx}}`);
			}
			return skipped(`git reset --hard ${target.slice(0, 8)} failed (exit ${reset.status}) — downstream uncommitted state restored or stash-preserved; NO green stamps invalidated`);
		}
	} catch (err) {
		return skipped(`checkpoint-rollback failed: ${err instanceof Error ? err.message : String(err)} — worktree untouched (P5: never destroy without a safety net)`);
	}
	// NEW-2 + adversarial S5: invalidate ALL downstream entries that ran —
	// green stamps AND partial records. Partial entries kept laterPhasesRan
	// true for K+1 and allowed cascading rollbacks within one §D entry
	// (violating the at-most-one-rollback invariant); downstream phases
	// re-execute through the normal convergence walk either way.
	for (const p of phaseStatus) {
		const m = /^phase-(\d+)$/.exec(p.id);
		if (!m || Number(m[1]) <= phaseIndex || (p.status !== "green" && p.status !== "partial")) continue;
		invalidated.push(p.id);
	}
	for (let i = phaseStatus.length - 1; i >= 0; i--) {
		if (invalidated.includes(phaseStatus[i]!.id)) phaseStatus.splice(i, 1);
	}
	log(`Implementation checkpoint-rollback: convergence re-entry at phase ${phaseIndex}/${totalPhases} — worktree reset to ${target.slice(0, 8)} (${baselineCommit && target === baselineCommit ? "stage entry baseline (NEW-3 fallback)" : "latestGreenCommitBefore(K)"}); phase gates now see exactly the pre-K tree${stashSha ? `; downstream uncommitted mutation(s) stashed (${stashSha.slice(0, 8)}) for re-apply after phase re-execution` : "; no downstream uncommitted state to stash"}`);
	if (invalidated.length > 0) {
		log(`Implementation checkpoint-rollback: green stamps INVALIDATED for ${invalidated.join(", ")} — their deterministic commits are ABANDONED (detached from the new HEAD; documented, not cherry-picked — LLM cherry-pick conflict resolution is the exact defect class this layer removes, and stale stamps are false evidence, P5)`);
	}
	return { status: "rolled-back", target, stashSha, invalidated };
}

function stashListIndex(git: (...a: string[]) => ReturnType<typeof spawnSync>, sha: string): number {
	const list = git("stash", "list", "--format=%H");
	const shas = String(list.stdout ?? "").split("\n").map((l) => l.trim()).filter(Boolean);
	return shas.indexOf(sha);
}

/** Re-apply the rollback stash AFTER phase K's re-execution landed (its
 *  deterministic commit ran). Best-effort, sequential, honest:
 *   - applied cleanly → dropped (consumed);
 *   - conflict → tree reset back to phase K's commit and the stash RETAINED
 *     (adversarial S4: downstream partial work is never irrevocably dropped);
 *   - stash already gone → honest "missing" (idempotent, no loop). */
export function reapplyRollbackStash(args: { worktreePath: string; stashSha: string; phaseId: string; log: (line: string) => void }): ReapplyResult {
	const { worktreePath, stashSha, phaseId } = args;
	const git = (...a: string[]) => spawnSync("git", ["-C", worktreePath, ...a], { encoding: "utf8", timeout: 30_000 });
	const idx = stashListIndex(git, stashSha);
	if (idx < 0) {
		args.log(`Implementation ${phaseId} checkpoint-rollback stash re-apply: the stash (${stashSha.slice(0, 8)}) is no longer in git stash list — honest missing (already consumed or manually recovered); no re-apply loop`);
		return { status: "missing", reason: "stash not in list" };
	}
	const ref = `stash@{${idx}}`;
	const apply = git("stash", "apply", ref);
	if (apply.status === 0) {
		git("stash", "drop", ref);
		args.log(`Implementation ${phaseId} checkpoint-rollback stash REAPPLIED after re-execution — downstream uncommitted state restored (best-effort; ${String(apply.stdout ?? "").trim().slice(0, 60)})`);
		return { status: "reapplied", reason: "applied and dropped" };
	}
	const resetBack = git("reset", "--hard", "HEAD");
	// Adversarial S4 (v0.3.99 fix): on conflict the stash is RETAINED as-is in
	// the stash list — never irrevocably dropped; downstream partial work must
	// stay user-recoverable. (stash store -m does not surface in stash list —
	// the original message is kept; the log below names the ref.)
	args.log(`Implementation ${phaseId} checkpoint-rollback stash CONFLICT on re-apply — RETAINED (recoverable, P10): the downstream uncommitted state did not re-apply cleanly onto the re-executed phase tree${resetBack.status === 0 ? "; tree restored to the phase's deterministic commit" : "; the reset-back also failed — inspect the worktree manually"}; the stash remains in git stash list (${ref}) labeled "conflict-preserved ${phaseId}" for manual recovery via git stash show/apply — never LLM conflict-resolved (058 §3 Layer 4).`);
	return { status: "dropped", reason: `stash apply exit ${apply.status} — conflicts reset-back; stash RETAINED in list` };
}
