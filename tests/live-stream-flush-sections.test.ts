/**
 * Phase 3 (RED) tests — Streaming per-stage sections in `flush()`
 * (AC-03, SCENARIO-010..013).
 *
 * Domain: render-live-stream.
 *
 * === What these tests pin ===
 * `flush()` is rebuilt to render a STACK of per-stage sections via
 * `groupByStage` (Phase 2). Each section = a status-themed header line
 * (running→accent+bold+animated braille glyph, ok→success, failed→error,
 * skipped→warning) carrying a leading `▌` bar in the status color, followed by
 * that stage's lines themed per-kind via `themeLine` and indented TWO spaces;
 * a blank line separates sections. The RUNNING stage shows ≤
 * `RUNNING_TAIL_LINES` (15) recent lines; COMPLETED stages render COMPACT
 * (header + ≤ `COMPLETED_TAIL_LINES` (3) tail, or header-only). Per-stage
 * `trim` notices (kind `trim`) appear INSIDE their own section. The mode gate
 * is unchanged: `mode === "tui" && theme` enables theming; EVERY other mode
 * emits RAW TEXT (plain `▶ <label>` headers + indented logs) with ZERO ANSI
 * bytes (AC-08 byte-clean preserved).
 *
 * SCENARIO-010: TUI flush emits a STACK of per-stage sections — status-themed
 *   header + per-kind indented lines + blank separator; sections in
 *   first-appearance order; header theming by status (running/ok/failed/
 *   skipped); running header carries the animated braille glyph + `▌` bar.
 * SCENARIO-011: the RUNNING stage honors `RUNNING_TAIL_LINES` (15) — pushes 30
 *   lines, flush shows ≤ 15, and a per-stage `trim` notice appears INSIDE that
 *   stage's own section.
 * SCENARIO-012: COMPLETED stages render COMPACT — ≤ `COMPLETED_TAIL_LINES` (3)
 *   tail lines, or header-only when the stage has zero visible lines.
 * SCENARIO-013: non-TUI flush (mode !== "tui" OR no theme) emits RAW TEXT with
 *   ZERO ANSI escape bytes; headers are plain `▶ <label>`; logs indented.
 *
 * === Expected state: ALL FAILING (RED) ===
 *   - `flush()` today renders a SINGLE rolling-tail body (no section headers,
 *     no `▌`/braille, no per-stage caps, no per-stage trim). Every structural
 *     assertion below therefore fails.
 *   - The named constants `RUNNING_TAIL_LINES` / `COMPLETED_TAIL_LINES` /
 *     `TOTAL_SECTION_CAP` are not exported yet → the namespace-import reads
 *     `undefined`.
 * No `execute` / spawned `pi` children are involved — the factory sink is
 * driven directly in isolation.
 */
import { describe, it, expect } from "vitest";

import * as LiveStreamNS from "../src/render/live-stream.ts";

const { createLiveStream } = LiveStreamNS;

/** Unicode braille-pattern block (U+2800..U+28FF) — the animated "running" glyph. */
const BRAILLE = /[\u2800-\u28FF]/;
/** The leading status bar used in TUI section headers. */
const STATUS_BAR = "▌";

/**
 * A structural mock theme whose `fg` / `bold` / `bg` emit searchable markers
 * so status-color and per-kind theming can be asserted WITHOUT real ANSI.
 * Methods are bound arrow functions so they ALSO survive method-detachment
 * (the class-theme guard below additionally pins the `this`-bound contract).
 */
function mockTheme() {
	return {
		fg: (color: string, text: string): string => `⟨fg:${color}⟩${text}⟨/fg:${color}⟩`,
		bold: (text: string): string => `⟨b⟩${text}⟨/b⟩`,
		bg: (color: string, text: string): string => `⟨bg:${color}⟩${text}⟨/bg:${color}⟩`,
	};
}

/**
 * Mutable body holder. `body` is read as a PROPERTY (not destructured) so the
 * latest flushed value is observed at assertion time.
 */
function bodyHolder(): { body: string; onUpdate: (b: string) => void } {
	const h: { body: string; onUpdate: (b: string) => void } = {
		body: "",
		onUpdate: (b: string): void => {
			h.body = b;
		},
	};
	return h;
}

/** Split a body into lines (preserving blank lines for separator checks). */
const lines = (body: string): string[] => body.split("\n");

// ─── Named per-stage tail-budget constants (SCENARIO-011 / 012) ────────────

describe("per-stage tail-budget constants are exported", () => {
	it("exports RUNNING_TAIL_LINES === 15", () => {
		expect(LiveStreamNS.RUNNING_TAIL_LINES).toBe(15);
	});
	it("exports COMPLETED_TAIL_LINES === 3", () => {
		expect(LiveStreamNS.COMPLETED_TAIL_LINES).toBe(3);
	});
	it("exports TOTAL_SECTION_CAP as a positive integer", () => {
		expect(typeof LiveStreamNS.TOTAL_SECTION_CAP).toBe("number");
		expect(LiveStreamNS.TOTAL_SECTION_CAP).toBeGreaterThan(0);
		expect(Number.isInteger(LiveStreamNS.TOTAL_SECTION_CAP)).toBe(true);
	});
});

// ─── SCENARIO-010: TUI flush emits a STACK of per-stage sections ──────────

describe("SCENARIO-010: TUI flush renders a per-stage section stack", () => {
	it("emits one status-themed header per stage in first-appearance order, separated by a blank line", () => {
		const h0 = bodyHolder();
		const h = createLiveStream({ mode: "tui", theme: mockTheme(), onUpdate: h0.onUpdate });
		h.sink.stage({ id: "research", label: "ResearchA", status: "running" });
		h.sink.log("alpha-1-marker");
		h.sink.stage({ id: "design", label: "DesignB", status: "ok" });
		h.sink.log("beta-1-marker");
		h.flush();

		const body = h0.body;
		const idxA = body.indexOf("ResearchA");
		const idxB = body.indexOf("DesignB");
		expect(idxA).toBeGreaterThanOrEqual(0);
		expect(idxB).toBeGreaterThanOrEqual(0);
		expect(idxA).toBeLessThan(idxB); // first-appearance order

		const ls = lines(body);
		const lineA = ls.findIndex((l) => l.includes("ResearchA"));
		const lineB = ls.findIndex((l) => l.includes("DesignB"));
		expect(lineA).toBeGreaterThanOrEqual(0);
		expect(lineB).toBeGreaterThan(lineA);
		const between = ls.slice(lineA + 1, lineB);
		expect(between.some((l) => l.trim() === "")).toBe(true); // blank separator
	});

	it("indents each stage's log lines two spaces under its header", () => {
		const h0 = bodyHolder();
		const h = createLiveStream({ mode: "tui", theme: mockTheme(), onUpdate: h0.onUpdate });
		h.sink.stage({ id: "research", label: "ResearchA", status: "running" });
		h.sink.log("alpha-indent-marker");
		h.flush();

		const indented = lines(h0.body).find(
			(l) => l.startsWith("  ") && l.includes("alpha-indent-marker"),
		);
		expect(indented, "expected a two-space-indented log line under the section").toBeDefined();
	});

	it("themes the running-stage header with accent", () => {
		const h0 = bodyHolder();
		const h = createLiveStream({ mode: "tui", theme: mockTheme(), onUpdate: h0.onUpdate });
		h.sink.stage({ id: "research", label: "RunningHdr", status: "running" });
		h.sink.log("neutral-log");
		h.flush();
		// logs use `text`/`dim` tokens, never accent; accent ⇒ the running header.
		expect(h0.body).toContain("⟨fg:accent⟩");
	});

	it("themes the ok-stage header with success", () => {
		const h0 = bodyHolder();
		const h = createLiveStream({ mode: "tui", theme: mockTheme(), onUpdate: h0.onUpdate });
		h.sink.stage({ id: "design", label: "OkHdr", status: "ok" });
		h.sink.log("neutral-log");
		h.flush();
		expect(h0.body).toContain("⟨fg:success⟩");
	});

	it("themes the failed-stage header with error", () => {
		const h0 = bodyHolder();
		const h = createLiveStream({ mode: "tui", theme: mockTheme(), onUpdate: h0.onUpdate });
		h.sink.stage({ id: "impl", label: "FailHdr", status: "failed" });
		h.sink.log("neutral-log");
		h.flush();
		expect(h0.body).toContain("⟨fg:error⟩");
	});

	it("themes the skipped-stage header with warning", () => {
		const h0 = bodyHolder();
		const h = createLiveStream({ mode: "tui", theme: mockTheme(), onUpdate: h0.onUpdate });
		h.sink.stage({ id: "verify", label: "SkipHdr", status: "skipped" });
		h.sink.log("neutral-log");
		h.flush();
		expect(h0.body).toContain("⟨fg:warning⟩");
	});

	it("the running-stage header carries the animated braille glyph and the ▌ status bar", () => {
		const h0 = bodyHolder();
		const h = createLiveStream({ mode: "tui", theme: mockTheme(), onUpdate: h0.onUpdate });
		h.sink.stage({ id: "research", label: "RunningHdr", status: "running" });
		h.sink.log("neutral-log");
		h.flush();
		const headerLine = lines(h0.body).find(
			(l) => l.includes("RunningHdr") && BRAILLE.test(l) && l.includes(STATUS_BAR),
		);
		expect(headerLine, "running header must carry braille glyph + ▌ bar").toBeDefined();
	});
});

// ─── SCENARIO-011: RUNNING stage honors RUNNING_TAIL_LINES (15) ───────────

describe("SCENARIO-011: the running stage honors RUNNING_TAIL_LINES (15)", () => {
	it("shows at most 15 recent lines for the running stage", () => {
		const h0 = bodyHolder();
		const h = createLiveStream({ mode: "tui", theme: mockTheme(), onUpdate: h0.onUpdate });
		h.sink.stage({ id: "research", label: "ResearchA", status: "running" });
		for (let i = 0; i < 30; i++) h.sink.log(`run-line-${String(i).padStart(2, "0")}`);
		h.flush();

		const markers = Array.from({ length: 30 }, (_, i) => `run-line-${String(i).padStart(2, "0")}`);
		const shown = markers.filter((m) => h0.body.includes(m)).length;
		// Global tailLines default (400) ≫ 30, so without a per-stage cap ALL 30
		// would render. The per-stage RUNNING cap must bound this to ≤ 15.
		expect(shown).toBeLessThanOrEqual(15);
		expect(shown).toBeGreaterThan(0);
	});

	it("emits a per-stage trim notice INSIDE the running section (not a single global one)", () => {
		const h0 = bodyHolder();
		const h = createLiveStream({ mode: "tui", theme: mockTheme(), onUpdate: h0.onUpdate });
		h.sink.stage({ id: "research", label: "ResearchA", status: "running" });
		for (let i = 0; i < 30; i++) h.sink.log(`run-line-${String(i).padStart(2, "0")}`);
		h.flush();

		const body = h0.body;
		expect(body.toLowerCase()).toContain("trim");

		// The trim notice must live INSIDE the running section: after the running
		// header and within that section's rendered tail — not a lone global preamble.
		const ls = lines(body);
		const headerIdx = ls.findIndex((l) => l.includes("ResearchA"));
		const trimIdx = ls.findIndex((l) => l.toLowerCase().includes("trim"));
		expect(headerIdx).toBeGreaterThanOrEqual(0);
		expect(trimIdx).toBeGreaterThan(headerIdx);
	});
});

// ─── SCENARIO-012: COMPLETED stages render COMPACT ────────────────────────

describe("SCENARIO-012: completed stages render COMPACT", () => {
	it("shows at most COMPLETED_TAIL_LINES (3) tail lines for a completed stage", () => {
		const h0 = bodyHolder();
		const h = createLiveStream({ mode: "tui", theme: mockTheme(), onUpdate: h0.onUpdate });
		// An earlier completed stage (status ok) with many lines.
		h.sink.stage({ id: "research", label: "ResearchA", status: "ok" });
		const markers = Array.from({ length: 10 }, (_, i) => `done-line-xx-${i}`);
		for (const m of markers) h.sink.log(m);
		// A trailing running stage (the live activity) so the ok stage is genuinely completed.
		h.sink.stage({ id: "impl", label: "ImplB", status: "running" });
		h.sink.log("live-now");
		h.flush();

		const shown = markers.filter((m) => h0.body.includes(m)).length;
		expect(shown).toBeLessThanOrEqual(3);
	});

	it("renders a completed stage with zero visible lines as header-only (still emits its header)", () => {
		const h0 = bodyHolder();
		const h = createLiveStream({ mode: "tui", theme: mockTheme(), onUpdate: h0.onUpdate });
		// A completed stage with NO log lines at all.
		h.sink.stage({ id: "research", label: "EmptyCompleted", status: "ok" });
		// A later running stage carries the live activity.
		h.sink.stage({ id: "impl", label: "ImplB", status: "running" });
		h.sink.log("live-now");
		h.flush();

		const body = h0.body;
		// The empty completed stage must STILL synthesize a header (not dropped).
		expect(body).toContain("EmptyCompleted");
		// ...and must be themed success (ok) to prove it is a real status header.
		expect(body).toContain("⟨fg:success⟩");
	});
});

// ─── SCENARIO-013: non-TUI flush is byte-clean RAW TEXT (AC-08) ───────────

describe("SCENARIO-013: non-TUI flush emits RAW TEXT with ZERO ANSI bytes", () => {
	it("mode !== 'tui' ⇒ no ANSI escape bytes anywhere in the body", () => {
		const h0 = bodyHolder();
		const h = createLiveStream({ mode: "print", theme: mockTheme(), onUpdate: h0.onUpdate });
		h.sink.stage({ id: "research", label: "ResearchA", status: "running" });
		h.sink.log("plain-log-marker");
		h.flush();
		expect(h0.body).not.toContain("\x1b");
	});

	it("mode !== 'tui' ⇒ plain ▶ header (no ▌ bar, no braille, no theme markers)", () => {
		const h0 = bodyHolder();
		const h = createLiveStream({ mode: "print", theme: mockTheme(), onUpdate: h0.onUpdate });
		h.sink.stage({ id: "research", label: "ResearchA", status: "running" });
		h.sink.log("plain-log-marker");
		h.flush();

		const body = h0.body;
		// A plain header is emitted (carries ▶ and the label) — current flush
		// synthesizes NO header at all, so this fails until Phase 3 lands.
		expect(body).toContain("▶");
		expect(body).toContain("ResearchA");
		// No TUI-only decorations leak into raw text.
		expect(body).not.toContain(STATUS_BAR);
		expect(body).not.toMatch(BRAILLE);
		expect(body).not.toContain("⟨fg:");
	});

	it("mode === 'tui' but NO theme ⇒ also byte-clean raw text (theme is the gate)", () => {
		const h0 = bodyHolder();
		const h = createLiveStream({ mode: "tui", onUpdate: h0.onUpdate }); // no theme
		h.sink.stage({ id: "research", label: "ResearchA", status: "running" });
		h.sink.log("plain-log-marker");
		h.flush();
		expect(h0.body).not.toContain("\x1b");
		expect(h0.body).toContain("▶");
	});
});

// ─── Class-theme guard: flush must call fg/bold METHOD-style ──────────────

describe("flush section rendering does not detach theme methods (class-theme guard)", () => {
	/** A class-based theme whose `fg()` reads `this.fgColors` — mirrors the real
	 *  pi Theme. Detaching `fg` from `this` throws "reading 'fgColors'". */
	class ClassTheme {
		private fgColors: Map<string, string>;
		constructor() {
			const codes: Record<string, string> = {
				accent: "\x1b[35m", success: "\x1b[32m", error: "\x1b[31m",
				warning: "\x1b[33m", text: "\x1b[0m", dim: "\x1b[2m", muted: "\x1b[90m",
				thinkingText: "\x1b[34m", toolTitle: "\x1b[36m",
			};
			this.fgColors = new Map(Object.entries(codes));
		}
		fg(color: string, text: string): string {
			const ansi = this.fgColors.get(color); // throws if `this` is undefined
			if (!ansi) throw new Error(`Unknown theme color: ${color}`);
			return `${ansi}${text}\x1b[39m`;
		}
		bold(text: string): string {
			return `\x1b[1m${text}\x1b[22m`;
		}
		bg(_color: string, text: string): string {
			return `\x1b[7m${text}\x1b[27m`;
		}
	}

	it("flush renders a running section against a class theme without throwing", () => {
		const h0 = bodyHolder();
		const h = createLiveStream({ mode: "tui", theme: new ClassTheme(), onUpdate: h0.onUpdate });
		expect(() => {
			h.sink.stage({ id: "research", label: "ResearchA", status: "running" });
			h.sink.log("class-theme-log");
			h.flush();
		}).not.toThrow();
		expect(h0.body).toContain("ResearchA");
	});
});

// ─── Additional AC-03 edge cases: aggregate cap, empty transcript, live ───
// ─── buffer, distinct per-section trim, no leading blank line ───────────
// These round out SCENARIO-010..013 with the spec-emphasized guarantees not
// covered above: the O(visible) aggregate bound, degenerate inputs, the
// still-pending live buffer's visibility, per-stage (not global) trim, and
// the absence of a stray leading blank line before the first header.
describe("AC-03 edge cases: aggregate cap, empty transcript, live buffer, per-section trim, leading blank", () => {
	it("bounds aggregate body lines to ≤ TOTAL_SECTION_CAP even with many large stages", () => {
		const cap = LiveStreamNS.TOTAL_SECTION_CAP;
		const h0 = bodyHolder();
		// A massive transcript (tailLines widened so the per-stage caps — not the
		// rolling-tail default — are the only thing in play).
		const h = createLiveStream({ mode: "tui", theme: mockTheme(), onUpdate: h0.onUpdate, tailLines: 1_000_000 });
		for (let s = 0; s < 60; s++) {
			h.sink.stage({ id: `stage-${s}`, label: `Stage${s}`, status: s % 2 === 0 ? "ok" : "running" });
			for (let l = 0; l < 40; l++) h.sink.log(`s${s}-l${l}-aggcap`);
		}
		h.flush();
		const count = h0.body.split("\n").length;
		expect(count).toBeLessThanOrEqual(cap);
	});

	it("flush of an empty transcript emits an empty body", () => {
		const h0 = bodyHolder();
		const h = createLiveStream({ mode: "tui", theme: mockTheme(), onUpdate: h0.onUpdate });
		h.flush();
		expect(h0.body).toBe("");
	});

	it("does NOT include the pending live buffer in the visible body (narration excluded)", () => {
		const h0 = bodyHolder();
		const h = createLiveStream({ mode: "tui", theme: mockTheme(), onUpdate: h0.onUpdate });
		h.sink.stage({ id: "research", label: "ResearchA", status: "running" });
		h.sink.text("partial-live-thinking-marker");
		h.flush(); // NO finalizeLive — the buffer is NOT shown (narration excluded from live view).
		const body = h0.body;
		expect(body).not.toContain("partial-live-thinking-marker");
	});

	it("emits a DISTINCT per-stage trim notice inside EACH trimmed section (not one global preamble)", () => {
		const h0 = bodyHolder();
		const h = createLiveStream({ mode: "tui", theme: mockTheme(), onUpdate: h0.onUpdate });
		// Completed stage over cap (10 > COMPLETED_TAIL_LINES).
		h.sink.stage({ id: "research", label: "ResearchA", status: "ok" });
		for (let i = 0; i < 10; i++) h.sink.log(`done-trim-${i}`);
		// Running stage over cap (20 > RUNNING_TAIL_LINES).
		h.sink.stage({ id: "impl", label: "ImplB", status: "running" });
		for (let i = 0; i < 20; i++) h.sink.log(`run-trim-${i}`);
		h.flush();

		const ls = lines(h0.body);
		const trimLines = ls.filter((l) => l.toLowerCase().includes("trim"));
		expect(trimLines.length, "one trim notice per trimmed section").toBeGreaterThanOrEqual(2);

		// The research-stage trim notice must sit BETWEEN its own header and the
		// impl-stage header (i.e. INSIDE the research section), proving per-stage
		// placement rather than a single global preamble.
		const researchHeader = ls.findIndex((l) => l.includes("ResearchA"));
		const implHeader = ls.findIndex((l) => l.includes("ImplB"));
		expect(researchHeader).toBeGreaterThanOrEqual(0);
		expect(implHeader).toBeGreaterThan(researchHeader);
		const researchTrim = ls.findIndex(
			(l, i) => i > researchHeader && i < implHeader && l.toLowerCase().includes("trim"),
		);
		expect(researchTrim).toBeGreaterThan(researchHeader);
		expect(researchTrim).toBeLessThan(implHeader);
	});

	it("does not prepend a stray leading blank line before the first section header", () => {
		const h0 = bodyHolder();
		const h = createLiveStream({ mode: "tui", theme: mockTheme(), onUpdate: h0.onUpdate });
		h.sink.stage({ id: "research", label: "FirstSection", status: "running" });
		h.sink.log("only-log");
		h.flush();
		const ls = lines(h0.body);
		// The very first emitted line must be the first section's header — not a
		// blank separator (the blank separator only goes BETWEEN sections).
		expect(ls[0].trim(), "first line must not be blank").not.toBe("");
		expect(ls[0]).toContain("FirstSection");
	});
});
