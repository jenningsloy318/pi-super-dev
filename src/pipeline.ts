/**
 * Thin public entry: run the super-dev workflow for a task.
 */

import { runWorkflow } from "./workflow.ts";
import { SUPER_DEV_WORKFLOW } from "./stages/index.ts";
import type { RunOptions, RunSummary } from "./types.ts";

export async function runPipelineTask(task: string, options: RunOptions = {}): Promise<RunSummary> {
	return runWorkflow(SUPER_DEV_WORKFLOW, task, options);
}

export { SUPER_DEV_WORKFLOW } from "./stages/index.ts";
export { runWorkflow } from "./workflow.ts";
export type { RunSummary, RunOptions, Workflow, Node, NodeResult, PipelineState } from "./types.ts";
