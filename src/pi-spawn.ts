/**
 * Spawns `pi` child processes to run specialist agents — the single primitive
 * that replaces pi-workflow's agent engine. Verified invocation:
 *
 *   pi --mode json -p --no-session --no-skills --no-extensions \
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
import type { SpawnResult } from "./types.ts";

const AGENT_TOOLS = "read,bash,edit,write,ffgrep,fffind";

/** Per-spawn wall-clock cap. Generous: capable agents legitimately take 1–2 min. */
const DEFAULT_SPAWN_TIMEOUT_MS = 300_000;

export interface SpawnAgentOptions {
	agent: string;
	prompt: string;
	cwd: string;
	model?: string;
	signal?: AbortSignal;
	id?: string;
	timeoutMs?: number;
	/** Live, compact progress from the spawned agent (e.g. tool calls). */
	onProgress?: (message: string) => void;
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
 */
export function buildSpawnArgs(opts: SpawnAgentOptions, promptPath: string): string[] {
	const { command, args: prefix } = resolvePiBinary();
	const args = [
		command, // ← the executable ("pi" on PATH, or `node` re-invoking the host entry)
		...prefix,
		"--mode", "json", "-p", "--no-session", "--no-skills", "--no-extensions",
		"--tools", AGENT_TOOLS,
		"--system-prompt", promptPath,
	];
	if (opts.model) args.push("--model", opts.model);
	args.push(`Task: ${opts.prompt}`);
	return args;
}

function runPi(args: string[], cwd: string, signal: AbortSignal | undefined, label: string, timeoutMs: number, onProgress?: (m: string) => void): Promise<SpawnResult> {
	return new Promise((resolve, reject) => {
		const child = spawn(args[0], args.slice(1), {
			cwd,
			stdio: ["ignore", "pipe", "pipe"],
			env: { ...process.env },
			windowsHide: true,
		});
		let stdoutBuf = "";
		let stderrBuf = "";
		let lineBuf = "";
		let aborted = false;
		let timedOut = false;
		let turns = 0;
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
			const chunk = c.toString("utf8");
			stdoutBuf += chunk;
			// Parse complete NDJSON lines as they arrive to surface live progress.
			if (onProgress) {
				lineBuf += chunk;
				let nl: number;
				while ((nl = lineBuf.indexOf("\n")) >= 0) {
					const line = lineBuf.slice(0, nl);
					lineBuf = lineBuf.slice(nl + 1);
					if (line.trim()) handleProgressLine(line, onProgress, () => ++turns);
				}
			}
		});
		child.stderr.on("data", (c: Buffer) => { stderrBuf += c.toString("utf8"); });
		child.on("error", (err) => {
			cleanup();
			reject(new Error(`super-dev [${label}]: failed to spawn pi: ${err.message}`));
		});
		child.on("close", (code) => {
			cleanup();
			if (aborted) { resolve({ text: "", control: null, error: "aborted" }); return; }
			// Resilient capture: keep the LAST NON-EMPTY assistant text seen in any
			// message_end. This recovers control JSON even when the agent ends on a
			// trailing tool-call turn (final message_end has no text) or is killed
			// mid-stream after already emitting its control block.
			const { text, model } = extractFinalAssistant(stdoutBuf);
			if (text) {
				resolve({ text, control: extractControl(text), model, error: timedOut ? `timed out after ${timeoutMs}ms (used partial output)` : undefined });
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
	message?: { role?: string; content?: Array<{ type: string; text?: string }> };
}

/** Compact one-line summary of a tool call, for live progress. */
export function summarizeToolCall(name: string, args: Record<string, unknown> | undefined): string {
	const a = args ?? {};
	switch (name) {
		case "write":
		case "edit":
		case "read":
			return `${name} ${a.path ?? a.file_path ?? ""}`;
		case "bash":
			return `$ ${String(a.command ?? "").split("\n")[0].slice(0, 60)}`;
		case "ffgrep":
		case "fffind":
			return `${name} "${a.pattern ?? ""}"`;
		default:
			return name;
	}
}

/** Parse one streamed NDJSON line and surface meaningful progress. */
function handleProgressLine(line: string, onProgress: (m: string) => void, nextTurn: () => number): void {
	let ev: { type?: string; toolName?: string; args?: Record<string, unknown> };
	try { ev = JSON.parse(line) as typeof ev; } catch { return; }
	if (ev.type === "tool_execution_start" && ev.toolName) {
		onProgress(`→ ${summarizeToolCall(ev.toolName, ev.args)}`);
	} else if (ev.type === "turn_start") {
		const n = nextTurn();
		if (n > 1) onProgress(`turn ${n}`);
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
		if (event.type === "message_end" && event.message?.role === "assistant") {
			// Keep the LAST NON-EMPTY assistant text — never overwrite with empty,
			// so a trailing tool-call-only turn doesn't discard the control block
			// emitted in an earlier turn.
			const t = (event.message.content ?? [])
				.filter((p) => p.type === "text" && typeof p.text === "string")
				.map((p) => p.text as string)
				.join("");
			if (t) text = t;
			const m = (event.message as { model?: string }).model;
			if (m) model = m;
		}
	}
	return { text, model };
}
