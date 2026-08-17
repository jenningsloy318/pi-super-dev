import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bddConvergenceNode, requirementsConvergenceNode, researchConvergenceNode, effectiveRoundCap, MAX_CONVERGENCE_ROUNDS, PROGRESS_EXTENSION_ROUNDS } from "../src/stages/artifact-convergence.ts";
import { runHelper } from "../src/helpers.ts";
import { renderRetryFeedbackBlock, type RetryFeedbackInput } from "../src/retry-feedback.ts";
import type { AgentCall, AgentResult, Budget, ControlObj, HelperCall, PipelineState, SetupControl, StageContext } from "../src/types.ts";

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

function budget(maxRounds = 20): Budget {
	// Bounded: the old `check: () => true` let a never-approving reviewer loop
	// forever (→ OOM). 20 is well above the 6-round convergence these scenarios
	// exercise; the MAX_CONVERGENCE_ROUNDS liveness cap is the real backstop.
	let calls = 0;
	return { count: 0, check: () => calls++ < maxRounds, spent() { this.count++; return true; } };
}

function ctx(state: PipelineState, controls: ControlObj[], seen: RetryFeedbackInput[][]): StageContext {
	let writerCalls = 0;
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
			const key = (call.id ?? "").replace(/^pipeline\./, "");
			const fb = ((state as Record<string, unknown>).__feedback as Record<string, RetryFeedbackInput[]> | undefined)?.[key] ?? [];
			seen.push([...fb]);
			// The shift-left reviewer (requirementsReview / bddReview) must APPROVE for
			// the loop to converge once the deterministic gate passes. The pre-review
			// era this file was written for never supplied verdicts, so (after the
			// review-layer regression) it looped forever → OOM. research has NO reviewer.
			if (key === "requirementsReview" || key === "bddReview") {
				return { text: "", control: { verdict: "Approved", summary: "approved", findings: [] } as ControlObj };
			}
			return { text: "", control: controls[Math.min(writerCalls++, controls.length - 1)] };
		},
		async helper(call: HelperCall) { return runHelper(call); },
		async parallel(calls) { return Promise.all(calls.map((call) => call())); },
	};
}

function requirementsControl(openQuestions: string[] = []): ControlObj {
	return {
		title: "Feature Requirements",
		date: "2026-08-10",
		type: "feature",
		priority: "high",
		executiveSummary: "Build a concrete feature with resolved behavior. " + "summary ".repeat(50),
		acceptanceCriteria: [
			{ id: "AC-01", statement: "Primary behavior works." },
			{ id: "AC-02", statement: "Edge behavior is handled." },
		],
		nonFunctional: ["Performance remains acceptable."],
		openQuestions,
	};
}

function bddControl(coverAc02: boolean): ControlObj {
	const scenarios = [
		{ id: "001", title: "primary behavior", acRef: "AC-01", priority: "high", given: "AC-01 setup", when: "the feature runs", then: "AC-01 is satisfied" },
		...(coverAc02 ? [{ id: "002", title: "edge behavior", acRef: "AC-02", priority: "high", given: "AC-02 setup", when: "the edge case runs", then: "AC-02 is satisfied" }] : []),
	];
	return {
		title: "Feature BDD",
		date: "2026-08-10",
		source: "01-requirements.md",
		features: [{ name: "Feature", scenarios }],
		traceability: scenarios.map((scenario) => ({ acId: scenario.acRef, description: scenario.title, scenarios: [`SCENARIO-${scenario.id}`] })),
	};
}

function researchControl(openIssues: string[] = []): ControlObj {
	return {
		title: "Feature Research",
		date: "2026-08-10",
		summary: "Research completed with source-backed recommendations. " + "details ".repeat(25),
		options: [{ name: "Use existing platform pattern", tradeoffs: "Grounded in the platform documentation and keeps implementation small." }],
		sources: [{ title: "Platform Docs", url: "https://example.com/platform-docs" }],
		openIssues,
	};
}

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "sd-artifact-converge-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("artifact convergence nodes", () => {
	it("continues requirements clarification beyond five rounds until open questions are resolved", async () => {
		const s = setup(dir);
		mkdirSync(s.specDirectory, { recursive: true });
		const state: PipelineState = { setup: s, classify: { taskType: "feature", uiScope: "none", language: "backend", isWebUi: false } };
		const seen: RetryFeedbackInput[][] = [];

		const result = await requirementsConvergenceNode.run(
			state,
			ctx(state, [...Array.from({ length: 5 }, () => requirementsControl(["Which behavior should win?"])), requirementsControl([])], seen),
		);

		expect(result.status).toBe("ok");
		expect(result.attempts).toBe(6);
		expect(renderRetryFeedbackBlock(seen[5])).toContain("open question");
		expect(renderRetryFeedbackBlock(seen[5])).not.toContain("/5");
	});

	it("continues BDD convergence beyond five rounds until every requirement AC is covered", async () => {
		const s = setup(dir);
		mkdirSync(s.specDirectory, { recursive: true });
		writeFileSync(`${s.specDirectory}01-requirements.md`, [
			"# Requirements",
			"## Executive Summary",
			"Implement the behavior. " + "details ".repeat(40),
			"## Acceptance Criteria",
			"- AC-01: primary behavior",
			"- AC-02: edge behavior",
			"## Non-Functional Requirements",
			"Performance remains acceptable.",
		].join("\n"));
		const state: PipelineState = { setup: s, requirements: { docPath: `${s.specDirectory}01-requirements.md` } };
		const seen: RetryFeedbackInput[][] = [];

		const result = await bddConvergenceNode.run(
			state,
			ctx(state, [...Array.from({ length: 5 }, () => bddControl(false)), bddControl(true)], seen),
		);

		expect(result.status).toBe("ok");
		expect(result.attempts).toBe(6);
		expect(renderRetryFeedbackBlock(seen[5])).toContain("AC-02");
		expect(renderRetryFeedbackBlock(seen[5])).not.toContain("/5");
	});

	it("continues research beyond five rounds until open issues are source-backed or cleared", async () => {
		const s = setup(dir);
		mkdirSync(s.specDirectory, { recursive: true });
		const state: PipelineState = { setup: s, classify: { taskType: "feature", uiScope: "none", language: "backend", isWebUi: false } };
		const seen: RetryFeedbackInput[][] = [];

		const result = await researchConvergenceNode.run(
			state,
			ctx(state, [...Array.from({ length: 5 }, () => researchControl(["Which protocol version applies?"])), researchControl([])], seen),
		);

		expect(result.status).toBe("ok");
		expect(result.attempts).toBe(6);
		expect(renderRetryFeedbackBlock(seen[5])).toContain("Which protocol version applies");
		expect(renderRetryFeedbackBlock(seen[5])).not.toContain("/5");
	});
});

// ── F2/F3 (adversarial TESTS-MISSING): the round-budget math the convergence
// loops use — resume grants fresh rounds (prior + cap) clamped at 3× the base
// cap, so replay-only resumes fail fast instead of ping-ponging forever.
describe("round-budget math (F2/F3)", () => {
	it("fresh run: effectiveCap = cap", () => {
		expect(effectiveRoundCap(MAX_CONVERGENCE_ROUNDS, 0)).toBe(MAX_CONVERGENCE_ROUNDS);
	});
	it("resume grants fresh rounds: prior + cap", () => {
		expect(effectiveRoundCap(8, 8)).toBe(16);
	});
	it("clamps at 3× the base cap — a replay-happy spec cannot extend forever", () => {
		expect(effectiveRoundCap(8, 40)).toBe(24);
	});
	it("progress extension block is exported and bounded", () => {
		expect(PROGRESS_EXTENSION_ROUNDS).toBeGreaterThan(0);
		expect(PROGRESS_EXTENSION_ROUNDS).toBeLessThanOrEqual(4);
	});
});
