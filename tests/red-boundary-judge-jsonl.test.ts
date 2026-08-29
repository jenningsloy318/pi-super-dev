/**
 * v0.3.30 F4 — `.judge.jsonl` is runtime evidence, never RED-boundary pollution.
 *
 * Root cause (run 2026-08-28T16-09-12-785Z try 4): the judge audit trail
 * (spec-dir `.judge.jsonl`, appended by every judge consult) is missing from
 * RUNTIME_EVIDENCE_BASENAMES, so a judge call BETWEEN RED tries drifts into
 * the boundary's changedFiles as a "production file" and lands in the
 * polluted-red reason list alongside the real scaffold.
 */

import { describe, it, expect } from "vitest";
import { classifyObviousRedPath, isRuntimeEvidencePath } from "../src/test-artifacts.ts";

describe("v0.3.30 F4 — .judge.jsonl is runtime evidence", () => {
	it("isRuntimeEvidencePath accepts spec-dir .judge.jsonl", () => {
		expect(isRuntimeEvidencePath("docs/specifications/17-fix-ankidroid-field-export/.judge.jsonl")).toBe(true);
		expect(isRuntimeEvidencePath(".judge.jsonl")).toBe(true);
	});

	it("classifyObviousRedPath allows it deterministically (runtime category, not ambiguous)", () => {
		const d = classifyObviousRedPath("docs/specifications/17-x/.judge.jsonl");
		expect(d.category).toBe("runtime");
		expect(d.allowed).toBe(true);
		expect(d.confidence).toBe(1);
	});
});
