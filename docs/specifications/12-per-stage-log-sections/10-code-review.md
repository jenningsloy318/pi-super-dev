# Code Review: Per-stage log sections — incomplete implementation (Phases 4 & 5 missing; Phase 3 unreachable in production)

- **Date**: 2025-07-21
- **Author**: super-dev:code-reviewer
- **Verdict**: Blocked

---

## Verdict: Blocked

The implementation lands only 2 of 6 phases correctly. Phase 1 (AC-01: tag TranscriptLine at sink) and Phase 2 (AC-02: groupByStage pure partitioner) are committed and solid — groupByStage is dependency-free, order-preserving, sentinel-coalescing, and its tests pass. Phase 3 (AC-03: per-stage flush sections) is present in the working tree but is DEAD CODE in production: the single wiring point the spec calls out — extension.ts `stage:` handler calling `stream.sink.stage(info)` — was never added (Phase 5). As a result `stageReceived` stays false, `flush()` always takes the legacy `flushRollingTail` path, the section stack never renders, and every transcript entry is tagged with the sentinel `stageId:"setup"` regardless of the real stage. Phase 4 (AC-04, the explicitly "high-impact surface") is entirely absent: dashboard.ts is byte-for-byte unchanged — §1 is still the single merged `── detail log (last 50 lines) ──` dim block, ResultDetails.transcriptTail was NOT widened to carry stageId/stageLabel, and the required tests/render/per-stage-result.test.ts does not exist. One committed test fails (SCENARIO-012: empty completed stages silently dropped). npm run typecheck is strict-clean; npm test is 1340/1341. Security: no concerns (pure rendering, no external input). Correctness of what IS shipped is good except the empty-stage drop and the TOTAL_SECTION_CAP splice edge. Verdict: Blocked — two Critical acceptance-criteria gaps (AC-03 unreachable end-to-end, AC-04 not implemented) plus a failing test.

## Findings

### F1: Phase 5 wiring missing — sink.stage() is never called, making the entire Phase 3 section stack unreachable in production (AC-03 Not Met end-to-end)

- **Severity**: Critical
- **File**: `src/extension.ts`
- **Line**: 381-386
extension.ts:381-386 defines the `stage: (info) => {...}` handler but it ONLY touches dashboardOrder/dashboardStages and calls renderDashboard(). It never calls `stream.sink.stage(info)`, which is the single wiring point the spec mandates ('the single wiring point that makes stage tags resolve from the structured stage.id rather than label parsing'). Consequence chain: (1) the factory's `stageReceived` flag stays false for the whole run; (2) `flush()` therefore always branches into `flushRollingTail` (legacy rolling-tail body) and NEVER calls `flushSectionStack`; (3) the entire AC-03 per-stage streaming render (status-colored headers, ▌ bars, per-stage tail caps, per-stage trim) is dead code in the real pipeline — only the unit tests (which drive the sink directly) exercise it; (4) `currentStageId` is never updated from its `"setup"` default, so EVERY transcript entry — phase, log, thinking, user-input — is tagged `stageId:"setup", stageLabel:"pre-stage"` regardless of actual stage, and `stageStatus` is never populated. Fix: in the stage handler, add `stream.sink.stage(info);` (and re-verify the phase-line re-tag still fires, since control-flow emits phase before stage:{running}). This is the highest-priority fix; without it AC-01/AC-03/AC-05 are all unmet end-to-end.
### F2: Phase 4 not implemented — buildResultComponent §1 is still the single merged dim log; the spec's 'high-impact surface' is absent (AC-04 Not Met)

- **Severity**: Critical
- **File**: `src/render/dashboard.ts`
- **Line**: 370-385
src/render/dashboard.ts is byte-for-byte unchanged versus main (git diff main is empty). §1 at line 376 still emits one `── detail log (last 50 lines) ──` dim header followed by a flat loop over details.transcriptTail with per-kind themeLine + commandBackground. There are NO per-stage blocks, NO status-themed bold headers, NO status glyphs (●/✓/✗/↷), NO per-stage customBgFn background via toolPendingBg/toolSuccessBg/toolErrorBg, NO expand/compact behavior. ResultDetails.transcriptTail (dashboard.ts:320) was NOT widened additively to `Array<{kind;text;stageId?;stageLabel?}|string>` — it is still `Array<{kind;text}|string>`, so even if stage tags were threaded end-to-end, buildResultComponent could not read them. The spec-required tests/render/per-stage-result.test.ts does not exist. The spec labels this surface 'the pi-native bubble look; the high-impact surface.' Fix: rebuild §1 via groupByStage(details.transcriptTail, statusOf) where statusOf is built from details.stages (mapped stageLabel→status), each group a Container of Text children (bold status-themed header + per-kind themed lines + status-colored customBgFn), failed/running expanded and completed compact, with the legacy sentinel falling back to one merged section.
### F3: Failing test / correctness bug: stages with zero log lines are silently dropped from the section stack (SCENARIO-012 fails)

- **Severity**: High
- **File**: `src/render/live-stream.ts`
- **Line**: flushSectionStack
npm test fails 1/1341 at tests/live-stream-flush-sections.test.ts:261. The test drives a stage ({id:'research', label:'EmptyCompleted', status:'ok'}) that emits NO log/phase lines, then a later running stage; it expects the empty completed stage's header to still render ('header + status only'). It does not — only 'ImplB' appears. Root cause: groupByStage partitions strictly on transcript ENTRIES. Stage-transition events (sink.stage) only mutate currentStageId/stageStatus; they push nothing into the transcript. A stage that produced zero entries therefore yields zero groups and vanishes. Spec requirement #3 explicitly allows completed stages to render 'header + status only', so the test is correct and the implementation is wrong. Fix: in flushSectionStack, after groupByStage, seed empty groups for any observed stage (tracked by the stageStatus Map keys — those are exactly the stages the sink was told about) that produced no lines, OR pass an observed-stage list into the grouping so empty stages get a header-only section.
### F4: Even after Phase 4 lands, end-to-end grouping at renderResult would collapse to one section without the Phase 5 wiring

- **Severity**: High
- **File**: `src/extension.ts`
- **Line**: 438
renderResult builds details.transcriptTail from stream.transcriptTail(). Because of F1, every entry carries stageId:'setup', so groupByStage would return a SINGLE 'setup/pre-stage' group regardless of how many real stages ran — i.e. the renderResult §1 'per-stage blocks' would visually be one block, defeating the entire feature even once Phase 4 is built. This is the downstream symptom of the F1 root cause; it is called out separately because reviewers implementing Phase 4 in isolation would see their grouping 'work' in unit tests (synthetic tagged tails) yet produce one section in production. Fix is F1; verification must be an integration-style assertion that a real stage→phase→log sequence yields a multi-section result.
### F5: TOTAL_SECTION_CAP splice drops earliest-stage headers and can slice mid-section, producing dangling indented lines with no header

- **Severity**: Medium
- **File**: `src/render/live-stream.ts`
- **Line**: flushSectionStack (TOTAL_SECTION_CAP)
flushSectionStack joins all sections then does `bodyLines.splice(0, bodyLines.length - TOTAL_SECTION_CAP)` (live-stream.ts, end of flushSectionStack). This keeps only the TAIL of the rendered body. Two problems: (1) the EARLIEST stages vanish entirely, including their headers — if a completed stage appeared only early and emitted few lines, its header (the only evidence it ran) is silently deleted; (2) the slice boundary is arbitrary and can land in the MIDDLE of a section's indented log lines, leaving a leading `  ⟨fg:…⟩…` line with no header above it. Spec #3 wants COMPLETED stages compact but PRESENT. Fix: bound per-stage (already done via RUNNING/COMPLETED_TAIL_LINES) and, if a total cap is still needed, drop whole LEADING sections and emit one `… N earlier stages trimmed …` notice rather than slicing the joined string.
### F6: AC-06 real-Theme parity for the NEW section rendering is not covered; only mockTheme exercises flush

- **Severity**: Medium
- **File**: `tests/render/real-theme-parity.test.ts`
- **Line**: 167-185
tests/render/real-theme-parity.test.ts exercises buildResultComponent (the unchanged legacy §1) and themeLine/commandBackground under withRealTheme, but contains NO reference to createLiveStream or flushSectionStack — the new per-stage section renderer is never run through the real class-based pi Theme proxy. live-stream-flush-sections.test.ts uses a mockTheme. The CRITICAL constraint ('NEVER destructure pi Theme methods; tests/stream-theme-class-theme.test.ts + tests/render/real-theme-parity.test.ts guard this') is therefore not actually guarding the new code path. Fix: add a withRealTheme case that drives createLiveStream({mode:'tui', theme:realTheme}) through phase/log/stage and asserts flush() does not throw `Cannot read properties of undefined (reading 'fgColors'/'bgColors')`.
### F7: Phase-line re-tag in sink.stage() is fragile: only the literal last entry is considered

- **Severity**: Low
- **File**: `src/render/live-stream.ts`
- **Line**: sink.stage
sink.stage() re-tags ONLY `transcript[length-1]` when it is a phase line whose label matches info.label (live-stream.ts, stage method). This relies on control-flow emitting phase STRICTLY immediately before stage:{running} with zero intervening pushes (RESOLVED-1). It is correct under that contract, but any future emit that inserts a line between phase and stage (e.g. an interim log, a second phase banner, or a thinking commit) silently defeats the re-tag and leaves the phase line on the previous stage. Confidence ~0.5. Suggested hardening: scan backwards for the most-recent matching phase line within a small window rather than requiring it to be the absolute last entry.
