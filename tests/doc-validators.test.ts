/**
 * Tests for doc-content gate validation. These prove the spec-stage gates read
 * the ACTUAL .md file and validate its content (not just the agent's
 * self-reported control JSON) — the fix for the BDD false-negative where a
 * 26-scenario doc failed the gate because the control object was misshapen.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runHelper } from "../src/helpers.ts";
import {
	requirementsContentErrors,
	bddContentErrors,
	bddTraceabilityErrors,
	specContentErrors,
	specTraceabilityErrors,
	specReviewContentErrors,
	extractAcceptanceCriteriaIds,
	extractScenarioIds,
	extractScenarioRefsFromControl,
	extractAcceptanceCriteriaRefsFromControl,
	extractMappedScenarioRefsFromControl,
	normalizePhases,
	phaseIndependenceErrors,
	phaseTestDeliverableErrors,
	readSpecDoc,
	toNumber,
	toBool,
	isApprovedVerdict,
	stripNonNormativeSections,
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

function requirementsDoc(acIds = ["AC-01", "AC-02"]): string {
	return [
		"# Requirements",
		"## Executive Summary",
		"Add the thing. " + "lorem ipsum dolor ".repeat(22),
		"## Acceptance Criteria",
		...acIds.map((id) => `- ${id}: must satisfy ${id}`),
		"## Non-Functional Requirements",
		"Security and performance must remain acceptable.",
	].join("\n");
}

function bddDoc(scenarios: Array<{ id: string; ac: string }>): string {
	return [
		"# BDD Scenarios",
		...scenarios.flatMap((s) => [
			`### SCENARIO-${s.id}: behavior for ${s.ac}`,
			`**Given** a precondition tied to ${s.ac}`,
			"**When** the actor performs the relevant action",
			`**Then** the expected outcome is verified against ${s.ac}`,
			`References: ${s.ac}`,
		]),
	].join("\n");
}

function specDoc(refs: string[], acRefs = ["AC-01", "AC-02"]): string {
	return [
		"# Spec",
		"## Summary",
		"Implement the behavior described by the BDD scenarios. " + "details ".repeat(65),
		"## Architecture",
		"Use the existing module boundaries and keep the implementation deterministic.",
		"## Testing Strategy",
		"Unit and integration tests cover every referenced BDD scenario.",
		"## Acceptance Criteria References",
		...acRefs.map((r) => `- ${r}`),
		"## BDD Scenario References",
		...refs.map((r) => `- ${r}`),
	].join("\n");
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

describe("traceability validators", () => {
	it("extracts normalized AC and scenario IDs from docs/control", () => {
		expect(extractAcceptanceCriteriaIds("AC-1, ac-02, AC-02")).toEqual(["AC-01", "AC-02"]);
		expect(extractScenarioIds("SCENARIO-1 plus scenario-002")).toEqual(["SCENARIO-001", "SCENARIO-002"]);
		expect(extractScenarioRefsFromControl({ scenarioRefs: ["001", "SCENARIO-002"] })).toEqual(["SCENARIO-001", "SCENARIO-002"]);
		expect(extractAcceptanceCriteriaRefsFromControl({ acceptanceCriteriaRefs: ["1", "AC-02"] })).toEqual(["AC-01", "AC-02"]);
		expect(extractMappedScenarioRefsFromControl({ phases: [{ scenarioRefs: ["SCENARIO-001"] }], tasks: [{ scenarioRefs: ["002"] }] })).toEqual(["SCENARIO-001", "SCENARIO-002"]);
	});

	it("requires BDD to cover every requirements acceptance criterion", () => {
		expect(bddTraceabilityErrors(requirementsDoc(["AC-01", "AC-02"]), bddDoc([{ id: "001", ac: "AC-01" }, { id: "002", ac: "AC-02" }]))).toEqual([]);
		const errors = bddTraceabilityErrors(requirementsDoc(["AC-01", "AC-02"]), bddDoc([{ id: "001", ac: "AC-01" }, { id: "002", ac: "AC-99" }]));
		expect(errors.some((e) => e.includes("AC-02"))).toBe(true);
		expect(errors.some((e) => e.includes("AC-99"))).toBe(true);
	});

	it("requires spec scenario refs and task phases to trace to BDD and declared phases", () => {
		const goodControl = {
			acceptanceCriteriaRefs: ["AC-01", "AC-02"],
			scenarioRefs: ["SCENARIO-001", "SCENARIO-002"],
			// AC-11 audit: a scenario-mapped phase now needs a test deliverable
			// for this gate-clean fixture.
			phases: [{ name: "Implementation", scenarioRefs: ["SCENARIO-001", "SCENARIO-002"], deliverables: { requireScenarios: ["SCENARIO-001", "SCENARIO-002"] } }],
			tasks: [{ phase: "Implementation", description: "build it", scenarioRefs: ["SCENARIO-001", "SCENARIO-002"] }],
		};
		expect(specTraceabilityErrors(bddDoc([{ id: "001", ac: "AC-01" }, { id: "002", ac: "AC-02" }]), specDoc(["SCENARIO-001", "SCENARIO-002"]), goodControl, requirementsDoc(["AC-01", "AC-02"]))).toEqual([]);
		const bad = specTraceabilityErrors(
			bddDoc([{ id: "001", ac: "AC-01" }, { id: "002", ac: "AC-02" }]),
			specDoc(["SCENARIO-001", "SCENARIO-099"], ["AC-01"]),
			{ acceptanceCriteriaRefs: ["AC-01"], scenarioRefs: ["SCENARIO-001"], phases: [{ name: "Implementation", scenarioRefs: ["SCENARIO-001"] }], tasks: [{ phase: "Wrong", description: "x", scenarioRefs: ["SCENARIO-001"] }] },
			requirementsDoc(["AC-01", "AC-02"]),
		);
		expect(bad.some((e) => e.includes("SCENARIO-002"))).toBe(true);
		expect(bad.some((e) => e.includes("SCENARIO-099"))).toBe(true);
		expect(bad.some((e) => e.includes("AC-02"))).toBe(true);
		expect(bad.some((e) => e.includes("unknown phase"))).toBe(true);
	});
	// ── AC-11 (SCENARIO-025): the deliverable guard is wired into the gate ──
	it("AC-11 (SCENARIO-025): specTraceabilityErrors flags a scenario-mapped phase without a test deliverable", () => {
		const specControl = {
			acceptanceCriteriaRefs: ["AC-01", "AC-02"],
			scenarioRefs: ["SCENARIO-001", "SCENARIO-002"],
			phases: [{ name: "Phase 1" }],
			tasks: [{ phase: "Phase 1", description: "build it", scenarioRefs: ["SCENARIO-001", "SCENARIO-002"] }],
		};
		const errors = specTraceabilityErrors(
			bddDoc([{ id: "001", ac: "AC-01" }, { id: "002", ac: "AC-02" }]),
			specDoc(["SCENARIO-001", "SCENARIO-002"]),
			specControl,
			requirementsDoc(["AC-01", "AC-02"]),
		);
		expect(errors.some((e) => e.includes("phase \"Phase 1\" maps 2 BDD scenario(s) but declares no test deliverable"))).toBe(true);
		// the guard is appended AFTER the phase-independence errors — an
		// independently-fine phase with deliverables declared stays clean
		const withDeliverables = { ...specControl, phases: [{ name: "Phase 1", deliverables: { requireScenarios: ["SCENARIO-001", "SCENARIO-002"] } }] };
		expect(specTraceabilityErrors(
			bddDoc([{ id: "001", ac: "AC-01" }, { id: "002", ac: "AC-02" }]),
			specDoc(["SCENARIO-001", "SCENARIO-002"]),
			withDeliverables,
			requirementsDoc(["AC-01", "AC-02"]),
		)).toEqual([]);
	});
});

describe("phaseIndependenceErrors (cascade-fail monolith guard)", () => {
	const norm = (p: unknown) => normalizePhases(p);

	it("flags a phase that is over-large on BOTH axes (many scenarios AND many files)", () => {
		const phases = norm([{
			name: "Phase 2",
			description: "everything at once",
			scenarioRefs: ["SCENARIO-001", "SCENARIO-002", "SCENARIO-003", "SCENARIO-004", "SCENARIO-005", "SCENARIO-006", "SCENARIO-007", "SCENARIO-008", "SCENARIO-009"],
			deliverables: { requireFiles: ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts", "f.ts"] },
		}]);
		const errors = phaseIndependenceErrors(phases, []);
		expect(errors.length).toBe(1);
		expect(errors[0]).toContain("cascade-fail monolith");
		expect(errors[0]).toContain("Phase 2");
	});

	it("does NOT flag a phase broad on only ONE axis (many scenarios, few files)", () => {
		const phases = norm([{
			name: "Cohesive",
			description: "many small scenarios, one file",
			scenarioRefs: ["SCENARIO-001", "SCENARIO-002", "SCENARIO-003", "SCENARIO-004", "SCENARIO-005", "SCENARIO-006", "SCENARIO-007", "SCENARIO-008", "SCENARIO-009"],
			deliverables: { requireFiles: ["one.ts"] },
		}]);
		expect(phaseIndependenceErrors(phases, [])).toEqual([]);
	});

	it("does NOT flag a phase broad on only ONE axis (many files, few scenarios)", () => {
		const phases = norm([{
			name: "Wiring",
			description: "one behavior across many files",
			scenarioRefs: ["SCENARIO-001"],
			deliverables: { requireFiles: ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts", "f.ts"] },
		}]);
		expect(phaseIndependenceErrors(phases, [])).toEqual([]);
	});

	it("counts scenarios mapped via task rows, not just phase.scenarioRefs", () => {
		const phases = norm([{ name: "P", description: "d", deliverables: { requireFiles: ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts", "f.ts"] } }]);
		const tasks = Array.from({ length: 9 }, (_, i) => ({ phase: "P", description: "t", scenarioRefs: [`SCENARIO-${String(i + 1).padStart(3, "0")}`] }));
		const errors = phaseIndependenceErrors(phases, tasks);
		expect(errors.length).toBe(1);
	});

	it("returns no errors for a phase with no deliverables (backward compat)", () => {
		expect(phaseIndependenceErrors(norm([{ name: "P", description: "d" }]), [])).toEqual([]);
	});
});

describe("phaseTestDeliverableErrors (scenario-mapped phase must declare a test deliverable)", () => {
	const norm = (p: unknown) => normalizePhases(p);

	it("flags a scenario-mapped phase that declares neither requireScenarios nor requireTests", () => {
		const phases = norm([{ name: "P", description: "d", scenarioRefs: ["SCENARIO-001"], deliverables: { requireFiles: ["src/x.ts"] } }]);
		const errors = phaseTestDeliverableErrors(phases, []);
		expect(errors.length).toBe(1);
		expect(errors[0]).toContain("no test deliverable");
		expect(errors[0]).toContain("P");
	});

	it("passes when the phase declares requireScenarios", () => {
		const phases = norm([{ name: "P", description: "d", scenarioRefs: ["SCENARIO-001"], deliverables: { requireScenarios: ["SCENARIO-001"] } }]);
		expect(phaseTestDeliverableErrors(phases, [])).toEqual([]);
	});

	it("passes when the phase declares requireTests", () => {
		const phases = norm([{ name: "P", description: "d", scenarioRefs: ["SCENARIO-001"], deliverables: { requireTests: ["covers it"] } }]);
		expect(phaseTestDeliverableErrors(phases, [])).toEqual([]);
	});

	it("exempts a phase that maps no scenarios (pure wiring/config)", () => {
		const phases = norm([{ name: "Wiring", description: "d", deliverables: { requireFiles: ["src/x.ts"] } }]);
		expect(phaseTestDeliverableErrors(phases, [])).toEqual([]);
	});

	it("counts scenarios mapped via task rows too", () => {
		const phases = norm([{ name: "P", description: "d" }]);
		const tasks = [{ phase: "P", description: "t", scenarioRefs: ["SCENARIO-005"] }];
		expect(phaseTestDeliverableErrors(phases, tasks).length).toBe(1);
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
	// ── AC-28 (SCENARIO-057/058): negated approvals never classify as approvals ──
	it("AC-28 (SCENARIO-057): isApprovedVerdict rejects negated approval verdicts (guard before the approve-family match)", () => {
		for (const v of ["not approved", "does not pass", "not passing", "approved: no", "NOT APPROVED", "Does Not Pass"]) {
			expect(isApprovedVerdict(v), v).toBe(false);
		}
	});
	it("AC-28 (SCENARIO-058): isApprovedVerdict keeps the approve family approving", () => {
		for (const v of ["Approved", "Approved with Comments", "APPROVED WITH REVISIONS"]) {
			expect(isApprovedVerdict(v), v).toBe(true);
		}
	});
});

// ─── integration: gates read real files via setup ───────────────────────────

describe("gates validate real doc content", () => {
	it("gate-bdd PASSES on a good doc even with a malformed/empty control object", async () => {
		const specDir = `${dir}/docs/specifications/05-thing/`;
		mkdirSync(specDir, { recursive: true });
		writeFileSync(`${specDir}01-requirements.md`, requirementsDoc(["AC-01", "AC-02"]));
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
		writeFileSync(`${specDir}01-requirements.md`, requirementsDoc(["AC-01", "AC-02"]));
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

	it("gate-bdd FAILS when BDD does not cover every requirements AC", async () => {
		const specDir = `${dir}/docs/specifications/05-thing/`;
		mkdirSync(specDir, { recursive: true });
		writeFileSync(`${specDir}01-requirements.md`, requirementsDoc(["AC-01", "AC-02"]));
		writeFileSync(`${specDir}02-bdd-scenarios.md`, bddDoc([{ id: "001", ac: "AC-01" }]));
		const setup = mkSetup(specDir);
		const r = await runHelper({
			name: "gate-bdd",
			sources: { "write-bdd": { docPath: `${specDir}02-bdd-scenarios.md` }, setup },
		});
		expect(r.value.pass).toBe(false);
		expect((r.value.errors as string[]).some((e) => e.includes("AC-02"))).toBe(true);
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

	it("gate-spec-trace PASSES with complete BDD coverage and valid task phases", async () => {
		const specDir = `${dir}/docs/specifications/05-thing/`;
		mkdirSync(specDir, { recursive: true });
		writeFileSync(`${specDir}01-requirements.md`, requirementsDoc(["AC-01", "AC-02"]));
		writeFileSync(`${specDir}02-bdd-scenarios.md`, bddDoc([{ id: "001", ac: "AC-01" }, { id: "002", ac: "AC-02" }]));
		writeFileSync(`${specDir}04-specification.md`, specDoc(["SCENARIO-001", "SCENARIO-002"]));
		writeFileSync(`${specDir}05-implementation-plan.md`, "## Phase 1: Implementation\nDo it.");
		writeFileSync(`${specDir}06-task-list.md`, "- [ ] **Implementation**: build it");
		const setup = mkSetup(specDir);
		const r = await runHelper({
			name: "gate-spec-trace",
			sources: {
				"write-spec": {
					specificationPath: `${specDir}04-specification.md`,
					phaseCount: 1,
					acceptanceCriteriaRefs: ["AC-01", "AC-02"],
					// AC-11 audit: scenario-mapped phases need a test deliverable to stay green.
					phases: [{ name: "Implementation", scenarioRefs: ["SCENARIO-001", "SCENARIO-002"], deliverables: { requireScenarios: ["SCENARIO-001", "SCENARIO-002"] } }],
					tasks: [{ phase: "Implementation", description: "build it", scenarioRefs: ["SCENARIO-001", "SCENARIO-002"] }],
					scenarioRefs: ["SCENARIO-001", "SCENARIO-002"],
				},
				setup,
			},
		});
		expect(r.value.pass).toBe(true);
	});

	it("gate-spec-trace FAILS on missing BDD scenario coverage and unknown task phase", async () => {
		const specDir = `${dir}/docs/specifications/05-thing/`;
		mkdirSync(specDir, { recursive: true });
		writeFileSync(`${specDir}01-requirements.md`, requirementsDoc(["AC-01", "AC-02"]));
		writeFileSync(`${specDir}02-bdd-scenarios.md`, bddDoc([{ id: "001", ac: "AC-01" }, { id: "002", ac: "AC-02" }]));
		writeFileSync(`${specDir}04-specification.md`, specDoc(["SCENARIO-001", "SCENARIO-099"]));
		writeFileSync(`${specDir}05-implementation-plan.md`, "## Phase 1: Implementation\nDo it.");
		writeFileSync(`${specDir}06-task-list.md`, "- [ ] **Wrong**: build it");
		const setup = mkSetup(specDir);
		const r = await runHelper({
			name: "gate-spec-trace",
			sources: {
				"write-spec": {
					specificationPath: `${specDir}04-specification.md`,
					phaseCount: 1,
					acceptanceCriteriaRefs: ["AC-01"],
					phases: [{ name: "Implementation", scenarioRefs: ["SCENARIO-001"] }],
					tasks: [{ phase: "Wrong", description: "build it", scenarioRefs: ["SCENARIO-001"] }],
					scenarioRefs: ["SCENARIO-001"],
				},
				setup,
			},
		});
		expect(r.value.pass).toBe(false);
		const errors = r.value.errors as string[];
		expect(errors.some((e) => e.includes("SCENARIO-002"))).toBe(true);
		expect(errors.some((e) => e.includes("SCENARIO-099"))).toBe(true);
		expect(errors.some((e) => e.includes("unknown phase"))).toBe(true);
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
	// ── AC-16 (SCENARIO-035/036): control-supplied paths resolve against the
	// spec dir — never the process CWD — and anything outside it is ignored ──
	it("AC-16 (SCENARIO-035): a docPath OUTSIDE the spec dir is ignored (one warn) and the globbed doc is returned", () => {
		const specDir = `${dir}/spec/`;
		mkdirSync(specDir);
		writeFileSync(`${specDir}24-specification.md`, "GLOBBED-CONTENT-035");
		writeFileSync(`${dir}/outside-spec.md`, "OUTSIDE-CONTENT-035"); // exists, but outside specDir
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const doc = readSpecDoc(specDir, { docPath: `${dir}/outside-spec.md` }, "*-specification.md");
			expect(doc?.path).toBe(`${specDir}24-specification.md`);
			expect(doc?.content).toBe("GLOBBED-CONTENT-035");
			const lines = warn.mock.calls.map((c) => String(c[0])).filter((l) => l.includes("[doc-validators] readSpecDoc: ignoring"));
			expect(lines).toHaveLength(1);
			expect(lines[0]).toContain("outside-spec.md");
		} finally {
			warn.mockRestore();
		}
	});
	it("AC-16 (SCENARIO-036): a RELATIVE docPath resolves against specDir, never the process CWD", () => {
		const specDir = `${dir}/spec/`;
		const cwd = `${dir}/fake-cwd/`;
		mkdirSync(`${specDir}notes/`, { recursive: true });
		mkdirSync(`${cwd}notes/`, { recursive: true });
		writeFileSync(`${specDir}notes/spec.md`, "SPEC-DIR-CONTENT-036");
		writeFileSync(`${cwd}notes/spec.md`, "CWD-CONTENT-036");
		const oldCwd = process.cwd();
		process.chdir(cwd);
		try {
			const doc = readSpecDoc(specDir, { docPath: "notes/spec.md" }, "*-specification.md");
			expect(doc?.content).toBe("SPEC-DIR-CONTENT-036");
			expect(doc?.path.endsWith(join("spec", "notes", "spec.md"))).toBe(true);
		} finally {
			process.chdir(oldCwd);
		}
	});
	it("AC-16: an empty specDir never reads control paths (degenerate callers fall to null)", () => {
		writeFileSync(`${dir}/outside-spec.md`, "OUTSIDE-CONTENT");
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			expect(readSpecDoc("", { docPath: `${dir}/outside-spec.md` }, "*.md")).toBeNull();
			expect(warn).not.toHaveBeenCalled();
		} finally {
			warn.mockRestore();
		}
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
		// AC-19 (SCENARIO-042): the comma left the split set — only newlines /
		// semicolons / bullets separate phases, so "a, b; c" is TWO phases
		// ("a, b" on one side of the semicolon, "c" on the other).
		expect(normalizePhases("a, b; c")).toEqual([{ name: "a, b" }, { name: "c" }]);
	});
	// ── AC-19 (SCENARIO-041/042): coercion fidelity — fields survive ──
	it("AC-19 (SCENARIO-041): a single phase OBJECT round-trips every field (scenarioRefs + deliverables survive)", () => {
		expect(normalizePhases({ name: " Phase 1 ", description: "d", scenarioRefs: ["SCENARIO-001"], deliverables: { requireTests: true } })).toEqual([
			{ name: "Phase 1", description: "d", scenarioRefs: ["SCENARIO-001"], deliverables: { requireTests: true } },
		]);
	});
	it("AC-19 (SCENARIO-042): a comma-separated phase string yields ONE phase (comma is not a separator)", () => {
		const out = normalizePhases("Phase A, Phase B");
		expect(out).toHaveLength(1);
		expect(out[0]?.name).toBe("Phase A, Phase B");
	});
	it("returns [] for null/undefined/number/object (never throws)", () => {
		expect(normalizePhases(undefined)).toEqual([]);
		expect(normalizePhases(null)).toEqual([]);
		expect(normalizePhases(42)).toEqual([]);
		expect(normalizePhases({ a: 1 })).toEqual([]);
		expect(normalizePhases("")).toEqual([]);
	});
});

describe("gate-spec-trace phases handling (F6 tolerant coercion)", () => {
	it("coerces a phases STRING (the Stage 9 crash case) — no structural error, only the AC-11 deliverable contract fires (D9 fixture flip citing AC-11)", async () => {
		const { runHelper } = await import("../src/helpers.ts");
		const specDir = `${dir}/docs/specifications/05-x/`;
		mkdirSync(specDir, { recursive: true });
		writeFileSync(`${specDir}01-requirements.md`, requirementsDoc(["AC-01"]));
		writeFileSync(`${specDir}02-bdd-scenarios.md`, bddDoc([{ id: "001", ac: "AC-01" }]));
		writeFileSync(`${specDir}04-specification.md`, specDoc(["SCENARIO-001"], ["AC-01"]));
		writeFileSync(`${specDir}05-implementation-plan.md`, "## Phase 1: Implementation\nDo it.");
		writeFileSync(`${specDir}06-task-list.md`, "- [ ] **Implementation**: build it");
		const setup = mkSetup(specDir);
		const r = await runHelper({ name: "gate-spec-trace", sources: { "write-spec": { specificationPath: `${specDir}04-specification.md`, phaseCount: 3, acceptanceCriteriaRefs: ["AC-01"], scenarioRefs: ["SCENARIO-001"], phases: "Implementation", tasks: [{ phase: "Implementation", description: "build it", scenarioRefs: ["SCENARIO-001"] }] }, setup } });
		// F6 (run 2026-08-17T06-39-58-800Z: 5 rounds lost to this exact shape;
		// adversarial F6-HINT-DEAD-CODE revision): a coercible phases value never
		// produces the STRUCTURAL failure — normalizePhases reconstructs the array
		// and the implementation stage normalizes the same way on read, so no
		// "spec.phases must be a non-empty array" error is emitted. (phases here is
		// a STRING naming one phase — the Stage 9 crash shape.)
		// AC-11 (SCENARIO-025) flip: a string-coerced phase cannot carry
		// deliverables, so the ONE remaining error is the deliverable contract —
		// the writer repairs it by emitting proper phase objects next round.
		expect((r.value.errors as string[]).some((e) => /spec\.phases must be a non-empty array/.test(e))).toBe(false);
		expect((r.value.errors as string[]).some((e) => e.includes('phase "Implementation" maps 1 BDD scenario(s) but declares no test deliverable'))).toBe(true);
		expect(r.value.pass).toBe(false);
	});
	it("a coercible single-OBJECT phase WITH deliverables passes the trace gate outright (F6 intent after AC-11)", async () => {
		const { runHelper } = await import("../src/helpers.ts");
		const specDir = `${dir}/docs/specifications/05-x2/`;
		mkdirSync(specDir, { recursive: true });
		writeFileSync(`${specDir}01-requirements.md`, requirementsDoc(["AC-01"]));
		writeFileSync(`${specDir}02-bdd-scenarios.md`, bddDoc([{ id: "001", ac: "AC-01" }]));
		writeFileSync(`${specDir}04-specification.md`, specDoc(["SCENARIO-001"], ["AC-01"]));
		writeFileSync(`${specDir}05-implementation-plan.md`, "## Phase 1: Implementation\nDo it.");
		writeFileSync(`${specDir}06-task-list.md`, "- [ ] **Implementation**: build it");
		const setup = mkSetup(specDir);
		const r = await runHelper({ name: "gate-spec-trace", sources: { "write-spec": { specificationPath: `${specDir}04-specification.md`, phaseCount: 3, acceptanceCriteriaRefs: ["AC-01"], scenarioRefs: ["SCENARIO-001"], phases: { name: "Implementation", description: "build it", deliverables: { requireScenarios: ["SCENARIO-001"] } }, tasks: [{ phase: "Implementation", description: "build it", scenarioRefs: ["SCENARIO-001"] }] }, setup } });
		// The single-object branch (b) spreads the original object, so the
		// deliverables survive coercion (AC-19) and the phase passes the AC-11
		// guard — a coercible value still costs ZERO rounds.
		expect(r.value.pass).toBe(true);
		expect(r.value.errors).toEqual([]);
	});
	it("still FAILS when phases cannot be coerced at all (null/garbage)", async () => {
		const { runHelper } = await import("../src/helpers.ts");
		const specDir = `${dir}/docs/specifications/05-y/`;
		mkdirSync(specDir, { recursive: true });
		writeFileSync(`${specDir}04-specification.md`, ("# Spec\nReferences SCENARIO-001.\n## Testing Strategy\nunit tests.\n" + "x".repeat(500)));
		writeFileSync(`${specDir}05-implementation-plan.md`, "plan");
		writeFileSync(`${specDir}06-task-list.md`, "tasks");
		const setup = mkSetup(specDir);
		const r = await runHelper({ name: "gate-spec-trace", sources: { "write-spec": { specificationPath: `${specDir}04-specification.md`, phaseCount: 3, phases: { garbage: true } }, setup } });
		expect(r.value.pass).toBe(false);
		expect((r.value.errors as string[]).some((e) => /spec\.phases must be a non-empty array/.test(e))).toBe(true);
	});
});

// ── F5 (RC5 + code-review R5): identifier extraction must read NORMATIVE
// content only, with a closed-set heading match and fence transparency.
describe("stripNonNormativeSections (F5/R5)", () => {
	it("strips Prior Review Responses prose explaining removed out-of-range ids", () => {
		const doc = "## Architecture\nCovers AC-01.\n\n## Prior Review Responses\nCF-spec-1: removed AC-24, AC-27, AC-29 as out of range.\n\n## Testing Strategy\nCovers SCENARIO-001.\n";
		const stripped = stripNonNormativeSections(doc);
		expect(stripped).toContain("Covers AC-01.");
		expect(stripped).toContain("Covers SCENARIO-001.");
		expect(stripped).not.toContain("AC-24");
	});
	// M14 pin flip (OQ-2, SCENARIO-053): the heading vocabulary widened to
	// H1–H4 + WORD-LED qualifiers from a fixed set ("for Phase 2", "Round 3", …)
	// — "## Evidence Notes for Phase 2" is now non-normative and strips; the
	// lookalike "## Convergence Criteria" still never strips (the over-strip
	// guard: "Criteria" is not in the qualifier vocabulary).
	it("accepts decorated headings but does NOT strip lookalike normative sections", () => {
		const doc = "## Convergence Criteria\nSCENARIO-005 must hold.\n\n## Prior Review Responses (Round 3)\nremoved AC-99\n\n## Evidence Notes — Phase 2\nAC-88 was purged\n\n## Evidence Notes for Phase 2\nAC-77 also stripped (word-led qualifier \"for\" is in the M14 vocabulary)\n";
		const stripped = stripNonNormativeSections(doc);
		// normative lookalike survives
		expect(stripped).toContain("SCENARIO-005 must hold.");
		// parenthetical/dash decorations of the closed set still strip
		expect(stripped).not.toContain("AC-99");
		expect(stripped).not.toContain("AC-88");
		// M14 (SCENARIO-052): word-led qualifiers from the fixed vocabulary now
		// strip too — the old \"trailing prose words\" pin flipped per OQ-2.
		expect(stripped).not.toContain("AC-77");
	});
	it("SCENARIO-053: \"## Convergence Criteria\" never strips (over-strip guard pin)", () => {
		const doc = "## Convergence Criteria\n- AC-01 must hold.\n- SCENARIO-005 verified.\n\n## Evidence Notes\nAC-88 purged here\n";
		const stripped = stripNonNormativeSections(doc);
		expect(stripped).toContain("## Convergence Criteria");
		expect(stripped).toContain("AC-01 must hold.");
		expect(stripped).toContain("SCENARIO-005 verified.");
		expect(stripped).not.toContain("AC-88");
	});
	it("keeps deeper headings inside a stripped section skipped, closes at the same level", () => {
		const doc = "## Evidence Notes\n### Details\nAC-77 hidden here\n\n## Next Section\nAC-01 visible.\n";
		const stripped = stripNonNormativeSections(doc);
		expect(stripped).not.toContain("AC-77");
		expect(stripped).toContain("AC-01 visible.");
	});
	it("treats fenced code blocks as prose — a '## ' line inside fences never toggles sections", () => {
		const doc = "## Evidence Notes\n```md\n## Not a real heading\n```\nAC-66 still hidden in the section\n\n## Real Next\nAC-02 visible.\n";
		const stripped = stripNonNormativeSections(doc);
		expect(stripped).not.toContain("AC-66");
		expect(stripped).toContain("AC-02 visible.");
	});
	// ── AC-13 (SCENARIO-028/029/030): CommonMark fence pairing — a closing
	// fence must use the SAME character at ≥ the opening length ──
	it("AC-13 (SCENARIO-028): a ~~~ outer fence survives an inner ``` fence (char mismatch never closes)", () => {
		const doc = [
			"## Evidence Notes",
			"~~~",
			"```js",
			"## Fake Close Attempt",
			"INNER-TOKEN-028 and LEAK-TOKEN-028 sit inside the ~~~ fence",
			"```",
			"~~~",
			"",
			"## Next Section",
			"AC-01 visible.",
		].join("\n");
		const stripped = stripNonNormativeSections(doc);
		// The inner ``` (wrong char) must NOT close the outer ~~~ fence — so the
		// fake-close heading + payload stay fenced/skipped and never leak.
		expect(stripped).not.toContain("Fake Close Attempt");
		expect(stripped).not.toContain("LEAK-TOKEN-028");
		expect(stripped).not.toContain("INNER-TOKEN-028");
		expect(stripped).toContain("## Next Section");
		expect(stripped).toContain("AC-01 visible.");
	});
	it("AC-13 (SCENARIO-029): a ```` outer fence beats an inner ``` fence (shorter same-char run never closes)", () => {
		const doc = [
			"## Prior Review Responses",
			"````",
			"```md",
			"## Fake Close Attempt",
			"INNER-TOKEN-029: a shorter ``` run must not close the 4-fence",
			"```",
			"still inside the 4-backtick fence (LEAK-TOKEN-029)",
			"````",
			"",
			"## Next Section",
			"AC-01 visible.",
		].join("\n");
		const stripped = stripNonNormativeSections(doc);
		expect(stripped).not.toContain("Fake Close Attempt");
		expect(stripped).not.toContain("INNER-TOKEN-029");
		expect(stripped).not.toContain("LEAK-TOKEN-029");
		expect(stripped).toContain("## Next Section");
		expect(stripped).toContain("AC-01 visible.");
	});
	it("AC-13 (SCENARIO-030): an unclosed ``` before a response heading implicitly closes at the non-normative heading and still strips — no fenced payload leaks", () => {
		const doc = [
			"## Evidence Notes",
			"```",
			"FENCED-TOKEN-030 lives in the never-closed fence",
			"## Prior Review Responses",
			"AC-99 removed as out of range",
			"",
			"## Next Section",
			"AC-01 visible.",
		].join("\n");
		const stripped = stripNonNormativeSections(doc);
		expect(stripped).not.toContain("FENCED-TOKEN-030");
		expect(stripped).not.toContain("AC-99");
		expect(stripped).toContain("## Next Section");
		expect(stripped).toContain("AC-01 visible.");
	});
	// ── AC-25 (SCENARIO-052): heading vocabulary widens to H1–H4 ──
	it("AC-25 (SCENARIO-052): decorated non-normative headings at levels 1–4 all strip (word-led qualifiers accepted)", () => {
		const doc = [
			"# Evidence Notes",
			"AC-H1-052 hidden",
			"# Normative Keeper",
			"AC-00 visible.",
			"## Evidence Notes for Phase 2",
			"AC-H2Q-052 hidden",
			"### Prior Review Responses",
			"AC-H3-052 hidden",
			"#### Prior Review Responses Round 3",
			"AC-H4-052 hidden",
			"## Final Section",
			"AC-01 visible here.",
		].join("\n");
		const stripped = stripNonNormativeSections(doc);
		expect(stripped).not.toContain("AC-H1-052");
		expect(stripped).not.toContain("AC-H2Q-052");
		expect(stripped).not.toContain("AC-H3-052");
		expect(stripped).not.toContain("AC-H4-052");
		expect(stripped).toContain("AC-00 visible.");
		expect(stripped).toContain("AC-01 visible here.");
	});
	it("AC-13: fenced content inside a KEPT section is preserved verbatim", () => {
		const doc = [
			"## Real Section",
			"```js",
			"KEPT-FENCED-TOKEN stays",
			"```",
			"",
			"## Evidence Notes",
			"AC-88 purged",
		].join("\n");
		const stripped = stripNonNormativeSections(doc);
		expect(stripped).toContain("KEPT-FENCED-TOKEN stays");
		expect(stripped).not.toContain("AC-88");
	});
});

// ── F6 + code-review R2: coercible spec controls are normalized BEFORE render
// so docs regenerate and control/docs/implementation agree.
describe("normalizeSpecControl (F6/R2)", () => {
	it("coerces a phases string to the normalized array", async () => {
		const { normalizeSpecControl } = await import("../src/stages/writers.ts");
		const out = normalizeSpecControl({ phases: "Phase One\nPhase Two" });
		expect(Array.isArray(out.phases)).toBe(true);
		expect((out.phases as Array<{ name: string }>).map((p) => p.name)).toEqual(["Phase One", "Phase Two"]);
	});
	it("unwraps {phases:[…]} and numeric-key maps", async () => {
		const { normalizeSpecControl } = await import("../src/stages/writers.ts");
		const wrapped = normalizeSpecControl({ phases: { phases: [{ name: "A" }] } });
		expect((wrapped.phases as Array<{ name: string }>)[0]?.name).toBe("A");
		const mapped = normalizeSpecControl({ phases: { "1": { name: "B" }, "2": { name: "C" } } });
		expect((mapped.phases as Array<{ name: string }>).map((p) => p.name)).toEqual(["B", "C"]);
	});
	it("leaves already-valid arrays and uncoercible values untouched", async () => {
		const { normalizeSpecControl } = await import("../src/stages/writers.ts");
		const ok = [{ name: "A", description: "d" }];
		expect(normalizeSpecControl({ phases: ok }).phases).toBe(ok);
		expect(normalizeSpecControl({ phases: { garbage: true } }).phases).toEqual({ garbage: true });
	});
});
