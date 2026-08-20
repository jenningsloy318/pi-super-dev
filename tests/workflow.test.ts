/**
 * Composition integrity: imports the real super-dev workflow module and asserts
 * the node tree is well-formed. This validates the entire module graph loads
 * (all stages, nodes, prompts, helpers wire together) WITHOUT spawning agents.
 */

import { describe, it, expect } from "vitest";
import { getEventListeners } from "node:events";
import { SUPER_DEV_WORKFLOW } from "../src/stages/index.ts";
import { runWorkflow, sleepMs } from "../src/workflow.ts";
import { gate, task, sequence, FatalAbort } from "../src/nodes.ts";
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
	it("reports 'failed' + cancellation error when the root returns cancelled", async () => {
		const cancelledRoot: Node = { kind: "cancelled", async run() { return { status: "cancelled" }; } };
		const s = await runWorkflow(wf(cancelledRoot), "t");
		expect(s.status).toBe("failed");
		expect(s.error).toBe("workflow cancelled");
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
		expect(s.status).toBe("partial");	});
	it("logs an honest PARTIAL completion line (not a bare 'complete') when phases are unfinished", async () => {
		const logs: string[] = [];
		await runWorkflow(
			wf(seed({ implementation: { totalPhases: 3, phasesCompleted: 1, allGreen: false, phaseStatus: [{ id: "phase-01", status: "green" }, { id: "phase-02", status: "partial" }, { id: "phase-03", status: "partial" }] } })),
			"t",
			{ progress: { log: (m: string) => logs.push(m), phase() {} } } as never,
		);
		const complete = logs.find((l) => l.includes('Workflow "test" complete'));
		expect(complete).toBeDefined();
		expect(complete).toContain("PARTIAL");
		expect(complete).toContain("1/3");
		// v0.3.0: partial phases surface in the summary (best attempts stash-preserved)
		expect(complete).toContain("2 partial");
	});
	it("logs a plain 'complete' when implementation is fully green", async () => {
		const logs: string[] = [];
		await runWorkflow(
			wf(seed({ implementation: { totalPhases: 2, phasesCompleted: 2, allGreen: true }, review: { verdict: "Approved" } })),
			"t",
			{ progress: { log: (m: string) => logs.push(m), phase() {} } } as never,
		);
		const complete = logs.find((l) => l.includes('Workflow "test" complete'));
		expect(complete).toBeDefined();
		expect(complete).not.toContain("PARTIAL");
	});
	it("R5: logs PARTIAL when implementation is green but a hard gate failed (log derives from status, not allGreen)", async () => {
		const logs: string[] = [];
		await runWorkflow(
			wf(seed({ implementation: { totalPhases: 2, phasesCompleted: 2, allGreen: true }, review: { verdict: "Approved" }, preMergeBuild: { pass: false } })),
			"t",
			{ progress: { log: (m: string) => logs.push(m), phase() {} } } as never,
		);
		const complete = logs.find((l) => l.includes('Workflow "test" complete'));
		expect(complete).toBeDefined();
		// Previously said bare "complete" because allGreen was true; now derived from status.
		expect(complete).toContain("PARTIAL");
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

// ─── T7.6 / A-05 (NFR-6 pinning): workflow sleepMs removes its abort listener ──
describe("A-05: sleepMs (workflow.ts) removes its abort listener on normal resolution", () => {
	it("a resolved sleepMs leaves the signal's abort-listener count unchanged", async () => {
		const controller = new AbortController();
		const baseline = getEventListeners(controller.signal, "abort").length;
		await sleepMs(5, controller.signal);
		// RED today: the once-listener survives the timer resolution (+1 leak)
		expect(getEventListeners(controller.signal, "abort").length).toBe(baseline);
	});

	it("a retry-heavy cadence on ONE shared run signal never accumulates listeners", async () => {
		const controller = new AbortController();
		const baseline = getEventListeners(controller.signal, "abort").length;
		for (let i = 0; i < 12; i++) await sleepMs(1, controller.signal);
		expect(getEventListeners(controller.signal, "abort").length).toBe(baseline);
	});

	it("an abort while sleeping resolves immediately (abort path preserved, listener gone)", async () => {
		const controller = new AbortController();
		const p = sleepMs(5_000, controller.signal);
		controller.abort();
		await p; // must not hang for 5s
		expect(getEventListeners(controller.signal, "abort").length).toBe(0);
	});
});

// ─── T7.2 / SD-05 (NFR-6 pinning): accepted fatal-gate limitations are never success ──
//
// A fatal gate whose escalation the user resolves with `accept-limitation`
// returns {status:"ok"} from the gate — but the underlying artifact NEVER
// validated. Without a recorded marker + status derivation, failedStages stays
// empty and a green-looking run derives "success" with a foundational
// artifact that never passed its gate.
describe("SD-05: accept-limitation on a fatal gate yields partial, never success", () => {
	const mockStage = (id: string, fn: (s: PipelineState) => unknown): Stage =>
		({ id, label: id, async run(s) { return fn(s); } });

	it("records state.__acceptedLimitations[feedbackKey] when the escalation accepts the limitation", async () => {
		const writer = task(mockStage("requirements", () => 1));
		const fatalGate = gate(
			{ validate: () => ({ pass: false, errors: ["no requirements doc produced"] }), feedbackKey: "requirements", attempts: 1, fatal: true },
			writer,
		);
		const root = sequence([fatalGate, seed({})]);
		const s = await runWorkflow(wf(root), "t", { escalate: async () => ({ choice: "accept-limitation" }) });
		// the acceptance stands — the gate returned ok and the run was not aborted
		expect(s.error).toBeUndefined();
		const marker = (s.state as Record<string, unknown>).__acceptedLimitations as Record<string, unknown> | undefined;
		expect(marker).toBeDefined();
		expect(marker?.["requirements"]).toBeDefined();
	});

	it("runWorkflow derives 'partial' (never 'success') for an accepted fatal-gate limitation", async () => {
		const writer = task(mockStage("requirements", () => 1));
		const fatalGate = gate(
			{ validate: () => ({ pass: false, errors: ["no requirements doc produced"] }), feedbackKey: "requirements", attempts: 1, fatal: true },
			writer,
		);
		const root = sequence([fatalGate, seed({ implementation: { totalPhases: 2, allGreen: true }, review: { verdict: "Approved" } })]);
		const s = await runWorkflow({ id: "t", root }, "t", { escalate: async () => ({ choice: "accept-limitation" }) });
		expect(s.status).toBe("partial"); // RED today: "success"
		expect((s.state as Record<string, unknown>).__acceptedLimitations).toBeDefined();
	});
});

// ─── T7.4 / A-03 (NFR-6 pinning): __replan never masks a subsequent abort ─────
//
// The replan marker used to win the status derivation unconditionally: once
// state.__replan was set, ANY later throw/cancellation was reclassified as
// "replan" (auto-resumed by the extension) with the real error demoted to
// summary.error. "replan" is only honest when the run was NOT aborted, or
// when the abort IS the replan FatalAbort itself.
describe("A-03: run-status derivation — replan only when not aborted", () => {
	const marker = { rounds: 1, owners: ["requirements"] };
	const impl = { implementation: { totalPhases: 2, allGreen: true }, review: { verdict: "Approved" } };

	it("marker set + a NON-replan crash afterwards → status 'failed', never 'replan'", async () => {
		const root: Node = {
			kind: "replan-then-crash",
			async run(state) {
				Object.assign(state, { __replan: marker, ...impl });
				throw new Error("unexpected crash after the replan trigger");
			},
		};
		const s = await runWorkflow(wf(root), "t");
		expect(s.status).toBe("failed"); // RED today: "replan"
		expect(s.error).toBe("unexpected crash after the replan trigger");
	});

	it("marker set + the REPLAN FatalAbort itself → status stays 'replan' (auto-resume intact)", async () => {
		const root: Node = {
			kind: "replan-fatal",
			async run(state) {
				Object.assign(state, { __replan: marker, ...impl });
				throw new FatalAbort("requirements convergence: REPLAN at round cap — 2 upstream-owned blocking finding(s) routed back to their owning stage(s); restarting to revise");
			},
		};
		const s = await runWorkflow(wf(root), "t");
		expect(s.status).toBe("replan");
	});

	it("marker set + no abort → status 'replan' (the deliberate terminal outcome)", async () => {
		const root: Node = {
			kind: "replan-ok",
			async run(state) {
				Object.assign(state, { __replan: marker, ...impl });
				return { status: "ok" };
			},
		};
		const s = await runWorkflow(wf(root), "t");
		expect(s.status).toBe("replan");
	});
});
