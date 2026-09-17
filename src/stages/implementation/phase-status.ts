import {IMPLEMENTER_CONTROL_KEYS, LeakPhase, MAX_CHALLENGE_REAUTHORS, UNSATISFIABLE_TEXT_RE, cratesFromErrors, formatReauthorEvidence, leakNorm, quoteCmdArg, redImplementContext, redRePromptHint, trimImplementerText} from "./phase-reentry.ts";
import {porcelainEntries} from "./red-evidence.ts";
/**
 * Stage 9 — Implementation (per-phase TDD).
 * Self-contained task: iterates the spec's phased task list. For each phase,
 * runs TDD-write → implement → build-gate until the phase is green, the global
 * run budget is exhausted, or the same actionable failure repeats with no
 * observable progress.
 * The build-gate is the DETERMINISTIC hard oracle (build-runner.ts) that
 * replaces the old QA self-report — no more vacuous pass on "agent said green".
 */

import { execFileSync, spawnSync } from "node:child_process";
import { harnessBasenames } from "../../harness-paths.ts";
import { superDevEnv } from "../../render/super-dev-dir.ts";
import {rmSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import type { BoundaryQuarantinePayload, ControlObj, PipelineState, Stage, StageContext } from "../../types.ts";

// v0.3.73 M1: re-exported for the salvage seam + tests.
import { classifyJudgeRoute } from "../../routing/router.ts";
import { getActiveTracker, isHarnessBookkeepingPath, isInternalRuntimeClaim } from "../../tracking.ts";
import type { ChangeRecord, StructuredChanges } from "../../tracking.ts";
import { localTimestamp } from "../../render/time.ts";
import { buildRedBoundaryPrompt, classifyObviousRedPath, isRuntimeEvidencePath, isSubstrateArtifact, redBoundaryResultFromAgent, redBoundaryResultFromClassifications, approveScaffoldPaths, type RedBoundaryResult } from "../../test-artifacts.ts";
import { buildTddPrompt, buildImplementPrompt, buildCommitPrompt, buildImplementationSummaryPrompt, buildRedReviewPrompt, rustDiscipline } from "../../prompts.ts";
import { firstCitedTestFile, runJudge, type JudgeRoute } from "../judge.ts";
import { triggerReplanForFindings, replanPending, countInheritedRedRows, pendingInheritedRedRows } from "../../replan/replan.ts";
import { planInlineRouteBack } from "../../routing/walker.ts";
import { RouteBackSignal } from "../../routing/router.ts";
// v0.3.85 F2 Tier 3 / F4 sub-cap + the validator hard-fail override: the
// stop-the-line terminal (ADR 9) and the restart-state pending-row probe.
import { FatalAbort } from "../../nodes.ts";
import { INHERITED_RED_SOURCE, appendInheritedRedEvent, countInheritedRedOccurrences, extractFailingTestFilePaths, f4ScopeMatch, inheritedRedAttribution, inheritedRedBoundaryShape, inheritedRedFlakeTally, normalizeRepoPath } from "../inherited-red.ts";
// v0.3.87 S4(b)+(d) (§9/§10 decision 9, §13, §14 ADR 6): the engine-mediated
// research assist — pure helpers + ledger + the one dispatch seam. §13:
// "research-assist" is a CONFIG ROLE KEY ONLY; the dispatch reuses
// research-agent, no agent file is created.
import { RESEARCH_ASSIST_ARCHIVE_CAP, RESEARCH_ASSIST_GREEN_TRIGGER_STREAK, RESEARCH_ASSIST_RED_TRIGGER_TRIES, parseNeedsResearch, runResearchAssist, type NeedsResearchEntry, type ResearchAssistRedArm, type ResearchAssistGreenTrigger } from "../research-assist.ts";
import { planFeasibilityFindings, contradictionFastFailFrame } from "../plan-feasibility.ts";
// 065 D-F-D/D-F-F: the Stage-9-entry gate (write×protect cross-product +
// plan compile-time checks) — two-locus mechanical findings routed through
// the SAME replan circuit plan-feasibility uses (no judge call needed).
import { stage9EntryGate, type EntryGateFinding } from "../../review/claim-spine.ts";
import { freshStageDocTexts } from "../../review/contract-validators.ts";
import { isNoEditCompletion } from "../../agent-errors.ts";
import { renderAndWrite } from "../../render/render.ts";
import { STAGE_MODELS, RedReviewData as RED_REVIEW_SCHEMA, TddCoverageControlData, FileClassifyControlData } from "../../render/schemas.ts";
import { userNotesForAgent } from "../../render/user-notes.ts";
import { extractScenarioIds, extractScenarioRefsFromControl, normalizePhases } from "../../doc-validators.ts";
import { computeChangeGate, computeSymbolGate, deliverablesAlreadyMet, resetDeliverableCheckCache, runBuildGate, buildGateCorrelationLine, runDeliverableCheck, runRedCheck, type BuildGateResult, type DeliverableContract, type GateOptions, type RedCheckDiagnostic, type RedCheckPlan, type RedStatus } from "../../build-runner.ts";
import { renderRetryFeedbackBlock, type RetryFeedback } from "../../retry-feedback.ts";
import { runInStepScope } from "../../step-scope.ts";
import { recordConvergenceFindings, type ConvergenceOwnerStage } from "../../convergence-ledger.ts";
import { stripVolatileNoise, classifyGateFault, collectDirtPaths, listPorcelainPaths, quarantineDirt, dirtyQuarantineEnabled, appendEnvironmentFault, readEnvironmentFaultCount, type FaultClass } from "../../fault-classification.ts";
import { freshRunWallFuseState, markRunWallFuseTripped, runFuseWindDown, runWallFuseMs } from "../../wall-fuse.ts";
import { clearBaselineCache } from "../../build-runner/baseline.ts";
import { phaseClauseFiles } from "../plan-feasibility.ts";
// v0.3.30 Layer C: agent-proposed runner discovery (machine-verified + cached).
import { readCachedTestRunner, writeCachedTestRunner, validateRunnerSpec, runnerCoversTargets, type TestRunnerSpec } from "../../build-runner/runner-discovery.ts";
import { deriveConventionsRunnerSpec } from "../../build-runner/conventions.ts";
import { runCoverageGate, type CoverageGateResult, coverageThreshold } from "../../build-runner/coverage-gate.ts";
// Wave 3 (058 §4 D-B/D-D, v0.3.99): Layer-2 protection intervals + Layer-4 checkpoint rollback.
import { buildProtectionEducationBlock, bumpProtectionStrike, detectProtectionViolations, deriveProtectionInterval, PROTECTION_STRIKE_BOUND, resetProtectionStrike, reviveProtectionInterval, serializeProtectionInterval, type ProtectionInterval } from "../protection-interval.ts";
import { consumeProtectionBreachEscalation } from "../../review/protection-breach-consumer.ts";
import { captureStageEntryBaseline, laterPhasesRan, reapplyRollbackStash, rollbackConvergenceReentry } from "../checkpoint-rollback.ts";
import { stateFileFor } from "../../state/state-root.ts";

export interface PhaseStatusEntry {
	id: string;
	status: "green" | "failed" | "partial";
	/** v0.3.0 windup bound: how many §D convergence iterations re-entered this
	 *  phase as partial, and the failure signature each pass ended on (a phase
	 *  whose partial keeps the SAME signature is hopeless this run — after
	 *  MAX_PARTIAL_REENTRIES passes it is skipped so the budget flows to the
	 *  phases that can still converge). */
	partialReEntries?: number;
	lastFailureSig?: string;
	/** v0.3.85 S3 (metrics-only): the PEAK implementer attempts this phase
	 *  consumed across §D entries (attempts reset per §D re-entry per F3, so
	 *  the max is the honest exposure). No control flow reads this — it feeds
	 *  RunMetricsRow.maxPhaseAttempts at close-out via deriveS3Counters. */
	attempts?: number;
}
export interface PhaseFailureEntry {
	phaseId: string;
	reasons: string[];
}
/** v0.3.0 (harness research, docs/requirements/037-harness-research-and-v0.3.0-architecture.md):
 *  a phase that exhausts its attempts no longer terminates the run — its best
 *  attempt is PRESERVED as a labeled git stash and the pipeline continues to
 *  the next phase (SWE-agent get_best / Anthropic git-per-increment semantics:
 *  never end a run with zero preserved work). Best-effort and never fatal: a
 *  stash failure only logs (the dirty tree itself still carries the work). */
export function preservePartialPhase(ctx: StageContext, setup: { worktreePath: string; specDirectory?: string } | undefined, phaseId: string, phaseName: string, reason: string): void {
	if (!setup) return;
	// review code-F1 (high): in-place runs share the USER's checkout — an
	// automatic stash there would sweep the user's own uncommitted work. The
	// preserve stash only ever runs in a dedicated super-dev worktree.
	const worktreeCreated = (setup as { worktreeCreated?: boolean }).worktreeCreated;
	if (worktreeCreated === false) {
		ctx.log(`Implementation ${phaseId} partial: stash-preserve SKIPPED (in-place run shares the user's checkout — no automatic worktree mutations); any uncommitted phase work stays dirty for inspection`);
		return;
	}
	// The same "no automatic worktree mutations" kill-switch that disables the
	// quarantine governs this preserve stash — a user who set
	// SUPER_DEV_NO_DIRTY_QUARANTINE=1 opted out of ALL automatic stashing.
	if (superDevEnv("SUPER_DEV_NO_DIRTY_QUARANTINE") === "1") {
		ctx.log(`Implementation ${phaseId} partial: stash-preserve SKIPPED (SUPER_DEV_NO_DIRTY_QUARANTINE=1 — no automatic worktree mutations); any uncommitted phase work stays dirty for inspection`);
		return;
	}
	try {
		// The spec directory (stage docs, evidence ledgers, knowledge) is harness
		// bookkeeping living untracked in the worktree until the release commit —
		// it must NEVER ride the partial stash (resume + downstream stages read it).
		// Pathspec magic excludes it from both the tracked and untracked sweep.
		const relSpec = ((): string => {
			const abs = typeof setup.specDirectory === "string" ? setup.specDirectory : "";
			if (!abs) return "docs/specifications";
			const rel = abs.startsWith("/") ? abs.slice(setup.worktreePath.length).replace(/^\/+/, "") : abs;
			return rel || "docs/specifications";
		})();
		const r = spawnSync("git", ["-C", setup.worktreePath, "stash", "push", "--include-untracked", "-m", `super-dev partial ${phaseId}: ${reason.slice(0, 120)}`, "--", ".", `:(exclude)${relSpec}`, ":(exclude)docs/specifications"], { encoding: "utf8", timeout: 30_000 });
		if (r.status === 0 && String(r.stdout).trim().length > 0) {
			ctx.log(`Implementation ${phaseId} partial preserved via git stash (${String(r.stdout).trim().slice(0, 40)}) — recoverable via git stash list`);
		} else if (r.status === 0) {
			ctx.log(`Implementation ${phaseId} partial: tree already clean — no preserve stash created; the committed state IS the best attempt`);
		} else {
			ctx.log(`Implementation ${phaseId} partial: stash attempt FAILED (exit ${r.status}) — NOT preserved via stash; any uncommitted phase work stays dirty for inspection (non-fatal)`);
		}
	} catch (error) {
		ctx.log(`Implementation ${phaseId} partial: stash attempt THREW (${error instanceof Error ? error.message : String(error)}) — NOT preserved via stash; non-fatal`);
	}
}

export function phaseStatusUpsert(arr: PhaseStatusEntry[], id: string, status: "green" | "failed" | "partial", attempts?: number): void {
	const i = arr.findIndex((p) => p.id === id);
	// v0.3.85 S3: `attempts` merges as a MAX across §D entries (the metric is
	// peak exposure); the existing replace semantics for id/status are
	// unchanged, and the partial-boundary mutations below (lastFailureSig /
	// partialReEntries) still apply to the fresh entry.
	const prev = i >= 0 ? arr[i] : undefined;
	const entry: PhaseStatusEntry = { id, status, ...(attempts !== undefined || prev?.attempts !== undefined ? { attempts: Math.max(attempts ?? 0, prev?.attempts ?? 0) } : {}) };
	if (i >= 0) arr[i] = entry;
	else arr.push(entry);
}
export function lastFailuresUpsert(arr: PhaseFailureEntry[], phaseId: string, reasons: string[]): void {
	const i = arr.findIndex((f) => f.phaseId === phaseId);
	if (i >= 0) arr[i] = { phaseId, reasons };
	else arr.push({ phaseId, reasons });
}

/** v0.3.43 RC2: discard the implementer's GREEN work when a parallel RED
 *  review joins with a fail-closed verdict (contradiction / invalid / error).
 *  Restores every worktree change EXCEPT: the RED test files (the suite must
 *  survive for re-authoring), harness bookkeeping (spec-dir ledgers are durable
 *  evidence), and runtime-scratch basenames. Untracked new files are removed;
 *  tracked modifications/deletions are restored from the index (= HEAD — the
 *  engine never stages during a phase). Returns the restored paths for the
 *  log. Never throws. */
function isInsidePath(child: string, parent: string): boolean {
	const rel = relative(parent, child);
	return rel === "" || (!!rel && !rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * v0.3.54 — attribute-and-restore for QUARANTINED reviewer violations (F3-real).
 *
 * A concurrent-with-writer read-only call (the RED review) that violates its
 * boundary is QUARANTINED by the guard (contents copied to a tmp dir, nothing
 * restored) because a blind `git restore` at detection time reverts to HEAD and
 * destroys the implementer's legitimate concurrent writes to the same file
 * (live: run 2026-08-31T16-03-57-978Z phase 11 — "boundary reversion wiped the
 * homepage cosmic card"). Attribution happens HERE, at the join, where the
 * implementer's claimed files are known:
 *   - path NOT claimed by the implementer → only the reviewer touched it →
 *     `git restore` is safe and removes the unreviewed edit;
 *   - path claimed by the implementer (or a phase test file) → content is mixed
 *     → left in place; the quarantined copy preserves the mixed state and the
 *     F2 ledger finding carries the paths for review.
 *
 * Trust bound: attribution uses the implementer's DECLARED files, and the
 * restore loop runs ONLY when the control declared at least one file — a null
 * control or all-empty file lists carries no attribution signal, so nothing
 * is restored then (v0.3.54 review fix, adv F1-i). A lying UNDER-claim (a
 * modified path omitted from the lists) can still cause its restoration: in
 * this fail-open branch no retry follows, and the change gate snapshots the
 * tree AFTER this function, so it cannot catch the loss. That residual risk
 * is honest and bounded — the full file bytes survive in the quarantine dir
 * and the F2 ledger finding names every path for manual recovery. Phase test
 * files are always kept (RED-hijack guard). Untracked reviewer-created files
 * cannot be git-restored; they are left in place and the change gate flags
 * them changed-not-claimed (conservative).
 *
 * v0.3.55 security review F1: the payload arrives ONLY via the structured
 * `quarantine` property of the thrown Error (composed parent-side from
 * git-status output). Error TEXT is never parsed — stderr tails and
 * delegation error strings are agent-influenceable, and a forged string
 * could previously weaponize this function into wiping implementer work.
 * No payload → no restore, ever (conservative; the quarantined bytes and the
 * ledger finding remain the evidence trail).
 */
/** v0.3.73 M1 (run 2026-09-05T23-09-55-596Z): the PURE half of quarantine
 *  attribution — classify every violation path as implementer-claimed (the
 *  concurrent writer's declared files ∪ phase test files) or unclaimed, without
 *  touching the worktree. The join uses this to decide whether a discarded
 *  red-review verdict can be SALVAGED: when declaredAny ∧ zero unclaimed, the
 *  reviewer demonstrably wrote nothing and every delta is the concurrent
 *  writer's — the formed verdict is evidence about the suite, not a violation.
 *  Path normalization semantics are verbatim v0.3.55 F3 (see below). */
export function attributeQuarantinePaths(
	worktreePath: string,
	payload: BoundaryQuarantinePayload | null | undefined,
	implControl: unknown,
	testFiles: string[],
	opts?: { testFilesAsClaims?: boolean },
): { declaredAny: boolean; claimed: string[]; unclaimed: string[] } {
	if (!payload || !Array.isArray(payload.violations)) return { declaredAny: false, claimed: [], unclaimed: [] };
	const paths = payload.violations.filter((p): p is string => typeof p === "string" && p.length > 0);
	const rootAbsNorm = resolve(worktreePath);
	const norm = (p: string) => {
		try {
			const rel = relative(rootAbsNorm, resolve(rootAbsNorm, p));
			return rel === "" ? p : rel;
		} catch { return p; }
	};
	// v0.3.73 dual review AR-73-01: testFiles claim membership UNCONDITIONALLY —
	// sound for the pre-existing RESTORE semantics (v0.3.55 F3: a test-file delta
	// must never be git-reverted as a reviewer violation), but NOT sound evidence
	// that the reviewer wrote nothing. The M1 SALVAGE gate therefore runs with
	// testFilesAsClaims=false: attribution there must rest on implementer-DECLARED
	// claims only. Default stays true so restore callers are unchanged.
	const claims = new Set<string>();
	if (opts?.testFilesAsClaims !== false) for (const t of testFiles) claims.add(norm(t));
	// declaredAny is the IMPLEMENTER-claim signal only (v0.3.54 adv F1-i): with
	// no implementer-declared files there is no attribution signal — both the
	// restore path and the M1 salvage decision fail closed. Phase test files
	// join the claims set but never set this flag.
	let declaredAny = false;
	if (implControl && typeof implControl === "object" && !Array.isArray(implControl)) {
		const rec = implControl as Record<string, unknown>;
		for (const key of ["filesCreated", "filesModified", "filesDeleted"]) {
			const list = rec[key];
			if (Array.isArray(list)) {
				for (const f of list) if (typeof f === "string" && f) { claims.add(norm(f)); declaredAny = true; }
			}
		}
	}
	const claimed: string[] = [];
	const unclaimed: string[] = [];
	for (const rawRel of paths) {
		const rel = norm(rawRel);
		if (claims.has(rel)) claimed.push(rel);
		else unclaimed.push(rel);
	}
	return { declaredAny, claimed, unclaimed };
}

export function attributeQuarantinedViolations(
	worktreePath: string,
	payload: BoundaryQuarantinePayload | null | undefined,
	implControl: unknown,
	testFiles: string[],
	log: (line: string) => void,
): void {
	// v0.3.55 security review F1: only the engine-composed structured payload
	// drives restores. Anything else (a plain error string, a null, an unknown
	// shape) restores nothing.
	if (!payload || !Array.isArray(payload.violations)) return;
	const parsed = { paths: payload.violations.filter((p): p is string => typeof p === "string" && p.length > 0), dir: typeof payload.dir === "string" ? payload.dir : "" };
	// v0.3.73 M1: attribution (claims ∪ normalization) lives in the pure
	// classifier above; this function keeps ONLY the restore/keep side effects
	// and their logs.
	const attribution = attributeQuarantinePaths(worktreePath, payload, implControl, testFiles);
	const claims = new Set([...attribution.claimed]);
	const declaredAny = attribution.declaredAny;
	if (!declaredAny) {
		// v0.3.54 review fix (adv F1-i): with no implementer-declared files there
		// is no attribution signal at all — restoring anything would wipe
		// possibly-undeclared concurrent GREEN work that no retry will bring back.
		log(`red-review-quarantine: left in place (no implementer file claims available — cannot attribute safely; quarantined copies preserved${parsed.dir ? ` at ${parsed.dir}` : ""}): ${parsed.paths.join(", ")}`);
		return;
	}
	const safe: string[] = [];
	const kept: string[] = [];
	const rootAbsNorm = resolve(worktreePath); // v0.4.16: was two identical vars (rootAbs/rootAbsNorm)
	const norm = (p: string) => {
		try {
			const rel = relative(rootAbsNorm, resolve(rootAbsNorm, p));
			return rel === "" ? p : rel;
		} catch { return p; }
	};
	for (const rawRel of parsed.paths) {
		const rel = norm(rawRel);
		if (claims.has(norm(rel))) {
			kept.push(rel);
			continue;
		}
		// Defense-in-depth (P1): the violation path names a worktree file, but a
		// malformed/traversal one is simply never worth executing a restore for
		// — keep it (manual) instead. Checked against the RAW path so resolve()
		// cannot silently canonicalize an escape away.
		if (isAbsolute(rawRel) || rawRel.includes("..") || rawRel.includes("\u0000")) {
			kept.push(rel);
			continue;
		}
		if (!isInsidePath(resolve(rootAbsNorm, rel), rootAbsNorm)) {
			kept.push(rel);
			continue;
		}
		// Not claimed by the implementer and not a phase test file: the only delta
		// is the reviewer's — safe to revert. Failure keeps the path (manual).
		// v0.3.55 security review F2: `:(literal)` — `--` ends option parsing but
		// NOT pathspec magic, so a file literally named `:(top)*` would otherwise
		// widen this restore to a worktree-wide revert (same guard as
		// fault-classification.ts stash pathspecs).
		const literalPath = `:(literal)${rel}`;
		let r = spawnSync("git", ["restore", "--staged", "--worktree", "--", literalPath], { cwd: worktreePath, encoding: "utf8" });
		if (r.status !== 0) r = spawnSync("git", ["checkout", "--", literalPath], { cwd: worktreePath, encoding: "utf8" });
		if (r.status === 0) safe.push(rel);
		else kept.push(rel);
	}
	if (safe.length) log(`red-review-quarantine: restored unclaimed reviewer edits (implementer never touched them): ${safe.join(", ")}`);
	if (kept.length) log(`red-review-quarantine: left in place (implementer-owned or mixed content — quarantined copy preserved${parsed.dir ? ` at ${parsed.dir}` : ""}): ${kept.join(", ")}`);
}

/** F-17 (v0.3.86): DEPRECATED alias for {@link attributeQuarantinedViolations}
 *  (the old spelling dropped the second 'e'). Kept as a re-export so any
 *  out-of-tree consumer keeps compiling; identical function object. */
export const attributQuarantinedViolations = attributeQuarantinedViolations;

/** v0.3.55 security review F1: parseQuarantinePayload deleted. Error text is
 *  an agent-influenceable channel (stderr tails land verbatim in review.error
 *  on the subprocess/delegation backends) and must never be parsed into
 *  restore pathspecs. The structured BoundaryQuarantinePayload on the thrown
 *  Error — produced by boundaryQuarantinePayload in workflow.ts — is the only
 *  trusted input. */

export function discardGreenWork(worktreePath: string, keepTestFiles: Set<string>): string[] {
	// v0.3.45: the -z reader replaces RAW v1-line parsing — v1 C-quotes
	// space paths on every machine and octal-escapes non-ASCII on default
	// `core.quotepath=true` machines, so rmSync/restore silently missed them.
	const restored: string[] = [];
	for (const e of porcelainEntries(worktreePath)) {
		const path = e.path;
		const base = path.split("/").pop() ?? path;
		if (keepTestFiles.has(path) || PHASE_COMMIT_EXCLUDED_BASENAMES.has(base) || isHarnessBookkeepingPath(path)) continue;
		if (e.status === "??") {
			try { rmSync(resolve(worktreePath, path), { force: true }); restored.push(path); } catch { /* best-effort */ }
		} else {
			// v0.3.55 security review F2: `:(literal)` — a file literally named
			// `:(top)*` must not widen this restore past the per-path iteration.
			// v0.3.56 F4: `--staged` added — restore --worktree alone leaves an
			// agent-STAGED change fully alive (worktree is restored FROM the index,
			// so the staged content stays in both). --staged --worktree reverts to
			// HEAD; the follow-up clean removes a staged-NEW file left untracked.
			const literal = `:(literal)${path}`;
			const r = spawnSync("git", ["-C", worktreePath, "restore", "--staged", "--worktree", "--", literal], { encoding: "utf8", timeout: 30_000 });
			if (r.status === 0) {
				spawnSync("git", ["-C", worktreePath, "clean", "-fd", "--", literal], { encoding: "utf8", timeout: 30_000 });
				restored.push(path);
			}
		}
	}
	return restored;
}

/** v0.3.43: basenames that must NEVER ride a phase commit (the spec-18+
 *  convention the LLM committer followed: runtime judge state + the cached
 *  runner spec are per-attempt scratch, not durable phase evidence). */
// v0.3.74 dual review F3: derived from the canonical registry (role
// `phaseCommitExcluded`) — was a sixth parallel basename literal.
const PHASE_COMMIT_EXCLUDED_BASENAMES = (() => {
	// v0.4.3: union with neverGitTracked — defense in depth. After setup
	// untracks + ignores the runtime state (runtime-state-git.ts), `git add -A`
	// skips them via info/exclude; if any path is ever tracked again (a foreign
	// `git add -f`, an older worktree created before v0.4.3 whose untrack pass
	// failed), the committer still must not snapshot resume ledgers into phase
	// commits — a committed ledger is a rollback-revertable ledger (the
	// 2026-09-15T08-13-05-056Z cache-truncation class).
	return new Set([...harnessBasenames("phaseCommitExcluded"), ...harnessBasenames("neverGitTracked")]);
})();

/** v0.3.43 throughput fix (RC4 — LLM doing deterministic work): the per-phase
 *  commit step ran an `orchestrator` agent whose ENTIRE job was `git add -A &&
 *  git commit` — measured 9 calls / 62.5 min / 179K output tokens on run
 *  2026-08-30T08-17-36 (plus one 20-min timeout that stranded a file on the AQ
 *  run). The engine already knows the phase's file set and gate results, so the
 *  commit is now engine-side and deterministic:
 *    - stage ALL worktree changes EXCEPT the runtime-scratch basenames above
 *      (spec-dir docs + ledgers ride the commit exactly like the LLM's phase
 *      convention — they are the durable evidence trail);
 *    - message is deterministic (phase name, gates, claimed/test files);
 *    - in-place runs (no dedicated worktree) and the SUPER_DEV_LLM_COMMITS=1
 *      kill-switch fall back to the orchestrator agent unchanged.
 *  Never throws; returns an honest outcome for the log. */
export function deterministicPhaseCommit(
	worktreePath: string,
	opts: { phaseIndex: number; totalPhases: number; phaseName: string; worktreeCreated?: boolean; gateSummary: string },
): { status: "committed" | "skipped" | "fallback"; sha?: string; reason: string } {
	if (superDevEnv("SUPER_DEV_LLM_COMMITS") === "1") return { status: "fallback", reason: "SUPER_DEV_LLM_COMMITS=1" };
	if (opts.worktreeCreated === false) return { status: "fallback", reason: "in-place run shares the user's checkout — refusing a whole-tree deterministic commit" };
	const git = (...args: string[]) => spawnSync("git", ["-C", worktreePath, ...args], { encoding: "utf8", timeout: 30_000 });
	// Snapshot the porcelain BEFORE staging so the exclusion set is applied to
	// the real change list (not to the staged index we are building).
	// v0.3.45: the -z reader (see porcelainEntries) — v1 lines C-quote space
	// paths on every machine and octal-escape non-ASCII on default
	// `core.quotepath=true` machines, breaking both the exclusion match and
	// the `git reset -- <path>` pathspec for quoted paths.
	const entries = porcelainEntries(worktreePath);
	if (entries.length === 0) return { status: "skipped", reason: "tree already clean — nothing to commit" };
	const committable = entries.filter((e) => {
		const base = e.path.split("/").pop() ?? e.path;
		if (!PHASE_COMMIT_EXCLUDED_BASENAMES.has(base)) return true;
		// v0.4.3: a staged DELETION of an excluded basename is the runtime-state
		// UNTRACKING (runtime-state-git.ts; its own setup commit is best-effort) —
		// it MUST ride this commit, or the path stays in HEAD and every later
		// `git reset --hard` re-tracks and reverts the ledger.
		return e.status[0] === "D";
	});
	if (committable.length === 0) return { status: "skipped", reason: `only runtime-scratch files changed (${entries.length} entr${entries.length === 1 ? "y" : "ies"}) — nothing durable to commit` };
	const add = git("add", "-A");
	if (add.status !== 0) return { status: "fallback", reason: `git add -A failed (exit ${add.status})` };
	// Unstage the excluded basenames AFTER the sweep (pathspec magic per file —
	// cheapest precise form; a failed reset is non-fatal, the commit message
	// names the file set honestly either way). v0.3.55 security review F4:
	// `:(literal)` so an odd filename cannot redirect the reset (residual:
	// exclusion is by BASENAME anywhere in the tree, so content parked at e.g.
	// src/.judge.jsonl is excluded from commits by design — flagged by review,
	// not by git).
	for (const e of entries) {
		const base = e.path.split("/").pop() ?? e.path;
		if (PHASE_COMMIT_EXCLUDED_BASENAMES.has(base) && e.status[0] !== "D") git("reset", "--", `:(literal)${e.path}`);
	}
	const title = `phase ${opts.phaseIndex}/${opts.totalPhases}: ${opts.phaseName}`;
	const message = [`${title}`, "", `Deterministic super-dev phase commit (v0.3.43+; engine-side, no LLM).`, ``, `Gates: ${opts.gateSummary}`, ``, `[super-dev: deterministic-phase-commit]`].join("\n");
	const commit = git("commit", "-m", message);
	if (commit.status !== 0) return { status: "fallback", reason: `git commit failed (exit ${commit.status}): ${String(commit.stderr ?? "").slice(0, 200)}` };
	const sha = git("rev-parse", "--short", "HEAD");
	return { status: "committed", sha: String(sha.stdout ?? "").trim(), reason: `${committable.length} path(s) committed` };
}
