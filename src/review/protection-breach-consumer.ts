/**
 * 058 Wave 3 D-B (Layer 2) — the strike-2 protection-breach judge consumer.
 * docs/requirements/058-cross-phase-contract-architecture.md §3 Layer 2 + §4 D-B.
 *
 * Structure mirrored from src/review/contract-conflict-consumer.ts (the
 * 059 R1A consumer whose execution policy this trigger adopts): when the
 * post-join pre-build-gate choke point records the SECOND protected-path
 * write in one phase, the stage calls the judge with scope
 * "stage9.protection-breach" and allowedRoutes EXACTLY
 * ["replan-upstream", "challenge-test"] — a test demanding immutability may
 * itself be the wrong contract; the judge can rule either way.
 *
 * Consumer execution policy for escalate-now: runJudgeInner unconditionally
 * appends "escalate-now" to allowedRoutes, so 'never escalate-now' means this
 * consumer REFUSES to execute the FatalAbort branch on that verdict FOR THIS
 * TRIGGER — it routes the replan circuit upstream (triggerReplanForFindings,
 * the implementation-stage mechanism) or degrades honestly (a non-blocking
 * convergence finding) instead. Never throws; never acquits the breach.
 */

import type { PipelineState, StageContext } from "../types.ts";
import { runJudge } from "../stages/judge.ts";
import { recordConvergenceFindings } from "../convergence-ledger.ts";
import { triggerReplanForFindings } from "../replan/replan.ts";
import { PROTECTION_STRIKE_BOUND, type ProtectionViolation } from "../stages/protection-interval.ts";

export const PROTECTION_BREACH_SCOPE = "stage9.protection-breach";
/** D-B: the judge may rule either way — revise the plan around the
 *  protection, or challenge the protecting test itself. */
export const PROTECTION_BREACH_ALLOWED_ROUTES = ["replan-upstream", "challenge-test"] as const;

export type ProtectionBreachOutcome =
	| { action: "replan-routed"; diagnosis: string }
	| { action: "challenge-test"; diagnosis: string; evidence: string }
	| { action: "degraded"; reason: string };

function degradeHonest(ctx: StageContext, state: PipelineState, phaseId: string, reason: string): ProtectionBreachOutcome {
	ctx.log(`Implementation ${phaseId} protection-breach: strike-2 signal DEGRADED (no FatalAbort on this trigger — 058 §3 Layer 2) — ${reason}`);
	try {
		recordConvergenceFindings(state, {
			id: `protection-breach-${phaseId}`,
			title: "protected-path write exceeded the two-strike bound (protection-breach signal)",
			detail: `${reason} — the violating path(s) were reverted and stay protected; this row is the honest non-blocking record of the escalation attempt (058 §3 Layer 2 consumer policy).`,
			severity: "medium",
			blocking: false,
			status: "open",
			evidence: [reason],
		}, { detectedAtStage: "implementation", ownerStage: "implementation", sourceGate: PROTECTION_BREACH_SCOPE });
	} catch { /* never block the phase on ledger bookkeeping */ }
	return { action: "degraded", reason };
}

/** Consume the phase's second protection strike. Never throws. */
export async function consumeProtectionBreachEscalation(args: {
	ctx: StageContext;
	state: PipelineState;
	phaseId: string;
	phaseName: string;
	/** The strike count that fired (≥ PROTECTION_STRIKE_BOUND). */
	strike: number;
	violations: ProtectionViolation[];
	specIdentifier: string;
}): Promise<ProtectionBreachOutcome> {
	const { ctx, state, phaseId, phaseName, violations } = args;
	ctx.log(`Implementation ${phaseId} protection strike ${args.strike}/${PROTECTION_STRIKE_BOUND}: protected-path write repeated after the strike-1 education — routing the protection breach to the judge (058 §3 Layer 2)`);
	try {
		const out = await runJudge(ctx, {
			scope: PROTECTION_BREACH_SCOPE,
			signature: `protection-breach:${phaseId}:strike-${args.strike}`,
			worktreePath: state.setup?.worktreePath ?? "",
			specDirectory: state.setup?.specDirectory,
			context: [
				"## Protection breach — a protected path was written twice in one phase",
				`Phase ${phaseId}${phaseName ? ` (${phaseName})` : ""}: the engine's post-join pre-build-gate choke point mechanically detected protected-path writes on two attempts. The strike-1 edit was reverted and the implementer was re-prompted with the protecting clauses; the write recurred. The violating paths were reverted again and stay protected.`,
				...violations.flatMap((v) => v.clauses.slice(0, 3).map((c) => `- \`${v.path}\` — protected by ${c.locus}: "${c.clause}"`)),
				"",
				"Adjudicate the CONTRACT, not the executor: route replan-upstream if the plan genuinely requires writing a protected file (move the write to the owning scope, drop the protection, or merge the scopes); route challenge-test if the protecting test itself is the wrong contract (a test demanding immutability may be stale or mis-scoped). escalate-now is NOT executable for this trigger — the consumer refuses to abort on it (058 §3 Layer 2).",
			].join("\n"),
			allowedRoutes: PROTECTION_BREACH_ALLOWED_ROUTES,
		});
		const verdict = out.status === "routed" || out.status === "escalate" ? out.verdict : undefined;
		if (verdict?.route === "replan-upstream") {
			let routed = false;
			try {
				routed = await triggerReplanForFindings(state, ctx, [{
					file: null,
					severity: "high",
					title: `protection breach at ${phaseId}: phase work requires writing protected path(s) ${violations.map((v) => v.path).join(", ")}`,
					detail: `Two mechanically-detected writes to protected path(s) (${violations.map((v) => `${v.path} ← ${v.clauses[0]?.locus ?? "unknown locus"}`).join("; ")}) after the strike-1 revert+education. Judge diagnosis: ${verdict.diagnosis}`,
					ownerStage: "spec",
				}], "implementation", args.specIdentifier ?? "unknown");
			} catch { routed = false; }
			if (routed) {
				ctx.log(`Implementation ${phaseId} judge route=replan-upstream: protection breach routed to REPLAN (plan revision) — the protected path(s) stay protected; the plan must move the write out of the protected scope`);
				return { action: "replan-routed", diagnosis: verdict.diagnosis };
			}
			return degradeHonest(ctx, state, phaseId, `judge routed replan-upstream but the replan circuit declined (pool/marker/budget) — the breach signal is recorded; steer manually or re-run`);
		}
		if (verdict?.route === "challenge-test") {
			ctx.log(`Implementation ${phaseId} judge route=challenge-test: the protecting test is the suspect contract — the RED is re-authored with the judge's verified diagnosis (a test demanding immutability may itself be the wrong contract)`);
			const evidence = verdict.evidence.map((e) => `${e.file}: ${e.quote}`).join(" | ");
			return { action: "challenge-test", diagnosis: verdict.diagnosis, evidence };
		}
		if (verdict?.route === "escalate-now") {
			// CONSUMER REFUSAL (058 §3 Layer 2, mirroring 059 §3 R4): the judge may
			// RETURN escalate-now (it is always in the allowed set), but this consumer
			// NEVER executes the FatalAbort branch for the protection-breach trigger.
			return degradeHonest(ctx, state, phaseId, `judge verdict escalate-now REFUSED for the protection-breach trigger — no FatalAbort on this route (058 §3 Layer 2)`);
		}
		return degradeHonest(ctx, state, phaseId, out.status === "degraded" || out.status === "discarded" ? `judge ${out.status} (${out.reason})` : `judge verdict ${String(verdict?.route ?? "none")}`);
	} catch (err) {
		return degradeHonest(ctx, state, phaseId, `judge call failed (${err instanceof Error ? err.message : String(err)})`);
	}
}
