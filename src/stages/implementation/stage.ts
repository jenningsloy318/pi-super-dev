import { changeFootprint, crossScopeTestCitations, expectedScenariosForPhase, failureSignature, gitStatusPaths, landedFootprintIsEmpty, nextFaultStreak, pad, repeatedNoProgress } from "./red-evidence.ts";
import type {AcceptedRedContext, ProgressSignature, RedEvidence} from "./red-evidence.ts";
import { MAX_CHALLENGE_REAUTHORS, MAX_PARTIAL_REENTRIES, faultRecurrenceLimit, formatReauthorEvidence, maxPhaseAttempts, phaseWallBudgetMs, runtimeInstructionFingerprint } from "./phase-reentry.ts";
import type {TestDefect} from "./phase-reentry.ts";
import { joinRedReview } from "./red-review-join.ts";
import { adjudicateProtectionGate } from "./protection-gate.ts";
import { adjudicateInheritedRedLadder } from "./inherited-red-ladder.ts";
import { runEnvBlockerRegate } from "./env-blocker-regate.ts";
import { handOffEnvBlockerJudge } from "./env-blocker-judge.ts";
import { adjudicateNoProgress } from "./no-progress-valve.ts";
import { runGateSuite } from "./gate-suite.ts";
import { runGreenBoundaryOracle } from "./green-boundary.ts";
import { closePhaseTail } from "./phase-tail.ts";
import { enterPhase } from "./phase-entry.ts";
import { runStageCloseReverify } from "./stage-close-reverify.ts";
import { prepareImplementationRun } from "./run-prepare.ts";
import { adjudicateRedRetryLadder } from "./red-retry-ladder.ts";
import { adjudicateRedAcceptance } from "./red-acceptance.ts";
import { phaseStatusUpsert } from "./phase-status.ts";
import { dispatchRedTdd } from "./red-tdd-dispatch.ts";
import { runRedOracleCycle } from "./red-oracle-cycle.ts";
import { assembleImplementerPrompt } from "./implementer-prompt.ts";
import { dispatchImplementer } from "./implementer-dispatch.ts";
/**
 * Stage 9 — Implementation (per-phase TDD).
 * Self-contained task: iterates the spec's phased task list. For each phase,
 * runs TDD-write → implement → build-gate until the phase is green, the global
 * run budget is exhausted, or the same actionable failure repeats with no
 * observable progress.
 * The build-gate is the DETERMINISTIC hard oracle (build-runner.ts) that
 * replaces the old QA self-report — no more vacuous pass on "agent said green".
 */

import { existsSync } from "node:fs";
import type { ControlObj, Stage } from "../../types.ts";

import { getActiveTracker } from "../../tracking.ts";
import { buildImplementationSummaryPrompt } from "../../prompts.ts";
import { replanPending } from "../../replan/replan.ts";
// v0.3.85 F2 Tier 3 / F4 sub-cap + the validator hard-fail override: the
// stop-the-line terminal (ADR 9) and the restart-state pending-row probe.
import { FatalAbort } from "../../nodes.ts";
import { extractFailingTestFilePaths } from "../inherited-red.ts";
// v0.3.87 S4(b)+(d) (§9/§10 decision 9, §13, §14 ADR 6): the engine-mediated
// research assist — pure helpers + ledger + the one dispatch seam. §13:
// "research-assist" is a CONFIG ROLE KEY ONLY; the dispatch reuses
// research-agent, no agent file is created.
import { RESEARCH_ASSIST_GREEN_TRIGGER_STREAK, type NeedsResearchEntry, type ResearchAssistGreenTrigger } from "../research-assist.ts";
// 065 D-F-D/D-F-F: the Stage-9-entry gate (write×protect cross-product +
// plan compile-time checks) — two-locus mechanical findings routed through
// the SAME replan circuit plan-feasibility uses (no judge call needed).
import { renderAndWrite } from "../../render/render.ts";
import { STAGE_MODELS } from "../../render/schemas.ts";
import { deliverablesAlreadyMet, type DeliverableContract, type RedCheckDiagnostic, type RedStatus } from "../../build-runner.ts";
import { createPhaseStatusKit } from "./phase-emit.ts";
import { recordConvergenceFindings } from "../../convergence-ledger.ts";
import { classifyGateFault, collectDirtPaths, type FaultClass } from "../../fault-classification.ts";
import { markRunWallFuseTripped, runFuseWindDown, runWallFuseMs } from "../../wall-fuse.ts";
// v0.3.30 Layer C: agent-proposed runner discovery (machine-verified + cached).
import { readCachedTestRunner, type TestRunnerSpec } from "../../build-runner/runner-discovery.ts";
import { type CoverageGateResult } from "../../build-runner/coverage-gate.ts";
// Wave 3 (058 §4 D-B/D-D, v0.3.99): Layer-2 protection intervals + Layer-4 checkpoint rollback.
import { serializeProtectionInterval } from "../protection-interval.ts";
import { handleConvergenceRollback } from "./phase-rollback.ts";

export const implementationStage: Stage = {
	id: "implementation",
	label: "Stage 9 — Implementation",
	async run(state, ctx) {
		const prepared = await prepareImplementationRun(state, ctx);
		if ("earlyResult" in prepared) return prepared.earlyResult;
		let {
			phases, setup, startInstructionFingerprint, phaseStartDirt,
			redAssistArmed, phaseResearchAssistUsed, phaseStatus, runStartDirt,
			phaseGuidanceReentryUsed, phaseProtectionStrikes, stageEntryBaselineCommit,
			pendingRollbackStash, protectionInterval, lastFailures, phasesCompleted, allGreen,
			envBlockedPhases, convergenceBlocked, convergenceBlockReason, filesModified,
			runFuse, attemptDurations, attemptStartedAt, attemptDurationClosed,
			inheritedRedFlakeGrantUsed,
		} = prepared;
		// increment 9: the inherited-red ladder takes the run-scoped flake grant by
		// reference (in/out holder) — the let below still persists to state at the
		// stage tail, unchanged.
		const inheritedRedFlakeGrant = {
			get used() { return inheritedRedFlakeGrantUsed; },
			set used(v: boolean) { inheritedRedFlakeGrantUsed = v; },
		};

		for (const [idx, phase] of phases.entries()) {
			// F9-C (v0.3.67): once a REPLAN round is routed, the spec artifacts are
			// invalidated — remaining phases are DEFERRED to the post-restart pass
			// (named, P10) instead of executing a superseded plan. The phase that
			// routed already broke naturally; partial-preserve is untouched.
			if (replanPending(state)) {
				ctx.log(`Implementation: REPLAN pending — deferring remaining phase(s) (${phases.length - idx} of ${phases.length}) to the post-restart pass; the current spec artifacts are invalidated`);
				break;
			}
			const phaseId = `phase-${pad(idx + 1)}`;
			const phaseName = (phase as { name?: string }).name?.trim() || phaseId;
			// v0.3.85 F3 (decision 2): run wall fuse — PHASE-BOUNDARY check. When the
			// fuse cannot fund another attempt (exhausted, or remaining below the
			// trailing-3-attempt median duration), defer the remaining phases to the
			// resumed pass instead of starting work that cannot finish inside the
			// window. Wind-down only, never mid-write: converged phases keep their
			// deterministic commits, resume-cache rows are written normally, and the
			// run's terminal state becomes `partial (wall-fuse)` — resumable by
			// design, never a FatalAbort. convergenceBlocked stops the §D loop from
			// re-entering this pass (re-entry is pointless — only a resumed pass gets
			// a fresh fuse window).
			{
				const fuseBoundary = runFuseWindDown(runFuse, attemptDurations);
				if (fuseBoundary.blocked) {
					runFuse.tripped = true;
					runFuse.tripReason = fuseBoundary.why;
					markRunWallFuseTripped(state, runWallFuseMs(), `phase boundary ${phaseId}: ${fuseBoundary.why}`);
					convergenceBlocked = true;
					convergenceBlockReason = `wall-fuse: ${fuseBoundary.why}`;
					// Fix-round 1: deferred phases are NOT green — without this the deferral
					// break leaves the stage-scope `allGreen = true` default intact and
					// deriveRunStatus could report SUCCESS for work decision 2 defers to
					// the resumed pass; the pass is `partial (wall-fuse)`, never success.
					allGreen = false;
					ctx.log(`Implementation: wall fuse at the ${phaseId} boundary — ${fuseBoundary.why}; deferring remaining phase(s) (${phases.length - idx} of ${phases.length}) to the resumed pass (fresh fuse window); converged phases stay committed`);
					break;
				}
			}
			const expectedScenarios = expectedScenariosForPhase(phase, state.spec ?? null, state.bdd ?? null);
			const phaseHeadline = `Implementation — Phase ${idx + 1}/${phases.length}: ${phaseName}`;
			const phaseLabel = `↳ Phase ${idx + 1}/${phases.length}: ${phaseName}`;
			const {
				emitPhaseStatus, ensurePhaseRunning, announceActivity, emitStep, runStep,
				inStepScope, attemptDetail, nextStepSeq,
			} = createPhaseStatusKit(ctx, { phaseId, phaseLabel, phaseHeadline });
			// §D: skip a phase already green in a prior convergence iteration (don't
			// re-touch done work — the state-confusion churn §F fought).
			if (phaseStatus.some((p) => p.id === phaseId && p.status === "green")) {
				phasesCompleted++;
				emitPhaseStatus("ok");
				ctx.log(`Implementation ${phaseId} already green (prior convergence iteration) — skipping`);
				continue;
			}
			// v0.3.0 windup bound (review code-F4 / adv SD030-3): a phase that went
			// partial with the SAME failure signature in MAX_PARTIAL_REENTRIES prior
			// passes is hopeless this run — skip it so the global budget flows to the
			// phases that can still converge (never-zero is preserved: the stash
			// holds its best attempt and the summary reports it as partial).
			{
				const prior = phaseStatus.find((p) => p.id === phaseId);
				const priorFailures = (lastFailures.find((f) => f.phaseId === phaseId)?.reasons ?? []).join("; ").slice(0, 200);
				if (prior && prior.status === "partial" && (prior.partialReEntries ?? 0) >= MAX_PARTIAL_REENTRIES && prior.lastFailureSig === priorFailures) {
					ctx.log(`Implementation ${phaseId} partial for ${prior.partialReEntries! + 1} passes with the same failure signature — skipping further re-entry this run (best attempt stays stash-preserved; budget flows to remaining phases)`);
					continue;
				}
			}
			// ── Wave 3 D-D (058 Layer 4 — NEW-2/NEW-3): checkpoint rollback at
			// convergence re-entry. The §D walk is RE-ENTERING this non-green phase K
			// after later phases already ran (their artifacts contaminate K's
			// convergence ground — the S-B class). Reset the worktree to
			// latestGreenCommitBefore(K) ?? the stage-entry baseline, stash downstream
			// uncommitted state, and INVALIDATE the green stamps of K+1..N (their
			// detached deterministic commits are documented as abandoned; recovery is
			// re-execution through the normal walk — never cherry-pick, which would
		// hand conflict resolution to an LLM: the exact defect class this removes).
			// Self-limiting: after the first rollback in a pass, the invalidated
			// downstream entries are gone, so later non-green phases no longer match
			// the laterPhasesRan predicate (at most one rollback per §D entry).
			// v0.4.29 gate fold (adv F2 / code F1): rebind ONLY when the module actually
			// stashed. The parent assigned inside the `rolled-back` branch; an unconditional
			// assign is equivalent today (the binding is null at every call — proven by
			// both gates), but it would silently clobber a revived mid-flight stash with no
			// P10 log the day one is ever persisted across a pass boundary.
			const rollbackStash = handleConvergenceRollback({
				setup, idx, totalPhases: phases.length, phaseStatus, phaseId,
				baselineCommit: stageEntryBaselineCommit, phaseStartDirt, phaseProtectionStrikes,
				log: (line) => ctx.log(line),
			});
			if (rollbackStash) pendingRollbackStash = rollbackStash;
			let green = false;
			let attemptErrors: string[] = [];
			let attemptsRun = 0;
			let terminalFailureKind: "red-generation" | "implementation-gate" = "implementation-gate";
			let terminalRedTries = 0;
			let terminalStopReason: "budget" | "no-progress" | "failed" | "environment-blocked" | "phase-attempt-cap" | "phase-wall" | "wall-fuse" | "inherited-red" | "declared-handoff" | "red-weakening" | "already-satisfied-blocked" = "failed";
			// v0.3.57 liveness: set when the worktree vanished under a running phase —
			// breaks the PHASE loop after this phase's partial bookkeeping (remaining
			// phases cannot run in a deleted worktree; re-probing each is pure noise).
			let worktreeGone = false;
			// Track 30 PRA (T3.2 — SCENARIO-005, AC-03): the environmental-blocker
			// one-gate-re-run budget. Per-phase hoisted state — reset each convergence
			// iteration (a later re-entry gets a fresh budget of exactly 1) and grants
			// EXACTLY ONE post-quarantine re-run; D-2: no delay-based anti-windup.
			// increment 10: the quarantine/re-gate grant as an in/out holder (the
			// module consumes it; one grant per phase, surviving attempts).
			const envBlockerRegate = { used: false };
			// v0.3.79 A2 (spec-25 run 14-14): count BLOCKING phase-boundary
			// reverts in this phase — a repeated no-progress signature coinciding
			// with reverts is a DETERMINISTIC plan contradiction, and the
			// no-progress valve below becomes contradiction-informed (replan-
			// upstream offered) instead of blind retry (the run burned 6 attempts
			// ≈2h before its generic valve fired and then discarded the verdicts).
			let boundaryRevertHits = 0;
			let boundaryLeakOwners: string[] = [];
			let boundaryLeakFiles: string[] = [];
			// v0.3.85 F3 (decision 2): per-phase wall anchor — resets on each §D
			// re-entry by construction (stage-run scope). Checked before each new
			// implementer attempt in the phase.
			const phaseWallStartedAt = Date.now();
			// v0.3.85 F3 (decision 4): consecutive-same-FaultClass streak for the
			// failure-category recurrence valve — resets on a non-matching class
			// and, via phase scope, on §D re-entry.
			let faultClassStreak: { faultClass: FaultClass; count: number } | null = null;
			// v0.3.87 S4(b) (decision 9): research-assist trigger state — phase-loop
			// scope, so it resets per §D re-entry (the faultClassStreak convention).
			// The GREEN side arms a PENDING dispatch at faultClassStreak ≥ 2; the
			// dispatch itself happens at the NEXT attempt's corrective-prompt assembly
			// (immediately before the implementer call — report-always-accompanies-
			// execution; a terminal break after arming simply leaves the pending state
			// unused: nothing was dispatched, never report-only). The implementer's
			// optional needsResearch entries are ARCHIVED here (in-memory per phase;
			// the field never dispatches by itself) and enrich the dispatched question.
			let researchAssistPending: ResearchAssistGreenTrigger | null = null;
			const needsResearchArchive: NeedsResearchEntry[] = [];
			// v0.2.6 G1 — dirt PROVENANCE: the phase's FIRST-EVER start porcelain
			// snapshot, PERSISTED across §D convergence iterations (adversarial
			// sd26-F1: the outer loop re-invokes the whole stage with no cap, so a
			// per-run snapshot would re-capture AFTER a prior iteration's uncommitted
			// work hit disk — reclassifying the implementer's own live edits as
			// FOREIGN and re-opening the quarantine-own-work window this fix exists
			// to close). Dirt present in the phase's first-ever snapshot is FOREIGN
			// (prior-run / pre-phase state — the mac-run class the quarantine was
			// built for); dirt absent from it was modified during THIS PHASE (the
			// implementer's undeclared edits — never stashable). A snapshot git
			// failure degrades to [] (listPorcelainPaths never throws, never returns
			// null) — treated as ZERO foreign dirt: unknown provenance can never
			// support an environment claim or a worktree mutation (safe direction is
			// the product ladder). Runs 01-47 / 05-09 died on exactly the missing
			// distinction: a clean-at-start tree classified `environmental-blocker`
			// and the quarantine stashed the implementer's own live fix.
			// J9-a: judge diagnosis to surface at the human boundary when it escalates.
			let redJudgeDiagnosis = "";
			// ADV-v0379-4: honest labeling — the v0.3.79 corrective floor escalates with
			// UNVERIFIED evidence (zeroed); "verified evidence" is only true for routed
			// verdicts or evidence-carrying escalates (route-not-offered).
			let redJudgeEvidenceLabel = "verified evidence";
			let attemptProgressHistory: ProgressSignature[] = [];
			// J9-b: judge guidance at the implementer no-progress boundary (the
			// diagnosis/evidence-label carriers moved into no-progress-valve.ts,
			// increment 12 — they were region-local).
			let judgeGuidance = "";
			// Wave 3 D-B (058 Layer 2): the strike-1 protection education block — set
			// by the post-join pre-build-gate choke point, consumed ONCE by the next
			// implementer re-prompt (the judgeGuidance consumed-on-use pattern).
			let protectionEducation = "";
			// AND-semantics (AC-03 → SCENARIO-011..015): the missing DELIVERABLE entries
			// from the previous attempt, fed into the next implementer retry under a
			// `## Deliverables still missing — create/wire these` block. Resets each
			// attempt, mirroring `attemptErrors = gate.errors`.
			let missingDeliverables: string[] = [];
			// v0.3.49 coverage gate: per-attempt feedback lines from a
			// below-threshold coverage measurement — fed into the next implementer
			// retry under a `## Coverage below the hard floor` block. Resets each
			// attempt, mirroring `missingDeliverables`.
			let coverageGap: string[] = [];
			// spec-11 AC-07 (SCENARIO-015): the change-gate's `claimedNotChanged` from
			// the previous attempt — claimed files git did NOT show changed — fed into
			// the next implementer retry under a `## Claimed changes not present in git`
			// block. Resets each attempt, mirroring `missingDeliverables`.
			let claimedNotChanged: string[] = [];
			// Symbol/hollow-file gate: claimed source deliverables that EXIST but contain
			// NO code (doc-comment-only shells) — fed into the next implementer retry.
			let hollowFiles: string[] = [];
			// Once a phase has a valid RED boundary, GREEN-side retries should reuse it
			// instead of asking tdd-guide to resample tests after every build/deliverable
			// failure. The cache is invalidated only when the GREEN attempt changes a
			// confirmed RED test file, because that corrupts the test oracle itself.
			let acceptedRed: AcceptedRedContext | null = null;
			// Snapshot of the confirmed RED test files' contents (captured when RED
			// confirms), persisted across GREEN attempts so changedSinceSnapshot can
			// detect implementer edits to test files on EVERY retry — not only on
			// the attempt where RED freshly ran.
			let redTestSnapshot = new Map<string, string | null>();
			// Evidence-carrying RED re-author (unsatisfiable-test loop): when the
			// implementer proves a confirmed RED test is unsatisfiable (testDefects),
			// we re-run tdd-guide WITH the implementer's diagnosis instead of blind.
			// `reauthorEvidence` is appended to the tdd-guide prompt; cleared once a
			// fresh RED is accepted. `challengeReauthors` bounds the proactive loop.
			let reauthorEvidence = "";
			// v0.3.0: advisory note carried from a merely-weak RED review into the
			// implementer prompt (the RED is accepted; the note guides implementation).
			let redWeaknessAdvisory = "";
			// v0.3.43 RC2 (pipelining): the RED review is READ-ONLY, so it is launched
			// at RED-acceptance time WITHOUT awaiting and runs concurrently with the
			// implementer; the verdict is joined immediately after the implementer
			// returns (below). STRONG/weak proceed exactly as the serial path did;
			// a contradiction/invalid/error verdict is fail-closed — the GREEN work is
			// discarded (git restore of non-test changes) and the RED is re-authored
			// with the review's evidence. Measured win: the ~8-12 min review window
			// leaves the critical path (13 reviews = 115 min on run 2026-08-30T08-17).
			let redReviewInFlight: Promise<{ control: unknown; error?: string } | null> | null = null;
			// v0.3.43 hard bound: the join-rejection `continue` routes back BEFORE the
			// attempt loop's no-progress detector runs, so a reviewer that keeps
			// rejecting could loop forever. Cap the parallel re-author cycle; past
			// the cap the phase stops as no-progress (the §D partial path preserves work).
			let parallelReviewRejects = 0;
			const MAX_PARALLEL_REVIEW_REJECTS = 3;
			// v0.3.53 F2 (P5 — fail-open for checker failures): violations of the
			// REVIEWER itself (boundary violation / timeout / spawn error) are NOT
			// suite evidence. Counted separately from suite rejections; after 2 the
			// parallel review is disabled for the phase and the deterministic gates
			// (post-RED oracle, deliverable, symbol, coverage) remain authoritative.
			// Live receipts: run 2026-08-31T16-03-57-978Z phases 05/06/07 burned ~5h
			// total because 8+ reviewer violations each discarded correct GREEN work
			// and re-authored the RED.
			let phaseReviewViolations = 0;
			// v0.3.53 F1 (P6 — shared capability at common-ancestor scope): the
			// cached runner + discovery guard were block-scoped inside the fresh-RED
			// branch, so the post-RED oracle call sites could NOT pass the runner and
			// silently ran conventions-only. Nested project test dirs
			// (cosmic-clock-3d/tests/…) match no convention anchor → zero plans →
			// `unknown` with NO diagnostic → false `tdd-targets-unverified` →
			// no-progress partial (same run, phases 01/02; the judge reproduced
			// 13/13 green independently). Declared here so every oracle call site in
			// the attempt loop reaches the same validated runner.
			let runnerSpec: TestRunnerSpec | null = readCachedTestRunner(setup.specDirectory);
			// v0.3.57 review F-E: conventions-derived coverage runner captured at
			// RED time (pre-implementer). The gate must measure the derivation that
			// produced the RED verdict — re-deriving at gate time reads
			// implementer-mutable worktree state (a legit-looking package.json edit
			// between RED and the gate steers the derivation to no recipe →
			// unmeasurable → the 85% floor dodged with only a loud advisory).
			let covConventionsSpec: TestRunnerSpec | null = null;
			let runnerDiscoveryTried = runnerSpec !== null;
			let challengeReauthors = 0;
			let implDefects: TestDefect[] = [];
			let implTextTail = "";
			// Phase bracketing (spec-11 Phase 3, AC-04 → SCENARIO-008/009): snapshot the
			// git baseline BEFORE the attempts so each per-attempt `tracker.end`
			// computes the delta from phase start; the change-gate reads the freshest
			// end-record. Never throws (tracker contract); no-op when no tracker active.
			const tracker = getActiveTracker();
			// §F #1 — pre-implement no-op detection (the state-confusion root cause):
			// ONLY for explicit resume runs. A fresh run must never count pre-existing
			// files/patterns as a completed phase without TDD + build verification.
			// Even on resume, this is a verified no-op: run the deterministic build gate
			// and full deliverable check before marking the phase green.
			const phaseDeliverables = (phase as { deliverables?: DeliverableContract }).deliverables;
			// increment 23: phase entry — the resume-only verified no-op adjudication (§F #1)
			// + the phase-start capture (dashboard rows, tracker.begin, the F2 first-ever
			// dirt snapshot). skip ⇒ verified no-op; enter ⇒ seeds carry over ONLY on the
			// resume-rejected arm (attemptErrors/missingDeliverables), phaseStartSet rides the record.
			const entry = enterPhase({
				ctx, state, phaseId, phaseDeliverables, tracker, phaseStatus, lastFailures, phaseStartDirt,
				worktreePath: setup.worktreePath, defaultBranch: setup.defaultBranch,
				ensurePhaseRunning, announceActivity, emitPhaseStatus,
			});
			if (entry.kind === "skip") {
				phasesCompleted++;
				continue;
			}
			attemptErrors = entry.attemptErrors;
			missingDeliverables = entry.missingDeliverables;
			const phaseStartSet = entry.phaseStartSet;
			for (let attempt = 1; ctx.budget.check(); attempt++) {
				// v0.3.85 F3: close out the PREVIOUS attempt's wall duration first — the
				// trailing-3-attempt median the run-fuse wind-down compares against is
				// consulted at every new attempt's entry AND at phase boundaries.
				if (attemptStartedAt > 0 && !attemptDurationClosed) {
					attemptDurations.push(Date.now() - attemptStartedAt);
					attemptDurationClosed = true;
				}
				// v0.3.85 F3 (decision 4): attempt cap — counts implementer attempts per
				// phase per §D entry (RED-generation tries inside an attempt keep their
				// own MAX_RED_RETRIES bound and are never counted here; the ≥2
				// same-signature partialReEntries block is untouched). Exhaustion ends
				// the phase partial with the NAMED reason `phase-attempt-cap`, which
				// feeds the F2 boundary logic like any partial.
				if (attempt > maxPhaseAttempts()) {
					terminalStopReason = "phase-attempt-cap";
					attemptErrors.push(`phase-attempt-cap: implementer attempt budget exhausted (SUPER_DEV_MAX_PHASE_ATTEMPTS=${maxPhaseAttempts()} per phase per §D entry; best attempt stays stash-preserved)`);
					ctx.log(`Implementation ${phaseId} attempt cap reached (${maxPhaseAttempts()} implementer attempts per phase per §D entry) — ending the phase partial (phase-attempt-cap)`);
					break;
				}
				// v0.3.85 F3 (decision 2): per-phase wall budget — checked before each
				// new implementer attempt within the phase; resets on each §D re-entry.
				// Structural floor: a phase ALWAYS gets its first attempt (the anchor is
				// taken at phase start; only budget-jitter between anchor and attempt 1
				// could pre-empt it — the wall bounds attempts ≥ 2, never zeroes a phase).
				if (attempt > 1 && Date.now() - phaseWallStartedAt >= phaseWallBudgetMs()) {
					terminalStopReason = "phase-wall";
					attemptErrors.push(`phase-wall: per-phase wall budget exhausted (SUPER_DEV_MAX_PHASE_WALL_MS=${phaseWallBudgetMs()}ms since phase start; resets on each §D re-entry)`);
					ctx.log(`Implementation ${phaseId} phase wall budget exhausted (${phaseWallBudgetMs()}ms since phase start) — ending the phase partial (phase-wall)`);
					break;
				}
				// v0.3.85 F3 (decision 2): run wall fuse — wind-down check before a NEW
				// attempt (an in-flight attempt always runs to its own
				// completion/timeout; overshoot is bounded by one attempt timeout).
				// No new attempt starts when the fuse is exhausted or the remaining
				// budget is below the trailing-3-attempt median duration.
				{
					const fuseAttempt = runFuseWindDown(runFuse, attemptDurations);
					if (fuseAttempt.blocked) {
						runFuse.tripped = true;
						runFuse.tripReason = fuseAttempt.why;
						markRunWallFuseTripped(state, runWallFuseMs(), `attempt boundary ${phaseId} attempt ${attempt}: ${fuseAttempt.why}`);
						convergenceBlocked = true; // §D re-entry is pointless this pass — only a resumed pass gets a fresh fuse window
						convergenceBlockReason = `wall-fuse: ${fuseAttempt.why}`;
						terminalStopReason = "wall-fuse";
						attemptErrors.push(`wall-fuse: ${fuseAttempt.why} — partial (wall-fuse), resumable by design (converged work stays committed; a resumed pass gets a fresh fuse window)`);
						ctx.log(`Implementation ${phaseId} wall fuse before attempt ${attempt} — ${fuseAttempt.why}; no new attempt starts (in-flight work already completed); phase ends partial (wall-fuse), remaining phases deferred to the resumed pass`);
						break;
					}
				}
				attemptsRun = attempt;
				attemptStartedAt = Date.now();
				attemptDurationClosed = false;
				redReviewInFlight = null; // v0.3.43: a stale in-flight review must never join a later attempt (the join/paths above always null it first — TS types the reset `never`, F3 verified dead)
				// v0.3.57 liveness: fail the attempt CLOSED when the worktree was
				// removed externally (silent-zombie incident, ledger 2026-09-01) —
				// children dispatched into a deleted cwd die silently and the
				// attempt would burn its whole timeout learning nothing.
				if ((setup as { worktreeCreated?: boolean }).worktreeCreated !== false && !existsSync(setup.worktreePath)) {
					terminalFailureKind = "implementation-gate";
					terminalStopReason = "environment-blocked";
					worktreeGone = true;
					attemptErrors.push(`worktree removed externally mid-run: ${setup.worktreePath}`);
					ctx.log(`Implementation ${phaseId} attempt ${attempt} aborted — WORKTREE GONE: ${setup.worktreePath} no longer exists (removed externally). Failing closed; remaining phases cannot run in a deleted worktree.`);
					break;
				}
				// v0.2.6 G1 — the phase reads the run-start dirt snapshot captured ONCE at
				// stage entry (line ~953, persisted across §D iterations per sd26-CR-1);
				// provenance is RUN-START, not per-phase, so this run's own work (any
				// phase's undeclared edits) is never foreign. No capture happens here — the
				// snapshot must predate ALL phase work to partition provenance honestly, and
				// RED test files written later are excluded from the dirt inventory via
				// testFiles anyway.
				announceActivity("Route specialist", attemptDetail(attempt));
				const specialist = await ctx.helper({ name: "route-specialist", sources: { "classify-task": state.classify }, options: { phase } });
				const lang = (specialist.value.languageInstructions as string) ?? "";
				// Gap 3 (AC-03 → SCENARIO-010): the RED-phase prompt carries the no-`--lib`
				// Rust verification discipline via the shared `langInstructions` slot so
				// `buildTddPrompt` and `buildImplementPrompt` reference the IDENTICAL
				// `RUST_SELF_VERIFY_DISCIPLINE` source string (single source of truth).
				// For non-rust setups `rustDiscipline(setup)` is "" and the specialist's
				// languageInstructions still flow through (no regression).
				let testFiles: string[] = [];
				let redStatus: RedStatus = "unknown";
				let redChangedFiles: string[] = [];
				let redEvidence: RedEvidence | null = null;
				if (acceptedRed) {
					testFiles = [...acceptedRed.testFiles];
					redStatus = acceptedRed.status;
					redChangedFiles = [...acceptedRed.changedFiles];
					announceActivity("Reuse RED", attemptDetail(attempt));
					ctx.log(`Implementation ${phaseId} reusing accepted RED for attempt ${attempt} (status=${redStatus}; tests=${testFiles.join(",") || "n/a"})`);
				} else {
					// RED phase: generate tests until the RED boundary and RED oracle are both
					// acceptable. Weak-green tests, broken tests, and RED pollution are retried
					// here before the implementer runs, so a bad RED sample does not consume or
					// masquerade as a GREEN implementation attempt.
					const redBaseline = gitStatusPaths(setup.worktreePath);
					const baselineDeliverablesSatisfied = phaseDeliverables ? deliverablesAlreadyMet(setup.worktreePath, phaseDeliverables, setup.defaultBranch) /* CR-R2-7 */ : false;
					let retries = 0;
					let redHint = "";
					const redProgressHistory: string[] = [];
					let redFailClosedUnknown = false; // v0.3.30 F2: unknown evidence retries/fails terminally ONLY when fail-closed (phase requires tests)
					// v0.3.30 C: cached runner spec + discovery guard — declared at PHASE
					// scope (v0.3.53 F1) so the post-RED oracle reaches the same runner;
					// discovery is a once-per-PHASE budget (resets on convergence
					// re-entry), not per fresh RED.
					// v0.3.16 review fix (code F-1/adv F-2): remember the last NON-EMPTY
					// claim across tries so an agent-death retry can still probe whether
					// the previously-claimed file is on disk (the claim itself is cleared
					// by F1 — correctly — but the DISK may hold the written file).
					let lastClaimedTestFiles: string[] = [];
					// v0.2.8 G4 (allow-scaffold): paths the judge has blessed as declaration-
					// only scaffolding this phase; re-admitted through the boundary on the
					// next try (the RED oracle remains the final guard).
					const redScaffoldApproved = new Set<string>();
					// Per-phase count of ROUTED judge interventions at the RED no-progress
					// boundary — after MAX_RED_JUDGE_ROUTES, only the fix-environment +
					// allow-scaffold floor remains (run 2026-08-27T12-33-43-088Z: 9 tries /
					// 5 judges / ~3.5h of ladder resets before the environment diagnosis
					// finally landed).
					let redJudgeRoutes = 0;
					// v0.3.30 F3 (review-2 F9: phase scope, not per-attempt): fix-environment
					// restarts are capped per PHASE so a convergence re-entry cannot reset
					// the cap.
					let redEnvRestarts = 0;
					while (ctx.budget.check()) {
					const redDiagnostics: RedCheckDiagnostic[] = [];
					const redTryDetail = attemptDetail(attempt, `try ${retries + 1}`);
					// increment 18 — the tdd dispatch + claim discipline (red-tdd-dispatch.ts):
					// the HEAD-drift advisory, the step-scoped tdd-guide call, the v0.3.16 F1
					// claim discard on a non-completed agent, and the streaming log. One
					// record; lastClaimedTestFiles rebinds only when the agent claimed files.
					const tddDispatch = await dispatchRedTdd({
						ctx,
						state,
						setup,
						phase,
						phaseId,
						attempt,
						retries,
						redTryDetail,
						redHint,
						reauthorEvidence,
						lang,
						testFiles,
						announceActivity,
						emitStep,
						inStepScope,
						nextStepSeq,
					});
					const { tdd, tddNotCompleted } = tddDispatch;
					testFiles = tddDispatch.testFiles;
					if (tddDispatch.lastClaimedTestFiles) lastClaimedTestFiles = tddDispatch.lastClaimedTestFiles;
					// increment 19 — the RED oracle cycle (red-oracle-cycle.ts): the runner-
					// cache scope guard, the oracle, the boundary + classification, the R1
					// fail-closed + F9-A no-edit routing, the Layer C runner discovery, the
					// stale-spawn heal, scenario coverage, the F5 ratchet call, the Tier 1/2
					// guards + parallel review launch, and the timeout hint. Record builder —
					// no loop exits; the three runner lets rebind each try.
					const oracleCycle = await runRedOracleCycle({
						ctx,
						state,
						setup,
						worktreePath: setup.worktreePath,
						specDirectory: setup.specDirectory,
						language: setup.language,
						phaseId,
						phaseName,
						phase: phase as never,
						attempt,
						retries,
						redTryDetail,
						tddError: tdd.error,
						tddNotCompleted,
						testFiles,
						lastClaimedTestFiles,
						redDiagnostics,
						redBaseline,
						runnerSpec,
						runnerDiscoveryTried,
						covConventionsSpec,
						expectedScenarios,
						phaseDeliverables,
						baselineDeliverablesSatisfied,
						redScaffoldApproved,
						phaseReviewViolations,
						announceActivity,
						runStep,
					});
					redStatus = oracleCycle.redStatus;
					redChangedFiles = oracleCycle.redChangedFiles;
					redEvidence = oracleCycle.redEvidence;
					// f32b6b36 F2: the module resets this PER TRY; the baseline leaked `true`
					// across tries within an attempt (declared before the while loop) — the
					// v0.3.30 F2 contract describes the CURRENT try's evidence, so the reset is
					// the documented intentional tightening.
					redFailClosedUnknown = oracleCycle.redFailClosedUnknown;
					runnerSpec = oracleCycle.runnerSpec;
					runnerDiscoveryTried = oracleCycle.runnerDiscoveryTried;
					covConventionsSpec = oracleCycle.covConventionsSpec;
					if (oracleCycle.redReviewInFlight) redReviewInFlight = oracleCycle.redReviewInFlight;
					const retryHint = oracleCycle.retryHint;
						if (retryHint && redEvidence.status !== "green-already-satisfied") {
							const ladder = await adjudicateRedRetryLadder({
								ctx,
								state,
								phaseId,
								phaseName,
								attempt,
								retries,
								redJudgeRoutes,
								redEnvRestarts,
								redJudgeDiagnosis,
								redJudgeEvidenceLabel,
								incomingStopReason: terminalStopReason,
								retryHint,
								redEvidence,
								testFiles,
								redChangedFiles,
								tddText: tdd?.text ?? "",
								worktreePath: setup.worktreePath,
								specDirectory: setup.specDirectory,
								specIdentifier: setup.specIdentifier ?? "unknown",
								redScaffoldApproved,
								redProgressHistory,
								replanAlreadyPending: replanPending(state),
								runFuseTripped: runFuse.tripped,
							});
							retries = ladder.routing.retries;
							redJudgeRoutes = ladder.routing.redJudgeRoutes;
							redEnvRestarts = ladder.routing.redEnvRestarts;
							redJudgeDiagnosis = ladder.routing.redJudgeDiagnosis;
							redJudgeEvidenceLabel = ladder.routing.redJudgeEvidenceLabel;
							redHint = ladder.routing.redHint;
							terminalStopReason = ladder.routing.terminalStopReason;
							if (ladder.kind === "f5-routed") attemptErrors = [...attemptErrors, ladder.attemptErrorsAppend];
							if (ladder.kind === "restart" || ladder.kind === "retry") continue;
							break;
						}
						break;
					}
					// v0.3.85 F5: a ROUTED red-weakening handoff ends the phase partial with
					// the NAMED reason — bypass the unaccepted-RED terminal block below (its
					// full changedFiles revert would destroy the surviving new test files,
					// and its reason overwrite would bury the handoff row; the scoped revert
					// already ran at the escalation site).
					// increment 17 — the RED acceptance boundary (red-acceptance.ts): the
					// F5 routed partial, the no-evidence terminal, the already-satisfied
					// MACHINE verification, the fail-closed terminal with the research-assist
					// arming, and the acceptance capture. 6-way outcome; the green trio and
					// the arming run in-module (by-ref surfaces), the caller owns the lets.
					const acceptance = adjudicateRedAcceptance({
						ctx,
						state,
						worktreePath: setup.worktreePath,
						defaultBranch: setup.defaultBranch,
						phaseId,
						attempt,
						terminalStopReason,
						retries,
						redEvidence,
						redStatus,
						testFiles,
						redChangedFiles,
						redFailClosedUnknown,
						phaseDeliverables,
						phaseStatus,
						lastFailures,
						phaseResearchAssistUsed,
						redAssistArmed,
						attemptDetail,
						announceActivity,
						emitPhaseStatus,
					});
					if (acceptance.kind === "red-weakening-partial") {
						terminalFailureKind = "red-generation";
						terminalRedTries = acceptance.terminalRedTries;
						break;
					}
					if (acceptance.kind === "no-evidence") {
						attemptErrors = ["red-generation: no RED evidence produced"];
						terminalFailureKind = "red-generation";
						terminalRedTries = 0;
						break;
					}
					if (acceptance.kind === "already-green") {
						green = true;
						break;
					}
					if (acceptance.kind === "already-fail") {
						attemptErrors = acceptance.attemptErrors;
						missingDeliverables = acceptance.missingDeliverables;
						// Run 2026-09-19T04-50-49-552Z — the already-satisfied-wall circuit
						// breaker. That run's phases 2–6 each burned 3–4 full attempts
						// (tdd-guide + implementer + oracle + gates ≈ 15–70 min each) against
						// an IDENTICAL wall: deliverables verified satisfied on disk, build
						// gate red on out-of-scope regressions new on the branch. The honest
						// tdd-guide no-op ("nothing to author, already green") was rejected by
						// the acceptance layer (correct P4) and F9-A correctly routed to the
						// already-satisfied verification — which then failed on the SAME gate
						// errors, and the generic retry re-dispatched agents that provably
						// could not change the outcome (≈40 dispatches, ~$50, 16h, wall-fuse).
						//
						// Control-flow note: this arm BREAKS the attempt loop (an already-fail
						// always ends the pass's attempts for this phase), so within-pass
						// recurrence cannot exist — the recurrence that burned the run lives
						// ACROSS §D convergence passes and ACROSS phases. Hence the durable
						// carrier: the wall signature rides this phase's PhaseStatusEntry
						// (state.implementation persists phaseStatus between passes), and the
						// deterministic block fires when the SAME signature is now observed
						// again — by THIS phase in a prior pass (still not green), or by a
						// DIFFERENT non-green phase (cross-phase; a phase that later went green
						// proves the wall was repaired and never blocks). Missing deliverables
						// never carry a signature (actionable by RED/GREEN — old semantics).
						const wallSig = acceptance.alreadySatisfiedWallSig;
						if (wallSig) {
							const priorSamePhase = phaseStatus.find((p) => p.id === phaseId && p.alreadySatisfiedWallSig === wallSig);
							const priorOtherPhase = phaseStatus.find((p) => p.id !== phaseId && p.status !== "green" && p.alreadySatisfiedWallSig === wallSig);
							// Record durably NOW (before the tail's upsert replaces the entry —
							// closePhaseTail carries the field across its replace).
							phaseStatusUpsert(phaseStatus, phaseId, "partial");
							const wallEntry = phaseStatus.find((p) => p.id === phaseId)!;
							wallEntry.alreadySatisfiedWallSig = wallSig;
							if (priorSamePhase !== undefined || priorOtherPhase !== undefined) {
								terminalStopReason = "already-satisfied-blocked";
								const wallOrigin = priorSamePhase !== undefined
									? "a prior convergence pass of this phase"
									: `phase ${priorOtherPhase!.id}`;
								attemptErrors.push(`already-satisfied-blocked: deliverables verified satisfied but the build gate failed on the same subject(s) as ${wallOrigin} (deliverables=true, build=false; wall signature: ${wallSig}) — RED/GREEN retries cannot change an out-of-phase failure; ending the phase partial (recorded for §D convergence / REPLAN)`);
								ctx.log(`Implementation ${phaseId} already-satisfied wall: same failing subject(s) as ${wallOrigin} with deliverables satisfied — ending the phase partial (already-satisfied-blocked) instead of retrying an unfixable wall`);
							}
						}
						break;
					}
					if (acceptance.kind === "red-terminal") {
						attemptErrors = acceptance.attemptErrors;
						terminalFailureKind = "red-generation";
						terminalRedTries = acceptance.terminalRedTries;
						terminalStopReason = acceptance.terminalStopReason;
						break;
					}
					acceptedRed = acceptance.acceptedRed;
				// A freshly (re)accepted RED consumed any prior challenge evidence —
					// clear it so a later UNRELATED re-author does not carry stale proof.
					reauthorEvidence = "";
					if (acceptance.redTestSnapshot) redTestSnapshot = acceptance.redTestSnapshot; // 8c5d07bc F1: null preserves the prior snapshot
				}
				// increment 20 — the corrective-prompt assembly (implementer-prompt.ts):
				// the advisory riders, the research-assist consumption, the retry
				// sections, the budget reminder, the prior-progress continuation, and
				// the redImplementContext tail. A builder with one dispatch; the caller
				// clears the consumed advisory lets (no reader between return and clear).
				const redTargetsExist = Array.from(redTestSnapshot.values()).some((content) => content !== null);
				const confirmedRedTargets = redStatus === "red" && testFiles.length > 0 && (redChangedFiles.length > 0 || redTargetsExist);
				const promptRound = await assembleImplementerPrompt({
					ctx,
					state,
					setup,
					worktreePath: setup.worktreePath,
					specDirectory: setup.specDirectory,
					phaseId,
					phaseName,
					attempt,
					phase,
					specialist: specialist.value,
					redStatus,
					testFiles,
					protectionEducation,
					judgeGuidance,
					redWeaknessAdvisory,
					redAssistArmed,
					researchAssistPending,
					phaseResearchAssistUsed,
					needsResearchArchive,
					attemptErrors,
					missingDeliverables,
					claimedNotChanged,
					hollowFiles,
					coverageGap,
					attemptProgressHistory,
					runStartDirt,
					acceptedRedChangedFiles: [...(acceptedRed?.changedFiles ?? [])],
					lastFailures,
				});
				const implPrompt = promptRound.implPrompt;
				if (promptRound.consumedProtectionEducation) protectionEducation = "";
				if (promptRound.consumedJudgeGuidance) judgeGuidance = "";
				if (promptRound.consumedRedWeaknessAdvisory) redWeaknessAdvisory = "";
				if (promptRound.consumedResearchAssistPending) researchAssistPending = null;
				// increment 21 — the implementer dispatch + claim parse
				// (implementer-dispatch.ts): the HEAD-drift advisory, the step-scoped
				// implementer call (explicit controlKeys contract), the structured-claim
				// parse with the internal-runtime filter, the needsResearch archive with
				// its P8 cap, and the streaming log. One record; the by-ref archive and
				// filesModified carries mutate in place.
				const implRound = await dispatchImplementer({
					ctx,
					state,
					worktreePath: setup.worktreePath,
					phaseId,
					attempt,
					implPrompt,
					needsResearchArchive,
					filesModified,
					attemptDetail,
					announceActivity,
					emitStep,
					inStepScope,
					nextStepSeq,
				});
				const { impl, projectStructured } = implRound;
				implDefects = implRound.implDefects;
				implTextTail = implRound.implTextTail;
				// ── v0.3.43 RC2 join: adjudicate the in-flight RED review ──────────────
				// The review ran concurrently with this implementer (read-only vs the
				// write lane). R2 fail-closed and the Fix 4 contradiction override are
				// enforced here verbatim: ONLY an explicit STRONG, contradiction-free
				// verdict lets the GREEN work proceed to the gates. A merely-weak
				// verdict stays advisory (the post-RED oracle is the deterministic
				// endpoint — same semantics as the serial path). Anything else
				// discards the GREEN work and re-authors the RED with the evidence.
				if (redReviewInFlight) {
					const reviewOutcome = await joinRedReview({
						ctx, state, worktreePath: setup.worktreePath, phaseId,
						review: redReviewInFlight, implControl: impl?.control, testFiles,
						maxParallelReviewRejects: MAX_PARALLEL_REVIEW_REJECTS, attemptsRun,
						parallelReviewRejects, phaseReviewViolations,
						terminalFailureKind, terminalRedTries, terminalStopReason,
						acceptedRed, redTestSnapshot, redWeaknessAdvisory, reauthorEvidence,
					});
					redReviewInFlight = null; // read once — a stale in-flight review must never join a later attempt
					const r = reviewOutcome.routing;
					parallelReviewRejects = r.parallelReviewRejects;
					phaseReviewViolations = r.phaseReviewViolations;
					terminalFailureKind = r.terminalFailureKind;
					terminalRedTries = r.terminalRedTries;
					terminalStopReason = r.terminalStopReason;
					redWeaknessAdvisory = r.redWeaknessAdvisory;
					reauthorEvidence = r.reauthorEvidence;
					acceptedRed = r.acceptedRed;
					redTestSnapshot = r.redTestSnapshot;
					if (r.attemptErrorsAppend) attemptErrors = [...attemptErrors, r.attemptErrorsAppend];
					if (reviewOutcome.kind === "terminal") break;
					if (reviewOutcome.kind === "restart") continue;
				}
				// ── Wave 3 D-B (058 Layer 2 — NEW-1): the protection-interval choke point.
				// A SYNCHRONOUS engine seam evaluated strictly AFTER the implementer
				// returned and the RED review joined, immediately BEFORE build-gate
				// dispatch — never a filesystem watcher or concurrent hook (NEW-1: a
				// watcher would re-introduce the S-C read-skew race inside the protection
				// mechanism itself). Zero cost / zero false positives when the protected
				// set is empty.
				// increment 8 — the protection choke point (protection-gate.ts): the
				// adjudication is extracted; the caller keeps only the phase-loop
				// interpretation. `reprompt` decrements the attempt (zero attempt cost:
				// the for-loop's ++ restores the SAME attempt number); `reauthor` clears
				// the RED context alongside the judge diagnosis; `terminal` stops the
				// phase as no-progress; `pass` falls through to the build gate below.
				const protectionGate = await adjudicateProtectionGate({
					ctx,
					state,
					worktreePath: setup.worktreePath,
					phaseId,
					phaseName,
					specIdentifier: setup.specIdentifier ?? "unknown",
					protectionInterval,
					declaredFootprint: [...projectStructured.filesCreated, ...projectStructured.filesModified, ...projectStructured.filesDeleted],
					phaseProtectionStrikes,
					attempt,
				});
				if (protectionGate.kind === "reprompt") {
					protectionEducation = protectionGate.education;
					attempt--; // zero attempt cost: the for-loop's ++ restores the SAME attempt number
					continue;
				}
				if (protectionGate.kind === "reauthor") {
					reauthorEvidence = protectionGate.reauthorEvidence;
					attemptProgressHistory = [];
					acceptedRed = null;
					continue;
				}
				if (protectionGate.kind === "terminal") {
					attemptErrors = [...attemptErrors, protectionGate.attemptError];
					terminalStopReason = "no-progress";
					break;
				}
				// increment 13 — the sequential gate-suite core (gate-suite.ts): the
				// HARD build oracle, the RC12c out-of-scope audit, the deliverable
				// contract (spec-10 bridge), the change and symbol gates, and the
				// BLOCKING cross-phase leak revert. No loop exits — one wide record;
				// the leak DELTA feeds the boundary-statistic unions exactly as the
				// inline mutations did.
				const suite = runGateSuite({
					ctx,
					state,
					worktreePath: setup.worktreePath,
					defaultBranch: setup.defaultBranch,
					language: setup.language,
					phaseId,
					attempt,
					phase: phase as never,
					phases: phases as Array<Record<string, unknown>>,
					idx,
					testFiles,
					projectStructured,
					rawStructured: implRound.rawStructured,
					tracker,
					announceActivity,
					attemptDetail,
				});
				const { gate, declaredScope, bridgedDeliverables, deliverableCheck, phaseChangeRec, changeGate, symbolGate } = suite;
				attemptErrors = gate.errors;
				missingDeliverables = deliverableCheck.missing;
				boundaryRevertHits += suite.leak.revertHits;
				if (suite.leak.owners.length) boundaryLeakOwners = [...new Set([...boundaryLeakOwners, ...suite.leak.owners])];
				if (suite.leak.files.length) boundaryLeakFiles = [...new Set([...boundaryLeakFiles, ...suite.leak.files])];
				claimedNotChanged = changeGate.claimedNotChanged;
				hollowFiles = symbolGate.hollowFiles;
				// increment 14 — the GREEN-boundary oracle (green-boundary.ts): the
				// post-RED TDD oracle (restore-don't-regenerate), the F4 door-in-the-
				// fence (FatalAborts stay throws), the coverage gate, and the GREEN
				// acceptance. The F4-routed arm carries the append message; the
				// caller owns green/terminalStopReason (the loop's own lets).
				let tddOracleFailures: string[] = [];
				let coverageResult: CoverageGateResult | null = null;
				const oracle = await runGreenBoundaryOracle({
					ctx,
					state,
					worktreePath: setup.worktreePath,
					specDirectory: setup.specDirectory,
					defaultBranch: setup.defaultBranch,
					specIdentifier: setup.specIdentifier,
					phaseId,
					attempt,
					phases: phases as Array<Record<string, unknown>>,
					idx,
					phaseStatus,
					lastFailures,
					acceptedRed,
					confirmedRedTargets,
					testFiles,
					redTestSnapshot,
					runnerSpec,
					covConventionsSpec,
					gate,
					deliverablePass: deliverableCheck.pass,
					changePass: changeGate.pass,
					symbolPass: symbolGate.pass,
					declaredScope,
					bridgedRequireFiles: bridgedDeliverables.requireFiles ?? [],
					projectStructured,
					replanAlreadyPending: replanPending(state),
					runFuseTripped: runFuse.tripped,
					emitPhaseStatus,
					announceActivity,
					attemptDetail,
				});
				tddOracleFailures = oracle.tddOracleFailures;
				coverageResult = oracle.coverageResult;
				// green/handoff arms reset the carry to [] (inline's reset ran before
				// the green predicate; the only coverageGap readers — the next
				// attempt's prompt build — are unreachable after either break, so the
				// handoff arm's [] is a dead-binding write either way; adversarial
				// e68a3167 NIT-1 documents the intent).
				coverageGap = oracle.kind === "continue" ? oracle.coverageGapOut : [];
				if (oracle.kind === "green") {
					green = true;
					break;
				}
				if (oracle.kind === "handoff-routed") {
					terminalStopReason = "declared-handoff";
					attemptErrors = [...attemptErrors, oracle.attemptErrorsAppend];
					break;
				}
				// Track 30 PRA (T3.1 — SCENARIO-001..004 · AC-01/AC-02): the deterministic
				// classification floor — pure TypeScript, no LLM (NFR-1) — runs at the
				// green-branch fall-through: AFTER the green predicate (so the own-scope
				// booleans exist) and BEFORE failureReasons/missing-test routing/challenge
				// re-author/signature (so an env-blocker can never be misrouted as a
				// challenge or re-spawn the implementer — AC-02). The classifier consumes
				// BuildGateResult; the gates themselves are untouched (D-11). The synthetic
				// `[baseline-verify]` block is excluded from the failure tally inside the
				// classifier (AC-01); absent baselineCheck / own-scope red ⇒ unclassified ⇒
				// today's retry semantics unchanged (SCENARIO-003).
				// v0.2.6 G1 — dirt inventory + PROVENANCE PARTITION before classification.
				// The canonical post-exclusion inventory is split against the phase-start
				// snapshot: foreignDirt (dirty at phase start — prior-run/foreign state,
				// the only quarantineable class) vs ownDirt (modified during THIS phase —
				// the implementer's undeclared edits, NEVER stashable: run 05-09's
				// quarantine stashed the implementer's own WriterId fix and manufactured
				// the re-gate's tsc failures). Unknown provenance (snapshot null) ⇒ zero
				// foreign dirt ⇒ no environment claim, no mutation (safe direction).
				const dirtPaths = collectDirtPaths({
					worktreePath: setup.worktreePath,
					specDirectory: setup.specDirectory,
					copiedEnvFiles: setup.copiedEnvFiles ?? [],
					extraExcluded: [...projectStructured.filesCreated, ...projectStructured.filesModified, ...projectStructured.filesDeleted, ...declaredScope, ...testFiles],
				});
				const runStartSet = new Set(runStartDirt);
				const foreignDirt = dirtPaths.filter((p) => runStartSet.has(p));
				// v0.3.49: NEW TEST FILES are exempt from own-dirt — the coverage
				// hard gate's retry step legitimately authors additional test files
				// (additive evidence, unlike RED files they are never restored),
				// and a hijacked RED test edit is guarded separately by the
				// tdd-tests-modified-during-green restore. Production paths keep
				// full own-dirt semantics.
				const looksLikeTestPath = (p: string) => /\.(test|spec)\.[A-Za-z0-9]+$/.test(p) || /(^|\/)(__tests__|tests?)\//.test(p);
				const ownDirt = dirtPaths.filter((p) => !foreignDirt.includes(p) && !looksLikeTestPath(p));
				// G1 feedback: the implementer's undeclared out-of-scope edits are NAMED in
				// the retry feedback (spec-only declared scope cannot be over-claimed away).
				const ownDirtFeedback = ownDirt.map((p) => `out-of-scope edit (this run): ${p} — fold it into the declared scope (requires a spec change) or revert it; it may be the cause of the out-of-scope failures below`);
				// G2/G3 carriers: the post-re-gate product fall-through replaces gate errors
				// with the re-run's; a judge implementer-retry override appends its diagnosis.
				let postRegateProductErrors: string[] | null = null;
				let envJudgeOverrideFeedback: string[] = [];
				const fault = classifyGateFault({
					errors: gate.errors,
					outOfScopeErrors: gate.outOfScopeErrors,
					baselineCheck: gate.baselineCheck,
					ownScope: { deliverablePass: deliverableCheck.pass, changePass: changeGate.pass, symbolPass: symbolGate.pass, tddClean: tddOracleFailures.length === 0 },
					foreignDirtCount: foreignDirt.length,
				});
				// v0.3.85 F3 (decision 4): the attempt's effective FaultClass for the
				// failure-category recurrence valve — re-classifications below
				// (post-quarantine re-run, judge override) replace the initial reading
				// so the streak counts the class the attempt actually ended as.
				let attemptFaultClass: FaultClass = fault.faultClass;
				if (fault.faultClass === "environmental-blocker") {
					// blocker branch — must break or hand off to judge; never `continue`;
					// never spawn the implementer (SCENARIO-004 · AC-02).
					//
					// T3.2 (SCENARIO-005/006/008/009 · AC-03): canonical dirt inventory —
					// computed ABOVE the classifier (v0.2.6 G1) and partitioned into
					// foreignDirt/ownDirt; the current-attempt exclusion set (implementer-
					// claimed files ∪ phase declaredScope ∪ testFiles) is in-loop ONLY (D-7
					// rule 5); the canonical spec-dir/bookkeeping/`.super-dev`/copiedEnvFiles
					// exclusions live once in the shared helper. RC12c-class undeclared edits
					// land IN the inventory (SCENARIO-009) as ownDirt — deliberately different
					// from trackerOutofScopeEdits' audit semantics (D-7).
				// increment 10 — the quarantine/re-gate/re-classification machinery
				// (env-blocker-regate.ts): the green-through break became a returned
				// variant; every fall-through collapses into `blocked`, which carries
				// gate2 (the judge region's latestGate input) and the null-or-value
				// re-classification fields the caller assigns ONLY when non-null.
				const envRegate = await runEnvBlockerRegate({
					ctx,
					state,
					worktreePath: setup.worktreePath,
					specDirectory: setup.specDirectory,
					copiedEnvFiles: setup.copiedEnvFiles ?? [],
					defaultBranch: setup.defaultBranch,
					phaseId,
					attempt,
					foreignDirt,
					runStartSet,
					dirtExclusions: [...projectStructured.filesCreated, ...projectStructured.filesModified, ...projectStructured.filesDeleted, ...declaredScope, ...testFiles],
					regateUsed: envBlockerRegate,
					bridgedDeliverables,
					ownScope: { changePass: changeGate.pass, symbolPass: symbolGate.pass, tddClean: tddOracleFailures.length === 0 },
					phaseStatus: phaseStatus as never,
					lastFailures: lastFailures as never,
					announceActivity,
					emitPhaseStatus,
					attemptDetail,
				});
				if (envRegate.kind === "green-through") {
					green = true;
					attemptErrors = envRegate.gateErrors;
					break;
				}
				if (envRegate.reclassifiedFaultClass !== null) attemptFaultClass = envRegate.reclassifiedFaultClass;
				if (envRegate.postRegateProductErrors !== null) postRegateProductErrors = envRegate.postRegateProductErrors;
				if (!envRegate.reRunClassifiedProduct) {
					// increment 11 — the judge hand-off (env-blocker-judge.ts): the single
					// runJudge dispatch at the blocker boundary, the D-5 soft HITL surface
					// (logged-only escalation, retry-with-guidance persistence), the T6.2
					// verdict record, and the terminal stop — or the G3 audited product
					// override falling through to failureReasons. envBlockedPhases and
					// phaseGuidanceReentryUsed mutate in place inside the module.
					const envJudge = await handOffEnvBlockerJudge({
						ctx,
						state,
						worktreePath: setup.worktreePath,
						specDirectory: setup.specDirectory,
						phaseId,
						phaseName,
						gate,
						gate2: envRegate.gate2,
						dirtPaths,
						phaseGuidanceReentryUsed,
						envBlockedPhases,
					});
					if (envJudge.kind === "override-retry") {
						attemptFaultClass = envJudge.faultClass;
						if (envJudge.postRegateErrors !== null) postRegateProductErrors = envJudge.postRegateErrors;
						envJudgeOverrideFeedback = envJudge.judgeOverrideFeedback;
					} else {
						terminalStopReason = envJudge.stopReason;
						if (envJudge.blockReason !== null) convergenceBlockReason = envJudge.blockReason;
						break;
					} // end the judge-hand-off interpretation (increment 11)
				} // end !reRunClassifiedProduct (adv-F5)
				} // end environmental-blocker branch
				const failureReasons = [
					// v0.2.6 G2: on the post-re-gate product fall-through the RE-RUN's errors
					// are the tree's current truth (the pre-quarantine gate errors describe a
					// worktree state that no longer exists).
					...(postRegateProductErrors ?? gate.errors),
					...missingDeliverables.map((e) => `deliverable: ${e}`),
					...claimedNotChanged.map((e) => `claimed-not-changed: ${e}`),
					...hollowFiles.map((e) => `hollow-file: ${e}`),
					...tddOracleFailures,
					// v0.2.6 G1/G3: name this attempt's undeclared out-of-scope edits and any
					// judge-override diagnosis so the implementer retry sees them explicitly.
					...ownDirtFeedback,
					...envJudgeOverrideFeedback,
				];
				attemptErrors = failureReasons;
				// Root-cause fix (deadlock): a `missing test: <name>` deliverable can
				// ONLY be satisfied by the RED author (tdd-guide) — the implementer is
				// forbidden from adding/altering RED tests (tdd-tests-modified-during-green).
				// Previously the retry told the implementer to "add the named tests",
				// producing the unsatisfiable A-vs-B gate contradiction that stalled the
				// phase at no-progress. Route it back to RED regeneration instead: drop the
				// accepted RED so the next attempt re-runs tdd-guide, which now receives the
				// exact requireTests names via buildTddPrompt and can author them.
				const missingTestDeliverables = missingDeliverables.filter((e) => /^missing (test|scenario):/i.test(e));
				if (missingTestDeliverables.length && acceptedRed) {
					acceptedRed = null;
					ctx.log(`Implementation ${phaseId} routing missing-test deliverable(s) back to RED regeneration (implementer cannot add RED tests): ${missingTestDeliverables.join("; ")}`);
				}
				// Implementer-driven RED re-author (unsatisfiable-test loop): if the
				// implementer PROVED a confirmed RED test is unsatisfiable (testDefects)
				// and this attempt still did not go green, the named test is genuinely
				// blocking. Drop acceptedRed and re-run tdd-guide WITH the implementer's
				// proof so the re-author fixes the contradiction instead of reproducing
				// it. Bounded by MAX_CHALLENGE_REAUTHORS; after the cap the existing
				// no-progress/HITL path below takes over. NOT an escape hatch: requires a
				// confirmed RED (acceptedRed) the implementer failed against AND a named
				// defect with a proof; the re-authored test still passes RED strength
				// review, and the no-progress detector guards a bad-faith loop.
				if (acceptedRed && implDefects.length && challengeReauthors < MAX_CHALLENGE_REAUTHORS) {
					challengeReauthors++;
					reauthorEvidence = formatReauthorEvidence(implDefects, implTextTail);
					const defectFiles = implDefects.map((d) => `${d.testFile}${d.lines ? ` (${d.lines})` : ""}`).join("; ");
					ctx.log(`Implementation ${phaseId} implementer challenge: confirmed RED test reported unsatisfiable — re-authoring RED with evidence (${challengeReauthors}/${MAX_CHALLENGE_REAUTHORS}; defects: ${defectFiles})`);
					attemptProgressHistory = [];
					acceptedRed = null;
					continue;
				}
				const progressSignature: ProgressSignature = {
					failure: failureSignature(failureReasons),
					footprint: changeFootprint(phaseChangeRec, projectStructured),
				};
				const signatureRepeat = repeatedNoProgress(attemptProgressHistory, progressSignature);
				// v0.3.85 F3 (decision 4): failure-category recurrence — the same
				// FaultClass across ≥ SUPER_DEV_FAULT_RECURRENCE (default 3) CONSECUTIVE
				// recorded attempts trips the existing no-progress valve even when every
				// footprint is fresh (C5: exact-signature matching alone let phases burn
				// 5-11 attempts on varying approaches). A non-matching class resets the
				// streak; §D re-entry resets it via phase scope. The update goes through
				// the module-scope pure helper — see its docstring for why (CFA `never`).
				faultClassStreak = nextFaultStreak(faultClassStreak, attemptFaultClass);
				const faultRecurrence = faultClassStreak.count >= faultRecurrenceLimit();
				// v0.3.87 S4(b) GREEN side (decision 9): the 2nd consecutive
				// same-FaultClass failure ARMS a pending assist — dispatched at the NEXT
				// attempt's corrective-prompt assembly. Arming is allowed even at ≥ the
				// no-progress valve's limit: the valve's judge routes often CONTINUE the
				// loop (re-author-tests / challenge-test / continue all reach another
				// implementer attempt); a terminal break simply leaves the pending state
				// unused — nothing was dispatched, never report-only. Per-phase cap ≤1
				// (P8), logged honestly when already spent.
				if (faultClassStreak.count >= RESEARCH_ASSIST_GREEN_TRIGGER_STREAK) {
					if (phaseResearchAssistUsed[phaseId]) {
						ctx.log(`Implementation ${phaseId} research-assist trigger (GREEN: fault-class ${attemptFaultClass} × ${faultClassStreak.count}) — per-phase assist cap already spent; proceeding WITHOUT assist`);
					} else {
						researchAssistPending = {
							triggerDetail: `fault-class ${attemptFaultClass} × ${faultClassStreak.count} consecutive attempt(s)`,
							contextLines: failureReasons.slice(0, 8),
						};
						ctx.log(`Implementation ${phaseId} research-assist ARMED (GREEN: fault-class ${attemptFaultClass} × ${faultClassStreak.count}) — research-agent will be dispatched before the next implementer attempt (if one starts)`);
					}
				}
				// ── Wave P1 D-C (Layer 3, DEC-3): tighten the EXISTING governor — plateau
				// + cross-scope routing build ON repeatedNoProgress/faultRecurrence, they
				// do not replace them. P8 (attempt-index bounds): the plateau fires at
				// the 2nd recorded attempt of the CURRENT signature window (history
				// non-empty — the first attempt of a fresh window, incl. after a judge/
				// challenge reset, is never a plateau); a FRESH footprint survives to
				// attempt 3 (via faultRecurrenceLimit) and the maxPhaseAttempts()=4 hard
				// cap stands for genuinely new signatures. Cross-scope conflicts route on
				// FIRST occurrence — the budget is never consumed on an unsatisfiable
				// goal. Ordering note: the inherited-red ladder above runs first at this
				// boundary (its own Tier-2/3 replan routes are the same destination).
				const zeroLandedChange = attemptProgressHistory.length > 0 && landedFootprintIsEmpty(progressSignature.footprint);
				// P6: attribution derives from the plan's requireTests mapping via the
				// canonical phaseClauseFiles grammar (own-scope = any clause form).
				const crossScopeCites = crossScopeTestCitations(extractFailingTestFilePaths(postRegateProductErrors ?? gate.errors), phases, idx);
				const crossScopeConflict = crossScopeCites.length > 0;
				const noProgress = signatureRepeat || faultRecurrence || zeroLandedChange || crossScopeConflict;
				// ADV-v0379-5: the contradiction valve's evidence must be from the SAME
				// repeated-signature window — a revert from an earlier, unrelated
				// signature must not arm the frame for this one.
				const lastSignature = attemptProgressHistory[attemptProgressHistory.length - 1];
				if (lastSignature && lastSignature.failure !== progressSignature.failure) {
					boundaryRevertHits = 0;
					boundaryLeakOwners = [];
					boundaryLeakFiles = [];
				}
				attemptProgressHistory.push(progressSignature);
				ctx.log(`Implementation ${phaseId} attempt ${attempt} FAIL: ${failureReasons.join("; ") || "phase gates unmet"}${faultRecurrence && !signatureRepeat ? ` [fault-category recurrence: ${attemptFaultClass} × ${faultClassStreak.count} consecutive attempt(s)]` : ""}`);
				// P10 (Wave P1 D-C): every failed attempt logs what the governor SAW —
				// signature delta, footprint delta, and scope attribution — so both the
				// trip and the non-trip are auditable in the run log.
				ctx.log(`Implementation ${phaseId} attempt ${attempt} governor: signature ${signatureRepeat ? "repeat (failure+footprint pair seen in an earlier attempt)" : "fresh"}; footprint ${zeroLandedChange ? "EMPTY (zero landed file changes)" : lastSignature && lastSignature.footprint === progressSignature.footprint ? "repeat" : "fresh"}; citations ${crossScopeConflict ? `CROSS-SCOPE: ${crossScopeCites.map((c) => `${c.file} (requireTests of ${c.ownerPhases.join(", ")})`).join("; ")}` : "same-scope or unattributable"}`);
				// increment 9 — the inherited-red tier ladder (inherited-red-ladder.ts):
				// the P3 run-state guards stay here (replan pending / env-override
				// feedback / post-regate product errors / run fuse); the ladder owns its
				// shape trigger and the tier adjudication. Tier-3 and handoff-unavailable
				// FatalAborts stay THROWS inside the module — they propagate through the
				// stage identically. attemptErrorsAppend lands uniformly BEFORE the kind
				// interpretation (the Tier-0 exhausted-budget fall-through keeps its
				// revert errors); ONLY flake-green REPLACES attemptErrors (the re-run
				// gate's verdict is the attempt's verdict).
				if (
					!replanPending(state)
					&& envJudgeOverrideFeedback.length === 0
					&& postRegateProductErrors === null
					&& !runFuse.tripped
				) {
					const irOutcome = await adjudicateInheritedRedLadder({
						ctx,
						state,
						worktreePath: setup.worktreePath,
						specDirectory: setup.specDirectory,
						specIdentifier: setup.specIdentifier ?? "unknown",
						defaultBranch: setup.defaultBranch,
						phaseId,
						idx,
						phases: phases as Array<Record<string, unknown>>,
						gate,
						ownScope: { deliverablePass: deliverableCheck.pass, changePass: changeGate.pass, symbolPass: symbolGate.pass, tddClean: tddOracleFailures.length === 0 },
						coverageBlocked: coverageResult?.status === "below-threshold",
						declaredScope,
						dirtPaths,
						phaseStartSet,
						attempt,
						lastFailures: lastFailures as never,
						phaseStatus: phaseStatus as never,
						flakeGrant: inheritedRedFlakeGrant,
						announceActivity,
						emitPhaseStatus,
						attemptDetail,
					});
					if (irOutcome.attemptErrorsAppend.length > 0) attemptErrors = [...attemptErrors, ...irOutcome.attemptErrorsAppend];
					if (irOutcome.kind === "tier0-retry") {
						continue;
					}
					if (irOutcome.kind === "flake-green") {
						green = true;
						attemptErrors = irOutcome.gateErrors;
						break;
					}
					if (irOutcome.kind === "handoff-routed") {
						terminalStopReason = "inherited-red";
						break;
					}
				}
				if (noProgress) {
				// increment 12 — the no-progress valve (no-progress-valve.ts): the
				// contradiction frames, the J9-b judge dispatch, the route arms
				// (replan-upstream / challenge-test / re-author-tests / continue),
				// the HITL escalation, and the terminal stop-class log. The five-way
				// outcome maps the region's four continues and two breaks; each arm
				// carries ONLY its bindings (the v0.4.33 discipline), with
				// challengeConsumed driving the caller-side counter increment.
				const npOutcome = await adjudicateNoProgress({
					ctx,
					state,
					worktreePath: setup.worktreePath,
					specDirectory: setup.specDirectory,
					specIdentifier: setup.specIdentifier ?? "unknown",
					phaseId,
					phaseName,
					framePhaseName: phases[idx]?.name ?? "", // F1: the frames' RAW name — never the phaseId fallback
					attempt,
					signatureRepeat,
					faultRecurrence,
					zeroLandedChange,
					attemptFaultClass,
					faultClassStreakCount: faultClassStreak?.count ?? 0,
					boundaryRevertHits,
					boundaryLeakOwners,
					boundaryLeakFiles,
					crossScopeConflict,
					crossScopeCites,
					failureReasons,
					progressSignatureFailure: progressSignature.failure,
					implTextTail,
					implDefects,
					acceptedRed,
					testFiles,
					challengeReauthors,
				});
				if (npOutcome.kind === "replan-routed") {
					redJudgeDiagnosis = npOutcome.diagnosis;
					terminalStopReason = "no-progress";
					break;
				}
				if (npOutcome.kind === "reauthor") {
					if (npOutcome.challengeConsumed) challengeReauthors++;
					reauthorEvidence = npOutcome.reauthorEvidence;
					attemptProgressHistory = [];
					acceptedRed = null;
					continue;
				}
				if (npOutcome.kind === "continue-guided") {
					attemptProgressHistory = [];
					judgeGuidance = npOutcome.judgeGuidance;
					continue;
				}
				if (npOutcome.kind === "retry-with-guidance") {
					reauthorEvidence = npOutcome.reauthorEvidence;
					attemptProgressHistory = [];
					acceptedRed = null;
					continue;
				}
				terminalStopReason = "no-progress";
				break;
				}
			}
			// v0.3.85 F3: close out the FINAL attempt's wall duration — a green break or
			// a terminal break never reaches a next attempt's entry, so without this
			// the phase-boundary fuse decision would not see a single-attempt green
			// phase's cost (the dominant shape for converged phases).
			if (attemptStartedAt > 0 && !attemptDurationClosed) {
				attemptDurations.push(Date.now() - attemptStartedAt);
				attemptDurationClosed = true;
			}
			if (!green && terminalStopReason !== "no-progress" && !ctx.budget.check()) terminalStopReason = "budget";
			// Close the phase bracket EXACTLY ONCE after the attempt loop: the
			// per-attempt probeEnd calls above computed the freshest cross-check
			// without appending; commitEnd persists that final record as the
			// single `end` jsonl line (single begin/end-per-phase nesting,
			// AC-04 → SCENARIO-008/009, review finding CR-MED). Never throws.
			if (tracker) tracker.commitEnd("phase", phaseId);
			// increment 15 — the phase tail (phase-tail.ts): the §D failure record,
			// the v0.3.0 partial preservation, the partial-status bookkeeping, the
			// S4 pending-stash retention, the green path's deterministic commit
			// (+ orchestrator fallback), and the stash re-apply. 3-way outcome;
			// stashCleared rides every arm (the caller owns the let).
			const tail = await closePhaseTail({
				ctx,
				state,
				setup,
				phaseId,
				phaseName,
				phaseNameRaw: (phase as { name?: string }).name as string,
				idx,
				totalPhases: phases.length,
				isGreen: green,
				terminalStopReason,
				terminalFailureKind,
				terminalRedTries,
				attemptsRun,
				attemptErrors,
				missingDeliverables,
				claimedNotChanged,
				hollowFiles,
				redJudgeDiagnosis,
				phaseStatus,
				lastFailures,
				envBlockedPhases,
				pendingRollbackStash,
				worktreeGone,
				emitPhaseStatus,
				announceActivity,
			});
			if (tail.stashCleared) pendingRollbackStash = null;
			if (tail.kind === "green") {
				phasesCompleted++;
			} else {
				allGreen = false;
				if (tail.kind === "worktree-gone") break; // v0.3.57 liveness
				continue;
			}
		}
		// increment 22: stage-close re-verification (commit fusion) — boundary closer
		const close = runStageCloseReverify({
			ctx, state,
			worktreePath: setup.worktreePath, defaultBranch: setup.defaultBranch,
			worktreeCreated: (setup as { worktreeCreated?: boolean }).worktreeCreated,
			phases, phaseStatus, envBlockedPhases, lastFailures,
		});
		phasesCompleted += close.flipsCompleted;
		lastFailures = close.lastFailuresOut; // content-identical when nothing flipped
		if (close.forceAllGreen) allGreen = true; // review P3: only on a full entry set, every row green
		const control: ControlObj = {
			phasesCompleted,
			totalPhases: phases.length,
			allGreen,
			filesModified,
			phaseStatus,
			lastFailures,
			// v0.2.6 G1/G4 (adversarial sd26-F1/F2 + code-review sd26-CR-1/CR-2):
			// the run-start dirt snapshot and the per-phase guidance-reentry grants
			// PERSIST across §D convergence iterations — the control rides
			// state.implementation exactly like phaseStatus.
			runStartDirt,
			// v0.3.85 F2: per-phase first-ever porcelain snapshots persist across §D
			// convergence iterations (the attribution boundary — see the phase-entry
			// capture); the per-run Tier-1 flake grant rides with them.
			phaseStartDirt,
			// v0.3.87 S4(b): research-assist per-phase state persists across §D
			// convergence iterations — the RED-side arm (dispatched at the re-entry's
			// first implementer round) and the per-phase assist cap (≤1, P8).
			redAssistArmed,
			phaseResearchAssistUsed,
			inheritedRedFlakeGrantUsed,
			phaseGuidanceReentryUsed,
			// Wave 3 (058 §4 D-B/D-D): per-phase protection strike counters
			// (`phaseProtectionStrikes: Record<phaseId, number>` — disjoint from 059's
			// writerMetadataRetryUsed:<stage>), the stage-entry baseline commit (the
			// NEW-3 rollback fallback), the serialized protection interval (derived
			// once per run — never re-scanned per §D entry), and the pending rollback
			// stash — all persist across §D convergence iterations like phaseStatus.
			phaseProtectionStrikes,
			stageEntryBaselineCommit,
			protectionInterval: serializeProtectionInterval(protectionInterval),
			rollbackStash: pendingRollbackStash,
			convergenceBlocked,
			convergenceBlockReason,
			runtimeInstructionFingerprint: runtimeInstructionFingerprint(state.setup?.specDirectory),
			invalidatedByRuntimeInstructions: false,
			summary: allGreen ? `All ${phases.length} phases completed successfully` : `${phasesCompleted}/${phases.length} phases completed`,
		};
		if (ctx.budget.check()) {
			ctx.phase("Implementation — Summary");
			const summaryResult = await ctx.agent({ id: "pipeline.implementation.summary", agent: "orchestrator", accessMode: "source-read-only", prompt: buildImplementationSummaryPrompt(setup, state.classify ?? null, control), schema: STAGE_MODELS["implementationSummary"]?.schema });
			renderAndWrite(setup, (m) => ctx.log(m), "implementationSummary", summaryResult.control as Record<string, unknown> | null);
		}
		const endInstructionFingerprint = runtimeInstructionFingerprint(state.setup?.specDirectory);
		const runtimeInstructionsChangedDuringRun = endInstructionFingerprint !== startInstructionFingerprint;
		if (runtimeInstructionsChangedDuringRun && phasesCompleted > 0) {
			control.allGreen = false;
			control.invalidatedByRuntimeInstructions = true;
			control.summary = "Runtime user instructions changed during implementation; re-run required";
			ctx.log("Implementation: runtime user instructions arrived during implementation — forcing one more convergence pass so earlier phases can incorporate them");
		}
		control.runtimeInstructionFingerprint = endInstructionFingerprint;
		return control;
	},
};
