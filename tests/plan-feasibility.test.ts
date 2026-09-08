/**
 * v0.3.79 Wave A1 — plan-feasibility validator (spec-25 deep analysis,
 * docs/findings/deep-analysis-2026-09-08-spec25.md).
 *
 * The plan is a program nobody type-checks: run 2026-09-07T14-14-09-937Z
 * executed a 10-phase plan for ~2h on phase-01 alone because phase-01's
 * deliverable clause (requireContains CROSS_CUTTING_CITATION_FIELDS in
 * tests/catalyst-contract.test.ts) is satisfiable only by editing
 * src/stages.ts — a file the plan declares a deliverable of LATER phase
 * phase-09 — so every satisfiable fix was BLOCKED and reverted by the
 * phase-boundary guard (implementation.ts:2951). A deterministic validator
 * must catch this at plan time (spec close, before Stage 9) — the cheapest
 * correction point (SDLC playbook: plan review before code).
 *
 * Contract:
 *  - clause-target contradiction: a phase's clause targets a file the plan
 *    declares a deliverable of a LATER phase → blocking finding naming both.
 *  - cross-phase identifier contradiction: an EARLIER phase's test-file
 *    clause requires identifier X whose only plan-positioned production
 *    introduction lives in a LATER phase's production file, and X is not
 *    already exported at HEAD from any file the earlier phase may write →
 *    blocking finding (the spec-25 shape).
 *  - shared-file coupling + missing coverage tooling → advisories.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, mkdirSync as mkDir } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { planFeasibilityFindings } from "../src/stages/plan-feasibility.ts";
import type { PlanPhase } from "../src/stages/plan-feasibility.ts";

let wt: string;
beforeEach(() => {
	wt = mkdtempSync(join(tmpdir(), "sd-planfeas-"));
});
afterEach(() => {
	rmSync(wt, { recursive: true, force: true });
});

const writeWt = (rel: string, content: string) => {
	const p = join(wt, rel);
	mkDir(join(p, ".."), { recursive: true });
	writeFileSync(p, content);
};

/** The spec-25 incident shape, verbatim from run 14-14's parsed plan. */
const spec25Phases = (): PlanPhase[] => [
	{
		name: "catalyst-contract-shard",
		deliverables: {
			requireContains: [
				{ file: "tests/catalyst-contract.test.ts", pattern: "CROSS_CUTTING_CITATION_FIELDS" },
			],
		},
	},
	{ name: "filler-phase", deliverables: { requireFiles: ["docs/notes.md"] } },
	{
		name: "ts-thesis-stage-wiring-unit",
		deliverables: {
			requireContains: [
				{ file: "src/stages.ts", pattern: "CROSS_CUTTING_CITATION_FIELDS" },
			],
		},
	},
];

describe("v0.3.79 A1 plan-feasibility validator", () => {
	it("cross-phase identifier contradiction: earlier test clause needs an identifier positioned only in a later phase's production file (run 14-14 shape)", () => {
		writeWt("tests/catalyst-contract.test.ts", `import { expect } from "vitest";\n`);
		writeWt("src/stages.ts", `export const OTHER = 1;\n`);
		const report = planFeasibilityFindings(spec25Phases(), wt);
		expect(report.contradictions).toHaveLength(1);
		const c = report.contradictions[0];
		expect(c.kind).toBe("cross-phase-identifier");
		expect(c.blocking).toBe(true);
		expect(c.title).toContain("CROSS_CUTTING_CITATION_FIELDS");
		// names BOTH ends of the contradiction so the replan finding is actionable
		expect(c.evidence.join(" ")).toContain("catalyst-contract-shard");
		expect(c.evidence.join(" ")).toContain("ts-thesis-stage-wiring-unit");
		expect(c.evidence.join(" ")).toContain("tests/catalyst-contract.test.ts");
		expect(c.evidence.join(" ")).toContain("src/stages.ts");
	});

	it("no contradiction when the identifier is already exported at HEAD from the later-owned file (import is satisfiable)", () => {
		writeWt("tests/catalyst-contract.test.ts", `import { expect } from "vitest";\n`);
		writeWt("src/stages.ts", `export const CROSS_CUTTING_CITATION_FIELDS = ["a", "b"] as const;\n`);
		const report = planFeasibilityFindings(spec25Phases(), wt);
		expect(report.contradictions.filter((c) => c.kind === "cross-phase-identifier")).toHaveLength(0);
	});

	it("clause-target contradiction: a LATER phase forbids (requireNotContains) exactly what an earlier phase requires in the same file — mutually unsatisfiable at audit time", () => {
		const phases: PlanPhase[] = [
			{ name: "phase-one", deliverables: { requireContains: [{ file: "src/shared.ts", pattern: "wiredThing" }] } },
			{ name: "phase-two", deliverables: { requireFiles: ["docs/a.md"] } },
			{ name: "phase-three", deliverables: { requireNotContains: [{ file: "src/shared.ts", pattern: "wiredThing" }] } },
		];
		const report = planFeasibilityFindings(phases, wt);
		const c = report.contradictions.find((x) => x.kind === "clause-target-ownership");
		expect(c).toBeDefined();
		expect(c?.blocking).toBe(true);
		expect(c?.title).toContain("src/shared.ts");
		expect(c?.title).toContain("wiredThing");
		expect(c?.evidence.join(" ")).toContain("phase-one");
		expect(c?.evidence.join(" ")).toContain("phase-three");
	});

	it("a clause file shared by earlier+later phases (both write) is an advisory, not a contradiction — the earlier phase's own declared scope covers it", () => {
		const phases: PlanPhase[] = [
			{ name: "phase-one", deliverables: { requireContains: [{ file: "src/shared.ts", pattern: "SCHEMA_ALPHA" }] } },
			{ name: "phase-three", deliverables: { requireFiles: ["src/shared.ts"] } },
		];
		const report = planFeasibilityFindings(phases, wt);
		expect(report.contradictions).toHaveLength(0);
		expect(report.advisories.find((x) => x.kind === "shared-file-coupling")).toBeDefined();
	});

	it("later-references-earlier ordering is satisfiable (no contradiction)", () => {
		const phases: PlanPhase[] = [
			{ name: "producer", deliverables: { requireContains: [{ file: "src/registry.ts", pattern: "WIDGET_REGISTRY" }] } },
			{ name: "consumer", deliverables: { requireContains: [{ file: "tests/registry.test.ts", pattern: "WIDGET_REGISTRY" }] } },
		];
		writeWt("src/registry.ts", "");
		writeWt("tests/registry.test.ts", "");
		const report = planFeasibilityFindings(phases, wt);
		expect(report.contradictions).toHaveLength(0);
	});

	it("shared-file coupling is an advisory, not a contradiction", () => {
		const phases: PlanPhase[] = [
			{ name: "phase-a", deliverables: { requireContains: [{ file: "src/schemas.ts", pattern: "SCHEMA_ALPHA" }] } },
			{ name: "phase-b", deliverables: { requireContains: [{ file: "src/schemas.ts", pattern: "SCHEMA_BETA" }] } },
		];
		const report = planFeasibilityFindings(phases, wt);
		expect(report.contradictions).toHaveLength(0);
		const a = report.advisories.find((x) => x.kind === "shared-file-coupling");
		expect(a).toBeDefined();
		expect(a?.blocking).toBe(false);
		expect(a?.title).toContain("src/schemas.ts");
	});

	it("coverage tooling preflight: vitest-family tests without @vitest/coverage-v8 → advisory naming the UNMEASURABLE outcome", () => {
		const phases: PlanPhase[] = [
			{ name: "p1", deliverables: { requireTests: ["tests/unit.test.ts"] } },
		];
		writeWt("tests/unit.test.ts", `import { expect } from "vitest";\n`);
		const report = planFeasibilityFindings(phases, wt);
		const a = report.advisories.find((x) => x.kind === "coverage-tooling");
		expect(a).toBeDefined();
		expect(a?.title).toContain("@vitest/coverage-v8");
		expect(a?.title.toLowerCase()).toContain("unmeasurable");
	});

	it("coverage tooling preflight: installed coverage package → no advisory", () => {
		const phases: PlanPhase[] = [
			{ name: "p1", deliverables: { requireTests: ["tests/unit.test.ts"] } },
		];
		writeWt("tests/unit.test.ts", `import { expect } from "vitest";\n`);
		writeWt("package.json", JSON.stringify({ devDependencies: { "@vitest/coverage-v8": "^3.0.0" } }));
		const report = planFeasibilityFindings(phases, wt);
		expect(report.advisories.find((x) => x.kind === "coverage-tooling")).toBeUndefined();
	});

	it("coverage preflight also accepts the installed node_modules dir", () => {
		const phases: PlanPhase[] = [
			{ name: "p1", deliverables: { requireTests: ["tests/unit.test.ts"] } },
		];
		writeWt("tests/unit.test.ts", "");
		mkDir(join(wt, "node_modules", "@vitest", "coverage-v8"), { recursive: true });
		const report = planFeasibilityFindings(phases, wt);
		expect(report.advisories.find((x) => x.kind === "coverage-tooling")).toBeUndefined();
	});

	it("clean plan → empty report", () => {
		const phases: PlanPhase[] = [
			{ name: "p1", deliverables: { requireFiles: ["src/one.ts"], requireContains: [{ file: "src/one.ts", pattern: "exportOne" }] } },
			{ name: "p2", deliverables: { requireFiles: ["src/two.ts"], requireContains: [{ file: "src/two.ts", pattern: "exportTwo" }] } },
		];
		writeWt("src/one.ts", "");
		writeWt("src/two.ts", "");
		const report = planFeasibilityFindings(phases, wt);
		expect(report.contradictions).toHaveLength(0);
		expect(report.advisories).toHaveLength(0);
	});

	it("ADV-v0379-2a: a Python later-file def/class at HEAD is import-satisfiable (no false contradiction)", () => {
		const phases: PlanPhase[] = [
			{ name: "p1", deliverables: { requireContains: [{ file: "tests/test_handlers.py", pattern: "SIGNAL_HANDLER" }] } },
			{ name: "p2", deliverables: { requireContains: [{ file: "src/handlers.py", pattern: "SIGNAL_HANDLER" }] } },
		];
		writeWt("tests/test_handlers.py", "");
		writeWt("src/handlers.py", "class SIGNAL_HANDLER:\n    pass\n");
		const report = planFeasibilityFindings(phases, wt);
		expect(report.contradictions).toHaveLength(0);
	});

	it("ADV-v0379-2b: production code under a bare spec/ dir is NOT test-family for the cross-phase check", () => {
		const phases: PlanPhase[] = [
			{ name: "p1", deliverables: { requireContains: [{ file: "spec/registry.ts", pattern: "ENDPOINT_TABLE" }] } },
			{ name: "p2", deliverables: { requireContains: [{ file: "src/api.ts", pattern: "ENDPOINT_TABLE" }] } },
		];
		writeWt("spec/registry.ts", "");
		writeWt("src/api.ts", "");
		const report = planFeasibilityFindings(phases, wt);
		expect(report.contradictions.filter((c) => c.kind === "cross-phase-identifier")).toHaveLength(0);
	});

	it("ADV-v0379-2c: single-word ALLCAPS literals (PIPELINE) are not import identifiers — no contradiction", () => {
		const phases: PlanPhase[] = [
			{ name: "p1", deliverables: { requireContains: [{ file: "tests/smoke.test.ts", pattern: "PIPELINE" }] } },
			{ name: "p2", deliverables: { requireContains: [{ file: "src/banner.ts", pattern: "PIPELINE" }] } },
		];
		writeWt("tests/smoke.test.ts", "");
		writeWt("src/banner.ts", 'const banner = () => "SUPER PIPELINE v2";\nexport { banner };\n');
		const report = planFeasibilityFindings(phases, wt);
		expect(report.contradictions).toHaveLength(0);
	});

	it("ADV-v0379 mirrored check 1: an EARLIER requireNotContains vs a LATER requireContains on the same file+pattern also contradicts", () => {
		const phases: PlanPhase[] = [
			{ name: "phase-one", deliverables: { requireNotContains: [{ file: "src/shared.ts", pattern: "wiredThing" }] } },
			{ name: "phase-two", deliverables: { requireFiles: ["docs/b.md"] } },
			{ name: "phase-three", deliverables: { requireContains: [{ file: "src/shared.ts", pattern: "wiredThing" }] } },
		];
		const report = planFeasibilityFindings(phases, wt);
		const c = report.contradictions.find((x) => x.kind === "clause-target-ownership");
		expect(c).toBeDefined();
		expect(c?.title).toContain("earlier phase");
	});

	it("contradiction findings carry ownerStage=spec so the replan router routes them deterministically", () => {
		writeWt("tests/catalyst-contract.test.ts", "");
		writeWt("src/stages.ts", "");
		const report = planFeasibilityFindings(spec25Phases(), wt);
		for (const c of report.contradictions) {
			expect((c as unknown as { ownerStage?: string }).ownerStage).toBe("spec");
		}
	});

	it("empty/edge plans never throw", () => {
		expect(planFeasibilityFindings([], wt)).toEqual({ contradictions: [], advisories: [] });
		expect(planFeasibilityFindings([{ name: undefined, deliverables: undefined }], wt).contradictions).toHaveLength(0);
		expect(existsSync(wt)).toBe(true);
	});
});
