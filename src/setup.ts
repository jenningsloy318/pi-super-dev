/**
 * Deterministic setup stage — detects language/framework, derives a spec id,
 * creates a git worktree (unless skipped), and creates the spec directory.
 * Replaces the original LLM-driven setup agent; no model round-trip.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { SetupControl } from "./types.ts";

function git(args: string[], cwd: string): string | null {
	try {
		return execFileSync("git", args, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim();
	} catch {
		return null;
	}
}

export function detectLanguage(cwd: string): { language: string; isWebUi: boolean } {
	const has = (f: string) => existsSync(join(cwd, f));
	if (has("Cargo.toml")) return { language: "rust", isWebUi: false };
	if (has("go.mod")) return { language: "go", isWebUi: false };
	if (has("pyproject.toml") || has("setup.py") || has("requirements.txt")) return { language: "python", isWebUi: false };
	if (has("package.json")) {
		try {
			const pkg = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8")) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
			const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
			const isWebUi = Boolean(deps["react"] || deps["next"] || deps["vue"] || deps["svelte"] || deps["@sveltejs/kit"]);
			if (deps["express"] || deps["fastify"] || deps["@hono/node-server"]) return { language: "backend", isWebUi };
			return { language: "frontend", isWebUi };
		} catch {
			return { language: "frontend", isWebUi: true };
		}
	}
	return { language: "mixed", isWebUi: false };
}

function slugify(task: string): string {
	return task.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/g, "");
}

function nextSpecIdentifier(cwd: string, task: string): string {
	const specsDir = join(cwd, "docs", "specifications");
	let max = 0;
	try {
		for (const entry of readdirSync(specsDir)) {
			const m = entry.match(/^(\d+)-/);
			if (m) max = Math.max(max, Number(m[1]));
		}
	} catch { /* no specs dir yet */ }
	return `${String(max + 1).padStart(2, "0")}-${slugify(task) || "task"}`;
}

function detectDefaultBranch(cwd: string): string {
	const fromOrigin = git(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], cwd);
	if (fromOrigin && fromOrigin.startsWith("origin/")) return fromOrigin.slice("origin/".length);
	const current = git(["rev-parse", "--abbrev-ref", "HEAD"], cwd);
	if (current && current !== "HEAD") return current;
	return "main";
}

export interface SetupOptions {
	cwd?: string;
	skipWorktree?: boolean;
}

export function runSetup(task: string, options: SetupOptions = {}): SetupControl {
	const cwd = resolve(options.cwd ?? process.cwd());
	const { language, isWebUi } = detectLanguage(cwd);
	const defaultBranch = detectDefaultBranch(cwd);
	const specIdentifier = nextSpecIdentifier(cwd, task);

	let worktreePath = cwd;
	if (!options.skipWorktree) {
		const wtPath = join(cwd, ".worktree", specIdentifier);
		const created = git(["worktree", "add", "-b", specIdentifier, wtPath, defaultBranch], cwd);
		if (created !== null || existsSync(wtPath)) worktreePath = wtPath;
	}

	const specDirectory = join(worktreePath, "docs", "specifications", specIdentifier) + "/";
	mkdirSync(specDirectory, { recursive: true });

	return { worktreePath, specDirectory, defaultBranch, language, isWebUi, specIdentifier };
}
