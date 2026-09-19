import { spawnSync } from "node:child_process";
import type { RunSummary, RunStatus } from "../types.ts";
import { superDevEnv } from "../render/super-dev-dir.ts";
import { abbreviatePath } from "../agents/agent-runtime/runtime.ts";
import { localTimestamp } from "../render/time.ts";

/** Wave 3 increment 2: the run presentation helpers (the honest summary
 *  block, duration formatting, launch metadata, the replan auto-resume env
 *  read), extracted from extension.ts verbatim. One reason to change: how a
 *  finished run is presented to the human. */

/** OQ6 (dsh-09 v3): replan auto-resume defaults ON; SUPER_DEV_REPLAN_MANUAL=1
 *  opts into confirm-first single runs. Lazy env read (defensive rule #5). */
export function autoResumeEnabled(): boolean {
	return superDevEnv("SUPER_DEV_REPLAN_MANUAL") !== "1";
}

/** Format a run summary honestly: success ✅ / partial ⚠️ / failed ❌ / replan 🔁. */
export function formatSummary(s: RunSummary, cwd?: string): string[] {
	const icon: Record<RunStatus, string> = { success: "✅", partial: "⚠️", failed: "❌", replan: "🔁" };
	const title: Record<RunStatus, string> = {
		success: "super-dev pipeline complete",
		partial: "super-dev pipeline completed with issues",
		failed: "super-dev pipeline did NOT complete",
		replan: "super-dev pipeline reached a replan boundary",
	};
	const impl = s.state.implementation as { summary?: string; totalPhases?: number; allGreen?: boolean } | undefined;
	const review = s.state.review as { verdict?: string } | undefined;
	const setup = s.state.setup as { language?: string; isWebUi?: boolean; defaultBranch?: string; worktreeCreated?: boolean; initializedRepo?: boolean } | undefined;
	const classify = s.state.classify as { taskType?: string; uiScope?: string } | undefined;
	const lines = [
		`${icon[s.status]} ${title[s.status]}`,
		`  Spec:     ${s.specIdentifier || "(none)"}`,
		`  Worktree: ${abbreviatePath(s.worktreePath, cwd)}${setup?.worktreeCreated ? " (created)" : setup ? " (in-place)" : ""}`,
		`  Stack:    ${setup ? `${setup.language}${setup.isWebUi ? " | Web UI" : ""}${setup.defaultBranch ? ` | branch ${setup.defaultBranch}` : ""}` : "n/a"}`,
		`  Classify: ${classify ? `${classify.taskType}${classify.uiScope ? ` | ${classify.uiScope}` : ""}` : "n/a"}`,
		`  Agents:   ${s.agentsSpawned} spawned`,
		`  Impl:     ${impl?.summary ?? (impl ? `${impl.totalPhases ?? 0} phase(s), allGreen=${impl.allGreen ?? false}` : "none produced")}`,
		`  Review:   ${review?.verdict ?? (s.state.review ? "no verdict" : "skipped")}`,
		`  Merged:   ${s.state.merge ? String((s.state.merge as { merged?: boolean }).merged ?? false) : "skipped"}`,
	];
	if (s.failedStages.length > 0) {
		const fmt = (f: { label: string; error?: string }) => {
			const e = f.error ? ` — ${f.error}` : "";
			return `${f.label}${e}`;
		};
		lines.push(`  Failed:   ${s.failedStages.map(fmt).join("\n            ")}`);
	}
	if (s.error) lines.push(`  Error:    ${s.error}`);
	const replan = (s.state as Record<string, unknown>).__replan as { rounds?: number; owners?: string[]; newRequests?: number; invalidationSet?: string[] } | undefined;
	if (replan) lines.push(`  🔁 Replan round ${replan.rounds}: ${replan.newRequests ?? 0} finding(s) routed back to ${replan.owners?.join(", ") ?? "?"}; ${replan.invalidationSet?.length ?? 0} stage(s) invalidated — ${autoResumeEnabled() ? "auto-resuming" : "manual resume required (SUPER_DEV_REPLAN_MANUAL=1)"}.`);
	const stagnant = (s.state as Record<string, unknown>).__stagnated as { rounds?: number; kind?: string } | undefined;
	if (stagnant) {
		lines.push(stagnant.kind === "blocked-on-decisions"
			? `  ⚠ Verify-loop blocked on decisions after ${stagnant.rounds} round(s) — every remaining finding is deferred (no code fixer can act); awaiting a human decision. See escalation-report.md in the spec dir.`
			: `  ⚠ Verify-loop stagnant after ${stagnant.rounds} round(s) — see escalation-report.md in the spec dir. The workflow reached review/verify but could not converge; inspect recurring findings or provide guidance before rerun.`);
	}
	return lines;
}

export function formatDuration(ms: number): string {
	if (!Number.isFinite(ms) || ms < 0) return "unknown";
	if (ms < 1000) return `${ms}ms`;
	const sec = ms / 1000;
	if (sec < 60) return `${sec.toFixed(sec < 10 ? 1 : 0)}s`;
	const min = Math.floor(sec / 60);
	const rem = Math.round(sec % 60);
	return `${min}m ${rem}s`;
}

function gitValue(cwd: string, args: string[]): string {
	try {
		const result = spawnSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
		if (result.status !== 0) return "n/a";
		return result.stdout.trim() || "n/a";
	} catch {
		return "n/a";
	}
}

export function launchMetadataLines(task: string, cwd: string, runLogPath: string): string[] {
	return [
		`Run started: ${localTimestamp()}`,
		`Task: ${task}`,
		`Launch cwd: ${cwd}`,
		`Launch worktree: ${gitValue(cwd, ["rev-parse", "--show-toplevel"])}`,
		`Launch branch: ${gitValue(cwd, ["branch", "--show-current"])}`,
		`Run log: ${runLogPath}`,
	];
}
