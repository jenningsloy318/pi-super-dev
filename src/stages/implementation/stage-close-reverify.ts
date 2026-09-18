import { spawnSync } from "node:child_process";
import type { StageContext, PipelineState } from "../../types.ts";
import { appendGateChecked } from "../../runlog.ts";
import { resetDeliverableCheckCache, runBuildGate, runDeliverableCheck, type DeliverableContract, type GateOptions } from "../../build-runner.ts";
import { leakNorm, reverifyPartialPhases } from "./phase-reentry.ts";
import { deterministicPhaseCommit, phaseStatusUpsert, type PhaseStatusEntry, type PhaseFailureEntry } from "./phase-status.ts";

export interface StageCloseReverifyInput {
	ctx: StageContext;
	state: PipelineState;
	/** setup fields (worktreePath/defaultBranch; worktreeCreated feeds the deterministic commit). */
	worktreePath: string;
	defaultBranch: string;
	worktreeCreated: boolean | undefined;
	/** The full phase array (deliverable contracts read per flippable). */
	phases: unknown[];
	/** By-ref surface — flips upsert "green" rows in place. */
	phaseStatus: PhaseStatusEntry[];
	/** Judge-owned phases are never re-verified (passed through to reverifyPartialPhases). */
	envBlockedPhases: Set<string>;
	/** The pre-flip failure rows; flipped phases drop their stale rows (review F3). */
	lastFailures: PhaseFailureEntry[];
}

export interface StageCloseReverifyResult {
	/** How many partial phases flipped GREEN here — the caller adds this to phasesCompleted. */
	flipsCompleted: number;
	/** The post-flip failure rows (content-identical to the input when nothing flipped). */
	lastFailuresOut: PhaseFailureEntry[];
	/** True only when every phase entry is green AND the entry count covers all phases (review P3: never claim all-green over an entry subset — a REPLAN break leaves later phases without entries). */
	forceAllGreen: boolean;
}

/** Increment 22 — the stage-close re-verification (commit fusion), a boundary
 * closer per the granularity standard. The caller interprets the result
 * mechanically: phasesCompleted += flipsCompleted; lastFailures rebind;
 * forceAllGreen ⇒ allGreen = true. Everything else (the git changed-set walk,
 * the build gate, the full deliverable re-check, the upsert, the deterministic
 * close commit) is owned here, byte-faithful to the pre-split stage.ts region. */
export function runStageCloseReverify(input: StageCloseReverifyInput): StageCloseReverifyResult {
	const { ctx, state, worktreePath, defaultBranch, worktreeCreated, phases, phaseStatus, envBlockedPhases } = input;
	let failures = input.lastFailures;
	let flipsCompleted = 0;
	let forceAllGreen = false;
	// v0.3.80 B2 — stage-close re-verification (commit fusion): gate-window expiry
	// can end a phase PARTIAL with its work already landed; the stage verdict must
	// reflect the tree, not the stale gate window. Dual-review hardening: the flip
	// requires an affirmative clause + a clause file changed THIS RUN (vs the merge
	// base — pre-existing content cannot flip) + the stage build gate + a FULL
	// runDeliverableCheck per flippable (deliverablesAlreadyMet now verifies
	// requireTests at existence grade; execution authority stays here — F-04,
	// v0.3.86); flipped phases splice lastFailures and get their deterministic
	// commit like every other green path (review F3).
	{
		const changedThisRun = new Set<string>();
		try {
			const mergeBase = String(spawnSync("git", ["-C", worktreePath, "merge-base", "HEAD", defaultBranch], { encoding: "utf8", timeout: 10_000 }).stdout ?? "").trim();
			if (mergeBase) {
				const diffOut = String(spawnSync("git", ["-C", worktreePath, "diff", "--name-only", mergeBase, "HEAD"], { encoding: "utf8", timeout: 15_000 }).stdout ?? "");
				const statusOut = String(spawnSync("git", ["-C", worktreePath, "status", "--porcelain"], { encoding: "utf8", timeout: 10_000 }).stdout ?? "");
				for (const line of diffOut.split("\n")) if (line.trim()) changedThisRun.add(leakNorm(line.trim()));
				for (const line of statusOut.split("\n")) {
					const rel = line.slice(3).trim().replace(/^"|"$/g, "");
					if (rel && !rel.includes(" -> ")) changedThisRun.add(leakNorm(rel));
				}
			}
		} catch { /* changed-set is a hardening input, not a gate — empty set degrades to the pre-hardening behavior for absorbed-work detection */ }
		const reverify = reverifyPartialPhases(phases as unknown as Array<Record<string, unknown>>, phaseStatus as Array<{ id: string; status: string }>, worktreePath, defaultBranch, envBlockedPhases, changedThisRun);
		for (const skipped of reverify.skippedVacuous) ctx.log(`Implementation stage-close re-verification: ${skipped} — keeping PARTIAL (honest)`);
		if (reverify.flippable.length > 0) {
			ctx.phase("Stage 9 — Implementation — stage-close re-verification");
			resetDeliverableCheckCache();
			const closeGate = runBuildGate(worktreePath, { gate: (state.spec?.gate) as GateOptions | undefined, signal: ctx.signal, defaultBranch });
			appendGateChecked(state, "stage-close-reverify", closeGate, "implementation");
			if (closeGate.pass || closeGate.inScopePass) {
				for (const f of reverify.flippable) {
					const rvDeliverables = (phases[f.index] as { deliverables?: DeliverableContract }).deliverables;
					const rvCheck = rvDeliverables
						? runDeliverableCheck(worktreePath, rvDeliverables, { signal: ctx.signal, skipTests: false, defaultBranch })
						: null;
					if (rvCheck && !rvCheck.pass) {
						ctx.log(`Implementation ${f.id} stage-close re-verification: deliverablesAlreadyMet passed but the FULL deliverable check FAILED (missing: ${rvCheck.missing.slice(0, 3).join("; ")}) — keeping PARTIAL (honest; requireTests/scenario sweep authoritative)`);
						continue;
					}
					ctx.log(`Implementation ${f.id} stage-close re-verification: deliverables satisfied at close (full check + build gate green) — marking GREEN (gate-window expiry had left landed work unverified; commit fusion)`);
					phaseStatusUpsert(phaseStatus, f.id, "green");
					flipsCompleted++;
					failures = failures.filter((e) => !e.phaseId || e.phaseId !== f.id); // review F3: a green phase carries no stale failure row
					if (ctx.budget.check()) {
						const commitOutcome = deterministicPhaseCommit(worktreePath, {
							phaseIndex: f.index + 1,
							totalPhases: phases.length,
							phaseName: String((phases[f.index] as { name?: unknown })?.name ?? f.id),
							worktreeCreated,
							gateSummary: "stage-close re-verification: build green; deliverables met (full check)",
						});
						ctx.log(`Implementation ${f.id} stage-close commit: ${commitOutcome.status} — ${commitOutcome.reason}`);
					}
				}
				if (phaseStatus.length === phases.length && phaseStatus.every((p) => p.status === "green")) forceAllGreen = true; // review P3: never claim all-green over an entry subset (REPLAN break leaves later phases without entries)
			} else {
				ctx.log(`Implementation stage-close re-verification: ${reverify.flippable.length} partial phase(s) have satisfied deliverables but the stage build gate FAILED — keeping PARTIAL (honest)`);
			}
		}
	}
	return { flipsCompleted, lastFailuresOut: failures, forceAllGreen };
}
