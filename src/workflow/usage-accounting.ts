import { superDevEnv } from "../render/super-dev-dir.ts";
import { USAGE_FIELDS } from "../evolution/usage-report.ts";
import type { AgentUsage, UsageAccumulator } from "../types.ts";

/** v0.3.68 F10-1: fresh run-scoped usage accumulator (Anthropic: multi-agent
 * ≈ 15× chat tokens — totals + per-agent splits are the governance surface). */
export function freshUsage(): UsageAccumulator {
	return {
		totals: { calls: 0, turns: 0, toolCalls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, durationMs: 0 },
		byAgent: {},
		byStage: {},
	};
}

export function accumulateUsage(acc: UsageAccumulator, agent: string, u: AgentUsage | undefined, stage?: string): void {
	if (!u) return; // absent usage is never fabricated (P10)
	acc.totals.calls += 1;
	for (const k of USAGE_FIELDS) {
		const v = u[k];
		if (typeof v === "number" && Number.isFinite(v)) acc.totals[k] += v;
	}
	const per = acc.byAgent[agent] ?? { calls: 0, turns: 0, toolCalls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, durationMs: 0 };
	per.calls += 1;
	for (const k of USAGE_FIELDS) {
		const v = u[k];
		if (typeof v === "number" && Number.isFinite(v)) per[k] += v;
	}
	acc.byAgent[agent] = per;
	// v0.3.75 W1: the same bucket keyed by stageKey(call.id) — which STAGE
	// burned the money (user ask 2026-09-07). Absent stage -> "(unlabeled)".
	if (stage != null) {
		const key = stage || "(unlabeled)";
		const st = (acc.byStage ??= {})[key] ?? { calls: 0, turns: 0, toolCalls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, durationMs: 0 };
		st.calls += 1;
		for (const k of USAGE_FIELDS) {
			const v = u[k];
			if (typeof v === "number" && Number.isFinite(v)) st[k] += v;
		}
		acc.byStage![key] = st;
	}
}

/** Structural subset of UsageAccumulator totals (summaries stay
 *  constructible from partial accumulators in tests/tools). */
export interface UsageTotalsView {
	calls: number;
	turns?: number;
	toolCalls?: number;
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	cost?: number;
	durationMs?: number;
}

/** v0.3.68 F10-1: deterministic one-line usage summary (P10 — null when no
 *  usage was ever seen; no fabricated zeros). */
export function summarizeUsage(acc: { totals: UsageTotalsView; byAgent?: unknown }): string | null {
	if (acc.totals.calls === 0) return null;
	const parts = [`calls=${acc.totals.calls}`];
	if (acc.totals.input) parts.push(`input=${acc.totals.input}`);
	if (acc.totals.output) parts.push(`output=${acc.totals.output}`);
	if (acc.totals.turns) parts.push(`turns=${acc.totals.turns}`);
	if (acc.totals.toolCalls) parts.push(`tools=${acc.totals.toolCalls}`);
	if (acc.totals.cost) parts.push(`cost=${Number(acc.totals.cost.toFixed(4))}`);
	return parts.join(" ");
}

/** v0.3.68 F10-1 (plan D6 方案 A): per-call fail-closed cost/token fuse.
 *  Checked BEFORE a call launches; the call that LANDS at/over the cap still
 *  completes and is counted honestly — the NEXT call fails closed naming the
 *  fuse and the spent/limit numbers (mirrors the spawn-budget fuse). The
 *  error rows then flow through the EXISTING deterministic wind-down: v0.3.65
 *  marks them cause:"agent-error" and FatalAborts after 3 consecutive rounds,
 *  so a tripped fuse winds the run down with zero further agent spend and
 *  close-out (summary/audit/metrics) still runs — the reasons 方案 A beat a
 *  hard abort (plan §6.1). */
let fuseCostWarned = false;
let fuseTokensWarned = false;
export function usageFuseError(acc: UsageAccumulator, log: (m: string) => void): string | null {
	const maxCost = superDevEnv("SUPER_DEV_MAX_RUN_COST");
	if (maxCost) {
		const cap = Number(maxCost);
		if (!Number.isFinite(cap)) {
			// v0.3.72 M3 (review F3/ADV-F3): a set-but-unparseable safety control
			// must never disarm silently. Loud WARN once per variable (repo
			// convention: loud fallback, e.g. MAX_RED_RETRIES), calls proceed
			// unlimited — NOT a fake silent limit and NOT a run-killing trip for
			// an operator typo.
			if (!fuseCostWarned) {
				fuseCostWarned = true;
				log(`WARN usage fuse DISABLED: SUPER_DEV_MAX_RUN_COST="${maxCost}" is not a number — set a numeric USD cap (e.g. SUPER_DEV_MAX_RUN_COST=50) or unset it.`);
			}
		} else if (acc.totals.cost >= cap) {
			return `usage fuse tripped: SUPER_DEV_MAX_RUN_COST spent $${acc.totals.cost.toFixed(4)} >= limit $${cap} — this call was NOT launched. Raise SUPER_DEV_MAX_RUN_COST (or unset it) and resume; already-committed work is safe.`;
		}
	}
	const maxTokens = superDevEnv("SUPER_DEV_MAX_RUN_TOKENS");
	if (maxTokens) {
		const cap = Number(maxTokens);
		if (!Number.isFinite(cap)) {
			if (!fuseTokensWarned) {
				fuseTokensWarned = true;
				log(`WARN usage fuse DISABLED: SUPER_DEV_MAX_RUN_TOKENS="${maxTokens}" is not a number — set a numeric token cap (e.g. SUPER_DEV_MAX_RUN_TOKENS=250000) or unset it.`);
			}
		} else if (acc.totals.input + acc.totals.output >= cap) {
			return `usage fuse tripped: SUPER_DEV_MAX_RUN_TOKENS spent ${acc.totals.input + acc.totals.output} tokens (in ${acc.totals.input}/out ${acc.totals.output}) >= limit ${cap} — this call was NOT launched. Raise SUPER_DEV_MAX_RUN_TOKENS (or unset it) and resume; already-committed work is safe.`;
		}
	}
	return null;
}
