import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gate, gateValidator, task } from "../src/nodes.ts";
import { runHelper } from "../src/helpers.ts";
import { bddTraceabilityErrors } from "../src/doc-validators.ts";
import type { AgentCall, AgentResult, Budget, HelperCall, PipelineState, SetupControl, Stage, StageContext } from "../src/types.ts";

function setup(dir: string): SetupControl {
	return {
		worktreePath: dir,
		specDirectory: `${dir}/docs/specifications/001-test/`,
		defaultBranch: "main",
		language: "backend",
		isWebUi: false,
		specIdentifier: "001-test",
		worktreeCreated: true,
		initializedRepo: false,
	};
}

function ctx(): StageContext {
	const budget: Budget = { count: 0, check: () => true, spent() { this.count++; return true; } };
	return {
		task: "write BDD",
		options: {},
		state: {},
		budget,
		log() {},
		phase() {},
		events: new EventEmitter(),
		results: [],
		async agent(_call: AgentCall): Promise<AgentResult> { throw new Error("agent should not run"); },
		async helper(call: HelperCall) { return runHelper(call); },
		async parallel(calls) { return Promise.all(calls.map((call) => call())); },
	};
}

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "sd-req-bdd-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("requirements -> BDD gate convergence", () => {
	it("retries the BDD writer with missing-AC feedback until every requirement is covered", async () => {
		const s = setup(dir);
		mkdirSync(s.specDirectory, { recursive: true });
		writeFileSync(`${s.specDirectory}01-requirements.md`, [
			"# Requirements",
			"## Executive Summary",
			"Implement the behavior. " + "details ".repeat(25),
			"## Acceptance Criteria",
			"- AC-01: primary behavior",
			"- AC-02: edge behavior",
			"## Non-Functional Requirements",
			"Keep it testable.",
		].join("\n"));

		let attempts = 0;
		const feedbackSeen: string[][] = [];
		const bddWriter: Stage = {
			id: "bdd",
			label: "BDD",
			async run(state) {
				attempts++;
				const feedback = ((state as Record<string, unknown>).__feedback as Record<string, string[]> | undefined)?.bdd ?? [];
				feedbackSeen.push([...feedback]);
				const coversAc02 = feedback.some((line) => line.includes("AC-02"));
				writeFileSync(`${s.specDirectory}02-bdd-scenarios.md`, [
					"# BDD Scenarios",
					"### SCENARIO-001: primary behavior",
					"**Given** AC-01 setup",
					"**When** the user runs the primary behavior",
					"**Then** AC-01 is satisfied",
					"References: AC-01",
					...(coversAc02 ? [
						"### SCENARIO-002: edge behavior",
						"**Given** AC-02 setup",
						"**When** the user runs the edge behavior",
						"**Then** AC-02 is satisfied",
						"References: AC-02",
					] : []),
				].join("\n"));
				return { docPath: `${s.specDirectory}02-bdd-scenarios.md` };
			},
		};

		const state: PipelineState = { setup: s };
		const result = await gate(
			{ validate: gateValidator("gate-bdd", "write-bdd", "bdd"), feedbackKey: "bdd", attempts: 2, fatal: true },
			task(bddWriter),
		).run(state, ctx());

		expect(result.status).toBe("ok");
		expect(attempts).toBe(2);
		expect(feedbackSeen[0]).toEqual([]);
		expect(feedbackSeen[1].join("\n")).toContain("AC-02");
		expect(((state as Record<string, unknown>).__feedback as Record<string, string[]> | undefined)?.bdd).toBeUndefined();
	});
});

// ── AC-26 (SCENARIO-054): gate-bdd runs on STRIPPED content — a dangling AC id
// inside a non-normative Evidence Notes section is not a gate error ──
describe("bddTraceabilityErrors reads normative content only (AC-26)", () => {
	const requirements = [
		"# Requirements",
		"## Acceptance Criteria",
		...["AC-01", "AC-02", "AC-03", "AC-04", "AC-05"].map((id) => `- ${id}: must satisfy ${id}`),
	].join("\n");
	const scenariosCoveringAc01ToAc05 = ["AC-01", "AC-02", "AC-03", "AC-04", "AC-05"].map((ac, i) => [
		`### SCENARIO-${String(i + 1).padStart(3, "0")}: behavior for ${ac}`,
		`**Given** a precondition tied to ${ac}`,
		"**When** the actor performs the relevant action",
		`**Then** the outcome is verified against ${ac}`,
		`References: ${ac}`,
	].join("\n")).join("\n");

	it("SCENARIO-054: a dangling AC-99 quoted inside `## Evidence Notes` produces no dangling-AC error", () => {
		const bddWithEvidenceNotes = [
			"# BDD Scenarios",
			scenariosCoveringAc01ToAc05,
			"## Evidence Notes",
			"AC-99 was considered and deliberately removed as out of range — it is discussed here, not covered.",
		].join("\n");
		const errors = bddTraceabilityErrors(requirements, bddWithEvidenceNotes);
		expect(errors.some((e) => e.includes("AC-99"))).toBe(false);
		expect(errors).toEqual([]);
	});

	it("SCENARIO-054 (end-to-end): gate-bdd PASSES a doc whose only dangling AC id lives in Evidence Notes", async () => {
		const s = setup(dir);
		mkdirSync(s.specDirectory, { recursive: true });
		writeFileSync(`${s.specDirectory}01-requirements.md`, [
			requirements,
			"## Non-Functional Requirements",
			"Keep it testable. " + "detail ".repeat(20),
		].join("\n"));
		writeFileSync(`${s.specDirectory}02-bdd-scenarios.md`, [
			"# BDD Scenarios",
			scenariosCoveringAc01ToAc05,
			"## Evidence Notes",
			"AC-99 was considered and deliberately removed as out of range — it is discussed here, not covered.",
		].join("\n"));
		const r = await runHelper({
			name: "gate-bdd",
			sources: { "write-bdd": { docPath: `${s.specDirectory}02-bdd-scenarios.md` }, setup: s },
		});
		const errorsForAc99 = (r.value.errors as string[]).filter((e) => e.includes("AC-99"));
		expect(errorsForAc99).toEqual([]);
		expect(r.value.pass).toBe(true);
	});
});

// ── AC-11 (SCENARIO-025): gate-spec-trace fails a scenario-mapped phase that
// declares neither requireScenarios nor requireTests (the silent-empty-success
// hole — phaseTestDeliverableErrors wired into specTraceabilityErrors) ──
describe("gate-spec-trace deliverable guard (AC-11)", () => {
	it("SCENARIO-025: a scenario-mapped phase via tasks with neither requireScenarios nor requireTests fails the gate naming the phase", async () => {
		const s = setup(dir);
		mkdirSync(s.specDirectory, { recursive: true });
		writeFileSync(`${s.specDirectory}01-requirements.md`, [
			"# Requirements",
			"## Executive Summary",
			"Add the thing. " + "lorem ipsum dolor ".repeat(22),
			"## Acceptance Criteria",
			"- AC-01: must satisfy AC-01",
			"- AC-02: must satisfy AC-02",
			"## Non-Functional Requirements",
			"Security and performance must remain acceptable.",
		].join("\n"));
		writeFileSync(`${s.specDirectory}02-bdd-scenarios.md`, [
			"# BDD Scenarios",
			"### SCENARIO-001: behavior for AC-01",
			"**Given** a precondition tied to AC-01",
			"**When** the actor performs the relevant action",
			"**Then** the expected outcome is verified against AC-01",
			"References: AC-01",
			"### SCENARIO-002: behavior for AC-02",
			"**Given** a precondition tied to AC-02",
			"**When** the actor performs the relevant action",
			"**Then** the expected outcome is verified against AC-02",
			"References: AC-02",
		].join("\n"));
		writeFileSync(`${s.specDirectory}04-specification.md`, [
			"# Spec",
			"## Summary",
			"Implement the behavior described by the BDD scenarios. " + "details ".repeat(65),
			"## Architecture",
			"Use the existing module boundaries.",
			"## Testing Strategy",
			"Unit and integration tests cover every referenced BDD scenario.",
			"## Acceptance Criteria References",
			"- AC-01",
			"- AC-02",
			"## BDD Scenario References",
			"- SCENARIO-001",
			"- SCENARIO-002",
		].join("\n"));
		writeFileSync(`${s.specDirectory}05-implementation-plan.md`, "## Phase 1: Implementation\nDo it.");
		writeFileSync(`${s.specDirectory}06-task-list.md`, "- [ ] **Phase 1**: build it");
		const r = await runHelper({
			name: "gate-spec-trace",
			sources: {
				"write-spec": {
					specificationPath: `${s.specDirectory}04-specification.md`,
					phaseCount: 1,
					acceptanceCriteriaRefs: ["AC-01", "AC-02"],
					scenarioRefs: ["SCENARIO-001", "SCENARIO-002"],
					// The phase maps scenarios ONLY via tasks and declares NEITHER
					// requireScenarios NOR requireTests — the SCENARIO-025 shape.
					phases: [{ name: "Phase 1" }],
					tasks: [{ phase: "Phase 1", description: "build it", scenarioRefs: ["SCENARIO-001", "SCENARIO-002"] }],
				},
				setup: s,
			},
		});
		expect(r.value.pass).toBe(false);
		const errors = r.value.errors as string[];
		expect(errors.some((e) => e.includes("phase \"Phase 1\" maps 2 BDD scenario(s) but declares no test deliverable"))).toBe(true);
	});
});
