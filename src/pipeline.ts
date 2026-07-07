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
import { loadResumeCache, clearResumeCache, specDirFor, findResumableSpec } from "./resume.ts";
import type { RunOptions, RunSummary } from "./types.ts";

export async function runPipelineTask(task: string, optionsIn: RunOptions = {}): Promise<RunSummary> {
	const options: RunOptions = { ...optionsIn };
	const cwd = options.cwd ?? process.cwd();

	if (options.resume) {
		const resumeId = options.resume === true ? findResumableSpec(cwd) : String(options.resume);
		if (resumeId) {
			options.resumeSpecIdentifier = resumeId;
			options.resumeCache = loadResumeCache(specDirFor(cwd, resumeId));
		} else {
			// nothing to resume → fall through to a fresh run
			options.resume = undefined;
		}
	}
	// Always capture (empty cache = write-only) so any run is resumable-by-default.
	if (!options.resumeCache) options.resumeCache = new Map();

	const summary = await runWorkflow(SUPER_DEV_WORKFLOW, task, options);

	// A fully-successful run is complete: clear its cache + mark `.complete`.
	if (summary.status === "success") {
		clearResumeCache(summary.specDirectory);
	}
	return summary;
}

export { SUPER_DEV_WORKFLOW } from "./stages/index.ts";
export { runWorkflow } from "./workflow.ts";
export type { RunSummary, RunOptions, Workflow, Node, NodeResult, PipelineState } from "./types.ts";
