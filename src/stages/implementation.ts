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
import { harnessBasenames } from "../harness-paths.ts";
import { superDevEnv } from "../render/super-dev-dir.ts";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync , rmSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { BoundaryQuarantinePayload, ControlObj, PipelineState, Stage, StageContext } from "../types.ts";

// v0.3.73 M1: re-exported for the salvage seam + tests.
export type { BoundaryQuarantinePayload } from "../types.ts";
import { classifyJudgeRoute } from "../routing/router.ts";
import { appendGateChecked } from "../runlog.ts";
import { getActiveTracker, isHarnessBookkeepingPath, isInternalRuntimeClaim } from "../tracking.ts";
import type { ChangeRecord, StructuredChanges } from "../tracking.ts";
import { localTimestamp } from "../render/time.ts";
import { buildRedBoundaryPrompt, classifyObviousRedPath, isRuntimeEvidencePath, isSubstrateArtifact, redBoundaryResultFromAgent, redBoundaryResultFromClassifications, approveScaffoldPaths, type RedBoundaryResult } from "../test-artifacts.ts";
import { buildTddPrompt, buildImplementPrompt, buildCommitPrompt, buildImplementationSummaryPrompt, buildRedReviewPrompt, rustDiscipline } from "../prompts.ts";
import { firstCitedTestFile, runJudge, type JudgeRoute } from "./judge.ts";
import { triggerReplanForFindings, replanPending, countInheritedRedRows, pendingInheritedRedRows } from "../replan/replan.ts";
// v0.3.85 F2 Tier 3 / F4 sub-cap + the validator hard-fail override: the
// stop-the-line terminal (ADR 9) and the restart-state pending-row probe.
import { FatalAbort } from "../nodes.ts";
import { INHERITED_RED_SOURCE, appendInheritedRedEvent, countInheritedRedOccurrences, extractFailingTestFilePaths, f4ScopeMatch, inheritedRedAttribution, inheritedRedBoundaryShape, inheritedRedFlakeTally, normalizeRepoPath } from "./inherited-red.ts";
import { planFeasibilityFindings, contradictionFastFailFrame } from "./plan-feasibility.ts";
import { isNoEditCompletion } from "../agent-errors.ts";
import { renderAndWrite } from "../render/render.ts";
import { STAGE_MODELS, RedReviewData as RED_REVIEW_SCHEMA, TddCoverageControlData, FileClassifyControlData } from "../render/schemas.ts";
import { userNotesForAgent } from "../render/user-notes.ts";
import { extractScenarioIds, extractScenarioRefsFromControl, normalizePhases } from "../doc-validators.ts";
import { computeChangeGate, computeSymbolGate, deliverablesAlreadyMet, resetDeliverableCheckCache, runBuildGate, buildGateCorrelationLine, runDeliverableCheck, runRedCheck, type BuildGateResult, type DeliverableContract, type GateOptions, type RedCheckDiagnostic, type RedCheckPlan, type RedStatus } from "../build-runner.ts";
import { renderRetryFeedbackBlock, type RetryFeedback } from "../retry-feedback.ts";
import { runInStepScope } from "../step-scope.ts";
import { recordConvergenceFindings, type ConvergenceOwnerStage } from "../convergence-ledger.ts";
import { stripVolatileNoise, classifyGateFault, collectDirtPaths, listPorcelainPaths, quarantineDirt, dirtyQuarantineEnabled, appendEnvironmentFault, readEnvironmentFaultCount, type FaultClass } from "../fault-classification.ts";
import { freshRunWallFuseState, markRunWallFuseTripped, runFuseWindDown, runWallFuseMs } from "../wall-fuse.ts";
import { clearBaselineCache } from "../build-runner/baseline.ts";
import { phaseClauseFiles } from "./plan-feasibility.ts";
// v0.3.30 Layer C: agent-proposed runner discovery (machine-verified + cached).
import { readCachedTestRunner, writeCachedTestRunner, validateRunnerSpec, runnerCoversTargets, type TestRunnerSpec } from "../build-runner/runner-discovery.ts";
import { deriveConventionsRunnerSpec } from "../build-runner/conventions.ts";
import { runCoverageGate, type CoverageGateResult, coverageThreshold } from "../build-runner/coverage-gate.ts";

type RedEvidenceStatus = "red-behavior-failure" | "coverage-incomplete" | "green-weak-test" | "review-weak" | "green-already-satisfied" | "broken-test" | "unknown-no-runner" | "unknown-unclassified" | "polluted-red" | "weakened-preexisting-test";

export interface RedEvidence {
	phaseId: string;
	attempt: number;
	status: RedEvidenceStatus;
	oracleStatus: RedStatus;
	testFiles: string[];
	changedFiles: string[];
	forbiddenFiles: string[];
	expectedScenarios?: string[];
	coveredScenarios?: string[];
	missingScenarios?: string[];
	boundary?: RedBoundaryResult;
	diagnostics?: RedCheckDiagnostic[];
	redRetries: number;
	reason?: string;
	/** v0.3.85 F5: the DECREASED (weakened) pre-existing test files with their
	 *  before→after assertion-surface counts — present only on
	 *  weakened-preexisting-test evidence (rejection detail, hint + finding
	 *  inputs). */
	weakenedFiles?: Array<{ path: string; before: number; after: number }>;
	/** v0.3.85 F5: ALL pre-existing test files this RED try edited (weakened
	 *  or not) — the SCOPED revert set. Newly authored test files are absent
	 *  by construction (not tracked at HEAD) and SURVIVE the revert. */
	preexistingTestFiles?: string[];
}

interface TddCoverageResult {
	allCovered: boolean;
	expectedScenarios: string[];
	coveredScenarios: string[];
	missingScenarios: string[];
	summary: string;
}

interface AcceptedRedContext {
	status: RedStatus;
	testFiles: string[];
	changedFiles: string[];
}

interface ProgressSignature {
	failure: string;
	footprint: string;
}

function normalizeSignatureText(value: string): string {
	// Phase 2 (Track 30, T2.1 · AC-06/AC-08 → SCENARIO-014/015): strip volatile
	// noise (ISO-8601 timestamps, UUIDs, durations, `(cached)`/`[cached]` markers)
	// BEFORE the pre-existing whitespace-collapse/trim/800-cap (strip → collapse
	// → trim → cap, in that order) so >800 chars of leading noise can never
	// displace discriminating content past the cap, and identical failures that
	// differ only in noise hash to ONE signature (SCENARIO-016). `repeatedNoProgress`
	// itself is untouched — fixing the normalizer's input fixes the detector.
	return stripVolatileNoise(value).replace(/\s+/g, " ").trim().slice(0, 800);
}

function stableUnique(values: string[]): string[] {
	return [...new Set(values.map(normalizeSignatureText).filter(Boolean))].sort();
}

function failureSignature(reasons: string[]): string {
	const normalized = stableUnique(reasons);
	return normalized.length ? normalized.join("\n") : "phase gates unmet";
}

function structuredFootprint(changes: StructuredChanges): Record<string, string[]> {
	return {
		filesCreated: stableUnique(changes.filesCreated),
		filesModified: stableUnique(changes.filesModified),
		filesDeleted: stableUnique(changes.filesDeleted),
	};
}

function changeFootprint(record: ChangeRecord | null, changes: StructuredChanges): string {
	const gitActual = record?.gitActual;
	if (gitActual) {
		return JSON.stringify({
			created: stableUnique(gitActual.created ?? []),
			modified: stableUnique(gitActual.modified ?? []),
			deleted: stableUnique(gitActual.deleted ?? []),
		});
	}
	return JSON.stringify(structuredFootprint(changes));
}

function repeatedNoProgress(history: ProgressSignature[], next: ProgressSignature): boolean {
	// H3 (spec-28, AC-03 → SCENARIO-006/007): ANY earlier matching entry is
	// non-progress — A→B→A→B oscillation slipped the old consecutive-only
	// (`history[last]`) check forever because every attempt differed from the
	// immediately-preceding one. Mirrors the RED loop's
	// `redProgressHistory.includes(signature)` (RC-3). Empty history ⇒ false —
	// the first attempt is never no-progress, and strictly fresh signatures
	// (A,B,C,D,…) never trip (escalation paths untouched).
	return history.some((h) => h.failure === next.failure && h.footprint === next.footprint);
}

/** v0.3.85 F3 (decision 4): failure-category recurrence — advance the
 * consecutive-same-FaultClass streak. Module-scope PURE helper deliberately:
 * the attempt loop's control flow (initial reading + re-classification
 * assignments inside the environmental-blocker branch) CFA-narrows a `let`
 * FaultClass to `never` at the streak-update site; function parameters carry
 * their declared types, immune to that narrowing history. Same shape as
 * `repeatedNoProgress` above. */
function nextFaultStreak(
	prev: { faultClass: FaultClass; count: number } | null,
	cls: FaultClass,
): { faultClass: FaultClass; count: number } {
	return prev !== null && prev.faultClass === cls
		? { faultClass: cls, count: prev.count + 1 }
		: { faultClass: cls, count: 1 };
}

/** v0.3.24 S4-2: harness runtime-evidence and spec-dir bookkeeping paths are
 *  EXCLUDED from the RED evidence signature — implementation-evidence.jsonl is
 *  appended after EVERY try (inside the worktree's spec dir), so its presence in
 *  raw changedFiles made every signature unique and the repeated-signature
 *  escape never fired (run 12-51-40: the judge / allow-scaffold path was
 *  unreachable until the 6-try ceiling). Exported for tests. */
export function signatureStableChangedFiles(changedFiles: string[]): string[] {
	return changedFiles.filter((p) => !isRuntimeEvidencePath(p) && !normalizeSlash(p).startsWith("docs/specifications/"));
}

function normalizeSlash(path: string): string {
	return String(path ?? "").replace(/\\/g, "/").replace(/^\.\//, "");
}

export function redEvidenceSignature(e: RedEvidence): string {
	return JSON.stringify({
		status: e.status,
		oracleStatus: e.oracleStatus,
		testFiles: stableUnique(e.testFiles),
		changedFiles: stableUnique(signatureStableChangedFiles(e.changedFiles)),
		forbiddenFiles: stableUnique(e.forbiddenFiles),
		missingScenarios: stableUnique(e.missingScenarios ?? []),
		coveredScenarios: stableUnique(e.coveredScenarios ?? []),
		reason: normalizeSignatureText(e.reason ?? ""),
		diagnostics: stableUnique((e.diagnostics ?? []).map((d) => `${d.status}:${d.exitCode ?? "null"}:${d.signal ?? "none"}:${normalizeSignatureText(d.outputTail ?? "")}`)),
	});
}

/** v0.3.45: machine-independent porcelain reading. `--porcelain -z` output
 * is NUL-terminated and NEVER C-quotes paths — the v1 line format quotes
 * paths containing spaces on EVERY machine (and non-ASCII whenever
 * `core.quotepath=true`, the git default), so RAW v1 parsing fed quoted
 * phantom paths ("\"space dir/x\"", octal-escaped 中文) into gate sets,
 * discard/commit pathspecs. Rename records in -z carry the OLD path as the
 * NEXT NUL field (`XY new\0old`); the reader consumes it so callers see flat
 * entries (both sides included — a rename dirties both the deleted and the
 * added path from the gates' perspective). Exported for tests. */
export interface PorcelainEntry {
	status: string;
	path: string;
	/** For R/C records: the pre-rename path (second -z field). */
	fromPath?: string;
}

export function porcelainEntries(cwd: string): PorcelainEntry[] {
	const r = spawnSync("git", ["-C", cwd, "status", "--porcelain", "-z", "--untracked-files=all"], { encoding: "utf8", timeout: 15_000 });
	if (r.error || r.status !== 0 || !r.stdout) return [];
	const recs = String(r.stdout).split("\0");
	const entries: PorcelainEntry[] = [];
	for (let i = 0; i < recs.length; i++) {
		const rec = recs[i]!;
		if (!rec) continue;
		const status = rec.slice(0, 2);
		const path = rec.slice(3);
		if (!path) continue;
		if ((status[0] === "R" || status[0] === "C") && recs[i + 1]) {
			entries.push({ status, path, fromPath: recs[i + 1] });
			i++;
			continue;
		}
		entries.push({ status, path });
	}
	return entries;
}

/** v0.3.45: dirty-path set from the -z reader (see porcelainEntries). The
 * old v1-line reader TRIMMED each line first, so a tracked modification
 * (" M path") lost its leading space and the path mangled to "ath" —
 * space/quoted/renamed paths also leaked quoted. */
export function gitStatusPaths(cwd: string): Set<string> {
	const paths = new Set<string>();
	for (const e of porcelainEntries(cwd)) {
		paths.add(e.path);
		if (e.fromPath) paths.add(e.fromPath);
	}
	return paths;
}

function setDiff(after: Set<string>, before: Set<string>): string[] {
	return [...after].filter((p) => !before.has(p)).sort();
}

function listOrNone(values: string[]): string {
	return values.length ? values.join(", ") : "none";
}

function redEvidenceLogLine(e: RedEvidence): string {
	const boundary = e.boundary ? ` ambiguousFiles=${listOrNone(e.boundary.ambiguousFiles)}` : "";
	const coverage = e.missingScenarios?.length ? ` missingScenarios=${listOrNone(e.missingScenarios)}` : "";
	const diagnostics = e.diagnostics?.length ? ` diagnostics=${e.diagnostics.length}` : " diagnostics=none";
	return `Implementation ${e.phaseId} RED gate evidence: status=${e.status} oracle=${e.oracleStatus} retries=${e.redRetries} testFiles=${listOrNone(e.testFiles)} changedFiles=${listOrNone(e.changedFiles)} forbiddenFiles=${listOrNone(e.forbiddenFiles)}${boundary}${coverage}${diagnostics}`;
}

function uniqueScenarioIds(ids: string[]): string[] {
	return [...new Set(ids)].sort((a, b) => Number(a.split("-")[1] ?? "0") - Number(b.split("-")[1] ?? "0"));
}

function scenarioIdsFromUnknown(value: unknown): string[] {
	if (value == null) return [];
	if (typeof value === "string") return extractScenarioIds(value);
	if (typeof value === "number" && Number.isInteger(value)) return [`SCENARIO-${String(value).padStart(3, "0")}`];
	if (Array.isArray(value)) return uniqueScenarioIds(value.flatMap(scenarioIdsFromUnknown));
	if (typeof value === "object") return scenarioIdsFromUnknown(JSON.stringify(value));
	return [];
}

function phaseTaskDescriptions(specControl: ControlObj | null | undefined, phaseName: string): string[] {
	const tasks = Array.isArray(specControl?.tasks) ? specControl.tasks as Array<Record<string, unknown>> : [];
	return tasks
		.filter((task) => typeof task.phase === "string" && task.phase.trim() === phaseName)
		.map((task) => String(task.description ?? "").trim())
		.filter(Boolean);
}

function expectedScenariosForPhase(phase: unknown, specControl: ControlObj | null | undefined, bddControl: ControlObj | null | undefined): string[] {
	const p = (phase && typeof phase === "object") ? phase as Record<string, unknown> : {};
	const phaseName = String(p.name ?? "");
	// AC-06 (spec-28, SCENARIO-013/014): task-level `scenarioRefs` for the
	// phase's own tasks are a first-class explicit source, merged BEFORE the
	// fallbacks — a multi-phase spec mapped only via `tasks[].scenarioRefs`
	// gives each phase its TASK SUBSET, never the full spec set (which would
	// demand every phase test every scenario). Mirrors `phaseScenarioRefsFor`
	// in prompts.ts. The full spec.scenarioRefs fallback fires ONLY when both
	// the phase-level AND task-level refs are empty (ordering unchanged).
	const taskScenarioRefs = (Array.isArray(specControl?.tasks) ? specControl.tasks as Array<Record<string, unknown>> : [])
		.filter((task) => typeof task.phase === "string" && task.phase.trim() === phaseName)
		.flatMap((task) => scenarioIdsFromUnknown(task.scenarioRefs));
	const explicit = uniqueScenarioIds([
		...scenarioIdsFromUnknown(p.scenarioRefs),
		...scenarioIdsFromUnknown(p.scenarios),
		...scenarioIdsFromUnknown(p.name),
		...scenarioIdsFromUnknown(p.description),
		...scenarioIdsFromUnknown(phaseTaskDescriptions(specControl, phaseName)),
		...taskScenarioRefs,
	]);
	if (explicit.length) return explicit;
	const specRefs = extractScenarioRefsFromControl(specControl ?? undefined);
	if (specRefs.length) return specRefs;
	return scenarioIdsFromUnknown(bddControl?.features);
}

function tddCoverageRetryHint(result: TddCoverageResult): string {
	const feedback: RetryFeedback = {
		stage: "implementation",
		gate: "red-scenario-coverage",
		location: "TDD RED test set",
		observed: `covered=${result.coveredScenarios.join(", ") || "none"}; verifier=${result.summary || "coverage incomplete"}`,
		expected: `coverage for every expected BDD scenario: ${result.expectedScenarios.join(", ") || "unknown"}`,
		missing: result.missingScenarios,
		nextAction: "Add or revise RED tests so every missing SCENARIO-NNN has a behavior-level test. Keep the tests compiling/collecting; it is fine if they fail because the implementation behavior is still missing.",
	};
	return `\n\n${renderRetryFeedbackBlock([feedback], "RED coverage verifier rejected the previous test set")}`;
}

function implementationRetrySection(heading: string, feedback: Omit<RetryFeedback, "stage">): string {
	return renderRetryFeedbackBlock([{ stage: "implementation", ...feedback }], heading);
}

function toStringArr(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

/** Out-of-scope edits: changed tracked+untracked files OUTSIDE the phase's
 *  declared clause scope (canonical phaseClauseFiles grammar, v0.3.80 B1) and
 *  outside the RED test files. Advisory input for the leak classifier. */
function trackerOutofScopeEdits(tracker: ReturnType<typeof getActiveTracker>, worktreePath: string, declaredScope: Set<string>, redTestFiles: string[]): string[] {
	if (!tracker) return [];
	try {
		const r = spawnSync("git", ["-c", "core.quotepath=false", "-C", worktreePath, "status", "--porcelain", "--untracked-files=all"], { encoding: "utf8", timeout: 15_000 });
		if (r.error || typeof r.status !== "number" || r.status !== 0) return [];
		// C-quoted paths (non-ASCII/quote chars): strip quotes and unescape
		// backslash-backslash / backslash-quote (best-effort), then normalize.
		const normalize = (p: string) => {
			const t = p.trim();
			if (t.startsWith('"') && t.endsWith('"')) {
				return t.slice(1, -1).replace(/\\\\/g, "\\").replace(/\\"/g, '"').replace(/\\/g, "/");
			}
			return t.replace(/\\/g, "/").replace(/^\.\//, "");
		};
		const excluded = new Set([...declaredScope, ...redTestFiles]);
		const out: string[] = [];
		for (const line of String(r.stdout ?? "").split("\n")) {
			if (!line.trim()) continue;
			const code = line.slice(0, 2);
			// Rename entries (R) carry "old -> new" — the NEW path is the live one.
			const body = line.slice(3);
			const raw = code.includes("R") && body.includes(" -> ") ? body.split(" -> ").pop()! : body;
			const path = normalize(raw);
			if (!path) continue;
			if (excluded.has(path) || excluded.has(path.replace(/\/+$/, ""))) continue;
			if (isInternalRuntimeClaim(path)) continue;
			if (path.startsWith("docs/specifications/")) continue;
			if (path.includes(".worktree/") || path === ".run-lock") continue;
			out.push(path);
		}
		return out;
	} catch {
		return [];
	}
}

/** v0.3.56 F4: restore BOTH index and worktree (source HEAD) — the old
 *  `git checkout -- <path>` left the INDEX untouched, so an agent-STAGED
 *  change survived RED cleanup (attributeQuarantinedViolations already used
 *  --staged --worktree; this closes the inconsistent restore class).
 *  Exported as the F9f seam: the ':(top)*' magic-name pin drives it directly. */
export function restorePaths(cwd: string, paths: string[]): void {
	for (const path of paths) {
		// v0.3.55 security review F2: `:(literal)` pathspec guard (magic like
		// `:(top)*` in an odd filename must not widen checkout/clean).
		const literal = `:(literal)${path}`;
		// v0.3.56 F4: restore BOTH index and worktree (source HEAD) — the old
		// `git checkout -- <path>` left the INDEX untouched, so an agent-STAGED
		// change survived RED cleanup (attributeQuarantinedViolations already used
		// --staged --worktree; this closes the inconsistent restore class).
		try { execFileSync("git", ["restore", "--staged", "--worktree", "--", literal], { cwd, stdio: "ignore" }); } catch { /* untracked or absent */ }
		try { execFileSync("git", ["clean", "-fd", "--", literal], { cwd, stdio: "ignore" }); } catch { /* best-effort */ }
	}
}

function restoreUnacceptedRedChanges(ctx: StageContext, cwd: string, phaseId: string, paths: string[]): void {
	// v0.3.24 S4-2 follow-up: harness bookkeeping (implementation-evidence.jsonl
	// above all — appended after EVERY try) must never be `git clean`d away by RED
	// cleanup: restorePaths runs checkout+clean per path, and cleaning the
	// harness's own audit trail destroyed it exactly when the new noise-free
	// signatures let oscillation detection fire the terminal path (previously
	// masked because signatures never repeated). Reverting a harness-owned file
	// is meaningless anyway — checkout no-ops on it, only the clean is harmful.
	const restorable = paths.filter((p) => !isInternalRuntimeClaim(p) && !isSubstrateArtifact(p) && !isHarnessBookkeepingPath(p));
	if (restorable.length === 0) return;
	restorePaths(cwd, restorable);
	ctx.log(`Implementation ${phaseId} RED cleanup: restored unaccepted RED change(s): ${restorable.join(", ")}`);
}

function appendImplementationEvidence(specDir: string | undefined, evidence: RedEvidence): void {
	if (!specDir) return;
	try {
		mkdirSync(specDir, { recursive: true });
		appendFileSync(join(specDir, "implementation-evidence.jsonl"), JSON.stringify({ ts: localTimestamp(), ...evidence }) + "\n");
	} catch { /* evidence is best-effort */ }
}

/** classifyRedEvidence's oracle-green reason literal (reviewer F-8: keep the
 *  two coupled sites reading ONE constant instead of duplicated strings). */
const CANONICAL_GREEN_WEAK_REASON = "RED tests passed before implementation";

export function classifyRedEvidence(args: { phaseId: string; attempt: number; redStatus: RedStatus; testFiles: string[]; changedFiles: string[]; boundary: RedBoundaryResult; redRetries: number; alreadySatisfied: boolean; diagnostics?: RedCheckDiagnostic[] }): RedEvidence {
	const { phaseId, attempt, redStatus, testFiles, changedFiles, boundary, redRetries, alreadySatisfied } = args;
	const forbiddenFiles = boundary.forbiddenFiles;
	const diagnostics = args.diagnostics?.map((d) => ({ ...d, plan: { cwd: d.plan.cwd, argv: [...d.plan.argv] } }));
	const base = { phaseId, attempt, oracleStatus: redStatus, testFiles, changedFiles, forbiddenFiles, boundary, redRetries, ...(diagnostics?.length ? { diagnostics } : {}) };
	if (forbiddenFiles.length) return { ...base, status: "polluted-red", reason: "RED phase modified files outside the test boundary" };
	if (redStatus === "red") return { ...base, status: "red-behavior-failure" };
	if (redStatus === "broken") return { ...base, status: "broken-test", reason: "RED tests did not compile/collect" };
	if (redStatus === "green" && alreadySatisfied) return { ...base, status: "green-already-satisfied", reason: "Deliverables were already satisfied before implementation" };
	if (redStatus === "green") return { ...base, status: "green-weak-test", reason: CANONICAL_GREEN_WEAK_REASON };
	return { ...base, status: testFiles.length ? "unknown-unclassified" : "unknown-no-runner", reason: testFiles.length ? "RED status could not be classified from runner output" : "No RED test targets or runner were available" };
}

function formatRedDiagnosticSummary(d: RedCheckDiagnostic): string {
	const exit = d.exitCode === null ? "null" : String(d.exitCode);
	const signal = d.signal ?? "none";
	const error = d.error ? ` error=${d.error}` : "";
	const tail = d.outputTail ? ` tail=${d.outputTail.replace(/\s+/g, " ").slice(0, 600)}` : " tail=none";
	return `cwd=${d.plan.cwd} cmd=${d.plan.argv.map(quoteCmdArg).join(" ")} status=${d.status} exit=${exit} signal=${signal}${error}${tail}`;
}

function firstRedDiagnosticDetail(e: RedEvidence): string {
	const diagnostic = e.diagnostics?.find((d) => d.status === e.oracleStatus) ?? e.diagnostics?.[0];
	return diagnostic ? `diagnostic: ${formatRedDiagnosticSummary(diagnostic)}` : "";
}

export function redEvidenceFailureReasons(e: RedEvidence): string[] {
	if (e.status === "polluted-red") return [`red-polluted: RED phase changed production file(s): ${e.forbiddenFiles.join(", ")}`];
	// v0.3.85 F5 (C3): the ratchet rejection carries its own named class so the
	// terminal/ledger rows stay attributable (a weakened oracle must never read
	// as a generic red-generation failure).
	if (e.status === "weakened-preexisting-test") {
		const weakened = (e.weakenedFiles ?? []).map((w) => `${w.path} ${w.before}→${w.after}`).join(", ");
		return [`red-weakened-preexisting: ${weakened || e.reason || "pre-existing test assertion surface decreased"} — pre-existing assertions must not decrease; author an independent NEW test file (a required weakening is a spec amendment: the declared route)`];
	}
	const detail = firstRedDiagnosticDetail(e);
	if (e.status === "coverage-incomplete") return [`red-coverage-incomplete: missing BDD scenario coverage: ${(e.missingScenarios ?? []).join(", ") || "unknown"}${e.reason ? `; ${e.reason}` : ""}`];
	if (e.status === "green-weak-test") {
		// RC8 (run 10-39): the fixed template lied for every non-oracle weak case
		// (hollow tests, review rejections) — prefer the recorded reason. The
		// canonical oracle-green reason stays verbatim for back-compat.
		const reason = e.reason && e.reason !== CANONICAL_GREEN_WEAK_REASON ? e.reason : "tests passed before implementation";
		return [`red-not-confirmed: ${reason} (${e.testFiles.join(", ") || "no tests"})${detail ? `; ${detail}` : ""}`];
	}
	if (e.status === "review-weak") return [`red-review-rejected: ${e.reason ?? "an independent reviewer did not confirm the RED tests as STRONG"} (${e.testFiles.join(", ") || "no tests"})${detail ? `; ${detail}` : ""}`];
	if (e.status === "broken-test") return [`red-broken: tests did not compile/collect (${e.testFiles.join(", ") || "no tests"})${detail ? `; ${detail}` : ""}`];
	// v0.3.30 F2 (run 2026-08-28T16-09-12-785Z): unknown evidence gets its OWN
	// honest template. Previously the fail-closed guard relabeled unknown to
	// broken-test and this template claimed "tests did not compile/collect"
	// while the agent's own gradle run showed 127 tests ran and 122 FAILED —
	// a lie that misdirected retries and polluted judge inputs.
	// F9-B (v0.3.67, incident 2026-09-04T14-45-04-784Z): when R1 overrode the
	// reason with the TRUE cause (agent aborted / no-edit rejection / no test
	// files), LEAD with it — the canned "no supported test runner was available"
	// asserted a false environment defect that sent tdd-guide re-verifying
	// runners and the judge reading harness source for hours.
	if (e.status === "unknown-no-runner") {
		if (e.reason && e.reason !== "No RED test targets or runner were available") {
			return [`red-unverified: ${e.reason}${detail ? `; ${detail}` : ""}`];
		}
		return [`red-unverified: no supported test runner was available — the RED oracle executed nothing, so the tests were NOT observed failing (nor passing); the harness could not observe them at all${detail ? `; ${detail}` : ""}`];
	}
	if (e.status === "unknown-unclassified") return [`red-unverified: the RED oracle could not classify the runner output${e.reason ? ` — ${e.reason}` : ""}${detail ? `; ${detail}` : ""}`];
	return [];
}

function ownerForImplementationFailure(reasons: string[], kind: "red-generation" | "implementation-gate"): ConvergenceOwnerStage {
	const joined = reasons.join("\n");
	if (/acceptance\s+criteria|\bAC-\d+\b/i.test(joined)) return "requirements";
	if (/BDD|SCENARIO|scenario coverage|missing scenario/i.test(joined)) return "bdd";
	if (/deliverable|missing pattern|requireContains|requireFiles|phase\.|task\.|spec\b/i.test(joined)) return "spec";
	return kind === "red-generation" ? "implementation" : "implementation";
}

function recordImplementationConvergenceFailure(
	state: PipelineState,
	args: { phaseId: string; phaseName: string; kind: "red-generation" | "implementation-gate"; attemptsRun: number; reasons: string[] },
): void {
	const reasons = args.reasons.filter(Boolean);
	if (reasons.length === 0) return;
	const ownerStage = ownerForImplementationFailure(reasons, args.kind);
	recordConvergenceFindings(state, {
		detectedAtStage: "implementation",
		ownerStage,
		severity: "high",
		blocking: true,
		title: `Implementation ${args.phaseId} did not converge`,
		detail: `${args.phaseName} failed after ${args.attemptsRun} attempt(s): ${reasons.slice(0, 5).join("; ")}`,
		evidence: reasons,
		sourceGate: args.kind,
		recommendation: ownerStage === "implementation"
			? "Feed these exact failing gates into the next implementer/TDD retry and avoid resampling unrelated tests."
			: `Route the blocker to ${ownerStage} before asking implementation to retry again.`,
	}, { detectedAtStage: "implementation", ownerStage, sourceGate: args.kind });
}

function redDiagnosticsPrompt(diagnostics: RedCheckDiagnostic[] | undefined): string {
	if (!diagnostics?.length) return "";
	const rendered = diagnostics.slice(0, 3).map((d, index) => {
		const tail = d.outputTail.trim() || "(no stdout/stderr captured)";
		const limitedTail = tail.split(/\r?\n/).slice(-10).join("\n");
		return [
			`${index + 1}. cwd: ${d.plan.cwd}`,
			`   cmd: ${d.plan.argv.map(quoteCmdArg).join(" ")}`,
			`   status: ${d.status}; exit: ${d.exitCode === null ? "null" : d.exitCode}; signal: ${d.signal ?? "none"}${d.error ? `; error: ${d.error}` : ""}`,
			"   output tail:",
			limitedTail.split(/\r?\n/).map((line) => `     ${line}`).join("\n"),
		].join("\n");
	}).join("\n");
	return `\n\n## RED runner diagnostics from the last oracle run\n${rendered}\n\nUse these exact command results. First make the test file compile/collect and execute, then make it fail for the intended missing behavior. Do not resample unrelated tests.`;
}

export function redGenerationRetryHint(e: RedEvidence, opts?: { failClosed?: boolean }): string | null {
	if (e.status === "coverage-incomplete") return tddCoverageRetryHint({
		allCovered: false,
		expectedScenarios: e.expectedScenarios ?? [],
		coveredScenarios: e.coveredScenarios ?? [],
		missingScenarios: e.missingScenarios ?? [],
		summary: e.reason ?? "BDD scenario coverage incomplete",
	});
	// v0.3.85 F5 (C3): the assertion-ratchet rejection's corrective hint — the
	// exact adjudicated semantics: (a) pre-existing assertions must not decrease,
	// (b) the legal RED is an independent NEW test file, (c) a genuinely required
	// weakening of a frozen suite is a spec amendment routed through the declared
	// route (report as a blocker — never edit the frozen tests).
	if (e.status === "weakened-preexisting-test") {
		const weakened = (e.weakenedFiles ?? []).map((w) => `${w.path} (${w.before}→${w.after} markers)`).join(", ");
		return `\n\n${implementationRetrySection("RED assertion ratchet rejected the previous test set", {
			phase: e.phaseId,
			attempt: e.attempt,
			gate: "red-assertion-ratchet",
			location: "pre-existing test files",
			observed: `the RED phase DECREASED the assertion surface of pre-existing test file(s): ${weakened || e.reason || "unknown"} — editing a frozen suite is not a legal route to a RED`,
			expected: "every pre-existing test file keeps its assertion surface (test(/it(/assert/expect/SCENARIO marker count never decreases); equal or higher is legal",
			missing: (e.weakenedFiles ?? []).map((w) => w.path),
			nextAction: "(a) Pre-existing assertions must not decrease — restore what you removed. (b) Author an independent NEW test file that fails for the missing behavior (that is the legal RED). (c) If the work genuinely requires weakening a pre-existing suite, that is a SPEC AMENDMENT — report it as a blocker in your summary (the declared route); do not edit the frozen tests.",
		})}`;
	}
	if (e.status === "green-weak-test") return redRePromptHint("green") + redDiagnosticsPrompt(e.diagnostics);
	if (e.status === "broken-test") return redRePromptHint("broken") + redDiagnosticsPrompt(e.diagnostics);
	// v0.3.30 F2: unknown evidence retries with a HONEST, scoped hint so the
	// fail-closed loop engages without lying about compilation. The hint must
	// never send the agent outside the worktree (run 16-09-12 try 4 spent
	// minutes full-disk hunting the harness's own source after a misdirected
	// toolchain hint). Gated on `failClosed` — when the phase does NOT require
	// tests, unknown still falls through to the implementer (the documented
	// "proceed without stalling" P3 contract; retrying there is a regression).
	if ((e.status === "unknown-no-runner" || e.status === "unknown-unclassified") && opts?.failClosed) {
		// F9-B: mirror the failure-reasons honesty — when R1 overrode the reason
		// with the true cause, the observed field names THAT cause; the runner
		// guidance survives only for genuine no-runner evidence.
		const overriddenReason = e.status === "unknown-no-runner" && e.reason && e.reason !== "No RED test targets or runner were available" ? e.reason : null;
		return `\n\n${implementationRetrySection("RED oracle could not verify the tests", {
			gate: "red-oracle",
			location: "TDD RED test execution",
			observed: e.status === "unknown-no-runner" ? (overriddenReason ?? "no supported test runner was available — the oracle executed nothing") : "the runner output could not be classified",
			expected: "a runnable, recognized test command executes the tests and they FAIL for the right reason",
			nextAction: "Ensure this project has a runnable test command (Gradle: ./gradlew test / testDebugUnitTest; Maven: mvn test; npm test; pytest; cargo test; go test) with its toolchain installed, and run the scoped test ONCE yourself to confirm it FAILS for the right reason. Do NOT modify production code to work around a verification limitation, and do NOT search, read, or modify anything outside this worktree — if the stack is unsupported by the harness, state that limitation in your result and stop.",
		})}` + redDiagnosticsPrompt(e.diagnostics);
	}
	if (e.status === "polluted-red") {
		return `\n\n${implementationRetrySection("RED boundary rejected the previous test set", {
			phase: e.phaseId,
			attempt: e.attempt,
			gate: "red-boundary",
			location: "RED changed-file boundary",
			observed: `RED phase modified files outside the test boundary: ${e.forbiddenFiles.join(", ")}`,
			expected: "RED may create or modify tests and test-only support artifacts only",
			missing: e.forbiddenFiles,
			nextAction: "Rewrite the RED change using test files or test-only support artifacts. Do not create or modify production implementation files.",
		})}`;
	}
	return null;
}

function buildTddCoveragePrompt(args: { phaseName: string; phaseDescription?: string; expectedScenarios: string[]; testFiles: string[]; testSnippets: Array<{ path: string; content: string }>; bddPath?: string; specPath?: string }): string {
	const snippets = args.testSnippets.length
		? args.testSnippets.map((s) => [`### ${s.path}`, "```", s.content.slice(0, 4000), "```"].join("\n")).join("\n\n")
		: "(No readable test file snippets were available.)";
	return [
		"## Purpose",
		"Evaluate whether the RED tests cover the expected BDD scenario IDs for this implementation phase.",
		"Do not write files, run commands, or change the repository.",
		"",
		"## Phase",
		`- Name: ${args.phaseName}`,
		`- Description: ${args.phaseDescription ?? ""}`,
		`- BDD doc: ${args.bddPath ?? "N/A"}`,
		`- Specification: ${args.specPath ?? "N/A"}`,
		`- Expected scenarios: ${args.expectedScenarios.join(", ")}`,
		`- Test files: ${args.testFiles.join(", ") || "none"}`,
		"",
		"## Test File Snippets",
		snippets,
		"",
		"## Rules",
		"A scenario is covered only when a test name, assertion, comment, data table, or nearby setup clearly maps to that SCENARIO-NNN behavior. Prefer explicit SCENARIO-NNN references, but accept unmistakable behavior-level coverage.",
		"If a scenario is not clearly covered, list it as missing. Do not mark allCovered true unless every expected scenario is covered.",
		"A test failing because implementation is missing can still be valid RED; this verifier only decides BDD scenario coverage.",
		"",
		"Output <control> JSON with: allCovered (boolean), coveredScenarios (array), missingScenarios (array), summary.",
	].join("\n");
}

function readTestSnippets(cwd: string, testFiles: string[]): Array<{ path: string; content: string }> {
	return testFiles.slice(0, 12).map((path) => {
		try { return { path, content: readFileSync(join(cwd, path), "utf8") }; }
		catch { return { path, content: "" }; }
	}).filter((item) => item.content.trim().length > 0);
}

// Exported for tests/control-contract-shapes.test.ts (S1): the REAL engine-side
// consumer/verifier of TddCoverageControlData — the S1 contract test generates a
// minimal instance from the TypeBox schema and runs it through this function so
// the schema↔consumer pair can never drift silently (the C2 class). Same
// precedent as verifyJudgeEvidence ("Pure + exported for unit tests").
export async function resolveTddScenarioCoverage(args: { ctx: StageContext; cwd: string; phaseId: string; phaseName: string; phase: unknown; expectedScenarios: string[]; testFiles: string[]; specControl: ControlObj | null | undefined; bddControl: ControlObj | null | undefined }): Promise<TddCoverageResult> {
	if (args.expectedScenarios.length === 0) {
		return { allCovered: true, expectedScenarios: [], coveredScenarios: [], missingScenarios: [], summary: "no expected BDD scenario baseline available" };
	}
	try {
		const phaseDescription = typeof (args.phase as { description?: unknown }).description === "string" ? (args.phase as { description: string }).description : undefined;
		const evaluated = await args.ctx.agent({
			id: `pipeline.implementation.${args.phaseId}.tdd-coverage`,
			agent: "tdd-coverage-classifier",
			accessMode: "source-read-only",
			controlKeys: ["allCovered", "coveredScenarios", "missingScenarios", "summary"],
			// v0.3.70 W3: schema-validated control (structured delegation).
			schema: TddCoverageControlData,
			prompt: buildTddCoveragePrompt({
				phaseName: args.phaseName,
				phaseDescription,
				expectedScenarios: args.expectedScenarios,
				testFiles: args.testFiles,
				testSnippets: readTestSnippets(args.cwd, args.testFiles),
				bddPath: typeof args.bddControl?.docPath === "string" ? args.bddControl.docPath : undefined,
				specPath: typeof args.specControl?.specificationPath === "string" ? args.specControl.specificationPath : undefined,
			}),
		});
		const control = evaluated.control ?? {};
		const covered = uniqueScenarioIds(scenarioIdsFromUnknown(control.coveredScenarios));
		const reportedMissing = uniqueScenarioIds(scenarioIdsFromUnknown(control.missingScenarios));
		const expectedSet = new Set(args.expectedScenarios);
		const coveredExpected = covered.filter((id) => expectedSet.has(id));
		const missingByDiff = args.expectedScenarios.filter((id) => !coveredExpected.includes(id));
		const missing = reportedMissing.length ? uniqueScenarioIds(reportedMissing.filter((id) => expectedSet.has(id))) : missingByDiff;
		// Authoritative coverage = the diff over the classifier's granular coveredScenarios
		// list. Do NOT also require control.allCovered === true: that boolean is a derived
		// summary of the same list and is the brittle channel — LLM shape drift routinely
		// emits every scenario in coveredScenarios (so the diff passes) while flubbing or
		// omitting the aggregate boolean, which would falsely fail a genuinely-covered RED.
		const allCovered = missing.length === 0 && coveredExpected.length >= args.expectedScenarios.length;
		return {
			allCovered,
			expectedScenarios: args.expectedScenarios,
			coveredScenarios: coveredExpected,
			missingScenarios: allCovered ? [] : (missing.length ? missing : missingByDiff),
			summary: String(control.summary ?? evaluated.error ?? "coverage verifier returned incomplete control"),
		};
	} catch (err) {
		return {
			allCovered: false,
			expectedScenarios: args.expectedScenarios,
			coveredScenarios: [],
			missingScenarios: args.expectedScenarios,
			summary: `coverage verifier failed: ${err instanceof Error ? err.message : String(err)}`,
		};
	}
}

function boundarySummary(result: RedBoundaryResult): string {
	const classifications = result.classifications.map((c) => `${c.path}:${c.category}:${c.allowed ? "allow" : "deny"}:${c.source}:${c.confidence.toFixed(2)}`).join("; ") || "none";
	return `allAllowed=${result.allAllowed} forbidden=${listOrNone(result.forbiddenFiles)} ambiguous=${listOrNone(result.ambiguousFiles)} classifications=${classifications}`;
}

export async function resolveRedBoundary(args: { ctx: StageContext; phaseId: string; phaseName: string; phase: unknown; redStatus: RedStatus; testFiles: string[]; changedFiles: string[]; cwd: string }): Promise<RedBoundaryResult> {
	const deterministic = args.changedFiles.map(classifyObviousRedPath);
	const ambiguous = deterministic.filter((item) => item.category === "ambiguous" && !item.allowed).map((item) => item.path);
	if (ambiguous.length === 0) return redBoundaryResultFromClassifications(deterministic);
	try {
		const phaseDescription = typeof (args.phase as { description?: unknown }).description === "string" ? (args.phase as { description: string }).description : undefined;
		const evaluated = await args.ctx.agent({
			id: `pipeline.implementation.${args.phaseId}.red-boundary`,
			agent: "red-boundary-classifier",
			accessMode: "source-read-only",
			controlKeys: ["classifications", "forbiddenFiles", "ambiguousFiles", "allAllowed"],
			// v0.3.70 W3: schema-validated control (structured delegation).
			schema: FileClassifyControlData,
			prompt: buildRedBoundaryPrompt({
				changedFiles: ambiguous,
				testFiles: args.testFiles,
				phaseName: args.phaseName,
				phaseDescription,
				redStatus: args.redStatus,
			}),
		});
		// v0.3.24 S4-1 context: the byPath matching inside
		// redBoundaryResultFromAgent is now SUFFIX-TOLERANT — the evaluator's
		// absolute/differently-prefixed path echoes no longer fall to
		// `fallback: evaluator omitted this path` denies (run
		// 2026-08-28T12-51-40-028Z: three textbook-valid declaration-only
		// scaffolds reverted purely on that plumbing mismatch). A deliberate
		// design note: a genuinely-omitted verdict still DENIES — "new file +
		// failing RED" alone does not prove declaration-only content (a RED agent
		// can write partial real implementation), so there is no deterministic
		// scaffold repair here; the escape hatches are the evaluator itself, the
		// widened late judge floor (fix-environment + allow-scaffold), and the
		// noise-free signature cycle detection.
		const agentResult = redBoundaryResultFromAgent(ambiguous, evaluated.control);
		const byPath = new Map(agentResult.classifications.map((item) => [item.path, item]));
		return redBoundaryResultFromClassifications(deterministic.map((item) => byPath.get(item.path) ?? item));
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return redBoundaryResultFromClassifications(deterministic.map((item) => item.category === "ambiguous" ? { ...item, source: "fallback", confidence: 0, reason: `boundary evaluator failed: ${message}` } : item));
	}
}

function snapshotFiles(cwd: string, paths: string[]): Map<string, string | null> {
	const out = new Map<string, string | null>();
	for (const path of paths) {
		try { out.set(path, readFileSync(join(cwd, path), "utf8")); }
		catch { out.set(path, null); }
	}
	return out;
}

/** Recognizable assertion calls across the pipeline's supported stacks. A RED
 *  test file that contains ZERO of these is HOLLOW — it may fail/pass for reasons
 *  unrelated to the behavior under test (e.g. only a bare `it("...", () => {})`),
 *  so a later minimal implementation can make it "green" without proving anything.
 *  This is the cheap, deterministic Tier-1 guard (weak-but-present assertions are
 *  Tier 2's job). Comment-stripping is intentionally skipped — a false NEGATIVE
 *  (assertion in a comment) is safe here because it only avoids a reject. */
const ASSERTION_RE = /\b(?:expect|assert|assert_eq|assert_ne|assertEquals|assertTrue|assertFalse|should|require\.|assert\.|t\.Error|t\.Fatal|t\.Errorf|t\.Fatalf|XCTAssert)\b|\bassert!|\bassert_eq!|\bassert_ne!/;

/** A RED artifact that is an actual TEST file (by name) — vs a test-only SUPPORT
 *  artifact (a fixture/helper imported by a test). The hollow-assertion guard
 *  applies ONLY to test files: a support fixture legitimately has no assertion,
 *  so flagging it would falsely reject a valid RED set. */
const TEST_FILE_NAME_RE = /(\.test\.|\.spec\.|_test\.|(^|\/)test_|(^|\/)tests?\/|__tests__\/)/i;

/** v0.3.17 (run 2026-08-26T02-36-42-419Z phase-02): pytest's RESERVED support
 *  filename. conftest.py is auto-loaded by pytest itself (fixtures, plugins,
 *  sys.path bootstrap) and legitimately contains no assertions — it is the
 *  canonical "fixture/helper imported by a test" the guard's doc comment
 *  already exempts in spirit. Matched on BASENAME at any depth because pytest
 *  collects it from every directory on the rootdir→test path (a package-root
 *  conftest is as legal as a tests/ one). Exempting it twice killed REAL RED
 *  sets in the incident (tries 3 and 5) whose only clean import fix lived in
 *  conftest.py. */
const PYTEST_SUPPORT_BASENAME_RE = /(^|\/)conftest\.py$/i;

/** Return the RED TEST files (from a content snapshot) that contain no
 *  recognizable assertion call. Non-test-named support artifacts are skipped
 *  (they may legitimately have no assertion). Files that couldn't be read (null)
 *  are skipped — absence of content is not evidence of a hollow test and must not
 *  block. Pure; never throws. */
export function assertionPresenceGaps(snapshot: Map<string, string | null>): string[] {
	const gaps: string[] = [];
	for (const [path, content] of snapshot) {
		if (content == null) continue;
		if (!TEST_FILE_NAME_RE.test(path)) continue; // support artifact, not a test
		if (PYTEST_SUPPORT_BASENAME_RE.test(path)) continue; // conftest.py — pytest support artifact (v0.3.17)
		if (!ASSERTION_RE.test(content)) gaps.push(path);
	}
	return gaps;
}

// ── v0.3.85 F5 (C3 fix; §9 F5, §14 ADR 10) — the RED-phase assertion ratchet ──

/** §13/§14 ADR 8: the F5 declared-handoff row tag — distinct from
 *  INHERITED_RED_SOURCE (the F2/F4 tag) and never overloading
 *  `classificationSource` (that is R2 routing provenance, a different concept). */
const RED_WEAKENING_SOURCE = "red-weakening";

/** v0.3.85 F5 — the assertion-surface GRAMMAR (P2: enumerated, not
 *  one-form-at-a-time). A file's assertion surface is the number of matches of
 *  ONE canonical regex:
 *
 *    /\b(?:test|it)\s*\(|\bassert|\bexpect|\bSCENARIO\b/g
 *
 * covering the marker families the pipeline's stacks actually use:
 *   - `test(` / `it(` — JS/TS (jest/vitest/mocha/node:test), allowing optional
 *     whitespace before the paren (`it (`). Python declarations (`def
 *     test_x():`) carry NO declaration marker — the underscored name breaks
 *     `test\s*\(` — so a python file's surface rides its `assert` markers
 *     (documented). Skip-marked forms (`test.skip(`, `xit(`) do NOT match the
 *     declaration marker: converting `test(` → `test.skip(` LOWERS the surface
 *     (detected); deleting an already-skipped test leaves it unchanged
 *     (undetected — documented fail-open blind spot).
 *   - `assert` — Python `assert`, Rust `assert!`/`assert_eq!`, JUnit
 *     `assertEquals`/`assertTrue`, Go testify — matched as a word START with NO
 *     end boundary, so `assertion`/`asserted` also count.
 *   - `expect` — jest/vitest/Playwright `expect(...)` and Rust `.expect(...)` —
 *     word START only, so `expected`/`expects` also count.
 *   - `SCENARIO` — the harness's BDD scenario ids (`SCENARIO-001`) and Gherkin
 *     `Scenario:` headers — CASE-SENSITIVE (the id grammar is uppercase;
 *     lowercase `scenario` does not count).
 *
 * COUNTING RULE: raw occurrence count per file, with BOTH sides of the
 * comparison read under this SAME grammar. Comments are deliberately NOT
 * stripped — mirroring ASSERTION_RE's documented choice but for the OPPOSITE
 * safety reason: a marker inside a comment (or a prose word like `expected`)
 * only INFLATES a surface, and inflation can only MASK a decrease (fail-open),
 * never fabricate one; a comment-stripper bug that ate real code would do the
 * fail-closed harm instead. `describe(`/`context(` grouping forms are out of
 * grammar: they group tests without asserting, so removing one without
 * removing its inner markers does not lower the surface (documented). */
const ASSERTION_SURFACE_RE = /\b(?:test|it)\s*\(|\bassert|\bexpect|\bSCENARIO\b/g;

/** Count one file's assertion surface under the F5 grammar. Pure; never throws. */
export function assertionSurfaceCount(content: string): number {
	return (content.match(ASSERTION_SURFACE_RE) ?? []).length;
}

/** One comparable file for the ratchet. `before` is the pre-edit (HEAD)
 * content — `null` means the file did NOT exist pre-edit (newly authored this
 * try → exempt: it survives both the ratchet and the revert). `after` `null`
 * means the file was deleted on disk (surface 0). */
export interface AssertionSurfaceRow {
	path: string;
	before: string | null;
	after: string | null;
}

/** A weakened row: the path plus its before→after surface counts. */
export interface WeakenedAssertionSurface {
	path: string;
	before: number;
	after: number;
}

/** The ratchet predicate (pure; never throws): every row whose post-edit
 *  surface is STRICTLY lower than its pre-edit surface (a deleted pre-existing
 *  file counts as 0). Equal or HIGHER surfaces pass — ADDING assertions to a
 *  pre-existing test file is legal and stays accepted. */
export function weakenedAssertionSurfaces(rows: AssertionSurfaceRow[]): WeakenedAssertionSurface[] {
	const out: WeakenedAssertionSurface[] = [];
	for (const row of rows) {
		if (row.before === null) continue; // not pre-existing — new file, exempt
		const before = assertionSurfaceCount(row.before);
		const after = row.after === null ? 0 : assertionSurfaceCount(row.after);
		if (after < before) out.push({ path: row.path, before, after });
	}
	return out;
}

/** `git show HEAD:<path>` content — `null` when the path is not tracked at
 *  HEAD (new/untracked file), on any git failure, or on a spawn error. Never
 *  throws. For a path clean at RED entry (everything in redChangedFiles, by
 *  the setDiff construction) HEAD content IS the pre-edit disk content. */
function headFileContent(cwd: string, path: string): string | null {
	try {
		const r = spawnSync("git", ["-C", cwd, "show", `HEAD:${path}`], { encoding: "utf8", timeout: 10_000 });
		if (r.error || typeof r.status !== "number" || r.status !== 0) return null;
		return String(r.stdout ?? "");
	} catch {
		return null;
	}
}

/** The F5 comparable set (impure; never throws): RED-changed paths that are
 *  TEST files by name (TEST_FILE_NAME_RE; conftest.py stays a support
 *  artifact, mirroring assertionPresenceGaps) and PRE-EXISTING (tracked at
 *  HEAD). Harness bookkeeping/substrate paths are exempt, mirroring
 *  restoreUnacceptedRedChanges's filter. */
function preexistingTestSurfaceRows(cwd: string, changedFiles: string[]): AssertionSurfaceRow[] {
	const rows: AssertionSurfaceRow[] = [];
	for (const path of changedFiles) {
		const rel = normalizeSlash(path);
		if (!TEST_FILE_NAME_RE.test(rel) || PYTEST_SUPPORT_BASENAME_RE.test(rel)) continue;
		if (isInternalRuntimeClaim(rel) || isSubstrateArtifact(rel) || isHarnessBookkeepingPath(rel)) continue;
		const before = headFileContent(cwd, rel);
		if (before === null) continue; // not pre-existing — new file, exempt
		let after: string | null = null;
		try { after = readFileSync(join(cwd, rel), "utf8"); } catch { after = null; }
		rows.push({ path: rel, before, after });
	}
	return rows;
}

function changedSinceSnapshot(cwd: string, before: Map<string, string | null>): string[] {
	const changed: string[] = [];
	for (const [path, oldContent] of before) {
		let next: string | null = null;
		try { next = readFileSync(join(cwd, path), "utf8"); } catch { next = null; }
		if (next !== oldContent) changed.push(path);
	}
	return changed;
}

/** Restore confirmed RED test files that the GREEN implementer modified,
 *  writing the snapshot's original content back to disk. Returns the count
 *  actually restored (files whose snapshot content was non-null and wrote
 *  successfully). This re-establishes the honest RED oracle so the phase can
 *  retry the implementer WITHOUT re-running the RED phase — the RED tests are
 *  still valid; only the implementer overstepped by editing them. Best-effort:
 *  a write failure is skipped (the next changedSinceSnapshot re-check will
 *  still flag an unrestored file). */
function restoreRedTestFiles(cwd: string, snapshot: Map<string, string | null>, modified: string[]): number {
	let restored = 0;
	for (const path of modified) {
		const content = snapshot.get(path);
		if (content == null) continue;
		try { writeFileSync(join(cwd, path), content); restored++; } catch { /* best-effort */ }
	}
	return restored;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** Hard ceiling on RED-generation tries within one implementation attempt (RC-3).
 *  Cycle detection handles oscillation; this bounds a non-repeating drift the
 *  signature hash might not catch, so a phase can never spin ~indefinitely on the
 *  global budget alone (the 47-retry/15h livelock). Env-overridable for tuning. */
const MAX_RED_RETRIES = (() => {
	const raw = Number.parseInt(superDevEnv("SUPER_DEV_MAX_RED_RETRIES") ?? "", 10);
	return Number.isFinite(raw) && raw > 0 ? raw : 6;
})();

/** v0.3.30 F3 (run 2026-08-28T16-09-12-785Z try 4): a judge `fix-environment`
 *  verdict restarts the RED loop with a repair hint. When the environment gap
 *  is outside the worktree (harness-side, e.g. an unsupported runner), blind
 *  restarts only burn budget and the misdirected "repair the toolchain" hint
 *  sent the agent full-disk hunting the harness's own source. ONE restart is
 *  granted for genuinely in-repo environment fixes; the next fix-environment
 *  verdict terminates the loop honestly (`environment-blocked`). */
const MAX_RED_ENV_RESTARTS = (() => {
	const raw = Number.parseInt(superDevEnv("SUPER_DEV_MAX_RED_ENV_RESTARTS") ?? "", 10);
	return Number.isFinite(raw) && raw >= 0 ? raw : 1;
})();

/** Cap on ROUTED judge interventions per phase at the RED no-progress boundary
 *  (run 2026-08-27T12-33-43-088Z: phase-03 ground through 9 RED tries / 5 judge
 *  calls / ~3.5h because every routed `re-author-tests` verdict RESET the RED
 *  retry ladder; the correct `fix-environment` diagnosis only landed at 04:43).
 *  After the cap, stop resampling and force environment diagnosis.
 *  Env-overridable for tuning. */
export const MAX_RED_JUDGE_ROUTES = (() => {
	const raw = Number.parseInt(superDevEnv("SUPER_DEV_MAX_RED_JUDGE_ROUTES") ?? "", 10);
	return Number.isFinite(raw) && raw > 0 ? raw : 3;
})();

/** Pure route-set policy: while `usedRoutes` routed interventions remain under
 *  `cap`, the full allowed set passes through; at/after the cap the floor is
 *  `fix-environment` + `allow-scaffold` — the loop has proven re-sampling
 *  cannot converge, so only the environment diagnosis and the last
 *  deterministic scaffold re-admission remain. */
export function restrictRedJudgeRoutes<T extends readonly string[]>(usedRoutes: number, allowed: T, cap: number = MAX_RED_JUDGE_ROUTES): T | readonly ["fix-environment", "allow-scaffold"] {
	// v0.3.24: the post-cap floor keeps BOTH late recovery routes — fix-environment
	// alone starved allow-scaffold, the last deterministic exit for a genuinely
	// scaffold-legal RED whose boundary classification kept failing.
	return usedRoutes >= cap ? (["fix-environment", "allow-scaffold"] as const) : allowed;
}

/** Loose phase shape for the leakage guard — self-contained so spec/doc types
 *  can evolve without touching this pure function. */
export type LeakPhase = {
	name?: string;
	deliverables?: {
		requireFiles?: string[];
		requireContains?: Array<{ file: string }>;
		requireNotContains?: Array<{ file: string }>;
		requireTests?: string[];
	};
};

const leakNorm = (p: string): string => p.trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");

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

/** Cross-phase deliverable leakage (run 2026-08-27T12-33-43-088Z): phase-2's
 *  implementer changed root index.html — phase-3's DECLARED deliverable — out
 *  of scope, so phase-3 could never author an honest RED (its deliverable
 *  already existed; the honest revert was itself flagged "RED pollution").
 *  Returns the changed files that intersect any LATER phase's declared
 *  deliverables (path-drift tolerant), current phase excluded. Pure. */
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
const MAX_CHALLENGE_REAUTHORS = (() => {
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
const IMPLEMENTER_CONTROL_KEYS = ["filesCreated", "filesModified", "filesDeleted", "testsPassCount", "summary", "testDefects"];

/** Fix 5 — cheap text-proof heuristic markers. ADVISORY ONLY: text alone never
 *  auto-triggers a re-author (`.text` is always present; the no-progress guard
 *  exists precisely because of that) — it only flags the escalation message. */
const UNSATISFIABLE_TEXT_RE = /unsatisfiab|contradict|cannot be satisfied/i;

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
function trimImplementerText(text: string | undefined, max = 1200): string {
	const t = (text ?? "").trim();
	if (!t) return "";
	return t.length <= max ? t : `…${t.slice(-max)}`;
}

/** Build the evidence suffix appended to the tdd-guide re-author prompt when
 *  re-authoring because the implementer proved the prior RED unsatisfiable.
 *  Prefers structured testDefects; falls back to a trimmed implementer
 *  reasoning tail so even a model that ignores the testDefects contract still
 *  surfaces its diagnosis instead of re-authoring blind. */
function formatReauthorEvidence(defects: TestDefect[], implTextTail: string): string {
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
function redRePromptHint(status: RedStatus): string {
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
function redImplementContext(status: RedStatus): string {
	if (status === "red") {
		return "The TDD tests are CONFIRMED-red; your goal is to make them green.";
	}
	// unknown — red could not be determined at all (e.g. greenfield: no test runner).
	return "The TDD red status could not be confirmed (status: unknown) — proceeding; red was not verified.";
}

function quoteCmdArg(arg: string): string {
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
function cratesFromErrors(errors: string[]): string[] {
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
export interface PhaseStatusEntry {
	id: string;
	status: "green" | "failed" | "partial";
	/** v0.3.0 windup bound: how many §D convergence iterations re-entered this
	 *  phase as partial, and the failure signature each pass ended on (a phase
	 *  whose partial keeps the SAME signature is hopeless this run — after
	 *  MAX_PARTIAL_REENTRIES passes it is skipped so the budget flows to the
	 *  phases that can still converge). */
	partialReEntries?: number;
	lastFailureSig?: string;
	/** v0.3.85 S3 (metrics-only): the PEAK implementer attempts this phase
	 *  consumed across §D entries (attempts reset per §D re-entry per F3, so
	 *  the max is the honest exposure). No control flow reads this — it feeds
	 *  RunMetricsRow.maxPhaseAttempts at close-out via deriveS3Counters. */
	attempts?: number;
}
export interface PhaseFailureEntry {
	phaseId: string;
	reasons: string[];
}
/** v0.3.0 (harness research, docs/requirements/harness-research-and-v0.3.0-architecture.md):
 *  a phase that exhausts its attempts no longer terminates the run — its best
 *  attempt is PRESERVED as a labeled git stash and the pipeline continues to
 *  the next phase (SWE-agent get_best / Anthropic git-per-increment semantics:
 *  never end a run with zero preserved work). Best-effort and never fatal: a
 *  stash failure only logs (the dirty tree itself still carries the work). */
function preservePartialPhase(ctx: StageContext, setup: { worktreePath: string; specDirectory?: string } | undefined, phaseId: string, phaseName: string, reason: string): void {
	if (!setup) return;
	// review code-F1 (high): in-place runs share the USER's checkout — an
	// automatic stash there would sweep the user's own uncommitted work. The
	// preserve stash only ever runs in a dedicated super-dev worktree.
	const worktreeCreated = (setup as { worktreeCreated?: boolean }).worktreeCreated;
	if (worktreeCreated === false) {
		ctx.log(`Implementation ${phaseId} partial: stash-preserve SKIPPED (in-place run shares the user's checkout — no automatic worktree mutations); any uncommitted phase work stays dirty for inspection`);
		return;
	}
	// The same "no automatic worktree mutations" kill-switch that disables the
	// quarantine governs this preserve stash — a user who set
	// SUPER_DEV_NO_DIRTY_QUARANTINE=1 opted out of ALL automatic stashing.
	if (superDevEnv("SUPER_DEV_NO_DIRTY_QUARANTINE") === "1") {
		ctx.log(`Implementation ${phaseId} partial: stash-preserve SKIPPED (SUPER_DEV_NO_DIRTY_QUARANTINE=1 — no automatic worktree mutations); any uncommitted phase work stays dirty for inspection`);
		return;
	}
	try {
		// The spec directory (stage docs, evidence ledgers, knowledge) is harness
		// bookkeeping living untracked in the worktree until the release commit —
		// it must NEVER ride the partial stash (resume + downstream stages read it).
		// Pathspec magic excludes it from both the tracked and untracked sweep.
		const relSpec = ((): string => {
			const abs = typeof setup.specDirectory === "string" ? setup.specDirectory : "";
			if (!abs) return "docs/specifications";
			const rel = abs.startsWith("/") ? abs.slice(setup.worktreePath.length).replace(/^\/+/, "") : abs;
			return rel || "docs/specifications";
		})();
		const r = spawnSync("git", ["-C", setup.worktreePath, "stash", "push", "--include-untracked", "-m", `super-dev partial ${phaseId}: ${reason.slice(0, 120)}`, "--", ".", `:(exclude)${relSpec}`, ":(exclude)docs/specifications"], { encoding: "utf8", timeout: 30_000 });
		if (r.status === 0 && String(r.stdout).trim().length > 0) {
			ctx.log(`Implementation ${phaseId} partial preserved via git stash (${String(r.stdout).trim().slice(0, 40)}) — recoverable via git stash list`);
		} else if (r.status === 0) {
			ctx.log(`Implementation ${phaseId} partial: tree already clean — no preserve stash created; the committed state IS the best attempt`);
		} else {
			ctx.log(`Implementation ${phaseId} partial: stash attempt FAILED (exit ${r.status}) — NOT preserved via stash; any uncommitted phase work stays dirty for inspection (non-fatal)`);
		}
	} catch (error) {
		ctx.log(`Implementation ${phaseId} partial: stash attempt THREW (${error instanceof Error ? error.message : String(error)}) — NOT preserved via stash; non-fatal`);
	}
}

export function phaseStatusUpsert(arr: PhaseStatusEntry[], id: string, status: "green" | "failed" | "partial", attempts?: number): void {
	const i = arr.findIndex((p) => p.id === id);
	// v0.3.85 S3: `attempts` merges as a MAX across §D entries (the metric is
	// peak exposure); the existing replace semantics for id/status are
	// unchanged, and the partial-boundary mutations below (lastFailureSig /
	// partialReEntries) still apply to the fresh entry.
	const prev = i >= 0 ? arr[i] : undefined;
	const entry: PhaseStatusEntry = { id, status, ...(attempts !== undefined || prev?.attempts !== undefined ? { attempts: Math.max(attempts ?? 0, prev?.attempts ?? 0) } : {}) };
	if (i >= 0) arr[i] = entry;
	else arr.push(entry);
}
export function lastFailuresUpsert(arr: PhaseFailureEntry[], phaseId: string, reasons: string[]): void {
	const i = arr.findIndex((f) => f.phaseId === phaseId);
	if (i >= 0) arr[i] = { phaseId, reasons };
	else arr.push({ phaseId, reasons });
}

/** v0.3.43 RC2: discard the implementer's GREEN work when a parallel RED
 *  review joins with a fail-closed verdict (contradiction / invalid / error).
 *  Restores every worktree change EXCEPT: the RED test files (the suite must
 *  survive for re-authoring), harness bookkeeping (spec-dir ledgers are durable
 *  evidence), and runtime-scratch basenames. Untracked new files are removed;
 *  tracked modifications/deletions are restored from the index (= HEAD — the
 *  engine never stages during a phase). Returns the restored paths for the
 *  log. Never throws. */
function isInsidePath(child: string, parent: string): boolean {
	const rel = relative(parent, child);
	return rel === "" || (!!rel && !rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * v0.3.54 — attribute-and-restore for QUARANTINED reviewer violations (F3-real).
 *
 * A concurrent-with-writer read-only call (the RED review) that violates its
 * boundary is QUARANTINED by the guard (contents copied to a tmp dir, nothing
 * restored) because a blind `git restore` at detection time reverts to HEAD and
 * destroys the implementer's legitimate concurrent writes to the same file
 * (live: run 2026-08-31T16-03-57-978Z phase 11 — "boundary reversion wiped the
 * homepage cosmic card"). Attribution happens HERE, at the join, where the
 * implementer's claimed files are known:
 *   - path NOT claimed by the implementer → only the reviewer touched it →
 *     `git restore` is safe and removes the unreviewed edit;
 *   - path claimed by the implementer (or a phase test file) → content is mixed
 *     → left in place; the quarantined copy preserves the mixed state and the
 *     F2 ledger finding carries the paths for review.
 *
 * Trust bound: attribution uses the implementer's DECLARED files, and the
 * restore loop runs ONLY when the control declared at least one file — a null
 * control or all-empty file lists carries no attribution signal, so nothing
 * is restored then (v0.3.54 review fix, adv F1-i). A lying UNDER-claim (a
 * modified path omitted from the lists) can still cause its restoration: in
 * this fail-open branch no retry follows, and the change gate snapshots the
 * tree AFTER this function, so it cannot catch the loss. That residual risk
 * is honest and bounded — the full file bytes survive in the quarantine dir
 * and the F2 ledger finding names every path for manual recovery. Phase test
 * files are always kept (RED-hijack guard). Untracked reviewer-created files
 * cannot be git-restored; they are left in place and the change gate flags
 * them changed-not-claimed (conservative).
 *
 * v0.3.55 security review F1: the payload arrives ONLY via the structured
 * `quarantine` property of the thrown Error (composed parent-side from
 * git-status output). Error TEXT is never parsed — stderr tails and
 * delegation error strings are agent-influenceable, and a forged string
 * could previously weaponize this function into wiping implementer work.
 * No payload → no restore, ever (conservative; the quarantined bytes and the
 * ledger finding remain the evidence trail).
 */
/** v0.3.73 M1 (run 2026-09-05T23-09-55-596Z): the PURE half of quarantine
 *  attribution — classify every violation path as implementer-claimed (the
 *  concurrent writer's declared files ∪ phase test files) or unclaimed, without
 *  touching the worktree. The join uses this to decide whether a discarded
 *  red-review verdict can be SALVAGED: when declaredAny ∧ zero unclaimed, the
 *  reviewer demonstrably wrote nothing and every delta is the concurrent
 *  writer's — the formed verdict is evidence about the suite, not a violation.
 *  Path normalization semantics are verbatim v0.3.55 F3 (see below). */
export function attributeQuarantinePaths(
	worktreePath: string,
	payload: BoundaryQuarantinePayload | null | undefined,
	implControl: unknown,
	testFiles: string[],
	opts?: { testFilesAsClaims?: boolean },
): { declaredAny: boolean; claimed: string[]; unclaimed: string[] } {
	if (!payload || !Array.isArray(payload.violations)) return { declaredAny: false, claimed: [], unclaimed: [] };
	const paths = payload.violations.filter((p): p is string => typeof p === "string" && p.length > 0);
	const rootAbsNorm = resolve(worktreePath);
	const norm = (p: string) => {
		try {
			const rel = relative(rootAbsNorm, resolve(rootAbsNorm, p));
			return rel === "" ? p : rel;
		} catch { return p; }
	};
	// v0.3.73 dual review AR-73-01: testFiles claim membership UNCONDITIONALLY —
	// sound for the pre-existing RESTORE semantics (v0.3.55 F3: a test-file delta
	// must never be git-reverted as a reviewer violation), but NOT sound evidence
	// that the reviewer wrote nothing. The M1 SALVAGE gate therefore runs with
	// testFilesAsClaims=false: attribution there must rest on implementer-DECLARED
	// claims only. Default stays true so restore callers are unchanged.
	const claims = new Set<string>();
	if (opts?.testFilesAsClaims !== false) for (const t of testFiles) claims.add(norm(t));
	// declaredAny is the IMPLEMENTER-claim signal only (v0.3.54 adv F1-i): with
	// no implementer-declared files there is no attribution signal — both the
	// restore path and the M1 salvage decision fail closed. Phase test files
	// join the claims set but never set this flag.
	let declaredAny = false;
	if (implControl && typeof implControl === "object" && !Array.isArray(implControl)) {
		const rec = implControl as Record<string, unknown>;
		for (const key of ["filesCreated", "filesModified", "filesDeleted"]) {
			const list = rec[key];
			if (Array.isArray(list)) {
				for (const f of list) if (typeof f === "string" && f) { claims.add(norm(f)); declaredAny = true; }
			}
		}
	}
	const claimed: string[] = [];
	const unclaimed: string[] = [];
	for (const rawRel of paths) {
		const rel = norm(rawRel);
		if (claims.has(rel)) claimed.push(rel);
		else unclaimed.push(rel);
	}
	return { declaredAny, claimed, unclaimed };
}

export function attributeQuarantinedViolations(
	worktreePath: string,
	payload: BoundaryQuarantinePayload | null | undefined,
	implControl: unknown,
	testFiles: string[],
	log: (line: string) => void,
): void {
	// v0.3.55 security review F1: only the engine-composed structured payload
	// drives restores. Anything else (a plain error string, a null, an unknown
	// shape) restores nothing.
	if (!payload || !Array.isArray(payload.violations)) return;
	const parsed = { paths: payload.violations.filter((p): p is string => typeof p === "string" && p.length > 0), dir: typeof payload.dir === "string" ? payload.dir : "" };
	// v0.3.73 M1: attribution (claims ∪ normalization) lives in the pure
	// classifier above; this function keeps ONLY the restore/keep side effects
	// and their logs.
	const attribution = attributeQuarantinePaths(worktreePath, payload, implControl, testFiles);
	const claims = new Set([...attribution.claimed]);
	const declaredAny = attribution.declaredAny;
	if (!declaredAny) {
		// v0.3.54 review fix (adv F1-i): with no implementer-declared files there
		// is no attribution signal at all — restoring anything would wipe
		// possibly-undeclared concurrent GREEN work that no retry will bring back.
		log(`red-review-quarantine: left in place (no implementer file claims available — cannot attribute safely; quarantined copies preserved${parsed.dir ? ` at ${parsed.dir}` : ""}): ${parsed.paths.join(", ")}`);
		return;
	}
	const safe: string[] = [];
	const kept: string[] = [];
	const rootAbs = resolve(worktreePath);
	const rootAbsNorm = resolve(worktreePath);
	const norm = (p: string) => {
		try {
			const rel = relative(rootAbsNorm, resolve(rootAbsNorm, p));
			return rel === "" ? p : rel;
		} catch { return p; }
	};
	for (const rawRel of parsed.paths) {
		const rel = norm(rawRel);
		if (claims.has(norm(rel))) {
			kept.push(rel);
			continue;
		}
		// Defense-in-depth (P1): the violation path names a worktree file, but a
		// malformed/traversal one is simply never worth executing a restore for
		// — keep it (manual) instead. Checked against the RAW path so resolve()
		// cannot silently canonicalize an escape away.
		if (isAbsolute(rawRel) || rawRel.includes("..") || rawRel.includes("\u0000")) {
			kept.push(rel);
			continue;
		}
		if (!isInsidePath(resolve(rootAbs, rel), rootAbs)) {
			kept.push(rel);
			continue;
		}
		// Not claimed by the implementer and not a phase test file: the only delta
		// is the reviewer's — safe to revert. Failure keeps the path (manual).
		// v0.3.55 security review F2: `:(literal)` — `--` ends option parsing but
		// NOT pathspec magic, so a file literally named `:(top)*` would otherwise
		// widen this restore to a worktree-wide revert (same guard as
		// fault-classification.ts stash pathspecs).
		const literalPath = `:(literal)${rel}`;
		let r = spawnSync("git", ["restore", "--staged", "--worktree", "--", literalPath], { cwd: worktreePath, encoding: "utf8" });
		if (r.status !== 0) r = spawnSync("git", ["checkout", "--", literalPath], { cwd: worktreePath, encoding: "utf8" });
		if (r.status === 0) safe.push(rel);
		else kept.push(rel);
	}
	if (safe.length) log(`red-review-quarantine: restored unclaimed reviewer edits (implementer never touched them): ${safe.join(", ")}`);
	if (kept.length) log(`red-review-quarantine: left in place (implementer-owned or mixed content — quarantined copy preserved${parsed.dir ? ` at ${parsed.dir}` : ""}): ${kept.join(", ")}`);
}

/** F-17 (v0.3.86): DEPRECATED alias for {@link attributeQuarantinedViolations}
 *  (the old spelling dropped the second 'e'). Kept as a re-export so any
 *  out-of-tree consumer keeps compiling; identical function object. */
export const attributQuarantinedViolations = attributeQuarantinedViolations;

/** v0.3.55 security review F1: parseQuarantinePayload deleted. Error text is
 *  an agent-influenceable channel (stderr tails land verbatim in review.error
 *  on the subprocess/delegation backends) and must never be parsed into
 *  restore pathspecs. The structured BoundaryQuarantinePayload on the thrown
 *  Error — produced by boundaryQuarantinePayload in workflow.ts — is the only
 *  trusted input. */

export function discardGreenWork(worktreePath: string, keepTestFiles: Set<string>): string[] {
	// v0.3.45: the -z reader replaces RAW v1-line parsing — v1 C-quotes
	// space paths on every machine and octal-escapes non-ASCII on default
	// `core.quotepath=true` machines, so rmSync/restore silently missed them.
	const restored: string[] = [];
	for (const e of porcelainEntries(worktreePath)) {
		const path = e.path;
		const base = path.split("/").pop() ?? path;
		if (keepTestFiles.has(path) || PHASE_COMMIT_EXCLUDED_BASENAMES.has(base) || isHarnessBookkeepingPath(path)) continue;
		if (e.status === "??") {
			try { rmSync(resolve(worktreePath, path), { force: true }); restored.push(path); } catch { /* best-effort */ }
		} else {
			// v0.3.55 security review F2: `:(literal)` — a file literally named
			// `:(top)*` must not widen this restore past the per-path iteration.
			// v0.3.56 F4: `--staged` added — restore --worktree alone leaves an
			// agent-STAGED change fully alive (worktree is restored FROM the index,
			// so the staged content stays in both). --staged --worktree reverts to
			// HEAD; the follow-up clean removes a staged-NEW file left untracked.
			const literal = `:(literal)${path}`;
			const r = spawnSync("git", ["-C", worktreePath, "restore", "--staged", "--worktree", "--", literal], { encoding: "utf8", timeout: 30_000 });
			if (r.status === 0) {
				spawnSync("git", ["-C", worktreePath, "clean", "-fd", "--", literal], { encoding: "utf8", timeout: 30_000 });
				restored.push(path);
			}
		}
	}
	return restored;
}

/** v0.3.43: basenames that must NEVER ride a phase commit (the spec-18+
 *  convention the LLM committer followed: runtime judge state + the cached
 *  runner spec are per-attempt scratch, not durable phase evidence). */
// v0.3.74 dual review F3: derived from the canonical registry (role
// `phaseCommitExcluded`) — was a sixth parallel basename literal.
const PHASE_COMMIT_EXCLUDED_BASENAMES = harnessBasenames("phaseCommitExcluded");

/** v0.3.43 throughput fix (RC4 — LLM doing deterministic work): the per-phase
 *  commit step ran an `orchestrator` agent whose ENTIRE job was `git add -A &&
 *  git commit` — measured 9 calls / 62.5 min / 179K output tokens on run
 *  2026-08-30T08-17-36 (plus one 20-min timeout that stranded a file on the AQ
 *  run). The engine already knows the phase's file set and gate results, so the
 *  commit is now engine-side and deterministic:
 *    - stage ALL worktree changes EXCEPT the runtime-scratch basenames above
 *      (spec-dir docs + ledgers ride the commit exactly like the LLM's phase
 *      convention — they are the durable evidence trail);
 *    - message is deterministic (phase name, gates, claimed/test files);
 *    - in-place runs (no dedicated worktree) and the SUPER_DEV_LLM_COMMITS=1
 *      kill-switch fall back to the orchestrator agent unchanged.
 *  Never throws; returns an honest outcome for the log. */
export function deterministicPhaseCommit(
	worktreePath: string,
	opts: { phaseIndex: number; totalPhases: number; phaseName: string; worktreeCreated?: boolean; gateSummary: string },
): { status: "committed" | "skipped" | "fallback"; sha?: string; reason: string } {
	if (superDevEnv("SUPER_DEV_LLM_COMMITS") === "1") return { status: "fallback", reason: "SUPER_DEV_LLM_COMMITS=1" };
	if (opts.worktreeCreated === false) return { status: "fallback", reason: "in-place run shares the user's checkout — refusing a whole-tree deterministic commit" };
	const git = (...args: string[]) => spawnSync("git", ["-C", worktreePath, ...args], { encoding: "utf8", timeout: 30_000 });
	// Snapshot the porcelain BEFORE staging so the exclusion set is applied to
	// the real change list (not to the staged index we are building).
	// v0.3.45: the -z reader (see porcelainEntries) — v1 lines C-quote space
	// paths on every machine and octal-escape non-ASCII on default
	// `core.quotepath=true` machines, breaking both the exclusion match and
	// the `git reset -- <path>` pathspec for quoted paths.
	const entries = porcelainEntries(worktreePath);
	if (entries.length === 0) return { status: "skipped", reason: "tree already clean — nothing to commit" };
	const committable = entries.filter((e) => {
		const base = e.path.split("/").pop() ?? e.path;
		return !PHASE_COMMIT_EXCLUDED_BASENAMES.has(base);
	});
	if (committable.length === 0) return { status: "skipped", reason: `only runtime-scratch files changed (${entries.length} entr${entries.length === 1 ? "y" : "ies"}) — nothing durable to commit` };
	const add = git("add", "-A");
	if (add.status !== 0) return { status: "fallback", reason: `git add -A failed (exit ${add.status})` };
	// Unstage the excluded basenames AFTER the sweep (pathspec magic per file —
	// cheapest precise form; a failed reset is non-fatal, the commit message
	// names the file set honestly either way). v0.3.55 security review F4:
	// `:(literal)` so an odd filename cannot redirect the reset (residual:
	// exclusion is by BASENAME anywhere in the tree, so content parked at e.g.
	// src/.judge.jsonl is excluded from commits by design — flagged by review,
	// not by git).
	for (const e of entries) {
		const base = e.path.split("/").pop() ?? e.path;
		if (PHASE_COMMIT_EXCLUDED_BASENAMES.has(base)) git("reset", "--", `:(literal)${e.path}`);
	}
	const title = `phase ${opts.phaseIndex}/${opts.totalPhases}: ${opts.phaseName}`;
	const message = [`${title}`, "", `Deterministic super-dev phase commit (v0.3.43+; engine-side, no LLM).`, ``, `Gates: ${opts.gateSummary}`, ``, `[super-dev: deterministic-phase-commit]`].join("\n");
	const commit = git("commit", "-m", message);
	if (commit.status !== 0) return { status: "fallback", reason: `git commit failed (exit ${commit.status}): ${String(commit.stderr ?? "").slice(0, 200)}` };
	const sha = git("rev-parse", "--short", "HEAD");
	return { status: "committed", sha: String(sha.stdout ?? "").trim(), reason: `${committable.length} path(s) committed` };
}

export const implementationStage: Stage = {
	id: "implementation",
	label: "Stage 9 — Implementation",
	async run(state, ctx) {
		// Defensively normalize: agents sometimes return `phases` as a string or
		// object instead of an array, which crashed `phases.entries()` (Stage 9:
		// "phases.entries is not a function"). Never trust the control shape.
		const phases = normalizePhases(state.spec?.phases);
		if (!Array.isArray(state.spec?.phases) && state.spec?.phases != null) {
			ctx.log(`Implementation: spec.phases was ${typeof state.spec.phases}, expected an array — normalized to ${phases.length} phase(s)`);
		}
		if (phases.length === 0) {
			ctx.log("Implementation: no phases defined in spec — skipping");
			return { phasesCompleted: 0, totalPhases: 0, allGreen: false };
		}
		const setup = state.setup!;
		// v0.3.57 liveness (ledger 2026-09-01, silent-zombie incident): the run's
		// dedicated worktree being removed EXTERNALLY mid-run must fail the stage
		// closed with an honest marker — never delegate children into a void that
		// then hangs awaiting responses that can never arrive.
		if ((setup as { worktreeCreated?: boolean }).worktreeCreated !== false && !existsSync(setup.worktreePath)) {
			ctx.log(`Implementation: WORKTREE GONE — ${setup.worktreePath} no longer exists (removed externally). Failing the stage closed; every delegation into it would hang or die silently. If a host process for this run is still alive, stop it, then start a fresh run or resume.`);
			return { phasesCompleted: 0, totalPhases: phases.length, allGreen: false, filesModified: [], phaseStatus: [], lastFailures: [{ phaseId: "phase-all", reasons: [`worktree removed externally: ${setup.worktreePath}`] }] };
		}
		// v0.3.79 A1 (spec-25, docs/findings/deep-analysis-2026-09-08-spec25.md):
		// plan feasibility — the plan is a program; validate it BEFORE executing
		// (the cheapest correction point; PDoctor/Turborepo precedent: check the
		// graph you actually execute, at load time). Cross-phase contradictions
		// route straight to REPLAN instead of surfacing hours later as BLOCKING
		// phase-boundary revert loops (run 2026-09-07T14-14-09-937Z: ~2h burned
		// on phase-01 of 10). Advisories surface even when no contradiction fires.
		// ADV-v0379-2: validate ONCE per run — §D re-entries must not re-derive
		// contradictions against a mid-run worktree (an incidental HEAD state
		// change could replan after work already converged; a REPLAN restart
		// gets a fresh state and re-validates in the new run).
		const feasibilityOnce = ((state as Record<string, unknown>).__planFeasibilityChecked as boolean | undefined) ?? false;
		(state as Record<string, unknown>).__planFeasibilityChecked = true;
		const feasibility = feasibilityOnce
			? { contradictions: [], advisories: [] }
			: planFeasibilityFindings(phases, setup.worktreePath);
		for (const advisory of feasibility.advisories) {
			ctx.log(`Implementation plan advisory: ${advisory.title}`);
		}
		if (feasibility.contradictions.length > 0) {
			for (const c of feasibility.contradictions) {
				ctx.log(`Implementation plan CONTRADICTION: ${c.title} — ${c.detail}`);
			}
			let planReplanned = false;
			try {
				planReplanned = await triggerReplanForFindings(state, ctx, feasibility.contradictions.map((c) => ({ file: null, severity: "high", title: c.title, detail: c.detail, ownerStage: c.ownerStage })), "implementation", setup.specIdentifier ?? "unknown");
			} catch { planReplanned = false; }
			if (planReplanned) {
				ctx.log(`Implementation: plan infeasible (${feasibility.contradictions.length} contradiction(s)) — routed to REPLAN before executing any phase`);
				return { phasesCompleted: 0, totalPhases: phases.length, allGreen: false, filesModified: [], phaseStatus: [], lastFailures: [{ phaseId: "phase-all", reasons: feasibility.contradictions.map((c) => c.title) }] };
			}
			// v0.3.85 F2 (§10 decision 3, grill pass 3): the log-and-proceed fallback
			// is overridden to HARD-FAIL for restart states carrying PENDING
			// source:"inherited-red" rows — an amended plan that still contradicts
			// the zero-LLM plan-feasibility validator after a declared handoff
			// routes Tier 3 FatalAbort naming the validator findings (no retry
			// loop). Every other restart keeps today's log-and-proceed.
			const pendingIrRows = pendingInheritedRedRows(setup.specDirectory);
			if (pendingIrRows.length > 0) {
				// FIX ROUND 1 (F-ii): the abort names the validator findings IN FULL —
				// kind + title + EVIDENCE lines (the evidence carries the clause text,
				// e.g. `P1 requireContains src/x.ts: FOO`, so the failing clause form
				// is machine-readable in the terminal reason, not just the prose title).
				const validatorFindings = feasibility.contradictions
					.slice(0, 6)
					.map((c) => `[${c.kind}] ${c.title} — evidence: ${c.evidence.join("; ")}`)
					.join(" | ");
				ctx.log(`Implementation: plan validation FAILED after an inherited-red declared handoff (${pendingIrRows.length} pending row(s): ${pendingIrRows.map((r) => r.id).join(", ")}) — routing Tier 3 FatalAbort naming the validator findings (no retry loop; v0.3.85 F2 validator override): ${validatorFindings}`);
				throw new FatalAbort(`inherited-red restart failed plan validation (v0.3.85 F2, ADR 8/9): the spec dir still carries ${pendingIrRows.length} pending source:"inherited-red" handoff row(s) (${pendingIrRows.map((r) => r.id).join(", ")}) while the amended plan contradicts the zero-LLM plan-feasibility validator — validator findings: ${validatorFindings}. A declared handoff's amended plan must pass the validator before execution; no retry loop.`);
			}
			ctx.log("Implementation: plan contradictions detected but replan unavailable (budget/marker) — proceeding with the contradictions logged");
		}
		// §D auto-iterate: carry per-phase green state + failure reasons from the
		// PRIOR convergence iteration (state.implementation holds the last run's
		// control). Green phases are skipped; a failed phase's prior reasons seed
		// its next attempt 1 so iteration 2 targets the real failures.
		const startInstructionFingerprint = runtimeInstructionFingerprint(state.setup?.specDirectory);
		const priorImpl = (state.implementation ?? {}) as { phaseStatus?: PhaseStatusEntry[]; lastFailures?: PhaseFailureEntry[]; runtimeInstructionFingerprint?: string; invalidatedByRuntimeInstructions?: boolean; runStartDirt?: string[]; phaseStartDirt?: Record<string, string[]>; phaseGuidanceReentryUsed?: Record<string, true>; inheritedRedFlakeGrantUsed?: boolean };
		const priorInstructionInvalidated = priorImpl.invalidatedByRuntimeInstructions === true || (typeof priorImpl.runtimeInstructionFingerprint === "string" && priorImpl.runtimeInstructionFingerprint !== startInstructionFingerprint);
		const priorRunStart = (Array.isArray(priorImpl.runStartDirt) ? priorImpl.runStartDirt : undefined);
		// v0.3.85 F2: per-phase FIRST-EVER porcelain snapshots (the attribution
		// boundary — see the phase-entry capture below), persisted across §D
		// convergence iterations exactly like runStartDirt (the sd26-F1 lesson:
		// a re-entry must not re-capture after this phase's own prior-iteration
		// edits hit disk, or its own live work would classify as pre-phase).
		const phaseStartDirt: Record<string, string[]> = priorInstructionInvalidated || !priorImpl.phaseStartDirt || typeof priorImpl.phaseStartDirt !== "object" ? {} : { ...priorImpl.phaseStartDirt };
		const priorGuidanceReentryUsed = (priorImpl.phaseGuidanceReentryUsed && typeof priorImpl.phaseGuidanceReentryUsed === "object") ? priorImpl.phaseGuidanceReentryUsed : undefined;
		let phaseStatus: PhaseStatusEntry[] = priorInstructionInvalidated ? [] : (Array.isArray(priorImpl.phaseStatus) ? priorImpl.phaseStatus.map((p) => ({ ...p })) : []);
		// v0.2.6 G1 (adversarial sd26-F1 + code-review sd26-CR-1): ONE run-start
		// porcelain snapshot, captured at stage entry ONLY when no prior snapshot
		// rides state.implementation, and partitioned against by EVERY phase —
		// foreign means "predates THIS RUN" (prior-run dirt on a reused worktree:
		// the mac-run class), while this run's own work (any phase's undeclared
		// edits — phases commit via an orchestrator call that stages only declared
		// files and is skipped without budget, so residue legitimately survives
		// phase boundaries) is NEVER foreign and never stashable. Persisted across
		// §D convergence iterations via the ControlObj so a re-entry does not
		// recapture after iteration 1's residue. Known limitation (sd26-CR-4,
		// documented): a process resume re-captures at the resumed invocation's
		// start, so pre-crash uncommitted work classifies foreign there — bounded
		// by G2's product fall-through (one wasted quarantine, recoverable via
		// git stash pop; durable spec-dir persistence was rejected because it
		// would also freeze the motivating prior-run-dirt class as own).
		let runStartDirt: string[] = priorRunStart ? [...priorRunStart] : listPorcelainPaths(setup.worktreePath);
		if (priorRunStart) {
			ctx.log("Implementation: reusing persisted run-start dirt snapshot from the prior convergence iteration (provenance boundary stays this run's start)");
		}
		// v0.2.6 G4 (adversarial sd26-F2): guidance-reentry grants persist per
		// phase EVER across convergence iterations.
		let phaseGuidanceReentryUsed: Record<string, true> = priorGuidanceReentryUsed ? { ...priorGuidanceReentryUsed } : {};
		let lastFailures: PhaseFailureEntry[] = priorInstructionInvalidated ? [] : (Array.isArray(priorImpl.lastFailures) ? priorImpl.lastFailures.map((f) => ({ ...f, reasons: [...f.reasons] })) : []);
		if (priorInstructionInvalidated) ctx.log("Implementation: runtime user instructions changed — invalidating prior green phase carry and re-running phases");
		if (phaseStatus.length) ctx.log(`Implementation: resuming convergence iteration (${phaseStatus.filter((p) => p.status === "green").length}/${phases.length} phases already green)`);
		let phasesCompleted = 0;
		let allGreen = true;
		// v0.3.80 B2: environment-blocked phases are judge-owned — excluded from stage-close re-verification.
		const envBlockedPhases = new Set<string>();
		// v0.3.0 (harness research): DEPRECATED — never set to true anymore. The
		// field survives on the control shape for downstream readers (workflow
		// summary, §D loop predicate) which now treat it as always-false; a failed
		// phase is recorded `partial` and the pipeline CONTINUES (never-zero).
		let convergenceBlocked = false;
		let convergenceBlockReason = "";
		const filesModified: string[] = [];
		// v0.3.85 F3 (decision 2): the run-pass wall fuse + its attempt-duration
		// estimator. ctx.wallFuse is the SAME window realAgent checks pre-call
		// (created once per runWorkflow invocation — a resumed pass gets a FRESH
		// window); bare test contexts without the surface get a stage-local fresh
		// window. attemptDurations records each completed implementer attempt's
		// wall time (pushed at the NEXT attempt's entry — exactly when the
		// trailing-3-median wind-down decision needs it), scoped to this stage run
		// so a §D re-entry re-estimates from its own attempts.
		const runFuse = ctx.wallFuse ?? freshRunWallFuseState();
		const attemptDurations: number[] = [];
		let attemptStartedAt = 0;
		let attemptDurationClosed = true;
		// v0.3.85 F2 (decision 3, D-2): the per-run Tier-1 flake-filter grant —
		// ≤1 deterministic full-gate re-run per run, NEVER consuming an
		// implementer attempt. Carried on the control so §D convergence re-entries
		// within one run share the single grant ("per run", the wall-fuse
		// per-run-pass doctrine — a resumed pass starts a fresh run and gets a
		// fresh grant). The flake TALLY itself is ledger-backed and persists
		// across resume (surfaced in the close-out report only — never a retry
		// reason).
		let inheritedRedFlakeGrantUsed = priorImpl.inheritedRedFlakeGrantUsed === true;

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
			let phaseLifecycleStarted = false;
			const emitPhaseStatus = (status: "running" | "ok" | "failed" | "skipped" | "partial") => {
				ctx.events.emit("stage", {
					id: `implementation.${phaseId}`,
					label: phaseLabel,
					status,
					kind: "phase",
					parentId: "implementation",
				});
			};
			const ensurePhaseRunning = () => {
				if (phaseLifecycleStarted) return;
				phaseLifecycleStarted = true;
				emitPhaseStatus("running");
			};
			const announceActivity = (activity?: string, detail?: string) => {
				const suffix = activity ? ` — ${activity}${detail ? ` (${detail})` : ""}` : "";
				ctx.phase(`${phaseHeadline}${suffix}`);
			};
			// Level-3 (step) dashboard rows: nested under the phase row so the
			// implementation stage shows stage → phase → step. Each step (and retry)
			// persists as its own row with its own ok/failed glyph (full audit trail).
			// `seq` disambiguates repeated step labels across attempts/retries so a new
			// row is emitted per occurrence rather than overwriting the prior one.
			let stepSeq = 0;
			const emitStep = (label: string, status: "running" | "ok" | "failed", seq: number): void => {
				ctx.events.emit("stage", {
					id: `implementation.${phaseId}.step-${pad(seq)}`,
					label: `· ${label}`,
					status,
					kind: "step",
					parentId: `implementation.${phaseId}`,
				});
			};
			/** Announce + run a phase step: emits a running level-3 row, runs `fn`,
			 *  then marks the row ok/failed by `okIf(result)`. Returns fn's result.
			 *  v0.3.58 pipelining attribution: the ENTIRE step body (announce,
			 *  lifecycle events, agent calls, delegation child lines) runs inside
			 *  runInStepScope, so every line emitted by this step's async chain is
			 *  stamped with THIS step's identity — a concurrently-running step (F3
			 *  pipelined RED review vs implementer) no longer steals the other's
			 *  lines via the global stage cursor. The raw id (no occurrence suffix)
			 *  matches emitStep's id; the extension seam resolves the display id. */
			const runStep = async <T>(label: string, detail: string | undefined, okIf: (r: T) => boolean, fn: () => Promise<T>): Promise<T> => {
				const seq = ++stepSeq;
				const stepLabel = `${label}${detail ? ` (${detail})` : ""}`;
				return runInStepScope({ stageId: `implementation.${phaseId}.step-${pad(seq)}`, stageLabel: `· ${stepLabel}` }, async () => {
					announceActivity(label, detail);
					emitStep(stepLabel, "running", seq);
					try {
						const r = await fn();
						emitStep(stepLabel, okIf(r) ? "ok" : "failed", seq);
						return r;
					} catch (err) {
						emitStep(stepLabel, "failed", seq);
						throw err;
					}
				});
			};
			/** v0.3.59 review P1 (class fix): manual step sites attribute their
			 *  emissions per-chain with the SAME identity scheme as runStep — these
			 *  sites drive announce/terminal emitStep by hand (custom okIf logic),
			 *  but their async chains MUST carry the step scope or the pipelined
			 *  inverse leak persists (implementer lines landing in the RED review's
			 *  card once the review's terminal event moves the cursor back). */
			const inStepScope = <T>(seq: number, stepLabel: string, fn: () => Promise<T>): Promise<T> =>
				runInStepScope({ stageId: `implementation.${phaseId}.step-${pad(seq)}`, stageLabel: `· ${stepLabel}` }, fn);
			const attemptDetail = (attempt: number, extra?: string) =>
				[`attempt ${attempt}`, extra].filter(Boolean).join(", ");
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
			let green = false;
			let attemptErrors: string[] = [];
			let attemptsRun = 0;
			let terminalFailureKind: "red-generation" | "implementation-gate" = "implementation-gate";
			let terminalRedTries = 0;
			let terminalStopReason: "budget" | "no-progress" | "failed" | "environment-blocked" | "phase-attempt-cap" | "phase-wall" | "wall-fuse" | "inherited-red" | "declared-handoff" | "red-weakening" = "failed";
			// v0.3.57 liveness: set when the worktree vanished under a running phase —
			// breaks the PHASE loop after this phase's partial bookkeeping (remaining
			// phases cannot run in a deleted worktree; re-probing each is pure noise).
			let worktreeGone = false;
			// Track 30 PRA (T3.2 — SCENARIO-005, AC-03): the environmental-blocker
			// one-gate-re-run budget. Per-phase hoisted state — reset each convergence
			// iteration (a later re-entry gets a fresh budget of exactly 1) and grants
			// EXACTLY ONE post-quarantine re-run; D-2: no delay-based anti-windup.
			let envBlockerRegateUsed = false;
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
			// v0.2.6 G4 — one-shot guidance re-entry grant at the env-blocker
			// boundary, PERSISTED per phase across convergence iterations
			// (adversarial sd26-F2: a per-run flag would re-grant on every re-entry,
			// making guidance-driven windup bounded only by the global agent budget).
			// The FIRST retry-with-guidance ever granted for a phase declines to trip
			// convergenceBlocked so the outer convergence loop re-enters the phase
			// and the persisted guidance reaches fresh agent calls; any later choice
			// finds the budget spent and terminal-stops.
			let envGuidanceReentryGranted = false;
			// J9-a: judge diagnosis to surface at the human boundary when it escalates.
			let redJudgeDiagnosis = "";
			// ADV-v0379-4: honest labeling — the v0.3.79 corrective floor escalates with
			// UNVERIFIED evidence (zeroed); "verified evidence" is only true for routed
			// verdicts or evidence-carrying escalates (route-not-offered).
			let redJudgeEvidenceLabel = "verified evidence";
			let attemptProgressHistory: ProgressSignature[] = [];
			// J9-b: judge diagnosis / guidance at the implementer no-progress boundary.
			let implJudgeDiagnosis = "";
			let implJudgeEvidenceLabel = "verified evidence";
			let judgeGuidance = "";
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
			const resumeNoOpAllowed = ctx.options.resume === true || typeof ctx.options.resume === "string";
			if (resumeNoOpAllowed && phaseDeliverables && deliverablesAlreadyMet(setup.worktreePath, phaseDeliverables, setup.defaultBranch) /* sweep-3 CR-R2-7 */) {
				ensurePhaseRunning();
				announceActivity("Resume verification");
				resetDeliverableCheckCache();
				announceActivity("Build gate", "resume verification");
				const gate = runBuildGate(setup.worktreePath, { gate: (state.spec?.gate) as GateOptions | undefined, signal: ctx.signal, defaultBranch: setup.defaultBranch });
				appendGateChecked(state, "phase-green:resume-verify", gate, "implementation");
				announceActivity("Deliverable check", "resume verification");
				const deliverableCheck = runDeliverableCheck(setup.worktreePath, phaseDeliverables, { signal: ctx.signal, skipTests: !(gate.pass || gate.inScopePass), defaultBranch: setup.defaultBranch });
				if ((gate.pass || gate.inScopePass) && deliverableCheck.pass) {
					ctx.log(`Implementation ${phaseId} no-op: resume deliverables already satisfied and verified — skipping implementer`);
					phaseStatusUpsert(phaseStatus, phaseId, "green");
					emitPhaseStatus("ok");
					const fi = lastFailures.findIndex((f) => f.phaseId === phaseId); if (fi >= 0) lastFailures.splice(fi, 1);
					phasesCompleted++;
					continue;
				}
				ctx.log(`Implementation ${phaseId} no-op rejected: resume verification failed (build=${gate.pass || gate.inScopePass}, missing=${deliverableCheck.missing.join("; ") || "none"}) — running implementer`);
				attemptErrors = gate.errors;
				missingDeliverables = deliverableCheck.missing;
			}
			// Pi-native sub-phase subtitle: announce WHICH phase is being implemented
			// AFTER the skip guards (so a skipped/already-green phase never flickers a
			// subtitle it isn't working on). Surfaces "Phase N/M: <name>" as the
			// dashboard header/working-message + a distinct ▶ line under the running
			// stage's live-log section. phase.name falls back to the phase id.
			// Emit the dashboard sub-stage row BEFORE the subtitle so the live-stream sink
			// tags the subtitle/progress under the current implementation phase.
			ensurePhaseRunning();
			announceActivity();
			if (tracker) tracker.begin("phase", phaseId);
			// v0.3.85 F2 (C1): the phase's FIRST-EVER porcelain snapshot — the F2
			// attribution boundary. Persisted across §D convergence iterations via
			// the control (the sd26-F1 lesson runStartDirt already pins: a re-entry
			// must not re-capture after this phase's own prior-iteration edits hit
			// disk, or its own live work would classify as pre-phase/inherited).
			// Dirt present in the first-ever snapshot is PRE-PHASE (earlier phases'
			// leftovers / prior-run state — the C1 poison class); dirt absent from
			// it appeared during THIS phase (the phase's own leak). A git failure
			// degrades to [] — unknown provenance can never support an inherited
			// classification (the safe direction is the Tier-0 own-leak ladder).
			// FIX ROUND 1 (A): the spawn is SKIPPED entirely for an absent worktree
			// (same [] degradation, zero latency) — a git spawn between the F3
			// phase-wall anchor and attempt 1 pre-empted the FIRST attempt under a
			// tiny SUPER_DEV_MAX_PHASE_WALL_MS (the wall bounds ATTEMPTS, never
			// pre-empts attempt 1).
			if (!Object.prototype.hasOwnProperty.call(phaseStartDirt, phaseId)) {
				phaseStartDirt[phaseId] = existsSync(setup.worktreePath) ? listPorcelainPaths(setup.worktreePath).map(normalizeRepoPath) : [];
			} else {
				ctx.log(`Implementation ${phaseId}: reusing persisted first-ever phase-start dirt snapshot (F2 attribution boundary stays the phase's first entry ever)`);
			}
			const phaseStartSet = new Set<string>(phaseStartDirt[phaseId] ?? []);
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
						const tddId = retries === 0
							? `pipeline.implementation.${phaseId}.tdd.a${attempt}`
							: `pipeline.implementation.${phaseId}.tdd.red${retries}.a${attempt}`;
						const tddStepSeq = ++stepSeq;
						// v0.3.73 M7 (dual review AR-73-05): the RED authoring window gets the
						// same HEAD-drift advisory as the implementer - the incident's 5d4790d
						// (implementation landed BEFORE its RED was authored) was exactly a
						// non-implementer-window self-commit shape.
						const headBeforeTdd = String(spawnSync("git", ["rev-parse", "HEAD"], { cwd: setup.worktreePath, encoding: "utf8", timeout: 5_000 }).stdout ?? "").trim();
						const tdd = await inStepScope(tddStepSeq, `TDD RED (${redTryDetail})`, async () => {
							announceActivity("TDD RED", redTryDetail);
							emitStep(`TDD RED (${redTryDetail})`, "running", tddStepSeq);
							const r = await ctx.agent({ id: tddId, agent: "tdd-guide", prompt: buildTddPrompt(setup, state.classify ?? null, phase, state.spec ?? null, [lang, rustDiscipline(setup)].filter(Boolean).join("\n\n"), state.bdd ?? null) + redHint + reauthorEvidence });
							emitStep(`TDD RED (${redTryDetail})`, r.error ? "failed" : "ok", tddStepSeq);
							return r;
						});
						try {
							const headAfterTdd = String(spawnSync("git", ["rev-parse", "HEAD"], { cwd: setup.worktreePath, encoding: "utf8", timeout: 5_000 }).stdout ?? "").trim();
							if (headBeforeTdd && headAfterTdd && headBeforeTdd !== headAfterTdd) {
								ctx.log(`Implementation ${phaseId} advisory: tdd-guide self-commit detected (HEAD ${headBeforeTdd.slice(0, 8)} -> ${headAfterTdd.slice(0, 8)} during the RED call) - commits are engine-owned; a pre-landed implementation routes through the already-satisfied verification`);
								recordConvergenceFindings(state, {
									detectedAtStage: "implementation",
									ownerStage: "implementation",
									severity: "low",
									blocking: false,
									title: `Phase ${phaseId} tdd-guide self-commit (HEAD moved mid-call)`,
									detail: `HEAD moved ${headBeforeTdd.slice(0, 8)} -> ${headAfterTdd.slice(0, 8)} during the tdd-guide RED call. Commits are engine-owned; self-commits pre-land unverified work and cost RED cycles.`,
									evidence: [headAfterTdd],
									sourceGate: "self-commit",
								}, { detectedAtStage: "implementation", ownerStage: "implementation", sourceGate: "self-commit" });
							}
						} catch { /* advisory detection only - never blocks the phase */ }
						// Reflect an agent error/timeout in the step glyph: a ✓ TDD RED next to
						// an errored call misrepresents what happened (R1 fail-closes the phase
						// regardless, but the dashboard should not show success).
						const filesRaw = (tdd.control as { testFiles?: unknown } | null)?.testFiles;
						// v0.3.16 F1 (RC-T1, run 2026-08-23T02-59-20-670Z): an agent that errored or
						// timed out produced NOTHING this try — keeping the previous try's claim
						// made the log lie ("test files=tests/screen.test.ts" next to
						// "error=timed out"), ran the oracle against a cleanup-deleted ghost file
						// ("No test files found" → misleading red-broken feedback), and poisoned
						// the next retry's hint. A non-completed agent is not a delivery: clear the
						// claim so the fail-closed branch below reports the honest cause and the
						// oracle never runs on stale state. (The legacy fallback ONLY survives for
						// the normal control-bearing path where testFiles may legitimately be
						// absent from a later control — the pre-fix echo.)
						const tddNotCompleted = Boolean(tdd.error) || tdd.control == null;
						if (tddNotCompleted) {
							testFiles = [];
						} else {
							testFiles = filesRaw == null && testFiles.length ? testFiles : normalizeStringArray(filesRaw);
							if (testFiles.length) lastClaimedTestFiles = [...testFiles];
						}
						// v0.2.9 G5: stream what tdd-guide DID (test files + its own summary),
						// so the run log shows the RED work each try, not just the oracle verdict.
						// v0.3.16 F1: the (agent did not complete) annotation makes the discard
						// visible to operators reading the log tail.
						{
							const tddSummary = String((tdd.control as { summary?: unknown } | null)?.summary ?? "").replace(/\s+/g, " ").trim();
							ctx.log(`Implementation ${phaseId} tdd-guide (try ${retries + 1})${tdd.error ? ` error=${tdd.error}` : ""}: test files=${testFiles.join(", ") || "(none)"}${tddNotCompleted ? " (agent did not complete — previous claim discarded)" : ""}${tddSummary ? ` — ${tddSummary.slice(0, 400)}` : ""}`);
						}
						announceActivity("RED oracle", redTryDetail);
						// v0.3.40 scope guard: a cached runner validated against an EARLIER
						// phase's specific test file must not judge THIS phase's tests
						// (run 2026-08-30T08-30-00-814Z phase 2: the phase-1 runner pinned
						// phase1-shell.test.mjs and the oracle read phase-1's GREEN output
						// as 'tests passed before implementation' for phase-2 engine tests
						// — false red-not-confirmed, pure retry burn). Stale scope ⇒ drop
						// the runner for this try AND the cache, so a fresh runner-discovery
						// can propose a phase-appropriate command on the next try.
						if (runnerSpec && testFiles.length && !runnerCoversTargets(runnerSpec, testFiles)) {
							ctx.log(`Implementation ${phaseId} runner-cache: cached runner does not execute this phase's test files (${testFiles.join(", ")}) — cache invalidated; runner-discovery will re-propose`);
							runnerSpec = null;
							runnerDiscoveryTried = false;
							try { rmSync(join(setup.specDirectory, "test-runner.json"), { force: true }); } catch { /* best effort */ }
						}
						redStatus = runRedCheck(setup.worktreePath, testFiles, redCheckOptions(ctx, phaseId, redDiagnostics, setup.defaultBranch, runnerSpec ?? undefined));
						ctx.log(`Implementation ${phaseId} red-oracle: ${redStatus} (ran: ${testFiles.join(",") || "n/a"})`);
						// v0.3.57 review F-E: capture NOW (post-RED, pre-implementer) so the
						// coverage gate measures verdict-time inputs. runnerSpec is null here
						// exactly when RED ran via conventions (the cache initializes it above),
						// so this never shadows a validated runner.
						if (!runnerSpec && !covConventionsSpec) covConventionsSpec = deriveConventionsRunnerSpec(setup.worktreePath, testFiles);
						redChangedFiles = setDiff(gitStatusPaths(setup.worktreePath), redBaseline);
						announceActivity("RED boundary", redTryDetail);
						let boundary = await resolveRedBoundary({ ctx, phaseId, phaseName, phase, redStatus, testFiles, changedFiles: redChangedFiles, cwd: setup.worktreePath });
						// v0.2.8 G4: re-admit judge-approved scaffolding before classifying.
						if (redScaffoldApproved.size) boundary = approveScaffoldPaths(boundary, redScaffoldApproved);
						ctx.log(`Implementation ${phaseId} RED boundary: ${boundarySummary(boundary)}`);
						// F8 (v0.3.66, incident 2026-09-04T14-45-04-784Z phase 5): the baseline was
					// snapshotted at attempt ENTRY; deliverables can land between entry and
					// oracle (sibling-phase commits, RED-authored test-file deliverables) —
					// the incident burned 3.5h in red-not-confirmed retries with every clause
					// satisfied on disk. Re-check the contract LIVE at oracle time, but only
					// when it can change the classification (oracle green, baseline false):
					// polluted-red is classified FIRST in classifyRedEvidence, so a RED-phase
					// production edit still cannot masquerade as already-satisfied, and the
					// Already-satisfied verification node re-runs build gate + deliverable
					// check deterministically before anything is accepted.
					const alreadySatisfiedNow = baselineDeliverablesSatisfied
						|| (redStatus === "green" && phaseDeliverables
							? deliverablesAlreadyMet(setup.worktreePath, phaseDeliverables, setup.defaultBranch)
							: false);
					if (!baselineDeliverablesSatisfied && alreadySatisfiedNow) {
						ctx.log(`Implementation ${phaseId} RED oracle-time deliverable re-check: satisfied (baseline was not) — routing to already-satisfied verification`);
					}
					redEvidence = classifyRedEvidence({ phaseId, attempt, redStatus, testFiles, changedFiles: redChangedFiles, boundary, redRetries: retries, alreadySatisfied: alreadySatisfiedNow, diagnostics: redDiagnostics });
						// R1 — FAIL CLOSED on an unclassifiable/absent RED when the phase is
						// SUPPOSED to have tests. `unknown-*` produces no failure reason and no
						// retry hint, so without this the implementer proceeds with NO confirmed
						// RED (and skips the assertion + review gates, which only fire on
						// red-behavior-failure). If tdd-guide errored/timed out, returned no
						// testFiles, or the runner couldn't classify — AND the phase declares
						// expected scenarios or a test deliverable — treat it as a broken RED so
						// it retries instead of silently shipping untested code.
						{
							const requiresTests = expectedScenarios.length > 0
								|| normalizeStringArray(phaseDeliverables?.requireTests).length > 0
								|| normalizeStringArray((phaseDeliverables as { requireScenarios?: unknown } | undefined)?.requireScenarios).length > 0;
							const unknownRed = redEvidence.status === "unknown-unclassified" || redEvidence.status === "unknown-no-runner";
							if (unknownRed && (requiresTests || tdd.error)) {
								const why = tdd.error
									? `the TDD agent did not complete (${tdd.error})`
									: testFiles.length === 0
										? "the TDD agent returned no test files"
										: "the RED test status could not be confirmed";
								ctx.log(`Implementation ${phaseId} RED fail-closed: ${why}; phase requires tests — retrying instead of proceeding without a confirmed RED`);
								redFailClosedUnknown = true;
								// v0.3.30 F2: keep the status HONEST — unknown stays unknown (with
								// its own red-unverified reason/hint templates). The pre-0.3.29
								// coercion to broken-test made the retry log claim "tests did not
								// compile/collect" even when 127 tests had run and 122 failed
								// (run 2026-08-28T16-09-12-785Z tries 2-3).
							redEvidence = { ...redEvidence, reason: `RED not confirmed: ${why}` };
							}
							// F9-A (v0.3.67, incident 2026-09-04T14-45-04-784Z): pi-subagents'
							// child-acceptance layer rejects an implementation-intent child that
							// completes WITHOUT file edits (MISSING_IMPLEMENTATION_MUTATION_MESSAGE,
							// LLM intent arbiter) — correct P4 enforcement: self-report is never
							// evidence. But in an already-satisfied phase a verification-only
							// completion is the CORRECT outcome (the incident's tdd-guide verified
							// both suites green on disk and edited nothing; 21 rejections, hours of
							// red-unverified retries). Route on the deterministic signal instead:
							// no-edit rejection + LIVE deliverable re-check satisfied ⇒ classify
							// green-already-satisfied; the Already-satisfied verification node
							// re-runs build gate + deliverable check before anything is accepted
							// (A1: the machine decides, never the child's own summary). Fail-closed:
							// deliverables NOT satisfied keeps today's bounded retry (with the
							// honest reason above). Precedent: no-op-is-success (Ansible changed=0,
							// Terraform no-op plan, git "Already up to date").
							if (tdd.error && isNoEditCompletion(tdd.error) && phaseDeliverables
								&& (baselineDeliverablesSatisfied || deliverablesAlreadyMet(setup.worktreePath, phaseDeliverables, setup.defaultBranch))) {
								redEvidence = {
									...redEvidence,
									status: "green-already-satisfied",
									reason: "TDD agent completed without edits (reports the phase observable already landed); live deliverable re-check satisfied — routing to already-satisfied verification",
								};
								ctx.log(`Implementation ${phaseId} RED no-edit completion + live deliverable re-check satisfied — routing to already-satisfied verification`);
							}
						}
						// v0.3.30 Layer C: the registry has no runner for this stack —
						// ONE discovery attempt before burning retries. The agent
						// PROPOSES a command under a mandatory per-test-evidence
						// contract; the harness MACHINE-VERIFIES it by executing it;
						// a validated spec is cached (spec-dir test-runner.json) and
						// threads into every later oracle run. LLM proposes, machine
						// verifies — the gate decision itself stays deterministic.
						if (redFailClosedUnknown && !runnerSpec && !runnerDiscoveryTried) {
							runnerDiscoveryTried = true;
							announceActivity("Runner discovery", redTryDetail);
							const discovery = await ctx.agent({
								id: `pipeline.implementation.${phaseId}.runner-discovery.a${attempt}.t${retries + 1}`,
								agent: "debug-analyzer",
								prompt: [
									"## Purpose",
									"Discover how to run this project's test suite so a deterministic harness can verify TDD RED/GREEN states.",
									"The harness could NOT find any recognized test runner for this repository (no package.json / go.mod / pyproject / Cargo / Gradle / Maven convention matched with a runnable test command).",
									"",
									"## Contract (MANDATORY — your proposal is machine-verified)",
									"The command you return MUST emit per-test pass/fail detail the harness can parse. Console prose NEVER classifies — the command must produce a STRUCTURED channel:",
									"- JUnit XML written to a conventional results directory (build/test-results/**, target/surefire-reports/**) — Gradle and Maven do this by default; pytest: add `--junitxml=<abs tmp path>/junit.xml`; or",
									"- TAP on stdout (lines `ok N ...` / `not ok N ...`) — node:test: `node --test --test-reporter=tap <files>`; vitest: `--reporter=tap`; or",
									"- go test JSON events: `go test -json <packages>`.",
									"The harness will EXECUTE your command once to validate it. A command that only prints prose (e.g. 'all tests passed') is REJECTED.",
									"You may run candidate commands yourself to confirm they work. Do NOT create, edit, or delete ANY file — explore, read, and run only.",
									"",
									"## Project",
									`- worktree root: ${setup.worktreePath}`,
									`- detected stack: language=${setup.language}${state.classify ? ` (${state.classify.language})` : ""}`,
									`- test files this phase expects: ${testFiles.join(", ") || "(none yet)"}`,
									"",
									"## Steps",
									"1. Inspect manifests/build files (Makefile, justfile, CMake, meson, composer, dotnet, xcodeproj, vendor scripts …) to identify the test entry point.",
									"2. Run a scoped candidate ONCE (ideally targeting one test file/class) and confirm it emits per-test pass/fail detail.",
									"3. Return the single best command (shell string; you may include quoting). Prefer deterministic, non-interactive, non-watch invocations.",
									"",
									"Output <control> JSON with: command, resultFormat.",
								].join("\n"),
								accessMode: "source-read-only",
							});
							const dControl = (discovery.control ?? {}) as { command?: unknown; cwd?: unknown; resultFormat?: unknown };
							const dCommand = typeof dControl.command === "string" ? dControl.command.trim() : "";
							if (dCommand) {
								const spec: TestRunnerSpec = {
									version: 1,
									command: dCommand,
									...(typeof dControl.cwd === "string" && dControl.cwd.trim() ? { cwd: dControl.cwd.trim() } : {}),
									resultFormat: dControl.resultFormat === "tap" || dControl.resultFormat === "junit-xml" ? dControl.resultFormat : "console",
									discoveredAt: new Date().toISOString(),
								};
								const validation = validateRunnerSpec(spec, setup.worktreePath, 180_000, ctx.signal);
								if (validation.ok) {
									runnerSpec = spec;
									writeCachedTestRunner(setup.specDirectory, spec);
									ctx.log(`Implementation ${phaseId} runner-discovery: VALIDATED agent-proposed runner (${validation.evidence}) — cached for reuse; the oracle now runs: ${spec.command}`);
								} else {
									ctx.log(`Implementation ${phaseId} runner-discovery: proposal REJECTED (${validation.evidence}) — continuing on the honest unknown path`);
								}
							} else {
								ctx.log(`Implementation ${phaseId} runner-discovery: agent returned no usable command — continuing on the honest unknown path`);
							}
						}
						// review-2 F12: a cached runner spec whose command no longer SPAWNS
						// (ENOENT-class `error` on the dynamic plan) self-heals — drop the
						// cache file and the in-memory spec so a later phase can rediscover.
						// Precise by design: only true staleness (command gone) invalidates;
						// a scoping miss ("No tests found") or unparseable output keeps the
						// cache and surfaces honestly as red-unverified instead.
						if (runnerSpec && redStatus === "unknown" && redDiagnostics.some((d) => d.error)) {
							runnerSpec = null;
							try { rmSync(join(setup.specDirectory, "test-runner.json"), { force: true }); } catch { /* best effort */ }
							ctx.log(`Implementation ${phaseId} runner-cache: cached runner failed to spawn — cache invalidated; a later phase may rediscover`);
						}
						if (redEvidence.status === "red-behavior-failure" && expectedScenarios.length > 0) {
							announceActivity("RED scenario coverage", redTryDetail);
							const coverage = await resolveTddScenarioCoverage({ ctx, cwd: setup.worktreePath, phaseId, phaseName, phase, expectedScenarios, testFiles, specControl: state.spec ?? null, bddControl: state.bdd ?? null });
							if (coverage.allCovered) {
								redEvidence = { ...redEvidence, expectedScenarios: coverage.expectedScenarios, coveredScenarios: coverage.coveredScenarios, missingScenarios: [] };
								ctx.log(`Implementation ${phaseId} RED scenario coverage PASS: ${coverage.coveredScenarios.join(", ") || "none"}`);
							} else {
								redEvidence = {
									...redEvidence,
									status: "coverage-incomplete",
									expectedScenarios: coverage.expectedScenarios,
									coveredScenarios: coverage.coveredScenarios,
									missingScenarios: coverage.missingScenarios,
									reason: coverage.summary,
								};
								ctx.log(`Implementation ${phaseId} RED scenario coverage FAIL: missing=${coverage.missingScenarios.join(", ") || "unknown"}; ${coverage.summary}`);
							}
						}
						// ── v0.3.85 F5 — RED-phase assertion ratchet (C3 fix; §9 F5, §14 ADR 10) ──
						// During RED the boundary LEGALLY admits edits to pre-existing test
						// files (the GREEN-side test-edit ban is v0.3.43) — the 09-09 phase-1
						// tdd-guide answered an "unsatisfiable RED" by gutting 3 pre-existing
						// guard suites, making the oracle green and misrouting the phase. The
						// ratchet: a pre-existing test file's assertion-surface count (F5
						// grammar, above) must NEVER decrease vs its pre-edit HEAD state.
						// Checked at ACCEPTANCE — only for tries heading to acceptance
						// (classes already rejected below revert everything anyway, and an
						// unknown that is NOT fail-closed still falls through to the
						// implementer per v0.3.30 F2's P3 contract) — so a weakened oracle
						// can NEVER reach GREEN, not even via the already-satisfied route.
						// ADR 10 (the F4/F5 asymmetry): unlike F4 — which escalates
						// IMMEDIATELY because retry is PROVABLY futile (a deterministically
						// restored lockstep test kills every later attempt) — F5 retries
						// FIRST because the corrective hint teaches a legal recoverable
						// alternative (author an independent NEW test file); escalation fires
						// only on RED-retry exhaustion or persistent weakening (below).
						const f5AlreadyRejected = redEvidence.status === "coverage-incomplete"
							|| redEvidence.status === "green-weak-test"
							|| redEvidence.status === "broken-test"
							|| redEvidence.status === "polluted-red"
							|| ((redEvidence.status === "unknown-no-runner" || redEvidence.status === "unknown-unclassified") && redFailClosedUnknown);
						if (!f5AlreadyRejected) {
							const f5Rows = preexistingTestSurfaceRows(setup.worktreePath, redChangedFiles);
							const f5Weakened = weakenedAssertionSurfaces(f5Rows);
							if (f5Weakened.length > 0) {
								redEvidence = {
									...redEvidence,
									status: "weakened-preexisting-test",
									reason: `pre-existing test assertion surface decreased: ${f5Weakened.map((w) => `${w.path} ${w.before}→${w.after}`).join(", ")}`,
									weakenedFiles: f5Weakened,
									preexistingTestFiles: f5Rows.map((r) => r.path),
								};
								ctx.log(`Implementation ${phaseId} RED assertion ratchet: REJECTED — weakened pre-existing test file(s) ${f5Weakened.map((w) => `${w.path} (${w.before}→${w.after} markers)`).join(", ")}; the pre-existing test edit(s) will be reverted, new independent test files survive`);
							}
						}
						appendImplementationEvidence(setup.specDirectory, redEvidence);
						if (redEvidence.status === "polluted-red") {
							restorePaths(setup.worktreePath, redEvidence.forbiddenFiles);
						}
						// Plan 2 Tier 1 — hollow-assertion guard: a RED sample that fails for
						// the RIGHT reason (red-behavior-failure, coverage OK) can still be
						// HOLLOW if a test file contains no recognizable assertion — a later
						// minimal impl would "pass" it without proving anything. Reject it here
						// so tdd-guide adds real assertions, routed through the SAME retry
						// machinery below (no-progress detection, restore, redHint). Cheap +
						// deterministic; weak-but-present assertions are Tier 2's job.
						let retryHint = redGenerationRetryHint(redEvidence, { failClosed: redFailClosedUnknown });
						if (!retryHint && redEvidence.status === "red-behavior-failure" && testFiles.length > 0) {
							const hollow = assertionPresenceGaps(snapshotFiles(setup.worktreePath, testFiles));
							if (hollow.length > 0) {
								ctx.log(`Implementation ${phaseId} RED hollow-assertion guard: no assertion found in ${hollow.join(", ")}`);
								redEvidence = { ...redEvidence, status: "green-weak-test", reason: `hollow RED test(s) — no assertion call found in: ${hollow.join(", ")}` };
								retryHint = `Your RED test file(s) ${hollow.join(", ")} contain no recognizable assertion (expect/assert/should/…). A test with no assertion proves nothing — a trivial implementation would make it pass. Add explicit assertions that bind each scenario's observable behavior to a concrete expected value, then re-run so the tests fail for the RIGHT reason.`;
							}
						}
						// Plan 2 Tier 2 — independent RED test-QUALITY review. Tier 1 only
						// catches TRULY hollow tests (no assertion); Tier 2 catches WEAK ones
						// (assertion present but not bound to the scenario's observable
						// behavior — e.g. asserting a stub constant, testing an implementation
						// detail, or a tautology). An INDEPENDENT reviewer (cross-model when
						// config.agentModels.code-reviewer is set — Plan 1) audits the RED test
						// cases; a WEAK verdict routes back to tdd-guide via the SAME retry
						// machinery. Runs every phase, on accepted-but-not-yet-implemented RED.
						// v0.3.53 F2: after 2 reviewer-side violations (boundary/timeout/spawn
						// failures — NOT suite evidence) the parallel review is disabled for
						// this phase; the deterministic gates carry the decision (P5).
						if (!retryHint && redEvidence.status === "red-behavior-failure" && testFiles.length > 0 && phaseReviewViolations < 2) {
							// v0.3.43 RC2 (pipelining): LAUNCH WITHOUT AWAITING — the review is
							// source-read-only and cannot conflict with the implementer (which is
							// forbidden from touching test files). The verdict is adjudicated at
							// the join site right after the implementer returns; the fail-closed
							// semantics (anything but an explicit STRONG, contradiction-free
							// verdict re-authors the RED) are preserved there verbatim.
							const review = runStep(
								"RED review", redTryDetail,
								// Fail CLOSED: the step is "ok" only on an explicit STRONG verdict.
								(r: { control?: { verdict?: unknown } | null }) => String(r?.control?.verdict ?? "").toLowerCase() === "strong",
								() => ctx.agent({
									id: `pipeline.implementation.${phaseId}.red-review.a${attempt}.t${retries + 1}`,
									agent: "code-reviewer",
									accessMode: "source-read-only",
									// v0.3.54: runs concurrently with the implementer — boundary
									// violations must QUARANTINE, not git-restore (a blind restore
									// wipes the implementer's legitimate concurrent writes to the
									// same files; live-confirmed in phase 11 of run
									// 2026-08-31T16-03-57-978Z). The join attributes and restores.
									concurrentWriter: true,
									prompt: buildRedReviewPrompt(setup, state.classify ?? null, phase, testFiles, expectedScenarios, state.spec ?? null, state.bdd ?? null),
									schema: RED_REVIEW_SCHEMA,
									// `contradictions: []` is the explicit jointly-satisfiable value;
									// it must not trigger a corrective re-prompt (Fix 1c/1d pattern).
									allowEmptyArraysFor: ["contradictions"],
								}),
							);
							redReviewInFlight = review as Promise<{ control: unknown; error?: string } | null>;
							// v0.3.51: the review is awaited only at the post-implementer join —
							// a rejection in the gap (e.g. a source-read-only boundary violation,
							// run 2026-08-31T03-25-44-485Z 16:29) sat unhandled and Node's default
							// unhandledRejection=throw killed the whole workflow with no terminal
							// marker. Mark the rejection handled NOW; the join still awaits the
							// ORIGINAL promise and rethrows the same error there.
							void redReviewInFlight.catch(() => {});
							ctx.log(`Implementation ${phaseId} RED review launched in parallel with the implementer (v0.3.43 pipelining) — verdict joins when GREEN returns`);
							// (v0.3.43: verdict adjudication moved to the post-implementer
							// join site — see "RC2 join" below. The R2 fail-closed rule and
							// the Fix 4 contradiction override are enforced there verbatim.)
						}
						// v0.3.16 F4 (RC-T4): when THIS try died of a wall-clock timeout (the tdd
						// agent itself, or the RED reviewer whose timeout blocked adjudication),
						// the next try must know that — the stock hint says "tests did not
						// compile"/"not strong" which sends the agent hunting a defect that does
						// not exist (run 02-59 phase-06: five 20-min re-explorations of the same
						// healthy material). Prefix the honest death cause + the disk state so
						// the retry can skip re-exploration.
						{
							const tddDeath = tddNotCompleted ? String(tdd.error ?? "agent produced no control object") : "";
							const reviewDeath = redEvidence.status === "review-weak" && /RED review (?:did not complete|returned no usable verdict)/i.test(String(redEvidence.reason ?? "")) ? String(redEvidence.reason ?? "") : "";
							if (tddDeath || reviewDeath) {
								// v0.3.16 review fix (code F-1 / adv F-2): probe the DISK, not the
								// (already-cleared) claim — the union of the current claim (a
								// completed agent may legitimately re-claim), the files the RED
								// phase actually touched this try (redChangedFiles — a timed-out
								// agent may still have written before dying), and nothing else.
								// Deduped so the hint names each existing file exactly once.
								const claimedNow = tddNotCompleted ? [] : [...testFiles];
								const onDisk = [...new Set([...claimedNow, ...lastClaimedTestFiles, ...redChangedFiles])]
									.filter((f) => { try { return existsSync(resolve(setup.worktreePath, f)); } catch { return false; } });
								const timeoutHint = [
									`\n\n## PREVIOUS TRY DIED AT THE WALL CLOCK — do not re-explore`,
									tddDeath ? `- Your previous run ended with: ${tddDeath}. You ran out of TIME, not correctness.` : "",
									reviewDeath ? `- Your tests were written but the independent review never completed (${reviewDeath}). The file was PRESERVED on disk — it was never adjudicated.` : "",
									`- Disk state now: ${onDisk.length ? `${onDisk.join(", ")} exist(s)` : "no claimed test file exists on disk"}.`,
									"- Skip re-exploration of material you already read (the summary above stands). Write/fix the test file FIRST, run the scoped test once, then call structured_output. If time runs short, prioritize: file on disk > one verification run > structured_output.",
								].filter(Boolean).join("\n");
								// v0.3.16 review fix (adv F-1): on an agent-death try the stock
								// broken/green templates MISLEAD ("tests did not compile" when the
								// file never existed this try). Keep diagnostics; drop the template
								// when the agent (not the tests) died. A review-death try keeps its
								// template only when it carries real verdict content — the preserved
								// file still needs the stock guidance then.
								const stockHint = tddDeath ? redDiagnosticsPrompt(redEvidence.diagnostics) : (retryHint ?? "");
								retryHint = timeoutHint + stockHint;
							}
						}
						// F9-A: green-already-satisfied is a MACHINE decision (live
						// deliverable re-check passed) — an agent-death retry hint must not
						// override it back into the retry loop; the Already-satisfied
						// verification node adjudicates deterministically.
						if (retryHint && redEvidence.status !== "green-already-satisfied") {
							const signature = redEvidenceSignature(redEvidence);
							// Cycle/oscillation detection (RC-3): the previous check only
							// compared the IMMEDIATELY-previous signature, so an A→B→A→B
							// livelock (e.g. red-not-confirmed ↔ red-polluted) evaded it and ran
							// for dozens of retries / hours. Stop when EITHER (a) this exact
							// signature has already been seen this phase (a cycle — the loop is
							// revisiting a state it cannot escape), OR (b) a hard retry ceiling
							// is hit (belt-and-braces against a non-repeating drift the signature
							// hashing might miss). Both are "no-progress": the RED phase is not
							// converging and further blind retries only burn budget.
							const seenBefore = redProgressHistory.includes(signature);
							const hitCeiling = retries + 1 >= MAX_RED_RETRIES;
							redProgressHistory.push(signature);
							if (seenBefore || hitCeiling) {
								// ── v0.3.85 F5 escalation (§9 F5, §14 ADR 8/10) — deterministic-first ──
								// RED-retry exhaustion (hitCeiling) OR persistent weakening
								// (seenBefore — the same weakened signature recurred): the ratchet
								// rejection rides the declared-handoff circuit with a DISTINCT
								// source:"red-weakening" tag, consuming ONE round of the shared
								// SUPER_DEV_MAX_REPLAN_ROUNDS pool — ADR 8's FOURTH consumer, with
								// NO inherited-red sub-cap (it never touches countInheritedRedRows).
								// Deterministic scoped cleanup runs FIRST (F2 Tier-0-at-exhausted-
								// budget doctrine: cleanup is deterministic, no agent call; the
								// surviving new test files stay on disk for the restart). Unroutable
								// (pool exhausted / marker already set / ledger write failure) falls
								// through to the existing judge + HITL path with the honest evidence.
								if (redEvidence.status === "weakened-preexisting-test" && !replanPending(state) && !runFuse.tripped) {
									restoreUnacceptedRedChanges(ctx, setup.worktreePath, phaseId, redEvidence.preexistingTestFiles ?? []);
									const f5WeakenedDetail = (redEvidence.weakenedFiles ?? []).map((w) => `${w.path} ${w.before}→${w.after}`).join(", ") || String(redEvidence.reason ?? "unknown");
									const f5Finding: Record<string, unknown> = {
										id: `red-weakening-${phaseId}`,
										file: redEvidence.weakenedFiles?.[0]?.path ?? null,
										severity: "high",
										title: `RED-phase assertion ratchet exhausted at ${phaseId}: pre-existing test surface weakened after ${retries + 1} RED tries`,
										detail: `The RED loop rejected ${retries + 1} tries because pre-existing test file(s) lost assertion surface (F5 grammar: test(/it(/assert/expect/SCENARIO): ${f5WeakenedDetail}. The corrective hint — author an independent NEW test file — did not land, so the work apparently REQUIRES weakening a frozen suite, which is a spec amendment: the declared route. Pre-existing test edits were reverted; surviving new test files stay on disk.`,
										ownerStage: "spec",
										source: RED_WEAKENING_SOURCE,
										sourcePhase: phaseId,
										recommendation: "Amend the spec/plan to declare the pre-existing suite's amendment (co-ownership in any clause form counts, or a phase that owns the atomic test change), so the RED can be authored without weakening the frozen guards.",
									};
									let f5Routed = false;
									try { f5Routed = await triggerReplanForFindings(state, ctx, [f5Finding], "implementation-red", setup.specIdentifier ?? "unknown"); } catch { f5Routed = false; }
									if (f5Routed) {
										terminalStopReason = "red-weakening";
										attemptErrors = [...attemptErrors, `red-weakening: pre-existing test assertion surface decreased (${f5WeakenedDetail}) after ${retries + 1} RED tries — declared handoff routed (source:red-weakening, sourcePhase:${phaseId}); the run ends status "replan"`];
										ctx.log(`Implementation ${phaseId} F5 red-weakening escalation: ${seenBefore ? `persistent weakening (the same weakened signature recurred after ${retries + 1} tries)` : `RED retries exhausted (${retries + 1} tries)`} — replan-requests.json row routed via the shared replan pool (source:red-weakening, sourcePhase:${phaseId}, ownerStage:spec; NO inherited-red sub-cap); the phase ends partial (red-weakening) and the run ends status "replan"`);
										break;
									}
									ctx.log(`Implementation ${phaseId} F5 red-weakening escalation: declared handoff UNAVAILABLE (replan pool exhausted / marker set / ledger write failure) — falling through to the judge + human boundary with the ratchet evidence`);
								}
								// J9-a (judge routing layer): one verified diagnosis before the
								// human boundary. A routed re-author-tests / fix-environment restarts
								// the RED loop with the diagnosis appended (bounded by the judge's
								// per-signature budget of 2, so the third identical stall escalates);
								// escalate-now / discarded / degraded falls through to today's HITL.
								const judgeOut = await runJudge(ctx, {
									scope: `stage9.red-no-progress.${phaseId}`,
									signature,
									worktreePath: setup.worktreePath,
									specDirectory: setup.specDirectory,
									context: [
										`## RED evidence (attempt ${attempt}, retry ${retries + 1})`,
										`status: ${redEvidence.status}`,
										`reasons: ${redEvidenceFailureReasons(redEvidence).join("; ") || redEvidence.reason || "n/a"}`,
										`test files: ${testFiles.join(", ") || "n/a"}`,
										"## Oracle output tails",
										...(redEvidence.diagnostics ?? []).map((d) => `[${d.plan.argv.join(" ")} exit=${d.exitCode ?? "?"}] ${d.outputTail.slice(0, 2000)}`),
										"## TDD agent's last text (tail)",
										(tdd?.text ?? "").slice(-2000) || "(none)",
										"## Files changed during RED",
										redChangedFiles.join("\n") || "(none)",
									].join("\n"),
									allowedRoutes: (() => {
								const base = ["re-author-tests", "fix-environment", "replan-upstream", "allow-scaffold"] as const;
								const restricted = restrictRedJudgeRoutes(redJudgeRoutes, base);
								if (restricted.length < base.length) ctx.log(`Implementation ${phaseId} red judge routes capped: ${redJudgeRoutes} routed intervention(s) without green — forcing fix-environment (stop resampling, start diagnosing the environment)`);
								return restricted;
							})(),
									outputTails: [...(redEvidence.diagnostics ?? []).map((d) => d.outputTail), tdd?.text ?? ""],
								});
								if (judgeOut.status === "routed") redJudgeRoutes++;
								// v0.2.8 G4 (allow-scaffold): the judge read the spec + the changed
								// files and blessed them as declaration-only scaffolding the test
								// needs to compile and still fail RED. Re-admit those paths through
								// the boundary and restart the RED loop; the oracle remains the guard
								// (the test must still be `red` next try). Bounded by the judge's
								// per-signature budget.
								if (judgeOut.status === "routed" && judgeOut.verdict.route === "allow-scaffold") {
									for (const f of redChangedFiles) redScaffoldApproved.add(f);
									redProgressHistory.length = 0;
									retries++;
									redHint = `\n\n## Judge approved your scaffolding (allow-scaffold)\n${judgeOut.verdict.diagnosis}\nKeep the declaration-only scaffolding you created (do NOT implement the behavior); make the test COMPILE and still FAIL on its assertion (a valid RED). Evidence: ${judgeOut.verdict.evidence.map((e) => `${e.file}: ${e.quote}`).join(" | ")}`;
									ctx.log(`Implementation ${phaseId} judge route=allow-scaffold: approved declaration-only scaffolding (${redChangedFiles.length} path(s)) — re-admitting through the RED boundary; oracle still guards`);
									continue;
								}
								// v0.2.8 G1 (replan-upstream, run 2026-08-19T08-32-47-962Z): the judge
								// determined the RED cannot be made strong because an UPSTREAM artifact
								// is defective (an AC referencing a non-existent code baseline; a spec
								// citing a non-existent scenario/AC). Route it back to the owning stage
								// via the replan circuit — the run ends `replan` and auto-resumes at
								// requirements/bdd/spec. Not routable / budget exhausted ⇒ fall through
								// to today's HITL with the diagnosis. Never throws.
								if (judgeOut.status === "routed" && judgeOut.verdict.route === "replan-upstream") {
									const finding = {
										id: `red-replan-${phaseId}`,
										title: `RED cannot converge — upstream artifact defect (phase "${phaseName}")`,
										detail: judgeOut.verdict.diagnosis,
										severity: "high",
										recommendation: judgeOut.verdict.evidence.map((e) => `${e.file}: ${e.quote}`).join(" | "),
										file: judgeOut.verdict.evidence[0]?.file,
									};
									let replanned = false;
									// M5 documented exception: this finding carries NO structured
									// ownerStage — the owner is resolved by the replan LEAD (an LLM
									// call), which the deterministic inline planner cannot serve.
									// The emulation survives here (and for genuine cross-run
									// interruptions) while every owner-addressable site routes inline.
									try { replanned = await triggerReplanForFindings(state, ctx, [finding], "implementation-red", setup.specIdentifier ?? "unknown"); } catch { replanned = false; }
									if (replanned) {
										redJudgeDiagnosis = `${judgeOut.verdict.diagnosis}\nEvidence: ${finding.recommendation}`;
										terminalStopReason = "no-progress";
										ctx.log(`Implementation ${phaseId} judge route=replan-upstream: routed the upstream-artifact defect back via REPLAN — the run will revise the owning stage and re-enter — ${judgeOut.verdict.diagnosis.slice(0, 200)}`);
										break;
									}
									ctx.log(`Implementation ${phaseId} judge route=replan-upstream: no routable owner / replan budget exhausted — falling through to the human boundary with the diagnosis`);
								}
								if (judgeOut.status === "routed" && (judgeOut.verdict.route === "re-author-tests" || judgeOut.verdict.route === "fix-environment")) {
									// v0.3.30 F3 (run 16-09-12 try 4): one fix-environment restart is
									// granted for genuinely in-repo environment repairs; a SECOND
									// fix-environment verdict means the fix is outside the RED loop's
									// reach (typically harness-side) — terminate honestly instead of
									// another blind restart that burns budget and tempts the agent to
									// hunt the harness's own source outside the worktree.
									if (judgeOut.verdict.route === "fix-environment" && redEnvRestarts >= MAX_RED_ENV_RESTARTS) {
										redJudgeDiagnosis = `${judgeOut.verdict.diagnosis}\nEvidence: ${judgeOut.verdict.evidence.map((e) => `${e.file}: ${e.quote}`).join(" | ")}`;
										terminalStopReason = "environment-blocked";
										ctx.log(`Implementation ${phaseId} RED generation stopped — environment-blocked: ${redEnvRestarts} fix-environment restart(s) granted without progress; the fix is outside the RED loop's reach — ${judgeOut.verdict.diagnosis.slice(0, 200)}`);
										break;
									}
									if (judgeOut.verdict.route === "fix-environment") redEnvRestarts++;
									redProgressHistory.length = 0;
									retries++;
									redHint = `\n\n## Judge diagnosis (verified evidence — act on it)\n${judgeOut.verdict.diagnosis}\n${judgeOut.verdict.route === "fix-environment" ? "The judge classified this as an ENVIRONMENT problem. Repair it INSIDE this worktree only (install dependencies, fix toolchain/config files that live in this repository), then author the RED test. If the fix requires anything OUTSIDE this repository (a capability the harness itself lacks), do NOT hunt for, read, or modify external files — state the limitation in your result and stop; the harness will escalate." : "The judge classified the RED tests themselves as contradictory or unsatisfiable: re-author the affected tests into a satisfiable form that still pins the same behavior."}\nEvidence: ${judgeOut.verdict.evidence.map((e) => `${e.file}: ${e.quote}`).join(" | ")}`;
									ctx.log(`Implementation ${phaseId} judge route=${judgeOut.verdict.route}: restarting RED with the diagnosis`);
									continue;
								}
								if (judgeOut.status === "routed" || judgeOut.status === "escalate") {
									redJudgeDiagnosis = `${judgeOut.verdict.diagnosis}\nEvidence: ${judgeOut.verdict.evidence.map((e) => `${e.file}: ${e.quote}`).join(" | ")}`;
					redJudgeEvidenceLabel = judgeOut.status === "escalate" && judgeOut.verdict.evidence.length === 0 ? "escalated — evidence unverified" : "verified evidence";
								}
								terminalStopReason = "no-progress";
								const why = seenBefore
									? `RED generation is oscillating (a prior failure state recurred) after ${retries + 1} tries`
									: `RED generation did not converge within ${MAX_RED_RETRIES} tries`;
								ctx.log(`Implementation ${phaseId} RED generation stopped — ${why}: ${redEvidenceFailureReasons(redEvidence).join("; ") || redEvidence.reason || redEvidence.status}`);
								// HITL escalation (parity with the implementation no-progress path):
								// a non-converging RED is usually a spec/toolchain problem (e.g. no
								// test runner for the package), not something more retries fix.
								const escalate = (ctx as { options?: { escalate?: import("../types.ts").Escalate } }).options?.escalate;
								if (escalate) {
									try {
										const { runEscalation, applyRetryDecision } = await import("../escalation.ts");
										const failure: import("../types.ts").EscalationFailure = {
											kind: "stagnation",
											stage: "implementation-red",
											message: `RED test generation for phase "${phaseName}" is not converging (${why}). This is typically a spec or test-toolchain issue — e.g. the target package has no runnable test command, so a new test cannot be observed to fail. Inspect the recurring RED evidence or provide guidance before retrying.${redJudgeDiagnosis ? `\n\nJUDGE DIAGNOSIS (${redJudgeEvidenceLabel}):\n${redJudgeDiagnosis}` : ""}`,
											severity: "soft",
											findings: (redEvidenceFailureReasons(redEvidence).length ? redEvidenceFailureReasons(redEvidence) : [redEvidence.reason ?? redEvidence.status]).slice(0, 12).map((r) => ({ file: null, severity: null, title: r })),
											worktreePath: setup.worktreePath,
											specDirectory: setup.specDirectory,
										};
										const decision = await runEscalation(state, failure, escalate);
										if (decision) {
											applyRetryDecision(state, decision, { worktreePath: setup.worktreePath, specDirectory: setup.specDirectory });
											if (decision.choice === "retry-with-guidance" && ctx.budget.check()) {
												// Guided retry: clear the cycle window so the guided attempt is
												// judged fresh, and re-prompt with the user's guidance.
												redProgressHistory.length = 0;
												retries++;
												redHint = retryHint;
												ctx.log(`Implementation ${phaseId} RED no-progress escalation: retrying with user guidance`);
												continue;
											}
										}
									} catch { /* never-throw: fall through to the terminal break */ }
								}
								break;
							}
							// RC8: review-weak evidence must ALSO restore the rejected RED
							// files before re-authoring (previously rode green-weak-test).
							// v0.3.16 F2 (RC-T2): a review that never RAN must not count as a verdict
							// against the artifact. When the review-weak reason is the agent-error/
							// timeout template ("RED review did not complete (...)" — the reviewer
							// timed out or errored, control=no), the test file is preserved on disk:
							// it was never adjudicated, the retry hint already names the review
							// infrastructure failure, and deleting it forces the next try to rewrite
							// from scratch (run 02-59 try 1 wrote a good file, its review timed out at
							// 480s, cleanup deleted the file, and every later try fought a ghost).
							const reviewNeverRan = redEvidence.status === "review-weak" && /RED review (?:did not complete|returned no usable verdict)/i.test(String(redEvidence.reason ?? ""));
							if (!reviewNeverRan && (redEvidence.status === "green-weak-test" || redEvidence.status === "review-weak" || redEvidence.status === "polluted-red")) {
								restoreUnacceptedRedChanges(ctx, setup.worktreePath, phaseId, redEvidence.changedFiles);
							} else if (redEvidence.status === "weakened-preexisting-test") {
								// v0.3.85 F5: SCOPED revert — pre-existing test-file edits ONLY.
								// The corrective route is an independent NEW test file, so the new
								// files SURVIVE the revert (salvageability, Group 3's non-destructive
								// Tier-0 doctrine) — the full changedFiles revert above would
								// `git clean` them away and force the next try to rewrite from
								// scratch (the v0.3.16 F2 ghost-file lesson).
								restoreUnacceptedRedChanges(ctx, setup.worktreePath, phaseId, redEvidence.preexistingTestFiles ?? []);
							} else if (reviewNeverRan) {
								ctx.log(`Implementation ${phaseId} RED cleanup SKIPPED: the review did not complete (no verdict was rendered) — preserving the written test file(s) on disk for the retry`);
							}
							retries++;
							redHint = retryHint;
							ctx.log(`Implementation ${phaseId} RED generation retry ${retries}: ${redEvidenceFailureReasons(redEvidence).join("; ") || redEvidence.reason || redEvidence.status}`);
							continue;
						}
						break;
					}
					// v0.3.85 F5: a ROUTED red-weakening handoff ends the phase partial with
					// the NAMED reason — bypass the unaccepted-RED terminal block below (its
					// full changedFiles revert would destroy the surviving new test files,
					// and its reason overwrite would bury the handoff row; the scoped revert
					// already ran at the escalation site).
					if (redEvidence && terminalStopReason === "red-weakening") {
						terminalFailureKind = "red-generation";
						terminalRedTries = retries + 1;
						break;
					}
					if (!redEvidence) {
						attemptErrors = ["red-generation: no RED evidence produced"];
						terminalFailureKind = "red-generation";
						terminalRedTries = 0;
						ctx.log(`Implementation ${phaseId} RED generation failed after 0 tries`);
						break;
					}
					if (redEvidence.status === "green-already-satisfied") {
						resetDeliverableCheckCache();
						announceActivity("Already-satisfied verification", attemptDetail(attempt));
						announceActivity("Build gate", attemptDetail(attempt));
						const gate = runBuildGate(setup.worktreePath, { gate: (state.spec?.gate) as GateOptions | undefined, signal: ctx.signal, defaultBranch: setup.defaultBranch });
						appendGateChecked(state, "phase-green:already-satisfied", gate, "implementation");
						announceActivity("Deliverable check", attemptDetail(attempt));
						const deliverableCheck = runDeliverableCheck(setup.worktreePath, phaseDeliverables ?? {}, { signal: ctx.signal, skipTests: !(gate.pass || gate.inScopePass), defaultBranch: setup.defaultBranch });
						ctx.log(`Implementation ${phaseId} RED already-satisfied: build=${gate.pass || gate.inScopePass}, deliverables=${deliverableCheck.pass}`);
						if ((gate.pass || gate.inScopePass) && deliverableCheck.pass) {
							green = true;
							phaseStatusUpsert(phaseStatus, phaseId, "green");
							emitPhaseStatus("ok");
							const _gfi = lastFailures.findIndex((f) => f.phaseId === phaseId); if (_gfi >= 0) lastFailures.splice(_gfi, 1);
							break;
						}
						attemptErrors = gate.errors;
						missingDeliverables = deliverableCheck.missing;
						ctx.log(`Implementation ${phaseId} RED already-satisfied verification FAIL: ${[...attemptErrors, ...missingDeliverables.map((e) => `deliverable: ${e}`)].join("; ") || "phase gates unmet"}`);
						break;
					}
					// v0.3.30 F2: unknown (red-unverified) evidence is only a TERMINAL
					// failure when the fail-closed guard engaged (the phase requires
					// tests). Otherwise the P3 contract holds: unknown falls through to
					// the implementer with an unconfirmed-RED advisory, no stall.
					const redFailures = redEvidenceFailureReasons(redEvidence).filter((r) => redFailClosedUnknown || !r.startsWith("red-unverified:"));
					if (redFailures.length) {
						restoreUnacceptedRedChanges(ctx, setup.worktreePath, phaseId, redEvidence.changedFiles);
						attemptErrors = redFailures;
						terminalFailureKind = "red-generation";
						terminalRedTries = retries + 1;
						if (terminalStopReason !== "no-progress" && terminalStopReason !== "environment-blocked") terminalStopReason = ctx.budget.check() ? "failed" : "budget";
						ctx.log(`Implementation ${phaseId} RED generation stopped after ${retries + 1} tries${terminalStopReason === "no-progress" ? " (no progress)" : terminalStopReason === "budget" ? " (budget exhausted)" : terminalStopReason === "environment-blocked" ? " (environment-blocked)" : ""}`);
						ctx.log(`Implementation ${phaseId} RED gate FAIL: ${redFailures.join("; ")}`);
						ctx.log(redEvidenceLogLine(redEvidence));
						break;
					}
					acceptedRed = { status: redStatus, testFiles: [...testFiles], changedFiles: [...redChangedFiles] };
				// A freshly (re)accepted RED consumed any prior challenge evidence —
				// clear it so a later UNRELATED re-author does not carry stale proof.
				reauthorEvidence = "";
					// Capture the confirmed RED test contents once; persisted across GREEN
					// attempts via the hoisted redTestSnapshot so a later GREEN edit to a
					// test file is detectable on every retry, not only this attempt.
					if (redStatus === "red" && testFiles.length > 0) redTestSnapshot = snapshotFiles(setup.worktreePath, testFiles);
				}
				const redTargetsExist = Array.from(redTestSnapshot.values()).some((content) => content !== null);
				const confirmedRedTargets = redStatus === "red" && testFiles.length > 0 && (redChangedFiles.length > 0 || redTargetsExist);
				// Feed the previous attempt's REAL build/test errors into this attempt
				// so the implementer fixes the specific failures instead of resampling,
				// and surface the verified RED status so the green-phase agent knows
				// whether the tests are CONFIRMED-red or unverified.
				const basePrompt = buildImplementPrompt(setup, state.classify ?? null, phase, specialist.value, state.spec ?? null);
				const implParts: string[] = [basePrompt];
				if (judgeGuidance) {
					implParts.push(judgeGuidance);
					judgeGuidance = "";
				}
				if (redWeaknessAdvisory) {
					implParts.push(`\n## RED review advisory\n${redWeaknessAdvisory}`);
					redWeaknessAdvisory = "";
				}
				// Forceful, prominent retry feedback when the PRIOR attempt edited a
				// confirmed RED test file during GREEN (a contract violation — even a
				// comment-only edit is detected and restored). Placed FIRST so the
				// implementer sees it before any other retry guidance.
				if (attemptErrors.some((e) => e.startsWith("tdd-tests-modified-during-green"))) {
					implParts.push(implementationRetrySection("STOP editing the test files — they are READ-ONLY during GREEN", {
						phase: phaseId,
						attempt,
						gate: "post-red-oracle",
						location: "confirmed RED test files",
						observed: "the previous GREEN attempt EDITED one or more confirmed RED test files. Any change — even a comment or header — is rejected and was RESTORED from the confirmed RED snapshot, so the edit had no effect.",
						expected: "the confirmed RED test files remain byte-for-byte unchanged; only production/source code is modified",
						missing: [],
						nextAction: "Do NOT create, edit, or modify ANY test file — not even a comment, import, or header. The test files are the frozen RED oracle that judges your implementation. Implement ONLY production/source code (the module under test) to make the existing tests pass. If a test looks stale or wrong, that is the RED phase's job — leave the test file untouched.",
					}));
				}
				// v0.3.85 F2 Tier 0: the previous attempt's own-leak revert — the retry
				// must know the undeclared out-of-scope edit was rolled back and that
				// the fix belongs INSIDE the declared scope (the declared-amendment
				// route is the escape for genuinely-needed scope changes).
				if (attemptErrors.some((e) => e.startsWith("inherited-red-own-leak-reverted:"))) {
					const reverted = attemptErrors.filter((e) => e.startsWith("inherited-red-own-leak-reverted:")).map((e) => e.slice("inherited-red-own-leak-reverted:".length).trim());
					implParts.push(implementationRetrySection("Out-of-scope own-leak REVERTED (inherited-red Tier 0)", {
						phase: phaseId,
						attempt,
						gate: "inherited-red-tier0",
						location: "undeclared out-of-scope edits",
						observed: `the engine reverted ${reverted.length} undeclared out-of-scope path(s): ${reverted.join(", ")} — an out-of-scope subject that passes at baseline broke, and with a tree clean at phase start the break is attributable to this phase's own edits`,
						expected: "only the phase's declared clause files (and the confirmed RED test files) change",
						missing: reverted,
						nextAction: "Redo the fix INSIDE the declared scope. If an out-of-scope file genuinely must change, that is a declared amendment (spec change) — report it as a blocker in your summary instead of editing the file.",
					}));
				}
				// v0.3.0 budget reminder (Codex rollout_budget / alatirok model): the
				// budget is MODEL-VISIBLE context, not a hidden fuse — from attempt 2
				// the implementer sees its attempt number, the repeating failure
				// signatures, and the explicit instruction to change strategy when
				// evidence repeats. (Placed after the RED-violation warning, which is
				// documented as FIRST — review code-F6.)
				if (attempt >= 2) {
					const recentSigs = attemptProgressHistory.slice(-2).map((h) => h.failure.slice(0, 140));
					implParts.push(`\n## Attempt budget — attempt ${attempt}\nThis is your attempt #${attempt} for this phase; attempts are budget-limited.${recentSigs.length ? `\nPrevious failure signatures (most recent last):\n${recentSigs.map((x) => `- ${x}`).join("\n")}` : ""}\nIf the evidence above repeats your last failure, DO NOT retry the same strategy — diagnose the root cause, or report the blocker explicitly in your summary (testDefects) instead of burning the remaining budget.`);
				}
				// v0.3.43 RC3 (continuation): retries used to cold-restart — a fresh
				// implementer re-read the whole repo while its predecessor's finished
				// work sat invisible on disk (measured: 24 implementer calls for 6
				// phases on run 2026-08-30T08-30-00; the post-timeout attempts that
				// finished in 2-4 min were the ones that happened to notice the disk
				// state). Surface the prior attempts' ACTUAL on-disk progress so the
				// next attempt continues instead of re-deriving.
				if (attempt >= 2) {
					const priorProgress = Array.from(gitStatusPaths(setup.worktreePath))
						.filter((p0: string) => !isHarnessBookkeepingPath(p0) && !runStartDirt.includes(p0) && !testFiles.includes(p0) && !(acceptedRed?.changedFiles ?? []).includes(p0));
					if (priorProgress.length > 0) {
						implParts.push(`\n## PRIOR ATTEMPT PROGRESS — continue, do NOT restart\n${priorProgress.length} production path(s) are ALREADY modified/created on disk by your predecessor attempt(s):\n${priorProgress.slice(0, 24).map((p0) => `- ${p0}`).join("\n")}${priorProgress.length > 24 ? `\n- … (+${priorProgress.length - 24} more)` : ""}\nInspect THESE FIRST with targeted reads (head/diff), then finish or fix the remaining gate failures. Do NOT re-derive the design or rewrite files that already carry your predecessor's work — your job is to COMPLETE the phase, not redo it. Files not in this list are unchanged and need no re-reading.`);
					}
				}
				// §D: seed attempt 1 with the PRIOR convergence iteration's failure reasons
				// so re-attempts target the real failures instead of resampling.
				if (attempt === 1) {
					const priorFail = lastFailures.find((f) => f.phaseId === phaseId);
					if (priorFail?.reasons.length) {
						implParts.push(implementationRetrySection("Prior convergence-iteration failures — fix these", {
							phase: phaseId,
							attempt,
							gate: "prior-convergence-iteration",
							location: "previous implementation convergence pass",
							observed: "this phase failed in the prior convergence pass",
							expected: "phase reaches green with build, deliverable, change, symbol, and post-RED gates satisfied",
							missing: priorFail.reasons,
							nextAction: "Fix these carried-forward blockers before reporting implementation complete.",
						}));
					}
				}
				if (attemptErrors.filter((e) => !/^deliverable:\s*missing (test|scenario):/i.test(e)).length) {
					implParts.push(implementationRetrySection("Previous attempt failed the build/test gate — fix these", {
						phase: phaseId,
						attempt,
						gate: "implementation-gates",
						location: "previous GREEN attempt",
						observed: "the prior implementation attempt did not satisfy all phase gates",
						expected: "all deterministic build/test and phase gates pass",
						// Exclude `deliverable: missing test:` — the implementer is forbidden
						// from authoring RED tests; those route back to RED regeneration, so
						// asking for them here is the forbidden action (deadlock root cause).
						missing: attemptErrors.filter((e) => !/^deliverable:\s*missing (test|scenario):/i.test(e)),
						nextAction: "Make a targeted code or test-support change for these exact failures, then run the relevant checks before calling structured_output.",
					}));
				}
				// AND-semantics (AC-03 → SCENARIO-012): when a previous attempt was
				// build-green but its DELIVERABLE CONTRACT was unmet, the exhaustive
				// `missing` list is injected here so the implementer creates the files /
				// does the wiring / adds the named tests instead of resampling.
				if (missingDeliverables.filter((e) => !/^missing (test|scenario):/i.test(e)).length) {
					implParts.push(implementationRetrySection("Deliverables still missing — create/wire these", {
						phase: phaseId,
						attempt,
						gate: "deliverable-check",
						location: "phase deliverable contract",
						observed: "the prior attempt built but did not satisfy declared non-test deliverables",
						expected: "every required file, pattern, and forbidden-pattern removal exists in the owning module",
						missing: missingDeliverables.filter((e) => !/^missing (test|scenario):/i.test(e)),
						nextAction: "Create, wire, or rename the missing deliverables directly. Do NOT create or edit test files — required tests are authored by the RED phase. Do not claim completion until this list is empty.",
					}));
				}
				// spec-11 AC-07 (SCENARIO-015): a previous attempt claimed a file git did
				// NOT show changed — feed the specific paths so the implementer actually
				// creates/wires them instead of resampling. Mirrors the deliverables block
				// above and is bounded by the global run budget plus no-progress detection
				// in the surrounding attempt loop.
				// v0.3.49: a previous attempt was green on every other gate but BELOW the
				// coverage hard floor — inject the exact per-file numbers so the
				// implementer writes targeted tests for the uncovered behavior instead
				// of resampling. Test files are exempt (they are authored by RED, and
				// the phase's production files are what the floor gates).
				if (coverageGap.length) {
					implParts.push(implementationRetrySection("Coverage below the hard floor — add tests for uncovered behavior", {
						phase: phaseId,
						attempt,
						gate: "phase-coverage",
						location: "deterministic coverage measurement on phase production files",
						observed: "the previous attempt passed every functional gate but the measured line coverage is below the hard floor",
						expected: `≥${coverageThreshold()}% lines across the phase's production files (aim for 100% on pure logic)`,
						missing: coverageGap,
						nextAction: "Write additional unit tests for the UNCOVERED behavior in the listed files (new test files you author in THIS retry are allowed and expected — unlike RED tests, coverage tests are additive). Do NOT weaken or delete existing assertions to raise the number.",
					}));
				}
				if (claimedNotChanged.length) {
					implParts.push(implementationRetrySection("Claimed changes not present in git — actually create/wire these", {
						phase: phaseId,
						attempt,
						gate: "change-check",
						location: "git actual-vs-claimed change set",
						observed: "the implementer claimed files that git did not show as changed",
						expected: "claimed files are actually created, modified, or deleted in the worktree",
						missing: claimedNotChanged,
						nextAction: "Actually create or modify these paths, or remove them from the claimed change set if no project edit is needed.",
					}));
				}
				if (hollowFiles.length) {
					implParts.push(implementationRetrySection("Hollow deliverable files — write the actual implementation", {
						phase: phaseId,
						attempt,
						gate: "symbol-check",
						location: "claimed source deliverables",
						observed: "these files exist but contain only comments or no real code symbols",
						expected: "claimed source deliverables contain real functions, types, handlers, or other executable implementation symbols",
						missing: hollowFiles,
						nextAction: "Write the actual implementation in each file instead of placeholder comments or empty shells.",
					}));
				}
				implParts.push(redImplementContext(redStatus));
				const implPrompt = implParts.join("\n\n");
				const implStepSeq = ++stepSeq;
				// v0.3.73 M7 (run 2026-09-05T23-09-55-596Z: 2e92da3/5d4790d): detect a
				// mid-phase implementer self-commit — HEAD moved across the call window.
				// Advisory (P10 honest log + low finding): the deterministic commit and
				// the v0.3.66/67 already-satisfied escapes keep the run safe, but a
				// self-commit pre-lands unverified work and costs a RED cycle.
				const headBeforeImpl = String(spawnSync("git", ["rev-parse", "HEAD"], { cwd: setup.worktreePath, encoding: "utf8", timeout: 5_000 }).stdout ?? "").trim();
				const impl = await inStepScope(implStepSeq, `Implementation (${attemptDetail(attempt)})`, async () => {
					announceActivity("Implementation", attemptDetail(attempt));
					emitStep(`Implementation (${attemptDetail(attempt)})`, "running", implStepSeq);
					const r = await ctx.agent({
						id: `pipeline.implementation.${phaseId}.impl.a${attempt}`,
						agent: "implementer",
						prompt: implPrompt,
						// Fix 1a: the implementer's control contract is declared EXPLICITLY
						// (parity with verify.ts:430) so the challenge channel never depends
						// on prose parsing. `testDefects` MUST be declared for the model to
						// emit it (v0.1.52: the undeclared key made the channel unreachable
						// while a phantom `lines` key got filled instead).
						controlKeys: IMPLEMENTER_CONTROL_KEYS,
						// Fix 1c/1d: `testDefects: []` is the explicit "no proven defect"
						// value — it must NOT trigger a corrective re-prompt in either
						// backend. Absence (undefined) still does.
						allowEmptyArraysFor: ["testDefects"],
					});
					emitStep(`Implementation (${attemptDetail(attempt)})`, r.error ? "failed" : "ok", implStepSeq);
					return r;
				});
				// spec-11 AC-06/AC-10: the implementer's claimed change set is now STRUCTURED
				// ({filesCreated, filesModified, filesDeleted}). parseStructuredChanges reads
				// it (and back-tolerates the legacy flat filesModified array). The flat
				// summary list derives from filesCreated ∪ filesModified — deleted is
				// EXCLUDED (a deleted file is not a "modified" display entry). dedupe via
				// the existing `filesModified.includes` guard (first-seen order preserved).
				try {
					const headAfterImpl = String(spawnSync("git", ["rev-parse", "HEAD"], { cwd: setup.worktreePath, encoding: "utf8", timeout: 5_000 }).stdout ?? "").trim();
					if (headBeforeImpl && headAfterImpl && headBeforeImpl !== headAfterImpl) {
						ctx.log(`Implementation ${phaseId} advisory: implementer self-commit detected (HEAD ${headBeforeImpl.slice(0, 8)} → ${headAfterImpl.slice(0, 8)} during the call) — commits are engine-owned; the deterministic commit still runs after the gates, and a pre-landed implementation routes through the already-satisfied verification`);
						recordConvergenceFindings(state, {
							detectedAtStage: "implementation",
							ownerStage: "implementation",
							severity: "low",
							blocking: false,
							title: `Phase ${phaseId} implementer self-commit (HEAD moved mid-call)`,
							detail: `HEAD moved ${headBeforeImpl.slice(0, 8)} → ${headAfterImpl.slice(0, 8)} during the implementer call. Commits are engine-owned; self-commits pre-land unverified work and cost RED cycles.`,
							evidence: [headAfterImpl],
							sourceGate: "self-commit",
						}, { detectedAtStage: "implementation", ownerStage: "implementation", sourceGate: "self-commit" });
					}
				} catch { /* advisory detection only — never blocks the phase */ }
				const structured = parseStructuredChanges(impl.control);
				// Capture the implementer's diagnosis for the evidence-carrying RED
				// re-author (unsatisfiable-test loop). `testDefects` is the structured,
				// preferred signal; the trimmed .text tail is a fallback so a model
				// that ignores the contract still surfaces its reasoning. Kept per
				// phase (latest attempt) and consumed when RED is re-authored.
				implDefects = parseTestDefects(impl.control);
				implTextTail = trimImplementerText(impl.text);
				const projectStructured: StructuredChanges = {
					filesCreated: structured.filesCreated.filter((f) => !isInternalRuntimeClaim(f)),
					filesModified: structured.filesModified.filter((f) => !isInternalRuntimeClaim(f)),
					filesDeleted: structured.filesDeleted.filter((f) => !isInternalRuntimeClaim(f)),
				};
				for (const f of [...projectStructured.filesCreated, ...projectStructured.filesModified]) {
					if (!filesModified.includes(f)) filesModified.push(f);
				}
				// v0.2.9 G5: stream what the implementer DID (claimed changes + summary +
				// tests-pass count), so the run log shows each attempt's work, not just gates.
				{
					const implSummary = String((impl.control as { summary?: unknown } | null)?.summary ?? "").replace(/\s+/g, " ").trim();
					const tp = (impl.control as { testsPassCount?: unknown } | null)?.testsPassCount;
					ctx.log(`Implementation ${phaseId} implementer (attempt ${attempt})${impl.error ? ` error=${impl.error}` : ""}: created=[${projectStructured.filesCreated.join(", ") || "none"}] modified=[${projectStructured.filesModified.join(", ") || "none"}] deleted=[${projectStructured.filesDeleted.join(", ") || "none"}]${tp != null ? ` testsPass=${String(tp)}` : ""}${implSummary ? ` — ${implSummary.slice(0, 400)}` : ""}`);
				}
				// ── v0.3.43 RC2 join: adjudicate the in-flight RED review ──────────────
				// The review ran concurrently with this implementer (read-only vs the
				// write lane). R2 fail-closed and the Fix 4 contradiction override are
				// enforced here verbatim: ONLY an explicit STRONG, contradiction-free
				// verdict lets the GREEN work proceed to the gates. A merely-weak
				// verdict stays advisory (the post-RED oracle is the deterministic
				// endpoint — same semantics as the serial path). Anything else
				// discards the GREEN work and re-authors the RED with the evidence.
				if (redReviewInFlight) {
					// v0.3.51: the parallel review can REJECT (agent throw — e.g. a
					// source-read-only boundary violation, run 2026-08-31T03-25-44-485Z
					// 16:29). The store site marks the rejection handled; here it must be
					// adjudicated as a review error (fail-closed re-author), never allowed
					// to escape the stage.
					let review: { control: unknown; error?: string; quarantine?: BoundaryQuarantinePayload; salvagedControl?: Record<string, unknown> | null } | null;
					try {
						review = await redReviewInFlight;
					} catch (err) {
						// v0.3.55 security review F1: the structured quarantine payload
						// rides the thrown Error (parent-composed, unforgeable); the
						// message string is display-only and never parsed.
						const q = (err as { quarantine?: BoundaryQuarantinePayload } | null | undefined)?.quarantine;
						// v0.3.73 M1: the boundary throw may carry the delegation's
						// fully-formed control (attached parent-side) — keep it reachable.
						const salvaged = ((err as { salvagedControl?: unknown } | undefined)?.salvagedControl ?? null) as Record<string, unknown> | null;
						review = { control: null, error: String((err as Error)?.message ?? err), quarantine: q, salvagedControl: salvaged && typeof salvaged === "object" ? salvaged : null };
					}
					redReviewInFlight = null;

					// v0.3.73 M1 (run 2026-09-05T23-09-55-596Z — six quarantines, 54 min):
					// when EVERY violating path is covered by the concurrent implementer's
					// DECLARED file claims, the violations attribute to the writer lane and
					// the formed verdict is valid evidence about the suite. Salvage it
					// instead of discarding; adjudication proceeds normally. (Dual review
					// AR-73-01: phase test files are EXCLUDED from this predicate — they
					// claim unconditionally and cannot establish that the reviewer wrote
					// nothing; a reviewer-written test file stays unclaimed → no salvage,
					// the v0.3.53 fail-open path keeps the work.)
					if (review?.error && !(review.control as { verdict?: unknown } | null)?.verdict && review.salvagedControl && review.quarantine) {
						const attribution = attributeQuarantinePaths(setup.worktreePath, review.quarantine, impl?.control, testFiles, { testFilesAsClaims: false });
						if (attribution.declaredAny && attribution.unclaimed.length === 0 && review.salvagedControl.verdict !== undefined) {
							review = { control: review.salvagedControl, error: undefined };
							ctx.log(`Implementation ${phaseId} red-review verdict salvaged (boundary violations fully covered by the implementer's declared claims: ${attribution.claimed.join(", ")}) — adjudicating normally`);
						}
					}
					const verdict = String((review?.control as { verdict?: unknown } | null)?.verdict ?? "").toLowerCase();
					const contradictionList = parseRedContradictions((review?.control ?? null) as Parameters<typeof parseRedContradictions>[0]);
					if (verdict === "strong" && contradictionList.length === 0) {
						ctx.log(`Implementation ${phaseId} RED review: STRONG (no contradictions; adjudicated post-implementation)`);
					} else if (verdict === "weak" && contradictionList.length === 0) {
						const summary = String((review?.control as { summary?: unknown } | null)?.summary ?? "") || "test assertions are not bound to the scenario's observable behavior";
						ctx.log(`Implementation ${phaseId} RED review: NOT STRONG (weak) — ${summary} (advisory; proceeding — the implementer already ran, the post-RED oracle guards)`);
						redWeaknessAdvisory = `An independent reviewer rated the RED tests as NOT STRONG: ${summary}.`;
					} else if (!contradictionList.length && review?.error && !verdict) {
						// v0.3.53 F2 (P5): the REVIEWER failed (boundary violation, timeout,
						// spawn error) — a CHECKER failure, not evidence about the suite.
						// v0.3.54 review fix (code F2): fail open ONLY when no verdict text
						// was parsed. A control carrying an off-enum verdict (e.g. "REJECTED"
						// via an unconstrained <control> path) IS evidence about the suite —
						// failing open on it would launder a rejection into a keep; such
						// controls fall to the fail-closed branch below. The
						// pre-0.3.53 fail-closed path discarded correct GREEN work and
						// re-authored the RED, then re-launched the same misbehaving reviewer
						// (8+ violations, 3 phases partial, ~5h: run 2026-08-31T16-03-57-978Z
						// phases 05/06/07). Fail OPEN instead: keep the work, degrade to the
						// deterministic gates, record the finding, count separately; the
						// launch site stops parallel reviews for this phase at 2 violations.
						attributeQuarantinedViolations(setup.worktreePath, review.quarantine, impl?.control, testFiles, (line) => ctx.log(line));
						phaseReviewViolations++;
						const reason = String(review.error).slice(0, 300);
						ctx.log(`Implementation ${phaseId} red-review-incomplete (advisory): ${reason} — GREEN work KEPT (checker failure, not suite evidence); post-RED oracle + deliverable gates remain authoritative${phaseReviewViolations >= 2 ? "; parallel review DISABLED for this phase" : ""}`);
						try {
							recordConvergenceFindings(state, {
								detectedAtStage: "implementation",
								ownerStage: "implementation",
								severity: "low",
								blocking: false,
								title: `Phase ${phaseId} RED review did not complete (reviewer-side failure)`,
								detail: `${reason}. The RED tests were NOT independently reviewed this phase; GREEN acceptance rests on the deterministic oracles. Re-run the review manually if an independent LLM audit is wanted.`,
								evidence: [reason],
								sourceGate: "red-review",
							}, { detectedAtStage: "implementation", ownerStage: "implementation", sourceGate: "red-review" });
						} catch { /* never block the phase on ledger bookkeeping */ }
					} else {
						const summary = contradictionList.length > 0
							? `joint-satisfiability contradiction(s): ${contradictionList.map((c) => c.tests).join("; ")}`
							: review?.error
								? `RED review did not complete (${review.error})`
								: String((review?.control as { summary?: unknown } | null)?.summary ?? "") || "RED review returned no usable verdict";
						const discarded = discardGreenWork(setup.worktreePath, new Set(testFiles));
						reauthorEvidence = `\n\n## RED REVIEW REJECTED THE SUITE — the tests are jointly unsatisfiable (adjudicated after a parallel implementation pass — that work was discarded, ${discarded.length} file(s) restored)\n${summary}\n${contradictionList.length > 0 ? `Rewrite or remove the contradicting tests: ${contradictionList.map((c) => `${c.tests}${c.lines ? ` (${c.lines})` : ""}: ${c.proof}`).join(" | ")}. Resolve the contradiction in favor of the specification's observable behavior.\n` : ""}Re-author the suite so every test binds the scenario's OBSERVABLE behavior (concrete expected values/outputs/status codes), then re-run.`;
						// Canonical RC8 honesty lines (grep-stable across the serial→parallel change).
						ctx.log(contradictionList.length > 0
							? `Implementation ${phaseId} red-review-rejected: RED review found jointly unsatisfiable tests: ${summary} (parallel join — GREEN work discarded)`
							: `Implementation ${phaseId} red-review-rejected: RED review not strong: ${summary} (parallel join — GREEN work discarded)`);
						attemptErrors = [...attemptErrors, contradictionList.length > 0 ? `red-review-rejected: RED review found jointly unsatisfiable tests: ${summary}` : `red-review-rejected: RED review not strong: ${summary}`];
						acceptedRed = null;
						redTestSnapshot = new Map();
						ctx.log(`Implementation ${phaseId} RED review: REJECTED at join (${summary}) — discarded ${discarded.length} GREEN file(s) (${discarded.slice(0, 6).join(", ")}${discarded.length > 6 ? ", …" : ""}); routing back to RED re-author`);
						parallelReviewRejects++;
						if (parallelReviewRejects > MAX_PARALLEL_REVIEW_REJECTS) {
							terminalFailureKind = "red-generation";
							terminalRedTries = attemptsRun;
							terminalStopReason = "no-progress";
							ctx.log(`Implementation ${phaseId} stopped after ${MAX_PARALLEL_REVIEW_REJECTS} parallel-review rejections without a usable suite — continuing to the next phase`);
							break;
						}
						continue;
					}
				}
				// HARD test oracle: actually run build/test/typecheck instead of trusting
				// a QA agent's self-report (vacuous-pass risk). Non-fatal when nothing
				// is detectable (greenfield): ran is empty and pass is true.
				announceActivity("Build gate", attemptDetail(attempt));
				const gate = runBuildGate(setup.worktreePath, { gate: (state.spec?.gate) as GateOptions | undefined, signal: ctx.signal, defaultBranch: setup.defaultBranch });
				appendGateChecked(state, "phase-build", gate, "implementation");
				attemptErrors = gate.errors;
				ctx.log(`Implementation ${phaseId} build-gate ${gate.pass ? "PASS" : "FAIL"} (ran: ${gate.ran.join(", ") || "no commands"})`);
				// RC12c (runs 10-39/15-07): the implementer edited files OUTSIDE the
				// phase's declared scope (auth-service type shims to dodge an unrelated
				// build failure) — record a low non-blocking finding so the drift is
				// visible in the ledger instead of silently persisting in the worktree.
				// v0.3.80 B1 (P6): own-scope now derives from the validator's canonical
				// clause grammar — requireNotContains/requireTests targets count as
				// declared scope too, so a co-owned file declared through ANY clause
				// form is never misclassified as a later-phase leak.
				const declaredScope = new Set<string>(phaseClauseFiles(phase as never).map(leakNorm)); // review P3: leakNorm parity (trim + trailing slash) with the leak-side set
				const outOfScope = [...declaredScope].length
					? trackerOutofScopeEdits(tracker, setup.worktreePath, declaredScope, testFiles)
					: [];
				if (outOfScope.length > 0) {
					ctx.log(`Implementation ${phaseId} out-of-scope edits (non-blocking, recorded): ${outOfScope.join(", ")}`);
					try {
						recordConvergenceFindings(state, {
							detectedAtStage: "implementation",
							ownerStage: "implementation",
							severity: "low",
							blocking: false,
							title: `Phase ${phaseId} edited files outside its declared scope`,
							detail: `The implementer modified ${outOfScope.slice(0, 5).join(", ")} which are not among this phase's declared deliverables. Often a workaround for an unrelated environmental failure (missing dependencies in a fresh worktree) — check the bootstrap log before accepting these edits.`,
							evidence: outOfScope.slice(0, 8),
							sourceGate: "phase-build",
							recommendation: "Review the out-of-scope edits; if they work around an environmental failure, revert them and fix the environment (dependency bootstrap) instead.",
						}, { detectedAtStage: "implementation", ownerStage: "implementation", sourceGate: "phase-build" });
					} catch { /* never block the phase on ledger bookkeeping */ }
				}
				// AR-02: emit the pi session/model correlation tag to the run trace.
				const corr = buildGateCorrelationLine(gate);
				if (corr) ctx.log(corr);
				// DELIVERABLE CONTRACT (AC-03 → SCENARIO-011..015): a build-green phase can
				// deliver NOTHING (a never-created file compiles fine, an unwired call site
				// is still a valid public fn, a dead `_ => {}` router arm passes its own
				// tests). runDeliverableCheck is the never-throwing sibling oracle AND-ed
				// with the gate so the phase is only GREEN when the declared files/contains/
				// not-contains/tests are ALSO satisfied. When phase.deliverables is undefined
				// it early-returns {pass:true} → today's behavior (SCENARIO-014 backward compat).
				// RUN-BOUNDARY RESET (review finding, HIGH): a module-level test-list
				// cache is STALE the instant the implementer adds a test on a retry — the
				// cached list omits the new name and requireTests false-negatives forever,
				// defeating the core retry mechanism. Clearing it before EACH attempt
				// guarantees a FRESH list is spawned (a freshly-added test is seen).
				resetDeliverableCheckCache();
				// SKIP the test-lister when the build gate FAILED (review finding: wasted
				// compile on a broken build + a poisoned cache). The cheap file/contains/
				// not-contains checks still run; only the requireTests spawn is deferred.
				const buildGreen = gate.pass || gate.inScopePass;
				// spec-10 deliverable bridge (AC-09 → SCENARIO-018): UNION the implementer's
				// `claimed.filesCreated` into the spec-declared `requireFiles` so a file a
				// phase CLAIMS to have created MUST also exist (tracking + deliverable
				// assertions reinforce). Deduped UNION (first-seen order); the spec-declared
				// contract is preserved verbatim — an omitted spec-required file is still
				// caught independently (no circular double-count, SCENARIO-018b/018c).
				const baseDeliverables = (phase.deliverables ?? {}) as DeliverableContract;
				const bridgedDeliverables: DeliverableContract = {
					...baseDeliverables,
					// Deduped UNION preserving first-seen order (Set iteration is insertion
					// order, first occurrence wins) — inlined so the stage does not depend
					// on an un-mocked build-runner export (the bridge is pure data prep).
					requireFiles: Array.from(new Set([
						...(baseDeliverables.requireFiles ?? []),
						...projectStructured.filesCreated,
					])),
				};
				announceActivity("Deliverable check", attemptDetail(attempt));
				const deliverableCheck = runDeliverableCheck(setup.worktreePath, bridgedDeliverables, { signal: ctx.signal, skipTests: !buildGreen, defaultBranch: setup.defaultBranch });
				missingDeliverables = deliverableCheck.missing;
				ctx.log(`Implementation ${phaseId} deliverable-check ${deliverableCheck.pass ? "PASS" : "FAIL"} (missing: ${deliverableCheck.missing.join("; ") || "none"}; ran: ${deliverableCheck.ran.join(", ") || "none"})`);
				// Git cross-check GATE (AC-07, AC-08 → SCENARIO-013/014/015/016/017):
				// snapshot the phase's actual-vs-claimed delta per-attempt (so a retry that
				// wires the claimed file flips the verdict, SCENARIO-015), then collapse it
				// into a boolean gate verdict AND-ed into phase-green. NEVER throws and
				// degrades to a pass when git is unavailable (SCENARIO-017) — never block
				// on infrastructure. No tracker / never ended → null record → trivial pass.
				let phaseChangeRec: ChangeRecord | null = null;
				announceActivity("Change check", attemptDetail(attempt));
				if (tracker) {
					// Per-attempt PROBE (compute + store, no jsonl append) so the retry
					// injection sees the freshest claimedNotChanged (SCENARIO-015).
					// The bracket is closed EXACTLY ONCE via commitEnd after the attempt
					// loop so the jsonl trace keeps single begin/end-per-phase nesting
					// (AC-04 → SCENARIO-008/009, review finding CR-MED).
					phaseChangeRec = tracker.probeEnd("phase", phaseId, structured);
				}
				const changeGate = computeChangeGate(phaseChangeRec);
				// Symbol/hollow-file gate (silent-empty-success killer): a claimed source
				// deliverable that EXISTS (passes deliverable + change gates) but contains
				// NO code symbols (doc-comment-only shell) is rejected here. Never throws;
				// degrades to pass on unreadable files / unknown language / no source files.
				announceActivity("Symbol check", attemptDetail(attempt));
				const symbolGate = computeSymbolGate(setup.worktreePath, [...projectStructured.filesCreated, ...projectStructured.filesModified], setup.language);
				ctx.log(`Implementation ${phaseId} symbol-check ${symbolGate.pass ? "PASS" : "FAIL"} (hollow: ${symbolGate.hollowFiles.join("; ") || "none"})`);
				// Advisory-only (SCENARIO-014): files git shows changed that the agent did
				// NOT report (under-reporting) are surfaced via ctx.log but NEVER fail the
				// gate — under-reporting is not a false-green.
				const advisory = phaseChangeRec?.crossCheck?.changedNotClaimed ?? [];
				// Cross-phase deliverable leakage (run 2026-08-27T12-33-43-088Z):
				// phase-2 changed root index.html — phase-3's DECLARED deliverable —
				// out of scope (advisory then), so phase-3 could never author an honest
				// RED and burned 9 tries. BLOCKING now: revert the leaked paths (this
				// check runs PRE-commit, so the revert is effective) and name the owner
				// phases — later phases re-do the work with an honest RED.
				// The check runs over the attempt's FULL git delta (claimed or not —
				// run-1's leak was HONESTLY claimed by phase-2, which is exactly why
				// the advisory-only path would have missed it), minus this phase's
				// own declared scope (a file declared by BOTH phases belongs here).
				const gitActual = phaseChangeRec?.gitActual;
				const changedAll = gitActual
					? [...(gitActual.created ?? []), ...(gitActual.modified ?? []), ...(gitActual.deleted ?? [])]
					: advisory;
				const inOwnScope = changedAll.filter((f) => declaredScope.has(f) || declaredScope.has(f.replace(/\\/g, "/").replace(/^\.\//, "")));
				const leakOwners = laterPhaseDeliverableOwners(changedAll.filter((f) => !inOwnScope.includes(f)), phases, idx);
				if (leakOwners.length > 0) {
					boundaryRevertHits++;
					const leakFiles = laterPhaseDeliverableHits(changedAll.filter((f) => !inOwnScope.includes(f)), phases, idx);
					boundaryLeakOwners = [...new Set([...boundaryLeakOwners, ...leakOwners])];
					boundaryLeakFiles = [...new Set([...boundaryLeakFiles, ...leakFiles])];
					ctx.log(`Implementation ${phaseId} BLOCKING: changed-not-claimed file(s) ${leakFiles.join(", ")} are DECLARED DELIVERABLES of later phase(s) ${leakOwners.join(", ")} — phase-boundary leak; reverting them (this phase's scope stands, later phases redo the work with an honest RED). ROUTE TO APPROVAL: if these files genuinely belong to this phase's work, the phase contract must DECLARE them (co-ownership — any clause form counts) or the plan must be revised to order the introduction before this phase; steer guidance to revise the plan rather than retrying blind.`);
					restorePaths(setup.worktreePath, leakFiles);
				}
				if (advisory.length) {
					ctx.log(`Implementation ${phaseId} advisory: ${advisory.length} changed-not-claimed file(s): ${advisory.join(", ")}`);
				}
				// Evidence (AC-10 → SCENARIO-019): the ground-truth actual change counts
				// surfaced as a concise `📝 N files changed (C/M/D)` line.
				const ga = phaseChangeRec?.gitActual ?? null;
				if (ga) {
					const c = ga.created?.length ?? 0;
					const m = ga.modified?.length ?? 0;
					const d = ga.deleted?.length ?? 0;
					ctx.log(`Implementation ${phaseId} 📝 ${c + m + d} files changed (${c}C/${m}M/${d}D)`);
				}
				claimedNotChanged = changeGate.claimedNotChanged;
				hollowFiles = symbolGate.hollowFiles;
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
					const modifiedRedTests = changedSinceSnapshot(setup.worktreePath, redTestSnapshot);
					if (modifiedRedTests.length) {
						const restoredCount = restoreRedTestFiles(setup.worktreePath, redTestSnapshot, modifiedRedTests);
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
						if (!replanPending(state) && !runFuse.tripped) {
							const f4Match = f4ScopeMatch(modifiedRedTests, phases as Array<Record<string, unknown>>, phaseStatus, idx, lastFailures);
							if (f4Match) {
								const armLabel = f4Match.arm === "arm-a" ? "A: declared clause files" : "B: recorded failing-test paths";
								const f4PriorRows = countInheritedRedRows(setup.specDirectory);
								if (f4PriorRows >= 1) {
									appendInheritedRedEvent(setup.specDirectory, { event: "f4-handoff", phaseId, outcome: "tier3-fatal", arm: f4Match.arm, sourcePhase: f4Match.phaseId, paths: modifiedRedTests }, ctx.log);
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
								try { f4Routed = await triggerReplanForFindings(state, ctx, [f4Finding], "implementation", setup.specIdentifier ?? "unknown"); } catch { f4Routed = false; }
								if (f4Routed) {
									appendInheritedRedEvent(setup.specDirectory, { event: "f4-handoff", phaseId, outcome: "handoff-routed", arm: f4Match.arm, sourcePhase: f4Match.phaseId, paths: modifiedRedTests }, ctx.log);
									terminalStopReason = "declared-handoff";
									attemptErrors = [...attemptErrors, `declared-handoff (f4): restored test file(s) ${modifiedRedTests.join(", ")} belong to prior partial phase ${f4Match.phaseId}'s scope (arm ${f4Match.arm}) — spec amendment routed (source:inherited-red, sourcePhase:${f4Match.phaseId})`];
									ctx.log(`Implementation ${phaseId} F4 door-in-the-fence: IMMEDIATE declared handoff — restored test file(s) ${modifiedRedTests.join(", ")} match prior partial phase ${f4Match.phaseId}'s scope (arm ${armLabel}); retry is provably futile, so the phase exits partial (declared-handoff (f4)) now and the run ends status "replan" — "requires a spec change" becomes a mechanism (row: source:inherited-red, sourcePhase:${f4Match.phaseId}, handoffArm:${f4Match.arm})`);
									break;
								}
								appendInheritedRedEvent(setup.specDirectory, { event: "f4-handoff", phaseId, outcome: "handoff-unavailable", arm: f4Match.arm, sourcePhase: f4Match.phaseId, paths: modifiedRedTests }, ctx.log);
								ctx.log(`Implementation ${phaseId} F4 door-in-the-fence: declared handoff UNAVAILABLE (replan pool exhausted / marker set / ledger write failure) while the restored test file(s) provably belong to prior partial phase ${f4Match.phaseId}'s scope — Tier 3 FatalAbort (no retry loop)`);
								throw new FatalAbort(`F4 declared handoff unavailable at ${phaseId} (v0.3.85 F4, ADR 8): the restored test file(s) ${modifiedRedTests.join(", ")} belong to prior partial phase ${f4Match.phaseId}'s scope (arm ${f4Match.arm}), but the replan circuit could not route (pool exhausted, marker already set, or ledger write failure). Stop-the-line — no retry loop.`);
							}
						}
						// Re-run the oracle against the RESTORED tests so the retry feedback
						// carries the real status (green = the edit was the only blocker;
						// red = real assertions still need production code).
						announceActivity("Post-RED oracle (restored)", attemptDetail(attempt));
						const restoredDiagnostics: RedCheckDiagnostic[] = [];
						const restoredStatus = runRedCheck(setup.worktreePath, acceptedRed.testFiles, redCheckOptions(ctx, phaseId, restoredDiagnostics, setup.defaultBranch, runnerSpec ?? undefined));
						ctx.log(`Implementation ${phaseId} post-red-oracle: restored tests re-checked → ${restoredStatus} (ran: ${acceptedRed.testFiles.join(",") || "n/a"})`);
						tddOracleFailures.push(`tdd-tests-modified-during-green: ${modifiedRedTests.join(", ")} (RESTORED from confirmed RED; re-check=${restoredStatus})`);
					} else if (confirmedRedTargets) {
						announceActivity("Post-RED oracle", attemptDetail(attempt));
						const postRedDiagnostics: RedCheckDiagnostic[] = [];
						const postRedStatus = runRedCheck(setup.worktreePath, testFiles, redCheckOptions(ctx, phaseId, postRedDiagnostics, setup.defaultBranch, runnerSpec ?? undefined));
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
				coverageGap = [];
				// v0.3.56 F2: the runner chain is LIVE phase-scoped `runnerSpec` first
				// (v0.3.53 hoisted it here, so the old "cache DIRECTLY" comment was
				// stale), then the disk cache, then a conventions-derived spec — RED
				// that ran via conventions previously left the cache unwritten and the
				// `&& covRunnerSpec` below silently skipped the gate AND its advisory
				// (a silent green, P10). Only when NO runner exists at all does the
				// loud UNMEASURABLE advisory fire instead of silence.
				const covRunnerSpec = runnerSpec ?? readCachedTestRunner(setup.specDirectory) ?? covConventionsSpec ?? deriveConventionsRunnerSpec(setup.worktreePath, testFiles); // F-E: the captured-at-RED spec precedes a fresh (implementer-mutable) re-derive
				if ((gate.pass || gate.inScopePass) && deliverableCheck.pass && changeGate.pass && symbolGate.pass && tddOracleFailures.length === 0) {
					if (covRunnerSpec) {
					const phaseProductionFiles = Array.from(new Set([
						...projectStructured.filesCreated,
						...projectStructured.filesModified,
						...declaredScope,
						...(bridgedDeliverables.requireFiles ?? []),
					]));
					announceActivity("Coverage gate", attemptDetail(attempt));
					coverageResult = runCoverageGate(setup.worktreePath, {
						runnerSpec: covRunnerSpec,
						phaseFiles: phaseProductionFiles,
						testFiles,
						log: (m) => ctx.log(`Implementation ${phaseId} coverage: ${m}`),
					});
					ctx.log(`Implementation ${phaseId} coverage-gate ${coverageResult.status.toUpperCase()}${coverageResult.linesPct !== undefined ? ` (${coverageResult.linesPct.toFixed(1)}% lines vs ≥${coverageResult.threshold}%)` : ""} — ${coverageResult.detail}`);
					if (coverageResult.status === "below-threshold") {
						coverageGap = [
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
				if ((gate.pass || gate.inScopePass) && deliverableCheck.pass && changeGate.pass && symbolGate.pass && tddOracleFailures.length === 0 && coverageResult?.status !== "below-threshold") {
					green = true;
					phaseStatusUpsert(phaseStatus, phaseId, "green", attempt); // v0.3.85 S3: peak-attempts metric
					emitPhaseStatus("ok");
					const _gfi = lastFailures.findIndex((f) => f.phaseId === phaseId); if (_gfi >= 0) lastFailures.splice(_gfi, 1);
					if (gate.pass) {
						ctx.log(`Implementation ${phaseId} GREEN on attempt ${attempt}`);
					} else {
						ctx.log(`Implementation ${phaseId} IN-SCOPE GREEN on attempt ${attempt} — ${gate.outOfScopeErrors.length} pre-existing out-of-scope failure(s) ignored (crates: ${cratesFromErrors(gate.outOfScopeErrors).join(",")})`);
					}
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
					let gate2: BuildGateResult | null = null;
				let latestDeliverableCheck2: ReturnType<typeof runDeliverableCheck> | null = null; // adv-F5: re-run deliverable verdict for re-classification
					if (foreignDirt.length > 0 && dirtyQuarantineEnabled() && !envBlockerRegateUsed) {
						announceActivity("Environmental blocker", attemptDetail(attempt));
						// AC-05 (SCENARIO-013 · T3.4): the class + next-action literal for
						// the quarantine arm — substring-pinned in tests (dirt non-empty +
						// switch unset ⇒ next=<quarantine+re-gate>).
						ctx.log(`Implementation ${phaseId} environmental-blocker: out-of-scope-only failures, baseline=regression, own-scope evidence green — class=environment; next=<quarantine+re-gate>`);
						// Recoverable quarantine (D-9/D-10): stash-based only, kill-switched,
						// never destructive — the ONLY worktree mutation is a scoped
						// `git stash push -u -- <paths>`.
						// v0.2.6 G1: stash FOREIGN dirt only — paths dirty at phase start. This
						// phase's own undeclared edits (ownDirt) are NEVER stashed: they are live
						// work the retry feedback must name, not state to sweep away.
						const q = quarantineDirt({ worktreePath: setup.worktreePath, paths: foreignDirt, reason: `stage9 environmental-blocker phase ${phaseId}`, log: ctx.log });
						if (q.ok) {
							// PRD ledger record (AC-12 · SCENARIO-005's And-clause): one JSON
							// line, exact key set; never throws (degrades inside the primitive).
							appendEnvironmentFault(setup.specDirectory, { kind: "quarantine", paths: foreignDirt, stashRef: q.stashRef, reason: `environmental-blocker phase ${phaseId}` }, ctx.log);
							// Recovery log (AC-10 parity): quarantined paths + stash ref +
							// `git stash pop` + kill-switch in one prominent line; class + next
							// (NFR-2). Reversible by construction — never drop/clear (R-N6).
							ctx.log(`Implementation ${phaseId} quarantined foreign uncommitted state — paths: ${foreignDirt.join(", ")} (foreign pre-phase dirt only — this-phase edits are never stashed); stash ref: ${q.stashRef ?? "(unresolved)"}; recover with: git stash pop; kill-switch: SUPER_DEV_NO_DIRTY_QUARANTINE=1 — class=environment; next=<build-gate re-run>`);
							// The budget counts a COMPLETED state change: consumed only on a
							// successful quarantine — it grants EXACTLY ONE gate re-run (AC-03,
							// OQ-1; a failed quarantine leaves it intact, T4.4).
							envBlockerRegateUsed = true;
							// D-1a (SCENARIO-006 · AC-03): the re-run must NOT inherit a baseline
							// verdict memoized against the pre-quarantine worktree — clear the
							// memo immediately before the single re-run (AC wins over research
							// Q4; deterministic, zero new cache machinery).
							clearBaselineCache();
							announceActivity("Build gate (post-quarantine re-run)", attemptDetail(attempt));
							gate2 = runBuildGate(setup.worktreePath, { gate: (state.spec?.gate) as GateOptions | undefined, signal: ctx.signal, defaultBranch: setup.defaultBranch });
							appendGateChecked(state, "phase-build:env-blocker-regate", gate2, "implementation");
							ctx.log(`Implementation ${phaseId} build-gate (post-quarantine re-run) ${gate2.pass ? "PASS" : "FAIL"} (ran: ${gate2.ran.join(", ") || "no commands"})`);
							// T3.3 (SCENARIO-007 · AC-03): green-through on the RE-RUN result — the
							// existing `(gate.pass || gate.inScopePass)` branch re-entered with a FRESH
							// deliverable check. D-12 (risk 2): the original check ran with skipTests:true
							// (the build was failing); after a green re-run, resetDeliverableCheckCache()
							// then re-run with skipTests:false so `requireTests` is verified against a
							// build-green state. The changeGate/symbolGate/tdd-oracle verdicts are REUSED,
							// not recomputed — the quarantined paths exclude the claimed set, so those
							// verdicts remain valid post-quarantine (D-12).
							if (gate2.pass || gate2.inScopePass) {
								resetDeliverableCheckCache();
								announceActivity("Deliverable check", attemptDetail(attempt, "post-quarantine re-run"));
								const deliverableCheck2 = runDeliverableCheck(setup.worktreePath, bridgedDeliverables, { signal: ctx.signal, skipTests: false, defaultBranch: setup.defaultBranch }); // sweep-3 G6
								latestDeliverableCheck2 = deliverableCheck2;
								if ((gate2.pass || gate2.inScopePass) && deliverableCheck2.pass && changeGate.pass && symbolGate.pass && tddOracleFailures.length === 0) {
									green = true;
									phaseStatusUpsert(phaseStatus, phaseId, "green", attempt); // v0.3.85 S3: peak-attempts metric
									emitPhaseStatus("ok");
									const _efi = lastFailures.findIndex((f) => f.phaseId === phaseId); if (_efi >= 0) lastFailures.splice(_efi, 1);
									if (gate2.pass) {
										ctx.log(`Implementation ${phaseId} GREEN on attempt ${attempt}`);
									} else {
										ctx.log(`Implementation ${phaseId} IN-SCOPE GREEN on attempt ${attempt} — ${gate2.outOfScopeErrors.length} pre-existing out-of-scope failure(s) ignored (crates: ${cratesFromErrors(gate2.outOfScopeErrors).join(",")})`);
									}
									attemptErrors = gate2.errors;
									break;
								}
								// Still blocked on own-scope evidence after the fresh check — but
								// adv-review F-5: re-classify the RE-RUN evidence before the judge
								// tail. A green re-run whose fresh deliverable check fails is product
								// evidence, not environmental — routing it to the environmental judge
								// would misclassify. Only a still-environmental verdict proceeds to
								// the judge hand-off below; otherwise fall through to failureReasons.
							}
						} else if (q.error) {
							// Quarantine mechanism failure (T4.4/SCENARIO-029 arm): nothing was
							// stashed so no recovery is owed; degrade to the judge route —
							// never fatal, the attempt loop never throws (AC-13).
							ctx.log(`Implementation ${phaseId} quarantine FAILED (nothing stashed — degrading to judge route) — class=environment; next=<judge: fix-environment/escalate>: ${q.error.slice(0, 300)}`);
						}
						// (q.skipped === "empty" is unreachable here — foreignDirt.length > 0;
						// q.skipped === "kill-switch" is guarded by dirtyQuarantineEnabled().)
					}
					// adv-F5 + v0.2.6 G2: compute the re-run re-classification ONCE here (gate2
					// + the fresh deliverable verdict + reused change/symbol/tdd evidence). It
					// now covers BOTH non-green re-run shapes: (a) the re-run STILL FAILS — post-
					// quarantine the foreign dirt is stashed by construction, so any remaining
					// failure is this phase's product problem (run 2026-08-19T05-09-21-800Z rode
					// a stale environment class into the judge on exactly this path — its own
					// quarantine had manufactured the tsc failures); (b) adv-F5's original case —
					// the re-run went green but the fresh deliverable check failed.
					// Non-environmental ⇒ fall through to failureReasons (product retry
					// semantics, the re-run's errors as the feedback truth) instead of the
					// environmental judge hand-off.
					let reRunClassifiedProduct = false;
					const regateStillRed = gate2 !== null && !gate2.pass && !gate2.inScopePass;
					if (gate2 && (regateStillRed || (latestDeliverableCheck2 !== null && !latestDeliverableCheck2.pass))) {
						// v0.2.6 G2 + adversarial sd26-F5: OBSERVED provenance, not the
						// asserted 0 — recompute the inventory and partition against the
						// phase's first-ever snapshot (normally 0 post-quarantine because
						// the foreign dirt was stashed; an external tree mutation between
						// the stash and the re-gate surfaces here as live foreign dirt and
						// keeps the environmental reading honest).
						const dirtAfter = collectDirtPaths({
							worktreePath: setup.worktreePath,
							specDirectory: setup.specDirectory,
							copiedEnvFiles: setup.copiedEnvFiles ?? [],
							extraExcluded: [...projectStructured.filesCreated, ...projectStructured.filesModified, ...projectStructured.filesDeleted, ...declaredScope, ...testFiles],
						});
						const foreignAfter = dirtAfter.filter((p) => runStartSet.has(p));
						const reClassify = classifyGateFault({
							errors: gate2.errors,
							outOfScopeErrors: gate2.outOfScopeErrors,
							baselineCheck: gate2.baselineCheck,
							ownScope: { deliverablePass: latestDeliverableCheck2 !== null ? latestDeliverableCheck2.pass : false, changePass: changeGate.pass, symbolPass: symbolGate.pass, tddClean: tddOracleFailures.length === 0 },
							foreignDirtCount: foreignAfter.length,
						});
						if (reClassify.faultClass !== "environmental-blocker") {
							reRunClassifiedProduct = true;
							attemptFaultClass = reClassify.faultClass; // v0.3.85 F3: the re-run's class is the attempt's effective class
							postRegateProductErrors = gate2.errors;
							ctx.log(`Implementation ${phaseId} post-quarantine re-run classified ${reClassify.faultClass} (${regateStillRed ? "re-run still failing — remaining failures are this phase's product problem (foreign dirt already stashed)" : "own-scope evidence not green"}) — class=product; next=<implementer-retry> — environmental judge skipped`);
						}
					}
					if (!reRunClassifiedProduct) {
					// Still blocked — v0.2.6 G1/G2 narrowed the reachable entries to
					// kill-switch-set and quarantine-FAILED (no-dirt can no longer classify
					// environmental; a still-failing or deliverable-failing re-gate
					// re-classifies product above): the judge hand-off below owns routing
					// from exactly those entries.

					// T4.3 (SCENARIO-024 · AC-11/AC-04): kill-switch ordering — the detection
					// warning is emitted BEFORE the judge hand-off. Detection observes,
					// mutation never runs: the guard above skipped the quarantine arm and the
					// primitive's own short-circuit makes a stash structurally unreachable.
					if (dirtPaths.length > 0 && !dirtyQuarantineEnabled()) {
						ctx.log(`Implementation ${phaseId} dirty-quarantine kill-switch SUPER_DEV_NO_DIRTY_QUARANTINE=1 set — detection only, worktree untouched — class=environment; next=<judge: fix-environment/escalate>`);
					}
					// AC-05 (SCENARIO-013): class + next action on every new line (NFR-2).
					ctx.log(`Implementation ${phaseId} environmental-blocker: out-of-scope-only failures, baseline=regression, own-scope evidence green — class=environment; next=<judge: fix-environment/escalate>`);
					// ── T4.1 (SCENARIO-010/011 · AC-04): the SINGLE judge hand-off, at FIRST
					// occurrence, reached from every still-blocked entry (dirt empty |
					// kill-switch | envBlockerRegateUsed | re-run still blocked | quarantine
					// failed). D-13: the signature is keyed on the out-of-scope subjects +
					// baseline status — NEVER progressSignature.failure — so the ≤2
					// per-signature budget is not shared with stage9.impl-no-progress.
					// D-6 (OQ-1): allowedRoutes is EXACTLY ["fix-environment"] (escalate-now
					// is auto-unioned by judge.ts); outputTails carries the gate tail +
					// baseline evidence so quote verification (INV-2) can pass instead of
					// silently degrading. OQ-3/D-8: exactly one prior-fault context line,
					// present iff the track ledger exists.
					const latestGate = gate2 ?? gate;
					const envSubjects = [...new Set(latestGate.outOfScopeErrors)].sort();
					const envSignature = JSON.stringify({ subjects: envSubjects, baseline: latestGate.baselineCheck?.status ?? "regression" });
					const priorFaults = readEnvironmentFaultCount(setup.specDirectory);
					const envBaselineStatus = latestGate.baselineCheck?.status ?? "regression";
					const envBaselineEvidence = latestGate.baselineCheck?.evidence ?? "(none)";
					const envGateTail = latestGate.errors.join("\n").slice(-2000);
					const judgeOut = await runJudge(ctx, {
						scope: `stage9.impl-env-blocker.${phaseId}`,
						signature: envSignature,
						worktreePath: setup.worktreePath,
						specDirectory: setup.specDirectory,
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
						// contradicts the deterministic `class=environment` frame (run 05-09:
						// "NOT environmental — cross-phase sequencing conflict"), it can route
						// implementer-retry instead of being boxed into fix-environment or
						// escalate-now. Bounded by the per-signature budget; audited in the log,
						// the ledger, and the implementer feedback.
						allowedRoutes: ["fix-environment", "implementer-retry"],
						outputTails: [envGateTail, envBaselineEvidence],
					});
					// ── T4.2 (SCENARIO-012 · AC-04): the outcome ladder. A routed
					// fix-environment surfaces as the D-5 soft HITL escalation carrying BOTH
					// evidence packets; escalate/discarded/degraded (incl. disabled judge and
					// budget exhaustion) fall to the SAME surface; headless logs the packets.
					// EVERY arm then terminal-stops — no `continue`, no implementer spawn, no
					// second automatic quarantine (OQ-1); the outer convergence loop owns
					// re-entry (a later iteration re-enters the phase with a fresh budget).
					const routedFixEnvironment = judgeOut.status === "routed" && judgeOut.verdict.route === "fix-environment";
					// v0.2.6 G3 — the audited override: the classifier said environment, the
					// judge's grounded reading says product. Trust the judge: the diagnosis
					// joins the implementer feedback, no HITL surface, no convergence block,
					// the attempt falls through to failureReasons (normal implementer retry).
					// M4 fold (defense-in-depth, NOT tautology removal): the explicit
					// route check guards against an UNOFFERED retry-classified route
					// (re-author-tests/challenge-test also classify to "retry" but are
					// never offered at this scope); the classifier agreement pins the
					// shared vocabulary so the two can never drift apart silently.
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
						// v0.2.6 G3 + code-review sd26-CR-3: the override arm neither
						// surfaces HITL nor terminal-stops — the ladder wording below must
						// not fire for it (its own override log is emitted in the G3 block).
					} else {
						const degradeWhy = judgeOut.status === "routed" || judgeOut.status === "escalate" ? `verdict route=${judgeOut.verdict.route}` : judgeOut.reason;
						ctx.log(`Implementation ${phaseId} judge ${judgeOut.status} at the environmental-blocker boundary (${degradeWhy}) — surfacing both evidence packets to the user (soft HITL, terminal stop) — class=environment; next=<human: escalate>`);
					}
					if (routedImplementerRetry) {
						// v0.2.6 G3 — the audited override path: the judge's grounded diagnosis
						// contradicts the deterministic class=environment frame. Record the
						// verdict in the ledger, join the diagnosis (+ any undeclared-edit
						// feedback) to the implementer retry, and SKIP the HITL surface and the
						// convergence block entirely — the attempt falls through to failureReasons
						// and the implementer is re-spawned with the judge's reading in context.
						appendEnvironmentFault(setup.specDirectory, { kind: "judge-environmental", paths: null, stashRef: null, reason: `implementer-retry: ${judgeOut.verdict.diagnosis.slice(0, 200)}` }, ctx.log);
						attemptFaultClass = "product-defect"; // v0.3.85 F3: the judge's grounded override — the audited log line says class=product
						// v0.2.6 G3 + code-review sd26-CR-5: when this override arrives via
						// a still-red post-quarantine re-gate, the re-run's errors are the
						// tree's current truth — mirror the G2 carrier so the implementer
						// never sees the stale pre-quarantine gate tail.
						if (gate2) postRegateProductErrors = gate2.errors;
						envJudgeOverrideFeedback = [
							`judge override — the deterministic classifier said environment, but the judge diagnosis says this is a product defect the implementer must address: ${judgeOut.verdict.diagnosis.slice(0, 600)}`,
							// v0.2.7 dedup: ownDirtFeedback is ALWAYS appended to failureReasons
							// directly below, so it must NOT be repeated here (it duplicated every
							// undeclared-edit line in the retry prompt on this override path).
						];
						ctx.log(`Implementation ${phaseId} judge route=implementer-retry: classifier=environment OVERRIDDEN by judge diagnosis — class=product; next=<implementer-retry> (audited in .environment-faults.jsonl; diagnosis joined the retry feedback) — ${judgeOut.verdict.diagnosis.slice(0, 200)}`);
					} else {
						// The soft HITL surface (mirrors the no-progress block's shape — minus
						// applyRetryDecision, D-5): kind stagnation / severity soft / stage
						// implementation; findings = gate tail + baseline + inventory sliced to
						// 12, with the baseline and inventory packets LEADING the slice so both
						// evidence packets always survive it.
						const envFailure: import("../types.ts").EscalationFailure = {
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
							worktreePath: setup.worktreePath,
							specDirectory: setup.specDirectory,
						};
						const escalate = (ctx as { options?: { escalate?: import("../types.ts").Escalate } }).options?.escalate;
						if (escalate) {
							try {
								const { runEscalation } = await import("../escalation.ts");
								const decision = await runEscalation(state, envFailure, escalate);
								// D-5: the decision is LOGGED ONLY — applyRetryDecision is NOT called
								// at this boundary (its retry path is a `git reset --hard` + `git
								// clean -fd` rollback; stash entries survive it, but the env-blocker
								// arm must never make that destructive choice unconscious). No
								// rollback, no implementer re-spawn, no `continue` — the outer
								// convergence loop owns re-entry.
								if (decision) {
									// adv-review F-3: a retry-with-guidance choice at this boundary must
									// not be silently discarded — persist the guidance non-destructively
									// to the track user-notes (injected into every later agent prompt)
									// WITHOUT applyRetryDecision (D-5 still holds: no rollback, no
									// implementer re-spawn, no continue).
									// v0.2.6 G4 — the FIRST retry-with-guidance EVER granted for this phase
										// (persisted across convergence iterations — adversarial sd26-F2) grants a
										// bounded re-entry: guidance persists AND the adv-F2 windup trip below is
										// skipped, so the outer convergence loop re-enters the phase and the guidance
										// actually reaches fresh agent calls (run 05-09 dead-lettered the user's
										// explicit "do it again"). One-shot per phase EVER; a later choice (any
										// iteration) finds the budget spent and terminal-stops as before. sd26-F3:
										// the grant is consumed ONLY after appendUserNotes succeeds — a persistence
										// failure leaves the budget intact and falls to the blocked stop.
									if (decision.choice === "retry-with-guidance" && decision.guidance) {
										const grantReentry = !Object.prototype.hasOwnProperty.call(phaseGuidanceReentryUsed, phaseId);
										try {
											const { appendUserNotes } = await import("../render/user-notes.ts");
											appendUserNotes(setup.specDirectory, [`[env-blocker phase ${phaseId}] ${decision.guidance.slice(0, 2000)}`]);
											if (grantReentry) {
												phaseGuidanceReentryUsed[phaseId] = true;
												envGuidanceReentryGranted = true;
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
						// appended after the hand-off settles (the HITL/headless surface has run)
						// on every outcome that carries a verdict — routed or escalate. A
						// discarded/degraded outcome carries NO verdict (only a reason), so no
						// verdict record exists to write; lenient preexisting grants never reach
						// this boundary at all (D-14). Verdict shape: paths/stashRef null, reason
						// = "<route>: <diagnosis tail>" (≤200 chars); key set stays exactly
						// {kind, paths, stashRef, reason}. The append never throws — an
						// unwritable ledger degrades to the primitive's warning (SCENARIO-030)
						// and the terminal stop below proceeds regardless.
						if (judgeOut.status === "routed" || judgeOut.status === "escalate") {
							appendEnvironmentFault(setup.specDirectory, { kind: "judge-environmental", paths: null, stashRef: null, reason: `${judgeOut.verdict.route}: ${judgeOut.verdict.diagnosis.slice(0, 200)}` }, ctx.log);
						}
						// D-5 terminal stop: terminalStopReason "failed" (the generic loop-tail
						// stop line carries no suffix for it) + this DISTINCT stop log so the
						// boundary remains identifiable in the run log.
						terminalStopReason = "failed";
					envBlockedPhases.add(phaseId); // v0.3.80 B2: judge-owned environmental stop — excluded from stage-close re-verification
						if (envGuidanceReentryGranted) {
							// v0.2.6 G4 — the granted re-entry declines the windup trip: the outer
							// convergence loop re-enters the phase and the persisted guidance
							// reaches the fresh agent calls. terminalStopReason stays "failed" so
							// the loop tail logs an honest stop for THIS pass.
							ctx.log(`Implementation ${phaseId} environmental-blocker stop after judge hand-off (outcome: ${routedFixEnvironment ? "route=fix-environment" : judgeOut.status}) — guidance re-entry GRANTED: convergence not blocked, the outer convergence loop re-enters this phase — class=environment; next=<re-entry consumes guidance>`);
						} else {
							// adv-review F-2: trip the convergence-level anti-windup — an unresolved
							// environmental blocker must NOT let the outer convergence loop re-enter
							// this phase until the global agent budget. The distinct reason names
							// the class so the summary distinguishes it from product no-progress.
							// v0.3.0 (harness research): the environmental-blocker stop no longer
							// trips convergenceBlocked — the phase is preserved as partial and the
							// pipeline continues; the outer convergence loop re-enters bounded by
							// the global budget fuse.
							convergenceBlockReason = `environmental-blocker: ${routedFixEnvironment ? "judge route=fix-environment awaiting environment fix" : `judge ${judgeOut.status}`} — out-of-scope-only failures (baseline=${envBaselineStatus}), own-scope evidence green`;
							ctx.log(`Implementation ${phaseId} environmental-blocker stop after judge hand-off (outcome: ${routedFixEnvironment ? "route=fix-environment" : judgeOut.status}) — awaiting environment fix or user decision — class=environment; phase preserved as partial, continuing to the next phase this pass (v0.3.0)`);
						}
						break;
					} // end !routedImplementerRetry (v0.2.6 G3)
					} // end !reRunClassifiedProduct (adv-F5)
				}
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
				const noProgress = signatureRepeat || faultRecurrence;
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
				// ── v0.3.85 F2: the inherited-red tier ladder (C1 fix; §10 decision 3) ──
				// Replaces C1's blind forward-continue at the partial boundary: when
				// the GATE is the blocker, every remaining failure is out-of-scope, a
				// baseline verification ran, own-scope evidence is green, and the
				// failing subjects sit outside the declared targets — attribution
				// decides. Occurrence = a boundary whose classification SURVIVES Tier 0
				// (attribution) and Tier 1 (flake filter) — reaches the Tier-2 decision;
				// Tier-0-reverted and Tier-1-flake-cleared boundaries are metrics-only
				// and NEVER consume the tally. P3 guards: no ladder after the run already
				// ended (replan marker / wall-fuse terminal), no double-fire with the env
				// machinery's product fall-throughs, and F4's handoff sets the marker so
				// this block cannot re-route in the same boundary. Runs AFTER the
				// signature recording so a Tier-0 retry is visible to the no-progress
				// detector on the NEXT attempt (bounded by the attempt cap — P8).
				if (
					!replanPending(state)
					&& envJudgeOverrideFeedback.length === 0
					&& postRegateProductErrors === null
					// FIX ROUND 1 (TSC TS2367 + the P3 intent behind it): read the FUSE
					// STATE directly, never the terminalStopReason string (CFA narrows
					// the reason away from "wall-fuse" on this path, and a string compare
					// is not structural anyway). runFuse.tripped is the same live window
					// the loop-head wind-down checks — fuse-terminal phases must NOT
					// route handoffs after the run already ended.
					&& !runFuse.tripped
					&& inheritedRedBoundaryShape({
						gate,
						ownScope: { deliverablePass: deliverableCheck.pass, changePass: changeGate.pass, symbolPass: symbolGate.pass, tddClean: tddOracleFailures.length === 0 },
						coverageBlocked: coverageResult?.status === "below-threshold",
						declaredScope,
					}).shape
				) {
					const prePhaseDirt = dirtPaths.filter((p) => phaseStartSet.has(normalizeRepoPath(p)));
					const ownLeakPaths = dirtPaths.filter((p) => !phaseStartSet.has(normalizeRepoPath(p)));
					const baselineStatus = gate.baselineCheck?.status;
					const attribution = inheritedRedAttribution({ baselineStatus, prePhaseDirt, ownLeakPaths });
					if (attribution === "not-evaluable") {
						// The deliberate exclusion: no attribution evidence (unknown
						// baseline) — today's behavior; the poison, if any, is caught at the
						// next completed gate.
						ctx.log(`Implementation ${phaseId} inherited-red boundary: NOT EVALUABLE (baseline=${baselineStatus ?? "absent"}) — attribution needs evidence; today's retry semantics stand`);
					} else if (attribution === "own-leak") {
						// TIER 0 — deterministic attribution: an out-of-scope subject that
						// passes at baseline cannot break on a tree clean at phase start any
						// other way than this phase's own edits (G1's row-2 derivation).
						// Revert the phase's undeclared out-of-scope dirt (deterministic,
						// no agent call — runs even at exhausted attempt budget) and retry
						// CONSUMING the phase's own attempt budget.
						//
						// FIX ROUND 1 (B): the revert is NON-DESTRUCTIVE. Only CONFIRMED
						// tracked/staged leaks are restored to HEAD (recoverable,
						// deterministic). UNTRACKED new files are the implementer's live
						// work — the G1/v0.3.0 preserve contract keeps them on disk for the
						// partial preserve-stash and names them in the retry feedback
						// (restorePaths' `git clean` would delete them irrecoverably). A
						// failed/empty porcelain read reverts NOTHING (fail-safe: no
						// destructive op on unknown state).
						const tier0Entries = porcelainEntries(setup.worktreePath);
						const tier0Untracked = new Set(tier0Entries.filter((e) => e.status.startsWith("?")).map((e) => e.path));
						const tier0Tracked = new Set(tier0Entries.filter((e) => !e.status.startsWith("?")).map((e) => e.path));
						const revertableLeakPaths = ownLeakPaths.filter((p) => tier0Tracked.has(p) && !tier0Untracked.has(p));
						const liveLeakPaths = ownLeakPaths.filter((p) => !revertableLeakPaths.includes(p));
						appendInheritedRedEvent(setup.specDirectory, { event: "tier0-own-leak", phaseId, outcome: revertableLeakPaths.length ? "reverted" : ownLeakPaths.length ? "live-work-named" : "no-revertable-dirt", ownLeakPaths, baseline: baselineStatus }, ctx.log);
						if (revertableLeakPaths.length > 0) {
							restorePaths(setup.worktreePath, revertableLeakPaths);
							attemptErrors = [...attemptErrors, ...revertableLeakPaths.map((p) => `inherited-red-own-leak-reverted: ${p}`)];
						}
						if (ownLeakPaths.length > 0) {
							ctx.log(`Implementation ${phaseId} inherited-red Tier 0 (own-leak): regression on a tree clean at phase start with no pre-phase dirt — the out-of-scope failure is this phase's own leak; REVERTED ${revertableLeakPaths.length} tracked undeclared out-of-scope path(s) (${revertableLeakPaths.join(", ") || "none"}) — deterministic cleanup, no agent call${liveLeakPaths.length ? `; LEFT ${liveLeakPaths.length} untracked live-work path(s) in place, never destroyed (${liveLeakPaths.join(", ")}) — named in the retry feedback and preserved for the partial stash` : ""}`);
						} else {
							ctx.log(`Implementation ${phaseId} inherited-red Tier 0 (own-leak): no revertable undeclared out-of-scope dirt — the leak rides the phase's in-scope edits (an in-scope product regression; the implementer retry carries the failure feedback)`);
						}
						if (attempt < maxPhaseAttempts() && ctx.budget.check()) {
							ctx.log(`Implementation ${phaseId} inherited-red Tier 0: retrying (the phase's own attempt budget is consumed — attempt ${attempt + 1} of ${maxPhaseAttempts()})`);
							continue;
						}
						ctx.log(`Implementation ${phaseId} inherited-red Tier 0: attempt budget exhausted (attempt ${attempt}/${maxPhaseAttempts()}) — the revert still ran; the phase ends partial and boundary logic proceeds (Tier-0 boundaries are metrics-only and never consume the occurrence tally)`);
					} else {
						// attribution === "inherited" — Tier 1 flake filter first.
						let tier1Gate: BuildGateResult | null = null;
						if (!inheritedRedFlakeGrantUsed) {
							inheritedRedFlakeGrantUsed = true;
							announceActivity("Inherited-red flake filter (Tier 1)", attemptDetail(attempt));
							tier1Gate = runBuildGate(setup.worktreePath, { gate: (state.spec?.gate) as GateOptions | undefined, signal: ctx.signal, defaultBranch: setup.defaultBranch });
							appendGateChecked(state, "phase-build:inherited-red-flake-rerun", tier1Gate, "implementation");
							const flakeCleared = tier1Gate.pass || tier1Gate.inScopePass;
							appendInheritedRedEvent(setup.specDirectory, { event: "flake-rerun", phaseId, outcome: flakeCleared ? "flake-cleared" : "still-red", baseline: baselineStatus }, ctx.log);
							ctx.log(`Implementation ${phaseId} inherited-red Tier 1 (flake filter): deterministic full-gate re-run → ${flakeCleared ? "GREEN" : "RED"} (the re-run NEVER consumes an implementer attempt; the per-run grant is now spent; flake tally ${inheritedRedFlakeTally(setup.specDirectory)})`);
							if (flakeCleared) {
								// Green-through on the re-run (the env-blocker T3.3 precedent):
								// own-scope evidence is green by the trigger shape, so the phase
								// is green — NOT inherited-red; metrics-only, the tally is never
								// consumed and a flake is never a retry reason.
								green = true;
								phaseStatusUpsert(phaseStatus, phaseId, "green", attempt); // v0.3.85 S3: peak-attempts metric
								emitPhaseStatus("ok");
								const _irfi = lastFailures.findIndex((f) => f.phaseId === phaseId); if (_irfi >= 0) lastFailures.splice(_irfi, 1);
								attemptErrors = tier1Gate.errors;
								ctx.log(`Implementation ${phaseId} ${tier1Gate.pass ? "GREEN" : "IN-SCOPE GREEN"} via inherited-red Tier 1 flake filter on attempt ${attempt} — flake cleared, not inherited-red (occurrence tally NEVER consumed)`);
								break;
							}
						} else {
							ctx.log(`Implementation ${phaseId} inherited-red Tier 1 (flake filter): per-run grant already spent — the classification stands without a re-run (flake tally ${inheritedRedFlakeTally(setup.specDirectory)})`);
						}
						// TIER 2 decision — occurrence accounting (ledger-backed, persists
						// across resume). Subjects come from the freshest gate (the Tier-1
						// re-run when it ran); the owning prior phase is derived from the
						// same Option-C scope predicate F4 uses (Arm A clause files ∪ Arm B
						// recorded failing paths of prior PARTIAL phases).
						const subjectsGate = tier1Gate ?? gate;
						// P1 (FIX ROUND 2, item-1 audit): never trust gate shapes at the
						// consumption sites either — the boundary shape already used
						// Array-guarded reads; mirror that here so a runtime gate with an
						// absent array cannot TypeError inside the Tier-2/3 subject naming.
						const irOos = Array.isArray(subjectsGate.outOfScopeErrors) ? subjectsGate.outOfScopeErrors : [];
						const irSubjects = [...new Set([...irOos, ...extractFailingTestFilePaths(irOos)])].slice(0, 6) as string[];
						const irOwner = f4ScopeMatch([...prePhaseDirt, ...extractFailingTestFilePaths(irOos)], phases as Array<Record<string, unknown>>, phaseStatus, idx, lastFailures);
						const priorOccurrences = countInheritedRedOccurrences(setup.specDirectory);
						const priorHandoffRows = countInheritedRedRows(setup.specDirectory);
						if (priorOccurrences >= 1 || priorHandoffRows >= 1) {
							// TIER 3 — second occurrence (or sub-cap spent by an F2/F4
							// trigger): FatalAbort naming the failing subjects + the owning
							// prior phase. The poisoned baseline propagated past the single
							// declared handoff — stop-the-line.
							appendInheritedRedEvent(setup.specDirectory, { event: "occurrence", phaseId, outcome: "tier3-fatal", subjects: irSubjects, attribution, baseline: baselineStatus }, ctx.log);
							ctx.log(`Implementation ${phaseId} inherited-red Tier 3: SECOND OCCURRENCE (prior occurrences=${priorOccurrences}, inherited-red handoff rows=${priorHandoffRows}) — FatalAbort naming the failing subjects + the owning prior phase (stop-the-line; no retry loop)`);
							throw new FatalAbort(`inherited-red second occurrence at ${phaseId} (v0.3.85 F2, ADR 9): gate failures are out-of-scope by attribution (baseline=${baselineStatus ?? "n/a"}; ${prePhaseDirt.length} pre-phase dirt path(s): ${prePhaseDirt.slice(0, 6).join(", ") || "none"}) — failing subjects: ${irSubjects.join(" | ").slice(0, 600)}; owning prior phase: ${irOwner ? `${irOwner.phaseId} (arm ${irOwner.arm}, ${irOwner.path})` : "unidentified (no prior partial phase's declared scope matches the poison paths — pre-run dirt)"}. The poisoned baseline already consumed the single declared handoff; stop-the-line.`);
						}
						// Occurrence #1 → TIER 2 declared handoff: one replan-requests.json
						// row (ownerStage:"spec" + source:"inherited-red" + sourcePhase) via
						// the existing triggerReplanForFindings circuit; consumes ONE round
						// of the shared SUPER_DEV_MAX_REPLAN_ROUNDS pool; the run ends
						// status "replan" and the amended plan must pass the plan-feasibility
						// validator before execution (§D re-entry).
						const irFinding: Record<string, unknown> = {
							id: `inherited-red-${phaseId}`,
							file: null,
							severity: "high",
							title: `inherited-red partial boundary at ${phaseId}: gate failures out-of-scope by attribution (baseline=${baselineStatus ?? "n/a"})`,
							detail: `The full-suite gate is red on failures outside this phase's declared targets, and attribution says they are NOT this phase's own: baseline=${baselineStatus ?? "n/a"}${prePhaseDirt.length ? `, ${prePhaseDirt.length} pre-phase dirt path(s) (${prePhaseDirt.slice(0, 6).join(", ")}) predating the phase's first-ever start` : ""}. Failing subjects: ${irSubjects.join(" | ").slice(0, 600)}. A prior phase left a poisoned baseline this phase cannot clear inside its declared scope — continuing forward-continues the poison (the C1 disease).`,
							ownerStage: "spec",
							source: INHERITED_RED_SOURCE,
							sourcePhase: phaseId,
							recommendation: "Merge the unfinished scope forward: amend the plan so the phase that owns the failing subjects' production change also owns the atomic test amendment (co-ownership in any clause form counts), or reorder/merge phases so the baseline this phase gates against is green when its turn comes.",
						};
						let irRouted = false;
						try { irRouted = await triggerReplanForFindings(state, ctx, [irFinding], "implementation", setup.specIdentifier ?? "unknown"); } catch { irRouted = false; }
						if (irRouted) {
							appendInheritedRedEvent(setup.specDirectory, { event: "occurrence", phaseId, outcome: "tier2-handoff-routed", subjects: irSubjects, attribution, baseline: baselineStatus }, ctx.log);
							terminalStopReason = "inherited-red";
							attemptErrors = [...attemptErrors, `inherited-red: gate failures out-of-scope by attribution (baseline=${baselineStatus ?? "n/a"}) — declared handoff routed (source:inherited-red, sourcePhase:${phaseId}); the run ends status "replan"`];
							ctx.log(`Implementation ${phaseId} inherited-red Tier 2 (declared handoff): occurrence 1 — replan-requests.json row routed via the shared replan pool (source:inherited-red, sourcePhase:${phaseId}, ownerStage:spec); consuming ONE SUPER_DEV_MAX_REPLAN_ROUNDS round; the phase ends partial and the run ends status "replan" (auto-resume → spec convergence regenerates the plan → plan-feasibility validator → §D re-entry)`);
							break;
						}
						// The handoff could not route (pool exhausted / marker set / write
						// failure): the occurrence still consumed the tally — routing
						// Tier 3 keeps the C1 disease from forward-continuing silently.
						appendInheritedRedEvent(setup.specDirectory, { event: "occurrence", phaseId, outcome: "handoff-unavailable", subjects: irSubjects, attribution, baseline: baselineStatus }, ctx.log);
						ctx.log(`Implementation ${phaseId} inherited-red Tier 2: declared handoff UNAVAILABLE (replan pool exhausted / marker set / ledger write failure) — the occurrence consumed the tally; routing Tier 3 FatalAbort (no retry loop)`);
						throw new FatalAbort(`inherited-red declared handoff unavailable at ${phaseId} (v0.3.85 F2, ADR 8/9): the replan circuit could not route while the gate is red on out-of-scope failures by attribution (baseline=${baselineStatus ?? "n/a"}). Failing subjects: ${irSubjects.join(" | ").slice(0, 600)}; owning prior phase: ${irOwner ? `${irOwner.phaseId} (arm ${irOwner.arm}, ${irOwner.path})` : "unidentified (pre-run dirt)"}. Stop-the-line — no retry loop.`);
					}
				}
				if (noProgress) {
					// v0.3.79 A2 (spec-25 run 14-14): a repeated signature + observed
					// phase-boundary reverts is a DETERMINISTIC contradiction — arm the
					// contradiction frame (replan-upstream offered) so the valve routes
					// plan revision instead of blind retries; the generic J9-b frame
					// stays when no revert was observed.
					const cfFrame = boundaryRevertHits > 0
						? contradictionFastFailFrame({ phaseId, phaseName: phases[idx]?.name ?? "", leakOwners: boundaryLeakOwners, leakFiles: boundaryLeakFiles, failureReasons })
						: null;
					// J9-b (judge routing layer): a verified diagnosis at the no-progress
					// boundary, BEFORE the human is asked. challenge-test synthesizes the
					// defect the implementer failed to report structurally and re-runs the
					// EXISTING challenge edge; re-author-tests drops acceptedRed and restarts
					// with the diagnosis; continue grants one fresh attempt with the
					// diagnosis as guidance. escalate-now / discarded / degraded falls
					// through to today's HITL (with the diagnosis surfaced when verified).
					const judgeOut = await runJudge(ctx, {
						scope: `stage9.impl-no-progress.${phaseId}`,
						signature: progressSignature.failure,
						worktreePath: setup.worktreePath,
						specDirectory: setup.specDirectory,
						context: [
							...(cfFrame ? [cfFrame.context] : []),
							faultRecurrence && !signatureRepeat
								? `## Recurring failure-category (${attemptFaultClass} across ${faultClassStreak?.count ?? 0} consecutive attempts — signatures are fresh, the CLASS repeats)`
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
						allowedRoutes: cfFrame ? (cfFrame.allowedRoutes as JudgeRoute[]) : ["challenge-test", "re-author-tests", "continue"],
						outputTails: [implTextTail, ...failureReasons],
					});
					if (judgeOut.status === "routed" && judgeOut.verdict.route === "replan-upstream") {
						// v0.3.79 A2: the contradiction valve's plan-revision route —
						// route the replan with the contradiction finding and stop this
						// pass (shouldIterateImplementation gates the re-entry; the
						// extension restarts under the revised spec).
						const contradictionFinding = {
							file: null,
							severity: "high",
							title: `plan contradiction at ${phaseId}: phase-boundary BLOCKING reverts block the only satisfiable fix`,
							detail: `Repeated identical failures while the engine reverted out-of-scope edits into later-phase deliverables (${boundaryLeakFiles.join(", ") || "n/a"} owned by ${boundaryLeakOwners.join(", ") || "later phases"}). Judge diagnosis: ${judgeOut.verdict.diagnosis}`,
							ownerStage: "spec",
						};
						let contradictionReplanned = false;
						try { contradictionReplanned = await triggerReplanForFindings(state, ctx, [contradictionFinding], "implementation", setup.specIdentifier ?? "unknown"); } catch { contradictionReplanned = false; }
						if (contradictionReplanned) {
							redJudgeDiagnosis = judgeOut.verdict.diagnosis;
							terminalStopReason = "no-progress";
							ctx.log(`Implementation ${phaseId} judge route=replan-upstream: contradiction routed to REPLAN (plan revision) — stopping this pass (${boundaryRevertHits} boundary revert(s) observed)`);
							break;
						}
					}
					if (judgeOut.status === "routed" && judgeOut.verdict.route === "challenge-test" && acceptedRed && challengeReauthors < MAX_CHALLENGE_REAUTHORS) {
						challengeReauthors++;
						const defect = {
							// v0.2.11 F1b: when the verdict carries no machine-verifiable evidence
							// (the missing-evidence exemption class), the diagnosis usually names
							// the culprit test verbatim (run 14-54: the stale spec-01 pin at
							// tests/interface-contracts-ownership.test.ts:618) — prefer that over
							// the phase's own RED file, which is NOT the defect in the
							// cross-spec-contradiction class.
							testFile: judgeOut.verdict.evidence[0]?.file ?? firstCitedTestFile(judgeOut.verdict.diagnosis) ?? acceptedRed.testFiles[0] ?? "",
							lines: "",
							reason: `judge-verified: ${judgeOut.verdict.diagnosis}`,
						};
						reauthorEvidence = formatReauthorEvidence([defect], implTextTail);
						attemptProgressHistory = [];
						acceptedRed = null;
						ctx.log(`Implementation ${phaseId} judge route=challenge-test: re-authoring RED with the verified diagnosis (${challengeReauthors}/${MAX_CHALLENGE_REAUTHORS})`);
						continue;
					}
					if (judgeOut.status === "routed" && judgeOut.verdict.route === "re-author-tests") {
						acceptedRed = null;
						attemptProgressHistory = [];
						reauthorEvidence = `\n\n## Judge diagnosis (verified evidence — the RED must be re-authored)\n${judgeOut.verdict.diagnosis}\nEvidence: ${judgeOut.verdict.evidence.map((e) => `${e.file}: ${e.quote}`).join(" | ")}`;
						ctx.log(`Implementation ${phaseId} judge route=re-author-tests: restarting RED with the diagnosis`);
						continue;
					}
					if (judgeOut.status === "routed" && judgeOut.verdict.route === "continue") {
						attemptProgressHistory = [];
						judgeGuidance = `## Judge guidance for this attempt (verified diagnosis — act on it)\n${judgeOut.verdict.diagnosis}\nEvidence: ${judgeOut.verdict.evidence.map((e) => `${e.file}: ${e.quote}`).join(" | ")}`;
						ctx.log(`Implementation ${phaseId} judge route=continue: one fresh attempt with diagnosis guidance`);
						continue;
					}
					if (judgeOut.status === "routed" || judgeOut.status === "escalate") {
						implJudgeDiagnosis = `${judgeOut.verdict.diagnosis}\nEvidence: ${judgeOut.verdict.evidence.map((e) => `${e.file}: ${e.quote}`).join(" | ")}`;
				implJudgeEvidenceLabel = judgeOut.status === "escalate" && judgeOut.verdict.evidence.length === 0 ? "escalated — evidence unverified" : "verified evidence";
					}
					// HITL escalation (parity with gate-exhaustion + verify-stagnation):
					// repeated identical failure is exactly where a human decision helps —
					// often an unsatisfiable gate contradiction or a spec ambiguity, not a
					// fixable code gap. Before the silent phase-fail (which abandons all
					// later phases), give the user a chance to inject guidance and continue.
					// Bounded by ESCALATION_RETRY_CAP; never throws; a dismissal/headless
					// run falls straight through to the pre-existing no-progress break.
					// J3 (run 2026-08-19T03-16-50-261Z): the deterministic test-defect
					// signature — the phase's RED targets NEVER went green across the
					// repeated no-progress attempts (tdd-targets-still-red) — identical
					// failure+footprint signature across attempts, no net progress. "A test that fails consistently is not flaky —
					// it is broken": surface the hypothesis and the legal next actions at
					// the human boundary (escalation message/findings) and in the terminal
					// stop log. Advisory only — never auto-triggers a re-author (the judge
					// stays the actuator for that verdict).
					const stillRedSuspect = failureReasons.some((r) => r.includes("tdd-targets-still-red"));
					const escalate = (ctx as { options?: { escalate?: import("../types.ts").Escalate } }).options?.escalate;
					if (escalate) {
						try {
							const { runEscalation, applyRetryDecision } = await import("../escalation.ts");
							// Fix 3 — evidence conservation at the human boundary: when the
							// structured challenge channel yielded nothing (no testDefects — the
							// v0.1.52 inert-channel case, or an attempt that timed out with
							// control=no and never called structured_output), the implementer's
							// LAST reasoning text may still carry the impossibility proof. Surface
							// it raw (already bounded to trimImplementerText's 1200-char tail);
							// the user must never have to guess that a proof exists.
							const implDiagnosisTail = implDefects.length === 0 ? implTextTail.trim() : "";
							// Fix 5 — advisory-only text-proof heuristic: flag (never auto-trigger)
							// when the tail claims unsatisfiability while failing a confirmed RED.
							const textProofSuspect = implDiagnosisTail.length > 0 && acceptedRed !== null && UNSATISFIABLE_TEXT_RE.test(implDiagnosisTail);
							if (textProofSuspect) {
								ctx.log(`Implementation ${phaseId} advisory: implementer text matches unsatisfiability markers without structured testDefects — surfacing the reasoning tail to the user (no automatic re-author from text alone)`);
							}
							const failure: import("../types.ts").EscalationFailure = {
								kind: "stagnation",
								stage: "implementation",
								message: `Implementation phase "${phaseName}" made no progress across consecutive attempts — the same failure recurred after a change. This is often an unsatisfiable RED test, a gate contradiction, or a spec ambiguity.${implDefects.length ? ` THE IMPLEMENTER REPORTS THE RED TEST IS UNSATISFIABLE: ${implDefects.map((d) => `${d.testFile}${d.lines ? ` (${d.lines})` : ""}: ${d.reason}`).join("; ")}.` : ""}${implDiagnosisTail ? `${textProofSuspect ? " POSSIBLE UNSATISFIABLE RED (text evidence only — unverified):" : ""}\n\nImplementer's latest diagnosis (reasoning tail):\n${implDiagnosisTail}` : ""}${implJudgeDiagnosis ? `\n\nJUDGE DIAGNOSIS (${implJudgeEvidenceLabel}):\n${implJudgeDiagnosis}` : ""}${stillRedSuspect && implDefects.length === 0 ? "\n\nDETERMINISTIC TEST-SUSPECT SIGNAL: the phase's RED targets never went green across these repeated no-progress attempts (tdd-targets-still-red). The RED test itself may be unsatisfiable (defective). Legal next actions: re-author the RED with this failure evidence (retry-with-guidance), fix the environment, or accept the limitation." : ""} Inspect the recurring failures or provide explicit guidance before the phase is abandoned.`,
								severity: "soft",
								findings: [
									...(implJudgeDiagnosis ? [{ file: null, severity: null, title: `judge diagnosis: ${implJudgeDiagnosis.split("\n")[0].slice(0, 200)}` }] : []),
									...(implDefects.map((d) => ({ file: d.testFile, severity: null, title: `unsatisfiable: ${d.reason}` }))),
								// J3: the deterministic still-red signal rides even when the
								// implementer reported nothing — classification must be explicit,
								// never silent.
								...(stillRedSuspect ? [{ file: null, severity: null, title: "test-suspect (deterministic): RED targets never went green across repeated no-progress attempts — the RED itself may be unsatisfiable; re-author it with this evidence, fix the environment, or accept the limitation" }] : []),
									// The diagnosis finding leads the failure reasons so it survives the
									// 12-entry slice — it is the highest-value evidence for the decision.
									...(implDiagnosisTail ? [{ file: null, severity: null, title: `implementer diagnosis: ${implDiagnosisTail.split("\n")[0].slice(0, 200)}` }] : []),
									...failureReasons.slice(0, 12).map((r) => ({ file: null, severity: null, title: r })),
								].slice(0, 12),
								worktreePath: setup.worktreePath,
								specDirectory: setup.specDirectory,
							};
							const decision = await runEscalation(state, failure, escalate);
							if (decision) {
								applyRetryDecision(state, decision, { worktreePath: setup.worktreePath, specDirectory: setup.specDirectory });
								if (decision.choice === "retry-with-guidance" && ctx.budget.check()) {
									// Reset the no-progress window so the guided attempt is judged
									// fresh (not instantly re-flagged against the pre-guidance signature),
									// and drop the accepted RED so guidance can reshape tests too.
									// Carry the implementer's diagnosis so the guided re-author is
									// evidence-backed, not blind (parity with the challenge edge). Even
									// without structured testDefects, a model that proved the test
									// unsatisfiable only in its .text reasoning still gets that proof
									// routed to the RED author.
									reauthorEvidence = formatReauthorEvidence(implDefects, implTextTail);
									attemptProgressHistory = [];
									acceptedRed = null;
									ctx.log(`Implementation ${phaseId} no-progress escalation: retrying with user guidance`);
									continue;
								}
							}
						} catch { /* never-throw: fall through to the terminal break */ }
					}
					terminalStopReason = "no-progress";
					ctx.log(`Implementation ${phaseId} stopped after ${faultRecurrence && !signatureRepeat ? `failure-category recurrence (${attemptFaultClass} × ${faultClassStreak?.count ?? 0} consecutive attempts — fresh footprints, same class)` : "repeated no-progress failure"} on attempt ${attempt}: ${failureReasons.join("; ") || "phase gates unmet"}${stillRedSuspect ? " [test-suspect: RED targets never went green across repeated no-progress attempts — the RED itself may be unsatisfiable; re-author it with this evidence or accept the limitation]" : ""}`);
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
			if (!green) {
				// §D: record the failure so the next convergence iteration targets it
				const terminalReasons = [
					...attemptErrors,
					// review-2 F8: the judge's verified diagnosis (fix-environment /
					// no-progress terminal stops) reaches the convergence record —
					// without it, environment-blocked phases surface only generic
					// red-unverified strings downstream.
					...(redJudgeDiagnosis ? [`judge diagnosis: ${redJudgeDiagnosis.slice(0, 400)}`] : []),
					...missingDeliverables.map((e) => `deliverable: ${e}`),
					...claimedNotChanged.map((e) => `claimed-not-changed: ${e}`),
					...hollowFiles.map((e) => `hollow-file: ${e}`),
				];
				recordImplementationConvergenceFailure(state, { phaseId, phaseName, kind: terminalFailureKind, attemptsRun, reasons: terminalReasons });
				// v0.3.0 (harness research): a failed phase NEVER terminates the run
				// anymore. The five track-07 deaths all ended PARTIAL 0/N with hours
				// of green doc/code work discarded; every external harness ends runs
				// with the best attempt preserved (SWE-agent get_best, Anthropic
				// git-per-increment, Ralph workspace-as-memory). The phase is marked
				// `partial`, its best attempt is stash-preserved, and the pipeline
				// CONTINUES to the next phase; the outer §D convergence loop re-enters
				// non-green phases for another bounded pass until allGreen or the
				// global budget fuse.
				preservePartialPhase(ctx, setup, phaseId, phaseName, terminalStopReason === "no-progress" ? "no-progress" : terminalStopReason === "budget" ? "budget" : terminalStopReason === "environment-blocked" ? "environment-blocked" : terminalStopReason === "phase-attempt-cap" ? "phase-attempt-cap" : terminalStopReason === "phase-wall" ? "phase-wall" : terminalStopReason === "wall-fuse" ? "wall-fuse" : terminalStopReason === "inherited-red" ? "inherited-red" : terminalStopReason === "declared-handoff" ? "declared-handoff (f4)" : terminalStopReason === "red-weakening" ? "red-weakening" : "gates-unmet"); // review-2 F8: keep the honest reason (v0.3.85 F3: the three bound reasons pass through verbatim; v0.3.85 F2/F4: the handoff reasons pass through named; v0.3.85 F5: the red-weakening handoff reason passes through named)
			if (terminalStopReason === "environment-blocked") envBlockedPhases.add(phaseId);
				{
					const sig = terminalReasons.join("; ").slice(0, 200);
					const prior = phaseStatus.find((p) => p.id === phaseId);
					const sameSig = prior?.status === "partial" && prior.lastFailureSig === sig;
					phaseStatusUpsert(phaseStatus, phaseId, "partial", attemptsRun); // v0.3.85 S3: peak-attempts metric
					const entry = phaseStatus.find((p) => p.id === phaseId)!;
					entry.lastFailureSig = sig;
					entry.partialReEntries = sameSig ? (prior?.partialReEntries ?? 0) + 1 : 0;
				}
				emitPhaseStatus("partial");
				lastFailuresUpsert(lastFailures, phaseId, [
					...attemptErrors,
					...missingDeliverables.map((e) => `deliverable: ${e}`),
					...claimedNotChanged.map((e) => `claimed-not-changed: ${e}`),
					...hollowFiles.map((e) => `hollow-file: ${e}`),
				]);
				if (terminalFailureKind === "red-generation") {
					ctx.log(`Implementation ${phaseId} partial (RED generation stopped after ${terminalRedTries} tries in attempt ${attemptsRun}${terminalStopReason === "no-progress" ? ", no progress" : terminalStopReason === "budget" ? ", budget exhausted" : terminalStopReason === "environment-blocked" ? ", environment blocked (fix is outside this worktree — judge diagnosis above)" : terminalStopReason === "red-weakening" ? " (red-weakening — declared handoff routed; the run ends status replan)" : ""}) — continuing to the next phase`); // review-2 F8
				} else {
					ctx.log(`Implementation ${phaseId} partial after ${attemptsRun} attempt(s)${terminalStopReason === "no-progress" ? " (no progress)" : terminalStopReason === "budget" ? " (budget exhausted)" : terminalStopReason === "environment-blocked" ? " (environment blocked — judge diagnosis above)" : terminalStopReason === "phase-attempt-cap" ? " (phase-attempt-cap)" : terminalStopReason === "phase-wall" ? " (phase wall budget exhausted)" : terminalStopReason === "wall-fuse" ? " (wall-fuse — run wall budget exhausted; resumable by design)" : terminalStopReason === "inherited-red" ? " (inherited-red — declared handoff routed; the run ends status replan)" : terminalStopReason === "declared-handoff" ? " (declared-handoff (f4) — the run ends status replan)" : ""} — continuing to the next phase`); // review-2 F8
				}
				allGreen = false;
				if (worktreeGone) break; // v0.3.57 liveness: no further phase can run in a deleted worktree
				continue;
			}
			phasesCompleted++;
			if (ctx.budget.check()) {
				announceActivity("Commit");
				// v0.3.43: engine-side deterministic commit (RC4). Falls back to the
				// orchestrator agent for in-place runs / kill-switch / git failures.
				const commitOutcome = deterministicPhaseCommit(setup.worktreePath, {
					phaseIndex: idx + 1,
					totalPhases: phases.length,
					phaseName,
					worktreeCreated: (setup as { worktreeCreated?: boolean }).worktreeCreated,
					gateSummary: ["build green", "deliverables met", "TDD oracle green"].join("; "),
				});
				if (commitOutcome.status === "committed") {
					ctx.log(`Implementation ${phaseId} deterministic commit: ${commitOutcome.sha ?? "(sha unknown)"} — ${commitOutcome.reason}`);
				} else if (commitOutcome.status === "skipped") {
					ctx.log(`Implementation ${phaseId} commit skipped: ${commitOutcome.reason}`);
				} else {
					ctx.log(`Implementation ${phaseId} deterministic commit fell back to the orchestrator agent: ${commitOutcome.reason}`);
					await ctx.agent({ id: `pipeline.implementation.${phaseId}.commit`, agent: "orchestrator", prompt: buildCommitPrompt(setup, phase.name) });
				}
			}
		}
		// v0.3.80 B2 — stage-close re-verification (commit fusion): gate-window expiry
		// can end a phase PARTIAL with its work already landed; the stage verdict must
		// reflect the tree, not the stale gate window. Dual-review hardening: the flip
		// requires an affirmative clause + a clause file changed THIS RUN (vs the merge
		// base — pre-existing content cannot flip) + the stage build gate + a FULL
		// runDeliverableCheck per flippable (deliverablesAlreadyMet now verifies
		// requireTests at existence grade; execution authority stays here — F-04,
		// v0.3.86); flipped phases splice lastFailures and get their deterministic
		// commit like every other green path (review F3).
		{
			const changedThisRun = new Set<string>();
			try {
				const mergeBase = String(spawnSync("git", ["-C", setup.worktreePath, "merge-base", "HEAD", setup.defaultBranch], { encoding: "utf8", timeout: 10_000 }).stdout ?? "").trim();
				if (mergeBase) {
					const diffOut = String(spawnSync("git", ["-C", setup.worktreePath, "diff", "--name-only", mergeBase, "HEAD"], { encoding: "utf8", timeout: 15_000 }).stdout ?? "");
					const statusOut = String(spawnSync("git", ["-C", setup.worktreePath, "status", "--porcelain"], { encoding: "utf8", timeout: 10_000 }).stdout ?? "");
					for (const line of diffOut.split("\n")) if (line.trim()) changedThisRun.add(leakNorm(line.trim()));
					for (const line of statusOut.split("\n")) {
						const rel = line.slice(3).trim().replace(/^"|"$/g, "");
						if (rel && !rel.includes(" -> ")) changedThisRun.add(leakNorm(rel));
					}
				}
			} catch { /* changed-set is a hardening input, not a gate — empty set degrades to the pre-hardening behavior for absorbed-work detection */ }
			const reverify = reverifyPartialPhases(phases as unknown as Array<Record<string, unknown>>, phaseStatus as Array<{ id: string; status: string }>, setup.worktreePath, setup.defaultBranch, envBlockedPhases, changedThisRun);
			for (const skipped of reverify.skippedVacuous) ctx.log(`Implementation stage-close re-verification: ${skipped} — keeping PARTIAL (honest)`);
			if (reverify.flippable.length > 0) {
				ctx.phase("Stage 9 — Implementation — stage-close re-verification");
				resetDeliverableCheckCache();
				const closeGate = runBuildGate(setup.worktreePath, { gate: (state.spec?.gate) as GateOptions | undefined, signal: ctx.signal, defaultBranch: setup.defaultBranch });
				appendGateChecked(state, "stage-close-reverify", closeGate, "implementation");
				if (closeGate.pass || closeGate.inScopePass) {
					for (const f of reverify.flippable) {
						const rvDeliverables = (phases[f.index] as { deliverables?: DeliverableContract }).deliverables;
						const rvCheck = rvDeliverables
							? runDeliverableCheck(setup.worktreePath, rvDeliverables, { signal: ctx.signal, skipTests: false, defaultBranch: setup.defaultBranch })
							: null;
						if (rvCheck && !rvCheck.pass) {
							ctx.log(`Implementation ${f.id} stage-close re-verification: deliverablesAlreadyMet passed but the FULL deliverable check FAILED (missing: ${rvCheck.missing.slice(0, 3).join("; ")}) — keeping PARTIAL (honest; requireTests/scenario sweep authoritative)`);
							continue;
						}
						ctx.log(`Implementation ${f.id} stage-close re-verification: deliverables satisfied at close (full check + build gate green) — marking GREEN (gate-window expiry had left landed work unverified; commit fusion)`);
						phaseStatusUpsert(phaseStatus, f.id, "green");
						phasesCompleted++;
						lastFailures = lastFailures.filter((e) => !e.phaseId || e.phaseId !== f.id); // review F3: a green phase carries no stale failure row
						if (ctx.budget.check()) {
							const commitOutcome = deterministicPhaseCommit(setup.worktreePath, {
								phaseIndex: f.index + 1,
								totalPhases: phases.length,
								phaseName: String((phases[f.index] as { name?: unknown })?.name ?? f.id),
								worktreeCreated: (setup as { worktreeCreated?: boolean }).worktreeCreated,
								gateSummary: "stage-close re-verification: build green; deliverables met (full check)",
							});
							ctx.log(`Implementation ${f.id} stage-close commit: ${commitOutcome.status} — ${commitOutcome.reason}`);
						}
					}
					if (phaseStatus.length === phases.length && phaseStatus.every((p) => p.status === "green")) allGreen = true; // review P3: never claim all-green over an entry subset (REPLAN break leaves later phases without entries)
				} else {
					ctx.log(`Implementation stage-close re-verification: ${reverify.flippable.length} partial phase(s) have satisfied deliverables but the stage build gate FAILED — keeping PARTIAL (honest)`);
				}
			}
		}
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
			inheritedRedFlakeGrantUsed,
			phaseGuidanceReentryUsed,
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
