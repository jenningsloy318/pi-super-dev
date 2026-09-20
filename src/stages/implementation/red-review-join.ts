/**
 * The parallel RED-review join (v0.4.35 — increment 7 of the stage.ts split).
 *
 * Source: the block at stage.ts ~1407-1513. The RED review is read-only, so
 * (v0.3.43 RC2) it launches at RED-acceptance time WITHOUT awaiting and runs
 * concurrently with the implementer; this module adjudicates the verdict
 * immediately after the implementer returns. R2 fail-closed and the Fix 4
 * contradiction override are enforced here verbatim: ONLY an explicit STRONG,
 * contradiction-free verdict lets the GREEN work proceed to the gates. A
 * merely-weak verdict stays advisory (the post-RED oracle is the deterministic
 * endpoint — same semantics as the serial path). Anything else discards the
 * GREEN work and re-authors the RED with the evidence.
 *
 * Four verdict branches:
 *   - STRONG, no contradictions → proceed (log only).
 *   - WEAK, no contradictions → advisory: set redWeaknessAdvisory, proceed.
 *   - reviewer-side FAILURE (no verdict parsed) → v0.3.53 F2 fail-OPEN: the
 *     checker is not suite evidence, keep the work, count a violation
 *     separately; 2 violations disable parallel review for the phase.
 *   - anything else → REJECT: discard the GREEN work, re-author the RED with
 *     the evidence, and continue; past MAX_PARALLEL_REVIEW_REJECTS the phase
 *     stops as no-progress (break).
 *
 * Extraction shape — the third control-flow conversion (after red-judge.ts
 * v0.4.32 and research-assist-dispatch.ts v0.4.34). The block's `continue`
 * (reject → re-author) becomes a returned `restart`, and the `break` (cap
 * exhausted) becomes a returned `terminal`. The eleven phase-scoped bindings
 * become typed params (reads) and a returned RedReviewRouting record (writes);
 * `attemptErrors` is appended via a returned string (the caller owns the array).
 *
 * `MAX_PARALLEL_REVIEW_REJECTS` is taken as a PARAM, not re-declared: the bound
 * is a phase-loop-scoped const at the caller (stage.ts:307) and duplicating it
 * here would be a P6 violation (two spellings of the same value drifting).
 *
 * Cross-iteration semantics (the v0.4.33 lesson — a `continue` preserves
 * phase-scoped state implicitly; a returned record must do it explicitly): the
 * reject branch does NOT touch terminalStopReason / terminalFailureKind /
 * terminalRedTries, so those are carried in as params and echoed on the
 * restart path; only the cap-exhausted terminal sets them. Likewise
 * acceptedRed and redTestSnapshot are carried in and only nulled on reject.
 *
 * Never throws: the in-flight promise's own rejection is caught here and
 * adjudicated as a review error (fail-closed re-author); the ledger write is
 * wrapped (never block the phase on bookkeeping).
 */

import type { BoundaryQuarantinePayload, PipelineState, StageContext } from "../../types.ts";
import type { AcceptedRedContext } from "./red-evidence.ts";
import { attributeQuarantinePaths, attributeQuarantinedViolations, discardGreenWork } from "./phase-status.ts";
import { parseRedContradictions } from "./phase-reentry.ts";
import { recordConvergenceFindings } from "../../convergence-ledger.ts";

/** The promise shape produced by the review store site (stage.ts:301). */
export type RedReviewInFlight = Promise<{ control: unknown; error?: string } | null>;

export interface RedReviewJoinInput {
	ctx: StageContext;
	state: PipelineState;
	worktreePath: string;
	phaseId: string;
	/** The in-flight review to adjudicate (read once; the caller nulls it). */
	review: RedReviewInFlight;
	/** The implementer's own control, for quarantine attribution/salvage. */
	implControl: unknown;
	/** The confirmed RED test files (excluded from salvage claims: AR-73-01). */
	testFiles: string[];
	/** v0.3.43 hard bound on the parallel re-author cycle (caller-owned, P6). */
	maxParallelReviewRejects: number;
	/** The phase's run-so-far count, used when the cap trips. */
	attemptsRun: number;
	/** Phase-scoped counters carried in. */
	parallelReviewRejects: number;
	phaseReviewViolations: number;
	/** Phase-scoped state carried in (echoed on restart — v0.4.33 lesson). */
	terminalFailureKind: "red-generation" | "implementation-gate";
	terminalRedTries: number;
	terminalStopReason: "budget" | "no-progress" | "failed" | "environment-blocked" | "phase-attempt-cap" | "phase-wall" | "wall-fuse" | "inherited-red" | "declared-handoff" | "red-weakening" | "already-satisfied-blocked";
	/** Carried in; nulled ONLY on reject. */
	acceptedRed: AcceptedRedContext | null;
	redTestSnapshot: Map<string, string | null>;
	redWeaknessAdvisory: string;
	reauthorEvidence: string;
}

/** The values the caller rebinds after the join. */
export interface RedReviewRouting {
	parallelReviewRejects: number;
	phaseReviewViolations: number;
	terminalFailureKind: "red-generation" | "implementation-gate";
	terminalRedTries: number;
	terminalStopReason: "budget" | "no-progress" | "failed" | "environment-blocked" | "phase-attempt-cap" | "phase-wall" | "wall-fuse" | "inherited-red" | "declared-handoff" | "red-weakening" | "already-satisfied-blocked";
	/** Set on the WEAK branch (advisory; consumed once by the next prompt). */
	redWeaknessAdvisory: string;
	/** Set on the REJECT branch (the re-author evidence). */
	reauthorEvidence: string;
	/** Nulled on REJECT — the suite must be re-accepted. */
	acceptedRed: AcceptedRedContext | null;
	/** Cleared on REJECT — the snapshot is stale once the suite is re-authored. */
	redTestSnapshot: Map<string, string | null>;
	/** Appended on REJECT (the caller owns the attemptErrors array). */
	attemptErrorsAppend: string | null;
}

export type RedReviewOutcome =
	| { kind: "proceed"; routing: RedReviewRouting }
	| { kind: "restart"; routing: RedReviewRouting }
	| { kind: "terminal"; routing: RedReviewRouting };

/**
 * Adjudicate the in-flight RED review. Never throws — a rejected promise is
 * caught and adjudicated as a review error.
 */
export async function joinRedReview(input: RedReviewJoinInput): Promise<RedReviewOutcome> {
	const { ctx, state, worktreePath, phaseId, review: inFlight, implControl, testFiles, maxParallelReviewRejects, attemptsRun } = input;
	let { parallelReviewRejects, phaseReviewViolations, terminalFailureKind, terminalRedTries, terminalStopReason } = input;

	// v0.3.51: the parallel review can REJECT (agent throw — e.g. a
	// source-read-only boundary violation, run 2026-08-31T03-25-44-485Z 16:29).
	// The store site marks the rejection handled; here it must be adjudicated as
	// a review error (fail-closed re-author), never allowed to escape the stage.
	let review: { control: unknown; error?: string; quarantine?: BoundaryQuarantinePayload; salvagedControl?: Record<string, unknown> | null } | null;
	try {
		review = await inFlight;
	} catch (err) {
		// v0.3.55 security review F1: the structured quarantine payload rides the
		// thrown Error (parent-composed, unforgeable); the message string is
		// display-only and never parsed.
		const q = (err as { quarantine?: BoundaryQuarantinePayload } | null | undefined)?.quarantine;
		// v0.3.73 M1: the boundary throw may carry the delegation's fully-formed
		// control (attached parent-side) — keep it reachable.
		const salvaged = ((err as { salvagedControl?: unknown } | undefined)?.salvagedControl ?? null) as Record<string, unknown> | null;
		review = { control: null, error: String((err as Error)?.message ?? err), quarantine: q, salvagedControl: salvaged && typeof salvaged === "object" ? salvaged : null };
	}

	// v0.3.73 M1 (run 2026-09-05T23-09-55-596Z — six quarantines, 54 min): when
	// EVERY violating path is covered by the concurrent implementer's DECLARED
	// file claims, the violations attribute to the writer lane and the formed
	// verdict is valid evidence about the suite. Salvage it instead of
	// discarding; adjudication proceeds normally. (Dual review AR-73-01: phase
	// test files are EXCLUDED from this predicate — they claim unconditionally
	// and cannot establish that the reviewer wrote nothing; a reviewer-written
	// test file stays unclaimed → no salvage, the v0.3.53 fail-open path keeps
	// the work.)
	if (review?.error && !(review.control as { verdict?: unknown } | null)?.verdict && review.salvagedControl && review.quarantine) {
		const attribution = attributeQuarantinePaths(worktreePath, review.quarantine, implControl, testFiles, { testFilesAsClaims: false });
		if (attribution.declaredAny && attribution.unclaimed.length === 0 && review.salvagedControl.verdict !== undefined) {
			review = { control: review.salvagedControl, error: undefined };
			ctx.log(`Implementation ${phaseId} red-review verdict salvaged (boundary violations fully covered by the implementer's declared claims: ${attribution.claimed.join(", ")}) — adjudicating normally`);
		}
	}
	const verdict = String((review?.control as { verdict?: unknown } | null)?.verdict ?? "").toLowerCase();
	const contradictionList = parseRedContradictions((review?.control ?? null) as Parameters<typeof parseRedContradictions>[0]);

	if (verdict === "strong" && contradictionList.length === 0) {
		ctx.log(`Implementation ${phaseId} RED review: STRONG (no contradictions; adjudicated post-implementation)`);
		return { kind: "proceed", routing: echo(input, {}) };
	}

	if (verdict === "weak" && contradictionList.length === 0) {
		const summary = String((review?.control as { summary?: unknown } | null)?.summary ?? "") || "test assertions are not bound to the scenario's observable behavior";
		ctx.log(`Implementation ${phaseId} RED review: NOT STRONG (weak) — ${summary} (advisory; proceeding — the implementer already ran, the post-RED oracle guards)`);
		return { kind: "proceed", routing: echo(input, { redWeaknessAdvisory: `An independent reviewer rated the RED tests as NOT STRONG: ${summary}.` }) };
	}

	if (!contradictionList.length && review?.error && !verdict) {
		// v0.3.53 F2 (P5): the REVIEWER failed (boundary violation, timeout,
		// spawn error) — a CHECKER failure, not evidence about the suite.
		// v0.3.54 review fix (code F2): fail open ONLY when no verdict text was
		// parsed. A control carrying an off-enum verdict (e.g. "REJECTED" via an
		// unconstrained <control> path) IS evidence about the suite — failing
		// open on it would launder a rejection into a keep; such controls fall to
		// the fail-closed branch below. The pre-0.3.53 fail-closed path discarded
		// correct GREEN work and re-authored the RED, then re-launched the same
		// misbehaving reviewer (8+ violations, 3 phases partial, ~5h: run
		// 2026-08-31T16-03-57-978Z phases 05/06/07). Fail OPEN instead: keep the
		// work, degrade to the deterministic gates, record the finding, count
		// separately; the launch site stops parallel reviews for this phase at 2
		// violations.
		attributeQuarantinedViolations(worktreePath, review.quarantine, implControl, testFiles, (line) => ctx.log(line));
		phaseReviewViolations++;
		const reason = String(review.error).slice(0, 300);
		ctx.log(`Implementation ${phaseId} red-review-incomplete (advisory): ${reason} — GREEN work KEPT (checker failure, not suite evidence); post-RED oracle + deliverable gates remain authoritative${phaseReviewViolations >= 2 ? "; parallel review DISABLED for this phase" : ""}`);
		try {
			recordConvergenceFindings(state, {
				detectedAtStage: "implementation",
				ownerStage: "implementation",
				severity: "low",
				blocking: false,
				title: `Phase ${phaseId} RED review did not complete (reviewer-side failure)`,
				detail: `${reason}. The RED tests were NOT independently reviewed this phase; GREEN acceptance rests on the deterministic oracles. Re-run the review manually if an independent LLM audit is wanted.`,
				evidence: [reason],
				sourceGate: "red-review",
			}, { detectedAtStage: "implementation", ownerStage: "implementation", sourceGate: "red-review" });
		} catch { /* never block the phase on ledger bookkeeping */ }
		return { kind: "proceed", routing: echo(input, { phaseReviewViolations }) };
	}

	// REJECT: discard the GREEN work and re-author the RED with the evidence.
	const summary = contradictionList.length > 0
		? `joint-satisfiability contradiction(s): ${contradictionList.map((c) => c.tests).join("; ")}`
		: review?.error
			? `RED review did not complete (${review.error})`
			: String((review?.control as { summary?: unknown } | null)?.summary ?? "") || "RED review returned no usable verdict";
	const discarded = discardGreenWork(worktreePath, new Set(testFiles));
	const reauthorEvidence = `\n\n## RED REVIEW REJECTED THE SUITE — the tests are jointly unsatisfiable (adjudicated after a parallel implementation pass — that work was discarded, ${discarded.length} file(s) restored)\n${summary}\n${contradictionList.length > 0 ? `Rewrite or remove the contradicting tests: ${contradictionList.map((c) => `${c.tests}${c.lines ? ` (${c.lines})` : ""}: ${c.proof}`).join(" | ")}. Resolve the contradiction in favor of the specification's observable behavior.\n` : ""}Re-author the suite so every test binds the scenario's OBSERVABLE behavior (concrete expected values/outputs/status codes), then re-run.`;
	// Canonical RC8 honesty lines (grep-stable across the serial→parallel change).
	ctx.log(contradictionList.length > 0
		? `Implementation ${phaseId} red-review-rejected: RED review found jointly unsatisfiable tests: ${summary} (parallel join — GREEN work discarded)`
		: `Implementation ${phaseId} red-review-rejected: RED review not strong: ${summary} (parallel join — GREEN work discarded)`);
	const attemptErrorsAppend = contradictionList.length > 0 ? `red-review-rejected: RED review found jointly unsatisfiable tests: ${summary}` : `red-review-rejected: RED review not strong: ${summary}`;
	ctx.log(`Implementation ${phaseId} RED review: REJECTED at join (${summary}) — discarded ${discarded.length} GREEN file(s) (${discarded.slice(0, 6).join(", ")}${discarded.length > 6 ? ", …" : ""}); routing back to RED re-author`);

	parallelReviewRejects++;
	if (parallelReviewRejects > maxParallelReviewRejects) {
		terminalFailureKind = "red-generation";
		terminalRedTries = attemptsRun;
		terminalStopReason = "no-progress";
		ctx.log(`Implementation ${phaseId} stopped after ${maxParallelReviewRejects} parallel-review rejections without a usable suite — continuing to the next phase`);
		return { kind: "terminal", routing: echo(input, { parallelReviewRejects, terminalFailureKind, terminalRedTries, terminalStopReason, reauthorEvidence, acceptedRed: null, redTestSnapshot: new Map(), attemptErrorsAppend }) };
	}
	return { kind: "restart", routing: echo(input, { parallelReviewRejects, reauthorEvidence, acceptedRed: null, redTestSnapshot: new Map(), attemptErrorsAppend }) };
}

/**
 * Build the routing record, carrying in the phase-scoped values each branch
 * does not touch (the v0.4.33 lesson: a returned record must echo what a
 * `continue` preserved implicitly — the STRONG/weak/reviewer-error branches
 * leave acceptedRed and the snapshot UNTOUCHED, so nulling them there would
 * wipe an accepted RED context the loop still needs).
 */
function echo(input: RedReviewJoinInput, over: Partial<RedReviewRouting>): RedReviewRouting {
	return {
		parallelReviewRejects: input.parallelReviewRejects,
		phaseReviewViolations: input.phaseReviewViolations,
		terminalFailureKind: input.terminalFailureKind,
		terminalRedTries: input.terminalRedTries,
		terminalStopReason: input.terminalStopReason,
		acceptedRed: input.acceptedRed,
		redTestSnapshot: input.redTestSnapshot,
		redWeaknessAdvisory: input.redWeaknessAdvisory,
		reauthorEvidence: input.reauthorEvidence,
		attemptErrorsAppend: null,
		...over,
	};
}
