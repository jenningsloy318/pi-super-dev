/**
 * Phase 1 of the unified verify-loop: the verify node is a loop that runs BOTH
 * reviewers (code-review + adversarial) in parallel → merge → fix. This guards
 * the structure so Phase 2 (adding the api/ui test step) doesn't accidentally
 * drop a reviewer or break the loop shape.
 */
import { describe, it, expect } from "vitest";
import { EventEmitter } from "node:events";
import { integrationTestsGreen, expectedIntegrationRoles, integrationLoopNode, reviewLoopNode, reviewLoopUntil } from "../src/stages/verify.ts";
import type { AgentResult, PipelineState, StageContext } from "../src/types.ts";

describe("reviewLoopNode (Phase 1)", () => {
	it("is a loop node (review → fix, iterating until approved)", () => {
		expect(reviewLoopNode.kind).toBe("loop");
		expect(typeof reviewLoopNode.run).toBe("function");
	});
});

describe("review loop exit predicate", () => {
	const ctx = { log: () => {} } as never;
	it("requires both approval and build green", async () => {
		expect(await reviewLoopUntil({ review: { verdict: "Approved" }, buildGate: { pass: false } } as PipelineState, ctx)).toBe(false);
		expect(await reviewLoopUntil({ review: { verdict: "Approved" }, buildGate: { pass: true } } as PipelineState, ctx)).toBe(true);
	});
});

describe("integrationLoopNode", () => {
	it("does not convert a failed bringup/test block into notApplicable success", async () => {
		const state = { review: { verdict: "Approved" }, buildGate: { pass: true } } as PipelineState;
		const ctx: StageContext = {
			task: "t",
			options: {},
			state,
			agent: async (): Promise<AgentResult> => ({ text: "", control: {} }),
			helper: async () => ({ value: {}, digest: "" }),
			parallel: async (calls) => Promise.all(calls.map((call) => call())),
			budget: { count: 0, check: () => false, spent() { this.count++; return false; } },
			log: () => {},
			phase: () => {},
			events: new EventEmitter(),
			results: [],
		};
		const r = await integrationLoopNode.run(state, ctx);
		expect(r.status).toBe("failed");
		expect(state.integration?.pass).toBe(false);
		expect(state.integration?.notApplicable).toBeUndefined();
	});
});

describe("integration test verdict helpers", () => {
	it("does not pass vacuously when no API/UI test was expected or produced", () => {
		expect(integrationTestsGreen({} as PipelineState)).toBe(false);
	});
	it("requires every expected integration role to produce a fresh pass", () => {
		expect(integrationTestsGreen({ integrationExpectedTests: ["api"] } as PipelineState)).toBe(false);
		expect(integrationTestsGreen({ integrationExpectedTests: ["api"], apiTest: { pass: true } } as PipelineState)).toBe(true);
		expect(integrationTestsGreen({ integrationExpectedTests: ["api", "ui"], apiTest: { pass: true } } as PipelineState)).toBe(false);
		expect(integrationTestsGreen({ integrationExpectedTests: ["api", "ui"], apiTest: { pass: true }, uiTest: { pass: "PASS" } } as PipelineState)).toBe(true);
	});
	it("uses explicit expected roles instead of stale old test objects", () => {
		const state = { integrationExpectedTests: [], apiTest: { pass: false }, uiTest: { pass: false } } as unknown as PipelineState;
		expect(expectedIntegrationRoles(state)).toEqual([]);
		expect(integrationTestsGreen(state)).toBe(false);
	});
});
