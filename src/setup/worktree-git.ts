import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

/** Wave 4 increment 3b: the WORKTREE/GIT BOOTSTRAP — moved verbatim from
 *  setup.ts: the quiet git() helper (now exported — setup.ts's own git calls
 *  import it from here), branchExists, gitWithStderr (H7/AC-09 both-streams
 *  capture), createOrReuseWorktree (SCENARIO-020 prune+retry, SCENARIO-019
 *  fail-closed), detectDefaultBranch, isGitRepo, headExists, and
 *  ensureGitIdentity. One reason to change: how the worktree is created. */

export function git(args: string[], cwd: string): string | null {
	try {
		return execFileSync("git", args, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim();
	} catch {
		return null;
	}
}

export function branchExists(cwd: string, branch: string): boolean {
	return git(["rev-parse", "--verify", `refs/heads/${branch}`], cwd) !== null;
}

/** H7 (AC-09): run git capturing BOTH streams — the fail-closed worktree-add
 *  error message must surface git's own stderr tail (diagnosability), which
 *  the silent-stderr `git()` helper cannot provide. Never throws. */
function gitWithStderr(args: string[], cwd: string): { stdout: string; stderr: string } {
	try {
		const out = execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
		return { stdout: out, stderr: "" };
	} catch (err) {
		const e = err as { stdout?: string; stderr?: string; message?: string };
		return { stdout: String(e.stdout ?? ""), stderr: String(e.stderr ?? e.message ?? "") };
	}
}

export function createOrReuseWorktree(cwd: string, specIdentifier: string, defaultBranch: string): { worktreePath: string; worktreeCreated: boolean } {
	const wtPath = join(cwd, ".worktree", specIdentifier);
	if (existsSync(wtPath)) return { worktreePath: wtPath, worktreeCreated: true };
	const args = branchExists(cwd, specIdentifier)
		? ["worktree", "add", wtPath, specIdentifier]
		: ["worktree", "add", "-b", specIdentifier, wtPath, defaultBranch];
	const created = git(args, cwd);
	if (created !== null || existsSync(wtPath)) return { worktreePath: wtPath, worktreeCreated: true };
	// H7 (AC-09 / SCENARIO-020): prune once and retry once — a stale
	// registration for a deleted .worktree/<id> path is the common recoverable
	// failure (worktree dir removed without `git worktree remove`).
	git(["worktree", "prune"], cwd);
	const retried = git(args, cwd);
	if (retried !== null || existsSync(wtPath)) return { worktreePath: wtPath, worktreeCreated: true };
	// H7 (AC-09 / SCENARIO-019): FAIL CLOSED — never silently fall back to
	// running in the user's main checkout with no isolation. Surface git's
	// stderr tail plus the recovery hint.
	const { stderr } = gitWithStderr(args, cwd);
	throw new Error(`git worktree add failed for ${specIdentifier} even after \`git worktree prune\` + one retry — git stderr: ${stderr.trim().slice(-400) || "(none)"}. Run \`git worktree prune\` manually and retry, or set skipWorktree to run in place deliberately.`);
}

export function detectDefaultBranch(cwd: string): string {
	const fromOrigin = git(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], cwd);
	if (fromOrigin && fromOrigin.startsWith("origin/")) return fromOrigin.slice("origin/".length);
	const current = git(["rev-parse", "--abbrev-ref", "HEAD"], cwd);
	if (current && current !== "HEAD") return current;
	return "main";
}

export function isGitRepo(cwd: string): boolean {
	return git(["rev-parse", "--is-inside-work-tree"], cwd) !== null;
}

export function headExists(cwd: string): boolean {
	return git(["rev-parse", "--verify", "HEAD"], cwd) !== null;
}

export function ensureGitIdentity(cwd: string): void {
	if (!git(["config", "user.email"], cwd)) git(["config", "user.email", "pi-super-dev@local"], cwd);
	if (!git(["config", "user.name"], cwd)) git(["config", "user.name", "pi-super-dev"], cwd);
}
