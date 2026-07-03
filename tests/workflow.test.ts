/**
 * Composition integrity: imports the real super-dev workflow module and asserts
 * the node tree is well-formed. This validates the entire module graph loads
 * (all stages, nodes, prompts, helpers wire together) WITHOUT spawning agents.
 */

import { describe, it, expect } from "vitest";
import { SUPER_DEV_WORKFLOW } from "../src/stages/index.ts";
import { runWorkflow } from "../src/workflow.ts";
import type { Node, NodeResult, PipelineState } from "../src/types.ts";

describe("SUPER_DEV_WORKFLOW composition", () => {
	it("is the super-dev workflow", () => {
		expect(SUPER_DEV_WORKFLOW.id).toBe("super-dev");
	});
	it("root is a sequence (the tolerant pipeline)", () => {
		expect(SUPER_DEV_WORKFLOW.root.kind).toBe("sequence");
		expect(typeof SUPER_DEV_WORKFLOW.root.run).toBe("function");
	});
	it("has a description", () => {
		expect(typeof SUPER_DEV_WORKFLOW.description).toBe("string");
		expect(SUPER_DEV_WORKFLOW.description!.length).toBeGreaterThan(0);
	});
});

/** A node that seeds state then returns ok — stands in for real stages. */
function seed(patch: Partial<PipelineState>): Node {
	return {
		kind: "task",
		async run(state) {
			Object.assign(state, patch);
			return { status: "ok" } as NodeResult;
		},
	};
}

const wf = (root: Node) => ({ id: "test", root });

describe("runWorkflow honest status", () => {
	it("reports 'failed' + error when the root throws (fatal gate abort)", async () => {
		const boom: Node = { kind: "gate", async run() { throw new Error("spec gate exhausted"); } };
		const s = await runWorkflow(wf(boom), "t");
		expect(s.status).toBe("failed");
		expect(s.error).toBe("spec gate exhausted");
	});
	it("reports 'failed' when no implementation was produced", async () => {
		const s = await runWorkflow(wf(seed({})), "t");
		expect(s.status).toBe("failed");
		expect(s.failedStages).toEqual([]);
	});
	it("reports 'success' when implementation is green and review approved", async () => {
		const s = await runWorkflow(
			wf(seed({ implementation: { totalPhases: 2, allGreen: true }, review: { verdict: "Approved" } })),
			"t",
		);
		expect(s.status).toBe("success");
	});
	it("reports 'partial' when implementation is not green", async () => {
		const s = await runWorkflow(
			wf(seed({ implementation: { totalPhases: 2, allGreen: false }, review: { verdict: "Approved" } })),
			"t",
		);
		expect(s.status).toBe("partial");
	});
	it("reports 'partial' when review did not approve", async () => {
		const s = await runWorkflow(
			wf(seed({ implementation: { totalPhases: 2, allGreen: true }, review: { verdict: "Changes Requested" } })),
			"t",
		);
		expect(s.status).toBe("partial");
	});
});
