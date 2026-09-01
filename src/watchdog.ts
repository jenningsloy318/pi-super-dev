/**
 * v0.3.57 external delegation watchdog — arming side.
 *
 * The silent-zombie incident (ledger 2026-09-01): when the host event loop
 * froze, BOTH in-process liveness mechanisms died with it and the run hung
 * unlogged for 2.5h. This module arms a DETACHED watcher per delegation so a
 * frozen loop is RECORDED by a process that does not share the host's fate.
 *
 * Design rules:
 *  - P5 (checker never punishes the work): every failure here is fail-open.
 *    The watcher is telemetry-only — it never kills, cancels, or restores
 *    anything. If arming fails, the delegation runs exactly as before v0.3.57.
 *  - Heartbeat lifecycle: written at arm time (deadline = timeout + backstop
 *    margin + grace), deleted by dispose() on EVERY settle path. "Heartbeat
 *    still present past deadline with a live host" is therefore a proof that
 *    the settle path never ran — i.e. the loop is frozen.
 *  - Run-local isolation: heartbeats live under <runDir>/watchdog/ so runs
 *    never cross-contaminate; stale files (>24h) are swept at arm time.
 */
import { spawn } from "node:child_process";
import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getRunDir } from "./render/super-dev-dir.ts";

/** The in-process backstop fires at timeoutMs+2s; the external watcher may
 *  only speak AFTER that provably failed. Grace absorbs scheduler jitter. */
const GRACE_MS = 120_000;
/** Heartbeat TTL — stale files from crashed-but-not-frozen runs get swept. */
const HEARTBEAT_TTL_MS = 24 * 3_600_000;
/** Same fallback the delegation backend uses for un-timed calls. */
const DEFAULT_TIMEOUT_MS = 1_200_000;

export interface DelegationWatchdog {
	/** Idempotent. Removing the heartbeat file is the worker's exit signal. */
	dispose: () => void;
}

/**
 * Arm an external watcher for one delegation attempt. Returns a no-op
 * watchdog (and does nothing) when: SUPER_DEV_NO_WATCHDOG=1, there is no run
 * dir (tests / non-run contexts), or any filesystem/spawn step fails.
 */
export function armDelegationWatchdog(agent: string, timeoutMs: number | undefined, runDirOverride?: string): DelegationWatchdog {
	const noop: DelegationWatchdog = { dispose: () => {} };
	// Kill switch — a user who opts out gets exactly the pre-v0.3.57 behavior.
	if (process.env.SUPER_DEV_NO_WATCHDOG === "1") return noop;
	const runDir = runDirOverride ?? getRunDir();
	if (!runDir) return noop;
	const dir = join(runDir, "watchdog");
	try {
		mkdirSync(dir, { recursive: true });
		sweepStaleHeartbeats(dir);
	} catch {
		return noop;
	}
	const id = `${Date.now().toString(36)}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
	const heartbeatPath = join(dir, `${id}.json`);
	const verdictPath = join(dir, `${id}.verdict.json`);
	const effective = timeoutMs && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS;
	const heartbeat = {
		hostPid: process.pid,
		agent,
		runLogPath: join(runDir, "run.log"),
		verdictPath,
		startedAt: new Date().toISOString(),
		deadlineMs: Date.now() + effective + 2_000 + GRACE_MS,
	};
	try {
		writeFileSync(heartbeatPath, JSON.stringify(heartbeat));
	} catch {
		return noop;
	}
	const workerPath = join(dirname(fileURLToPath(import.meta.url)), "watchdog-worker.mjs");
	let child: ReturnType<typeof spawn>;
	try {
		child = spawn(process.execPath, [workerPath, heartbeatPath], { detached: true, stdio: "ignore" });
		child.unref();
	} catch {
		// Watcher could not start — remove the heartbeat so nothing can later
		// mistake this delegation for watched (P5: fail open, honestly inert).
		try { rmSync(heartbeatPath, { force: true }); } catch { /* best-effort */ }
		return noop;
	}
	// A worker that failed to exec must not leave a live heartbeat behind.
	child.on("error", () => {
		try { rmSync(heartbeatPath, { force: true }); } catch { /* best-effort */ }
	});
	let disposed = false;
	return {
		dispose() {
			if (disposed) return;
			disposed = true;
			try { rmSync(heartbeatPath, { force: true }); } catch { /* best-effort */ }
		},
	};
}

/** Delete heartbeat files older than the TTL (verdict files are evidence —
 *  they persist until the run dir itself is cleaned). Never throws. */
export function sweepStaleHeartbeats(dir: string): void {
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		return;
	}
	for (const f of entries) {
		if (!f.endsWith(".json") || f.endsWith(".verdict.json")) continue;
		try {
			const st = statSync(join(dir, f));
			if (Date.now() - st.mtimeMs > HEARTBEAT_TTL_MS) rmSync(join(dir, f), { force: true });
		} catch { /* raced with the worker — skip */ }
	}
}
