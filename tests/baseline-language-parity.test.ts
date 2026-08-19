import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	detectFailureBlockLanguage,
	parseFailingGoPackages,
	resolveGoModuleForPackages,
	parseFailingPythonTestFiles,
} from "../src/build-runner/scope.ts";
import { resolveInScopePassWithBaseline } from "../src/build-runner/gates.ts";
import type { BaselineVerifyInput, BaselineCheckResult } from "../src/build-runner/baseline.ts";

// v0.2.9 G6 (run 2026-08-19T08-32-47-962Z): the env-blocker baseline check must
// verify each out-of-scope failure with the runner of the SUBJECT's language +
// module dir, not the run's PRIMARY language. A nested Go module's `snow`
// failure on a node-primary track was verified with `pnpm run test` (passes at
// baseline) → mis-tagged a pre-existing failure as a NEW regression.

describe("v0.2.9 G6 — per-subject-language baseline detection", () => {
	it("detects Go from a package FAIL/ok line (tab or duration), not a jest FAIL file", () => {
		expect(detectFailureBlockLanguage("FAIL\tgithub.com/mod/backend-service/internal/services/snow\t24.7s")).toBe("go");
		expect(detectFailureBlockLanguage("ok  \tgithub.com/mod/backend-service/internal/services/snow/odata\t(cached)")).toBe("go");
		expect(detectFailureBlockLanguage("internal/services/snow/enrichment.go:12:5: undefined: X")).toBe("go");
		// a jest FAIL on a .test.ts file is NODE, never Go (the greedy-slash trap)
		expect(detectFailureBlockLanguage("FAIL tests/old.test.ts\nexpected 1 to be 2")).toBe("node");
	});
	it("detects rust / python / node / null", () => {
		expect(detectFailureBlockLanguage("error[E0308]: mismatched types\ncrates/foo/src/lib.rs")).toBe("rust");
		expect(detectFailureBlockLanguage("FAILED tests/test_api.py::TestC::test_m - assert 1 == 2")).toBe("python");
		expect(detectFailureBlockLanguage("❯ src/x.spec.ts:3:1")).toBe("node");
		expect(detectFailureBlockLanguage("some opaque failure with no language marker")).toBeNull();
	});
	it("parses failing Go package import paths", () => {
		const blocks = ["FAIL\tgithub.com/mod/be/internal/services/snow\t24.7s\nFAIL\tgithub.com/mod/be/internal/x [build failed]"];
		expect(parseFailingGoPackages(blocks)).toEqual([
			"github.com/mod/be/internal/services/snow",
			"github.com/mod/be/internal/x",
		]);
	});
	it("parses failing python test files", () => {
		expect(parseFailingPythonTestFiles("FAILED pkg/test_a.py::T::m\npkg/test_b.py:9: AssertionError")).toEqual(["pkg/test_a.py", "pkg/test_b.py"]);
	});
});

describe("v0.2.9 G6 — nested Go module resolution", () => {
	let repo: string;
	beforeEach(() => {
		repo = mkdtempSync(join(tmpdir(), "sd-g6-"));
		// nested go module at backend-service/ (module github.com/mod/be)
		mkdirSync(join(repo, "backend-service", "internal", "services", "snow"), { recursive: true });
		writeFileSync(join(repo, "backend-service", "go.mod"), "module github.com/mod/be\n\ngo 1.22\n");
		// a decoy JS package at the repo root
		writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "root", scripts: { test: "vitest run" } }));
	});
	afterEach(() => rmSync(repo, { recursive: true, force: true }));

	it("maps a nested package import path to the module subdir + module-relative pkg dir", () => {
		const r = resolveGoModuleForPackages(repo, ["github.com/mod/be/internal/services/snow"]);
		expect(r).not.toBeNull();
		expect(r!.moduleSubdir).toBe("backend-service");
		expect(r!.packageDirs).toEqual(["internal/services/snow"]);
	});
	it("returns null when no go.mod matches the package prefix (safe direction)", () => {
		expect(resolveGoModuleForPackages(repo, ["example.com/other/pkg"])).toBeNull();
	});
});

describe("v0.2.9 G6 — resolveInScopePassWithBaseline verifies each subject in its own language", () => {
	// The motivating run: a Go `snow` failure on a node-primary (backend) track.
	// The mock verify records the language + moduleSubdir it was asked to use.
	function mkGoRepo(): string {
		const repo = mkdtempSync(join(tmpdir(), "sd-g6i-"));
		mkdirSync(join(repo, "backend-service", "internal", "services", "snow"), { recursive: true });
		writeFileSync(join(repo, "backend-service", "go.mod"), "module github.com/mod/be\n\ngo 1.22\n");
		return repo;
	}
	const goBlock = "FAIL\tgithub.com/mod/be/internal/services/snow\t24.7s";

	it("routes a Go failure to the GO runner + module subdir (NOT the node primary), and a Go regression strips the lenient pass", () => {
		const repo = mkGoRepo();
		try {
			const seen: BaselineVerifyInput[] = [];
			const r = resolveInScopePassWithBaseline({
				pass: false,
				errors: [goBlock],
				outOfScopeErrors: [goBlock],
				language: "backend", // run PRIMARY is node-family
				cwd: repo,
				defaultBranch: "main",
				baselineVerify: (input): BaselineCheckResult => { seen.push(input); return { status: "regression", evidence: "passes at baseline" }; },
			});
			expect(seen).toHaveLength(1);
			expect(seen[0]!.language).toBe("go"); // NOT "backend"/pnpm
			expect(seen[0]!.moduleSubdir).toBe("backend-service");
			expect(seen[0]!.subjects.some((s) => s.startsWith("internal/services/snow/"))).toBe(true);
			expect(r.inScopePass).toBe(false);
			expect(r.errors.some((e) => e.includes("[baseline-verify] regression"))).toBe(true);
		} finally { rmSync(repo, { recursive: true, force: true }); }
	});

	it("a PREEXISTING Go failure keeps the lenient pass (env-blocker recognizes it) — the run-08-32 fix", () => {
		const repo = mkGoRepo();
		try {
			const r = resolveInScopePassWithBaseline({
				pass: false,
				errors: [goBlock],
				outOfScopeErrors: [goBlock],
				language: "backend",
				cwd: repo,
				defaultBranch: "main",
				baselineVerify: (input): BaselineCheckResult => {
					expect(input.language).toBe("go"); // verified with go, so it correctly fails at baseline too
					return { status: "preexisting", evidence: "also fails at baseline" };
				},
			});
			expect(r.inScopePass).toBe(true); // pre-existing → lenient pass preserved (no false regression)
		} finally { rmSync(repo, { recursive: true, force: true }); }
	});
});
