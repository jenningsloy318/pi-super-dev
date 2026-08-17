/**
 * Centralized super-dev user-level directory management.
 *
 * All super-dev runtime data lives under ~/.super-dev/:
 *   config.json, learned.md, learned-index.json, runs/<ts>/, traces/, stats.json
 *
 * This module provides path resolution, config defaults, and per-run lifecycle.
 */

import { mkdirSync, readFileSync, appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const SUPER_DEV_DIR = join(homedir(), ".super-dev");

export interface SuperDevConfig {
	reflectionEnabled: boolean;
	topNPreload: number;
	indexListSize: number;
	maxLearnedEntries: number;
	minScoreToKeep: number;
	archiveAfterDays: number;
	runRetentionDays: number;
	traceRetentionDays: number;
	/** How verify-loop stagnation is surfaced (Gap 4.6′-lite):
	 *  - "informative" (default): non-blocking — diagnostic in the run summary +
	 *    a stagnation-report.md in the spec dir. Never prompts; headless-safe.
	 *  - "interactive": additionally prompt with a 3-option select when
	 *    stagnation fires AND the run is in TUI/RPC mode (ctx.hasUI). Headless
	 *    runs always fall back to "informative". */
	escalation: "informative" | "interactive";
	/** Per-agent-role model overrides. Keys are agent role names (e.g.
	 *  "code-reviewer", "adversarial-reviewer"); values are qualified "provider/id"
	 *  model strings. Lets you run review on a DIFFERENT model than implementation
	 *  (cross-model review — no output graded by the same model that wrote it).
	 *  Precedence: this config OVERRIDES the global --model/SUPER_DEV_MODEL for the
	 *  listed roles (a cross-model policy must not be silently undone by a one-off
	 *  --model), but an explicit per-call model still wins. Unlisted roles are
	 *  unaffected. Empty/absent = today's behavior. */
	agentModels?: Record<string, string>;
}

const DEFAULT_CONFIG: SuperDevConfig = {
	reflectionEnabled: true,
	topNPreload: 3,
	indexListSize: 10,
	maxLearnedEntries: 200,
	minScoreToKeep: 3,
	archiveAfterDays: 90,
	runRetentionDays: 30,
	traceRetentionDays: 7,
	escalation: "informative",
};

// ─── paths ──────────────────────────────────────────────────────────────────

export function getSuperDevDir(): string { return SUPER_DEV_DIR; }
export function getLearnedPath(): string { return join(SUPER_DEV_DIR, "learned.md"); }
export function getLearnedIndexPath(): string { return join(SUPER_DEV_DIR, "learned-index.json"); }
export function getLearnedArchivePath(): string { return join(SUPER_DEV_DIR, "learned-archive.md"); }
export function getStatsPath(): string { return join(SUPER_DEV_DIR, "stats.json"); }
export function getTracesDir(): string { return join(SUPER_DEV_DIR, "traces"); }
export function getRunsDir(): string { return join(SUPER_DEV_DIR, "runs"); }
export function getConfigPath(): string { return join(SUPER_DEV_DIR, "config.json"); }

// ─── config ─────────────────────────────────────────────────────────────────

export function ensureSuperDevDirs(): void {
	mkdirSync(getRunsDir(), { recursive: true });
	mkdirSync(getTracesDir(), { recursive: true });
}

export function getConfig(): SuperDevConfig {
	try {
		const raw = readFileSync(getConfigPath(), "utf8");
		return { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
	} catch { return DEFAULT_CONFIG; }
}

// ─── per-run lifecycle ──────────────────────────────────────────────────────

let currentRunDir: string | null = null;

/** Start a new run — creates the run directory and sets the active audit/log paths. */
export function startRun(): string {
	const ts = new Date().toISOString().replace(/[:.]/g, "-");
	currentRunDir = join(getRunsDir(), ts);
	mkdirSync(currentRunDir, { recursive: true });
	return currentRunDir;
}

export function getRunDir(): string | null { return currentRunDir; }

/** AC-29 (SCENARIO-060): path-for helpers — resolve a run's file paths from a
 *  run dir CAPTURED ONCE at run start, so a run B starting while run A's async
 *  reflection is still in flight can never redirect A's writes. */
export function runLogPathFor(runDir: string): string { return join(runDir, "run.log"); }
export function auditPathFor(runDir: string): string { return join(runDir, "audit.jsonl"); }
export function reflectionPathFor(runDir: string): string { return join(runDir, "reflection.md"); }

export function getRunLogPath(): string { return join(currentRunDir ?? SUPER_DEV_DIR, "run.log"); }
export function getAuditPath(): string { return join(currentRunDir ?? SUPER_DEV_DIR, "audit.jsonl"); }
export function getReflectionPath(): string { return join(currentRunDir ?? SUPER_DEV_DIR, "reflection.md"); }

// ─── audit trail ────────────────────────────────────────────────────────────

export interface AuditEntry {
	ts?: string;
	stage: string;
	agent?: string;
	attempt?: number;
	durationMs?: number;
	gate?: { pass: boolean; errors: string[] } | null;
	control?: unknown;
	error?: string;
	turns?: number;
	backend?: string;
}

/** Append a structured audit entry to the current run's audit.jsonl.
 *  AC-29 (SCENARIO-060): an explicit `runDir` (captured once at run start)
 *  takes precedence over the module-global current run dir, so late async
 *  work (e.g. reflection) always lands under its ORIGINATING run. Best-effort.
 *  D-8: the file is created 0600 (audit trails may quote task/secrets text). */
export function auditAppend(entry: AuditEntry, runDir?: string): void {
	const dir = runDir ?? currentRunDir;
	if (!dir) return; // no active run (e.g., in tests)
	try {
		appendFileSync(auditPathFor(dir), JSON.stringify({ ...entry, ts: new Date().toISOString() }) + "\n", { mode: 0o600 });
	} catch { /* best-effort — never break the pipeline */ }
}
