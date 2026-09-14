/**
 * Leaf stages built from the convenience builders in `nodes.ts`:
 *   - single-shot agent "writer" tasks (wrapped in `gate`/`loop` upstream)
 *   - deterministic helper tasks (classify, cleanup)
 */

import { writerTask, helperTask, isFatalAbort } from "../nodes.ts";
import { clearResumeCache } from "../resume.ts";
import type { Stage, SetupControl, PipelineState, StageContext } from "../types.ts";
import * as P from "../prompts.ts";
import { ClassificationData } from "../render/schemas.ts";
import { toBool, normalizePhases } from "../doc-validators.ts";
import { isHarnessBookkeepingPath } from "../helpers.ts";
import { priorReplanConstraintBlock } from "../replan/replan.ts";
// 059 R1A W1 (D-R-C plumbing): the write-time contract-surface slice — computed
// per buildPrompt call (fresh walk, no cache) and stamped on the pipeline state
// so the R4 exemption + R3 validators read what the writer saw.
// 059 R1B (D-R-C reviewer portion): the reviewer-side slice — re-rendered from
// the WRITER's stamp (readContractSliceStamp) so each reviewer sees the same
// contract-surface pins its stage's writer saw.
import { CONTRACT_INVENTORY_ERROR_BANNER, CONTRACT_SLICE_MAX_LINES, CONTRACT_SLICE_TRUNCATION_MARKER, extractContractInventory, readContractSliceStamp, stampContractSlice, writerContractSlice, type ContractSliceStamp } from "../review/contract-surface.ts";

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
	buildPrompt: (state, ctx) => {
		// 059 W1: Stage 2B evaluates task + classify + the invariants mapping (no
		// artifact exists yet). Absent worktree ⇒ null slice ⇒ section omitted.
		const slice = writerContractSlice(S(state).worktreePath, [ctx.task, JSON.stringify(state.classify ?? {})]);
		if (slice) stampContractSlice(state as Record<string, unknown>, "requirements", slice);
		return P.buildRequirementsPrompt(S(state), state.classify ?? null, ctx.task, slice?.block ?? "");
	},
});

export const bddWriter: Stage = writerTask({
	id: "bdd",
	label: "Stage 2C — BDD Scenarios",
	agent: "bdd-scenario-writer",
	accessMode: "source-read-only",
	requires: ["*-requirements.md"],
	buildPrompt: (state, ctx) => {
		// 059 W1: later writer stages evaluate their upstream artifacts (task +
		// requirements control here) against the contract inventory.
		const slice = writerContractSlice(S(state).worktreePath, [ctx.task, JSON.stringify(state.requirements ?? {})]);
		if (slice) stampContractSlice(state as Record<string, unknown>, "bdd", slice);
		return P.buildBddPrompt(S(state), state.classify ?? null, ctx.task, state.requirements ?? null, slice?.block ?? "");
	},
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
	// One-shot task-wired writer: no convergence node guards its render — retry
	// inline (runs 2026-08-30T00-14-16/05-26-19 dropped the debug doc silently).
	renderRetries: 2,
	buildPrompt: (state, ctx) => P.buildDebugPrompt(S(state), state.classify ?? null, ctx.task, state.requirements ?? null, state.research ?? null),
});

export const assessmentWriter: Stage = writerTask({
	id: "assessment",
	label: "Stage 5 — Code Assessment",
	agent: "code-assessor",
	accessMode: "source-read-only",
	renderRetries: 2,
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

/** The spec writer's prompt builder, as a named export: the write-time slice
 *  stamping is a REAL side effect of prompt construction (059 W1), and the S8
 *  honesty test exercises this exact function (no manual stampContractSlice). */
export function specWriterBuildPrompt(state: PipelineState, ctx: StageContext): string {
	// 059 W1: the spec's write-time slice over task + every upstream control —
	// the SAME texts spec-convergence's fallback validator evaluates, so the
	// stamped slice and the validator context agree.
	const slice = writerContractSlice(S(state).worktreePath, [ctx.task, JSON.stringify(state.requirements ?? {}), JSON.stringify(state.bdd ?? {}), JSON.stringify(state.research ?? {}), JSON.stringify(state.assessment ?? {}), JSON.stringify(state.design ?? {}), JSON.stringify(state.prototype ?? {})]);
	if (slice) stampContractSlice(state as Record<string, unknown>, "spec", slice);
	return P.buildSpecPrompt(S(state), state.classify ?? null, ctx.task, state.requirements ?? null, state.bdd ?? null, state.research ?? null, state.assessment ?? null, state.design ?? null, state.prototype ?? null, priorReplanConstraintBlock((state as { setup?: { specDirectory?: string } | undefined }).setup?.specDirectory), slice?.block ?? "");
}

export const specWriter: Stage = writerTask({
	id: "spec",
	label: "Stage 7 — Specification",
	agent: "spec-writer",
	accessMode: "source-read-only",
	requires: ["*-requirements.md", "*-bdd-scenarios.md"],
	buildPrompt: specWriterBuildPrompt,
	normalizeControl: normalizeSpecControl,
});

/** 059 R1B (§3 R2, D-R-C reviewer portion): render the reviewer's
 *  contract-surface section from the WRITER's stamp — the stamp carries the
 *  slice identity (touched files + pinIds, exactly what the writer's prompt
 *  saw), and pin detail (locus + statement) comes from a fresh inventory walk
 *  (059 §3 R1 extraction timing: fresh read at each review dispatch; same tree
 *  ⇒ same pins). No stamp / empty touched-set / absent worktree / any error ⇒
 *  "" ⇒ the prompt section is omitted entirely — fail-closed harmless (the S5
 *  degrade policy; pre-W/resume replays carry no stamp). Deterministic; never
 *  throws. Exported so the R1B prompt tests exercise this exact function. */
export function reviewerContractSliceBlock(state: PipelineState, stage: string): string {
	try {
		const stamp: ContractSliceStamp | undefined = readContractSliceStamp(state as Record<string, unknown>, stage);
		if (!stamp || stamp.files.size === 0 || stamp.pinIds.size === 0) return "";
		const worktreePath = state.setup?.worktreePath;
		if (!worktreePath) return "";
		const inventory = stamp.inventory ?? extractContractInventory(worktreePath);
		const pinIds = new Set(stamp.pinIds);
		// Same header the writer's block carries (the SAME slice, reviewer side).
		const lines = ["## Contract Surface Slice — shared baseline pins this change may touch"];
		// DEC-4 fail-loud: an extraction error on an existing tree must never
		// silently shrink the review inputs. (When extraction failed there is
		// nothing to drift-check — the banner IS the honest signal.)
		const extractionFailed = inventory.errors.length > 0;
		if (extractionFailed) {
			lines.push(CONTRACT_INVENTORY_ERROR_BANNER, ...inventory.errors.slice(0, 4).map((e) => `- extraction: ${e}`));
		}
		const matched = new Set<string>();
		for (const file of [...stamp.files].sort()) {
			for (const pin of inventory.protectedFiles.get(file) ?? []) {
				if (pinIds.has(pin.pinId)) {
					matched.add(pin.pinId);
					lines.push(`- ${file}: ${pin.pinId} ${pin.idiomFamily} @ ${pin.locus} — ${pin.statement}`);
				}
			}
		}
		// Stamp-fidelity drift guard (059 §3 R1: "same tree ⇒ same slice"):
		// when the fresh walk can no longer account for EVERY pinned pinId the
		// writer stamped, the tree drifted between write and review — emitting
		// the residual would be silent skew. Fail closed to "" (the S5 degrade
		// policy): no slice at all, never a partial one.
		if (!extractionFailed && matched.size < pinIds.size) return "";
		for (const pin of inventory.unanchored) {
			lines.push(`unanchored: ${pin.pinId} "${pin.statement}" @ ${pin.locus} — ${pin.unanchoredReason ?? "unresolved"}`);
		}
		// The stamp's pinIds are already capped at 15 (they WERE the writer's
		// slice); the line budget still bounds the whole section (P8/P10).
		if (lines.length > CONTRACT_SLICE_MAX_LINES) {
			lines.length = CONTRACT_SLICE_MAX_LINES - 1;
			lines.push(CONTRACT_SLICE_TRUNCATION_MARKER);
		}
		return lines.length > 1 ? lines.join("\n") : "";
	} catch {
		return "";
	}
}

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
			// 059 R1B: the requirements writer's stamped slice (fail-closed when absent)
			contractSliceBlock: reviewerContractSliceBlock(state, "requirements"),
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
			// 059 R1B: the bdd writer's stamped slice (fail-closed when absent)
			contractSliceBlock: reviewerContractSliceBlock(state, "bdd"),
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
			// 059 R1B: the design writer's stamped slice (fail-closed when absent)
			contractSliceBlock: reviewerContractSliceBlock(state, "design"),
		}),
});

export const specReviewWriter: Stage = writerTask({
	id: "specReview",
	label: "Stage 8 — Spec Review",
	agent: "spec-reviewer",
	accessMode: "source-read-only",
	requires: ["*-specification.md", "*-implementation-plan.md", "*-task-list.md"],
	// 059 R1B: the spec writer's stamped slice rides the new additive 4th param.
	buildPrompt: (state) => P.buildSpecReviewPrompt(S(state), state.classify ?? null, state.spec ?? null, reviewerContractSliceBlock(state, "spec")),
});

export const docsWriter: Stage = writerTask({
	id: "docs",
	label: "Stage 12 — Documentation",
	agent: "docs-executor",
	accessMode: "source-read-only",
	requires: ["*-specification.md"],
	renderRetries: 2,
	buildPrompt: (state, ctx) => P.buildDocsPrompt(S(state), state.classify ?? null, ctx.task, state.spec ?? null),
});

export const mergeWriter: Stage = writerTask({
	id: "merge",
	label: "Stage 14 — Merge",
	agent: "orchestrator",
	renderRetries: 2,
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
			// v0.3.12 F2 (incident: merged tracks stayed live reuse candidates —
			// .complete was only written on summary.status==="success", and every
			// merged run that cancelled/parteled at close-out left the track
			// isResumable forever; the 06 task then absorbed into merged-05).
			// A git-confirmed merge IS completion — close the track NOW: cache
			// cleared + marker written, at the moment git confirms, not at
			// summary time. clearResumeCache is idempotent (marker-checked), so
			// the pipeline.ts success-path call stays a no-op.
			try {
				clearResumeCache(setup.specDirectory);
				ctx.log(`merge-verify: track closed — .complete written for ${setup.specIdentifier ?? setup.specDirectory} (merged tracks are never reuse/resume candidates)`);
			} catch (e) {
				ctx.log(`merge-verify: track close-out FAILED (best-effort): ${e instanceof Error ? e.message : String(e)}`);
			}
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
		// Fabrication honesty (run 2026-08-27T13-12-39-803Z): a fallback-derived
		// control must NEVER be indistinguishable from an agent verdict — the
		// aborted run's audit row showed a perfectly healthy classify control that
		// the deterministic fallback had fabricated. Every fallback return carries
		// `fallback: true` and logs at WARN so downstream consumers (and the
		// audit trail) can tell derived-from-task apart from judged-by-model.
		if (!ctx.budget.check()) {
				ctx.log("WARN classify: budget exhausted — using deterministic classification (fallback)");
			return { ...base, fallback: true };
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
			const c = result.control as { taskType?: string; uiScope?: string; rationale?: string; skillDomains?: string[] } | null;
			if (!c || !c.taskType || !c.uiScope) {
				ctx.log(`WARN classify: LLM classifier produced no usable result${result.error ? ` (${result.error})` : ""} — using deterministic fallback (${base.taskType}/${base.uiScope}, flagged fallback)`);
				return { ...base, fallback: true };
			}
			ctx.log(`classify: taskType=${c.taskType} uiScope=${c.uiScope}${c.rationale ? ` — ${c.rationale}` : ""}`);
			// Keep the setup-derived language/isWebUi; the LLM owns taskType/uiScope.
			// v0.3.76 L1: domains ride the classification (tolerant — only KNOWN
			// domains map to curated sets; unknowns are recorded, mapped to nothing).
			const domains = Array.isArray(c.skillDomains) ? c.skillDomains.filter((d): d is string => typeof d === "string") : undefined;
			return { taskType: c.taskType, uiScope: c.uiScope, language: base.language, isWebUi: base.isWebUi, skipStages: base.skipStages ?? [], rationale: c.rationale, ...(domains && domains.length > 0 ? { skillDomains: domains } : {}) };
		} catch (err) {
			if (isFatalAbort(err) || isSafetyBoundaryError(err)) throw err; // never swallow safety/fatal
			const msg = err instanceof Error ? err.message : String(err);
			ctx.log(`WARN classify: LLM classifier threw (${msg}) — using deterministic fallback (${base.taskType}/${base.uiScope}, flagged fallback)`);
			return { ...base, fallback: true };
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
