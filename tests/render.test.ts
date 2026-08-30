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
		const r = renderStage("design", { title: "Design", date: "2026-08-30", summary: "Arch.", designer: "x", modules: [{ name: "M", description: "d" }], hasNumericConstants: true, contracts: [{ name: "c", pattern: "p", enumerates: 42 }] });
		expect(r.errors.some((e) => e.startsWith("contracts[].enumerates: must be array"))).toBe(true);
		expect(r.errors.some((e) => e.startsWith("$"))).toBe(false);
		// A NUMBER in an array slot stays rejected (strings/objects wrap to
		// [value] via coerceArraySlot — numbers are not a legal item shape).
	});
	// Run 2026-08-30T00-14-16-142Z (AnkiQuick): requirements round-1 burned a
	// blind 9-minute retry on "$: must be string" ×5 and debug's doc was
	// silently dropped (×8, status=ok) — the REVERSE drift direction: models
	// emit numeric dates, paragraph ARRAYS for prose slots, booleans for string
	// flags. Schema-driven coercion (coerceSchemaStrings) repairs exactly those
	// would-be failures, for every stage, incl. nested container items.
	it("scalar/paragraph-array control drift: non-string values in string-contract slots no longer drop requirements/debug docs (run 2026-08-30T00-14-16)", () => {
		const reqControl: Record<string, any> = { title: "Fix export", date: 2026, type: true, priority: 42,
			executiveSummary: ["Para one.", "Para two."],
			acceptanceCriteria: [
				{ id: "AC-01", statement: ["Nested paragraph drift", "second line"] },
				{ id: "AC-02", statement: "plain statement" },
			],
			nonFunctional: ["60fps"] };
		const req = renderStage("requirements", reqControl);
		expect(req.errors).toEqual([]);
		expect(req.markdown).toContain("Para one.");
		// Coercion is IN PLACE — the caller's control carries string values downstream.
		expect(reqControl.date).toBe("2026");
		expect(reqControl.executiveSummary).toBe("Para one.\nPara two.");
		expect(reqControl.acceptanceCriteria[0].statement).toBe("Nested paragraph drift\nsecond line");
		const dbgControl: Record<string, any> = { title: "Debug", date: 2026, summary: ["Para A", "Para B"], hypotheses: ["h1", 2, true], rootCause: 500, reproductionSteps: ["step one"] };
		const dbg = renderStage("debug", dbgControl);
		expect(dbg.errors).toEqual([]);
		expect(dbg.markdown).toContain("Root Cause");
		expect(dbgControl.hypotheses).toEqual(["h1", "2", "true"]); // array-of-string slots coerce item-wise
	});
	it("union-contract fields are NEVER rewritten: a legal number/boolean phasesCompleted/allGreen stays non-string (tolerance repairs only would-be failures)", () => {
		const c: Record<string, any> = { title: "t", date: "2026-08-30", summary: "s", phasesCompleted: 2, allGreen: true, filesModified: [] };
		const r = renderStage("implementationSummary", c);
		expect(r.errors).toEqual([]);
		expect(c.phasesCompleted).toBe(2);
		expect(typeof c.phasesCompleted).toBe("number");
		expect(c.allGreen).toBe(true);
	});
	it("structured-OBJECT control drift: hypotheses[] items and rootCause emitted as rich objects no longer drop the debug doc (run 2026-08-30T05-26-19 — live payload verified)", () => {
		// The debug-analyzer emitted hypotheses as [{id, statement, probability,
		// falsifiablePrediction, verification}] and rootCause as {verified,
		// description, codeLocations, recommendedFix} — rich CONTENT, wrong SHAPE.
		// The template would render [object Object]; boundary flattening turns
		// each into readable `key: value` prose.
		const control: Record<string, any> = {
			title: "Debug", date: "2026-08-30", summary: "Blank cards after i18n refactor.",
			hypotheses: [
				{ id: "H1", statement: "Representation mismatch: save stores IDs, export compares display names", probability: "0.70", verification: "CONFIRMED via PlanEditorActivity.kt:233" },
				{ id: "H2", statement: "Dictionary fallback also misses", probability: "0.15" },
			],
			rootCause: { verified: true, description: "Half-finished i18n refactor", codeLocations: ["PopupActivity.kt:1003", "PlanEditorActivity.kt:227"], recommendedFix: "Comparison-time identity resolution" },
			reproductionSteps: ["run the harness"],
		};
		const r = renderStage("debug", control);
		expect(r.errors).toEqual([]);
		expect(r.markdown).toContain("id: H1");
		expect(r.markdown).toContain("verified: true");
		expect(r.markdown).toContain("PopupActivity.kt:1003; PlanEditorActivity.kt:227");
		expect(r.markdown).not.toContain("[object Object]");
		// In place: the control carries the flattened prose downstream.
		expect(String(control.rootCause)).toContain("verified: true");
		expect(typeof control.hypotheses[0]).toBe("string");
	});
	it("null-inside-optional drift: services emitted with null api/portEnv prunes to absence instead of dropping the assessment doc (run 2026-08-30T04-53-26)", () => {
		// The assessor expressed "not applicable" as nulls (api: null, ui.portEnv:
		// null); the schema expresses that as ABSENCE. Pruning drops the null keys
		// and cascades (ui loses required portEnv → ui itself is optional → drop).
		const control: Record<string, any> = {
			title: "Assessment", date: "2026-08-30", summary: "s",
			patterns: [{ name: "p", example: "f:1", consistency: "high" }],
			recommendations: ["r"], filesAssessed: ["a.ts"],
			services: { api: null, ui: { cmd: "python3 -m http.server 8322", portEnv: null, readyPath: "/" } },
		};
		const r = renderStage("assessment", control);
		expect(r.errors).toEqual([]);
		expect(r.markdown.length).toBeGreaterThan(0);
		expect(control.services).toEqual({}); // pruned IN PLACE to absence
		// A null at a REQUIRED top-level slot stays REJECTED + located.
		const r2 = renderStage("assessment", { title: "t", date: "2026-08-30", summary: null, patterns: [{ name: "p", example: "e", consistency: "c" }], recommendations: ["r"], filesAssessed: ["f"] });
		expect(r2.errors.some((e) => e === "summary: must be string")).toBe(true);
	});
	it("singleton-into-array drift: prototype measurements/adjustments emitted as ONE string/object wrap into [value] instead of dropping the doc (run 2026-08-30T04-53-26)", () => {
		const control: Record<string, any> = {
			title: "Proto", date: "2026-08-30", summary: "s", verdict: "pass",
			measurements: { method: "Node 24 script re-implementing each mandated formula", result: "all 15 golden values recomputed and matching" },
			adjustments: "Pin Rydberg constant R = 1.097e7 m⁻¹ in constants.js",
		};
		const r = renderStage("prototype", control);
		expect(r.errors).toEqual([]);
		expect(r.markdown).toContain("re-implementing each mandated formula");
		expect(r.markdown).toContain("Rydberg constant");
		// In place: both fields are arrays downstream.
		expect(Array.isArray(control.measurements)).toBe(true);
		expect(control.adjustments).toEqual(["Pin Rydberg constant R = 1.097e7 m⁻¹ in constants.js"]);
	});
	it("real shape mismatches in string slots stay REJECTED and located (null/empty-object summary → 'executiveSummary: must be string'), never guessed away", () => {
		const r = renderStage("requirements", { title: "t", date: "2026-08-30", type: "feature", priority: "high", executiveSummary: null, acceptanceCriteria: [{ id: "AC-01", statement: "s" }], nonFunctional: [] });
		expect(r.errors.some((e) => e === "executiveSummary: must be string")).toBe(true);
		expect(r.markdown).toBe("");
		// An object with NOTHING to render (no non-empty values) has no prose to
		// flatten — it stays rejected too, not silently blanked.
		const r2 = renderStage("requirements", { title: "t", date: "2026-08-30", type: "feature", priority: "high", executiveSummary: { a: null, b: undefined }, acceptanceCriteria: [{ id: "AC-01", statement: "s" }], nonFunctional: [] });
		expect(r2.errors.some((e) => e === "executiveSummary: must be string")).toBe(true);
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

// ─── v0.3.39: boolean-word drift at exact boolean slots ──────────────────────
// OM run 2026-08-30T08-17-36 design attempt 2 emitted
// uniqueness: "the enumeration is duplicate-free" (prose where boolean belongs).
// Boolean WORDS are exact (zero-risk) coercion; prose stays rejected located —
// it describes the boolean's meaning without asserting it (observed: one
// ~4-minute retry round converged).
describe("boolean-word coercion at exact boolean slots", () => {
	it("coerces \"true\"/\"yes\"/\"false\"/\"no\"/0/1 into declared booleans", async () => {
		const { renderStage } = await import("../src/render/render.ts");
		const ctl = { title: "T", date: "d", summary: "s", designer: "x", modules: [{ name: "M", description: "d" }], hasNumericConstants: "true", contracts: [{ name: "c", pattern: "p", enumerates: ["a", "b"], uniqueness: "yes", namespaced: "false" }] };
		const r = renderStage("design", ctl);
		expect(r.errors).toEqual([]);
		expect(r.markdown).toContain("`a`");
		expect(r.markdown).toContain("`b`");
	});
	it("leaves prose at a boolean slot rejected with the located error", async () => {
		const { renderStage } = await import("../src/render/render.ts");
		const ctl = { title: "T", date: "d", summary: "s", designer: "x", modules: [{ name: "M", description: "d" }], hasNumericConstants: true, contracts: [{ name: "c", pattern: "p", enumerates: ["a"], uniqueness: "the enumeration is duplicate-free" }] };
		const r = renderStage("design", ctl);
		expect(r.errors.join(" ")).toContain("contracts[].uniqueness: must be boolean");
	});
});
