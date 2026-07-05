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
	/** Absolute URL polled for readiness (overrides readyPath). */
	readyUrl?: string;
	/** Path appended to the base URL for readiness (e.g. "/health"). Defaults to "/". */
	readyPath?: string;
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

/** Parse a .env file (KEY=VALUE per line, # comments, optional quotes) into a
 *  plain object. Missing file → {}. Used so the service inherits the app's own
 *  config/secrets (auth tokens, DB urls, …) exactly as it would locally. */
export function loadDotEnv(cwd: string): Record<string, string> {
	const out: Record<string, string> = {};
	try {
		const raw = readFileSync(join(cwd, ".env"), "utf8");
		for (const line of raw.split(/\r?\n/)) {
			const t = line.trim();
			if (!t || t.startsWith("#")) continue;
			const i = t.indexOf("=");
			if (i < 0) continue;
			const k = t.slice(0, i).trim();
			let v = t.slice(i + 1).trim();
			if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
			if (k) out[k] = v;
		}
	} catch { /* no .env — fine */ }
	return out;
}

/** Start one service per `spec`, injecting the chosen port via `portEnv`, then
 *  readiness-poll it. `.env` from the cwd is loaded into the spawned env (so the
 *  app reads its own config/secrets). `opts.port` lets a caller reuse a fixed
 *  port across a try/fallback ladder. On timeout the handle is returned with
 *  `ready:false` (the pid is still recorded so teardown can clean it up). Never
 *  throws — bringup records not-ready services and `withServiceDeps` skips. */
export async function startService(spec: StartSpec, opts: { port?: number } = {}): Promise<ServiceHandle> {
	const port = opts.port ?? (await pickFreePort());
	const env: Record<string, string> = {
		...(process.env as Record<string, string>),
		...loadDotEnv(spec.cwd),
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
	const readyUrl = spec.readyUrl ?? `${baseUrl}${spec.readyPath ?? "/"}`;
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

/** Normalize a model-discovered service spec (loose object from assessment's
 *  control JSON) into a StartSpec. Returns null if there's no usable cmd. */
function normalizeDiscovered(role: "api" | "ui", raw: unknown, cwd: string): StartSpec | null {
	if (!raw || typeof raw !== "object") return null;
	const r = raw as { cmd?: unknown; portEnv?: unknown; readyPath?: unknown };
	const cmd = typeof r.cmd === "string" ? r.cmd.trim() : "";
	if (!cmd) return null;
	return {
		role,
		cmd,
		cwd,
		portEnv: typeof r.portEnv === "string" ? r.portEnv : "PORT",
		readyPath: typeof r.readyPath === "string" ? r.readyPath : "/",
	};
}

/** Ordered candidate commands to start a role: assessment's discovery first, then
 *  the heuristic detection, then common fallbacks — deduped by cmd. bringup tries
 *  them in order until one readiness-passes. */
function candidatesFor(role: "api" | "ui", override: { api?: unknown; ui?: unknown } | undefined, detected: { api?: StartSpec; ui?: StartSpec }, cwd: string): StartSpec[] {
	const list: StartSpec[] = [];
	const disc = normalizeDiscovered(role, role === "api" ? override?.api : override?.ui, cwd);
	if (disc) list.push(disc);
	const det = role === "api" ? detected.api : detected.ui;
	if (det) list.push(det);
	const fallbacks = role === "api"
		? ["npm start", "node src/server.js", "node server.js", "node src/app.js"]
		: ["npm run dev", "vite", "next dev"];
	for (const cmd of fallbacks) list.push({ role, cmd, cwd, portEnv: "PORT" });
	const seen = new Set<string>();
	return list.filter((s) => {
		if (seen.has(s.cmd)) return false;
		seen.add(s.cmd);
		return true;
	});
}

/** Try each candidate on the SAME port until one readiness-passes; kill the
 *  failures. Returns the ready handle, or null if none came up. */
async function tryStartService(role: "api" | "ui", candidates: StartSpec[], port: number, log: (m: string) => void, perAttemptMs = 12_000): Promise<ServiceHandle | null> {
	for (const spec of candidates) {
		const h = await startService({ ...spec, readinessTimeoutMs: perAttemptMs }, { port });
		if (h.ready) return h;
		stopService(h);
		log(`bringup ${role}: "${spec.cmd}" did not become ready; trying next candidate…`);
	}
	return null;
}

/** Bring up the services needed for testing. For each needed role (api and/or
 *  ui) it picks ONE free port and tries the candidate ladder on it: the
 *  assessment-discovered command first, then the heuristic detection, then common
 *  fallbacks. Records `state.services`. A role that no candidate can start is
 *  omitted → `withServiceDeps` skips its test (no phantom failures). */
export const bringupTask: Stage = {
	id: "bringup",
	label: "Stage 10d — Bring-Up",
	async run(state, ctx) {
		const cwd = state.setup?.worktreePath ?? process.cwd();
		const detected = detectServices(cwd);
		const override = (state.assessment as { services?: { api?: unknown; ui?: unknown } } | undefined)?.services;
		const hasApi = !!normalizeDiscovered("api", override?.api, cwd) || !!detected.api;
		const uiScope = (state.classify as { uiScope?: string } | undefined)?.uiScope;
		const hasUi = (!!uiScope && uiScope !== "none") || !!normalizeDiscovered("ui", override?.ui, cwd) || !!detected.ui;
		const roles: Array<"api" | "ui"> = [hasApi ? "api" : null, hasUi ? "ui" : null].filter((x): x is "api" | "ui" => x !== null);
		const services: ServiceMap = {};
		for (const role of roles) {
			const port = await pickFreePort();
			const candidates = candidatesFor(role, override, detected, cwd);
			const h = await tryStartService(role, candidates, port, (m) => ctx.log(m));
			if (h) services[role] = h;
			else ctx.log(`bringup ${role}: could not start any candidate (tried ${candidates.map((c) => `"${c.cmd}"`).join(", ")})`);
		}
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
