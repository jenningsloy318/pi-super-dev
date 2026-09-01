// Coverage gate tests (v0.3.49). Layers follow docs/testing-strategy.md:
// L0 pure parser tests (fixture strings, no toolchain), L2 real-toolchain
// lanes that execute real node --test / vitest / go runs in temp projects.
// Real lanes are skipped when the toolchain is absent (CI variance), except
// node itself which this suite requires anyway.

import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
	coverageGateEnabled,
	coverageMatches,
	coverageThreshold,
	parseGoCoverProfile,
	parseNodeTapCoverage,
	parseVitestSummary,
	pickCoverageRecipe,
	runCoverageGate,
} from "../src/build-runner/coverage-gate.ts";
import type { TestRunnerSpec } from "../src/build-runner/runner-discovery.ts";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) { try { rmSync(d, { recursive: true, force: true }); } catch { /* ok */ } } });
const tempDir = () => { const d = mkdtempSync(join(tmpdir(), "covtest-")); dirs.push(d); return d; };

const spec = (command: string, cwd?: string): TestRunnerSpec => ({ version: 1, command, ...(cwd ? { cwd } : {}), resultFormat: "tap", discoveredAt: new Date().toISOString() });

// ─── L0: pure ────────────────────────────────────────────────────────────────

describe("coverage gate config", () => {
	it("default threshold is 85; SUPER_DEV_COVERAGE_THRESHOLD overrides", () => {
		const saved = process.env.SUPER_DEV_COVERAGE_THRESHOLD;
		try {
			expect(coverageThreshold()).toBe(85);
			process.env.SUPER_DEV_COVERAGE_THRESHOLD = "95";
			expect(coverageThreshold()).toBe(95);
			process.env.SUPER_DEV_COVERAGE_THRESHOLD = "bogus";
			expect(coverageThreshold()).toBe(85);
			process.env.SUPER_DEV_COVERAGE_THRESHOLD = "0";
			expect(coverageThreshold()).toBe(85); // out-of-range ignored
		} finally {
			if (saved === undefined) delete process.env.SUPER_DEV_COVERAGE_THRESHOLD; else process.env.SUPER_DEV_COVERAGE_THRESHOLD = saved;
		}
	});
	it("kill switch skips the gate", () => {
		const saved = process.env.SUPER_DEV_NO_COVERAGE_GATE;
		try {
			process.env.SUPER_DEV_NO_COVERAGE_GATE = "1";
			expect(coverageGateEnabled()).toBe(false);
			const r = runCoverageGate("/nonexistent", { runnerSpec: spec("node --test x.test.mjs"), phaseFiles: ["src/a.ts"], testFiles: [] });
			expect(r.status).toBe("skipped");
		} finally {
			if (saved === undefined) delete process.env.SUPER_DEV_NO_COVERAGE_GATE; else process.env.SUPER_DEV_NO_COVERAGE_GATE = saved;
		}
	});
});

describe("pickCoverageRecipe", () => {
	it("vitest / npm-exec vitest → vitest", () => {
		expect(pickCoverageRecipe("npm exec vitest run --reporter=tap tests/agent-roster.test.ts")).toBe("vitest");
		expect(pickCoverageRecipe("npx vitest run tests/x.test.ts")).toBe("vitest");
	});
	it("node --test → node-test", () => {
		expect(pickCoverageRecipe("node --test --test-reporter=tap tests/phase1.test.mjs")).toBe("node-test");
	});
	it("go test → go", () => {
		expect(pickCoverageRecipe("go test ./...")).toBe("go");
	});
	it("unknown families → null (unmeasurable)", () => {
		expect(pickCoverageRecipe("pytest tests/")).toBeNull();
		expect(pickCoverageRecipe("npm run gradle:test")).toBeNull();
		expect(pickCoverageRecipe("./gradlew test")).toBeNull();
	});
});

describe("coverageMatches", () => {
	it("matches equality, absolute-prefix, and either-direction suffix", () => {
		expect(coverageMatches("src/big.js", ["src/big.js"])).toBe(true);
		expect(coverageMatches("/repo/src/big.js", ["src/big.js"])).toBe(true);
		expect(coverageMatches("src/big.js", ["/repo/src/big.js"])).toBe(true);
		expect(coverageMatches("module/src/big.js", ["src/big.js"])).toBe(true);
		expect(coverageMatches("src/other.js", ["src/big.js"])).toBe(false);
	});
});

describe("parseGoCoverProfile (fixture — L0)", () => {
	it("aggregates per-file statement coverage", () => {
		const fixture = [
			"mode: set",
			"covgo/math.go:4.2,6.1 2 1",
			"covgo/math.go:9.2,12.1 3 0",
			"covgo/util.go:2.2,3.1 1 1",
			"",
		].join("\n");
		const m = parseGoCoverProfile(fixture);
		expect(m.get("covgo/math.go")).toEqual({ covered: 2, total: 5 });
		expect(m.get("covgo/util.go")).toEqual({ covered: 1, total: 1 });
	});
});

describe("parseNodeTapCoverage (fixture — L0, from the 2026-08-31 ground-truth lane)", () => {
	it("rebuilds tree paths and reads pcts + uncovered hints", () => {
		const fixture = [
			"# start of coverage report",
			"# ----------------------------------------------------------",
			"# file      | line % | branch % | funcs % | uncovered lines",
			"# ----------------------------------------------------------",
			"# src       |        |          |         | ",
			"#  big.js   |  55.56 |   100.00 |   50.00 | 6-9",
			"#  lib      |        |          |         | ",
			"#    deep.js | 100.00 |   100.00 |  100.00 | ",
			"# ----------------------------------------------------------",
			"# all files |  70.00 |   100.00 |   60.00 | ",
			"# ----------------------------------------------------------",
			"# end of coverage report",
		].join("\n");
		const rows = parseNodeTapCoverage(fixture);
		expect(rows).toContainEqual({ file: "src/big.js", linesPct: 55.56, branchesPct: 100, functionsPct: 50, uncoveredHint: "6-9" });
		expect(rows).toContainEqual({ file: "src/lib/deep.js", linesPct: 100, branchesPct: 100, functionsPct: 100 });
		expect(rows.some((r) => r.file.startsWith("all files"))).toBe(false);
	});
});

describe("parseVitestSummary (fixture — L0)", () => {
	it("reads per-file axes and skips total", () => {
		const json = {
			total: { lines: { pct: 62.5, covered: 5, total: 8 } },
			"/repo/src.mjs": { lines: { pct: 62.5, covered: 5, total: 8 }, functions: { pct: 50 }, branches: { pct: 100 } },
		};
		const rows = parseVitestSummary(json);
		expect(rows).toEqual([{ file: "/repo/src.mjs", linesPct: 62.5, functionsPct: 50, branchesPct: 100 }]);
	});
});

// ─── L2: real toolchain lanes ────────────────────────────────────────────────

function nodeAvailable(): boolean {
	return (spawnSync(process.execPath, ["--version"], { encoding: "utf8" })?.stdout ?? "").startsWith("v");
}

describe("runCoverageGate — node --test (real run)", () => {
	it.skipIf(!nodeAvailable())("gates below-threshold phase files and passes covered ones", () => {
		const d = tempDir();
		mkdirSync(join(d, "src"));
		mkdirSync(join(d, "tests"));
		writeFileSync(join(d, "src", "big.js"), [
			"export function covered(a) {",
			"  const x = a + 1;",
			"  return x;",
			"}",
			"export function notCovered(a) {",
			"  const y = a * 2;",
			"  const z = y + 1;",
			"  return z;",
			"}",
			"",
		].join("\n"));
		writeFileSync(join(d, "src", "tiny.js"), [
			"export function t() {",
			"  return 1;",
			"}",
			"",
		].join("\n"));
		writeFileSync(join(d, "tests", "big.test.mjs"), [
			'import { test } from "node:test";',
			'import assert from "node:assert/strict";',
			'import { covered } from "../src/big.js";',
			'import { t as tiny } from "../src/tiny.js";',
			'test("covered", () => { assert.equal(covered(1), 2); });',
			'test("tiny", () => { assert.equal(tiny(), 1); });',
			"",
		].join("\n"));
		const runner = spec(`node --test --test-reporter=tap tests/big.test.mjs`);
		// big.js is below the floor → below-threshold
		const low = runCoverageGate(d, { runnerSpec: runner, phaseFiles: ["src/big.js"], testFiles: ["tests/big.test.mjs"] });
		expect(low.status).toBe("below-threshold");
		expect(low.recipe).toBe("node-test");
		expect(low.linesPct).toBeDefined();
		expect((low.linesPct ?? 0)).toBeLessThan(85);
		expect(low.detail).toContain("src/big.js");
		expect(low.detail).toContain("floor");
		// tiny.js fully covered → pass
		const ok = runCoverageGate(d, { runnerSpec: runner, phaseFiles: ["src/tiny.js"], testFiles: ["tests/big.test.mjs"] });
		expect(ok.status).toBe("pass");
		expect(ok.linesPct).toBe(100);
	});
	it.skipIf(!nodeAvailable())("unmeasurable for an unknown runner family", () => {
		const d = tempDir();
		const r = runCoverageGate(d, { runnerSpec: spec("pytest tests/"), phaseFiles: ["src/a.py"], testFiles: [] });
		expect(r.status).toBe("unmeasurable");
		expect(r.detail).toContain("hard gate");
		expect(r.detail).toContain("SUPER_DEV_NO_COVERAGE_GATE");
	});
	it.skipIf(!nodeAvailable())("skipped when phase files are empty or all test files", () => {
		const d = tempDir();
		expect(runCoverageGate(d, { runnerSpec: spec("node --test x.test.mjs"), phaseFiles: [], testFiles: [] }).status).toBe("skipped");
		expect(runCoverageGate(d, { runnerSpec: spec("node --test x.test.mjs"), phaseFiles: ["tests/x.test.mjs"], testFiles: ["tests/x.test.mjs"] }).status).toBe("skipped");
	});
});

describe("runCoverageGate — vitest (real run)", () => {
	it("measures via json-summary with true line counts", () => {
		const d = tempDir();
		// Reuse THIS repo's vitest + coverage provider via a node_modules symlink.
		symlinkSync("/home/jenningsl/development/personal/jenningsloy318/pi-super-dev/node_modules", join(d, "node_modules"));
		writeFileSync(join(d, "src.mjs"), [
			"export function cov(a) {",
			"  const x = a + 1;",
			"  return x;",
			"}",
			"export function uncov(a) {",
			"  const y = a * 2;",
			"  return y;",
			"}",
			"",
		].join("\n"));
		mkdirSync(join(d, "tests"));
		writeFileSync(join(d, "tests", "a.test.mjs"), [
			'import { test, expect } from "vitest";',
			'import { cov } from "../src.mjs";',
			'test("cov", () => { expect(cov(1)).toBe(2); });',
			"",
		].join("\n"));
		const runner = spec("vitest run tests/a.test.mjs");
		const low = runCoverageGate(d, { runnerSpec: runner, phaseFiles: ["src.mjs"], testFiles: ["tests/a.test.mjs"], timeoutMs: 180_000 });
		expect(low.status).toBe("below-threshold");
		expect(low.linesPct).toBeLessThan(85);
		// The out-of-scope vitest internals are never reported as phase files.
		expect(low.perFile.every((f) => f.file.endsWith("src.mjs"))).toBe(true);
	});
});

describe("runCoverageGate — v0.3.57 review P1: exec-form commands (real run)", () => {
	it("vitest: coverage flags appended AFTER the pm-owned `--` reach vitest (npm exec)", () => {
		// Repro of the v0.3.56 P1: pre-`--` insertion fed `--coverage.*` to npm
		// as its own cli config ("Unknown cli config"), vitest ran WITHOUT
		// coverage, and every phase reported unmeasurable — the 85% floor was
		// unenforced on exec-form (npm-PM) projects. End-append lands child-side.
		const d = tempDir();
		symlinkSync("/home/jenningsl/development/personal/jenningsloy318/pi-super-dev/node_modules", join(d, "node_modules"));
		writeFileSync(join(d, "src.mjs"), [
			"export function cov(a) {",
			"  const x = a + 1;",
			"  return x;",
			"}",
			"export function uncov(a) {",
			"  const y = a * 2;",
			"  return y;",
			"}",
			"",
		].join("\n"));
		mkdirSync(join(d, "tests"));
		writeFileSync(join(d, "tests", "a.test.mjs"), [
			'import { test, expect } from "vitest";',
			'import { cov } from "../src.mjs";',
			'test("cov", () => { expect(cov(1)).toBe(2); });',
			"",
		].join("\n"));
		const runner = spec("npm exec vitest -- run tests/a.test.mjs");
		const r = runCoverageGate(d, { runnerSpec: runner, phaseFiles: ["src.mjs"], testFiles: ["tests/a.test.mjs"], timeoutMs: 180_000 });
		// Unmeasurable would mean npm ate the coverage flags again.
		expect(r.status).toBe("below-threshold");
		expect(r.linesPct).toBeLessThan(85);
		expect(r.perFile.every((f) => f.file.endsWith("src.mjs"))).toBe(true);
	}, 240_000);

	it("node-test: the coverage flag lands in the CHILD region of `npm exec node -- --test`", () => {
		// Pre-fix, insertBeforeFirstPositional scanned from argv[1] and inserted
		// `--experimental-test-coverage` at index 1 — npm's config stream — so
		// node ran WITHOUT coverage and the TAP table never printed.
		const d = tempDir();
		mkdirSync(join(d, "src"));
		mkdirSync(join(d, "tests"));
		writeFileSync(join(d, "src", "part.js"), [
			"export function covered(a) {",
			"  return a + 1;",
			"}",
			"export function notCovered(a) {",
			"  const y = a * 2;",
			"  return y + 1;",
			"}",
			"",
		].join("\n"));
		writeFileSync(join(d, "tests", "part.test.mjs"), [
			'import { test } from "node:test";',
			'import assert from "node:assert/strict";',
			'import { covered } from "../src/part.js";',
			'test("covered", () => { assert.equal(covered(1), 2); });',
			"",
		].join("\n"));
		const runner = spec("npm exec node -- --test --test-reporter=tap tests/part.test.mjs");
		const r = runCoverageGate(d, { runnerSpec: runner, phaseFiles: ["src/part.js"], testFiles: ["tests/part.test.mjs"], timeoutMs: 120_000 });
		expect(r.status).toBe("below-threshold");
		expect(r.recipe).toBe("node-test");
		expect((r.linesPct ?? 0)).toBeLessThan(85);
	}, 180_000);
});

describe("runCoverageGate — go (real run)", () => {
	const goOk = (() => { try { return spawnSync("go", ["version"], { encoding: "utf8" }).status === 0; } catch { return false; } })();
	it.skipIf(!goOk)("measures statement coverage from the coverprofile", () => {
		const d = tempDir();
		writeFileSync(join(d, "go.mod"), "module covgate\n\ngo 1.21\n");
		writeFileSync(join(d, "math.go"), [
			"package covgate",
			"",
			"func Add(a, b int) int {",
			"	x := a + 1",
			"	return x + b",
			"}",
			"",
			"func Mul(a, b int) int {",
			"	y := a * b",
			"	z := y + 1",
			"	return z",
			"}",
			"",
		].join("\n"));
		writeFileSync(join(d, "math_test.go"), [
			"package covgate",
			"",
			'import "testing"',
			"",
			"func TestAdd(t *testing.T) {",
			"	if Add(1, 2) != 4 {",
			'		t.Fatal("bad")',
			"	}",
			"}",
			"",
		].join("\n"));
		const low = runCoverageGate(d, { runnerSpec: spec("go test ./..."), phaseFiles: ["math.go"], testFiles: ["math_test.go"], timeoutMs: 120_000 });
		expect(low.status).toBe("below-threshold");
		expect(low.recipe).toBe("go");
		expect(low.linesPct).toBeLessThan(85);
	});
});
