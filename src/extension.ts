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

import type { ExtensionAPI, Theme, ExtensionContext, InputEvent } from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";
import { packDashboardLines, padTruncate, truncateActivity, buildDashboardWidget, createDashboardWidgetFactory, buildResultComponent } from "./render/dashboard.ts";
import type { DashboardTheme } from "./render/dashboard.ts";
import { createLiveStream } from "./render/live-stream.js";
import type { TranscriptLine, LiveStreamHandle } from "./render/live-stream.js";
import { Type } from "typebox";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensureSuperDevDirs, startRun, getRunLogPath, getConfig } from "./render/super-dev-dir.ts";
import { runReflectionAsync } from "./render/reflection.ts";
import { runPipelineTask } from "./pipeline.ts";
import { abbreviatePath } from "./pi-spawn.ts";
import { setActiveTracker } from "./tracking.ts";
import type { ProgressSink, RunStatus, RunSummary } from "./types.ts";

export { runPipelineTask } from "./pipeline.ts";
export { SUPER_DEV_WORKFLOW } from "./stages/index.ts";
export * as nodes from "./nodes.ts";
export { runWorkflow } from "./workflow.ts";

const SUPER_DEV_TOOL = "super_dev";
const SUPER_DEV_COMMAND = "super-dev";

/**
 * Phase 1 (AC-01 / AC-02 / AC-03) — Mid-run input injection run-state singleton.
 *
 * `activeRun` is the single module-scoped source of truth for "a super_dev run
 * is in progress." It is created on `execute()` entry (ctx stored on it) and
 * nulled in the existing execute() `finally` alongside the dashboard-widget
 * teardown, so run teardown and widget teardown stay unified (SCENARIO-002).
 *
 * The module-lifetime `pi.events.on("input", handler)` listener — registered
 * EXACTLY ONCE in `activate(pi)`, never per-run — reads this singleton to
 * decide {active-run + interactive}→handled / {else}→continue (AC-03), which
 * also prevents listener leaks across runs (AC-01 / SCENARIO-001).
 *
 * Phase 1 ships ONLY the queue mechanics + guards. ACK surfaces (status pill,
 * dashboard count, transcript LineKind) are added in Phase 2; the
 * `userSteerProvider` drain seam is wired in Phase 3.
 */
export interface ActiveRun {
	/** Pending mid-run user inputs not yet injected into a specialist prompt. */
	queue: string[];
	/** True when this run executes DETACHED in the background (the tool returned
	 *  immediately). Background runs leave the session fully interactive, so the
	 *  input listener never captures keystrokes as steering — every command / new
	 *  turn flows through pi's normal pipeline and executes DURING the run. */
	background?: boolean;
	/** The execute() ctx (TUI guards + ACK surfaces use this — Phase 2). */
	ctx?: ExtensionContext;
	/** The live-stream handle (Phase 2 ACK: pushes the user-input transcript
	 *  line). Optional so the Phase 1 idle-shape (no stream) still works. */
	stream?: LiveStreamHandle;
	/** Store interactive input. Empty/whitespace-only is skipped (SCENARIO-007). */
	push(text: string): void;
	/** Atomically return the pending inputs AND clear the queue (SCENARIO-013). */
	drain(): string[];
}

let activeRun: ActiveRun | null = null;

/** Bound on queued mid-run inputs so a single specialist spawn cannot be
 *  token-bombed via a huge guidance prepend. Older entries are dropped first
 *  (most-recent guidance wins — it reflects the user's latest intent). */
const MAX_QUEUED_INPUTS = 20;

/** Phase 4 (AC-08 / SCENARIO-017..018): the session-backend live-steer
 *  forwarder, set by `runAgentViaSession`'s `onSteer` seam while a specialist
 *  AgentSession is alive and nulled on dispose. The input handler nudges it
 *  with the MOST-RECENT captured input only. `null` outside a session run
 *  (idle / subprocess / browser backend) → no-throw no-op. */
let activeSteerForwarder: ((text: string) => void) | null = null;

/** Phase 2 (AC-04 / SCENARIO-008): ellipsize the queued-input preview to ~60
 *  chars so the status pill stays one line even for long user messages. */
function previewInput(text: string, max = 60): string {
	const t = String(text ?? "");
	return t.length > max ? `${t.slice(0, max)}…` : t;
}

/** Factory for the module-scoped ActiveRun (fresh queue per run — no leak).
 *  Phase 2 adds the optional `stream` arg so push() can reach the live-stream's
 *  `userInput` sink; omitting it preserves Phase 1 behavior (queue + no ACK). */
export function createActiveRun(ctx?: ExtensionContext, stream?: LiveStreamHandle, background = false): ActiveRun {
	return {
		queue: [],
		background,
		ctx,
		stream,
		push(text: string): void {
			// SCENARIO-007: never queue empty/whitespace-only input (no spurious
			// guidance entry would be prepended downstream).
			const t = String(text ?? "").trim();
			if (!t) return;
			this.queue.push(t);
			// Bound the queue: drop the oldest entry when over capacity so a single
			// specialist spawn can't be token-bombed (most-recent guidance wins).
			if (this.queue.length > MAX_QUEUED_INPUTS) this.queue.shift();
			// Phase 2 (AC-04 / AC-07): ACK surfaces — TUI-only AND stream-attached,
			// each wrapped best-effort try/catch so a failing surface never aborts
			// capture (SCENARIO-006 / SCENARIO-023). No stream ⇒ no ACK at all
			// (keeps the Phase 1 idle shape byte-identical).
			if (this.ctx?.mode === "tui" && this.stream) {
				// (a) status pill — "📥 queued: <preview ~60ch>" (SCENARIO-008).
				try { this.ctx?.ui?.setStatus?.("super-dev-input", `📥 queued: ${previewInput(t)}`); } catch { /* best-effort */ }
				// (c) transcript line — flows through transcriptTail → renderResult
				// unchanged (SCENARIO-009). (b) dashboard count is derived from
				// queue.length by execute()'s renderDashboard() closure below.
				try { this.stream.sink.userInput(t); } catch { /* best-effort */ }
			}
		},
		drain(): string[] {
			// SCENARIO-013: atomic return-and-clear. A second drain returns [] until
			// new input arrives, so each captured input is injected exactly once.
			const out = this.queue;
			this.queue = [];
			return out;
		},
	};
}

/** Set/clear the module singleton. Called on execute() entry (store ctx) and
 * in the execute() finally (discard — unifies run + widget teardown). */
export function setActiveRun(run: ActiveRun | null): void {
	activeRun = run;
}

/** Phase 4 (AC-08 / SCENARIO-017..018): the bridge the session backend's
 *  `onSteer` seam populates. `runAgentViaSession` calls this with a no-throw
 *  forwarder bound to the live AgentSession on creation, and `null` on dispose
 *  — so each captured input nudges the currently-running session specialist
 *  with the MOST-RECENT input only (bounds context growth). Idle / subprocess /
 *  browser backends never call it, so live steer is a documented no-throw
 *  no-op and the Phase-3 queue path is the sole, identical delivery guarantee.
 *  execute()'s finally clears it alongside activeRun (no stale leak). */
export function setActiveSteerForwarder(fn: ((text: string) => void) | null): void {
	activeSteerForwarder = fn;
}

/**
 * Background-run abort controller singleton.
 *
 * A background super_dev run is detached from the tool call (the tool returns
 * "started" immediately), so it CANNOT use the turn's `signal` — that aborts the
 * instant the turn ends. Instead the detached pipeline is driven by its own
 * AbortController stored here, letting `/super-dev-stop` (command + shortcut)
 * cancel an in-flight background run. Cleared in the detached task's `finally`.
 */
let activeBgController: AbortController | null = null;
export function setActiveBgController(c: AbortController | null): void {
	activeBgController = c;
}
export function getActiveBgController(): AbortController | null {
	return activeBgController;
}

/** Tool-result shape shared by foreground return + background delivery. */
interface ToolRunResult {
	content: Array<{ type: "text"; text: string }>;
	isError: boolean;
	details: Record<string, unknown>;
}

/**
 * Deliver the outcome of a DETACHED background run. The tool already returned
 * "started" to the LLM, so the real summary is surfaced three pi-native ways,
 * each best-effort so one failing surface never masks the others:
 *   1. a toast via `ctx.ui.notify` (immediate, ephemeral);
 *   2. a durable transcript card via `pi.appendEntry("super-dev-summary")` —
 *      TUI-only, survives `/reload`, never sent to the LLM;
 *   3. a `deliverAs: "nextTurn"` custom message so the AGENT learns the result
 *      on the user's next prompt WITHOUT auto-triggering a turn.
 */
function deliverBackgroundResult(pi: ExtensionAPI, ctx: ExtensionContext | undefined, res: ToolRunResult): void {
	const text = res?.content?.[0]?.text ?? "super-dev background run finished.";
	const level: "info" | "warning" | "error" = res?.isError ? "error" : (text.startsWith("⚠️") ? "warning" : "info");
	try { ctx?.ui?.notify?.(res?.isError ? "super-dev finished with errors" : "super-dev finished", level); } catch { /* best-effort */ }
	try { pi.appendEntry?.("super-dev-summary", { text, isError: !!res?.isError, at: Date.now() }); } catch { /* best-effort */ }
	// Custom message with deliverAs:"nextTurn" — the AGENT learns the outcome on
	// the user's next prompt WITHOUT auto-triggering a turn (never sent mid-turn).
	try {
		pi.sendMessage?.(
			{ customType: "super-dev-summary", content: `super-dev background run finished:\n${text}`, display: false },
			{ deliverAs: "nextTurn" },
		);
	} catch { /* best-effort */ }
}

/** Read the module singleton. Null when idle (no run in progress). */
export function getActiveRun(): ActiveRun | null {
	return activeRun;
}

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

// Re-export the extracted dashboard presentation helpers so existing
// importers (tests, downstream consumers) keep resolving unchanged (AC-08).
// The upgraded, theme-aware implementations live in src/render/dashboard.ts;
// `buildDashboardWidget` / `createDashboardWidgetFactory` expose the Phase 2
// Component-factory builders consumed by renderDashboard()'s setWidget call.
export {
	packDashboardLines,
	padTruncate,
	truncateActivity,
	buildDashboardWidget,
	createDashboardWidgetFactory,
};

export default function activate(pi: ExtensionAPI): void {
	// Phase 1 (AC-01 / SCENARIO-001): register the mid-run input listener EXACTLY
	// ONCE at module lifetime (inside activate, never per execute() call). The
	// handler implements the {active-run + interactive}→handled / {else}→continue
	// invariant (AC-03); returning {action:"handled"} for captured input tells pi
	// NOT to re-queue it as a parent steer (SCENARIO-004). The whole body is
	// try/catch-wrapped so any capture failure degrades to a safe no-op and the
	// run always completes normally (SCENARIO-006 / SCENARIO-023).
	// NOTE: `EventBus.on(channel, handler)` types the data payload as `unknown`
	// (generic pub/sub). We contextually accept `unknown` and narrow to the
	// `InputEvent` shape here — the "input" channel only ever carries an
	// InputEvent. Any malformed payload falls through to the catch → {continue}.
	pi.events.on("input", (data) => {
		try {
			// SCENARIO-002 / SCENARIO-003 / SCENARIO-019: idle (no run in progress)
			// → pi owns the input entirely; nothing is captured.
			if (activeRun == null) return { action: "continue" };
			// Background runs free the session ENTIRELY: never swallow keystrokes as
			// steering. Returning {continue} lets slash-commands and new prompts flow
			// through pi's normal pipeline and run DURING the detached pipeline
			// (mid-run steering is a foreground-only feature). This is the core of
			// "accept new commands while super-dev is executing."
			if (activeRun.background) return { action: "continue" };
			const event = data as InputEvent;
			// SCENARIO-005 / SCENARIO-020: non-interactive sources (rpc/extension) are
			// never captured — print/json/headless/RPC input flows through pi
			// byte-identical to today.
			if (event?.source !== "interactive") return { action: "continue" };
			activeRun.push(event.text);
			// Phase 4 (AC-08 / SCENARIO-017): best-effort live steer — nudge the
			// currently-running session specialist with the MOST-RECENT input only
			// (one forward per capture, bounds context growth). No-throw no-op when
			// no session handle is reachable (idle / subprocess / browser backend);
			// the Phase-3 queue path still guarantees delivery.
			try { activeSteerForwarder?.(event.text); } catch { /* best-effort */ }
			return { action: "handled" };
		} catch {
			return { action: "continue" };
		}
	});

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
			resume: Type.Optional(Type.Boolean({ description: "Resume the most-recent interrupted run from where it left off (memoized replay). Default: false." })),
			resumeSpecId: Type.Optional(Type.String({ description: "Resume a specific run by spec identifier (e.g. '07-foo-bar'). Overrides auto-pick." })),
			background: Type.Optional(Type.Boolean({ description: "Run the pipeline DETACHED in the background so the session stays interactive (you can keep chatting and running commands during the run). Defaults to true in interactive TUI mode; set false to block until the pipeline finishes. Ignored (always blocking) in print/json/rpc modes." })),
		}),
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const task = String(params.task ?? "").trim();
			if (!task) {
				return { content: [{ type: "text", text: "super_dev requires a non-empty `task`." }], isError: true, details: {} };
			}
			let lastFlush = 0;
			const FLUSH_MS = 80;
			// Phase 2 (AC-04 / AC-05 / AC-06): the live transcript + mode-aware
			// per-kind theming + rolling tail + raw disk log are owned by the pure
			// `createLiveStream` factory. It classifies every line AT THE SINK
			// (single authority) and renders the live body themed per-kind ONLY in
			// TUI mode; print/json/headless/RPC emit raw `line.text` (byte-clean,
			// zero ANSI — AC-08 no-leak contract). `transcriptTail` carries
			// `{kind,text}` end-to-end (AC-06).
			const stream = createLiveStream({
				onUpdate: (body) => onUpdate?.({ content: [{ type: "text", text: body }], details: {} }),
				mode: ctx?.mode,
				theme: ctx?.ui?.theme as DashboardTheme | undefined,
			});
			const finalizeLive = stream.finalizeLive;
			const flush = stream.flush;
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
				if (ctx?.mode !== "tui") return; // TUI-only widget (AC-09 no-regression guard)
				const entries = dashboardOrder.map((id) => { const s = dashboardStages.get(id); return s ? { id, ...s } : null; }).filter(Boolean) as Array<{ id: string; label: string; status: string }>;
			// Phase 4 (AC-07): footer status pill — done/total stages. TUI-only
			// (guard above already ensured ctx.mode === "tui").
			const TERMINAL = new Set(["ok", "failed", "skipped"]);
			const doneCount = entries.filter((e) => TERMINAL.has(e.status)).length;
			try { ctx?.ui?.setStatus?.("super-dev", `${doneCount}/${entries.length} stages`); } catch { /* best-effort */ }
				// SCENARIO-001 / SCENARIO-002 — register the dashboard via pi's native
				// Component-factory overload `setWidget(key, (tui, theme) => Component,
				// opts)`. The previous zero-arg object-returning factory never received
				// `theme`, so the dashboard rendered as uncolored ASCII (AC-01 root
				// cause). The factory now builds a Container of Text children using the
				// theme-aware packDashboardLines (AC-02 theming, AC-03 animated running
				// glyph via a time-derived seed, AC-04 preserved 2-column layout). The
				// string[] setWidget overload is intentionally NOT used (AC-08).
				try {
					// SCENARIO-001 / SCENARIO-002 — register the dashboard via pi's native
					// Component-factory overload `setWidget(key, (tui, theme) => Component,
					// opts)`. The factory is the pure, unit-tested
					// `createDashboardWidgetFactory`, so `theme` threads into a Container of
					// Text children (AC-01 root-cause fix; AC-02 theming; AC-03 animated
					// running glyph via a time-derived seed; AC-04 preserved 2-column
					// layout). The string[] setWidget overload is intentionally NOT used
					// (AC-08); the `ctx.mode === 'tui'` guard above guarantees no call fires
					// in print/json/headless/RPC modes (AC-09 / AC-10).
					ctx?.ui?.setWidget?.(
						DASHBOARD_KEY,
						createDashboardWidgetFactory(entries, dashboardActivity, activeRun?.queue.length ?? 0, activeRun?.background ? "/super-dev-stop" : "esc to abort"),
						{ placement: "aboveEditor" },
					);
				} catch { /* best-effort */ }
			};
			// Stage changes are infrequent → render at once; text/log updates are high-rate → throttle.
			const renderDashboardThrottled = () => { const now = Date.now(); if (now - lastWidget >= WIDGET_MS) { renderDashboard(); lastWidget = now; } };
			const sink: ProgressSink = {
				phase: (label) => { stream.sink.phase(label); dashboardActivity = label; if (ctx?.mode === "tui") { try { ctx?.ui?.setWorkingMessage?.(`super-dev · ${label}`); } catch { /* best-effort */ } } renderDashboard(); flush(); },
				log: (message) => { stream.sink.log(message); dashboardActivity = message; renderDashboardThrottled(); flush(); },
				text: (partial) => {
					stream.sink.text(partial);
					dashboardActivity = partial;
					const now = Date.now();
					if (now - lastFlush >= FLUSH_MS) { flush(); lastFlush = now; renderDashboardThrottled(); }
				},
				stage: (info) => {
					// Workflow dashboard v1 (Gap Dashboard): always-on phase tracker widget.
					if (!dashboardOrder.includes(info.id)) dashboardOrder.push(info.id);
					dashboardStages.set(info.id, { label: info.label, status: info.status });
					// Phase 5 (AC-05 / SCENARIO-019..021): mirror the structured `stage`
					// event into the live-stream sink so its current-stage state (and the
					// RESOLVED-1 phase-line re-tag) stays synchronized with the dashboard
					// tracker. This is the SINGLE wiring point that makes stage tags
					// resolve from the structured `stage.id` (not `▶ Stage N` label
					// parsing) end-to-end — without it the Phase-3 per-stage section stack
					// is unreachable in production and transcriptTail carries no tags.
					stream.sink.stage(info);
					renderDashboard(); // widget update
				},
			};
			const doRun = async (runSignal: AbortSignal | undefined, background: boolean): Promise<ToolRunResult> => {
			try {
				// Set the run-state singleton on execute() entry via the exported setter
				// (single write path). Guard overlapping runs: a non-null singleton here
				// means a prior run never cleared its finally (reentrancy) — discard it.
				if (activeRun != null) setActiveRun(null);
				setActiveRun(createActiveRun(ctx, stream, background));
				ensureSuperDevDirs();
				startRun();
				// Name the session after the task (pi-native) so it is identifiable in
				// the session selector / `/tree`. Only set when the session is still
				// unnamed so a user-chosen name is never clobbered; refined to the spec
				// identifier once the run resolves one (below). Best-effort: never let a
				// naming failure abort the run.
				try { if (!pi.getSessionName()) pi.setSessionName(`super-dev: ${task.slice(0, 60)}`); } catch { /* best-effort */ }
				const summary = await runPipelineTask(task, {
					cwd: process.cwd(),
					skipWorktree: params.skipWorktree === true,
					skipStages: params.skipStages as string[] | undefined,
					model: params.model as string | undefined,
					maxAgents: typeof params.maxAgents === "number" ? params.maxAgents : undefined,
					resume: typeof params.resumeSpecId === "string" ? params.resumeSpecId : (params.resume === true ? true : undefined),
				// Wire the mid-run input drain to the activeRun singleton. workflow.ts
				// realAgent drains this ONCE per specialist spawn; empty while idle/after
				// drain so non-TUI/idle runs inject nothing (byte-identical baseline).
				userSteerProvider: () => getActiveRun()?.drain() ?? [],
				// AC-08: wire the session-backend live-steer seam. runAgentViaSession
				// invokes onSteer with a no-throw forwarder bound to the live AgentSession
				// (or null on dispose / when steer() is absent); registering it here is
				// what makes the input handler's live steer actually fire on the session
				// backend. subprocess/browser never set a forwarder → documented no-op.
				onSteer: setActiveSteerForwarder,
				progress: sink,
					signal: runSignal,
				});
				// Refine the session name to the resolved spec identifier (pi-native),
				// which is a stable, human-meaningful slug (e.g. `07-oauth-login`).
				try { if (summary.specIdentifier) pi.setSessionName(`super-dev: ${summary.specIdentifier}`); } catch { /* best-effort */ }
				const summaryLines = formatSummary(summary, process.cwd());
				finalizeLive(); // flush any pending live text into the transcript
				// Preserve the FULL run log to disk (the live display is a rolling tail).
				let logPath = "";
				try {
					logPath = getRunLogPath();
					writeFileSync(logPath, stream.diskLogText() + "\n");
				} catch { /* best-effort; the live tail is the primary surface */ }
				const escalationChoice = await handleStagnation(summary, ctx);
				const isError = summary.status === "failed";
				// Async reflection ("dreaming") — non-blocking, best-effort.
				runReflectionAsync();
				// Stages for the result's stage-progress section, from the live tracker.
				const stages = dashboardOrder.map((id) => ({ id, ...(dashboardStages.get(id) ?? { label: id, status: "·" }) }));
				// `content` is the text fallback (print/json/headless); in TUI, renderResult
				// below builds a themed 3-section view (dimmed logs / normal stages / summary).
				const fallback = [...summaryLines];
				if (logPath) fallback.push(`Full run log: ${logPath}`);
				if (escalationChoice) fallback.push(`  Escalation: user chose "${escalationChoice}".`);
				return {
					content: [{ type: "text", text: fallback.join("\n") }],
					isError,
					details: { summary, summaryLines, transcriptTail: stream.transcriptTail(), stages, logPath },
				};
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return { content: [{ type: "text", text: `❌ super-dev pipeline failed: ${message}` }], isError: true, details: {} };
			} finally {
				// Discard the run-state singleton via the exported setter (single write
				// path), in the SAME cleanup that removes the run's dashboard widget — so
				// run teardown + widget teardown stay unified (no leak across runs).
				setActiveRun(null);
				setActiveSteerForwarder(null);
				// spec-11 AC-05 / SCENARIO-010: clear the per-run ChangeTracker singleton
				// in the SAME finally that nulls activeRun, so no tracker (and its
				// in-memory baselines/end-records) leaks across runs. The setup stage
				// installs it; every run clears it here on success OR failure.
				// Always clear the dashboard widget + footer state when the run ends (success or failure).
				try { ctx?.ui?.setWidget?.(DASHBOARD_KEY, undefined); } catch { /* best-effort */ }
				try { ctx?.ui?.setWorkingMessage?.(); } catch { /* best-effort */ }
				try { ctx?.ui?.setStatus?.("super-dev", undefined); } catch { /* best-effort */ }
				// Phase 2 (AC-04 / SCENARIO-010): clear the mid-run input status pill in
				// the same cleanup that nulls activeRun + the dashboard widget.
				try { ctx?.ui?.setStatus?.("super-dev-input", undefined); } catch { /* best-effort */ }
				setActiveTracker(null);
			}
			};
			// ── foreground vs. background dispatch ───────────────────────────────────
			// In interactive TUI mode, DETACH the pipeline by default so the session
			// stays live (user can chat + run commands DURING the run). The turn's
			// `signal` would abort the instant the tool returns, so the detached run
			// gets its OWN AbortController (stored for /super-dev-stop). print/json/rpc
			// modes and an explicit `background:false` keep the original blocking path
			// — byte-identical for automation / tests.
			const runInBackground = ctx?.mode === "tui" && params.background !== false;
			if (!runInBackground) return await doRun(signal, false);
			if (getActiveRun()?.background) {
				return { content: [{ type: "text", text: "⏳ A super-dev run is already active in the background. Wait for it to finish or stop it with /super-dev-stop." }], isError: true, details: {} };
			}
			const bgController = new AbortController();
			setActiveBgController(bgController);
			void doRun(bgController.signal, true)
				.then((res) => deliverBackgroundResult(pi, ctx, res))
				.catch((err) => { try { ctx?.ui?.notify?.(`super-dev background run crashed: ${err instanceof Error ? err.message : String(err)}`, "error"); } catch { /* best-effort */ } })
				.finally(() => setActiveBgController(null));
			return {
				content: [{ type: "text", text: `🚀 super-dev started in the background for:\n  ${task.slice(0, 100)}\n\nProgress shows in the dashboard above the editor. Keep chatting or running commands — I'll post a summary card here when it finishes. Stop it any time with /super-dev-stop.` }],
				isError: false,
				details: { background: true },
			};
		},
		// Pi-native result rendering: 3 sections. §1 detail logs DIMMED (thought-like,
		// kept — not suppressed); §2 stage progress NORMAL (answer-like); §3 summary.
		renderResult(result, _opts: any, theme: Theme) {
			const d = (result.details ?? {}) as {
				summaryLines?: string[];
				transcriptTail?: TranscriptLine[];
				stages?: Array<{ id?: string; label: string; status: string }>;
				logPath?: string;
			};
			// During streaming (onUpdate), details are empty — fall back to plain content
			// text so the live log shows normally instead of empty sections.
			if (!d.stages?.length) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "", 0, 0);
			}
			// §1 dim detail log + §2 bold stage progress + §3 Markdown summary are
			// composed by the pure, unit-tested builder (single source of truth —
			// mirrors the widget extraction; AC-06 root-cause fix). The streaming
			// fallback above is unchanged so print/json/headless/RPC modes regress.
			return buildResultComponent(d, theme);
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

	// Durable transcript card for a finished BACKGROUND run (pi-native): rendered
	// TUI-only, survives `/reload`, and is NEVER sent to the LLM. Populated by
	// deliverBackgroundResult()'s pi.appendEntry("super-dev-summary", ...).
	// Feature-detected: `registerEntryRenderer` exists in the pi runtime but is
	// absent from the pinned 0.80.3 type surface, so we call it through a narrow
	// capability type and no-op when unavailable (appendEntry still persists).
	const piWithRenderer = pi as unknown as {
		registerEntryRenderer?: (
			customType: string,
			renderer: (entry: { data?: unknown }, opts: unknown, theme: DashboardTheme) => Container,
		) => void;
	};
	try {
		piWithRenderer.registerEntryRenderer?.("super-dev-summary", (entry, _opts, theme) => {
		const d = (entry.data ?? {}) as { text?: string; isError?: boolean };
		const bold = (t: string): string => (theme?.bold ? theme.bold(t) : t);
		const fg = (color: string, t: string): string => (theme ? theme.fg(color, t) : t);
		const container = new Container();
		const header = d.isError ? fg("error", bold("── super-dev (background) ─ finished with errors ──")) : bold("── super-dev (background) ─ finished ──");
		container.addChild(new Text(header, 0, 0));
		for (const line of String(d.text ?? "").split("\n")) container.addChild(new Text(line, 0, 0));
		return container;
		});
	} catch { /* best-effort: entry renderer unavailable on this pi runtime */ }

	// Stop an in-flight background run (pi-native command + shortcut). Aborts the
	// detached run's OWN controller (not the turn signal, which is already gone).
	pi.registerCommand("super-dev-stop", {
		description: "Stop the in-progress background super-dev run.",
		handler: async (_args, ctx) => {
			const c = getActiveBgController();
			if (!c) { ctx.ui.notify("No background super-dev run is active.", "info"); return; }
			try { c.abort(); } catch { /* best-effort */ }
			ctx.ui.notify("Stopping background super-dev run…", "warning");
		},
	});
	try {
		pi.registerShortcut("ctrl+shift+s", {
			description: "Stop background super-dev run",
			handler: async (ctx) => {
				const c = getActiveBgController();
				if (!c) { ctx.ui.notify("No background super-dev run is active.", "info"); return; }
				try { c.abort(); } catch { /* best-effort */ }
				ctx.ui.notify("Stopping background super-dev run…", "warning");
			},
		});
	} catch { /* best-effort: the keybinding may be unavailable / conflicting */ }
}
