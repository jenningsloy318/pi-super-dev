/**
 * In-process specialist execution via the pi SDK (`createAgentSession`).
 *
 * This is the alternative to {@link spawnAgent} (raw `pi` subprocess). It runs a
 * specialist in-process, in-memory, and captures its result via a
 * `structured_output` tool (schema-validated) instead of parsing `<control>`
 * text from subprocess stdout. Same return contract as spawnAgent
 * ({@link SpawnResult}) so the workflow engine is unchanged.
 *
 * Why: the subprocess path carried a whole class of bugs (spawn ENOENT,
 * RangeError on stdout buffering, <control> parse fragility, process timeouts).
 * The session path uses the same `@earendil-works/pi-coding-agent` SDK we
 * already peer-depend on — no new dependency — and gets structured output,
 * abort, and host config reuse (auth/model) for free.
 *
 * Select at runtime via `ctx.agent` (see workflow.ts): backend "session" uses
 * this; "subprocess" uses spawnAgent.
 */

import {
	createAgentSession,
	createCodingTools,
	defineTool,
	getAgentDir,
	type ToolDefinition,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { loadAgentPrompt } from "./agents.ts";
import { extractControl } from "./control.ts";
import { sanitizeSlug } from "./setup.ts";
import type { AgentProgress, SpawnResult } from "./types.ts";

export interface SessionAgentOptions {
	agent: string;
	prompt: string;
	cwd: string;
	model?: string;
	signal?: AbortSignal;
	id?: string;
	timeoutMs?: number;
	onProgress?: AgentProgress;
}

/**
 * Permissive schema: the specialist's control object varies per stage
 * (docPath/featureName/acCount for requirements, verdict/findings for review,
 * etc.), so accept any object. Pi validates `params` is an object before the
 * tool runs; we trust the shape per stage.
 */
const CONTROL_SCHEMA = Type.Object(
	{ summary: Type.Optional(Type.String()) },
	{ additionalProperties: true },
);

interface Capture {
	called: boolean;
	value: unknown;
}

/** Build the terminating structured_output tool that captures the result. */
function structuredOutputTool(capture: Capture): ToolDefinition {
	return defineTool({
		name: "structured_output",
		label: "Structured Output",
		description: "Return the final result object for this task — the fields the task requested.",
		promptSnippet: "Return final machine-readable result",
		promptGuidelines: [
			"structured_output is the final answer channel; call it exactly once when the task is complete.",
			"Do not write a prose final answer after calling structured_output.",
		],
		parameters: CONTROL_SCHEMA,
		async execute(_toolCallId, params) {
			capture.value = params;
			capture.called = true;
			return {
				content: [{ type: "text", text: "Structured output received." }],
				details: params,
				terminate: true,
			};
		},
	});
}

/** Live progress forwarding from session events → the sink. Session events
 *  nest streaming under `message_update.assistantMessageEvent` (text_delta /
 *  text_end carry `partial.content` with the accumulated block text); tool calls
 *  arrive as top-level `tool_execution_start`. Text partials reset per message
 *  block, so finalizing at each tool call doesn't duplicate prefixes. */
function forwardProgress(session: { subscribe(listener: (e: unknown) => void): () => void }, onProgress: AgentProgress): () => void {
	let turns = 0;
	let lastText = ""; // dedup: only forward text when it changes; reset per tool block
	return session.subscribe((event: unknown) => {
		const e = event as { type?: string; toolName?: string; args?: Record<string, unknown>; assistantMessageEvent?: { type?: string; partial?: { content?: Array<{ type: string; text?: string }> } } };
		if (!e?.type) return;
		if (e.type === "tool_execution_start" && e.toolName) {
			lastText = "";
			onProgress.event(`→ ${summarize(e.toolName, e.args)}`);
		} else if (e.type === "turn_start") {
			if (++turns > 1) onProgress.event(`turn ${turns}`);
		} else if (e.type === "message_update") {
			const a = e.assistantMessageEvent;
			if (a?.type === "text_delta" || a?.type === "text_end") {
				const text = (a.partial?.content ?? []).filter((p) => p.type === "text").map((p) => p.text ?? "").join("");
				const clean = text.replace(/<control>[\s\S]*?<\/control>/gi, "").trim();
				if (clean && clean !== lastText) {
					lastText = clean;
					onProgress.text(clean.slice(0, 600));
				}
			}
		}
	});
}

function summarize(name: string, args: Record<string, unknown> | undefined): string {
	const a = args ?? {};
	switch (name) {
		case "write": case "edit": case "read": return `${name} ${a.path ?? a.file_path ?? ""}`;
		case "bash": return `$ ${String(a.command ?? "").split("\n")[0].slice(0, 72)}`;
		case "ffgrep": case "fffind": return `${name} "${a.pattern ?? ""}"`;
		default: return name === "structured_output" ? "structured_output ✓" : name;
	}
}

function lastAssistantText(messages: Array<{ role?: string; content?: Array<{ type: string; text?: string }> }>): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		if (m?.role !== "assistant" || !Array.isArray(m.content)) continue;
		const t = m.content.filter((p) => p.type === "text" && typeof p.text === "string").map((p) => p.text as string).join("");
		if (t.trim()) return t;
	}
	return "";
}

/** Ask the model for a concise 2-5 word kebab-case slug summarizing the task.
 *  Minimal session: no coding tools, only a structured_output tool — fast and
 *  cheap. Returns "" on any failure/timeout so the caller can fall back to the
 *  deterministic slugifyTask. */
export async function summarizeSlug(task: string, cwd: string, opts: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<string> {
	const timeoutMs = opts.timeoutMs ?? 20_000;
	const capture: Capture = { called: false, value: undefined };
	const agentDir = getAgentDir();
	let session;
	try {
		({ session } = await createAgentSession({
			cwd,
			agentDir,
			sessionManager: SessionManager.inMemory(cwd),
			settingsManager: SettingsManager.create(cwd, agentDir),
			customTools: [defineTool({
				name: "structured_output",
				label: "Slug",
				description: "Return the summary slug.",
				promptSnippet: "Return the slug",
				promptGuidelines: ["Call structured_output once with the slug."],
				parameters: Type.Object({ slug: Type.String() }),
				async execute(_id, params) { capture.value = params; capture.called = true; return { content: [{ type: "text", text: "ok" }], details: params, terminate: true }; },
			})],
		}));
	} catch {
		return "";
	}
	const timer = setTimeout(() => { try { void session.abort(); } catch { /* ignore */ } }, timeoutMs);
	const onAbort = () => void session.abort();
	opts.signal?.addEventListener("abort", onAbort, { once: true });
	try {
		await session.prompt(`Summarize this software task into a concise 2-5 word kebab-case slug (lowercase, words joined by single hyphens, no articles or filler words like "implement/add/feature"). Task:\n"""${task}"""\nCall structured_output with {slug}.`);
	} catch { /* timeout/abort → fallback */ }
	clearTimeout(timer);
	opts.signal?.removeEventListener("abort", onAbort);
	session.dispose();
	const raw = capture.called ? String((capture.value as { slug?: unknown })?.slug ?? "") : "";
	return sanitizeSlug(raw);
}

/** Run a specialist in-process and return its result (SpawnResult contract). */
export async function runAgentViaSession(opts: SessionAgentOptions): Promise<SpawnResult> {
	const systemPrompt = loadAgentPrompt(opts.agent);
	const capture: Capture = { called: false, value: undefined };
	const timeoutMs = opts.timeoutMs ?? 300_000;

	const agentDir = getAgentDir();
	const { session } = await createAgentSession({
		cwd: opts.cwd,
		agentDir,
		sessionManager: SessionManager.inMemory(opts.cwd),
		settingsManager: SettingsManager.create(opts.cwd, agentDir),
		customTools: [...createCodingTools(opts.cwd), structuredOutputTool(capture)],
	});

	const unsub = opts.onProgress ? forwardProgress(session, opts.onProgress) : undefined;
	let timedOut = false;
	const onAbort = () => void session.abort();
	const timer = setTimeout(() => {
		timedOut = true;
		try { void session.abort(); } catch { /* ignore */ }
	}, timeoutMs);
	opts.signal?.addEventListener("abort", onAbort, { once: true });

	try {
		const task = [
			systemPrompt,
			"",
			"## Task",
			opts.prompt,
			"",
			"## Final output",
			"When the task is complete, call the `structured_output` tool exactly once with an object containing the fields requested above (docPath/featureName/..., verdict/findings/..., etc.). Do not emit a prose final answer after that.",
		].join("\n");
		try {
			await session.prompt(task);
		} catch (err) {
			// abort (timeout or signal) rejects prompt; fall through to capture partial.
			if (!timedOut && !opts.signal?.aborted) throw err;
		}
		const text = lastAssistantText(session.messages as Parameters<typeof lastAssistantText>[0]);
		const control = capture.called ? (capture.value as Record<string, unknown>) : extractControl(text);
		return { text, control: control ?? null, error: timedOut ? `timed out after ${Math.round(timeoutMs / 1000)}s${capture.called ? " (structured_output captured before abort)" : ""}` : undefined };
	} catch (err) {
		return { text: "", control: null, error: err instanceof Error ? err.message : String(err) };
	} finally {
		clearTimeout(timer);
		opts.signal?.removeEventListener("abort", onAbort);
		unsub?.();
		session.dispose();
	}
}
