import { existsSync, mkdirSync, readFileSync, readdirSync, copyFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { git } from "./worktree-git.ts";

/** Wave 4 increment 1: env-file PROPAGATION — the .env loader (process.env
 *  merge, existing wins), the recursive worktree copier (H6/AC-07: never
 *  overwrite, prune heavy dirs, best-effort), the copier's own predicate, and
 *  the common-info/exclude writer (H6/AC-08 + Sweep-3 G8 unconditional
 *  harness-bookkeeping excludes + F-04 .run-lock + v0.3.3 L1 ledger) — moved
 *  verbatim from setup.ts. One reason to change: how env files reach worktrees.
 *  The git() helper comes from the sibling worktree-git.ts (the wave-4 I3
 *  review fold: the original private copy predates worktree-git exporting it). */

/** Load KEY=VALUE pairs from a `.env` file into `process.env` so spawned
 *  specialist agents (api-tester, etc.) inherit them. Only sets vars that
 *  aren't already defined (existing env wins). This is how TEST_API_KEY and
 *  other test credentials become available during Stage 11 Integration Testing. */
export function loadDotEnv(dir: string): void {
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

/** H6 (ISS-01 / AC-08): append each copied repo-relative env path to the repo's
 *  COMMON exclude file — the only per-repo exclude git reads for EVERY worktree
 *  (gitrepository-layout(5); verified on git 2.47.3: `--git-path info.exclude`
 *  inside a linked worktree resolves to .git/worktrees/<id>/info/exclude, which
 *  git never reads). Patterns are repo-relative and intentionally apply to all
 *  worktrees: a copied env file must never be committed anywhere. Idempotent
 *  (dedupe by exact pattern line). Best-effort — AC-07's cleanup scan is the
 *  backstop. */
const COPIED_ENV_EXCLUDE_HEADER = "# pi-super-dev copied env files (never committed)";

export function excludeCopiedEnvFiles(worktreeRoot: string, copiedRelPaths: string[]): void {
	// Sweep-3 G8: the harness-bookkeeping excludes (.run-lock, .convergence-
	// ledger.json) must be written UNCONDITIONALLY — pre-fix the early return
	// when no env files were copied left env-less repos with NO excludes, so an
	// unconditional `git add -A` snapshotted the lock/ledger into user branches.
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

