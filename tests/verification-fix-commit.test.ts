/**
 * F-B (dsh-09 v3 Phase F): a verification fix that changes repository state is
 * committed DETERMINISTICALLY at the moment it happens — no LLM in the loop.
 *
 * Production evidence (run 2026-08-16T01-00-35-613Z): the review fix round
 * repaired finding F-01 but left `M tests/persistence.test.ts` uncommitted.
 * The adversarial reviewer itself warned the change "must ship with the merge",
 * yet nothing between reviewFix and merge commits it, and mergeVerifyTask
 * checked only branch geometry — the fix would have been silently dropped at
 * merge time under a green banner.
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { commitWorktreeChanges } from "../src/helpers.ts";
import { runVerificationFix } from "../src/stages/verify.ts";
import type { Node, NodeResult, PipelineState, StageContext } from "../src/types.ts";

const sh = (cwd: string, cmd: string): string => { try { return execSync(cmd, { cwd, encoding: "utf-8" }); } catch { return ""; } };

function gitRepo(withIdentity = true): string {
	const dir = mkdtempSync(join(tmpdir(), "sd-fb-"));
	sh(dir, "git init -b main");
	if (withIdentity) sh(dir, "git config user.email t@t && git config user.name t");
	writeFileSync(join(dir, "a.txt"), "base\n");
	sh(dir, "git add -A && git commit -m base");
	return dir;
}

describe("commitWorktreeChanges (F-B deterministic commit)", () => {
	it("commits a tracked modification with the given subject", () => {
		const dir = gitRepo();
		try {
			writeFileSync(join(dir, "a.txt"), "modified\n");
			const r = commitWorktreeChanges(dir, "fix(verify): address review findings (round 1)");
			expect(r.committed).toBe(true);
			expect(r.subject).toBe("fix(verify): address review findings (round 1)");
			expect(sh(dir, "git status --porcelain").trim()).toBe("");
			expect(sh(dir, "git log -1 --pretty=%s").trim()).toBe("fix(verify): address review findings (round 1)");
		} finally { rmSync(dir, { recursive: true, force: true }); }
	});

	it("is a no-op (no error) on a clean worktree", () => {
		const dir = gitRepo();
		try {
			const r = commitWorktreeChanges(dir, "nothing to do");
			expect(r.committed).toBe(false);
			expect(r.error).toBeUndefined();
			expect(sh(dir, "git rev-list --count HEAD").trim()).toBe("1"); // no empty commit created
		} finally { rmSync(dir, { recursive: true, force: true }); }
	});

	it("sweeps untracked files in (-A): pipeline work product must ship", () => {
		const dir = gitRepo();
		try {
			writeFileSync(join(dir, "src-new.ts"), "export {};\n");
			const r = commitWorktreeChanges(dir, "sweep");
			expect(r.committed).toBe(true);
			expect(sh(dir, "git ls-files").trim()).toContain("src-new.ts");
		} finally { rmSync(dir, { recursive: true, force: true }); }
	});

	it("falls back to an explicit pipeline identity when no git user is configured", () => {
		// git auto-derives an identity from username/hostname when nothing is
		// configured, so the real no-identity failure requires useConfigOnly —
		// the standard strict-CI setup. Error text: "*** Please tell me who you are."
		const prevGlobal = process.env.GIT_CONFIG_GLOBAL;
		const prevSystem = process.env.GIT_CONFIG_SYSTEM;
		process.env.GIT_CONFIG_GLOBAL = "/dev/null";
		process.env.GIT_CONFIG_SYSTEM = "/dev/null";
		const dir = gitRepo(false); // no local identity
		try {
			sh(dir, "git config user.useConfigOnly true");
			writeFileSync(join(dir, "a.txt"), "modified\n");
			const r = commitWorktreeChanges(dir, "identity fallback");
			expect(r.committed).toBe(true);
			expect(sh(dir, "git log -1 --pretty=%an").trim()).toBe("super-dev (pipeline)");
		} finally {
			rmSync(dir, { recursive: true, force: true });
			if (prevGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL; else process.env.GIT_CONFIG_GLOBAL = prevGlobal;
			if (prevSystem === undefined) delete process.env.GIT_CONFIG_SYSTEM; else process.env.GIT_CONFIG_SYSTEM = prevSystem;
		}
	});

	it("reports an error (never throws) on a non-git directory", () => {
		const dir = mkdtempSync(join(tmpdir(), "sd-fb-nogit-"));
		try {
			const r = commitWorktreeChanges(dir, "x");
			expect(r.committed).toBe(false);
			expect(r.error).toBeTruthy();
		} finally { rmSync(dir, { recursive: true, force: true }); }
	});
});

describe("runVerificationFix deterministic commit (F-B integration)", () => {
	const fakeCtx = (): { ctx: StageContext; logs: string[] } => {
		const logs: string[] = [];
		return {
			logs,
			ctx: { task: "", options: {}, log: (m: string) => logs.push(m), events: new EventEmitter(), results: [] } as unknown as StageContext,
		};
	};

	it("commits the repository change a fix step made, with kind + round label", async () => {
		const dir = gitRepo();
		try {
			const state = { setup: { worktreePath: dir, specDirectory: dir } } as unknown as PipelineState;
			const node: Node = {
				kind: "fakeFix",
				run: async () => { writeFileSync(join(dir, "a.txt"), "fixed by the implementer\n"); return { status: "ok" } satisfies NodeResult; },
			};
			const { ctx, logs } = fakeCtx();
			const r = await runVerificationFix("review", node, state, ctx, "round 1");
			expect(r.status).toBe("ok");
			const last = (state as Record<string, unknown>).__lastVerificationFix as { changed?: boolean };
			expect(last.changed).toBe(true);
			expect(sh(dir, "git status --porcelain").trim()).toBe(""); // committed, not left dirty
			expect(sh(dir, "git log -1 --pretty=%s").trim()).toBe("fix(verify): address review findings (round 1)");
			expect(logs.join("\n")).toContain("deterministically committed the review fix");
		} finally { rmSync(dir, { recursive: true, force: true }); }
	});

	it("does not create commits when the fix step changed nothing", async () => {
		const dir = gitRepo();
		try {
			const state = { setup: { worktreePath: dir, specDirectory: dir } } as unknown as PipelineState;
			const node: Node = { kind: "fakeNoop", run: async () => ({ status: "ok" } satisfies NodeResult) };
			const { ctx, logs } = fakeCtx();
			await runVerificationFix("integration", node, state, ctx, "round 2");
			expect(sh(dir, "git rev-list --count HEAD").trim()).toBe("1");
			expect(logs.join("\n")).toContain("made no repository-state change");
		} finally { rmSync(dir, { recursive: true, force: true }); }
	});
});

afterEach(() => { /* env restore is handled per-test; placeholder keeps hooks uniform */ });
