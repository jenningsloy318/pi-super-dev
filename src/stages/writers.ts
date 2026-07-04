/**
 * Leaf stages built from the convenience builders in `nodes.ts`:
 *   - single-shot agent "writer" tasks (wrapped in `gate`/`loop` upstream)
 *   - deterministic helper tasks (classify, cleanup)
 */

import { writerTask, helperTask } from "../nodes.ts";
import type { Stage, SetupControl } from "../types.ts";
import * as P from "../prompts.ts";

const S = (s: { setup?: SetupControl }) => s.setup!;

export const requirementsWriter: Stage = writerTask({
	id: "requirements",
	label: "Stage 2B — Requirements",
	agent: "requirements-clarifier",
	buildPrompt: (state, ctx) => P.buildRequirementsPrompt(S(state), state.classify ?? null, ctx.task),
});

export const bddWriter: Stage = writerTask({
	id: "bdd",
	label: "Stage 2C — BDD Scenarios",
	agent: "bdd-scenario-writer",
	requires: ["*-requirements.md"],
	buildPrompt: (state, ctx) => P.buildBddPrompt(S(state), state.classify ?? null, ctx.task, state.requirements ?? null),
});

export const researchWriter: Stage = writerTask({
	id: "research",
	label: "Stage 3 — Research",
	agent: "research-agent",
	requires: ["*-requirements.md"],
	buildPrompt: (state, ctx) =>
		P.buildResearchPrompt(S(state), state.classify ?? null, ctx.task, state.requirements ?? null, state.bdd ?? null, state.research ?? null),
});

export const debugWriter: Stage = writerTask({
	id: "debug",
	label: "Stage 4 — Debug Analysis",
	agent: "debug-analyzer",
	requires: ["*-requirements.md"],
	buildPrompt: (state, ctx) => P.buildDebugPrompt(S(state), state.classify ?? null, ctx.task, state.requirements ?? null, state.research ?? null),
});

export const assessmentWriter: Stage = writerTask({
	id: "assessment",
	label: "Stage 5 — Code Assessment",
	agent: "code-assessor",
	buildPrompt: (state, ctx) => P.buildAssessmentPrompt(S(state), state.classify ?? null, ctx.task, state.research ?? null, state.debug ?? null),
});

export const specWriter: Stage = writerTask({
	id: "spec",
	label: "Stage 7 — Specification",
	agent: "spec-writer",
	requires: ["*-requirements.md", "*-bdd-scenarios.md"],
	buildPrompt: (state, ctx) =>
		P.buildSpecPrompt(S(state), state.classify ?? null, ctx.task, state.requirements ?? null, state.bdd ?? null, state.research ?? null, state.assessment ?? null, state.design ?? null),
});

export const specReviewWriter: Stage = writerTask({
	id: "specReview",
	label: "Stage 8 — Spec Review",
	agent: "spec-reviewer",
	requires: ["*-specification.md", "*-implementation-plan.md", "*-task-list.md"],
	buildPrompt: (state) => P.buildSpecReviewPrompt(S(state), state.classify ?? null, state.spec ?? null),
});

export const docsWriter: Stage = writerTask({
	id: "docs",
	label: "Stage 11 — Documentation",
	agent: "docs-executor",
	requires: ["*-specification.md"],
	buildPrompt: (state, ctx) => P.buildDocsPrompt(S(state), state.classify ?? null, ctx.task, state.spec ?? null),
});

export const mergeWriter: Stage = writerTask({
	id: "merge",
	label: "Stage 13 — Merge",
	agent: "orchestrator",
	buildPrompt: (state) => P.buildMergePrompt(S(state)),
});

/** Classify the task via a helper. Needs the runtime task text from ctx. */
export const classifyStage: Stage = {
	id: "classify",
	label: "Stage 2A — Classify Task",
	async run(state, ctx) {
		const result = await ctx.helper({
			name: "classify-task",
			sources: { setup: state.setup },
			options: { runtimeTask: ctx.task },
		});
		return result.value;
	},
};

/** Scan the worktree for build artifacts + sensitive data; decide merge blocking. */
export const cleanupTask: Stage = helperTask({
	id: "cleanup",
	label: "Stage 12 — Cleanup",
	helper: "cleanup",
	sources: (state) => ({ docs: state.docs ?? {} }),
	context: (state) => ({ cwd: state.setup?.worktreePath ?? "" }),
});
