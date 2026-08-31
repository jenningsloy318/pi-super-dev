/**
 * Tolerant extraction of the `<control>` JSON object specialist agents emit.
 * Tries, in order: `<control>...</control>` tag, ```json fenced block, then the
 * last balanced `{...}` object in the text. Returns null if none parse.
 */

import type { ControlObj } from "./types.ts";

// NOTE: trailing `\s*` (zero-or-more) — NOT `\s` (exactly one). A single
// trailing whitespace char made `<control>{...}</control>` (compact JSON,
// no trailing space) miss the primary tag path and silently fall through to
// the weaker last-JSON-object fallback. The function still returned the
// right object, but relying on the fallback is fragile (a prose `{...}`
// after the block could win). Zero-or-more is the obviously-intended match.
const CONTROL_TAG_RE = /<control>\s*([\s\S]*?)\s*<\/control>/i;

export function extractControl(text: string): ControlObj | null {
	if (!text) return null;
	const tag = text.match(CONTROL_TAG_RE);
	if (tag?.[1]) {
		const parsed = tryParseJsonObject(tag[1]);
		if (parsed) return parsed;
	}
	for (const match of text.matchAll(/```(?:json)?\s*([\s\S]*?)\s*```/gi)) {
		const parsed = tryParseJsonObject(match[1]);
		if (parsed) return parsed;
	}
	const obj = findLastJsonObject(text);
	if (obj) {
		const parsed = tryParseJsonObject(obj);
		if (parsed) return parsed;
	}
	return null;
}

function tryParseJsonObject(raw: string): ControlObj | null {
	const trimmed = raw.replace(/,(\s*[}\]])/g, "$1").trim();
	if (!trimmed.startsWith("{")) return null;
	try {
		const value = JSON.parse(trimmed);
		if (value && typeof value === "object" && !Array.isArray(value)) {
			return value as ControlObj;
		}
	} catch {
		// v0.3.48: strict parse failed — try the unescaped-inner-quote repair before
		// giving up (see repairUnescapedQuotes for the incident this ends).
		const repaired = repairUnescapedQuotes(trimmed);
		if (repaired && repaired !== trimmed) {
			try {
				const value = JSON.parse(repaired);
				if (value && typeof value === "object" && !Array.isArray(value)) {
					return value as ControlObj;
				}
			} catch {
				/* repair did not converge — fall through to null */
			}
		}
	}
	return null;
}

/** v0.3.48 — repair the unescaped-inner-double-quote JSON class.
 *
 * Live incident (run 2026-08-31T01-47-05 + poisoned resume 02-56-26,
 * cosmic-clock requirements review round 1): the reviewer's control JSON
 * embedded HTML markup in an evidence string — `countOccurrences('<a class="card "'=8)`
 * — and the UNESCAPED double quotes inside the string terminated it early
 * (`Expected ',' or '}' after property value`). The whole 22-minute review
 * (6 findings, 4 blocking golden-value math contradictions) was discarded,
 * the delegation corrective retry re-ran the entire agent, the still-unparsed
 * retry got cached as a permanent error row, and the resume replayed that
 * poisoned row into an instant abort. Models quoting HTML/markup in evidence
 * is COMMON, so the parse boundary now repairs this class instead of failing.
 *
 * Strategy: a quote inside a string is a REAL closing quote only when the
 * next non-whitespace character is structural (`,` `:` `}` `]` — the only
 * legal followers of a string value/key in JSON). Any other quote is inner
 * and gets escaped. The repair runs ONLY after strict JSON.parse already
 * failed, so well-formed payloads take the fast path untouched; a wrong
 * repair just fails parse again (returns null — never worse than before).
 * Known residual ambiguity (inner quote immediately followed by a comma,
 * e.g. prose `class="card,"`) stays unrepaired — better honest-null than
 * silently rewritten content. */
export function repairUnescapedQuotes(raw: string): string | null {
	let out = "";
	let inString = false;
	for (let i = 0; i < raw.length; i++) {
		const ch = raw[i]!;
		if (!inString) {
			if (ch === '"') inString = true;
			out += ch;
			continue;
		}
		// inside a string
		if (ch === "\\") {
			out += ch + (raw[i + 1] ?? "");
			i++;
			continue;
		}
		if (ch !== '"') {
			out += ch;
			continue;
		}
		// candidate closing quote — lookahead to the next non-whitespace char
		let j = i + 1;
		while (j < raw.length && /\s/.test(raw[j]!)) j++;
		const next = raw[j];
		if (next === undefined || next === "," || next === ":" || next === "}" || next === "]") {
			inString = false;
			out += ch;
		} else {
			out += '\\"'; // inner quote — escape it
		}
	}
	return out;
}

/** The list of control keys a stage expects, parsed from its prompt.
 *  Every `build*Prompt` ends with a line like:
 *      Output <control> JSON with: docPath, featureName, acCount, openQuestions, summary.
 *  We parse that comma-list (stripping balanced `(…)` annotations) so the
 *  session backend can declare those keys in its `structured_output` tool
 *  schema — which is what actually makes the model fill them (see
 *  docs/findings/session-backend-requirements-gate.md). Returns [] if the
 *  prompt has no such line (e.g. commit tasks), which safely degrades to the
 *  permissive schema.
 *
 *  HARDENED (v0.1.52 casualty): the list is split on commas at NESTING DEPTH
 *  ZERO only — commas inside `(…)`/`{…}`/`[…]` shapes do not separate keys.
 *  The old naive split broke `testDefects (optional array of {testFile, lines,
 *  reason} — emit ONLY when…)`: the fragment carrying `testDefects` had an
 *  unclosed paren, failed the identifier filter, and was silently DROPPED
 *  while the inner word `lines` leaked through as a phantom key — which made
 *  the v0.1.51 unsatisfiable-RED-test challenge channel unreachable in real
 *  runs. A segment is accepted when it starts with a valid identifier whose
 *  remainder is empty or an annotation/shape continuation (`(`, `[`, em-dash,
 *  `;`). Unparseable fragments are logged, not silently discarded.
 *
 *  OPTIONALITY (v0.3.47): a segment may mark its key optional two ways — a
 *  trailing `?` after the identifier (`priorFindingResolutions?`) or a
 *  leading `(optional…)` paren annotation (`contracts (optional) [{…}]`,
 *  `reviewResponses (optional on first attempt…)`). Optional keys are
 *  EXCLUDED from the returned (required) list: the delegation key check is
 *  context-free, and a schema-`Type.Optional` field that the contract
 *  nevertheless DEMANDED cost a live run 22m52s when a reviewer reasonably
 *  omitted a semantically-empty `priorFindingResolutions` at round 1 and the
 *  corrective retry re-ran the whole agent (run 2026-08-31T01-47-05). The
 *  deterministic validators own context-conditional requirements. */
export function extractControlKeys(prompt: string): string[] {
	const m = prompt.match(/<control>\s*JSON\s*with:\s*([^\n]+)/i);
	if (!m) return [];
	const raw = m[1].replace(/\.\s*$/, ""); // sentence-final period only — mid-line periods stay
	// Aggregate drift signal: unbalanced parens in a control line mean prose
	// is leaking into the contract — warn once (the split below still rescues
	// the leading identifier of each segment, so keys are NOT lost).
	const parenDepth = [...raw].reduce((d, ch) => (ch === "(" ? d + 1 : ch === ")" ? d - 1 : d), 0);
	if (parenDepth !== 0) console.warn(`[control] unbalanced parentheses in control-key line (${parenDepth > 0 ? "unclosed" : "extra closing"}); keys rescued by leading-identifier extraction`);
	// Depth-aware comma split (nesting depth 0).
	const segments: string[] = [];
	let depth = 0;
	let start = 0;
	for (let i = 0; i < raw.length; i++) {
		const ch = raw[i];
		if (ch === "(" || ch === "{" || ch === "[") depth++;
		else if (ch === ")" || ch === "}" || ch === "]") depth = Math.max(0, depth - 1);
		else if (ch === "," && depth === 0) {
			segments.push(raw.slice(start, i));
			start = i + 1;
		}
	}
	segments.push(raw.slice(start));
	const keys: string[] = [];
	for (const segment of segments) {
		const t = segment.trim();
		if (!t) continue;
		// Key = leading identifier; the remainder must be empty or an
		// annotation/shape continuation. A period, hyphen, or other attached
		// junk ("b.g. note", "good-key", "123bad") rejects the segment.
		const id = /^([A-Za-z_]\w*)/.exec(t);
		if (id) {
			const rest = t.slice(id[1].length);
			if (/^\?/.test(rest)) continue; // `key?` — optional, not required
			if (/^\s*\(\s*optional\b/.test(rest)) continue; // `key (optional …)` — optional
			if (rest === "" || /^\s*[\u2014\u2013;(\[:]/.test(rest)) {
				keys.push(id[1]);
				continue;
			}
		}
		// Surface drift instead of silently dropping keys (the failure mode
		// that hid the challenge channel for two versions).
		console.warn(`[control] unparseable control-key fragment dropped: ${JSON.stringify(t.slice(0, 120))}`);
	}
	return keys;
}

/** Which declared keys are missing/blank in a captured control object. */
export function missingControlKeys(
	captured: Record<string, unknown> | null | undefined,
	keys: string[],
	options: { allowEmptyArraysFor?: Set<string> | string[] | "*" } = {},
): string[] {
	if (!captured) return keys;
	const allow = options.allowEmptyArraysFor;
	const allowEmptyArray = (key: string): boolean =>
		allow === "*" || (Array.isArray(allow) ? allow.includes(key) : allow instanceof Set ? allow.has(key) : false);
	return keys.filter((k) => {
		const v = captured[k];
		return v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0 && !allowEmptyArray(k));
	});
}

/** Find the last balanced `{...}` substring via a brace scan. */
export function findLastJsonObject(text: string): string | null {
	const lastOpen = text.lastIndexOf("{");
	if (lastOpen === -1) return null;
	let depth = 0;
	let inString = false;
	let escape = false;
	for (let i = lastOpen; i < text.length; i++) {
		const ch = text[i];
		if (inString) {
			if (escape) escape = false;
			else if (ch === "\\") escape = true;
			else if (ch === '"') inString = false;
			continue;
		}
		if (ch === '"') inString = true;
		else if (ch === "{") depth++;
		else if (ch === "}") {
			depth--;
			if (depth === 0) return text.slice(lastOpen, i + 1);
		}
	}
	return null;
}
