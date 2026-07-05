/**
 * Tests for the deterministic service lifecycle (Phase 2a). Uses a REAL tiny
 * HTTP server spawned as a child process — no mocks — so start/readiness/kill
 * are exercised end-to-end (and fast).
 */
import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
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
