/**
 * Prompt builders for each pipeline stage. Ported from the original controller
 * so agent `<control>` JSON contracts are unchanged.
 *
 * Doc NUMBERING is COMPUTED, never hardcoded: a stage's number = (number of
 * numbered docs already in the spec dir) + 1. So the sequence is dense and
 * follows actual execution order — a skipped stage (debug for a feature,
 * prototype when there are no numeric constants) writes no file and consumes
 * no number, so code-assessment lands on 04 when debug is skipped and 05 when
 * debug runs. The current stage's own slug is excluded from the count so gate
 * retries don't inflate it; spec's three docs take base, base+1, base+2.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { SetupControl, Classification, ControlObj } from "./types.ts";

type R = ControlObj | null | undefined;

/** Next doc number = count of existing `NN-*` files in the spec dir (excluding
 *  any whose name ends in `-<slug>.md` for the given slugs) + 1. */
function nextDocNumber(specDir: string, excludeSlugs: string[] = []): number {
	let count = 0;
	try {
		for (const entry of readdirSync(specDir)) {
			if (!/^\d{2}-.+/.test(entry)) continue;
			if (excludeSlugs.some((sg) => entry.endsWith(`-${sg}.md`))) continue;
			count++;
		}
	} catch { /* dir not readable yet — treat as empty */ }
	return count + 1;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** A single stage's doc path: next free number + the slug. */
export function specDoc(s: SetupControl, slug: string): string {
	return `${s.specDirectory}${pad(nextDocNumber(s.specDirectory, [slug]))}-${slug}.md`;
}

/** A stage that writes several docs at once (the spec stage): they take
 *  consecutive numbers base, base+1, … in the given slug order. */
function specDocRange(s: SetupControl, slugs: string[]): string[] {
	const base = nextDocNumber(s.specDirectory, slugs);
	return slugs.map((slug, i) => `${s.specDirectory}${pad(base + i)}-${slug}.md`);
}

function ctxBlock(setup: SetupControl, c: Classification | null): string {
	return ["## Context", `- Worktree: ${setup.worktreePath}`, `- Spec Directory: ${setup.specDirectory}`, `- Language: ${c?.language ?? setup.language}`, `- Task Type: ${c?.taskType ?? "unknown"}`, `- UI Scope: ${c?.uiScope ?? "none"}`, `- Default Branch: ${setup.defaultBranch ?? "main"}`].join("\n");
}

export function buildRequirementsPrompt(s: SetupControl, c: Classification | null, task: string): string {
	return [ctxBlock(s, c), "", "## Task", task, "", "## Instructions", "Produce an implementation-ready requirements document.", "The document will be RENDERED FOR YOU from your structured output — focus on CONTENT, not format. Do NOT write the document yourself.", "", "## Data to return", "Return the requirements as structured data:", "- title: the feature/fix title", "- date: today's date (YYYY-MM-DD)", "- type: 'feature' | 'bug-fix' | 'refactor' | 'enhancement'", "- priority: 'high' | 'medium' | 'low' | 'critical'", "- executiveSummary: 2-3 sentence summary", "- acceptanceCriteria: array of { id: 'AC-01', statement: string } (at least 2)", "- nonFunctional: array of performance/security/accessibility notes (at least 1)", "- openQuestions (optional): array of strings", "", "Output <control> JSON with: title, date, type, priority, executiveSummary, acceptanceCriteria, nonFunctional, openQuestions."].join("\n");
}
export function buildBddPrompt(s: SetupControl, c: Classification | null, task: string, requirements: R): string {
	return [ctxBlock(s, c), "", "## Upstream Artifacts", `- Requirements: ${(requirements?.docPath as string) ?? "N/A"}`, "", "## Task", task, "", "## Instructions", "Write BDD behavior scenarios from the requirements acceptance criteria.", "Cover happy paths, edge cases, and error scenarios.", "The document will be RENDERED FOR YOU from your structured output — focus on CONTENT, not markdown format. Do NOT write the document yourself.", "", "## Data to return", "Return the scenarios as structured data:", "- title: the feature/spec title", "- date: today's date (YYYY-MM-DD)", "- source: the requirements doc path", "- features: array of { name: string, scenarios: [{ id: '001', title, acRef: 'AC-01', priority: 'high'|'medium'|'low', given, when, then, andClauses?: string[] }] }", "- traceability (optional): array of { acId, description, scenarios: ['SCENARIO-001', ...] }", "", "Output <control> JSON with: title, date, source, features, traceability."].join("\n");
}
export function buildResearchPrompt(s: SetupControl, c: Classification | null, task: string, requirements: R, bdd: R, prev: R): string {
	const parts = [ctxBlock(s, c), "", "## Upstream Artifacts", `- Requirements: ${(requirements?.docPath as string) ?? "N/A"}`, `- BDD Scenarios: ${(bdd?.docPath as string) ?? "N/A"}`];
	if (prev?.docPath) { parts.push(`- Previous Research: ${prev.docPath as string}`); const oi = prev.openIssues as string[] | undefined; if (Array.isArray(oi) && oi.length) parts.push(`- Open Issues to resolve: ${oi.join(", ")}`); }
	parts.push("", "## Task", task, "", "## Instructions", "Research best practices relevant to this task.", "The document will be RENDERED FOR YOU — focus on CONTENT. Do NOT write the document.", "", "## Data to return", "Return the research as structured data:", "- title: the research topic title", "- date: today's date", "- summary: one-paragraph summary", "- options: array of { name: string, tradeoffs: string } (at least 1)", "- openIssues: array of strings (empty if none)", "", "Output <control> JSON with: title, date, summary, options, openIssues.");
	return parts.join("\n");
}
export function buildDebugPrompt(s: SetupControl, c: Classification | null, task: string, requirements: R, research: R): string {
	return [ctxBlock(s, c), "", "## Upstream Artifacts", `- Requirements: ${(requirements?.docPath as string) ?? "N/A"}`, `- Research: ${(research?.docPath as string) ?? "N/A"}`, "", "## Task", task, "", "## Instructions", "Perform systematic root-cause debugging with evidence collection.", "The document will be RENDERED FOR YOU — focus on CONTENT. Do NOT write the document.", "Include: hypotheses, reproduction steps, root cause, and recommended fix.", "", "Output <control> JSON with: title, date, summary, hypotheses, rootCause, reproductionSteps."].join("\n");
}
export function buildAssessmentPrompt(s: SetupControl, c: Classification | null, task: string, research: R, debug: R): string {
	const parts = [ctxBlock(s, c), "", "## Upstream Artifacts", `- Research: ${(research?.docPath as string) ?? "N/A"}`];
	if (debug?.docPath) parts.push(`- Debug Analysis: ${debug.docPath as string}`);
	parts.push("", "## Task", task, "", "## Instructions", "Assess the existing codebase: architecture patterns, coding standards, dependencies, and framework conventions.", "The document will be RENDERED FOR YOU — focus on CONTENT. Do NOT write the document.", "", "Also identify how to RUN this app locally for testing: the shell command to start the API server and (if present) the UI dev server, the env var that sets the port (e.g. PORT), and a health/readiness URL path (e.g. /health or /). Read the README, package.json scripts, Dockerfile/Makefile, and server entrypoints to determine these.", "", "## Data to return", "Return the assessment as structured data:", "- title, date, summary", "- patterns: array of { name, example (file:line), consistency }", "- recommendations: array of strings", "- filesAssessed: array of file paths", "- services (optional): { api?: {cmd, portEnv, readyPath}, ui?: {cmd, portEnv, readyPath} }", "", "Output <control> JSON with: title, date, summary, patterns, recommendations, filesAssessed, services.");
	return parts.join("\n");
}
export function buildDesignPrompt(s: SetupControl, c: Classification | null, task: string, requirements: R, research: R, assessment: R, designerAgent: string): string {
	return [ctxBlock(s, c), "", "## Upstream Artifacts", `- Requirements: ${(requirements?.docPath as string) ?? "N/A"}`, `- Research: ${(research?.docPath as string) ?? "N/A"}`, `- Code Assessment: ${(assessment?.docPath as string) ?? "N/A"}`, "", "## Task", task, "", "## Instructions", `You are the ${designerAgent}. Design the architecture/UI for this feature.`, "The document will be RENDERED FOR YOU — focus on CONTENT. Do NOT write the document.", "Include: module decomposition, interfaces, data flow, and any numeric constants that need validation.", "", "Output <control> JSON with: title, date, summary, designer, modules [{name, description}], hasNumericConstants."].join("\n");
}
export function buildPrototypePrompt(s: SetupControl, c: Classification | null, task: string, design: R, constants: string[], round: number): string {
	return [ctxBlock(s, c), "", "## Design", `- Design doc: ${(design?.docs as string[] | undefined)?.[0] ?? "N/A"}`, `- Constants to validate: ${(constants ?? []).join(", ")}`, "", "## Task", task, "", "## Instructions", `Prototype round ${round}: Empirically validate the numeric design constants.`, "Build a minimal prototype, measure against representative input, and report pass/fail.", "The document will be RENDERED FOR YOU — focus on CONTENT. Do NOT write the document.", "", "Output <control> JSON with: title, date, summary, verdict, measurements, adjustments."].join("\n");
}
export function buildSpecPrompt(s: SetupControl, c: Classification | null, task: string, requirements: R, bdd: R, research: R, assessment: R, design: R): string {
	const parts = [ctxBlock(s, c), "", "## Upstream Artifacts", `- Requirements: ${(requirements?.docPath as string) ?? "N/A"}`, `- BDD Scenarios: ${(bdd?.docPath as string) ?? "N/A"}`, `- Research: ${(research?.docPath as string) ?? "N/A"}`, `- Code Assessment: ${(assessment?.docPath as string) ?? "N/A"}`];
	const docs = design?.docs as string[] | undefined;
	if (Array.isArray(docs) && docs.length) parts.push(`- Design: ${docs.join(", ")}`);
	/* render pipeline: spec returns structured data; 3 docs rendered from it */
	parts.push("", "## Task", task, "", "## Instructions", "Write the technical specification, implementation plan, and task list.", "The documents will be RENDERED FOR YOU — focus on CONTENT. Do NOT write the documents.", "Break implementation into phases. Each phase must be independently testable.", "", "## Data to return", "Return the specification as structured data:", "- title, date, summary", "- architecture: the technical architecture (prose)", "- testingStrategy: how the feature will be tested (prose)", "- scenarioRefs: array of SCENARIO-NNN IDs", "- phases: array of { name, description } (at least 1, each independently testable)", "- tasks: array of { phase, description }", "", "Output <control> JSON with: title, date, summary, architecture, testingStrategy, scenarioRefs, phases, tasks.");
	return parts.join("\n");
}
export function buildSpecReviewPrompt(s: SetupControl, c: Classification | null, specControl: R): string {
	return [ctxBlock(s, c), "", "## Specification to Review", `- Specification: ${(specControl?.specificationPath as string) ?? "N/A"}`, `- Plan: ${(specControl?.planPath as string) ?? "N/A"}`, `- Tasks: ${(specControl?.tasksPath as string) ?? "N/A"}`, `- Phases: ${(specControl?.phaseCount as number) ?? 0}`, "", "## Instructions", "Review the specification across 8 quality dimensions: completeness, correctness, consistency, testability, feasibility, security, performance, and maintainability.", "Score each dimension 1-5. Produce a verdict.", "The document will be RENDERED FOR YOU — focus on CONTENT. Do NOT write the document.", "", "## Data to return", "Return: title, date, verdict, summary, findings [{id, severity, title, detail}], dimensions [{name, status, notes}]", "", "Output <control> JSON with: title, date, verdict, summary, findings, dimensions."].join("\n");
}
export function buildTddPrompt(s: SetupControl, c: Classification | null, phase: { name: string; description?: string }, specControl: R, langInstructions = ""): string {
	return [ctxBlock(s, c), "", "## Implementation Phase", `- Phase: ${phase.name}`, `- Description: ${phase.description ?? ""}`, `- Specification: ${(specControl?.specificationPath as string) ?? "N/A"}`, "", langInstructions ? `## Language-Specific Instructions\n${langInstructions}\n` : "", "## Instructions", "Write failing tests FIRST for this implementation phase.", "Tests should cover the acceptance criteria and edge cases.", "Run the tests to confirm they fail (red phase of TDD).", "", "Output <control> JSON with: testsWritten (number), testFiles (array of paths), allFailing (boolean), summary."].join("\n");
}
/** Fix 3 — language-scoped Rust self-verification discipline (AC-07,
 *  SCENARIO-010 implement / SCENARIO-011 qa). Appended UNCONDITIONALLY to
 *  buildImplementPrompt and buildQaPrompt; scoped to Rust via its wording
 *  ("When verifying a Rust crate…") so non-Rust stacks are unaffected.
 *  Prompt-TEXT only — the stages consume these builders unchanged, so there
 *  is NO control-flow / nodes / workflow / pipeline change. */
const RUST_SELF_VERIFY_DISCIPLINE = "When verifying a Rust crate, run `cargo test -p <pkg>` WITHOUT the `--lib` flag so the integration binaries under tests/ execute as well, PLUS any spec-mandated e2e or integration target. Do NOT declare green on `--lib`-only evidence: `--lib` skips the tests/ integration binaries, so it is never sufficient proof.";

export function buildImplementPrompt(s: SetupControl, c: Classification | null, phase: { name: string; description?: string }, specialist: R, specControl: R): string {
	const li = (specialist?.languageInstructions as string) ?? "";
	return [ctxBlock(s, c), "", "## Implementation Phase", `- Phase: ${phase.name}`, `- Description: ${phase.description ?? ""}`, `- Specification: ${(specControl?.specificationPath as string) ?? "N/A"}`, "", li ? `## Language-Specific Instructions\n${li}\n` : "", "## Instructions", "Implement the code to make the failing tests pass (green phase of TDD).", "Follow existing patterns from the code assessment. Keep changes minimal and focused.", RUST_SELF_VERIFY_DISCIPLINE, "", "Output <control> JSON with: filesModified (array), testsPassCount (number), summary."].join("\n");
}
export function buildQaPrompt(s: SetupControl, c: Classification | null, phase: { name: string }): string {
	return [ctxBlock(s, c), "", "## Implementation Phase", `- Phase: ${phase.name}`, "", "## Instructions", "Run the full test suite and verify build succeeds.", "Check coverage meets threshold. Report any regressions.", RUST_SELF_VERIFY_DISCIPLINE, "", "Output <control> JSON with: allTestsPass (boolean), buildSuccess (boolean), coveragePercent (number), regressions (array), summary."].join("\n");
}
export function buildImplementationSummaryPrompt(s: SetupControl, c: Classification | null, impl: R): string {
	return [ctxBlock(s, c), "", "## Implementation Result", `- Phases Completed: ${(impl?.phasesCompleted as number) ?? 0}/${(impl?.totalPhases as number) ?? 0}`, `- All Green: ${(impl?.allGreen as boolean) ?? false}`, `- Files Modified: ${((impl?.filesModified as string[]) ?? []).join(", ") || "none"}`, "", "## Instructions", "Write a concise implementation summary: what was built per phase, files changed, test results, and any deviations from the specification.", "The document will be RENDERED FOR YOU — focus on CONTENT. Do NOT write the document.", "", "Output <control> JSON with: title, date, summary, phasesCompleted, allGreen, filesModified."].join("\n");
}
export function buildCodeReviewPrompt(s: SetupControl, c: Classification | null, task: string, specControl: R, implControl: R): string {
	return [ctxBlock(s, c), "", "## Upstream Artifacts", `- Specification: ${(specControl?.specificationPath as string) ?? "N/A"}`, `- Phases Completed: ${(implControl?.phasesCompleted as number) ?? 0}/${(implControl?.totalPhases as number) ?? 0}`, "", "## Task", task, "", "## Instructions", "Review the implementation against the specification for correctness, security, performance, and maintainability.", "Produce a verdict and list findings with severity.", "The document will be RENDERED FOR YOU — focus on CONTENT. Do NOT write the document.", "", "## Data to return", "Return: title, date, verdict, summary, findings [{id, severity, title, detail, file?, line?}]", "", "Output <control> JSON with: title, date, verdict, summary, findings."].join("\n");
}
export function buildAdversarialPrompt(s: SetupControl, c: Classification | null, task: string, specControl: R, implControl: R): string {
	return [ctxBlock(s, c), "", "## Upstream Artifacts", `- Specification: ${(specControl?.specificationPath as string) ?? "N/A"}`, `- Phases Completed: ${(implControl?.phasesCompleted as number) ?? 0}/${(implControl?.totalPhases as number) ?? 0}`, "", "## Task", task, "", "## Instructions", "Challenge the implementation from three critical lenses: Skeptic, Architect, Minimalist.", "Look for issues standard review misses: over-engineering, hidden complexity, missing error paths.", "The document will be RENDERED FOR YOU — focus on CONTENT. Do NOT write the document.", "", "## Data to return", "Return: title, date, verdict, summary, findings [{id, severity, title, detail, lens?}] (use lens: Skeptic|Architect|Minimalist)", "", "Output <control> JSON with: title, date, verdict, summary, findings."].join("\n");
}
export function buildFixPrompt(s: SetupControl, c: Classification | null, findings: unknown[], testFailures?: unknown[]): string {
	const list = (findings ?? []).map((f) => { const o = f as { severity?: string; title?: string; message?: string }; return `- [${o.severity ?? "medium"}] ${o.title ?? o.message ?? JSON.stringify(f)}`; }).join("\n");
	const tlist = (testFailures ?? []).map((f) => { const o = f as { method?: string; path?: string; reason?: string }; return `- ${o.method ?? ""} ${o.path ?? ""} — ${o.reason ?? JSON.stringify(f)}`; }).join("\n");
	const parts = [ctxBlock(s, c), "", "## Code Review Findings to Address", list || "- (no specific findings)"];
	if (tlist) parts.push("", "## API Test Failures to Address", tlist, "");
	parts.push("", "## Instructions", "Fix the issues above. Make minimal, targeted changes.", "Run tests after each fix to ensure no regressions.", "Then update the existing `*-implementation-summary.md` in the spec directory: append a short note of what this fix round changed.", "", "Output <control> JSON with: filesModified (array), fixesApplied (number), summary.");
	return parts.join("\n");
}

/** Build the ui-tester prompt. `ui.baseUrl` is the already-running UI dev server;
 *  for a fullstack app `api.baseUrl` is the live API behind it (the UI calls it).
 *  Secrets stay in .env / process.env — referenced by NAME, never printed. */
export function buildUiTestPrompt(s: SetupControl, c: Classification | null, specControl: R, ui: { baseUrl: string }, api?: { baseUrl: string }): string {
	const parts = [ctxBlock(s, c), "", "## Service under test", `- UI base URL: ${ui.baseUrl}`, "- The UI server is ALREADY RUNNING — do not start or stop it."];
	if (api) parts.push(`- The backing API is also running at ${api.baseUrl} (fullstack) — the UI calls it; confirm end-to-end behavior.`);
	parts.push("", "## Authentication", "If the UI requires login, credentials are in `.env` — load it and reference secrets ONLY as process.env.NAME (or type them into the login form from that variable). NEVER print a secret; redact tokens to `***`.", "", "## Upstream Artifacts", `- BDD Scenarios: ${(specControl?.planPath as string) ?? (specControl?.specificationPath as string) ?? "N/A"}`, "", "## Instructions", "Derive user flows from the BDD scenarios. Connect via `browser_execute` (CDP auto-discovery: `await session.connect()` then drive a page target) — or Playwright via bash as a fallback. For each flow: navigate, interact, and assert the visible page state. Screenshot any failure.", "The document will be RENDERED FOR YOU — focus on CONTENT. Do NOT write the document.", "The report must include: flows tested, per-flow (flow/steps/expected/observed/pass), screenshot refs, overall pass, and a failures list. Redact all credentials.", "", "Output <control> JSON with: pass (boolean), flows (number), failures (array of {flow, reason}), summary.");
	return parts.join("\n");
}

/** Build the api-tester prompt. `service.baseUrl` is the already-running API
 *  (bringup started it). Secrets stay in .env / process.env — referenced by
 *  NAME, redacted, never printed. */
export function buildApiTestPrompt(s: SetupControl, c: Classification | null, specControl: R, service: { baseUrl: string }): string {
	return [ctxBlock(s, c), "", "## Service under test", `- API base URL: ${service.baseUrl}`, "- The server is ALREADY RUNNING — do not start or stop it.", "", "## Authentication", "Determine the auth scheme from the spec and source. If a credential is required it is in `.env` — load it (`set -a; . ./.env; set +a`) and reference it in your test script ONLY as `process.env.NAME`. NEVER print a secret value; redact any Authorization to `***` in every output.", "", "## Upstream Artifacts", `- Specification: ${(specControl?.specificationPath as string) ?? "N/A"}`, "", "## Instructions", "Exercise every endpoint from the spec: full CRUD where applicable, unauthorized attempts (expect 401/403), and edge/invalid bodies (missing fields, wrong types, empty/oversized). Write a node test script using `fetch`, run it, and collect status + a short response excerpt per case.", "The document will be RENDERED FOR YOU — focus on CONTENT. Do NOT write the document.", "The report must include: endpoints tested, a per-case table (method/path/body-summary/expected/actual/pass), an overall pass flag, and a failures list. Redact all credentials.", "", "Output <control> JSON with: pass (boolean), cases (number), failures (array of {method, path, reason}), summary."].join("\n");
}
export function buildDocsPrompt(s: SetupControl, c: Classification | null, task: string, specControl: R): string {
	return [ctxBlock(s, c), "", "## Task", task, "", "## Upstream Artifacts", `- Specification: ${(specControl?.specificationPath as string) ?? "N/A"}`, `- Spec Directory: ${s.specDirectory}`, "", "## Instructions", "Update documentation to reflect the implementation:", "- Review spec directory files for accuracy against the code", "- Update README, CHANGELOG, API docs as needed", "- Document any deviations from the specification", "The document will be RENDERED FOR YOU — focus on CONTENT. Do NOT write the document.", "", "Output <control> JSON with: title, date, summary, docsUpdated, deviationsDocumented."].join("\n");
}
export function buildCommitPrompt(s: SetupControl, phaseName: string): string {
	return ["## Context", `- Worktree: ${s.worktreePath}`, "", "## Instructions", `Commit all changes for implementation phase: ${phaseName}`, "Use a conventional commit message that describes the phase work.", "Stage only files relevant to this phase."].join("\n");
}
export function buildMergePrompt(s: SetupControl): string {
	return ["## Context", `- Worktree: ${s.worktreePath}`, `- Default Branch: ${s.defaultBranch ?? "main"}`, "", "## Instructions", "Merge the feature branch back into the default branch.", "Ensure all changes are committed. Create a merge commit with a summary of all work done.", "If there are conflicts, resolve them preserving the feature branch changes.", "", "Output <control> JSON with: merged (boolean), commitSha, mergeCommand, summary."].join("\n");
}
