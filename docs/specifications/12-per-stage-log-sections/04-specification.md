# Specification: Per-Stage Log Sections: Tag, Group, and Render Each Pipeline Stage as Its Own Themed Section

- **Date**: 2026-07-21

---

## Summary

Render each pipeline STAGE as its OWN log section instead of merging all stage logs into one flat rolling transcript. Today stage titles are themed but every stage's lines collapse into one onUpdate text blob (streaming) and one merged dim `── detail log ──` block (renderResult §1). This change (1) tags every transcript entry with its stage at the sink, (2) adds a pure `groupByStage` partitioner preserving first-appearance order, (3) rebuilds the streaming `flush()` to emit a TUI stack of per-stage sections (status-colored headers + per-kind indented logs + per-stage tail caps) and raw byte-clean text in non-TUI, (4) rebuilds `buildResultComponent` §1 into a stack of per-stage blocks with status-themed bold headers + per-kind lines + a status-colored BACKGROUND via pi-tui Text's 4th `customBgFn` arg (mirroring pi-native tool-call bubbles), and (5) threads stage tags end-to-end through `details.transcriptTail`. Pure TS change to THIS repo (pi-super-dev). No new runtime deps; no control-flow / change-tracker / backend / dashboard-widget changes. Backward compatible: non-TUI output is zero-ANSI byte-clean; legacy `transcriptTail` shapes fall back to today's single-section behavior.

## Architecture

The system is a 13-stage pi extension pipeline whose live-stream rendering is split across three pure modules: `src/render/live-stream.ts` (the transcript sink + mode-aware flush factory), `src/render/stream-theme.ts` (the classification + theming authority), and `src/render/dashboard.ts` (the widget + final result composition). The control-flow engine (`src/nodes.ts`) emits two adjacent events per stage — `ctx.events.emit("phase", stage.label)` immediately followed by `ctx.events.emit("stage", {id,label,status:"running"})` — and `src/extension.ts` wires both into the sink. This change touches ONLY the three render modules + the extension wiring; it does not alter control-flow emit sites, the change-tracker (spec-11), backend selection, or the aboveEditor dashboard widget.

THEME SAFETY CONTRACT (foundational, applies everywhere): the real pi `Theme` is a class whose `fg()`/`bg()` read `this.fgColors`/`this.bgColors`. Every existing accessor already wraps method-style via local `bold`/`fg` closures (e.g. `const fg = (c,t) => theme.fg(c,t)`). All NEW theme access — every status header color, every status background — must follow the SAME pattern: never `const {fg} = theme`. The `commandBackground` helper already proves the public `Text(content,0,0,customBgFn)` 4th-arg API works against a real class Theme, so the per-stage status background reuses that exact pattern.

DESIGN PILLAR 1 — Stage tagging at the sink (AC-01). The `TranscriptLine` shape in `live-stream.ts` widens additively to `{ kind: LineKind; text: string; stageId: string; stageLabel: string }`. The factory gains a `currentStageId`/`currentStageLabel` pair defaulting to `"setup"`/`"pre-stage"` before the first banner. The `LiveStreamSink` interface gains a new `stage(info: {id,label,status?})` method that (a) sets the current stage id/label from the STRUCTURED dashboard `stage` event (NOT by parsing the `▶ Stage N` label), and (b) RE-TAGS the most-recent transcript entry when it is a `phase` line whose label matches `info.label`. This re-tag is the recommended fix for the emit ordering proven in research RESOLVED-1: because `phase` (nodes.ts L123) fires strictly BEFORE `stage:{running}` (L127), a phase line pushed by `sink.phase` would otherwise inherit the PREVIOUS `currentStageId`; the sink-side re-tag in `sink.stage` corrects exactly that one most-recent phase entry with zero control-flow change. Implementation sub-phases (TDD red/green/refactor banners, etc.) emit only `phase` lines and inherit `currentStageId="implementation"` automatically — no collapse map is needed (research RESOLVED-2), satisfying the "don't over-engineer" directive by construction. Every push site — `phase`, `log`, `userInput`, and the `finalizeLive` thinking commit — stamps the current `stageId`/`stageLabel`.

DESIGN PILLAR 2 — Pure groupByStage partitioner (AC-02). A new dependency-free module `src/render/stage-grouping.ts` exports `groupByStage(transcript, statusOf?: (stageId) => string | undefined): StageGroup[]` where `StageGroup = { stageId; stageLabel; status?; lines: Array<{kind,text}> }`. It partitions tagged entries preserving FIRST-APPEARANCE stage order, strips the stage tag from each emitted `lines` element (callers consume only `{kind,text}`), coalesces every untagged or string-shaped entry into ONE fallback sentinel group (`stageId:"setup"`, `stageLabel:"pre-stage"`), returns `[]` for empty input, and resolves each group's `status` (running/ok/failed/skipped) via the optional `statusOf` lookup keyed by `stageId` — `undefined` when the tracker has no entry. The lookup is injected (not imported) so the pure helper stays unit-testable in isolation, mirroring the existing pure-helper discipline in `stream-theme.ts`.

DESIGN PILLAR 3 — Streaming per-stage sections (AC-03). `flush()` is rebuilt. It first builds the visible list (committed transcript + the un-finalized live `thinking` buffer, as today), then partitions it via `groupByStage`, then renders a STACK of per-stage sections. Each section is a status-themed header line followed by that stage's lines themed per-kind via `themeLine` and indented two spaces, with a blank line between sections. Per-stage tail budgets are named constants: `RUNNING_TAIL_LINES = 15`, `COMPLETED_TAIL_LINES = 3`, plus a `TOTAL_SECTION_CAP` bounding aggregate cost so flush stays O(visible lines). The RUNNING stage shows up to `RUNNING_TAIL_LINES` recent lines; COMPLETED stages render COMPACT (header + ≤`COMPLETED_TAIL_LINES` tail, or header-only when empty). When a stage's visible tail is trimmed, its OWN `trim` notice (kind `trim`) is prepended inside that section — never a single global notice. Header theming by status uses method-style wrappers: running → `theme.fg("accent", bold(label))` with the animated braille glyph (via `runningGlyph(Math.floor(Date.now()/100))`); ok → `theme.fg("success",...)`; failed → `theme.fg("error",...)`; skipped → `theme.fg("warning",...)`. In TUI each section header carries a leading `▌` bar in the status color for subtle visual distinction. The mode gate is unchanged: `mode === "tui" && theme` enables theming; EVERY other mode (print/json/RPC/headless, or no theme) emits RAW TEXT — plain `▶ Stage N` headers + indented logs, ZERO ANSI bytes (preserving the AC-08 no-leak byte-clean contract).

DESIGN PILLAR 4 — renderResult per-stage blocks (AC-04, the high-impact surface). `buildResultComponent` §1 is rebuilt from a single dim log into a STACK of per-stage blocks via `groupByStage`, with a status resolver built from `details.stages` (mapped id→status; the dashboard tracker's canonical key). Each block is a `Container` of `Text` children: (a) a BOLD header `Text` themed by STATUS via method-style `theme.fg(...)` and prefixed with a status glyph — e.g. `● Stage 9 — Implementation` (running), `✓` (ok), `✗` (failed), `↷` (skipped); (b) the stage's log lines as `Text` children themed per-kind via `themeLine`; (c) a per-stage BACKGROUND applied through pi-tui `Text`'s 4th `customBgFn` arg colored by status — running → `theme.bg("toolPendingBg", _)`, ok → `theme.bg("toolSuccessBg", _)`, failed → `theme.bg("toolErrorBg", _)`, skipped → none/dim — mirroring pi-native's tool-call bubbles using ONLY the public `Text` customBgFn API (no internal pi-core imports). Failed and running stages render EXPANDED (full per-kind line list); completed stages render COMPACT (header + status + a one-line tail) so the final report is scannable and foregrounds active/failed work. Legacy `transcriptTail` entries (missing `stageId`/`stageLabel`, or plain `string` entries) collapse via `groupByStage`'s sentinel fallback into a SINGLE section — exactly today's merged dim block — with no throw. §2 (stage progress) and §3 (Markdown summary) are UNCHANGED.

DESIGN PILLAR 5 — End-to-end threading + additive types (AC-05). In `src/extension.ts`, the existing `stage: (info) => { ...dashboardStages.set(...) ... }` handler additionally calls `stream.sink.stage(info)` so the sink's current-stage state stays synchronized with the dashboard tracker (and re-tags the matching phase line). `ResultDetails.transcriptTail` in `dashboard.ts` widens ADDITIVELY to `Array<{ kind: LineKind; text: string; stageId?: string; stageLabel?: string } | string>` — optional fields + string tolerance keep every legacy caller strict-clean. The `renderResult` path threads `details.stages` (already built from `dashboardOrder` → `dashboardStages`) as the status resolver into `buildResultComponent`. The change-tracker (spec-11), deliverable/change gates, mid-run input handling, scope-aware gate, and Markdown §3 are orthogonal and untouched.

NON-GOALS (explicitly out of scope): no interactive collapse/expand (Ctrl+O) — static compact-completed/expanded-running suffices (interactive expand noted as future); no control-flow, change-tracker, or backend changes; no dashboard-widget (aboveEditor) changes — it already shows per-stage status.

## Testing Strategy

The change follows the repo's pure-helper testing discipline: pure modules (`stage-grouping.ts`, `stream-theme.ts`, `dashboard.ts`) are unit-tested with lightweight structural theme mocks, and the real pi `Theme` class is exercised ONLY through the parity guard `tests/helpers/real-theme.ts#withRealTheme`. Tests are layered by acceptance criterion and cross-reference BDD scenarios.

UNIT — groupByStage (AC-02, SCENARIO-005..009): a new `tests/stage-grouping.test.ts` asserts (1) groups appear in first-appearance order, each containing only that stage's `{kind,text}` lines; (2) an all-one-stage transcript yields exactly one group; (3) untagged/legacy entries (missing `stageId`, or plain strings) collapse into the single sentinel fallback group; (4) empty input → `[]`; (5) `status` is resolved from the injected `statusOf` lookup where present, `undefined` otherwise.

UNIT — stage tagging at the sink (AC-01, SCENARIO-001..004): a new `tests/live-stream-per-stage.test.ts` drives the factory sink through `phase`/`log`/`text`/`userInput`/`stage` events in isolation (no `execute`, no spawned pi children) and asserts pre-stage entries carry the default `"setup"`/`"pre-stage"` tag, subsequent entries inherit the current stage until the next `stage` event, implementation `phase` sub-banners collapse to the `"implementation"` stageId, and the `sink.stage` re-tag corrects the most-recent phase line for the phase-before-stage emit ordering.

UNIT — streaming flush per-stage sections (AC-03, SCENARIO-010..013): asserts the TUI flush emits a STACK of per-stage sections (status-themed header + per-kind indented lines + blank separator), the running stage honors `RUNNING_TAIL_LINES` (~15), completed stages honor `COMPLETED_TAIL_LINES` (~3) or render header-only, per-stage `trim` notices appear inside their own section, and — critically for the AC-08 no-leak contract — a non-TUI flush (mode!=="tui" or no theme) emits RAW TEXT with ZERO ANSI escape bytes (asserted by scanning the output for `\x1b`).

UNIT — buildResultComponent per-stage blocks (AC-04, SCENARIO-014..018): a new `tests/render/per-stage-result.test.ts` asserts §1 is a stack of per-stage blocks, each block's header carries the correct status glyph/token, each block's Text children carry a background `customBgFn` (running→toolPendingBg, ok→toolSuccessBg, failed→toolErrorBg, skipped→none), failed/running blocks are expanded while completed blocks are compact, and legacy `transcriptTail` (string entries / missing stage tags) falls back to a single merged section without throwing. The existing `customBgFnOf(child)` parity helper (already used for command-bubble assertions) is reused to read the 4th-arg background function per child Text.

REAL-THEME PARITY + CLASS-THEME GUARD (AC-06, SCENARIO-022..023): the new per-stage §1 section test runs under `withRealTheme` and asserts no `reading 'fgColors'/'bgColors'` throw — proving every new status-bg call is method-style. `tests/stream-theme-class-theme.test.ts` (which guards `commandBackground`→`theme.bg` at L67) is EXTENDED to also cover `buildResultComponent`'s new per-stage bg path so any future destructuring regression is caught. `tests/render/real-theme-parity.test.ts` stays green.

NO-ANSI REGRESSION: explicit non-TUI assertions for BOTH `flush` and `buildResultComponent` (the latter exercised via a no-theme call) confirm byte-clean output.

FULL SUITE GREEN (AC-07, SCENARIO-024): `npm run typecheck` must be strict-clean (additive type widening must not break legacy callers) and `npm test` must pass existing + new. Regression sentinels confirm NO disturbance to: the dashboard widget (aboveEditor), themed stream LineKinds/classification (`classifyLine`/`themeLine`/`commandBackground`), scope-aware gate, deliverable/change gates, mid-run input handling, and Markdown §3. Per-stage tail budgets are named constants guaranteeing flush/render cost stays O(visible lines) and never grows unbounded, with the existing throttles (`FLUSH_MS=80`, `WIDGET_MS=200`) preserved.

## BDD Scenario References

- SCENARIO-001
- SCENARIO-002
- SCENARIO-003
- SCENARIO-004
- SCENARIO-005
- SCENARIO-006
- SCENARIO-007
- SCENARIO-008
- SCENARIO-009
- SCENARIO-010
- SCENARIO-011
- SCENARIO-012
- SCENARIO-013
- SCENARIO-014
- SCENARIO-015
- SCENARIO-016
- SCENARIO-017
- SCENARIO-018
- SCENARIO-019
- SCENARIO-020
- SCENARIO-021
- SCENARIO-022
- SCENARIO-023
- SCENARIO-024

---

## Deviations from Specification (recorded 2026-07-22, post-code-review)

All deviations are additive, low-risk, and backward-compatible. None change control-flow, the change-tracker, backend selection, or the dashboard widget.

### D1: Added `PARTITION_INPUT_CAP` (additive hot-path bound, not in spec)
- **Original text (Pillar 3 / AC-03)**: "a `TOTAL_SECTION_CAP` bounding aggregate cost so flush stays O(visible lines)". Only `RUNNING_TAIL_LINES`, `COMPLETED_TAIL_LINES`, and `TOTAL_SECTION_CAP` were specified.
- **Changed text**: Added `PARTITION_INPUT_CAP = TOTAL_SECTION_CAP * 10 = 4000`, and `flushSectionStack` slices `visible.slice(-PARTITION_INPUT_CAP)` before calling `groupByStage`.
- **Reason**: On every throttled flush the hot path previously re-partitioned the full unbounded transcript. The cap bounds the slice passed to the pure partitioner so flush cost is bounded by `PARTITION_INPUT_CAP`, not transcript size.
- **Impact**: None visible. Older lines already render COMPACT / header-only via the `stageMeta` synthesis (D2), so capping never drops visible content. Cosmetic-only edge case noted in code-review L4: for very long runs a stage whose earliest lines predate the 4000-line window can have its header position computed from within the sliding window.

### D2: Shared `statusFgToken(status)` export (dedup, not in spec)
- **Original text (Pillars 3 & 4)**: Status→color mapping was specified inline per call site (live-stream header, dashboard header, dashboard bg).
- **Changed text**: New `export function statusFgToken(status: string | undefined): string` in `src/render/stream-theme.ts` is the single source of truth; `live-stream.ts` `renderSectionHeader` and `dashboard.ts` `statusThemeToken` both delegate to it.
- **Reason**: Avoid three copies of the status→color taxonomy drifting out of sync.
- **Impact**: Identical behavior; strictly less duplication. Reduces the risk surfaced by code-review L3.

### D3: `TOTAL_SECTION_CAP` value chosen = 400
- **Original text (spec F-06)**: "a `TOTAL_SECTION_CAP` bounding aggregate cost" with no numeric value.
- **Changed text**: `export const TOTAL_SECTION_CAP = 400`.
- **Reason**: Spec left the value open (F-06); 400 is a generous bound for the live view's aggregate rendered cost while comfortably accommodating realistic stage counts.
- **Impact**: Bounds the live stack; the running stage tail is always retained, completed stages render compact. No content loss.

### D4: AC-01 wording drift (F-05, design supersedes literal text)
- **Original text (AC-01)**: Described the phase banner as the trigger that updates the current stage.
- **Changed text**: Implementation resolves stage identity from the STRUCTURED `stage` event via `sink.stage(info)` (the single `extension.ts` wiring point), with a bounded re-tag scan fixing the phase-before-stage emit ordering (research RESOLVED-1).
- **Reason**: The spec body (Pillar 1) and research RESOLVED-1 already prescribed this design; the literal AC-01 wording was the older phrasing. Following the body's design was correct and is what the tests assert.
- **Impact**: None. Behavior matches the spec body; only the literal AC-01 phrasing was not retroactively amended.

### D5: Non-TUI live body structurally richer than legacy flat text
- **Original text (SCENARIO-013 / AC-08)**: Non-TUI output must be byte-clean of ANSI.
- **Changed text**: Non-TUI `flush` emits plain `▶ <label>` headers + indented per-kind logs (a sectioned structure) instead of a single flat joined string.
- **Reason**: Intentional per SCENARIO-013 — the sectioning improves readability while remaining ZERO ANSI bytes.
- **Impact**: The AC-08 no-leak byte-clean contract is preserved (asserted by `` scan). Structural change only; print/RPC/headless callers still receive clean text.

### D6: `ResultDetails.stages` widened additively with optional `id`
- **Original text (Pillar 5)**: The `statusOf` resolver was keyed by stage id, but the documented `details.stages` type was `{ label, status }` with NO `id`.
- **Changed text**: `stages?: Array<{ id?: string; label: string; status: string }>` (additive optional `id`); `extension.ts` build of `details.stages` now carries `id`.
- **Reason**: Without the `id` the id→status resolver used by AC-04's per-stage blocks could not resolve. The widening is additive so legacy callers stay strict-clean.
- **Impact**: None to existing callers; enables the AC-04 per-stage background resolution.

### Deferred findings (low-risk, noted for follow-up, not deviations)
- **M1 / L1**: `hasStageTags` heuristic and the aggregate-cap "keep last section" logic are edge-case-tolerant; code-review recommended deriving `hasStageTags` from a positive `details.stages` signal and preferring the running section under cap pressure. Left as-is this round (real runs almost always end on the running stage).
- **L2**: `sink.stage` re-tag scan window hardcoded to 4 entries — correct against observed emit ordering; a named constant / unconditional scan-back was recommended for robustness if control-flow emit ordering changes.
- **Interactive collapse/expand (Ctrl+O)**: Explicitly out of scope (NON-GOALS); static compact-completed / expanded-running suffices.
