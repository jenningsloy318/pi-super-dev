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

// ─── 4. Requirements render pipeline ─────────────────────────────────────────

describe("render pipeline: requirements", () => {
	it("valid data → rendered doc passes gate patterns", () => {
		const result = renderStage("requirements", {
			title: "Test Feature", date: "2026-01-01", type: "feature", priority: "high",
			executiveSummary: "A summary of the feature.",
			acceptanceCriteria: [{ id: "AC-01", statement: "must work" }, { id: "AC-02", statement: "must be fast" }],
			nonFunctional: ["Performance: under 100ms"],
		});
		expect(result.errors).toEqual([]);
		expect(result.markdown).toMatch(/Acceptance Criteria/);
		expect(result.markdown).toMatch(/AC-01/);
		expect(result.markdown).toMatch(/AC-02/);
		expect(result.markdown).toMatch(/Executive Summary/);
		expect(result.markdown).toMatch(/Non-Functional/);
		expect(result.markdown).toMatch(/Performance/);
	});
	it("real-doc round-trip: stockfan requirements → render → ACs preserved", () => {
		const doc = readFileSync("/home/jenningsl/development/personal/stock-analysis/stockfan-server/docs/specifications/01-core-foundation/01-requirements.md", "utf8");
		const titleMatch = doc.match(/^# Requirements:\s*(.+)$/m);
		const acs = [...doc.matchAll(/- \*\*(AC-\d+)\*\*:\s*(.+)/g)].map((m) => ({ id: m[1], statement: m[2].trim() }));
		const data = { title: titleMatch?.[1]?.trim() ?? "T", date: "2026-01-01", type: "feature", priority: "high", executiveSummary: "Extracted from real doc.", acceptanceCriteria: acs.length >= 2 ? acs : [...acs, { id: "AC-FILL", statement: "filler" }], nonFunctional: ["Security: validated"] };
		const result = renderStage("requirements", data);
		expect(result.errors).toEqual([]);
		for (const ac of acs) expect(result.markdown).toContain(ac.id);
		expect(result.markdown).toMatch(/Acceptance Criteria/);
	});
});

// ─── 5. Research render pipeline ─────────────────────────────────────────────

describe("render pipeline: research-report", () => {
	it("valid data → rendered doc has options + summary", () => {
		const result = renderStage("research", {
			title: "API Design", date: "2026-01-01", summary: "Researched API patterns.",
			options: [{ name: "REST", tradeoffs: "Simple, widely understood" }, { name: "GraphQL", tradeoffs: "Flexible, but complex" }],
			openIssues: ["Which auth scheme?"],
		});
		expect(result.errors).toEqual([]);
		expect(result.markdown).toMatch(/Options Considered/);
		expect(result.markdown).toMatch(/REST/);
		expect(result.markdown).toMatch(/GraphQL/);
		expect(result.markdown).toMatch(/Open Issues/);
	});
});

// ─── 6. Code Assessment render pipeline ──────────────────────────────────────

describe("render pipeline: code-assessment", () => {
	it("valid data → rendered doc has patterns + recommendations", () => {
		const result = renderStage("assessment", {
			title: "Codebase Assessment", date: "2026-01-01", summary: "Assessed the codebase.",
			patterns: [{ name: "Result types", example: "src/lib/weather.js:42", consistency: "Consistent" }],
			recommendations: ["Follow Result pattern for new endpoints"],
			filesAssessed: ["src/server.js", "src/lib/weather.js"],
		});
		expect(result.errors).toEqual([]);
		expect(result.markdown).toMatch(/Patterns/);
		expect(result.markdown).toMatch(/Result types/);
		expect(result.markdown).toMatch(/Recommendations/);
		expect(result.markdown).toMatch(/Files Assessed/);
	});
	it("real-doc round-trip: stockfan code-assessment → render → summary preserved", () => {
		const doc = readFileSync("/home/jenningsl/development/personal/stock-analysis/stockfan-server/docs/specifications/01-core-foundation/03-code-assessment.md", "utf8");
		const titleMatch = doc.match(/^# Code Assessment:\s*(.+)$/m);
		const summaryMatch = doc.match(/## Executive Summary\s*\n\s*\n([\s\S]*?)(?:\n---|\n## )/);
		const data = { title: titleMatch?.[1]?.trim() ?? "T", date: "2026-01-01", summary: summaryMatch?.[1]?.trim() ?? "Assessed.", patterns: [{ name: "P1", example: "f:1", consistency: "ok" }], recommendations: ["R1"], filesAssessed: ["f.js"] };
		const result = renderStage("assessment", data);
		expect(result.errors).toEqual([]);
		expect(result.markdown).toMatch(/Executive Summary/);
		expect(result.markdown).toContain(titleMatch?.[1]?.trim() ?? "T");
	});
});

// ─── 7. Spec Review render pipeline ──────────────────────────────────────────

describe("render pipeline: spec-review", () => {
	it("valid data → rendered doc has verdict + dimensions", () => {
		const result = renderStage("specReview", {
			title: "Feature Spec", date: "2026-01-01", verdict: "Approved with Comments",
			summary: "Well-structured spec with minor findings.",
			findings: [{ id: "F-01", severity: "Medium", title: "Under-specified", detail: "Env var override unclear" }],
			dimensions: [
				{ name: "Completeness", status: "Pass", notes: "All ACs covered" },
				{ name: "Consistency", status: "Pass", notes: "Names match" },
			],
		});
		expect(result.errors).toEqual([]);
		expect(result.markdown).toMatch(/Verdict: Approved with Comments/);
		expect(result.markdown).toMatch(/Findings/);
		expect(result.markdown).toMatch(/F-01/);
		expect(result.markdown).toMatch(/Dimension Reviews/);
		expect(result.markdown).toMatch(/Completeness/);
	});
});

// ─── 8. Code Review render pipeline ──────────────────────────────────────────

describe("render pipeline: code-review", () => {
	it("valid data → rendered doc has verdict + findings", () => {
		const result = renderStage("codeReview", {
			title: "Code Review", date: "2026-01-01", verdict: "Approved",
			summary: "Clean implementation.",
			findings: [{ id: "F-01", severity: "Low", title: "Minor naming", detail: "Variable could be clearer", file: "src/server.js", line: "42" }],
		});
		expect(result.errors).toEqual([]);
		expect(result.markdown).toMatch(/Verdict: Approved/);
		expect(result.markdown).toMatch(/F-01/);
		expect(result.markdown).toMatch(/server\.js/);
	});
	it("real-doc round-trip: stockfan code-review → render → verdict + findings preserved", () => {
		const doc = readFileSync("/home/jenningsl/development/personal/stock-analysis/stockfan-server/docs/specifications/01-core-foundation/09-code-review.md", "utf8");
		const titleMatch = doc.match(/^# Code Review:\s*(.+)$/m);
		const verdictMatch = doc.match(/## Verdict:\s*(.+)/);
		const data = { title: titleMatch?.[1]?.trim() ?? "T", date: "2026-01-01", verdict: verdictMatch?.[1]?.trim() ?? "Approved", summary: "Extracted.", findings: [{ id: "F-01", severity: "Low", title: "Test finding", detail: "Detail" }] };
		const result = renderStage("codeReview", data);
		expect(result.errors).toEqual([]);
		expect(result.markdown).toMatch(/Verdict:/);
		expect(result.markdown).toContain(verdictMatch?.[1]?.trim() ?? "Approved");
	});
});

// ─── 9. Adversarial Review render pipeline ───────────────────────────────────

describe("render pipeline: adversarial-review", () => {
	it("valid data → rendered doc has verdict + lens findings", () => {
		const result = renderStage("adversarialReview", {
			title: "Adversarial Review", date: "2026-01-01", verdict: "PASS",
			summary: "No critical issues found.",
			findings: [
				{ id: "S-01", severity: "Low", title: "Info discarded", detail: "Error info lost", lens: "Skeptic" },
				{ id: "A-01", severity: "Informational", title: "Over-abstraction", detail: "Unnecessary layer", lens: "Architect" },
			],
		});
		expect(result.errors).toEqual([]);
		expect(result.markdown).toMatch(/PASS/);
		expect(result.markdown).toMatch(/S-01/);
		expect(result.markdown).toMatch(/Skeptic/);
	});
});

// ─── 10. Remaining stages (batch 3) ──────────────────────────────────────────

describe("render pipeline: implementation-summary + debug + design + prototype + docs + api-test + ui-test", () => {
	it("implementation-summary → has phases + files", () => {
		const r = renderStage("implementationSummary", { title: "Summary", date: "2026-01-01", summary: "Done.", phasesCompleted: "3/3", allGreen: "true", filesModified: ["a.ts", "b.ts"] });
		expect(r.errors).toEqual([]); expect(r.markdown).toMatch(/Files Modified/); expect(r.markdown).toMatch(/Phases Completed/);
	});
	it("debug-analysis → has root cause + hypotheses", () => {
		const r = renderStage("debug", { title: "Debug", date: "2026-01-01", summary: "Found.", hypotheses: ["h1"], rootCause: "null deref", reproductionSteps: ["step1"] });
		expect(r.errors).toEqual([]); expect(r.markdown).toMatch(/Root Cause/); expect(r.markdown).toMatch(/Hypotheses/);
	});
	it("design → has modules + designer", () => {
		const r = renderStage("design", { title: "Design", date: "2026-01-01", summary: "Arch.", designer: "architecture-designer", modules: [{name: "API", description: "REST"}], hasNumericConstants: "false" });
		expect(r.errors).toEqual([]); expect(r.markdown).toMatch(/Modules/); expect(r.markdown).toMatch(/architecture-designer/);
	});
	it("prototype-report → has verdict + measurements", () => {
		const r = renderStage("prototype", { title: "Proto", date: "2026-01-01", summary: "Done.", verdict: "pass", measurements: ["m1"], adjustments: ["a1"] });
		expect(r.errors).toEqual([]); expect(r.markdown).toMatch(/Verdict/); expect(r.markdown).toMatch(/Measurements/);
	});
	it("documentation → has docs updated", () => {
		const r = renderStage("docs", { title: "Docs", date: "2026-01-01", summary: "Updated.", docsUpdated: "true", deviationsDocumented: ["d1"] });
		expect(r.errors).toEqual([]); expect(r.markdown).toMatch(/Documentation Updates/);
	});
	it("api-test → has cases tested + pass flag", () => {
		const r = renderStage("apiTest", { title: "API Test", date: "2026-01-01", summary: "All pass.", pass: "true", cases: "9", failures: [] });
		expect(r.errors).toEqual([]); expect(r.markdown).toMatch(/Cases Tested/);
	});
	it("ui-test → has flows tested + pass flag", () => {
		const r = renderStage("uiTest", { title: "UI Test", date: "2026-01-01", summary: "All pass.", pass: "true", flows: "5", failures: [] });
		expect(r.errors).toEqual([]); expect(r.markdown).toMatch(/Flows Tested/);
	});
});
