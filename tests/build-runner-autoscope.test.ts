/**
 * Phase 3 — runBuildGate auto-scopes build+test+clippy to the resolved set
 *           (RED phase — AC-03 → SCENARIO-006/007/008/017).
 *
 * These tests define the FOUR-TIER package-set precedence + all-three-command
 * override contract for `runBuildGate` BEFORE Phase 3 is implemented.
 *
 * Today (pre-Phase-3) `runBuildGate` ONLY overrides `cmds.test` (build-runner.ts
 * ~:301) and NEVER calls `detectTouchedCargoPackages` (tier iii is not wired).
 * So these tests are RED until Phase 3 lands:
 *   - SCENARIO-006: a touched-`data` crate drives ALL THREE captured cargo
 *     argvs (build + test + typecheck/clippy) to carry `-p data`. Today the
 *     build/typecheck argvs stay workspace-wide AND the git-diff never runs.
 *   - SCENARIO-007: a higher-precedence source (explicit opts / explicit [] /
 *     SUPER_DEV_BUILD_TEST_PACKAGES) is used and the git-diff spawn is SKIPPED.
 *     Today build/typecheck are never scoped even when an override exists.
 *   - SCENARIO-008: an empty resolved set leaves all three argvs byte-identical
 *     to `detectProjectCommands` output (no `-p` anywhere).
 *   - SCENARIO-017: integration coverage with a stubbed `spawnSync` so no real
 *     git/cargo ever runs (hermetic + deterministic).
 *
 * Hermetic: `node:child_process.spawnSync` is mocked so we (a) feed synthetic
 * `git diff --name-only` stdout to drive auto-detection and (b) capture the
 * real cargo build/test/typecheck argvs from `spawn.mock.calls`. Env-touching
 * tests save/restore both relevant vars so tests stay independent.
 *
 * NOTE: `detectProjectCommands` stays PURE (reads the real fs, no spawn), so
 * each test creates a real temp `Cargo.toml` worktree to make the detector
 * report `language === "rust"`.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runBuildGate } from "../src/build-runner.ts";

// Mock the ONLY side-effects runBuildGate performs: spawnSync. Real git and
// cargo must never run in CI. The mock routes git-diff → synthetic stdout and
// cargo build/test/clippy → status 0 success, while we capture the real argvs.
vi.mock("node:child_process", () => ({
	spawnSync: vi.fn(),
}));

import { spawnSync } from "node:child_process";

const spawn = spawnSync as unknown as ReturnType<typeof vi.fn>;
const PKG_ENV = "SUPER_DEV_BUILD_TEST_PACKAGES";
const BASE_REF_ENV = "SUPER_DEV_GATE_BASE_REF";

/** A real rust temp worktree (Cargo.toml present) so detectProjectCommands ⇒ rust. */
function rustTmp(): string {
	const dir = mkdtempSync(join(tmpdir(), "sd-autoscope-"));
	writeFileSync(join(dir, "Cargo.toml"), "");
	return dir;
}

/** Save/restore the two env vars runBuildGate reads around a test block. */
function withEnv() {
	let savedPkg: string | undefined;
	let savedRef: string | undefined;
	return {
		before() {
			savedPkg = process.env[PKG_ENV];
			savedRef = process.env[BASE_REF_ENV];
			delete process.env[PKG_ENV];
			delete process.env[BASE_REF_ENV];
		},
		after() {
			if (savedPkg === undefined) delete process.env[PKG_ENV];
			else process.env[PKG_ENV] = savedPkg;
			if (savedRef === undefined) delete process.env[BASE_REF_ENV];
			else process.env[BASE_REF_ENV] = savedRef;
		},
	};
}

/**
 * Configure spawnSync routing: `git` calls return `gitDiff` stdout (status 0);
 * `cargo metadata` returns synthetic metadata JSON derived from the gitDiff
 * (so touched dirs resolve to package names); every other cargo call (build/
 * test/clippy) is captured to `cargoCalls` and returns status 0 success.
 */
function routeSpawn(gitDiff: string, cargoCalls: string[][]): void {
	// Derive metadata members from the gitDiff so touched dirs resolve to names.
	// Uses RELATIVE manifest_path (crates/<dir>/Cargo.toml) — firstCratesSegment
	// matches on the segment, not the absolute path.
	const dirs = [...new Set((gitDiff.match(/crates\/([^/]+)/g) ?? []).map((m) => m.split("/")[1]!))];
	const metadataJson = dirs.length > 0
		? JSON.stringify({
			packages: dirs.map((dir) => ({ name: dir, manifest_path: `crates/${dir}/Cargo.toml` })),
		})
		: "";

	spawn.mockImplementation((cmd: string, args: string[]) => {
		if (cmd === "git") {
			return { status: 0, stdout: gitDiff, stderr: "" };
		}
		if (cmd === "cargo" && args[0] === "metadata") {
			return { status: 0, stdout: metadataJson, stderr: "" };
		}
		// cargo build/test/clippy — capture the full argv [cmd, ...args] and succeed.
		cargoCalls.push([cmd, ...(args ?? [])]);
		return { status: 0, stdout: "", stderr: "" };
	});
}

/** Count spawn calls whose first argv element is `cmd`. */
function callsFor(cmd: string): unknown[][] {
	return spawn.mock.calls.filter((c) => (c[0] as string) === cmd);
}

/** The cargo call whose full argv contains `subcommand` as argv[1]. */
function cargoArgvFor(cargoCalls: string[][], subcommand: string): string[] {
	const found = cargoCalls.find((a) => a[1] === subcommand);
	if (!found) throw new Error(`no captured cargo ${subcommand} argv`);
	return found;
}

beforeEach(() => {
	spawn.mockReset();
});

/* -------------------------------------------------------------------------- */
/* SCENARIO-006 — touched crates scope ALL THREE commands when nothing overrides */
/* -------------------------------------------------------------------------- */

describe("SCENARIO-006 — touched crates scope build+test+typecheck (no override)", () => {
	const env = withEnv();
	beforeEach(env.before);
	afterEach(env.after);

	it("a touched-`data` crate drives ALL THREE captured cargo argvs to carry -p data", () => {
		const cargoCalls: string[][] = [];
		routeSpawn("crates/data/src/lib.rs\n", cargoCalls);
		const d = rustTmp();
		try {
			const r = runBuildGate(d);
			expect(cargoArgvFor(cargoCalls, "build")).toEqual([
				"cargo",
				"build",
				"-p",
				"data",
				"--quiet",
			]);
			expect(cargoArgvFor(cargoCalls, "test")).toEqual([
				"cargo",
				"test",
				"-p",
				"data",
				"--quiet",
			]);
			expect(cargoArgvFor(cargoCalls, "clippy")).toEqual([
				"cargo",
				"clippy",
				"-p",
				"data",
				"--all-targets",
				"--quiet",
			]);
			// Succeeded cargo runs → clean pass.
			expect(r.pass).toBe(true);
			expect(r.errors).toEqual([]);
		} finally {
			rmSync(d, { recursive: true, force: true });
		}
	});

	it("exactly TWO git spawns run (diff + untracked union — Layer B)", () => {
		const cargoCalls: string[][] = [];
		routeSpawn("crates/data/src/lib.rs\n", cargoCalls);
		const d = rustTmp();
		try {
			runBuildGate(d);
			expect(callsFor("git")).toHaveLength(2);
		} finally {
			rmSync(d, { recursive: true, force: true });
		}
	});

	it("the git-diff spawn uses discrete argv (no shell:true), runs in cwd via -C", () => {
		const cargoCalls: string[][] = [];
		routeSpawn("crates/data/src/lib.rs\n", cargoCalls);
		const d = rustTmp();
		try {
			runBuildGate(d);
			const [cmd, args, opts] = callsFor("git")[0] as [
				string,
				string[],
				{ shell?: boolean; encoding?: string },
			];
			expect(cmd).toBe("git");
			expect(args).toContain("-C");
			expect(args).toContain(d);
			expect(args).toContain("--merge-base");
			expect(args).toContain("--name-only");
			expect(opts?.shell).toBeFalsy();
		} finally {
			rmSync(d, { recursive: true, force: true });
		}
	});

	it("multiple touched crates each add a -p flag, order preserved (anti-hardcode: not a literal 'data')", () => {
		const cargoCalls: string[][] = [];
		// compute touched BEFORE data → forces input-order preservation, defeating
		// any hardcoded "data"-only literal or sorted-lookup shortcut.
		routeSpawn("crates/compute/src/a.rs\ncrates/data/src/b.rs\n", cargoCalls);
		const d = rustTmp();
		try {
			runBuildGate(d);
			expect(cargoArgvFor(cargoCalls, "build")).toEqual([
				"cargo",
				"build",
				"-p",
				"compute",
				"-p",
				"data",
				"--quiet",
			]);
			expect(cargoArgvFor(cargoCalls, "test")).toEqual([
				"cargo",
				"test",
				"-p",
				"compute",
				"-p",
				"data",
				"--quiet",
			]);
			expect(cargoArgvFor(cargoCalls, "clippy")).toEqual([
				"cargo",
				"clippy",
				"-p",
				"compute",
				"-p",
				"data",
				"--all-targets",
				"--quiet",
			]);
		} finally {
			rmSync(d, { recursive: true, force: true });
		}
	});

	it("all three argv labels are recorded in result.ran with the -p data scoping", () => {
		const cargoCalls: string[][] = [];
		routeSpawn("crates/data/src/lib.rs\n", cargoCalls);
		const d = rustTmp();
		try {
			const r = runBuildGate(d);
			expect(r.ran).toEqual([
				"cargo build -p data --quiet",
				"cargo test -p data --quiet",
				"cargo clippy -p data --all-targets --quiet",
			]);
		} finally {
			rmSync(d, { recursive: true, force: true });
		}
	});

	it("a crate touched in multiple files collapses to a single -p data (dedupe)", () => {
		const cargoCalls: string[][] = [];
		routeSpawn("crates/data/src/a.rs\ncrates/data/src/b.rs\n", cargoCalls);
		const d = rustTmp();
		try {
			runBuildGate(d);
			const buildArgv = cargoArgvFor(cargoCalls, "build");
			const minusP = buildArgv.filter((a) => a === "-p");
			expect(minusP).toHaveLength(1);
			expect(buildArgv).toContain("data");
		} finally {
			rmSync(d, { recursive: true, force: true });
		}
	});
});

/* -------------------------------------------------------------------------- */
/* SCENARIO-007 — higher-precedence sources skip auto-detection and win         */
/* -------------------------------------------------------------------------- */

describe("SCENARIO-007 — explicit opts / env skip git-detection and win", () => {
	const env = withEnv();
	beforeEach(env.before);
	afterEach(env.after);

	it("explicit opts.testPackages=['api'] ⇒ git-diff NEVER spawns AND all three carry -p api", () => {
		const cargoCalls: string[][] = [];
		// A bogus gitDiff that WOULD resolve to `data` if detection ran — proving
		// the override wins and detection is skipped entirely.
		routeSpawn("crates/data/src/lib.rs\n", cargoCalls);
		const d = rustTmp();
		try {
			runBuildGate(d, { testPackages: ["api"] });
			// No git spawn at all.
			expect(callsFor("git")).toHaveLength(0);
			expect(cargoArgvFor(cargoCalls, "build")).toEqual([
				"cargo",
				"build",
				"-p",
				"api",
				"--quiet",
			]);
			expect(cargoArgvFor(cargoCalls, "test")).toEqual([
				"cargo",
				"test",
				"-p",
				"api",
				"--quiet",
			]);
			expect(cargoArgvFor(cargoCalls, "clippy")).toEqual([
				"cargo",
				"clippy",
				"-p",
				"api",
				"--all-targets",
				"--quiet",
			]);
		} finally {
			rmSync(d, { recursive: true, force: true });
		}
	});

	it("SUPER_DEV_BUILD_TEST_PACKAGES='api' ⇒ git-diff NEVER spawns AND all three carry -p api", () => {
		const cargoCalls: string[][] = [];
		process.env[PKG_ENV] = "api";
		routeSpawn("crates/data/src/lib.rs\n", cargoCalls);
		const d = rustTmp();
		try {
			runBuildGate(d);
			expect(callsFor("git")).toHaveLength(0);
			expect(cargoArgvFor(cargoCalls, "build")).toEqual([
				"cargo",
				"build",
				"-p",
				"api",
				"--quiet",
			]);
			expect(cargoArgvFor(cargoCalls, "test")).toEqual([
				"cargo",
				"test",
				"-p",
				"api",
				"--quiet",
			]);
			expect(cargoArgvFor(cargoCalls, "clippy")).toEqual([
				"cargo",
				"clippy",
				"-p",
				"api",
				"--all-targets",
				"--quiet",
			]);
		} finally {
			rmSync(d, { recursive: true, force: true });
		}
	});

	it("explicit opts.testPackages=['api'] wins over SUPER_DEV_BUILD_TEST_PACKAGES and skips git", () => {
		const cargoCalls: string[][] = [];
		process.env[PKG_ENV] = "store";
		routeSpawn("crates/data/src/lib.rs\n", cargoCalls);
		const d = rustTmp();
		try {
			runBuildGate(d, { testPackages: ["api"] });
			// No detection spawn when an override exists.
			expect(callsFor("git")).toHaveLength(0);
			// opt packages used (not env's 'store', not detection's 'data'), and
			// applied to ALL THREE commands — build + test + typecheck.
			expect(cargoArgvFor(cargoCalls, "build")).toEqual([
				"cargo",
				"build",
				"-p",
				"api",
				"--quiet",
			]);
			expect(cargoArgvFor(cargoCalls, "test")).toEqual([
				"cargo",
				"test",
				"-p",
				"api",
				"--quiet",
			]);
			expect(cargoArgvFor(cargoCalls, "clippy")).toEqual([
				"cargo",
				"clippy",
				"-p",
				"api",
				"--all-targets",
				"--quiet",
			]);
		} finally {
			rmSync(d, { recursive: true, force: true });
		}
	});

	it("an explicit empty opts.testPackages=[] forces workspace-wide AND skips git detection", () => {
		const cargoCalls: string[][] = [];
		process.env[PKG_ENV] = "api"; // env would scope if [] didn't force workspace-wide
		routeSpawn("crates/data/src/lib.rs\n", cargoCalls);
		const d = rustTmp();
		try {
			runBuildGate(d, { testPackages: [] });
			// Provided-but-empty = force workspace-wide; no git spawn, no -p.
			expect(callsFor("git")).toHaveLength(0);
			expect(cargoArgvFor(cargoCalls, "build")).toEqual(["cargo", "build", "--quiet"]);
			expect(cargoArgvFor(cargoCalls, "test")).toEqual(["cargo", "test", "--quiet"]);
			expect(cargoArgvFor(cargoCalls, "clippy")).toEqual([
				"cargo",
				"clippy",
				"--all-targets",
				"--quiet",
			]);
		} finally {
			rmSync(d, { recursive: true, force: true });
		}
	});

	it("SUPER_DEV_BUILD_TEST_PACKAGES multi-package 'api,store' scopes all three without a git spawn", () => {
		const cargoCalls: string[][] = [];
		process.env[PKG_ENV] = "api,store";
		routeSpawn("crates/data/src/lib.rs\n", cargoCalls);
		const d = rustTmp();
		try {
			runBuildGate(d);
			// Env-driven scoping skips detection entirely.
			expect(callsFor("git")).toHaveLength(0);
			// Both env packages applied to ALL THREE commands, order preserved.
			expect(cargoArgvFor(cargoCalls, "build")).toEqual([
				"cargo",
				"build",
				"-p",
				"api",
				"-p",
				"store",
				"--quiet",
			]);
			expect(cargoArgvFor(cargoCalls, "test")).toEqual([
				"cargo",
				"test",
				"-p",
				"api",
				"-p",
				"store",
				"--quiet",
			]);
			expect(cargoArgvFor(cargoCalls, "clippy")).toEqual([
				"cargo",
				"clippy",
				"-p",
				"api",
				"-p",
				"store",
				"--all-targets",
				"--quiet",
			]);
		} finally {
			rmSync(d, { recursive: true, force: true });
		}
	});
});

/* -------------------------------------------------------------------------- */
/* SCENARIO-008 — empty resolved scope ⇒ all three argvs byte-identical to today */
/* -------------------------------------------------------------------------- */

describe("SCENARIO-008 — empty resolved scope leaves argvs byte-identical to detected cmds", () => {
	const env = withEnv();
	beforeEach(env.before);
	afterEach(env.after);

	it("no override + git diff with NO crate paths ⇒ workspace-wide argvs, no -p", () => {
		const cargoCalls: string[][] = [];
		// Diff touches only non-crate paths → resolved set empty → fall through.
		routeSpawn("Cargo.toml\nREADME.md\n", cargoCalls);
		const d = rustTmp();
		try {
			runBuildGate(d);
			expect(cargoArgvFor(cargoCalls, "build")).toEqual(["cargo", "build", "--quiet"]);
			expect(cargoArgvFor(cargoCalls, "test")).toEqual(["cargo", "test", "--quiet"]);
			expect(cargoArgvFor(cargoCalls, "clippy")).toEqual([
				"cargo",
				"clippy",
				"--all-targets",
				"--quiet",
			]);
		} finally {
			rmSync(d, { recursive: true, force: true });
		}
	});

	it("no override + empty git diff ⇒ workspace-wide argvs (git ran but found nothing)", () => {
		const cargoCalls: string[][] = [];
		routeSpawn("", cargoCalls);
		const d = rustTmp();
		try {
			runBuildGate(d);
			// Detection ran (2 git calls: diff + ls-files) but resolved to [] → byte-identical cmds.
			expect(callsFor("git")).toHaveLength(2);
			expect(cargoArgvFor(cargoCalls, "build")).toEqual(["cargo", "build", "--quiet"]);
			expect(cargoArgvFor(cargoCalls, "test")).toEqual(["cargo", "test", "--quiet"]);
			expect(cargoArgvFor(cargoCalls, "clippy")).toEqual([
				"cargo",
				"clippy",
				"--all-targets",
				"--quiet",
			]);
		} finally {
			rmSync(d, { recursive: true, force: true });
		}
	});

	it("no override + git FAILURE (non-zero) ⇒ safe [] ⇒ workspace-wide argvs", () => {
		const cargoCalls: string[][] = [];
		// Detection must degrade to [] without throwing.
		spawn.mockImplementation((cmd: string, _args: string[]) => {
			if (cmd === "git") return { status: 128, stdout: "", stderr: "fatal" };
			cargoCalls.push([cmd, ...(_args ?? [])]);
			return { status: 0, stdout: "", stderr: "" };
		});
		const d = rustTmp();
		try {
			const r = runBuildGate(d);
			expect(cargoArgvFor(cargoCalls, "build")).toEqual(["cargo", "build", "--quiet"]);
			expect(cargoArgvFor(cargoCalls, "test")).toEqual(["cargo", "test", "--quiet"]);
			expect(cargoArgvFor(cargoCalls, "clippy")).toEqual([
				"cargo",
				"clippy",
				"--all-targets",
				"--quiet",
			]);
			expect(r.pass).toBe(true);
		} finally {
			rmSync(d, { recursive: true, force: true });
		}
	});

	it("explicit [] and an empty diff both yield the SAME argvs (both = workspace-wide)", () => {
		const d = rustTmp();
		try {
			const explicitEmpty: string[][] = [];
			spawn.mockImplementation((cmd: string, a: string[]) => {
				if (cmd === "git") return { status: 0, stdout: "crates/data/src/lib.rs\n", stderr: "" };
				explicitEmpty.push([cmd, ...(a ?? [])]);
				return { status: 0, stdout: "", stderr: "" };
			});
			runBuildGate(d, { testPackages: [] });

			const viaDetection: string[][] = [];
			spawn.mockImplementation((cmd: string, a: string[]) => {
				if (cmd === "git") return { status: 0, stdout: "", stderr: "" };
				viaDetection.push([cmd, ...(a ?? [])]);
				return { status: 0, stdout: "", stderr: "" };
			});
			runBuildGate(d);

			expect(viaDetection).toEqual(explicitEmpty);
		} finally {
			rmSync(d, { recursive: true, force: true });
		}
	});
});

/* -------------------------------------------------------------------------- */
/* SCENARIO-017 — integration coverage: detectProjectCommands purity preserved   */
/* (override applies only on the shallow copy; detector argv never carries -p)    */
/* -------------------------------------------------------------------------- */

describe("SCENARIO-017 — detectProjectCommands purity: override only on the shallow copy", () => {
	const env = withEnv();
	beforeEach(env.before);
	afterEach(env.after);

	it("runBuildGate scopes its captured argvs WITHOUT mutating the detector contract", () => {
		const cargoCalls: string[][] = [];
		routeSpawn("crates/data/src/lib.rs\n", cargoCalls);
		const d = rustTmp();
		try {
			const r = runBuildGate(d);
			// The 3 captured argvs ARE scoped (proves the override happened on a
			// copy run by exec), while the result still reports the 3 rust labels.
			expect(r.ran).toHaveLength(3);
			expect(cargoArgvFor(cargoCalls, "build")).toContain("-p");
			expect(cargoArgvFor(cargoCalls, "test")).toContain("-p");
			expect(cargoArgvFor(cargoCalls, "clippy")).toContain("-p");
		} finally {
			rmSync(d, { recursive: true, force: true });
		}
	});

	it("a non-rust worktree is NEVER auto-scoped even when git touches crates/ paths", () => {
		// go.mod repo: language !== "rust" ⇒ no scoping, no git-detection spawn.
		const cargoCalls: string[][] = [];
		const dir = mkdtempSync(join(tmpdir(), "sd-go-"));
		writeFileSync(join(dir, "go.mod"), "module x\n");
		routeSpawn("crates/data/src/lib.rs\n", cargoCalls);
		try {
			runBuildGate(dir);
			expect(callsFor("git")).toHaveLength(0);
			expect(cargoCalls.every((a) => !a.includes("-p"))).toBe(true);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("greenfield (no manifest) stays non-fatal pass with empty ran even with git data", () => {
		const dir = mkdtempSync(join(tmpdir(), "sd-green-"));
		routeSpawn("crates/data/src/lib.rs\n", []);
		try {
			const r = runBuildGate(dir);
			expect(r.pass).toBe(true);
			expect(r.ran).toEqual([]);
			expect(r.errors).toEqual([]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
