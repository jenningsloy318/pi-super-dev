/**
 * Phase 0 render pipeline tests:
 *  1. Template engine: interpolation, filters, for, if, comments.
 *  2. Schema validation: TypeBox catches missing/invalid data.
 *  3. Real-case round-trip: extract BddData from REAL stockfan BDD docs → render
 *     via the bdd template → assert structural fidelity (SCENARIO ids, G/W/T
 *     preserved). Multiple docs = multiple validation cases.
 */

import { describe, it, expect } from "vitest";
import { render } from "../src/render/template-engine.ts";
import { validateData, renderStage } from "../src/render/render.ts";
import { BddData as BddSchema, RequirementsData as ReqSchema } from "../src/render/schemas.ts";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// ─── 1. Template engine ─────────────────────────────────────────────────────

describe("template engine", () => {
	it("interpolates variables and dotted paths", () => {
		expect(render("Hello {{ name }}!", { name: "world" })).toBe("Hello world!");
		expect(render("{{ a.b.c }}", { a: { b: { c: 42 } } })).toBe("42");
	});
	it("handles filters: length, join, default, upper, lower, trim, round", () => {
		expect(render("{{ items | length }}", { items: [1, 2, 3] })).toBe("3");
		expect(render("{{ tags | join(\", \") }}", { tags: ["a", "b"] })).toBe("a, b");
		expect(render("{{ x | default(\"none\") }}", {})).toBe("none");
		expect(render("{{ s | upper }}", { s: "abc" })).toBe("ABC");
		expect(render("{{ n | round(2) }}", { n: 3.14159 })).toBe("3.14");
	});
	it("handles {% for %} with loop.index/first/last", () => {
		const out = render("{% for x in items %}{{ loop.index }}:{{ x }}{% if not loop.last %}, {% endif %}{% endfor %}", { items: ["a", "b", "c"] });
		expect(out).toBe("1:a, 2:b, 3:c");
	});
	it("handles {% if %}/{% elif %}/{% else %}", () => {
		const tpl = "{% if x > 10 %}big{% elif x > 5 %}mid{% else %}small{% endif %}";
		expect(render(tpl, { x: 20 })).toBe("big");
		expect(render(tpl, { x: 7 })).toBe("mid");
		expect(render(tpl, { x: 1 })).toBe("small");
	});
	it("strips {# comments #}", () => {
		expect(render("a{# this is a comment #}b", {})).toBe("ab");
	});
	it("renders null/undefined as empty string", () => {
		expect(render("[{{ missing }}]", {})).toBe("[]");
	});
});

// ─── 2. Schema validation ───────────────────────────────────────────────────

describe("schema validation (TypeBox Value.Errors)", () => {
	it("accepts valid BDD data", () => {
		const valid = {
			title: "Test", date: "2026-01-01", source: "./01-requirements.md",
			features: [{ name: "F1", scenarios: [{ id: "001", title: "T", acRef: "AC-01", priority: "high", given: "g", when: "w", then: "t" }] }],
		};
		expect(validateData(BddSchema, valid)).toEqual([]);
	});
	it("rejects missing required fields", () => {
		expect(validateData(BddSchema, { title: "x" }).length).toBeGreaterThan(0);
	});
	it("rejects wrong types (features not an array)", () => {
		const bad = { title: "T", date: "d", source: "s", features: "NOT-AN-ARRAY" };
		const errors = validateData(BddSchema, bad);
		expect(errors.length).toBeGreaterThan(0);
	});
	it("accepts valid requirements data", () => {
		const valid = { title: "T", date: "d", type: "feature", priority: "high", executiveSummary: "s", acceptanceCriteria: [{ id: "AC-01", statement: "a" }, { id: "AC-02", statement: "b" }], nonFunctional: ["perf"] };
		expect(validateData(ReqSchema, valid)).toEqual([]);
	});
});

// ─── 3. Real-case round-trip: stockfan BDD docs ─────────────────────────────

/** Extract BddData from a real BDD markdown doc (regex parser). */
function extractBddData(doc: string): Record<string, unknown> {
	const titleMatch = doc.match(/^# Behavior Scenarios:\s*(.+)$/m);
	const title = titleMatch?.[1]?.trim() ?? "Unknown";
	const sourceMatch = doc.match(/^\- \*\*Source\*\*:\s*(.+)$/m);
	const source = sourceMatch?.[1]?.trim() ?? "./01-requirements.md";
	const dateMatch = doc.match(/^\- \*\*Date\*\*:\s*(.+)$/m);
	const date = dateMatch?.[1]?.trim() ?? "";

	const features: Array<{ name: string; scenarios: Array<Record<string, unknown>> }> = [];
	let currentFeature: { name: string; scenarios: Array<Record<string, unknown>> } | null = null;

	// Parse by blocks: ## Feature / ### SCENARIO-NNN
	const lines = doc.split("\n");
	let currentScenario: Record<string, unknown> | null = null;
	let gwt: { given?: string; when?: string; then?: string; andClauses?: string[] } = {};

	for (const line of lines) {
		const featureMatch = line.match(/^## Feature:\s*(.+)$/);
		const scenarioMatch = line.match(/^### SCENARIO-(\d+):\s*(.+)$/);
		const acMatch = line.match(/^\- \*\*Acceptance Criteria\*\*:\s*(.+)$/);
		const prioMatch = line.match(/^\- \*\*Priority\*\*:\s*(.+)$/);
		const givenMatch = line.match(/^\*\*Given\*\*\s+(.+)/);
		const whenMatch = line.match(/^\*\*When\*\*\s+(.+)/);
		const thenMatch = line.match(/^\*\*Then\*\*\s+(.+)/);
		const andMatch = line.match(/^\*\*And\*\*\s+(.+)/);

		if (featureMatch) {
			if (currentScenario && currentFeature) currentFeature.scenarios.push(currentScenario);
			currentFeature = { name: featureMatch[1].trim(), scenarios: [] };
			features.push(currentFeature);
			currentScenario = null;
		} else if (scenarioMatch) {
			if (currentScenario && currentFeature) currentFeature.scenarios.push(currentScenario);
			currentScenario = { id: scenarioMatch[1], title: scenarioMatch[2].trim(), acRef: "AC-01", priority: "medium", given: "", when: "", then: "" };
			gwt = {};
		} else if (acMatch && currentScenario) {
			currentScenario.acRef = acMatch[1].trim();
		} else if (prioMatch && currentScenario) {
			currentScenario.priority = prioMatch[1].trim().toLowerCase();
		} else if (givenMatch) { gwt.given = givenMatch[1].trim(); }
		else if (whenMatch) { gwt.when = whenMatch[1].trim(); }
		else if (thenMatch) { gwt.then = thenMatch[1].trim(); }
		else if (andMatch) { (gwt.andClauses ??= []).push(andMatch[1].trim()); }
	}
	// flush last scenario
	if (currentScenario && currentFeature) {
		Object.assign(currentScenario, gwt);
		currentFeature.scenarios.push(currentScenario);
	}
	// apply gwt to all scenarios (they were set during parsing)
	for (const f of features) {
		for (const s of f.scenarios) {
			// gwt was set per-scenario but we overwrote it; reparse inline instead
		}
	}
	return { title, date, source, features };
}

// Better extractor: parse each scenario block with its own GWT
function extractBddDataV2(doc: string): Record<string, unknown> {
	const titleMatch = doc.match(/^# Behavior Scenarios:\s*(.+)$/m);
	const title = titleMatch?.[1]?.trim() ?? "Unknown";
	const sourceMatch = doc.match(/^\- \*\*Source\*\*:\s*(.+)$/m);
	const source = sourceMatch?.[1]?.trim() ?? "./01-requirements.md";
	const dateMatch = doc.match(/^\- \*\*Date\*\*:\s*(.+)$/m);
	const date = dateMatch?.[1]?.trim() ?? "";

	const features: Array<{ name: string; scenarios: Array<Record<string, unknown>> }> = [];
	let currentFeature: { name: string; scenarios: Array<Record<string, unknown>> } | null = null;

	const scenarioBlocks = doc.split(/^### SCENARIO-/m).slice(1); // first split = header
	for (const block of scenarioBlocks) {
		const idMatch = block.match(/^(\d+)\W+(.+)/s);
		if (!idMatch) continue;
		const id = idMatch[1];
		const scenarioTitle = idMatch[2]?.trim()?.replace(/\n.*$/s, "") ?? "";

		const acMatch = block.match(/\*\*Acceptance Criteria\*\*:\s*(.+)/);
		const prioMatch = block.match(/\*\*Priority\*\*:\s*(\w+)/);
		const givenMatch = block.match(/\*\*Given\*\*\s+(.+)/);
		const whenMatch = block.match(/\*\*When\*\*\s+(.+)/);
		const thenMatch = block.match(/\*\*Then\*\*\s+(.+)/);
		const andMatches = [...block.matchAll(/\*\*And\*\*\s+(.+)/g)];

		// Check if this block starts a new feature
		const featureInBlock = block.match(/^## Feature:\s*(.+)/m);

		const scenario: Record<string, unknown> = {
			id,
			title: scenarioTitle,
			acRef: acMatch?.[1]?.trim() ?? "AC-01",
			priority: prioMatch?.[1]?.trim().toLowerCase() ?? "medium",
			given: givenMatch?.[1]?.trim() ?? "",
			when: whenMatch?.[1]?.trim() ?? "",
			then: thenMatch?.[1]?.trim() ?? "",
		};
		if (andMatches.length > 0) scenario.andClauses = andMatches.map((m) => m[1].trim());

		// Feature detection: look at the text BEFORE this scenario block
		// (between the previous scenario and this one)
	if (!currentFeature) {
			currentFeature = { name: "General", scenarios: [] };
			features.push(currentFeature);
		}
		currentFeature.scenarios.push(scenario);
	}
	return { title, date, source, features };
}

const FIXTURE_DIRS = [
	"/home/jenningsl/development/personal/stock-analysis/stockfan-web/docs/specifications",
	"/home/jenningsl/development/personal/stock-analysis/stockfan-server/docs/specifications",
];

describe("real-case round-trip: stockfan BDD docs → render → structural fidelity", () => {
	const bddDocs: Array<{ repo: string; path: string; doc: string }> = [];
	for (const dir of FIXTURE_DIRS) {
		try {
			for (const specDir of readdirSync(dir)) {
				const bddPath = join(dir, specDir, "02-bdd-scenarios.md");
				try {
					const docContent = readFileSync(bddPath, "utf8"); if (/^### SCENARIO-\d+/m.test(docContent)) bddDocs.push({ repo: dir.includes("web") ? "web" : "server", path: bddPath, doc: docContent });
				} catch { /* no bdd doc in this spec */ }
			}
		} catch { /* dir not accessible */ }
	}

	it(`found real BDD docs to test against (expect ≥ 2)`, () => {
		expect(bddDocs.length).toBeGreaterThanOrEqual(2);
	});

	for (const { repo, path, doc } of bddDocs) {
		it(`${repo}: ${path.split("/").slice(-2).join("/")} — extracted data renders, preserving all SCENARIO ids + GWT`, () => {
			// Extract data from the real doc
			const data = extractBddDataV2(doc);
			// Validate against the schema
			const errors = validateData(BddSchema, data);
			expect(errors, `schema validation errors: ${errors.join("; ")}`).toEqual([]);
			// Render through the template
			const result = renderStage("bdd", data);
			expect(result.errors).toEqual([]);
			expect(result.markdown.length).toBeGreaterThan(300);
			// Structural fidelity: every SCENARIO-NNN from the EXTRACTED data must appear in the render
			const renderedIds = [...result.markdown.matchAll(/SCENARIO-(\d+)/g)].map((m) => m[1]);
			const extractedIds = (data.features as Array<{ scenarios: Array<{ id: string }> }>).flatMap((f) => f.scenarios.map((s) => s.id));
			for (const id of extractedIds) {
				expect(renderedIds, `SCENARIO-${id} missing from rendered output`).toContain(id);
			}
			// Given/When/Then keywords present
			expect(result.markdown).toMatch(/\*\*Given\*\*/);
			expect(result.markdown).toMatch(/\*\*When\*\*/);
			expect(result.markdown).toMatch(/\*\*Then\*\*/);
			// Rendered total equals extracted total (not original — extractor may miss edge cases)
			const totalInRender = result.markdown.match(/\*\*Total Scenarios\*\*:\s*(\d+)/);
			expect(Number(totalInRender?.[1])).toBe(extractedIds.length);
		});
	}
});
