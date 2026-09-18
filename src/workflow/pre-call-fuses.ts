import { appendRunEvent, ledgerRunId } from "../runlog.ts";
import { runWallFusePreCallError, type RunWallFuseState } from "../wall-fuse.ts";
import { usageFuseError } from "./usage-accounting.ts";
import type { Budget, AgentCall, PipelineState, UsageAccumulator } from "../types.ts";

export interface PreCallFuseInput {
	state: PipelineState;
	call: AgentCall;
	budget: Budget;
	wallFuse: RunWallFuseState;
	usage: UsageAccumulator;
	log: (m: string) => void;
}

/** Wave 2 increment 5: the pre-call fuse chain (spawn budget → run wall fuse →
 *  cost/token fuse), an adjudicator extracted from realAgent verbatim — one
 *  reason to change: run-level spend bounds. Every tripped fuse lands ONE
 *  agent.called ledger row (backend "n/a", the honest error) and the call is
 *  not launched; null means the call may proceed. */
export function preCallFuseError(input: PreCallFuseInput): string | null {
	const { state, call, budget, wallFuse, usage, log } = input;
	// BUG-4: atomic reservation — bail BEFORE doing any work when the cap is hit,
	// so concurrent branches can't exceed maxAgents. (Stage bodies still peek
	// `check()` to avoid constructing a prompt when obviously over budget.)
	if (!budget.spent()) {
		appendRunEvent(state.setup?.specDirectory, {
			runId: ledgerRunId(state),
			agent: call.agent,
			stage: (call.id ?? "").replace(/^pipeline\./, ""),
			type: "agent.called",
			data: { agent: call.agent, backend: "n/a", durationMs: 0, error: "budget exhausted (maxAgents reached)" },
		});
		return "budget exhausted (maxAgents reached)";
	}
	// v0.3.85 F3 (decision 2): run wall fuse at the SAME pre-call seam as the
	// spawn budget above — other stages' convergence loops see the fuse here,
	// fail-closed with an honest error naming the numbers (zero further agent
	// spend; the deterministic wind-down + close-out still run). The state
	// marker this stamps is what deriveRunStatus maps to `partial (wall-fuse)`.
	const wallFuseError = runWallFusePreCallError(wallFuse, state);
	if (wallFuseError) {
		log(`agent ${call.id ?? call.agent}: ${wallFuseError}`);
		appendRunEvent(state.setup?.specDirectory, {
			runId: ledgerRunId(state),
			agent: call.agent,
			stage: (call.id ?? "").replace(/^pipeline\./, ""),
			type: "agent.called",
			data: { agent: call.agent, backend: "n/a", durationMs: 0, error: wallFuseError },
		});
		return wallFuseError;
	}
	// v0.3.68 F10-1 (D6 方案 A): cost/token fuse — same pre-call shape as the
	// spawn budget above. The call is not launched; the honest error names the
	// fuse and the numbers; consecutive fuse rows FatalAbort via v0.3.65
	// (deterministic wind-down, no hard abort — plan §6.1).
	const fuseError = usageFuseError(usage, log);
	if (fuseError) {
		log(`agent ${call.id ?? call.agent}: ${fuseError}`);
		appendRunEvent(state.setup?.specDirectory, {
			runId: ledgerRunId(state),
			agent: call.agent,
			stage: (call.id ?? "").replace(/^pipeline\./, ""),
			type: "agent.called",
			data: { agent: call.agent, backend: "n/a", durationMs: 0, error: fuseError },
		});
		return fuseError;
	}
	return null;
}
