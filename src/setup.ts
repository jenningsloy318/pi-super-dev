/**
 * Deterministic setup stage — detects language/framework, derives a spec id,
 * creates a git worktree (unless skipped), and creates the spec directory.
 * Replaces the original LLM-driven setup agent; no model round-trip.
 */

import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { isResumable } from "./resume.ts";
import { clearKnowledge } from "./render/knowledge.ts";
import { clearUserNotes } from "./render/user-notes.ts";
import { dirname, join, relative, resolve } from "node:path";

/** Load KEY=VALUE pairs from a `.env` file into `process.env` so spawned
 *  specialist agents (api-tester, etc.) inherit them. Only sets vars that
 *  aren't already defined (existing env wins). This is how TEST_API_KEY and
 *  other test credentials become available during Stage 11 Integration Testing. */
function loadDotEnv(dir: string): void {
	const envPath = join(dir, ".env");
	if (!existsSync(envPath)) return;
	try {
		for (const line of readFileSync(envPath, "utf8").split("\n")) {
			const trimmed = line.trim();
			if (!trimmed || trimmed.startsWith("#")) continue;
			const eq = trimmed.indexOf("=");
			if (eq < 1) continue;
			const key = trimmed.slice(0, eq).trim();
			let val = trimmed.slice(eq + 1).trim();
			// strip surrounding quotes
			if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
				val = val.slice(1, -1);
			}
			if (key && !(key in process.env)) process.env[key] = val;
		}
	} catch { /* best-effort */ }
}

const ENV_PRUNE_DIRS = new Set([".git", ".worktree", "node_modules", "target", "dist", "build", ".next", ".nuxt", "vendor", ".venv", "venv", "__pycache__"]);

function isEnvFile(name: string): boolean {
	if (!name.startsWith(".env")) return false;
	const lower = name.toLowerCase();
	return !lower.includes("example") && !lower.includes("template") && !lower.endsWith(".sample");
}

/** Copy .env / .env.* files recursively from the main checkout into a created
 * worktree. Git worktrees intentionally omit ignored files, but app/test startup
 * commonly depends on nested env files (apps/web/.env.local, services/api/.env,
 * etc.). Best-effort: never abort setup, never overwrite an env that already
 * exists in the worktree, and prune heavy/generated dirs. */
export function copyEnvFilesToWorktree(sourceRoot: string, worktreeRoot: string): string[] {
	if (resolve(sourceRoot) === resolve(worktreeRoot)) return [];
	const copied: string[] = [];
	const visit = (dir: string) => {
		let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
		try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
		for (const entry of entries) {
			const src = join(dir, entry.name);
			const rel = relative(sourceRoot, src);
			if (!rel || rel.startsWith("..")) continue;
			if (entry.isDirectory()) {
				if (ENV_PRUNE_DIRS.has(entry.name)) continue;
				visit(src);
				continue;
			}
			if (!entry.isFile() || !isEnvFile(entry.name)) continue;
			const dst = join(worktreeRoot, rel);
			if (existsSync(dst)) continue;
			try {
				mkdirSync(dirname(dst), { recursive: true });
				copyFileSync(src, dst);
				copied.push(rel);
			} catch { /* best-effort */ }
		}
	};
	visit(sourceRoot);
	return copied;
}
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

// ─── G2: spec-track reuse on task similarity ────────────────────────────────
// Slightly different task texts allocated DIFFERENT tracks for the same
// workstream (254-step-e2e-dashboard / 254-step-e2e-test-dashboard /
// 254-e2e-dashboard were all observed), each fresh track regenerating
// requirements nondeterministically and abandoning all prior convergence
// progress. Before allocating a new track, deterministically match the task
// against existing INCOMPLETE tracks (no LLM) and re-enter the same one.

/** Anchor-task file persisted inside a spec dir at first allocation. Never
 *  overwritten — the anchor keeps the track's identity stable across re-runs. */
export const SPEC_TASK_ANCHOR = ".task";

/** Stopword-stripped lowercase token set of a task text (shared vocabulary
 *  with slugifyTask so slug tokens and task tokens line up). */
export function taskTokens(task: string): Set<string> {
	return new Set(task.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w.length >= 2 && !STOPWORDS.has(w)));
}

/** Jaccard similarity of two task texts' token sets (near-identical re-runs). */
export function taskSimilarity(a: string, b: string): number {
	const ta = taskTokens(a);
	const tb = taskTokens(b);
	if (ta.size === 0 || tb.size === 0) return 0;
	let inter = 0;
	for (const t of ta) if (tb.has(t)) inter++;
	return inter / (ta.size + tb.size - inter);
}

/** Share of a track slug's distinctive tokens present in the task text
 *  (re-phrased re-run of the same feature: `step-e2e-dashboard` tokens
 *  appear inside a task that never mentions the original wording). */
export function slugTokenContainment(slug: string, task: string): number {
	const slugTokens = slug.toLowerCase().split("-").filter((w) => w.length >= 3 && !STOPWORDS.has(w));
	if (slugTokens.length === 0) return 0;
	const tokens = taskTokens(task);
	let hit = 0;
	for (const t of slugTokens) if (tokens.has(t)) hit++;
	return hit / slugTokens.length;
}

/** Reuse score threshold: containment >= 0.75 with >= 3 slug tokens, exact
 *  match for 2-token slugs, or Jaccard >= 0.6 for near-identical anchors. */
function reusableScore(slug: string, anchorTask: string | undefined, task: string): number {
	const slugTokens = slug.toLowerCase().split("-").filter((w) => w.length >= 3 && !STOPWORDS.has(w));
	const containment = slugTokenContainment(slug, task);
	if (slugTokens.length >= 3 && containment >= 0.75) return Math.max(containment, 0.75);
	if (slugTokens.length === 2 && containment === 1) return 1;
	if (anchorTask && taskSimilarity(anchorTask, task) >= 0.6) return taskSimilarity(anchorTask, task);
	return 0;
}

/** Env kill-switch for spec-track reuse. */
export function specReuseEnabled(): boolean {
	return process.env.SUPER_DEV_NO_SPEC_REUSE !== "1";
}

/** Find an existing INCOMPLETE spec track whose task matches the new task
 *  (same workstream, re-phrased). Completed tracks (.complete marker) are
 *  skipped — asking again after completion is a new iteration, not a re-run.
 *  Returns the spec identifier (e.g. `254-step-e2e-dashboard`) or null. */
export function findReusableSpec(cwd: string, task: string, opts: { worktree?: boolean } = {}): string | null {
	const useWorktree = opts.worktree !== false; // default: the pipeline layout
	const candidates: Array<{ id: string; dir: string; score: number; mtime: number }> = [];
	const consider = (specDir: string, id: string) => {
		// Reuse is a CONTINUATION of a dead run (adversarial
		// G2-COLLISION-ABSORPTION / code-review G2-FALSE-POSITIVE-REUSE): only
		// tracks with recorded progress (non-empty resume cache, no .complete
		// marker — i.e. isResumable) are eligible. A track that never got past
		// setup has nothing to preserve; a finished track asked-for-again is a
		// new iteration, not a re-run.
		if (!isResumable(specDir)) return;
		let anchor: string | undefined;
		try {
			anchor = readFileSync(join(specDir, SPEC_TASK_ANCHOR), "utf8");
		} catch { /* no anchor — containment-only scoring */ }
		const slug = id.replace(/^\d+-/, "");
		const score = reusableScore(slug, anchor, task);
		if (score <= 0) return;
		let mtime = 0;
		try {
			mtime = statSync(join(specDir, SPEC_TASK_ANCHOR)).mtimeMs;
		} catch { /* fallback mtime 0 — score still discriminates */ }
		candidates.push({ id, dir: specDir, score, mtime });
	};
	// Layout-aware (code-review N1-CROSS-LAYOUT-REUSE): a track recorded
	// in-place (skipWorktree run) that is "reused" by a worktree-mode run (or
	// vice versa) points specDirectory at an EMPTY sibling dir — the docs and
	// cache stay in the other layout and nothing is preserved. Only tracks
	// whose recorded layout matches how THIS run addresses the spec dir are
	// eligible.
	const wtRoot = join(cwd, ".worktree");
	if (useWorktree && existsSync(wtRoot)) {
		for (const id of readdirSync(wtRoot)) consider(join(wtRoot, id, "docs", "specifications", id), id);
	}
	const specsRoot = join(cwd, "docs", "specifications");
	if (!useWorktree && existsSync(specsRoot)) {
		for (const id of readdirSync(specsRoot)) consider(join(specsRoot, id), id);
	}
	if (candidates.length === 0) return null;
	// Deterministic across machines: score, then recency, then lexicographic id
	// (adversarial G2-TIEBREAK-NONDETERMINISM — readdir order is not stable).
	candidates.sort((a, b) => b.score - a.score || b.mtime - a.mtime || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
	return candidates[0].id;
}

/** Extract an explicitly referenced existing spec directory from the task text.
 * Users often ask: `implement @docs/specifications/24-foo/` and expect the
 * whole workflow to keep that track as source-of-truth. Without this, setup
 * allocates the next numbered spec (`28-foo`), causing review/source-of-truth
 * failures even when implementation succeeds. */
export function referencedSpecIdentifier(task: string, cwd: string): string | null {
	const specsRoot = join(cwd, "docs", "specifications");
	const re = /@?docs\/specifications\/([A-Za-z0-9][A-Za-z0-9._-]*)(?:\/|\b)/g;
	let match: RegExpExecArray | null;
	while ((match = re.exec(task)) !== null) {
		const candidate = match[1];
		if (candidate.includes("..") || candidate.includes("/")) continue;
		if (existsSync(join(specsRoot, candidate))) return candidate;
	}
	return null;
}

function branchExists(cwd: string, branch: string): boolean {
	return git(["rev-parse", "--verify", `refs/heads/${branch}`], cwd) !== null;
}

function createOrReuseWorktree(cwd: string, specIdentifier: string, defaultBranch: string): { worktreePath: string; worktreeCreated: boolean } {
	const wtPath = join(cwd, ".worktree", specIdentifier);
	if (existsSync(wtPath)) return { worktreePath: wtPath, worktreeCreated: true };
	const args = branchExists(cwd, specIdentifier)
		? ["worktree", "add", wtPath, specIdentifier]
		: ["worktree", "add", "-b", specIdentifier, wtPath, defaultBranch];
	const created = git(args, cwd);
	if (created !== null || existsSync(wtPath)) return { worktreePath: wtPath, worktreeCreated: true };
	return { worktreePath: cwd, worktreeCreated: false };
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
	let reusedTrack = false;
	const taskSpecIdentifier = referencedSpecIdentifier(task, cwd);
	if (options.resumeSpecIdentifier) {
		// Resume: reuse the existing spec id + worktree (do NOT allocate new).
		specIdentifier = options.resumeSpecIdentifier;
		if (!options.skipWorktree) {
			const wt = createOrReuseWorktree(cwd, specIdentifier, defaultBranch);
			worktreePath = wt.worktreePath;
			worktreeCreated = wt.worktreeCreated;
		}
	} else if (taskSpecIdentifier) {
		// Existing spec reference: keep that numbered track as the authoritative
		// spec directory. This is a fresh full workflow run, not a memoized resume,
		// but it must not allocate `nextSpecNumber()` or create a new spec dir.
		specIdentifier = taskSpecIdentifier;
		if (!options.skipWorktree) {
			const wt = createOrReuseWorktree(cwd, specIdentifier, defaultBranch);
			worktreePath = wt.worktreePath;
			worktreeCreated = wt.worktreeCreated;
		}
	} else if (!specReuseEnabled()) {
		// Kill-switch: the caller has expressed intent for a FRESH track.
		const slug = sanitizeSlug(options.slug ?? "") || slugifyTask(task);
		specIdentifier = `${String(nextSpecNumber(cwd)).padStart(2, "0")}-${slug}`;
		if (!options.skipWorktree) {
			const wt = createOrReuseWorktree(cwd, specIdentifier, defaultBranch);
			worktreePath = wt.worktreePath;
			worktreeCreated = wt.worktreeCreated;
		}
	} else {
		// G2 (spec-track fragmentation): try to re-enter an existing INCOMPLETE
		// track with recorded progress whose task matches (re-phrased re-run of
		// the same workstream) BEFORE allocating a sibling. The `options.slug`
		// passed by the pipeline stage is an LLM-SUMMARIZED LABEL, never
		// explicit fresh-track intent (code-review G2-PROD-DEAD-PATH /
		// adversarial G2-DEAD-IN-PRODUCTION) — it only names a FRESH track.
		const reusable = findReusableSpec(cwd, task, { worktree: !options.skipWorktree });
		if (reusable) {
			specIdentifier = reusable;
			reusedTrack = true;
		} else {
			const slug = sanitizeSlug(options.slug ?? "") || slugifyTask(task);
			specIdentifier = `${String(nextSpecNumber(cwd)).padStart(2, "0")}-${slug}`;
		}
		if (!options.skipWorktree) {
			const wt = createOrReuseWorktree(cwd, specIdentifier, defaultBranch);
			worktreePath = wt.worktreePath;
			worktreeCreated = wt.worktreeCreated;
		}
	}

	// Git worktree creation does not copy ignored files. Copy .env files from the
	// main checkout recursively before loading root .env so app/test startup in
	// the isolated worktree has the same local configuration as the source repo.
	let copiedEnvFiles: string[] = [];
	if (worktreeCreated) copiedEnvFiles = copyEnvFilesToWorktree(cwd, worktreePath);
	// Load .env (TEST_API_KEY etc.) from the worktree so spawned agents inherit it.
	loadDotEnv(worktreePath);

	const specDirectory = join(worktreePath, "docs", "specifications", specIdentifier) + "/";
	mkdirSync(specDirectory, { recursive: true });
	// G2: persist the anchor task at first allocation of a track (never
	// overwritten) so later re-phrased runs can deterministically find and
	// re-enter this track instead of fragmenting into siblings.
	const anchorPath = join(specDirectory, SPEC_TASK_ANCHOR);
	if (!existsSync(anchorPath)) {
		try {
			writeFileSync(anchorPath, task, "utf8");
		} catch { /* best-effort — reuse falls back to slug containment */ }
	}
	// Fresh run: clear accumulated knowledge. Resume: PRESERVE it (the memoizing
	// replay overwrites keyed entries as stages re-run, so no duplication; and the
	// resumed call's knowledge-injection needs prior-stage data intact).
	if (!options.resumeSpecIdentifier && !reusedTrack) {
		// A REUSED track is a continuation like resume: its knowledge and
		// user-notes carry the prior run's context (and user-authored guidance)
		// — wiping them would silently destroy human notes (adversarial
		// G2-COLLISION-ABSORPTION).
		clearKnowledge(specDirectory);
		clearUserNotes(specDirectory);
	}

	return { worktreePath, specDirectory, defaultBranch, language, isWebUi, specIdentifier, worktreeCreated, initializedRepo, copiedEnvFiles, reusedTrack };
}
