/**
 * Phase 1 — Shared `touchedFilePaths` git helper (RED phase).
 *
 * These tests define the contract for the NEW exported helper
 * `touchedFilePaths(cwd, baseRef?): string[]` BEFORE any implementation
 * exists. The helper is the foundation for Phase 5 (npm in/out-of-scope
 * classification): it extracts the raw git `diff --merge-base` + `ls-files
 * --others` union currently embedded in `detectTouchedCargoPackages`
 * (build-runner.ts:485) into its own pure-git, never-throwing function.
 *
 * CONTRACT (from the P1 specification):
 *   - Returns RAW file paths — NO crate-segment filtering. A line like
 *     `crates/data/src/lib.rs` is returned verbatim; non-crate paths
 *     (`Cargo.toml`, `README.md`, `docs/spec.md`) are ALSO returned (unlike
 *     `detectTouchedCargoPackages`, which maps to crate segments only).
 *   - UNION of BOTH git stdouts: `git diff --merge-base <ref> --name-only`
 *     (committed changes) + `git ls-files --others --exclude-standard`
 *     (untracked-but-not-ignored files). De-duplicated via
 *     `dedupePreservingOrder` preserving first-seen order (committed diff
 *     lines first, then untracked-only lines).
 *   - Base-ref precedence (highest → lowest): explicit `baseRef` arg >
 *     `SUPER_DEV_GATE_BASE_REF` env > `"main"`.
 *   - NEVER throws: the entire body is try/caught; returns `[]` on a non-zero
 *     git exit, an `r.error` (git missing / ENOENT), empty/whitespace output,
 *     a non-string stdout, or any thrown exception.
 *   - Exactly TWO bounded git spawns per call (no baseline-on-main run).
 *
 * `touchedFilePaths` does NOT exist yet — importing it yields `undefined`
 * until it is implemented, so every call throws
 * "touchedFilePaths is not a function" (intentional RED state).
 *
 * Hermetic: `node:child_process.spawnSync` is mocked so NO real `git` ever
 * runs. Env-touching tests save/restore `SUPER_DEV_GATE_BASE_REF` so tests
 * stay independent (no shared state).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Mock the ONLY side-effect touchedFilePaths performs: spawnSync. Real git must
// never run in CI. The mock lets us feed synthetic diff + untracked stdouts
// and read the exact spawn argv (discrete elements, never shell:true).
vi.mock("node:child_process", () => ({
	spawnSync: vi.fn(),
}));

import { spawnSync } from "node:child_process";
import { touchedFilePaths } from "../src/build-runner.ts";

const spawn = spawnSync as unknown as ReturnType<typeof vi.fn>;
const BASE_REF_ENV = "SUPER_DEV_GATE_BASE_REF";

/** Reset the spawn mock before every test (tests are independent). */
beforeEach(() => {
	spawn.mockReset();
});

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

/**
 * Configure the git spawns: the committed-diff call returns `diffOut` and the
 * untracked-union call returns `untrackedOut`, both status 0. Decides which is
 * which by inspecting the spawn argv (`diff` vs `ls-files`), matching the real
 * implementation's call order-independent of mockReturnValueOnce sequencing.
 */
function diffAndUntracked(
	diffOut: string,
	untrackedOut: string,
	status = 0,
): void {
	spawn.mockImplementation((cmd: string, argv: string[]) => {
		if (Array.isArray(argv) && argv.includes("diff")) {
			return { status, stdout: diffOut, stderr: "" };
		}
		return { status, stdout: untrackedOut, stderr: "" };
	});
}

/** Pull the argv (2nd positional) out of the diff spawn call (the one with
 * "diff" in its argv), or the first call as a fallback. */
function diffArgv(): string[] | undefined {
	const diffCall = spawn.mock.calls.find(
		(c) => Array.isArray(c[1]) && (c[1] as string[]).includes("diff"),
	);
	return (diffCall?.[1] as string[] | undefined) ?? (spawn.mock.calls[0]?.[1] as string[]);
}

/** Pull the argv (2nd positional) out of the untracked-union spawn call. */
function untrackedArgv(): string[] | undefined {
	const call = spawn.mock.calls.find(
		(c) => Array.isArray(c[1]) && (c[1] as string[]).includes("ls-files"),
	);
	return call?.[1] as string[] | undefined;
}

/* -------------------------------------------------------------------------- */
/* raw path mapping (NO crate filtering) — P1 / SCENARIO-001/020/022/037/038   */
/* -------------------------------------------------------------------------- */

describe("raw path mapping — returns file paths VERBATIM, no crate filtering (P1)", () => {
	it("returns committed-diff paths verbatim, preserving order", () => {
		diffAndUntracked("crates/data/src/lib.rs\ncrates/api/src/main.rs\n", "");
		expect(touchedFilePaths("/repo")).toEqual([
			"crates/data/src/lib.rs",
			"crates/api/src/main.rs",
		]);
	});

	it("returns untracked-only paths verbatim when the diff is empty", () => {
		diffAndUntracked("", "crates/newcrate/src/lib.rs\nnewfile.ts\n");
		expect(touchedFilePaths("/repo")).toEqual([
			"crates/newcrate/src/lib.rs",
			"newfile.ts",
		]);
	});

	it("includes NON-crate paths verbatim (Cargo.toml, README, docs/…)", () => {
		// The critical P1 distinction from detectTouchedCargoPackages: raw paths
		// are returned WITHOUT crate-segment filtering, so a root Cargo.toml or a
		// docs/ path that the in-scope classifier needs survives untouched.
		diffAndUntracked("Cargo.toml\nREADME.md\ndocs/spec.md\n", "");
		expect(touchedFilePaths("/repo")).toEqual([
			"Cargo.toml",
			"README.md",
			"docs/spec.md",
		]);
	});

	it("keeps mixed crate + non-crate paths, all verbatim, order preserved", () => {
		diffAndUntracked("Cargo.toml\ncrates/data/src/lib.rs\nREADME.md\n", "");
		expect(touchedFilePaths("/repo")).toEqual([
			"Cargo.toml",
			"crates/data/src/lib.rs",
			"README.md",
		]);
	});

	it("always returns a plain string[] (every element typeof string)", () => {
		diffAndUntracked("crates/data/src/lib.rs\n", "");
		const out = touchedFilePaths("/repo");
		expect(Array.isArray(out)).toBe(true);
		expect(out.every((p) => typeof p === "string")).toBe(true);
	});
});

/* -------------------------------------------------------------------------- */
/* union of committed diff + untracked, dedup ordering — P1 / SCENARIO-022     */
/* -------------------------------------------------------------------------- */

describe("union of committed diff + untracked, dedup ordering (P1 / SCENARIO-022)", () => {
	it("unions the committed diff with untracked files (untracked appended)", () => {
		diffAndUntracked(
			"crates/data/src/lib.rs\n",
			"crates/newcrate/tests/e2e_smoke.rs\n",
		);
		// Committed diff lines come first, untracked-only lines after, preserving
		// first-seen order. The motivating stockfan e2e fix: a brand-new
		// (uncommitted) crate dir is NOT silently dropped.
		expect(touchedFilePaths("/repo")).toEqual([
			"crates/data/src/lib.rs",
			"crates/newcrate/tests/e2e_smoke.rs",
		]);
	});

	it("dedupes a path present in BOTH diff and untracked to a single entry", () => {
		// A modified-and-staged file might appear in both listings; the union must
		// collapse it to ONE entry at its first-seen (committed-diff) position.
		diffAndUntracked("src/a.ts\nsrc/shared.ts\n", "src/shared.ts\nsrc/b.ts\n");
		expect(touchedFilePaths("/repo")).toEqual(["src/a.ts", "src/shared.ts", "src/b.ts"]);
	});

	it("preserves first-seen order across an interleaved union", () => {
		diffAndUntracked(
			"crates/api/x.rs\ncrates/data/y.rs\n",
			"crates/api/z.rs\ncrates/data/w.rs\n",
		);
		expect(touchedFilePaths("/repo")).toEqual([
			"crates/api/x.rs",
			"crates/data/y.rs",
			"crates/api/z.rs",
			"crates/data/w.rs",
		]);
	});

	it("an untracked-only change with an empty committed diff still returns paths", () => {
		// detectTouchedCargoPackages returned [] here (no crate segment); the raw
		// helper returns the untracked paths so Phase 5 can still classify scope.
		diffAndUntracked("", "crates/newcrate/src/lib.rs\n");
		expect(touchedFilePaths("/repo")).toEqual(["crates/newcrate/src/lib.rs"]);
	});
});

/* -------------------------------------------------------------------------- */
/* safe degradation to [] — P1 / SCENARIO-003                                  */
/* -------------------------------------------------------------------------- */

describe("safe degradation to [] (P1 / SCENARIO-003)", () => {
	it("returns [] when the diff exits non-zero and untracked is empty", () => {
		spawn.mockReturnValue({ status: 128, stdout: "", stderr: "fatal: not a git repository" });
		expect(touchedFilePaths("/repo")).toEqual([]);
	});

	it("returns [] when BOTH git spawns report an r.error (ENOENT / git missing)", () => {
		spawn.mockReturnValue({
			status: null,
			stdout: "",
			stderr: "",
			error: new Error("spawn git ENOENT"),
		});
		expect(touchedFilePaths("/repo")).toEqual([]);
	});

	it("returns [] when one spawn fails but the other contributes nothing", () => {
		// The failing command contributes nothing; if the surviving command is
		// also empty, the union is [].
		spawn.mockImplementation((cmd: string, argv: string[]) => {
			if (argv.includes("diff")) {
				return { status: 128, stdout: "", stderr: "fatal: bad revision 'main'" };
			}
			return { status: 0, stdout: "", stderr: "" };
		});
		expect(touchedFilePaths("/repo")).toEqual([]);
	});

	it("returns [] for an empty diff AND an empty untracked set", () => {
		diffAndUntracked("", "");
		expect(touchedFilePaths("/repo")).toEqual([]);
	});

	it("returns [] for a whitespace-only diff + untracked", () => {
		diffAndUntracked("\n\n  \n", "\n   \n");
		expect(touchedFilePaths("/repo")).toEqual([]);
	});

	it("a [] return is the conservative in-scope fallback for Phase 5", () => {
		// The helper's [] return is the value Phase 5 treats as "empty touched →
		// conservative in-scope" (grants no false green).
		spawn.mockReturnValue({ status: 1, stdout: "", stderr: "fatal: bad revision 'main'" });
		expect(touchedFilePaths("/repo").length).toBe(0);
	});
});

/* -------------------------------------------------------------------------- */
/* never throws — P1 / SCENARIO-003 & SCENARIO-021                             */
/* -------------------------------------------------------------------------- */

describe("never throws — degrades to [] (P1 / SCENARIO-003 & SCENARIO-021)", () => {
	it("returns [] instead of throwing when spawnSync throws synchronously", () => {
		spawn.mockImplementation(() => {
			throw new Error("boom");
		});
		expect(() => touchedFilePaths("/repo")).not.toThrow();
		expect(touchedFilePaths("/repo")).toEqual([]);
	});

	it("returns [] instead of throwing on a non-string stdout (defensive parse)", () => {
		// A non-string stdout would crash a naive `.split("\n")`; the contract
		// requires the whole body to be try/caught → [].
		spawn.mockReturnValue({
			status: 0,
			stdout: { weird: true } as unknown as string,
			stderr: "",
		});
		expect(() => touchedFilePaths("/repo")).not.toThrow();
		expect(touchedFilePaths("/repo")).toEqual([]);
	});

	it("returns [] instead of throwing when ONLY the untracked spawn throws", () => {
		spawn.mockImplementation((cmd: string, argv: string[]) => {
			if (argv.includes("ls-files")) {
				throw new Error("untracked boom");
			}
			return { status: 0, stdout: "crates/data/src/lib.rs\n", stderr: "" };
		});
		expect(() => touchedFilePaths("/repo")).not.toThrow();
		expect(touchedFilePaths("/repo")).toEqual([]);
	});
});

/* -------------------------------------------------------------------------- */
/* base-ref precedence — P1 / SCENARIO-002                                     */
/* -------------------------------------------------------------------------- */

describe("base-ref precedence (P1 / SCENARIO-002)", () => {
	const env = withBaseRefEnv();
	beforeEach(env.before);
	afterEach(env.after);

	it("defaults to --merge-base main when no arg and no env", () => {
		diffAndUntracked("", "");
		touchedFilePaths("/repo");
		const args = diffArgv();
		expect(args).toContain("--merge-base");
		expect(args).toContain("main");
	});

	it("reads SUPER_DEV_GATE_BASE_REF into --merge-base when no arg is given", () => {
		process.env[BASE_REF_ENV] = "develop";
		diffAndUntracked("", "");
		touchedFilePaths("/repo");
		const args = diffArgv();
		expect(args).toContain("develop");
		expect(args).not.toContain("main");
	});

	it("an explicit baseRef arg wins over the env var", () => {
		process.env[BASE_REF_ENV] = "develop";
		diffAndUntracked("", "");
		touchedFilePaths("/repo", "release-1.2");
		const args = diffArgv();
		expect(args).toContain("release-1.2");
		expect(args).not.toContain("develop");
		expect(args).not.toContain("main");
	});

	it("runs the diff git command in the given cwd via `-C <cwd>`", () => {
		diffAndUntracked("", "");
		touchedFilePaths("/work/repo");
		const args = diffArgv();
		expect(args?.[0]).toBe("-C");
		expect(args?.[1]).toBe("/work/repo");
	});

	it("the untracked-union spawn does NOT take a --merge-base flag", () => {
		// The untracked listing is against the working tree; the base ref does not
		// apply to it (must not be echoed into ls-files argv).
		diffAndUntracked("", "");
		touchedFilePaths("/repo", "release-1.2");
		const args = untrackedArgv();
		expect(args).not.toContain("--merge-base");
		expect(args).not.toContain("release-1.2");
	});
});

/* -------------------------------------------------------------------------- */
/* spawn shape: two bounded read-only git spawns — P1 / SCENARIO-020/023/037   */
/* -------------------------------------------------------------------------- */

describe("spawn shape: two read-only git spawns, discrete argv (P1 / SCENARIO-020/023/037/038)", () => {
	it("invokes git as discrete-argv spawnSync calls (named 'git', no shell)", () => {
		diffAndUntracked("crates/data/src/lib.rs\n", "");
		touchedFilePaths("/repo");
		expect(spawn.mock.calls).toHaveLength(2);
		for (const call of spawn.mock.calls) {
			const [cmd, , opts] = call as [string, string[], { shell?: boolean; encoding?: string }];
			expect(cmd).toBe("git");
			expect(opts?.shell).toBeFalsy();
			expect(opts?.encoding).toBe("utf8");
		}
	});

	it("the first spawn is the committed diff with the exact discrete argv", () => {
		diffAndUntracked("crates/api/x.rs\n", "");
		touchedFilePaths("/repo");
		const args = diffArgv();
		expect(args).toEqual([
			"-C",
			"/repo",
			"diff",
			"--merge-base",
			"main",
			"--name-only",
		]);
	});

	it("the second spawn is the untracked-files union with the exact discrete argv", () => {
		diffAndUntracked("crates/api/x.rs\n", "newfile.ts\n");
		touchedFilePaths("/repo");
		const args = untrackedArgv();
		expect(args).toEqual(["-C", "/repo", "ls-files", "--others", "--exclude-standard"]);
	});

	it("performs exactly TWO git spawns per call (no baseline-on-main run)", () => {
		// SCENARIO-023: full baseline-diff gating is NOT implemented; the only git
		// spawns are the committed `git diff --name-only` and the untracked
		// `git ls-files` union (SCENARIO-037/038). No diagnostic follow-up spawns.
		diffAndUntracked("crates/api/x.rs\ncrates/data/y.rs\n", "newfile.ts\n");
		touchedFilePaths("/repo");
		expect(spawn.mock.calls).toHaveLength(2);
	});

	it("still spawns exactly two git commands on a failed diff (no extra spawns)", () => {
		spawn.mockReturnValue({ status: 128, stdout: "", stderr: "fatal" });
		touchedFilePaths("/repo");
		expect(spawn.mock.calls).toHaveLength(2);
	});
});

/* -------------------------------------------------------------------------- */
/* raw union feeds the cargo refactor — P1 regression boundary                 */
/* -------------------------------------------------------------------------- */

describe("raw union is the cargo-refactor input (P1 regression boundary)", () => {
	it("touchedFilePaths returns the raw union the segment-mapper will consume", () => {
		// After the refactor detectTouchedCargoPackages maps CRATE_SEGMENT_RE over
		// touchedFilePaths(cwd, baseRef). Its observable crate-segment output for
		// crate paths must be byte-for-byte unchanged — that regression is covered
		// by the existing build-runner-touched-crates / autoscope / nonregression
		// suites (which stay green). This test only pins the raw input contract:
		// committed crate paths + untracked crate paths both survive verbatim and
		// in first-seen order, ready for the segment-mapper to collapse.
		diffAndUntracked(
			"crates/data/src/lib.rs\ncrates/api/src/main.rs\n",
			"crates/newcrate/src/lib.rs\n",
		);
		expect(touchedFilePaths("/repo")).toEqual([
			"crates/data/src/lib.rs",
			"crates/api/src/main.rs",
			"crates/newcrate/src/lib.rs",
		]);
	});

	it("a non-crate-only union returns those paths (segment-mapper yields [], raw does not)", () => {
		// The P1 distinction: detectTouchedCargoPackages would map this to [], but
		// touchedFilePaths returns the raw non-crate paths so Phase 5's npm
		// classifier has the full touched set to compare against.
		diffAndUntracked("package.json\nvitest.config.ts\n", "src/untouched.test.ts\n");
		expect(touchedFilePaths("/repo")).toEqual([
			"package.json",
			"vitest.config.ts",
			"src/untouched.test.ts",
		]);
	});
});
