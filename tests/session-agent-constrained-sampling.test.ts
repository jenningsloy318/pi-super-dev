/**
 * Phase 2 (Feature 2 / SCENARIO-009..013): constrained tool sampling for the
 * `structured_output` tool. Verifies:
 *  - `isStrictCapable` is the gate: true ONLY for a closed typebox Object
 *    (additionalProperties === false) with ≥1 required non-Optional key; false
 *    for the permissive controlSchema (all-Optional + additionalProperties:true),
 *    any open/unknown-key schema, and non-Object schemas.
 *  - `structuredOutputTool` attaches `constrainedSampling: { type: "json_schema",
 *    strict: "prefer" }` on the ToolDefinition ONLY when the effective schema is
 *    strict-capable, and is ABSENT (byte-identical to today) for the permissive
 *    controlSchema and open/unknown-key schemas.
 *  - `strictControlSchema` (the strict-capable variant) produces a schema
 *    `isStrictCapable` returns true for.
 *  - `missingKeys()` + the permissive fallback are preserved byte-identical as
 *    the non-capable-provider/permissive-schema fallback.
 */

import { describe, it, expect } from "vitest";
import { Type } from "typebox";
import {
	isStrictCapable,
	structuredOutputTool,
	strictControlSchema,
	missingKeys,
	type Capture,
} from "../src/session-agent.ts";
import {
	CodeReviewData,
	SpecReviewData,
	AdversarialReviewData,
	ImplementationSummaryData,
	RedReviewData,
} from "../src/render/schemas.ts";

// ─── schemas in the test vocabulary ─────────────────────────────────────────
const strictSchema = Type.Object(
	{ summary: Type.String(), scenarioCount: Type.Integer() },
	{ additionalProperties: false },
);
// The exact permissive shape controlSchema() emits today.
const permissiveAllOptional = Type.Object(
	{ summary: Type.Optional(Type.Any()), scenarioCount: Type.Optional(Type.Any()) },
	{ additionalProperties: true },
);
const requiredButOpenAdditional = Type.Object(
	{ summary: Type.String() },
	{ additionalProperties: true },
);
// additionalProperties undefined → open / unknown-key schema.
const openNoAdditional = Type.Object({ summary: Type.String() });

describe("isStrictCapable (SCENARIO-009..012)", () => {
	it("returns true for a closed Object with ≥1 required non-Optional key (SCENARIO-009)", () => {
		expect(isStrictCapable(strictSchema)).toBe(true);
	});

	it("returns true for a single required typed key (the slug-tool shape)", () => {
		expect(isStrictCapable(Type.Object({ slug: Type.String() }, { additionalProperties: false }))).toBe(true);
	});

	it("returns false for the permissive controlSchema shape (all-Optional + additionalProperties:true) — SCENARIO-010", () => {
		expect(isStrictCapable(permissiveAllOptional)).toBe(false);
	});

	it("returns false when additionalProperties is true even with required keys — SCENARIO-011", () => {
		expect(isStrictCapable(requiredButOpenAdditional)).toBe(false);
	});

	it("returns false when additionalProperties is undefined (open/unknown-key schema) — SCENARIO-011", () => {
		expect(isStrictCapable(openNoAdditional)).toBe(false);
	});

	it("returns false for a closed Object with NO required keys (all optional) — SCENARIO-010", () => {
		const allOptionalClosed = Type.Object(
			{ a: Type.Optional(Type.String()) },
			{ additionalProperties: false },
		);
		expect(isStrictCapable(allOptionalClosed)).toBe(false);
	});

	it("returns false for non-Object schemas (SCENARIO-012)", () => {
		expect(isStrictCapable(Type.String())).toBe(false);
		expect(isStrictCapable(Type.Integer())).toBe(false);
		expect(isStrictCapable(Type.Array(Type.String()))).toBe(false);
	});

	it("returns false for non-schema inputs without throwing", () => {
		expect(isStrictCapable(undefined)).toBe(false);
		expect(isStrictCapable(null)).toBe(false);
		expect(isStrictCapable({})).toBe(false);
		expect(isStrictCapable("object")).toBe(false);
		expect(isStrictCapable(42)).toBe(false);
	});
});

describe("strictControlSchema (the strict-capable variant)", () => {
	it("produces a schema isStrictCapable returns true for", () => {
		expect(isStrictCapable(strictControlSchema(["summary", "scenarioCount"]))).toBe(true);
	});

	it("declares every key required and closes the object (additionalProperties:false)", () => {
		const s = strictControlSchema(["a", "b", "c"]) as {
			additionalProperties?: unknown;
			required?: string[];
			properties?: Record<string, unknown>;
		};
		expect(s.additionalProperties).toBe(false);
		expect(s.required).toHaveLength(3);
		expect(s.required).toEqual(expect.arrayContaining(["a", "b", "c"]));
		expect(Object.keys(s.properties ?? {}).sort()).toEqual(["a", "b", "c"]);
	});

	it("is NOT strict-capable when called with no keys (empty object)", () => {
		expect(isStrictCapable(strictControlSchema([]))).toBe(false);
	});
});

describe("structuredOutputTool constrainedSampling gating (SCENARIO-009, 013)", () => {
	const freshCapture = (): Capture => ({ called: false, value: undefined });

	it("attaches constrainedSampling {type:json_schema, strict:prefer} when the effective schema is strict-capable", () => {
		const tool = structuredOutputTool(freshCapture(), ["summary"], strictSchema);
		expect(tool.constrainedSampling).toEqual({ type: "json_schema", strict: "prefer" });
	});

	it("attaches constrainedSampling when a strict schema is provided via the schema arg even with no keys", () => {
		const tool = structuredOutputTool(freshCapture(), [], strictSchema);
		expect(tool.constrainedSampling).toEqual({ type: "json_schema", strict: "prefer" });
	});

	it("attaches constrainedSampling when the strict-capable variant is the schema", () => {
		const tool = structuredOutputTool(freshCapture(), ["summary"], strictControlSchema(["summary"]));
		expect(tool.constrainedSampling).toEqual({ type: "json_schema", strict: "prefer" });
	});

	it("does NOT attach constrainedSampling for the permissive controlSchema (keys present) — byte-identical today (SCENARIO-013)", () => {
		const tool = structuredOutputTool(freshCapture(), ["summary", "scenarioCount"]);
		expect(tool.constrainedSampling).toBeUndefined();
	});

	it("does NOT attach constrainedSampling for an open/unknown-key schema", () => {
		const tool = structuredOutputTool(freshCapture(), ["summary"], openNoAdditional);
		expect(tool.constrainedSampling).toBeUndefined();
	});

	it("does NOT attach constrainedSampling for the permissive all-Optional schema even if passed explicitly", () => {
		const tool = structuredOutputTool(freshCapture(), ["summary"], permissiveAllOptional);
		expect(tool.constrainedSampling).toBeUndefined();
	});

	it("does NOT attach constrainedSampling when no keys and no schema are given", () => {
		const tool = structuredOutputTool(freshCapture(), []);
		expect(tool.constrainedSampling).toBeUndefined();
	});

	it("uses the caller-provided schema as the tool parameters (identity preserved)", () => {
		const tool = structuredOutputTool(freshCapture(), ["irrelevant"], strictSchema);
		expect(tool.parameters).toBe(strictSchema);
	});

	it("falls back to the permissive controlSchema when no schema is given", () => {
		const tool = structuredOutputTool(freshCapture(), ["summary"], undefined) as unknown as {
			parameters: { additionalProperties?: unknown; required?: unknown[] };
		};
		// The permissive controlSchema has additionalProperties:true and no required keys.
		expect(tool.parameters.additionalProperties).toBe(true);
		expect(tool.parameters.required ?? []).toEqual([]);
	});
});

describe("missingKeys + permissive fallback preserved byte-identical (SCENARIO-013)", () => {
	it("missingKeys behavior is unchanged from the existing session-agent suite", () => {
		expect(missingKeys(null, ["a", "b"])).toEqual(["a", "b"]);
		expect(missingKeys(undefined, ["a", "b"])).toEqual(["a", "b"]);
		expect(missingKeys({ a: 1, b: "" }, ["a", "b"])).toEqual(["b"]);
		expect(missingKeys({ a: 1, b: "x" }, ["a", "b"])).toEqual([]);
	});
});

describe("production stage schemas are strict-capable (F1/AR-01: Feature 2 is ACTIVE)", () => {
	// The headline acceptance criterion of Feature 2: a real pipeline stage with
	// a well-defined required-key schema gets constrained sampling in production.
	// Before this fix every render schema was an open Type.Object (additionalProperties
	// omitted), so isStrictCapable returned false for ALL of them and
	// constrainedSampling never attached. These schemas are now CLOSED.
	it("the well-defined review/summary schemas are strict-capable", () => {
		expect(isStrictCapable(CodeReviewData)).toBe(true);
		expect(isStrictCapable(SpecReviewData)).toBe(true);
		expect(isStrictCapable(AdversarialReviewData)).toBe(true);
		expect(isStrictCapable(ImplementationSummaryData)).toBe(true);
		expect(isStrictCapable(RedReviewData)).toBe(true);
	});

	it("structuredOutputTool attaches constrainedSampling when given a real stage schema", () => {
		const tool = structuredOutputTool({ called: false, value: undefined }, ["title", "verdict", "findings"], CodeReviewData);
		expect(tool.constrainedSampling).toEqual({ type: "json_schema", strict: "prefer" });
	});
});
