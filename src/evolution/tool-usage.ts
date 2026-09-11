/**
 * v0.3.76 L2 (collection half) — tool-usage telemetry.
 *
 * The delegation bus's progress ticks carry the child's actual tool calls
 * (recentTools / currentTool). This module lands them as ONE JSON row per
 * (call, tool, argHead) into <specDir>/tool-usage.jsonl — the RAW feed a
 * future curation loop reads to decide which skills/extensions agents really
 * use (measured curation instead of guessing). Collection ONLY in this wave:
 * no interpretation, no gating, no LLM — matching to skills happens later,
 * offline, against skill allowed-tools patterns.
 *
 * P3 (D6 / DEC-12 telemetry amendment, 2026-09-11 third-round ruling): the
 * (tool, argHead) dedup key now carries `count: n` instead of dropping
 * repeats — in-call repetition (the flagship example class the v0.3.76
 * collector folded away) is preserved as a count. ABSENT ≡ 1: readers that
 * ignore `count` see identical behavior to the pre-amendment rows (backward
 * compatible by construction). argHead stays 60 chars (long paths =
 * prefix-family semantics, recorded as-is).
 *
 * Registry note: tool-usage.jsonl is declared in HARNESS_FILE_ROLES with
 * events.jsonl parity (redBoundarySpecScoped + trackerAdvisoryNoise +
 * specDirBookkeeping) — the v0.3.75 review M1 lesson: a new engine-owned
 * spec-dir file that is NOT registered breaks merge-verify (its own appends
 * read as dirty tracked changes) and the RED write-boundary.
 */
import { appendFileSync } from "node:fs";
import { join } from "node:path";

/** The telemetry basename (shared with the P3 reread-check reader). */
export const TOOL_USAGE_BASENAME = "tool-usage.jsonl";

/** One observed tool invocation (keyed per agent call by the collector; the
 *  dedup key (tool, argHead) carries `count` — repeat invocations inside the
 *  same call INCREMENT it instead of writing a second row). */
export interface ToolUsageRow {
	ts: number;
	runId: string;
	agent: string;
	tool: string;
	/** First words of the invocation args (bounded, single line) — enough to
	 *  identify the command family (e.g. `firecrawl search …`) without logging
	 *  full arguments (they may contain task/user text). */
	argHead: string;
	/** Invocations of this exact (tool, argHead) inside this agent call
	 *  (D6/DEC-12). Absent ≡ 1 — the pre-P3 row shape remains valid. */
	count?: number;
}

/** Bound + sanitize an args string into an argHead. */
export function toolArgHead(args: string | undefined): string {
	if (typeof args !== "string") return "";
	return args.replace(/\s+/g, " ").trim().slice(0, 60);
}

/** Best-effort telemetry append (crash-durable single write, P5 never
 *  throws). No spec dir → no-op. */
export function appendToolUsageRows(specDir: string | undefined, rows: ToolUsageRow[]): void {
	if (!specDir || rows.length === 0) return;
	try {
		appendFileSync(join(specDir, TOOL_USAGE_BASENAME), rows.map((r) => JSON.stringify(r) + "\n").join(""), "utf8");
	} catch { /* best-effort observability (P5) */ }
}
