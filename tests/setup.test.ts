/**
 * Tests for deterministic setup. These touch the filesystem + real git in a
 * temp dir (local IO, no network/spawn) to verify worktree creation — the bug
 * was that an empty repo (unborn HEAD) broke `git worktree add`, so setup
 * silently fell back to operating in the cwd with no isolation.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSetup, detectLanguage } from "../src/setup.ts";

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

	it("operates in-place when skipWorktree is set", () => {
		const s = runSetup("implement a node api", { cwd: dir, skipWorktree: true });
		expect(s.worktreeCreated).toBe(false);
		expect(s.worktreePath).toBe(dir);
	});
});
