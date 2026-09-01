/**
 * v0.3.57 — external delegation watchdog (silent-zombie incident, ledger
 * 2026-09-01). Layers per docs/testing-strategy.md:
 *  - L0: arming math / kill switch / no-run-dir no-op (no processes).
 *  - L2: the REAL detached worker executed against real heartbeat files —
 *    fires the marker on a live host past deadline, stands down on dispose,
 *    stands down on a dead host (execute, don't string-match).
 */
import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { armDelegationWatchdog, sweepStaleHeartbeats } from "../src/watchdog.ts";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) { try { rmSync(d, { recursive: true, force: true }); } catch { /* ok */ } } });
const tempDir = () => { const d = mkdtempSync(join(tmpdir(), "wdtest-")); dirs.push(d); return d; };

const WORKER = join(import.meta.dirname, "..", "src", "watchdog-worker.mjs");

/** Run the real worker in the foreground with a short deadline and wait for
 *  it to exit (the detached spawn path is exercised by L0; the CONTRACT is
 *  exercised here against real files). WATCHDOG_POLL_MS keeps the worker's
 *  poll cycle fast so the suite stays honest AND quick. */
function runWorker(heartbeatPath: string): void {
	const r = spawnSync(process.execPath, [WORKER, heartbeatPath], { encoding: "utf8", timeout: 30_000, env: { ...process.env, WATCHDOG_POLL_MS: "50" } });
	if (r.status !== 0 && r.status !== null) throw new Error(`watchdog worker exited ${r.status}: ${r.stderr?.slice(0, 200)}`);
}

describe("v0.3.57 L0 — armDelegationWatchdog arming rules", () => {
	it("no run dir → no-op watchdog, no files anywhere", () => {
		const wd = armDelegationWatchdog("test-agent", 60_000);
		expect(typeof wd.dispose).toBe("function");
		wd.dispose(); // must not throw
	});
	it("SUPER_DEV_NO_WATCHDOG=1 → no-op even with a run dir", () => {
		const run = tempDir();
		const saved = process.env.SUPER_DEV_NO_WATCHDOG;
		process.env.SUPER_DEV_NO_WATCHDOG = "1";
		try {
			const wd = armDelegationWatchdog("test-agent", 60_000, run);
			wd.dispose();
			expect(existsSync(join(run, "watchdog"))).toBe(false);
		} finally {
			if (saved === undefined) delete process.env.SUPER_DEV_NO_WATCHDOG; else process.env.SUPER_DEV_NO_WATCHDOG = saved;
		}
	});
	it("arms a heartbeat with deadline = now + timeout + backstop + grace; dispose removes it", async () => {
		const run = tempDir();
		const t0 = Date.now();
		const wd = armDelegationWatchdog("test-agent", 60_000, run);
		const dir = join(run, "watchdog");
		const files = readdirSync(dir).filter((f) => f.endsWith(".json") && !f.endsWith(".verdict.json"));
		expect(files).toHaveLength(1);
		const hb = JSON.parse(readFileSync(join(dir, files[0]!), "utf8")) as { agent: string; hostPid: number; deadlineMs: number; runLogPath: string };
		expect(hb.agent).toBe("test-agent");
		expect(hb.hostPid).toBe(process.pid);
		expect(hb.runLogPath).toBe(join(run, "run.log"));
		const delta = hb.deadlineMs - t0;
		expect(delta).toBeGreaterThanOrEqual(60_000 + 2_000 + 120_000);
		expect(delta).toBeLessThanOrEqual(60_000 + 2_000 + 120_000 + 5_000);
		wd.dispose();
		expect(readdirSync(dir).filter((f) => f.endsWith(".json") && !f.endsWith(".verdict.json"))).toHaveLength(0);
	});
	it("sweepStaleHeartbeats removes >24h heartbeats, keeps fresh ones and verdict files", () => {
		const run = tempDir();
		const dir = join(run, "watchdog");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "stale.json"), "{}");
		utimesSync(join(dir, "stale.json"), new Date(Date.now() - 25 * 3_600_000), new Date(Date.now() - 25 * 3_600_000));
		writeFileSync(join(dir, "fresh.json"), "{}");
		writeFileSync(join(dir, "done.verdict.json"), "{}");
		sweepStaleHeartbeats(dir);
		expect(existsSync(join(dir, "stale.json"))).toBe(false);
		expect(existsSync(join(dir, "fresh.json"))).toBe(true);
		expect(existsSync(join(dir, "done.verdict.json"))).toBe(true); // evidence persists
	});
});

describe("v0.3.57 L2 — the real worker executes its contract", () => {
	it("fires: live host + heartbeat past deadline → honest marker in run.log + verdict file", async () => {
		const run = tempDir();
		const dir = join(run, "watchdog");
		mkdirSync(dir, { recursive: true });
		const hbPath = join(dir, "hb.json");
		const runLog = join(run, "run.log");
		writeFileSync(runLog, "prior line\n");
		writeFileSync(hbPath, JSON.stringify({ hostPid: process.pid, agent: "implementer", runLogPath: runLog, verdictPath: join(dir, "hb.verdict.json"), startedAt: new Date().toISOString(), deadlineMs: Date.now() + 1_000 }));
		runWorker(hbPath);
		const log = readFileSync(runLog, "utf8");
		expect(log).toContain("prior line"); // append-only, never truncates
		expect(log).toContain("WATCHDOG");
		expect(log).toContain("implementer");
		expect(log).toContain("host event loop appears frozen");
		const verdict = JSON.parse(readFileSync(join(dir, "hb.verdict.json"), "utf8")) as { kind: string; hostPid: number };
		expect(verdict.kind).toBe("delegation-watchdog-verdict");
		expect(verdict.hostPid).toBe(process.pid);
	});

	it("stands down: heartbeat removed (dispose) before deadline → no marker", async () => {
		const run = tempDir();
		const dir = join(run, "watchdog");
		mkdirSync(dir, { recursive: true });
		const hbPath = join(dir, "hb2.json");
		const runLog = join(run, "run.log");
		writeFileSync(runLog, "");
		writeFileSync(hbPath, JSON.stringify({ hostPid: process.pid, agent: "x", runLogPath: runLog, verdictPath: join(dir, "hb2.verdict.json"), startedAt: new Date().toISOString(), deadlineMs: Date.now() + 1_000 }));
		rmSync(hbPath); // the dispose race the worker must honor
		runWorker(hbPath);
		expect(readFileSync(runLog, "utf8")).toBe("");
		expect(existsSync(join(dir, "hb2.verdict.json"))).toBe(false);
	});

	it("stands down: dead host + pending heartbeat → no marker (resume owns recovery)", async () => {
		// A pid that is (almost certainly) not alive: spawn a sleeper and kill it.
		const sleeper = spawn("sleep", ["30"], { stdio: "ignore" });
		await new Promise((r) => setTimeout(r, 150));
		const deadPid = sleeper.pid!;
		sleeper.kill("SIGKILL");
		await new Promise((r) => setTimeout(r, 150));
		const run = tempDir();
		const dir = join(run, "watchdog");
		mkdirSync(dir, { recursive: true });
		const hbPath = join(dir, "hb3.json");
		const runLog = join(run, "run.log");
		writeFileSync(runLog, "");
		writeFileSync(hbPath, JSON.stringify({ hostPid: deadPid, agent: "x", runLogPath: runLog, verdictPath: join(dir, "hb3.verdict.json"), startedAt: new Date().toISOString(), deadlineMs: Date.now() + 1_000 }));
		runWorker(hbPath);
		expect(readFileSync(runLog, "utf8")).toBe("");
		expect(existsSync(join(dir, "hb3.verdict.json"))).toBe(false);
	});
});
