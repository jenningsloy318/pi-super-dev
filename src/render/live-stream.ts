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

import type { DashboardTheme } from "./dashboard.js";
import { classifyLine, themeLine } from "./stream-theme.js";
import type { LineKind } from "./stream-theme.js";

/**
 * One committed transcript entry. `kind` is the classified content taxonomy
 * value; `text` is the RAW (un-themed, un-indented) line text — the disk log
 * and every non-TUI body render this field byte-for-byte.
 */
export type TranscriptLine = { kind: LineKind; text: string };

/** The minimal sink surface the factory owns (phase / log / text). The
 *  optional `stage` dashboard event stays in `extension.ts`. */
export interface LiveStreamSink {
	phase(label: string): void;
	log(message: string): void;
	text(partial: string): void;
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

/**
 * Default rolling-tail window. A full run (100+ agents) produces thousands of
 * transcript lines; the live display keeps only the CURRENT activity visible
 * and the full log is persisted to disk at run end so nothing is lost.
 */
const DEFAULT_TAIL_LINES = 400;

/** Default tail size for the final `transcriptTail` snapshot (AC-06). */
const DEFAULT_TAIL_SNAPSHOT = 50;

/**
 * Create a live-stream handle. The transcript starts empty; the sink is the
 * ONLY classification entry point; the live body is themed per-kind in TUI mode
 * and emitted raw in every other mode (AC-05 byte-clean contract).
 */
export function createLiveStream(opts: CreateLiveStreamOptions = {}): LiveStreamHandle {
	const onUpdate = opts.onUpdate;
	const mode = opts.mode;
	const theme = opts.theme;
	const tailLines = opts.tailLines ?? DEFAULT_TAIL_LINES;

	const transcript: TranscriptLine[] = [];
	let live = "";

	/** Commit any pending live buffer as a `{thinking}` line (SCENARIO-008). */
	const finalizeLive = (): void => {
		if (live) {
			transcript.push({ kind: "thinking", text: live });
			live = "";
		}
	};

	const sink: LiveStreamSink = {
		// SCENARIO-008: phase marker carries the ▶ prefix text.
		phase: (label: string): void => {
			finalizeLive();
			transcript.push({ kind: "phase", text: `▶ ${label}` });
		},
		// SCENARIO-008: log is classified by the single classifyLine authority;
		// the RAW message is stored as text (no leading indent — classification
		// trims leading whitespace itself).
		log: (message: string): void => {
			finalizeLive();
			transcript.push({ kind: classifyLine(message), text: message });
		},
		// Live (typing) buffer — NOT committed until finalizeLive().
		text: (partial: string): void => {
			live = partial;
		},
	};

	/** Render a sequence of lines into the mode-aware body string.
	 *  TUI + theme → per-kind themed; otherwise raw `line.text` joined by `\n`. */
	const renderBody = (lines: TranscriptLine[]): string => {
		const themed = mode === "tui" && theme;
		return lines
			.map((l) => (themed ? themeLine(l.kind, l.text, theme) : l.text))
			.join("\n");
	};

	/** SCENARIO-009: rolling tail + trim-notice. Emits the body via onUpdate. */
	const flush = (): void => {
		// The pending live buffer is included in the VISIBLE body (so the user
		// sees in-flight typing) but is NOT committed to the transcript.
		const pending: TranscriptLine[] = live ? [{ kind: "thinking", text: live }] : [];
		const visible = [...transcript, ...pending];
		let display = visible;
		if (visible.length > tailLines) {
			const trimmed = visible.length - tailLines;
			const notice: TranscriptLine = {
				kind: "trim",
				text: `… ${trimmed} earlier lines trimmed (full log saved at run end) …`,
			};
			display = [notice, ...visible.slice(-tailLines)];
		}
		onUpdate?.(renderBody(display));
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
