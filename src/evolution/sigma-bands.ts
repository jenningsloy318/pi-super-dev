/**
 * v0.3.69 E1 — σ-band drift monitor + the run-metrics ledger (W2 v0.3.68
 * helpers moved here; workflow.ts re-exports for compatibility).
 *
 * Design (plan §9, W5): deterministic, zero-LLM. Every run appends one JSON
 * row to (a) the per-specDir file (W2) and (b) the GLOBAL
 * <super-dev-dir>/run-metrics.jsonl (E1 — one chronological file across all
 * runs and specs, the cross-run baseline source). At close-out the trailing
 * baseline (median + MAD, robust z = |x−median| / (1.4826·MAD)) classifies
 * the current run per metric:
 *
 *   ≥1σ → logged            (worth seeing)
 *   ≥2σ → post-mortem flag  (E2 recommended; auto when postMortem="auto")
 *   ≥3σ → intent drafting   (surface to the operator — the run is an outlier)
 *
 * Honesty rules (P10): <8 prior rows → NO bands (insufficientHistory — never
 * fabricate confidence); MAD=0 → equal value is exactly 0σ, any deviation is
 * capped 3σ (all-identical history makes any change maximally surprising);
 * junk rows (NaN/missing fields) are excluded per-metric, deterministically;
 * nothing here ever throws (best-effort observability, P5).
 */
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { UsageAccumulator } from "../types.ts";
import { getSuperDevDir } from "../render/super-dev-dir.ts";

// ── W2 v0.3.68 (moved verbatim from workflow.ts) ────────────────────────────

/** v0.3.68 F10-2: one deterministic JSON row per run — the closing-the-loop
 * harvest (SDLC playbook): trend watching and σ-bands become jq over the file
 * instead of hand-mining 4k-line prose logs. */
export interface RunMetricsRow {
	runId: string;
	status: string;
	agentsSpawned: number;
	wallMs: number;
	stages: Record<string, number>;
	agentErrorRounds: number;
	fatalAborts: number;
	usage: { calls: number; input: number; output: number; cost: number };
	ts: number;
}

export function buildRunMetricsRow(input: { runId: string; status: string; agentsSpawned: number; wallMs: number; results: Array<{ id?: string; label?: string; status?: string; error?: string; cause?: string }>; usage?: { totals?: Partial<{ calls: number; input: number; output: number; cost: number }>; byAgent?: unknown }; ts: number }): RunMetricsRow {
	const stages: Record<string, number> = {};
	let agentErrorRounds = 0;
	let fatalAborts = 0;
	for (const row of input.results) {
		if (row.status) stages[row.status] = (stages[row.status] ?? 0) + 1;
		if (row.cause === "agent-error") agentErrorRounds += 1;
		if (typeof row.error === "string" && row.error.includes("FatalAbort")) fatalAborts += 1;
	}
	return {
		runId: input.runId,
		status: input.status,
		agentsSpawned: input.agentsSpawned,
		wallMs: input.wallMs,
		stages,
		agentErrorRounds,
		fatalAborts,
		usage: {
			calls: input.usage?.totals?.calls ?? 0,
			input: input.usage?.totals?.input ?? 0,
			output: input.usage?.totals?.output ?? 0,
			cost: input.usage?.totals?.cost ?? 0,
		},
		ts: input.ts,
	};
}

/** Never throws (metrics are best-effort observability, not a gate). Writes
 * BOTH the per-spec file (W2) and the global cross-run ledger (E1). */
export function appendRunMetrics(specDir: string | undefined, row: RunMetricsRow): void {
	const line = JSON.stringify(row) + "\n";
	if (specDir) {
		try {
			appendFileSync(join(specDir, "run-metrics.jsonl"), line, "utf8");
		} catch { /* best-effort observability (P5: never punishes the run) */ }
	}
	try {
		appendFileSync(join(getSuperDevDir(), "run-metrics.jsonl"), line, "utf8");
	} catch { /* best-effort observability (P5: never punishes the run) */ }
}

// ── E1: robust bands ────────────────────────────────────────────────────────

export type SigmaMetricName = "wallMs" | "costUsd" | "tokens" | "agentErrorRounds" | "fatalAborts" | "agentsSpawned";

export interface SigmaBand {
	metric: SigmaMetricName;
	value: number;
	median: number;
	mad: number;
	sigma: number;
	tier: "1σ" | "2σ" | "3σ";
	n: number;
}

export interface SigmaReport {
	insufficientHistory: boolean;
	priorRuns: number;
	bands: SigmaBand[];
}

const MIN_PRIOR_RUNS = 8;
const TRAILING_WINDOW = 20;

function median(xs: number[]): number {
	const s = [...xs].sort((a, b) => a - b);
	const mid = Math.floor(s.length / 2);
	return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

function metricValue(r: RunMetricsRow, metric: SigmaMetricName): number {
	switch (metric) {
		case "wallMs": return r.wallMs;
		case "costUsd": return r.usage?.cost ?? 0;
		case "tokens": return (r.usage?.input ?? 0) + (r.usage?.output ?? 0);
		case "agentErrorRounds": return r.agentErrorRounds ?? 0;
		case "fatalAborts": return r.fatalAborts ?? 0;
		case "agentsSpawned": return r.agentsSpawned ?? 0;
	}
}

const METRICS: SigmaMetricName[] = ["wallMs", "costUsd", "tokens", "agentErrorRounds", "fatalAborts", "agentsSpawned"];

/** Deterministic σ classification of the CURRENT row against the trailing
 *  baseline of prior rows. rows = full ledger (last row = current). */
export function sigmaReport(rows: RunMetricsRow[], current?: RunMetricsRow): SigmaReport {
	const last = current ?? rows[rows.length - 1];
	const prior = rows.slice(0, rows.length - (current ? 0 : 1)).slice(-TRAILING_WINDOW - 1);
	// When `current` is passed separately, prior = all rows (windowed); when
	// derived, prior = everything except the last row.
	const priorRows = current ? rows.slice(-TRAILING_WINDOW) : prior;
	if (!last) return { insufficientHistory: true, priorRuns: 0, bands: [] };
	if (priorRows.length < MIN_PRIOR_RUNS) {
		return { insufficientHistory: true, priorRuns: priorRows.length, bands: [] };
	}
	const bands: SigmaBand[] = [];
	for (const metric of METRICS) {
		const baseline = priorRows
			.map((r) => metricValue(r, metric))
			.filter((v) => typeof v === "number" && Number.isFinite(v));
		if (baseline.length < MIN_PRIOR_RUNS) continue; // junk-excluded rows can starve a metric — skip it honestly
		const med = median(baseline);
		const mad = median(baseline.map((v) => Math.abs(v - med)));
		const x = metricValue(last, metric);
		if (typeof x !== "number" || !Number.isFinite(x)) continue;
		let sigma: number;
		if (mad === 0) {
			sigma = x === med ? 0 : 3; // all-identical history: any deviation is maximally surprising (capped)
		} else {
			sigma = Math.abs(x - med) / (1.4826 * mad);
		}
		if (sigma < 1) continue;
		const tier: SigmaBand["tier"] = sigma >= 3 ? "3σ" : sigma >= 2 ? "2σ" : "1σ";
		bands.push({ metric, value: x, median: med, mad, sigma: Math.min(sigma, 99), tier, n: baseline.length });
	}
	bands.sort((a, b) => b.sigma - a.sigma);
	return { insufficientHistory: false, priorRuns: priorRows.length, bands };
}

/** Deterministic log block (P10 — numbers and named tiers, no prose guesses). */
export function renderSigmaLines(report: SigmaReport): string[] {
	if (report.insufficientHistory) {
		return [`σ-band: ${report.priorRuns} prior run(s) (<${MIN_PRIOR_RUNS}) — no bands yet (honest skip; baselines start at ${MIN_PRIOR_RUNS}+ prior runs)`];
	}
	if (report.bands.length === 0) return [`σ-band: all metrics within 1σ of the trailing baseline (n=${report.priorRuns})`];
	const lines: string[] = [];
	for (const b of report.bands) {
		const action = b.tier === "3σ"
			? "3σ outlier — draft intent (surface to operator)"
			: b.tier === "2σ"
				? "2σ drift — post-mortem recommended (config postMortem)"
				: "1σ — worth seeing";
		lines.push(`σ-band ${b.metric}: ${Number(b.sigma.toFixed(1))}σ (value ${b.value}, median ${Number(b.median.toFixed(4))}, MAD ${Number(b.mad.toFixed(4))}, n=${b.n}) — ${action}`);
	}
	return lines;
}

/** The just-written row of a run's own spec ledger (the E2 frame). */
export function readLastMetricsRow(specDir: string | undefined): RunMetricsRow | undefined {
	if (!specDir) return undefined;
	try {
		const lines = readFileSync(join(specDir, "run-metrics.jsonl"), "utf8").split("\n").filter((l) => l.trim().length > 0);
		const last = lines[lines.length - 1];
		return last ? (JSON.parse(last) as RunMetricsRow) : undefined;
	} catch {
		return undefined;
	}
}

/** Close-out hook (workflow.ts): read the global ledger, classify the last
 *  row, log the deterministic block. Best-effort — never throws. */
export function checkSigmaBands(log: (m: string) => void): void {
	try {
		let rows: RunMetricsRow[];
		try {
			rows = readFileSync(join(getSuperDevDir(), "run-metrics.jsonl"), "utf8")
				.split("\n")
				.filter((l) => l.trim().length > 0)
				.map((l) => JSON.parse(l) as RunMetricsRow);
		} catch {
			return; // no ledger yet — nothing to say (honest silence)
		}
		for (const line of renderSigmaLines(sigmaReport(rows))) log(line);
	} catch {
		/* best-effort observability (P5) */
	}
}
