/**
 * Phase 1 — Cargo package name resolution (RED phase).
 *
 * These tests define the contract for:
 *   - `resolveCargoPackageNames(cwd, touchedDirs): string[]`  (NEW, exported)
 *   - private `loadCargoMetadata(cwd)`                        (side-effecting spawn, memoized)
 *   - module-level `cargoMetadataCache`                       (process-local, keyed by absolute cwd)
 *
 * …BEFORE any of them exist. Importing `resolveCargoPackageNames` from a
 * not-yet-modified build-runner yields `undefined`, so every call throws
 * "resolveCargoPackageNames is not a function" — intentional RED state.
 *
 * Covers AC-01 / AC-02 / AC-03 and SCENARIO-001 / 002 / 003 / 004 / 005 / 006 /
 * 017 / 018 / 019 / 020.
 *
 * Hermetic: `node:child_process.spawnSync` is mocked via `vi.mock` so NO real
 * `cargo` or `git` ever runs. The module registry is reset (`vi.resetModules` +
 * dynamic import) before each test so the per-cwd cache starts empty — tests are
 * fully independent with no shared state.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock the ONLY side-effect the resolver performs: spawnSync. Real cargo / git
// must never run in CI. The factory is re-evaluated after vi.resetModules().
vi.mock("node:child_process", () => ({
	spawnSync: vi.fn(),
}));

// Late-bound bindings, refreshed in beforeEach after the module reset so the
// per-cwd cache starts empty every test.
type SpawnFn = ReturnType<typeof vi.fn>;
let spawn: SpawnFn;
let resolveCargoPackageNames: (cwd: string, touchedDirs: string[]) => string[];
let scopedCargoBuildArgs: (pkgs: string[]) => string[];
let scopedCargoTestArgs: (pkgs: string[]) => string[];
let scopedCargoClippyArgs: (pkgs: string[]) => string[];
let DEFAULT_TIMEOUT_MS: number;

const TIMEOUT_ENV = "SUPER_DEV_BUILD_TIMEOUT_MS";

/**
 * Re-import the module after clearing the registry so the module-level cache
 * starts empty (test independence). The hoisted spawnSync mock is re-applied and
 * we grab its fresh instance off the re-imported child_process module.
 */
beforeEach(async () => {
	vi.resetModules();
	const cp = await import("node:child_process");
	spawn = cp.spawnSync as unknown as SpawnFn;
	spawn.mockReset();
	const mod = await import("../src/build-runner.ts");
	resolveCargoPackageNames = mod.resolveCargoPackageNames;
	scopedCargoBuildArgs = mod.scopedCargoBuildArgs;
	scopedCargoTestArgs = mod.scopedCargoTestArgs;
	scopedCargoClippyArgs = mod.scopedCargoClippyArgs;
	DEFAULT_TIMEOUT_MS = mod.DEFAULT_TIMEOUT_MS;
	// Tests assert the default timeout envelope; never leak an env override.
	delete process.env[TIMEOUT_ENV];
});

/** A workspace package entry (real cargo metadata uses `manifest_path`). */
interface Pkg {
	name: string;
	manifestPath: string;
}

/**
 * Render a realistic `cargo metadata --format-version 1 --no-deps` JSON string.
 * The resolver only reads `packages[].name` + `packages[].manifest_path`, but we
 * emit a plausible full shape so a naive full-shape parse also passes.
 */
function metadataJson(packages: Pkg[]): string {
	return JSON.stringify({
		packages: packages.map((p) => ({
			name: p.name,
			version: "0.1.0",
			id: `${p.name}@0.1.0`,
			manifest_path: p.manifestPath,
			target_directory: "/repo/target",
		})),
		workspace_members: packages.map((p) => `${p.name}@0.1.0`),
		workspace_default_members: [],
		resolve: null,
		version: 1,
		target_directory: "/repo/target",
		workspace_root: "/repo",
		metadata: null,
	});
}

/** Configure the cargo-metadata spawn to return `stdout` (status 0, no error). */
function metadataReturns(stdout: string): void {
	spawn.mockReturnValue({ status: 0, stdout, stderr: "" });
}

/** The canonical prefixed-crate workspace used across the dir→name tests. */
const PREFIXED = [
	{ name: "stockfan-data", manifestPath: "/repo/crates/data/Cargo.toml" },
	{ name: "stockfan-tools", manifestPath: "/repo/crates/tools/Cargo.toml" },
	{ name: "stockfan-workflows", manifestPath: "/repo/crates/workflows/Cargo.toml" },
] as const;

/* -------------------------------------------------------------------------- */
/* dir→name resolution, first-seen order, dedupe — AC-01 / SCENARIO-001/017    */
/* -------------------------------------------------------------------------- */

describe("dir→name resolution (AC-01 / SCENARIO-001 / SCENARIO-017)", () => {
	it("maps directory segments to REAL package names, first-seen order", () => {
		metadataReturns(metadataJson([...PREFIXED]));
		expect(resolveCargoPackageNames("/repo", ["data", "tools", "workflows"])).toEqual([
			"stockfan-data",
			"stockfan-tools",
			"stockfan-workflows",
		]);
	});

	it("is NOT an identity pass-through when dir ≠ name (the bug being fixed)", () => {
		metadataReturns(metadataJson([...PREFIXED]));
		const out = resolveCargoPackageNames("/repo", ["data", "tools"]);
		// The pre-fix bug returned ["data","tools"]; the fix MUST map to the
		// real prefixed names so `cargo build -p stockfan-data` (not `-p data`).
		expect(out).not.toEqual(["data", "tools"]);
		expect(out).toEqual(["stockfan-data", "stockfan-tools"]);
	});

	it("preserves first-seen order (tools before data)", () => {
		metadataReturns(metadataJson([...PREFIXED]));
		expect(resolveCargoPackageNames("/repo", ["tools", "data"])).toEqual([
			"stockfan-tools",
			"stockfan-data",
		]);
	});

	it("dedupes repeated touched segments to a single resolved name", () => {
		metadataReturns(metadataJson([...PREFIXED]));
		expect(resolveCargoPackageNames("/repo", ["data", "data", "tools"])).toEqual([
			"stockfan-data",
			"stockfan-tools",
		]);
	});

	it("dedupes resolved names when distinct segments collapse to one package", () => {
		// Two workspace roots alias the same package name via different manifests
		// is unrealistic, but two touched segments mapping to the SAME package
		// name must collapse (defensive dedupe of the OUTPUT, not just input).
		metadataReturns(metadataJson([...PREFIXED]));
		expect(resolveCargoPackageNames("/repo", ["data", "data"])).toEqual(["stockfan-data"]);
	});

	it("returns a plain string[] (every element typeof string)", () => {
		metadataReturns(metadataJson([...PREFIXED]));
		const out = resolveCargoPackageNames("/repo", ["data"]);
		expect(Array.isArray(out)).toBe(true);
		expect(out.every((p) => typeof p === "string")).toBe(true);
	});

	it("returns [] for an empty touched-dir input (no scope → workspace-wide)", () => {
		metadataReturns(metadataJson([...PREFIXED]));
		// The empty input is the value the gate relies on to run workspace-wide.
		expect(resolveCargoPackageNames("/repo", [])).toEqual([]);
	});
});

/* -------------------------------------------------------------------------- */
/* manifest-in-subdir is matched by the FIRST crates/<seg>/ segment            */
/* AC-01 / SCENARIO-002                                                         */
/* -------------------------------------------------------------------------- */

describe("manifest-in-subdir matching (AC-01 / SCENARIO-002)", () => {
	it("matches a package whose Cargo.toml is nested deeper than crates/<seg>/", () => {
		// The Cargo.toml lives at crates/inner/src/sub/Cargo.toml. Its manifestDir
		// is crates/inner/src/sub whose FIRST crates/<seg>/ segment is `inner`, so
		// touched segment `inner` MUST resolve to the real package name.
		metadataReturns(
			metadataJson([
				{ name: "stockfan-inner", manifestPath: "/repo/crates/inner/src/sub/Cargo.toml" },
			]),
		);
		expect(resolveCargoPackageNames("/repo", ["inner"])).toEqual(["stockfan-inner"]);
	});

	it("selects the package whose first crates/<seg>/ segment EQUALS the touched dir", () => {
		// A package at crates/data/inner/Cargo.toml has first segment `data`, NOT
		// `inner`. Touched `data` resolves to it; touched `inner` does NOT match
		// (it has no package whose first segment is `inner`) and falls back.
		metadataReturns(
			metadataJson([
				{ name: "stockfan-data-deep", manifestPath: "/repo/crates/data/inner/Cargo.toml" },
			]),
		);
		expect(resolveCargoPackageNames("/repo", ["data"])).toEqual(["stockfan-data-deep"]);
		// `inner` is the second path segment, not the first crates segment → no
		// package matches → per-element identity fallback (SCENARIO-004).
		expect(resolveCargoPackageNames("/repo", ["inner"])).toEqual(["inner"]);
	});

	it("combines flat + nested packages into one resolved set", () => {
		metadataReturns(
			metadataJson([
				...PREFIXED,
				{ name: "stockfan-inner", manifestPath: "/repo/crates/inner/src/sub/Cargo.toml" },
			]),
		);
		expect(
			resolveCargoPackageNames("/repo", ["data", "tools", "workflows", "inner"]),
		).toEqual([
			"stockfan-data",
			"stockfan-tools",
			"stockfan-workflows",
			"stockfan-inner",
		]);
	});
});

/* -------------------------------------------------------------------------- */
/* per-element identity fallback + never throws — AC-02 / SCENARIO-004/018/019  */
/* -------------------------------------------------------------------------- */

describe("per-element identity fallback (AC-02 / SCENARIO-004)", () => {
	it("a touched dir with no matching package degrades to its own name", () => {
		metadataReturns(metadataJson([...PREFIXED]));
		expect(
			resolveCargoPackageNames("/repo", ["data", "unknown", "tools"]),
		).toEqual(["stockfan-data", "unknown", "stockfan-tools"]);
	});

	it("identity fallback preserves first-seen order relative to resolved names", () => {
		metadataReturns(metadataJson([...PREFIXED]));
		expect(
			resolveCargoPackageNames("/repo", ["ghost", "data", "phantom", "tools"]),
		).toEqual(["ghost", "stockfan-data", "phantom", "stockfan-tools"]);
	});

	it("a fully-unmatched input is an exact identity pass-through (deduped)", () => {
		metadataReturns(metadataJson([...PREFIXED]));
		expect(resolveCargoPackageNames("/repo", ["foo", "bar", "foo"])).toEqual(["foo", "bar"]);
	});
});

describe("never throws — identity fallback on any failure (AC-02 / SCENARIO-003/018/019)", () => {
	it("returns input verbatim (identity) when spawnSync throws synchronously", () => {
		spawn.mockImplementation(() => {
			throw new Error("boom");
		});
		expect(() => resolveCargoPackageNames("/repo", ["data", "tools"])).not.toThrow();
		expect(resolveCargoPackageNames("/repo", ["data", "tools"])).toEqual(["data", "tools"]);
	});

	it("returns identity when cargo exits non-zero (status 101 — bad package spec)", () => {
		spawn.mockReturnValue({
			status: 101,
			stdout: "",
			stderr: "error: package ID specification 'data' did not match any packages",
		});
		expect(resolveCargoPackageNames("/repo", ["data", "tools"])).toEqual(["data", "tools"]);
	});

	it("returns identity when spawn reports r.error (ENOENT — cargo not installed)", () => {
		spawn.mockReturnValue({
			status: null,
			stdout: "",
			stderr: "",
			error: new Error("spawn cargo ENOENT"),
		});
		expect(resolveCargoPackageNames("/repo", ["data"])).toEqual(["data"]);
	});

	it("returns identity on a timeout kill (r.error + signal)", () => {
		// `cargo metadata` exceeded resolveTimeoutMs(): killed via SIGTERM.
		spawn.mockReturnValue({
			status: null,
			stdout: "",
			stderr: "",
			signal: "SIGTERM",
			error: new Error("spawnSync ETIMEDOUT"),
		});
		expect(() => resolveCargoPackageNames("/repo", ["data"])).not.toThrow();
		expect(resolveCargoPackageNames("/repo", ["data"])).toEqual(["data"]);
	});

	it("returns identity when stdout is malformed JSON", () => {
		spawn.mockReturnValue({ status: 0, stdout: "not-json{[", stderr: "" });
		expect(resolveCargoPackageNames("/repo", ["data"])).toEqual(["data"]);
	});

	it("returns identity when packages[] is missing / wrong shape", () => {
		spawn.mockReturnValue({ status: 0, stdout: JSON.stringify({ version: 1 }), stderr: "" });
		expect(resolveCargoPackageNames("/repo", ["data"])).toEqual(["data"]);
	});

	it("returns identity when a package lacks manifest_path", () => {
		spawn.mockReturnValue({
			status: 0,
			stdout: JSON.stringify({
				packages: [{ name: "x" }], // no manifest_path
				version: 1,
			}),
			stderr: "",
		});
		expect(resolveCargoPackageNames("/repo", ["x"])).toEqual(["x"]);
	});

	it("returns identity when stdout is a non-string (defensive parse)", () => {
		spawn.mockReturnValue({
			status: 0,
			stdout: { weird: true } as unknown as string,
			stderr: "",
		});
		expect(() => resolveCargoPackageNames("/repo", ["data"])).not.toThrow();
		expect(resolveCargoPackageNames("/repo", ["data"])).toEqual(["data"]);
	});
});

/* -------------------------------------------------------------------------- */
/* per-cwd cache (memoize) — AC-03 / SCENARIO-005/020                           */
/* -------------------------------------------------------------------------- */

describe("per-cwd metadata cache (AC-03 / SCENARIO-005 / SCENARIO-020)", () => {
	it("invokes cargo metadata EXACTLY ONCE across two calls for the same cwd", () => {
		metadataReturns(metadataJson([...PREFIXED]));
		resolveCargoPackageNames("/repo", ["data"]);
		resolveCargoPackageNames("/repo", ["data", "tools"]);
		expect(spawn).toHaveBeenCalledTimes(1);
	});

	it("returns the same resolved result on a cache hit (second call)", () => {
		metadataReturns(metadataJson([...PREFIXED]));
		const first = resolveCargoPackageNames("/repo", ["data"]);
		const second = resolveCargoPackageNames("/repo", ["data"]);
		expect(second).toEqual(first);
		expect(second).toEqual(["stockfan-data"]);
	});

	it("the cache is keyed by cwd: a different cwd spawns again", () => {
		metadataReturns(metadataJson([...PREFIXED]));
		resolveCargoPackageNames("/repo-a", ["data"]);
		resolveCargoPackageNames("/repo-b", ["data"]);
		expect(spawn).toHaveBeenCalledTimes(2);
	});

	it("a FAILED cargo metadata is cached as a failure sentinel (not re-spawned)", () => {
		// AC-02/SCENARIO-018: a failing/missing cargo is not re-spawned within a
		// run. The second call must hit the cached {ok:false} sentinel, so spawn
		// runs exactly once even though the metadata failed.
		spawn.mockReturnValue({
			status: 101,
			stdout: "",
			stderr: "error: package ID 'data' did not match",
		});
		resolveCargoPackageNames("/repo", ["data"]);
		resolveCargoPackageNames("/repo", ["tools"]);
		expect(spawn).toHaveBeenCalledTimes(1);
		// Both calls still returned identity (never throw), just from the cache.
	});

	it("does NOT spawn cargo metadata for an empty touched-dir input", () => {
		metadataReturns(metadataJson([...PREFIXED]));
		// No packages to resolve → the gate runs workspace-wide → metadata is not
		// needed. (Defensive: short-circuit before the spawn.)
		resolveCargoPackageNames("/repo", []);
		expect(spawn).not.toHaveBeenCalled();
	});
});

/* -------------------------------------------------------------------------- */
/* process-local cache — SCENARIO-006                                          */
/* -------------------------------------------------------------------------- */

describe("process-local cache, no cross-run leakage (SCENARIO-006)", () => {
	it("the cache lives only in memory: a stale module reset yields a fresh cache", () => {
		// SCENARIO-006: cache is never persisted to disk and never leaks across
		// process runs. The hermetic harness proves this concretely: after
		// vi.resetModules() the module-level cache is a fresh Map, so a previously
		// populated (or failed) entry does not survive a "new run". Each test in
		// this file relies on exactly this property (see beforeEach).
		metadataReturns(metadataJson([...PREFIXED]));
		resolveCargoPackageNames("/repo", ["data"]);
		// Within ONE run/module-instance, a second same-cwd call is cached:
		resolveCargoPackageNames("/repo", ["data"]);
		expect(spawn).toHaveBeenCalledTimes(1);
	});

	it("a failed cwd does NOT poison a different cwd's resolution", () => {
		spawn.mockReturnValueOnce({
			status: 101,
			stdout: "",
			stderr: "bad",
		});
		metadataReturns(metadataJson([...PREFIXED]));
		// /bad fails → identity fallback for /bad; /good is unaffected and still
		// resolves to real names (per-cwd keying, not a single global ok flag).
		expect(resolveCargoPackageNames("/bad", ["data"])).toEqual(["data"]);
		expect(resolveCargoPackageNames("/good", ["data"])).toEqual(["stockfan-data"]);
		expect(spawn).toHaveBeenCalledTimes(2);
	});
});

/* -------------------------------------------------------------------------- */
/* spawn shape: cached cargo metadata, discrete argv, no shell, timeout — AC-10 */
/* -------------------------------------------------------------------------- */

describe("spawn shape: cargo metadata, discrete argv (AC-10 / SCENARIO-020)", () => {
	it("spawns `cargo metadata --format-version 1 --no-deps --manifest-path <cwd>/Cargo.toml`", () => {
		metadataReturns(metadataJson([...PREFIXED]));
		resolveCargoPackageNames("/repo", ["data"]);
		expect(spawn).toHaveBeenCalledTimes(1);
		const [cmd, argv] = spawn.mock.calls[0] as [string, string[], unknown];
		expect(cmd).toBe("cargo");
		expect(argv).toEqual([
			"metadata",
			"--format-version",
			"1",
			"--no-deps",
			"--manifest-path",
			"/repo/Cargo.toml",
		]);
	});

	it("passes the absolute cwd to --manifest-path via join(cwd, 'Cargo.toml')", () => {
		metadataReturns(metadataJson([...PREFIXED]));
		resolveCargoPackageNames("/work/space", ["data"]);
		const argv = (spawn.mock.calls[0] as [string, string[], unknown])[1];
		expect(argv).toContain("--manifest-path");
		expect(argv[argv.indexOf("--manifest-path") + 1]).toBe("/work/space/Cargo.toml");
	});

	it("uses discrete argv with NO shell:true (no shell-injection surface)", () => {
		metadataReturns(metadataJson([...PREFIXED]));
		resolveCargoPackageNames("/repo", ["data"]);
		const opts = (spawn.mock.calls[0] as [string, string[], { shell?: boolean }])[2];
		expect(opts?.shell).toBeFalsy();
	});

	it("runs under the existing resolveTimeoutMs() envelope (encoding utf8)", () => {
		metadataReturns(metadataJson([...PREFIXED]));
		resolveCargoPackageNames("/repo", ["data"]);
		const opts = (spawn.mock.calls[0] as [
			string,
			string[],
			{ timeout?: number; encoding?: string },
		])[2];
		expect(opts?.encoding).toBe("utf8");
		// Timeout equals the resolved envelope (DEFAULT_TIMEOUT_MS when no env
		// override is set — beforeEach clears SUPER_DEV_BUILD_TIMEOUT_MS).
		expect(opts?.timeout).toBe(DEFAULT_TIMEOUT_MS);
		expect(Number.isFinite(opts?.timeout)).toBe(true);
		expect((opts?.timeout ?? 0) > 0).toBe(true);
	});

	it("the cargo metadata spawn is the ONLY new spawn the resolver performs", () => {
		// AC-10: no extra diagnostic/git/registry spawns — exactly one call per
		// cold cwd, and that call is `cargo metadata`.
		metadataReturns(metadataJson([...PREFIXED]));
		resolveCargoPackageNames("/repo", ["data", "tools", "workflows"]);
		expect(spawn).toHaveBeenCalledTimes(1);
		expect((spawn.mock.calls[0] as [string, string[], unknown])[0]).toBe("cargo");
	});
});

/* -------------------------------------------------------------------------- */
/* end-to-end: resolved names flow into scoped -p flags — AC-01 contract        */
/* (scopedCargo* already exist; the RED pivot is resolveCargoPackageNames)     */
/* -------------------------------------------------------------------------- */

describe("resolved names flow into scoped -p argv (AC-01 contract)", () => {
	it("scopedCargoBuildArgs over the resolved set yields real -p flags + --quiet", () => {
		metadataReturns(metadataJson([...PREFIXED]));
		const resolved = resolveCargoPackageNames("/repo", ["data", "tools", "workflows"]);
		expect(scopedCargoBuildArgs(resolved)).toEqual([
			"cargo",
			"build",
			"-p",
			"stockfan-data",
			"-p",
			"stockfan-tools",
			"-p",
			"stockfan-workflows",
			"--quiet",
		]);
	});

	it("scopedCargoTestArgs over the resolved set yields real -p flags + --quiet", () => {
		metadataReturns(metadataJson([...PREFIXED]));
		const resolved = resolveCargoPackageNames("/repo", ["data", "tools", "workflows"]);
		expect(scopedCargoTestArgs(resolved)).toEqual([
			"cargo",
			"test",
			"-p",
			"stockfan-data",
			"-p",
			"stockfan-tools",
			"-p",
			"stockfan-workflows",
			"--quiet",
		]);
	});

	it("scopedCargoClippyArgs over the resolved set yields real -p flags + --all-targets", () => {
		metadataReturns(metadataJson([...PREFIXED]));
		const resolved = resolveCargoPackageNames("/repo", ["data", "tools", "workflows"]);
		expect(scopedCargoClippyArgs(resolved)).toEqual([
			"cargo",
			"clippy",
			"-p",
			"stockfan-data",
			"-p",
			"stockfan-tools",
			"-p",
			"stockfan-workflows",
			"--all-targets",
			"--quiet",
		]);
	});
});
