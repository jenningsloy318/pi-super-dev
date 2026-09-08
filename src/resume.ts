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
import { extractControl } from "./control.ts";

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

/** Append one completed agent-call result to the cache log (crash-safe).
 *  R8 (AC-21 fix-in-pass): torn-line repair — when the file is non-empty and
 *  its last byte is NOT a newline (a killed process left a half-written row),
 *  write "\n" FIRST so the fresh row cannot glue onto the fragment (which
 *  would lose BOTH). The torn entry is lost by design; the next good entry is
 *  saved. Mirrors the runlog's tailProbe healing. */
export function appendResumeResult(specDir: string, key: string, result: AgentResult): void {
	try {
		const path = resumeCachePath(specDir);
		try {
			const st = statSync(path);
			if (st.size > 0) {
				const buf = readFileSync(path);
				if (buf.length > 0 && buf[buf.length - 1] !== 0x0a) appendFileSync(path, "\n");
			}
		} catch { /* absent/empty — nothing to repair */ }
		appendFileSync(path, JSON.stringify({ key, result }) + "\n");
	} catch { /* best-effort; resume is opportunistic */ }
}

/** Load the cache as a Map (last value wins per key; a partial trailing line is ignored).
 *  R8: one `console.warn("[resume] skipping unparseable cache line")` per
 *  skipped corrupt line — silent data loss is undiagnosable. */
/** v0.3.83 r2 (adv-F4): ensure the cache file exists and is non-empty even
 *  when nothing was persistable — an all-pure-failure pass previously left NO
 *  file, so isResumable (non-empty check) and findReusableSpec skipped the
 *  track and the infra-healed retry had nothing to resume. The tombstone is
 *  inert: a parseable, error-free row under a key no call ever mints. */
export function ensureResumeCacheTombstone(specDir: string): void {
	try {
		const st = statSync(resumeCachePath(specDir));
		if (st.size > 0) return; // a real row (or an earlier tombstone) is already there
	} catch { /* absent — fall through and create */ }
	try {
		appendResumeResult(specDir, "__tombstone__@boot#1", { text: "", control: null });
	} catch { /* best-effort; resume is opportunistic */ }
}

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
			console.warn("[resume] skipping unparseable cache line");
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
 * Wrap a real agent executor with a resume-cache memoizer. The cache key is
 * the call's STRUCTURAL position — `callId@scopePath#occurrence` — NOT a
 * sequential invocation counter. Structural identity is order-independent:
 * `parallel`/`map` push a scope marker per branch/iteration (via ctx.withScope
 * → AsyncLocalStorage), so concurrent branches get distinct keys regardless of
 * which `ctx.agent` fires first. This is the fix for BUG-1: the old `++seq`
 * counter was only incidentally deterministic (it held iff `ctx.agent` was the
 * first await in every parallel branch — a fragile invariant).
 *
 * `occurrence` is scoped to (callId, scopePath): it disambiguates repeated
 * calls at the same structural position (loop iterations, gate re-runs), which
 * are sequential within their scope and thus deterministic. Always WRITES
 * results (so any run is resumable); READS (memoizes) only when the cache was
 * pre-loaded (resume). `getSpecDir` is lazy because `state.setup` is only
 * populated after the setup stage runs. `getScope` defaults to [] (root) so
 * callers/tests that don't thread scopes still get deterministic `@root#N` keys.
 */
export function createMemoizingAgent(
	realAgent: (call: AgentCall) => Promise<AgentResult>,
	cache: Map<string, AgentResult>,
	getSpecDir: () => string,
	log?: (m: string) => void,
	getScope: () => string[] = () => [],
): (call: AgentCall) => Promise<AgentResult> {
	const occ = new Map<string, number>();
	// NOTE (F3 design decision): the occurrence counter is deliberately NOT
	// seeded from the cache. The old replay behavior is CORRECT for state
	// rebuild — a resumed loop replays rounds 1..k as cache hits, deterministically
	// reconstructing retry feedback + convergence-ledger state, and the k+1-th
	// call mints #k+1 → cache miss → FRESH. The bug that killed resumes (runs
	// 2026-08-17T02-47-14-024Z / 06-02-59-538Z) was the loop's round cap firing
	// AFTER the replay but BEFORE round k+1 could run — fixed in the convergence
	// loops via countStageRounds(), not here. Seeding here would skip the replay
	// (state never rebuilt) and lose feedback continuity.
	return async (call: AgentCall): Promise<AgentResult> => {
		const id = call.id ?? "agent";
		const scope = getScope().join("/") || "root";
		const occKey = `${id}\u0000${scope}`;
		const n = (occ.get(occKey) ?? 0) + 1;
		occ.set(occKey, n);
		const key = `${id}@${scope}#${n}`;
		const hit = cache.get(key);
		if (hit) {
			// v0.3.48 poisoned-row recovery: a cached row whose ONLY defect was a
			// control-extraction failure (the result carries text + an error + no
			// control) is re-extracted with the CURRENT parser before any other
			// decision. The 2026-08-31 cosmic-clock incident cached a 22-minute review
			// whose JSON had two unescaped inner quotes; re-extraction at replay time
			// converts such rows into successes the moment the parse boundary
			// improves — no manual cache surgery needed.
			// v0.3.83 r2 (adv-F1): the gate is ANY error row, including
			// error+control rows. delegation-backend.ts:505/:508 return the FIRST
			// attempt's control alongside a corrective-retry error — that control
			// was certified invalid by the engine (missing keys / schema
			// violations; that is why the corrective fired), so replaying it
			// verbatim is poison that escapes both the v0.3.65 agent-error marking
			// (needs error && !control) and this degrade path (previously needed
			// control == null). Text recovery runs first; the stale control is
			// discarded, never replayed.
			if (hit.error) {
				if (hit.text) {
					// v0.3.54 (F6 wiring): the recovery extraction gets the call's declared
					// keys so the fallback-object guard can reject a WRONG object instead of
					// replaying it as this call's control.
					const recovered = extractControl(hit.text, call.controlKeys);
					if (recovered != null) {
						log?.(`resumed (cached): ${call.id ?? key} — control RECOVERED from cached text (parse boundary improved since the original attempt)`);
						return { ...hit, control: recovered, error: undefined };
					}
				}
				// v0.3.83 (incident 2026-09-08, spec 25 run 13-21-29-124Z): never
				// replay an unrecoverable agent error. A cached error is replayed
				// verbatim forever while the live environment may long have healed —
				// restarts, quota resets, and exclusion-store deletions are invisible
				// to this Map, and the replay makes zero model calls so nothing ever
				// self-corrects. Treat the row as a miss and re-run live; the fresh
				// row shadows the error row in the append-only, last-wins log.
				log?.(`resumed (cached): ${call.id ?? key} — cached agent error NOT replayed; re-running live (infrastructure may have healed)`);
			} else {
				log?.(`resumed (cached): ${call.id ?? key}`);
				return hit;
			}
		}
		const result = await realAgent(call);
		// v0.3.83 write side: a pure failure (error, no control, no body text)
		// carries no replayable value — never persist it, so the next resume
		// retries the call live instead of replaying the failure. Errors WITH
		// body text stay cacheable: they preserve the v0.3.48 recovery chance
		// for the CURRENT parser (a row that recovers replays for free); while
		// the text stays unrecoverable the row still degrades to ONE live re-run
		// per resume (adv-F3: bounded, honest liveness-over-cost) until a
		// success shadows it.
		// v0.3.83 r2 (adv-F1): a control riding an error (delegation-backend
		// :505/:508) is the FIRST attempt's schema-violating object — strip it
		// from the PERSISTED copy only; the live caller keeps the original
		// result so the read-side paths above (recovery → miss) own its replay.
		const persistRow = result.error != null && result.control != null ? { ...result, control: null } : result;
		const persistable = !(persistRow.error != null && persistRow.control == null && !(persistRow.text && persistRow.text.trim().length > 0));
		if (persistable) {
			cache.set(key, persistRow);
			appendResumeResult(getSpecDir(), key, persistRow);
		} else {
			// v0.3.83 r2 (adv-F4): a pass whose every call pure-fails would never
			// create the cache file — isResumable/findReusableSpec then skip the
			// track and the quota-healed retry has nothing to resume. Touch an
			// inert tombstone row once (parseable, error-free, no call key ever
			// collides with "__tombstone__@boot") so the track stays discoverable.
			ensureResumeCacheTombstone(getSpecDir());
		}
		return result;
	};
}

/** F3: how many rounds (occurrences) of `callId` the PERSISTED cache already
 *  records SUCCESSFULLY — across all scopes (max #N per exact `callId@scope`,
 *  then max). Convergence loops use this to grant a resumed run a fresh round
 *  budget: effectiveCap = min(prior + cap, 3 × cap). A converged stage replays
 *  its j prior rounds and approves at round j ≤ cap (never needs the
 *  extension); a stage that exhausted its cap replays k rounds and gets k+1..
 *  fresh.
 *  v0.3.83 r2 (adv-F2): ERROR rows are holes, not banked work — the read side
 *  degrades every cached error to a LIVE re-run, so counting them as prior
 *  would (a) stretch the replay window with rows that no longer replay and
 *  (b) hide those live re-runs from the fresh-round gates (`round >
 *  priorRounds` — the v0.3.65 consecutive-agent-error fuse and the budget
 *  extension), letting a poisoned k-round cache re-spend k uncounted live
 *  calls per resume while infra stays down. Excluded here, error rounds
 *  re-execute as FRESH rounds: counted by the fuse, bounded by the cap. */
export function countStageRounds(specDir: string, callId: string): number {
	const perScope = new Map<string, number>();
	try {
		const raw = readFileSync(resumeCachePath(specDir), "utf8");
		for (const line of raw.split("\n")) {
			const trimmed = line.trim();
			if (!trimmed) continue;
			try {
				const entry = JSON.parse(trimmed) as { key?: string; result?: { error?: string } };
			if (entry?.result?.error != null) continue; // v0.3.83 r2: error rounds are holes, not banked work
			const m = entry?.key ? new RegExp(`^${callId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}@(\\S+)#(\\d+)$`).exec(entry.key) : null;
				if (!m) continue;
				const n = Number.parseInt(m[2] ?? "0", 10);
				if (Number.isFinite(n) && n > (perScope.get(m[1] ?? "") ?? 0)) perScope.set(m[1] ?? "", n);
			} catch { /* partial/corrupt line — skip */ }
		}
	} catch {
		return 0; // no cache → fresh run
	}
	return perScope.size > 0 ? Math.max(...perScope.values()) : 0;
}
