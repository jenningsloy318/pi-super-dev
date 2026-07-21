# Task List: Per-Stage Log Sections: Tag, Group, and Render Each Pipeline Stage as Its Own Themed Section

- **Date**: 2026-07-21
- **Status**: ✅ COMPLETE — all 27 tasks done (2026-07-22)

---

## Completion Summary

All 6 acceptance criteria delivered and merged to green. `npm run typecheck` strict-clean; `npm test` = 1361 passed / 0 failed (80 files). Phases 1–2 committed (`ea1f7c64`, `c550323b`); phases 3–6 + code-review fix round in working tree (uncommitted) pending final docs commit.

**Files created**
- `src/render/stage-grouping.ts` — pure `groupByStage` partitioner + `StageGroup` (AC-02)
- `tests/stage-grouping.test.ts` — 23 tests (AC-02)
- `tests/live-stream-per-stage.test.ts` — sink tagging in isolation (AC-01)
- `tests/live-stream-flush-sections.test.ts` — streaming per-stage sections + no-ANSI regression (AC-03)
- `tests/render/per-stage-result.test.ts` — `buildResultComponent` per-stage blocks (AC-04/AC-06)

**Files modified**
- `src/render/live-stream.ts` — widened `TranscriptLine`, `stage(info)` method, `flushSectionStack`, named caps (`RUNNING_TAIL_LINES=15`, `COMPLETED_TAIL_LINES=3`, `TOTAL_SECTION_CAP=400`, `PARTITION_INPUT_CAP=4000`)
- `src/render/stream-theme.ts` — new shared `statusFgToken(status)` export (single source of truth for status→color)
- `src/render/dashboard.ts` — `buildResultComponent` §1 per-stage block stack + per-stage `customBgFn` backgrounds; additive `ResultDetails.transcriptTail` widening
- `src/extension.ts` — single `stream.sink.stage(info)` wiring point (AC-05)
- `tests/render/real-theme-parity.test.ts` — per-stage parity case under `withRealTheme`

---

- [x] **Stage tagging at the sink**: In src/render/live-stream.ts, widen `TranscriptLine` additively to `{ kind: LineKind; text: string; stageId: string; stageLabel: string }`.
- [x] **Stage tagging at the sink**: Add `currentStageId`/`currentStageLabel` factory state defaulting to `"setup"`/`"pre-stage"`.
- [x] **Stage tagging at the sink**: Add `stage(info: { id: string; label: string; status?: string })` to the `LiveStreamSink` interface and the factory sink; it sets current stage id/label AND re-tags the most-recent transcript entry when it is a `phase` line whose label matches `info.label` (RESOLVED-1 fix).
- [x] **Stage tagging at the sink**: Stamp `stageId`/`stageLabel` on every push site: `phase`, `log`, `userInput`, and the `finalizeLive` thinking commit.
- [x] **Stage tagging at the sink**: Update `transcriptTail(size)` return type to the widened shape; ensure `getTranscript()`/`diskLogText()` stay correct.
- [x] **Stage tagging at the sink**: Add tests/live-stream-per-stage.test.ts driving the sink in isolation: pre-stage default tag, inherit-after-banner, implementation collapse, sink.stage re-tag of matching phase line.
- [x] **groupByStage pure partitioner**: Create src/render/stage-grouping.ts exporting `StageGroup = { stageId; stageLabel; status?; lines: Array<{kind,text}> }` and `groupByStage(transcript, statusOf?): StageGroup[]`.
- [x] **groupByStage pure partitioner**: Implement first-appearance-order partitioning; strip stage tags from emitted `lines`; coalesce untagged/string entries into one sentinel group ("setup"/"pre-stage"); return [] on empty.
- [x] **groupByStage pure partitioner**: Resolve each group `status` via injected `statusOf?: (stageId)=>string|undefined` (undefined when absent).
- [x] **groupByStage pure partitioner**: Create tests/stage-grouping.test.ts: ordering, all-one-stage, untagged fallback, empty, status lookup present/absent.
- [x] **Streaming per-stage sections in flush()**: Add named constants `RUNNING_TAIL_LINES = 15`, `COMPLETED_TAIL_LINES = 3`, `TOTAL_SECTION_CAP` in live-stream.ts.
- [x] **Streaming per-stage sections in flush()**: Rebuild `flush()` to build the visible list (committed transcript + pending live buffer), partition via `groupByStage`, then render a STACK of per-stage sections (header + per-kind indented lines + blank separator).
- [x] **Streaming per-stage sections in flush()**: Implement per-stage tail caps (running ≤ RUNNING_TAIL_LINES, completed ≤ COMPLETED_TAIL_LINES or header-only) and a per-stage `trim` notice inside each section.
- [x] **Streaming per-stage sections in flush()**: Theme headers by status method-style (running accent+bold+braille glyph via runningGlyph, ok success, failed error, skipped warning/dim) with a leading `▌` bar in the status color for TUI; non-TUI emits raw `▶ Stage N` + indented logs with zero ANSI.
- [x] **Streaming per-stage sections in flush()**: Extend tests/live-stream-per-stage.test.ts: TUI stack structure, running cap, completed compact, per-stage trim, and non-TUI zero-ANSI regression.
- [x] **buildResultComponent per-stage blocks**: Widen `ResultDetails.transcriptTail` in dashboard.ts additively to `Array<{ kind; text; stageId?; stageLabel? } | string>`.
- [x] **buildResultComponent per-stage blocks**: Build a `statusOf` resolver from `details.stages` (stageLabel→status) for groupByStage.
- [x] **buildResultComponent per-stage blocks**: Rebuild §1 into a stack of per-stage blocks (Container of Text): bold status-themed header + per-kind themed lines + per-stage background via Text 4th customBgFn (running toolPendingBg, ok toolSuccessBg, failed toolErrorBg, skipped none/dim).
- [x] **buildResultComponent per-stage blocks**: Expand failed/running blocks; render completed blocks compact (header + status + 1-line tail). Legacy tail → single-section fallback. Keep §2/§3 unchanged.
- [x] **buildResultComponent per-stage blocks**: Create tests/render/per-stage-result.test.ts: block stack, status glyph per status, per-child customBgFn via customBgFnOf, expand/compact, legacy fallback, §2/§3 unchanged.
- [x] **End-to-end threading + extension wiring**: In src/extension.ts `stage: (info) => {...}` handler, also call `stream.sink.stage(info)` to sync sink current-stage with the dashboard tracker.
- [x] **End-to-end threading + extension wiring**: In renderResult, pass `details.stages`-derived `statusOf` resolver into `buildResultComponent`; confirm transcriptTail now carries stage tags end-to-end.
- [x] **End-to-end threading + extension wiring**: Verify additive type still accepts legacy string entries and that change-tracker/deliverable/change/mid-run-input/scope-aware gates + Markdown §3 remain green.
- [x] **Tests, real-Theme parity, and full suite green**: Extend tests/stream-theme-class-theme.test.ts to cover buildResultComponent per-stage bg path (method-style theme.bg guard).
- [x] **Tests, real-Theme parity, and full suite green**: Extend tests/render/real-theme-parity.test.ts to run the new §1 builder under withRealTheme asserting no class-Theme throw.
- [x] **Tests, real-Theme parity, and full suite green**: Add non-TUI no-ANSI regression assertions for both flush and buildResultComponent.
- [x] **Tests, real-Theme parity, and full suite green**: Run `npm run typecheck` (strict-clean) and `npm test` (all green); add regression sentinels for dashboard widget, stream LineKinds/classification, scope-aware gate, deliverable/change gates, mid-run input, Markdown §3.
