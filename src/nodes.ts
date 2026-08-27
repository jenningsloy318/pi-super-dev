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
	StageProgressEvent,
	ControlObj,
} from "./types.ts";
import { specDocExists } from "./doc-validators.ts";
import { STAGE_MODELS } from "./render/schemas.ts";
import { renderAndWrite } from "./render/render.ts";
import { auditAppend } from "./render/super-dev-dir.ts";
import { WORKFLOW_ATTEMPTS } from "./retry-policy.ts";
import { clearRetryFeedback, setRetryFeedback } from "./retry-feedback.ts";
import { isNonRetryableAgentError, nonRetryableAgentSummary } from "./agent-errors.ts";
import { markConvergenceFindingsVerified, recordConvergenceFindings, normalizeConvergenceStage } from "./convergence-ledger.ts";

// ─── Shared helper types ────────────────────────────────────────────────────

type Predicate = (state: PipelineState, ctx: StageContext) => boolean | Promise<boolean>;
/** A gate validator returns structured errors, not just pass/fail — the gate feeds
 *  those errors into the next retry's prompt so retries CONVERGE instead of
 *  blind-resampling the same distribution (the root cause of "gate failed after
 *  5 attempts" on a probabilistic agent). */
type Validator = (state: PipelineState, ctx: StageContext) => Promise<{ pass: boolean; errors: string[] }> | { pass: boolean; errors: string[] };

/** Run async functions with a concurrency cap, preserving order. */
async function runConcurrent<T>(fns: Array<() => Promise<T>>, concurrency = Infinity, signal?: AbortSignal): Promise<T[]> {
	const results = [] as T[];
	const queue = fns.map((fn, i) => [i, fn] as const);
	// F-1: when one branch THROWS (e.g. FatalAbort), Promise.all rejects but the
	// other in-flight workers would keep pulling from the queue and running —
	// spawning agents, burning budget, writing shared state AFTER the caller has
	// already aborted. This flag makes siblings stop starting new work the moment
	// any branch throws, mirroring the existing signal?.aborted short-circuit.
	let threw = false;
	async function worker(): Promise<void> {
		while (queue.length > 0) {
			if (signal?.aborted || threw) return; // #6 sibling-cancellation + F-1 sibling-throw
			const entry = queue.shift();
			if (!entry) return;
			const [i, fn] = entry;
			try {
				results[i] = await fn();
			} catch (err) {
				threw = true; // stop siblings from starting new work
				throw err;    // propagate to Promise.all (preserves original error)
			}
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
		const onAbort = () => { clearTimeout(t); finish(); };
		// A-05 (NFR-6): remove the once-listener on NORMAL resolution too — the
		// ONE shared run AbortSignal otherwise accumulates a retained closure per
		// sleep across a retry-heavy run (MaxListenersExceededWarning noise).
		// ({ once: true } only cleans up when the signal actually FIRES.)
		const finish = () => { signal?.removeEventListener("abort", onAbort); resolve(); };
		const t = setTimeout(finish, ms);
		signal?.addEventListener("abort", onAbort, { once: true });
	});

const OK: NodeResult = { status: "ok" };
const failed = (error: string): NodeResult => ({ status: "failed", error });
const cancelled = (): NodeResult => ({ status: "cancelled" });

// ─── Fatal abort (foundational-gate exhaustion) ─────────────────────────────

/** Thrown by a `gate({ fatal: true })` on EXHAUSTION. A tolerant `sequence`
 *  RE-THROWS this (it does not swallow it), so a foundational stage that cannot
 *  produce its artifact aborts the run honestly instead of feeding garbage to
 *  every downstream stage — the "failed but still go on" cascading-failure gap.
 *  `runWorkflow` catches it like any throw → status "failed" + the real reason;
 *  resume replays cached calls. */
export class FatalAbort extends Error {
	constructor(message: string) {
		super(message);
		this.name = "FatalAbort";
	}
}

/** True for a `FatalAbort` (or any error marked fatal). Used by `sequence` to
 *  decide whether a tolerant pipeline must re-throw despite {tolerant:true}. */
export function isFatalAbort(err: unknown): boolean {
	return err instanceof FatalAbort || (err instanceof Error && (err as { fatal?: boolean }).fatal === true);
}

/** Run `fn` inside a structural scope marker (BUG-1). `parallel`/`map` call this
 *  per branch/iteration so concurrent branches get distinct, order-independent
 *  scope paths for resume cache keys. Falls back to running `fn` directly when
 *  the context doesn't provide `withScope` (e.g. minimal unit-test contexts). */
function scopeRun<T>(ctx: StageContext, marker: string, fn: () => Promise<T>): Promise<T> {
	return ctx.withScope ? ctx.withScope(marker, fn) : fn();
}

function normalizeSkipStage(value: string): string {
	return value.trim().toLowerCase().replace(/^stage\s+/, "");
}

function stageNumbers(label: string): string[] {
	const match = /^Stage\s+(\d+(?:\.\d+)?)/i.exec(label.trim());
	return match ? [match[1]] : [];
}

function shouldSkipStage(stage: Stage, ctx: StageContext): boolean {
	// Stage 1/setup is never skippable because it creates the worktree/spec dirs.
	if (stage.id === "setup") return false;
	const requested = new Set((ctx.options.skipStages ?? []).map((s) => normalizeSkipStage(String(s))));
	if (requested.size === 0) return false;
	const candidates = [stage.id, stage.label, ...stageNumbers(stage.label)].map(normalizeSkipStage);
	return candidates.some((candidate) => requested.has(candidate));
}

// ─── task ───────────────────────────────────────────────────────────────────

/** Lift a `Stage` into a leaf node. Stores the return value under `state[id]`. */
export function task(stage: Stage): Node {
	const record = (ctx: StageContext, status: NodeStatus, error?: string, eventStatus: StageProgressEvent["status"] = status) => {
		ctx.results.push({ id: stage.id, label: stage.label, status, error });
		ctx.events.emit("stage", { id: stage.id, label: stage.label, status: eventStatus, error });
	};
	const displayStatus = (result: unknown): StageProgressEvent["status"] => {
		if (stage.id === "implementation" && result != null && typeof result === "object" && (result as { allGreen?: unknown }).allGreen === false) {
			return "partial";
		}
		return "ok";
	};
	return {
		kind: "task",
		label: stage.label,
		id: stage.id,
		async run(state, ctx) {
			if (ctx.signal?.aborted) return { status: "cancelled" };
			// Sweep-3 G20 (A-adv CORE-4): the skip/budget paths previously emitted
			// a TERMINAL stage event with no prior stage.started — failing the
			// exported INV-L6 checker on every --skipStages / budget-death run.
			// record()'s "running" first opens the lifecycle, the terminal closes
			// it; both events carry the skip/budget reason.
			if (shouldSkipStage(stage, ctx)) {
				ctx.log(`task "${stage.id}": skipped (--skipStages)`);
				ctx.events.emit("stage", { id: stage.id, label: stage.label, status: "running" }); // G20: open the lifecycle
				record(ctx, "skipped");
				return { status: "skipped" };
			}
			if (stage.enabled && !stage.enabled(state)) {
				ctx.log(`task "${stage.id}": skipped (disabled)`);
				ctx.events.emit("stage", { id: stage.id, label: stage.label, status: "running" }); // G20: open the lifecycle
				record(ctx, "skipped");
				return { status: "skipped" };
			}
			if (!ctx.budget.check()) {
				const error = `task "${stage.id}": budget exhausted before stage start`;
				ctx.log(error);
				ctx.events.emit("stage", { id: stage.id, label: stage.label, status: "running" }); // G20: open the lifecycle
				record(ctx, "failed", error);
				return { status: "failed", error };
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
			let startMs = Date.now();
			try {
				ctx.events.emit("phase", stage.label);
				ctx.events.emit("stage", { id: stage.id, label: stage.label, status: "running" });
				startMs = Date.now();
				const result = await stage.run(state, ctx);
				const durationMs = Date.now() - startMs;
				// Cancellation honesty (run 2026-08-27T13-12-39-803Z): a stage that
				// RETURNS after the run signal aborted must never record ok —
				// classifyStage caught an aborted agent and returned the deterministic
				// fallback, so a cancelled run logged "status=ok" with a perfectly
				// healthy-looking fabricated control. Record cancelled, DISCARD the
				// returned value (never written to state — a resume re-runs the stage
				// honestly), and let the sequence propagate the cancellation.
				if (ctx.signal?.aborted) {
					record(ctx, "cancelled");
					auditAppend({ stage: stage.id, durationMs, error: "aborted by parent signal" });
					return { status: "cancelled" };
				}
				if (result !== undefined && result !== null) state[stage.id] = result;
				// Sweep-3 round-2 CR-R2-3/CRR2-2: a stage that recorded an INFRA
				// failed row mid-run (writerTask's G21 honest marker) must not have
				// it masked by this same-id ok row — G3's last-status semantics
				// would read silently green. Emit the ok EVENT (dashboard shows the
				// round completing) but keep the ROW failed when one exists.
				const infraFailed = ctx.results.some((r) => r.id === stage.id && r.status === "failed");
				if (!infraFailed) {
					record(ctx, "ok", undefined, displayStatus(result));
				} else {
					ctx.events.emit("stage", { id: stage.id, label: stage.label, status: displayStatus(result) });
				}
				auditAppend({ stage: stage.id, durationMs, control: result });
				return { status: "ok", value: result };
			} catch (err) {
				// FatalAbort (a nested fatal gate's exhaustion) must ALWAYS propagate —
				// never be converted to {status:"failed"}, which a tolerant sequence
				// would swallow.
				if (isFatalAbort(err)) throw err;
				// Cancellation honesty (run 2026-08-27T13-12-39-803Z): an agent aborted
				// by the run's signal surfaces as a thrown error — that is a CANCELLED
				// stage, not a failed one.
				if (ctx.signal?.aborted) {
					const durationMs = Date.now() - startMs;
					record(ctx, "cancelled");
					auditAppend({ stage: stage.id, durationMs, error: "aborted by parent signal" });
					return { status: "cancelled" };
				}
				const error = err instanceof Error ? err.message : String(err);
				const durationMs = Date.now() - startMs;
				record(ctx, "failed", error);
				auditAppend({ stage: stage.id, durationMs, error });
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
					if (!opts.tolerant || isFatalAbort(err)) throw err;
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
			// Duplicate-id guard: two concurrent task nodes with the same stage.id
			// would silently clobber state[id] (last-write-wins, nondeterministic).
			const ids = branches.map((b) => b.id).filter((x): x is string => !!x);
			if (new Set(ids).size !== ids.length) {
				const dup = ids.find((x, i) => ids.indexOf(x) !== i);
				throw new Error(`parallel(): duplicate stage id "${dup}" — concurrent tasks sharing a state key would clobber each other. Use distinct ids.`);
			}
			// #6 sibling-cancellation: when one branch returns cancelled, abort a sub-signal
			// so remaining QUEUED branches are not started (in-flight branches run to completion
			// — aborting an async fn without its own signal check is not possible).
			const subAbort = new AbortController();
			const results = await runConcurrent(
				branches.map((b, i) => async () => {
					const r = await scopeRun(ctx, `parallel[${i}]`, () => b.run(state, ctx));
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
	/** When true, a `failed` body result does NOT exit the loop — the loop keeps
	 *  iterating (bounded by while/until/times) and returns the LAST result. Mirrors
	 *  `sequence`'s tolerant option (F-2). Default false: `failed` fail-fasts, as
	 *  before. `cancelled` always exits regardless. */
	tolerant?: boolean;
}

/** Arbitrary-cycle iteration (WCP10). `while`/`until` checked before each body run. */
export function loop(opts: LoopOptions, body: Node): Node {
	return {
		kind: "loop",
		async run(state, ctx) {
			const max = opts.times ?? Infinity;
			let last: NodeResult = OK;
			let ran = 0; // F-5: report the ACTUAL iteration count, not `times`
			for (let attempt = 1; attempt <= max; attempt++) {
				if (ctx.signal?.aborted) return { status: "cancelled" };
				if (opts.while && !(await opts.while(state, ctx))) break;
				if (opts.until && (await opts.until(state, ctx))) break;
				last = await body.run(state, ctx);
				ran++;
				if (last.status === "cancelled") return last;
				if (last.status === "failed" && !opts.tolerant) return last;
			}
			return { ...last, attempts: ran || undefined };
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
	/** When true, EXHAUSTION throws a `FatalAbort` instead of returning `{status:"failed"}`.
	 *  A fatal abort propagates PAST tolerant sequences (they re-throw it), so a
	 *  foundational stage that cannot produce its artifact aborts the run
	 *  honestly instead of feeding garbage to every downstream stage (the
	 *  "failed but still go on" cascading-failure gap). Use for load-bearing doc
	 *  stages (requirements/bdd/research/spec). Non-fatal exhaustion (default)
	 *  returns failed so a tolerant pipeline can limp on with best-effort. */
	fatal?: boolean;
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
			const max = opts.attempts ?? WORKFLOW_ATTEMPTS;
			const label = opts.feedbackKey ? ` gate ${opts.feedbackKey}` : "";
			let lastErrors: string[] = [];
			let last: NodeResult = OK;
			let escalationRetry = false;
			let msg = "";
			do {
				escalationRetry = false;
				for (let attempt = 1; attempt <= max; attempt++) {
					if (ctx.signal?.aborted) return { status: "cancelled" };
					const target = attempt === 1 ? node : (opts.fix ?? node);
					ctx.log(`gate${label}: attempt ${attempt}/${max} starting`);
					auditAppend({ stage: opts.feedbackKey ?? "gate", attempt, gate: null });
					last = await target.run(state, ctx);
					if (last.status === "cancelled") return last;
					if (last.status === "failed") {
						if (isNonRetryableAgentError(last.error)) {
							lastErrors = [nonRetryableAgentSummary(last.error)];
							recordConvergenceFindings(state, {
								detectedAtStage: opts.feedbackKey ?? "gate",
								ownerStage: "environment",
								severity: "fatal",
								blocking: true,
								title: "Agent environment cannot start",
								detail: lastErrors[0],
								evidence: [last.error ?? "unknown"],
								recommendation: "Fix the local agent runtime/PATH before rerunning; another LLM retry cannot repair this process-spawn failure.",
								sourceGate: "stage-failure",
							}, { detectedAtStage: opts.feedbackKey ?? "gate", ownerStage: "environment", sourceGate: "stage-failure" });
							msg = `gate${label} stopped on ${lastErrors[0]}`;
							ctx.log(`gate${label}: non-retryable stage failure — ${lastErrors[0]}`);
							if (opts.feedbackKey) setRetryFeedback(state as Record<string, unknown>, opts.feedbackKey, lastErrors);
							if (opts.fatal) throw new FatalAbort(msg);
							return { status: "failed", error: msg, attempts: attempt };
						}
						if (attempt < max) {
							ctx.log(`gate${label}: attempt ${attempt}/${max} stage failed — ${last.error ?? "unknown error"}; retrying`);
							continue;
						}
						break; // exhausted → non-fatal return below
					}
					const v = await opts.validate(state, ctx);
					if (v.pass) {
						// BUG-6: clear the feedback entry on success so stale failure errors
						// don't persist + get re-prepended if this gate (or a sibling sharing
						// the key) is ever re-run (loop/converge). No-op when none was set.
						if (opts.feedbackKey) {
							clearRetryFeedback(state as Record<string, unknown>, opts.feedbackKey);
							const owner = normalizeConvergenceStage(opts.feedbackKey, "implementation");
							markConvergenceFindingsVerified(state, (finding) => finding.ownerStage === owner && finding.detectedAtStage === opts.feedbackKey);
						}
						auditAppend({ stage: opts.feedbackKey ?? "gate", attempt, gate: { pass: true, errors: [] } });
						ctx.log(`gate${label}: ✓ validated (attempt ${attempt}${attempt > 1 ? ", after feedback" : ""})`);
						return { status: "ok", attempts: attempt };
					}
					lastErrors = v.errors;
					if (opts.feedbackKey && v.errors.length) {
						recordConvergenceFindings(state, v.errors.map((error) => ({
							detectedAtStage: opts.feedbackKey,
							ownerStage: normalizeConvergenceStage(opts.feedbackKey, "implementation"),
							severity: "high",
							blocking: true,
							title: error,
							detail: error,
							evidence: [error],
							sourceGate: "validator",
						})), { detectedAtStage: opts.feedbackKey, ownerStage: normalizeConvergenceStage(opts.feedbackKey, "implementation"), sourceGate: "validator" });
					}
					auditAppend({ stage: opts.feedbackKey ?? "gate", attempt, gate: { pass: false, errors: v.errors } });
					ctx.log(`gate${label}: ✗ FAIL attempt ${attempt}/${max}${v.errors.length ? ` — ${v.errors.join("; ")}` : ""}`);
					// Feed the errors forward so the next attempt's agent prompt names them.
					if (opts.feedbackKey) {
						setRetryFeedback(state as Record<string, unknown>, opts.feedbackKey, v.errors);
					}
					if (attempt < max) ctx.log(`gate${label}: retrying with validator feedback`);
				}
			msg = `gate${label} could not pass after ${max} attempt(s)${lastErrors.length ? `: ${lastErrors.join("; ")}` : ""}`;
			ctx.log(`gate: EXHAUSTED${opts.fatal ? " (FATAL — aborting run)" : " (non-fatal)"} — ${opts.fatal ? "aborting" : "proceeding with best-available artifact"}`);
			if (msg) ctx.log(`  blocker (${opts.feedbackKey ?? "gate"}): ${msg}`);
			if (opts.fatal) {
				// spec-18 HITL: before aborting, give the user a chance to decide
				// (pause-then-continue via ctx.ui.select). Only fires when an escalate
				// callback is threaded + budget remains; never throws.
				const escalate = (ctx as { options?: { escalate?: import("./types.ts").Escalate } }).options?.escalate;
				if (escalate) {
					try {
						const { runEscalation, applyRetryDecision } = await import("./escalation.ts");
						const setup = (state as { setup?: { worktreePath?: string; specDirectory?: string } }).setup;
						const failure: import("./types.ts").EscalationFailure = { kind: "gate-exhaustion", stage: opts.feedbackKey ?? "gate", message: msg, severity: "hard", worktreePath: setup?.worktreePath, specDirectory: setup?.specDirectory };
						const decision = await runEscalation(state, failure, escalate);
						if (decision) {
							applyRetryDecision(state, decision, { worktreePath: setup?.worktreePath, specDirectory: setup?.specDirectory });
							if (decision.choice === "accept-limitation") {
							// SD-05 (NFR-6): a human-accepted limitation on a FATAL gate is
							// never a silent gate pass — record the marker so the run-status
							// derivation can only yield `partial`, never `success` (the
							// foundational artifact still never validated; the acceptance is
							// visible in state and the run summary, not just the report).
							const accepted = (state as Record<string, unknown>).__acceptedLimitations as Record<string, unknown> | undefined;
							(state as Record<string, unknown>).__acceptedLimitations = {
								...(accepted ?? {}),
								[opts.feedbackKey ?? "gate"]: { stage: opts.feedbackKey ?? "gate", message: msg },
							};
							ctx.log(`gate${label}: fatal blocker accepted as a limitation — the run will report partial (${msg})`);
							return { status: "ok" as const, attempts: max };
						}
							if (decision.choice === "retry-with-guidance") { escalationRetry = true; continue; }
						}
					} catch (err) {
						// G2 (routing M1 review): a RouteBackSignal escaping the decision
						// handling must NOT be swallowed by this never-throw guard — it is
						// a FatalAbort subclass the M2+ walker catches above root.run.
						// Name-based check avoids a nodes→router import cycle.
						if (err instanceof Error && err.name === "RouteBackSignal") throw err;
						/* never-throw: degrade to FatalAbort */
					}
				}
				throw new FatalAbort(msg);
			}
				break; // non-fatal exhaustion — exit do-while
			} while (escalationRetry);
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
			// BUG-5: the API exposes the current item ONLY via the shared key
			// state[as], so concurrency > 1 races and silently corrupts. Fail loud
			// instead of producing wrong results. (A safe concurrent map needs a
			// future per-item-arg body signature; today map is single-threaded.)
			if ((opts.concurrency ?? 1) > 1) {
				throw new Error("map() concurrency > 1 is unsafe: the current item is passed via shared state[as] and concurrent iterations would race. Use concurrency: 1 (the default).");
			}
			const items = await opts.over(state, ctx);
			const results = await runConcurrent(
				items.map((item, i) => async () => {
					(state as Record<string, unknown>)[opts.as] = item;
					return scopeRun(ctx, `map[${i}]`, () => body.run(state, ctx));
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

// ─── wait ────────────────────────────────────────────────────────────────

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
				// FatalAbort must propagate (run finally first for the teardown guarantee).
				if (isFatalAbort(err)) {
					// The finally node must NOT be able to lose the FatalAbort: if it throws,
					// swallow its error so the original abort still propagates (F-7).
					if (opts.finally) {
						try { await opts.finally.run(state, ctx); } catch { /* teardown error must not mask the abort */ }
					}
					throw err;
				}
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
	return { kind: "noop", async run() { return OK; } };
}

// ─── Convenience stage builders ─────────────────────────────────────────────

/** A task that spawns one specialist agent and returns its parsed control. */
export function writerTask(spec: {
	id: string;
	label: string;
	agent: string;
	accessMode?: import("./types.ts").AgentAccessMode;
	buildPrompt: (state: PipelineState, ctx: StageContext) => string;
	fatal?: boolean;
	/** Upstream artifact docs this writer needs (globs); checked by task() before run. */
	requires?: string[];
	/** OPTIONAL control normalizer applied BEFORE render (code-review R2): repair
	 *  coercible control malformations (e.g. spec.phases as a string/wrapper map)
	 *  so the render schema validates and the docs REGENERATE — otherwise the
	 *  gate can pass a coercible control while the on-disk docs silently go
	 *  stale (renderAndWrite returns null on schema failure and the old doc
	 *  keeps passing the gates). */
	normalizeControl?: (control: Record<string, unknown>) => Record<string, unknown>;
}): Stage {
	return {
		id: spec.id,
		label: spec.label,
		fatal: spec.fatal,
		requires: spec.requires,
		async run(state, ctx) {
			if (!ctx.budget.check()) {
				// A-04 (NFR-6): returning undefined here let task() record status
				// "ok" with NO artifact (a parallel sibling spent the last slot
				// between task()'s check and this body-level re-check — the stage
				// appeared green in results/dashboard/audit while producing
				// nothing). Fail loud: the honest-reporting contract requires a
				// failed stage row, never a silent ok.
				throw new Error(`${spec.id}: budget exhausted before writer agent call (maxAgents reached)`);
			}
			const model = STAGE_MODELS[spec.id];
			// Stick a stream log at stage START naming which AGENT is working. The
			// exact doc filename it will write is logged by renderAndWrite (`doc → …`,
			// stable across retries — overwritten in place, never a new index).
			ctx.log(`${spec.id}: agent ${spec.agent} working`);
			const result = await ctx.agent({
				id: `pipeline.${spec.id}`,
				agent: spec.agent,
				accessMode: spec.accessMode,
				prompt: spec.buildPrompt(state, ctx),
				schema: model?.schema,
			});
			if (result.error) ctx.log(`${spec.id}: agent error — ${result.error}`);
			if (!result.control) {
				const said = result.text ? ` (last text: ${result.text.replace(/\s+/g, " ")})` : "";
				ctx.log(`${spec.id}: agent produced no control object${said}`);
			}
			// Sweep-3 G21 (CR-1 corrected): an INFRA agent error must surface —
			// but NOT via throw (a thrown error dead-ends the gated writers'
			// bounded retry AND replays forever on resume — the memoizer caches
			// error results). Instead: record an HONEST failed result row NOW
			// (deriveRunStatus's last-status-per-stage sees it) and still return
			// the empty control so the convergence loop's retry feedback runs.
			// The stage-lifecycle event pair stays open→failed so the dashboard
			// and run log show the infra error immediately.
			if (result.error && !result.control) {
				ctx.results.push({ id: spec.id, label: spec.id, status: "failed", error: result.error.slice(0, 300) });
				ctx.events.emit("stage", { id: spec.id, label: spec.id, status: "failed", error: result.error.slice(0, 300) });
			}
			// Render pipeline: if this stage has a render model, render + write the doc.
			if (result.control) {
				const control = spec.normalizeControl ? spec.normalizeControl(result.control as Record<string, unknown>) : (result.control as Record<string, unknown>);
				renderAndWrite(state.setup!, (m) => ctx.log(m), spec.id, control);
				return control;
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
