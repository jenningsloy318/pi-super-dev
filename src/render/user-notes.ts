/**
 * `.user-notes.json` — durable, append-only store for freeform context the
 * user adds MID-RUN (by typing/pasting/attaching images while super_dev runs).
 * Mirrors `.knowledge.json`: spec-dir file, cleared at pipeline start, injected
 * into agent prompts by the pipeline. Agents do not need to know about the
 * in-memory parent TUI; they receive ordinary text + file paths.
 *
 * Delivery is checkpoint-based and guaranteed: input typed during agent N is
 * picked up at the next agent/checkpoint boundary. Image data is persisted as
 * files under `user-input/` and referenced by path in later prompts, so it also
 * survives resume/crash and works for both session and subprocess backends.
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { extname, isAbsolute, join, resolve, sep } from "node:path";
import type { RuntimeInstruction, RuntimeInstructionImage } from "../types.ts";

interface StoredRuntimeInstruction {
	id: string;
	timestamp: string;
	text: string;
	source?: string;
	streamingBehavior?: "steer" | "followUp";
	attachments: Array<{ path: string; mediaType?: string; label?: string }>;
}

interface UserNotesFile {
	notes: StoredRuntimeInstruction[];
}

const EMPTY: UserNotesFile = { notes: [] };

/** AC-33 (SCENARIO-067): the persisted size of ONE user note — 16 KiB. Exported
 *  so the cap is pinnable in tests. */
export const MAX_USER_NOTE_BYTES = 16_384;
const USER_NOTE_HEAD_BYTES = 8_192;
const USER_NOTE_TAIL_BYTES = 8_192;

/** M21: head+tail cap applied at persist/drain time so userNotesForAgent can
 *  never inject more than the capped form. Byte-exact: first 8192 bytes +
 *  marker (N = dropped byte count) + last 8192 bytes. Text at or under the
 *  cap is returned byte-identical. */
export function capUserNoteBytes(text: string): string {
	const buf = Buffer.from(text, "utf8");
	if (buf.length <= MAX_USER_NOTE_BYTES) return text;
	const head = buf.subarray(0, USER_NOTE_HEAD_BYTES).toString("utf8");
	const tail = buf.subarray(buf.length - USER_NOTE_TAIL_BYTES).toString("utf8");
	const dropped = buf.length - USER_NOTE_HEAD_BYTES - USER_NOTE_TAIL_BYTES;
	return `${head}\n…[truncated ${dropped} bytes]…\n${tail}`;
}

/** Path to `.user-notes.json` in a spec directory. */
export function userNotesPath(specDir: string): string {
	return join(specDir, ".user-notes.json");
}

export function userInputDir(specDir: string): string {
	return join(specDir, "user-input");
}

/** Clear user notes at pipeline start (fresh run only — NOT on resume). */
export function clearUserNotes(specDir: string): void {
	try {
		writeFileSync(userNotesPath(specDir), JSON.stringify(EMPTY, null, 2) + "\n");
	} catch { /* best-effort */ }
}

function safeId(id: string): string {
	return String(id || "note").replace(/[^A-Za-z0-9_.-]+/g, "-").slice(0, 80) || "note";
}

function extForMedia(mediaType?: string): string {
	const mt = String(mediaType ?? "").toLowerCase();
	if (mt.includes("png")) return ".png";
	if (mt.includes("jpeg") || mt.includes("jpg")) return ".jpg";
	if (mt.includes("gif")) return ".gif";
	if (mt.includes("webp")) return ".webp";
	if (mt.includes("bmp")) return ".bmp";
	return ".bin";
}

function extractBase64(image: RuntimeInstructionImage): { data?: string; mediaType?: string } {
	const raw = image as RuntimeInstructionImage & { source?: { type?: string; data?: string; mediaType?: string }; mimeType?: string };
	if (typeof raw.data === "string") return { data: raw.data, mediaType: raw.mediaType ?? raw.mimeType };
	if (raw.source?.type === "base64" && typeof raw.source.data === "string") return { data: raw.source.data, mediaType: raw.source.mediaType };
	return { mediaType: raw.mediaType ?? raw.mimeType };
}

function outputImagePath(specDir: string, noteId: string, index: number, ext: string): { rel: string; abs: string } {
	const rel = join("user-input", `${safeId(noteId)}-image-${index + 1}${ext || ".bin"}`);
	return { rel, abs: join(specDir, rel) };
}

function persistImage(specDir: string, noteId: string, image: RuntimeInstructionImage, index: number): { path: string; mediaType?: string; label?: string } | null {
	try {
		mkdirSync(userInputDir(specDir), { recursive: true });
		if (image.path) {
			// Always COPY path-backed attachments into the spec dir so prompts never
			// contain absolute/temp/traversal paths and resume stays durable.
			// D-4: spec-root containment applies to ABSOLUTE paths too — only files
			// already inside the spec dir may be copied in; anything outside (an
			// arbitrary host path, a /etc/… target, a symlink-adjacent traversal) is
			// rejected with the existing could-not-persist notice.
			const src = isAbsolute(image.path) ? resolve(image.path) : resolve(specDir, image.path);
			const specRoot = resolve(specDir);
			if (src !== specRoot && !src.startsWith(specRoot + sep)) return null;
			if (!existsSync(src)) return null;
			const { rel, abs } = outputImagePath(specDir, noteId, index, extname(src) || extForMedia(image.mediaType));
			copyFileSync(src, abs);
			return { path: rel, mediaType: image.mediaType, label: image.label };
		}
		const { data, mediaType } = extractBase64(image);
		if (!data) return null;
		const { rel, abs } = outputImagePath(specDir, noteId, index, extForMedia(mediaType));
		writeFileSync(abs, Buffer.from(data, "base64"));
		return { path: rel, mediaType, label: image.label };
	} catch {
		return null;
	}
}

function normalizeStoredNotes(value: unknown): UserNotesFile {
	const raw = value as { notes?: unknown[] } | null | undefined;
	const notes = Array.isArray(raw?.notes) ? raw.notes : [];
	return {
		notes: notes.map((entry, index) => {
			const e = entry as Partial<StoredRuntimeInstruction> | undefined;
			return {
				id: typeof e?.id === "string" && e.id ? e.id : `legacy-${index + 1}`,
				timestamp: typeof e?.timestamp === "string" ? e.timestamp : new Date(0).toISOString(),
				text: typeof e?.text === "string" ? e.text : "",
				source: e?.source,
				streamingBehavior: e?.streamingBehavior,
				attachments: Array.isArray(e?.attachments) ? e.attachments.filter((a): a is { path: string; mediaType?: string; label?: string } => !!a && typeof a.path === "string") : [],
			};
		}),
	};
}

function readNotes(path: string): UserNotesFile {
	try {
		return existsSync(path) ? normalizeStoredNotes(JSON.parse(readFileSync(path, "utf8"))) : { notes: [] };
	} catch {
		return { notes: [] };
	}
}

/** Append captured runtime instructions. Never throws — a write failure must
 * never abort a run. Empty text is allowed when images are present. */
export function appendUserNotes(specDir: string | undefined, instructions: Array<RuntimeInstruction | string>): void {
	if (!specDir || instructions.length === 0) return;
	const path = userNotesPath(specDir);
	const notes = readNotes(path);
	let added = 0;
	for (const item of instructions) {
		const instruction: RuntimeInstruction = typeof item === "string"
			? { id: `legacy-${Date.now().toString(36)}-${notes.notes.length + 1}`, createdAt: new Date().toISOString(), text: item }
			: item;
		// AC-33 (SCENARIO-067): the note text is finalized here — apply the
		// head+tail byte cap at PERSIST time so every later consumer (agent prompt
		// injection, resume) can only ever see the bounded form.
		const text = capUserNoteBytes(String(instruction.text ?? "").trim());
		const images = instruction.images ?? [];
		if (!text && images.length === 0) continue;
		const persisted = images.map((image, index) => persistImage(specDir, instruction.id, image, index));
		const attachments = persisted.filter((x): x is { path: string; mediaType?: string; label?: string } => x !== null);
		const failedImages = images.length - attachments.length;
		const finalText = failedImages > 0
			? [text, `(${failedImages} image/content attachment(s) could not be persisted; ask the user to resend if needed.)`].filter(Boolean).join("\n")
			: text;
		notes.notes.push({
			id: instruction.id,
			timestamp: instruction.createdAt || new Date().toISOString(),
			text: finalText,
			source: instruction.source,
			streamingBehavior: instruction.streamingBehavior,
			attachments,
		});
		added++;
	}
	if (added === 0) return;
	try {
		// Sweep-3 G31: atomic (tmp+rename) — a torn write lost the user's mid-run input.
		const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
		writeFileSync(tmp, JSON.stringify(notes, null, 2) + "\n");
		renameSync(tmp, path);
	} catch { /* best-effort */ }
}

/** Return accumulated runtime instructions as a prompt-injection string. Empty
 * string when there are no notes. Attachment paths are relative to the spec dir
 * and should be read by downstream specialists when relevant. */
export function userNotesForAgent(specDir: string | undefined): string {
	if (!specDir) return "";
	const notes = readNotes(userNotesPath(specDir));
	const items = (notes.notes ?? []).filter((n) => n && (n.text.trim() || n.attachments.length > 0));
	if (items.length === 0) return "";
	return items.map((n, i) => {
		const lines = [`(${i + 1}) [${n.id} @ ${n.timestamp}] ${n.text || "(image/content attachment)"}`];
		if (n.attachments.length) {
			lines.push("    Attachments:");
			for (const a of n.attachments) lines.push(`    - ${a.path}${a.mediaType ? ` (${a.mediaType})` : ""}`);
		}
		return lines.join("\n");
	}).join("\n");
}
