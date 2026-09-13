/**
 * 059 R1A D-R-A — Layer R1 contract-surface inventory (mechanical, single
 * source). docs/requirements/059-reviewer-quality-architecture.md §3 R1.
 *
 * A deterministic extractor walks each `<worktree>/docs/specifications/<spec>/`
 * artifacts plus the test suite and indexes baseline pins by protected file:
 * `inventory[protectedFile] → Array<{pinId, idiomFamily, locus(file:line),
 * owningSpec, resolutionState}>`. Detection is HYBRID (DEC-2): this module
 * produces candidates with loci; the LLM adjudicates. P4: purely mechanical
 * (regex/grammar tables), zero LLM, zero network.
 *
 * P6 (binding): the porcelain-emptiness TS/test form COMPOSES the landed
 * `scanImmutabilityIdioms` from src/stages/plan-feasibility.ts (058 P1 D-A)
 * and every path containment check goes through its exported `claimPathUsable`
 * — the regex/window/quote logic of that scanner is NEVER re-implemented here.
 * The OTHER grammar families' token extraction (exactly-N / no-Xth /
 * ownership) is NEW grammar (the §3 table's remaining columns) and lives only
 * in this module.
 *
 * Idiom grammar (059 §3 table, v1 scope — additions require a grammar-table
 * row + fixture pair):
 *
 * | Family             | TS/JS test form                                        | Python test form                    | Markdown/prose form                       |
 * |--------------------|--------------------------------------------------------|-------------------------------------|-------------------------------------------|
 * | porcelain-emptiness| scanImmutabilityIdioms (porcelain + toBe("")/wording)  | subprocess git + assert == ""       | "stays byte-untouched in git", "working tree clean for X" |
 * | exactly-N membership| toHaveLength(N) / expect(x.length).toBe(N) / .size    | len(X) == N / assertEqual(len(x),N) | "pinned at exactly N members", "closed set of N" |
 * | no-Xth closure     | not.toContain("x")                                     | assert "x" not in …                 | "no fifteenth module", "gains no new member" |
 * | ownership table    | exported OWNERSHIP_PINS/*_OWNERS compared verbatim     | dict-equality asserts               | "OWNER '14'", ownership-table rows        |
 *
 * Path-resolution rule (HIGH-3): a pin enters the inventory keyed by a
 * protected file ONLY via (a) a literal path token in the pinning statement
 * (backtick/quote-symmetric token, or a repo-rooted plain token), or (b) an
 * entry in repo-invariants.json `pins: Array<{protectedFile, pin, anchor}>`
 * (backwards-compatible envelope — the `protected` key keeps 058 P1's landed
 * plan-feasibility.ts validator working unchanged). Unresolvable pins are
 * listed in the slice header as `unanchored:` lines (P10 — never dropped).
 *
 * DEC-4: absent tree/suite ⇒ silent fail-open (empty inventory); an extraction
 * ERROR on an existing tree ⇒ fail-loud `[contract-inventory: extraction
 * failed — review slice incomplete]` banner carried by the slice.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { claimPathUsable, scanImmutabilityIdioms } from "../stages/plan-feasibility.ts";

// ─── types ───────────────────────────────────────────────────────────────────

/** The §3 grammar table's four v1 families (closed set). */
export type IdiomFamily = "porcelain-emptiness" | "exactly-n-membership" | "no-xth-closure" | "ownership-table";

/** Which column of the grammar table produced the pin. */
export type PinSourceForm = "ts-test" | "python-test" | "markdown-prose" | "repo-invariants";

/** One indexed baseline pin. */
export interface ContractPin {
	/** Deterministic stable id (minted from family+locus+statement). */
	pinId: string;
	idiomFamily: IdiomFamily;
	/** Locus of the pinning statement, repo-relative `file:line` (1-based). */
	locus: string;
	/** The artifact (spec doc or test file) that carries the pin. */
	owningSpec: string;
	/** `active` = keyed to a resolved protected file; `unanchored` = listed
	 *  in the slice header instead (P10). */
	resolutionState: "active" | "unanchored";
	/** Proof text: the matched statement (trimmed, bounded). */
	statement: string;
	via: PinSourceForm;
	/** Set when a repo-invariants.json pins[] entry supplied (or corroborated)
	 *  the anchoring — the envelope's backwards-compatibility trace. */
	declaredPin?: string;
	/** unanchored only: why the protected file could not be resolved. */
	unanchoredReason?: string;
}

export interface ContractInventory {
	/** protectedFile (normalized repo-relative) → pins (sorted by locus, pinId). */
	protectedFiles: Map<string, ContractPin[]>;
	/** Pins whose protected file could not be resolved (P10: listed, never dropped). */
	unanchored: ContractPin[];
	/** DEC-4 fail-loud extraction errors (existing tree, failed read/parse). */
	errors: string[];
	/** P10 scan visibility: one line per scanned source (file: N pin(s) / skipped). */
	scanLines: string[];
	/** repo-invariants.json `mapping`: shared concept → protectedFile[]. */
	mapping: Map<string, string[]>;
	/** repo-invariants.json `concepts`: the declared shared-concept vocabulary. */
	concepts: Set<string>;
	/** Counts for the reconciliation section. */
	counts: { specArtifacts: number; testFiles: number };
}

// ─── pinId minting (deterministic) ───────────────────────────────────────────

const FAMILY_CODE: Record<IdiomFamily, string> = {
	"porcelain-emptiness": "pe",
	"exactly-n-membership": "xn",
	"no-xth-closure": "nx",
	"ownership-table": "ot",
};

/** Stable, content-derived pin id: `pin-<family-code>-<base36 djb2>`. Same
 *  tree + same statement ⇒ same id (slice citations and the R4 exemption's
 *  pinId matching depend on this). */
export function mintPinId(family: IdiomFamily, locus: string, statement: string): string {
	let hash = 5381;
	const input = `${family}\u0000${locus}\u0000${statement}`;
	for (let i = 0; i < input.length; i++) hash = ((hash << 5) + hash) ^ input.charCodeAt(i);
	return `pin-${FAMILY_CODE[family]}-${(hash >>> 0).toString(36).padStart(7, "0")}`;
}

// ─── path-token extraction (the OTHER families' literal-token arm) ───────────

/** Repo-path-looking tokens (extension-bounded). New grammar for the
 *  exactly-N/no-Xth/ownership columns — the porcelain column reuses the
 *  landed scanner and never touches this. */
const PATH_TOKEN_RE = /[A-Za-z0-9_.\-/]+\.(?:ts|tsx|js|jsx|mjs|cjs|cts|mts|py|json|md|markdown|rs|go|toml|yaml|yml)\b/g;
/** Plain (unquoted) tokens count only when repo-rooted under a known source
 *  root — the HIGH-3 "literal path token" reading for prose/markdown. */
const REPO_ROOTED_PREFIX_RE = /^(?:\.\/)?(?:src|tests|test|lib|libs|docs|scripts|internal|pkg|cmd|__tests__)\//;

/** Literal path tokens in text[from..to]: backtick/quote-symmetric tokens
 *  (mirrors the porcelain scanner's symmetric-quote guard) ∪ repo-rooted
 *  plain tokens. Every token must survive claimPathUsable (P6). */
function literalPathTokens(text: string, from: number, to: number): string[] {
	const out: string[] = [];
	const seen = new Set<string>();
	const window = text.slice(Math.max(0, from), Math.min(text.length, to));
	PATH_TOKEN_RE.lastIndex = 0;
	for (let m = PATH_TOKEN_RE.exec(window); m !== null; m = PATH_TOKEN_RE.exec(window)) {
		const absIdx = Math.max(0, from) + m.index;
		const before = absIdx > 0 ? text[absIdx - 1] : "";
		const afterIdx = absIdx + m[0].length;
		const after = afterIdx < text.length ? text[afterIdx] : "";
		const symmetric = (before === '"' && after === '"') || (before === "'" && after === "'") || (before === "`" && after === "`");
		if (!symmetric && !REPO_ROOTED_PREFIX_RE.test(m[0])) continue;
		const usable = claimPathUsable(m[0]);
		if (usable && !seen.has(usable)) {
			seen.add(usable);
			out.push(usable);
		}
	}
	return out;
}

// ─── grammar scanners (per family × form) ────────────────────────────────────

interface RawHit {
	family: IdiomFamily;
	via: PinSourceForm;
	/** 1-based line of the pinning statement. */
	line: number;
	/** The pinning statement text (trimmed, bounded to ~200 chars). */
	statement: string;
	/** Candidate literal path tokens extracted from the statement window. */
	pathTokens: string[];
	/** The declared repo-invariants `pin` string this hit matched (if any). */
	declaredPin?: string;
}

const lineAt = (text: string, index: number): number => text.slice(0, index).split("\n").length;
const clampStatement = (s: string): string => {
	const t = s.replace(/\s+/g, " ").trim();
	return t.length > 200 ? `${t.slice(0, 197)}…` : t;
};

/** porcelain-emptiness, TS/JS test form — COMPOSES the landed scanner (P6). */
function scanPorcelainTs(_rel: string, text: string): RawHit[] {
	const hits = scanImmutabilityIdioms(text);
	return hits.map((h) => {
		const idx = text.indexOf(h.wording);
		const line = idx >= 0 ? lineAt(text, idx) : 1;
		return {
			family: "porcelain-emptiness" as const,
			via: "ts-test" as const,
			line,
			statement: clampStatement(h.wording),
			pathTokens: [h.path],
		};
	});
}

/** porcelain-emptiness, Python test form: `subprocess` git-status-porcelain
 *  call co-present with an `== ""` assertion (co-presence, like the TS form). */
const PY_PORCELAIN_LINE_RE = /(?:subprocess\.(?:run|check_output|check_call|Popen)\s*\(|os\.system\s*\()[^\n]*git[^\n]*status[^\n]*--porcelain/gi;
const PY_ASSERT_EMPTY_RE = /assert[^\n]*==\s*""|assertNotEqual\(\s*""[^\n]*,\s*""/g;

function scanPorcelainPy(text: string): RawHit[] {
	PY_PORCELAIN_LINE_RE.lastIndex = 0;
	const callIdxs: number[] = [];
	for (let m = PY_PORCELAIN_LINE_RE.exec(text); m !== null; m = PY_PORCELAIN_LINE_RE.exec(text)) callIdxs.push(m.index);
	if (callIdxs.length === 0) return [];
	PY_ASSERT_EMPTY_RE.lastIndex = 0;
	const asserts = [...text.matchAll(PY_ASSERT_EMPTY_RE)];
	if (asserts.length === 0) return [];
	const out: RawHit[] = [];
	for (const idx of callIdxs) {
		const line = lineAt(text, idx);
		const from = text.lastIndexOf("\n", idx) + 1;
		const nl = text.indexOf("\n", idx);
		const to = nl === -1 ? text.length : nl;
		out.push({
			family: "porcelain-emptiness",
			via: "python-test",
			line,
			statement: clampStatement(text.slice(from, to)),
			pathTokens: literalPathTokens(text, from - 200, to + 200),
		});
	}
	return out;
}

/** porcelain-emptiness, Markdown/prose form: "stays byte-untouched in git",
 *  "working tree clean for X". */
const MD_PORCELAIN_RE = /\b(?:stays?|remain[sd]?|must (?:stay|remain|be))\s+byte[-\s]?untouched\b|\bbyte[-\s]?untouched\s+in\s+git\b|\bworking\s+tree\s+(?:is\s+|stays?\s+)?clean\b|\b(?:is|are|remains?|stays?)\s+immutable\b/gi;

function scanPorcelainMd(text: string): RawHit[] {
	const out: RawHit[] = [];
	for (const m of text.matchAll(MD_PORCELAIN_RE)) {
		const line = lineAt(text, m.index);
		const from = text.lastIndexOf("\n", m.index) + 1;
		const nl = text.indexOf("\n", m.index);
		const to = nl === -1 ? text.length : nl;
		out.push({
			family: "porcelain-emptiness",
			via: "markdown-prose",
			line,
			statement: clampStatement(text.slice(from, to)),
			pathTokens: literalPathTokens(text, from - 200, to + 200),
		});
	}
	return out;
}

/** exactly-N membership, TS/JS test form: toHaveLength(N),
 *  expect(x.length).toBe(N), expect(set.size).toBe(N), toEqual([...N items]). */
function scanExactlyNTs(text: string): RawHit[] {
	const out: RawHit[] = [];
	const record = (index: number, statementText: string): void => {
		const line = lineAt(text, index);
		const from = text.lastIndexOf("\n", index) + 1;
		out.push({
			family: "exactly-n-membership",
			via: "ts-test",
			line,
			statement: clampStatement(statementText),
			pathTokens: literalPathTokens(text, from - 200, from + statementText.length + 200),
		});
	};
	for (const m of text.matchAll(/\.toHaveLength\(\s*(\d+)\s*\)/g)) {
		record(m.index, m[0].replace(/^\./, ""));
	}
	for (const m of text.matchAll(/expect\(\s*[\w$.]+\s*(?:\.\s*(?:length|size)\s*)?(?:,[^)\n]*)?\)\s*\.\s*toBe\(\s*(\d+)\s*\)/g)) {
		if (!/\.(?:length|size)\b/.test(m[0])) continue; // plain toBe(N) is not a membership pin
		record(m.index, m[0]);
	}
	// toEqual([...]) — count TOP-LEVEL items of the array literal (one scan,
	// depth-tracked; nested brackets/braces/parens never split an item).
	for (const m of text.matchAll(/\)\s*\.\s*toEqual\(\s*\[/g)) {
		const openIdx = m.index + m[0].length - 1; // the '['
		let depth = 0;
		let topCommas = 0;
		let sawContent = false;
		let closedAt = -1;
		for (let i = openIdx; i < text.length; i++) {
			const ch = text[i];
			if (ch === "[" || ch === "{" || ch === "(") {
				depth++;
			if (depth === 1) continue;
		} else if (ch === "]" || ch === "}" || ch === ")") {
				if (depth === 1 && ch === "]") {
				closedAt = i;
				break;
			}
				depth--;
				continue;
			}
			if (depth === 1) {
				if (ch === ",") topCommas++;
				else if (!/\s/.test(ch)) sawContent = true;
			}
		}
		if (closedAt === -1) continue; // unbalanced — not a pin
		const count = sawContent ? topCommas + 1 : 0;
		if (count > 0) record(m.index, clampStatement(text.slice(m.index, closedAt + 1)));
	}
	return out;
}

/** exactly-N membership, Python test form: len(X) == N / assertEqual(len(x), N). */
function scanExactlyNPy(text: string): RawHit[] {
	const out: RawHit[] = [];
	const res = [/assert\w*\s*\(?\s*len\(\s*[\w.]+\s*\)\s*(?:==|,)\s*(\d+)/g, /\blen\(\s*[\w.]+\s*\)\s*==\s*(\d+)/g];
	for (const re of res) {
		for (const m of text.matchAll(re)) {
			const line = lineAt(text, m.index);
			const from = text.lastIndexOf("\n", m.index) + 1;
			const nl = text.indexOf("\n", m.index);
			out.push({
				family: "exactly-n-membership",
				via: "python-test",
				line,
				statement: clampStatement(text.slice(from, nl === -1 ? undefined : nl)),
				pathTokens: literalPathTokens(text, from - 200, (nl === -1 ? text.length : nl) + 200),
			});
		}
	}
	return out;
}

/** exactly-N membership, Markdown/prose form: "pinned at exactly N members",
 *  "closed set of N". */
const MD_EXACTLY_N_RE = /\bpinned\s+at\s+exactly\s+(\d+)\s+(?:members?|modules?|entries|items|scenarios|phases|pins?)\b|\bclosed\s+set\s+of\s+(\d+)\b|\bexactly\s+(\d+)\s+(?:members?|modules?)\b/gi;

function scanExactlyNMd(text: string): RawHit[] {
	const out: RawHit[] = [];
	for (const m of text.matchAll(MD_EXACTLY_N_RE)) {
		const line = lineAt(text, m.index);
		const from = text.lastIndexOf("\n", m.index) + 1;
		const nl = text.indexOf("\n", m.index);
		out.push({
			family: "exactly-n-membership",
			via: "markdown-prose",
			line,
			statement: clampStatement(text.slice(from, nl === -1 ? undefined : nl)),
			pathTokens: literalPathTokens(text, from - 200, (nl === -1 ? text.length : nl) + 200),
		});
	}
	return out;
}

/** no-Xth closure, TS/JS test form: missing-member assertions. */
const TS_NO_XTH_RE = /not\s*\.\s*toContain\(\s*["'`]([^"'`\n]+)["'`]\s*\)/g;

function scanNoXthTs(text: string): RawHit[] {
	const out: RawHit[] = [];
	for (const m of text.matchAll(TS_NO_XTH_RE)) {
		const line = lineAt(text, m.index);
		const from = text.lastIndexOf("\n", m.index) + 1;
		const nl = text.indexOf("\n", m.index);
		out.push({
			family: "no-xth-closure",
			via: "ts-test",
			line,
			statement: clampStatement(text.slice(from, nl === -1 ? undefined : nl)),
			pathTokens: literalPathTokens(text, from - 200, (nl === -1 ? text.length : nl) + 200),
		});
	}
	return out;
}

/** no-Xth closure, Python test form: assert "x" not in … */
const PY_NO_XTH_RE = /assert\s+["']([^"'\n]+)["']\s+not\s+in\b/g;

function scanNoXthPy(text: string): RawHit[] {
	const out: RawHit[] = [];
	for (const m of text.matchAll(PY_NO_XTH_RE)) {
		const line = lineAt(text, m.index);
		const from = text.lastIndexOf("\n", m.index) + 1;
		const nl = text.indexOf("\n", m.index);
		out.push({
			family: "no-xth-closure",
			via: "python-test",
			line,
			statement: clampStatement(text.slice(from, nl === -1 ? undefined : nl)),
			pathTokens: literalPathTokens(text, from - 200, (nl === -1 ? text.length : nl) + 200),
		});
	}
	return out;
}

/** no-Xth closure, Markdown/prose form: "no fifteenth module", "gains no new
 *  member". */
const MD_NO_XTH_RE = /\bno\s+(?:\d+(?:st|nd|rd|th)|[a-z]+th)\s+(?:module|member|entry|item|scenario|phase)s?\b|\bgains?\s+no\s+new\s+(?:module|member|entry|item)s?\b/gi;

function scanNoXthMd(text: string): RawHit[] {
	const out: RawHit[] = [];
	for (const m of text.matchAll(MD_NO_XTH_RE)) {
		const line = lineAt(text, m.index);
		const from = text.lastIndexOf("\n", m.index) + 1;
		const nl = text.indexOf("\n", m.index);
		out.push({
			family: "no-xth-closure",
			via: "markdown-prose",
			line,
			statement: clampStatement(text.slice(from, nl === -1 ? undefined : nl)),
			pathTokens: literalPathTokens(text, from - 200, (nl === -1 ? text.length : nl) + 200),
		});
	}
	return out;
}

/** ownership-table identifiers (the exported OWNERSHIP_PINS / *_OWNERS family). */
const OWNERS_IDENT_RE = /\b([A-Z][A-Z0-9_]*(?:OWNERSHIP_PINS|_OWNERS|OWNERS_TABLE))\b/;

/** ownership table, TS/JS test form: (1) an EXPORT of an ownership table —
 *  the pin's own file is the protected file (self-anchor, documented v1
 *  reading); (2) a verbatim comparison `expect(IDENT).toEqual(` — resolved
 *  via the statement-window token / repo-invariants rule. */
function scanOwnershipTs(rel: string, text: string): RawHit[] {
	const out: RawHit[] = [];
	for (const m of text.matchAll(/export\s+(?:const|let|var)\s+([A-Z][A-Z0-9_]*)\b/g)) {
		if (!OWNERS_IDENT_RE.test(m[1])) continue;
		const line = lineAt(text, m.index);
		out.push({
			family: "ownership-table",
			via: "ts-test",
			line,
			statement: clampStatement(m[0]),
			// self-anchor: the file carrying the exported table IS the protected file
			pathTokens: [rel],
		});
	}
	for (const m of text.matchAll(/expect\(\s*([A-Z][A-Z0-9_]*)\s*\)\s*\.\s*toEqual\(/g)) {
		if (!OWNERS_IDENT_RE.test(m[1])) continue;
		const line = lineAt(text, m.index);
		const from = text.lastIndexOf("\n", m.index) + 1;
		const nl = text.indexOf("\n", m.index);
		out.push({
			family: "ownership-table",
			via: "ts-test",
			line,
			statement: clampStatement(text.slice(from, nl === -1 ? undefined : nl)),
			pathTokens: literalPathTokens(text, from - 200, (nl === -1 ? text.length : nl) + 200),
		});
	}
	return out;
}

/** ownership table, Python test form: dict-equality asserts over an OWNERS
 * identifier. */
function scanOwnershipPy(text: string): RawHit[] {
	const out: RawHit[] = [];
	for (const m of text.matchAll(/(?:assert\w*|self\.assert\w+)\s*\(?\s*([A-Z][A-Z0-9_]*)\s*(?:==|,)/g)) {
		if (!OWNERS_IDENT_RE.test(m[1])) continue;
		const line = lineAt(text, m.index);
		const from = text.lastIndexOf("\n", m.index) + 1;
		const nl = text.indexOf("\n", m.index);
		out.push({
			family: "ownership-table",
			via: "python-test",
			line,
			statement: clampStatement(text.slice(from, nl === -1 ? undefined : nl)),
			pathTokens: literalPathTokens(text, from - 200, (nl === -1 ? text.length : nl) + 200),
		});
	}
	return out;
}

/** ownership table, Markdown/prose form: OWNER '14' / ownership-table rows. */
const MD_OWNERSHIP_RE = /\bOWNER\s+['"`]([^'"`\n]+)['"`]/g;
const MD_OWNERSHIP_ROW_RE = /^\s*\|\s*\d{1,3}[-–][a-z0-9][^|]*\|[^|]*\bowner\b[^\n]*$/gim;

function scanOwnershipMd(text: string): RawHit[] {
	const out: RawHit[] = [];
	for (const re of [MD_OWNERSHIP_RE, MD_OWNERSHIP_ROW_RE]) {
		for (const m of text.matchAll(re)) {
			const line = lineAt(text, m.index);
			const from = text.lastIndexOf("\n", m.index) + 1;
			const nl = text.indexOf("\n", m.index);
			out.push({
				family: "ownership-table",
				via: "markdown-prose",
				line,
				statement: clampStatement(text.slice(from, nl === -1 ? undefined : nl)),
				pathTokens: literalPathTokens(text, from - 200, (nl === -1 ? text.length : nl) + 200),
			});
		}
	}
	return out;
}

// ─── traversal (deterministic order; bounded) ────────────────────────────────

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "coverage", ".venv", "venv", "__pycache__", ".pi", ".cache", "target", ".next", "out"]);
/** P8 bound: cap scanned files per extraction (a pathological tree degrades
 *  with a P10 line, never hangs a review dispatch). */
const MAX_SCAN_FILES = 2000;

const isTsFamily = (p: string): boolean => /\.(?:ts|tsx|js|jsx|mjs|cjs|cts|mts)$/i.test(p);
const isPyFamily = (p: string): boolean => /\.py$/i.test(p);
const isMdFamily = (p: string): boolean => /\.(?:md|markdown)$/i.test(p);
const isTestFamily = (p: string): boolean => /(^|\/)(tests?|__tests__|spec)\//i.test(p) || /\.(?:test|spec)\.[cm]?[jt]sx?$/i.test(p) || /(^|\/)(test_[^/]+|[^/]+_test)\.py$/i.test(p);

/** Deterministic recursive listing: depth-first, entries sorted by name. */
function walkSorted(root: string, rel: string, out: string[], budget: { left: number }): void {
	if (budget.left <= 0) return;
	let entries: string[];
	try {
		entries = readdirSync(join(root, rel)).sort();
	} catch {
		return; // unreadable dir — absent-tree fail-open (DEC-4)
	}
	for (const name of entries) {
		if (budget.left <= 0) return;
		const relPath = rel ? `${rel}/${name}` : name;
		let isDir: boolean;
		try {
			isDir = statSync(join(root, relPath)).isDirectory();
		} catch {
			continue;
		}
		if (isDir) {
			if (SKIP_DIRS.has(name)) continue;
			walkSorted(root, relPath, out, budget);
		} else {
			out.push(relPath);
			budget.left--;
		}
	}
}

/** Scan one source file's text with the grammar-table column matching its
 *  family. Pure: never throws (a scanner failure is a DEC-4 error line). */
export function scanSourceFile(rel: string, text: string, kind: "ts" | "py" | "md"): RawHit[] {
	try {
		if (kind === "ts") return [...scanPorcelainTs(rel, text), ...scanExactlyNTs(text), ...scanNoXthTs(text), ...scanOwnershipTs(rel, text)];
		if (kind === "py") return [...scanPorcelainPy(text), ...scanExactlyNPy(text), ...scanNoXthPy(text), ...scanOwnershipPy(text)];
		return [...scanPorcelainMd(text), ...scanExactlyNMd(text), ...scanNoXthMd(text), ...scanOwnershipMd(text)];
	} catch {
		return [];
	}
}

// ─── repo-invariants.json envelope (backwards-compatible) ────────────────────

interface DeclaredPin { protectedFile: string; pin: string; anchor?: string }

function loadRepoInvariants(worktreePath: string, out: { declaredPins: DeclaredPin[]; mapping: Map<string, string[]>; concepts: Set<string>; errors: string[] }): void {
	const abs = join(worktreePath, "repo-invariants.json");
	if (!existsSync(abs)) return; // optional — absent = skipped silently (058 P1 contract)
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(abs, "utf8"));
	} catch {
		out.errors.push("repo-invariants.json: present but unparseable — pin anchors unavailable");
		return;
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		out.errors.push("repo-invariants.json: malformed envelope (expected {protected: string[], pins?: [...]}) — pin anchors unavailable");
		return;
	}
	const obj = parsed as { protected?: unknown; pins?: unknown; mapping?: unknown; concepts?: unknown };
	// `protected` is consumed by plan-feasibility Check 3 (058 P1) — the
	// inventory only notes it (it carries no pin statement to index).
	if (obj.protected !== undefined && !(Array.isArray(obj.protected) && obj.protected.every((p) => typeof p === "string"))) {
		out.errors.push("repo-invariants.json: 'protected' is not string[] — Check 3 will report this too");
	}
	if (Array.isArray(obj.pins)) {
		for (const entry of obj.pins) {
			const e = entry as { protectedFile?: unknown; pin?: unknown; anchor?: unknown } | null;
			if (!e || typeof e !== "object" || typeof e.protectedFile !== "string" || typeof e.pin !== "string" || !e.protectedFile.trim() || !e.pin.trim()) {
				out.errors.push("repo-invariants.json: malformed pins[] entry (expected {protectedFile, pin, anchor?}) — entry skipped");
				continue;
			}
			const usable = claimPathUsable(e.protectedFile);
			if (!usable) continue;
			out.declaredPins.push({ protectedFile: usable, pin: e.pin, anchor: typeof e.anchor === "string" && e.anchor.trim() ? e.anchor : undefined });
		}
	}
	if (obj.mapping && typeof obj.mapping === "object" && !Array.isArray(obj.mapping)) {
		for (const [concept, files] of Object.entries(obj.mapping as Record<string, unknown>)) {
			if (!Array.isArray(files)) continue;
			const usable = files.filter((f): f is string => typeof f === "string").map(claimPathUsable).filter((f): f is string => f !== null);
			out.mapping.set(concept, usable);
		}
	}
	if (Array.isArray(obj.concepts)) {
		for (const c of obj.concepts) if (typeof c === "string" && c.trim()) out.concepts.add(c);
	}
}

// ─── the extractor ───────────────────────────────────────────────────────────

/** Deterministic contract-surface extraction: one walk, one inventory. Same
 *  tree ⇒ same inventory (sorted traversal, sorted pin lists). Reads are
 *  FRESH per call — no cache between stages (059 §3 R1). */
export function extractContractInventory(worktreePath: string): ContractInventory {
	const inventory: ContractInventory = {
		protectedFiles: new Map(),
		unanchored: [],
		errors: [],
		scanLines: [],
		mapping: new Map(),
		concepts: new Set(),
		counts: { specArtifacts: 0, testFiles: 0 },
	};
	const inv = { declaredPins: [] as DeclaredPin[], mapping: inventory.mapping, concepts: inventory.concepts, errors: inventory.errors };
	try {
		loadRepoInvariants(worktreePath, inv);
	} catch (err) {
		inventory.errors.push(`repo-invariants.json: read failed — ${err instanceof Error ? err.message : String(err)}`);
	}

	// Source list: docs/specifications/**/*.md + test-family files under the
	// worktree (node_modules & co. skipped; P8 file cap; sorted = deterministic).
	const budget = { left: MAX_SCAN_FILES };
	const all: string[] = [];
	try {
		walkSorted(worktreePath, "", all, budget);
	} catch (err) {
		inventory.errors.push(`worktree walk failed — ${err instanceof Error ? err.message : String(err)}`);
		return inventory;
	}
	if (budget.left <= 0) inventory.errors.push(`scan cap reached (${MAX_SCAN_FILES} files) — inventory incomplete (P8 bound)`);
	const specArtifacts = all.filter((p) => p.startsWith("docs/specifications/") && isMdFamily(p));
	const testFiles = all.filter((p) => isTestFamily(p) && (isTsFamily(p) || isPyFamily(p)));

	const rawHits: Array<RawHit & { owningSpec: string }> = [];
	for (const rel of [...specArtifacts, ...testFiles]) {
		const kind: "ts" | "py" | "md" = isTsFamily(rel) ? "ts" : isPyFamily(rel) ? "py" : "md";
		let text: string;
		try {
			text = readFileSync(join(worktreePath, rel), "utf8");
		} catch (err) {
			// DEC-4: the tree exists but the read failed — fail-loud error line.
			inventory.errors.push(`${rel}: unreadable — not scanned (${err instanceof Error ? err.message : String(err)})`);
			continue;
		}
		const hits = scanSourceFile(rel, text, kind);
		if (kind === "md") inventory.counts.specArtifacts++;
		else inventory.counts.testFiles++;
		inventory.scanLines.push(`${rel}: ${hits.length} pin(s)`);
		for (const h of hits) rawHits.push({ ...h, owningSpec: rel });
	}

	// Resolution: literal token first (HIGH-3 arm a), then a declared
	// repo-invariants pin whose `pin` text appears in the statement (arm b).
	const declaredUnused = new Set(inv.declaredPins);
	const addPin = (pin: ContractPin, protectedFile: string | null): void => {
		if (protectedFile) {
			const arr = inventory.protectedFiles.get(protectedFile) ?? [];
			arr.push(pin);
			inventory.protectedFiles.set(protectedFile, arr);
		} else {
			inventory.unanchored.push(pin);
		}
	};
	for (const hit of rawHits) {
		const locus = `${hit.owningSpec}:${hit.line}`;
		const pinId = mintPinId(hit.family, locus, hit.statement);
		const pin: ContractPin = {
			pinId,
			idiomFamily: hit.family,
			locus,
			owningSpec: hit.owningSpec,
			resolutionState: "active",
			statement: hit.statement,
			via: hit.via,
		};
		let protectedFile = hit.pathTokens.length > 0 ? hit.pathTokens[0] : null;
		if (!protectedFile) {
			const declared = inv.declaredPins.find((d) => hit.statement.includes(d.pin) || pinId === d.pin);
			if (declared) {
				protectedFile = declared.protectedFile;
				// The envelope supplied the anchoring — provenance is the envelope,
				// not the scanner form (honest via; P10/P6).
				pin.via = "repo-invariants";
				pin.declaredPin = declared.pin;
				declaredUnused.delete(declared);
			}
		} else {
			for (const d of inv.declaredPins) if (d.protectedFile === protectedFile && hit.statement.includes(d.pin)) { pin.declaredPin = d.pin; declaredUnused.delete(d); }
		}
		if (protectedFile) {
			addPin(pin, protectedFile);
		} else {
			pin.resolutionState = "unanchored";
			pin.unanchoredReason = "no literal path token in the pinning statement and no matching repo-invariants.json pins[] entry";
			addPin(pin, null);
		}
	}
	// Declared pins never matched by a scanned statement: anchor them directly
	// (the file must exist and contain the pin text), else honest `unanchored:`.
	for (const d of declaredUnused) {
		const pin: ContractPin = {
			pinId: mintPinId("porcelain-emptiness", `repo-invariants.json:${d.protectedFile}`, d.pin),
			idiomFamily: "porcelain-emptiness",
			locus: d.anchor ?? "repo-invariants.json",
			owningSpec: d.anchor ?? "repo-invariants.json",
			resolutionState: "active",
			statement: clampStatement(d.pin),
			via: "repo-invariants",
		};
		let anchored = false;
		if (d.anchor) {
			const anchorRel = claimPathUsable(d.anchor);
			if (anchorRel && existsSync(join(worktreePath, anchorRel))) {
				try {
					const text = readFileSync(join(worktreePath, anchorRel), "utf8");
					const idx = text.indexOf(d.pin);
					if (idx >= 0) {
						pin.locus = `${anchorRel}:${lineAt(text, idx)}`;
						pin.owningSpec = anchorRel;
						anchored = true;
					}
				} catch { /* unreadable anchor — unanchored below */ }
			}
		}
		if (anchored) {
			addPin(pin, d.protectedFile);
		} else {
			pin.resolutionState = "unanchored";
			pin.unanchoredReason = d.anchor ? `declared pin not found in anchor ${d.anchor}` : "declared pin carries no anchor";
			addPin(pin, null);
		}
	}

	// Deterministic pin order per protected file (locus, then pinId).
	for (const arr of inventory.protectedFiles.values()) arr.sort((a, b) => a.locus === b.locus ? a.pinId.localeCompare(b.pinId) : a.locus.localeCompare(b.locus));
	inventory.unanchored.sort((a, b) => a.locus.localeCompare(b.locus) || a.pinId.localeCompare(b.pinId));
	return inventory;
}

// ─── Layer R2 slice construction (deterministic injection) ───────────────────

/** W1/grill R6 MED-2 caps: at most 15 pins / 60 lines per injected slice. */
export const CONTRACT_SLICE_MAX_PINS = 15;
export const CONTRACT_SLICE_MAX_LINES = 60;
export const CONTRACT_SLICE_TRUNCATION_MARKER = "[contract-inventory: slice truncated at 15 pins; see repo-invariants.json]";
export const CONTRACT_INVENTORY_ERROR_BANNER = "[contract-inventory: extraction failed — review slice incomplete]";

export interface ContractSlice {
	/** True ⇒ callers OMIT the section entirely (W1: zero noise). */
	empty: boolean;
	/** The rendered markdown block (header + `unanchored:`/`unmapped-concept:`
	 *  lines + truncation marker), bounded by the caps. */
	block: string;
	/** Total pins in the touched slice BEFORE the cap. */
	pinCount: number;
	truncated: boolean;
	/** Known shared concepts named in the texts with no mapping entry
	 *  (honest gap — never a silent empty slice). */
	unmappedConcepts: string[];
	/** The touched protected files (normalized keys), in slice order. */
	files: string[];
	/** The pinIds present in the slice (cap-excluded ones are honest losses
	 *  covered by the truncation marker). */
	pinIds: string[];
}

/** Touched-set algorithm (059 §3 R2/MED-1): inventory keys appearing as a
 *  literal path/backtick token in the evaluated texts ∪ mapping[concept] for
 *  a concept named in the texts. */
export function touchedProtectedFiles(inventory: ContractInventory, texts: Array<string | undefined | null>): { files: string[]; unmappedConcepts: string[] } {
	const corpus = texts.filter((t): t is string => typeof t === "string" && t.length > 0).join("\n");
	const touched = new Set<string>();
	if (corpus) {
		for (const key of inventory.protectedFiles.keys()) {
			if (new RegExp(`(?<![\\w/])${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w/])`).test(corpus)) touched.add(key);
		}
	}
	const unmappedConcepts: string[] = [];
	for (const concept of inventory.concepts) {
		if (!new RegExp(`(?<![\\w-])${concept.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w-])`, "i").test(corpus)) continue;
		const mapped = inventory.mapping.get(concept);
		if (mapped && mapped.length > 0) for (const f of mapped) touched.add(f);
		else if (!unmappedConcepts.includes(concept)) unmappedConcepts.push(concept);
	}
	return { files: [...touched].sort(), unmappedConcepts };
}

/** Build the deterministic contract-surface slice for prompt injection.
 *  Empty touched-set (and no errors/unmapped concepts) ⇒ `empty: true` —
 *  the caller omits the section (W1 zero-noise rule). */
export function buildContractSlice(input: { inventory: ContractInventory; texts: Array<string | undefined | null> }): ContractSlice {
	const { files, unmappedConcepts } = touchedProtectedFiles(input.inventory, input.texts);
	const errors = input.inventory.errors;
	const empty = files.length === 0 && unmappedConcepts.length === 0 && errors.length === 0;
	const pinIds: string[] = [];
	const lines: string[] = ["## Contract Surface Slice — shared baseline pins this change may touch"];
	if (errors.length > 0) {
		// DEC-4 fail-loud banner: an extraction error on an existing tree must
		// never silently shrink the review inputs.
		lines.push(CONTRACT_INVENTORY_ERROR_BANNER, ...errors.slice(0, 4).map((e) => `- extraction: ${e}`));
	}
	let rendered = 0;
	for (const file of files) {
		if (lines.length >= CONTRACT_SLICE_MAX_LINES - 1) break;
		const pins = input.inventory.protectedFiles.get(file) ?? [];
		for (const pin of pins) {
			if (rendered >= CONTRACT_SLICE_MAX_PINS || lines.length >= CONTRACT_SLICE_MAX_LINES - 1) break;
			lines.push(`- ${file}: ${pin.pinId} ${pin.idiomFamily} @ ${pin.locus} — ${pin.statement}`);
			pinIds.push(pin.pinId);
			rendered++;
		}
	}
	const totalPins = files.reduce((n, f) => n + (input.inventory.protectedFiles.get(f)?.length ?? 0), 0);
	for (const pin of input.inventory.unanchored) {
		if (lines.length >= CONTRACT_SLICE_MAX_LINES - 1) break;
		lines.push(`unanchored: ${pin.pinId} "${pin.statement}" @ ${pin.locus} — ${pin.unanchoredReason ?? "unresolved"}`);
	}
	for (const concept of unmappedConcepts) {
		if (lines.length >= CONTRACT_SLICE_MAX_LINES - 1) break;
		lines.push(`unmapped-concept: ${concept}`);
	}
	let truncated = totalPins > rendered;
	if (lines.length > CONTRACT_SLICE_MAX_LINES - 1) truncated = true;
	let blockLines = lines;
	if (truncated) {
		blockLines = [...lines.slice(0, CONTRACT_SLICE_MAX_LINES - 1), CONTRACT_SLICE_TRUNCATION_MARKER];
	}
	return { empty, block: empty ? "" : blockLines.join("\n"), pinCount: totalPins, truncated, unmappedConcepts, files, pinIds };
}

// ─── reconciliation (D-R-E: the engine-written spec-review section) ──────────

export interface NormalizedAmendmentFamilyEntry {
	sharedFile: string;
	pinsMoved: string[];
	exemptions: Array<{ pinId: string; justification: string }>;
	docUpdates: string[];
}

/** Tolerant control-shape reader for amendmentFamily (unknown LLM JSON in). */
export function normalizeAmendmentFamily(raw: unknown): { entries: NormalizedAmendmentFamilyEntry[]; malformed: string[] } {
	const entries: NormalizedAmendmentFamilyEntry[] = [];
	const malformed: string[] = [];
	if (raw === undefined || raw === null) return { entries, malformed };
	if (!Array.isArray(raw)) {
		malformed.push("amendmentFamily must be a JSON array of {sharedFile, pinsMoved, exemptions, docUpdates}");
		return { entries, malformed };
	}
	raw.forEach((entry, i) => {
		const e = entry as { sharedFile?: unknown; pinsMoved?: unknown; exemptions?: unknown; docUpdates?: unknown } | null;
		if (!e || typeof e !== "object") {
			malformed.push(`amendmentFamily[${i}]: not an object`);
			return;
		}
		const sharedFile = typeof e.sharedFile === "string" ? claimPathUsable(e.sharedFile) : null;
		if (!sharedFile) {
			malformed.push(`amendmentFamily[${i}]: sharedFile must be a non-empty repo-relative path`);
			return;
		}
		const strArr = (v: unknown): string[] => Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && !!x.trim()) : [];
		const exemptions = Array.isArray(e.exemptions)
			? e.exemptions.map((x) => x as { pinId?: unknown; justification?: unknown })
				.filter((x) => x && typeof x === "object")
				.map((x) => ({ pinId: typeof x.pinId === "string" ? x.pinId : "", justification: typeof x.justification === "string" ? x.justification : "" }))
			: [];
		entries.push({ sharedFile, pinsMoved: strArr(e.pinsMoved), exemptions, docUpdates: strArr(e.docUpdates) });
	});
	return { entries, malformed };
}

/** The deterministic cross-check result rendered into the spec-review doc
 *  (059 §3 R3 spec-reviewer duty): inventory summary + the family set-
 *  inclusion verdict D2's pass/fail must cite. Pure; never throws. */
export function contractInventoryReconciliationSection(
	inventory: ContractInventory,
	declaredFamily: NormalizedAmendmentFamilyEntry[] | undefined,
	mismatches: string[],
): string {
	const pinTotal = [...inventory.protectedFiles.values()].reduce((n, arr) => n + arr.length, 0);
	if (pinTotal === 0 && !declaredFamily?.length) return "";
	const lines = [
		"## Contract Inventory Reconciliation (engine-written — deterministic cross-check; D2 must cite this)",
		`- scanned sources: ${inventory.counts.specArtifacts} spec artifact(s), ${inventory.counts.testFiles} test file(s)`,
		`- inventory pins: ${pinTotal} across ${inventory.protectedFiles.size} protected file(s); unanchored: ${inventory.unanchored.length}`,
	];
	if (inventory.unanchored.length > 0) {
		for (const pin of inventory.unanchored.slice(0, 6)) lines.push(`  - unanchored: ${pin.pinId} @ ${pin.locus} — ${pin.unanchoredReason ?? "unresolved"}`);
		if (inventory.unanchored.length > 6) lines.push(`  - …(+${inventory.unanchored.length - 6} more unanchored pin(s) — see repo-invariants.json)`);
	}
	appendDeclaredFamilyRows(declaredFamily, lines);
	if (mismatches.length === 0) {
		lines.push(declaredFamily?.length ? "- set-inclusion: OK — declared amendmentFamily covers every inventory pin on the touched shared surfaces" : "- set-inclusion: (no family declared; no touched-surface pins to cover)");
	} else {
		lines.push("- set-inclusion: MISMATCH — declared amendmentFamily does NOT cover every inventory pin on the touched shared surfaces:");
		for (const m of mismatches.slice(0, 10)) lines.push(`  - ${m}`);
		if (mismatches.length > 10) lines.push(`  - …(+${mismatches.length - 10} more — see the convergence findings)`);
	}
	return lines.join("\n");
}

function appendDeclaredFamilyRows(declaredFamily: NormalizedAmendmentFamilyEntry[] | undefined, lines: string[]): void {
	if (!declaredFamily || declaredFamily.length === 0) {
		lines.push("- declared amendment family: (none declared)");
		return;
	}
	lines.push(`- declared amendment family: ${declaredFamily.length} entr${declaredFamily.length === 1 ? "y" : "ies"}`);
	for (const f of declaredFamily.slice(0, 8)) {
		lines.push(`  - ${f.sharedFile}: pinsMoved=[${f.pinsMoved.join(", ")}] exemptions=[${f.exemptions.map((e) => `${e.pinId}${e.justification ? "" : " (EMPTY justification)"}`).join(", ")}] docUpdates=[${f.docUpdates.join(", ")}]`);
	}
	if (declaredFamily.length > 8) lines.push(`  - …(+${declaredFamily.length - 8} more entr${declaredFamily.length - 8 === 1 ? "y" : "ies"})`);
}

// ─── write-time slice plumbing (W1) ──────────────────────────────────────

/** Compute a stage's write-time slice (059 §3 W1): fresh inventory walk + the
 *  touched-set over the evaluated texts (task + classify + upstream control
 *  JSON for 2B; upstream artifacts for later stages). Returns null when the
 *  worktree is absent or the walk itself failed (DEC-4 absent-tree
 *  fail-open — the injection is simply omitted). */
export function writerContractSlice(worktreePath: string | undefined, texts: Array<string | undefined | null>): ContractSlice | null {
	if (!worktreePath) return null;
	try {
		const inventory = extractContractInventory(worktreePath);
		return buildContractSlice({ inventory, texts });
	} catch {
		return null;
	}
}

const SLICE_STAMP_PREFIX = "__contractSlice:";

/** An all-empty slice view (validators use it when no context is available —
 *  every check no-ops, fail-open harmless). */
export const EMPTY_CONTRACT_SLICE: ContractSlice = { empty: true, block: "", pinCount: 0, truncated: false, unmappedConcepts: [], files: [], pinIds: [] };

export interface ContractSliceStamp {
	files: Set<string>;
	pinIds: Set<string>;
	/** The inventory the slice derived from (same-process reuse: the stage's
	 *  writer computed it this round; validators must not re-walk). */
	inventory?: ContractInventory;
}

/** Stamp a stage's slice identity on the pipeline state (the R4 exemption's
 *  `injectedSlice` source — the review loop reads what the writer saw). */
export function stampContractSlice(state: Record<string, unknown>, stage: string, slice: ContractSlice, inventory?: ContractInventory): void {
	state[`${SLICE_STAMP_PREFIX}${stage}`] = { files: slice.files, pinIds: slice.pinIds, ...(inventory ? { inventory } : {}) };
}

/** Read a stage's stamped slice identity (absent on pre-W/resume replays —
 *  callers treat that as no exemption eligibility, fail-closed harmless). */
export function readContractSliceStamp(state: Record<string, unknown>, stage: string): ContractSliceStamp | undefined {
	const v = state[`${SLICE_STAMP_PREFIX}${stage}`] as { files?: unknown; pinIds?: unknown; inventory?: ContractInventory } | undefined;
	if (!v || !Array.isArray(v.files) || !Array.isArray(v.pinIds)) return undefined;
	return { files: new Set(v.files as string[]), pinIds: new Set(v.pinIds as string[]), inventory: v.inventory };
}

/** A minimal slice VIEW over a stamp (validators only need .files). */
export function contractSliceView(stamp: ContractSliceStamp | undefined): ContractSlice {
	if (!stamp) return EMPTY_CONTRACT_SLICE;
	return { empty: stamp.files.size === 0, block: "", pinCount: stamp.pinIds.size, truncated: false, unmappedConcepts: [], files: [...stamp.files], pinIds: [...stamp.pinIds] };
}
