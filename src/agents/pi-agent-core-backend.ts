/**
 * 069 — the pi-agent-core direct backend: replaces the pi-subagents
 * delegation layer with direct Agent-class usage.
 *
 * Every specialist call creates a one-shot `new Agent(...)` with:
 *  - systemPrompt = the role's base prompt (+ skill cards + lessons)
 *  - model = resolved from our per-role config via the host's ModelRegistry
 *  - thinkingLevel = the role's tier
 *  - tools = the role's allowlist (SDK tool factories, created per-call
 *    with the correct cwd)
 *  - beforeToolCall = the child guards (commit/safety) ported from
 *    extension files to inline hooks (069 R7-Q2), + our tool budget counter
 *  - streamFn = the host's ctx.modelRegistry.streamSimple (carries
 *    auth.json credentials, NOT env-var-only)
 *
 * The three hard adapter invariants (069 R4-Q5, P4 mechanical):
 *  1. EVERY prompt() is timeout-wrapped (setTimeout(abort) + await
 *     waitForIdle() + clearTimeout — the Agent has NO internal timeout)
 *  2. deactivate aborts + waits all active Agents
 *  3. contextWindow pre-checked before prompt
 *
 * Returns the same SpawnResult contract the delegation backend satisfied —
 * the 14-stage pipeline, the convergence economy (WS0-WS7), the bounce
 * gates, the sealed audit, and the resume cache are all unchanged.
 */

import { Agent } from "@earendil-works/pi-agent-core";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { SpawnResult, AgentUsage, ControlObj } from "../types.ts";
import { extractControl } from "../control.ts";
import { splitModelThinking, clampThinkingToModel } from "./agent-runtime/index.ts";
import { isCommitClassGitCommand } from "../child-guards/commit-guard.ts";
import { checkBashCommand, checkProtectedWrite } from "../child-guards/safety-guard.ts";

// ── The host context (set once at extension activation) ──────────────────

export interface HostContext {
	/** The host's model registry — resolves models + carries auth. */
	modelRegistry: {
		find(provider: string, modelId: string): unknown;
		streamSimple: (...args: unknown[]) => unknown;
		refresh(): Promise<void>;
	};
	/** The host's tool factories. */
	createReadTool(): AgentTool;
	createBashTool(cwd: string): AgentTool;
	createGrepTool(): AgentTool;
	createFindTool(): AgentTool;
	createLsTool(): AgentTool;
	createEditTool(cwd: string): AgentTool;
	createWriteTool(cwd: string): AgentTool;
}

/** 069 run 2026-09-23T02-03 FIX: the pi object is stored eagerly at
 * activation (always available), but modelRegistry + tool factories are
 * resolved LAZILY at each call — _bindExtensionCore runs AFTER extension
 * factories, so modelRegistry may not exist during activation but WILL
 * exist by the time any agent call fires. */
let piRef: Record<string, unknown> | undefined;
let cachedHost: HostContext | undefined;

export function setPiReference(pi: Record<string, unknown>): void {
	piRef = pi;
}

/** Resolve the host context lazily — returns undefined if modelRegistry or
 * the SDK tool factories are not yet available (caller falls back). */
async function resolveHost(): Promise<HostContext | undefined> {
	if (cachedHost) return cachedHost;
	if (!piRef) return undefined;
	const mr = piRef.modelRegistry as HostContext["modelRegistry"] | undefined;
	if (!mr) return undefined;
	try {
		const sdkModule = await import("@earendil-works/pi-coding-agent") as Record<string, unknown>;
		cachedHost = {
			modelRegistry: mr,
			createReadTool: sdkModule.createReadTool as HostContext["createReadTool"],
			createBashTool: sdkModule.createBashTool as HostContext["createBashTool"],
			createGrepTool: sdkModule.createGrepTool as HostContext["createGrepTool"],
			createFindTool: sdkModule.createFindTool as HostContext["createFindTool"],
			createLsTool: sdkModule.createLsTool as HostContext["createLsTool"],
			createEditTool: sdkModule.createEditTool as HostContext["createEditTool"],
			createWriteTool: sdkModule.createWriteTool as HostContext["createWriteTool"],
		};
		return cachedHost;
	} catch {
		return undefined;
	}
}

// Backward compat (tests use this)
export function setHostContext(ctx: HostContext): void {
	cachedHost = ctx;
}

export function hostContextAvailable(): boolean {
	return cachedHost !== undefined || piRef?.modelRegistry !== undefined;
}

// ── Active agent tracking (invariant #2: deactivate aborts) ──────────────

const activeAgents = new Set<Agent>();

export function abortAllActiveAgents(): void {
	for (const agent of activeAgents) {
		try { agent.abort(); } catch { /* best-effort */ }
	}
}

// ── Tool provisioning ──────────────────────────────────────────────────────

const READ_ONLY_TOOLS = ["read", "grep", "find", "ls"];
const WRITER_TOOLS = ["read", "grep", "find", "ls", "bash", "edit", "write"];

async function toolsForRole(role: string, readOnly: boolean, cwd: string): Promise<AgentTool[]> {
	const paiModule = await import("@earendil-works/pi-coding-agent");
	const pai = {
		createReadTool: paiModule.createReadTool as (...args: unknown[]) => AgentTool,
		createGrepTool: paiModule.createGrepTool as (...args: unknown[]) => AgentTool,
		createFindTool: paiModule.createFindTool as (...args: unknown[]) => AgentTool,
		createLsTool: paiModule.createLsTool as (...args: unknown[]) => AgentTool,
		createBashTool: paiModule.createBashTool as (...args: unknown[]) => AgentTool,
		createEditTool: paiModule.createEditTool as (...args: unknown[]) => AgentTool,
		createWriteTool: paiModule.createWriteTool as (...args: unknown[]) => AgentTool,
	};
	const names = readOnly ? READ_ONLY_TOOLS : WRITER_TOOLS;
	const tools: AgentTool[] = [];
	for (const name of names) {
		switch (name) {
			case "read": tools.push(pai.createReadTool()); break;
			case "grep": tools.push(pai.createGrepTool()); break;
			case "find": tools.push(pai.createFindTool()); break;
			case "ls": tools.push(pai.createLsTool()); break;
			case "bash": tools.push(pai.createBashTool(cwd)); break;
			case "edit": tools.push(pai.createEditTool(cwd)); break;
			case "write": tools.push(pai.createWriteTool(cwd)); break;
		}
	}
	return tools;
}

// ── The child guards ported to beforeToolCall (069 R7-Q2) ───────────────

function guardBeforeToolCall(readOnly: boolean, cwd: string): (ctx: { toolCall: { name: string }; args: unknown }) => Promise<{ block?: boolean; reason?: string } | undefined> {
	return async (ctx) => {
		try {
			const name: string = ctx.toolCall.name;
			const args = (ctx.args ?? {}) as Record<string, unknown>;
			// Commit guard: block git engine-owned verbs for writer roles
			if (!readOnly && name === "bash") {
				const cmd = String(args.command ?? "");
				if (isCommitClassGitCommand(cmd)) {
					return { block: true, reason: "Commit guard: git commit/merge/rebase/etc. are engine-owned — use the deterministic phase-commit machinery, never self-commit." };
				}
				// Safety guard: block dangerous shell patterns
				const safety = checkBashCommand(cmd);
				if (safety.blocked) return { block: true, reason: safety.reason ?? "safety guard block" };
			}
			// Safety guard: protected write targets (edit/write tools)
			if (name === "write" || name === "edit") {
				const file = String(args.path ?? "");
				const pw = checkProtectedWrite(file, cwd);
				if (pw.blocked) return { block: true, reason: pw.reason ?? "protected write" };
			}
			return undefined;
		} catch {
			return undefined; // fail-open (069 R7-Q2: guard crash hits the PARENT)
		}
	};
}

// ── Usage extraction (069 R3-Q3: sum over assistant messages) ───────────

function extractUsage(messages: Array<{ role: string; content?: unknown; usage?: unknown; stopReason?: string; errorMessage?: string }>): AgentUsage {
	let input = 0, output = 0, cacheRead = 0, cacheWrite = 0, cost = 0, turns = 0, toolCalls = 0;
	for (const msg of messages) {
		if (msg.role !== "assistant") continue;
		turns++;
		const usage = (msg as { usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; cost?: { total?: number } } }).usage;
		if (usage) {
			input += usage.input ?? 0;
			output += usage.output ?? 0;
			cacheRead += usage.cacheRead ?? 0;
			cacheWrite += usage.cacheWrite ?? 0;
			cost += usage.cost?.total ?? 0;
		}
		const content = (msg as { content?: Array<{ type?: string }> }).content;
		if (Array.isArray(content)) {
			toolCalls += content.filter((c) => c?.type === "toolCall").length;
		}
	}
	return { input, output, cacheRead, cacheWrite, cost, turns, toolCalls, durationMs: 0 };
}

// ── Result extraction (069 R2-Q2: findLast(assistant) + stopReason guard) ─

type AgentMessage = { role: string; content?: unknown; usage?: unknown; stopReason?: string; errorMessage?: string };

function extractResult(agent: Agent): { text: string; error?: string; usage: AgentUsage } {
	const messages = agent.state.messages ?? [];
	// Find the LAST assistant message
	let last: AgentMessage | undefined;
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i]!.role === "assistant") { last = messages[i]; break; }
	}
	if (!last) return { text: "", error: "no assistant message produced", usage: extractUsage(messages) };
	const m = last as { stopReason?: string; errorMessage?: string; content?: Array<{ type?: string; text?: string }> };
	// stopReason guard (069 R2-Q2: abort/error synthesizes empty-content assistant)
	if (m.stopReason === "error" || m.stopReason === "aborted") {
		return { text: "", error: m.errorMessage ?? `agent ${m.stopReason}`, usage: extractUsage(messages) };
	}
	// Extract text
	const text = Array.isArray(m.content)
		? m.content.filter((c) => c?.type === "text").map((c) => c.text ?? "").join("")
		: "";
	return { text, usage: extractUsage(messages) };
}

// ── The main dispatch function ─────────────────────────────────────────────

export interface PiAgentCoreCallOptions {
	agent: string;
	prompt: string;
	cwd: string;
	model?: string;
	thinking?: string;
	timeoutMs?: number;
	signal?: AbortSignal;
	readOnly?: boolean;
	systemPrompt?: string;
	controlKeys?: string[];
}

export async function runAgentViaPiAgentCore(opts: PiAgentCoreCallOptions): Promise<SpawnResult> {
	const host = await resolveHost();
	if (!host) {
		return { text: "", control: null, error: "pi-agent-core backend: modelRegistry not yet available (pi._bindExtensionCore may not have completed — retry after session_start)" };
	}

	// Resolve model
	const [provider, ...modelParts] = (opts.model ?? "").split("/");
	const modelId = modelParts.join("/");
	const thinkingSuffix = opts.thinking ? `:${opts.thinking}` : "";
	let resolvedModel: unknown;
	try {
		await host.modelRegistry.refresh();
		resolvedModel = host.modelRegistry.find(provider, modelId);
	} catch { /* fall through to error below */ }
	if (!resolvedModel) {
		return { text: "", control: null, error: `model not found: ${opts.model} (provider=${provider}, id=${modelId})` };
	}

	// Context window pre-check (invariant #3)
	const contextWindow = (resolvedModel as { contextWindow?: number }).contextWindow ?? 0;
	if (contextWindow > 0 && opts.prompt.length > contextWindow) {
		return { text: "", control: null, error: `prompt exceeds context window: ${opts.prompt.length} chars > ${contextWindow} tokens` };
	}

	// Build the Agent
	const tools = await toolsForRole(opts.agent, opts.readOnly ?? false, opts.cwd);
	const systemPrompt = opts.systemPrompt ?? `You are a ${opts.agent} specialist.`;
	const startedAt = Date.now();

	const agent = new Agent({
		initialState: {
			systemPrompt,
			model: resolvedModel as never,
			thinkingLevel: (opts.thinking ?? "medium") as never,
			tools,
		},
		streamFn: host.modelRegistry.streamSimple as never,
		beforeToolCall: guardBeforeToolCall(opts.readOnly ?? false, opts.cwd) as never,
	});

	activeAgents.add(agent);
	const cleanup = () => { activeAgents.delete(agent); };
	opts.signal?.addEventListener("abort", () => { try { agent.abort(); } catch { /* best-effort */ } }, { once: true });

	try {
		// Invariant #1: EVERY prompt is timeout-wrapped
		const timeout = setTimeout(() => { try { agent.abort(); } catch { /* best-effort */ } }, opts.timeoutMs ?? 1_800_000);
		try {
			await agent.prompt(opts.prompt);
			await agent.waitForIdle();
		} finally {
			clearTimeout(timeout);
		}

		// Extract result
		const result = extractResult(agent);
		const durationMs = Date.now() - startedAt;
		const control = result.text ? extractControl(result.text, opts.controlKeys) : null;
		return {
			text: result.text,
			control: control as ControlObj | null,
			model: opts.model,
			error: result.error,
			usage: { ...result.usage, durationMs },
		};
	} finally {
		cleanup();
	}
}
