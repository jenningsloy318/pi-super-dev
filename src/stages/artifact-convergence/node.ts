import { blockingSignature, compactReviewFindings, deliverCarriedDebt, getEscalate, judgeEscalateEvidencePresent, readRenderErrors, recordArtifactErrors, reviewVerdictApproves, setArtifactFeedback, setReviewFeedback } from "./feedback.ts";
import { MAX_TOTAL_ROUND_MULTIPLE, effectiveRoundCap, extendedRoundCap } from "./rounds.ts";
import { ArtifactConvergenceOptions, MAX_CONVERGENCE_ROUNDS } from "./validators.ts";
/** node — the artifactConvergenceNode state machine (split from artifact-convergence.ts at v0.4.17e). */
import { AGENT_ERROR_FATAL_CONSECUTIVE, agentErrorTextsSince, FatalAbort, task } from "../../nodes.ts";
import { clearRetryFeedback, setRetryFeedback } from "../../retry-feedback.ts";
import type { ControlObj, EscalationFailure, Node, PipelineState, Stage, StageContext } from "../../types.ts";
import { isNonRetryableAgentError, nonRetryableAgentSummary } from "../../agent-errors.ts";
import { enforceReviewerConvergenceDuty, reviewBlockingVerdictFindings } from "../../review-findings.ts";
import { consumeContractConflictEscalation } from "../../review/contract-conflict-consumer.ts";
import { readContractSliceStamp } from "../../review/contract-surface/index.ts";
import { isWriterMetadataRejection, writerMetadataRepairFeedback, writerMetadataStrikeKey } from "../../review/contract-validators.ts";
import { renderAndWrite } from "../../render/render.ts";
import { priorFindingsForInjection } from "../../convergence-ledger.ts";
import { adjudicateFindingResolutionGate } from "../../convergence-economy/finding-resolution-gate.ts";
import { applyRetryDecision, escalationBudgetRemaining, runEscalation } from "../../escalation.ts";
import { runJudge } from "../judge.ts";
import { countStageRounds } from "../../resume.ts";
import { blockingConvergenceFindings, carriedConvergenceFindings, isActionableOwnerStage, markConvergenceFindingsAddressedFromResponses, markConvergenceFindingsVerified, normalizeConvergenceStage, ownerPrecedes, recordConvergenceFindings, recordReviewFindingsFromControl, getConvergenceLedger } from "../../convergence-ledger.ts";
import { pendingReplanRequests, consumeReplanRequests } from "../../replan/replan.ts";
import { RouteBackSignal, isRoutableOwnerStage } from "../../routing/router.ts";
import { appendUserNotes } from "../../render/user-notes.ts";
import { fastForwardGate, recordConvergedRevision } from "../../routing/revision-gate.ts";
import { planInlineRouteBack } from "../../routing/walker.ts";
import { autoRouteBackEnabled, routeBackReentry } from "../../routing/journal.ts";
export function artifactConvergenceNode(options: ArtifactConvergenceOptions): Node {
	const stageTask = task(options.stage);
	const reviewTask = options.review ? task(options.review.stage) : null;
	return {
		kind: `${options.feedbackKey}-convergence`,
		// M2 addressable-walker anchor: the routing sub-walk finds this node by id.
		id: options.feedbackKey,
		async run(state: PipelineState, ctx: StageContext) {
			// M3 G4: revision-gate green-skip. After an inline route-back jump,
			// stages between the owner and the thrower already converged this
			// process with an UNCHANGED artifact revision and no pending
			// requests — re-running their full writer+reviewer loop is pure
			// waste. The gate fires only when a jump was journaled (inert on
			// fresh/kill-switch runs) AND the stage's deterministic validator
			// re-passes against CURRENT upstream state (research has no
			// validator → never fast-forwards → conservatively re-runs).
			if (options.fastForwardable === true && await fastForwardGate(state, ctx, options.feedbackKey, state.setup?.specDirectory, options.validate)) {
				return { status: "ok" as const, attempts: 0 };
			}
			const maxRounds = options.maxRounds ?? MAX_CONVERGENCE_ROUNDS;
			// F3 (RC2): a resumed run REPLAYS this loop's prior rounds as cache hits
			// (rebuilding retry feedback + ledger state) and must then get FRESH
			// rounds — the old static cap fired right after the replay and re-killed
			// the run before any fresh call (runs 02-47 / 06-02). countStageRounds
			// reads the persisted occurrence count; fresh runs see 0.
			const priorRounds = state.setup?.specDirectory ? countStageRounds(state.setup.specDirectory, `pipeline.${options.stage.id}`) : 0;
			// v0.3.24 S3: a route-back re-entry is a REVISION walk, not a durable
			// resume — the recorded rounds belong to a PREVIOUS walk segment, and
			// granting them the resume-style `prior + cap` budget inflated run
			// 2026-08-28T13-04-28-485Z's deadlocked requirements loop from its base
			// cap to 8 rounds before the fatal. Reset to segment scope; repeated
			// re-entries stay bounded by the per-edge JUMP budget (the walker's
			// anti-ping-pong bound), not by replayed-round arithmetic.
			const segmentReentry = routeBackReentry(state.setup?.specDirectory, options.feedbackKey);
			let effectiveCap = effectiveRoundCap(maxRounds, segmentReentry ? 0 : priorRounds);
			if (segmentReentry) {
				ctx.log(`${options.feedbackKey} convergence: route-back re-entry (journal) — round budget reset to segment scope (${maxRounds}); jump budget bounds re-entry cycles`);
			} else if (effectiveCap > maxRounds) ctx.log(`${options.feedbackKey} convergence: resuming after ${priorRounds} recorded round(s) — round budget extended to ${effectiveCap} (replayed rounds do not consume the fresh budget)`);
			// AC-17 (SCENARIO-038): the recorded REVIEW rounds of THIS loop — strict
			// progress may only arm on a FRESH (cache-miss) review reading; a replayed
			// reading carries no fresh information and must never earn the extension.
			const priorReviewRounds = options.review && state.setup?.specDirectory
				? countStageRounds(state.setup.specDirectory, `pipeline.${options.review.stage.id}`)
				: 0;
			let round = 0;
			// v0.4.60 WS1 (066 §2): the ids this walk injected at round 1 (prior-run
			// ledger + replan requests, post-downgrade stamped) — the finding-
			// resolution gate's injected set. Empty for no-injection specs (the gate
			// is then inert).
			let round1InjectedIds: string[] = [];
			let lastErrors: string[] = [];
			let priorBlockingSignature = "";
			let convergenceJudgeTried = false;
			// F2: strict-progress tracking — the count of this stage's OWN open
			// blocking findings across consecutive rounds, plus the one-shot
			// extension flag.
			let prevOwnOpen = Number.POSITIVE_INFINITY;
			let lastOwnOpen = Number.POSITIVE_INFINITY;
			let progressExtensionUsed = false;
			const ownStage = normalizeConvergenceStage(options.feedbackKey, options.feedbackKey);
			// G1 (adversarial G1-ROUND-COUNTER-CONFLATION): the duty threshold
			// counts REVIEW passes, not loop iterations — validation-failure
			// rounds run no reviewer and must not consume the reviewer's free
			// early passes.
			let reviewRound = 0;
			// v0.3.65 (incident 2026-09-04T13-45-10, P5 class fix): consecutive
			// agent-error rounds per role. A dead writer or reviewer runtime must
			// abort with the infra error NAMED — never masquerade as artifact
			// rejections spinning rounds to the cap. Only FRESH rounds count
			// (round > priorRounds, the cap gate's convention): replayed cache hits
			// carry no new evidence and a fixed runtime must be allowed to recover.
			let consecutiveWriterAgentErrors = 0;
			let consecutiveReviewAgentErrors = 0;
			while (ctx.budget.check()) {
				round++;
				if (ctx.signal?.aborted) return { status: "cancelled" as const };
			// J10-c (judge routing layer): one round before the cap, ONE verified
			// diagnosis so the fatal message explains WHY convergence failed — the
			// judge can only abort early (escalate-now) with its diagnosis attached,
			// never extend the cap or touch the writer loop.
			// F3 (code-review R4): anchor on the EFFECTIVE cap, not the base cap — a
			// resumed run replays cached rounds 1..k; a judge call cached at base
			// round maxRounds-1 would replay its fatal verdict BEFORE the fresh
			// round budget (effectiveCap) is ever reached. effectiveCap === maxRounds
			// on a fresh run, so behavior there is unchanged.
			if (round === effectiveCap - 1 && !convergenceJudgeTried) {
					convergenceJudgeTried = true;
					try {
						const out = await runJudge(ctx, {
							scope: `stage10.convergence-cap.${options.feedbackKey}`,
							signature: priorBlockingSignature || `${options.feedbackKey}:rounds`,
							worktreePath: state.setup?.worktreePath ?? "",
							specDirectory: state.setup?.specDirectory,
							context: [
								`## Convergence loop: ${options.feedbackKey}`,
								`round ${round} of cap ${maxRounds}; still not converged.`,
								"## Recurring errors across rounds",
								...(lastErrors.length ? lastErrors.slice(0, 8) : ["(none recorded)"]),
							].join("\n"),
							allowedRoutes: ["escalate-now"],
						});
						if ((out.status === "routed" || out.status === "escalate") && out.verdict.route === "escalate-now") {
							// B4 (D10): an escalate-now verdict may only abort the run when it
							// carries at least one NON-EMPTY evidence entry — an evidence-less
							// diagnosis (the judge's degrade-to-escalate path) is advisory, not
							// fatal; log it and fall through to the normal cap path.
							// v0.3.24 S4-4: widened from quote-only via judgeEscalateEvidencePresent.
							const hasEvidence = judgeEscalateEvidencePresent(out.verdict.evidence);
							if (hasEvidence) {
								ctx.log(`${options.feedbackKey} convergence: JUDGE ESCALATE — ${out.verdict.diagnosis}`);
								// D10: the fatal reports the EFFECTIVE cap (replayed rounds
								// included), never the base maxRounds.
								throw new FatalAbort(`${options.feedbackKey} convergence did not converge within ${effectiveCap} round(s): ${out.verdict.diagnosis}`);
							}
							ctx.log(`${options.feedbackKey} convergence: judge escalate-now verdict carried no verbatim evidence — falling through to the round-cap path`);
						}
					} catch (err) {
						if (err instanceof FatalAbort) throw err;
						/* INV-6: judge infra failure never blocks the loop */
					}
				}
				// AC-17 (SCENARIO-038): the cap gate also requires a FRESH round —
				// replayed rounds (round ≤ priorRounds) never fatal/extend/replan, so at
				// priorRounds ≥ 3×cap exactly ONE fresh writer round (priorRounds + 1)
				// executes before the fatal at priorRounds + 2 (fresh-run behavior is
				// unchanged: priorRounds = 0 ⇒ the gate is round > 1).
				if (round > effectiveCap && round > priorRounds + 1) {
					// F2 (RC1): strict progress at the cap — the loop resolved more of
					// its own blockers than it gained last round. Grant ONE bounded
					// extension instead of killing productive work (run 02-16 resolved
					// findings every round and still hit the cap's FatalAbort).
					if (!progressExtensionUsed && prevOwnOpen !== Number.POSITIVE_INFINITY && lastOwnOpen < prevOwnOpen && lastOwnOpen > 0) {
						progressExtensionUsed = true;
						// AC-17 (SCENARIO-037): the extension is re-clamped to the 3× ceiling.
						const priorCap = effectiveCap;
						effectiveCap = extendedRoundCap(effectiveCap, maxRounds);
						// P10 (v0.3.56 F9b): at the ceiling extendedRoundCap returns the SAME
						// value — the old log claimed "cap extended" when nothing extended.
						const progressDetail = `strict progress (own open blocking ${prevOwnOpen === Number.POSITIVE_INFINITY ? "?" : prevOwnOpen} → ${lastOwnOpen})`;
						ctx.log(effectiveCap > priorCap
							? `${options.feedbackKey} convergence: cap extended to ${effectiveCap} — ${progressDetail}`
							: `${options.feedbackKey} convergence: extension granted but the cap already sits at the ${maxRounds}×${MAX_TOTAL_ROUND_MULTIPLE} ceiling — cap stays ${effectiveCap} — ${progressDetail}`);
					} else {
						// F1/M5: before the fatal, route upstream-owned blockers back —
						// INLINE only (the emulation is retired for routing; the extension
						// auto-restart survives solely for the RED-site lead and genuine
						// cross-run interruptions). A declined jump proceeds to the honest
						// cap fatal below (the escalation surface already fired in-loop).
						// v0.3.48: non-routable upstream owners (classify) cannot drive a cap
						// route either — exclude them from the cap-escalation predicate (they
						// were downgraded to carried advisory at the review site).
						const upstreamAtCap = blockingConvergenceFindings(state).filter((f) => isRoutableOwnerStage(f.ownerStage) && ownerPrecedes(f.ownerStage, ownStage));
						if (upstreamAtCap.length > 0) {
							const inlineAtCap = planInlineRouteBack(state.setup?.specDirectory, options.feedbackKey, upstreamAtCap);
							if (inlineAtCap) {
								ctx.log(`${options.feedbackKey} convergence: INLINE route-back ${inlineAtCap.from}→${inlineAtCap.to} at round cap (budget checked) — throwing RouteBackSignal for the walker`);
								throw new RouteBackSignal(inlineAtCap);
							}
							ctx.log(`${options.feedbackKey} convergence: ${upstreamAtCap.length} upstream-owned blocker(s) at round cap but the route-back declined (budget/kill-switch) — proceeding to the honest cap fatal`);
						}
						// Unconditional liveness floor. The stall path below routes ACTIONABLE
						// stagnation (a recurring blocking finding) to HITL escalation; this cap
						// is the safety net for NON-actionable non-convergence (e.g. a stochastic
						// reviewer that never approves). It FatalAborts exactly like the global-
						// budget-exhaustion path below — deliberately NOT escalating, so it does
						// NOT consume the shared `stagnation:<feedbackKey>` escalation budget
						// (ESCALATION_RETRY_CAP) that the stall path relies on.
						const msg = `${options.feedbackKey} convergence did not converge within ${effectiveCap} round(s)${lastErrors.length ? `: ${lastErrors.join("; ")}` : ""}`;
						ctx.log(`${options.feedbackKey} convergence: ROUND CAP (${effectiveCap}) EXHAUSTED (FATAL — aborting run) — ${msg}`);
						throw new FatalAbort(msg);
					}
				}
				ctx.log(`${options.feedbackKey} convergence: round ${round} starting`);
				if (options.review) delete (state as Record<string, unknown>)[options.review.reviewStateKey];
				// M8 (SCENARIO-039/040): true when THIS round's convergence is a genuine
				// reviewer approval. Defaults to true for review-less loops (research):
				// with no reviewer verdict, the deterministic gate's pass IS the approval
				// and replan consumption keeps its existing behavior.
				let genuineApproval = !options.review;

				// R3 (dsh-09 v3): pending replan requests owned by this stage inject as
				// convergence-ledger findings at round 1 — the EXISTING
				// writer-revises-per-finding machinery performs the revision. Dedup by
				// fingerprint keeps restarts idempotent.
				if (round === 1) {
					// v0.3.3 L1: unresolved BLOCKING findings from a prior run's
					// persisted ledger inject at round 1 (the resume/restart path —
					// the ledger itself restarts empty, but its residue must not).
					// Fingerprint merge in recordConvergenceFindings keeps this
					// idempotent across repeated restarts. sd33 self-audit: feedback
					// calls REPLACE the key's array (setRetryFeedback), so the
					// prior-run lines and the replan lines below must be merged into
					// ONE setArtifactFeedback call or the second wipes the first.
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
						})), { detectedAtStage: options.feedbackKey, ownerStage: normalizeConvergenceStage(options.feedbackKey, options.feedbackKey), sourceGate: "prior-run-ledger" });
						round1Lines.push(
							// sd33 CODE-SD33-9: prior-run lines capped at 6 so replan
							// directives (below) always fit the feedback `missing` slice.
							...prior.findings.slice(0, 6).map((f) => `[prior-run finding ${f.id}] ${f.title}${f.ownerStage ? ` (owner: ${f.ownerStage})` : ""}`),
							...(prior.omitted > 0 || prior.findings.length > 6 ? [`…(+${Math.max(prior.omitted, prior.findings.length - 6)} more prior-run blocking finding(s) — see .convergence-ledger.json)`] : []),
						);
						ctx.log(`${options.feedbackKey} convergence: ${prior.findings.length} prior-run blocking finding(s) injected at round 1${prior.omitted > 0 ? ` (+${prior.omitted} omitted)` : ""}`);
					}
					const pendingReplan = pendingReplanRequests(state.setup?.specDirectory, options.feedbackKey);
					if (pendingReplan.length > 0) {
						recordConvergenceFindings(state, pendingReplan.map((r) => ({
							id: `replan-${r.id}`,
							title: r.title,
							detail: r.requestedRevision,
							severity: r.severity,
							file: r.file,
							status: "open",
							blocking: true,
						})), { detectedAtStage: "replan", ownerStage: normalizeConvergenceStage(options.feedbackKey, options.feedbackKey), sourceGate: "replan-request" });
						round1Lines.push(...pendingReplan.map((r) => `[replan request ${r.id}] ${r.requestedRevision}`));
						ctx.log(`${options.feedbackKey} convergence: ${pendingReplan.length} replan request(s) injected at round 1`);
					}
					// v0.4.60 WS1: capture the injected id set for the gate (replan ids
					// take the replan- prefix the ledger rows get).
					round1InjectedIds = [...prior.findings.map((f) => f.id), ...pendingReplan.map((r) => `replan-${r.id}`)];
					// Replan directives lead (they are explicit revision orders);
					// prior-run residue follows within the slice budget.
					if (round1Lines.length > 0) setArtifactFeedback(options, state, round1Lines);
				}

				const resultsBeforeWriter = ctx.results.length;
				const stageResult = await stageTask.run(state, ctx);
				if (stageResult.status === "cancelled") return stageResult;
				if (stageResult.status === "failed") {
					lastErrors = [`${options.feedbackKey} agent failed: ${stageResult.error ?? "unknown error"}`];
					recordArtifactErrors(options, state, lastErrors, `${options.feedbackKey}-agent`);
					setArtifactFeedback(options, state, lastErrors);
					ctx.log(`${options.feedbackKey} convergence: agent failed round ${round} — ${lastErrors.join("; ")}`);
					// F2 (adversarial F2-STALE-PROGRESS): a round that ended without a
					// review produces no fresh blocking-count reading — invalidate the
					// progress signal so the cap extension cannot fire on stale data.
					prevOwnOpen = Number.POSITIVE_INFINITY;
					lastOwnOpen = Number.POSITIVE_INFINITY;
					if (isNonRetryableAgentError(stageResult.error)) throw new FatalAbort(nonRetryableAgentSummary(stageResult.error));
					continue;
				}
				// v0.3.65: G21 marks WRITER agent errors as ok + empty control + a
				// cause:"agent-error" row. Without this check the empty control fell
				// through to the validators — the generic validation messages masked
				// the real infra cause and spun rounds (incident 2026-09-04T13-45-10:
				// every design/designReview child died <250 ms on version skew).
				const writerAgentErrors = agentErrorTextsSince(ctx, resultsBeforeWriter, options.stage.id);
				if (writerAgentErrors.length > 0) {
					const freshWriterError = round > priorRounds;
					const writerAgentError = writerAgentErrors[writerAgentErrors.length - 1];
					if (isNonRetryableAgentError(writerAgentError)) throw new FatalAbort(nonRetryableAgentSummary(writerAgentError));
					if (freshWriterError) consecutiveWriterAgentErrors++;
					if (consecutiveWriterAgentErrors >= AGENT_ERROR_FATAL_CONSECUTIVE) {
						const msg = `${options.feedbackKey} convergence: writer agent errored ${consecutiveWriterAgentErrors} consecutive round(s) — infra failure, not an artifact defect (last error: ${writerAgentError})`;
						ctx.log(msg);
						throw new FatalAbort(msg);
					}
					lastErrors = [`${options.feedbackKey} writer agent errored: ${writerAgentError}`];
					recordArtifactErrors(options, state, lastErrors, `${options.feedbackKey}-agent`);
					setArtifactFeedback(options, state, lastErrors);
					ctx.log(`${options.feedbackKey} convergence: ✗ writer agent errored round ${round}${freshWriterError ? ` (${consecutiveWriterAgentErrors}/${AGENT_ERROR_FATAL_CONSECUTIVE} consecutive)` : " (replayed — not counted)"} — ${writerAgentError}`);
					prevOwnOpen = Number.POSITIVE_INFINITY;
					lastOwnOpen = Number.POSITIVE_INFINITY;
					continue;
				}
				consecutiveWriterAgentErrors = 0;
				// v0.4.60 WS1 (066 §2) — the finding-resolution gate: the E1 class (an
				// injected blocking finding unaddressed by the writer, receipt run
				// 2026-09-20T07-37-57-688Z: rediscovered ~80 min and 3 agent calls
				// later at BDD review) bounces the writer ONCE with the exact missing
				// ids BEFORE any reviewer pass. P5 fail-open (a gate crash logs
				// advisory and proceeds); P8 bound = 1 bounce per walk; the
				// re-dispatch consumes agent budget, NOT a convergence round.
				if (round1InjectedIds.length > 0) {
					let frGate: ReturnType<typeof adjudicateFindingResolutionGate> | null = null;
					try {
						const ctrlCandidate = ((stageResult as { control?: unknown } | null | undefined)?.control
							?? (state as Record<string, unknown>)[options.stage.id]) as { findingResolutions?: unknown } | null | undefined;
						frGate = adjudicateFindingResolutionGate({ injectedIds: round1InjectedIds, resolutions: ctrlCandidate?.findingResolutions });
					} catch (error) {
						ctx.log(`${options.feedbackKey} convergence: finding-resolution gate crashed (advisory — proceeding): ${error instanceof Error ? error.message : String(error)}`);
					}
					if (frGate?.bounce) {
						ctx.log(`${options.feedbackKey} convergence: ${frGate.feedback} — one bounded writer re-dispatch follows (agent budget, not a convergence round)`);
						setArtifactFeedback(options, state, [frGate.feedback]);
						const bounceResult = await stageTask.run(state, ctx);
						if (bounceResult.status === "cancelled") return bounceResult;
						if (bounceResult.status === "failed") {
							lastErrors = [`${options.feedbackKey} agent failed (post-bounce): ${bounceResult.error ?? "unknown error"}`];
							recordArtifactErrors(options, state, lastErrors, `${options.feedbackKey}-agent`);
							setArtifactFeedback(options, state, lastErrors);
							ctx.log(`${options.feedbackKey} convergence: bounced writer failed round ${round} — ${lastErrors.join("; ")}`);
							prevOwnOpen = Number.POSITIVE_INFINITY;
							lastOwnOpen = Number.POSITIVE_INFINITY;
							continue;
						}
					} else if (frGate && frGate.missing.length > 0) {
						ctx.log(`${options.feedbackKey} convergence: finding-resolution gate — ${frGate.missing.length} injected finding(s) unaddressed (gate disabled or bounce spent); proceeding to validation/review with the gap recorded: ${frGate.missing.join(", ")}`);
					}
				}

				// Stage produced no artifact by design (e.g. design skipped for a bug
				// fix): nothing to validate or review — converge immediately.
				if (options.skipped?.(state)) {
					clearRetryFeedback(state as Record<string, unknown>, options.feedbackKey);
					ctx.log(`${options.feedbackKey} convergence: skipped (no artifact produced) — complete (round ${round})`);
					recordConvergedRevision(state, options.feedbackKey, state.setup?.specDirectory);
					return { status: "ok" as const, attempts: round };
				}

				// The writer reported ok but produced NO artifact (returned null — e.g. a
				// selected designer timed out). This is a FAILURE, not a skip: retry so a
				// missing artifact never slips past the deterministic + review gates.
				// v0.3.32: when the stage recorded schema/render errors (design.ts /
				// writerTask), surface THOSE — the generic "empty/failed output" line
				// starved the retries of the one actionable fact (which field, which
				// type) in runs 2026-08-30T00-10-34 (aborted after 6 rounds) and
				// 03-23-40 (8 wasted rounds before a lucky valid control).
				const renderErrs = readRenderErrors(state);
				if ((state as Record<string, unknown>)[options.feedbackKey] == null) {
					lastErrors = renderErrs.length > 0
						? [`${options.feedbackKey} control rejected by schema/render validation — fix these exact fields:`, ...renderErrs]
						: [`${options.feedbackKey} agent produced no artifact (empty/failed output)`];
					recordArtifactErrors(options, state, lastErrors, renderErrs.length > 0 ? `${options.feedbackKey}-render` : `${options.feedbackKey}-empty`);
					setArtifactFeedback(options, state, lastErrors);
					ctx.log(`${options.feedbackKey} convergence: ✗ no artifact produced round ${round}${renderErrs.length > 0 ? ` — ${renderErrs.join("; ")}` : " — retrying"}`);
					// F2 (code-review R1): no artifact = no review = no fresh reading.
					prevOwnOpen = Number.POSITIVE_INFINITY;
					lastOwnOpen = Number.POSITIVE_INFINITY;
					continue;
				}

				// Apply the writer's response matrix to the convergence ledger (mirrors
				// spec-convergence): a prior finding the rewrite claims to have addressed
				// is marked addressed so it stops being re-injected as an active blocker.
				if (options.review) {
					const artifact = (state as Record<string, unknown>)[options.feedbackKey] as ControlObj | undefined;
					const addressed = markConvergenceFindingsAddressedFromResponses(state, artifact?.reviewResponses);
					if (addressed > 0) ctx.log(`${options.feedbackKey} convergence: writer response matrix addressed ${addressed} prior finding(s)`);
				}

				const result0 = options.validate ? await options.validate(state, ctx) : { pass: true, errors: [] };
				let result = result0;
				// 059 R1A (§3 R3 Metadata strike-1, MED-3/P8): a W-metadata rejection
				// (malformed amendmentFamily / missing pinOwnership shape) gets ONE
				// zero-attempt-cost inline retry with a deterministic repair template
				// BEFORE it counts as a convergence round (renderRetries precedent).
				// State key writerMetadataRetryUsed:<stage> — exactly once per stage,
				// disjoint from 058's planned phaseProtectionStrikes.
				const stateRecStrike = state as Record<string, unknown>;
				if (!result.pass && isWriterMetadataRejection(result.errors) && !stateRecStrike[writerMetadataStrikeKey(options.feedbackKey)]) {
					stateRecStrike[writerMetadataStrikeKey(options.feedbackKey)] = true;
					setRetryFeedback(stateRecStrike, options.feedbackKey, [{
						stage: options.feedbackKey,
						attempt: round,
						gate: `${options.feedbackKey}-contract-metadata`,
						location: "structured control (contract declarations)",
						observed: "The control's contract declarations failed shape validation (metadata only — content was not judged).",
						expected: "Well-formed contract-declaration fields (see the repair template below).",
						missing: result.errors.slice(0, 8),
						diagnostics: [writerMetadataRepairFeedback(options.feedbackKey, result.errors)],
						nextAction: "Return the SAME control with only the contract-declaration fields repaired.",
					}]);
					ctx.log(`${options.feedbackKey} convergence: METADATA STRIKE-1 — contract-declaration shape rejected; one zero-cost inline retry with repair template (059 §3 R3)`);
					const strike = await stageTask.run(state, ctx);
					if (strike.status === "cancelled") return strike;
					const retryRenderErrs = readRenderErrors(state);
					if (stateRecStrike[options.feedbackKey] != null && retryRenderErrs.length === 0) {
						result = options.validate ? await options.validate(state, ctx) : { pass: true, errors: [] };
						if (result.pass) ctx.log(`${options.feedbackKey} convergence: METADATA STRIKE-1 retry passed — no convergence round consumed`);
					} else {
						result = { pass: false, errors: [...result.errors, ...retryRenderErrs] };
					}
				}
				// v0.3.32: a writer control that PASSED validation but FAILED
				// schema/render (writerTask returns the control and renderAndWrite
				// returned null) means NO fresh doc on disk — the gates would keep
				// passing against the STALE doc (the code-review R2 stale-doc hole).
				// Fold the recorded render errors in so the round retries instead.
				if (!result.pass || renderErrs.length > 0) {
					lastErrors = [...result.errors, ...renderErrs];
					recordArtifactErrors(options, state, lastErrors, renderErrs.length > 0 ? `${options.feedbackKey}-render` : `${options.feedbackKey}-validation`);
					setArtifactFeedback(options, state, lastErrors);
					ctx.log(`${options.feedbackKey} convergence: continuing after round ${round}${lastErrors.length ? ` — ${lastErrors.join("; ")}` : ""}`);
					// F2 (adversarial F2-STALE-PROGRESS): same invalidation — see above.
					prevOwnOpen = Number.POSITIVE_INFINITY;
					lastOwnOpen = Number.POSITIVE_INFINITY;
					continue;
				}
				ctx.log(`${options.feedbackKey} convergence: deterministic validation passed round ${round}`);

				// Fagan-style LLM review layer (shift-left). A passed deterministic gate
				// INTENTIONALLY falls through to the reviewer — content quality is judged
				// even when the structural gate passes (a deterministic pass does NOT skip
				// the review). Absent ⇒ deterministic-only.
				if (options.review && reviewTask) {
					const review = options.review;
					const resultsBeforeReview = ctx.results.length;
					const reviewResult = await reviewTask.run(state, ctx);
					if (reviewResult.status === "cancelled") return reviewResult;
					if (reviewResult.status === "failed") {
						lastErrors = [`${review.reviewStateKey} review failed: ${reviewResult.error ?? "unknown error"}`];
						setReviewFeedback(options, state, `${options.feedbackKey} review`, lastErrors);
						ctx.log(`${options.feedbackKey} convergence: ✗ review failed round ${round} — ${lastErrors.join("; ")}`);
						// F2 (code-review R1): review AGENT failure = no fresh reading.
						prevOwnOpen = Number.POSITIVE_INFINITY;
						lastOwnOpen = Number.POSITIVE_INFINITY;
						if (isNonRetryableAgentError(reviewResult.error)) throw new FatalAbort(nonRetryableAgentSummary(reviewResult.error));
						continue;
					}
					// v0.3.65: the REVIEW agent itself errored (G21 row) — a dead reviewer
					// previously read as an empty control → "review rejected" → writer
					// rework rounds against a corpse (incident 2026-09-04T13-45-10: 16
					// fake rejections). Honest label, bounded retries, FatalAbort with
					// the infra error named at the threshold. Only FRESH rounds count.
					const reviewAgentErrors = agentErrorTextsSince(ctx, resultsBeforeReview, options.review.stage.id);
					if (reviewAgentErrors.length > 0) {
						const freshReviewError = round > priorRounds;
						const reviewAgentError = reviewAgentErrors[reviewAgentErrors.length - 1];
						if (isNonRetryableAgentError(reviewAgentError)) throw new FatalAbort(nonRetryableAgentSummary(reviewAgentError));
						if (freshReviewError) consecutiveReviewAgentErrors++;
						if (consecutiveReviewAgentErrors >= AGENT_ERROR_FATAL_CONSECUTIVE) {
							const msg = `${options.feedbackKey} convergence: review agent errored ${consecutiveReviewAgentErrors} consecutive round(s) — infra failure, not an artifact defect (last error: ${reviewAgentError})`;
							ctx.log(msg);
							throw new FatalAbort(msg);
						}
						lastErrors = [`${options.feedbackKey} review agent errored: ${reviewAgentError}`];
						setReviewFeedback(options, state, `${options.feedbackKey} review`, lastErrors);
						ctx.log(`${options.feedbackKey} convergence: ✗ review agent errored round ${round}${freshReviewError ? ` (${consecutiveReviewAgentErrors}/${AGENT_ERROR_FATAL_CONSECUTIVE} consecutive)` : " (replayed — not counted)"} — ${reviewAgentError}`);
						prevOwnOpen = Number.POSITIVE_INFINITY;
						lastOwnOpen = Number.POSITIVE_INFINITY;
						continue;
					}
					consecutiveReviewAgentErrors = 0;
					const reviewControl = (state as Record<string, unknown>)[review.reviewStateKey] as ControlObj | undefined;
					// The reviewer's verification of prior findings also updates the ledger
					// (a finding it confirms resolved is marked, so it stops blocking).
					const resolved = markConvergenceFindingsAddressedFromResponses(state, reviewControl?.priorFindingResolutions, "reviewer");
					if (resolved > 0) ctx.log(`${options.feedbackKey} convergence: reviewer resolved ${resolved} prior finding(s)`);
					// G1 (run 08-56 moving-target spiral): the convergence-duty
					// contract is enforced DETERMINISTICALLY, not by prompt
					// compliance — from REVIEWER_DUTY_ROUND on, NEW non-High
					// blocking findings become advisory before approval is
					// decided, so a reviewer that ignores the contract can no
					// longer keep the loop open until the cap kills the run.
					reviewRound++;
					// AC-17 (SCENARIO-038): a reading past the recorded review rounds is
					// FRESH; a cache-replayed reading carries no fresh information and
					// must never arm the strict-progress extension.
					const freshReviewReading = reviewRound > priorReviewRounds;
					const duty = enforceReviewerConvergenceDuty(reviewControl, reviewRound, {
						stage: options.feedbackKey,
						knownFindingIds: new Set(getConvergenceLedger(state).findings.filter((f) => f.blocking && !f.downgradeReason).map((f) => f.id)),
						// M22 (SCENARIO-068): verbatim restatements of live blocking ledger
						// findings are shielded from the downgrade by convergence fingerprint.
						knownBlockingFingerprints: new Set(getConvergenceLedger(state).findings.filter((f) => f.blocking && !f.downgradeReason).map((f) => f.fingerprint)),
						reviewSourceGate: `${options.feedbackKey}-review`,
						// 059 §3 R4: evidence-pair exemption inputs — the slice the WRITER saw
						// this stage (stamped at prompt-build). Absent stamp (pre-W/resume
						// replay) ⇒ no eligibility, fail-closed harmless.
						worktreePath: state.setup?.worktreePath,
						injectedSlice: readContractSliceStamp(state as Record<string, unknown>, options.feedbackKey),
					});
					const downgraded = duty.downgraded;
					// 059 R1A D-R-B(g): the excess-exemption SIGNAL's consumer — judge with
					// allowedRoutes EXACTLY ["replan-upstream"]; escalate-now verdicts are
					// REFUSED (no FatalAbort on this trigger — routes back / degrades).
					if (duty.escalateToJudge) await consumeContractConflictEscalation({ ctx, state, from: options.feedbackKey, reviewControl, exemptCount: duty.exemptCount });
					if (downgraded > 0) {
						ctx.log(`${options.feedbackKey} convergence: convergence duty enforced — ${downgraded} new non-High blocking finding(s) downgraded to advisory (round ${round})`);
						// B8 (fix-in-pass, SCENARIO-068): the enforcement MUTATED the review
						// control in place — re-render the review doc (per-slug reuse via
						// renderAndWrite, idempotent) so the on-disk artifact matches the
						// enforced classifications instead of the stale agent-authored ones.
						// Best-effort: a schema-invalid control renders nothing (null) and a
						// failed write must never kill the convergence loop.
						try {
							if (state.setup) renderAndWrite(state.setup, (m) => ctx.log(m), options.review.stage.id, reviewControl as Record<string, unknown>);
						} catch { /* best-effort re-render */ }
					}
					// F-A verdict pinning (adversarial G1-NEEDSHUMAN-NOOP): the
					// approval gate uses the VERDICT-layer blocking scan — a
					// needs-human finding pins the verdict only through its own
					// blocking flag / high severity, so the duty downgrade of a
					// late non-high needs-human note actually unblocks approval.
					// M8 (SCENARIO-039/040): a duty override may converge the loop, but it is
					// NOT a reviewer approval — replan consumption and the replan verified-flip
					// below are gated on the GENUINE verdict signal alone.
					genuineApproval = reviewVerdictApproves(reviewControl?.verdict);
					// v0.3.24 S1: the verdict gate is OWNER-AWARE — this loop may only be
					// pinned by findings its own stage (or an upstream route-back) can act
					// on. Blocking findings owned by a DOWNSTREAM stage are carried debt:
					// they persist in the ledger and re-inject at the owner's round 1
					// (the v0.3.3 machinery — how the debt reached this loop at all), so
					// they must not keep THIS loop open. Run 2026-08-28T13-04-28-485Z: six
					// rounds rejected solely on bdd-owned blockers after a v0.3.19
					// auto-route-back re-entry — including a literal "Approved" verdict at
					// round 7 — until ROUND CAP 8 killed the run (a textbook wait-for-graph
					// cycle: this loop waits on bdd; bdd waits for this loop to converge).
					const verdictBlocking = reviewBlockingVerdictFindings(reviewControl);
					const verdictCarried = verdictBlocking.filter((f) => !isActionableOwnerStage((f as { ownerStage?: unknown }).ownerStage, ownStage));
					// actionable verdict-blockers (own/upstream/unknown owner) still pin the
					// verdict exactly as before — ONLY the downstream-owned subset stops
					// pinning (it is carried debt for the owner stage instead).
					const approved = (genuineApproval || downgraded > 0) && (verdictBlocking.length - verdictCarried.length) === 0;
					if (!approved && verdictCarried.length > 0) {
						// v0.3.24 S2: deterministic wait-for-graph resolution — every open
						// blocking finding is owned by a stage this loop cannot reach without
						// exiting. Exit CONVERGED-CARRIED instead of spinning to the cap: the
						// walk continues to the owner, which receives the debt at its round 1.
						const ownActionableOpen = blockingConvergenceFindings(state).filter((f) => isActionableOwnerStage(f.ownerStage, ownStage));
						if (ownActionableOpen.length === 0 && verdictBlocking.length === verdictCarried.length) {
							recordReviewFindingsFromControl(state, reviewControl, { detectedAtStage: review.reviewStateKey, ownerStage: review.ownerStage, sourceGate: `${options.feedbackKey}-review-carried` });
							clearRetryFeedback(state as Record<string, unknown>, options.feedbackKey);
							ctx.log(`${options.feedbackKey} convergence: CONVERGED-CARRIED (round ${round}) — every open blocking finding is owned downstream (${carriedConvergenceFindings(state, ownStage).map((f) => `${f.id} owner=${f.ownerStage}`).join(", ")}); no ${options.feedbackKey} rewrite can close them. The walk continues to the owner stage, where they re-inject at its round 1.`);
							// review-2 F1: DELIVER the debt (pending replan requests + owner
							// revision bump) and deliberately do NOT recordConvergedRevision —
							// this exit is a harness-forced pass with open blockers, and the
							// revision-gate invariant says only a GENUINE approval may make the
							// artifact green-skippable in later sub-walks.
							deliverCarriedDebt(state, ownStage, ctx.log);
							return { status: "ok" as const, attempts: round };
						}
					}
					if (!approved) {
						recordReviewFindingsFromControl(state, reviewControl, { detectedAtStage: review.reviewStateKey, ownerStage: review.ownerStage, sourceGate: `${options.feedbackKey}-review` });
						lastErrors = compactReviewFindings(reviewControl);
						// F2: track this stage's OWN open-blocking count for the
						// strict-progress extension at the cap — FRESH readings only.
						if (freshReviewReading) {
							prevOwnOpen = lastOwnOpen;
							lastOwnOpen = blockingConvergenceFindings(state).filter((f) => f.ownerStage === ownStage).length;
						} else {
							// M7/adv-B/B5: a cache-replayed reading carries no fresh
							// information — the extension can never be granted on it.
							prevOwnOpen = Number.POSITIVE_INFINITY;
							lastOwnOpen = Number.POSITIVE_INFINITY;
						}
						// HITL escalation triggers (bounded by ESCALATION_RETRY_CAP per stage):
						//  (a) a blocking finding owned by a STRICTLY UPSTREAM stage — the
						//      current writer structurally cannot fix it (e.g. a scope/routing
						//      mismatch owned by `classify`), so escalate IMMEDIATELY rather than
						//      forcing the writer to oscillate for rounds; OR
						//  (b) a STALL — the same blocking signature recurred across rounds.
						// v0.3.48 non-routable-owner downgrade: ownerPrecedes accepts ANY
						// strictly-upstream stage, but the routing graph can only re-enter
						// the closed REPLAN_OWNER_STAGES set. A blocker owned by a
						// NON-routable upstream stage (classify is the live case —
						// run 2026-08-31T02-56: task-classifier's deterministic fallback
						// wrote uiScope=none for a UI-heavy app; the reviewer correctly
						// flagged owner=classify; planInlineRouteBack can NEVER route it;
						// headless HITL then aborted the run on a defect the artifact
						// cannot fix). Such findings become carried advisory debt with a
						// loud log — the run continues on its real (routable/own) blockers.
						const routableUpstream = blockingConvergenceFindings(state).filter((f) => isRoutableOwnerStage(f.ownerStage) && ownerPrecedes(f.ownerStage, ownStage));
						const nonRoutableUpstream = blockingConvergenceFindings(state).filter((f) => !isRoutableOwnerStage(f.ownerStage) && ownerPrecedes(f.ownerStage, ownStage));
						if (nonRoutableUpstream.length > 0) {
							for (const f of nonRoutableUpstream) {
								f.blocking = false;
								f.downgradeReason = `owner ${f.ownerStage} is not routable mid-run (v0.3.48) — carried advisory debt; fix the classification in the task/config for the next run`;
							}
							ctx.log(`${options.feedbackKey} convergence: ${nonRoutableUpstream.length} upstream-owned blocker(s) downgraded to CARRIED ADVISORY (owner stage${nonRoutableUpstream.length === 1 ? "" : "s"} ${[...new Set(nonRoutableUpstream.map((f) => f.ownerStage))].join(", ")} not routable mid-run): ${nonRoutableUpstream.map((f) => f.id).join(", ")} — the run continues on its actionable blockers`);
						}
						const upstreamOwned = routableUpstream;
						const signature = blockingSignature(state, review.ownerStage);
						const stalled = signature.length > 0 && signature === priorBlockingSignature;
						priorBlockingSignature = signature;
						if (upstreamOwned.length > 0 || stalled) {
							const escalate = getEscalate(ctx);
							const reason = upstreamOwned.length > 0
								? `${options.feedbackKey} review surfaced blocking finding(s) owned by an upstream stage the ${options.feedbackKey} writer cannot fix: ${upstreamOwned.map((f) => `${f.id} owner=${f.ownerStage}`).join(", ")}`
								: `${options.feedbackKey} review stalled: the same blocking finding(s) recurred across review rounds`;
							const failure: EscalationFailure = {
								kind: "stagnation",
								stage: options.feedbackKey,
								message: `${reason} — ${lastErrors.join("; ")}`,
								severity: "soft",
								worktreePath: state.setup?.worktreePath,
								specDirectory: state.setup?.specDirectory,
								findings: blockingConvergenceFindings(state).filter((f) => f.ownerStage === review.ownerStage || ownerPrecedes(f.ownerStage, ownStage)).slice(0, 6).map((f) => ({ severity: f.severity, title: f.title })),
								// M4 (G6): exactly-one routable upstream owner → offer
								// "Route back to ⟨owner⟩ (recommended)" first.
								routeBackOwner: [...new Set(upstreamOwned.map((f) => f.ownerStage))]
									.filter((o, _i, arr) => arr.length === 1 && isRoutableOwnerStage(o))[0],
							};
							let decision: import("../../types.ts").EscalationDecision | undefined;
							// v0.3.19 AUTO-ROUTE: when the blocker analysis itself already
							// resolves the fix path — exactly ONE routable strictly-upstream
							// owner and a per-edge jump budget that allows it — route DIRECTLY,
							// no human round-trip (run 2026-08-27T00-59-52: a BDD contradiction
							// with a crisp owner=requirements recommendation burned a full HITL
							// wait only for the user to click "route back"). Since M5 the wait
							// was already ceremonial for this shape — every non-run-level choice
							// routes identically; the run-level overrides (accept-limitation /
							// abandon) remain reachable via SUPER_DEV_NO_AUTO_ROUTEBACK=1.
							// Budget-exhausted, multi-owner, non-routable, or kill-switched
							// cases fall through to the HITL escalation below unchanged.
							if (upstreamOwned.length > 0 && autoRouteBackEnabled()) {
								const autoCmd = planInlineRouteBack(state.setup?.specDirectory, options.feedbackKey, upstreamOwned);
								if (autoCmd) {
									// Audit trail: the SAME report surface, decision marked
									// machine-taken (route-back-auto), so the auto-jump is never
									// silent. Best-effort — a report failure must not block recovery.
									try {
										const { writeEscalationReport } = await import("../../render/escalation-report.ts");
										writeEscalationReport({ ...failure, message: `[auto-route: single upstream owner "${autoCmd.to}" — routed without HITL; kill-switch SUPER_DEV_NO_AUTO_ROUTEBACK=1 restores the human prompt]\n\n${failure.message}` }, { choice: "route-back-auto" }, state.setup?.specDirectory);
									} catch { /* best-effort audit */ }
								ctx.log(`${options.feedbackKey} convergence: UPSTREAM-OWNED blocker detected — AUTO-ROUTE ${autoCmd.from}→${autoCmd.to} (single routable owner, budget checked, no HITL; SUPER_DEV_NO_AUTO_ROUTEBACK=1 restores the prompt)`);
								ctx.log(`  blocker: ${failure.message}`);
								throw new RouteBackSignal(autoCmd);
							}
							}
							if (escalate && escalationBudgetRemaining(state, failure) > 0) {
								ctx.log(`${options.feedbackKey} convergence: ${upstreamOwned.length > 0 ? "UPSTREAM-OWNED blocker" : "STALL"} detected — escalating to user (HITL)`);
								ctx.log(`  blocker: ${failure.message}`);
								decision = await runEscalation(state, failure, escalate);
							}
							// M5: genuine human overrides are respected FIRST — these two
							// express a decision about the RUN, not about which actuator fixes it.
							if (decision?.choice === "accept-limitation") {
								applyRetryDecision(state, decision, { worktreePath: state.setup?.worktreePath, specDirectory: state.setup?.specDirectory });
								clearRetryFeedback(state as Record<string, unknown>, options.feedbackKey);
								ctx.log(`${options.feedbackKey} convergence: user accepted the limitation — proceeding (round ${round})`);
								return { status: "ok" as const, attempts: round };
							}
							if (decision?.choice === "abandon") {
								throw new FatalAbort(`${options.feedbackKey} convergence: user abandoned the run at review escalation — ${failure.message}`);
							}
							// M5 — the interactive decision suppression is DELETED: upstream-
							// owned blockers route REGARDLESS of the choice (route-back,
							// retry-with-guidance, revise-manually) or the headless no-decision.
							// The run-03-23-47 interactive sibling (retry-with-guidance on an
							// upstream-owned blocker → the writer retried what it cannot fix →
							// oscillation → cap) is dead. A retry-with-guidance decision in
							// hand persists its guidance (the owner reads it at re-entry);
							// applyRetryDecision itself is NOT called (M4 contract: no
							// worktree rollback on the routed path).
							if (upstreamOwned.length > 0) {
								const inlineCmd = planInlineRouteBack(state.setup?.specDirectory, options.feedbackKey, upstreamOwned);
								if (inlineCmd) {
									if (decision?.choice === "retry-with-guidance" && decision.guidance?.trim()) {
										try { appendUserNotes(state.setup?.specDirectory, [decision.guidance.trim()]); } catch { /* best-effort */ }
										ctx.log(`${options.feedbackKey} convergence: retry-with-guidance chosen but the blocker is upstream-owned — routing anyway; guidance persisted for the owner`);
									}
									ctx.log(`${options.feedbackKey} convergence: INLINE route-back ${inlineCmd.from}→${inlineCmd.to} (budget checked)${decision?.choice === "route-back" ? " (user-chosen)" : ""} — throwing RouteBackSignal for the walker`);
									throw new RouteBackSignal(inlineCmd);
								}
								// M5 — the emulation is retired for routing: a declined jump
								// (budget exhausted / kill-switch / scope) is an honest fatal.
								// The escalation surface fired above (interactive choice or
								// headless report); there is NO automatic process restart.
								throw new FatalAbort(`${options.feedbackKey} convergence: route-back declined (edge budget exhausted or kill-switch — ${upstreamOwned.length} upstream-owned blocker(s) persist: ${upstreamOwned.map((f) => f.id).join(", ")}) — the escalation surface was offered when available and no automatic restart remains (M5 retirement) — ${failure.message}`);
							}
							// Stall-only residue: retry-with-guidance / revise-manually keep
							// their same-stage semantics (rollback + persisted guidance).
							if (decision) {
								applyRetryDecision(state, decision, { worktreePath: state.setup?.worktreePath, specDirectory: state.setup?.specDirectory });
								priorBlockingSignature = ""; // guidance changes the inputs; reset stall tracking
							}
						}
						setReviewFeedback(options, state, `${options.feedbackKey} review`, lastErrors);
						ctx.log(`${options.feedbackKey} convergence: ✗ review rejected round ${round}${lastErrors.length ? ` — ${lastErrors.join("; ")}` : ""}`);
						continue;
					}
					// G1: a downgrade-approval still records the advisory findings
					// (audit trail) before the verified flip discards them.
					if (downgraded > 0) {
						recordReviewFindingsFromControl(state, reviewControl, { detectedAtStage: review.reviewStateKey, ownerStage: review.ownerStage, sourceGate: `${options.feedbackKey}-review` });
						ctx.log(`${options.feedbackKey} convergence: ${downgraded} downgraded finding(s) recorded as advisory on approval`);
					}
					// v0.3.24 S1: an approval that carries downstream-owned debt records
					// it too — the ledger is the transport to the owner stage, and the
					// verified flip below now skips downstream rows (they must stay open
					// so the owner's round-1 injection re-arms them).
					if (verdictCarried.length > 0) {
						recordReviewFindingsFromControl(state, reviewControl, { detectedAtStage: review.reviewStateKey, ownerStage: review.ownerStage, sourceGate: `${options.feedbackKey}-review-carried` });
						ctx.log(`${options.feedbackKey} convergence: ✓ review approved round ${round} with ${verdictCarried.length} carried downstream-owned blocking finding(s) — they remain open for the owner stage`);
					} else {
						ctx.log(`${options.feedbackKey} convergence: ✓ review approved round ${round}`);
					}
				}

				clearRetryFeedback(state as Record<string, unknown>, options.feedbackKey);
				markConvergenceFindingsVerified(state, (finding) => !finding.downgradeReason && (
					(finding.ownerStage === ownStage && finding.detectedAtStage === options.feedbackKey) ||
					// v0.3.24 S1: the review-detected flip now requires an ACTIONABLE
					// owner — a downstream-owned finding detected by this review must NOT
					// be verified here (that would erase the carried debt before the
					// owner stage ever sees it; run 13-04-28's bdd rows would have been
					// silently closed by a requirements approval).
					(options.review && isActionableOwnerStage(finding.ownerStage, ownStage) ? finding.detectedAtStage === options.review.reviewStateKey : false) ||
					(genuineApproval && finding.ownerStage === ownStage && finding.detectedAtStage === "replan")
				));
				if (genuineApproval) {
					// R3 (SCENARIO-040): approval by the owning reviewer VERIFIES the revision —
					// only now may the persisted requests flip to addressed (never on the
					// writer's say-so alone, and never on a duty override — SCENARIO-039).
					const consumedReplan = consumeReplanRequests(state.setup?.specDirectory, options.feedbackKey);
					if (consumedReplan > 0) ctx.log(`${options.feedbackKey} convergence: ${consumedReplan} replan request(s) verified and marked addressed`);
				}
				ctx.log(`${options.feedbackKey} convergence: complete (round ${round}${round > 1 ? ", after feedback" : ""})`);
				recordConvergedRevision(state, options.feedbackKey, state.setup?.specDirectory);
				return { status: "ok" as const, attempts: round };
			}

			const msg = `${options.feedbackKey} convergence stopped before all ambiguity/validation issues were resolved because the global agent budget was exhausted after ${round} round(s)${lastErrors.length ? `: ${lastErrors.join("; ")}` : ""}`;
			ctx.log(`${options.feedbackKey} convergence: BUDGET EXHAUSTED (FATAL — aborting run) — ${msg}`);
			throw new FatalAbort(msg);
		},
	};
}
