/**
 * Composition integrity: imports the real super-dev workflow module and asserts
 * the node tree is well-formed. This validates the entire module graph loads
 * (all stages, nodes, prompts, helpers wire together) WITHOUT spawning agents.
 */

import { describe, it, expect } from "vitest";
import { SUPER_DEV_WORKFLOW } from "../src/stages/index.ts";
import { runWorkflow } from "../src/workflow.ts";
import { gate, task, sequence } from "../src/nodes.ts";
import type { Node, NodeResult, PipelineState, Stage } from "../src/types.ts";

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

describe("runWorkflow fatal-gate abort (cascading-failure fix)", () => {
	// The fix for "failed but still go on": a foundational doc gate that exhausts
	// must abort the run honestly, NOT feed garbage to downstream stages.
	const mockStage = (id: string, fn: (s: PipelineState) => unknown): Stage =>
		({ id, label: id, async run(s) { return fn(s); } });

	it("a FATAL foundational gate exhaustion aborts with status 'failed' + the real reason", async () => {
		let n = 0;
		const writer = task(mockStage("requirements", () => ++n));
		const fatalReqGate = gate(
			{ validate: () => ({ pass: false, errors: ["no requirements doc produced"] }), feedbackKey: "requirements", attempts: 2, fatal: true },
			writer,
		);
		const downstream = task(mockStage("downstream", () => { throw new Error("downstream must NOT run after a fatal gate"); }));
		const wf = { id: "t", root: sequence([fatalReqGate, downstream], { tolerant: true }) };
		const s = await runWorkflow(wf, "task");
		expect(s.status).toBe("failed");
		expect(s.error).toMatch(/no requirements doc produced/);
	});

	it("a NON-fatal gate exhaustion still yields 'failed' overall when no implementation results", async () => {
		// Non-fatal exhaustion returns {status:failed}; the tolerant pipeline
		// continues but produces no implementation → overall status 'failed'.
		const writer = task(mockStage("g", () => 1));
		const softGate = gate({ validate: () => ({ pass: false, errors: ["soft"] }), attempts: 1 }, writer);
		const wf = { id: "t", root: sequence([softGate], { tolerant: true }) };
		const s = await runWorkflow(wf, "task");
		expect(s.status).toBe("failed"); // no implementation produced
	});
});

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
	it("reports 'partial' when review never ran", async () => {
		const s = await runWorkflow(
			wf(seed({ implementation: { totalPhases: 2, allGreen: true } })),
			"t",
		);
		expect(s.status).toBe("partial");
	});
	it("reports 'partial' when a deterministic build gate failed despite approval", async () => {
		const s = await runWorkflow(
			wf(seed({ implementation: { totalPhases: 2, allGreen: true }, review: { verdict: "Approved" }, preMergeBuild: { pass: false } })),
			"t",
		);
		expect(s.status).toBe("partial");
	});
	it("reports 'partial' when integration failed despite approval", async () => {
		const s = await runWorkflow(
			wf(seed({ implementation: { totalPhases: 2, allGreen: true }, review: { verdict: "Approved" }, integration: { pass: false } })),
			"t",
		);
		expect(s.status).toBe("partial");
	});
	it("reports 'partial' when merge was required but not confirmed", async () => {
		const s = await runWorkflow(
			wf(seed({ implementation: { totalPhases: 2, allGreen: true }, review: { verdict: "Approved" }, preMergeBuild: { pass: true }, cleanup: { blocked: false }, merge: { merged: false } })),
			"t",
		);
		expect(s.status).toBe("partial");
	});
	it("reports 'partial' when any stage failed even if green implementation and review exist", async () => {
		const root: Node = {
			kind: "seed-and-fail-record",
			async run(state, ctx) {
				Object.assign(state, { implementation: { totalPhases: 2, allGreen: true }, review: { verdict: "Approved" } });
				ctx.results.push({ id: "budgeted", label: "Budgeted Stage", status: "failed", error: "budget exhausted" });
				return { status: "ok" };
			},
		};
		const s = await runWorkflow(wf(root), "t");
		expect(s.status).toBe("partial");
		expect(s.failedStages).toEqual([{ label: "Budgeted Stage", error: "budget exhausted" }]);
	});
});
