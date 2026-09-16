/**
 * Shared agent-execution runtime utilities — model/thinking resolution,
 * per-role extension packages, and display helpers. Split at v0.4.17d into
 * extensions / config-extensions / thinking / runtime.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
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
export const RESEARCH_EXTENSION_PACKAGES = ["pi-web-access", "pi-mcp-adapter"];
export const BROWSER_EXTENSION_PACKAGES = ["pi-browser-cdp-extension"];

export function piAgentDir(): string {
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
	const path = fileURLToPath(new URL("../../child-guards/commit-guard.ts", import.meta.url));
	if (!existsSync(path)) {
		if (!commitGuardPathWarned) {
			commitGuardPathWarned = true;
			console.warn(`[super-dev] commit guard not found at ${path} — implementer/tdd-guide run unguarded (v0.3.73 HEAD-drift detector remains; this warning appears once per process)`);
		}
		return null;
	}
	return path;
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
	const path = fileURLToPath(new URL("../../child-guards/safety-guard.ts", import.meta.url));
	if (!existsSync(path)) {
		if (!safetyGuardPathWarned) {
			safetyGuardPathWarned = true;
			console.warn(`[super-dev] safety guard not found at ${path} — delegated agents run without the bash/protected-write safety hook (deterministic gates remain; this warning appears once per process)`);
		}
		return null;
	}
	return path;
}
