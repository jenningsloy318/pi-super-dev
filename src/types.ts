/**
 * Core type system for the self-contained super-dev control-flow engine.
 *
 * Architecture: a pipeline is a tree of `Node`s evaluated over a shared
 * `PipelineState`. Leaf nodes (`task`) wrap a `Stage` (a unit of work that
 * spawns agents / runs helpers). Control nodes (`sequence`, `branch`,
 * `parallel`, `loop`, `retry`, `gate`, `map`, `wait`, `tryCatch`, ...) compose
 * nodes and are self-evaluating: each implements `run(state, ctx)`. The engine
 * itself is just `await root.run(state, ctx)` — adding a new control construct
 * means writing one builder function in `nodes.ts`, never touching the runner.
 *
 * Zero dependency on @agwab/pi-workflow: agents are spawned directly as `pi`
 * child processes (see `pi-spawn.ts`).
 */

import type { EventEmitter } from "node:events";

// ─── Primitive result types ─────────────────────────────────────────────────

export type ControlObj = Record<string, unknown>;

/** A running service brought up by the verify-loop's `bringup` step. */
export interface ServiceHandle {
	role: "api" | "ui";
	baseUrl: string;
	pid: number;
	port: number;
	cmd: string;
	/** True if `bringup` reused an already-running service (teardown won't kill it). */
	external: boolean;
	/** True only after the readiness poll succeeded. */
	ready: boolean;
}

/** Services brought up for the verify-loop's test phase. */
export interface ServiceMap {
	api?: ServiceHandle;
	ui?: ServiceHandle;
}

/** Result of parsing an agent's final assistant message. */
export interface SpawnResult {
	text: string;
	control: ControlObj | null;
	model?: string;
	error?: string;
}

export interface AgentCall {
	id: string;
	agent: string;
	prompt: string;
	/**
	 * Per-call mutation contract. `source-read-only` means the child agent may
	 * inspect the project and run diagnostics, but must not mutate project source
	 * or config files. The pipeline itself may still render/update its own spec
	 * artifacts outside the child agent call.
	 */
	accessMode?: AgentAccessMode;
	/** Control keys the caller expects back (for the session backend's
	 *  structured_output schema). Optional; omitted for non-writer calls. */
	controlKeys?: string[];
	/** Optional TypeBox schema for typed structured_output (render pipeline stages).
	 *  When provided, the structured_output tool uses this typed schema instead of
	 *  the permissive Type.Any-per-key schema, so the model returns typed data. */
	schema?: unknown;
	/** Optional per-call wall-clock cap (ms). Overrides the role-based default
	 *  (see defaultAgentTimeoutMs). Threaded into `common` and honored by both the
	 *  session and subprocess backends. */
	timeoutMs?: number;
	/** Optional per-call thinking override (Phase 2). Highest precedence; when
	 *  absent the resolved level falls back to SUPER_DEV_THINKING then the role
	 *  default. Threaded into `common` for both backends. */
	thinking?: import("./pi-spawn.ts").ThinkingLevel;
	/** Optional per-call model override ("provider/id"). Highest precedence — wins
	 *  over config.agentModels and the global --model/SUPER_DEV_MODEL. Rarely set by
	 *  stages; the usual cross-model policy is declared in ~/.super-dev config. */
	model?: string;
}

export type AgentAccessMode = "write" | "source-read-only";

export interface AgentResult extends SpawnResult {}

/** Image/content attachment captured from a parent Pi input event while a run is active. */
export interface RuntimeInstructionImage {
	mediaType?: string;
	data?: string;
	path?: string;
	label?: string;
}

/** Freeform text/image instruction typed by the user while super-dev is running. */
export interface RuntimeInstruction {
	id: string;
	createdAt: string;
	text: string;
	source?: string;
	streamingBehavior?: "steer" | "followUp";
	images?: RuntimeInstructionImage[];
}

export interface HelperCall {
	name: string;
	sources: Record<string, unknown>;
	options?: Record<string, unknown>;
	context?: Record<string, unknown>;
}

export interface HelperResult {
	value: ControlObj;
	digest: string;
}

export interface Budget {
	check(): boolean;
	/** Atomically reserve one agent slot. Increments only when under the cap
	 *  and returns whether the reservation succeeded. This is the hard gate —
	 *  `realAgent` bails when it returns false — so concurrent branches cannot
	 *  exceed `maxAgents` via the check-then-await race that a read-only
	 *  `check()` + post-hoc `spent()` left open (BUG-4). `check()` remains a
	 *  read-only peek for stage-body guards. */
	spent(): boolean;
	count: number;
}

export interface ProgressSink {
	phase(label: string): void;
	log(message: string): void;
	/** Live streaming text from the active agent (typing effect). `partial` is the
	 *  full accumulated text of the current text block so far. */
	text(partial: string): void;
	/** Per-stage lifecycle for the workflow dashboard (v1): "running" on enter,
	 *  a terminal NodeStatus on exit. Optional — headless callers omit it. */
	stage?(info: StageProgressEvent): void;
}

/** One stage lifecycle event for dashboard subscribers. */
export interface StageProgressEvent {
	id: string;
	label: string;
	status: NodeStatus | "running" | "partial";
	error?: string;
	/** Optional dashboard-only hierarchy marker. `phase` rows are subordinate to
	 *  their stage; `step` rows are subordinate to a phase (level 3 — e.g. TDD RED,
	 *  RED review, Implementation). Both are excluded from top-level stage counts. */
	kind?: "stage" | "phase" | "step";
	parentId?: string;
}

/** Streaming callbacks from a spawned agent to the progress sink. */
export interface AgentProgress {
	/** A permanent log line (tool call, turn marker, finalized agent text). */
	event(message: string): void;
	/** Live partial text as the agent generates it (control block stripped). */
	text(partial: string): void;
}

// ─── Domain shapes ──────────────────────────────────────────────────────────

export interface SetupControl {
	worktreePath: string;
	specDirectory: string;
	defaultBranch: string;
	language: string;
	isWebUi: boolean;
	specIdentifier: string;
	/** True when an isolated git worktree was created (vs. operating in cwd). */
	worktreeCreated: boolean;
	/** True when setup had to `git init` the directory first. */
	initializedRepo: boolean;
}

export interface Classification {
	taskType: "bug" | "feature" | "refactor";
	uiScope: string;
	language: string;
	isWebUi: boolean;
}

// ─── Pipeline state (shared blackboard) ─────────────────────────────────────

/**
 * Mutable state threaded through every node. A `task` node stores its return
 * value under `state[stage.id]`. Control nodes read upstream artifacts by key.
 * The index signature allows custom stages without extending the interface.
 */
export interface PipelineState {
	setup?: SetupControl;
	classify?: Classification;
	requirements?: ControlObj;
	bdd?: ControlObj;
	research?: ControlObj;
	debug?: ControlObj;
	assessment?: ControlObj;
	design?: ControlObj;
	prototype?: ControlObj;
	spec?: ControlObj;
	specReview?: ControlObj;
	implementation?: ControlObj;
	/** Running services brought up by the verify-loop's `bringup` step, so the
	 *  api/ui test steps know where to hit and `teardown` knows what to kill. */
	services?: ServiceMap;
	review?: ControlObj;
	codeReview?: ControlObj;
	adversarialReview?: ControlObj;
	apiTest?: ControlObj;
	uiTest?: ControlObj;
	/** Expected integration-test roles for the current verification attempt. */
	integrationExpectedTests?: Array<"api" | "ui">;
	/** Aggregate integration verdict; absent means integration never ran. */
	integration?: ControlObj;
	docs?: ControlObj;
	cleanup?: ControlObj;
	merge?: ControlObj;
	[index: string]: unknown;
}

// ─── Stage (leaf unit of work) ──────────────────────────────────────────────

/** Outcome of one leaf-stage execution, recorded for honest run reporting. */
export interface StageResult {
	id: string;
	label: string;
	status: NodeStatus;
	error?: string;
}

/**
 * Execution primitives handed to every stage. The runner builds one context
 * and passes the same reference around; `agent()` resolves its cwd from
 * `state.setup` (falling back to the run cwd).
 */
export interface StageContext {
	task: string;
	options: RunOptions;
	state: PipelineState;
	agent(call: AgentCall): Promise<AgentResult>;
	helper(call: HelperCall): Promise<HelperResult>;
	/**
	 * @deprecated Use the `parallel()` NODE builder from nodes.ts instead. This
	 * ctx method does NOT propagate the abort signal or run scope tracking, so
	 * using it breaks resume-cache keying and cancellation (F-6). It has no
	 * callers today; kept only for interface stability. Prefer `parallel([...])`.
	 */
	parallel(calls: Array<() => Promise<AgentResult>>): Promise<AgentResult[]>;
	budget: Budget;
	log(message: string): void;
	/** Announce a sub-phase of the current stage (pi-native): routes through the
	 *  progress sink's `phase()` so it surfaces as the dashboard subtitle, the
	 *  native working-message, AND a distinct `▶`-prefixed transcript line under
	 *  the running stage's section. Used by the Implementation stage to show
	 *  "Phase N/M: <name>" as the current phase being implemented. No-op-safe
	 *  when no progress sink is wired (headless / unit tests). */
	phase(label: string): void;
	/** Push a structural scope marker (e.g. `parallel[0]`, `map[2]`) onto an
	 *  AsyncLocalStorage stack for the duration of `fn`, so concurrent branches
	 *  get DISTINCT, order-independent scope paths. The resume cache keys agent
	 *  calls by their structural position (`callId@scopePath#occurrence`), which
	 *  is deterministic regardless of await interleaving — the fix for the
	 *  fragile sequential `seq` counter (BUG-1). Optional: control-flow nodes
	 *  fall back to running `fn` directly when absent (test contexts that don't
	 *  exercise resume). */
	withScope?<T>(marker: string, fn: () => Promise<T>): Promise<T>;
	events: EventEmitter;
	signal?: AbortSignal;
	/** Every leaf-stage outcome, appended by `task()`. Used for honest summaries. */
	results: StageResult[];
}

/** A leaf unit of work. Its return value is stored under `state[id]`. */
export interface Stage {
	id: string;
	label: string;
	description?: string;
	enabled?: (state: PipelineState) => boolean;
	run: (state: PipelineState, ctx: StageContext) => Promise<unknown>;
	fatal?: boolean;
	/** Upstream artifact docs this stage needs (filename globs in the spec dir,
	 *  e.g. "*-requirements.md"). task() checks they exist before running and
	 *  logs ✓/✗, making inter-stage dependencies visible. Missing artifacts are
	 *  logged (not fatal) — the tolerant pipeline proceeds and the prompt shows
	 *  "N/A" for absent upstream. */
	requires?: string[];
}

// ─── Control-flow node algebra ──────────────────────────────────────────────

export type NodeStatus = "ok" | "skipped" | "failed" | "cancelled";

export interface NodeResult {
	status: NodeStatus;
	/** Stored artifact (for tasks) or aggregate (for some control nodes). */
	value?: unknown;
	error?: string;
	/** Round/attempt count reached (for loop/retry/gate). */
	attempts?: number;
}

/**
 * A self-evaluating pipeline node. Leaf `task` nodes do work; control nodes
 * recursively evaluate children. The runner is `await root.run(state, ctx)`.
 */
export interface Node {
	kind: string;
	label?: string;
	/** The stage id (task nodes only). Used by duplicate-id detection in `parallel`
	 *  so two concurrent tasks can't silently clobber the same `state[id]`. */
	id?: string;
	run(state: PipelineState, ctx: StageContext): Promise<NodeResult>;
}

/** A workflow: a root node plus metadata. */
export interface Workflow {
	id: string;
	description?: string;
	root: Node;
}

// ─── HITL escalation primitives (spec-18 / AC-01) ─────────────────────────
// Pure additions — zero pipeline behavior change until a firing point
// consumes ctx.options.escalate. Threaded exactly like userSteerProvider so
// every node/stage/gate reaches it via the already-shared StageContext.options.

/** The kind of unrecoverable blocker the pipeline hit (SCENARIO-001 / AC-01). */
export type EscalationKind = "stagnation" | "gate-exhaustion" | "design-conflict";

/**
 * Whether the user may "accept" the finding and continue. Hard blockers
 * (e.g. a failed build gate) are terminal — `accept-limitation` is never
 * offered for them. Soft blockers (review/test findings, stagnation) may be
 * accepted. Defaults to "soft"; firing points set "hard" for build failures.
 */
export type EscalationSeverity = "soft" | "hard";

/** A single finding surfaced for stagnation/review escalation (advisory). */
export interface EscalationFinding {
	file?: string | null;
	severity?: string | null;
	title?: string | null;
}

/** The failure payload passed to {@link Escalate} (carries rich, LIVE context). */
export interface EscalationFailure {
	kind: EscalationKind;
	stage?: string;
	message: string;
	specDirectory?: string;
	worktreePath?: string;
	findings?: EscalationFinding[];
	severity?: EscalationSeverity;
}

/** The user's chosen recovery action (SCENARIO-002 / AC-01). */
export type EscalationChoice =
	| "retry-with-guidance"
	| "revise-manually"
	| "accept-limitation"
	| "abandon";

/**
 * A decision returned by {@link Escalate}. `undefined` = no decision
 * (treat as fail-with-report — the pre-existing abort/break path).
 */
export interface EscalationDecision {
	choice: EscalationChoice;
	/** Free-text guidance injected into the next specialist attempt
	 *  (retry-with-guidance only). */
	guidance?: string;
}

/**
 * Inline pause-ask-continue hook fired BEFORE an unrecoverable throw/break.
 * Returns `undefined` on dismissal, timeout, non-interactive mode, or any error
 * (the impl NEVER throws). A firing point that receives `undefined` proceeds
 * to the pre-existing fail/abort path.
 */
export type Escalate = (failure: EscalationFailure) => Promise<EscalationDecision | undefined>;

// ─── Run options + summary ──────────────────────────────────────────────────

export interface RunOptions {
	cwd?: string;
	skipWorktree?: boolean;
	skipStages?: string[];
	model?: string;
	/** The FULL main-session model object (ctx.model), threaded from
	 *  extension.execute() → realAgent.common → both backends. The session backend
	 *  passes it wholesale to createAgentSession; the subprocess backend derives
	 *  the qualified `provider/id` for `--model`. ADDITIVE — never clobbers `model`
	 *  or a SUPER_DEV_MODEL env override; wins over the SDK/settings default. */
	inheritedModelObject?: import("./session-agent.ts").SessionModelOption;
	/** Phase 1 (Feature 1): DEFAULT thinking level inherited from the live main
	 *  session (ctx.thinkingLevel). ADDITIVE — never clobbers a per-call override
	 *  or a SUPER_DEV_THINKING env var, but wins over the role default. */
	inheritedThinking?: import("./pi-spawn.ts").ThinkingLevel;
	maxAgents?: number;
	maxConcurrency?: number;
	progress?: ProgressSink;
	signal?: AbortSignal;
	/** Specialist execution backend. "subprocess" (default) = raw `pi` spawn;
	 *  "session" = in-process `createAgentSession`. Also set via
	 *  SUPER_DEV_BACKEND env. */
	backend?: "subprocess" | "session";
	/** Resume an interrupted run: `true` = auto-pick the most-recent resumable
	 *  spec; a string = a specific spec identifier (e.g. "07-foo-bar"). */
	resume?: boolean | string;
	/** @internal resolved by pipeline.ts — the spec identifier to resume. */
	resumeSpecIdentifier?: string;
	/** @internal loaded resume cache; when present, ctx.agent memoizes. */
	resumeCache?: Map<string, AgentResult>;
	/** Spec-declared cargo build-gate contract (Layer D, AC-04..08). Optional.
	 *  On a rust repo this is the HIGHEST-precedence scope source: `workspace`
	 *  short-circuits to workspace-wide; `packages` (validated) drives the scoped
	 *  set; `integration` targets are appended. Threaded from the specification
	 *  stage's declared `gate` via `state.spec?.gate`. */
	gate?: { packages?: string[]; workspace?: boolean; integration?: string[] };
	/** Drains freeform runtime instructions captured from parent Pi input while
	 *  super-dev is running. Instructions may include text plus image/file
	 *  attachments. They are persisted to the spec dir and injected at the next
	 *  specialist/checkpoint boundary; resume replays do not re-drain because this
	 *  is called inside `realAgent`, not the memoizing wrapper. */
	userSteerProvider?: () => Array<RuntimeInstruction | string>;
	/** Inline HITL escalation hook (AC-01). Supplied by extension.ts; reachable
	 *  as ctx.options.escalate with NO workflow.ts edit (StageContext.options is
	 *  RunOptions). Additive — undefined/absent ⇒ byte-identical to today. */
	escalate?: Escalate;
}

/** Honest, derived overall outcome of a run. */
export type RunStatus = "success" | "partial" | "failed";

export interface RunSummary {
	workflowId: string;
	specIdentifier: string;
	worktreePath: string;
	specDirectory: string;
	agentsSpawned: number;
	state: PipelineState;
	/** Derived overall outcome — never faked. */
	status: RunStatus;
	/** Stages that ended in `failed`, with their error message (deduped). */
	failedStages: { label: string; error?: string }[];
	/** Error message when the run aborted (e.g. a fatal gate threw). */
	error?: string;
}
