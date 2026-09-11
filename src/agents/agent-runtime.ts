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
import { getConfig, superDevEnv, type ToolBudgetValue } from "../render/super-dev-dir.ts";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
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
/**
 * v0.3.74 P2-e: the two writer agents that had the self-commit incidents
 * (run 2026-09-05T23-09-55-596Z: implementer commits 2e92da3 / 5d4790d) carry
 * the commit-guard child extension — a pi `tool_call` hook that BLOCKS
 * commit-class git invocations at the tool layer (mechanical prevention; the
 * v0.3.73 HEAD-drift detector stays as the fail-open detective net).
 *
 * v0.3.74 dual review F1/F2: the guard rides `subagentOnlyExtensions`, NOT
 * `extensions` — pi-subagents disables AMBIENT extension discovery for a child
 * whenever `input.extensions !== undefined` (child-tool-plan.ts:403), which
 * would silently strip the user's MCP/tools from exactly these two agents
 * (against the user's "subagents same as pi itself" decision). The
 * child-only field loads the guard without touching ambient discovery. The
 * path is existsSync-verified with a WARN-once degrade to absent (fail-open,
 * same posture as a missing extension package).
 */
const COMMIT_GUARD_AGENTS = new Set(["implementer", "tdd-guide"]);
let commitGuardPathWarned = false;
export function commitGuardExtensionPath(agent: string): string | null {
	if (!COMMIT_GUARD_AGENTS.has(agent)) return null;
	if (superDevEnv("SUPER_DEV_NO_COMMIT_GUARD") === "1") return null;
	const path = fileURLToPath(new URL("../child-guards/commit-guard.ts", import.meta.url));
	if (!existsSync(path)) {
		if (!commitGuardPathWarned) {
			commitGuardPathWarned = true;
			console.warn(`[super-dev] commit guard not found at ${path} — implementer/tdd-guide run unguarded (v0.3.73 HEAD-drift detector remains; this warning appears once per process)`);
		}
		return null;
	}
	return path;
}

export function extensionsForAgent(agent: string): string[] {
	const packages = [
		...(needsWebResearch(agent) ? RESEARCH_EXTENSION_PACKAGES : []),
		...(isBrowserAgent(agent) ? BROWSER_EXTENSION_PACKAGES : []),
	];
	const agentDir = piAgentDir();
	return packages.flatMap((p) => resolveExtensionEntries(p, agentDir));
}

/** v0.3.86 F-13 — the SAFETY guard child extension (dangerous-bash denylist +
 *  protected-file writes; the tables live in child-guards/safety-guard.ts and
 *  are re-exported by src/safety.ts). Unlike the commit guard this rides EVERY
 *  registered agent (any child with a bash/write tool gets the same floor; the
 *  legit-flow audit is documented at the guard file). Same registration
 *  mechanics: existsSync-verified path, WARN-once degrade to absent, kill
 *  switch SUPER_DEV_NO_SAFETY_GUARD=1 (fail-open — the deterministic gates and
 *  the service-bringup screening remain). */
let safetyGuardPathWarned = false;
export function safetyGuardExtensionPath(_agent: string): string | null {
	if (superDevEnv("SUPER_DEV_NO_SAFETY_GUARD") === "1") return null;
	const path = fileURLToPath(new URL("../child-guards/safety-guard.ts", import.meta.url));
	if (!existsSync(path)) {
		if (!safetyGuardPathWarned) {
			safetyGuardPathWarned = true;
			console.warn(`[super-dev] safety guard not found at ${path} — delegated agents run without the bash/protected-write safety hook (deterministic gates remain; this warning appears once per process)`);
		}
		return null;
	}
	return path;
}

// ─── Config-driven extension entries (v0.3.78) ─────────────────────────────

/** Normalize a config-declared package name: users copy `npm:pkg` install
 *  ids; the node_modules layout needs the bare package name. */
export function normalizeExtensionPackageName(pkg: string): string {
	return pkg.startsWith("npm:") ? pkg.slice(4) : pkg;
}

const warnedMissingConfigExtensions = new Set<string>();
const warnedMalformedConfigKeys = new Set<string>();

/** v0.3.78 review fix (dual fresh-context 2026-09-08, both reviewers probe-
 *  verified): getConfig does ZERO runtime type validation, and a wrong-type
 *  container (`commonExtensions: 42`, or the single-string typo
 *  `"nowledge-mem-pi"`) used to throw/decay per-character OUT of the fail-
 *  open contract — the throw fired inside registerOne's request literal and
 *  unregistered EVERY capability agent for the session. Loud fallback
 *  instead: malformed container → [] with ONE warn per key per process
 *  (v0.3.72 M3 / v0.3.74 P1-c convention). */
function stringListOr(value: unknown, key: string, warn?: (message: string) => void): string[] {
	if (Array.isArray(value)) return value;
	if (value === undefined || value === null) return [];
	if (!warnedMalformedConfigKeys.has(key)) {
		warnedMalformedConfigKeys.add(key);
		warn?.(`super-dev: config key "${key}" must be an array of strings — got ${typeof value}; ignoring it (fix ~/.super-dev/config.json)`);
	}
	return [];
}

/** Per-role lookup accepting BOTH the bare role name (consistent with
 *  agentModels/agentThinking/agentSkills) and the `sd-`-prefixed form users
 *  see in pi's agent listings (v0.3.78 review code-F2: the prefixed form was
 *  a silent no-op). Bare key wins when both are present. */
function roleEntry<T>(map: unknown, agent: string): T | undefined {
	if (map === null || typeof map !== "object") return undefined;
	const m = map as Record<string, unknown>;
	const bare = m[agent];
	if (bare !== undefined) return bare as T;
	return m[`sd-${agent}`] as T | undefined;
}

/** v0.3.78 — config-declared extension entries for an agent's
 *  subagentOnlyExtensions registration: `commonExtensions` (every CAPABILITY
 *  agent; mechanical one-shot classifiers excluded — scope decision
 *  2026-09-08) plus `agentExtensions[role]` (explicit per-role additions,
 *  honored for ANY role including mechanical ones — explicit config beats
 *  scope defaults; `sd-`-prefixed keys accepted). Union, deduplicated,
 *  `npm:` prefix normalized, malformed containers degraded loudly to absent.
 *  Missing packages degrade to absent with ONE warn per package per process
 *  (the run continues — same policy as the hardcoded role packages). Never
 *  throws: unreadable config → [] (getConfig itself swallows parse errors to
 *  DEFAULT_CONFIG; the catch is defense-in-depth). Kept injectable
 *  (config/agentDir/warn) for unit tests, mirroring resolveExtensionEntries. */
export function configExtensionEntriesForAgent(
	agent: string,
	opts?: { config?: { commonExtensions?: unknown; agentExtensions?: unknown }; agentDir?: string; warn?: (message: string) => void },
): string[] {
	let common: string[] = [];
	let perRole: string[] = [];
	try {
		const config = opts?.config ?? getConfig();
		if (!MECHANICAL_CLASSIFIER_ROLES.has(agent)) common = stringListOr(config.commonExtensions, "commonExtensions", opts?.warn);
		perRole = stringListOr(roleEntry<string[]>(config.agentExtensions, agent), `agentExtensions[${agent}]`, opts?.warn);
	} catch {
		return []; // config unreadable → no config-driven extensions; role-hardcoded ones are unaffected
	}
	const packages = [...new Set([...common, ...perRole].map((p) => normalizeExtensionPackageName(String(p).trim())).filter((p) => p.length > 0))];
	if (packages.length === 0) return [];
	const agentDir = opts?.agentDir ?? piAgentDir();
	const resolved: string[] = [];
	for (const pkg of packages) {
		const entries = resolveExtensionEntries(pkg, agentDir);
		if (entries.length === 0) {
			if (!warnedMissingConfigExtensions.has(pkg)) {
				warnedMissingConfigExtensions.add(pkg);
				opts?.warn?.(`super-dev: config extension package "${pkg}" is not installed (applies to all agents; first seen on ${agent}) — skipping (install with: pi install npm:${pkg})`);
			}
			continue;
		}
		resolved.push(...entries);
	}
	return resolved;
}

/** v0.3.82: extension PACKAGE names an agent declares — role-hardcoded
 *  (browser/web-research, static names) ∪ config commonExtensions ∪
 *  agentExtensions[role]. No filesystem resolution: this feeds the mechanical
 *  tool-index lookup (a declared-but-uninstalled package simply contributes
 *  nothing — the tool index only holds tools of extensions that DID load). */
export function extensionPackagesForAgent(
	agent: string,
	opts?: { config?: { commonExtensions?: unknown; agentExtensions?: unknown }; warn?: (message: string) => void },
): string[] {
	const role = isBrowserAgent(agent) ? BROWSER_EXTENSION_PACKAGES : (needsWebResearch(agent) ? RESEARCH_EXTENSION_PACKAGES : []);
	let declared: string[] = [];
	try {
		const config = opts?.config ?? getConfig();
		// v0.3.82 r2 review fix (code-R2-1): thread the warn sink — this function
		// runs BEFORE configExtensionEntriesForAgent's loud call in the real
		// registration path, so an un-threaded stringListOr silently consumes the
		// shared warnedMalformedConfigKeys memo and the loud fallback never fires.
		const common = MECHANICAL_CLASSIFIER_ROLES.has(agent) ? [] : stringListOr(config.commonExtensions, "commonExtensions", opts?.warn);
		const perRole = stringListOr(roleEntry<string[]>(config.agentExtensions, agent), "agentExtensions[" + agent + "]", opts?.warn);
		declared = [...common, ...perRole];
	} catch {
		declared = [];
	}
	return [...new Set([...role, ...declared].map((p) => normalizeExtensionPackageName(String(p).trim())).filter((p) => p.length > 0))];
}

export function configExtensionToolsForAgent(
	agent: string,
	opts?: { config?: { commonExtensions?: unknown; agentExtensions?: unknown }; warn?: (message: string) => void; toolIndex?: ReadonlyMap<string, readonly string[]> },
): string[] {
	// v0.3.82: MECHANICAL ONLY. Declaring an extension (commonExtensions /
	// agentExtensions / role-hardcoded) is sufficient — every tool the loaded
	// extension registered is merged onto this agent allowlist automatically.
	// The index is built once (deferred to the first session_start — see
	// buildToolIndex; pi.getAllTools() THROWS during activation) from
	// pi.getAllTools() package-attributed via sourceInfo. The explicit-name
	// config keys (commonExtensionTools / agentExtensionTools) were removed;
	// the all-tools mode moved to the boolean allTools / agentAllTools keys
	// (toolsWildcardForAgent).
	const declared = extensionPackagesForAgent(agent, opts?.config || opts?.warn ? { config: opts?.config, warn: opts?.warn } : undefined);
	const mechanical: string[] = [];
	for (const pkg of declared) {
		const tools = opts?.toolIndex?.get(pkg);
		if (tools) mechanical.push(...tools);
		else if (opts?.warn && !warnedZeroToolPackages.has(pkg)) {
			// v0.3.82 dual review (adv-F2): a declared package contributing ZERO
			// tools used to be a silent empty merge — the exact silent-loss class
			// this feature replaced. Loud once per package: tool-less hook-only
			// packages (nowledge-mem) legitimately hit this; so do attribution
			// misses and lazily-registered tools (mcp__* direct tools register
			// per-server — use the all-tools mode for those).
			warnedZeroToolPackages.add(pkg);
			opts.warn(`super-dev: config extension package "${pkg}" contributed no tools to the mechanical merge (registers none, or registers lazily — e.g. per-server mcp__* direct tools, for which the allTools mode exists) — its hooks still load in children`);
		}
	}
	return [...new Set(mechanical.map((t) => String(t).trim()).filter((t) => t.length > 0))];
}

const warnedZeroToolPackages = new Set<string>();

/** v0.3.82 dual review (BLOCKER, empirically probed): pi.getAllTools() THROWS
 *  during extension activation — pi stubs action methods with notInitialized
 *  until _bindExtensionCore (which runs after every extension factory), and
 *  the load-order bet was wrong anyway (settings.json packages-array order,
 *  not alphabetical). The index is therefore built DEFERRED (first
 *  session_start); these helpers are the testable core. */
export function buildToolIndexFromTools(
	tools: Array<{ name: string; sourceInfo?: { source?: string; path?: string } }>,
): Map<string, string[]> {
	// Scoped-package-aware: node_modules/@scope/pkg/ must capture the FULL
	// "@scope/pkg" (the naive [^\\/]+ capture truncated to "@scope" — adv-F3).
	const re = /node_modules[\\/]((?:@[^\\/]+[\\/])?[^\\/]+)[\\/]/;
	const toolIndex = new Map<string, string[]>();
	for (const t of tools) {
		const source = t.sourceInfo?.source ?? "";
		const sourcePath = t.sourceInfo?.path ?? "";
		// F-15 (v0.3.86): normalize to FORWARD slashes — on Windows the capture
		// yields `@scope\pkg`, and downstream lookups query normalized
		// `@scope/pkg`, so every scoped-package tool silently missed its allowlist.
		const pkg = (source.startsWith("npm:") ? source.slice(4) : (re.exec(sourcePath)?.[1] ?? "")).replace(/\\/g, "/");
		// Built-ins carry source "builtin" + synthetic "<builtin:name>" paths
		// (no node_modules segment) and fall out at the empty-pkg guard; the
		// pi-package guard covers the path-attributed fallback (scoped name).
		if (!pkg || pkg === "pi-coding-agent" || pkg.endsWith("/pi-coding-agent")) continue;
		const list = toolIndex.get(pkg);
		if (list) list.push(t.name);
		else toolIndex.set(pkg, [t.name]);
	}
	return toolIndex;
}

/** Thin wrapper: read pi.getAllTools() and attribute; NEVER throws — on
 *  failure returns the empty index plus the error text so the caller can WARN
 *  (a silent empty index is the universal silent-loss failure mode). */
export function buildToolIndex(pi: {
	getAllTools?: () => Array<{ name: string; sourceInfo?: { source?: string; path?: string } }>;
}): { toolIndex: Map<string, string[]>; error?: string } {
	try {
		return { toolIndex: buildToolIndexFromTools(pi.getAllTools?.() ?? []) };
	} catch (err) {
		return { toolIndex: new Map(), error: err instanceof Error ? err.message : String(err) };
	}
}

/** v0.3.82: the all-tools MODE — config.allTools (capability agents;
 *  mechanical classifiers excluded, same scope predicate) or
 *  agentAllTools[role] (any role, explicit beats scope). True means the
 *  registration OMITS the tools pin (the only correct "all tools": pi's
 *  allowedToolNames is an exact-match Set). Never throws. */
export function toolsWildcardForAgent(
	agent: string,
	opts?: { config?: { allTools?: unknown; agentAllTools?: unknown }; warn?: (message: string) => void },
): boolean {
	try {
		const config = opts?.config ?? getConfig();
		// v0.3.82 dual review (code-F4): the v0.3.78 loud-fallback contract —
		// malformed container → ONE warn naming the key — must hold for the new
		// keys too (allTools: "yes" / 42 silently coerced to false otherwise).
		if (config.allTools !== undefined && typeof config.allTools !== "boolean" && opts?.warn && !warnedMalformedConfigKeys.has("allTools")) {
			warnedMalformedConfigKeys.add("allTools");
			opts.warn(`super-dev: config key "allTools" must be a boolean — got ${typeof config.allTools}; ignoring it (fix ~/.super-dev/config.json)`);
		}
		if (config.agentAllTools && typeof config.agentAllTools === "object") {
			const perRole = roleEntry<unknown>(config.agentAllTools as Record<string, unknown>, agent);
			if (perRole !== undefined && typeof perRole !== "boolean" && opts?.warn && !warnedMalformedConfigKeys.has(`agentAllTools[${agent}]`)) {
				warnedMalformedConfigKeys.add(`agentAllTools[${agent}]`);
				opts.warn(`super-dev: config key "agentAllTools[${agent}]" must be a boolean — got ${typeof perRole}; ignoring it (fix ~/.super-dev/config.json)`);
			}
			if (perRole !== undefined) return perRole === true;
		}
		if (MECHANICAL_CLASSIFIER_ROLES.has(agent)) return false;
		return config.allTools === true;
	} catch {
		return false;
	}
}

/** v0.3.87 (S4 decision 8) — the external-exploration tool families a
 *  resolved budget blocks. NEVER "*" (a hard-trip must leave local coding
 *  tools usable so the run can always finish). The MCP family carries the
 *  exact-name + prefix PAIR: the pi-mcp-adapter aggregate `mcp` tool plus
 *  the `mcp__` prefix entry for the mcp__<server>__<tool> direct-tool
 *  family. Verified against pi-subagents 0.67 on disk (2026-09-11):
 *  `block` accepts an array of non-empty strings or "*", and matching is
 *  EXACT-NAME (runs/shared/tool-budget.ts shouldBlockToolForBudget →
 *  block.includes(toolName)) — no prefix semantics upstream, so the
 *  `mcp__` entry is the declared family form and stays inert until upstream
 *  gains prefix matching (harmless either way: the aggregate `mcp` tool is
 *  the exact-match path that blocks). */
export const EXTERNAL_EXPLORATION_BLOCK_LIST = [
	"web_search",
	"fetch_content",
	"get_search_content",
	"source_check",
	"mcp",
	"mcp__",
] as const;

/** A config-resolved tool budget in the native pi-subagents spawn shape
 *  (RuntimeAgentDefinition.toolBudget → every dispatch of that agent). */
export interface ResolvedToolBudget {
	soft: number;
	hard: number;
	block: string[];
}

/** v0.3.87: loud-fallback parser for ONE budget value. Exactly
 *  `{ soft, hard }` — positive integers, soft ≤ hard, NO other keys (a
 *  stray `block` in config would otherwise be a silent no-op: the block
 *  list is fixed discipline, never policy input). Absent (undefined/null)
 *  is the documented opt-out — no warn. Malformed → ONE warn naming the key
 *  (shared warnedMalformedConfigKeys memo, reset via
 *  resetConfigExtensionWarnsForTests) and treated as absent. Never throws. */
function toolBudgetValueOr(
	value: unknown,
	key: string,
	warn?: (message: string) => void,
): ToolBudgetValue | undefined {
	if (value === undefined || value === null) return undefined;
	const shapeOk =
		typeof value === "object" && !Array.isArray(value) &&
		Object.keys(value).length === 2 &&
		typeof (value as { soft?: unknown }).soft === "number" &&
		typeof (value as { hard?: unknown }).hard === "number";
	if (shapeOk) {
		const { soft, hard } = value as { soft: number; hard: number };
		if (Number.isInteger(soft) && soft >= 1 && Number.isInteger(hard) && hard >= 1 && soft <= hard) {
			return { soft, hard };
		}
	}
	if (!warnedMalformedConfigKeys.has(key)) {
		warnedMalformedConfigKeys.add(key);
		warn?.(`super-dev: config key "${key}" must be { soft, hard } — positive integers with soft ≤ hard, no other keys — got ${JSON.stringify(value).slice(0, 60)}; ignoring it (fix ~/.super-dev/config.json)`);
	}
	return undefined;
}

/** v0.3.87 (S4 decisions 8/9/10) — resolve a role's tool-call budget, pure
 *  and exported for tests. `agentToolBudget[role] > commonToolBudget >
 *  none`; caps are STRICTLY OPT-IN (absent config → NO toolBudget sent).
 *  Mechanical one-shot classifiers NEVER get a budget — even with an
 *  explicit per-role entry (firmer than the extensions scope predicate: a
 *  single tiny call has no browsing to bound). `research-assist` is a
 *  CONFIG ROLE KEY ONLY (§13 — assist dispatches reuse research-agent, no
 *  agent file exists): it falls back to research-agent's entry before
 *  common. Accepts bare and `sd-`-prefixed agentToolBudget keys (roleEntry,
 *  the agentExtensions precedent; bare key wins when both are present).
 *  A malformed agentToolBudget CONTAINER (non-object) warns once naming the
 *  key and is treated as absent; malformed values warn once per key. An
 *  unreadable config degrades to no budget. Never throws. When a budget
 *  resolves it carries the fixed five-family block list (never "*"). */
export function resolveToolBudget(
	role: string,
	opts?: { config?: { commonToolBudget?: unknown; agentToolBudget?: unknown }; warn?: (message: string) => void },
): ResolvedToolBudget | undefined {
	if (MECHANICAL_CLASSIFIER_ROLES.has(role)) return undefined;
	try {
		const config = opts?.config ?? getConfig();
		let agentToolBudget: unknown = config.agentToolBudget;
		// null/undefined = the documented opt-out (silent — stringListOr/roleEntry
		// convention); any other non-object (or an array) is malformed → one warn.
		if (agentToolBudget !== undefined && agentToolBudget !== null && (typeof agentToolBudget !== "object" || Array.isArray(agentToolBudget))) {
			if (!warnedMalformedConfigKeys.has("agentToolBudget")) {
				warnedMalformedConfigKeys.add("agentToolBudget");
				opts?.warn?.(`super-dev: config key "agentToolBudget" must be an object mapping role → { soft, hard } — got ${typeof agentToolBudget}; ignoring it (fix ~/.super-dev/config.json)`);
			}
			agentToolBudget = undefined;
		}
		const perRole = toolBudgetValueOr(roleEntry<unknown>(agentToolBudget, role), `agentToolBudget[${role}]`, opts?.warn);
		if (perRole) return { ...perRole, block: [...EXTERNAL_EXPLORATION_BLOCK_LIST] };
		if (role === "research-assist") {
			// decision 9/10 + §13: the assist dispatch reuses research-agent —
			// its config entry is the per-role leg before common.
			const viaResearchAgent = toolBudgetValueOr(roleEntry<unknown>(agentToolBudget, "research-agent"), "agentToolBudget[research-agent]", opts?.warn);
			if (viaResearchAgent) return { ...viaResearchAgent, block: [...EXTERNAL_EXPLORATION_BLOCK_LIST] };
		}
		const common = toolBudgetValueOr(config.commonToolBudget, "commonToolBudget", opts?.warn);
		return common ? { ...common, block: [...EXTERNAL_EXPLORATION_BLOCK_LIST] } : undefined;
	} catch {
		return undefined; // config unreadable → no budget; caps are opt-in, never a crash
	}
}

/** Test isolation: clear the one-warn-per-package and per-key memos. */
export function resetConfigExtensionWarnsForTests(): void {
	warnedMissingConfigExtensions.clear();
	warnedMalformedConfigKeys.clear();
	warnedZeroToolPackages.clear();
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
/** v0.3.73 M4 (run 2026-09-05T23-09-55-596Z): reviewer roles need the same
 * headroom as code writers — seven exact-20:00 delegation timeouts in one
 * healthy run (spec-reviewer ×3, verify code-review ×2, adversarial ×1,
 * tests-review ×1) while completions ran 11–19.5 min. 20 min has zero margin
 * for review roles; 30 min matches the observed worst case (19m29s) plus ~50%
 * headroom. */
const REVIEW_TIMEOUT_MS = 1_800_000;

/** v0.3.73 M4: analytical review roles whose deliverable is a verdict over a
 * large artifact. Mirrors READ_ONLY_AGENTS' reviewer subset. */
const REVIEW_TIMEOUT_AGENTS = new Set([
	"code-reviewer",
	"adversarial-reviewer",
	"spec-reviewer",
	"requirements-reviewer",
	"bdd-reviewer",
	"design-reviewer",
]);

/** v0.3.84 (incident 2026-09-08T23-27-36-732Z): spec-writer produces THREE
 *  docs in one call (spec + implementation plan + task list; observed 62KB)
 *  and ran at 90-100% utilization of the 20-min default — 3 of 5 rounds died
 *  at exactly 1200s (one completion took 1082.9s). 30 min = worst observed
 *  completion + 50% headroom, the same calibration as the v0.3.73 M4 review
 *  tier. Surgical on evidence: other doc writers completed comfortably inside
 *  20 min in every observed run, so they stay on the default tier. */
const WRITER_TIMEOUT_MS = 1_800_000;
const HEAVY_WRITER_TIMEOUT_AGENTS = new Set(["spec-writer"]);

/** AC-23 (SCENARIO-049): SIGTERM → SIGKILL watchdog. A child that registered a
 *  SIGTERM handler and never exits (or whose grandchildren hold the stdio
 *  pipes) must not hold the run hostage — after this grace the ladder escalates
 *  to an uncatchable SIGKILL. */
export const SIGTERM_GRACE_MS = 10_000;

/** The default wall-clock cap for an agent, by role. Overridable per-call via
 *  AgentCall.timeoutMs (threaded through `common` in workflow.ts). */
/**
 * v0.3.74 P1-c (M4 design gap, run 2026-09-05T23-09-55-596Z: 7 reviewer
 * delegations died at exactly 20:00 because the tiers were hardcoded constants
 * with no operator knob — recalibrating for a slower model required a code
 * change and an extension reload). Each tier reads its env key per call
 * (superDevEnv reads process.env directly, so edits apply to new calls without
 * a restart, matching the fuse precedent). A positive finite number overrides
 * the tier constant; garbage is rejected LOUDLY (one WARN per variable per
 * process, v0.3.72 M3 loud-fallback convention) and the run proceeds on the
 * tier default.
 */
const timeoutWarned: Record<"code" | "review" | "writer" | "default", boolean> = { code: false, review: false, writer: false, default: false };
function timeoutTierMs(kind: "code" | "review" | "writer" | "default", envKey: string, fallback: number): number {
	const raw = superDevEnv(envKey);
	if (raw === undefined || raw === "") return fallback;
	const n = Number(raw);
	// v0.3.74 dual review F6: a sub-second value is a unit mistake (seconds
	// typed as ms), never an intentional agent timeout — treat it as garbage.
	if (Number.isFinite(n) && n >= 1_000) return n;
	if (!timeoutWarned[kind]) {
		timeoutWarned[kind] = true;
		console.warn(`[super-dev] ${envKey}=${JSON.stringify(raw)} is not a positive number of milliseconds — keeping the tier default ${fallback}ms (set e.g. ${envKey}=1800000; this warning appears once per variable per process)`);
	}
	return fallback;
}

export function defaultAgentTimeoutMs(agent: string): number {
	if (isCodeWritingAgent(agent)) return timeoutTierMs("code", "SUPER_DEV_CODE_TIMEOUT_MS", CODE_WRITING_TIMEOUT_MS);
	if (REVIEW_TIMEOUT_AGENTS.has(agent)) return timeoutTierMs("review", "SUPER_DEV_REVIEW_TIMEOUT_MS", REVIEW_TIMEOUT_MS);
	if (HEAVY_WRITER_TIMEOUT_AGENTS.has(agent)) return timeoutTierMs("writer", "SUPER_DEV_WRITER_TIMEOUT_MS", WRITER_TIMEOUT_MS);
	return timeoutTierMs("default", "SUPER_DEV_DEFAULT_TIMEOUT_MS", DEFAULT_SPAWN_TIMEOUT_MS);
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

// ─── v0.3.76 skill curation (L0 + L1; approved 2026-09-07) ───────────────────
// The catalog DATA lives in the zero-import leaf ./skill-domains.ts (see that
// file for why: an import edge prompts → agent-runtime corrupts v8 coverage
// attribution). Re-exported here so consumers keep one canonical import site.
export { MECHANICAL_CLASSIFIER_ROLES, DEFAULT_RESEARCH_SKILLS, SKILL_DOMAINS } from "./skill-domains.ts";
export type { SkillDomainDescriptor } from "./skill-domains.ts";
import { MECHANICAL_CLASSIFIER_ROLES, DEFAULT_RESEARCH_SKILLS, SKILL_DOMAINS } from "./skill-domains.ts";

/** L3 escape hatch: `SUPER_DEV_SKILLS=ambient` restores today's full ambient
 * injection for EVERY role (opt-OUT of curation, not a forgotten opt-in —
 * the Option-C doctrine from v0.3.70 structured delegation). Dual-review
 * R3/AR-1 fix: resolves via superDevEnv (process.env > config.json env map —
 * the config channel is the ONLY one GUI-launched sessions have) and is
 * MEMOIZED on first use — registration snapshots the decision at activate
 * while skillsForCall consults it per call; one cached value keeps both
 * layers consistent even if config flips mid-run (registration cannot flip
 * back, so a per-call re-read would silently zero-card curated roles).
 * Deliberately distinct from SUPER_DEV_NO_SKILLS (v0.3.59). */
let ambientSkillsForcedMemo: boolean | null = null;
export function ambientSkillsForced(env?: { SUPER_DEV_SKILLS?: string }): boolean {
	if (env !== undefined) return String(env.SUPER_DEV_SKILLS ?? "").trim().toLowerCase() === "ambient";
	if (ambientSkillsForcedMemo === null) {
		ambientSkillsForcedMemo = String(superDevEnv("SUPER_DEV_SKILLS") ?? "").trim().toLowerCase() === "ambient";
	}
	return ambientSkillsForcedMemo;
}
export function resetAmbientSkillsForcedForTests(): void {
	ambientSkillsForcedMemo = null;
}

export function skillsForCall(
	role: string,
	opts: { agentSkills?: Record<string, false | string[]>; skillDomains?: string[] } = {},
): false | string[] | undefined {
	// Dual-review R2/AR-N3: NO_SKILLS=1 must mean ZERO cards on every layer
	// (its documented pre-v0.3.76 contract: full isolation for debugging/CI),
	// so it gates the per-call field too — it stays the top kill-switch.
	if (!skillsEnabled()) return false;
	if (ambientSkillsForced()) return undefined;
	const configured = opts.agentSkills?.[role];
	if (configured === false) return false;
	// Dual-review R4/AR-N2: an explicit [] is "a curated set of zero" — the
	// config doc says `a string[] = that curated set only`, so [] ≡ false
	// instead of silently falling through to the built-in tiers.
	if (Array.isArray(configured)) return configured.length > 0 ? configured : false;
	if (MECHANICAL_CLASSIFIER_ROLES.has(role)) return false;
	if (needsWebResearch(role)) {
		const set = new Set<string>(DEFAULT_RESEARCH_SKILLS);
		const selected = Array.isArray(opts.skillDomains) ? opts.skillDomains : [];
		for (const name of selected) {
			const domain = SKILL_DOMAINS.find((d) => d.name === name);
			if (domain) for (const s of domain.skills) set.add(s);
		}
		return [...set];
	}
	return undefined;
}

/** v0.3.76: roles whose REGISTRATION turns inheritSkills off (ambient
 * discovery suppressed child-side; cards arrive via the per-call request
 * `skill` field instead — skillsForCall). The registration-level flag is the
 * only one that gates the child's ambient listing (pi-subagents
 * child-launch.ts noSkills: !inheritSkills; E2E probe 2026-09-07). */
export function curatedSkillsRole(role: string): boolean {
	return MECHANICAL_CLASSIFIER_ROLES.has(role) || needsWebResearch(role);
}

/** Dual-review R1/AR-2 fix: an explicit agentSkills entry for a role (false
 * or ANY array, including []) must ALSO flip REGISTRATION — ambient
 * suppression is registration-only (pi-subagents child-launch
 * `noSkills: !inheritSkills`; per-call `skill` cannot remove ambient), so a
 * config entry that only set the per-call field would be a silent no-op
 * (false on a capability role) or strictly worse, ambient PLUS curated
 * duplicate injection (array on a capability role). */
export function explicitSkillConfigured(agentSkills: Record<string, false | string[]> | undefined, role: string): boolean {
	const v = agentSkills?.[role];
	return v === false || Array.isArray(v);
}
