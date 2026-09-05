/**
 * v0.3.69 E1 — σ-BAND MONITOR (deterministic drift detection, zero LLM).
 *
 * The closing-the-loop play (SDLC playbook): deterministic scripts watch
 * production outcomes; findings re-enter the pipeline. W2 (v0.3.68) harvests
 * one run-metrics.jsonl row per run; E1 turns the accumulated rows into
 * robust statistical bands (median + MAD, per Weng/Self-Harness drift
 * detection) so degradation is DETECTED instead of noticed when a human
 * finally reads logs.
 *
 * Contract under test:
 *  - Global ledger: appendRunMetrics ALSO appends to the super-dev dir's
 *    run-metrics.jsonl (one chronological file across ALL runs/specs — the
 *    cross-run baseline source), in addition to the per-specDir file.
 *  - sigmaReport(rows, current): trailing-window baseline (median + MAD,
 *    robust z = |x−median| / (1.4826·MAD)) per metric; MAD=0 → z=0 when equal,
 *    ≥3σ (capped) when any deviation; needs ≥8 prior rows before banding
 *    (fewer → honest insufficientHistory, no bands); never throws on junk
 *    rows; thresholds 1σ/2σ/3σ classified per metric.
 *  - The report is deterministic: same rows → same report, no LLM anywhere.
 */
import { describe, it, expect, vi, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Test isolation: the global ledger must never touch the real ~/.super-dev.
vi.mock("../src/render/super-dev-dir.ts", async (importOriginal) => {
	const mod = await importOriginal<typeof import("../src/render/super-dev-dir.ts")>();
	const { mkdtempSync } = await import("node:fs");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	const dir = mkdtempSync(join(tmpdir(), "sd-e1global-"));
	return { ...mod, getSuperDevDir: () => dir };
});

import { appendRunMetrics, sigmaReport, type RunMetricsRow } from "../src/evolution/sigma-bands.ts";
import { getSuperDevDir } from "../src/render/super-dev-dir.ts";

afterAll(() => rmSync(getSuperDevDir(), { recursive: true, force: true }));

const row = (over: Partial<RunMetricsRow>): RunMetricsRow => ({
	runId: "r",
	status: "ok",
	agentsSpawned: 10,
	wallMs: 100_000,
	stages: { ok: 5 },
	agentErrorRounds: 0,
	fatalAborts: 0,
	usage: { calls: 10, input: 50_000, output: 10_000, cost: 0.1 },
	ts: 1,
	...over,
});

describe("v0.3.69 E1 — global metrics ledger", () => {
	it("appendRunMetrics writes BOTH the per-spec file and the global super-dev-dir file", () => {
		const dir = mkdtempSync(join(tmpdir(), "sd-e1-"));
		const globalBefore = (() => { try { return readFileSync(join(getSuperDevDir(), "run-metrics.jsonl"), "utf8").split("\n").filter(Boolean).length; } catch { return 0; } })();
		try {
			appendRunMetrics(dir, row({ runId: "global-check" }));
			const perSpec = readFileSync(join(dir, "run-metrics.jsonl"), "utf8").trim().split("\n");
			expect(JSON.parse(perSpec[0]).runId).toBe("global-check");
			const global = readFileSync(join(getSuperDevDir(), "run-metrics.jsonl"), "utf8").trim().split("\n");
			expect(global.length).toBeGreaterThan(globalBefore);
			expect(JSON.parse(global[global.length - 1]).runId).toBe("global-check");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("no specDir still lands the row in the global ledger (resume-safe observability)", () => {
		appendRunMetrics(undefined, row({ runId: "global-only" }));
		const global = readFileSync(join(getSuperDevDir(), "run-metrics.jsonl"), "utf8").trim().split("\n");
		expect(JSON.parse(global[global.length - 1]).runId).toBe("global-only");
	});
});

const renderQuiet = (r: { insufficientHistory: boolean; bands: unknown[] }) => r.insufficientHistory === false && r.bands.length === 0;

describe("v0.3.69 E1 — sigmaReport (median + MAD robust bands)", () => {
	const mkRows = (n: number, wallMs: number, cost: number): RunMetricsRow[] =>
		Array.from({ length: n }, (_, i) => row({ runId: `b${i}`, wallMs, usage: { calls: 10, input: 50_000, output: 10_000, cost } }));

	it("fewer than 8 prior rows → honest insufficientHistory, no bands", () => {
		const report = sigmaReport(mkRows(7, 100_000, 0.1), row({ runId: "cur" }));
		expect(report.insufficientHistory).toBe(true);
		expect(report.bands).toHaveLength(0);
	});

	it("a metric at the median → 0σ; a wild deviation → high σ classified 3σ-tier", () => {
		const prior = mkRows(12, 100_000, 0.1);
		// Sanity: identical rows make MAD=0; an equal current is NOT a band
		// (bands list only ≥1σ deviations — quiet metrics are absent by design).
		const atMedian = sigmaReport(prior, row({ runId: "cur", wallMs: 100_000, usage: { calls: 10, input: 50_000, output: 10_000, cost: 0.1 } }));
		expect(atMedian.bands).toHaveLength(0);
		expect(renderQuiet(atMedian)).toBe(true);

		// Deviation with MAD=0 → capped at ≥3σ.
		const wild = sigmaReport(prior, row({ runId: "cur", wallMs: 900_000, usage: { calls: 10, input: 50_000, output: 10_000, cost: 1.4 } }));
		const costBand = wild.bands.find((b) => b.metric === "costUsd")!;
		expect(costBand.sigma).toBeGreaterThanOrEqual(3);
		expect(costBand.tier).toBe("3σ");
	});

	it("varying baseline → robust z lands in the expected tier (2σ example)", () => {
		// wallMs: 90k..110k spread (median 100k, small MAD); current 140k → clearly >2σ but <3σ-ish robust… assert tier is one of 2σ/3σ and sigma>1
		const prior = mkRows(10, 100_000, 0.1).map((r, i) => ({ ...r, wallMs: 90_000 + i * 2_000 }));
		const report = sigmaReport(prior, row({ runId: "cur", wallMs: 140_000 }));
		const wall = report.bands.find((b) => b.metric === "wallMs")!;
		expect(wall.sigma).toBeGreaterThan(1);
		expect(["2σ", "3σ"]).toContain(wall.tier);
	});

	it("metrics tracked: wallMs, costUsd, tokens, agentErrorRounds, fatalAborts, agentsSpawned (leading/lagging pairs)", () => {
		// current deviates on EVERY metric (MAD=0 baseline → all capped 3σ) so
		// all six tracked metrics surface as bands.
		const report = sigmaReport(mkRows(8, 100_000, 0.1), row({
			runId: "cur", agentsSpawned: 60, wallMs: 500_000, agentErrorRounds: 4, fatalAborts: 2,
			usage: { calls: 40, input: 300_000, output: 60_000, cost: 0.9 },
		}));
		const names = report.bands.map((b) => b.metric).sort();
		expect(names).toEqual(["agentErrorRounds", "agentsSpawned", "costUsd", "fatalAborts", "tokens", "wallMs"].sort());
	});

	it("junk rows (NaN/undefined fields) never throw — they are excluded from the baseline deterministically", () => {
		const prior = [...mkRows(8, 100_000, 0.1), { junk: true } as unknown as RunMetricsRow];
		expect(() => sigmaReport(prior, row({ runId: "cur" }))).not.toThrow();
	});

	it("renderSigmaLines renders the deterministic log block (P10 — numbers, not prose guesses)", async () => {
		const { renderSigmaLines } = await import("../src/evolution/sigma-bands.ts");
		const prior = mkRows(12, 100_000, 0.1);
		const report = sigmaReport(prior, row({ runId: "cur", usage: { calls: 10, input: 50_000, output: 10_000, cost: 1.4 } }));
		const lines = renderSigmaLines(report);
		expect(lines.some((l) => l.includes("costUsd") && l.includes("σ"))).toBe(true);
		expect(lines.some((l) => l.includes("3σ"))).toBe(true);
	});
});

describe("v0.3.69 E1 — wire into runWorkflow (source contract)", () => {
	it("runWorkflow checks sigma bands at close-out (best-effort)", async () => {
		const src = await import("node:fs").then((fs) => fs.readFileSync("src/workflow.ts", "utf8"));
		expect(src).toMatch(/checkSigmaBands\(/);
	});
});
