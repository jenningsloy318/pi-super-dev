/**
 * Deterministic service lifecycle for the verify-loop's test phase.
 *
 *   bringup  → detect start commands, pick free ports, load .env, start the
 *              needed services CONCURRENTLY (api-server + ui-dev-server for a
 *              fullstack app), readiness-poll each, record `state.services`.
 *   teardown → kill every recorded pid (process group), always (tryCatch finally).
 *   withServiceDeps → guard that SKIPS a test step (with a log) if a required
 *              service isn't ready, instead of running against a dead backend.
 *
 * This is deliberately NOT an agent: process lifecycle needs reliable teardown,
 * and starting/polling/killing is mechanical. All of it is unit-testable with a
 * real tiny server — no model calls.
 *
 * Phase 2a ships these primitives + tests; 2b adds the api-tester/ui-tester
 * agents; 2c wires bringup → test → teardown into verifyNode.
 */

import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Node, NodeResult, PipelineState, ServiceHandle, ServiceMap, Stage, StageContext } from "../types.ts";

/** How to start one service. `portEnv` is the env-var name that receives the
 *  chosen free port (e.g. "PORT"); `readyUrl` is polled (defaults to the base). */
export interface StartSpec {
	role: "api" | "ui";
	cmd: string;
	cwd: string;
	env?: Record<string, string>;
	portEnv?: string;
	readyUrl?: string;
	readinessTimeoutMs?: number;
}

/** Pick a free TCP port on 127.0.0.1 by briefly listening on :0. */
export function pickFreePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const srv = createServer();
		srv.unref();
		srv.on("error", reject);
		srv.listen(0, "127.0.0.1", () => {
			const addr = srv.address();
			const port = typeof addr === "object" && addr ? addr.port : 0;
			srv.close(() => resolve(port));
		});
	});
}

/** Poll `url` until it responds 2xx or `timeoutMs` elapses. Returns readiness. */
export async function waitForReady(url: string, timeoutMs = 20_000): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			const res = await fetch(url);
			if (res.ok) return true;
		} catch {
			/* not up yet */
		}
		await new Promise((r) => setTimeout(r, 250));
	}
	return false;
}

/** Start one service per `spec`, injecting the chosen port via `portEnv`, then
 *  readiness-poll it. On timeout the handle is returned with `ready:false`
 *  (the pid is still recorded so teardown can clean it up). Never throws —
 *  bringup records not-ready services and `withServiceDeps` skips their tests. */
export async function startService(spec: StartSpec): Promise<ServiceHandle> {
	const port = await pickFreePort();
	const env: Record<string, string> = {
		...(process.env as Record<string, string>),
		...(spec.env ?? {}),
		...(spec.portEnv ? { [spec.portEnv]: String(port) } : {}),
	};
	const child = spawn(spec.cmd, {
		cwd: spec.cwd,
		env,
		shell: true,
		detached: true, // own process group → teardown kills the whole tree
		stdio: "ignore",
	});
	child.unref();
	const baseUrl = `http://127.0.0.1:${port}`;
	const readyUrl = spec.readyUrl ?? baseUrl;
	const ready = await waitForReady(readyUrl, spec.readinessTimeoutMs ?? 20_000);
	return { role: spec.role, baseUrl, pid: child.pid ?? -1, port, cmd: spec.cmd, external: false, ready };
}

/** Kill a service. Detached spawns get their whole process group signaled
 *  (so a shell-spawned node server dies with its shell). External/reused
 *  services and invalid pids are left alone. Best-effort, never throws. */
export function stopService(h: ServiceHandle): void {
	if (h.external || h.pid < 0) return;
	for (const target of [-h.pid, h.pid]) {
		try {
			process.kill(target, "SIGTERM");
			return;
		} catch {
			/* try the next form */
		}
	}
}

/** Heuristic detection of how to start the api/ui services for a project.
 *  Reads package.json scripts + dependencies. The assessment stage may refine
 *  these (future); this gives a working default for node projects. */
export function detectServices(cwd: string): { api?: StartSpec; ui?: StartSpec } {
	const out: { api?: StartSpec; ui?: StartSpec } = {};
	let pkg: { scripts?: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string> } | null = null;
	try {
		pkg = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8"));
	} catch {
		return out;
	}
	const deps = { ...(pkg?.dependencies ?? {}), ...(pkg?.devDependencies ?? {}) };
	const scripts = pkg?.scripts ?? {};
	const has = (...names: string[]) => names.some((n) => n in deps);
	// API server: explicit server framework, or a `start` script that runs node.
	if (has("express", "fastify", "koa", "hapi", "@nestjs/core", "@nestjs/platform-express") || scripts.start) {
		out.api = { role: "api", cmd: scripts.start ?? "node src/server.js", cwd, portEnv: "PORT" };
	}
	// UI dev server: a frontend dev tool, or a `dev` script that looks like one.
	const devCmd = scripts.dev ?? "";
	if (has("vite", "next", "react-scripts", "webpack", "@vitejs/plugin-react", "@sveltejs/kit") || /\b(vite|next|webpack|react-scripts)\b/.test(devCmd)) {
		out.ui = { role: "ui", cmd: devCmd || "npm run dev", cwd, portEnv: "PORT" };
	}
	return out;
}

/** Bring up the services needed for testing. `roles` selects what to start
 *  (e.g. ["api"] for server-only, ["api","ui"] for fullstack, ["ui"] for a
 *  standalone UI). Detection provides the StartSpecs; an optional `override`
 *  (e.g. from assessment) wins. Records `state.services`. */
export const bringupTask: Stage = {
	id: "bringup",
	label: "Stage 10d — Bring-Up",
	async run(state, ctx) {
		const cwd = state.setup?.worktreePath ?? process.cwd();
		const detected = detectServices(cwd);
		const override = (state.assessment as { services?: { api?: StartSpec; ui?: StartSpec } } | undefined)?.services;
		const api = override?.api ?? detected.api;
		const ui = override?.ui ?? detected.ui;
		const services: ServiceMap = {};
		const roles = ((state.classify as { uiScope?: string } | undefined)?.uiScope && ui) ? ["api", "ui"] : (api ? ["api"] : ui ? ["ui"] : []);
		// Start the needed services concurrently.
		const handles = await Promise.all(roles.map((r) => startService((r === "api" ? api : ui)!)));
		for (const h of handles) services[h.role] = h;
		(state as PipelineState).services = services;
		const summary = Object.entries(services).map(([r, h]) => `${r}@${h.baseUrl}:${h.ready ? "ready" : "not-ready"}`).join(", ") || "no services";
		ctx.log(`bringup: ${summary}`);
		return { services, summary };
	},
};

/** Tear down every service recorded in `state.services`. Meant to run in a
 *  `tryCatch` `finally` so it always fires — even if a test step throws. */
export function teardownNode(): Node {
	return {
		kind: "teardown",
		async run(state, ctx) {
			const services = (state.services ?? {}) as ServiceMap;
			for (const h of Object.values(services)) {
				if (h) {
					stopService(h);
					ctx.log(`teardown: killed ${h.role}@${h.baseUrl} (pid ${h.pid})`);
				}
			}
			return { status: "ok" as NodeResult["status"] };
		},
	};
}

/** Wrap a test step so it only runs when all `deps` services are ready in
 *  `state.services`. Missing/not-ready → SKIP with a log (a dead backend is
 *  "can't test", not a test failure) so the fix loop doesn't chase phantoms. */
export function withServiceDeps(deps: string[], node: Node): Node {
	return {
		kind: "withServiceDeps",
		async run(state, ctx) {
			if (ctx.signal?.aborted) return { status: "cancelled" };
			const services = ((state as PipelineState).services ?? {}) as ServiceMap;
			const missing = deps.filter((d) => {
				const h = services[d as keyof ServiceMap];
				return !h || !h.ready;
			});
			if (missing.length > 0) {
				ctx.log(`verify: skip test — service(s) not ready: ${missing.join(", ")}`);
				return { status: "skipped" };
			}
			return node.run(state, ctx);
		},
	};
}
