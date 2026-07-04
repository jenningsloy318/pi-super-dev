/**
 * Spawns `pi` child processes to run specialist agents — the single primitive
 * that replaces pi-workflow's agent engine. Verified invocation:
 *
 *   pi --mode json -p --no-session --no-skills [--no-extensions] \
 *      --tools read,bash,edit,write,ffgrep,fffind \
 *      [--model <provider/id>] --system-prompt <temp-file> "Task: <prompt>"
 *
 * stdout is newline-delimited JSON; the final assistant text is in the last
 * `{"type":"message_end","message":{"role":"assistant",...}}` event.
 */

import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadAgentPrompt } from "./agents.ts";
import { extractControl } from "./control.ts";
import type { AgentProgress, SpawnResult } from "./types.ts";

const BASE_TOOLS = "read,bash,edit,write,ffgrep,fffind";

/** Agents that drive a browser for UI testing. They receive the `browser_execute`
 *  tool and load extensions (so pi-browser-cdp-extension is available). The
 *  `--tools` allowlist still keeps every other extension tool (e.g. `subagent`)
 *  disabled, so this stays isolated. Browser connection uses AUTO-DISCOVERY —
 *  `await session.connect()` with no args finds any Chrome started with
 *  `--remote-debugging-port`; see agents/qa-agent.md. */
const BROWSER_AGENTS = new Set(["qa-agent"]);

export function isBrowserAgent(agent: string): boolean {
	return BROWSER_AGENTS.has(agent);
}

export function toolsForAgent(agent: string): string {
	return BROWSER_AGENTS.has(agent) ? `${BASE_TOOLS},browser_execute` : BASE_TOOLS;
}

/** Per-spawn wall-clock cap. Generous: capable agents legitimately take 1–2 min. */
const DEFAULT_SPAWN_TIMEOUT_MS = 480_000;

export interface SpawnAgentOptions {
	agent: string;
	prompt: string;
	cwd: string;
	model?: string;
	signal?: AbortSignal;
	id?: string;
	timeoutMs?: number;
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
	const systemPrompt = loadAgentPrompt(opts.agent);
	const tempDir = mkdtempSync(join(tmpdir(), "super-dev-agent-"));
	const promptPath = join(tempDir, "agent.md");
	writeFileSync(promptPath, systemPrompt, { mode: 0o600 });

	const args = buildSpawnArgs(opts, promptPath);
	const result = await runPi(args, opts.cwd, opts.signal, opts.id ?? opts.agent, opts.timeoutMs ?? DEFAULT_SPAWN_TIMEOUT_MS, opts.onProgress);
	rmSync(tempDir, { recursive: true, force: true });
	return result;
}

/**
 * Build the full argv vector for a specialist spawn, INCLUDING the executable
 * as element 0. (Extracted so the command resolution is unit-testable — a
 * previous version dropped `command` and tried to exec "--mode", causing
 * `spawn --mode ENOENT` on every single agent spawn.)
 *
 * Browser-capable agents (see BROWSER_AGENTS) omit `--no-extensions` so the
 * pi-browser-cdp-extension loads, and add `browser_execute` to the tool set.
 * The `--tools` allowlist still restricts active tools to the declared set.
 */
export function buildSpawnArgs(opts: SpawnAgentOptions, promptPath: string): string[] {
	const { command, args: prefix } = resolvePiBinary();
	const browser = isBrowserAgent(opts.agent);
	const args = [
		command, // ← the executable ("pi" on PATH, or `node` re-invoking the host entry)
		...prefix,
		"--mode", "json", "-p", "--no-session", "--no-skills",
	];
	// Browser agents need pi-browser-cdp-extension loaded, so they do NOT pass
	// --no-extensions. The --tools allowlist below still restricts active tools
	// to the declared set (so loading extensions doesn't enable e.g. `subagent`).
	if (!browser) args.push("--no-extensions");
	args.push("--tools", toolsForAgent(opts.agent));
	args.push("--system-prompt", promptPath);
	if (opts.model) args.push("--model", opts.model);
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
					else if (se.kind === "turn" && se.n > 1) onProgress.event(`turn ${se.n}`);
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
			return `$ ${String(a.command ?? "").split("\n")[0]}`;
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

