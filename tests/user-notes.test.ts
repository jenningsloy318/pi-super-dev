/**
 * Unit tests for `src/render/user-notes.ts` — the durable `.user-notes.json`
 * store backing mid-run user context. Covers the file mechanics the workflow
 * test mocks out: append→read round-trip, clear, injection formatting, and the
 * no-throw / empty-input guards.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
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
		expect(out).toBe("(1) also handle X\n(2) and Y");
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
		expect(userNotesForAgent(dir)).toBe("(1) first");
		appendUserNotes(dir, ["second"]);
		expect(userNotesForAgent(dir)).toBe("(1) first\n(2) second");
	});
});
