import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { StageContext } from "../../types.ts";
import type { ControlObj } from "../../types.ts";
import { buildRedBoundaryPrompt, classifyObviousRedPath, redBoundaryResultFromAgent, redBoundaryResultFromClassifications, type RedBoundaryResult } from "../../test-artifacts.ts";
import { TddCoverageControlData, FileClassifyControlData } from "../../render/schemas.ts";
import type { RedStatus } from "../../build-runner.ts";
import { extractScenarioIds } from "../../doc-validators.ts";

// listOrNone twin (the red-evidence.ts original serves redEvidenceLogLine's 5
// call sites there; kept local to avoid a red-evidence -> red-boundary cycle).
function listOrNoneLocal(values: string[]): string {
	return values.length ? values.join(", ") : "none";
}

export interface TddCoverageResult {
	allCovered: boolean;
	expectedScenarios: string[];
	coveredScenarios: string[];
	missingScenarios: string[];
	summary: string;
}

/** Wave 5 increment 2: the two RED-GATE AGENT ADJUDICATIONS — moved verbatim
 *  from red-evidence.ts: resolveTddScenarioCoverage (BDD scenario coverage,
 *  authoritative diff over coveredScenarios — the allCovered boolean is a
 *  derived brittle channel) and resolveRedBoundary (deterministic obvious-path
 *  classification first, the red-boundary-classifier agent ONLY for ambiguous
 *  paths, suffix-tolerant byPath merge, fail-closed fallback denies), plus
 *  their prompt builders and the scenarioId coercion helpers.
 *  One reason to change: what the RED gate's two classifiers adjudicate. */

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

export function boundarySummary(result: RedBoundaryResult): string {
	const classifications = result.classifications.map((c) => `${c.path}:${c.category}:${c.allowed ? "allow" : "deny"}:${c.source}:${c.confidence.toFixed(2)}`).join("; ") || "none";
	return `allAllowed=${result.allAllowed} forbidden=${listOrNoneLocal(result.forbiddenFiles)} ambiguous=${listOrNoneLocal(result.ambiguousFiles)} classifications=${classifications}`;
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

export function uniqueScenarioIds(ids: string[]): string[] {
	return [...new Set(ids)].sort((a, b) => Number(a.split("-")[1] ?? "0") - Number(b.split("-")[1] ?? "0"));
}

export function scenarioIdsFromUnknown(value: unknown): string[] {
	if (value == null) return [];
	if (typeof value === "string") return extractScenarioIds(value);
	if (typeof value === "number" && Number.isInteger(value)) return [`SCENARIO-${String(value).padStart(3, "0")}`];
	if (Array.isArray(value)) return uniqueScenarioIds(value.flatMap(scenarioIdsFromUnknown));
	if (typeof value === "object") return scenarioIdsFromUnknown(JSON.stringify(value));
	return [];
}
