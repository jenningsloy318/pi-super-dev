/**
 * Prompt builders for each pipeline stage. Ported verbatim from the original
 * controller so agent `<control>` JSON contracts are unchanged.
 */

import type { SetupControl, Classification, ControlObj } from "./types.ts";

type R = ControlObj | null | undefined;

function ctxBlock(setup: SetupControl, c: Classification | null): string {
	return ["## Context", `- Worktree: ${setup.worktreePath}`, `- Spec Directory: ${setup.specDirectory}`, `- Language: ${c?.language ?? setup.language}`, `- Task Type: ${c?.taskType ?? "unknown"}`, `- UI Scope: ${c?.uiScope ?? "none"}`, `- Default Branch: ${setup.defaultBranch ?? "main"}`].join("\n");
}

export function buildRequirementsPrompt(s: SetupControl, c: Classification | null, task: string): string {
	return [ctxBlock(s, c), "", "## Task", task, "", "## Instructions", "Produce an implementation-ready requirements document.", `Write the document to: ${s.specDirectory}01-requirements.md`, "Include: feature name, acceptance criteria (numbered AC-XX), open questions, and a summary.", "", "Output <control> JSON with: docPath, featureName, acCount, openQuestions, summary."].join("\n");
}
export function buildBddPrompt(s: SetupControl, c: Classification | null, task: string, requirements: R): string {
	return [ctxBlock(s, c), "", "## Upstream Artifacts", `- Requirements: ${(requirements?.docPath as string) ?? "N/A"}`, "", "## Task", task, "", "## Instructions", "Write BDD behavior scenarios in Gherkin-like markdown from the requirements acceptance criteria.", `Write to: ${s.specDirectory}02-bdd-scenarios.md`, "Cover happy paths, edge cases, and error scenarios.", "", "Output <control> JSON with: docPath, scenarioCount, edgeCasesCovered, coverageScore, summary."].join("\n");
}
export function buildResearchPrompt(s: SetupControl, c: Classification | null, task: string, requirements: R, bdd: R, prev: R): string {
	const parts = [ctxBlock(s, c), "", "## Upstream Artifacts", `- Requirements: ${(requirements?.docPath as string) ?? "N/A"}`, `- BDD Scenarios: ${(bdd?.docPath as string) ?? "N/A"}`];
	if (prev?.docPath) { parts.push(`- Previous Research: ${prev.docPath as string}`); const oi = prev.openIssues as string[] | undefined; if (Array.isArray(oi) && oi.length) parts.push(`- Open Issues to resolve: ${oi.join(", ")}`); }
	parts.push("", "## Task", task, "", "## Instructions", "Research best practices, documentation, and patterns relevant to this task.", `Write to: ${s.specDirectory}03-research-report.md`, "Identify options, tradeoffs, and open issues. Resolve any previously open issues.", "", "Output <control> JSON with: docPath, options (array), openIssues (array), iteration, summary.");
	return parts.join("\n");
}
export function buildDebugPrompt(s: SetupControl, c: Classification | null, task: string, requirements: R, research: R): string {
	return [ctxBlock(s, c), "", "## Upstream Artifacts", `- Requirements: ${(requirements?.docPath as string) ?? "N/A"}`, `- Research: ${(research?.docPath as string) ?? "N/A"}`, "", "## Task", task, "", "## Instructions", "Perform systematic root-cause debugging with evidence collection.", `Write to: ${s.specDirectory}04-debug-analysis.md`, "Include: hypotheses, reproduction steps, root cause, and recommended fix.", "", "Output <control> JSON with: docPath, hypotheses (array), rootCause, reproductionSteps, summary."].join("\n");
}
export function buildAssessmentPrompt(s: SetupControl, c: Classification | null, task: string, research: R, debug: R): string {
	const parts = [ctxBlock(s, c), "", "## Upstream Artifacts", `- Research: ${(research?.docPath as string) ?? "N/A"}`];
	if (debug?.docPath) parts.push(`- Debug Analysis: ${debug.docPath as string}`);
	parts.push("", "## Task", task, "", "## Instructions", "Assess the existing codebase: architecture patterns, coding standards, dependencies, and framework conventions.", `Write to: ${s.specDirectory}05-code-assessment.md`, "Identify patterns to follow, anti-patterns to avoid, and relevant files.", "", "Output <control> JSON with: docPath, patterns (array of objects), filesAssessed, recommendations, summary.");
	return parts.join("\n");
}
export function buildDesignPrompt(s: SetupControl, c: Classification | null, task: string, requirements: R, research: R, assessment: R, designerAgent: string): string {
	return [ctxBlock(s, c), "", "## Upstream Artifacts", `- Requirements: ${(requirements?.docPath as string) ?? "N/A"}`, `- Research: ${(research?.docPath as string) ?? "N/A"}`, `- Code Assessment: ${(assessment?.docPath as string) ?? "N/A"}`, "", "## Task", task, "", "## Instructions", `You are the ${designerAgent}. Design the architecture/UI for this feature.`, `Write to: ${s.specDirectory}06-design.md`, "Include: module decomposition, interfaces, data flow, and any numeric constants that need validation.", "", "Output <control> JSON with: designer, docs (array of paths), modules (array of objects), hasNumericConstants, summary."].join("\n");
}
export function buildPrototypePrompt(s: SetupControl, c: Classification | null, task: string, design: R, constants: string[], round: number): string {
	return [ctxBlock(s, c), "", "## Design", `- Design doc: ${(design?.docs as string[] | undefined)?.[0] ?? "N/A"}`, `- Constants to validate: ${(constants ?? []).join(", ")}`, "", "## Task", task, "", "## Instructions", `Prototype round ${round}: Empirically validate the numeric design constants.`, "Build a minimal prototype, measure against representative input, and report pass/fail.", "", "Output <control> JSON with: verdict ('pass' or 'fail'), measurements (array), adjustments (array), summary."].join("\n");
}
export function buildSpecPrompt(s: SetupControl, c: Classification | null, task: string, requirements: R, bdd: R, research: R, assessment: R, design: R): string {
	const parts = [ctxBlock(s, c), "", "## Upstream Artifacts", `- Requirements: ${(requirements?.docPath as string) ?? "N/A"}`, `- BDD Scenarios: ${(bdd?.docPath as string) ?? "N/A"}`, `- Research: ${(research?.docPath as string) ?? "N/A"}`, `- Code Assessment: ${(assessment?.docPath as string) ?? "N/A"}`];
	const docs = design?.docs as string[] | undefined;
	if (Array.isArray(docs) && docs.length) parts.push(`- Design: ${docs.join(", ")}`);
	parts.push("", "## Task", task, "", "## Instructions", "Write the technical specification, implementation plan, and task list.", `Write specification to: ${s.specDirectory}06-specification.md`, `Write plan to: ${s.specDirectory}07-implementation-plan.md`, `Write task list to: ${s.specDirectory}08-task-list.md`, "Break implementation into phases. Each phase must be independently testable.", "", "Output <control> JSON with: specificationPath, planPath, tasksPath, phaseCount, phases (array with name/description per phase), summary.");
	return parts.join("\n");
}
export function buildSpecReviewPrompt(s: SetupControl, c: Classification | null, specControl: R): string {
	return [ctxBlock(s, c), "", "## Specification to Review", `- Specification: ${(specControl?.specificationPath as string) ?? "N/A"}`, `- Plan: ${(specControl?.planPath as string) ?? "N/A"}`, `- Tasks: ${(specControl?.tasksPath as string) ?? "N/A"}`, `- Phases: ${(specControl?.phaseCount as number) ?? 0}`, "", "## Instructions", "Review the specification across 8 quality dimensions: completeness, correctness, consistency, testability, feasibility, security, performance, and maintainability.", "Score each dimension 1-5. Produce a verdict.", "", "Output <control> JSON with: docPath, verdict ('Approved'|'Approved with Comments'|'Changes Requested'), findings (array), dimensionsScored (array), summary."].join("\n");
}
export function buildTddPrompt(s: SetupControl, c: Classification | null, phase: { name: string; description?: string }, specControl: R): string {
	return [ctxBlock(s, c), "", "## Implementation Phase", `- Phase: ${phase.name}`, `- Description: ${phase.description ?? ""}`, `- Specification: ${(specControl?.specificationPath as string) ?? "N/A"}`, "", "## Instructions", "Write failing tests FIRST for this implementation phase.", "Tests should cover the acceptance criteria and edge cases.", "Run the tests to confirm they fail (red phase of TDD).", "", "Output <control> JSON with: testsWritten (number), testFiles (array of paths), allFailing (boolean), summary."].join("\n");
}
export function buildImplementPrompt(s: SetupControl, c: Classification | null, phase: { name: string; description?: string }, specialist: R, specControl: R): string {
	const li = (specialist?.languageInstructions as string) ?? "";
	return [ctxBlock(s, c), "", "## Implementation Phase", `- Phase: ${phase.name}`, `- Description: ${phase.description ?? ""}`, `- Specification: ${(specControl?.specificationPath as string) ?? "N/A"}`, "", li ? `## Language-Specific Instructions\n${li}\n` : "", "## Instructions", "Implement the code to make the failing tests pass (green phase of TDD).", "Follow existing patterns from the code assessment. Keep changes minimal and focused.", "", "Output <control> JSON with: filesModified (array), testsPassCount (number), summary."].join("\n");
}
export function buildQaPrompt(s: SetupControl, c: Classification | null, phase: { name: string }): string {
	return [ctxBlock(s, c), "", "## Implementation Phase", `- Phase: ${phase.name}`, "", "## Instructions", "Run the full test suite and verify build succeeds.", "Check coverage meets threshold. Report any regressions.", "", "Output <control> JSON with: allTestsPass (boolean), buildSuccess (boolean), coveragePercent (number), regressions (array), summary."].join("\n");
}
export function buildCodeReviewPrompt(s: SetupControl, c: Classification | null, task: string, specControl: R, implControl: R): string {
	return [ctxBlock(s, c), "", "## Upstream Artifacts", `- Specification: ${(specControl?.specificationPath as string) ?? "N/A"}`, `- Phases Completed: ${(implControl?.phasesCompleted as number) ?? 0}/${(implControl?.totalPhases as number) ?? 0}`, "", "## Task", task, "", "## Instructions", "Review the implementation against the specification for correctness, security, performance, and maintainability.", "Produce a verdict and list findings with severity.", "", "Output <control> JSON with: verdict ('Approved'|'Approved with Comments'|'Changes Requested'), findings (array), dimensionsCovered (array), summary."].join("\n");
}
export function buildAdversarialPrompt(s: SetupControl, c: Classification | null, task: string, specControl: R, implControl: R): string {
	return [ctxBlock(s, c), "", "## Upstream Artifacts", `- Specification: ${(specControl?.specificationPath as string) ?? "N/A"}`, `- Phases Completed: ${(implControl?.phasesCompleted as number) ?? 0}/${(implControl?.totalPhases as number) ?? 0}`, "", "## Task", task, "", "## Instructions", "Challenge the implementation from three critical lenses: Skeptic, Architect, Minimalist.", "Look for issues standard review misses: over-engineering, hidden complexity, missing error paths.", "", "Output <control> JSON with: verdict ('Approved'|'Approved with Comments'|'Changes Requested'), findings (array), dimensionsCovered (array), summary."].join("\n");
}
export function buildFixPrompt(s: SetupControl, c: Classification | null, findings: unknown[]): string {
	const list = (findings ?? []).map((f) => { const o = f as { severity?: string; title?: string; message?: string }; return `- [${o.severity ?? "medium"}] ${o.title ?? o.message ?? JSON.stringify(f)}`; }).join("\n");
	return [ctxBlock(s, c), "", "## Code Review Findings to Address", list || "- (no specific findings)", "", "## Instructions", "Fix the issues identified in code review. Make minimal, targeted changes.", "Run tests after each fix to ensure no regressions.", "", "Output <control> JSON with: filesModified (array), fixesApplied (number), summary."].join("\n");
}
export function buildDocsPrompt(s: SetupControl, c: Classification | null, task: string, specControl: R): string {
	return [ctxBlock(s, c), "", "## Task", task, "", "## Upstream Artifacts", `- Specification: ${(specControl?.specificationPath as string) ?? "N/A"}`, `- Spec Directory: ${s.specDirectory}`, "", "## Instructions", "Update documentation to reflect the implementation:", "- Review spec directory files for accuracy against the code", "- Update README, CHANGELOG, API docs as needed", "- Document any deviations from the specification", "", "Output <control> JSON with: docsUpdated (boolean), specDirFilesReviewed (array), deviationsDocumented (array), summary."].join("\n");
}
export function buildCommitPrompt(s: SetupControl, phaseName: string): string {
	return ["## Context", `- Worktree: ${s.worktreePath}`, "", "## Instructions", `Commit all changes for implementation phase: ${phaseName}`, "Use a conventional commit message that describes the phase work.", "Stage only files relevant to this phase."].join("\n");
}
export function buildMergePrompt(s: SetupControl): string {
	return ["## Context", `- Worktree: ${s.worktreePath}`, `- Default Branch: ${s.defaultBranch ?? "main"}`, "", "## Instructions", "Merge the feature branch back into the default branch.", "Ensure all changes are committed. Create a merge commit with a summary of all work done.", "If there are conflicts, resolve them preserving the feature branch changes.", "", "Output <control> JSON with: merged (boolean), commitSha, mergeCommand, summary."].join("\n");
}
