/**
 * Phase 2 (RED) tests — the `userInput(text)` live-stream sink (AC-07).
 *
 * Scope (from the spec):
 *   - Add a `userInput(text)` sink to src/render/live-stream.ts that pushes
 *     `{ kind: "user-input", text: "📥 " + text }` into the transcript, reusing
 *     the tagged-kind path already used for phase/thinking/trim so it flows
 *     through `transcriptTail()` → `buildResultComponent` → `renderResult`
 *     unchanged (SCENARIO-009).
 *
 * These tests reference behavior that DOES NOT EXIST YET:
 *   - `createLiveStream({}).sink.userInput` is currently `undefined`, so calling
 *     it throws "userInput is not a function" (clean RED).
 *
 * Coverage:
 *   AC-07 → SCENARIO-009 (transcript line carries {kind:"user-input",
 *            text:"📥 "+text}); also guards that it reaches transcriptTail /
 *            getTranscript / diskLogText / the TUI themed flush.
 *
 * `userInput` is tagged directly at the sink (NOT derived by classifyLine), so
 * it must commit any pending live `text` buffer first (mirroring phase/log) —
 * the order-of-commit detail is an impl concern; this file asserts the
 * observable committed transcript only.
 */
import { describe, it, expect } from "vitest";
import { createLiveStream } from "../src/render/live-stream.ts";
import type { LiveStreamHandle } from "../src/render/live-stream.ts";

/** A plain-object mock theme so a TUI flush renders a recognizable accent. */
const mockTheme = {
	fg: (color: string, value: string): string => `<${color}>${value}</${color}>`,
	bold: (value: string): string => `**${value}**`,
};

describe("Phase 2 — userInput(text) sink pushes the tagged transcript line (AC-07 / SCENARIO-009)", () => {
	it("userInput(text) pushes { kind:'user-input', text:'📥 '+text } into the transcript", () => {
		const h = createLiveStream({});
		// RED today: `sink.userInput` is undefined → throws.
		h.sink.userInput("focus on the auth bug");
		const tail = h.getTranscript();
		expect(tail).toContainEqual({ kind: "user-input", text: "📥 focus on the auth bug" });
	});

	it("userInput reaches transcriptTail() with the kind + 📥-prefixed text", () => {
		const h = createLiveStream({});
		h.sink.userInput("second input");
		const tail = h.transcriptTail();
		expect(tail.at(-1)).toEqual({ kind: "user-input", text: "📥 second input" });
	});

	it("preserves input order across multiple userInput calls", () => {
		const h = createLiveStream({});
		h.sink.userInput("a");
		h.sink.userInput("b");
		h.sink.userInput("c");
		const kinds = h.getTranscript().filter((l) => l.kind === "user-input");
		expect(kinds.map((l) => l.text)).toEqual(["📥 a", "📥 b", "📥 c"]);
	});

	it("userInput is a tagged sink — classifyLine is NOT consulted (no prefix rules)", () => {
		// Even arbitrary text that contains words classifyLine would otherwise
		// match (PASS / FAIL / error / arrows) must still tag as user-input,
		// because the kind is set at the sink, not derived by classification.
		const h = createLiveStream({});
		h.sink.userInput("→ command that FAILED with an error ✓");
		const tail = h.getTranscript();
		expect(tail.at(-1)?.kind).toBe("user-input");
		expect(tail.at(-1)?.text).toBe("📥 → command that FAILED with an error ✓");
	});

	it("the 📥-prefixed text reaches diskLogText() (raw, grep-friendly)", () => {
		const h = createLiveStream({});
		h.sink.userInput("fix the crash");
		expect(h.diskLogText()).toContain("📥 fix the crash");
	});

	it("a TUI-mode flush renders the user-input line themed via themeLine", () => {
		// This couples to the Phase 2 themeLine('user-input') case, but the
		// observable behavior — the user-input line is rendered through the SAME
		// per-kind themed path as phase/log — is exactly what SCENARIO-009 guards.
		const bodies: string[] = [];
		const h: LiveStreamHandle = createLiveStream({
			mode: "tui",
			theme: mockTheme,
			onUpdate: (b) => bodies.push(b),
		});
		h.sink.userInput("steer toward tests");
		h.flush();
		const last = bodies.at(-1) ?? "";
		expect(last).toContain("<accent>"); // accent fg applied via themeLine('user-input')
		expect(last).toContain("**📥 steer toward tests**"); // bold(innermost) + 📥 prefix
	});
});
