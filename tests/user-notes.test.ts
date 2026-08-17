/**
 * Unit tests for `src/render/user-notes.ts` — the durable `.user-notes.json`
 * store backing mid-run user context. Covers the file mechanics the workflow
 * test mocks out: append→read round-trip, clear, injection formatting, and the
 * no-throw / empty-input guards.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { userNotesPath, clearUserNotes, appendUserNotes, userNotesForAgent } from "../src/render/user-notes.ts";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "user-notes-"));
});
afterEach(() => {
	try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
});

describe("user-notes store", () => {
	it("clearUserNotes writes an empty {notes:[]} file", () => {
		clearUserNotes(dir);
		expect(existsSync(userNotesPath(dir))).toBe(true);
		expect(JSON.parse(readFileSync(userNotesPath(dir), "utf8"))).toEqual({ notes: [] });
	});

	it("appendUserNotes → userNotesForAgent round-trips the text, enumerated", () => {
		appendUserNotes(dir, ["also handle X"]);
		appendUserNotes(dir, ["and Y", "  "]); // whitespace-only entry is skipped
		const out = userNotesForAgent(dir);
		expect(out).toMatch(/\(1\) \[legacy-.*\] also handle X/);
		expect(out).toMatch(/\(2\) \[legacy-.*\] and Y/);
	});

	it("userNotesForAgent returns '' when there are no notes (no block)", () => {
		expect(userNotesForAgent(dir)).toBe("");
		clearUserNotes(dir);
		expect(userNotesForAgent(dir)).toBe("");
	});

	it("appendUserNotes is a no-op (no file written) when specDir is undefined or texts empty", () => {
		appendUserNotes(undefined, ["x"]);
		appendUserNotes(dir, []);
		appendUserNotes(dir, ["   ", ""]);
		expect(existsSync(userNotesPath(dir))).toBe(false);
		expect(userNotesForAgent(dir)).toBe("");
	});

	it("appendUserNotes never throws on a bad specDir", () => {
		expect(() => appendUserNotes("/no/such/path/abc", ["x"])).not.toThrow();
	});

	it("persists across reads (durable) — a later append is visible to the next read", () => {
		appendUserNotes(dir, ["first"]);
		expect(userNotesForAgent(dir)).toMatch(/\(1\) \[legacy-.*\] first/);
		appendUserNotes(dir, ["second"]);
		const out = userNotesForAgent(dir);
		expect(out).toMatch(/\(1\) \[legacy-.*\] first/);
		expect(out).toMatch(/\(2\) \[legacy-.*\] second/);
	});

	it("reads legacy text-only .user-notes.json without crashing", () => {
		writeFileSync(userNotesPath(dir), JSON.stringify({ notes: [{ timestamp: "2025-01-01T00:00:00.000Z", text: "legacy note" }] }));
		expect(userNotesForAgent(dir)).toContain("legacy note");
	});

	it("persists image attachments and references them in prompt text", () => {
		appendUserNotes(dir, [{
			id: "ui-test",
			createdAt: "2026-01-01T00:00:00.000Z",
			text: "match this screenshot",
			images: [{ mediaType: "image/png", data: Buffer.from("pngdata").toString("base64") }],
		}]);
		const out = userNotesForAgent(dir);
		expect(out).toContain("match this screenshot");
		expect(out).toContain("Attachments:");
		expect(out).toContain("user-input/ui-test-image-1.png");
		expect(existsSync(join(dir, "user-input", "ui-test-image-1.png"))).toBe(true);
	});

	it("copies path-backed attachments into user-input instead of injecting original paths", () => {
		const src = join(dir, "source.png");
		writeFileSync(src, "image-bytes");
		appendUserNotes(dir, [{ id: "path-note", createdAt: "2026-01-01T00:00:00.000Z", text: "see file", images: [{ path: src, mediaType: "image/png" }] }]);
		const out = userNotesForAgent(dir);
		expect(out).toContain("user-input/path-note-image-1.png");
		expect(out).not.toContain(src);
		expect(existsSync(join(dir, "user-input", "path-note-image-1.png"))).toBe(true);
	});

	it("does not silently drop image-only input when attachment persistence fails", () => {
		appendUserNotes(dir, [{ id: "bad-image", createdAt: "2026-01-01T00:00:00.000Z", text: "", images: [{ mediaType: "image/png" }] }]);
		const out = userNotesForAgent(dir);
		expect(out).toContain("could not be persisted");
	});
});

// ─── Phase 6 / T6.6 (AC-33): byte-capped user notes + image containment ─────

import { MAX_USER_NOTE_BYTES, capUserNoteBytes } from "../src/render/user-notes.ts";

describe("AC-33 (SCENARIO-067): an oversized note persists as the capped head+tail form", () => {
	it("MAX_USER_NOTE_BYTES is exported as 16_384", () => {
		expect(MAX_USER_NOTE_BYTES).toBe(16_384);
	});

	it("capUserNoteBytes leaves short text byte-identical and caps long text head+tail", () => {
		const short = "handle X";
		expect(capUserNoteBytes(short)).toBe(short);
		// Exactly at the cap: unchanged.
		const atCap = "x".repeat(16_384);
		expect(capUserNoteBytes(atCap)).toBe(atCap);
		// Over the cap: first 8192 bytes + marker + last 8192 bytes.
		const oneMb = "a".repeat(1_048_576);
		const capped = capUserNoteBytes(oneMb);
		const dropped = 1_048_576 - 8_192 - 8_192;
		expect(capped).toBe(`a`.repeat(8_192) + `\n…[truncated ${dropped} bytes]…\n` + `a`.repeat(8_192));
	});

	it("appendUserNotes persists the CAPPED form and userNotesForAgent injects only that form", () => {
		const oneMb = "b".repeat(1_048_576);
		appendUserNotes(dir, [{ id: "big-note", createdAt: "2026-01-01T00:00:00.000Z", text: oneMb }]);
		const stored = JSON.parse(readFileSync(userNotesPath(dir), "utf8")) as { notes: Array<{ text: string }> };
		const storedText = stored.notes[0]!.text;
		const dropped = 1_048_576 - 8_192 - 8_192;
		expect(storedText.startsWith("b".repeat(8_192))).toBe(true);
		expect(storedText.endsWith("b".repeat(8_192))).toBe(true);
		expect(storedText).toContain(`…[truncated ${dropped} bytes]…`);
		expect(Buffer.byteLength(storedText, "utf8")).toBeLessThanOrEqual(16_384 + 64);
		// The prompt block contains ONLY the capped form — never the full 1 MB.
		const injected = userNotesForAgent(dir);
		expect(injected).toContain(`…[truncated ${dropped} bytes]…`);
		expect(injected.length).toBeLessThan(16_384 + 512);
	});

	it("short notes stay byte-identical through persist + inject", () => {
		const text = "keep me verbatim — éàü 🚀";
		appendUserNotes(dir, [{ id: "small-note", createdAt: "2026-01-01T00:00:00.000Z", text }]);
		const injected = userNotesForAgent(dir);
		expect(injected).toContain(text);
	});
});

describe("AC-33 (+D-4): absolute-path image attachments are contained to the spec dir", () => {
	it("an ABSOLUTE path outside the spec dir is rejected (attachment not persisted)", () => {
		const outside = mkdtempSync(join(tmpdir(), "user-notes-outside-"));
		try {
			const outsidePng = join(outside, "evil.png");
			writeFileSync(outsidePng, "image-bytes");
			appendUserNotes(dir, [{ id: "abs-out", createdAt: "2026-01-01T00:00:00.000Z", text: "see image", images: [{ path: outsidePng, mediaType: "image/png" }] }]);
			const stored = JSON.parse(readFileSync(userNotesPath(dir), "utf8")) as { notes: Array<{ text: string; attachments: unknown[] }> };
			expect(stored.notes[0]!.attachments).toEqual([]);
			expect(stored.notes[0]!.text).toContain("could not be persisted");
			expect(userNotesForAgent(dir)).not.toContain(outsidePng);
		} finally {
			rmSync(outside, { recursive: true, force: true });
		}
	});

	it("an ABSOLUTE path INSIDE the spec dir is still copied into user-input", () => {
		const insidePng = join(dir, "shot.png");
		writeFileSync(insidePng, "image-bytes");
		appendUserNotes(dir, [{ id: "abs-in", createdAt: "2026-01-01T00:00:00.000Z", text: "see image", images: [{ path: insidePng, mediaType: "image/png" }] }]);
		const out = userNotesForAgent(dir);
		expect(out).toContain("user-input/abs-in-image-1.png");
		expect(existsSync(join(dir, "user-input", "abs-in-image-1.png"))).toBe(true);
	});
});
