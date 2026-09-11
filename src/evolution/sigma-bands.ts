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
import { getSuperDevDir, superDevEnv } from "../render/super-dev-dir.ts";

let warnedGlobalMetricsOff = false;

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
	// ── v0.3.85 S3 (§9 S3 / §13 run-metrics row of the 09-09 postmortem): the
	// health counters that make subsystem death VISIBLE (constitution §8.3 —
	// "every cross-module contract has a health counter in run-metrics"; the C2
	// lesson: judge death was invisible for 15 versions). Honest-zero contract
	// (P10): the keys are REQUIRED and always present in written rows — absent
	// data reads as 0, never as a missing key. Values are THIS-PASS (runId-
	// windowed) counts; derivation lives in evolution/run-observability.ts. ──
	/** Judge verdicts ACCEPTED this pass (outcome "routed" — verification
	 *  passed or a documented INV-2 exemption; see .judge.jsonl for per-row
	 *  reasons). Timeout/infra judge failures are "degraded", NOT accepted or
	 *  discarded — the meter never conflates infrastructure with verdicts. */
	judgeAccepted: number;
	/** Judge verdicts DISCARDED this pass (evidence verification failed AND
	 *  the corrective budget was exhausted — the honest discard class; a
	 *  corrective-failure escalates instead, preserving the diagnosis). */
	judgeDiscarded: number;
	/** Phases ending `partial` this pass (state.implementation.phaseStatus). */
	partialPhases: number;
	/** `source:"inherited-red"` replan handoff rows written this pass (F2/F4). */
	inheritedRedHandoffs: number;
	/** Inherited-red occurrences this pass — boundary evaluations whose
	 *  classification survived Tier 0+1 (reached the Tier-2 decision; the
	 *  .inherited-red.jsonl `event:"occurrence"` tally, windowed). */
	inheritedRedOccurrences: number;
	/** Peak implementer attempts any phase consumed this pass (F3 exposure). */
	maxPhaseAttempts: number;
	ts: number;
}

/** The v0.3.85 S3 counter set (schema lives here — the row's owner; the
 * derivation lives in evolution/run-observability.ts so this module stays
 * dependency-light). Same honest-zero contract as the row fields. */
export interface S3Counters {
	judgeAccepted: number;
	judgeDiscarded: number;
	partialPhases: number;
	inheritedRedHandoffs: number;
	inheritedRedOccurrences: number;
	maxPhaseAttempts: number;
}

export function buildRunMetricsRow(input: { runId: string; status: string; agentsSpawned: number; wallMs: number; results: Array<{ id?: string; label?: string; status?: string; error?: string; cause?: string }>; usage?: { totals?: Partial<{ calls: number; input: number; output: number; cost: number }>; byAgent?: unknown }; s3?: Partial<S3Counters>; ts: number }): RunMetricsRow {
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
		// v0.3.85 S3 honest-zero: absent derivation input still writes every
		// counter as 0 — the key is always present, the subsystem never dies
		// silently (P10).
		judgeAccepted: input.s3?.judgeAccepted ?? 0,
		judgeDiscarded: input.s3?.judgeDiscarded ?? 0,
		partialPhases: input.s3?.partialPhases ?? 0,
		inheritedRedHandoffs: input.s3?.inheritedRedHandoffs ?? 0,
		inheritedRedOccurrences: input.s3?.inheritedRedOccurrences ?? 0,
		maxPhaseAttempts: input.s3?.maxPhaseAttempts ?? 0,
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
	// v0.3.73 M5 (run 2026-09-05T23-09-55-596Z): the global append is env-guarded
	// so TEST suites that drive runWorkflow to close-out without mocking
	// getSuperDevDir stop polluting the real user ledger (481 junk rows →
	// median-0 σ-band baselines → fake 3σ on every real run). The per-specDir
	// write above is hermetic (tmp dirs) and stays unguarded. Vitest sets the
	// guard globally (tests/setup/config-env-hermeticity.ts); production leaves
	// it unset.
	// v0.3.73 dual review AR-73-04: resolution goes through the canonical
	// superDevEnv seam (process.env > config.json env map) so a deliberate
	// persistent disable is possible via config — and if the variable IS set
	// outside vitest (shell rc / wrapper leak) it WARNs once instead of failing
	// silent on every future run.
	if (superDevEnv("SUPER_DEV_NO_GLOBAL_METRICS") === "1") {
		if (!process.env.VITEST && !warnedGlobalMetricsOff) {
			warnedGlobalMetricsOff = true;
			console.warn("[super-dev] SUPER_DEV_NO_GLOBAL_METRICS=1 is active outside tests — the global run-metrics ledger will not be written (unset it or remove it from config.json env)");
		}
		return;
	}
	try {
		appendFileSync(join(getSuperDevDir(), "run-metrics.jsonl"), line, "utf8");
	} catch { /* best-effort observability (P5: never punishes the run) */ }
}

// ── E1: robust bands ────────────────────────────────────────────────────────

export type SigmaMetricName = "wallMs" | "costUsd" | "tokens" | "agentErrorRounds" | "fatalAborts" | "agentsSpawned"
// v0.3.85 S3: the new health counters join the SAME banding machinery — no
// new banding code, just rows in the existing table (§9 S3 "sigma-banded").
	| "judgeAccepted" | "judgeDiscarded" | "partialPhases" | "inheritedRedHandoffs" | "inheritedRedOccurrences" | "maxPhaseAttempts";

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

/** Banding honesty floor: fewer prior rows ⇒ insufficientHistory, no bands.
 *  Exported because the eval-layer validation gate (§8.5 fold of
 *  docs/requirements/sdlc-tips-adoption.md) shares the SAME floor — n<8
 *  matched pairs is a directional signal only there too. ONE constant, two
 *  consumers (P6 single grammar; no re-typed 8). */
export const MIN_PRIOR_RUNS = 8;
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
		// v0.3.85 S3: `?? 0` guards old ledger rows (pre-S3 files lack the keys;
		// a missing counter reads as the honest 0, never NaN — junk filtering
		// below then treats it as a legitimate baseline value).
		case "judgeAccepted": return r.judgeAccepted ?? 0;
		case "judgeDiscarded": return r.judgeDiscarded ?? 0;
		case "partialPhases": return r.partialPhases ?? 0;
		case "inheritedRedHandoffs": return r.inheritedRedHandoffs ?? 0;
		case "inheritedRedOccurrences": return r.inheritedRedOccurrences ?? 0;
		case "maxPhaseAttempts": return r.maxPhaseAttempts ?? 0;
	}
}

const METRICS: SigmaMetricName[] = ["wallMs", "costUsd", "tokens", "agentErrorRounds", "fatalAborts", "agentsSpawned", "judgeAccepted", "judgeDiscarded", "partialPhases", "inheritedRedHandoffs", "inheritedRedOccurrences", "maxPhaseAttempts"];

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
