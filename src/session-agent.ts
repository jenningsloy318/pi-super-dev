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
	ModelRuntime,
	type ToolDefinition,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Type, IsObject, IsOptional, type TSchema } from "typebox";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getTracesDir } from "./render/super-dev-dir.ts";
import { loadAgentPrompt } from "./agents.ts";
import { extractControl, missingControlKeys } from "./control.ts";
import { sanitizeSlug } from "./setup.ts";
import { createSafetyExtensionFactory } from "./safety.ts";
import { defaultAgentTimeoutMs, isCodeWritingAgent, resolveExplicitThinking, resolveModel, resolveThinking, summarizeToolCall, thinkingForAgent, type ThinkingLevel } from "./pi-spawn.ts";
import type { AgentProgress, SpawnResult } from "./types.ts";

// ─────────────────────────────────────────────────────────────────────────────
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

// ─── Phase 1 (Feature 1): session-backend model inheritance ──────────────────

/** The `Model<any>` createAgentSession's `model` option expects, derived from
 *  its own typed signature so we never reach for the (transitive)
 *  @earendil-works/pi-ai Model type directly. */
export type SessionModelOption = NonNullable<NonNullable<Parameters<typeof createAgentSession>[0]>["model"]>;

/** Module-level cache for the resolved ModelRuntime (AR-03). The model
 *  catalog does not change within a run, so `create()` is resolved ONCE per
 *  process and shared across every session-backend specialist spawn — it never
 *  pays a per-spawn catalog-resolution cost. The promise is cleared on
 *  rejection so a transient create() failure can be retried by a later spawn. */
let runtimeCache: Promise<ModelRuntime> | undefined;
function getModelRuntime(): Promise<ModelRuntime> {
	if (!runtimeCache) {
		runtimeCache = ModelRuntime.create().catch((err) => {
			runtimeCache = undefined; // allow a later spawn to retry
			throw err;
		});
	}
	return runtimeCache;
}

/** Resolve an EXPLICIT (user/env-supplied) qualified model ref to a Model<any>
 *  for createAgentSession. Provider-scoped ONLY: a qualified "provider/model-id"
 *  resolves via getModel within the named provider; a BARE id (no slash) returns
 *  undefined so createAgentSession falls to the SDK/settings default rather than
 *  ambiguously matching some other provider's same-named model. This mirrors
 *  pi-subagents' rule that a qualified query "never silently switches providers"
 *  (security/cost-sensitive). The INHERITED main-session model is NOT resolved
 *  here — it is passed through WHOLESALE as a Model<any> object (see
 *  runAgentViaSession), avoiding re-resolution entirely. Best-effort, no-throw. */
async function resolveExplicitSessionModel(id: string | undefined): Promise<SessionModelOption | undefined> {
	if (!id) return undefined;
	const slash = id.indexOf("/");
	if (slash < 0) return undefined; // bare explicit id → don't guess; fall to settings default
	const provider = id.slice(0, slash);
	const modelId = id.slice(slash + 1);
	try {
		const runtime = await getModelRuntime();
		return runtime.getModel(provider, modelId) ?? undefined;
	} catch {
		return undefined; // runtime unavailable → SDK/settings default
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
	/** The FULL main-session model object (ctx.model), threaded through RunOptions
	 *  → realAgent.common. Used WHOLESALE — passed directly to createAgentSession
	 *  so the specialist runs on the EXACT model the parent is on (same provider,
	 *  headers, baseUrl). ADDITIVE — loses to an explicit `model` string override
	 *  and to SUPER_DEV_MODEL, but wins over the SDK/settings default. Carrying
	 *  the object (not a bare id) preserves the provider — which is what the prior
	 *  bare-id re-resolution lost (the opencode mis-resolution root cause). */
	inheritedModelObject?: SessionModelOption;
	/** Phase 1 (Feature 1): DEFAULT thinking level inherited from the live main
	 *  session (ctx.thinkingLevel). ADDITIVE — loses to a per-call override and
	 *  to SUPER_DEV_THINKING env, but wins over the role default. */
	inheritedThinking?: ThinkingLevel;
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

/** A built typebox Object as it exists at runtime: the `~kind: 'Object'` shape
 *  carrying the options spread (`additionalProperties`) and the `required` array.
 *  Used to inspect a confirmed Object without leaning on TObject's generic
 *  (over-narrowed) `required` typing. */
type BuiltObject = {
	additionalProperties?: unknown;
	required?: unknown;
	properties?: Record<PropertyKey, unknown>;
};

/** Phase 2 (Feature 2 / SCENARIO-009..013): true ONLY for a typebox Object with
 *  ≥1 required non-Optional key AND `additionalProperties === false`. Gates
 *  `constrainedSampling` so it is NEVER attached to a permissive/open schema
 *  (the all-Optional `controlSchema`, or any unknown-key schema) — those stay
 *  the byte-identical fallback. No-throw on non-schema input. */
export function isStrictCapable(schema: unknown): boolean {
	if (!IsObject(schema)) return false;
	// `IsObject` confirmed `~kind === 'Object'`; read the runtime fields via a
	// single structural cast (NOT `as unknown as`). `additionalProperties` comes
	// from the TypeBox options spread; `required`/`properties` are built fields.
	const obj = schema as BuiltObject;
	if (obj.additionalProperties !== false) return false;
	const required = obj.required;
	if (!Array.isArray(required) || required.length === 0) return false;
	// ≥1 required key whose declared property is NOT Optional.
	return required.some((key) => {
		const prop = obj.properties?.[key];
		return prop != null && !IsOptional(prop);
	});
}

/** Phase 2 (Feature 2): the strict-capable schema variant for stages with
 *  well-defined keys. A CLOSED object (`additionalProperties: false`) with every
 *  key REQUIRED (non-Optional). Values stay Any-typed to preserve the
 *  `controlSchema` value-permissiveness (a numeric/array control value is never
 *  rejected by tool validation) — only the object is closed and the keys are
 *  required, which is exactly what makes it strict-capable. Pass this as
 *  `SessionAgentOptions.schema` to opt a stage into constrained sampling. */
export function strictControlSchema(keys: string[]) {
	const props: Record<string, ReturnType<typeof Type.Any>> = {};
	for (const k of keys) props[k] = Type.Any();
	return Type.Object(props, { additionalProperties: false });
}

/** Which declared keys are missing/blank in the captured control object. */
export function missingKeys(
	captured: Record<string, unknown> | null | undefined,
	keys: string[],
	options: { allowEmptyArraysFor?: Set<string> | string[] | "*" } = {},
): string[] {
	return missingControlKeys(captured, keys, options);
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
		"Your deliverable is COMPLETE STRUCTURED CONTENT via the structured_output tool. The super-dev renderer writes the Markdown document from that object; do NOT hand-write markdown files unless this stage explicitly asks you to.",
		"- Explore with AT MOST ~6 tool calls total (read/bash/grep/web). You do NOT need to read every file, run the full test suite, or verify every claim independently.",
		"- Never re-read a file you already read. Never loop on self-auditing, self-scoring, or revision.",
		"- START composing the structured_output object once you have the gist — well before you feel 'done' exploring. Complete-but-imperfect structured data beats thorough-but-unreturned work (a timeout produces NOTHING).",
		"- Then immediately call structured_output and STOP.",
	].join("\n");
}

export interface Capture {
	called: boolean;
	value: unknown;
}

/** Build the terminating structured_output tool that captures the result.
 *  The schema DECLARES the expected keys (see controlSchema) so the model
 *  fills them instead of dumping everything into one field.
 *
 *  Phase 2 (Feature 2 / SCENARIO-009..013): the effective schema is the
 *  caller-provided schema when given, else the permissive controlSchema
 *  fallback. `constrainedSampling: { type: "json_schema", strict: "prefer" }`
 *  is attached to the ToolDefinition ONLY when the effective schema is
 *  strict-capable (`isStrictCapable`). It is NEVER attached to the permissive
 *  controlSchema (all-Optional + additionalProperties:true) or any open /
 *  unknown-key schema — so the non-capable-provider/permissive-schema path
 *  (`missingKeys()` + the single corrective re-prompt) stays byte-identical as
 *  the fallback. */
export function structuredOutputTool(capture: Capture, keys: string[], schema?: unknown): ToolDefinition {
	const fieldList = keys.length ? keys.join(", ") : "the fields the task requested";
	// The effective schema: caller-provided (may be strict-capable) or the
	// permissive controlSchema fallback (byte-identical to today).
	const effective = (schema as TSchema | undefined) ?? controlSchema(keys);
	const tool: ToolDefinition = defineTool({
		name: "structured_output",
		label: "Structured Output",
		description: `Return the final result object. It MUST include every one of these keys: ${fieldList}.`,
		promptSnippet: "Return final machine-readable result",
		promptGuidelines: [
			`structured_output is the final answer channel; call it exactly once when the task is complete. Your object MUST contain ALL of: ${fieldList}.`,
			"Do not write a prose final answer after calling structured_output.",
		],
		parameters: effective,
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
	// constrainedSampling is attached ONLY when the effective schema is
	// strict-capable — gated here, never on the permissive/open shape.
	if (isStrictCapable(effective)) {
		tool.constrainedSampling = { type: "json_schema", strict: "prefer" };
	}
	return tool;
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
	return name === "structured_output" ? "structured_output ✓" : summarizeToolCall(name, args);
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
 *  what turns the old "gate failed after 5 attempts" into a self-healing step.
 *  Set SUPER_DEV_DEBUG=1 to dump the full per-agent message trace to a temp
 *  file (sessions are otherwise in-memory and unobservable). */
export async function runAgentViaSession(opts: SessionAgentOptions): Promise<SpawnResult> {
	const systemPrompt = loadAgentPrompt(opts.agent);
	const keys = opts.controlKeys ?? [];
	const capture: Capture = { called: false, value: undefined };
	const timeoutMs = opts.timeoutMs ?? defaultAgentTimeoutMs(opts.agent);

	const agentDir = getAgentDir();
	const settingsManager = SettingsManager.create(opts.cwd, agentDir);
	// Keep session-backed specialists on super-dev-owned prompts/resources. The
	// subprocess backend runs with `--no-skills --no-extensions --no-context-files`
	// and a temp system prompt built from agents/<name>.md; mirror that here so
	// ambient packages such as pi-subagents cannot expose tools that discover
	// ~/.pi/agent/agents or project .pi/agents, and AGENTS.md/CLAUDE.md files are
	// not appended to the specialist role.
	const resourceLoader = new DefaultResourceLoader({
		cwd: opts.cwd,
		agentDir,
		settingsManager,
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		systemPrompt,
		appendSystemPromptOverride: () => [],
		agentsFilesOverride: () => ({ agentsFiles: [] }),
		extensionFactories: [createSafetyExtensionFactory()],
	});
	await resourceLoader.reload();
	// Phase 1 (Feature 1): resolve the model + thinking level ONCE with the
	// widened precedence (explicit → SUPER_DEV_* env → INHERITED → role/SDK
	// default). `creationThinking` is the EXPLICIT-OR-INHERITED level (NO
	// role-default fallback) — it reaches createAgentSession ONLY when the main
	// session's level actually resolves, preserving the byte-identical baseline
	// (no creation option) otherwise (SCENARIO-002). `resolvedModel` is
	// best-effort and no-throw: an inherited id that cannot resolve to a Model
	// falls through to the SDK/settings default (SCENARIO-008). The retained
	// applyThinkingLevel is guarded against double-application below (SCENARIO-007).
	const creationThinking = resolveExplicitThinking(opts.thinkingLevel, opts.inheritedThinking);
	// Model resolution (inherit-wholesale): an EXPLICIT override (opts.model /
	// SUPER_DEV_MODEL) is resolved provider-scoped via resolveExplicitSessionModel;
	// otherwise the inherited main-session model object is passed DIRECTLY — no
	// re-resolution, so the specialist uses the parent's exact model (same
	// provider/headers). When neither resolves, createAgentSession omits `model`
	// and uses the SDK/settings default (byte-identical to the pre-inheritance
	// baseline).
	let resolvedModel: SessionModelOption | undefined;
	try {
		const explicitModel = resolveModel(opts.model);
		resolvedModel = explicitModel ? await resolveExplicitSessionModel(explicitModel) : opts.inheritedModelObject;
	} catch {
		resolvedModel = opts.inheritedModelObject;
	}

	const { session } = await createAgentSession({
		cwd: opts.cwd,
		agentDir,
		sessionManager: SessionManager.inMemory(opts.cwd),
		settingsManager,
		resourceLoader,
		customTools: [...createCodingTools(opts.cwd), structuredOutputTool(capture, keys, opts.schema)],
		// Recursion guard remains defense-in-depth: ambient extensions are disabled
		// above, but an explicitly supplied safety factory or future local factory
		// must still never expose this extension's spawner tool to specialists.
		excludeTools: ["super_dev"],
		// Conditionally threaded so a run with NO resolvable model/thinking is
		// byte-identical to today (neither creation option is set — SCENARIO-002/004).
		...(resolvedModel ? { model: resolvedModel } : {}),
		...(creationThinking ? { thinkingLevel: creationThinking } : {}),
	});

	// Phase 2 (Feature 1): best-effort apply the per-agent thinking level — now a
	// SECOND line of defense, since the canonical path is createAgentSession's
	// `thinkingLevel` option. Guarded against double-application: when creation
	// already received the level, do NOT re-apply (SCENARIO-007). When nothing
	// resolved at creation (role-default territory), apply the FULL widened
	// resolution (incl. the role default) best-effort. Tolerant of an older
	// runtime that lacks setThinkingLevel or a model that rejects the level
	// (applyThinkingLevel swallows any throw).
	if (!creationThinking) applyThinkingLevel(session, resolveThinking(opts.agent, opts.thinkingLevel, opts.inheritedThinking));

	const unsub = opts.onProgress ? forwardProgress(session, opts.onProgress) : undefined;
	let timedOut = false;
	const label = opts.id ?? opts.agent;
	opts.onProgress?.event(`session ${label}: start timeout=${timeoutMs}ms cwd=${opts.cwd} controlKeys=${keys.join(",") || "(none)"}`);
	const onAbort = () => {
		opts.onProgress?.event(`session ${label}: aborted by parent signal`);
		void session.abort();
	};
	const timer = setTimeout(() => {
		timedOut = true;
		opts.onProgress?.event(`session ${label}: timeout after ${timeoutMs}ms; aborting agent session`);
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
	const task = ["## Task", opts.prompt, "", deliveryDiscipline, "", "## Final output", finalOutputLine].join("\n");

	let correctiveNote = "";
	try {
		try {
			await session.prompt(task);
		} catch (err) {
			if (!timedOut && !opts.signal?.aborted) throw err;
		}

		// Self-heal #1: when the specialist returns normally without ever calling
		// structured_output, keep the SAME session/context and give it one final,
		// tool-only chance. This catches the real BDD failure mode where the agent
		// read the requirements, stopped after ~30s, and produced neither control nor
		// a rendered doc; pushing that to a cold gate retry wastes minutes and is
		// easy for users to cancel before attempt 2. Do not do this on timeout/abort.
		if (!capture.called && keys.length > 0 && !timedOut && !opts.signal?.aborted) {
			correctiveNote = "corrective re-prompt (no structured_output)";
			opts.onProgress?.event(`↻ ${opts.id ?? opts.agent}: ${correctiveNote}`);
			const fix = `You ended without calling the required structured_output tool. Do not read more files and do not answer in prose. Using the work/context already in this session, call structured_output NOW with ALL of these keys filled: ${keys.join(", ")}.`;
			try {
				await session.prompt(fix);
			} catch (err) {
				if (!timedOut && !opts.signal?.aborted) throw err;
			}
		}

		// Self-heal #2: ONLY when the model actually called structured_output but
		// omitted declared keys, send ONE corrective turn in the same session
		// (same context, same files written) naming exactly what's missing.
		const afterFirst = capture.called ? (capture.value as Record<string, unknown> | undefined) : undefined;
		const emptyArrayOk = new Set(["filesCreated", "filesModified", "filesDeleted"]);
		const missing = missingKeys(afterFirst, keys, { allowEmptyArraysFor: emptyArrayOk });
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
