/**
 * Workflow resume (v0.3.0) — Solution B: memoized agent-call replay.
 *
 * The cache is an append-only event log (`<specDir>/.resume-cache.jsonl`), one
 * JSON line per completed agent call: `{"key": "<callId>#<seq>", "result": <AgentResult>}`.
 * On resume, `pipeline.ts` loads it (last-wins per key) into a Map and passes it
 * to the workflow; `ctx.agent` becomes a memoizing wrapper (createMemoizingAgent)
 * that returns cached results for completed calls and runs+caches the rest. The
 * workflow code itself is unchanged — it re-runs from the top and naturally
 * fast-forwards through completed calls (including mid-loop) until the first
 * uncached call, which is the interrupted one.
 *
 * This is the durable-execution replay pattern (Temporal/DBOS/Restate): replay
 * the workflow with memoized activity results. Determinism contract: the
 * workflow must not branch on wall-clock/random — today it branches only on
 * cached state, so the call sequence matches on replay. Any divergence just
 * cache-misses that call (still correct, less efficient).
 */

import { appendFileSync, readFileSync, existsSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentCall, AgentResult } from "./types.ts";

const CACHE_FILE = ".resume-cache.jsonl";
const COMPLETE_FILE = ".complete";

// ─── paths ──────────────────────────────────────────────────────────────────

export function resumeCachePath(specDir: string): string {
	return join(specDir, CACHE_FILE);
}

/** The spec dir for a given spec identifier, preferring the (persisted) worktree. */
export function specDirFor(cwd: string, specIdentifier: string): string {
	const inWorktree = join(cwd, ".worktree", specIdentifier, "docs", "specifications", specIdentifier);
	if (existsSync(inWorktree)) return `${inWorktree}/`;
	return `${join(cwd, "docs", "specifications", specIdentifier)}/`;
}

// ─── cache I/O (append-only, last-wins, partial-tail-safe) ──────────────────

/** Append one completed agent-call result to the cache log (crash-safe). */
export function appendResumeResult(specDir: string, key: string, result: AgentResult): void {
	try {
		appendFileSync(resumeCachePath(specDir), JSON.stringify({ key, result }) + "\n");
	} catch { /* best-effort; resume is opportunistic */ }
}

/** Load the cache as a Map (last value wins per key; a partial trailing line is ignored). */
export function loadResumeCache(specDir: string): Map<string, AgentResult> {
	const map = new Map<string, AgentResult>();
	let raw: string;
	try {
		raw = readFileSync(resumeCachePath(specDir), "utf8");
	} catch {
		return map; // no cache → nothing to resume
	}
	for (const line of raw.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		try {
			const entry = JSON.parse(trimmed) as { key: string; result: AgentResult };
			if (entry?.key && entry?.result) map.set(entry.key, entry.result);
		} catch {
			/* partial/corrupt line — skip (last-wins keeps prior good entries) */
		}
	}
	return map;
}

/** Clear the cache (called after a successful completed run so it isn't re-resumable). */
export function clearResumeCache(specDir: string): void {
	try {
		if (existsSync(resumeCachePath(specDir))) writeFileSync(resumeCachePath(specDir), "");
		if (existsSync(join(specDir, COMPLETE_FILE))) return; // already marked
		writeFileSync(join(specDir, COMPLETE_FILE), new Date().toISOString());
	} catch { /* best-effort */ }
}

// ─── resumability detection ─────────────────────────────────────────────────

/** A spec dir is complete (don't resume) if it has a `.complete` marker. */
export function isComplete(specDir: string): boolean {
	return existsSync(join(specDir, COMPLETE_FILE));
}

/** Resumable = has a non-empty cache AND no completion marker. */
export function isResumable(specDir: string): boolean {
	if (isComplete(specDir)) return false;
	try {
		const raw = readFileSync(resumeCachePath(specDir), "utf8");
		return raw.trim().length > 0;
	} catch {
		return false;
	}
}

/** Find the most-recent resumable spec identifier in cwd (worktree dirs first,
 *  then in-place). Returns undefined if none. */
export function findResumableSpec(cwd: string): string | undefined {
	const candidates: Array<{ id: string; mtime: number }> = [];
	const consider = (specDir: string, id: string) => {
		if (isResumable(specDir)) {
			try {
				candidates.push({ id, mtime: statSync(resumeCachePath(specDir)).mtimeMs });
			} catch { /* ignore */ }
		}
	};
	// worktree-based specs: <cwd>/.worktree/<id>/docs/specifications/<id>
	const wtRoot = join(cwd, ".worktree");
	if (existsSync(wtRoot)) {
		for (const id of readdirSync(wtRoot)) consider(specDirFor(cwd, id), id);
	}
	// in-place specs (skipWorktree runs): <cwd>/docs/specifications/<id>
	const specsRoot = join(cwd, "docs", "specifications");
	if (existsSync(specsRoot)) {
		for (const id of readdirSync(specsRoot)) consider(`${join(specsRoot, id)}/`, id);
	}
	if (candidates.length === 0) return undefined;
	candidates.sort((a, b) => b.mtime - a.mtime);
	return candidates[0].id;
}

// ─── the memoizing agent wrapper (testable) ──────────────────────────────────

/**
 * Wrap a real agent executor with a resume-cache memoizer. `seq` is a monotonic
 * counter incremented at every invocation; the cache key is `<callId>#<seq>`.
 * Invocation order is deterministic (the workflow's `parallel()` shifts from a
 * FIFO queue in single-threaded JS), so `seq` matches on replay — even for
 * loop iterations whose call.id repeats (e.g. the verify-loop's code-review).
 * Always WRITES results (so any run is resumable); READS (memoizes) only when the
 * cache was pre-loaded (resume). `getSpecDir` is lazy because `state.setup` is
 * only populated after the setup stage runs.
 */
export function createMemoizingAgent(
	realAgent: (call: AgentCall) => Promise<AgentResult>,
	cache: Map<string, AgentResult>,
	getSpecDir: () => string,
	log?: (m: string) => void,
): (call: AgentCall) => Promise<AgentResult> {
	let seq = 0;
	return async (call: AgentCall): Promise<AgentResult> => {
		const key = `${call.id ?? "agent"}#${++seq}`;
		const hit = cache.get(key);
		if (hit) {
			log?.(`resumed (cached): ${call.id ?? key}`);
			return hit;
		}
		const result = await realAgent(call);
		cache.set(key, result);
		appendResumeResult(getSpecDir(), key, result);
		return result;
	};
}
