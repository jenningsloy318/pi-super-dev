/**
 * `.user-notes.json` — durable, append-only store for free-text context the
 * user adds MID-RUN (by typing while super_dev executes). Mirrors the
 * `.knowledge.json` pattern (spec-dir file, cleared at pipeline start, injected
 * into agent prompts by the pipeline — the agent never reads the file).
 *
 * Why a file (not in-memory pipeline state):
 * - Survives resume/crash (durable execution replay re-reads it).
 * - Human-inspectable (`cat`/`jq`) alongside the other spec-dir artifacts.
 * - Consistent with `.knowledge.json` / `change-tracker.jsonl`.
 *
 * Delivery is NON-INTERRUPTING: a note typed during agent N is picked up at the
 * next agent boundary (the pipeline reads this file at each spawn), not
 * mid-turn — mirroring pi-subagents' file-backed steer queue.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

interface UserNotesFile {
	notes: Array<{ timestamp: string; text: string }>;
}

const EMPTY: UserNotesFile = { notes: [] };

/** Path to `.user-notes.json` in a spec directory. */
export function userNotesPath(specDir: string): string {
	return join(specDir, ".user-notes.json");
}

/** Clear user notes at pipeline start (fresh run only — NOT on resume). */
export function clearUserNotes(specDir: string): void {
	try {
		writeFileSync(userNotesPath(specDir), JSON.stringify(EMPTY, null, 2) + "\n");
	} catch { /* best-effort */ }
}

/** Append captured user notes (read-modify-write). Never throws — a write
 *  failure must never abort a run. Empty/whitespace-only entries are skipped. */
export function appendUserNotes(specDir: string | undefined, texts: string[]): void {
	const trimmed = texts.map((t) => String(t ?? "").trim()).filter((t) => t.length > 0);
	if (!specDir || trimmed.length === 0) return;
	const path = userNotesPath(specDir);
	let notes: UserNotesFile;
	try {
		notes = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : { notes: [] };
	} catch {
		notes = { notes: [] };
	}
	const ts = new Date().toISOString();
	for (const text of trimmed) notes.notes.push({ timestamp: ts, text });
	try {
		writeFileSync(path, JSON.stringify(notes, null, 2) + "\n");
	} catch { /* best-effort */ }
}

/** Return the accumulated user notes as a numbered prompt-injection string.
 *  Empty string when there are no notes (so the caller prepends nothing —
 *  byte-identical to the no-feature baseline). */
export function userNotesForAgent(specDir: string | undefined): string {
	if (!specDir) return "";
	let notes: UserNotesFile;
	try {
		notes = JSON.parse(readFileSync(userNotesPath(specDir), "utf8"));
	} catch {
		return "";
	}
	const items = (notes.notes ?? []).filter((n) => n && typeof n.text === "string" && n.text.trim());
	if (items.length === 0) return "";
	return items.map((n, i) => `(${i + 1}) ${n.text}`).join("\n");
}
