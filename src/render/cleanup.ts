/**
 * Post-reflection cleanup: retention (delete old runs/traces) + stats update.
 * Called by the reflection agent after updating learned.md.
 */

import { readdirSync, statSync, unlinkSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { getSuperDevDir, getConfig, getStatsPath, getAuditPath, getRunDir } from "./super-dev-dir.ts";

export interface RunStats {
	totalRuns: number;
	totalStages: number;
	totalRetries: number;
	avgRunDurationMs: number;
	mostRetriedStage: string;
	stageStats: Record<string, { runs: number; avgAttempts: number; avgMs: number }>;
	updatedAt: string;
}

/** Delete run directories and traces older than the configured retention. */
export function cleanupOldRuns(): { deletedRuns: number; deletedTraces: number } {
	const config = getConfig();
	const now = Date.now();
	const runMs = config.runRetentionDays * 86400000;
	const traceMs = config.traceRetentionDays * 86400000;
	let deletedRuns = 0;
	let deletedTraces = 0;

	// Clean old runs
	try {
		const runsDir = join(getSuperDevDir(), "runs");
		for (const entry of readdirSync(runsDir)) {
			const path = join(runsDir, entry);
			try {
				if (now - statSync(path).mtimeMs > runMs) {
					rmSync(path, { recursive: true, force: true });
					deletedRuns++;
				}
			} catch { /* skip */ }
		}
	} catch { /* runs dir missing */ }

	// Clean old traces
	try {
		const tracesDir = join(getSuperDevDir(), "traces");
		for (const entry of readdirSync(tracesDir)) {
			const path = join(tracesDir, entry);
			try {
				if (now - statSync(path).mtimeMs > traceMs) {
					unlinkSync(path);
					deletedTraces++;
				}
			} catch { /* skip */ }
		}
	} catch { /* traces dir missing */ }

	return { deletedRuns, deletedTraces };
}

/** Read the current run's audit.jsonl and update aggregate stats.json. */
export function updateStats(): void {
	const auditPath = getAuditPath();
	if (!existsSync(auditPath)) return;

	// Read current stats
	let stats: RunStats;
	try {
		stats = JSON.parse(readFileSync(getStatsPath(), "utf8"));
	} catch {
		stats = { totalRuns: 0, totalStages: 0, totalRetries: 0, avgRunDurationMs: 0, mostRetriedStage: "", stageStats: {}, updatedAt: "" };
	}

	// Parse this run's audit
	const lines = readFileSync(auditPath, "utf8").trim().split("\n").filter(Boolean);
	let runStages = 0;
	let runRetries = 0;
	let runDuration = 0;
	const stageAttempts: Record<string, number> = {};
	const stageMs: Record<string, number[]> = {};

	for (const line of lines) {
		try {
			const entry = JSON.parse(line);
			runStages++;
			if (entry.durationMs) runDuration += entry.durationMs;
			if (entry.gate?.pass === false) runRetries++;
			const stage = entry.stage ?? "unknown";
			stageAttempts[stage] = (stageAttempts[stage] ?? 0) + 1;
			if (entry.durationMs) (stageMs[stage] ??= []).push(entry.durationMs);
		} catch { /* skip malformed */ }
	}

	// Update aggregate
	stats.totalRuns++;
	stats.totalStages += runStages;
	stats.totalRetries += runRetries;
	stats.avgRunDurationMs = Math.round(stats.avgRunDurationMs * ((stats.totalRuns - 1) / stats.totalRuns) + runDuration / stats.totalRuns);

	// Per-stage stats
	for (const [stage, attempts] of Object.entries(stageAttempts)) {
		const prev = stats.stageStats[stage] ?? { runs: 0, avgAttempts: 0, avgMs: 0 };
		const ms = stageMs[stage] ?? [];
		const avgMs = ms.length ? Math.round(ms.reduce((a, b) => a + b, 0) / ms.length) : 0;
		stats.stageStats[stage] = {
			runs: prev.runs + 1,
			avgAttempts: Math.round(((prev.avgAttempts * prev.runs) + attempts) / (prev.runs + 1)),
			avgMs: Math.round(((prev.avgMs * prev.runs) + avgMs) / (prev.runs + 1)),
		};
	}

	// Most retried stage
	let maxRetries = 0;
	for (const [stage, s] of Object.entries(stats.stageStats)) {
		if (s.avgAttempts > maxRetries) { maxRetries = s.avgAttempts; stats.mostRetriedStage = stage; }
	}

	stats.updatedAt = new Date().toISOString();
	try { writeFileSync(getStatsPath(), JSON.stringify(stats, null, 2) + "\n"); } catch { /* best-effort */ }
}
