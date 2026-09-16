/**
 * v0.4.3 — resume-cache durability: super-dev runtime state must never be
 * git-tracked inside a worktree (runtime-state-git.ts).
 *
 * The incident this suite pins (run 2026-09-15T08-13-05-056Z, spec-26):
 * `.resume-cache.jsonl` was TRACKED — the deterministic phase committer's
 * `git add -A` had snapshotted it into the phase-1 commit — so every
 * checkpoint-rollback `git reset --hard <phase-commit>` silently reverted the
 * resume cache to that snapshot, destroying every row appended after it (the
 * prototype round, review rounds, phases 02..05). The next resume replayed
 * those stages LIVE. The three commit/rollback consumers all ASSUMED the files
 * were untracked; this suite pins that setup now makes reality match.
 *
 * Deterministic only: REAL git repos, REAL resets — mirrors
 * tests/checkpoint-rollback-058.test.ts style.
 */

import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ensureRuntimeStateUntracked } from "../src/runtime-state-git.ts";
import { harnessBasenames } from "../src/harness-paths.ts";
// Hoisted to module top level so implementation.ts (the repo's largest module)
// transforms/evaluates at COLLECTION time, outside any per-test timer
// (Code-Gate review: a dynamic import inside the test flaked at vitest's 5000ms
// default testTimeout on cold/loaded runs).
import { deterministicPhaseCommit } from "../src/stages/implementation/index.ts";

const SPEC = "docs/specifications/26-x";

function makeRepo(prefix: string): { repo: string; git: (...args: string[]) => { status: number; stdout: string; stderr: string } } {
	const repo = mkdtempSync(join(tmpdir(), prefix));
	const git = (...args: string[]) => {
		const r = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
		return { status: r.status ?? 1, stdout: String(r.stdout ?? ""), stderr: String(r.stderr ?? "") };
	};
	git("init", "-q", "--initial-branch=main");
	git("config", "user.email", "t@t");
	git("config", "user.name", "t");
	writeFileSync(join(repo, "seed.txt"), "seed\n");
	git("add", "-A");
	git("commit", "-qm", "seed");
	return { repo, git };
}

function trackStateFiles(repo: string, git: (...args: string[]) => { status: number; stdout: string; stderr: string }): void {
	const specDir = join(repo, SPEC);
	mkdirSync(specDir, { recursive: true });
	mkdirSync(join(repo, "src"), { recursive: true });
	writeFileSync(join(specDir, ".resume-cache.jsonl"), JSON.stringify({ key: "pipeline.classify@root#1", result: { text: "a", control: { ok: true } } }) + "\n");
	writeFileSync(join(specDir, ".convergence-ledger.json"), JSON.stringify({ rounds: [] }) + "\n");
	writeFileSync(join(repo, "src", "app.ts"), "export const app = 1;\n");
	git("add", "-A");
	git("commit", "-qm", "phase 1/6: snapshot WITH tracked state files (the incident shape)");
}

const cacheRows = (repo: string): string[] =>
	readFileSync(join(repo, SPEC, ".resume-cache.jsonl"), "utf8").split("\n").filter((l) => l.trim());

describe("v0.4.3 — ensureRuntimeStateUntracked (the 2026-09-15T08-13-05-056Z cache-truncation incident)", () => {
	it("THE INCIDENT: after untrack, a checkpoint rollback's `git reset --hard` can no longer truncate the resume cache", () => {
		const { repo, git } = makeRepo("sd-rtstate-incident-");
		try {
			trackStateFiles(repo, git);
			// Post-commit appends — the rows the old world LOSED on every rollback.
			const cachePath = join(repo, SPEC, ".resume-cache.jsonl");
			writeFileSync(cachePath, cacheRows(repo).join("\n") + "\n" + JSON.stringify({ key: "pipeline.prototype.r01@root#1", result: { text: "proto", control: { verdict: "pass" } } }) + "\n");
			expect(cacheRows(repo)).toHaveLength(2);

			const report = ensureRuntimeStateUntracked({ worktreePath: repo, specDirectory: join(repo, SPEC), worktreeCreated: true });
			expect(report.status).toBe("applied");
			expect(report.untracked).toContain(`${SPEC}/.resume-cache.jsonl`);
			expect(report.untracked).toContain(`${SPEC}/.convergence-ledger.json`);
			// On-disk content untouched by `git rm --cached`.
			expect(cacheRows(repo)).toHaveLength(2);
			// Out of the index.
			expect(git("ls-files", "--", `${SPEC}/.resume-cache.jsonl`).stdout.trim()).toBe("");

			// The rollback the checkpoint layer performs on every §D re-entry.
			const reset = git("reset", "--hard", "HEAD");
			expect(reset.status).toBe(0);
			// PRE-FIX this reverts the file to the committed 1-row snapshot and the
			// prototype row is silently gone; POST-FIX the appended row survives.
			expect(cacheRows(repo)).toHaveLength(2);
			expect(cacheRows(repo).some((l) => l.includes("pipeline.prototype.r01@root#1"))).toBe(true);
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	});

	it("`git add -A` cannot re-track the state files — the worktree gitdir's info/exclude is honored", () => {
		const { repo, git } = makeRepo("sd-rtstate-ignore-");
		try {
			trackStateFiles(repo, git);
			const report = ensureRuntimeStateUntracked({ worktreePath: repo, specDirectory: join(repo, SPEC), worktreeCreated: true });
			expect(report.ignored).toContain(`${SPEC}/.resume-cache.jsonl`);

			// A NEW state file the engine writes mid-run (never tracked before).
			writeFileSync(join(repo, SPEC, ".judge.jsonl"), JSON.stringify({ call: 1 }) + "\n");
			// The committer's sweep — pre-fix `git add -A` re-adds every untracked file.
			git("add", "-A");
			git("commit", "-qm", "phase 2/6: normal work after untracking");
			const committed = git("show", "--name-only", "--format=", "HEAD").stdout;
			expect(committed).not.toContain(`${SPEC}/.judge.jsonl`);
			expect(git("ls-files", "--", `${SPEC}/.judge.jsonl`).stdout.trim()).toBe("");
			expect(readFileSync(join(repo, SPEC, ".judge.jsonl"), "utf8")).toContain("call");
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	});

	it("idempotent: a second run untracks nothing and appends no duplicate exclude lines", () => {
		const { repo, git } = makeRepo("sd-rtstate-idem-");
		try {
			trackStateFiles(repo, git);
			const first = ensureRuntimeStateUntracked({ worktreePath: repo, specDirectory: join(repo, SPEC), worktreeCreated: true });
			expect(first.untracked.length).toBeGreaterThan(0);
			const excludePath = git("rev-parse", "--git-dir").stdout.trim();
			const exclude = () => readFileSync(join(repo, excludePath, "info", "exclude"), "utf8");
			const afterFirst = exclude();

			const second = ensureRuntimeStateUntracked({ worktreePath: repo, specDirectory: join(repo, SPEC), worktreeCreated: true });
			expect(second.untracked).toEqual([]);
			expect(second.ignored).toEqual([]);
			expect(exclude()).toBe(afterFirst);
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	});

	it("in-place run (worktreeCreated: false) mutates nothing and says why (P10)", () => {
		const { repo, git } = makeRepo("sd-rtstate-inplace-");
		try {
			trackStateFiles(repo, git);
			const report = ensureRuntimeStateUntracked({ worktreePath: repo, specDirectory: join(repo, SPEC), worktreeCreated: false });
			expect(report.status).toBe("skipped");
			expect(report.reason).toContain("in-place");
			// The user's checkout index is untouched.
			expect(git("ls-files", "--", `${SPEC}/.resume-cache.jsonl`).stdout.trim()).not.toBe("");
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	});

	it("a failing git backend degrades to an honest skipped report — never throws", () => {
		const { repo, git } = makeRepo("sd-rtstate-fail-");
		try {
			trackStateFiles(repo, git);
			const report = ensureRuntimeStateUntracked({
				worktreePath: repo,
				specDirectory: join(repo, SPEC),
				worktreeCreated: true,
				git: () => ({ status: 1, stdout: "", stderr: "injected failure" }),
			});
			expect(report.status).toBe("skipped");
			expect(report.errors.length).toBeGreaterThan(0);
			// The tracked file is still there (the failure did not half-mutate).
			expect(git("ls-files", "--", `${SPEC}/.resume-cache.jsonl`).stdout.trim()).not.toBe("");
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	});

	it("works against a REAL linked worktree — the COMMON git dir's info/exclude protects it (Code-Gate BLOCK-1: git never reads per-worktree info/exclude)", () => {
		const { repo, git } = makeRepo("sd-rtstate-wt-");
		let wt = "";
		try {
			trackStateFiles(repo, git);
			wt = `${repo}-wt`;
			const add = git("worktree", "add", "-b", "26-x-track", wt, "main");
			expect(add.status).toBe(0);

			const report = ensureRuntimeStateUntracked({ worktreePath: wt, specDirectory: join(wt, SPEC), worktreeCreated: true });
			expect(report.status).toBe("applied");
			expect(report.untracked).toContain(`${SPEC}/.resume-cache.jsonl`);

			// The ignore MUST be honored inside the linked worktree: a NEW state
			// file the engine writes mid-run is invisible to `git add -A`
			// (pre-BLOCK-1 fix the exclude went to the per-worktree gitdir, which
			// git never reads — this assertion is what that defect evaded).
			writeFileSync(join(wt, SPEC, ".judge.jsonl"), JSON.stringify({ call: 1 }) + "\n");
			const addAll = spawnSync("git", ["-C", wt, "add", "-A"], { encoding: "utf8" });
			expect(addAll.status).toBe(0);
			const status = spawnSync("git", ["-C", wt, "status", "--porcelain"], { encoding: "utf8" });
			expect(status.stdout).not.toContain(".judge.jsonl");
			expect(spawnSync("git", ["-C", wt, "ls-files", "--", `${SPEC}/.judge.jsonl`], { encoding: "utf8" }).stdout.trim()).toBe("");

			// The rollback the checkpoint layer performs inside the WORKTREE.
			const reset = spawnSync("git", ["-C", wt, "reset", "--hard", "HEAD"], { encoding: "utf8" });
			expect(reset.status).toBe(0);
			const rows = readFileSync(join(wt, SPEC, ".resume-cache.jsonl"), "utf8").split("\n").filter((l) => l.trim());
			// The 1 committed row + nothing lost: file still on disk with its content.
			expect(rows.length).toBe(1);
		} finally {
			if (wt) spawnSync("git", ["-C", repo, "worktree", "remove", "--force", wt], { encoding: "utf8" });
			rmSync(repo, { recursive: true, force: true });
		}
	});

	it("P6 drift guard: the phase committer's exclusion set covers every neverGitTracked basename", () => {
		// The committer's set is module-internal; pin it behaviorally: a
		// neverGitTracked basename in the porcelain must never be committed,
		// while a real source change in the same phase still ships.
		const { repo, git } = makeRepo("sd-rtstate-commit-");
		try {
			// A neverGitTracked basename in the porcelain must never be committed.
			mkdirSync(join(repo, SPEC), { recursive: true });
			mkdirSync(join(repo, "src"), { recursive: true });
			writeFileSync(join(repo, SPEC, ".resume-cache.jsonl"), JSON.stringify({ key: "k", result: { text: "t", control: null } }) + "\n");
			writeFileSync(join(repo, "src", "feat.ts"), "export const f = 1;\n");
			const out = deterministicPhaseCommit(repo, { phaseIndex: 1, totalPhases: 2, phaseName: "p1", worktreeCreated: true, gateSummary: "g" });
			expect(out.status).toBe("committed");
			const committed = git("show", "--name-only", "--format=", "HEAD").stdout;
			expect(committed).toContain("src/feat.ts");
			expect(committed).not.toContain(`${SPEC}/.resume-cache.jsonl`);
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
		expect(harnessBasenames("neverGitTracked").size).toBeGreaterThanOrEqual(20);
	});
});
