/**
 * Phase 2 — Scoped cargo argv family (build/test/clippy) — RED phase.
 *
 * These tests define the AC-02 contract for the shared `scopedCargoArgs`
 * family + the two NEW `scopedCargoBuildArgs` / `scopedCargoClippyArgs`
 * helpers, and the refactor of `scopedCargoTestArgs` into a byte-identical thin
 * wrapper, BEFORE the implementation exists.
 *
 * Coverage map:
 *   - SCENARIO-004 (non-empty set → per-package `-p` flags + preserved extra
 *     flags) — `describe("SCENARIO-004 …")`.
 *   - SCENARIO-005 (empty set → byte-identical workspace-wide argvs) —
 *     `describe("SCENARIO-005 …")`.
 *   - Cross-helper regression / anti-hardcoding guards — `describe("wrapper
 *     equivalence …")` and `describe("regression …")`.
 *
 * RED status: `scopedCargoArgs`, `scopedCargoBuildArgs`, and
 * `scopedCargoClippyArgs` do NOT exist yet, so the non-empty, empty, and
 * wrapper-equivalence assertions referencing them fail until they are
 * implemented. `scopedCargoTestArgs` already exists; its assertions pin the
 * pre-refactor output so the refactor cannot drift it.
 *
 * Pure argv construction: no git, no spawn, no filesystem, no env. Deterministic
 * and hermetic. Inputs deliberately vary package names / counts / order to
 * defeat literal-return or single-entry lookup-table shortcuts (anti-hardcoding).
 */

import { describe, it, expect } from "vitest";
import {
	scopedCargoArgs,
	scopedCargoBuildArgs,
	scopedCargoClippyArgs,
	scopedCargoTestArgs,
} from "../src/build-runner.ts";

/* -------------------------------------------------------------------------- */
/* shared scopedCargoArgs helper — the family core                              */
/* -------------------------------------------------------------------------- */

describe("scopedCargoArgs — core contract", () => {
	it("emits cargo + subcommand + one -p per package in input order + trailing extras (SCENARIO-004 core)", () => {
		expect(scopedCargoArgs("build", ["data", "api"], ["--quiet"])).toEqual([
			"cargo",
			"build",
			"-p",
			"data",
			"-p",
			"api",
			"--quiet",
		]);
	});

	it("preserves first-seen package order across three packages (anti-hardcode: not a sorted/lookup impl)", () => {
		expect(scopedCargoArgs("test", ["zeta", "alpha", "mu"], ["--quiet"])).toEqual([
			"cargo",
			"test",
			"-p",
			"zeta",
			"-p",
			"alpha",
			"-p",
			"mu",
			"--quiet",
		]);
	});

	it("appends extraArgs verbatim after all -p flags, preserving extra-flag order", () => {
		expect(scopedCargoArgs("clippy", ["data"], ["--all-targets", "--quiet"])).toEqual([
			"cargo",
			"clippy",
			"-p",
			"data",
			"--all-targets",
			"--quiet",
		]);
	});

	it("omits trailing extras when extraArgs is undefined", () => {
		expect(scopedCargoArgs("build", ["data"], undefined)).toEqual([
			"cargo",
			"build",
			"-p",
			"data",
		]);
	});

	it("omits trailing extras when extraArgs is an empty array", () => {
		expect(scopedCargoArgs("test", ["data"], [])).toEqual(["cargo", "test", "-p", "data"]);
	});

	it("emits no -p flags for an empty package set and keeps extras (SCENARIO-005 core)", () => {
		expect(scopedCargoArgs("build", [], ["--quiet"])).toEqual(["cargo", "build", "--quiet"]);
		expect(scopedCargoArgs("clippy", [], ["--all-targets", "--quiet"])).toEqual([
			"cargo",
			"clippy",
			"--all-targets",
			"--quiet",
		]);
	});

	it("emits the subcommand as a single discrete argv element (no shell joining)", () => {
		const argv = scopedCargoArgs("build", ["data"], ["--quiet"]);
		// index 1 is exactly "build", not "build -p" or similar
		expect(argv[1]).toBe("build");
	});

	it("returns a fresh array on each call (no shared mutable reference between callers)", () => {
		const a = scopedCargoArgs("test", ["data"], ["--quiet"]);
		const b = scopedCargoArgs("test", ["data"], ["--quiet"]);
		expect(a).not.toBe(b); // distinct identity
		expect(a).toEqual(b); // equal contents
		// mutating one must not bleed into the other
		a.push("MUTATED");
		expect(b).toEqual(["cargo", "test", "-p", "data", "--quiet"]);
	});

	it("treats each package as a discrete argv element so names never reach a shell (SCENARIO-014 parity)", () => {
		const argv = scopedCargoArgs("build", ["data; rm -rf /", "api"], ["--quiet"]);
		expect(argv).toEqual([
			"cargo",
			"build",
			"-p",
			"data; rm -rf /",
			"-p",
			"api",
			"--quiet",
		]);
	});
});

/* -------------------------------------------------------------------------- */
/* SCENARIO-004 — non-empty set → per-package -p flags + preserved extras       */
/* -------------------------------------------------------------------------- */

describe("SCENARIO-004 — scoped helpers emit per-package -p flags with preserved extra flags", () => {
	it("scopedCargoBuildArgs(['data','api']) → cargo build -p data -p api --quiet", () => {
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

	it("scopedCargoTestArgs(['data']) → cargo test -p data --quiet (unchanged)", () => {
		expect(scopedCargoTestArgs(["data"])).toEqual([
			"cargo",
			"test",
			"-p",
			"data",
			"--quiet",
		]);
	});

	it("scopedCargoClippyArgs(['data']) → cargo clippy -p data --all-targets --quiet", () => {
		expect(scopedCargoClippyArgs(["data"])).toEqual([
			"cargo",
			"clippy",
			"-p",
			"data",
			"--all-targets",
			"--quiet",
		]);
	});

	it("build argv keeps the --quiet flag", () => {
		expect(scopedCargoBuildArgs(["data"]).includes("--quiet")).toBe(true);
	});

	it("test argv keeps the --quiet flag", () => {
		expect(scopedCargoTestArgs(["data"]).includes("--quiet")).toBe(true);
	});

	it("clippy argv keeps BOTH --all-targets and --quiet, in that order", () => {
		const argv = scopedCargoClippyArgs(["data"]);
		expect(argv).toContain("--all-targets");
		expect(argv).toContain("--quiet");
		expect(argv.indexOf("--all-targets")).toBeLessThan(argv.indexOf("--quiet"));
	});

	it("multi-package set preserves order: scopedCargoClippyArgs(['compute','data']) carries -p compute then -p data", () => {
		expect(scopedCargoClippyArgs(["compute", "data"])).toEqual([
			"cargo",
			"clippy",
			"-p",
			"compute",
			"-p",
			"data",
			"--all-targets",
			"--quiet",
		]);
	});

	it("package names with dashes stay intact as discrete elements (anti-hardcode: not split on '-')", () => {
		expect(scopedCargoBuildArgs(["data-core", "job-queries"])).toEqual([
			"cargo",
			"build",
			"-p",
			"data-core",
			"-p",
			"job-queries",
			"--quiet",
		]);
	});
});

/* -------------------------------------------------------------------------- */
/* SCENARIO-005 — empty set → byte-identical workspace-wide argvs               */
/* -------------------------------------------------------------------------- */

describe("SCENARIO-005 — empty package set produces byte-identical workspace-wide argvs", () => {
	it("scopedCargoBuildArgs([]) → ['cargo','build','--quiet']", () => {
		expect(scopedCargoBuildArgs([])).toEqual(["cargo", "build", "--quiet"]);
	});

	it("scopedCargoTestArgs([]) → ['cargo','test','--quiet']", () => {
		expect(scopedCargoTestArgs([])).toEqual(["cargo", "test", "--quiet"]);
	});

	it("scopedCargoClippyArgs([]) → ['cargo','clippy','--all-targets','--quiet']", () => {
		expect(scopedCargoClippyArgs([])).toEqual([
			"cargo",
			"clippy",
			"--all-targets",
			"--quiet",
		]);
	});

	it("all three empty forms carry NO -p flag anywhere (true workspace-wide)", () => {
		expect(scopedCargoBuildArgs([]).filter((a) => a === "-p")).toEqual([]);
		expect(scopedCargoTestArgs([]).filter((a) => a === "-p")).toEqual([]);
		expect(scopedCargoClippyArgs([]).filter((a) => a === "-p")).toEqual([]);
	});
});

/* -------------------------------------------------------------------------- */
/* wrapper equivalence — pins the "thin wrapper" contract (anti-hardcode guard) */
/* -------------------------------------------------------------------------- */

describe("wrapper equivalence — each named helper delegates to scopedCargoArgs", () => {
	const cases: Array<{ name: string; pkgs: string[] }> = [
		{ name: "empty", pkgs: [] },
		{ name: "single", pkgs: ["data"] },
		{ name: "multi-ordered", pkgs: ["data", "api", "store"] },
		{ name: "dashed-names", pkgs: ["data-core", "job-queries"] },
	];

	for (const { name, pkgs } of cases) {
		it(`scopedCargoBuildArgs ≡ scopedCargoArgs('build', pkgs, ['--quiet']) [${name}]`, () => {
			expect(scopedCargoBuildArgs(pkgs)).toEqual(
				scopedCargoArgs("build", pkgs, ["--quiet"]),
			);
		});

		it(`scopedCargoTestArgs ≡ scopedCargoArgs('test', pkgs, ['--quiet']) [${name}]`, () => {
			expect(scopedCargoTestArgs(pkgs)).toEqual(
				scopedCargoArgs("test", pkgs, ["--quiet"]),
			);
		});

		it(`scopedCargoClippyArgs ≡ scopedCargoArgs('clippy', pkgs, ['--all-targets','--quiet']) [${name}]`, () => {
			expect(scopedCargoClippyArgs(pkgs)).toEqual(
				scopedCargoArgs("clippy", pkgs, ["--all-targets", "--quiet"]),
			);
		});
	}
});

/* -------------------------------------------------------------------------- */
/* regression — scopedCargoTestArgs stays byte-identical to pre-refactor output */
/* (callers in verify.ts / implementation.ts + existing tests must not change)   */
/* -------------------------------------------------------------------------- */

describe("regression — scopedCargoTestArgs output unchanged vs pre-refactor", () => {
	it("non-empty single package keeps the exact historical argv", () => {
		expect(scopedCargoTestArgs(["crates/api"])).toEqual([
			"cargo",
			"test",
			"-p",
			"crates/api",
			"--quiet",
		]);
	});

	it("non-empty multi-package keeps one -p per package in order", () => {
		expect(scopedCargoTestArgs(["a", "b"])).toEqual([
			"cargo",
			"test",
			"-p",
			"a",
			"-p",
			"b",
			"--quiet",
		]);
	});

	it("empty set still returns the workspace-wide cargo test --quiet argv", () => {
		expect(scopedCargoTestArgs([])).toEqual(["cargo", "test", "--quiet"]);
	});

	it("first element is always 'cargo' and the subcommand element is always 'test'", () => {
		const argv = scopedCargoTestArgs(["x"]);
		expect(argv[0]).toBe("cargo");
		expect(argv[1]).toBe("test");
	});
});
