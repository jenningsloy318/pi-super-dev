/**
 * The workflow runner. Builds a `StageContext` and evaluates the workflow's
 * root node: `await workflow.root.run(state, ctx)`. All control logic lives in
 * the node algebra (`nodes.ts`); this file only wires execution primitives.
 *
 *   ctx.agent()    — spawn a specialist `pi` subprocess (pi-spawn.ts)
 *   ctx.helper()   — run a deterministic pure helper (helpers.ts)
 *   ctx.parallel() — run agent calls with a concurrency cap
 *   ctx.budget()   — cap total agent spawns
 *   ctx.events     — EventEmitter for stage/phase progress events
 *                  (human-in-loop aborts live on ctx.signal, the run's
 *                  AbortSignal; the dead WCP16 event-wait node was deleted
 *                  in spec 28 T7.3 / SD-07)
 */

import { EventEmitter } from "node:events";
import { languageDirective, superDevEnv } from "./render/super-dev-dir.ts";
import { AsyncLocalStorage } from "node:async_hooks";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { splitModelThinking } from "./agents/agent-runtime.ts";
import { buildRunMetricsRow, appendRunMetrics, checkSigmaBands } from "./evolution/sigma-bands.ts";
import { checkPredictionsFromLedger } from "./evolution/predictions.ts";
export { buildRunMetricsRow, appendRunMetrics, type RunMetricsRow } from "./evolution/sigma-bands.ts";
import { runAgentViaDelegation, isDelegationRuntimeExtensionFailure, delegationBackendDegraded, markDelegationBackendDegraded, delegationAgentName } from "./agents/delegation-backend.ts";
import { fleetBegin, fleetFinish, fleetUpdate, resolveExternalRunsModule } from "./agents/fleet-visibility.ts";

import { delegationOwnerPresent } from "./agents/register-agents.ts";
import { runHelper } from "./helpers.ts";
import { toBool } from "./doc-validators.ts";
import { createMemoizingAgent, loadResumeCache, clearResumeCache, specDirFor, findResumableSpec } from "./resume.ts";
import { drainControlDrift, extractControlKeys } from "./control.ts";
import { knowledgeForAgent } from "./render/knowledge.ts";
import { appendUserNotes, userNotesForAgent } from "./render/user-notes.ts";
import { getConfig } from "./render/super-dev-dir.ts";
import { getActiveTracker } from "./tracking.ts";
import { WORKFLOW_ATTEMPTS } from "./retry-policy.ts";
import { getRetryFeedback, renderRetryFeedbackBlock } from "./retry-feedback.ts";
import { currentStepScope } from "./step-scope.ts";
import { appendRunEvent, runStartedEvent, readRunEvents, reconstructStageOutcomes, type RunEventInput } from "./runlog.ts";
import { auditAppend } from "./render/super-dev-dir.ts";
import { writeCompletionAudit } from "./completion-audit.ts";
import { validateTeamReadiness } from "./team/raci.ts";
import { recordInstruction } from "./team/messages.ts";
import { SUPER_DEV_EXTENSION_VERSION } from "./version.ts";
import { isNonRetryableAgentError } from "./agent-errors.ts";
import { convergenceRetryFeedback, normalizeConvergenceStage } from "./convergence-ledger.ts";
import type {

	AgentCall,
	AgentResult,
	Budget,
	HelperCall,
	HelperResult,
	PipelineState,
	BoundaryQuarantinePayload,
	RunOptions,
	RunStatus,
	RunSummary,
	SpawnResult, UsageAccumulator, AgentUsage,
	StageContext,
	StageProgressEvent,
	Workflow,
} from "./types.ts";

/** v0.3.35: prepended to EVERY delegation prompt — see realAgent. */
export const DELEGATION_AUTONOMY_CLAUSE = "## Autonomy (hard constraint)\nYou run AUTONOMOUSLY — there is no human and no supervisor watching, and nobody will answer a question. NEVER call intercom, subagent_supervisor, or subagent_wait, and never wait for a reply. If you are blocked or missing information, complete everything you CAN and state the blocker plainly in your final structured output.";

/** v0.3.55 security review F1: single source of the quarantine payload. The
 *  structured payload is the ONLY trusted channel — it rides on the thrown
 *  Error as a process-local property (composed in the parent from git-status
 *  output). This string is DISPLAY-ONLY: it appears in logs and error text,
 *  both of which are attacker-influenceable channels (a misbehaving agent can
 *  echo arbitrary text to stderr and land it in review.error), so no parser
 *  may ever turn it back into restore pathspecs. */
export function formatBoundaryQuarantineError(violations: string[], quarantineDir: string): string {
	return `source-read-only boundary violation (quarantined, not restored — concurrent writer): paths=${JSON.stringify(violations)} dir=${JSON.stringify(quarantineDir)}`;
}

/** v0.3.55 security review F1: the structured payload factory. Tests and the
 *  throw site build payloads through THIS function so the producer shape is
 *  pinned in one place. */
export function boundaryQuarantinePayload(violations: string[], quarantineDir: string): BoundaryQuarantinePayload {
	return { violations: [...violations], dir: quarantineDir };
}

/** v0.3.55 security review F5: quarantine dirs accumulate per violating
 *  delegation and their byte copies are only needed while a run is live.
 *  Before creating a new dir, best-effort sweep stale siblings (>24h old).
 *  Never throws — GC failure must not break enforcement. */
/** v0.3.56 F9f: exported for the L5 quarantine test lane (fresh dirs survive,
 *  >24h dirs swept, planted symlinks skipped). */
export function sweepStaleQuarantineDirs(): void {
	try {
		for (const entry of readdirSync(tmpdir())) {
			if (!entry.startsWith("sd-boundary-")) continue;
			const full = join(tmpdir(), entry);
			try {
				// v0.3.57 review P3: lstat (not stat) — statSync follows a planted
				// symlink for the mtime read. rmSync (no recursive deref of the
				// link target beyond the entry itself) removes the link, never
				// the target — that safety property is unchanged.
				if (Date.now() - lstatSync(full).mtimeMs > 24 * 3_600_000) rmSync(full, { recursive: true, force: true });
			} catch { /* a dir created by another process — skip */ }
		}
	} catch { /* best-effort */ }
}

const DEFAULT_MAX_AGENTS = 200;
const DEFAULT_MAX_CONCURRENCY = 3;

interface PathFingerprint {
	status: string;
	exists: boolean;
	kind: "file" | "dir" | "other" | "missing";
	hash?: string;
}

interface SourceBoundarySnapshot {
	ok: boolean;
	fingerprints: Map<string, PathFingerprint>;
	allowedRoots: string[];
	error?: string;
}

function normalizeRelPath(path: string): string {
	return path.replace(/\\/g, "/").replace(/^\.\//, "");
}

function isInsidePath(child: string, parent: string): boolean {
	const rel = relative(parent, child);
	return rel === "" || (!!rel && !rel.startsWith("..") && !isAbsolute(rel));
}

function allowedSourceReadOnlyRoots(cwd: string, specDirectory?: string): string[] {
	const roots: string[] = [];
	if (specDirectory) {
		const abs = resolve(specDirectory);
		if (isInsidePath(abs, resolve(cwd))) roots.push(abs);
	}
	return roots;
}

function isAllowedSourceReadOnlyPath(cwd: string, allowedRoots: string[], relPath: string): boolean {
	const abs = resolve(cwd, relPath);
	return allowedRoots.some((root) => abs === root || abs.startsWith(`${root}${sep}`));
}

function gitStatusEntries(cwd: string): { entries: Map<string, string>; error?: string } {
	const r = spawnSync("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], { cwd, encoding: "utf8" });
	if (r.error) return { entries: new Map(), error: r.error.message };
	if (r.status !== 0) return { entries: new Map(), error: (r.stderr || r.stdout || `git status exited ${r.status}`).trim() };
	const entries = new Map<string, string>();
	const parts = r.stdout.split("\0").filter(Boolean);
	for (let i = 0; i < parts.length; i++) {
		const rec = parts[i];
		if (rec.length < 4) continue;
		const status = rec.slice(0, 2);
		const path = normalizeRelPath(rec.slice(3));
		entries.set(path, status);
		if ((status[0] === "R" || status[0] === "C") && i + 1 < parts.length) {
			entries.set(normalizeRelPath(parts[++i]), status);
		}
	}
	return { entries };
}

function fingerprintPath(cwd: string, relPath: string, status: string): PathFingerprint {
	const abs = resolve(cwd, relPath);
	try {
		if (!existsSync(abs)) return { status, exists: false, kind: "missing" };
		const st = lstatSync(abs);
		if (st.isDirectory()) return { status, exists: true, kind: "dir" };
		if (!st.isFile() && !st.isSymbolicLink()) return { status, exists: true, kind: "other" };
		const hash = createHash("sha256").update(readFileSync(abs)).digest("hex");
		return { status, exists: true, kind: "file", hash };
	} catch {
		return { status, exists: existsSync(abs), kind: "other" };
	}
}

function captureSourceBoundary(cwd: string, specDirectory?: string): SourceBoundarySnapshot {
	const allowedRoots = allowedSourceReadOnlyRoots(cwd, specDirectory);
	const { entries, error } = gitStatusEntries(cwd);
	if (error) return { ok: false, fingerprints: new Map(), allowedRoots, error };
	const fingerprints = new Map<string, PathFingerprint>();
	for (const [relPath, status] of entries) {
		if (isAllowedSourceReadOnlyPath(cwd, allowedRoots, relPath)) continue;
		fingerprints.set(relPath, fingerprintPath(cwd, relPath, status));
	}
	return { ok: true, fingerprints, allowedRoots };
}

function sameFingerprint(a: PathFingerprint | undefined, b: PathFingerprint | undefined): boolean {
	return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

function sourceBoundaryViolations(before: SourceBoundarySnapshot, after: SourceBoundarySnapshot): string[] {
	const paths = new Set([...before.fingerprints.keys(), ...after.fingerprints.keys()]);
	return [...paths].filter((path) => !sameFingerprint(before.fingerprints.get(path), after.fingerprints.get(path))).sort();
}

/** v0.3.56 F9f: exported (seam) so tests can drive the quarantine path
 *  directly — captureSourceBoundary/restoreNewSourceViolations are the
 *  source-read-only enforcement pair; tests pin the :(literal) guard and the
 *  symlink skip here. */
export function restoreNewSourceViolations(cwd: string, before: SourceBoundarySnapshot, after: SourceBoundarySnapshot, paths: string[], quarantineDir: string | null, mode: "restore" | "quarantine" = "restore"): { restored: string[]; manual: string[]; quarantined: string[] } {
	const restored: string[] = [];
	const manual: string[] = [];
	const quarantined: string[] = [];
	for (const relPath of paths) {
		// v0.3.54: quarantine the violating content BEFORE any mutation so the
		// evidence survives every downstream branch (P10 — honest evidence trail).
		if (quarantineDir) {
			try {
				const abs0 = resolve(cwd, relPath);
				// v0.3.55 security review F5: lstat (not stat) — a planted symlink
				// must not pull its TARGET's bytes into the quarantine dir; the
				// link itself stays in the worktree as evidence (quarantine mode
				// mutates nothing).
				const st = lstatSync(abs0);
				if (st.isFile()) {
					const safeName = relPath.replace(/[^A-Za-z0-9._-]+/g, "_").slice(-120) || "file";
					// v0.3.55 security review F5: 0o700 — same-uid agents had worktree
					// read access anyway; other local users need none.
					mkdirSync(quarantineDir, { recursive: true, mode: 0o700 });
					const dest = join(quarantineDir, `${quarantined.length}-${safeName}`);
					copyFileSync(abs0, dest);
					// v0.3.57 review: re-lstat NARROWS the lstat→copy TOCTOU — it
					// cannot close one (a swap between copy and re-check, or a
					// delete, still races). The re-check therefore runs in its own
					// try/catch: ANY failure drops the copy, so the source being
					// deleted mid-race can never strand an orphaned copy with no
					// quarantined[] evidence row (integrity over availability).
					try {
						if (lstatSync(abs0).isFile()) {
							quarantined.push(relPath);
						} else {
							try { rmSync(dest, { force: true }); } catch { /* best-effort */ }
						}
					} catch {
						try { rmSync(dest, { force: true }); } catch { /* best-effort */ }
					}
				}
			} catch { /* quarantine is best-effort; enforcement continues */ }
		}
		if (mode === "quarantine") continue; // v0.3.54: preserve bytes, change nothing
		if (before.fingerprints.has(relPath)) {
			manual.push(relPath);
			continue;
		}
		const fp = after.fingerprints.get(relPath);
		if (!fp) continue;
		const abs = resolve(cwd, relPath);
		if (!isInsidePath(abs, resolve(cwd))) {
			manual.push(relPath);
			continue;
		}
		try {
			if (fp.status === "??") {
				rmSync(abs, { recursive: true, force: true });
				restored.push(relPath);
				continue;
			}
			// v0.3.55 security review F2: `--` ends option parsing but NOT pathspec
			// magic — a file literally named `:(top)*` widens this restore to a
			// worktree-wide revert. Same `:(literal)` guard fault-classification.ts
			// already applies to stash pathspecs.
			const literal = `:(literal)${relPath}`;
			let r = spawnSync("git", ["restore", "--staged", "--worktree", "--", literal], { cwd, encoding: "utf8" });
			if (r.status !== 0) r = spawnSync("git", ["checkout", "--", literal], { cwd, encoding: "utf8" });
			if (r.status === 0) restored.push(relPath);
			else manual.push(relPath);
		} catch {
			manual.push(relPath);
		}
	}
	return { restored, manual, quarantined };
}

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

/** Signal-aware sleep (local — workflow.ts doesn't import nodes' sleep).
 *  Exported (additive) for the A-05 listener-count pinning test. */
export function sleepMs(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		if (signal?.aborted) return resolve();
		const onAbort = () => { clearTimeout(t); finish(); };
		// A-05 (NFR-6): remove the once-listener on NORMAL resolution too — the
		// transient-retry backoff cadence otherwise accumulates retained closures
		// on the ONE shared run AbortSignal (MaxListenersExceededWarning noise).
		const finish = () => { signal?.removeEventListener("abort", onAbort); resolve(); };
		const t = setTimeout(finish, ms);
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

/** Transient (retryable) agent errors: rate limits, overload, 5xx, connection
 *  resets. Retried with backoff INSIDE one agent call — not counted as a fresh
 *  gate attempt (which burned the budget when a model 429'd on every attempt). */
const TRANSIENT_RE = /\b(429|rate.?limit|overload|too many requests|service unavailable|503|502|520|521|522|524|ECONNRESET|ETIMEDOUT|socket hang up)\b/i;
/** v0.3.26: pi-subagents' executor answers unresolvable agent names with
 *  "Unknown agent: <name>". That error is a registration gap, never a task
 *  failure — realAgent surfaces it as the call's error with the re-register
 *  remedy named (no fallback backend since v0.3.64). */
const UNKNOWN_AGENT_ERROR_RE = /unknown agent/i;

/** v0.3.64: actionable per-call error when no pi-subagents owner is in the
 *  process (hard requirement — no fallback backend). */
const DELEGATION_OWNER_ABSENT_ERROR = "pi-subagents is not active in this session (no delegation owner answered the registration handshake). Install the pi-subagents pi package (pi install npm:pi-subagents) and restart pi — super-dev v0.3.64+ requires it.";
/** v0.3.64: actionable per-call error for the sticky version-skew class. */
const DELEGATION_VERSION_SKEW_ERROR = "pi-subagents version skew: the package changed under this live pi session (pi update mid-session), so delegated children die at startup. Restart pi so the in-memory backend matches the on-disk package, then re-run.";
function isTransientAgentError(error?: string): boolean {
	return !!error && TRANSIENT_RE.test(error);
}

/** Transient-retry backoff schedule (ms). Read LAZILY so tests can set
 *  SUPER_DEV_TRANSIENT_RETRY_MS before invoking. Default: four retries
 *  (5 total tries) at 2s, 4s, 8s, 16s. */
function transientRetryMs(): number[] {
	const defaultDelays = Array.from({ length: Math.max(0, WORKFLOW_ATTEMPTS - 1) }, (_, i) => 2000 * (2 ** i)).join(",");
	return (superDevEnv("SUPER_DEV_TRANSIENT_RETRY_MS") ?? defaultDelays)
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
		if (isNonRetryableAgentError(last.error)) return last;
		if (!isTransientAgentError(last.error)) return last;
		if (attempt >= delays.length) return last; // exhausted -> surface the transient error
		const delay = delays[attempt];
		log(`agent transient error (429/overload) — retrying in ${delay}ms (attempt ${attempt + 1}/${delays.length}): ${last.error}`);
		await sleepMs(delay, signal);
		if (signal?.aborted) return last;
	}
}

/** Resolve the model for a specific agent call under precedence A (cross-model
 *  policy in config wins over a one-off global --model):
 *    call.model  →  agentModels[call.agent]  →  globalModel  →  undefined.
 *  `undefined` means "no explicit model" — the backends then fall back to the
 *  inherited main-session model, preserving the no-default rule. Pure + exported
 *  for unit tests.
 *  v0.3.45: every tier strips a trailing `:level` thinking suffix — the request
 *  must carry the BARE model id (session/subprocess build argv from it; only
 *  pi-subagents' own display combines model+thinking). The suffix's meaning is
 *  applied separately: config.agentModels suffixes feed resolveThinking, and a
 *  per-call suffix feeds the call's perCall thinking in realAgent. */
export function resolveAgentModel(
	call: { agent: string; model?: string },
	agentModels: Record<string, string>,
	globalModel?: string,
): string | undefined {
	const perCall = splitModelThinking(call.model).model;
	if (perCall) return perCall;
	const byRole = splitModelThinking(agentModels[call.agent]).model;
	if (byRole) return byRole;
	return splitModelThinking(globalModel).model || undefined;
}

/** P1.3: the run's ledger id, read at event time (runWorkflow sets __runId
 *  right after makeContext; agents only ever spawn after setup, so it exists). */
const ledgerRunId = (state: PipelineState): string => String((state as Record<string, unknown>).__runId ?? "unknown");

/** P1.3: bounded control summary for agent.called events — key presence plus
 *  the two universal scalar signals (verdict/pass). Full controls already live
 *  in audit.jsonl + the resume cache; events.jsonl must stay cheap to fold. */
function ledgerControlSummary(control: unknown): Record<string, unknown> | null {
	if (!control || typeof control !== "object") return null;
	const c = control as Record<string, unknown>;
	const out: Record<string, unknown> = { keys: Object.keys(c) };
	if (typeof c.verdict === "string") out.verdict = c.verdict;
	if (typeof c.pass === "boolean") out.pass = c.pass;
	return out;
}

/** v0.3.68 F10-1: fresh run-scoped usage accumulator (Anthropic: multi-agent
 * ≈ 15× chat tokens — totals + per-agent splits are the governance surface). */
function freshUsage(): UsageAccumulator {
	return {
		totals: { calls: 0, turns: 0, toolCalls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, durationMs: 0 },
		byAgent: {},
	};
}

function accumulateUsage(acc: UsageAccumulator, agent: string, u: AgentUsage | undefined): void {
	if (!u) return; // absent usage is never fabricated (P10)
	acc.totals.calls += 1;
	for (const k of ["turns", "toolCalls", "input", "output", "cacheRead", "cacheWrite", "cost", "durationMs"] as const) {
		const v = u[k];
		if (typeof v === "number" && Number.isFinite(v)) acc.totals[k] += v;
	}
	const per = acc.byAgent[agent] ?? { calls: 0, turns: 0, toolCalls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, durationMs: 0 };
	per.calls += 1;
	for (const k of ["turns", "toolCalls", "input", "output", "cacheRead", "cacheWrite", "cost", "durationMs"] as const) {
		const v = u[k];
		if (typeof v === "number" && Number.isFinite(v)) per[k] += v;
	}
	acc.byAgent[agent] = per;
}

/** Structural subset of UsageAccumulator totals (summaries stay
 *  constructible from partial accumulators in tests/tools). */
export interface UsageTotalsView {
	calls: number;
	turns?: number;
	toolCalls?: number;
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	cost?: number;
	durationMs?: number;
}

/** v0.3.68 F10-1: deterministic one-line usage summary (P10 — null when no
 * usage was ever seen; no fabricated zeros). */
export function summarizeUsage(acc: { totals: UsageTotalsView; byAgent?: unknown }): string | null {
	if (acc.totals.calls === 0) return null;
	const parts = [`calls=${acc.totals.calls}`];
	if (acc.totals.input) parts.push(`input=${acc.totals.input}`);
	if (acc.totals.output) parts.push(`output=${acc.totals.output}`);
	if (acc.totals.turns) parts.push(`turns=${acc.totals.turns}`);
	if (acc.totals.toolCalls) parts.push(`tools=${acc.totals.toolCalls}`);
	if (acc.totals.cost) parts.push(`cost=${Number(acc.totals.cost.toFixed(4))}`);
	return parts.join(" ");
}

/** v0.3.68 F10-1 (plan D6 方案 A): per-call fail-closed cost/token fuse.
 * Checked BEFORE a call launches; the call that LANDS at/over the cap still
 * completes and is counted honestly — the NEXT call fails closed naming the
 * fuse and the spent/limit numbers (mirrors the spawn-budget fuse). The
 * error rows then flow through the EXISTING deterministic wind-down: v0.3.65
 * marks them cause:"agent-error" and FatalAborts after 3 consecutive rounds,
 * so a tripped fuse winds the run down with zero further agent spend and
 * close-out (summary/audit/metrics) still runs — the reasons 方案 A beat a
 * hard abort (plan §6.1). */
function usageFuseError(acc: UsageAccumulator): string | null {
	const maxCost = superDevEnv("SUPER_DEV_MAX_RUN_COST");
	if (maxCost) {
		const cap = Number(maxCost);
		if (Number.isFinite(cap) && acc.totals.cost >= cap) {
			return `usage fuse tripped: SUPER_DEV_MAX_RUN_COST spent $${acc.totals.cost.toFixed(4)} >= limit $${cap} — this call was NOT launched. Raise SUPER_DEV_MAX_RUN_COST (or unset it) and resume; already-committed work is safe.`;
		}
	}
	const maxTokens = superDevEnv("SUPER_DEV_MAX_RUN_TOKENS");
	if (maxTokens) {
		const cap = Number(maxTokens);
		if (Number.isFinite(cap) && (acc.totals.input + acc.totals.output) >= cap) {
			return `usage fuse tripped: SUPER_DEV_MAX_RUN_TOKENS spent ${acc.totals.input + acc.totals.output} tokens (in ${acc.totals.input}/out ${acc.totals.output}) >= limit ${cap} — this call was NOT launched. Raise SUPER_DEV_MAX_RUN_TOKENS (or unset it) and resume; already-committed work is safe.`;
		}
	}
	return null;
}


function makeContext(state: PipelineState, task: string, options: RunOptions, log: (m: string) => void): StageContext {
	const budget = makeBudget(options.maxAgents ?? DEFAULT_MAX_AGENTS);
	const maxConcurrency = options.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY;
	const model = options.model;
	// Per-agent cross-model policy, read ONCE per run (config is a small JSON file).
	// resolveAgentModel applies precedence A: call.model > config.agentModels[role]
	// > global options.model. Failure to read config degrades to {} (today's behavior).
	const agentModels = (() => { try { return getConfig().agentModels ?? {}; } catch { return {}; } })();
	const signal = options.signal;
	// Single EventEmitter for the whole context: `ctx.phase()` emits on it and
	// runWorkflow subscribes ("phase"/"stage") to route into the progress sink.
	const events = new EventEmitter();

	// v0.3.26/v0.3.64: one-shot ERROR log for a missing pi-subagents owner.
	let ownerWarned = false;
	// v0.3.68 F10-1: run-scoped usage accumulator — the single mutable record
	// every successful agent call lands in (per-agent + totals), the RunSummary
	// usage block reads, and the SUPER_DEV_MAX_RUN_COST/TOKENS fuses check.
	const usage = freshUsage();

	async function realAgent(call: AgentCall): Promise<AgentResult> {
		// BUG-4: atomic reservation — bail BEFORE doing any work when the cap is hit,
		// so concurrent branches can't exceed maxAgents. (Stage bodies still peek
		// `check()` to avoid constructing a prompt when obviously over budget.)
		if (!budget.spent()) {
			appendRunEvent(state.setup?.specDirectory, {
				runId: ledgerRunId(state),
				agent: call.agent,
				stage: (call.id ?? "").replace(/^pipeline\./, ""),
				type: "agent.called",
				data: { agent: call.agent, backend: "n/a", durationMs: 0, error: "budget exhausted (maxAgents reached)" },
			});
			return { text: "", control: null, error: "budget exhausted (maxAgents reached)" };
		}
		// v0.3.68 F10-1 (D6 方案 A): cost/token fuse — same pre-call shape as the
		// spawn budget above. The call is not launched; the honest error names the
		// fuse and the numbers; consecutive fuse rows FatalAbort via v0.3.65
		// (deterministic wind-down, no hard abort — plan §6.1).
		const fuseError = usageFuseError(usage);
		if (fuseError) {
			log(`agent ${call.id ?? call.agent}: ${fuseError}`);
			appendRunEvent(state.setup?.specDirectory, {
				runId: ledgerRunId(state),
				agent: call.agent,
				stage: (call.id ?? "").replace(/^pipeline\./, ""),
				type: "agent.called",
				data: { agent: call.agent, backend: "n/a", durationMs: 0, error: fuseError },
			});
			return { text: "", control: null, error: fuseError };
		}
		const agentCwd = state.setup?.worktreePath ?? options.cwd ?? process.cwd();
		// First-principles retry convergence: if a gate rejected a prior attempt,
		// it stored structured errors under state.__feedback[stageId]. Prepend them
		// to this attempt's prompt so the agent fixes the specific failure instead
		// of resampling the same distribution. The writer's call.id is `pipeline.<id>`.
		const stageKey = (call.id ?? "").replace(/^pipeline\./, "");
		const feedback = getRetryFeedback(state as Record<string, unknown>, stageKey) ?? [];
		const alreadyHasLedger = feedback.some((item) => typeof item === "object" && item !== null && "location" in item && String((item as { location?: unknown }).location ?? "").startsWith("convergence-ledger/"));
		const ledgerFeedback = alreadyHasLedger ? [] : convergenceRetryFeedback(state, { stage: stageKey || call.agent, currentStage: normalizeConvergenceStage(stageKey, "implementation"), gate: "convergence-ledger" });
		const combinedFeedback = [...feedback, ...ledgerFeedback];
		const feedbackBlock = combinedFeedback.length ? renderRetryFeedbackBlock(combinedFeedback) : "";
	// v0.3.35: AUTONOMY CLAUSE on every delegation. Runs 2026-08-30T04-53-26 /
		// 05-26-19: specialists occasionally "ask a supervisor" mid-task
		// (intercom/subagent_supervisor) — pi-subagents DETACHES such a child and
		// the whole multi-minute turn is discarded (observed on
		// sd-requirements-clarifier and sd-debug-analyzer; each detach cost a full
		// convergence round). No supervisor exists: state it up front.
		const autonomy = DELEGATION_AUTONOMY_CLAUSE;
		const prompt = combinedFeedback.length
			? `${call.prompt}\n\n${autonomy}\n\n${feedbackBlock}\nRe-produce the complete artifact, then call structured_output.`
			: `${call.prompt}\n\n${autonomy}`;
		// Option C: inject ONLY the fields this agent needs from prior stages'
		// structured_output (control objects), extracted from .knowledge.json.
		const knowledge = knowledgeForAgent(state.setup?.specDirectory ?? "", call.agent);
		const promptWithKnowledge = knowledge
			? `${prompt}\n\n## Prior-stage data (auto-injected)\n${knowledge}`
			: prompt;
		// Drain captured mid-run user input ONCE per spawn and PERSIST it to
		// `.user-notes.json` (durable, resume-safe). Then inject the ACCUMULATED
		// notes (incl. the just-appended ones) into THIS agent's prompt — so every
		// subsequent stage sees all user context added so far, not just the next
		// agent. Draining here (inside realAgent, not the memoizing wrapper) means a
		// cached/replayed spawn during resume does NOT re-drain. Non-interrupting:
		// a note typed during agent N is picked up at the N+1 boundary.
		const drained = options.userSteerProvider ? options.userSteerProvider() : [];
		appendUserNotes(state.setup?.specDirectory, drained);
		// P3.1: user instructions are ledger events too (the instruction channel
		// of the message bus — folds see what the human injected and when).
		for (const note of drained) recordInstruction(state.setup?.specDirectory, typeof note === "string" ? note : note.text, ledgerRunId(state)); // v0.3.56 F9a: RuntimeInstruction objects rendered as '[object Object]' in the ledger (P10)
		const userNotes = userNotesForAgent(state.setup?.specDirectory);
		const promptWithNotes = userNotes
			? `${promptWithKnowledge}\n\n## User context (added during the run)\n${userNotes}`
			: promptWithKnowledge;
		const controlKeys = call.controlKeys ?? extractControlKeys(call.prompt);
		// v0.3.54 (P10): contract-drift telemetry (unbalanced parens, dropped
		// fragments, F6 fallback acceptances) lands in the RUN LOG with the call
		// id — console.warn never reached run.log/audit, so live runs could not
		// see why a control line misparsed.
		for (const drift of drainControlDrift()) log(`agent ${call.id ?? call.agent}: ${drift}`);
		const allowEmptyArraysFor = call.allowEmptyArraysFor;
		const timeoutMs = call.timeoutMs;
		const timeoutLabel = timeoutMs !== undefined ? `${timeoutMs}ms` : "role-default";
		// v0.3.45: a per-call model may carry a `:level` suffix ("glm-5.3:high");
		// an explicit call.thinking still wins, the suffix fills it when absent
		// (resolveAgentModel strips the suffix from the model string itself).
		const perCallThinking = call.thinking ?? splitModelThinking(call.model).thinking;
		const thinkingLabel = perCallThinking ?? options.inheritedThinking ?? superDevEnv("SUPER_DEV_THINKING") ?? "role-default";
		const accessMode = call.accessMode ?? "write";
		// v0.3.64: the pi-subagents delegation backend is the ONLY specialist
		// backend — browser/web-research roles load their extension tools via the
		// sd-* registration's per-agent `extensions` (agent-runtime.extensionsForAgent,
		// verified live on pi-subagents 0.64 and 0.65 on 2026-09-04), so the old
		// forced-subprocess routing and the session/subprocess backends are gone.
		// options.events (the in-process bus) is a hard requirement: without it a
		// delegation request would hang on an unanswered event — the run-level gate
		// in extension.ts refuses to start, and this seam degrades defensively.
		const inheritedModel = options.inheritedModelObject
			? `${options.inheritedModelObject.provider}/${options.inheritedModelObject.id}`
			: undefined;
		const promptWithAccess = accessMode === "source-read-only"
			? `${promptWithNotes}\n\n## Source mutation boundary\nThis call is source-read-only. You may inspect files and run diagnostics, but do not edit, write, stage, commit, delete, move, or generate files under the project worktree except temporary files outside the repository (for example under /tmp). The super-dev pipeline renders report artifacts for you.`
			: promptWithNotes;
		// v0.3.23: output-language directive rides on EVERY agent call — appended
		// last at THIS seam (the backends may wrap delivery-discipline sections
		// after it, but it stays the final TASK-content section; recency beats
		// system prompts for output language) so every artifact
		// (spec docs, reports, ledger/audit text, commits) lands in the configured
		// language (default english) regardless of the task's language. One choke
		// point covers both backends; judge calls flow through ctx.agent too.
		const promptWithLanguage = `${promptWithAccess}\n\n${languageDirective()}`;
		const common = {
			agent: call.agent,
			prompt: promptWithLanguage,
			cwd: agentCwd,
			accessMode,
			controlKeys,
			// Optional-by-contract keys whose empty-array value counts as present
			// (Fix 1d threading; undefined for every legacy caller).
			allowEmptyArraysFor,
			schema: call.schema,
			// Per-agent model (precedence A). Falls back to the global `model`, then
			// (in the backend) to the inherited main-session model. Enables cross-model
			// review via ~/.super-dev config.agentModels.
			model: resolveAgentModel(call, agentModels, model),
			// Thread the inherited DEFAULTS (live main-session model object +
			// thinking level) through the shared `common` object so BOTH backends
			// receive them. ADDITIVE — each backend applies them BELOW an explicit
			// param/env override (see pi-spawn.resolveModel/resolveThinking and
			// session-agent.runAgentViaSession). SCENARIO-001/005/006.
			inheritedModelObject: options.inheritedModelObject,
			inheritedThinking: options.inheritedThinking,
			signal,
			id: call.id,
			// Per-call override; when absent each backend falls back to the
			// role-based default (code-writing agents get a larger cap).
			timeoutMs,
			// Per-call thinking override. Both backends read the SAME per-call value:
			// the subprocess backend reads `thinking` (buildSpawnArgs → --thinking via
			// resolveThinking); the session backend reads `thinkingLevel`
			// (applyThinkingLevel → session.setThinkingLevel). They are intentionally
			// aliased to the same `call.thinking` so one `common` object feeds both
			// backends; when absent, each backend falls back to SUPER_DEV_THINKING
			// then the role default.
			thinking: perCallThinking,
			thinkingLevel: perCallThinking,
			onProgress: {
				event: (m: string) => log(m),
				text: (partial: string) => options.progress?.text(partial, currentStepScope()),
			},
		};
		const sourceBoundaryBefore = accessMode === "source-read-only" ? captureSourceBoundary(agentCwd, state.setup?.specDirectory) : null;
		if (sourceBoundaryBefore && !sourceBoundaryBefore.ok) log(`agent ${call.id ?? call.agent}: source-read-only boundary unavailable (${sourceBoundaryBefore.error}); relying on tool restrictions`);
		// v0.3.54: read-only calls that run CONCURRENTLY with a writer (the RED
		// review vs the implementer) must not let the guard's blind `git restore`
		// destroy the writer's legitimate edits to the same file (live: phase-11
		// "boundary reversion wiped the homepage cosmic card"). Quarantine mode:
		// violating contents are preserved to a tmp dir, NOTHING is restored here,
		// and the thrown error carries the quarantine dir so the join site can
		// attribute each path against the writer's claimed files.
		const boundaryQuarantine = accessMode === "source-read-only" && call.concurrentWriter === true;
		function enforceSourceBoundary(): void {
			if (!sourceBoundaryBefore?.ok) return;
			const after = captureSourceBoundary(agentCwd, state.setup?.specDirectory);
			if (!after.ok) {
				log(`agent ${call.id ?? call.agent}: source-read-only boundary post-check unavailable (${after.error})`);
				return;
			}
			const violations = sourceBoundaryViolations(sourceBoundaryBefore, after);
			if (violations.length === 0) return;
			sweepStaleQuarantineDirs();
			const quarantineDir = join(tmpdir(), `sd-boundary-${randomUUID().slice(0, 8)}`);
			const outcome = restoreNewSourceViolations(agentCwd, sourceBoundaryBefore, after, violations, quarantineDir, boundaryQuarantine ? "quarantine" : "restore");
			const restoredLine = outcome.restored.length ? ` restored=${outcome.restored.join(", ")}` : "";
			const manualLine = outcome.manual.length ? ` manual=${outcome.manual.join(", ")}` : "";
			log(`agent ${call.id ?? call.agent}: source-read-only boundary violation paths=${violations.join(", ")}${restoredLine}${manualLine}`);
			if (boundaryQuarantine) {
				log(`agent ${call.id ?? call.agent}: boundary QUARANTINE mode (concurrent writer) — nothing restored here; quarantined=${outcome.quarantined.join(", ") || violations.join(", ")} dir=${quarantineDir}`);
				// v0.3.55 security review F1: attach the structured payload to the
				// Error object. The join consumes err.quarantine — the string in
				// .message is never parsed, so an agent cannot forge restores by
				// echoing payload-shaped text to stderr.
				const err = new Error(formatBoundaryQuarantineError(violations, quarantineDir)) as Error & { quarantine?: BoundaryQuarantinePayload };
				err.quarantine = boundaryQuarantinePayload(violations, quarantineDir);
				throw err;
			}
			throw new Error(`source-read-only boundary violation: modified project files outside the spec artifact directory (${violations.join(", ")})`);
		}
		// v0.3.25: every specialist call routes through pi-subagents' structured-
		// delegation executor — the same machinery as the `subagent` tool — so each
		// one appears in pi's Fleet UI (turns/tools/tokens/output logs) and is
		// steerable/stoppable like any pi subagent. Since v0.3.64 this is the ONLY
		// backend: pi-subagents is a hard requirement (README), browser/web-research
		// roles load extension tools via the registration's per-agent `extensions`,
		// and there is no session/subprocess fallback. Two infra failure classes
		// (P5: never the work's fault) fail CLOSED with the remedy named:
		//   1. owner absent (pi-subagents not active in this process) — extension.ts
		//      refuses to start the run; this seam reports the actionable error per
		//      call in case registration was lost mid-session.
		//   2. version skew (v0.3.63 incident class: `pi update` swapped the package
		//      under a live session) — sticky: once seen, later calls fail FAST with
		//      the same remedy instead of burning ~5s each on the dead child.
		const exec = async (): Promise<SpawnResult> => {
			if (!options.events) {
				return { text: "", control: null, error: "pi-subagents delegation requires the in-process event bus (extension mode) — run super-dev through the super_dev tool in a pi session, not the standalone CLI." };
			}
			if (delegationOwnerPresent() === false && !ownerWarned) {
				ownerWarned = true;
				log("ERROR pi-subagents is not active in this session — every specialist call will fail. Install the pi-subagents pi package (pi install npm:pi-subagents) and restart pi. super-dev v0.3.64+ requires pi-subagents (README: Requirements).");
			}
			if (delegationOwnerPresent() === false) {
				return { text: "", control: null, error: DELEGATION_OWNER_ABSENT_ERROR };
			}
			// v0.3.63 / v0.3.64: sticky fail-fast for the version-skew class
			// (isDelegationRuntimeExtensionFailure in delegation-backend.ts for the
			// full receipt): `pi update` swapping the package under a live session
			// leaves an N-1 bridge in memory whose children die at startup against the
			// on-disk package. It cannot self-heal in this process — fail every later
			// call instantly with the remedy instead of burning ~5s on the dead child
			// (2026-09-04 incident: every agent of two stages).
			if (delegationBackendDegraded()) {
				return { text: "", control: null, error: DELEGATION_VERSION_SKEW_ERROR };
			}
			const delegated = await runAgentViaDelegation({ ...common, events: options.events, ownerRunId: state.setup?.specIdentifier ?? ledgerRunId(state) });
			// v0.3.63: the version-skew signature (pi-subagents' own runtime
			// extension failing to load in the child) is an executor infra failure,
			// never a task failure — P5: fail closed naming the remedy (there is no
			// fallback backend since v0.3.64); the sticky flag above makes later calls
			// fail fast.
			if (delegated.error && isDelegationRuntimeExtensionFailure(delegated.error)) {
				markDelegationBackendDegraded();
				log(`ERROR pi-subagents delegation infra failure (${delegated.error}) — the pi-subagents package changed under this live pi session (pi update mid-session), so the in-memory backend and the on-disk package disagree. Every later agent call in this pi session will fail fast. Remedy: restart pi (so memory matches the on-disk package) and re-run.`);
				return { text: delegated.text, control: null, error: DELEGATION_VERSION_SKEW_ERROR };
			}
			// v0.3.26 → v0.3.64: an unresolvable agent name surfaces as the call's
			// error (run 2026-08-28T15-50-08 lost all 8 requirements rounds to instant
			// "Unknown agent" rejections; the old session-backend degrade no longer
			// exists, but the registration seam trims/validates so this class is
			// reduced to genuine registration loss, and the error text names the
			// remedy for the operator).
			if (delegated.error && UNKNOWN_AGENT_ERROR_RE.test(delegated.error)) {
				log(`ERROR agent ${call.id ?? call.agent}: delegation rejected (${delegated.error}) — the sd-* registration is missing for this role; restart pi so activation re-registers (registration summary appears at super-dev activation).`);
			}
			return delegated;
		};
		const label = call.id ?? call.agent;
		const started = Date.now();
		let boundaryChecked = false;
		// v0.3.25 L1: FleetView visibility for THIS call — a display-only external
		// run (register on start, throttled currentAction from progress events,
		// terminal record on settle). Best-effort by contract: no session id (CLI
		// mode), an unresolvable pi-subagents install, or a throwing registry are
		// all silent no-ops; execution is never gated on visibility.
		const fleetMod = options.sessionId ? await resolveExternalRunsModule() : null;
		const fleetSession = options.sessionId;
		if (fleetMod && fleetSession && common.onProgress?.event) {
			const origEvent = common.onProgress.event.bind(common.onProgress);
			common.onProgress.event = (m: string) => {
				fleetUpdate(fleetMod, fleetSession, label, m);
				origEvent(m);
			};
		}
		if (fleetMod && fleetSession) fleetBegin(fleetMod, { sessionId: fleetSession, id: label, label: call.agent, source: "super-dev" });
		const fleetDone = (result: { error?: string; text?: string } | null) => {
			if (!fleetMod || !fleetSession) return;
			fleetFinish(fleetMod, fleetSession, label, {
				state: result?.error ? "failed" : "completed",
				preview: result?.error ?? result?.text?.slice(0, 160),
			});
		};
		log(`agent ${label}: start agent=${call.agent} backend=pi-subagents access=${accessMode} timeout=${timeoutLabel} thinking=${thinkingLabel} cwd=${agentCwd} model=${common.model ?? inheritedModel ?? "default"} controlKeys=${controlKeys.join(",") || "(none)"} promptChars=${promptWithAccess.length}`);
		try {
			const result = await runWithTransientRetry(exec, signal, (m) => log(m));
			fleetDone(result);
			// v0.3.68 F10-1: accumulate the per-call usage block (absent usage never
			// fabricates — accumulateUsage no-ops). Keyed by the DELEGATION agent
			// name (sd-*) so the split matches FleetView/registration identities.
			accumulateUsage(usage, delegationAgentName(call.agent), result.usage);
			// v0.3.54 review fix (adv F5): capture-side drift telemetry (F6 fallback
			// acceptances, parse warnings) is emitted during RESULT parsing inside
			// exec — after this call's prompt-time drain ran. Drain again here so
			// the events land in the run log under THIS call's id, not the next
			// call's; without it the last call's drift is dropped entirely.
			for (const drift of drainControlDrift()) log(`agent ${label}: ${drift} (at result)`);
			boundaryChecked = true;
			enforceSourceBoundary();
			const elapsed = Date.now() - started;
			log(`agent ${label}: end elapsed=${elapsed}ms control=${result.control ? "yes" : "no"} model=${result.model ?? "unknown"}${result.error ? ` error=${result.error}` : ""}`);
			// P1.3: every completed agent call lands in the event ledger (bounded
			// control summary; the full control stays in audit.jsonl + resume cache).
			appendRunEvent(state.setup?.specDirectory, {
				runId: ledgerRunId(state),
				agent: call.agent,
				stage: stageKey || call.agent,
				type: "agent.called",
				data: { agent: call.agent, model: result.model ?? common.model ?? null, backend: "pi-subagents", durationMs: elapsed, control: ledgerControlSummary(result.control), error: result.error },
			});
			return result;
		} catch (err) {
			let finalErr = err;
			if (!boundaryChecked) {
				try { enforceSourceBoundary(); }
				catch (boundaryErr) { finalErr = boundaryErr; }
			}
			for (const drift of drainControlDrift()) log(`agent ${label}: ${drift} (at result-throw)`);
			fleetDone({ error: finalErr instanceof Error ? finalErr.message : String(finalErr) });
			const elapsed = Date.now() - started;
			const message = finalErr instanceof Error ? finalErr.message : String(finalErr);
			log(`agent ${label}: threw elapsed=${elapsed}ms error=${message}`);
			appendRunEvent(state.setup?.specDirectory, {
				runId: ledgerRunId(state),
				agent: call.agent,
				stage: stageKey || call.agent,
				type: "agent.called",
				data: { agent: call.agent, model: common.model ?? null, backend: "pi-subagents", durationMs: elapsed, error: message },
			});
			throw finalErr;
		}
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

	return { task, options, state, agent, helper, parallel, budget, usage, log, phase: (label: string) => events.emit("phase", label), withScope: <T>(marker: string, fn: () => Promise<T>): Promise<T> => { const parent = scopeAls.getStore() ?? []; return scopeAls.run([...parent, marker], fn); }, events, signal, results: [] };
}

/** Run a workflow for a task. */
/** One ctx.results row (structural subset — keeps the derivation testable
 *  without a full StageContext). */
export interface StatusDerivationResultRow {
	id: string;
	label?: string;
	status: string;
	error?: string;
}

export interface RunStatusDerivation {
	status: RunStatus;
	/** Stages that ENDED in `failed` (last status per stage id — G3). */
	failedStages: { label: string; error?: string }[];
	/** Honest reasons the run is NOT `success` (G9 surfacing; empty on success). */
	statusReasons: string[];
}

/** Sweep-3 G3/G9/G22: the run-status derivation, extracted pure so the
 *  honesty contracts are unit-pinnable:
 *  - G3 `failedStages` is LAST-status-per-stage — a convergence loop that
 *    failed round 1 and converged round 2 must not permanently block `success`
 *    (the pre-fix first-failure dedupe did exactly that).
 *  - G9 `success` requires an AFFIRMATIVE build gate (`pass === true`); an
 *    ABSENT buildGate is not a vacuous pass — no deterministic build
 *    verification ran and the run is `partial` with the honest reason.
 *  - G22 a final `success` supersedes the mid-loop `__stagnated` marker — the
 *    marker is stale loop state and must never reach formatSummary/HITL. */
export function deriveRunStatus(input: {
	results: StatusDerivationResultRow[];
	state: PipelineState;
	aborted: boolean;
	abortError?: string;
}): RunStatusDerivation {
	const { results, state, aborted, abortError } = input;
	// G3: LAST status per stage id wins (later success of the same stage clears
	// an earlier failure — convergence rounds re-run the same task()).
	const lastByStage = new Map<string, StatusDerivationResultRow>();
	for (const r of results) lastByStage.set(r.id, r);
	const failedStages: { label: string; error?: string }[] = [];
	for (const r of lastByStage.values()) {
		if (r.status === "failed") failedStages.push({ label: r.label || r.id, error: r.error });
	}

	const impl = state.implementation as { totalPhases?: number; phasesCompleted?: number; allGreen?: boolean; convergenceBlocked?: boolean; phaseStatus?: Array<{ id: string; status: string }> } | undefined;
	const review = state.review as { verdict?: string } | undefined;
	const phases = impl?.totalPhases ?? 0;
	const green = impl?.allGreen === true;
	const verdict = review?.verdict;
	const approved = verdict === "Approved" || verdict === "Approved with Comments";
	const reviewRan = review !== undefined;

	// G9: the build gate must AFFIRM pass — absent is not a vacuous pass.
	const buildAffirmed = (state.buildGate as { pass?: boolean } | undefined)?.pass === true;
	const hardGateFailed =
		((state.buildGate as { pass?: boolean } | undefined)?.pass === false) ||
		((state.preMergeBuild as { pass?: boolean } | undefined)?.pass === false) ||
		((state.integration as { pass?: boolean } | undefined)?.pass === false);
	const mergeRequired =
		state.preMergeBuild !== undefined &&
		(state.preMergeBuild as { pass?: boolean }).pass === true &&
		state.cleanup !== undefined &&
		(state.cleanup as { blocked?: boolean }).blocked !== true;
	// A-2 + boolean-drift (run 2026-08-15T13-45-02): tolerant merge read.
	const mergeNotConfirmed = mergeRequired && !toBool((state.merge as { merged?: unknown } | undefined)?.merged);
	// A-3 status honesty: cleanup-blocked ⇒ never a clean success.
	const cleanupBlocked = (state.cleanup as { blocked?: boolean } | undefined)?.blocked === true;

	// R3: replan is a first-class terminal outcome.
	const replanMarker = (state as Record<string, unknown>).__replan as { rounds?: number; owners?: string[] } | undefined;
	// SD-05 (NFR-6): accepted limitations never count as clean success.
	const acceptedLimitations = (state as Record<string, unknown>).__acceptedLimitations as Record<string, unknown> | undefined;
	// A-03 (NFR-6): the replan marker must never MASK a subsequent abort.
	const replanAbort = aborted && abortError !== undefined && abortError.includes("REPLAN at round cap");

	const statusReasons: string[] = [];
	let status: RunStatus;
	if (replanMarker && (!aborted || replanAbort)) {
		status = "replan";
	} else if (aborted || phases === 0) {
		status = "failed";
	} else if (green && reviewRan && approved && buildAffirmed && !hardGateFailed && !mergeNotConfirmed && !cleanupBlocked && !acceptedLimitations && failedStages.length === 0) {
		status = "success";
	} else {
		status = "partial";
		if (!buildAffirmed && state.buildGate === undefined) statusReasons.push("build gate absent (no deterministic build verification ran)");
		if (!green) statusReasons.push("implementation not all-green");
		if (!reviewRan) statusReasons.push("review never ran");
		else if (!approved) statusReasons.push(`review verdict not approved (${String(verdict)})`);
		if (hardGateFailed) statusReasons.push("a hard gate failed");
		if (mergeNotConfirmed) statusReasons.push("merge not confirmed");
		if (cleanupBlocked) statusReasons.push("cleanup blocked the merge");
		if (acceptedLimitations) statusReasons.push("accepted limitations present");
		for (const f of failedStages) statusReasons.push(`stage ${f.label} ended failed${f.error ? `: ${f.error}` : ""}`);
	}

	// G22: a final success supersedes the mid-loop stagnation marker.
	if (status === "success") {
		delete (state as Record<string, unknown>).__stagnated;
	}
	return { status, failedStages, statusReasons };
}

export async function runWorkflow(workflow: Workflow, task: string, options: RunOptions = {}): Promise<RunSummary> {
	const progress = options.progress;
	const state: PipelineState = {};
	const ctx = makeContext(
		state,
		task,
		options,
		(msg: string) => progress?.log(msg, currentStepScope()),
	);

	// Surface phase banners + stage logs through the progress sink. We re-bind
	// ctx.log so control nodes' ctx.log(...) reach the caller; phase banners are
	// emitted by the top-level sequence via a wrapping node (see stages/index.ts).
	if (progress) {
		ctx.events.on("phase", (label: unknown) => progress.phase(String(label), currentStepScope()));
		ctx.events.on("stage", (info: unknown) => progress.stage?.(info as StageProgressEvent));
	}

	// ChangeTracker stage bracketing (Phase 3a): open a record on stage start and
	// close it on every terminal status, so change-tracker.jsonl always contains a
	// stage-start/stage-end pair for every stage — independent of the progress
	// sink wiring. SCENARIO-008 (no claimed set for stages).
	ctx.events.on("stage", (info: unknown) => {
		const stage = info as StageProgressEvent;
		if (stage.kind === "phase") return; // dashboard-only sub-stage rows; phase tracking is handled explicitly in implementation.ts
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

	// P1.2 (dsh-09 v3 Phase P): the durable run-event ledger. ONE subscription
	// captures every stage transition — including sub-step tasks (codeReview,
	// reviewFix, buildGate…) that never get their own audit.jsonl row. Events
	// buffer in order until state.setup.specDirectory exists (the ledger lives in
	// the spec dir, which setup itself creates): run.started + setup.started flush
	// the moment setup's terminal event arrives. Kind "phase" rows are
	// dashboard-only noise (same rule as the tracker above); "step" rows (TDD RED,
	// RED review…) are real transitions and are recorded with their kind.
	const runId = randomUUID();
	const runStartedAt = Date.now();
	(state as Record<string, unknown>).__runId = runId;
	const pendingLedgerEvents: RunEventInput[] = [runStartedEvent(runId, task, SUPER_DEV_EXTENSION_VERSION)];
	const ledgerEvent = (evt: RunEventInput) => {
		const dir = state.setup?.specDirectory;
		if (!dir) { pendingLedgerEvents.push(evt); return; }
		for (const pending of pendingLedgerEvents.splice(0)) appendRunEvent(dir, pending);
		appendRunEvent(dir, evt);
	};
	ctx.events.on("stage", (info: unknown) => {
		const stage = info as StageProgressEvent;
		if (!stage?.id || stage.kind === "phase") return;
		const base = { runId, stage: stage.id, data: { ...(stage.kind ? { kind: stage.kind } : {}) } } as const;
		if (stage.status === "running") { ledgerEvent({ ...base, type: "stage.started", data: { ...base.data } }); return; }
		if (stage.status === "ok" || stage.status === "partial") { ledgerEvent({ ...base, type: "stage.completed", data: { ...base.data, partial: stage.status === "partial" } }); return; }
		if (stage.status === "skipped") { ledgerEvent({ ...base, type: "stage.skipped", data: { ...base.data } }); return; }
		if (stage.status === "failed") { ledgerEvent({ ...base, type: "stage.failed", data: { ...base.data, error: stage.error } }); return; }
		if (stage.status === "cancelled") { ledgerEvent({ ...base, type: "stage.cancelled", data: { ...base.data } }); return; }
	});

	// P2 (dsh-09 v3 Phase P): team-roster setup validation — the degraded-boot
	// diagnostic that catches a renamed/deleted Responsible role BEFORE the run
	// discovers it mid-flight (pure + deterministic; warnings only, never fatal).
	for (const issue of validateTeamReadiness()) {
		progress?.log(`team readiness: stage "${issue.stage}" responsible role "${issue.role}" has no agents/${issue.role}.md definition`);
	}

	let aborted = false;
	let abortError: string | undefined;
	try {
		const rootResult = await workflow.root.run(state, ctx);
		if (rootResult.status === "cancelled") {
			aborted = true;
			abortError = "workflow cancelled";
			progress?.log(`Workflow "${workflow.id}" cancelled`);
		}
	} catch (err) {
		// A fatal gate (or fatal task) threw to abort the run honestly.
		aborted = true;
		abortError = err instanceof Error ? err.message : String(err);
		progress?.log(`Workflow "${workflow.id}" aborted: ${abortError}`);
	}

	// Sweep-3: derivation extracted pure (G3/G9/G22 contracts unit-pinned in
	// tests/sweep3-phase1.test.ts). `statusReasons` ride the summary surface for
	// the completion audit and the honest close-out log lines.
	const { status, failedStages, statusReasons } = deriveRunStatus({
		results: ctx.results as StatusDerivationResultRow[],
		state,
		aborted,
		abortError,
	});

	// Locals the close-out log lines below still read (same reads as the
	// derivation — kept local so deriveRunStatus stays pure over them).
	const impl = state.implementation as { totalPhases?: number; phasesCompleted?: number; allGreen?: boolean; convergenceBlocked?: boolean; phaseStatus?: Array<{ id: string; status: string }> } | undefined;
	const phases = impl?.totalPhases ?? 0;
	const green = impl?.allGreen === true;
	const cleanupBlocked = (state.cleanup as { blocked?: boolean } | undefined)?.blocked === true;
	const acceptedLimitations = (state as Record<string, unknown>).__acceptedLimitations as Record<string, unknown> | undefined;
	const replanMarker = (state as Record<string, unknown>).__replan as { rounds?: number; owners?: string[] } | undefined;

	// v0.3.3 V2: deterministic completion audit — written for EVERY outcome at
	// the moment the summary is derived (a partial/failed audit is more valuable
	// than a success audit). Best-effort; never throws, never blocks.
	try {
		writeCompletionAudit(state, status);
	} catch { /* best-effort */ }

	// Cancellation honesty (run 2026-08-27T13-12-39-803Z): audit.jsonl ended at
	// the last stage row — a cancelled run was indistinguishable from a crashed
	// or failed one from the trail alone (the run-dir ledger differs from the
	// spec-dir events ledger, which already closes with run.completed). Write
	// the TERMINAL cancellation record to the run-dir audit trail, always last.
	if (aborted) {
		auditAppend({ stage: "run", error: abortError ?? "cancelled", control: { event: "run.cancelled", runStatus: status, reason: abortError } });
	}

	if (!aborted) {
		// Honest completion log DERIVED FROM `status` (R5): a `tolerant` sequence
		// reaches this point even when the run only partially succeeded — not just
		// on a partial implementation, but also on a failed review/build/integration/
		// merge or any failed stage. A bare "complete" reads as success, so surface
		// `partial` explicitly with the reason (run 2026-08-10T10-54-20-663Z shipped
		// "complete" with only 1/3 phases). `success` prints the plain line.
		if (status === "partial") {
			const total = phases;
			const done = impl?.phasesCompleted ?? 0;
			const reason = green
				? cleanupBlocked
					? "cleanup blocked the merge — sensitive file(s) detected in the merge set (see state.cleanup.sensitiveDataFindings)"
					: acceptedLimitations
						? `a fatal-gate limitation was accepted without validation (see state.__acceptedLimitations: ${Object.keys(acceptedLimitations).join(", ")})`
						: "review/build/integration/merge or a stage did not fully pass"
				: `implementation finished ${done}/${total} phase(s)${(impl?.phaseStatus ?? []).filter((p) => p.status === "partial").length > 0 ? ` (${(impl?.phaseStatus ?? []).filter((p) => p.status === "partial").length} partial — best attempts stash-preserved, see run log)` : ""}`;
			progress?.log(`Workflow "${workflow.id}" complete — PARTIAL: ${reason}; downstream close-out was gated for unverified work. Inspect the run, or resume to continue.${statusReasons.length ? ` Reasons: ${statusReasons.slice(0, 4).join("; ")}` : ""}`);
		} else if (status === "replan") {
			progress?.log(`Workflow "${workflow.id}" complete — REPLAN round ${replanMarker?.rounds ?? "?"}: ${replanMarker?.owners?.join(", ") ?? "?"} will revise; auto-resuming`);
		} else {
			progress?.log(`Workflow "${workflow.id}" complete`);
		}
	}

	// P2: the topic projection — a pre-digested owner-status view folded FROM
	// the ledger itself (the shared-blackboard snapshot E4's A/B comparisons
	// consume). Emitted BEFORE run.completed so the block still ends with its
	// bracket event (INV-L5).
	try {
		const dir = state.setup?.specDirectory;
		if (dir) {
			const outcomes = reconstructStageOutcomes(readRunEvents(dir));
			appendRunEvent(dir, {
				runId,
				type: "topic.snapshot",
				data: { owners: Object.fromEntries(outcomes.map((o) => [o.stage, o.partial ? "partial" : o.status])), stageCount: outcomes.length },
			});
		}
	} catch { /* the snapshot is a convenience; the events remain the source */ }

	// P1.2: the run's terminal event — flushes any still-pending buffered events
	// first (a run that never produced a spec dir writes nothing anywhere).
	ledgerEvent({ runId, type: "run.completed", data: { status, reason: abortError, specIdentifier: state.setup?.specIdentifier ?? "" } });

	// v0.3.68 F10-2: the closing-the-loop harvest — ONE deterministic JSON row
	// per run in <specDir>/run-metrics.jsonl (never throws; no spec dir → no
	// row). Leading/lagging counters the σ-band monitor (v0.3.69 E1) reads
	// instead of hand-mining 4k-line prose logs.
	appendRunMetrics(state.setup?.specDirectory, buildRunMetricsRow({
		runId,
		status,
		agentsSpawned: ctx.budget.count,
		wallMs: Date.now() - runStartedAt,
		results: ctx.results as Array<{ id?: string; label?: string; status?: string; error?: string; cause?: string }>,
		usage: ctx.usage,
		ts: Date.now(),
	}));

	// v0.3.69 E1: σ-band drift detection over the global metrics ledger —
	// deterministic, zero-LLM, best-effort (never gates, never throws).
	checkSigmaBands((m) => progress?.log(m));
	// v0.3.69 E5: prediction ledger — verify finding predictions against the
	// accumulated metrics (decision observability; never throws).
	checkPredictionsFromLedger((m) => progress?.log(m));

	return {
		workflowId: workflow.id,
		specIdentifier: state.setup?.specIdentifier ?? "",
		worktreePath: state.setup?.worktreePath ?? options.cwd ?? process.cwd(),
		specDirectory: state.setup?.specDirectory ?? "",
		agentsSpawned: ctx.budget.count,
		state,
		status,
		failedStages,
		statusReasons,
		error: abortError,
		usage: ctx.usage,
	};
}

export { makeContext };
