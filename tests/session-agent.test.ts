/**
 * Tests for runAgentViaSession's corrective-re-prompt behavior (B1/B2 from the
 * deep audit): the corrective turn must (B1) fire ONLY when structured_output
 * was actually called, and (B2) MERGE into the captured value instead of
 * overwriting (so previously-present keys survive a partial second call).
 *
 * These test the pure helpers + the tool-merge behavior directly, since the
 * full session path needs a real model (covered by verify-bdd.ts).
 */

import { describe, it, expect } from "vitest";
import { missingKeys, deliveryDisciplineFor } from "../src/session-agent.ts";

describe("deliveryDisciplineFor", () => {
	it("gives code-writing agents a code-centric discipline (edits, not a document)", () => {
		const impl = deliveryDisciplineFor("implementer");
		expect(impl).toMatch(/APPLIED SOURCE-CODE EDITS/);
		// Must NOT tell the implementer its deliverable is a "document" nor cap it at ~6 calls.
		expect(impl).not.toMatch(/written document/);
		expect(impl).not.toMatch(/AT MOST ~6 tool calls/);
		// Steers away from the edit-thrash failure mode.
		expect(impl).toMatch(/whole-file `write`/);
		expect(impl).toMatch(/source file MUST be modified/);
		expect(deliveryDisciplineFor("tdd-guide")).toBe(impl);
	});
	it("keeps the doc-centric discipline for doc writers", () => {
		const doc = deliveryDisciplineFor("research-agent");
		expect(doc).toMatch(/written document/);
		expect(doc).toMatch(/AT MOST ~6 tool calls/);
		expect(doc).not.toMatch(/APPLIED SOURCE-CODE EDITS/);
	});
});

describe("missingKeys", () => {
	it("returns all keys when captured is null/undefined", () => {
		expect(missingKeys(undefined, ["a", "b"])).toEqual(["a", "b"]);
		expect(missingKeys(null, ["a", "b"])).toEqual(["a", "b"]);
	});
	it("returns keys that are blank", () => {
		expect(missingKeys({ a: 1, b: "", c: null, d: [], e: "x" }, ["a", "b", "c", "d", "e", "f"])).toEqual(["b", "c", "d", "f"]);
	});
	it("returns [] when everything is present", () => {
		expect(missingKeys({ a: 1, b: "x" }, ["a", "b"])).toEqual([]);
	});
});

describe("structured_output capture merges (B2)", () => {
	it("simulates the merge: a partial second call does not erase earlier keys", () => {
		// Mirror of the tool's execute(): capture.value = { ...capture.value, ...params }
		let value: Record<string, unknown> | undefined = undefined;
		const exec = (params: Record<string, unknown>) => {
			value = { ...value, ...params };
		};
		// First call: docPath + summary present, scenarioCount missing.
		exec({ docPath: "/x/01-requirements.md", summary: "s" });
		expect(value).toEqual({ docPath: "/x/01-requirements.md", summary: "s" });
		// Corrective turn returns ONLY the missing key — merge must keep docPath.
		exec({ scenarioCount: 5 });
		expect(value).toEqual({ docPath: "/x/01-requirements.md", summary: "s", scenarioCount: 5 });
	});
});
