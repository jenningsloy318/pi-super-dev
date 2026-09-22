/**
 * Pi extension entry point.
 *
 * Registers:
 *   - `super_dev` tool — the LLM-callable entry that runs the staged
 *     pipeline by spawning `pi` child processes. Fully self-contained: no
 *     dependency on @agwab/pi-workflow or any other workflow engine. The
 *     pipeline is a tree of control-flow nodes (src/nodes.ts) composed in
 *     src/stages/index.ts.
 *   - `/super-dev <task>` command — dispatches the task to the agent, which
 *     invokes the `super_dev` tool.
 */

import type { ExtensionAPI, Theme, EntryRenderer } from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";
import { packDashboardLines, padTruncate, truncateActivity, buildDashboardWidget, createDashboardWidgetFactory, buildResultComponent } from "./render/dashboard.ts";
import type { DashboardTheme } from "./render/dashboard.ts";
import { createLiveStream } from "./render/live-stream.js";
import type { TranscriptLine, StageStamp } from "./render/live-stream.js";
import { stepOccurrenceStamp } from "./render/stage-occurrence.ts";
import {type StepScopeInfo } from "./step-scope.ts";
import { Type } from "typebox";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensureSuperDevDirs, startRun, runLogPathFor, getConfig, auditAppend } from "./render/super-dev-dir.ts";
import { shouldAutoPostMortem, runPostMortem } from "./evolution/post-mortem.ts";
import { readLastMetricsRow } from "./evolution/sigma-bands.ts";
import { runReflectionAsync } from "./render/reflection.ts";
import { updateStats, cleanupOldRuns } from "./render/cleanup.ts";
import { localTimestamp } from "./render/time.ts";
import { runPipelineTask } from "./pipeline.ts";
import { maxReplanRounds, pendingHumanReplanRequests } from "./replan/replan.ts";
import { releaseHeldRunLock } from "./setup.ts";
import { appendRunEvent } from "./runlog.ts";
import { type ThinkingLevel } from "./agents/agent-runtime/index.ts";
import { setActiveTracker } from "./tracking.ts";
import { registerSuperDevAgentsDeferred } from "./agents/register-agents.ts";
import { resolvePiSessionIdentity } from "./agents/fleet-visibility.ts";
import { superDevRunMetadataLine } from "./version.ts";
import type { ProgressSink, RuntimeInstruction } from "./types.ts";
import { setHostContext, abortAllActiveAgents } from "./agents/pi-agent-core-backend.ts";

/** 069: the structural slice of the host's ModelRegistry that our adapter
 * consumes (069 R1-Q1: streamSimple carries auth.json credentials). */
interface HostModelRegistry {
	find(provider: string, modelId: string): unknown;
	streamSimple(...args: unknown[]): unknown;
	refresh(): Promise<void>;
}

export { runPipelineTask } from "./pipeline.ts";
export { SUPER_DEV_WORKFLOW } from "./stages/index.ts";
export * as nodes from "./nodes.ts";
export { runWorkflow } from "./workflow.ts";
import { handleStagnation, makeEscalate } from "./extension/escalation.ts";
import { autoResumeEnabled, formatSummary, formatDuration, launchMetadataLines } from "./extension/run-presentation.ts";
import { createActiveRun, setRunGuard, releaseRunGuard, noteInFlightReflection, getRunGuard, runGuardRefusal, pendingBackgroundWork, clearPendingBackgroundWork, type ActiveRun } from "./extension/run-state.ts";
import { SUPER_DEV_TOOL, SUPER_DEV_COMMAND, SUPER_DEV_PANEL_SHORTCUT, buildSuperDevToolInstruction, hasRemovedBackgroundFlag, canonTruncate, parseSuperDevCommandArgs } from "./extension/tool-args.ts";
import { adjudicateInputEvent, instructionForEntry, reportSessionShutdown } from "./extension/event-handlers.ts";
// Public seam (canon + command lanes import from extension.ts): re-exported.
export { parseSuperDevCommandArgs, canonTruncate, CANON_MAX_CONTENT_BYTES, CANON_MAX_CONTENT_LINES } from "./extension/tool-args.ts";
// Public seam (the input-handler + run-guard test lanes import these from extension.ts): re-exported.
export { createActiveRun, runGuardRefusal, setRunGuard, releaseRunGuard, noteInFlightReflection, type ActiveRun, type ActiveRunGuard } from "./extension/run-state.ts";
// Public seam (tests + the escalation lanes import these from extension.ts): re-exported.
export { handleStagnation, escalateOptionsFor, mapEscalateChoice, makeEscalate } from "./extension/escalation.ts";
export { SUPER_DEV_VERSION_METADATA, SUPER_DEV_EXTENSION_VERSION, SUPER_DEV_VERSION_POLICY, superDevVersionLabel } from "./version.ts";
import { checkServingFreshness, SERVING_EXTENSION_DIR, servingVersionLine } from "./serving-freshness.ts";
import { eventsPath } from "./runlog.ts";

let activeRun: ActiveRun | null = null;

/** AC-29 (SCENARIO-059): exactly one super_dev run may be in flight at a time.
 *  Set at doRun() entry, cleared in its finally. A second execute() while a
 *  run is active is REFUSED — the active singleton and the module-global run
 *  dir are never clobbered by a concurrent invocation. */
let inFlight = false;



/** Set/clear the module singleton. Called on execute() entry (store ctx) and
 * in the execute() finally (discard — unifies run + widget teardown). */
export function setActiveRun(run: ActiveRun | null): void {
	activeRun = run;
}

/** v0.3.60 R3: single write path for the in-flight serialization guard (doRun
 *  entry sets true, its finally sets false; tests drive the same seam). */
export function setInFlight(value: boolean): void {
	inFlight = value;
}


/** Tool-result shape returned by the foreground tool call. */
interface ToolRunResult {
	content: Array<{ type: "text"; text: string }>;
	isError: boolean;
	details: Record<string, unknown>;
}

/** Read the module singleton. Null when idle (no run in progress). */
export function getActiveRun(): ActiveRun | null {
	return activeRun;
}

// Re-export the extracted dashboard presentation helpers so existing
// importers (tests, downstream consumers) keep resolving unchanged (AC-08).
// The upgraded, theme-aware implementations live in src/render/dashboard.ts.
// The live foreground widget is no longer registered, but these builders remain
// exported for compatibility with tests/downstream consumers and final results.
export {
	packDashboardLines,
	padTruncate,
	truncateActivity,
	buildDashboardWidget,
	createDashboardWidgetFactory,
};

export default async function activate(pi: ExtensionAPI): Promise<void> {
	// v0.3.25 L3: register super-dev's specialists as first-class pi-subagents
	// agents (sd-* names) through the runtime-agent event contract. Best-effort
	// by contract: a missing pi-subagents install, a rejected registration, or a
	// throwing bus is logged (or silently skipped) — activation never fails. The
	// dispose is retained for a future deactivate hook; pi extensions live for
	// the process lifetime, so registrations ride along.
	let superDevAgentsDispose: (() => void) | undefined;
	try {
		// 069 wave 2: wire the host context for the pi-agent-core backend.
		// The ExtensionAPI exposes modelRegistry (host's ModelRuntime facade
		// with auth.json credentials) — this is what the adapter's streamFn
		// binds to. Tool factories come from the SDK re-exports.
		try {
			// 069: the host pi's ExtensionAPI includes modelRegistry (verified on
			// the installed 0.87.0 types.d.ts:222) but our devDep's re-export
			// chain may not carry it — use a structural extension.
			const hostPi = pi as ExtensionAPI & { modelRegistry: HostModelRegistry };
			if (hostPi.modelRegistry) {
				// Dynamic import of the SDK tool factories (the extension loader
				// resolves @earendil-works/* to the host's copies)
				const sdkModule = await import("@earendil-works/pi-coding-agent");
				const sdk = {
					createReadTool: sdkModule.createReadTool as (...args: unknown[]) => unknown,
					createBashTool: sdkModule.createBashTool as (...args: unknown[]) => unknown,
					createGrepTool: sdkModule.createGrepTool as (...args: unknown[]) => unknown,
					createFindTool: sdkModule.createFindTool as (...args: unknown[]) => unknown,
					createLsTool: sdkModule.createLsTool as (...args: unknown[]) => unknown,
					createEditTool: sdkModule.createEditTool as (...args: unknown[]) => unknown,
					createWriteTool: sdkModule.createWriteTool as (...args: unknown[]) => unknown,
				};
				setHostContext({
					modelRegistry: hostPi.modelRegistry as HostModelRegistry,
					createReadTool: sdk.createReadTool as never,
					createBashTool: sdk.createBashTool as never,
					createGrepTool: sdk.createGrepTool as never,
					createFindTool: sdk.createFindTool as never,
					createLsTool: sdk.createLsTool as never,
					createEditTool: sdk.createEditTool as never,
					createWriteTool: sdk.createWriteTool as never,
				});
				try { pi.appendEntry?.("super-dev-pi-agent-core", { line: "host context wired (modelRegistry + SDK tool factories)" }); } catch { /* best-effort */ }
			}
		} catch (error) {
			try { pi.appendEntry?.("super-dev-pi-agent-core", { line: `host context wiring failed: ${error instanceof Error ? error.message : String(error)} — SUPER_DEV_BACKEND=pi-agent-core will not work; delegation backend remains` }); } catch { /* best-effort */ }
		}
		const delegationBus = (pi as { events?: unknown }).events as import("./agents/delegation-backend.ts").DelegationEventBus | undefined;
		if (delegationBus) {
			// v0.3.82 dual review BLOCKER fix: registration is DEFERRED to the
			// first session_start — pi.getAllTools() THROWS during activation
			// (notInitialized stub until _bindExtensionCore, which runs after
			// every extension factory), and package load order follows the
			// settings.json packages array (pi-blackhole/nowledge load AFTER
			// super-dev on this machine), so an activation-time snapshot was both
			// uncallable and incomplete. registerSuperDevAgentsDeferred builds the
			// package-attributed tool index post-bind (every settings package
			// activated, real npm:<pkg> sourceInfo applied) and registers once.
			superDevAgentsDispose = registerSuperDevAgentsDeferred(pi, delegationBus, (line: string) => { try { pi.appendEntry?.("super-dev-agent-registration", { line }); } catch { /* best-effort */ } });
		}
	} catch { /* best-effort */ }
	// v0.3.81 C1: serving-copy freshness — stamp the version once at activation
	// and warn (best-effort, fire-and-forget, never blocks activation) when the
	// installed copy is behind its origin (incident class 2026-09-04T14-10: a
	// fixed bug kept running live because the serving copy lagged repo main).
	try {
		console.error(`[super-dev] ${servingVersionLine()}`);
		void checkServingFreshness(SERVING_EXTENSION_DIR, (line) => {
			try { console.error(line); } catch { /* best-effort */ }
			try { pi.appendEntry?.("super-dev-freshness", { line }); } catch { /* best-effort */ }
		});
	} catch { /* best-effort */ }
	// Phase 1 (AC-01 / SCENARIO-001): register the mid-run input listener EXACTLY
	// ONCE at module lifetime (inside activate, never per execute() call). The
	// adjudication invariant lives in extension/event-handlers.ts (increment 5);
	// this wiring keeps only the appendEntry telemetry + the catch degradation.
	pi.on("input", (event) => {
		try {
			const result = adjudicateInputEvent(activeRun, event);
			if (result.action === "handled" && result.instruction) {
				try { pi.appendEntry?.("super-dev-instruction", { instruction: instructionForEntry(result.instruction), queued: result.queued }); } catch { /* best-effort */ }
			}
			return result.action === "handled" ? { action: "handled" as const } : result.action === "transform" ? { action: "transform" as const, text: result.text } : { action: "continue" as const };
		} catch {
			return { action: "continue" };
		}
	});

	// v0.3.60 R3: idempotent session_shutdown handler (canon: extensions.md
	// Lifecycle — /new, /resume, /fork, /reload and quit tear the extension
	// instance down and rebind it). The idempotency flag is INSTANCE-local; the
	// state it reads is module/global scope by design so it observes the OLD run.
	let shutdownHandled = false;
	pi.on("session_shutdown", (event) => {
		abortAllActiveAgents(); // 069: invariant #2 — deactivate aborts all active Agents

		if (shutdownHandled) return;
		shutdownHandled = true;
		reportSessionShutdown(pi, event, {
			inFlight, activeRun, getRunGuard, pendingBackgroundWork, clearPendingBackgroundWork, disposeAgents: superDevAgentsDispose,
		});
	});

	pi.registerTool({
		name: SUPER_DEV_TOOL,
		label: "Super Dev",
		description:
			"Run the self-contained staged super-dev pipeline (requirements → research → design → spec → TDD implementation → verification convergence → docs → merge). Spawns specialist `pi` subagents directly — no external workflow engine required.",
		promptSnippet: "Run the full staged super-dev development pipeline for a feature/bug/refactor task",
		promptGuidelines: [
			"Use super_dev when the user asks to implement a feature, fix a bug, or refactor code as a structured multi-stage workflow.",
			"Pass the user's full task verbatim to super_dev; do not paraphrase constraints, file references, or acceptance criteria.",
		],
		parameters: Type.Object({
			task: Type.String({ description: "The full development task, e.g. 'implement OAuth2 login' or 'fix the crash on large file upload'." }),
			skipWorktree: Type.Optional(Type.Boolean({ description: "Skip git worktree creation and operate in the current directory. Default: false." })),
			skipStages: Type.Optional(Type.Array(Type.String(), { description: "Stage output keys to skip (advanced). Default: none." })),
			// v0.3.60 R2 (canon): StringEnum over Type.Union(Type.Literal) — Google
			// models fail schema validation on union-of-literals.
			backend: Type.Optional(Type.String({ description: "DEPRECATED (v0.3.64, ignored): specialists always run through pi-subagents delegation. Kept so legacy callers passing a backend value are not rejected." })),
			model: Type.Optional(Type.String({ description: "Model override for spawned specialist agents in provider/id form." })),
			maxAgents: Type.Optional(Type.Number({ description: "Maximum specialist agent spawns. Default: 200." })),
			resume: Type.Optional(Type.Boolean({ description: "Resume the most-recent interrupted run from where it left off (memoized replay). Default: false." })),
			resumeSpecId: Type.Optional(Type.String({ description: "Resume a specific run by spec identifier (e.g. '07-foo-bar'). Overrides auto-pick." })),
		}),
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const task = String(params.task ?? "").trim();
			if (!task) {
				throw new Error("super_dev requires a non-empty `task`.");
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
				showTimestamps: true,
			});
			const finalizeLive = stream.finalizeLive;
			const flush = stream.flush;
			const flushLive = () => flush();
			type StageViewState = {
				label: string;
				status: string;
				kind?: "stage" | "phase" | "step";
				parentId?: string;
				startedAt?: string;
				endedAt?: string;
				durationMs?: number;
				startedMs?: number;
			};
			const dashboardStages = new Map<string, StageViewState>();
			const dashboardOrder: string[] = [];
			const stageOccurrenceCounts = new Map<string, number>();
			const activeStageOccurrences = new Map<string, string>();
			const stageDisplayLabel = (label: string, occurrence: number): string =>
				occurrence > 1 ? `${label} (attempt ${occurrence})` : label;
			// v0.3.58 pipelining attribution: resolve a step-scoped emission to its
			// own dashboard section — only while that step's occurrence row is
			// actively running; otherwise undefined ⇒ cursor stamping (unchanged
			// serial-stage behavior, and correct ownership for post-step join lines).
			const stepStamp = (step: StepScopeInfo | undefined): StageStamp | undefined => {
				if (!step) return undefined;
				const activeId = activeStageOccurrences.get(step.stageId);
				return stepOccurrenceStamp(step, activeId, activeId ? dashboardStages.get(activeId)?.status : undefined);
			};
			const resolveStageOccurrence = (id: string, status: string): { displayId: string; occurrence: number } => {
				const activeId = activeStageOccurrences.get(id);
				const active = activeId ? dashboardStages.get(activeId) : undefined;
				if (status === "running") {
					if (!activeId || (active && active.status !== "running")) {
						const nextOccurrence = (stageOccurrenceCounts.get(id) ?? 0) + 1;
						stageOccurrenceCounts.set(id, nextOccurrence);
						const displayId = nextOccurrence === 1 ? id : `${id}#${nextOccurrence}`;
						activeStageOccurrences.set(id, displayId);
						return { displayId, occurrence: nextOccurrence };
					}
					return { displayId: activeId, occurrence: stageOccurrenceCounts.get(id) ?? 1 };
				}
				if (activeId) return { displayId: activeId, occurrence: stageOccurrenceCounts.get(id) ?? 1 };
				const nextOccurrence = stageOccurrenceCounts.get(id) ?? 1;
				stageOccurrenceCounts.set(id, nextOccurrence);
				const displayId = nextOccurrence === 1 ? id : `${id}#${nextOccurrence}`;
				activeStageOccurrences.set(id, displayId);
				return { displayId, occurrence: nextOccurrence };
			};
			let liveRunLogPath = "";
			// Sweep-3 G10: THIS run's audit path, captured at start (finally-scope safe).
			let liveAuditPath = "";
			let lastDiskLog = 0;
			const DISK_LOG_MS = 1000;
			const persistLiveLog = (force = false) => {
				if (!liveRunLogPath) return;
				const now = Date.now();
				if (!force && now - lastDiskLog < DISK_LOG_MS) return;
				lastDiskLog = now;
				try { writeFileSync(liveRunLogPath, stream.diskLogText() + "\n"); } catch { /* best-effort */ }
			};
			const logStageTiming = (message: string) => {
				stream.sink.log(message);
				persistLiveLog(true);
				flushLive();
			};
			const sink: ProgressSink = {
				phase: (label, step) => { stream.sink.phase(label, stepStamp(step)); persistLiveLog(); if (ctx?.mode === "tui") { try { ctx?.ui?.setWorkingMessage?.(`super-dev · ${label}`); } catch { /* best-effort */ } } flushLive(); },
				log: (message, step) => { stream.sink.log(message, stepStamp(step)); persistLiveLog(); flushLive(); },
				text: (partial, step) => {
					stream.sink.text(partial, stepStamp(step));
					const now = Date.now();
					if (now - lastFlush >= FLUSH_MS) { persistLiveLog(); flushLive(); lastFlush = now; }
				},
				stage: (info) => {
					const { displayId, occurrence } = resolveStageOccurrence(info.id, info.status);
					const displayInfo = { ...info, id: displayId, label: stageDisplayLabel(info.label, occurrence) };
					if (!dashboardOrder.includes(displayId)) dashboardOrder.push(displayId);
					const previous = dashboardStages.get(displayId);
					const nowMs = Date.now();
					const nowIso = localTimestamp(new Date(nowMs));
					const next: StageViewState = {
						...(previous ?? {}),
						label: displayInfo.label,
						status: displayInfo.status,
						kind: displayInfo.kind,
						parentId: displayInfo.parentId,
					};
					if (displayInfo.status === "running" && previous?.startedAt === undefined) {
						next.startedAt = nowIso;
						next.startedMs = nowMs;
					} else if (displayInfo.status !== "running") {
						next.endedAt = nowIso;
						const startedMs = previous?.startedMs ?? nowMs;
						next.durationMs = nowMs - startedMs;
					}
					dashboardStages.set(displayId, next);
					stream.sink.stage(displayInfo);
					const lifecycleNoun = displayInfo.kind === "phase" ? "Phase" : "Stage";
					if (displayInfo.status === "running" && previous?.startedAt === undefined) {
						logStageTiming(`${lifecycleNoun} start: ${displayInfo.label} at ${nowIso}`);
					} else if (displayInfo.status !== "running") {
						const error = displayInfo.error ? ` error=${displayInfo.error}` : "";
						logStageTiming(`${lifecycleNoun} end: ${displayInfo.label} status=${displayInfo.status} at ${nowIso} duration=${formatDuration(next.durationMs ?? 0)}${error}`);
					}
				},
			};
			const doRun = async (runSignal: AbortSignal | undefined): Promise<ToolRunResult> => {
				// v0.3.61: token identifying THIS run's guard ownership — declared before
				// the try so the finally below can always see it.
				const guardToken = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
				// AC-29 (SCENARIO-059): serialize runs — a second execute() while a run
				// is in flight is refused OUTRIGHT (before the try, so the finally below
				// never runs for a refused call and cannot null the ACTIVE run's
				// singleton / run dir); it must never interleave a second pipeline.
				if (inFlight) {
					return { content: [{ type: "text", text: "a super-dev run is already active — wait for it to finish (or abort it) before starting another" }], isError: true, details: {} };
				}
				// v0.3.60 R3: cross-instance guard — a /reload rebind resets module
				// state while the old pipeline still runs; the globalThis guard plus
				// this honest refusal (SUPER_DEV_ALLOW_OVERLAP=1 escape) keeps runs
				// from interleaving. See runGuardRefusal().
				const overlapRefusal = runGuardRefusal();
				if (overlapRefusal) {
					return { content: [{ type: "text", text: overlapRefusal }], isError: true, details: {} };
				}
			try {
				inFlight = true;
				// Set the run-state singleton on execute() entry via the exported setter
				// (single write path). The inFlight guard above makes a stale singleton
				// unreachable — runs never overlap, so the old reentrancy discard is gone.
				setActiveRun(createActiveRun(ctx, stream));
				ensureSuperDevDirs();
				// AC-29: the run dir is captured ONCE — every later write (live log,
				// reflection, audit) resolves from THIS dir even if a later run starts
				// while this run's async work is still in flight.
				const runDir = startRun();
				setRunGuard({ startedAt: localTimestamp(), runDir, token: guardToken });
				liveRunLogPath = runLogPathFor(runDir);
				// Sweep-3 G10: pin THIS run's audit path at capture time.
				liveAuditPath = join(runDir, "audit.jsonl");
				stream.sink.log(superDevRunMetadataLine());
				for (const line of launchMetadataLines(task, process.cwd(), liveRunLogPath)) stream.sink.log(line);
				persistLiveLog(true);
				flushLive();
				// Name the session after the task (pi-native) so it is identifiable in
				// the session selector / `/tree`. Only set when the session is still
				// unnamed so a user-chosen name is never clobbered; refined to the spec
				// identifier once the run resolves one (below). Best-effort: never let a
				// naming failure abort the run.
				try { if (!pi.getSessionName()) pi.setSessionName(`super-dev: ${task.slice(0, 60)}`); } catch { /* best-effort */ }
				// Capture the live main session's FULL model object (ctx.model) + thinking
				// level BEFORE runPipelineTask, then thread them as ADDITIVE DEFAULTS so
				// every spawned specialist inherits the parent's EXACT model (same
				// provider/headers/baseUrl) when no explicit param/env override is supplied
				// (SCENARIO-001). The FULL object — not ctx.model.id — is captured: a bare
				// id drops the provider, and re-resolving it ambiguously matched a different
				// provider's same-named model (the opencode mis-resolution bug).
				// try/catch + a ctx guard — an older/non-TUI ctx exposes neither and
				// degrades byte-identically to today (SCENARIO-002).
				let inheritedModelObject: import("./agents/agent-runtime/index.ts").SessionModelOption | undefined;
				let inheritedThinking: ThinkingLevel | undefined;
				try {
					if (ctx?.model?.id && ctx.model.provider) inheritedModelObject = ctx.model;
					inheritedThinking = ctx?.thinkingLevel;
				} catch {
					inheritedModelObject = undefined;
					inheritedThinking = undefined;
				}
				const runOnce = (resumeSpecId: string | true | undefined) => runPipelineTask(task, {
					cwd: process.cwd(),
					skipWorktree: params.skipWorktree === true,
					skipStages: params.skipStages as string[] | undefined,
					model: params.model as string | undefined,
					inheritedModelObject,
					inheritedThinking,
					maxAgents: typeof params.maxAgents === "number" ? params.maxAgents : undefined,
					resume: resumeSpecId,
				// Wire the mid-run input drain to the activeRun singleton. workflow.ts
				// realAgent drains this ONCE per specialist spawn; empty while idle/after
				// drain so non-TUI/idle runs inject nothing (byte-identical baseline).
					// v0.3.25: thread pi's in-process event bus + session id into the run so
					// the pi-subagents delegation backend (the ONLY backend since v0.3.64)
					// and FleetView external-run visibility can operate in extension mode.
					// Both degrade to inert in standalone CLI mode.
					// v0.3.64: the backend selector (tool param / config agentBackend /
					// SUPER_DEV_BACKEND env) is GONE — params.backend is accepted but
					// ignored (deprecated), and a legacy agentBackend config key is a
					// harmless leftover (README: Requirements).
					events: (pi as { events?: unknown }).events as import("./agents/delegation-backend.ts").DelegationEventBus | undefined,
					sessionId: (() => {
						try {
							// v0.3.27: pi-subagents' Fleet filters external runs by the session
							// FILE path (resolveCurrentSessionId = getSessionFile() ??
							// getSessionId()). Passing the bare uuid made our records invisible
							// (E7 in-process probe, run 2026-08-28T16-09-12 diagnosis).
							const sm = (ctx as { sessionManager?: { getSessionId?: () => string; getSessionFile?: () => string | null } } | undefined)?.sessionManager;
							return resolvePiSessionIdentity(sm);
						} catch { return undefined; }
					})(),
					userSteerProvider: () => getActiveRun()?.drainInstructions() ?? [],
				// Phase 2 (spec-18 / AC-01): thread the inline escalate callback so the
				// Phase 3 firing points can pause-ask-continue via ctx.ui. Additive —
				// an undefined decision stays byte-identical to today (no firing point
				// invokes it yet). Built beside userSteerProvider (same options seam).
					escalate: makeEscalate(ctx),
					progress: sink,
					signal: runSignal,
				});

				let summary = await runOnce(typeof params.resumeSpecId === "string" ? params.resumeSpecId : (params.resume === true ? true : undefined));
				// R3 auto-resume (dsh-09 v3, OQ6 default ON): a replan boundary ends the
				// run deliberately; re-invoke on the SAME spec (the resume path — the cache
				// was already invalidated for the revised suffix by the trigger). The R5
				// budget self-limits at the trigger site; this loop cap is the
				// belt-and-braces bound. SUPER_DEV_REPLAN_MANUAL=1 keeps single runs.
				let replanRestarts = 0;
				while (summary.status === "replan" && autoResumeEnabled() && replanRestarts < maxReplanRounds() && !runSignal?.aborted) {
					replanRestarts++;
					const marker = (summary.state as Record<string, unknown>).__replan as { rounds?: number; owners?: string[]; newRequests?: number } | undefined;
					try { stream.sink.log(`🔁 REPLAN restart ${replanRestarts}/${maxReplanRounds()} — ${marker?.owners?.join(", ") ?? "?"} revises; resuming spec ${summary.specIdentifier}`); } catch { /* best-effort */ }
				// AC-20 (SCENARIO-044): the human-owned deferred rows ride along —
				// surface them on resume so the user sees what awaits their decision.
				try {
					const humanPending = pendingHumanReplanRequests(summary.specDirectory);
					if (humanPending.length > 0) stream.sink.log(`⏸ ${humanPending.length} deferred finding(s) awaiting human decision: ${humanPending.map((r) => r.title).join("; ")}`);
				} catch { /* best-effort */ }
					try { const resumedRunId = ((summary.state as Record<string, unknown>).__runId as string | undefined) ?? summary.specIdentifier; appendRunEvent(summary.specDirectory, { runId: resumedRunId, type: "replan.resumed", data: { runId: resumedRunId, requests: marker?.newRequests ?? 0 } }); } catch { /* best-effort */ }
					summary = await runOnce(summary.specIdentifier);
				}
				// Refine the session name to the resolved spec identifier (pi-native),
				// which is a stable, human-meaningful slug (e.g. `07-oauth-login`).
				try { if (summary.specIdentifier) pi.setSessionName(`super-dev: ${summary.specIdentifier}`); } catch { /* best-effort */ }
				const summaryLines = formatSummary(summary, process.cwd());
				finalizeLive(); // flush any pending live text into the transcript
				// Preserve the FULL run log to disk (the live display is a rolling tail).
				// AC-29: written under the run dir captured at start — never a newer run's.
				let logPath = "";
				try {
					logPath = runLogPathFor(runDir);
					persistLiveLog(true);
					writeFileSync(logPath, stream.diskLogText() + "\n");
				} catch { /* best-effort; the live tail is the primary surface */ }
				const escalationChoice = await handleStagnation(summary, ctx);
				// Async reflection ("dreaming") — non-blocking, best-effort. AC-29: the
				// ORIGINATING run dir is threaded so a late reflection never lands under
				// a newer run's directory.
				// v0.3.60 R9: track the in-flight reflection (and its origin dir) so
				// session_shutdown can name it if the session is torn down mid-run.
				// The tracking self-clears when the reflection SETTLES — only a
				// genuinely-pending reflection is ever reported as dropped (P10:
				// no false alarms for reflections that finished). The identity guard
				// stops an old reflection's settle from clearing a NEWER run's
				// tracking when reflections overlap across runs.
				const reflection = runReflectionAsync(runDir, (pi as { events?: unknown }).events as import("./agents/delegation-backend.ts").DelegationEventBus | undefined);
				// Defensive: a non-promise return (legacy/tests) tracks nothing.
				if (reflection) noteInFlightReflection(runDir, reflection);
				// v0.3.69 E2: auto post-mortem — read-only agent drafts a finding to
				// docs/findings/inbox/ ONLY when config postMortem==="auto" and the
				// run was not a success (manual default; the Decide gate stays human).
				try {
					if (shouldAutoPostMortem(summary.status, getConfig().postMortem)) {
						const bus = (pi as { events?: unknown }).events as import("./agents/delegation-backend.ts").DelegationEventBus | undefined;
						const frame = readLastMetricsRow(summary.specDirectory);
						if (bus && frame) {
							const postMortem = runPostMortem({
								events: bus,
								runId: frame.runId,
								status: summary.status,
								metricsRow: frame,
								artifactPaths: {
									runLog: logPath,
									eventsJsonl: summary.specDirectory ? eventsPath(summary.specDirectory) : undefined, // 063 S2 — the ONE resolution (external store)
									specDir: summary.specDirectory || undefined,
								},
							});
							// v0.3.86 F-16: register the detached post-mortem in the in-flight
							// background-work registry (kind "post-mortem") — a session_shutdown
							// mid-analysis now NAMES the dropped post-mortem (P10) instead of
							// severing the child agent silently.
							noteInFlightReflection(runDir, postMortem, "post-mortem");
							postMortem.then((out) => {
								auditAppend(out.draftPath
									? { stage: "post-mortem", control: { event: "finding-draft", path: out.draftPath } }
									: { stage: "post-mortem", error: out.error ?? "no draft" }, runDir);
							}).catch(() => { /* best-effort (P5) */ });
						} else {
							auditAppend({ stage: "post-mortem", skipped: bus ? "no metrics row (frame absent)" : "no delegation bus" }, runDir);
						}
					}
				} catch { /* best-effort (P5) */ }
				// Stages for the result's stage-progress section, from the live tracker.
				const stages = dashboardOrder.map((id) => ({ id, ...(dashboardStages.get(id) ?? { label: id, status: "·" }) }));
				// `content` is the text fallback (print/json/headless); in TUI, renderResult
				// below builds a themed 3-section view (dimmed logs / normal stages / summary).
				const fallback = [...summaryLines];
				if (logPath) fallback.push(`Full run log: ${logPath}`);
				if (escalationChoice) fallback.push(`  Escalation: user chose "${escalationChoice}".`);
				const isFailed = summary.status === "failed";
				return {
					// v0.3.60 R8 (canon): tools MUST truncate output — the headless
					// (print/json/RPC) content path gets the canonical bounds + notice
					// pointing at the durable run log. Byte-identical below the bounds.
					content: [{ type: "text", text: canonTruncate(fallback.join("\n"), logPath || undefined) }],
					isError: isFailed,
					details: { summary, summaryLines, transcriptTail: stream.transcriptTail(), stages, logPath },
				};
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				throw new Error(`❌ super-dev pipeline failed: ${message}`);
			} finally {
				// AC-29: release the serialization guard FIRST so the next run may
				// start as soon as this one is done.
				inFlight = false;
				// v0.3.60 R3: release the cross-instance guard with the same lifecycle
				// (v0.3.61: only if THIS run still owns it).
				releaseRunGuard(guardToken);
				// D-8: aggregate stats + run retention fire even without reflection
				// (best-effort — never let bookkeeping break a finished run).
				// Sweep-3 G10: pin the audit file captured at run START (runDir) —
				// never the module-global currentRunDir a newer run may own.
				try { if (liveAuditPath) updateStats(liveAuditPath); } catch { /* best-effort */ }
				try { cleanupOldRuns(); } catch { /* best-effort */ }
				// Discard the run-state singleton via the exported setter (single write
				// path) so no queued run input leaks across runs.
				setActiveRun(null);
				// AC-30: belt-and-braces release of the spec-dir run lock (pipeline.ts
				// owns the primary release; this covers direct callers).
				try { releaseHeldRunLock(); } catch { /* best-effort */ }
				// spec-11 AC-05 / SCENARIO-010: clear the per-run ChangeTracker singleton
				// in the SAME finally that nulls activeRun, so no tracker (and its
				// in-memory baselines/end-records) leaks across runs. The setup stage
				// installs it; every run clears it here on success OR failure.
				// Always clear the compact working message when the run ends (success or failure).
				try { ctx?.ui?.setWorkingMessage?.(); } catch { /* best-effort */ }
				// No-op: super-dev no longer owns a footer/status-line pill. Do not call
				// setStatus("super-dev", undefined) here either; some TUI shells render even
				// clear operations as prompt/status-line churn.
				// Phase 2 (AC-04 / SCENARIO-010): clear the mid-run input status pill in
				// the same cleanup that nulls activeRun.
				try { ctx?.ui?.setStatus?.("super-dev-input", undefined); } catch { /* best-effort */ }
				setActiveTracker(null);
			}
			};
			return await doRun(signal);
		},
		// Pi-native result rendering: 3 sections. §1 detail logs DIMMED (thought-like,
		// kept — not suppressed); §2 stage progress NORMAL (answer-like); §3 summary.
		renderResult(result, _opts: any, theme: Theme) {
			const d = (result.details ?? {}) as {
				summaryLines?: string[];
				transcriptTail?: TranscriptLine[];
				stages?: Array<{ id?: string; label: string; status: string; kind?: "stage" | "phase" | "step"; parentId?: string; startedAt?: string; endedAt?: string; durationMs?: number }>;
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
		description: "Run the staged super-dev pipeline. Usage: /super-dev <task description>",
		handler: async (args, ctx) => {
			if (hasRemovedBackgroundFlag(args)) {
				ctx.ui.notify(
					"Background super-dev runs have been removed. Use /super-dev <task description>.",
					"info",
				);
				return;
			}
			const { task } = parseSuperDevCommandArgs(args);
			if (!task) {
				ctx.ui.notify(
					"Usage: /super-dev <task description>\n\nExamples:\n  /super-dev implement user authentication with OAuth2\n  /super-dev fix the crash when uploading large files",
					"info",
				);
				return;
			}
			// Dispatch to the agent so it runs interruptibly and the tool streams progress.
			pi.sendUserMessage(buildSuperDevToolInstruction(task));
		},
	});

	type RunEntryData = { status?: string; task?: string; at?: number };
	const runRenderer: EntryRenderer<RunEntryData> = (entry, _opts, theme) => {
		const d: RunEntryData = entry.data ?? {};
		const container = new Container();
		container.addChild(new Text(theme.fg("accent", theme.bold(`── super-dev run ${d.status ?? "event"} ──`)), 0, 0));
		if (d.task) container.addChild(new Text(String(d.task), 0, 0));
		if (d.at) container.addChild(new Text(theme.fg("dim", new Date(d.at).toLocaleString()), 0, 0));
		return container;
	};
	try {
		pi.registerEntryRenderer("super-dev-run", runRenderer);
	} catch { /* best-effort */ }

	type InstructionEntryData = { instruction?: RuntimeInstruction; queued?: number };
	const instructionRenderer: EntryRenderer<InstructionEntryData> = (entry, _opts, theme) => {
		const d: InstructionEntryData = entry.data ?? {};
		const i = d.instruction;
		const container = new Container();
		container.addChild(new Text(theme.fg("accent", theme.bold(`── super-dev accepted runtime instruction${i?.id ? ` ${i.id}` : ""} ──`)), 0, 0));
		const text = i?.text?.trim() || "(image/content attachment)";
		container.addChild(new Text(text, 0, 0));
		const imageCount = i?.images?.length ?? 0;
		if (imageCount > 0) container.addChild(new Text(theme.fg("muted", `${imageCount} image attachment(s) will be persisted at the next checkpoint.`), 0, 0));
		container.addChild(new Text(theme.fg("dim", `Queued for next workflow checkpoint${d.queued ? ` · pending ${d.queued}` : ""}`), 0, 0));
		return container;
	};
	try {
		pi.registerEntryRenderer("super-dev-instruction", instructionRenderer);
	} catch { /* best-effort */ }

	try {
		pi.registerShortcut(SUPER_DEV_PANEL_SHORTCUT, {
			description: "Show active super-dev run panel",
			handler: async (ctx) => {
				const run = getActiveRun();
				if (!run || ctx.mode !== "tui") { ctx.ui.notify("No active super-dev run panel available.", "info"); return; }
				try {
					await ctx.ui.custom((_tui, theme, _keybindings, done) => {
						const container = new Container();
						container.addChild(new Text(theme.fg("accent", theme.bold("super-dev active run")), 1, 1));
						container.addChild(new Text(`Pending instructions: ${run.queue.length}`, 1, 0));
						container.addChild(new Text(`Latest: ${run.lastInstructionPreview ?? "(none)"}`, 1, 0));
						container.addChild(new Text(theme.fg("dim", "Press Enter/Escape to close"), 1, 1));
						Object.assign(container, { onKey: (key: string) => {
							if (key === "return" || key === "enter" || key === "escape") { done(undefined); return true; }
							return false;
						} });
						return container;
					}, { overlay: true });
				} catch { /* best-effort */ }
			},
		});
	} catch { /* best-effort */ }
}
