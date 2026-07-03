/**
 * Stage 1 — Setup (deterministic, fatal).
 * Detects language/framework, creates a git worktree, creates the spec dir.
 * Fatal: failure aborts the whole workflow.
 */

import type { Stage } from "../types.ts";
import { runSetup } from "../setup.ts";

export const setupStage: Stage = {
	id: "setup",
	label: "Stage 1 — Setup",
	fatal: true,
	async run(_state, ctx) {
		const setup = runSetup(ctx.task, { cwd: ctx.options.cwd, skipWorktree: ctx.options.skipWorktree });
		ctx.log(`Setup: spec ${setup.specIdentifier} | ${setup.language}${setup.isWebUi ? " (Web UI)" : ""} | branch ${setup.defaultBranch}`);
		ctx.log(`Worktree: ${setup.worktreePath} (${setup.worktreeCreated ? "created" : "in-place, no worktree"}${setup.initializedRepo ? "; git init'd" : ""})`);
		ctx.log(`Spec dir: ${setup.specDirectory}`);
		return setup;
	},
};
