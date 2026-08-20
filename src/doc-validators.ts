/**
 * Doc-content validators for the spec-stage gates.
 *
 * The gates in helpers.ts used to trust the agent's self-reported control JSON
 * (scenarioCount, coverageScore, …). That was fragile: models return numbers
 * as strings ("13"), omit keys, or self-report scores that don't match the doc.
 * A real /super-dev run wrote an excellent 26-scenario BDD doc but the gate
 * failed on the control object's shape — a false negative.
 *
 * These validators read the ACTUAL .md file the agent wrote and check its
 * content (regex / min-size), ported from the original super-dev-plugin's
 * scripts/gates/definitions.mjs. Gates prefer this; old metadata checks remain
 * only as diagnostics or limited fallback where cross-document traceability is
 * not required.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import type { ControlObj } from "./types.ts";
import type { PhaseDeliverables } from "./render/schemas.ts";
import { NEGATED_APPROVAL_RE } from "./review-findings.ts";

export interface DocRef {
	path: string;
	content: string;
}

/** Convert a simple filename glob ("*-bdd-scenarios.md") into a RegExp. */
function globToRegExp(glob: string): RegExp {
	const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
	return new RegExp(`^${escaped}$`, "i");
}

/** Count regex matches in content (ensures the `g` flag so match() counts all). */
function countMatches(content: string, re: RegExp): number {
	const global = re.flags.includes("g") ? re : new RegExp(re.source, re.flags + "g");
	return (content.match(global) ?? []).length;
}

function uniqueSortedIds(ids: string[]): string[] {
	return [...new Set(ids)].sort((a, b) => {
		const [ap, an] = a.split("-");
		const [bp, bn] = b.split("-");
		if (ap !== bp) return ap.localeCompare(bp);
		return Number(an) - Number(bn);
	});
}

function normalizedId(prefix: "AC" | "SCENARIO", digits: string): string {
	const width = prefix === "SCENARIO" ? 3 : 2;
	return `${prefix}-${String(Number(digits)).padStart(width, "0")}`;
}

/** Extract normalized AC-NN identifiers from requirements/BDD text. */
export function extractAcceptanceCriteriaIds(content: string): string[] {
	return uniqueSortedIds([...content.matchAll(/\bAC-(\d+)\b/gi)].map((m) => normalizedId("AC", m[1] ?? "0")));
}

function extractAcceptanceCriteriaIdsFromValue(value: unknown): string[] {
	const raw = Array.isArray(value) ? value : [value];
	const ids: string[] = [];
	for (const item of raw) {
		if (typeof item === "number" && Number.isInteger(item)) {
			ids.push(normalizedId("AC", String(item)));
			continue;
		}
		if (typeof item !== "string") continue;
		const matches = extractAcceptanceCriteriaIds(item);
		if (matches.length > 0) ids.push(...matches);
		else if (/^\d+$/.test(item.trim())) ids.push(normalizedId("AC", item.trim()));
	}
	return uniqueSortedIds(ids);
}

/** Extract normalized SCENARIO-NNN identifiers from BDD/spec text. */
export function extractScenarioIds(content: string): string[] {
	return uniqueSortedIds([...content.matchAll(/\bSCENARIO-(\d+)\b/gi)].map((m) => normalizedId("SCENARIO", m[1] ?? "0")));
}

/** A CommonMark fence opener: up to 3 leading spaces, then ≥3 backticks or
 *  tildes (info strings may follow on the opening line). */
const FENCE_OPEN_RE = /^[ \t]{0,3}(`{3,}|~{3,})/;

/** Headings of NON-NORMATIVE rendered sections — response/evidence/convergence
 *  prose where a writer legitimately DISCUSSES out-of-range identifiers while
 *  explaining their removal. The deterministic trace gate must not read them:
 *  run 2026-08-17T04-20-16-328Z failed 8 rounds straight on `AC-24, AC-27,
 *  AC-29` tokens that existed only inside "## Prior Review Responses" notes
 *  explaining they had been deleted (and the retry feedback re-quoted them,
 *  so the writer re-emitted them — a self-referential trap).
 *  M14 (SCENARIO-052/053, OQ-2): CLOSED-SET non-normative headings at levels
 *  1–4 (`#{1,4}`), with an optional WORD-LED qualifier from a fixed vocabulary
 *  ("for Phase 2", "Round 3", "from Stage 9", …) or the historical
 *  parenthetical/dash decoration. "## Convergence Criteria" still never
 *  matches ("Criteria" is not a qualifier — the over-strip guard); the section
 *  closes only at a same-or-HIGHER heading level, tracked per-section. */
export const NON_NORMATIVE_SECTION_RE = /^(#{1,4})\s+(prior\s+(?:review\s+)?(?:finding\s+)?responses?|review\s+responses?|convergence(?:\s+ledger)?|evidence\s+notes?)(?:\s*(?:[(:\u2014\u2013-].*)|\s+(?:for|from|in|round|phase|part|section|appendix|addendum|notes?|entries?)\b.*)?$/i;

/** Remove non-normative sections (heading through the next same-or-higher-level
 *  heading, or EOF) so identifier extraction sees only normative content.
 *  Fences follow CommonMark PAIRING (AC-13): a fence opens at a run of ≥3
 *  backticks or tildes (up to 3 leading spaces; info strings allowed on the
 *  opening line) and closes only on a line whose leading run uses the SAME
 *  character at ≥ the opening length — an inner ``` run never closes a
 *  ````-fence, and a ``` run never closes a ~~~-fence. While inside a fence,
 *  heading lines are prose (never open/close sections), and a non-normative
 *  heading IMPLICITLY closes an unclosed fence (M3 fail-safe: a broken fence
 *  can never swallow the strip logic — SCENARIO-030). Fenced content inside
 *  KEPT sections is preserved verbatim. */
export function stripNonNormativeSections(content: string): string {
	const lines = content.split(/\r?\n/);
	const kept: string[] = [];
	let skipLevel: number | null = null; // the opening heading's level while skipping
	let fence: { char: string; len: number } | null = null; // open fence: opening char + opening run length
	for (const line of lines) {
		if (fence === null) {
			// (1) not in a fence: a fence-opening run opens one.
			const open = FENCE_OPEN_RE.exec(line);
			if (open?.[1]) fence = { char: open[1][0]!, len: open[1].length };
		} else {
			// (2) in a fence: only a SAME-character run of length ≥ the opening
			// length closes it (CommonMark pairing — a char/length mismatch never closes).
			const runRe = fence.char === "`" ? /^[ \t]{0,3}(`+)/ : /^[ \t]{0,3}(~+)/;
			const close = runRe.exec(line);
			if (close?.[1] && close[1].length >= fence.len) {
				fence = null;
			} else if (NON_NORMATIVE_SECTION_RE.test(line)) {
				// (3) still in a fence: a non-normative heading IMPLICITLY closes it —
				// an unclosed fence can never swallow the strip logic (M3 fail-safe).
				fence = null;
			}
		}
		if (fence === null) {
			const heading = /^(#{1,6})\s+/.exec(line);
			if (heading) {
				const level = heading[1]?.length ?? 0;
				if (skipLevel !== null) {
					if (level <= skipLevel) skipLevel = null; // same-or-higher closes the section
					else continue; // deeper heading inside the skipped section
				}
				if (skipLevel === null && NON_NORMATIVE_SECTION_RE.test(line)) {
					skipLevel = level;
					continue; // drop the heading itself
				}
			}
		}
		if (skipLevel === null) kept.push(line);
	}
	return kept.join("\n");
}

function extractScenarioIdsFromValue(value: unknown): string[] {
	const raw = Array.isArray(value) ? value : [value];
	const ids: string[] = [];
	for (const item of raw) {
		if (typeof item === "number" && Number.isInteger(item)) {
			ids.push(normalizedId("SCENARIO", String(item)));
			continue;
		}
		if (typeof item !== "string") continue;
		const matches = extractScenarioIds(item);
		if (matches.length > 0) ids.push(...matches);
		else if (/^\d+$/.test(item.trim())) ids.push(normalizedId("SCENARIO", item.trim()));
	}
	return uniqueSortedIds(ids);
}

/** Extract normalized SCENARIO-NNN identifiers from spec control.scenarioRefs. */
export function extractScenarioRefsFromControl(control: ControlObj | undefined): string[] {
	return extractScenarioIdsFromValue(control?.scenarioRefs);
}

/** Extract normalized AC-NN identifiers from spec control.acceptanceCriteriaRefs. */
export function extractAcceptanceCriteriaRefsFromControl(control: ControlObj | undefined): string[] {
	return extractAcceptanceCriteriaIdsFromValue(control?.acceptanceCriteriaRefs);
}

/** Extract scenario refs from phase/task trace-matrix fields. */
export function extractMappedScenarioRefsFromControl(control: ControlObj | undefined): string[] {
	const refs: string[] = [];
	const phases = Array.isArray(control?.phases) ? control.phases as Array<Record<string, unknown>> : [];
	for (const phase of phases) refs.push(...extractScenarioIdsFromValue(phase.scenarioRefs));
	const tasks = Array.isArray(control?.tasks) ? control.tasks as Array<Record<string, unknown>> : [];
	for (const task of tasks) refs.push(...extractScenarioIdsFromValue(task.scenarioRefs));
	return uniqueSortedIds(refs);
}

function missingIds(required: string[], actual: string[]): string[] {
	const actualSet = new Set(actual);
	return required.filter((id) => !actualSet.has(id));
}

/** BDD must cover every requirements AC and must not cite nonexistent ACs.
 *  AC-26 (SCENARIO-054): both inputs are read NORMATIVE-only (stripped) —
 *  parity with specTraceabilityErrors — so an out-of-range AC id quoted inside
 *  a non-normative Evidence Notes section is not a dangling-reference error. */
export function bddTraceabilityErrors(requirementsContent: string, bddContent: string): string[] {
	const requirementIds = extractAcceptanceCriteriaIds(stripNonNormativeSections(requirementsContent));
	const bddIds = extractAcceptanceCriteriaIds(stripNonNormativeSections(bddContent));
	const errors: string[] = [];
	if (requirementIds.length === 0) errors.push("requirements doc has no AC-NN identifiers for BDD traceability");
	if (bddIds.length === 0) errors.push("BDD doc has no AC-NN references for requirements traceability");
	const uncovered = missingIds(requirementIds, bddIds);
	if (uncovered.length > 0) errors.push(`BDD doc does not cover acceptance criteria: ${uncovered.join(", ")}`);
	const dangling = missingIds(bddIds, requirementIds);
	if (dangling.length > 0) errors.push(`BDD doc references acceptance criteria not found in requirements: ${dangling.join(", ")}`);
	return errors;
}

/** Spec must cover every requirements AC, every BDD scenario, and map tasks to declared phases. */
export function specTraceabilityErrors(bddContent: string, specContent: string, spec: ControlObj | undefined, requirementsContent?: string): string[] {
	// F5 (RC5): extract identifiers from NORMATIVE content only. Response/
	// evidence prose may legitimately mention out-of-range ids while explaining
	// their removal — that must not trip the dangling-id check (nor may the
	// retry feedback's re-quoting of those tokens trap the writer into
	// re-emitting them). See stripNonNormativeSections for the incident.
	const bddNormative = stripNonNormativeSections(bddContent);
	const specNormative = stripNonNormativeSections(specContent);
	const bddScenarioIds = extractScenarioIds(bddNormative);
	const specDocScenarioIds = extractScenarioIds(specNormative);
	const specControlScenarioIds = extractScenarioRefsFromControl(spec);
	const combinedSpecIds = uniqueSortedIds([...specDocScenarioIds, ...specControlScenarioIds]);
	const mappedScenarioIds = extractMappedScenarioRefsFromControl(spec);
	const errors: string[] = [];
	if (bddScenarioIds.length === 0) errors.push("BDD doc has no SCENARIO-NNN identifiers for spec traceability");
	if (specControlScenarioIds.length === 0) errors.push("spec.scenarioRefs must include SCENARIO-NNN IDs from the BDD doc");
	const uncovered = missingIds(bddScenarioIds, combinedSpecIds);
	if (uncovered.length > 0) errors.push(`spec does not reference BDD scenarios: ${uncovered.join(", ")}`);
	const dangling = missingIds(combinedSpecIds, bddScenarioIds);
	if (dangling.length > 0) errors.push(`spec references scenarios not found in BDD doc: ${dangling.join(", ")}`);
	if (mappedScenarioIds.length === 0) errors.push("spec phases/tasks must include scenarioRefs so every BDD scenario maps to implementable work");
	const unmapped = missingIds(bddScenarioIds, mappedScenarioIds);
	if (unmapped.length > 0) errors.push(`spec phases/tasks do not map BDD scenarios to work: ${unmapped.join(", ")}`);
	const mappedDangling = missingIds(mappedScenarioIds, bddScenarioIds);
	if (mappedDangling.length > 0) errors.push(`spec phases/tasks reference scenarios not found in BDD doc: ${mappedDangling.join(", ")}`);

	if (requirementsContent) {
		const requirementIds = extractAcceptanceCriteriaIds(stripNonNormativeSections(requirementsContent));
		const specDocAcIds = extractAcceptanceCriteriaIds(specNormative);
		const specControlAcIds = extractAcceptanceCriteriaRefsFromControl(spec);
		const combinedSpecAcIds = uniqueSortedIds([...specDocAcIds, ...specControlAcIds]);
		if (requirementIds.length === 0) errors.push("requirements doc has no AC-NN identifiers for spec traceability");
		if (specControlAcIds.length === 0) errors.push("spec.acceptanceCriteriaRefs must include AC-NN IDs from the requirements doc");
		const uncoveredAc = missingIds(requirementIds, combinedSpecAcIds);
		if (uncoveredAc.length > 0) errors.push(`spec does not reference acceptance criteria: ${uncoveredAc.join(", ")}`);
		const danglingAc = missingIds(combinedSpecAcIds, requirementIds);
		if (danglingAc.length > 0) errors.push(`spec references acceptance criteria not found in requirements: ${danglingAc.join(", ")}`);
	}

	const phases = normalizePhases(spec?.phases);
	const phaseNames = new Set(phases.map((p) => p.name.trim()));
	const tasks = Array.isArray(spec?.tasks) ? spec.tasks as Array<Record<string, unknown>> : [];
	if (tasks.length === 0) errors.push("spec.tasks must be a non-empty array mapped to declared phase names");
	tasks.forEach((task, index) => {
		const phase = typeof task?.phase === "string" ? task.phase.trim() : "";
		if (!phase) errors.push(`spec.tasks[${index}].phase is missing`);
		else if (!phaseNames.has(phase)) errors.push(`spec.tasks[${index}].phase references unknown phase "${phase}"`);
	});
	errors.push(...phaseIndependenceErrors(phases, tasks));
	errors.push(...phaseTestDeliverableErrors(phases, tasks)); // M1/AC-11: scenario-mapped phases must declare a test deliverable
	return errors;
}

/**
 * Phase-independence heuristic (learned from run 2026-08-10T10-54-20-663Z, where
 * a single Phase 2 bundling ~10 scenarios across ~6 files cascade-failed and
 * abandoned Phase 3). The spec prompt ASKS for coarse-but-independent phases;
 * this makes the ask enforceable. A phase is flagged as over-large ONLY when it
 * is egregious on BOTH axes at once — many mapped scenarios AND many distinct
 * required files — because that combination is what makes a phase an
 * all-or-nothing monolith whose failure blocks every later phase. Single-axis
 * breadth (many small scenarios in one file, or many files for one behavior) is
 * left alone to avoid over-fragmenting genuinely cohesive work. Thresholds are
 * deliberately generous so only true monoliths hard-fail.
 */
export function phaseIndependenceErrors(
	phases: NormalizedPhase[],
	tasks: Array<Record<string, unknown>>,
): string[] {
	const SCENARIO_LIMIT = 8; // per phase
	const FILE_LIMIT = 5;     // distinct requireFiles/requireContains targets per phase
	const errors: string[] = [];
	for (const phase of phases) {
		const phaseScenarioRefs = extractScenarioIdsFromValue(phase.scenarioRefs);
		const taskScenarioRefs = tasks
			.filter((t) => typeof t?.phase === "string" && t.phase.trim() === phase.name.trim())
			.flatMap((t) => extractScenarioIdsFromValue(t.scenarioRefs));
		const scenarioCount = new Set([...phaseScenarioRefs, ...taskScenarioRefs]).size;
		const d = phase.deliverables;
		const files = new Set<string>([
			...((d?.requireFiles ?? []) as string[]),
			...((d?.requireContains ?? []) as Array<{ file?: string }>).map((e) => e?.file ?? "").filter(Boolean),
		]).size;
		if (scenarioCount > SCENARIO_LIMIT && files > FILE_LIMIT) {
			errors.push(
				`phase "${phase.name}" is a cascade-fail monolith: ${scenarioCount} scenarios across ${files} files (>${SCENARIO_LIMIT} scenarios AND >${FILE_LIMIT} files) — split it into smaller independently-shippable phases so one failure does not abandon later phases`,
			);
		}
	}
	return errors;
}

/**
 * Test-coverage-deliverable guard (Fix 6 — closes the invariant that a phase's
 * gradeable criteria must be declared). A phase that maps ≥1 BDD scenario is, by
 * definition, delivering testable behavior — yet without a `requireScenarios` or
 * `requireTests` deliverable the deterministic gate has NOTHING to assert about
 * that phase's tests, so it can compile green while delivering zero test
 * coverage (the "silent-empty-success" hole, one level up from the symbol gate).
 * Flag any scenario-mapped phase whose deliverables declare neither. Phases that
 * map no scenarios (pure wiring/config) are exempt — they have nothing to cover.
 * requireScenarios is the RECOMMENDED remedy (stable tag); requireTests also
 * satisfies the guard for the rare case where no scenario tag applies.
 */
export function phaseTestDeliverableErrors(
	phases: NormalizedPhase[],
	tasks: Array<Record<string, unknown>>,
): string[] {
	const errors: string[] = [];
	for (const phase of phases) {
		const phaseScenarioRefs = extractScenarioIdsFromValue(phase.scenarioRefs);
		const taskScenarioRefs = tasks
			.filter((t) => typeof t?.phase === "string" && t.phase.trim() === phase.name.trim())
			.flatMap((t) => extractScenarioIdsFromValue(t.scenarioRefs));
		const scenarioCount = new Set([...phaseScenarioRefs, ...taskScenarioRefs]).size;
		if (scenarioCount === 0) continue; // no mapped behavior → nothing to cover
		const d = phase.deliverables as { requireScenarios?: unknown[]; requireTests?: unknown[] } | undefined;
		const hasScenarioDeliverable = Array.isArray(d?.requireScenarios) && d.requireScenarios.length > 0;
		const hasTestDeliverable = Array.isArray(d?.requireTests) && d.requireTests.length > 0;
		if (!hasScenarioDeliverable && !hasTestDeliverable) {
			errors.push(
				`phase "${phase.name}" maps ${scenarioCount} BDD scenario(s) but declares no test deliverable — add deliverables.requireScenarios (preferred: the SCENARIO-NNN tags it covers) or deliverables.requireTests so the phase cannot go green without proving test coverage`,
			);
		}
	}
	return errors;
}

function safeReadDir(path: string): string[] {
	try { return readdirSync(path); } catch { return []; }
}

function mentionedNextCatchAllRoutes(specContent: string): string[] {
	const matches = [...specContent.matchAll(/\b((?:[\w.-]+\/)*src\/app\/api\/[\w./-]+\/\[[^\]]*\.\.\.[^\]]+\]\/route\.(?:ts|tsx|js|jsx))\b/g)];
	return [...new Set(matches.map((m) => m[1]).filter(Boolean))];
}

/**
 * Deterministic grounding checks for specs that name existing framework route
 * files. Conservative by design: only catches a known wrong-path pattern where
 * a Next.js catch-all route is chosen even though an existing specific route
 * under the same parent would take precedence for the endpoint named in spec.
 */
export function specGroundingErrors(worktreePath: string, specContent: string): string[] {
	const errors: string[] = [];
	if (!worktreePath) return errors;
	for (const catchAllRoute of mentionedNextCatchAllRoutes(specContent)) {
		const parent = dirname(catchAllRoute);
		const routeRoot = dirname(parent);
		const routeRootAbs = join(worktreePath, routeRoot);
		for (const child of safeReadDir(routeRootAbs)) {
			if (child.startsWith("[")) continue;
			const specificRoute = join(routeRoot, child, "route.ts");
			const specificRouteTsx = join(routeRoot, child, "route.tsx");
			const specificRouteJs = join(routeRoot, child, "route.js");
			const specificRouteJsx = join(routeRoot, child, "route.jsx");
			const candidates = [specificRoute, specificRouteTsx, specificRouteJs, specificRouteJsx];
			const existing = candidates.find((candidate) => existsSync(join(worktreePath, candidate)));
			if (!existing) continue;
			const childMentioned = new RegExp(`\\b${child.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(specContent);
			const explicitSpecific = candidates.some((candidate) => specContent.includes(candidate));
			if (childMentioned && !explicitSpecific) {
				errors.push(`spec routes ${child} work to catch-all ${catchAllRoute}, but existing specific route ${existing} will take precedence; update the spec/tasks/deliverables to name the specific route or explain why it is intentionally unchanged`);
			}
		}
	}
	return errors;
}

/**
 * Locate & read a stage's doc. Prefer an explicitly-declared path in the control
 * object (docPath / specificationPath / …); fall back to a glob of the spec
 * directory so the gate still works when the agent omits or misreports the path.
 * AC-16 (SCENARIO-035/036): control-supplied paths resolve against the SPEC
 * ROOT — never the process CWD — and anything outside it is ignored (exactly
 * one `[doc-validators] readSpecDoc: ignoring` warn per ignored key), falling
 * through to the glob. Returns null if no doc can be found.
 */
export function readSpecDoc(specDir: string, control: ControlObj | undefined, glob: string, pathKeys: string[] = ["docPath"]): DocRef | null {
	const specRoot = specDir ? resolve(specDir) : null;
	for (const k of pathKeys) {
		const p = control?.[k];
		if (typeof p !== "string" || !p.trim() || !specRoot) continue;
		const resolved = resolve(specRoot, p);
		if (resolved === specRoot || resolved.startsWith(specRoot + sep)) {
			if (existsSync(resolved)) return { path: resolved, content: readFileSync(resolved, "utf8") };
			continue; // contained but absent — fall through to the glob
		}
		// M6: control-supplied paths resolve against the spec dir, never the
		// process CWD; anything outside it is ignored (exactly one log line).
		console.warn(`[doc-validators] readSpecDoc: ignoring ${k} "${p}" — resolves outside the spec directory (${resolved}); falling back to the spec-dir glob`);
	}
	if (specDir) {
		try {
			const re = globToRegExp(glob);
			for (const entry of readdirSync(specDir)) {
				if (re.test(entry)) {
				const p = join(specDir, entry);
				if (existsSync(p)) return { path: p, content: readFileSync(p, "utf8") };
			}
		}
		} catch { /* spec dir unreadable — fall through */ }
	}
	return null;
}

/** True if a sibling doc exists in the spec dir (for file-existence checks). */
export function specDocExists(specDir: string, glob: string): boolean {
	if (!specDir) return false;
	try {
		const re = globToRegExp(glob);
		return readdirSync(specDir).some((e) => re.test(e));
	} catch {
		return false;
	}
}

// ─── coercion: models return "13" / "true" where a gate wants 13 / true ───────

export function toNumber(v: unknown): number | null {
	if (typeof v === "number") return Number.isFinite(v) ? v : null;
	if (typeof v === "string") {
		const n = Number(v.trim());
		return Number.isFinite(n) ? n : null;
	}
	return null;
}

export function toBool(v: unknown): boolean {
	if (typeof v === "boolean") return v;
	if (typeof v === "string") return /^(true|yes|y|1|pass)$/i.test(v.trim());
	return false;
}

/** A normalized spec phase. `deliverables` is OPTIONAL and round-trips from the
 *  agent's declared `phases[].deliverables` so downstream consumers (the
 *  implementation stage) read a typed `phase.deliverables`. */
export type NormalizedPhase = { name: string; description?: string; scenarioRefs?: string[]; deliverables?: PhaseDeliverables };

/** Normalize a spec's `phases` field into a usable {name, description?, deliverables?}
 *  array. Agents occasionally return phases as a string (newline/comma list) or an
 *  object instead of an array; the implementation stage iterates it, so a
 *  non-array must never reach `for...of phases.entries()` (which threw:
 *  "phases.entries is not a function"). Array → keep valid entries (preserving a
 *  declared `deliverables` object by reference); string → best-effort split into
 *  names; anything else → []. */
export function normalizePhases(raw: unknown): NormalizedPhase[] {
	if (Array.isArray(raw)) {
		return raw.filter((p): p is NormalizedPhase =>
			!!p && typeof p === "object" && typeof (p as { name?: unknown }).name === "string" && (p as { name: string }).name.trim() !== "",
		);
	}
	// F6 (RC6, run 2026-08-17T06-39-58-800Z — 5 consecutive rounds of "spec.phases
	// must be a non-empty array"): tolerate the common LLM malformations BEFORE
	// failing the trace gate, so one structural slip costs one round, not five.
	if (raw && typeof raw === "object") {
		const obj = raw as Record<string, unknown>;
		// (a) wrapper: the model returned { phases: [...] } instead of the array.
		if (Array.isArray(obj.phases)) return normalizePhases(obj.phases);
		// (b) single phase object instead of a 1-element array.
		// AC-19 (SCENARIO-041): SPREAD the original object so every field
		// (scenarioRefs, deliverables, …) survives the coercion — the
		// implementation stage and the trace gates read those fields.
		if (typeof obj.name === "string" && obj.name.trim()) return [{ ...obj, name: obj.name.trim(), description: typeof obj.description === "string" ? obj.description : "" } as NormalizedPhase];
		// (c) numeric-key map (JSON round-trips that dropped the array).
		const keys = Object.keys(obj).filter((k) => /^\d+$/.test(k)).sort((a, b) => Number(a) - Number(b));
		if (keys.length > 0) {
			const mapped = keys.map((k) => obj[k]).filter((p): p is NormalizedPhase =>
				!!p && typeof p === "object" && typeof (p as { name?: unknown }).name === "string" && (p as { name: string }).name.trim() !== "",
			);
			if (mapped.length > 0) return mapped;
		}
	}
	if (typeof raw === "string" && raw.trim()) {
		return raw
			// AC-19 (SCENARIO-042): the comma left the split set — a phase name
			// may legitimately contain one ("Phase A, Phase B" is ONE phase);
			// only newlines / semicolons / bullets separate phases.
			.split(/\r?\n|;|•/)
			.map((x) => x.trim().replace(/^[-*\d.)\s]+/, "").trim())
			.filter((x) => x.length > 0)
			.map((name) => ({ name }));
	}
	return [];
}

/** Tolerant approved-verdict test. Accepts the approve FAMILY — Approved /
 *  Approved with Comments / Approved with minor changes / "APPROVED WITH
 *  REVISIONS" (suggestion-only pass, per the reviewer contract) / PASS /
 *  Accepted (any case); rejects explicit rejections — Changes Requested /
 *  "REVISIONS NEEDED" / Rejected / CONTEST / Blocked / FAIL / Declined.
 *  Aligned with artifact-convergence's `reviewVerdictApproves` (one contract:
 *  an affirmative approval is a pass unless it is an explicit rejection;
 *  blocking findings are AND-ed at the call sites, never the wording).
 *  Run 2026-08-17T00-52-39-124Z: "APPROVED WITH REVISIONS" + zero blocking
 *  findings was rejected here and the run FATALed at the round cap. */
export function isApprovedVerdict(verdict: unknown): boolean {
	const v = String(verdict ?? "").trim().toLowerCase();
	if (!v) return false;
	// M17 (SCENARIO-057): negated approvals ("not approved", "does not pass",
	// "approved: no", …) never approve — the shared guard fires BEFORE the
	// approve-family match (mirrors reviewVerdictApproves in
	// artifact-convergence.ts; review-findings imports nothing, so no cycle).
	if (NEGATED_APPROVAL_RE.test(v)) return false;
	// Explicit rejections always lose, even when phrased around "revisions".
	if (/(changes?\s+requested|revisions?\s+needed|reject|contest|blocked|fail|declined)/i.test(v)) return false;
	// Approve family: "approved …" of any qualifier (comments/revisions/minor …).
	if (/\bapproved\b/i.test(v)) return true;
	return /\b(pass|accept)/i.test(v);
}

// ─── per-stage content checks (ported from definitions.mjs) ──────────────────
// Each returns a list of human-readable errors; empty = doc content is valid.

/** requirements.md: acceptance criteria, AC items, NFRs, summary, substance. */
export function requirementsContentErrors(c: string): string[] {
	const e: string[] = [];
	if (countMatches(c, /acceptance\s+criteria/i) < 1) e.push("missing an 'Acceptance Criteria' section");
	if (countMatches(c, /AC-\d+/g) < 2) e.push("needs ≥2 acceptance-criteria items (AC-NN)");
	if (countMatches(c, /non-functional|performance|security|accessibility/i) < 1) e.push("missing non-functional requirements");
	if (countMatches(c, /executive\s+summary|##\s+summary|\bsummary\b/i) < 1) e.push("missing a summary section");
	if (c.length < 500) e.push("doc is too short (<500 bytes) — likely a stub");
	return e;
}

/** bdd-scenarios.md: SCENARIO-NN ids, Given/When/Then, AC traceability, substance. */
export function bddContentErrors(c: string): string[] {
	const e: string[] = [];
	if (countMatches(c, /SCENARIO-\d+/g) < 1) e.push("missing SCENARIO-NN identifiers");
	// Given/When/Then keyword lines (tolerant of bullets/bold), ≥3 distinct blocks
	if (countMatches(c, /^\s*(?:[-*]\s+)?\*{0,2}(?:given|when|then|and)\b/im) < 3) e.push("missing Given/When/Then structure (≥3 blocks)");
	if (countMatches(c, /AC-\d+/g) < 1) e.push("missing AC references for traceability");
	if (c.length < 300) e.push("doc is too short (<300 bytes) — likely a stub");
	return e;
}

/** specification.md: BDD scenario refs, testing strategy, substance. */
export function specContentErrors(c: string): string[] {
	const e: string[] = [];
	if (countMatches(c, /SCENARIO-\d+/g) < 1) e.push("specification must reference BDD scenarios (SCENARIO-NN)");
	if (countMatches(c, /testing\s+strategy|test\s+plan|test\s+approach|test\s+coverage|unit\s+test|integration\s+test|e2e\s+test/i) < 1) e.push("missing a testing strategy");
	if (c.length < 500) e.push("specification is too short (<500 bytes) — likely a stub");
	return e;
}

/** spec-review.md: all 8 review dimensions present. */
export function specReviewContentErrors(c: string): string[] {
	const e: string[] = [];
	const dims = ["Completeness", "Consistency", "Feasibility", "Testability", "Traceability", "Grounding", "Complexity", "Ambiguity"];
	const found = dims.filter((d) => new RegExp(d, "i").test(c));
	if (found.length < 8) e.push(`missing review dimensions (${found.length}/8: ${found.join(", ") || "none"})`);
	return e;
}

// ─── v0.3.2 Contract-Claims Layer (WS-1 rung-2 sensors) ────────────────────────

/** A design-stage contract claim: the writer declares a paired
 *  generate/validate contract (pattern, allowlist, filename convention, key
 *  set) together with the enumerated closure it claims to admit and the source
 *  anchor the enumeration derives from. The checker below verifies INTERNAL
 *  consistency (pattern-vs-enumeration, anchor existence, uniqueness); the
 *  reviewer verifies the enumeration matches reality. */
export interface DesignContractClaim {
	name: string;
	pattern: string;
	enumerates: string[];
	/** Entries the normalizer dropped (non-string/blank) — a non-empty raw
	 *  array yielding zero valid strings is a VACUOUS claim (sd32 F2). */
	rawEnumeratesCount: number;
	sourceAnchor?: string;
	derivationRule?: string;
	uniqueness?: boolean;
}

/** Repo-relative anchor containment: no absolute paths, no `..` escape. */
function containedRelativePath(value: string): boolean {
	if (!value || value.startsWith("/") || value.startsWith("\\") || /^[a-z]:/i.test(value)) return false;
	const parts = value.split(/[\\/]/).filter(Boolean);
	let depth = 0;
	for (const part of parts) {
		if (part === ".") continue;
		if (part === "..") { depth -= 1; if (depth < 0) return false; continue; }
		depth += 1;
	}
	return depth > 0;
}

function normalizeClaim(raw: unknown): DesignContractClaim | null {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
	const c = raw as Record<string, unknown>;
	const name = typeof c.name === "string" && c.name.trim() ? c.name.trim() : null;
	const pattern = typeof c.pattern === "string" ? c.pattern : "";
	const enumerates = Array.isArray(c.enumerates) ? c.enumerates.filter((v): v is string => typeof v === "string" && v.trim().length > 0) : [];
	if (!name || !pattern) return null;
	return {
		name,
		pattern,
		enumerates,
		rawEnumeratesCount: Array.isArray(c.enumerates) ? c.enumerates.length : 0,
		sourceAnchor: typeof c.sourceAnchor === "string" && c.sourceAnchor.trim() ? c.sourceAnchor.trim() : undefined,
		derivationRule: typeof c.derivationRule === "string" ? c.derivationRule : undefined,
		uniqueness: c.uniqueness === true || c.uniqueness === "true",
	};
}

/** C1: deterministic consistency check over a design control's contract
 *  claims. Runs EVERY round of design convergence — the run-06-19 class
 *  (over-restrictive artifact-name validation) is machine-checkable from round
 *  1, and ALL violations are reported at once (a table, not a drip).
 *  No claims / malformed entries are ignored (backward-compatible). */
export function designContractsErrors(control: ControlObj | undefined, worktreePath: string): string[] {
	const errors: string[] = [];
	const raw = (control as { contracts?: unknown } | undefined)?.contracts;
	if (!Array.isArray(raw) || raw.length === 0) return errors;
	for (const entry of raw) {
		const claim = normalizeClaim(entry);
		if (!claim) {
			errors.push('contract claim malformed: every contract needs a non-empty "name" and a "pattern" string — fix or drop the entry');
			continue;
		}
		// (1) the pattern must compile — an invalid regex is a validator that
		// cannot even run (and would crash the real validator at runtime).
		// sd32 adv-F3: a JS-literal-style pattern ("/^x$/i") COMPILES but matches
		// nothing — name the dialect problem instead of blaming the derivation.
		if (/^\/.+\/[a-z]*$/i.test(claim.pattern)) {
			errors.push(`contract "${claim.name}": pattern "${claim.pattern.slice(0, 60)}" looks like a JS regex literal with delimiters/flags — supply the bare source (e.g. "^x$"); flags are not supported`);
			continue;
		}
		let re: RegExp | null = null;
		try {
			re = new RegExp(claim.pattern);
		} catch (error) {
			errors.push(`contract "${claim.name}": pattern does not compile — ${error instanceof Error ? error.message : String(error)}`);
			continue;
		}
		// sd32 F2 (both reviewers): a declared contract with a vacuous enumeration
		// passes closure AND uniqueness silently — the flagship sensor would be
		// defeated by an empty table. The enumeration IS the machine-checked
		// artifact; if the contract genuinely admits nothing, drop the claim.
		if (claim.enumerates.length === 0) {
			const dropped = claim.rawEnumeratesCount > 0 ? ` (the ${claim.rawEnumeratesCount} declared entr${claim.rawEnumeratesCount === 1 ? "y is" : "ies are"} all non-string/blank)` : "";
			errors.push(`contract "${claim.name}": declares a contract but enumerates no values${dropped} — derive the closure from the sourceAnchor, or drop the contract claim`);
			continue;
		}
		// (2) closure consistency: EVERY enumerated value matches its own
		// pattern. All violations at once — this is the run-06-19 kill.
		const violating = claim.enumerates.filter((value) => !re!.test(value));
		if (violating.length > 0) {
			const shown = violating.slice(0, 6).map((v) => `"${v}"`).join(", ");
			errors.push(`contract "${claim.name}": ${violating.length}/${claim.enumerates.length} enumerated value(s) violate the contract's own pattern (${shown}${violating.length > 6 ? `, …(+${violating.length - 6} more)` : ""}) — the derivation rule is wrong: fix the rule or the pattern, then regenerate the enumeration; do not patch individual values`);
		}
		// (3) source anchor cites reality: repo-relative, exists, and (with a
		// `#export` suffix) the file actually contains the named export.
		if (claim.sourceAnchor) {
			const [relPath, exportName] = claim.sourceAnchor.split("#", 2);
			if (!containedRelativePath(relPath)) {
				errors.push(`contract "${claim.name}": sourceAnchor "${claim.sourceAnchor}" must be a repo-relative path (optional "#export" suffix), not absolute or escaping`);
			} else if (worktreePath && !existsSync(join(worktreePath, relPath))) {
				errors.push(`contract "${claim.name}": sourceAnchor path "${relPath}" does not exist in the worktree — derive the enumeration from the real source`);
			} else if (exportName && worktreePath) {
				try {
					const text = readFileSync(join(worktreePath, relPath), "utf8");
					if (!new RegExp(`(?<![\\w$])${exportName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w$])`).test(text)) {
						errors.push(`contract "${claim.name}": sourceAnchor export "${exportName}" not found in ${relPath} — cite the symbol the enumeration actually derives from`);
					}
				} catch { /* unreadable file falls through to the reviewer */ }
			}
		}
		// (4) uniqueness claims hold over the enumeration.
		if (claim.uniqueness) {
			const dupes = claim.enumerates.filter((v, i, all) => all.indexOf(v) !== i);
			if (dupes.length > 0) errors.push(`contract "${claim.name}": claims uniqueness but the enumeration has duplicate value(s): ${[...new Set(dupes)].slice(0, 5).map((v) => `"${v}"`).join(", ")}`);
		}
	}
	return errors;
}

/** C2: spec deliverables pre-flight — a malformed deliverable is a perma-fail
 *  contract that today only surfaces at phase-GREEN (the implementer burns an
 *  attempt discovering a regex that never compiles or a scenario id that does
 *  not exist). Fail it at spec time, where the spec writer can fix it. */
export function deliverablesPreflightErrors(phases: NormalizedPhase[], bddContent: string | undefined): string[] {
	const errors: string[] = [];
	const knownScenarios = bddContent ? new Set(extractScenarioIds(bddContent)) : null;
	for (const phase of phases) {
		const d = phase.deliverables;
		if (!d) continue;
		const label = `phase "${phase.name}"`;
		// code-C2-REGEX-DIALECT: the phase-GREEN consumer (gates.ts tolerantMatch)
		// translates a leading "(?i)" to JS flags — the preflight must ACCEPT what
		// the consumer accepts, or it fails specs the green gate would pass.
		const compiles = (p: string): string | null => {
			const source = p.startsWith("(?i)") ? p.slice(4) : p;
			const flags = p.startsWith("(?i)") ? "i" : "";
			try { new RegExp(source, flags); return null; } catch (error) {
				return error instanceof Error ? error.message : String(error);
			}
		};
		for (const entry of (d.requireContains ?? []) as Array<{ file?: unknown; pattern?: unknown }>) {
			if (!entry || typeof entry !== "object") { errors.push(`${label}: requireContains entry malformed (needs {file, pattern})`); continue; }
			if (typeof entry.pattern === "string") {
				const why = compiles(entry.pattern);
				if (why) errors.push(`${label}: requireContains pattern does not compile — ${why} (${entry.pattern.slice(0, 80)})`);
			} else {
				errors.push(`${label}: requireContains entry missing its pattern string`);
			}
			if (typeof entry.file === "string" && !containedRelativePath(entry.file)) {
				errors.push(`${label}: requireContains file "${entry.file}" must be a repo-relative path`);
			}
		}
		for (const pattern of (d.requireNotContains ?? []) as Array<{ file?: unknown; pattern?: unknown }>) {
			const p = pattern && typeof pattern === "object" ? pattern.pattern : pattern;
			if (typeof p !== "string") { errors.push(`${label}: requireNotContains entry must be a pattern string`); continue; }
			// code-C2-NOTCONTAINS-NO-FILE: an entry with no file asserts NOTHING at
			// phase-GREEN — surface it at spec time instead of silently passing.
			if (pattern && typeof pattern === "object" && (typeof (pattern as { file?: unknown }).file !== "string" || !(pattern as { file?: string }).file?.trim())) {
				errors.push(`${label}: requireNotContains entry has no file — it would silently assert nothing at phase-GREEN`);
			}
			const why = compiles(p);
			if (why) errors.push(`${label}: requireNotContains pattern does not compile — ${why} (${p.slice(0, 80)})`);
		}
		for (const file of (d.requireFiles ?? []) as unknown[]) {
			if (typeof file !== "string" || !containedRelativePath(file)) errors.push(`${label}: requireFiles entry "${String(file).slice(0, 80)}" must be a non-empty repo-relative path`);
		}
		for (const scenario of (d.requireScenarios ?? []) as unknown[]) {
			const id = typeof scenario === "string" ? scenario.trim() : "";
			const m = id.match(/^SCENARIO-(\d{2,})$/i);
			if (!m) { errors.push(`${label}: requireScenarios entry "${String(scenario).slice(0, 40)}" is not a SCENARIO-NNN id`); continue; }
			// code-C2-SCENARIO: normalize the pin with the SAME padding rule as
			// extractScenarioIds so a 4-digit pin compares equal to its 3-digit id.
			const normalized = `SCENARIO-${String(Number(m[1])).padStart(3, "0")}`;
			if (knownScenarios && !knownScenarios.has(normalized)) errors.push(`${label}: requireScenarios pins ${normalized}, which does not exist in the BDD doc — the phase can never go green`);
		}
		for (const test of (d.requireTests ?? []) as unknown[]) {
			if (typeof test !== "string" || !test.trim()) errors.push(`${label}: requireTests entry must be a non-empty test-name string`);
		}
	}
	// sd32 adv-F4: announced truncation (cumora discipline — silent drops are
	// unrecoverable for the writer).
	if (errors.length > 12) {
		return [...errors.slice(0, 12), `…(+${errors.length - 12} more deliverable error(s) omitted — fix the listed ones and re-run)`];
	}
	return errors;
}

/** C3: BDD boundary lint — every numeric bound an AC statement PINS must be
 *  named by some BDD scenario (digit-normalized). A boundary no scenario names
 *  cannot be exercised; the rethink's BDD-F01 finding is this class. Tight
 *  guards against false positives: explicit bound-phrases only, AC-statement
 *  lines only, `1,000`≡`1000` normalization on both sides, ≤4 reported. */
// sd32 adv-F1/code-C3 fixes: capture the FULL grouped number ("10,000", "1 000",
// "10_000"), tolerate an immediate unit suffix ("60s", "5ms", "10%"), normalize
// digits on BOTH sides, and compare with digit boundaries — raw substring
// containment let "10" be satisfied by "SCENARIO-100". Accepted miss: unit-word
// spellings ("10k", "ten thousand") do not match a numeric bound — the reviewer
// layer catches prose.
const BOUND_PHRASE_RE = /\b(?:at most|no more than|up to|at least|no fewer than|no less than|exactly|precisely|top|first|last|within|max(?:imum)?(?:\s+of)?|min(?:imum)?(?:\s+of)?|limit(?:ed)?\s+to|capped\s+at)\s+(\d{1,3}(?:[,\s_]\d{3})+|\d{1,10})(?=(?:ms|s|min|h|kb|mb|gb|%|x)?(?:[\s.,;:)]|$))/gi;

function normalizeDigits(text: string): string {
	return text.replace(/(\d)[,\s_](?=\d{3}\b)/g, "$1");
}

/** Digit-boundary containment: "10" must NOT be satisfied by "SCENARIO-100". */
function namesBound(bddNormalized: string, value: string): boolean {
	return new RegExp(`(?<!\d)${value}(?!\d)`).test(bddNormalized);
}

export function bddBoundaryLintErrors(requirementsContent: string, bddContent: string): string[] {
	const errors: string[] = [];
	const bddNormalized = normalizeDigits(bddContent);
	const acLines = requirementsContent.split("\n").filter((line) => /-\s*\*{0,2}AC-\d{2,}\*{0,2}\s*[:.]/i.test(line));
	for (const line of acLines) {
		const acId = (line.match(/AC-\d{2,}/i) ?? ["AC-??"])[0];
		for (const match of line.matchAll(BOUND_PHRASE_RE)) {
			const phrase = match[0].trim();
			const value = normalizeDigits(match[1]);
			if (!namesBound(bddNormalized, value)) {
				errors.push(`${acId} pins the numeric bound "${phrase}" but no BDD scenario names the boundary value ${value} — a bound no scenario exercises cannot be verified; add a scenario at the boundary (or remove the pin)`);
				if (errors.length >= 4) return errors;
			}
		}
	}
	return errors;
}
