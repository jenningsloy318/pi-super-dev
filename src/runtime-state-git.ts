/**
 * v0.4.3 — resume-cache durability: super-dev runtime state must never be
 * git-tracked inside a worktree.
 *
 * Incident (run 2026-09-15T08-13-05-056Z, spec-26): `.resume-cache.jsonl` and
 * nine sibling state files were TRACKED — the deterministic phase committer's
 * `git add -A` had snapshotted them into commit 5d613aa — so every
 * checkpoint-rollback `git reset --hard 5d613aa` silently reverted the resume
 * cache to that snapshot, destroying every row appended after it (the
 * prototype round, design/bdd/spec review rounds, phases 02..05). The next
 * resume replayed those stages LIVE — expensive, and exactly the cost the
 * resume cache exists to avoid.
 *
 * The three git consumers already ASSUMED these files were untracked:
 *   - checkpoint-rollback.ts excludes the spec dir from the rollback stash
 *     "so harness bookkeeping survives the reset" (a stash exclusion cannot
 *     protect a TRACKED file from the subsequent reset --hard);
 *   - tracking.ts rollbackWorktreeTo excludes the same names from `git clean`
 *     with the comment "untracked artifacts";
 *   - the RED write-boundary treats them as engine bookkeeping, not content.
 * This module makes reality match the assumption, once per setup:
 *   1. UNTRACK: `git rm --cached` any registry basename found in the index
 *      (the on-disk file is untouched; the next phase commit records the
 *      untracking once, honestly);
 *   2. IGNORE: append each path to the COMMON git dir's `info/exclude` so
 *	     `git add -A` cannot re-track it and `git status` stays clean
 *      (gitrepository-layout(5): git never reads the per-worktree
 *	     .git/worktrees/<id>/info/exclude — the setup.ts excludeCopiedEnvFiles
 *	     ISS-01 precedent; the project's own .gitignore is never touched).
 *
 * Guards (P5/P10): worktree runs only — an in-place run shares the user's
 * checkout and gets a WARN, never an index mutation (the deterministicPhaseCommit
 * in-place fallback + the commit-exclusion union still protect it). Never
 * throws: every git call is best-effort and failures land in the report the
 * caller logs. Idempotent: a second run finds nothing tracked and no missing
 * exclude lines.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, appendFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { harnessBasenames } from "./harness-paths.ts";

export interface RuntimeStateUntrackReport {
	status: "applied" | "skipped";
	reason?: string;
	/** Paths removed from the index (still on disk). */
	untracked: string[];
	/** Paths appended to $GIT_DIR/info/exclude this run. */
	ignored: string[];
	/** Per-path git failures — logged by the caller, never thrown. */
	errors: string[];
}

export type GitRunner = (...args: string[]) => { status: number; stdout: string; stderr: string };

export const defaultGitRunner = (worktreePath: string) => (...args: string[]): { status: number; stdout: string; stderr: string } => {
	const r = spawnSync("git", ["-C", worktreePath, ...args], { encoding: "utf8", timeout: 30_000 });
	return { status: r.status ?? 1, stdout: String(r.stdout ?? ""), stderr: String(r.stderr ?? "") };
};

/** The spec dir relative to the worktree root (parity with
 *  checkpoint-rollback.ts stashExcludedSpecDir — same normalization, kept
 *  literal so a future refactor must consciously unify them). */
function relativeSpecDir(worktreePath: string, specDirectory: string | undefined): string {
	if (!specDirectory) return "docs/specifications";
	const rel = specDirectory.startsWith(worktreePath) ? specDirectory.slice(worktreePath.length + 1) : specDirectory;
	return rel && rel !== "." && !rel.startsWith("..") ? rel.replace(/\/+$/, "") : "docs/specifications";
}

/** Untrack + git-ignore every `neverGitTracked` harness basename under the
 *  spec dir. Idempotent, best-effort, never throws. */
export function ensureRuntimeStateUntracked(args: {
	worktreePath: string;
	specDirectory?: string;
	worktreeCreated?: boolean;
	log?: (line: string) => void;
	git?: GitRunner;
	/** 063 S1 (H4 geometry guard): EXTRA in-tree paths to info/exclude — the
	 *  state-subtree relative path when the external store resolves INSIDE the
	 *  worktree (dotfiles repos). Exclusion prevents tracking, so the store
	 *  keeps its worktree-death durability there. */
	extraExcludePaths?: string[];
}): RuntimeStateUntrackReport {
	const report: RuntimeStateUntrackReport = { status: "applied", untracked: [], ignored: [], errors: [] };
	if (args.worktreeCreated === false) {
		return { status: "skipped", reason: "in-place run shares the user's checkout — runtime state left as-is (no automatic index mutations); the phase-commit exclusion union still keeps it out of deterministic commits", untracked: [], ignored: [], errors: [] };
	}
	try {
		const git = args.git ?? defaultGitRunner(args.worktreePath);
		const relSpec = relativeSpecDir(args.worktreePath, args.specDirectory);
		const basenames = [...harnessBasenames("neverGitTracked")].sort();

		// 1. Untrack anything the index still knows, then make the untracking
		// DURABLE: `git rm --cached` alone leaves the path in HEAD, so a later
		// `git reset --hard` (the checkpoint rollback) restores and re-tracks it.
		// Only a COMMIT removing the path from history protects it — so setup
		// commits the untracking itself (paths only; the rest of the tree is
		// untouched). If this commit fails, the staged deletion still rides the
		// next deterministic phase commit (the committer admits staged deletions
		// of excluded basenames — implementation.ts).
		const untrackedPaths: string[] = [];
		for (const base of basenames) {
			const rel = `${relSpec}/${base}`;
			try {
				const listed = git("ls-files", "--", rel);
				if (listed.status !== 0) {
					report.errors.push(`ls-files ${rel} failed: ${listed.stderr.trim().slice(0, 120)}`);
					continue;
				}
				if (!listed.stdout.trim()) continue; // not tracked — nothing to do
				const rm = git("rm", "--cached", "--quiet", "--", rel);
				if (rm.status !== 0) {
					report.errors.push(`rm --cached ${rel} failed: ${rm.stderr.trim().slice(0, 120)}`);
					continue;
				}
				report.untracked.push(rel);
				untrackedPaths.push(rel);
			} catch (err) {
				report.errors.push(`${rel}: ${err instanceof Error ? err.message : String(err)}`);
			}
		}
		if (untrackedPaths.length > 0) {
			// git pathspec-limited commit takes the WORKING-TREE content of the
			// named paths — with the file still on disk it would re-commit the
			// content and keep the file tracked (verified: the deletion never
			// lands). Move the files aside for the commit, then move them back:
			// the commit records the DELETION; the ledgers stay on disk untracked.
			const parked: Array<{ abs: string; tmp: string }> = [];
			try {
				for (const rel of untrackedPaths) {
					const abs = join(args.worktreePath, rel);
					if (existsSync(abs)) {
						const tmp = `${abs}.sd-untrack-tmp`;
						renameSync(abs, tmp);
						parked.push({ abs, tmp });
					}
				}
				const commit = git("commit", "-qm", "chore(super-dev): untrack runtime state ledgers (v0.4.3 resume-cache durability)", "--", ...untrackedPaths);

				if (commit.status !== 0) {
					report.errors.push(`untracking commit failed (the staged deletion still rides the next phase commit): ${commit.stderr.trim().slice(0, 160)}`);
				}
			} finally {
				// Guarded restore (Code-Gate ADV-4): one failed rename must never
				// strand the remaining parked files as *.sd-untrack-tmp.
				for (const p of parked) {
					try {
						if (existsSync(p.tmp)) renameSync(p.tmp, p.abs);
					} catch (restoreErr) {
						report.errors.push(`restore ${p.abs} failed: ${restoreErr instanceof Error ? restoreErr.message : String(restoreErr)}`);
					}
				}
			}
		}

		// 2. Ignore the paths so `git add -A` cannot re-track them. Written to the
		// COMMON git dir's info/exclude — the only per-repo exclude git reads for
		// EVERY worktree (gitrepository-layout(5); git never reads
		// .git/worktrees/<id>/info/exclude — the setup.ts excludeCopiedEnvFiles
		// ISS-01 precedent, Code-Gate BLOCK-1). Patterns are repo-relative and
		// intentionally apply to all worktrees + the main checkout: super-dev's
		// runtime ledgers are machine state, never project content anywhere. The
		// project's own .gitignore is never touched.
		try {
			const gd = git("rev-parse", "--git-common-dir");
			if (gd.status !== 0 || !gd.stdout.trim()) {
				report.errors.push(`rev-parse --git-common-dir failed: ${gd.stderr.trim().slice(0, 120)}`);
			} else {
				// git may return a relative common dir ("../../.git") — resolve
				// against the worktree root; absolute outputs pass through unchanged.
				const infoDir = join(resolve(args.worktreePath, gd.stdout.trim()), "info");
				const excludePath = join(infoDir, "exclude");
				mkdirSync(infoDir, { recursive: true });
				const existing = existsSync(excludePath) ? readFileSync(excludePath, "utf8") : "";
				const lines = new Set(existing.split("\n").map((l) => l.trim()));
				const wanted = basenames.map((base) => `${relSpec}/${base}`);
				// 063 S1 (H4): the geometry guard's extra paths ride the same
				// exclude write (the state subtree when it resolves in-tree).
				for (const extra of args.extraExcludePaths ?? []) if (!wanted.includes(extra)) wanted.push(extra);
				const missing = wanted.filter((p) => !lines.has(p));
				if (missing.length > 0) {
					const block = [`# super-dev runtime state (v0.4.3) — machine-ledgers, never project content`, ...missing, ""];
					appendFileSync(excludePath, (existing.endsWith("\n") || existing === "" ? "" : "\n") + block.join("\n"));
					report.ignored.push(...missing);
				}
			}
		} catch (err) {
			report.errors.push(`info/exclude: ${err instanceof Error ? err.message : String(err)}`);
		}

		if (report.errors.length > 0 && report.untracked.length === 0 && report.ignored.length === 0) {
			report.status = "skipped";
			report.reason = `all operations failed: ${report.errors[0]}`;
		}
	} catch (err) {
		return { status: "skipped", reason: `ensureRuntimeStateUntracked failed: ${err instanceof Error ? err.message : String(err)}`, untracked: report.untracked, ignored: report.ignored, errors: report.errors };
	}
	return report;
}
