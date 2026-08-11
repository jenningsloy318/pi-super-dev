/**
 * Spawns `pi` child processes to run specialist agents — the single primitive
 * that replaces pi-workflow's agent engine. Verified invocation:
 *
 *   pi --mode json -p --no-session --no-skills --no-extensions --no-context-files --no-prompt-templates \
 *      --exclude-tools super_dev \
 *      [--model <provider/id>] --system-prompt <temp-file> "Task: <prompt>"
 *
 * stdout is newline-delimited JSON; the final assistant text is in the last
 * `{"type":"message_end","message":{"role":"assistant",...}}` event.
 */

import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { loadAgentPrompt } from "./agents.ts";
import { extractControl, missingControlKeys } from "./control.ts";
import { renderRetryFeedbackBlock, type RetryFeedback } from "./retry-feedback.ts";
import { safetyPreamble } from "./safety.ts";
import type { AgentAccessMode, AgentProgress, SpawnResult } from "./types.ts";

/** Agents that drive a browser for UI testing. They receive the `browser_execute`
 *  tool by explicitly loading pi-browser-cdp-extension via `-e` while ambient
 *  extension discovery stays disabled. Recursion is prevented by
 *  `--exclude-tools super_dev` (this extension's own spawner tool stays
 *  uncallable). Browser connection uses AUTO-DISCOVERY —
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
 *  the parent's in-process session. Ambient extensions stay disabled; these
 *  web/MCP extensions are the only role extensions attached via repeatable
 *  `-e <path>`. Recursion is prevented by
 *  `--exclude-tools super_dev` (the spawner tool stays uncallable); all other
 *  ambient extension tools remain unavailable. */
const WEB_RESEARCH_AGENTS = new Set(["research-agent"]);

export function needsWebResearch(agent: string): boolean {
	return WEB_RESEARCH_AGENTS.has(agent);
}

/** The installed extensions a research agent explicitly loads via `-e`. Order
 *  is irrelevant; each is resolved to its on-disk entry by researchExtensions(). */
const RESEARCH_EXTENSION_PACKAGES = ["pi-web-access", "pi-mcp-adapter"];
const BROWSER_EXTENSION_PACKAGES = ["pi-browser-cdp-extension"];

function piAgentDir(): string {
	return process.env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), ".pi", "agent");
}

function safeIsFile(path: string): boolean {
	try { return statSync(path).isFile(); } catch { return false; }
}

function safeIsDirectory(path: string): boolean {
	try { return statSync(path).isDirectory(); } catch { return false; }
}

function packageRoot(pkg: string, agentDir: string): string {
	return join(agentDir, "npm", "node_modules", pkg);
}

function readPiExtensionManifestEntries(root: string): string[] {
	try {
		const raw = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { pi?: { extensions?: unknown } };
		const entries = raw.pi?.extensions;
		return Array.isArray(entries)
			? entries.filter((e): e is string => typeof e === "string").map((e) => e.trim()).filter((e) => e.length > 0)
			: [];
	} catch {
		return [];
	}
}

function resolveExtensionPath(root: string, relativePath: string): string[] {
	const full = join(root, relativePath);
	if (safeIsFile(full)) return [full];
	if (!safeIsDirectory(full)) return [];
	try {
		return readdirSync(full)
			.filter((name) => /\.(?:ts|mjs|js|cjs)$/i.test(name))
			.map((name) => join(full, name))
			.filter((path) => safeIsFile(path))
			.sort();
	} catch {
		return [];
	}
}

/** Resolve every Pi extension entry exposed by an installed package's
 *  package.json `pi.extensions` manifest. Falls back to root index.* for older
 *  packages. Never throws. */
export function resolveExtensionEntries(pkg: string, agentDir: string): string[] {
	const root = packageRoot(pkg, agentDir);
	const manifestEntries = readPiExtensionManifestEntries(root).flatMap((entry) => resolveExtensionPath(root, entry));
	if (manifestEntries.length > 0) return manifestEntries;
	for (const fallback of ["index.ts", "index.mjs", "index.js", "dist/index.js"]) {
		const candidate = join(root, fallback);
		if (safeIsFile(candidate)) return [candidate];
	}
	return [];
}

/** Resolve an installed pi extension package to its loadable entry file, or null
 *  when it isn't installed. Uses pi's standard agent-dir npm layout
 *  (`<agentDir>/npm/node_modules/<pkg>`). Kept pure (agentDir injected) so it is
 *  unit-testable against a temp fixture. Never throws. */
export function resolveExtensionEntry(pkg: string, agentDir: string): string | null {
	return resolveExtensionEntries(pkg, agentDir)[0] ?? null;
}

/** Resolve the research extensions' entry paths (pi-web-access + pi-mcp-adapter)
 *  from the pi agent dir. Missing packages are silently skipped so a partial
 *  install degrades gracefully (the agent still gets whatever loaded). */
export function researchExtensions(): string[] {
	const agentDir = piAgentDir();
	return RESEARCH_EXTENSION_PACKAGES
		.flatMap((p) => resolveExtensionEntries(p, agentDir));
}

/** Resolve browser automation extensions from the pi agent dir. */
export function browserExtensions(): string[] {
	const agentDir = piAgentDir();
	return BROWSER_EXTENSION_PACKAGES.flatMap((p) => resolveExtensionEntries(p, agentDir));
}

export function extensionsForAgent(agent: string): string[] {
	const packages = [
		...(needsWebResearch(agent) ? RESEARCH_EXTENSION_PACKAGES : []),
		...(isBrowserAgent(agent) ? BROWSER_EXTENSION_PACKAGES : []),
	];
	const agentDir = piAgentDir();
	return packages.flatMap((p) => resolveExtensionEntries(p, agentDir));
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
	accessMode?: AgentAccessMode;
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
	/** Required top-level keys in the subprocess <control> block. The subprocess
	 *  backend cannot pass a structured_output schema, so it appends an explicit
	 *  text contract and does one corrective retry when these keys are missing. */
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

function normalizedControlKeys(keys: string[] | undefined): string[] {
	return Array.from(new Set((keys ?? []).map((k) => k.trim()).filter((k) => /^[A-Za-z_][\w]*$/.test(k))));
}

function controlTemplate(keys: string[]): string {
	const obj: Record<string, string> = {};
	for (const key of keys) obj[key] = "FILL_ME";
	return JSON.stringify(obj);
}

export function buildSubprocessTaskPrompt(prompt: string, controlKeys: string[] | undefined): string {
	const keys = normalizedControlKeys(controlKeys);
	if (keys.length === 0) return prompt;
	return [
		prompt,
		"",
		"## Required Final Control Output",
		"Your final assistant message MUST include one valid machine-readable control block.",
		`The block MUST be exactly valid JSON inside <control>...</control> and MUST include these top-level keys: ${keys.join(", ")}.`,
		"Do not put comments, markdown fences, or prose inside the <control> block.",
		`Template: <control>${controlTemplate(keys)}</control>`,
	].join("\n");
}

function controlError(control: Record<string, unknown> | null, keys: string[]): string | undefined {
	const missing = missingControlKeys(control, keys);
	if (missing.length === 0) return undefined;
	return control
		? `missing required control keys: ${missing.join(", ")}`
		: `agent produced no control object; missing required control keys: ${missing.join(", ")}`;
}

function withControlError(result: SpawnResult, keys: string[]): SpawnResult {
	const err = controlError(result.control, keys);
	return err && !result.error ? { ...result, error: err } : result;
}

function compactPreviousOutput(text: string, maxChars = 12_000): string {
	if (text.length <= maxChars) return text;
	return `[previous output truncated to last ${maxChars} chars]\n${text.slice(-maxChars)}`;
}

function buildSubprocessCorrectivePrompt(originalPrompt: string, previous: SpawnResult, keys: string[]): string {
	const missing = missingControlKeys(previous.control, keys);
	const feedback: RetryFeedback = {
		stage: "agent-subprocess",
		gate: "required-control-output",
		location: "final assistant message <control> block",
		observed: previous.control ? "control block was present but missing required keys" : "agent produced no control object",
		expected: `valid <control> JSON containing required keys: ${keys.join(", ")}`,
		missing,
		nextAction: "Use the files and artifacts already produced in this working tree. Return a final assistant message with a valid <control> JSON block containing every required key.",
	};
	return [
		originalPrompt,
		"",
		renderRetryFeedbackBlock([feedback], "Corrective Retry"),
		"",
		"## Previous Assistant Output",
		compactPreviousOutput(previous.text || "(empty)"),
	].join("\n");
}

export async function spawnAgent(opts: SpawnAgentOptions): Promise<SpawnResult> {
	const systemPrompt = `${safetyPreamble()}\n\n---\n\n${loadAgentPrompt(opts.agent)}`;
	const tempDir = mkdtempSync(join(tmpdir(), "super-dev-agent-"));
	const promptPath = join(tempDir, "agent.md");
	writeFileSync(promptPath, systemPrompt, { mode: 0o600 });

	try {
		const requiredKeys = normalizedControlKeys(opts.controlKeys);
		const roleExtensions = extensionsForAgent(opts.agent);
		const timeoutMs = opts.timeoutMs ?? defaultAgentTimeoutMs(opts.agent);
		const label = opts.id ?? opts.agent;
		const args = buildSpawnArgs(opts, promptPath, roleExtensions);
		opts.onProgress?.event(`subprocess ${label}: spawn timeout=${timeoutMs}ms cwd=${opts.cwd} roleExtensions=${roleExtensions.length ? roleExtensions.join(", ") : "(none)"} argv=${summarizeSpawnArgs(args)}`);
		const first = await runPi(args, opts.cwd, opts.signal, label, timeoutMs, opts.onProgress);
		const firstError = controlError(first.control, requiredKeys);
		if (!firstError || first.error || opts.signal?.aborted) return withControlError(first, requiredKeys);

		opts.onProgress?.event(`↻ ${label}: corrective subprocess retry (${firstError})`);
		const retryOpts: SpawnAgentOptions = {
			...opts,
			prompt: buildSubprocessCorrectivePrompt(opts.prompt, first, requiredKeys),
		};
		const retryArgs = buildSpawnArgs(retryOpts, promptPath, roleExtensions);
		opts.onProgress?.event(`subprocess ${label}: corrective retry argv=${summarizeSpawnArgs(retryArgs)}`);
		const retry = await runPi(retryArgs, opts.cwd, opts.signal, label, timeoutMs, opts.onProgress);
		return withControlError(retry, requiredKeys);
	} finally {
		rmSync(tempDir, { recursive: true, force: true });
	}
}

function summarizeSpawnArgs(args: string[]): string {
	const redacted = args.map((arg, index) => {
		if (index === args.length - 1 && arg.startsWith("Task: ")) return `Task: [prompt ${arg.length} chars]`;
		return arg;
	});
	return redacted.join(" ");
}

/**
 * Build the full argv vector for a specialist spawn, INCLUDING the executable
 * as element 0. (Extracted so the command resolution is unit-testable — a
 * previous version dropped `command` and tried to exec "--mode", causing
 * `spawn --mode ENOENT` on every single agent spawn.)
 *
 * Spawned specialists run isolated from ambient Pi resources: no skills, no
 * extensions, and no AGENTS.md/CLAUDE.md context files. Role-specific extensions
 * are supplied only through explicit `-e` paths. This prevents installed tools
 * such as pi-subagents from discovering ~/.pi/agent/agents or project agents and
 * keeps this repository's agents/<name>.md as the sole role definition.
 */
export function buildSpawnArgs(opts: SpawnAgentOptions, promptPath: string, extraExtensions: string[] = []): string[] {
	const { command, args: prefix } = resolvePiBinary();
	const args = [
		command, // ← the executable ("pi" on PATH, or `node` re-invoking the host entry)
		...prefix,
		"--mode", "json", "-p", "--no-session", "--no-skills", "--no-extensions", "--no-context-files", "--no-prompt-templates",
	];
	// `--no-extensions` disables ambient discovery; explicit `-e` role extensions
	// still load, per pi CLI semantics.
	for (const ext of extraExtensions) args.push("-e", ext);
	const excludedTools = opts.accessMode === "source-read-only" ? "super_dev,edit,write" : "super_dev";
	args.push("--exclude-tools", excludedTools);
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
	args.push(`Task: ${buildSubprocessTaskPrompt(opts.prompt, opts.controlKeys)}`);
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
			onProgress?.event(`subprocess ${label}: aborted by parent signal; terminating child pi`);
			try { child.kill("SIGTERM"); } catch { /* ignore */ }
		};
		signal?.addEventListener("abort", onAbort, { once: true });
		const timer = setTimeout(() => {
			timedOut = true;
			onProgress?.event(`subprocess ${label}: timeout after ${timeoutMs}ms; terminating child pi`);
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
			// Stay bounded on a runaway line, but keep the TAIL rather than dropping the
			// whole buffer: a >LINE_CAP line (e.g. a huge message_end) would otherwise
			// discard the partial final assistant text, leaving extractControl to run on
			// stale earlier output. Keeping the tail lets the next newline still close a line.
			if (lineBuf.length > LINE_CAP) lineBuf = lineBuf.slice(-LINE_CAP);
		});
		child.stderr.on("data", (c: Buffer) => {
			stderrBuf += c.toString("utf8");
			if (stderrBuf.length > STDERR_CAP) stderrBuf = stderrBuf.slice(stderrBuf.length - STDERR_CAP);
		});
		child.on("error", (err) => {
			cleanup();
			const pathPreview = (process.env.PATH ?? "").split(":").slice(0, 8).join(":");
			reject(new Error(`super-dev [${label}]: failed to spawn pi: ${err.message}; cwd=${cwd}; PATH=${pathPreview || "(empty)"}`));
		});
		child.on("close", (code) => {
			cleanup();
			const tail = stderrBuf.trim().split("\n").slice(-3).join(" | ");
			onProgress?.event(`subprocess ${label}: close exit=${code ?? "signal"} timedOut=${timedOut ? "yes" : "no"}${tail ? ` stderrTail=${tail}` : ""}`);
			if (aborted) { resolve({ text: "", control: null, error: "aborted" }); return; }
			// lastAssistantText already holds the last non-empty assistant text
			// (resilient to a trailing tool-call turn or a mid-stream kill).
			if (lastAssistantText) {
				resolve({ text: lastAssistantText, control: extractControl(lastAssistantText), model: lastModel, error: timedOut ? `timed out after ${timeoutMs}ms (used partial output)` : undefined });
				return;
			}
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
function compactArg(value: unknown, max = 180): string {
	const s = typeof value === "string" ? value : value == null ? "" : JSON.stringify(value);
	return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function firstArg(args: Record<string, unknown>, keys: string[]): string {
	for (const key of keys) {
		const value = args[key];
		if (value !== undefined && value !== null && String(value).trim()) return compactArg(value);
	}
	return "";
}

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
		case "web_search": {
			const query = firstArg(a, ["query", "q", "search", "term"]);
			return query ? `${name} query="${query}"` : name;
		}
		case "fetch_content": {
			const url = firstArg(a, ["url", "uri", "link"]);
			return url ? `${name} url="${url}"` : name;
		}
		case "get_search_content": {
			const id = firstArg(a, ["id", "resultId", "contentId"]);
			const url = firstArg(a, ["url", "uri", "link"]);
			const query = firstArg(a, ["query", "q"]);
			const detail = id ? `id="${id}"` : url ? `url="${url}"` : query ? `query="${query}"` : "";
			return detail ? `${name} ${detail}` : name;
		}
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
