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
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Node, NodeResult, PipelineState, ServiceHandle, ServiceMap, Stage, StageContext } from "../types.ts";
import { checkBashCommand } from "../safety.ts";
import { SIGTERM_GRACE_MS } from "../pi-spawn.ts";

/** How to start one service. `portEnv` is the env-var name that receives the
 *  chosen free port (e.g. "PORT"); `readyUrl` is polled (defaults to the base). */
export interface StartSpec {
	role: "api" | "ui";
	cmd: string;
	cwd: string;
	env?: Record<string, string>;
	portEnv?: string;
	/** FIXED port the command binds by itself (a Caddyfile's `:8321`,
	 *  `http.server 8321`, `--listen :8321`, …). When set, readiness polls THIS
	 *  port — the shared random `PORT` injection can never satisfy a fixed-port
	 *  server, so without this the candidate is unstartable BY CONSTRUCTION
	 *  (run 2026-08-27T12-33-43-088Z burned 10h green work into PARTIAL on it). */
	port?: number;
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

/** Poll `url` until it responds 2xx or `timeoutMs` elapses. Returns readiness.
 *  AC-24 (SCENARIO-051): abortable — the signal is checked at the TOP of every
 *  loop iteration and threaded into `fetch`, so an aborted poll breaks within
 *  ≤ one 250 ms sleep (never waits out the full timeout). */
export async function waitForReady(url: string, timeoutMs = 20_000, signal?: AbortSignal): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (signal?.aborted) return false;
		try {
			const res = await fetch(url, { signal });
			if (res.ok) return true;
		} catch {
			// AbortError (or any failure after an abort) — stop immediately; a
			// genuine connection refusal falls through to the bounded sleep.
			if (signal?.aborted) return false;
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
export async function startService(spec: StartSpec, opts: { port?: number; signal?: AbortSignal } = {}): Promise<ServiceHandle> {
	// Explicit caller port > the spec's own fixed port > a fresh random one.
	const port = opts.port ?? spec.port ?? (await pickFreePort());
	// The service command is MODEL-DISCOVERED (assessment output) and runs via
	// shell:true with the full env + .env — it never passes through the agent bash
	// safety hook. Screen it with the SAME denylist before spawning: a dangerous
	// bringup command (rm -rf, curl|sh, env exfiltration, …) is refused, returning
	// a not-ready handle so withServiceDeps skips it instead of executing it.
	const safety = checkBashCommand(spec.cmd);
	if (safety.blocked) {
		return { role: spec.role, baseUrl: `http://127.0.0.1:${port}`, pid: -1, port, cmd: spec.cmd, external: false, ready: false };
	}
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
	// Fast-fail a candidate whose process EXITS before readiness (run
	// 2026-08-27T12-33-43-088Z: "npm run dev"/"vite"/"next dev" on a static tree
	// die instantly, yet each burned its FULL 12s poll window before the ladder
	// moved on). Race the readiness poll against child exit — first to settle
	// wins; a long-lived server never fires exit, so readiness is unchanged.
	const exited = new Promise<false>((resolveExit) => {
		child.once("exit", () => resolveExit(false));
		child.once("error", () => resolveExit(false));
	});
	const ready = await Promise.race([
		waitForReady(readyUrl, spec.readinessTimeoutMs ?? 20_000, opts.signal),
		exited,
	]);
	return { role: spec.role, baseUrl, pid: child.pid ?? -1, port, cmd: spec.cmd, external: false, ready };
}

/** Kill a service. Detached spawns get their whole process group signaled
 *  (so a shell-spawned node server dies with its shell). External/reused
 *  services and invalid pids are left alone. Best-effort, never throws.
 *  AC-24 (SCENARIO-050): a service that TRAPPED SIGTERM (registered listener,
 *  never exits) is group-SIGKILLed after the SIGTERM grace — SIGKILL cannot be
 *  caught, so the port is always released. */
export function stopService(h: ServiceHandle): void {
	if (h.external || h.pid < 0) return;
	let signaled = false;
	for (const target of [-h.pid, h.pid]) {
		try {
			process.kill(target, "SIGTERM");
			signaled = true;
			break;
		} catch {
			/* try the next form */
		}
	}
	if (!signaled) return;
	const pid = h.pid;
	// Bounded escalation watchdog (unref'd so it never holds the event loop).
	const watchdog = setTimeout(() => {
		try {
			process.kill(-pid, 0); // group still alive → escalate
		} catch {
			return; // already gone — nothing to do
		}
		for (const target of [-pid, pid]) {
			try {
				process.kill(target, "SIGKILL");
			return;
			} catch {
				/* try the next form */
			}
		}
	}, SIGTERM_GRACE_MS);
	watchdog.unref?.();
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

/** True when the project is a STATIC site: a servable HTML tree with NO node
 *  dev-server machinery (no package.json — Caddyfile/Makefile/plain-HTML
 *  projects). Run 2026-08-27T12-33-43-088Z: such a project failed every
 *  npm/vite/next fallback and its 10h of green deterministic work was reported
 *  PARTIAL solely because bringup could not express "static site, no dev
 *  server". */
export function detectStaticSite(cwd: string): boolean {
	try {
		if (!existsSync(join(cwd, "index.html"))) return false;
	} catch {
		return false;
	}
	try {
		JSON.parse(readFileSync(join(cwd, "package.json"), "utf8"));
		return false; // a package.json owns api/ui startup — not static-only
	} catch {
		return true;
	}
}

/** PORT-honoring static servers for a static tree (run 1's missing strategy).
 *  `$PORT` is expanded by the shell from the injected env var, so readiness on
 *  the CHOSEN random port can pass — unlike the fixed-port Caddyfile original
 *  the assessment discovered. Ladder order: python3 (ubiquitous), caddy,
 *  npx serve. */
export function staticServerCandidates(cwd: string, role: "api" | "ui" = "ui"): StartSpec[] {
	return [
		{ role, cmd: "python3 -m http.server $PORT --bind 127.0.0.1", cwd, portEnv: "PORT" },
		{ role, cmd: "caddy file-server --listen :$PORT --root .", cwd, portEnv: "PORT" },
		{ role, cmd: "npx --yes serve -l $PORT .", cwd, portEnv: "PORT" },
	];
}

/** Prose markers that never appear in a real single shell command but DID
 *  appear in run 2026-08-27T12-33-43-088Z: the assessment agent returned `cmd`
 *  as a whole explanatory paragraph ("make dev # = caddy run --config Caddyfile
 *  … NOTE: Caddyfile root points at the PARENT dir …"). */
const DISCOVERED_PROSE_MARKERS = /\bNOTE\b|N\.B\.|note that|说明：|注意：|——|…|\bthis command\b|\bwhich will\b|\bthe above\b/i;

/** Sanitize a model-discovered service command into a single executable shell
 *  line, or null when the "command" is prose. One line, shell comments
 *  stripped, bounded length/token count, no prose markers, no CJK text, first
 *  token must look like an executable. */
export function sanitizeDiscoveredCmd(raw: string): string | null {
	// A real command is one line; multi-line output is prose.
	const first = raw.split(/\r?\n/, 1)[0];
	// Strip a trailing shell comment: '#' at token start through end of line.
	const stripped = first.replace(/(^|\s)#.*$/, "").trim();
	if (!stripped) return null;
	if (stripped.length > 200) return null;
	if (DISCOVERED_PROSE_MARKERS.test(stripped)) return null;
	const tokens = stripped.split(/\s+/);
	if (tokens.length > 16) return null;
	// First token must look like an executable path/binary (no quotes-with-
	// spaces, no CJK, no sentence punctuation).
	if (!/^[\w@./~"'-]+$/.test(tokens[0]!)) return null;
	if (/[\u4e00-\u9fff]/.test(stripped)) return null;
	return stripped;
}

/** Extract a port the command binds BY ITSELF: `:8321`, `--listen :8321`,
 *  `--port 8321`, `-p 8321`, `serve -l 8321`, `http.server 8321`. Returns
 *  undefined when the command takes its port from an env var (`$PORT`) — the
 *  PORT-injected ladder already handles that shape. */
export function fixedPortFromCmd(cmd: string): number | undefined {
	const m = cmd.match(/(?:--listen\s+:?|--port[= ]\s*|-p\s+|-l\s+|http\.server\s+|:)(\d{2,5})\b/);
	if (!m) return undefined;
	const n = Number(m[1]);
	return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : undefined;
}

/** Normalize a model-discovered service spec (loose object from assessment's
 *  control JSON) into a StartSpec. Returns null if there's no usable cmd —
 * the raw `cmd` is SANITIZED first (run 2026-08-27T12-33-43-088Z shipped a
 * prose paragraph as candidate #1) and a self-declared fixed port is honored. */
function normalizeDiscovered(role: "api" | "ui", raw: unknown, cwd: string): StartSpec | null {
	if (!raw || typeof raw !== "object") return null;
	const r = raw as { cmd?: unknown; portEnv?: unknown; readyPath?: unknown; port?: unknown };
	if (typeof r.cmd !== "string") return null;
	const cmd = sanitizeDiscoveredCmd(r.cmd);
	if (!cmd) return null;
	const declared = typeof r.port === "number" && Number.isInteger(r.port) && r.port >= 1 && r.port <= 65535 ? r.port : undefined;
	const port = declared ?? fixedPortFromCmd(cmd);
	return {
		role,
		cmd,
		cwd,
		portEnv: typeof r.portEnv === "string" ? r.portEnv : "PORT",
		...(port ? { port } : {}),
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
	// Static tree (run 2026-08-27T12-33-43-088Z): every node fallback fails
	// instantly (nothing installed) — append PORT-honoring static servers so a
	// plain HTML project CAN bring its ui role up for integration testing.
	if (role === "ui" && detectStaticSite(cwd)) list.push(...staticServerCandidates(cwd, role));
	const seen = new Set<string>();
	return list.filter((s) => {
		if (seen.has(s.cmd)) return false;
		seen.add(s.cmd);
		return true;
	});
}

/** Try each candidate on the SAME port until one readiness-passes; kill the
 *  failures. Returns the ready handle, or null if none came up.
 *  AC-24 (SCENARIO-051): the run's AbortSignal is threaded into every
 *  readiness poll AND checked BETWEEN candidates — an aborted run returns null
 *  without spawning the next candidate. */
async function tryStartService(role: "api" | "ui", candidates: StartSpec[], port: number, log: (m: string) => void, perAttemptMs = 12_000, signal?: AbortSignal): Promise<ServiceHandle | null> {
	for (const spec of candidates) {
		if (signal?.aborted) return null; // never start the next candidate
		const h = await startService({ ...spec, readinessTimeoutMs: perAttemptMs }, { port, signal });
		if (h.ready) return h;
		stopService(h);
		if (signal?.aborted) return null;
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
		const staticSite = detectStaticSite(cwd);
		const override = (state.assessment as { services?: { api?: unknown; ui?: unknown } } | undefined)?.services;
		const hasApi = !!normalizeDiscovered("api", override?.api, cwd) || !!detected.api;
		const uiScope = (state.classify as { uiScope?: string } | undefined)?.uiScope;
		const hasUi = (!!uiScope && uiScope !== "none") || !!normalizeDiscovered("ui", override?.ui, cwd) || !!detected.ui;
		const roles: Array<"api" | "ui"> = [hasApi ? "api" : null, hasUi ? "ui" : null].filter((x): x is "api" | "ui" => x !== null);
		(state as PipelineState).integrationExpectedTests = [...roles];
		const services: ServiceMap = {};
		for (const role of roles) {
			const port = await pickFreePort();
			const candidates = candidatesFor(role, override, detected, cwd);
			const h = await tryStartService(role, candidates, port, (m) => ctx.log(m), 12_000, ctx.signal);
			if (h) services[role] = h;
			else ctx.log(`bringup ${role}: could not start any candidate (tried ${candidates.map((c) => `"${c.cmd}"`).join(", ")})`);
		}
		(state as PipelineState).services = services;
		const summary = Object.entries(services).map(([r, h]) => `${r}@${h.baseUrl}:${h.ready ? "ready" : "not-ready"}`).join(", ") || "no services";
		ctx.log(`bringup: ${summary}`);
		// `staticSite` rides the task() result into `state.bringup` so verify can
		// treat an unstartable integration server on a static tree as NON-blocking
		// (skipped-static) instead of a hard-gate PARTIAL over green work.
		return { services, summary, staticSite };
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
				const reason = `service(s) not ready: ${missing.join(", ")}`;
				ctx.log(`verify: skip test — ${reason}`);
				for (const dep of missing) {
					if (dep === "api") (state as PipelineState).apiTest = { pass: false, skipped: true, failures: [{ reason }], summary: reason };
					if (dep === "ui") (state as PipelineState).uiTest = { pass: false, skipped: true, failures: [{ reason }], summary: reason };
				}
				return { status: "skipped" };
			}
			return node.run(state, ctx);
		},
	};
}
