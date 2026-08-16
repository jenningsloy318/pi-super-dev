/**
 * P3.1 (dsh-09 v3 Phase P): the durable role-to-role message bus.
 *
 * Messages are the WHO-channel between team roles: sender, receiver, subject,
 * optional body, threaded replies (inReplyTo). Persisted append-only to
 * `messages.jsonl` in the spec dir AND double-written to the event ledger
 * (message.sent / message.replied) so folds see the full conversation graph.
 * User instructions drained mid-run are recorded as instruction.received.
 *
 * Wiring (the first real producer/consumer pair): the replan trigger messages
 * every owning stage when its revision requests persist, and the owning
 * convergence node replies when its reviewer verifies the revision — the
 * request/reply lifecycle is exactly the replan-requests lifecycle.
 *
 * Conventions mirror the ledger: single-process appends, best-effort, NEVER
 * throws.
 */

import { appendFileSync, existsSync, readFileSync, mkdirSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { appendRunEvent } from "../runlog.ts";

export const MESSAGES_FILE = "messages.jsonl";

export interface TeamMessage {
	id: string;
	ts: string;
	senderRole: string;
	receiverRole: string;
	subject: string;
	body?: string;
	/** Set on replies: the id of the message this answers. */
	inReplyTo?: string;
}

function messagesPath(specDir: string): string {
	return join(isAbsolute(specDir) ? specDir : join(process.cwd(), specDir), MESSAGES_FILE);
}

function readAll(specDir: string): TeamMessage[] {
	try {
		const raw = readFileSync(messagesPath(specDir), "utf8");
		return raw.split("\n").filter((l) => l.trim()).map((l) => {
			try { return JSON.parse(l) as TeamMessage; } catch { return null; }
		}).filter((m): m is TeamMessage => m !== null && typeof m.id === "string");
	} catch {
		return [];
	}
}

let seqCounter = 0;
function newId(): string {
	seqCounter = (seqCounter + 1) % 1_000_000;
	return `msg-${Date.now().toString(36)}-${seqCounter.toString(36)}`;
}

/** Send a message; persists + ledger-events. Returns the message id (null on a
 *  best-effort failure). NEVER throws. */
export function sendMessage(specDir: string | undefined, msg: { senderRole: string; receiverRole: string; subject: string; body?: string }, runId?: string): string | null {
	if (!specDir) return null;
	try {
		const full: TeamMessage = { id: newId(), ts: new Date().toISOString(), ...msg };
		const dir = isAbsolute(specDir) ? specDir : join(process.cwd(), specDir);
		mkdirSync(dir, { recursive: true });
		appendFileSync(messagesPath(specDir), JSON.stringify(full) + "\n");
		appendRunEvent(specDir, {
			runId: runId ?? "unknown",
			type: "message.sent",
			data: { id: full.id, senderRole: full.senderRole, receiverRole: full.receiverRole, subject: full.subject },
		});
		return full.id;
	} catch {
		return null;
	}
}

/** Reply to a message (threaded). NEVER throws. */
export function replyTo(specDir: string | undefined, messageId: string, reply: { senderRole: string; subject: string; body?: string }, runId?: string): string | null {
	if (!specDir) return null;
	try {
		const original = readAll(specDir).find((m) => m.id === messageId);
		const full: TeamMessage = { id: newId(), ts: new Date().toISOString(), inReplyTo: messageId, receiverRole: original?.senderRole ?? "verify", ...reply };
		const dir = isAbsolute(specDir) ? specDir : join(process.cwd(), specDir);
		mkdirSync(dir, { recursive: true });
		appendFileSync(messagesPath(specDir), JSON.stringify(full) + "\n");
		appendRunEvent(specDir, {
			runId: runId ?? "unknown",
			type: "message.replied",
			data: { id: full.id, inReplyTo: messageId, senderRole: full.senderRole },
		});
		return full.id;
	} catch {
		return null;
	}
}

/** The inbox for a role: messages addressed to it that have no reply yet. */
export function pendingMessagesFor(specDir: string | undefined, receiverRole: string): TeamMessage[] {
	if (!specDir) return [];
	const all = readAll(specDir);
	const replied = new Set(all.filter((m) => m.inReplyTo).map((m) => m.inReplyTo));
	return all.filter((m) => m.receiverRole === receiverRole && !replied.has(m.id));
}

/** Record a drained user instruction into the ledger (best-effort). */
export function recordInstruction(specDir: string | undefined, text: string, runId?: string): void {
	if (!specDir) return;
	try {
		appendRunEvent(specDir, { runId: runId ?? "unknown", type: "instruction.received", data: { text: text.slice(0, 500), source: "user-mid-run" } });
	} catch { /* best-effort */ }
}
