/**
 * Shared agent-execution runtime utilities — the single home for model/thinking
 * resolution, per-role extension packages, and display helpers used by the
 * pi-subagents delegation backend (the ONLY specialist backend since v0.3.64),
 * the sd-* registration, and the workflow engine.
 *
 * History: these lived in pi-spawn.ts (the deleted subprocess backend) and
 * session-agent.ts (the deleted in-process backend). v0.3.64 removed both
 * backends — every specialist call now routes through pi-subagents' structured
 * delegation — so their shared utilities moved here unchanged, and everything
 * backend-specific (spawn/RPC machinery, per-stage schema corrective
 * re-prompting) was deleted with them. Do not grow this module into a backend:
 * agent EXECUTION belongs to delegation-backend.ts; this file only holds pure
 * resolution/resolution-adjacent helpers.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { getConfig, superDevEnv } from "../render/super-dev-dir.ts";
import { sanitizeSlug } from "../setup.ts";
import {
	createAgentSession,
	defineTool,
	getAgentDir,
	DefaultResourceLoader,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

// ─── Role classification ─────────────────────────────────────────────────────

/** Agents that drive a browser for UI testing. Since v0.3.64 their sd-*
 *  registration carries the pi-browser-cdp-extension entry paths as per-agent
 *  `extensions`, so the delegated child loads the `browser_execute` tool
 *  (verified against pi-subagents 0.64 `-e` CLI children AND 0.65 in-process
 *  children on 2026-09-04: both expose the tool to the child). Recursion stays
 *  prevented by the delegation tool split — children never receive the
 *  super_dev tool. */
const BROWSER_AGENTS = new Set(["qa-agent", "ui-tester"]);

export function isBrowserAgent(agent: string): boolean {
	return BROWSER_AGENTS.has(agent);
}

/** Agents that perform ONLINE RESEARCH. They need pi's web tools
 *  (`web_search` / `fetch_content` / `get_search_content` from the `pi-web-access`
 *  extension) AND the MCP gateway (`mcp` from `pi-mcp-adapter`) so they can pull
 *  EXTERNAL knowledge — best practices, library/framework docs, standards,
 *  pitfalls — for the requirement + BDD, rather than re-analyzing the local
 *  codebase (that is the code-assessment stage's job). Since v0.3.64 the sd-*
 *  registration carries those package entries as per-agent `extensions`
 *  (extensionsForAgent) — declaring extensions disables AMBIENT discovery for
 *  that child, which is exactly the isolation this role always had. */
const WEB_RESEARCH_AGENTS = new Set(["research-agent"]);

export function needsWebResearch(agent: string): boolean {
	return WEB_RESEARCH_AGENTS.has(agent);
}

// ─── Per-agent extension packages ────────────────────────────────────────────

/** The installed extensions a research agent explicitly loads. Order is
 *  irrelevant; each is resolved to its on-disk entry by extensionsForAgent(). */
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

/** Entry paths for every extension package an agent's role requires. Feeds the
 *  sd-* registration's per-agent `extensions` field (pi-subagents
 *  RuntimeAgentDefinition): the delegated child loads exactly these — 0.64 via
 *  `-e` on the spawned `pi` CLI child, 0.65 via in-process extensionPaths
 *  (verified live on both, 2026-09-04). */
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
 *  within one turn, so they get a much larger wall-clock budget (see
 *  defaultAgentTimeoutMs). The doc-writer default (480s + "explore ≤6, write
 *  the document") starves them: on a slow model, reading a 400+ line source
 *  file alone can exhaust 8 min BEFORE a single edit lands (observed root
 *  cause of the recurring phase-03 zero-edit / edit-thrash failures). */
const CODE_WRITING_AGENTS = new Set(["implementer", "tdd-guide"]);

export function isCodeWritingAgent(agent: string): boolean {
	return CODE_WRITING_AGENTS.has(agent);
}

// ─── Per-agent thinking configuration ────────────────────────────────────────

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
 * resolveAgentModel (which must send the BARE model id on every call) and the
 * per-call seam in workflow.ts. */
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
 *  env → INHERITED) WITHOUT the role-default fallback. Used to decide whether a
 *  thinking level is worth threading at all: it reaches the delegation request
 *  ONLY when an explicit per-call / SUPER_DEV_THINKING / inherited value
 *  resolves, so the byte-identical baseline (no thinking field, SCENARIO-002)
 *  is preserved when none does. The role default stays resolveThinking's
 *  concern, never an explicit creation option. */
export function resolveExplicitThinking(perCall?: ThinkingLevel, inherited?: ThinkingLevel): ThinkingLevel | undefined {
	if (perCall) return perCall;
	const env = asThinkingLevel(superDevEnv("SUPER_DEV_THINKING"));
	if (env) return env;
	return inherited;
}

/** Resolve an EXPLICIT model id with precedence: explicit param → SUPER_DEV_MODEL
 *  env → undefined. The INHERITED main-session model is NOT handled here — it is
 *  an object threaded separately (inheritedModelObject) and derived into a
 *  qualified `provider/id` in the delegation request. Returns undefined when no
 *  explicit tier supplies a value (SCENARIO-003/004 — preserves the
 *  no-default rule). */
export function resolveModel(explicit?: string): string | undefined {
	const ex = explicit?.trim();
	if (ex) return ex;
	const env = superDevEnv("SUPER_DEV_MODEL")?.trim();
	return env || undefined;
}

// ─── Timeouts, skills, lifecycle ─────────────────────────────────────────────

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

/** The default wall-clock cap for an agent, by role. Overridable per-call via
 *  AgentCall.timeoutMs (threaded through `common` in workflow.ts). */
export function defaultAgentTimeoutMs(agent: string): number {
	return isCodeWritingAgent(agent) ? CODE_WRITING_TIMEOUT_MS : DEFAULT_SPAWN_TIMEOUT_MS;
}

/** W4 (v0.2.10): skills are a CAPABILITY, not ambient noise — v0.3.59: ONE
 *  switch governs skills across every specialist surface (now: the sd-*
 *  registration's inheritSkills). `SUPER_DEV_NO_SKILLS=1` restores the
 *  pre-v0.2.10 full isolation for debugging/CI. */
export function skillsEnabled(env: { SUPER_DEV_NO_SKILLS?: string } = {
	SUPER_DEV_NO_SKILLS: superDevEnv("SUPER_DEV_NO_SKILLS"),
}): boolean {
	return env.SUPER_DEV_NO_SKILLS !== "1";
}

// ─── Display helpers ─────────────────────────────────────────────────────────

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

/** One-line summary of a tool call for progress logs (name + key arg). */
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

// ─── Live-session thinking application ───────────────────────────────────────

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

// ─── Model-inheritance type ──────────────────────────────────────────────────

/** The `Model<any>` createAgentSession's `model` option expects, derived from
 *  its own typed signature so we never reach for the (transitive)
 *  @earendil-works/pi-ai Model type directly. */
export type SessionModelOption = NonNullable<NonNullable<Parameters<typeof createAgentSession>[0]>["model"]>;

// ─── Content-aware slug summarization (setup stage) ─────────────────────────

export function taskFilePaths(task: string): string[] {
	const out: string[] = [];
	const push = (raw: string) => {
		const s = raw.replace(/^[.,;:()\[\]"']+/g, "").replace(/[.,;:()\[\]"']+$/g, "");
		if (s && !out.includes(s)) out.push(s);
	};
	for (const m of task.matchAll(/@([\w.~/-]+\.[A-Za-z0-9]+)/g)) push(m[1]);
	for (const m of task.matchAll(/(?<!\w)(~\/[\w.-]+(?:\/[\w.-]+)*\.[A-Za-z0-9]+)/g)) push(m[1]);
	for (const m of task.matchAll(/(?<![\w@~/.-])((?:[\w.-]+\/)+[\w.-]+\.[A-Za-z0-9]+)/g)) push(m[1]);
	return out.slice(0, 4);
}

/** Bounded content excerpts of task-referenced files so the slug model can
 *  summarize WHAT the referenced requirement asks for instead of echoing its
 *  FILENAME (incident: `docs/requirements/16-dimension-financials.md` → LLM
 *  slug "16-dimension-financials" → spec id "16-16-dimension-financials").
 *  First ~6 KB per file (title/purpose lives up front), at most 3 files,
 *  unreadable/missing/directory references skipped silently. */
export function taskFileExcerpts(task: string, cwd: string): Array<{ path: string; excerpt: string }> {
	const out: Array<{ path: string; excerpt: string }> = [];
	for (const ref of taskFilePaths(task)) {
		if (out.length >= 3) break;
		const abs = ref.startsWith("~/") ? join(homedir(), ref.slice(2)) : isAbsolute(ref) ? ref : resolve(cwd, ref);
		let text: string;
		try {
			if (!statSync(abs).isFile()) continue;
			text = readFileSync(abs, "utf8");
		} catch { continue; }
		const excerpt = text.slice(0, 6000).trim();
		if (excerpt) out.push({ path: ref, excerpt });
	}
	return out;
}

/** Local capture shape for the slug structured_output tool. */
interface SlugCapture { called: boolean; value: unknown }

/** Ask the model for a concise 2-5 word kebab-case slug summarizing the task.
 *  When the task references files (requirement/design docs), their CONTENT is
 *  excerpted into the prompt so the slug describes the actual subject matter
 *  rather than echoing a filename — and index numerals are explicitly barred
 *  (the pipeline prepends its own number; a numeral echo produced the
 *  "16-16-dimension-financials" double-index spec id). Minimal in-process
 *  session (dev/setup utility — NOT the specialist pipeline): no coding tools,
 *  only a structured_output tool — fast and cheap. Returns "" on any
 *  failure/timeout so the caller can fall back to the deterministic
 *  slugifyTask. */
export async function summarizeSlug(task: string, cwd: string, opts: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<string> {
	// SD-04 (NFR-6): pre-aborted signal — the post-creation listener would never
	// fire; skip the session entirely and let the caller use the deterministic
	// fallback slug.
	if (opts.signal?.aborted) return "";
	const timeoutMs = opts.timeoutMs ?? 20_000;
	const capture: SlugCapture = { called: false, value: undefined };
	const agentDir = getAgentDir();
	let session;
	try {
		// Isolate the slug session identically to specialist sessions (#11): without
		// an explicit resourceLoader it would discover ambient extensions/skills from
		// the pi agent dir, inconsistent with the isolation contract every other
		// session honors. A slug generator needs none of them.
		const settingsManager = SettingsManager.create(cwd, agentDir);
		const resourceLoader = new DefaultResourceLoader({
			cwd,
			agentDir,
			settingsManager,
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
			appendSystemPromptOverride: () => [],
			agentsFilesOverride: () => ({ agentsFiles: [] }),
		});
		await resourceLoader.reload();
		({ session } = await createAgentSession({
			cwd,
			agentDir,
			sessionManager: SessionManager.inMemory(cwd),
			settingsManager,
			resourceLoader,
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
	// SD-04 (NFR-6): close the registration window (abort landed during the
	// awaited session creation above) — the listener would never fire.
	if (opts.signal?.aborted) onAbort();
	try {
		const excerpts = taskFileExcerpts(task, cwd);
		const fileContext = excerpts.length === 0
			? ""
			: `\nReferenced files (content excerpts — derive the subject from this CONTENT, never from file names):\n${excerpts.map((f) => `--- ${f.path} ---\n${f.excerpt}`).join("\n\n")}\n`;
		await session.prompt(`Summarize this software task into a concise 2-5 word kebab-case slug (lowercase, words joined by single hyphens, no articles or filler words like "implement/add/feature").\nRules:\n- Name WHAT the work delivers, based on the task text and the CONTENT of the referenced files below — do not echo file or directory names.\n- Never include index or sequence numbers (the pipeline prepends its own number to the spec id); keep an identifier only if it is genuinely part of the feature name in the task text.\nTask:\n"""${task}"""\n${fileContext}Call structured_output with {slug}.`);
	} catch { /* timeout/abort → fallback */ }
	clearTimeout(timer);
	opts.signal?.removeEventListener("abort", onAbort);
	session.dispose();
	const raw = capture.called ? String((capture.value as { slug?: unknown })?.slug ?? "") : "";
	return sanitizeSlug(raw);
}
