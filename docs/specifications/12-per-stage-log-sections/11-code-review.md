# Code Review: Code Review — Per-Stage Log Sections (spec-12)

- **Date**: 2025-01-01
- **Author**: super-dev:code-reviewer
- **Verdict**: Approved

---

## Verdict: Approved

The implementation faithfully realizes all seven acceptance criteria for rendering each pipeline stage as its own log section, with no Critical or High-severity defects. `npm run typecheck` is strict-clean and the full suite is green (80 files, 1361 tests), including the directly-scoped suites (stage-grouping 23, live-stream-per-stage 24, live-stream-flush-sections 23, per-stage-result 19, stream-theme-class-theme 4, real-theme-parity 27) and adjacent regression suites (dashboard, render). AC-01 widens `TranscriptLine` additively with `stageId`/`stageLabel`, stamps them at every push site (phase/log/userInput/finalizeLive), and adds a structured `stage(info)` method that resolves stage identity from `info.id` (never label parsing) plus a bounded re-tag scan to fix the phase-before-stage emit ordering. AC-02's `groupByStage` is a pure, dependency-free partitioner (first-appearance order, tag-stripping, sentinel coalescing for untagged/legacy strings, injected `statusOf`, empty→[]). AC-03 rebuilds `flush()` into a per-stage section stack with named tail caps (RUNNING_TAIL_LINES=15, COMPLETED_TAIL_LINES=3, TOTAL_SECTION_CAP=400, PARTITION_INPUT_CAP=4000), status-themed TUI headers (leading `▌`, animated braille for running) and byte-clean raw text in non-TUI. AC-04 rebuilds `buildResultComponent` §1 into status-themed bold header blocks with per-stage `customBgFn` backgrounds (toolPendingBg/Success/Error), failed/running expanded vs completed compact, and legacy fallback. AC-05 threads tags end-to-end via the single `stream.sink.stage(info)` wiring point. The CRITICAL theme constraint is honored everywhere (method-style `theme.fg/bg/bold` via local wrappers, never destructured), no new runtime deps were added, and backward compatibility for print/RPC/headless is preserved. Findings below are Medium/Low improvement-tier only.

## Findings

### M1: `hasStageTags` heuristic treats literal stageId "setup" as legacy, creating a live/result-view asymmetry

- **Severity**: Medium
- **File**: `src/render/dashboard.ts`
- **Line**: ~410 (hasStageTags)
In buildResultComponent, `const hasStageTags = tail.some((e) => typeof e !== "string" && e.stageId !== undefined && e.stageId !== "setup")`. The sink's pre-banner default is stageId "setup", so this exclusion is intended to detect the sentinel. However it creates two problems: (1) ASYMMETRY — the streaming `flushSectionStack` path uses `groupByStage` directly, which treats "setup" as a normal stage id and renders it as its own section header in the LIVE view, but the COMPLETED result view collapses any "setup"-tagged entries back into the single merged legacy block; (2) LATENT MISCLASSIFICATION — if any real pipeline stage ever carries id "setup" (custom skipStages run, a future stage, or a stage whose control-flow id is literally "setup"), its tagged lines are silently demoted to the legacy single-section view in renderResult while still rendering per-stage in the live stream. Failure scenario: a run where the only tagged lines are pre-stage (setup) logs renders the new per-stage UI live but reverts to the old merged dim log on completion — visually inconsistent. Suggested fix: derive hasStageTags from a positive signal, e.g. `details.stages?.some(s => s.id !== undefined)` OR `tail.some(e => typeof e !== "string" && e.stageId !== undefined)` and let groupByStage's sentinel handle the pre-stage coalescing uniformly on both surfaces. Confidence ~0.6.
### L1: Aggregate cap keeps the LAST section, not necessarily the RUNNING section

- **Severity**: Low
- **File**: `src/render/live-stream.ts`
- **Line**: flushSectionStack aggregate-cap loop
In flushSectionStack, the TOTAL_SECTION_CAP trim loop condition is `start < sections.length - 1`, guaranteeing only that the final section survives. The spec intent ("ALWAYS keeping at least the final (live / running) section") assumes the running stage is last. Because the stageMeta synthesis appends header-only blocks for stages that emitted a `stage` event but produced zero lines, an empty COMPLETED stage can be appended AFTER the running stage, so under cap pressure the running stage could be dropped while a completed empty-stage header is retained. In practice the running stage receives the latest log lines so it is almost always last; this is an edge case. Suggested fix: when trimming, prefer retaining the section whose status is "running" (or undefined) over a trailing completed-empty synthesized block.
### L2: Phase-line re-tag scan window is hardcoded to 4 entries

- **Severity**: Low
- **File**: `src/render/live-stream.ts`
- **Line**: sink.stage re-tag loop
`sink.stage` scans back only `Math.max(0, transcript.length - 4)` entries to find and re-tag the most-recent matching phase line (RESOLVED-1 phase-before-stage ordering fix). If control-flow ever emits more than 4 transcript entries between `phase(label)` and `stage:{running}` (e.g. several rapid log commits or a thinking commit plus logs), the phase line will not be re-tagged and will inherit the PREVIOUS stage's id, misattributing that stage banner. The comment acknowledges the bounded window. Acceptable given the currently observed emit ordering (phase immediately precedes stage), but fragile if emit ordering changes. Suggested fix: scan back to the last phase line unconditionally (or to a more generous bound) and stop at the first entry already tagged with info.id.
### L3: Duplicated sentinel constants across stage-grouping and live-stream

- **Severity**: Low
- **File**: `src/render/stage-grouping.ts`
- **Line**: SENTINEL_* constants
`stage-grouping.ts` defines `SENTINEL_STAGE_ID = "setup"` / `SENTINEL_STAGE_LABEL = "pre-stage"` while `live-stream.ts` independently hardcodes the identical defaults (`currentStageId = "setup"`, `currentStageLabel = "pre-stage"`) and `dashboard.ts` repeats the "setup" literal in hasStageTags. The sentinel-coalescing contract relies on all three staying in sync; if one drifts, pre-stage tagged entries and legacy untagged entries silently stop coalescing. Suggested fix: export SENTINEL_STAGE_ID/SENTINEL_STAGE_LABEL from stage-grouping.ts and reuse at every site (including the hasStageTags check in M1).
### L4: PARTITION_INPUT_CAP window-slicing can shift a stage's first-appearance header position across flushes

- **Severity**: Low
- **File**: `src/render/live-stream.ts`
- **Line**: flushSectionStack partition
flushSectionStack slices `visible.slice(-PARTITION_INPUT_CAP)` (last 4000) before calling groupByStage. groupByStage assigns section order by FIRST APPEARANCE within the partitioned input, so for a very long run a stage whose earliest lines predate the 4000-line window will have its header position computed from within the window; as the window slides on subsequent flushes the header can appear to jump position. This is purely cosmetic (content is never dropped — completed stages render compact and the running tail is preserved) and only manifests on runs producing thousands of lines. No action required for correctness; noted for awareness.
