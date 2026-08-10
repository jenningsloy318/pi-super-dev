import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { specConvergenceNode } from "../src/stages/spec-convergence.ts";
import { runHelper } from "../src/helpers.ts";
import { getConvergenceLedger } from "../src/convergence-ledger.ts";
import { renderRetryFeedbackBlock, type RetryFeedbackInput } from "../src/retry-feedback.ts";
import type { AgentCall, AgentResult, Budget, ControlObj, HelperCall, PipelineState, SetupControl, StageContext } from "../src/types.ts";

const dims = ["Completeness", "Consistency", "Feasibility", "Testability", "Traceability", "Grounding", "Complexity", "Ambiguity"];

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

function seedDocs(s: SetupControl) {
	mkdirSync(s.specDirectory, { recursive: true });
	writeFileSync(`${s.specDirectory}01-requirements.md`, [
		"# Requirements",
		"## Executive Summary",
		"Build the feature with explicit traceability. " + "details ".repeat(30),
		"## Acceptance Criteria",
		"- AC-01: primary behavior works",
		"- AC-02: edge behavior works",
		"## Non-Functional Requirements",
		"Keep the implementation testable.",
	].join("\n"));
	writeFileSync(`${s.specDirectory}02-bdd-scenarios.md`, [
		"# BDD Scenarios",
		"### SCENARIO-001: primary behavior",
		"**Given** AC-01 setup",
		"**When** the feature runs",
		"**Then** AC-01 is satisfied",
		"References: AC-01",
		"### SCENARIO-002: edge behavior",
		"**Given** AC-02 setup",
		"**When** the edge case runs",
		"**Then** AC-02 is satisfied",
		"References: AC-02",
	].join("\n"));
}

function specControl(refs: string[], mappedRefs = refs, acRefs = ["AC-01", "AC-02"]): ControlObj {
	return {
		title: "Feature Spec",
		date: "2026-08-07",
		summary: "A complete specification. " + "summary ".repeat(35),
		architecture: "Use the existing architecture and preserve module boundaries. " + "architecture ".repeat(25),
		testingStrategy: "Unit tests and integration tests cover each mapped scenario. " + "testing ".repeat(20),
		acceptanceCriteriaRefs: acRefs,
		scenarioRefs: refs,
		phases: [{ name: "Implementation", description: "Implement and test the behavior.", scenarioRefs: mappedRefs }],
		tasks: [{ phase: "Implementation", description: "Implement behavior for mapped scenarios.", scenarioRefs: mappedRefs }],
	};
}

function specControlWithResponses(responses: Array<Record<string, unknown>>): ControlObj {
	return { ...specControl(["SCENARIO-001", "SCENARIO-002"]), reviewResponses: responses };
}

function reviewControl(verdict: string, findings: Array<Record<string, unknown>> = []): ControlObj {
	return {
		title: "Spec Review",
		date: "2026-08-07",
		verdict,
		summary: verdict === "Approved" ? "Spec is complete." : "Spec needs correction.",
		findings,
		dimensions: dims.map((name) => ({ name, status: verdict === "Approved" ? "pass" : "fail", notes: `${name} reviewed.` })),
	};
}

function budget(): Budget {
	return { count: 0, check: () => true, spent() { this.count++; return true; } };
}

function ctx(state: PipelineState, specControls: ControlObj[], reviewControls: ControlObj[], seenSpecFeedback: RetryFeedbackInput[][]): StageContext {
	let specCalls = 0;
	let reviewCalls = 0;
	return {
		task: "implement feature",
		options: {},
		state,
		budget: budget(),
		log() {},
		phase() {},
		events: new EventEmitter(),
		results: [],
		async agent(call: AgentCall): Promise<AgentResult> {
			if (call.agent === "spec-writer") {
				const fb = ((state as Record<string, unknown>).__feedback as Record<string, RetryFeedbackInput[]> | undefined)?.spec ?? [];
				seenSpecFeedback.push([...fb]);
				return { text: "", control: specControls[Math.min(specCalls++, specControls.length - 1)] };
			}
			if (call.agent === "spec-reviewer") {
				return { text: "", control: reviewControls[Math.min(reviewCalls++, reviewControls.length - 1)] };
			}
			throw new Error(`unexpected agent ${call.agent}`);
		},
		async helper(call: HelperCall) { return runHelper(call); },
		async parallel(calls) { return Promise.all(calls.map((call) => call())); },
	};
}

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "sd-spec-converge-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("specConvergenceNode", () => {
	it("feeds spec-review findings back into the next spec-writer attempt", async () => {
		const s = setup(dir);
		seedDocs(s);
		const state: PipelineState = { setup: s, classify: { taskType: "feature", uiScope: "none", language: "backend", isWebUi: false } };
		const seen: RetryFeedbackInput[][] = [];

		const result = await specConvergenceNode.run(
			state,
			ctx(
				state,
				[specControl(["SCENARIO-001", "SCENARIO-002"]), specControl(["SCENARIO-001", "SCENARIO-002"])],
				[
					reviewControl("Changes Requested", [{ id: "TRACE-1", severity: "high", title: "Traceability gap", detail: "Clarify AC-02 scenario mapping." }]),
					reviewControl("Approved"),
				],
				seen,
			),
		);

		expect(result.status).toBe("ok");
		expect(result.attempts).toBe(2);
		expect(seen[0]).toEqual([]);
		const renderedFeedback = renderRetryFeedbackBlock(seen[1]);
		expect(renderedFeedback).toContain("The latest specification was rejected by spec review");
		expect(renderedFeedback).not.toContain("1/5");
		expect(renderedFeedback).toContain("Traceability gap");
		expect(((state as Record<string, unknown>).__feedback as Record<string, string[]> | undefined)?.spec).toBeUndefined();
	});

	it("continues spec/review convergence beyond the shared workflow attempt count", async () => {
		const s = setup(dir);
		seedDocs(s);
		const state: PipelineState = { setup: s, classify: { taskType: "feature", uiScope: "none", language: "backend", isWebUi: false } };
		const seen: RetryFeedbackInput[][] = [];
		const result = await specConvergenceNode.run(
			state,
			ctx(
				state,
				Array.from({ length: 6 }, () => specControl(["SCENARIO-001", "SCENARIO-002"])),
				[
					...Array.from({ length: 5 }, (_, i) => reviewControl("Changes Requested", [{ id: `AMB-${i + 1}`, severity: "high", title: `Ambiguity ${i + 1}`, detail: "Clarify before implementation.", ownerStage: "spec", blocking: true, status: "open", recommendation: "Resolve ambiguity.", evidence: ["review evidence"] }])),
					reviewControl("Approved"),
				],
				seen,
			),
		);

		expect(result.status).toBe("ok");
		expect(result.attempts).toBe(6);
		expect(seen).toHaveLength(6);
		expect(renderRetryFeedbackBlock(seen[5])).toContain("Ambiguity 5");
		expect(renderRetryFeedbackBlock(seen[5])).not.toContain("/5");
	});

	it("does not run spec review until deterministic traceability passes", async () => {
		const s = setup(dir);
		seedDocs(s);
		const state: PipelineState = { setup: s, classify: { taskType: "feature", uiScope: "none", language: "backend", isWebUi: false } };
		const seen: RetryFeedbackInput[][] = [];

		const result = await specConvergenceNode.run(
			state,
			ctx(
				state,
				[
					specControl(["SCENARIO-001"], ["SCENARIO-001"], ["AC-01"]),
					specControl(["SCENARIO-001", "SCENARIO-002"]),
				],
				[reviewControl("Approved")],
				seen,
			),
		);

		expect(result.status).toBe("ok");
		expect(result.attempts).toBe(2);
		const renderedFeedback = renderRetryFeedbackBlock(seen[1]);
		expect(renderedFeedback).toContain("deterministic trace gate");
		expect(renderedFeedback).toContain("SCENARIO-002");
		expect(renderedFeedback).toContain("AC-02");
	});

	it("keeps prior spec-review findings in the ledger-backed retry prompt until verified", async () => {
		const s = setup(dir);
		seedDocs(s);
		const state: PipelineState = { setup: s, classify: { taskType: "feature", uiScope: "none", language: "backend", isWebUi: false } };
		const seen: RetryFeedbackInput[][] = [];

		const result = await specConvergenceNode.run(
			state,
			ctx(
				state,
				[
					specControl(["SCENARIO-001", "SCENARIO-002"]),
					specControlWithResponses([{ findingId: "TRACE-1", status: "addressed", response: "Mapped AC-02 to SCENARIO-002.", evidence: "phase scenarioRefs", ownerStage: "spec" }]),
					specControlWithResponses([
						{ findingId: "TRACE-1", status: "addressed", response: "Mapped AC-02 to SCENARIO-002.", evidence: "phase scenarioRefs", ownerStage: "spec" },
						{ findingId: "GROUND-2", status: "addressed", response: "Named the concrete route file.", evidence: "deliverables", ownerStage: "spec" },
					]),
				],
				[
					reviewControl("Changes Requested", [{ id: "TRACE-1", severity: "high", title: "Traceability gap", detail: "Clarify AC-02 scenario mapping.", ownerStage: "spec", blocking: true, status: "open", recommendation: "Map AC-02 to work.", evidence: ["AC-02 missing"] }]),
					reviewControl("Changes Requested", [{ id: "GROUND-2", severity: "high", title: "Wrong route file", detail: "Specific route exists and must be named.", ownerStage: "spec", blocking: true, status: "open", recommendation: "Use concrete route path.", evidence: ["refresh/route.ts exists"] }]),
					reviewControl("Approved"),
				],
				seen,
			),
		);

		expect(result.status).toBe("ok");
		expect(result.attempts).toBe(3);
		const secondAttemptFeedback = renderRetryFeedbackBlock(seen[1]);
		expect(secondAttemptFeedback).toContain("TRACE-1");
		const thirdAttemptFeedback = renderRetryFeedbackBlock(seen[2]);
		expect(thirdAttemptFeedback).toContain("TRACE-1");
		expect(thirdAttemptFeedback).toContain("GROUND-2");
		const ledger = getConvergenceLedger(state);
		expect(ledger.findings.find((f) => f.id === "TRACE-1")?.status).toBe("verified");
		expect(ledger.findings.find((f) => f.id === "GROUND-2")?.status).toBe("verified");
	});

	it("surfaces upstream-owned review findings instead of losing their owner routing", async () => {
		const s = setup(dir);
		seedDocs(s);
		const state: PipelineState = { setup: s, classify: { taskType: "feature", uiScope: "none", language: "backend", isWebUi: false } };
		const seen: RetryFeedbackInput[][] = [];

		const result = await specConvergenceNode.run(
			state,
			ctx(
				state,
				[specControl(["SCENARIO-001", "SCENARIO-002"]), specControl(["SCENARIO-001", "SCENARIO-002"])],
				[
					reviewControl("Changes Requested", [{ id: "BDD-1", severity: "high", title: "BDD example missing", detail: "BDD does not define the refresh-cookie edge case.", ownerStage: "bdd", blocking: true, status: "open", recommendation: "Add the missing BDD scenario before spec locks phases.", evidence: ["no SCENARIO for refresh-cookie edge"] }]),
					reviewControl("Approved"),
				],
				seen,
			),
		);

		expect(result.status).toBe("ok");
		const renderedFeedback = renderRetryFeedbackBlock(seen[1]);
		expect(renderedFeedback).toContain("BDD-1");
		expect(renderedFeedback).toContain("owner=bdd upstream");
		const finding = getConvergenceLedger(state).findings.find((f) => f.id === "BDD-1");
		expect(finding?.ownerStage).toBe("bdd");
		expect(finding?.invalidatesStages).toContain("spec");
		expect(finding?.invalidatesStages).toContain("implementation");
	});
});
