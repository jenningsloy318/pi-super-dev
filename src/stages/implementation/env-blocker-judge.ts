/**
 * The environmental-blocker judge hand-off — increment 11 of the stage.ts
 * split (the second and final sub-block of the env-blocker branch).
 *
 * THE BLOCK THIS REPLACES (stage.ts, the `if (!reRunClassifiedProduct)`
 * region after the quarantine/re-gate extraction): every still-blocked entry
 * (dirt empty | kill-switch | re-gate grant spent | re-run still blocked |
 * quarantine failed) routes to the SINGLE judge hand-off at FIRST occurrence —
 *
 *   • routed fix-environment / escalate / degraded / discarded → the D-5 soft
 *     HITL surface (or the headless evidence log), the T6.2 verdict record,
 *     then the terminal stop (phase preserved partial; the granted
 *     retry-with-guidance re-entry declines the anti-windup block)
 *   • routed implementer-retry (v0.2.6 G3) → the AUDITED OVERRIDE: the judge's
 *     grounded diagnosis contradicts the deterministic class=environment
 *     frame; the attempt falls through to failureReasons for a normal
 *     implementer retry with the diagnosis joined to the feedback
 *
 * THE CONTROL-FLOW CONVERSION (the seventh, after v0.4.32/34/35/36/37/38):
 * the block had ONE `break` (the terminal stop) and ONE fall-through (the
 * override). The break became the `terminal-stop` variant (carrying the
 * null-or-value convergenceBlockReason — null when the guidance re-entry was
 * granted, leaving the anti-windup block unset exactly as inline); the
 * fall-through became `override-retry` (carrying the fault class, the
 * judge-override feedback, and the null-or-value post-regate errors).
 *
 * THE v0.4.33 CROSS-ITERATION LESSON (applied by construction): `envGuidance
 * ReentryGranted` was read and written ONLY inside this region — the module
 * owns it as a local. `envBlockedPhases` (Set) and `phaseGuidanceReentryUsed`
 * (Record) are read elsewhere in the stage and stay in/out by reference,
 * mutated exactly where the inline code mutated them. The escalation
 * decision is LOGGED ONLY — D-5 holds: no applyRetryDecision, no rollback,
 * no implementer spawn, no `continue`.
 */

import type { Escalate, EscalationFailure, PipelineState, StageContext } from "../../types.ts";
import { runJudge } from "../judge.ts";
import { classifyJudgeRoute } from "../../routing/router.ts";
import { appendEnvironmentFault, dirtyQuarantineEnabled, readEnvironmentFaultCount } from "../../fault-classification.ts";
import type { BuildGateResult } from "../../build-runner.ts";

/** The judge hand-off verdict: the terminal stop (break) or the audited
 *  product override (fall-through to failureReasons). */
export type EnvJudgeOutcome =
	| {
		kind: "override-retry";
		/** The judge's grounded override — always "product-defect" (v0.3.85 F3). */
		faultClass: "product-defect";
		/** The diagnosis joined to the implementer retry feedback. */
		judgeOverrideFeedback: string[];
		/** The re-run's errors as the tree's current truth (null = keep the existing carrier). */
		postRegateErrors: string[] | null;
	}
	| {
		kind: "terminal-stop";
		/** terminalStopReason is always "failed" (the distinct stop log identifies the boundary). */
		stopReason: "failed";
		/** The anti-windup block reason; NULL when the guidance re-entry was granted. */
		blockReason: string | null;
	};

export interface EnvJudgeInput {
	ctx: StageContext;
	state: PipelineState;
	worktreePath: string;
	specDirectory: string;
	phaseId: string;
	phaseName: string;
	/** The attempt's original full-suite gate verdict. */
	gate: BuildGateResult;
	/** The post-quarantine re-run's verdict (null when no re-run ran). */
	gate2: BuildGateResult | null;
	/** The canonical dirt inventory (context + findings evidence). */
	dirtPaths: string[];
	/** In/out: the per-phase guidance re-entry grants (one-shot per phase EVER,
	 *  persisted across convergence iterations — adversarial sd26-F2). */
	phaseGuidanceReentryUsed: Record<string, true>;
	/** In/out: judge-owned environmental stops — excluded from stage-close
	 *  re-verification (v0.3.80 B2). */
	envBlockedPhases: Set<string>;
}

/**
 * Run the environmental-blocker judge hand-off. The kill-switch detection
 * warning and the class=environment line are emitted BEFORE the dispatch
 * (T4.3 ordering); the escalation surface's decision is logged only (D-5).
 */
export async function handOffEnvBlockerJudge(input: EnvJudgeInput): Promise<EnvJudgeOutcome> {
	const { ctx, state, worktreePath, specDirectory, phaseId, phaseName, gate, gate2, dirtPaths, phaseGuidanceReentryUsed, envBlockedPhases } = input;

	// T4.3 (SCENARIO-024): kill-switch ordering — the detection warning is
	// emitted BEFORE the judge hand-off. Detection observes, mutation never
	// runs (the regate module skipped the quarantine arm and the primitive's
	// own short-circuit makes a stash structurally unreachable).
	if (dirtPaths.length > 0 && !dirtyQuarantineEnabled()) {
		ctx.log(`Implementation ${phaseId} dirty-quarantine kill-switch SUPER_DEV_NO_DIRTY_QUARANTINE=1 set — detection only, worktree untouched — class=environment; next=<judge: fix-environment/escalate>`);
	}
	// AC-05 (SCENARIO-013): class + next action on every new line (NFR-2).
	ctx.log(`Implementation ${phaseId} environmental-blocker: out-of-scope-only failures, baseline=regression, own-scope evidence green — class=environment; next=<judge: fix-environment/escalate>`);
	// ── T4.1 (SCENARIO-010/011 · AC-04): the SINGLE judge hand-off, at FIRST
	// occurrence, reached from every still-blocked entry. D-13: the signature
	// is keyed on the out-of-scope subjects + baseline status — NEVER
	// progressSignature.failure — so the ≤2 per-signature budget is not shared
	// with stage9.impl-no-progress. D-6 (OQ-1): allowedRoutes is EXACTLY
	// ["fix-environment"] plus the G3 arbitration route; outputTails carries
	// the gate tail + baseline evidence so quote verification (INV-2) can pass.
	const latestGate = gate2 ?? gate;
	const envSubjects = [...new Set(latestGate.outOfScopeErrors)].sort();
	const envSignature = JSON.stringify({ subjects: envSubjects, baseline: latestGate.baselineCheck?.status ?? "regression" });
	const priorFaults = readEnvironmentFaultCount(specDirectory);
	const envBaselineStatus = latestGate.baselineCheck?.status ?? "regression";
	const envBaselineEvidence = latestGate.baselineCheck?.evidence ?? "(none)";
	const envGateTail = latestGate.errors.join("\n").slice(-2000);
	const judgeOut = await runJudge(ctx, {
		scope: `stage9.impl-env-blocker.${phaseId}`,
		signature: envSignature,
		worktreePath,
		specDirectory,
		context: [
			"## Environmental blocker — out-of-scope-only failures, baseline=regression, own-scope evidence green",
			...latestGate.errors.slice(0, 12),
			"## Baseline verification",
			`status=${envBaselineStatus}`,
			envBaselineEvidence,
			"## Dirt inventory (foreign uncommitted state, canonical exclusions applied)",
			dirtPaths.length ? dirtPaths.join("\n") : "(empty)",
			...(priorFaults !== null ? [`## Prior environmental faults on this track: ${priorFaults} (from .environment-faults.jsonl)`] : []),
		].join("\n"),
		// v0.2.6 G3: the judge may ARBITRATE — when its grounded diagnosis
		// contradicts the deterministic `class=environment` frame, it can route
		// implementer-retry instead of being boxed into fix-environment or
		// escalate-now. Bounded by the per-signature budget; audited in the log,
		// the ledger, and the implementer feedback.
		allowedRoutes: ["fix-environment", "implementer-retry"],
		outputTails: [envGateTail, envBaselineEvidence],
	});
	// ── T4.2 (SCENARIO-012): the outcome ladder. A routed fix-environment
	// surfaces as the D-5 soft HITL escalation carrying BOTH evidence packets;
	// escalate/discarded/degraded fall to the SAME surface; headless logs the
	// packets. EVERY arm then terminal-stops — no `continue`, no implementer
	// spawn, no second automatic quarantine (OQ-1); the outer convergence loop
	// owns re-entry.
	const routedFixEnvironment = judgeOut.status === "routed" && judgeOut.verdict.route === "fix-environment";
	// v0.2.6 G3 — the audited override predicate. M4 fold (defense-in-depth):
	// the explicit route check guards against an UNOFFERED retry-classified
	// route; the classifier agreement pins the shared vocabulary so the two
	// can never drift apart silently.
	const routedImplementerRetry = judgeOut.status === "routed" && judgeOut.verdict.route === "implementer-retry" && classifyJudgeRoute(judgeOut.verdict.route) === "retry";
	let envJudgeDiagnosis = "";
	if (judgeOut.status === "routed" || judgeOut.status === "escalate") {
		envJudgeDiagnosis = `${judgeOut.verdict.diagnosis}\nEvidence: ${judgeOut.verdict.evidence.map((e) => `${e.file}: ${e.quote}`).join(" | ")}`;
	} else {
		envJudgeDiagnosis = `judge ${judgeOut.status}: ${judgeOut.reason}`;
	}
	if (routedFixEnvironment) {
		ctx.log(`Implementation ${phaseId} judge route=fix-environment: environmental fix required — surfacing both evidence packets to the user (soft HITL, terminal stop) — class=environment; next=<human: fix-environment> — ${judgeOut.verdict.diagnosis}`);
	} else if (routedImplementerRetry) {
		// v0.2.6 G3 + sd26-CR-3: the override arm neither surfaces HITL nor
		// terminal-stops — the ladder wording below must not fire for it (its
		// own override log is emitted in the G3 block).
	} else {
		const degradeWhy = judgeOut.status === "routed" || judgeOut.status === "escalate" ? `verdict route=${judgeOut.verdict.route}` : judgeOut.reason;
		ctx.log(`Implementation ${phaseId} judge ${judgeOut.status} at the environmental-blocker boundary (${degradeWhy}) — surfacing both evidence packets to the user (soft HITL, terminal stop) — class=environment; next=<human: escalate>`);
	}
	if (routedImplementerRetry) {
		// v0.2.6 G3 — the audited override path: record the verdict in the
		// ledger, join the diagnosis to the implementer retry, and SKIP the
		// HITL surface and the convergence block entirely.
		appendEnvironmentFault(specDirectory, { kind: "judge-environmental", paths: null, stashRef: null, reason: `implementer-retry: ${judgeOut.verdict.diagnosis.slice(0, 200)}` }, ctx.log);
		// v0.2.6 G3 + sd26-CR-5: when this override arrives via a still-red
		// post-quarantine re-gate, the re-run's errors are the tree's current
		// truth — mirror the G2 carrier so the implementer never sees the stale
		// pre-quarantine gate tail.
		const postRegateErrors = gate2 ? gate2.errors : null;
		const judgeOverrideFeedback = [
			`judge override — the deterministic classifier said environment, but the judge diagnosis says this is a product defect the implementer must address: ${judgeOut.verdict.diagnosis.slice(0, 600)}`,
			// v0.2.7 dedup: ownDirtFeedback is ALWAYS appended to failureReasons
			// directly below (in the caller), so it must NOT be repeated here.
		];
		ctx.log(`Implementation ${phaseId} judge route=implementer-retry: classifier=environment OVERRIDDEN by judge diagnosis — class=product; next=<implementer-retry> (audited in .environment-faults.jsonl; diagnosis joined the retry feedback) — ${judgeOut.verdict.diagnosis.slice(0, 200)}`);
		return { kind: "override-retry", faultClass: "product-defect", judgeOverrideFeedback, postRegateErrors };
	}
	// The soft HITL surface (mirrors the no-progress block's shape — minus
	// applyRetryDecision, D-5): kind stagnation / severity soft / stage
	// implementation; findings = gate tail + baseline + inventory sliced to 12,
	// with the baseline and inventory packets LEADING the slice so both
	// evidence packets always survive it.
	const envFailure: EscalationFailure = {
		kind: "stagnation",
		stage: "implementation",
		message: `Implementation phase "${phaseName}" is blocked by an environmental failure: every gate failure references out-of-scope subject(s) that PASS at the merge-base baseline (status=${envBaselineStatus}), while all own-scope evidence (deliverables, change gate, symbol gate, TDD oracle) is green — this is not a product defect, and the implementer was not re-spawned.${envJudgeDiagnosis ? `\n\nJUDGE (${judgeOut.status}):\n${envJudgeDiagnosis}` : ""} Fix the environment (or recover quarantined state with: git stash pop) and re-run; the next convergence pass re-enters this phase with a fresh one-re-run budget.`,
		severity: "soft",
		findings: [
			...(envJudgeDiagnosis ? [{ file: null, severity: null, title: `judge diagnosis: ${envJudgeDiagnosis.split("\n")[0].slice(0, 200)}` }] : []),
			{ file: null, severity: null, title: `baseline verification: status=${envBaselineStatus} — ${envBaselineEvidence}` },
			{ file: null, severity: null, title: `dirt inventory (canonical exclusions applied): ${dirtPaths.length ? dirtPaths.join(", ") : "(empty)"}` },
			...latestGate.errors.slice(0, 12).map((r) => ({ file: null, severity: null, title: r })),
		].slice(0, 12),
		worktreePath,
		specDirectory,
	};
	const escalate = (ctx as { options?: { escalate?: Escalate } }).options?.escalate;
	// v0.2.6 G4 — the FIRST retry-with-guidance EVER granted for this phase
	// (persisted across convergence iterations — adversarial sd26-F2) grants a
	// bounded re-entry: guidance persists AND the anti-windup block is
	// skipped, so the outer convergence loop re-enters the phase and the
	// guidance actually reaches fresh agent calls. One-shot per phase EVER.
	// sd26-F3: the grant is consumed ONLY after appendUserNotes succeeds — a
	// persistence failure leaves the budget intact and falls to the blocked
	// stop.
	let guidanceReentryGranted = false;
	if (escalate) {
		try {
			const { runEscalation } = await import("../../escalation.ts");
			const decision = await runEscalation(state, envFailure, escalate);
			// D-5: the decision is LOGGED ONLY — applyRetryDecision is NOT called
			// at this boundary (its retry path is a destructive rollback; the
			// env-blocker arm must never make that choice unconscious). No
			// rollback, no implementer spawn, no `continue` — the outer
			// convergence loop owns re-entry.
			if (decision) {
				// adv-review F-3: a retry-with-guidance choice at this boundary must
				// not be silently discarded — persist the guidance non-destructively
				// to the track user-notes WITHOUT applyRetryDecision.
				if (decision.choice === "retry-with-guidance" && decision.guidance) {
					const grantReentry = !Object.prototype.hasOwnProperty.call(phaseGuidanceReentryUsed, phaseId);
					try {
						const { appendUserNotes } = await import("../../render/user-notes.ts");
						appendUserNotes(specDirectory, [`[env-blocker phase ${phaseId}] ${decision.guidance.slice(0, 2000)}`]);
						if (grantReentry) {
							phaseGuidanceReentryUsed[phaseId] = true;
							guidanceReentryGranted = true;
						}
						ctx.log(`Implementation ${phaseId} environmental-blocker retry-with-guidance: guidance persisted to track user-notes${grantReentry ? " — re-entry granted (1/1, per phase ever): the outer convergence loop re-enters this phase and the guidance reaches the next pass" : " — re-entry budget already spent; phase preserved as partial and the pass continues (v0.3.0 semantics), guidance persists for the next convergence iteration"} — class=environment; next=<${grantReentry ? "re-entry consumes guidance" : "human: manual re-entry"}>`);
					} catch (e) {
						ctx.log(`Implementation ${phaseId} environmental-blocker guidance persistence failed (logged only — re-entry grant NOT consumed): ${e instanceof Error ? e.message : String(e)}`);
					}
				}
				ctx.log(`Implementation ${phaseId} environmental-blocker escalation decision: ${decision.choice}${decision.guidance ? ` (guidance: ${decision.guidance.slice(0, 200)})` : ""} — logged only, NOT applied (no rollback; the outer convergence loop owns re-entry)`);
			}
		} catch { /* never-throw: fall through to the terminal stop */ }
	} else {
		// Headless: no escalation surface — log BOTH evidence packets, then stop.
		ctx.log(`Implementation ${phaseId} environmental-blocker (headless — no escalation surface): gate tail: ${envGateTail}; baseline: status=${envBaselineStatus} — ${envBaselineEvidence}; dirt inventory (canonical exclusions applied): ${dirtPaths.length ? dirtPaths.join(", ") : "(empty)"}`);
	}
	// ── T6.2 (SCENARIO-026 · AC-12): the judge-environmental VERDICT record,
	// appended after the hand-off settles on every outcome that carries a
	// verdict — routed or escalate. A discarded/degraded outcome carries NO
	// verdict (only a reason). The append never throws — an unwritable ledger
	// degrades to the primitive's warning and the terminal stop proceeds.
	if (judgeOut.status === "routed" || judgeOut.status === "escalate") {
		appendEnvironmentFault(specDirectory, { kind: "judge-environmental", paths: null, stashRef: null, reason: `${judgeOut.verdict.route}: ${judgeOut.verdict.diagnosis.slice(0, 200)}` }, ctx.log);
	}
	// D-5 terminal stop: the caller sets terminalStopReason "failed" (the
	// generic loop-tail stop line carries no suffix for it); this DISTINCT stop
	// log keeps the boundary identifiable in the run log.
	envBlockedPhases.add(phaseId); // v0.3.80 B2: judge-owned environmental stop — excluded from stage-close re-verification
	if (guidanceReentryGranted) {
		// v0.2.6 G4 — the granted re-entry declines the anti-windup block: the
		// outer convergence loop re-enters the phase and the persisted guidance
		// reaches the fresh agent calls. terminalStopReason stays "failed" so
		// the loop tail logs an honest stop for THIS pass.
		ctx.log(`Implementation ${phaseId} environmental-blocker stop after judge hand-off (outcome: ${routedFixEnvironment ? "route=fix-environment" : judgeOut.status}) — guidance re-entry GRANTED: convergence not blocked, the outer convergence loop re-enters this phase — class=environment; next=<re-entry consumes guidance>`);
		return { kind: "terminal-stop", stopReason: "failed", blockReason: null };
	}
	// adv-review F-2: trip the convergence-level anti-windup — an unresolved
	// environmental blocker must NOT let the outer convergence loop re-enter
	// this phase until the global agent budget. The distinct reason names the
	// class so the summary distinguishes it from product no-progress. (v0.3.0:
	// the stop no longer trips convergenceBlocked — the phase is preserved as
	// partial and the pipeline continues; the outer loop re-enters bounded by
	// the global budget fuse.)
	ctx.log(`Implementation ${phaseId} environmental-blocker stop after judge hand-off (outcome: ${routedFixEnvironment ? "route=fix-environment" : judgeOut.status}) — awaiting environment fix or user decision — class=environment; phase preserved as partial, continuing to the next phase this pass (v0.3.0)`);
	return {
		kind: "terminal-stop",
		stopReason: "failed",
		blockReason: `environmental-blocker: ${routedFixEnvironment ? "judge route=fix-environment awaiting environment fix" : `judge ${judgeOut.status}`} — out-of-scope-only failures (baseline=${envBaselineStatus}), own-scope evidence green`,
	};
}
