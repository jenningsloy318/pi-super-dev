/**
 * P1.7 (dsh-09 v3 Phase P): the event-consumer invariants registry — CI
 * enforcement of the contract fold consumers rely on. Real runWorkflow streams
 * must satisfy INV-L1..L6; synthetic broken streams must be rejected.
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runWorkflow } from "../src/workflow.ts";
import { sequence, task } from "../src/nodes.ts";
import { readRunEvents, checkRunLogInvariants, type RunEvent } from "../src/runlog.ts";
import type { PipelineState, Stage, StageContext, Workflow } from "../src/types.ts";

function fakeSetupStage(specDir: string): Stage {
	return {
		id: "setup",
		label: "Setup",
		async run() {
			return { worktreePath: specDir, specDirectory: specDir, defaultBranch: "main", language: "backend", isWebUi: false, specIdentifier: "01-t", worktreeCreated: false, initializedRepo: false } as never;
		},
	};
}

const ev = (seq: number, type: string, over: Partial<RunEvent> = {}): RunEvent =>
	({ seq, time: `2026-08-16T10:00:${String(seq).padStart(2, "0")}Z`, runId: "r1", type, data: {}, ...over }) as RunEvent;

describe("run-log invariants (P1.7)", () => {
	it("a real runWorkflow stream satisfies every invariant", async () => {
		const d = mkdtempSync(join(tmpdir(), "sd-p17-"));
		try {
			const wf: Workflow = {
				id: "t",
				root: sequence([
					task(fakeSetupStage(d)),
					task({ id: "classify", label: "Classify", run: async () => ({}) as never }),
					task({ id: "research", label: "Research", run: async () => { throw new Error("nope"); } }),
				]),
			} as unknown as Workflow;
			await runWorkflow(wf, "t", {});
			const violations = checkRunLogInvariants(readRunEvents(d));
			expect(violations).toEqual([]);
		} finally { rmSync(d, { recursive: true, force: true }); }
	});

	it("rejects a seq gap (INV-L1)", () => {
		const v = checkRunLogInvariants([ev(1, "run.started"), ev(3, "run.completed")]);
		expect(v.some((x) => x.includes("INV-L1"))).toBe(true);
	});

	it("rejects non-monotonic time (INV-L2)", () => {
		const v = checkRunLogInvariants([ev(1, "run.started"), { ...ev(2, "run.completed"), time: "2026-08-16T09:00:00Z" }]);
		expect(v.some((x) => x.includes("INV-L2"))).toBe(true);
	});

	it("rejects a missing run.started bracket (INV-L5)", () => {
		const v = checkRunLogInvariants([ev(1, "stage.started", { stage: "x" }), ev(2, "stage.completed", { stage: "x" }), ev(3, "run.completed")]);
		expect(v.some((x) => x.includes("INV-L5"))).toBe(true);
	});

	it("rejects interleaved runs (INV-L4) and a zombie stage after run.completed (INV-L6)", () => {
		const interleaved = [
			ev(1, "run.started", { runId: "a" }),
			ev(2, "run.started", { runId: "b" }),
			ev(3, "run.completed", { runId: "b" }),
			ev(4, "run.completed", { runId: "a" }),
		];
		expect(checkRunLogInvariants(interleaved).some((x) => x.includes("INV-L4"))).toBe(true);
		const zombie = [ev(1, "run.started"), ev(2, "stage.started", { stage: "x" }), ev(3, "run.completed")];
		expect(checkRunLogInvariants(zombie).some((x) => x.includes("INV-L6"))).toBe(true);
	});

	it("an interrupted run (no run.completed) with an open stage is NOT a violation — a fact, not a defect", () => {
		const killed = [ev(1, "run.started"), ev(2, "stage.started", { stage: "implementation" })];
		expect(checkRunLogInvariants(killed)).toEqual([]);
	});

	it("two sequential runs in one file (replan restart shape) satisfy every invariant", () => {
		const a: RunEvent[] = [
			ev(1, "run.started", { runId: "a" }),
			ev(2, "stage.started", { stage: "setup", runId: "a" }),
			ev(3, "stage.completed", { stage: "setup", runId: "a" }),
			ev(4, "replan.requested", { stage: "verify", runId: "a" }),
			ev(5, "run.completed", { runId: "a" }),
		];
		const b: RunEvent[] = [
			ev(6, "run.started", { runId: "b" }),
			ev(7, "replan.resumed", { runId: "b" }),
			ev(8, "stage.started", { stage: "setup", runId: "b" }),
			ev(9, "stage.completed", { stage: "setup", runId: "b" }),
			ev(10, "run.completed", { runId: "b" }),
		];
		expect(checkRunLogInvariants([...a, ...b])).toEqual([]);
	});
});
