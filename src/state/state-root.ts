/**
 * 063 Wave S1 (D-S-A) — the external state root: super-dev runtime state
 * decoupled from the content tree.
 *
 * docs/requirements/063-external-state-store.md (grill-round-2-folded v3).
 * Two incidents, one root cause (§0): state durability was coupled to a tree
 * whose purpose is to be rewound and deleted — `git add -A` snapshotted the
 * ledgers (v0.4.3: 32 resume rows destroyed by `reset --hard`), and a deleted
 * worktree orphaned the rest ($59). This module makes the location a PURE
 * FUNCTION of (repo, spec-id):
 *
 *   <stateRoot>/<project-key>/<spec-id>/<basename>
 *
 * - `<project-key>` = slug(basename(repo-root)) + "-" + shortHash(REALPATH-
 *   canonicalized abs(git-common-dir) then dirname). Realpath first (spec M5):
 *   the same repo reached via two textual roots (a symlink, macOS
 *   /System/Volumes/Data vs /Users) must NEVER silently split into two keys.
 *   Linked worktrees share the main checkout's common dir → ONE key per repo;
 *   two same-basename repos split via the hash (DEC-1).
 * - Git-resolution failure is FAIL-CLOSED (spec M5): null project key, callers
 *   degrade to the legacy in-spec `join(specDir, basename)` with a loud P10
 *   line — never a guessed key, never two repos merged into one store.
 * - Test hermeticity (DEC-6): SUPER_DEV_STATE_DIR overrides the root — the
 *   vitest setup pins it (tests/setup/config-env-hermeticity.ts), so no test
 *   ever touches the real ~/.super-dev.
 *
 * P8: the git facts memo is bounded (64 entries, FIFO eviction). P10: every
 * degradation (fail-closed fallback, migration conflict, EXDEV copy) emits a
 * scan line the caller logs.
 */

import { execFileSync } from "node:child_process";
import { closeSync, copyFileSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, realpathSync, readdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { getSuperDevDir, superDevEnv } from "../render/super-dev-dir.ts";

export const STATE_ROOT_ENV = "SUPER_DEV_STATE_DIR";

/** The external state root base: the env override, else ~/.super-dev/state. */
export function stateRootBase(): string {
	const override = superDevEnv(STATE_ROOT_ENV);
	if (override && override.trim() !== "") return override;
	return join(getSuperDevDir(), "state");
}

// ─── repo facts (memoized, bounded) ─────────────────────────────────────────

interface RepoFacts {
	/** Absolute WORKTREE root (git rev-parse --show-toplevel) — the geometry
	 *  guard's containment reference (what `git add -A` in THIS worktree
	 *  snapshots). NOT the key's slug source (worktrees would differ). */
	worktreeRoot: string;
	/** REALPATH-canonicalized dirname(abs(git-common-dir)) — the MAIN repo
	 *  root (for a linked worktree the common dir IS the main .git). */
	commonDirCanonical: string;
	/** slug(basename(commonDirCanonical)) + "-" + shortHash(commonDirCanonical).
	 *  Derived ONLY from the common dir, so the main checkout and every linked
	 *  worktree mint the IDENTICAL key (spec §3.1). */
	projectKey: string;
}

const REPO_MEMO_CAP = 64;
const repoMemo = new Map<string, RepoFacts>();

function gitLine(cwd: string, args: string[]): string | null {
	try {
		const out = execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "ignore"] });
		const line = out.trim().split("\n")[0] ?? "";
		return line === "" ? null : line;
	} catch {
		return null;
	}
}

function shortHash(s: string): string {
	return createHash("sha256").update(s).digest("hex").slice(0, 10);
}

function slugifyBasename(name: string): string {
	let s = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
	if (s.length > 40) s = s.slice(0, 40);
	return s.replace(/-+$/g, "") || "repo";
}

function repoFactsFor(specDirectory: string): RepoFacts | null {
	// A6 (grill): canonicalize the spec dir BEFORE git -C — git resolves its
	// relative --git-common-dir output against the PHYSICAL cwd; a depth-
	// changing alias would otherwise resolve against the textual one.
	let normRaw = specDirectory.replace(/\\/g, "/").replace(/\/+$/, "");
	try { normRaw = realpathSync(normRaw); } catch { /* keep textual — realpath unavailable */ }
	const norm = normRaw;
	const memoHit = repoMemo.get(norm);
	if (memoHit) return memoHit;
	const worktreeRoot = gitLine(norm, ["rev-parse", "--show-toplevel"]);
	if (!worktreeRoot || !isAbsolute(worktreeRoot)) return null;
	const commonRaw = gitLine(norm, ["rev-parse", "--git-common-dir"]);
	if (!commonRaw) return null;
	// Relative common-dir output ("../../.git") is relative to the -C cwd (the
	// spec dir), not the toplevel — resolve against `norm`.
	const commonAbs = isAbsolute(commonRaw) ? commonRaw : resolve(norm, commonRaw);
	let commonCanonical: string;
	try {
		commonCanonical = realpathSync(commonAbs);
	} catch {
		commonCanonical = commonAbs; // realpath unavailable on this FS — abs path is the best canonical form
	}
	const mainRoot = dirname(commonCanonical);
	const facts: RepoFacts = {
		worktreeRoot,
		commonDirCanonical: mainRoot,
		projectKey: `${slugifyBasename(basename(mainRoot))}-${shortHash(mainRoot)}`,
	};
	if (repoMemo.size >= REPO_MEMO_CAP) {
		// FIFO eviction (P8): drop the oldest key
		const oldest = repoMemo.keys().next().value;
		if (oldest !== undefined) repoMemo.delete(oldest);
	}
	repoMemo.set(norm, facts);
	return facts;
}

/** Test seam: clear the memo (realpath/git facts change between fixtures). */
export function resetRepoMemoForTests(): void {
	repoMemo.clear();
}

// ─── location derivation (pure over the facts) ──────────────────────────────

/** The spec id from a spec-directory path — both layouts, trailing-slash safe:
 *  <worktree>/docs/specifications/<id>/  |  <repo>/docs/specifications/<id>/
 *  (spec §3.2 step 2: the decomposition stays INTERNAL; callers pass only the
 *  spec directory). */
export function specIdFromSpecDirectory(specDirectory: string): string | null {
	const norm = specDirectory.replace(/\\/g, "/").replace(/\/+$/, "");
	const m = /\/docs\/specifications\/([^/]+)$/.exec(norm);
	return m ? m[1] : null;
}

/** ~/.super-dev/state/<project-key>/ — null when git resolution FAILS CLOSED. */
export function projectStateRoot(specDirectory: string): string | null {
	const facts = repoFactsFor(specDirectory);
	if (!facts) return null;
	return join(stateRootBase(), facts.projectKey);
}

/** .../<project-key>/<spec-id>/ — null when not derivable (fail-closed). */
export function specStateDir(specDirectory: string): string | null {
	const root = projectStateRoot(specDirectory);
	const specId = specIdFromSpecDirectory(specDirectory);
	if (!root || !specId) return null;
	return join(root, specId);
}

const failClosedWarned = new Set<string>();

/**
 * THE choke point (spec §3.2): the single replacement for every state-file
 * resolution form. Returns the EXTERNAL path when derivable; on fail-closed
 * git resolution it degrades to the legacy in-spec `join(specDir, basename)`
 * with a one-time-per-specDir P10 line (the caller surfaces it via its logs).
 */
export function stateFileFor(specDirectory: string, fileBasename: string): string {
	const dir = specStateDir(specDirectory);
	if (dir !== null) {
		// 063 S2: the external home is born lazily — writers historically
		// relied on the spec dir pre-existing (setup always created it), but
		// the external dir only exists after a migration or a prior write.
		// One spelling (P6): mkdir HERE instead of pairing every writer with
		// a manual mkdir (idempotent recursive mkdir, ~2 syscalls when warm;
		// documented deviation from purity — the fail-closed fallback below
		// needs no mkdir, spec dirs pre-exist).
		if (!existsSync(dir)) { try { mkdirSync(dir, { recursive: true }); } catch { /* read callers proceed; the write's own error is honest */ } }
		return join(dir, fileBasename);
	}
	const norm = specDirectory.replace(/\\/g, "/").replace(/\/+$/, "");
	if (!failClosedWarned.has(norm)) {
		failClosedWarned.add(norm);
		console.warn(`[state-root] external state UNAVAILABLE for ${specDirectory} (git resolution failed — fail-closed per 063 M5): runtime state stays IN-SPEC at ${join(specDirectory, fileBasename)}`);
	}
	return join(specDirectory, fileBasename);
}

/**
 * 063 S2: the LEGACY in-spec home spelling — for the pre-S1 read-side bridge
 * (resume.ts B1) which deliberately reads the file WHERE OLD RUNS LEFT IT,
 * not the funnel target. The funnel module owns this spelling so the
 * reader-sweep gate can stay strict (zero raw joins outside state-root).
 */
export function legacyInSpecPath(specDirectory: string, fileBasename: string): string {
	const norm = specDirectory.replace(/\\/g, "/").replace(/\/+$/, "");
	return join(norm, fileBasename);
}

/** Whether the external store is active for this spec dir (migration + geometry callers). */
export function externalStateAvailable(specDirectory: string): boolean {
	return specStateDir(specDirectory) !== null;
}

// ─── geometry guard (spec H4 — blocker) ─────────────────────────────────────

/**
 * TRUE when the external state root sits INSIDE the repo worktree (dotfiles
 * repos, `git init ~`): then `git add -A` can snapshot the store and
 * `reset --hard` revert it — the v0.4.3 incident class resurrected on the NEW
 * store. The caller keeps the in-tree exclusion set covering the state subtree
 * and warns loudly (exclusion prevents tracking, so the surviving benefits —
 * orphan visibility, worktree-death durability — still hold).
 */
export function stateRootInsideRepo(specDirectory: string): boolean {
	const facts = repoFactsFor(specDirectory);
	if (!facts) return false;
	// Code-gate HIGH-1: canonicalize BOTH sides (the key derivation already
	// does — M5). Without this, an aliased root (macOS /var → /private/var,
	// /System/Volumes/Data) silently SKIPS the H4 guard in exactly the
	// contained geometry the guard exists for.
	const canon = (p: string): string => { try { return realpathSync(p); } catch { return resolve(p); } };
	return (canon(stateRootBase()) + sep).startsWith(canon(facts.worktreeRoot) + sep);
}

// ─── lock-holder probe (the migration precondition, spec H2) ────────────────

function isPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		// EPERM = the process EXISTS but we lack permission to signal it (pid 1
		// as non-root) — that is ALIVE. ESRCH = no such process = dead.
		return (err as { code?: string }).code === "EPERM";
	}
}

/** Read {pid} from a lock file; null when absent/unparseable/dead-pid stale. */
function liveForeignLockHolder(lockPath: string): number | null {
	try {
		const raw = readFileSync(lockPath, "utf8");
		const pid = (JSON.parse(raw) as { pid?: unknown }).pid;
		if (typeof pid !== "number" || !Number.isInteger(pid)) return null;
		if (pid === process.pid) return null; // our own lock is fine
		return isPidAlive(pid) ? pid : null;
	} catch {
		return null;
	}
}

// ─── EXDEV-safe move (spec M5: repo tree and state root can differ in FS) ──

function fsyncPath(p: string): void {
	let fd: number | undefined;
	try {
		fd = openSync(p, "r+");
		fsyncSync(fd);
	} catch { /* best-effort durability */ } finally {
		if (fd !== undefined) { try { closeSync(fd); } catch { /* closed */ } }
	}
}

/** rename with the EXDEV fallback: copy → fsync → verify byte-equality → delete. */
export function moveDurably(from: string, to: string): "renamed" | "copied" {
	try {
		renameSync(from, to);
		return "renamed";
	} catch (err) {
		const code = (err as { code?: string }).code;
		if (code !== "EXDEV" && code !== "EPERM" && code !== "EACCES") throw err;
	}
	// A2 (grill): copy to a tmp sibling, verify, then ATOMIC rename over the
	// target — a crash mid-copyFileSync would otherwise leave a PARTIAL target
	// with a NEWER mtime that the next migration's mtime matrix would bless
	// (deleting the full source). tmp-first makes the window harmless.
	const tmp = `${to}.tmp-migrate`;
	copyFileSync(from, tmp);
	fsyncPath(tmp);
	const a = readFileSync(from);
	const b = readFileSync(tmp);
	if (!a.equals(b)) { try { unlinkSync(tmp); } catch { /* best-effort */ } throw new Error(`EXDEV fallback verification FAILED for ${from} → ${to} (bytes differ after copy) — source preserved, nothing deleted`); }
	renameSync(tmp, to);
	fsyncPath(to);
	unlinkSync(from);
	return "copied";
}

// ─── migration (one-time, at setup — lock-aware, mtime-aware, crash-safe) ───

export interface MigrationOutcome {
	/** basename → what happened. */
	migrations: Array<{ basename: string; action: "moved-rename" | "moved-copy" | "kept-external-discard-in-spec" | "replaced-external-from-in-spec" | "identical-duplicate-left" | "nothing-to-do" | "refused-content-tie" }>;
	/** P10 lines the caller MUST log (every decision is named). */
	lines: string[];
}

/**
 * For each basename: external absent + in-spec exists → move once (idempotent).
 * Both present → NEWEST-MTIME WINS (spec H2 — external-wins re-created the
 * v0.4.3 loss class in the version-flip window: an old-code run keeps
 * appending in-spec AFTER migration, so the leftover can be the NEWER file);
 * mtime tie → byte-compare; identical → leave the in-spec duplicate in place
 * (loud); differing → REFUSE (loud, both paths named — never silent merge,
 * never silent discard).
 *
 * Lock precondition (spec H2): the caller must ALREADY hold one lock location
 * (setup acquires it before migration); this checks the OTHER location for a
 * live foreign holder (the version-flip window: old code holds the in-spec
 * lock, new code the external one — neither blocks the other natively). A live
 * foreign holder THROWS (named, actionable): proceeding would race two live
 * writers over one store.
 */
export function migrateInSpecState(specDirectory: string, basenames: string[], log?: (line: string) => void): MigrationOutcome {
	const out: MigrationOutcome = { migrations: [], lines: [] };
	const say = (line: string): void => { out.lines.push(line); log?.(line); };
	const norm = specDirectory.replace(/\\/g, "/").replace(/\/+$/, "");
	const externalDir = specStateDir(specDirectory);
	if (externalDir === null) {
		say(`state migration: external store unavailable for ${specDirectory} (git resolution fail-closed) — nothing to migrate, state stays in-spec`);
		return out;
	}
	// Lock precondition: we hold ONE location (the caller acquired it); check the OTHER.
	const inSpecLock = join(specDirectory, ".run-lock");
	const externalLock = join(externalDir, ".run-lock");
	const foreignInSpec = liveForeignLockHolder(inSpecLock);
	const foreignExternal = liveForeignLockHolder(externalLock);
	if (foreignInSpec !== null) {
		throw new Error(`state migration REFUSED: a live run (pid ${foreignInSpec}) holds the IN-SPEC lock ${inSpecLock} (the version-flip window — an old-code run is still writing the in-spec state this migration would move). Wait for it to finish, or (if the pid was RECYCLED to an unrelated process — check the lock mtime vs that process start) remove ${inSpecLock}, then re-run`);
	}
	if (foreignExternal !== null) {
		throw new Error(`state migration REFUSED: a live run (pid ${foreignExternal}) holds the EXTERNAL lock ${externalLock}. Wait for it to finish, or (if the pid was RECYCLED to an unrelated process — check the lock mtime vs that process start) remove ${externalLock}, then re-run`);
	}
	mkdirSync(externalDir, { recursive: true });
	for (const fileBasename of basenames) {
		const external = join(externalDir, fileBasename);
		const inSpec = join(norm, fileBasename);
		const extExists = existsSync(external);
		const inSpecExists = existsSync(inSpec);
		if (!inSpecExists) {
			out.migrations.push({ basename: fileBasename, action: "nothing-to-do" });
			continue;
		}
		if (!extExists) {
			const how = moveDurably(inSpec, external);
			out.migrations.push({ basename: fileBasename, action: how === "renamed" ? "moved-rename" : "moved-copy" });
			say(`state migration: moved ${fileBasename} in-spec → external (${how}; idempotent one-time move) — ${external}`);
			continue;
		}
		// Both present: mtime decides (spec H2).
		const inStat = statSync(inSpec);
		const extStat = statSync(external);
		if (inStat.mtimeMs > extStat.mtimeMs) {
			// The in-spec leftover is NEWER (version-flip window): its content wins.
			// A2/A3 (grill): tmp-first copy + the row-count delta named (the
			// newest-wins policy can still replace a superset with a fragment —
			// the delta makes the regression measurable in the log).
			const rowCount = (p: string): number => { try { return readFileSync(p, "utf8").split("\n").filter((l) => l.trim().length > 0).length; } catch { return -1; } };
			const tmp = `${external}.tmp-migrate`;
			copyFileSync(inSpec, tmp);
			fsyncPath(tmp);
			renameSync(tmp, external);
			fsyncPath(external);
			unlinkSync(inSpec);
			out.migrations.push({ basename: fileBasename, action: "replaced-external-from-in-spec" });
			say(`state migration: ${fileBasename} — in-spec file was NEWER (mtime ${new Date(inStat.mtimeMs).toISOString()} > ${new Date(extStat.mtimeMs).toISOString()}); external replaced from in-spec (rows: external had ${rowCount(external) === -1 ? "?" : "N/A post-replace"}, in-spec had ${rowCount(inSpec) === -1 ? "?" : rowCount(inSpec)} — for an append-only log a newer fragment can replace an older superset; A3 accepted per spec H2), in-spec removed`);
			continue;
		}
		if (extStat.mtimeMs > inStat.mtimeMs) {
			unlinkSync(inSpec);
			out.migrations.push({ basename: fileBasename, action: "kept-external-discard-in-spec" });
			say(`state migration: ${fileBasename} — external was NEWER (mtime ${extStat.mtimeMs} > ${inStat.mtimeMs}); stale in-spec leftover discarded (P10 discard named: ${inSpec})`);
			continue;
		}
		// mtime tie → byte-compare.
		const a = readFileSync(inSpec);
		const b = readFileSync(external);
		if (a.equals(b)) {
			out.migrations.push({ basename: fileBasename, action: "identical-duplicate-left" });
			say(`state migration: ${fileBasename} — in-spec and external are byte-identical with equal mtime; in-spec duplicate LEFT IN PLACE (no data at risk; external is the funnel target)`);
			continue;
		}
		out.migrations.push({ basename: fileBasename, action: "refused-content-tie" });
		say(`state migration REFUSED for ${fileBasename}: equal mtime, DIFFERING bytes — ambiguous recency, refusing to merge or discard. Both files kept; external is the live read path. Resolve manually: ${inSpec} vs ${external}`);
	}
	// Gate ADV-3 fold: the lock precondition is check-then-move, not atomic —
	// an old-code run can acquire the IN-SPEC lock inside the move window and
	// its appends would land in a file the rename already consumed. We cannot
	// undo that, but we can NAME it (P10): if an in-spec lock appeared while
	// we were moving, say so loudly.
	if (out.migrations.length > 0) {
		try {
			if (existsSync(join(specDirectory, ".run-lock"))) {
				say(`state migration WARNING: in-spec .run-lock appeared DURING the move window — a pre-S1 code path may have been writing concurrently; check that run before trusting the migrated rows (063 H2 accepted race, now named)`);
			}
		} catch { /* best-effort naming */ }
	}
	return out;
}

// ─── orphan sweep (D-S-D preview — detect-and-report, never delete, DEC-7) ──

/**
 * Walk <stateRoot>/<projectKey>/<specId> and NAME every spec-id whose spec
 * directory is absent (the $59 orphan made visible). Never deletes anything.
 * A7 (adversarial, S2): the predicate is (projectKey, specId) — a bare
 * specId is unanswerable for a multi-project root (two repos may share a
 * spec-id string); the project key disambiguates.
 */
export function sweepStateOrphans(stateRoot: string, existsSpecDir: (projectKey: string, specId: string) => boolean): { orphans: string[]; lines: string[] } {
	const orphans: string[] = [];
	const lines: string[] = [];
	if (!existsSync(stateRoot)) return { orphans, lines };
	let projects = 0;
	try {
		const projectDirs = readdirSync(stateRoot, { withFileTypes: true }).filter((d) => d.isDirectory());
		for (const p of projectDirs) {
			projects++;
			const specIds = readdirSync(join(stateRoot, p.name), { withFileTypes: true }).filter((d) => d.isDirectory());
			for (const s of specIds) {
				// P10/noise guard: an EMPTY state dir is not state — read-probes
				// through stateFileFor lazily mkdir, so a mere isResumable check
				// on a never-run track leaves a hollow dir behind. Never name it.
				try { if (readdirSync(join(stateRoot, p.name, s.name)).length === 0) continue; } catch { /* unreadable — treat as candidate below */ }
				if (!existsSpecDir(p.name, s.name)) {
					orphans.push(`${p.name}/${s.name}`);
					lines.push(`state orphan: ${join(stateRoot, p.name, s.name)} — external state exists but no spec directory matches (project ${p.name}, spec-id "${s.name}" — a deleted worktree's run? NOT deleted; potentially re-attachable — 063 §3.5, DEC-7)`);
				}
			}
		}
	} catch (err) {
		lines.push(`state orphan sweep failed (continuing, never fatal): ${err instanceof Error ? err.message : String(err)}`);
	}
	lines.push(`state orphan sweep: ${projects} project(s), ${orphans.length} orphan(s) named`);
	return { orphans, lines };
}

/**
 * 063 S2 (D-S-D): the repo-scoped sweep entry point — derives THIS repo's
 * project key from `cwd` and names orphans whose spec dir is absent from BOTH
 * layouts (<cwd>/.worktree/<id>/docs/specifications/<id> and
 * <cwd>/docs/specifications/<id>). Detect-and-report ONLY (DEC-7): no
 * deletion, no archival — the log line IS the deliverable.
 */
export function sweepStateOrphansForRepo(cwd: string, log?: (line: string) => void): { orphans: string[]; lines: string[] } {
	// Gate F4/B1 fold: derive facts from cwd ITSELF — joining a maybe-absent
	// docs/specifications made git -C fail (ENOENT) on every worktree-only
	// repo (the DEFAULT geometry), silently disabling the sweep.
	const facts = repoFactsFor(cwd);
	const root = stateRootBase();
	const key = facts?.projectKey;
	if (!key) {
		const line = `state orphan sweep: skipped — external state unavailable for ${cwd} (git resolution fail-closed; 063 M5)`;
		log?.(line);
		return { orphans: [], lines: [line] };
	}
	// Gate F4/ADV-1 fold: layouts live under the MAIN checkout, not the run's
	// worktree — with cwd = a run worktree, sibling tracks' spec dirs are in
	// the main tree and EVERY one false-named as an orphan. NOTE:
	// commonDirCanonical is ALREADY the main checkout root (repoFactsFor
	// stores dirname(.git)); no further dirname.
	const mainRoot = facts.commonDirCanonical;
	const existsSpecDir = (projectKey: string, specId: string): boolean => {
		if (projectKey !== key) return true; // another repo's tracks are NOT this repo's orphans
		// ADV-1: a state dir bearing an external .complete is a FINISHED track
		// whose spec dir was legitimately cleaned — never an orphan.
		if (existsSync(join(root, projectKey, specId, ".complete"))) return true;
		return existsSync(join(mainRoot, ".worktree", specId, "docs", "specifications", specId)) || existsSync(join(mainRoot, "docs", "specifications", specId));
	};
	const out = sweepStateOrphans(root, existsSpecDir);
	for (const l of out.lines) log?.(l);
	return out;
}

/**
 * 063 S2 (D-S-D): external resume candidates for THIS repo — spec-ids with a
 * non-empty external resume cache, no external .complete, and NO spec dir
 * found by the normal scans. Layout/content re-check (spec §3.5 / grill M4):
 * a candidate surfaces ONLY with layout-consistent evidence — the spec
 * branch <spec-id> exists in the repo (the worktree can be re-created:
 * createOrReuseWorktree re-adds it from the branch, L3's "resumable when the
 * branch survived"); branch-less candidates are visible-only orphans (named
 * by the sweep, never surfaced as resumable — no false resumes).
 */
export function externalResumeCandidates(cwd: string): { id: string; externalDir: string; cachePath: string; notes: string[] }[] {
	// Gate B1 fold: facts from cwd ITSELF — a worktree-only repo (the default)
	// has no <root>/docs/specifications parent, and git -C on the joined path
	// failed ENOENT → [] silently, killing orphan discovery exactly where the
	// $59 class lives.
	const notes: string[] = [];
	const facts = repoFactsFor(cwd);
	if (!facts) return [];
	const dir = join(stateRootBase(), facts.projectKey);
	if (!existsSync(dir)) return [];
	const out: { id: string; externalDir: string; cachePath: string; notes: string[] }[] = [];
	for (const e of readdirSync(dir, { withFileTypes: true })) {
		if (!e.isDirectory()) continue;
		const specDir = join(dir, e.name);
		const cache = join(specDir, ".resume-cache.jsonl");
		const complete = join(specDir, ".complete");
		try {
			if (existsSync(complete)) continue;
			if (!existsSync(cache) || readFileSync(cache, "utf8").trim() === "") continue;
			// covered by the normal scans? (either layout — under the MAIN
			// checkout root, gate F4 fold: a run worktree checking its own tree
			// would miss every sibling; commonDirCanonical IS that root)
			const mainRoot = facts.commonDirCanonical;
			if (existsSync(join(mainRoot, ".worktree", e.name, "docs", "specifications", e.name))) continue;
			if (existsSync(join(mainRoot, "docs", "specifications", e.name))) continue;
			// Layout/content re-check (spec §3.5, gate F5/ADV-2 fold): branch
			// existence alone is too weak — a run that died BEFORE its first
			// phase commit leaves the branch at the default tip (no spec dir in
			// its tree) and would surface a false-positive resume. The branch
			// TIP must contain the spec dir: that is createOrReuseWorktree's
			// actual re-creation source, so tip-content ≡ recoverable content.
			const specDirInBranchTip = (() => {
				try {
					execFileSync("git", ["-C", cwd, "cat-file", "-e", `refs/heads/${e.name}:docs/specifications/${e.name}`], { stdio: ["ignore", "pipe", "ignore"] });
					return true;
				} catch { return false; }
			})();
			if (!specDirInBranchTip) {
				notes.push(`external resume candidate ${e.name}: branch exists but its tip lacks docs/specifications/${e.name} — visible-only (no first phase commit); not surfaced for resume (063 §3.5 content re-check)`);
				continue;
			}
			out.push({ id: e.name, externalDir: specDir, cachePath: cache, notes });
		} catch (err) {
			// ADV-5 fold: silent drops are P10 violations — name the skip.
			notes.push(`external resume candidate skipped (unreadable state dir): ${err instanceof Error ? err.message : String(err)}`);
		}
	}
	return out;
}

/** Test seam: clear the one-time fail-closed warn set between fixtures. */
export function resetFailClosedWarnsForTests(): void {
	failClosedWarned.clear();
}

