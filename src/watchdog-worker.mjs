/**
 * v0.3.57 external delegation watchdog (detached worker).
 *
 * WHY THIS EXISTS — the silent-zombie incident (ledger 2026-09-01): both
 * delegation liveness mechanisms (the bridge's proc.on("close") and the
 * in-process `timeoutMs+2s` backstop timer) live in the HOST's event loop.
 * When that loop stops processing (frozen primitive, undiagnosable — ptrace
 * blocked), BOTH die with it, the run hangs forever, and NOTHING is logged.
 * Every in-process watchdog shares one failure domain with the thing it
 * watches; only an external process can record the death.
 *
 * CONTRACT (P5 — checker failures never punish the work):
 *   - watches ONE heartbeat file; exits silently the moment it disappears
 *     (the delegation settled normally — dispose() removed it);
 *   - exits silently if the host pid is dead (a dead host needs no marker;
 *     resume/startup owns recovery);
 *   - only when the host is ALIVE and the heartbeat is STILL present past
 *     its deadline (backstop + grace, so the in-process timeout provably had
 *     time to fire and did not) does it act — and all it does is APPEND an
 *     honest terminal marker to run.log + write a verdict file. It never
 *     kills, signals, or restores anything (telemetry-only, fail-open).
 *
 * ZERO imports from the extension by design: this process must stay runnable
 * (and stay honest) even when the host is wedged in exactly the state this
 * worker exists to diagnose.
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";

const heartbeatPath = process.argv[2];
if (!heartbeatPath) process.exit(2);

const POLL_MS = Number(process.env.WATCHDOG_POLL_MS) || 5_000;

for (;;) {
	await new Promise((resolve) => setTimeout(resolve, POLL_MS));
	let hb;
	try {
		hb = JSON.parse(readFileSync(heartbeatPath, "utf8"));
	} catch {
		// Removed between poll and read → disposed (delegation settled). Any
		// other transient read error: keep watching (fail-open telemetry).
		if (!existsSync(heartbeatPath)) process.exit(0);
		continue;
	}
	if (!hb || typeof hb.deadlineMs !== "number") continue;
	const now = Date.now();
	if (now < hb.deadlineMs) continue;
	let hostAlive = true;
	try {
		process.kill(hb.hostPid, 0);
	} catch {
		hostAlive = false;
	}
	if (!hostAlive) process.exit(0); // host died — nothing to guard; resume owns it
	const agent = typeof hb.agent === "string" ? hb.agent : "unknown";
	const startedAt = typeof hb.startedAt === "string" ? hb.startedAt : "unknown";
	const overdueMs = now - hb.deadlineMs;
	const line =
		`[${new Date().toISOString()}] WATCHDOG (external pid ${process.pid}): delegation '${agent}' ` +
		`(started ${startedAt}) is STILL PENDING ${Math.round(overdueMs) / 1000}s past its deadline — ` +
		`the host event loop appears frozen (the in-process timeout backstop did not fire). ` +
		`This run is presumed dead (silent zombie). Action: stop the host process, then resume or start a fresh run. ` +
		`This line was written by a detached external watcher because the host can no longer log.`;
	try {
		appendFileSync(hb.runLogPath, `${line}\n`);
	} catch {
		/* run.log unwritable — the verdict file below still records it */
	}
	try {
		writeFileSync(
			hb.verdictPath,
			JSON.stringify(
				{
					kind: "delegation-watchdog-verdict",
					hostPid: hb.hostPid,
					agent,
					startedAt,
					deadlineMs: hb.deadlineMs,
					detectedAt: new Date().toISOString(),
					verdict: "host-loop-frozen (delegation pending past deadline with heartbeat present)",
					runLogPath: hb.runLogPath,
				},
				null,
				2,
			),
		);
	} catch {
		/* best-effort — P5 fail-open */
	}
	process.exit(0);
}
