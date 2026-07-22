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
	DefaultResourceLoader,
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
import { createSafetyExtensionFactory } from "./safety.ts";
import { defaultAgentTimeoutMs, isCodeWritingAgent, resolveThinking, type ThinkingLevel } from "./pi-spawn.ts";
import type { AgentProgress, SpawnResult } from "./types.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Phase 4 (AC-08 / SCENARIO-017 / SCENARIO-018): session-backend best-effort
// LIVE STEER. The AgentSession handle is created LOCALLY inside
// `runAgentViaSession` (`const { session } = await createAgentSession(...)`)
// and disposed in its `finally` — it is NEVER returned to, or reachable from,
// `makeContext`/`realAgent` or the input-capture path. So live steer is exposed
// ONLY through an additive `onSteer` seam: `runAgentViaSession` hands out a
// no-throw forwarder bound to the live session when it exposes `steer()`, and
// `null` on dispose (or when the session lacks `steer()`). The capture path
// (extension.ts input handler) nudges the currently-running specialist with
// the MOST-RECENT input only — one forward per capture — bounding context
// growth. The Phase-3 queue path (`RunOptions.userSteerProvider`) is the
// GUARANTEED delivery contract for BOTH the session AND subprocess/browser
// backends; live steer is an additive enhancement that never blocks a run.
// ─────────────────────────────────────────────────────────────────────────────

/** A no-throw steer forwarder: bound to a live AgentSession so calling it
 *  nudges the currently-running specialist mid-turn. */
export type SteerForwarder = (text: string) => void;

/** Build a best-effort, no-throw steer forwarder bound to a session handle.
 *  Returns `null` when the handle is absent or has no `steer()` method (the
 *  documented best-effort no-op — the queue path remains the guaranteed
 *  contract). Binds the method back to the handle via `.call` so `this` stays
 *  attached — guards the same class-detachment class of bug the stream-theme
 *  class-theme regression covers. Swallows any throw (AC-09). */
export function makeSteer(handle: unknown): SteerForwarder | null {
	if (handle == null) return null;
	const steer: unknown = (handle as { steer?: unknown }).steer;
	if (typeof steer !== "function") return null;
	const fn = steer as (text: string) => void;
	return (text: string): void => {
		try {
			// `.call(handle, …)` rebinds `this` to the handle so a class-based
			// session (whose steer() reads `this.fgColors` etc.) keeps `this`.
			fn.call(handle, text);
		} catch {
			/* best-effort (AC-09): a throwing live session must never break the capture path */
		}
	};
}

/** A tiny sink holding at most one live steer forwarder, used by a capture
 *  path to nudge the currently-running session specialist with the MOST-RECENT
 *  input only (one forward per capture — bounds context growth, SCENARIO-017).
 *  The accumulating queue is the Phase-3 injection path's job; this path sends
 *  exactly one nudge per capture and never hands the handle a list. */
export interface SteerSink {
	/** Register a live session handle (builds the forwarder via makeSteer). */
	set(handle: unknown): void;
	/** Forward the just-captured (most-recent) input. No-throw no-op when no
	 *  handle is registered (SCENARIO-018). */
	forward(text: string): void;
	/** Unregister the handle (mirrors session.dispose → onSteer(null)). */
	clear(): void;
}

/** Create a fresh SteerSink (no shared state across runs — no leak). */
export function createSteerSink(): SteerSink {
	let forwarder: SteerForwarder | null = null;
	return {
		set(handle: unknown): void {
			forwarder = makeSteer(handle);
		},
		forward(text: string): void {
			if (!forwarder) return;
			try {
				forwarder(text);
			} catch {
				/* defensive (AC-09): makeSteer already swallows, but the sink never propagates */
			}
		},
		clear(): void {
			forwarder = null;
		},
	};
}

/** Best-effort apply a thinking level to a live AgentSession (Phase 2). Calls
 *  `session.setThinkingLevel(level)` guarded by try/catch so an older runtime
 *  that lacks the method (or a model that rejects the level) never breaks the
 *  run. No-ops when `level` is undefined. */
export function applyThinkingLevel(session: unknown, level: ThinkingLevel | undefined): void {
	if (level === undefined) return;
	try {
		const fn = (session as { setThinkingLevel?: unknown } | null | undefined)?.setThinkingLevel;
		if (typeof fn === "function") {
			(fn as (l: ThinkingLevel) => void).call(session, level);
		}
	} catch {
		/* best-effort: older runtimes may lack the method or clamp the level */
	}
}

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
	/** Optional per-agent thinking level (Phase 2). When set, the session backend
	 *  best-effort calls `session.setThinkingLevel(level)` after createAgentSession
	 *  (see applyThinkingLevel). Older runtimes may lack the method — tolerated. */
	thinkingLevel?: ThinkingLevel;
	/** Phase 4 (AC-08 / SCENARIO-017..018): best-effort live-steer seam. When
	 *  provided, `runAgentViaSession` invokes `onSteer` with a no-throw forwarder
	 *  bound to the live AgentSession as soon as the session is created (if it
	 *  exposes `steer()`), and with `null` on dispose (or when the session lacks
	 *  `steer()`). The capture path uses the forwarder to nudge the
	 *  currently-running specialist with the MOST-RECENT input only. When the
	 *  handle is absent (subprocess backend, browser agents, or a session
	 *  without steer()), the Phase-3 queue path is the guaranteed contract for
	 *  BOTH backends — live steer is an additive enhancement only. */
	onSteer?: (fn: SteerForwarder | null) => void;
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

/** Agent-aware delivery discipline preamble (OVERRIDES the ported agent prompts,
 *  which demand Claude-grade exhaustive verification a slow model cannot afford).
 *
 *  Two shapes, because the deliverable differs by role:
 *   - DOC writers (requirements/research/spec/…): deliverable is a document —
 *     bound exploration hard and write early, because a timeout produces nothing.
 *   - CODE writers (implementer/tdd-guide): deliverable is APPLIED source edits.
 *     Capping exploration at ~6 calls starves them (reading one 400+ line file
 *     is already several calls); the fix is to read ENOUGH, then land + verify
 *     edits before the (now larger) clock runs out, and to prefer whole-file
 *     `write` over many fragile exact-match `edit` calls on big files. Framing a
 *     code edit as "writing a document" was the root cause of the recurring
 *     zero-edit / edit-thrash phase failures. */
export function deliveryDisciplineFor(agent: string): string {
	if (isCodeWritingAgent(agent)) {
		return [
			"## Delivery discipline (OVERRIDES any contrary instruction above)",
			"Your deliverable is APPLIED SOURCE-CODE EDITS — real changes to the real files, verified to build — followed by your structured_output call. A plan, an added test alone, or a description of edits you did NOT apply is a FAILURE.",
			"- Read ONLY what you need to edit safely (the target file + the failing test + the types you touch). Do NOT read every file or re-read a file you already read.",
			"- Then APPLY the edits early — well before you feel 'done' exploring. You have a generous but finite budget; an unfinished turn writes NOTHING to disk.",
			"- When a single file needs several changes, prefer ONE whole-file `write` over many `edit` calls. Do NOT thrash on `edit` when its exact-match `oldText` keeps failing (tabs/whitespace); switch to `write` after the first miss. Never hand-patch indentation with `sed`.",
			"- After applying edits, run the build/tests ONCE to confirm, fix any obvious break, then call structured_output and STOP. Do not loop on self-review.",
			"- NEVER end your turn having only explored or only added a test: the source file MUST be modified before you finish.",
		].join("\n");
	}
	return [
		"## Delivery discipline (OVERRIDES any contrary instruction above)",
		"You have a LIMITED time budget. The ONLY deliverable that matters is the written document + your structured_output call.",
		"- Explore with AT MOST ~6 tool calls total (read/bash/grep/web). You do NOT need to read every file, run the full test suite, or verify every claim independently.",
		"- Never re-read a file you already read. Never loop on self-auditing, self-scoring, or revision.",
		"- START WRITING the document once you have the gist — well before you feel 'done' exploring. Written-but-imperfect beats thorough-but-unfinished (a timeout produces NOTHING).",
		"- After writing, immediately call structured_output and STOP.",
	].join("\n");
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
	let lastText = ""; // dedup: only forward text when it changes; reset per tool block
	return session.subscribe((event: unknown) => {
		const e = event as { type?: string; toolName?: string; args?: Record<string, unknown>; assistantMessageEvent?: { type?: string; partial?: { content?: Array<{ type: string; text?: string }> } } };
		if (!e?.type) return;
		if (e.type === "tool_execution_start" && e.toolName) {
			lastText = "";
			onProgress.event(`→ ${summarize(e.toolName, e.args)}`);
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
	const timeoutMs = opts.timeoutMs ?? defaultAgentTimeoutMs(opts.agent);

	const agentDir = getAgentDir();
	const settingsManager = SettingsManager.create(opts.cwd, agentDir);
	// Safety (Gap 4.3): inject a `tool_call` hook that hard-blockks dangerous
	// commands + secret-file overwrites, and suppress ambient global-extension
	// discovery (noExtensions:true). Inline factories still load (verified C9),
	// so the child is both guarded AND deterministic (no user global extensions).
	const resourceLoader = new DefaultResourceLoader({
		cwd: opts.cwd,
		agentDir,
		settingsManager,
		noExtensions: true,
		extensionFactories: [createSafetyExtensionFactory()],
	});
	await resourceLoader.reload();
	const { session } = await createAgentSession({
		cwd: opts.cwd,
		agentDir,
		sessionManager: SessionManager.inMemory(opts.cwd),
		settingsManager,
		resourceLoader,
		customTools: [...createCodingTools(opts.cwd), structuredOutputTool(capture, keys, opts.schema)],
	});

	// Phase 2: best-effort apply the per-agent thinking level, resolved with the
	// same precedence as the subprocess backend (per-call → SUPER_DEV_THINKING →
	// role default). Tolerant of an older runtime that lacks setThinkingLevel or a
	// model that rejects the level (applyThinkingLevel swallows any throw).
	applyThinkingLevel(session, resolveThinking(opts.agent, opts.thinkingLevel));

	// Phase 4 (AC-08 / SCENARIO-017..018): hand out a no-throw live-steer
	// forwarder bound to this session when it exposes `steer()`; otherwise signal
	// `null` (documented best-effort no-op). The capture path nudges the
	// currently-running specialist with the MOST-RECENT input only; the Phase-3
	// queue path is the guaranteed contract for BOTH backends.
	try {
		opts.onSteer?.(makeSteer(session));
	} catch { /* best-effort: never let steer-wiring break a run */ }

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
	// out of time. This preamble overrides that. It is AGENT-AWARE: a doc-writer's
	// deliverable is a document (explore ≤6, write early), but a CODE-writing
	// agent's deliverable is applied source edits (read enough, then land+verify
	// edits before the clock runs out). Applying the doc discipline to the
	// implementer was the root cause of the recurring phase-N zero-edit and
	// edit-thrash failures (see runs 2026-07-20 / 2026-07-22 phase-03).
	const deliveryDiscipline = deliveryDisciplineFor(opts.agent);
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
		// Phase 4: invalidate the live-steer forwarder BEFORE disposing the
		// session so the capture path degrades to a no-op (SCENARIO-018).
		try {
			opts.onSteer?.(null);
		} catch { /* best-effort */ }
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
