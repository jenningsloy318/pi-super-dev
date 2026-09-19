import { readFileSync, openSync, writeSync, closeSync, rmSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { externalStateAvailable, stateFileFor } from "../state/state-root.ts";

/** Wave 4 increment 3a: the SPEC-DIR RUN LOCK (OQ-3 / AC-30) — moved verbatim
 *  from setup.ts: the RUN_LOCK_BASENAME, the held-lock singleton, readLockHolder
 *  (+F-03 EPERM-is-alive), the F-10 empty-window bounded backoff
 *  (2x75ms Atomics.wait sync sleep), acquireRunLock (063 S1 state-funnel
 *  resolution, <=3 steal attempts, live-foreign-holder block, Sweep-3 SETUP-2
 *  fd close), and releaseHeldRunLock (pipeline.ts + extension finally).
 *  One reason to change: same-track serialization semantics. */

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

/** Bounded SYNCHRONOUS sleep (no child process, no event-loop dependency):
 *  Atomics.wait on a zero-initialized SharedArrayBuffer is the canonical
 *  sync sleep in Node and resolves in every context acquireRunLock runs in. */
function sleepSyncMs(ms: number): void {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** F-10 (v0.3.86): when readLockHolder returns null the file may be an
 *  EMPTied-but-locked window — another process's openSync("wx") has created
 *  the file but its writeSync has not landed yet. Stealing immediately (the
 *  old rmSync) let BOTH processes hold the lock (TOCTOU). Bounded backoff:
 *  2 retries × 75ms, stealing only if the file is STILL unreadable after the
 *  window — a genuine holder writes within one loop iteration, so the total
 *  added latency for the stale case is a fixed ≤150ms. */
const LOCK_EMPTY_RETRIES = 2;
const LOCK_EMPTY_BACKOFF_MS = 75;

function readLockHolderWithBackoff(path: string): { pid: number; startedAt?: string } | null {
	let holder = readLockHolder(path);
	if (holder !== null) return holder;
	for (let i = 0; i < LOCK_EMPTY_RETRIES && holder === null; i++) {
		sleepSyncMs(LOCK_EMPTY_BACKOFF_MS);
		holder = readLockHolder(path);
	}
	return holder;
}

export function acquireRunLock(specDirectory: string): void {
	// 063 S1 (spec §3.4 H2 concurrency ruling): the lock resolves through the
	// state funnel — EXTERNAL when derivable, so two worktrees/checkouts of one
	// repo running the SAME spec-id serialize on one lock instead of silently
	// racing over the shared external store (previously-parallel duplicate-spec
	// runs now hard-fail with the message below — the deliberate trade). The
	// fail-closed degradation keeps the legacy in-spec lock.
	const lockPath = stateFileFor(specDirectory, RUN_LOCK_BASENAME);
	if (externalStateAvailable(specDirectory)) mkdirSync(dirname(lockPath), { recursive: true });
	for (let attempt = 0; attempt < 3; attempt++) {
		let fd: number | undefined;
		try {
			fd = openSync(lockPath, "wx");
			writeSync(fd, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
			// Sweep-3 (B SETUP-2): close the descriptor — every acquisition leaked
			// one fd for the process lifetime (closeSync was imported, never called).
			closeSync(fd);
			fd = undefined;
			heldRunLockPath = lockPath;
			return;
		} catch (err) {
			const code = (err as { code?: string }).code;
			if (code !== "EEXIST") throw err; // real IO failure — fail closed
			// F-10: an EMPTY/unparseable lock gets the bounded backoff FIRST — the
			// competing process's writeSync usually lands within one retry, turning a
			// would-be steal into the honest live-holder block above.
			const holder = readLockHolderWithBackoff(lockPath);
			// A holder pid equal to process.pid is ALWAYS stolen; a live foreign
			// holder blocks; a dead/still-unreadable lock is stale and stolen.
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
