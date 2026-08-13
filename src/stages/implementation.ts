/**
 * Stage 9 — Implementation (per-phase TDD).
 * Self-contained task: iterates the spec's phased task list. For each phase,
 * runs TDD-write → implement → build-gate until the phase is green, the global
 * run budget is exhausted, or the same actionable failure repeats with no
 * observable progress.
 * The build-gate is the DETERMINISTIC hard oracle (build-runner.ts) that
 * replaces the old QA self-report — no more vacuous pass on "agent said green".
 */

import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ControlObj, PipelineState, Stage, StageContext } from "../types.ts";
import { getActiveTracker, isInternalRuntimeClaim } from "../tracking.ts";
import type { ChangeRecord, StructuredChanges } from "../tracking.ts";
import { localTimestamp } from "../render/time.ts";
import { buildRedBoundaryPrompt, classifyObviousRedPath, redBoundaryResultFromAgent, redBoundaryResultFromClassifications, type RedBoundaryResult } from "../test-artifacts.ts";
import { buildTddPrompt, buildImplementPrompt, buildCommitPrompt, buildImplementationSummaryPrompt, buildRedReviewPrompt, rustDiscipline } from "../prompts.ts";
import { renderAndWrite } from "../render/render.ts";
import { STAGE_MODELS, RedReviewData as RED_REVIEW_SCHEMA } from "../render/schemas.ts";
import { userNotesForAgent } from "../render/user-notes.ts";
import { extractScenarioIds, extractScenarioRefsFromControl, normalizePhases } from "../doc-validators.ts";
import { computeChangeGate, computeSymbolGate, deliverablesAlreadyMet, resetDeliverableCheckCache, runBuildGate, buildGateCorrelationLine, runDeliverableCheck, runRedCheck, type DeliverableContract, type GateOptions, type RedCheckDiagnostic, type RedCheckPlan, type RedStatus } from "../build-runner.ts";
import { renderRetryFeedbackBlock, type RetryFeedback } from "../retry-feedback.ts";
import { recordConvergenceFindings, type ConvergenceOwnerStage } from "../convergence-ledger.ts";

type RedEvidenceStatus = "red-behavior-failure" | "coverage-incomplete" | "green-weak-test" | "green-already-satisfied" | "broken-test" | "unknown-no-runner" | "unknown-unclassified" | "polluted-red";

interface RedEvidence {
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
	return value.replace(/\s+/g, " ").trim().slice(0, 800);
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
	const previous = history[history.length - 1];
	return !!previous && previous.failure === next.failure && previous.footprint === next.footprint;
}

function redEvidenceSignature(e: RedEvidence): string {
	return JSON.stringify({
		status: e.status,
		oracleStatus: e.oracleStatus,
		testFiles: stableUnique(e.testFiles),
		changedFiles: stableUnique(e.changedFiles),
		forbiddenFiles: stableUnique(e.forbiddenFiles),
		missingScenarios: stableUnique(e.missingScenarios ?? []),
		coveredScenarios: stableUnique(e.coveredScenarios ?? []),
		reason: normalizeSignatureText(e.reason ?? ""),
		diagnostics: stableUnique((e.diagnostics ?? []).map((d) => `${d.status}:${d.exitCode ?? "null"}:${d.signal ?? "none"}:${normalizeSignatureText(d.outputTail ?? "")}`)),
	});
}

function gitLines(cwd: string, args: string[]): string[] {
	try {
		const out = execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
		return out.split("\n").map((l) => l.trim()).filter(Boolean);
	} catch {
		return [];
	}
}

function gitStatusPaths(cwd: string): Set<string> {
	const paths = new Set<string>();
	for (const line of gitLines(cwd, ["status", "--porcelain=v1", "--untracked-files=all"])) {
		const raw = line.slice(3).trim();
		const path = raw.includes(" -> ") ? raw.split(" -> ").pop()!.trim() : raw;
		if (path) paths.add(path);
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
	const explicit = uniqueScenarioIds([
		...scenarioIdsFromUnknown(p.scenarioRefs),
		...scenarioIdsFromUnknown(p.scenarios),
		...scenarioIdsFromUnknown(p.name),
		...scenarioIdsFromUnknown(p.description),
		...scenarioIdsFromUnknown(phaseTaskDescriptions(specControl, phaseName)),
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

function restorePaths(cwd: string, paths: string[]): void {
	for (const path of paths) {
		try { execFileSync("git", ["checkout", "--", path], { cwd, stdio: "ignore" }); } catch { /* untracked or absent */ }
		try { execFileSync("git", ["clean", "-fd", "--", path], { cwd, stdio: "ignore" }); } catch { /* best-effort */ }
	}
}

function restoreUnacceptedRedChanges(ctx: StageContext, cwd: string, phaseId: string, paths: string[]): void {
	const restorable = paths.filter((p) => !isInternalRuntimeClaim(p));
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

function classifyRedEvidence(args: { phaseId: string; attempt: number; redStatus: RedStatus; testFiles: string[]; changedFiles: string[]; boundary: RedBoundaryResult; redRetries: number; alreadySatisfied: boolean; diagnostics?: RedCheckDiagnostic[] }): RedEvidence {
	const { phaseId, attempt, redStatus, testFiles, changedFiles, boundary, redRetries, alreadySatisfied } = args;
	const forbiddenFiles = boundary.forbiddenFiles;
	const diagnostics = args.diagnostics?.map((d) => ({ ...d, plan: { cwd: d.plan.cwd, argv: [...d.plan.argv] } }));
	const base = { phaseId, attempt, oracleStatus: redStatus, testFiles, changedFiles, forbiddenFiles, boundary, redRetries, ...(diagnostics?.length ? { diagnostics } : {}) };
	if (forbiddenFiles.length) return { ...base, status: "polluted-red", reason: "RED phase modified files outside the test boundary" };
	if (redStatus === "red") return { ...base, status: "red-behavior-failure" };
	if (redStatus === "broken") return { ...base, status: "broken-test", reason: "RED tests did not compile/collect" };
	if (redStatus === "green" && alreadySatisfied) return { ...base, status: "green-already-satisfied", reason: "Deliverables were already satisfied before implementation" };
	if (redStatus === "green") return { ...base, status: "green-weak-test", reason: "RED tests passed before implementation" };
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

function redEvidenceFailureReasons(e: RedEvidence): string[] {
	if (e.status === "polluted-red") return [`red-polluted: RED phase changed production file(s): ${e.forbiddenFiles.join(", ")}`];
	const detail = firstRedDiagnosticDetail(e);
	if (e.status === "coverage-incomplete") return [`red-coverage-incomplete: missing BDD scenario coverage: ${(e.missingScenarios ?? []).join(", ") || "unknown"}${e.reason ? `; ${e.reason}` : ""}`];
	if (e.status === "green-weak-test") return [`red-not-confirmed: tests passed before implementation (${e.testFiles.join(", ") || "no tests"})${detail ? `; ${detail}` : ""}`];
	if (e.status === "broken-test") return [`red-broken: tests did not compile/collect (${e.testFiles.join(", ") || "no tests"})${detail ? `; ${detail}` : ""}`];
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

function redGenerationRetryHint(e: RedEvidence): string | null {
	if (e.status === "coverage-incomplete") return tddCoverageRetryHint({
		allCovered: false,
		expectedScenarios: e.expectedScenarios ?? [],
		coveredScenarios: e.coveredScenarios ?? [],
		missingScenarios: e.missingScenarios ?? [],
		summary: e.reason ?? "BDD scenario coverage incomplete",
	});
	if (e.status === "green-weak-test") return redRePromptHint("green") + redDiagnosticsPrompt(e.diagnostics);
	if (e.status === "broken-test") return redRePromptHint("broken") + redDiagnosticsPrompt(e.diagnostics);
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

async function resolveTddScenarioCoverage(args: { ctx: StageContext; cwd: string; phaseId: string; phaseName: string; phase: unknown; expectedScenarios: string[]; testFiles: string[]; specControl: ControlObj | null | undefined; bddControl: ControlObj | null | undefined }): Promise<TddCoverageResult> {
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
		const allCovered = control.allCovered === true && missing.length === 0 && coveredExpected.length >= args.expectedScenarios.length;
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

async function resolveRedBoundary(args: { ctx: StageContext; phaseId: string; phaseName: string; phase: unknown; redStatus: RedStatus; testFiles: string[]; changedFiles: string[] }): Promise<RedBoundaryResult> {
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
			prompt: buildRedBoundaryPrompt({
				changedFiles: ambiguous,
				testFiles: args.testFiles,
				phaseName: args.phaseName,
				phaseDescription,
				redStatus: args.redStatus,
			}),
		});
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
		if (!ASSERTION_RE.test(content)) gaps.push(path);
	}
	return gaps;
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

const pad = (n: number) => String(n).padStart(2, "0");

/** Hard ceiling on RED-generation tries within one implementation attempt (RC-3).
 *  Cycle detection handles oscillation; this bounds a non-repeating drift the
 *  signature hash might not catch, so a phase can never spin ~indefinitely on the
 *  global budget alone (the 47-retry/15h livelock). Env-overridable for tuning. */
const MAX_RED_RETRIES = (() => {
	const raw = Number.parseInt(process.env.SUPER_DEV_MAX_RED_RETRIES ?? "", 10);
	return Number.isFinite(raw) && raw > 0 ? raw : 6;
})();

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

function redCheckOptions(ctx: StageContext, phaseId: string, diagnostics?: RedCheckDiagnostic[]) {
	return {
		signal: ctx.signal,
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
	status: "green" | "failed";
}
export interface PhaseFailureEntry {
	phaseId: string;
	reasons: string[];
}
export function phaseStatusUpsert(arr: PhaseStatusEntry[], id: string, status: "green" | "failed"): void {
	const i = arr.findIndex((p) => p.id === id);
	if (i >= 0) arr[i] = { id, status };
	else arr.push({ id, status });
}
export function lastFailuresUpsert(arr: PhaseFailureEntry[], phaseId: string, reasons: string[]): void {
	const i = arr.findIndex((f) => f.phaseId === phaseId);
	if (i >= 0) arr[i] = { phaseId, reasons };
	else arr.push({ phaseId, reasons });
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
		// §D auto-iterate: carry per-phase green state + failure reasons from the
		// PRIOR convergence iteration (state.implementation holds the last run's
		// control). Green phases are skipped; a failed phase's prior reasons seed
		// its next attempt 1 so iteration 2 targets the real failures.
		const startInstructionFingerprint = runtimeInstructionFingerprint(state.setup?.specDirectory);
		const priorImpl = (state.implementation ?? {}) as { phaseStatus?: PhaseStatusEntry[]; lastFailures?: PhaseFailureEntry[]; runtimeInstructionFingerprint?: string; invalidatedByRuntimeInstructions?: boolean };
		const priorInstructionInvalidated = priorImpl.invalidatedByRuntimeInstructions === true || (typeof priorImpl.runtimeInstructionFingerprint === "string" && priorImpl.runtimeInstructionFingerprint !== startInstructionFingerprint);
		let phaseStatus: PhaseStatusEntry[] = priorInstructionInvalidated ? [] : (Array.isArray(priorImpl.phaseStatus) ? priorImpl.phaseStatus.map((p) => ({ ...p })) : []);
		let lastFailures: PhaseFailureEntry[] = priorInstructionInvalidated ? [] : (Array.isArray(priorImpl.lastFailures) ? priorImpl.lastFailures.map((f) => ({ ...f, reasons: [...f.reasons] })) : []);
		if (priorInstructionInvalidated) ctx.log("Implementation: runtime user instructions changed — invalidating prior green phase carry and re-running phases");
		if (phaseStatus.length) ctx.log(`Implementation: resuming convergence iteration (${phaseStatus.filter((p) => p.status === "green").length}/${phases.length} phases already green)`);
		let phasesCompleted = 0;
		let allGreen = true;
		let convergenceBlocked = false;
		let convergenceBlockReason = "";
		const filesModified: string[] = [];

		for (const [idx, phase] of phases.entries()) {
			const phaseId = `phase-${pad(idx + 1)}`;
			const phaseName = (phase as { name?: string }).name?.trim() || phaseId;
			const expectedScenarios = expectedScenariosForPhase(phase, state.spec ?? null, state.bdd ?? null);
			const phaseHeadline = `Implementation — Phase ${idx + 1}/${phases.length}: ${phaseName}`;
			const phaseLabel = `↳ Phase ${idx + 1}/${phases.length}: ${phaseName}`;
			let phaseLifecycleStarted = false;
			const emitPhaseStatus = (status: "running" | "ok" | "failed" | "skipped") => {
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
			 *  then marks the row ok/failed by `okIf(result)`. Returns fn's result. */
			const runStep = async <T>(label: string, detail: string | undefined, okIf: (r: T) => boolean, fn: () => Promise<T>): Promise<T> => {
				const seq = ++stepSeq;
				announceActivity(label, detail);
				emitStep(`${label}${detail ? ` (${detail})` : ""}`, "running", seq);
				try {
					const r = await fn();
					emitStep(`${label}${detail ? ` (${detail})` : ""}`, okIf(r) ? "ok" : "failed", seq);
					return r;
				} catch (err) {
					emitStep(`${label}${detail ? ` (${detail})` : ""}`, "failed", seq);
					throw err;
				}
			};
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
			let green = false;
			let attemptErrors: string[] = [];
			let attemptsRun = 0;
			let terminalFailureKind: "red-generation" | "implementation-gate" = "implementation-gate";
			let terminalRedTries = 0;
			let terminalStopReason: "budget" | "no-progress" | "failed" = "failed";
			let attemptProgressHistory: ProgressSignature[] = [];
			// AND-semantics (AC-03 → SCENARIO-011..015): the missing DELIVERABLE entries
			// from the previous attempt, fed into the next implementer retry under a
			// `## Deliverables still missing — create/wire these` block. Resets each
			// attempt, mirroring `attemptErrors = gate.errors`.
			let missingDeliverables: string[] = [];
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
			if (resumeNoOpAllowed && phaseDeliverables && deliverablesAlreadyMet(setup.worktreePath, phaseDeliverables)) {
				ensurePhaseRunning();
				announceActivity("Resume verification");
				resetDeliverableCheckCache();
				announceActivity("Build gate", "resume verification");
				const gate = runBuildGate(setup.worktreePath, { gate: (state.spec?.gate) as GateOptions | undefined, signal: ctx.signal });
				announceActivity("Deliverable check", "resume verification");
				const deliverableCheck = runDeliverableCheck(setup.worktreePath, phaseDeliverables, { signal: ctx.signal, skipTests: !(gate.pass || gate.inScopePass) });
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
			for (let attempt = 1; ctx.budget.check(); attempt++) {
				attemptsRun = attempt;
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
					const baselineDeliverablesSatisfied = phaseDeliverables ? deliverablesAlreadyMet(setup.worktreePath, phaseDeliverables) : false;
					let retries = 0;
					let redHint = "";
					const redProgressHistory: string[] = [];
					while (ctx.budget.check()) {
						const redDiagnostics: RedCheckDiagnostic[] = [];
						const redTryDetail = attemptDetail(attempt, `try ${retries + 1}`);
						const tddId = retries === 0
							? `pipeline.implementation.${phaseId}.tdd.a${attempt}`
							: `pipeline.implementation.${phaseId}.tdd.red${retries}.a${attempt}`;
						announceActivity("TDD RED", redTryDetail);
						const tddStepSeq = ++stepSeq;
						emitStep(`TDD RED (${redTryDetail})`, "running", tddStepSeq);
						const tdd = await ctx.agent({ id: tddId, agent: "tdd-guide", prompt: buildTddPrompt(setup, state.classify ?? null, phase, state.spec ?? null, [lang, rustDiscipline(setup)].filter(Boolean).join("\n\n"), state.bdd ?? null) + redHint });
						// Reflect an agent error/timeout in the step glyph: a ✓ TDD RED next to
						// an errored call misrepresents what happened (R1 fail-closes the phase
						// regardless, but the dashboard should not show success).
						emitStep(`TDD RED (${redTryDetail})`, tdd.error ? "failed" : "ok", tddStepSeq);
						const filesRaw = (tdd.control as { testFiles?: unknown } | null)?.testFiles;
						testFiles = filesRaw == null && testFiles.length ? testFiles : normalizeStringArray(filesRaw);
						announceActivity("RED oracle", redTryDetail);
						redStatus = runRedCheck(setup.worktreePath, testFiles, redCheckOptions(ctx, phaseId, redDiagnostics));
						ctx.log(`Implementation ${phaseId} red-oracle: ${redStatus} (ran: ${testFiles.join(",") || "n/a"})`);
						redChangedFiles = setDiff(gitStatusPaths(setup.worktreePath), redBaseline);
						announceActivity("RED boundary", redTryDetail);
						const boundary = await resolveRedBoundary({ ctx, phaseId, phaseName, phase, redStatus, testFiles, changedFiles: redChangedFiles });
						ctx.log(`Implementation ${phaseId} RED boundary: ${boundarySummary(boundary)}`);
						redEvidence = classifyRedEvidence({ phaseId, attempt, redStatus, testFiles, changedFiles: redChangedFiles, boundary, redRetries: retries, alreadySatisfied: baselineDeliverablesSatisfied, diagnostics: redDiagnostics });
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
								redEvidence = { ...redEvidence, status: "broken-test", reason: `RED not confirmed: ${why}` };
							}
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
						let retryHint = redGenerationRetryHint(redEvidence);
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
						if (!retryHint && redEvidence.status === "red-behavior-failure" && testFiles.length > 0) {
							const review = await runStep(
								"RED review", redTryDetail,
								// Fail CLOSED: the step is "ok" only on an explicit STRONG verdict.
								(r: { control?: { verdict?: unknown } | null }) => String(r?.control?.verdict ?? "").toLowerCase() === "strong",
								() => ctx.agent({
									id: `pipeline.implementation.${phaseId}.red-review.a${attempt}.t${retries + 1}`,
									agent: "code-reviewer",
									accessMode: "source-read-only",
									prompt: buildRedReviewPrompt(setup, state.classify ?? null, phase, testFiles, expectedScenarios, state.spec ?? null, state.bdd ?? null),
									schema: RED_REVIEW_SCHEMA,
								}),
							);
							// R2 — fail CLOSED: proceed to implementation ONLY on an explicit
							// "strong" verdict. Anything else — "weak", an invalid verdict, a
							// missing control object, or an agent error/timeout (null control) —
							// routes back to tdd-guide. A review gate that defaults to "pass" on
							// malformed output is worse than no gate (it looks like protection).
							const verdict = String((review.control as { verdict?: unknown } | null)?.verdict ?? "").toLowerCase();
							if (verdict !== "strong") {
								const summary = String((review.control as { summary?: unknown } | null)?.summary ?? "")
									|| (verdict === "weak"
										? "test assertions are not bound to the scenario's observable behavior"
										: review.error
											? `RED review did not complete (${review.error})`
											: "RED review returned no usable verdict");
								ctx.log(`Implementation ${phaseId} RED review: NOT STRONG (${verdict || review.error || "no verdict"}) — ${summary}`);
								redEvidence = { ...redEvidence, status: "green-weak-test", reason: `RED review not strong: ${summary}` };
								retryHint = `An independent reviewer did not confirm your RED tests as STRONG: ${summary}. Strengthen the assertions so each binds the scenario's OBSERVABLE behavior (concrete expected values/outputs/status codes), not implementation details or tautologies, then re-run.`;
							} else {
								ctx.log(`Implementation ${phaseId} RED review: STRONG`);
							}
						}
						if (retryHint) {
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
											message: `RED test generation for phase "${phaseName}" is not converging (${why}). This is typically a spec or test-toolchain issue — e.g. the target package has no runnable test command, so a new test cannot be observed to fail. Inspect the recurring RED evidence or provide guidance before retrying.`,
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
							if (redEvidence.status === "green-weak-test" || redEvidence.status === "polluted-red") {
								restoreUnacceptedRedChanges(ctx, setup.worktreePath, phaseId, redEvidence.changedFiles);
							}
							retries++;
							redHint = retryHint;
							ctx.log(`Implementation ${phaseId} RED generation retry ${retries}: ${redEvidenceFailureReasons(redEvidence).join("; ") || redEvidence.reason || redEvidence.status}`);
							continue;
						}
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
						const gate = runBuildGate(setup.worktreePath, { gate: (state.spec?.gate) as GateOptions | undefined, signal: ctx.signal });
						announceActivity("Deliverable check", attemptDetail(attempt));
						const deliverableCheck = runDeliverableCheck(setup.worktreePath, phaseDeliverables ?? {}, { signal: ctx.signal, skipTests: !(gate.pass || gate.inScopePass) });
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
					const redFailures = redEvidenceFailureReasons(redEvidence);
					if (redFailures.length) {
						restoreUnacceptedRedChanges(ctx, setup.worktreePath, phaseId, redEvidence.changedFiles);
						attemptErrors = redFailures;
						terminalFailureKind = "red-generation";
						terminalRedTries = retries + 1;
						if (terminalStopReason !== "no-progress") terminalStopReason = ctx.budget.check() ? "failed" : "budget";
						ctx.log(`Implementation ${phaseId} RED generation stopped after ${retries + 1} tries${terminalStopReason === "no-progress" ? " (no progress)" : terminalStopReason === "budget" ? " (budget exhausted)" : ""}`);
						ctx.log(`Implementation ${phaseId} RED gate FAIL: ${redFailures.join("; ")}`);
						ctx.log(redEvidenceLogLine(redEvidence));
						break;
					}
					acceptedRed = { status: redStatus, testFiles: [...testFiles], changedFiles: [...redChangedFiles] };
				}
				const redTestSnapshot = redStatus === "red" && testFiles.length > 0 ? snapshotFiles(setup.worktreePath, testFiles) : new Map<string, string | null>();
				const redTargetsExist = Array.from(redTestSnapshot.values()).some((content) => content !== null);
				const confirmedRedTargets = redStatus === "red" && testFiles.length > 0 && (redChangedFiles.length > 0 || redTargetsExist);
				// Feed the previous attempt's REAL build/test errors into this attempt
				// so the implementer fixes the specific failures instead of resampling,
				// and surface the verified RED status so the green-phase agent knows
				// whether the tests are CONFIRMED-red or unverified.
				const basePrompt = buildImplementPrompt(setup, state.classify ?? null, phase, specialist.value, state.spec ?? null);
				const implParts: string[] = [basePrompt];
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
				announceActivity("Implementation", attemptDetail(attempt));
				const implStepSeq = ++stepSeq;
				emitStep(`Implementation (${attemptDetail(attempt)})`, "running", implStepSeq);
				const impl = await ctx.agent({ id: `pipeline.implementation.${phaseId}.impl.a${attempt}`, agent: "implementer", prompt: implPrompt });
				emitStep(`Implementation (${attemptDetail(attempt)})`, impl.error ? "failed" : "ok", implStepSeq);
				// spec-11 AC-06/AC-10: the implementer's claimed change set is now STRUCTURED
				// ({filesCreated, filesModified, filesDeleted}). parseStructuredChanges reads
				// it (and back-tolerates the legacy flat filesModified array). The flat
				// summary list derives from filesCreated ∪ filesModified — deleted is
				// EXCLUDED (a deleted file is not a "modified" display entry). dedupe via
				// the existing `filesModified.includes` guard (first-seen order preserved).
				const structured = parseStructuredChanges(impl.control);
				const projectStructured: StructuredChanges = {
					filesCreated: structured.filesCreated.filter((f) => !isInternalRuntimeClaim(f)),
					filesModified: structured.filesModified.filter((f) => !isInternalRuntimeClaim(f)),
					filesDeleted: structured.filesDeleted.filter((f) => !isInternalRuntimeClaim(f)),
				};
				for (const f of [...projectStructured.filesCreated, ...projectStructured.filesModified]) {
					if (!filesModified.includes(f)) filesModified.push(f);
				}
				// HARD test oracle: actually run build/test/typecheck instead of trusting
				// a QA agent's self-report (vacuous-pass risk). Non-fatal when nothing
				// is detectable (greenfield): ran is empty and pass is true.
				announceActivity("Build gate", attemptDetail(attempt));
				const gate = runBuildGate(setup.worktreePath, { gate: (state.spec?.gate) as GateOptions | undefined, signal: ctx.signal });
				attemptErrors = gate.errors;
				ctx.log(`Implementation ${phaseId} build-gate ${gate.pass ? "PASS" : "FAIL"} (ran: ${gate.ran.join(", ") || "no commands"})`);
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
				const deliverableCheck = runDeliverableCheck(setup.worktreePath, bridgedDeliverables, { signal: ctx.signal, skipTests: !buildGreen });
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
				let invalidateAcceptedRed = false;
				if (confirmedRedTargets) {
					const modifiedRedTests = changedSinceSnapshot(setup.worktreePath, redTestSnapshot);
					if (modifiedRedTests.length) {
						tddOracleFailures.push(`tdd-tests-modified-during-green: ${modifiedRedTests.join(", ")}`);
						invalidateAcceptedRed = true;
						ctx.log(`Implementation ${phaseId} post-red-oracle: skipped because confirmed RED test file(s) changed during GREEN (${modifiedRedTests.join(", ")})`);
					} else {
						announceActivity("Post-RED oracle", attemptDetail(attempt));
						const postRedStatus = runRedCheck(setup.worktreePath, testFiles, redCheckOptions(ctx, phaseId));
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
				if ((gate.pass || gate.inScopePass) && deliverableCheck.pass && changeGate.pass && symbolGate.pass && tddOracleFailures.length === 0) {
					green = true;
					phaseStatusUpsert(phaseStatus, phaseId, "green");
					emitPhaseStatus("ok");
					const _gfi = lastFailures.findIndex((f) => f.phaseId === phaseId); if (_gfi >= 0) lastFailures.splice(_gfi, 1);
					if (gate.pass) {
						ctx.log(`Implementation ${phaseId} GREEN on attempt ${attempt}`);
					} else {
						ctx.log(`Implementation ${phaseId} IN-SCOPE GREEN on attempt ${attempt} — ${gate.outOfScopeErrors.length} pre-existing out-of-scope failure(s) ignored (crates: ${cratesFromErrors(gate.outOfScopeErrors).join(",")})`);
					}
					break;
				}
				const failureReasons = [
					...gate.errors,
					...missingDeliverables.map((e) => `deliverable: ${e}`),
					...claimedNotChanged.map((e) => `claimed-not-changed: ${e}`),
					...hollowFiles.map((e) => `hollow-file: ${e}`),
					...tddOracleFailures,
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
				if (missingTestDeliverables.length && acceptedRed && !invalidateAcceptedRed) {
					acceptedRed = null;
					ctx.log(`Implementation ${phaseId} routing missing-test deliverable(s) back to RED regeneration (implementer cannot add RED tests): ${missingTestDeliverables.join("; ")}`);
				}
				if (invalidateAcceptedRed) {
					acceptedRed = null;
					ctx.log(`Implementation ${phaseId} RED cache invalidated: confirmed RED test file(s) changed during GREEN`);
				}
				const progressSignature: ProgressSignature = {
					failure: failureSignature(failureReasons),
					footprint: changeFootprint(phaseChangeRec, projectStructured),
				};
				const noProgress = repeatedNoProgress(attemptProgressHistory, progressSignature);
				attemptProgressHistory.push(progressSignature);
				ctx.log(`Implementation ${phaseId} attempt ${attempt} FAIL: ${failureReasons.join("; ") || "phase gates unmet"}`);
				if (noProgress) {
					// HITL escalation (parity with gate-exhaustion + verify-stagnation):
					// repeated identical failure is exactly where a human decision helps —
					// often an unsatisfiable gate contradiction or a spec ambiguity, not a
					// fixable code gap. Before the silent phase-fail (which abandons all
					// later phases), give the user a chance to inject guidance and continue.
					// Bounded by ESCALATION_RETRY_CAP; never throws; a dismissal/headless
					// run falls straight through to the pre-existing no-progress break.
					const escalate = (ctx as { options?: { escalate?: import("../types.ts").Escalate } }).options?.escalate;
					if (escalate) {
						try {
							const { runEscalation, applyRetryDecision } = await import("../escalation.ts");
							const failure: import("../types.ts").EscalationFailure = {
								kind: "stagnation",
								stage: "implementation",
								message: `Implementation phase "${phaseName}" made no progress across consecutive attempts — the same failure recurred after a change. This is often an unsatisfiable gate contradiction or a spec ambiguity. Inspect the recurring failures or provide explicit guidance before the phase is abandoned.`,
								severity: "soft",
								findings: failureReasons.slice(0, 12).map((r) => ({ file: null, severity: null, title: r })),
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
									attemptProgressHistory = [];
									acceptedRed = null;
									ctx.log(`Implementation ${phaseId} no-progress escalation: retrying with user guidance`);
									continue;
								}
							}
						} catch { /* never-throw: fall through to the terminal break */ }
					}
					terminalStopReason = "no-progress";
					ctx.log(`Implementation ${phaseId} stopped after repeated no-progress failure on attempt ${attempt}: ${failureReasons.join("; ") || "phase gates unmet"}`);
					break;
				}
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
					...missingDeliverables.map((e) => `deliverable: ${e}`),
					...claimedNotChanged.map((e) => `claimed-not-changed: ${e}`),
					...hollowFiles.map((e) => `hollow-file: ${e}`),
				];
				recordImplementationConvergenceFailure(state, { phaseId, phaseName, kind: terminalFailureKind, attemptsRun, reasons: terminalReasons });
				phaseStatusUpsert(phaseStatus, phaseId, "failed");
				emitPhaseStatus("failed");
				lastFailuresUpsert(lastFailures, phaseId, [
					...attemptErrors,
					...missingDeliverables.map((e) => `deliverable: ${e}`),
					...claimedNotChanged.map((e) => `claimed-not-changed: ${e}`),
					...hollowFiles.map((e) => `hollow-file: ${e}`),
				]);
				if (terminalFailureKind === "red-generation") {
					ctx.log(`Implementation ${phaseId} stopped before implementation: RED generation stopped after ${terminalRedTries} tries in implementation attempt ${attemptsRun}${terminalStopReason === "no-progress" ? " (no progress)" : terminalStopReason === "budget" ? " (budget exhausted)" : ""}`);
				} else {
					ctx.log(`Implementation ${phaseId} stopped after ${attemptsRun} attempt(s)${terminalStopReason === "no-progress" ? " (no progress)" : terminalStopReason === "budget" ? " (budget exhausted)" : ""}`);
				}
				if (terminalStopReason === "no-progress") {
					convergenceBlocked = true;
					convergenceBlockReason = terminalFailureKind === "red-generation"
						? `RED generation repeated the same failing evidence for ${phaseId}`
						: `Implementation gates repeated the same failing evidence for ${phaseId}`;
				}
				allGreen = false;
				break;
			}
			phasesCompleted++;
			if (ctx.budget.check()) {
				announceActivity("Commit");
				await ctx.agent({ id: `pipeline.implementation.${phaseId}.commit`, agent: "orchestrator", prompt: buildCommitPrompt(setup, phase.name) });
			}
		}
		const control: ControlObj = {
			phasesCompleted,
			totalPhases: phases.length,
			allGreen,
			filesModified,
			phaseStatus,
			lastFailures,
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
