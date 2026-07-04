/**
 * Tests for control-object parsing: extractControl (text contract) and
 * extractControlKeys (per-stage schema derivation). The session backend's
 * structured_output schema is built from extractControlKeys, so a regression
 * here silently re-introduces the requirements-gate failure.
 */

import { describe, it, expect } from "vitest";
import { extractControl, extractControlKeys } from "../src/control.ts";

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

	it("tolerates trailing commas", () => {
		const t = '<control>{"a": 1, "b": [1,2,],}</control>';
		expect(extractControl(t)).toEqual({ a: 1, b: [1, 2] });
	});

	it("returns null when nothing parses", () => {
		expect(extractControl("just prose, no object")).toBeNull();
		expect(extractControl("")).toBeNull();
	});
});
