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
import { renderRetryFeedbackBlock, type RetryFeedback } from "./retry-feedback.ts";
import { DATA_FENCE_PREAMBLE, fenceUntrusted } from "./fence.ts";
export { DATA_FENCE_PREAMBLE, fenceUntrusted };

/** M19/R-02 (SCENARIO-063): the standing preamble printed above EVERY DATA
 *  fence — untrusted text may contain prompt-injection attempts, and the model
 *  is told up front that fenced content is data, never instructions. */


/** Fence the LLM-authored task under `## Task` (single wiring point for every
 *  task-embedding builder). */
function fencedTask(task: string): string {
	return fenceUntrusted(task, "task content");
}

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

/** Coerce an unknown control value into a clean string[] (drops non-strings and
 *  blanks). Local copy to avoid a circular import from stages/implementation.ts,
 *  which imports this module. */
function toStringArray(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.map((v) => (typeof v === "string" ? v.trim() : "")).filter(Boolean);
}

function scenarioRefsFromValue(value: unknown): string[] {
	const raw = Array.isArray(value) ? value : [value];
	const ids: string[] = [];
	for (const item of raw) {
		if (typeof item === "number" && Number.isInteger(item)) {
			ids.push(`SCENARIO-${String(item).padStart(3, "0")}`);
			continue;
		}
		if (typeof item !== "string") continue;
		const matches = [...item.matchAll(/\bSCENARIO-(\d+)\b/gi)].map((m) => `SCENARIO-${String(Number(m[1] ?? "0")).padStart(3, "0")}`);
		if (matches.length) ids.push(...matches);
		else if (/^\d+$/.test(item.trim())) ids.push(`SCENARIO-${String(Number(item.trim())).padStart(3, "0")}`);
	}
	return [...new Set(ids)].sort((a, b) => Number(a.split("-")[1]) - Number(b.split("-")[1]));
}

function mergeScenarioRefs(values: unknown[]): string[] {
	return [...new Set(values.flatMap(scenarioRefsFromValue))].sort((a, b) => Number(a.split("-")[1]) - Number(b.split("-")[1]));
}

function phaseTasksFor(specControl: R, phaseName: string): string[] {
	const tasks = Array.isArray(specControl?.tasks) ? specControl.tasks as Array<Record<string, unknown>> : [];
	return tasks
		.filter((task) => typeof task.phase === "string" && task.phase.trim() === phaseName)
		.map((task) => String(task.description ?? "").trim())
		.filter(Boolean);
}

function phaseScenarioRefsFor(specControl: R, phase: { name: string; scenarioRefs?: unknown }): string[] {
	const tasks = Array.isArray(specControl?.tasks) ? specControl.tasks as Array<Record<string, unknown>> : [];
	const taskRefs = tasks
		.filter((task) => typeof task.phase === "string" && task.phase.trim() === phase.name)
		.map((task) => task.scenarioRefs);
	return mergeScenarioRefs([phase.scenarioRefs, ...taskRefs]);
}

/** A stage that writes several docs at once (the spec stage: specification +
 *  implementation-plan + task-list) resolves ALL its slugs together so they get
 *  DISTINCT indices. Resolving each slug independently via specDoc() is the bug
 *  behind three docs colliding on the same number (08-specification.md,
 *  08-implementation-plan.md, 08-task-list.md): on a fresh run none exist yet,
 *  and nextDocNumber only excludes the SAME slug, so every slug computes the
 *  identical "next free" index. Here:
 *   - a slug with an EXISTING `NN-<slug>.md` reuses it (idempotent across retries);
 *   - not-yet-existing slugs take consecutive indices from a base that counts the
 *     files NOT owned by this group, so they never collide with each other or
 *     with prior stages' docs. */
export function specDocs(s: SetupControl, slugs: string[]): string[] {
	// Base = count of numbered docs that are NOT one of this group's slugs, +1.
	let base = nextDocNumber(s.specDirectory, slugs);
	return slugs.map((slug) => {
		const existing = existingDocForSlug(s.specDirectory, slug);
		if (existing) return `${s.specDirectory}${existing}`;
		return `${s.specDirectory}${pad(base++)}-${slug}.md`;
	});
}

/** A single stage's doc path, STABLE across retries: if a `NN-<slug>.md` file
 *  already exists in the spec dir, reuse it (overwrite in place); otherwise
 *  allocate the next free index. Without the reuse step, a stage that re-runs
 *  (spec/review convergence, any gate retry) produced a NEW `NN-<slug>.md` every
 *  round — e.g. 06-specification.md, then 09-specification.md, then 12-… —
 *  because nextDocNumber only excluded the SAME slug while OTHER slugs' files
 *  inflated the count. Reusing the existing per-slug file is the correct
 *  idempotent behavior (one artifact per slug, updated in place). */
export function specDoc(s: SetupControl, slug: string): string {
	const existing = existingDocForSlug(s.specDirectory, slug);
	if (existing) return `${s.specDirectory}${existing}`;
	return `${s.specDirectory}${pad(nextDocNumber(s.specDirectory, [slug]))}-${slug}.md`;
}

/** Return the FIRST existing `NN-<slug>.md` filename in the spec dir (lowest
 *  index wins if duplicates already exist from a pre-fix run), or null. */
function existingDocForSlug(specDir: string, slug: string): string | null {
	try {
		const matches = readdirSync(specDir)
			.filter((entry) => new RegExp(`^\\d{2}-${slug.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.md$`).test(entry))
			.sort();
		return matches[0] ?? null;
	} catch { return null; }
}

function ctxBlock(setup: SetupControl, c: Classification | null): string {
	return ["## Context", `- Worktree: ${setup.worktreePath}`, `- Spec Directory: ${setup.specDirectory}`, `- Language: ${c?.language ?? setup.language}`, `- Task Type: ${c?.taskType ?? "unknown"}`, `- UI Scope: ${c?.uiScope ?? "none"}`, `- Default Branch: ${setup.defaultBranch ?? "main"}`].join("\n");
}

/** LLM task classifier (Stage 2A). Replaces the brittle keyword regex with an
 *  intent-aware routing decision. Research on agent routing (2026) is consistent:
 *  regex/keyword routers are brittle and miss compound intent, so production
 *  systems fall through to an LLM classifier for anything non-trivial. */
export function buildClassifyPrompt(s: SetupControl, task: string): string {
	return [
		"## Context",
		`- Worktree: ${s.worktreePath}`,
		`- Detected language: ${s.language}`,
		`- Repo UI auto-detected: ${s.isWebUi ? "yes" : "no"}`,
		"",
		"## Task",
		fencedTask(task),
		"",
		"## Instructions",
		"Classify this task for pipeline routing. Judge by the task's actual INTENT, not by isolated keywords — a feature that merely mentions 'error handling' is NOT a bug, and a task that asks for a page/upload/chart needs UI scope even if the repo auto-detect missed it.",
		"You MAY read/grep the repo lightly to confirm referenced pages/endpoints, but keep it fast.",
		"",
		"## Data to return",
		"- taskType: 'bug' (fixing incorrect behavior in existing functionality) | 'feature' (new capability/endpoint/page/flow) | 'refactor' (restructure, no behavior change)",
		"- uiScope: 'none' (backend/API/library only) | 'ui-only' (frontend, no new backend) | 'ui+arch' (both UI and backend/architecture)",
		"- rationale: one sentence citing the concrete task signals you used",
		"",
		"Output <control> JSON with: taskType, uiScope, rationale.",
	].join("\n");
}

export function buildRequirementsPrompt(s: SetupControl, c: Classification | null, task: string): string {
	return [ctxBlock(s, c), "", "## Task", fencedTask(task), "", "## Instructions", "Produce an implementation-ready requirements document.", "Resolve ambiguity into explicit acceptance criteria or non-functional constraints before returning. The pipeline treats openQuestions as unresolved ambiguity, so leave openQuestions empty unless a specific user-only decision blocks all implementation; never use it for generic caveats or future work.", "GROUNDING (critical): before you assert that an EXISTING code entity, contract, schema, route, type, or connection MUST be preserved/extended/unchanged, VERIFY it actually exists in the codebase (you have source-read-only access — grep/read for it). Do NOT write an acceptance criterion that references a baseline that is not present in the repo: if the thing does not exist, treat the capability as NEW/greenfield instead of asserting a preserved 'existing' contract, or record the uncertainty in openQuestions. An AC that demands preserving a non-existent baseline is unimplementable and will stall downstream RED tests.", "The document will be RENDERED FOR YOU from your structured output — focus on CONTENT, not format. Do NOT write the document yourself.", "", "## Data to return", "Return the requirements as structured data:", "- title: the feature/fix title", "- date: today's date (YYYY-MM-DD)", "- type: 'feature' | 'bug-fix' | 'refactor' | 'enhancement'", "- priority: 'high' | 'medium' | 'low' | 'critical'", "- executiveSummary: 2-3 sentence summary", "- acceptanceCriteria: array of { id: 'AC-01', statement: string, verifiedBy?: 'deterministic' | 'test' | 'manual' } (at least 2) — classify each AC: deterministic (a build/gate can check it: file exists, pattern present, count enforced), test (needs an automated behavioral test), manual (needs human/visual verification)", "- nonFunctional: array of performance/security/accessibility notes (at least 1)", "- openQuestions (optional): array of strings; must be empty when the task can proceed", "", "Output <control> JSON with: title, date, type, priority, executiveSummary, acceptanceCriteria, nonFunctional, openQuestions?."].join("\n");
}
export function buildBddPrompt(s: SetupControl, c: Classification | null, task: string, requirements: R): string {
	return [ctxBlock(s, c), "", "## Upstream Artifacts", `- Requirements: ${(requirements?.docPath as string) ?? "N/A"}`, "", "## Task", fencedTask(task), "", "## Instructions", "Write BDD behavior scenarios from the requirements acceptance criteria.", "Cover happy paths, edge cases, and error scenarios.", "Every AC-NN from the requirements doc must be referenced by at least one scenario, and every scenario acRef must name an AC-NN that exists in the requirements doc. The BDD artifact is invalid while any requirements AC is uncovered.", "NEVER invent an acceptance criterion: do not mint a new AC-NN, and do not write a scenario whose acRef points to an AC that is not present in the requirements doc. If a behavior you believe is needed has no backing AC, that is a REQUIREMENTS gap — surface it (cover only the ACs that exist) rather than fabricating an AC here.", "The document will be RENDERED FOR YOU from your structured output — focus on CONTENT, not markdown format. Do NOT write the document yourself.", "", "## Data to return", "Return the scenarios as structured data:", "- title: the feature/spec title", "- date: today's date (YYYY-MM-DD)", "- source: the requirements doc path", "- features: array of { name: string, scenarios: [{ id: '001', title, acRef: 'AC-01', priority: 'high'|'medium'|'low', given, when, then, andClauses?: string[] }] }", "- traceability (optional): array of { acId, description, scenarios: ['SCENARIO-001', ...] }", "", "Output <control> JSON with: title, date, source, features, traceability?."].join("\n");
}
export function buildResearchPrompt(s: SetupControl, c: Classification | null, task: string, requirements: R, bdd: R, prev: R): string {
	const parts = [ctxBlock(s, c), "", "## Upstream Artifacts", `- Requirements: ${(requirements?.docPath as string) ?? "N/A"}`, `- BDD Scenarios: ${(bdd?.docPath as string) ?? "N/A"}`];
	if (prev?.docPath) { parts.push(`- Previous Research: ${prev.docPath as string}`); const oi = prev.openIssues as string[] | undefined; if (Array.isArray(oi) && oi.length) parts.push(`- Open Issues to resolve in this research round: ${oi.join(", ")}`); }
	parts.push("", "## Task", fencedTask(task), "", "## Instructions",
		"Do ONLINE RESEARCH to find the best EXTERNAL knowledge for THIS requirement and its BDD scenarios. This is NOT codebase analysis — analyzing the existing repository is the separate code-assessment stage's job. Your job is to bring in knowledge that is NOT already in this repo.",
		"- Read the Requirements and BDD Scenarios docs above first, then derive the 2-4 research questions that actually matter for implementing them (frameworks/libraries, algorithms, protocols, security/perf pitfalls, applicable standards or spec versions, idiomatic patterns).",
		"- USE THE WEB TOOLS. Preferred search order in this repository: AnySearch first, then Firecrawl MCP/CLI, then Tavily remote MCP, then Tinyfish. If those are not exposed in your tool surface, use `web_search`/`fetch_content` for the same search→fetch pattern. Search each question with several varied queries, then fetch/extract the most authoritative results (official docs, RFCs/standards, primary sources, high-quality community posts) and read the real content — do not rely on snippets alone. If MCP servers are configured, you may also use the `mcp` gateway (e.g. a library-docs server) to pull authoritative reference material.",
		"- Ground every option and recommendation in what you FOUND online, tied back to the requirement/BDD it serves. Prefer current, version-accurate sources; note the date.",
		"- If web tools are unavailable or a provider is not configured, say so explicitly, fall back to your own knowledge, and mark the affected claims as unverified — never fabricate sources or URLs.",
		"- Use openIssues ONLY for concrete, answerable ambiguities that require another research iteration. If retry feedback or Previous Research names open issues, treat them as the search agenda for this round and resolve each with source-backed evidence before returning. Do NOT put generic caveats, future work, or permanently unresolvable limitations in openIssues; include those in summary/options instead and keep openIssues empty.",
		"The document will be RENDERED FOR YOU — focus on CONTENT. Do NOT write the document.",
		"", "## Data to return", "Return the research as structured data:",
		"- title: the research topic title",
		"- date: today's date",
		"- summary: one-paragraph synthesis of what the online research concluded",
		"- options: array of { name: string, tradeoffs: string } (at least 1), each grounded in a real source and the requirement/BDD it addresses",
		"- sources: array of { title: string, url: string } — the real URLs you actually fetched/searched (empty ONLY if web tools were unavailable)",
		"- openIssues: array of concrete answerable blocker questions that need another research pass (empty if none)",
		"", "Output <control> JSON with: title, date, summary, options, sources.");
	return parts.join("\n");
}
export function buildDebugPrompt(s: SetupControl, c: Classification | null, task: string, requirements: R, research: R): string {
	return [ctxBlock(s, c), "", "## Upstream Artifacts", `- Requirements: ${(requirements?.docPath as string) ?? "N/A"}`, `- Research: ${(research?.docPath as string) ?? "N/A"}`, "", "## Task", fencedTask(task), "", "## Instructions", "Perform systematic root-cause debugging with evidence collection.", "The document will be RENDERED FOR YOU — focus on CONTENT. Do NOT write the document.", "Include: hypotheses, reproduction steps, root cause, and recommended fix.", "", "Output <control> JSON with: title, date, summary, hypotheses, rootCause, reproductionSteps.", "Field shapes (STRICT): hypotheses = JSON array of SHORT hypothesis strings, one entry per hypothesis — never objects or nested structures; rootCause = ONE prose string — fold verification/evidence/locations INTO the prose, never an object; summary = one paragraph; reproductionSteps = array of short step strings."].join("\n");
}
export function buildAssessmentPrompt(s: SetupControl, c: Classification | null, task: string, research: R, debug: R): string {
	const parts = [ctxBlock(s, c), "", "## Upstream Artifacts", `- Research: ${(research?.docPath as string) ?? "N/A"}`];
	if (debug?.docPath) parts.push(`- Debug Analysis: ${debug.docPath as string}`);
	parts.push("", "## Task", fencedTask(task), "", "## Instructions", "Assess the existing codebase: architecture patterns, coding standards, dependencies, and framework conventions.", "The document will be RENDERED FOR YOU — focus on CONTENT. Do NOT write the document.", "", "Also identify how to RUN this app locally for testing: the shell command to start the API server and (if present) the UI dev server, the env var that sets the port (e.g. PORT), and a health/readiness URL path (e.g. /health or /). Read the README, package.json scripts, Dockerfile/Makefile, and server entrypoints to determine these.", "", "## Data to return", "Return the assessment as structured data:", "- title, date, summary", "- patterns: array of { name, example (file:line), consistency }", "- recommendations: array of strings", "- filesAssessed: array of file paths", "- services (optional): { api?: {cmd, portEnv, readyPath}, ui?: {cmd, portEnv, readyPath} }", "", "Output <control> JSON with: title, date, summary, patterns, recommendations, filesAssessed, services?.");
	return parts.join("\n");
}
export function buildDesignPrompt(s: SetupControl, c: Classification | null, task: string, requirements: R, research: R, assessment: R, designerAgent: string): string {
	return [ctxBlock(s, c), "", "## Upstream Artifacts", `- Requirements: ${(requirements?.docPath as string) ?? "N/A"}`, `- Research: ${(research?.docPath as string) ?? "N/A"}`, `- Code Assessment: ${(assessment?.docPath as string) ?? "N/A"}`, "", "## Task", fencedTask(task), "", "## Instructions", `You are the ${designerAgent}. Design the architecture/UI for this feature.`, "The document will be RENDERED FOR YOU — focus on CONTENT. Do NOT write the document.", "Include: module decomposition, interfaces, data flow, and any numeric constants that need validation.",
"When the design states any paired generate/validate contract (a pattern, allowlist, filename convention, or key set that something both PRODUCES and VALIDATES against), declare it in the contracts block: name, the regex pattern, the FULL enumerated closure derived from the actual source via a stated derivationRule, and the sourceAnchor (repo-relative path, optional \"#exportName\") it derives from. A deterministic checker verifies every enumerated value matches the pattern, the anchor exists, and uniqueness holds — a violation fails the round with the full table, so derive, never hand-write.",
"When a design decision had real alternatives, record it in alternativesConsidered ({decision, chosen, rationale, alternatives}) — a decision recorded without what it beat invites re-litigation. `alternatives` MUST be a JSON ARRAY of short strings (one rejected option per element, e.g. [\"exact-text equality — freezes prose\", \"LLM-judged conformance — nondeterministic\"]); NEVER one long prose string.", "", "Output <control> JSON with: title, date, summary, designer, modules [{name, description}], hasNumericConstants, contracts (optional) [{name, pattern, enumerates[], sourceAnchor?, derivationRule?, uniqueness?}], alternativesConsidered (optional) [{decision, chosen, rationale, alternatives: string[]}]."].join("\n");
}
export function buildPrototypePrompt(s: SetupControl, c: Classification | null, task: string, design: R, constants: string[], round: number, previous: R = null): string {
	const previousBlock = previous
		? ["", renderRetryFeedbackBlock([{
			stage: "prototype",
			attempt: Math.max(1, round - 1),
			gate: "prototype-verdict",
			location: "previous prototype round",
			observed: `Verdict: ${String(previous.verdict ?? "unknown")}`,
			expected: "prototype verdict pass with measurements validating the numeric constants",
			diagnostics: [
				`Measurements: ${Array.isArray(previous.measurements) ? previous.measurements.map(String).join("; ") || "none" : String(previous.measurements ?? "none")}`,
				`Adjustments: ${Array.isArray(previous.adjustments) ? previous.adjustments.map(String).join("; ") || "none" : String(previous.adjustments ?? "none")}`,
			],
			nextAction: "Use this feedback directly. Do not repeat the same failed measurement setup unless you explain why it is still the correct validation path.",
		} satisfies RetryFeedback], "Previous Prototype Round Feedback")]
		: [];
	return [ctxBlock(s, c), "", "## Design", `- Design doc: ${(design?.docs as string[] | undefined)?.[0] ?? "N/A"}`, `- Constants to validate: ${(constants ?? []).join(", ")}`, ...previousBlock, "", "## Task", fencedTask(task), "", "## Instructions", `Prototype round ${round}: Empirically validate the numeric design constants.`, "Build a minimal prototype, measure against representative input, and report the verdict.", "The verdict field MUST be exactly one of the two lowercase strings: pass or fail. Never PROTOTYPE_COMPLETE, never uppercase, never prose in the verdict field — put reservations in adjustments and still report pass when the constants validate.", "The document will be RENDERED FOR YOU — focus on CONTENT. Do NOT write the document.", "", "Output <control> JSON with: title, date, summary, verdict (exactly pass or fail), measurements, adjustments."].join("\n");
}
export function buildSpecPrompt(s: SetupControl, c: Classification | null, task: string, requirements: R, bdd: R, research: R, assessment: R, design: R, prototype: R = null): string {
	const parts = [ctxBlock(s, c), "", "## Upstream Artifacts", `- Requirements: ${(requirements?.docPath as string) ?? "N/A"}`, `- BDD Scenarios: ${(bdd?.docPath as string) ?? "N/A"}`, `- Research: ${(research?.docPath as string) ?? "N/A"}`, `- Code Assessment: ${(assessment?.docPath as string) ?? "N/A"}`];
	const docs = design?.docs as string[] | undefined;
	if (Array.isArray(docs) && docs.length) parts.push(`- Design: ${docs.join(", ")}`);
	if (prototype?.docPath) parts.push(`- Prototype Report: ${prototype.docPath as string}`);
	/* render pipeline: spec returns structured data; 3 docs rendered from it */
	parts.push("", "## Task", fencedTask(task), "", "## Instructions", "Write the technical specification, implementation plan, and task list.", "The documents will be RENDERED FOR YOU — focus on CONTENT. Do NOT write the documents.", "Build an explicit trace matrix from Requirements AC-NN IDs to BDD SCENARIO-NNN IDs to implementation phases/tasks. The spec is invalid unless every requirements acceptance criterion and every BDD scenario is covered by that matrix.", "Reference ONLY upstream IDs that actually exist: every AC-NN must appear in the Requirements doc and every SCENARIO-NNN must appear in the BDD doc — never invent or renumber one. Likewise, every file, function, API, type, route, or dependency the spec names as EXISTING must be verified against the actual codebase (you have source-read-only access); do not ground the spec on a component that is not present in the repo. A reference to a non-existent scenario, AC, or code entity is a spec defect that will stall implementation.", "Break implementation into phases. Each phase must be independently testable. Prefer FEWER, COARSER, independently-shippable phases (each with its own deliverable); avoid over-decomposing a feature into many tiny interdependent phases — if two phases must share state or edit the same files, MERGE them into one phase. Granular interdependent phases cascade-fail; coarse independent phases converge.", "If a Prototype Report is present, incorporate its verdict, measurements, and adjustments into the architecture, testing strategy, and phase deliverables; do not ignore failed or borderline prototype evidence.", "Every requirements AC-NN from the Requirements doc must appear in acceptanceCriteriaRefs and in the specification narrative. Every BDD scenario from the BDD Scenarios doc must appear in scenarioRefs, in the specification narrative, and in at least one phase.scenarioRefs or task.scenarioRefs entry. Every task.phase must exactly match a declared phase.name.", "If retry feedback names convergence-ledger finding IDs, include reviewResponses entries for every ID: findingId, status, response, evidence, and ownerStage. Do not drop unresolved prior findings; either address them with evidence, mark needs-human with the exact ambiguity, or explain why they are deferred/non-blocking.", "When a finding is owned by an upstream artifact (requirements, BDD, research, assessment, design, or prototype), do not pretend a spec-only rewrite fixed it unless the spec can fully resolve the inconsistency. Preserve the ownerStage in reviewResponses so the next review can verify the routing.", "Do not pass ambiguity to implementation. If a decision is still unclear, resolve it using upstream evidence or route it explicitly through reviewResponses with ownerStage and blocking status so the review can stop the pipeline before code is written.", "Paired generate/validate contracts (patterns, allowlists, filename conventions, key sets, threshold tables) must be DERIVED from the actual registry/source via a stated rule and shipped with the enumerated closure table (every admitted value listed) — never hand-written on both sides. If a pattern and its enumeration disagree, the derivation rule is wrong: fix the rule, then regenerate the table.", "", "## Data to return", "Return the specification as structured data:", "- title, date, summary", "- architecture: the technical architecture (prose)", "- testingStrategy: how the feature will be tested (prose)", "- acceptanceCriteriaRefs: array of AC-NN IDs from the Requirements doc", "- scenarioRefs: array of SCENARIO-NNN IDs from the BDD Scenarios doc", "- phases: array of { name, description, deliverables? } (at least 1, each independently testable; may also include scenarioRefs?: string[] to map BDD scenarios to phases)", "- tasks: array of { phase, description, scenarioRefs? }", "- reviewResponses (optional on first attempt, REQUIRED on retries with convergence-ledger IDs): [{ findingId, status, response, evidence?, ownerStage? }]", "- gate (optional, Rust/backend only): { packages: [real cargo package names whose tests must pass], workspace: boolean (true = run cargo test --workspace), integration: [paths to e2e/integration test files to also run] }", "- deliverables (optional, per phase): declare when a phase's deliverable is NOT compiler-checkable — { requireFiles: [paths that must exist], requireContains: [{ file, pattern } regex that must appear], requireNotContains: [{ file, pattern } regex that must NOT appear], requireScenarios: [SCENARIO-NNN tags that must appear in the phase's test file contents], requireTests: [full test names that must exist in the test list] }. Phases that create a file, wire a call site X→Y, make new sources reachable, or cover a scenario MUST declare deliverables — without them a phase compiles green while delivering nothing. Deliverables are AND-ed with build-green, so a missing file/pattern/scenario/test fails the phase even when the build passes. PREFER requireScenarios over requireTests: a SCENARIO-NNN tag is a STABLE id that survives test rewording, whereas a full requireTests name is brittle (a reworded `it(...)` title false-negatives forever and the implementer is forbidden from editing RED tests to fix it). Use requireTests only when no scenario tag applies. For requireContains, assert semantic anchors and avoid arbitrary local variable names from examples: prefer flexible identifier regex such as `[A-Za-z_$][\\w$]*\\.POST` over `h\\.POST`; patterns for code files are matched against comment-stripped code, so comments do not satisfy wiring assertions.", "", "Output <control> JSON with: title, date, summary, architecture, testingStrategy, acceptanceCriteriaRefs?, scenarioRefs, phases, tasks, reviewResponses? (REQUIRED on retries whose feedback names convergence-ledger finding IDs), gate? (Rust/backend only).");
	return parts.join("\n");
}
/** Shared builder for the upstream-stage reviewers (requirements/bdd/design).
 *  Each reviews the just-written artifact against its stage-specific dimensions
 *  (encoded in the agent .md) and returns a verdict + blocking/suggestion
 *  findings — caught EARLY so upstream defects don't cascade into the spec. The
 *  reviewer is read-only and never rewrites the artifact. `upstream` lists the
 *  prior-stage docs it should cross-check against. `priorResponses` are the
 *  writer's responses to a prior review round, threaded so the reviewer can
 *  verify each was actually resolved (mirrors buildSpecReviewPrompt). */
export function buildUpstreamReviewPrompt(
	s: SetupControl,
	c: Classification | null,
	args: { stage: "requirements" | "bdd" | "design"; docPath?: string; upstream: Array<{ label: string; path?: string }>; priorResponses?: Array<Record<string, unknown>> },
): string {
	const upstreamLines = args.upstream.filter((u) => u.path).map((u) => `- ${u.label}: ${u.path}`);
	const stageLabel = args.stage === "bdd" ? "BDD scenarios" : args.stage;
	const responses = Array.isArray(args.priorResponses) ? args.priorResponses : [];
	// AC-31 (SCENARIO-063): the writer's response rows are LLM-authored prose —
	// fence the whole list.
	const responseLines = responses.length
		? ["", "## Prior Finding Responses to Verify", fenceUntrusted(responses.map((r) => `- ${String(r.findingId ?? "finding")}: status=${String(r.status ?? "unknown")} ownerStage=${String(r.ownerStage ?? "unknown")} evidence=${String(r.evidence ?? "none")} response=${String(r.response ?? "")}`).join("\n"), "prior finding responses")]
		: [];
	return [
		ctxBlock(s, c),
		"",
		`## ${stageLabel} artifact to review`,
		`- Document: ${args.docPath ?? "N/A"}`,
		...(upstreamLines.length ? ["", "## Upstream artifacts to cross-check", ...upstreamLines] : []),
		...responseLines,
		"",
		"## Instructions",
		`Review the ${stageLabel} artifact against the review dimensions defined for your role. Find defects EARLY — a defect caught here is orders of magnitude cheaper than at spec or code review.`,
		"Read the ACTUAL artifact (and the upstream docs) before judging; ground every finding in a specific section, AC, scenario, or module.",
		"Mark blocking=true for correctness/completeness/consistency/contract defects; blocking=false for suggestions. Set ownerStage to the true owning stage — this stage, or an upstream stage when the defect is inherited.",
		"Use verdict 'Changes Requested' when any blocking finding exists; 'Approved with Comments' when only suggestions remain; 'Approved' when clean.",
		"Convergence duty (review-loop contract): this is an iterative revise-review loop with a hard round cap. Do NOT introduce NEW blocking findings in later rounds unless they are P0/P1 (High/Critical) correctness defects that would genuinely break implementation. When every prior blocking finding is resolved and only advisory/polish items remain, you MUST return 'Approved' or 'Approved with Comments' — do not hold the loop open for preferences. Never re-flag a finding the writer resolved unless it regressed (use priorFindingId). Judge the CURRENT artifact, not the history.", "When the artifact carries a Contract Claims section, a deterministic checker has already verified pattern-vs-enumeration closure, regex validity, and source-anchor existence — do NOT re-derive those. Your job is what the machine cannot do: READ the cited source and verify the ENUMERATION MATCHES REALITY (no missing/extra values), and judge whether the derivation rule itself is right.", "Finding quality bar (calibration): raise a finding only when it is a discrete, actionable defect in THIS artifact that would meaningfully harm accuracy, consistency, or implementability; was introduced in or survives in the current revision (upstream-rooted defects go via ownerStage, not duplicate re-flagging); and whose impact is provable — name the specific section, scenario, AC, or contract affected. Speculation that a change might break something elsewhere is not a finding; neither is rigor the surrounding artifact never had. One finding per distinct defect — merge candidates sharing location and remedy. Use severity P0 (assumption-free defect that breaks implementation outright), P1 (urgent correctness), P2 (normal), P3 (low/advisory), and emit a 0..1 confidence on every finding. Zero findings is a valid, respected outcome — an honest approval with residual risks noted beats a padded blocker list. Deterministic gates already own: id formats and bidirectional AC/SCENARIO coverage, artifact/control shape, and verdict vocabulary — do NOT spend findings re-flagging those (report the gate itself only if the gate is wrong); spend attention where nothing else checks.", "When a defect GENERALIZES (a rule, pattern, or convention that other parts of the artifact also violate), tag that finding with a short stable defectClass name (e.g. \"pattern-rejects-registry-keys\") and state the generalization rule in the detail — do not enumerate every instance yourself; naming the class once is enough.",
		"For prior findings, set status=verified ONLY when the response and current artifact actually resolve it; if it remains open or regressed, keep blocking=true and set priorFindingId to the old findingId.",
		"Score each dimension. Produce a verdict. Do NOT rewrite the artifact — the document is RENDERED FOR YOU from your structured data.",
		"",
		"## Data to return",
		"Return: title, date, verdict, summary, findings [{id, severity, title, detail, ownerStage, blocking, status, recommendation, evidence, priorFindingId?, defectClass?, confidence?}], priorFindingResolutions? [{findingId, status, response, evidence?, ownerStage?}], dimensions [{name, status, notes}]",
		"",
		"Output <control> JSON with: title, date, verdict, summary, findings, priorFindingResolutions?, dimensions.",
	].join("\n");
}

export function buildSpecReviewPrompt(s: SetupControl, c: Classification | null, specControl: R): string {
	const responses = Array.isArray(specControl?.reviewResponses) ? specControl.reviewResponses as Array<Record<string, unknown>> : [];
	// AC-31 (SCENARIO-063): fence the writer's LLM-authored response rows.
	const responseLines = responses.length
		? ["", "## Prior Finding Responses to Verify", fenceUntrusted(responses.map((r) => `- ${String(r.findingId ?? "finding")}: status=${String(r.status ?? "unknown")} ownerStage=${String(r.ownerStage ?? "unknown")} evidence=${String(r.evidence ?? "none")} response=${String(r.response ?? "")}`).join("\n"), "prior finding responses")]
		: [];
	return [ctxBlock(s, c), "", "## Specification to Review", `- Specification: ${(specControl?.specificationPath as string) ?? "N/A"}`, `- Plan: ${((specControl?.planPath ?? specControl?.implementationPlanPath) as string) ?? "N/A"}`, `- Tasks: ${((specControl?.tasksPath ?? specControl?.taskListPath) as string) ?? "N/A"}`, `- Phases: ${(specControl?.phaseCount as number) ?? 0}`, ...responseLines, "", "## Instructions", "Review the specification across these 8 required quality dimensions: Completeness, Consistency, Feasibility, Testability, Traceability, Grounding, Complexity, and Ambiguity.", "Testability specifically: every phase that maps one or more BDD scenarios MUST declare a test deliverable — deliverables.requireScenarios (PREFERRED: the SCENARIO-NNN tags it covers, a stable id) or deliverables.requireTests. A scenario-mapped phase with no test deliverable can compile green while delivering zero test coverage; flag it (ownerStage=spec, blocking) and use verdict Changes Requested.", "Traceability must explicitly check Requirements AC-NN coverage, BDD SCENARIO-NNN coverage, scenario-to-phase/task mapping, and whether prior convergence findings are explicitly resolved in reviewResponses. If any requirement, scenario, task, phase, test obligation, prior finding response, or owner-stage routing is missing or ambiguous, use verdict Changes Requested.", "Every finding must include ownerStage, blocking, status, recommendation, and evidence. Use ownerStage=requirements/bdd/research/assessment/design/prototype/spec when an upstream artifact must be changed; use ownerStage=spec only when a specification rewrite can fix it; use ownerStage=environment only for local/tooling failures.", "For prior findings, set status=verified only when the response and current spec actually resolve it. If it remains open or regressed, include priorFindingId with the old findingId and keep blocking=true when it blocks implementation.", "Score each dimension 1-5. Produce a verdict.", "Convergence duty (review-loop contract): this is an iterative revise-review loop with a hard round cap. Do NOT introduce NEW blocking findings in later rounds unless they are P0/P1 (High/Critical) defects that would genuinely break implementation. When every prior blocking finding is resolved and the remaining items are advisory (cosmetic duplication, naming, optional elaboration), you MUST use 'Approved' or 'Approved with Comments' — the loop ends on your approval, so an unbounded stream of fresh minor blockers kills productive runs. Never re-flag a resolved finding unless it regressed (use priorFindingId).", "Finding quality bar (calibration): raise a finding only when it is a discrete, actionable defect in THIS artifact that would meaningfully harm accuracy, consistency, or implementability; was introduced in or survives in the current revision (upstream-rooted defects go via ownerStage, not duplicate re-flagging); and whose impact is provable — name the specific section, scenario, AC, or contract affected. Speculation that a change might break something elsewhere is not a finding; neither is rigor the surrounding artifact never had. One finding per distinct defect — merge candidates sharing location and remedy. Use severity P0 (assumption-free defect that breaks implementation outright), P1 (urgent correctness), P2 (normal), P3 (low/advisory), and emit a 0..1 confidence on every finding. Zero findings is a valid, respected outcome — an honest approval with residual risks noted beats a padded blocker list. Deterministic gates already own: id formats and bidirectional AC/SCENARIO coverage, phases shape, review-document dimension shape, deliverable file/pattern checks, and verdict vocabulary — do NOT spend findings re-flagging those (report the gate itself only if the gate is wrong); spend attention where nothing else checks.", "When a defect GENERALIZES (a rule, pattern, or convention that other parts of the artifact also violate), tag that finding with a short stable defectClass name (e.g. \"pattern-rejects-registry-keys\") and state the generalization rule in the detail — do not enumerate every instance yourself; naming the class once is enough.", "The document will be RENDERED FOR YOU — focus on CONTENT. Do NOT write the document.", "", "## Data to return", "Return: title, date, verdict, summary, findings [{id, severity, title, detail, ownerStage, blocking, status, recommendation, evidence, priorFindingId?, defectClass?, confidence?}], priorFindingResolutions? [{findingId, status, response, evidence?, ownerStage?}], dimensions [{name, status, notes}]", "", "Output <control> JSON with: title, date, verdict, summary, findings, priorFindingResolutions?, dimensions."].join("\n");
}
export function buildTddPrompt(s: SetupControl, c: Classification | null, phase: { name: string; description?: string; scenarioRefs?: unknown; deliverables?: unknown }, specControl: R, langInstructions = "", bddControl: R = null): string {
	const scenarioRefs = scenarioRefsFromValue(specControl?.scenarioRefs);
	const phaseScenarioRefs = phaseScenarioRefsFor(specControl, phase);
	const phaseTasks = phaseTasksFor(specControl, phase.name);
	const scenarioBaseline = phaseScenarioRefs.length
		? phaseScenarioRefs.join(", ")
		: scenarioRefs.length ? scenarioRefs.join(", ") : "read the BDD scenarios doc and derive the SCENARIO-NNN baseline";
	const scenarioBaselineLabel = phaseScenarioRefs.length ? "Phase scenarioRefs baseline" : "Spec scenarioRefs baseline";
	// AC-31 (SCENARIO-063): the LLM-derived scenario list is fenced when it
	// exists; the harness-authored fallback prose stays unfenced.
	const scenarioList = phaseScenarioRefs.length ? phaseScenarioRefs : scenarioRefs;
	const scenarioBaselineValue = scenarioList.length
		? `\n${fenceUntrusted(scenarioBaseline, "scenario baseline")}`
		: ` ${scenarioBaseline}`;
	const taskLines = phaseTasks.length ? phaseTasks.map((t) => `- ${t}`) : ["- No explicit task rows were mapped to this phase; use the phase name/description and BDD scenario refs as the coverage boundary."];
	// Root-cause fix: the RED author is graded by the deterministic deliverable
	// gate on `requireTests` NAME strings + `requireFiles`, but was previously
	// never told them — so it named tests freely and the gate reported
	// `missing test: <name>` forever, while the later implementer could only
	// satisfy the gate by editing the RED files (rejected as
	// `tdd-tests-modified-during-green`). Surfacing the exact contract here lets
	// the RED phase produce the required names up front (context-over-procedure).
	const deliverables = (phase.deliverables ?? null) as { requireTests?: unknown; requireFiles?: unknown; requireScenarios?: unknown } | null;
	const requiredTests = toStringArray(deliverables?.requireTests);
	const requiredFiles = toStringArray(deliverables?.requireFiles);
	const requiredScenarios = toStringArray(deliverables?.requireScenarios);
	const deliverableLines: string[] = [];
	if (requiredTests.length || requiredFiles.length || requiredScenarios.length) {
		deliverableLines.push("", "## Required Deliverables (deterministic gate — must match EXACTLY)");
		if (requiredScenarios.length) {
			deliverableLines.push(
				// RC9 (run 15-07): comments are STRIPPED before the deterministic
				// contains-match — "a comment" was a false contract; Go test names
				// cannot contain '-' so tags there are usually comments.
				"The phase is only GREEN when EACH of these BDD scenario tags appears VERBATIM in your test file contents in MATCHED CODE — a test title or a string-literal tag constant (any convention: vitest/jest `it(...)`/`test(...)`, pytest `def test_*`, Go `func TestXxx(t *testing.T)` titles or string-typed consts, Rust `#[test] fn` names). Comments do NOT count — the gate strips comments before matching, and Go test names cannot contain '-':",
				fenceUntrusted(requiredScenarios.map((t) => `- ${t}`).join("\n"), "required scenario tags"),
			);
		}
		if (requiredTests.length) {
			deliverableLines.push(
				"The project test list must contain a test whose name matches EACH of these. Name your test cases so these strings appear VERBATIM in the test-name line the runner lists (vitest/jest `it(...)`/`test(...)` titles; pytest `def test_*` function names; Go `func TestXxx(t *testing.T)` names; Rust `#[test] fn` names) — the gate matches the listed test-name line, not the file:",
				fenceUntrusted(requiredTests.map((t) => `- ${t}`).join("\n"), "required test names"),
			);
		}
		if (requiredFiles.length) {
			deliverableLines.push("Place tests so these deliverable files exist and are wired:", fenceUntrusted(requiredFiles.map((f) => `- ${f}`).join("\n"), "required deliverable files"));
		}
	}
	return [
		ctxBlock(s, c),
		"",
		"## Implementation Phase",
		`- Phase: ${phase.name}`,
		`- Description: ${phase.description ?? ""}`,
		`- Specification: ${(specControl?.specificationPath as string) ?? "N/A"}`,
		`- BDD Scenarios: ${(bddControl?.docPath as string) ?? "N/A"}`,
		`- ${scenarioBaselineLabel}:${scenarioBaselineValue}`,
		"",
		// AC-31 (SCENARIO-063): the task rows come from the LLM-authored spec
		// control — fence the whole list.
		"## Phase Tasks",
		fenceUntrusted(taskLines.join("\n"), "phase task rows"),
		...deliverableLines,
		"",
		langInstructions ? `## Language-Specific Instructions\n${langInstructions}\n` : "",
		// v0.3.49: test CATEGORIES (user mandate 2026-08-31) — author the RED
		// suite as a categorized pyramid instead of one undifferentiated blob.
		// The coverage hard floor (≥85% lines on phase production files, aim
		// 100% on pure logic) is enforced deterministically post-GREEN; writing
		// coverage-complete unit tests from the start avoids coverage retries.
		"## Test Categories — author every test at its right level",
		"- UNIT (default): one pure behavior per test — pure logic, parsing, math, state transitions. No I/O, no network, no DOM, no clocks. Fastest tier; aim for 100% line coverage of pure logic here.",
		"- INTEGRATION: behavior that emerges from wiring — module composition, file I/O through the real API, DOM mounting, request handling. Stub ONLY external boundaries (network/time), never internal collaborators.",
		"- SCENARIO: BDD-mapped acceptance — one test per SCENARIO-NNN your phase owns, the scenario tag verbatim in the test name, asserting the user-visible outcome end-to-end.",
		"- Ratio guidance: mostly unit, fewer integration, scenario tests only for acceptance the phase owns. Prefer adding a unit test over thickening an existing one.",
		"- Name files by category in the project's idiom (e.g. math.unit.test.ts / wiring.integration.test.ts / phase1-acceptance.scenario.test.mjs, *_test.go by package) so the suite stays navigable.",
		"- COVERAGE HARD FLOOR: after GREEN, the harness measures line coverage over this phase's production files (≥85% floor, deterministic). Write unit tests for every branch of your production code now — uncovered behavior forces a coverage retry later.",
		"",
		"## Instructions",
		"Write failing tests FIRST for this implementation phase.",
		// RC11: match the test level to the task's stated observable — a
		// declaration-level task gets a declaration-binding test; do not invent a
		// deeper observable the task never states.
		"TEST LEVEL = TASK LEVEL: each task row states its observable. When a task's observable is declaration/source-level (e.g. 'must declare type X', 'must implement TableName()'), bind the test to exactly that declared observable. When it is behavior-level (persist and read back a row, return a status code), write a behavior test. Never demand or author a different observable than the task states — the RED review enforces the same precedence.",
		"Before writing tests, build a Scenario Coverage Matrix from the BDD scenarios and the spec scenarioRefs. Cover every SCENARIO-NNN relevant to this phase; if the spec does not map scenarios to phases, cover every scenarioRef in the baseline above.",
		requiredTests.length || requiredScenarios.length ? "You MUST also satisfy every item under Required Deliverables above — author each named test using that exact name string, and embed each required SCENARIO-NNN tag verbatim in a test. These are the deterministic acceptance gate — the phase cannot go green while any is absent, and the later implementer is FORBIDDEN from adding them (editing these RED tests during implementation is rejected). Author them now." : "",
		"Do not mark the RED phase complete while any relevant BDD scenario lacks a test. Missing scenario coverage is an invalid RED sample; add or revise tests until the coverage matrix is complete.",
		"A RED run that compiles/collects and fails because the implementation is missing or behavior is not implemented yet is valid. On interpreted stacks (node/vitest --reporter=tap, python) a greenfield suite that fails to LOAD solely because the module under test does not exist is reported by the runner as a failing test — that IS a valid, verifiable RED: leave it and report it; the implementer will create the module. On compiled stacks (rust/go/jvm) a suite that cannot COMPILE produces no per-test evidence — the oracle honestly returns unknown and the recovery is the judge's allow-scaffold route, NOT a stub: do NOT create a production file or stub module during RED to satisfy typecheck; RED may ONLY create test (and test-support) files. A test that fails only because it references a non-existent type/property UNRELATED to the intended public contract is BROKEN, not RED.",
		"Run the tests to confirm they fail (red phase of TDD). Prefer suites that LOAD and fail at the assertion level (per-test structured evidence) over suites that cannot even load.",
		"In summary, include the scenario coverage matrix as SCENARIO-NNN -> test file/test name and explicitly say `missing scenario coverage: none` when complete.",
		"",
		// v0.3.16 F3 (RC-T3, run 2026-08-23T02-59-20-670Z): the RED author died at the
		// wall clock 15/26 times because it explored for 15+ minutes before writing.
		// A written-but-unverified file survives a timeout (the oracle can classify
		// it next round); prose and an unreturned structured_output do not. This
		// block is deliberately AFTER the correctness instructions and BEFORE the
		// control spec so it reads as the closing discipline.
		"## Deadline survival (OVERRIDES exploration thoroughness)",
		"- WRITE THE TEST FILE TO DISK EARLY. The file on disk is the deliverable; a written-but-unverified file survives a wall-clock timeout, prose and an unreturned structured_output do not.",
		"- Cap exploration at ~10 tool calls total before you start writing. You do NOT need to re-derive the whole codebase — the phase tasks and BDD scenarios above already state the observable.",
		"- Order of operations: (1) draft the test file, (2) write it to disk, (3) run the scoped test once to confirm it fails, (4) call structured_output. If you are running low on time, do (2) and (4) even if (3) is incomplete — report honestly in `summary` what was not verified.",
		"- On a retry whose feedback says the previous try TIMED OUT: do not re-explore material the feedback already summarizes. Go straight to writing/fixing the file.",
		"",
		"Output <control> JSON with: testsWritten (number), testFiles (array of paths), allFailing (boolean), summary.",
	].filter(Boolean).join("\n");
}
/** Fix 3 — language-scoped Rust self-verification discipline (AC-07,
 *  SCENARIO-010 implement / SCENARIO-011 qa). Appended UNCONDITIONALLY to
 *  buildImplementPrompt and buildQaPrompt; scoped to Rust via its wording
 *  ("When verifying a Rust crate…") so non-Rust stacks are unaffected.
 *  Prompt-TEXT only — the stages consume these builders unchanged, so there
 *  is NO control-flow / nodes / workflow / pipeline change. */
const RUST_SELF_VERIFY_DISCIPLINE = "When verifying a Rust crate, run `cargo test -p <pkg>` WITHOUT the `--lib` flag so the integration binaries under tests/ execute as well, PLUS any spec-mandated e2e or integration target. Do NOT declare green on `--lib`-only evidence: `--lib` skips the tests/ integration binaries, so it is never sufficient proof.";

/** spec-11 AC-06 / SCENARIO-011: the implementer's + fixer's claimed change set
 *  is now STRUCTURED (`{filesCreated, filesModified, filesDeleted}`) AND is
 *  git-cross-checked by the per-run ChangeTracker. Claiming a file you did not
 *  actually change in git fails the phase (the false-green killer). Appended to
 *  `buildImplementPrompt` + `buildFixPrompt` so both green-phase agents carry
 *  the identical contract (single source of truth). */
const GIT_CROSSCHECK_WARNING = "These file claims are git-cross-checked: claiming a file you did not change fails the phase. Report only project source/docs/test files you actually created, modified, or deleted; do NOT include super-dev runtime/cache artifacts such as `.resume-cache.jsonl`, `change-tracker.jsonl`, or `.user-notes.json`.";

/** Return the Rust verification discipline ONLY for Rust projects (review
 *  finding: it was previously broadcast to ALL languages). Uses the
 *  SETUP-detected language (`s.language`, derived from repo manifests) so it is
 *  reliable even when the per-task classification is null at prompt-build time.
 *
 *  Exported so `src/stages/implementation.ts` can pass it as the
 *  `langInstructions` arg of `buildTddPrompt` (Gap 3 / P4, AC-03 →
 *  SCENARIO-010) — the RED-phase prompt then carries the IDENTICAL
 *  `RUST_SELF_VERIFY_DISCIPLINE` source string that `buildImplementPrompt` and
 *  `buildQaPrompt` already embed, closing the no-`--lib` parity gap. Degrades to
 *  the empty string for non-rust setups and on null/undefined/malformed `s`
 *  (via `s?.language`) — never throws. */
export function rustDiscipline(s: SetupControl): string {
	return s?.language === "rust" ? RUST_SELF_VERIFY_DISCIPLINE : "";
}

/** Plan 2 Tier 2 — independent RED test-quality review. An INDEPENDENT reviewer
 *  (cross-model when configured) audits the RED test cases BEFORE implementation:
 *  do the assertions bind each scenario's OBSERVABLE behavior, or are they weak
 *  (tautologies, asserting a stub constant, coupling to implementation details)?
 *  A "weak" verdict routes the RED phase back to tdd-guide. Read-only. */
export function buildRedReviewPrompt(
	s: SetupControl,
	c: Classification | null,
	phase: { name: string; description?: string },
	testFiles: string[],
	expectedScenarios: string[],
	specControl: R,
	bddControl: R,
): string {
	return [
		ctxBlock(s, c),
		"",
		"## RED test review (test-quality gate, BEFORE implementation)",
		`- Phase: ${phase.name}`,
		// AC-31 (SCENARIO-063): the RED-authored test-file list and the
		// LLM-derived expected-scenario list are untrusted — fence them.
		`- Test files to review:${testFiles.length ? `\n${fenceUntrusted(testFiles.join("\n"), "test file list")}` : " (none)"}`,
		`- Scenarios these tests must cover:${expectedScenarios.length ? `\n${fenceUntrusted(expectedScenarios.join("\n"), "expected scenario list")}` : " (derive from the BDD doc)"}`,
		`- Specification: ${(specControl?.specificationPath as string) ?? "N/A"}`,
		`- BDD Scenarios: ${(bddControl?.docPath as string) ?? "N/A"}`,
		"",
		"## Instructions",
		"You are STRICTLY READ-ONLY: never create, modify, or delete any file — not tests, not production code, not configs. A review that writes anything is discarded and the boundary guard restores your edits (run 2026-08-31T03-25-44-485Z).",
		"Read the test files above. There is NO implementation yet — this is the RED phase. Judge ONLY test QUALITY, not whether they pass.",
		"For each mapped scenario, decide whether its test asserts the scenario's OBSERVABLE behavior with a concrete expected value (status code, returned value, emitted effect, error).",
		// RC11 (run 10-39): the phase's task rows and deliverables define the
		// observable. When a task's stated observable is declaration/source-level
		// (e.g. 'must declare type X' / 'must implement TableName()'), a test that
		// asserts THAT declared observable is behavior-binding — the reviewer must
		// NOT demand a different observable the task never states (that made the
		// loop unsatisfiable: declaration tests rejected as weak, behavior tests
		// broke compilation).
		"TASK-CONTRACT PRECEDENCE: the phase's task rows and deliverables (read the specification) define each scenario's observable. When a task's observable is explicitly declaration/source-level, a test binding exactly that declared observable counts as behavior-binding. Do not demand a deeper observable (runtime persistence, integration effects) that the task never states. Report a contradiction only when the stated contract itself is jointly unsatisfiable.",
		"A test is WEAK if any of: it has no meaningful assertion; it asserts a tautology (e.g. expect(true).toBe(true)); it asserts a hard-coded stub/constant rather than computed behavior; it only checks an implementation detail (an internal call/shape) that the task did NOT state as the observable (per TASK-CONTRACT PRECEDENCE above, a declaration-level task makes that declaration the contract); or a trivial/wrong implementation would satisfy it.",
		"Return verdict=\"strong\" ONLY when EVERY mapped scenario has at least one behavior-binding assertion. Otherwise verdict=\"weak\" and name the specific weak tests/scenarios and the missing assertion in summary.",
		"JOINT SATISFIABILITY (mandatory second dimension): verify at least ONE conforming implementation could pass ALL these tests SIMULTANEOUSLY. Cross-check scenarios that share fixtures, sample data, or assert on the same behavior for internal contradictions (e.g. one scenario requires byte-identical output across validators while another mandates different error tokens for the same inputs; one requires a value both X and not-X). If NO conforming implementation can pass all tests, report each contradiction in `contradictions` with the exact test names/lines and a concise impossibility proof, and ALSO set verdict=\"weak\". When the suite is jointly satisfiable, emit contradictions as an empty array [] — never omit the key.",
		"You are read-only: do NOT edit any file.",
		"",
		"## Data to return",
		"Return: verdict (\"strong\" | \"weak\"), summary (one line; when weak, name the weak tests/scenarios and the missing assertion), contradictions (array of {tests, lines, proof}; [] when jointly satisfiable).",
		"",
		"Output <control> JSON with: verdict, summary, contradictions (array of {tests, lines, proof} — ALWAYS emit; use [] when the suite is jointly satisfiable).",
	].join("\n");
}

export function buildImplementPrompt(s: SetupControl, c: Classification | null, phase: { name: string; description?: string; deliverables?: unknown }, specialist: R, specControl: R): string {
	const li = (specialist?.languageInstructions as string) ?? "";
	const rust = rustDiscipline(s);
	// Gate-criteria-in-prompt invariant (Fix 5): the deliverable gate grades this
	// agent on requireFiles/requireContains, so tell it those UP FRONT instead of
	// only via post-failure retry feedback. requireTests/requireScenarios are the
	// RED author's responsibility (the implementer is forbidden from editing RED
	// tests), so they are intentionally omitted here.
	const d = (phase.deliverables ?? null) as { requireFiles?: unknown; requireContains?: Array<{ file?: unknown; pattern?: unknown }> } | null;
	const reqFiles = toStringArray(d?.requireFiles);
	const reqContains = Array.isArray(d?.requireContains)
		? d!.requireContains.map((e) => (e && typeof e.file === "string" && typeof e.pattern === "string") ? `${e.pattern} in ${e.file}` : "").filter(Boolean)
		: [];
	const deliverableLines: string[] = [];
	if (reqFiles.length || reqContains.length) {
		deliverableLines.push("## Required Deliverables (deterministic gate — the phase is not green until ALL are satisfied)");
		if (reqFiles.length) deliverableLines.push("These files MUST exist and be wired:", ...reqFiles.map((f) => `- ${f}`));
		if (reqContains.length) deliverableLines.push("These patterns MUST appear (matched against comment-stripped code):", ...reqContains.map((p) => `- ${p}`));
		deliverableLines.push("");
	}
	return [ctxBlock(s, c), "", "## Implementation Phase", `- Phase: ${phase.name}`, `- Description: ${phase.description ?? ""}`, `- Specification: ${(specControl?.specificationPath as string) ?? "N/A"}`, "", li ? `## Language-Specific Instructions\n${li}\n` : "", ...deliverableLines, "## Instructions", "Implement the code to make the failing tests pass (green phase of TDD).", "The test files are the CONFIRMED RED oracle — they are READ-ONLY during GREEN. Do NOT create, edit, or modify ANY test file (not even a comment, header, or import). Any change to a test file is detected and automatically reverted, and the phase cannot go green while a test file was touched, so editing tests only wastes a turn. Implement ONLY production/source code. If a test looks stale, wrong, or redundant, leave it untouched — fixing tests is the RED phase's responsibility, not yours.", "CHALLENGING AN UNSATISFIABLE RED TEST (the only exception to read-only tests): if you have PROVEN a confirmed RED test cannot be satisfied by ANY conforming implementation — e.g. an internal contradiction (asserting a value is both of type object and callable), or compile errors in the test file itself that you cannot fix because tests are read-only — do NOT edit the test. Instead output a testDefects entry naming the file, the exact lines, and a concise impossibility proof, then keep implementing everything else you can. The pipeline routes your proof back to the RED author so it re-authors a satisfiable test. This is NOT an escape hatch for merely-hard tests: use it ONLY when you have a concrete proof that no conforming implementation can pass.", "Follow existing patterns from the code assessment. Keep changes minimal and focused.", "Worktree discipline: the worktree may contain changes you did not make (other phases' committed work, harness artifacts, prior-run leftovers). NEVER revert or delete changes you did not make. When an unexpected foreign change blocks your work, do not fix around it silently — name it in your summary (and in testDefects when it blocks tests) and continue within your own scope.", "Work in a TIGHT edit→build→test→fix loop WITHIN this turn: make a change, run the build + tests, read the failures, fix, repeat until green. Do NOT make all changes blind then declare done.", "Before declaring done, run the FULL test suite for this project's language (`npm test` / `pytest -q` / `go test ./...` / `cargo test` with NO `--lib`), not just this phase's own tests. Cross-cutting regressions in UNRELATED tests are YOUR responsibility — if your change broke an existing test elsewhere, fix it before finishing.", ...(rust ? [rust] : []), "", GIT_CROSSCHECK_WARNING, "Output <control> JSON with: filesCreated (array), filesModified (array), filesDeleted (array), testsPassCount (number), summary, testDefects (array of {testFile, lines, reason} — ALWAYS emit this key; use [] when you have no proven unsatisfiable RED test)."].filter(Boolean).join("\n");
}
export function buildQaPrompt(s: SetupControl, c: Classification | null, phase: { name: string }): string {
	const rust = rustDiscipline(s);
	return [ctxBlock(s, c), "", "## Implementation Phase", `- Phase: ${phase.name}`, "", "## Instructions", "Run the full test suite and verify build succeeds.", "Check coverage meets threshold. Report any regressions.", ...(rust ? [rust] : []), "", "Output <control> JSON with: allTestsPass (boolean), buildSuccess (boolean), coveragePercent (number), regressions (array), summary."].join("\n");
}
export function buildImplementationSummaryPrompt(s: SetupControl, c: Classification | null, impl: R): string {
	return [ctxBlock(s, c), "", "## Implementation Result", `- Phases Completed: ${(impl?.phasesCompleted as number) ?? 0}/${(impl?.totalPhases as number) ?? 0}`, `- All Green: ${(impl?.allGreen as boolean) ?? false}`, `- Files Modified: ${((impl?.filesModified as string[]) ?? []).join(", ") || "none"}`, "", "## Instructions", "Write a concise implementation summary: what was built per phase, files changed, test results, and any deviations from the specification.", "The document will be RENDERED FOR YOU — focus on CONTENT. Do NOT write the document.", "", "Output <control> JSON with: title, date, summary, phasesCompleted, allGreen, filesModified."].join("\n");
}
export function buildCodeReviewPrompt(s: SetupControl, c: Classification | null, task: string, specControl: R, implControl: R): string {
	return [ctxBlock(s, c), "", "## Upstream Artifacts", `- Specification: ${(specControl?.specificationPath as string) ?? "N/A"}`, `- Phases Completed: ${(implControl?.phasesCompleted as number) ?? 0}/${(implControl?.totalPhases as number) ?? 0}`, "", "## Task", fencedTask(task), "", "## Instructions", "Review the implementation against the specification for correctness, security, performance, and maintainability.", "Produce a verdict and list findings with severity.", "Every finding must classify status (open, verified, deferred, or needs-human), blocking (true only when it must stop merge), confidence (0..1), evidence, and recommendation. If you are confirming that a prior issue is fixed, set status=verified and blocking=false even if the prior issue was high severity. If a concern is plausible but unproven, set confidence below 0.7 and either blocking=false or status=needs-human with concrete verification needed.", "The document will be RENDERED FOR YOU — focus on CONTENT. Do NOT write the document.", "", "## Data to return", "Set ownerStage on every finding — implementation when the code must change, or the upstream stage (requirements/bdd/research/design/spec) whose artifact the defect is inherited from (sweep-3 G34: the triage router routes by this field). ", "Return: title, date, verdict, summary, findings [{id, severity, title, detail, ownerStage?, file?, line?, status?, blocking?, confidence?, evidence?, recommendation?}]", "", "Output <control> JSON with: title, date, verdict, summary, findings."].join("\n");
}
export function buildAdversarialPrompt(s: SetupControl, c: Classification | null, task: string, specControl: R, implControl: R): string {
	return [ctxBlock(s, c), "", "## Upstream Artifacts", `- Specification: ${(specControl?.specificationPath as string) ?? "N/A"}`, `- Phases Completed: ${(implControl?.phasesCompleted as number) ?? 0}/${(implControl?.totalPhases as number) ?? 0}`, "", "## Task", fencedTask(task), "", "## Instructions", "Challenge the implementation from three critical lenses: Skeptic, Architect, Minimalist.", "Look for issues standard review misses: over-engineering, hidden complexity, missing error paths.", "Every finding must classify status (open, verified, deferred, or needs-human), blocking (true only when it must stop merge), confidence (0..1), evidence, and recommendation. If you are confirming that a prior issue is fixed, set status=verified and blocking=false even if the prior issue was high severity. If a concern is plausible but unproven, set confidence below 0.7 and either blocking=false or status=needs-human with concrete verification needed.", "The document will be RENDERED FOR YOU — focus on CONTENT. Do NOT write the document.", "", "## Data to return", "Set ownerStage on every finding — implementation when the code must change, or the upstream stage (requirements/bdd/research/design/spec) whose artifact the defect is inherited from (sweep-3 G34: the triage router routes by this field). ", "Return: title, date, verdict, summary, findings [{id, severity, title, detail, ownerStage?, lens?, file?, line?, status?, blocking?, confidence?, evidence?, recommendation?}] (use lens: Skeptic|Architect|Minimalist)", "", "Output <control> JSON with: title, date, verdict, summary, findings."].join("\n");
}

/**
 * R-2 — the tests/validation review angle. Spawned ONLY when the spec
 * declares test deliverables (phase requireTests/requireScenarios or top-level
 * scenarioRefs): the diversity research says the FIRST added angle has the
 * steepest marginal gain, and tests-vs-spec binding is the audit's recurring
 * gap class. Same findings contract as the code review so the merge-layer
 * triage (R-1) applies unchanged. Language-idiomatic by instruction (the
 * reviewer reads the repo's actual stack, not an assumed one).
 */
export function buildTestsReviewPrompt(s: SetupControl, c: Classification | null, task: string, specControl: R, implControl: R): string {
	return [ctxBlock(s, c), "", "## Upstream Artifacts", `- Specification: ${(specControl?.specificationPath as string) ?? "N/A"}`, `- Phases Completed: ${(implControl?.phasesCompleted as number) ?? 0}/${(implControl?.totalPhases as number) ?? 0}`, "", "## Task", fencedTask(task), "", "## Instructions", "Review the TESTS AND VALIDATION of the implementation against the specification.", "Check, with evidence from the actual test files on disk:", "- Do the tests bind to the specification's acceptance criteria and BDD scenario tags (declared requireScenarios must appear verbatim in test contents; declared requireTests must exist by name)?", "- Do assertions verify OBSERVABLE BEHAVIOR (outputs, state, errors) rather than tautologies, implementation details, or always-true constants?", "- Are error paths, boundary conditions, and edge cases covered — not just the happy path?", "- Are the tests deterministic (no uncontrolled randomness, wall-clock time, network, or ordering dependence that would flake)?", "- Do the tests follow the repo's actual language conventions (vitest/jest it()/test(), pytest def test_*, Go func TestXxx(t *testing.T), Rust #[test] fn)?", "Do NOT re-report style or architecture opinions — the code review and adversarial reviewers already cover those. Stay on the tests/validation angle.", "Produce a verdict and list findings with severity.", "Every finding must classify status (open, verified, deferred, or needs-human), blocking (true only when it must stop merge), confidence (0..1), evidence, and recommendation. If you are confirming that a prior issue is fixed, set status=verified and blocking=false even if the prior issue was high severity. If a concern is plausible but unproven, set confidence below 0.7 and either blocking=false or status=needs-human with concrete verification needed.", "The document will be RENDERED FOR YOU — focus on CONTENT. Do NOT write the document.", "", "## Data to return", "Set ownerStage on every finding — implementation when the code must change, or the upstream stage (requirements/bdd/research/design/spec) whose artifact the defect is inherited from (sweep-3 G34: the triage router routes by this field). ", "Return: title, date, verdict, summary, findings [{id, severity, title, detail, ownerStage?, file?, line?, status?, blocking?, confidence?, evidence?, recommendation?}]", "", "Output <control> JSON with: title, date, verdict, summary, findings."].join("\n");
}
/** Judge prompt (docs/requirements/llm-judge-routing-layer.md §3). Self-contained:
 *  no stage artifacts are assumed — the caller renders every context block it
 *  wants the judge to see. The route list is the closed set THIS wiring point
 *  can execute; the contract-test pins the control-line key set. */
/** v0.2.6 G3 — one-line route glosses so the judge can choose a route it has
 * never been offered before (implementer-retry) without guessing its meaning.
 * Shape-level only; unknown routes render bare (future-proof). */
const JUDGE_ROUTE_GLOSSES: Record<string, string> = {
	"re-author-tests": "the RED tests themselves are defective — regenerate them with your diagnosis",
	"challenge-test": "the failing test's premise is wrong — challenge it with evidence",
	"fix-environment": "the failure is environmental (deps, toolchain, pre-existing state) — a human or tool must fix the environment",
	"implementer-retry": "this is a product defect the implementer can fix — retry the implementer with your diagnosis in its feedback",
	"replan-upstream": "the RED cannot be made strong because an UPSTREAM artifact is defective — e.g. an acceptance criterion demands preserving a baseline that does not exist in the code, or the spec references a scenario/AC/entity that is absent — route it back to the owning stage (requirements/bdd/spec) to revise",
	"allow-scaffold": "the RED is blocked only because the tests need NEW declaration-only scaffolding to compile (types/interfaces/consts/enums or unimplemented function signatures) that the spec justifies — approve creating it (the test must still fail RED after; behavior stays unimplemented)",
	"continue": "the next retry WILL differ — say why, citing what changed",
};

export function buildJudgePrompt(scope: string, context: string, allowedRoutes: readonly string[]): string {
	return ["## Role", "You are the diagnostic judge for a deterministic TDD pipeline. A loop has stopped making progress and deterministic code cannot classify the failure. Diagnose WHY and route the next move. You never acquit anything — every gate verdict stands.", "", "## Wiring point", scope, "", "## Routes you may choose from (closed set)", ...allowedRoutes.map((r) => `- ${r}${JUDGE_ROUTE_GLOSSES[r] ? ` — ${JUDGE_ROUTE_GLOSSES[r]}` : ""}`), "- escalate-now (always available: a human must decide)", "", "## Failure context", fenceUntrusted(context, "failure context"), "", "## Instructions", "1. Diagnose the single most likely category of failure from the context (and the worktree files it references — you have read access).", "2. Choose exactly one route from the offered set that your diagnosis implies.", "3. For every route except continue, provide 1-5 evidence items {file, quote}; quote must be 8-200 characters copied VERBATIM from that file or from the captured output in the context. Fabricated quotes discard the verdict.", "4. Be honest: if uncertain, confidence below 0.6 and escalate-now. Do NOT route continue unless you can say why THIS retry differs from the retries that already failed.", "", "## Data to return", "Return: diagnosis (string, at most 600 chars — the category of failure and why), route (one of the offered routes), confidence (number 0..1), evidence (array of {file, quote}; use [] only for route=continue)", "", "Output <control> JSON with: diagnosis, route, confidence, evidence."].join("\n");
}
export function buildReplanOwnerPrompt(finding: Record<string, unknown>, context?: string): string {
	const t = (v: unknown): string => {
		if (v == null) return "";
		if (typeof v === "object") return JSON.stringify(v);
		return String(v).replace(/\s+/g, " ").trim();
	};
	const lines = [
		"- id: " + (t(finding.id) || "(none)"),
		"- severity: " + (t(finding.severity) || "medium"),
		"- title: " + t(finding.title),
		"- detail: " + t(finding.detail),
		"- file: " + (t(finding.file) || "(none)"),
		"- ownerStage (reviewer's guess): " + (t(finding.ownerStage) || "(none)"),
		"- recommendation: " + (t(finding.recommendation) || "(none)"),
	];
	const ev = Array.isArray(finding.evidence) ? finding.evidence.map(t).filter(Boolean) : [];
	if (ev.length) lines.push("- evidence lines:", ...ev.map((e) => "  - " + e));
	return [
		"## Role",
		"You are the replan lead: a downstream review found a defect the code fixer may NOT legitimately fix (it lives in an upstream artifact). Decide WHICH owning stage must revise its artifact — or route it to a human.",
		"",
		"## Closed owner set (choose exactly one)",
		...["requirements", "bdd", "research", "design", "spec", "human"].map((o) => `- ${o}`),
		"",
		// AC-31 (SCENARIO-063): the finding detail/evidence lines are reviewer
		// output — fence the whole block.
		"## The finding (deterministic rules could not route it)",
		fenceUntrusted(lines.join("\n"), "finding detail"),
		...(context ? ["", "## Context", context] : []),
		"",
		"## Instructions",
		"1. Ask: if which artifact's sentence were rewritten, would this finding dissolve? That artifact's stage is the owner. Prefer the shallowest owner that fully resolves it.",
		"2. Location is not ownership: a finding citing src/ code can be a spec gap (no protocol to implement).",
		"3. Route human when the decision needs product/user judgment no artifact revision can encode, or when the finding is actually implementation-domain (misrouted to you).",
		"4. Provide 1-3 evidence items {file, quote}; quote must be 8-200 characters copied VERBATIM from the finding text above. Fabricated quotes discard the verdict.",
		"5. confidence >= 0.6 is required for an owner route; below that, route human.",
		"",
		"## Data to return",
		"Return: owner (one of the closed set), confidence (number 0..1), reason (at most 400 chars), evidence (array of {file, quote}).",
		"",
		"Output <control> JSON with: owner, confidence, reason, evidence.",
	].join("\n");
}
export function buildFixPrompt(s: SetupControl, c: Classification | null, findings: unknown[], testFailures?: unknown[]): string {
	const clean = (value: unknown): string => {
		if (value == null) return "";
		if (typeof value === "object") return JSON.stringify(value);
		return String(value).replace(/\s+/g, " ").trim();
	};
	const list = (findings ?? []).map((f, index) => {
		const o = f as { id?: unknown; severity?: unknown; title?: unknown; message?: unknown; detail?: unknown; file?: unknown; line?: unknown; evidence?: unknown; recommendation?: unknown; ownerStage?: unknown };
		const title = clean(o.title) || clean(o.message) || clean(f) || `Finding ${index + 1}`;
		const id = clean(o.id);
		const file = clean(o.file);
		const line = clean(o.line);
		const evidence = Array.isArray(o.evidence) ? o.evidence.map(clean).filter(Boolean).join("; ") : clean(o.evidence);
		const detail = clean(o.detail);
		const recommendation = clean(o.recommendation);
		const ownerStage = clean(o.ownerStage);
		const rows = [`- ${id ? `${id} ` : ""}[${clean(o.severity) || "medium"}] ${title}`];
		if (file || line) rows.push(`  - Location: ${file || "unknown"}${line ? `:${line}` : ""}`);
		if (detail && detail !== title) rows.push(`  - Detail: ${detail}`);
		if (evidence) rows.push(`  - Evidence: ${evidence}`);
		if (recommendation) rows.push(`  - Recommendation: ${recommendation}`);
		if (ownerStage) rows.push(`  - Owning stage: ${ownerStage}`);
		return rows.join("\n");
	}).join("\n");
	const tlist = (testFailures ?? []).map((f, index) => {
		const o = f as { method?: unknown; path?: unknown; file?: unknown; title?: unknown; message?: unknown; reason?: unknown; expected?: unknown; actual?: unknown };
		const method = clean(o.method);
		const path = clean(o.path) || clean(o.file);
		const reason = clean(o.reason) || clean(o.message) || clean(o.title) || clean(f) || `Failure ${index + 1}`;
		const expected = clean(o.expected);
		const actual = clean(o.actual);
		const rows = [`- ${[method, path].filter(Boolean).join(" ") || `Failure ${index + 1}`} — ${reason}`];
		if (expected || actual) rows.push(`  - Expected/actual: ${expected || "unknown"} / ${actual || "unknown"}`);
		return rows.join("\n");
	}).join("\n");
	// AC-31 (SCENARIO-063): the finding/test-failure lists carry LLM-authored
	// title/detail/evidence text — fence them.
	const parts = [ctxBlock(s, c), "", "## Code Review Findings to Address", list ? fenceUntrusted(list, "review findings") : "- (no specific findings)"];
	if (tlist) parts.push("", "## API/UI Test Failures to Address", fenceUntrusted(tlist, "test failure evidence (API cases carry method/path; UI cases carry flow/reason)"), "");
	parts.push("", "## Instructions", "Fix the issues above. Make minimal, targeted changes.", "Run tests after each fix to ensure no regressions.", "Worktree discipline: the worktree may contain changes you did not make (other phases' committed work, harness artifacts, prior-run leftovers). NEVER revert or delete changes you did not make. When an unexpected foreign change blocks your fix, do not fix around it silently — name it in your summary and continue within your own scope.", "Then update the existing `*-implementation-summary.md` in the spec directory: append a short note of what this fix round changed.", "", GIT_CROSSCHECK_WARNING, "Output <control> JSON with: filesCreated (array), filesModified (array), filesDeleted (array), fixesApplied (number), summary.");
	return parts.join("\n");
}

/** Build the ui-tester prompt. `ui.baseUrl` is the already-running UI dev server;
 *  for a fullstack app `api.baseUrl` is the live API behind it (the UI calls it).
 *  Secrets stay in .env / process.env — referenced by NAME, never printed. */
export function buildUiTestPrompt(s: SetupControl, c: Classification | null, specControl: R, ui: { baseUrl: string }, api?: { baseUrl: string }): string {
	const parts = [ctxBlock(s, c), "", "## Service under test", `- UI base URL: ${ui.baseUrl}`, "- The UI server is ALREADY RUNNING — do not start or stop it."];
	if (api) parts.push(`- The backing API is also running at ${api.baseUrl} (fullstack) — the UI calls it; confirm end-to-end behavior.`);
	parts.push("", "## Authentication", "If the UI requires login, credentials are in `.env` — load it and reference secrets ONLY as process.env.NAME (or type them into the login form from that variable). NEVER print a secret; redact tokens to `***`.", "", "## Upstream Artifacts", `- Specification (implementation plan + scenario table): ${(specControl?.planPath as string) ?? (specControl?.specificationPath as string) ?? "N/A"}`, "", "## Instructions", "Derive user flows from the specification's scenario table (sweep-3 G14: previously mislabeled 'BDD Scenarios' — the UI tester was reading the wrong artifact). Connect via `browser_execute` (CDP auto-discovery: `await session.connect()` then drive a page target) — or Playwright via bash as a fallback. For each flow: navigate, interact, and assert the visible page state. Screenshot any failure.", "Do NOT modify production/source files while testing. If you need a script, put it outside the repository (for example under /tmp) or in an obvious test-only artifact; the harness rejects tester writes to implementation files.", "The document will be RENDERED FOR YOU — focus on CONTENT. Do NOT write the document.", "The report must include: flows tested, per-flow (flow/steps/expected/observed/pass), screenshot refs, overall pass, and a failures list. Redact all credentials.", "", "Output <control> JSON with: pass (boolean), flows (number), failures (array of {flow, reason}), summary.");
	return parts.join("\n");
}

/** Build the api-tester prompt. `service.baseUrl` is the already-running API
 *  (bringup started it). Secrets stay in .env / process.env — referenced by
 *  NAME, redacted, never printed. */
export function buildApiTestPrompt(s: SetupControl, c: Classification | null, specControl: R, service: { baseUrl: string }): string {
	return [ctxBlock(s, c), "", "## Service under test", `- API base URL: ${service.baseUrl}`, "- The server is ALREADY RUNNING — do not start or stop it.", "", "## Authentication", "Determine the auth scheme from the spec and source. If a credential is required it is in `.env` — load it (`set -a; . ./.env; set +a`) and reference it in your test script ONLY as `process.env.NAME`. NEVER print a secret value; redact any Authorization to `***` in every output.", "", "## Upstream Artifacts", `- Specification: ${(specControl?.specificationPath as string) ?? "N/A"}`, "", "## Instructions", "Exercise every endpoint from the spec: full CRUD where applicable, unauthorized attempts (expect 401/403), and edge/invalid bodies (missing fields, wrong types, empty/oversized). Write a node test script using `fetch`, run it, and collect status + a short response excerpt per case.", "Do NOT modify production/source files while testing. If you need a script, put it outside the repository (for example under /tmp) or in an obvious test-only artifact; the harness rejects tester writes to implementation files.", "The document will be RENDERED FOR YOU — focus on CONTENT. Do NOT write the document.", "The report must include: endpoints tested, a per-case table (method/path/body-summary/expected/actual/pass), an overall pass flag, and a failures list. Redact all credentials.", "", "Output <control> JSON with: pass (boolean), cases (number), failures (array of {method, path, reason}), summary."].join("\n");
}
export function buildDocsPrompt(s: SetupControl, c: Classification | null, task: string, specControl: R): string {
	return [ctxBlock(s, c), "", "## Task", fencedTask(task), "", "## Upstream Artifacts", `- Specification: ${(specControl?.specificationPath as string) ?? "N/A"}`, `- Spec Directory: ${s.specDirectory}`, "", "## Instructions", "Prepare the documentation close-out for this verified implementation:", "- Review spec directory files for accuracy against the code", "- Record any README, CHANGELOG, API-doc, or architecture-doc updates that are still needed as recommendations in the documentation report", "- Document any deviations from the specification", "Do NOT edit production source, tests, configs, or project-level docs. The pipeline may render/update the spec-directory documentation artifact for you.", "", "Output <control> JSON with: title, date, summary, docsUpdated, deviationsDocumented."].join("\n");
}
export function buildCommitPrompt(s: SetupControl, phaseName: string): string {
	return ["## Context", `- Worktree: ${s.worktreePath}`, "", "## Instructions", `Commit all changes for implementation phase: ${phaseName}`, "Use a conventional commit message that describes the phase work.", "Stage only files relevant to this phase."].join("\n");
}
export function buildMergePrompt(s: SetupControl): string {
	return ["## Context", `- Worktree: ${s.worktreePath}`, `- Default Branch: ${s.defaultBranch ?? "main"}`, "", "## Instructions", "Merge the feature branch back into the default branch.", "Ensure all changes are committed on the feature branch first (commit any leftovers there).", "IMPORTANT — worktree geometry: the default branch is checked out in the MAIN checkout, so `git checkout <default>` INSIDE this worktree FAILS ('already checked out'). Determine the main checkout path with `git worktree list` (the entry without a `(detached`/feature marker that matches the default branch), then run the merge FROM the main checkout: `git -C <mainCheckout> merge --no-ff <featureBranch> -m <summary>`. Never merge the default branch INTO the feature branch — that is the wrong direction.", "If there are conflicts, resolve them preserving the feature branch changes (still operating via `git -C <mainCheckout>`).", "Report merged:true ONLY if `git -C <mainCheckout> rev-parse <defaultBranch>` now contains the feature branch head (verify with `git -C <mainCheckout> merge-base --is-ancestor <featureBranch> <defaultBranch>`; the pipeline independently re-verifies this — a self-report that git facts contradict will be marked as a failed merge).", "", "Output <control> JSON with: merged (boolean), commitSha, mergeCommand, summary."].join("\n");
}
