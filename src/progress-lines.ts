/**
 * Shared progress-line formatting for all three agent backends (v0.3.28).
 *
 * Before v0.3.28 the delegation backend logged only the bare current tool
 * name (run.log under agentBackend pi-subagents degraded to
 * `requirements-clarifier: ls` lines), while session logged `→ tool args` +
 * TUI-only narration and subprocess logged `→ summary` + unprefixed
 * narration — and NO backend logged a terminal usage summary even though
 * every execution path HAS the data (session.messages assistant entries and
 * the child's message_end both carry full usage; the delegation terminal
 * response carries SubagentDelegationUsage).
 *
 * v0.3.28 unifies the surface so run.log reads uniformly regardless of the
 * selected backend:
 *   - tool lines:   `<label>: → tool args…`
 *   - narration:    `<label>: ⇢ <one line>`
 *   - terminal:     `<backend> <label>: completed status=completed model=…
 *                    turns=N tools=N tokens=in/out cache=r/w $cost duration=Xs`
 */

/** v0.3.28: live usage accounting shared by the subprocess loops (pi-spawn.ts)
 *  and the RPC driver (message_end events never reach onRawEvent — the driver
 *  intercepts them, so it accumulates its own copy). */
export interface LiveUsageStats {
	model?: string;
	toolCalls: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
}

export function newUsageStats(): LiveUsageStats {
	return { toolCalls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
}

export function accumulateUsage(stats: LiveUsageStats, u: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; cost?: { total?: number } } | undefined): void {
	if (!u) return;
	stats.input += u.input ?? 0;
	stats.output += u.output ?? 0;
	stats.cacheRead += u.cacheRead ?? 0;
	stats.cacheWrite += u.cacheWrite ?? 0;
	stats.cost += u.cost?.total ?? 0;
}

export interface AgentUsageSummary {
	model?: string;
	turns?: number;
	toolCalls?: number;
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	cost?: number;
	durationMs?: number;
}

/** The terminal summary line. Segments are included only when their data is
 *  present, so a missing usage object degrades to a plain status line. */
export function agentTerminalLine(backend: "session" | "subprocess" | "delegation", label: string, status: string, info: AgentUsageSummary): string {
	const word = status === "completed" ? "completed" : "terminal";
	const segs = [`${backend} ${label}: ${word} status=${status}`];
	if (info.model) segs.push(`model=${info.model}`);
	if (typeof info.turns === "number") segs.push(`turns=${info.turns}`);
	if (typeof info.toolCalls === "number") segs.push(`tools=${info.toolCalls}`);
	if (typeof info.input === "number" && typeof info.output === "number") segs.push(`tokens=${info.input}/${info.output}`);
	if (typeof info.cacheRead === "number" && typeof info.cacheWrite === "number") segs.push(`cache=${info.cacheRead}/${info.cacheWrite}`);
	if (typeof info.cost === "number" && info.cost > 0) segs.push(`$${info.cost.toFixed(4)}`);
	if (typeof info.durationMs === "number") segs.push(`duration=${(info.durationMs / 1000).toFixed(1)}s`);
	return segs.join(" ");
}

/** Diff a narration window into lines not yet logged (each narration line
 *  reaches run.log exactly once across progress ticks). */
export function newNarrationLines(lines: string[], previous: string[]): string[] {
	return lines.filter((l) => l.trim().length > 0 && !previous.includes(l));
}
