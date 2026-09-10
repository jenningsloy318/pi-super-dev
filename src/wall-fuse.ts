/**
 * v0.3.85 F3 (C5 fix — bounded time; §9 F3 + §10 decision 2 of
 * docs/requirements/run-2026-09-09-poisoned-baseline-postmortem-v0.3.85.md):
 * the GLOBAL RUN WALL FUSE.
 *
 * `SUPER_DEV_MAX_RUN_WALL_MS` (default 14_400_000 = 4h; `0` disables) bounds
 * WALL per run-pass — ONE fresh window per runWorkflow invocation, so a
 * resumed pass gets a FRESH fuse window (the fuse bounds the pass, never the
 * spec: long work = bounded units + sequential composition, fuse →
 * checkpoint-commit → resume next run).
 *
 * Surfaced exactly like the spawn budget: the window is created once per
 * context in makeContext (`ctx.wallFuse`, mirroring `ctx.budget`), checked at
 * the SAME pre-call seam in realAgent (other stages' convergence loops see the
 * fuse there, fail-closed, with an honest error naming the numbers), and wound
 * down ONLY at implementer-attempt / phase boundaries — never mid-write; an
 * in-flight attempt runs to its own completion/timeout (overshoot bounded by
 * one attempt timeout).
 *
 * Wind-down (decision 2): before each new implementer attempt and at each
 * phase boundary, when the remaining budget is below the trailing-3-attempt
 * MEDIAN duration no new attempt starts. Green phases keep their existing
 * deterministicPhaseCommit (checkpoint-commit); resume-cache rows are written
 * normally (resume stays deterministic). The run's TERMINAL STATE is
 * `partial (wall-fuse)` — resumable BY DESIGN and deliberately DISTINCT from
 * FatalAbort (bug class): deriveRunStatus maps the `__wallFuse` state marker
 * to a partial run, never a failed one.
 *
 * Pure helpers only — no spawns, no fs, never throws (P5: a broken clock read
 * can never punish the work under review).
 */
import { superDevEnv } from "./render/super-dev-dir.ts";

/** PipelineState key holding the first-trip marker (read by deriveRunStatus). */
export const RUN_WALL_FUSE_MARKER = "__wallFuse";

export interface RunWallFuseMarker {
	trippedAt: number;
	capMs: number;
	reason: string;
}

/** The per-run-pass fuse window (created in makeContext; one per runWorkflow
 *  invocation — a resumed pass starts a NEW window by construction). */
export interface RunWallFuseState {
	startedAt: number;
	tripped: boolean;
	tripReason: string;
}

/** `SUPER_DEV_MAX_RUN_WALL_MS` — lazy env read (defensive rule #5, the
 *  maxReplanRounds pattern in replan/replan.ts). Default 4h (decision 2);
 *  `0` disables the fuse entirely. */
export function runWallFuseMs(): number {
	const n = Number.parseInt(superDevEnv("SUPER_DEV_MAX_RUN_WALL_MS") ?? "", 10);
	if (Number.isFinite(n) && n === 0) return 0;
	return Number.isFinite(n) && n > 0 ? n : 14_400_000;
}

export function freshRunWallFuseState(now: number = Date.now()): RunWallFuseState {
	return { startedAt: now, tripped: false, tripReason: "" };
}

/** First trip wins (provenance): an already-set marker is never overwritten. */
export function markRunWallFuseTripped(state: { [key: string]: unknown }, capMs: number, reason: string, now: number = Date.now()): RunWallFuseMarker {
	const existing = state[RUN_WALL_FUSE_MARKER] as RunWallFuseMarker | undefined;
	if (existing && typeof existing === "object") return existing;
	const marker: RunWallFuseMarker = { trippedAt: now, capMs, reason };
	state[RUN_WALL_FUSE_MARKER] = marker;
	return marker;
}

export function readRunWallFuseMarker(state: { [key: string]: unknown }): RunWallFuseMarker | undefined {
	const m = state[RUN_WALL_FUSE_MARKER] as RunWallFuseMarker | undefined;
	return m && typeof m === "object" ? m : undefined;
}

/** Median of the LAST `n` values — the "trailing-3-attempt median duration"
 *  estimator. Median, not mean: one runaway attempt must not price every later
 *  attempt out of the remaining budget. Null when no samples exist. */
export function trailingMedian(values: readonly number[], n: number): number | null {
	if (values.length === 0 || n <= 0) return null;
	const last = [...values.slice(-n)].sort((a, b) => a - b);
	const mid = Math.floor(last.length / 2);
	return last.length % 2 === 1 ? last[mid]! : Math.round((last[mid - 1]! + last[mid]!) / 2);
}

export interface RunFuseWindDown {
	blocked: boolean;
	why: string;
}

/** The wind-down decision (decision 2): block a new attempt when the run-pass
 *  wall budget is exhausted OR the remaining budget is smaller than the
 *  trailing-3-attempt median duration — an attempt that cannot finish inside
 *  the fuse never starts. Never throws; `now` injectable for tests. */
export function runFuseWindDown(fuse: RunWallFuseState, attemptDurations: readonly number[], now: number = Date.now(), capMs: number = runWallFuseMs()): RunFuseWindDown {
	if (capMs <= 0) return { blocked: false, why: "" };
	const elapsed = now - fuse.startedAt;
	const remaining = capMs - elapsed;
	if (remaining <= 0) {
		return { blocked: true, why: `run wall budget exhausted (elapsed ${elapsed}ms >= SUPER_DEV_MAX_RUN_WALL_MS ${capMs}ms)` };
	}
	const med = trailingMedian(attemptDurations, 3);
	if (med !== null && remaining < med) {
		return { blocked: true, why: `remaining ${remaining}ms < trailing-3-attempt median duration ${med}ms — a new attempt would overrun the fuse` };
	}
	return { blocked: false, why: "" };
}

/** The pre-call seam check (realAgent — the SAME seam as the spawn budget and
 *  the cost/token fuses): returns an honest fail-closed error once the
 *  run-pass wall budget is spent, else null. Also stamps the first-trip state
 *  marker so deriveRunStatus derives the `partial (wall-fuse)` terminal state
 *  regardless of which stage observed the trip. Never throws. */
export function runWallFusePreCallError(fuse: RunWallFuseState, state: { [key: string]: unknown }, now: number = Date.now()): string | null {
	const capMs = runWallFuseMs();
	if (capMs <= 0) return null;
	const elapsed = now - fuse.startedAt;
	if (elapsed < capMs) return null;
	fuse.tripped = true;
	const reason = `run wall budget exhausted (elapsed ${elapsed}ms >= SUPER_DEV_MAX_RUN_WALL_MS ${capMs}ms)`;
	fuse.tripReason = reason;
	markRunWallFuseTripped(state, capMs, `pre-call: ${reason}`, now);
	return `wall fuse tripped: ${reason} — this call was NOT launched. Raise SUPER_DEV_MAX_RUN_WALL_MS (or set 0 to disable) and resume; converged work is committed and a resumed pass gets a FRESH fuse window.`;
}
