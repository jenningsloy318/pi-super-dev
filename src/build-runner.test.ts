/**
 * Scope-Aware Build Gate tests — Phase 1/2/3 (AC-01/AC-02/AC-03).
 *
 * Phase 3 focus (AC-03 → SCENARIO-006/007/008/017): integration test stubbing
 * `child_process.spawnSync` so a touched-`data` cargo crate drives ALL THREE
 * captured gate argvs (`build`/`test`/`typecheck`) to carry `-p data`, plus the
 * FOUR-tier precedence assertions (explicit opts → SUPER_DEV_BUILD_TEST_PACKAGES
 * → detectTouchedCargoPackages → workspace-wide) and the no-spawn-when-
 * overridden invariant. Phases 1 (detectTouchedCargoPackages) & 2 (scoped argv
 * family) are covered here too because they are the inputs Phase 3 composes and
 * no separate co-located suite existed yet.
 *
 * `spawnSync` is fully stubbed via `vi.mock("node:child_process")`; `existsSync`
 * / `readFileSync` run against a real temp worktree (a `Cargo.toml` file) so the
 * `detectProjectCommands` purity path is exercised on real fs without spawning
 * git/cargo. No real `git`/`cargo` is executed in CI.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// --- spawnSync stub ---------------------------------------------------------
// Captured argv history + a per-test override. `vi.hoisted` keeps the shared
// state initialized before the hoisted `vi.mock` factory runs.
const mock = vi.hoisted(() => ({
	calls: [] as { args: string[] }[],
	stubber: null as
		| null
		| ((args: string[]) => {
				status: number;
				stdout: string;
				stderr: string;
				signal: NodeJS.Signals | null;
				error?: Error;
		  }),
}));

vi.mock("node:child_process", () => ({
	spawnSync: (cmd: string, argv?: readonly string[]) => {
		const full = [cmd, ...(Array.isArray(argv) ? argv.slice() : [])];
		mock.calls.push({ args: full });
		if (mock.stubber) return mock.stubber(full);
		return { status: 0, stdout: "", stderr: "", signal: null };
	},
}));

import {
	runBuildGate,
	detectTouchedCargoPackages,
	scopedCargoArgs,
	scopedCargoBuildArgs,
	scopedCargoTestArgs,
	scopedCargoClippyArgs,
} from "./build-runner.js";

// --- helpers ----------------------------------------------------------------

/** A minimal spawn result that signals success to the gate exec loop. */
function ok(): ReturnType<NonNullable<typeof mock.stubber>> {
	return { status: 0, stdout: "", stderr: "", signal: null };
}

/** Default stubber: git diff lists touched crates/data; cargo calls succeed. */
function rustWorktreeStubber(touchedStdout: string) {
	return (args: string[]) => {
		if (args[0] === "git" && args.includes("diff")) {
			return { status: 0, stdout: touchedStdout, stderr: "", signal: null };
		}
		// cargo build/test/clippy → success.
		return ok();
	};
}

/** Build a temp cargo worktree (a `Cargo.toml`) and return its absolute path. */
function makeRustWorktree(): string {
	const dir = mkdtempSync(join(tmpdir(), "buildgate-"));
	writeFileSync(join(dir, "Cargo.toml"), "[package]\nname = \"ws\"\nversion = \"0.1.0\"\n");
	return dir;
}

let worktree: string;

beforeEach(() => {
	mock.calls = [];
	mock.stubber = null;
	worktree = makeRustWorktree();
});

afterEach(() => {
	mock.calls = [];
	mock.stubber = null;
	delete process.env.SUPER_DEV_BUILD_TEST_PACKAGES;
	delete process.env.SUPER_DEV_GATE_BASE_REF;
	rmSync(worktree, { recursive: true, force: true });
});

/** All captured cargo-gate argvs (build/test/typecheck), in run order. */
function cargoCalls(): string[][] {
	return mock.calls.filter((c) => c.args[0] === "cargo").map((c) => c.args);
}

/** Did any `git ... diff --name-only` spawn happen? */
function gitDiffSpawned(): boolean {
	return mock.calls.some((c) => c.args[0] === "git" && c.args.includes("diff"));
}

// ===========================================================================
// Phase 2 — scoped argv family (AC-02 → SCENARIO-004/005). Pure, no spawn.
// ===========================================================================

describe("scopedCargoArgs family (AC-02)", () => {
	it("scopedCargoBuildArgs scopes build with --quiet", () => {
		expect(scopedCargoBuildArgs(["data", "api"])).toEqual([
			"cargo",
			"build",
			"-p",
			"data",
			"-p",
			"api",
			"--quiet",
		]);
	});

	it("scopedCargoTestArgs is byte-identical to the pre-refactor form", () => {
		expect(scopedCargoTestArgs(["data"])).toEqual([
			"cargo",
			"test",
			"-p",
			"data",
			"--quiet",
		]);
	});

	it("scopedCargoClippyArgs scopes clippy with --all-targets --quiet", () => {
		expect(scopedCargoClippyArgs(["data"])).toEqual([
			"cargo",
			"clippy",
			"-p",
			"data",
			"--all-targets",
			"--quiet",
		]);
	});

	it("empty package set → byte-identical workspace-wide argv for all three", () => {
		expect(scopedCargoBuildArgs([])).toEqual(["cargo", "build", "--quiet"]);
		expect(scopedCargoTestArgs([])).toEqual(["cargo", "test", "--quiet"]);
		expect(scopedCargoClippyArgs([])).toEqual([
			"cargo",
			"clippy",
			"--all-targets",
			"--quiet",
		]);
	});

	it("scopedCargoArgs core emits one -p per package in order then extras", () => {
		expect(scopedCargoArgs("test", ["a", "b"], ["--quiet"])).toEqual([
			"cargo",
			"test",
			"-p",
			"a",
			"-p",
			"b",
			"--quiet",
		]);
	});
});

// ===========================================================================
// Phase 1 — detectTouchedCargoPackages (AC-01 → SCENARIO-001/002/003/020/022/023)
// ===========================================================================

describe("detectTouchedCargoPackages (AC-01)", () => {
	it("maps crates/<pkg>/ lines to package names, deduped + order preserved", () => {
		mock.stubber = (_a) => ({
			status: 0,
			stdout: "crates/data/src/lib.rs\ncrates/api/src/main.rs\ncrates/data/src/x.rs\n",
			stderr: "",
			signal: null,
		});
		expect(detectTouchedCargoPackages(worktree)).toEqual(["data", "api"]);
	});

	it("ignores non-crate paths (root Cargo.toml / README)", () => {
		mock.stubber = (_a) => ({
			status: 0,
			stdout: "Cargo.toml\nREADME.md\ndocs/x.md\n",
			stderr: "",
			signal: null,
		});
		expect(detectTouchedCargoPackages(worktree)).toEqual([]);
	});

	it("returns [] on git non-zero exit / missing base ref", () => {
		mock.stubber = (_a) => ({ status: 128, stdout: "", stderr: "bad rev", signal: null });
		expect(detectTouchedCargoPackages(worktree)).toEqual([]);
	});

	it("returns [] when the spawn throws (NEVER throws itself)", () => {
		mock.stubber = (_a) => {
			throw new Error("ENOENT git");
		};
		expect(() => detectTouchedCargoPackages(worktree)).not.toThrow();
		expect(detectTouchedCargoPackages(worktree)).toEqual([]);
	});

	it("SUPER_DEV_GATE_BASE_REF flows into the --merge-base argv", () => {
		process.env.SUPER_DEV_GATE_BASE_REF = "develop";
		mock.stubber = (_a) => ({ status: 0, stdout: "crates/data/src/lib.rs\n", stderr: "", signal: null });
		detectTouchedCargoPackages(worktree);
		const git = mock.calls.find((c) => c.args[0] === "git")!.args;
		expect(git).toContain("--merge-base");
		expect(git[git.indexOf("--merge-base") + 1]).toBe("develop");
	});

	it("explicit baseRef arg overrides the env var", () => {
		process.env.SUPER_DEV_GATE_BASE_REF = "develop";
		mock.stubber = (_a) => ({ status: 0, stdout: "crates/data/src/lib.rs\n", stderr: "", signal: null });
		detectTouchedCargoPackages(worktree, "release/v1");
		const git = mock.calls.find((c) => c.args[0] === "git")!.args;
		expect(git[git.indexOf("--merge-base") + 1]).toBe("release/v1");
	});
});

// ===========================================================================
// Phase 3 — runBuildGate auto-scopes build+test+clippy (AC-03 → SCENARIO-006/007/008/017)
// ===========================================================================

describe("runBuildGate auto-scoping (AC-03)", () => {
	it("SCENARIO-006: touched-`data` crate drives ALL THREE argvs to carry -p data", () => {
		// No env, no explicit opts ⇒ tier (iii) detectTouchedCargoPackages runs.
		mock.stubber = rustWorktreeStubber("crates/data/src/lib.rs\n");
		const res = runBuildGate(worktree);
		expect(res.pass).toBe(true);
		const cargo = cargoCalls();
		expect(cargo).toHaveLength(3);
		expect(cargo[0]).toEqual(["cargo", "build", "-p", "data", "--quiet"]);
		expect(cargo[1]).toEqual(["cargo", "test", "-p", "data", "--quiet"]);
		expect(cargo[2]).toEqual([
			"cargo",
			"clippy",
			"-p",
			"data",
			"--all-targets",
			"--quiet",
		]);
		// git-diff spawn DID happen (tier iii).
		expect(gitDiffSpawned()).toBe(true);
	});

	it("SCENARIO-007: explicit opts.testPackages wins and git-diff is NOT spawned", () => {
		mock.stubber = rustWorktreeStubber("crates/data/src/lib.rs\n");
		runBuildGate(worktree, { testPackages: ["api"] });
		expect(gitDiffSpawned()).toBe(false);
		const cargo = cargoCalls();
		expect(cargo[0]).toEqual(["cargo", "build", "-p", "api", "--quiet"]);
		expect(cargo[1]).toEqual(["cargo", "test", "-p", "api", "--quiet"]);
		expect(cargo[2]).toEqual([
			"cargo",
			"clippy",
			"-p",
			"api",
			"--all-targets",
			"--quiet",
		]);
	});

	it("SCENARIO-007: SUPER_DEV_BUILD_TEST_PACKAGES env wins and git-diff is NOT spawned", () => {
		process.env.SUPER_DEV_BUILD_TEST_PACKAGES = "api";
		mock.stubber = rustWorktreeStubber("crates/data/src/lib.rs\n");
		runBuildGate(worktree);
		expect(gitDiffSpawned()).toBe(false);
		const cargo = cargoCalls();
		expect(cargo[1]).toEqual(["cargo", "test", "-p", "api", "--quiet"]);
	});

	it("SCENARIO-007: explicit [] forces workspace-wide AND skips git-diff", () => {
		mock.stubber = rustWorktreeStubber("crates/data/src/lib.rs\n");
		runBuildGate(worktree, { testPackages: [] });
		expect(gitDiffSpawned()).toBe(false);
		const cargo = cargoCalls();
		expect(cargo[0]).toEqual(["cargo", "build", "--quiet"]);
		expect(cargo[1]).toEqual(["cargo", "test", "--quiet"]);
		expect(cargo[2]).toEqual(["cargo", "clippy", "--all-targets", "--quiet"]);
	});

	it("SCENARIO-008: empty resolved scope (no touched crates) ⇒ byte-identical workspace argvs", () => {
		// git diff returns empty stdout ⇒ detectTouchedCargoPackages ⇒ [] ⇒ no scoping.
		mock.stubber = (_a) => {
			if (_a[0] === "git") return { status: 0, stdout: "", stderr: "", signal: null };
			return ok();
		};
		runBuildGate(worktree);
		const cargo = cargoCalls();
		expect(cargo[0]).toEqual(["cargo", "build", "--quiet"]);
		expect(cargo[1]).toEqual(["cargo", "test", "--quiet"]);
		expect(cargo[2]).toEqual(["cargo", "clippy", "--all-targets", "--quiet"]);
	});

	it("SCENARIO-006: multiple touched crates scope all three argvs in order", () => {
		mock.stubber = rustWorktreeStubber(
			"crates/data/src/lib.rs\ncrates/api/src/main.rs\n",
		);
		runBuildGate(worktree);
		const cargo = cargoCalls();
		expect(cargo[0]).toEqual([
			"cargo",
			"build",
			"-p",
			"data",
			"-p",
			"api",
			"--quiet",
		]);
		expect(cargo[2]).toEqual([
			"cargo",
			"clippy",
			"-p",
			"data",
			"-p",
			"api",
			"--all-targets",
			"--quiet",
		]);
	});

	it("non-rust repo never spawns git-diff and never scopes (backward compat)", () => {
		// A package.json backend repo: language !== "rust" ⇒ tier (iv) [].
		const nodeDir = mkdtempSync(join(tmpdir(), "nodegate-"));
		try {
			writeFileSync(
				join(nodeDir, "package.json"),
				JSON.stringify({
					name: "x",
					scripts: { build: "tsc", test: "vitest", typecheck: "tsc --noEmit" },
				}),
			);
			mock.stubber = (_a) => ok();
			runBuildGate(nodeDir);
			expect(gitDiffSpawned()).toBe(false);
		} finally {
			rmSync(nodeDir, { recursive: true, force: true });
		}
	});
});
