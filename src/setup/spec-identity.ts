import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { isResumable } from "../resume.ts";
import { stateFileFor } from "../state/state-root.ts";
import { superDevEnv } from "../render/super-dev-dir.ts";

/** Wave 4 increment 2: SPEC IDENTITY + TRACK REUSE — sanitizeSlug/slugifyTask,
 *  the spec-reference numeral grammars (SPEC_NUM/SPEC_TREE_PATH_RE/
 *  SPEC_ARTIFACT_TREE_RE/SPEC_ARTIFACT_PATH_RE), specRefNumerals,
 *  slugFromSpecPathReference (v0.3.95 FIX A), dedupeSlugIndex (v0.3.18
 *  double-index guard), anchorNumeralRefusal (v0.3.12 F1), reusableScore,
 *  specReuseEnabled, findReusableSpec (G2 deterministic tiebreak +
 *  layout-aware), referencedSpecIdentifier, and nextSpecNumber — moved
 *  verbatim from setup.ts. One reason to change: how spec tracks are named,
 *  matched, and re-entered. */

/** Sanitize any string (LLM output or raw) into a kebab-case slug, truncated at
 *  a word boundary so it never cuts mid-word. */
export function sanitizeSlug(raw: string): string {
	let s = raw.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
	if (s.length > 40) { s = s.slice(0, 40); const c = s.lastIndexOf("-"); if (c > 8) s = s.slice(0, c); }
	return s.replace(/-+$/g, "");
}

/** Deterministic fallback slug: drop filler words, keep up to ~5 content words. */
const STOPWORDS = new Set("a an the to of for and or nor but in on at by with from into is are be as that this it its our your their we you they please need want implement add build create make new feature features simple app application page use using used based get one two three next".split(" "));
export function slugifyTask(task: string): string {
	const words = task.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w && !STOPWORDS.has(w));
	return sanitizeSlug(words.slice(0, 5).join("-")) || "task";
}

export function nextSpecNumber(cwd: string): number {
	const specsDir = join(cwd, "docs", "specifications");
	let max = 0;
	try {
		for (const entry of readdirSync(specsDir)) {
			const m = entry.match(/^(\d+)-/);
			if (m) max = Math.max(max, Number(m[1]));
		}
	} catch { /* no specs dir yet */ }
	return max + 1;
}

// ─── G2: spec-track reuse on task similarity ────────────────────────────────
// Slightly different task texts allocated DIFFERENT tracks for the same
// workstream (254-step-e2e-dashboard / 254-step-e2e-test-dashboard /
// 254-e2e-dashboard were all observed), each fresh track regenerating
// requirements nondeterministically and abandoning all prior convergence
// progress. Before allocating a new track, deterministically match the task
// against existing INCOMPLETE tracks (no LLM) and re-enter the same one.

/** Anchor-task file persisted inside a spec dir at first allocation. Never
 *  overwritten — the anchor keeps the track's identity stable across re-runs. */
export const SPEC_TASK_ANCHOR = ".task";

/** Stopword-stripped lowercase token set of a task text (shared vocabulary
 *  with slugifyTask so slug tokens and task tokens line up). */
export function taskTokens(task: string): Set<string> {
	return new Set(task.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w.length >= 2 && !STOPWORDS.has(w)));
}

/** Jaccard similarity of two task texts' token sets (near-identical re-runs). */
export function taskSimilarity(a: string, b: string): number {
	const ta = taskTokens(a);
	const tb = taskTokens(b);
	if (ta.size === 0 || tb.size === 0) return 0;
	let inter = 0;
	for (const t of ta) if (tb.has(t)) inter++;
	return inter / (ta.size + tb.size - inter);
}

/** Share of a track slug's distinctive tokens present in the task text
 *  (re-phrased re-run of the same feature: `step-e2e-dashboard` tokens
 *  appear inside a task that never mentions the original wording).
 *  R6 (NFR-6): a NUMERIC token in the slug (error code, ticket id, port) must
 *  appear VERBATIM in the task text — generic words alone (step/e2e/dashboard)
 *  hit the 0.75 threshold and silently absorb a DIFFERENT workstream into an
 *  existing track; the numeral is the one unambiguous discriminator. */
export function slugTokenContainment(slug: string, task: string): number {
	const rawTokens = slug.toLowerCase().split("-");
	const tokens = taskTokens(task);
	for (const numeric of rawTokens.filter((w) => /^\d+$/.test(w))) {
		if (!tokens.has(numeric)) return 0; // numeral absent → different workstream
	}
	const slugTokens = rawTokens.filter((w) => w.length >= 3 && !STOPWORDS.has(w));
	if (slugTokens.length === 0) return 0;
	let hit = 0;
	for (const t of slugTokens) if (tokens.has(t)) hit++;
	return hit / slugTokens.length;
}

/**
 * v0.3.12 F1 — the leading numerals of PATH-SHAPED SPEC references in a task
 * text (`docs/requirements/05-verification.md` → "5"). Two shapes:
 *  1. `NN-slug.md` (with or without a leading path);
 *  2. `NN-slug` riding a path — ONLY when the path smells like a docs/spec
 *     tree (docs|doc|requirement|spec|research segment), so source paths
 *     (`src/254-e2e/…`) and asset paths don't fabricate spec numerals
 *     (round-2 CR-2: the unrestricted form falsely refused same-spec reuse).
 * Free-text numerals (ports, ticket ids, dates) are deliberately NOT
 * extracted. Numerals are stored zero-padding-stripped (round-2 CR-4:
 * `05-verification` and `5-verification` name the same spec; `\d{1,4}` covers
 * 4-digit spec numbers).
 */
const SPEC_NUM = (raw: string) => String(parseInt(raw, 10));

/** The docs/spec-tree path smell for the spec-REFERENCE numeral grammar
 *  (specRefNumerals only — fix-round BLOCKING-2 split): a path counts when
 *  one of its segments is docs|doc|requirements|specifications|specs|research.
 *  Deliberately BROADER than the slug grammar below: numerals extracted from
 *  research/ citations feed only dedupeSlugIndex echo-stripping and
 *  anchorNumeralRefusal — reuse guards that can REFUSE a cross-workstream
 *  absorption, never cause one — so the citation-hijack exposure that
 *  narrowed the slug grammar does not apply here (verified in the fix round;
 *  specRefNumerals keeps this behavior, P6: each grammar serves its own
 *  consumer). Source paths (`src/254-e2e/…`) and asset paths must not
 *  fabricate spec numerals. */
const SPEC_TREE_PATH_RE = /(?:^|\/)(?:docs?|doc|requirements?|specifications?|specs?|research)(?:\/|$)/i;

/** The SPEC-ARTIFACT tree grammar (fix-round BLOCKING-2, owner ruling): only
 *  paths riding a requirements/ or specifications/ segment — super-dev's own
 *  re-entry format (the incident shape "…/docs/requirements/26-capability-
 *  backends.md"). Citation trees (research/, architecture/, or any other docs
 *  subtree) NEVER derive slugs: their basenames leak tokens into
 *  findReusableSpec's containment scoring (a later unrelated task citing the
 *  same reference doc hit containment 1.0 and hijacked the track). */
const SPEC_ARTIFACT_TREE_RE = /(?:^|\/)(?:requirements?|specifications?)(?:\/|$)/i;

/** The spec-artifact PATH grammar (fix-round BLOCKING-3): the adversarial
 *  reviewer's corrected boundary shape. Leading boundary accepts markdown
 *  delimiters (backtick, quotes, angle/square brackets) beside the original
 *  start/whitespace/paren/slash/@ forms; the basename is numeral-prefixed
 *  (BLOCKING-2: `NN-slug.md` only); the `.md` tail is sealed with
 *  `(?![\w.])` — NOT `\b`, which is word→non-word and still matches the dot
 *  in `.md.bak`/`.md.tmp` (the literal `(\b|(?=[…]|$))` alternation from the
 *  review has the same hole, so the tightest form that passes the specified
 *  cases is the negative lookahead: no word char and no dot may follow).
 *  Case-insensitive (`.MD` matches). */
const SPEC_ARTIFACT_PATH_RE = /(?:^|[\s(@/'"`<[])@?((?:[\w~.-]+\/)+)(\d{1,4})-([A-Za-z0-9][\w.-]*)\.md(?![\w.])/gi;

export function specRefNumerals(text: string): Set<string> {
	const out = new Set<string>();
	for (const m of text.matchAll(/(?<![\w/.-])(\d{1,4})(?=-[a-z0-9][\w.-]*\.md\b)/gi)) out.add(SPEC_NUM(m[1]));
	for (const m of text.matchAll(/(?:^|[\s(/])((?:[\w.-]+\/)+)(\d{1,4})(?=-[a-z0-9])/gi)) {
		if (SPEC_TREE_PATH_RE.test(m[1])) out.add(SPEC_NUM(m[2]));
	}
	return out;
}

/**
 * v0.3.95 FIX A (run-2026-09-12T15-16-29-042Z, owner-adjudicated option A;
 * fix-round BLOCKING-2 narrowed + BLOCKING-3 boundary-corrected) — the
 * spec-slug fallback for SPEC-ARTIFACT path references. `slugifyTask` treats
 * path segments as words, so `implement @docs/requirements/26-capability-
 * backends.md` fell back to the ugly "docs-requirements-26-capability-
 * backends" (the mid-slug numeral echo survives dedupeSlugIndex, which strips
 * only LEADING numerals) → spec id "26-docs-requirements-26-capability-
 * backends". When the task carries a requirements/ or specifications/ path
 * reference whose basename is numeral-prefixed (`NN-slug.md` — super-dev's
 * own re-entry format, the ONLY shape that ever composed meaningful slugs),
 * the slug derives from the REFERENCED FILE's basename instead:
 * "…/26-capability-backends.md" → "26-capability-backends" → the caller's
 * dedupeSlugIndex strips the leading numeral echo (26 ∈ specRefNumerals(task))
 * → "capability-backends" → spec id "26-capability-backends" (the historical
 * meaningful shape, e.g. "24-macro-liquidity-dimension"). Citations of
 * research/reference/architecture docs — any other tree, or non-numeral
 * basenames — return null → slugifyTask fallback (v0.3.94 behavior, zero
 * regression; their tokens never leak into findReusableSpec). Pure and total:
 * FIRST spec-artifact reference wins on multi-ref tasks; the LLM-summarized
 * `options.slug` still wins above this helper at the call site.
 */
export function slugFromSpecPathReference(task: string): string | null {
	for (const m of task.matchAll(SPEC_ARTIFACT_PATH_RE)) {
		if (!SPEC_ARTIFACT_TREE_RE.test(m[1])) continue;
		const slug = sanitizeSlug(`${m[2]}-${m[3]}`);
		if (slug) return slug;
	}
	return null;
}

/**
 * v0.3.18 — content-aware slugs + double-index guard: a slug that still starts
 * with a referenced spec index numeral (the slug LLM echoing the requirement
 * FILENAME `docs/requirements/16-dimension-financials.md` → "16-dimension-
 * financials") doubles the allocated number into "16-16-dimension-financials".
 * Strip the echo ONLY when the leading numeral provably comes from a docs-path
 * spec reference in the task text — free-text numerals (step 254, ticket 1234)
 * are identity tokens for track reuse (R6) and are kept verbatim. Falls back to
 * the original slug when the remainder would be empty.
 */
export function dedupeSlugIndex(slug: string, task: string): string {
	let s = slug;
	for (;;) {
		const m = s.match(/^(\d{1,4})-(.+)$/);
		if (!m) return s;
		if (!specRefNumerals(task).has(String(parseInt(m[1], 10)))) return s;
		s = sanitizeSlug(m[2]) || slug; // empty remainder → restore original
	}
}

/**
 * v0.3.12 F1 (round-2 CR-1/CR-3): the anchor-numeral refusal as a standalone
 * probe so EVERY reuse branch can pass through it (not just Jaccard) and the
 * refusal is LOGGABLE (the plan doc promised a visible reason, not silence).
 * Returns the offending numeral when the anchor names spec(s) the candidate
 * task does not name — null when the guard passes (or nothing to check).
 */
export function anchorNumeralRefusal(anchorTask: string | undefined, task: string): string | null {
	if (!anchorTask) return null;
	const anchorNums = specRefNumerals(anchorTask);
	if (anchorNums.size === 0) return null;
	const taskNums = specRefNumerals(task);
	for (const n of anchorNums) if (!taskNums.has(n)) return n;
	return null;
}

/** Reuse score threshold: containment >= 0.75 with >= 3 slug tokens, exact
 *  match for 2-token slugs, or Jaccard >= 0.6 for near-identical anchors.
 *  v0.3.12 F1 (incident: the 06 task absorbed into the merged 05 track at
 *  Jaccard 0.643): the anchor-Jaccard branch now carries the SAME numeric-
 *  verbatim discipline as the R6 slug rule — an anchor's spec-reference
 *  numerals (05-verification.md) must appear in the candidate task, else the
 *  uniform-template prefix drowns the one distinguishing token and reuse
 *  fires across DIFFERENT workstreams. */
function reusableScore(slug: string, anchorTask: string | undefined, task: string): number {
	// v0.3.12 round-2 CR-1: the anchor-numeral guard gates EVERY branch
	// (containment included — a numeric-stripped slug plus an anchor naming a
	// DIFFERENT spec is the same cross-workstream absorption the Jaccard
	// branch had). Guard first, branch after.
	if (anchorNumeralRefusal(anchorTask, task) !== null) return 0;
	const slugTokens = slug.toLowerCase().split("-").filter((w) => w.length >= 3 && !STOPWORDS.has(w));
	const containment = slugTokenContainment(slug, task);
	if (slugTokens.length >= 3 && containment >= 0.75) return Math.max(containment, 0.75);
	if (slugTokens.length === 2 && containment === 1) return 1;
	if (anchorTask && taskSimilarity(anchorTask, task) >= 0.6) return taskSimilarity(anchorTask, task);
	return 0;
}

/** Env kill-switch for spec-track reuse. */
export function specReuseEnabled(): boolean {
	return superDevEnv("SUPER_DEV_NO_SPEC_REUSE") !== "1";
}

/** Find an existing INCOMPLETE spec track whose task matches the new task
 *  (same workstream, re-phrased). Completed tracks (.complete marker) are
 *  skipped — asking again after completion is a new iteration, not a re-run.
 *  Returns the spec identifier (e.g. `254-step-e2e-dashboard`) or null.
 *  R6 (NFR-6): the reuse DECISION is logged with its score (`opts.log`) so a
 *  wrong absorption is visible in the run log, not silent. */
export function findReusableSpec(cwd: string, task: string, opts: { worktree?: boolean; log?: (message: string) => void } = {}): string | null {
	const useWorktree = opts.worktree !== false; // default: the pipeline layout
	const candidates: Array<{ id: string; dir: string; score: number; mtime: number }> = [];
	const consider = (specDir: string, id: string) => {
		// Reuse is a CONTINUATION of a dead run (adversarial
		// G2-COLLISION-ABSORPTION / code-review G2-FALSE-POSITIVE-REUSE): only
		// tracks with recorded progress (non-empty resume cache, no .complete
		// marker — i.e. isResumable) are eligible. A track that never got past
		// setup has nothing to preserve; a finished track asked-for-again is a
		// new iteration, not a re-run.
		if (!isResumable(specDir)) return;
		let anchor: string | undefined;
		try {
			anchor = readFileSync(stateFileFor(specDir, SPEC_TASK_ANCHOR), "utf8"); // 063 S2
		} catch { /* no anchor — containment-only scoring */ }
		const slug = id.replace(/^\d+-/, "");
		const refusedNumeral = anchorNumeralRefusal(anchor, task);
		if (refusedNumeral !== null) {
			opts.log?.(`spec-track reuse: refusing track ${id} — its anchor names spec numeral ${refusedNumeral} absent from this task (different workstream under a uniform template)`);
			return;
		}
		const score = reusableScore(slug, anchor, task);
		if (score <= 0) return;
		let mtime = 0;
		try {
			mtime = statSync(stateFileFor(specDir, SPEC_TASK_ANCHOR)).mtimeMs; // 063 S2
		} catch { /* fallback mtime 0 — score still discriminates */ }
		candidates.push({ id, dir: specDir, score, mtime });
	};
	// Layout-aware (code-review N1-CROSS-LAYOUT-REUSE): a track recorded
	// in-place (skipWorktree run) that is "reused" by a worktree-mode run (or
	// vice versa) points specDirectory at an EMPTY sibling dir — the docs and
	// cache stay in the other layout and nothing is preserved. Only tracks
	// whose recorded layout matches how THIS run addresses the spec dir are
	// eligible.
	const wtRoot = join(cwd, ".worktree");
	if (useWorktree && existsSync(wtRoot)) {
		for (const id of readdirSync(wtRoot)) consider(join(wtRoot, id, "docs", "specifications", id), id);
	}
	const specsRoot = join(cwd, "docs", "specifications");
	if (!useWorktree && existsSync(specsRoot)) {
		for (const id of readdirSync(specsRoot)) consider(join(specsRoot, id), id);
	}
	if (candidates.length === 0) {
		opts.log?.("spec-track reuse: no reusable track matched this task — allocating a fresh spec directory");
		return null;
	}
	// Deterministic across machines: score, then recency, then lexicographic id
	// (adversarial G2-TIEBREAK-NONDETERMINISM — readdir order is not stable).
	candidates.sort((a, b) => b.score - a.score || b.mtime - a.mtime || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
	const best = candidates[0];
	// R6 (NFR-6): the reuse decision carries its SCORE — a wrong absorption is
	// visible in the run log instead of silently re-entering the track.
	opts.log?.(`spec-track reuse: re-entering track "${best.id}" (score ${best.score.toFixed(2)} — containment/anchor similarity above threshold; prior docs, knowledge and user notes preserved)`);
	return best.id;
}

/** Extract an explicitly referenced existing spec directory from the task text.
 * Users often ask: `implement @docs/specifications/24-foo/` and expect the
 * whole workflow to keep that track as source-of-truth. Without this, setup
 * allocates the next numbered spec (`28-foo`), causing review/source-of-truth
 * failures even when implementation succeeds. */
export function referencedSpecIdentifier(task: string, cwd: string): string | null {
	const specsRoot = join(cwd, "docs", "specifications");
	const re = /@?docs\/specifications\/([A-Za-z0-9][A-Za-z0-9._-]*)(?:\/|\b)/g;
	let match: RegExpExecArray | null;
	while ((match = re.exec(task)) !== null) {
		const candidate = match[1];
		if (candidate.includes("..") || candidate.includes("/")) continue;
		if (existsSync(join(specsRoot, candidate))) return candidate;
	}
	return null;
}
