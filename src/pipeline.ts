/**
 * Thin public entry: run the super-dev workflow for a task.
 *
 * Resume (v0.3.0): when `options.resume` is set, resolve the target spec
 * (auto-pick most-recent resumable, or the named identifier), load its resume
 * cache, and run with memoization enabled. Every run ALSO captures its results
 * so a future interruption is resumable; a fully-successful run clears its cache
 * (and writes a `.complete` marker) so it isn't re-resumed.
 */

import { runWorkflow } from "./workflow.ts";
import { SUPER_DEV_WORKFLOW } from "./stages/index.ts";
import { loadResumeCache, loadResumeCacheFromPath, clearResumeCache, specDirFor, findResumableSpec, RESUME_CACHE_BASENAME } from "./resume.ts";
import { releaseHeldRunLock } from "./setup.ts";
import type { RunOptions, RunSummary } from "./types.ts";

export async function runPipelineTask(task: string, optionsIn: RunOptions = {}): Promise<RunSummary> {
	// Sweep-3 G15 (INV-3): judge budgets are PER-RUN — reset at entry so an
	// in-process replan auto-resume (or a long-lived extension session) never
	// carries a prior run's exhausted budget into this one.
	try { const { resetJudgeBudgets } = await import("./stages/judge.ts"); resetJudgeBudgets(); } catch { /* never block a run on bookkeeping */ }
	const options: RunOptions = { ...optionsIn };
	const cwd = options.cwd ?? process.cwd();

	if (options.resume) {
		const resumeId = options.resume === true ? findResumableSpec(cwd) : String(options.resume);
		if (resumeId) {
			options.resumeSpecIdentifier = resumeId;
			// 063-S1 gate B1: migrate the pre-S1 in-spec cache BEFORE loading —
			// the setup-stage migration runs later (inside runWorkflow) and the
			// rows would be invisible to this load (silent full re-run).
			// Gate ADV-5 fold: the migration's decision lines (incl. discard /
			// replace verdicts) go to the operator — they are never re-said by
			// the later setup migration (it sees nothing-to-do).
			try {
				const { migrateInSpecState } = await import("./state/state-root.ts");
				const report = await migrateInSpecState(specDirFor(cwd, resumeId), [RESUME_CACHE_BASENAME], (line) => console.warn(`[063-resume] ${line}`));
				if (report.migrations.length > 0) console.warn(`[063-resume] pre-load migration: ${report.migrations.map((m) => `${m.basename}:${m.action}`).join(", ")}`);
			} catch (err) {
				// ADV-5: name the failure — a swallowed migration hides which
				// home the subsequent load actually reads.
				console.warn(`[063-resume] pre-load migration FAILED (best-effort; load falls back to the funnel path): ${err instanceof Error ? err.message : String(err)}`);
			}
			// Gate B2 fold: an ORPHAN resume (worktree died, branch + external
			// state survived) has no spec dir yet — specDirFor gives a
			// nonexistent in-tree path, the funnel fail-closes, and the normal
			// loader reads the in-spec fallback (empty). Load the external
			// cachePath directly when the resume id came from the orphan scan.
			let orphanCachePath: string | undefined;
			try {
				const { externalResumeCandidates } = await import("./state/state-root.ts");
				orphanCachePath = externalResumeCandidates(cwd).find((c) => c.id === resumeId)?.cachePath;
			} catch { /* the scan is advisory here */ }
			options.resumeCache = orphanCachePath
				? loadResumeCacheFromPath(orphanCachePath)
				: loadResumeCache(specDirFor(cwd, resumeId));
			if ((options.resumeCache as Map<string, unknown>)?.size === 0) {
				// B2 honesty: 0 loaded rows with a NON-EMPTY external cache is
				// the silent-full-rerun signature — name it loudly.
				try {
					const { existsSync, readFileSync } = await import("node:fs");
					const { stateFileFor } = await import("./state/state-root.ts");
					const ext = stateFileFor(specDirFor(cwd, resumeId), RESUME_CACHE_BASENAME);
					if (existsSync(ext) && readFileSync(ext, "utf8").trim() !== "") {
						console.warn(`[063-resume] resume loaded 0 rows but the external cache is NON-EMPTY (${ext}) — the memoized stages of this track will re-run live; if this persists the cache keys no longer match the call graph`);
					}
				} catch { /* best-effort naming */ }
			}
		} else {
			// nothing to resume → fall through to a fresh run
			options.resume = undefined;
		}
	}
	// Always capture (empty cache = write-only) so any run is resumable-by-default.
	if (!options.resumeCache) options.resumeCache = new Map();

	let summary: RunSummary;
	try {
		summary = await runWorkflow(SUPER_DEV_WORKFLOW, task, options);
	} finally {
		// AC-30: release the spec-dir run lock on every exit path (the setup
		// stage acquired it inside runSetup).
		releaseHeldRunLock();
	}

	// A fully-successful run is complete: clear its cache + mark `.complete`.
	if (summary.status === "success") {
		clearResumeCache(summary.specDirectory);
	}
	return summary;
}

export { SUPER_DEV_WORKFLOW } from "./stages/index.ts";
export { runWorkflow } from "./workflow.ts";
export type { RunSummary, RunOptions, Workflow, Node, NodeResult, PipelineState } from "./types.ts";
