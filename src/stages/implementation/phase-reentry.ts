import { preservePartialPhase } from "./phase-status.ts";
import {AcceptedRedContext, MAX_RED_ENV_RESTARTS, MAX_RED_RETRIES, ProgressSignature, RED_WEAKENING_SOURCE, appendImplementationEvidence, boundarySummary, changeFootprint, changedSinceSnapshot, expectedScenariosForPhase, failureSignature, formatRedDiagnosticSummary, implementationRetrySection, nextFaultStreak, pad, porcelainEntries, preexistingTestSurfaceRows, recordImplementationConvergenceFailure, redDiagnosticsPrompt, redEvidenceLogLine, repeatedNoProgress, restoreRedTestFiles, restoreUnacceptedRedChanges, setDiff, snapshotFiles, trackerOutofScopeEdits} from "./red-evidence.ts";
/**
 * Stage 9 — Implementation (per-phase TDD).
 * Self-contained task: iterates the spec's phased task list. For each phase,
 * runs TDD-write → implement → build-gate until the phase is green, the global
 * run budget is exhausted, or the same actionable failure repeats with no
 * observable progress.
 * The build-gate is the DETERMINISTIC hard oracle (build-runner.ts) that
 * replaces the old QA self-report — no more vacuous pass on "agent said green".
 */

import { execFileSync, spawnSync } from "node:child_process";
import { harnessBasenames } from "../../harness-paths.ts";
import { superDevEnv } from "../../render/super-dev-dir.ts";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync , rmSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { BoundaryQuarantinePayload, ControlObj, PipelineState, Stage, StageContext } from "../../types.ts";

// v0.3.73 M1: re-exported for the salvage seam + tests.
import { classifyJudgeRoute } from "../../routing/router.ts";
import { appendGateChecked } from "../../runlog.ts";
import { getActiveTracker, isHarnessBookkeepingPath, isInternalRuntimeClaim } from "../../tracking.ts";
import type { ChangeRecord, StructuredChanges } from "../../tracking.ts";
import { localTimestamp } from "../../render/time.ts";
import { buildRedBoundaryPrompt, classifyObviousRedPath, isRuntimeEvidencePath, isSubstrateArtifact, redBoundaryResultFromAgent, redBoundaryResultFromClassifications, approveScaffoldPaths, type RedBoundaryResult } from "../../test-artifacts.ts";
import { buildTddPrompt, buildImplementPrompt, buildCommitPrompt, buildImplementationSummaryPrompt, buildRedReviewPrompt, rustDiscipline } from "../../prompts.ts";
import { firstCitedTestFile, runJudge, type JudgeRoute } from "../judge.ts";
import { triggerReplanForFindings, replanPending, countInheritedRedRows, pendingInheritedRedRows } from "../../replan/replan.ts";
import { planInlineRouteBack } from "../../routing/walker.ts";
import { RouteBackSignal } from "../../routing/router.ts";
// v0.3.85 F2 Tier 3 / F4 sub-cap + the validator hard-fail override: the
// stop-the-line terminal (ADR 9) and the restart-state pending-row probe.
import { FatalAbort } from "../../nodes.ts";
import { INHERITED_RED_SOURCE, appendInheritedRedEvent, countInheritedRedOccurrences, extractFailingTestFilePaths, f4ScopeMatch, inheritedRedAttribution, inheritedRedBoundaryShape, inheritedRedFlakeTally, normalizeRepoPath } from "../inherited-red.ts";
// v0.3.87 S4(b)+(d) (§9/§10 decision 9, §13, §14 ADR 6): the engine-mediated
// research assist — pure helpers + ledger + the one dispatch seam. §13:
// "research-assist" is a CONFIG ROLE KEY ONLY; the dispatch reuses
// research-agent, no agent file is created.
import { RESEARCH_ASSIST_ARCHIVE_CAP, RESEARCH_ASSIST_GREEN_TRIGGER_STREAK, RESEARCH_ASSIST_RED_TRIGGER_TRIES, parseNeedsResearch, runResearchAssist, type NeedsResearchEntry, type ResearchAssistRedArm, type ResearchAssistGreenTrigger } from "../research-assist.ts";
import { planFeasibilityFindings, contradictionFastFailFrame } from "../plan-feasibility.ts";
// 065 D-F-D/D-F-F: the Stage-9-entry gate (write×protect cross-product +
// plan compile-time checks) — two-locus mechanical findings routed through
// the SAME replan circuit plan-feasibility uses (no judge call needed).
import { stage9EntryGate, type EntryGateFinding } from "../../review/claim-spine.ts";
import { freshStageDocTexts } from "../../review/contract-validators.ts";
import { isNoEditCompletion } from "../../agent-errors.ts";
import { renderAndWrite } from "../../render/render.ts";
import { STAGE_MODELS, RedReviewData as RED_REVIEW_SCHEMA, TddCoverageControlData, FileClassifyControlData } from "../../render/schemas.ts";
import { userNotesForAgent } from "../../render/user-notes.ts";
import { extractScenarioIds, extractScenarioRefsFromControl, normalizePhases } from "../../doc-validators.ts";
import { computeChangeGate, computeSymbolGate, deliverablesAlreadyMet, resetDeliverableCheckCache, runBuildGate, buildGateCorrelationLine, runDeliverableCheck, runRedCheck, type BuildGateResult, type DeliverableContract, type GateOptions, type RedCheckDiagnostic, type RedCheckPlan, type RedStatus } from "../../build-runner.ts";
import { renderRetryFeedbackBlock, type RetryFeedback } from "../../retry-feedback.ts";
import { runInStepScope } from "../../step-scope.ts";
import { recordConvergenceFindings, type ConvergenceOwnerStage } from "../../convergence-ledger.ts";
import { stripVolatileNoise, classifyGateFault, collectDirtPaths, listPorcelainPaths, quarantineDirt, dirtyQuarantineEnabled, appendEnvironmentFault, readEnvironmentFaultCount, type FaultClass } from "../../fault-classification.ts";
import { freshRunWallFuseState, markRunWallFuseTripped, runFuseWindDown, runWallFuseMs } from "../../wall-fuse.ts";
import { clearBaselineCache } from "../../build-runner/baseline.ts";
import { phaseClauseFiles } from "../plan-feasibility.ts";
// v0.3.30 Layer C: agent-proposed runner discovery (machine-verified + cached).
import { readCachedTestRunner, writeCachedTestRunner, validateRunnerSpec, runnerCoversTargets, type TestRunnerSpec } from "../../build-runner/runner-discovery.ts";
import { deriveConventionsRunnerSpec } from "../../build-runner/conventions.ts";
import { runCoverageGate, type CoverageGateResult, coverageThreshold } from "../../build-runner/coverage-gate.ts";
// Wave 3 (058 §4 D-B/D-D, v0.3.99): Layer-2 protection intervals + Layer-4 checkpoint rollback.
import { buildProtectionEducationBlock, bumpProtectionStrike, detectProtectionViolations, deriveProtectionInterval, PROTECTION_STRIKE_BOUND, resetProtectionStrike, reviveProtectionInterval, serializeProtectionInterval, type ProtectionInterval } from "../protection-interval.ts";
import { consumeProtectionBreachEscalation } from "../../review/protection-breach-consumer.ts";
import { captureStageEntryBaseline, laterPhasesRan, reapplyRollbackStash, rollbackConvergenceReentry } from "../checkpoint-rollback.ts";
import { stateFileFor } from "../../state/state-root.ts";

export type LeakPhase = {
	name?: string;
	deliverables?: {
		requireFiles?: string[];
		requireContains?: Array<{ file: string }>;
		requireNotContains?: Array<{ file: string }>;
		requireTests?: string[];
	};
};

export const leakNorm = (p: string): string => p.trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");

function phaseDeliverableFiles(phase: LeakPhase | undefined): string[] {
	const d = phase?.deliverables;
	if (!d) return [];
	return [
		...(d.requireFiles ?? []),
		...(d.requireContains ?? []).map((x) => x.file),
		...(d.requireNotContains ?? []).map((x) => x.file),
		...(d.requireTests ?? []),
	].map(leakNorm);
}

/** v0.3.80 B2 — stage-close re-verification (commit fusion): a phase can end
 *  PARTIAL with its work already landed in the tree (gate-window expiry, work
 *  absorbed by a later phase's commit, or the stash-kill-switch leaving it
 *  dirty). Before the stage reports allGreen=false, re-verify each PARTIAL
 *  phase's deliverable contract LIVE. Dual-review hardening (v0.3.80):
 *  (a) at least one AFFIRMATIVE clause (requireFiles/requireContains/
 *  requireScenarios/requireTests) is required — notContains-only contracts
 *  are vacuously satisfiable by a missing file and never flip;
 *  (b) at least one of the phase's clause files must be in `changedThisRun`
 *  (vs the run baseline, committed or dirty) so PRE-EXISTING content cannot
 *  flip a phase the run never touched (the §F no-op doctrine);
 *  (c) requireTests-bearing contracts are verified at EXISTENCE grade inside
 *  deliverablesAlreadyMet (F-04, v0.3.86) and additionally gated by the
 *  caller's full runDeliverableCheck (the execution authority).
 *  Empty/absent contracts stay fail-closed partial. Pure: no gates, no
 *  mutation — the caller decides. */
export function reverifyPartialPhases(
	phases: Array<Record<string, unknown>>,
	phaseStatus: Array<{ id: string; status: string }>,
	worktreePath: string,
	defaultBranch: string,
	exclude: ReadonlySet<string> = new Set(),
	changedThisRun: ReadonlySet<string> = new Set(),
): { flippable: Array<{ id: string; index: number }>; skippedVacuous: string[] } {
	const flippable: Array<{ id: string; index: number }> = [];
	const skippedVacuous: string[] = [];
	const partialById = new Map(phaseStatus.filter((p) => p.status === "partial").map((p) => [p.id, p]));
	if (partialById.size === 0) return { flippable, skippedVacuous };
	phases.forEach((phase, index) => {
		const id = `phase-${String(index + 1).padStart(2, "0")}`;
		if (!partialById.has(id)) return;
		if (exclude.has(id)) return; // environment-blocked phases resolve through the judge — close-reverify must not bypass that route
		const deliverables = (phase as { deliverables?: DeliverableContract }).deliverables;
		if (!deliverables) return; // fail-closed: no contract, no re-verification
		const d = deliverables as { requireFiles?: unknown[]; requireContains?: unknown[]; requireScenarios?: unknown[]; requireTests?: unknown[] };
		// F-04 (v0.3.86): requireTests counts as AFFIRMATIVE — pre-fix a phase whose
		// sole deliverable was test execution was skipped as "(no affirmative
		// clause)" and could never flip at stage close.
		const affirmative = (d.requireFiles?.length ?? 0) + (d.requireContains?.length ?? 0) + (d.requireScenarios?.length ?? 0) + (d.requireTests?.length ?? 0);
		if (affirmative === 0) {
			skippedVacuous.push(`${id} (no affirmative clause)`);
			return; // notContains-only: vacuously satisfiable — never flip
		}
		const clauseSet = new Set(phaseClauseFiles(phase as never).map(leakNorm));
		const touchedThisRun = changedThisRun.size === 0 ? true : [...clauseSet].some((f) => changedThisRun.has(f));
		if (!touchedThisRun) {
			skippedVacuous.push(`${id} (satisfied by pre-existing content — no clause file changed this run)`);
			return;
		}
		try {
			if (deliverablesAlreadyMet(worktreePath, deliverables, defaultBranch)) flippable.push({ id, index });
		} catch {
			// fail-closed on any evaluation error
		}
	});
	return { flippable, skippedVacuous };
}

/** Cross-phase deliverable leakage (run 2026-08-27T12-33-43-088Z): phase-2's
 *  implementer changed root index.html — phase-3's DECLARED deliverable — out
 *  of scope, so phase-3 could never author an honest RED (its deliverable
 *  already existed; the honest revert was itself flagged "RED pollution").
 *  Returns the changed files that intersect any LATER phase's declared
 *  deliverables (path-drift tolerant), current phase excluded. Pure. */
export function laterPhaseDeliverableHits(changedFiles: string[], phases: LeakPhase[], currentIndex: number): string[] {
	const later = new Set<string>();
	for (let j = currentIndex + 1; j < phases.length; j++) {
		for (const f of phaseDeliverableFiles(phases[j])) later.add(f);
	}
	return changedFiles.filter((p) => later.has(leakNorm(p)));
}

/** Owner names of the later phases whose declared deliverables `changedFiles`
 *  leak into — for the BLOCKING log line at the advisory site. Pure. */
export function laterPhaseDeliverableOwners(changedFiles: string[], phases: LeakPhase[], currentIndex: number): string[] {
	const owners: string[] = [];
	for (let j = currentIndex + 1; j < phases.length; j++) {
		const files = new Set(phaseDeliverableFiles(phases[j]));
		if (changedFiles.some((p) => files.has(leakNorm(p)))) owners.push(phases[j]?.name ?? `phase-${j + 1}`);
	}
	return owners;
}

/** v0.3.0: after this many §D re-entries a phase whose partial keeps the SAME
 * failure signature is skipped for the rest of the run (its stash-preserved
 * best attempt stands; later phases keep getting convergence iterations). */
export const MAX_PARTIAL_REENTRIES = 2;

/** Hard cap on implementer-driven (challenge) RED re-authors per phase. When the
 *  implementer PROVES a confirmed RED test is unsatisfiable (internal
 *  contradiction, or compile errors in the test it cannot fix because tests are
 *  READ-ONLY), the stage drops acceptedRed and re-runs tdd-guide WITH the
 *  implementer's diagnosis — instead of blind re-authoring (which reproduces
 *  the same contradiction). Bounded so a flailing implementer cannot loop
 *  forever; after the cap the existing no-progress/HITL path takes over.
 *  Env-overridable for tuning. */
export const MAX_CHALLENGE_REAUTHORS = (() => {
	const raw = Number.parseInt(superDevEnv("SUPER_DEV_MAX_CHALLENGE_REAUTHORS") ?? "", 10);
	return Number.isFinite(raw) && raw > 0 ? raw : 2;
})();

/** v0.3.85 F3 (C5 fix, §10 decision 4): implementer attempts per phase PER §D
 *  ENTRY — the phase's attempt-loop hard cap. RED-generation tries INSIDE an
 *  attempt keep their own MAX_RED_RETRIES bound and are NOT counted; the ≥2
 *  same-signature partialReEntries windup bound is untouched. Cap exhaustion
 *  ends the phase partial with the NAMED reason `phase-attempt-cap`, which
 *  feeds the F2 boundary logic like any partial. Lazy env read (defensive
 *  rule #5 — the maxReplanRounds pattern in replan/replan.ts). */
export const maxPhaseAttempts = (): number => {
	const n = Number.parseInt(superDevEnv("SUPER_DEV_MAX_PHASE_ATTEMPTS") ?? "", 10);
	return Number.isFinite(n) && n > 0 ? n : 4;
};

/** v0.3.85 F3 (decision 2): per-phase WALL budget — anchored at phase start
 *  inside the stage run, so it resets on each §D re-entry by construction.
 *  Checked before each new implementer attempt within the phase. Lazy env
 *  read. */
export const phaseWallBudgetMs = (): number => {
	const n = Number.parseInt(superDevEnv("SUPER_DEV_MAX_PHASE_WALL_MS") ?? "", 10);
	return Number.isFinite(n) && n > 0 ? n : 5_400_000;
};

/** v0.3.85 F3 (decision 4): failure-category recurrence valve — the SAME
 *  FaultClass across ≥ this many CONSECUTIVE recorded attempts within the
 *  phase trips the existing no-progress valve even when every footprint is
 *  fresh (C5: run 09-09 ground 5-11 attempts per phase because the exact
 *  (failure, footprint) repeat never matched). GREEN side only — RED-side
 *  terminalRedTries keeps its own bound. The counter resets on §D re-entry
 *  and on a non-matching FaultClass. Lazy env read. */
export const faultRecurrenceLimit = (): number => {
	const n = Number.parseInt(superDevEnv("SUPER_DEV_FAULT_RECURRENCE") ?? "", 10);
	return Number.isFinite(n) && n > 0 ? n : 3;
};

// F3 bound interplay (§9): the phase wall (90min) typically fires BEFORE the
// attempt cap (4 × 30min code-tier attempt timeout = 120min) — intended, the
// fuse dominates; the bounds stay independent.

/** A concrete implementer report that a confirmed RED test is unsatisfiable.
 *  `reason` carries the impossibility proof (e.g. "line 338 asserts
 *  typeof==='object'; line 346 calls it — no value is both"). Defensive parse of
 *  untrusted agent control; never throws. */
export interface TestDefect {
	testFile: string;
	lines?: string;
	reason: string;
}

/** Parse the implementer's optional `testDefects` control field. Accepts only
 *  objects with a non-empty testFile AND reason (a defect without a proof is
 *  not actionable and is dropped, so the channel cannot be used as a vague
 *  escape hatch). Bounded to 6 entries. Never throws. */
/** Fix 4 — parse the RED reviewer's joint-satisfiability findings from its
 *  control object. Bounded (4 entries) and defensive: malformed entries are
 *  skipped, never thrown. Mirrors parseTestDefects' tolerance. */
export function parseRedContradictions(control: unknown): Array<{ tests: string; lines?: string; proof: string }> {
	if (control == null || typeof control !== "object" || Array.isArray(control)) return [];
	const raw = (control as Record<string, unknown>).contradictions;
	if (!Array.isArray(raw)) return [];
	const out: Array<{ tests: string; lines?: string; proof: string }> = [];
	for (const entry of raw) {
		if (entry == null || typeof entry !== "object" || Array.isArray(entry)) continue;
		const e = entry as Record<string, unknown>;
		const tests = typeof e.tests === "string" ? e.tests.trim() : "";
		const proof = typeof e.proof === "string" ? e.proof.trim() : "";
		if (!tests || !proof) continue;
		const lines = typeof e.lines === "number" && Number.isFinite(e.lines)
			? String(Math.trunc(e.lines))
			: typeof e.lines === "string" && e.lines.trim() ? e.lines.trim() : undefined;
		out.push({ tests, proof, ...(lines ? { lines } : {}) });
	}
	return out.slice(0, 4);
}

/** The implementer's structured-output contract, declared at the call site
 *  (Fix 1a) so the challenge channel cannot be broken by prompt-text drift.
 *  Must stay in sync with buildImplementPrompt's control line (enforced by
 *  tests/prompt-control-contracts.test.ts). */
// testDefects stays REQUIRED here: the current prompt line says "ALWAYS emit
// this key; use [] when none" and the call site passes allowEmptyArraysFor —
// required-with-empty-ok. (The v0.1.52 HISTORICAL line wording "(optional…)"
// now parses as optional under v0.3.47, but that line is only a parser
// fixture; the live contract is this one.)
// v0.3.87 S4(b) (decision 9): needsResearch rides the SAME required-with-
// empty-ok contract (ALWAYS emit; [] = no research question). Semantically
// OPTIONAL — the field NEVER dispatches by itself; parseNeedsResearch archives
// the entries and they only ENRICH an engine-gate-triggered assist dispatch.
export const IMPLEMENTER_CONTROL_KEYS = ["filesCreated", "filesModified", "filesDeleted", "testsPassCount", "summary", "testDefects", "needsResearch"];

/** Fix 5 — cheap text-proof heuristic markers. ADVISORY ONLY: text alone never
 *  auto-triggers a re-author (`.text` is always present; the no-progress guard
 *  exists precisely because of that) — it only flags the escalation message. */
export const UNSATISFIABLE_TEXT_RE = /unsatisfiab|contradict|cannot be satisfied/i;

export function parseTestDefects(control: unknown): TestDefect[] {
	if (control == null || typeof control !== "object" || Array.isArray(control)) return [];
	const raw = (control as Record<string, unknown>).testDefects;
	if (!Array.isArray(raw)) return [];
	const out: TestDefect[] = [];
	for (const entry of raw) {
		if (entry == null || typeof entry !== "object" || Array.isArray(entry)) continue;
		const e = entry as Record<string, unknown>;
		const testFile = typeof e.testFile === "string" ? e.testFile.trim() : "";
		const reason = typeof e.reason === "string" ? e.reason.trim() : "";
		if (!testFile || !reason) continue;
		// Fix 1f: models frequently emit line numbers as NUMBERS — coerce instead
		// of silently dropping the field (which weakened the impossibility proof's
		// precision in escalation and re-author prompts).
		const lines = typeof e.lines === "number" && Number.isFinite(e.lines)
			? String(Math.trunc(e.lines))
			: typeof e.lines === "string" && e.lines.trim() ? e.lines.trim() : undefined;
		out.push({ testFile, reason, ...(lines ? { lines } : {}) });
	}
	return out.slice(0, 6);
}

/** Trim an implementer reasoning trace to its tail (the most recent diagnosis),
 *  bounded so a long agent transcript cannot bloat the RED re-author prompt. */
export function trimImplementerText(text: string | undefined, max = 1200): string {
	const t = (text ?? "").trim();
	if (!t) return "";
	return t.length <= max ? t : `…${t.slice(-max)}`;
}

/** Build the evidence suffix appended to the tdd-guide re-author prompt when
 *  re-authoring because the implementer proved the prior RED unsatisfiable.
 *  Prefers structured testDefects; falls back to a trimmed implementer
 *  reasoning tail so even a model that ignores the testDefects contract still
 *  surfaces its diagnosis instead of re-authoring blind. */
export function formatReauthorEvidence(defects: TestDefect[], implTextTail: string): string {
	const parts: string[] = [];
	if (defects.length) {
		parts.push("## PRIOR RED TEST WAS UNSATISFIABLE — re-author a satisfiable test");
		parts.push("The implementer PROVED the previously-accepted RED test cannot be satisfied by ANY conforming implementation. Do NOT reproduce the same contradiction. Fix the named defects and author a test that is internally consistent AND that at least one conforming implementation could pass:");
		for (const d of defects) parts.push(`- ${d.testFile}${d.lines ? ` (${d.lines})` : ""}: ${d.reason}`);
	}
	if (implTextTail.trim()) {
		parts.push("");
		parts.push("Implementer's latest diagnosis (for context):");
		parts.push(implTextTail.trim());
	}
	return parts.length ? `\n\n${parts.join("\n")}` : "";
}

export function runtimeInstructionFingerprint(specDir: string | undefined): string {
	const notes = userNotesForAgent(specDir);
	let hash = 2166136261;
	for (let i = 0; i < notes.length; i++) {
		hash ^= notes.charCodeAt(i);
		hash = Math.imul(hash, 16777619);
	}
	return `${notes.length}:${(hash >>> 0).toString(16)}`;
}

/** Status-specific re-prompt hint appended to the tdd-guide prompt when the RED
 *  oracle reports a NON-red status (green/broken), nudging the agent toward a
 *  test that GENUINELY fails against the unimplemented behavior instead of
 *  resampling the same passing/broken shape (spec §B → SCENARIO-007). */
export function redRePromptHint(status: RedStatus): string {
	if (status === "green") {
		return `\n\n${implementationRetrySection("RED oracle rejected the previous test set", {
			gate: "red-oracle",
			location: "TDD RED test execution",
			observed: "tests PASSED already before implementation",
			expected: "a RED test set that GENUINELY fails against the unimplemented behavior",
			nextAction: "Rewrite the test so it fails for the right reason before the production code exists.",
		})}`;
	}
	if (status === "broken") {
		return `\n\n${implementationRetrySection("RED oracle rejected the previous test set", {
			gate: "red-oracle",
			location: "TDD RED test execution",
			observed: "tests did not compile/collect; the RED oracle saw a build/collection error",
			expected: "a test that compiles, RUNS, and then FAILS against the unimplemented behavior",
			nextAction: "Fix the test so it RUNS and then FAILS against the unimplemented behavior.",
		})}`;
	}
	return "";
}

/** Context line appended to the implementer prompt so the green-phase agent
 *  knows the verified RED status. The CONFIRMED-red marker appears ONLY on a
 *  verified `red`; unconfirmed green/broken no longer reaches the implementer,
 *  while `unknown` remains a non-stalling greenfield/no-runner fallback. */
export function redImplementContext(status: RedStatus): string {
	if (status === "red") {
		return "The TDD tests are CONFIRMED-red; your goal is to make them green.";
	}
	// unknown — red could not be determined at all (e.g. greenfield: no test runner).
	return "The TDD red status could not be confirmed (status: unknown) — proceeding; red was not verified.";
}

export function quoteCmdArg(arg: string): string {
	return /^[A-Za-z0-9_./:@%+=,-]+$/.test(arg) ? arg : JSON.stringify(arg);
}

export function redCheckOptions(ctx: StageContext, phaseId: string, diagnostics?: RedCheckDiagnostic[], defaultBranch?: string, runner?: TestRunnerSpec) {
	return {
		signal: ctx.signal,
		defaultBranch, // sweep-3 G6 (AR1-3): the run's real base ref for cargo -p scoping
		...(runner ? { runner } : {}), // v0.3.30 C: cached/validated agent-proposed runner
		onPlan(plans: RedCheckPlan[]) {
			for (const plan of plans) {
				ctx.log(`Implementation ${phaseId} RED test plan: cwd=${plan.cwd} cmd=${plan.argv.map(quoteCmdArg).join(" ")}`);
			}
		},
		onResult(diagnostic: RedCheckDiagnostic) {
			diagnostics?.push(diagnostic);
			ctx.log(`Implementation ${phaseId} RED runner diagnostic: ${formatRedDiagnosticSummary(diagnostic)}`);
		},
	};
}

/**
 * Extract referenced crate names from error blocks for the IN-SCOPE GREEN log
 * (AC-05 → SCENARIO-012/025). Reuses the same two markers as the build-gate's
 * `classifyOutOfScopeErrors`: (a) `crates/<pkg>/` path markers and (b) cargo
 * `-p <pkg>` markers. De-duplicates while preserving first-seen order.
 */
export function cratesFromErrors(errors: string[]): string[] {
	const crates: string[] = [];
	const pathRe = /crates\/([^/]+)\//g;
	const pkgRe = /(?:^|\s)-p\s+(\S+)/g;
	for (const block of errors) {
		let m: RegExpExecArray | null;
		pathRe.lastIndex = 0;
		while ((m = pathRe.exec(block))) crates.push(m[1]);
		pkgRe.lastIndex = 0;
		while ((m = pkgRe.exec(block))) crates.push(m[1]);
	}
	return Array.from(new Set(crates));
}

/** Parse the implementer/fixer's claimed change set (spec-11 AC-06 →
 *  SCENARIO-011/012). Accepts the STRUCTURED `{filesCreated, filesModified,
 *  filesDeleted}` shape AND back-tolerates the legacy flat `filesModified`
 *  array by reading it into `filesModified` (created/deleted empty).
 *
 *  NEVER throws (the implementer control is untrusted agent output):
 *   - null/undefined/non-object/array control → empty StructuredChanges.
 *   - a bucket whose value is not an array collapses that bucket to empty.
 *   - non-string entries within a bucket array are dropped (defensive).
 *  The gate reads `claimedNotChanged` off `(claimed.created ∪ claimed.modified)`
 *  so a legacy flat `filesModified` is cross-checked exactly like a structured
 *  modified set (no migration gap). */
export function parseStructuredChanges(control: unknown): StructuredChanges {
	const empty: StructuredChanges = { filesCreated: [], filesModified: [], filesDeleted: [] };
	if (control == null || typeof control !== "object" || Array.isArray(control)) {
		return empty;
	}
	const obj = control as Record<string, unknown>;
	const pickStrings = (key: string): string[] => {
		const v = obj[key];
		return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
	};
	return {
		filesCreated: pickStrings("filesCreated"),
		filesModified: pickStrings("filesModified"),
		filesDeleted: pickStrings("filesDeleted"),
	};
}

/** Decode one string element that may itself be a JSON-encoded array (LLM
 *  shape-drift: an array-typed control field sometimes arrives as the STRING
 *  `'["src/x.test.ts"]'`, or even nested). Wrapping such a blob whole yields a
 *  single malformed filename that the test runner's substring filter matches to
 *  nothing (`No test files found` forever). Recursively decodes JSON-array
 *  strings; falls back to a bare-string wrap when the payload is not valid
 *  JSON. Pure + never throws. */
function normalizeStringElement(s: string): string[] {
	const trimmed = s.trim();
	if (!trimmed) return [];
	if (trimmed[0] === "[") {
		try {
			const parsed: unknown = JSON.parse(trimmed);
			if (Array.isArray(parsed)) {
				return parsed.flatMap((x) => (typeof x === "string" ? normalizeStringElement(x) : []));
			}
		} catch {
			/* not valid JSON → fall through to bare-string wrap */
		}
	}
	return [trimmed];
}

/** Normalize an agent-returned array field into a genuine `string[]`.
 *  Agents unreliably return array-typed control fields as a bare string, a
 *  JSON-encoded string/array, an object, a number, or null/undefined (the same
 *  shape-drift that `normalizePhases` defends against for `spec.phases`). A bare
 *  `?? []` only catches null/undefined — a string or JSON blob sails through
 *  and later `.join()` / spread / iteration crashes, or a malformed filename is
 *  passed to the test runner. This helper coerces defensively: array →
 *  string-filtered and element-decoded; string → decoded if a JSON array else
 *  wrapped; else []. */
export function normalizeStringArray(v: unknown): string[] {
	if (Array.isArray(v)) {
		return v.flatMap((item) => (typeof item === "string" ? normalizeStringElement(item) : []));
	}
	if (typeof v === "string") {
		return normalizeStringElement(v);
	}
	return [];
}

// §D auto-iterate convergence loop — per-phase green state + failure reasons
// carried across outer iterations (the loop in stages/index.ts re-runs this
// stage until allGreen or no-progress blocking). Without these, a re-run would
// re-attempt GREEN phases (state-confusion churn); with them, green phases are
// skipped and a failed phase's prior-iteration reasons are seeded into its next
// attempt 1.
