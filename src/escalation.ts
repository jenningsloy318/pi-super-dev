/**
 * Escalation budget + retry-decision helpers (spec-18 / AC-01, AC-05, AC-10).
 *
 * `ESCALATION_RETRY_CAP` bounds per-blocker retries so a stuck user can never
 * drive the run into an infinite pause-ask-continue loop (guaranteed
 * termination + bounded spend). `runEscalation` fires the inline `escalate`
 * callback under that budget with a FULL never-throw guard — no callback, an
 * exhausted budget, or a throwing callback all collapse to `undefined` (the
 * pre-existing fail-with-report path). `applyRetryDecision` composes the
 * retry-with-guidance recovery: worktree-scoped rollback + persisted guidance.
 *
 * All exports are never-throw (AC-10 / SCENARIO-012). Per-blocker retry counts
 * live on `state.__escalationRetries`, keyed by `failure.kind`.
 */

import type { Escalate, EscalationDecision, EscalationFailure, PipelineState } from "./types.ts";
import { rollbackWorktreeTo } from "./tracking.ts";
import { appendUserNotes } from "./render/user-notes.ts";

/** Per-blocker retry cap. Guarantees termination + bounded spend (AC-01). */
export const ESCALATION_RETRY_CAP = 2;

/** Per-blocker retry counters (`state.__escalationRetries`), keyed by kind. */
interface EscalationRetryMap {
	[kind: string]: number;
}

/** Read (lazily creating) the per-blocker retry map on state. */
function retryMap(state: PipelineState): EscalationRetryMap {
	const existing = (state as Record<string, unknown>).__escalationRetries;
	if (existing && typeof existing === "object") {
		return existing as EscalationRetryMap;
	}
	const created: EscalationRetryMap = {};
	(state as Record<string, unknown>).__escalationRetries = created;
	return created;
}

/** Budget key for a blocker. Keyed by kind AND stage (F-3): two structurally
 *  distinct fatal gates (e.g. requirements vs spec) both use kind
 *  "gate-exhaustion", so keying by kind alone let the first gate's retries starve
 *  the second gate's escalation entirely. Including `stage` (which carries the
 *  gate's feedbackKey / stage name) gives each named failure site its own budget. */
function budgetKey(failure: EscalationFailure): string {
	return `${failure.kind}:${failure.stage ?? ""}`;
}

/**
 * Remaining retries for the blocker described by `failure` (floored at 0).
 * Reads `state.__escalationRetries[budgetKey(failure)]`.
 */
export function escalationBudgetRemaining(state: PipelineState, failure: EscalationFailure): number {
	const used = retryMap(state)[budgetKey(failure)] ?? 0;
	return Math.max(0, ESCALATION_RETRY_CAP - used);
}

/**
 * Fire the inline escalate callback under the per-blocker budget.
 *
 * - no `escalate` callback ⇒ `undefined` (additive baseline — byte-identical).
 * - budget exhausted ⇒ `undefined` AND `escalate` is NOT invoked.
 * - `escalate` throws / dismisses ⇒ `undefined` (never propagates).
 * - `escalate` resolves a decision ⇒ that decision, and the blocker's retry
 *   count on `state.__escalationRetries` is incremented.
 */
export async function runEscalation(
	state: PipelineState,
	failure: EscalationFailure,
	escalate?: Escalate,
): Promise<EscalationDecision | undefined> {
	if (!escalate) return undefined;
	if (escalationBudgetRemaining(state, failure) <= 0) return undefined;
	// Charge the budget BEFORE awaiting so even a throwing/dismissed callback
	// counts toward termination (guaranteed bounded spend).
	retryMap(state)[budgetKey(failure)] = (retryMap(state)[budgetKey(failure)] ?? 0) + 1;
	try {
		return await escalate(failure);
	} catch {
		return undefined;
	}
}

/**
 * Apply a retry-with-guidance decision: roll the worktree back to its
 * pre-stage baseline (`rollbackWorktreeTo`) and persist the user's guidance into
 * `.user-notes.json` (`appendUserNotes`) so the next specialist attempt sees it.
 *
 * Composes two never-throw primitives, so this too never throws. Non-retry
 * choices are a safe no-op (rollback only makes sense when re-running).
 */
export function applyRetryDecision(
	state: PipelineState,
	decision: EscalationDecision,
	opts: { worktreePath?: string; specDirectory?: string },
): void {
	void state;
	if (decision.choice !== "retry-with-guidance") return;
	try {
		rollbackWorktreeTo(opts.worktreePath);
		const guidance = decision.guidance?.trim();
		if (guidance) {
			appendUserNotes(opts.specDirectory, [guidance]);
		}
	} catch {
		/* never-throw: both primitives already guard; this is belt-and-braces. */
	}
}
