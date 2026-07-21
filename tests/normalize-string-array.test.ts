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

	it("the result is always `.join`-able (the original crash surface)", () => {
		// Every branch must yield a value on which `.join()` works.
		expect(normalizeStringArray("foo.rs").join(",")).toBe("foo.rs");
		expect(normalizeStringArray(["a", "b"]).join(",")).toBe("a,b");
		expect(normalizeStringArray(undefined).join(",")).toBe("");
		expect(normalizeStringArray({ wrong: true }).join(",")).toBe("");
	});
});
