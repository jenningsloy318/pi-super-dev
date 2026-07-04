/**
 * Tests for doc-content gate validation. These prove the spec-stage gates read
 * the ACTUAL .md file and validate its content (not just the agent's
 * self-reported control JSON) — the fix for the BDD false-negative where a
 * 26-scenario doc failed the gate because the control object was misshapen.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runHelper } from "../src/helpers.ts";
import {
	requirementsContentErrors,
	bddContentErrors,
	specContentErrors,
	specReviewContentErrors,
	normalizePhases,
	readSpecDoc,
	toNumber,
	toBool,
	isApprovedVerdict,
} from "../src/doc-validators.ts";
import type { SetupControl } from "../src/types.ts";

function mkSetup(dir: string): SetupControl & { specDirectory: string } {
	return {
		worktreePath: dir,
		specDirectory: `${dir}/`,
		defaultBranch: "main",
		language: "backend",
		isWebUi: false,
		specIdentifier: "test",
		worktreeCreated: true,
		initializedRepo: false,
	};
}

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "sd-gates-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

// ─── pure content validators ────────────────────────────────────────────────

describe("requirementsContentErrors", () => {
	it("passes on a complete requirements doc", () => {
		const doc = [
			"# Requirements",
			"## Executive Summary",
			"Add the thing. " + "lorem ipsum ".repeat(45),
			"## Acceptance Criteria",
			"- AC-01: must do X",
			"- AC-02: must do Y",
			"## Non-Functional Requirements",
			"- Performance: fast",
		].join("\n");
		expect(requirementsContentErrors(doc)).toEqual([]);
	});
	it("fails when <2 AC items", () => {
		const doc = "## Acceptance Criteria\n- AC-01: only one\n## Summary\nx".padEnd(500, " ");
		const errs = requirementsContentErrors(doc);
		expect(errs.some((e) => /≥2 acceptance-criteria/.test(e))).toBe(true);
	});
	it("fails on a stub", () => {
		expect(requirementsContentErrors("short").some((e) => /too short/.test(e))).toBe(true);
	});
});

describe("bddContentErrors", () => {
	it("passes on a well-structured BDD doc", () => {
		const doc = [
			"# BDD Scenarios",
			"### SCENARIO-001: happy path",
			"**Given** a user who wants to use the feature described in AC-01",
			"**When** they perform the primary action of the feature",
			"**Then** the system responds correctly and the outcome is observed",
			"References: AC-01",
			"### SCENARIO-002: edge case",
			"**Given** empty input is provided to the feature",
			"**When** the user submits the empty input",
			"**Then** the request is rejected with a validation error",
		].join("\n");
		expect(bddContentErrors(doc)).toEqual([]);
	});
	it("fails without SCENARIO-NN ids", () => {
		const doc = "**Given** x\n**When** y\n**Then** z\nAC-01".padEnd(300, " ");
		expect(bddContentErrors(doc).some((e) => /SCENARIO-NN/.test(e))).toBe(true);
	});
});

describe("specContentErrors + specReviewContentErrors", () => {
	it("spec wants scenario refs + testing strategy", () => {
		const good = "# Spec\nReferences SCENARIO-001.\n## Testing Strategy\nUnit tests.".padEnd(500, " ");
		expect(specContentErrors(good)).toEqual([]);
		const bad = "# Spec\nNo scenarios, no tests.".padEnd(500, " ");
		expect(specContentErrors(bad).length).toBeGreaterThan(0);
	});
	it("spec-review wants all 8 dimensions", () => {
		const dims = ["Completeness", "Consistency", "Feasibility", "Testability", "Traceability", "Grounding", "Complexity", "Ambiguity"];
		const good = dims.map((d) => `### ${d}: 5/5`).join("\n");
		expect(specReviewContentErrors(good)).toEqual([]);
		expect(specReviewContentErrors("only Completeness").length).toBeGreaterThan(0);
	});
});

// ─── coercion helpers ───────────────────────────────────────────────────────

describe("coercion", () => {
	it("toNumber parses numbers and numeric strings", () => {
		expect(toNumber(13)).toBe(13);
		expect(toNumber("13")).toBe(13);
		expect(toNumber("0.85")).toBe(0.85);
		expect(toNumber("n/a")).toBeNull();
		expect(toNumber(undefined)).toBeNull();
	});
	it("toBool parses booleans and truthy strings", () => {
		expect(toBool(true)).toBe(true);
		expect(toBool("true")).toBe(true);
		expect(toBool("yes")).toBe(true);
		expect(toBool("false")).toBe(false);
		expect(toBool(0)).toBe(false);
	});
	it("isApprovedVerdict tolerates case/variants and rejects negatives", () => {
		expect(isApprovedVerdict("Approved")).toBe(true);
		expect(isApprovedVerdict("Approved with Comments")).toBe(true);
		expect(isApprovedVerdict("approved with minor changes")).toBe(true);
		expect(isApprovedVerdict("PASS")).toBe(true);
		expect(isApprovedVerdict("Changes Requested")).toBe(false);
		expect(isApprovedVerdict("Rejected")).toBe(false);
		expect(isApprovedVerdict("CONTEST")).toBe(false);
	});
});

// ─── integration: gates read real files via setup ───────────────────────────

describe("gates validate real doc content", () => {
	it("gate-bdd PASSES on a good doc even with a malformed/empty control object", async () => {
		const specDir = `${dir}/docs/specifications/05-thing/`;
		mkdirSync(specDir, { recursive: true });
		writeFileSync(
			`${specDir}02-bdd-scenarios.md`,
			[
				"# BDD",
				"### SCENARIO-001: x — the happy path exercising AC-01 in full detail",
				"**Given** a precondition that is set up before the action begins",
				"**When** the actor performs the triggering action under test",
				"**Then** the expected outcome is observed and verified against AC-01",
				"### SCENARIO-002: y — an edge case for the same acceptance criterion",
				"**Given** a different precondition representing a boundary input",
				"**When** the same action is performed with that boundary input",
				"**Then** the system handles it gracefully per AC-02",
			].join("\n"),
		);
		const setup = mkSetup(specDir);
		// Malformed control object: the exact failure mode from the real run —
		// missing scenarioCount/coverageScore. Content validation must still pass.
		const r = await runHelper({
			name: "gate-bdd",
			sources: { "write-bdd": { summary: "only summary present" }, setup },
		});
		expect(r.value.pass).toBe(true);
	});

	it("gate-bdd FAILS on a stub doc", async () => {
		const specDir = `${dir}/docs/specifications/05-thing/`;
		mkdirSync(specDir, { recursive: true });
		writeFileSync(`${specDir}02-bdd-scenarios.md`, "stub");
		const setup = mkSetup(specDir);
		const r = await runHelper({
			name: "gate-bdd",
			sources: { "write-bdd": { scenarioCount: 99, coverageScore: 0.9, edgeCasesCovered: true }, setup },
		});
		// Even though the control object claims 99 scenarios / 0.9 score, the
		// actual doc is a stub → content validation fails. This is the whole point.
		expect(r.value.pass).toBe(false);
	});

	it("gate-requirements finds the doc via spec-dir glob when docPath is absent", async () => {
		const specDir = `${dir}/docs/specifications/05-thing/`;
		mkdirSync(specDir, { recursive: true });
		writeFileSync(
			`${specDir}01-requirements.md`,
			[
				"# Requirements",
				"## Executive Summary",
				"Add the thing. " + "lorem ipsum dolor ".repeat(20),
				"## Acceptance Criteria",
				"- AC-01: must do X",
				"- AC-02: must do Y",
				"## Non-Functional Requirements",
				"Security.",
			].join("\n"),
		);
		const setup = mkSetup(specDir);
		const r = await runHelper({
			name: "gate-requirements",
			sources: { "write-requirements": { /* no docPath */ }, setup },
		});
		expect(r.value.pass).toBe(true);
	});

	it("gate-spec-review passes on Approved + 8 dimensions, fails on Changes Requested", async () => {
		const specDir = `${dir}/docs/specifications/05-thing/`;
		mkdirSync(specDir, { recursive: true });
		const dims = ["Completeness", "Consistency", "Feasibility", "Testability", "Traceability", "Grounding", "Complexity", "Ambiguity"];
		writeFileSync(`${specDir}08-spec-review.md`, dims.map((d) => `### ${d}`).join("\n"));
		const setup = mkSetup(specDir);
		const pass = await runHelper({ name: "gate-spec-review", sources: { "review-spec": { verdict: "Approved" }, setup } });
		expect(pass.value.pass).toBe(true);
		const fail = await runHelper({ name: "gate-spec-review", sources: { "review-spec": { verdict: "Changes Requested" }, setup } });
		expect(fail.value.pass).toBe(false);
	});
});

describe("readSpecDoc", () => {
	it("prefers the declared path, falls back to glob", () => {
		const specDir = `${dir}/spec/`;
		mkdirSync(specDir);
		writeFileSync(`${specDir}02-bdd-scenarios.md`, "content");
		// No docPath → glob finds it
		expect(readSpecDoc(specDir, undefined, "*-bdd-scenarios.md")?.content).toBe("content");
		// Nonexistent declared path → glob still finds it
		expect(readSpecDoc(specDir, { docPath: "/nope.md" }, "*-bdd-scenarios.md")?.content).toBe("content");
		// Nothing matches
		expect(readSpecDoc(specDir, undefined, "*-nope.md")).toBeNull();
	});
});

describe("normalizePhases (crash guard for Stage 9)", () => {
	it("keeps a valid array of {name,description}", () => {
		expect(normalizePhases([{ name: "Phase 1", description: "d" }, { name: "Phase 2" }])).toEqual([
			{ name: "Phase 1", description: "d" }, { name: "Phase 2" },
		]);
	});
	it("drops entries without a usable name", () => {
		expect(normalizePhases([{ name: "ok" }, { description: "no name" }, { name: "" }])).toEqual([{ name: "ok" }]);
	});
	it("parses a string of phase names (the real crash case)", () => {
		expect(normalizePhases("Phase 1: setup\nPhase 2: impl\nPhase 3: tests")).toEqual([
			{ name: "Phase 1: setup" }, { name: "Phase 2: impl" }, { name: "Phase 3: tests" },
		]);
		expect(normalizePhases("a, b; c")).toEqual([{ name: "a" }, { name: "b" }, { name: "c" }]);
	});
	it("returns [] for null/undefined/number/object (never throws)", () => {
		expect(normalizePhases(undefined)).toEqual([]);
		expect(normalizePhases(null)).toEqual([]);
		expect(normalizePhases(42)).toEqual([]);
		expect(normalizePhases({ a: 1 })).toEqual([]);
		expect(normalizePhases("")).toEqual([]);
	});
});

describe("gate-spec-trace requires spec.phases array even with a good doc", () => {
	it("fails when phases is a string (the Stage 9 crash case), despite a valid specification.md", async () => {
		const { runHelper } = await import("../src/helpers.ts");
		const specDir = `${dir}/docs/specifications/05-x/`;
		mkdirSync(specDir, { recursive: true });
		// a substantive spec doc (passes content checks)
		writeFileSync(`${specDir}04-specification.md`, ("# Spec\nReferences SCENARIO-001.\n## Testing Strategy\nunit tests.\n" + "x".repeat(500)));
		writeFileSync(`${specDir}05-implementation-plan.md`, "plan");
		writeFileSync(`${specDir}06-task-list.md`, "tasks");
		const setup = mkSetup(specDir);
		// but the CONTROL's phases is a string (what crashed Stage 9)
		const r = await runHelper({ name: "gate-spec-trace", sources: { "write-spec": { specificationPath: `${specDir}04-specification.md`, phaseCount: 3, phases: "Phase 1\nPhase 2" }, setup } });
		expect(r.value.pass).toBe(false);
		expect((r.value.errors as string[]).some((e) => /spec\.phases must be a non-empty array/.test(e))).toBe(true);
	});
});
