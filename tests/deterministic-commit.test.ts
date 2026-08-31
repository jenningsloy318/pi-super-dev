/**
 * v0.3.43 — deterministicPhaseCommit (RC4: engine-side phase commits).
 *
 * The LLM commit orchestrator measured 9 calls / 62.5 min / 179K output tokens
 * on run 2026-08-30T08-17-36 and once timed out at 20 min stranding a file
 * (AnkiQuick run 05-26-19 R1). These tests pin the engine-side replacement:
 * staging, the runtime-scratch exclusion set, honest skip/fallback outcomes,
 * and the deterministic message.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deterministicPhaseCommit } from "../src/stages/implementation.ts";

const ENV_KEYS = ["SUPER_DEV_LLM_COMMITS"];

function makeRepo(): { repo: string; git: (...args: string[]) => ReturnType<typeof spawnSync> } {
	const repo = mkdtempSync(join(tmpdir(), "sd-detcommit-"));
	const git = (...args: string[]) => spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
	git("init", "-q");
	git("config", "user.email", "t@t");
	git("config", "user.name", "t");
	writeFileSync(join(repo, "seed.txt"), "seed\n");
	git("add", "-A");
	git("commit", "-qm", "seed");
	return { repo, git };
}

describe("deterministicPhaseCommit (v0.3.43 RC4)", () => {
	const saved: Record<string, string | undefined> = {};
	beforeEach(() => { for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; } });
	afterEach(() => { for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

	it("commits phase changes with a deterministic message and excludes runtime-scratch basenames", () => {
		const { repo, git } = makeRepo();
		try {
			writeFileSync(join(repo, "src", "feature.ts") /* missing dir → mkdir below */, "");
		} catch { /* node 20 strictness guard */ }
		try {
			mkdirSync(join(repo, "src"), { recursive: true });
			writeFileSync(join(repo, "src", "feature.ts"), "export {};\n");
			writeFileSync(join(repo, "tests", "feature.test.ts"), "");
		} catch { /* covered by mkdir above */ }
		mkdirSync(join(repo, "tests"), { recursive: true });
		writeFileSync(join(repo, "tests", "feature.test.ts"), "it('works', () => {});\n");
		mkdirSync(join(repo, "docs", "specifications", "spec-x"), { recursive: true });
		writeFileSync(join(repo, "docs", "specifications", "spec-x", "01-requirements.md"), "# reqs\n");
		writeFileSync(join(repo, "docs", "specifications", "spec-x", ".judge.jsonl"), "{}\n");
		writeFileSync(join(repo, "docs", "specifications", "spec-x", "test-runner.json"), "{}\n");

		const out = deterministicPhaseCommit(repo, {
			phaseIndex: 2, totalPhases: 5, phaseName: "feature-phase", worktreeCreated: true,
			gateSummary: "build green; TDD oracle green",
		});
		expect(out.status).toBe("committed");
		expect(out.sha).toMatch(/^[0-9a-f]+$/);

		const log = String(git("log", "-1", "--format=%B").stdout);
		expect(log).toContain("phase 2/5: feature-phase");
		expect(log).toContain("build green; TDD oracle green");
		expect(log).toContain("[super-dev: deterministic-phase-commit]");

		const tracked = String(git("ls-files").stdout).split("\n");
		expect(tracked).toContain("src/feature.ts");
		expect(tracked).toContain("tests/feature.test.ts");
		expect(tracked).toContain("docs/specifications/spec-x/01-requirements.md");
		expect(tracked).not.toContain("docs/specifications/spec-x/.judge.jsonl");
		expect(tracked).not.toContain("docs/specifications/spec-x/test-runner.json");
		// Excluded files must remain on disk (untracked), not swept away.
		expect(String(git("status", "--porcelain").stdout)).toContain("test-runner.json");
		rmSync(repo, { recursive: true, force: true });
	});

	it("skips honestly when the tree is already clean", () => {
		const { repo } = makeRepo();
		const out = deterministicPhaseCommit(repo, { phaseIndex: 1, totalPhases: 1, phaseName: "p", worktreeCreated: true, gateSummary: "g" });
		expect(out.status).toBe("skipped");
		expect(out.reason).toContain("clean");
		rmSync(repo, { recursive: true, force: true });
	});

	it("skips when ONLY runtime-scratch files changed (nothing durable)", () => {
		const { repo } = makeRepo();
		writeFileSync(join(repo, "test-runner.json"), "{}\n");
		const out = deterministicPhaseCommit(repo, { phaseIndex: 1, totalPhases: 1, phaseName: "p", worktreeCreated: true, gateSummary: "g" });
		expect(out.status).toBe("skipped");
		expect(out.reason).toContain("runtime-scratch");
		rmSync(repo, { recursive: true, force: true });
	});

	it("falls back on the SUPER_DEV_LLM_COMMITS=1 kill-switch", () => {
		const { repo } = makeRepo();
		process.env.SUPER_DEV_LLM_COMMITS = "1";
		writeFileSync(join(repo, "a.txt"), "x\n");
		const out = deterministicPhaseCommit(repo, { phaseIndex: 1, totalPhases: 1, phaseName: "p", worktreeCreated: true, gateSummary: "g" });
		expect(out.status).toBe("fallback");
		expect(out.reason).toContain("SUPER_DEV_LLM_COMMITS");
		rmSync(repo, { recursive: true, force: true });
	});

	it("falls back on in-place runs (no dedicated worktree) — the user's checkout is never auto-committed", () => {
		const { repo } = makeRepo();
		writeFileSync(join(repo, "a.txt"), "x\n");
		const out = deterministicPhaseCommit(repo, { phaseIndex: 1, totalPhases: 1, phaseName: "p", worktreeCreated: false, gateSummary: "g" });
		expect(out.status).toBe("fallback");
		expect(out.reason).toContain("in-place");
		rmSync(repo, { recursive: true, force: true });
	});

	it("commits deletions too (git add -A semantics)", () => {
		const { repo, git } = makeRepo();
		// seed.txt exists from makeRepo; delete it and add a new file.
		spawnSync("rm", [join(repo, "seed.txt")]);
		writeFileSync(join(repo, "new.txt"), "n\n");
		const out = deterministicPhaseCommit(repo, { phaseIndex: 1, totalPhases: 1, phaseName: "p", worktreeCreated: true, gateSummary: "g" });
		expect(out.status).toBe("committed");
		const tracked = String(git("ls-files").stdout).split("\n");
		expect(tracked).not.toContain("seed.txt");
		expect(tracked).toContain("new.txt");
		rmSync(repo, { recursive: true, force: true });
	});
});

describe("discardGreenWork (v0.3.43 RC2 — fail-closed join discard)", () => {
	const saved: Record<string, string | undefined> = {};
	beforeEach(() => { for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; } });
	afterEach(() => { for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

	it("restores tracked modifications and removes untracked GREEN files while keeping test files and harness bookkeeping", async () => {
		const { deterministicPhaseCommit } = await import("../src/stages/implementation.ts");
		const { discardGreenWork } = await import("../src/stages/implementation.ts");
		const { repo, git } = makeRepo();
		// Tracked production file modified by the implementer.
		writeFileSync(join(repo, "seed.txt"), "modified-by-implementer\n");
		// Untracked GREEN file created by the implementer.
		writeFileSync(join(repo, "src-feature.ts"), "export {};\n");
		// RED test file (untracked) — MUST survive.
		mkdirSync(join(repo, "tests"), { recursive: true });
		writeFileSync(join(repo, "tests", "red.test.ts"), "it('red', () => {});\n");
		// Harness bookkeeping (untracked spec dir) — MUST survive.
		mkdirSync(join(repo, "docs", "specifications", "spec-x"), { recursive: true });
		writeFileSync(join(repo, "docs", "specifications", "spec-x", "events.jsonl"), "{}\n");
		const discarded = discardGreenWork(repo, new Set(["tests/red.test.ts"]));
		expect(discarded).toContain("src-feature.ts");
		expect(discarded).toContain("seed.txt");
		expect(discarded).not.toContain("tests/red.test.ts");
		// seed.txt restored to HEAD content; GREEN file gone; test + ledger intact.
		expect(String(git("show", "HEAD:seed.txt").stdout)).toBe("seed\n");
		const status = String(git("status", "--porcelain", "-uall").stdout);
		expect(status).toContain("tests/red.test.ts");
		expect(status).toContain("docs/specifications/spec-x/events.jsonl");
		expect(status).not.toContain("src-feature.ts");
		rmSync(repo, { recursive: true, force: true });
	});

	it("restores tracked files DELETED by the implementer", async () => {
		const { discardGreenWork } = await import("../src/stages/implementation.ts");
		const { repo, git } = makeRepo();
		spawnSync("rm", [join(repo, "seed.txt")]);
		const discarded = discardGreenWork(repo, new Set());
		expect(discarded).toContain("seed.txt");
		expect(String(git("status", "--porcelain").stdout).trim()).toBe("");
		rmSync(repo, { recursive: true, force: true });
	});
});
