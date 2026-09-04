/**
 * Stage 1 — Setup (deterministic, fatal).
 * Detects language/framework, creates a git worktree, creates the spec dir.
 * Fatal: failure aborts the whole workflow.
 */

import type { Stage } from "../types.ts";
import { seedRunEpochFromJournal } from "../routing/journal.ts";
import { runSetup, referencedSpecIdentifier } from "../setup.ts";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { abbreviatePath } from "../agents/agent-runtime.ts";
import { summarizeSlug } from "../agents/agent-runtime.ts";
import { ChangeTracker, setActiveTracker } from "../tracking.ts";

export const setupStage: Stage = {
	id: "setup",
	label: "Stage 1 — Setup",
	fatal: true,
	async run(_state, ctx) {
		const cwd = ctx.options.cwd ?? process.cwd();
		const resumeId = ctx.options.resumeSpecIdentifier;
		// On resume we reuse the existing spec id, so skip the LLM slug call.
		let slug = "";
		if (!resumeId && !referencedSpecIdentifier(ctx.task, cwd)) {
			// Skip the LLM slug call when the task explicitly re-enters an EXISTING
			// spec track (docs/specifications/NN-…): that runSetup branch never
			// allocates a fresh id, so an eagerly computed slug would be discarded.
			try {
				slug = await summarizeSlug(ctx.task, cwd, { signal: ctx.signal });
			} catch { /* fallback below */ }
		}
		const setup = runSetup(ctx.task, { cwd: ctx.options.cwd, skipWorktree: ctx.options.skipWorktree, slug, resumeSpecIdentifier: resumeId, log: (m) => ctx.log(m) });
		if (setup.reusedTrack) {
			let anchorPreview = "";
			try {
				anchorPreview = readFileSync(join(setup.specDirectory, ".task"), "utf8").slice(0, 100).replace(/\s+/g, " ");
			} catch { /* anchor absent — containment-only match */ }
			ctx.log(`Setup: reusing spec track ${setup.specIdentifier} (task similarity match${anchorPreview ? `; anchor: \"${anchorPreview}\"…` : ""}) — prior docs, knowledge and user notes preserved; convergence ledger restarts; the STALE resume cache was truncated for this fresh entry (sweep-3 SETUP-4 honesty: use --resume to REPLAY a dead run instead); set SUPER_DEV_NO_SPEC_REUSE=1 to force a fresh track`);
		}
		// A-3 observability (logging-only): make it visible WHY an untracked .env
		// in the worktree does not block the merge — setup itself copied it for
		// integration-test credentials; the sensitive scan is git-carried-only.
		if (setup.copiedEnvFiles && setup.copiedEnvFiles.length > 0) {
			ctx.log(`Setup copied ${setup.copiedEnvFiles.length} untracked env file(s) into the worktree for integration testing (never merged; excluded from the sensitive-data scan): ${setup.copiedEnvFiles.join(", ")}`);
		}
		// spec-11 AC-05 / SCENARIO-010 (review finding CR-01): ACTUALLY install the
		// per-run ChangeTracker singleton the instant the setup's `worktreePath`
		// + `specDirectory` are finalized — right here, before any producing stage
		// runs. Without this call the import above is dead and the entire
		// bracketing + cross-check gate + false-green killer never executes in a
		// real run. setActiveTracker overwrites any stale singleton left by an
		// overlapping/aborted prior run (the discard guard); construction is
		// side-effect-free (no git/fs). Cleared in src/extension.ts execute()'s
		// finally (setActiveTracker(null)) so no tracker leaks across runs.
		setActiveTracker(new ChangeTracker(setup.specDirectory, setup.worktreePath));
		const relWorktree = abbreviatePath(setup.worktreePath, cwd);
		const relSpec = abbreviatePath(setup.specDirectory, setup.worktreePath) || ".";
		ctx.log(`Setup: spec ${setup.specIdentifier} | ${setup.language}${setup.isWebUi ? " (Web UI)" : ""} | branch ${setup.defaultBranch}${resumeId ? " (resumed)" : ""}`);
		// M3 routing (MP1): on an explicit --resume, seed the routing budget
		// epoch from the PERSISTED epoch file (routing-epoch.json) — the crashed
		// run's jumps count against the resumed budget (never re-arm). This is
		// the first seam where BOTH the spec dir and the resume identity exist
		// (the walker entry runs before setup, where state.setup is empty).
		if (resumeId) seedRunEpochFromJournal(setup.specDirectory);
		ctx.log(`Worktree: ${relWorktree}${setup.worktreeCreated ? " (created)" : " (in-place)"}${setup.initializedRepo ? "; git init'd" : ""}`);
		ctx.log(`Spec dir: ${relSpec}`);
		return setup;
	},
};
