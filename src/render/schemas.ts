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
	// AC-27 (SCENARIO-055/056): gate-parseable AC id — the deterministic gates'
	// extractor reads /\bAC-\d+\b/, so a render-time pattern forces the writer
	// to emit ids the gates can actually trace (2+ digits, zero-padded).
	// (typebox@1.x has no Type.Pattern builder; the `pattern` option emits the
	// same JSON-schema constraint and Value.Errors enforces it.)
	acRef: Type.String({ pattern: "^AC-\\d{2,}$", description: "gate-parseable AC id, e.g. 'AC-01'" }),
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
	// AC-27 (SCENARIO-055/056): gate-parseable AC id (see BddScenario.acRef).
	id: Type.String({ pattern: "^AC-\\d{2,}$", description: "gate-parseable AC id, e.g. 'AC-01'" }),
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
	// Real sources the research-agent searched/fetched online (URL + title). Optional
	// so a run where web tools were unavailable still validates; the agent is
	// instructed to leave it empty ONLY in that case and mark claims unverified.
	sources: Type.Optional(Type.Array(Type.Object({ title: Type.String(), url: Type.String() }))),
	openIssues: Type.Array(Type.String()),
});
export type ResearchData = Static<typeof ResearchData>;

// ─── Reviews (spec-review, code-review, adversarial-review) ───────────────────

// CLOSED (`additionalProperties: false`) so the well-defined review schemas that
// embed it (SpecReviewData/CodeReviewData/AdversarialReviewData) are STRICT-
// CAPABLE end-to-end: `isStrictCapable` returns true for them and the
// structured_output tool attaches constrained sampling, AND a capable
// provider's strict mode recurses into the nested findings without seeing open
// slots to dump into. Optional keys (lens/file/line) stay optional.
const Finding = Type.Object({
	id: Type.String(),
	severity: Type.String(),
	title: Type.String(),
	detail: Type.String(),
	lens: Type.Optional(Type.String()),
	file: Type.Optional(Type.String()),
	line: Type.Optional(Type.String()),
	ownerStage: Type.Optional(Type.String({ description: "owning stage: requirements, bdd, research, assessment, design, prototype, spec, implementation, verification, environment" })),
	blocking: Type.Optional(Type.Boolean()),
	status: Type.Optional(Type.String({ description: "open, addressed, verified, deferred, or needs-human" })),
	confidence: Type.Optional(Type.Number({ description: "0..1 confidence that this is a real current issue" })),
	recommendation: Type.Optional(Type.String()),
	evidence: Type.Optional(Type.Array(Type.String())),
	priorFindingId: Type.Optional(Type.String()),
}, { additionalProperties: false });

const ReviewResponse = Type.Object({
	findingId: Type.String(),
	status: Type.String({ description: "addressed, verified, deferred, or needs-human" }),
	response: Type.String(),
	evidence: Type.Optional(Type.String()),
	ownerStage: Type.Optional(Type.String()),
});

// CLOSED (`additionalProperties: false`) so this stage schema is STRICT-CAPABLE
// (≥1 required non-Optional key + additionalProperties:false) and the
// structured_output tool attaches constrained sampling in production (Feature 2).
// The nested dimensions element is also closed so a provider's strict mode can
// not dump extra keys inside it either.
export const SpecReviewData = Type.Object({
	title: Type.String(),
	date: Type.String(),
	verdict: Type.String(),
	summary: Type.String(),
	findings: Type.Array(Finding),
	priorFindingResolutions: Type.Optional(Type.Array(ReviewResponse)),
	dimensions: Type.Array(Type.Object({ name: Type.String(), status: Type.String(), notes: Type.String() }, { additionalProperties: false })),
}, { additionalProperties: false });
export type SpecReviewDataT = Static<typeof SpecReviewData>;

// Upstream reviewer schemas (requirements/bdd/design) share the SpecReview shape
// — verdict + findings + dimensions — so a re-defined CLOSED object keeps each
// one independently strict-capable for constrained sampling (Feature 2).
const upstreamReviewObject = () => Type.Object({
	title: Type.String(),
	date: Type.String(),
	verdict: Type.String(),
	summary: Type.String(),
	findings: Type.Array(Finding),
	priorFindingResolutions: Type.Optional(Type.Array(ReviewResponse)),
	dimensions: Type.Array(Type.Object({ name: Type.String(), status: Type.String(), notes: Type.String() }, { additionalProperties: false })),
}, { additionalProperties: false });
export const RequirementsReviewData = upstreamReviewObject();
export const BddReviewData = upstreamReviewObject();
export const DesignReviewData = upstreamReviewObject();

// CLOSED so this stage schema is STRICT-CAPABLE in production (Feature 2).
export const CodeReviewData = Type.Object({
	title: Type.String(),
	date: Type.String(),
	verdict: Type.String(),
	summary: Type.String(),
	findings: Type.Array(Finding),
}, { additionalProperties: false });
export type CodeReviewDataT = Static<typeof CodeReviewData>;

// CLOSED so this stage schema is STRICT-CAPABLE in production (Feature 2).
export const AdversarialReviewData = Type.Object({
	title: Type.String(),
	date: Type.String(),
	verdict: Type.String(),
	summary: Type.String(),
	findings: Type.Array(Finding),
}, { additionalProperties: false });
export type AdversarialReviewDataT = Static<typeof AdversarialReviewData>;

// ─── Remaining stages (batch 3) ─────────────────────────────────────────────

// CLOSED so this stage schema is STRICT-CAPABLE in production (Feature 2).
export const ImplementationSummaryData = Type.Object({
	title: Type.String(), date: Type.String(), summary: Type.String(),
	phasesCompleted: Type.String(), allGreen: Type.String(),
	filesModified: Type.Array(Type.String()),
}, { additionalProperties: false });
export const DebugData = Type.Object({
	title: Type.String(), date: Type.String(), summary: Type.String(),
	hypotheses: Type.Array(Type.String()), rootCause: Type.String(),
	reproductionSteps: Type.Array(Type.String()),
});
export const DesignData = Type.Object({
	title: Type.String(), date: Type.String(), summary: Type.String(),
	designer: Type.String(),
	modules: Type.Array(Type.Object({ name: Type.String(), description: Type.String() })),
	// Boolean control drift (run 2026-08-15T13-45-02 postmortem): these fields
	// are semantically boolean but historically typed String-only — a model
	// emitting a real boolean failed Value.Errors and renderAndWrite silently
	// DROPPED the whole report doc (audit C-F3). Union keeps both shapes valid.
	hasNumericConstants: Type.Union([Type.String(), Type.Boolean()]),
});
export const PrototypeData = Type.Object({
	title: Type.String(), date: Type.String(), summary: Type.String(),
	// Closed enum (postmortem 0001 case 3): the verdict reaches structured_output
	// as tool parameters, so conforming models cannot drift to PROTOTYPE_COMPLETE
	// et al. Boundary normalization in prototype.ts covers unconstrained paths.
	verdict: Type.Union([Type.Literal("pass"), Type.Literal("fail")]),
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
	// Boolean drift: accept boolean OR string (see DesignData.hasNumericConstants).
	pass: Type.Union([Type.String(), Type.Boolean()]), cases: Type.String(),
	failures: Type.Array(Type.Object({ method: Type.String(), path: Type.String(), reason: Type.String() })),
});
export const UiTestData = Type.Object({
	title: Type.String(), date: Type.String(), summary: Type.String(),
	// Boolean drift: accept boolean OR string (see DesignData.hasNumericConstants).
	pass: Type.Union([Type.String(), Type.Boolean()]), flows: Type.String(),
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
	/** Additional docs rendered from the same data (multi-doc stages like spec). */
	additionalDocs?: Array<{ slug: string; template: string }>;
}

export const STAGE_MODELS: Record<string, StageModel> = {
	bdd: { slug: "bdd-scenarios", schema: BddData, template: "bdd-scenarios.md.njk" },
	requirements: { slug: "requirements", schema: RequirementsData, template: "requirements.md.njk" },
	assessment: { slug: "code-assessment", schema: CodeAssessmentData, template: "code-assessment.md.njk" },
	research: { slug: "research-report", schema: ResearchData, template: "research-report.md.njk" },
	specReview: { slug: "spec-review", schema: SpecReviewData, template: "spec-review.md.njk" },
	requirementsReview: { slug: "requirements-review", schema: RequirementsReviewData, template: "requirements-review.md.njk" },
	bddReview: { slug: "bdd-review", schema: BddReviewData, template: "bdd-review.md.njk" },
	designReview: { slug: "design-review", schema: DesignReviewData, template: "design-review.md.njk" },
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

// ─── Specification (multi-doc: specification + implementation-plan + task-list) ─

/** Per-phase DELIVERABLE CONTRACT (AC-04/05 → SCENARIO-018..020). OPTIONAL; a
 *  phase with no deliverables validates & behaves identically to today (backward
 *  compat). Enforced by runDeliverableCheck AND-ed with build-green so a phase
 *  that creates a file / wires a call site X→Y / makes new sources reachable /
 *  adds a named test cannot compile green while delivering nothing. */
export const PhaseDeliverables = Type.Object({
	requireFiles: Type.Optional(Type.Array(Type.String())),
	requireContains: Type.Optional(Type.Array(Type.Object({ file: Type.String(), pattern: Type.String() }))),
	requireNotContains: Type.Optional(Type.Array(Type.Object({ file: Type.String(), pattern: Type.String() }))),
	requireTests: Type.Optional(Type.Array(Type.String())),
	requireScenarios: Type.Optional(Type.Array(Type.String())),
});
export type PhaseDeliverables = Static<typeof PhaseDeliverables>;

/** A specification phase element. `deliverables` is OPTIONAL (backward compat).
 *  When present it round-trips through normalizePhases as typed `phase.deliverables`. */
export const SpecPhase = Type.Object({
	name: Type.String(),
	description: Type.String(),
	scenarioRefs: Type.Optional(Type.Array(Type.String())),
	deliverables: Type.Optional(PhaseDeliverables),
});
export type SpecPhase = Static<typeof SpecPhase>;

/** Plan 2 Tier 2 — independent RED test-quality review verdict. `verdict` is
 *  "strong" (assertions bind observable behavior) or "weak" (tautologies, stub
 *  constants, implementation-detail coupling). A "weak" verdict routes the RED
 *  phase back to tdd-guide. `contradictions` (Fix 4) carries JOINT
 *  satisfiability findings: named test pairs/lines plus an impossibility proof
 *  when NO conforming implementation can pass all tests simultaneously —
 *  emitted as [] when the suite is jointly satisfiable. Kept tiny so the
 *  reviewer returns a crisp decision. */
export const RedReviewData = Type.Object({
	verdict: Type.Union([Type.Literal("strong"), Type.Literal("weak")]),
	summary: Type.String(),
	contradictions: Type.Array(Type.Object({
		tests: Type.String(),
		lines: Type.Optional(Type.String()),
		proof: Type.String(),
	})),
}, { additionalProperties: false });
export type RedReviewData = Static<typeof RedReviewData>;

/** LLM task-classification (Stage 2A). Replaces the shallow BUG_RE/isWebUi regex
 *  that misread compound tasks (e.g. "add upload page with error handling" →
 *  bug/none because it saw the word "error"). The classifier reads the task text
 *  (and may inspect the repo) and returns a grounded routing decision. `rationale`
 *  is a one-line justification kept for the run log. CLOSED so it is strict-capable
 *  for constrained sampling. */
export const ClassificationData = Type.Object({
	taskType: Type.Union([Type.Literal("bug"), Type.Literal("feature"), Type.Literal("refactor")]),
	uiScope: Type.Union([Type.Literal("none"), Type.Literal("ui-only"), Type.Literal("ui+arch")]),
	rationale: Type.String(),
}, { additionalProperties: false });
export type ClassificationData = Static<typeof ClassificationData>;

export const SpecificationData = Type.Object({
	title: Type.String(),
	date: Type.String(),
	summary: Type.String(),
	architecture: Type.String(),
	testingStrategy: Type.String(),
	acceptanceCriteriaRefs: Type.Optional(Type.Array(Type.String())),
	scenarioRefs: Type.Array(Type.String()),
	phases: Type.Array(SpecPhase, { minItems: 1 }),
	tasks: Type.Array(Type.Object({ phase: Type.String(), description: Type.String(), scenarioRefs: Type.Optional(Type.Array(Type.String())) })),
	reviewResponses: Type.Optional(Type.Array(ReviewResponse)),
	// Layer D (AC-04..08): an OPTIONAL spec-declared cargo build-gate contract.
	// The specification stage MAY declare it for backend/integration features; it
	// is threaded into RunOptions.gate and becomes the top-precedence scope tier.
	gate: Type.Optional(
		Type.Object({
			packages: Type.Optional(Type.Array(Type.String())),
			workspace: Type.Optional(Type.Boolean()),
			integration: Type.Optional(Type.Array(Type.String())),
		}),
	),
});

// Register the multi-doc specification stage
STAGE_MODELS["spec"] = {
	slug: "specification",
	schema: SpecificationData,
	template: "specification.md.njk",
	additionalDocs: [
		{ slug: "implementation-plan", template: "implementation-plan.md.njk" },
		{ slug: "task-list", template: "task-list.md.njk" },
	],
};
