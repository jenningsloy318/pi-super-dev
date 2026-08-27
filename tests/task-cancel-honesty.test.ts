/**
 * task() cancellation honesty (run 2026-08-27T13-12-39-803Z).
 *
 * classifyStage caught an agent aborted by the parent signal and returned the
 * deterministic fallback — the task() wrapper recorded `status=ok` with a
 * perfectly healthy-looking FABRICATED control for a cancelled run. A stage
 * that returns or throws after the run signal aborted must record `cancelled`,
 * never write its value into state, and propagate cancellation.
 */
import { describe, it, expect } from "vitest";
import { task } from "../src/nodes.ts";
import type { PipelineState, Stage, StageContext } from "../src/types.ts";

function makeCtx(signal?: AbortSignal): { ctx: StageContext; rows: Array<{ id: string; status: string; error?: string }> } {
	const rows: Array<{ id: string; status: string; error?: string }> = [];
	const ctx = {
		task: "test",
		options: {},
		log: () => {},
		events: { on() {}, off() {}, emit(ev: string, info: { id: string; status: string }) { if (ev === "stage") rows.push({ id: info.id, status: info.status }); } },
		results: rows,
		signal,
		budget: { check: () => true, spent: () => true, count: 0 },
		skipStages: [],
	} as unknown as StageContext;
	return { ctx, rows };
}

const state = () => ({}) as PipelineState;

describe("task() — cancellation honesty", () => {
	it("a stage RETURNING after signal abort records cancelled and discards the value", async () => {
		const controller = new AbortController();
		const stage: Stage = { id: "classify", label: "Classify", run: async () => { controller.abort(); return { taskType: "bug", uiScope: "none" }; } };
		const { ctx } = makeCtx(controller.signal);
		const s = state();
		const r = await task(stage).run(s as PipelineState, ctx);
		expect(r.status).toBe("cancelled");
		expect((s as Record<string, unknown>).classify).toBeUndefined(); // fabricated value NOT stored
		expect(ctx.results.some((row) => row.id === "classify" && row.status === "cancelled")).toBe(true);
	});

	it("a stage THROWING after signal abort records cancelled, not failed", async () => {
		const controller = new AbortController();
		const stage: Stage = { id: "classify", label: "Classify", run: async () => { controller.abort(); throw new Error("session aborted by parent signal"); } };
		const { ctx } = makeCtx(controller.signal);
		const r = await task(stage).run(state(), ctx);
		expect(r.status).toBe("cancelled");
		expect(ctx.results.some((row) => row.id === "classify" && row.status === "cancelled")).toBe(true);
	});

	it("an ordinary (non-abort) stage still records ok and stores its value", async () => {
		const stage: Stage = { id: "classify", label: "Classify", run: async () => ({ taskType: "feature" }) };
		const { ctx } = makeCtx();
		const s = state();
		const r = await task(stage).run(s as PipelineState, ctx);
		expect(r.status).toBe("ok");
		expect((s as Record<string, unknown>).classify).toEqual({ taskType: "feature" });
	});
});
