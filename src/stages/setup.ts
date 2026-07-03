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
		ctx.log(`Spec ${setup.specIdentifier} | ${setup.language} | Web UI ${setup.isWebUi} | Branch ${setup.defaultBranch}`);
		ctx.log(`Worktree: ${setup.worktreePath}`);
		return setup;
	},
};
