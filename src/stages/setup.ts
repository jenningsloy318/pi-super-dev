/**
 * Stage 1 — Setup (deterministic, fatal).
 * Detects language/framework, creates a git worktree, creates the spec dir.
 * Fatal: failure aborts the whole workflow.
 */

import type { Stage } from "../types.ts";
import { runSetup } from "../setup.ts";
import { abbreviatePath } from "../pi-spawn.ts";
import { summarizeSlug } from "../session-agent.ts";

export const setupStage: Stage = {
	id: "setup",
	label: "Stage 1 — Setup",
	fatal: true,
	async run(_state, ctx) {
		const cwd = ctx.options.cwd ?? process.cwd();
		// Try an LLM-summarized spec slug (concise, meaningful); fall back to the
		// deterministic slugifyTask inside runSetup on any failure/timeout.
		let slug = "";
		try {
			slug = await summarizeSlug(ctx.task, cwd, { signal: ctx.signal });
		} catch { /* fallback below */ }
		const setup = runSetup(ctx.task, { cwd: ctx.options.cwd, skipWorktree: ctx.options.skipWorktree, slug });
		const relWorktree = abbreviatePath(setup.worktreePath, cwd);
		const relSpec = abbreviatePath(setup.specDirectory, setup.worktreePath) || ".";
		ctx.log(`Setup: spec ${setup.specIdentifier} | ${setup.language}${setup.isWebUi ? " (Web UI)" : ""} | branch ${setup.defaultBranch}`);
		ctx.log(`Worktree: ${relWorktree}${setup.worktreeCreated ? " (created)" : " (in-place)"}${setup.initializedRepo ? "; git init'd" : ""}`);
		ctx.log(`Spec dir: ${relSpec}`);
		return setup;
	},
};
