/**
 * R1 (dsh-09 v3 Phase R): the explicit dependency-edges table for the pipeline
 * skeleton — graph-engineering's concrete landing ("which dependencies are
 * real vs habitual": every edge below is a VERIFIED prompt-read or composition
 * adjacency, not an assumption).
 *
 * Consumers:
 *   - R4 replan invalidation: `downstreamOf(stageId)` defines which stages a
 *     revision of an owning artifact invalidates (user decision D3:
 *     dependency-graph FULL invalidation).
 *   - P4 generated architecture docs (stage table input).
 *
 * Drift guard: tests/graph-edges.test.ts pins (a) every non-setup stage has an
 * inbound edge, (b) the graph is acyclic, and (c) signature tripwires that grep
 * src/prompts.ts for the exact artifact-read parameters each edge encodes —
 * adding a prompt dependency without updating this table fails CI.
 *
 * Granularity note: the verify node's internal sub-steps (codeReview,
 * testsReview, adversarialReview, reviewFix, buildGate, apiTest, uiTest,
 * testFix, bringup) are NOT separate nodes here — they are internal to the
 * `verify` convergence state machine and always re-run together with it.
 */

export interface StageEdge {
	/** The upstream stage (producer of the consumed artifact). */
	from: string;
	/** The downstream stage (consumer). */
	to: string;
	/** Why this edge is real — the verified prompt read or composition fact. */
	rationale: string;
}

/** The top-level skeleton nodes (setup is the root; it has no inbound edge). */
export const STAGE_IDS = [
	"setup",
	"classify",
	"requirements",
	"bdd",
	"research",
	"debug",
	"assessment",
	"design",
	"prototype",
	"spec",
	"implementation",
	"verify",
	"docs",
	"preMergeBuild",
	"cleanup",
	"merge",
	"merge-verify",
] as const;

export type SkeletonStageId = (typeof STAGE_IDS)[number];

export const EDGES: StageEdge[] = [
	{ from: "setup", to: "classify", rationale: "classification reads the detected language/isWebUi from state.setup" },
	{ from: "classify", to: "requirements", rationale: "buildRequirementsPrompt(s, c, task) reads the classification" },
	{ from: "requirements", to: "bdd", rationale: "buildBddPrompt(…, requirements) — BDD scenarios cover requirements ACs" },
	{ from: "requirements", to: "research", rationale: "buildResearchPrompt(…, requirements, …) reads the requirements" },
	{ from: "bdd", to: "research", rationale: "buildResearchPrompt(…, bdd, …) — research derives questions after reading the BDD scenarios" },
	{ from: "requirements", to: "debug", rationale: "buildDebugPrompt(…, requirements, …) reads the requirements (bug path only)" },
	{ from: "research", to: "debug", rationale: "buildDebugPrompt(…, research) reads the research report" },
	{ from: "research", to: "assessment", rationale: "buildAssessmentPrompt(…, research, …) reads the research report" },
	{ from: "debug", to: "assessment", rationale: "buildAssessmentPrompt(…, debug) reads the debug analysis when present" },
	{ from: "requirements", to: "design", rationale: "buildDesignPrompt(…, requirements, …) reads the requirements" },
	{ from: "research", to: "design", rationale: "buildDesignPrompt(…, research, …) reads the research report" },
	{ from: "assessment", to: "design", rationale: "buildDesignPrompt(…, assessment) reads the code assessment" },
	{ from: "design", to: "prototype", rationale: "buildPrototypePrompt(…, design, …) prototypes the chosen design" },
	{ from: "requirements", to: "spec", rationale: "buildSpecPrompt(…, requirements, …) cites requirements ACs" },
	{ from: "bdd", to: "spec", rationale: "buildSpecPrompt(…, bdd, …) binds scenarios into phases" },
	{ from: "research", to: "spec", rationale: "buildSpecPrompt(…, research, …) carries research constraints" },
	{ from: "assessment", to: "spec", rationale: "buildSpecPrompt(…, assessment, …) carries code-assessment findings" },
	{ from: "design", to: "spec", rationale: "buildSpecPrompt(…, design, …) instantiates the design modules" },
	{ from: "prototype", to: "spec", rationale: "buildSpecPrompt(…, prototype) folds validated prototype constants" },
	{ from: "spec", to: "implementation", rationale: "buildImplementPrompt/buildTddPrompt read the spec control (phases, deliverables)" },
	{ from: "bdd", to: "implementation", rationale: "buildTddPrompt(…, bddControl) — TDD scenarios come from the BDD artifact" },
	{ from: "spec", to: "verify", rationale: "reviewers read specControl (buildCodeReviewPrompt/buildAdversarialPrompt/buildTestsReviewPrompt take specControl)" },
	{ from: "implementation", to: "verify", rationale: "reviewers read implControl; verification gates the implementation's phases" },
	{ from: "spec", to: "docs", rationale: "buildDocsPrompt(…, specControl) documents the spec's deliverables" },
	{ from: "verify", to: "docs", rationale: "composition: docs runs only after positive Stage 10 verification (hasVerifiedImplementation branch)" },
	{ from: "docs", to: "preMergeBuild", rationale: "composition: sequence(docs → preMergeBuild → cleanup → merge)" },
	{ from: "preMergeBuild", to: "cleanup", rationale: "composition: cleanup runs after the pre-merge build gate" },
	{ from: "cleanup", to: "merge", rationale: "composition: merge is gated on cleanup's sensitive-scan (canMerge branch)" },
	{ from: "merge", to: "merge-verify", rationale: "composition: mergeVerifyTask runs immediately after mergeWriter" },
];

/** Outbound edges per stage (memoized adjacency). */
const OUTBOUND: ReadonlyMap<string, readonly StageEdge[]> = (() => {
	const m = new Map<string, StageEdge[]>();
	for (const id of STAGE_IDS) m.set(id, []);
	for (const e of EDGES) {
		const list = m.get(e.from);
		if (list) list.push(e);
	}
	return m;
})();

/** All stages transitively reachable from `stageId` (NOT including itself).
 *  The D3 full-invalidation set for a revised owning stage. Deterministic. */
export function downstreamOf(stageId: string): string[] {
	const seen = new Set<string>();
	const queue = [stageId];
	while (queue.length > 0) {
		const cur = queue.shift()!;
		for (const e of OUTBOUND.get(cur) ?? []) {
			if (!seen.has(e.to)) {
				seen.add(e.to);
				queue.push(e.to);
			}
		}
	}
	seen.delete(stageId);
	return [...seen].sort();
}

/** Direct inbound edges (who consumes this stage's artifact). */
export function inboundEdges(stageId: string): StageEdge[] {
	return EDGES.filter((e) => e.to === stageId);
}
