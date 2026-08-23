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

	it("keeps the latest Stage 9 activity banner visible even when the running tail overflows", () => {
		const h0 = bodyHolder();
		const h = createLiveStream({ mode: "print", onUpdate: h0.onUpdate });
		h.sink.stage({ id: "implementation.phase-01", label: "↳ Phase 1/1: Core", status: "running", kind: "phase", parentId: "implementation" });
		h.sink.phase("Implementation — Phase 1/1: Core — TDD RED (attempt 1, try 1)");
		for (let i = 0; i < 30; i++) h.sink.log(`agent-tool-line-${String(i).padStart(2, "0")}`);
		h.flush();

		const body = h0.body;
		expect(body).toContain("Implementation — Phase 1/1: Core — TDD RED (attempt 1, try 1)");
		expect(body).toContain("agent-tool-line-29");
		expect(body).not.toContain("agent-tool-line-00");
	});
});

// ─── SCENARIO-012: COMPLETED stages render COMPACT ────────────────────────

describe("SCENARIO-012: completed stages render COMPACT", () => {
	it("drops ALL ordinary chatter from a completed stage (header + sticky lifecycle only — titles stay pinned)", () => {
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
		// PINNED TITLES: completed sections render HEADER + sticky lifecycle ONLY —
		// ordinary chatter is dropped entirely (0 of the 10 markers) so every
		// stage title stays visible instead of being flushed off the viewport.
		expect(shown).toBe(0);
	});

	it("keeps sticky run metadata and stage/phase lifecycle lines visible outside the completed tail cap", () => {
		const h0 = bodyHolder();
		const h = createLiveStream({ mode: "print", onUpdate: h0.onUpdate, showTimestamps: true });
		h.sink.stage({ id: "research", label: "ResearchA", status: "running" });
		h.sink.log("super-dev v9.09.09");
		h.sink.log("Run started: 2026-08-06T22:00:00.000+08:00");
		h.sink.log("Launch branch: main");
		h.sink.log("Run log: /Users/me/.super-dev/runs/2026/run.log");
		h.sink.log("Stage start: ResearchA at 2026-08-06T22:00:00.000+08:00");
		const ordinary = Array.from({ length: 12 }, (_, i) => `done-noise-xx-${String(i).padStart(2, "0")}`);
		for (const line of ordinary) h.sink.log(line);
		h.sink.log("Implementation phase-01 RED gate FAIL: red-polluted: RED phase changed production file(s): src/prod.go");
		h.sink.log("Implementation phase-01 RED gate evidence: status=polluted-red oracle=green retries=4 testFiles=src/prod_test.go changedFiles=src/prod.go forbiddenFiles=src/prod.go");
		h.sink.log("Implementation phase-01 RED runner diagnostic: cwd=/repo cmd=node --test src/prod_test.go status=broken exit=1 signal=none tail=SyntaxError marker");
		h.sink.log("Stage end: ResearchA status=ok at 2026-08-06T22:10:00.000+08:00 duration=10m 00s");
		h.sink.stage({ id: "research", label: "ResearchA", status: "ok" });
		h.sink.stage({ id: "implementation.phase-01", label: "↳ Phase 1/1: Core", status: "running", kind: "phase", parentId: "implementation" });
		h.sink.log("Phase start: ↳ Phase 1/1: Core at 2026-08-06T22:11:00.000+08:00");
		for (let i = 0; i < 8; i++) h.sink.log(`phase-noise-xx-${String(i).padStart(2, "0")}`);
		h.sink.log("Phase end: ↳ Phase 1/1: Core status=ok at 2026-08-06T22:13:00.000+08:00 duration=2m 00s");
		h.sink.stage({ id: "implementation.phase-01", label: "↳ Phase 1/1: Core", status: "ok", kind: "phase", parentId: "implementation" });
		h.sink.stage({ id: "verify", label: "Verify", status: "running" });
		h.sink.log("live-now");
		h.flush();

		const body = h0.body;
		expect(body).toContain("super-dev v9.09.09");
		expect(body).toContain("Run started: 2026-08-06T22:00:00.000+08:00");
		expect(body).toContain("Launch branch: main");
		expect(body).toContain("Run log: /Users/me/.super-dev/runs/2026/run.log");
		expect(body).toContain("Stage start: ResearchA");
		expect(body).toContain("Stage end: ResearchA status=ok");
		expect(body).toContain("Implementation phase-01 RED gate FAIL");
		expect(body).toContain("Implementation phase-01 RED gate evidence");
		expect(body).toContain("Implementation phase-01 RED runner diagnostic");
		expect(body).toContain("Phase start: ↳ Phase 1/1: Core");
		expect(body).toContain("Phase end: ↳ Phase 1/1: Core status=ok");
		expect(ordinary.filter((m) => body.includes(m))).toHaveLength(0);
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
		// PINNED TITLES: the COMPLETED research section renders header + sticky
		// lifecycle only (no ordinary tail, NO trim notice). Only the RUNNING
		// impl section (20 > RUNNING_TAIL_LINES) still emits a per-stage trim
		// notice INSIDE its own section (not a single global preamble).
		expect(trimLines.length, "trim notice only in the trimmed RUNNING section").toBeGreaterThanOrEqual(1);

		const researchHeader = ls.findIndex((l) => l.includes("ResearchA"));
		const implHeader = ls.findIndex((l) => l.includes("ImplB"));
		expect(researchHeader).toBeGreaterThanOrEqual(0);
		expect(implHeader).toBeGreaterThan(researchHeader);
		// The completed research section has NO trim notice between its header and
		// the impl header (ordinary chatter dropped, not trimmed-and-noticed).
		const researchTrim = ls.findIndex(
			(l, i) => i > researchHeader && i < implHeader && l.toLowerCase().includes("trim"),
		);
		expect(researchTrim, "completed section has no trim notice").toBe(-1);
		// The running impl section's trim notice sits AFTER its own header.
		const implTrim = ls.findIndex((l, i) => i > implHeader && l.toLowerCase().includes("trim"));
		expect(implTrim).toBeGreaterThan(implHeader);
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

// ─── Sticky stage headers + stranded-banner suppression ─────────────────────
// Two related fixes: (1) the `▶ <stage>` phase banner task() emits right before
// its stage-running event used to DUPLICATE the section header `▌ <stage>` — and,
// because the dashboard appends " (attempt N)" only to the stage-event label,
// the banner's base label broke the phase→stage re-tag and stranded itself in
// the PREVIOUS section. Stage-level banners are now suppressed (the header is
// the canonical title). (2) When the body overflows TOTAL_SECTION_CAP, old
// sections collapse to HEADER-ONLY instead of being dropped — every stage title
// stays pinned while only the live section's body scrolls.
describe("sticky stage headers + redundant-banner suppression", () => {
	it("suppresses the stranded `▶ <stage>` banner that duplicates a section header (attempt-suffix re-tag gap)", () => {
		const h0 = bodyHolder();
		const h = createLiveStream({ mode: "tui", theme: mockTheme(), onUpdate: h0.onUpdate });
		// Reproduce the real task() ordering: the requirements stage runs, then the
		// review stage's PHASE banner fires while currentStage is still requirements
		// (emitted before its own stage-running event), then the review stage event
		// arrives carrying the " (attempt 2)" suffix the dashboard adds.
		h.sink.stage({ id: "requirements", label: "Stage 2B — Requirements", status: "running" });
		h.sink.log("requirements-work-marker");
		h.sink.stage({ id: "requirements", label: "Stage 2B — Requirements", status: "ok" });
		h.sink.phase("Stage 2B — Requirements Review"); // stranded: base label, pre-stage-event
		h.sink.stage({ id: "requirementsReview", label: "Stage 2B — Requirements Review (attempt 2)", status: "running" });
		h.sink.log("review-work-marker");
		h.flush();
		const body = h0.body;
		// The canonical section header survives (with its attempt suffix)...
		expect(body).toContain("Stage 2B — Requirements Review (attempt 2)");
		// ...but the redundant `▶ <base label>` banner is NOT rendered as a log line.
		expect(body).not.toContain("▶ Stage 2B — Requirements Review");
	});

	it("preserves sub-phase banners (Implementation phases are NOT stage labels)", () => {
		const h0 = bodyHolder();
		const h = createLiveStream({ mode: "tui", theme: mockTheme(), onUpdate: h0.onUpdate });
		h.sink.stage({ id: "implementation", label: "Stage 9 — Implementation", status: "running" });
		h.sink.phase("Implementation — Phase 1/1: Core — TDD RED (attempt 1, try 1)");
		h.sink.log("agent-tool-line-29");
		h.flush();
		const body = h0.body;
		// The stage-level banner (matching the stage label) is suppressed...
		expect(body).not.toContain("▶ Stage 9 — Implementation");
		// ...but the sub-phase banner (no stage label match) is kept.
		expect(body).toContain("Implementation — Phase 1/1: Core — TDD RED (attempt 1, try 1)");
	});

	it("sticky headers: over TOTAL_SECTION_CAP, old completed sections collapse to header-only (titles persist, not dropped)", () => {
		const cap = LiveStreamNS.TOTAL_SECTION_CAP;
		const h0 = bodyHolder();
		const h = createLiveStream({ mode: "tui", theme: mockTheme(), onUpdate: h0.onUpdate, tailLines: 1_000_000 });
		// Many large COMPLETED stages (each header + trim + 3-line tail ≈ 5 lines)
		// plus a final live stage → total well over the cap, so the aggregate
		// collapse must engage.
		for (let s = 0; s < 90; s++) {
			h.sink.stage({ id: `stage-${s}`, label: `StickyStage${s}`, status: "ok" });
			for (let l = 0; l < 40; l++) h.sink.log(`s${s}-l${l}-sticky`);
		}
		h.sink.stage({ id: "live", label: "LiveStage", status: "running" });
		for (let l = 0; l < 40; l++) h.sink.log(`live-l${l}`);
		h.flush();
		const body = h0.body;
		// Body is still bounded by the cap...
		expect(lines(body).length).toBeLessThanOrEqual(cap);
		// ...yet the OLDEST completed title survives (the old drop-whole-sections
		// behavior would have removed StickyStage0 ENTIRELY once over the cap).
		expect(body).toContain("StickyStage0");
		expect(body).toContain("StickyStage89");
		expect(body).toContain("LiveStage");
		// The live section keeps its scrolling body; a collapsed old stage does not.
		expect(body).toContain("live-l39");
		expect(body).not.toContain("s0-l39-sticky");
	});
});

// ─── Pinned stage titles + END-glyph on completed headers ────────────────────
// Completed sections render HEADER + sticky lifecycle ONLY (ordinary chatter
// dropped) so EVERY stage title — and its Stage/Phase start+end markers — stays
// visible instead of being flushed off the top of the viewport by a tall body.
// The completed header also carries a status glyph (✓/✗) as a visible END
// marker, symmetric with the running header's animated START glyph.
describe("pinned stage titles + END-glyph on completed headers", () => {
	it("keeps EVERY stage title visible across many completed stages + a live tail (ordinary chatter dropped)", () => {
		const h0 = bodyHolder();
		const h = createLiveStream({ mode: "print", onUpdate: h0.onUpdate, showTimestamps: true });
		// 20 completed stages, each with ordinary noise + a Stage start/end lifecycle line.
		for (let s = 0; s < 20; s++) {
			h.sink.stage({ id: `stage-${s}`, label: `Stage ${s} — Work`, status: "running" });
			h.sink.log(`Stage start: Stage ${s} — Work at 2026-08-06T22:00:00.000+08:00`);
			for (let i = 0; i < 12; i++) h.sink.log(`noise-${s}-${i}`);
			h.sink.log(`Stage end: Stage ${s} — Work status=ok at 2026-08-06T22:01:00.000+08:00 duration=1m 00s`);
			h.sink.stage({ id: `stage-${s}`, label: `Stage ${s} — Work`, status: "ok" });
		}
		// A final live stage carrying the scrolling tail.
		h.sink.stage({ id: "live", label: "Stage 20 — Live", status: "running" });
		for (let i = 0; i < 30; i++) h.sink.log(`live-line-${i}`);
		h.flush();
		const body = h0.body;
		// EVERY completed stage title is pinned (visible), not flushed away.
		for (let s = 0; s < 20; s++) expect(body).toContain(`Stage ${s} — Work`);
		expect(body).toContain("Stage 20 — Live");
		// Every stage's sticky start+end lifecycle markers survive (the sticky lines
		// the user asked to keep pinned), while ordinary noise is dropped.
		expect(body).toContain("Stage start: Stage 0 — Work");
		expect(body).toContain("Stage end: Stage 0 — Work status=ok");
		expect(body).toContain("Stage start: Stage 19 — Work");
		expect(body).toContain("Stage end: Stage 19 — Work status=ok");
		expect(body).not.toContain("noise-0-0");
		expect(body).not.toContain("noise-19-11");
		// The live stage keeps its scrolling recent tail.
		expect(body).toContain("live-line-29");
	});

	it("a completed TUI header carries the ✓ END-glyph (ok) and ✗ (failed)", () => {
		const h0 = bodyHolder();
		const h = createLiveStream({ mode: "tui", theme: mockTheme(), onUpdate: h0.onUpdate });
		h.sink.stage({ id: "okstage", label: "OkDone", status: "ok" });
		h.sink.log("ok-ordinary-noise");
		h.sink.stage({ id: "failstage", label: "FailDone", status: "failed" });
		h.sink.log("fail-ordinary-noise");
		h.sink.stage({ id: "live", label: "LiveNow", status: "running" });
		h.sink.log("live-now");
		h.flush();
		const body = h0.body;
		// The completed ok header carries the ✓ success glyph as its END marker...
		expect(body).toContain("✓");
		expect(body).toContain("OkDone");
		// ...and the failed header carries ✗.
		expect(body).toContain("✗");
		expect(body).toContain("FailDone");
		// Ordinary chatter from the completed stages is dropped (sticky-only).
		expect(body).not.toContain("ok-ordinary-noise");
		expect(body).not.toContain("fail-ordinary-noise");
	});
});

// ─── Sticky lifecycle anchors (agent/session start+end, doc/rendered writes) ──
// The user asked that each stage pin not just its title + start/end markers but
// its full lifecycle spine: which agent ran (and for how long) and what artifact
// was written. These lines are sticky anchors retained in completed sections
// AND when the aggregate cap collapses a section (header + anchors, not
// header-only).
describe("sticky lifecycle anchors (agent/session/doc/rendered)", () => {
	const lifecycle = [
		"Stage start: BDD Review at 2026-08-14T10:49:34.975+08:00",
		"bddReview: agent bdd-reviewer working",
		"agent pipeline.bddReview: start agent=bdd-reviewer backend=session access=source-read-only timeout=role-default thinking=high cwd=/repo model=antigravity/gemini-3.6-flash controlKeys=title,date,verdict,summary promptChars=2589",
		"session pipeline.bddReview: start timeout=1200000ms cwd=/repo access=source-read-only controlKeys=title,date,verdict,summary",
		"agent pipeline.bddReview: end elapsed=219964ms control=yes model=unknown",
		"bddReview: doc → 04-bdd-review.md",
		"bddReview: rendered /home/me/04-bdd-review.md (10235 bytes)",
		"Stage end: BDD Review status=ok at 2026-08-14T10:53:14.974+08:00 duration=3m 40s",
	];

	it("pins every lifecycle anchor line of a completed stage (ordinary chatter dropped)", () => {
		const h0 = bodyHolder();
		const h = createLiveStream({ mode: "print", onUpdate: h0.onUpdate, showTimestamps: false });
		h.sink.stage({ id: "bddReview", label: "Stage 2C — BDD Review", status: "running" });
		for (const line of lifecycle) h.sink.log(line);
		for (let i = 0; i < 20; i++) h.sink.log(`bdd-noise-${i}`);
		h.sink.stage({ id: "bddReview", label: "Stage 2C — BDD Review", status: "ok" });
		// a trailing live stage so BDD Review is genuinely completed
		h.sink.stage({ id: "impl", label: "Implementation", status: "running" });
		h.sink.log("live-now");
		h.flush();
		const body = h0.body;
		for (const line of lifecycle) expect(body).toContain(line);
		expect(body).not.toContain("bdd-noise-0");
		expect(body).not.toContain("bdd-noise-19");
	});

	it("survives aggregate cap pressure: collapses to header + anchors, not header-only", () => {
		const cap = LiveStreamNS.TOTAL_SECTION_CAP;
		const h0 = bodyHolder();
		const h = createLiveStream({ mode: "print", onUpdate: h0.onUpdate, tailLines: 1_000_000 });
		// Many completed stages, each with its lifecycle anchors + lots of ordinary
		// noise, so the total far exceeds the cap and the aggregate collapse engages.
		for (let s = 0; s < 60; s++) {
			h.sink.stage({ id: `s${s}`, label: `Stage ${s}`, status: "running" });
			h.sink.log(`s${s}: agent agent-${s} working`);
			h.sink.log(`agent pipeline.s${s}: start agent=agent-${s} backend=session`);
			h.sink.log(`agent pipeline.s${s}: end elapsed=1000ms control=yes model=unknown`);
			h.sink.log(`s${s}: doc → 0${s}-doc.md`);
			h.sink.log(`s${s}: rendered /home/me/0${s}-doc.md (500 bytes)`);
			for (let i = 0; i < 30; i++) h.sink.log(`s${s}-noise-${i}`);
			h.sink.stage({ id: `s${s}`, label: `Stage ${s}`, status: "ok" });
		}
		h.sink.stage({ id: "live", label: "LiveStage", status: "running" });
		for (let i = 0; i < 40; i++) h.sink.log(`live-l${i}`);
		h.flush();
		const body = h0.body;
		// Body still bounded by the cap.
		expect(lines(body).length).toBeLessThanOrEqual(cap);
		// A RECENT stage near the live end keeps its full anchor spine (header +
		// anchors). The oldest stages are dropped outright (last resort) once 60
		// stages x ~6 anchors exceeds the cap; every stage that SURVIVES keeps its
		// anchors (the prior header-only collapse would have stripped them).
		expect(body).toContain("s59: agent agent-59 working");
		expect(body).toContain("agent pipeline.s59: start agent=agent-59");
		expect(body).toContain("agent pipeline.s59: end elapsed=1000ms");
		expect(body).toContain("s59: rendered /home/me/059-doc.md");
		// Ordinary noise is still dropped (anchors pin, chatter does not).
		expect(body).not.toContain("s59-noise-0");
	});
});

// ─── Sticky Stage 1 setup anchors (Setup/Worktree/Spec dir) ──
// The user reported the created-worktree line scrolled away with Stage 1's
// body, leaving no visible answer to "where does this run work?". These three
// lines are now sticky anchors: real byte-level fixtures below are lifted
// verbatim from production run 2026-08-16T08-41-11-882Z/run.log.
describe("sticky setup anchors (Setup/Worktree/Spec dir)", () => {
	const setupAnchors = [
		"Setup: spec 03-staging-requirements | frontend | branch main",
		"Worktree: ./.worktree/03-staging-requirements (created)",
		"Spec dir: ./docs/specifications/03-staging-requirements/",
	];

	it("pins the setup identity lines of a completed Stage 1 section (chatter dropped)", () => {
		const h0 = bodyHolder();
		const h = createLiveStream({ mode: "print", onUpdate: h0.onUpdate, showTimestamps: false });
		h.sink.stage({ id: "setup", label: "Stage 1 — Setup", status: "running" });
		for (const line of setupAnchors) h.sink.log(line);
		for (let i = 0; i < 20; i++) h.sink.log(`setup-noise-${i}`);
		h.sink.stage({ id: "setup", label: "Stage 1 — Setup", status: "ok" });
		h.sink.stage({ id: "impl", label: "Implementation", status: "running" });
		h.sink.log("live-now");
		h.flush();
		const body = h0.body;
		for (const line of setupAnchors) expect(body).toContain(line);
		expect(body).not.toContain("setup-noise-0");
	});

	it("pins the in-place + resumed + git-init variants too", () => {
		const h0 = bodyHolder();
		const h = createLiveStream({ mode: "print", onUpdate: h0.onUpdate, showTimestamps: false });
		h.sink.stage({ id: "setup", label: "Stage 1 — Setup", status: "running" });
		h.sink.log("Setup: spec 01-x | mixed (Web UI) | branch main (resumed)");
		h.sink.log("Worktree: ./.worktree/01-x (in-place); git init'd");
		h.sink.log("Spec dir: .");
		h.sink.stage({ id: "setup", label: "Stage 1 — Setup", status: "ok" });
		h.sink.stage({ id: "impl", label: "Implementation", status: "running" });
		h.flush();
		const body = h0.body;
		expect(body).toContain("Worktree: ./.worktree/01-x (in-place); git init'd");
		expect(body).toContain("Setup: spec 01-x | mixed (Web UI) | branch main (resumed)");
		expect(body).toContain("Spec dir: .");
	});

	it("does NOT pin a bare 'Worktree:' agent echo lacking the created/in-place marker", () => {
		const h0 = bodyHolder();
		const h = createLiveStream({ mode: "print", onUpdate: h0.onUpdate, showTimestamps: false });
		h.sink.stage({ id: "setup", label: "Stage 1 — Setup", status: "running" });
		h.sink.log("Worktree: /repo/some/echoed/context/line");
		for (let i = 0; i < 20; i++) h.sink.log(`setup-noise-${i}`);
		h.sink.stage({ id: "setup", label: "Stage 1 — Setup", status: "ok" });
		h.sink.stage({ id: "impl", label: "Implementation", status: "running" });
		h.flush();
		expect(h0.body).not.toContain("Worktree: /repo/some/echoed/context/line");
	});
});
