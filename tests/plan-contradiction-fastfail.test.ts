/**
 * v0.3.79 Wave A2 — execution-time contradiction fast-fail
 * (spec-25 run 14-14: phase-01 burned 6 attempts (~2h) on a DETERMINISTIC
 * contradiction — every satisfiable fix hit the BLOCKING later-phase revert —
 * while the generic no-progress valve only fired late and its judge verdicts
 * were discarded. The escape valve must be contradiction-informed: when a
 * phase's repeated no-progress signature coincides with phase-boundary
 * reverts, the judge is invoked immediately with the contradiction frame and
 * the replan-upstream route offered — turning a blind retry loop into a
 * plan-revision route at the cheapest point still available).
 *
 * Also pins the A1 wiring: implementationStage runs the plan-feasibility
 * validator at entry and routes contradictions through
 * triggerReplanForFindings BEFORE executing any phase.
 */

import { describe, it, expect } from "vitest";
import { contradictionFastFailFrame } from "../src/stages/plan-feasibility.ts";
import { implementationSources } from "./helpers/implementation-source.ts";

describe("v0.3.79 A2 contradiction fast-fail frame (pure)", () => {
	it("builds the judge context naming both phases, the reverted files, and the failure reasons", () => {
		const frame = contradictionFastFailFrame({
			phaseId: "phase-01",
			phaseName: "catalyst-contract-shard",
			leakOwners: ["ts-thesis-stage-wiring-unit"],
			leakFiles: ["src/stages.ts"],
			failureReasons: ["deliverable-missing: contains:tests/catalyst-contract.test.ts:CROSS_CUTTING_CITATION_FIELDS"],
		});
		expect(frame.context).toContain("phase-boundary");
		expect(frame.context).toContain("catalyst-contract-shard");
		expect(frame.context).toContain("ts-thesis-stage-wiring-unit");
		expect(frame.context).toContain("src/stages.ts");
		expect(frame.context).toContain("CROSS_CUTTING_CITATION_FIELDS");
		expect(frame.allowedRoutes).toContain("replan-upstream");
		expect(frame.allowedRoutes).toContain("challenge-test");
		expect(frame.allowedRoutes).toContain("re-author-tests");
	});

	it("empty inputs still produce a well-formed frame", () => {
		const frame = contradictionFastFailFrame({ phaseId: "phase-02", phaseName: "", leakOwners: [], leakFiles: [], failureReasons: [] });
		expect(frame.context).toContain("phase-02");
		expect(frame.allowedRoutes).toContain("replan-upstream");
	});
});

describe("v0.3.79 A2/A1 wiring source contracts", () => {
	const impl = implementationSources();

	it("the BLOCKING phase-boundary leak site counts reverts per phase (boundaryRevertHits)", () => {
		expect(impl).toMatch(/boundaryRevertHits/);
		// incremented inside the leak-owners branch (the revert that fires)
		expect(impl).toMatch(/leakOwners\.length > 0[\s\S]{0,400}boundaryRevertHits\+\+/);
	});

	it("the impl-no-progress judge offers replan-upstream when a boundary revert was observed", () => {
		// the env-blocker site's comments mention the valve in prose — anchor on
		// the actual scope template
		const scope = impl.indexOf("stage9.impl-no-progress.${phaseId}");
		expect(scope).toBeGreaterThan(0);
		const window = impl.slice(scope - 3000, scope + 4000);
		expect(window).toMatch(/boundaryRevertHits\s*>\s*0/);
		expect(window).toMatch(/replan-upstream/);
	});

	it("a judge replan-upstream route at that valve triggers the replan machinery (no blind continue)", () => {
		const scope = impl.indexOf("stage9.impl-no-progress.${phaseId}");
		expect(scope).toBeGreaterThan(0);
		const window = impl.slice(scope, scope + 6500);
		// Wave P1 D-C: the valve now builds a cross-scope contract-conflict
		// finding shape BETWEEN the route check and the trigger (the cited file ×
		// owning phases), so the window bound widened 1000 → 2500 — the pin's
		// intent (replan-upstream routes the replan, never a blind continue) is
		// unchanged.
		expect(window).toMatch(/route === "replan-upstream"[\s\S]{0,2500}triggerReplanForFindings/);
	});

	it("implementationStage validates plan feasibility at entry and routes contradictions to replan before executing phases", () => {
		expect(impl).toMatch(/planFeasibilityFindings/);
  		const entry = impl.indexOf("planFeasibilityFindings(phases, setup.worktreePath, setup.specDirectory)"); // v0.3.98: 3rd arg feeds the Check 3 amendmentFamily exemption consumer (059 R1A)
		const window = impl.slice(entry, entry + 4600);
		// 065 routing follow-up: the ladder is inline-jump-first (planInlineRouteBack
		// + RouteBackSignal) THEN triggerReplanForFindings — the window widened
		// 3000 → 4600; the pin's intent (contradictions route upstream before any
		// phase executes) is unchanged.
		expect(window).toMatch(/planInlineRouteBack/);
		expect(window).toMatch(/RouteBackSignal/);
		expect(window).toMatch(/triggerReplanForFindings/);
		// advisories are surfaced honestly even when no contradiction fires
		expect(window).toMatch(/advisories/);
	});
});
