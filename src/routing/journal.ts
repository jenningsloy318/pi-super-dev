/**
 * M2 of the routing-architecture migration: the routing-journal IO layer.
 *
 * MP1 (sync-before-re-entry): a jump record is appended SYNCHRONOUSLY before
 * the sub-walk starts — a crash mid-re-entry must leave the journal already
 * recording the jump, so a resume cannot silently re-arm the budget (the
 * LangGraph "nodes re-execute on resume" durability lesson; a journal that
 * lags the control flow is worse than none).
 *
 * MP2 (persisted authority): budgets are read from THIS journal via
 * budgetFromJournal — never from process-local counters (the exactly-once-send
 * lesson; the pre-sd26 guidance grant failed exactly this way).
 *
 * MP4 (semantics-aware journaling): ONLY jumps are journaled. Fast-forwards,
 * green-skips, and ordinary convergence rounds never touch this file —
 * 75 %+ of turns carry no recovery-relevant state, and a journal that stays
 * small stays auditable by eye.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
	type RouteStageId,
	type RoutingJournal,
	type RoutingJournalEntry,
	type RoutableOwnerStage,
	budgetFromJournal,
	edgeKey,
} from "./router.ts";

export const ROUTING_JOURNAL_FILE = "routing-journal.jsonl";

/** M2 pilot flag — default OFF. When off, the walker re-throws every
 *  RouteBackSignal unchanged and byte-identical emulation holds (G8). */
export function inlineRouteBackEnabled(): boolean {
	return process.env.SUPER_DEV_INLINE_ROUTEBACK === "1";
}

/** Total inline-jump bound per run (defense-in-depth above the per-edge
 *  budget; a runaway route-back↔re-block cycle stops here). */
export function maxInlineJumps(): number {
	const raw = Number(process.env.SUPER_DEV_MAX_INLINE_JUMPS);
	return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : 4;
}

function journalPath(specDir: string): string {
	return join(specDir, ROUTING_JOURNAL_FILE);
}

/** Read the journal (tolerant: unparseable/torn lines are skipped, never
 *  fatal — a torn last line from a crash mid-append must not brick reads). */
export function readRoutingJournal(specDir: string): RoutingJournal {
	const entries: RoutingJournalEntry[] = [];
	try {
		const path = journalPath(specDir);
		if (!existsSync(path)) return { entries };
		for (const line of readFileSync(path, "utf8").split("\n")) {
			if (!line.trim()) continue;
			try {
				const e = JSON.parse(line) as RoutingJournalEntry;
				if (e && e.kind === "route-back" && typeof e.seq === "number") entries.push(e);
			} catch { /* torn line — skip */ }
		}
	} catch {
		return { entries };
	}
	entries.sort((a, b) => a.seq - b.seq);
	return { entries };
}

export interface ChargeRoutingJumpInput {
	from: RouteStageId;
	to: RoutableOwnerStage;
	reason: string;
	findingIds: string[];
	resumeFromIndex: number;
	invalidated: RouteStageId[];
	/** Caller-supplied timestamp (MP3: the IO layer may mint it — the ROUTER
	 *  never does; this is the journal side of that contract). */
	at: string;
	/** MP1 post-jump offsets: what the jump did to persisted state. */
	cacheDropped: number;
	/** Owner revision counter AFTER the bump (artifact-revisions.json). */
	revisionAfter: number;
}

/** Append one jump record SYNCHRONOUSLY and return the persisted entry (with
 *  its journal-assigned seq + computed budget window). Returns null when the
 *  spec dir is unwritable — callers must treat a failed journal write as a
 *  failed jump (never re-enter on an unrecorded edge; MP1 fail-closed). */
export function chargeRoutingJump(specDir: string, input: ChargeRoutingJumpInput): RoutingJournalEntry | null {
	try {
		const before = readRoutingJournal(specDir);
		// Review round-1 F-2/adv-F-3: per-edge budget is PER RUN. Entries carry
		// `at`; the budget view counts only entries at/after the current run's
		// epoch (set by the walker at run() start). A prior run's exhausted edge
		// must not starve this run (and vice versa).
		const epoch = currentRunEpoch();
		const budgetBefore = before.entries.filter(
			(e) => edgeKey(e.from, e.to) === edgeKey(input.from, input.to) && withinEpoch(e, epoch),
		).length;
		// seq from MAX (torn trailing lines are skipped by the reader, so
		// entries.length can undercount — seq must stay strictly monotonic).
		const maxSeq = before.entries.reduce((m, e) => Math.max(m, e.seq), 0);
		const entry: RoutingJournalEntry = {
			seq: maxSeq + 1,
			kind: "route-back",
			from: input.from,
			to: input.to,
			reason: input.reason,
			findingIds: input.findingIds,
			resumeFromIndex: input.resumeFromIndex,
			invalidated: input.invalidated,
			budgetBefore: budgetBefore,
			budgetAfter: budgetBefore + 1,
			at: input.at,
			cacheDropped: input.cacheDropped,
			revisionAfter: input.revisionAfter,
		};
		const path = journalPath(specDir);
		mkdirSync(specDir, { recursive: true });
		// R2-5 (torn-boundary healing, mirrors runlog's fileEndsClean): if a
		// crash left a partial line without its trailing newline, a naive append
		// would glue onto it and make BOTH entries unparseable (budget undercount).
		let prefix = "";
		try {
			const existing = readFileSync(path, "utf8");
			if (existing.length > 0 && !existing.endsWith("\n")) prefix = "\n";
		} catch { /* absent file — nothing to heal */ }
		appendFileSync(path, prefix + JSON.stringify(entry) + "\n");
		return entry;
	} catch {
		return null;
	}
}

// ─── Run epoch (per-RUN budget window — review round-1 F-2/adv-F-3) ────────

/** Process-local start-of-run timestamp (ISO). The walker sets it at run()
 *  start so both the throw-site planner and the walker's re-check count only
 *  THIS run's journal entries — the plan's "budget: 2 per (from,to) per run".
 *  A fresh runWorkflow invocation resets it; "" = no epoch (count all —
 *  used by unit tests that seed journals directly). */
let runEpochIso = "";

export function startRunEpoch(): string {
	runEpochIso = new Date().toISOString(); // journal IO may mint time (MP3)
	return runEpochIso;
}

export function currentRunEpoch(): string {
	return runEpochIso;
}

/** Test/isolation hook: clear the epoch (subsequent budget reads count all
 *  entries until the next walker run() starts a fresh epoch). */
export function resetRunEpoch(): void {
	runEpochIso = "";
}

function withinEpoch(e: { at: string }, epoch: string): boolean {
	return epoch === "" || String(e.at) >= epoch;
}

/** Persisted budget view (MP2): the ONLY source throw sites consult. Filtered
 *  to the current run's epoch when one is active (per-run budget semantics). */
export function persistedBudget(specDir: string) {
	const epoch = currentRunEpoch();
	if (epoch === "") return budgetFromJournal(readRoutingJournal(specDir));
	const j = readRoutingJournal(specDir);
	return budgetFromJournal({ entries: j.entries.filter((e) => withinEpoch(e, epoch)) });
}
