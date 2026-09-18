/**
 * The implementer dispatch + structured-claim parse — increment 21 of the
 * stage.ts split (the assembly was increment 20; this is the CALL half).
 *
 * THE BLOCK THIS REPLACES (stage.ts, from the implStepSeq through the
 * implementer streaming log): the v0.3.73 M7 HEAD-drift advisory (a
 * mid-phase implementer self-commit pre-lands unverified work — detected,
 * LOW ledger finding, never blocking), the step-scoped implementer dispatch
 * (announce + running row + the agent call with the EXPLICIT controlKeys
 * contract and the empty-array allowances, + the error-reflected glyph),
 * parseStructuredChanges (spec-11 AC-06/AC-10), the implDefects capture,
 * the v0.3.87 needsResearch ARCHIVE with its P8 bounded cap (oldest drop
 * first, logged honestly), implTextTail, the internal-runtime-claim filter
 * into projectStructured, the filesModified append (first-seen order), and
 * the v0.2.9 G5 streaming log (created/modified/deleted + testsPass +
 * summary).
 *
 * THE SHAPE: a dispatcher — one record {impl, projectStructured,
 * implDefects, implTextTail}. The by-ref surfaces (needsResearchArchive
 * push/splice, filesModified append) mutate the caller's arrays in place,
 * exactly as inline did.
 */

import type { StageContext, PipelineState } from "../../types.ts";
import { spawnSync } from "node:child_process";
import { recordConvergenceFindings } from "../../convergence-ledger.ts";
import { IMPLEMENTER_CONTROL_KEYS, parseStructuredChanges, parseTestDefects, trimImplementerText } from "./phase-reentry.ts";
import { parseNeedsResearch, RESEARCH_ASSIST_ARCHIVE_CAP, type NeedsResearchEntry } from "../research-assist.ts";
import { isInternalRuntimeClaim } from "../../tracking.ts";
import type { StructuredChanges } from "../../tracking.ts";
import type { TestDefect } from "./phase-reentry.ts";

export interface ImplementerDispatchInput {
	ctx: StageContext;
	state: PipelineState;
	/** setup fields. */
	worktreePath: string;
	phaseId: string;
	attempt: number;
	/** The joined corrective prompt. */
	implPrompt: string;
	/** By-ref surfaces (mutated in place): the assist archive + the files-modified carry. */
	needsResearchArchive: NeedsResearchEntry[];
	filesModified: string[];
	attemptDetail: (attempt: number, extra?: string) => string;
	announceActivity: (activity?: string, detail?: string) => void;
	emitStep: (label: string, status: "running" | "ok" | "failed", seq: number) => void;
	inStepScope: <T>(seq: number, stepLabel: string, fn: () => Promise<T>) => Promise<T>;
	nextStepSeq: () => number;
}

export interface ImplementerDispatchResult {
	/** The raw agent result (control/error/text — the RC2 join reads impl.control). */
	impl: { control: unknown; error?: string; text?: string };
	/** The internal-runtime-claim-FILTERED structured footprint. */
	projectStructured: StructuredChanges;
	/** The RAW parse — the change-tracker probe's claimed field (audit parity, cf. gate-suite). */
	rawStructured: StructuredChanges;
	implDefects: TestDefect[];
	implTextTail: string;
}

/**
 * Dispatch the implementer for one attempt. `await` is required (the agent
 * call). The HEAD-drift advisory degrades to a log line — never blocks.
 */
export async function dispatchImplementer(input: ImplementerDispatchInput): Promise<ImplementerDispatchResult> {
	const { ctx, state, worktreePath, phaseId, attempt, implPrompt, needsResearchArchive, filesModified, attemptDetail, announceActivity, emitStep, inStepScope, nextStepSeq } = input;
	const implStepSeq = nextStepSeq();
	// v0.3.73 M7 (run 2026-09-05T23-09-55-596Z: 2e92da3/5d4790d): detect a
	// mid-phase implementer self-commit — HEAD moved across the call window.
	// Advisory (P10 honest log + low finding): the deterministic commit and
	// the v0.3.66/67 already-satisfied escapes keep the run safe, but a
	// self-commit pre-lands unverified work and costs a RED cycle.
	const headBeforeImpl = String(spawnSync("git", ["rev-parse", "HEAD"], { cwd: worktreePath, encoding: "utf8", timeout: 5_000 }).stdout ?? "").trim();
	const impl = await inStepScope(implStepSeq, `Implementation (${attemptDetail(attempt)})`, async () => {
		announceActivity("Implementation", attemptDetail(attempt));
		emitStep(`Implementation (${attemptDetail(attempt)})`, "running", implStepSeq);
		const r = await ctx.agent({
			id: `pipeline.implementation.${phaseId}.impl.a${attempt}`,
			agent: "implementer",
			prompt: implPrompt,
			// Fix 1a: the implementer's control contract is declared EXPLICITLY
			// (parity with verify.ts:430) so the challenge channel never depends
			// on prose parsing. `testDefects` MUST be declared for the model to
			// emit it (v0.1.52: the undeclared key made the channel unreachable
			// while a phantom `lines` key got filled instead).
			controlKeys: IMPLEMENTER_CONTROL_KEYS,
			// Fix 1c/1d: `testDefects: []` is the explicit "no proven defect"
			// value — it must NOT trigger a corrective re-prompt in either
			// backend. Absence (undefined) still does.
			// v0.3.87 S4(b): `needsResearch: []` rides the same contract — the
			// explicit "no research question" value, never a violation.
			allowEmptyArraysFor: ["testDefects", "needsResearch"],
		});
		emitStep(`Implementation (${attemptDetail(attempt)})`, r.error ? "failed" : "ok", implStepSeq);
		return r;
	});
	// spec-11 AC-06/AC-10: the implementer's claimed change set is now STRUCTURED
	// ({filesCreated, filesModified, filesDeleted}). parseStructuredChanges reads
	// it (and back-tolerates the legacy flat filesModified array). The flat
	// summary list derives from filesCreated ∪ filesModified — deleted is
	// EXCLUDED (a deleted file is not a "modified" display entry). dedupe via
	// the existing `filesModified.includes` guard (first-seen order preserved).
	try {
		const headAfterImpl = String(spawnSync("git", ["rev-parse", "HEAD"], { cwd: worktreePath, encoding: "utf8", timeout: 5_000 }).stdout ?? "").trim();
		if (headBeforeImpl && headAfterImpl && headBeforeImpl !== headAfterImpl) {
			ctx.log(`Implementation ${phaseId} advisory: implementer self-commit detected (HEAD ${headBeforeImpl.slice(0, 8)} → ${headAfterImpl.slice(0, 8)} during the call) — commits are engine-owned; the deterministic commit still runs after the gates, and a pre-landed implementation routes through the already-satisfied verification`);
			recordConvergenceFindings(state, {
				detectedAtStage: "implementation",
				ownerStage: "implementation",
				severity: "low",
				blocking: false,
				title: `Phase ${phaseId} implementer self-commit (HEAD moved mid-call)`,
				detail: `HEAD moved ${headBeforeImpl.slice(0, 8)} → ${headAfterImpl.slice(0, 8)} during the implementer call. Commits are engine-owned; self-commits pre-land unverified work and cost RED cycles.`,
				evidence: [headAfterImpl],
				sourceGate: "self-commit",
			}, { detectedAtStage: "implementation", ownerStage: "implementation", sourceGate: "self-commit" });
		}
	} catch { /* advisory detection only — never blocks the phase */ }
	const structured = parseStructuredChanges(impl.control);
	// Capture the implementer's diagnosis for the evidence-carrying RED
	// re-author (unsatisfiable-test loop). `testDefects` is the structured,
	// preferred signal; the trimmed .text tail is a fallback so a model
	// that ignores the contract still surfaces its reasoning. Kept per
	// phase (latest attempt) and consumed when RED is re-authored.
	const implDefects = parseTestDefects(impl.control);
	// v0.3.87 S4(b) (decision 9): ARCHIVE the implementer's optional
	// needsResearch entries — the field NEVER dispatches by itself; the
	// in-memory per-phase archive enriches the assist QUESTION when the
	// engine gate trips. Bounded (P8): oldest entries drop first, logged
	// honestly; malformed entries were already rejected by the parser.
	{
		const before = needsResearchArchive.length;
		needsResearchArchive.push(...parseNeedsResearch(impl.control, (m) => ctx.log(`Implementation ${phaseId} ${m}`)));
		if (needsResearchArchive.length > RESEARCH_ASSIST_ARCHIVE_CAP) {
			const dropped = needsResearchArchive.length - RESEARCH_ASSIST_ARCHIVE_CAP;
			needsResearchArchive.splice(0, dropped);
			ctx.log(`Implementation ${phaseId} research-assist archive bounded (${RESEARCH_ASSIST_ARCHIVE_CAP}): dropped ${dropped} oldest needsResearch entr(ies)`);
		}
		if (needsResearchArchive.length > before) ctx.log(`Implementation ${phaseId} needsResearch: ${needsResearchArchive.length} entr(ies) archived (no dispatch — the engine gate has not tripped; the field alone never triggers research)`);
	}
	const implTextTail = trimImplementerText(impl.text);
	const projectStructured: StructuredChanges = {
		filesCreated: structured.filesCreated.filter((f) => !isInternalRuntimeClaim(f)),
		filesModified: structured.filesModified.filter((f) => !isInternalRuntimeClaim(f)),
		filesDeleted: structured.filesDeleted.filter((f) => !isInternalRuntimeClaim(f)),
	};
	for (const f of [...projectStructured.filesCreated, ...projectStructured.filesModified]) {
		if (!filesModified.includes(f)) filesModified.push(f);
	}
	// v0.2.9 G5: stream what the implementer DID (claimed changes + summary +
	// tests-pass count), so the run log shows each attempt's work, not just gates.
	{
		const implSummary = String((impl.control as { summary?: unknown } | null)?.summary ?? "").replace(/\s+/g, " ").trim();
		const tp = (impl.control as { testsPassCount?: unknown } | null)?.testsPassCount;
		ctx.log(`Implementation ${phaseId} implementer (attempt ${attempt})${impl.error ? ` error=${impl.error}` : ""}: created=[${projectStructured.filesCreated.join(", ") || "none"}] modified=[${projectStructured.filesModified.join(", ") || "none"}] deleted=[${projectStructured.filesDeleted.join(", ") || "none"}]${tp != null ? ` testsPass=${String(tp)}` : ""}${implSummary ? ` — ${implSummary.slice(0, 400)}` : ""}`);
	}
	return { impl, projectStructured, rawStructured: structured, implDefects, implTextTail };
}
