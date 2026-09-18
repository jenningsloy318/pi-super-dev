/**
 * The no-progress valve — increment 12 of the stage.ts split.
 *
 * THE BLOCK THIS REPLACES (stage.ts, the `if (noProgress) { ... }` region after
 * the implementer-challenge routing): the repeated-failure boundary —
 *
 *   • the contradiction frames: a repeated signature + observed phase-boundary
 *     reverts (v0.3.79 A2) or a cross-scope citation (Wave P1 D-C) arms a
 *     replan-upstream frame — the deterministic plan-contradiction classes
 *   • J9-b: ONE judge dispatch at stage9.impl-no-progress.<phaseId> keyed on
 *     the progress signature, offered routes shaped by the frames —
 *       - replan-upstream (a frame fired) → route the replan finding, stop
 *       - challenge-test (bounded by the challenge budget) → re-author the
 *         RED with the judge-verified defect
 *       - re-author-tests → restart RED with the diagnosis
 *       - continue → one fresh attempt with diagnosis guidance
 *       - escalate / routed-elsewhere → the verified diagnosis joins the HITL
 *   • the HITL escalation (soft stagnation): the user may inject guidance and
 *     continue (retry-with-guidance drops the accepted RED so guidance can
 *     reshape tests, evidence-backed); headless/dismissal falls through
 *   • the terminal stop: no-progress with the P10 stop-class line (which
 *     governor valve fired — signature repeat, fault-class recurrence,
 *     zero-change plateau, or the cross-scope citation)
 *
 * THE CONTROL-FLOW CONVERSION (the eighth, after v0.4.32/34/35/36/37/38/39):
 * the region had FOUR `continue`s (challenge-test, re-author-tests, the judge
 * continue route, the HITL retry-with-guidance) and TWO `break`s (the
 * contradiction replan stop, the terminal no-progress stop) plus a fall-through
 * shape that is structurally part of the terminal stop. They became a FIVE-way
 * outcome union; the caller applies per-arm rebinds and the loop control.
 *
 * THE v0.4.33 CROSS-ITERATION LESSON (applied by construction): each outcome
 * carries ONLY its arm's bindings — replan-routed carries the diagnosis
 * (redJudgeDiagnosis at the caller); reauthor carries the evidence and a
 * challengeConsumed flag (the caller increments the loop-scoped counter);
 * continue-guided carries judgeGuidance (read at the NEXT implementer prompt,
 * outside this region); retry-with-guidance carries the re-author evidence;
 * terminal carries nothing beyond the stop class (the log emits in-module).
 * implJudgeDiagnosis/implJudgeEvidenceLabel were region-local and became
 * module-locals — an INTENTIONAL tightening: at phase scope a diagnosis set on
 * entry N could leak into entry N+1's HITL message when N ended via
 * retry-with-guidance and N+1's judge degraded; per-call locals reset it
 * (code-review NPV-2, blessed).
 */

import type { Escalate, PipelineState, StageContext } from "../../types.ts";
import type { JudgeRoute } from "../judge.ts";
import { runJudge, firstCitedTestFile } from "../judge.ts";
import { triggerReplanForFindings } from "../../replan/replan.ts";
import { contradictionFastFailFrame } from "../plan-feasibility.ts";
import { crossScopeContractConflictFrame, type CrossScopeCitation, type AcceptedRedContext } from "./red-evidence.ts";
import { formatReauthorEvidence, MAX_CHALLENGE_REAUTHORS, UNSATISFIABLE_TEXT_RE } from "./phase-reentry.ts";
import type { TestDefect } from "./phase-reentry.ts";

/** The valve's verdict — five arms mapping the region's four continues and
 *  two breaks. */
export type NoProgressOutcome =
	| { kind: "replan-routed"; diagnosis: string }
	| { kind: "reauthor"; reauthorEvidence: string; challengeConsumed: boolean }
	| { kind: "continue-guided"; judgeGuidance: string }
	| { kind: "retry-with-guidance"; reauthorEvidence: string }
	| { kind: "terminal" };

export interface NoProgressInput {
	ctx: StageContext;
	state: PipelineState;
	worktreePath: string;
	specDirectory: string;
	specIdentifier: string;
	phaseId: string;
	/** The loop-normalized phase name (escalation message + logs). */
	phaseName: string;
	/** The RAW name for the frame constructors — inline they received
	 *  `phases[idx]?.name ?? ""` (never the phaseId fallback), so an unnamed
	 *  phase renders no parenthetical in the judge-prompt frames. */
	framePhaseName: string;
	attempt: number;
	/** The governor's readings: which valve fired. */
	signatureRepeat: boolean;
	faultRecurrence: boolean;
	zeroLandedChange: boolean;
	/** The attempt's effective fault class + the streak (context + stop class). */
	attemptFaultClass: string;
	faultClassStreakCount: number;
	/** The contradiction-frame inputs: observed phase-boundary reverts. */
	boundaryRevertHits: number;
	boundaryLeakOwners: string[];
	boundaryLeakFiles: string[];
	/** The cross-scope citation readings. */
	crossScopeConflict: boolean;
	crossScopeCites: CrossScopeCitation[];
	/** The failure evidence. */
	failureReasons: string[];
	progressSignatureFailure: string;
	implTextTail: string;
	implDefects: TestDefect[];
	acceptedRed: AcceptedRedContext | null;
	testFiles: string[];
	/** The challenge budget reading (the counter itself stays caller-side). */
	challengeReauthors: number;
}

/**
 * Adjudicate the no-progress boundary. The judge and the escalation surface
 * dispatch inside; every arm returns (never throws — the escalation try/catch
 * falls through to the terminal stop, as inline).
 */
export async function adjudicateNoProgress(input: NoProgressInput): Promise<NoProgressOutcome> {
	const { ctx, state, worktreePath, specDirectory, specIdentifier, phaseId, phaseName, framePhaseName, attempt, signatureRepeat, faultRecurrence, zeroLandedChange, attemptFaultClass, faultClassStreakCount, boundaryRevertHits, boundaryLeakOwners, boundaryLeakFiles, crossScopeConflict, crossScopeCites, failureReasons, progressSignatureFailure, implTextTail, implDefects, acceptedRed, testFiles, challengeReauthors } = input;

	// v0.3.79 A2: a repeated signature + observed phase-boundary reverts is a
	// DETERMINISTIC contradiction — arm the contradiction frame (replan-upstream
	// offered) so the valve routes plan revision instead of blind retries.
	const cfFrame = boundaryRevertHits > 0
		? contradictionFastFailFrame({ phaseId, phaseName: framePhaseName, leakOwners: boundaryLeakOwners, leakFiles: boundaryLeakFiles, failureReasons })
		: null;
	// Wave P1 D-C (S-A class): the cross-scope contract-conflict frame —
	// replan-upstream is offered on FIRST occurrence (the goal is unsatisfiable
	// inside this phase's scope; no attempt can produce improving signal).
	const csFrame = crossScopeConflict
		? crossScopeContractConflictFrame({ phaseId, phaseName: framePhaseName, citations: crossScopeCites })
		: null;
	// J9-b (judge routing layer): a verified diagnosis at the no-progress
	// boundary, BEFORE the human is asked.
	const judgeOut = await runJudge(ctx, {
		scope: `stage9.impl-no-progress.${phaseId}`,
		signature: progressSignatureFailure,
		worktreePath,
		specDirectory,
		context: [
			...(csFrame ? [csFrame.context] : []),
			...(cfFrame ? [cfFrame.context] : []),
			faultRecurrence && !signatureRepeat
				? `## Recurring failure-category (${attemptFaultClass} across ${faultClassStreakCount} consecutive attempts — signatures are fresh, the CLASS repeats)`
				: zeroLandedChange
					? "## Zero-change plateau (the attempt landed no file changes — static signal)"
					: crossScopeConflict
						? `## Cross-scope citation (${attempt === 1 ? "first occurrence" : `occurrence on attempt ${attempt}`} — routing immediately per the attempt governor)`
						: "## Recurring failure (identical signature across consecutive attempts)",
			...failureReasons.slice(0, 12),
			"## Implementer's last reasoning tail",
			implTextTail || "(none)",
			"## Structured testDefects reported",
			implDefects.length ? implDefects.map((d) => `${d.testFile}${d.lines ? ` (${d.lines})` : ""}: ${d.reason}`).join("; ") : "(none)",
			"## Confirmed RED in force",
			acceptedRed ? acceptedRed.testFiles.join(", ") : "none",
			"## Test files under contract",
			testFiles.join(", ") || "n/a",
		].join("\n"),
		allowedRoutes: ((csFrame ?? cfFrame)?.allowedRoutes ?? ["challenge-test", "re-author-tests", "continue"]) as JudgeRoute[],
		outputTails: [implTextTail, ...failureReasons],
	});
	if (judgeOut.status === "routed" && judgeOut.verdict.route === "replan-upstream") {
		// v0.3.79 A2: the contradiction valve's plan-revision route — route the
		// replan with the contradiction finding and stop this pass. Wave P1 D-C:
		// a cross-scope conflict carries ITS OWN finding shape.
		const contradictionFinding = csFrame
			? {
				file: null,
				severity: "high",
				title: `cross-scope contract conflict at ${phaseId}: gate failures cite test file(s) owned by ${crossScopeCites.map((c) => `${c.file} (${c.ownerPhases.join(", ")})`).join("; ")}`,
				detail: `The build gate fails on test file(s) declared requireTests of ANOTHER phase (${crossScopeCites.map((c) => `${c.file}: ${c.ownerPhases.join(", ")}`).join("; ")}); every satisfiable fix edits files outside ${phaseId}'s declared scope, which the phase-boundary guard BLOCKS and reverts. Judge diagnosis: ${judgeOut.verdict.diagnosis}`,
				ownerStage: "spec",
			}
			: {
			file: null,
			severity: "high",
			title: `plan contradiction at ${phaseId}: phase-boundary BLOCKING reverts block the only satisfiable fix`,
			detail: `Repeated identical failures while the engine reverted out-of-scope edits into later-phase deliverables (${boundaryLeakFiles.join(", ") || "n/a"} owned by ${boundaryLeakOwners.join(", ") || "later phases"}). Judge diagnosis: ${judgeOut.verdict.diagnosis}`,
			ownerStage: "spec",
		};
		let contradictionReplanned = false;
		try { contradictionReplanned = await triggerReplanForFindings(state, ctx, [contradictionFinding], "implementation", specIdentifier); } catch { contradictionReplanned = false; }
		if (contradictionReplanned) {
			if (csFrame) {
				ctx.log(`Implementation ${phaseId} judge route=replan-upstream: cross-scope contract conflict routed to REPLAN (plan revision) — stopping this pass (cited test file(s) declared by another phase; no attempt can produce improving signal)`);
			} else {
				ctx.log(`Implementation ${phaseId} judge route=replan-upstream: contradiction routed to REPLAN (plan revision) — stopping this pass (${boundaryRevertHits} boundary revert(s) observed)`);
			}
			return { kind: "replan-routed", diagnosis: judgeOut.verdict.diagnosis };
		}
	}
	if (judgeOut.status === "routed" && judgeOut.verdict.route === "challenge-test" && acceptedRed && challengeReauthors < MAX_CHALLENGE_REAUTHORS) {
		const defect = {
			// v0.2.11 F1b: when the verdict carries no machine-verifiable evidence,
			// the diagnosis usually names the culprit test verbatim — prefer that
			// over the phase's own RED file, which is NOT the defect in the
			// cross-spec-contradiction class.
			testFile: judgeOut.verdict.evidence[0]?.file ?? firstCitedTestFile(judgeOut.verdict.diagnosis) ?? acceptedRed.testFiles[0] ?? "",
			lines: "",
			reason: `judge-verified: ${judgeOut.verdict.diagnosis}`,
		};
		ctx.log(`Implementation ${phaseId} judge route=challenge-test: re-authoring RED with the verified diagnosis (${challengeReauthors + 1}/${MAX_CHALLENGE_REAUTHORS})`);
		return { kind: "reauthor", reauthorEvidence: formatReauthorEvidence([defect], implTextTail), challengeConsumed: true };
	}
	if (judgeOut.status === "routed" && judgeOut.verdict.route === "re-author-tests") {
		ctx.log(`Implementation ${phaseId} judge route=re-author-tests: restarting RED with the diagnosis`);
		return {
			kind: "reauthor",
			reauthorEvidence: `\n\n## Judge diagnosis (verified evidence — the RED must be re-authored)\n${judgeOut.verdict.diagnosis}\nEvidence: ${judgeOut.verdict.evidence.map((e) => `${e.file}: ${e.quote}`).join(" | ")}`,
			challengeConsumed: false,
		};
	}
	if (judgeOut.status === "routed" && judgeOut.verdict.route === "continue") {
		ctx.log(`Implementation ${phaseId} judge route=continue: one fresh attempt with diagnosis guidance`);
		return { kind: "continue-guided", judgeGuidance: `## Judge guidance for this attempt (verified diagnosis — act on it)\n${judgeOut.verdict.diagnosis}\nEvidence: ${judgeOut.verdict.evidence.map((e) => `${e.file}: ${e.quote}`).join(" | ")}` };
	}
	// The verified diagnosis (routed-elsewhere or escalate) joins the HITL
	// surface below — region-local carriers, never returned.
	let implJudgeDiagnosis = "";
	let implJudgeEvidenceLabel = "verified evidence";
	if (judgeOut.status === "routed" || judgeOut.status === "escalate") {
		implJudgeDiagnosis = `${judgeOut.verdict.diagnosis}\nEvidence: ${judgeOut.verdict.evidence.map((e) => `${e.file}: ${e.quote}`).join(" | ")}`;
		implJudgeEvidenceLabel = judgeOut.status === "escalate" && judgeOut.verdict.evidence.length === 0 ? "escalated — evidence unverified" : "verified evidence";
	}
	// HITL escalation (parity with gate-exhaustion + verify-stagnation): repeated
	// identical failure is exactly where a human decision helps. Bounded by
	// ESCALATION_RETRY_CAP; never throws; a dismissal/headless run falls through
	// to the terminal no-progress stop.
	const stillRedSuspect = failureReasons.some((r) => r.includes("tdd-targets-still-red"));
	const escalate = (ctx as { options?: { escalate?: Escalate } }).options?.escalate;
	if (escalate) {
		try {
			const { runEscalation, applyRetryDecision } = await import("../../escalation.ts");
			// Fix 3 — evidence conservation: when the structured challenge channel
			// yielded nothing, the implementer's LAST reasoning text may still carry
			// the impossibility proof — surface it raw.
			const implDiagnosisTail = implDefects.length === 0 ? implTextTail.trim() : "";
			// Fix 5 — advisory-only text-proof heuristic (never auto-triggers).
			const textProofSuspect = implDiagnosisTail.length > 0 && acceptedRed !== null && UNSATISFIABLE_TEXT_RE.test(implDiagnosisTail);
			if (textProofSuspect) {
				ctx.log(`Implementation ${phaseId} advisory: implementer text matches unsatisfiability markers without structured testDefects — surfacing the reasoning tail to the user (no automatic re-author from text alone)`);
			}
			const failure: import("../../types.ts").EscalationFailure = {
				kind: "stagnation",
				stage: "implementation",
				message: `Implementation phase "${phaseName}" made no progress across consecutive attempts — the same failure recurred after a change. This is often an unsatisfiable RED test, a gate contradiction, or a spec ambiguity.${crossScopeConflict ? ` THIS FAILURE CITES TEST FILE(S) DECLARED BY ANOTHER PHASE (${crossScopeCites.map((c) => `${c.file} ← ${c.ownerPhases.join(", ")}`).join("; ")}) — a cross-scope contract this phase cannot satisfy inside its declared scope; plan revision (replan) is the likely fix, not another attempt.` : ""}${implDefects.length ? ` THE IMPLEMENTER REPORTS THE RED TEST IS UNSATISFIABLE: ${implDefects.map((d) => `${d.testFile}${d.lines ? ` (${d.lines})` : ""}: ${d.reason}`).join("; ")}.` : ""}${implDiagnosisTail ? `${textProofSuspect ? " POSSIBLE UNSATISFIABLE RED (text evidence only — unverified):" : ""}\n\nImplementer's latest diagnosis (reasoning tail):\n${implDiagnosisTail}` : ""}${implJudgeDiagnosis ? `\n\nJUDGE DIAGNOSIS (${implJudgeEvidenceLabel}):\n${implJudgeDiagnosis}` : ""}${stillRedSuspect && implDefects.length === 0 ? "\n\nDETERMINISTIC TEST-SUSPECT SIGNAL: the phase's RED targets never went green across these repeated no-progress attempts (tdd-targets-still-red). The RED test itself may be unsatisfiable (defective). Legal next actions: re-author the RED with this failure evidence (retry-with-guidance), fix the environment, or accept the limitation." : ""} Inspect the recurring failures or provide explicit guidance before the phase is abandoned.`,
				severity: "soft",
				findings: [
					...(implJudgeDiagnosis ? [{ file: null, severity: null, title: `judge diagnosis: ${implJudgeDiagnosis.split("\n")[0].slice(0, 200)}` }] : []),
					...(implDefects.map((d) => ({ file: d.testFile, severity: null, title: `unsatisfiable: ${d.reason}` }))),
					// J3: the deterministic still-red signal rides even when the
					// implementer reported nothing.
					...(stillRedSuspect ? [{ file: null, severity: null, title: "test-suspect (deterministic): RED targets never went green across repeated no-progress attempts — the RED itself may be unsatisfiable; re-author it with this evidence, fix the environment, or accept the limitation" }] : []),
					// The diagnosis finding leads the failure reasons so it survives
					// the 12-entry slice.
					...(implDiagnosisTail ? [{ file: null, severity: null, title: `implementer diagnosis: ${implDiagnosisTail.split("\n")[0].slice(0, 200)}` }] : []),
					...failureReasons.slice(0, 12).map((r) => ({ file: null, severity: null, title: r })),
				].slice(0, 12),
				worktreePath,
				specDirectory,
			};
			const decision = await runEscalation(state, failure, escalate);
			if (decision) {
				applyRetryDecision(state, decision, { worktreePath, specDirectory });
				if (decision.choice === "retry-with-guidance" && ctx.budget.check()) {
					// Reset the no-progress window so the guided attempt is judged
					// fresh, and drop the accepted RED so guidance can reshape tests
					// too — evidence-backed via the implementer's diagnosis.
					ctx.log(`Implementation ${phaseId} no-progress escalation: retrying with user guidance`);
					return { kind: "retry-with-guidance", reauthorEvidence: formatReauthorEvidence(implDefects, implTextTail) };
				}
			}
		} catch { /* never-throw: fall through to the terminal stop */ }
	}
	// P10 (Wave P1 D-C): the terminal stop names WHICH governor valve fired.
	const noProgressStopClass = signatureRepeat
		? "repeated no-progress failure"
		: faultRecurrence
			? `failure-category recurrence (${attemptFaultClass} × ${faultClassStreakCount} consecutive attempts — fresh footprints, same class)`
			: zeroLandedChange
				? "zero-change plateau (the attempt landed no file changes — static signal)"
				: crossScopeConflict
					? `cross-scope contract conflict (cited test file(s) declared requireTests of ${crossScopeCites.map((c) => `${c.file} ← ${c.ownerPhases.join(", ")}`).join("; ")} — first occurrence routed immediately)`
					: "repeated no-progress failure";
	ctx.log(`Implementation ${phaseId} stopped after ${noProgressStopClass} on attempt ${attempt}: ${failureReasons.join("; ") || "phase gates unmet"}${stillRedSuspect ? " [test-suspect: RED targets never went green across repeated no-progress attempts — the RED itself may be unsatisfiable; re-author it with this evidence or accept the limitation]" : ""}`);
	return { kind: "terminal" };
}
