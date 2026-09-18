/**
 * The GREEN-boundary oracle — increment 14 of the stage.ts split (the last
 * control-flow-dense region of the attempt loop).
 *
 * THE BLOCK THIS REPLACES (stage.ts, immediately after the gate-suite call):
 * the post-RED TDD oracle (GREEN-phase corruption of the confirmed RED tests —
 * restore the honest RED contents and retry, never re-run RED), the v0.3.85 F4
 * DOOR-IN-THE-FENCE (a deterministically restored test file belonging to a
 * prior PARTIAL phase's scope routes the declared handoff IMMEDIATELY — retry
 * is provably futile; two FatalAbort throws stay throws here), the v0.3.49
 * COVERAGE GATE (≥85% lines hard floor on the target program, measured from
 * the validated cached runner chain; unmeasurable families degrade to a loud
 * non-blocking ledger finding — never a silent green), and the GREEN
 * ACCEPTANCE break.
 *
 * THE OUTCOME (4 arms — mirrors the inline exits):
 *  - `green`          — the phase is GREEN (the upsert/emit/failure-cleanup
 *                       side effects have ALREADY run in-module, in the exact
 *                       inline order); the caller sets green=true and breaks.
 *  - `handoff-routed` — F4 routed the replan; the arm carries the append
 *                       message; the caller sets terminalStopReason
 *                       ="declared-handoff", appends the message, breaks.
 *  - `continue`       — not green: carries tddOracleFailures, coverageResult,
 *                       and the coverageGap carry (a PHASE-scoped binding the
 *                       next attempt's implementer prompt reads — the caller
 *                       rebinds it).
 * The two F4 FatalAborts (sub-cap spent / handoff-unavailable) stay `throw`s
 * inside the module.
 *
 * P3 run-state guards (replanPending, runFuse.tripped) are read at the module
 * boundary via boolean inputs — the guard is a pure read, its position is
 * unobservable.
 */

import type { StageContext, PipelineState } from "../../types.ts";
import { FatalAbort } from "../../nodes.ts";
import { triggerReplanForFindings, replanPending } from "../../replan/replan.ts";
import { countInheritedRedRows } from "../../replan/replan.ts";
import { INHERITED_RED_SOURCE, appendInheritedRedEvent, f4ScopeMatch } from "../inherited-red.ts";
import { runRedCheck, type RedCheckDiagnostic } from "../../build-runner.ts";
import { readCachedTestRunner, type TestRunnerSpec } from "../../build-runner/runner-discovery.ts";
import { deriveConventionsRunnerSpec } from "../../build-runner/conventions.ts";
import { runCoverageGate, type CoverageGateResult, coverageThreshold } from "../../build-runner/coverage-gate.ts";
import { recordConvergenceFindings } from "../../convergence-ledger.ts";
import { phaseStatusUpsert, type PhaseStatusEntry, type PhaseFailureEntry } from "./phase-status.ts";
import { redCheckOptions, cratesFromErrors } from "./phase-reentry.ts";
import { changedSinceSnapshot, restoreRedTestFiles } from "./red-evidence.ts";
import type { BuildGateResult, DeliverableContract } from "../../build-runner.ts";
import type { StructuredChanges } from "../../tracking.ts";

export interface GreenOracleInput {
	ctx: StageContext;
	state: PipelineState;
	/** setup fields (worktreePath, specDirectory, defaultBranch, specIdentifier). */
	worktreePath: string;
	specDirectory: string | undefined;
	defaultBranch: string | undefined;
	specIdentifier: string | undefined;
	phaseId: string;
	attempt: number;
	phases: Array<Record<string, unknown>>;
	idx: number;
	phaseStatus: PhaseStatusEntry[];
	lastFailures: PhaseFailureEntry[];
	/** The confirmed RED context (null → the oracle is skipped). */
	acceptedRed: { testFiles: string[] } | null;
	/** Whether confirmed RED targets existed for this phase. */
	confirmedRedTargets: boolean;
	testFiles: string[];
	redTestSnapshot: Map<string, string | null>;
	runnerSpec: TestRunnerSpec | null;
	covConventionsSpec: TestRunnerSpec | null;
	/** The gate-suite record fields the green predicate ANDs over. */
	gate: BuildGateResult;
	deliverablePass: boolean;
	changePass: boolean;
	symbolPass: boolean;
	declaredScope: Set<string>;
	bridgedRequireFiles: string[];
	projectStructured: StructuredChanges;
	/** P3 run-state guards (pure reads at the module boundary). */
	replanAlreadyPending: boolean;
	runFuseTripped: boolean;
	emitPhaseStatus: (status: "ok") => void;
	announceActivity: (activity?: string, detail?: string) => void;
	attemptDetail: (attempt: number, extra?: string) => string;
}

/** v0.3.85 F4 — the door in the fence needs the caller's replanPending state;
 *  pass the evaluated boolean so the module stays pure of state plumbing. */
export type GreenOracleOutcome =
	| { kind: "green"; tddOracleFailures: []; coverageResult: CoverageGateResult | null }
	| { kind: "handoff-routed"; attemptErrorsAppend: string; tddOracleFailures: []; coverageResult: CoverageGateResult | null }
	| { kind: "continue"; tddOracleFailures: string[]; coverageResult: CoverageGateResult | null; coverageGapOut: string[] };

/**
 * Run the GREEN-boundary oracle. `await` is required (the F4 replan route).
 * The F4 Tier-3 arms throw FatalAbort — exactly as inline.
 */
export async function runGreenBoundaryOracle(input: GreenOracleInput): Promise<GreenOracleOutcome> {
	const { ctx, state, worktreePath, specDirectory, defaultBranch, specIdentifier, phaseId, attempt, phases, idx, phaseStatus, lastFailures, acceptedRed, confirmedRedTargets, testFiles, redTestSnapshot, runnerSpec, covConventionsSpec, gate, deliverablePass, changePass, symbolPass, declaredScope, bridgedRequireFiles, projectStructured, emitPhaseStatus, announceActivity, attemptDetail } = input;
	const tddOracleFailures: string[] = [];
	// Detect GREEN-phase corruption of the confirmed RED tests on EVERY attempt
	// (the snapshot persists alongside acceptedRed), not only when RED freshly
	// ran. If the implementer edited a test file, RESTORE the honest RED
	// contents and retry the implementer with forceful feedback — do NOT
	// invalidate/re-run RED. The RED tests are valid; re-running tdd-guide
	// would re-author the same tests and the implementer would edit them
	// again (the prior non-converging loop). Restoring + a forceful retry
	// converges without wasting RED re-runs.
	if (acceptedRed) {
		const modifiedRedTests = changedSinceSnapshot(worktreePath, redTestSnapshot);
		if (modifiedRedTests.length) {
			const restoredCount = restoreRedTestFiles(worktreePath, redTestSnapshot, modifiedRedTests);
			ctx.log(`Implementation ${phaseId} post-red-oracle: implementer modified confirmed RED test file(s) during GREEN — RESTORED ${restoredCount}/${modifiedRedTests.length} (${modifiedRedTests.join(", ")}); keeping confirmed RED (no re-generation).`);
			// ── v0.3.85 F4 — the door in the fence (C4 fix; §9 F4, §14 ADR 8/10) ─
			// A deterministically restored test file that belongs to a prior
			// PARTIAL phase's scope (Arm A: declared clause files; Arm B:
			// recorded failing-test paths) routes the declared handoff
			// IMMEDIATELY — retry is PROVABLY futile (every subsequent
			// implementer attempt hits the same restore; F3's cap bounds the
			// UNDETECTABLE, not the detected — amendment 4). Shares F2's single
			// ≤1 source:"inherited-red" sub-cap; spent → Tier 3 FatalAbort.
			// No prior partial phase exists → F4 can never fire (the restore is
			// implementer error and today's behavior stands). P3: never route
			// after the run already ended — the replan marker OR a tripped run
			// wall fuse (the fuse state read directly, mirroring the F2 ladder
			// guard; structurally unreachable mid-attempt today because fuse
			// breaks happen at the attempt head — kept explicit).
			if (!input.replanAlreadyPending && !input.runFuseTripped) {
				const f4Match = f4ScopeMatch(modifiedRedTests, phases, phaseStatus, idx, lastFailures);
				if (f4Match) {
					const armLabel = f4Match.arm === "arm-a" ? "A: declared clause files" : "B: recorded failing-test paths";
					const f4PriorRows = countInheritedRedRows(specDirectory);
					if (f4PriorRows >= 1) {
						appendInheritedRedEvent(specDirectory, { event: "f4-handoff", phaseId, outcome: "tier3-fatal", arm: f4Match.arm, sourcePhase: f4Match.phaseId, paths: modifiedRedTests }, ctx.log);
						ctx.log(`Implementation ${phaseId} F4 door-in-the-fence: restored test file(s) ${modifiedRedTests.join(", ")} match prior partial phase ${f4Match.phaseId}'s scope (arm ${armLabel}) — inherited-red sub-cap already spent (${f4PriorRows} row(s)) — Tier 3 FatalAbort (stop-the-line; no retry loop)`);
						throw new FatalAbort(`inherited-red sub-cap spent at ${phaseId} F4 (v0.3.85, ADR 8/9): the restored test file(s) ${modifiedRedTests.join(", ")} belong to prior partial phase ${f4Match.phaseId}'s scope (arm ${f4Match.arm} — ${armLabel}), but the single source:"inherited-red" handoff row was already consumed. Stop-the-line — a second declared handoff is mechanically unavailable.`);
					}
					const f4Finding: Record<string, unknown> = {
						id: `f4-declared-handoff-${phaseId}`,
						file: f4Match.path,
						severity: "high",
						title: `test-edit ban deadlock at ${phaseId}: the restored test file belongs to prior partial phase ${f4Match.phaseId}'s scope (arm ${f4Match.arm})`,
						detail: `The GREEN-boundary restore deterministically reverted the implementer's edit to ${f4Match.path} — a file whose completion-relevant scope belongs to prior PARTIAL phase ${f4Match.phaseId} (arm ${f4Match.arm === "arm-a" ? "declared clause/target files" : "recorded failing-test file paths"}). Completing this phase requires editing that test file, which the GREEN test-edit ban mechanically forbids and restores: retry is provably futile. Amend the plan so the coupling is declared (co-ownership in this phase's contract, or a merged/reordered phase that owns both sides atomically). Restored path(s): ${modifiedRedTests.join(", ")}.`,
						ownerStage: "spec",
						source: INHERITED_RED_SOURCE,
						sourcePhase: f4Match.phaseId,
						handoffArm: f4Match.arm,
						recommendation: "Declare the coupling in the plan: give this phase co-ownership of the test file (any clause form counts), or merge/reorder so the phase that owns the production change also owns the atomic test amendment.",
					};
					let f4Routed = false;
					try { f4Routed = await triggerReplanForFindings(state, ctx, [f4Finding], "implementation", specIdentifier ?? "unknown"); } catch { f4Routed = false; }
					if (f4Routed) {
						appendInheritedRedEvent(specDirectory, { event: "f4-handoff", phaseId, outcome: "handoff-routed", arm: f4Match.arm, sourcePhase: f4Match.phaseId, paths: modifiedRedTests }, ctx.log);
						ctx.log(`Implementation ${phaseId} F4 door-in-the-fence: IMMEDIATE declared handoff — restored test file(s) ${modifiedRedTests.join(", ")} match prior partial phase ${f4Match.phaseId}'s scope (arm ${armLabel}); retry is provably futile, so the phase exits partial (declared-handoff (f4)) now and the run ends status "replan" — "requires a spec change" becomes a mechanism (row: source:inherited-red, sourcePhase:${f4Match.phaseId}, handoffArm:${f4Match.arm})`);
						return { kind: "handoff-routed", attemptErrorsAppend: `declared-handoff (f4): restored test file(s) ${modifiedRedTests.join(", ")} belong to prior partial phase ${f4Match.phaseId}'s scope (arm ${f4Match.arm}) — spec amendment routed (source:inherited-red, sourcePhase:${f4Match.phaseId})`, tddOracleFailures: [], coverageResult: null };
					}
					appendInheritedRedEvent(specDirectory, { event: "f4-handoff", phaseId, outcome: "handoff-unavailable", arm: f4Match.arm, sourcePhase: f4Match.phaseId, paths: modifiedRedTests }, ctx.log);
					ctx.log(`Implementation ${phaseId} F4 door-in-the-fence: declared handoff UNAVAILABLE (replan pool exhausted / marker set / ledger write failure) while the restored test file(s) provably belong to prior partial phase ${f4Match.phaseId}'s scope — Tier 3 FatalAbort (no retry loop)`);
					throw new FatalAbort(`F4 declared handoff unavailable at ${phaseId} (v0.3.85 F4, ADR 8): the restored test file(s) ${modifiedRedTests.join(", ")} belong to prior partial phase ${f4Match.phaseId}'s scope (arm ${f4Match.arm}), but the replan circuit could not route (pool exhausted, marker already set, or ledger write failure). Stop-the-line — no retry loop.`);
				}
			}
			// Re-run the oracle against the RESTORED tests so the retry feedback
			// carries the real status (green = the edit was the only blocker;
			// red = real assertions still need production code).
			announceActivity("Post-RED oracle (restored)", attemptDetail(attempt));
			const restoredDiagnostics: RedCheckDiagnostic[] = [];
			const restoredStatus = runRedCheck(worktreePath, acceptedRed.testFiles, redCheckOptions(ctx, phaseId, restoredDiagnostics, defaultBranch, runnerSpec ?? undefined));
			ctx.log(`Implementation ${phaseId} post-red-oracle: restored tests re-checked → ${restoredStatus} (ran: ${acceptedRed.testFiles.join(",") || "n/a"})`);
			tddOracleFailures.push(`tdd-tests-modified-during-green: ${modifiedRedTests.join(", ")} (RESTORED from confirmed RED; re-check=${restoredStatus})`);
		} else if (confirmedRedTargets) {
			announceActivity("Post-RED oracle", attemptDetail(attempt));
			const postRedDiagnostics: RedCheckDiagnostic[] = [];
			const postRedStatus = runRedCheck(worktreePath, testFiles, redCheckOptions(ctx, phaseId, postRedDiagnostics, defaultBranch, runnerSpec ?? undefined));
			ctx.log(`Implementation ${phaseId} post-red-oracle: ${postRedStatus} (ran: ${testFiles.join(",") || "n/a"})`);
			if (postRedStatus === "red") tddOracleFailures.push(`tdd-targets-still-red: ${testFiles.join(", ")}`);
			else if (postRedStatus === "broken") tddOracleFailures.push(`tdd-targets-broken-after-implementation: ${testFiles.join(", ")}`);
			else if (postRedStatus !== "green") tddOracleFailures.push(`tdd-targets-unverified-after-implementation: ${testFiles.join(", ")}`);
		}
	}
	// In-scope verdict (AC-05 → SCENARIO-012/013/014/025/027): the phase is GREEN
	// when the gate fully passed OR when every failure is a pre-existing
	// out-of-scope crate the branch never touched (gate.inScopePass). The
	// `if (!green)` branch below therefore fires ONLY on genuine in-scope
	// failures — neither pass nor inScopePass before the attempt loop stops — so
	// pre-existing breakage elsewhere can no longer abort green in-scope work.
	// spec-11 AC-07/AC-08 (SCENARIO-013): AND `changeGate.pass` so a
	// claimed-but-never-changed file hard-fails EVEN WHEN build + deliverable
	// both pass (the false-green killer, closed a second way).
	// v0.3.49 COVERAGE GATE (user mandate 2026-08-31): test coverage on the
	// TARGET program is a HARD GATE — ≥85% lines on phase production files,
	// striving for 100%. Deterministically measured from the VALIDATED cached
	// runner (vitest / node --test / go recipes; SUPER_DEV_COVERAGE_THRESHOLD
	// and SUPER_DEV_NO_COVERAGE_GATE switches). Unmeasurable families degrade
	// to a loud non-blocking advisory — never a silent green, never a
	// dead-lock. Runs ONLY when every other gate is already green so a
	// broken build never pays the coverage re-run cost.
	let coverageResult: CoverageGateResult | null = null;
	let coverageGapOut: string[] = [];
	// v0.3.56 F2: the runner chain is LIVE phase-scoped `runnerSpec` first
	// (v0.3.53 hoisted it here, so the old "cache DIRECTLY" comment was
	// stale), then the disk cache, then a conventions-derived spec — RED
	// that ran via conventions previously left the cache unwritten and the
	// `&& covRunnerSpec` below silently skipped the gate AND its advisory
	// (a silent green, P10). Only when NO runner exists at all does the
	// loud UNMEASURABLE advisory fire instead of silence.
	const covRunnerSpec = runnerSpec ?? readCachedTestRunner(specDirectory) ?? covConventionsSpec ?? deriveConventionsRunnerSpec(worktreePath, testFiles); // F-E: the captured-at-RED spec precedes a fresh (implementer-mutable) re-derive
	if ((gate.pass || gate.inScopePass) && deliverablePass && changePass && symbolPass && tddOracleFailures.length === 0) {
		if (covRunnerSpec) {
			const phaseProductionFiles = Array.from(new Set([
				...projectStructured.filesCreated,
				...projectStructured.filesModified,
				...declaredScope,
				...(bridgedRequireFiles ?? []),
			]));
			announceActivity("Coverage gate", attemptDetail(attempt));
			coverageResult = runCoverageGate(worktreePath, {
				runnerSpec: covRunnerSpec,
				phaseFiles: phaseProductionFiles,
				testFiles,
				log: (m) => ctx.log(`Implementation ${phaseId} coverage: ${m}`),
			});
			ctx.log(`Implementation ${phaseId} coverage-gate ${coverageResult.status.toUpperCase()}${coverageResult.linesPct !== undefined ? ` (${coverageResult.linesPct.toFixed(1)}% lines vs ≥${coverageResult.threshold}%)` : ""} — ${coverageResult.detail}`);
			if (coverageResult.status === "below-threshold") {
				coverageGapOut = [
					`${(coverageResult.linesPct ?? 0).toFixed(1)}% lines vs the ≥${coverageResult.threshold}% hard floor (recipe: ${coverageResult.recipe ?? "n/a"})`,
					...[...coverageResult.perFile].sort((a, b) => a.linesPct - b.linesPct).slice(0, 8)
						.map((f) => `${f.file}: ${f.linesPct.toFixed(1)}% lines${f.uncoveredHint ? ` (uncovered ${f.uncoveredHint})` : ""}${typeof f.functionsPct === "number" ? `, funcs ${f.functionsPct.toFixed(1)}%` : ""}`),
				];
			} else if (coverageResult.status === "unmeasurable") {
				// Loud carried debt — the phase still goes green (the gate cannot
				// invent a recipe for an unwired family), but the ledger records it
				// for review/verification to see.
				try {
					recordConvergenceFindings(state, {
						detectedAtStage: "implementation",
						ownerStage: "implementation",
						severity: "medium",
						blocking: false,
						title: `Phase ${phaseId} coverage gate UNMEASURABLE`,
						detail: coverageResult.detail,
						evidence: [covRunnerSpec.command.slice(0, 200)],
						sourceGate: "phase-coverage",
						recommendation: "Wire a deterministic coverage recipe into the project's test command (vitest --coverage / node --test --experimental-test-coverage / go test -coverprofile) so the ≥85% lines hard floor becomes enforceable.",
					}, { detectedAtStage: "implementation", ownerStage: "implementation", sourceGate: "phase-coverage" });
				} catch { /* ledger bookkeeping never blocks */ }
			}
		} else {
			// v0.3.56 F2: no runner exists at all — loud carried debt, never a
			// silent green (the old code skipped the gate silently here).
			coverageResult = { status: "unmeasurable", threshold: coverageThreshold(), perFile: [], detail: "no validated or conventions-derived runner for this phase — coverage could not be measured (before v0.3.56 this case skipped the gate SILENTLY)" };
			ctx.log(`Implementation ${phaseId} coverage-gate UNMEASURABLE — ${coverageResult.detail}`);
			try {
				recordConvergenceFindings(state, {
					detectedAtStage: "implementation",
					ownerStage: "implementation",
					severity: "medium",
					blocking: false,
					title: `Phase ${phaseId} coverage gate UNMEASURABLE`,
					detail: coverageResult.detail,
					evidence: testFiles.slice(0, 3),
					sourceGate: "phase-coverage",
					recommendation: "Ensure runner discovery or a conventions row claims this project's tests so the ≥85% lines hard floor becomes enforceable.",
				}, { detectedAtStage: "implementation", ownerStage: "implementation", sourceGate: "phase-coverage" });
			} catch { /* ledger bookkeeping never blocks */ }
		}
	}
	if ((gate.pass || gate.inScopePass) && deliverablePass && changePass && symbolPass && tddOracleFailures.length === 0 && coverageResult?.status !== "below-threshold") {
		phaseStatusUpsert(phaseStatus, phaseId, "green", attempt); // v0.3.85 S3: peak-attempts metric
		emitPhaseStatus("ok");
		const _gfi = lastFailures.findIndex((f) => f.phaseId === phaseId); if (_gfi >= 0) lastFailures.splice(_gfi, 1);
		if (gate.pass) {
			ctx.log(`Implementation ${phaseId} GREEN on attempt ${attempt}`);
		} else {
			ctx.log(`Implementation ${phaseId} IN-SCOPE GREEN on attempt ${attempt} — ${gate.outOfScopeErrors.length} pre-existing out-of-scope failure(s) ignored (crates: ${cratesFromErrors(gate.outOfScopeErrors).join(",")})`);
		}
		return { kind: "green", tddOracleFailures: [], coverageResult };
	}
	return { kind: "continue", tddOracleFailures, coverageResult, coverageGapOut };
}
