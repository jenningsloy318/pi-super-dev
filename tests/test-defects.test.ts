/**
 * Unit tests for the implementer `testDefects` control parser — the structured
 * signal that triggers an evidence-carrying RED re-author when the implementer
 * proves a confirmed RED test is unsatisfiable. The parser is defensive
 * (untrusted agent control) and must never throw.
 */
import { describe, it, expect } from "vitest";
import { parseTestDefects } from "../src/stages/implementation.ts";

describe("parseTestDefects (defensive parse of untrusted control)", () => {
	it("returns [] for null/undefined/non-object/array input", () => {
		expect(parseTestDefects(null)).toEqual([]);
		expect(parseTestDefects(undefined)).toEqual([]);
		expect(parseTestDefects("not an object")).toEqual([]);
		expect(parseTestDefects(42)).toEqual([]);
		expect(parseTestDefects([{ testFile: "a", reason: "b" }])).toEqual([]);
	});

	it("returns [] when testDefects is absent or not an array", () => {
		expect(parseTestDefects({})).toEqual([]);
		expect(parseTestDefects({ testDefects: "nope" })).toEqual([]);
		expect(parseTestDefects({ testDefects: {} })).toEqual([]);
	});

	it("parses well-formed defects, preserving optional lines", () => {
		expect(parseTestDefects({ testDefects: [
			{ testFile: "tests/a.test.ts", lines: "L10,L20", reason: "contradiction: X and not-X" },
			{ testFile: "tests/b.test.ts", reason: "compile error in test" },
		] })).toEqual([
			{ testFile: "tests/a.test.ts", lines: "L10,L20", reason: "contradiction: X and not-X" },
			{ testFile: "tests/b.test.ts", reason: "compile error in test" },
		]);
	});

	it("DROPS entries missing testFile or reason (no proof => not actionable, prevents vague escape hatch)", () => {
		expect(parseTestDefects({ testDefects: [
			{ testFile: "tests/a.test.ts", reason: "valid" },
			{ testFile: "", reason: "missing file" },
			{ testFile: "tests/c.test.ts", reason: "" },
			{ lines: "L1", reason: "missing file field" },
			{ testFile: "tests/e.test.ts" },
		] })).toEqual([
			{ testFile: "tests/a.test.ts", reason: "valid" },
		]);
	});

	it("skips non-object array entries and trims whitespace", () => {
		expect(parseTestDefects({ testDefects: [
			"string entry",
			null,
			{ testFile: "  tests/a.test.ts  ", reason: "  spaced proof  " },
		] })).toEqual([
			{ testFile: "tests/a.test.ts", reason: "spaced proof" },
		]);
	});

	it("bounds to 6 entries (a flailing implementer cannot flood the re-author prompt)", () => {
		const many = Array.from({ length: 12 }, (_, i) => ({ testFile: `tests/${i}.test.ts`, reason: `r${i}` }));
		expect(parseTestDefects({ testDefects: many })).toHaveLength(6);
	});
});
