/** rounds — the round-cap constants and strict-progress extension arithmetic (split from artifact-convergence.ts at v0.4.17e). */
/** F2 (RC1, run 2026-08-17T02-16-49-478Z): one bounded extension when the loop
 *  is still making STRICT progress at the cap. Research grounding — Refine-n-Judge
 *  (arXiv 2508.01543) and verification-loop practice: a hard cap alone kills
 *  loops that resolve prior findings every round but keep meeting one NEW
 *  reviewer finding; strict-progress detection (open-blocking count strictly
 *  decreasing) separates those from true stalls. */

export const PROGRESS_EXTENSION_ROUNDS = 4;
/** F3: hard cumulative ceiling — replayed + fresh rounds across resumes. Each
 *  resume grants maxRounds fresh rounds (durable-execution continuation), but
 *  the total is bounded at 3× the base cap so a deterministic false-positive
 *  gate cannot ping-pong forever (replan/HITL owns the terminal state by then). */
export const MAX_TOTAL_ROUND_MULTIPLE = 3;

export function effectiveRoundCap(maxRounds: number, priorRounds: number): number {
	return Math.min(priorRounds + maxRounds, maxRounds * MAX_TOTAL_ROUND_MULTIPLE);
}

/** AC-17 (SCENARIO-037): the one-shot strict-progress extension, re-clamped to
 *  the 3× cumulative ceiling — effectiveCap can NEVER exceed maxRounds × 3
 *  (from 10 it yields 14; from 22 or 24 it yields 24; never 28). */
export function extendedRoundCap(effectiveCap: number, maxRounds: number): number {
	return Math.min(effectiveCap + PROGRESS_EXTENSION_ROUNDS, maxRounds * MAX_TOTAL_ROUND_MULTIPLE);
}
