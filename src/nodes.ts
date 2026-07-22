/**
 * The control-flow node algebra.
 *
 * A pipeline is a tree of self-evaluating `Node`s. Leaf `task` nodes wrap a
 * `Stage` (a unit of work). Control nodes compose nodes and implement their
 * own `run(state, ctx)` by recursively evaluating children. The runner
 * (`workflow.ts`) is just `await root.run(state, ctx)` — adding a new control
 * construct means writing one builder here, never touching the runner.
 *
 * Node set (lineage in parens):
 *   task        (ASL Task)              leaf; runs a stage, stores result
 *   sequence    (WCP1)                  run in order; fail-fast or tolerant
 *   branch      (WCP4 Exclusive Choice) binary conditional
 *   choose      (WCP4)                  multi-way conditional
 *   parallel    (WCP2+WCP3 Split+Sync)  concurrent branches + optional join
 *   loop        (WCP10 Arbitrary Cycles) while/until/times iteration
 *   retry       (ASL Retry)             repeat-on-error with backoff
 *   gate        (domain quality gates)  validate output, re-run until valid
 *   map         (WCP12-14 Multi-Instance) fan-out over a collection
 *   wait        (ASL Wait)              delay
 *   waitForEvent (WCP16 Deferred Choice) external signal sync (human-in-loop)
 *   tryCatch    (ASL Catch)             error boundary
 *   noop        (ASL Pass)              no-op
 *
 * Every node returns a truthful `NodeResult`. `status`:
 *   ok         succeeded
 *   skipped    intentionally not run (predicate/budget/disabled)
 *   failed     ran but did not succeed (caught error / gate not satisfied)
 *   cancelled  aborted via signal
 */

import type {
	Node,
	NodeResult,
	NodeStatus,
	PipelineState,
	Stage,
	StageContext,
	ControlObj,
} from "./types.ts";
import { specDocExists } from "./doc-validators.ts";
import { STAGE_MODELS } from "./render/schemas.ts";
import { renderAndWrite } from "./render/render.ts";
import { auditAppend } from "./render/super-dev-dir.ts";

// ─── Shared helper types ────────────────────────────────────────────────────

type Predicate = (state: PipelineState, ctx: StageContext) => boolean | Promise<boolean>;
/** A gate validator returns structured errors, not just pass/fail — the gate feeds
 *  those errors into the next retry's prompt so retries CONVERGE instead of
 *  blind-resampling the same distribution (the root cause of "gate failed after
 *  3 attempts" on a probabilistic agent). */
type Validator = (state: PipelineState, ctx: StageContext) => Promise<{ pass: boolean; errors: string[] }> | { pass: boolean; errors: string[] };

/** Run async functions with a concurrency cap, preserving order. */
async function runConcurrent<T>(fns: Array<() => Promise<T>>, concurrency = Infinity, signal?: AbortSignal): Promise<T[]> {
	const results = [] as T[];
	const queue = fns.map((fn, i) => [i, fn] as const);
	async function worker(): Promise<void> {
		while (queue.length > 0) {
			if (signal?.aborted) return; // #6 sibling-cancellation: don't start remaining branches
			const entry = queue.shift();
			if (!entry) return;
			const [i, fn] = entry;
			results[i] = await fn();
		}
	}
	const n = Math.min(concurrency, fns.length);
	if (n <= 0) return results;
	await Promise.all(Array.from({ length: n }, () => worker()));
	return results;
}

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
	new Promise((resolve) => {
		if (signal?.aborted) return resolve();
		const t = setTimeout(resolve, ms);
		signal?.addEventListener(
			"abort",
			() => {
				clearTimeout(t);
				resolve();
			},
			{ once: true },
		);
	});

const OK: NodeResult = { status: "ok" };
const NOOP_RESULT: NodeResult = { status: "ok" };
const failed = (error: string): NodeResult => ({ status: "failed", error });
const cancelled = (): NodeResult => ({ status: "cancelled" });

// ─── task ───────────────────────────────────────────────────────────────────

/** Lift a `Stage` into a leaf node. Stores the return value under `state[id]`. */
export function task(stage: Stage): Node {
	const record = (ctx: StageContext, status: NodeStatus, error?: string) => {
		ctx.results.push({ id: stage.id, label: stage.label, status, error });
		ctx.events.emit("stage", { id: stage.id, label: stage.label, status, error });
	};
	return {
		kind: "task",
		label: stage.label,
		async run(state, ctx) {
			if (ctx.signal?.aborted) return { status: "cancelled" };
			if (stage.enabled && !stage.enabled(state)) {
				ctx.log(`task "${stage.id}": skipped (disabled)`);
				record(ctx, "skipped");
				return { status: "skipped" };
			}
			if (!ctx.budget.check()) {
				ctx.log(`task "${stage.id}": skipped (budget exhausted)`);
				record(ctx, "skipped");
				return { status: "skipped" };
			}
			// Precondition: verify upstream artifact docs exist before running. Logs
			// ✓/✗ per required glob so inter-stage dependencies are visible. Missing
			// artifacts are NOT fatal — the tolerant pipeline proceeds (the prompt
			// shows "N/A" for absent upstream) and the gap is logged.
			const specDir = state.setup?.specDirectory ?? "";
			if (stage.requires?.length && specDir) {
				for (const glob of stage.requires) {
					ctx.log(`precondition ${stage.id}: ${specDocExists(specDir, glob) ? "✓" : "✗ missing"} ${glob}`);
				}
			}
			try {
				ctx.events.emit("phase", stage.label);
			ctx.events.emit("stage", { id: stage.id, label: stage.label, status: "running" });
				const startMs = Date.now();
				const result = await stage.run(state, ctx);
				const durationMs = Date.now() - startMs;
				if (result !== undefined && result !== null) state[stage.id] = result;
				record(ctx, "ok");
				auditAppend({ stage: stage.id, durationMs, control: result });
				return { status: "ok", value: result };
			} catch (err) {
				const error = err instanceof Error ? err.message : String(err);
				record(ctx, "failed", error);
				auditAppend({ stage: stage.id, error });
				if (stage.fatal) throw err;
				return { status: "failed", error };
			}
		},
	};
}

// ─── sequence ───────────────────────────────────────────────────────────────

export interface SequenceOptions {
	tolerant?: boolean;
}

/** Run nodes in order. Fail-fast by default; `tolerant` logs+continues past failures. */
export function sequence(children: Node[], opts: SequenceOptions = {}): Node {
	return {
		kind: "sequence",
		async run(state, ctx) {
			for (const child of children) {
				if (ctx.signal?.aborted) return { status: "cancelled" };
				let r: NodeResult;
				try {
					r = await child.run(state, ctx);
				} catch (err) {
					// A thrown exception must NOT bypass a tolerant sequence and abort the
					// whole run (the original bug: gate({fatal:true}) threw through
					// `tolerant` and discarded every prior stage's artifacts). Tolerant
					// means tolerant — convert throws to failed and continue.
					const error = err instanceof Error ? err.message : String(err);
					if (!opts.tolerant) throw err;
					ctx.log(`sequence: stage threw — ${error} (tolerant: continuing)`);
					r = { status: "failed", error };
				}
				if (r.status === "cancelled") return r;
				if (r.status === "failed" && !opts.tolerant) return r;
			}
			return OK;
		},
	};
}

// ─── branch / choose ────────────────────────────────────────────────────────

/** Binary conditional (WCP4 Exclusive Choice). */
export function branch(predicate: Predicate, branches: { yes: Node; no?: Node }): Node {
	return {
		kind: "branch",
		async run(state, ctx) {
			if (ctx.signal?.aborted) return { status: "cancelled" };
			const cond = await predicate(state, ctx);
			const chosen = cond ? branches.yes : branches.no;
			if (!chosen) return { status: "skipped" };
			return chosen.run(state, ctx);
		},
	};
}

export interface ChooseCase {
	when: Predicate;
	run: Node;
}

/** Multi-way conditional. First matching case wins; else `otherwise` or skipped. */
export function choose(cases: ChooseCase[], otherwise?: Node): Node {
	return {
		kind: "choose",
		async run(state, ctx) {
			if (ctx.signal?.aborted) return { status: "cancelled" };
			for (const c of cases) {
				if (await c.when(state, ctx)) return c.run.run(state, ctx);
			}
			return otherwise ? otherwise.run(state, ctx) : { status: "skipped" };
		},
	};
}

// ─── parallel ───────────────────────────────────────────────────────────────

export interface ParallelOptions {
	into?: string;
	join?: (results: NodeResult[], state: PipelineState, ctx: StageContext) => Promise<unknown> | unknown;
	concurrency?: number;
	tolerant?: boolean;
}

/**
 * Run branches concurrently (WCP2 parallel split). Branches share `state`;
 * they MUST write distinct keys to avoid clobbering. Optional `join` reduces
 * branch results and stores the value under `into`.
 */
export function parallel(branches: Node[], opts: ParallelOptions = {}): Node {
	return {
		kind: "parallel",
		async run(state, ctx) {
			if (ctx.signal?.aborted) return { status: "cancelled" };
			// #6 sibling-cancellation: when one branch returns cancelled, abort a sub-signal
			// so remaining QUEUED branches are not started (in-flight branches run to completion
			// — aborting an async fn without its own signal check is not possible).
			const subAbort = new AbortController();
			const results = await runConcurrent(
				branches.map((b) => async () => {
					const r = await b.run(state, ctx);
					if (r.status === "cancelled") subAbort.abort(); // #6: signal siblings to stop
					return r;
				}),
				opts.concurrency ?? ctx.options.maxConcurrency ?? Infinity,
				subAbort.signal, // #6: workers check this before dequeuing
			);
			if (results.some((r) => r.status === "cancelled")) return { status: "cancelled" };
			if (!opts.tolerant && results.some((r) => r.status === "failed")) {
				const first = results.find((r) => r.status === "failed");
				return { status: "failed", error: first?.error };
			}
			if (opts.join) {
				const joined = await opts.join(results, state, ctx);
				if (opts.into) state[opts.into] = joined;
				return { status: "ok", value: joined };
			}
			return { status: "ok", value: results };
		},
	};
}

// ─── loop ───────────────────────────────────────────────────────────────────

export interface LoopOptions {
	while?: Predicate;
	until?: Predicate;
	times?: number;
}

/** Arbitrary-cycle iteration (WCP10). `while`/`until` checked before each body run. */
export function loop(opts: LoopOptions, body: Node): Node {
	return {
		kind: "loop",
		async run(state, ctx) {
			const max = opts.times ?? Infinity;
			let last: NodeResult = OK;
			for (let attempt = 1; attempt <= max; attempt++) {
				if (ctx.signal?.aborted) return { status: "cancelled" };
				if (opts.while && !(await opts.while(state, ctx))) break;
				if (opts.until && (await opts.until(state, ctx))) break;
				last = await body.run(state, ctx);
				if (last.status === "cancelled") return last;
				if (last.status === "failed") return last;
			}
			return { ...last, attempts: max === Infinity ? undefined : max };
		},
	};
}

// ─── retry ──────────────────────────────────────────────────────────────────

export interface RetryOptions {
	attempts: number;
	backoff?: number | ((attempt: number) => number);
	matches?: (result: NodeResult, state: PipelineState, ctx: StageContext) => boolean | Promise<boolean>;
}

/** Repeat a node on failure (ASL Retry / Temporal RetryPolicy). */
export function retry(opts: RetryOptions, node: Node): Node {
	return {
		kind: "retry",
		async run(state, ctx) {
			let last: NodeResult = { status: "failed", error: "never ran" };
			for (let attempt = 1; attempt <= opts.attempts; attempt++) {
				if (ctx.signal?.aborted) return { status: "cancelled" };
				last = await node.run(state, ctx);
				if (last.status === "cancelled") return last;
				if (last.status === "ok" || last.status === "skipped") return { ...last, attempts: attempt };
				// failed:
				if (opts.matches && !(await opts.matches(last, state, ctx))) return { ...last, attempts: attempt };
				if (attempt < opts.attempts) {
					const delay = typeof opts.backoff === "function" ? opts.backoff(attempt) : opts.backoff;
					if (delay) await sleep(delay, ctx.signal);
				}
			}
			return { ...last, attempts: opts.attempts };
		},
	};
}

// ─── gate ───────────────────────────────────────────────────────────────────

export interface GateOptions {
	validate: Validator;
	attempts?: number;
	/** Remediation node run between failed validations (defaults to re-running `node`). */
	fix?: Node;
	/** Stage id; the gate stores the validator's errors under state.__feedback[feedbackKey]
	 *  so the next retry's agent prompt includes them (see workflow.ts agent()). */
	feedbackKey?: string;
}

/**
 * Run `node`, validate its output, and repeat (running `fix`, or `node` again)
 * until validation passes or attempts are exhausted.
 *
 * First-principles behavior for a pipeline over PROBABILISTIC agents:
 *  - Retries CONVERGE: the validator returns structured errors, which are fed
 *    into the next attempt's prompt (via state.__feedback + workflow.ts), so the
 *    agent fixes the specific failure instead of blind-resampling.
 *  - Exhaustion NEVER throws/aborts. A thrown gate would bypass `tolerant`
 *    sequences and discard every prior stage's artifacts. Exhaustion logs and
 *    returns failed; the tolerant pipeline proceeds with the best-available
 *    artifact. (Only the setup stage is truly fatal — it's not a gate.)
 */
export function gate(opts: GateOptions, node: Node): Node {
	return {
		kind: "gate",
		async run(state, ctx) {
			const max = opts.attempts ?? 3;
			const label = opts.feedbackKey ? ` gate ${opts.feedbackKey}` : "";
			let lastErrors: string[] = [];
			let last: NodeResult = OK;
			for (let attempt = 1; attempt <= max; attempt++) {
				if (ctx.signal?.aborted) return { status: "cancelled" };
				const target = attempt === 1 ? node : (opts.fix ?? node);
				last = await target.run(state, ctx);
				if (last.status === "cancelled") return last;
				if (last.status === "failed") {
					if (attempt < max) continue;
					break; // exhausted → non-fatal return below
				}
				const v = await opts.validate(state, ctx);
				if (v.pass) {
					auditAppend({ stage: opts.feedbackKey ?? "gate", attempt, gate: { pass: true, errors: [] } });
					ctx.log(`gate${label}: ✓ validated (attempt ${attempt}${attempt > 1 ? ", after feedback" : ""})`);
					return { status: "ok", attempts: attempt };
				}
				lastErrors = v.errors;
				auditAppend({ stage: opts.feedbackKey ?? "gate", attempt, gate: { pass: false, errors: v.errors } });
				ctx.log(`gate${label}: ✗ FAIL attempt ${attempt}/${max}${v.errors.length ? ` — ${v.errors.join("; ")}` : ""}`);
				// Feed the errors forward so the next attempt's agent prompt names them.
				if (opts.feedbackKey) {
					const all = (state as Record<string, unknown>).__feedback as Record<string, string[]> | undefined;
					(state as Record<string, unknown>).__feedback = { ...(all ?? {}), [opts.feedbackKey]: v.errors };
				}
			}
			const msg = `gate${label} could not pass after ${max} attempt(s)${lastErrors.length ? `: ${lastErrors.join("; ")}` : ""}`;
			ctx.log(`gate: EXHAUSTED (non-fatal) — proceeding with best-available artifact`);
			return { status: "failed", error: msg, attempts: max };
		},
	};
}

// ─── map ────────────────────────────────────────────────────────────────────

export interface MapOptions {
	over: (state: PipelineState, ctx: StageContext) => unknown[] | Promise<unknown[]>;
	as: string;
	into?: string;
	join?: (results: NodeResult[], state: PipelineContextState, ctx: StageContext) => Promise<unknown> | unknown;
	concurrency?: number;
}

// (alias to avoid a circular type reference in JSDoc only)
type PipelineContextState = PipelineState;

/** Fan-out over a collection (WCP12-14 Multiple Instances). NOTE: concurrent
 *  iterations share `state`; use distinct keys or `concurrency: 1` for safety. */
export function map(opts: MapOptions, body: Node): Node {
	return {
		kind: "map",
		async run(state, ctx) {
			if (ctx.signal?.aborted) return { status: "cancelled" };
			const items = await opts.over(state, ctx);
			const results = await runConcurrent(
				items.map((item) => async () => {
					(state as Record<string, unknown>)[opts.as] = item;
					return body.run(state, ctx);
				}),
				opts.concurrency ?? 1,
			);
			if (results.some((r) => r.status === "cancelled")) return { status: "cancelled" };
			if (opts.join) {
				const joined = await opts.join(results, state, ctx);
				if (opts.into) state[opts.into] = joined;
				return { status: "ok", value: joined };
			}
			return { status: "ok", value: results };
		},
	};
}

// ─── wait / waitForEvent ────────────────────────────────────────────────────

/** Delay (ASL Wait). Signal-aware. */
export function wait(ms: number): Node {
	return {
		kind: "wait",
		async run(_state, ctx) {
			if (ctx.signal?.aborted) return { status: "cancelled" };
			await sleep(ms, ctx.signal);
			return ctx.signal?.aborted ? { status: "cancelled" } : OK;
		},
	};
}

export interface WaitForEventOptions {
	timeout?: number;
}

/** Block until an event is emitted on `ctx.events` (WCP16 Deferred Choice). */
export function waitForEvent(name: string, opts: WaitForEventOptions = {}): Node {
	return {
		kind: "waitForEvent",
		async run(_state, ctx) {
			if (ctx.signal?.aborted) return { status: "cancelled" };
			return new Promise<NodeResult>((resolve) => {
				let done = false;
				const finish = (r: NodeResult) => {
					if (done) return;
					done = true;
					ctx.events.removeListener(name, onEvent);
					clearTimeout(timer);
					resolve(r);
				};
				const onEvent = () => finish(OK);
				ctx.events.once(name, onEvent);
				const timer = opts.timeout
					? setTimeout(() => finish(failed(`timeout waiting for event "${name}"`)), opts.timeout)
					: undefined;
				ctx.signal?.addEventListener("abort", () => finish(cancelled()), { once: true });
			});
		},
	};
}

// ─── tryCatch ───────────────────────────────────────────────────────────────

export interface TryCatchOptions {
	catch?: Node;
	finally?: Node;
}

/** Error boundary (ASL Catch). Catches thrown errors (e.g. fatal tasks). */
export function tryCatch(body: Node, opts: TryCatchOptions = {}): Node {
	return {
		kind: "tryCatch",
		async run(state, ctx) {
			try {
				const r = await body.run(state, ctx);
				if (opts.finally) await opts.finally.run(state, ctx);
				return r;
			} catch (err) {
				const error = err instanceof Error ? err.message : String(err);
				(state as Record<string, unknown>).__lastError = error;
				ctx.log(`tryCatch: caught error — ${error}`);
				const r = opts.catch ? await opts.catch.run(state, ctx) : failed(error);
				if (opts.finally) await opts.finally.run(state, ctx);
				return r;
			}
		},
	};
}

/** No-op node (ASL Pass). */
export function noop(): Node {
	return { kind: "noop", async run() { return NOOP_RESULT; } };
}

// ─── Convenience stage builders ─────────────────────────────────────────────

/** A task that spawns one specialist agent and returns its parsed control. */
export function writerTask(spec: {
	id: string;
	label: string;
	agent: string;
	buildPrompt: (state: PipelineState, ctx: StageContext) => string;
	fatal?: boolean;
	/** Upstream artifact docs this writer needs (globs); checked by task() before run. */
	requires?: string[];
}): Stage {
	return {
		id: spec.id,
		label: spec.label,
		fatal: spec.fatal,
		requires: spec.requires,
		async run(state, ctx) {
			if (!ctx.budget.check()) return undefined;
			const model = STAGE_MODELS[spec.id];
			const result = await ctx.agent({
				id: `pipeline.${spec.id}`,
				agent: spec.agent,
				prompt: spec.buildPrompt(state, ctx),
				schema: model?.schema,
			});
			if (result.error) ctx.log(`${spec.id}: agent error — ${result.error}`);
			if (!result.control) {
				const said = result.text ? ` (last text: ${result.text.replace(/\s+/g, " ")})` : "";
				ctx.log(`${spec.id}: agent produced no control object${said}`);
			}
			// Render pipeline: if this stage has a render model, render + write the doc.
			if (result.control) {
				renderAndWrite(state.setup!, (m) => ctx.log(m), spec.id, result.control as Record<string, unknown>);
			}
			return result.control ?? {};
		},
	};
}

/** A task that runs a deterministic helper and returns its value. */
export function helperTask(spec: {
	id: string;
	label: string;
	helper: string;
	sources: (state: PipelineState, ctx: StageContext) => Record<string, unknown>;
	options?: (state: PipelineState, ctx: StageContext) => Record<string, unknown>;
	context?: (state: PipelineState, ctx: StageContext) => Record<string, unknown>;
}): Stage {
	return {
		id: spec.id,
		label: spec.label,
		async run(state, ctx) {
			const result = await ctx.helper({
				name: spec.helper,
				sources: spec.sources(state, ctx),
				options: spec.options?.(state, ctx),
				context: spec.context?.(state, ctx),
			});
			return result.value as ControlObj;
		},
	};
}

/** A validator backed by a gate helper. */
export function gateValidator(helperName: string, sourceKey: string, stateKey: string): Validator {
	return async (state, ctx) => {
		const result = await ctx.helper({
			name: helperName,
			// Include setup so content gates can read docs from the spec directory
			// (the control object's docPath may be missing/misreported by the agent).
			sources: { [sourceKey]: (state as Record<string, unknown>)[stateKey] ?? {}, setup: state.setup },
		});
		const value = result.value as { pass?: boolean; errors?: string[] };
		return { pass: Boolean(value.pass), errors: value.errors ?? [] };
	};
}
