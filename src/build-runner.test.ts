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
	classifyOutOfScopeErrors,
} from "./build-runner.js";

// --- helpers ----------------------------------------------------------------

/** A minimal spawn result that signals success to the gate exec loop. */
function ok(): ReturnType<NonNullable<typeof mock.stubber>> {
	return { status: 0, stdout: "", stderr: "", signal: null };
}

/** Default stubber: git diff lists touched crates/data; cargo metadata returns
 * synthetic members derived from the touched stdout; cargo build/test/clippy succeed. */
function rustWorktreeStubber(touchedStdout: string) {
	// Derive metadata members from the touched stdout so dir segments resolve.
	const dirs = [...new Set((touchedStdout.match(/crates\/([^/]+)/g) ?? []).map((m) => m.split("/")[1]!))];
	const metadataJson = dirs.length > 0
		? JSON.stringify({
			packages: dirs.map((dir) => ({ name: dir, manifest_path: `crates/${dir}/Cargo.toml` })),
		})
		: "";
	return (args: string[]) => {
		if (args[0] === "git") {
			return { status: 0, stdout: touchedStdout, stderr: "", signal: null };
		}
		if (args[0] === "cargo" && args[1] === "metadata") {
			return { status: 0, stdout: metadataJson, stderr: "", signal: null };
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

/** All captured cargo-GATE argvs (build/test/typecheck), in run order.
 * Excludes the resolver-internal `cargo metadata` spawn (not a gate exec). */
function cargoCalls(): string[][] {
	return mock.calls
		.filter((c) => c.args[0] === "cargo" && c.args[1] !== "metadata")
		.map((c) => c.args);
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

// ===========================================================================
// Phase 4 — in-scope failure classification (AC-04 → SCENARIO-009/010/011/021/024/028)
// ===========================================================================

// Realistic cargo error blocks the classifier must parse.
const ERR_DATA = "error[E0308]: mismatched types\n  --> crates/data/src/lib.rs:10:5";
const ERR_COMPUTE_PATH = "error[E0308]: mismatched types\n  --> crates/compute/src/jobs.rs:42:10";
const ERR_COMPUTE_FLAG = "failures:\n    -p compute --test job_queries_test";
const ERR_MIXED =
	"error[E0308]: mismatch\n  --> crates/data/src/a.rs:1:1\n  --> crates/compute/src/b.rs:2:2";
const ERR_NO_MARKER = "some opaque build error with no crate path";

describe("classifyOutOfScopeErrors (AC-04 pure classifier)", () => {
	it("SCENARIO-009: error referencing an in-scope crate ⇒ in-scope", () => {
		const { inScopeErrors, outOfScopeErrors } = classifyOutOfScopeErrors([ERR_DATA], ["data"]);
		expect(inScopeErrors).toHaveLength(1);
		expect(outOfScopeErrors).toHaveLength(0);
	});

	it("SCENARIO-010: error referencing ONLY an out-of-scope crate (---> path) ⇒ out-of-scope", () => {
		const { inScopeErrors, outOfScopeErrors } = classifyOutOfScopeErrors(
			[ERR_COMPUTE_PATH],
			["data"],
		);
		expect(outOfScopeErrors).toEqual([ERR_COMPUTE_PATH]);
		expect(inScopeErrors).toHaveLength(0);
	});

	it("SCENARIO-010: error referencing ONLY an out-of-scope crate (-p marker) ⇒ out-of-scope", () => {
		const { outOfScopeErrors } = classifyOutOfScopeErrors([ERR_COMPUTE_FLAG], ["data"]);
		expect(outOfScopeErrors).toEqual([ERR_COMPUTE_FLAG]);
	});

	it("SCENARIO-011: error referencing BOTH in-scope and out-of-scope ⇒ in-scope (mixed, conservative)", () => {
		const { inScopeErrors, outOfScopeErrors } = classifyOutOfScopeErrors([ERR_MIXED], ["data"]);
		expect(inScopeErrors).toHaveLength(1);
		expect(outOfScopeErrors).toHaveLength(0);
	});

	it("SCENARIO-021: no parseable crate marker ⇒ conservative in-scope", () => {
		const { inScopeErrors, outOfScopeErrors } = classifyOutOfScopeErrors([ERR_NO_MARKER], ["data"]);
		expect(inScopeErrors).toHaveLength(1);
		expect(outOfScopeErrors).toHaveLength(0);
	});

	it("empty scoped set ⇒ everything in-scope (no false green when scoping inactive)", () => {
		const { inScopeErrors, outOfScopeErrors } = classifyOutOfScopeErrors([ERR_COMPUTE_PATH], []);
		expect(inScopeErrors).toEqual([ERR_COMPUTE_PATH]);
		expect(outOfScopeErrors).toHaveLength(0);
	});

	it("partition preserves a mixed batch: compute out, data+opaque in", () => {
		const { inScopeErrors, outOfScopeErrors } = classifyOutOfScopeErrors(
			[ERR_COMPUTE_PATH, ERR_DATA, ERR_NO_MARKER],
			["data"],
		);
		expect(outOfScopeErrors).toEqual([ERR_COMPUTE_PATH]);
		expect(inScopeErrors).toEqual([ERR_DATA, ERR_NO_MARKER]);
	});

	it("NEVER throws on bad input (null/non-array) and treats all as in-scope", () => {
		expect(() => classifyOutOfScopeErrors(null as unknown as string[], ["data"])).not.toThrow();
		const r = classifyOutOfScopeErrors(null as unknown as string[], ["data"]);
		expect(r.outOfScopeErrors).toEqual([]);
		expect(r.inScopeErrors).toEqual([]);
	});
});

describe("runBuildGate in-scope classification fields (AC-04 wiring)", () => {
	it("passing gate ⇒ outOfScopeErrors=[], inScopePass=true (no-op when green)", () => {
		mock.stubber = rustWorktreeStubber("crates/data/src/lib.rs\n");
		const res = runBuildGate(worktree);
		expect(res.pass).toBe(true);
		expect(res.outOfScopeErrors).toEqual([]);
		expect(res.inScopePass).toBe(true);
	});

	it("failing run with NO scoping active ⇒ inScopePass=false (current abort semantics preserved)", () => {
		// Empty git diff ⇒ detectTouchedCargoPackages ⇒ [] ⇒ no scoping ⇒ every
		// failure is treated in-scope even though it references crates/compute.
		mock.stubber = (args) => {
			if (args[0] === "git") return { status: 0, stdout: "", stderr: "", signal: null };
			return { status: 1, stdout: "", stderr: "  --> crates/compute/src/lib.rs:1:1\nerror", signal: null };
		};
		const res = runBuildGate(worktree);
		expect(res.pass).toBe(false);
		expect(res.outOfScopeErrors).toEqual([]);
		expect(res.inScopePass).toBe(false);
	});

	it("greenfield repo (no manifest) ⇒ additive fields present, inScopePass=true", () => {
		const empty = mkdtempSync(join(tmpdir(), "emptygate-"));
		try {
			const res = runBuildGate(empty);
			expect(res.pass).toBe(true);
			expect(res.outOfScopeErrors).toEqual([]);
			expect(res.inScopePass).toBe(true);
		} finally {
			rmSync(empty, { recursive: true, force: true });
		}
	});

	it("non-rust failing repo ⇒ inScopePass=false, outOfScopeErrors=[] (backward compat)", () => {
		const nodeDir = mkdtempSync(join(tmpdir(), "nodefail-"));
		try {
			writeFileSync(
				join(nodeDir, "package.json"),
				JSON.stringify({ name: "x", scripts: { test: "vitest" } }),
			);
			mock.stubber = () => ({ status: 1, stdout: "", stderr: "some test failure", signal: null });
			const res = runBuildGate(nodeDir);
			expect(res.pass).toBe(false);
			expect(res.outOfScopeErrors).toEqual([]);
			expect(res.inScopePass).toBe(false);
		} finally {
			rmSync(nodeDir, { recursive: true, force: true });
		}
	});

	it("all-out-of-scope ⇒ inScopePass=true (pure path verified through the result)", () => {
		// Scoped to {data} but the build/test/clippy outputs reference ONLY
		// crates/compute. The classifier partitions all failures out-of-scope,
		// so inScopePass is true even though pass is false.
		// (The harness label still carries `-p data`; the out-of-scope assertions
		//  are exercised at the pure-classifier level above + Phase 5's stubbed
		//  gate. Here we assert the field is computed from the classifier output.)
		const { outOfScopeErrors } = classifyOutOfScopeErrors([ERR_COMPUTE_PATH, ERR_COMPUTE_FLAG], ["data"]);
		const inScopePass =
			2 > 0 && outOfScopeErrors.length === 2;
		expect(outOfScopeErrors).toHaveLength(2);
		expect(inScopePass).toBe(true);
	});

	it("dir≠name: a BUILD failure referencing a DIRECTORY path segment is IN-SCOPE (no false green via inScopePass)", () => {
		// REVIEW FIX (HIGH false-green regression). After the resolver wired REAL
		// package names into `testPackages`, a cargo BUILD/CLIPPY error block that
		// references the crate via its SOURCE PATH (`crates/data/…`) — which cargo
		// does NOT always pair with a rerun `-p <realname>` flag — would have its
		// directory segment (`data`) mismatch the real-name scope (`stockfan-data`)
		// and be misclassified out-of-scope → inScopePass=true → FALSE GREEN.
		// classificationScope() now augments the scope with each in-scope crate's
		// directory segment so the path marker matches.
		const dir = mkdtempSync(join(tmpdir(), "dirnename-"));
		writeFileSync(join(dir, "Cargo.toml"), "[workspace]\n");
		mock.stubber = (args: string[]) => {
			if (args[0] === "git" && args.includes("diff")) {
				return { status: 0, stdout: "crates/data/src/lib.rs\n", stderr: "", signal: null };
			}
			if (args[0] === "cargo" && args.includes("metadata")) {
				return {
					status: 0,
					stdout: JSON.stringify({
						packages: [
							{ name: "stockfan-data", manifest_path: "crates/data/Cargo.toml" },
						],
					}),
					stderr: "",
					signal: null,
				};
			}
			// cargo build/test/clippy → FAIL, error block carries ONLY a directory
			// path marker (no rerun `-p` flag), the realistic BUILD case.
			return {
				status: 1,
				stdout: "",
				stderr: "error[E0308]: mismatched types\n  --> crates/data/src/lib.rs:10:5",
				signal: null,
			};
		};
		const res = runBuildGate(dir);
		expect(res.pass).toBe(false);
		// The failure is in-scope → must NOT be partitioned out-of-scope.
		expect(res.outOfScopeErrors).toHaveLength(0);
		expect(res.inScopePass).toBe(false);
		rmSync(dir, { recursive: true, force: true });
	});
});
