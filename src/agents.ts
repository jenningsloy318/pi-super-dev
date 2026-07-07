/**
 * Loads specialist agent system prompts from `agents/<name>.md`.
 * The YAML frontmatter is metadata; the body is passed to spawned `pi` via
 * `--system-prompt`.
 */

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadLearnedLessons } from "./render/learned.ts";

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const AGENTS_DIR = join(MODULE_DIR, "..", "agents");
const LANG_DIR = join(AGENTS_DIR, "lang");
const cache = new Map<string, string>();
const langCache = new Map<string, string>();

function stripFrontmatter(md: string): string {
	if (!md.startsWith("---")) return md;
	const end = md.indexOf("\n---", 3);
	if (end === -1) return md;
	return md.slice(end + 4).replace(/^\s*\n/, "");
}

// Internal: load the base agent .md body (cached).
function loadAgentPromptBase(name: string): string {
	const cached = cache.get(name);
	if (cached !== undefined) return cached;
	const path = join(AGENTS_DIR, `${name}.md`);
	let body: string;
	try {
		body = stripFrontmatter(readFileSync(path, "utf8"));
	} catch {
		throw new Error(`super-dev: unknown agent "${name}" (no file at ${path})`);
	}
	cache.set(name, body);
	return body;
}

// Public: load the agent .md body + inject learned lessons (fresh each call,
// not cached — learned-index.json can change between runs via reflection).
export function loadAgentPrompt(name: string): string {
	const base = loadAgentPromptBase(name);
	const learned = loadLearnedLessons(name);
	return learned ? `${base}\n\n${learned}` : base;
}

export function agentsDirectory(): string {
	return AGENTS_DIR;
}

/** Load a per-language specialist profile from `agents/lang/<lang>.md` (cached).
 *  Returns "" for `mixed` or a missing profile so callers always get a string.
 *  Prose-only (no code samples): build/test/lint commands, coverage threshold,
 *  file-organization rule, and a few top idioms — injected into the implementer
 *  and tdd-guide prompts so a generic agent gets language-specific guardrails
 *  without needing a per-language agent file. */
export function loadLangProfile(language: string): string {
	const lang = (language ?? "mixed").trim();
	if (!lang || lang === "mixed") return "";
	const cached = langCache.get(lang);
	if (cached !== undefined) return cached;
	let body = "";
	try {
		body = stripFrontmatter(readFileSync(join(LANG_DIR, `${lang}.md`), "utf8")).trim();
	} catch {
		/* no profile for this language → empty (caller falls back gracefully) */
	}
	langCache.set(lang, body);
	return body;
}
