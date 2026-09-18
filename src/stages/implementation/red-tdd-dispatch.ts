/**
 * The tdd-guide dispatch + claim handling — increment 18 of the stage.ts
 * split (the RED oracle pipeline head, re-sliced at the dispatch/oracle seam
 * per the granularity standard — the full head would have needed ~30 inputs).
 *
 * THE BLOCK THIS REPLACES (stage.ts, the RED while loop's head): the tddId
 * naming (first-try vs red-retry), the v0.3.73 M7 HEAD-drift advisory (the
 * 5d4790d incident: a self-commit during the RED call pre-lands unverified
 * work — detected, recorded as a LOW ledger finding, never blocking), the
 * step-scoped dispatch (announce + running step row + agent + the
 * error-reflected step glyph), the v0.3.16 F1 CLAIM DISCIPLINE (an agent
 * that errored or timed out produced NOTHING this try — keeping the previous
 * claim made the log lie, ran the oracle against a ghost file, and poisoned
 * the next retry's hint; the legacy fallback survives only for the normal
 * control-bearing path), and the v0.2.9 G5 streaming log (what tdd-guide DID
 * each try, with the discard annotation).
 *
 * THE SHAPE: a dispatcher module — one record, no loop exits. The record
 * carries the dispatch result, the disciplined claim (testFiles), the new
 * lastClaimedTestFiles (the attempt-scoped let, rebound caller-side), and
 * tddNotCompleted for the downstream fail-closed guard and timeout hint.
 */

import type { StageContext, PipelineState } from "../../types.ts";
import { spawnSync } from "node:child_process";
import { buildTddPrompt, rustDiscipline } from "../../prompts.ts";
import { recordConvergenceFindings } from "../../convergence-ledger.ts";
import { normalizeStringArray } from "./phase-reentry.ts";

/** The agent call result shape used by the step machinery. */
export interface TddDispatchResult {
	control: unknown;
	error?: string;
	text?: string;
}

export interface RedTddDispatchInput {
	ctx: StageContext;
	state: PipelineState;
	/** setup fields. */
	setup: Parameters<typeof buildTddPrompt>[0];
	phase: Parameters<typeof buildTddPrompt>[2];
	phaseId: string;
	attempt: number;
	retries: number;
	/** The caller's attemptDetail(attempt, `try ${retries+1}`) — the step/announce label. */
	redTryDetail: string;
	/** The corrective hint + re-author evidence riding the prompt. */
	redHint: string;
	reauthorEvidence: string;
	/** The language instructions (specialist.value.languageInstructions). */
	lang: string;
	/** The PREVIOUS try's claim (the fallback + the discard target). */
	testFiles: string[];
	announceActivity: (activity?: string, detail?: string) => void;
	emitStep: (label: string, status: "running" | "ok" | "failed", seq: number) => void;
	inStepScope: <T>(seq: number, stepLabel: string, fn: () => Promise<T>) => Promise<T>;
	nextStepSeq: () => number;
}

export interface RedTddDispatchOutput {
	tdd: TddDispatchResult;
	/** The disciplined claim (empty on a non-completed agent). */
	testFiles: string[];
	/** The new claimed-files carry (rebound caller-side when non-empty). */
	lastClaimedTestFiles: string[] | null;
	tddNotCompleted: boolean;
}

/**
 * Dispatch tdd-guide for one RED try. `await` is required (the agent call).
 * The HEAD-drift advisory degrades to a log line on detection failure —
 * never blocks the phase.
 */
export async function dispatchRedTdd(input: RedTddDispatchInput): Promise<RedTddDispatchOutput> {
	const { ctx, state, setup, phase, phaseId, attempt, retries, redTryDetail, redHint, reauthorEvidence, lang, testFiles, announceActivity, emitStep, inStepScope, nextStepSeq } = input;
	const worktreePath = setup.worktreePath;
	const tddId = retries === 0
		? `pipeline.implementation.${phaseId}.tdd.a${attempt}`
		: `pipeline.implementation.${phaseId}.tdd.red${retries}.a${attempt}`;
	const tddStepSeq = nextStepSeq();
	// v0.3.73 M7 (dual review AR-73-05): the RED authoring window gets the
	// same HEAD-drift advisory as the implementer - the incident's 5d4790d
	// (implementation landed BEFORE its RED was authored) was exactly a
	// non-implementer-window self-commit shape.
	const headBeforeTdd = String(spawnSync("git", ["rev-parse", "HEAD"], { cwd: worktreePath, encoding: "utf8", timeout: 5_000 }).stdout ?? "").trim();
	let testFilesLocal = [...testFiles];
	const tdd = await inStepScope(tddStepSeq, `TDD RED (${redTryDetail})`, async () => {
		announceActivity("TDD RED", redTryDetail);
		emitStep(`TDD RED (${redTryDetail})`, "running", tddStepSeq);
		const r = await ctx.agent({ id: tddId, agent: "tdd-guide", prompt: buildTddPrompt(setup, state.classify ?? null, phase, state.spec ?? null, [lang, rustDiscipline(setup)].filter(Boolean).join("\n\n"), state.bdd ?? null) + redHint + reauthorEvidence });
		emitStep(`TDD RED (${redTryDetail})`, r.error ? "failed" : "ok", tddStepSeq);
		return r as TddDispatchResult;
	});
	try {
		const headAfterTdd = String(spawnSync("git", ["rev-parse", "HEAD"], { cwd: worktreePath, encoding: "utf8", timeout: 5_000 }).stdout ?? "").trim();
		if (headBeforeTdd && headAfterTdd && headBeforeTdd !== headAfterTdd) {
			ctx.log(`Implementation ${phaseId} advisory: tdd-guide self-commit detected (HEAD ${headBeforeTdd.slice(0, 8)} -> ${headAfterTdd.slice(0, 8)} during the RED call) - commits are engine-owned; a pre-landed implementation routes through the already-satisfied verification`);
			recordConvergenceFindings(state, {
				detectedAtStage: "implementation",
				ownerStage: "implementation",
				severity: "low",
				blocking: false,
				title: `Phase ${phaseId} tdd-guide self-commit (HEAD moved mid-call)`,
				detail: `HEAD moved ${headBeforeTdd.slice(0, 8)} -> ${headAfterTdd.slice(0, 8)} during the tdd-guide RED call. Commits are engine-owned; self-commits pre-land unverified work and cost RED cycles.`,
				evidence: [headAfterTdd],
				sourceGate: "self-commit",
			}, { detectedAtStage: "implementation", ownerStage: "implementation", sourceGate: "self-commit" });
		}
	} catch { /* advisory detection only - never blocks the phase */ }
	// Reflect an agent error/timeout in the step glyph: a ✓ TDD RED next to
	// an errored call misrepresents what happened (R1 fail-closes the phase
	// regardless, but the dashboard should not show success).
	const filesRaw = (tdd.control as { testFiles?: unknown } | null)?.testFiles;
	// v0.3.16 F1 (RC-T1, run 2026-08-23T02-59-20-670Z): an agent that errored or
	// timed out produced NOTHING this try — keeping the previous try's claim
	// made the log lie ("test files=tests/screen.test.ts" next to
	// "error=timed out"), ran the oracle against a cleanup-deleted ghost file
	// ("No test files found" → misleading red-broken feedback), and poisoned
	// the next retry's hint. A non-completed agent is not a delivery: clear the
	// claim so the fail-closed branch below reports the honest cause and the
	// oracle never runs on stale state. (The legacy fallback ONLY survives for
	// the normal control-bearing path where testFiles may legitimately be
	// absent from a later control — the pre-fix echo.)
	const tddNotCompleted = Boolean(tdd.error) || tdd.control == null;
	if (tddNotCompleted) {
		testFilesLocal = [];
	} else {
		testFilesLocal = filesRaw == null && testFilesLocal.length ? testFilesLocal : normalizeStringArray(filesRaw);
	}
	// v0.2.9 G5: stream what tdd-guide DID (test files + its own summary),
	// so the run log shows the RED work each try, not just the oracle verdict.
	// v0.3.16 F1: the (agent did not complete) annotation makes the discard
	// visible to operators reading the log tail.
	{
		const tddSummary = String((tdd.control as { summary?: unknown } | null)?.summary ?? "").replace(/\s+/g, " ").trim();
		ctx.log(`Implementation ${phaseId} tdd-guide (try ${retries + 1})${tdd.error ? ` error=${tdd.error}` : ""}: test files=${testFilesLocal.join(", ") || "(none)"}${tddNotCompleted ? " (agent did not complete — previous claim discarded)" : ""}${tddSummary ? ` — ${tddSummary.slice(0, 400)}` : ""}`);
	}
	return {
		tdd,
		testFiles: testFilesLocal,
		lastClaimedTestFiles: !tddNotCompleted && testFilesLocal.length ? [...testFilesLocal] : null,
		tddNotCompleted,
	};
}
