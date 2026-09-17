/**
 * The RED-loop judge hand-off (v0.4.32 — increment 5 of the stage.ts split).
 *
 * Source: the block at stage.ts ~965-1097. When the RED loop stalls (a cycle:
 * a signature seen before, or the retry ceiling), ONE verified judge diagnosis
 * runs before the human boundary. Its four routes each either restart the RED
 * loop with the diagnosis appended (allow-scaffold / re-author-tests /
 * fix-environment / guided retry) or terminate the phase (replan-upstream
 * routed, environment-blocked, or honest no-progress).
 *
 * Extraction shape — the increment-5 control-flow conversion (research: Fowler,
 * "Refactoring with Loops and Collection Pipelines"; Startifact, "Refactoring to
 * Multiple Exit Points"): the loop body becomes a function, so every `continue`
 * becomes `return { kind: "restart" … }` and every `break` becomes
 * `return { kind: "terminal" … }`. The reads that were scoped mutable bindings
 * become typed params; the WRITES become the returned JudgeRouting record
 * (by-ref object params for the two collections). No behavior change: the
 * route set, the counters, the log text, the escalation paths and the terminal
 * reasons are byte-identical to the inlined block.
 *
 * The caller interprets exactly two outcomes:
 *   restart  → rebind the scalars from `out`, then `continue` the RED loop
 *   terminal → rebind, then `break` out of it (the phase ends partial)
 */
import type { ControlObj, StageContext } from "../../types.ts";
import { MAX_RED_ENV_RESTARTS, MAX_RED_RETRIES, redEvidenceFailureReasons, restrictRedJudgeRoutes } from "./red-evidence.ts";
import type { RedEvidence } from "./red-evidence.ts";
import { runJudge } from "../judge.ts";

/** Mutable by-ref collections the routing mutates in place. */
export interface JudgeCollections {
	/** Paths the judge blessed as declaration-only scaffolding (G4). */
	redScaffoldApproved: Set<string>;
	/** Per-phase RED signature history; cleared on every judge restart. */
	redProgressHistory: string[];
}

/** Inputs that were reads of loop-scoped state at the inline site. */
export interface JudgeRoutingInput extends JudgeCollections {
	ctx: StageContext;
	state: Record<string, unknown>;
	phaseId: string;
	phaseName: string;
	signature: string;
	seenBefore: boolean;
	attempt: number;
	retries: number;
	/** Routed-without-green counter, drives the route cap (v0.3.53 F2). */
	redJudgeRoutes: number;
	/** fix-environment restarts granted so far (v0.3.30 F3). */
	redEnvRestarts: number;
	redEvidence: RedEvidence;
	testFiles: string[];
	redChangedFiles: string[];
	retryHint: string;
	tddText: string;
	worktreePath: string;
	specDirectory: string;
	specIdentifier: string;
}

/** The WRITE set — every loop-scoped `let` the inline block reassigned. */
export interface JudgeRouting {
	retries: number;
	redHint: string;
	redJudgeDiagnosis: string;
	redJudgeEvidenceLabel: string;
	/** Routed-without-green counter after this call (drives the route cap). */
	redJudgeRoutes: number;
	/** fix-environment restarts granted after this call (v0.3.30 F3). */
	redEnvRestarts: number;
	terminalStopReason: "budget" | "no-progress" | "failed" | "environment-blocked" | "phase-attempt-cap" | "phase-wall" | "wall-fuse" | "inherited-red" | "declared-handoff" | "red-weakening";
	/** Only present on the terminal replan-upstream route. */
	attemptErrorsAppend?: string;
}

export type JudgeRoutingOutcome =
	| { kind: "restart"; routing: JudgeRouting }
	| { kind: "terminal"; routing: JudgeRouting };

/**
 * Interpret the judge verdict for a stalled RED loop. Pure of disk mutation
 * except the two by-ref collections (scaffold approval + history clear, both
 * also performed on the retry paths in the original block). Never throws —
 * every routing failure degrades to the honest terminal no-progress break.
 */
export async function routeRedJudge(input: JudgeRoutingInput): Promise<JudgeRoutingOutcome> {
	const { ctx, state, phaseId, phaseName, signature, seenBefore, attempt, redEvidence, testFiles, redChangedFiles, retryHint, tddText } = input;
	let { retries, redJudgeRoutes, redEnvRestarts } = input;

	const judgeOut = await runJudge(ctx, {
		scope: `stage9.red-no-progress.${phaseId}`,
		signature,
		worktreePath: input.worktreePath,
		specDirectory: input.specDirectory,
		context: [
			`## RED evidence (attempt ${attempt}, retry ${retries + 1})`,
			`status: ${redEvidence.status}`,
			`reasons: ${redEvidenceFailureReasons(redEvidence).join("; ") || redEvidence.reason || "n/a"}`,
			`test files: ${testFiles.join(", ") || "n/a"}`,
			"## Oracle output tails",
			...(redEvidence.diagnostics ?? []).map((d) => `[${d.plan.argv.join(" ")} exit=${d.exitCode ?? "?"}] ${d.outputTail.slice(0, 2000)}`),
			"## TDD agent's last text (tail)",
			tddText.slice(-2000) || "(none)",
			"## Files changed during RED",
			redChangedFiles.join("\n") || "(none)",
		].join("\n"),
		allowedRoutes: (() => {
			const base = ["re-author-tests", "fix-environment", "replan-upstream", "allow-scaffold"] as const;
			const restricted = restrictRedJudgeRoutes(redJudgeRoutes, base);
			if (restricted.length < base.length) ctx.log(`Implementation ${phaseId} red judge routes capped: ${redJudgeRoutes} routed intervention(s) without green — forcing fix-environment (stop resampling, start diagnosing the environment)`);
			return restricted;
		})(),
		outputTails: [...(redEvidence.diagnostics ?? []).map((d) => d.outputTail), tddText],
	});
	if (judgeOut.status === "routed") redJudgeRoutes++;

	// v0.2.8 G4 (allow-scaffold): declaration-only scaffolding the test needs to
	// compile and still fail RED. Re-admit and restart; the oracle still guards.
	if (judgeOut.status === "routed" && judgeOut.verdict.route === "allow-scaffold") {
		for (const f of redChangedFiles) input.redScaffoldApproved.add(f);
		input.redProgressHistory.length = 0;
		retries++;
		const redHint = `\n\n## Judge approved your scaffolding (allow-scaffold)\n${judgeOut.verdict.diagnosis}\nKeep the declaration-only scaffolding you created (do NOT implement the behavior); make the test COMPILE and still FAIL on its assertion (a valid RED). Evidence: ${judgeOut.verdict.evidence.map((e) => `${e.file}: ${e.quote}`).join(" | ")}`;
		ctx.log(`Implementation ${phaseId} judge route=allow-scaffold: approved declaration-only scaffolding (${redChangedFiles.length} path(s)) — re-admitting through the RED boundary; oracle still guards`);
		return { kind: "restart", routing: { retries,
				redJudgeRoutes, redEnvRestarts, redHint, redJudgeDiagnosis: "", redJudgeEvidenceLabel: "", terminalStopReason: "failed" } };
	}

	// v0.2.8 G1 (replan-upstream): an UPSTREAM artifact is defective. Route back
	// to the owning stage via the replan circuit. Unroutable ⇒ fall through to
	// the human boundary. Never throws.
	if (judgeOut.status === "routed" && judgeOut.verdict.route === "replan-upstream") {
		const finding = {
			id: `red-replan-${phaseId}`,
			title: `RED cannot converge — upstream artifact defect (phase "${phaseName}")`,
			detail: judgeOut.verdict.diagnosis,
			severity: "high",
			recommendation: judgeOut.verdict.evidence.map((e) => `${e.file}: ${e.quote}`).join(" | "),
			file: judgeOut.verdict.evidence[0]?.file,
		};
		let replanned = false;
		// M5 documented exception: NO structured ownerStage — the owner is
		// resolved by the replan LEAD (an LLM call) the inline planner can't serve.
		const { triggerReplanForFindings } = await import("../../replan/replan.ts");
		try { replanned = await triggerReplanForFindings(state, ctx, [finding], "implementation-red", input.specIdentifier); } catch { replanned = false; }
		if (replanned) {
			const redJudgeDiagnosis = `${judgeOut.verdict.diagnosis}\nEvidence: ${finding.recommendation}`;
			ctx.log(`Implementation ${phaseId} judge route=replan-upstream: routed the upstream-artifact defect back via REPLAN — the run will revise the owning stage and re-enter — ${judgeOut.verdict.diagnosis.slice(0, 200)}`);
			return { kind: "terminal", routing: { retries,
				redJudgeRoutes, redEnvRestarts, redHint: "", redJudgeDiagnosis, redJudgeEvidenceLabel: "", terminalStopReason: "no-progress" } };
		}
		ctx.log(`Implementation ${phaseId} judge route=replan-upstream: no routable owner / replan budget exhausted — falling through to the human boundary with the diagnosis`);
	}

	if (judgeOut.status === "routed" && (judgeOut.verdict.route === "re-author-tests" || judgeOut.verdict.route === "fix-environment")) {
		// v0.3.30 F3: one fix-environment restart is granted for genuinely
		// in-repo repairs; a SECOND means the fix is outside the RED loop's reach
		// — terminate honestly instead of burning budget.
		if (judgeOut.verdict.route === "fix-environment" && redEnvRestarts >= MAX_RED_ENV_RESTARTS) {
			const redJudgeDiagnosis = `${judgeOut.verdict.diagnosis}\nEvidence: ${judgeOut.verdict.evidence.map((e) => `${e.file}: ${e.quote}`).join(" | ")}`;
			ctx.log(`Implementation ${phaseId} RED generation stopped — environment-blocked: ${redEnvRestarts} fix-environment restart(s) granted without progress; the fix is outside the RED loop's reach — ${judgeOut.verdict.diagnosis.slice(0, 200)}`);
			return { kind: "terminal", routing: { retries,
				redJudgeRoutes, redEnvRestarts, redHint: "", redJudgeDiagnosis, redJudgeEvidenceLabel: "", terminalStopReason: "environment-blocked" } };
		}
		if (judgeOut.verdict.route === "fix-environment") redEnvRestarts++;
		input.redProgressHistory.length = 0;
		retries++;
		const redHint = `\n\n## Judge diagnosis (verified evidence — act on it)\n${judgeOut.verdict.diagnosis}\n${judgeOut.verdict.route === "fix-environment" ? "The judge classified this as an ENVIRONMENT problem. Repair it INSIDE this worktree only (install dependencies, fix toolchain/config files that live in this repository), then author the RED test. If the fix requires anything OUTSIDE this repository (a capability the harness itself lacks), do NOT hunt for, read, or modify external files — state the limitation in your result and stop; the harness will escalate." : "The judge classified the RED tests themselves as contradictory or unsatisfiable: re-author the affected tests into a satisfiable form that still pins the same behavior."}\nEvidence: ${judgeOut.verdict.evidence.map((e) => `${e.file}: ${e.quote}`).join(" | ")}`;
		ctx.log(`Implementation ${phaseId} judge route=${judgeOut.verdict.route}: restarting RED with the diagnosis`);
		return { kind: "restart", routing: { retries,
				redJudgeRoutes, redEnvRestarts, redHint, redJudgeDiagnosis: "", redJudgeEvidenceLabel: "", terminalStopReason: "failed" } };
	}

	// v0.2.8 G1 fall-through / escalate-now / discarded / degraded: the terminal
	// no-progress path, carrying the diagnosis if the judge rendered one.
	let redJudgeDiagnosis = "";
	let redJudgeEvidenceLabel = "";
	if (judgeOut.status === "routed" || judgeOut.status === "escalate") {
		redJudgeDiagnosis = `${judgeOut.verdict.diagnosis}\nEvidence: ${judgeOut.verdict.evidence.map((e) => `${e.file}: ${e.quote}`).join(" | ")}`;
		redJudgeEvidenceLabel = judgeOut.status === "escalate" && judgeOut.verdict.evidence.length === 0 ? "escalated — evidence unverified" : "verified evidence";
	}

	const why = seenBefore
		? `RED generation is oscillating (a prior failure state recurred) after ${retries + 1} tries`
		: `RED generation did not converge within ${MAX_RED_RETRIES} tries`;
	ctx.log(`Implementation ${phaseId} RED generation stopped — ${why}: ${redEvidenceFailureReasons(redEvidence).join("; ") || redEvidence.reason || redEvidence.status}`);

	// HITL escalation (parity with the implementation no-progress path).
	const escalate = (ctx as unknown as ControlObj & { options?: { escalate?: import("../../types.ts").Escalate } }).options?.escalate;
	if (escalate) {
		try {
			const { runEscalation, applyRetryDecision } = await import("../../escalation.ts");
			const failure: import("../../types.ts").EscalationFailure = {
				kind: "stagnation",
				stage: "implementation-red",
				message: `RED test generation for phase "${phaseName}" is not converging (${why}). This is typically a spec or test-toolchain issue — e.g. the target package has no runnable test command, so a new test cannot be observed to fail. Inspect the recurring RED evidence or provide guidance before retrying.${redJudgeDiagnosis ? `\n\nJUDGE DIAGNOSIS (${redJudgeEvidenceLabel}):\n${redJudgeDiagnosis}` : ""}`,
				severity: "soft",
				findings: (redEvidenceFailureReasons(redEvidence).length ? redEvidenceFailureReasons(redEvidence) : [redEvidence.reason ?? redEvidence.status]).slice(0, 12).map((r) => ({ file: null, severity: null, title: r })),
				worktreePath: input.worktreePath,
				specDirectory: input.specDirectory,
			};
			const decision = await runEscalation(state, failure, escalate);
			if (decision) {
				applyRetryDecision(state, decision, { worktreePath: input.worktreePath, specDirectory: input.specDirectory });
				if (decision.choice === "retry-with-guidance" && ctx.budget.check()) {
					input.redProgressHistory.length = 0;
					retries++;
					ctx.log(`Implementation ${phaseId} RED no-progress escalation: retrying with user guidance`);
					return { kind: "restart", routing: { retries,
				redJudgeRoutes, redEnvRestarts, redHint: retryHint, redJudgeDiagnosis, redJudgeEvidenceLabel, terminalStopReason: "failed" } };
				}
			}
		} catch { /* never-throw: fall through to the terminal break */ }
	}

	return { kind: "terminal", routing: { retries,
				redJudgeRoutes, redEnvRestarts, redHint: "", redJudgeDiagnosis, redJudgeEvidenceLabel, terminalStopReason: "no-progress" } };
}
