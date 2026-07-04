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
import { spawnAgent } from "./pi-spawn.ts";
import { runAgentViaSession } from "./session-agent.ts";
import { runHelper } from "./helpers.ts";
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
	Workflow,
} from "./types.ts";

const DEFAULT_MAX_AGENTS = 200;
const DEFAULT_MAX_CONCURRENCY = 3;

function makeBudget(maxAgents: number): Budget {
	const s = { count: 0, max: maxAgents };
	return {
		count: 0,
		check: () => s.count < s.max,
		spent() {
			s.count++;
			this.count = s.count;
		},
	};
}

function makeContext(state: PipelineState, task: string, options: RunOptions, log: (m: string) => void): StageContext {
	const budget = makeBudget(options.maxAgents ?? DEFAULT_MAX_AGENTS);
	const maxConcurrency = options.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY;
	const model = options.model;
	const signal = options.signal;

	async function agent(call: AgentCall): Promise<AgentResult> {
		budget.spent();
		const agentCwd = state.setup?.worktreePath ?? options.cwd ?? process.cwd();
		const common = {
			agent: call.agent,
			prompt: call.prompt,
			cwd: agentCwd,
			model,
			signal,
			id: call.id,
			onProgress: {
				event: (m: string) => log(m),
				text: (partial: string) => options.progress?.text(partial),
			},
		};
		// Backend selectable: "session" = in-process createAgentSession (default for
		// the prototype once verified), "subprocess" = raw pi spawn (the original).
		const backend = options.backend ?? (process.env.SUPER_DEV_BACKEND as "session" | "subprocess" | undefined) ?? "subprocess";
		return backend === "session" ? runAgentViaSession(common) : spawnAgent(common);
	}
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

	return { task, options, state, agent, helper, parallel, budget, log, events: new EventEmitter(), signal, results: [] };
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
	}

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
