import { LeakPhase, leakNorm, quoteCmdArg, redRePromptHint } from "./phase-reentry.ts";
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
import { superDevEnv } from "../../render/super-dev-dir.ts";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ControlObj, PipelineState, StageContext } from "../../types.ts";

// v0.3.73 M1: re-exported for the salvage seam + tests.
export type { BoundaryQuarantinePayload } from "../../types.ts";
import { getActiveTracker, isHarnessBookkeepingPath, isInternalRuntimeClaim } from "../../tracking.ts";
import type { ChangeRecord, StructuredChanges } from "../../tracking.ts";
import { localTimestamp } from "../../render/time.ts";
import { buildRedBoundaryPrompt, classifyObviousRedPath, isRuntimeEvidencePath, isSubstrateArtifact, redBoundaryResultFromAgent, redBoundaryResultFromClassifications, type RedBoundaryResult } from "../../test-artifacts.ts";
// v0.3.85 F2 Tier 3 / F4 sub-cap + the validator hard-fail override: the
// stop-the-line terminal (ADR 9) and the restart-state pending-row probe.
import { INHERITED_RED_SOURCE } from "../inherited-red.ts";
// v0.3.87 S4(b)+(d) (§9/§10 decision 9, §13, §14 ADR 6): the engine-mediated
// research assist — pure helpers + ledger + the one dispatch seam. §13:
// "research-assist" is a CONFIG ROLE KEY ONLY; the dispatch reuses
// research-agent, no agent file is created.
import { contradictionFastFailFrame } from "../plan-feasibility.ts";
// 065 D-F-D/D-F-F: the Stage-9-entry gate (write×protect cross-product +
// plan compile-time checks) — two-locus mechanical findings routed through
// the SAME replan circuit plan-feasibility uses (no judge call needed).
import { TddCoverageControlData, FileClassifyControlData } from "../../render/schemas.ts";
import { extractScenarioIds, extractScenarioRefsFromControl } from "../../doc-validators.ts";
import { normalizeSlash, snapshotFiles, changedSinceSnapshot, restoreRedTestFiles } from "./red-snapshot.ts";
import { uniqueScenarioIds, scenarioIdsFromUnknown, resolveTddScenarioCoverage, resolveRedBoundary, type TddCoverageResult } from "./red-boundary.ts";
export { resolveTddScenarioCoverage, resolveRedBoundary, boundarySummary } from "./red-boundary.ts";
export { snapshotFiles, assertionPresenceGaps, RED_WEAKENING_SOURCE, assertionSurfaceCount, weakenedAssertionSurfaces, preexistingTestSurfaceRows, changedSinceSnapshot, restoreRedTestFiles, type AssertionSurfaceRow, type WeakenedAssertionSurface } from "./red-snapshot.ts";
import { type RedCheckDiagnostic, type RedStatus } from "../../build-runner.ts";
import { renderRetryFeedbackBlock, type RetryFeedback } from "../../retry-feedback.ts";
import { recordConvergenceFindings, type ConvergenceOwnerStage } from "../../convergence-ledger.ts";
import { stripVolatileNoise, type FaultClass } from "../../fault-classification.ts";
import { phaseClauseFiles } from "../plan-feasibility.ts";
// v0.3.30 Layer C: agent-proposed runner discovery (machine-verified + cached).
// Wave 3 (058 §4 D-B/D-D, v0.3.99): Layer-2 protection intervals + Layer-4 checkpoint rollback.
import { stateFileFor } from "../../state/state-root.ts";

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

export interface AcceptedRedContext {
	status: RedStatus;
	testFiles: string[];
	changedFiles: string[];
}

export interface ProgressSignature {
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

export function failureSignature(reasons: string[]): string {
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

export function changeFootprint(record: ChangeRecord | null, changes: StructuredChanges): string {
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

export function repeatedNoProgress(history: ProgressSignature[], next: ProgressSignature): boolean {
	// H3 (spec-28, AC-03 → SCENARIO-006/007): ANY earlier matching entry is
	// non-progress — A→B→A→B oscillation slipped the old consecutive-only
	// (`history[last]`) check forever because every attempt differed from the
	// immediately-preceding one. Mirrors the RED loop's
	// `redProgressHistory.includes(signature)` (RC-3). Empty history ⇒ false —
	// the first attempt is never no-progress, and strictly fresh signatures
	// (A,B,C,D,…) never trip (escalation paths untouched).
	return history.some((h) => h.failure === next.failure && h.footprint === next.footprint);
}

/** Wave P1 D-C (docs/requirements/058-cross-phase-contract-architecture.md
 * Layer 3, DEC-3): zero-change plateau predicate — the attempt's landed
 * change set is EMPTY (all three change classes empty). Parses exactly the
 * JSON `changeFootprint` emits; anything unparseable is NOT empty (fail
 * toward the normal loop, never a false plateau). Pure. */
export function landedFootprintIsEmpty(footprint: string): boolean {
	try {
		// P6: BOTH footprint key families are the same grammar — the gitActual
		// path emits created/modified/deleted, the structured-claims path emits
		// filesCreated/filesModified/filesDeleted (structuredFootprint). A key
		// being absent means nothing landed in that class (empty), not "unknown".
		const parsed = JSON.parse(footprint) as Record<string, unknown>;
		const classes = ["created", "modified", "deleted", "filesCreated", "filesModified", "filesDeleted"];
		return classes.every((k) => {
			const v = parsed[k];
			return v === undefined || (Array.isArray(v) && v.length === 0);
		});
	} catch {
		return false;
	}
}

/** Wave P1 D-C: one cross-scope contract-conflict attribution row. */
export interface CrossScopeCitation {
	/** Repo-normalized cited failing test file. */
	file: string;
	/** The OTHER phase(s) whose requireTests scope declares the file. */
	ownerPhases: string[];
}

/** Wave P1 D-C (Layer 3, the S-A class): cross-scope contract-conflict
 *  attribution — the failure's cited failing test file(s) vs the plan's
 *  per-phase requireTests mapping. A citation CONFLICTS iff the file sits
 *  inside ANOTHER phase's requireTests scope AND outside the current phase's
 *  own declared scope (the canonical phaseClauseFiles grammar — a file the
 *  current phase co-declares through ANY clause form is same-scope and keeps
 *  the normal loop; P6). Pure; never throws. */
export function crossScopeTestCitations(citedTestFiles: readonly string[], phases: readonly LeakPhase[], currentIndex: number): CrossScopeCitation[] {
	const ownScope = new Set(phaseClauseFiles(phases[currentIndex] as never).map(leakNorm));
	const out: CrossScopeCitation[] = [];
	for (const raw of citedTestFiles) {
		const file = leakNorm(String(raw ?? ""));
		if (!file || ownScope.has(file)) continue;
		const ownerPhases: string[] = [];
		for (let j = 0; j < phases.length; j++) {
			if (j === currentIndex) continue;
			if ((phases[j]?.deliverables?.requireTests ?? []).some((t) => leakNorm(t) === file)) {
				ownerPhases.push(phases[j]?.name?.trim() || `phase-${j + 1}`);
			}
		}
		if (ownerPhases.length > 0 && !out.some((c) => c.file === file)) out.push({ file, ownerPhases });
	}
	return out;
}

/** Wave P1 D-C: the judge frame for a cross-scope contract conflict — the
 *  goal is unsatisfiable inside this phase's declared scope, so the budget is
 *  not consumed on it (first occurrence routes immediately). Mirrors
 *  contradictionFastFailFrame's shape (context + allowed routes). Pure. */
export function crossScopeContractConflictFrame(input: { phaseId: string; phaseName: string; citations: CrossScopeCitation[] }): { context: string; allowedRoutes: string[] } {
	const lines = [
		"## Cross-scope contract conflict (unsatisfiable within this phase)",
		`Phase ${input.phaseId}${input.phaseName ? ` (${input.phaseName})` : ""} failed on test file(s) that belong to ANOTHER phase's requireTests scope:`,
		...(input.citations.length
			? input.citations.map((c) => `- ${c.file} — declared requireTests of ${c.ownerPhases.join(", ")}`)
			: ["- (citation list empty)"]),
		"",
		"The failure cites a contract this phase cannot satisfy inside its declared scope: every satisfiable fix edits files the phase-boundary guard BLOCKS and reverts, so further attempts cannot produce improving signal. Route replan-upstream so the plan is revised (merge the scopes, hand off the contract, or reorder the phases), or re-author/challenge the test if the citation itself is defective.",
	];
	return { context: lines.join("\n"), allowedRoutes: ["replan-upstream", "challenge-test", "re-author-tests", "continue"] };
}

/** v0.3.85 F3 (decision 4): failure-category recurrence — advance the
 * consecutive-same-FaultClass streak. Module-scope PURE helper deliberately:
 * the attempt loop's control flow (initial reading + re-classification
 * assignments inside the environmental-blocker branch) CFA-narrows a `let`
 * FaultClass to `never` at the streak-update site; function parameters carry
 * their declared types, immune to that narrowing history. Same shape as
 * `repeatedNoProgress` above. */
export function nextFaultStreak(
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

export function setDiff(after: Set<string>, before: Set<string>): string[] {
	return [...after].filter((p) => !before.has(p)).sort();
}

function listOrNone(values: string[]): string {
	return values.length ? values.join(", ") : "none";
}

export function redEvidenceLogLine(e: RedEvidence): string {
	const boundary = e.boundary ? ` ambiguousFiles=${listOrNone(e.boundary.ambiguousFiles)}` : "";
	const coverage = e.missingScenarios?.length ? ` missingScenarios=${listOrNone(e.missingScenarios)}` : "";
	const diagnostics = e.diagnostics?.length ? ` diagnostics=${e.diagnostics.length}` : " diagnostics=none";
	return `Implementation ${e.phaseId} RED gate evidence: status=${e.status} oracle=${e.oracleStatus} retries=${e.redRetries} testFiles=${listOrNone(e.testFiles)} changedFiles=${listOrNone(e.changedFiles)} forbiddenFiles=${listOrNone(e.forbiddenFiles)}${boundary}${coverage}${diagnostics}`;
}

function phaseTaskDescriptions(specControl: ControlObj | null | undefined, phaseName: string): string[] {
	const tasks = Array.isArray(specControl?.tasks) ? specControl.tasks as Array<Record<string, unknown>> : [];
	return tasks
		.filter((task) => typeof task.phase === "string" && task.phase.trim() === phaseName)
		.map((task) => String(task.description ?? "").trim())
		.filter(Boolean);
}

export function expectedScenariosForPhase(phase: unknown, specControl: ControlObj | null | undefined, bddControl: ControlObj | null | undefined): string[] {
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

export function implementationRetrySection(heading: string, feedback: Omit<RetryFeedback, "stage">): string {
	return renderRetryFeedbackBlock([{ stage: "implementation", ...feedback }], heading);
}

function toStringArr(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

/** Out-of-scope edits: changed tracked+untracked files OUTSIDE the phase's
 *  declared clause scope (canonical phaseClauseFiles grammar, v0.3.80 B1) and
 *  outside the RED test files. Advisory input for the leak classifier. */
export function trackerOutofScopeEdits(tracker: ReturnType<typeof getActiveTracker>, worktreePath: string, declaredScope: Set<string>, redTestFiles: string[]): string[] {
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

export function restoreUnacceptedRedChanges(ctx: StageContext, cwd: string, phaseId: string, paths: string[]): void {
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

export function appendImplementationEvidence(specDir: string | undefined, evidence: RedEvidence): void {
	if (!specDir) return;
	try {
		mkdirSync(specDir, { recursive: true });
		appendFileSync(stateFileFor(specDir, "implementation-evidence.jsonl"), JSON.stringify({ ts: localTimestamp(), ...evidence }) + "\n");
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

export function formatRedDiagnosticSummary(d: RedCheckDiagnostic): string {
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

export function recordImplementationConvergenceFailure(
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

export function redDiagnosticsPrompt(diagnostics: RedCheckDiagnostic[] | undefined): string {
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



export const pad = (n: number) => String(n).padStart(2, "0");

/** Hard ceiling on RED-generation tries within one implementation attempt (RC-3).
 *  Cycle detection handles oscillation; this bounds a non-repeating drift the
 *  signature hash might not catch, so a phase can never spin ~indefinitely on the
 *  global budget alone (the 47-retry/15h livelock). Env-overridable for tuning. */
export const MAX_RED_RETRIES = (() => {
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
export const MAX_RED_ENV_RESTARTS = (() => {
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
