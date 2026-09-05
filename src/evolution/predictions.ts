/**
 * v0.3.69 E5 — PREDICTION LEDGER (decision observability).
 *
 * Plan §9.2 aspect 7 ("Prove"): every fix is a falsifiable prediction about a
 * metrics-ledger field; E5 verifies those predictions deterministically once
 * enough post-fix runs accumulate. Findings (drafts and approved) carry a
 * `prediction: <metric> <direction>` line (E2 drafts it; humans may edit);
 * E5 compares the recent-window median (last 3 rows) against the prior
 * baseline median (rows before that, n≥3 required) and APPENDS a
 * `prediction-status:` line — supported / refuted / unverified — never
 * overwriting an earlier verdict. Honest limits (P10): without fix
 * timestamps the comparison is recent-vs-prior-window, a signal not a proof;
 * unverified stays unverified; junk files are skipped silently.
 */
import { readFileSync, readdirSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { getSuperDevDir } from "../render/super-dev-dir.ts";
import type { RunMetricsRow } from "./sigma-bands.ts";

const PREDICTION_RE = /^prediction:\s*([A-Za-z]+)\s+(increase|decrease)\s*$/m;
const STATUS_RE = /^prediction-status:/m;

const METRIC_READERS: Record<string, (r: RunMetricsRow) => number> = {
	wallMs: (r) => r.wallMs,
	costUsd: (r) => r.usage?.cost ?? 0,
	tokens: (r) => (r.usage?.input ?? 0) + (r.usage?.output ?? 0),
	agentErrorRounds: (r) => r.agentErrorRounds ?? 0,
	fatalAborts: (r) => r.fatalAborts ?? 0,
	agentsSpawned: (r) => r.agentsSpawned ?? 0,
};

/** The extension repo's docs/findings/ (same derivation as post-mortem.ts). */
export function defaultFindingsDir(): string {
	const here = fileURLToPath(new URL(".", import.meta.url)); // …/src/evolution/
	return join(here, "..", "..", "docs", "findings");
}

function median(xs: number[]): number {
	const s = [...xs].sort((a, b) => a - b);
	const mid = Math.floor(s.length / 2);
	return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

export interface PredictionVerdict {
	file: string;
	metric: string;
	direction: "increase" | "decrease";
	verdict: "supported" | "refuted" | "unverified";
	detail: string;
}

/** Verify predictions in `dir` against the ledger rows; append verdict lines
 *  to files that had none. Best-effort per file — never throws. */
export function checkPredictions(dir: string, rows: RunMetricsRow[]): PredictionVerdict[] {
	const out: PredictionVerdict[] = [];
	let files: string[] = [];
	try {
		files = readdirSync(dir).filter((f) => f.endsWith(".md"));
		// inbox drafts (pending triage) carry predictions too — scan both levels.
		const inbox = join(dir, "inbox");
		for (const f of readdirSync(inbox).filter((f) => f.endsWith(".md"))) files.push(join("inbox", f));
	} catch {
		// fall through with whatever was collected; empty is honest silence
	}
	for (const f of files) {
		try {
			const path = join(dir, f);
			const md = readFileSync(path, "utf8");
			if (STATUS_RE.test(md)) continue; // already adjudicated — never overwrite
			const m = PREDICTION_RE.exec(md);
			if (!m) continue;
			const metric = m[1]!;
			const direction = m[2] as "increase" | "decrease";
			const read = METRIC_READERS[metric];
			if (!read) continue; // unknown metric — skip honestly
			const recent = rows.slice(-3).map(read).filter((v) => Number.isFinite(v));
			const priorRows = rows.slice(0, Math.max(0, rows.length - 3));
			const baseline = priorRows.map(read).filter((v) => Number.isFinite(v));
			if (recent.length < 3 || baseline.length < 3) {
				out.push({ file: f, metric, direction, verdict: "unverified", detail: `insufficient runs (recent n=${recent.length}, baseline n=${baseline.length})` });
				continue; // no verdict line yet — wait for data
			}
			const recentMed = median(recent);
			const baselineMed = median(baseline);
			const moved = recentMed === baselineMed ? "none" : recentMed > baselineMed ? "increase" : "decrease";
			const verdict: PredictionVerdict["verdict"] = moved === direction ? "supported" : moved === "none" ? "unverified" : "refuted";
			const detail = `recent median ${Number(recentMed.toFixed(4))} vs baseline ${Number(baselineMed.toFixed(4))} (n=3)`;
			if (verdict !== "unverified") {
				appendFileSync(path, `\nprediction-status: ${verdict} (${detail})\n`, "utf8");
			}
			out.push({ file: f, metric, direction, verdict, detail });
		} catch {
			/* per-file best-effort */
		}
	}
	return out;
}

/** Deterministic log lines for the close-out hook. */
export function renderPredictionLines(verdicts: PredictionVerdict[]): string[] {
	const interesting = verdicts.filter((v) => v.verdict !== "unverified" || v.detail.includes("insufficient") === false);
	if (interesting.length === 0) return [];
	const lines = ["prediction ledger:"];
	for (const v of interesting) {
		lines.push(`  ${v.file}: ${v.metric} ${v.direction} → ${v.verdict} (${v.detail})`);
	}
	return lines;
}

/** Close-out hook (workflow.ts): verify predictions against the global ledger. */
export function checkPredictionsFromLedger(log: (m: string) => void): void {
	try {
		const rows = readFileSync(join(getSuperDevDir(), "run-metrics.jsonl"), "utf8")
			.split("\n").filter((l) => l.trim().length > 0)
			.map((l) => JSON.parse(l) as RunMetricsRow);
		for (const line of renderPredictionLines(checkPredictions(defaultFindingsDir(), rows))) log(line);
	} catch {
		/* no ledger — honest silence */
	}
}
