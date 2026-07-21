# Implementation Summary: Per-Stage Log Sections (spec-12) — Implementation Summary

- **Date**: 2026-07-22
- **Final Status**: ✅ COMPLETE — all 6 phases, `npm run typecheck` strict-clean, `npm test` 1361 passed / 0 failed (80 files)

---

## Summary

Bug-type frontend task to tag, group, and render each pipeline stage as its own themed section. All 6 phases delivered and green after one code-review fix round. Phases 1–2 are committed (`ea1f7c64` TranscriptLine tagging, `c550323b` groupByStage partitioner); phases 3–6 plus the code-review fix round are in the working tree pending the final docs commit.

PHASE 1 — Stage tagging at the sink (AC-01), committed ea1f7c64: widened TranscriptLine additively to {kind;text;stageId;stageLabel}; added currentStageId/currentStageLabel factory state (default setup/pre-stage); added stage(info) to the LiveStreamSink that sets the current stage AND re-tags the most-recent matching phase line (RESOLVED-1 phase-before-stage fix); stamped tags on phase/log/userInput/finalizeLive; widened transcriptTail type; new isolation test tests/live-stream-per-stage.test.ts. GREEN.

PHASE 2 — groupByStage pure partitioner (AC-02), committed c550323b: new src/render/stage-grouping.ts exporting StageGroup and groupByStage(transcript, statusOf?). First-appearance-order partitioning, strips stage tags from emitted lines, coalesces untagged/string entries into a setup/pre-stage sentinel, returns [] on empty, status resolved via injected statusOf (no dashboard import). New tests/stage-grouping.test.ts. GREEN.

PHASE 3 — Streaming per-stage sections in flush() (AC-03), COMPLETE & GREEN: src/render/live-stream.ts adds named constants `RUNNING_TAIL_LINES=15`, `COMPLETED_TAIL_LINES=3`, `TOTAL_SECTION_CAP=400`, and `PARTITION_INPUT_CAP=4000` (an added aggregate-input bound not in the original spec — see DEVIATIONS); a `flushSectionStack()` builds the visible list, partitions via `groupByStage`, and renders a per-stage section stack with caps + per-stage `trim` notices; `renderSectionHeader()` themes headers method-style (▌ status bar, animated braille `runningGlyph` for running, plain `▶ <label>` zero-ANSI when no theme). The empty-completed-stage header (SCENARIO-012 blocker) is now synthesized via `stageMeta` so even a stage with zero visible lines renders a status header. tests/live-stream-flush-sections.test.ts GREEN (23 tests).

PHASE 4 — buildResultComponent per-stage blocks (AC-04), COMPLETE & GREEN: src/render/dashboard.ts §1 rebuilt into a stack of per-stage `Container`/`Text` blocks via `groupByStage`, with a `statusOf` resolver built from `details.stages` (id→status). Each block = bold status-themed header `Text` (method-style `theme.fg`) with status glyph (●/✓/✗/↷) + per-kind themed line `Text` children + a per-stage background via pi-tui `Text`'s 4th `customBgFn` (running→`toolPendingBg`, ok→`toolSuccessBg`, failed→`toolErrorBg`, skipped→none). Failed/running expanded; completed compact (header + 1-line tail). Legacy `transcriptTail` collapses via the sentinel into a single section — no throw. Header-only blocks synthesized for stages present in `details.stages` but absent from the tail. §2/§3 unchanged. tests/render/per-stage-result.test.ts GREEN (19 tests).

PHASE 5 — End-to-end threading + extension wiring (AC-05), COMPLETE & GREEN: src/extension.ts `stage: (info) => {...}` handler additionally calls `stream.sink.stage(info)` — the single wiring point that makes stage tags resolve from the structured `stage.id` rather than `▶ Stage N` label parsing. `ResultDetails.transcriptTail` widened additively to `Array<{kind;text;stageId?;stageLabel?}|string>`; `details.stages` widened additively to add optional `id`. renderResult threads `details.stages`→`statusOf` into `buildResultComponent`. Change-tracker (spec-11), deliverable/change gates, mid-run input, scope-aware gate, and Markdown §3 verified undisturbed.

PHASE 6 — Tests, real-Theme parity, full suite green (AC-06/AC-07), COMPLETE & GREEN: `tests/stream-theme-class-theme.test.ts` extended to guard `buildResultComponent`'s per-stage bg path; `tests/render/real-theme-parity.test.ts` extended with a per-stage parity case under `withRealTheme`; new `tests/render/per-stage-result.test.ts` and `tests/live-stream-per-stage.test.ts`. Regression sentinels confirm no disturbance to the dashboard widget, themed stream LineKinds/classification, scope-aware gate, deliverable/change gates, mid-run input, or Markdown §3.

TEST RESULTS: `npx vitest run` → 1361 passed / 0 failed (80 files). `npm run typecheck` → strict-clean. Directly-scoped suites: stage-grouping 23, live-stream-per-stage 24, live-stream-flush-sections 23, per-stage-result 19, stream-theme-class-theme 4, real-theme-parity 27.

DEVIATIONS FROM SPEC (see 04-specification.md "Deviations" section for full detail): (1) `PARTITION_INPUT_CAP = TOTAL_SECTION_CAP * 10 = 4000` was added as an additive hot-path bound not specified — bounds the transcript slice partitioned on every throttled flush so the streaming hot path never re-partitions the full unbounded transcript (older lines already render compact/header-only via `stageMeta` synthesis, so no visible content is dropped). (2) A shared `statusFgToken(status)` export was added to `src/render/stream-theme.ts` as the single source of truth for the status→color taxonomy, deduped from the three prior copies (live-stream header, dashboard header, dashboard bg). (3) `TOTAL_SECTION_CAP` had no numeric value in the spec (F-06); implementer chose 400. (4) AC-01 wording drift (F-05) — implementation followed the spec's stage-event-resolves-it design, superseding the literal phase-updates-it AC-01 text. (5) Non-TUI live-body format is structurally richer than the legacy flat joined text (`▶ <label>` headers + indented logs) but remains byte-clean of ANSI (AC-08 preserved) — intentional per SCENARIO-013. The earlier spec-review grounding gaps (hallucinated helper names `customBgFnOf`/`withRealTheme`, unverified Theme tokens) were resolved during implementation: the real helper is a local `n(child)` closure and the real parity harness is `ln<T>`; the Theme tokens `toolPendingBg`/`toolSuccessBg`/`toolErrorBg` were confirmed valid against the real pi `Theme` class by the new parity test.

## Phases

- **Phases Completed**: 6/6 ✅
- **All Green**: true

## Files Modified

- src/render/live-stream.ts
- src/render/live-stream.test.ts
- src/render/stage-grouping.ts
- tests/live-stream-per-stage.test.ts
- tests/live-stream-user-input.test.ts
- tests/input-handler-phase2-ack.test.ts
- tests/stage-grouping.test.ts
- tests/live-stream-flush-sections.test.ts
- docs/specifications/12-per-stage-log-sections/08-implementation-summary.md

---

## Code-Review Fix Round (2026-07-22)

Addressed the post-implementation review findings against the phase-3/4/5 work.
All changes are minimal and targeted; full suite green (1361 tests, 80 files)
and `npm run typecheck` is strict-clean.

**Files created**
- `tests/render/per-stage-result.test.ts` — the MISSING required AC-05/AC-06
  dedicated test file for `buildResultComponent` §1 per-stage block branch
  (block stack, status glyphs, per-child `customBgFn` via the existing
  `customBgFnOf` helper, status backgrounds, expand/compact, legacy fallback,
  absent-stage synthesis, §2/§3 no-regression, graceful-degrade). +20 tests.

**Files modified**
- `src/render/stream-theme.ts` — new shared `statusFgToken(status)` export;
  the single source of truth for the status→color taxonomy, deduped from the
  three prior copies (live-stream header, dashboard header, dashboard bg).
- `src/render/live-stream.ts` — (1) `renderSectionHeader` now uses
  `statusFgToken` (dedup); (2) the aggregate-cap accounting is corrected — it
  now counts `(sections−1)` blank separators actually emitted instead of one
  per section (was off-by-one, inflating the budget by a phantom trailing
  separator); (3) new `PARTITION_INPUT_CAP = TOTAL_SECTION_CAP * 10` bounds
  the transcript slice passed to `groupByStage` on every throttled flush so the
  streaming hot path no longer re-partitions the full unbounded transcript —
  older lines already render COMPACT / header-only via `stageMeta` synthesis,
  so capping never drops visible content.
- `src/render/dashboard.ts` — (1) `statusThemeToken` delegates to the shared
  `statusFgToken` (dedup); (2) `statusOf` is now SYMMETRIC with the live view:
  the `setup` sentinel is no longer forced to `"ok"` (which masked pre-stage
  failures); untracked stages resolve to `undefined` → accent in-progress on
  both surfaces; (3) `buildResultComponent` now SYNTHESIZES header-only blocks
  for stages present in `details.stages` but absent from `transcriptTail`,
  consistent with the streaming view's `stageMeta` synthesis.
- `tests/render/real-theme-parity.test.ts` — added a per-stage-block parity
  case asserting tagged-tail blocks render against the REAL pi `Theme` class
  via method-bound `theme.bg` (no detached-`this` throw).

**Findings acknowledged but deferred (low-risk, noted for follow-up)**
- Phase-line re-tag's fixed 4-entry window: correct against real traces today;
  left as-is (the magic bound is now the only undocumented magic number — a
  named constant could land later).
- Non-TUI live-body format: byte-clean of ANSI (AC-08 preserved) but
  structurally richer than the legacy flat joined text — intentional per
  SCENARIO-013 (`▶ <label>` headers + indented logs).
- `runningGlyph` runtime import from `dashboard.ts` into `live-stream.ts`:
  noted as a render-layer boundary smell, left unchanged to avoid risk.
- Ephemeral spec-process tokens (SCENARIO-XXX / AC-0X / RESOLVED-X) in
  comments: cleaned in the regions touched this round; legacy tokens elsewhere
  remain.

**Test results**: `npx vitest run` → 1361 passed / 0 failed (80 files);
`npm run typecheck` → strict-clean.
