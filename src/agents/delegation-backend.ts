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

import { extractControl, missingControlKeys } from "../control.ts";
import { defaultAgentTimeoutMs, resolveModel, resolveThinking } from "../pi-spawn.ts";
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
	model?: string;
	result?: unknown;
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
	inheritedModelObject?: import("../session-agent.ts").SessionModelOption;
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
	const perCallThinking = (opts.thinking ?? opts.thinkingLevel) as import("../pi-spawn.ts").ThinkingLevel | undefined;
	const thinking = resolveThinking(opts.agent, perCallThinking, opts.inheritedThinking as import("../pi-spawn.ts").ThinkingLevel | undefined);
	if (thinking) request.thinking = thinking;
	if (timeoutMs) request.timeoutMs = timeoutMs;

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
				finish({ response: null, error: `delegation bridge rejected the request: ${payload.error ?? "invalid_request"}` });
				return;
			}
			finish({ response: payload });
		};
		const onUpdate = (raw: unknown) => {
			const payload = raw as { requestId?: string; currentTool?: string };
			if (payload?.requestId !== requestId || !payload.currentTool) return;
			opts.onProgress?.event?.(`${opts.agent}: ${payload.currentTool}`);
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
		};
		let timer: ReturnType<typeof setTimeout> | undefined;
		if (timeoutMs && timeoutMs > 0) {
			timer = setTimeout(() => cancel(`agent ${opts.agent} timed out after ${timeoutMs}ms (delegation)`), timeoutMs + 2_000);
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
	const control = extractControl(text);
	// Review-2 P1: the corrective check must honor allowEmptyArraysFor AND the
	// built-in file-list allow-set — a legitimately empty `filesCreated: []`
	// must NOT trigger a spurious full second run (session-agent parity).
	const emptyArrayOk = new Set(["filesCreated", "filesModified", "filesDeleted", ...(opts.allowEmptyArraysFor ?? [])]);
	const missing = opts.controlKeys && opts.controlKeys.length > 0 && control != null
		? missingControlKeys(control, opts.controlKeys, { allowEmptyArraysFor: emptyArrayOk })
		: (control == null && opts.controlKeys && opts.controlKeys.length > 0 ? [...opts.controlKeys] : []);
	if (missing.length > 0) {
		// One corrective attempt: same logical node, new requestId (legal once
		// the previous attempt settled).
		const second = await attempt(opts, correctiveTask(task0, missing), backstopMs);
		if (second.error) return { text, control, model: response.model, error: `delegation retry after missing control keys (${missing.join(", ")}): ${second.error}` };
		const response2 = second.response!;
		if (response2.status !== "completed") {
			return { text, control, model: response.model, error: `delegation retry ended with status ${response2.status}${response2.error ? `: ${response2.error}` : ""}` };
		}
		const text2 = textOf(response2.result);
		const control2 = extractControl(text2);
		if (control2 != null) return { text: text2, control: control2, model: response2.model ?? response.model };
		return { text: text2, control: null, model: response2.model ?? response.model, error: `delegation retry still missing control keys: ${missing.join(", ")}` };
	}
	return { text, control, model: response.model };
}
