/**
 * Unit tests for stagnation escalation (Gap 4.6′-lite).
 * Covers: the __stagnated flag set by reviewLoopUntil, the always-on report write,
 * and the opt-in interactive select path (via the test-only escalation override).
 */

import { describe, it, expect } from "vitest";
import { mkdtempSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reviewLoopUntil } from "../src/stages/verify.ts";
import { handleStagnation } from "../src/extension.ts";
import type { PipelineState, RunSummary, StageContext } from "../src/types.ts";

const finding = (file: string, severity: string, title: string) => ({ id: "x", severity, title, detail: "d", file });

function stateWith(review: Record<string, unknown> | undefined, prior?: string[]): PipelineState {
	const s = { review } as unknown as PipelineState;
	if (prior) (s as Record<string, unknown>).__reviewSignatures = prior;
	return s;
}
const fakeCtx = (): StageContext => ({ log: () => {}, task: "", options: {}, state: {} as PipelineState } as unknown as StageContext);

function summaryWith(stagnated: unknown, specDirectory: string): RunSummary {
	const state = { __stagnated: stagnated } as unknown as PipelineState;
	return {
		workflowId: "x", specIdentifier: "x", worktreePath: specDirectory, specDirectory,
		agentsSpawned: 0, state, status: "partial", failedStages: [],
	} as RunSummary;
}

describe("reviewLoopUntil records __stagnated", () => {
	it("sets a structured stagnation record on the second identical round", async () => {
		const s1 = stateWith({ verdict: "Changes Requested", findings: [finding("a.ts", "high", "T")] });
		await reviewLoopUntil(s1, fakeCtx());
		const s2 = stateWith({ verdict: "Changes Requested", findings: [finding("a.ts", "high", "T")] }, (s1 as unknown as Record<string, unknown>).__reviewSignatures as string[]);
		await reviewLoopUntil(s2, fakeCtx());
		const st = (s2 as Record<string, unknown>).__stagnated as { rounds?: number; verdict?: string; findings?: unknown[] } | undefined;
		expect(st).toBeDefined();
		expect(st?.rounds).toBe(2);
		expect(st?.verdict).toBe("Changes Requested");
		expect(st?.findings?.length).toBe(1);
	});

	it("does NOT set __stagnated when findings change", async () => {
		const s1 = stateWith({ verdict: "Changes Requested", findings: [finding("a.ts", "high", "T")] });
		await reviewLoopUntil(s1, fakeCtx());
		const s2 = stateWith({ verdict: "Changes Requested", findings: [finding("b.ts", "low", "U")] }, (s1 as unknown as Record<string, unknown>).__reviewSignatures as string[]);
		await reviewLoopUntil(s2, fakeCtx());
		expect((s2 as Record<string, unknown>).__stagnated).toBeUndefined();
	});
});

describe("handleStagnation", () => {
	it("is a no-op when the run did not stagnate", async () => {
		const d = mkdtempSync(join(tmpdir(), "sd-esc-"));
		try {
			const r = await handleStagnation(summaryWith(undefined, d), { hasUI: true });
			expect(r).toBeUndefined();
			expect(existsSync(join(d, "stagnation-report.md"))).toBe(false);
		} finally { rmSync(d, { recursive: true, force: true }); }
	});

	it("writes a stagnation-report.md and returns undefined in headless mode (baseline)", async () => {
		const d = mkdtempSync(join(tmpdir(), "sd-esc-"));
		try {
			const r = await handleStagnation(summaryWith({ rounds: 3, verdict: "Changes Requested", findings: [finding("a.ts", "high", "T")] }, d), { hasUI: false });
			expect(r).toBeUndefined();
			const report = readFileSync(join(d, "stagnation-report.md"), "utf8");
			expect(report).toMatch(/review round/);
			expect(report).toContain("**3**");
			expect(report).toMatch(/a\.ts/);
		} finally { rmSync(d, { recursive: true, force: true }); }
	});

	it("prompts interactively and returns the user's choice when escalation=interactive + hasUI", async () => {
		const d = mkdtempSync(join(tmpdir(), "sd-esc-"));
		try {
			let called = false;
			const ctx = {
				hasUI: true,
				ui: {
					select: async (_title: string, options: string[]) => { called = true; return options[1]; /* Accept */ },
				},
			};
			const r = await handleStagnation(summaryWith({ rounds: 2, verdict: "Contested", findings: [] }, d), ctx, { escalation: "interactive" });
			expect(called).toBe(true);
			expect(r).toBe("Accept findings as known limitations");
			expect(existsSync(join(d, "stagnation-report.md"))).toBe(true); // baseline still writes
		} finally { rmSync(d, { recursive: true, force: true }); }
	});

	it("does not prompt in interactive mode when headless (hasUI false)", async () => {
		const d = mkdtempSync(join(tmpdir(), "sd-esc-"));
		try {
			let called = false;
			const ctx = { hasUI: false, ui: { select: async () => { called = true; return "x"; } } };
			const r = await handleStagnation(summaryWith({ rounds: 2 }, d), ctx, { escalation: "interactive" });
			expect(called).toBe(false);
			expect(r).toBeUndefined();
		} finally { rmSync(d, { recursive: true, force: true }); }
	});
});
