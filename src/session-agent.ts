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
import { Type, type TSchema } from "typebox";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getTracesDir } from "./render/super-dev-dir.ts";
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
	/** Control keys the caller expects in structured_output (declares them in the
	 *  tool schema so the model fills them). When omitted, a fully permissive
	 *  schema is used. Derived from the prompt by workflow.ts. */
	controlKeys?: string[];
	schema?: unknown;
	onProgress?: AgentProgress;
}

/** Build the structured_output schema. When `keys` is non-empty, each key is
 *  DECLARED (Optional, Any) so the model treats it as part of the contract and
 *  fills it — this is the fix for the requirements-gate failure, where a
 *  schema that declared only `summary` made GLM return only `summary`. Keys
 *  stay Optional so tool validation never rejects a partially-filled object;
 *  completeness is enforced by the corrective re-prompt below. */
function controlSchema(keys: string[]) {
	const props: Record<string, ReturnType<typeof Type.Any>> = {};
	for (const k of keys) props[k] = Type.Optional(Type.Any());
	return Type.Object(props, { additionalProperties: true });
}

/** Which declared keys are missing/blank in the captured control object. */
export function missingKeys(captured: Record<string, unknown> | null | undefined, keys: string[]): string[] {
	if (!captured) return keys;
	return keys.filter((k) => {
		const v = captured[k];
		return v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0);
	});
}

interface Capture {
	called: boolean;
	value: unknown;
}

/** Build the terminating structured_output tool that captures the result.
 *  The schema DECLARES the expected keys (see controlSchema) so the model
 *  fills them instead of dumping everything into one field. */
function structuredOutputTool(capture: Capture, keys: string[], schema?: unknown): ToolDefinition {
	const fieldList = keys.length ? keys.join(", ") : "the fields the task requested";
	return defineTool({
		name: "structured_output",
		label: "Structured Output",
		description: `Return the final result object. It MUST include every one of these keys: ${fieldList}.`,
		promptSnippet: "Return final machine-readable result",
		promptGuidelines: [
			`structured_output is the final answer channel; call it exactly once when the task is complete. Your object MUST contain ALL of: ${fieldList}.`,
			"Do not write a prose final answer after calling structured_output.",
		],
		parameters: (schema as TSchema | undefined) ?? controlSchema(keys),
		async execute(_toolCallId, params) {
			capture.value = { ...((capture.value ?? {}) as Record<string, unknown>), ...(params as Record<string, unknown>) };
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
					onProgress.text(clean);
				}
			}
		}
	});
}

function summarize(name: string, args: Record<string, unknown> | undefined): string {
	const a = args ?? {};
	switch (name) {
		case "write": case "edit": case "read": return `${name} ${a.path ?? a.file_path ?? ""}`;
		case "bash": return `$ ${String(a.command ?? "").split("\n")[0]}`;
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

/** Run a specialist in-process and return its result (SpawnResult contract).
 *  Per-stage `controlKeys` are declared in the structured_output schema so the
 *  model fills them. If the first turn omits any, a single corrective re-prompt
 *  is sent IN THE SAME SESSION (context preserved) before giving up — this is
 *  what turns the old "gate failed after 3 attempts" into a self-healing step.
 *  Set SUPER_DEV_DEBUG=1 to dump the full per-agent message trace to a temp
 *  file (sessions are otherwise in-memory and unobservable). */
export async function runAgentViaSession(opts: SessionAgentOptions): Promise<SpawnResult> {
	const systemPrompt = loadAgentPrompt(opts.agent);
	const keys = opts.controlKeys ?? [];
	const capture: Capture = { called: false, value: undefined };
	const timeoutMs = opts.timeoutMs ?? 480_000;

	const agentDir = getAgentDir();
	const { session } = await createAgentSession({
		cwd: opts.cwd,
		agentDir,
		sessionManager: SessionManager.inMemory(opts.cwd),
		settingsManager: SettingsManager.create(opts.cwd, agentDir),
		customTools: [...createCodingTools(opts.cwd), structuredOutputTool(capture, keys, opts.schema)],
	});

	const unsub = opts.onProgress ? forwardProgress(session, opts.onProgress) : undefined;
	let timedOut = false;
	const onAbort = () => void session.abort();
	const timer = setTimeout(() => {
		timedOut = true;
		try { void session.abort(); } catch { /* ignore */ }
	}, timeoutMs);
	opts.signal?.addEventListener("abort", onAbort, { once: true });

	const finalOutputLine = keys.length
		? `When the task is complete, call the \`structured_output\` tool exactly once with an object containing ALL of these keys: ${keys.join(", ")}. Do not omit any. Do not emit a prose final answer after that.`
		: "When the task is complete, call the `structured_output` tool exactly once with an object containing the fields requested above. Do not emit a prose final answer after that.";
	// Delivery discipline — the systemic fix for the recurring "agent explores for
	// 10-27 tool calls then times out before writing" pattern. The ported agent
	// prompts demand Claude-grade exhaustive verification; glm is slower and runs
	// out of time. This preamble overrides that: bound exploration, write early.
	const deliveryDiscipline = [
		"## Delivery discipline (OVERRIDES any contrary instruction above)",
		"You have a LIMITED time budget. The ONLY deliverable that matters is the written document + your structured_output call.",
		"- Explore with AT MOST ~6 tool calls total (read/bash/grep/web). You do NOT need to read every file, run the full test suite, or verify every claim independently.",
		"- Never re-read a file you already read. Never loop on self-auditing, self-scoring, or revision.",
		"- START WRITING the document once you have the gist — well before you feel 'done' exploring. Written-but-imperfect beats thorough-but-unfinished (a timeout produces NOTHING).",
		"- After writing, immediately call structured_output and STOP.",
	].join("\n");
	const task = [systemPrompt, "", "## Task", opts.prompt, "", deliveryDiscipline, "", "## Final output", finalOutputLine].join("\n");

	let correctiveNote = "";
	try {
		try {
			await session.prompt(task);
		} catch (err) {
			if (!timedOut && !opts.signal?.aborted) throw err;
		}

		// Self-heal: ONLY when the model actually called structured_output but
		// omitted declared keys, send ONE corrective turn in the same session
		// (same context, same files written) naming exactly what's missing. If it
		// never called the tool, a "you omitted keys" message would be a false
		// premise — leave that to the gate's cold retry instead.
		const afterFirst = capture.called ? (capture.value as Record<string, unknown> | undefined) : undefined;
		const missing = missingKeys(afterFirst, keys);
		if (capture.called && missing.length > 0 && !timedOut && !opts.signal?.aborted) {
			correctiveNote = `corrective re-prompt (missing: ${missing.join(", ")})`;
			opts.onProgress?.event(`↻ ${opts.id ?? opts.agent}: ${correctiveNote}`);
			const fix = `Your previous structured_output was missing required keys: ${missing.join(", ")}. Call structured_output AGAIN, this time with ALL of these keys filled from the work you already did: ${keys.join(", ")}. Do not redo the work — just return the complete object.`;
			try {
				await session.prompt(fix);
			} catch (err) {
				if (!timedOut && !opts.signal?.aborted) throw err;
			}
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
		if (process.env.SUPER_DEV_DEBUG) dumpTrace(opts, keys, capture, correctiveNote, session.messages);
		session.dispose();
	}
}

/** Write the full in-memory message trace to a temp file. The session backend
 *  keeps everything in memory (SessionManager.inMemory), so without this there
 *  are zero logs to debug a failed/garbled agent run. */
function dumpTrace(opts: SessionAgentOptions, keys: string[], capture: Capture, correctiveNote: string, messages: unknown): void {
	try {
		const dir = getTracesDir();
		mkdirSync(dir, { recursive: true });
		const safe = (opts.id ?? opts.agent).replace(/[^A-Za-z0-9_.-]+/g, "_");
		const file = join(dir, `${Date.now()}-${safe}.json`);
		writeFileSync(file, JSON.stringify({
			agent: opts.agent,
			id: opts.id,
			cwd: opts.cwd,
			controlKeys: keys,
			structuredOutputCalled: capture.called,
			structuredOutputValue: capture.value,
			correctiveNote,
			messages,
		}, null, 2));
	} catch { /* best-effort */ }
}
