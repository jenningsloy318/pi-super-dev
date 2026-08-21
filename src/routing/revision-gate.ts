/**
 * M3 of the routing-architecture migration: the G4 REVISION-GATE green-skip.
 *
 * §D's phaseStatus carry is implementation-only. Requirements/BDD/research/
 * design/spec convergence nodes had no "already converged + artifact revision
 * unchanged + no new findings → fast-forward" guard — after an inline
 * route-back jump, every stage between the owner and the thrower re-ran its
 * FULL writer+reviewer loop even though its artifact was provably untouched.
 *
 * The gate is deliberately conservative — it fires only when ALL hold:
 *   1. a routing journal with ≥1 entry exists (a jump happened at some point
 *      on this track) — on never-jumped runs the gate is INERT, so kill-switch
 *      and fresh runs stay byte-identical (the G8 invariant);
 *   2. the stage converged earlier in THIS process with a RECORDED revision
 *      (the thrower never records — it threw before approval; the owner's
 *      recorded revision was just bumped by the walker — both re-run);
 *   3. the stage's artifact-revisions.json counter is UNCHANGED since that
 *      convergence (a later jump targeting this stage bumps it → re-run);
 *   4. ZERO pending replan requests target this stage;
 *   5. the stage's cheap DETERMINISTIC validator still passes on the existing
 *      state control — the real safety: it re-checks the artifact against
 *      CURRENT upstream state (e.g. BDD traceability against the just-revised
 *      requirements doc) without a single agent call.
 *
 * MP4: green-skips are never journaled (only jumps are) — the gate adds no
 * journal traffic and stays auditable.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { PipelineState, StageContext } from "../types.ts";
import { ARTIFACT_REVISIONS_FILE, pendingReplanRequests } from "../replan/replan.ts";
import { readRoutingJournal, ROUTING_JOURNAL_FILE } from "./journal.ts";

/** Recorded at genuine approval (incl. duty-override; NOT accept-limitation —
 *  that is a user-forced pass with open blockers and must re-converge). */
export interface ConvergedRevision {
	revision: number;
}

function revisionsFor(specDir: string): Record<string, number> {
	const path = join(specDir, ARTIFACT_REVISIONS_FILE);
	if (!existsSync(path)) return {};
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, number>;
		return parsed && typeof parsed === "object" ? parsed : {};
	} catch {
		return {}; // unreadable → treat every counter as unknown (0-safe: re-run)
	}
}

/** The walker-side store accessor. Stored via cast — PipelineState extension
 *  fields follow the __replan precedent (not part of any stage contract). */
function store(state: PipelineState): Record<string, ConvergedRevision> {
	const s = state as PipelineState & { __convergedRevisions?: Record<string, ConvergedRevision> };
	s.__convergedRevisions ??= {};
	return s.__convergedRevisions;
}

/** Call at genuine approval. Records the stage's CURRENT revision counter so
 *  a later re-entry can diff against it. */
export function recordConvergedRevision(state: PipelineState, stageId: string, specDir: string | undefined): void {
	if (!specDir) return;
	const revs = revisionsFor(specDir);
	store(state)[stageId] = { revision: revs[stageId] ?? 0 };
}

/**
 * The green-skip decision. Returns true (after logging) when the stage may
 * return `{ status: "ok", attempts: 0 }` without any agent call; the caller
 * should treat the artifact as converged. `validate` is the stage's own
 * deterministic validator over state (agent-free).
 */
export function revisionGateFastForward(
	state: PipelineState,
	stageId: string,
	specDir: string | undefined,
): boolean {
	if (!specDir) return false;
	// (1) inert without a jump on this track (G8 byte-identity for fresh and
	// kill-switch runs — those never journal).
	if (!existsSync(join(specDir, ROUTING_JOURNAL_FILE))) return false;
	const journal = readRoutingJournal(specDir);
	if (journal.entries.length === 0) return false;
	// (2) converged earlier in THIS process?
	const recorded = store(state)[stageId];
	if (!recorded) return false;
	// (3) revision unchanged since that convergence?
	const current = revisionsFor(specDir)[stageId] ?? 0;
	if (current !== recorded.revision) return false;
	// (4) no pending replan requests target this stage?
	if (pendingReplanRequests(specDir, stageId).length > 0) return false;
	// (5) synchronous pre-checks pass; the async validator runs in the caller
	// (kept sync for trivial embedding at loop entry — see fastForwardGate).
	return true;
}

/** Full gate INCLUDING the deterministic validator. Returns true when the
 *  stage fast-forwards (logged); false = run the normal loop. */
export async function fastForwardGate(
	state: PipelineState,
	ctx: StageContext,
	stageId: string,
	specDir: string | undefined,
	validate?: (state: PipelineState, ctx: StageContext) => Promise<{ pass: boolean; errors?: string[] }> | { pass: boolean; errors?: string[] },
): Promise<boolean> {
	// A validator is REQUIRED: without one there is no way to re-check the
	// artifact against current upstream state — research (validator-less)
	// conservatively re-runs its loop instead.
	if (!validate) return false;
	if (!revisionGateFastForward(state, stageId, specDir)) return false;
	let ok = false;
	try {
		const r = await validate(state, ctx);
		ok = r.pass;
	} catch {
		ok = false;
	}
	if (!ok) return false;
	ctx.log(`${stageId} convergence: revision-gate FAST-FORWARD (converged earlier this run, revision unchanged, no pending requests, deterministic gate green) — skipping agent calls`);
	recordConvergedRevision(state, stageId, specDir); // idempotent re-record
	return true;
}
