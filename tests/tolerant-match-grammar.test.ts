/**
 * F-14 (v0.3.86) — tolerantMatch's ENUMERATED matching grammar.
 *
 * The old regex-first order compiled literal code text as a RegExp: `foo(bar)`
 * matched `foobar`, `obj.property` matched `obj-property` — false positives in
 * requireContains (false greens) and requireNotContains (false blocks). The new
 * order is a literal-first grammar table:
 *
 *   | row | pattern form                | stage | expected                     |
 *   |---|---|---|---|
 *   | 1 | plain literal            | 1 (raw substring)           | match iff literally contained |
 *   | 2 | literal with bare parens `foo(bar)` | 1 only          | matches ONLY literally — no `foobar` false hit |
 *   | 3 | literal with bare dot `obj.property` | 1 only          | `obj-property` does NOT match |
 *   | 4 | `(?i)Literal`            | 1 raw, then 2 (ci containment) | case-insensitive containment |
 *   | 5 | regex-intent `connect.*db` | 3 (compile+test)          | regex semantics preserved |
 *   | 6 | regex-intent escaped `toBe\(13\)` | 3                  | escaped metachar regex preserved |
 *   | 7 | `(?i)` + regex-intent     | 2 then 3 (i flag)           | both case-insensitive stages |
 *   | 8 | invalid regex with no literal hit | —               | no match, never throws |
 *
 * Regex-intent = REGEX_INTENT_RE (backslash escapes, `|`, anchors, `*`/`+`/`?`,
 * `{...}`, class-like brackets) — bare grouping parens and bare dots are
 * deliberately NOT regex intent (they are the literal false-positive source).
 */

import { describe, expect, it } from "vitest";
import { tolerantMatch } from "../src/build-runner/gates.ts";

describe("tolerantMatch — literal-first grammar (F-14)", () => {
	it("row 1: plain literal both polarities", () => {
		expect(tolerantMatch("CLOSED_THIRTEEN", "const CLOSED_THIRTEEN = 13;")).toBe(true);
		expect(tolerantMatch("CLOSED_THIRTEEN", "const OTHER = 1;")).toBe(false);
	});

	it("row 2: literal-with-parens matches ONLY literally (no foobar false positive)", () => {
		expect(tolerantMatch("foo(bar)", "call foo(bar) now")).toBe(true);
		// RED pre-fix: the regex `foo(bar)` compiled and matched `connectdb foobar`.
		expect(tolerantMatch("foo(bar)", "connectdb foobar")).toBe(false);
	});

	it("row 2 (notContains polarity): a forbidden `a.b` no longer matches `a-b`", () => {
		expect(tolerantMatch("obj.property", "obj-property")).toBe(false);
		expect(tolerantMatch("obj.property", "obj.property = 1")).toBe(true);
	});

	it("row 3: literal-indexing brackets stay literal (arr[0] ≠ arr0)", () => {
		expect(tolerantMatch("arr[0]", "value at arr0")).toBe(false);
		expect(tolerantMatch("arr[0]", "read arr[0] first")).toBe(true);
	});

	it("row 4: (?i) keeps its meaning in the containment stage", () => {
		expect(tolerantMatch("(?i)Permission", "GRANTED permission yes")).toBe(true);
		expect(tolerantMatch("(?i)Permission", "GRANTED only")).toBe(false);
	});

	it("row 5: regex-intent patterns still match via stage 3", () => {
		expect(tolerantMatch("connect.*db", "connect-to-db")).toBe(true);
		expect(tolerantMatch("user|admin", "hello admin")).toBe(true);
		expect(tolerantMatch("^export const", "  export const")).toBe(false);
		expect(tolerantMatch("^export const", "export const x = 1")).toBe(true);
	});

	it("row 6: escaped-metachar regexes keep regex semantics (existing G12/deliverable forms)", () => {
		expect(tolerantMatch("toBe\\(13\\)", "expect(n).toBe(13);")).toBe(true);
		expect(tolerantMatch("toBe\\(13\\)", "expect(n).tobe13")).toBe(false);
		expect(tolerantMatch("h\\.POST\\s*\\(", "  h.POST (y)")).toBe(true);
	});

	it("row 7: (?i) + regex-intent exercises BOTH stages (stage 3 with the i flag)", () => {
		expect(tolerantMatch("(?i)[a-z]+_ID", "token USER_ID here")).toBe(true);
		expect(tolerantMatch("(?i)[a-z]+_ID", "no match here")).toBe(false);
	});

	it("row 8: invalid regex with no literal containment never matches and never throws", () => {
		expect(tolerantMatch("a(b", "contains a(b literally")).toBe(true); // literal containment wins
		expect(tolerantMatch("x(y", "no such text")).toBe(false);
	});

	it("alias-relaxation variant behavior is unchanged (sweep-3 G12 control)", () => {
		expect(tolerantMatch("h\\.POST\\s*\\(", "  h.POST (y)")).toBe(true);
		expect(tolerantMatch("auth\\.something", "authXsomething")).toBe(false);
	});
});
