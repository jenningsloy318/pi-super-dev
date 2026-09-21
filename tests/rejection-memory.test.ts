/**
 * WS4 (066 §2) — the rejection memory: L0 pins.
 * Restart-with-lessons, JSON-structured, decayed (066 grill-3 Q3).
 */

import { describe, it, expect } from "vitest";
import { lessonRowFrom, lessonsForWriter, lessonsPromptBlock } from "../src/convergence-economy/rejection-memory.ts";

const finding = (over: Partial<Parameters<typeof lessonRowFrom>[0]> = {}) => ({
	title: "Amendment family omits the scope-guard repair",
	detail: "the mandated edits trip tests/prosperity-contract.test.ts:2798",
	severity: "P1",
	evidence: ["tests/prosperity-contract.test.ts:2798"],
	recommendation: "extend SIBLING_PHASE_DELIVERABLES via the amendment family",
	defectClass: "scope-guard-collision",
	detectedAtStage: "bdd",
	status: "open",
	...over,
});

describe("lessonRowFrom", () => {
	it("compresses a finding into the JSON row shape with caps", () => {
		const row = lessonRowFrom(finding());
		expect(row).toEqual({
			class: "scope-guard-collision",
			rule: "extend SIBLING_PHASE_DELIVERABLES via the amendment family",
			locus: "tests/prosperity-contract.test.ts:2798",
			origin: "bdd",
			severity: "P1",
		});
	});
	it("whitespace-normalizes and truncates long rules/loci with an ellipsis", () => {
		const row = lessonRowFrom(finding({ recommendation: "x".repeat(300), evidence: ["y".repeat(300)] }));
		expect(row.rule.length).toBeLessThanOrEqual(160);
		expect(row.rule.endsWith("…")).toBe(true);
		expect(row.locus.length).toBeLessThanOrEqual(120);
	});
	it("falls back rule->detail->title when the recommendation is absent; class->title stem", () => {
		const row = lessonRowFrom(finding({ recommendation: undefined, defectClass: undefined }));
		expect(row.class).toContain("Amendment family");
		expect(row.rule).toContain("prosperity-contract");
	});
});

describe("lessonsForWriter (dedupe, ranking, cap, decay semantics)", () => {
	it("excludes superseded rows AND resolved residue (verified/addressed teach nothing — 067 R6-Q3)", () => {
		const rows = lessonsForWriter([finding({ status: "superseded" }), finding({ status: "verified" }), finding({ status: "addressed" }), finding({ defectClass: "other" })]);
		expect(rows.length).toBe(1);
		expect(rows[0]!.class).toBe("other");
	});
	it("dedupes on class+rule-stem — a generalized defect teaches ONE lesson", () => {
		const rows = lessonsForWriter([finding(), finding({ evidence: ["other:1"] }), finding({ severity: "P2" })]);
		expect(rows.length).toBe(1);
	});
	it("severity-ranks (P0/P1 first) and caps at 8", () => {
		const many = Array.from({ length: 12 }, (_, i) => finding({ defectClass: `c${i}`, severity: i % 2 === 0 ? "P2" : "P1" }));
		const rows = lessonsForWriter(many);
		expect(rows.length).toBe(8);
		expect(rows[0]!.severity).toBe("P1");
	});
	it("cross-stage provenance is preserved (origin carries the learning site)", () => {
		const rows = lessonsForWriter([finding({ detectedAtStage: "verify" })]);
		expect(rows[0]!.origin).toBe("verify");
	});
});

describe("lessonsPromptBlock (JSON lines — the shape models respect)", () => {
	it("renders a header + one JSON line per lesson; empty rows → empty block (no noise)", () => {
		const block = lessonsPromptBlock(lessonsForWriter([finding()]));
		expect(block).toContain("## Lessons from prior rounds");
		const jsonLines = block.split("\n").slice(1);
		expect(() => JSON.parse(jsonLines[0]!)).not.toThrow();
		expect(JSON.parse(jsonLines[0]!).class).toBe("scope-guard-collision");
		expect(lessonsPromptBlock([])).toBe("");
	});
});
