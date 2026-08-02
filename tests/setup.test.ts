/**
 * Tests for deterministic setup. These touch the filesystem + real git in a
 * temp dir (local IO, no network/spawn) to verify worktree creation — the bug
 * was that an empty repo (unborn HEAD) broke `git worktree add`, so setup
 * silently fell back to operating in the cwd with no isolation.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSetup, detectLanguage, referencedSpecIdentifier } from "../src/setup.ts";

const git = (args: string[], cwd: string) => execFileSync("git", args, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] });

describe("detectLanguage (greenfield task inference)", () => {
	it("infers backend/node from task text when no manifest is present", () => {
		const d = mkdtempSync(join(tmpdir(), "sd-lang-"));
		try {
			expect(detectLanguage(d, "build an api with nodejs and express").language).toBe("backend");
		} finally { rmSync(d, { recursive: true, force: true }); }
	});
	it("infers python from task text", () => {
		const d = mkdtempSync(join(tmpdir(), "sd-lang-"));
		try {
			expect(detectLanguage(d, "create a flask web app").language).toBe("python");
		} finally { rmSync(d, { recursive: true, force: true }); }
	});
	it("falls back to mixed when no signal", () => {
		const d = mkdtempSync(join(tmpdir(), "sd-lang-"));
		try {
			expect(detectLanguage(d, "do something generic").language).toBe("mixed");
		} finally { rmSync(d, { recursive: true, force: true }); }
	});
});

describe("referencedSpecIdentifier", () => {
	let dir: string;
	beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "sd-spec-ref-")); });
	afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

	it("detects an explicitly referenced existing spec directory", () => {
		mkdirSync(join(dir, "docs", "specifications", "24-agent-team-runtime"), { recursive: true });
		expect(referencedSpecIdentifier("implement @docs/specifications/24-agent-team-runtime/", dir)).toBe("24-agent-team-runtime");
	});

	it("ignores referenced spec paths that do not exist", () => {
		expect(referencedSpecIdentifier("implement @docs/specifications/99-missing/", dir)).toBeNull();
	});
});

describe("runSetup worktree creation", () => {
	let dir: string;
	beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "sd-setup-")); });
	afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

	it("git-inits an empty dir, adds a base commit, and creates an isolated worktree", () => {
		const s = runSetup("implement a node api", { cwd: dir });
		expect(s.initializedRepo).toBe(true);
		expect(s.worktreeCreated).toBe(true);
		expect(s.worktreePath).not.toBe(dir);
		expect(existsSync(s.worktreePath)).toBe(true);
		expect(existsSync(s.specDirectory)).toBe(true);
	});

	it("reuses an explicitly referenced existing spec directory instead of allocating next numbered spec", () => {
		git(["init"], dir);
		git(["config", "user.email", "test@example.com"], dir);
		git(["config", "user.name", "Test User"], dir);
		mkdirSync(join(dir, "docs", "specifications", "24-agent-team-runtime"), { recursive: true });
		writeFileSync(join(dir, "docs", "specifications", "24-agent-team-runtime", "06-technical-specification.md"), "# Spec\n");
		git(["add", "."], dir);
		git(["commit", "-m", "seed spec"], dir);

		const s = runSetup("implement @docs/specifications/24-agent-team-runtime/, don't create new spec dir again", { cwd: dir });
		expect(s.specIdentifier).toBe("24-agent-team-runtime");
		expect(s.worktreeCreated).toBe(true);
		expect(s.worktreePath).toContain(join(".worktree", "24-agent-team-runtime"));
		expect(s.specDirectory).toBe(join(s.worktreePath, "docs", "specifications", "24-agent-team-runtime") + "/");
		expect(existsSync(join(s.worktreePath, "docs", "specifications", "24-agent-team-runtime", "06-technical-specification.md"))).toBe(true);
		expect(existsSync(join(s.worktreePath, "docs", "specifications", "25-agent-team-runtime"))).toBe(false);
	});

	it("creates a worktree in a git repo that had an unborn HEAD (the /tmp/hello-word bug)", () => {
		// Reproduce: `git init` then no commits — `git worktree add` used to fail
		// with "fatal: invalid reference: main".
		git(["init"], dir);
		expect(() => git(["rev-parse", "--verify", "HEAD"], dir)).toThrow();
		const s = runSetup("implement a node api", { cwd: dir });
		expect(s.initializedRepo).toBe(false); // already a repo
		expect(s.worktreeCreated).toBe(true); // the fix: base commit added → worktree succeeds
		expect(existsSync(s.worktreePath)).toBe(true);
	});

	it("copies .env files recursively into a created worktree", () => {
		writeFileSync(join(dir, ".env"), "ROOT_SECRET=1\n");
		mkdirSync(join(dir, "apps", "web"), { recursive: true });
		writeFileSync(join(dir, "apps", "web", ".env.local"), "WEB_SECRET=1\n");
		writeFileSync(join(dir, "apps", "web", ".env.example"), "EXAMPLE=1\n");
		mkdirSync(join(dir, "node_modules", "pkg"), { recursive: true });
		writeFileSync(join(dir, "node_modules", "pkg", ".env"), "NOPE=1\n");

		const s = runSetup("implement a node api", { cwd: dir });
		expect(s.worktreeCreated).toBe(true);
		expect(readFileSync(join(s.worktreePath, ".env"), "utf8")).toContain("ROOT_SECRET=1");
		expect(readFileSync(join(s.worktreePath, "apps", "web", ".env.local"), "utf8")).toContain("WEB_SECRET=1");
		expect(existsSync(join(s.worktreePath, "apps", "web", ".env.example"))).toBe(false);
		expect(existsSync(join(s.worktreePath, "node_modules", "pkg", ".env"))).toBe(false);
	});

	it("operates in-place when skipWorktree is set", () => {
		const s = runSetup("implement a node api", { cwd: dir, skipWorktree: true });
		expect(s.worktreeCreated).toBe(false);
		expect(s.worktreePath).toBe(dir);
	});
});
