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
 * scripts/gates/definitions.mjs. Gates prefer this; the old metadata checks
 * survive only as a fallback when no doc can be found on disk.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
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
export type NormalizedPhase = { name: string; description?: string; deliverables?: PhaseDeliverables };

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
