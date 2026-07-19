/**
 * Phase 2 — Per-package / scoped test invocation (RED phase).
 *
 * These tests define the contract for rust-only `-p` package scoping BEFORE the
 * implementation exists. They target AC-03 (parseTestPackages + scopedCargoTestArgs
 * helpers), AC-04 (opts.testPackages precedence over env), AC-06 (non-rust stacks
 * are never scoped), and SCENARIO-006/007/008/009/010/011/014.
 *
 * `parseTestPackages` and `scopedCargoTestArgs` do NOT exist yet — importing them
 * fails the file until they are implemented (intentional RED state). `opts.testPackages`
 * is also not yet on the runBuildGate option type.
 *
 * Deterministic & hermetic: no real cargo. Precedence assertions read the actual
 * argv via `result.ran` (which records `argv.join(" ")` before any spawnSync, so
 * ENOENT on a missing cargo still leaves the scoped label in `ran`). Each
 * env-touching test saves/restores `process.env` so tests stay independent.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// Helpers + widening imported now; they do NOT exist yet → RED until implemented.
import {
	parseTestPackages,
	scopedCargoTestArgs,
	runBuildGate,
	detectProjectCommands,
} from "../src/build-runner.ts";

const ENV_KEY = "SUPER_DEV_BUILD_TEST_PACKAGES";

function tmpProj(setup: (dir: string) => void): string {
	const dir = mkdtempSync(join(tmpdir(), "sd-pkg-"));
	setup(dir);
	return dir;
}

/** Save/restore the scoping env var around a test block (no shared state). */
function withEnv() {
	let saved: string | undefined;
	return {
		before() {
			saved = process.env[ENV_KEY];
			delete process.env[ENV_KEY];
		},
		after() {
			if (saved === undefined) delete process.env[ENV_KEY];
			else process.env[ENV_KEY] = saved;
		},
	};
}

/* -------------------------------------------------------------------------- */
/* parseTestPackages — AC-03 / SCENARIO-007                                     */
/* -------------------------------------------------------------------------- */

describe("parseTestPackages (AC-03 / SCENARIO-007)", () => {
	it("splits a comma list and trims each entry", () => {
		expect(parseTestPackages("crates/api, crates/store")).toEqual([
			"crates/api",
			"crates/store",
		]);
	});

	it("filters empties and collapses dupes while preserving first-seen order", () => {
		// "a, b ,, a ," → trim → ["a","b","","","a",""] → drop empties → ["a","b","a"]
		// → dedupe preserving order → ["a","b"]
		expect(parseTestPackages("a, b ,, a ,")).toEqual(["a", "b"]);
	});

	it("returns [] for an empty string", () => {
		expect(parseTestPackages("")).toEqual([]);
	});

	it("returns [] when the argument is undefined", () => {
		expect(parseTestPackages(undefined)).toEqual([]);
	});

	it("returns [] for a whitespace-only string (entries are all empty after trim)", () => {
		expect(parseTestPackages("   ,  , ")).toEqual([]);
	});

	it("handles a single package with no commas", () => {
		expect(parseTestPackages("crates/api")).toEqual(["crates/api"]);
	});

	it("preserves order across duplicates of the same value (first occurrence wins)", () => {
		expect(parseTestPackages("b, a, b, c, a")).toEqual(["b", "a", "c"]);
	});

	it("trims tabs and newlines, not just spaces", () => {
		expect(parseTestPackages("\tcrates/api\n, crates/store\r")).toEqual([
			"crates/api",
			"crates/store",
		]);
	});

	it("does NOT split on whitespace-only separators (only commas)", () => {
		// "crates/api crates/store" has no comma → one entry, trimmed.
		expect(parseTestPackages("crates/api crates/store")).toEqual([
			"crates/api crates/store",
		]);
	});
});

/* -------------------------------------------------------------------------- */
/* scopedCargoTestArgs — AC-03 / SCENARIO-006                                   */
/* -------------------------------------------------------------------------- */

describe("scopedCargoTestArgs (AC-03 / SCENARIO-006)", () => {
	it("expands a single package to one -p flag + --quiet", () => {
		expect(scopedCargoTestArgs(["crates/api"])).toEqual([
			"cargo",
			"test",
			"-p",
			"crates/api",
			"--quiet",
		]);
	});

	it("expands two packages to one -p flag each, order preserved, --quiet retained", () => {
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

	it("falls back to the unscoped workspace argv when the list is empty", () => {
		expect(scopedCargoTestArgs([])).toEqual(["cargo", "test", "--quiet"]);
	});

	it("always returns a plain string[] (every element typeof string)", () => {
		const argv = scopedCargoTestArgs(["x", "y"]);
		expect(Array.isArray(argv)).toBe(true);
		expect(argv.every((a) => typeof a === "string")).toBe(true);
	});

	it("emits exactly one -p per package (never a comma-joined single -p)", () => {
		const argv = scopedCargoTestArgs(["a", "b", "c"]);
		const minusP = argv.filter((a) => a === "-p");
		expect(minusP).toHaveLength(3);
		expect(argv).toEqual([
			"cargo",
			"test",
			"-p",
			"a",
			"-p",
			"b",
			"-p",
			"c",
			"--quiet",
		]);
	});
});

/* -------------------------------------------------------------------------- */
/* Shell safety — SCENARIO-014                                                  */
/* -------------------------------------------------------------------------- */

describe("scopedCargoTestArgs shell safety (SCENARIO-014)", () => {
	it("keeps a package name with shell metacharacters as a single discrete argv element", () => {
		// No shell:true anywhere; the malicious name flows verbatim as one token,
		// so `; rm -rf /` is NOT interpreted by a shell.
		const argv = scopedCargoTestArgs(["foo; rm -rf /"]);
		expect(argv).toEqual([
			"cargo",
			"test",
			"-p",
			"foo; rm -rf /",
			"--quiet",
		]);
	});

	it("does not collapse a pipe/backtick name into multiple argv tokens", () => {
		const argv = scopedCargoTestArgs(["a`whoami`|nc evil"]);
		// The whole malicious string survives as exactly one element following -p.
		const idx = argv.indexOf("-p");
		expect(argv[idx + 1]).toBe("a`whoami`|nc evil");
		expect(argv).toHaveLength(5);
	});
});

/* -------------------------------------------------------------------------- */
/* Precedence via runBuildGate (AC-04 / SCENARIO-008/009) — read via result.ran */
/* -------------------------------------------------------------------------- */

describe("runBuildGate package-scoping precedence (AC-04 / SCENARIO-008/009)", () => {
	const env = withEnv();
	beforeEach(env.before);
	afterEach(env.after);

	// Helper: the actual rust test argv is recorded in result.ran as
	// argv.join(" "), pushed BEFORE spawnSync — so it is present even if cargo
	// is absent (ENOENT) or the package does not exist.
	function rustTmp(): string {
		return tmpProj((dir) => writeFileSync(join(dir, "Cargo.toml"), ""));
	}

	it("honors opts.testPackages and ignores the env var (opt wins)", () => {
		const d = rustTmp();
		try {
			process.env[ENV_KEY] = "crates/api,crates/store";
			const r = runBuildGate(d, { testPackages: ["crates/core"] });
			// Scoped label present; env packages absent.
			expect(r.ran.some((l) => l === "cargo test -p crates/core --quiet")).toBe(true);
			expect(r.ran.some((l) => l.includes("crates/api"))).toBe(false);
			expect(r.ran.some((l) => l.includes("crates/store"))).toBe(false);
		} finally {
			rmSync(d, { recursive: true, force: true });
		}
	});

	it("an explicit empty opts.testPackages=[] forces workspace-wide (overrides env)", () => {
		const d = rustTmp();
		try {
			process.env[ENV_KEY] = "crates/api,crates/store";
			const r = runBuildGate(d, { testPackages: [] });
			// Provided-but-empty = force unscoped; env ignored.
			expect(r.ran.some((l) => l === "cargo test --quiet")).toBe(true);
			expect(r.ran.some((l) => l.includes("-p"))).toBe(false);
		} finally {
			rmSync(d, { recursive: true, force: true });
		}
	});

	it("uses the env var when opts.testPackages is undefined", () => {
		const d = rustTmp();
		try {
			process.env[ENV_KEY] = "a,b";
			const r = runBuildGate(d);
			expect(r.ran.some((l) => l === "cargo test -p a -p b --quiet")).toBe(true);
		} finally {
			rmSync(d, { recursive: true, force: true });
		}
	});

	it("is byte-identical to today when both opts.testPackages and env are absent", () => {
		const d = rustTmp();
		try {
			const r = runBuildGate(d);
			expect(r.ran.some((l) => l === "cargo test --quiet")).toBe(true);
			expect(r.ran.some((l) => l.includes("-p"))).toBe(false);
		} finally {
			rmSync(d, { recursive: true, force: true });
		}
	});

	it("falls back to workspace-wide when the env value is garbage (only commas/whitespace)", () => {
		const d = rustTmp();
		try {
			process.env[ENV_KEY] = "  ,, , ";
			const r = runBuildGate(d);
			expect(r.ran.some((l) => l === "cargo test --quiet")).toBe(true);
			expect(r.ran.some((l) => l.includes("-p"))).toBe(false);
		} finally {
			rmSync(d, { recursive: true, force: true });
		}
	});

	it("dedupes env packages via parseTestPackages before scoping", () => {
		const d = rustTmp();
		try {
			process.env[ENV_KEY] = "a, a, b";
			const r = runBuildGate(d);
			// One -p a (not two), then -p b.
			expect(r.ran.some((l) => l === "cargo test -p a -p b --quiet")).toBe(true);
		} finally {
			rmSync(d, { recursive: true, force: true });
		}
	});
});

/* -------------------------------------------------------------------------- */
/* Non-rust non-regression — AC-06 / SCENARIO-010/011                          */
/* -------------------------------------------------------------------------- */

describe("runBuildGate does NOT scope non-rust stacks (AC-06 / SCENARIO-010/011)", () => {
	const env = withEnv();
	beforeEach(env.before);
	afterEach(env.after);

	it("leaves the go test argv unchanged even when the env var is set", () => {
		const d = tmpProj((dir) => writeFileSync(join(dir, "go.mod"), "module x\n"));
		try {
			process.env[ENV_KEY] = "a,b";
			const r = runBuildGate(d);
			expect(r.ran.some((l) => l === "go test ./...")).toBe(true);
			expect(r.ran.some((l) => l.includes("-p"))).toBe(false);
		} finally {
			rmSync(d, { recursive: true, force: true });
		}
	});

	it("leaves the python test argv unchanged even when the env var is set", () => {
		const d = tmpProj((dir) =>
			writeFileSync(join(dir, "pyproject.toml"), "[tool.pytest.ini_options]\n"),
		);
		try {
			process.env[ENV_KEY] = "a,b";
			const r = runBuildGate(d);
			expect(r.ran.some((l) => l === "pytest -q")).toBe(true);
			expect(r.ran.some((l) => l.includes("-p"))).toBe(false);
		} finally {
			rmSync(d, { recursive: true, force: true });
		}
	});

	it("does not scope a node/frontend project even when opts.testPackages is provided", () => {
		// Scoping is guarded on language === "rust" only.
		const d = tmpProj((dir) =>
			writeFileSync(
				join(dir, "package.json"),
				JSON.stringify({ scripts: { test: 'node -e "process.exit(0)"' } }),
			),
		);
		try {
			const r = runBuildGate(d, { testPackages: ["a", "b"] });
			expect(r.ran.some((l) => l === "npm run test")).toBe(true);
			expect(r.ran.some((l) => l.includes("-p"))).toBe(false);
		} finally {
			rmSync(d, { recursive: true, force: true });
		}
	});

	it("still passes greenfield (no manifest) with the env var set, ran empty", () => {
		const d = tmpProj(() => {});
		try {
			process.env[ENV_KEY] = "a,b";
			const r = runBuildGate(d);
			expect(r.pass).toBe(true);
			expect(r.ran).toEqual([]);
			expect(r.errors).toEqual([]);
		} finally {
			rmSync(d, { recursive: true, force: true });
		}
	});
});

/* -------------------------------------------------------------------------- */
/* Detector purity — env never leaks into detectProjectCommands                */
/* -------------------------------------------------------------------------- */

describe("detectProjectCommands stays pure: env never leaks (AC-06 / regression guard)", () => {
	const env = withEnv();
	beforeEach(env.before);
	afterEach(env.after);

	it("returns the unscoped rust test argv even when the env var is set", () => {
		const d = tmpProj((dir) => writeFileSync(join(dir, "Cargo.toml"), ""));
		try {
			process.env[ENV_KEY] = "crates/api,crates/store";
			const c = detectProjectCommands(d);
			// Detector MUST be byte-identical to today; scoping lives in runBuildGate.
			expect(c.language).toBe("rust");
			expect(c.test).toEqual(["cargo", "test", "--quiet"]);
			expect(c.ran).toContain("cargo test");
		} finally {
			rmSync(d, { recursive: true, force: true });
		}
	});

	it("does not read the env var for go/python/node detection", () => {
		const d = tmpProj((dir) => writeFileSync(join(dir, "go.mod"), "module x\n"));
		try {
			process.env[ENV_KEY] = "a,b";
			const c = detectProjectCommands(d);
			expect(c.test).toEqual(["go", "test", "./..."]);
		} finally {
			rmSync(d, { recursive: true, force: true });
		}
	});
});
