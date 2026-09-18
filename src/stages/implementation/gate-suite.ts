/**
 * The phase gate suite — increment 13 of the stage.ts split.
 *
 * THE BLOCK THIS REPLACES (stage.ts, the sequential core between the
 * protection gate and the TDD oracle): the HARD build-gate oracle (never trust
 * a QA agent's self-report), the RC12c out-of-scope-edit audit (a LOW
 * non-blocking ledger finding — visible drift, never silent), the AR-02
 * correlation tag, the deliverable contract check with the spec-10 claimed-
 * files bridge (AC-09), the git cross-check change gate (per-attempt probe),
 * and the symbol/hollow-file gate — followed by the CROSS-PHASE DELIVERABLE
 * LEAK check (run 2026-08-27: phase-2 edited phase-3's declared deliverable
 * out of scope and phase-3 burned 9 tries) which BLOCKS by reverting the
 * leaked paths and extends the phase-boundary revert statistics.
 *
 * THE EXTRACTION SHAPE (unlike increments 7–12): this region has NO loop
 * exits — it is sequential data-prep with side effects. There is no outcome
 * union; the module returns ONE wide record (GateSuiteResult) and the caller
 * rebinds the loop-scoped bindings from it. The only in-place mutations are
 * the worktree leak revert (restorePaths, exactly where inline reverted) and
 * the ledger findings (recordConvergenceFindings on the caller's state).
 *
 * THE BOUNDARY-STAT CONTRACT: inline, the leak block mutated the phase-scoped
 * boundaryRevertHits/Owners/Files lets directly. The module cannot reach them,
 * so the record carries the DELTA (revert hits + the NEW owners/files) and the
 * caller applies the same increment/union semantics — preserving the exact
 * values the (already-extracted) no-progress valve reads.
 */

import type { StageContext, PipelineState } from "../../types.ts";
import { runBuildGate, runDeliverableCheck, resetDeliverableCheckCache, computeChangeGate, computeSymbolGate, buildGateCorrelationLine, type BuildGateResult, type DeliverableContract, type GateOptions } from "../../build-runner.ts";
import { appendGateChecked } from "../../runlog.ts";
import { recordConvergenceFindings } from "../../convergence-ledger.ts";
import { phaseClauseFiles } from "../plan-feasibility.ts";
import type { ChangeRecord, StructuredChanges } from "../../tracking.ts";
import type { ChangeTracker } from "../../tracking.ts";
import { laterPhaseDeliverableHits, laterPhaseDeliverableOwners, leakNorm } from "./phase-reentry.ts";
import { trackerOutofScopeEdits, restorePaths } from "./red-evidence.ts";

export interface GateSuiteInput {
	ctx: StageContext;
	state: PipelineState;
	worktreePath: string;
	defaultBranch: string | undefined;
	/** The spec's declared language (the symbol gate). */
	language: string | undefined;
	phaseId: string;
	attempt: number;
	/** The phase contract (the clause grammar derives declaredScope); untyped
	 *  at this seam — the inline code cast it the same way. */
	phase: unknown;
	/** The plan's phases (the cross-phase leak owner lookup). */
	phases: Array<Record<string, unknown>>;
	/** This phase's index. */
	idx: number;
	testFiles: string[];
	/** The implementer's structured footprint (internal-runtime claims filtered). */
	projectStructured: StructuredChanges;
	/** The RAW parse — the change-tracker probe's claimed field (audit parity:
	 *  the inline region passed the unfiltered parse here; every gate is
	 *  neutral to the difference, but the persisted jsonl claims stay exact). */
	rawStructured: StructuredChanges;
	/** The active change tracker (null → trivial change-gate pass). */
	tracker: ChangeTracker | null;
	announceActivity: (activity?: string, detail?: string) => void;
	attemptDetail: (attempt: number, extra?: string) => string;
}

/** The sequential suite's outputs — every loop-scoped binding the attempt
 *  loop's downstream reads. */
export interface GateSuiteResult {
	gate: BuildGateResult;
	/** The phase's declared scope (clause grammar, leakNorm-parity). */
	declaredScope: Set<string>;
	/** gate.pass || gate.inScopePass. */
	buildGreen: boolean;
	/** The spec-declared contract UNIONED with the implementer's created files. */
	bridgedDeliverables: DeliverableContract;
	deliverableCheck: ReturnType<typeof runDeliverableCheck>;
	phaseChangeRec: ChangeRecord | null;
	changeGate: ReturnType<typeof computeChangeGate>;
	symbolGate: ReturnType<typeof computeSymbolGate>;
	/** Changed-not-claimed files (advisory only, SCENARIO-014). */
	advisory: string[];
	/** The cross-phase leak delta: revert hits + the NEW owners/files for the
	 *  caller's boundary-statistic unions. Empty when no leak fired. */
	leak: { revertHits: number; owners: string[]; files: string[] };
}

/**
 * Run the sequential gate-suite core (build → RC12c audit → deliverable →
 * change → symbol → cross-phase leak). Never throws on ledger bookkeeping
 * (the findings appends degrade inside); the leak revert uses restorePaths'
 * own per-command guards.
 */
export function runGateSuite(input: GateSuiteInput): GateSuiteResult {
	const { ctx, state, worktreePath, defaultBranch, language, phaseId, attempt, phase, phases, idx, testFiles, projectStructured, rawStructured, tracker, announceActivity, attemptDetail } = input;

	// HARD test oracle (vacuous-pass risk). Non-fatal when nothing is
	// detectable (greenfield): ran is empty and pass is true.
	announceActivity("Build gate", attemptDetail(attempt));
	const gate = runBuildGate(worktreePath, { gate: (state.spec?.gate) as GateOptions | undefined, signal: ctx.signal, defaultBranch });
	appendGateChecked(state, "phase-build", gate, "implementation");
	ctx.log(`Implementation ${phaseId} build-gate ${gate.pass ? "PASS" : "FAIL"} (ran: ${gate.ran.join(", ") || "no commands"})`);
	// RC12c: out-of-scope edits — a LOW non-blocking finding so the drift is
	// visible in the ledger instead of silently persisting in the worktree.
	// v0.3.80 B1 (P6): own-scope derives from the validator's canonical clause
	// grammar — a co-owned file declared through ANY clause form is never
	// misclassified as a later-phase leak.
	const declaredScope = new Set<string>(phaseClauseFiles(phase as never).map(leakNorm)); // review P3: leakNorm parity (trim + trailing slash) with the leak-side set
	const outOfScope = [...declaredScope].length
		? trackerOutofScopeEdits(tracker, worktreePath, declaredScope, testFiles)
		: [];
	if (outOfScope.length > 0) {
		ctx.log(`Implementation ${phaseId} out-of-scope edits (non-blocking, recorded): ${outOfScope.join(", ")}`);
		try {
			recordConvergenceFindings(state, {
				detectedAtStage: "implementation",
				ownerStage: "implementation",
				severity: "low",
				blocking: false,
				title: `Phase ${phaseId} edited files outside its declared scope`,
				detail: `The implementer modified ${outOfScope.slice(0, 5).join(", ")} which are not among this phase's declared deliverables. Often a workaround for an unrelated environmental failure (missing dependencies in a fresh worktree) — check the bootstrap log before accepting these edits.`,
				evidence: outOfScope.slice(0, 8),
				sourceGate: "phase-build",
				recommendation: "Review the out-of-scope edits; if they work around an environmental failure, revert them and fix the environment (dependency bootstrap) instead.",
			}, { detectedAtStage: "implementation", ownerStage: "implementation", sourceGate: "phase-build" });
		} catch { /* never block the phase on ledger bookkeeping */ }
	}
	// AR-02: emit the pi session/model correlation tag to the run trace.
	const corr = buildGateCorrelationLine(gate);
	if (corr) ctx.log(corr);
	// DELIVERABLE CONTRACT (AC-03): AND-ed with the gate so the phase is only
	// GREEN when the declared files/contains/not-contains/tests are ALSO
	// satisfied. RUN-BOUNDARY RESET: clear the test-list cache before EACH
	// attempt so a freshly-added test is seen (a stale cache false-negatives
	// requireTests forever). SKIP the test-lister when the build FAILED.
	resetDeliverableCheckCache();
	const buildGreen = gate.pass || gate.inScopePass;
	// spec-10 deliverable bridge (AC-09): UNION the implementer's created files
	// into requireFiles (deduped, first-seen order — inlined so the stage does
	// not depend on an un-mocked build-runner export; the bridge is pure data
	// prep).
	const baseDeliverables = ((phase as { deliverables?: DeliverableContract }).deliverables ?? {}) as DeliverableContract;
	const bridgedDeliverables: DeliverableContract = {
		...baseDeliverables,
		requireFiles: Array.from(new Set([
			...(baseDeliverables.requireFiles ?? []),
			...projectStructured.filesCreated,
		])),
	};
	announceActivity("Deliverable check", attemptDetail(attempt));
	const deliverableCheck = runDeliverableCheck(worktreePath, bridgedDeliverables, { signal: ctx.signal, skipTests: !buildGreen, defaultBranch });
	ctx.log(`Implementation ${phaseId} deliverable-check ${deliverableCheck.pass ? "PASS" : "FAIL"} (missing: ${deliverableCheck.missing.join("; ") || "none"}; ran: ${deliverableCheck.ran.join(", ") || "none"})`);
	// Git cross-check GATE (AC-07/AC-08): per-attempt probe so a retry that
	// wires the claimed file flips the verdict. NEVER throws; degrades to a
	// pass when git is unavailable. No tracker / never ended → null record →
	// trivial pass.
	let phaseChangeRec: ChangeRecord | null = null;
	announceActivity("Change check", attemptDetail(attempt));
	if (tracker) {
		// Per-attempt PROBE (compute + store, no jsonl append); the bracket is
		// closed EXACTLY ONCE via commitEnd after the attempt loop.
		phaseChangeRec = tracker.probeEnd("phase", phaseId, rawStructured);
	}
	const changeGate = computeChangeGate(phaseChangeRec);
	// Symbol/hollow-file gate (silent-empty-success killer): a claimed source
	// deliverable that EXISTS but contains NO code symbols is rejected here.
	// Never throws; degrades to pass on unreadable files / unknown language.
	announceActivity("Symbol check", attemptDetail(attempt));
	const symbolGate = computeSymbolGate(worktreePath, [...projectStructured.filesCreated, ...projectStructured.filesModified], language);
	ctx.log(`Implementation ${phaseId} symbol-check ${symbolGate.pass ? "PASS" : "FAIL"} (hollow: ${symbolGate.hollowFiles.join("; ") || "none"})`);
	// Advisory-only (SCENARIO-014): changed-not-claimed files (under-reporting)
	// are surfaced but NEVER fail the gate.
	const advisory = phaseChangeRec?.crossCheck?.changedNotClaimed ?? [];
	// CROSS-PHASE DELIVERABLE LEAKAGE (run 2026-08-27): BLOCKING — revert the
	// leaked paths (PRE-commit, so the revert is effective) and name the owner
	// phases. Runs over the attempt's FULL git delta (claimed or not), minus
	// this phase's own declared scope.
	const gitActual = phaseChangeRec?.gitActual;
	const changedAll = gitActual
		? [...(gitActual.created ?? []), ...(gitActual.modified ?? []), ...(gitActual.deleted ?? [])]
		: advisory;
	const inOwnScope = changedAll.filter((f) => declaredScope.has(f) || declaredScope.has(f.replace(/\\/g, "/").replace(/^\.\//, "")));
	const leakOwners = laterPhaseDeliverableOwners(changedAll.filter((f) => !inOwnScope.includes(f)), phases, idx);
	const leak: GateSuiteResult["leak"] = { revertHits: 0, owners: [], files: [] };
	if (leakOwners.length > 0) {
		const leakFiles = laterPhaseDeliverableHits(changedAll.filter((f) => !inOwnScope.includes(f)), phases, idx);
		leak.revertHits = 1;
		leak.owners = leakOwners;
		leak.files = leakFiles;
		ctx.log(`Implementation ${phaseId} BLOCKING: changed-not-claimed file(s) ${leakFiles.join(", ")} are DECLARED DELIVERABLES of later phase(s) ${leakOwners.join(", ")} — phase-boundary leak; reverting them (this phase's scope stands, later phases redo the work with an honest RED). ROUTE TO APPROVAL: if these files genuinely belong to this phase's work, the phase contract must DECLARE them (co-ownership — any clause form counts) or the plan must be revised to order the introduction before this phase; steer guidance to revise the plan rather than retrying blind.`);
		restorePaths(worktreePath, leakFiles);
	}
	if (advisory.length) {
		ctx.log(`Implementation ${phaseId} advisory: ${advisory.length} changed-not-claimed file(s): ${advisory.join(", ")}`);
	}
	// Evidence (AC-10): the ground-truth actual change counts.
	const ga = phaseChangeRec?.gitActual ?? null;
	if (ga) {
		const c = ga.created?.length ?? 0;
		const m = ga.modified?.length ?? 0;
		const d = ga.deleted?.length ?? 0;
		ctx.log(`Implementation ${phaseId} 📝 ${c + m + d} files changed (${c}C/${m}M/${d}D)`);
	}
	return { gate, declaredScope, buildGreen, bridgedDeliverables, deliverableCheck, phaseChangeRec, changeGate, symbolGate, advisory, leak };
}
