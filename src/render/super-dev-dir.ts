/**
 * Centralized super-dev user-level directory management.
 *
 * All super-dev runtime data lives under ~/.super-dev/:
 *   config.json, learned.md, learned-index.json, runs/<ts>/, traces/, stats.json
 *
 * This module provides path resolution, config defaults, and per-run lifecycle.
 */

import { mkdirSync, readFileSync, appendFileSync, statSync } from "node:fs";
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
	/** v0.3.15: persistent channel for the SUPER_DEV_* tunables (timeouts,
	 *  budgets, kill-switches, model/backend selectors) so GUI-launched pi
	 *  sessions — which have no shell env — can still set them. Flat string
	 *  map; consumed via superDevEnv(). Precedence per key:
	 *    1. process.env (a one-off shell override beats the persistent file)
	 *    2. this map (string values only; other types ignored)
	 *    3. undefined
	 *  Bootstrap-excluded on purpose: SUPER_DEV_DIR (config.json lives there),
	 *  and the subprocess IPC / release-tooling plumbing vars. */
	env?: Record<string, string>;
}

export const DEFAULT_CONFIG: SuperDevConfig = {
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

/** v0.3.15: read a SUPER_DEV_* tunable with config.json as the persistent
 *  fallback channel. Precedence: process.env > config.env > undefined.
 *  An EMPTY process.env string is treated as unset so a GUI-inherited empty
 *  var can never silently mask a configured value (consumers already use
 *  `?? ""` / parseInt-|| fallbacks, so treating "" as absent is safe).
 *  Reads config lazily per call — no module-load snapshot — so config edits
 *  mid-run are observed by later calls. */
export function superDevEnv(key: string): string | undefined {
	const fromEnv = process.env[key];
	if (fromEnv !== undefined && fromEnv !== "") return fromEnv;
	const fromConfig = envConfigCached()?.[key];
	return typeof fromConfig === "string" && fromConfig !== "" ? fromConfig : undefined;
}

/** mtime-keyed 1-entry cache of the config's env map (review F4): gates.ts
 *  reads tunables inside spawn loops; re-reading + re-parsing config.json on
 *  every lookup is measurable there. A config edit mid-run is still observed
 *  within one mtime tick of the next lookup. */
let envConfigCache: { mtimeMs: number; env: Record<string, string> | undefined } | null = null;
function envConfigCached(): Record<string, string> | undefined {
	try {
		const st = statSync(getConfigPath());
		if (!envConfigCache || envConfigCache.mtimeMs !== st.mtimeMs) {
			envConfigCache = { mtimeMs: st.mtimeMs, env: getConfig().env };
		}
		return envConfigCache.env;
	} catch {
		envConfigCache = null;
		return undefined;
	}
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
