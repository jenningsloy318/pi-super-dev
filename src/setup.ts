/**
 * Deterministic setup stage — detects language/framework, derives a spec id,
 * creates a git worktree (unless skipped), and creates the spec directory.
 * Replaces the original LLM-driven setup agent; no model round-trip.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
// PRC (Track 30 Phase 5): the shared dirt primitives — REUSED, never
// duplicated (D-7: src/fault-classification.ts is the canonical exclusion/
// quarantine source so setup and the Stage 9 loop cannot drift).
import { collectDirtPaths, quarantineDirt, dirtyQuarantineEnabled, appendEnvironmentFault, readEnvironmentFaultCount } from "./fault-classification.ts";
import { resumeCachePath } from "./resume.ts";
import { externalStateAvailable, migrateInSpecState, stateFileFor, stateRootInsideRepo, sweepStateOrphansForRepo } from "./state/state-root.ts";
import { externalMigrateBasenames } from "./harness-paths.ts";
import { ensureRuntimeStateUntracked } from "./runtime-state-git.ts";
import { clearKnowledge } from "./render/knowledge.ts";
import { clearUserNotes } from "./render/user-notes.ts";
import { dirname, join, relative, resolve } from "node:path";
import type { SetupControl } from "./types.ts";
import { loadDotEnv, copyEnvFilesToWorktree, excludeCopiedEnvFiles } from "./setup/env-files.ts";
import { acquireRunLock } from "./setup/run-lock.ts";
export { RUN_LOCK_BASENAME, releaseHeldRunLock } from "./setup/run-lock.ts";
import { git, createOrReuseWorktree, detectDefaultBranch, isGitRepo, headExists, ensureGitIdentity } from "./setup/worktree-git.ts";
import { bootstrapDependencies } from "./setup/bootstrap.ts";
export { bootstrapDependenciesForTests } from "./setup/bootstrap.ts";
import { nextSpecNumber, sanitizeSlug, slugifyTask, slugFromSpecPathReference, dedupeSlugIndex, findReusableSpec, referencedSpecIdentifier, specReuseEnabled, SPEC_TASK_ANCHOR } from "./setup/spec-identity.ts";
export { sanitizeSlug, slugifyTask, taskTokens, taskSimilarity, slugTokenContainment, SPEC_TASK_ANCHOR, specRefNumerals, slugFromSpecPathReference, dedupeSlugIndex, anchorNumeralRefusal, specReuseEnabled, findReusableSpec, referencedSpecIdentifier } from "./setup/spec-identity.ts";
export { isEnvFile, copyEnvFilesToWorktree } from "./setup/env-files.ts";

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
		// v0.3.95 FIX A: docs/spec-tree path references contribute their basename
		// slug BEFORE the slugifyTask fallback (LLM options.slug still wins above).
		const slug = dedupeSlugIndex(sanitizeSlug(options.slug ?? "") || slugFromSpecPathReference(task) || slugifyTask(task), task);
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
			// v0.3.95 FIX A: same precedence as the kill-switch branch above.
			const slug = dedupeSlugIndex(sanitizeSlug(options.slug ?? "") || slugFromSpecPathReference(task) || slugifyTask(task), task);
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
	}
	// Sweep-3 G8: excludes are written for EVERY worktree-shaped run (fresh OR
	// reused) and even when NO env files were copied — the .run-lock /
	// .convergence-ledger.json bookkeeping entries must never ride an
	// unconditional `git add -A` into user branches. In-place (skipWorktree)
	// runs never mutate the user's own git config.
	if (worktreePath !== cwd) {
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
	// 063 S1 (§3.4): one-time migration of the proof basename's in-spec state —
	// lock-aware (we hold one location; a live FOREIGN holder on either throws
	// a named, actionable refusal), mtime-aware (newest wins; ties
	// byte-compare; differing-tie refuses loudly), EXDEV-safe. Runs under the
	// lock, BEFORE any reader (the M11 truncation below and every stage).
	try {
		// 063 S2 (D-S-D): the FULL durable set (stateExternal minus .run-lock —
		// stale in-spec locks are stolen harmlessly by the dead-pid path; the
		// live-lock case is the migration precondition's own refusal). user-input/
		// never migrates (spec M3 — assets stay in-tree).
		const report = migrateInSpecState(specDirectory, externalMigrateBasenames(), options.log);
		for (const line of report.lines) options.log?.(line);
	} catch (err) {
		// A live foreign holder: proceeding would race two writers over one
		// store — fail the setup loudly (the message names the lock + action).
		throw new Error(`Setup state migration refused: ${err instanceof Error ? err.message : String(err)}`);
	}
	// 063 S2 (D-S-D): the orphan sweep — external state whose spec dir is gone
	// is NAMED (P10), never deleted (DEC-7). Detect-and-report only.
	try { sweepStateOrphansForRepo(worktreePath, options.log); } catch { /* never fatal */ }

	// 063 S1 geometry guard (spec H4 — blocker): a repo rooted at/containing
	// $HOME puts the state store INSIDE the worktree; git add -A can snapshot
	// it and reset --hard revert it. Detection only here — the exclusion set
	// (runtime-state-git, below) still covers the basenames, and the loud line
	// tells the operator which geometry they are in.
	let geometryStateExclude: string | undefined;
	if (externalStateAvailable(specDirectory) && stateRootInsideRepo(specDirectory)) {
		options.log?.(`Setup GEOMETRY WARNING (063 H4): the external state root resolves INSIDE this repo's worktree (dotfiles-style repo) — git add -A can snapshot it and reset --hard revert it, and git clean -fdx would REMOVE ignored-untracked state outright. The runtime-state exclusion set stays ACTIVE for this run (exclusion prevents tracking); orphan visibility still applies; AVOID git clean in this repo`);
		// A5 (grill): exclude the WHOLE state-root base subtree (not just this
		// run's key/spec dir) — sibling tracks' state lives under it too — and
		// the warning names the clean hazard (ignored ≠ clean-safe).
		const stateRootAbs = stateFileFor(specDirectory, ".run-lock");
		const stateBaseAbs = dirname(dirname(stateRootAbs)); // <stateRoot>/<key>/<spec> → <stateRoot>
		const candidate = stateBaseAbs.startsWith(worktreePath) ? stateBaseAbs : dirname(stateRootAbs);
		if (candidate.startsWith(worktreePath)) geometryStateExclude = relative(worktreePath, candidate).replace(/\\/g, "/");
	}
	// G2: persist the anchor task at first allocation of a track (never
	// overwritten) so later re-phrased runs can deterministically find and
	// re-enter this track instead of fragmenting into siblings.
	const anchorPath = stateFileFor(specDirectory, SPEC_TASK_ANCHOR) // 063 S2;
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
	// 063 S1: the M11 truncation routes through the resume.ts funnel (the old
	// INLINE literal bypassed it — setup.ts:776 was the H1 third toucher; a
	// split-brain here would mix a dead run's occurrence keys into the fresh
	// external cache).
	const staleResumeCachePath = resumeCachePath(specDirectory);
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

	// v0.4.3 — resume-cache durability (run 2026-09-15T08-13-05-056Z class):
	// super-dev runtime state files must never be git-tracked, or the engine's
	// own checkpoint rollback (`git reset --hard` to a phase commit that
	// snapshotted them) silently truncates the resume cache and later replays
	// converged stages live. Untrack + info/exclude-ignore them (worktree runs;
	// in-place runs warn only). Best-effort, never throws.
	try {
		const state = ensureRuntimeStateUntracked({ worktreePath, specDirectory, worktreeCreated, log: options.log, extraExcludePaths: geometryStateExclude ? [geometryStateExclude] : [] });
		if (state.status === "applied") {
			if (state.untracked.length > 0) options.log?.(`Setup untracked ${state.untracked.length} runtime state file(s) from git — resume ledgers must survive checkpoint rollbacks (reset --hard otherwise reverts them to a phase-commit snapshot; run 2026-09-15T08-13-05-056Z class): ${state.untracked.join(", ")}`);
			if (state.ignored.length > 0) options.log?.(`Setup git-ignored ${state.ignored.length} runtime state path(s) via $GIT_DIR/info/exclude (project .gitignore untouched): ${state.ignored.length > 3 ? `${state.ignored.slice(0, 3).join(", ")}, …` : state.ignored.join(", ")}`);
			for (const e of state.errors) options.log?.(`Setup runtime-state untrack partial failure (continuing): ${e}`);
		} else {
			options.log?.(`Setup runtime-state untrack skipped — ${state.reason}`);
		}
	} catch (err) {
		options.log?.(`Setup runtime-state untrack failed (continuing — best-effort by contract): ${err instanceof Error ? err.message : String(err)}`);
	}

	return { worktreePath, specDirectory, defaultBranch, language, isWebUi, specIdentifier, worktreeCreated, initializedRepo, copiedEnvFiles, reusedTrack };
}

