/**
 * WS4 (066 §2) — the rejection memory: restart-with-lessons, JSON-structured,
 * decayed. Research grounding (grill-3 Q3): restart-with-lessons beats
 * in-context accumulation (Anthropic long-running-agent harness: fresh
 * sessions reading a STRUCTURED progress file; the /clear lesson verbatim),
 * and the lessons artifact must be JSON-shaped — "models inappropriately
 * overwrite Markdown progress notes but respect JSON ones". Context rot is
 * measured (Chroma 2025), so lessons DECAY to one-liners instead of
 * accumulating verbatim.
 *
 * Source of truth: the convergence ledger's historical findings (already
 * persisted per spec dir). This module derives compact per-writer LESSON
 * ROWS from them — cross-stage (a BDD writer sees requirements-stage
 * lessons), deduped by defectClass/title stem, capped, severity-ranked.
 * Pure: findings in, JSON rows + a rendered compact block out; never throws.
 */

export interface LessonRow {
	/** The defect class (stable tag) or title stem. */
	class: string;
	/** One-line rule: the finding's recommendation, compressed. */
	rule: string;
	/** Where it bit: the finding's evidence/loci head (may be empty). */
	locus: string;
	/** Origin stage (provenance — where the lesson was learned). */
	origin: string;
	severity: string;
}

export interface ConvergenceFindingLike {
	id?: unknown;
	title?: unknown;
	detail?: unknown;
	severity?: unknown;
	evidence?: unknown;
	recommendation?: unknown;
	defectClass?: unknown;
	ownerStage?: unknown;
	status?: unknown;
	blocking?: unknown;
	detectedAtStage?: unknown;
}

const MAX_LESSONS = 8;
const RULE_MAX = 160;
const LOCUS_MAX = 120;

function str(v: unknown, max: number): string {
	const s = typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "";
	return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

/** Compress one finding into a lesson row (never throws). */
export function lessonRowFrom(f: ConvergenceFindingLike): LessonRow {
	const titleStem = str(f.title, 60);
	return {
		class: str(f.defectClass, 40) || titleStem || "unnamed",
		rule: str(f.recommendation, RULE_MAX) || str(f.detail, RULE_MAX) || titleStem,
		locus: Array.isArray(f.evidence) && f.evidence.length > 0 ? str(f.evidence[0], LOCUS_MAX) : "",
		origin: str(f.detectedAtStage ?? f.ownerStage, 24) || "unknown",
		severity: str(f.severity, 12) || "P2",
	};
}

const SEVERITY_RANK: Record<string, number> = { P0: 0, critical: 0, high: 1, P1: 1, P2: 2, medium: 2, P3: 3, low: 3 };

/** Derive deduped, severity-ranked, capped lesson rows from ledger findings.
 * Superseded rows are excluded (dead against the revised upstream); dedupe
 * keys on class+title-stem so a generalized defect teaches ONE lesson. */
export function lessonsForWriter(findings: readonly ConvergenceFindingLike[]): LessonRow[] {
	const seen = new Set<string>();
	const rows: LessonRow[] = [];
	for (const f of findings) {
		if (!f || typeof f !== "object") continue;
		// 067 R6-Q3: RESOLVED findings teach nothing — a lesson from an already-
		// verified/addressed finding is stale context (context rot is measured);
		// only OPEN residue may ride the lessons block. Superseded rows are dead
		// against the revised upstream (the original rule).
		if (f.status === "superseded" || f.status === "verified" || f.status === "addressed") continue;
		const row = lessonRowFrom(f);
		const key = `${row.class}::${row.rule.slice(0, 40)}`;
		if (seen.has(key)) continue;
		seen.add(key);
		rows.push(row);
	}
	rows.sort((a, b) => (SEVERITY_RANK[a.severity] ?? 2) - (SEVERITY_RANK[b.severity] ?? 2));
	return rows.slice(0, MAX_LESSONS);
}

/** The compact prompt block: JSON lines (the shape models respect), one per
 * lesson, preceded by a one-line header. Empty string when no lessons (the
 * prompt section is omitted entirely — no noise, P10). */
export function lessonsPromptBlock(rows: readonly LessonRow[]): string {
	if (rows.length === 0) return "";
	const lines = rows.map((r) => JSON.stringify({ class: r.class, rule: r.rule, ...(r.locus ? { locus: r.locus } : {}), origin: r.origin }));
	return [
		`## Lessons from prior rounds (JSON — apply each rule to THIS artifact; one line per lesson)`,
		...lines,
	].join("\n");
}
