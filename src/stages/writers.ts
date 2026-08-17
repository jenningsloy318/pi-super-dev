/**
 * Leaf stages built from the convenience builders in `nodes.ts`:
 *   - single-shot agent "writer" tasks (wrapped in `gate`/`loop` upstream)
 *   - deterministic helper tasks (classify, cleanup)
 */

import { writerTask, helperTask, isFatalAbort } from "../nodes.ts";
import type { Stage, SetupControl } from "../types.ts";
import * as P from "../prompts.ts";
import { ClassificationData } from "../render/schemas.ts";
import { toBool, normalizePhases } from "../doc-validators.ts";
import { isHarnessBookkeepingPath } from "../helpers.ts";

const S = (s: { setup?: SetupControl }) => s.setup!;

/** A source-read-only boundary violation (a read-only agent mutated project
 *  files that could not all be restored) is a SAFETY error: it must never be
 *  swallowed by a convenience fallback — the pipeline has to stop so the user
 *  sees the unrestored mutation. Matched by the message thrown in workflow.ts. */
function isSafetyBoundaryError(err: unknown): boolean {
	return err instanceof Error && /source-read-only boundary violation/i.test(err.message);
}

export const requirementsWriter: Stage = writerTask({
	id: "requirements",
	label: "Stage 2B — Requirements",
	agent: "requirements-clarifier",
	accessMode: "source-read-only",
	buildPrompt: (state, ctx) => P.buildRequirementsPrompt(S(state), state.classify ?? null, ctx.task),
});

export const bddWriter: Stage = writerTask({
	id: "bdd",
	label: "Stage 2C — BDD Scenarios",
	agent: "bdd-scenario-writer",
	accessMode: "source-read-only",
	requires: ["*-requirements.md"],
	buildPrompt: (state, ctx) => P.buildBddPrompt(S(state), state.classify ?? null, ctx.task, state.requirements ?? null),
});

export const researchWriter: Stage = writerTask({
	id: "research",
	label: "Stage 3 — Research",
	agent: "research-agent",
	accessMode: "source-read-only",
	requires: ["*-requirements.md"],
	buildPrompt: (state, ctx) =>
		P.buildResearchPrompt(S(state), state.classify ?? null, ctx.task, state.requirements ?? null, state.bdd ?? null, state.research ?? null),
});

export const debugWriter: Stage = writerTask({
	id: "debug",
	label: "Stage 4 — Debug Analysis",
	agent: "debug-analyzer",
	accessMode: "source-read-only",
	requires: ["*-requirements.md"],
	buildPrompt: (state, ctx) => P.buildDebugPrompt(S(state), state.classify ?? null, ctx.task, state.requirements ?? null, state.research ?? null),
});

export const assessmentWriter: Stage = writerTask({
	id: "assessment",
	label: "Stage 5 — Code Assessment",
	agent: "code-assessor",
	accessMode: "source-read-only",
	buildPrompt: (state, ctx) => P.buildAssessmentPrompt(S(state), state.classify ?? null, ctx.task, state.research ?? null, state.debug ?? null),
});

/** F6 + code-review R2: repair coercible spec-control malformations (phases as
 *  a string / {phases:[…]} wrapper / single object / numeric-key map) BEFORE
 *  render, so the render schema validates, the docs REGENERATE (a failed render
 *  silently keeps stale docs on disk), and control/docs/implementation all
 *  agree on the same normalized array. */
export function normalizeSpecControl(control: Record<string, unknown>): Record<string, unknown> {
	const phases = control.phases;
	if (phases !== undefined && !Array.isArray(phases)) {
		const normalized = normalizePhases(phases);
		if (normalized.length > 0) {
			control = { ...control, phases: normalized };
		}
	}
	return control;
}

export const specWriter: Stage = writerTask({
	id: "spec",
	label: "Stage 7 — Specification",
	agent: "spec-writer",
	accessMode: "source-read-only",
	requires: ["*-requirements.md", "*-bdd-scenarios.md"],
	buildPrompt: (state, ctx) =>
		P.buildSpecPrompt(S(state), state.classify ?? null, ctx.task, state.requirements ?? null, state.bdd ?? null, state.research ?? null, state.assessment ?? null, state.design ?? null, state.prototype ?? null),
	normalizeControl: normalizeSpecControl,
});

/** Upstream Fagan-style reviewers (shift-left): each reviews the just-written
 *  artifact against its stage dimensions and returns a verdict + findings, so
 *  defects are caught at the source instead of cascading into the spec. The id
 *  matches its STAGE_MODELS entry so the review doc renders as NN-<slug>.md. */
export const requirementsReviewWriter: Stage = writerTask({
	id: "requirementsReview",
	label: "Stage 2B — Requirements Review",
	agent: "requirements-reviewer",
	accessMode: "source-read-only",
	requires: ["*-requirements.md"],
	buildPrompt: (state) =>
		P.buildUpstreamReviewPrompt(S(state), state.classify ?? null, {
			stage: "requirements",
			docPath: (state.requirements?.docPath as string) ?? undefined,
			upstream: [],
			priorResponses: (state.requirements?.reviewResponses as Array<Record<string, unknown>>) ?? undefined,
		}),
});

export const bddReviewWriter: Stage = writerTask({
	id: "bddReview",
	label: "Stage 2C — BDD Review",
	agent: "bdd-reviewer",
	accessMode: "source-read-only",
	requires: ["*-bdd-scenarios.md"],
	buildPrompt: (state) =>
		P.buildUpstreamReviewPrompt(S(state), state.classify ?? null, {
			stage: "bdd",
			docPath: (state.bdd?.docPath as string) ?? undefined,
			upstream: [{ label: "Requirements", path: (state.requirements?.docPath as string) ?? undefined }],
			priorResponses: (state.bdd?.reviewResponses as Array<Record<string, unknown>>) ?? undefined,
		}),
});

export const designReviewWriter: Stage = writerTask({
	id: "designReview",
	label: "Stage 6B — Design Review",
	agent: "design-reviewer",
	accessMode: "source-read-only",
	requires: ["*-design.md"],
	buildPrompt: (state) =>
		P.buildUpstreamReviewPrompt(S(state), state.classify ?? null, {
			stage: "design",
			docPath: (state.design?.docPath as string) ?? undefined,
			upstream: [
				{ label: "Requirements", path: (state.requirements?.docPath as string) ?? undefined },
				{ label: "Research", path: (state.research?.docPath as string) ?? undefined },
				{ label: "Code Assessment", path: (state.assessment?.docPath as string) ?? undefined },
			],
			priorResponses: (state.design?.reviewResponses as Array<Record<string, unknown>>) ?? undefined,
		}),
});

export const specReviewWriter: Stage = writerTask({
	id: "specReview",
	label: "Stage 8 — Spec Review",
	agent: "spec-reviewer",
	accessMode: "source-read-only",
	requires: ["*-specification.md", "*-implementation-plan.md", "*-task-list.md"],
	buildPrompt: (state) => P.buildSpecReviewPrompt(S(state), state.classify ?? null, state.spec ?? null),
});

export const docsWriter: Stage = writerTask({
	id: "docs",
	label: "Stage 12 — Documentation",
	agent: "docs-executor",
	accessMode: "source-read-only",
	requires: ["*-specification.md"],
	buildPrompt: (state, ctx) => P.buildDocsPrompt(S(state), state.classify ?? null, ctx.task, state.spec ?? null),
});

export const mergeWriter: Stage = writerTask({
	id: "merge",
	label: "Stage 14 — Merge",
	agent: "orchestrator",
	buildPrompt: (state) => P.buildMergePrompt(S(state)),
});

/** A-2 (audit): deterministic merge confirmation. The merge agent's `merged`
 *  self-report is never trusted on its own — this stage re-derives the fact
 *  from git: the feature branch head (the worktree's checked-out branch) must
 *  be an ancestor of the default branch head, and a reported commitSha must
 *  exist. An unconfirmed merge is rewritten to merged:false with the reason,
 *  so runWorkflow reports partial — never success — until git confirms. */
export const mergeVerifyTask: Stage = {
	id: "merge-verify",
	label: "Stage 14B — Merge Verification",
	async run(state, ctx) {
		// A-2 + boolean-drift (run 2026-08-15T13-45-02): the merge agent emitted
		// `merged: "true"` (STRING) — the strict `!== true` read silently SKIPPED
		// verification entirely and the run misreported PARTIAL. LLM booleans are
		// read tolerantly (toBool) and normalized observably; the trust direction
		// never weakens — a truthy claim still has to be git-confirmed below.
		const merge = state.merge as { merged?: unknown; commitSha?: string; mergeCommand?: string; summary?: string; verification?: string } | undefined;
		if (!merge || !toBool(merge.merged)) return { status: "ok" }; // nothing claimed — mergeNotConfirmed already covers it
		if (typeof merge.merged !== "boolean") {
			ctx.log(`merge: self-report merged=${JSON.stringify(merge.merged)} (${typeof merge.merged}) — normalized to true; verifying against git`);
			state.merge = { ...merge, merged: true };
		}
		const setup = state.setup;
		if (!setup?.worktreePath || !setup.defaultBranch) {
			state.merge = { ...merge, merged: false, verification: "FAILED: setup context missing — cannot confirm the merge" };
			ctx.log(`Merge verification FAILED: setup context missing (worktreePath/defaultBranch) — refusing to trust the merge self-report`);
			return { status: "ok" };
		}
		const { execFileSync } = await import("node:child_process");
		const gitOk = (args: string[]): string | null => {
			try { return execFileSync("git", args, { cwd: setup.worktreePath, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"], timeout: 15_000 }).trim(); }
			catch { return null; }
		};
		const gitBool = (args: string[]): boolean => {
			try { execFileSync("git", args, { cwd: setup.worktreePath, encoding: "utf-8", stdio: "ignore", timeout: 15_000 }); return true; }
			catch { return false; }
		};
		const featureBranch = gitOk(["branch", "--show-current"]);
		const reasons: string[] = [];
		if (!featureBranch) reasons.push("could not determine the worktree's current branch (detached HEAD?)");
		const defHead = gitOk(["rev-parse", "--verify", `refs/heads/${setup.defaultBranch}`]);
		if (!defHead) reasons.push(`default branch ref "${setup.defaultBranch}" could not be resolved`);
		const featureHead = featureBranch ? gitOk(["rev-parse", "--verify", `refs/heads/${featureBranch}`]) : null;
		if (featureBranch && !featureHead) reasons.push(`feature branch ref "${featureBranch}" could not be resolved`);
		const ancestor = featureHead && defHead ? gitBool(["merge-base", "--is-ancestor", featureHead, defHead]) : false;
		if (featureHead && defHead && !ancestor) reasons.push(`feature head ${featureHead.slice(0, 12)} is NOT an ancestor of ${setup.defaultBranch} head ${defHead.slice(0, 12)} (merge never landed, or landed in the wrong direction)`);
		const reportedSha = String(merge.commitSha ?? "").trim();
		if (reportedSha && !gitOk(["rev-parse", "--verify", `${reportedSha}^{commit}`])) reasons.push(`reported commitSha ${reportedSha.slice(0, 12)} does not exist`);
		// F-B: geometry alone is not enough — uncommitted TRACKED work in the
		// worktree at merge time would be silently lost (run 2026-08-16T01-00-35:
		// the review fix repaired F-01 but left `M tests/persistence.test.ts`
		// uncommitted; nothing between reviewFix and merge commits it). Untracked
		// files do NOT block (A-3 geometry: pipeline-copied .env files are untracked
		// and git never carries them into a merge). Harness bookkeeping ledgers
		// (events/change-tracker/.resume-cache/…) ARE tracked but the harness itself
		// appends to them after the merge agent's final commit — deterministically,
		// every run (2026-08-16T11-19-05: merge-verify flagged its own 3 ledgers and
		// downgraded a clean merge to PARTIAL) — so they are exempt; a dirty REAL
		// source file still blocks exactly as before.
		const dirtyRaw = gitOk(["status", "--porcelain=v1", "--untracked-files=no"]);
		const dirtyPaths = dirtyRaw ? dirtyRaw.split("\n").filter(Boolean).map((line) => {
			let p = line.slice(3).trim();
			const arrow = p.indexOf(" -> ");
			if (arrow >= 0) p = p.slice(arrow + 4); // rename: the post-rename path is what ships
			if (p.startsWith('"') && p.endsWith('"')) p = p.slice(1, -1);
			return p;
		}) : [];
		const exempt = dirtyPaths.filter((p) => isHarnessBookkeepingPath(setup.specDirectory, p));
		const dirty = dirtyPaths.filter((p) => !isHarnessBookkeepingPath(setup.specDirectory, p));
		if (exempt.length > 0) ctx.log(`merge-verify: exempting ${exempt.length} harness bookkeeping file(s) the pipeline itself appended to after the merge commit: ${exempt.join(", ")}`);
		if (dirty.length > 0) reasons.push(`worktree has ${dirty.length} uncommitted tracked change(s) that would NOT ship with the merge (e.g. ${dirty[0]})`);
		if (reasons.length === 0) {
			state.merge = { ...merge, merged: true, verification: `git-confirmed: ${setup.defaultBranch} @ ${defHead!.slice(0, 12)} contains ${featureBranch}` };
			ctx.log(`Merge verification PASSED: ${setup.defaultBranch} @ ${defHead!.slice(0, 12)} contains feature head (${featureHead!.slice(0, 12)})`);
		} else {
			state.merge = { ...merge, merged: false, verification: `FAILED: ${reasons.join("; ")}` };
			ctx.log(`Merge verification FAILED: ${reasons.join("; ")} — reporting unmerged (run status will be partial, not success)`);
		}
		return { status: "ok" };
	},
};

/** Classify the task for pipeline routing (Stage 2A). Uses an LLM classifier
 *  (intent-aware) instead of the old keyword regex, which misread compound tasks
 *  ("add upload page with error handling" → bug/none because it matched "error").
 *  Falls back to the deterministic `classify-task` helper if the agent produces
 *  nothing, so routing always has a value. The `language`/`isWebUi` fields come
 *  from setup detection; the LLM decides `taskType`/`uiScope`. */
export const classifyStage: Stage = {
	id: "classify",
	label: "Stage 2A — Classify Task",
	async run(state, ctx) {
		const setup = S(state);
		const fallback = await ctx.helper({ name: "classify-task", sources: { setup }, options: { runtimeTask: ctx.task } });
		const base = fallback.value as { taskType?: string; uiScope?: string; language?: string; isWebUi?: boolean; skipStages?: unknown };
		if (!ctx.budget.check()) {
			ctx.log("classify: budget exhausted — using deterministic classification");
			return base;
		}
		// The classifier is a routing convenience, never a hard dependency: an
		// ordinary failure (backend/session error, empty/invalid control) degrades to
		// the deterministic fallback so Stage 2A ALWAYS yields a classification (a
		// missing state.classify recreates the bad routing context this stage fixes).
		// SAFETY/FATAL errors are NOT swallowed: a source-read-only boundary
		// violation (a read-only agent mutated project files) and any FatalAbort must
		// propagate so the pipeline stops — continuing after an unrestored mutation is
		// exactly the failure the boundary guard exists to prevent.
		try {
			const result = await ctx.agent({
				id: "pipeline.classify",
				agent: "task-classifier",
				accessMode: "source-read-only",
				prompt: P.buildClassifyPrompt(setup, ctx.task),
				schema: ClassificationData,
			});
			const c = result.control as { taskType?: string; uiScope?: string; rationale?: string } | null;
			if (!c || !c.taskType || !c.uiScope) {
				ctx.log(`classify: LLM classifier produced no usable result${result.error ? ` (${result.error})` : ""} — using deterministic fallback (${base.taskType}/${base.uiScope})`);
				return base;
			}
			ctx.log(`classify: taskType=${c.taskType} uiScope=${c.uiScope}${c.rationale ? ` — ${c.rationale}` : ""}`);
			// Keep the setup-derived language/isWebUi; the LLM owns taskType/uiScope.
			return { taskType: c.taskType, uiScope: c.uiScope, language: base.language, isWebUi: base.isWebUi, skipStages: base.skipStages ?? [], rationale: c.rationale };
		} catch (err) {
			if (isFatalAbort(err) || isSafetyBoundaryError(err)) throw err; // never swallow safety/fatal
			const msg = err instanceof Error ? err.message : String(err);
			ctx.log(`classify: LLM classifier threw (${msg}) — using deterministic fallback (${base.taskType}/${base.uiScope})`);
			return base;
		}
	},
};

/** Scan the worktree for build artifacts + sensitive data; decide merge blocking. */
export const cleanupTask: Stage = helperTask({
	id: "cleanup",
	label: "Stage 13 — Cleanup",
	helper: "cleanup",
	sources: (state) => ({ docs: state.docs ?? {} }),
	context: (state) => ({ cwd: state.setup?.worktreePath ?? "", worktreeCreated: state.setup?.worktreeCreated ?? false, defaultBranch: state.setup?.defaultBranch ?? null }),
});
