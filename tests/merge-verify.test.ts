/**
 * A-2 (repo-wide audit): the merge agent's `merged` self-report is gated by a
 * deterministic git verification (mergeVerifyTask). A run may only claim the
 * merge happened when the feature branch head is an ancestor of the default
 * branch head; otherwise state.merge is rewritten to merged:false and the run
 * reports partial — never success.
 *
 * The tests build real git repos + linked worktrees (the exact geometry the
 * pipeline runs in: default checked out in the main checkout, feature checked
 * out in the worktree) and drive mergeVerifyTask.run directly with scripted
 * state.
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { mergeVerifyTask } from "../src/stages/writers.ts";
import type { PipelineState, Stage, StageContext } from "../src/types.ts";

const sh = (cwd: string, cmd: string): string => { try { return execSync(cmd, { cwd, encoding: "utf-8" }); } catch { return ""; } };

/** main checkout on `main` (one commit) + linked worktree on `feature/x`
 *  carrying one extra commit — the super-dev geometry. */
function repo(): { main: string; wt: string } {
	const main = mkdtempSync(join(tmpdir(), "sd-a2-"));
	sh(main, "git init -b main && git config user.email t@t && git config user.name t");
	sh(main, "git commit --allow-empty -m base");
	sh(main, "git checkout -b feature/x");
	sh(main, "git commit --allow-empty -m feature-work");
	sh(main, "git checkout main");
	const wt = join(main, "..", "sd-a2-wt-" + Math.random().toString(36).slice(2));
	sh(main, `git worktree add ${wt} feature/x`); // feature/x already exists — plain add checks it out
	return { main, wt };
}

function stateWith(main: string, wt: string, merge: Record<string, unknown>): { state: PipelineState; ctx: StageContext; logs: string[] } {
	const logs: string[] = [];
	const state = {
		setup: { worktreePath: wt, specDirectory: wt, defaultBranch: "main", language: "backend", isWebUi: false, specIdentifier: "t", worktreeCreated: true, initializedRepo: false },
		merge,
	} as unknown as PipelineState;
	const ctx = {
		task: "", options: {}, state,
		log: (m: string) => logs.push(m),
		events: new EventEmitter(),
		results: [],
	} as unknown as StageContext;
	return { state, ctx, logs };
}

describe("mergeVerifyTask (A-2 deterministic merge confirmation)", () => {
	it("confirms a real merge that advanced the default branch", async () => {
		const { main, wt } = repo();
		try {
			sh(main, "git merge --no-ff feature/x -m merged"); // the correct-direction merge
			const { state, ctx, logs } = stateWith(main, wt, { merged: true, commitSha: sh(main, "git rev-parse HEAD").trim(), summary: "done" });
			await (mergeVerifyTask as Stage).run(state, ctx);
			expect(state.merge?.merged).toBe(true);
			expect(String(state.merge?.verification)).toContain("git-confirmed");
			expect(logs.join("\n")).toContain("Merge verification PASSED");
		} finally { rmSync(wt, { recursive: true, force: true }); sh(main, "git worktree prune"); rmSync(main, { recursive: true, force: true }); }
	});

	it("rejects a false self-report: agent merged default INTO the feature branch (wrong direction)", async () => {
		const { main, wt } = repo();
		try {
			sh(wt, "git merge main -m wrong-direction"); // default branch did NOT advance
			const { state, ctx } = stateWith(main, wt, { merged: true, summary: "claims merged" });
			await (mergeVerifyTask as Stage).run(state, ctx);
			expect(state.merge?.merged).toBe(false);
			expect(String(state.merge?.verification)).toContain("NOT an ancestor");
		} finally { rmSync(wt, { recursive: true, force: true }); sh(main, "git worktree prune"); rmSync(main, { recursive: true, force: true }); }
	});

	it("rejects a pure lie: nothing happened, merged:true reported", async () => {
		const { main, wt } = repo();
		try {
			const { state, ctx, logs } = stateWith(main, wt, { merged: true, commitSha: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef", summary: "sure, merged" });
			await (mergeVerifyTask as Stage).run(state, ctx);
			expect(state.merge?.merged).toBe(false);
			expect(logs.join("\n")).toContain("Merge verification FAILED");
		} finally { rmSync(wt, { recursive: true, force: true }); sh(main, "git worktree prune"); rmSync(main, { recursive: true, force: true }); }
	});

	it("rejects a fabricated commitSha even when the ancestor check passes", async () => {
		const { main, wt } = repo();
		try {
			sh(main, "git merge --no-ff feature/x -m merged");
			const { state, ctx } = stateWith(main, wt, { merged: true, commitSha: "1234567890abcdef1234567890abcdef12345678", summary: "done" });
			await (mergeVerifyTask as Stage).run(state, ctx);
			expect(state.merge?.merged).toBe(false);
			expect(String(state.merge?.verification)).toContain("does not exist");
		} finally { rmSync(wt, { recursive: true, force: true }); sh(main, "git worktree prune"); rmSync(main, { recursive: true, force: true }); }
	});

	it("leaves an unclaimed merge (merged !== true) untouched", async () => {
		const { main, wt } = repo();
		try {
			const { state, ctx } = stateWith(main, wt, { merged: false, summary: "agent said no" });
			await (mergeVerifyTask as Stage).run(state, ctx);
			expect(state.merge?.merged).toBe(false);
			expect(state.merge?.verification).toBeUndefined();
		} finally { rmSync(wt, { recursive: true, force: true }); sh(main, "git worktree prune"); rmSync(main, { recursive: true, force: true }); }
	});

	// ── F-B: uncommitted tracked work would not ship ──────────────────────────
	// Production shape (run 2026-08-16T01-00-35-613Z): the review fix repaired
	// F-01 but left `M tests/persistence.test.ts` uncommitted; geometry-only
	// verification would have confirmed the merge while the fix silently
	// failed to ship.
	it("F-B: rejects a claimed merge when tracked work is uncommitted (would NOT ship)", async () => {
		const { main, wt } = repo();
		try {
			sh(wt, "echo base > f.txt && git add f.txt && git commit -m 'add f'"); // tracked file on feature/x
			sh(main, "git merge --no-ff feature/x -m merged"); // geometry is CORRECT
			sh(wt, "echo modified >> f.txt"); // tracked modification, uncommitted
			const { state, ctx, logs } = stateWith(main, wt, { merged: true, summary: "claims merged" });
			await (mergeVerifyTask as Stage).run(state, ctx);
			expect(state.merge?.merged).toBe(false);
			expect(String(state.merge?.verification)).toContain("uncommitted tracked change");
			expect(logs.join("\n")).toContain("Merge verification FAILED");
		} finally { rmSync(wt, { recursive: true, force: true }); sh(main, "git worktree prune"); rmSync(main, { recursive: true, force: true }); }
	});

	it("F-B: untracked files do NOT block the merge (A-3 geometry — pipeline-copied .env stays behind)", async () => {
		const { main, wt } = repo();
		try {
			sh(main, "git merge --no-ff feature/x -m merged");
			sh(wt, "echo secret > .env"); // untracked — git never carries it into a merge
			const { state, ctx, logs } = stateWith(main, wt, { merged: true, summary: "done" });
			await (mergeVerifyTask as Stage).run(state, ctx);
			expect(state.merge?.merged).toBe(true);
			expect(logs.join("\n")).toContain("Merge verification PASSED");
		} finally { rmSync(wt, { recursive: true, force: true }); sh(main, "git worktree prune"); rmSync(main, { recursive: true, force: true }); }
	});
});

describe("mergeVerifyTask boolean control drift (run 2026-08-15T13-45-02 postmortem)", () => {
	// Production evidence: the merge agent emitted `merged: "true"` (STRING);
	// the old strict `merge.merged !== true` read skipped verification entirely
	// (17ms, zero log lines) and the run misreported PARTIAL on a genuinely
	// merged repo. The claim must be read tolerantly and verified like any other.
	it("verifies (not skips) a string \"true\" claim — normalized observably, then git-confirmed", async () => {
		const { main, wt } = repo();
		try {
			sh(main, "git merge --no-ff feature/x -m merged");
			const { state, ctx, logs } = stateWith(main, wt, { merged: "true", commitSha: sh(main, "git rev-parse HEAD").trim(), summary: "done" });
			await (mergeVerifyTask as Stage).run(state, ctx);
			expect(logs.join("\n")).toContain('merged="true" (string) — normalized to true');
			expect(state.merge?.merged).toBe(true); // normalized to a real boolean
			expect(String(state.merge?.verification)).toContain("git-confirmed");
			expect(logs.join("\n")).toContain("Merge verification PASSED");
		} finally { rmSync(wt, { recursive: true, force: true }); sh(main, "git worktree prune"); rmSync(main, { recursive: true, force: true }); }
	});

	it("a string \"true\" claim git FAILS to confirm is still rewritten to merged:false (trust direction unchanged)", async () => {
		const { main, wt } = repo();
		try {
			// no merge performed — the lie must be caught by verification, not skipped
			const { state, ctx, logs } = stateWith(main, wt, { merged: "true", summary: "lying string" });
			await (mergeVerifyTask as Stage).run(state, ctx);
			expect(state.merge?.merged).toBe(false);
			expect(String(state.merge?.verification)).toContain("NOT an ancestor");
			expect(logs.join("\n")).toContain("Merge verification FAILED");
		} finally { rmSync(wt, { recursive: true, force: true }); sh(main, "git worktree prune"); rmSync(main, { recursive: true, force: true }); }
	});

	it("a string \"false\" claim stays an unclaimed merge (no verification, no normalization)", async () => {
		const { main, wt } = repo();
		try {
			const { state, ctx, logs } = stateWith(main, wt, { merged: "false", summary: "not merged" });
			await (mergeVerifyTask as Stage).run(state, ctx);
			expect(state.merge?.merged).toBe("false"); // untouched
			expect(state.merge?.verification).toBeUndefined();
			expect(logs.join("\n")).not.toContain("normalized");
		} finally { rmSync(wt, { recursive: true, force: true }); sh(main, "git worktree prune"); rmSync(main, { recursive: true, force: true }); }
	});
});
