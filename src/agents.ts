/**
 * Loads specialist agent system prompts from `agents/<name>.md`.
 * The YAML frontmatter is metadata; the body is passed to spawned `pi` via
 * `--system-prompt`.
 */

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const AGENTS_DIR = join(MODULE_DIR, "..", "agents");
const cache = new Map<string, string>();

function stripFrontmatter(md: string): string {
	if (!md.startsWith("---")) return md;
	const end = md.indexOf("\n---", 3);
	if (end === -1) return md;
	return md.slice(end + 4).replace(/^\s*\n/, "");
}

export function loadAgentPrompt(name: string): string {
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

export function agentsDirectory(): string {
	return AGENTS_DIR;
}
