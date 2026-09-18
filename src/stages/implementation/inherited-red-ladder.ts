/**
 * The inherited-red tier ladder — increment 9 of the stage.ts split.
 *
 * THE BLOCK THIS REPLACES (stage.ts, the `if (... inheritedRedBoundaryShape(...)
 * .shape)` block after the signature recording): when the GATE is the blocker,
 * every remaining failure is out-of-scope, own-scope evidence is green, and
 * attribution decides —
 *
 *   • not-evaluable          → metrics-only log, fall through (today's semantics)
 *   • TIER 0 own-leak        → deterministic revert of the phase's undeclared
 *                              out-of-scope tracked dirt; retry consuming the
 *                              phase's attempt budget (or fall through at an
 *                              exhausted budget — metrics-only, tally untouched)
 *   • TIER 1 flake filter    → one per-run deterministic full-gate re-run
 *                              (never consumes an attempt): flake cleared →
 *                              the phase is GREEN via the re-run; still-red →
 *                              the classification stands
 *   • TIER 3 second occurrence → FatalAbort (stop-the-line, no retry loop)
 *   • TIER 2 occurrence #1   → the declared handoff: one replan-requests.json
 *                              row via triggerReplanForFindings; routed → the
 *                              phase ends partial, run ends status "replan";
 *                              unavailable → FatalAbort (the tally was consumed)
 *
 * THE CONTROL-FLOW CONVERSION (the fifth, after red-judge v0.4.32,
 * research-assist-dispatch v0.4.34, red-review-join v0.4.35, protection-gate
 * v0.4.36): the block had ONE `continue` (Tier-0 retry), TWO `break`s
 * (flake-green, handoff-routed) and TWO `throw new FatalAbort`s (Tier 3,
 * handoff-unavailable). The breaks became returned variants; the throws STAY
 * throws inside the module (they propagate through the stage identically —
 * no caller interpretation arm needed).
 *
 * THE P3 GUARDS STAY IN THE CALLER: replanPending(state) / envJudgeOverride
 * Feedback / postRegateProductErrors / runFuse.tripped are loop- and run-scoped
 * state the caller checks to skip the call entirely. The shape guard (this
 * ladder's own trigger predicate, a pure function) lives HERE.
 *
 * THE v0.4.33 CROSS-ITERATION LESSON (applied by construction): every outcome
 * carries `attemptErrorsAppend` (possibly empty) so the caller appends
 * uniformly; ONLY flake-green REPLACES attemptErrors (with the re-run gate's
 * errors — the inline semantics). In-place state stays in-place by reference:
 * lastFailures.splice, phaseStatusUpsert, and the flake-grant flag holder are
 * mutated exactly where the inline code mutated them; the caller applies only
 * green / attemptErrors / terminalStopReason.
 */

import type { StageContext, PipelineState } from "../../types.ts";
import { FatalAbort } from "../../nodes.ts";
import {
	INHERITED_RED_SOURCE,
	appendInheritedRedEvent,
	countInheritedRedOccurrences,
	extractFailingTestFilePaths,
	f4ScopeMatch,
	inheritedRedAttribution,
	inheritedRedBoundaryShape,
	inheritedRedFlakeTally,
	normalizeRepoPath,
} from "../inherited-red.ts";
import { triggerReplanForFindings, countInheritedRedRows } from "../../replan/replan.ts";
import { runBuildGate, type BuildGateResult, type GateOptions } from "../../build-runner.ts";
import { appendGateChecked } from "../../runlog.ts";
import { phaseStatusUpsert } from "./phase-status.ts";
import { maxPhaseAttempts } from "./phase-reentry.ts";
import { porcelainEntries, restorePaths } from "./red-evidence.ts";

/** The ladder's verdict. `pass` covers: shape guard failed, not-evaluable, and
 *  Tier-0-at-exhausted-budget (all metrics-only fall-throughs — the boundary
 *  logic below the block proceeds, attemptErrorsAppend still lands). */
export type InheritedRedOutcome =
	| { kind: "pass"; attemptErrorsAppend: string[] }
	| { kind: "tier0-retry"; attemptErrorsAppend: string[] }
	| { kind: "flake-green"; attemptErrorsAppend: string[]; gateErrors: string[] }
	| { kind: "handoff-routed"; attemptErrorsAppend: string[] };

export interface InheritedRedInput {
	ctx: StageContext;
	state: PipelineState;
	worktreePath: string;
	specDirectory: string;
	specIdentifier: string;
	defaultBranch: string | undefined;
	phaseId: string;
	/** The phase's index (for f4ScopeMatch owner derivation). */
	idx: number;
	phases: Array<Record<string, unknown>>;
	/** The attempt's full-suite gate verdict. */
	gate: BuildGateResult;
	/** Own-scope evidence (the boundary-shape arm). */
	ownScope: { deliverablePass: boolean; changePass: boolean; symbolPass: boolean; tddClean: boolean };
	coverageBlocked: boolean;
	declaredScope: Set<string>;
	/** Worktree dirt paths + the paths dirt at this phase's first-ever start. */
	dirtPaths: string[];
	phaseStartSet: Set<string>;
	/** The current attempt number. */
	attempt: number;
	/** In/out: the stage's lastFailures rows (splice in place, as inline). */
	lastFailures: Array<{ phaseId: string; reasons: string[]; [k: string]: unknown }>;
	/** In/out: the phase-status rows (upsert in place, as inline). */
	phaseStatus: Array<{ id: string; status: string; [k: string]: unknown }>;
	/** In/out: the run-scoped per-run flake-grant flag (one re-run per run). */
	flakeGrant: { used: boolean };
	/** The phase-status kit closures (announce the Tier-1 re-run, emit green). */
	announceActivity: (activity?: string, detail?: string) => void;
	emitPhaseStatus: (status: "running" | "ok" | "failed" | "skipped" | "partial") => void;
	attemptDetail: (attempt: number, extra?: string) => string;
}

/**
 * Adjudicate the inherited-red boundary. FatalAbort THROWS stay throws (Tier 3
 * second-occurrence and handoff-unavailable propagate through the stage
 * identically to the inline block).
 */
export async function adjudicateInheritedRedLadder(input: InheritedRedInput): Promise<InheritedRedOutcome> {
	const { ctx, state, worktreePath, specDirectory, specIdentifier, defaultBranch, phaseId, idx, phases, gate, ownScope, coverageBlocked, declaredScope, dirtPaths, phaseStartSet, attempt, lastFailures, phaseStatus, flakeGrant, announceActivity, emitPhaseStatus, attemptDetail } = input;

	// The ladder's own trigger predicate (pure; the P3 run-state guards were
	// checked by the caller before dispatching here).
	if (!inheritedRedBoundaryShape({ gate, ownScope, coverageBlocked, declaredScope }).shape) {
		return { kind: "pass", attemptErrorsAppend: [] };
	}

	const prePhaseDirt = dirtPaths.filter((p) => phaseStartSet.has(normalizeRepoPath(p)));
	const ownLeakPaths = dirtPaths.filter((p) => !phaseStartSet.has(normalizeRepoPath(p)));
	const baselineStatus = gate.baselineCheck?.status;
	const attribution = inheritedRedAttribution({ baselineStatus, prePhaseDirt, ownLeakPaths });

	if (attribution === "not-evaluable") {
		// The deliberate exclusion: no attribution evidence (unknown baseline) —
		// today's behavior; the poison, if any, is caught at the next completed gate.
		ctx.log(`Implementation ${phaseId} inherited-red boundary: NOT EVALUABLE (baseline=${baselineStatus ?? "absent"}) — attribution needs evidence; today's retry semantics stand`);
		return { kind: "pass", attemptErrorsAppend: [] };
	}

	if (attribution === "own-leak") {
		// TIER 0 — deterministic attribution: an out-of-scope subject that passes
		// at baseline cannot break on a tree clean at phase start any other way
		// than this phase's own edits (G1's row-2 derivation). Revert the phase's
		// undeclared out-of-scope dirt (deterministic, no agent call — runs even
		// at exhausted attempt budget) and retry CONSUMING the phase's own attempt
		// budget. The revert is NON-DESTRUCTIVE: only CONFIRMED tracked/staged
		// leaks are restored to HEAD; UNTRACKED new files are the implementer's
		// live work (kept on disk for the partial preserve-stash, named in the
		// retry feedback). A failed/empty porcelain read reverts NOTHING
		// (fail-safe: no destructive op on unknown state).
		const tier0Entries = porcelainEntries(worktreePath);
		const tier0Untracked = new Set(tier0Entries.filter((e) => e.status.startsWith("?")).map((e) => e.path));
		const tier0Tracked = new Set(tier0Entries.filter((e) => !e.status.startsWith("?")).map((e) => e.path));
		const revertableLeakPaths = ownLeakPaths.filter((p) => tier0Tracked.has(p) && !tier0Untracked.has(p));
		const liveLeakPaths = ownLeakPaths.filter((p) => !revertableLeakPaths.includes(p));
		appendInheritedRedEvent(specDirectory, { event: "tier0-own-leak", phaseId, outcome: revertableLeakPaths.length ? "reverted" : ownLeakPaths.length ? "live-work-named" : "no-revertable-dirt", ownLeakPaths, baseline: baselineStatus }, ctx.log);
		const attemptErrorsAppend: string[] = [];
		if (revertableLeakPaths.length > 0) {
			restorePaths(worktreePath, revertableLeakPaths);
			attemptErrorsAppend.push(...revertableLeakPaths.map((p) => `inherited-red-own-leak-reverted: ${p}`));
		}
		if (ownLeakPaths.length > 0) {
			ctx.log(`Implementation ${phaseId} inherited-red Tier 0 (own-leak): regression on a tree clean at phase start with no pre-phase dirt — the out-of-scope failure is this phase's own leak; REVERTED ${revertableLeakPaths.length} tracked undeclared out-of-scope path(s) (${revertableLeakPaths.join(", ") || "none"}) — deterministic cleanup, no agent call${liveLeakPaths.length ? `; LEFT ${liveLeakPaths.length} untracked live-work path(s) in place, never destroyed (${liveLeakPaths.join(", ")}) — named in the retry feedback and preserved for the partial stash` : ""}`);
		} else {
			ctx.log(`Implementation ${phaseId} inherited-red Tier 0 (own-leak): no revertable undeclared out-of-scope dirt — the leak rides the phase's in-scope edits (an in-scope product regression; the implementer retry carries the failure feedback)`);
		}
		if (attempt < maxPhaseAttempts() && ctx.budget.check()) {
			ctx.log(`Implementation ${phaseId} inherited-red Tier 0: retrying (the phase's own attempt budget is consumed — attempt ${attempt + 1} of ${maxPhaseAttempts()})`);
			return { kind: "tier0-retry", attemptErrorsAppend };
		}
		ctx.log(`Implementation ${phaseId} inherited-red Tier 0: attempt budget exhausted (attempt ${attempt}/${maxPhaseAttempts()}) — the revert still ran; the phase ends partial and boundary logic proceeds (Tier-0 boundaries are metrics-only and never consume the occurrence tally)`);
		return { kind: "pass", attemptErrorsAppend };
	}

	// attribution === "inherited" — Tier 1 flake filter first.
	let tier1Gate: BuildGateResult | null = null;
	if (!flakeGrant.used) {
		flakeGrant.used = true;
		announceActivity("Inherited-red flake filter (Tier 1)", attemptDetail(attempt));
		tier1Gate = runBuildGate(worktreePath, { gate: (state.spec?.gate) as GateOptions | undefined, signal: ctx.signal, defaultBranch });
		appendGateChecked(state, "phase-build:inherited-red-flake-rerun", tier1Gate, "implementation");
		const flakeCleared = tier1Gate.pass || tier1Gate.inScopePass;
		appendInheritedRedEvent(specDirectory, { event: "flake-rerun", phaseId, outcome: flakeCleared ? "flake-cleared" : "still-red", baseline: baselineStatus }, ctx.log);
		ctx.log(`Implementation ${phaseId} inherited-red Tier 1 (flake filter): deterministic full-gate re-run → ${flakeCleared ? "GREEN" : "RED"} (the re-run NEVER consumes an implementer attempt; the per-run grant is now spent; flake tally ${inheritedRedFlakeTally(specDirectory)})`);
		if (flakeCleared) {
			// Green-through on the re-run (the env-blocker T3.3 precedent):
			// own-scope evidence is green by the trigger shape, so the phase is
			// green — NOT inherited-red; metrics-only, the tally is never consumed
			// and a flake is never a retry reason.
			phaseStatusUpsert(phaseStatus as never, phaseId, "green", attempt); // v0.3.85 S3: peak-attempts metric
			emitPhaseStatus("ok");
			const irfi = lastFailures.findIndex((f) => f.phaseId === phaseId); if (irfi >= 0) lastFailures.splice(irfi, 1);
			ctx.log(`Implementation ${phaseId} ${tier1Gate.pass ? "GREEN" : "IN-SCOPE GREEN"} via inherited-red Tier 1 flake filter on attempt ${attempt} — flake cleared, not inherited-red (occurrence tally NEVER consumed)`);
			return { kind: "flake-green", attemptErrorsAppend: [], gateErrors: tier1Gate.errors };
		}
	} else {
		ctx.log(`Implementation ${phaseId} inherited-red Tier 1 (flake filter): per-run grant already spent — the classification stands without a re-run (flake tally ${inheritedRedFlakeTally(specDirectory)})`);
	}

	// TIER 2 decision — occurrence accounting (ledger-backed, persists across
	// resume). Subjects come from the freshest gate (the Tier-1 re-run when it
	// ran); the owning prior phase is derived from the same Option-C scope
	// predicate F4 uses (Arm A clause files ∪ Arm B recorded failing paths of
	// prior PARTIAL phases). Never trust gate shapes at consumption sites
	// (Array-guarded reads; a runtime gate with an absent array cannot
	// TypeError inside the Tier-2/3 subject naming).
	const subjectsGate = tier1Gate ?? gate;
	const irOos = Array.isArray(subjectsGate.outOfScopeErrors) ? subjectsGate.outOfScopeErrors : [];
	const irSubjects = [...new Set([...irOos, ...extractFailingTestFilePaths(irOos)])].slice(0, 6) as string[];
	const irOwner = f4ScopeMatch([...prePhaseDirt, ...extractFailingTestFilePaths(irOos)], phases, phaseStatus as never, idx, lastFailures as never);
	const priorOccurrences = countInheritedRedOccurrences(specDirectory);
	const priorHandoffRows = countInheritedRedRows(specDirectory);

	if (priorOccurrences >= 1 || priorHandoffRows >= 1) {
		// TIER 3 — second occurrence (or sub-cap spent by an F2/F4 trigger):
		// FatalAbort naming the failing subjects + the owning prior phase. The
		// poisoned baseline propagated past the single declared handoff —
		// stop-the-line.
		appendInheritedRedEvent(specDirectory, { event: "occurrence", phaseId, outcome: "tier3-fatal", subjects: irSubjects, attribution, baseline: baselineStatus }, ctx.log);
		ctx.log(`Implementation ${phaseId} inherited-red Tier 3: SECOND OCCURRENCE (prior occurrences=${priorOccurrences}, inherited-red handoff rows=${priorHandoffRows}) — FatalAbort naming the failing subjects + the owning prior phase (stop-the-line; no retry loop)`);
		throw new FatalAbort(`inherited-red second occurrence at ${phaseId} (v0.3.85 F2, ADR 9): gate failures are out-of-scope by attribution (baseline=${baselineStatus ?? "n/a"}; ${prePhaseDirt.length} pre-phase dirt path(s): ${prePhaseDirt.slice(0, 6).join(", ") || "none"}) — failing subjects: ${irSubjects.join(" | ").slice(0, 600)}; owning prior phase: ${irOwner ? `${irOwner.phaseId} (arm ${irOwner.arm}, ${irOwner.path})` : "unidentified (no prior partial phase's declared scope matches the poison paths — pre-run dirt)"}. The poisoned baseline already consumed the single declared handoff; stop-the-line.`);
	}

	// Occurrence #1 → TIER 2 declared handoff: one replan-requests.json row
	// (ownerStage:"spec" + source:"inherited-red" + sourcePhase) via the
	// existing triggerReplanForFindings circuit; consumes ONE round of the
	// shared SUPER_DEV_MAX_REPLAN_ROUNDS pool; the run ends status "replan" and
	// the amended plan must pass the plan-feasibility validator before
	// execution (§D re-entry).
	const irFinding: Record<string, unknown> = {
		id: `inherited-red-${phaseId}`,
		file: null,
		severity: "high",
		title: `inherited-red partial boundary at ${phaseId}: gate failures out-of-scope by attribution (baseline=${baselineStatus ?? "n/a"})`,
		detail: `The full-suite gate is red on failures outside this phase's declared targets, and attribution says they are NOT this phase's own: baseline=${baselineStatus ?? "n/a"}${prePhaseDirt.length ? `, ${prePhaseDirt.length} pre-phase dirt path(s) (${prePhaseDirt.slice(0, 6).join(", ")}) predating the phase's first-ever start` : ""}. Failing subjects: ${irSubjects.join(" | ").slice(0, 600)}. A prior phase left a poisoned baseline this phase cannot clear inside its declared scope — continuing forward-continues the poison (the C1 disease).`,
		ownerStage: "spec",
		source: INHERITED_RED_SOURCE,
		sourcePhase: phaseId,
		recommendation: "Merge the unfinished scope forward: amend the plan so the phase that owns the failing subjects' production change also owns the atomic test amendment (co-ownership in any clause form counts), or reorder/merge phases so the baseline this phase gates against is green when its turn comes.",
	};
	let irRouted = false;
	try { irRouted = await triggerReplanForFindings(state, ctx, [irFinding], "implementation", specIdentifier); } catch { irRouted = false; }
	if (irRouted) {
		appendInheritedRedEvent(specDirectory, { event: "occurrence", phaseId, outcome: "tier2-handoff-routed", subjects: irSubjects, attribution, baseline: baselineStatus }, ctx.log);
		ctx.log(`Implementation ${phaseId} inherited-red Tier 2 (declared handoff): occurrence 1 — replan-requests.json row routed via the shared replan pool (source:inherited-red, sourcePhase:${phaseId}, ownerStage:spec); consuming ONE SUPER_DEV_MAX_REPLAN_ROUNDS round; the phase ends partial and the run ends status "replan" (auto-resume → spec convergence regenerates the plan → plan-feasibility validator → §D re-entry)`);
		return { kind: "handoff-routed", attemptErrorsAppend: [`inherited-red: gate failures out-of-scope by attribution (baseline=${baselineStatus ?? "n/a"}) — declared handoff routed (source:inherited-red, sourcePhase:${phaseId}); the run ends status "replan"`] };
	}
	// The handoff could not route (pool exhausted / marker set / write failure):
	// the occurrence still consumed the tally — routing Tier 3 keeps the C1
	// disease from forward-continuing silently.
	appendInheritedRedEvent(specDirectory, { event: "occurrence", phaseId, outcome: "handoff-unavailable", subjects: irSubjects, attribution, baseline: baselineStatus }, ctx.log);
	ctx.log(`Implementation ${phaseId} inherited-red Tier 2: declared handoff UNAVAILABLE (replan pool exhausted / marker set / ledger write failure) — the occurrence consumed the tally; routing Tier 3 FatalAbort (no retry loop)`);
	throw new FatalAbort(`inherited-red declared handoff unavailable at ${phaseId} (v0.3.85 F2, ADR 8/9): the replan circuit could not route while the gate is red on out-of-scope failures by attribution (baseline=${baselineStatus ?? "n/a"}). Failing subjects: ${irSubjects.join(" | ").slice(0, 600)}; owning prior phase: ${irOwner ? `${irOwner.phaseId} (arm ${irOwner.arm}, ${irOwner.path})` : "unidentified (pre-run dirt)"}. Stop-the-line — no retry loop.`);
}
