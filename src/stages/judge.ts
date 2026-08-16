/**
 * LLM Judge Routing Layer (docs/requirements/llm-judge-routing-layer.md).
 *
 * The judge is the pipeline's diagnostic escape valve: deterministic loops can
 * only RECOGNIZE enumerated failure classes; when a loop stops making progress
 * (unknown ×2, oscillation, no-progress), the judge diagnoses the un-enumerated
 * category and picks the next move from a CLOSED route set.
 *
 * Safety model — "judgment routes, code verifies":
 *   INV-1 the judge never acquits: every route is executed by deterministic
 *         wiring code; no gate verdict (RED status, build pass, review approval)
 *         is ever taken from the judge;
 *   INV-2 evidence must be machine-verifiable: each `{file, quote}` is checked
 *         (file exists under the worktree; quote byte-occurs in that file or in
 *         the captured outputs supplied by the caller); an unverified verdict is
 *         discarded and falls back to `escalate-now` — NEVER to a permissive route;
 *   INV-3 budgets are independent and small: ≤2 calls per failure signature,
 *         ≤12 per run (env-tunable), never shared with implementer/reviewer budgets;
 *   INV-4 fresh context, read-only: the judge agent gets a self-contained prompt
 *         and `source-read-only` access;
 *   INV-5 full audit: every call is logged and appended to `.judge.jsonl` in the
 *         spec directory;
 *   INV-6 self-hosting: the judge runs on the SESSION backend; if the judge call
 *         itself fails on infrastructure, the caller transparently degrades to
 *         today's behavior (`status: "degraded"`) — the diagnosis mechanism must
 *         never become a new deadlock source.
 *
 * Kill switch: SUPER_DEV_DISABLE_JUDGE=1 makes runJudge degrade instantly.
 */

import { existsSync, readFileSync, appendFileSync, mkdirSync } from "node:fs";
import { join, isAbsolute } from "node:path";
import { buildJudgePrompt } from "../prompts.ts";
import { appendRunEvent } from "../runlog.ts";
import type { StageContext } from "../types.ts";

export const JUDGE_ROUTES = ["re-author-tests", "challenge-test", "fix-environment", "continue", "escalate-now"] as const;
export type JudgeRoute = (typeof JUDGE_ROUTES)[number];

export const JUDGE_CONTROL_KEYS = ["diagnosis", "route", "confidence", "evidence"] as const;

/** Min judge confidence for a non-default route (below → escalate-now). */
const MIN_CONFIDENCE = 0.6;
/** Max judge calls per failure signature (INV-3). */
const MAX_CALLS_PER_SIGNATURE = 2;
/** Max judge calls per run (INV-3); env-override SUPER_DEV_MAX_JUDGE_CALLS.
 *  Read lazily per call (tests must be able to set env after import). */
const maxCallsPerRun = (): number => {
	const n = Number.parseInt(process.env.SUPER_DEV_MAX_JUDGE_CALLS ?? "", 10);
	return Number.isFinite(n) && n > 0 ? n : 12;
};
/** Wall-clock cap for one judge call: diagnosis must be fast, never block a loop. */
const JUDGE_TIMEOUT_MS = 120_000;
const DIAGNOSIS_MAX_CHARS = 600;
const QUOTE_MIN = 8;
const QUOTE_MAX = 200;
const MAX_EVIDENCE_ITEMS = 5;
/** Cap on a single file read during evidence verification (pathological files). */
const VERIFY_FILE_CAP = 8 * 1024 * 1024;

export interface JudgeEvidence {
	file: string;
	quote: string;
}

export interface JudgeVerdict {
	diagnosis: string;
	route: JudgeRoute;
	confidence: number;
	evidence: JudgeEvidence[];
}

export interface JudgeRequest {
	/** Wiring-point id, e.g. "stage9.red-unknown" — used in logs/audit + agent id. */
	scope: string;
	/** Failure signature the caller keyed the stall on (budget key). */
	signature: string;
	/** Worktree the failure occurred in (evidence files resolve against it). */
	worktreePath: string;
	/** Spec directory (audit .judge.jsonl is appended there); empty disables file audit. */
	specDirectory?: string;
	/** Pre-rendered context blocks for the prompt (oracle output, tails, history). */
	context: string;
	/** Routes this wiring point is able to execute. escalate-now is always implied. */
	allowedRoutes: readonly JudgeRoute[];
	/** Captured outputs (oracle stdout, agent text tails) eligible for quote verification. */
	outputTails?: string[];
}

export type JudgeOutcome =
	| { status: "routed"; verdict: JudgeVerdict }
	| { status: "escalate"; verdict: JudgeVerdict }
	| { status: "discarded"; reason: string }
	| { status: "degraded"; reason: string };

// ---------------------------------------------------------------------------
// Budgets (INV-3). Module-level so every wiring point shares one run budget.
// Keys reset only on process restart; per-signature budget makes re-routing the
// SAME stall impossible after 2 attempts, forcing today's HITL path.
const signatureCalls = new Map<string, number>();
let runCalls = 0;

export function resetJudgeBudgets(): void {
	signatureCalls.clear();
	runCalls = 0;
}

export function judgeBudgetState(): { run: number; signatures: number } {
	return { run: runCalls, signatures: signatureCalls.size };
}

// ---------------------------------------------------------------------------
// Evidence verification (INV-2). Pure + exported for unit tests.

function boundedRead(path: string): string {
	try {
		const buf = readFileSync(path);
		return buf.length > VERIFY_FILE_CAP ? buf.subarray(0, VERIFY_FILE_CAP).toString("utf8") : buf.toString("utf8");
	} catch {
		return "";
	}
}

/**
 * Verify each evidence item: file resolves under the worktree (or is absolute
 * and exists), and the quote byte-occurs in that file OR in one of the supplied
 * captured outputs. Returns per-item failures; empty array = fully verified.
 * The WORKTREE is the only relative base — never the process cwd (a host-repo
 * same-named path must not false-verify a fabricated location).
 */
export function verifyJudgeEvidence(verdict: JudgeVerdict, worktreePath: string, outputTails: string[]): string[] {
	const failures: string[] = [];
	if (verdict.route !== "continue" && verdict.evidence.length < 1) {
		failures.push(`route "${verdict.route}" requires at least 1 evidence item`);
	}
	if (verdict.evidence.length > MAX_EVIDENCE_ITEMS) {
		failures.push(`evidence has ${verdict.evidence.length} items (max ${MAX_EVIDENCE_ITEMS})`);
	}
	for (const [i, ev] of verdict.evidence.entries()) {
		const file = String(ev.file ?? "").trim();
		const quote = String(ev.quote ?? "");
		if (!file) { failures.push(`evidence[${i}]: empty file`); continue; }
		if (quote.length < QUOTE_MIN || quote.length > QUOTE_MAX) {
			failures.push(`evidence[${i}]: quote length ${quote.length} outside ${QUOTE_MIN}-${QUOTE_MAX}`);
			continue;
		}
		const resolved = isAbsolute(file) ? file : join(worktreePath, file.replace(/^\.\//, ""));
		if (!existsSync(resolved)) { failures.push(`evidence[${i}]: file not found: ${file}`); continue; }
		if (!boundedRead(resolved).includes(quote)) {
			const inTails = outputTails.some((t) => t.includes(quote));
			if (!inTails) failures.push(`evidence[${i}]: quote not found in ${file} or captured outputs`);
		}
	}
	return failures;
}

// ---------------------------------------------------------------------------
// Control parsing: defensive, never throws, falls back to discarded.

function parseJudgeControl(control: Record<string, unknown> | null): JudgeVerdict | null {
	if (!control) return null;
	const diagnosisRaw = typeof control.diagnosis === "string" ? control.diagnosis.trim() : "";
	const routeRaw = typeof control.route === "string" ? control.route.trim() as JudgeRoute : ("" as JudgeRoute);
	if (!diagnosisRaw) return null;
	if (!(JUDGE_ROUTES as readonly string[]).includes(routeRaw)) return null;
	const confidenceNum = Number(control.confidence);
	const confidence = Number.isFinite(confidenceNum) ? Math.min(1, Math.max(0, confidenceNum)) : 0;
	const evidenceRaw = Array.isArray(control.evidence) ? control.evidence : [];
	const evidence: JudgeEvidence[] = evidenceRaw
		.slice(0, MAX_EVIDENCE_ITEMS)
		.map((e) => {
			const o = (e ?? {}) as Record<string, unknown>;
			return { file: String(o.file ?? ""), quote: String(o.quote ?? "") };
		})
		.filter((e) => e.file || e.quote);
	return { diagnosis: diagnosisRaw.slice(0, DIAGNOSIS_MAX_CHARS), route: routeRaw, confidence, evidence };
}

// ---------------------------------------------------------------------------
// Audit (INV-5). Best-effort; never throws.

function appendAudit(req: JudgeRequest, entry: Record<string, unknown>): void {
	if (!req.specDirectory) return;
	try {
		const dir = isAbsolute(req.specDirectory) ? req.specDirectory : join(req.worktreePath, req.specDirectory);
		mkdirSync(dir, { recursive: true });
		appendFileSync(join(dir, ".judge.jsonl"), JSON.stringify({ ts: new Date().toISOString(), scope: req.scope, ...entry }) + "\n");
	} catch { /* best-effort audit */ }
}

// ---------------------------------------------------------------------------
// The entry point. NEVER throws; every failure mode degrades (INV-6).

async function runJudgeInner(ctx: StageContext, req: JudgeRequest): Promise<JudgeOutcome> {
	if (process.env.SUPER_DEV_DISABLE_JUDGE === "1") {
		return { status: "degraded", reason: "judge disabled (SUPER_DEV_DISABLE_JUDGE)" };
	}
	const allowed = [...new Set([...req.allowedRoutes, "escalate-now" as JudgeRoute])];
	const sigKey = `${req.scope}:${req.signature}`;
	const used = signatureCalls.get(sigKey) ?? 0;
	if (used >= MAX_CALLS_PER_SIGNATURE) {
		return { status: "degraded", reason: `per-signature judge budget exhausted (${used}/${MAX_CALLS_PER_SIGNATURE} for ${sigKey})` };
	}
	if (runCalls >= maxCallsPerRun()) {
		return { status: "degraded", reason: `run judge budget exhausted (${runCalls}/${maxCallsPerRun()})` };
	}
	signatureCalls.set(sigKey, used + 1);
	runCalls++;
	ctx.log(`judge ${req.scope}: call ${used + 1}/${MAX_CALLS_PER_SIGNATURE} (run ${runCalls}/${maxCallsPerRun()})`);
	try {
		const result = await ctx.agent({
			id: `pipeline.judge.${req.scope.replace(/[^A-Za-z0-9.-]+/g, "-")}`,
			agent: "judge",
			prompt: buildJudgePrompt(req.scope, req.context, allowed),
			accessMode: "source-read-only",
			controlKeys: [...JUDGE_CONTROL_KEYS],
			allowEmptyArraysFor: ["evidence"],
			timeoutMs: JUDGE_TIMEOUT_MS,
		});
		if (result.error && !result.control) {
			appendAudit(req, { error: result.error });
			return { status: "degraded", reason: `judge agent failed: ${result.error}` };
		}
		const verdict = parseJudgeControl(result.control);
		if (!verdict) {
			appendAudit(req, { error: "unparseable judge control", control: result.control ?? null });
			return { status: "discarded", reason: "judge control unparseable or missing diagnosis/route" };
		}
		const evidenceFailures = verifyJudgeEvidence(verdict, req.worktreePath, req.outputTails ?? []);
		if (evidenceFailures.length > 0) {
			appendAudit(req, { verdict, discarded: true, evidenceFailures });
			ctx.log(`judge ${req.scope}: verdict DISCARDED — evidence verification failed: ${evidenceFailures.join("; ")}`);
			return { status: "discarded", reason: `evidence verification failed: ${evidenceFailures.join("; ")}` };
		}
		if (!allowed.includes(verdict.route)) {
			appendAudit(req, { verdict, escalated: true, reason: `route "${verdict.route}" not offered at this wiring point` });
			ctx.log(`judge ${req.scope}: route "${verdict.route}" not offered — escalating instead`);
			return { status: "escalate", verdict: { ...verdict, route: "escalate-now" } };
		}
		if (verdict.confidence < MIN_CONFIDENCE && verdict.route !== "escalate-now") {
			appendAudit(req, { verdict, escalated: true, reason: `confidence ${verdict.confidence} < ${MIN_CONFIDENCE}` });
			ctx.log(`judge ${req.scope}: confidence ${verdict.confidence} < ${MIN_CONFIDENCE} — escalating instead`);
			return { status: "escalate", verdict: { ...verdict, route: "escalate-now" } };
		}
		appendAudit(req, { verdict, routed: true });
		ctx.log(`judge ${req.scope}: route=${verdict.route} confidence=${verdict.confidence} — ${verdict.diagnosis}`);
		return { status: "routed", verdict };
	} catch (err) {
		// INV-6: the judge itself is infrastructure — a failure here degrades
		// silently to today's behavior, never a new deadlock source.
		const msg = err instanceof Error ? err.message : String(err);
		appendAudit(req, { error: msg });
		return { status: "degraded", reason: `judge threw: ${msg}` };
	}
}

/**
 * The exported entry point (P1.5): delegates to {@link runJudgeInner} and
 * double-writes every judge call to the run-event ledger (INV-5's audit trail
 * gains the fold-friendly stream view: scope, status, route/confidence for
 * acted-on verdicts, the degradation reason otherwise). NEVER lets the ledger
 * block or alter the judge outcome.
 */
export async function runJudge(ctx: StageContext, req: JudgeRequest): Promise<JudgeOutcome> {
	const out = await runJudgeInner(ctx, req);
	try {
		const stageOfScope = req.scope.startsWith("stage9.") ? "implementation" : req.scope.startsWith("stage10.") ? "verify" : undefined;
		appendRunEvent(req.specDirectory, {
			runId: String((ctx.state as Record<string, unknown> | undefined)?.__runId ?? "unknown"),
			...(stageOfScope ? { stage: stageOfScope } : {}),
			agent: "judge",
			type: "judge.called",
			data: {
				scope: req.scope,
				status: out.status,
				...(out.status === "routed" || out.status === "escalate"
					? { route: out.verdict.route, confidence: out.verdict.confidence, diagnosis: out.verdict.diagnosis.slice(0, 300) }
					: { reason: String(out.reason ?? "").slice(0, 200) }),
			},
		});
	} catch { /* ledger must never block the judge */ }
	return out;
}
