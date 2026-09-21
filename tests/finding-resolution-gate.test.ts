/**
 * WS1 (066 §2) — the finding-resolution gate decision core, L0 grammar +
 * decision tables. The wiring (artifact-convergence bounce) lands as the next
 * increment; these pins hold the CONTRACT the wiring must consume.
 */

import { describe, it, expect } from "vitest";
import { adjudicateFindingResolutionGate, findingResolutionGateEnabled, validatorBounceEnabled, parseFindingResolutions, resolveAnchors, type FindingResolutionGateInput } from "../src/convergence-economy/finding-resolution-gate.ts";
import { designatedBounceFindings } from "../src/stages/artifact-convergence/validators.ts";

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

describe("validatorBounceEnabled (WS2 kill-switch, lazy env)", () => {
	it("defaults enabled; the three falsy spellings disable", () => {
		expect(validatorBounceEnabled()).toBe(true);
		const saved = process.env.SUPER_DEV_NO_VALIDATOR_BOUNCE;
		try {
			for (const v of ["1", "true", "yes"]) {
				process.env.SUPER_DEV_NO_VALIDATOR_BOUNCE = v;
				expect(validatorBounceEnabled()).toBe(false);
			}
		} finally {
			if (saved === undefined) delete process.env.SUPER_DEV_NO_VALIDATOR_BOUNCE;
			else process.env.SUPER_DEV_NO_VALIDATOR_BOUNCE = saved;
		}
	});
});

describe("designatedBounceFindings (WS2 class table — live-run message shapes)", () => {
	it("matches the three designated classes", () => {
		const out = designatedBounceFindings([
			"bdd SCENARIO-054 pinOwnership cites unknown pinId pin-pe-11tb30l — cite only pinIds present in the injected slice",
			"bdd write-claim on docs/requirements/20-tooling.md contradicts a pin in bdd's OWN artifact",
			"bdd writes src/persistence.ts which carries a foreign pin pin-xn-00fsa30",
		]);
		expect(out.length).toBe(3);
	});
	it("leaves non-designated advisories advisory", () => {
		const out = designatedBounceFindings([
			"36 further pin(s) on the touched surfaces exceed the injected slice cap",
			"some other advisory noise",
		]);
		expect(out.length).toBe(0);
	});
});

describe("resolveAnchors (WS3 mechanical layer — anchor nonexistent ≈ 100% recall)", () => {
	const exists = (p: string) => p === "01-requirements.md" || p === "docs/spec/03-bdd.md";
	it("resolves path:line, path#fragment, and bare-path forms", () => {
		const out = resolveAnchors(["01-requirements.md:18", "docs/spec/03-bdd.md#AC-01", "01-requirements.md"], exists);
		expect(out.unresolved).toEqual([]);
		expect(out.checked).toBe(3);
	});
	it("flags absent files, spaces, and empty path parts as unresolved", () => {
		const out = resolveAnchors(["nope.md:5", "has space.md:3", ":12"], exists);
		expect(out.unresolved.length).toBe(3);
	});
	it("skips empty loci (checked stays honest)", () => {
		const out = resolveAnchors(["", "   ", "01-requirements.md:1"], exists);
		expect(out.checked).toBe(1);
		expect(out.unresolved).toEqual([]);
	});
});

describe("WS6 patch-mode", () => {
	it("directive names the three patch rules; soft check handles absent/malformed/declared controls", async () => {
		const { patchModeDirective, changedSectionsSoftCheck } = await import("../src/convergence-economy/patch-mode.ts");
		const d = patchModeDirective();
		expect(d).toContain("Patch mode (route-back revision)");
		expect(d).toContain("changedSections");
		expect(changedSectionsSoftCheck(undefined).note).toContain("absent");
		expect(changedSectionsSoftCheck({ changedSections: ["x.md:1", 42, ""] }).declared).toBe(1);
		expect(changedSectionsSoftCheck({ changedSections: [] }).note).toContain("absent");
	});
});

describe("stripMalformedResolutionRows (067 grill-2 Q1 — row-seam strict, array-seam lenient)", () => {
	it("one malformed row is stripped, not the whole control; clean arrays pass through by reference", async () => {
		const { stripMalformedResolutionRows } = await import("../src/convergence-economy/finding-resolution-gate.ts");
		const ctrl: Record<string, unknown> = { title: "t", findingResolutions: [{ id: "F1", loci: ["a"], note: "n" }, { loci: ["bad row no id"] }, null, { id: "  " }] };
		const out = stripMalformedResolutionRows(ctrl);
		expect((out.findingResolutions as unknown[]).length).toBe(1);
		expect(out.title).toBe("t");
		const clean: Record<string, unknown> = { title: "t", findingResolutions: [{ id: "F1", loci: [], note: "" }] };
		expect(stripMalformedResolutionRows(clean)).toBe(clean); // no-copy when clean
		const noField: Record<string, unknown> = { title: "t" };
		expect(stripMalformedResolutionRows(noField)).toBe(noField);
	});
});

describe("067 R5 convergence pins", () => {
	it("R5-Q3: CONTROL_SCHEMA_VERSION is pinned — a bump is a deliberate act (the resume salt consumes it)", async () => {
		const { CONTROL_SCHEMA_VERSION } = await import("../src/render/schemas.ts");
		expect(CONTROL_SCHEMA_VERSION).toBe("2");
	});
	it("R5-Q4: every convergence node carries EXACTLY ONE walk-scoped writer-bounce budget (the round-4 drift class)", async () => {
		const fs = await import("node:fs");
		const spec = fs.readFileSync("src/stages/spec-convergence.ts", "utf8");
		const node = fs.readFileSync("src/stages/artifact-convergence/node.ts", "utf8");
		const countDecl = (src: string, name: string) => (src.match(new RegExp(`let ${name} = false;`, "g")) ?? []).length;
		expect(countDecl(spec, "specWriterBounceSpent")).toBe(1);
		expect(countDecl(spec, "specWriterResolutionBounceSpent")).toBe(0);
		expect(countDecl(node, "writerBounceSpent")).toBe(1);
	});
});
