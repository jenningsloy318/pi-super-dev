/**
 * Tests for the deterministic service lifecycle (Phase 2a). Uses a REAL tiny
 * HTTP server spawned as a child process — no mocks — so start/readiness/kill
 * are exercised end-to-end (and fast).
 */
import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import { writeFileSync, mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	pickFreePort,
	waitForReady,
	startService,
	stopService,
	detectServices,
	withServiceDeps,
} from "../src/stages/lifecycle.ts";
import { SIGTERM_GRACE_MS } from "../src/agents/agent-runtime.ts";
import { createServer } from "node:net";
import type { Node, PipelineState, ServiceHandle } from "../src/types.ts";

/** A minimal node HTTP server script that listens on $PORT and responds "ok". */
const TINY_SERVER = String.raw`
import { createServer } from "node:http";
const srv = createServer((req, res) => res.end("ok"));
srv.listen(process.env.PORT, () => console.log("up"));
`;

describe("pickFreePort", () => {
	it("returns a usable port (we can bind it)", async () => {
		const port = await pickFreePort();
		expect(port).toBeGreaterThan(0);
		// binding again should work (pickFreePort releases its placeholder)
		const port2 = await pickFreePort();
		expect(port2).toBeGreaterThan(0);
	});
});

describe("waitForReady", () => {
	it("returns false quickly for a dead url", async () => {
		const ok = await waitForReady("http://127.0.0.1:1/", 400);
		expect(ok).toBe(false);
	}, 5000);
});

describe("startService / stopService (real child server)", () => {
	it("starts the server, readiness-passes, and teardown kills it", async () => {
		const dir = mkdtempSync(join(tmpdir(), "sd-life-"));
		writeFileSync(join(dir, "server.mjs"), TINY_SERVER);
		const h = await startService({
			role: "api",
			cmd: `node ${join(dir, "server.mjs")}`,
			cwd: dir,
			portEnv: "PORT",
			readinessTimeoutMs: 8000,
		});
		expect(h.ready).toBe(true);
		expect(h.port).toBeGreaterThan(0);
		expect(h.baseUrl).toBe(`http://127.0.0.1:${h.port}`);
		// the server actually responds
		const res = await fetch(h.baseUrl);
		expect(res.ok).toBe(true);
		expect(await res.text()).toBe("ok");
		// teardown
		stopService(h);
		// give the OS a moment to release, then confirm it's gone
		await new Promise((r) => setTimeout(r, 300));
		await expect(fetch(h.baseUrl)).rejects.toThrow();
		rmSync(dir, { recursive: true, force: true });
	}, 15_000);

	it("REFUSES a dangerous model-discovered bringup command (safety-hook parity) without spawning", async () => {
		const dir = mkdtempSync(join(tmpdir(), "sd-life-danger-"));
		const before = Date.now();
		const h = await startService({
			role: "api",
			// A destructive command that the agent bash hook would block — bringup
			// must not execute it via shell:true.
			cmd: "rm -rf / && node server.mjs",
			cwd: dir,
			portEnv: "PORT",
			readinessTimeoutMs: 8000,
		});
		// Refused: not ready, no pid, and it returned immediately (never waited for
		// readiness / never spawned).
		expect(h.ready).toBe(false);
		expect(h.pid).toBe(-1);
		expect(Date.now() - before).toBeLessThan(2000);
		rmSync(dir, { recursive: true, force: true });
	});
});

describe("stopService edge cases", () => {
	it("is a no-op for external (reused) services and invalid pids", () => {
		expect(() => stopService({ role: "api", baseUrl: "x", pid: -1, port: 0, cmd: "", external: true, ready: true } as ServiceHandle)).not.toThrow();
		expect(() => stopService({ role: "api", baseUrl: "x", pid: 999999, port: 0, cmd: "", external: false, ready: true } as ServiceHandle)).not.toThrow();
	});
});

describe("detectServices", () => {
	it("detects an api server from a start script + express dep, and a ui dev server from vite", () => {
		const dir = mkdtempSync(join(tmpdir(), "sd-detect-"));
		writeFileSync(
			join(dir, "package.json"),
			JSON.stringify({
				scripts: { start: "node src/server.js", dev: "vite" },
				dependencies: { express: "^4.0.0" },
				devDependencies: { vite: "^5.0.0" },
			}),
		);
		const d = detectServices(dir);
		expect(d.api?.cmd).toBe("node src/server.js");
		expect(d.api?.portEnv).toBe("PORT");
		expect(d.ui?.cmd).toBe("vite");
		rmSync(dir, { recursive: true, force: true });
	});
	it("returns nothing when there's no package.json", () => {
		const dir = mkdtempSync(join(tmpdir(), "sd-empty-"));
		expect(detectServices(dir)).toEqual({});
		rmSync(dir, { recursive: true, force: true });
	});
});

describe("withServiceDeps guard", () => {
	const mkCtx = () => ({ log: () => {}, events: { on: () => {}, emit: () => {} }, signal: undefined, results: [] } as unknown as Parameters<Node["run"]>[1]);
	it("runs the wrapped node when all deps are ready", async () => {
		let ran = false;
		const inner: Node = { kind: "x", async run() { ran = true; return { status: "ok" }; } };
		const state = { services: { api: { ready: true } } } as unknown as PipelineState;
		const r = await withServiceDeps(["api"], inner).run(state, mkCtx());
		expect(ran).toBe(true);
		expect(r.status).toBe("ok");
	});
	it("SKIPS (does not run) when a required service is missing/not-ready", async () => {
		let ran = false;
		const inner: Node = { kind: "x", async run() { ran = true; return { status: "ok" }; } };
		const state = { services: { api: { ready: false } } } as unknown as PipelineState;
		const r = await withServiceDeps(["api", "ui"], inner).run(state, mkCtx());
		expect(ran).toBe(false);
		expect(r.status).toBe("skipped");
	});
	it("skips when there are no services at all", async () => {
		const inner: Node = { kind: "x", async run() { return { status: "ok" }; } };
		const r = await withServiceDeps(["api"], inner).run({} as PipelineState, mkCtx());
		expect(r.status).toBe("skipped");
	});
});

describe("bringupTask try/fallback ladder", () => {
	it("uses the assessment-discovered cmd, but falls back when it fails readiness", async () => {
		const { bringupTask } = await import("../src/stages/lifecycle.ts");
		const dir = mkdtempSync(join(tmpdir(), "sd-bringup-"));
		// a real working server the fallback can start
		writeFileSync(join(dir, "server.mjs"), TINY_SERVER);
		writeFileSync(
			join(dir, "package.json"),
			JSON.stringify({ scripts: { start: `node ${join(dir, "server.mjs")}` }, dependencies: { express: "1" } }),
		);
		const logs: string[] = [];
		const ctx = { log: (m: string) => logs.push(m) } as unknown as Parameters<typeof bringupTask.run>[1];
		// assessment "discovers" a command that does NOT come up → must fall back
		const state = {
			setup: { worktreePath: dir },
			assessment: { services: { api: { cmd: "node -e 'setInterval(()=>{},9999)'", portEnv: "PORT", readyPath: "/" } } },
			classify: { uiScope: "none" },
		} as unknown as PipelineState;
		const res = (await bringupTask.run(state, ctx)) as { services: { api?: { ready: boolean; baseUrl: string } }; summary: string };
		expect(res.services.api?.ready).toBe(true);
		// it logged that the bad cmd failed and tried the next candidate
		expect(logs.some((l) => /did not become ready/.test(l))).toBe(true);
		// and the server is actually up
		const up = await fetch(res.services.api!.baseUrl);
		expect(await up.text()).toBe("ok");
		// teardown
		const { stopService } = await import("../src/stages/lifecycle.ts");
		stopService(state.services!.api!);
		rmSync(dir, { recursive: true, force: true });
	}, 30_000);
});

describe("loadDotEnv", () => {
	it("parses KEY=VALUE lines, comments, and quoted values; missing file → {}", async () => {
		const { loadDotEnv } = await import("../src/stages/lifecycle.ts");
		const dir = mkdtempSync(join(tmpdir(), "sd-env-"));
		writeFileSync(join(dir, ".env"), "# comment\nFOO=bar\nTOKEN=\"secret with spaces\"\nEMPTY=\nQUOTED='q'\n");
		const e = loadDotEnv(dir);
		expect(e.FOO).toBe("bar");
		expect(e.TOKEN).toBe("secret with spaces");
		expect(e.EMPTY).toBe(""); // has '=', empty value
		expect(e.QUOTED).toBe("q");
		// missing file → empty object
		expect(loadDotEnv(mkdtempSync(join(tmpdir(), "sd-env2-")))).toEqual({});
	});
});

// ─── Phase 6 / T6.3 (AC-24): service teardown SIGKILL + abortable readiness ──

/** A server that TRAPS SIGTERM (registered handler, never exits on it) — the
 *  SCENARIO-050 fixture. It self-exits at 25s as a leak guard for a failing
 *  run; the group-SIGKILL teardown (10s grace) must win long before that. */
const SIGTERM_TRAPPING_SERVER = String.raw`
import { createServer } from "node:http";
import { writeFileSync } from "node:fs";
process.on("SIGTERM", () => { /* trap: registered handler, no exit */ });
const srv = createServer((req, res) => res.end("ok"));
srv.listen(process.env.PORT, () => console.log("up"));
setInterval(() => {}, 1000);
setTimeout(() => { writeFileSync(process.env.SELF_EXIT_MARKER ?? "/tmp/sd-selfexit", "self"); process.exit(0); }, 25000);
`;

describe("AC-24 (SCENARIO-050): a SIGTERM-trapping service is group-SIGKILLed and the port is released", () => {
	it("stopService escalates to group SIGKILL after the grace, then ESRCH + the port is bindable", async () => {
		const dir = mkdtempSync(join(tmpdir(), "sd-life-sigkill-"));
		writeFileSync(join(dir, "trap-server.mjs"), SIGTERM_TRAPPING_SERVER);
		const marker = join(dir, "selfexit.txt");
		const h = await startService({
			role: "api",
			cmd: `node ${join(dir, "trap-server.mjs")}`,
			cwd: dir,
			portEnv: "PORT",
			readinessTimeoutMs: 8000,
			// thread the leak-guard marker path through the service env
			env: { SELF_EXIT_MARKER: marker },
		});
		expect(h.ready).toBe(true);
		const pid = h.pid;
		expect(pid).toBeGreaterThan(0);

		stopService(h);
		// The SIGTERM was trapped — the process must still be alive immediately.
		expect(() => process.kill(pid, 0)).not.toThrow();
		// …but after the SIGTERM grace the teardown must have group-SIGKILLed it.
		await new Promise((r) => setTimeout(r, SIGTERM_GRACE_MS + 1_500));
		expect(() => process.kill(pid, 0)).toThrow(/ESRCH|No such process/);
		// It was killed by the ladder, not its own 25s self-exit guard.
		expect(existsSync(marker)).toBe(false);
		// And the released port is bindable again by a fresh listener.
		await expect(new Promise<void>((resolve, reject) => {
			const srv = createServer();
			srv.once("error", reject);
			srv.listen(h.port, "127.0.0.1", () => { srv.close(() => resolve()); });
		})).resolves.toBeUndefined();
		rmSync(dir, { recursive: true, force: true });
	}, 20_000);
});

describe("AC-24 (SCENARIO-051): aborted readiness polling stops within one iteration", () => {
	it("a pre-aborted signal returns false immediately (no timeoutMs wait)", async () => {
		const started = Date.now();
		const ok = await waitForReady("http://127.0.0.1:1/", 5_000, AbortSignal.abort());
		expect(ok).toBe(false);
		expect(Date.now() - started).toBeLessThan(1_500);
	}, 8_000);

	it("a mid-poll abort breaks the loop within ≤ one 250ms sleep", async () => {
		const controller = new AbortController();
		const started = Date.now();
		const poll = waitForReady("http://127.0.0.1:1/", 8_000, controller.signal);
		setTimeout(() => controller.abort(), 120);
		const ok = await poll;
		expect(ok).toBe(false);
		expect(Date.now() - started).toBeLessThan(2_000);
	}, 10_000);
});

describe("AC-24 (SCENARIO-051): tryStartService stops between candidates when the run aborts", () => {
	it("bringupTask never starts the NEXT candidate after the signal aborts (marker proves it never ran)", async () => {
		const { bringupTask } = await import("../src/stages/lifecycle.ts");
		const dir = mkdtempSync(join(tmpdir(), "sd-bringup-abort-"));
		// candidate 2: a WORKING server that proves it ran by touching a marker.
		const marker = join(dir, "candidate2-started");
		writeFileSync(join(dir, "server.mjs"), [
			'import { createServer } from "node:http";',
			'import { writeFileSync } from "node:fs";',
			`writeFileSync(${JSON.stringify(marker)}, "started");`,
			'const srv = createServer((req, res) => res.end("ok"));',
			'srv.listen(process.env.PORT, () => console.log("up"));',
		].join("\n"));
		writeFileSync(
			join(dir, "package.json"),
			JSON.stringify({ scripts: { start: `node ${join(dir, "server.mjs")}` }, dependencies: { express: "1" } }),
		);
		const controller = new AbortController();
		controller.abort(); // pre-aborted run: every remaining candidate is moot
		const logs: string[] = [];
		const ctx = {
			log: (m: string) => logs.push(m),
			signal: controller.signal,
		} as unknown as Parameters<typeof bringupTask.run>[1];
		const state = {
			setup: { worktreePath: dir },
			// assessment "discovers" a command that never becomes ready (candidate 1)
			assessment: { services: { api: { cmd: "node -e 'setInterval(() => {}, 4000)'", portEnv: "PORT", readyPath: "/" } } },
			classify: { uiScope: "none" },
		} as unknown as PipelineState;
		const started = Date.now();
		const res = (await bringupTask.run(state, ctx)) as { services: Record<string, unknown> };
		// No api service came up AND the working fallback candidate never started.
		expect(res.services.api).toBeUndefined();
		expect(existsSync(marker)).toBe(false);
		expect(Date.now() - started).toBeLessThan(5_000);
		rmSync(dir, { recursive: true, force: true });
	}, 25_000);
});

// ─── static-site strategy + discovered-cmd sanitization (run 2026-08-27T12-33-43-088Z) ──

import {
	sanitizeDiscoveredCmd,
	fixedPortFromCmd,
	detectStaticSite,
	staticServerCandidates,
	bringupTask as bringupTaskRe,
} from "../src/stages/lifecycle.ts";

describe("sanitizeDiscoveredCmd — run-1's prose-polluted discovery", () => {
	it("strips a trailing shell comment from an otherwise clean command", () => {
		expect(sanitizeDiscoveredCmd("make dev # = caddy run --config Caddyfile")).toBe("make dev");
	});

	it("sanitizes the observed prose paragraph down to its real command", () => {
		// Run 1's candidate #1: a clean command leader + a whole explanatory
		// paragraph in the trailing comment. The fix strips the comment — the
		// ladder then gets a sane `make dev` (which still fails readiness on the
		// random port and falls through to the static ladder) instead of garbage.
		const observed = "make dev   # = caddy run --config Caddyfile  NOTE: Caddyfile root points at the PARENT dir so /nuclear-fission-3d/ resolves";
		expect(sanitizeDiscoveredCmd(observed)).toBe("make dev");
	});

	it("REJECTS prose without any comment marker", () => {
		expect(sanitizeDiscoveredCmd("run the dev server which will serve the static tree from the parent directory")).toBeNull();
		expect(sanitizeDiscoveredCmd("NOTE: use make dev for local preview")).toBeNull();
	});

	it("takes the first line of multi-line output; rejects CJK prose outright", () => {
		expect(sanitizeDiscoveredCmd("npm run dev\nsecond line of explanation")).toBe("npm run dev");
		expect(sanitizeDiscoveredCmd("启动本地服务器 说明： 请先安装依赖")).toBeNull();
	});

	it("REJECTS empty/comment-only/absurdly long commands", () => {
		expect(sanitizeDiscoveredCmd("   ")).toBeNull();
		expect(sanitizeDiscoveredCmd("# just a comment")).toBeNull();
		expect(sanitizeDiscoveredCmd(`node ${"a".repeat(250)}.js`)).toBeNull();
	});

	it("accepts ordinary single-line commands untouched", () => {
		expect(sanitizeDiscoveredCmd("npm run dev")).toBe("npm run dev");
		expect(sanitizeDiscoveredCmd("python3 -m http.server $PORT --bind 127.0.0.1")).toBe("python3 -m http.server $PORT --bind 127.0.0.1");
		expect(sanitizeDiscoveredCmd("  caddy file-server --listen :$PORT --root .  ")).toBe("caddy file-server --listen :$PORT --root .");
	});
});

describe("fixedPortFromCmd — self-bound ports", () => {
	it("extracts :PORT, --listen, --port, -p, -l, http.server forms", () => {
		// (Input here is ALREADY sanitized — the pipeline strips comments before
		// this layer, so a port inside a comment is unreachable.)
		expect(fixedPortFromCmd("python3 -m http.server 8321")).toBe(8321);
		expect(fixedPortFromCmd("caddy file-server --listen :8321 --root .")).toBe(8321);
		expect(fixedPortFromCmd("node server.js --port 3000")).toBe(3000);
		expect(fixedPortFromCmd("php -S 127.0.0.1:8080")).toBe(8080);
		expect(fixedPortFromCmd("npx serve -l 5000 .")).toBe(5000);
	});

	it("returns undefined for env-port commands", () => {
		expect(fixedPortFromCmd("npm run dev")).toBeUndefined();
		expect(fixedPortFromCmd("python3 -m http.server $PORT")).toBeUndefined();
		expect(fixedPortFromCmd("caddy file-server --listen :$PORT --root .")).toBeUndefined();
	});
});

describe("detectStaticSite — index.html tree without package.json", () => {
	it("true for an HTML tree, false once package.json exists or no index.html", () => {
		const dir = mkdtempSync(join(tmpdir(), "sd-static-"));
		try {
			expect(detectStaticSite(dir)).toBe(false); // no index.html yet
			writeFileSync(join(dir, "index.html"), "<html></html>");
			expect(detectStaticSite(dir)).toBe(true); // static tree
			writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { dev: "vite" } }));
			expect(detectStaticSite(dir)).toBe(false); // node machinery owns startup
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("static bring-up — run 1's missing strategy", () => {
	it("brings a static HTML tree up on a PORT-honoring server (python3 ladder)", async () => {
		const dir = mkdtempSync(join(tmpdir(), "sd-static-up-"));
		writeFileSync(join(dir, "index.html"), "<html><body>static</body></html>");
		try {
			const logs: string[] = [];
			const ctx = { log: (m: string) => logs.push(m), signal: undefined } as unknown as Parameters<typeof bringupTaskRe.run>[1];
			const state = {
				setup: { worktreePath: dir },
				classify: { uiScope: "full" }, // run 1: ui expected for a static site
			} as unknown as PipelineState;
			const res = (await bringupTaskRe.run(state, ctx)) as { services: { ui?: ServiceHandle }; staticSite: boolean };
			expect(res.staticSite).toBe(true);
			expect(res.services.ui?.ready).toBe(true); // python3 http.server on $PORT
			const body = await fetch(res.services.ui!.baseUrl);
			expect(await body.text()).toContain("static");
			stopService(res.services.ui!);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	}, 30_000);

	it("staticServerCandidates all expand $PORT via the injected env", () => {
		for (const spec of staticServerCandidates("/tmp/x")) {
			expect(spec.cmd).toContain("$PORT");
			expect(spec.portEnv).toBe("PORT");
		}
	});
});
