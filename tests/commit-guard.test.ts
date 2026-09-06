/**
 * v0.3.74 P2-e — commit-guard child extension (M7 root: P4 mechanical
 * prevention for the git-commit class).
 *
 * Run 2026-09-05T23-09-55-596Z: the implementer committed GREEN work itself
 * (2e92da3, thousands-of-words message) and pre-landed phase-5 production
 * code (5d4790d) BEFORE its RED ran — v0.3.73 made this DETECTED (advisory +
 * HEAD-drift finding), but detection still pays the RED cycle. pi exposes
 * `pi.on("tool_call")` with `{ block: true, reason }` (extensions.md), and
 * pi-subagents loads agent-declared extension paths into the child — so the
 * commit class is now MECHANICALLY prevented for the two writer agents that
 * had the incident. Fail-open by design: if the guard is absent/unloaded, the
 * v0.3.73 detective net still catches the drift.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isCommitClassGitCommand, default as guardFactory } from "../src/child-guards/commit-guard.ts";
import { commitGuardExtensionPath, extensionsForAgent } from "../src/agents/agent-runtime.ts";

describe("v0.3.74 P2-e — commit-class git command classifier", () => {
	it("blocks the incident shapes (2e92da3 / 5d4790d)", () => {
		expect(isCommitClassGitCommand("git commit -m 'phase 5 done'")).toBe(true);
		expect(isCommitClassGitCommand("git add . && git commit -am 'feat spec-24 phase 5/9'")).toBe(true);
		expect(isCommitClassGitCommand("cd /repo && git commit --amend --no-edit")).toBe(true);
	});

	it("blocks every commit-CREATING/MOVING verb wherever it appears in the pipeline", () => {
		for (const verb of ["commit", "merge", "rebase", "cherry-pick", "stash", "push", "revert", "pull", "am"]) {
			expect(isCommitClassGitCommand(`git ${verb}`), verb).toBe(true);
			expect(isCommitClassGitCommand(`git -c user.email=x@y ${verb} --quiet`), verb).toBe(true);
			expect(isCommitClassGitCommand(`npm test && git ${verb} || true`), verb).toBe(true);
		}
	});

	it("does NOT block read-only shapes (dual review CR-F2: merge-base, stash list/show/clear)", () => {
		for (const ok of [
			"git merge-base main other",
			"git merge-base --is-ancestor a b",
			"git stash list",
			"git stash show -p",
			"git stash clear",
			"git log --merges",
			"git status",
		]) {
			expect(isCommitClassGitCommand(ok), ok).toBe(false);
		}
	});

	it("blocks env-prefixed and path-targeted commit forms (GIT_DIR=… git commit, git -C, --git-dir)", () => {
		expect(isCommitClassGitCommand("GIT_DIR=/x/.git git commit -m y")).toBe(true);
		expect(isCommitClassGitCommand("GIT_AUTHOR_DATE=2020-01-01 git commit -m z")).toBe(true);
		expect(isCommitClassGitCommand("git -C /repo commit -m x")).toBe(true);
		expect(isCommitClassGitCommand("git --git-dir=/x/.git commit")).toBe(true);
		expect(isCommitClassGitCommand("git --work-tree /w commit -a")).toBe(true);
		// env stripping must not over-strip a NON-git env-prefixed command
		expect(isCommitClassGitCommand("FOO=bar make test")).toBe(false);
	});

	it("documents the fail-open residuals (detective net owns them)", () => {
		// Contrived/nonsense shapes for a writer child — deliberately NOT blocked;
		// the v0.3.73 HEAD-drift detector catches any drift honestly.
		expect(isCommitClassGitCommand("echo $(git commit -m x)")).toBe(false);
		expect(isCommitClassGitCommand("xargs git commit")).toBe(false);
	});

	it("does NOT block read-only or write-file git usage", () => {
		for (const ok of [
			"git status --porcelain",
			"git rev-parse HEAD",
			"git diff --stat",
			"git log --oneline -5",
			"git log --grep=commit -5", // 'commit' as a grep VALUE, not a subcommand
			"git add src/x.ts", // staging is fine — the engine's commit -m is the seam
			"echo 'commit often' > notes.md",
			"echo git commit",
		]) {
			expect(isCommitClassGitCommand(ok), ok).toBe(false);
		}
	});
});

describe("v0.3.74 P2-e — guard extension factory (pi.on tool_call)", () => {
	type Handler = (event: { toolName: string; input: { command?: string } }) => Promise<{ block: true; reason: string } | undefined>;

	function armGuard(): Handler {
		const handlers: Array<{ event: string; fn: unknown }> = [];
		const fakePi = {
			on(event: string, fn: unknown) {
				handlers.push({ event, fn });
			},
		};
		guardFactory(fakePi as never);
		const h = handlers.find((x) => x.event === "tool_call");
		expect(h, "guard must register a tool_call handler").toBeDefined();
		return h!.fn as Handler;
	}

	it("blocks a bash tool_call whose command is a commit-class git invocation, with an actionable reason", async () => {
		const handler = armGuard();
		const res = await handler({ toolName: "bash", input: { command: "git add . && git commit -m done" } });
		expect(res?.block).toBe(true);
		expect(res?.reason).toMatch(/engine-owned/i);
		expect(res?.reason).toMatch(/deterministic/i);
	});

	it("lets non-bash tools and non-commit bash commands through", async () => {
		const handler = armGuard();
		expect(await handler({ toolName: "read", input: { command: "git commit -m x" } })).toBeUndefined();
		expect(await handler({ toolName: "bash", input: { command: "git status" } })).toBeUndefined();
		expect(await handler({ toolName: "bash", input: {} })).toBeUndefined();
	});
});

	it("blocks quoted-verb forms (dual review AR-F5)", () => {
		expect(isCommitClassGitCommand('git "commit" -m x')).toBe(true);
		expect(isCommitClassGitCommand("git 'commit' -m x")).toBe(true);
	});

	describe("v0.3.74 P2-e — registration (writer agents only, kill-switch)", () => {
	const saved: Record<string, string | undefined> = {};
	beforeEach(() => {
		for (const k of ["SUPER_DEV_NO_COMMIT_GUARD"]) {
			saved[k] = process.env[k];
			delete process.env[k];
		}
		return () => {
			for (const [k, v] of Object.entries(saved)) {
				if (v === undefined) delete process.env[k];
				else process.env[k] = v;
			}
		};
	});

	it("implementer and tdd-guide carry the guard; reviewers do not", () => {
		for (const agent of ["implementer", "tdd-guide"]) {
			const p = commitGuardExtensionPath(agent);
			// Dual review F1 (BLOCKER): the path must EXIST on disk — the original
			// ./child-guards URL resolved to src/agents/child-guards/… (nonexistent)
			// and a substring assertion was a false green that passed with the guard
			// unloadable (pi -e <nonexistent> exits 1 on CLI spawns; silently dropped
			// on the in-process path).
			expect(p, agent).not.toBeNull();
			expect(existsSync(p!), `${agent}: ${p}`).toBe(true);
		}
		expect(commitGuardExtensionPath("code-reviewer")).toBeNull();
		expect(commitGuardExtensionPath("task-classifier")).toBeNull();
	});

	it("the guard rides subagentOnlyExtensions, NOT extensions (dual review F2: ambient discovery preserved)", async () => {
		const { registerSuperDevAgents } = await import("../src/agents/register-agents.ts");
		const src = readFileSync(join(import.meta.dirname, "../src/agents/register-agents.ts"), "utf8");
		// emission contract: the guard lands in subagentOnlyExtensions
		expect(src).toContain("subagentOnlyExtensions: [commitGuardExtensionPath(name)!");
		// extensionsForAgent (the ambient-disabling field) must NOT carry the guard
		for (const agent of ["implementer", "tdd-guide"]) {
			expect(extensionsForAgent(agent).some((p) => p.includes("commit-guard")), agent).toBe(false);
		}
		void registerSuperDevAgents;
	});

	it("SUPER_DEV_NO_COMMIT_GUARD=1 removes the guard (fail-open escape hatch)", () => {
		process.env.SUPER_DEV_NO_COMMIT_GUARD = "1";
		expect(commitGuardExtensionPath("implementer")).toBeNull();
	});

	it("self-containment contract: the guard file has ZERO import statements (loads standalone in child jiti)", () => {
		const src = readFileSync(join(import.meta.dirname, "../src/child-guards/commit-guard.ts"), "utf8");
		expect(/^import\s/m.test(src)).toBe(false);
		expect(/^const .*require\(/m.test(src)).toBe(false);
	});
});
