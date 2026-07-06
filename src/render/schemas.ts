/**
 * Per-stage DATA schemas (TypeBox). One definition → three uses:
 *   1. a TS type (Static<typeof X>) for compile-time safety,
 *   2. a JSON-schema-shaped object the template engine + validator consume,
 *   3. (forthcoming) the structured_output tool schema the agent returns against.
 *
 * The agent produces CONTENT conforming to these; the doc is rendered from it,
 * so the agent never wrestles with markdown format.
 */

import { Type, type Static } from "typebox";

const Priority = Type.String({ description: "priority: high, medium, low, critical, etc." });

// ─── BDD scenarios ───────────────────────────────────────────────────────────

export const BddScenario = Type.Object({
	id: Type.String({ description: "zero-padded, e.g. '001'" }),
	title: Type.String(),
	acRef: Type.String({ description: "e.g. 'AC-02'" }),
	priority: Priority,
	given: Type.String(),
	when: Type.String(),
	then: Type.String(),
	andClauses: Type.Optional(Type.Array(Type.String())),
});

export const BddFeature = Type.Object({
	name: Type.String(),
	scenarios: Type.Array(BddScenario, { minItems: 1 }),
});

export const BddData = Type.Object({
	title: Type.String({ description: "feature/spec title, e.g. 'Core Types & Configuration'" }),
	date: Type.String(),
	source: Type.String({ description: "requirements doc path, e.g. './01-requirements.md'" }),
	features: Type.Array(BddFeature, { minItems: 1 }),
	traceability: Type.Optional(
		Type.Array(Type.Object({
			acId: Type.String(),
			description: Type.String(),
			scenarios: Type.Array(Type.String()),
		})),
	),
});
export type BddData = Static<typeof BddData>;

// ─── Requirements ────────────────────────────────────────────────────────────

export const AcceptanceCriterion = Type.Object({
	id: Type.String({ description: "e.g. 'AC-01'" }),
	statement: Type.String(),
});

export const RequirementsData = Type.Object({
	title: Type.String(),
	date: Type.String(),
	type: Type.String(),
	priority: Priority,
	executiveSummary: Type.String(),
	acceptanceCriteria: Type.Array(AcceptanceCriterion, { minItems: 2 }),
	nonFunctional: Type.Array(Type.String(), { description: "performance / security / accessibility notes" }),
	openQuestions: Type.Optional(Type.Array(Type.String())),
});
export type RequirementsData = Static<typeof RequirementsData>;

// ─── Code Assessment ──────────────────────────────────────────────────────────

export const CodeAssessmentData = Type.Object({
	title: Type.String(),
	date: Type.String(),
	summary: Type.String(),
	patterns: Type.Array(Type.Object({ name: Type.String(), example: Type.String(), consistency: Type.String() })),
	recommendations: Type.Array(Type.String()),
	filesAssessed: Type.Array(Type.String()),
	services: Type.Optional(Type.Object({
		api: Type.Optional(Type.Object({ cmd: Type.String(), portEnv: Type.String(), readyPath: Type.String() })),
		ui: Type.Optional(Type.Object({ cmd: Type.String(), portEnv: Type.String(), readyPath: Type.String() })),
	})),
});
export type CodeAssessmentData = Static<typeof CodeAssessmentData>;

// ─── Research Report ──────────────────────────────────────────────────────────

export const ResearchData = Type.Object({
	title: Type.String(),
	date: Type.String(),
	summary: Type.String(),
	options: Type.Array(Type.Object({ name: Type.String(), tradeoffs: Type.String() }), { minItems: 1 }),
	openIssues: Type.Array(Type.String()),
});
export type ResearchData = Static<typeof ResearchData>;

// ─── Reviews (spec-review, code-review, adversarial-review) ───────────────────

const Finding = Type.Object({
	id: Type.String(),
	severity: Type.String(),
	title: Type.String(),
	detail: Type.String(),
	lens: Type.Optional(Type.String()),
	file: Type.Optional(Type.String()),
	line: Type.Optional(Type.String()),
});

export const SpecReviewData = Type.Object({
	title: Type.String(),
	date: Type.String(),
	verdict: Type.String(),
	summary: Type.String(),
	findings: Type.Array(Finding),
	dimensions: Type.Array(Type.Object({ name: Type.String(), status: Type.String(), notes: Type.String() })),
});
export type SpecReviewDataT = Static<typeof SpecReviewData>;

export const CodeReviewData = Type.Object({
	title: Type.String(),
	date: Type.String(),
	verdict: Type.String(),
	summary: Type.String(),
	findings: Type.Array(Finding),
});
export type CodeReviewDataT = Static<typeof CodeReviewData>;

export const AdversarialReviewData = Type.Object({
	title: Type.String(),
	date: Type.String(),
	verdict: Type.String(),
	summary: Type.String(),
	findings: Type.Array(Finding),
});
export type AdversarialReviewDataT = Static<typeof AdversarialReviewData>;

// ─── Remaining stages (batch 3) ─────────────────────────────────────────────

export const ImplementationSummaryData = Type.Object({
	title: Type.String(), date: Type.String(), summary: Type.String(),
	phasesCompleted: Type.String(), allGreen: Type.String(),
	filesModified: Type.Array(Type.String()),
});
export const DebugData = Type.Object({
	title: Type.String(), date: Type.String(), summary: Type.String(),
	hypotheses: Type.Array(Type.String()), rootCause: Type.String(),
	reproductionSteps: Type.Array(Type.String()),
});
export const DesignData = Type.Object({
	title: Type.String(), date: Type.String(), summary: Type.String(),
	designer: Type.String(),
	modules: Type.Array(Type.Object({ name: Type.String(), description: Type.String() })),
	hasNumericConstants: Type.String(),
});
export const PrototypeData = Type.Object({
	title: Type.String(), date: Type.String(), summary: Type.String(),
	verdict: Type.String(),
	measurements: Type.Array(Type.String()),
	adjustments: Type.Array(Type.String()),
});
export const DocumentationData = Type.Object({
	title: Type.String(), date: Type.String(), summary: Type.String(),
	docsUpdated: Type.String(),
	deviationsDocumented: Type.Array(Type.String()),
});
export const ApiTestData = Type.Object({
	title: Type.String(), date: Type.String(), summary: Type.String(),
	pass: Type.String(), cases: Type.String(),
	failures: Type.Array(Type.Object({ method: Type.String(), path: Type.String(), reason: Type.String() })),
});
export const UiTestData = Type.Object({
	title: Type.String(), date: Type.String(), summary: Type.String(),
	pass: Type.String(), flows: Type.String(),
	failures: Type.Array(Type.Object({ flow: Type.String(), reason: Type.String() })),
});

// ─── Registry: stageId → { schema, template } ────────────────────────────────

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { TSchema } from "typebox";

const TEMPLATES_DIR = join(dirname(fileURLToPath(import.meta.url)), "templates");
const templateCache = new Map<string, string>();
function loadTemplate(name: string): string {
	const cached = templateCache.get(name);
	if (cached !== undefined) return cached;
	const body = readFileSync(join(TEMPLATES_DIR, name), "utf8");
	templateCache.set(name, body);
	return body;
}

export interface StageModel {
	/** The output filename slug, e.g. "bdd-scenarios". */
	slug: string;
	/** TypeBox schema for the agent's content data. */
	schema: TSchema;
	/** Template filename under src/render/templates/. */
	template: string;
}

export const STAGE_MODELS: Record<string, StageModel> = {
	bdd: { slug: "bdd-scenarios", schema: BddData, template: "bdd-scenarios.md.njk" },
	requirements: { slug: "requirements", schema: RequirementsData, template: "requirements.md.njk" },
	assessment: { slug: "code-assessment", schema: CodeAssessmentData, template: "code-assessment.md.njk" },
	research: { slug: "research-report", schema: ResearchData, template: "research-report.md.njk" },
	specReview: { slug: "spec-review", schema: SpecReviewData, template: "spec-review.md.njk" },
	codeReview: { slug: "code-review", schema: CodeReviewData, template: "code-review.md.njk" },
	adversarialReview: { slug: "adversarial-review", schema: AdversarialReviewData, template: "adversarial-review.md.njk" },
	implementationSummary: { slug: "implementation-summary", schema: ImplementationSummaryData, template: "implementation-summary.md.njk" },
	debug: { slug: "debug-analysis", schema: DebugData, template: "debug-analysis.md.njk" },
	design: { slug: "design", schema: DesignData, template: "design.md.njk" },
	prototype: { slug: "prototype-report", schema: PrototypeData, template: "prototype-report.md.njk" },
	docs: { slug: "documentation", schema: DocumentationData, template: "documentation.md.njk" },
	apiTest: { slug: "api-test", schema: ApiTestData, template: "api-test-report.md.njk" },
	uiTest: { slug: "ui-test", schema: UiTestData, template: "ui-test-report.md.njk" },
};
