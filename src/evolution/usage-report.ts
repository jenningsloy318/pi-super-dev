/**
 * v0.3.75 W1 — usage attribution dashboard (user ask 2026-09-07: "write the
 * total token usage and cost on the dashboard after each run, plus per-stage
 * and per-agent, so we know where the spend goes and optimize with
 * direction").
 *
 * Three artifacts, all best-effort / never-throwing (P5 — observability never
 * punishes the run):
 *  1. <specDir>/usage-calls.jsonl — ONE JSON row per terminal agent call
 *     (per-call append, crash-durable; failed calls included even without
 *     usage — wasted dispatches are where money goes wrong).
 *  2. <specDir>/usage-report.md — rendered dashboard: totals, per-stage table
 *     (cost-sorted), per-agent table, top-N most expensive calls, cache-hit
 *     share, and the cheapest-observed-prompt "fixed floor" line (the ambient
 *     skill listing lives there — run 2026-09-07T00-49-33-204Z measured a
 *     127-output-token classification on 50,914 input tokens).
 *  3. a compact summary block into the run log via the log callback.
 *
 * Resume honesty (P10): the report covers THIS pass only (runId-named);
 * prior passes' rows remain in usage-calls.jsonl with their own runIds.
 */
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { UsageAccumulator, UsageCallRow } from "../types.ts";

type Bucket = NonNullable<UsageAccumulator["byAgent"][string]>;

/** The usage numeric fields, in canonical order — shared with workflow.ts
 * (accumulator loops + the per-call row builder) so the three copies cannot
 * drift (v0.3.75 review N1: was a dead local beside two inlined copies). */
export const USAGE_FIELDS = ["turns", "toolCalls", "input", "output", "cacheRead", "cacheWrite", "cost", "durationMs"] as const;

/** Normalize a call id to a stable stage key: trailing round/attempt/try
 * counter segments (`.a2`, `.t3`, `.r03`, `.round4`, `.attempt5`, `.try2`)
 * collapse so retries aggregate under one stage row while semantic segments
 * (`impl` vs `red-review` vs `runner-discovery`, phase ids) are preserved.
 * Grammar of our ids (src/stages/*): `pipeline.<stage>[.<sub>][.aN[.tN]]`,
 * `pipeline.prototype.rNN`, single-segment stage ids, `red-replan-<phase>`. */
export function stageKey(id: string): string {
	const segs = id.split(".");
	// Strip trailing counter segments only — never a leading/semantic one.
	while (segs.length > 1 && /^(?:a|t|r|round|attempt|try)\d{1,4}$/i.test(segs[segs.length - 1] ?? "")) segs.pop();
	return segs.join(".");
}

/** Best-effort per-call ledger append — one write per terminal call, mirroring
 * the events-ledger convention (crash-durable). No spec dir → no-op. */
export function appendUsageCallRows(specDir: string | undefined, rows: UsageCallRow[]): void {
	if (!specDir || rows.length === 0) return;
	try {
		appendFileSync(join(specDir, "usage-calls.jsonl"), rows.map((r) => JSON.stringify(r) + "\n").join(""), "utf8");
	} catch { /* best-effort observability (P5) */ }
}

function fmtK(n: number | undefined): string {
	if (typeof n !== "number" || !Number.isFinite(n)) return "—";
	if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
	if (n >= 1_000) return (n / 1_000).toFixed(1) + "K";
	return String(n);
}
function fmtMs(n: number | undefined): string {
	if (typeof n !== "number" || !Number.isFinite(n)) return "—";
	if (n >= 60_000) return (n / 60_000).toFixed(1) + "m";
	if (n >= 1_000) return (n / 1_000).toFixed(1) + "s";
	return n + "ms";
}
function fmt$(n: number | undefined): string {
	if (typeof n !== "number" || !Number.isFinite(n)) return "—";
	return "$" + n.toFixed(4);
}

function bucketRow(key: string, b: Bucket, kind: "stage" | "agent"): string {
	const avgDur = b.calls > 0 ? (b.durationMs ?? 0) / b.calls : undefined;
	const cache = (b.input ?? 0) + (b.cacheRead ?? 0);
	const cacheShare = cache > 0 ? Math.round(((b.cacheRead ?? 0) / cache) * 100) + "%" : "—";
	const name = kind === "agent" ? key.replace(/^sd-/, "") : key;
	return `| ${name} | ${b.calls} | ${fmtK(b.input)} | ${fmtK(b.output)} | ${fmtK(b.cacheRead)} (${cacheShare}) | ${fmt$(b.cost)} | ${avgDur != null ? fmtMs(avgDur) : "—"} |`;
}

export interface UsageReportInput {
	runId: string;
	status: string;
	wallMs: number;
	usage: UsageAccumulator;
	calls: UsageCallRow[];
}

/** Pure renderer — null when zero calls were recorded (P10 no fabrication). */
export function renderUsageReport(input: UsageReportInput): string | null {
	const { usage, calls } = input;
	if (usage.totals.calls === 0 && calls.length === 0) return null;

	const promptTotal = (usage.totals.input ?? 0) + (usage.totals.cacheRead ?? 0);
	const cacheShare = promptTotal > 0 ? Math.round(((usage.totals.cacheRead ?? 0) / promptTotal) * 100) : 0;
	// v0.3.75 review M4: the headline count is TERMINAL CALLS (ledger rows),
	// not usage-bearing calls — an all-failed run must not read "0 agent
	// call(s)" over a Top-calls table that (correctly) shows nothing. Failed
	// rows without usage are spend the owner could not attribute — say so
	// (P10: unknowns stay unknown, never "0").
	const failed = calls.filter((c) => c.status === "failed").length;
	const noUsage = calls.filter((c) => !USAGE_FIELDS.some((k) => typeof c[k] === "number")).length;
	const dispatchTotal = calls.reduce((s, c) => s + (c.dispatches ?? 1), 0);

	const lines: string[] = [];
	lines.push(`# Usage report`);
	lines.push("");
	lines.push(`- run: \`${input.runId}\` — status **${input.status}** — wall ${fmtMs(input.wallMs)} — ${calls.length} agent call(s)${dispatchTotal > calls.length ? ` (${dispatchTotal} dispatches — transient retries)` : ""}${failed > 0 ? ` — ${failed} failed` : ""}${noUsage > 0 ? ` — ${noUsage} without usage data (spend not attributable: thrown/timed-out calls)` : ""}`);
	lines.push(`- total: input ${fmtK(usage.totals.input)} + cache-read ${fmtK(usage.totals.cacheRead)} (cache-hit ${cacheShare}% of prompt tokens) → output ${fmtK(usage.totals.output)} — **cost ${fmt$(usage.totals.cost)}**`);
	lines.push(`- covers THIS pass only; prior passes' rows remain in \`usage-calls.jsonl\` (per-run \`runId\`)`);

	// Per-stage table (cost-sorted).
	const stages = Object.entries(usage.byStage ?? {}).sort((a, b) => (b[1].cost ?? 0) - (a[1].cost ?? 0));
	if (stages.length > 0) {
		lines.push("");
		lines.push(`## By stage`);
		lines.push("");
		lines.push(`| stage | calls | in | out | cache (hit) | cost | avg dur |`);
		lines.push(`|---|---|---|---|---|---|---|`);
		for (const [key, b] of stages) lines.push(bucketRow(key, b, "stage"));
	}

	// Per-agent table (cost-sorted).
	const agents = Object.entries(usage.byAgent ?? {}).sort((a, b) => (b[1].cost ?? 0) - (a[1].cost ?? 0));
	if (agents.length > 0) {
		lines.push("");
		lines.push(`## By agent`);
		lines.push("");
		lines.push(`| agent | calls | in | out | cache (hit) | cost | avg dur |`);
		lines.push(`|---|---|---|---|---|---|---|`);
		for (const [key, b] of agents) lines.push(bucketRow(key, b, "agent"));
	}

	// Top calls by cost (max 10) — the amplifiers, visible at a glance.
	const top = [...calls]
		.filter((c) => typeof c.cost === "number" || typeof c.input === "number")
		.sort((a, b) => (b.cost ?? (b.input ?? 0) * 1e-5) - (a.cost ?? (a.input ?? 0) * 1e-5))
		.slice(0, 10);
	if (top.length > 0) {
		lines.push("");
		lines.push(`## Top calls`);
		lines.push("");
		lines.push(`| call | agent | in (+cache) | out | cost | dur | status |`);
		lines.push(`|---|---|---|---|---|---|---|`);
		for (const c of top) {
			lines.push(`| ${c.id} | ${c.agent} | ${fmtK(c.input)} (+${fmtK(c.cacheRead)}) | ${fmtK(c.output)} | ${fmt$(c.cost)} | ${fmtMs(c.durationMs)} | ${c.status}${c.error ? ` — ${c.error.slice(0, 80)}` : ""} |`);
		}
	}

	// Fixed-floor line: the cheapest observed prompt approximates the fixed
	// per-call overhead (ambient skill listing + tools + system prompt).
	// v0.3.75 review M4: only rows with a REAL prompt-side measurement count —
	// a completed-without-usage row fabricated "0 tokens" as the floor.
	const cheapest = [...calls]
		.filter((c) => typeof c.input === "number" || typeof c.cacheRead === "number")
		.sort((a, b) => ((a.input ?? 0) + (a.cacheRead ?? 0)) - ((b.input ?? 0) + (b.cacheRead ?? 0)))[0];
	if (cheapest) {
		const floor = (cheapest.input ?? 0) + (cheapest.cacheRead ?? 0);
		lines.push("");
		lines.push(`## Fixed floor`);
		lines.push("");
		lines.push(`- cheapest observed prompt: **${fmtK(floor)} tokens** on \`${cheapest.id}\` (${cheapest.agent}) ≈ the fixed per-call overhead floor (skill listing + tools + system prompt). Multiply by ${dispatchTotal} dispatch(es) for the run's fixed cost.`);
	}

	return lines.join("\n") + "\n";
}

/** Close-out orchestrator: write the report + log a compact summary. The
 * per-call LEDGER is NOT re-appended here — realAgent already appends each row
 * at terminal time (crash-durable single-write); re-flushing the array would
 * duplicate every line. Never throws; no spec dir → log-only. */
export function writeUsageArtifacts(specDir: string | undefined, input: UsageReportInput, log: (m: string) => void): void {
	try {
		const md = renderUsageReport(input);
		if (specDir && md) {
			try {
				writeFileSync(join(specDir, "usage-report.md"), md, "utf8");
			} catch { /* best-effort (P5) */ }
		}
		// Compact run-log summary: total + top-3 stages by cost. Headline count
		// is terminal ledger rows (v0.3.75 review M4) — failed calls included.
		if (input.usage.totals.calls > 0 || input.calls.length > 0) {
			const noUsage = input.calls.filter((c) => !USAGE_FIELDS.some((k) => typeof c[k] === "number")).length;
			const topStages = Object.entries(input.usage.byStage ?? {})
				.sort((a, b) => (b[1].cost ?? 0) - (a[1].cost ?? 0))
				.slice(0, 3)
				.map(([k, b]) => `${k.replace(/^pipeline\./, "")}=${fmt$(b.cost)}`)
				.join(", ");
			log(`usage report: ${input.calls.length} calls${noUsage > 0 ? ` (${noUsage} without usage data)` : ""} — in ${fmtK(input.usage.totals.input)} (+cache ${fmtK(input.usage.totals.cacheRead)}) out ${fmtK(input.usage.totals.output)} — ${fmt$(input.usage.totals.cost)}${topStages ? ` — top stages: ${topStages}` : ""}${specDir ? ` — ${join(specDir, "usage-report.md")}` : ""}`);
		}
	} catch { /* best-effort observability (P5) */ }
}
