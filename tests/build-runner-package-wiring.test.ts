/**
 * Wiring: git diff → touched directory SEGMENTS → REAL cargo package names
 * → scoped cargo argv (spec-08 Layer C separation contract).
 *
 * spec-07 originally resolved names INSIDE `detectTouchedCargoPackages`. spec-08
 * REVERSES that separation to remove the identity fallbacks that crashed the
 * stockfan gate (`-p data`): `detectTouchedCargoPackages` is now a PURE git
 * extraction that returns raw `crates/<seg>/` directory segments and NEVER
 * spawns `cargo metadata`; resolution to REAL package names is a SEPARATE step
 * (`resolveCargoPackageNames`) invoked by `runBuildGate` (or composed at the
 * call site). The identity fallbacks are GONE: unknown dirs are DROPPED and a
 * metadata failure yields `[]` (the gate widens safely to workspace-wide).
 *
 * This file asserts that SEPARATED wiring end-to-end: detection yields raw
 * segments + no cargo spawn; the resolver, fed those segments, yields the real
 * prefixed package names; and the scoped argv builders driven through the
 * composed chain `scopedCargo*(resolveCargoPackageNames(cwd, detect(cwd)))`
 * emit `-p stockfan-*` (never the rejected `-p data`).
 *
 * Covers AC-04 / AC-05 / AC-10 and SCENARIO-007 / 008 / 009 / 014 / 021 / 022
 * (resolution-side coverage; segment-extraction coverage lives in
 * build-runner-touched-crates.test.ts and never-throw/drop contract in
 * build-runner-resolver-validation.test.ts).
 *
 * Hermetic: `node:child_process.spawnSync` is mocked via `vi.mock` so NO real
 * `cargo` or `git` ever runs. The mock branches on the spawned binary name
 * (`"git"` vs `"cargo"`) so both the git-diff spawn AND the cached cargo-metadata
 * spawn are supplied synthetic output. The module registry is reset
 * (`vi.resetModules` + dynamic import) before each test so the per-cwd metadata
 * cache starts empty — tests are fully independent with no shared state.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock the ONLY side-effect the wiring path performs: spawnSync. Real cargo /
// git must never run in CI. The factory is re-evaluated after vi.resetModules().
vi.mock("node:child_process", () => ({
	spawnSync: vi.fn(),
}));

// Late-bound bindings, refreshed in beforeEach after the module reset so the
// per-cwd cache starts empty every test.
type SpawnFn = ReturnType<typeof vi.fn>;
let spawn: SpawnFn;
let detectTouchedCargoPackages: (cwd: string, baseRef?: string) => string[];
let resolveCargoPackageNames: (cwd: string, touchedDirs: string[]) => string[];
let scopedCargoBuildArgs: (pkgs: string[]) => string[];
let scopedCargoTestArgs: (pkgs: string[]) => string[];
let scopedCargoClippyArgs: (pkgs: string[]) => string[];
const BASE_REF_ENV = "SUPER_DEV_GATE_BASE_REF";

/**
 * Re-import the module after clearing the registry so the module-level metadata
 * cache starts empty (test independence). The hoisted spawnSync mock is
 * re-applied and we grab its fresh instance off the re-imported child_process.
 */
beforeEach(async () => {
	vi.resetModules();
	const cp = await import("node:child_process");
	spawn = cp.spawnSync as unknown as SpawnFn;
	spawn.mockReset();
	const mod = await import("../src/build-runner.ts");
	detectTouchedCargoPackages = mod.detectTouchedCargoPackages;
	resolveCargoPackageNames = mod.resolveCargoPackageNames;
	scopedCargoBuildArgs = mod.scopedCargoBuildArgs;
	scopedCargoTestArgs = mod.scopedCargoTestArgs;
	scopedCargoClippyArgs = mod.scopedCargoClippyArgs;
	// detectTouchedCargoPackages reads base-ref precedence from the env; never
	// leak an override between tests.
	delete process.env[BASE_REF_ENV];
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

/** The canonical prefixed-crate workspace (dir ≠ name) used across tests. */
const PREFIXED = [
	{ name: "stockfan-data", manifestPath: "/repo/crates/data/Cargo.toml" },
	{ name: "stockfan-tools", manifestPath: "/repo/crates/tools/Cargo.toml" },
	{ name: "stockfan-workflows", manifestPath: "/repo/crates/workflows/Cargo.toml" },
] as const;

/**
 * Configure the spawn mock to serve a git-diff `stdout` for git calls and a
 * cargo-metadata JSON (status 0) for cargo calls. The same single mock handles
 * BOTH spawned binaries so the wiring path runs end-to-end hermetically.
 */
function setupWorkspace(diff: string, packages: Pkg[] = [...PREFIXED]): void {
	spawn.mockImplementation((bin: string) => {
		if (bin === "git") return { status: 0, stdout: diff, stderr: "" };
		if (bin === "cargo") return { status: 0, stdout: metadataJson(packages), stderr: "" };
		return { status: 0, stdout: "", stderr: "" };
	});
}

/** Configure the spawn mock so cargo calls FAIL (non-zero exit) while git works. */
function setupCargoFailure(diff: string, cargoResult: { status: number; stdout: string; stderr: string }): void {
	spawn.mockImplementation((bin: string) => {
		if (bin === "git") return { status: 0, stdout: diff, stderr: "" };
		if (bin === "cargo") return cargoResult;
		return { status: 0, stdout: "", stderr: "" };
	});
}

/** Count cargo-metadata spawns recorded by the mock (argv[0] === "cargo"). */
function cargoSpawnCount(): number {
	return spawn.mock.calls.filter((c) => c[0] === "cargo").length;
}

/* -------------------------------------------------------------------------- */
/* detectTouchedCargoPackages is a PURE git extraction (segments, no cargo)    */
/* AC-04 / SCENARIO-020 / SCENARIO-021                                         */
/* -------------------------------------------------------------------------- */

describe("detectTouchedCargoPackages returns raw directory segments (AC-04 / SCENARIO-020/021)", () => {
	it("returns the deduped `crates/<seg>/` segments, NOT resolved names", () => {
		setupWorkspace("crates/data/src/lib.rs\ncrates/tools/src/main.rs\ncrates/workflows/src/lib.rs");
		// Pure git extraction: segments flow out UNCHANGED — resolution is a
		// separate step, so detection never emits a package name.
		expect(detectTouchedCargoPackages("/repo")).toEqual([
			"data",
			"tools",
			"workflows",
		]);
	});

	it("does NOT resolve to package names when dir ≠ name (resolution is separate)", () => {
		setupWorkspace("crates/data/src/lib.rs\ncrates/tools/src/main.rs");
		const out = detectTouchedCargoPackages("/repo");
		expect(out).not.toContain("stockfan-data");
		expect(out).not.toContain("stockfan-tools");
		expect(out).toEqual(["data", "tools"]);
	});

	it("preserves first-seen order of segments (tools before data)", () => {
		setupWorkspace("crates/tools/src/main.rs\ncrates/data/src/lib.rs");
		expect(detectTouchedCargoPackages("/repo")).toEqual(["tools", "data"]);
	});

	it("dedupes repeated touched directories to a single segment", () => {
		setupWorkspace("crates/data/src/lib.rs\ncrates/data/src/util.rs");
		expect(detectTouchedCargoPackages("/repo")).toEqual(["data"]);
	});

	it("NEVER spawns `cargo metadata` (resolution is deferred to runBuildGate)", () => {
		setupWorkspace("crates/data/src/lib.rs");
		detectTouchedCargoPackages("/repo");
		expect(cargoSpawnCount()).toBe(0);
	});

	it("an unmatched segment (ghost) is still returned — dropping is the resolver's job", () => {
		// Detection must surface every touched segment; `ghost` is DROPPED later
		// by resolveCargoPackageNames (SCENARIO-005), not silently dropped here.
		setupWorkspace("crates/data/src/lib.rs\ncrates/ghost/src/lib.rs", [
			{ name: "stockfan-data", manifestPath: "/repo/crates/data/Cargo.toml" },
		]);
		expect(detectTouchedCargoPackages("/repo")).toEqual(["data", "ghost"]);
		expect(cargoSpawnCount()).toBe(0);
	});
});

/* -------------------------------------------------------------------------- */
/* resolveCargoPackageNames maps detected segments → REAL names (the wiring)    */
/* AC-04 / SCENARIO-007 / SCENARIO-005 (drop) / SCENARIO-006 (metadata fail)    */
/* -------------------------------------------------------------------------- */

describe("resolveCargoPackageNames maps segments to REAL package names (AC-04 / SCENARIO-007)", () => {
	it("maps touched directory segments to REAL cargo package names", () => {
		setupWorkspace("crates/data/src/lib.rs\ncrates/tools/src/main.rs\ncrates/workflows/src/lib.rs");
		expect(resolveCargoPackageNames("/repo", ["data", "tools", "workflows"])).toEqual([
			"stockfan-data",
			"stockfan-tools",
			"stockfan-workflows",
		]);
	});

	it("is NOT an identity pass-through when dir ≠ name (the bug being fixed)", () => {
		setupWorkspace("crates/data/src/lib.rs\ncrates/tools/src/main.rs");
		const out = resolveCargoPackageNames("/repo", ["data", "tools"]);
		// The pre-fix bug resolved dir==name / identity-fell-back to ["data","tools"];
		// the resolver MUST map to real prefixed names so `cargo build -p stockfan-data`.
		expect(out).not.toEqual(["data", "tools"]);
		expect(out).toEqual(["stockfan-data", "stockfan-tools"]);
	});

	it("preserves first-seen order through resolution (tools before data)", () => {
		setupWorkspace("crates/tools/src/main.rs\ncrates/data/src/lib.rs");
		expect(resolveCargoPackageNames("/repo", ["tools", "data"])).toEqual([
			"stockfan-tools",
			"stockfan-data",
		]);
	});

	it("resolves `crates/workflows/tests/e2e_*.rs` segment to `stockfan-workflows`", () => {
		// The detection regex captures `workflows` from
		// `crates/workflows/tests/e2e_smoke.rs`; the resolver then maps it.
		setupWorkspace("crates/workflows/tests/e2e_smoke.rs");
		expect(resolveCargoPackageNames("/repo", ["workflows"])).toEqual(["stockfan-workflows"]);
	});

	it("includes the e2e crate alongside lib crates in a mixed set", () => {
		setupWorkspace(
			"crates/data/src/lib.rs\ncrates/workflows/tests/e2e_smoke.rs\ncrates/tools/src/main.rs",
		);
		expect(resolveCargoPackageNames("/repo", ["data", "workflows", "tools"])).toEqual([
			"stockfan-data",
			"stockfan-workflows",
			"stockfan-tools",
		]);
	});

	it("DROPS an unmatched segment (ghost) instead of identity-falling-back (SCENARIO-005)", () => {
		setupWorkspace("crates/data/src/lib.rs\ncrates/ghost/src/lib.rs", [
			{ name: "stockfan-data", manifestPath: "/repo/crates/data/Cargo.toml" },
		]);
		// `ghost` has NO matching package → DROPPED (never emitted as a raw name).
		expect(resolveCargoPackageNames("/repo", ["data", "ghost"])).toEqual(["stockfan-data"]);
	});
});

/* -------------------------------------------------------------------------- */
/* end-to-end: detected segments → resolve → scoped argv yields real names     */
/* AC-04 / SCENARIO-007 / SCENARIO-008 / SCENARIO-022                          */
/* -------------------------------------------------------------------------- */

describe("end-to-end scoped argv via resolve(detect(cwd)) (AC-04 / SCENARIO-007/008/022)", () => {
	// A diff touching all three prefixed crates — fed through detection +
	// resolution, then into the UNCHANGED scopedCargo* builders.
	const ALL_THREE_DIFF =
		"crates/data/src/lib.rs\ncrates/tools/src/main.rs\ncrates/workflows/tests/e2e_smoke.rs";

	it("scopedCargoBuildArgs yields `cargo build -p <real>... --quiet`", () => {
		setupWorkspace(ALL_THREE_DIFF);
		const argv = scopedCargoBuildArgs(
			resolveCargoPackageNames("/repo", detectTouchedCargoPackages("/repo")),
		);
		expect(argv).toEqual([
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
		// The pre-fix bug would emit `-p data -p tools -p workflows` here; cargo
		// rejects those as unknown package IDs (exit 101). Assert the bug is gone.
		expect(argv).not.toContain("data");
		expect(argv).not.toContain("tools");
		expect(argv).not.toContain("workflows");
	});

	it("scopedCargoTestArgs yields `cargo test -p <real>... --quiet`", () => {
		setupWorkspace(ALL_THREE_DIFF);
		expect(
			scopedCargoTestArgs(resolveCargoPackageNames("/repo", detectTouchedCargoPackages("/repo"))),
		).toEqual([
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

	it("scopedCargoClippyArgs yields `cargo clippy -p <real>... --all-targets --quiet`", () => {
		setupWorkspace(ALL_THREE_DIFF);
		expect(
			scopedCargoClippyArgs(resolveCargoPackageNames("/repo", detectTouchedCargoPackages("/repo"))),
		).toEqual([
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

/* -------------------------------------------------------------------------- */
/* cargo metadata spawn contract (the resolver is the ONLY new spawn)          */
/* AC-10 / SCENARIO-014 / SCENARIO-007b (cached)                               */
/* -------------------------------------------------------------------------- */

describe("cargo metadata spawn contract (AC-10 / SCENARIO-014)", () => {
	it("resolveCargoPackageNames spawns `cargo metadata` as discrete argv with --no-deps + workspace manifest", () => {
		setupWorkspace("crates/data/src/lib.rs");
		resolveCargoPackageNames("/repo", ["data"]);
		// The ONLY new spawned process in build-runner.ts is this one. It must be
		// discrete-argv (no shell:true) with the workspace-root Cargo.toml.
		const cargoCalls = spawn.mock.calls.filter((c) => c[0] === "cargo");
		expect(cargoCalls).toHaveLength(1);
		const cargoArgv = cargoCalls[0][1] as string[];
		expect(cargoArgv[0]).toBe("metadata");
		expect(cargoArgv).toContain("--format-version");
		expect(cargoArgv).toContain("1");
		expect(cargoArgv).toContain("--no-deps");
		const manifestIdx = cargoArgv.indexOf("--manifest-path");
		expect(manifestIdx).toBeGreaterThan(-1);
		// Points at the workspace-root manifest (cwd/Cargo.toml), not a subcrate.
		expect(cargoArgv[manifestIdx + 1]).toBe("/repo/Cargo.toml");
	});

	it("resolveCargoPackageNames spawns `cargo metadata` EXACTLY ONCE per cwd across repeats (cache)", () => {
		setupWorkspace("crates/data/src/lib.rs");
		// Two resolution passes for the same cwd must hit the per-cwd cache once
		// and reuse it — never re-spawn cargo within a single run (SCENARIO-007b).
		resolveCargoPackageNames("/repo", ["data"]);
		resolveCargoPackageNames("/repo", ["data"]);
		expect(cargoSpawnCount()).toBe(1);
	});
});

/* -------------------------------------------------------------------------- */
/* failure: metadata failure → resolver returns [] (NO identity); detect still  */
/* returns segments. The gate widens safely to workspace-wide.                  */
/* AC-02 / SCENARIO-006 / SCENARIO-018 / SCENARIO-019                          */
/* -------------------------------------------------------------------------- */

describe("failure: resolver returns [] on metadata failure, detect returns segments (AC-02 / SCENARIO-006)", () => {
	it("resolveCargoPackageNames returns [] when `cargo metadata` exits non-zero (NO identity fallback)", () => {
		// cargo rejects / is missing → resolver DROPS everything ([]), so the gate
		// widens to workspace-wide. It must NOT identity-fall-back to dir names.
		setupCargoFailure("crates/data/src/lib.rs\ncrates/tools/src/main.rs", {
			status: 101,
			stdout: "",
			stderr: "error: could not find Cargo.toml",
		});
		expect(resolveCargoPackageNames("/repo", ["data", "tools"])).toEqual([]);
		// AND cargo was actually attempted (the resolver invoked metadata) — this
		// distinguishes the [] widening from a never-spawned short-circuit.
		expect(cargoSpawnCount()).toBeGreaterThanOrEqual(1);
	});

	it("resolveCargoPackageNames returns [] when `cargo metadata` throws (NO identity fallback)", () => {
		setupWorkspace("crates/data/src/lib.rs");
		// Override only the cargo branch to throw synchronously.
		spawn.mockImplementation((bin: string) => {
			if (bin === "git") return { status: 0, stdout: "crates/data/src/lib.rs", stderr: "" };
			if (bin === "cargo") throw new Error("spawn cargo ENOENT");
			return { status: 0, stdout: "", stderr: "" };
		});
		expect(() => resolveCargoPackageNames("/repo", ["data"])).not.toThrow();
		expect(resolveCargoPackageNames("/repo", ["data"])).toEqual([]);
		// AND cargo was actually attempted (the resolver invoked metadata).
		expect(cargoSpawnCount()).toBeGreaterThanOrEqual(1);
	});

	it("detectTouchedCargoPackages is unaffected by a cargo failure (returns segments, never throws)", () => {
		// Detection never touches cargo, so a failing `cargo metadata` cannot
		// corrupt the detected segments — they remain the git-extracted set.
		setupCargoFailure("crates/data/src/lib.rs\ncrates/tools/src/main.rs", {
			status: 101,
			stdout: "",
			stderr: "error: could not find Cargo.toml",
		});
		expect(() => detectTouchedCargoPackages("/repo")).not.toThrow();
		expect(detectTouchedCargoPackages("/repo")).toEqual(["data", "tools"]);
		expect(cargoSpawnCount()).toBe(0);
	});
});
