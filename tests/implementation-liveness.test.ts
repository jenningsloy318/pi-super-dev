/**
 * v0.3.57 — implementation-stage liveness probes (silent-zombie incident,
 * ledger 2026-09-01): a worktree removed EXTERNALLY mid-run must fail the
 * stage/attempt CLOSED with an honest marker — never delegate children into a
 * void that then hangs awaiting responses that can never arrive.
 */
import { describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { implementationStage } from "../src/stages/implementation.ts";
import type { PipelineState, StageContext } from "../src/types.ts";

function mkCtx() {
	const logs: string[] = [];
	const ctx = {
		log: (line: string) => logs.push(line),
		agent: vi.fn(async () => { throw new Error("probe test: no agent call expected"); }),
		options: { resume: false },
	} as unknown as { log: (l: string) => string[]; agent: ReturnType<typeof vi.fn> } & StageContext;
	return { ctx: ctx as StageContext, logs };
}

function mkState(worktreePath: string, worktreeCreated: boolean): PipelineState {
	return {
		setup: { worktreePath, specDirectory: join(worktreePath, "docs", "specifications"), defaultBranch: "main", language: "frontend", isWebUi: false, specIdentifier: "liveness", worktreeCreated, initializedRepo: false },
		classify: { taskType: "feature", uiScope: "none", language: "frontend", isWebUi: false },
		spec: { phases: [{ name: "P", description: "d" }] },
	} as PipelineState;
}

describe("v0.3.57 liveness — worktree-existence probes fail the stage closed", () => {
	it("stage entry: dedicated worktree removed externally → honest WORKTREE GONE marker, zero agent calls, fail-closed control", async () => {
		const { ctx, logs } = mkCtx();
		const gone = join(tmpdir(), `sd-liveness-gone-${Date.now()}`); // deliberately does not exist
		const control = await (implementationStage as { run: (s: PipelineState, c: StageContext) => Promise<unknown> }).run(mkState(gone, true), ctx);
		expect(control).toMatchObject({ phasesCompleted: 0, totalPhases: 1, allGreen: false });
		expect(logs.some((l) => l.includes("WORKTREE GONE") && l.includes(gone))).toBe(true);
		expect(ctx.agent).not.toHaveBeenCalled();
	});

	it("in-place runs (worktreeCreated: false) are exempt — the user's checkout is not probed", async () => {
		const { ctx, logs } = mkCtx();
		const gone = join(tmpdir(), `sd-liveness-alsogone-${Date.now()}`);
		// The probe sits at stage entry BEFORE any other machinery; the stage may
		// then throw on the minimal fake ctx (full-stage behavior is covered by
		// the pipelining/red-loop suites) — the assertion is the probe's silence.
		try {
			await (implementationStage as { run: (s: PipelineState, c: StageContext) => Promise<unknown> }).run(mkState(gone, false), ctx);
		} catch { /* past the probe — subject not under test here */ }
		expect(logs.some((l) => l.includes("WORKTREE GONE"))).toBe(false);
	});

	it("a REAL existing worktree passes the probe (no false positive)", async () => {
		const { ctx, logs } = mkCtx();
		const real = mkdtempSync(join(tmpdir(), "sd-liveness-real-"));
		try {
			await (implementationStage as { run: (s: PipelineState, c: StageContext) => Promise<unknown> }).run(mkState(real, true), ctx);
		} catch { /* past the probe — subject not under test here */ }
		expect(logs.some((l) => l.includes("WORKTREE GONE"))).toBe(false);
	});
});
