/**
 * Spec Deliverable Declaration — RED-phase tests for Layer 2
 * (AC-04/AC-05 → SCENARIO-018..020).
 *
 * These tests DEFINE the end-to-end `phase.deliverables` plumbing BEFORE it is
 * implemented across three pure type/string change sites:
 *
 *   1. src/render/schemas.ts  — SpecificationData.phases element gains an OPTIONAL
 *      `deliverables` object ({ requireFiles, requireContains, requireNotContains,
 *      requireTests }), all-optional so specs without deliverables validate
 *      identically (backward compat).
 *   2. src/doc-validators.ts  — normalizePhases() return type widens from
 *      { name, description? } to { name, description?, deliverables? } so a
 *      declared deliverables object round-trips and is statically typed.
 *   3. src/prompts.ts         — buildSpecPrompt() gains (a) the `deliverables?`
 *      token in the phases "data to return" bullet and (b) an explicit
 *      instruction that a phase whose deliverable is NOT compiler-checkable
 *      (creating a file, wiring a call site X→Y, adding a named test, making new
 *      sources reachable) MUST declare deliverables naming requireFiles /
 *      requireContains+requireNotContains / requireTests, AND-ed with build-green.
 *
 * They are RED until Phase 2 (Layer 2) lands: the prompt bullet currently reads
 * `{ name, description }`, the schema declares no `deliverables` property, and
 * normalizePhases' return type omits `deliverables`. No runtime behavior change
 * is expected in this layer — these are schema/type/prompt contract locks.
 */

import { describe, it, expect } from "vitest";
import { SpecificationData } from "../src/render/schemas.ts";
import { normalizePhases } from "../src/doc-validators.ts";
import { buildSpecPrompt } from "../src/prompts.ts";
import { Value } from "typebox/value";
import type { SetupControl } from "../src/types.ts";

function mkSetup(dir: string): SetupControl {
	return {
		worktreePath: dir,
		specDirectory: `${dir}/`,
		defaultBranch: "main",
		language: "backend",
		isWebUi: false,
		specIdentifier: "test",
		worktreeCreated: true,
		initializedRepo: false,
	};
}

/** Minimal structurally-valid SpecificationData payload (all required fields). */
function minimalSpec(): Record<string, unknown> {
	return {
		title: "Per-Phase Deliverable Assertions",
		date: "2026-07-21",
		summary: "Add a per-phase deliverable contract AND-ed with build-green.",
		architecture: "Three cooperating layers (checker, declaration, verdict).",
		testingStrategy: "vitest + tsc --noEmit strict.",
		scenarioRefs: ["SCENARIO-018", "SCENARIO-019", "SCENARIO-020"],
		phases: [{ name: "Layer 2", description: "schema + normalizer + prompt" }],
		tasks: [{ phase: "Layer 2", description: "extend SpecificationData + normalizePhases + buildSpecPrompt" }],
	};
}

// ─── SCENARIO-018: buildSpecPrompt elicits deliverables ─────────────────────

describe("SCENARIO-018 — buildSpecPrompt elicits phase deliverables", () => {
	const s = mkSetup("/tmp/sd-spec-deliv-prompt");

	it("includes the `deliverables?` token in the phases data-to-return bullet", () => {
		const p = buildSpecPrompt(s, null, "t", null, null, null, null, null);
		// The phases bullet must ask for deliverables as an OPTIONAL field, i.e.
		// the bullet reads `{ name, description, deliverables? }` (not the old
		// `{ name, description }`). Asserting the deliverables token appears in
		// the phases line specifically.
		expect(p).toMatch(/phases:.*\{ name, description, deliverables\? \}/);
	});

	it("names all four deliverable sub-checks in an explicit declaration instruction", () => {
		const p = buildSpecPrompt(s, null, "t", null, null, null, null, null);
		// The prompt must instruct the agent to declare deliverables and must name
		// every sub-check so a non-compiler-checkable phase cannot compile green
		// while delivering nothing.
		expect(p).toContain("deliverables");
		expect(p).toContain("requireFiles");
		expect(p).toContain("requireContains");
		expect(p).toContain("requireNotContains");
		expect(p).toContain("requireTests");
	});

	it("explains the AND-ed-with-build-green intent for non-compiler-checkable phases", () => {
		const p = buildSpecPrompt(s, null, "t", null, null, null, null, null);
		// Must motivate WHY: a phase that creates a file / wires a call site /
		// adds a test compiles green while delivering nothing without these.
		expect(p.toLowerCase()).toMatch(/compile.*green|compiles green|deliver.*nothing/);
	});
});

// ─── SCENARIO-019: schema accepts phases[].deliverables ─────────────────────

describe("SCENARIO-019 — SpecificationData declares phases[].deliverables (present)", () => {
	it("structurally declares a `deliverables` property on the phases element", () => {
		// TypeBox object graphs are plain JSON-schema objects, so we can
		// introspect the schema directly: SpecificationData.phases.items.properties
		// must now expose a `deliverables` key. Currently it only has name/description.
		const phaseItemProps = (SpecificationData as unknown as {
			properties: { phases: { items: { properties: Record<string, unknown> } } };
		}).properties.phases.items.properties;
		expect(phaseItemProps).toHaveProperty("deliverables");
	});

	it("declares all four optional sub-checks under deliverables", () => {
		const deliverablesSchema = (SpecificationData as unknown as {
			properties: {
				phases: { items: { properties: { deliverables?: { properties?: Record<string, unknown> } } } };
			};
		}).properties.phases.items.properties.deliverables;
		const props = deliverablesSchema?.properties ?? {};
		expect(props).toHaveProperty("requireFiles");
		expect(props).toHaveProperty("requireContains");
		expect(props).toHaveProperty("requireNotContains");
		expect(props).toHaveProperty("requireTests");
	});

	it("validates a phases entry that declares a full deliverables object", () => {
		const spec = minimalSpec();
		(spec.phases as Array<Record<string, unknown>>)[0].deliverables = {
			requireFiles: ["src/foo.ts"],
			requireContains: [{ file: "src/foo.ts", pattern: "fetch_us_data" }],
			requireNotContains: [{ file: "src/foo.ts", pattern: "_ => \\{\\}" }],
			requireTests: ["fetches us market data"],
		};
		// With deliverables declared, the payload must still validate cleanly.
		expect(Value.Check(SpecificationData, spec)).toBe(true);
		expect([...Value.Errors(SpecificationData, spec)]).toEqual([]);
	});

	it("deliverables is OPTIONAL on the phases element (required array does not list it)", () => {
		const phaseItem = (SpecificationData as unknown as {
			properties: { phases: { items: { required?: string[] } } };
		}).properties.phases.items;
		// Backward-compat guarantee: deliverables must NOT be a required key.
		expect((phaseItem.required ?? []).includes("deliverables")).toBe(false);
	});
});

// ─── SCENARIO-020: schema validates identically when deliverables absent ────

describe("SCENARIO-020 — SpecificationData validates identically when deliverables absent (backward compat)", () => {
	it("validates a spec whose phases carry only name + description", () => {
		// A spec authored today, before deliverables existed, must still validate.
		const spec = minimalSpec();
		expect(Value.Check(SpecificationData, spec)).toBe(true);
		expect([...Value.Errors(SpecificationData, spec)]).toEqual([]);
	});

	it("validates a mix of phases with and without deliverables", () => {
		const spec = minimalSpec();
		(spec.phases as Array<Record<string, unknown>>).push(
			{ name: "With deliverables", description: "d", deliverables: { requireFiles: ["a.ts"] } },
			{ name: "Without deliverables", description: "d2" },
		);
		expect(Value.Check(SpecificationData, spec)).toBe(true);
		expect([...Value.Errors(SpecificationData, spec)]).toEqual([]);
	});
});

// ─── normalizePhases round-trips deliverables (typed) ───────────────────────

describe("normalizePhases — round-trips a deliverables object onto the typed output", () => {
	it("preserves deliverables on a well-formed phase entry", () => {
		const deliverables = {
			requireFiles: ["src/screen.rs"],
			requireContains: [{ file: "src/screen.rs", pattern: "fetch_us_data" }],
			requireNotContains: [{ file: "src/screen.rs", pattern: "with_retry" }],
			requireTests: ["us_market_data"],
		};
		const out = normalizePhases([{ name: "Phase 5", description: "wire data", deliverables }]);
		expect(out).toEqual([{ name: "Phase 5", description: "wire data", deliverables }]);
		// The round-tripped deliverables object must be the SAME reference and shape
		// so downstream consumers (implementation stage) read typed phase.deliverables.
		expect(out[0].deliverables).toBe(deliverables);
	});

	it("keeps delivering { name, description? }-only phases when deliverables is absent", () => {
		// Existing behavior (the suite in doc-validators.test.ts) must hold: no
		// deliverables key is synthesized for phases that never declared one.
		const out = normalizePhases([{ name: "P1", description: "d" }, { name: "P2" }]);
		expect(out).toEqual([{ name: "P1", description: "d" }, { name: "P2" }]);
		expect((out[0] as { deliverables?: unknown }).deliverables).toBeUndefined();
	});

	it("still drops malformed entries (no name) even if they carry deliverables", () => {
		// Crash-guard invariant preserved: a deliverables object must not rescue an
		// otherwise-invalid (nameless) phase entry.
		const out = normalizePhases([{ description: "no name", deliverables: { requireFiles: ["x.ts"] } }, { name: "ok" }]);
		expect(out).toEqual([{ name: "ok" }]);
	});
});
