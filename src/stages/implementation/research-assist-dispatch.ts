/**
 * The research-assist dispatch (v0.4.34 — increment 6 of the stage.ts split).
 *
 * Source: the block at stage.ts ~1136-1182 (v0.4.33-era line numbers). The
 * engine-mediated research assist (v0.3.87 S4(b), §9/§10 decision 9, §14 ADR 6)
 * is CONSUMED here, immediately
 * before the implementer call (report-always-accompanies-execution: the
 * dispatched ResearchAssistData renders into THIS attempt's corrective block;
 * never report-only). Two trigger sources, one dispatch:
 *   - RED side: armed by a terminal RED-generation failure
 *     (≥ RESEARCH_ASSIST_RED_TRIGGER_TRIES) in a prior §D pass, held in the
 *     stage-run-scope `redAssistArmed` map.
 *   - GREEN side: pending from a faultClassStreak ≥ 2 in this pass, held in
 *     the phase-loop-scope `researchAssistPending`.
 * tdd-guide gets NO assist (implementer-only v1, ADR 6). Per-phase cap 1 (P8);
 * the dispatch consumes the archived needsResearch entries (enrichment —
 * surfaced in the ledger row's enrichedByNeedsResearch).
 *
 * Extraction shape — this increment is straight-line (no continue/break against
 * the phase loop): the block reads the two trigger sources, resolves ONE
 * trigger, and either dispatches (returning the corrective block) or declines
 * (returning null). Three state mutations surround the call, split by owner:
 *   - the module deletes the consumed RED arm by-ref, before trigger
 *     resolution, so an armed trigger never outlives the first implementer
 *     round it targets (deleted on every path, including both declines);
 *   - the module sets the per-phase cap before the await (no TOCTOU window);
 *   - the CALLER clears `researchAssistPending` (phase-loop scope) and clears
 *     the archived needsResearch — both only when `assist.block` is non-null.
 *
 * Two relocations from the inline block, behavior-preserving and acknowledged
 * (NOT byte-identical — the v0.4.33 lesson):
 *   (i) the inline code nulled `researchAssistPending` right after the trigger
 *     ternary read it and BEFORE the guards; the caller now nulls it after the
 *     await. Unobservable: the module captures the pending value synchronously
 *     into the input object, nothing reads the slot during the await, and
 *     runResearchAssist never throws, so the caller's unconditional clear still
 *     runs on every path.
 *   (ii) the inline code cleared the archive and pushed the block
 *     UNCONDITIONALLY; the caller now guards both behind `if (assist.block)`.
 *     Equivalent because the block is contractually never empty
 *     (renderResearchAssistBlock): block-non-null == dispatch ran == archive
 *     consumed. If that ever changes the clear silently stops, bounded by
 *     RESEARCH_ASSIST_ARCHIVE_CAP — degradation is bounded, not unbounded.
 *
 * Never throws: runResearchAssist is engine-owned and bounded; a failure
 * degrades to an honest-empty block, not an exception.
 */

import type { StageContext } from "../../types.ts";
import type { NeedsResearchEntry, ResearchAssistGreenTrigger, ResearchAssistRedArm } from "../research-assist.ts";
import { runResearchAssist } from "../research-assist.ts";

/** The two trigger sources, as the dispatch resolves them. */
export interface ResearchAssistDispatchInput {
	ctx: StageContext;
	specDirectory: string;
	phaseId: string;
	phaseName: string;
	attempt: number;
	/** Stage-run-scope arms (read-then-delete: an armed trigger never outlives
	 * the first implementer round it targets). */
	redAssistArmed: Record<string, ResearchAssistRedArm>;
	/** Phase-loop-scope pending GREEN trigger (cleared on read). */
	researchAssistPending: ResearchAssistGreenTrigger | null;
	/** Per-phase cap ledger, stage-run scope (P8: ≤1 dispatch per phase). */
	phaseResearchAssistUsed: Record<string, boolean>;
	/** The implementer's archived needsResearch entries (consumed on dispatch). */
	needsResearchArchive: NeedsResearchEntry[];
	/** The confirmed RED test files, for the GREEN trigger's failingTargets. */
	testFiles: string[];
}

export interface ResearchAssistDispatchOutcome {
	/** The corrective block to append to the implementer prompt (null = declined). */
	block: string | null;
}

/**
 * Resolve and dispatch the research assist for this attempt. Returns the block
 * to append (or null); the caller owns the map/collection mutations.
 */
export async function dispatchResearchAssist(input: ResearchAssistDispatchInput): Promise<ResearchAssistDispatchOutcome> {
	const { ctx, specDirectory, phaseId, phaseName, attempt, redAssistArmed, researchAssistPending, phaseResearchAssistUsed, needsResearchArchive, testFiles } = input;

	const redArm = redAssistArmed[phaseId] ?? null;
	delete redAssistArmed[phaseId]; // consumed either way — an armed trigger never outlives the first implementer round it targets
	const trigger: { side: "RED" | "GREEN"; triggerDetail: string; contextLines: string[]; failingTargets: string[] } | null = redArm
		? { side: "RED", triggerDetail: `RED generation stuck — ${redArm.tries} terminal RED trie(s) in a prior pass`, contextLines: [`terminal RED failure reasons: ${redArm.detail}`], failingTargets: redArm.testFiles }
		: researchAssistPending
			? { side: "GREEN", triggerDetail: researchAssistPending.triggerDetail, contextLines: researchAssistPending.contextLines, failingTargets: [...testFiles] }
			: null;
	if (!trigger) return { block: null };

	if (phaseResearchAssistUsed[phaseId]) {
		ctx.log(`Implementation ${phaseId} research-assist trigger (${trigger.side}) — per-phase assist cap already spent; proceeding WITHOUT assist (P8)`);
		return { block: null };
	}
	if (!ctx.budget.check()) {
		ctx.log(`Implementation ${phaseId} research-assist trigger (${trigger.side}) — budget exhausted; assist skipped, proceeding WITHOUT assist`);
		return { block: null };
	}
	phaseResearchAssistUsed[phaseId] = true;
	ctx.log(`Implementation ${phaseId} research-assist trigger (${trigger.side}: ${trigger.triggerDetail}) — dispatching research-agent synchronously before attempt ${attempt} (scoped single question, 240s cap; toolBudget resolved from the assist config chain)`);
	const assist = await runResearchAssist({
		ctx,
		specDirectory,
		phaseId,
		phaseName,
		attempt,
		trigger: trigger.side,
		triggerDetail: trigger.triggerDetail,
		contextLines: trigger.contextLines,
		failingTargets: trigger.failingTargets,
		needsResearch: needsResearchArchive,
	});
	ctx.log(`Implementation ${phaseId} research-assist complete (before attempt ${attempt}): outcome=${assist.row.outcome}${assist.row.enrichedByNeedsResearch ? ", enriched by needsResearch" : ""}${assist.row.noUsefulSignal ? ", noUsefulSignal (honest-empty note accompanies the attempt)" : ""}${assist.toolBudgetSent ? ", toolBudget sent" : ", no toolBudget configured"}, ${assist.row.durationMs}ms — the distilled block accompanies this attempt`);
	return { block: assist.block };
}
