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

import { existsSync, readFileSync, appendFileSync, mkdirSync, realpathSync } from "node:fs";
import { join, isAbsolute, sep } from "node:path";
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
 * Verify each evidence item: RELATIVE file paths resolve — and are CONTAINED —
 * under the worktree (realpath both sides, so `..` traversal and symlink
 * indirection cannot cite host files; B5), absolute paths are allowed by
 * design (documented allowance — the judge runs source-read-only on the host
 * and may cite host-visible build output), and the quote byte-occurs in that
 * file OR in one of the supplied captured outputs. Returns per-item failures;
 * empty array = fully verified. The WORKTREE is the only relative base —
 * never the process cwd (a host-repo same-named path must not false-verify a
 * fabricated location).
 */
export function verifyJudgeEvidence(verdict: JudgeVerdict, worktreePath: string, outputTails: string[]): string[] {
	const failures: string[] = [];
	if (verdict.route !== "continue" && verdict.evidence.length < 1) {
		failures.push(`route "${verdict.route}" requires at least 1 evidence item`);
	}
	if (verdict.evidence.length > MAX_EVIDENCE_ITEMS) {
		failures.push(`evidence has ${verdict.evidence.length} items (max ${MAX_EVIDENCE_ITEMS})`);
	}
	// B4 (NFR-6): an evidence array whose items are ALL empty/whitespace is
	// MALFORMED (fabricated shape), not MISSING — it discards on every route
	// (including escalate-now), never taking the missing-evidence degrade.
	// "the judge attached nothing" ([]) and "the judge attached garbage"
	// (all-blank items) are different failure classes.
	const allEmpty = verdict.evidence.length > 0 && verdict.evidence.every((ev) => !String(ev.file ?? "").trim() && !String(ev.quote ?? "").trim());
	if (allEmpty) failures.push("evidence is malformed: every item is empty/whitespace");
	// B5: realpath the worktree ONCE per call (both containment comparisons use
	// it); falls back to the given path when realpath is unavailable.
	let worktreeReal: string | undefined;
	try { worktreeReal = realpathSync(worktreePath); } catch { worktreeReal = undefined; }
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
		if (!isAbsolute(file)) {
			// B5 (NFR-6): contain RELATIVE evidence under the worktree — the docstring
		// contract was false for `join(worktreePath, "../../etc/passwd")`, which
		// resolves outside and would verify against a host file. realpath both
		// sides so symlink indirection cannot bypass the boundary either.
			let real: string;
			try { real = realpathSync(resolved); } catch { real = resolved; }
			const root = worktreeReal ?? worktreePath;
			if (real !== root && !real.startsWith(root + sep)) {
				failures.push(`evidence[${i}]: file resolves outside the worktree: ${file}`);
				continue;
			}
		}
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
	// B4 (NFR-6): empty/whitespace evidence items are NOT filtered away — an
	// all-empty array must reach verifyJudgeEvidence so it classifies as
	// MALFORMED (discard on every route) instead of collapsing to the
	// missing-evidence degrade. Partially-empty arrays keep their per-item
	// "empty file" failures, same as before.
	const evidence: JudgeEvidence[] = evidenceRaw
		.slice(0, MAX_EVIDENCE_ITEMS)
		.map((e) => {
			const o = (e ?? {}) as Record<string, unknown>;
			return { file: String(o.file ?? ""), quote: String(o.quote ?? "") };
		});
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
			// F4 (RC4, runs 2026-08-17T08-56-53-706Z ×2): an escalate-now verdict
			// with missing/unverifiable evidence must DEGRADE TO ESCALATE, never
		// discard. The diagnosis is the product ("owned by requirements — this
			// loop has no authority"); evidence quotes only guard fabrication on
			// keep-going routes. Discarding silenced the one component that had
			// root-caused the systemic failure. Fabricated `continue` evidence
			// still discards below-the-line as before.
			// Adversarial F4-JUDGE-INTEGRITY refinement: only the MISSING-evidence
			// class degrades (empty evidence list → "requires at least 1"). FABRICATED
			// evidence (a quote that fails verification, malformed/empty file claim)
			// still DISCARDS even on escalate-now — an unverified diagnosis must not
			// abort the run one round early; the judge prompt's "fabricated quotes
			// discard the verdict" clause stays true for every route.
			const missingOnly = verdict.evidence.length === 0 && evidenceFailures.every((f) => f.includes("requires at least 1 evidence item"));
			if (verdict.route === "escalate-now" && missingOnly) {
				appendAudit(req, { verdict, escalated: true, evidenceFailures, reason: "escalate-now with NO evidence — degrading to escalate (diagnosis preserved)" });
				ctx.log(`judge ${req.scope}: unverified escalate accepted — no evidence attached (${evidenceFailures.join("; ")}) but route is escalate-now; escalating with diagnosis`);
				return { status: "escalate", verdict };
			}
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
		// B3 (NFR-6): the keep-going route is exempt from INV-2's ≥1-verified-item
		// rule (its impact is bounded — it preserves the loop's deterministic
		// machinery), but the exemption must be EXPLICIT in the audit trail, never
		// silent: an evidence-less continue routes with a documented reason.
		if (verdict.route === "continue" && verdict.evidence.length === 0) {
			appendAudit(req, { verdict, routed: true, reason: "continue routed with zero evidence — INV-2 exemption documented: the keep-going route preserves the loop's deterministic machinery; nothing was machine-verified" });
			ctx.log(`judge ${req.scope}: route=continue confidence=${verdict.confidence} routed with ZERO evidence (INV-2 exemption — documented in .judge.jsonl) — ${verdict.diagnosis}`);
			return { status: "routed", verdict };
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
