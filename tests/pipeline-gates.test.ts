/**
 * P0 gate-fix regression tests (design report §C / audit Findings 1, 2, 4b).
 *
 * Locks in the fail-fast completeness gate + conservative merge:
 *  - hasImplementation requires allGreen (partial impl → review/test SKIPPED,
 *    not run on incomplete code — the "merged 2/6" false-green fix).
 *  - canMerge is conservative: requires notBlocked AND impl.allGreen AND
 *    reviewApproved AND an AFFIRMATIVE build pass (not "!== false" — a missing
 *    build result is a vacuous pass, the asymmetry the audit flagged).
 */
import { describe, it, expect } from "vitest";
import { canMerge, hasImplementation } from "../src/stages/index.ts";
import type { PipelineState } from "../src/types.ts";

const base = (over: Partial<PipelineState>): PipelineState => ({ ...over } as PipelineState);

describe("hasImplementation — fail-fast completeness gate (§C / audit #1)", () => {
	it("totalPhases>0 AND allGreen=true → reviewable", () => {
		expect(hasImplementation(base({ implementation: { totalPhases: 6, allGreen: true } }))).toBe(true);
	});
	it("totalPhases>0 BUT allGreen=false (partial, e.g. 2/6) → NOT reviewable (review/test skipped)", () => {
		expect(hasImplementation(base({ implementation: { totalPhases: 6, allGreen: false } }))).toBe(false);
	});
	it("allGreen missing → NOT reviewable (no vacuous pass on undefined)", () => {
		expect(hasImplementation(base({ implementation: { totalPhases: 6 } }))).toBe(false);
	});
	it("no implementation at all → NOT reviewable", () => {
		expect(hasImplementation(base({}))).toBe(false);
	});
});

describe("canMerge — conservative merge gate (§C / audit #1,#2,#4b)", () => {
	const greenImpl = { allGreen: true };
	const approved = { verdict: "Approved" };
	const passBuild = { pass: true };
	const cleanCleanup = { blocked: false };

	it("all conditions met → mergeable", () => {
		expect(canMerge(base({ cleanup: cleanCleanup, implementation: greenImpl, review: approved, preMergeBuild: passBuild }))).toBe(true);
	});
	it("partial implementation (allGreen=false) → NOT mergeable (completeness gate)", () => {
		expect(canMerge(base({ cleanup: cleanCleanup, implementation: { allGreen: false }, review: approved, preMergeBuild: passBuild }))).toBe(false);
	});
	it("review NOT approved → NOT mergeable (defense-in-depth)", () => {
		expect(canMerge(base({ cleanup: cleanCleanup, implementation: greenImpl, review: { verdict: "Changes Requested" }, preMergeBuild: passBuild }))).toBe(false);
	});
	it("build gate FAILED (pass=false) → NOT mergeable", () => {
		expect(canMerge(base({ cleanup: cleanCleanup, implementation: greenImpl, review: approved, preMergeBuild: { pass: false } }))).toBe(false);
	});
	it("build result MISSING (tolerant skip / never ran) → NOT mergeable (vacuous-pass fix: missing ≠ pass)", () => {
		// The old code returned `b?.pass !== false` → true for missing. Now `=== true` → false.
		expect(canMerge(base({ cleanup: cleanCleanup, implementation: greenImpl, review: approved }))).toBe(false);
	});
	it("cleanup missing → NOT mergeable (existing notBlocked asymmetry preserved)", () => {
		expect(canMerge(base({ implementation: greenImpl, review: approved, preMergeBuild: passBuild }))).toBe(false);
	});
	it("cleanup blocked → NOT mergeable", () => {
		expect(canMerge(base({ cleanup: { blocked: true }, implementation: greenImpl, review: approved, preMergeBuild: passBuild }))).toBe(false);
	});
});
