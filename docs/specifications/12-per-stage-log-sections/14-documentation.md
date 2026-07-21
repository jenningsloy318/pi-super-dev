# Documentation: Per-Stage Log Sections (spec-12) — Documentation Update

- **Date**: 2026-07-22

---

## Summary

Updated all spec-12 directory documents plus the project CHANGELOG to reflect the completed implementation. Verified the codebase state directly: `npm run typecheck` is strict-clean and `npm test` passes 1361/1361 (80 files), including the directly-scoped suites (stage-grouping 23, live-stream-per-stage 24, live-stream-flush-sections 23, per-stage-result 19, stream-theme-class-theme 4, real-theme-parity 27). All 6 phases are complete — phases 1–2 committed (ea1f7c64, c550323b), phases 3–6 + a code-review fix round in the working tree. Source changes: src/render/live-stream.ts (widened TranscriptLine + stage(info) + flushSectionStack + named caps RUNNING_TAIL_LINES=15/COMPLETED_TAIL_LINES=3/TOTAL_SECTION_CAP=400/PARTITION_INPUT_CAP=4000), new src/render/stage-grouping.ts (pure groupByStage), src/render/stream-theme.ts (new shared statusFgToken), src/render/dashboard.ts (buildResultComponent §1 per-stage blocks + customBgFn backgrounds + additive transcriptTail/stages widening), src/extension.ts (single stream.sink.stage(info) wiring). New tests: tests/stage-grouping.test.ts, tests/live-stream-per-stage.test.ts, tests/live-stream-flush-sections.test.ts, tests/render/per-stage-result.test.ts.

## Documentation Updates

- **Docs Updated**: docs/specifications/12-per-stage-log-sections/06-task-list.md (marked all 27 tasks complete [x], added completion summary with file lists + test results); docs/specifications/12-per-stage-log-sections/05-implementation-plan.md (marked all 6 phases ✅ COMPLETE, added status banner); docs/specifications/12-per-stage-log-sections/08-implementation-summary.md (flipped to 6/6 phases + All Green:true; rewrote the stale phase-3-RED / phases-4-6-NOT-STARTED / DEVIATIONS sections to the final green narrative; corrected the empty-claim control-artifact NOTE); docs/specifications/12-per-stage-log-sections/04-specification.md (appended a full "Deviations from Specification" section D1–D6 plus deferred findings); CHANGELOG.md (added a spec-12 "Added" entry under [Unreleased]). Requirements (01), BDD scenarios (02), research (03), spec-review (07), and review docs (09/10/10/11) left as historical stage records — no deviations touched their acceptance criteria or scenarios.

## Deviations Documented

- D1 — Added PARTITION_INPUT_CAP = TOTAL_SECTION_CAP * 10 = 4000 (additive hot-path bound not in spec): slices visible.slice(-PARTITION_INPUT_CAP) before groupByStage so the streaming flush never re-partitions the unbounded transcript; no visible content dropped (older lines render compact/header-only via stageMeta synthesis). Cosmetic-only edge case noted in code-review L4.
- D2 — Added shared statusFgToken(status) export in stream-theme.ts as the single source of truth for the status→color taxonomy, deduped from the three prior inline copies (live-stream header, dashboard header, dashboard bg); reduces the drift risk surfaced by code-review L3.
- D3 — TOTAL_SECTION_CAP value chosen = 400 (spec F-06 left it unspecified); generous bound for the live stack, running stage tail always retained, no content loss.
- D4 — AC-01 wording drift (F-05): implementation resolves stage identity from the structured stage event via sink.stage(info) per the spec body + research RESOLVED-1, superseding the older literal phase-updates-it AC-01 phrasing (which was not retroactively amended); behavior matches the spec body and tests assert the structured-event path.
- D5 — Non-TUI live body is structurally richer than legacy flat text (▶ <label> headers + indented per-kind logs) but remains ZERO ANSI bytes (AC-08 byte-clean contract preserved and asserted by \x1b scan); intentional per SCENARIO-013.
- D6 — ResultDetails.stages widened additively with optional id (was {label,status} with no id, breaking the id→statusOf resolver); additive so legacy callers stay strict-clean; enables AC-04 per-stage background resolution.
- Deferred (not deviations): M1 hasStageTags asymmetry + L1 aggregate-cap keep-last-section edge case left as-is (real runs end on the running stage); L2 phase-line re-tag window hardcoded to 4 (correct vs observed emit ordering); interactive collapse/expand (Ctrl+O) explicitly out of scope (NON-GOALS).
