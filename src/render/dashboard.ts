/**
 * Dashboard presentation module (Phase 1 — extracted & upgraded).
 *
 * Pure, TUI-context-free helpers powering the pi-super-dev live dashboard
 * widget. Nothing in this module touches the control-flow engine; it only
 * shapes the strings the widget factory feeds into a pi-tui `Container`.
 *
 * Coverage:
 *   - AC-02 : statusGlyph / theme threading
 *   - AC-03 : RUNNING_FRAMES / runningGlyph / runningSeed / time-derived seed
 *   - AC-05 : ANSI-safe truncLine (+ attribution), relocated
 *             truncateActivity / padTruncate / packDashboardLines
 *
 * SCENARIO-003, SCENARIO-004 (status glyphs), SCENARIO-005, SCENARIO-006
 * (running animation), SCENARIO-007 (header / abort hint), SCENARIO-009
 * (relocated truncators), SCENARIO-010 (ANSI-safe truncation).
 */

import { visibleWidth } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";

/**
 * The 10-frame braille spinner set used for animated "running" glyphs.
 * Mirrors pi-subagents (MIT, Nico Bailon) — `src/tui/render.ts`.
 */
export const RUNNING_FRAMES: string[] = [
	"⠋",
	"⠙",
	"⠹",
	"⠸",
	"⠼",
	"⠴",
	"⠦",
	"⠧",
	"⠇",
	"⠏",
];

/** Static filled-circle glyph used when no animation seed is supplied. */
const STATIC_RUNNING_GLYPH = "●";

/**
 * Sum a variadic list of numbers into an animation seed, mirroring
 * pi-subagents' `runningSeed`. Non-finite values (NaN / ±Infinity) and
 * `undefined` entries are ignored; each finite value is truncated toward
 * zero (`Math.trunc`) before being summed. Returns `undefined` when no
 * finite number was supplied (SCENARIO-005 / SCENARIO-006).
 */
export function runningSeed(...values: Array<number | undefined>): number | undefined {
	let seed: number | undefined;
	for (const value of values) {
		if (value === undefined || !Number.isFinite(value)) continue;
		seed = (seed ?? 0) + Math.trunc(value);
	}
	return seed;
}

/**
 * Resolve a "running" glyph. With no seed the static filled-circle is returned;
 * with a seed the corresponding braille frame is selected by `abs(seed) % 10`,
 * so the index wraps and advances as the seed grows (animation reachable).
 * `seed === 0` is a real frame index (RUNNING_FRAMES[0]) — never the static
 * glyph (anti-hardcoding: do NOT collapse falsy seeds).
 */
export function runningGlyph(seed?: number): string {
	if (seed === undefined) return STATIC_RUNNING_GLYPH;
	return RUNNING_FRAMES[Math.abs(seed) % RUNNING_FRAMES.length]!;
}

/**
 * Themed status glyph for a stage line.
 *
 *   ok      → success  ✓
 *   failed  → error    ✗
 *   skipped → warning  ↷
 *   running → accent   <animated braille frame, time-derived seed>
 *   *       → dim      ·
 *
 * The running seed is `Math.floor(Date.now() / 100)`, so each ~200 ms
 * throttled widget re-render (WIDGET_MS) advances the RUNNING_FRAMES index
 * and produces visible animation (SCENARIO-004 / SCENARIO-005).
 */
export function statusGlyph(status: string, theme: Theme): string {
	if (status === "ok") return theme.fg("success", "✓");
	if (status === "failed") return theme.fg("error", "✗");
	if (status === "skipped") return theme.fg("warning", "↷");
	if (status === "running") {
		return theme.fg("accent", runningGlyph(Math.floor(Date.now() / 100)));
	}
	return theme.fg("dim", "·");
}

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/**
 * ANSI-safe line truncation to `maxWidth`.
 *
 * pi-tui's `truncateToWidth` emits `\x1b[0m` immediately before the ellipsis,
 * which resets all active SGR styling and causes color bleed in the TUI. This
 * implementation tracks active ANSI SGR codes and re-applies them before the
 * "…" ellipsis. It measures visible width via `visibleWidth` (so CJK / wide
 * glyphs truncate earlier) and iterates graphemes with `Intl.Segmenter` (so
 * surrogate-pair emoji never break). When the input already fits it is
 * returned unchanged.
 *
 * Adapted from pi-subagents (MIT, Nico Bailon) — ANSI-safe truncation
 * (`src/tui/render.ts`). Re-released here under the pi-super-dev project.
 */
export function truncLine(text: string, maxWidth: number): string {
	if (visibleWidth(text) <= maxWidth) return text;

	const targetWidth = maxWidth - 1;
	let result = "";
	let currentWidth = 0;
	let activeStyles: string[] = [];
	let i = 0;

	while (i < text.length) {
		const ansiMatch = text.slice(i).match(/^\x1b\[[0-9;]*m/);
		if (ansiMatch) {
			const code = ansiMatch[0]!;
			result += code;

			if (code === "\x1b[0m" || code === "\x1b[m") {
				activeStyles = [];
			} else {
				activeStyles.push(code);
			}
			i += code.length;
			continue;
		}

		let end = i;
		while (end < text.length && !text.slice(end).match(/^\x1b\[[0-9;]*m/)) {
			end++;
		}

		const textPortion = text.slice(i, end);
		for (const seg of segmenter.segment(textPortion)) {
			const grapheme = seg.segment;
			const graphemeWidth = visibleWidth(grapheme);

			if (currentWidth + graphemeWidth > targetWidth) {
				return result + activeStyles.join("") + "…";
			}

			result += grapheme;
			currentWidth += graphemeWidth;
		}
		i = end;
	}

	return result + activeStyles.join("") + "…";
}

/** Truncate to a single line of at most `max` visible chars (activity row). */
export function truncateActivity(s: string, max = 100): string {
	const oneLine = s.replace(/\s+/g, " ").trim();
	return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

/** Pad `s` with spaces to `w`, or truncate with an ellipsis if longer. */
export function padTruncate(s: string, w: number): string {
	return s.length >= w ? `${s.slice(0, Math.max(1, w - 1))}…` : s + " ".repeat(w - s.length);
}

/**
 * Format the dashboard widget lines, packing ALL stages into width-adaptive
 * columns so EVERY stage is shown — no summary, no stage dropped. The header
 * carries the completed-over-total count, the running stage label, and the
 * "esc to abort" hint (SCENARIO-007). Status glyphs are themed via
 * `statusGlyph`; the running stage uses the time-derived seed so it animates
 * across throttled re-renders (AC-02 / AC-03 / AC-04).
 */
export function packDashboardLines(
	entries: Array<{ id: string; label: string; status: string }>,
	activity: string | undefined,
	width: number,
	theme: Theme,
): string[] {
	const done = entries.filter((e) => e.status !== "running").length;
	const running = entries.find((e) => e.status === "running");
	const head = truncLine(
		`super-dev · ${done}/${entries.length}${
			running ? ` · ${statusGlyph(running.status, theme)} ${running.label}` : ""
		}  (esc to abort)`,
		width,
	);
	const lines = [head];

	const a = truncateActivity(activity ?? "");
	if (a) lines.push(truncLine(`▶ ${a}`, width));

	const cols = 2;
	// Adapt cell width to the actual terminal width — prevents overflow on narrow terminals.
	const indent = 2;
	const cellW = Math.max(10, Math.floor((width - indent) / cols));
	// Column-first fill: first column = first half, second column = second half.
	const half = Math.ceil(entries.length / cols);
	const cell = (e: { label: string; status: string }): string =>
		padTruncate(`${statusGlyph(e.status, theme)} ${e.label}`, cellW);

	for (let row = 0; row < half; row++) {
		const left = entries[row];
		const right = entries[row + half];
		lines.push(
			truncLine(" ".repeat(indent) + (right ? cell(left!) + cell(right) : cell(left!)), width),
		);
	}
	return lines;
}
