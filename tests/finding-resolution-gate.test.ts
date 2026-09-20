/**
 * WS1 (066 §2) — the finding-resolution gate decision core, L0 grammar +
 * decision tables. The wiring (artifact-convergence bounce) lands as the next
 * increment; these pins hold the CONTRACT the wiring must consume.
 */

import { describe, it, expect } from "vitest";
import { adjudicateFindingResolutionGate, findingResolutionGateEnabled, parseFindingResolutions, type FindingResolutionGateInput } from "../src/convergence-economy/finding-resolution-gate.ts";

const base = (over: Partial<FindingResolutionGateInput> = {}): FindingResolutionGateInput => ({
	injectedIds: ["CF-implementation-1nl0mhr", "BDD26-F01"],
	resolutions: [
		{ id: "CF-implementation-1nl0mhr", loci: ["docs/specifications/26-capability-backend-substrate/01-requirements.md:18"], note: "amendment family extended per the finding's remedy" },
		{ id: "BDD26-F01", loci: ["03-bdd-scenarios.md:37"], note: "SCENARIO-054 pin ownership added" },
	],
	...over,
});

describe("parseFindingResolutions (grammar table — a row counts only with a non-empty string id)", () => {
	it("accepts the well-formed row shape", () => {
		const out = parseFindingResolutions([{ id: "F1", loci: ["a.md:1"], note: "n" }]);
		expect(out.rows).toEqual([{ id: "F1", loci: ["a.md:1"], note: "n" }]);
		expect(out.malformedRows).toBe(0);
	});
	it("drops non-array controls wholesale (absent control = no coverage — fail-closed)", () => {
		for (const v of [undefined, null, "prose blob", {}, 42]) {
			const out = parseFindingResolutions(v);
			expect(out.rows).toEqual([]);
			expect(out.malformedRows).toBe(0);
		}
	});
	it("drops null/non-object rows and id-less rows as malformed (never throws — P5)", () => {
		const out = parseFindingResolutions([null, 7, { note: "no id" }, { id: "   " }, { id: "F1" }]);
		expect(out.rows).toEqual([{ id: "F1", loci: [], note: "" }]);
		expect(out.malformedRows).toBe(4);
	});
	it("keeps rows with empty loci/note without counting malformed (optionality is union-shaped)", () => {
		const out = parseFindingResolutions([{ id: "F1" }]);
		expect(out.rows[0]?.loci).toEqual([]);
		expect(out.malformedRows).toBe(0);
	});
	it("trims string ids and filters non-string loci", () => {
		const out = parseFindingResolutions([{ id: " F1 ", loci: ["a.md:1", 42, ""], note: 7 }]);
		expect(out.rows[0]).toEqual({ id: "F1", loci: ["a.md:1"], note: "" });
	});
});

describe("adjudicateFindingResolutionGate (decision table)", () => {
	it("all injected mapped → no bounce", () => {
		const d = adjudicateFindingResolutionGate(base());
		expect(d.bounce).toBe(false);
		expect(d.missing).toEqual([]);
		expect(d.feedback).toBe("");
	});
	it("an unaddressed injected id → bounce naming exactly the missing ids (the E1 receipt case)", () => {
		const d = adjudicateFindingResolutionGate(base({ resolutions: [{ id: "BDD26-F01", loci: ["x"], note: "y" }] }));
		expect(d.bounce).toBe(true);
		expect(d.missing).toEqual(["CF-implementation-1nl0mhr"]);
		expect(d.feedback).toContain("CF-implementation-1nl0mhr");
		expect(d.feedback).toContain("findingResolutions");
	});
	it("absent control → every injected id missing → bounce (silence is not coverage)", () => {
		const d = adjudicateFindingResolutionGate(base({ resolutions: undefined }));
		expect(d.bounce).toBe(true);
		expect(d.missing).toEqual(base().injectedIds);
	});
	it("malformed rows never mint coverage (an id-less row counts as missing)", () => {
		const d = adjudicateFindingResolutionGate(base({ resolutions: [{ loci: ["x"], note: "quotes the remedy" }] }));
		expect(d.bounce).toBe(true);
		expect(d.missing).toEqual(base().injectedIds);
		expect(d.malformedRows).toBe(1);
	});
	it("inherited-green findings are exempt from re-mapping (WS1×WS6 composition)", () => {
		const d = adjudicateFindingResolutionGate(base({
			resolutions: [{ id: "BDD26-F01", loci: ["x"], note: "y" }],
			inheritedGreen: new Set(["CF-implementation-1nl0mhr"]),
		}));
		expect(d.bounce).toBe(false);
	});
	it("kill-switch disabled → missing ids reported but never bounced", () => {
		const d = adjudicateFindingResolutionGate(base({ resolutions: [] }), false);
		expect(d.enabled).toBe(false);
		expect(d.bounce).toBe(false);
		expect(d.missing).toEqual(base().injectedIds);
	});
	it("rows for ids that were not injected are neither missing nor malformed", () => {
		const d = adjudicateFindingResolutionGate(base({
			resolutions: [...(base().resolutions as unknown[]), { id: "UNKNOWN-F9", loci: ["z"], note: "w" }],
		}));
		expect(d.bounce).toBe(false);
	});
	it("empty injected set never bounces regardless of control", () => {
		const d = adjudicateFindingResolutionGate(base({ injectedIds: [], resolutions: undefined }));
		expect(d.bounce).toBe(false);
	});
});

describe("findingResolutionGateEnabled (kill-switch, lazy env)", () => {
	it("defaults enabled; the three falsy spellings disable", () => {
		expect(findingResolutionGateEnabled()).toBe(true);
		const saved = process.env.SUPER_DEV_NO_COVERAGE_BOUNCE;
		try {
			for (const v of ["1", "true", "yes"]) {
				process.env.SUPER_DEV_NO_COVERAGE_BOUNCE = v;
				expect(findingResolutionGateEnabled()).toBe(false);
			}
			process.env.SUPER_DEV_NO_COVERAGE_BOUNCE = "0";
			expect(findingResolutionGateEnabled()).toBe(true);
		} finally {
			if (saved === undefined) delete process.env.SUPER_DEV_NO_COVERAGE_BOUNCE;
			else process.env.SUPER_DEV_NO_COVERAGE_BOUNCE = saved;
		}
	});
});
