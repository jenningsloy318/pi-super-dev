/**
 * Tests for deterministic setup. These touch the filesystem + real git in a
 * temp dir (local IO, no network/spawn) to verify worktree creation — the bug
 * was that an empty repo (unborn HEAD) broke `git worktree add`, so setup
 * silently fell back to operating in the cwd with no isolation.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSetup, detectLanguage, referencedSpecIdentifier, findReusableSpec, slugTokenContainment, taskSimilarity, specReuseEnabled, releaseHeldRunLock, RUN_LOCK_BASENAME } from "../src/setup.ts";
import { isHarnessBookkeepingPath } from "../src/helpers.ts";
import { isInternalRuntimeClaim } from "../src/tracking.ts";

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

// ── H7 (AC-09): worktree-add is FAIL-CLOSED — a failure that prune cannot
// recover aborts setup with git's stderr and a `git worktree prune` hint;
// the silent in-place fallback is gone. SCENARIO-019/020/021.
describe("worktree-add fail-closed (AC-09)", () => {
	/** main repo (one base commit) whose branch `id` is checked out at
	 *  `elsewhere` — a LIVE worktree: `git worktree add` fails and prune
	 *  cannot recover it (the unrecoverable shape). */
	function repoWithLiveBranchElsewhere(id: string): string {
		const d = mkdtempSync(join(tmpdir(), "sd-wtfail-"));
		git(["init", "-b", "main"], d);
		git(["config", "user.email", "t@example.com"], d);
		git(["config", "user.name", "T"], d);
		git(["commit", "--allow-empty", "-m", "base"], d);
		git(["branch", id], d);
		git(["worktree", "add", join(d, "elsewhere"), id], d);
		return d;
	}

	it("SCENARIO-019: unrecoverable failure aborts with the git stderr tail and the `git worktree prune` hint — never a silent in-place run", () => {
		const d = repoWithLiveBranchElsewhere("02-live");
		try {
			// sanity: the add genuinely fails (missing-but-registered class aside,
			// this branch is checked out elsewhere)
			expect(() => git(["worktree", "add", join(d, ".worktree", "02-live"), "02-live"], d)).toThrow();
			expect(() => runSetup("implement a node api", { cwd: d, resumeSpecIdentifier: "02-live" })).toThrow(/git worktree prune/);
			expect(() => runSetup("implement a node api", { cwd: d, resumeSpecIdentifier: "02-live" })).toThrow(/already used by worktree/); // git's stderr tail is surfaced
		} finally { rmSync(d, { recursive: true, force: true }); }
	});

	it("SCENARIO-020: a stale registration for a DELETED .worktree/<id> path is recovered by prune + one retry", () => {
		const d = mkdtempSync(join(tmpdir(), "sd-wtprune-"));
		try {
			git(["init", "-b", "main"], d);
			git(["config", "user.email", "t@example.com"], d);
			git(["config", "user.name", "T"], d);
			git(["commit", "--allow-empty", "-m", "base"], d);
			git(["branch", "01-task"], d);
			git(["worktree", "add", join(d, ".worktree", "01-task"), "01-task"], d);
			rmSync(join(d, ".worktree", "01-task"), { recursive: true, force: true }); // stale: registered, deleted on disk
			// sanity: a plain add fails on the stale registration
			expect(() => git(["worktree", "add", join(d, ".worktree", "01-task"), "01-task"], d)).toThrow();
			const s = runSetup("implement a node api", { cwd: d, resumeSpecIdentifier: "01-task" });
			expect(s.worktreeCreated).toBe(true);
			expect(s.worktreePath).toBe(join(d, ".worktree", "01-task"));
			expect(existsSync(s.worktreePath)).toBe(true);
			// the prune ran: the stale registration is gone from the list
			const list = execFileSync("git", ["worktree", "list", "--porcelain"], { cwd: d, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
			expect(list).not.toContain("prunable");
		} finally { rmSync(d, { recursive: true, force: true }); }
	});

	it("SCENARIO-021: skipWorktree runs bypass the fail-closed path entirely (in-place, no prune/retry/abort)", () => {
		const d = repoWithLiveBranchElsewhere("03-live");
		try {
			const s = runSetup("implement a node api", { cwd: d, resumeSpecIdentifier: "03-live", skipWorktree: true });
			expect(s.worktreeCreated).toBe(false);
			expect(s.worktreePath).toBe(d);
			// the other live worktree was left untouched
			const list = execFileSync("git", ["worktree", "list", "--porcelain"], { cwd: d, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
			expect(list).toContain("elsewhere");
		} finally { rmSync(d, { recursive: true, force: true }); }
	});
});

// ── H2 (AC-02 / SCENARIO-004/005): a REFERENCED-spec entry is a continuation
// of the existing track — `reusedTrack` is set and the track's knowledge +
// user notes survive byte-identically (never cleared); a FRESH new-track entry
// still clears both (existing behavior preserved).
describe("referenced-spec entry preserves the track (AC-02)", () => {
	it("SCENARIO-004: taskSpecIdentifier entry sets reusedTrack and keeps .knowledge.json/.user-notes.json byte-identical", () => {
		const d = mkdtempSync(join(tmpdir(), "sd-ac02-"));
		try {
			git(["init", "-b", "main"], d);
			git(["config", "user.email", "t@example.com"], d);
			git(["config", "user.name", "T"], d);
			git(["commit", "--allow-empty", "-m", "base"], d);
			mkdirSync(join(d, "docs", "specifications", "24-auth-flow"), { recursive: true });
			writeFileSync(join(d, "docs", "specifications", "24-auth-flow", "06-specification.md"), "# Spec\n");
			const knowledgeBefore = JSON.stringify({ stages: { spec: { timestamp: "2026-08-16T00:00:00.000Z", summary: "token refresh uses rotating refresh tokens" } } }, null, 2) + "\n";
			const notesBefore = JSON.stringify({ notes: ["keep the refresh TTL at 15m"] }, null, 2) + "\n";
			writeFileSync(join(d, "docs", "specifications", "24-auth-flow", ".knowledge.json"), knowledgeBefore);
			writeFileSync(join(d, "docs", "specifications", "24-auth-flow", ".user-notes.json"), notesBefore);
			git(["add", "."], d);
			git(["commit", "-m", "seed spec"], d);

			const s = runSetup("implement @docs/specifications/24-auth-flow/ the token refresh changes", { cwd: d, skipWorktree: true });
			expect(s.specIdentifier).toBe("24-auth-flow");
			expect(s.reusedTrack).toBe(true); // H2: a referenced-spec entry is a continuation
			expect(readFileSync(join(s.specDirectory, ".knowledge.json"), "utf8")).toBe(knowledgeBefore); // byte-identical
			expect(readFileSync(join(s.specDirectory, ".user-notes.json"), "utf8")).toBe(notesBefore); // byte-identical
		} finally { rmSync(d, { recursive: true, force: true }); }
	});

	it("SCENARIO-005: a fresh new-track entry still clears knowledge and user notes", () => {
		const d = mkdtempSync(join(tmpdir(), "sd-ac02b-"));
		try {
			git(["init", "-b", "main"], d);
			git(["config", "user.email", "t@example.com"], d);
			git(["config", "user.name", "T"], d);
			git(["commit", "--allow-empty", "-m", "base"], d);
			// Pre-create the directory the fresh allocation will land in (no other
			// numbered specs ⇒ nextSpecNumber = 1 ⇒ "01-fresh-notes") holding STALE
			// notes — a fresh track wipes them.
			const specDir = join(d, ".worktree", "01-fresh-notes", "docs", "specifications", "01-fresh-notes");
			mkdirSync(specDir, { recursive: true });
			writeFileSync(join(specDir, ".knowledge.json"), JSON.stringify({ stages: { stale: { summary: "stale insight" } } }));
			writeFileSync(join(specDir, ".user-notes.json"), JSON.stringify({ notes: ["stale human guidance"] }));

			const s = runSetup("build a car theory html animation page", { cwd: d, slug: "fresh-notes" });
			expect(s.specIdentifier).toBe("01-fresh-notes");
			expect(s.reusedTrack ?? false).toBe(false); // fresh: the clear branch runs
			expect(readFileSync(join(s.specDirectory, ".knowledge.json"), "utf8")).not.toContain("stale insight");
			expect(readFileSync(join(s.specDirectory, ".user-notes.json"), "utf8")).not.toContain("stale human guidance");
		} finally { rmSync(d, { recursive: true, force: true }); }
	});
});

// ── M11 (AC-21 / SCENARIO-045/046): a FRESH (non-resume) entry into an
// EXISTING track must truncate the stale resume cache — this run's fresh #1
// occurrence keys must never mix with the dead run's #2/#3 rows. A RESUME
// entry keeps the cache intact (durable continuation).
describe("fresh entry truncates the stale resume cache (AC-21)", () => {
	const STALE_ROWS = [
		'{"key":"pipeline.requirements@root#2","result":{"text":"","control":{}}}',
		'{"key":"pipeline.requirements@root#3","result":{"text":"","control":{}}}',
	].join("\n") + "\n";

	function seededReferencedTrack(): string {
		const d = mkdtempSync(join(tmpdir(), "sd-ac21-"));
		git(["init", "-b", "main"], d);
		git(["config", "user.email", "t@example.com"], d);
		git(["config", "user.name", "T"], d);
		git(["commit", "--allow-empty", "-m", "base"], d);
		mkdirSync(join(d, "docs", "specifications", "24-auth-flow"), { recursive: true });
		writeFileSync(join(d, "docs", "specifications", "24-auth-flow", ".resume-cache.jsonl"), STALE_ROWS);
		return d;
	}

	it("SCENARIO-045: a fresh referenced-spec entry truncates the stale cache (no #2/#3 mixing)", () => {
		const d = seededReferencedTrack();
		try {
			const s = runSetup("implement @docs/specifications/24-auth-flow/ the token refresh changes", { cwd: d, skipWorktree: true });
			expect(s.reusedTrack).toBe(true);
			expect(readFileSync(join(s.specDirectory, ".resume-cache.jsonl"), "utf8")).toBe(""); // truncated (clearKnowledge semantics, NOT clearResumeCache — no .complete marker)
			expect(existsSync(join(s.specDirectory, ".complete"))).toBe(false);
		} finally { rmSync(d, { recursive: true, force: true }); }
	});

	it("SCENARIO-045 (reused-track shape): a G2-reuse fresh entry truncates the cache strictly AFTER selection", () => {
		const d = mkdtempSync(join(tmpdir(), "sd-ac21b-"));
		try {
			git(["init", "-b", "main"], d);
			git(["config", "user.email", "t@example.com"], d);
			git(["config", "user.name", "T"], d);
			git(["commit", "--allow-empty", "-m", "init"], d);
			const first = runSetup("we want to add step e2e test dashboard at e2e-automation/step-dashboard", { cwd: d });
			writeFileSync(join(first.specDirectory, ".resume-cache.jsonl"), STALE_ROWS);
			// the re-phrased run re-enters the SAME track (findReusableSpec read the
		// cache first) and then truncates the stale rows
			const second = runSetup("implement @docs/requirements/step-e2e-dashboard.md", { cwd: d, slug: "step-e2e-dashboard" });
			expect(second.specIdentifier).toBe(first.specIdentifier);
			expect(second.reusedTrack).toBe(true);
			expect(readFileSync(join(second.specDirectory, ".resume-cache.jsonl"), "utf8")).toBe("");
		} finally { rmSync(d, { recursive: true, force: true }); }
	});

	it("SCENARIO-046: a resume entry preserves the resume-cache rows", () => {
		const d = seededReferencedTrack();
		try {
			const s = runSetup("continue the auth work", { cwd: d, skipWorktree: true, resumeSpecIdentifier: "24-auth-flow" });
			expect(readFileSync(join(s.specDirectory, ".resume-cache.jsonl"), "utf8")).toBe(STALE_ROWS); // intact
		} finally { rmSync(d, { recursive: true, force: true }); }
	});

	it("a fresh entry into a NON-reused fresh track has no stale cache to truncate (no-op, no file minted)", () => {
		const d = mkdtempSync(join(tmpdir(), "sd-ac21c-"));
		try {
			git(["init", "-b", "main"], d);
			git(["config", "user.email", "t@example.com"], d);
			git(["config", "user.name", "T"], d);
			git(["commit", "--allow-empty", "-m", "base"], d);
			const s = runSetup("build a car theory html animation page", { cwd: d, skipWorktree: true, slug: "fresh" });
			expect(existsSync(join(s.specDirectory, ".resume-cache.jsonl"))).toBe(false);
		} finally { rmSync(d, { recursive: true, force: true }); }
	});
});

// ── OQ-3 (AC-30 / SCENARIO-061/062): a per-spec-dir run lock (.run-lock, wx
// create + live-pid check + stale steal) serializes same-track runs. A LIVE
// holder blocks setup with an actionable error; a DEAD holder is stolen; the
// lock is removed on release; the basename is exempt from the harness gates.
describe("spec-dir run lock (AC-30)", () => {
	function seededInPlaceTrack(): string {
		const d = mkdtempSync(join(tmpdir(), "sd-lock-"));
		git(["init", "-b", "main"], d);
		git(["config", "user.email", "t@example.com"], d);
		git(["config", "user.name", "T"], d);
		git(["commit", "--allow-empty", "-m", "base"], d);
		mkdirSync(join(d, "docs", "specifications", "24-auth-flow"), { recursive: true });
		return d;
	}

	it("SCENARIO-061: a live-pid lock produces an actionable setup error naming the holder pid", () => {
		const d = seededInPlaceTrack();
		const holder = spawn("sleep", ["30"], { stdio: "ignore" });
		try {
			const lockPath = join(d, "docs", "specifications", "24-auth-flow", ".run-lock");
			writeFileSync(lockPath, JSON.stringify({ pid: holder.pid, startedAt: new Date().toISOString() }));
			expect(() => runSetup("implement @docs/specifications/24-auth-flow/ the token refresh changes", { cwd: d, skipWorktree: true }))
				.toThrow(new RegExp(`is locked by another super-dev run \\(pid ${holder.pid}, started `));
			expect(readFileSync(lockPath, "utf8")).toContain(String(holder.pid)); // the live holder's lock is NOT stolen
		} finally {
			holder.kill("SIGKILL");
			rmSync(d, { recursive: true, force: true });
		}
	});

	it("SCENARIO-062: a stale (dead-pid) lock is stolen and replaced; the lock is absent after release", () => {
		const d = seededInPlaceTrack();
		try {
			const lockPath = join(d, "docs", "specifications", "24-auth-flow", ".run-lock");
			const dead = spawnSync("true"); // exited synchronously — its pid is gone
			writeFileSync(lockPath, JSON.stringify({ pid: dead.pid, startedAt: "2020-01-01T00:00:00.000Z" }));
			const s = runSetup("implement @docs/specifications/24-auth-flow/ the token refresh changes", { cwd: d, skipWorktree: true });
			expect(s.specIdentifier).toBe("24-auth-flow"); // setup proceeded
			const held = JSON.parse(readFileSync(lockPath, "utf8")) as { pid: number };
			expect(held.pid).toBe(process.pid); // the new holder replaced the stale one
			releaseHeldRunLock();
			expect(existsSync(lockPath)).toBe(false); // removed on release
		} finally { rmSync(d, { recursive: true, force: true }); }
	});

	it("runSetup acquires the lock under RUN_LOCK_BASENAME inside the spec dir; a same-process re-entry steals it (replan restarts)", () => {
		const d = seededInPlaceTrack();
		try {
			expect(RUN_LOCK_BASENAME).toBe(".run-lock");
			const s1 = runSetup("implement @docs/specifications/24-auth-flow/ first entry", { cwd: d, skipWorktree: true });
			const lockPath = join(s1.specDirectory, RUN_LOCK_BASENAME);
			expect(existsSync(lockPath)).toBe(true);
			const s2 = runSetup("implement @docs/specifications/24-auth-flow/ same process re-entry", { cwd: d, skipWorktree: true });
			expect(existsSync(join(s2.specDirectory, RUN_LOCK_BASENAME))).toBe(true); // pid === process.pid ⇒ always stolen
			releaseHeldRunLock();
			expect(existsSync(lockPath)).toBe(false);
		} finally { rmSync(d, { recursive: true, force: true }); }
	});

	it("the .run-lock basename is exempt: harness bookkeeping + internal runtime claims ignore a dirty lock file", () => {
		const d = seededInPlaceTrack();
		try {
			const s = runSetup("implement @docs/specifications/24-auth-flow/ exemptions", { cwd: d, skipWorktree: true });
			const lockRel = `${s.specDirectory}${RUN_LOCK_BASENAME}`;
			expect(isHarnessBookkeepingPath(s.specDirectory, lockRel)).toBe(true);
			expect(isInternalRuntimeClaim(lockRel)).toBe(true);
		} finally {
			releaseHeldRunLock();
			rmSync(d, { recursive: true, force: true });
		}
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

	// ─── T7.8 / R6 (NFR-6 pinning): numeric-token exactness + score log ─────
	//
	// Generic-word containment at the 0.75 threshold absorbs a DIFFERENT
	// workstream into an existing track whenever the slug's ordinary words
	// (step/e2e/dashboard/test/api/ui) overlap. A NUMERIC token in the slug is
	// the one unambiguous discriminator — it must appear VERBATIM in the task
	// text, or containment is 0.
	it("R6: a numeric slug token must appear verbatim in the task text — generic words alone never reach containment", () => {
		// RED today: 3/4 word tokens hit → 0.75 ≥ threshold → wrong-track reuse
		expect(slugTokenContainment("401-auth-bypass-flow", "fix the auth bypass flow in the login service")).toBe(0);
		// the numeral present verbatim → containment holds normally
		expect(slugTokenContainment("401-auth-bypass-flow", "re-run the 401 auth bypass flow fix")).toBe(1);
		// slugs without numeric tokens are unaffected (existing pins above)
		expect(slugTokenContainment("step-e2e-test-dashboard", ORIG_TASK)).toBeGreaterThanOrEqual(0.75);
	});

	it("R6: the reuse decision logs its score so a wrong absorption is visible in the run log", () => {
		const d = mkdtempSync(join(tmpdir(), "sd-reuse-log-"));
		try {
			seedTrack(d, "254-step-e2e-test-dashboard", ORIG_TASK);
			const logs: string[] = [];
		const id = findReusableSpec(d, REPHRASED_B, { log: (m) => logs.push(m) });
			expect(id).toBe("254-step-e2e-test-dashboard");
			// RED today: findReusableSpec has no log channel — the decision is silent
			expect(logs.join(" ")).toMatch(/254-step-e2e-test-dashboard.*score/i);
		} finally { rmSync(d, { recursive: true, force: true }); }
	});

	it("R6: a numeric-slug track is NOT reused by a task that never names the numeral", () => {
		const d = mkdtempSync(join(tmpdir(), "sd-reuse-num-"));
		try {
			// a track whose slug embeds a numeral (e.g. an error code or ticket id)
			seedTrack(d, "301-401-auth-bypass-flow", "fix the 401 auth bypass flow");
			// a DIFFERENT workstream whose generic words all overlap
			expect(findReusableSpec(d, "fix the auth bypass flow in the login service")).toBeNull();
		} finally { rmSync(d, { recursive: true, force: true }); }
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
