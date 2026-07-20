/**
 * Phase 1 — Touched-crate detection helper (RED phase).
 *
 * These tests define the contract for `detectTouchedCargoPackages(cwd, baseRef?)`
 * BEFORE the implementation exists. They target AC-01 and its scenarios:
 *   - SCENARIO-001  path→pkg mapping, first-seen order, dedupe
 *   - SCENARIO-002  base-ref override via SUPER_DEV_GATE_BASE_REF (and explicit arg)
 *   - SCENARIO-003  safe degradation to [] on git failure / empty / non-crate diff
 *                   and the helper NEVER throws
 *   - SCENARIO-020  at most ONE bounded `git diff --name-only` spawn with discrete
 *                   argv elements (no shell:true), reducing wall-time on monorepos
 *   - SCENARIO-022  an uncommitted (untracked) crate absent from `git diff` is NOT
 *                   detected (documented edge case; the in-scope classifier is the
 *                   fallback, not this helper)
 *   - SCENARIO-023  full baseline-diff gating is deferred — only the single diff
 *                   spawn runs here, never a "gate on main" run
 *
 * `detectTouchedCargoPackages` does NOT exist yet — importing it yields
 * `undefined` until it is implemented, so every call throws
 * "detectTouchedCargoPackages is not a function" (intentional RED state).
 *
 * Hermetic: `node:child_process.spawnSync` is mocked so NO real `git` ever runs.
 * We feed synthetic `git diff --name-only` stdout and read the actual spawn argv
 * from `spawn.mock.calls`. Env-touching tests save/restore
 * `SUPER_DEV_GATE_BASE_REF` so tests stay independent (no shared state).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Mock the ONLY side-effect detectTouchedCargoPackages performs: spawnSync.
// Real git must never run in CI. The mock returns synthetic diff output and lets
// us assert the exact argv (discrete elements, never shell:true).
vi.mock("node:child_process", () => ({
	spawnSync: vi.fn(),
}));

import { spawnSync } from "node:child_process";
import { detectTouchedCargoPackages } from "../src/build-runner.ts";

const spawn = spawnSync as unknown as ReturnType<typeof vi.fn>;
const BASE_REF_ENV = "SUPER_DEV_GATE_BASE_REF";

/** Reset the spawn mock before every test (tests are independent). */
beforeEach(() => {
	spawn.mockReset();
});

/** Configure the git-diff spawn to return `stdout` with status 0. */
function diffReturns(stdout: string): void {
	spawn.mockReturnValue({ status: 0, stdout, stderr: "" });
}

/** Save/restore SUPER_DEV_GATE_BASE_REF around an env-touching test block. */
function withBaseRefEnv() {
	let saved: string | undefined;
	return {
		before() {
			saved = process.env[BASE_REF_ENV];
			delete process.env[BASE_REF_ENV];
		},
		after() {
			if (saved === undefined) delete process.env[BASE_REF_ENV];
			else process.env[BASE_REF_ENV] = saved;
		},
	};
}

/** Pull the argv (2nd positional) out of the first spawn call, defensively. */
function firstArgv(): string[] | undefined {
	return spawn.mock.calls[0]?.[1] as string[] | undefined;
}

/* -------------------------------------------------------------------------- */
/* path→pkg mapping, order, dedupe — AC-01 / SCENARIO-001                       */
/* -------------------------------------------------------------------------- */

describe("path→pkg mapping, first-seen order, dedupe (AC-01 / SCENARIO-001)", () => {
	it("maps crates/data/ + crates/api/ to [data, api] preserving first-seen order", () => {
		diffReturns("crates/data/src/lib.rs\ncrates/api/src/main.rs\n");
		expect(detectTouchedCargoPackages("/repo")).toEqual(["data", "api"]);
	});

	it("dedupes a single crate touched in multiple files to one entry", () => {
		diffReturns("crates/data/src/a.rs\ncrates/data/src/b.rs\n");
		expect(detectTouchedCargoPackages("/repo")).toEqual(["data"]);
	});

	it("preserves first-seen order across interleaved duplicates", () => {
		diffReturns("crates/api/x.rs\ncrates/data/y.rs\ncrates/api/z.rs\n");
		expect(detectTouchedCargoPackages("/repo")).toEqual(["api", "data"]);
	});

	it("extracts the crates/<pkg>/ segment for a deeply nested path", () => {
		diffReturns("crates/data/src/sub/deep/file.rs\n");
		expect(detectTouchedCargoPackages("/repo")).toEqual(["data"]);
	});

	it("ignores non-crate paths (root Cargo.toml, README) but keeps crate paths", () => {
		diffReturns("Cargo.toml\nREADME.md\ncrates/data/src/lib.rs\n");
		expect(detectTouchedCargoPackages("/repo")).toEqual(["data"]);
	});

	it("always returns a plain string[] (every element typeof string)", () => {
		diffReturns("crates/data/src/lib.rs\n");
		const out = detectTouchedCargoPackages("/repo");
		expect(Array.isArray(out)).toBe(true);
		expect(out.every((p) => typeof p === "string")).toBe(true);
	});
});

/* -------------------------------------------------------------------------- */
/* base-ref override — AC-01 / SCENARIO-002                                     */
/* -------------------------------------------------------------------------- */

describe("base-ref override (AC-01 / SCENARIO-002)", () => {
	const env = withBaseRefEnv();
	beforeEach(env.before);
	afterEach(env.after);

	it("defaults to --merge-base main when no arg and no env", () => {
		diffReturns("");
		detectTouchedCargoPackages("/repo");
		const args = firstArgv();
		expect(args).toContain("--merge-base");
		expect(args).toContain("main");
	});

	it("reads SUPER_DEV_GATE_BASE_REF into --merge-base when no arg is given", () => {
		process.env[BASE_REF_ENV] = "develop";
		diffReturns("");
		detectTouchedCargoPackages("/repo");
		const args = firstArgv();
		expect(args).toContain("develop");
		expect(args).not.toContain("main");
	});

	it("an explicit baseRef arg wins over the env var", () => {
		process.env[BASE_REF_ENV] = "develop";
		diffReturns("");
		detectTouchedCargoPackages("/repo", "release-1.2");
		const args = firstArgv();
		expect(args).toContain("release-1.2");
		expect(args).not.toContain("develop");
		expect(args).not.toContain("main");
	});

	it("runs git in the given cwd via `-C <cwd>`", () => {
		diffReturns("");
		detectTouchedCargoPackages("/work/repo");
		const args = firstArgv();
		expect(args?.[0]).toBe("-C");
		expect(args?.[1]).toBe("/work/repo");
	});
});

/* -------------------------------------------------------------------------- */
/* safe degradation to [] — AC-01 / SCENARIO-003                                */
/* -------------------------------------------------------------------------- */

describe("safe degradation to [] (AC-01 / SCENARIO-003)", () => {
	it("returns [] when git exits non-zero (missing base ref / non-git dir)", () => {
		spawn.mockReturnValue({ status: 128, stdout: "", stderr: "fatal: not a git repository" });
		expect(detectTouchedCargoPackages("/repo")).toEqual([]);
	});

	it("returns [] when spawn reports r.error (ENOENT / git missing)", () => {
		spawn.mockReturnValue({
			status: null,
			stdout: "",
			stderr: "",
			error: new Error("spawn git ENOENT"),
		});
		expect(detectTouchedCargoPackages("/repo")).toEqual([]);
	});

	it("returns [] for an empty diff (no changes vs base ref)", () => {
		diffReturns("");
		expect(detectTouchedCargoPackages("/repo")).toEqual([]);
	});

	it("returns [] for a whitespace-only diff", () => {
		diffReturns("\n\n  \n");
		expect(detectTouchedCargoPackages("/repo")).toEqual([]);
	});

	it("returns [] when the diff contains ONLY non-crate paths", () => {
		diffReturns("Cargo.toml\nREADME.md\ndocs/spec.md\n");
		expect(detectTouchedCargoPackages("/repo")).toEqual([]);
	});

	it("an empty resolved set is exactly the workspace-wide trigger in runBuildGate", () => {
		// The helper's [] return is the value runBuildGate relies on to fall back
		// to workspace-wide scoping (no -p flags anywhere).
		spawn.mockReturnValue({ status: 1, stdout: "", stderr: "fatal: bad revision 'main'" });
		expect(detectTouchedCargoPackages("/repo").length).toBe(0);
	});
});

/* -------------------------------------------------------------------------- */
/* never throws — AC-01 / SCENARIO-003 & SCENARIO-021                           */
/* -------------------------------------------------------------------------- */

describe("never throws — degrades to [] (AC-01 / SCENARIO-003 & SCENARIO-021)", () => {
	it("returns [] instead of throwing when spawnSync throws synchronously", () => {
		spawn.mockImplementation(() => {
			throw new Error("boom");
		});
		expect(() => detectTouchedCargoPackages("/repo")).not.toThrow();
		expect(detectTouchedCargoPackages("/repo")).toEqual([]);
	});

	it("returns [] instead of throwing on a non-string stdout (defensive parse)", () => {
		// A non-string stdout would crash a naive `.split("\n")`; the contract
		// requires the whole body to be try/caught → [].
		spawn.mockReturnValue({
			status: 0,
			stdout: { weird: true } as unknown as string,
			stderr: "",
		});
		expect(() => detectTouchedCargoPackages("/repo")).not.toThrow();
		expect(detectTouchedCargoPackages("/repo")).toEqual([]);
	});
});

/* -------------------------------------------------------------------------- */
/* spawn shape: one bounded git diff, discrete argv — AC-01 / SCENARIO-020/023  */
/* -------------------------------------------------------------------------- */

describe("spawn shape: two read-only git spawns (diff + untracked union), discrete argv (AC-01 / SCENARIO-020/023/037/038)", () => {
	it("invokes git as discrete-argv spawnSync calls (named 'git', no shell)", () => {
		diffReturns("crates/data/src/lib.rs\n");
		detectTouchedCargoPackages("/repo");
		// Layer B (untracked-file union, AC-01): detection now spawns TWO read-only
		// git commands — `diff --merge-base` (committed changes) +
		// `ls-files --others --exclude-standard` (untracked files) — so a brand-new
		// (uncommitted) crate dir is NOT silently dropped. Both are discrete-argv
		// spawns with no shell:true.
		expect(spawn.mock.calls).toHaveLength(2);
		const [cmd, argv, opts] = spawn.mock.calls[0] as [
			string,
			string[],
			{ shell?: boolean; encoding?: string },
		];
		expect(cmd).toBe("git");
		expect(argv).toEqual(["-C", "/repo", "diff", "--merge-base", "main", "--name-only"]);
		expect(opts?.shell).toBeFalsy();
		expect(opts?.encoding).toBe("utf8");
		// The second spawn is the untracked-files union.
		const [cmd2, argv2] = spawn.mock.calls[1] as [string, string[], unknown];
		expect(cmd2).toBe("git");
		expect(argv2).toEqual(["-C", "/repo", "ls-files", "--others", "--exclude-standard"]);
	});

	it("performs exactly TWO git spawns per call: the committed diff + the untracked union (no baseline-on-main run)", () => {
		// SCENARIO-023: full baseline-diff gating is NOT implemented; the only git
		// spawns are the single `git diff --name-only` and the `git ls-files`
		// untracked union (SCENARIO-037/038).
		diffReturns("crates/api/x.rs\ncrates/data/y.rs\n");
		detectTouchedCargoPackages("/repo");
		expect(spawn.mock.calls).toHaveLength(2);
	});

	it("still spawns exactly two git commands on a failed diff (no follow-up diagnostic spawns)", () => {
		// Even when the diff fails, the untracked union still runs independently;
		// each failing command contributes nothing but no extra spawns occur.
		spawn.mockReturnValue({ status: 128, stdout: "", stderr: "fatal" });
		detectTouchedCargoPackages("/repo");
		expect(spawn.mock.calls).toHaveLength(2);
	});
});

/* -------------------------------------------------------------------------- */
/* uncommitted crate not detected — AC-01 / SCENARIO-022                        */
/* -------------------------------------------------------------------------- */

describe("only committed diff entries are detected (AC-01 / SCENARIO-022)", () => {
	it("an uncommitted (untracked) crate absent from git diff is NOT in the set", () => {
		// The implementer created crates/newcrate/ but it is not committed yet, so
		// `git diff --name-only` against main does NOT list it. Detection only
		// sees what the branch has actually changed.
		diffReturns("crates/data/src/lib.rs\n");
		const pkgs = detectTouchedCargoPackages("/repo");
		expect(pkgs).toEqual(["data"]);
		expect(pkgs).not.toContain("newcrate");
	});

	it("an empty committed diff for an untracked-only change yields [] (documented edge case)", () => {
		// Falls back to workspace-wide; the in-scope classifier (later phase) is
		// what protects against false-abort, not this helper.
		diffReturns("");
		expect(detectTouchedCargoPackages("/repo")).toEqual([]);
	});
});
