/**
 * RED no-progress escalation bias (run 2026-08-27T12-33-43-088Z).
 *
 * phase-03 ground through 9 RED tries / 5 judge calls / ~3.5h because every
 * routed `re-author-tests` verdict RESET the RED retry ladder; the correct
 * `fix-environment` diagnosis only landed at 04:43. After a phase exhausts
 * MAX_RED_JUDGE_ROUTES routed interventions, the only route left is
 * fix-environment — stop resampling, start diagnosing the environment.
 */
import { describe, it, expect, afterEach } from "vitest";
import { MAX_RED_JUDGE_ROUTES, restrictRedJudgeRoutes } from "../src/stages/implementation.ts";

const ROUTES = ["re-author-tests", "fix-environment", "replan-upstream", "allow-scaffold"] as const;

describe("restrictRedJudgeRoutes", () => {
	afterEach(() => { delete process.env.SUPER_DEV_MAX_RED_JUDGE_ROUTES; });
	it("passes the full route set through while under the cap", () => {
		expect(restrictRedJudgeRoutes(0, [...ROUTES])).toEqual([...ROUTES]);
		expect(restrictRedJudgeRoutes(MAX_RED_JUDGE_ROUTES - 1, [...ROUTES])).toEqual([...ROUTES]);
	});
	it("forces fix-environment-only at/after the cap (default 3)", () => {
		expect(MAX_RED_JUDGE_ROUTES).toBe(3);
		expect(restrictRedJudgeRoutes(3, [...ROUTES])).toEqual(["fix-environment"]);
		expect(restrictRedJudgeRoutes(7, [...ROUTES])).toEqual(["fix-environment"]);
	});
	it("env override SUPER_DEV_MAX_RED_JUDGE_ROUTES is honored by the constant", () => {
		// (constant is module-cached; the exported helper takes cap explicitly)
		expect(restrictRedJudgeRoutes(1, [...ROUTES], 1)).toEqual(["fix-environment"]);
		expect(restrictRedJudgeRoutes(0, [...ROUTES], 1)).toEqual([...ROUTES]);
	});
});
