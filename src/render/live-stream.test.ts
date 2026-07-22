/**
 * Phase 2 RED tests — live-stream sink-layer tagging + mode-aware flush.
 *
 * Coverage: AC-04 / AC-05 / AC-06 (SCENARIO-008..013) and the AC-08
 * no-ANSI-leak regression mirror (SCENARIO-015 / SCENARIO-016).
 *
 * === Why a separate factory under test ===
 * In the current codebase the sink / flush() / finalizeLive() / transcript
 * state all live as CLOSURES inside `activate().execute` in src/extension.ts.
 * That closure runs the real 13-stage pipeline via `runPipelineTask` (spawns
 * `pi` child processes), so it cannot be driven directly in a unit test.
 * The spec's Testing Strategy (C) explicitly requires driving "the sink
 * through phase/log/text events" in isolation — therefore Phase 2 MUST
 * extract a PURE, dependency-free factory `createLiveStream()` (a sibling of
 * stream-theme.ts under src/render/) that encapsulates:
 *   - the {kind,text} transcript (AC-04),
 *   - mode-aware per-kind theming in flush() with a raw-text fallback (AC-05),
 *   - the kind-carrying transcriptTail (AC-06).
 *
 * src/extension.ts then imports and wires this factory (its sink/flush are
 * delegated to the handle; throttling + dashboard rendering stay in
 * extension.ts). Throttling/timers are intentionally OUT of the factory so
 * tests stay deterministic.
 *
 * === Expected state: ALL FAILING (RED) ===
 * `src/render/live-stream.ts` does not exist yet, so every test errors on
 * import. Once Phase 2 lands the factory, the assertions pin the exact
 * behaviour.
 */
import { describe, it, expect } from "vitest";

import { createLiveStream } from "./live-stream.js";
import type { TranscriptLine } from "./live-stream.js";
import type { DashboardTheme } from "./dashboard.js";

/** ANSI CSI detector — MUST NOT match any no-theme / non-TUI output. */
const ANSI = /\x1b\[/i;

/** Extract mock-theme color-token markers (`<accent>`, `<toolTitle>`, ...).
 *  The `<b>` bold wrapper is structural, not a color token, so it is omitted. */
function tokensIn(s: string): string[] {
	return [...s.matchAll(/<([a-zA-Z]+)>/g)]
		.map((m) => m[1])
		.filter((t) => t !== "b");
}

/** Structural theme mock (mirrors stream-theme.test.ts). `fg`/`bg` wrap text in
 *  token markers; `bold` wraps in `<b>`. No real ANSI is emitted, so "tokens
 *  present" stands in for "themed". */
function mockTheme(): Required<DashboardTheme> {
	return {
		fg: (token, text) => `<${token}>${text}`,
		bg: (token, text) => `<<${token}>>${text}`,
		bold: (text) => `<b>${text}</b>`,
	};
}

/** Captures every onUpdate body emitted by flush(). */
function capture(): { bodies: string[]; push: (b: string) => void } {
	const bodies: string[] = [];
	return { bodies, push: (b: string) => void bodies.push(b) };
}

// ─── AC-04 / SCENARIO-008: kind tagging at the sink layer ────────────────

describe("AC-04 sink-layer kind tagging (SCENARIO-008)", () => {
	it("phase(label) pushes a {phase} line carrying the ▶ marker text", () => {
		const h = createLiveStream({});
		h.sink.phase("Requirements");
		expect(h.getTranscript()).toEqual([
			{ kind: "phase", text: "▶ Requirements", stageId: "setup", stageLabel: "pre-stage" },
		]);
	});

	it("log(→ cmd) classifies as command and stores the RAW message as text", () => {
		const h = createLiveStream({});
		h.sink.log("→ npm install");
		expect(h.getTranscript()).toEqual([
			{ kind: "command", text: "→ npm install", stageId: "setup", stageLabel: "pre-stage" },
		]);
	});

	it("log(→ structured_output … ✓) classifies as command-done (precedence)", () => {
		const h = createLiveStream({});
		h.sink.log("→ structured_output { ok: true } ✓");
		expect(h.getTranscript()[0]?.kind).toBe("command-done");
		expect(h.getTranscript()[0]?.text).toBe("→ structured_output { ok: true } ✓");
	});

	it("log(▶ marker) classifies as phase, not as a plain log", () => {
		const h = createLiveStream({});
		h.sink.log("▶ Research");
		expect(h.getTranscript()[0]).toEqual({ kind: "phase", text: "▶ Research", stageId: "setup", stageLabel: "pre-stage" });
	});

	it("log(plain message) classifies as log", () => {
		const h = createLiveStream({});
		h.sink.log("doing some work");
		expect(h.getTranscript()[0]).toEqual({ kind: "log", text: "doing some work", stageId: "setup", stageLabel: "pre-stage" });
	});

	it("log(success marker) classifies as log-success", () => {
		const h = createLiveStream({});
		h.sink.log("PASS — all green");
		expect(h.getTranscript()[0]?.kind).toBe("log-success");
	});

	it("log(❌ error marker) classifies as error", () => {
		const h = createLiveStream({});
		h.sink.log("❌ build broke");
		expect(h.getTranscript()[0]?.kind).toBe("error");
	});

	it("text(partial) buffers live; it is NOT committed until finalizeLive()", () => {
		const h = createLiveStream({});
		h.sink.text("thinking about it...");
		expect(h.getTranscript()).toEqual([]);
	});

	it("finalizeLive() commits the buffered live text tagged as thinking", () => {
		const h = createLiveStream({});
		h.sink.text("thinking about it...");
		h.finalizeLive();
		expect(h.getTranscript()).toEqual([
			{ kind: "thinking", text: "thinking about it...", stageId: "setup", stageLabel: "pre-stage" },
		]);
	});

	it("finalized thinking resets the buffer so a second text commits separately", () => {
		const h = createLiveStream({});
		h.sink.text("part one");
		h.finalizeLive();
		h.sink.text("part two");
		h.finalizeLive();
		expect(h.getTranscript()).toEqual([
			{ kind: "thinking", text: "part one", stageId: "setup", stageLabel: "pre-stage" },
			{ kind: "thinking", text: "part two", stageId: "setup", stageLabel: "pre-stage" },
		]);
	});

	it("interleaving phase/log/finalize produces the full kind sequence in order", () => {
		const h = createLiveStream({});
		h.sink.phase("Design");
		h.sink.log("→ npm test");
		h.sink.text("musing");
		h.finalizeLive();
		h.sink.log("PASS");
		expect(h.getTranscript().map((l) => l.kind)).toEqual([
			"phase",
			"command",
			"thinking",
			"log-success",
		]);
	});
});

// ─── AC-04 / SCENARIO-009: rolling tail + trim notice ────────────────────

describe("AC-04 rolling tail + trim notice (SCENARIO-009)", () => {
	it("emits a trim-notice line when the tail limit is exceeded", () => {
		const cap = capture();
		const h = createLiveStream({ onUpdate: cap.push, mode: "print", tailLines: 3 });
		for (let i = 0; i < 5; i++) h.sink.log(`line ${i}`);
		h.flush();
		const lines = cap.bodies.at(-1)!.split("\n");
		expect(lines).toHaveLength(4); // 1 trim notice + 3 kept lines
		expect(/2 earlier lines trimmed/.test(lines[0]!)).toBe(true);
		expect(lines.slice(1)).toEqual(["line 2", "line 3", "line 4"]);
	});

	it("does NOT emit a trim notice when under the tail limit", () => {
		const cap = capture();
		const h = createLiveStream({ onUpdate: cap.push, mode: "print", tailLines: 400 });
		h.sink.log("only one line");
		h.flush();
		expect(cap.bodies.at(-1)).toBe("only one line");
	});

	it("uses a 400-line rolling tail by default (TAIL_LINES=400)", () => {
		const cap = capture();
		const h = createLiveStream({ onUpdate: cap.push, mode: "print" });
		for (let i = 0; i < 402; i++) h.sink.log(`l ${i}`);
		h.flush();
		const lines = cap.bodies.at(-1)!.split("\n");
		expect(lines).toHaveLength(401); // 1 trim notice + 400 kept
		expect(/2 earlier lines trimmed/.test(lines[0]!)).toBe(true);
		expect(lines[1]).toBe("l 2");
		expect(lines[400]).toBe("l 401");
	});

	it("does NOT include the pending live buffer in the visible body (narration excluded)", () => {
		const cap = capture();
		const h = createLiveStream({ onUpdate: cap.push, mode: "print" });
		h.sink.phase("Spec");
		h.sink.text("still typing"); // pending, not finalized
		h.flush();
		const lines = cap.bodies.at(-1)!.split("\n");
		expect(lines).toEqual(["▶ Spec"]); // "still typing" excluded — narration not shown in live view
		expect(h.getTranscript()).toEqual([
			{ kind: "phase", text: "▶ Spec", stageId: "setup", stageLabel: "pre-stage" },
		]);
	});
});

// ─── AC-05 / SCENARIO-010: TUI flush styles per kind ─────────────────────

describe("AC-05 TUI-mode per-kind styling (SCENARIO-010)", () => {
	it("styles each committed line via themeLine tokens when mode === 'tui'", () => {
		const cap = capture();
		const h = createLiveStream({ onUpdate: cap.push, mode: "tui", theme: mockTheme() });
		h.sink.phase("Design");                  // phase → accent
		h.sink.log("→ npm test");                // command → toolTitle
		h.sink.text("musing..."); h.finalizeLive(); // thinking → thinkingText
		h.sink.log("❌ boom");                    // error → error
		h.flush();
		const toks = tokensIn(cap.bodies.at(-1)!);
		expect(toks).toContain("accent");
		expect(toks).toContain("toolTitle");
		expect(toks).toContain("thinkingText");
		expect(toks).toContain("error");
	});

	it("phase markers render bolded in TUI mode", () => {
		const cap = capture();
		const h = createLiveStream({ onUpdate: cap.push, mode: "tui", theme: mockTheme() });
		h.sink.phase("Design");
		h.flush();
		expect(cap.bodies.at(-1)).toContain("<b>");
	});

	it("command lines split the arrow bold and dim the rest (toolTitle name)", () => {
		const cap = capture();
		const h = createLiveStream({ onUpdate: cap.push, mode: "tui", theme: mockTheme() });
		h.sink.log("→ npm install");
		h.flush();
		const body = cap.bodies.at(-1)!;
		const toks = tokensIn(body);
		expect(toks).toContain("toolTitle"); // bolded arrow name
		expect(toks).toContain("dim");       // dimmed rest
	});

	it("trim notice renders with the muted token in TUI mode", () => {
		const cap = capture();
		const h = createLiveStream({ onUpdate: cap.push, mode: "tui", theme: mockTheme(), tailLines: 1 });
		h.sink.log("a");
		h.sink.log("b");
		h.flush();
		expect(tokensIn(cap.bodies.at(-1)!)).toContain("muted");
	});
});

// ─── AC-05 / SCENARIO-011: non-TUI flush stays byte-clean ────────────────

describe("AC-05 non-TUI flush stays byte-clean (SCENARIO-011)", () => {
	it("print mode emits RAW joined text with zero ANSI and zero token markers", () => {
		const cap = capture();
		const h = createLiveStream({ onUpdate: cap.push, mode: "print" /* no theme */ });
		h.sink.phase("Design");
		h.sink.log("→ npm test");
		h.sink.text("musing..."); h.finalizeLive();
		h.flush();
		const body = cap.bodies.at(-1)!;
		expect(body).toBe("▶ Design\n→ npm test\nmusing...");
		expect(ANSI.test(body)).toBe(false);
		expect(tokensIn(body)).toEqual([]);
	});

	it("json/headless/rpc modes are likewise byte-clean (any non-'tui' mode)", () => {
		const cap = capture();
		const h = createLiveStream({ onUpdate: cap.push, mode: "json" /* no theme */ });
		h.sink.phase("Spec");
		h.sink.log("PASS");
		h.flush();
		expect(cap.bodies.at(-1)).toBe("▶ Spec\nPASS");
		expect(ANSI.test(cap.bodies.at(-1)!)).toBe(false);
	});

	it("tui mode WITHOUT a theme also degrades to raw text (zero ANSI)", () => {
		const cap = capture();
		const h = createLiveStream({ onUpdate: cap.push, mode: "tui" /* theme undefined */ });
		h.sink.phase("Design");
		h.sink.log("→ npm test");
		h.flush();
		const body = cap.bodies.at(-1)!;
		expect(body).toBe("▶ Design\n→ npm test");
		expect(ANSI.test(body)).toBe(false);
		expect(tokensIn(body)).toEqual([]);
	});
});

// ─── AC-05 on-disk log: raw line.text, zero ANSI ─────────────────────────

describe("AC-05 on-disk log writes raw line.text (zero ANSI)", () => {
	it("diskLogText() returns committed texts joined by \\n — no kinds, no ANSI", () => {
		// Even in TUI+theme mode (which WOULD style the live body), the disk log
		// stays grep-friendly raw text.
		const h = createLiveStream({ mode: "tui", theme: mockTheme() });
		h.sink.phase("Design");
		h.sink.log("→ npm test");
		h.sink.text("musing..."); h.finalizeLive();
		expect(h.diskLogText()).toBe("▶ Design\n→ npm test\nmusing...");
		expect(ANSI.test(h.diskLogText())).toBe(false);
		expect(tokensIn(h.diskLogText())).toEqual([]);
	});

	it("diskLogText() excludes the pending (un-finalized) live buffer", () => {
		const h = createLiveStream({});
		h.sink.phase("Design");
		h.sink.text("not yet committed");
		expect(h.diskLogText()).toBe("▶ Design");
	});
});

// ─── AC-06 / SCENARIO-012 + SCENARIO-013: kind-carrying transcriptTail ───

describe("AC-06 transcriptTail carries kinds end-to-end (SCENARIO-012/013)", () => {
	it("returns the last 50 {kind,text} entries by default", () => {
		const h = createLiveStream({});
		for (let i = 0; i < 60; i++) h.sink.log(`line ${i}`);
		const tail = h.transcriptTail();
		expect(tail).toHaveLength(50);
		expect(tail[0]).toEqual({ kind: "log", text: "line 10", stageId: "setup", stageLabel: "pre-stage" });
		expect(tail[49]).toEqual({ kind: "log", text: "line 59", stageId: "setup", stageLabel: "pre-stage" });
	});

	it("honours an explicit tail size", () => {
		const h = createLiveStream({});
		for (let i = 0; i < 10; i++) h.sink.log(`line ${i}`);
		expect(h.transcriptTail(3)).toEqual([
			{ kind: "log", text: "line 7", stageId: "setup", stageLabel: "pre-stage" },
			{ kind: "log", text: "line 8", stageId: "setup", stageLabel: "pre-stage" },
			{ kind: "log", text: "line 9", stageId: "setup", stageLabel: "pre-stage" },
		]);
	});

	it("preserves the kind of every kind in the tail", () => {
		const h = createLiveStream({});
		h.sink.phase("P");
		h.sink.log("→ c");            // command
		h.sink.log("❌ e");           // error
		h.sink.text("t"); h.finalizeLive(); // thinking
		const tail = h.transcriptTail(10);
		expect(tail.map((l) => l.kind)).toEqual(["phase", "command", "error", "thinking"]);
	});

	it("SCENARIO-013: always emits {kind,text} objects, never plain strings", () => {
		// The extension is the producer; it must NEVER emit legacy plain-string
		// entries, so downstream render tolerance (buildResultComponent, Phase 3)
		// is a pure safety net rather than a load-bearing branch.
		const h = createLiveStream({});
		h.sink.phase("P");
		h.sink.log("hello");
		h.sink.text("world"); h.finalizeLive();
		for (const entry of h.transcriptTail()) {
			expect(typeof entry).toBe("object");
			expect(entry).not.toBeNull();
			expect(typeof (entry as TranscriptLine).kind).toBe("string");
			expect(typeof (entry as TranscriptLine).text).toBe("string");
		}
	});

	it("transcriptTail is empty when nothing has been streamed", () => {
		expect(createLiveStream({}).transcriptTail()).toEqual([]);
	});
});

// ─── AC-08 regression: no-ANSI-leak + TUI mirror (SCENARIO-015/016) ──────

describe("no-ANSI-leak regression (AC-08 / SCENARIO-015..016)", () => {
	it("no-theme path: BOTH live body AND disk log contain zero ANSI", () => {
		const cap = capture();
		const h = createLiveStream({ onUpdate: cap.push, mode: "print" });
		h.sink.phase("Spec");
		h.sink.log("→ npm run build");
		h.sink.log("PASS");
		h.sink.log("❌ failed after stage");
		h.sink.text("live thinking");
		h.flush();
		h.finalizeLive();
		expect(ANSI.test(cap.bodies.at(-1)!)).toBe(false);
		expect(ANSI.test(h.diskLogText())).toBe(false);
	});

	it("TUI mirror: themed body DOES carry the expected fg tokens", () => {
		const cap = capture();
		const h = createLiveStream({ onUpdate: cap.push, mode: "tui", theme: mockTheme() });
		h.sink.phase("Spec");
		h.sink.log("→ npm run build");
		h.sink.log("PASS");
		h.flush();
		const toks = tokensIn(cap.bodies.at(-1)!);
		expect(toks).toContain("accent");    // phase
		expect(toks).toContain("toolTitle"); // command
		expect(toks).toContain("success");   // log-success
	});
});
