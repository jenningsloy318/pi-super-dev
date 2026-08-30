/**
 * Phase 0 render pipeline tests:
 *  1. Template engine: interpolation, filters, for, if, comments.
 *  2. Schema validation: TypeBox catches missing/invalid data.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { render } from "../src/render/template-engine.ts";
import { validateData, renderStage, renderAndWrite } from "../src/render/render.ts";
import { extractAcceptanceCriteriaIds } from "../src/doc-validators.ts";
import { BddData as BddSchema, RequirementsData as ReqSchema } from "../src/render/schemas.ts";
import type { SetupControl } from "../src/types.ts";

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

// ── AC-27 (SCENARIO-055/056): AC ids must match ^AC-\d{2,}$ at RENDER time ──
describe("schema validation: AC-id patterns (AC-27)", () => {
	let dir: string;
	beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "sd-render-acid-")); });
	afterEach(() => rmSync(dir, { recursive: true, force: true }));
	const mkSetup = (): SetupControl => ({
		worktreePath: dir,
		specDirectory: `${dir}/`,
		defaultBranch: "main",
		language: "backend",
		isWebUi: false,
		specIdentifier: "acid",
		worktreeCreated: false,
		initializedRepo: false,
	} as SetupControl);
	const requirementsControl = (ids: string[]) => ({
		title: "T", date: "2026-08-17", type: "feature", priority: "high",
		executiveSummary: "e", acceptanceCriteria: ids.map((id) => ({ id, statement: `must satisfy ${id}` })),
		nonFunctional: ["nf"],
	});

	it("SCENARIO-055: ids [\"1\",\"2\"] FAIL validation and no requirements doc is written", () => {
		const errors = validateData(ReqSchema, requirementsControl(["1", "2"]));
		expect(errors.length).toBeGreaterThan(0);
		// the pattern constraint is what fired (path renders as $ in this typebox)
		expect(errors.some((e) => e.includes("must match pattern") && e.includes("AC-"))).toBe(true);
		const out = renderStage("requirements", requirementsControl(["1", "2"]));
		expect(out.errors.length).toBeGreaterThan(0);
		expect(out.markdown).toBe("");
		const written = renderAndWrite(mkSetup(), () => {}, "requirements", requirementsControl(["1", "2"]));
		expect(written).toBeNull();
		expect(readdirSync(dir).filter((f) => f.endsWith(".md"))).toEqual([]);
	});
	it("SCENARIO-055: a BddScenario.acRef without the AC-NN shape also fails", () => {
		const bad = {
			title: "Test", date: "2026-01-01", source: "./01-requirements.md",
			features: [{ name: "F1", scenarios: [{ id: "001", title: "T", acRef: "01", priority: "high", given: "g", when: "w", then: "t" }] }],
		};
		expect(validateData(BddSchema, bad).length).toBeGreaterThan(0);
	});
	it("SCENARIO-056: ids [\"AC-01\",\"AC-02\"] pass and render tokens extractAcceptanceCriteriaIds parses", () => {
		const control = requirementsControl(["AC-01", "AC-02"]);
		expect(validateData(ReqSchema, control)).toEqual([]);
		const out = renderStage("requirements", control);
		expect(out.errors).toEqual([]);
		const parsed = extractAcceptanceCriteriaIds(out.markdown);
		expect(parsed).toContain("AC-01");
		expect(parsed).toContain("AC-02");
	});
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
});

	// ─── 4b. BDD coverage summary is COMPUTED or omitted (AC-14) ─────────────
describe("render pipeline: bdd coverage summary (AC-14)", () => {
	const scenario = (id: string, acRef: string) => ({ id, title: `behavior ${id}`, acRef, priority: "high", given: "g", when: "w", then: "t" });

	it("SCENARIO-031: 20 scenarios and NO traceability ⇒ the entire Coverage Summary block is omitted", () => {
		const result = renderStage("bdd", {
			title: "No Trace", date: "2026-01-01", source: "./01-requirements.md",
			features: [{ name: "F", scenarios: Array.from({ length: 20 }, (_, i) => scenario(String(i + 1).padStart(3, "0"), "AC-01")) }],
		});
		expect(result.errors).toEqual([]);
		expect(result.markdown).not.toContain("Coverage Summary");
		expect(result.markdown).not.toContain("Uncovered:");
		expect(result.markdown).not.toContain("Covered by Scenarios:");
		expect(result.markdown).toContain("Total Scenarios**: 20"); // header count stays
	});

	it("SCENARIO-032: partial traceability renders the COMPUTED covered/uncovered counts (distinct AC ids, redundant refs deduped)", () => {
		const result = renderStage("bdd", {
			title: "Partial Trace", date: "2026-01-01", source: "./01-requirements.md",
			features: [{ name: "F", scenarios: [scenario("001", "AC-01"), scenario("002", "AC-02"), scenario("003", "AC-03")] }],
			traceability: [
				{ acId: "AC-01", description: "first", scenarios: ["SCENARIO-001", "SCENARIO-002"] }, // AC-01 redundantly re-referenced
				{ acId: "AC-01", description: "first (dup)", scenarios: ["SCENARIO-001"] },
				{ acId: "AC-02", description: "second", scenarios: ["SCENARIO-002"] },
				{ acId: "AC-03", description: "third", scenarios: ["SCENARIO-003"] },
				{ acId: "AC-04", description: "fourth", scenarios: [] },
				{ acId: "AC-05", description: "fifth", scenarios: [] },
			],
		});
		expect(result.errors).toEqual([]);
		expect(result.markdown).toContain("## Coverage Summary");
		expect(result.markdown).toContain("Total Acceptance Criteria**: 5");
		// the bolded bullet renders as "**Covered by Scenarios**: 3" — match the
		// observable count robust to the markdown emphasis markers.
		expect(result.markdown).toMatch(/Covered by Scenarios\*{0,2}: 3/);
		expect(result.markdown).toMatch(/Uncovered\*{0,2}: 2/);
		expect(result.markdown).toContain("(AC-04, AC-05)");
		expect(result.markdown).toContain("Total Scenarios**: 3");
		expect(result.markdown).not.toMatch(/Uncovered\*{0,2}: 0/);
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
	it("boolean control drift: a real BOOLEAN pass/hasNumericConstants no longer drops the doc (run 2026-08-15T13-45-02 postmortem / audit C-F3)", () => {
		// Production shape: models emit real booleans where the schema used to
		// demand strings — Value.Errors previously rejected the control and
		// renderAndWrite silently returned null (report doc never written).
		const api = renderStage("apiTest", { title: "API Test", date: "2026-01-01", summary: "All pass.", pass: true, cases: "9", failures: [] });
		expect(api.errors).toEqual([]); expect(api.markdown).toMatch(/Cases Tested/);
		const ui = renderStage("uiTest", { title: "UI Test", date: "2026-01-01", summary: "All pass.", pass: true, flows: "5", failures: [] });
		expect(ui.errors).toEqual([]); expect(ui.markdown).toMatch(/Flows Tested/);
		const design = renderStage("design", { title: "Design", date: "2026-01-01", summary: "Arch.", designer: "architecture-designer", modules: [{ name: "API", description: "REST" }], hasNumericConstants: true });
		expect(design.errors).toEqual([]); expect(design.markdown).toContain("Has numeric constants requiring validation**: true");
	});
	// Run 2026-08-30T00-10-34-032Z (aborted after 6 design rounds + judge escalation)
	// and 2026-08-30T03-23-40-576Z (8 rounds): GLM designers emitted
	// `alternativesConsidered[].alternatives` as ONE prose string ("(a) … rejected:
	// …; (b) …") every round; the strict Array schema rejected each COMPLETE
	// control and the doc never rendered.
	it("string control drift: alternativesConsidered[].alternatives as ONE prose string no longer drops the design doc (runs 2026-08-30T00-10-34 / 03-23-40)", () => {
		const design = renderStage("design", { title: "Design", date: "2026-08-30", summary: "Arch.", designer: "product-designer", modules: [{ name: "M", description: "d" }], hasNumericConstants: true, alternativesConsidered: [{ decision: "storage", chosen: "sqlite", rationale: "r", alternatives: "(a) json files — rejected: no queries; (b) duckdb — rejected: binary weight" }] });
		expect(design.errors).toEqual([]);
		expect(design.markdown).toContain("(a) json files — rejected: no queries");
		// Normalization is IN PLACE: the caller's control object carries the array
		// downstream (convergence ledger / knowledge accumulate from the same object).
		const control = { alternativesConsidered: [{ alternatives: "one prose string" }] };
		renderStage("design", { title: "D", date: "2026-01-01", summary: "s", designer: "x", modules: [], hasNumericConstants: false, ...(control as object) });
		expect((control.alternativesConsidered as Array<{ alternatives: unknown }>)[0]!.alternatives).toEqual(["one prose string"]);
	});
	it("string control drift: findings[].evidence as ONE prose string no longer drops review docs (same runs: review rounds logged '$: must be array' while verdicts were consumed)", () => {
		const r = renderStage("codeReview", { title: "R", date: "2026-08-30", verdict: "APPROVED", summary: "s", findings: [{ id: "F1", severity: "P2", title: "t", detail: "d", evidence: "src/a.ts:12; tests/b.ts:3" }] });
		expect(r.errors).toEqual([]);
		expect(r.markdown).toContain("src/a.ts:12");
	});
	it("schema errors name the offending FIELD (typebox@1.x schemaPath), never a bare \"$\" location (the masking that starved both runs' retries)", () => {
		const r = renderStage("design", { title: "Design", date: "2026-08-30", summary: "Arch.", designer: "x", modules: [{ name: "M", description: "d" }], hasNumericConstants: true, contracts: [{ name: "c", pattern: "p", enumerates: "NOT-AN-ARRAY" }] });
		expect(r.errors.some((e) => e.startsWith("contracts[].enumerates: must be array"))).toBe(true);
		expect(r.errors.some((e) => e.startsWith("$"))).toBe(false);
		// A string `alternatives` still VALIDATES (normalized pre-check) — the
		// located-error path above is exercised via a field normalization does not touch.
	});
	it("ui-test → has flows tested + pass flag", () => {
		const r = renderStage("uiTest", { title: "UI Test", date: "2026-01-01", summary: "All pass.", pass: "true", flows: "5", failures: [] });
		expect(r.errors).toEqual([]); expect(r.markdown).toMatch(/Flows Tested/);
	});
});

// ─── 11. Specification (multi-doc) render pipeline ───────────────────────────

describe("render pipeline: specification (multi-doc)", () => {
	it("valid data → primary doc has architecture + testing strategy + scenario refs", () => {
		const result = renderStage("spec", {
			title: "Feature Spec", date: "2026-01-01", summary: "A spec.",
			architecture: "REST API with Express.",
			testingStrategy: "Unit + integration tests.",
			scenarioRefs: ["SCENARIO-001", "SCENARIO-002"],
			phases: [{ name: "Phase 1: Setup", description: "Initial setup" }, { name: "Phase 2: Implement", description: "Core logic" }],
			tasks: [{ phase: "Phase 1", description: "Create structure" }, { phase: "Phase 2", description: "Implement endpoints" }],
		});
		expect(result.errors).toEqual([]);
		expect(result.markdown).toMatch(/Architecture/);
		expect(result.markdown).toMatch(/Testing Strategy/);
		expect(result.markdown).toMatch(/SCENARIO-001/);
	});
	it("schema requires at least 1 phase", async () => {
		const errors = validateData(
			// access the spec schema via STAGE_MODELS
			(await import("../src/render/schemas.ts")).STAGE_MODELS["spec"].schema,
			{ title: "T", date: "d", summary: "s", architecture: "a", testingStrategy: "t", scenarioRefs: [], phases: [], tasks: [] },
		);
		expect(errors.length).toBeGreaterThan(0);
	});
});

// ─── generatedAt timezone unification ────────────────────────────────────────
// The user asked that report "Generated" stamps match run.log timestamps (local
// time with numeric offset) instead of UTC ISO (`...Z`). Every rendered doc's
// generatedAt must carry a local offset and must NOT be UTC Z-form.
describe("generatedAt uses local time (matches run.log timestamp format)", () => {
	it("requirements doc header shows local-offset generatedAt, never UTC Z", () => {
		const result = renderStage("requirements", {
			title: "TZ Feature", date: "2026-01-01", type: "feature", priority: "high",
			executiveSummary: "Summary.",
			acceptanceCriteria: [{ id: "AC-01", statement: "must work" }, { id: "AC-02", statement: "must be local-time consistent" }],
			nonFunctional: ["Performance: under 100ms"],
		});
		expect(result.errors).toEqual([]);
		const line = result.markdown.split("\n").find((l) => l.includes("**Generated**")) ?? "";
		expect(line).toMatch(/\*\*Generated\*\*: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}$/);
		expect(line).not.toMatch(/Z$/);
	});
});
