# Implementation Plan: Technical Specification: pi-native Stream Content-Kind Theming for super-dev Live Stream + Result Render

- **Date**: 2025-07-20

---

> **Implementation Status (post-code-review):** ALL 4 PHASES COMPLETE ✅. `npm run typecheck` strict-clean; `npm test` green (existing dashboard/render suites + new stream-theme, live-stream, render-per-kind, regression-guard tests). All AC-01..AC-10 demonstrable. See [10-implementation-summary.md](10-implementation-summary.md) for the full delivery record.

| Phase | Status | Commit |
|-------|--------|--------|
| Phase 1 — Pure stream-theme module + DashboardTheme extension | ✅ Complete | 5cddac82 |
| Phase 2 — Sink-layer tagging + kind-carrying transcript | ✅ Complete | 43868fbf |
| Phase 3 — renderResult §1 per-kind theming + tool-bubble bg | ✅ Complete | 6916b4a1 |
| Phase 4 — Regression guard + full verification gate | ✅ Complete | a02f4058 |

## Phase 1: Phase 1 — Pure stream-theme module + DashboardTheme extension

Create the new dependency-free module src/render/stream-theme.ts exporting LineKind, classifyLine, themeLine, and commandBackground, and extend the DashboardTheme interface in src/render/dashboard.ts with an optional bg() member so the real pi Theme satisfies it structurally. Independently testable: a standalone stream-theme.test.ts drives every classifyLine precedence case, every themeLine kind→token mapping, the undefined-theme graceful-degrade (raw text, zero ANSI), and commandBackground for command/command-done/other. Covers AC-01, AC-02, AC-03 (SCENARIO-001..007). No runtime behavior changes yet — extension.ts/dashboard.ts render logic is untouched, so this phase is safe to land and typecheck in isolation.
## Phase 2: Phase 2 — Sink-layer tagging + kind-carrying transcript in extension.ts

Convert src/extension.ts transcript from string[] to Array<{kind,text}>, push classified kinds from sink.phase/log and finalizeLive (thinking), rework flush() to theme per-kind ONLY in TUI mode (ctx?.mode === 'tui' using ctx?.ui?.theme) while emitting raw line.text in non-TUI, keep the rolling-tail + trim-notice (trim kind), keep the on-disk log write as raw line.text, and make details.transcriptTail carry {kind,text} end-to-end. Independently testable: a no-ANSI-leak test drives the sink with NO theme and asserts zero ANSI in both the live body and the disk log; a TUI-mode mirror asserts ANSI IS present. Covers AC-04, AC-05, AC-06 (SCENARIO-008..013). Depends on Phase 1 (needs classifyLine/themeLine/commandBackground + LineKind type).
## Phase 3: Phase 3 — renderResult/buildResultComponent §1 per-kind theming with tool-bubble backgrounds

Update buildResultComponent in src/render/dashboard.ts so §1 renders each transcriptTail line via themeLine(kind,text,theme) and emits COMMAND/COMMAND-DONE lines as new Text(styled, 0, 0, commandBackground(kind,theme)) to paint the per-line tool-bubble background through pi-tui Text's 4th customBgFn argument; ResultDetails.transcriptTail becomes Array<{kind,text}> with a backward-tolerant plain-string→kind 'log' default. §2 (bold stage header + stageIcon rows) and §3 (Markdown summary via getMarkdownTheme) stay byte-identical. Independently testable: a render-per-kind test drives buildResultComponent with one entry per kind and asserts command/command-done Texts carry a customBgFn while thinking/phase/error lines carry their fg tokens. Covers AC-07 (SCENARIO-014). Depends on Phase 1 (stream-theme helpers) and Phase 2 (the new transcriptTail shape).
## Phase 4: Phase 4 — Regression guard + full verification gate

Add the no-ANSI-leak regression test (simulating print/json/headless with NO theme) and the TUI-mode ANSI-present mirror if not already added in Phase 2, then run the full gate: npm run typecheck must be strict-clean (transcript/transcriptTail shape change + DashboardTheme optional bg must typecheck across all three files) and npm test must pass existing dashboard-widget/dashboard-wiring/dashboard-result/render suites PLUS the new stream-theme and render-per-kind tests. Confirms no regression to the live dashboard widget, the in-scope build-gate, or the §3 Markdown summary. Covers AC-08, AC-09, AC-10 (SCENARIO-015..018). Depends on Phases 1-3 being complete.
