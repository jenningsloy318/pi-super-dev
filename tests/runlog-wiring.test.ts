/**
 * P1.2 (dsh-09 v3 Phase P): runWorkflow's ledger wiring — one "stage" event
 * subscription captures every stage transition into events.jsonl, buffering
 * until the spec dir exists (setup creates it), and run.started/run.completed
 * bracket the run.
 *
 * Drives runWorkflow with a minimal fake workflow (no agents) so only the
 * wiring is under test.
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runWorkflow } from "../src/workflow.ts";
import { sequence, task } from "../src/nodes.ts";
import { readRunEvents, reconstructStageOutcomes, RUN_LOG_VERSION } from "../src/runlog.ts";
import { SUPER_DEV_EXTENSION_VERSION } from "../src/version.ts";
import type { PipelineState, Stage, StageContext, Workflow } from "../src/types.ts";

function fakeSetupStage(specDir: string): Stage {
	return {
		id: "setup",
		label: "Setup",
		async run(state: PipelineState, _ctx: StageContext) {
			// Mirror the REAL setup contract: the stage's return value IS the
			// SetupControl, and task() writes it to state.setup — so the control must
			// carry specDirectory itself.
			const control = { worktreePath: specDir, specDirectory: specDir, defaultBranch: "main", language: "backend", isWebUi: false, specIdentifier: "01-test", worktreeCreated: false, initializedRepo: false };
			state.setup = control as never;
			return control as never;
		},
	};
}

describe("runWorkflow ledger wiring (P1.2)", () => {
	it("buffered events (run.started + setup.started) flush in order once the spec dir exists", async () => {
		const d = mkdtempSync(join(tmpdir(), "sd-p12b-"));
		try {
			const wf: Workflow = {
				id: "t",
				root: sequence([
					task(fakeSetupStage(d)),
					task({ id: "classify", label: "Classify", run: async () => ({ taskType: "bug" }) as never }),
				]),
			} as unknown as Workflow;
			await runWorkflow(wf, "task text", {});
			const events = readRunEvents(d);
			const types = events.map((e) => e.type);
			// Order: run.started, setup.started (buffered, flushed on setup terminal),
			// setup.completed, classify.started, classify.completed, run.completed.
			expect(types).toEqual([
				"run.started", "stage.started", "stage.completed",
				"stage.started", "stage.completed", "run.completed",
			]);
			expect(events[1].stage).toBe("setup");
			expect(events[3].stage).toBe("classify");
			// seq strictly increasing 1..N
			expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i + 1));
			// run.started carries version + ledger version; every event shares the runId
			expect(events[0].data.version).toBe(SUPER_DEV_EXTENSION_VERSION);
			expect(events[0].data.ledgerVersion).toBe(RUN_LOG_VERSION);
			const runId = events[0].runId;
			expect(events.every((e) => e.runId === runId)).toBe(true);
			// run.completed carries the honest status
			expect(events[events.length - 1].data.status).toBeTruthy();
			// the runId is also on the state for downstream consumers
		} finally { rmSync(d, { recursive: true, force: true }); }
	});

	it("records stage.failed with the error and run.completed with status=failed", async () => {
		const d = mkdtempSync(join(tmpdir(), "sd-p12c-"));
		try {
			const boom: Stage = { id: "boom", label: "Boom", run: async () => { throw new Error("kaboom"); } };
			const wf: Workflow = { id: "t", root: sequence([task(fakeSetupStage(d)), task(boom)]) } as unknown as Workflow;
			const summary = await runWorkflow(wf, "t", {});
			expect(summary.failedStages.length).toBe(1);
			const events = readRunEvents(d);
			const failed = events.find((e) => e.type === "stage.failed");
			expect(failed?.stage).toBe("boom");
			expect(String(failed?.data.error)).toContain("kaboom");
			const completed = events[events.length - 1];
			expect(completed.type).toBe("run.completed");
			expect(completed.data.status).toBe(summary.status);
		} finally { rmSync(d, { recursive: true, force: true }); }
	});

	it("records stage.skipped for --skipStages tasks", async () => {
		const d = mkdtempSync(join(tmpdir(), "sd-p12d-"));
		try {
			const wf: Workflow = {
				id: "t",
				root: sequence([
					task(fakeSetupStage(d)),
					task({ id: "classify", label: "Classify", run: async () => ({}) as never }),
				]),
			} as unknown as Workflow;
			await runWorkflow(wf, "t", { skipStages: ["classify"] });
			const events = readRunEvents(d);
			const skipped = events.find((e) => e.type === "stage.skipped");
			expect(skipped?.stage).toBe("classify");
		} finally { rmSync(d, { recursive: true, force: true }); }
	});

	it("writes nothing when no spec dir is ever created (no phantom files)", async () => {
		const wf: Workflow = {
			id: "t",
			root: task({ id: "x", label: "X", run: async () => ({}) as never }),
		} as unknown as Workflow;
		await runWorkflow(wf, "t", {});
		// No assertions on disk: the invariant is simply that nothing throws and no
		// file was created anywhere observable (buffered events are dropped).
		expect(existsSync(join(process.cwd(), "events.jsonl"))).toBe(false);
	});
});

describe("P1.6: replay proof — fold(events) reconstructs the stage outcomes", () => {
	it("a run's event stream fully determines every stage's terminal outcome (ok / failed / skipped)", async () => {
		const d = mkdtempSync(join(tmpdir(), "sd-p16-"));
		try {
			const boom: Stage = { id: "boom", label: "Boom", run: async () => { throw new Error("kaboom"); } };
			const wf: Workflow = {
				id: "t",
				root: sequence([
					task(fakeSetupStage(d)),
					task({ id: "classify", label: "Classify", run: async () => ({ taskType: "bug" }) as never }),
					task({ id: "research", label: "Research", run: async () => ({}) as never }),
					task(boom),
				]),
			} as unknown as Workflow;
			const summary = await runWorkflow(wf, "t", { skipStages: ["research"] });
			const events = readRunEvents(d);
			const outcomes = reconstructStageOutcomes(events);
			const byStage = Object.fromEntries(outcomes.map((o) => [o.stage, o]));
			expect(byStage.setup.status).toBe("completed");
			expect(byStage.classify.status).toBe("completed");
			expect(byStage.research.status).toBe("skipped");
			expect(byStage.boom.status).toBe("failed");
			expect(byStage.boom.error).toContain("kaboom");
			// cross-check against the summary the pipeline itself computed
			const failedIds = summary.failedStages.map((f) => f.label);
			expect(failedIds.some((l) => l.includes("Boom"))).toBe(true);
			// determinism: same events fold to the same outcomes
			expect(reconstructStageOutcomes(events)).toEqual(outcomes);
		} finally { rmSync(d, { recursive: true, force: true }); }
	});
});
