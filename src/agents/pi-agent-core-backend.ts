/**
 * 069/070 — the pi-agent-core direct backend, createAgentSession shape
 * (spec 070 §11.3, R7-F3 option (a) — implemented after the 8-round grill).
 *
 * One-shot session per specialist call:
 *  - systemPrompt = the role's base prompt (loadAgentBasePrompt — the single
 *    source of truth, R4-F1) + the curated skill-card list (R5-F4), composed
 *    by DefaultResourceLoader with the worktree's context files (R6-F2)
 *  - model = string-resolved, else the INHERITED session model OBJECT
 *    (R5-F2 — object-first after string resolution; the SCENARIO-001
 *    bare-id re-resolution trap is avoided by never stringifying it)
 *  - thinkingLevel = per-call tier, else inherited session tier; the session
 *    clamps it to model capabilities itself (CreateAgentSessionOptions doc,
 *    R4-F2)
 *  - tools = the session's built-ins + extension tools; read-only posture is
 *    excludeTools ["bash","edit","write"] driven by the per-call accessMode
 *    (R5-F1) — exclusions keep extension tools intact (R8-F1)
 *  - guards = the commit/safety guard EXTENSIONS ride
 *    additionalExtensionPaths — the same delivery channel the delegation
 *    registration used (subagentOnlyExtensions)
 *  - timeout = per-call, else the role-tier default (defaultAgentTimeoutMs,
 *    R5-F3) — the timeout aborts the session and the run settles
 *  - the session's automatic retries (provider + turn layers) ride
 *    createAgentSession (R6-F1); our workflow transient-retry stays the
 *    outermost layer
 *  - tool telemetry rides tool_execution_start events → onToolUse (R5-F6);
 *    the tool budget is a hard cap enforced by abort (R5-F5 — the soft
 *    nudge is documented future work)
 *  - the returned control is validated (missing keys + schema violations)
 *    with ONE corrective attempt, mirroring the delegation corrective check
 *    (R5-F7)
 *
 * Adapter invariants (P4 mechanical):
 *  1. EVERY prompt() is timeout-wrapped (setTimeout → session.abort())
 *  2. session_shutdown aborts all active sessions (abortAllActiveAgents)
 *  3. contextWindow pre-checked before prompt
 *  4. the shared-signal abort listener is REMOVED in the finally (R4-F3 —
 *     the A-05/sleepMs listener-hygiene precedent)
 *
 * Returns the same SpawnResult contract the delegation backend satisfied.
 */

import { join } from "node:path";
import { homedir } from "node:os";
import type { SpawnResult, AgentUsage, ControlObj } from "../types.ts";
import { extractControl, missingControlKeys, DEFAULT_EMPTY_ARRAY_OK } from "../control.ts";
import { loadAgentBasePrompt } from "../agents.ts";
import { defaultAgentTimeoutMs, extensionsForAgent, configExtensionEntriesForAgent, commitGuardExtensionPath, safetyGuardExtensionPath, resolveToolBudget } from "./agent-runtime/index.ts";
import { schemaViolationErrors } from "./structured-output.ts";
import { stripMalformedResolutionRows } from "../convergence-economy/finding-resolution-gate.ts";

// ── Shared services (spec 070 §12.3: reusable across createAgentSession) ──
// ModelRuntime + SettingsManager are the expensive boundaries (auth/models
// reads, settings merge); both are documented reusable across sessions. The
// resource loader is per-call (its options carry the per-role system prompt).

interface ResolvedRuntime {
	getModel(provider: string, modelId: string): unknown;
}

/** The host SDK surface this adapter consumes (resolved once, host-copied). */
interface PiCodingAgentModule {
	ModelRuntime: { create(): Promise<unknown> };
	createAgentSession(options: Record<string, unknown>): Promise<{ session: ActiveSession }>;
	SessionManager: { inMemory(cwd?: string): unknown };
	DefaultResourceLoader: new (options: Record<string, unknown>) => { reload(): Promise<void> };
	SettingsManager?: { create(cwd: string, agentDir: string): unknown };
}

/** The per-call session surface (AgentSession — abort/dispose/prompt/messages). */
interface ActiveSession {
	prompt(text: string): Promise<void>;
	abort(): Promise<void>;
	dispose(): void;
	subscribe(listener: (event: Record<string, unknown>) => void): () => void;
	readonly messages: Array<{ role: string; content?: unknown; usage?: unknown; stopReason?: string; errorMessage?: string }>;
}

function agentDir(): string {
	return join(homedir(), ".pi", "agent");
}

interface SharedServices {
	runtime: ResolvedRuntime;
	settingsManager: unknown;
	pai: PiCodingAgentModule;
}

let cachedServices: Promise<SharedServices | undefined> | undefined;

async function getServices(): Promise<SharedServices | undefined> {
	if (!cachedServices) {
		cachedServices = (async (): Promise<SharedServices | undefined> => {
			try {
				const pai = await import("@earendil-works/pi-coding-agent") as unknown as PiCodingAgentModule;
				const runtime = await pai.ModelRuntime.create() as ResolvedRuntime;
				const settingsManager = pai.SettingsManager
					? await pai.SettingsManager.create(process.cwd(), agentDir())
					: undefined;
				return { runtime, settingsManager, pai };
			} catch {
				return undefined;
			}
		})();
	}
	return cachedServices;
}

/** Test hook: pre-populate the shared services (ModelRuntime.create is lazy). */
export function setRuntimeForTests(rt: ResolvedRuntime, pai?: PiCodingAgentModule): void {
	cachedServices = Promise.resolve({
		runtime: rt,
		settingsManager: undefined,
		pai: pai ?? (undefined as unknown as PiCodingAgentModule),
	});
}

// ── Active session tracking (invariant #2) ──────────────────────────────────

const activeSessions = new Set<ActiveSession>();

export function abortAllActiveAgents(): void {
	for (const session of activeSessions) {
		try { void session.abort(); } catch { /* best-effort */ }
		try { session.dispose(); } catch { /* best-effort */ }
	}
}

// ── System prompt assembly (R4-F1 role body + R5-F4 skill cards) ───────────

function skillCardSection(skill: string[] | undefined): string {
	if (!skill || skill.length === 0) return "";
	const lines = skill.map((name) => `- ${name}: read ${name}/SKILL.md under ~/.pi/agent/skills/, .pi/skills/, or .agents/skills/ before relying on it`);
	return `\n\n## Skills available to you\n\nRead a skill's SKILL.md with the read tool BEFORE relying on it — never guess a skill's steps.\n${lines.join("\n")}\n`;
}

function buildSystemPrompt(agent: string, skill: false | string[] | undefined): string {
	const base = loadAgentBasePrompt(agent);
	const body = base && base.length > 0 ? base : `You are a ${agent} specialist.`;
	return `${body}${skillCardSection(skill === false ? undefined : skill)}`;
}

// ── Usage extraction (sum over assistant messages — R6-verified shapes) ─────

function extractUsage(messages: ActiveSession["messages"]): AgentUsage {
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

// ── Result extraction (findLast assistant + stopReason/empty-text guards) ──

function extractResult(messages: ActiveSession["messages"]): { text: string; error?: string; usage: AgentUsage } {
	let last: ActiveSession["messages"][number] | undefined;
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i]!.role === "assistant") { last = messages[i]!; break; }
	}
	const usage = extractUsage(messages);
	if (!last) return { text: "", error: "no assistant message produced", usage };
	const m = last as { stopReason?: string; errorMessage?: string; content?: Array<{ type?: string; text?: string }> };
	if (m.stopReason === "error" || m.stopReason === "aborted") {
		return { text: "", error: m.errorMessage ?? `agent ${m.stopReason}`, usage };
	}
	const text = Array.isArray(m.content)
		? m.content.filter((c) => c?.type === "text").map((c) => c.text ?? "").join("")
		: "";
	// R4-F4: a stop with zero text is a named failure, never a silent success
	if (text.trim().length === 0) {
		return { text: "", error: `empty assistant response (stopReason=${m.stopReason ?? "unknown"})`, usage };
	}
	return { text, usage };
}

// ── The main dispatch function ──────────────────────────────────────────────

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
	/** R5-F2: the inherited live session model OBJECT — used directly when
	 * string resolution comes up empty (never re-resolved as provider/id). */
	inheritedModel?: unknown;
	/** R5-F2 sub-note: the inherited session thinking tier. */
	inheritedThinking?: string;
	/** R5-F4: false = zero cards; string[] = that curated set only; undefined
	 * = ambient discovery left on. */
	skill?: false | string[];
	/** R5-F7: keys whose empty-array values count as present. */
	allowEmptyArraysFor?: string[];
	/** R5-F7: the call's TypeBox schema for control validation. */
	schema?: unknown;
	/** R5-F6: per-tool-call telemetry (tool name + argument head). */
	onToolUse?: (tool: string, argHead: string) => void;
	/** R5-F5: per-call budget override; the registration-level default is
	 * resolved here when absent. */
	toolBudget?: { soft: number; hard: number; block: string[] };
}

function argHeadOf(args: unknown): string {
	if (args && typeof args === "object") {
		const a = args as Record<string, unknown>;
		for (const key of ["path", "command", "pattern", "query", "url", "file"]) {
			if (typeof a[key] === "string") return String(a[key]).slice(0, 60);
		}
	}
	return "";
}

function sumUsage(a: AgentUsage, b: AgentUsage): AgentUsage {
	return {
		input: (a.input ?? 0) + (b.input ?? 0),
		output: (a.output ?? 0) + (b.output ?? 0),
		cacheRead: (a.cacheRead ?? 0) + (b.cacheRead ?? 0),
		cacheWrite: (a.cacheWrite ?? 0) + (b.cacheWrite ?? 0),
		cost: (a.cost ?? 0) + (b.cost ?? 0),
		turns: (a.turns ?? 0) + (b.turns ?? 0),
		toolCalls: (a.toolCalls ?? 0) + (b.toolCalls ?? 0),
		durationMs: (a.durationMs ?? 0) + (b.durationMs ?? 0),
	};
}

export async function runAgentViaPiAgentCore(opts: PiAgentCoreCallOptions): Promise<SpawnResult> {
	const services = await getServices();
	if (!services) {
		return { text: "", control: null, error: "pi-agent-core backend: ModelRuntime.create() failed — check ~/.pi/agent/auth.json and models.json" };
	}

	// Model resolution (R5-F2): string first, inherited OBJECT as the fallback.
	const [provider, ...modelParts] = (opts.model ?? "").split("/");
	const modelId = modelParts.join("/");
	let resolvedModel: unknown;
	if (provider && modelId) {
		try { resolvedModel = services.runtime.getModel(provider, modelId); } catch { /* fall through */ }
	}
	if (!resolvedModel && opts.inheritedModel) resolvedModel = opts.inheritedModel;
	if (!resolvedModel) {
		return { text: "", control: null, error: `model not found: ${opts.model || "(inherited session model unavailable)"} (provider=${provider || "?"}, id=${modelId || "?"})` };
	}

	// Context window pre-check (invariant #3)
	const contextWindow = (resolvedModel as { contextWindow?: number }).contextWindow ?? 0;
	if (contextWindow > 0 && opts.prompt.length > contextWindow) {
		return { text: "", control: null, error: `prompt exceeds context window: ${opts.prompt.length} chars > ${contextWindow} tokens` };
	}

	// R5-F5: budget resolution (per-call override > registration default).
	const budget = opts.toolBudget ?? resolveToolBudget(opts.agent);
	let toolExecutions = 0;
	let budgetExceeded = false;
	let budgetHardCap = 0;

	const pai = services.pai;
	if (!pai?.createAgentSession || !pai.SessionManager || !pai.DefaultResourceLoader) {
		return { text: "", control: null, error: "pi-agent-core backend: host SDK surface incomplete (createAgentSession/SessionManager/DefaultResourceLoader)" };
	}

	// Guards + capability extensions ride the loader (R8-F1 + the guard
	// delivery channel the delegation registration used).
	const guardPaths: string[] = [];
	const commitGuard = commitGuardExtensionPath(opts.agent);
	if (commitGuard) guardPaths.push(commitGuard);
	const safetyGuard = safetyGuardExtensionPath(opts.agent);
	if (safetyGuard) guardPaths.push(safetyGuard);
	const configEntries = configExtensionEntriesForAgent(opts.agent);
	const roleExtensions = extensionsForAgent(opts.agent);

	const loader = new pai.DefaultResourceLoader({
		cwd: opts.cwd,
		agentDir: agentDir(),
		...(services.settingsManager ? { settingsManager: services.settingsManager } : {}),
		additionalExtensionPaths: [...guardPaths, ...configEntries, ...roleExtensions],
		noPromptTemplates: true,
		noThemes: true,
		// R5-F4: false = zero cards (suppress discovery); a curated list is
		// injected prompt-side; undefined keeps ambient discovery.
		...(opts.skill === false ? { noSkills: true } : {}),
		systemPrompt: opts.systemPrompt ?? buildSystemPrompt(opts.agent, opts.skill),
	});
	await loader.reload();

	const { session } = await pai.createAgentSession({
		cwd: opts.cwd,
		agentDir: agentDir(),
		...(services.settingsManager ? { settingsManager: services.settingsManager } : {}),
		modelRuntime: services.runtime,
		resourceLoader: loader,
		sessionManager: pai.SessionManager.inMemory(opts.cwd),
		model: resolvedModel,
		thinkingLevel: (opts.thinking ?? opts.inheritedThinking ?? "medium"),
		// R5-F1: posture by exclusion — read-only keeps extension tools.
		...(opts.readOnly ? { excludeTools: ["bash", "edit", "write"] } : {}),
	});
	activeSessions.add(session);

	// R5-F6 telemetry + R5-F5 hard budget cap ride the event stream.
	const unsubscribe = session.subscribe((event) => {
			if (event.type === "tool_execution_start") {
				toolExecutions++;
				opts.onToolUse?.(String(event.toolName ?? ""), argHeadOf(event.args));
				if (budget && toolExecutions > budget.hard) {
					budgetHardCap = budget.hard;
					budgetExceeded = true;
				}
			}
	});

	// Invariant #1 + R5-F3: timeout = per-call, else the role tier.
	const timeoutMs = opts.timeoutMs ?? defaultAgentTimeoutMs(opts.agent);
	let timer: ReturnType<typeof setTimeout> | undefined;
	const onAbort = () => { try { void session.abort(); } catch { /* best-effort */ } };
	opts.signal?.addEventListener("abort", onAbort, { once: true });
	const startedAt = Date.now();
	try {
		timer = setTimeout(() => { try { void session.abort(); } catch { /* best-effort */ } }, timeoutMs);
		await session.prompt(opts.prompt);
	} finally {
		if (timer) clearTimeout(timer);
		// R4-F3: listener hygiene on the SHARED run signal (A-05 precedent).
		opts.signal?.removeEventListener("abort", onAbort);
		unsubscribe();
	}

	const result = extractResult(session.messages);
	const usage = { ...result.usage, durationMs: Date.now() - startedAt };
	if (budgetExceeded && !result.error) {
		session.dispose();
		activeSessions.delete(session);
		return { text: result.text, control: null, model: opts.model, usage, error: `tool budget exceeded: ${toolExecutions} executions > hard cap ${budgetHardCap}` };
	}
	if (result.error) {
		session.dispose();
		activeSessions.delete(session);
		return { text: result.text, control: null, model: opts.model, usage, error: result.error };
	}

	// R5-F7: control validation + ONE corrective attempt (the delegation
	// corrective-check parity — missing keys and schema violations are
	// named to the model, not bounced through the stage gate).
	const control = extractControl(result.text, opts.controlKeys) as Record<string, unknown> | null;
	const emptyArrayOk = new Set([...DEFAULT_EMPTY_ARRAY_OK, ...(opts.allowEmptyArraysFor ?? [])]);
	const missing = opts.controlKeys && opts.controlKeys.length > 0 && control != null
		? missingControlKeys(control, opts.controlKeys, { allowEmptyArraysFor: emptyArrayOk })
		: (control == null && opts.controlKeys && opts.controlKeys.length > 0 ? [...opts.controlKeys] : []);
	const controlNorm = control != null && typeof control === "object" ? stripMalformedResolutionRows(control) : control;
	const violations = controlNorm != null && opts.schema != null ? schemaViolationErrors(opts.schema, controlNorm) : [];

	if (missing.length === 0 && violations.length === 0) {
		session.dispose();
		activeSessions.delete(session);
		return { text: result.text, control: controlNorm as ControlObj | null, model: opts.model, usage };
	}
	const corrective = await correctiveAttempt(session, opts, result.text, missing, violations);
	const finalUsage = sumUsage(usage, corrective.usage);
	const outcome: SpawnResult = corrective.error || corrective.control == null
		? { text: corrective.text || result.text, control: null, model: opts.model, usage: finalUsage, error: `control validation failed (missing: ${missing.join(", ") || "—"}; violations: ${violations.length})${corrective.error ? `; corrective attempt: ${corrective.error}` : ""}` }
		: { text: corrective.text, control: corrective.control, model: opts.model, usage: finalUsage };
	session.dispose();
	activeSessions.delete(session);
	return outcome;
}

/** One corrective attempt on the SAME session (validate → repair). */
async function correctiveAttempt(
	session: ActiveSession,
	opts: PiAgentCoreCallOptions,
	originalText: string,
	missing: string[],
	violations: string[],
): Promise<{ text: string; control: ControlObj | null; error?: string; usage: AgentUsage }> {
	const task = `${opts.prompt}\n\n--- CORRECTIVE REQUEST ---\nYour previous response's <control> block was invalid.\nMissing keys: ${missing.join(", ") || "—"}.\nSchema violations: ${violations.slice(0, 5).join(" | ") || "—"}.\nRe-emit the COMPLETE final answer with a corrected <control> JSON block containing every required key.\nPrevious response (for reference, do not repeat its error):\n${originalText.slice(0, 4000)}`;
	try {
		await session.prompt(task);
	} catch (err) {
		return { text: "", control: null, error: `corrective prompt failed: ${String((err as Error)?.message ?? err)}`, usage: extractUsage(session.messages) };
	}
	const result = extractResult(session.messages);
	if (result.error) return { text: "", control: null, error: result.error, usage: result.usage };
	const control = extractControl(result.text, opts.controlKeys) as ControlObj | null;
	return { text: result.text, control, usage: result.usage };
}
