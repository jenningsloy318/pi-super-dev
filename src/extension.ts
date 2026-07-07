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
import { ensureSuperDevDirs, startRun, getRunLogPath, getConfig } from "./render/super-dev-dir.ts";
import { runReflectionAsync } from "./render/reflection.ts";
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
	const stagnant = (s.state as Record<string, unknown>).__stagnated as { rounds?: number } | undefined;
	if (stagnant) lines.push(`  ⚠ Verify-loop stagnant after ${stagnant.rounds} round(s) — see stagnation-report.md in the spec dir. More fixing won't help; consider revising the spec design.`);
	return lines;
}

/** Gap 4.6′-lite — stagnation escalation (scheme C: informative by default, interactive opt-in).
 *  Always writes a stagnation-report.md to the spec dir (baseline, all modes).
 *  When the run is interactive (ctx.hasUI) AND config.escalation === "interactive",
 *  additionally prompts a 3-option select. Returns the chosen option (or undefined
 *  if not interactive / dismissed). For Tier-2 all options just finish the run —
 *  "revise spec" only surfaces the recommendation; auto-replay is deferred (Tier-3). */
interface StagnationRecord {
	rounds?: number;
	verdict?: string;
	findings?: Array<{ file?: string | null; severity?: string | null; title?: string | null }>;
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function handleStagnation(summary: RunSummary, ctx: any, opts?: { escalation?: "informative" | "interactive" }): Promise<string | undefined> {
	const st = (summary.state as Record<string, unknown>).__stagnated as StagnationRecord | undefined;
	if (!st) return undefined;

	// Baseline (all modes): write the report.
	try {
		const findings = (st.findings ?? []).map((f) => `- [${f.severity ?? "?"}] ${f.file ? "`" + f.file + "` " : ""}${f.title ?? ""}`);
		const body = [
			"# Stagnation report",
			"",
			`The verify-loop broke early after **${st.rounds}** review round(s): the same findings recurred across two consecutive iterations.`,
			"",
			`Merged review verdict at stagnation: **${st.verdict ?? "unknown"}**.`,
			"",
			"This usually means the implementation is faithful to a spec that produces the wrong outcome — more fixing will not help. Consider revising the specification's design (constants/algorithm/architecture), or accept these findings as known limitations.",
			"",
			"## Recurring findings",
			...(findings.length ? findings : ["_(no structured findings captured)_"]),
		].join("\n");
		writeFileSync(join(summary.specDirectory, "stagnation-report.md"), body);
	} catch { /* best-effort */ }

	// Opt-in interactive escalation (TUI/RPC only).
	const mode = opts?.escalation ?? getConfig().escalation;
	const interactive = ctx?.hasUI === true && mode === "interactive";
	if (!interactive) return undefined;
	try {
		const choice = await ctx.ui?.select?.(
			"Review loop stagnant — how to proceed?",
			["Revise spec & re-run from design", "Accept findings as known limitations", "Abandon worktree"],
			{ timeout: 120_000 },
		);
		return choice ?? undefined;
	} catch {
		return undefined;
	}
}

/** Truncate to a single line of at most `max` visible chars (for the activity row). */
export function truncateActivity(s: string, max = 100): string {
	const oneLine = s.replace(/\s+/g, " ").trim();
	return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

/** Format the workflow dashboard widget lines (Gap Dashboard). Pure/testable:
 *  the TUI widget renders these via ctx.ui.setWidget. Icon per status, a
 *  done/total header, and an optional live-activity row (what the current
 *  agent is doing right now — the v2 "right panel" data via the safe channel). */
export function formatDashboardLines(entries: Array<{ id: string; label: string; status: string }>, activity?: string): string[] {
	const icon = (st: string) => (st === "ok" ? "✔" : st === "failed" ? "⚠" : st === "skipped" ? "↷" : st === "running" ? "●" : "·");
	const done = entries.filter((e) => e.status !== "running").length;
	const lines = [`super-dev · ${done}/${entries.length} stages`, ...entries.map((e) => `  ${icon(e.status)} ${e.label}`)];
	const a = truncateActivity(activity ?? "");
	if (a) lines.push(`  ▶ ${a}`);
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
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
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
			// Workflow dashboard v1 (Gap Dashboard): always-on phase-tracker widget,
			// TUI-only. Updated from the structured `stage` events emitted by task()
			// nodes (running → terminal). v2 will grow this into a full two-panel
			// interactive ctx.ui.custom() with stop/pause/save keybindings.
			const DASHBOARD_KEY = "super-dev";
			const dashboardStages = new Map<string, { label: string; status: string }>();
			const dashboardOrder: string[] = [];
			let dashboardActivity = "";
			let lastWidget = 0;
			const WIDGET_MS = 200;
			const renderDashboard = () => {
				if (ctx?.mode !== "tui") return; // no-op in print/json/rpc/headless
				const entries = dashboardOrder.map((id) => ({ id, ...dashboardStages.get(id)! }));
				const lines = formatDashboardLines(entries, dashboardActivity);
				lines.push("  esc to abort"); // app.interrupt (keybindings.md) is the idiomatic stop
				try { ctx?.ui?.setWidget?.(DASHBOARD_KEY, lines); } catch { /* best-effort */ }
			};
			// Stage changes are infrequent → render at once; text/log updates are high-rate → throttle.
			const renderDashboardThrottled = () => { const now = Date.now(); if (now - lastWidget >= WIDGET_MS) { renderDashboard(); lastWidget = now; } };
			const sink: ProgressSink = {
				phase: (label) => { finalizeLive(); transcript.push(`▶ ${label}`); dashboardActivity = label; renderDashboard(); flush(); },
				log: (message) => { finalizeLive(); transcript.push(`  ${message}`); dashboardActivity = message; renderDashboardThrottled(); flush(); },
				text: (partial) => {
					live = partial;
					dashboardActivity = partial;
					const now = Date.now();
					if (now - lastFlush >= FLUSH_MS) { flush(); lastFlush = now; renderDashboardThrottled(); }
				},
				stage: (info) => {
					// Workflow dashboard v1 (Gap Dashboard): always-on phase tracker widget.
					if (!dashboardOrder.includes(info.id)) dashboardOrder.push(info.id);
					dashboardStages.set(info.id, { label: info.label, status: info.status });
					renderDashboard();
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
				const escalationChoice = await handleStagnation(summary, ctx);
				if (escalationChoice) lines.push(`  Escalation: user chose "${escalationChoice}".`);
				const isError = summary.status === "failed";
				// Async reflection ("dreaming") — non-blocking, best-effort.
				// Updates learned.md + learned-index.json for future runs.
				runReflectionAsync();
				return { content: [{ type: "text", text: lines.join("\n") }], isError, details: { summary } };
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return { content: [{ type: "text", text: `❌ super-dev pipeline failed: ${message}` }], isError: true, details: {} };
			} finally {
				// Always clear the dashboard widget when the run ends (success or failure).
				try { ctx?.ui?.setWidget?.(DASHBOARD_KEY, undefined); } catch { /* best-effort */ }
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
