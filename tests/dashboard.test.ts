/**
 * Unit tests for the workflow dashboard v1 (Gap Dashboard):
 *  - task() emits structured `stage` events (running → terminal)
 *  - formatDashboardLines renders the phase-tracker widget content
 */

import { describe, it, expect } from "vitest";
import { EventEmitter } from "node:events";
import { task } from "../src/nodes.ts";
import { formatDashboardLines, truncateActivity } from "../src/extension.ts";
import type { NodeResult, PipelineState, Stage, StageContext } from "../src/types.ts";

function fakeCtx(): { ctx: StageContext; events: EventEmitter } {
	const events = new EventEmitter();
	const budget = { count: 0, max: 100, check: () => true, spent() { this.count++; } };
	const ctx = {
		task: "t", options: {}, state: {} as PipelineState,
		events,
		budget,
		log: () => {},
		results: [] as StageContext["results"],
		agent: async () => ({ control: {} }),
		helper: async () => ({ value: {}, digest: "" }),
		parallel: async (calls: Array<() => Promise<unknown>>) => Promise.all(calls.map((c) => c())),
	} as unknown as StageContext;
	return { ctx, events };
}

describe("task() emits stage events", () => {
	it("emits running on enter and ok on success", async () => {
		const stage: Stage = { id: "s1", label: "Stage 1 — Setup", async run() { return { ok: true }; } };
		const { ctx, events } = fakeCtx();
		const seen: Array<{ status: string }> = [];
		events.on("stage", (info) => seen.push(info));
		await task(stage).run({} as PipelineState, ctx);
		expect(seen.map((s) => s.status)).toEqual(["running", "ok"]);
	});

	it("emits failed on throw (non-fatal stage)", async () => {
		const stage: Stage = { id: "s2", label: "Boom", async run() { throw new Error("nope"); } };
		const { ctx, events } = fakeCtx();
		const seen: string[] = [];
		events.on("stage", (info: { status: string }) => seen.push(info.status));
		const r = await task(stage).run({} as PipelineState, ctx) as NodeResult;
		expect(r.status).toBe("failed");
		expect(seen).toEqual(["running", "failed"]);
	});

	it("emits skipped when disabled", async () => {
		const stage: Stage = { id: "s3", label: "Skipped", enabled: () => false, async run() { return {}; } };
		const { ctx, events } = fakeCtx();
		const seen: string[] = [];
		events.on("stage", (info: { status: string }) => seen.push(info.status));
		await task(stage).run({} as PipelineState, ctx);
		// disabled short-circuits before the "phase"/"running" emit
		expect(seen).toEqual(["skipped"]);
	});
});

describe("formatDashboardLines", () => {
	it("header carries done/total + the running stage; detail is current-first", () => {
		const lines = formatDashboardLines([
			{ id: "1", label: "Stage 1 — Setup", status: "ok" },
			{ id: "2", label: "Stage 2 — Requirements", status: "ok" },
			{ id: "3", label: "Stage 5 — Code Assessment", status: "running" },
			{ id: "4", label: "Stage X — Debug", status: "skipped" },
			{ id: "5", label: "Stage Y — Review", status: "failed" },
		]);
		// header includes the running stage + esc hint
		expect(lines[0]).toBe("super-dev · 4/5 · ● Stage 5 — Code Assessment  (esc to abort)");
		// detail is current-first (running first), then the rest reversed
		expect(lines).toContain("  ● Stage 5 — Code Assessment");
		expect(lines).toContain("  ⚠ Stage Y — Review");
		expect(lines).toContain("  ↷ Stage X — Debug");
		expect(lines).toContain("  ✔ Stage 2 — Requirements");
		expect(lines).toContain("  ✔ Stage 1 — Setup");
		// the running stage appears in the detail block (not truncated away)
		expect(lines.indexOf("  ● Stage 5 — Code Assessment")).toBeLessThan(lines.length);
	});

	it("counts only non-running stages as done", () => {
		const lines = formatDashboardLines([
			{ id: "1", label: "A", status: "running" },
			{ id: "2", label: "B", status: "running" },
		]);
		expect(lines[0]).toBe("super-dev · 0/2 · ● A  (esc to abort)");
	});

	it("header has no running segment when nothing is running", () => {
		expect(formatDashboardLines([])[0]).toBe("super-dev · 0/0  (esc to abort)");
	});

	it("collapses older stages into a summary (current + recent stay detailed)", () => {
		const many = Array.from({ length: 12 }, (_, i) => ({ id: String(i), label: `S${i}`, status: i < 10 ? "ok" : "running" }));
		const lines = formatDashboardLines(many);
		// the 6 oldest get summarized; the running stage (last) is in the detail block
		expect(lines.some((l) => /… \+6 earlier \(all ✔\)/.test(l))).toBe(true);
		expect(lines.some((l) => l.includes("● S11"))).toBe(true);
	});
});

describe("formatDashboardLines: live-activity row (v2)", () => {
	it("appends an activity row when activity is non-empty", () => {
		const lines = formatDashboardLines([{ id: "1", label: "Stage 1", status: "running" }], "writing src/auth.ts");
		expect(lines).toContain("▶ writing src/auth.ts");
	});

	it("omits the activity row when activity is blank", () => {
		const lines = formatDashboardLines([{ id: "1", label: "Stage 1", status: "ok" }], "   ");
		expect(lines.some((l) => l.startsWith("▶"))).toBe(false);
	});

	it("does not break when activity is undefined", () => {
		const lines = formatDashboardLines([{ id: "1", label: "Stage 1", status: "ok" }]);
		expect(lines).toHaveLength(2);
	});
});

describe("truncateActivity", () => {
	it("collapses whitespace and trims", () => {
		expect(truncateActivity("  foo\n  bar  ")).toBe("foo bar");
	});
	it("truncates with an ellipsis when over the limit", () => {
		const long = "x".repeat(150);
		const out = truncateActivity(long, 100);
		expect(out.length).toBeLessThanOrEqual(100);
		expect(out.endsWith("…")).toBe(true);
	});
	it("returns empty for blank input", () => {
		expect(truncateActivity("")).toBe("");
		expect(truncateActivity("   \n  ")).toBe("");
	});
});
