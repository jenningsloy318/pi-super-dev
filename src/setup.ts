/**
 * Deterministic setup stage — detects language/framework, derives a spec id,
 * creates a git worktree (unless skipped), and creates the spec directory.
 * Replaces the original LLM-driven setup agent; no model round-trip.
 */

import { execFileSync } from "node:child_process";
import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
// PRC (Track 30 Phase 5): the shared dirt primitives — REUSED, never
// duplicated (D-7: src/fault-classification.ts is the canonical exclusion/
// quarantine source so setup and the Stage 9 loop cannot drift).
import { collectDirtPaths, quarantineDirt, dirtyQuarantineEnabled, appendEnvironmentFault, readEnvironmentFaultCount } from "./fault-classification.ts";
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

/** H6 (AC-07): the copier's env-file predicate, exported so the cleanup
 *  sensitive scan can DERIVE its env blocklist from the exact copy-set
 *  (never a divergent hardcoded list). `.env`-prefixed, minus
 *  example/template/sample variants. */
export function isEnvFile(name: string): boolean {
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

/** H6 (ISS-01 / AC-08): append each copied repo-relative env path to the repo's
 *  COMMON exclude file — the only per-repo exclude git reads for EVERY worktree
 *  (gitrepository-layout(5); verified on git 2.47.3: `--git-path info.exclude`
 *  inside a linked worktree resolves to .git/worktrees/<id>/info/exclude, which
 *  git never reads). Patterns are repo-relative and intentionally apply to all
 *  worktrees: a copied env file must never be committed anywhere. Idempotent
 *  (dedupe by exact pattern line). Best-effort — AC-07's cleanup scan is the
 *  backstop. */
const COPIED_ENV_EXCLUDE_HEADER = "# pi-super-dev copied env files (never committed)";

function excludeCopiedEnvFiles(worktreeRoot: string, copiedRelPaths: string[]): void {
	if (copiedRelPaths.length === 0) return;
	try {
		const commonDir = git(["rev-parse", "--git-common-dir"], worktreeRoot);
		if (!commonDir) return;
		// git may return a relative common dir ("../../.git") — resolve against
		// the worktree root; absolute outputs pass through resolve unchanged.
		const excludePath = join(resolve(worktreeRoot, commonDir), "info", "exclude");
		mkdirSync(dirname(excludePath), { recursive: true });
		let existing = "";
		try { existing = readFileSync(excludePath, "utf8"); } catch { /* absent — create */ }
		const lines = new Set(existing.split("\n"));
		const additions: string[] = [];
		if (!existing.includes(COPIED_ENV_EXCLUDE_HEADER)) additions.push(COPIED_ENV_EXCLUDE_HEADER);
		// Adversarial F-04 (spec-28 review): the transient spec-dir run lock must
		// never be snapshotted into pipeline commits by `git add -A`.
		if (!existing.includes(".run-lock")) additions.push(".run-lock");
	// v0.3.3 L1: the persisted convergence ledger is harness state — never
	// snapshotted into pipeline commits by `git add -A`.
	if (!existing.includes(".convergence-ledger.json")) additions.push(".convergence-ledger.json");
		for (const rel of copiedRelPaths) if (!lines.has(rel)) additions.push(rel);
		if (additions.length === 0) return;
		const prefix = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
		writeFileSync(excludePath, existing + prefix + additions.join("\n") + "\n", "utf8");
	} catch { /* best-effort — the cleanup scan blocks committed env files */ }
}

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
 *  appear inside a task that never mentions the original wording).
 *  R6 (NFR-6): a NUMERIC token in the slug (error code, ticket id, port) must
 *  appear VERBATIM in the task text — generic words alone (step/e2e/dashboard)
 *  hit the 0.75 threshold and silently absorb a DIFFERENT workstream into an
 *  existing track; the numeral is the one unambiguous discriminator. */
export function slugTokenContainment(slug: string, task: string): number {
	const rawTokens = slug.toLowerCase().split("-");
	const tokens = taskTokens(task);
	for (const numeric of rawTokens.filter((w) => /^\d+$/.test(w))) {
		if (!tokens.has(numeric)) return 0; // numeral absent → different workstream
	}
	const slugTokens = rawTokens.filter((w) => w.length >= 3 && !STOPWORDS.has(w));
	if (slugTokens.length === 0) return 0;
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
 *  Returns the spec identifier (e.g. `254-step-e2e-dashboard`) or null.
 *  R6 (NFR-6): the reuse DECISION is logged with its score (`opts.log`) so a
 *  wrong absorption is visible in the run log, not silent. */
export function findReusableSpec(cwd: string, task: string, opts: { worktree?: boolean; log?: (message: string) => void } = {}): string | null {
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
	if (candidates.length === 0) {
		opts.log?.("spec-track reuse: no reusable track matched this task — allocating a fresh spec directory");
		return null;
	}
	// Deterministic across machines: score, then recency, then lexicographic id
	// (adversarial G2-TIEBREAK-NONDETERMINISM — readdir order is not stable).
	candidates.sort((a, b) => b.score - a.score || b.mtime - a.mtime || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
	const best = candidates[0];
	// R6 (NFR-6): the reuse decision carries its SCORE — a wrong absorption is
	// visible in the run log instead of silently re-entering the track.
	opts.log?.(`spec-track reuse: re-entering track "${best.id}" (score ${best.score.toFixed(2)} — containment/anchor similarity above threshold; prior docs, knowledge and user notes preserved)`);
	return best.id;
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

// ─── OQ-3 / AC-30: spec-dir run lock ────────────────────────────────────────

/** AC-30: the per-spec-dir run lock basename (serialized same-track runs). */
export const RUN_LOCK_BASENAME = ".run-lock";

/** The lock this process currently holds (released by pipeline.ts / the
 *  extension's finally). Null when nothing is held. */
let heldRunLockPath: string | null = null;

/** Parse a lock file's holder ({pid, startedAt}); null on ANY failure. */
function readLockHolder(path: string): { pid: number; startedAt?: string } | null {
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as { pid?: unknown; startedAt?: unknown };
		const pid = Number(parsed?.pid);
		if (!Number.isInteger(pid) || pid <= 0) return null;
		return { pid, startedAt: typeof parsed?.startedAt === "string" ? parsed.startedAt : undefined };
	} catch {
		return null;
	}
}

/** Signal-0 liveness probe: process.kill(pid, 0) succeeds ⟺ a signal could be
 *  delivered (alive + permitted); false on ANY throw (dead / not ours). */
function isPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		// Adversarial F-03 (spec-28 review): kill(pid,0) on a LIVE process owned
		// by another user throws EPERM (exists-but-not-permitted) — that is
		// ALIVE, not dead. Only ESRCH (no such process) means dead.
		return (err as NodeJS.ErrnoException).code === "EPERM";
	}
}

/** Serialize same-track runs: exclusive-create the lock; on collision a LIVE
 *  holder (≠ this process) blocks setup with an actionable error, anything
 *  else (dead pid, unreadable, our own pid — replan auto-restarts re-enter
 *  runSetup in the same process) is stolen and retried (≤3 attempts). */
function acquireRunLock(specDirectory: string): void {
	const lockPath = join(specDirectory, RUN_LOCK_BASENAME);
	for (let attempt = 0; attempt < 3; attempt++) {
		let fd: number | undefined;
		try {
			fd = openSync(lockPath, "wx");
			writeSync(fd, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
			heldRunLockPath = lockPath;
			return;
		} catch (err) {
			const code = (err as { code?: string }).code;
			if (code !== "EEXIST") throw err; // real IO failure — fail closed
			const holder = readLockHolder(lockPath);
			// A holder pid equal to process.pid is ALWAYS stolen; a live foreign
			// holder blocks; a dead/unreadable lock is stale and stolen.
			if (holder && holder.pid !== process.pid && isPidAlive(holder.pid)) {
				throw new Error(`spec directory ${specDirectory} is locked by another super-dev run (pid ${holder.pid}, started ${holder.startedAt ?? "unknown"}); wait for it to finish, or remove ${lockPath} if that run is gone`);
			}
			rmSync(lockPath, { force: true });
		}
	}
	throw new Error(`spec directory ${specDirectory} could not be locked (${RUN_LOCK_BASENAME} kept reappearing — remove ${lockPath} manually and retry)`);
}

/** Release the lock this process holds (pipeline.ts finally + the extension's
 *  doRun finally). Safe when nothing is held. */
export function releaseHeldRunLock(): void {
	if (heldRunLockPath === null) return;
	try {
		rmSync(heldRunLockPath, { force: true });
	} catch { /* best-effort */ }
	heldRunLockPath = null;
}

/** H7 (AC-09): run git capturing BOTH streams — the fail-closed worktree-add
 *  error message must surface git's own stderr tail (diagnosability), which
 *  the silent-stderr `git()` helper cannot provide. Never throws. */
function gitWithStderr(args: string[], cwd: string): { stdout: string; stderr: string } {
	try {
		const out = execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
		return { stdout: out, stderr: "" };
	} catch (err) {
		const e = err as { stdout?: string; stderr?: string; message?: string };
		return { stdout: String(e.stdout ?? ""), stderr: String(e.stderr ?? e.message ?? "") };
	}
}

function createOrReuseWorktree(cwd: string, specIdentifier: string, defaultBranch: string): { worktreePath: string; worktreeCreated: boolean } {
	const wtPath = join(cwd, ".worktree", specIdentifier);
	if (existsSync(wtPath)) return { worktreePath: wtPath, worktreeCreated: true };
	const args = branchExists(cwd, specIdentifier)
		? ["worktree", "add", wtPath, specIdentifier]
		: ["worktree", "add", "-b", specIdentifier, wtPath, defaultBranch];
	const created = git(args, cwd);
	if (created !== null || existsSync(wtPath)) return { worktreePath: wtPath, worktreeCreated: true };
	// H7 (AC-09 / SCENARIO-020): prune once and retry once — a stale
	// registration for a deleted .worktree/<id> path is the common recoverable
	// failure (worktree dir removed without `git worktree remove`).
	git(["worktree", "prune"], cwd);
	const retried = git(args, cwd);
	if (retried !== null || existsSync(wtPath)) return { worktreePath: wtPath, worktreeCreated: true };
	// H7 (AC-09 / SCENARIO-019): FAIL CLOSED — never silently fall back to
	// running in the user's main checkout with no isolation. Surface git's
	// stderr tail plus the recovery hint.
	const { stderr } = gitWithStderr(args, cwd);
	throw new Error(`git worktree add failed for ${specIdentifier} even after \`git worktree prune\` + one retry — git stderr: ${stderr.trim().slice(-400) || "(none)"}. Run \`git worktree prune\` manually and retry, or set skipWorktree to run in place deliberately.`);
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
	/** Optional run-log sink (R6/NFR-6): the spec-track reuse decision (with its
	 *  score) is logged here so a wrong absorption is visible in the run log. */
	log?: (message: string) => void;
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
		reusedTrack = true; // H2 (AC-02/SCENARIO-004): a referenced-spec entry is a continuation — never clear knowledge/user-notes
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
		const reusable = findReusableSpec(cwd, task, { worktree: !options.skipWorktree, log: options.log });
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
	if (worktreeCreated) {
		copiedEnvFiles = copyEnvFilesToWorktree(cwd, worktreePath);
		excludeCopiedEnvFiles(worktreePath, copiedEnvFiles);
	}
	// RC12a (runs 10-39/15-07): a fresh worktree has NO node_modules — the build
	// gate then fails on unrelated packages (auth-service TS2307 better-auth) and
	// the implementer 'fixes' unrelated files to escape. Best-effort dependency
	// bootstrap from the lockfile; NEVER blocks on failure (warning only).
	bootstrapDependencies(cwd, worktreePath, worktreeCreated, options.log);
	// Load .env (TEST_API_KEY etc.) from the worktree so spawned agents inherit it.
	loadDotEnv(worktreePath);

	const specDirectory = join(worktreePath, "docs", "specifications", specIdentifier) + "/";
	mkdirSync(specDirectory, { recursive: true });
	// AC-30: serialize same-track runs (live-pid check + stale steal) —
	// immediately after the spec dir exists.
	acquireRunLock(specDirectory);
	// G2: persist the anchor task at first allocation of a track (never
	// overwritten) so later re-phrased runs can deterministically find and
	// re-enter this track instead of fragmenting into siblings.
	const anchorPath = join(specDirectory, SPEC_TASK_ANCHOR);
	if (!existsSync(anchorPath)) {
		try {
			writeFileSync(anchorPath, task, "utf8");
		} catch { /* best-effort — reuse falls back to slug containment */ }
	}
	// M11 (AC-21/SCENARIO-045): a FRESH (non-resume) entry into an EXISTING
	// track must not mix this run's fresh #1 occurrence keys with the dead
	// run's #2/#3 rows — truncate the stale cache (clearKnowledge semantics;
	// NOT clearResumeCache, which also writes the .complete marker).
	// findReusableSpec already read the cache — truncation happens strictly
	// AFTER selection. Resume keeps the cache intact (SCENARIO-046).
	const staleResumeCachePath = join(specDirectory, ".resume-cache.jsonl");
	if (!options.resumeSpecIdentifier && (reusedTrack || taskSpecIdentifier) && existsSync(staleResumeCachePath)) {
		try { writeFileSync(staleResumeCachePath, ""); } catch { /* best-effort */ }
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

	// ── PRC reuse hygiene (Track 30 Phase 5 · SCENARIO-020..023 · AC-09/10/11):
	// on RE-ENTRY ONLY — a reused track (referenced-spec or reuse-search match,
	// `reusedTrack === true`) or an explicitly resumed one
	// (`options.resumeSpecIdentifier`) — detect foreign uncommitted state left
	// behind in the worktree (a dead run's or a human's edits) and quarantine it
	// recoverably so it cannot poison this run's gates. Detection is scoped
	// exactly (SCENARIO-021): fresh tracks skip it entirely, and the user's main
	// checkout (skipWorktree ⇒ worktreePath === cwd) is NEVER quarantined.
	// Insertion contract (spec 07 Phase 5): after acquireRunLock + stale-cache
	// truncation + knowledge clearing, before the return; synchronous spawnSync
	// only; options.log is the only sink; the return shape is unchanged.
	if ((reusedTrack || options.resumeSpecIdentifier) && resolve(worktreePath) !== resolve(cwd)) {
		// Canonical inventory (D-7): spec-dir prefix + harness bookkeeping +
		// `.super-dev/` + copiedEnvFiles exclusions live once in the shared
		// helper. NO extraExcluded here — the phase's declared scope is unknown
		// at setup time (in-loop only).
		const setupDirt = collectDirtPaths({ worktreePath, specDirectory, copiedEnvFiles });
		if (!dirtyQuarantineEnabled()) {
			// Kill-switch (SCENARIO-023 · AC-11): detection observes, mutation never
			// runs — the worktree is left untouched with a prominent warning (the
			// SUPER_DEV_NO_BOOTSTRAP / SUPER_DEV_NO_SPEC_REUSE log style).
			if (setupDirt.length > 0) {
				options.log?.(`Setup detected foreign uncommitted state on re-entered track ${specIdentifier} but SUPER_DEV_NO_DIRTY_QUARANTINE=1 is set — worktree untouched; paths: ${setupDirt.join(", ")}`);
			}
		} else if (setupDirt.length > 0) {
			// SCENARIO-020 · AC-09: ONE recoverable quarantine — a scoped
			// `git stash push -u` (the ONLY worktree mutation, SCENARIO-028) plus a
			// PRD ledger record (SCENARIO-025 · AC-12). A mechanism failure
			// degrades to a warning + plain proceed — never fatal (AC-13), mirroring
			// the bootstrapDependencies degrade style.
			const q = quarantineDirt({ worktreePath, paths: setupDirt, reason: `setup reuse hygiene track ${specIdentifier}`, log: options.log });
			if (q.ok && q.stashRef) {
				appendEnvironmentFault(specDirectory, { kind: "quarantine", paths: setupDirt, stashRef: q.stashRef, reason: `setup re-entry track ${specIdentifier}` }, options.log);
				// SCENARIO-022 · AC-10: ONE prominent recovery line — the quarantined
				// paths, the stash ref, the recovery command, and the kill-switch name.
				options.log?.(`Setup quarantined foreign uncommitted state on re-entered track ${specIdentifier} — paths: ${setupDirt.join(", ")}; stash ref: ${q.stashRef}; recover with: git stash pop; kill-switch: SUPER_DEV_NO_DIRTY_QUARANTINE=1`);
			} else {
				const why = q.error ?? `stash ref could not be captured (skipped: ${q.skipped ?? "none"})`;
				options.log?.(`Setup reuse-hygiene quarantine FAILED (continuing without it — foreign uncommitted state remains in the worktree; recover manually via git stash list, or disable with SUPER_DEV_NO_DIRTY_QUARANTINE=1) — class=environment; next=proceed: ${why.slice(0, 400)}`);
			}
		}
		// ── T6.1 (SCENARIO-027 · AC-12): the prior-fault count, surfaced IFF the
		// per-track ledger EXISTS. Runs on EVERY eligible re-entry regardless of
		// dirt, AFTER the quarantine arm — a quarantining re-entry's line reflects
		// the just-appended record. An ABSENT file emits NO line at all (never a
		// ": 0" line — readEnvironmentFaultCount is null iff the file is absent);
		// informational only (next=none), never a throw, never an actuation.
		const priorFaults = readEnvironmentFaultCount(specDirectory);
		if (priorFaults !== null) {
			options.log?.(`Setup prior environmental faults on track ${specIdentifier}: ${priorFaults} (ledger: .environment-faults.jsonl — class=environment; next=none, informational)`);
		}
	}

	return { worktreePath, specDirectory, defaultBranch, language, isWebUi, specIdentifier, worktreeCreated, initializedRepo, copiedEnvFiles, reusedTrack };
}

/** RC12a: best-effort dependency bootstrap for a FRESH worktree of a JS/TS
 *  monorepo. Runs the package manager's frozen install when a lockfile exists
 *  and the worktree root has no node_modules. Kill-switch SUPER_DEV_NO_BOOTSTRAP=1;
 *  timeout SUPER_DEV_BOOTSTRAP_TIMEOUT_MS (default 10min). Non-JS projects and
 *  pre-installed worktrees no-op. Failures log a warning and never throw —
 *  the pipeline keeps going exactly as before (observable, not blocking). */
function bootstrapDependencies(cwd: string, worktreePath: string, worktreeCreated: boolean, log?: (m: string) => void): void {
	if (process.env.SUPER_DEV_NO_BOOTSTRAP === "1") return;
	if (!worktreeCreated || worktreePath === cwd) return;
	const wt = (m: string) => { if (log) log(m); };
	try {
		if (existsSync(join(worktreePath, "node_modules"))) return;
		const pm = existsSync(join(worktreePath, "pnpm-lock.yaml")) ? "pnpm"
			: existsSync(join(worktreePath, "yarn.lock")) ? "yarn"
			: existsSync(join(worktreePath, "bun.lockb")) || existsSync(join(worktreePath, "bun.lock")) ? "bun"
			: existsSync(join(worktreePath, "package-lock.json")) ? "npm"
			: null;
		if (!pm) return;
		if (!existsSync(join(worktreePath, "package.json"))) return;
		const timeoutMs = Number.parseInt(process.env.SUPER_DEV_BOOTSTRAP_TIMEOUT_MS ?? "", 10) || 600_000;
		// Reviewer F-5/F-6: `--immutable` is Yarn BERRY only — classic yarn (the
		// common yarn.lock case) needs `--frozen-lockfile`. Distinguish by the
		// Berry config marker `.yarnrc.yml`. maxBuffer 64MB: the default 1MB
		// aborts large monorepo installs mid-stream.
		const yarnBerry = existsSync(join(worktreePath, ".yarnrc.yml"));
		const argv = pm === "pnpm" ? ["pnpm", "install", "--frozen-lockfile", "--prefer-offline"]
			: pm === "yarn" ? (yarnBerry ? ["yarn", "install", "--immutable"] : ["yarn", "install", "--frozen-lockfile"])
			: pm === "bun" ? ["bun", "install", "--frozen-lockfile"]
			: ["npm", "ci", "--prefer-offline"];
		wt(`Setup bootstrapping dependencies in the fresh worktree (${argv.join(" ")}; timeout ${timeoutMs}ms)`);
		const r = execFileSync(argv[0], argv.slice(1), { cwd: worktreePath, timeout: timeoutMs, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 });
		wt(`Setup dependency bootstrap finished${r ? ` (tail: ${String(r).trim().slice(-200)})` : ""}`);
	} catch (err) {
		// Never block: a failed bootstrap degrades to today's behavior, but the
		// warning makes the later build-gate failure attributable.
		const msg = err instanceof Error ? err.message : String(err);
		wt(`Setup dependency bootstrap FAILED (continuing without it — later build-gate failures on missing dependencies are environmental, do NOT edit unrelated packages to work around them): ${msg.slice(0, 400)}`);
	}
}
