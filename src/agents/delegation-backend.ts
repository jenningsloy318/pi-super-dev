/**
 * v0.3.25 L2 — the pi-subagents structured-delegation agent backend.
 *
 * super-dev's third specialist execution backend (besides the in-process
 * session backend and the raw `pi` subprocess backend): every agent call is
 * executed by pi-subagents' delegation executor — the SAME machinery as the
 * `subagent` tool — via the process-local event contract documented in
 * pi-subagents' docs/extension-api.md ("Structured delegation API").
 *
 * What this buys: Fleet UI rows with real turns/tools/tokens/output logs for
 * every specialist call, live steering, stop/resume, session attribution —
 * "the subagent same like pi itself".
 *
 * Design constraints honored here:
 *  - NO runtime import of pi-subagents (separately installed package; the
 *    event contract is pure `pi.events`). The payload types are mirrored
 *    locally and versioned against pi-subagents@0.58.0.
 *  - Result mode is TEXT: super-dev's control contract (`<control> JSON with:`
 *    in the prompt, parsed by extractControl) is unchanged — the delegation
 *    result text flows through the exact same parser the subprocess backend
 *    uses, so stages see an identical SpawnResult.
 *  - Identity: ownerRunId (the super-dev run) + nodeId (the per-call id, e.g.
 *    `pipeline.stage9.impl.a1`) is the logical node; each ATTEMPT gets a fresh
 *    requestId. A settled node may be re-attempted — that is the corrective
 *    re-prompt path (one retry when required control keys are missing).
 *  - Cancellation: AbortSignal and timeoutMs both emit the cancel event with
 *    the exact identity tuple and settle as an agent error, never a hang.
 */

import { DEFAULT_EMPTY_ARRAY_OK, extractControl, missingControlKeys } from "../control.ts";
import { armDelegationWatchdog } from "../watchdog.ts";
import { defaultAgentTimeoutMs, resolveModel, resolveThinking } from "./agent-runtime.ts";
import { agentTerminalLine } from "../progress-lines.ts";
import type { AgentProgress, SpawnResult } from "../types.ts";

/** The minimal structural slice of pi's EventBus this backend needs. */
export interface DelegationEventBus {
	on(channel: string, handler: (payload: unknown) => void): unknown;
	emit(channel: string, payload: unknown): void;
	/** Optional — used to detach per-attempt listeners; absent busses simply
	 *  accumulate them (bounded by the run's agent-call count). */
	off?(channel: string, handler: (payload: unknown) => void): unknown;
}

/** pi-subagents delegation event channels (prompt-template bridge contract). */
export const DELEGATION_REQUEST_EVENT = "prompt-template:subagent:request";
export const DELEGATION_STARTED_EVENT = "prompt-template:subagent:started";
export const DELEGATION_UPDATE_EVENT = "prompt-template:subagent:update";
export const DELEGATION_RESPONSE_EVENT = "prompt-template:subagent:response";
export const DELEGATION_CANCEL_EVENT = "prompt-template:subagent:cancel";

/** Registration prefix — collision-proof against pi-subagents' own agents
 *  (it ships agents like `judge`-adjacent names; ours are all `sd-*`). */
export const SD_AGENT_PREFIX = "sd-";

/** Map a super-dev specialist name to its registered delegation agent name. */
export function delegationAgentName(agent: string): string {
	return agent.startsWith(SD_AGENT_PREFIX) ? agent : `${SD_AGENT_PREFIX}${agent}`;
}

/** The request payload we put on the wire (mirrors
 *  SubagentDelegationRequest; `controlKeys` is deliberately NOT a field —
 *  the control contract lives in the task text only). */
export interface DelegationRequestPayload {
	requestId: string;
	ownerRunId: string;
	nodeId: string;
	agent: string;
	task: string;
	context: "fresh";
	cwd: string;
	model?: string;
	thinking?: string;
	timeoutMs?: number;
	result: { kind: "text" };
}

interface DelegationTerminalResponse {
	requestId: string;
	ownerRunId?: string;
	nodeId?: string;
	status: string;
	error?: string;
	runId?: string;
	agent?: string;
	model?: string;
	result?: unknown;
	usage?: DelegationUsage;
}

/** Structural slice of pi-subagents' SubagentDelegationUsage (api/delegation.ts)
 *  — declared locally per the no-runtime-import contract rule. */
export interface DelegationUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	turns: number;
	toolCalls: number;
	durationMs: number;
}

/** Structural slice of pi-subagents' SubagentDelegationUpdate — every field
 *  the bridge can send on a progress tick. v0.3.28: consumed in full. Before
 *  this, onUpdate read ONLY currentTool, so run.log under agentBackend
 *  pi-subagents degraded to bare tool names (live run 2026-08-28T16-09-12:
 *  every line was `requirements-clarifier: ls`) while the session backend logs
 *  `→ tool args…` + narration and the subprocess backend `→ summary` + live
 *  text. Reference consumers (pi-prompt-template-model subagent-widget)
 *  surface all of these fields. */
export interface DelegationUpdatePayload {
	requestId?: string;
	currentTool?: string;
	currentToolArgs?: string;
	recentOutput?: string;
	recentOutputLines?: string[];
	recentTools?: Array<{ tool: string; args: string }>;
	model?: string;
	toolCount?: number;
	durationMs?: number;
	tokens?: number;
}

/** pi-subagents' OWN runtime extensions failing to load in a spawned child.
 * Class, not one incident: pi's CLI loader calls a file-loaded extension's
 * default export with exactly one argument, so any pi-subagents-internal
 * runtime-extension file whose activate signature carries a config object
 * becomes unloadable as a `-e` path. Receipt (2026-09-04, pi-omisis spec-24
 * run 14:56): pi-subagents 0.65.0 changed
 * subagent-prompt-runtime.ts from `registerSubagentPromptRuntime(pi)` (env-
 * driven, 0.64 line 689) to `registerSubagentPromptRuntime(pi, config)` whose
 * FIRST statement reads `config.runtimeAcknowledgements` (0.65 line 445). A
 * live parent session with 0.64's bridge in MEMORY kept spawning `pi` CLI
 * children with `-e <...>/pi-subagents/src/runs/shared/subagent-prompt-runtime.ts`
 * (0.64 pi-args.ts:579, unfiltered) against the on-disk 0.65 file - every
 * child died at startup (~5s) with:
 *   Failed to load extension "<...>pi-subagents<...>": Cannot read properties of
 *   undefined (reading 'runtimeAcknowledgements')
 * (byte-identical reproduction: `pi -p "Say OK" -e <0.65 prompt-runtime.ts>`.)
 * The signature is package-scoped - a load failure INSIDE pi-subagents' own
 * files means the in-memory owner and the on-disk package disagree (version
 * skew after `pi update` mid-session, or a broken install). Neither can be
 * fixed by retrying within this process, so the caller degrades the whole
 * backend for the session (see workflow.ts) - P5: an executor infra failure
 * never punishes the work. */
const DELEGATION_RUNTIME_EXTENSION_FAILURE_RE = /Failed to load extension "[^"]*pi-subagents[^"]*"/;

/** True when a delegation error shows pi-subagents' own runtime extension
 * failing to load in the spawned child (version-skew class above). */
export function isDelegationRuntimeExtensionFailure(error: string | undefined): boolean {
	return !!error && DELEGATION_RUNTIME_EXTENSION_FAILURE_RE.test(error);
}

/** Sticky whole-backend degrade state for the version-skew class. The
 * in-memory pi-subagents bridge cannot change within this process, so once
 * the signature is seen, every later pi-subagents call in ANY run of this
 * process goes straight to the session backend (no per-call 5s burn - the
 * 2026-09-04 incident lost every agent of two stages to it). Reset hook
 * exists for tests only. */
let delegationRuntimeExtensionFailureSeen = false;
export function delegationBackendDegraded(): boolean {
	return delegationRuntimeExtensionFailureSeen;
}
export function markDelegationBackendDegraded(): void {
	delegationRuntimeExtensionFailureSeen = true;
}
export function resetDelegationBackendDegradeForTests(): void {
	delegationRuntimeExtensionFailureSeen = false;
}

/** v0.3.28: the terminal summary line — turns/tools/tokens/cache/cost/duration
 *  from SubagentDelegationUsage, via the SHARED formatter so all three
 *  backends emit identical segment formats in run.log. */
function delegationTerminalLine(agent: string, resp: DelegationTerminalResponse): string {
	return agentTerminalLine("delegation", agent, resp.status, {
		model: resp.model,
		turns: resp.usage?.turns,
		toolCalls: resp.usage?.toolCalls,
		input: resp.usage?.input,
		output: resp.usage?.output,
		cacheRead: resp.usage?.cacheRead,
		cacheWrite: resp.usage?.cacheWrite,
		cost: resp.usage?.cost,
		durationMs: resp.usage?.durationMs,
	});
}

/** The execution options — the same `common` object the other two backends
 *  receive, plus the delegation-specific inputs (event bus + run identity). */
export interface DelegationAgentOptions {
	agent: string;
	prompt: string;
	cwd: string;
	id?: string;
	model?: string;
	thinking?: string;
	thinkingLevel?: string;
	timeoutMs?: number;
	signal?: AbortSignal;
	controlKeys?: string[];
	/** Optional-by-contract keys whose empty-array value counts as present
	 *  (same semantics as the session backend's corrective check). */
	allowEmptyArraysFor?: string[];
	/** Inherited main-session defaults (SCENARIO-001 parity): applied BELOW an
	 *  explicit model/thinking param, exactly like the other two backends. */
	inheritedModelObject?: import("./agent-runtime.ts").SessionModelOption;
	inheritedThinking?: string;
	onProgress?: AgentProgress;
	/** pi's in-process event bus (RunOptions.events, threaded from the
	 *  extension). Without it this backend is never selected. */
	events: DelegationEventBus;
	/** The super-dev run identity for the delegation tuple. */
	ownerRunId: string;
}

function randomRequestId(): string {
	return `sd-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function textOf(value: unknown): string {
	if (typeof value === "string") return value;
	// Review-2 P0: the real bridge ALWAYS returns text results as the
	// { kind: "text", text } envelope (pi-subagents delegation-adapters.ts
	// ~364-375: `projectedResult = { kind: "text", text: child.finalOutput }`).
	// Unwrap it — otherwise JSON.stringify escapes the <control> block and
	// extractControl fails on every completed call.
	if (value != null && typeof value === "object") {
		const envelope = value as { kind?: unknown; text?: unknown };
		if (envelope.kind === "text" && typeof envelope.text === "string") return envelope.text;
	}
	if (value == null) return "";
	try { return JSON.stringify(value); } catch { return String(value); }
}

/** One delegation attempt: emit the request, await the terminal response for
 *  exactly this requestId, forward progress, honor cancel/timeout. */
function attempt(opts: DelegationAgentOptions, task: string, timeoutMs: number | undefined): Promise<{ response: DelegationTerminalResponse | null; error?: string }> {
	const { events } = opts;
	// Review-2 P1 (SD-04 parity): an already-aborted signal NEVER fires
	// "abort" listeners — bail synchronously BEFORE emitting an uncancellable
	// request that would either hang or run an orphan child to completion.
	if (opts.signal?.aborted) {
		return Promise.resolve({ response: null, error: `agent ${opts.agent} aborted by parent signal` });
	}
	const requestId = randomRequestId();
	const nodeId = opts.id ?? `pipeline.${opts.agent}`;
	const request: DelegationRequestPayload = {
		requestId,
		ownerRunId: opts.ownerRunId,
		nodeId,
		agent: delegationAgentName(opts.agent),
		task,
		context: "fresh",
		cwd: opts.cwd,
		result: { kind: "text" },
	};
	// Review-2 P2: model/thinking resolution mirrors the other backends —
	// explicit param > SUPER_DEV_MODEL/SUPER_DEV_THINKING env > inherited
	// main-session default > (thinking only) role default.
	const model = opts.model ?? resolveModel(undefined) ?? (opts.inheritedModelObject ? `${opts.inheritedModelObject.provider}/${opts.inheritedModelObject.id}` : undefined);
	if (model) request.model = model;
	const perCallThinking = (opts.thinking ?? opts.thinkingLevel) as import("./agent-runtime.ts").ThinkingLevel | undefined;
	const thinking = resolveThinking(opts.agent, perCallThinking, opts.inheritedThinking as import("./agent-runtime.ts").ThinkingLevel | undefined);
	if (thinking) request.thinking = thinking;
	if (timeoutMs) request.timeoutMs = timeoutMs;

	// v0.3.28 progress parity: per-attempt log state. `toolLines` dedupes rapid
	// identical ticks (one line per tool call, not per progress tick);
	// `prevOutputLines` diffs the narration window so each line logs once.
	const toolLines = new Set<string>();
	let prevOutputLines: string[] = [];
	const logToolLine = (line: string) => {
		if (toolLines.has(line)) return;
		toolLines.add(line);
		opts.onProgress?.event?.(`${opts.agent}: ${line}`);
	};
	opts.onProgress?.event?.(`delegation ${opts.agent}: request agent=${request.agent}${model ? ` model=${model}` : ""}${timeoutMs ? ` timeout=${timeoutMs}ms` : ""} cwd=${opts.cwd}`);

	return new Promise((resolve) => {
		let settled = false;
		// Review-2 P1: pi-subagents treats `on()`'s RETURN as the unsubscribe
		// (off appears nowhere in its codebase) — capture the returned
		// detachers and call them in cleanup; `off` stays as a belt-and-braces
		// fallback for busses that expose it instead.
		const detachers: Array<unknown> = [];
		const finish = (value: { response: DelegationTerminalResponse | null; error?: string }) => {
			if (settled) return;
			settled = true;
			cleanup();
			resolve(value);
		};
		const matches = (payload: DelegationTerminalResponse) =>
			payload && typeof payload === "object" && payload.requestId === requestId
			&& (payload.ownerRunId === undefined || payload.ownerRunId === opts.ownerRunId)
			&& (payload.nodeId === undefined || payload.nodeId === nodeId);
		const onResponse = (raw: unknown) => {
			const payload = raw as DelegationTerminalResponse;
			if (!matches(payload)) return;
			if (payload.status === "invalid_request") {
				opts.onProgress?.event?.(`delegation ${opts.agent}: rejected status=invalid_request${payload.error ? ` (${payload.error})` : ""}`);
				finish({ response: null, error: `delegation bridge rejected the request: ${payload.error ?? "invalid_request"}` });
				return;
			}
			opts.onProgress?.event?.(delegationTerminalLine(opts.agent, payload));
			finish({ response: payload });
		};
		const onUpdate = (raw: unknown) => {
			const payload = raw as DelegationUpdatePayload;
			if (payload?.requestId !== requestId) return;
			// Tool coverage: the append-only recentTools history first (it surfaces
			// tools that finished between ticks), then the live currentTool tick.
			// toolLines dedupes a tool that appears in both.
			if (Array.isArray(payload.recentTools)) {
				for (const entry of payload.recentTools) {
					if (!entry || typeof entry.tool !== "string") continue;
					logToolLine(`→ ${entry.tool}${entry.args ? ` ${entry.args}` : ""}`);
				}
			}
			if (payload.currentTool) {
				logToolLine(`→ ${payload.currentTool}${payload.currentToolArgs ? ` ${payload.currentToolArgs}` : ""}`);
			}
			// Narration output tail (subprocess live-text parity): prefer the
			// bridge's recentOutputLines window, fall back to splitting
			// recentOutput; log only lines new since the previous tick.
			const lines = Array.isArray(payload.recentOutputLines) && payload.recentOutputLines.length > 0
				? payload.recentOutputLines.filter((l): l is string => typeof l === "string" && l.trim().length > 0)
				: (typeof payload.recentOutput === "string" ? payload.recentOutput.split("\n") : []).filter((l) => l.trim().length > 0);
			for (const line of lines) {
				if (prevOutputLines.includes(line)) continue;
				opts.onProgress?.event?.(`${opts.agent}: ⇢ ${line.slice(0, 200)}`);
			}
			prevOutputLines = lines;
		};
		const cancel = (reason: string) => {
			// Cancel affects only the exact tuple (including cancel-before-start
			// races) — safe to emit even if the bridge never started us.
			try {
				events.emit(DELEGATION_CANCEL_EVENT, { requestId, ownerRunId: opts.ownerRunId, nodeId });
			} catch { /* best-effort */ }
			finish({ response: null, error: reason });
		};
		const onAbort = () => cancel(`agent ${opts.agent} aborted by parent signal`);
		const cleanup = () => {
			for (const detach of detachers) {
				if (typeof detach === "function") { try { (detach as () => void)(); } catch { /* best-effort */ } }
			}
			try { events.off?.(DELEGATION_RESPONSE_EVENT, onResponse as (payload: unknown) => void); } catch { /* best-effort */ }
			try { events.off?.(DELEGATION_UPDATE_EVENT, onUpdate as (payload: unknown) => void); } catch { /* best-effort */ }
			opts.signal?.removeEventListener("abort", onAbort);
			if (timer) clearTimeout(timer);
			watchdog?.dispose(); // v0.3.57: the settle path ran → tell the external watcher to stand down
		};
		let timer: ReturnType<typeof setTimeout> | undefined;
		let watchdog: import("../watchdog.ts").DelegationWatchdog | undefined;
		if (timeoutMs && timeoutMs > 0) {
			timer = setTimeout(() => cancel(`agent ${opts.agent} timed out after ${timeoutMs}ms (delegation)`), timeoutMs + 2_000);
			// v0.3.57 liveness (silent-zombie incident): the timer above lives in
			// THIS loop — if the loop freezes, it dies with everything else. The
			// external watcher is a detached process that records the freeze when
			// the heartbeat is still present past deadline+grace. Telemetry-only;
			// every failure inside it is fail-open (P5).
			watchdog = armDelegationWatchdog(opts.agent, timeoutMs);
		}
		opts.signal?.addEventListener("abort", onAbort, { once: true });
		detachers.push(
			events.on(DELEGATION_RESPONSE_EVENT, onResponse as (payload: unknown) => void),
			events.on(DELEGATION_UPDATE_EVENT, onUpdate as (payload: unknown) => void),
		);
		events.emit(DELEGATION_REQUEST_EVENT, request);
	});
}

/** The corrective suffix appended when a text result is missing required
 *  control keys — mirrors the session backend's corrective re-prompt. */
function correctiveTask(prompt: string, missing: string[]): string {
	return `${prompt}\n\n## Required output correction\nYour previous response was missing the required control key(s): ${missing.join(", ")}. Re-answer and end your reply with the complete <control> JSON block containing every required key.`;
}

/** The backend entry: same signature family as runAgentViaSession/spawnAgent
 *  (the shared `common` object) plus events + ownerRunId. Returns a
 *  SpawnResult parsed exactly like the subprocess backend's fallback path. */
export async function runAgentViaDelegation(opts: DelegationAgentOptions): Promise<SpawnResult> {
	const task0 = opts.prompt;
	// Review-2 P1: local backstop parity — the session/spawn backends both
	// fall back to the role timeout when the call sets none (in practice only
	// reflection.ts sets call.timeoutMs), so a request without timeoutMs must
	// still never hang forever when pi-subagents is absent/unresponsive.
	const backstopMs = opts.timeoutMs ?? defaultAgentTimeoutMs(opts.agent);
	const first = await attempt(opts, task0, backstopMs);
	if (first.error) return { text: "", control: null, model: undefined, error: first.error };
	const response = first.response!;
	// Any non-completed terminal state (failed/stopped/duplicate_node/…) is an
	// agent error — never a silent empty success.
	if (response.status !== "completed") {
		return { text: "", control: null, model: response.model, error: response.error?.trim() || `delegation ended with status ${response.status}` };
	}
	const text = textOf(response.result);
	// v0.3.54 (F6 wiring): declared keys guard the fallback paths — a fenced or
	// trailing JSON blob that is NOT this call's control is rejected, not silently
	// accepted as a verdict.
	const control = extractControl(text, opts.controlKeys);
	// Review-2 P1: the corrective check must honor allowEmptyArraysFor AND the
	// built-in file-list allow-set — a legitimately empty `filesCreated: []`
	// must NOT trigger a spurious full second run (session-agent parity).
	// v0.3.47: findings:[] is a valid zero-defect approval (see pi-spawn DEFAULT_EMPTY_ARRAY_OK).
	// v0.3.56 F5: base set imported from control.ts (shared across all three
	// backends — P6); the hand copy here could drift from the others.
	const emptyArrayOk = new Set([...DEFAULT_EMPTY_ARRAY_OK, ...(opts.allowEmptyArraysFor ?? [])]);
	const missing = opts.controlKeys && opts.controlKeys.length > 0 && control != null
		? missingControlKeys(control, opts.controlKeys, { allowEmptyArraysFor: emptyArrayOk })
		: (control == null && opts.controlKeys && opts.controlKeys.length > 0 ? [...opts.controlKeys] : []);
	if (missing.length > 0) {
		// One corrective attempt: same logical node, new requestId (legal once
		// the previous attempt settled).
		const second = await attempt(opts, correctiveTask(task0, missing), backstopMs);
		if (second.error) return { text, control, model: response.model, usage: second.response?.usage, error: `delegation retry after missing control keys (${missing.join(", ")}): ${second.error}` };
		const response2 = second.response!;
		if (response2.status !== "completed") {
			return { text, control, model: response.model, error: `delegation retry ended with status ${response2.status}${response2.error ? `: ${response2.error}` : ""}` };
		}
		const text2 = textOf(response2.result);
		const control2 = extractControl(text2, opts.controlKeys);
		if (control2 != null) return { text: text2, control: control2, model: response2.model ?? response.model, usage: second.response?.usage };
		// v0.3.48 honest diagnosis: distinguish UNPARSEABLE control JSON (a
		// `<control>` block exists but strict parse failed — the unescaped-quote
		// class, now repaired in control.ts) from a genuinely absent block. The
		// old wording ("still missing control keys") pointed debuggers at the
		// MODEL omitting keys when the real defect was in the payload's quoting.
		const hadTag = /<control>[\s\S]*<\/control>/i.test(text2);
		return { text: text2, control: null, model: response2.model ?? response.model, usage: second.response?.usage, error: hadTag
			? `delegation retry produced an UNPARSEABLE control block (originally missing: ${missing.join(", ")}) — the <control> JSON failed to parse; report this payload for corpus capture`
			: `delegation retry produced no control object at all (originally missing: ${missing.join(", ")})` };
	}
	return { text, control, model: response.model, usage: response.usage };
}
