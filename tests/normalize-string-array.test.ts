/**
 * Regression guard for the `testFiles.join is not a function` crash (spec-12
 * run, Stage 9). The tdd-guide agent returned `testFiles` as a bare string
 * instead of an array; the old `?? []` only caught null/undefined, so the
 * string sailed through and `.join()` crashed the RED oracle.
 *
 * normalizeStringArray mirrors the normalizePhases defense: coerce any
 * agent-returned array field into a genuine string[].
 */
import { describe, it, expect } from "vitest";
import { normalizeStringArray } from "../src/stages/implementation.ts";

describe("normalizeStringArray — agent-shape defense", () => {
	it("passes a real string[] through (filtered to strings)", () => {
		expect(normalizeStringArray(["a.rs", "b.ts"])).toEqual(["a.rs", "b.ts"]);
		expect(normalizeStringArray(["a.rs", 42, null, { x: 1 }, "b.ts"])).toEqual(["a.rs", "b.ts"]);
	});

	it("wraps a bare STRING into a single-element array (the crash case)", () => {
		// This is exactly what the spec-12 tdd-guide returned.
		expect(normalizeStringArray("crates/foo/tests/bar.rs")).toEqual(["crates/foo/tests/bar.rs"]);
		expect(normalizeStringArray("  spaced.rs  ")).toEqual(["spaced.rs"]);
	});

	it("returns [] for an empty/whitespace string (not [''])", () => {
		expect(normalizeStringArray("")).toEqual([]);
		expect(normalizeStringArray("   ")).toEqual([]);
	});

	it("returns [] for object / number / null / undefined (no crash)", () => {
		for (const v of [null, undefined, 42, { path: "x.rs" }, true, { 0: "x" }]) {
			expect(normalizeStringArray(v), `value=${JSON.stringify(v)}`).toEqual([]);
		}
	});

	it("decodes a JSON-array STRING into its real elements (LLM shape-drift: the malformed-vitest-filter bug)", () => {
		// The run-2026-08-12 RED loop deadlock: tdd-guide returned testFiles as the
		// STRING '["src/persistence.test.ts"]'. The old wrap produced one filename
		// '["src/persistence.test.ts"]' which vitest's substring filter matched to
		// nothing (`No test files found` forever). Must decode to the real path.
		expect(normalizeStringArray('["src/persistence.test.ts"]')).toEqual(["src/persistence.test.ts"]);
		expect(normalizeStringArray('  ["src/a.ts", "src/b.ts"]  ')).toEqual(["src/a.ts", "src/b.ts"]);
		// non-string elements inside the decoded array are dropped.
		expect(normalizeStringArray('["a.ts", 42, "b.ts"]')).toEqual(["a.ts", "b.ts"]);
	});

	it("decodes array-wrapped JSON-array strings (element-level shape-drift)", () => {
		// An ARRAY whose single element is itself a JSON-array string must also
		// decode — a naive `Array.isArray` + string-filter would pass the blob through.
		expect(normalizeStringArray(['["src/persistence.test.ts"]'])).toEqual(["src/persistence.test.ts"]);
		expect(normalizeStringArray(['["a.ts", "b.ts"]', "c.ts"])).toEqual(["a.ts", "b.ts", "c.ts"]);
	});

	it("falls back to a bare-string wrap when a bracketed string is not a JSON string array", () => {
		expect(normalizeStringArray("[not json")).toEqual(["[not json"]); // invalid JSON → bare wrap
		expect(normalizeStringArray("[1, 2, 3]")).toEqual([]); // valid JSON number array → no string filenames (consistent with array-input non-string dropping)
	});

	it("the result is always `.join`-able (the original crash surface)", () => {
		// Every branch must yield a value on which `.join()` works.
		expect(normalizeStringArray("foo.rs").join(",")).toBe("foo.rs");
		expect(normalizeStringArray(["a", "b"]).join(",")).toBe("a,b");
		expect(normalizeStringArray(undefined).join(",")).toBe("");
		expect(normalizeStringArray({ wrong: true }).join(",")).toBe("");
	});
});
