/**
 * Phase 1 — `rollbackWorktreeTo` behavior (spec-18 / AC-05, AC-10 → SCENARIO-010, SCENARIO-012).
 *
 * AUTHORITATIVE end-to-end coverage: drives a REAL `git` binary inside a fresh
 * hermetic temp repo per test (no mocked spawnSync) so we prove the actual
 * reset+clean BEHAVIOR, not just the argv shape (which is covered separately in
 * tests/tracking.test.ts). This guards against the tautological-test family: a
 * mock that merely asserts `spawnSync` was called can pass while the repo is
 * never actually reset — a real repo cannot lie.
 *
 * Coverage matrix:
 *   - SCENARIO-010 / AC-05 — rollback resets dirty tracked changes AND removes
 *     untracked files inside the worktree; returns {ok:true}.
 *   - AC-05 scope — the rollback touches ONLY the worktree dir (a sibling dir
 *     on the same filesystem is untouched).
 *   - default `commit='HEAD'` — rolls back to the last commit.
 *   - explicit earlier commit — `reset --hard <ref>` lands at that ref.
 *   - SCENARIO-012 / AC-10 — a non-git dir returns {ok:false} and NEVER throws.
 *   - AC-10 never-throw — undefined worktreePath and an invalid ref both return
 *     {ok:false} without throwing.
 *
 * Hermetic: each test `git init`s a unique `mkdtempSync` dir and removes it in
 * afterEach. NO shared state. Real `git` must be on PATH (it is — the repo
 * itself is a git worktree).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { rollbackWorktreeTo } from "../src/tracking.ts";

/** Run real git in `cwd` (no shell). Throws on failure so test setup is loud. */
function git(args: string[], cwd: string): string {
	return execFileSync("git", args, {
		cwd,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	}).toString().trim();
}

/** A fresh, committed, non-empty git repo. Returns its dir. */
let repo: string;
beforeEach(() => {
	repo = fs.mkdtempSync(path.join(os.tmpdir(), "rollback-"));
	// A deterministic identity so `git commit` doesn't refuse to run.
	git(["init", "-q", "-b", "main"], repo);
	git(["config", "user.email", "test@example.com"], repo);
	git(["config", "user.name", "Test"], repo);
});
afterEach(() => {
	fs.rmSync(repo, { recursive: true, force: true });
});

describe("rollbackWorktreeTo — dirty worktree reset (SCENARIO-010 / AC-05)", () => {
	it("reverts modified tracked files to the committed baseline and returns {ok:true}", () => {
		fs.writeFileSync(path.join(repo, "tracked.txt"), "baseline\n");
		git(["add", "-A"], repo);
		git(["commit", "-q", "-m", "baseline"], repo);

		// Dirty: modify the tracked file after commit.
		fs.writeFileSync(path.join(repo, "tracked.txt"), "DIRTY\n");
		expect(fs.readFileSync(path.join(repo, "tracked.txt"), "utf8")).toBe("DIRTY\n");

		const result = rollbackWorktreeTo(repo);

		expect(result.ok).toBe(true);
		expect(result.error).toBeUndefined();
		expect(fs.readFileSync(path.join(repo, "tracked.txt"), "utf8")).toBe("baseline\n");
	});

	it("removes untracked files/dirs via `clean -fd` and returns {ok:true}", () => {
		fs.writeFileSync(path.join(repo, "tracked.txt"), "baseline\n");
		git(["add", "-A"], repo);
		git(["commit", "-q", "-m", "baseline"], repo);

		// Dirty: an untracked file + an untracked nested dir.
		fs.writeFileSync(path.join(repo, "untracked.txt"), "junk\n");
		fs.mkdirSync(path.join(repo, "untracked-dir"));
		fs.writeFileSync(path.join(repo, "untracked-dir", "inner.txt"), "junk\n");
		expect(fs.existsSync(path.join(repo, "untracked.txt"))).toBe(true);
		expect(fs.existsSync(path.join(repo, "untracked-dir", "inner.txt"))).toBe(true);

		const result = rollbackWorktreeTo(repo);

		expect(result.ok).toBe(true);
		expect(fs.existsSync(path.join(repo, "untracked.txt"))).toBe(false);
		expect(fs.existsSync(path.join(repo, "untracked-dir"))).toBe(false);
		// Tracked file survives untouched.
		expect(fs.readFileSync(path.join(repo, "tracked.txt"), "utf8")).toBe("baseline\n");
	});

	it("resets BOTH modified tracked and untracked at once (full clean slate to HEAD)", () => {
		fs.writeFileSync(path.join(repo, "a.txt"), "v1\n");
		git(["add", "-A"], repo);
		git(["commit", "-q", "-m", "v1"], repo);

		fs.writeFileSync(path.join(repo, "a.txt"), "DIRTY\n");
		fs.writeFileSync(path.join(repo, "b.txt"), "new\n");
		const result = rollbackWorktreeTo(repo);

		expect(result.ok).toBe(true);
		expect(fs.readFileSync(path.join(repo, "a.txt"), "utf8")).toBe("v1\n");
		expect(fs.existsSync(path.join(repo, "b.txt"))).toBe(false);
	});
});

describe("rollbackWorktreeTo — explicit commit ref (default HEAD vs older ref)", () => {
	it("defaults to HEAD when no commit is passed", () => {
		fs.writeFileSync(path.join(repo, "a.txt"), "v1\n");
		git(["add", "-A"], repo);
		git(["commit", "-q", "-m", "v1"], repo);
		fs.writeFileSync(path.join(repo, "a.txt"), "dirty\n");
		// No second arg → defaults to HEAD (the only commit).
		expect(rollbackWorktreeTo(repo).ok).toBe(true);
		expect(fs.readFileSync(path.join(repo, "a.txt"), "utf8")).toBe("v1\n");
	});

	it("resets to an explicit earlier commit ref, discarding later commits", () => {
		fs.writeFileSync(path.join(repo, "a.txt"), "v1\n");
		git(["add", "-A"], repo);
		git(["commit", "-q", "-m", "v1"], repo);
		const first = git(["rev-parse", "HEAD"], repo);

		fs.writeFileSync(path.join(repo, "a.txt"), "v2\n");
		fs.writeFileSync(path.join(repo, "b.txt"), "v2\n");
		git(["add", "-A"], repo);
		git(["commit", "-q", "-m", "v2"], repo);

		// Roll back to the FIRST commit explicitly.
		const result = rollbackWorktreeTo(repo, first);
		expect(result.ok).toBe(true);
		expect(fs.readFileSync(path.join(repo, "a.txt"), "utf8")).toBe("v1\n");
		// b.txt was introduced in v2 — gone after resetting to v1 + clean.
		expect(fs.existsSync(path.join(repo, "b.txt"))).toBe(false);
	});
});

describe("rollbackWorktreeTo — scope is confined to the worktree (AC-05)", () => {
	it("never touches a sibling directory on the same filesystem", () => {
		fs.writeFileSync(path.join(repo, "tracked.txt"), "baseline\n");
		git(["add", "-A"], repo);
		git(["commit", "-q", "-m", "baseline"], repo);

		// A sibling dir OUTSIDE the worktree with its own files.
		const sibling = fs.mkdtempSync(path.join(os.tmpdir(), "sibling-"));
		try {
			fs.writeFileSync(path.join(sibling, "untouchable.txt"), "keep-me\n");
			fs.writeFileSync(path.join(repo, "tracked.txt"), "DIRTY\n");

			rollbackWorktreeTo(repo);

			expect(fs.readFileSync(path.join(sibling, "untouchable.txt"), "utf8")).toBe("keep-me\n");
			expect(fs.readFileSync(path.join(repo, "tracked.txt"), "utf8")).toBe("baseline\n");
		} finally {
			fs.rmSync(sibling, { recursive: true, force: true });
		}
	});
});

describe("rollbackWorktreeTo — never throws / degrades (SCENARIO-012 / AC-10)", () => {
	it("returns {ok:false} (no throw) for a non-git directory", () => {
		const nonGit = fs.mkdtempSync(path.join(os.tmpdir(), "not-a-repo-"));
		try {
			// Sanity: no .git here.
			expect(fs.existsSync(path.join(nonGit, ".git"))).toBe(false);
			const result = rollbackWorktreeTo(nonGit);
			expect(result.ok).toBe(false);
			expect(typeof result.error).toBe("string");
			expect(result.error!.length).toBeGreaterThan(0);
		} finally {
			fs.rmSync(nonGit, { recursive: true, force: true });
		}
	});

	it("returns {ok:false, error:'no worktreePath'} for an undefined path and never throws", () => {
		const result = rollbackWorktreeTo(undefined);
		expect(result.ok).toBe(false);
		expect(result.error).toBe("no worktreePath");
	});

	it("returns {ok:false} (no throw) for a commit ref that does not exist", () => {
		fs.writeFileSync(path.join(repo, "a.txt"), "v1\n");
		git(["add", "-A"], repo);
		git(["commit", "-q", "-m", "v1"], repo);
		const result = rollbackWorktreeTo(repo, "definitely-not-a-real-ref-zzz");
		expect(result.ok).toBe(false);
		expect(typeof result.error).toBe("string");
		expect(result.error!.length).toBeGreaterThan(0);
	});
});
