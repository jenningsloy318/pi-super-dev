/**
 * Phase 4 — In-scope failure classification on BuildGateResult — RED phase.
 *
 * These tests define the AC-04 contract for the pure
 * `classifyOutOfScopeErrors(errors, scopedSet)` classifier AND its wiring into
 * `runBuildGate` (additive `BuildGateResult.outOfScopeErrors` +
 * `BuildGateResult.inScopePass`), BEFORE the implementation exists.
 *
 * Coverage map:
 *   - SCENARIO-009 (all-out-of-scope failures → inScopePass true; outOfScopeErrors
 *     holds all of them) — `describe("SCENARIO-009 …")`.
 *   - SCENARIO-010 (any in-scope failure prevents inScopePass; out-of-scope ones
 *     still recorded in outOfScopeErrors) — `describe("SCENARIO-010 …")`.
 *   - SCENARIO-011 (ambiguous / malformed / no-marker errors treated
 *     conservatively as in-scope; a passing gate sets inScopePass true and
 *     skips classification as a no-op) — `describe("SCENARIO-011 …")`.
 *   - SCENARIO-021 (classifier never throws, degrades to conservative
 *     in-scope) — `describe("SCENARIO-021 …")`.
 *   - SCENARIO-024 (only the in-scope subset is surfaced for fixing; inScopePass
 *     green stops the fix-loop) — `describe("SCENARIO-024 …")`.
 *   - SCENARIO-028 (both source-path `--> crates/<pkg>/` and cargo test
 *     `-p <pkg>` rerun markers are recognized; out-of-scope only when EVERY
 *     referenced crate is outside the scoped set) — `describe("SCENARIO-028 …")`.
 *   - `BuildGateResult` additive-field + runBuildGate wiring —
 *     `describe("BuildGateResult …")` and `describe("runBuildGate wiring …")`.
 *   - SCENARIO-016 parity (workspace-wide / no scoping never grants a false
 *     inScopePass) — `describe("SCENARIO-016 parity …")`.
 *
 * RED status: `classifyOutOfScopeErrors` does NOT exist yet and `BuildGateResult`
 * carries neither `outOfScopeErrors` nor `inScopePass`, so every assertion
 * referencing them fails until Phase 4 is implemented.
 *
 * The pure classifier unit tests are the authoritative, INDEPENDENTLY TESTABLE
 * core. The runBuildGate wiring tests stub `node:child_process.spawnSync` so no
 * real `git` / `cargo` runs (hermetic). Env-touching tests save/restore the two
 * env vars `runBuildGate` reads. A real temp `Cargo.toml` worktree makes
 * `detectProjectCommands` report `language:"rust"` so the resolved scoped set
 * is non-empty and classification activates.
 *
 * IMPORTANT design contract pinned by these tests: the classifier must NOT treat
 * the command LABEL's own `-p <scoped-pkg>` as a crate reference. The realistic
 * error blocks produced by `runBuildGate` look like
 *   `cargo build -p data --quiet FAILED (exit 101):\nerror[E0308]: ...\n  --> crates/compute/src/jobs.rs:42:10`
 * where the LABEL carries `-p data` (a scoped crate) but the FAILURE references
 * `crates/compute/` (out-of-scope). For AC-04 to ever grant an in-scope pass
 * under active scoping, the label's `-p` MUST be ignored — only cargo's failure
 * markers (`--> crates/<pkg>/` source paths and `rerun pass '-p <pkg>'` lines)
 * identify the failing crate. These tests encode that contract; a naive
 * whole-string regex that catches the label `-p` will fail RED here.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Mock the ONLY side-effects runBuildGate performs: spawnSync. Real git/cargo
// must never run in CI. Routes are configured per-test below.
vi.mock("node:child_process", () => ({
	spawnSync: vi.fn(),
}));

import {
	classifyOutOfScopeErrors,
	runBuildGate,
	type BuildGateResult,
} from "../src/build-runner.ts";
import { spawnSync } from "node:child_process";

const spawn = spawnSync as unknown as ReturnType<typeof vi.fn>;
const PKG_ENV = "SUPER_DEV_BUILD_TEST_PACKAGES";
const BASE_REF_ENV = "SUPER_DEV_GATE_BASE_REF";

/* -------------------------------------------------------------------------- */
/* Realistic cargo error strings (tail / stderr content)                        */
/* -------------------------------------------------------------------------- */

/** Compile error pointing at an OUT-OF-SCOPE crate (`compute`), source-path marker. */
const TAIL_COMPILE_COMPUTE =
	"error[E0308]: mismatched types\n" +
	"  --> crates/compute/src/jobs.rs:42:10\n" +
	"   |\n" +
	"42 |     let x: u8 = \"oops\";\n" +
	"   |                ^^^^^ expected `u8`, found `&str`";

/** Compile error pointing at an IN-SCOPE crate (`data`), source-path marker. */
const TAIL_COMPILE_DATA =
	"error[E0425]: cannot find value `thing` in this scope\n" +
	"  --> crates/data/src/lib.rs:10:5\n" +
	"   |\n" +
	"10 |     thing.run();\n" +
	"   |     ^^^^^ not found in this scope";

/** Cargo TEST failure whose rerun line names an OUT-OF-SCOPE crate (`-p compute`). */
const TAIL_TEST_COMPUTE =
	"failures:\n" +
	"    job_queries_test::tests::basic\n" +
	"\n" +
	"error: test failed, to rerun pass '-p compute --test job_queries_test'";

/** A failure string with NO parseable crate marker at all (ambiguous → in-scope). */
const TAIL_NO_MARKER =
	"warning: build failed\n" +
	"error: could not compile the workspace due to a previous error";

/** Full error block as `runBuildGate` would assemble it (label + tail). */
function block(label: string, tail: string): string {
	return `${label} FAILED (exit 101):\n${tail}`;
}

const BUILD_LABEL_DATA = "cargo build -p data --quiet";
const TEST_LABEL_DATA = "cargo test -p data --quiet";
const CLIPPY_LABEL_DATA = "cargo clippy -p data --all-targets --quiet";

/* -------------------------------------------------------------------------- */
/* Test scaffolding                                                            */
/* -------------------------------------------------------------------------- */

/** A real rust temp worktree (Cargo.toml present) → detectProjectCommands ⇒ rust. */
function rustTmp(tag = "sd-inscope-"): string {
	const dir = mkdtempSync(join(tmpdir(), tag));
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
 * Route spawnSync so `git` succeeds with `gitDiff` stdout, and each cargo
 * subcommand (`build`/`test`/`clippy`) returns the configured status+stderr.
 * A subcommand omitted from `perSub` succeeds (status 0). The cargo argv's
 * subcommand is argv[1] of the full invocation = args[0] (since spawnSync is
 * called as spawnSync(argv[0], argv.slice(1), …)).
 */
function routeSpawn(
	gitDiff: string,
	perSub: Partial<Record<"build" | "test" | "clippy", { status: number; stderr: string }>>,
): void {
	spawn.mockImplementation((cmd: string, args: string[]) => {
		if (cmd === "git") {
			return { status: 0, stdout: gitDiff, stderr: "" };
		}
		const sub = (args ?? [])[0] as "build" | "test" | "clippy" | undefined;
		const cfg = sub ? perSub[sub] : undefined;
		if (cfg) return { status: cfg.status, stdout: "", stderr: cfg.stderr };
		return { status: 0, stdout: "", stderr: "" };
	});
}

beforeEach(() => {
	spawn.mockReset();
});

/* ========================================================================== */
/* PURE CLASSIFIER — classifyOutOfScopeErrors                                   */
/* (the INDEPENDENTLY TESTABLE core of Phase 4)                                 */
/* ========================================================================== */

describe("classifyOutOfScopeErrors — return shape contract", () => {
	it("returns { inScopeErrors, outOfScopeErrors } arrays for any input", () => {
		const r = classifyOutOfScopeErrors([], ["data"]);
		expect(r).toHaveProperty("inScopeErrors");
		expect(r).toHaveProperty("outOfScopeErrors");
		expect(Array.isArray(r.inScopeErrors)).toBe(true);
		expect(Array.isArray(r.outOfScopeErrors)).toBe(true);
	});

	it("partitions the input into a disjoint union covering every error (no loss)", () => {
		const errs = [
			block(BUILD_LABEL_DATA, TAIL_COMPILE_DATA), // in-scope
			block(BUILD_LABEL_DATA, TAIL_COMPILE_COMPUTE), // out-of-scope
			block(TEST_LABEL_DATA, TAIL_TEST_COMPUTE), // out-of-scope
			TAIL_NO_MARKER, // in-scope (no marker)
		];
		const r = classifyOutOfScopeErrors(errs, ["data"]);
		expect(r.inScopeErrors.length + r.outOfScopeErrors.length).toBe(errs.length);
		// every original error appears in exactly one bucket, verbatim
		for (const e of errs) {
			const inIn = r.inScopeErrors.includes(e);
			const inOut = r.outOfScopeErrors.includes(e);
			expect(inIn || inOut).toBe(true);
			expect(inIn && inOut).toBe(false);
		}
	});

	it("preserves the original error-string identity (no reformatting / truncation)", () => {
		const e = block(BUILD_LABEL_DATA, TAIL_COMPILE_COMPUTE);
		const r = classifyOutOfScopeErrors([e], ["data"]);
		expect(r.outOfScopeErrors[0]).toBe(e);
	});

	it("returns fresh arrays on each call (no shared mutable reference)", () => {
		const a = classifyOutOfScopeErrors([TAIL_NO_MARKER], ["data"]);
		const b = classifyOutOfScopeErrors([TAIL_NO_MARKER], ["data"]);
		expect(a.inScopeErrors).not.toBe(b.inScopeErrors);
		expect(a.outOfScopeErrors).not.toBe(b.outOfScopeErrors);
	});
});

/* -------------------------------------------------------------------------- */
/* SCENARIO-028 — both source-path and -p package markers are recognized        */
/* -------------------------------------------------------------------------- */

describe("SCENARIO-028 — both `--> crates/<pkg>/` and `-p <pkg>` markers recognized", () => {
	it("a `--> crates/compute/` source-path marker is OUT-OF-SCOPE when compute ∉ scope", () => {
		const r = classifyOutOfScopeErrors([block(BUILD_LABEL_DATA, TAIL_COMPILE_COMPUTE)], ["data"]);
		expect(r.outOfScopeErrors).toHaveLength(1);
		expect(r.inScopeErrors).toHaveLength(0);
	});

	it("a `--> crates/data/` source-path marker is IN-SCOPE when data ∈ scope", () => {
		const r = classifyOutOfScopeErrors([block(BUILD_LABEL_DATA, TAIL_COMPILE_DATA)], ["data"]);
		expect(r.inScopeErrors).toHaveLength(1);
		expect(r.outOfScopeErrors).toHaveLength(0);
	});

	it("a cargo rerun `-p compute` test-failure marker is OUT-OF-SCOPE when compute ∉ scope", () => {
		const r = classifyOutOfScopeErrors([block(TEST_LABEL_DATA, TAIL_TEST_COMPUTE)], ["data"]);
		expect(r.outOfScopeErrors).toHaveLength(1);
		expect(r.inScopeErrors).toHaveLength(0);
	});

	it("the command label's own `-p data` is NOT counted as a crate reference (label exclusion)", () => {
		// The ONLY crate signal in this string is the label's `-p data`; the tail
		// has NO marker. With label-exclusion this is a no-marker error → IN-SCOPE.
		// (A naive whole-string regex would extract `data` from the label and could
		// wrongly behave; this pins the contract: the label's -p must be ignored.)
		const r = classifyOutOfScopeErrors([block(BUILD_LABEL_DATA, TAIL_NO_MARKER)], ["data"]);
		expect(r.inScopeErrors).toHaveLength(1);
		expect(r.outOfScopeErrors).toHaveLength(0);
	});

	it("out-of-scope requires EVERY referenced crate to be outside the scoped set", () => {
		// error references both data (in-scope via `--> crates/data/`) and compute
		// (out-of-scope via `--> crates/compute/`) → mixed → IN-SCOPE (conservative)
		const mixedTail =
			"error[E0308]: ...\n  --> crates/data/src/a.rs:1:1\n  --> crates/compute/src/b.rs:2:2";
		const r = classifyOutOfScopeErrors([block(BUILD_LABEL_DATA, mixedTail)], ["data"]);
		expect(r.inScopeErrors).toHaveLength(1);
		expect(r.outOfScopeErrors).toHaveLength(0);
	});

	it("an error touching ≥1 scoped crate is IN-SCOPE even if other crates are out-of-scope", () => {
		const tail =
			"error: ...\n  --> crates/data/src/lib.rs:3:3\n  --> crates/reports/src/x.rs:4:4\n  --> crates/store/src/y.rs:5:5";
		const r = classifyOutOfScopeErrors([tail], ["data"]);
		expect(r.inScopeErrors).toHaveLength(1);
		expect(r.outOfScopeErrors).toHaveLength(0);
	});

	it("multiple distinct out-of-scope crates with none in scope → out-of-scope", () => {
		const tail =
			"error: ...\n  --> crates/compute/src/a.rs:1:1\n  --> crates/reports/src/b.rs:2:2";
		const r = classifyOutOfScopeErrors([tail], ["data"]);
		expect(r.outOfScopeErrors).toHaveLength(1);
		expect(r.inScopeErrors).toHaveLength(0);
	});

	it("recognizes the rerun `-p` marker form `-p compute --test name` (anti-hardcode: not just source-path)", () => {
		const r = classifyOutOfScopeErrors([TAIL_TEST_COMPUTE], ["data"]);
		expect(r.outOfScopeErrors).toHaveLength(1);
	});
});

/* -------------------------------------------------------------------------- */
/* SCENARIO-009 — all-out-of-scope failures yield an in-scope pass               */
/* -------------------------------------------------------------------------- */

describe("SCENARIO-009 — all-out-of-scope failures partition into outOfScopeErrors", () => {
	it("when EVERY error references only out-of-scope crates, outOfScopeErrors holds all of them", () => {
		const errs = [
			block(BUILD_LABEL_DATA, TAIL_COMPILE_COMPUTE),
			block(TEST_LABEL_DATA, TAIL_TEST_COMPUTE),
			block(CLIPPY_LABEL_DATA, "error: ...\n  --> crates/reports/src/lib.rs:7:7"),
		];
		const r = classifyOutOfScopeErrors(errs, ["data"]);
		expect(r.outOfScopeErrors).toHaveLength(errs.length);
		expect(r.inScopeErrors).toHaveLength(0);
		// ordering preserved (first-seen)
		expect(r.outOfScopeErrors).toEqual(errs);
	});

	it("a single out-of-scope error is the only element in outOfScopeErrors", () => {
		const r = classifyOutOfScopeErrors([TAIL_COMPILE_COMPUTE], ["data"]);
		expect(r.outOfScopeErrors).toEqual([TAIL_COMPILE_COMPUTE]);
	});
});

/* -------------------------------------------------------------------------- */
/* SCENARIO-010 — any in-scope failure prevents an in-scope pass                 */
/* -------------------------------------------------------------------------- */

describe("SCENARIO-010 — an in-scope failure keeps it in inScopeErrors; out-of-scope ones still recorded", () => {
	it("a mixed batch: in-scope error in inScopeErrors, out-of-scope ones in outOfScopeErrors", () => {
		const errs = [
			block(BUILD_LABEL_DATA, TAIL_COMPILE_DATA), // in-scope (data ∈ scope)
			block(TEST_LABEL_DATA, TAIL_TEST_COMPUTE), // out-of-scope (compute ∉ scope)
			block(CLIPPY_LABEL_DATA, TAIL_NO_MARKER), // in-scope (no marker, conservative)
		];
		const r = classifyOutOfScopeErrors(errs, ["data"]);
		expect(r.inScopeErrors).toHaveLength(2);
		expect(r.outOfScopeErrors).toHaveLength(1);
		expect(r.outOfScopeErrors[0]).toBe(errs[1]);
	});

	it("even a single in-scope error among many out-of-scope ones yields a non-empty inScopeErrors", () => {
		const errs = [
			block(BUILD_LABEL_DATA, TAIL_COMPILE_COMPUTE),
			block(TEST_LABEL_DATA, TAIL_TEST_COMPUTE),
			block(CLIPPY_LABEL_DATA, TAIL_COMPILE_DATA), // the lone in-scope
		];
		const r = classifyOutOfScopeErrors(errs, ["data"]);
		expect(r.inScopeErrors).toHaveLength(1);
		expect(r.outOfScopeErrors).toHaveLength(2);
		expect(r.inScopeErrors[0]).toBe(errs[2]);
	});
});

/* -------------------------------------------------------------------------- */
/* SCENARIO-011 — ambiguous / malformed / no-marker → in-scope (conservative)   */
/* -------------------------------------------------------------------------- */

describe("SCENARIO-011 — ambiguous / no-marker errors are conservatively in-scope", () => {
	it("an error with NO parseable crate marker is in-scope", () => {
		const r = classifyOutOfScopeErrors([TAIL_NO_MARKER], ["data"]);
		expect(r.inScopeErrors).toHaveLength(1);
		expect(r.outOfScopeErrors).toHaveLength(0);
	});

	it("a bare non-cargo log line (no markers) is in-scope", () => {
		const r = classifyOutOfScopeErrors(["everything went sideways, no idea why"], ["data"]);
		expect(r.inScopeErrors).toHaveLength(1);
		expect(r.outOfScopeErrors).toHaveLength(0);
	});

	it("a malformed `-->` line with no crates/ path is in-scope", () => {
		const r = classifyOutOfScopeErrors(["error: bad\n  --> src/main.rs:1:1"], ["data"]);
		expect(r.inScopeErrors).toHaveLength(1);
		expect(r.outOfScopeErrors).toHaveLength(0);
	});

	it("an empty string error is in-scope (no marker → conservative)", () => {
		const r = classifyOutOfScopeErrors([""], ["data"]);
		expect(r.inScopeErrors).toHaveLength(1);
		expect(r.outOfScopeErrors).toHaveLength(0);
	});

	it("an EMPTY scoped set forces every error in-scope (no scoping active)", () => {
		// even a `crates/compute/` marker is in-scope when scopedSet is empty
		const r = classifyOutOfScopeErrors([TAIL_COMPILE_COMPUTE, TAIL_TEST_COMPUTE], []);
		expect(r.inScopeErrors).toHaveLength(2);
		expect(r.outOfScopeErrors).toHaveLength(0);
	});

	it("an error whose only marker is an IN-SCOPE crate is in-scope (data ∈ {data})", () => {
		const r = classifyOutOfScopeErrors([TAIL_COMPILE_DATA], ["data"]);
		expect(r.inScopeErrors).toHaveLength(1);
		expect(r.outOfScopeErrors).toHaveLength(0);
	});
});

/* -------------------------------------------------------------------------- */
/* SCENARIO-021 — robustness: never throws, degrades safely                     */
/* -------------------------------------------------------------------------- */

describe("SCENARIO-021 — classifier never throws and always degrades safely", () => {
	it("handles empty inputs without throwing", () => {
		expect(() => classifyOutOfScopeErrors([], [])).not.toThrow();
		expect(() => classifyOutOfScopeErrors([], ["data"])).not.toThrow();
		const r = classifyOutOfScopeErrors([], []);
		expect(r.inScopeErrors).toEqual([]);
		expect(r.outOfScopeErrors).toEqual([]);
	});

	it("does not throw on weird/malformed content (unicode, control chars, very long)", () => {
		const weird = [
			"\u0000\u0001\u0002",
			"-->".repeat(500),
			" crates/ / weird",
			"crates//src/x.rs", // empty package name segment
			"-p", // dangling -p with no value
			"   -p   ", // -p surrounded by whitespace, no token
		];
		expect(() => classifyOutOfScopeErrors(weird, ["data"])).not.toThrow();
		const r = classifyOutOfScopeErrors(weird, ["data"]);
		// all partitioned (none lost); malformed ones treated conservatively in-scope
		expect(r.inScopeErrors.length + r.outOfScopeErrors.length).toBe(weird.length);
	});

	it("always returns a valid partition object shape even under adversarial input", () => {
		const r = classifyOutOfScopeErrors(["x", "y"], ["a"]);
		expect(Array.isArray(r.inScopeErrors)).toBe(true);
		expect(Array.isArray(r.outOfScopeErrors)).toBe(true);
	});
});

/* -------------------------------------------------------------------------- */
/* SCENARIO-024 — only the in-scope subset is surfaced for fixing               */
/* -------------------------------------------------------------------------- */

describe("SCENARIO-024 — only the in-scope subset is surfaced (out-of-scope excluded)", () => {
	it("inScopeErrors holds EXACTLY the failures the implementer must fix", () => {
		const errs = [
			block(BUILD_LABEL_DATA, TAIL_COMPILE_DATA), // must fix (in-scope)
			block(TEST_LABEL_DATA, TAIL_TEST_COMPUTE), // pre-existing (out-of-scope)
		];
		const r = classifyOutOfScopeErrors(errs, ["data"]);
		expect(r.inScopeErrors).toEqual([errs[0]]); // ONLY the in-scope one
		expect(r.outOfScopeErrors).toEqual([errs[1]]); // noise excluded from feedback
	});

	it("outOfScopeErrors holds the pre-existing noise excluded from implementer feedback", () => {
		const r = classifyOutOfScopeErrors([TAIL_COMPILE_DATA, TAIL_COMPILE_COMPUTE], ["data"]);
		expect(r.outOfScopeErrors.every((e) => e.includes("crates/compute/"))).toBe(true);
		expect(r.inScopeErrors.every((e) => e.includes("crates/data/"))).toBe(true);
	});
});

/* ========================================================================== */
/* BuildGateResult additive fields                                             */
/* ========================================================================== */

describe("BuildGateResult — additive fields outOfScopeErrors + inScopePass", () => {
	it("every BuildGateResult carries outOfScopeErrors: string[]", () => {
		const env = withEnv();
		env.before();
		const d = rustTmp();
		try {
			routeSpawn("", {});
			const r: BuildGateResult = runBuildGate(d);
			expect(r).toHaveProperty("outOfScopeErrors");
			expect(Array.isArray(r.outOfScopeErrors)).toBe(true);
		} finally {
			rmSync(d, { recursive: true, force: true });
			env.after();
		}
	});

	it("every BuildGateResult carries inScopePass: boolean", () => {
		const env = withEnv();
		env.before();
		const d = rustTmp();
		try {
			routeSpawn("", {});
			const r: BuildGateResult = runBuildGate(d);
			expect(r).toHaveProperty("inScopePass");
			expect(typeof r.inScopePass).toBe("boolean");
		} finally {
			rmSync(d, { recursive: true, force: true });
			env.after();
		}
	});

	it("the existing pass/errors/ran fields are unchanged (additive, not breaking)", () => {
		const env = withEnv();
		env.before();
		const d = rustTmp();
		try {
			routeSpawn("", {});
			const r = runBuildGate(d);
			expect(typeof r.pass).toBe("boolean");
			expect(Array.isArray(r.errors)).toBe(true);
			expect(Array.isArray(r.ran)).toBe(true);
			expect(typeof r.buildSuccess).toBe("boolean");
			expect(typeof r.allTestsPass).toBe("boolean");
			expect(typeof r.typecheckSuccess).toBe("boolean");
		} finally {
			rmSync(d, { recursive: true, force: true });
			env.after();
		}
	});
});

/* ========================================================================== */
/* runBuildGate wiring — inScopePass / outOfScopeErrors computation             */
/* (uses the resolved scoped set; classifyOutOfScopeErrors never blocks)        */
/* ========================================================================== */

describe("runBuildGate wiring — passing gate is a no-op (SCENARIO-011 / 021)", () => {
	const env = withEnv();
	beforeEach(env.before);
	afterEach(env.after);

	it("a PASSING gate sets inScopePass=true and outOfScopeErrors=[] regardless of scope", () => {
		const d = rustTmp();
		try {
			routeSpawn("", {});
			const r = runBuildGate(d, { testPackages: ["data"] });
			expect(r.pass).toBe(true);
			expect(r.errors).toHaveLength(0);
			expect(r.inScopePass).toBe(true); // no-op when already passing
			expect(r.outOfScopeErrors).toEqual([]);
		} finally {
			rmSync(d, { recursive: true, force: true });
		}
	});

	it("a PASSING gate with zero failures never blocks on classification", () => {
		const d = rustTmp();
		try {
			routeSpawn("", {});
			const r = runBuildGate(d, { testPackages: ["data"] });
			expect(r.inScopePass).toBe(true);
			expect(r.outOfScopeErrors).toEqual([]);
		} finally {
			rmSync(d, { recursive: true, force: true });
		}
	});
});

describe("SCENARIO-009 wiring — all failures out-of-scope ⇒ inScopePass true", () => {
	const env = withEnv();
	beforeEach(env.before);
	afterEach(env.after);

	it("scope={data}; build/test/clippy all fail in crates/compute → inScopePass=true", () => {
		const d = rustTmp();
		try {
			routeSpawn("", {
				build: { status: 101, stderr: TAIL_COMPILE_COMPUTE },
				test: { status: 101, stderr: TAIL_TEST_COMPUTE },
				clippy: { status: 101, stderr: "warning: ... --> crates/compute/src/lib.rs:1:1" },
			});
			const r = runBuildGate(d, { testPackages: ["data"] });
			expect(r.pass).toBe(false);
			expect(r.errors).toHaveLength(3);
			// ALL three failures reference only out-of-scope crates → all out-of-scope
			expect(r.outOfScopeErrors).toHaveLength(3);
			expect(r.inScopePass).toBe(true);
		} finally {
			rmSync(d, { recursive: true, force: true });
		}
	});


});

describe("SCENARIO-010 wiring — mixed failures ⇒ inScopePass false, outOfScopeErrors populated", () => {
	const env = withEnv();
	beforeEach(env.before);
	afterEach(env.after);

	it("scope={data}; build fails in crates/data (in-scope), test fails in compute (out-of-scope)", () => {
		const d = rustTmp();
		try {
			routeSpawn("", {
				build: { status: 101, stderr: TAIL_COMPILE_DATA }, // in-scope
				test: { status: 101, stderr: TAIL_TEST_COMPUTE }, // out-of-scope
				// clippy passes
			});
			const r = runBuildGate(d, { testPackages: ["data"] });
			expect(r.pass).toBe(false);
			expect(r.errors).toHaveLength(2);
			expect(r.inScopePass).toBe(false); // at least one in-scope failure → no false green
			expect(r.outOfScopeErrors).toHaveLength(1); // the compute one still recorded
			// Cargo test-failure blocks carry a `-p <pkg>` rerun marker, NOT a
			// `crates/<pkg>/` source path (test rerun lines omit source paths),
			// so assert on the rerun marker that actually drives the classification.
			expect(r.outOfScopeErrors[0]).toContain("'-p compute");
		} finally {
			rmSync(d, { recursive: true, force: true });
		}
	});

	it("a lone in-scope failure among out-of-scope ones keeps inScopePass false", () => {
		const d = rustTmp();
		try {
			routeSpawn("", {
				build: { status: 101, stderr: TAIL_COMPILE_COMPUTE }, // out-of-scope
				test: { status: 101, stderr: TAIL_TEST_COMPUTE }, // out-of-scope
				clippy: { status: 101, stderr: TAIL_COMPILE_DATA }, // in-scope
			});
			const r = runBuildGate(d, { testPackages: ["data"] });
			expect(r.pass).toBe(false);
			expect(r.inScopePass).toBe(false);
			expect(r.outOfScopeErrors).toHaveLength(2); // build + test
		} finally {
			rmSync(d, { recursive: true, force: true });
		}
	});
});

describe("SCENARIO-016 parity — no scoping active never grants a false inScopePass", () => {
	const env = withEnv();
	beforeEach(env.before);
	afterEach(env.after);

	it("empty resolved set (no touched crates) ⇒ outOfScopeErrors=[] and inScopePass=false on failure", () => {
		const d = rustTmp();
		try {
			// git diff returns NO crate paths → resolved set [] → no scoping active
			routeSpawn("README.md\nCargo.toml\n", {
				build: { status: 101, stderr: TAIL_COMPILE_COMPUTE },
			});
			const r = runBuildGate(d);
			expect(r.pass).toBe(false);
			expect(r.errors.length).toBeGreaterThan(0);
			// no scoping active → classifier returns all in-scope → no false green
			expect(r.outOfScopeErrors).toEqual([]);
			expect(r.inScopePass).toBe(false);
		} finally {
			rmSync(d, { recursive: true, force: true });
		}
	});

	it("explicit empty opts.testPackages=[] forces workspace-wide ⇒ no inScopePass on failure", () => {
		const d = rustTmp();
		try {
			routeSpawn("", {
				test: { status: 101, stderr: TAIL_TEST_COMPUTE },
			});
			// explicit [] ⇒ workspace-wide (tier i), no -p in argv, scoped set []
			const r = runBuildGate(d, { testPackages: [] });
			expect(r.pass).toBe(false);
			expect(r.inScopePass).toBe(false);
			expect(r.outOfScopeErrors).toEqual([]);
		} finally {
			rmSync(d, { recursive: true, force: true });
		}
	});
});

describe("runBuildGate wiring — auto-detected scope flows into classification", () => {
	const env = withEnv();
	beforeEach(env.before);
	afterEach(env.after);

	it("git-diff touches `data`; failures all in crates/compute ⇒ inScopePass=true", () => {
		const d = rustTmp();
		try {
			routeSpawn("crates/data/src/lib.rs\n", {
				build: { status: 101, stderr: TAIL_COMPILE_COMPUTE },
				test: { status: 101, stderr: TAIL_TEST_COMPUTE },
			});
			const r = runBuildGate(d); // no explicit opts → auto-detect from git diff
			expect(r.pass).toBe(false);
			expect(r.errors).toHaveLength(2);
			expect(r.outOfScopeErrors).toHaveLength(2);
			expect(r.inScopePass).toBe(true);
		} finally {
			rmSync(d, { recursive: true, force: true });
		}
	});

	it("classification never throws on a cargo failure with unparseable stderr", () => {
		const d = rustTmp();
		try {
			routeSpawn("crates/data/src/lib.rs\n", {
				build: { status: 1, stderr: "\u0000garbage\u0000no markers at all" },
			});
			expect(() => runBuildGate(d)).not.toThrow();
			const r = runBuildGate(d);
			// unparseable → conservative in-scope → no false green
			expect(r.inScopePass).toBe(false);
			expect(r.outOfScopeErrors).toEqual([]);
		} finally {
			rmSync(d, { recursive: true, force: true });
		}
	});
});

/* ========================================================================== */
/* Anti-hardcoding guards — varied package names defeat literal/lookup shortcuts */
/* ========================================================================== */

describe("anti-hardcoding — varied package names force generalization", () => {
	it("out-of-scope detection works for arbitrary crate names, not a fixed list", () => {
		// scoped set uses an uncommon name to defeat a `data`/`compute` lookup table
		const r = classifyOutOfScopeErrors(
			["error: ...\n  --> crates/zzz_uncommon/src/lib.rs:1:1"],
			["alpha_pkg"],
		);
		expect(r.outOfScopeErrors).toHaveLength(1);
	});

	it("in-scope detection matches the scoped member regardless of its name", () => {
		const r = classifyOutOfScopeErrors(
			["error: ...\n  --> crates/alpha_pkg/src/lib.rs:1:1"],
			["alpha_pkg", "beta_pkg"],
		);
		expect(r.inScopeErrors).toHaveLength(1);
		expect(r.outOfScopeErrors).toHaveLength(0);
	});

	it("a different scoped set flips the SAME error from out-of-scope to in-scope", () => {
		const err = "error: ...\n  --> crates/compute/src/lib.rs:1:1";
		expect(classifyOutOfScopeErrors([err], ["data"]).outOfScopeErrors).toHaveLength(1);
		expect(classifyOutOfScopeErrors([err], ["compute"]).inScopeErrors).toHaveLength(1);
	});

	it("rerun `-p` marker also generalizes to arbitrary names", () => {
		const r = classifyOutOfScopeErrors(
			["error: test failed, to rerun pass '-p widgets --test thing_test'"],
			["data"],
		);
		expect(r.outOfScopeErrors).toHaveLength(1);
	});
});
