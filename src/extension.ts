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

import type { ExtensionAPI, Theme, ExtensionContext, InputEvent, EntryRenderer } from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";
import { packDashboardLines, padTruncate, truncateActivity, buildDashboardWidget, createDashboardWidgetFactory, buildResultComponent } from "./render/dashboard.ts";
import type { DashboardTheme } from "./render/dashboard.ts";
import { createLiveStream } from "./render/live-stream.js";
import type { TranscriptLine, LiveStreamHandle } from "./render/live-stream.js";
import { Type } from "typebox";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { ensureSuperDevDirs, startRun, runLogPathFor, getConfig } from "./render/super-dev-dir.ts";
import { runReflectionAsync } from "./render/reflection.ts";
import { updateStats, cleanupOldRuns } from "./render/cleanup.ts";
import { writeEscalationReport } from "./render/escalation-report.ts";
import { localTimestamp } from "./render/time.ts";
import { runPipelineTask } from "./pipeline.ts";
import { maxReplanRounds, pendingHumanReplanRequests } from "./replan/replan.ts";
import { releaseHeldRunLock } from "./setup.ts";
import { appendRunEvent } from "./runlog.ts";
import { abbreviatePath, type ThinkingLevel } from "./pi-spawn.ts";
import { setActiveTracker } from "./tracking.ts";
import { superDevRunMetadataLine } from "./version.ts";
import type { Escalate, EscalationDecision, EscalationFailure, ProgressSink, RunStatus, RunSummary, RuntimeInstruction, RuntimeInstructionImage } from "./types.ts";

export { runPipelineTask } from "./pipeline.ts";
export { SUPER_DEV_WORKFLOW } from "./stages/index.ts";
export * as nodes from "./nodes.ts";
export { runWorkflow } from "./workflow.ts";
export { SUPER_DEV_VERSION_METADATA, SUPER_DEV_EXTENSION_VERSION, SUPER_DEV_VERSION_POLICY, superDevVersionLabel } from "./version.ts";

const SUPER_DEV_TOOL = "super_dev";
const SUPER_DEV_COMMAND = "super-dev";
const SUPER_DEV_PANEL_SHORTCUT = "ctrl+shift+d";

export interface ParsedSuperDevCommandArgs {
	task: string;
}

/** Parse `/super-dev` args. The command is foreground-only. */
export function parseSuperDevCommandArgs(args: unknown): ParsedSuperDevCommandArgs {
	return { task: String(args ?? "").trim() };
}

function hasRemovedBackgroundFlag(args: unknown): boolean {
	return /^--(?:bg|background)(?:\s+|$)/.test(String(args ?? "").trim());
}

function buildSuperDevToolInstruction(task: string): string {
	return [
		`Use the ${SUPER_DEV_TOOL} tool with these exact parameters:`,
		JSON.stringify({ task }, null, 2),
		"Call the tool now. Pass the task verbatim.",
	].join("\n");
}

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
	queue: RuntimeInstruction[];
	/** Preview of the most recent accepted instruction for native dashboard UI. */
	lastInstructionPreview?: string;
	/** The execute() ctx (TUI guards + ACK surfaces use this — Phase 2). */
	ctx?: ExtensionContext;
	/** The live-stream handle (Phase 2 ACK: pushes the user-input transcript
	 *  line). Optional so the Phase 1 idle-shape (no stream) still works. */
	stream?: LiveStreamHandle;
	/** Store interactive input. Empty/whitespace-only text is allowed only when images exist. */
	push(text: string, images?: RuntimeInstructionImage[], meta?: { source?: string; streamingBehavior?: "steer" | "followUp" }): RuntimeInstruction | null;
	/** Back-compat text-only drain for existing callers/tests. */
	drain(): string[];
	/** Atomically return the pending structured inputs AND clear the queue. */
	drainInstructions(): RuntimeInstruction[];
}

let activeRun: ActiveRun | null = null;

/** AC-29 (SCENARIO-059): exactly one super_dev run may be in flight at a time.
 *  Set at doRun() entry, cleared in its finally. A second execute() while a
 *  run is active is REFUSED — the active singleton and the module-global run
 *  dir are never clobbered by a concurrent invocation. */
let inFlight = false;

/** Bound on queued mid-run inputs so a single specialist spawn cannot be
 *  token-bombed via a huge guidance prepend. Older entries are dropped first
 *  (most-recent guidance wins — it reflects the user's latest intent). */
const MAX_QUEUED_INPUTS = 20;

/** Phase 2 (AC-04 / SCENARIO-008): ellipsize the queued-input preview to ~60
 *  chars so the status pill stays one line even for long user messages. */
function previewInput(text: string, max = 60): string {
	const t = String(text ?? "");
	return t.length > max ? `${t.slice(0, max)}…` : t;
}

let instructionSeq = 0;
function createInstructionId(): string {
	instructionSeq += 1;
	return `ui-${Date.now().toString(36)}-${instructionSeq.toString(36)}`;
}

function normalizeInputImages(images: unknown): RuntimeInstructionImage[] {
	return Array.isArray(images) ? images as RuntimeInstructionImage[] : [];
}

function instructionForEntry(instruction: RuntimeInstruction): RuntimeInstruction {
	return {
		...instruction,
		images: (instruction.images ?? []).map((image) => ({
			mediaType: image.mediaType,
			path: image.path,
			label: image.label,
		})),
	};
}

/** Factory for the module-scoped ActiveRun (fresh queue per run — no leak).
 *  Phase 2 adds the optional `stream` arg so push() can reach the live-stream's
 *  `userInput` sink; omitting it preserves Phase 1 behavior (queue + no ACK). */
export function createActiveRun(ctx?: ExtensionContext, stream?: LiveStreamHandle): ActiveRun {
	return {
		queue: [],
		ctx,
		stream,
		push(text: string, images: RuntimeInstructionImage[] = [], meta: { source?: string; streamingBehavior?: "steer" | "followUp" } = {}): RuntimeInstruction | null {
			const t = String(text ?? "").trim();
			const normalizedImages = Array.isArray(images) ? images : [];
			if (!t && normalizedImages.length === 0) return null;
			const instruction: RuntimeInstruction = {
				id: createInstructionId(),
				createdAt: new Date().toISOString(),
				text: t,
				source: meta.source,
				streamingBehavior: meta.streamingBehavior,
				images: normalizedImages,
			};
			this.queue.push(instruction);
			// Bound the queue: drop the oldest entry when over capacity so a single
			// specialist spawn can't be token-bombed (most-recent guidance wins).
			if (this.queue.length > MAX_QUEUED_INPUTS) this.queue.shift();
			const imageSuffix = normalizedImages.length ? ` + ${normalizedImages.length} image(s)` : "";
			const preview = t || "(image/content attachment)";
			this.lastInstructionPreview = `${preview}${imageSuffix}`;
			if (this.ctx?.mode === "tui" && this.stream) {
				try { this.ctx?.ui?.setStatus?.("super-dev-input", `📥 accepted: ${previewInput(preview)}${imageSuffix}`); } catch { /* best-effort */ }
				try { this.stream.sink.userInput(`${instruction.id}: ${preview}${imageSuffix} — queued for next checkpoint`); } catch { /* best-effort */ }
			}
			return instruction;
		},
		drain(): string[] {
			return this.drainInstructions().map((instruction) => instruction.text);
		},
		drainInstructions(): RuntimeInstruction[] {
			// Atomic return-and-clear. A second drain returns [] until new input
			// arrives, so each captured input is injected exactly once.
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

/** OQ6 (dsh-09 v3): replan auto-resume defaults ON; SUPER_DEV_REPLAN_MANUAL=1
 *  opts into confirm-first single runs. Lazy env read (defensive rule #5). */
function autoResumeEnabled(): boolean {
	return process.env.SUPER_DEV_REPLAN_MANUAL !== "1";
}

/** Format a run summary honestly: success ✅ / partial ⚠️ / failed ❌ / replan 🔁. */
function formatSummary(s: RunSummary, cwd?: string): string[] {
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

function formatDuration(ms: number): string {
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

function launchMetadataLines(task: string, cwd: string, runLogPath: string): string[] {
	return [
		`Run started: ${localTimestamp()}`,
		`Task: ${task}`,
		`Launch cwd: ${cwd}`,
		`Launch worktree: ${gitValue(cwd, ["rev-parse", "--show-toplevel"])}`,
		`Launch branch: ${gitValue(cwd, ["branch", "--show-current"])}`,
		`Run log: ${runLogPath}`,
	];
}

/** Gap 4.6′-lite — stagnation escalation (scheme C: informative by default, interactive opt-in).
 *  Always writes a stagnation-report.md to the spec dir (baseline, all modes);
 *  spec-18 / Phase 2 additionally delegates the canonical escalation-report.md
 *  to the shared `writeEscalationReport` writer. When the run is interactive
 *  (ctx.hasUI) AND config.escalation === "interactive", additionally prompts a
 *  3-option select. Returns the chosen option (or undefined if not interactive /
 *  dismissed). For Tier-2 all options just finish the run — "revise spec" only
 *  surfaces the recommendation; auto-replay is deferred (Tier-3). */
interface StagnationRecord {
	/** F-C: WHY the loop broke. "stagnation" (default, legacy) = identical
	 *  findings recurred across consecutive rounds — the fixer tried and failed.
	 *  "blocked-on-decisions" = no actionable findings remain (all deferred:
	 *  advisory / needs-human / cross-stage) — nothing recurred; a human
	 *  decision or upstream revision is the only way forward. The report and
	 *  prompt must never tell the human to "fix the implementation" for this
	 *  kind — that is precisely the misdiagnosis run 2026-08-16T01-00-35
	 *  produced by reusing the stagnation template. */
	kind?: "stagnation" | "blocked-on-decisions";
	rounds?: number;
	verdict?: string;
	findings?: Array<{ file?: string | null; severity?: string | null; title?: string | null }>;
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function handleStagnation(summary: RunSummary, ctx: any, opts?: { escalation?: "informative" | "interactive" }): Promise<string | undefined> {
	const st = (summary.state as Record<string, unknown>).__stagnated as StagnationRecord | undefined;
	if (!st) return undefined;
	// If the inline escalation (verify.ts) already attempted (even if dismissed),
	// don't re-prompt here (prevents double-prompt on the same stagnation).
	if ((summary.state as Record<string, unknown>).__escalationAttempted) return undefined;

	// Baseline (all modes): write the report. The stagnation prose is shared
	// between the legacy human-facing `stagnation-report.md` (backward-compat —
	// the diagnostic referenced in the run summary) and the canonical
	// `escalation-report.md` produced by delegating to the shared
	// `writeEscalationReport` writer (spec-18 / Phase 2 generalization: one
	// structured report format across this legacy path and the new inline
	// `escalate` callback; uniformly never-throw). Additive + never-regressing.
	const findingsRaw = st.findings ?? [];
	const blocked = st.kind === "blocked-on-decisions";
	const message = blocked
		? [
			`The verify loop stopped after **${st.rounds}** round(s): the merged review verdict (**${st.verdict ?? "unknown"}**) is not approved, but every remaining finding is deferred — advisory, needs-human, or owned by an upstream stage.`,
			"",
			"Nothing recurred and no code fixer may act on these items. Awaiting a human decision: accept the deferred items as known limitations, resolve them manually, or revise the owning upstream artifact (spec/design) and rerun.",
		].join("\n")
		: [
		`The verify-loop broke early after **${st.rounds}** review round(s): the same findings recurred across two consecutive iterations.`,
		"",
		`Merged review verdict at stagnation: **${st.verdict ?? "unknown"}**.`,
		"",
		"This means the workflow reached review/verify but repeated the same unresolved findings. Treat it as a workflow/review convergence blocker: inspect the recurring findings, fix the implementation or orchestration issue they identify, or provide explicit retry guidance before rerunning.",
	].join("\n");
	// Legacy human-facing diagnostic (byte-identical to pre-spec-18 output for
	// the stagnation kind; honest kind-specific prose for the dead-state break).
	try {
		const findingLines = findingsRaw.map((f) => `- [${f.severity ?? "?"}] ${f.file ? "`" + f.file + "` " : ""}${f.title ?? ""}`);
		writeFileSync(
			join(summary.specDirectory, "stagnation-report.md"),
			[
				"# Stagnation report",
				"",
				message,
				"",
				blocked ? "## Blocked on decisions (deferred findings — no code fixer can act)" : "## Recurring findings",
				...(findingLines.length ? findingLines : ["_(no structured findings captured)_"]),
			].join("\n"),
		);
	} catch { /* best-effort */ }
	// Canonical escalation report via the shared writer (never-throw).
	writeEscalationReport(
		{
			kind: "stagnation",
			stage: "verify",
			severity: "soft",
			message,
			findings: findingsRaw.map((f) => ({
				file: f.file ?? null,
				severity: f.severity ?? null,
				title: f.title ?? null,
			})),
			specDirectory: summary.specDirectory,
		},
		undefined,
		summary.specDirectory,
	);

	// Opt-in interactive escalation (TUI/RPC only).
	const mode = opts?.escalation ?? getConfig().escalation;
	const interactive = ctx?.hasUI === true && mode === "interactive";
	if (!interactive) return undefined;
	try {
		const choice = await ctx.ui?.select?.(
			formatEscalationPrompt(
				{ kind: blocked ? "blocked-on-decisions" : "stagnation", stage: "verify", severity: "soft", message, findings: findingsRaw },
				blocked ? "Blocked on decisions — how to proceed?" : "Review loop stagnant — how to proceed?",
			),
			["Revise spec & re-run from design", "Accept findings as known limitations", "Abandon worktree"],
			{ timeout: 120_000 },
		);
		return choice ?? undefined;
	} catch {
		return undefined;
	}
}

/** Human-readable choices offered via ctx.ui.select, in stable order. */
const ESCALATE_OPTIONS_SOFT = [
	"Retry with guidance",
	"Revise manually",
	"Accept limitation",
	"Abandon",
];
const ESCALATE_OPTIONS_HARD = [
	"Retry with guidance",
	"Revise manually",
	"Abandon",
];

/** M4 routing (G6): the full offered list for a failure — when it carries a
 *  routeBackOwner (exactly one upstream routable owner), "Route back to
 *  ⟨owner⟩ (recommended)" leads BOTH severity lists. */
export function escalateOptionsFor(failure: { severity?: string; routeBackOwner?: string }): string[] {
	const base = failure.severity === "hard" ? ESCALATE_OPTIONS_HARD : ESCALATE_OPTIONS_SOFT;
	if (!failure.routeBackOwner) return base;
	return [`Route back to ${failure.routeBackOwner} (recommended)`, ...base];
}

/** Map a ctx.ui.select result to an EscalationDecision (undefined = dismissed).
 *  The route-back marker is matched FIRST — "Revise manually" never contains
 *  "route", but keep the order explicit anyway. */
export function mapEscalateChoice(choice: unknown): EscalationDecision | undefined {
	if (typeof choice !== "string") return undefined;
	const lower = choice.toLowerCase();
	if (lower.startsWith("route back")) return { choice: "route-back" };
	if (lower.includes("retry")) return { choice: "retry-with-guidance" };
	if (lower.includes("revise")) return { choice: "revise-manually" };
	if (lower.includes("accept")) return { choice: "accept-limitation" };
	if (lower.includes("abandon")) return { choice: "abandon" };
	return undefined;
}

/** Format the FULL blocker (message + structured findings) into the interactive
 *  escalation prompt, so the user sees WHAT blocked the run — not merely that a
 *  blocker exists — before choosing how to proceed. The finding layout mirrors
 *  escalation-report.md (one source of truth for the blocker text). */
function formatEscalationPrompt(
	failure: { kind?: string; stage?: string; severity?: string; message: string; findings?: readonly { file?: string | null; severity?: string | null; title?: string | null }[] },
	headline: string,
): string {
	const meta = [
		failure.stage && `Stage: ${failure.stage}`,
		failure.kind && `Kind: ${failure.kind}`,
		failure.severity && `Severity: ${failure.severity}`,
	].filter(Boolean).join("   ");
	const findings = (failure.findings ?? []).filter((f) => (f.title ?? "").trim() || (f.file ?? "").trim());
	const findingLines = findings.length
		? ["", "Findings:", ...findings.map((f) => `- [${f.severity ?? "?"}] ${f.file ? "`" + f.file + "` " : ""}${f.title ?? ""}`)]
		: [];
	return [headline, ...(meta ? ["", meta] : []), "", failure.message, ...findingLines].join("\n");
}

/**
 * Build the inline `escalate` callback for a run (spec-18 / AC-01). ALWAYS
 * writes `escalation-report.md` via {@link writeEscalationReport}; then — ONLY
 * when `ctx.hasUI === true` — prompts `ctx.ui.select` (300s timeout) and, for a
 * retry-with-guidance choice, `ctx.ui.input` to capture free-text guidance.
 * Wrapped in try/catch so dismissal / timeout / error all collapse to
 * `undefined` (the pre-existing fail-with-report path). `accept-limitation` is
 * omitted from the offered choices when the failure is `severity: "hard"`.
 * NEVER throws.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function makeEscalate(ctx: any): Escalate {
	const escalate: Escalate = async (failure: EscalationFailure) => {
		let decision: EscalationDecision | undefined;
		// Interactive pause-ask-continue — TUI/RPC only.
		if (ctx?.hasUI === true) {
			try {
				const options = escalateOptionsFor(failure);
				failure.offeredChoices = options; // MP5: persisted with the report
				const choice = await ctx.ui?.select?.(
					formatEscalationPrompt(failure, "Super-dev hit a blocker — how to proceed?"),
					options,
					{ timeout: 300_000 },
				);
				decision = mapEscalateChoice(choice);
				if (decision?.choice === "retry-with-guidance") {
					const guidance = await ctx.ui?.input?.(
						"Guidance for the retry (appended to the next specialist attempt):",
						{ timeout: 300_000 },
					);
					if (typeof guidance === "string" && guidance.trim()) {
						decision.guidance = guidance;
					}
				}
			} catch {
				decision = undefined;
			}
		}
		// ALWAYS write the report (baseline, all modes). Never throws.
		writeEscalationReport(failure, decision, failure.specDirectory);
		return decision;
	};
	return escalate;
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
			// idle (no run in progress) → pi owns the input entirely.
			if (activeRun == null) return { action: "continue" };
			const event = data as InputEvent;
			// non-interactive sources (rpc/extension/print/json/headless) are never
			// captured — they flow through pi byte-identical to today.
			if (event?.source !== "interactive") return { action: "continue" };
			// Slash-commands pass through so /reload, /model, etc.
			// still work during a run. Everything else typed during an active run is
			// captured as mid-run user context: it is drained + persisted into
			// .user-notes.json and injected into EVERY subsequent stage (durable,
			// resume-safe). Returning {handled} tells pi NOT to also queue it as a normal turn.
			// Coerce safely so a missing/blank `text` can never crash the handler.
			const text = typeof event?.text === "string" ? event.text : "";
			if (text.trimStart().startsWith("/")) return { action: "continue" };
			const instruction = activeRun.push(text, normalizeInputImages(event?.images), { source: event?.source, streamingBehavior: event?.streamingBehavior });
			if (instruction) {
				try { pi.appendEntry?.("super-dev-instruction", { instruction: instructionForEntry(instruction), queued: activeRun.queue.length }); } catch { /* best-effort */ }
			}
			return { action: "handled" };
		} catch {
			return { action: "continue" };
		}
	});

	pi.registerTool({
		name: SUPER_DEV_TOOL,
		label: "Super Dev",
		description:
			"Run the self-contained 13-stage super-dev pipeline (requirements → research → design → spec → TDD implementation → verification convergence → docs → merge). Spawns specialist `pi` subagents directly — no external workflow engine required.",
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
				phase: (label) => { stream.sink.phase(label); persistLiveLog(); if (ctx?.mode === "tui") { try { ctx?.ui?.setWorkingMessage?.(`super-dev · ${label}`); } catch { /* best-effort */ } } flushLive(); },
				log: (message) => { stream.sink.log(message); persistLiveLog(); flushLive(); },
				text: (partial) => {
					stream.sink.text(partial);
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
				// AC-29 (SCENARIO-059): serialize runs — a second execute() while a run
				// is in flight is refused OUTRIGHT (before the try, so the finally below
				// never runs for a refused call and cannot null the ACTIVE run's
				// singleton / run dir); it must never interleave a second pipeline.
				if (inFlight) {
					return { content: [{ type: "text", text: "a super-dev run is already active — wait for it to finish (or abort it) before starting another" }], isError: true, details: {} };
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
				liveRunLogPath = runLogPathFor(runDir);
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
				let inheritedModelObject: import("./session-agent.ts").SessionModelOption | undefined;
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
					try { appendRunEvent(summary.specDirectory, { runId: summary.specIdentifier, type: "replan.resumed", data: { runId: summary.specIdentifier, requests: marker?.newRequests ?? 0 } }); } catch { /* best-effort */ }
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
				runReflectionAsync(runDir);
				// Stages for the result's stage-progress section, from the live tracker.
				const stages = dashboardOrder.map((id) => ({ id, ...(dashboardStages.get(id) ?? { label: id, status: "·" }) }));
				// `content` is the text fallback (print/json/headless); in TUI, renderResult
				// below builds a themed 3-section view (dimmed logs / normal stages / summary).
				const fallback = [...summaryLines];
				if (logPath) fallback.push(`Full run log: ${logPath}`);
				if (escalationChoice) fallback.push(`  Escalation: user chose "${escalationChoice}".`);
				const isFailed = summary.status === "failed";
				return {
					content: [{ type: "text", text: fallback.join("\n") }],
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
				// D-8: aggregate stats + run retention fire even without reflection
				// (best-effort — never let bookkeeping break a finished run).
				try { updateStats(); } catch { /* best-effort */ }
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
		description: "Run the 13-stage super-dev pipeline. Usage: /super-dev <task description>",
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
