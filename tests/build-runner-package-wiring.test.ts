/**
 * Phase 2 — Wire `resolveCargoPackageNames` into `detectTouchedCargoPackages`
 * + complete the touched set (RED phase).
 *
 * Phase 1 shipped the resolver (`resolveCargoPackageNames`) and unit-tested it in
 * isolation. Phase 2's contract is that `detectTouchedCargoPackages` passes its
 * de-duplicated `crates/<dir>/` directory segments through
 * `resolveCargoPackageNames(cwd, dirs)` AS THE FINAL MAPPING STEP before return,
 * so that real cargo package names (not workspace directory names) flow into the
 * unchanged `scopedCargo{Build,Test,Clippy}Args` builders.
 *
 * TODAY (pre-Phase-2) `detectTouchedCargoPackages` returns the raw directory
 * segments verbatim and NEVER spawns `cargo metadata`. So every test below that
 * asserts a dir≠name workspace resolves to the REAL prefixed names — or that
 * `cargo metadata` is spawned at all — FAILS until Phase 2 lands. That is the
 * intentional RED state.
 *
 * Covers AC-04 / AC-05 / AC-10 and SCENARIO-007 / 008 / 009 / 014 / 021 / 022.
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
/* wiring: dir→name resolution through detectTouchedCargoPackages              */
/* AC-04 / SCENARIO-007 / SCENARIO-021                                         */
/* -------------------------------------------------------------------------- */

describe("detectTouchedCargoPackages wiring: dir→name resolution (AC-04 / SCENARIO-007 / SCENARIO-021)", () => {
	it("maps touched directory segments to REAL cargo package names", () => {
		setupWorkspace("crates/data/src/lib.rs\ncrates/tools/src/main.rs\ncrates/workflows/src/lib.rs");
		// TODAY this returns ["data","tools","workflows"] (the bug). After Phase 2
		// the deduped dirs flow through resolveCargoPackageNames → real names.
		expect(detectTouchedCargoPackages("/repo")).toEqual([
			"stockfan-data",
			"stockfan-tools",
			"stockfan-workflows",
		]);
	});

	it("is NOT an identity pass-through when dir ≠ name (the bug being fixed)", () => {
		setupWorkspace("crates/data/src/lib.rs\ncrates/tools/src/main.rs");
		const out = detectTouchedCargoPackages("/repo");
		// The pre-fix bug returned ["data","tools"]; the wiring MUST map to real
		// prefixed names so `cargo build -p stockfan-data` (NOT `-p data`).
		expect(out).not.toEqual(["data", "tools"]);
		expect(out).toEqual(["stockfan-data", "stockfan-tools"]);
	});

	it("preserves first-seen order through the wiring (tools before data)", () => {
		setupWorkspace("crates/tools/src/main.rs\ncrates/data/src/lib.rs");
		expect(detectTouchedCargoPackages("/repo")).toEqual([
			"stockfan-tools",
			"stockfan-data",
		]);
	});

	it("dedupes repeated touched directories to a single resolved name", () => {
		// Two files under the same crate → one dir segment → one resolved package.
		setupWorkspace("crates/data/src/lib.rs\ncrates/data/src/util.rs");
		expect(detectTouchedCargoPackages("/repo")).toEqual(["stockfan-data"]);
	});

	it("applies per-element identity fallback for an unmatched touched dir", () => {
		// `ghost` has NO matching package in metadata → degrades to its own dir
		// name (SCENARIO-004), while `data` still resolves to its real name.
		setupWorkspace("crates/data/src/lib.rs\ncrates/ghost/src/lib.rs", [
			{ name: "stockfan-data", manifestPath: "/repo/crates/data/Cargo.toml" },
		]);
		expect(detectTouchedCargoPackages("/repo")).toEqual(["stockfan-data", "ghost"]);
	});
});

/* -------------------------------------------------------------------------- */
/* complete touched set — Fix 2 (regex already captures the workflows segment) */
/* AC-05 / SCENARIO-009                                                        */
/* -------------------------------------------------------------------------- */

describe("complete touched set: e2e crate not dropped (AC-05 / SCENARIO-009)", () => {
	it("resolves `crates/workflows/tests/e2e_*.rs` to `stockfan-workflows`", () => {
		// The existing regex `/(?:^|\/)crates\/([^/]+)\//` captures `workflows`
		// from `crates/workflows/tests/e2e_smoke.rs`; the resolver then maps it.
		// TODAY this returns ["workflows"]; after wiring → ["stockfan-workflows"].
		setupWorkspace("crates/workflows/tests/e2e_smoke.rs");
		expect(detectTouchedCargoPackages("/repo")).toEqual(["stockfan-workflows"]);
	});

	it("includes the e2e crate alongside lib crates in a mixed diff", () => {
		setupWorkspace(
			"crates/data/src/lib.rs\ncrates/workflows/tests/e2e_smoke.rs\ncrates/tools/src/main.rs",
		);
		expect(detectTouchedCargoPackages("/repo")).toEqual([
			"stockfan-data",
			"stockfan-workflows",
			"stockfan-tools",
		]);
	});

	it("does NOT drop the workflows crate when only its integration tests changed", () => {
		// A workflows-only diff must still resolve to the real e2e package, never
		// to [] (which would silently skip spec-mandated e2e verification).
		setupWorkspace("crates/workflows/tests/e2e_login.rs\ncrates/workflows/tests/e2e_checkout.rs");
		expect(detectTouchedCargoPackages("/repo")).toEqual(["stockfan-workflows"]);
	});
});

/* -------------------------------------------------------------------------- */
/* end-to-end scoped argv DRIVEN THROUGH detectTouchedCargoPackages            */
/* AC-04 / SCENARIO-007 / SCENARIO-008 / SCENARIO-022                          */
/* -------------------------------------------------------------------------- */

describe("end-to-end scoped argv via detectTouchedCargoPackages (AC-04 / SCENARIO-007/008/022)", () => {
	// A diff touching all three prefixed crates — fed through the detection +
	// resolution pipeline, then into the UNCHANGED scopedCargo* builders.
	const ALL_THREE_DIFF =
		"crates/data/src/lib.rs\ncrates/tools/src/main.rs\ncrates/workflows/tests/e2e_smoke.rs";

	it("scopedCargoBuildArgs yields `cargo build -p <real>... --quiet`", () => {
		setupWorkspace(ALL_THREE_DIFF);
		const argv = scopedCargoBuildArgs(detectTouchedCargoPackages("/repo"));
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
		expect(scopedCargoTestArgs(detectTouchedCargoPackages("/repo"))).toEqual([
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
		expect(scopedCargoClippyArgs(detectTouchedCargoPackages("/repo"))).toEqual([
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
/* cargo metadata spawn contract (only NEW spawn, discrete argv, cached)       */
/* AC-10 / SCENARIO-014                                                        */
/* -------------------------------------------------------------------------- */

describe("cargo metadata spawn contract (AC-10 / SCENARIO-014)", () => {
	it("spawns `cargo metadata` as a discrete-argv call with --no-deps + workspace manifest", () => {
		setupWorkspace("crates/data/src/lib.rs");
		detectTouchedCargoPackages("/repo");
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

	it("spawns `cargo metadata` EXACTLY ONCE per cwd across repeated detections (cache)", () => {
		setupWorkspace("crates/data/src/lib.rs");
		// Two detection passes for the same cwd must hit the per-cwd cache once
		// and reuse it — never re-spawn cargo within a single run (SCENARIO-005).
		detectTouchedCargoPackages("/repo");
		detectTouchedCargoPackages("/repo");
		expect(cargoSpawnCount()).toBe(1);
	});
});

/* -------------------------------------------------------------------------- */
/* failure fallback survives the wiring (never throw, identity on cargo fail)   */
/* AC-02 / SCENARIO-018 / SCENARIO-019                                         */
/* -------------------------------------------------------------------------- */

describe("failure fallback through the wiring (AC-02 / SCENARIO-018/019)", () => {
	it("returns directory segments verbatim when `cargo metadata` exits non-zero (identity)", () => {
		// cargo rejects / is missing → resolver identity-falls-back to dir names.
		// detectTouchedCargoPackages must NOT throw and must return the dirs.
		setupCargoFailure("crates/data/src/lib.rs\ncrates/tools/src/main.rs", {
			status: 101,
			stdout: "",
			stderr: "error: could not find Cargo.toml",
		});
		const out = detectTouchedCargoPackages("/repo");
		expect(out).toEqual(["data", "tools"]);
		// AND cargo was actually attempted (the wiring invoked the resolver) —
		// TODAY (pre-wiring) cargo is never spawned, so this distinguishes the
		// wired identity-fallback from the unwired identity return.
		expect(cargoSpawnCount()).toBeGreaterThanOrEqual(1);
	});

	it("returns directory segments verbatim when `cargo metadata` throws (identity)", () => {
		setupWorkspace("crates/data/src/lib.rs");
		// Override only the cargo branch to throw synchronously.
		spawn.mockImplementation((bin: string) => {
			if (bin === "git") return { status: 0, stdout: "crates/data/src/lib.rs", stderr: "" };
			if (bin === "cargo") throw new Error("spawn cargo ENOENT");
			return { status: 0, stdout: "", stderr: "" };
		});
		expect(() => detectTouchedCargoPackages("/repo")).not.toThrow();
		expect(detectTouchedCargoPackages("/repo")).toEqual(["data"]);
		// AND cargo was actually attempted (the wiring invoked the resolver) —
		// TODAY (pre-wiring) cargo is never spawned, so this distinguishes the
		// wired identity-fallback from the unwired identity return.
		expect(cargoSpawnCount()).toBeGreaterThanOrEqual(1);
	});
});
