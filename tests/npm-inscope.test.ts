/**
 * Phase 5 — npm/vitest/jest in-scope failure classification — RED phase.
 *
 * Defines the Gap 4 / AC-04 contract for the npm-family in-scope classifier
 * BEFORE the implementation exists:
 *   - `parseFailingNpmTestFiles(combinedOutput): string[]` — pure, never throws.
 *     Matches vitest `❯\s*(<path>)` (strips a trailing `:line:col`) and jest
 *     `^FAIL\s+(<path>)` markers; returns de-duplicated RAW file paths, or `[]`.
 *   - `runBuildGate` npm-family wiring — after a FAILED npm/vitest/jest test
 *     step, compute `touchedFilePaths(cwd, baseRef)`, parse the failing test
 *     files, classify each OUT-of-scope iff absent from `touched`, and populate
 *     `outOfScopeErrors` / `inScopePass` EXACTLY mirroring the cargo path
 *     (`inScopePass = pass || (errors.length>0 && outOfScopeErrors.length===errors.length)`).
 *     Degrades conservatively to in-scope on ANY ambiguity, empty touched set,
 *     or unparseable output (grants NO false green).
 *
 * RED status: `parseFailingNpmTestFiles` does NOT exist yet and `runBuildGate`'s
 * npm branch carries no in-scope classification (the resolved npm scope is always
 * `[]`, so `outOfScopeErrors` is always `[]` and `inScopePass` mirrors `pass`),
 * so every assertion referencing the npm classifier fails until Phase 5 lands.
 *
 * The cargo branch (`classifyOutOfScopeErrors` + `crates/<pkg>/` markers) is
 * byte-for-byte UNCHANGED — pinned here by a smoke test and fully covered by the
 * existing build-runner-inscope-classification suite.
 *
 * Coverage map:
 *   - `parseFailingNpmTestFiles` pure unit tests (the INDEPENDENTLY TESTABLE core)
 *     → `describe("parseFailingNpmTestFiles …")`.
 *   - runBuildGate npm wiring (SCENARIO parity with cargo in/out-of-scope) →
 *     `describe("runBuildGate npm wiring …")`.
 *   - conservative degradation (no false green) → `describe("degradation …")`.
 *   - anti-hardcoding (arbitrary file names defeat fixed lookup tables) →
 *     `describe("anti-hardcoding …")`.
 *   - cargo branch unchanged smoke → `describe("cargo branch unchanged …")`.
 *
 * Hermetic: `node:child_process.spawnSync` is mocked so NO real git/vitest/jest
 * /cargo runs. A real temp `package.json` makes `detectProjectCommands` report
 * an npm-family language so the test step is the only command executed.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Mock the ONLY side-effects runBuildGate + touchedFilePaths perform: spawnSync.
// Real git/vitest/jest/cargo must NEVER run in CI. Routes configured per-test.
vi.mock("node:child_process", () => ({
	spawnSync: vi.fn(),
}));

import {
	parseFailingNpmTestFiles,
	runBuildGate,
	type BuildGateResult,
} from "../src/build-runner.ts";
import { spawnSync } from "node:child_process";

const spawn = spawnSync as unknown as ReturnType<typeof vi.fn>;
const BASE_REF_ENV = "SUPER_DEV_GATE_BASE_REF";
const PKG_ENV = "SUPER_DEV_BUILD_TEST_PACKAGES";

/* -------------------------------------------------------------------------- */
/* Realistic vitest / jest failure fixtures                                     */
/* -------------------------------------------------------------------------- */

/**
 * A vitest FAIL block whose `❯` pointer names an UNTOUCHED test file. Real
 * vitest emits the `FAIL  <path> [ <path> ]` summary line AND a per-assertion
 * `❯ <path>:line:col` pointer; the `❯` pointer is the authoritative failing-file
 * signal. The parser must return `src/untouched.test.ts` (NO `:4:5` suffix).
 */
const VITEST_FAIL_UNTOUCHED =
	"FAIL  src/untouched.test.ts [ src/untouched.test.ts ]\n" +
	" ❯ src/untouched.test.ts:4:5\n" +
	"  4 | expect(true).toBe(false)\n" +
	"     |       |            |\n" +
	"Tests  1 failed (1)";

/** A vitest FAIL block whose `❯` pointer names a TOUCHED test file. */
const VITEST_FAIL_TOUCHED =
	"FAIL  src/fail.test.ts [ src/fail.test.ts ]\n" +
	" ❯ src/fail.test.ts:8:3\n" +
	"Tests  1 failed (1)";

/** A jest FAIL block naming an UNTOUCHED test file (line-start `FAIL <path>`). */
const JEST_FAIL_UNTOUCHED =
	"FAIL src/untouched.test.js\n" +
	"  ● test suite failed to run\n" +
	"Tests: 2 failed, 3 passed";

/** A jest FAIL block naming a TOUCHED test file. */
const JEST_FAIL_TOUCHED = "FAIL src/fail.test.js\nTests: 1 failed, 0 passed";

/* -------------------------------------------------------------------------- */
/* Test scaffolding                                                            */
/* -------------------------------------------------------------------------- */

/** A real npm/frontend temp worktree (package.json with a test script). */
function npmTmp(tag = "sd-npm-inscope-"): string {
	const dir = mkdtempSync(join(tmpdir(), tag));
	// react devDep ⇒ detectProjectCommands reports `language:"frontend"` (npm
	// family). Only a `test` script is declared so ONLY the test step runs in
	// runBuildGate (build/typecheck are undefined → skipped), giving exactly one
	// error block and clean in-scope assertions.
	writeFileSync(
		join(dir, "package.json"),
		JSON.stringify({
			scripts: { test: "vitest run" },
			devDependencies: { vitest: "1", react: "19" },
		}),
	);
	return dir;
}

/** A real rust temp worktree (Cargo.toml present) → detectProjectCommands ⇒ rust. */
function rustTmp(tag = "sd-cargo-smoke-"): string {
	const dir = mkdtempSync(join(tmpdir(), tag));
	writeFileSync(join(dir, "Cargo.toml"), "");
	return dir;
}

/** Save/restore the env vars runBuildGate / touchedFilePaths read. */
function withEnv() {
	let savedRef: string | undefined;
	let savedPkg: string | undefined;
	return {
		before() {
			savedRef = process.env[BASE_REF_ENV];
			savedPkg = process.env[PKG_ENV];
			delete process.env[BASE_REF_ENV];
			delete process.env[PKG_ENV];
		},
		after() {
			if (savedRef === undefined) delete process.env[BASE_REF_ENV];
			else process.env[BASE_REF_ENV] = savedRef;
			if (savedPkg === undefined) delete process.env[PKG_ENV];
			else process.env[PKG_ENV] = savedPkg;
		},
	};
}

/**
 * Route spawnSync for an npm-family project: `git` (both `diff` and `ls-files`)
 * returns `gitDiff`; the `npm run test` step returns the configured status +
 * stdout when `testFail` is given, or exits 0 (passing) when null.
 */
function routeNpm(
	gitDiff: string,
	testFail: { status: number; stdout: string } | null,
): void {
	spawn.mockImplementation((cmd: string, args: string[]) => {
		if (cmd === "git") {
			// touchedFilePaths runs both `diff --merge-base <ref> --name-only` and
			// `ls-files --others --exclude-standard`; route both to the same set.
			return { status: 0, stdout: gitDiff, stderr: "" };
		}
		if (cmd === "npm" && args[0] === "run" && args[1] === "test") {
			if (testFail) return { status: testFail.status, stdout: testFail.stdout, stderr: "" };
			return { status: 0, stdout: "", stderr: "" };
		}
		return { status: 0, stdout: "", stderr: "" };
	});
}

/** Route spawnSync so every `git` invocation FAILS (non-zero) → touchedFilePaths ⇒ []. */
function routeGitError(): void {
	spawn.mockImplementation((cmd: string) => {
		if (cmd === "git") return { status: 128, stdout: "", stderr: "fatal: not a git repo" };
		return { status: 0, stdout: "", stderr: "" };
	});
}

beforeEach(() => {
	spawn.mockReset();
});

/* ========================================================================== */
/* PURE CLASSIFIER — parseFailingNpmTestFiles                                   */
/* (the INDEPENDENTLY TESTABLE core of Phase 5)                                 */
/* ========================================================================== */

describe("parseFailingNpmTestFiles — return shape contract", () => {
	it("returns a string[] for any input", () => {
		const r = parseFailingNpmTestFiles(VITEST_FAIL_UNTOUCHED);
		expect(Array.isArray(r)).toBe(true);
		for (const p of r) expect(typeof p).toBe("string");
	});

	it("returns [] for empty / no-marker input", () => {
		expect(parseFailingNpmTestFiles("")).toEqual([]);
		expect(parseFailingNpmTestFiles("everything is fine, no failures")).toEqual([]);
		expect(parseFailingNpmTestFiles("Tests  5 passed (5)")).toEqual([]);
	});
});

describe("parseFailingNpmTestFiles — vitest `❯ <path>:line:col` marker", () => {
	it("extracts the file path from a vitest `❯` pointer, STRIPPING the `:line:col`", () => {
		const r = parseFailingNpmTestFiles(VITEST_FAIL_UNTOUCHED);
		expect(r).toContain("src/untouched.test.ts");
		// the trailing `:4:5` MUST be stripped so the path matches a raw git path
		expect(r.every((p) => !/:4:5$/.test(p))).toBe(true);
	});

	it("handles a leading-space `❯` pointer (real vitest indents the pointer)", () => {
		const r = parseFailingNpmTestFiles(" ❯ src/widgets/Button.test.tsx:12:3");
		expect(r).toEqual(["src/widgets/Button.test.tsx"]);
	});

	it("strips a single `:line` suffix (no column) too", () => {
		const r = parseFailingNpmTestFiles("❯ src/a.test.ts:7");
		expect(r).toEqual(["src/a.test.ts"]);
	});
});

describe("parseFailingNpmTestFiles — jest `FAIL <path>` marker", () => {
	it("extracts the file path from a line-start jest `FAIL <path>` summary", () => {
		const r = parseFailingNpmTestFiles(JEST_FAIL_UNTOUCHED);
		expect(r).toContain("src/untouched.test.js");
	});

	it("a `FAIL` NOT at line start is not parsed as a jest path (anchored)", () => {
		// the spec anchors jest at `^FAIL`; a mid-sentence FAIL must not leak.
		const r = parseFailingNpmTestFiles("warning: the build did FAIL something here");
		expect(r).toEqual([]);
	});
});

describe("parseFailingNpmTestFiles — de-dup + ordering", () => {
	it("returns multiple DISTINCT failing files in first-seen order", () => {
		const out =
			" ❯ src/a.test.ts:1:1\n" +
			" ❯ src/b.test.ts:2:2\n" +
			" ❯ src/c.test.ts:3:3";
		expect(parseFailingNpmTestFiles(out)).toEqual([
			"src/a.test.ts",
			"src/b.test.ts",
			"src/c.test.ts",
		]);
	});

	it("de-duplicates the SAME file referenced by multiple markers", () => {
		const out =
			" ❯ src/once.test.ts:1:1\n" +
			" ❯ src/once.test.ts:9:4\n" +
			" ❯ src/once.test.ts:20:2";
		expect(parseFailingNpmTestFiles(out)).toEqual(["src/once.test.ts"]);
	});

	it("de-duplicates the same file appearing in BOTH vitest and jest forms", () => {
		const out = "❯ src/shared.test.js:5:5\nFAIL src/shared.test.js";
		expect(parseFailingNpmTestFiles(out)).toEqual(["src/shared.test.js"]);
	});
});

/* ========================================================================== */
/* parseFailingNpmTestFiles — robustness (never throws, degrades to [])        */
/* ========================================================================== */

describe("parseFailingNpmTestFiles — never throws; degrades to []", () => {
	it("does not throw on non-string / null / undefined input", () => {
		expect(() => parseFailingNpmTestFiles(null as unknown as string)).not.toThrow();
		expect(() => parseFailingNpmTestFiles(undefined as unknown as string)).not.toThrow();
		expect(() => parseFailingNpmTestFiles(123 as unknown as string)).not.toThrow();
		expect(parseFailingNpmTestFiles(null as unknown as string)).toEqual([]);
	});

	it("does not throw on adversarial content (control chars, very long, unicode)", () => {
		const weird = ["\u0000\u0001\u0002", "❯".repeat(5000), "❯\n".repeat(2000), "🦀 unicode path"];
		for (const w of weird) {
			expect(() => parseFailingNpmTestFiles(w)).not.toThrow();
		}
		expect(Array.isArray(parseFailingNpmTestFiles(weird[1]))).toBe(true);
	});

	it("returns [] when a `❯` pointer has no path token", () => {
		expect(parseFailingNpmTestFiles("❯\n❯   ")).toEqual([]);
	});
});

/* ========================================================================== */
/* parseFailingNpmTestFiles — anti-hardcoding (arbitrary file names)            */
/* ========================================================================== */

describe("parseFailingNpmTestFiles — anti-hardcoding (arbitrary paths generalize)", () => {
	it("extracts deeply-nested uncommon paths, not a fixed `src/*.test.ts` list", () => {
		const r = parseFailingNpmTestFiles("❯ packages/zzz_uncommon/__tests__/thing.spec.ts:42:9");
		expect(r).toEqual(["packages/zzz_uncommon/__tests__/thing.spec.ts"]);
	});

	it("extracts a jest path with arbitrary directory depth", () => {
		const r = parseFailingNpmTestFiles("FAIL apps/web/src/lib/utils.test.js");
		expect(r).toContain("apps/web/src/lib/utils.test.js");
	});

	it("the SAME path is returned regardless of which marker form points at it", () => {
		const p = "src/deeply/nested/widget.test.ts";
		expect(parseFailingNpmTestFiles(`❯ ${p}:1:1`)).toEqual([p]);
		expect(parseFailingNpmTestFiles(`FAIL ${p}`)).toEqual([p]);
	});
});

/* ========================================================================== */
/* runBuildGate npm wiring — inScopePass / outOfScopeErrors computation         */
/* (uses touchedFilePaths ∩ failing test files; never grants a false green)     */
/* ========================================================================== */

describe("runBuildGate npm wiring — passing gate is a no-op", () => {
	const env = withEnv();
	beforeEach(env.before);
	afterEach(env.after);

	it("a PASSING npm gate sets inScopePass=true and outOfScopeErrors=[] regardless of touched set", () => {
		const d = npmTmp();
		try {
			routeNpm("src/anything.test.ts\n", null); // test exits 0
			const r: BuildGateResult = runBuildGate(d);
			expect(r.pass).toBe(true);
			expect(r.errors).toHaveLength(0);
			expect(r.inScopePass).toBe(true);
			expect(r.outOfScopeErrors).toEqual([]);
		} finally {
			rmSync(d, { recursive: true, force: true });
		}
	});
});

describe("runBuildGate npm wiring — all failures out-of-scope ⇒ inScopePass true", () => {
	const env = withEnv();
	beforeEach(env.before);
	afterEach(env.after);

	it("vitest fails in an UNTOUCHED file (git touches OTHER files) ⇒ outOfScopeErrors populated, inScopePass=true", () => {
		const d = npmTmp();
		try {
			// touched set does NOT contain src/untouched.test.ts
			routeNpm("src/other.test.ts\nsrc/lib.ts\n", { status: 1, stdout: VITEST_FAIL_UNTOUCHED });
			const r = runBuildGate(d);
			expect(r.pass).toBe(false);
			expect(r.errors.length).toBeGreaterThanOrEqual(1);
			// the failing file is OUT-of-scope ⇒ surfaced in outOfScopeErrors, NOT blocking
			expect(r.outOfScopeErrors.length).toBeGreaterThanOrEqual(1);
			expect(r.inScopePass).toBe(true);
			// the surfaced block is the FULL assembled error (label + vitest tail)
			expect(r.outOfScopeErrors.some((e) => e.includes("src/untouched.test.ts"))).toBe(true);
		} finally {
			rmSync(d, { recursive: true, force: true });
		}
	});

	it("jest `FAIL <untouched-file>` ⇒ outOfScopeErrors populated, inScopePass=true", () => {
		const d = npmTmp();
		try {
			routeNpm("README.md\n", { status: 1, stdout: JEST_FAIL_UNTOUCHED });
			const r = runBuildGate(d);
			expect(r.pass).toBe(false);
			expect(r.outOfScopeErrors.length).toBeGreaterThanOrEqual(1);
			expect(r.inScopePass).toBe(true);
		} finally {
			rmSync(d, { recursive: true, force: true });
		}
	});
});

describe("runBuildGate npm wiring — any in-scope failure ⇒ inScopePass false", () => {
	const env = withEnv();
	beforeEach(env.before);
	afterEach(env.after);

	it("vitest fails in a TOUCHED file (git touches that exact file) ⇒ inScopePass=false (blocks)", () => {
		const d = npmTmp();
		try {
			// touched set CONTAINS src/fail.test.ts
			routeNpm("src/fail.test.ts\n", { status: 1, stdout: VITEST_FAIL_TOUCHED });
			const r = runBuildGate(d);
			expect(r.pass).toBe(false);
			expect(r.outOfScopeErrors).toEqual([]); // in-scope failure never lands here
			expect(r.inScopePass).toBe(false); // genuine in-scope failure → no false green
		} finally {
			rmSync(d, { recursive: true, force: true });
		}
	});

	it("jest `FAIL <touched-file>` ⇒ inScopePass=false (blocks)", () => {
		const d = npmTmp();
		try {
			routeNpm("src/fail.test.js\n", { status: 1, stdout: JEST_FAIL_TOUCHED });
			const r = runBuildGate(d);
			expect(r.pass).toBe(false);
			expect(r.inScopePass).toBe(false);
			expect(r.outOfScopeErrors).toEqual([]);
		} finally {
			rmSync(d, { recursive: true, force: true });
		}
	});

	it("mixed: one TOUCHED + one UNTOUCHED failing file ⇒ inScopePass=false (conservative)", () => {
		const d = npmTmp();
		try {
			// touched set contains src/fail.test.ts but NOT src/untouched.test.ts
			const mixed =
				" ❯ src/untouched.test.ts:4:5\n" +
				" ❯ src/fail.test.ts:9:1\n" +
				"Tests  2 failed (2)";
			routeNpm("src/fail.test.ts\n", { status: 1, stdout: mixed });
			const r = runBuildGate(d);
			expect(r.pass).toBe(false);
			// ≥1 in-scope failure ⇒ the whole gate is NOT in-scope-passing
			expect(r.inScopePass).toBe(false);
		} finally {
			rmSync(d, { recursive: true, force: true });
		}
	});
});

/* ========================================================================== */
/* runBuildGate npm wiring — conservative degradation (no false green)          */
/* ========================================================================== */

describe("runBuildGate npm wiring — degradation grants NO false green", () => {
	const env = withEnv();
	beforeEach(env.before);
	afterEach(env.after);

	it("unparseable vitest output (no `❯`/`FAIL` marker) ⇒ conservative in-scope", () => {
		const d = npmTmp();
		try {
			routeNpm("src/other.test.ts\n", {
				status: 1,
				stdout: "something went wrong, no idea why\nError: boom",
			});
			const r = runBuildGate(d);
			expect(r.pass).toBe(false);
			expect(r.outOfScopeErrors).toEqual([]); // ambiguous → never out-of-scope
			expect(r.inScopePass).toBe(false); // conservative → no false green
		} finally {
			rmSync(d, { recursive: true, force: true });
		}
	});

	it("EMPTY touched set (git diff returns nothing) ⇒ conservative in-scope", () => {
		const d = npmTmp();
		try {
			// no touched files ⇒ cannot prove out-of-scope ⇒ treat as in-scope
			routeNpm("", { status: 1, stdout: VITEST_FAIL_UNTOUCHED });
			const r = runBuildGate(d);
			expect(r.pass).toBe(false);
			expect(r.outOfScopeErrors).toEqual([]);
			expect(r.inScopePass).toBe(false);
		} finally {
			rmSync(d, { recursive: true, force: true });
		}
	});

	it("git spawn ERROR (touchedFilePaths ⇒ []) ⇒ conservative in-scope", () => {
		const d = npmTmp();
		try {
			routeGitError();
			// configure the npm test failure AFTER the git-error router (append route)
			spawn.mockImplementation((cmd: string, args: string[]) => {
				if (cmd === "git") return { status: 128, stdout: "", stderr: "fatal" };
				if (cmd === "npm" && args[0] === "run" && args[1] === "test") {
					return { status: 1, stdout: VITEST_FAIL_UNTOUCHED, stderr: "" };
				}
				return { status: 0, stdout: "", stderr: "" };
			});
			const r = runBuildGate(d);
			expect(r.pass).toBe(false);
			expect(r.outOfScopeErrors).toEqual([]); // empty touched → in-scope
			expect(r.inScopePass).toBe(false);
		} finally {
			rmSync(d, { recursive: true, force: true });
		}
	});

	it("runBuildGate never throws when the npm test step fails with adversarial stdout", () => {
		const d = npmTmp();
		try {
			routeNpm("src/other.test.ts\n", { status: 1, stdout: "\u0000garbage\u0000no markers" });
			expect(() => runBuildGate(d)).not.toThrow();
		} finally {
			rmSync(d, { recursive: true, force: true });
		}
	});
});

describe("runBuildGate npm wiring — BuildGateResult fields stay additive", () => {
	const env = withEnv();
	beforeEach(env.before);
	afterEach(env.after);

	it("the existing pass/errors/ran/buildSuccess/allTestsPass/typecheckSuccess fields are present", () => {
		const d = npmTmp();
		try {
			routeNpm("", null);
			const r = runBuildGate(d);
			expect(typeof r.pass).toBe("boolean");
			expect(Array.isArray(r.errors)).toBe(true);
			expect(Array.isArray(r.ran)).toBe(true);
			expect(typeof r.buildSuccess).toBe("boolean");
			expect(typeof r.allTestsPass).toBe("boolean");
			expect(typeof r.typecheckSuccess).toBe("boolean");
			expect(Array.isArray(r.outOfScopeErrors)).toBe(true);
			expect(typeof r.inScopePass).toBe("boolean");
		} finally {
			rmSync(d, { recursive: true, force: true });
		}
	});
});

/* ========================================================================== */
/* Cargo branch byte-for-byte UNCHANGED smoke                                  */
/* (the npm classifier must NOT perturb the existing cargo in-scope path)      */
/* ========================================================================== */

describe("cargo branch unchanged — crates/<pkg>/ classification still active", () => {
	const env = withEnv();
	beforeEach(env.before);
	afterEach(env.after);

	it("rust repo: scope={data}, build fails in crates/compute ⇒ outOfScopeErrors populated, inScopePass=true", () => {
		const d = rustTmp();
		try {
			// git diff touches crates/data (auto-detect resolves to `data`); cargo
			// metadata + build are routed so compute is the out-of-scope failure.
			const computeTail =
				"error[E0308]: mismatched types\n  --> crates/compute/src/jobs.rs:42:10";
			spawn.mockImplementation((cmd: string, args: string[]) => {
				if (cmd === "git") return { status: 0, stdout: "crates/data/src/lib.rs\n", stderr: "" };
				if (cmd === "cargo" && args[0] === "metadata") {
					return {
						status: 0,
						stdout: JSON.stringify({
							packages: [
								{ name: "data", manifest_path: "crates/data/Cargo.toml" },
								{ name: "compute", manifest_path: "crates/compute/Cargo.toml" },
							],
						}),
						stderr: "",
					};
				}
				if (cmd === "cargo" && args[0] === "build") {
					return { status: 101, stdout: "", stderr: computeTail };
				}
				return { status: 0, stdout: "", stderr: "" };
			});
			const r = runBuildGate(d); // auto-detect scope {data}
			expect(r.pass).toBe(false);
			expect(r.outOfScopeErrors.length).toBeGreaterThanOrEqual(1);
			expect(r.inScopePass).toBe(true); // cargo path still grants the in-scope pass
		} finally {
			rmSync(d, { recursive: true, force: true });
		}
	});
});
