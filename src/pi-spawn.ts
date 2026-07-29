/**
 * Spawns `pi` child processes to run specialist agents — the single primitive
 * that replaces pi-workflow's agent engine. Verified invocation:
 *
 *   pi --mode json -p --no-session --no-skills \
 *      --exclude-tools super_dev \
 *      [--model <provider/id>] --system-prompt <temp-file> "Task: <prompt>"
 *
 * stdout is newline-delimited JSON; the final assistant text is in the last
 * `{"type":"message_end","message":{"role":"assistant",...}}` event.
 */

import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { loadAgentPrompt } from "./agents.ts";
import { extractControl } from "./control.ts";
import { safetyPreamble } from "./safety.ts";
import type { AgentProgress, SpawnResult } from "./types.ts";

/** Agents that drive a browser for UI testing. They receive the `browser_execute`
 *  tool and load extensions (so pi-browser-cdp-extension is available).
 *  Recursion is prevented by `--exclude-tools super_dev` (this extension's own
 *  spawner tool stays uncallable). Browser connection uses AUTO-DISCOVERY —
 *  `await session.connect()` with no args finds any Chrome started with
 *  `--remote-debugging-port`; see agents/qa-agent.md. */
const BROWSER_AGENTS = new Set(["qa-agent", "ui-tester"]);

export function isBrowserAgent(agent: string): boolean {
	return BROWSER_AGENTS.has(agent);
}

/** Agents that perform ONLINE RESEARCH. They need pi's web tools
 *  (`web_search` / `fetch_content` / `get_search_content` from the `pi-web-access`
 *  extension) AND the MCP gateway (`mcp` from `pi-mcp-adapter`) so they can pull
 *  EXTERNAL knowledge — best practices, library/framework docs, standards,
 *  pitfalls — for the requirement + BDD, rather than re-analyzing the local
 *  codebase (that is the code-assessment stage's job). Forced onto the SUBPROCESS
 *  backend (see workflow.ts) so extensions load in an ISOLATED process, never in
 *  the parent's in-process session. Ambient extensions now load by default (no
 *  `--no-extensions`); these two web/MCP extensions are ALSO attached via
 *  repeatable `-e <path>` as belt-and-suspenders so the web tools are present
 *  even if ambient discovery missed them. Recursion is prevented by
 *  `--exclude-tools super_dev` (the spawner tool stays uncallable); all other
 *  tools (built-in + extension + MCP) inherit active. */
const WEB_RESEARCH_AGENTS = new Set(["research-agent"]);

export function needsWebResearch(agent: string): boolean {
	return WEB_RESEARCH_AGENTS.has(agent);
}

/** The installed extensions a research agent explicitly loads via `-e`. Order
 *  is irrelevant; each is resolved to its on-disk entry by researchExtensions(). */
const RESEARCH_EXTENSION_PACKAGES = ["pi-web-access", "pi-mcp-adapter"];

/** Resolve an installed pi extension package to its loadable entry file, or null
 *  when it isn't installed. Uses pi's standard agent-dir npm layout
 *  (`<agentDir>/npm/node_modules/<pkg>/index.ts`). Kept pure (agentDir injected)
 *  so it is unit-testable against a temp fixture. Never throws. */
export function resolveExtensionEntry(pkg: string, agentDir: string): string | null {
	const entry = join(agentDir, "npm", "node_modules", pkg, "index.ts");
	try { return existsSync(entry) ? entry : null; } catch { return null; }
}

/** Resolve the research extensions' entry paths (pi-web-access + pi-mcp-adapter)
 *  from the pi agent dir. Missing packages are silently skipped so a partial
 *  install degrades gracefully (the agent still gets whatever loaded). */
export function researchExtensions(): string[] {
	const agentDir = process.env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), ".pi", "agent");
	return RESEARCH_EXTENSION_PACKAGES
		.map((p) => resolveExtensionEntry(p, agentDir))
		.filter((p): p is string => p !== null);
}


/** Agents whose deliverable is CODE EDITS to real source files (not a document).
 *  These legitimately need to READ large existing files AND apply/verify edits
 *  within one turn, so they get a much larger wall-clock budget + a code-centric
 *  delivery discipline (see session-agent.ts). The doc-writer default (480s +
 *  "explore ≤6, write the document") starves them: on a slow model, reading a
 *  400+ line source file alone can exhaust 8 min BEFORE a single edit lands
 *  (observed root cause of the recurring phase-03 zero-edit / edit-thrash
 *  failures). */
const CODE_WRITING_AGENTS = new Set(["implementer", "tdd-guide"]);

export function isCodeWritingAgent(agent: string): boolean {
	return CODE_WRITING_AGENTS.has(agent);
}

// ─── Per-agent thinking configuration (Phase 2) ─────────────────────────────

/** The model thinking/reasoning levels understood by pi's `--thinking` flag and
 *  `session.setThinkingLevel`. Ordered least→most effort. */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

/** Reasoning-heavy analysis agents: worth the extra token/latency cost of a
 *  high thinking budget because their deliverable is judgement/analysis. */
const REASONING_AGENTS = new Set([
	"design",
	"spec-writer",
	"adversarial-reviewer",
	"code-reviewer",
	"debug",
	"debugger",
	"assessment",
]);

/** Mechanical bookkeeping agents: little reasoning needed (commits, cleanup,
 *  slug summarization), so they think minimally to stay fast/cheap. */
const MECHANICAL_AGENTS = new Set([
	"commit",
	"orchestrator-commit",
	"cleanup",
	"slug",
	"slug-summarizer",
]);

/** Role-based default thinking level for an agent, mirroring isCodeWritingAgent.
 *  Reasoning-heavy analysis agents think hard; code writers think medium;
 *  mechanical bookkeeping agents think minimally; everything else defaults to
 *  medium. */
export function thinkingForAgent(agent: string): ThinkingLevel {
	if (REASONING_AGENTS.has(agent)) return "high";
	if (isCodeWritingAgent(agent)) return "medium";
	if (MECHANICAL_AGENTS.has(agent)) return "minimal";
	return "medium";
}

/** Narrow an arbitrary string to a ThinkingLevel (used for the env override). */
function asThinkingLevel(value: string | undefined): ThinkingLevel | undefined {
	return value && (THINKING_LEVELS as readonly string[]).includes(value) ? (value as ThinkingLevel) : undefined;
}

/** Resolve the effective thinking level with precedence (Phase 1 widened):
 *  per-call override → SUPER_DEV_THINKING env override → INHERITED main-session
 *  level (`inherited`) → role default. The INHERITED tier sits ABOVE the role
 *  default but BELOW per-call and SUPER_DEV_THINKING, so an explicit override
 *  or env var still wins (SCENARIO-005/006). */
export function resolveThinking(agent: string, perCall?: ThinkingLevel, inherited?: ThinkingLevel): ThinkingLevel {
	if (perCall) return perCall;
	const env = asThinkingLevel(process.env.SUPER_DEV_THINKING);
	if (env) return env;
	if (inherited) return inherited;
	return thinkingForAgent(agent);
}

/** Resolve the EXPLICIT-OR-INHERITED thinking level (per-call → SUPER_DEV_THINKING
 *  env → INHERITED) WITHOUT the role-default fallback (Phase 1, Feature 1).
 *  The session backend uses this to decide whether to thread `thinkingLevel` as
 *  a `createAgentSession` creation option: the level reaches creation ONLY when
 *  an explicit per-call / SUPER_DEV_THINKING / inherited value resolves, so the
 *  byte-identical baseline (no creation option, SCENARIO-002) is preserved when
 *  none does. The role default stays a best-effort `applyThinkingLevel` concern
 *  (see session-agent.ts), never a creation option. */
export function resolveExplicitThinking(perCall?: ThinkingLevel, inherited?: ThinkingLevel): ThinkingLevel | undefined {
	if (perCall) return perCall;
	const env = asThinkingLevel(process.env.SUPER_DEV_THINKING);
	if (env) return env;
	return inherited;
}

/** Resolve an EXPLICIT model id with precedence: explicit param → SUPER_DEV_MODEL
 *  env → undefined. The INHERITED main-session model is NOT handled here — it is
 *  an object threaded separately (inheritedModelObject) and derived into a
 *  qualified `provider/id` in buildSpawnArgs. Returns undefined when no explicit
 *  tier supplies a value (SCENARIO-003/004 — preserves the no-default rule). */
export function resolveModel(explicit?: string): string | undefined {
	const ex = explicit?.trim();
	if (ex) return ex;
	const env = process.env.SUPER_DEV_MODEL?.trim();
	return env || undefined;
}

/** Per-spawn wall-clock cap. Generous: capable agents legitimately take 1–2 min. */
const DEFAULT_SPAWN_TIMEOUT_MS = 480_000;
/** Code-writing agents (implementer/tdd-guide) must read large existing files
 *  AND land+verify edits in one turn; on a slow model the doc-writer cap aborts
 *  them mid-exploration before any edit is written. Give them ~20 min. */
const CODE_WRITING_TIMEOUT_MS = 1_200_000;

/** The default wall-clock cap for an agent, by role. Overridable per-call via
 *  AgentCall.timeoutMs (threaded through `common` in workflow.ts). */
export function defaultAgentTimeoutMs(agent: string): number {
	return isCodeWritingAgent(agent) ? CODE_WRITING_TIMEOUT_MS : DEFAULT_SPAWN_TIMEOUT_MS;
}

export interface SpawnAgentOptions {
	agent: string;
	prompt: string;
	cwd: string;
	model?: string;
	signal?: AbortSignal;
	id?: string;
	timeoutMs?: number;
	/** Optional per-call thinking override (Phase 2). When absent, the resolved
	 *  level falls back to SUPER_DEV_THINKING then the role default. */
	thinking?: ThinkingLevel;
	/** The FULL main-session model object (ctx.model), threaded through RunOptions
	 *  → realAgent.common → both backends. The subprocess backend derives the
	 *  parent's qualified `provider/id` from it for `--model` (never a bare id, so
	 *  the child resolves the SAME provider the parent is on). ADDITIVE — loses to
	 *  an explicit `model`/SUPER_DEV_MODEL override; wins over the SDK/settings
	 *  default. */
	inheritedModelObject?: import("./session-agent.ts").SessionModelOption;
	/** Phase 1 (Feature 1): DEFAULT thinking level inherited from the live main
	 *  session (ctx.thinkingLevel). ADDITIVE — loses to a per-call override and
	 *  to SUPER_DEV_THINKING env, but wins over the role default. */
	inheritedThinking?: ThinkingLevel;
	/** Ignored by the subprocess backend (it uses <control> text, not a schema).
	 *  Accepted so the same `common` options object can feed both backends. */
	controlKeys?: string[];
	/** Live progress from the spawned agent (tool calls + streaming text). */
	onProgress?: AgentProgress;
}

function resolvePiBinary(): { command: string; args: string[] } {
	const argv1 = process.argv[1] ?? "";
	if (argv1 && /\.(?:mjs|cjs|js)$/i.test(argv1)) {
		return { command: process.execPath, args: [argv1] };
	}
	return { command: "pi", args: [] };
}

export async function spawnAgent(opts: SpawnAgentOptions): Promise<SpawnResult> {
	const systemPrompt = `${safetyPreamble()}\n\n---\n\n${loadAgentPrompt(opts.agent)}`;
	const tempDir = mkdtempSync(join(tmpdir(), "super-dev-agent-"));
	const promptPath = join(tempDir, "agent.md");
	writeFileSync(promptPath, systemPrompt, { mode: 0o600 });

	const args = buildSpawnArgs(opts, promptPath, needsWebResearch(opts.agent) ? researchExtensions() : []);
	const result = await runPi(args, opts.cwd, opts.signal, opts.id ?? opts.agent, opts.timeoutMs ?? defaultAgentTimeoutMs(opts.agent), opts.onProgress);
	rmSync(tempDir, { recursive: true, force: true });
	return result;
}

/**
 * Build the full argv vector for a specialist spawn, INCLUDING the executable
 * as element 0. (Extracted so the command resolution is unit-testable — a
 * previous version dropped `command` and tried to exec "--mode", causing
 * `spawn --mode ENOENT` on every single agent spawn.)
 *
 * All agents load ambient (global + project) extensions by default (no
 * `--no-extensions`), matching pi-subagents' default (its
 * `disableAmbientExtensions` is false unless an explicit extensions list or
 * denyExtensions is given). Recursion is prevented by `--exclude-tools super_dev`
 * (this extension's own spawner tool stays uncallable even though super-dev
 * itself loads) — the subprocess counterpart of the session backend's
 * excludeTools. All other tools (built-in + extension + MCP) inherit active.
 * Browser agents additionally get `browser_execute`; research agents additionally load pi-web-access +
 * pi-mcp-adapter via `-e`.
 */
export function buildSpawnArgs(opts: SpawnAgentOptions, promptPath: string, extraExtensions: string[] = []): string[] {
	const { command, args: prefix } = resolvePiBinary();
	const args = [
		command, // ← the executable ("pi" on PATH, or `node` re-invoking the host entry)
		...prefix,
		"--mode", "json", "-p", "--no-session", "--no-skills",
	];
	// Extensions: ALL agents load ambient (global + project) extensions by
	// default (no --no-extensions) — matches pi-subagents' default, so an
	// inherited parent model that resolves from an extension-registered provider
	// no longer silently fails, and newly-installed useful extensions are picked
	// up automatically. Recursion is prevented solely by `--exclude-tools super_dev`
	// below (this extension's own spawner tool stays uncallable) — the subprocess
	// counterpart of the session backend's excludeTools:["super_dev"]. Browser/
	// research agents additionally pull their role extensions via the -e paths below.
	for (const ext of extraExtensions) args.push("-e", ext);
	// Inherit ALL tools (built-in + extension + MCP) — NO allowlist, so newly added
	// MCP/extension tools are picked up automatically without editing a whitelist.
	args.push("--exclude-tools", "super_dev");
	args.push("--system-prompt", promptPath);
	// Model precedence: explicit param → SUPER_DEV_MODEL env → INHERITED
	// main-session model (the parent's qualified `provider/id`, derived from the
	// ctx.model object) → SDK/settings default. `--model` is pushed ONLY when a
	// model resolves from any tier (SCENARIO-003/004), preserving the no-default
	// rule. The inherited ref is QUALIFIED (provider/id) — never a bare id — so
	// the child resolves the SAME provider the parent is on (mirrors pi-subagents'
	// INHERIT_MODEL → provider/id; closes the bare-id opencode mis-resolution).
	const explicitModel = resolveModel(opts.model);
	const inheritedRef = opts.inheritedModelObject ? `${opts.inheritedModelObject.provider}/${opts.inheritedModelObject.id}` : undefined;
	const resolvedModel = explicitModel ?? inheritedRef;
	if (resolvedModel) args.push("--model", resolvedModel);
	// Phase 1 (Feature 1): widened thinking precedence per-call → SUPER_DEV_THINKING
	// → inheritedThinking → role default (SCENARIO-005/006).
	args.push("--thinking", resolveThinking(opts.agent, opts.thinking, opts.inheritedThinking));
	args.push(`Task: ${opts.prompt}`);
	return args;
}

function runPi(args: string[], cwd: string, signal: AbortSignal | undefined, label: string, timeoutMs: number, onProgress?: AgentProgress): Promise<SpawnResult> {
	return new Promise((resolve, reject) => {
		const child = spawn(args[0], args.slice(1), {
			cwd,
			stdio: ["ignore", "pipe", "pipe"],
			env: { ...process.env },
			windowsHide: true,
		});
		// Bounded capture ONLY: the spawned agent's stdout is a stream of NDJSON
		// deltas where each message_update re-emits the FULL accumulated partial —
		// gigabytes for a verbose/long agent (the design stage crashed pi with
		// RangeError "Invalid string length" at >512MB). Never buffer the whole
		// stdout; parse line-by-line and keep only the last assistant text.
		let lineBuf = "";
		let lastAssistantText = "";
		let lastModel: string | undefined;
		let stderrBuf = "";
		let aborted = false;
		let timedOut = false;
		let turns = 0;
		let currentText = ""; // live streaming text of the current agent text block
		const STDERR_CAP = 16 * 1024;
		const LINE_CAP = 16 * 1024 * 1024;
		const cleanup = () => {
			signal?.removeEventListener("abort", onAbort);
			clearTimeout(timer);
		};
		const onAbort = () => {
			aborted = true;
			try { child.kill("SIGTERM"); } catch { /* ignore */ }
		};
		signal?.addEventListener("abort", onAbort, { once: true });
		const timer = setTimeout(() => {
			timedOut = true;
			try { child.kill("SIGTERM"); } catch { /* ignore */ }
		}, timeoutMs);

		child.stdout.on("data", (c: Buffer) => {
			lineBuf += c.toString("utf8");
			let nl: number;
			while ((nl = lineBuf.indexOf("\n")) >= 0) {
				const raw = lineBuf.slice(0, nl);
				lineBuf = lineBuf.slice(nl + 1);
				const trimmed = raw.trim();
				if (!trimmed) continue;
				let ev: PiJsonEvent;
				try { ev = JSON.parse(trimmed) as PiJsonEvent; } catch { continue; }
				// capture the final assistant text (for <control> extraction)
				const a = assistantFromMessageEnd(ev);
				if (a) {
					if (a.text) { lastAssistantText = a.text; if (a.model) lastModel = a.model; }
					// a finished message finalizes any in-progress live text
					if (onProgress && currentText.trim()) { onProgress.event(stripControl(currentText).trim()); currentText = ""; }
					continue;
				}
				if (!onProgress) continue;
				const se = renderEvent(ev, () => ++turns);
				if (!se) continue;
				if (se.kind === "text") {
					// live typing: update the mutable live line
					currentText = se.text;
					onProgress.text(stripControl(currentText));
				} else {
					// a permanent event finalizes any in-progress text first
					if (currentText.trim()) { onProgress.event(stripControl(currentText).trim()); currentText = ""; }
					if (se.kind === "tool") onProgress.event(`→ ${se.summary}`);
				}
			}
			if (lineBuf.length > LINE_CAP) lineBuf = ""; // stay bounded on a runaway line
		});
		child.stderr.on("data", (c: Buffer) => {
			stderrBuf += c.toString("utf8");
			if (stderrBuf.length > STDERR_CAP) stderrBuf = stderrBuf.slice(stderrBuf.length - STDERR_CAP);
		});
		child.on("error", (err) => {
			cleanup();
			reject(new Error(`super-dev [${label}]: failed to spawn pi: ${err.message}`));
		});
		child.on("close", (code) => {
			cleanup();
			if (aborted) { resolve({ text: "", control: null, error: "aborted" }); return; }
			// lastAssistantText already holds the last non-empty assistant text
			// (resilient to a trailing tool-call turn or a mid-stream kill).
			if (lastAssistantText) {
				resolve({ text: lastAssistantText, control: extractControl(lastAssistantText), model: lastModel, error: timedOut ? `timed out after ${timeoutMs}ms (used partial output)` : undefined });
				return;
			}
			const tail = stderrBuf.trim().split("\n").slice(-3).join(" | ");
			const reason = timedOut ? `timed out after ${Math.round(timeoutMs / 1000)}s` : `produced no output (exit ${code})`;
			reject(new Error(`super-dev [${label}]: agent ${reason}.${tail ? ` stderr: ${tail}` : ""}`));
		});
	});
}

interface PiJsonEvent {
	type?: string;
	toolName?: string;
	args?: Record<string, unknown>;
	message?: { role?: string; model?: string; content?: Array<{ type: string; text?: string }> };
}

/** If an event is an assistant message_end, return its text + model (shared by
 *  the streaming capture and the batch extractFinalAssistant). */
function assistantFromMessageEnd(ev: PiJsonEvent): { text: string; model?: string } | null {
	if (ev.type !== "message_end" || ev.message?.role !== "assistant") return null;
	const text = (ev.message.content ?? [])
		.filter((p) => p.type === "text" && typeof p.text === "string")
		.map((p) => p.text as string)
		.join("");
	return { text, model: ev.message.model };
}

/** Compact one-line summary of a tool call, for live progress.
 *  Paths/commands are shown IN FULL (no truncation, no abbreviation) — the
 *  TUI wraps long lines, same as it does for read/write. */
export function summarizeToolCall(name: string, args: Record<string, unknown> | undefined): string {
	const a = args ?? {};
	switch (name) {
		case "write":
		case "edit":
		case "read":
			return `${name} ${a.path ?? a.file_path ?? ""}`;
		case "bash":
			return `$ ${String(a.command ?? "")}`;
		case "ffgrep":
		case "fffind":
			return `${name} "${a.pattern ?? ""}"`;
		default:
			return name;
	}
}

/** Shorten a path/string for display: cwd => ".", $HOME => "~". Keeps live
 *  progress readable instead of being truncated mid-path by the TUI. */
export function abbreviatePath(p: string, cwd?: string): string {
	if (!p) return p;
	let out = p;
	if (cwd && cwd.length > 1 && out.includes(cwd)) out = out.split(cwd).join(".");
	const home = process.env.HOME;
	if (home && out.startsWith(home)) out = "~" + out.slice(home.length);
	return out;
}

/** Parse one streamed NDJSON line: surface live progress AND capture the
 *  assistant text. Returns {text,model} if the line is an assistant message_end. */
type StreamEvent =
	| { kind: "text"; text: string }
	| { kind: "tool"; summary: string }
	| { kind: "turn"; n: number };

/** Strip the machine <control> block from displayed text. */
function stripControl(s: string): string {
	return s.replace(/<control>[\s\S]*?<\/control>/gi, "");
}

/** Extract a renderable event from a parsed NDJSON line (pure).
 *  pi streams assistant text inside `message_update` events whose `message.content`
 *  holds the full accumulated text so far. */
export function renderEvent(ev: PiJsonEvent, nextTurn: () => number): StreamEvent | null {
	switch (ev.type) {
		case "message_update": {
			const text = (ev.message?.content ?? []).filter((p) => p.type === "text").map((p) => p.text ?? "").join("");
			return text ? { kind: "text", text } : null;
		}
		case "tool_execution_start":
			return ev.toolName ? { kind: "tool", summary: summarizeToolCall(ev.toolName, ev.args) } : null;
		case "turn_start":
			return { kind: "turn", n: nextTurn() };
		default:
			return null;
	}
}

export function extractFinalAssistant(stdout: string): { text: string; model?: string } {
	let text = "";
	let model: string | undefined;
	for (const line of stdout.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		let event: PiJsonEvent;
		try { event = JSON.parse(trimmed) as PiJsonEvent; } catch { continue; }
		// Keep the LAST NON-EMPTY assistant text — never overwrite with empty,
		// so a trailing tool-call-only turn doesn't discard the control block
		// emitted in an earlier turn.
		const r = assistantFromMessageEnd(event);
		if (r && r.text) { text = r.text; if (r.model) model = r.model; }
	}
	return { text, model };
}

