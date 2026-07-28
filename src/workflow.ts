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
import { spawnAgent, isBrowserAgent, needsWebResearch } from "./pi-spawn.ts";
import { runAgentViaSession } from "./session-agent.ts";
import { runHelper } from "./helpers.ts";
import { createMemoizingAgent, loadResumeCache, clearResumeCache, specDirFor, findResumableSpec } from "./resume.ts";
import { extractControlKeys } from "./control.ts";
import { knowledgeForAgent } from "./render/knowledge.ts";
import { getActiveTracker } from "./tracking.ts";
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
 *  SUPER_DEV_TRANSIENT_RETRY_MS before invoking. Default: 2s, 4s, 8s. */
function transientRetryMs(): number[] {
	return (process.env.SUPER_DEV_TRANSIENT_RETRY_MS ?? "2000,4000,8000")
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
		if (!isTransientAgentError(last.error)) return last;
		if (attempt >= delays.length) return last; // exhausted -> surface the transient error
		const delay = delays[attempt];
		log(`agent transient error (429/overload) — retrying in ${delay}ms (attempt ${attempt + 1}/${delays.length}): ${last.error}`);
		await sleepMs(delay, signal);
		if (signal?.aborted) return last;
	}
}

function makeContext(state: PipelineState, task: string, options: RunOptions, log: (m: string) => void): StageContext {
	const budget = makeBudget(options.maxAgents ?? DEFAULT_MAX_AGENTS);
	const maxConcurrency = options.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY;
	const model = options.model;
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
		const fb = (state as Record<string, unknown>).__feedback as Record<string, string[]> | undefined;
		const feedback = fb?.[stageKey];
		const prompt = feedback?.length
			? `${call.prompt}\n\n## Previous attempt rejected — fix these\nThe validator rejected the prior attempt for these specific reasons:\n${feedback.map((e) => `- ${e}`).join("\n")}\nAddress every point and re-produce the complete artifact, then call structured_output.`
			: call.prompt;
		// Option C: inject ONLY the fields this agent needs from prior stages'
		// structured_output (control objects), extracted from .knowledge.json.
		const knowledge = knowledgeForAgent(state.setup?.specDirectory ?? "", call.agent);
		const promptWithKnowledge = knowledge
			? `${prompt}\n\n## Prior-stage data (auto-injected)\n${knowledge}`
			: prompt;
		// Phase 3 (AC-05 / AC-06 / SCENARIO-013..016): drain mid-run user input
		// captured live during execution ONCE per spawn, and when non-empty
		// prepend a `## Mid-run user guidance` block AFTER feedback AND knowledge
		// so it remains the most-visible tail of the prompt. Draining here (inside
		// `realAgent`, NOT the memoizing wrapper at the bottom of makeContext)
		// means a cached/replayed spawn during resume does NOT re-drain — each
		// captured input is injected exactly once. An empty drain is byte-identical
		// to the no-feature baseline.
		const midRun = options.userSteerProvider ? options.userSteerProvider() : [];
		const promptWithGuidance = midRun.length
			? `${promptWithKnowledge}\n\n## Mid-run user guidance (added during execution)\n${midRun.map((t, i) => `(${i + 1}) ${t}`).join("\n")}\n\nIncorporate this into your work.`
			: promptWithKnowledge;
		const common = {
			agent: call.agent,
			prompt: promptWithGuidance,
			cwd: agentCwd,
			controlKeys: call.controlKeys ?? extractControlKeys(call.prompt),
			schema: call.schema,
			model,
			// Phase 1 (Feature 1): thread the inherited DEFAULTS (live main-session
			// model + thinking level) through the shared `common` object so BOTH
			// backends receive them. ADDITIVE — each backend resolves them BELOW an
			// explicit param/env override (see pi-spawn.resolveModel/resolveThinking
			// and session-agent.resolveSessionModel). SCENARIO-001/005/006.
			inheritedModel: options.inheritedModel,
			inheritedThinking: options.inheritedThinking,
			signal,
			id: call.id,
			// Per-call override; when absent each backend falls back to the
			// role-based default (code-writing agents get a larger cap).
			timeoutMs: call.timeoutMs,
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
			// Phase 4 (AC-08): thread the session-backend live-steer seam through to
			// runAgentViaSession. Only consulted by the session backend; the
			// subprocess/browser path ignores it (queue path is the guaranteed contract).
			onSteer: options.onSteer,
		};
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
		const backend = isBrowserAgent(call.agent) || needsWebResearch(call.agent)
			? "subprocess"
			: (options.backend ?? (process.env.SUPER_DEV_BACKEND as "session" | "subprocess" | undefined) ?? "session");
		const exec = backend === "session" ? () => runAgentViaSession(common) : () => spawnAgent(common);
		return runWithTransientRetry(exec, signal, (m) => log(m));
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

	let aborted = false;
	let abortError: string | undefined;
	try {
		await workflow.root.run(state, ctx);
	} catch (err) {
		// A fatal gate (or fatal task) threw to abort the run honestly.
		aborted = true;
		abortError = err instanceof Error ? err.message : String(err);
		progress?.log(`Workflow "${workflow.id}" aborted: ${abortError}`);
	}

	if (!aborted) progress?.log(`Workflow "${workflow.id}" complete`);

	// Derive an honest overall status from the produced state — never faked.
	const impl = state.implementation as { totalPhases?: number; allGreen?: boolean } | undefined;
	const review = state.review as { verdict?: string } | undefined;
	const phases = impl?.totalPhases ?? 0;
	const green = impl?.allGreen === true;
	const verdict = review?.verdict;
	const approved = verdict === "Approved" || verdict === "Approved with Comments";
	const reviewRan = review !== undefined;

	let status: RunStatus;
	if (phases === 0) {
		status = "failed"; // no implementation produced (gate aborted, or spec had no phases)
	} else if (green && (!reviewRan || approved)) {
		status = "success";
	} else {
		status = "partial";
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
