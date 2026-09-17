/**
 * contract-surface — the 12 grammar scanners (4 families × ts/py/md forms) and scanSourceFile. Exports PROTECT_QUALIFIER_RE (single spelling, shared with claim-spine). Layer doctrine: ./types.ts.
 */
import { scanImmutabilityIdiomsWithRejects, isUsableProtectedToken } from "../../stages/plan-feasibility.ts";
import { literalPathTokens, windowTokenRejects } from "./tokens.ts";
import type { IdiomFamily, PinSourceForm } from "./types.ts";

// ─── grammar scanners (per family × form) ────────────────────────────────────

export interface RawHit {
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

export const lineAt = (text: string, index: number): number => text.slice(0, index).split("\n").length;
export const clampStatement = (s: string): string => {
	const t = s.replace(/\s+/g, " ").trim();
	return t.length > 200 ? `${t.slice(0, 197)}…` : t;
};

/** porcelain-emptiness, TS/JS test form — COMPOSES the landed scanner (P6).
 *  065 grill F-4 residual hole: the OLD silent-dropping scanner fed the raw
 *  pathspec (`${wiredFile}`) straight into pathTokens — the phantom entered
 *  the inventory HERE, not via literalPathTokens. Compose the WithRejects
 *  arm and reject unusable pathspecs loudly. */
function scanPorcelainTs(_rel: string, text: string): RawHit[] {
	const { hits: scanned, rejects } = scanImmutabilityIdiomsWithRejects(text);
	for (const r of rejects) if (!windowTokenRejects.includes(r)) windowTokenRejects.push(r);
	const hits = scanned.filter((h) => isUsableProtectedToken(h.path));
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

/** porcelain-emptiness, Markdown/prose form — THE protect-qualifier
 *  grammar, single spelling (P6/065 A2): claim-spine imports this for
 *  classifySegment, so md-prose protections in "pins X byte-untouched" /
 *  "never touching" / "must not touch" wording mint pins HERE too (the
 *  old narrower set re-opened the D6 split inward). */
export const PROTECT_QUALIFIER_RE = /\b(?:stays?|remain[sd]?|must (?:stay|remain|be)|pins?|pinned)\s+(?:[\w./-]+\s+){0,3}?byte[-\s]?untouched\b|\bbyte[-\s]?untouched\s+in\s+git\b|\bworking\s+tree\s+(?:is\s+|stays?\s+|remains?\s+)?clean\b|\b(?:is|are|remains?|stays?)\s+immutable\b|\bnever\s+touch(?:es|ing)?\b|\bmust\s+not\s+(?:touch|edit|modify|change)\b/gi;
const MD_PORCELAIN_RE = PROTECT_QUALIFIER_RE;

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
