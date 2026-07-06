/**
 * Pi extension entry point.
 *
 * Registers:
 *   - `super_dev` tool — the LLM-callable entry that runs the 13-stage
 *     pipeline by spawning `pi` child processes. Fully self-contained: no
 *     dependency on @agwab/pi-workflow or any other workflow engine. The
 *     pipeline is a tree of control-flow nodes (src/nodes.ts) composed in
 *     src/stages/index.ts.
 *   - `/super-dev <task>` command — dispatches the task to the agent, which
 *     invokes the `super_dev` tool.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensureSuperDevDirs, startRun, getRunLogPath } from "./render/super-dev-dir.ts";
import { runPipelineTask } from "./pipeline.ts";
import { abbreviatePath } from "./pi-spawn.ts";
import type { ProgressSink, RunStatus, RunSummary } from "./types.ts";

export { runPipelineTask } from "./pipeline.ts";
export { SUPER_DEV_WORKFLOW } from "./stages/index.ts";
export * as nodes from "./nodes.ts";
export { runWorkflow } from "./workflow.ts";

const SUPER_DEV_TOOL = "super_dev";
const SUPER_DEV_COMMAND = "super-dev";

/** Format a run summary honestly: success ✅ / partial ⚠️ / failed ❌. */
function formatSummary(s: RunSummary, cwd?: string): string[] {
	const icon: Record<RunStatus, string> = { success: "✅", partial: "⚠️", failed: "❌" };
	const title: Record<RunStatus, string> = {
		success: "super-dev pipeline complete",
		partial: "super-dev pipeline completed with issues",
		failed: "super-dev pipeline did NOT complete",
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
	return lines;
}

export default function activate(pi: ExtensionAPI): void {
	pi.registerTool({
		name: SUPER_DEV_TOOL,
		label: "Super Dev",
		description:
			"Run the self-contained 13-stage super-dev pipeline (requirements → research → design → spec → TDD implementation → code review → docs → merge). Spawns specialist `pi` subagents directly — no external workflow engine required.",
		promptSnippet: "Run the full 13-stage super-dev development pipeline for a feature/bug/refactor task",
		promptGuidelines: [
			"Use super_dev when the user asks to implement a feature, fix a bug, or refactor code as a structured multi-stage workflow.",
			"Pass the user's full task verbatim to super_dev; do not paraphrase constraints, file references, or acceptance criteria.",
		],
		parameters: Type.Object({
			task: Type.String({ description: "The full development task, e.g. 'implement OAuth2 login' or 'fix the crash on large file upload'." }),
			skipWorktree: Type.Optional(Type.Boolean({ description: "Skip git worktree creation and operate in the current directory. Default: false." })),
			skipStages: Type.Optional(Type.Array(Type.String(), { description: "Stage output keys to skip (advanced). Default: none." })),
			model: Type.Optional(Type.String({ description: "Model override for spawned specialist agents in provider/id form." })),
			maxAgents: Type.Optional(Type.Number({ description: "Maximum specialist agent spawns. Default: 200." })),
		}),
		async execute(_toolCallId, params, signal, onUpdate) {
			const task = String(params.task ?? "").trim();
			if (!task) {
				return { content: [{ type: "text", text: "super_dev requires a non-empty `task`." }], isError: true, details: {} };
			}
			const transcript: string[] = [];
			let live = "";
			let lastFlush = 0;
			const FLUSH_MS = 80;
			// The live display is a ROLLING TAIL. A full run (100+ agents) produces
			// thousands of transcript lines; sending the whole thing on every flush
			// let pi truncate it, and since later stages append at the END, they were
			// the first to fall off the visible window ("very little logs afterwards").
			// The tail keeps the CURRENT activity visible; the full log is written to
			// disk at run end so nothing is lost.
			const TAIL_LINES = 400;
			const finalizeLive = () => {
				if (live) {
					transcript.push(live);
					live = "";
				}
			};
			const flush = () => {
				const all = live ? [...transcript, live] : transcript;
				const body = all.length > TAIL_LINES
					? `… ${all.length - TAIL_LINES} earlier lines trimmed (full log saved at run end) …\n` + all.slice(-TAIL_LINES).join("\n")
					: all.join("\n");
				onUpdate?.({ content: [{ type: "text", text: body }], details: {} });
			};
			const sink: ProgressSink = {
				phase: (label) => { finalizeLive(); transcript.push(`▶ ${label}`); flush(); },
				log: (message) => { finalizeLive(); transcript.push(`  ${message}`); flush(); },
				text: (partial) => {
					live = partial;
					const now = Date.now();
					if (now - lastFlush >= FLUSH_MS) { flush(); lastFlush = now; }
				},
			};
			try {
				ensureSuperDevDirs();
				startRun();
				const summary = await runPipelineTask(task, {
					cwd: process.cwd(),
					skipWorktree: params.skipWorktree === true,
					skipStages: params.skipStages as string[] | undefined,
					model: params.model as string | undefined,
					maxAgents: typeof params.maxAgents === "number" ? params.maxAgents : undefined,
				progress: sink,
					signal,
				});
				const lines = formatSummary(summary, process.cwd());
				// Preserve the FULL run log to disk (the live display is a rolling tail).
				let logPath = "";
				try {
					logPath = getRunLogPath();
					writeFileSync(logPath, transcript.join("\n") + "\n");
				} catch { /* best-effort; the live tail is the primary surface */ }
				if (logPath) lines.push(`Full run log: ${logPath}`);
				const isError = summary.status === "failed";
				return { content: [{ type: "text", text: lines.join("\n") }], isError, details: { summary } };
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return { content: [{ type: "text", text: `❌ super-dev pipeline failed: ${message}` }], isError: true, details: {} };
			}
		},
	});

	pi.registerCommand(SUPER_DEV_COMMAND, {
		description: "Run the 13-stage super-dev pipeline. Usage: /super-dev <task description>",
		handler: async (args, ctx) => {
			const task = String(args ?? "").trim();
			if (!task) {
				ctx.ui.notify(
					"Usage: /super-dev <task description>\n\nExamples:\n  /super-dev implement user authentication with OAuth2\n  /super-dev fix the crash when uploading large files",
					"info",
				);
				return;
			}
			// Dispatch to the agent so it runs interruptibly and the tool streams progress.
			pi.sendUserMessage(`Use the ${SUPER_DEV_TOOL} tool to run the full super-dev pipeline for this task: ${task}`);
		},
	});
}
