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
import { runSetup, detectLanguage, referencedSpecIdentifier, findReusableSpec, slugTokenContainment, taskSimilarity, specReuseEnabled } from "../src/setup.ts";

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

describe("spec-track reuse (G2)", () => {
	const ORIG_TASK = "we want to add step e2e test dashboard at e2e-automation/step-dashboard, it will get all processes for an user via the step reporting api with basic auth";
	const REPHRASED_A = "Implement the STEP E2E Test Dashboard feature exactly per the requirements document";
	const REPHRASED_B = "implement @docs/requirements/step-e2e-dashboard.md";

	function seedTrack(cwd: string, id: string, anchor?: string) {
		const dir = join(cwd, ".worktree", id, "docs", "specifications", id);
		mkdirSync(dir, { recursive: true });
		if (anchor !== undefined) writeFileSync(join(dir, ".task"), anchor);
		// reuse requires recorded progress (isResumable): a dead run's cache
		writeFileSync(join(dir, ".resume-cache.jsonl"), JSON.stringify({ key: `pipeline.spec@root#1`, result: {} }) + "\n");
		return dir;
	}

	it("taskTokens/slugTokenContainment: the three observed task variants share the track's slug tokens", () => {
		expect(slugTokenContainment("step-e2e-test-dashboard", ORIG_TASK)).toBeGreaterThanOrEqual(0.75);
		expect(slugTokenContainment("step-e2e-test-dashboard", REPHRASED_A)).toBeGreaterThanOrEqual(0.75);
		expect(slugTokenContainment("step-e2e-test-dashboard", REPHRASED_B)).toBeGreaterThanOrEqual(0.75);
		expect(taskSimilarity(ORIG_TASK, ORIG_TASK)).toBe(1);
		expect(taskSimilarity(ORIG_TASK, "fix the login page footer overflow on mobile")).toBeLessThan(0.6);
	});

	it("findReusableSpec re-enters an incomplete matching track (anchor-based, worktree layout)", () => {
		const d = mkdtempSync(join(tmpdir(), "sd-reuse-"));
		try {
			seedTrack(d, "254-step-e2e-test-dashboard", ORIG_TASK);
			expect(findReusableSpec(d, REPHRASED_B)).toBe("254-step-e2e-test-dashboard");
			// near-identical re-run also matches via Jaccard on the anchor
			expect(findReusableSpec(d, ORIG_TASK + " please")).toBe("254-step-e2e-test-dashboard");
		} finally { rmSync(d, { recursive: true, force: true }); }
	});

	it("skips completed tracks (.complete marker)", () => {
		const d = mkdtempSync(join(tmpdir(), "sd-reuse-"));
		try {
			const dir = seedTrack(d, "254-step-e2e-test-dashboard", ORIG_TASK);
			writeFileSync(join(dir, ".complete"), "");
			expect(findReusableSpec(d, REPHRASED_B)).toBeNull();
		} finally { rmSync(d, { recursive: true, force: true }); }
	});

	it("returns null for dissimilar tasks and empty repos", () => {
		const d = mkdtempSync(join(tmpdir(), "sd-reuse-"));
		try {
			seedTrack(d, "254-step-e2e-test-dashboard", ORIG_TASK);
			expect(findReusableSpec(d, "build a car theory html animation page")).toBeNull();
			expect(findReusableSpec(mkdtempSync(join(tmpdir(), "sd-reuse-")), "anything")).toBeNull();
		} finally { rmSync(d, { recursive: true, force: true }); }
	});

	it("in-place (skipWorktree) tracks are also considered", () => {
		const d = mkdtempSync(join(tmpdir(), "sd-reuse-"));
		try {
			const dir = join(d, "docs", "specifications", "12-step-e2e-dashboard");
			mkdirSync(dir, { recursive: true });
			writeFileSync(join(dir, ".task"), ORIG_TASK);
			writeFileSync(join(dir, ".resume-cache.jsonl"), JSON.stringify({ key: "pipeline.spec@root#1", result: {} }) + "\n");
			// in-place tracks are only eligible for in-place (skipWorktree) runs
			expect(findReusableSpec(d, REPHRASED_A, { worktree: false })).toBe("12-step-e2e-dashboard");
			// cross-layout: a worktree-mode run must NOT reuse an in-place track
			// (code-review N1-CROSS-LAYOUT-REUSE — the id would point at an
			// empty sibling spec dir, preserving nothing)
			expect(findReusableSpec(d, REPHRASED_A, { worktree: true })).toBeNull();
		} finally { rmSync(d, { recursive: true, force: true }); }
	});

	it("specReuseEnabled honors the kill-switch", () => {
		const prior = process.env.SUPER_DEV_NO_SPEC_REUSE;
		try {
			delete process.env.SUPER_DEV_NO_SPEC_REUSE;
			expect(specReuseEnabled()).toBe(true);
			process.env.SUPER_DEV_NO_SPEC_REUSE = "1";
			expect(specReuseEnabled()).toBe(false);
		} finally {
			if (prior === undefined) delete process.env.SUPER_DEV_NO_SPEC_REUSE;
			else process.env.SUPER_DEV_NO_SPEC_REUSE = prior;
		}
	});

	it("runSetup persists the anchor task and reuses the matching track on a re-phrased run", () => {
		const d = mkdtempSync(join(tmpdir(), "sd-reuse-run-"));
		try {
			execFileSync("git", ["init", "-b", "main"], { cwd: d, stdio: "ignore" });
			execFileSync("git", ["commit", "--allow-empty", "-m", "init"], { cwd: d, stdio: "ignore" });
			const first = runSetup(ORIG_TASK, { cwd: d });
			expect(existsSync(join(first.specDirectory, ".task"))).toBe(true);
			expect(readFileSync(join(first.specDirectory, ".task"), "utf8")).toBe(ORIG_TASK);
			// simulate the run dying mid-flight (the motivating scenario) so the
			// track is resumable
			writeFileSync(join(first.specDirectory, ".resume-cache.jsonl"), JSON.stringify({ key: "pipeline.spec@root#1", result: {} }) + "\n");
			// the pipeline stage ALWAYS passes an LLM-summarized slug — reuse must
			// still fire (code-review G2-PROD-DEAD-PATH regression pin)
			const second = runSetup(REPHRASED_B, { cwd: d, slug: "step-e2e-dashboard" });
			expect(second.specIdentifier).toBe(first.specIdentifier);
			expect(second.specDirectory).toBe(first.specDirectory);
			expect(second.reusedTrack).toBe(true);
			// anchor is NOT overwritten by the re-phrased run
			expect(readFileSync(join(second.specDirectory, ".task"), "utf8")).toBe(ORIG_TASK);
		} finally { rmSync(d, { recursive: true, force: true }); }
	});

	it("runSetup allocates a fresh track only via the kill-switch (an LLM slug is a label, not intent)", () => {
		const d = mkdtempSync(join(tmpdir(), "sd-reuse-slug-"));
		try {
			execFileSync("git", ["init", "-b", "main"], { cwd: d, stdio: "ignore" });
			execFileSync("git", ["config", "user.email", "t@example.com"], { cwd: d, stdio: "ignore" });
			execFileSync("git", ["config", "user.name", "T"], { cwd: d, stdio: "ignore" });
			execFileSync("git", ["commit", "--allow-empty", "-m", "init"], { cwd: d, stdio: "ignore" });
			const first = runSetup(ORIG_TASK, { cwd: d });
			writeFileSync(join(first.specDirectory, ".resume-cache.jsonl"), JSON.stringify({ key: "pipeline.spec@root#1", result: {} }) + "\n");
			// a slug alone does NOT bypass reuse (production shape)
			const withSlug = runSetup(REPHRASED_B, { cwd: d, slug: "brand-new-name" });
			expect(withSlug.specIdentifier).toBe(first.specIdentifier);
			expect(withSlug.reusedTrack).toBe(true);
			// the kill-switch forces a fresh track, named by the slug
			const prior = process.env.SUPER_DEV_NO_SPEC_REUSE;
			try {
				process.env.SUPER_DEV_NO_SPEC_REUSE = "1";
				const fresh = runSetup(REPHRASED_B, { cwd: d, slug: "fresh-track" });
				expect(fresh.specIdentifier).not.toBe(first.specIdentifier);
				expect(fresh.specIdentifier.endsWith("-fresh-track")).toBe(true);
				expect(fresh.reusedTrack ?? false).toBe(false);
			} finally {
				if (prior === undefined) delete process.env.SUPER_DEV_NO_SPEC_REUSE;
				else process.env.SUPER_DEV_NO_SPEC_REUSE = prior;
			}
		} finally { rmSync(d, { recursive: true, force: true }); }
	});

	it("a track with no recorded progress is never re-entered (nothing to continue)", () => {
		const d = mkdtempSync(join(tmpdir(), "sd-reuse-nocache-"));
		try {
			const dir = seedTrack(d, "254-step-e2e-test-dashboard", ORIG_TASK);
			rmSync(join(dir, ".resume-cache.jsonl"));
			expect(findReusableSpec(d, REPHRASED_B)).toBeNull();
		} finally { rmSync(d, { recursive: true, force: true }); }
	});

	it("reuse preserves the track's knowledge and user notes (continuation semantics)", () => {
		const d = mkdtempSync(join(tmpdir(), "sd-reuse-notes-"));
		try {
			execFileSync("git", ["init", "-b", "main"], { cwd: d, stdio: "ignore" });
			execFileSync("git", ["config", "user.email", "t@example.com"], { cwd: d, stdio: "ignore" });
			execFileSync("git", ["config", "user.name", "T"], { cwd: d, stdio: "ignore" });
			execFileSync("git", ["commit", "--allow-empty", "-m", "init"], { cwd: d, stdio: "ignore" });
			const first = runSetup(ORIG_TASK, { cwd: d });
			writeFileSync(join(first.specDirectory, ".resume-cache.jsonl"), JSON.stringify({ key: "pipeline.spec@root#1", result: {} }) + "\n");
			writeFileSync(join(first.specDirectory, ".user-notes.json"), JSON.stringify({ notes: ["human guidance from the dead run"] }));
			const second = runSetup(REPHRASED_B, { cwd: d, slug: "step-e2e-dashboard" });
			expect(second.reusedTrack).toBe(true);
			expect(readFileSync(join(second.specDirectory, ".user-notes.json"), "utf8")).toContain("human guidance from the dead run");
		} finally { rmSync(d, { recursive: true, force: true }); }
	});

	it("deterministic tie-break: equal scores resolve by lexicographic id", () => {
		const d = mkdtempSync(join(tmpdir(), "sd-reuse-tie-"));
		try {
			// three siblings of the motivating fragmentation, all resumable, no anchors
			seedTrack(d, "254-e2e-dashboard");
			seedTrack(d, "254-step-e2e-dashboard");
			seedTrack(d, "254-step-e2e-test-dashboard");
			const pick = findReusableSpec(d, "continue the step e2e dashboard work");
			expect(pick).toBe("254-e2e-dashboard"); // lexicographically smallest of equal scores
		} finally { rmSync(d, { recursive: true, force: true }); }
	});
});
