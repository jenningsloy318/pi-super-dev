/**
 * Unit tests for the extracted dashboard presentation module (Phase 1).
 *
 * These tests target the PURE, TUI-context-free helpers that will live in
 * `src/render/dashboard.ts`. They cover:
 *   - AC-02 helpers : statusGlyph / theme threading
 *   - AC-03 helpers : RUNNING_FRAMES / runningGlyph / runningSeed / time-derived seed
 *   - AC-05         : module exports, ANSI-safe truncLine (+ attribution), relocated
 *                     truncateActivity / padTruncate / packDashboardLines
 *
 * Written FIRST (RED). Every symbol referenced below is imported from
 * `./dashboard`, which does NOT yet exist — the suite must fail until the
 * module is implemented.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
	RUNNING_FRAMES,
	runningGlyph,
	runningSeed,
	statusGlyph,
	truncLine,
	truncateActivity,
	padTruncate,
	packDashboardLines,
} from "./dashboard.js";

/** Minimal structural mock of the pi Theme — `fg(token, text)` wraps text in a
 * token marker so assertions can verify WHICH theme token was applied without
 * parsing real ANSI escapes. */
type ThemeLike = { fg: (token: string, text: string) => string };
function mockTheme(): ThemeLike {
	return {
		// e.g. fg("success", "✓") => "<success>✓"
		fg: (token, text) => `<${token}>${text}`,
	};
}

const EXPECTED_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const STATIC_RUNNING_GLYPH = "●";

describe("dashboard module — exports (SCENARIO-008 / AC-05)", () => {
	it("exports every dashboard symbol", () => {
		expect(typeof RUNNING_FRAMES).not.toBe("undefined");
		expect(typeof runningGlyph).toBe("function");
		expect(typeof runningSeed).toBe("function");
		expect(typeof statusGlyph).toBe("function");
		expect(typeof truncLine).toBe("function");
		expect(typeof truncateActivity).toBe("function");
		expect(typeof padTruncate).toBe("function");
		expect(typeof packDashboardLines).toBe("function");
	});
});

describe("RUNNING_FRAMES (AC-03)", () => {
	it("is the 10-frame braille spinner set", () => {
		expect(Array.isArray(RUNNING_FRAMES)).toBe(true);
		expect(RUNNING_FRAMES).toHaveLength(10);
	});

	it("matches the canonical braille frames", () => {
		expect(RUNNING_FRAMES).toEqual(EXPECTED_FRAMES);
	});

	it("contains only single-grapheme frames", () => {
		for (const frame of RUNNING_FRAMES) {
			// \u{1F600} style ranges are surrogate pairs; braille frames are single BMP code points.
			expect([...frame]).toHaveLength(1);
		}
	});
});

describe("runningGlyph (AC-03 / SCENARIO-005, SCENARIO-006)", () => {
	it("returns the static filled-circle glyph when no seed is given", () => {
		expect(runningGlyph()).toBe(STATIC_RUNNING_GLYPH);
		expect(runningGlyph(undefined)).toBe(STATIC_RUNNING_GLYPH);
	});

	it("indexes the frame by the seed", () => {
		expect(runningGlyph(0)).toBe(RUNNING_FRAMES[0]);
		expect(runningGlyph(1)).toBe(RUNNING_FRAMES[1]);
		expect(runningGlyph(9)).toBe(RUNNING_FRAMES[9]);
	});

	it("wraps the index modulo the frame count (abs(seed) % 10)", () => {
		expect(runningGlyph(10)).toBe(RUNNING_FRAMES[0]);
		expect(runningGlyph(11)).toBe(RUNNING_FRAMES[1]);
	});

	it("uses the absolute value of the seed", () => {
		expect(runningGlyph(-1)).toBe(RUNNING_FRAMES[1]);
		expect(runningGlyph(-11)).toBe(RUNNING_FRAMES[1]);
		expect(runningGlyph(-10)).toBe(RUNNING_FRAMES[0]);
	});

	it("advances through every frame as the seed increases (animation reachable)", () => {
		const produced = new Set<number>();
		for (let i = 0; i < 1000; i++) {
			const idx = RUNNING_FRAMES.indexOf(runningGlyph(i));
			expect(idx).toBeGreaterThanOrEqual(0);
			produced.add(idx);
		}
		expect(produced.size).toBe(10);
	});
});

describe("runningSeed (AC-03 / mirrors pi-subagents)", () => {
	it("returns undefined when no values are supplied", () => {
		expect(runningSeed()).toBeUndefined();
	});

	it("sums finite numbers", () => {
		expect(runningSeed(1, 2, 3)).toBe(6);
		expect(runningSeed(5)).toBe(5);
	});

	it("ignores NaN", () => {
		expect(runningSeed(1, NaN, 2)).toBe(3);
		expect(runningSeed(NaN)).toBeUndefined();
	});

	it("ignores undefined entries", () => {
		expect(runningSeed(1, undefined, 2)).toBe(3);
		expect(runningSeed(undefined)).toBeUndefined();
	});

	it("handles negative contributions", () => {
		expect(runningSeed(-3, 7)).toBe(4);
	});

	it("truncates each value toward zero before summing (mirrors pi-subagents Math.trunc)", () => {
		// 2.9 -> 2, 3.1 -> 3 => 5
		expect(runningSeed(2.9, 3.1)).toBe(5);
		expect(runningSeed(-2.9, 3.1)).toBe(1);
	});

	it("handles Infinity by ignoring it", () => {
		expect(runningSeed(1, Infinity, 2)).toBe(3);
		expect(runningSeed(-Infinity)).toBeUndefined();
	});
});

describe("statusGlyph (AC-02 / SCENARIO-003, SCENARIO-004)", () => {
	it("colors completed (ok) stages with the success token and a checkmark", () => {
		const theme = mockTheme();
		expect(statusGlyph("ok", theme as never)).toBe("<success>✓");
	});

	it("colors failed stages with the error token and a cross", () => {
		const theme = mockTheme();
		expect(statusGlyph("failed", theme as never)).toBe("<error>✗");
	});

	it("colors skipped stages with the warning token and a skip glyph", () => {
		const theme = mockTheme();
		expect(statusGlyph("skipped", theme as never)).toBe("<warning>↷");
	});

	it("colors running stages with the accent token (SCENARIO-004)", () => {
		const theme = mockTheme();
		const out = statusGlyph("running", theme as never);
		expect(out.startsWith("<accent>")).toBe(true);
	});

	it("uses an animated braille frame for the running glyph (SCENARIO-005)", () => {
		const theme = mockTheme();
		const out = statusGlyph("running", theme as never);
		const frame = out.slice("<accent>".length);
		// Derived from time, but the glyph must always be a real spinner frame.
		expect(RUNNING_FRAMES).toContain(frame);
	});

	it("colors unknown / pending / empty statuses with the dim token and a dot", () => {
		const theme = mockTheme();
		expect(statusGlyph("pending", theme as never)).toBe("<dim>·");
		expect(statusGlyph("queued", theme as never)).toBe("<dim>·");
		expect(statusGlyph("", theme as never)).toBe("<dim>·");
		expect(statusGlyph("anything-else", theme as never)).toBe("<dim>·");
	});
});

describe("truncLine — ANSI-safe truncation (AC-05 / SCENARIO-010)", () => {
	it("returns the input unchanged when it fits within maxWidth", () => {
		expect(truncLine("hi", 10)).toBe("hi");
		expect(truncLine("hello", 5)).toBe("hello");
		expect(truncLine("", 5)).toBe("");
	});

	it("returns the input unchanged when it exactly fits maxWidth", () => {
		expect(truncLine("hello", 5)).toBe("hello");
	});

	it("truncates with an ellipsis when the visible width exceeds maxWidth", () => {
		const out = truncLine("hello world this is a long line", 10);
		expect(out.endsWith("…")).toBe(true);
		// The ellipsis consumes one cell, so the visible width must not exceed maxWidth.
		const visible = out.replace(/\x1b\[[0-9;]*m/g, "");
		expect(visible.length).toBeLessThanOrEqual(10);
	});

	it("does NOT leave a bare \\x1b[0m reset immediately before the ellipsis (the bleed bug)", () => {
		// An unclosed red style carried to the truncation point must be re-applied
		// (or left active) — never collapsed to a reset right before the "…".
		const styled = `\x1b[31m${"x".repeat(30)}`;
		const out = truncLine(styled, 6);
		expect(out.endsWith("…")).toBe(true);
		expect(out).not.toMatch(/\x1b\[0m…$/);
	});

	it("re-applies an active ANSI SGR code before the ellipsis", () => {
		const styled = `\x1b[31m${"x".repeat(30)}`;
		const out = truncLine(styled, 6);
		// The "…" must be preceded by SOME active style escape (not a hard reset).
		expect(out).toMatch(/(\x1b\[[0-9;]*m)…$/);
		expect(out).not.toMatch(/\x1b\[0m…$/);
	});

	it("measures CJK / wide glyphs correctly so they truncate earlier", () => {
		// Each CJK glyph occupies width 2. A 6-wide budget should not hold 6 glyphs.
		const wide = "中文测试中文测试"; // 8 glyphs, width 16
		const out = truncLine(wide, 6);
		expect(out.endsWith("…")).toBe(true);
		const visible = out.replace(/\x1b\[[0-9;]*m/g, "");
		expect(visible.length).toBeLessThan(wide.length);
	});

	it("handles emoji (surrogate-pair graphemes) without crashing", () => {
		const out = truncLine("😀😀😀😀😀😀", 4);
		expect(typeof out).toBe("string");
		// Either truncated with ellipsis, or returned whole if it fit — both acceptable
		// as long as no NaN / broken surrogate leaks out.
		const visible = out.replace(/\x1b\[[0-9;]*m/g, "");
		expect(visible).not.toContain("\uFFFD"); // no replacement char / broken pair
	});
});

describe("truncateActivity (relocated unchanged — AC-05 / SCENARIO-009)", () => {
	it("returns a short string unchanged", () => {
		expect(truncateActivity("hello", 10)).toBe("hello");
	});

	it("truncates to max-1 visible chars plus an ellipsis", () => {
		expect(truncateActivity("a".repeat(50), 10)).toBe("aaaaaaaaa…");
	});

	it("uses a default max of 100", () => {
		expect(truncateActivity("a".repeat(50))).toBe("a".repeat(50));
		expect(truncateActivity("a".repeat(120))).toBe(`${"a".repeat(99)}…`);
	});

	it("collapses internal whitespace onto a single line", () => {
		expect(truncateActivity("a  b\n\t c", 100)).toBe("a b c");
		expect(truncateActivity("   leading and trailing   ", 100)).toBe(
			"leading and trailing",
		);
	});
});

describe("padTruncate (relocated unchanged — AC-05 / SCENARIO-009)", () => {
	it("pads a short string with trailing spaces to width w", () => {
		expect(padTruncate("hi", 5)).toBe("hi   ");
		expect(padTruncate("hi", 5).length).toBe(5);
	});

	it("truncates with an ellipsis when the string is at least as long as w", () => {
		expect(padTruncate("hello", 3)).toBe("he…");
		expect(padTruncate("ab", 2)).toBe("a…");
	});

	it("preserves a single char when w == 1 on truncation", () => {
		// Behavior retained from prior implementation: Math.max(1, w - 1).
		expect(padTruncate("abcdef", 1)).toBe("a…");
		expect(padTruncate("abcdef", 1).length).toBe(2);
	});
});

describe("packDashboardLines (AC-02 / AC-04 / SCENARIO-007)", () => {
	const entries = [
		{ id: "a", label: "Stage A", status: "ok" },
		{ id: "b", label: "Stage B", status: "failed" },
		{ id: "c", label: "Stage C", status: "running" },
	];

	it("returns a string array whose first line is the themed header", () => {
		const lines = packDashboardLines(entries, "doing stuff", 120, mockTheme() as never);
		expect(Array.isArray(lines)).toBe(true);
		expect(lines.length).toBeGreaterThan(0);
		expect(typeof lines[0]).toBe("string");
	});

	it("header carries the completed-over-total stage count", () => {
		const lines = packDashboardLines(entries, undefined, 120, mockTheme() as never);
		// done = entries not running = 2 (ok + failed); total = 3
		expect(lines[0]).toContain("2/3");
		expect(lines[0]).toContain("super-dev");
	});

	it("header carries the running stage label", () => {
		const lines = packDashboardLines(entries, undefined, 120, mockTheme() as never);
		expect(lines[0]).toContain("Stage C");
	});

	it("header carries the abort hint (SCENARIO-007)", () => {
		const lines = packDashboardLines(entries, undefined, 120, mockTheme() as never);
		expect(lines[0]).toContain("esc to abort");
	});

	it("applies themed status glyphs across the output (ok/failed/running tokens)", () => {
		const all = packDashboardLines(entries, "doing stuff", 120, mockTheme() as never).join(
			"\n",
		);
		expect(all).toContain("<success>"); // ok
		expect(all).toContain("<error>"); // failed
		expect(all).toContain("<accent>"); // running
	});

	it("preserves the two-column adaptive stage layout (ceil(n/2) stage rows)", () => {
		const lines = packDashboardLines(entries, undefined, 120, mockTheme() as never);
		// header(1) + 0 activity lines + ceil(3/2)=2 stage rows = 3 lines
		expect(lines.length).toBe(3);
	});

	it("adds exactly one activity line when activity text is supplied", () => {
		const lines = packDashboardLines(entries, "doing stuff", 120, mockTheme() as never);
		// header(1) + activity(1) + 2 stage rows = 4 lines
		expect(lines.length).toBe(4);
		expect(lines[1]).toContain("doing stuff");
	});

	it("omits the activity line when activity is empty / undefined", () => {
		for (const act of [undefined, "", "   "]) {
			const lines = packDashboardLines(entries, act, 120, mockTheme() as never);
			// header + 2 stage rows only
			expect(lines.length).toBe(3);
		}
	});

	it("header has no running label when no stage is running", () => {
		const done = [
			{ id: "a", label: "Stage A", status: "ok" },
			{ id: "b", label: "Stage B", status: "skipped" },
		];
		const lines = packDashboardLines(done, undefined, 120, mockTheme() as never);
		expect(lines[0]).not.toContain("Stage A");
		expect(lines[0]).not.toContain("Stage B");
		// count = 2 done / 2 total (no running excluded)
		expect(lines[0]).toContain("2/2");
	});
});

describe("edge cases — anti-hardcoding hardening (AC-02 / AC-03 / AC-05)", () => {
	it("runningGlyph distinguishes seed=0 from no-seed (catches `seed || undefined` bug)", () => {
		// A naive `seed || undefined` or `seed ? frame : circle` impl collapses 0 to the
		// static glyph. seed=0 MUST select RUNNING_FRAMES[0], NOT the static circle.
		expect(runningGlyph(0)).toBe(RUNNING_FRAMES[0]);
		expect(runningGlyph(0)).not.toBe(STATIC_RUNNING_GLYPH);
	});

	it("runningGlyph is deterministic for a given seed (idempotent)", () => {
		for (const seed of [-37, -1, 0, 1, 7, 42, 1000]) {
			expect(runningGlyph(seed)).toBe(runningGlyph(seed));
		}
	});

	it("runningSeed(0) returns 0 — distinguishes zero-sum from no-values", () => {
		// `0` is a finite number and must contribute; only an empty/all-non-finite
		// argument list yields undefined.
		expect(runningSeed(0)).toBe(0);
		expect(runningSeed(0, 0, 0)).toBe(0);
	});

	it("runningSeed sums to 0 with mixed positive/negative without going undefined", () => {
		expect(runningSeed(5, -5)).toBe(0);
		expect(runningSeed(5, -5)).not.toBeUndefined();
	});

	it("packDashboardLines handles an empty entries array (0/0 header, no stage rows)", () => {
		const lines = packDashboardLines([], undefined, 120, mockTheme() as never);
		expect(lines.length).toBe(1); // header only, ceil(0/2) = 0 stage rows
		expect(lines[0]).toContain("0/0");
		expect(lines[0]).toContain("super-dev");
		expect(lines[0]).toContain("esc to abort");
	});

	it("packDashboardLines omits the running label fragment when nothing is running", () => {
		// Even on a busy header, no `· <glyph> <label>` running fragment should appear
		// for an all-done stage set.
		const lines = packDashboardLines(
			[{ id: "x", label: "X", status: "ok" }],
			undefined,
			120,
			mockTheme() as never,
		);
		expect(lines[0]).not.toMatch(/·\s*<accent>/);
	});

	it("truncLine does not throw on a tiny maxWidth and stays within budget", () => {
		expect(() => truncLine("hello", 1)).not.toThrow();
		expect(() => truncLine("hello", 0)).not.toThrow();
		for (const w of [0, 1, 2]) {
			const out = truncLine("hello", w);
			expect(typeof out).toBe("string");
			const visible = out.replace(/\x1b\[[0-9;]*m/g, "");
			expect(visible.length).toBeLessThanOrEqual(Math.max(1, w));
		}
	});

	it("statusGlyph is case-sensitive and only matches the canonical status words", () => {
		const theme = mockTheme();
		// Case variants / typos must NOT be treated as a known status — they fall to dim.
		expect(statusGlyph("OK", theme as never)).toBe("<dim>·");
		expect(statusGlyph("Failed", theme as never)).toBe("<dim>·");
		expect(statusGlyph("RUNNING", theme as never)).toBe("<dim>·");
	});

	it("statusGlyph output is always a non-empty string", () => {
		const theme = mockTheme();
		for (const st of ["ok", "failed", "skipped", "running", "", "nonsense"]) {
			const out = statusGlyph(st, theme as never);
			expect(typeof out).toBe("string");
			expect(out.length).toBeGreaterThan(0);
		}
	});

	it("truncateActivity preserves internal spaces (single space between words)", () => {
		// Anti-hardcoding: must not strip legitimate inter-word spaces.
		expect(truncateActivity("hello world foo", 100)).toBe("hello world foo");
		expect(truncateActivity("hello world foo", 8)).toBe("hello w…");
	});

	it("padTruncate leaves a single-space string at w>=1 unchanged-padding", () => {
		// " " length 1 < 5 => padded to 5 chars with trailing spaces.
		expect(padTruncate(" ", 5)).toBe("     ".slice(0, 5));
		expect(padTruncate(" ", 5).length).toBe(5);
	});
});

describe("truncLine attribution comment (AC-05 / SCENARIO-010)", () => {
	it("the dashboard module source carries the pi-subagents MIT attribution", () => {
		const file = fileURLToPath(new URL("./dashboard.ts", import.meta.url));
		const src = (() => {
			try {
				return readFileSync(file, "utf8");
			} catch {
				return "";
			}
		})();
		expect(src.length).toBeGreaterThan(0);
		expect(src).toMatch(/pi-subagents/i);
		expect(src).toMatch(/MIT/i);
	});
});
