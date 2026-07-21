/**
 * Live-stream sink + mode-aware flush factory (Phase 2).
 *
 * Encapsulates the kind-carrying transcript, the rolling-tail + trim-notice,
 * and the **mode-gated** per-kind theming of the live `onUpdate` body. It is
 * the SINGLE runtime authority for the live stream's content kinds — every
 * emitted line is classified HERE at the sink (no upstream emit-site changes).
 *
 * Why a factory (and not inline closures in `extension.ts#execute`):
 *   The original transcript / sink / flush / finalizeLive all lived as closures
 *   inside the real `execute` path, which runs the 13-stage pipeline (spawns
 *   `pi` children) and so cannot be driven in a unit test. The spec's Testing
 *   Strategy (C) requires driving "the sink through phase/log/text events" in
 *   isolation, so Phase 2 extracts this PURE, dependency-free factory. It owns
 *   ONLY classification + transcript + mode-aware body rendering + the disk-log
 *   raw text. Throttling, timers, and the dashboard widget are intentionally
 *   LEFT OUT so the factory is deterministic and unit-testable; `extension.ts`
 *   drives throttling/dashboard on top of the returned handle.
 *
 * Coverage: AC-04 (kind tagging + rolling tail), AC-05 (TUI per-kind theming
 * with a raw-text non-TUI fallback + raw disk log), AC-06 (kind-carrying
 * transcriptTail), AC-08 (no-ANSI-leak regression — non-TUI output is
 * byte-clean).
 *
 * SCENARIO-008 (sink tagging), SCENARIO-009 (rolling tail + trim notice),
 * SCENARIO-010 (TUI styling), SCENARIO-011 (non-TUI byte-clean),
 * SCENARIO-012 / SCENARIO-013 (kind-carrying tail), SCENARIO-015 / SCENARIO-016
 * (no-ANSI-leak + TUI mirror).
 */

import { runningGlyph, type DashboardTheme } from "./dashboard.js";
import { classifyLine, themeLine, statusFgToken } from "./stream-theme.js";
import type { LineKind } from "./stream-theme.js";
import { groupByStage, type StageGroup } from "./stage-grouping.js";

/**
 * One committed transcript entry. `kind` is the classified content taxonomy
 * value; `text` is the RAW (un-themed, un-indented) line text — the disk log
 * and every non-TUI body render this field byte-for-byte. `stageId` /
 * `stageLabel` (AC-01 / SCENARIO-001..004) record which pipeline stage the
 * line was emitted under; they are stamped at every push site from the
 * factory's `currentStageId` / `currentStageLabel`.
 */
export type TranscriptLine = {
	kind: LineKind;
	text: string;
	stageId: string;
	stageLabel: string;
};

/** Structured dashboard `stage` event payload — the ONLY source the sink
 *  reads stage identity from (never the human-readable `▶ Stage N` label). */
export interface StageInfo {
	id: string;
	label: string;
	status?: string;
}

/** The minimal sink surface the factory owns (phase / log / text / stage). */
export interface LiveStreamSink {
	phase(label: string): void;
	log(message: string): void;
	text(partial: string): void;
	/** Phase 2 (AC-07 / SCENARIO-009): mid-run user input, tagged directly at
	 *  the sink as `{ kind: "user-input", text: "📥 " + text }` so it flows
	 *  through transcriptTail() → buildResultComponent → renderResult unchanged
	 *  (same tagged-kind path as phase/thinking/trim). */
	userInput(text: string): void;
	/** AC-01 / SCENARIO-004: set the current stage from the STRUCTURED dashboard
	 *  `stage` event (info.id is canonical — never parsed off the `▶ Stage N`
	 *  label). ALSO re-tags the most-recent transcript entry when it is a `phase`
	 *  line whose label matches info.label: control-flow emits `phase` strictly
	 *  BEFORE `stage:{running}` (research RESOLVED-1), so without this sink-side
	 *  correction that phase line would inherit the PREVIOUS stage. Only the
	 *  single most-recent matching phase line is touched. */
	stage(info: StageInfo): void;
}

/** Options for {@link createLiveStream}. */
export interface CreateLiveStreamOptions {
	/** Live-body callback — receives the rendered (mode-aware) body string. */
	onUpdate?: (body: string) => void;
	/** pi run mode. Only `"tui"` enables per-kind theming; every other value
	 *  (and the default) emits raw text (byte-clean for print/json/headless/RPC). */
	mode?: string;
	/** The display theme. When present AND `mode === "tui"`, lines are themed
	 *  per-kind via {@link themeLine}; otherwise raw text is emitted (zero ANSI). */
	theme?: DashboardTheme;
	/** Rolling-tail window size (default 400). When the visible body exceeds
	 *  this, a `{trim}` notice line prefixes the last `tailLines` entries. */
	tailLines?: number;
}

/** Handle returned by {@link createLiveStream}. */
export interface LiveStreamHandle {
	/** The classified sink (phase / log / text). */
	sink: LiveStreamSink;
	/** Commit any pending live buffer as a `{thinking}` line. */
	finalizeLive(): void;
	/** Render + emit the rolling-tail body via `onUpdate`. */
	flush(): void;
	/** The committed transcript (excludes the un-finalized live buffer). */
	getTranscript(): TranscriptLine[];
	/** Committed `text` values joined by `\n` — grep-friendly raw disk log
	 *  (no kinds, no ANSI, no pending live buffer). */
	diskLogText(): string;
	/** The last `size` (default 50) transcript entries as `{kind,text}` objects. */
	transcriptTail(size?: number): TranscriptLine[];
}

/** Default tail size for the final `transcriptTail` snapshot (AC-06). */
const DEFAULT_TAIL_SNAPSHOT = 50;

// ─── AC-03 (SCENARIO-010..013): per-stage section tail budgets ───────────
/**
 * Max recent lines shown for the RUNNING stage's section. The live activity
 * is foregrounded with a generous tail so in-flight work stays visible.
 */
export const RUNNING_TAIL_LINES = 15;
/**
 * Max tail lines shown for a COMPLETED (ok/failed/skipped) stage's section —
 * completed work renders COMPACT so the live view stays scannable (header +
 * ≤ this many tail lines, or header-only when the stage has no lines).
 */
export const COMPLETED_TAIL_LINES = 3;
/**
 * Aggregate bound on the total rendered body so flush stays O(visible lines)
 * regardless of how many stages a run has (a 100-stage run would otherwise
 * fan out 100 × per-stage tail lines). Applied as a final safety trim AFTER
 * the per-stage caps; never interferes with small inputs.
 */
export const TOTAL_SECTION_CAP = 400;
/**
 * Hot-path bound on the transcript slice passed to `groupByStage` on every
 * throttled flush. `groupByStage` is O(input) and `flush()` runs repeatedly
 * across the whole run, so partitioning the FULL unbounded transcript on every
 * flush is the streaming hot path's dominant cost. This caps the input to a
 * generous recent window (10× the output cap) — older lines are already
 * trimmed to ≤ `COMPLETED_TAIL_LINES` per completed stage, and a completed
 * stage whose lines all predate the window still renders its header via the
 * `stageMeta` synthesis (SCENARIO-012), so capping the input never drops
 * visible content; it only bounds the worst-case partition cost on huge runs.
 */
export const PARTITION_INPUT_CAP = TOTAL_SECTION_CAP * 10;

/** Leading status bar drawn in the section-header status color (TUI only). */
const STATUS_BAR = "▌";

/**
 * AC-03 / AC-04: the synthetic per-stage (or legacy rolling-tail) trim notice.
 * The contiguous `earlier lines trimmed` substring is asserted verbatim by the
 * SCENARIO-009 rolling-tail tests and the SCENARIO-015 regression guard, so it
 * must survive every render path. When `stageLabel` is supplied the notice is
 * scoped to that stage's own section; otherwise it is the legacy global tail
 * notice (byte-clean raw text, no stage qualifier).
 */
const trimNoticeText = (trimmed: number, stageLabel?: string): string =>
	stageLabel
		? `… ${trimmed} earlier lines trimmed in "${stageLabel}" (full log saved at run end) …`
		: `… ${trimmed} earlier lines trimmed (full log saved at run end) …`;

/**
 * AC-03 (SCENARIO-010): render ONE per-stage section header line.
 *
 * - TUI (theme supplied): a status-themed header carrying a leading `▌` bar
 *   in the status color. The RUNNING stage (and unknown / pre-stage status,
 *   treated as in-progress) adds the animated braille glyph via
 *   `runningGlyph(Math.floor(Date.now()/100))` and a BOLD label; ok → success,
 *   failed → error, skipped → warning.
 * - non-TUI (no theme): a plain `▶ <label>` header — byte-clean raw text with
 *   ZERO ANSI (AC-08 no-leak contract preserved).
 *
 * Theme access is METHOD-style via local `fg`/`bold` wrappers (never
 * destructured) so the class-based pi `Theme` (whose `fg()` reads
 * `this.fgColors`) survives without a detached-`this` throw — pinned by the
 * class-theme guard in tests/live-stream-flush-sections.test.ts.
 */
const renderSectionHeader = (
	group: Pick<StageGroup, "stageLabel" | "status">,
	theme: DashboardTheme | undefined,
): string => {
	if (!theme) return `▶ ${group.stageLabel}`;
	const bold = (value: string): string =>
		theme.bold ? theme.bold(value) : value;
	const fg = (color: string, value: string): string => theme.fg(color, value);
	const label = group.stageLabel;
	const status = group.status;
	const token = statusFgToken(status); // shared status→color taxonomy (dedup)
	// Unknown / pre-stage status ⇒ treat as in-progress (running) so the
	// sentinel "setup" section theming matches the live activity's accent.
	if (status === undefined || status === "running") {
		const glyph = runningGlyph(Math.floor(Date.now() / 100));
		return fg(token, `${STATUS_BAR}${glyph} ${bold(label)}`);
	}
	return fg(token, `${STATUS_BAR} ${label}`);
};

/**
 * Create a live-stream handle. The transcript starts empty; the sink is the
 * ONLY classification entry point; the live body is themed per-kind in TUI mode
 * and emitted raw in every other mode (AC-05 byte-clean contract).
 */
export function createLiveStream(opts: CreateLiveStreamOptions = {}): LiveStreamHandle {
	const onUpdate = opts.onUpdate;
	const mode = opts.mode;
	const theme = opts.theme;
	/** Rolling-tail window for the pre-stage legacy body (default 400). The
	 *  per-stage section stack uses its OWN caps (RUNNING/COMPLETED_TAIL_LINES). */
	const tailLines = opts.tailLines ?? 400;

	const transcript: TranscriptLine[] = [];
	let live = "";

	// AC-01 / SCENARIO-001: the stage the sink is currently emitting under.
	// Defaults to the sentinel pre-stage until the first structured `stage`
	// event arrives (RESOLVED-1: resolved from info.id, never label parsing).
	let currentStageId = "setup";
	let currentStageLabel = "pre-stage";
	// AC-03 / SCENARIO-010: stageId → { label, status? }, captured from the
	// structured `stage` events the sink receives so flush can theme each
	// section header WITHOUT importing the dashboard tracker (the pure
	// groupByStage helper receives this map as its injected `statusOf`
	// resolver). The LABEL is stored (not just status) so flush can SYNTHESIZE
	// an empty header for a stage that emitted a `stage` event but produced
	// ZERO log lines (SCENARIO-012). A Map, so iteration follows stage-event
	// arrival order.
	const stageMeta = new Map<string, { label: string; status?: string }>();
	// AC-03: true once the first STRUCTURED `stage` event arrives. Until then the
	// run is in its pre-stage window and flush() emits the legacy rolling-tail
	// body (raw joined text, no section header, no indent) — preserving the
	// AC-04/AC-05 + SCENARIO-015 byte-clean contract pinned by Phase 2 tests.
	let stageReceived = false;

	/** Commit any pending live buffer as a `{thinking}` line (SCENARIO-008).
	 *  Stamps the CURRENT stage tag onto the committed entry (AC-01). */
	const finalizeLive = (): void => {
		if (live) {
			transcript.push({
				kind: "thinking",
				text: live,
				stageId: currentStageId,
				stageLabel: currentStageLabel,
			});
			live = "";
		}
	};

	const sink: LiveStreamSink = {
		// SCENARIO-008: phase marker carries the ▶ prefix text.
		phase: (label: string): void => {
			finalizeLive();
			transcript.push({
				kind: "phase",
				text: `▶ ${label}`,
				stageId: currentStageId,
				stageLabel: currentStageLabel,
			});
		},
		// SCENARIO-008: log is classified by the single classifyLine authority;
		// the RAW message is stored as text (no leading indent — classification
		// trims leading whitespace itself).
		log: (message: string): void => {
			finalizeLive();
			transcript.push({
				kind: classifyLine(message),
				text: message,
				stageId: currentStageId,
				stageLabel: currentStageLabel,
			});
		},
		// Live (typing) buffer — NOT committed until finalizeLive().
		text: (partial: string): void => {
			live = partial;
		},
		// Phase 2 (AC-07 / SCENARIO-009): tagged user-input line — same commit
		// semantics as phase/log (flush any pending live buffer first), then push
		// the `📥 `-prefixed raw text so it reaches diskLogText + themed flush.
		userInput: (text: string): void => {
			finalizeLive();
			transcript.push({
				kind: "user-input",
				text: `📥 ${text}`,
				stageId: currentStageId,
				stageLabel: currentStageLabel,
			});
		},
		// AC-01 / SCENARIO-004: set the current stage from the STRUCTURED
		// dashboard `stage` event (info.id is canonical — never parsed off the
		// `▶ Stage N` label). ALSO re-tags the most-recent transcript entry when
		// it is a `phase` line whose label matches info.label: control-flow emits
		// `phase` strictly BEFORE `stage:{running}` (research RESOLVED-1), so
		// without this sink-side correction that phase line would inherit the
		// PREVIOUS stage. Only the single most-recent matching phase line is
		// touched — older phase lines are left alone.
		stage: (info: StageInfo): void => {
			stageReceived = true;
			currentStageId = info.id;
			currentStageLabel = info.label;
			// Always record the label; update status only when the event carries
			// one (a later `stage:{running}` then `stage:{ok}` for the same id
			// keeps the latest terminal status).
			const prev = stageMeta.get(info.id);
			stageMeta.set(info.id, {
				label: info.label,
				status: info.status !== undefined ? info.status : prev?.status,
			});
			// Re-tag the most-recent matching phase line that still sits under the
			// PREVIOUS stage (RESOLVED-1 phase-before-stage ordering). Scan back a
			// SMALL window rather than only the literal last entry, so an
			// intervening commit (e.g. a finalizeLive thinking push between the
			// `phase` and the `stage:{running}`) does not silently defeat the
			// correction. The first (most-recent) match wins; we stop early once an
			// entry already tagged with this stage is reached.
			for (
				let i = transcript.length - 1;
				i >= Math.max(0, transcript.length - 4);
				i--
			) {
				const entry = transcript[i]!;
				if (entry.stageId === info.id) break;
				if (
					entry.kind === "phase" &&
					entry.text.startsWith("▶ ") &&
					entry.text.slice(2) === info.label
				) {
					entry.stageId = info.id;
					entry.stageLabel = info.label;
					break;
				}
			}
		},
	};

	/**
	 * Legacy rolling-tail body (AC-04 / AC-05). Emitted while the run is in its
	 * pre-stage window — before the first STRUCTURED `stage` event arrives.
	 * Produces the byte-clean RAW-JOINED text in every non-TUI mode (body ===
	 * joined `text`, NO section header, NO indentation) and the per-kind themed
	 * body in TUI mode. A synthetic `{trim}` notice prefixes the last
	 * `tailLines` entries when the visible window overflows. Preserves the
	 * Phase 2 contract pinned by `live-stream.test.ts` and the SCENARIO-015
	 * regression guard byte-for-byte.
	 */
	const flushRollingTail = (visible: TranscriptLine[]): void => {
		const themed = mode === "tui" && theme;
		let shown: TranscriptLine[] = visible;
		if (visible.length > tailLines) {
			const trimmed = visible.length - tailLines;
			shown = [
				{
					kind: "trim",
					text: trimNoticeText(trimmed),
					stageId: currentStageId,
					stageLabel: currentStageLabel,
				},
				...visible.slice(-tailLines),
			];
		}
		const bodyLines = shown.map((l) =>
			themed ? themeLine(l.kind, l.text, theme) : l.text,
		);
		onUpdate?.(bodyLines.join("\n"));
	};

	/**
	 * AC-03 (SCENARIO-010..013): render a STACK of per-stage sections via
	 * groupByStage — each a status-themed header + per-kind indented lines,
	 * with per-stage tail caps and a per-stage trim notice. Takes over once a
	 * real pipeline stage is known. The mode gate is unchanged: `mode === "tui"
	 * && theme` enables theming; EVERY other mode (and no-theme) emits RAW TEXT
	 * — byte-clean, zero ANSI (AC-08) — now structured as `▶ <label>` headers +
	 * two-space-indented logs.
	 */
	const flushSectionStack = (visible: TranscriptLine[]): void => {
		// Hot-path bound (PARTITION_INPUT_CAP): partition only a generous recent
		// WINDOW of the transcript. Completed stages already render COMPACT
		// (≤ COMPLETED_TAIL_LINES tail, or header-only via stageMeta synthesis),
		// so slicing never drops visible content — it only bounds the O(input)
		// partition cost on huge runs (the streaming hot path).
		const partitioned =
			visible.length > PARTITION_INPUT_CAP
				? visible.slice(-PARTITION_INPUT_CAP)
				: visible;
		// Partition into per-stage sections in FIRST-APPEARANCE order; each
		// group's status is resolved from the structured stage events captured
		// at the sink (injected as `statusOf` — no dashboard import, pure helper).
		const groups = groupByStage(partitioned, (id) => stageMeta.get(id)?.status);

		// SCENARIO-012: synthesize an empty group for every stage that emitted a
		// structured `stage` event but produced ZERO log lines — so its header
		// STILL renders (header-only for a completed stage). `stageMeta` is a Map,
		// so iteration follows stage-EVENT arrival order; stages absent from the
		// line-partitioned `groups` append here (a stage with no lines has no
		// natural line position, so appending is the faithful placement).
		for (const [id, meta] of stageMeta) {
			if (groups.some((g) => g.stageId === id)) continue;
			const empty: StageGroup = { stageId: id, stageLabel: meta.label, lines: [] };
			if (meta.status !== undefined) empty.status = meta.status;
			groups.push(empty);
		}

		const themed = mode === "tui" && theme;
		const themeArg = themed ? theme : undefined;

		// Render each section into its OWN string[] so the aggregate cap can drop
		// WHOLE leading sections — never slicing mid-section (which would leave
		// dangling indented lines with no header) and never dropping a header
		// while keeping its orphaned lines.
		const sections: string[][] = groups.map((group) => {
			const sec: string[] = [renderSectionHeader(group, themeArg)];

			// Per-stage tail budget: running (incl. unknown / pre-stage) shows a
			// generous recent tail; completed stages render COMPACT (header +
			// ≤ COMPLETED_TAIL_LINES tail, or header-only when empty).
			const isRunning =
				group.status === undefined || group.status === "running";
			const cap = isRunning ? RUNNING_TAIL_LINES : COMPLETED_TAIL_LINES;
			let sectionLines: { kind: LineKind; text: string }[] = group.lines;
			if (sectionLines.length > cap) {
				const trimmed = sectionLines.length - cap;
				// Per-stage trim notice appears INSIDE its own section (not a
				// single global preamble) — SCENARIO-011.
				sectionLines = [
					{ kind: "trim", text: trimNoticeText(trimmed, group.stageLabel) },
					...sectionLines.slice(-cap),
				];
			}
			// Each line is themed per-kind (TUI) or raw (non-TUI) and indented
			// TWO spaces under its header (SCENARIO-010).
			for (const line of sectionLines) {
				const rendered = themed
					? themeLine(line.kind, line.text, theme)
					: line.text;
				sec.push(`  ${rendered}`);
			}
			return sec;
		});

		// Aggregate cap (TOTAL_SECTION_CAP): drop WHOLE leading sections (the
		// oldest, typically completed) until the body fits, ALWAYS keeping at
		// least the final (live / running) section. The budget counts each rendered
		// line PLUS the blank separators actually EMITTED — there are
		// (sections−1) of those, NOT one per section (the prior accounting counted a
		// phantom trailing separator, inflating the budget by one).
		const sectionLens = sections.map((s) => s.length);
		let total =
			sectionLens.reduce((sum, n) => sum + n, 0) + Math.max(0, sections.length - 1);
		let start = 0;
		while (start < sections.length - 1 && total > TOTAL_SECTION_CAP) {
			total -= sectionLens[start]! + 1; // this section + the separator after it
			start++;
		}
		const bodyLines: string[] = [];
		for (let i = start; i < sections.length; i++) {
			if (i > start) bodyLines.push("");
			bodyLines.push(...sections[i]!);
		}

		onUpdate?.(bodyLines.join("\n"));
	};

	/** Render + emit the live body via `onUpdate`. Until the first structured
	 *  `stage` event arrives the run is in its pre-stage window and the legacy
	 *  rolling-tail body is emitted (preserving the AC-04/AC-05 + SCENARIO-015
	 *  byte-clean contract); once a stage is known the per-stage section stack
	 *  (SCENARIO-010..013) takes over. */
	const flush = (): void => {
		// The pending live buffer is included in the VISIBLE body (so the user
		// sees in-flight typing) but is NOT committed to the transcript.
		const pending: TranscriptLine[] = live
			? [
					{
						kind: "thinking",
						text: live,
						stageId: currentStageId,
						stageLabel: currentStageLabel,
					},
				]
			: [];
		const visible = [...transcript, ...pending];
		if (visible.length === 0) {
			onUpdate?.("");
			return;
		}
		if (!stageReceived) {
			flushRollingTail(visible);
			return;
		}
		flushSectionStack(visible);
	};

	/** Committed transcript (the un-finalized live buffer is excluded). */
	const getTranscript = (): TranscriptLine[] => transcript;

	/** AC-05 on-disk log: raw committed `text` joined by `\n` — grep-friendly,
	 *  zero ANSI, no kinds, no pending live buffer. */
	const diskLogText = (): string => transcript.map((l) => l.text).join("\n");

	/** AC-06: kind-carrying tail snapshot (default last 50 entries). Always
	 *  emits `{kind,text}` objects — never plain strings (SCENARIO-013). */
	const transcriptTail = (size: number = DEFAULT_TAIL_SNAPSHOT): TranscriptLine[] =>
		transcript.slice(-size);

	return { sink, finalizeLive, flush, getTranscript, diskLogText, transcriptTail };
}
