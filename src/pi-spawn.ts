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

export interface SpawnAgentOptions {
	agent: string;
	prompt: string;
	cwd: string;
	model?: string;
	signal?: AbortSignal;
	id?: string;
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

	const { command, args: prefix } = resolvePiBinary();
	const args = [
		...prefix,
		"--mode", "json", "-p", "--no-session", "--no-skills", "--no-extensions",
		"--tools", AGENT_TOOLS,
		"--system-prompt", promptPath,
	];
	if (opts.model) args.push("--model", opts.model);
	args.push(`Task: ${opts.prompt}`);

	const result = await runPi(args, opts.cwd, opts.signal, opts.id ?? opts.agent);
	rmSync(tempDir, { recursive: true, force: true });
	return result;
}

function runPi(args: string[], cwd: string, signal: AbortSignal | undefined, label: string): Promise<SpawnResult> {
	return new Promise((resolve, reject) => {
		const child = spawn(args[0], args.slice(1), {
			cwd,
			stdio: ["ignore", "pipe", "pipe"],
			env: { ...process.env },
			windowsHide: true,
		});
		let stdoutBuf = "";
		let stderrBuf = "";
		let aborted = false;
		const onAbort = () => {
			aborted = true;
			try { child.kill("SIGTERM"); } catch { /* ignore */ }
		};
		signal?.addEventListener("abort", onAbort, { once: true });

		child.stdout.on("data", (c: Buffer) => { stdoutBuf += c.toString("utf8"); });
		child.stderr.on("data", (c: Buffer) => { stderrBuf += c.toString("utf8"); });
		child.on("error", (err) => {
			signal?.removeEventListener("abort", onAbort);
			reject(new Error(`super-dev [${label}]: failed to spawn pi: ${err.message}`));
		});
		child.on("close", (code) => {
			signal?.removeEventListener("abort", onAbort);
			if (aborted) { resolve({ text: "", control: null, error: "aborted" }); return; }
			const { text, model } = extractFinalAssistant(stdoutBuf);
			if (!text) {
				const tail = stderrBuf.trim().split("\n").slice(-3).join(" | ");
				reject(new Error(`super-dev [${label}]: agent produced no output (exit ${code}).${tail ? ` stderr: ${tail}` : ""}`));
				return;
			}
			resolve({ text, control: extractControl(text), model });
		});
	});
}

interface PiJsonEvent {
	type?: string;
	message?: { role?: string; content?: Array<{ type: string; text?: string }> };
}

function extractFinalAssistant(stdout: string): { text: string; model?: string } {
	let text = "";
	for (const line of stdout.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		let event: PiJsonEvent;
		try { event = JSON.parse(trimmed) as PiJsonEvent; } catch { continue; }
		if (event.type === "message_end" && event.message?.role === "assistant") {
			text = (event.message.content ?? [])
				.filter((p) => p.type === "text" && typeof p.text === "string")
				.map((p) => p.text as string)
				.join("");
		}
	}
	return { text };
}
