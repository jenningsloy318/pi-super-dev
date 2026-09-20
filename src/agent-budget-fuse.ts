/**
 * v0.4.57 — the AGENT-BUDGET terminal marker (the spawn-budget sibling of the
 * wall-fuse, v0.3.85 F3).
 *
 * The corpus context (runs 2026-09-09, 2026-09-14, 2026-09-19): a run that
 * consumes its whole `maxAgents` spawn budget mid-pipeline currently records
 * every remaining stage as `failed` with `budget exhausted before stage start`
 * (nodes.ts task()) and ends a generic partial — indistinguishable, at the
 * terminal-state level, from a bug-class failure. The wall fuse already has
 * the right shape: a first-trip state marker that deriveRunStatus maps to the
 * terminal state `partial (wall-fuse)` — resumable BY DESIGN, deliberately
 * DISTINCT from FatalAbort — with a fresh window per resumed pass.
 *
 * This module mirrors that pattern for the spawn budget: when the stage-start
 * `ctx.budget.check()` first fails, nodes.ts stamps `__agentBudget` (first
 * trip wins) and deriveRunStatus derives `partial (agent-budget)` with the
 * fresh-budget resume note. A budget-blocked cascade is a BOUNDED-BY-DESIGN
 * outcome, never a bug class; a fully-converged run still reads success.
 *
 * Pure helpers only — no spawns, no fs, never throws (P5).
 */

/** PipelineState key holding the first-trip marker (read by deriveRunStatus). */
export const RUN_AGENT_BUDGET_MARKER = "__agentBudget";

export interface AgentBudgetMarker {
	trippedAt: number;
	/** The first stage id whose start found the budget exhausted. */
	stageId: string;
	/** Reservations consumed at trip time (== the maxAgents cap). */
	consumed: number;
}

/** First trip wins (provenance — same rule as the wall-fuse marker): an
 * already-set marker is never overwritten. */
export function markAgentBudgetExhausted(state: { [key: string]: unknown }, stageId: string, consumed: number, now: number = Date.now()): AgentBudgetMarker {
	const existing = state[RUN_AGENT_BUDGET_MARKER] as AgentBudgetMarker | undefined;
	if (existing && typeof existing === "object") return existing;
	const marker: AgentBudgetMarker = { trippedAt: now, stageId, consumed };
	state[RUN_AGENT_BUDGET_MARKER] = marker;
	return marker;
}

export function readAgentBudgetMarker(state: { [key: string]: unknown }): AgentBudgetMarker | undefined {
	const m = state[RUN_AGENT_BUDGET_MARKER] as AgentBudgetMarker | undefined;
	return m && typeof m === "object" ? m : undefined;
}

/** The deriveRunStatus reason line (honest numbers + the resume semantics). */
export function agentBudgetStatusReason(marker: AgentBudgetMarker): string {
	return `partial (agent-budget): the spawn budget was exhausted (${marker.consumed} agent calls, maxAgents) before stage "${marker.stageId}" could start — bounded by design: converged stages are committed and a resumed pass continues with a FRESH budget (raise the maxAgents tool option for larger specs)`;
}
