/**
 * v0.3.85 S3 (§9 S3 / §13 run-metrics row of
 * docs/requirements/run-2026-09-09-poisoned-baseline-postmortem-v0.3.85.md) —
 * the run-health counter DERIVATION. The row schema and σ-banding live in
 * sigma-bands.ts (the owner); this module reads the run's own durable
 * territory and produces the this-pass counter set the close-out writes.
 *
 * Constitution §8.3 ("no subsystem may die silently"): every counter is
 * file/state-backed — the meters are wired to the territory, not to a log
 * line someone hoped would appear:
 *
 *   judgeAccepted / judgeDiscarded ← events.jsonl `judge.called` rows for THIS
 *       runId (runJudge double-writes every outcome there, P1.5). "routed" is
 *       accepted (verification passed, or a documented INV-2 exemption — the
 *       per-row reason is in .judge.jsonl); "discarded" is the honest discard
 *       class (evidence verification failed with the corrective budget
 *       exhausted). Timeout/infra failures surface as "degraded" — INV-6
 *       infrastructure degradation is NEITHER accepted NOR discarded, and this
 *       meter never conflates the classes (conflating them is exactly the
 *       dishonesty the C2 lesson forbids).
 *   partialPhases / maxPhaseAttempts ← state.implementation.phaseStatus (the
 *       §D-persisted per-phase truth; `attempts` is the peak per-§D-entry
 *       implementer attempt count, recorded by phaseStatusUpsert).
 *   inheritedRedHandoffs ← replan-requests.json rows with
 *       source:"inherited-red" created at/after THIS run's `run.started`
 *       event. NOTE: the writing machinery (triggerReplanForFindings call
 *       sites) records the SPEC IDENTIFIER in `originatedRunId`, not the run
 *       UUID — so the run.started time window is the authoritative this-pass
 *       predicate, not a runId equality match.
 *   inheritedRedOccurrences ← .inherited-red.jsonl rows with
 *       event:"occurrence" and ts at/after the same window (the survived-
 *       Tier-0+1 tally; distinct from the broader gate-classification count).
 *
 * Degraded reads (missing/unreadable files, no run.started bracket) fall back
 * honestly: judge counters scope to the runId (0 when absent), the
 * inherited-red counters degrade to the LIFETIME tally with the window
 * unknown — a documented approximation, never a silent omission (P10).
 * NEVER throws (best-effort observability, P5).
 */
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { readRunEvents } from "../runlog.ts";
import { readInheritedRedEvents, INHERITED_RED_SOURCE } from "../stages/inherited-red.ts";
import { REPLAN_REQUESTS_FILE } from "../replan/replan.ts";
import type { S3Counters } from "./sigma-bands.ts";

/** The implementation-control shape the derivation reads (workflow.ts passes
 * state.implementation; the E2E harness passes the stage's control). */
export type S3ImplementationState = {
	phaseStatus?: Array<{ id?: string; status?: string; attempts?: number }>;
} | undefined;

/** resolve a spec-dir-relative file name the way the writers do (absolute
 * passes through; relative joins the process cwd — replan.ts specPath /
 * inherited-red.ts ledger semantics). */
function specFile(specDir: string, name: string): string {
	return join(isAbsolute(specDir) ? specDir : join(process.cwd(), specDir), name);
}

function readJsonFile<T>(path: string, fallback: T): T {
	try {
		if (!existsSync(path)) return fallback;
		return JSON.parse(readFileSync(path, "utf8")) as T;
	} catch {
		return fallback;
	}
}

/** The this-pass window start: THIS runId's `run.started` event time ("" when
 * the bracket is absent — the degraded lifetime fallback). */
export function runPassStartedAt(specDir: string | undefined, runId: string): string {
	if (!specDir) return "";
	try {
		const mine = readRunEvents(specDir).filter((e) => e.type === "run.started" && e.runId === runId);
		return mine.length > 0 ? String(mine[mine.length - 1]!.time ?? "") : "";
	} catch {
		return "";
	}
}

/**
 * Derive the v0.3.85 S3 counters for ONE run pass. Pure read (files + the
 * passed implementation state); never throws; every counter present (absent
 * data = 0, never a missing key).
 */
export function deriveS3Counters(input: { runId: string; specDirectory: string | undefined; implementation: S3ImplementationState }): S3Counters {
	const { runId, specDirectory } = input;
	// ── judge outcomes: the run-events ledger, scoped to THIS runId ──
	let judgeAccepted = 0;
	let judgeDiscarded = 0;
	try {
		for (const e of specDirectory ? readRunEvents(specDirectory) : []) {
			if (e.type !== "judge.called" || e.runId !== runId) continue;
			const status = String((e.data as Record<string, unknown> | undefined)?.status ?? "");
			if (status === "routed") judgeAccepted += 1;
			else if (status === "discarded") judgeDiscarded += 1;
			// "escalate" preserves the diagnosis (F4 doctrine — not a discard);
			// "degraded" is INV-6 infrastructure (neither class).
		}
	} catch { /* best-effort observability (P5) */ }

	// ── phase truth: state.implementation.phaseStatus ──
	const phaseStatus = Array.isArray(input.implementation?.phaseStatus) ? input.implementation!.phaseStatus : [];
	let partialPhases = 0;
	let maxPhaseAttempts = 0;
	for (const p of phaseStatus) {
		if (String(p?.status ?? "") === "partial") partialPhases += 1;
		const att = typeof p?.attempts === "number" && Number.isFinite(p.attempts) ? p.attempts : 0;
		if (att > maxPhaseAttempts) maxPhaseAttempts = att;
	}

	// ── inherited-red: the spec-dir ledgers, windowed to this pass ──
	// The window is this run's run.started time; without the bracket the count
	// degrades to the lifetime tally (documented approximation — rows from
	// prior passes cannot be separated without a timestamped boundary).
	const windowStart = runPassStartedAt(specDirectory, runId);
	let inheritedRedHandoffs = 0;
	let inheritedRedOccurrences = 0;
	if (specDirectory) {
		try {
			const requests = readJsonFile<{ requests?: Array<Record<string, unknown>> }>(specFile(specDirectory, REPLAN_REQUESTS_FILE), { requests: [] });
			inheritedRedHandoffs = (requests.requests ?? []).filter((r) =>
				String(r?.source ?? "") === INHERITED_RED_SOURCE
				&& (windowStart === "" || String(r?.createdAt ?? "") >= windowStart)).length;
		} catch { /* best-effort observability (P5) */ }
		try {
			inheritedRedOccurrences = readInheritedRedEvents(specDirectory).filter((row) =>
				String(row?.event ?? "") === "occurrence"
				&& (windowStart === "" || String(row?.ts ?? "") >= windowStart)).length;
		} catch { /* best-effort observability (P5) */ }
	}

	return { judgeAccepted, judgeDiscarded, partialPhases, inheritedRedHandoffs, inheritedRedOccurrences, maxPhaseAttempts };
}
