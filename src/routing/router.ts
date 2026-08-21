/**
 * M1 of the routing-architecture migration (docs/requirements/
 * routing-architecture-routeback.md): the ONE routing vocabulary.
 *
 * Today five mechanisms own continue/stop/route decisions — escalation
 * choices, judge routes, the replan circuit, retry decisions, and
 * convergence-loop internal branches — each with its own vocabulary,
 * trigger, and budget. "Route back to stage X" maps to none of them
 * (incident run 2026-08-21T03-23-47-913Z: the user's reply was recorded,
 * classified retry-with-guidance, and re-ran the SAME stage).
 *
 * This module defines the normalized vocabulary every producer will map onto
 * (M2–M4). M1 ships with ZERO production call sites — nothing here runs in
 * the pipeline yet. Shape decisions are pinned by tests/routing-router.test.ts.
 *
 * Determinism contract (MP3): every classify/budget function below is a pure
 * function of its declared inputs — no wall-clock, no randomness, no
 * filesystem, no environment reads. Timestamps are SUPPLIED by the caller
 * (the M2 journal IO layer), never minted here, so a resume replay follows
 * the same code path to the same answer (Temporal's deterministic-workflow
 * rule; a nondeterministic router makes journal and replay disagree, which
 * is worse than no journal).
 */

import { FatalAbort } from "../nodes.ts";
import { STAGE_IDS, downstreamOf } from "../graph/edges.ts";
import { REPLAN_OWNER_STAGES, type ReplanOwnerStage } from "../replan/owners.ts";

// ─── Stage ids ───────────────────────────────────────────────────────────────

/** Pipeline stage ids addressable by routing (mirrors STAGE_IDS; kept local so
 *  this module never couples to the skeleton's export surface). */
export type RouteStageId = string;

/** Routable owner stages — IS the closed REPLAN_OWNER_STAGES set (imported
 *  from replan/owners.ts, never mirrored: review F-1). Only these own
 *  artifacts a route-back can meaningfully re-enter; fixer-domain owner
 *  stages (implementation etc.) classify as same-stage retry, never
 *  route-back. */
export const ROUTABLE_OWNER_STAGES = REPLAN_OWNER_STAGES;
export type RoutableOwnerStage = ReplanOwnerStage;

/** True when `stage` is in the closed routable-owner set. */
export function isRoutableOwnerStage(stage: string): stage is RoutableOwnerStage {
	return (ROUTABLE_OWNER_STAGES as readonly string[]).includes(stage);
}

/** Skeleton order test (review F-2): true only when `a` sits strictly BEFORE
 *  `b` in STAGE_IDS. Stages absent from the skeleton (or equal) are NOT
 *  upstream — the safe direction is same-stage retry, never a bogus
 *  back-edge to a downstream owner. */
export function stagePrecedes(a: RouteStageId, b: RouteStageId): boolean {
	const ia = (STAGE_IDS as readonly string[]).indexOf(a);
	const ib = (STAGE_IDS as readonly string[]).indexOf(b);
	return ia >= 0 && ib >= 0 && ia < ib;
}

// ─── The vocabulary ──────────────────────────────────────────────────────────

/** The one normalized routing decision. Every producer (escalation choices,
 *  judge routes, replan circuit, convergence branches) maps onto this enum —
 *  see classifyEscalationChoice / classifyJudgeRoute / classifyFindingRoute. */
export type RoutingAction =
	| "continue" /** proceed; nothing to route */
	| "retry" /** re-run the SAME stage with feedback */
	| "route-back" /** jump to an UPSTREAM owning stage (graph back-edge) */
	| "escalate" /** surface to the human; no automatic actuator */
	| "accept-limitation" /** record and proceed despite the blocker */
	| "abort"; /** end the run honestly */

export interface RoutingCommandBase {
	/** The stage that produced the decision (the thrower / decision site). */
	from: RouteStageId;
	/** Human-readable reason — goes to logs and the journal. */
	reason: string;
	/** Finding ids driving the decision (empty for non-finding decisions). */
	findingIds: string[];
}

export interface ContinueCommand extends RoutingCommandBase {
	action: "continue";
}

export interface RetryCommand extends RoutingCommandBase {
	action: "retry";
	/** Feedback lines reaching the retried stage's prompt. */
	feedback: string[];
}

export interface RouteBackCommand extends RoutingCommandBase {
	action: "route-back";
	/** The upstream owning stage to re-enter. */
	to: RoutableOwnerStage;
	/** G3: walk position — the forward walk resumes at the index AFTER `to`
	 *  in the addressable stage list. Filled by the M2 walker; -1 = unset. */
	resumeFromIndex: number;
	/** G3: stages invalidated by the back-edge (owner + downstreamOf(owner)). */
	invalidated: RouteStageId[];
}

export interface EscalateCommand extends RoutingCommandBase {
	action: "escalate";
	/** Why escalation (upstream-owned, stall, budget-exhausted, environment…). */
	escalationKind:
		| "upstream-owned"
		| "stall"
		| "budget-exhausted"
		| "environment"
		| "needs-human";
}

export interface AcceptLimitationCommand extends RoutingCommandBase {
	action: "accept-limitation";
}

export interface AbortCommand extends RoutingCommandBase {
	action: "abort";
}

export type RoutingCommand =
	| ContinueCommand
	| RetryCommand
	| RouteBackCommand
	| EscalateCommand
	| AcceptLimitationCommand
	| AbortCommand;

// ─── RouteBackSignal (G2) ────────────────────────────────────────────────────

/**
 * The in-process back-edge carrier. Extends FatalAbort so propagation is
 * airtight through every existing combinator — task() re-throws
 * isFatalAbort(err) and sequence() re-throws FatalAbort through tolerant
 * mode (nodes.ts) — with ZERO combinator changes. The M2 walker catches it
 * ABOVE root.run, before runWorkflow's summary derivation, so an inline
 * route-back never ends the run.
 */
export class RouteBackSignal extends FatalAbort {
	readonly command: RouteBackCommand;

	constructor(command: RouteBackCommand) {
		super(`ROUTE-BACK ${command.from}→${command.to}: ${command.reason}`);
		this.name = "RouteBackSignal";
		this.command = command;
	}
}

/** True for a RouteBackSignal (FatalAbort subclass check first for cheapness). */
export function isRouteBackSignal(err: unknown): err is RouteBackSignal {
	return err instanceof RouteBackSignal;
}

// ─── Per-edge budget (MP2) ───────────────────────────────────────────────────

/** Serialized per-edge budget state — hydrate from the persisted routing
 *  journal, NEVER from an in-process counter: a budget read that gates a jump
 *  must observe every prior persisted jump, or two resumes of the same run
 *  silently re-arm it (the exactly-once-send lesson; the pre-sd26 guidance
 *  grant failed exactly this way). */
export interface RoutingBudgetState {
	/** `"${from}→${to}"` → jumps consumed. */
	edges: Record<string, number>;
}

/** Default per-edge jump cap per run (the plan's anti-ping-pong bound;
 *  exhaustion degrades to escalate — never an unbounded back-edge). */
export const DEFAULT_EDGE_BUDGET = 2;

export function edgeKey(from: RouteStageId, to: RouteStageId): string {
	return `${from}→${to}`;
}

/** Jumps already consumed on (from→to) — pure read over persisted state. */
export function consumedBudget(
	state: RoutingBudgetState,
	from: RouteStageId,
	to: RouteStageId,
): number {
	return state.edges[edgeKey(from, to)] ?? 0;
}

/** Budget remaining on (from→to); never negative. */
export function remainingBudget(
	state: RoutingBudgetState,
	from: RouteStageId,
	to: RouteStageId,
	cap: number = DEFAULT_EDGE_BUDGET,
): number {
	return Math.max(0, cap - consumedBudget(state, from, to));
}

/** Immutable consume: returns a NEW state with one jump charged to the edge.
 *  Pure — callers persist the result via the M2 journal write (sync-before-
 *  re-entry, MP1). */
export function consumeBudget(
	state: RoutingBudgetState,
	from: RouteStageId,
	to: RouteStageId,
): RoutingBudgetState {
	const key = edgeKey(from, to);
	return { edges: { ...state.edges, [key]: consumedBudget(state, from, to) + 1 } };
}

// ─── Journal types (G3 / MP4) ────────────────────────────────────────────────

/**
 * MP4 semantics-aware journaling: ONLY routing decisions that change the walk
 * are journaled — jumps and budget consumption. Fast-forwards, green-skips,
 * and ordinary convergence rounds are NOT (Crab: 75%+ of turns carry no
 * recovery-relevant state; blanket checkpointing is waste). Keeps the journal
 * small enough to audit by eye.
 */
export interface RoutingJournalEntry {
	/** Monotonic sequence within the run (assigned by the journal IO layer). */
	seq: number;
	kind: "route-back";
	/** The thrower. */
	from: RouteStageId;
	/** The owning stage re-entered. */
	to: RoutableOwnerStage;
	reason: string;
	findingIds: string[];
	/** G3: where the forward walk resumed after the owner re-converged. */
	resumeFromIndex: number;
	/** G3: stages invalidated by this back-edge. */
	invalidated: RouteStageId[];
	budgetBefore: number;
	budgetAfter: number;
	/** Caller-supplied timestamp (MP3: never minted inside the router). */
	at: string;
	/** MP1 post-jump offsets (M2): resume-cache rows the jump dropped. */
	cacheDropped?: number;
	/** MP1: the owner's artifact-revision counter AFTER the bump. */
	revisionAfter?: number;
}

export interface RoutingJournal {
	entries: RoutingJournalEntry[];
}

/** Hydrate the budget view from a journal (the MP2 persisted source). */
export function budgetFromJournal(journal: RoutingJournal): RoutingBudgetState {
	const edges: Record<string, number> = {};
	for (const e of journal.entries) {
		const key = edgeKey(e.from, e.to);
		edges[key] = (edges[key] ?? 0) + 1;
	}
	return { edges };
}

// ─── Pure classification (maps today's five mechanisms onto the vocabulary) ─

/** Map an escalation choice (types.ts EscalationChoice) onto the vocabulary.
 *  The route-back gap: NONE of today's four choices can express "jump to the
 *  owning stage" — M4 adds `route-back:<owner>` and routes it here.
 *  Known conflation (review F-6): revise-manually → retry matches the
 *  artifact-convergence call site; gate()'s escalation path treats it via
 *  applyRetryDecision — M4 unifies both onto this table. */
export function classifyEscalationChoice(choice: string): RoutingAction {
	switch (choice) {
		case "retry-with-guidance":
		case "revise-manually":
			return "retry"; // same-stage by design (documented)
		case "accept-limitation":
			return "accept-limitation";
		case "abandon":
			return "abort";
		case "route-back":
			return "route-back";
		default:
			return "escalate"; // unknown choice → safest actuator: the human
	}
}

/** Map a judge route (stages/judge.ts JUDGE_ROUTES) onto the vocabulary. */
export function classifyJudgeRoute(route: string): RoutingAction {
	switch (route) {
		case "re-author-tests":
		case "challenge-test":
		case "implementer-retry":
			return "retry";
		case "replan-upstream":
			return "route-back";
		case "fix-environment":
			return "escalate"; // today's soft-HITL seam; NOTE (review F-6) the RED-phase
			// repair-hint seam (implementation.ts ~1298, stage9.red-no-progress) consumes it WITHOUT escalation
			// — M4 unifies both seams onto this table
		case "allow-scaffold":
		case "continue":
			return "continue";
		case "escalate-now":
			return "escalate";
		default:
			return "escalate";
	}
}

/** Minimal finding shape the router reasons over (structural subset of
 *  ConvergenceFinding — keeps this module decoupled from the ledger types). */
export interface RoutableFindingLike {
	id?: unknown;
	ownerStage?: unknown;
	blocking?: unknown;
	status?: unknown;
	severity?: unknown;
}

function ownerIsUpstreamOf(owner: unknown, ownStage: RouteStageId): owner is RoutableOwnerStage {
	return (
			typeof owner === "string" &&
			owner !== ownStage &&
			isRoutableOwnerStage(owner) &&
			stagePrecedes(owner, ownStage) // F-2: a DOWNSTREAM routable owner is NOT a back-edge
		);
}

/**
 * Classify ONE finding against the stage that surfaced it:
 *  - blocking + upstream routable owner  → route-back (the MetaGPT lookup:
 *    destination-addressed artifacts make routing a table read)
 *  - blocking + own/fixer-domain owner    → retry (the stage can fix it)
 *  - needs-human + high severity          → escalate
 *  - anything else                        → continue (advisory)
 */
export type FindingRoute =
	| { action: "route-back"; to: RoutableOwnerStage; findingId: string }
	| { action: "retry"; findingId: string }
	| { action: "escalate"; findingId: string; escalationKind: "needs-human" }
	| { action: "continue"; findingId: string };

export function classifyFindingRoute(
	finding: RoutableFindingLike,
	ownStage: RouteStageId,
): FindingRoute {
	const id = typeof finding.id === "string" ? finding.id : "(unidentified)";
	const blocking = finding.blocking === true;
	const needsHuman = finding.status === "needs-human";
	const severity = typeof finding.severity === "string" ? finding.severity.toLowerCase() : "";
	const highClass = /(^|\W)(critical|blocker|fatal|high|major|must.?fix|p0|p1|s0|s1|sev0|sev1|serious)(\W|$)/.test(severity);
	if (blocking && ownerIsUpstreamOf(finding.ownerStage, ownStage)) {
		return { action: "route-back", to: finding.ownerStage, findingId: id };
	}
	if (blocking) {
		// Covers own-stage owners, fixer-domain owners (implementation),
		// downstream routable owners, and environment-owned blockers (F-2).
		return { action: "retry", findingId: id };
	}
	if (needsHuman && highClass) {
		return { action: "escalate", findingId: id, escalationKind: "needs-human" };
	}
	return { action: "continue", findingId: id };
}

/**
 * Budget-gated route-back: the ONLY entry the M2+ walker will use. A
 * route-back with no remaining budget degrades to escalate — never an
 * unbounded back-edge, never a silent same-stage retry.
 */
export function routeBackOrEscalate(
	from: RouteStageId,
	to: RoutableOwnerStage,
	reason: string,
	findingIds: string[],
	budget: RoutingBudgetState,
	cap: number = DEFAULT_EDGE_BUDGET,
): RoutingCommand {
	if (remainingBudget(budget, from, to, cap) <= 0) {
		return {
			action: "escalate",
			from,
			reason: `edge budget exhausted (${edgeKey(from, to)} cap ${cap}) — was: ${reason}`,
			findingIds,
			escalationKind: "budget-exhausted",
		};
	}
	return {
		action: "route-back",
		from,
		to,
		reason,
		findingIds,
		resumeFromIndex: -1,
		invalidated: [to, ...downstreamOf(to)],
	};
}

// ─── Determinism self-check ─────────────────────────────────────────────────

/** MP3 pin — a same-instant referential-transparency tripwire, NOT proof of
 *  determinism (that is enforced by the no-io/no-clock discipline above and
 *  review); used by tests and available to the M2 walker as a sanity check. */
export function deterministicClassify<T>(fn: () => T): { first: T; second: T; stable: boolean } {
	const first = fn();
	const second = fn();
	return { first, second, stable: JSON.stringify(first) === JSON.stringify(second) };
}
