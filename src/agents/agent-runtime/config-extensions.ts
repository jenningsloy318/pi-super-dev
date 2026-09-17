import { MECHANICAL_CLASSIFIER_ROLES } from "../skill-domains.ts";
import {BROWSER_EXTENSION_PACKAGES, RESEARCH_EXTENSION_PACKAGES, isBrowserAgent, needsWebResearch, piAgentDir, resolveExtensionEntries} from "./extensions.ts";
/** config-extensions — config-driven extension entries, tool index, tool budgets. Split from agent-runtime.ts at v0.4.17d. */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { getConfig, superDevEnv, type ToolBudgetValue } from "../../render/super-dev-dir.ts";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { sanitizeSlug } from "../../setup.ts";
import {
	createAgentSession,
	defineTool,
	getAgentDir,
	DefaultResourceLoader,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
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
