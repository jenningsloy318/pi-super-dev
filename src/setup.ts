/**
 * Deterministic setup stage — detects language/framework, derives a spec id,
 * creates a git worktree (unless skipped), and creates the spec directory.
 * Replaces the original LLM-driven setup agent; no model round-trip.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { clearKnowledge } from "./render/knowledge.ts";
import { join, resolve } from "node:path";
import type { SetupControl } from "./types.ts";

function git(args: string[], cwd: string): string | null {
	try {
		return execFileSync("git", args, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim();
	} catch {
		return null;
	}
}

export function detectLanguage(cwd: string, task = ""): { language: string; isWebUi: boolean } {
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
	// Greenfield (no manifest): infer the target stack from the task text so
	// downstream prompts and the implementation know what to build.
	const t = task.toLowerCase();
	const mentions = (...kw: string[]) => kw.some((k) => t.includes(k));
	if (mentions("node", "nodejs", "node.js", "express", "fastify", "npm", "deno", "bun")) return { language: "backend", isWebUi: false };
	if (mentions("python", "django", "flask", "fastapi", "pip")) return { language: "python", isWebUi: false };
	if (mentions("golang") || /\bgo\b/.test(t)) return { language: "go", isWebUi: false };
	if (mentions("rust", "cargo")) return { language: "rust", isWebUi: false };
	return { language: "mixed", isWebUi: false };
}

/** Sanitize any string (LLM output or raw) into a kebab-case slug, truncated at
 *  a word boundary so it never cuts mid-word. */
export function sanitizeSlug(raw: string): string {
	let s = raw.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
	if (s.length > 40) { s = s.slice(0, 40); const c = s.lastIndexOf("-"); if (c > 8) s = s.slice(0, c); }
	return s.replace(/-+$/g, "");
}

/** Deterministic fallback slug: drop filler words, keep up to ~5 content words. */
const STOPWORDS = new Set("a an the to of for and or nor but in on at by with from into is are be as that this it its our your their we you they please need want implement add build create make new feature features simple app application page use using used based get one two three next".split(" "));
export function slugifyTask(task: string): string {
	const words = task.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w && !STOPWORDS.has(w));
	return sanitizeSlug(words.slice(0, 5).join("-")) || "task";
}

function nextSpecNumber(cwd: string): number {
	const specsDir = join(cwd, "docs", "specifications");
	let max = 0;
	try {
		for (const entry of readdirSync(specsDir)) {
			const m = entry.match(/^(\d+)-/);
			if (m) max = Math.max(max, Number(m[1]));
		}
	} catch { /* no specs dir yet */ }
	return max + 1;
}

function detectDefaultBranch(cwd: string): string {
	const fromOrigin = git(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], cwd);
	if (fromOrigin && fromOrigin.startsWith("origin/")) return fromOrigin.slice("origin/".length);
	const current = git(["rev-parse", "--abbrev-ref", "HEAD"], cwd);
	if (current && current !== "HEAD") return current;
	return "main";
}

function isGitRepo(cwd: string): boolean {
	return git(["rev-parse", "--is-inside-work-tree"], cwd) !== null;
}

function headExists(cwd: string): boolean {
	return git(["rev-parse", "--verify", "HEAD"], cwd) !== null;
}

function ensureGitIdentity(cwd: string): void {
	if (!git(["config", "user.email"], cwd)) git(["config", "user.email", "pi-super-dev@local"], cwd);
	if (!git(["config", "user.name"], cwd)) git(["config", "user.name", "pi-super-dev"], cwd);
}

export interface SetupOptions {
	cwd?: string;
	skipWorktree?: boolean;
	/** Descriptive slug for the spec id (e.g. LLM-summarized). Falls back to
	 *  slugifyTask(task) when empty/invalid. */
	slug?: string;
	/** Resume: reuse this existing spec identifier + worktree instead of
	 *  allocating a new spec number / branch. */
	resumeSpecIdentifier?: string;
}

export function runSetup(task: string, options: SetupOptions = {}): SetupControl {
	const cwd = resolve(options.cwd ?? process.cwd());

	// Ensure cwd is a git repo (worktree + later commits/merge require it).
	let initializedRepo = false;
	if (!isGitRepo(cwd)) {
		git(["init"], cwd);
		initializedRepo = true;
	}
	// A worktree (and later commits/merge) needs at least one commit on the
	// base branch. Empty repos with an unborn HEAD break `git worktree add`
	// ("fatal: invalid reference: main"), causing setup to silently fall back
	// to operating in the cwd with no isolation.
	if (!headExists(cwd)) {
		ensureGitIdentity(cwd);
		git(["commit", "--allow-empty", "-m", "chore: initial commit (pi-super-dev)"], cwd);
	}

	const { language, isWebUi } = detectLanguage(cwd, task);
	const defaultBranch = detectDefaultBranch(cwd);

	let specIdentifier: string;
	let worktreePath = cwd;
	let worktreeCreated = false;
	if (options.resumeSpecIdentifier) {
		// Resume: reuse the existing spec id + worktree (do NOT allocate new).
		specIdentifier = options.resumeSpecIdentifier;
		const wtPath = join(cwd, ".worktree", specIdentifier);
		if (existsSync(wtPath)) {
			worktreePath = wtPath;
			worktreeCreated = true;
		}
		// else: worktree gone → fall back to in-place in cwd (worktreePath stays cwd).
	} else {
		const slug = sanitizeSlug(options.slug ?? "") || slugifyTask(task);
		specIdentifier = `${String(nextSpecNumber(cwd)).padStart(2, "0")}-${slug}`;
		if (!options.skipWorktree) {
			const wtPath = join(cwd, ".worktree", specIdentifier);
			const created = git(["worktree", "add", "-b", specIdentifier, wtPath, defaultBranch], cwd);
			if (created !== null || existsSync(wtPath)) {
				worktreePath = wtPath;
				worktreeCreated = true;
			}
		}
	}

	const specDirectory = join(worktreePath, "docs", "specifications", specIdentifier) + "/";
	mkdirSync(specDirectory, { recursive: true });
	// Fresh run: clear accumulated knowledge. Resume: PRESERVE it (the memoizing
	// replay overwrites keyed entries as stages re-run, so no duplication; and the
	// resumed call's knowledge-injection needs prior-stage data intact).
	if (!options.resumeSpecIdentifier) clearKnowledge(specDirectory);

	return { worktreePath, specDirectory, defaultBranch, language, isWebUi, specIdentifier, worktreeCreated, initializedRepo };
}
