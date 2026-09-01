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
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deterministicPhaseCommit, discardGreenWork, porcelainEntries, gitStatusPaths } from "../src/stages/implementation.ts";

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

	it("a tracked file literally named ':(top)*' does not widen the restore past the keep-list (v0.3.55 security F2)", async () => {
		// Pre-fix, `git restore --worktree -- ':(top)*'` parsed magic `top` + a
		// cross-directory `*` pattern and reverted EVERY tracked modified file —
		// including keep-listed RED test files the per-path iteration protects.
		const { discardGreenWork } = await import("../src/stages/implementation.ts");
		const { repo, git } = makeRepo();
		mkdirSync(join(repo, "tests"), { recursive: true });
		writeFileSync(join(repo, "tests", "red.test.ts"), "it('red', () => {});\n");
		writeFileSync(join(repo, ":(top)*"), "junk v1\n");
		spawnSync("git", ["add", "-A"], { cwd: repo });
		spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "tests"], { cwd: repo });
		// Post-seed dirt: production modified (discardable), test modified (KEEP),
		// and the magic-named file TRACKED-modified (discardable — but its restore
		// must not widen).
		writeFileSync(join(repo, "seed.txt"), "modified-by-implementer\n");
		writeFileSync(join(repo, "tests", "red.test.ts"), "it('red v2', () => {});\n");
		writeFileSync(join(repo, ":(top)*"), "junk v2\n");
		discardGreenWork(repo, new Set(["tests/red.test.ts"]));
		expect(String(git("show", "HEAD:seed.txt").stdout)).toBe("seed\n");
		// The keep-listed test file survives the magic-named file's restore
		// (worktree content, never staged → read from disk).
		expect(readFileSync(join(repo, "tests", "red.test.ts"), "utf8")).toBe("it('red v2', () => {});\n");
		rmSync(repo, { recursive: true, force: true });
	});
});

/* ── v0.3.45: -z porcelain reader vs C-quoted paths ────────────────────────
 * Real-repo regression for the v1-quoting class found in the wild: git quotes
 * space-containing paths on EVERY machine and non-ASCII paths whenever
 * core.quotepath=true (the git DEFAULT — only this dev box's global config
 * disables it, which is why every earlier ASCII-only fixture silently passed).
 * Each repo below PINS core.quotepath=true locally to simulate a default
 * machine, so these tests prove the engine's -z reader is machine-independent. */
describe("porcelain -z reader (v0.3.45) — quoted 中文/space/rename paths", () => {
	function makeQuotedRepo() {
		const repo = mkdtempSync(join(tmpdir(), "sd-porcelain-"));
		const git = (...args: string[]) => spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
		git("init", "-q");
		git("config", "user.email", "t@t");
		git("config", "user.name", "t");
		git("config", "core.quotepath", "true"); // simulate the git default machine
		mkdirSync(join(repo, "中文目录"), { recursive: true });
		mkdirSync(join(repo, "space dir"), { recursive: true });
		writeFileSync(join(repo, "seed.txt"), "seed\n");
		writeFileSync(join(repo, "中文目录", "文件.ts"), "a\n");
		writeFileSync(join(repo, "space dir", "file.txt"), "b\n");
		git("add", "-A");
		git("commit", "-qm", "init");
		return { repo, git };
	}

	it("gitStatusPaths returns RAW unquoted paths for modified/untracked 中文 and space files (no ' M' mangling, no quote leakage)", () => {
		const { repo, git } = makeQuotedRepo();
		try {
			writeFileSync(join(repo, "seed.txt"), "seed\nMODIFIED"); // ' M' tracked modification
			writeFileSync(join(repo, "中文目录", "新文件.kt"), "x"); // untracked non-ASCII
			writeFileSync(join(repo, "space dir", "new.txt"), "y"); // untracked, space path
			const paths = gitStatusPaths(repo);
			expect(paths.has("seed.txt")).toBe(true); // NOT 'eed.txt' (the v1 trim bug)
			expect(paths.has("中文目录/新文件.kt")).toBe(true); // NOT octal-escaped
			expect(paths.has("space dir/new.txt")).toBe(true); // NOT wrapped in literal quotes
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	});

	it("porcelainEntries flattens rename records (both new and old path visible)", () => {
		const { repo, git } = makeQuotedRepo();
		try {
			git("mv", "space dir/file.txt", "space dir/renamed.txt");
			const entries = porcelainEntries(repo);
			const renamed = entries.find((e) => e.status.startsWith("R"));
			expect(renamed?.path).toBe("space dir/renamed.txt"); // unquoted new side
			expect(renamed?.fromPath).toBe("space dir/file.txt"); // old side as its own field
			expect(entries.some((e) => e.path === "中文目录/文件.ts")).toBe(false); // clean file not reported
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	});

	it("discardGreenWork restores modified and removes untracked 中文/space paths under core.quotepath=true", () => {
		const { repo, git } = makeQuotedRepo();
		try {
			writeFileSync(join(repo, "中文目录", "文件.ts"), "a\nGREEN-EDIT"); // tracked modification
			writeFileSync(join(repo, "space dir", "green-new.ts"), "impl"); // untracked GREEN output
			const discarded = discardGreenWork(repo, new Set(["tests/keep.test.ts"]));
			expect(discarded).toContain("中文目录/文件.ts");
			expect(discarded).toContain("space dir/green-new.ts");
			expect(String(git("status", "--porcelain").stdout).trim()).toBe(""); // tree back to HEAD
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	});

	it("deterministicPhaseCommit commits 中文/space files and still excludes runtime scratch under them", () => {
		const { repo, git } = makeQuotedRepo();
		try {
			writeFileSync(join(repo, "中文目录", "prod.ts"), "impl\n");
			writeFileSync(join(repo, "中文目录", ".judge.jsonl"), "{}\n"); // excluded basename under non-ASCII dir
			const out = deterministicPhaseCommit(repo, { phaseIndex: 1, totalPhases: 2, phaseName: "中文相位", gateSummary: "all-green", worktreeCreated: true });
			expect(out.status).toBe("committed");
			// the production file rides the commit; the judge scratch stays untracked
			expect(String(git("-c", "core.quotepath=false", "show", "--name-only", "--pretty=format:", "HEAD").stdout)).toContain("中文目录/prod.ts");
			expect(String(git("status", "--porcelain", "--untracked-files=all").stdout)).toContain(".judge.jsonl");
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	});
});
