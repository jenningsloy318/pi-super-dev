/**
 * 059 R1A D-R-B(g) — the R4 excess-exemption signal's convergence-loop
 * consumer. docs/requirements/059-reviewer-quality-architecture.md §3 R4.
 *
 * When enforceReviewerConvergenceDuty reports >1 evidence-pair-eligible
 * finding in one review round, the async loop (artifact-convergence.ts /
 * spec-convergence.ts) consumes the flag at the ROUND BOUNDARY and calls the
 * judge with scope "stage9.contract-conflict" and allowedRoutes EXACTLY
 * ["replan-upstream"] ('route-back' is a RoutingAction, not a JudgeRoute —
 * the verdict maps via classifyJudgeRoute("replan-upstream") → route-back).
 *
 * Consumer execution policy for escalate-now: runJudgeInner unconditionally
 * appends "escalate-now" to allowedRoutes, so 'never escalate-now' means the
 * LOOP refuses to execute the FatalAbort branch on that verdict FOR THIS
 * TRIGGER — it routes back upstream (inline route-back jump) or degrades
 * honestly (records the signal as a non-blocking convergence finding) instead
 * (delta-2 folds ix/x; blocker-storm fuse preserved, HIGH-4).
 */

import type { ControlObj, PipelineState, StageContext } from "../types.ts";
import { runJudge } from "../stages/judge.ts";
import { planInlineRouteBack } from "../routing/walker.ts";
import { RouteBackSignal } from "../routing/router.ts";
import { CONVERGENCE_OWNER_STAGES, recordConvergenceFindings } from "../convergence-ledger.ts";

export const CONTRACT_CONFLICT_SCOPE = "stage9.contract-conflict";

function degradeHonest(ctx: StageContext, state: PipelineState, from: string, reason: string): void {
	ctx.log(`${from} convergence: contract-conflict signal DEGRADED (no FatalAbort on this trigger — 059 §3 R4) — ${reason}`);
	recordConvergenceFindings(state, [{
		id: `contract-conflict-${from}`,
		title: "evidence-pair exemption bound exceeded (contract-conflict signal)",
		detail: `${reason} — the exempt cross-artifact findings remain blocking in the review; this row is the honest non-blocking record of the escalation attempt (059 §3 R4 consumer policy).`,
		severity: "medium",
		blocking: false,
		status: "open",
		evidence: [reason],
	}], { detectedAtStage: from, ownerStage: CONVERGENCE_OWNER_STAGES.find((s) => s === from), sourceGate: CONTRACT_CONFLICT_SCOPE });
}

/** Consume the escalateToJudge flag at the round boundary. Never throws
 *  except RouteBackSignal (the replan-upstream route-back jump). */
export async function consumeContractConflictEscalation(args: {
	ctx: StageContext;
	state: PipelineState;
	/** The convergence loop's feedback key (e.g. "bdd" / "spec"). */
	from: string;
	/** The review control the duty layer just enforced. */
	reviewControl: ControlObj | undefined;
	/** exemptCount from the duty result (>1 is why we are here). */
	exemptCount: number;
}): Promise<void> {
	const { ctx, state, from, reviewControl } = args;
	const findings = (Array.isArray(reviewControl?.findings) ? reviewControl!.findings : []) as Array<Record<string, unknown>>;
	const exemptRows = findings.filter((f) => f.evidencePairExempt === true);
	ctx.log(`${from} convergence: evidence-pair exemption bound exceeded (${args.exemptCount} eligible, bound = 1) — routing the contract-conflict signal to the judge (059 §3 R4)`);
	try {
		const out = await runJudge(ctx, {
			scope: CONTRACT_CONFLICT_SCOPE,
			signature: `contract-conflict:${from}:exempt-${args.exemptCount}`,
			worktreePath: state.setup?.worktreePath ?? "",
			specDirectory: state.setup?.specDirectory,
			context: [
				"## Cross-artifact contract conflict — more than one evidence-pair-qualified finding in one review round",
				"The deterministic convergence-duty layer verified these findings against disk loci and the stage's injected contract-surface slice; the bound (≤1 exempt finding per round) was exceeded, which is a contract-conflict SIGNAL, not a call.",
				...exemptRows.map((f) => `- ${String(f.id ?? "finding")}: ${String(f.title ?? "")} — ${String(f.detail ?? "").slice(0, 300)}`),
				"",
				"Adjudicate whether the upstream artifacts/plan must be revised so the shared-surface contract is consistent (route replan-upstream). escalate-now is NOT executable for this trigger — the consumer refuses to abort on it (059 §3 R4).",
			].join("\n"),
			allowedRoutes: ["replan-upstream"],
		});
		const verdict = out.status === "routed" || out.status === "escalate" ? out.verdict : undefined;
		if (verdict?.route === "replan-upstream") {
			// classifyJudgeRoute("replan-upstream") → route-back: execute ONLY as
			// the loop-native inline route-back jump (triggerReplanForFindings is
			// pinned OUT of the convergence loops — tests/verify.test.ts).
			const cmd = planInlineRouteBack(state.setup?.specDirectory, from, exemptRows.map((f) => ({ id: String(f.id ?? ""), ownerStage: typeof f.ownerStage === "string" ? f.ownerStage : undefined, blocking: true, title: String(f.title ?? "") })));
			if (cmd) {
				ctx.log(`${from} convergence: judge replan-upstream — INLINE route-back ${cmd.from}→${cmd.to} (contract-conflict) — throwing RouteBackSignal for the walker`);
				throw new RouteBackSignal(cmd);
			}
			degradeHonest(ctx, state, from, `judge routed replan-upstream but the inline route-back declined (owner geometry or budget) — upstream revision is operator-available via the normal replan route`);
			return;
		}
		if (verdict?.route === "escalate-now") {
			// CONSUMER REFUSAL (059 §3 R4): the judge may RETURN escalate-now (it is
			// always in the allowed set), but this consumer NEVER executes the
			// FatalAbort branch for the contract-conflict trigger.
			degradeHonest(ctx, state, from, `judge verdict escalate-now REFUSED for the contract-conflict trigger — no FatalAbort on this route (059 §3 R4)`);
			return;
		}
		degradeHonest(ctx, state, from, out.status === "degraded" || out.status === "discarded" ? `judge ${out.status} (${out.reason})` : `judge verdict ${String(verdict?.route ?? "none")}`);
	} catch (err) {
		if (err instanceof RouteBackSignal) throw err;
		degradeHonest(ctx, state, from, `judge call failed (${err instanceof Error ? err.message : String(err)})`);
	}
}
