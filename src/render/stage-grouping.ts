/**
 * Pure stage-grouping partitioner (AC-02 / SCENARIO-005..009).
 *
 * Dependency-free: imports ONLY the `LineKind` type (a type, erased at
 * runtime) from {@link stream-theme}. No dashboard, no theme, no control-flow
 * — fully unit-testable in isolation with synthetic transcripts. The status
 * resolver is INJECTED (`statusOf`) rather than imported so the helper never
 * reaches into the dashboard tracker, preserving purity.
 *
 * Contract:
 *   - Partitions tagged entries preserving FIRST-APPEARANCE stage order
 *     (later reappearances of an earlier stage coalesce back into that
 *     stage's single group, in original relative line order).
 *   - Strips the stage tag from every emitted `lines` element so callers
 *     consume only `{ kind, text }`.
 *   - Coalesces EVERY untagged OR string-shaped (legacy) entry into ONE
 *     sentinel fallback group (`stageId: "setup"`, `stageLabel: "pre-stage"`)
 *     — mirroring the Phase-1 sink's pre-banner defaults, so pre-stage tagged
 *     entries and legacy untagged entries resolve to the same section.
 *   - Returns `[]` for empty input.
 *   - Resolves each group's `status` via the injected `statusOf(stageId)`
 *     lookup; `undefined` when the tracker has no entry (status key left
 *     ABSENT to stay faithful to "unset when unknown").
 *   - Does NOT mutate its input.
 */
import type { LineKind } from "./stream-theme.js";

/** The tag-stripped line shape callers consume. */
export type GroupedLine = {
	kind: LineKind;
	text: string;
};

/** A partitioned per-stage section (one per distinct stage in first-appearance order). */
export type StageGroup = {
	stageId: string;
	stageLabel: string;
	/** Resolved from `statusOf(stageId)`; ABSENT when the tracker has no entry. */
	status?: string;
	lines: GroupedLine[];
};

/**
 * Maximally-permissive input element shape this partitioner tolerates:
 *   - fully-tagged objects (`{ kind, text, stageId, stageLabel }`)
 *   - partially-tagged objects (`stageId?` / `stageLabel?` absent)
 *   - plain legacy strings
 *
 * This mirrors the additive `TranscriptLine` widening (Phase 1) and the legacy
 * `transcriptTail: Array<{kind;text;stageId?;stageLabel?} | string>` tolerance
 * (Phase 4), so a single call site partitions every shape without a throw.
 */
export type GroupableEntry =
	| { kind: LineKind; text: string; stageId: string; stageLabel: string }
	| { kind: LineKind; text: string; stageId?: string; stageLabel?: string }
	| string;

/** Sentinel identity for untagged / legacy-string entries — identical to the
 *  Phase-1 sink's pre-banner `currentStageId` / `currentStageLabel` defaults,
 *  so pre-stage tagged entries and legacy untagged entries collapse together. */
const SENTINEL_STAGE_ID = "setup";
const SENTINEL_STAGE_LABEL = "pre-stage";

/** Default {@link LineKind} for legacy plain-string entries (which carry no
 *  kind metadata). `"log"` is the neutral per-kind default renderers theme as
 *  an ordinary log line. */
const DEFAULT_LINE_KIND: LineKind = "log";

/**
 * Partition a transcript into per-stage sections in FIRST-APPEARANCE order.
 *
 * @param transcript  The raw entries (tagged objects, partially-tagged
 *                    objects, or legacy strings) — NOT mutated.
 * @param statusOf    Optional injected status resolver keyed by `stageId`.
 *                    Pure by design: the helper never imports the dashboard
 *                    tracker. `undefined` (or an absent return) leaves a
 *                    group's `status` unset.
 * @returns `StageGroup[]` in first-appearance order (`[]` when empty input).
 */
export function groupByStage(
	transcript: readonly GroupableEntry[],
	statusOf?: (stageId: string) => string | undefined,
): StageGroup[] {
	// SCENARIO-008: empty input → empty partition (NOT a sentinel group),
	// regardless of whether a statusOf lookup was supplied.
	if (transcript.length === 0) return [];

	// Ordered groups + a stageId→index map so later reappearances of an
	// earlier stage coalesce back into that stage's existing group, preserving
	// first-appearance GROUP order while lines keep their original relative
	// order (SCENARIO-005).
	const groups: StageGroup[] = [];
	const groupIndexOf = new Map<string, number>();

	for (const entry of transcript) {
		let stageId: string;
		let stageLabel: string;
		let kind: LineKind;
		let text: string;

		if (typeof entry === "string") {
			// SCENARIO-007: plain legacy strings collapse into the sentinel
			// fallback group with a neutral default kind.
			stageId = SENTINEL_STAGE_ID;
			stageLabel = SENTINEL_STAGE_LABEL;
			kind = DEFAULT_LINE_KIND;
			text = entry;
		} else {
			// Missing stageId / stageLabel → same sentinel fallback so legacy
			// object entries coalesce with legacy strings AND pre-stage tagged
			// entries (SCENARIO-007).
			stageId =
				entry.stageId !== undefined ? entry.stageId : SENTINEL_STAGE_ID;
			stageLabel =
				entry.stageLabel !== undefined
					? entry.stageLabel
					: SENTINEL_STAGE_LABEL;
			kind = entry.kind;
			text = entry.text;
		}

		let idx = groupIndexOf.get(stageId);
		if (idx === undefined) {
			// First appearance of this stage → new group; its FIRST label
			// wins for the whole (possibly coalesced) group.
			idx = groups.length;
			groupIndexOf.set(stageId, idx);
			groups.push({ stageId, stageLabel, lines: [] });
		}
		// Strip the stage tag: callers consume only { kind, text }.
		groups[idx].lines.push({ kind, text });
	}

	// SCENARIO-009: resolve each group's status via the injected lookup,
	// keyed by stageId. Called exactly once per group (a coalesced stage is
	// resolved once, not once per line). When the tracker returns undefined
	// (or no lookup was supplied), the `status` key is left ABSENT so the
	// helper faithfully represents "status unknown".
	if (statusOf) {
		for (const group of groups) {
			const status = statusOf(group.stageId);
			if (status !== undefined) {
				group.status = status;
			}
		}
	}

	return groups;
}
