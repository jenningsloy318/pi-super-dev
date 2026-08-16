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

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

export const RUN_LOG_VERSION = 1;
export const RUN_LOG_FILENAME = "events.jsonl";

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
 */
export function appendRunEvent(specDir: string | undefined, evt: RunEventInput): number | null {
	if (!specDir) return null;
	try {
		const path = eventsPath(specDir);
		if (!existsSync(path)) {
			mkdirSync(isAbsolute(specDir) ? specDir : ".", { recursive: true });
		}
		const { lastSeq, endsClean } = tailProbe(path);
		const full: RunEvent = {
			seq: lastSeq + 1,
			time: new Date().toISOString(),
			runId: evt.runId,
			...(evt.stage !== undefined ? { stage: evt.stage } : {}),
			...(evt.agent !== undefined ? { agent: evt.agent } : {}),
			type: evt.type,
			data: evt.data ?? {},
		};
		appendFileSync(path, (endsClean ? "" : "\n") + JSON.stringify(full) + "\n");
		return full.seq;
	} catch {
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
