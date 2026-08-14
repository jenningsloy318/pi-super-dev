/**
 * Tests for control-object parsing: extractControl (text contract) and
 * extractControlKeys (per-stage schema derivation). The session backend's
 * structured_output schema is built from extractControlKeys, so a regression
 * here silently re-introduces the requirements-gate failure.
 */

import { describe, it, expect } from "vitest";
import { extractControl, extractControlKeys, missingControlKeys } from "../src/control.ts";

describe("extractControlKeys", () => {
	it("parses the requirements-style key list", () => {
		const prompt =
			"## Instructions\nProduce a doc.\nOutput <control> JSON with: docPath, featureName, acCount, openQuestions, summary.";
		expect(extractControlKeys(prompt)).toEqual([
			"docPath",
			"featureName",
			"acCount",
			"openQuestions",
			"summary",
		]);
	});

	it("strips inline (type) annotations from keys", () => {
		// spec prompt: "...phases (array with name/description per phase), summary."
		const prompt =
			"Output <control> JSON with: specificationPath, planPath, tasksPath, phaseCount, phases (array with name/description per phase), summary.";
		expect(extractControlKeys(prompt)).toEqual([
			"specificationPath",
			"planPath",
			"tasksPath",
			"phaseCount",
			"phases",
			"summary",
		]);
	});

	it("returns [] when the prompt has no <control> line (e.g. commit tasks)", () => {
		expect(extractControlKeys("## Instructions\nCommit the changes.")).toEqual([]);
	});

	it("is case-insensitive on the <control> JSON marker", () => {
		expect(extractControlKeys("output <CONTROL> Json with: verdict, findings.")).toEqual([
			"verdict",
			"findings",
		]);
	});

	it("filters out non-identifier tokens", () => {
		// keys are camelCase identifiers; digits-leading and stripped-empty tokens drop out
		const prompt = "Output <control> JSON with: docPath, (notes), 3things, okKey, summary.";
		expect(extractControlKeys(prompt)).toEqual(["docPath", "okKey", "summary"]);
	});
});

describe("extractControl", () => {
	it("parses a <control> tag", () => {
		const t = 'before\n<control>{"docPath": "x.md", "acCount": 3}</control>\nafter';
		expect(extractControl(t)).toEqual({ docPath: "x.md", acCount: 3 });
	});

	it("parses a ```json fenced block", () => {
		const t = "blah\n```json\n{\"verdict\": \"Approved\"}\n```\n";
		expect(extractControl(t)).toEqual({ verdict: "Approved" });
	});

	it("parses a COMPACT fenced block with no trailing newline before the fence (F-4)", () => {
		// Before the fix the closing `\s` required exactly one whitespace char, so a
		// compact ```json{...}``` fell through to findLastJsonObject and could pick up
		// a later prose object instead.
		const t = 'text ```json{"verdict":"Approved"}``` trailing {"decoy":true}';
		expect(extractControl(t)).toEqual({ verdict: "Approved" });
	});

	it("tolerates trailing commas", () => {
		const t = '<control>{"a": 1, "b": [1,2,],}</control>';
		expect(extractControl(t)).toEqual({ a: 1, b: [1, 2] });
	});

	it("parses a <control> tag with NO trailing whitespace before </control>", () => {
		// Regression: the tag regex used to require exactly one `\s` before
		// `</control>`, so compact JSON like `{"a":1}</control>` missed the
		// primary tag path and only parsed via the weaker last-JSON-object
		// fallback. The regex must accept zero-or-more trailing whitespace.
		const t = 'before\n<control>{"docPath": "y.md", "acCount": 7}</control>\nafter';
		expect(extractControl(t)).toEqual({ docPath: "y.md", acCount: 7 });
	});

	it("parses a <control> tag with leading+trailing whitespace", () => {
		const t = '<control>\n  {"v": 1}\n</control>';
		expect(extractControl(t)).toEqual({ v: 1 });
	});

	it("returns null when nothing parses", () => {
		expect(extractControl("just prose, no object")).toBeNull();
		expect(extractControl("")).toBeNull();
	});
});

describe("missingControlKeys optionality (Fix 1c/1d support)", () => {
	it("absent key is ALWAYS missing, even when allow-listed", () => {
		// The contract is emit-[]-when-none: the key must be PRESENT.
		expect(missingControlKeys({ a: 1 }, ["a", "testDefects"], { allowEmptyArraysFor: ["testDefects"] })).toEqual(["testDefects"]);
	});

	it("empty array is valid ONLY when allow-listed", () => {
		expect(missingControlKeys({ testDefects: [] }, ["testDefects"], { allowEmptyArraysFor: ["testDefects"] })).toEqual([]);
		expect(missingControlKeys({ testDefects: [] }, ["testDefects"])).toEqual(["testDefects"]);
		expect(missingControlKeys({ testDefects: [] }, ["testDefects"], { allowEmptyArraysFor: "*" })).toEqual([]);
	});

	it("non-empty array is always valid; blank strings and null stay missing", () => {
		const control = { testDefects: [{ testFile: "a.test.ts", reason: "r" }], filesModified: [], summary: "" };
		expect(
			missingControlKeys(control, ["testDefects", "filesModified", "summary"], {
				allowEmptyArraysFor: new Set(["filesCreated", "filesModified", "filesDeleted", "testDefects"]),
			}),
		).toEqual(["summary"]);
	});
});
