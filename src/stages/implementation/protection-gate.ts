/**
 * The protection choke point — increment 8 of the stage.ts split.
 *
 * THE BLOCK THIS REPLACES (stage.ts:1440-1496, the `if (protectionInterval
 * .protectedPaths.size > 0) { ... }` block between the RED-review join and the
 * build gate): mechanically diff the attempt's changed files (worktree porcelain
 * + the implementer's declared footprint) against the phase's protected set,
 * revert any violating paths, and adjudicate:
 *
 *   • no violations            → fall through to the build gate
 *   • STRIKE 1                 → revert + education block; the attempt is
 *                               NOT counted (`attempt--`), re-prompt once
 *   • STRIKE 2 → challenge-test → the protecting test is the suspect contract;
 *                               the RED is re-authored with the diagnosis
 *   • STRIKE 2 → replan/degraded → the attempt ends, phase stops no-progress
 *
 * THE CONTROL-FLOW CONVERSION (the fourth, after red-judge.ts v0.4.32,
 * research-assist-dispatch.ts v0.4.34 and red-review-join.ts v0.4.35): the
 * inline block had TWO `continue`s and ONE `break`, and one of the continues
 * also mutated the for-loop counter (`attempt--` — zero attempt cost for the
 * environment-corrected strike-1 re-prompt). A module cannot reach the caller's
 * loop counter, so the counter mutation became a RETURNED VARIANT: the caller
 * decrements only on `reprompt`. This is why the outcome is a four-way union
 * rather than a two-way restart/terminal like red-review-join.
 *
 * THE v0.4.33 CROSS-ITERATION LESSON (applied by construction here): the inline
 * `continue`s preserved phase-scoped state implicitly — whatever a branch did
 * NOT assign stayed live for the next iteration. A returned record must not
 * zero anything the branch did not zero. Each outcome below carries ONLY the
 * bindings its branch assigned:
 *
 *   • pass      → nothing (the caller must not touch a single binding)
 *   • reprompt  → education ONLY (attemptErrors/terminalStopReason/acceptedRed/
 *                 reauthorEvidence/attemptProgressHistory all stay live)
 *   • reauthor  → reauthorEvidence ONLY (acceptedRed/attemptProgressHistory are
 *                 caller-side clears that the inline code did in the same arm —
 *                 they are returned values here, never implicit)
 *   • terminal  → attemptError + the no-progress stop reason ONLY
 *
 * `phaseProtectionStrikes` is an in/out Record (bump/reset mutate it in place),
 * exactly as inline — it is passed by reference, not returned.
 */

import type { StageContext, PipelineState } from "../../types.ts";
import {
	PROTECTION_STRIKE_BOUND,
	buildProtectionEducationBlock,
	bumpProtectionStrike,
	detectProtectionViolations,
	resetProtectionStrike,
} from "../protection-interval.ts";
import type { ProtectionInterval } from "../protection-interval.ts";
import { consumeProtectionBreachEscalation } from "../../review/protection-breach-consumer.ts";
import { porcelainEntries, restorePaths } from "./red-evidence.ts";

/** The four verdicts of the choke point. `pass` is first because it is the
 *  overwhelmingly common path (the protected set is empty on most phases —
 *  zero cost, zero false positives). */
export type ProtectionGateOutcome =
	| { kind: "pass" }
	| { kind: "reprompt"; education: string }
	| { kind: "reauthor"; reauthorEvidence: string }
	| { kind: "terminal"; attemptError: string };

export interface ProtectionGateInput {
	ctx: StageContext;
	state: PipelineState;
	worktreePath: string;
	phaseId: string;
	phaseName: string;
	specIdentifier: string;
	/** The phase's derived protected set. Empty ⇒ immediate pass (the porcelain
	 *  walk is skipped, as inline). */
	protectionInterval: ProtectionInterval;
	/** The implementer's declared write footprint for this attempt
	 *  ([...filesCreated, ...filesModified, ...filesDeleted]). */
	declaredFootprint: string[];
	/** Per-phase strike counters on the implementation control — mutated in
	 *  place by bump/reset (the same object the caller reads downstream). */
	phaseProtectionStrikes: Record<string, number>;
	/** The current attempt number, for the log line only. */
	attempt: number;
}

/**
 * Adjudicate the protection choke point for one attempt. Pure w.r.t. the
 * caller's phase-scoped bindings: every mutation the inline block made is
 * either applied to an in/out param (phaseProtectionStrikes, the worktree via
 * restorePaths) or RETURNED in the outcome.
 */
export async function adjudicateProtectionGate(input: ProtectionGateInput): Promise<ProtectionGateOutcome> {
	const { ctx, state, worktreePath, phaseId, phaseName, specIdentifier, protectionInterval, declaredFootprint, phaseProtectionStrikes, attempt } = input;

	// The protected-set guard: zero cost / zero false positives when the set is
	// empty, and it skips the porcelain walk (the only filesystem cost here).
	if (protectionInterval.protectedPaths.size === 0) return { kind: "pass" };

	const protectionChanged = new Set<string>();
	for (const e of porcelainEntries(worktreePath)) {
		protectionChanged.add(e.path);
		if (e.fromPath) protectionChanged.add(e.fromPath);
	}

	const protectionViolations = detectProtectionViolations(
		[...protectionChanged],
		declaredFootprint,
		protectionInterval,
	);
	if (protectionViolations.length === 0) return { kind: "pass" };

	const strike = bumpProtectionStrike(phaseProtectionStrikes, phaseId);
	const violationPaths = protectionViolations.map((v) => v.path);
	// Mechanical protection holds while the breach is adjudicated: revert the
	// violating paths to the phase's entry state (restorePaths covers the
	// tracked restore AND the created-file clean — the deterministic checkpoint
	// chain IS the entry state).
	restorePaths(worktreePath, violationPaths);

	if (strike === 1) {
		// STRIKE 1 (zero attempt cost — an environment-corrected dispatch, not a
		// judged failure): re-prompt the implementer ONCE with the education block
		// naming the protected files + the exact clause. The attempt decrement is
		// the CALLER's job (a module cannot reach the for-loop counter).
		const education = buildProtectionEducationBlock({ phaseId, violations: protectionViolations, strike });
		ctx.log(`Implementation ${phaseId} protection strike 1/${PROTECTION_STRIKE_BOUND}: attempt ${attempt} wrote protected path(s) ${violationPaths.join(", ")} — REVERTED to the phase entry state; attempt NOT counted; re-prompting once with the protection education block (058 §3 Layer 2)`);
		return { kind: "reprompt", education };
	}

	// STRIKE 2 (same phase): route to the judge — the consumer REFUSES
	// escalate-now (honest degrade + route-back only, the 059 §3 R4 consumer
	// policy mirrored). Every strike-2 outcome ENDS this attempt (replan / RED
	// re-author / honest partial), so no third in-loop strike can loop
	// (P8: strike 2 always routes).
	const breach = await consumeProtectionBreachEscalation({
		ctx,
		state,
		phaseId,
		phaseName,
		strike,
		violations: protectionViolations,
		specIdentifier,
	});

	if (breach.action === "challenge-test") {
		const reauthorEvidence = `\n\n## Judge diagnosis (verified evidence — the RED must be re-authored)\n${breach.diagnosis}\nEvidence: ${breach.evidence}`;
		// The contract surface is being re-authored — a fresh protection interval
		// for this phase (bounded by the phase attempt cap / wall / run budget —
		// strike-2 always routes; this path does NOT consult challengeReauthors,
		// unlike the RED-judge and noProgress reauthor sites).
		resetProtectionStrike(phaseProtectionStrikes, phaseId);
		ctx.log(`Implementation ${phaseId} protection strike ${strike}: breach routed to judge → challenge-test — RED re-authored with the verified diagnosis; protection strike counter reset for the re-authored contract surface`);
		// The inline code cleared attemptProgressHistory and acceptedRed in this
		// same arm; those are the caller's bindings (not reachable here), so the
		// caller clears them alongside this outcome — see the v0.4.33 note above.
		return { kind: "reauthor", reauthorEvidence };
	}

	const attemptError = `protection-breach: protected path(s) ${violationPaths.join(", ")} written ${strike}× after the strike-1 education${breach.action === "replan-routed" ? " — judge routed replan-upstream (plan revision)" : ` — judge outcome degraded (${breach.reason.slice(0, 200)})`}; the violating path(s) stay protected (reverted)`;
	return { kind: "terminal", attemptError };
}
