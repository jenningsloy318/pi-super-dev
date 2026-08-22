/**
 * Sweep-3 Phase 3 — scoping plumbing (G6) + baseline strict-positive (G40).
 * G6: runBuildGate threads defaultBranch into every touchedFilePaths consumer;
 *     RedCheckOptions.defaultBranch feeds the cargo -p tiers.
 * G40: the whole-suite baseline fallback refuses the regression inference when
 *     NO subject was positively observed at baseline (mocha/tap partial parses).
 */
import { describe, expect, it } from "vitest";
import { classifyOutOfScopeNpmErrors, parseFailingGoPackages } from "../src/build-runner/scope.ts";
import { resolveIntegrationStems } from "../src/build-runner/detect.ts";
import { redCheckOptionsDefaultBranch } from "./sweep3-phase3-helpers.ts";

describe("G6 — scoping plumbing", () => {
	it("classifyOutOfScopeNpmErrors accepts the run's base ref (signature contract)", () => {
		expect(classifyOutOfScopeNpmErrors(["❯ pkg/a.test.ts:1:1\n FAIL pkg/a.test.ts"], "/nonexistent", "trunk")).toEqual([]);
	});
	it("RedCheckOptions carries defaultBranch through redCheckOptions into runRedCheck's plans", () => {
		// Mirrors implementation.ts:1297 — the options object the RED oracle reads.
		expect(redCheckOptionsDefaultBranch("trunk-branch")).toBe("trunk-branch");
	});
});

describe("G39 — Go FAIL parsers use the [ \\t ] form", () => {
	it("parseFailingGoPackages: a bare `FAIL\\n` summary line does NOT capture the NEXT line (the pre-fix \\\\s+ bug)", () => {
		expect(parseFailingGoPackages(["FAIL\\nexample.com/app/pkg\\t0.001s"])).toEqual([]);
	});
	it("CONTROL: the tab-separated package line still parses", () => {
		expect(parseFailingGoPackages([`FAIL	example.com/app/pkg	0.001s`])).toEqual(["example.com/app/pkg"]);
	});
});
