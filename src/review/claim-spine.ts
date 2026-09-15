/**
 * 065 core wave D-F-A — the write-claim spine: ONE deterministic extractor
 * (verb-context classification + token validation + list governance) consumed
 * by four gates (W writer closure / R reviewer binding / E entry cross-product
 * / I interval inputs). docs/requirements/065-first-pass-satisfiability.md §4.
 *
 * WHY THIS MODULE EXISTS (the 065 defect table, run 2026-09-14T11-40-21-540Z):
 * the pipeline re-extracted "which files will be written / are protected" from
 * untyped prose with a different heuristic at every seam, and the
 * `pathTokens[0]`-over-a-±200-char-window resolution INVERTED sentences
 * ("extends X … never touching Y" protected X, the write target). This module
 * is the single grammar (P6): classify each path token by its GOVERNING
 * context, never by position.
 *
 * Grammar table (065 §4.1 — BINDING, P2: additions require a row + fixture):
 *
 * | Form                                  | Example                                                     | Classification |
 * |---------------------------------------|-------------------------------------------------------------|----------------|
 * | Verb-governed write                   | "22-public-interface.md §4 gains the data/cache note"       | WRITE(token) |
 * | Verb-governed protect                 | "src/stages.ts, src/orchestrator.ts stay byte-untouched"    | PROTECT(all list tokens) |
 * | Post-positioned protect qualifier     | "the guard pins python/omisis/_fetchers.py byte-untouched"   | PROTECT(_fetchers.py) |
 * | Mixed single sentence                 | one WRITE ("gains") + one PROTECT ("pins … byte-untouched") | both mint (different tokens) |
 * | List context                          | "Files edited: src/a.ts, tests/b.ts (NEW), docs/c.md"       | WRITE(every listed token) |
 * | Negation                              | "must not gain", "without touching X"                       | no claim |
 * | Noun form                             | "the byte-untouched guard"                                  | no protect claim |
 * | Concept reference                     | "spec 22's package layout gains the note"                   | WRITE(mapping[concept]) |
 * | Template/invalid token                | `${wiredFile}`, `${pathspec}`, bare identifiers              | REJECTED at resolution (P10-counted) |
 *
 * P4: purely mechanical. P5: gates fail-open on absent trees (empty claims).
 * P8: every scan is single-pass with bounded windows. P10: rejected tokens are
 * reported through the caller's scan lines, never silently dropped.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { claimPathUsable, isUsableProtectedToken } from "../stages/plan-feasibility.ts";
import { extractContractInventory, normalizeAmendmentFamily, PROTECT_QUALIFIER_RE, type ContractInventory, type NormalizedAmendmentFamilyEntry } from "./contract-surface.ts";

// ─── types ───────────────────────────────────────────────────────────────────

/** One deterministically extracted write mandate. */
export interface WriteClaim {
	/** Repo-relative normalized path (claimPathUsable spelling). */
	path: string;
	/** The governing verb's canonical form. */
	verb: "create" | "extend" | "amend" | "delete";
	/** Locus of the governing sentence: `<file>:<line>`. */
	locus: string;
	/** The stage whose artifact minted the claim (for findings + routing). */
	sourceStage: string;
}

/** concept → protected-file paths (fed from inventory.mapping / repo-invariants). */
export type ClaimConceptMap = Map<string, string[]>;

// ─── token validation (D2 — applies at pin resolution, both arms) ────────────

/** Template-variable / interpolation tokens are NEVER repo paths. The observed
 *  phantoms (`${wiredFile}` financials-contract.test.ts:843, `${pathspec}`
 *  prosperity-contract.test.ts:439) entered exactly this way — via porcelain
 *  pathspecs, which no prose window ever wrote. ONE spelling (P6): the base
 *  predicate lives in plan-feasibility (the DAG root). */
export const isUsablePathToken = isUsableProtectedToken;

/** 065 D2 — pin-resolution governance: which of a hit's window tokens the
 *  STATEMENT actually governs as protected. Rules (the §4.1 grammar):
 *  1. Statement-governed protect tokens win (list governance included:
 *     "A, B, C stay byte-untouched" governs all three).
 *  2. When the statement governs NO protect token, the window tokens MINUS
 *     the statement's WRITE-governed tokens anchor the pin (the inversion
 *     guard: "extends X … never touching Y" must never protect X).
 * Pure; never throws. */
export function governedProtectedTokens(statement: string, windowTokens: readonly string[]): string[] {
	if (windowTokens.length === 0) return [];
	try {
		// B1 (grill round 1, both gates): classify per-SENTENCE, never the raw
		// md line — a write sentence and a protect sentence on one line must
		// not cross-govern ("The module lands in X. Y stays byte-untouched" must
		// never protect X).
		const writes: WriteClaim[] = [];
		const protects: string[] = [];
		for (const seg of segments(statement)) {
			const r = classifySegment(seg, "", "");
			writes.push(...r.writes, ...r.conceptWrites);
			for (const p of r.protects) if (!protects.includes(p)) protects.push(p);
		}
		const winSet = new Set(windowTokens);
		if (protects.length > 0) {
			const governed = protects.filter((t) => winSet.has(t));
			if (governed.length > 0) return governed;
		}
		const writeGoverned = new Set(writes.map((w) => w.path));
		return windowTokens.filter((t) => !writeGoverned.has(t));
	} catch {
		return [...windowTokens]; // scanner failure degrades to the old behavior, never throws
	}
}

// ─── the grammar (constants shared by write extraction and protect resolution)

/** Write verbs (065 §4.1 rows 1/5). Case-insensitive, word-bounded.
 *  Governs BOTH directions — English SVO puts the FILE in subject position
 *  ("22-public-interface.md §4 gains the note"), while list/prose forms put
 *  the verb first ("extends X", "Files edited: …"). */
const WRITE_VERB_RE = /\b(gains?|gained|extends?|extended|adds?|added|creates?|created|writes?|wrote|edits?|edited|amends?|amended|lands?|landed|ships?|shipped|modifies?|modified|updates?|updated|introduces?|introduced|fixes?|fixed)\b/gi;

/** Protect qualifiers — imported from contract-surface (single spelling,
 *  P6/065 A2 — same regex object as the md-arm scanner). */


/** Negation guard (row 6): a negated write verb mints nothing. */
const NEGATED_WRITE_RE = /\b(?:must\s+not|never|without)\s+(?:gains?|gain|extends?|extend|adds?|add|creates?|create|writes?|write|edits?|edit|amends?|amend|lands?|land|ships?|ship|modifies?|modify|updates?|update|touch(?:es|ing)?)\b|\bwithout\s+touching\b/gi;

/** B2 (grill round 1, both gates): non-global clones for stateless .test()
 * — the module-level /g forms are for exec loops ONLY (reset discipline);
 * .test() on a /g regex advances lastIndex and makes classification depend
 * on input history ("without touching X and Y" minted a phantom WRITE on Y). */
const NEGATED_WRITE_TEST_RE = new RegExp(NEGATED_WRITE_RE.source, "i");
const WRITE_VERB_TEST_RE = new RegExp(WRITE_VERB_RE.source, "i");

/** List-context headers (row 5): every path token in the segment is a WRITE. */
const LIST_CONTEXT_RE = /^(?:\s*[-*]\s*)?(?:files?\s+(?:edited|created|written|changed|modified)|deliverables\.requirefiles|requirefiles)\s*[:=]?/i;

/** Sentence/segment boundaries for governance: newlines, sentence enders
 *  followed by whitespace+capital/digit/backtick, and semicolons (the run's
 *  own mixed sentence used a semicolon between the WRITE and PROTECT arms). */
function segments(text: string): string[] {
	return text
		.split(/\n+|(?<=[.!?])\s+(?=[A-Z0-9`"(\[])|;\s*/)
		.map((s) => s.trim())
		.filter((s) => s.length > 0);
}

/** Repo-path-looking tokens in a segment (extension-bounded, like the
 *  contract-surface PATH_TOKEN_RE family). Returns usable, deduped tokens in
 *  order; rejects template/identifier tokens via isUsablePathToken (P10 notes
 *  are the caller's concern — this returns the rejects for reporting). */
const SEGMENT_TOKEN_RE = /[A-Za-z0-9_.\-/]+\.(?:ts|tsx|js|jsx|mjs|cjs|cts|mts|py|json|md|markdown|rs|go|toml|yaml|yml|gitignore|ignore)\b|[A-Za-z0-9_.\-/]+\.(?:ts|tsx|js|py|md)\b/g;
const REPO_ROOTED_RE = /^(?:\.\/)?(?:src|tests|test|lib|libs|docs|python|scripts|internal|pkg|cmd|__tests__|tools|app|server|client)\//;

export function segmentPathTokens(segment: string): { tokens: string[]; rejected: string[] } {
	const tokens: string[] = [];
	const rejected: string[] = [];
	const seen = new Set<string>();
	SEGMENT_TOKEN_RE.lastIndex = 0;
	for (let m = SEGMENT_TOKEN_RE.exec(segment); m !== null; m = SEGMENT_TOKEN_RE.exec(segment)) {
		const raw = m[0];
		const before = m.index > 0 ? segment[m.index - 1] : "";
		const afterIdx = m.index + raw.length;
		const after = afterIdx < segment.length ? segment[afterIdx] : "";
		const quoted = (before === "`" && (after === "`" || after === "")) || (before === '"' && after === '"') || (before === "'" && after === "'");
		const beforeOk = before === "" || /[\s(`"':\[—–-]/.test(before);
		const afterOk = after === "" || /[\s)`"':.,;\]—–-]/.test(after);
		if (!quoted && !(REPO_ROOTED_RE.test(raw) && beforeOk && afterOk)) continue;
		if (!isUsablePathToken(raw)) { rejected.push(raw); continue; }
		const usable = claimPathUsable(raw);
		if (usable && !seen.has(usable)) { seen.add(usable); tokens.push(usable); }
	}
	return { tokens, rejected };
}

/** Does the segment carry a negated write verb? (row 6 — a negated verb
 *  governs NOTHING: no write claims from this segment.) */
function segmentNegated(segment: string): boolean {
	return NEGATED_WRITE_TEST_RE.test(segment);
}

/**
 * Classify ONE segment's path tokens into write claims and protect tokens
 * (the §4.1 grammar). Pure. Returns claims in deterministic order.
 *
 * Resolution rules (each a grammar-table row):
 * 1. LIST_CONTEXT header ⇒ every token is a WRITE (row 5).
 * 2. A protect qualifier whose match position FOLLOWS a run of comma/and-listed
 *    tokens ⇒ those backward-list tokens are PROTECT (row 2 — list governance;
 *    the qualifier "stay byte-untouched" governs its list, never a following
 *    sentence's tokens).
 * 3. "pins <token> … byte-untouched" / "never touching" ⇒ the token(s) named
 *    between/after are PROTECT (row 3).
 * 4. A write verb before a token (same segment, not negated) ⇒ WRITE (row 1).
 * 5. A token governed by BOTH (impossible by construction: a protect qualifier
 *    after it + a write verb before it in one segment) resolves PROTECT — the
 *    contradiction is Gate E's finding, not a silent write.
 * 6. Ungoverned token ⇒ no claim (precision over recall: a false write-claim
 *    false-blocks gates E/W).
 */
export function classifySegment(segment: string, sourceLocus: string, sourceStage: string, conceptMap?: ClaimConceptMap): { writes: WriteClaim[]; protects: string[]; conceptWrites: WriteClaim[] } {
	const { tokens } = segmentPathTokens(segment);
	const writes: WriteClaim[] = [];
	const protects: string[] = [];
	const negated = segmentNegated(segment);
	// Row 5: list context governs every token.
	if (LIST_CONTEXT_RE.test(segment)) {
		for (const t of tokens) writes.push({ path: t, verb: "amend", locus: sourceLocus, sourceStage });
	}
	// Protect qualifiers: find their positions; tokens in the backward
	// comma/and-list run preceding a qualifier are PROTECT; tokens named after
	// "pins"/"never touching" (same segment) are PROTECT.
	const protectIdxs: Array<{ start: number; end: number }> = [];
	PROTECT_QUALIFIER_RE.lastIndex = 0;
	for (let m = PROTECT_QUALIFIER_RE.exec(segment); m !== null; m = PROTECT_QUALIFIER_RE.exec(segment)) protectIdxs.push({ start: m.index, end: m.index + m[0].length });
	const writeVerbIdxs: Array<{ start: number; end: number }> = [];
	WRITE_VERB_RE.lastIndex = 0;
	for (let m = WRITE_VERB_RE.exec(segment); m !== null; m = WRITE_VERB_RE.exec(segment)) writeVerbIdxs.push({ start: m.index, end: m.index + m[0].length });
	const tokenPositions: Array<{ token: string; start: number; end: number }> = [];
	{
		const re = new RegExp(SEGMENT_TOKEN_RE.source, "g");
		for (let m = re.exec(segment); m !== null; m = re.exec(segment)) {
			const raw = m[0];
			const before = m.index > 0 ? segment[m.index - 1] : "";
			const afterIdx = m.index + raw.length;
			const after = afterIdx < segment.length ? segment[afterIdx] : "";
			const quoted = (before === "`" && (after === "`" || after === "")) || (before === '"' && after === '"') || (before === "'" && after === "'");
			const beforeOk = before === "" || /[\s(`"':\[—–-]/.test(before);
			const afterOk = after === "" || /[\s)`"':.,;\]—–-]/.test(after);
			if (!quoted && !(REPO_ROOTED_RE.test(raw) && beforeOk && afterOk)) continue;
			if (!isUsablePathToken(raw)) continue;
			const usable = claimPathUsable(raw);
			if (usable) tokenPositions.push({ token: usable, start: m.index, end: afterIdx });
		}
	}
	for (const tp of tokenPositions) {
		const verbNegated = (start: number): boolean => {
			const head = segment.slice(Math.max(0, start - 16), start);
			return /(?:must\s+not|never|without)\s+[a-z]*$/i.test(head);
		};
		const writeGoverned = writeVerbIdxs.some((v) => {
			if (verbNegated(v.start)) return false;
			// FORWARD (verb … token): "extends X", "lands in X", "edits X".
			if (v.end <= tp.start) {
				const between = segment.slice(v.end, tp.start);
				return !NEGATED_WRITE_TEST_RE.test(between) && between.length <= 120;
			}
			// BACKWARD (token [§ref/qualifier] verb — SVO subject position):
			// "docs/requirements/22-public-interface.md §4 gains the note".
			// Tight window (≤40 chars).
			if (tp.end <= v.start) {
				const between = segment.slice(tp.end, v.start);
				return /^[\s§\w.'’()\/-]{0,40}$/.test(between);
			}
			return false;
		});
		const protectGoverned = protectIdxs.some((q) => {
			// (i) token INSIDE the qualifier span — the post-positioned form
			//     "pins <token> byte-untouched" (grammar row 3).
			if (q.start <= tp.start && tp.end <= q.end) return true;
			// (ii) qualifier AFTER the token with only list/connective material
			//      between (grammar row 2 — list governance). B1 (grill round 1):
			//      prose carrying a WRITE VERB or a sentence ender between the
			//      token and the qualifier means the token belongs to the WRITE
			//      clause — "X gains the note, and Y stays byte-untouched" must
			//      NOT protect X.
			if (q.start < tp.end) return false;
			const between = segment.slice(tp.end, q.start);
			if (between.length > 80) return false;
			if (WRITE_VERB_TEST_RE.test(between)) return false;
			if (/[.!?]\s/.test(between)) return false;
			return /^[\s,/&()'\-a-zA-Z0-9._]*(?:\b(?:and|or|plus|all|the|these|those|this|that|file|files|module|guard|surface|path)\b[\s,/&()'\-a-zA-Z0-9._]*)*$/.test(between);
		});
		const forwardProtectGoverned = protectIdxs.some((q) => {
			// (iii) A2 fold: qualifier IMMEDIATELY BEFORE the token — the forward
			//      form "never touching X" / "must not touch X" (the md arm
			//      previously minted nothing for these wordings).
			if (q.end > tp.start) return false;
			const between = segment.slice(q.end, tp.start);
			return between.length <= 40 && !WRITE_VERB_TEST_RE.test(between) && /^[\s,/&()'\-a-zA-Z0-9._]*$/.test(between);
		});
		// A3 (grill round 1): same-token BOTH-governance mints BOTH — the
		// self-contradiction stays visible to Gate E instead of being hidden by
		// a protect-only resolution (rule 5 of the v1 table is withdrawn).
		if ((protectGoverned || forwardProtectGoverned) && !protects.includes(tp.token)) protects.push(tp.token);
		if (writeGoverned && !writes.some((w) => w.path === tp.token)) {
			writes.push({ path: tp.token, verb: "amend", locus: sourceLocus, sourceStage });
		}
	}
	// Row 8: concept references — a write verb in a segment that names a mapped
	// concept mints WRITE(mapping[concept]) even with no literal path token.
	const conceptWrites: WriteClaim[] = [];
	if (conceptMap && conceptMap.size > 0 && !negated && writeVerbIdxs.length > 0) {
		for (const [concept, files] of conceptMap) {
			if (!concept || files.length === 0) continue;
			const cRe = new RegExp(`(?<![\\w-])${concept.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w-])`, "i");
			if (!cRe.test(segment)) continue;
			for (const f of files) {
				if (!writes.some((w) => w.path === f) && !conceptWrites.some((w) => w.path === f)) {
					conceptWrites.push({ path: f, verb: "amend", locus: sourceLocus, sourceStage: `${sourceStage}(concept:${concept})` });
				}
			}
		}
	}
	return { writes, protects, conceptWrites };
}

/** extractWriteClaims (065 §4.1): texts → write claims. Deterministic, pure. */
export function extractWriteClaims(texts: Array<{ text: string | undefined | null; locusPrefix: string }>, sourceStage: string, conceptMap?: ClaimConceptMap): { claims: WriteClaim[]; rejectedTokens: string[] } {
	const claims: WriteClaim[] = [];
	const rejected: string[] = [];
	const seen = new Set<string>();
	for (const t of texts) {
		if (!t || typeof t.text !== "string" || t.text.length === 0) continue;
		const segs = segments(t.text);
		for (let i = 0; i < segs.length; i++) {
			const seg = segs[i];
			// Line number within the source text (1-based) for the locus.
			const upto = t.text.indexOf(seg);
			const line = upto >= 0 ? t.text.slice(0, upto).split("\n").length : 1;
			const locus = `${t.locusPrefix}:${line}`;
			const { tokens: segRejected } = segmentPathTokens(seg);
			for (const r of segRejected) if (!rejected.includes(r)) rejected.push(r);
			const { writes, conceptWrites } = classifySegment(seg, locus, sourceStage, conceptMap);
			for (const w of [...writes, ...conceptWrites]) {
				const key = `${w.path}\u0000${w.locus}`;
				if (seen.has(key)) continue;
				seen.add(key);
				claims.push(w);
			}
		}
	}
	return { claims, rejectedTokens: rejected };
}

// ─── D7: the ONE .knowledge.json amendmentFamily reader (065 DEC-7) ──────────

/**
 * The unified amendmentFamily reader (065 §5 DEC-7 / D7): ONE exported spelling
 * replacing BOTH duplicated fail-closed readers (protection-interval's
 * approvedAmendmentSharedFiles and plan-feasibility's
 * readAmendmentFamilySharedFiles). Resolution order: stages.design.data.
 * amendmentFamily ?? stages.spec.data.amendmentFamily. FAIL-CLOSED (059 grill
 * R8, preserved verbatim): unparseable JSON, wrong envelope, or ANY malformed
 * entry ⇒ ZERO entries (every P10 note says so). 063's S2 census redirects
 * exactly this helper when state relocates.
 */
export function readAmendmentFamilyEntries(specDirectory: string | undefined, notes?: string[]): NormalizedAmendmentFamilyEntry[] {
	const note = (msg: string): void => { if (notes) notes.push(msg); };
	if (!specDirectory) return [];
	const abs = join(specDirectory.endsWith("/") ? specDirectory.slice(0, -1) : specDirectory, ".knowledge.json");
	if (!existsSync(abs)) return [];
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(abs, "utf8"));
	} catch {
		note(".knowledge.json: present but unparseable — zero amendmentFamily entries (fail-closed)");
		return [];
	}
	const stages = (parsed as { stages?: unknown } | null)?.stages;
	if (!stages || typeof stages !== "object" || Array.isArray(stages)) {
		note(".knowledge.json: malformed (expected {stages: {...}}) — zero amendmentFamily entries (fail-closed)");
		return [];
	}
	const familyOf = (stageId: string): unknown => {
		const row = (stages as Record<string, unknown>)[stageId] as { data?: unknown } | undefined;
		const data = row && typeof row === "object" && !Array.isArray(row) ? (row.data as { amendmentFamily?: unknown } | undefined) : undefined;
		return data && typeof data === "object" ? (data as { amendmentFamily?: unknown }).amendmentFamily : undefined;
	};
	const raw = familyOf("design") ?? familyOf("spec");
	if (raw === undefined || raw === null) return []; // nothing declared — silent (nothing was declared)
	const { entries, malformed } = normalizeAmendmentFamily(raw);
	// P10 note contract preserved from the retired duplicated readers (the
	// 059 test suite greps "malformed amendmentFamily entry"):
	for (const m of malformed) note(`.knowledge.json: malformed amendmentFamily entry — ${m} — zero amendmentFamily entries (fail-closed)`);
	return malformed.length > 0 ? [] : entries;
}

/** The exemption set every gate uses (file-level — the interval's semantics;
 *  pin-level precision is Gate R's demandable-set concern, never Gate E's: a
 *  writer cannot cite pinIds minted from its own future prose). */
export function amendmentExemptFiles(specDirectory: string | undefined, notes?: string[]): Set<string> {
	return new Set(readAmendmentFamilyEntries(specDirectory, notes).map((e) => e.sharedFile));
}

// ─── Gate W: writer typed-closure over the FRESH rendered artifacts ─────────

export interface WriterGateInput {
	stage: string;
	/** The stage control (amendmentFamily home). */
	control: Record<string, unknown> | undefined;
	/** The JUST-RENDERED artifact texts (fresh walk — never the input-slice
	 *  stamp; the 065 HIGH-1(c) temporal hole). */
	docTexts: Array<{ text: string | undefined | null; locusPrefix: string }>;
	/** Fresh inventory (the caller walks; this function never re-walks). */
	inventory: ContractInventory;
	/** Concept map (inventory.mapping) for concept-reference claims. */
	conceptMap?: ClaimConceptMap;
	/** Intent-level stages (requirements/bdd) get ADVISORY findings; concrete
	 *  stages (design/spec) get BLOCKING (059 W2: the typed family is a
	 *  design/spec home). */
	level: "intent" | "concrete";
}

/** Gate W finding shape — reuses ContractValidatorFinding for gate wiring. */
export interface ClaimFinding {
	kind: "blocking" | "advisory";
	message: string;
}

/**
 * The typed-closure rule (065 §4.2): every write-claim path that carries a
 * pin must appear as some amendmentFamily entry's sharedFile. Prose paths are
 * claim-evidence (extracted), so a file hidden in docUpdates prose can no
 * longer bypass the exemption grammar (D3). Self-minted pins (locus inside
 * THIS spec's own artifacts) produce a DEDUCATION finding — remove the
 * contradiction in your own artifact; no family declaration can license
 * writing what the same artifact declares immutable.
 */
export function writeClaimClosureFindings(input: WriterGateInput): ClaimFinding[] {
	const findings: ClaimFinding[] = [];
	const { claims } = extractWriteClaims(input.docTexts, input.stage, input.conceptMap);
	if (claims.length === 0) return findings;
	const { entries, malformed } = normalizeAmendmentFamily(input.control?.amendmentFamily);
	// A6 (grill round 1): a malformed entry voids ALL Gate-E exemptions
	// (fail-closed reader) while this gate's control-side keeps the valid
	// ones — surface the asymmetry AT the writer with a repair demand, so the
	// family is either fully valid or the run does not proceed to Gate E.
	for (const m of malformed) {
		findings.push({
			kind: input.level === "concrete" ? "blocking" : "advisory",
			message: `[contract-metadata] ${input.stage} ${m} — while ANY entry is malformed, Gate E honors ZERO exemptions (fail-closed); fix the entry so the whole family is valid (065 A6 unification).`,
		});
	}
	const familyFiles = new Set(entries.map((e) => e.sharedFile));
	const seen = new Set<string>();
	for (const claim of claims) {
		const pins = input.inventory.protectedFiles.get(claim.path) ?? [];
		if (pins.length === 0) continue;
		// F-2/A1 (grill round 1, both gates): self-minted pins FIRST — no family
		// declaration can license writing what the same bundle declares
		// immutable (claim.locus docs are repo-relative; pin.owningSpec is).
		const claimDoc = claim.locus.split(":")[0] ?? "\u0000";
		const selfPins = pins.filter((p) => p.owningSpec === claimDoc);
		for (const pin of selfPins.slice(0, 3)) {
			findings.push({
				kind: input.level === "concrete" ? "blocking" : "advisory",
				message: `${input.stage} write-claim on ${claim.path} (@ ${claim.locus}) contradicts a pin in ${input.stage}'s OWN artifact (@ ${pin.locus}: "${pin.statement.slice(0, 120)}") — the same artifact declares the file written AND immutable. Remove one side: drop the write-claim, or drop the immutability wording (no family declaration licenses this — it is a self-contradiction).`,
			});
		}
		if (familyFiles.has(claim.path)) continue; // covered — closure holds for this claim
		for (const pin of pins.slice(0, 3)) {
			if (selfPins.includes(pin)) continue;
			const key = `${claim.path}\u0000${pin.pinId}`;
			if (seen.has(key)) continue;
			seen.add(key);
			findings.push({
				kind: input.level === "concrete" ? "blocking" : "advisory",
				message: `${input.stage} writes ${claim.path} (@ ${claim.locus}) which carries a foreign pin ${pin.pinId} (${pin.idiomFamily} @ ${pin.locus}: "${pin.statement.slice(0, 120)}") but no amendmentFamily entry declares sharedFile=${claim.path} — declare the entry (move the pin or exempt it with a justification), or drop the write-claim (065 Gate W typed closure; prose docUpdates do not exempt).`,
			});
		}
	}
	return findings;
}

// ─── Gate E: the Stage-9-entry cross-product (065 §4.4) ──────────────────────

export interface EntryContradiction {
	path: string;
	/** The write side (both loci named — the two-locus finding contract). */
	writeLocus: string;
	/** Every protecting clause on the path (incl. self-minted — D1). */
	protectLoci: Array<{ pinId: string; locus: string; statement: string }>;
	exemptedElsewhere: boolean;
}

export interface EntryGateResult {
	contradictions: EntryContradiction[];
	/** P10 scan lines (exemptions applied, rejects, cap notes). */
	scanLines: string[];
}

/**
 * The cross-product assertion: writeClaims × protectClaims ∖ exemptions = ∅.
 * Self-minted pins are INCLUDED (D1: a spec that writes X and protects X is a
 * contradiction regardless of which artifact minted the pin). Exemptions are
 * file-level (amendmentExemptFiles). Scan-cap: the caller's inventory may be
 * partial (MAX_SCAN_FILES) — found contradictions still block; the cap is a
 * loud scan line (partial-but-authoritative, never silent fail-open).
 */
export function entryContradictions(input: {
	writeClaims: WriteClaim[];
	inventory: ContractInventory;
	specDirectory: string | undefined;
}): EntryGateResult {
	const scanLines: string[] = [];
	if (input.inventory.errors.some((e) => e.includes("scan cap reached"))) {
		scanLines.push("gateE: inventory scan cap reached — protectClaims are PARTIAL but authoritative (contradictions found in the partial walk still block)");
	}
	const exempt = amendmentExemptFiles(input.specDirectory, scanLines);
	for (const f of exempt) scanLines.push(`gateE exemption: ${f} — owner-approved amendmentFamily`);
	const byPath = new Map<string, EntryContradiction>();
	for (const claim of input.writeClaims) {
		const pins = input.inventory.protectedFiles.get(claim.path);
		if (!pins || pins.length === 0) continue;
		if (exempt.has(claim.path)) continue;
		const row = byPath.get(claim.path) ?? { path: claim.path, writeLocus: claim.locus, protectLoci: [], exemptedElsewhere: false };
		if (row.writeLocus !== claim.locus) row.writeLocus = `${row.writeLocus} | ${claim.locus}`;
		for (const pin of pins) {
			if (!row.protectLoci.some((p) => p.pinId === pin.pinId)) {
				row.protectLoci.push({ pinId: pin.pinId, locus: pin.locus, statement: pin.statement });
			}
		}
		byPath.set(claim.path, row);
	}
	return { contradictions: [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path)), scanLines };
}

/** Render a Gate E contradiction as the two-locus mechanical finding (the
 *  replan routing payload — the finding IS the diagnosis; no judge call). */
export function entryContradictionFindingText(c: EntryContradiction): { title: string; detail: string } {
	const protectSide = c.protectLoci.slice(0, 3).map((p) => `${p.pinId} @ ${p.locus}: "${p.statement.slice(0, 140)}"`).join("; ");
	return {
		title: `plan contradiction (write×protect): ${c.path} is mandated written (@ ${c.writeLocus}) AND protected`,
		detail: `Write claim @ ${c.writeLocus} intersects the protection interval (immutability-class pins: ${protectSide}) and no amendmentFamily entry declares sharedFile=${c.path}. No executor quality resolves this — revise the spec: declare the amendment (sharedFile + pinsMoved/exemptions), drop the write, or drop the protection. (065 Gate E — deterministic; no judge call needed.)`,
	};
}

// ─── 065 D-F-D + D-F-F — the Stage-9-entry gate (cross-product + plan checks) ─

export interface EntryPlanPhase {
	name?: string;
	deliverables?: {
		requireFiles?: string[];
		requireContains?: Array<{ file: string; pattern: string }>;
		requireNotContains?: Array<{ file: string; pattern: string }>;
		requireTests?: string[];
		requireScenarios?: string[];
	};
}

export interface EntryGateFinding {
	title: string;
	detail: string;
	kind: "write-protect" | "forward-file-reference" | "unresolvable-scenario" | "uncovered-ac-write";
}

/**
 * The Stage-9-entry gate (065 §4.4 + §7 D-F-F): one deterministic pass over
 * the FRESH tree computing:
 *
 *  1. write×protect ∖ exemptions (Gate E proper — self-minted pins INCLUDED
 *     per D1; exemptions are file-level, the interval's semantics);
 *  2. D-F-F(a) forward-file-reference: a phase clause file that exists
 *     neither on disk nor in ANY phase's requireFiles (unsatisfiable), or is
 *     only a LATER phase's requireFiles output (forward reference);
 *  3. D-F-F(b) create-collision: DROPPED (grill round 1 B3) — phases run
 *     strictly sequentially, so two phases declaring the same NEW file is
 *     the canonical create-then-extend TDD handoff, not a conflict. No
 *     parallelism field exists to decide a real collision on;
 *  4. D-F-F(c) requireScenarios resolvability against the BDD scenario ids;
 *  5. D-F-F(d) AC write-coverage: every write-claim extracted from the
 *     requirements' acceptanceCriteria statements appears in some phase's
 *     write-set (phaseClauseFiles).
 *
 * Every finding names BOTH loci (the two-locus contract). P5: a gate failure
 * (unreadable tree) degrades to findings=[] with a scan line — never punishes
 * the work. P8: single pass, bounded per-collection caps.
 */
export function stage9EntryGate(input: {
	worktreePath: string | undefined;
	specDirectory: string | undefined;
	phases: EntryPlanPhase[];
	/** requirementsControl.acceptanceCriteria[].statement → AC write-claims. */
	requirementsControl: Record<string, unknown> | undefined;
	/** The BDD scenario id set (e.g. "SCENARIO-007"). */
	bddScenarioIds: ReadonlySet<string>;
	/** The rendered spec docs (09/10/11) — the caller reads them fresh. */
	docTexts: Array<{ text: string | undefined | null; locusPrefix: string }>;
}): { findings: EntryGateFinding[]; scanLines: string[] } {
	const findings: EntryGateFinding[] = [];
	const scanLines: string[] = [];
	if (!input.worktreePath || !existsSync(input.worktreePath)) return { findings, scanLines: ["gateE: absent worktree — entry gate skipped (DEC-5 fail-open)"] };

	// ── 1. Gate E proper: write×protect ∖ exemptions.
	let inventory: ContractInventory | null = null;
	try {
		inventory = extractContractInventory(input.worktreePath);
	} catch {
		scanLines.push("gateE: inventory extraction failed — cross-product skipped, fail-open (P5)");
	}
	if (inventory) {
		const claims: WriteClaim[] = [];
		const docClaims = extractWriteClaims(input.docTexts, "spec", inventory.mapping).claims;
		claims.push(...docClaims);
		// AC statements are write-claim evidence (D-F-F(d) input + Gate E input).
		const acs = Array.isArray(input.requirementsControl?.acceptanceCriteria)
			? (input.requirementsControl!.acceptanceCriteria as Array<{ statement?: unknown }>)
			: [];
		for (let i = 0; i < acs.length; i++) {
			const st = typeof acs[i]?.statement === "string" ? (acs[i].statement as string) : "";
			if (!st) continue;
			const { claims: acClaims } = extractWriteClaims([{ text: st, locusPrefix: `AC-${String(i + 1).padStart(2, "0")}` }], "requirements", inventory.mapping);
			claims.push(...acClaims);
		}
		// Phase requireFiles are explicit write claims (no extraction needed).
		input.phases.forEach((p, pi) => {
			for (const f of p?.deliverables?.requireFiles ?? []) {
				if (typeof f === "string" && f) claims.push({ path: (f.startsWith("./") ? f.slice(2) : f).replace(/\/+$/, ""), verb: "create", locus: `phase-${pi + 1}${p?.name ? ` (${p.name})` : ""}`, sourceStage: "spec" });
			}
		});
		const gateE = entryContradictions({ writeClaims: claims, inventory, specDirectory: input.specDirectory });
		scanLines.push(...gateE.scanLines);
		for (const c of gateE.contradictions) {
			const t = entryContradictionFindingText(c);
			findings.push({ kind: "write-protect", title: t.title, detail: t.detail });
		}
	}

	// ── 2. D-F-F: plan compile-time checks (typed-shape subset; the plan has
	// no dependsOn/parallel fields — the decidable checks only, P2-honest).
	const norm = (p: string): string => String(p ?? "").trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
	const requireSets = input.phases.map((p) => [...new Set((p?.deliverables?.requireFiles ?? []).filter((f) => typeof f === "string" && f).map(norm))]);
	const allProduced = new Set(requireSets.flat());
	const label = (p: EntryPlanPhase | undefined, i: number): string => p?.name?.trim() || `phase-${i + 1}`;
	// (a) forward-file-reference over clause files.
	input.phases.forEach((p, pi) => {
		const d = p?.deliverables;
		if (!d) return;
		const clauseFiles = new Set<string>();
		for (const e of [...(d.requireContains ?? []), ...(d.requireNotContains ?? [])]) if (e && typeof e.file === "string" && e.file) clauseFiles.add(norm(e.file));
		// NOTE: requireTests are EXCLUDED — the TDD flow authors the phase's own
		// RED files, so a declared requireTests file absent at entry is the NORM
		// (attempt-governor-plateau harness), never a forward reference. Only
		// content-clause targets (files whose CONTENT the deliverable pins) must
		// exist on disk or be a phase's requireFiles output.
		for (const file of clauseFiles) {
			const usable = claimPathUsable(file);
			if (!usable) continue;
			if (existsSync(join(input.worktreePath!, usable))) continue; // on disk — modifiable target
			if (requireSets[pi].includes(usable)) continue; // own phase creates it
			const producer = requireSets.findIndex((set, j) => j !== pi && set.includes(usable));
			if (producer === -1) {
				findings.push({
					kind: "forward-file-reference",
					title: `plan contradiction: ${label(p, pi)} clauses target ${usable} which exists neither on disk nor in any phase's requireFiles`,
					detail: `${label(p, pi)} declares a deliverable clause over ${usable}, but the file is absent at entry and no phase's requireFiles creates it — the clause is unsatisfiable. Create the file in ${label(p, pi)}'s requireFiles or fix the clause path. (065 D-F-F(a))`,
				});
			} else if (producer > pi) {
				findings.push({
					kind: "forward-file-reference",
					title: `plan contradiction: ${label(p, pi)} clauses target ${usable} which only LATER phase ${label(input.phases[producer], producer)} creates`,
					detail: `${label(p, pi)}'s clause over ${usable} runs before ${label(input.phases[producer], producer)} creates the file (forward reference). Merge the phases, move the clause, or move the creation earlier. (065 D-F-F(a))`,
				});
			}
		}
	});
	// (b) create-collision: DROPPED (grill round 1 B3) — phases execute
	// strictly sequentially (implementation.ts `for (const [idx, phase] of
	// phases.entries())`), so "phase A creates X, phase B extends X" in
	// requireFiles is the canonical, satisfiable TDD handoff, not a conflict.
	// The check banned a legal plan shape. Revisit ONLY when the plan grows a
	// parallel-groups field.
	// (c) requireScenarios resolvability.
	input.phases.forEach((p, pi) => {
		for (const s of p?.deliverables?.requireScenarios ?? []) {
			if (typeof s !== "string" || !s.trim()) continue;
			if (input.bddScenarioIds.has(s.trim())) continue;
			findings.push({
				kind: "unresolvable-scenario",
				title: `plan contradiction: ${label(p, pi)} requireScenarios cites ${s} which does not exist in the BDD`,
				detail: `${label(p, pi)}'s deliverable cites ${s}, but no BDD scenario carries that id — the deliverable check can never pass. Fix the id or add the scenario. (065 D-F-F(c))`,
			});
		}
	});
	// (d) AC write-coverage (uses the inventory-independent claim extraction —
	// concept mapping needs the inventory; reuse it when present, else skip).
	if (inventory) {
		const acs = Array.isArray(input.requirementsControl?.acceptanceCriteria)
			? (input.requirementsControl!.acceptanceCriteria as Array<{ statement?: unknown; id?: unknown }>)
			: [];
		const phaseWriteSet = new Set<string>();
		input.phases.forEach((p) => {
			const d = p?.deliverables;
			if (!d) return;
			for (const f of [...(d.requireFiles ?? []), ...(d.requireContains ?? []).map((e) => e?.file), ...(d.requireNotContains ?? []).map((e) => e?.file), ...(d.requireTests ?? [])]) {
				const usable = typeof f === "string" ? claimPathUsable(f) : null;
				if (usable) phaseWriteSet.add(usable);
			}
		});
		for (let i = 0; i < acs.length; i++) {
			const st = typeof acs[i]?.statement === "string" ? (acs[i].statement as string) : "";
			const id = typeof acs[i]?.id === "string" ? (acs[i].id as string) : `AC-${String(i + 1).padStart(2, "0")}`;
			if (!st) continue;
			const { claims } = extractWriteClaims([{ text: st, locusPrefix: id }], "requirements", inventory!.mapping);
			for (const c of claims) {
				if (phaseWriteSet.has(c.path)) continue;
				findings.push({
					kind: "uncovered-ac-write",
					title: `plan contradiction: ${id} mandates writing ${c.path} but NO phase's write-set covers it`,
					detail: `${id}'s statement mandates a change to ${c.path} (claim @ ${c.locus}), yet no phase's deliverables (requireFiles/requireContains/requireTests) target it — the AC can never be verified. Add the file to the owning phase's deliverables or fix the AC. (065 D-F-F(d))`,
				});
			}
		}
	}
	void allProduced;
	return { findings, scanLines };
}


