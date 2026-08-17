/**
 * H6/ISS-01 (AC-08, SCENARIO-017/018): copied env files are excluded from
 * staging via the repo's COMMON git exclude file so pipeline commits
 * (`git add -A`-based staging) can never sweep a copied `.env.*` secret into
 * a fix commit or the merge.
 *
 * Drift resolution ISS-01 (spec-28): the exclude file is
 * `$(git -C <worktree> rev-parse --git-common-dir)/info/exclude` — the only
 * per-repo exclude git reads for EVERY worktree. The per-worktree
 * `--git-path info.exclude` file resolves to `.git/worktrees/<id>/info/exclude`
 * and is NEVER read by git (verified on git 2.47.3) — the implementation must
 * not write there.
 *
 * All fixtures are REAL git repos in temp dirs (git init, commit, worktree) —
 * the observable is git's own check-ignore / index / commit-tree behavior.
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execSync, spawnSync } from "node:child_process";
import { runSetup } from "../src/setup.ts";
import { commitWorktreeChanges } from "../src/helpers.ts";

const sh = (cwd: string, cmd: string): string => {
	try { return execSync(cmd, { cwd, encoding: "utf8" }); } catch { return ""; }
};

/** A real repo with one base commit and an UNTRACKED-UNIGNORED
 *  `.env.development` — the adversarial source shape (no .gitignore help). */
function fixtureRepo(): string {
	const root = mkdtempSync(join(tmpdir(), "sd-envex-"));
	sh(root, "git init -b main && git config user.email t@t && git config user.name t");
	writeFileSync(join(root, "a.txt"), "base\n");
	sh(root, "git add a.txt && git commit -m base");
	writeFileSync(join(root, ".env.development"), "DEV_SECRET=1\n");
	return root;
}

/** exit code of `git -C dir check-ignore -- <path>` (0 = ignored). */
const checkIgnore = (dir: string, path: string): number =>
	spawnSync("git", ["-C", dir, "check-ignore", "--", path], { encoding: "utf8" }).status ?? -1;

describe("copied env files are excluded from staging (AC-08, ISS-01)", () => {
	it("SCENARIO-017: after copy + commitWorktreeChanges the env path is check-ignore'd, untracked, never staged, and absent from the commit", () => {
		const root = fixtureRepo();
		try {
			const s = runSetup("implement a node api", { cwd: root });
			expect(s.worktreeCreated).toBe(true);
			// the copier copied it (the premise of the scenario)
			expect(existsSync(join(s.worktreePath, ".env.development"))).toBe(true);

			// excluded via the COMMON exclude file (ISS-01): readable by git in
			// this worktree; the per-worktree --git-path file is never written
			expect(checkIgnore(s.worktreePath, ".env.development")).toBe(0);
			const commonDir = sh(s.worktreePath, "git rev-parse --git-common-dir").trim();
			const commonExclude = join(resolve(s.worktreePath, commonDir), "info", "exclude");
			expect(readFileSync(commonExclude, "utf8")).toContain(".env.development");
			expect(existsSync(join(resolve(s.worktreePath, sh(s.worktreePath, "git rev-parse --git-path info.exclude").trim())))).toBe(false);

			// still untracked (never swept by the -A stage): not in the index,
			// not staged, and a deterministic pipeline commit leaves it behind
			expect(sh(s.worktreePath, "git ls-files -- .env.development").trim()).toBe("");
			writeFileSync(join(s.worktreePath, "fix.txt"), "fix\n");
			const c = commitWorktreeChanges(s.worktreePath, "fix(verify): address review findings (round 1)");
			expect(c.committed).toBe(true);
			const committed = sh(s.worktreePath, "git diff-tree --no-commit-id --name-only -r HEAD");
			expect(committed.includes("fix.txt")).toBe(true); // the fix shipped
			expect(committed.includes(".env.development")).toBe(false); // the secret did not
			expect(sh(s.worktreePath, "git ls-files").includes(".env.development")).toBe(false);
			const ignored = sh(s.worktreePath, "git status --porcelain --ignored");
			expect(ignored.includes("!! .env.development")).toBe(true);
			expect(ignored.includes(".run-lock")).toBe(true); // spec-28 review F-04: lock never staged either // ignored, not staged
		} finally { rmSync(root, { recursive: true, force: true }); }
	});

	it("SCENARIO-018: second fix commit and the merge commit also exclude the env path — regardless of the source repo's ignore state", () => {
		const root = fixtureRepo();
		try {
			const s = runSetup("implement a node api", { cwd: root });
			const wt = s.worktreePath;
			// fix commit 2
			writeFileSync(join(wt, "fix2.txt"), "fix2\n");
			expect(commitWorktreeChanges(wt, "fix(verify): address review findings (round 2)").committed).toBe(true);
			// merge the feature branch into main (the merge agent's geometry)
			sh(root, `git merge --no-ff ${s.specIdentifier} -m "merge: implement a node api"`);
			// the merge commit tree does not contain the env path
			expect(sh(root, "git ls-tree -r HEAD --name-only").includes(".env.development")).toBe(false);
			// source repo does NOT ignore it (.gitignore is absent) — yet the
			// repo-wide common exclude still protects `git add -A` in the MAIN
			// checkout too (patterns are repo-relative by design)
			expect(sh(root, "git check-ignore -q .env.development; echo $?").trim()).toBe("0");
			writeFileSync(join(root, "post-merge.txt"), "x\n");
			sh(root, "git add -A");
			expect(sh(root, "git diff --cached --name-only").includes(".env.development")).toBe(false);
			sh(root, "git reset -q");
		} finally { rmSync(root, { recursive: true, force: true }); }
	});

	it("exclude append is IDEMPOTENT — repeated setups never duplicate the header or the pattern", () => {
		const root = fixtureRepo();
		try {
			const first = runSetup("implement a node api", { cwd: root });
			// a second fresh track (no recorded progress ⇒ not reusable) copies
			// the same env file again and appends again
			const second = runSetup("implement a node api", { cwd: root, slug: "another-task" });
			expect(second.specIdentifier).not.toBe(first.specIdentifier);
			const commonDir = sh(second.worktreePath, "git rev-parse --git-common-dir").trim();
			const excludePath = join(resolve(second.worktreePath, commonDir), "info", "exclude");
			const text = readFileSync(excludePath, "utf8");
			expect(text.split("\n").filter((l) => l === ".env.development")).toHaveLength(1);
			expect(text.split("pi-super-dev copied env files (never committed)")).toHaveLength(2); // one line, its \n terminator
			// and the earlier worktree's exclusion still holds
			expect(checkIgnore(first.worktreePath, ".env.development")).toBe(0);
		} finally { rmSync(root, { recursive: true, force: true }); }
	});

	it("SCENARIO-017 (nested path): a copied apps/web/.env.development is excluded under its repo-relative path", () => {
		const root = fixtureRepo();
		try {
			sh(root, "mkdir -p apps/web");
			writeFileSync(join(root, "apps", "web", ".env.development"), "WEB_SECRET=1\n");
			const s = runSetup("implement a node api", { cwd: root });
			expect(existsSync(join(s.worktreePath, "apps", "web", ".env.development"))).toBe(true);
			expect(checkIgnore(s.worktreePath, "apps/web/.env.development")).toBe(0);
			writeFileSync(join(s.worktreePath, "fix.txt"), "fix\n");
			expect(commitWorktreeChanges(s.worktreePath, "fix").committed).toBe(true);
			expect(sh(s.worktreePath, "git ls-files").includes("apps/web/.env.development")).toBe(false);
		} finally { rmSync(root, { recursive: true, force: true }); }
	});
});
