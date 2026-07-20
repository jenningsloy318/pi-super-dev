# Implementation Summary: pi-native Stream Content-Kind Theming (Spec-04)

- **Date**: 2025-07-20

---

## Summary

## What was built

Made the super-dev live stream and final result render behave like pi-native by classifying every transcript line into one of 10 `LineKind` values and mapping each kind to real pi Theme tokens (foreground colors + dedicated tool-bubble backgrounds). Classification is the single authority and happens entirely at the sink layer; ANSI theming is gated to TUI mode only so print/json/RPC/headless output stays byte-clean.

## Per-phase delivery

**Phase 1 — Pure stream-theme module + DashboardTheme extension** (`src/render/stream-theme.ts`, new)
- New dependency-free module exporting `LineKind`, `classifyLine`, `themeLine`, and `commandBackground`.
- `classifyLine` trims leading whitespace first (sink.log stores `  → cmd` indented) then matches a strict precedence: `→ structured_output ✓` (command-done) BEFORE generic `→ ` (command); then corrective `↻`, phase `▶`, error (`❌`/`failed after`/`did NOT complete`), warning (`⚠`/stagnant), success (PASS/GREEN/✓/passed/complete), log-error (FAIL/✗/error), trim marker, default log.
- `themeLine` maps each kind→fg token (toolTitle/thinkingText/accent/text/dim/success/warning/error/muted + bold where specified); **graceful-degrade contract**: undefined theme returns raw text byte-for-byte (zero ANSI).
- `commandBackground` returns `bg("toolPendingBg")`/`bg("toolSuccessBg")` for command/command-done, undefined otherwise.
- Extended `DashboardTheme` with an optional `bg()` member so the real pi Theme satisfies it structurally without breaking existing `fg` call sites.
- Covers AC-01..03 (SCENARIO-001..007).

**Phase 2 — Sink-layer tagging + kind-carrying transcript** (`src/extension.ts`, modified; `src/render/live-stream.ts`, new)
- `transcript` changed from `string[]` → `Array<{kind,text}>`; `sink.phase`/`sink.log`/`finalizeLive` push classified kinds (`thinking` tagged directly by sink.text).
- `flush()` themes per-kind via `themeLine` **only when `ctx?.mode === 'tui'`**; non-TUI mode emits raw `line.text` so output stays ANSI-free. Rolling tail (TAIL_LINES=400) + trim-notice preserved (now `trim` kind). On-disk log writes raw text only (grep-friendly).
- `details.transcriptTail` carries `{kind,text}` end-to-end (sink → flush → details → renderResult).
- Covers AC-04..06 (SCENARIO-008..013).

**Phase 3 — renderResult/buildResultComponent §1 per-kind theming** (`src/render/dashboard.ts`, modified)
- §1 renders each tail line via `themeLine(kind,text,theme)`; COMMAND/COMMAND-DONE lines emitted as `new Text(styled, 0, 0, commandBackground(kind,theme))` to paint the per-line tool-bubble background through pi-tui Text's 4th `customBgFn` argument.
- `transcriptTail` consumer is backward-tolerant: a plain `string` element defaults to kind `log`.
- §2 (bold stage header + stageIcon rows) and §3 (Markdown summary via getMarkdownTheme) byte-identical.
- Covers AC-07 (SCENARIO-014).

**Phase 4 — Regression guard + full verification gate** (`src/render/regression-guard.test.ts`, new)
- Added no-ANSI-leak regression test (drives sink with NO theme → zero ANSI in live body AND disk log) plus TUI-mode mirror asserting ANSI IS present, proving gating is on theme+mode not always-on.
- Full gate: `npm run typecheck` strict-clean across the three files + optional `bg`; `npm test` passes existing dashboard-widget/wiring/dashboard-result/render suites AND new stream-theme + render-per-kind tests.
- Covers AC-08..10 (SCENARIO-015..018).

## Files changed (10)
- NEW `src/render/stream-theme.ts` + `src/render/stream-theme.test.ts`
- NEW `src/render/live-stream.ts` + `src/render/live-stream.test.ts`
- MOD `src/render/dashboard.ts` (DashboardTheme bg() + per-kind §1)
- MOD `src/extension.ts` (transcript {kind,text}, sink tagging, flush mode-gating)
- NEW `src/render/dashboard-result-perkind.test.ts`, `src/render/regression-guard.test.ts`
- MOD `src/render/dashboard-result.test.ts`, `package-lock.json`

## Test results
All green: `npm run typecheck` strict-clean; `npm test` passes for the existing dashboard/render suites plus the four new test files. AC-01..10 demonstrable from passing assertions.

## Deviations from spec
- The live-stream theming/gating logic was extracted into a dedicated NEW `src/render/live-stream.ts` module (with its own test) rather than living inline in `extension.ts`. The spec described the logic as inline in `extension.ts`; the extraction is a clean refactor of the same behavior, net-neutral. No functional deviation.

## Phases

- **Phases Completed**: 4/4
- **All Green**: true

## Files Modified

- src/render/stream-theme.ts
- src/render/stream-theme.test.ts
- src/render/live-stream.ts
- src/render/live-stream.test.ts
- src/render/dashboard.ts
- src/extension.ts
- src/render/dashboard-result-perkind.test.ts
- src/render/regression-guard.test.ts
- src/render/dashboard-result.test.ts
- package-lock.json
