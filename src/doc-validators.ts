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
import { dirname, join } from "node:path";
import type { ControlObj } from "./types.ts";
import type { PhaseDeliverables } from "./render/schemas.ts";

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

/** BDD must cover every requirements AC and must not cite nonexistent ACs. */
export function bddTraceabilityErrors(requirementsContent: string, bddContent: string): string[] {
	const requirementIds = extractAcceptanceCriteriaIds(requirementsContent);
	const bddIds = extractAcceptanceCriteriaIds(bddContent);
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
	const bddScenarioIds = extractScenarioIds(bddContent);
	const specDocScenarioIds = extractScenarioIds(specContent);
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
		const requirementIds = extractAcceptanceCriteriaIds(requirementsContent);
		const specDocAcIds = extractAcceptanceCriteriaIds(specContent);
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
 * Returns null if no doc can be found.
 */
export function readSpecDoc(specDir: string, control: ControlObj | undefined, glob: string, pathKeys: string[] = ["docPath"]): DocRef | null {
	for (const k of pathKeys) {
		const p = control?.[k];
		if (typeof p === "string" && p && existsSync(p)) {
			return { path: p, content: readFileSync(p, "utf8") };
		}
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
	if (typeof raw === "string" && raw.trim()) {
		return raw
			.split(/\r?\n|,|;|•/)
			.map((x) => x.trim().replace(/^[-*\d.)\s]+/, "").trim())
			.filter((x) => x.length > 0)
			.map((name) => ({ name }));
	}
	return [];
}

/** Tolerant approved-verdict test. Accepts Approved / Approved with Comments /
 *  Approved with minor changes / PASS / Accepted (any case); rejects Changes
 *  Requested / Rejected / CONTEST / Blocked / FAIL. */
export function isApprovedVerdict(verdict: unknown): boolean {
	const v = String(verdict ?? "").trim().toLowerCase();
	if (/(changes?\s+requested|reject|contest|blocked|fail|revision|declined)/i.test(v)) return false;
	return /\b(approved|pass|accept)/i.test(v);
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
