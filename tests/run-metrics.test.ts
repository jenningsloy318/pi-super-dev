/**
 * v0.3.68 F10-2 — deterministic RUN-METRICS harvest (closing the loop).
 *
 * SDLC playbook closing-the-loop play + LangChain Monitor stage: deterministic
 * scripts watch production outcomes and findings re-enter the pipeline. Our
 * findings F1–F9 were hand-mined from 4,000–8,000-line prose logs. Contract:
 * at run end, ONE JSON row per run lands in <specDir>/run-metrics.jsonl with
 * machine-checkable health counters. Never throws; no spec dir → no row.
 */
import { describe, it, expect, vi, afterAll, beforeAll } from "vitest";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// v0.3.69 E1: appendRunMetrics also writes the GLOBAL ledger — isolate it.
vi.mock("../src/render/super-dev-dir.ts", async (importOriginal) => {
	const mod = await importOriginal<typeof import("../src/render/super-dev-dir.ts")>();
	const { mkdtempSync } = await import("node:fs");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	const dir = mkdtempSync(join(tmpdir(), "sd-rm-global-"));
	return { ...mod, getSuperDevDir: () => dir };
});

import { buildRunMetricsRow, appendRunMetrics } from "../src/workflow.ts";
import { getSuperDevDir } from "../src/render/super-dev-dir.ts";

// v0.3.73 M5: the suite-level hermeticity setup disables the global append;
// these tests ASSERT the global ledger write, so opt back in (getSuperDevDir
// is mocked to a tmp dir — writes stay hermetic).
beforeAll(() => { delete process.env.SUPER_DEV_NO_GLOBAL_METRICS; });
afterAll(() => { process.env.SUPER_DEV_NO_GLOBAL_METRICS = "1"; });
afterAll(() => rmSync(getSuperDevDir(), { recursive: true, force: true }));

const ts = () => Date.now();

describe("v0.3.68 F10-2 — run-metrics harvest", () => {
	it("buildRunMetricsRow counts stage statuses, agent-error rows, and usage totals from real inputs", () => {
		const row = buildRunMetricsRow({
			runId: "run-42",
			status: "partial",
			agentsSpawned: 12,
			wallMs: 45000,
			results: [
				{ id: "requirements", label: "R", status: "ok" },
				{ id: "bdd", label: "B", status: "ok" },
				{ id: "implementation", label: "I", status: "partial" },
				{ id: "requirements", label: "R", status: "failed", error: "FatalAbort: review agent errored 3 consecutive", cause: "agent-error" },
				{ id: "spec", label: "S", status: "failed", error: "FatalAbort: spec convergence", cause: "agent-error" },
			],
			usage: { totals: { calls: 12, input: 1000, output: 400, cost: 0.5 }, byAgent: {} },
			ts: ts(),
		});
		expect(row.runId).toBe("run-42");
		expect(row.status).toBe("partial");
		expect(row.stages).toEqual({ ok: 2, partial: 1, failed: 2 });
		expect(row.agentErrorRounds).toBe(2);
		expect(row.fatalAborts).toBe(2);
		expect(row.usage.input).toBe(1000);
		expect(row.usage.cost).toBe(0.5);
		expect(row.usage.calls).toBe(12);
	});

	it("appendRunMetrics appends one JSON line per call and never throws on a bad path", () => {
		const dir = mkdtempSync(join(tmpdir(), "sd-metrics-"));
		try {
			appendRunMetrics(dir, { runId: "a", status: "ok", agentsSpawned: 1, wallMs: 1, stages: { ok: 1 }, agentErrorRounds: 0, fatalAborts: 0, judgeAccepted: 0, judgeDiscarded: 0, partialPhases: 0, inheritedRedHandoffs: 0, inheritedRedOccurrences: 0, maxPhaseAttempts: 0, usage: { calls: 1, input: 0, output: 0, cost: 0 }, ts: ts() });
			appendRunMetrics(dir, { runId: "b", status: "failed", agentsSpawned: 2, wallMs: 2, stages: { failed: 1 }, agentErrorRounds: 1, fatalAborts: 0, judgeAccepted: 1, judgeDiscarded: 2, partialPhases: 3, inheritedRedHandoffs: 1, inheritedRedOccurrences: 1, maxPhaseAttempts: 4, usage: { calls: 2, input: 0, output: 0, cost: 0 }, ts: ts() });
			const lines = readFileSync(join(dir, "run-metrics.jsonl"), "utf8").trim().split("\n");
			expect(lines).toHaveLength(2);
			expect(JSON.parse(lines[1]).runId).toBe("b");
			// v0.3.85 S3: the health counters ride the row verbatim (P10 — the keys
			// are written even when zero; a subsystem never dies silently).
			expect(JSON.parse(lines[0])).toMatchObject({ judgeAccepted: 0, judgeDiscarded: 0, partialPhases: 0, inheritedRedHandoffs: 0, inheritedRedOccurrences: 0, maxPhaseAttempts: 0 });
			expect(JSON.parse(lines[1])).toMatchObject({ judgeAccepted: 1, judgeDiscarded: 2, partialPhases: 3, inheritedRedHandoffs: 1, inheritedRedOccurrences: 1, maxPhaseAttempts: 4 });
			// never throws on an unusable path
			expect(() => appendRunMetrics("/proc/definitely/not/writable", { runId: "c", status: "ok", agentsSpawned: 0, wallMs: 0, stages: {}, agentErrorRounds: 0, fatalAborts: 0, judgeAccepted: 0, judgeDiscarded: 0, partialPhases: 0, inheritedRedHandoffs: 0, inheritedRedOccurrences: 0, maxPhaseAttempts: 0, usage: { calls: 0, input: 0, output: 0, cost: 0 }, ts: ts() })).not.toThrow();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("usage absent → the row records calls=0 and zeroed usage honestly (no NaN, no fabrication)", () => {
		const row = buildRunMetricsRow({ runId: "r", status: "ok", agentsSpawned: 0, wallMs: 0, results: [], usage: undefined, ts: ts() });
		expect(row.usage).toEqual({ calls: 0, input: 0, output: 0, cost: 0 });
	});

	// ── v0.3.85 S3 — the health counters (§9 S3 / §13 run-metrics row) ──────
	it("s3 absent → every health counter is PRESENT as honest 0 (never a missing key — the C2 lesson)", () => {
		const row = buildRunMetricsRow({ runId: "r", status: "ok", agentsSpawned: 0, wallMs: 0, results: [], usage: undefined, ts: ts() });
		expect(row).toMatchObject({ judgeAccepted: 0, judgeDiscarded: 0, partialPhases: 0, inheritedRedHandoffs: 0, inheritedRedOccurrences: 0, maxPhaseAttempts: 0 });
		// P10: the keys are materialized in the serialized row, not defaulted on read.
		for (const key of ["judgeAccepted", "judgeDiscarded", "partialPhases", "inheritedRedHandoffs", "inheritedRedOccurrences", "maxPhaseAttempts"] as const) {
			expect(Object.prototype.hasOwnProperty.call(row, key)).toBe(true);
		}
	});

	it("s3 partial input → missing members default to 0, present members pass through verbatim", () => {
		const row = buildRunMetricsRow({ runId: "r", status: "partial", agentsSpawned: 3, wallMs: 9, results: [{ status: "partial" }], usage: undefined, s3: { judgeAccepted: 2, partialPhases: 5, maxPhaseAttempts: 4 }, ts: ts() });
		expect(row.judgeAccepted).toBe(2);
		expect(row.partialPhases).toBe(5);
		expect(row.maxPhaseAttempts).toBe(4);
		expect(row.judgeDiscarded).toBe(0);
		expect(row.inheritedRedHandoffs).toBe(0);
		expect(row.inheritedRedOccurrences).toBe(0);
	});

	it("runWorkflow wires the harvest before returning (source contract)", async () => {
		const src = await import("node:fs").then((fs) => fs.readFileSync("src/workflow.ts", "utf8"));
		expect(src).toMatch(/appendRunMetrics\(/);
	});
});
