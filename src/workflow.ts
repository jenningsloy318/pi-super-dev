/**
 * The workflow runner. Builds a `StageContext` and evaluates the workflow's
 * root node: `await workflow.root.run(state, ctx)`. All control logic lives in
 * the node algebra (`nodes.ts`); this file only wires execution primitives.
 *
 *   ctx.agent()    — spawn a specialist `pi` subprocess (pi-spawn.ts)
 *   ctx.helper()   — run a deterministic pure helper (helpers.ts)
 *   ctx.parallel() — run agent calls with a concurrency cap
 *   ctx.budget()   — cap total agent spawns
 *   ctx.events     — EventEmitter for waitForEvent (human-in-loop / signals)
 */

import { EventEmitter } from "node:events";
import { AsyncLocalStorage } from "node:async_hooks";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, readFileSync, rmSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { spawnAgent, isBrowserAgent, needsWebResearch } from "./pi-spawn.ts";
import { runAgentViaSession } from "./session-agent.ts";
import { runHelper } from "./helpers.ts";
import { toBool } from "./doc-validators.ts";
import { createMemoizingAgent, loadResumeCache, clearResumeCache, specDirFor, findResumableSpec } from "./resume.ts";
import { extractControlKeys } from "./control.ts";
import { knowledgeForAgent } from "./render/knowledge.ts";
import { appendUserNotes, userNotesForAgent } from "./render/user-notes.ts";
import { getConfig } from "./render/super-dev-dir.ts";
import { getActiveTracker } from "./tracking.ts";
import { WORKFLOW_ATTEMPTS } from "./retry-policy.ts";
import { getRetryFeedback, renderRetryFeedbackBlock } from "./retry-feedback.ts";
import { appendRunEvent, runStartedEvent, type RunEventInput } from "./runlog.ts";
import { SUPER_DEV_EXTENSION_VERSION } from "./version.ts";
import { isNonRetryableAgentError } from "./agent-errors.ts";
import { convergenceRetryFeedback, normalizeConvergenceStage } from "./convergence-ledger.ts";
import type {
	AgentCall,
	AgentResult,
	Budget,
	HelperCall,
	HelperResult,
	PipelineState,
	RunOptions,
	RunStatus,
	RunSummary,
	StageContext,
	StageProgressEvent,
	Workflow,
} from "./types.ts";

const DEFAULT_MAX_AGENTS = 200;
const DEFAULT_MAX_CONCURRENCY = 3;

interface PathFingerprint {
	status: string;
	exists: boolean;
	kind: "file" | "dir" | "other" | "missing";
	hash?: string;
}

interface SourceBoundarySnapshot {
	ok: boolean;
	fingerprints: Map<string, PathFingerprint>;
	allowedRoots: string[];
	error?: string;
}

function normalizeRelPath(path: string): string {
	return path.replace(/\\/g, "/").replace(/^\.\//, "");
}

function isInsidePath(child: string, parent: string): boolean {
	const rel = relative(parent, child);
	return rel === "" || (!!rel && !rel.startsWith("..") && !isAbsolute(rel));
}

function allowedSourceReadOnlyRoots(cwd: string, specDirectory?: string): string[] {
	const roots: string[] = [];
	if (specDirectory) {
		const abs = resolve(specDirectory);
		if (isInsidePath(abs, resolve(cwd))) roots.push(abs);
	}
	return roots;
}

function isAllowedSourceReadOnlyPath(cwd: string, allowedRoots: string[], relPath: string): boolean {
	const abs = resolve(cwd, relPath);
	return allowedRoots.some((root) => abs === root || abs.startsWith(`${root}${sep}`));
}

function gitStatusEntries(cwd: string): { entries: Map<string, string>; error?: string } {
	const r = spawnSync("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], { cwd, encoding: "utf8" });
	if (r.error) return { entries: new Map(), error: r.error.message };
	if (r.status !== 0) return { entries: new Map(), error: (r.stderr || r.stdout || `git status exited ${r.status}`).trim() };
	const entries = new Map<string, string>();
	const parts = r.stdout.split("\0").filter(Boolean);
	for (let i = 0; i < parts.length; i++) {
		const rec = parts[i];
		if (rec.length < 4) continue;
		const status = rec.slice(0, 2);
		const path = normalizeRelPath(rec.slice(3));
		entries.set(path, status);
		if ((status[0] === "R" || status[0] === "C") && i + 1 < parts.length) {
			entries.set(normalizeRelPath(parts[++i]), status);
		}
	}
	return { entries };
}

function fingerprintPath(cwd: string, relPath: string, status: string): PathFingerprint {
	const abs = resolve(cwd, relPath);
	try {
		if (!existsSync(abs)) return { status, exists: false, kind: "missing" };
		const st = lstatSync(abs);
		if (st.isDirectory()) return { status, exists: true, kind: "dir" };
		if (!st.isFile() && !st.isSymbolicLink()) return { status, exists: true, kind: "other" };
		const hash = createHash("sha256").update(readFileSync(abs)).digest("hex");
		return { status, exists: true, kind: "file", hash };
	} catch {
		return { status, exists: existsSync(abs), kind: "other" };
	}
}

function captureSourceBoundary(cwd: string, specDirectory?: string): SourceBoundarySnapshot {
	const allowedRoots = allowedSourceReadOnlyRoots(cwd, specDirectory);
	const { entries, error } = gitStatusEntries(cwd);
	if (error) return { ok: false, fingerprints: new Map(), allowedRoots, error };
	const fingerprints = new Map<string, PathFingerprint>();
	for (const [relPath, status] of entries) {
		if (isAllowedSourceReadOnlyPath(cwd, allowedRoots, relPath)) continue;
		fingerprints.set(relPath, fingerprintPath(cwd, relPath, status));
	}
	return { ok: true, fingerprints, allowedRoots };
}

function sameFingerprint(a: PathFingerprint | undefined, b: PathFingerprint | undefined): boolean {
	return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

function sourceBoundaryViolations(before: SourceBoundarySnapshot, after: SourceBoundarySnapshot): string[] {
	const paths = new Set([...before.fingerprints.keys(), ...after.fingerprints.keys()]);
	return [...paths].filter((path) => !sameFingerprint(before.fingerprints.get(path), after.fingerprints.get(path))).sort();
}

function restoreNewSourceViolations(cwd: string, before: SourceBoundarySnapshot, after: SourceBoundarySnapshot, paths: string[]): { restored: string[]; manual: string[] } {
	const restored: string[] = [];
	const manual: string[] = [];
	for (const relPath of paths) {
		if (before.fingerprints.has(relPath)) {
			manual.push(relPath);
			continue;
		}
		const fp = after.fingerprints.get(relPath);
		if (!fp) continue;
		const abs = resolve(cwd, relPath);
		if (!isInsidePath(abs, resolve(cwd))) {
			manual.push(relPath);
			continue;
		}
		try {
			if (fp.status === "??") {
				rmSync(abs, { recursive: true, force: true });
				restored.push(relPath);
				continue;
			}
			let r = spawnSync("git", ["restore", "--staged", "--worktree", "--", relPath], { cwd, encoding: "utf8" });
			if (r.status !== 0) r = spawnSync("git", ["checkout", "--", relPath], { cwd, encoding: "utf8" });
			if (r.status === 0) restored.push(relPath);
			else manual.push(relPath);
		} catch {
			manual.push(relPath);
		}
	}
	return { restored, manual };
}

function makeBudget(maxAgents: number): Budget {
	const s = { count: 0, max: maxAgents };
	return {
		count: 0,
		check: () => s.count < s.max,
		// BUG-4: atomic reservation. Increments ONLY when under the cap and returns
		// whether it succeeded, so concurrent branches can't both pass a read-only
		// check() and then both spend past the limit. `count` reflects actual
		// reservations (accurate `agentsSpawned` reporting).
		spent(): boolean {
			if (s.count >= s.max) return false;
			s.count++;
			this.count = s.count;
			return true;
		},
	};
}

/** BUG-1: the structural scope stack. `parallel`/`map` push a marker (e.g.
 *  `parallel[0]`) per branch/iteration; the resume memoizer reads the current
 *  path to key agent calls by STRUCTURAL position (order-independent) instead
 *  of a fragile sequential counter. Module-level so one run shares one stack. */
const scopeAls = new AsyncLocalStorage<string[]>();

/** Signal-aware sleep (local — workflow.ts doesn't import nodes' sleep). */
function sleepMs(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		if (signal?.aborted) return resolve();
		const t = setTimeout(resolve, ms);
		signal?.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
	});
}

/** Transient (retryable) agent errors: rate limits, overload, 5xx, connection
 *  resets. Retried with backoff INSIDE one agent call — not counted as a fresh
 *  gate attempt (which burned the budget when a model 429'd on every attempt). */
const TRANSIENT_RE = /\b(429|rate.?limit|overload|too many requests|service unavailable|503|502|520|521|522|524|ECONNRESET|ETIMEDOUT|socket hang up)\b/i;
function isTransientAgentError(error?: string): boolean {
	return !!error && TRANSIENT_RE.test(error);
}

/** Transient-retry backoff schedule (ms). Read LAZILY so tests can set
 *  SUPER_DEV_TRANSIENT_RETRY_MS before invoking. Default: four retries
 *  (5 total tries) at 2s, 4s, 8s, 16s. */
function transientRetryMs(): number[] {
	const defaultDelays = Array.from({ length: Math.max(0, WORKFLOW_ATTEMPTS - 1) }, (_, i) => 2000 * (2 ** i)).join(",");
	return (process.env.SUPER_DEV_TRANSIENT_RETRY_MS ?? defaultDelays)
		.split(",").map((x) => Number.parseInt(x.trim(), 10)).filter((n) => Number.isFinite(n) && n >= 0);
}

/** Run an agent backend call, retrying transient errors with exponential backoff.
 *  One logical agent call = one budget unit (budget.spent is called once by
 *  realAgent; retries are internal). */
async function runWithTransientRetry<T extends { error?: string }>(
	exec: () => Promise<T>, signal: AbortSignal | undefined, log: (m: string) => void,
): Promise<T> {
	const delays = transientRetryMs();
	let last: T;
	for (let attempt = 0; ; attempt++) {
		last = await exec();
		if (isNonRetryableAgentError(last.error)) return last;
		if (!isTransientAgentError(last.error)) return last;
		if (attempt >= delays.length) return last; // exhausted -> surface the transient error
		const delay = delays[attempt];
		log(`agent transient error (429/overload) — retrying in ${delay}ms (attempt ${attempt + 1}/${delays.length}): ${last.error}`);
		await sleepMs(delay, signal);
		if (signal?.aborted) return last;
	}
}

/** Resolve the model for a specific agent call under precedence A (cross-model
 *  policy in config wins over a one-off global --model):
 *    call.model  →  agentModels[call.agent]  →  globalModel  →  undefined.
 *  `undefined` means "no explicit model" — the backends then fall back to the
 *  inherited main-session model, preserving the no-default rule. Pure + exported
 *  for unit tests. */
export function resolveAgentModel(
	call: { agent: string; model?: string },
	agentModels: Record<string, string>,
	globalModel?: string,
): string | undefined {
	const perCall = call.model?.trim();
	if (perCall) return perCall;
	const byRole = agentModels[call.agent]?.trim();
	if (byRole) return byRole;
	return globalModel;
}

function makeContext(state: PipelineState, task: string, options: RunOptions, log: (m: string) => void): StageContext {
	const budget = makeBudget(options.maxAgents ?? DEFAULT_MAX_AGENTS);
	const maxConcurrency = options.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY;
	const model = options.model;
	// Per-agent cross-model policy, read ONCE per run (config is a small JSON file).
	// resolveAgentModel applies precedence A: call.model > config.agentModels[role]
	// > global options.model. Failure to read config degrades to {} (today's behavior).
	const agentModels = (() => { try { return getConfig().agentModels ?? {}; } catch { return {}; } })();
	const signal = options.signal;
	// Single EventEmitter for the whole context: `ctx.phase()` emits on it and
	// runWorkflow subscribes ("phase"/"stage") to route into the progress sink.
	const events = new EventEmitter();

	async function realAgent(call: AgentCall): Promise<AgentResult> {
		// BUG-4: atomic reservation — bail BEFORE doing any work when the cap is hit,
		// so concurrent branches can't exceed maxAgents. (Stage bodies still peek
		// `check()` to avoid constructing a prompt when obviously over budget.)
		if (!budget.spent()) {
			return { text: "", control: null, error: "budget exhausted (maxAgents reached)" };
		}
		const agentCwd = state.setup?.worktreePath ?? options.cwd ?? process.cwd();
		// First-principles retry convergence: if a gate rejected a prior attempt,
		// it stored structured errors under state.__feedback[stageId]. Prepend them
		// to this attempt's prompt so the agent fixes the specific failure instead
		// of resampling the same distribution. The writer's call.id is `pipeline.<id>`.
		const stageKey = (call.id ?? "").replace(/^pipeline\./, "");
		const feedback = getRetryFeedback(state as Record<string, unknown>, stageKey) ?? [];
		const alreadyHasLedger = feedback.some((item) => typeof item === "object" && item !== null && "location" in item && String((item as { location?: unknown }).location ?? "").startsWith("convergence-ledger/"));
		const ledgerFeedback = alreadyHasLedger ? [] : convergenceRetryFeedback(state, { stage: stageKey || call.agent, currentStage: normalizeConvergenceStage(stageKey, "implementation"), gate: "convergence-ledger" });
		const combinedFeedback = [...feedback, ...ledgerFeedback];
		const feedbackBlock = combinedFeedback.length ? renderRetryFeedbackBlock(combinedFeedback) : "";
		const prompt = combinedFeedback.length
			? `${call.prompt}\n\n${feedbackBlock}\nRe-produce the complete artifact, then call structured_output.`
			: call.prompt;
		// Option C: inject ONLY the fields this agent needs from prior stages'
		// structured_output (control objects), extracted from .knowledge.json.
		const knowledge = knowledgeForAgent(state.setup?.specDirectory ?? "", call.agent);
		const promptWithKnowledge = knowledge
			? `${prompt}\n\n## Prior-stage data (auto-injected)\n${knowledge}`
			: prompt;
		// Drain captured mid-run user input ONCE per spawn and PERSIST it to
		// `.user-notes.json` (durable, resume-safe). Then inject the ACCUMULATED
		// notes (incl. the just-appended ones) into THIS agent's prompt — so every
		// subsequent stage sees all user context added so far, not just the next
		// agent. Draining here (inside realAgent, not the memoizing wrapper) means a
		// cached/replayed spawn during resume does NOT re-drain. Non-interrupting:
		// a note typed during agent N is picked up at the N+1 boundary.
		const drained = options.userSteerProvider ? options.userSteerProvider() : [];
		appendUserNotes(state.setup?.specDirectory, drained);
		const userNotes = userNotesForAgent(state.setup?.specDirectory);
		const promptWithNotes = userNotes
			? `${promptWithKnowledge}\n\n## User context (added during the run)\n${userNotes}`
			: promptWithKnowledge;
		const controlKeys = call.controlKeys ?? extractControlKeys(call.prompt);
		const allowEmptyArraysFor = call.allowEmptyArraysFor;
		const timeoutMs = call.timeoutMs;
		const timeoutLabel = timeoutMs !== undefined ? `${timeoutMs}ms` : "role-default";
		const thinkingLabel = call.thinking ?? options.inheritedThinking ?? process.env.SUPER_DEV_THINKING ?? "role-default";
		const accessMode = call.accessMode ?? "write";
		const backend = isBrowserAgent(call.agent) || needsWebResearch(call.agent)
			? "subprocess"
			: (options.backend ?? (process.env.SUPER_DEV_BACKEND as "session" | "subprocess" | undefined) ?? "session");
		const inheritedModel = options.inheritedModelObject
			? `${options.inheritedModelObject.provider}/${options.inheritedModelObject.id}`
			: undefined;
		const promptWithAccess = accessMode === "source-read-only"
			? `${promptWithNotes}\n\n## Source mutation boundary\nThis call is source-read-only. You may inspect files and run diagnostics, but do not edit, write, stage, commit, delete, move, or generate files under the project worktree except temporary files outside the repository (for example under /tmp). The super-dev pipeline renders report artifacts for you.`
			: promptWithNotes;
		const common = {
			agent: call.agent,
			prompt: promptWithAccess,
			cwd: agentCwd,
			accessMode,
			controlKeys,
			// Optional-by-contract keys whose empty-array value counts as present
			// (Fix 1d threading; undefined for every legacy caller).
			allowEmptyArraysFor,
			schema: call.schema,
			// Per-agent model (precedence A). Falls back to the global `model`, then
			// (in the backend) to the inherited main-session model. Enables cross-model
			// review via ~/.super-dev config.agentModels.
			model: resolveAgentModel(call, agentModels, model),
			// Thread the inherited DEFAULTS (live main-session model object +
			// thinking level) through the shared `common` object so BOTH backends
			// receive them. ADDITIVE — each backend applies them BELOW an explicit
			// param/env override (see pi-spawn.resolveModel/resolveThinking and
			// session-agent.runAgentViaSession). SCENARIO-001/005/006.
			inheritedModelObject: options.inheritedModelObject,
			inheritedThinking: options.inheritedThinking,
			signal,
			id: call.id,
			// Per-call override; when absent each backend falls back to the
			// role-based default (code-writing agents get a larger cap).
			timeoutMs,
			// Per-call thinking override. Both backends read the SAME per-call value:
			// the subprocess backend reads `thinking` (buildSpawnArgs → --thinking via
			// resolveThinking); the session backend reads `thinkingLevel`
			// (applyThinkingLevel → session.setThinkingLevel). They are intentionally
			// aliased to the same `call.thinking` so one `common` object feeds both
			// backends; when absent, each backend falls back to SUPER_DEV_THINKING
			// then the role default.
			thinking: call.thinking,
			thinkingLevel: call.thinking,
			onProgress: {
				event: (m: string) => log(m),
				text: (partial: string) => options.progress?.text(partial),
			},
		};
		const sourceBoundaryBefore = accessMode === "source-read-only" ? captureSourceBoundary(agentCwd, state.setup?.specDirectory) : null;
		if (sourceBoundaryBefore && !sourceBoundaryBefore.ok) log(`agent ${call.id ?? call.agent}: source-read-only boundary unavailable (${sourceBoundaryBefore.error}); relying on tool restrictions`);
		function enforceSourceBoundary(): void {
			if (!sourceBoundaryBefore?.ok) return;
			const after = captureSourceBoundary(agentCwd, state.setup?.specDirectory);
			if (!after.ok) {
				log(`agent ${call.id ?? call.agent}: source-read-only boundary post-check unavailable (${after.error})`);
				return;
			}
			const violations = sourceBoundaryViolations(sourceBoundaryBefore, after);
			if (violations.length === 0) return;
			const restored = restoreNewSourceViolations(agentCwd, sourceBoundaryBefore, after, violations);
			const restoredLine = restored.restored.length ? ` restored=${restored.restored.join(", ")}` : "";
			const manualLine = restored.manual.length ? ` manual=${restored.manual.join(", ")}` : "";
			log(`agent ${call.id ?? call.agent}: source-read-only boundary violation paths=${violations.join(", ")}${restoredLine}${manualLine}`);
			throw new Error(`source-read-only boundary violation: modified project files outside the spec artifact directory (${violations.join(", ")})`);
		}
		// Backend selectable. Default is 'session' (in-process createAgentSession):
		// same SDK we peer-depend on, structured output via a schema, no spawn/
		// stdout-buffering/<control>-parse fragility. The earlier failure (requirements
		// gate) was NOT a session-backend defect — it was an incomplete control
		// object caused by a permissive structured_output schema; fixed in
		// session-agent.ts (per-stage schema + corrective re-prompt). 'subprocess'
		// remains available via SUPER_DEV_BACKEND=subprocess.
		// Browser agents (ui-tester, qa-agent) run via the SUBPROCESS backend even when
		// the default is session — only the subprocess path loads pi-browser-cdp-extension
		// (so they get the `browser_execute` tool: CDP with auto-discovery). The session
		// backend's createCodingTools doesn't expose browser tooling.
		// Web-research agents are ALSO forced onto the subprocess backend: they need
		// pi's web tools (pi-web-access), which load via extension discovery in an
		// ISOLATED process, never in the parent's in-process session (the session
		// backend runs noExtensions + createCodingTools only, so it has no web tools).
		const exec = backend === "session" ? () => runAgentViaSession(common) : () => spawnAgent(common);
		const label = call.id ?? call.agent;
		const started = Date.now();
		let boundaryChecked = false;
		log(`agent ${label}: start agent=${call.agent} backend=${backend} access=${accessMode} timeout=${timeoutLabel} thinking=${thinkingLabel} cwd=${agentCwd} model=${common.model ?? inheritedModel ?? "default"} controlKeys=${controlKeys.join(",") || "(none)"} promptChars=${promptWithAccess.length}`);
		try {
			const result = await runWithTransientRetry(exec, signal, (m) => log(m));
			boundaryChecked = true;
			enforceSourceBoundary();
			const elapsed = Date.now() - started;
			log(`agent ${label}: end elapsed=${elapsed}ms control=${result.control ? "yes" : "no"} model=${result.model ?? "unknown"}${result.error ? ` error=${result.error}` : ""}`);
			return result;
		} catch (err) {
			let finalErr = err;
			if (!boundaryChecked) {
				try { enforceSourceBoundary(); }
				catch (boundaryErr) { finalErr = boundaryErr; }
			}
			const elapsed = Date.now() - started;
			const message = finalErr instanceof Error ? finalErr.message : String(finalErr);
			log(`agent ${label}: threw elapsed=${elapsed}ms error=${message}`);
			throw finalErr;
		}
	}
	// Resume (v0.3.0): always CAPTURE agent results so any interrupted run is
	// resumable; MEMOIZE (return cached) when options.resumeCache was pre-loaded.
	// The lazy getSpecDir is because state.setup is populated only after the setup
	// stage runs (the first node).
	const agent = options.resumeCache
		? createMemoizingAgent(realAgent, options.resumeCache, () => state.setup?.specDirectory ?? "", log, () => scopeAls.getStore() ?? [])
		: realAgent;
	async function helper(call: HelperCall): Promise<HelperResult> {
		return runHelper(call);
	}
	async function parallel(calls: Array<() => Promise<AgentResult>>): Promise<AgentResult[]> {
		const results: AgentResult[] = [];
		const queue = [...calls];
		async function worker(): Promise<void> {
			while (queue.length > 0) {
				const next = queue.shift();
				if (!next) return;
				results.push(await next());
			}
		}
		await Promise.all(Array.from({ length: Math.min(maxConcurrency, calls.length) }, worker));
		return results;
	}

	return { task, options, state, agent, helper, parallel, budget, log, phase: (label: string) => events.emit("phase", label), withScope: <T>(marker: string, fn: () => Promise<T>): Promise<T> => { const parent = scopeAls.getStore() ?? []; return scopeAls.run([...parent, marker], fn); }, events, signal, results: [] };
}

/** Run a workflow for a task. */
export async function runWorkflow(workflow: Workflow, task: string, options: RunOptions = {}): Promise<RunSummary> {
	const progress = options.progress;
	const state: PipelineState = {};
	const ctx = makeContext(
		state,
		task,
		options,
		(msg: string) => progress?.log(msg),
	);

	// Surface phase banners + stage logs through the progress sink. We re-bind
	// ctx.log so control nodes' ctx.log(...) reach the caller; phase banners are
	// emitted by the top-level sequence via a wrapping node (see stages/index.ts).
	if (progress) {
		ctx.events.on("phase", (label: unknown) => progress.phase(String(label)));
		ctx.events.on("stage", (info: unknown) => progress.stage?.(info as StageProgressEvent));
	}

	// ChangeTracker stage bracketing (Phase 3a): open a record on stage start and
	// close it on every terminal status, so change-tracker.jsonl always contains a
	// stage-start/stage-end pair for every stage — independent of the progress
	// sink wiring. SCENARIO-008 (no claimed set for stages).
	ctx.events.on("stage", (info: unknown) => {
		const stage = info as StageProgressEvent;
		if (stage.kind === "phase") return; // dashboard-only sub-stage rows; phase tracking is handled explicitly in implementation.ts
		const tracker = getActiveTracker();
		if (tracker && stage?.id) {
			if (stage.status === "running") {
				tracker.begin("stage", stage.id);
			} else {
				// Terminal NodeStatus: ok | skipped | failed | cancelled.
				tracker.end("stage", stage.id);
			}
		}
	});

	// P1.2 (dsh-09 v3 Phase P): the durable run-event ledger. ONE subscription
	// captures every stage transition — including sub-step tasks (codeReview,
	// reviewFix, buildGate…) that never get their own audit.jsonl row. Events
	// buffer in order until state.setup.specDirectory exists (the ledger lives in
	// the spec dir, which setup itself creates): run.started + setup.started flush
	// the moment setup's terminal event arrives. Kind "phase" rows are
	// dashboard-only noise (same rule as the tracker above); "step" rows (TDD RED,
	// RED review…) are real transitions and are recorded with their kind.
	const runId = randomUUID();
	(state as Record<string, unknown>).__runId = runId;
	const pendingLedgerEvents: RunEventInput[] = [runStartedEvent(runId, task, SUPER_DEV_EXTENSION_VERSION)];
	const ledgerEvent = (evt: RunEventInput) => {
		const dir = state.setup?.specDirectory;
		if (!dir) { pendingLedgerEvents.push(evt); return; }
		for (const pending of pendingLedgerEvents.splice(0)) appendRunEvent(dir, pending);
		appendRunEvent(dir, evt);
	};
	ctx.events.on("stage", (info: unknown) => {
		const stage = info as StageProgressEvent;
		if (!stage?.id || stage.kind === "phase") return;
		const base = { runId, stage: stage.id, data: { ...(stage.kind ? { kind: stage.kind } : {}) } } as const;
		if (stage.status === "running") { ledgerEvent({ ...base, type: "stage.started", data: { ...base.data } }); return; }
		if (stage.status === "ok" || stage.status === "partial") { ledgerEvent({ ...base, type: "stage.completed", data: { ...base.data, partial: stage.status === "partial" } }); return; }
		if (stage.status === "skipped") { ledgerEvent({ ...base, type: "stage.skipped", data: { ...base.data } }); return; }
		if (stage.status === "failed") { ledgerEvent({ ...base, type: "stage.failed", data: { ...base.data, error: stage.error } }); return; }
		if (stage.status === "cancelled") { ledgerEvent({ ...base, type: "stage.cancelled", data: { ...base.data } }); return; }
	});

	let aborted = false;
	let abortError: string | undefined;
	try {
		const rootResult = await workflow.root.run(state, ctx);
		if (rootResult.status === "cancelled") {
			aborted = true;
			abortError = "workflow cancelled";
			progress?.log(`Workflow "${workflow.id}" cancelled`);
		}
	} catch (err) {
		// A fatal gate (or fatal task) threw to abort the run honestly.
		aborted = true;
		abortError = err instanceof Error ? err.message : String(err);
		progress?.log(`Workflow "${workflow.id}" aborted: ${abortError}`);
	}

	// Deduped list of stages that ended in `failed` (with their error).
	const seen = new Set<string>();
	const failedStages: { label: string; error?: string }[] = [];
	for (const r of ctx.results) {
		if (r.status === "failed" && !seen.has(r.id)) {
			seen.add(r.id);
			failedStages.push({ label: r.label || r.id, error: r.error });
		}
	}

	// Derive an honest overall status from the produced state — never faked.
	const impl = state.implementation as { totalPhases?: number; phasesCompleted?: number; allGreen?: boolean; convergenceBlocked?: boolean } | undefined;
	const review = state.review as { verdict?: string } | undefined;
	const phases = impl?.totalPhases ?? 0;
	const green = impl?.allGreen === true;
	const verdict = review?.verdict;
	const approved = verdict === "Approved" || verdict === "Approved with Comments";
	const reviewRan = review !== undefined;

	const hardGateFailed =
		((state.buildGate as { pass?: boolean } | undefined)?.pass === false) ||
		((state.preMergeBuild as { pass?: boolean } | undefined)?.pass === false) ||
		((state.integration as { pass?: boolean } | undefined)?.pass === false);
	const mergeRequired =
		state.preMergeBuild !== undefined &&
		(state.preMergeBuild as { pass?: boolean }).pass === true &&
		state.cleanup !== undefined &&
		(state.cleanup as { blocked?: boolean }).blocked !== true;
	// A-2 + boolean-drift (run 2026-08-15T13-45-02): the merge agent emitted
	// `merged: "true"` (string); strict `!== true` misreported PARTIAL on a
	// genuinely merged run. Tolerant read (toBool) mirrors mergeVerifyTask.
	const mergeNotConfirmed = mergeRequired && !toBool((state.merge as { merged?: unknown } | undefined)?.merged);
	// A-3 status honesty: a cleanup-blocked run skipped the merge — that is never
	// a clean success, whatever else passed. Surface as partial with the reason.
	const cleanupBlocked = (state.cleanup as { blocked?: boolean } | undefined)?.blocked === true;

	// R3 (dsh-09 v3): a replan boundary is a deliberate, first-class terminal
	// outcome — routable upstream-owned findings were persisted and the extension
	// will auto-resume; report it as such (never as failed/partial noise).
	const replanMarker = (state as Record<string, unknown>).__replan as { rounds?: number; owners?: string[] } | undefined;

	let status: RunStatus;
	if (replanMarker) {
		status = "replan";
	} else if (aborted || phases === 0) {
		// `phases === 0` means the implementation stage produced no phases (gate
		// aborted before impl, or an empty spec). NOTE (F-8): this couples runStatus
		// to the super-dev implementation-stage shape — a future workflow with no
		// implementation stage would need a distinct "no impl expected" signal here
		// rather than being reported as failed. Fine while super-dev is the only
		// consumer and every run is expected to implement.
		status = "failed";
	} else if (green && reviewRan && approved && !hardGateFailed && !mergeNotConfirmed && !cleanupBlocked && failedStages.length === 0) {
		status = "success";
	} else {
		status = "partial";
	}

	if (!aborted) {
		// Honest completion log DERIVED FROM `status` (R5): a `tolerant` sequence
		// reaches this point even when the run only partially succeeded — not just
		// on a partial implementation, but also on a failed review/build/integration/
		// merge or any failed stage. A bare "complete" reads as success, so surface
		// `partial` explicitly with the reason (run 2026-08-10T10-54-20-663Z shipped
		// "complete" with only 1/3 phases). `success` prints the plain line.
		if (status === "partial") {
			const total = phases;
			const done = impl?.phasesCompleted ?? 0;
			const reason = green
				? cleanupBlocked
					? "cleanup blocked the merge — sensitive file(s) detected in the merge set (see state.cleanup.sensitiveDataFindings)"
					: "review/build/integration/merge or a stage did not fully pass"
				: `implementation finished ${done}/${total} phase(s)${impl?.convergenceBlocked ? " (convergence blocked — no-progress)" : ""}`;
			progress?.log(`Workflow "${workflow.id}" complete — PARTIAL: ${reason}; downstream close-out was gated for unverified work. Inspect the run, or resume to continue.`);
		} else if (status === "replan") {
			progress?.log(`Workflow "${workflow.id}" complete — REPLAN round ${replanMarker?.rounds ?? "?"}: ${replanMarker?.owners?.join(", ") ?? "?"} will revise; auto-resuming`);
		} else {
			progress?.log(`Workflow "${workflow.id}" complete`);
		}
	}

	// P1.2: the run's terminal event — flushes any still-pending buffered events
	// first (a run that never produced a spec dir writes nothing anywhere).
	ledgerEvent({ runId, type: "run.completed", data: { status, reason: abortError, specIdentifier: state.setup?.specIdentifier ?? "" } });

	return {
		workflowId: workflow.id,
		specIdentifier: state.setup?.specIdentifier ?? "",
		worktreePath: state.setup?.worktreePath ?? options.cwd ?? process.cwd(),
		specDirectory: state.setup?.specDirectory ?? "",
		agentsSpawned: ctx.budget.count,
		state,
		status,
		failedStages,
		error: abortError,
	};
}

export { makeContext };
