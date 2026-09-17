/**
 * Stage 9 — implementation run preparation (extracted from stage.ts at v0.4.26).
 *
 * Everything Stage 9 does BEFORE the phase loop begins: defensive phase
 * normalization, the liveness check that fails the stage closed when the
 * worktree was removed externally, the once-per-run plan-feasibility + 065
 * entry-gate validation (with the inline route-back / replan / FatalAbort
 * escalation paths), and the revival of all §D-convergence-iteration state
 * (green-phase carry, dirt snapshots, protection strikes, the rollback stash,
 * the protection interval, the wall fuse). Pure setup — no phase is touched.
 *
 * The contract: returns `{ earlyResult }` when the stage must short-circuit
 * before any phase runs (no phases / worktree gone / plan routed to replan),
 * otherwise the full run state the phase loop consumes. Throws RouteBackSignal
 * / FatalAbort for the inline-jump and hard-block paths, exactly as before.
 */
import { existsSync } from "node:fs";
import type { PipelineState, StageContext, SetupControl } from "../../types.ts";
import { normalizePhases } from "../../doc-validators.ts";
import { planFeasibilityFindings } from "../plan-feasibility.ts";
import { stage9EntryGate, type EntryGateFinding } from "../../review/claim-spine.ts";
import { freshStageDocTexts } from "../../review/contract-validators.ts";
import { planInlineRouteBack } from "../../routing/walker.ts";
import { RouteBackSignal } from "../../routing/router.ts";
import { triggerReplanForFindings, pendingInheritedRedRows } from "../../replan/replan.ts";
import { FatalAbort } from "../../nodes.ts";
import { runtimeInstructionFingerprint } from "./phase-reentry.ts";
import { listPorcelainPaths } from "../../fault-classification.ts";
import { captureStageEntryBaseline } from "../checkpoint-rollback.ts";
import { reviveProtectionInterval, deriveProtectionInterval, type ProtectionInterval } from "../protection-interval.ts";
import { freshRunWallFuseState } from "../../wall-fuse.ts";
import type { PhaseStatusEntry, PhaseFailureEntry } from "./phase-status.ts";
import type { ResearchAssistRedArm } from "../research-assist.ts";

export async function prepareImplementationRun(state: PipelineState, ctx: StageContext) {
		// Defensively normalize: agents sometimes return `phases` as a string or
		// object instead of an array, which crashed `phases.entries()` (Stage 9:
		// "phases.entries is not a function"). Never trust the control shape.
		const phases = normalizePhases(state.spec?.phases);
		if (!Array.isArray(state.spec?.phases) && state.spec?.phases != null) {
			ctx.log(`Implementation: spec.phases was ${typeof state.spec.phases}, expected an array — normalized to ${phases.length} phase(s)`);
		}
		if (phases.length === 0) {
			ctx.log("Implementation: no phases defined in spec — skipping");
			return { earlyResult: { phasesCompleted: 0, totalPhases: 0, allGreen: false } };
		}
		const setup = state.setup!;
		// v0.3.57 liveness (ledger 2026-09-01, silent-zombie incident): the run's
		// dedicated worktree being removed EXTERNALLY mid-run must fail the stage
		// closed with an honest marker — never delegate children into a void that
		// then hangs awaiting responses that can never arrive.
		if ((setup as { worktreeCreated?: boolean }).worktreeCreated !== false && !existsSync(setup.worktreePath)) {
			ctx.log(`Implementation: WORKTREE GONE — ${setup.worktreePath} no longer exists (removed externally). Failing the stage closed; every delegation into it would hang or die silently. If a host process for this run is still alive, stop it, then start a fresh run or resume.`);
			return { earlyResult: { phasesCompleted: 0, totalPhases: phases.length, allGreen: false, filesModified: [], phaseStatus: [], lastFailures: [{ phaseId: "phase-all", reasons: [`worktree removed externally: ${setup.worktreePath}`] }] } };
		}
		// v0.3.79 A1 (spec-25, docs/findings/deep-analysis-2026-09-08-spec25.md):
		// plan feasibility — the plan is a program; validate it BEFORE executing
		// (the cheapest correction point; PDoctor/Turborepo precedent: check the
		// graph you actually execute, at load time). Cross-phase contradictions
		// route straight to REPLAN instead of surfacing hours later as BLOCKING
		// phase-boundary revert loops (run 2026-09-07T14-14-09-937Z: ~2h burned
		// on phase-01 of 10). Advisories surface even when no contradiction fires.
		// ADV-v0379-2: validate ONCE per run — §D re-entries must not re-derive
		// contradictions against a mid-run worktree (an incidental HEAD state
		// change could replan after work already converged; a REPLAN restart
		// gets a fresh state and re-validates in the new run).
		const feasibilityOnce = ((state as Record<string, unknown>).__planFeasibilityChecked as boolean | undefined) ?? false;
		(state as Record<string, unknown>).__planFeasibilityChecked = true;
		const feasibility = feasibilityOnce
			? { contradictions: [], advisories: [], protectionScan: [] }
				// 059 R1A (§6 handoff contract): setup.specDirectory threads the Check 3
				// amendmentFamily exemption consumer — planFeasibilityFindings reads
				// .knowledge.json (design ?? spec family) and exempts owner-approved
				// sharedFile paths; fail-closed on malformed knowledge (grill R8).
			: planFeasibilityFindings(phases, setup.worktreePath, setup.specDirectory);
		// 065 D-F-D + D-F-F (the entry gate): ONE fresh cross-product pass —
		// write-claims (rendered 09/10/11 + AC statements + phase requireFiles)
		// × protect-claims (fresh inventory, unified grammar, phantoms rejected,
		// SELF-MINTED pins included — D1) ∖ file-level exemptions; plus the plan
		// compile-time checks (forward refs, create collisions, scenario
		// resolvability, AC write-coverage). Same once-per-run guard as Check 3.
		let entryGateFindings: EntryGateFinding[] = [];
		if (!feasibilityOnce) {
			const bddScenarioIds = new Set<string>();
			const bddControl = state.bdd as { features?: unknown } | undefined;
			if (Array.isArray(bddControl?.features)) {
				for (const feature of bddControl!.features as Array<Record<string, unknown>>) {
				for (const sc of (Array.isArray(feature?.scenarios) ? feature.scenarios : []) as Array<Record<string, unknown>>) {
					if (typeof sc?.id === "string" && sc.id.trim()) bddScenarioIds.add(`SCENARIO-${sc.id.trim()}`);
				}
			}
			}
			const docTexts = freshStageDocTexts(setup.specDirectory, state.spec as Record<string, unknown> | undefined, ["*-specification.md", "*-implementation-plan.md", "*-task-list.md"]);
			const entryGate = stage9EntryGate({
				worktreePath: setup.worktreePath,
				specDirectory: setup.specDirectory,
				phases: phases as Parameters<typeof stage9EntryGate>[0]["phases"],
				requirementsControl: state.requirements as Record<string, unknown> | undefined,
				bddScenarioIds,
				docTexts,
			});
			for (const line of entryGate.scanLines) ctx.log(`Implementation entry-gate: ${line}`);
			entryGateFindings = entryGate.findings;
			for (const f of entryGateFindings) ctx.log(`Implementation entry-gate CONTRADICTION (${f.kind}): ${f.title}`);
		}
		// Wave P1 D-A (P10 — silent-miss visibility): the immutability-idiom
		// scanner's per-file hit list is logged at entry — a repo whose tests use
		// an idiom OUTSIDE the enumerated grammar shows "0 hit(s)" here instead
		// of silently missing the protection. One line per scanned source.
		for (const scanLine of feasibility.protectionScan) {
			ctx.log(`Implementation plan protection-scan: ${scanLine}`);
		}
		for (const advisory of feasibility.advisories) {
			ctx.log(`Implementation plan advisory: ${advisory.title}`);
		}
		if (feasibility.contradictions.length > 0 || entryGateFindings.length > 0) {
			for (const c of feasibility.contradictions) {
				ctx.log(`Implementation plan CONTRADICTION: ${c.title} — ${c.detail}`);
			}
			// 065 routing follow-up (grill HIGH-2): the INLINE route-back jump
			// FIRST — the walker re-enters at the spec convergence node (minutes:
			// spec re-render + re-review), trading the replan restart (invalidation
			// + process re-entry) for an in-process sub-walk. Declines (owner
			// geometry, per-edge budget, kill-switch) fall through to the replan
			// route below unchanged.
			const routingFindings = [...feasibility.contradictions.map((c) => ({ id: `gateE-feas-${c.title.slice(0, 24)}`, ownerStage: c.ownerStage, blocking: true, title: c.title })), ...entryGateFindings.map((c, i) => ({ id: `gateE-${c.kind}-${i}`, ownerStage: "spec" as const, blocking: true, title: c.title }))];
			const inlineCmd = planInlineRouteBack(setup.specDirectory, "implementation", routingFindings);
			if (inlineCmd) {
				ctx.log(`Implementation: entry-gate contradictions — INLINE route-back ${inlineCmd.from}→${inlineCmd.to} (${routingFindings.length} blocking finding(s); the spec re-converges in-process, no restart) — throwing RouteBackSignal for the walker (065 §4.4 follow-up)`);
				throw new RouteBackSignal(inlineCmd);
			}
			let planReplanned = false;
			try {
				planReplanned = await triggerReplanForFindings(state, ctx, [...feasibility.contradictions.map((c) => ({ file: null, severity: "high", title: c.title, detail: c.detail, ownerStage: c.ownerStage })), ...entryGateFindings.map((c) => ({ file: null, severity: "high", title: c.title, detail: c.detail, ownerStage: "spec" as const }))], "implementation", setup.specIdentifier ?? "unknown");
			} catch { planReplanned = false; }
			if (planReplanned) {
				ctx.log(`Implementation: plan infeasible (${feasibility.contradictions.length} contradiction(s)) — routed to REPLAN before executing any phase`);
				return { earlyResult: { phasesCompleted: 0, totalPhases: phases.length, allGreen: false, filesModified: [], phaseStatus: [], lastFailures: [{ phaseId: "phase-all", reasons: feasibility.contradictions.map((c) => c.title) }] } };
			}
			// v0.3.85 F2 (§10 decision 3, grill pass 3): the log-and-proceed fallback
			// is overridden to HARD-FAIL for restart states carrying PENDING
			// source:"inherited-red" rows — an amended plan that still contradicts
			// the zero-LLM plan-feasibility validator after a declared handoff
			// routes Tier 3 FatalAbort naming the validator findings (no retry
			// loop). Every other restart keeps today's log-and-proceed.
			const pendingIrRows = pendingInheritedRedRows(setup.specDirectory);
			if (pendingIrRows.length > 0) {
				// FIX ROUND 1 (F-ii): the abort names the validator findings IN FULL —
				// kind + title + EVIDENCE lines (the evidence carries the clause text,
				// e.g. `P1 requireContains src/x.ts: FOO`, so the failing clause form
				// is machine-readable in the terminal reason, not just the prose title).
				const validatorFindings = [...feasibility.contradictions, ...entryGateFindings.map((c) => ({ kind: c.kind, title: c.title, detail: c.detail, evidence: [] as string[] }))]
					.slice(0, 6)
					.map((c) => `[${c.kind}] ${c.title} — evidence: ${c.evidence.join("; ")}`)
					.join(" | ");
				ctx.log(`Implementation: plan validation FAILED after an inherited-red declared handoff (${pendingIrRows.length} pending row(s): ${pendingIrRows.map((r) => r.id).join(", ")}) — routing Tier 3 FatalAbort naming the validator findings (no retry loop; v0.3.85 F2 validator override): ${validatorFindings}`);
				throw new FatalAbort(`inherited-red restart failed plan validation (v0.3.85 F2, ADR 8/9): the spec dir still carries ${pendingIrRows.length} pending source:"inherited-red" handoff row(s) (${pendingIrRows.map((r) => r.id).join(", ")}) while the amended plan contradicts the zero-LLM plan-feasibility validator — validator findings: ${validatorFindings}. A declared handoff's amended plan must pass the validator before execution; no retry loop.`);
			}
			// 065 A5 (grill round 1): HARD BLOCK per spec §4.4 — executing a plan
			// the gate PROVED contradictory punishes everything downstream; fail
			// loud (the contradictions are named; the human decides).
			const gateDetail = entryGateFindings.slice(0, 3).map((f) => `${f.title} — ${f.detail}`).join(" | ");
			throw new FatalAbort(`Stage 9 entry gate found write×protect plan contradictions and the replan route is unavailable (budget/marker exhausted): ${gateDetail}. Fix the spec artifacts (declare the amendment, drop the write, or drop the protection) and re-run — no execution of a proven-contradictory plan (065 §4.4 HARD BLOCK).`);
		}
		// §D auto-iterate: carry per-phase green state + failure reasons from the
		// PRIOR convergence iteration (state.implementation holds the last run's
		// control). Green phases are skipped; a failed phase's prior reasons seed
		// its next attempt 1 so iteration 2 targets the real failures.
		const startInstructionFingerprint = runtimeInstructionFingerprint(state.setup?.specDirectory);
		const priorImpl = (state.implementation ?? {}) as { phaseStatus?: PhaseStatusEntry[]; lastFailures?: PhaseFailureEntry[]; runtimeInstructionFingerprint?: string; invalidatedByRuntimeInstructions?: boolean; runStartDirt?: string[]; phaseStartDirt?: Record<string, string[]>; phaseGuidanceReentryUsed?: Record<string, true>; inheritedRedFlakeGrantUsed?: boolean; redAssistArmed?: Record<string, ResearchAssistRedArm>; phaseResearchAssistUsed?: Record<string, true>; phaseProtectionStrikes?: Record<string, number>; stageEntryBaselineCommit?: string; protectionInterval?: unknown; rollbackStash?: { phaseId?: unknown; stashSha?: unknown } };
		const priorInstructionInvalidated = priorImpl.invalidatedByRuntimeInstructions === true || (typeof priorImpl.runtimeInstructionFingerprint === "string" && priorImpl.runtimeInstructionFingerprint !== startInstructionFingerprint);
		const priorRunStart = (Array.isArray(priorImpl.runStartDirt) ? priorImpl.runStartDirt : undefined);
		// v0.3.85 F2: per-phase FIRST-EVER porcelain snapshots (the attribution
		// boundary — see the phase-entry capture below), persisted across §D
		// convergence iterations exactly like runStartDirt (the sd26-F1 lesson:
		// a re-entry must not re-capture after this phase's own prior-iteration
		// edits hit disk, or its own live work would classify as pre-phase).
		const phaseStartDirt: Record<string, string[]> = priorInstructionInvalidated || !priorImpl.phaseStartDirt || typeof priorImpl.phaseStartDirt !== "object" ? {} : { ...priorImpl.phaseStartDirt };
		const priorGuidanceReentryUsed = (priorImpl.phaseGuidanceReentryUsed && typeof priorImpl.phaseGuidanceReentryUsed === "object") ? priorImpl.phaseGuidanceReentryUsed : undefined;
		// v0.3.87 S4(b) (decision 9): research-assist per-phase state, PERSISTED
		// across §D convergence iterations via the control (the
		// phaseGuidanceReentryUsed precedent — per phase EVER within a run):
		//  - redAssistArmed: a terminal RED-generation failure (terminalRedTries ≥
		//    RESEARCH_ASSIST_RED_TRIGGER_TRIES) armed the assist for this phase's
		//    NEXT implementer round — the dispatch happens at the §D re-entry's
		//    corrective-prompt assembly, immediately before the implementer call
		//    (report-always-accompanies-execution: never dispatched at the terminal
		//    boundary itself, where no next attempt is guaranteed).
		//  - phaseResearchAssistUsed: the per-phase assist cap (≤1 assist per
		//    phase, P8) — a second trigger in the same phase proceeds WITHOUT
		//    assist, logged honestly.
		const redAssistArmed: Record<string, ResearchAssistRedArm> = priorInstructionInvalidated || !priorImpl.redAssistArmed || typeof priorImpl.redAssistArmed !== "object" ? {} : { ...priorImpl.redAssistArmed };
		const phaseResearchAssistUsed: Record<string, true> = priorInstructionInvalidated || !priorImpl.phaseResearchAssistUsed || typeof priorImpl.phaseResearchAssistUsed !== "object" ? {} : { ...priorImpl.phaseResearchAssistUsed };
		let phaseStatus: PhaseStatusEntry[] = priorInstructionInvalidated ? [] : (Array.isArray(priorImpl.phaseStatus) ? priorImpl.phaseStatus.map((p) => ({ ...p })) : []);
		// v0.2.6 G1 (adversarial sd26-F1 + code-review sd26-CR-1): ONE run-start
		// porcelain snapshot, captured at stage entry ONLY when no prior snapshot
		// rides state.implementation, and partitioned against by EVERY phase —
		// foreign means "predates THIS RUN" (prior-run dirt on a reused worktree:
		// the mac-run class), while this run's own work (any phase's undeclared
		// edits — phases commit via an orchestrator call that stages only declared
		// files and is skipped without budget, so residue legitimately survives
		// phase boundaries) is NEVER foreign and never stashable. Persisted across
		// §D convergence iterations via the ControlObj so a re-entry does not
		// recapture after iteration 1's residue. Known limitation (sd26-CR-4,
		// documented): a process resume re-captures at the resumed invocation's
		// start, so pre-crash uncommitted work classifies foreign there — bounded
		// by G2's product fall-through (one wasted quarantine, recoverable via
		// git stash pop; durable spec-dir persistence was rejected because it
		// would also freeze the motivating prior-run-dirt class as own).
		let runStartDirt: string[] = priorRunStart ? [...priorRunStart] : listPorcelainPaths(setup.worktreePath);
		if (priorRunStart) {
			ctx.log("Implementation: reusing persisted run-start dirt snapshot from the prior convergence iteration (provenance boundary stays this run's start)");
		}
		// v0.2.6 G4 (adversarial sd26-F2): guidance-reentry grants persist per
		// phase EVER across convergence iterations.
		let phaseGuidanceReentryUsed: Record<string, true> = priorGuidanceReentryUsed ? { ...priorGuidanceReentryUsed } : {};
		// ── Wave 3 D-B (058 §4): per-phase protection strike counters. State key
		// `phaseProtectionStrikes: Record<phaseId, number>` on the implementation
		// control — persisted across §D convergence iterations (the
		// phaseGuidanceReentryUsed precedent), strictly disjoint from 059's
		// `writerMetadataRetryUsed:<stage>` (different prefix, different lifetime:
		// per phase vs per stage). Instruction invalidation resets it with the
		// phase carry (fresh run semantics).
		let phaseProtectionStrikes: Record<string, number> = priorInstructionInvalidated || !priorImpl.phaseProtectionStrikes || typeof priorImpl.phaseProtectionStrikes !== "object" ? {} : { ...priorImpl.phaseProtectionStrikes };
		// ── Wave 3 D-D (058 Layer 4): the stage-entry baseline commit (the NEW-3
		// fallback rollback target for K=1 / partial-predecessor cases) + the
		// pending rollback stash (re-applied after the re-entered phase's
		// re-execution). Both persist across §D iterations via the control.
		let stageEntryBaselineCommit = typeof priorImpl.stageEntryBaselineCommit === "string" && priorImpl.stageEntryBaselineCommit ? priorImpl.stageEntryBaselineCommit : captureStageEntryBaseline(setup.worktreePath);
		if (!stageEntryBaselineCommit) ctx.log("Implementation: stage-entry baseline commit unavailable (git rev-parse failed / no commits) — D-D rollback would degrade honestly (NEW-3 fallback unusable this run)");
		const priorRollbackStash = priorImpl.rollbackStash && typeof priorImpl.rollbackStash === "object" && typeof priorImpl.rollbackStash.stashSha === "string" && typeof priorImpl.rollbackStash.phaseId === "string" ? { phaseId: priorImpl.rollbackStash.phaseId, stashSha: priorImpl.rollbackStash.stashSha } : null;
		let pendingRollbackStash: { phaseId: string; stashSha: string } | null = priorRollbackStash;
		// ── Wave 3 D-B (058 Layer 2): the mechanically-derived protection interval —
		// computed ONCE per run at first entry from the entry-time Layer-1 sources
		// (the landed inventory walk COMPOSES scanImmutabilityIdioms; do NOT
		// re-scan per attempt or per §D re-entry), persisted on the control in
		// serializable form. A malformed persisted form re-derives (fail-safe).
		let protectionInterval: ProtectionInterval;
		const revivedInterval = reviveProtectionInterval(priorImpl.protectionInterval);
		if (revivedInterval) {
			protectionInterval = revivedInterval;
		} else {
			protectionInterval = deriveProtectionInterval(setup.worktreePath, setup.specDirectory);
			// P10 visibility (mirrors the Layer-1 protectionScan lines): the interval's
			// inputs are logged at derivation — a protection the grammar misses is
			// visible as a 0-path interval, never silently absent.
			for (const scanLine of protectionInterval.scanLines) ctx.log(`Implementation protection-interval: ${scanLine}`);
			ctx.log(`Implementation protection-interval: ${protectionInterval.protectedPaths.size} protected path(s)${protectionInterval.protectedPaths.size > 0 ? ` — ${[...protectionInterval.protectedPaths.keys()].join(", ")}` : ""} (two-strike defense armed, 058 §3 Layer 2)`);
		}
		let lastFailures: PhaseFailureEntry[] = priorInstructionInvalidated ? [] : (Array.isArray(priorImpl.lastFailures) ? priorImpl.lastFailures.map((f) => ({ ...f, reasons: [...f.reasons] })) : []);
		if (priorInstructionInvalidated) ctx.log("Implementation: runtime user instructions changed — invalidating prior green phase carry and re-running phases");
		if (phaseStatus.length) ctx.log(`Implementation: resuming convergence iteration (${phaseStatus.filter((p) => p.status === "green").length}/${phases.length} phases already green)`);
		let phasesCompleted = 0;
		let allGreen = true;
		// v0.3.80 B2: environment-blocked phases are judge-owned — excluded from stage-close re-verification.
		const envBlockedPhases = new Set<string>();
		// v0.3.85 wall fuse: this IS set true — by the per-pass convergence budget
		// (below) and the §D re-entry guard, both honest "stop this pass" signals,
		// never a silent abort. v0.3.0's "never set anymore" note was overtaken by
		// the wall-fuse wave; downstream readers treat true as "the pass ended at
		// the budget, resume next pass". A failed phase is recorded `partial` and
		// the pipeline CONTINUES (never-zero).
		let convergenceBlocked = false;
		let convergenceBlockReason = "";
		const filesModified: string[] = [];
		// v0.3.85 F3 (decision 2): the run-pass wall fuse + its attempt-duration
		// estimator. ctx.wallFuse is the SAME window realAgent checks pre-call
		// (created once per runWorkflow invocation — a resumed pass gets a FRESH
		// window); bare test contexts without the surface get a stage-local fresh
		// window. attemptDurations records each completed implementer attempt's
		// wall time (pushed at the NEXT attempt's entry — exactly when the
		// trailing-3-median wind-down decision needs it), scoped to this stage run
		// so a §D re-entry re-estimates from its own attempts.
		const runFuse = ctx.wallFuse ?? freshRunWallFuseState();
		const attemptDurations: number[] = [];
		let attemptStartedAt = 0;
		let attemptDurationClosed = true;
		// v0.3.85 F2 (decision 3, D-2): the per-run Tier-1 flake-filter grant —
		// ≤1 deterministic full-gate re-run per run, NEVER consuming an
		// implementer attempt. Carried on the control so §D convergence re-entries
		// within one run share the single grant ("per run", the wall-fuse
		// per-run-pass doctrine — a resumed pass starts a fresh run and gets a
		// fresh grant). The flake TALLY itself is ledger-backed and persists
		// across resume (surfaced in the close-out report only — never a retry
		// reason).
		let inheritedRedFlakeGrantUsed = priorImpl.inheritedRedFlakeGrantUsed === true;

		return {
			phases, setup, feasibility, startInstructionFingerprint, phaseStartDirt,
			redAssistArmed, phaseResearchAssistUsed, phaseStatus, runStartDirt,
			phaseGuidanceReentryUsed, phaseProtectionStrikes, stageEntryBaselineCommit,
			pendingRollbackStash, protectionInterval, lastFailures, phasesCompleted, allGreen,
			envBlockedPhases, convergenceBlocked, convergenceBlockReason, filesModified,
			runFuse, attemptDurations, attemptStartedAt, attemptDurationClosed,
			inheritedRedFlakeGrantUsed,
		};
}
