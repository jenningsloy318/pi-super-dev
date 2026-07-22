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

import { Container, Markdown, Text, visibleWidth } from "@earendil-works/pi-tui";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { themeLine, commandBackground, statusFgToken, type LineKind } from "./stream-theme.js";
import { groupByStage, type StageGroup } from "./stage-grouping.js";

/**
 * Structural subset of pi's `Theme` that the dashboard presentation layer
 * depends on. Declared with METHOD syntax so it is satisfied bivariantly by
 * BOTH the real pi-coding-agent `Theme` (whose `fg`/`bold` are methods) and by
 * lightweight unit-test mocks that supply just an `fg`/`bold` function pair —
 * keeping the pure helpers free of the full `Theme` shape. Making `theme`
 * optional everywhere also realizes the graceful-degrade contract: with no
 * theme the strings render uncolored (and the running glyph is the static `●`).
 */
export interface DashboardTheme {
	fg(token: string, text: string): string;
	bold?(text: string): string;
	/**
	 * Optional background painter (SCENARIO-007). Added so the real pi
	 * `Theme` — whose `bg(color, text)` is a method — satisfies this shape
	 * STRUCTURALLY, while unit-test mocks can omit it. `stream-theme.ts`
	 * `commandBackground` reads this to paint tool-bubble backgrounds via
	 * pi-tui `Text`'s 4th `customBgFn` arg. Optional ⇒ graceful-degrade:
	 * callers without a background painter simply get none.
	 */
	bg?(token: string, text: string): string;
}

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
 * `theme` is OPTIONAL so the presentation helpers stay pure and unit-testable
 * with no TUI context: when omitted, the glyphs are returned uncolored and the
 * running stage renders the static filled-circle `●` (no animation, since the
 * throttled re-render loop only exists in the live TUI). This is the
 * graceful-degrade contract from the spec — the real TUI factory always
 * threads a `theme`, so the running seed `Math.floor(Date.now() / 100)` still
 * advances the RUNNING_FRAMES index there and produces visible animation
 * (SCENARIO-003 / SCENARIO-004 / SCENARIO-005).
 */
export function statusGlyph(status: string, theme?: DashboardTheme): string {
	if (status === "ok") return theme ? theme.fg("success", "✓") : "✓";
	if (status === "failed") return theme ? theme.fg("error", "✗") : "✗";
	if (status === "skipped") return theme ? theme.fg("warning", "↷") : "↷";
	if (status === "running") {
		// With theme: animated braille frame (time-derived seed). Without theme:
		// the stable static glyph `●` (anti-hardcoding: seed undefined → static).
		return theme
			? theme.fg("accent", runningGlyph(Math.floor(Date.now() / 100)))
			: runningGlyph();
	}
	return theme ? theme.fg("dim", "·") : "·";
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
	theme?: DashboardTheme,
	pendingInputCount: number = 0,
	abortHint: string = "esc to abort",
): string[] {
	// F5: count only TERMINAL stages (ok/failed/skipped). The prior
	// `!== "running"` rule counted never-started (pending/"·") stages as done,
	// so the header over-reported progress (e.g. "8/11" with only 2 finished).
	const TERMINAL = new Set(["ok", "failed", "skipped"]);
	const done = entries.filter((e) => TERMINAL.has(e.status)).length;
	const running = entries.find((e) => e.status === "running");
	const head = truncLine(
		`super-dev · ${done}/${entries.length}${
			running ? ` · ${statusGlyph(running.status, theme)} ${running.label}` : ""
		}  (${abortHint})`,
		width,
	);
	const lines = [head];

	const a = truncateActivity(activity ?? "");
	if (a) lines.push(truncLine(`▶ ${a}`, width));
	// Phase 2 (AC-04 / AC-07): pending mid-run user-input count — surfaces how
	// many interactive inputs are queued but not yet injected into a specialist.
	// Pending-yet-to-be-injected; resets to 0 once drain() runs at the next spawn.
	if (pendingInputCount > 0) {
		lines.push(
			truncLine(
				`📥 ${pendingInputCount} mid-run input${pendingInputCount === 1 ? "" : "s"}`,
				width,
			),
		);
	}

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

/**
 * Build the dashboard widget as a pi-tui `Container` of `Text` children — the
 * Component shape pi's native Component-factory `setWidget(key, factory, opts)`
 * overload consumes. Pure: no TUI side effects, no reads of process state except
 * the explicit `width` arg. Each rendered line becomes one `Text` child, so the
 * 2-column adaptive layout, themed glyphs, animated running frame, and abort
 * hint all flow straight through from `packDashboardLines`
 * (SCENARIO-001 / SCENARIO-002 — AC-01 / AC-02 / AC-04).
 */
export function buildDashboardWidget(
	entries: Array<{ id: string; label: string; status: string }>,
	activity: string | undefined,
	width: number,
	theme?: DashboardTheme,
	pendingInputCount: number = 0,
	abortHint: string = "esc to abort",
): Container {
	const container = new Container();
	for (const line of packDashboardLines(entries, activity, width, theme, pendingInputCount, abortHint)) {
		container.addChild(new Text(line, 1, 0));
	}
	return container;
}

/**
 * Return the `(tui, theme) => Component` closure that pi's native
 * Component-factory `setWidget` overload consumes. Terminal width is read INSIDE
 * the returned closure on every render so the 2-column layout adapts to a
 * resized terminal rather than freezing at creation-time width. The factory
 * arity is exactly 2 (`tui`, `theme`); passing a function — not a string[] — to
 * `setWidget` selects the Component overload and ensures `theme` reaches the
 * strings, which is the AC-01 root-cause fix (AC-08: the string[] overload is
 * never produced) (SCENARIO-001 / SCENARIO-002).
 */
export function createDashboardWidgetFactory(
	entries: Array<{ id: string; label: string; status: string }>,
	activity: string | undefined,
	pendingInputCount: number = 0,
	abortHint: string = "esc to abort",
): (tui: unknown, theme: DashboardTheme) => Container {
	return (_tui, theme) =>
		buildDashboardWidget(entries, activity, process.stdout.columns || 120, theme, pendingInputCount, abortHint);
}

// ---------------------------------------------------------------------------
// Phase 3 — RESULT rendering (AC-06): the COMPLETED-run §1/§2/§3 view.
// ---------------------------------------------------------------------------

/**
 * Result-rendering details shape (the COMPLETED-run path). The streaming path
 * (empty stages) short-circuits in `extension.ts#renderResult` before this
 * builder is ever reached, so every field here is optional and the builder
 * graceful-degrades on any absence (SCENARIO-010 / SCENARIO-016).
 */
export interface ResultDetails {
	summaryLines?: string[];
	/** Per-kind transcript tail (AC-06). Phase 2 carries `{kind,text}` end-to-end
	 *  from the sink; Phase 1 (AC-01) additively stamps `stageId` / `stageLabel`
	 *  so Phase 4 can partition §1 into per-stage blocks. A plain `string`
	 *  element (and an object missing stage tags) is tolerated — groupByStage
	 *  coalesces such legacy entries into ONE merged sentinel section (no throw). */
	transcriptTail?: Array<
		{ kind: LineKind; text: string; stageId?: string; stageLabel?: string } | string
	>;
	/** Stage-progress rows (§2). `id` is OPTIONAL (additive) so a `statusOf`
	 *  resolver can map stageId→status for the Phase-4 per-stage blocks; legacy
	 *  callers that supply only {label,status} still satisfy the shape. */
	stages?: Array<{ id?: string; label: string; status: string }>;
	logPath?: string;
}

/** Status → foreground theme token for a Phase-4 per-stage block header.
 *  Delegates to the shared `statusFgToken` (stream-theme.ts) so the result
 *  view's status→color taxonomy is IDENTICAL to the streaming live view's —
 *  one source of truth (previously duplicated). */
function statusThemeToken(status: string | undefined): string {
	return statusFgToken(status);
}

/** Status → static (non-animated) glyph prefix for a Phase-4 per-stage block
 *  header. The result view is for a COMPLETED run, so the running stage uses
 *  the stable filled-circle `●` rather than the live animated braille frame.
 *  Consistency (spec-12 review AR): an UNDEFINED status (unknown / never
 *  reported terminal) is treated as in-progress `●` to MATCH the accent color
 *  (`statusFgToken(undefined)`→"accent") — do-not-mask-as-ok. Previously the
 *  glyph was the neutral `·` while the color was accent (disagreement). */
function stageBlockGlyph(status: string | undefined): string {
	if (status === "ok") return "✓";
	if (status === "failed") return "✗";
	if (status === "skipped") return "↷";
	return "●"; // running OR undefined (unknown) — in-progress, matches accent fg
}

/**
 * Per-stage tool-bubble BACKGROUND (AC-04 / SCENARIO-014..018). Mirrors
 * pi-native tool bubbles via ONLY the public pi-tui `Text` 4th `customBgFn`
 * argument — no internal pi-core imports. running→toolPendingBg,
 * ok→toolSuccessBg, failed→toolErrorBg, skipped / unknown→none. Graceful-
 * degrades to `undefined` when the theme lacks the optional `bg` member so
 * non-TUI paths never attempt to paint a background (SCENARIO-005).
 */
function statusBackground(
	status: string | undefined,
	theme?: DashboardTheme,
): ((text: string) => string) | undefined {
	if (!theme?.bg) return undefined;
	if (status === "running" || status === undefined) return (text: string) => theme.bg!("toolPendingBg", text); // undefined = unknown/in-progress (matches accent fg + ● glyph) — do-not-mask-as-ok
	if (status === "ok") return (text: string) => theme.bg!("toolSuccessBg", text);
	if (status === "failed") return (text: string) => theme.bg!("toolErrorBg", text);
	return undefined; // skipped → no background
}

/** Status → icon for §2 stage rows (mirrors the renderResult icon mapper). */
export function stageIcon(st: string): string {
	return st === "ok"
		? "✔"
		: st === "failed"
			? "⚠"
			: st === "skipped"
				? "↷"
				: st === "running"
					? "●"
					: "·";
}

/**
 * Build the pi-native result view as a `Container` of [§1 dim Text, §2 bold
 * Text, §3 Markdown] — the AC-06 (SCENARIO-006) composition contract.
 *
 *   §1 — DIMMED detail log (thought-like, persisted; not transient). Header +
 *        the rolling transcript tail + a `(full log: …)` footnote when present.
 *   §2 — NORMAL stage-progress block. A BOLD `── stage progress ──` header
 *        followed by one icon-prefixed row per stage (status → glyph via
 *        `stageIcon`).
 *   §3 — the run summary rendered through the pi-tui `Markdown` component so
 *        headings, bold, code, and lists parse (NOT flattened to plain text —
 *        the AC-06 root-cause fix). Omitted entirely when `summaryLines` is
 *        empty/undefined (graceful-degrade: no blank Markdown block).
 *
 * Pure & TUI-context-free: threads the display `theme` into every styled
 * string and derives the MarkdownTheme from it, so the Container composition is
 * unit-testable with a structural theme mock (mirrors `buildDashboardWidget`
 * for the widget path). Input-resilient: empty `transcriptTail`, missing
 * `logPath`, undefined/empty `summaryLines`, and single-stage pipelines all
 * render without throwing and leave the remaining sections intact
 * (SCENARIO-006 / SCENARIO-010 / SCENARIO-015 / SCENARIO-016).
 */
export function buildResultComponent(details: ResultDetails, theme?: DashboardTheme): Container {
	// HOTFIX: call theme.fg / theme.bold METHOD-STYLE (not destructured). The real
	// pi Theme is a class whose `fg()` reads `this.fgColors`; detaching via
	// `const fg = theme.fg` loses `this` and throws "reading 'fgColors'". The
	// per-kind §1 lines route through `themeLine` (already method-style), but the
	// §1 header + §2 stage header below call these wrappers directly.
	const bold = (text: string): string => (theme?.bold ? theme.bold(text) : text);
	const fg = (color: string, text: string): string => (theme ? theme.fg(color, text) : text);
	const container = new Container();

	// §1 detail log. Two rendering paths share this Container:
	//   • LEGACY (no real stage tags) — the single merged DIM
	//     "── detail log (last 50 lines) ──" view with per-kind themeLine +
	//     command-bubble backgrounds. Pinned byte-for-byte by
	//     dashboard-result.test.ts / dashboard-result-perkind.test.ts (the
	//     SCENARIO-014 per-kind contract) so untagged tails render UNCHANGED.
	//   • PHASE 4 (real stage tags present) — a STACK of per-stage blocks
	//     (AC-04 / SCENARIO-014..018): a BOLD status-themed header (status-glyph
	//     prefix) carrying a per-stage BACKGROUND via pi-tui Text's 4th
	//     `customBgFn` arg (statusBackground), followed by the stage's log lines
	//     themed per-kind via themeLine. Failed/running blocks render EXPANDED;
	//     completed blocks render COMPACT (header + 1-line tail). Legacy
	//     untagged / string entries collapse via groupByStage's sentinel into a
	//     SINGLE merged block — no throw.
	const tail = details.transcriptTail ?? [];
	const hasStageTags = tail.some(
		(e) => typeof e !== "string" && e.stageId !== undefined && e.stageId !== "setup",
	);
	if (!hasStageTags) {
		container.addChild(new Text(fg("dim", "── detail log (last 50 lines) ──"), 0, 0));
		for (const line of tail) {
			const kind: LineKind = typeof line === "string" ? "log" : line.kind;
			const text = typeof line === "string" ? line : line.text;
			const styled = themeLine(kind, text, theme);
			const bgFn = commandBackground(kind, theme);
			container.addChild(new Text(styled, 0, 0, bgFn));
		}
	} else {
		// statusOf resolves a group's status from its stageId via details.stages
		// (id→status). SYMMETRIC with the streaming live view: an untracked stage
		// (incl. the "setup" sentinel, which has no stage event) resolves to
		// `undefined` → renders the accent in-progress treatment on BOTH surfaces —
		// it is NOT forced to "ok"/green, which would mask a pre-stage failure.
		const idToStatus = new Map<string, string>();
		for (const s of details.stages ?? []) {
			if (s.id !== undefined) idToStatus.set(s.id, s.status);
		}
		const statusOf = (stageId: string): string | undefined => idToStatus.get(stageId);
		const groups = groupByStage(tail, statusOf);
		// Consistency with the streaming view: synthesize a header-only block for
		// every stage present in details.stages that produced ZERO transcriptTail
		// lines, so its status still surfaces in the result view (mirrors the
		// live-stream section stack's stageMeta synthesis in SCENARIO-012).
		const presentStageIds = new Set(groups.map((g) => g.stageId));
		for (const s of details.stages ?? []) {
			if (s.id === undefined || presentStageIds.has(s.id)) continue;
			const empty: StageGroup = { stageId: s.id, stageLabel: s.label, lines: [] };
			if (s.status !== undefined) empty.status = s.status;
			groups.push(empty);
		}
		for (const group of groups) {
			const status = group.status;
			const headerBg = statusBackground(status, theme);
			const glyph = stageBlockGlyph(status);
			const headerText = theme
				? fg(statusThemeToken(status), `${glyph} ${bold(group.stageLabel)}`)
				: `${glyph} ${group.stageLabel}`;
			container.addChild(new Text(headerText, 0, 0, headerBg));
			// Per-kind themed lines. command / command-done KEEP their tool-bubble
			// background (commandBackground) so the SCENARIO-014 per-kind contract
			// holds inside every stage block. Failed/running blocks EXPANDED
			// (all lines); completed blocks COMPACT (≤ 1 tail line).
			const expanded = status === "failed" || status === "running";
			const lines = expanded ? group.lines : group.lines.slice(-1);
			for (const line of lines) {
				const styled = themeLine(line.kind, line.text, theme);
				container.addChild(
					new Text(`  ${styled}`, 0, 0, commandBackground(line.kind, theme)),
				);
			}
		}
	}
	if (details.logPath) {
		container.addChild(new Text(fg("dim", `(full log: ${details.logPath})`), 0, 0));
	}

	// §2 stage progress — NORMAL (the answer-like block). Header is BOLD; each
	// stage renders its status icon + label.
	container.addChild(new Text(bold("── stage progress ──"), 0, 0));
	for (const s of details.stages ?? []) {
		container.addChild(new Text(`  ${stageIcon(s.status)} ${s.label}`, 0, 0));
	}

	// §3 summary — Markdown-rendered (AC-06). Omitted entirely when there are no
	// summary lines so no empty Markdown block is ever emitted.
	if (details.summaryLines?.length) {
		container.addChild(
			new Markdown(details.summaryLines.join("\n"), 0, 0, getMarkdownTheme()),
		);
	}

	return container;
}
