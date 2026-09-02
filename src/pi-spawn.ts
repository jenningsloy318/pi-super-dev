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
import { getConfig, superDevEnv } from "./render/super-dev-dir.ts";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadAgentPrompt } from "./agents.ts";
import { agentTerminalLine, newNarrationLines, newUsageStats, accumulateUsage, type LiveUsageStats } from "./progress-lines.ts";
import { DEFAULT_EMPTY_ARRAY_OK as CONTROL_DEFAULT_EMPTY_ARRAY_OK, extractControl, missingControlKeys } from "./control.ts";
import { RpcDriver } from "./rpc-driver.ts";
import { renderRetryFeedbackBlock, type RetryFeedback } from "./retry-feedback.ts";
import { DATA_FENCE_PREAMBLE, fenceUntrusted } from "./fence.ts";
import { safetyPreamble } from "./safety.ts";
import { SO_CAPTURE_ENV, SO_SCHEMA_ENV } from "./subprocess-structured-output.ts";
import type { AgentAccessMode, AgentProgress, ControlObj, SpawnResult } from "./types.ts";

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
	// v0.3.43: judge verdicts are pure analysis (diagnosis + routing) — tiered
	// HIGH so a `:max` parent session cannot inflate them either.
	"judge",
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

/** v0.3.43 throughput root cause (run-pair forensics 2026-08-30): binary/small
 *  classification roles were running at the INHERITED main-session thinking
 *  level and emitting 3.6-4K output tokens for yes/no verdicts (12 boundary
 *  classifier calls = 43K tokens; 28 coverage calls = 113K). Classification
 *  needs LOW thinking — the deterministic oracle + downstream gates are the
 *  real guards; the classifier only triages. */
const CLASSIFIER_AGENTS = new Set([
	"tdd-coverage-classifier",
	"red-boundary-classifier",
	"task-classifier",
	"route-specialist",
]);

/** Role-based default thinking level for an agent, mirroring isCodeWritingAgent.
 *  Reasoning-heavy analysis agents think hard; code writers think medium;
 *  classifier triage thinks low; mechanical bookkeeping agents think minimally;
 *  everything else defaults to medium. */
export function thinkingForAgent(agent: string): ThinkingLevel {
	if (REASONING_AGENTS.has(agent)) return "high";
	if (isCodeWritingAgent(agent)) return "medium";
	if (CLASSIFIER_AGENTS.has(agent)) return "low";
	if (MECHANICAL_AGENTS.has(agent)) return "minimal";
	return "medium";
}

/** Does this agent carry an EXPLICIT throughput tier (reasoning / code-writing /
 *  classifier / mechanical)? Tiered roles keep their designed level even when a
 *  main-session thinking level is inherited — the v0.3.43 root-cause fix. A
 *  `:max` parent session must not silently turn a yes/no classifier or a git
 *  committer into a max-effort reasoner: measured effect on the 2026-08-30 run
 *  pair was ~1.5M of 2.36M output tokens (≈10 wall-clock hours across two runs)
 *  spent on thinking inflation that the role tiers were designed to prevent. */
export function hasThinkingTier(agent: string): boolean {
	return REASONING_AGENTS.has(agent) || isCodeWritingAgent(agent) || CLASSIFIER_AGENTS.has(agent) || MECHANICAL_AGENTS.has(agent);
}

/** Narrow an arbitrary string to a ThinkingLevel (used for the env override). */
function asThinkingLevel(value: string | undefined): ThinkingLevel | undefined {
	return value && (THINKING_LEVELS as readonly string[]).includes(value) ? (value as ThinkingLevel) : undefined;
}

/** v0.3.45: split a trailing `:level` thinking suffix off a model string
 * ("zai-coding-cn/glm-5.3:high" → model "zai-coding-cn/glm-5.3", thinking "high").
 * The suffix only splits on a VALID ThinkingLevel word, so model ids that
 * merely contain a colon ("provider/model:latest") stay intact. Exported for
 * resolveAgentModel (which must send the BARE model id on every backend) and
 * the per-call seam in workflow.ts. */
export function splitModelThinking(raw: string | undefined): { model: string; thinking: ThinkingLevel | undefined } {
	const s = raw?.trim();
	if (!s) return { model: "", thinking: undefined };
	const idx = s.lastIndexOf(":");
	if (idx <= 0 || idx === s.length - 1) return { model: s, thinking: undefined };
	const thinking = asThinkingLevel(s.slice(idx + 1).trim().toLowerCase());
	if (!thinking) return { model: s, thinking: undefined };
	return { model: s.slice(0, idx), thinking };
}

/** v0.3.45: per-agent thinking override embedded as a `:level` suffix on the
 * config.agentModels entry ("zai-coding-cn/glm-5.3:high" — set model and
 * thinking together). Same lazy-read pattern as agentThinkingFromConfig;
 * the DEDICATED agentThinking map wins when both are set (the suffix is
 * colocated sugar, not a second opinion channel). */
export function agentModelThinkingFromConfig(agent: string, map?: Record<string, string>): ThinkingLevel | undefined {
	const source =
		map ??
		(() => {
			try {
				return getConfig().agentModels;
			} catch {
				return undefined;
			}
		})();
	if (!source) return undefined;
	return splitModelThinking(source[agent]).thinking;
}

/** v0.3.44: per-agent thinking override from config.json (`agentThinking`).
 *  Lazily read per call (the superDevEnv pattern) so config edits apply to
 *  later dispatches without a process restart; the optional `map` param keeps
 *  this unit-testable without touching the real ~/.super-dev/config.json.
 *  Invalid levels are ignored — a typo falls back to tier behavior, not a
 *  crash. */
export function agentThinkingFromConfig(agent: string, map?: Record<string, string>): ThinkingLevel | undefined {
	const source =
		map ??
		(() => {
			try {
				return getConfig().agentThinking;
			} catch {
				return undefined;
			}
		})();
	if (!source) return undefined;
	return asThinkingLevel(source[agent]?.trim());
}

/** Resolve the effective thinking level with precedence (v0.3.43 reordered,
 *  v0.3.44 adds the config tier; v0.3.45 adds the agentModels `:level`
 *  suffix at the SAME config tier):
 *  per-call override → SUPER_DEV_THINKING env → config.agentThinking[role] →
 *  config.agentModels[role] `:level` suffix →
 *  ROLE TIER (for explicitly tiered agents) → INHERITED main-session level →
 *  "medium" fallback.
 *
 *  The ROLE TIER sits ABOVE the inherited level for TIERED roles. The previous
 *  order (inherited above role defaults, SCENARIO-006) let a parent session
 *  running `:max` propagate max thinking to EVERY specialist — classifiers,
 *  committers, everyone — measured as the #1 latency root cause (thinking
 *  tokens were 50-85% of specialist output). Explicit control is preserved:
 *  per-call and SUPER_DEV_THINKING still override everything, UNTIERED agents
 *  keep inheriting the main-session level exactly as before, and a
 *  config.agentThinking entry beats the built-in tier for its role (tuning a
 *  role is the point of the config — e.g. raise implementer to "high" for a
 *  hard codebase, or drop a reviewer to "low" for a cheap one). */
export function resolveThinking(agent: string, perCall?: ThinkingLevel, inherited?: ThinkingLevel): ThinkingLevel {
	if (perCall) return perCall;
	const env = asThinkingLevel(superDevEnv("SUPER_DEV_THINKING"));
	if (env) return env;
	const cfg = agentThinkingFromConfig(agent);
	if (cfg) return cfg;
	const modelSuffix = agentModelThinkingFromConfig(agent);
	if (modelSuffix) return modelSuffix;
	if (hasThinkingTier(agent)) return thinkingForAgent(agent);
	if (inherited) return inherited;
	return "medium";
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
	const env = asThinkingLevel(superDevEnv("SUPER_DEV_THINKING"));
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
	const env = superDevEnv("SUPER_DEV_MODEL")?.trim();
	return env || undefined;
}

/** Per-spawn wall-clock cap. 20 min: big-spec writers (46+ scenarios) spend
 *  ~70% re-verifying anchors then run out of the 480s budget mid-compose —
 *  the timeout discards the whole structured_output (run 2026-08-23T00-59-32
 *  rounds 2/4). Aligned with CODE_WRITING_TIMEOUT_MS so every role gets 20 min. */
const DEFAULT_SPAWN_TIMEOUT_MS = 1_200_000;
/** Code-writing agents (implementer/tdd-guide) must read large existing files
 *  AND land+verify edits in one turn; on a slow model the doc-writer cap aborts
 *  them mid-exploration before any edit is written. Give them ~30 min — 20
 *  aborted two healthy writers on 2026-08-30 (AQ phase-02 commit orchestrator,
 *  CC phase-03 implementer on glm-5.3:max thinking), each costing the full
 *  window plus a recovery round. */
const CODE_WRITING_TIMEOUT_MS = 1_800_000;

/** AC-23 (SCENARIO-049): SIGTERM → SIGKILL watchdog. A child that registered a
 *  SIGTERM handler and never exits (or whose grandchildren hold the stdio
 *  pipes) must not hold the run hostage — after this grace the ladder escalates
 *  to an uncatchable SIGKILL. */
export const SIGTERM_GRACE_MS = 10_000;
/** AC-23 (SCENARIO-049): post-SIGKILL settle bound. Even after SIGKILL, pipe-
 *  holding grandchildren can keep `close` from firing; the backstop rejects
 *  within this bound so the caller always regains control. */
export const SETTLE_GRACE_MS = 5_000;

/** The default wall-clock cap for an agent, by role. Overridable per-call via
 *  AgentCall.timeoutMs (threaded through `common` in workflow.ts). */
export function defaultAgentTimeoutMs(agent: string): number {
	return isCodeWritingAgent(agent) ? CODE_WRITING_TIMEOUT_MS : DEFAULT_SPAWN_TIMEOUT_MS;
}

// ─── v0.2.10: subprocess-backend spawn resilience ──────────────────────────

/** W4: skills are a CAPABILITY, not ambient noise — v0.3.59: ONE switch governs
 *  all three backends (session loader noSkills, subprocess --no-skills,
 *  pi-subagents registration inheritSkills). `SUPER_DEV_NO_SKILLS=1` restores
 *  the pre-v0.2.10 full isolation for debugging/CI. */
export function skillsEnabled(env: { SUPER_DEV_NO_SKILLS?: string } = {
	SUPER_DEV_NO_SKILLS: superDevEnv("SUPER_DEV_NO_SKILLS"),
}): boolean {
	return env.SUPER_DEV_NO_SKILLS !== "1";
}

/** W1: the RPC same-session backend is the default; `SUPER_DEV_NO_RPC_SPAWN=1`
 *  falls back to today's `--mode json -p` one-shot behavior. */
export function rpcSpawnEnabled(env: { SUPER_DEV_NO_RPC_SPAWN?: string } = {
	SUPER_DEV_NO_RPC_SPAWN: superDevEnv("SUPER_DEV_NO_RPC_SPAWN"),
}): boolean {
	return env.SUPER_DEV_NO_RPC_SPAWN !== "1";
}

/** W2: task texts longer than this ride a 0600 `@file` in the json fallback
 *  path instead of argv (pi-subagents' TASK_ARG_LIMIT value; long natural-
 *  language argv is a documented EDR pre-exec-scan kill class and bloats every
 *  spawn log line — we observed a 28444-char task in argv). The RPC path needs
 *  no threshold: the task always rides the stdin prompt event. */
export const TASK_ARG_LIMIT = 8_000;

/** W3: the control schema handed to the child's structured_output tool —
 *  the same permissive key-declaration contract the session backend's
 *  controlSchema emits (every key DECLARED, values unconstrained, nothing
 *  required): the model sees the keys as its contract, tool validation never
 *  rejects a partial object, and completeness stays with the parent-side
 *  missingControlKeys check. */
export function controlSchemaJson(keys: string[]): Record<string, unknown> {
	const properties: Record<string, unknown> = {};
	for (const key of keys) properties[key] = {};
	return { type: "object", properties, additionalProperties: true };
}

/** W3: absolute path of the repo's child-side runtime extension, resolved from
 *  THIS module's location so it works both from the repo checkout and from the
 *  installed extension layout. Null when the sibling file is missing (the
 *  caller then stays on the plain <control> text contract). */
export function structuredOutputExtensionPath(): string | null {
	try {
		const here = fileURLToPath(import.meta.url);
		const candidate = join(dirname(here), "subprocess-structured-output.ts");
		return safeIsFile(candidate) ? candidate : null;
	} catch {
		return null;
	}
}

/** W3: read the structured_output tool's capture file. Null when absent,
 *  unreadable, or not a JSON object — the caller then falls back to the
 *  <control> text contract. Never throws. */
export function readToolCapture(capturePath: string | null | undefined): ControlObj | null {
	if (!capturePath) return null;
	try {
		const parsed = JSON.parse(readFileSync(capturePath, "utf-8")) as unknown;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
		return parsed as ControlObj;
	} catch {
		return null;
	}
}

/** Resolve a turn's control with tool-capture preference over text extraction.
 *  v0.3.54 (F6 wiring): the declared keys ride into extractControl so the
 *  fallback-object guard can reject a wrong object after a tag-parse failure. */
function resolveTurnControl(text: string, capturePath: string | null | undefined, expectedKeys?: string[]): ControlObj | null {
	return readToolCapture(capturePath) ?? extractControl(text, expectedKeys);
}

/** Log which control-delivery channel produced the result (auditability):
 *  tool capture (with size + sha256 prefix), the legacy <control> text
 *  fallback, or neither. */
function logControlSource(result: SpawnResult, capturePath: string | null | undefined, label: string, onProgress?: AgentProgress): void {
	if (!capturePath) return;
	try {
		const raw = readFileSync(capturePath, "utf-8");
		const digest = createHash("sha256").update(raw).digest("hex").slice(0, 16);
		onProgress?.event(`subprocess ${label}: structured_output captured (${raw.length} bytes sha256:${digest})`);
	} catch {
		if (result.control) onProgress?.event(`subprocess ${label}: structured_output via <control> text fallback (no tool capture)`);
		else onProgress?.event(`subprocess ${label}: structured_output absent (no tool capture, no <control> text)`);
	}
}

/** W1: the in-session corrective follow_up message. Unlike the json-mode
 *  corrective RESPAWN (which must replay the original prompt + previous output
 *  because the fresh process has no memory), the RPC follow_up lands in the
 *  SAME session — the message is short, names the real cause, and forbids
 *  redoing work that is already on disk/in context. */
export function buildRpcCorrectiveMessage(missing: string[], keys: string[]): string {
	return [
		"CORRECTIVE TURN — your previous turn ended WITHOUT the required control object.",
		missing.length > 0 ? `Missing required keys: ${missing.join(", ")}.` : "No control object was delivered.",
		"Your final action must be a `structured_output` tool call carrying the COMPLETE control object.",
		`Required top-level keys: ${keys.join(", ")}.`,
		"If the tool is unavailable, emit ONE final message containing exactly a `<control>{...}</control>` JSON block with every required key.",
		"Do NOT redo work you already completed this session — use what you have already read and produced.",
	].join("\n");
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
	/** Keys whose EMPTY-ARRAY value counts as present (merged over the default
	 *  file-list allow-list, matching the session backend). The key must still
	 *  be EMITTED — undefined is always missing. */
	allowEmptyArraysFor?: string[];
	/** Live progress from the spawned agent (tool calls + streaming text). */
	onProgress?: AgentProgress;
	/** v0.2.10 W1: execution mode for the subprocess backend. "rpc" keeps the
	 *  child alive and drives turns over stdin (same-session corrective
	 *  follow_up); "json" is the legacy one-shot `--mode json -p`. Defaults to
	 *  rpcSpawnEnabled() at the spawnAgent level; exposed for argv unit tests. */
	spawnMode?: "json" | "rpc";
	/** v0.2.10 W2: when set (json fallback path only), the task rides this
	 *  0600 file via `@<path>` instead of argv. Set by spawnAgent when the task
	 *  exceeds TASK_ARG_LIMIT; exposed for argv unit tests. */
	taskFile?: string;
}

const PI_PACKAGE_NAME = "@earendil-works/pi-coding-agent";

/** Walk up from an entry file to the pi-coding-agent package root (the first
 *  package.json whose name matches). Mirrors pi-subagents'
 *  findPiPackageRootFromEntry — the only trustworthy way to know argv[1] IS
 *  the pi CLI rather than some other node host's script. */
export function findPiPackageRootFromEntry(entry: string): string | undefined {
	try {
		let dir = dirname(entry);
		for (;;) {
			const pkgPath = join(dir, "package.json");
			if (safeIsFile(pkgPath)) {
				try {
					const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as { name?: unknown };
					if (pkg.name === PI_PACKAGE_NAME) return dir;
				} catch { /* keep walking */ }
			}
			const parent = dirname(dir);
			if (parent === dir) return undefined;
			dir = parent;
		}
	} catch {
		return undefined;
	}
}

function resolvePiBinary(): { command: string; args: string[] } {
	const argv1 = process.argv[1] ?? "";
	// The argv[1] heuristic is valid ONLY when that entry lives inside the
	// pi-coding-agent package. Under any other node host (vitest, SDK runners)
	// argv[1] is the HOST's script, and exec'ing it turns every spawn into
	// `node <host-script> --mode rpc ...` — observed live as instant exit 1.
	if (argv1 && /\.(?:mjs|cjs|js)$/i.test(argv1) && findPiPackageRootFromEntry(argv1)) {
		return { command: process.execPath, args: [argv1] };
	}
	// Next: the installed pi package's own bin, when resolvable from here.
	try {
		// NOTE (adv review F-1): this import.meta.resolve rung throws in plain
		// Node (package.json is not in pi's exports map) and under vitest SSR — it
		// only ever resolves under pi's own loader. Best-effort by design; the
		// validated argv[1] and PATH rungs are the load-bearing ones.
		const pkgJsonPath = fileURLToPath(import.meta.resolve(`${PI_PACKAGE_NAME}/package.json`));
		const root = dirname(pkgJsonPath);
		const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf-8")) as { bin?: string | Record<string, string> };
		const bin = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.pi;
		if (bin) {
			const entry = join(root, bin);
			if (safeIsFile(entry)) return { command: process.execPath, args: [entry] };
		}
	} catch { /* not resolvable from this module — fall through to PATH */ }
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

/** Default empty-array allow-list — identical to the session backend's, so both
 *  backends enforce the same completeness contract by default (parity). */
// v0.3.47: `findings` joins the empty-ok set — a review that APPROVES with
// zero findings is a first-class outcome (the review prompts say so verbatim:
// "Zero findings is a valid, respected outcome"), but the strict key check
// treated findings:[] as a missing key and burned a full corrective re-run.
// v0.3.56 F5: the canonical base moved to control.ts (shared with the session
// and delegation backends — P6). Kept as a local alias so the call sites below
// and the zero-findings rationale comment stay stable.
const DEFAULT_EMPTY_ARRAY_OK = CONTROL_DEFAULT_EMPTY_ARRAY_OK;

function controlError(control: Record<string, unknown> | null, keys: string[], allowEmptyArraysFor?: string[]): string | undefined {
	const missing = missingControlKeys(control, keys, { allowEmptyArraysFor: [...DEFAULT_EMPTY_ARRAY_OK, ...(allowEmptyArraysFor ?? [])] });
	if (missing.length === 0) return undefined;
	return control
		? `missing required control keys: ${missing.join(", ")}`
		: `agent produced no control object; missing required control keys: ${missing.join(", ")}`;
}

function withControlError(result: SpawnResult, keys: string[], allowEmptyArraysFor?: string[]): SpawnResult {
	const err = controlError(result.control, keys, allowEmptyArraysFor);
	return err && !result.error ? { ...result, error: err } : result;
}

function compactPreviousOutput(text: string, maxChars = 12_000): string {
	if (text.length <= maxChars) return text;
	return `[previous output truncated to last ${maxChars} chars]\n${text.slice(-maxChars)}`;
}

function buildSubprocessCorrectivePrompt(originalPrompt: string, previous: SpawnResult, keys: string[], allowEmptyArraysFor?: string[]): string {
	const missing = missingControlKeys(previous.control, keys, { allowEmptyArraysFor: [...DEFAULT_EMPTY_ARRAY_OK, ...(allowEmptyArraysFor ?? [])] });
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
		// Sweep-3 G24: prior assistant output is UNTRUSTED TEXT — fence it with
		// the shared DATA-fence discipline (AC-31) so model-emitted instructions
		// can't leak into the task framing unfenced (every other embedder fences).
		DATA_FENCE_PREAMBLE,
		fenceUntrusted(compactPreviousOutput(previous.text || "(empty)"), "previous assistant output"),
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

		// v0.2.10 W3: arm the structured-output tool contract whenever control
		// keys are declared and the runtime extension resolves. The tool capture
		// (preferred) or the legacy <control> text (fallback) both satisfy the
		// same missingControlKeys completeness gate, so nothing downstream
		// changes. Without controlKeys (or when the sibling file is missing) the
		// text contract alone applies — byte-identical to pre-v0.2.10 behavior.
		const soExtension = requiredKeys.length > 0 ? structuredOutputExtensionPath() : null;
		let capturePath: string | null = null;
		let soEnv: Record<string, string> | undefined;
		if (requiredKeys.length > 0 && soExtension) {
			const schemaPath = join(tempDir, "control-schema.json");
			capturePath = join(tempDir, "control-output.json");
			writeFileSync(schemaPath, JSON.stringify(controlSchemaJson(requiredKeys)), { mode: 0o600 });
			try { unlinkSync(capturePath); } catch { /* absent is the normal fresh state */ }
			soEnv = { [SO_SCHEMA_ENV]: schemaPath, [SO_CAPTURE_ENV]: capturePath };
		}
		const extraExtensions = soExtension && requiredKeys.length > 0 ? [soExtension, ...roleExtensions] : roleExtensions;
		const extSummary = extraExtensions.length ? extraExtensions.join(", ") : "(none)";
		/** Merge the tool capture over the text extraction + log the channel. */
		const applyCapture = (result: SpawnResult): SpawnResult => {
			const captured = readToolCapture(capturePath);
			const merged = captured ? { ...result, control: captured } : result;
			logControlSource(merged, capturePath, label, opts.onProgress);
			return merged;
		};

		// v0.2.10 W1: RPC same-session backend (default). The task rides the stdin
		// prompt event (never argv), and the corrective retry is an in-session
		// follow_up instead of an amnesiac fresh-process respawn.
		if (rpcSpawnEnabled()) {
			const args = buildSpawnArgs({ ...opts, spawnMode: "rpc" }, promptPath, extraExtensions);
			opts.onProgress?.event(`subprocess ${label}: spawn (rpc same-session) timeout=${timeoutMs}ms cwd=${opts.cwd} roleExtensions=${extSummary} argv=${summarizeSpawnArgs(args)}`);
			const result = await runPiRpc({
				args,
				cwd: opts.cwd,
				signal: opts.signal,
				label,
				timeoutMs,
				onProgress: opts.onProgress,
				env: soEnv,
				task: `Task: ${buildSubprocessTaskPrompt(opts.prompt, opts.controlKeys)}`,
				capturePath,
				controlKeys: requiredKeys,
				correctiveFor: (first) => {
					const err = controlError(first.control, requiredKeys, opts.allowEmptyArraysFor);
					if (!err || first.error) return null;
					const missing = missingControlKeys(first.control, requiredKeys, { allowEmptyArraysFor: [...DEFAULT_EMPTY_ARRAY_OK, ...(opts.allowEmptyArraysFor ?? [])] });
					return buildRpcCorrectiveMessage(missing, requiredKeys);
				},
			});
			// review F-2: the DEFAULT rpc path must log the control-delivery channel
			// too (spec W3 + CHANGELOG promise the audit line on every path).
			logControlSource(result, capturePath, label, opts.onProgress);
			return withControlError(result, requiredKeys, opts.allowEmptyArraysFor);
		}

		// json one-shot fallback (SUPER_DEV_NO_RPC_SPAWN=1) — pre-v0.2.10 shape,
		// plus W2 @file delivery and the W3 capture merge.
		const taskText = buildSubprocessTaskPrompt(opts.prompt, opts.controlKeys);
		let spawnOpts = opts;
		if (taskText.length > TASK_ARG_LIMIT) {
			const taskFile = join(tempDir, "task.md");
			writeFileSync(taskFile, `Task: ${taskText}`, { mode: 0o600 });
			spawnOpts = { ...opts, taskFile };
		}
		const args = buildSpawnArgs(spawnOpts, promptPath, extraExtensions);
		opts.onProgress?.event(`subprocess ${label}: spawn timeout=${timeoutMs}ms cwd=${opts.cwd} roleExtensions=${extSummary} argv=${summarizeSpawnArgs(args)}`);
		const first = applyCapture(await runPi(args, opts.cwd, opts.signal, label, timeoutMs, opts.onProgress, soEnv, requiredKeys));
		const firstError = controlError(first.control, requiredKeys, opts.allowEmptyArraysFor);
		if (!firstError || first.error || opts.signal?.aborted) return withControlError(first, requiredKeys, opts.allowEmptyArraysFor);

		opts.onProgress?.event(`↻ ${label}: corrective subprocess retry (${firstError})`);
		// review F-1: reset capture presence before the corrective respawn — a
		// PARTIAL capture from the first run must not mask the retry's text-channel
		// recovery (applyCapture prefers any readable capture, and the corrective
		// prompt explicitly directs the text channel).
		if (capturePath) {
			try { unlinkSync(capturePath); } catch { /* absent is the normal fresh state */ }
		}
		const correctivePrompt = buildSubprocessCorrectivePrompt(opts.prompt, first, requiredKeys, opts.allowEmptyArraysFor);
		const retryOpts: SpawnAgentOptions = {
			...opts,
			prompt: correctivePrompt,
		};
		// Sweep-3 G7: the corrective prompt REPLACED opts.prompt, so a stale
		// taskFile would deliver the ORIGINAL task verbatim (buildSpawnArgs
		// prefers @file over the prompt) — and the corrective prompt is LONGER
		// than the original, so it must re-qualify for the limit on its own.
		// Recompute the delivery channel for the retry: a fresh 0600 file when
		// over-limit, argv when not.
		if (retryOpts.taskFile) {
			try { unlinkSync(retryOpts.taskFile); } catch { /* absent is fine */ }
			retryOpts.taskFile = undefined;
		}
		if (correctivePrompt.length > TASK_ARG_LIMIT) {
			const retryTaskFile = join(tempDir, "task-retry.md");
			writeFileSync(retryTaskFile, `Task: ${correctivePrompt}`, { mode: 0o600 });
			retryOpts.taskFile = retryTaskFile;
		}
		const retryArgs = buildSpawnArgs(retryOpts, promptPath, extraExtensions);
		opts.onProgress?.event(`subprocess ${label}: corrective retry argv=${summarizeSpawnArgs(retryArgs)}`);
		const retry = applyCapture(await runPi(retryArgs, opts.cwd, opts.signal, label, timeoutMs, opts.onProgress, soEnv, requiredKeys));
		return withControlError(retry, requiredKeys, opts.allowEmptyArraysFor);
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
	const mode = opts.spawnMode === "rpc" ? "rpc" : "json";
	const args = [
		command, // ← the executable ("pi" on PATH, or `node` re-invoking the host entry)
		...prefix,
		"--mode", mode,
	];
	// `-p` is the one-shot print flag; the rpc mode drives turns over stdin
	// events instead, so it takes NO positional task at all.
	if (mode === "json") args.push("-p");
	args.push("--no-session");
	// v0.2.10 W4: skills stay loadable by default (capability parity with the
	// session backend); SUPER_DEV_NO_SKILLS=1 restores the old isolation flag.
	if (!skillsEnabled()) args.push("--no-skills");
	args.push("--no-extensions", "--no-context-files", "--no-prompt-templates");
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
	if (mode === "rpc") return args; // task rides the stdin prompt event (runPiRpc)
	// v0.2.10 W2: long tasks ride a 0600 @file (spawnAgent decides); short
	// tasks keep argv delivery (audit-visible, no extra file).
	if (opts.taskFile) args.push(`@${opts.taskFile}`);
	else args.push(`Task: ${buildSubprocessTaskPrompt(opts.prompt, opts.controlKeys)}`);
	return args;
}

/** Run one `pi` subprocess and capture its final assistant text. Exported for
 *  direct unit testing of the NDJSON streaming/termination contract (the
 *  subprocess backend's single primitive). `extraEnv` carries the
 *  structured-output contract vars to the child (W3). */
export function runPi(args: string[], cwd: string, signal: AbortSignal | undefined, label: string, timeoutMs: number, onProgress?: AgentProgress, extraEnv?: Record<string, string | undefined>, expectedKeys?: string[]): Promise<SpawnResult> {
	return new Promise((resolve, reject) => {
		// SD-04 (NFR-6): a listener registered on an ALREADY-aborted signal never
		// fires (WHATWG/Node EventTarget semantics) — the child would run to its
		// own hard timeout (up to 1200s for code-writing agents). Check
		// synchronously BEFORE spawn so no child is ever spawned into a dead run.
		if (signal?.aborted) {
			resolve({ text: "", control: null, error: "aborted" });
			return;
		}
		const child = spawn(args[0], args.slice(1), {
			cwd,
			stdio: ["ignore", "pipe", "pipe"],
			env: { ...process.env, ...extraEnv },
			windowsHide: true,
		});
		// AC-12 (SCENARIO-026): decode the byte stream EXACTLY ONCE at the stream
		// layer — the string decoder buffers incomplete multi-byte UTF-8 sequences
		// across chunk boundaries, so a sequence split mid-codepoint (F0 9F | 98 80)
		// reassembles byte-exactly instead of producing U+FFFD replacement chars
		// the way a per-Buffer `.toString("utf8")` did.
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
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
		const startedAt = Date.now(); // v0.3.28: terminal usage duration
		const usageStats = newUsageStats(); // v0.3.28: terminal usage accumulation
		let prevNarrationLines: string[] = []; // v0.3.28: ⇢ narration diff
		// v0.3.28: narration parity — flush the accumulated live text as
		// `label: ⇢ line` run.log lines (was: one bare unprefixed flush), matching
		// the delegation and session backends.
		const flushNarration = () => {
			if (!currentText.trim()) return;
			const lines = stripControl(currentText).trim().split("\n").map((l) => l.trim()).filter(Boolean);
			for (const l of newNarrationLines(lines, prevNarrationLines)) onProgress?.event(`${label}: ⇢ ${l.slice(0, 200)}`);
			prevNarrationLines = [...prevNarrationLines, ...lines].slice(-50);
			currentText = "";
		};
		const STDERR_CAP = 16 * 1024;
		const LINE_CAP = 16 * 1024 * 1024;
		/** AC-12 (SCENARIO-027): one NDJSON line's handling, shared by the chunk
		 *  splitter and the close handler's residual (newline-less) final line. */
		const processLine = (raw: string): void => {
			const trimmed = raw.trim();
			if (!trimmed) return;
			let ev: PiJsonEvent;
			try { ev = JSON.parse(trimmed) as PiJsonEvent; } catch { return; }
			// capture the final assistant text (for <control> extraction)
			const a = assistantFromMessageEnd(ev);
			if (a) {
				if (a.text) { lastAssistantText = a.text; if (a.model) lastModel = a.model; }
				if (a.model) usageStats.model = a.model;
				accumulateUsage(usageStats, a.usage);
				// a finished message finalizes any in-progress live text
				flushNarration();
				return;
			}
			// v0.3.28: turn/tool accounting is UNCONDITIONAL (the terminal summary
			// must not depend on onProgress wiring).
			if (ev.type === "turn_start") turns++;
			if (!onProgress) return;
			const se = renderEvent(ev, () => turns);
			if (!se) return;
			if (se.kind === "text") {
				// live typing: update the mutable live line
				currentText = se.text;
				onProgress.text(stripControl(currentText));
			} else {
				// a permanent event finalizes any in-progress text first
				flushNarration();
				if (se.kind === "tool") { usageStats.toolCalls++; onProgress.event(`→ ${se.summary}`); }
			}
		};
		const cleanup = () => {
			signal?.removeEventListener("abort", onAbort);
			clearTimeout(timer);
			clearTimeout(killWatchdog);
			clearTimeout(settleTimer);
		};
		// AC-23 (SCENARIO-049): ONE termination ladder shared by the abort and the
		// timeout paths (idempotent via killArmed): SIGTERM → SIGTERM_GRACE_MS →
		// SIGKILL → SETTLE_GRACE_MS → backstop reject. Promise settle-once
		// semantics make the backstop reject safe after a normal close, and the
		// close handler's cleanup() clears both watchdogs so a child that exited
		// (gracefully or on SIGKILL) is never signaled again.
		let killArmed = false;
		let killWatchdog: ReturnType<typeof setTimeout> | undefined;
		let settleTimer: ReturnType<typeof setTimeout> | undefined;
		const terminateChild = () => {
			if (killArmed) return;
			killArmed = true;
			try { child.kill("SIGTERM"); } catch { /* ignore */ }
			killWatchdog = setTimeout(() => {
				try { child.kill("SIGKILL"); } catch { /* ignore */ }
				settleTimer = setTimeout(() => {
				cleanup();
				reject(new Error(`super-dev [${label}]: killed after SIGTERM+SIGKILL (no exit within ${SETTLE_GRACE_MS}ms)`));
				}, SETTLE_GRACE_MS);
			}, SIGTERM_GRACE_MS);
		};
		const onAbort = () => {
			aborted = true;
			onProgress?.event(`subprocess ${label}: aborted by parent signal; terminating child pi`);
			terminateChild();
		};
		signal?.addEventListener("abort", onAbort, { once: true });
		// SD-04 (NFR-6): close the registration window — if the signal aborted
		// between the pre-spawn check and this registration (future refactors may
		// await in between), terminate NOW instead of relying on a never-firing
		// listener.
		if (signal?.aborted) onAbort();
		const timer = setTimeout(() => {
			timedOut = true;
			onProgress?.event(`subprocess ${label}: timeout after ${timeoutMs}ms; terminating child pi`);
			terminateChild();
		}, timeoutMs);

		child.stdout.on("data", (c: string) => {
			lineBuf += c;
			let nl: number;
			while ((nl = lineBuf.indexOf("\n")) >= 0) {
				const raw = lineBuf.slice(0, nl);
				lineBuf = lineBuf.slice(nl + 1);
				processLine(raw);
			}
			// Stay bounded on a runaway line, but keep the TAIL rather than dropping the
			// whole buffer: a >LINE_CAP line (e.g. a huge message_end) would otherwise
			// discard the partial final assistant text, leaving extractControl to run on
			// stale earlier output. Keeping the tail lets the next newline still close a line.
			if (lineBuf.length > LINE_CAP) lineBuf = lineBuf.slice(-LINE_CAP);
		});
		child.stderr.on("data", (c: string) => {
			stderrBuf += c;
			if (stderrBuf.length > STDERR_CAP) stderrBuf = stderrBuf.slice(stderrBuf.length - STDERR_CAP);
		});
		child.on("error", (err) => {
			cleanup();
			const pathPreview = (process.env.PATH ?? "").split(":").slice(0, 8).join(":");
			reject(new Error(`super-dev [${label}]: failed to spawn pi: ${err.message}; cwd=${cwd}; PATH=${pathPreview || "(empty)"}`));
		});
		child.on("close", (code) => {
			cleanup();
			// AC-12 (SCENARIO-027): a newline-less final NDJSON line is still a line —
			// parse the residual buffer BEFORE treating output as absent so a final
			// `message_end` emitted without a trailing \n is processed, not dropped.
			if (lineBuf.trim()) processLine(lineBuf.trim());
			const tail = stderrBuf.trim().split("\n").slice(-3).join(" | ");
			onProgress?.event(`subprocess ${label}: close exit=${code ?? "signal"} timedOut=${timedOut ? "yes" : "no"}${tail ? ` stderrTail=${tail}` : ""}`);
			if (aborted) { resolve({ text: "", control: null, error: "aborted" }); return; }
			// lastAssistantText already holds the last non-empty assistant text
			// (resilient to a trailing tool-call turn or a mid-stream kill).
			if (lastAssistantText) {
				// v0.3.28 full-field parity: terminal usage summary on success —
				// the child's message_end events carry full usage.
				if (!aborted && !timedOut) {
					onProgress?.event(agentTerminalLine("subprocess", label, "completed", {
						model: lastModel ?? usageStats.model, turns, toolCalls: usageStats.toolCalls,
						input: usageStats.input, output: usageStats.output, cacheRead: usageStats.cacheRead, cacheWrite: usageStats.cacheWrite,
						cost: usageStats.cost, durationMs: Date.now() - startedAt,
					}));
				}
				resolve({ text: lastAssistantText, control: extractControl(lastAssistantText, expectedKeys), model: lastModel, error: timedOut ? `timed out after ${timeoutMs}ms (used partial output)` : undefined });
				return;
			}
			const reason = timedOut ? `timed out after ${Math.round(timeoutMs / 1000)}s` : `produced no output (exit ${code})`;
			reject(new Error(`super-dev [${label}]: agent ${reason}.${tail ? ` stderr: ${tail}` : ""}`));
		});
	});
}

export interface RpcRunOptions {
	/** Full argv INCLUDING the executable (buildSpawnArgs with spawnMode "rpc"). */
	args: string[];
	cwd: string;
	signal?: AbortSignal;
	label: string;
	/** TOTAL wall-clock budget spanning the prompt turn AND the corrective
	 *  follow_up turn (same semantics as the json-mode timeout). */
	timeoutMs: number;
	onProgress?: AgentProgress;
	/** Extra env for the child (the structured-output contract vars). */
	env?: Record<string, string | undefined>;
	/** First-turn task message (already includes the control-keys contract). */
	task: string;
	/** structured_output capture path (W3); null disables tool-capture merging. */
	capturePath?: string | null;
	/** v0.3.54 (F6 wiring): declared control keys for the text-extraction guard. */
	controlKeys?: string[];
	/** Decide whether a corrective follow_up is needed once the first turn's
	 *  control is resolved; returns the in-session message to send, or null to
	 *  stop after the first turn. */
	correctiveFor: (result: SpawnResult) => string | null;
}

/** v0.2.10 W1: run one `pi --mode rpc` child and drive its turns over stdin.
 * The child stays ALIVE across turns, so the corrective follow_up lands in the
 * SAME in-memory session (verified: a turn-2 prompt recalled a turn-1 secret
 * verbatim) — the agent finishes from its own completed context instead of
 * re-entering the narration loop a fresh process re-enters. The overall
 * timeout spans both turns; abort sends the rpc abort event then the same
 * SIGTERM→SIGKILL ladder as runPi. */
export function runPiRpc(options: RpcRunOptions): Promise<SpawnResult> {
	return new Promise<SpawnResult>((resolve, reject) => {
		// SD-04 parity: never spawn a child into an already-aborted run.
		if (options.signal?.aborted) {
			resolve({ text: "", control: null, error: "aborted" });
			return;
		}
		const { label, timeoutMs, onProgress } = options;
		const child = spawn(options.args[0], options.args.slice(1), {
			cwd: options.cwd,
			stdio: ["pipe", "pipe", "pipe"],
			env: options.env ? { ...process.env, ...options.env } : { ...process.env },
			windowsHide: true,
		});
		// EPIPE when the child dies mid-write must not crash the parent.
		child.stdin?.on("error", () => {});
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		let turns = 0;
		let liveText = "";
		let rawEventCount = 0; // review F-6: zero-event quick-exit = host pi may lack rpc mode
		const usageStats = newUsageStats(); // v0.3.28: terminal usage accumulation
		let prevNarrationLines: string[] = []; // v0.3.28: ⇢ narration diff
		// v0.3.28: narration parity — flush as `label: ⇢ line` run.log lines (was:
		// one bare unprefixed flush), matching the delegation and session backends.
		const flushNarration = () => {
			if (!liveText.trim()) return;
			const lines = stripControl(liveText).trim().split("\n").map((l) => l.trim()).filter(Boolean);
			for (const l of newNarrationLines(lines, prevNarrationLines)) onProgress?.event(`${label}: ⇢ ${l.slice(0, 200)}`);
			prevNarrationLines = [...prevNarrationLines, ...lines].slice(-50);
			liveText = "";
		};
		const driver = new RpcDriver({
			write: (line) => {
				try { child.stdin?.write(`${line}\n`); } catch { /* handled via turn error */ }
			},
			onRawEvent: (event) => {
				rawEventCount++;
				// v0.3.28: turn/tool accounting is UNCONDITIONAL (the terminal
				// summary must not depend on onProgress wiring). message_end finalizes
				// the pending narration block; its usage is already accumulated inside
				// the driver (message_end is intercepted there first).
				const ev = event as PiJsonEvent;
				if (ev.type === "turn_start") turns++;
				if (ev.type === "tool_execution_start" && ev.toolName) usageStats.toolCalls++;
				if (ev.type === "message_end") { flushNarration(); return; }
				if (!onProgress) return;
				const se = renderEvent(ev, () => turns);
				if (!se) return;
				if (se.kind === "text") {
					liveText = se.text;
					onProgress.text(stripControl(liveText));
				} else if (se.kind === "tool") {
					flushNarration();
					onProgress.event(`→ ${se.summary}`);
				}
			},
		});
		let lineBuf = "";
		let stderrBuf = "";
		let aborted = false;
		let settledMain = false;
		let killArmed = false;
		let killWatchdog: ReturnType<typeof setTimeout> | undefined;
		let settleTimer: ReturnType<typeof setTimeout> | undefined;
		let exitSettleTimer: ReturnType<typeof setTimeout> | undefined;
		const STDERR_CAP = 16 * 1024;
		const LINE_CAP = 16 * 1024 * 1024;
		const startedAt = Date.now();
		const cleanup = () => {
			options.signal?.removeEventListener("abort", onAbort);
			clearTimeout(killWatchdog);
			clearTimeout(settleTimer);
			clearTimeout(exitSettleTimer);
		};
		const terminateChild = () => {
			if (killArmed) return;
			killArmed = true;
			try { child.kill("SIGTERM"); } catch { /* ignore */ }
			killWatchdog = setTimeout(() => {
				try { child.kill("SIGKILL"); } catch { /* ignore */ }
				settleTimer = setTimeout(() => {
					cleanup();
					reject(new Error(`super-dev [${label}]: killed after SIGTERM+SIGKILL (no exit within ${SETTLE_GRACE_MS}ms)`));
				}, SETTLE_GRACE_MS);
			}, SIGTERM_GRACE_MS);
		};
		const finishMain = (result: SpawnResult): void => {
			if (settledMain) return;
			settledMain = true;
			// v0.3.28 full-field parity: terminal usage summary on success — usage
			// comes from driver.usage (message_end is intercepted there); turns are
			// the counted turn_start events; tools from tool_execution_start ticks.
			if (!result.error && !aborted) {
				const u = driver.usage;
				onProgress?.event(agentTerminalLine("subprocess", label, "completed", {
					model: result.model ?? u.model, turns, toolCalls: Math.max(usageStats.toolCalls, 0),
					input: u.input, output: u.output, cacheRead: u.cacheRead, cacheWrite: u.cacheWrite,
					cost: u.cost, durationMs: Date.now() - startedAt,
				}));
			}
			terminateChild(); // we own the child's lifetime; it never self-exits
			resolve(result);
		};
		const onAbort = () => {
			aborted = true;
			onProgress?.event(`subprocess ${label}: aborted by parent signal; terminating child pi`);
			// v0.3.60 R5 (canon rpc.md): clear_queue BEFORE abort — queued steering /
			// follow-up work must not survive into the checkpointed session.
			// v0.3.61: the checkpoint is bounded and AWAITED (same 4s+4s budget as
			// the timeout path) — the previous raw id-less fire-and-forget writes
			// raced the SIGTERM and the checkpoint was usually discarded by the
			// kill. Fail-open: a failed checkpoint only costs the log line.
			void (async () => {
				if (settledMain) return;
				const q = await driver.sendControl("clear_queue", 4_000);
				const a = await driver.sendControl("abort", 4_000);
				onProgress?.event(`subprocess ${label}: aborted by parent signal — clear_queue=${q.ok ? "ok" : `failed (${q.error ?? "?"})`} abort=${a.ok ? "ok" : `failed (${a.error ?? "?"})`} (checkpoint before kill)`);
				driver.dispose("aborted");
				finishMain({ text: "", control: null, error: "aborted" });
			})();
		};
		options.signal?.addEventListener("abort", onAbort, { once: true });
		if (options.signal?.aborted) onAbort(); // close the registration window

		void (async () => {
			// v0.3.60 R5 (canon rpc.md): a TIMED-OUT turn must CHECKPOINT, not just
			// die — clear_queue then abort lets the child persist partial work to
			// its session file before terminateChild kills it (killing discards both
			// queued and running work). Bounded at 4s per command and fail-open: a
			// failed checkpoint only costs the log line, the kill proceeds anyway.
			// clear_queue needs a pi that implements it — at the 0.82.x peer floor
			// the child answers "Unknown command" and the checkpoint fail-opens to
			// abort-only (both outcomes logged honestly either way).
			const gracefulCheckpoint = async (why: string): Promise<void> => {
				if (aborted || settledMain || driver.isDisposed) return;
				const q = await driver.sendControl("clear_queue", 4_000);
				const a = await driver.sendControl("abort", 4_000);
				onProgress?.event(`subprocess ${label}: ${why} — clear_queue=${q.ok ? "ok" : `failed (${q.error ?? "?"})`} abort=${a.ok ? "ok" : `failed (${a.error ?? "?"})`} (checkpoint before kill)`);
			};
			const turn1 = await driver.send("prompt", options.task, timeoutMs);
			if (aborted || settledMain) return;
			if (turn1.error) await gracefulCheckpoint("turn timed out");
			if (aborted || settledMain) return;
			const control1 = resolveTurnControl(turn1.text, options.capturePath, options.controlKeys);
			const first: SpawnResult = { text: turn1.text, control: control1, model: turn1.model, error: turn1.error };
			const corrective = first.error ? null : options.correctiveFor(first);
			const remainingMs = timeoutMs - (Date.now() - startedAt);
			// One corrective turn max (session-backend parity), and only when the
			// remaining budget plausibly covers a real turn.
			if (corrective && remainingMs > 15_000) {
				onProgress?.event(`↻ ${label}: corrective rpc follow_up (same session, remaining ${Math.round(remainingMs / 1000)}s)`);
				// review F-1: reset capture presence before the corrective turn — a
				// PARTIAL capture from turn 1 (the child tool cannot reject it; the
				// schema declares keys without requiring any) must not mask turn 2's
				// fresh tool or text-channel delivery in resolveTurnControl.
				if (options.capturePath) {
					try { unlinkSync(options.capturePath); } catch { /* absent is the normal fresh state */ }
				}
				// Verified live: a `follow_up` event after agent_settled is ACKED
				// (response success + queue_update) but the turn NEVER RUNS — 286s
				// of silence in the E2E probe. A second `prompt` event on the SAME
				// process DOES start the next in-memory turn (probe3: turn-2 recalled
				// the turn-1 secret verbatim), so the corrective rides a prompt
				// event. Same session, same memory — only the event type differs.
				const turn2 = await driver.send("prompt", corrective, remainingMs);
				if (aborted || settledMain) return;
				if (turn2.error) await gracefulCheckpoint("corrective turn timed out");
				if (aborted || settledMain) return;
				const control2 = resolveTurnControl(turn2.text, options.capturePath, options.controlKeys);
				finishMain({
					text: turn2.text || first.text,
					control: control2 ?? control1,
					model: turn2.model ?? first.model,
					error: turn2.error,
				});
				return;
			}
			finishMain(first);
		})().catch((error) => {
			const text = driver.currentText;
			finishMain({
				text,
				control: resolveTurnControl(text, options.capturePath, options.controlKeys),
				error: error instanceof Error ? error.message : String(error),
			});
		});

		child.stdout.on("data", (chunk: string) => {
			lineBuf += chunk;
			let nl: number;
			while ((nl = lineBuf.indexOf("\n")) >= 0) {
				const raw = lineBuf.slice(0, nl);
				lineBuf = lineBuf.slice(nl + 1);
				driver.ingest(raw);
			}
			if (lineBuf.length > LINE_CAP) lineBuf = lineBuf.slice(-LINE_CAP);
		});
		child.stderr.on("data", (chunk: string) => {
			stderrBuf += chunk;
			if (stderrBuf.length > STDERR_CAP) stderrBuf = stderrBuf.slice(stderrBuf.length - STDERR_CAP);
		});
		child.on("error", (err) => {
			driver.dispose("spawn failed"); // review F-7: cancel the pending turn timer — the promise already rejects
			cleanup();
			const pathPreview = (process.env.PATH ?? "").split(":").slice(0, 8).join(":");
			reject(new Error(`super-dev [${label}]: failed to spawn pi: ${err.message}; cwd=${options.cwd}; PATH=${pathPreview || "(empty)"}`));
		});
		// v0.3.1 F5 (cumora lesson): settle abnormal exits on `exit`, not only on
		// `close` — grandchildren can inherit the stdio pipes, so `close` may never
		// fire after the child dies. The exit handler schedules the same settle
		// after SETTLE_GRACE_MS, cancelable when `close` DOES fire (close also
		// flushes the residual line buffer first, which this path cannot).
		child.on("exit", (code) => {
			if (settledMain) return;
			exitSettleTimer = setTimeout(() => {
				if (settledMain) return;
				// sd31-SD31-4/F-06: flush the residual stdout line buffer exactly like
				// the close path — a final newline-less assistant message_end must not
				// be dropped just because `close` never fired.
				if (lineBuf.trim()) driver.ingest(lineBuf.trim());
				const tail = stderrBuf.trim().split("\n").slice(-3).join(" | ");
				onProgress?.event(`subprocess ${label}: exit=${code ?? "signal"} with no close event (pipe held by descendant?) — settling${tail ? ` stderrTail=${tail}` : ""}`);
				driver.dispose("process exited (no close)");
				const text = driver.currentText;
				settledMain = true;
				cleanup();
				resolve({
					text,
					control: resolveTurnControl(text, options.capturePath, options.controlKeys),
						error: `process exited before turn completion (exit ${code ?? "signal"}, no close event)`,
				});
			}, SETTLE_GRACE_MS);
		});
		child.on("close", (code) => {
			cleanup();
			if (lineBuf.trim()) driver.ingest(lineBuf.trim());
			const tail = stderrBuf.trim().split("\n").slice(-3).join(" | ");
			onProgress?.event(`subprocess ${label}: close exit=${code ?? "signal"}${tail ? ` stderrTail=${tail}` : ""}`);
			// review F-6: an immediate non-zero exit with ZERO rpc events is the
			// signature of a host pi that lacks --mode rpc support (peer floor
			// pi@0.82.1) — surface the escape hatch instead of a bare failure.
			if (code !== 0 && rawEventCount === 0 && Date.now() - startedAt < 3000) {
				onProgress?.event(`subprocess ${label}: hint: host pi exited with no rpc events — it may not support --mode rpc (peer floor pi@0.82.1); set SUPER_DEV_NO_RPC_SPAWN=1 for the json fallback`);
			}
			if (!settledMain) {
				driver.dispose("process exited");
				const text = driver.currentText;
				settledMain = true; // the ladder reject below must not double-settle
				resolve({
					text,
					control: resolveTurnControl(text, options.capturePath, options.controlKeys),
					error: `process exited before turn completion (exit ${code ?? "signal"})`,
				});
			}
		});
	});
}

interface PiJsonEvent {
	type?: string;
	toolName?: string;
	args?: Record<string, unknown>;
	message?: {
		role?: string;
		model?: string;
		content?: Array<{ type: string; text?: string }>;
		/** v0.3.28: the child's assistant message_end carries full usage —
		 *  same shape as session.messages entries (verified live). */
		usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; cost?: { total?: number } };
	};
}

/** If an event is an assistant message_end, return its text + model (shared by
 *  the streaming capture and the batch extractFinalAssistant). */
function assistantFromMessageEnd(ev: PiJsonEvent): { text: string; model?: string; usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; cost?: { total?: number } } } | null {
	if (ev.type !== "message_end" || ev.message?.role !== "assistant") return null;
	const text = (ev.message.content ?? [])
		.filter((p) => p.type === "text" && typeof p.text === "string")
		.map((p) => p.text as string)
		.join("");
	return { text, model: ev.message.model, usage: ev.message.usage }; // v0.3.28: usage rides along for the terminal summary
}

// v0.3.28: live usage accounting moved to progress-lines.ts (shared with rpc-driver.ts).

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
