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
	/** Control keys the caller expects back (for the session backend's
	 *  structured_output schema). Optional; omitted for non-writer calls. */
	controlKeys?: string[];
	/** Optional TypeBox schema for typed structured_output (render pipeline stages).
	 *  When provided, the structured_output tool uses this typed schema instead of
	 *  the permissive Type.Any-per-key schema, so the model returns typed data. */
	schema?: unknown;
}

export interface AgentResult extends SpawnResult {}

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
	spent(): void;
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
	status: NodeStatus | "running";
	error?: string;
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
	parallel(calls: Array<() => Promise<AgentResult>>): Promise<AgentResult[]>;
	budget: Budget;
	log(message: string): void;
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
	run(state: PipelineState, ctx: StageContext): Promise<NodeResult>;
}

/** A workflow: a root node plus metadata. */
export interface Workflow {
	id: string;
	description?: string;
	root: Node;
}

// ─── Run options + summary ──────────────────────────────────────────────────

export interface RunOptions {
	cwd?: string;
	skipWorktree?: boolean;
	skipStages?: string[];
	model?: string;
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
	/** Phase 3 (AC-05 / SCENARIO-013..016): drains mid-run user input captured
	 *  live during execution, atomically, ONCE per specialist spawn inside
	 *  `workflow.ts` `realAgent`. Each captured input is injected exactly once
	 *  (memoized resume replays do not re-drain — draining lives inside
	 *  `realAgent`, NOT the memoizing wrapper). Optional — omitting it disables
	 *  the feature and prompts stay byte-identical to the no-feature baseline. */
	userSteerProvider?: () => string[];
	/** Phase 4 (AC-08 / SCENARIO-017..018): session-backend best-effort LIVE
	 *  steer. When provided, the session backend hands out a no-throw
	 *  forwarder bound to the live AgentSession (or `null` when the handle is
	 *  absent). The capture path nudges the currently-running specialist with
	 *  the MOST-RECENT input only. Optional — omitting it (or using the
	 *  subprocess/browser backend) leaves the Phase-3 queue path as the sole
	 *  delivery contract, with an identical guarantee. */
	onSteer?: (fn: ((text: string) => void) | null) => void;
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
