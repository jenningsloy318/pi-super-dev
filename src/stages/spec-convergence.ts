import { FatalAbort, gateValidator, task } from "../nodes.ts";
import { clearRetryFeedback, setRetryFeedback, withOmissionNotice, type RetryFeedback } from "../retry-feedback.ts";
import type { ControlObj, Node, PipelineState, StageContext } from "../types.ts";
import { enforceReviewerConvergenceDuty, reviewBlockingVerdictFindings } from "../review-findings.ts";
import { renderAndWrite } from "../render/render.ts";
import { isNonRetryableAgentError, nonRetryableAgentSummary } from "../agent-errors.ts";
import {
	blockingConvergenceFindings,
	carriedConvergenceFindings,
	classSweepRetryFeedback,
	convergenceRetryFeedback,
	isActionableOwnerStage,
	markConvergenceFindingsAddressedFromResponses,
	markConvergenceFindingsVerified,
	normalizeConvergenceStage,
	ownerPrecedes,
	recordConvergenceFindings,
	recordReviewFindingsFromControl,
	type ConvergenceOwnerStage,
	getConvergenceLedger,
} from "../convergence-ledger.ts";
import { pendingReplanRequests, consumeReplanRequests } from "../replan/replan.ts";
import { priorFindingsForInjection } from "../convergence-ledger.ts";
import { specReviewWriter, specWriter } from "./writers.ts";
import { MAX_CONVERGENCE_ROUNDS, effectiveRoundCap, extendedRoundCap, judgeEscalateEvidencePresent, deliverCarriedDebt } from "./artifact-convergence.ts";
import { countStageRounds } from "../resume.ts";

const specTask = task(specWriter);
const specReviewTask = task(specReviewWriter);
const validateSpecTrace = gateValidator("gate-spec-trace", "write-spec", "spec");
import { RouteBackSignal } from "../routing/router.ts";
import { planInlineRouteBack } from "../routing/walker.ts";
import { routeBackReentry } from "../routing/journal.ts";
import { fastForwardGate, recordConvergedRevision } from "../routing/revision-gate.ts";
const validateSpecReview = gateValidator("gate-spec-review", "review-spec", "specReview");

function setSpecFeedback(state: PipelineState, source: string, errors: string[]) {
	const feedback: RetryFeedback = {
		stage: "spec",
		gate: source,
		observed: `The latest specification was rejected by ${source}.`,
		expected: "A specification that passes deterministic traceability and approved spec review with no unresolved ambiguity before implementation starts.",
		// v0.3.1 F1 (sd31-SD31-3/F-01): re-attach the compact view's truncation
		// announcement so the slice cannot silence it a second time.
		missing: withOmissionNotice(errors.slice(0, 8), errors),
		diagnostics: errors.slice(8, 12),
		nextAction: "Rewrite the complete specification, implementation plan, and task list; preserve valid content and resolve every rejected trace/review/ambiguity item before calling structured_output. When an item concerns out-of-range acceptance-criteria/scenario identifiers, refer to them ONLY generically (e.g. \"out-of-range AC\") — NEVER spell the identifier itself in any section, including reviewResponses prose (the trace gate ignores response sections, but re-quoting teaches the next round to repeat the token).",
	};
	setRetryFeedback(state as Record<string, unknown>, "spec", [
		feedback,
		...convergenceRetryFeedback(state, { stage: "spec", currentStage: "spec", gate: source }),
		// v0.3.1 F1: class-sweep directive on spec review rejections.
		...classSweepRetryFeedback(state, { stage: "spec", gate: source }),
	]);
}

function clearSpecFeedback(state: PipelineState) {
	clearRetryFeedback(state as Record<string, unknown>, "spec", "specReview");
}

export function compactReviewFindings(review: ControlObj | undefined): string[] {
	const lines: string[] = [];
	if (typeof review?.verdict === "string" && review.verdict.trim()) lines.push(`review verdict: ${review.verdict.trim()}`);
	if (typeof review?.summary === "string" && review.summary.trim()) lines.push(`review summary: ${review.summary.trim()}`);
	const findings = Array.isArray(review?.findings) ? review.findings as Array<Record<string, unknown>> : [];
	for (const finding of findings.slice(0, 8)) {
		const id = typeof finding.id === "string" ? finding.id : "finding";
		const severity = typeof finding.severity === "string" ? finding.severity : "unspecified";
		const title = typeof finding.title === "string" ? finding.title : "untitled";
		const detail = typeof finding.detail === "string" ? finding.detail : "";
		const owner = typeof finding.ownerStage === "string" ? ` owner=${finding.ownerStage}` : "";
		const status = typeof finding.status === "string" ? ` status=${finding.status}` : "";
		const cls = typeof finding.defectClass === "string" && finding.defectClass.trim() ? ` class=${finding.defectClass.trim()}` : "";
		const recommendation = typeof finding.recommendation === "string" ? ` recommendation=${finding.recommendation}` : "";
		lines.push(`review ${id} severity=${severity}${owner}${status}${cls}: ${title}${detail ? ` — ${detail}` : ""}${recommendation}`);
		// v0.3.1 F1: evidence passthrough — the writer can re-verify the way the
		// reviewer falsified it (grounding the revision restores forward movement).
		const evidence = Array.isArray(finding.evidence) ? finding.evidence.filter((e): e is string => typeof e === "string") : [];
		for (const item of evidence.slice(0, 2)) {
			const capped = item.length > 240 ? `${item.slice(0, 240)}…(+${item.length - 240} chars)` : item;
			lines.push(`  evidence: ${capped}`);
		}
	}
	// v0.3.1 F1 (cumora truncation accounting): announce every eviction with its
	// exact count — silent drops make the loss unrecoverable for the writer.
	if (findings.length > 8) lines.push(`…(+${findings.length - 8} more findings omitted from this compact view — read the full review document before revising)`);
	return lines;
}

function ownerForSpecTraceError(error: string): ConvergenceOwnerStage {
	if (/No requirements doc|requirements doc has no AC-NN/i.test(error)) return "requirements";
	if (/No BDD doc|BDD doc has no SCENARIO/i.test(error)) return "bdd";
	if (/task list|implementation plan|phase|spec\./i.test(error)) return "spec";
	return "spec";
}

function recordSpecTraceErrors(state: PipelineState, errors: string[]) {
	recordConvergenceFindings(state, errors.map((error) => ({
		detectedAtStage: "spec",
		ownerStage: ownerForSpecTraceError(error),
		severity: "high",
		blocking: true,
		title: error,
		detail: error,
		evidence: [error],
		sourceGate: "deterministic-trace",
		recommendation: "Rewrite the owning artifact or its trace mapping so downstream implementation receives a complete, grounded contract.",
	})), { detectedAtStage: "spec", ownerStage: "spec", sourceGate: "deterministic-trace" });
}

function recordSpecWriterFailure(state: PipelineState, source: string, error: string) {
	const environment = isNonRetryableAgentError(error);
	recordConvergenceFindings(state, {
		detectedAtStage: "spec",
		ownerStage: environment ? "environment" : "spec",
		severity: environment ? "fatal" : "high",
		blocking: true,
		title: `${source} failed`,
		detail: environment ? nonRetryableAgentSummary(error) : error,
		evidence: [error],
		sourceGate: source,
		recommendation: environment ? "Fix the local agent runtime/PATH before rerunning." : "Use the failure evidence in the next spec convergence attempt.",
	}, { detectedAtStage: "spec", ownerStage: environment ? "environment" : "spec", sourceGate: source });
}

function upstreamBlockingSummary(state: PipelineState): string[] {
	return blockingConvergenceFindings(state)
		.filter((finding) => ownerPrecedes(finding.ownerStage, "spec"))
		.slice(0, 6)
		.map((finding) => `${finding.id} owner=${finding.ownerStage} status=${finding.status}: ${finding.title}`);
}

/**
 * Stage 7/8 convergence: spec writing, deterministic trace validation, and
 * spec-review approval are one budget-bounded loop. A reviewer-only retry cannot
 * fix a bad spec; review failures must feed back into the next spec-writer
 * attempt. The loop is bounded by the hard MAX_CONVERGENCE_ROUNDS liveness cap
 * (shared with artifact-convergence): termination normally comes from trace+
 * review approval, the global run budget, or cancellation, but a stochastic
 * spec-reviewer that never approves is guaranteed to stop at the cap rather than
 * loop forever. See docs/requirements/convergence-loop-unbounded-cap-fix.md.
 */
export const specConvergenceNode: Node = {
	kind: "spec-convergence",
	// M2 addressable-walker anchor (review round-1 code-F-5): the routing
	// sub-walk finds this node by id, mirroring the artifact-convergence nodes.
	id: "spec",
	async run(state: PipelineState, ctx: StageContext) {
		// M3 G4: revision-gate green-skip (see artifact-convergence). The spec's
		// cheap deterministic gate is the trace validator — it re-checks the
		// spec against the CURRENT requirements/BDD docs without agents.
		if (await fastForwardGate(state, ctx, "spec", state.setup?.specDirectory, validateSpecTrace)) {
			return { status: "ok" as const, attempts: 0 };
		}
		let lastErrors: string[] = [];
		let round = 0;
		const maxRounds = MAX_CONVERGENCE_ROUNDS;
		// F3 (RC2): grant a resumed run FRESH rounds after its replay — the old
		// static cap fired right after the cache-hit replay and re-killed the run
		// before the user's new guidance could reach the writer (runs 05-46 /
		// 06-02). Hard cumulative ceiling 3× the base cap.
		const priorRounds = state.setup?.specDirectory ? countStageRounds(state.setup.specDirectory, "pipeline.spec") : 0;
		// v0.3.24 S3 (review-2 F3): a route-back re-entry into spec is a REVISION
		// walk, not a durable resume — grant the segment its full base budget
		// instead of the resume-style prior+cap arithmetic that inflated the
		// deadlocked requirements loop of run 2026-08-28T13-04-28-485Z (same
		// treatment as the artifact loops).
		const segmentReentry = routeBackReentry(state.setup?.specDirectory, "spec");
		let effectiveCap = effectiveRoundCap(maxRounds, segmentReentry ? 0 : priorRounds);
		if (segmentReentry) {
			ctx.log(`spec convergence: route-back re-entry (journal) — round budget reset to segment scope (${maxRounds}); jump budget bounds re-entry cycles`);
		} else if (effectiveCap > maxRounds) ctx.log(`spec convergence: resuming after ${priorRounds} recorded round(s) — round budget extended to ${effectiveCap}`);
		// AC-17 (SCENARIO-038): the recorded REVIEW rounds — strict progress may
		// only arm on a FRESH (cache-miss) review reading.
		const priorReviewRounds = state.setup?.specDirectory ? countStageRounds(state.setup.specDirectory, "pipeline.specReview") : 0;
		// F2 (RC1): strict-progress tracking for the one-shot cap extension.
		let prevOwnOpen = Number.POSITIVE_INFINITY;
		let lastOwnOpen = Number.POSITIVE_INFINITY;
		let progressExtensionUsed = false;
		// F1 (RC3): the upstream-owned blocking signature across consecutive
		// review rounds — 2 identical rounds means the spec writer CANNOT resolve
		// it (it tried twice); route back via replan instead of spinning to the
		// cap (run 05-48/06-02: SR findings owner=requirements/bdd for 8 rounds).
		let priorUpstreamSignature = "";
		// F6 (RC6): consecutive IDENTICAL structural trace errors → repair hint.
		let lastTraceError: string | null = null;
		let sameTraceErrorCount = 0;
		// G1 (adversarial G1-ROUND-COUNTER-CONFLATION): the duty threshold
		// counts REVIEW passes, not loop iterations.
		let reviewRound = 0;
		while (ctx.budget.check()) {
			round++;
			if (ctx.signal?.aborted) return { status: "cancelled" as const };
			// AC-17 (SCENARIO-038): the cap gate also requires a FRESH round —
			// replayed rounds (round ≤ priorRounds) never fatal/extend/replan; at
			// priorRounds ≥ 3×cap exactly ONE fresh writer round executes first.
			if (round > effectiveCap && round > priorRounds + 1) {
				// F2: strict progress at the cap — one bounded extension.
				if (!progressExtensionUsed && prevOwnOpen !== Number.POSITIVE_INFINITY && lastOwnOpen < prevOwnOpen && lastOwnOpen > 0) {
					progressExtensionUsed = true;
					// AC-17 (SCENARIO-037): re-clamped to the 3× ceiling — never 3×cap + 4.
					effectiveCap = extendedRoundCap(effectiveCap, maxRounds);
					ctx.log(`spec convergence: cap extended to ${effectiveCap} — strict progress (own open blocking ${prevOwnOpen === Number.POSITIVE_INFINITY ? "?" : prevOwnOpen} → ${lastOwnOpen})`);
				} else {
					// F1/M5: before the fatal, route upstream-owned blockers back —
					// INLINE only (the emulation is retired for routing).
					const upstreamAtCap = blockingConvergenceFindings(state).filter((f) => ownerPrecedes(f.ownerStage, "spec"));
					if (upstreamAtCap.length > 0) {
						const inlineAtCap = planInlineRouteBack(state.setup?.specDirectory, "spec", upstreamAtCap);
						if (inlineAtCap) {
							ctx.log(`spec convergence: INLINE route-back ${inlineAtCap.from}→${inlineAtCap.to} at round cap (budget checked) — throwing RouteBackSignal for the walker`);
							throw new RouteBackSignal(inlineAtCap);
						}
						ctx.log(`spec convergence: ${upstreamAtCap.length} upstream-owned blocker(s) at round cap but the route-back declined (budget/kill-switch) — proceeding to the honest cap fatal`);
					}
					// Hard liveness floor (see artifact-convergence.ts): a stochastic
					// spec-reviewer that never approves must stop here, not loop forever.
					// Sweep-3 G17 (J10-c parity): ONE verified diagnosis at the cap so
					// the fatal explains WHY — mirrors artifact-convergence's wiring
					// (escalate-now with non-empty evidence may abort early carrying
					// the diagnosis; anything else is advisory and falls through).
					let capJudgeDiagnosis = "";
					try {
						const { runJudge } = await import("./judge.ts");
						const out = await runJudge(ctx, {
							scope: "spec.convergence-cap", // sweep-3 AR2-5: attributed to SPEC, not stage10/verify
							signature: `spec:rounds:${effectiveCap}`,
							worktreePath: state.setup?.worktreePath ?? "",
							specDirectory: state.setup?.specDirectory,
							context: ["## Convergence loop: spec", `round ${round} of effective cap ${effectiveCap}; still not converged.`, "## Recurring errors across rounds", ...(lastErrors.length ? lastErrors.slice(0, 8) : ["(none recorded)"])].join("\n"),
							allowedRoutes: ["escalate-now"],
						});
						if ((out.status === "routed" || out.status === "escalate") && out.verdict.route === "escalate-now" && judgeEscalateEvidencePresent(out.verdict.evidence)) {
							ctx.log(`spec convergence: JUDGE ESCALATE — ${out.verdict.diagnosis}`);
							throw new FatalAbort(`spec convergence did not converge within ${effectiveCap} round(s): ${out.verdict.diagnosis}`);
						}
						const verdict = out.status === "routed" || out.status === "escalate" ? out.verdict : undefined;
						capJudgeDiagnosis = verdict?.diagnosis ? ` — judge: ${String(verdict.diagnosis).slice(0, 300)}` : "";
					} catch (fatal) {
						if (fatal instanceof FatalAbort) throw fatal;
						/* judge unavailable → undiagnosed cap fatal as before */
					}
					const msg = `spec convergence did not converge within ${effectiveCap} round(s)${lastErrors.length ? `: ${lastErrors.join("; ")}` : ""}${capJudgeDiagnosis}`;
					ctx.log(`spec convergence: ROUND CAP (${effectiveCap}) EXHAUSTED (FATAL — aborting run) — ${msg}`);
					throw new FatalAbort(msg);
				}
			}
			ctx.log(`spec convergence: round ${round} starting`);
			delete state.specReview;

			// R3 (dsh-09 v3): pending replan requests owned by spec inject as
			// convergence-ledger findings at round 1 (same machinery as the artifact
			// convergence nodes); approval below flips them to addressed.
			if (round === 1) {
				// v0.3.3 L1: prior-run ledger residue (see artifact-convergence).
				// sd33 self-audit: setSpecFeedback replaces the key's array — merge
				// prior-run and replan lines into ONE call.
				const round1Lines: string[] = [];
				const prior = priorFindingsForInjection(state.setup?.specDirectory);
				if (prior.findings.length > 0 || prior.omitted > 0) {
					// sd33 ADV-SD33-3: record ALL unresolved rows (the file's
					// completeness survives restarts); cap only the FEEDBACK lines.
					recordConvergenceFindings(state, prior.findings.map((f) => ({
						id: f.id,
						ownerStage: f.ownerStage,
						title: f.title,
						detail: f.detail,
						severity: f.severity,
						evidence: f.evidence,
						recommendation: f.recommendation,
						defectClass: f.defectClass,
						status: f.status,
						blocking: true,
					})), { detectedAtStage: "spec", ownerStage: "spec", sourceGate: "prior-run-ledger" });
					round1Lines.push(
						// sd33 CODE-SD33-9: capped at 6 so replan directives fit `missing`.
						...prior.findings.slice(0, 6).map((f) => `[prior-run finding ${f.id}] ${f.title}${f.ownerStage ? ` (owner: ${f.ownerStage})` : ""}`),
						...(prior.omitted > 0 || prior.findings.length > 6 ? [`…(+${Math.max(prior.omitted, prior.findings.length - 6)} more prior-run blocking finding(s) — see .convergence-ledger.json)`] : []),
					);
					ctx.log(`spec convergence: ${prior.findings.length} prior-run blocking finding(s) injected at round 1${prior.omitted > 0 ? ` (+${prior.omitted} omitted)` : ""}`);
				}
				const pendingReplan = pendingReplanRequests(state.setup?.specDirectory, "spec");
				if (pendingReplan.length > 0) {
					recordConvergenceFindings(state, pendingReplan.map((r) => ({
						id: `replan-${r.id}`,
						title: r.title,
						detail: r.requestedRevision,
						severity: r.severity,
						file: r.file,
						status: "open",
						blocking: true,
					})), { detectedAtStage: "replan", ownerStage: "spec", sourceGate: "replan-request" });
					round1Lines.push(...pendingReplan.map((r) => `[replan request ${r.id}] ${r.requestedRevision}`));
					ctx.log(`spec convergence: ${pendingReplan.length} replan request(s) injected at round 1`);
				}
				if (round1Lines.length > 0) setSpecFeedback(state, "prior-run-ledger+replan", round1Lines);
			}

			const specResult = await specTask.run(state, ctx);
			if (specResult.status === "cancelled") return specResult;
			if (specResult.status === "failed") {
				lastErrors = [`spec writer failed: ${specResult.error ?? "unknown error"}`];
				recordSpecWriterFailure(state, "spec writer", specResult.error ?? "unknown error");
				setSpecFeedback(state, "spec writer", lastErrors);
				ctx.log(`spec convergence: ✗ spec writer failed round ${round} — ${lastErrors.join("; ")}`);
				// F2 (adversarial F2-STALE-PROGRESS): no review this round → no fresh
				// blocking-count reading → invalidate the progress signal.
				prevOwnOpen = Number.POSITIVE_INFINITY;
				lastOwnOpen = Number.POSITIVE_INFINITY;
				if (isNonRetryableAgentError(specResult.error)) throw new FatalAbort(nonRetryableAgentSummary(specResult.error));
				continue;
			}
			const addressed = markConvergenceFindingsAddressedFromResponses(state, (state.spec as ControlObj | undefined)?.reviewResponses);
			if (addressed > 0) ctx.log(`spec convergence: spec response matrix addressed ${addressed} prior finding(s)`);

			const trace = await validateSpecTrace(state, ctx);
			if (!trace.pass) {
				lastErrors = trace.errors;
				recordSpecTraceErrors(state, lastErrors);
				// F6 (RC6, run 06-39: "spec.phases must be a non-empty array" ×5
				// rounds): after 2 consecutive IDENTICAL structural errors the
				// corrective re-prompt alone is not landing — append the exact JSON
				// shape so the writer can repair the structure mechanically.
				const structural = lastErrors.find((e) => e.includes("spec.phases must be a non-empty array"));
				if (structural) {
					sameTraceErrorCount = structural === lastTraceError ? sameTraceErrorCount + 1 : 1;
					lastTraceError = structural;
					if (sameTraceErrorCount >= 2) {
						lastErrors = [...lastErrors, "STRUCTURAL REPAIR REQUIRED: return `phases` as a JSON ARRAY of objects, each exactly { 'name': string, 'description': string } — e.g. phases: [ { name: 'Backend sync foundation', description: '…' } ]. Do NOT wrap it in an object, do NOT return a map, do NOT omit it. `tasks` must be an array of { phase: <exact phase.name>, description: string }."];
						ctx.log(`spec convergence: structural phases error repeated ${sameTraceErrorCount}× — injected exact-shape repair hint`);
					}
				} else {
					lastTraceError = null;
					sameTraceErrorCount = 0;
				}
				setSpecFeedback(state, "deterministic trace gate", lastErrors);
				ctx.log(`spec convergence: ✗ trace gate failed round ${round}${lastErrors.length ? ` — ${lastErrors.join("; ")}` : ""}`);
				// F2 (adversarial F2-STALE-PROGRESS): same invalidation.
				prevOwnOpen = Number.POSITIVE_INFINITY;
				lastOwnOpen = Number.POSITIVE_INFINITY;
				continue;
			}
			ctx.log(`spec convergence: trace gate passed round ${round}`);

			const reviewResult = await specReviewTask.run(state, ctx);
			if (reviewResult.status === "cancelled") return reviewResult;
			if (reviewResult.status === "failed") {
				lastErrors = [`spec review failed: ${reviewResult.error ?? "unknown error"}`];
				recordSpecWriterFailure(state, "spec review", reviewResult.error ?? "unknown error");
				setSpecFeedback(state, "spec review", lastErrors);
				ctx.log(`spec convergence: ✗ review failed round ${round} — ${lastErrors.join("; ")}`);
				// F2 (code-review R1): review AGENT failure = no fresh reading.
				prevOwnOpen = Number.POSITIVE_INFINITY;
				lastOwnOpen = Number.POSITIVE_INFINITY;
				if (isNonRetryableAgentError(reviewResult.error)) throw new FatalAbort(nonRetryableAgentSummary(reviewResult.error));
				continue;
			}

			const review = await validateSpecReview(state, ctx);
			// Review-finding fix (adversarial F7-GATE-BYPASS): the gate tests the
			// VERDICT only — it never inspects findings. Approving on the gate alone
			// would let an approve-family verdict ("APPROVED WITH REVISIONS", which
			// F7 legitimately accepts) carrying HIGH/blocking findings converge the
			// spec silently — the findings would never even enter the ledger (they
			// are recorded only on the reject path below). Mirror
			// artifact-convergence: verdict approval AND no blocking finding.
			const specReviewControl = state.specReview as ControlObj | undefined;
			// G1 (run 08-56 moving-target spiral): deterministic convergence-duty
			// enforcement — from REVIEWER_DUTY_ROUND on, NEW non-High blocking
			// findings become advisory before approval is decided (the prompt
			// contract alone could not stop fresh medium blockers from keeping
			// the loop open until the cap killed the run).
			reviewRound++;
			// AC-17 (SCENARIO-038): FRESH review readings only — a replayed reading
			// never arms the strict-progress extension.
			const freshReviewReading = reviewRound > priorReviewRounds;
			const downgraded = enforceReviewerConvergenceDuty(specReviewControl, reviewRound, {
				stage: "spec",
				knownFindingIds: new Set(getConvergenceLedger(state).findings.filter((f) => f.blocking && !f.downgradeReason).map((f) => f.id)),
				// M22 (SCENARIO-068): verbatim restatements of live blocking ledger
				// findings are shielded from the downgrade by convergence fingerprint
				// (the review findings recorded under the "spec-review" source gate).
				knownBlockingFingerprints: new Set(getConvergenceLedger(state).findings.filter((f) => f.blocking && !f.downgradeReason).map((f) => f.fingerprint)),
				reviewSourceGate: "spec-review",
			});
			if (downgraded > 0) {
				ctx.log(`spec convergence: convergence duty enforced — ${downgraded} new non-High blocking finding(s) downgraded to advisory (round ${round})`);
				// B8 (fix-in-pass, SCENARIO-068): the enforcement MUTATED the spec-review
				// control in place — re-render the review doc (per-slug reuse via
				// renderAndWrite, idempotent) so the on-disk artifact matches the
				// enforced classifications. Best-effort: a schema-invalid control renders
				// nothing (null) and a failed write must never kill the loop.
				try {
					if (state.setup && specReviewControl) renderAndWrite(state.setup, (m) => ctx.log(m), "specReview", specReviewControl as Record<string, unknown>);
				} catch { /* best-effort re-render */ }
			}
			// G1 (code-review G1-GATE-OVERRIDE): a downgrade-approval may
			// override ONLY the verdict-wording failure — review-DOC shape
			// errors (missing dimensions/doc) are real gate failures that must
			// still reject. And per F-A verdict pinning, needs-human findings
			// pin approval only via their own blocking flag / high severity.
			const shapeErrors = (review.errors ?? []).filter((e) => !e.startsWith("Verdict is"));
			// M8 (SCENARIO-039/040): the gate's own verdict pass is the GENUINE
			// approval signal — a duty override may converge the loop, but replan
			// consumption and the replan verified-flip below gate on review.pass alone.
			const genuineApproval = review.pass;
			// v0.3.24 S1: owner-aware verdict gate (mirrors artifact-convergence) — the
			// spec loop may only be pinned by spec-owned or upstream-owned findings;
			// blocking findings owned downstream (implementation/verification/…)
			// are carried debt that re-injects at the owner's round 1.
			const specVerdictBlocking = reviewBlockingVerdictFindings(specReviewControl);
			const specVerdictCarried = specVerdictBlocking.filter((f) => !isActionableOwnerStage((f as { ownerStage?: unknown }).ownerStage, "spec"));
			// actionable verdict-blockers (own/upstream/unknown owner) still pin the
			// verdict exactly as before — ONLY the downstream-owned subset stops pinning.
			const approved = (review.pass || (downgraded > 0 && shapeErrors.length === 0)) && (specVerdictBlocking.length - specVerdictCarried.length) === 0;
			if (review.pass && !approved) ctx.log("spec convergence: review verdict approved but blocking finding(s) are present — treating as rejection");
			if (!approved && specVerdictCarried.length > 0 && shapeErrors.length === 0) {
				// v0.3.24 S2: deterministic wait-for-graph resolution — every open
				// blocking finding is owned downstream of spec. Exit
				// CONVERGED-CARRIED; the walk continues to the owner. The
				// shapeErrors guard (review-2 F4): a malformed/missing review
				// document means the review never validly happened — it must not
				// convert into a carried pass; that path stays an honest cap fatal.
				const specActionableOpen = blockingConvergenceFindings(state).filter((f) => isActionableOwnerStage(f.ownerStage, "spec"));
				if (specActionableOpen.length === 0 && specVerdictBlocking.length === specVerdictCarried.length) {
					recordReviewFindingsFromControl(state, specReviewControl, { detectedAtStage: "specReview", ownerStage: "spec", sourceGate: "spec-review-carried" });
					clearSpecFeedback(state);
					ctx.log(`spec convergence: CONVERGED-CARRIED (round ${round}) — every open blocking finding is owned downstream (${carriedConvergenceFindings(state, "spec").map((f) => `${f.id} owner=${f.ownerStage}`).join(", ")}); the walk continues to the owner stage, where they re-inject at its round 1.`);
					// review-2 F1: DELIVER the debt (pending replan requests + owner
					// revision bump); never recordConvergedRevision on a carried exit —
					// only a genuine approval may make the artifact green-skippable.
					deliverCarriedDebt(state, "spec", ctx.log);
					return { status: "ok" as const, attempts: round };
				}
			}
			if (approved) {
				// G1: a downgrade-approval still records the advisory findings
				// (audit trail) before the verified flip discards them.
				if (downgraded > 0) {
					recordReviewFindingsFromControl(state, specReviewControl, { detectedAtStage: "specReview", ownerStage: "spec", sourceGate: "spec-review" });
					ctx.log(`spec convergence: ${downgraded} downgraded finding(s) recorded as advisory on approval`);
				}
				// v0.3.24 S1: approval carrying downstream debt records it, and the
				// flip below skips non-actionable rows so the debt survives for the owner.
				if (specVerdictCarried.length > 0) {
					recordReviewFindingsFromControl(state, specReviewControl, { detectedAtStage: "specReview", ownerStage: "spec", sourceGate: "spec-review-carried" });
					ctx.log(`spec convergence: ✓ trace + review approved round ${round} with ${specVerdictCarried.length} carried downstream-owned blocking finding(s) — they remain open for the owner stage`);
				}
				markConvergenceFindingsVerified(state, (finding) => {
					if (finding.downgradeReason) return false; // duty-enforced advisories stay visible in the ledger
					if (!isActionableOwnerStage(finding.ownerStage, "spec")) return false; // v0.3.24 S1: carried debt stays open
					const detected = normalizeConvergenceStage(finding.detectedAtStage, "implementation");
					return detected === "spec" || detected === "specReview" || (genuineApproval && String(finding.detectedAtStage) === "replan");
				});
				clearSpecFeedback(state);
				if (genuineApproval) {
					// R3 (SCENARIO-040): the spec reviewer's GENUINE approval verifies the
					// revision — flip the persisted requests to addressed only now (never on
					// a duty override — SCENARIO-039).
					const consumedReplan = consumeReplanRequests(state.setup?.specDirectory, "spec");
					if (consumedReplan > 0) ctx.log(`spec convergence: ${consumedReplan} replan request(s) verified and marked addressed`);
				}
				ctx.log(`spec convergence: ✓ trace + review approved (round ${round}${round > 1 ? ", after feedback" : ""})`);
				recordConvergedRevision(state, "spec", state.setup?.specDirectory);
				return { status: "ok" as const, attempts: round };
			}

			recordReviewFindingsFromControl(state, state.specReview as ControlObj | undefined, { detectedAtStage: "specReview", ownerStage: "spec", sourceGate: "spec-review" });
			lastErrors = [...review.errors, ...compactReviewFindings(state.specReview as ControlObj | undefined)];
			const upstream = upstreamBlockingSummary(state);
			if (upstream.length) lastErrors.push(`upstream-owned blocking findings remain: ${upstream.join("; ")}`);
			// F2: track own open blocking count for the strict-progress extension —
			// FRESH readings only (AC-17: replayed readings carry no fresh signal).
			if (freshReviewReading) {
				prevOwnOpen = lastOwnOpen;
				lastOwnOpen = blockingConvergenceFindings(state).filter((f) => f.ownerStage === "spec").length;
			} else {
				prevOwnOpen = Number.POSITIVE_INFINITY;
				lastOwnOpen = Number.POSITIVE_INFINITY;
			}
			// F1 (RC3): identical upstream-owned signature twice in a row — the
			// spec writer has had its chance; route back to the owning stages via
			// the replan circuit (bounded restart, auto-resume) instead of
			// spinning to the cap. The gate-spec-review path has NO HITL surface
			// at all today (runs 05-48 / 06-02: 4 SR findings owner=requirements
			// re-raised every round to the cap).
			const upstreamFindings = blockingConvergenceFindings(state).filter((f) => ownerPrecedes(f.ownerStage, "spec"));
			const upstreamSignature = upstreamFindings.map((f) => f.fingerprint).sort().join("|");
			if (upstreamSignature.length > 0 && upstreamSignature === priorUpstreamSignature) {
				// M3 pilot (spec→upstream, runs 05-48/06-02): flag ON (default) +
				// exactly one strictly-upstream routable owner + edge budget →
				// INLINE route-back. Kill-switch / out-of-scope → the replan
				// emulation below runs byte-identical (G8).
				const inlineCmd = planInlineRouteBack(state.setup?.specDirectory, "spec", upstreamFindings);
				if (inlineCmd) {
					ctx.log(`spec convergence: INLINE route-back ${inlineCmd.from}→${inlineCmd.to} (budget checked) — throwing RouteBackSignal for the walker`);
					throw new RouteBackSignal(inlineCmd);
				}
				// M5: the emulation is retired for routing — a declined jump falls
				// through to the review-rejected round (the cap fatal remains the
				// honest liveness floor).
			}
			priorUpstreamSignature = upstreamSignature;
			setSpecFeedback(state, "spec review", lastErrors);
			ctx.log(`spec convergence: ✗ review gate failed round ${round}${lastErrors.length ? ` — ${lastErrors.join("; ")}` : ""}`);
		}

		const msg = `spec convergence stopped before approval because the global agent budget was exhausted after ${round} round(s)${lastErrors.length ? `: ${lastErrors.join("; ")}` : ""}`;
		ctx.log(`spec convergence: BUDGET EXHAUSTED (FATAL — aborting run) — ${msg}`);
		throw new FatalAbort(msg);
	},
};
