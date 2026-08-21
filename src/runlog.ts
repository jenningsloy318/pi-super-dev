/**
 * P1.1 (dsh-09 v3 Phase P): the durable run-event ledger — ONE append-only
 * `events.jsonl` per spec directory. dsh-03's SessionEvent-log line, sized for
 * this pipeline: consumers are FOLDS (postmortems become `jq` queries, the
 * replay proof asserts fold(events) ≡ ctx.results), never second writers.
 *
 * Conventions (mirroring auditAppend — the established best-effort ledger
 * pattern): single-process appends, joins serialize, mkdir best-effort, NEVER
 * throws. A torn last line (process killed mid-append) is tolerated on read.
 *
 * Naming is deliberately simple and stable; a future OTel GenAI bridge maps
 * agent.called → invoke_agent, stage.* → workflow spans mechanically
 * (gen_ai.operation.name / gen_ai.agent.name).
 */

import { appendFileSync, closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync } from "node:fs";
import { isAbsolute, join } from "node:path";

export const RUN_LOG_VERSION = 1;
export const RUN_LOG_FILENAME = "events.jsonl";

/** D-5 (NFR-6): uniform payload bound — the serialized event may never exceed
 *  this many bytes. The bound lives at the single append choke point, so it
 *  covers EVERY RunEventInput emitter by construction (gate.checked's own
 *  tighter bounds stay as-is; only unbounded shapes ever hit this). */
export const MAX_RUN_EVENT_BYTES = 64 * 1024;

// ─── Event type registry ────────────────────────────────────────────────────

export type RunEventType =
	| "run.started"
	| "run.completed"
	| "stage.started"
	| "stage.completed"
	| "stage.failed"
	| "stage.skipped"
	| "stage.cancelled"
	| "agent.called"
	| "gate.checked"
	| "judge.called"
	| "escalation.raised"
	| "escalation.resolved"
	| "message.sent"
	| "message.replied"
	| "instruction.received"
	| "topic.snapshot"
	| "team.configured"
	// R3 replan circuit (dsh-09 v3 Phase R):
	| "replan.requested"
	| "replan.routed"
	| "replan.resumed"
	// R4 revision counters:
	| "artifact.revised";

/** What each event's `data` carries (documentation contract; runtime objects
 *  are plain records — the ledger never schema-validates its own writes, it
 *  must never be the component that drops an event). */
export interface RunEventDataHints {
	"run.started": { task: string; version: string };
	"run.completed": { status: string; reason?: string };
	"stage.started": Record<string, never>;
	"stage.completed": { durationMs?: number; partial?: boolean; kind?: string };
	"stage.failed": { durationMs?: number; error?: string; kind?: string };
	"stage.skipped": { reason?: string; kind?: string };
	"stage.cancelled": { kind?: string };
	"agent.called": { agent: string; model?: string; backend?: string; durationMs?: number; control?: unknown; error?: string };
	"gate.checked": { gate: string; pass: boolean; ran: string[]; errors?: string };
	"judge.called": { scope: string; route?: string; status: string };
	"escalation.raised": { stage?: string; kind: string; message?: string };
	"escalation.resolved": { stage?: string; kind: string; choice?: string };
	"message.sent": { id: string; senderRole?: string; receiverRole?: string; subject?: string };
	"message.replied": { id: string; inReplyTo?: string };
	"instruction.received": { text: string; source?: string };
	"topic.snapshot": Record<string, unknown>;
	"team.configured": { owners: string[] };
	"replan.requested": { findings: number; originatedRunId?: string };
	"replan.routed": { findings: Array<{ id?: string; owner: string; routable: boolean; source: string; reason: string }>; invalidationSet: string[] };
	"replan.resumed": { runId: string; requests: number };
	"artifact.revised": { artifact: string; revision: number };
	"route.taken": { from: string; to: string; seq: number; budgetBefore: number; budgetAfter: number; resumeFromIndex: number };
	"route.declined": { from: string; to: string; reason: string };
}

export interface RunEvent<K extends keyof RunEventDataHints = keyof RunEventDataHints> {
	seq: number;
	time: string;
	runId: string;
	stage?: string;
	agent?: string;
	type: K | (string & {});
	data: RunEventDataHints[K] & Record<string, unknown>;
}

/** The partial callers provide; seq/time are filled by appendRunEvent. */
export type RunEventInput = Omit<RunEvent, "seq" | "time"> & { seq?: never; time?: never };

// ─── Append ─────────────────────────────────────────────────────────────────

function eventsPath(specDir: string): string {
	return isAbsolute(specDir) ? join(specDir, RUN_LOG_FILENAME) : specDir.endsWith("/") ? `${specDir}${RUN_LOG_FILENAME}` : `${specDir}/${RUN_LOG_FILENAME}`;
}

/** The first event of a run carries the ledger version (schema-evolution tripwire). */
export function runStartedEvent(runId: string, task: string, version: string): RunEventInput {
	return { runId, type: "run.started", data: { task: task.slice(0, 2000), version, ledgerVersion: RUN_LOG_VERSION } };
}

/** The tail probe: last parseable seq + whether the file ends with a clean
 *  newline (a torn last write has no \n — the next append must heal the
 *  boundary or it glues onto the fragment and both lines are lost). */
function tailProbe(path: string): { lastSeq: number; endsClean: boolean } {
	try {
		if (!existsSync(path)) return { lastSeq: 0, endsClean: true };
		const buf = readFileSync(path);
		if (buf.length === 0) return { lastSeq: 0, endsClean: true };
		const endsClean = buf[buf.length - 1] === 0x0a;
		const text = buf.toString("utf8").trimEnd();
		if (!text) return { lastSeq: 0, endsClean: true };
		const lines = text.split("\n");
		for (let i = lines.length - 1; i >= 0; i--) {
			try {
				const parsed = JSON.parse(lines[i]) as { seq?: unknown };
				if (typeof parsed.seq === "number") return { lastSeq: parsed.seq, endsClean };
			} catch { /* skip torn/blank lines */ }
		}
		return { lastSeq: 0, endsClean };
	} catch {
		return { lastSeq: 0, endsClean: true };
	}
}

/**
 * Append one event. Seq is last-line seq + 1 (single-process appends; joins
 * serialize — no concurrent writers by construction). A torn last line (no
 * trailing newline, e.g. a killed process) is healed by prepending the newline
 * this time — without it the fresh event would glue onto the fragment and
 * BOTH would be lost. NEVER throws; a failed append (unwritable dir) is a
 * silent no-op exactly like auditAppend: the ledger must never kill the run
 * it is observing.
 *
 * D-5 (NFR-6): lastSeq is cached in memory PER SPEC DIR — the O(file) tail
 * probe runs only on the FIRST append after process start; every subsequent
 * append resolves seq from memory (an O(n²) re-read per event was quadratic
 * over retry-heavy runs). Cleanliness of the file's last byte is still checked
 * in O(1) on every append so a torn line written by a killed PRIOR append is
 * healed exactly as before.
 */
const seqCache = new Map<string, number>();

/** O(1) cleanliness check: does the file's last byte end a line? (A killed
 *  append leaves no trailing \n — the next append must heal the boundary.) */
function fileEndsClean(path: string): boolean {
	let fd: number | undefined;
	try {
		fd = openSync(path, "r");
		const len = fstatSync(fd).size;
		if (len === 0) return true;
		const buf = Buffer.alloc(1);
		readSync(fd, buf, 0, 1, len - 1);
		return buf[0] === 0x0a;
	} catch {
		return true;
	} finally {
		if (fd !== undefined) { try { closeSync(fd); } catch { /* best-effort */ } }
	}
}

export function appendRunEvent(specDir: string | undefined, evt: RunEventInput): number | null {
	if (!specDir) return null;
	try {
		const path = eventsPath(specDir);
		if (!existsSync(path)) {
			mkdirSync(isAbsolute(specDir) ? specDir : ".", { recursive: true });
		}
		const cachedSeq = seqCache.get(path);
		const { lastSeq, endsClean } = cachedSeq !== undefined
			? { lastSeq: cachedSeq, endsClean: fileEndsClean(path) }
			: tailProbe(path);
		const full: RunEvent = {
			seq: lastSeq + 1,
			time: new Date().toISOString(),
			runId: evt.runId,
			...(evt.stage !== undefined ? { stage: evt.stage } : {}),
			...(evt.agent !== undefined ? { agent: evt.agent } : {}),
			type: evt.type,
			data: evt.data ?? {},
		};
		let line = JSON.stringify(full);
		if (line.length > MAX_RUN_EVENT_BYTES) {
			// D-5 (NFR-6): uniform payload bound — keep the fold-critical envelope
			// (seq/time/runId/stage/agent/type) and swap the oversized data for a
			// bounded marker so the line stays valid, parseable JSON.
			line = JSON.stringify({ ...full, data: { dataTruncated: true, originalBytes: line.length } });
			if (line.length > MAX_RUN_EVENT_BYTES) line = line.slice(0, MAX_RUN_EVENT_BYTES); // pathological envelope — never write an unbounded line
		}
		appendFileSync(path, (endsClean ? "" : "\n") + line + "\n");
		seqCache.set(path, full.seq);
		return full.seq;
	} catch {
		// A failed append may have torn the file — drop the cached seq so the
		// NEXT append re-probes from disk instead of trusting stale memory.
		try { if (specDir) seqCache.delete(eventsPath(specDir)); } catch { /* never throws */ }
		return null;
	}
}

// ─── Typed emitters for wiring points (P1.4+) ───────────────────────────────

/** P1.4: gate.checked — a deterministic build/test gate outcome. Bounded
 *  payload (ran commands capped at 12, errors at 8 × 200 chars) so a broken
 *  toolchain's wall of text never bloats the ledger. NEVER throws. */
export function appendGateChecked(
	state: { setup?: { specDirectory?: string } } & Record<string, unknown>,
	gate: string,
	r: { pass: boolean; ran?: string[]; errors?: string[]; inScopePass?: boolean },
	stage?: string,
): void {
	appendRunEvent(state.setup?.specDirectory, {
		runId: String(state.__runId ?? "unknown"),
		...(stage ? { stage } : {}),
		type: "gate.checked",
		data: {
			gate,
			pass: r.pass,
			...(typeof r.inScopePass === "boolean" ? { inScopePass: r.inScopePass } : {}),
			ran: (r.ran ?? []).slice(0, 12),
			errors: (r.errors ?? []).slice(0, 8).map((e) => String(e).slice(0, 200)),
		},
	});
}

// ─── Read / fold ────────────────────────────────────────────────────────────

/** Read all events; a torn LAST line is skipped (partial write from a killed
 *  process). NEVER throws. */
export function readRunEvents(specDir: string | undefined): RunEvent[] {
	if (!specDir) return [];
	try {
		const path = eventsPath(specDir);
		if (!existsSync(path)) return [];
		const lines = readFileSync(path, "utf8").split("\n");
		const out: RunEvent[] = [];
		for (const line of lines) {
			const trimmed = line.trim();
			if (!trimmed) continue;
			try {
				const parsed = JSON.parse(trimmed) as RunEvent;
				if (parsed && typeof parsed.seq === "number" && typeof parsed.type === "string") out.push(parsed);
			} catch { /* torn or non-JSON line — skip */ }
		}
		return out;
	} catch {
		return [];
	}
}

/**
 * Deterministic fold over the event stream (dsh-03: consumers are folds).
 * Pure: same events in, same state out — the replay-proof invariant.
 */
export function foldEvents<T>(events: RunEvent[], init: T, step: (acc: T, evt: RunEvent) => T): T {
	return events.reduce((acc, evt) => {
		try {
			return step(acc, evt);
		} catch {
			return acc; // a malformed event never breaks the fold
		}
	}, init);
}

// ─── Reference fold consumer (P1.6: the replay proof) ───────────────────────

export interface StageOutcome {
	stage: string;
	status: "completed" | "failed" | "skipped" | "cancelled";
	error?: string;
	partial?: boolean;
}

/**
 * Reconstruct the terminal outcome of every stage from the event stream —
 * the canonical demonstration that the ledger is a complete decision log:
 * fold(events) reproduces the stage results without any other source
 * (last-terminal-wins per stage id; sub-step ids are stages too). This is the
 * reference consumer postmortems and the R6 acceptance check fold with.
 */
export function reconstructStageOutcomes(events: RunEvent[]): StageOutcome[] {
	const out = new Map<string, StageOutcome>();
	for (const e of events) {
		if (!e.stage) continue;
		if (e.type === "stage.completed") out.set(e.stage, { stage: e.stage, status: "completed", ...(e.data.partial === true ? { partial: true } : {}) });
		else if (e.type === "stage.failed") out.set(e.stage, { stage: e.stage, status: "failed", ...(typeof e.data.error === "string" ? { error: e.data.error } : {}) });
		else if (e.type === "stage.skipped") out.set(e.stage, { stage: e.stage, status: "skipped" });
		else if (e.type === "stage.cancelled") out.set(e.stage, { stage: e.stage, status: "cancelled" });
	}
	return [...out.values()];
}

// ─── Event-consumer invariants registry (P1.7) ──────────────────────────────
//
// The contract every emitter (task wrapper, realAgent, gates, judge, replan)
// must preserve — the assumptions fold consumers are entitled to rely on.
// CI enforces these against real runWorkflow streams; the checker is exported
// so postmortems (and the R6 acceptance check) can validate any production
// events.jsonl:
//
//   INV-L1 seq is strictly increasing and contiguous from 1 (no gaps/dupes —
//          a lost event would silently corrupt every downstream fold).
//   INV-L2 time is non-decreasing (folds may bucket by time safely).
//   INV-L3 every event carries seq, time, runId, and type.
//   INV-L4 each runId's events form ONE contiguous block (runs are sequential;
//          replan restarts append after the previous run.completed — never
//          interleave).
//   INV-L5 run.started is the first event of its runId; run.completed is the
//          last (bracket integrity).
//   INV-L6 every stage.started for stage X is followed by exactly one terminal
//          event for X (completed/failed/skipped/cancelled) before any other
//          lifecycle event for X (no zombie stages, no double terminals).

export function checkRunLogInvariants(events: RunEvent[]): string[] {
	const violations: string[] = [];
	// INV-L1 / INV-L2 / INV-L3
	for (let i = 0; i < events.length; i++) {
		const e = events[i];
		if (typeof e.seq !== "number" || typeof e.type !== "string" || !e.runId || !e.time) {
			violations.push(`seq ${i + 1}: event missing seq/time/runId/type (INV-L3)`);
			continue;
		}
		if (e.seq !== i + 1) violations.push(`position ${i + 1}: seq is ${e.seq}, expected ${i + 1} (INV-L1)`);
		if (i > 0) {
			const prev = events[i - 1];
			if (prev.time && e.time < prev.time) violations.push(`seq ${e.seq}: time ${e.time} precedes ${prev.time} (INV-L2)`);
		}
	}
	// INV-L4 / INV-L5
	const blocks = new Map<string, { first: number; last: number }>();
	for (let i = 0; i < events.length; i++) {
		const b = blocks.get(events[i].runId) ?? { first: i, last: i };
		if (i - b.last > 1) violations.push(`seq ${events[i].seq}: runId ${events[i].runId} resumed after a gap (interleaved runs, INV-L4)`);
		b.last = i;
		blocks.set(events[i].runId, b);
	}
	const lastBlockLast = Math.max(...[...blocks.values()].map((b) => b.last));
	for (const [runId, b] of blocks) {
		if (events[b.first].type !== "run.started") violations.push(`runId ${runId}: first event is ${events[b.first].type}, not run.started (INV-L5)`);
		// A run missing its run.completed is a violation ONLY when another run
		// follows it in the file (the run provably ended — the process survived
		// to start the next run). The file's TRAILING block may be an interrupted
		// run: a fact about the run, not a ledger defect.
		if (b.last !== lastBlockLast && events[b.last].type !== "run.completed") {
			violations.push(`runId ${runId}: last event is ${events[b.last].type}, not run.completed (INV-L5)`);
		}
	}
	// INV-L6
	const openStages = new Map<string, string>(); // stage -> opened at seq
	for (const e of events) {
		if (!e.stage) continue;
		if (e.type === "stage.started") {
			if (openStages.has(e.stage)) violations.push(`seq ${e.seq}: stage ${e.stage} started while already open (INV-L6)`);
			openStages.set(e.stage, e.seq as unknown as string);
		} else if (e.type === "stage.completed" || e.type === "stage.failed" || e.type === "stage.skipped" || e.type === "stage.cancelled") {
			if (!openStages.has(e.stage)) violations.push(`seq ${e.seq}: terminal ${e.type} for ${e.stage} without stage.started (INV-L6)`);
			openStages.delete(e.stage);
		}
	}
	// An interrupted run (process killed) leaves stages open — that is a fact
	// about the run, not a ledger violation; only report when run.completed
	// exists (the run ended cleanly) yet a stage is still open.
	const lastRun = events[events.length - 1];
	if (lastRun?.type === "run.completed") { // clean end — no stage may remain open
		for (const [stage, at] of openStages) violations.push(`stage ${stage} (opened seq ${at}) never reached a terminal event before run.completed (INV-L6)`);
	}
	return violations;
}
