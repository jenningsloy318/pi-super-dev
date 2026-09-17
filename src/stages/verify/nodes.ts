import {buildGreen, detectIntegrationWriteViolations, expectedIntegrationRoles, markIntegrationNotApplicable, markIntegrationPassed, resetIntegrationAttemptState, reviewApproved, runVerificationFix, setIntegrationOutcome} from "./boundary.ts";
import {buildGateStep, classifyIntegrationObservation, detectStagnation, fixStepIntegration, fixStepReview, inconclusiveIntegrationMessage, reviewStep, testBlock, testFailuresSignature} from "./steps.ts";
import {VerificationAttemptRecord, buildErrors, ensureVerificationAttempts, recordAttemptEnd, recordVerificationConvergenceFinding, recordVerificationReviewFindings, recordVerificationStagnation, snapshotStatusFiles, summarizeReviewFindings, summarizeTestFailures, testFailureCount, verificationReplayArms, workingTreeSignature} from "./evidence.ts";
/**
 * Stage 10 — Verification Convergence
 * (review → fix → review → integration → fix → review → integration).
 *
 * The main pipeline uses one convergence state machine so every product fix
 * invalidates downstream evidence: a review/build fix must be reviewed before
 * integration; an integration fix must be reviewed before integration is run
 * again. Success means review + build + integration are fresh on the same code
 * state. The older split review/integration nodes are kept as compatibility
 * exports for direct callers and existing tests.
 *
 * Research basis (SWE-bench agent): tight, feedback-driven loops where
 * observable results are the convergence signal.
 *
 * Split at v0.4.17c into evidence / boundary / steps / nodes.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loop, sequence, parallel, branch, noop, task, tryCatch, isFatalAbort } from "../../nodes.ts";
import { buildCodeReviewPrompt, buildAdversarialPrompt, buildTestsReviewPrompt, buildFixPrompt, buildApiTestPrompt, buildUiTestPrompt } from "../../prompts.ts";
import { runBuildGate, buildGateCorrelationLine, type GateOptions } from "../../build-runner.ts";
import { runJudge } from "../judge.ts";
import { toBool } from "../../doc-validators.ts";
import { commitWorktreeChanges, isHarnessBookkeepingPath } from "../../helpers.ts";
import { RouteBackSignal } from "../../routing/router.ts";
import { planInlineRouteBack } from "../../routing/walker.ts";
import { countStageRounds } from "../../resume.ts";
import { appendGateChecked } from "../../runlog.ts";
import { withServiceDeps, bringupTask, teardownNode } from "../lifecycle.ts";
import { renderAndWrite, reserveStageDocs } from "../../render/render.ts";
import { STAGE_MODELS, FileClassifyControlData } from "../../render/schemas.ts";
import { localTimestamp } from "../../render/time.ts";
import { buildRedBoundaryPrompt, classifyObviousRedPath, redBoundaryResultFromAgent, redBoundaryResultFromClassifications, type RedBoundaryResult } from "../../test-artifacts.ts";
import { renderRetryFeedbackBlock, type RetryFeedback } from "../../retry-feedback.ts";
import { persistConvergenceLedger, getConvergenceLedger, recordConvergenceFindings, recordReviewFindingsFromControl, closeAgentFailedFindings, type ConvergenceOwnerStage } from "../../convergence-ledger.ts";
import { inferReviewFindingStatus, reviewFindingBlocks, reviewFindingSeverity } from "../../review-findings.ts";
import type { ControlObj, Node, NodeResult, PipelineState, Stage, StageContext } from "../../types.ts";
/**
 * Stage 10 — Verification Convergence.
 *
 * This is the main workflow's review/fix/test convergence state machine:
 * review → fix → review → integration → fix → review → integration. A fix is
 * never terminal evidence; the next attempt must re-run semantic review and the
 * deterministic build gate before integration is allowed to run again.
 */
export const verificationConvergenceNode: Node = {
	kind: "verificationConvergence",
	async run(state, ctx) {
		if (ctx.signal?.aborted) return { status: "cancelled" };
		delete (state as Record<string, unknown>).__verificationStagnated;
		delete (state as Record<string, unknown>).__stagnated;
		delete (state as Record<string, unknown>).__lastVerificationFix;
		(state as Record<string, unknown>).__verificationFailureFingerprintRounds = [];
		const attempts = ensureVerificationAttempts(state);

		let lastAttempt = 0;
		for (let attempt = 1; ctx.budget.check(); attempt++) {
			lastAttempt = attempt;
			if (ctx.signal?.aborted) return { status: "cancelled" };
			resetIntegrationAttemptState(state);
			delete state.integration;

			const record: VerificationAttemptRecord = {
				attempt,
				startedAt: localTimestamp(),
				reviewFindings: 0,
				buildErrors: 0,
				integrationExpected: [],
				failureSignature: "",
				codeBefore: workingTreeSignature(state),
			};
			attempts.push(record);
			ctx.log(`Stage 10 — Verification convergence attempt ${attempt}: review + build`);

			const reviewResult = await reviewStep.run(state, ctx);
			if (reviewResult.status === "cancelled") return reviewResult;
			recordVerificationReviewFindings(state, ctx);
			// Sweep-3 AR1-5: on a REPLAYED attempt (memoized review cache-hit) a
			// non-approved review cannot arm the boundary below — skip the build
			// spawn too (the G2 guard would only `continue` after it ran; each
			// replayed attempt re-paid the build gate for nothing).
			const replayEarly = Math.max(attempt, attempts.length) <= verificationReplayArms(state, ctx);
			if (replayEarly && !reviewApproved(state)) {
				recordAttemptEnd(state, record, false);
				ctx.log(`Stage 10: attempt ${attempt} replay-derived (review cache-hit, not approved) — skipping build re-run and terminal arming until fresh evidence`);
				// Bound (P8): the attempt loop's budget check (ctx.budget.check()) plus
				// the replay sequence — every replayed attempt advances
				// Math.max(attempt, attempts.length) past verificationReplayArms, so at
				// most that many replay-continue rounds can fire before fresh evidence
				// (or budget exhaustion) ends the loop.
				continue;
			}
			const buildResult = await buildGateStep.run(state, ctx);
			if (buildResult.status === "cancelled") return buildResult;

			if (!reviewApproved(state) || !buildGreen(state)) {
				recordAttemptEnd(state, record, false);
				ctx.log(`Stage 10: review/build outcome attempt ${attempt}: review=${String(record.reviewVerdict || "unknown")} build=${record.buildPass === true ? "pass" : "fail"} findings=${record.reviewFindings} buildErrors=${record.buildErrors}`);
				// Liveness (R-5 companion): all findings demoted to the ledger +
				// no build errors + gate absent/green → nothing in this loop can
				// change state (fixer has no work, stagnation needs non-empty
				// items). Stop for the human boundary instead of spinning forever.
				if (!reviewApproved(state) && record.reviewFindings === 0 && record.buildErrors === 0 && (state.buildGate === undefined || buildGreen(state))) {
				// Sweep-3 G2 (E-code E-1): the outer convergence boundary (inline
				// route-back throw + blocked-on-decisions marker) must obey the SAME
				// replay discipline as the inner stagnation classifier (v0.3.10).
				// On a resumed run the review agents replay from the memoized cache
				// and reproduce the prior deferred findings — replayed evidence must
				// not arm a terminal exit. The attempt sequence is cumulative via the
				// persisted __verificationAttempts ledger; when this attempt is still
				// inside the replay-arm budget, skip the boundary and let the loop
				// proceed (each replayed attempt advances the sequence, so this
				// terminates exactly when genuinely fresh evidence arrives).
				const replaySeq = Math.max(attempt, attempts.length);
				if (replaySeq <= verificationReplayArms(state, ctx)) {
					ctx.log(`Stage 10: attempt ${attempt} boundary evidence is replay-derived (resume cache) — inline route-back/blocked-on-decisions deferred until fresh evidence`);
					recordAttemptEnd(state, record, false);
					// Bound (P8): same replay-sequence bound as the replayEarly arm —
					// replaySeq is monotonically increasing per attempt and bounded by
					// verificationReplayArms; the outer budget check caps everything else.
					continue;
				}
				const deferred = ((state.review as { deferredFindings?: Array<Record<string, unknown>> } | undefined)?.deferredFindings) ?? [];
				// R3 (dsh-09 v3): before falling to the human boundary, try routing the
				// residue back to its OWNING stages — a bounded replan restart re-runs
				// the owning convergence loops and everything downstream they
				// invalidate. When nothing is routable or the budget is exhausted this
				// returns false and today's honest blocked-on-decisions path runs.
				// M4: inline-first — deferred findings carry ownerStage (cross-stage
				// ownership is exactly why they were deferred), so the shared
				// planner can jump instead of restarting the process. Exactly one
				// routable strictly-upstream owner + edge budget → RouteBackSignal
				// for the walker (verify needs no addressable id: the TARGET is the
				// owner). The replan emulation stays the multi-owner/kill-switch/
				// budget-exhausted fallback.
				const inlineCmd = planInlineRouteBack(state.setup?.specDirectory, "verify", deferred);
				if (inlineCmd) {
					// Review round-1 M4-H1: the walker's MP1 protocol injects LEDGER
					// findings matched by cmd.findingIds — deferred findings live only
					// in state.review.deferredFindings. Record them FIRST so the
					// owner's round 1 carries them (and the walker's decline fallback
					// finds them too); without this the owner re-enters BLIND.
					recordConvergenceFindings(state, deferred
						.filter((f) => typeof f.id === "string" && inlineCmd.findingIds.includes(f.id as string))
						.map((f) => ({
							id: String(f.id),
							ownerStage: typeof f.ownerStage === "string" ? f.ownerStage : inlineCmd.to,
							title: String(f.title ?? "deferred finding"),
							detail: String(f.detail ?? f.deferralReason ?? "cross-stage deferred finding"),
							severity: typeof f.severity === "string" ? f.severity : "medium",
							evidence: Array.isArray((f as { evidence?: unknown }).evidence) ? ((f as { evidence: unknown[] }).evidence as unknown[]).map(String) : [],
							recommendation: String((f as { recommendation?: unknown }).recommendation ?? "revise the owning artifact"),
							blocking: true,
						})), { detectedAtStage: "verify", ownerStage: inlineCmd.to, sourceGate: "verify-deferred" });
					ctx.log(`Stage 10: INLINE route-back ${inlineCmd.from}→${inlineCmd.to} for ${inlineCmd.findingIds.length} deferred finding(s) (budget checked; recorded to the ledger for round-1 injection) — throwing RouteBackSignal for the walker`);
					throw new RouteBackSignal(inlineCmd);
				}
				// M5: the emulation is retired for routing — a declined inline
				// plan (multi-owner / kill-switch / budget / OWNER-LESS residue)
				// lands on the honest blocked-on-decisions human boundary below
				// instead of an automatic process restart. (Disposition: deferred
				// findings WITHOUT ownerStage could once be resolved by the replan
				// LEAD (the deleted verify wrapper); M5 narrows routing to structured
				// owners — owner-less residue is surfaced to the human boundary
				// where the [deferred: …] titles carry it; the lead remains
				// reachable from the RED-site exception and genuine resume.)
				(state as Record<string, unknown>).__stagnated = {
					kind: "blocked-on-decisions",
					rounds: attempts.length,
					verdict: (state.review as { verdict?: string } | undefined)?.verdict,
					// D5 (AC-20): the COMPLETE deferred list — no slice(0, 6) cap.
					findings: deferred.map((f) => ({ file: f.file ?? null, severity: f.severity ?? null, title: `[deferred: ${String(f.deferralReason ?? "advisory")}] ${String(f.title ?? "")}` })),
				};
				// Sweep-3 G35 (E-code E-4): the human boundary leaves a durable
				// convergence-ledger record (a resume finds it — state alone is
				// volatile) and marks THIS attempt terminal in the persisted
				// attempt ledger so a resume does not treat it as in-flight.
				try {
					recordVerificationConvergenceFinding(state, {
						title: `Blocked on human decision (${deferred.length} deferred finding(s))`,
						detail: `review=${String((state.review as { verdict?: string } | undefined)?.verdict ?? "unknown")}, no build driver; deferred: ${deferred.map((f) => String(f.title ?? "?")).slice(0, 8).join("; ")}`,
						evidence: deferred.map((f) => String(f.deferralReason ?? f.title ?? "")),
						sourceGate: "blocked-on-decisions",
						// AR1-2: the boundary record is a TRACE (the human's queue),
						// not a loop-killer — blocking=true would poison the next
						// run's round-1 injection with an unfixable-by-code blocker.
						severity: "low",
					});
					// The writer hard-codes blocking for non-environment owners;
					// demote this one row post-hoc (it is surfaced to the human via
					// __stagnated + the escalation report, not via the blocking set).
					const lastRow = getConvergenceLedger(state).findings[getConvergenceLedger(state).findings.length - 1];
					if (lastRow && lastRow.sourceGate === "blocked-on-decisions") {
						lastRow.blocking = false;
						// round-2 CR-R2-2/ARR2-2: PERSIST the demotion — memory-only let
						// the next run's round-1 injection read blocking=true from disk.
						persistConvergenceLedger(state);
					}
				} catch { /* ledger best-effort */ }
				recordAttemptEnd(state, record, true); // sweep-3 G35: TRUE terminal — survives the end-write (pre-fix the write clobbered the marker)
				ctx.log(`Stage 10: no actionable findings remain after triage (${deferred.length} deferred) and no build driver — stopping for human decision (non-fatal; attempt ${attempt}; ledger record + terminal attempt marker written)`);
				return { status: "ok" };
			}
				if (await recordVerificationStagnation(state, ctx, record)) return { status: "failed", error: "verification convergence stagnant" };
				if (!ctx.budget.check()) {
					record.terminal = true;
					ctx.log("Stage 10: verification budget exhausted after fresh review/build evidence; no final fix will run without re-review");
					recordVerificationConvergenceFinding(state, {
						title: "Verification review/build budget exhausted",
						detail: `review=${String(record.reviewVerdict || "unknown")} build=${record.buildPass === true ? "pass" : "fail"} after ${attempt} attempt(s)`,
						evidence: [...summarizeReviewFindings(state), ...buildErrors(state)],
						sourceGate: "review-build-budget",
					});
					return { status: "failed", error: "verification convergence budget exhausted" };
				}
				record.fixKind = "review";
				const fixResult = await runVerificationFix("review", fixStepReview, state, ctx, `round ${attempt}`);
				record.fixChanged = ((state as Record<string, unknown>).__lastVerificationFix as { changed?: boolean } | undefined)?.changed;
				if (fixResult.status === "cancelled") return fixResult;
				// Bound (P8): loop bound = ctx.budget.check() in the attempt header plus
				// recordVerificationStagnation's identical-failure-signature floor
				// (returns failed) — a review-fix continue without budget/stagnation
				// progress cannot spin unbounded.
				continue;
			}

			ctx.log(`Stage 10 — Verification convergence attempt ${attempt}: integration`);
			const integrationWriteSnapshot = snapshotStatusFiles(state);
			const testResult = await testBlock.run(state, ctx);
			if (testResult.status === "cancelled") return testResult;
			const writeViolations = await detectIntegrationWriteViolations(state, ctx, integrationWriteSnapshot);
			if (writeViolations.length > 0) {
				state.integration = {
					pass: false,
					status: "failed",
					summary: `integration tester modified non-test implementation file(s): ${writeViolations.join(", ")}`,
					expected: expectedIntegrationRoles(state),
					failures: writeViolations.map((file) => ({ file, reason: "integration tester modified repository implementation state" })),
				};
				recordAttemptEnd(state, record, true);
				ctx.log(`Stage 10: integration write-boundary violation — ${writeViolations.join(", ")}; stopping without product-code fix`);
				return { status: "failed", error: "integration tester modified implementation files" };
			}
			if (testResult.status === "failed") {
				state.integration = { pass: false, status: "failed", summary: testResult.error ?? "integration bringup/test block failed", expected: expectedIntegrationRoles(state) };
				recordAttemptEnd(state, record, false);
				if (await recordVerificationStagnation(state, ctx, record)) return { status: "failed", error: "verification convergence stagnant" };
				if (!ctx.budget.check()) {
					record.terminal = true;
					recordVerificationConvergenceFinding(state, {
						title: "Integration test block failed after budget exhaustion",
						detail: testResult.error ?? "integration bringup/test block failed",
						evidence: summarizeTestFailures(state),
						sourceGate: "integration-test-block",
					});
					return { status: "failed", error: testResult.error ?? "integration bringup/test block failed" };
				}
				record.fixKind = "integration";
				const fixResult = await runVerificationFix("integration", fixStepIntegration, state, ctx, `round ${attempt}`);
				record.fixChanged = ((state as Record<string, unknown>).__lastVerificationFix as { changed?: boolean } | undefined)?.changed;
				if (fixResult.status === "cancelled") return fixResult;
				// Bound (P8): same as the review-fix arm — budget check in the attempt
				// header + recordVerificationStagnation's signature floor.
				continue;
			}

			if (expectedIntegrationRoles(state).length === 0) {
				const r = markIntegrationNotApplicable(state, ctx);
				recordAttemptEnd(state, record, true);
				ctx.log(`Stage 10: verification converged (review/build green; integration not applicable) in ${attempt} attempt(s)`);
				return r;
			}

			const outcome = setIntegrationOutcome(state);
			recordAttemptEnd(state, record, outcome.status === "passed");
			ctx.log(`Stage 10: integration outcome attempt ${attempt}: ${outcome.status} (expected: ${outcome.expected.join(",") || "none"})`);
			if (outcome.status === "passed" && reviewApproved(state) && buildGreen(state)) {
				return markIntegrationPassed(state, ctx, `Stage 10: verification converged after ${attempt} attempt(s)`);
			}

			// Static-tree convergence (run 2026-08-27T12-33-43-088Z): a static site
			// with no startable integration server must not hard-gate 10h of green
			// deterministic work into PARTIAL. When review/build ARE green, the
			// deterministic gates stand as verification — converge honestly with the
			// skip disclosed in the summary (a real test failure never reaches here).
			if (outcome.status === "skipped-static" && reviewApproved(state) && buildGreen(state)) {
				return markIntegrationPassed(state, ctx, "Stage 10: static site — integration server unavailable; deterministic review/build/test gates stand as verification (skipped-static)");
			}

			if (outcome.status !== "failed") {
				ctx.log(`Stage 10: ${inconclusiveIntegrationMessage(outcome)}`);
				recordVerificationConvergenceFinding(state, {
					title: "Verification integration inconclusive",
					detail: inconclusiveIntegrationMessage(outcome),
					evidence: summarizeTestFailures(state),
					sourceGate: "integration-inconclusive",
				});
				return { status: "failed", error: inconclusiveIntegrationMessage(outcome) };
			}
			if (await recordVerificationStagnation(state, ctx, record)) return { status: "failed", error: "verification convergence stagnant" };
			if (!ctx.budget.check()) {
				record.terminal = true;
				ctx.log("Stage 10: verification budget exhausted after fresh integration evidence; no final fix will run without re-review");
				recordVerificationConvergenceFinding(state, {
					title: "Verification integration budget exhausted",
					detail: `integration=${outcome.status} after ${attempt} attempt(s)`,
					evidence: [...summarizeTestFailures(state), ...summarizeReviewFindings(state), ...buildErrors(state)],
					sourceGate: "integration-budget",
				});
				return { status: "failed", error: "verification convergence budget exhausted" };
			}

			record.fixKind = "integration";
			const fixResult = await runVerificationFix("integration", fixStepIntegration, state, ctx, `round ${attempt}`);
			record.fixChanged = ((state as Record<string, unknown>).__lastVerificationFix as { changed?: boolean } | undefined)?.changed;
			if (fixResult.status === "cancelled") return fixResult;
		}

		recordVerificationConvergenceFinding(state, {
			title: "Verification convergence budget exhausted",
			detail: `verification loop exhausted the global agent budget after ${lastAttempt} attempt(s)`,
			evidence: [...summarizeTestFailures(state), ...summarizeReviewFindings(state), ...buildErrors(state)],
			sourceGate: "verification-budget",
		});
		state.integration = { pass: false, status: "unknown-runner-unavailable", summary: "Budget exhausted before verification convergence attempt" };
		return { status: "failed", error: "verification convergence budget exhausted" };
	},
};

/**
 * Stage 11 — Integration Testing: test → (fail? fix → re-review → build → re-test),
 * bounded by the global budget and repeated test-failure stagnation.
 *
 * Custom node (not loop()) because integrationTestsGreen used to be vacuously true before tests ran —
 * a loop's `until` check would exit immediately. This node runs tests FIRST
 * unconditionally, then loops for retries on failure.
 */
export const integrationLoopNode: Node = {
	kind: "integrationLoop",
	async run(state, ctx) {
		if (ctx.signal?.aborted) return { status: "cancelled" };

		// GAP A/C: per-round test-failure signature + count history. When the same
		// non-empty failure set repeats (or the failure count fails to decrease)
		// across 2 consecutive rounds, record state.__testStagnated and break early
		// (non-fatal). Mirrors reviewLoopUntil/__stagnated.
		const testSigHist = ((state as Record<string, unknown>).__testSignatures as string[] | undefined) ?? [];
		const testCountHist = ((state as Record<string, unknown>).__testCounts as number[] | undefined) ?? [];
		(state as Record<string, unknown>).__testSignatures = testSigHist;
		(state as Record<string, unknown>).__testCounts = testCountHist;
		const recordTestStagnation = (): boolean => {
			// V1 (v0.3.10): replay-derived integration observations (resume cache
			// hits) reconstruct state but never arm test stagnation — same contract
			// as the Stage 10 review loop above.
			if (classifyIntegrationObservation(state, ctx)) return false;
			const sig = testFailuresSignature(state);
			if (!detectStagnation(sig, testFailureCount(state), testSigHist, testCountHist)) return false;
			const failures = [
				...(((state.apiTest as { failures?: Array<Record<string, unknown>> } | undefined)?.failures) ?? []),
				...(((state.uiTest as { failures?: Array<Record<string, unknown>> } | undefined)?.failures) ?? []),
			];
			const outcome = setIntegrationOutcome(state, "integration testing stagnated (non-fatal)");
			(state as Record<string, unknown>).__testStagnated = {
				rounds: testSigHist.length,
				signature: sig,
				status: outcome.status,
				failures: failures.slice(0, 12).map((f) => ({ file: f.file ?? null, title: f.title ?? null, message: f.message ?? null })),
			};
			ctx.log(`Stage 11: test failures stagnant across 2 consecutive rounds — breaking early (non-fatal; ${testSigHist.length} rounds; status=${outcome.status})`);
			return true;
		};

		// 1. Initial test run (unconditional).
		ctx.log("Stage 11 — Integration Testing: running initial tests");
		resetIntegrationAttemptState(state);
		const initResult = await testBlock.run(state, ctx);
		if (initResult.status === "cancelled") return initResult;
		if (initResult.status === "failed") {
			state.integration = { pass: false, status: "failed", summary: initResult.error ?? "integration bringup/test block failed", expected: expectedIntegrationRoles(state) };
			return initResult;
		}
		if (expectedIntegrationRoles(state).length === 0) return markIntegrationNotApplicable(state, ctx);
		const initialOutcome = setIntegrationOutcome(state);
		ctx.log(`Stage 11: integration initial outcome ${initialOutcome.status} (expected: ${initialOutcome.expected.join(",") || "none"})`);
		if (initialOutcome.status === "passed" && reviewApproved(state) && buildGreen(state)) {
			return markIntegrationPassed(state, ctx, "Stage 11: integration passed on first run");
		}
		if (recordTestStagnation()) return { status: "failed", error: "integration testing stagnated (non-fatal)" };

		// 2. Retry loop: fix → re-review → build → re-test.
		let retryAttempts = 0;
		for (let attempt = 1; ctx.budget.check(); attempt++) {
			retryAttempts = attempt;
			if (ctx.signal?.aborted) return { status: "cancelled" };

			ctx.log(`Stage 11: integration retry ${attempt} — fix + re-review + re-test`);

			await fixStepIntegration.run(state, ctx);
			await reviewStep.run(state, ctx);
			await buildGateStep.run(state, ctx);
			resetIntegrationAttemptState(state);
			const retryTestResult = await testBlock.run(state, ctx);
			if (retryTestResult.status === "cancelled") return retryTestResult;
			if (retryTestResult.status === "failed") {
				state.integration = { pass: false, status: "failed", summary: retryTestResult.error ?? "integration bringup/test block failed", expected: expectedIntegrationRoles(state) };
				return retryTestResult;
			}

			if (expectedIntegrationRoles(state).length === 0) return markIntegrationNotApplicable(state, ctx);
			const retryOutcome = setIntegrationOutcome(state);
			ctx.log(`Stage 11: integration retry ${attempt} outcome ${retryOutcome.status} (expected: ${retryOutcome.expected.join(",") || "none"})`);
			if (retryOutcome.status === "passed" && reviewApproved(state) && buildGreen(state)) {
				return markIntegrationPassed(state, ctx, `Stage 11: integration passed on retry ${attempt}`);
			}
			if (recordTestStagnation()) return { status: "failed", error: "integration testing stagnated (non-fatal)" };
		}

		ctx.log(`Stage 11: integration testing budget exhausted after ${retryAttempts} retry attempt(s) (non-fatal)`);
		const outcome = setIntegrationOutcome(state, "integration testing budget exhausted");
		state.integration = { ...state.integration, pass: false, status: outcome.status === "passed" ? "failed" : outcome.status, summary: "integration testing budget exhausted", expected: outcome.expected, roleStatus: outcome.roleStatus };
		return { status: "failed", error: "integration testing budget exhausted" };
	},
};
