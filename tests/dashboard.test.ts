/**
 * Unit tests for the workflow dashboard v1 (Gap Dashboard):
 *  - task() emits structured `stage` events (running → terminal)
 *  - formatDashboardLines renders the phase-tracker widget content
 */

import { describe, it, expect } from "vitest";
import { EventEmitter } from "node:events";
import { task } from "../src/nodes.ts";
import { packDashboardLines, truncateActivity } from "../src/extension.ts";
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

describe("packDashboardLines", () => {
	const stages = (n: number, runningIdx = -1) => Array.from({ length: n }, (_, i) => ({ id: String(i), label: `Stage ${i + 1} — ${i === runningIdx ? "Live" : "Done ${i}"}`, status: i === runningIdx ? "running" : "ok" }));

	it("shows EVERY stage — none summarized or dropped (13 stages on width 80)", () => {
		const lines = packDashboardLines(stages(13), undefined, 80);
		// all 13 stage labels appear somewhere in the output
		for (let i = 0; i < 13; i++) expect(lines.some((l) => l.includes(`Stage ${i + 1} —`))).toBe(true);
		// no summary line
		expect(lines.some((l) => /… \+\d+ earlier/.test(l))).toBe(false);
	});

	it("header carries done/total + running stage + esc hint", () => {
		const lines = packDashboardLines(stages(5, 2), undefined, 80);
		expect(lines[0]).toBe("super-dev · 4/5 · ● Stage 3 — Live  (esc to abort)");
	});

	it("packs into 2 columns always (column-first: first half left, second half right)", () => {
		const w80 = packDashboardLines(stages(6), undefined, 80);
		const rows = w80.filter((x) => x.startsWith("  "));
		expect(rows.length).toBe(3); // ceil(6/2) = 3 rows
		for (let i = 0; i < 6; i++) expect(w80.some((l) => l.includes(`Stage ${i + 1} —`))).toBe(true);
	});

	it("includes the activity row when activity is non-empty", () => {
		const lines = packDashboardLines(stages(2), "writing src/auth.ts", 80);
		expect(lines.some((l) => l.startsWith("▶ writing"))).toBe(true);
	});

	it("omits the activity row when blank", () => {
		const lines = packDashboardLines(stages(2), "   ", 80);
		expect(lines.some((l) => l.startsWith("▶"))).toBe(false);
	});

	it("shows all stages even with odd count (column-first)", () => {
		const lines = packDashboardLines(stages(3), undefined, 40);
		// 3 stages: half=2, rows=2. Left: stages 1,2. Right: stage 3.
		expect(lines.filter((x) => x.startsWith("  ")).length).toBe(2);
		for (let i = 0; i < 3; i++) expect(lines.some((l) => l.includes(`Stage ${i + 1} —`))).toBe(true);
	});

	it("header stays byte-identical when no elapsed clock is supplied", () => {
		const lines = packDashboardLines(stages(5, 2), undefined, 80);
		expect(lines[0]).toBe("super-dev · 4/5 · ● Stage 3 — Live  (esc to abort)");
	});

	it("header shows a ticking elapsed clock when elapsedMs is supplied", () => {
		const lines = packDashboardLines(stages(5, 2), undefined, 80, undefined, 0, "esc to abort", { elapsedMs: 134_000 });
		// 134s → 2m14s, inserted after the done/total count
		expect(lines[0]).toBe("super-dev · 4/5 · 2m14s · ● Stage 3 — Live  (esc to abort)");
	});

	it("formats sub-minute, minute, and hour elapsed spans", () => {
		const at = (ms: number) => packDashboardLines(stages(1), undefined, 80, undefined, 0, "esc to abort", { elapsedMs: ms })[0];
		expect(at(45_000)).toContain("· 45s");
		expect(at(125_000)).toContain("· 2m05s");
		expect(at(3_780_000)).toContain("· 1h03m");
	});

	it("renders a dimmed recent-activity tail when recentLogs are supplied (background mode)", () => {
		const logs = ["Implementation phase-01 red-oracle: red", "Implementation phase-01 build-gate PASS"];
		const lines = packDashboardLines(stages(5, 2), undefined, 80, undefined, 0, "/super-dev-stop", { recentLogs: logs });
		expect(lines.some((l) => l.includes("── recent ──"))).toBe(true);
		expect(lines.some((l) => l.includes("red-oracle: red"))).toBe(true);
		expect(lines.some((l) => l.includes("build-gate PASS"))).toBe(true);
	});

	it("caps the recent tail at 8 lines (most-recent kept)", () => {
		const logs = Array.from({ length: 20 }, (_, i) => `log line ${i + 1}`);
		const lines = packDashboardLines(stages(2), undefined, 120, undefined, 0, "/super-dev-stop", { recentLogs: logs });
		const shown = lines.filter((l) => /log line \d+/.test(l));
		expect(shown.length).toBe(8);
		expect(lines.some((l) => l.includes("log line 20"))).toBe(true); // newest kept
		expect(lines.some((l) => l.includes("log line 12"))).toBe(false); // oldest trimmed
	});

	it("omits the recent tail entirely when no recentLogs (foreground mode)", () => {
		const lines = packDashboardLines(stages(2), "writing x", 80);
		expect(lines.some((l) => l.includes("── recent ──"))).toBe(false);
	});
});

describe("formatDashboardLines: live-activity row (v2)", () => {
	it("placeholder — activity tested in packDashboardLines", () => {
		expect(true).toBe(true);
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
