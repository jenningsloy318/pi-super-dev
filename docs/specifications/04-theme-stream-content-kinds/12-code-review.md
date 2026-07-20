# Code Review: Code Review — spec-04 theme stream content kinds

- **Date**: 2026-07-20
- **Author**: super-dev:code-reviewer
- **Verdict**: Approved

---

## Verdict: Approved

The implementation cleanly delivers pi-native content-kind separation across the live stream and final result render. A new pure module `src/render/stream-theme.ts` exports the 11-value `LineKind` taxonomy plus `classifyLine`, `themeLine`, and `commandBackground` — all dependency-free, unit-tested, and gracefully degrading to raw text (zero ANSI) when no theme is present. A second pure factory `src/render/live-stream.ts` owns the kind-carrying transcript, mode-gated theming (TUI only), rolling-tail + trim-notice, and the grep-friendly raw disk log. `extension.ts` threads `{kind,text}` end-to-end (sink → flush → details → renderResult), and `dashboard.ts#buildResultComponent` §1 renders each tail line per-kind, painting command/command-done lines as tool bubbles via pi-tui `Text`'s 4th `customBgFn` argument while §2 (stage progress) and §3 (Markdown summary) stay byte-identical.

Validation against the spec is strong: `npm run typecheck` is strict-clean; all 773 tests pass (42 files), including the new `stream-theme.test.ts`, `live-stream.test.ts`, `dashboard-result-perkind.test.ts`, and the cross-cutting `regression-guard.test.ts`. Every acceptance criterion (AC-01..AC-07) is demonstrably met with passing BDD scenarios, and the no-ANSI-leak contract is locked in across print/json/rpc/headless modes with NO theme for both the live body and the disk log. Backward compatibility is honored — a plain-string tail element is tolerated (defaults to kind `log`), `DashboardTheme.bg` stays optional, and non-TUI output is byte-clean.

No Critical, High, or Medium issues were found. The findings below are Low/Informational robustness and documentation observations that do not block approval.

## Findings

### F-01: Live-stream onUpdate applies command foreground only; the best-effort tool-bubble background from spec §2 is not applied

- **Severity**: Low
- **File**: `src/render/live-stream.ts`
- **Line**: 135-139
Required-change §2 (flush) states lines should be themed via `themeLine(...)` and that commands are 'also wrapped with `theme.bg("toolPendingBg", line)` best-effort'. `live-stream.ts#renderBody` (line 135-139) only calls `themeLine(l.kind, l.text, theme)` and joins — it never invokes `theme.bg`/`commandBackground`, so command lines in the STREAMING view get the `toolTitle` foreground but no pending/success tool-bubble background. AC-02 is still satisfied (it requires only foreground color-separation in the live stream) and the Out-of-scope clause explicitly permits streaming backgrounds to be best-effort/terminal-dependent, with the guaranteed-correct backgrounds living in `renderResult` (which IS correctly wired via `commandBackground` + Text `customBgFn`). Action: either apply `commandBackground(kind, theme)?.(themed)` to command/command-done lines in `renderBody` when `mode === 'tui'`, or confirm the implementation summary explicitly notes that per-line backgrounds are renderResult-only (the spec asks this to be noted). Confidence 0.8.
### F-02: `complete`/`passed` substring matching produces real-world false positives

- **Severity**: Low
- **File**: `src/render/stream-theme.ts`
- **Line**: 88-96
classifyLine rules 7 use `/passed/i` and `/complete/i` (substring). These match 'bypassed', 'surpassed', 'incomplete', 'completed', 'completion' — all of which would be misclassified as `log-success` (green). For example a log line 'tests bypassed' or 'build incomplete' would render green. The spec literally says 'contains `passed`' / 'contains `complete`' (note `PASS` is the only one given `\b` word boundaries), so this faithfully implements the spec as written, but it is fragile against ordinary English. Suggested fix: tighten to word-boundary forms `/\bpassed\b/i` and `/\bcomplete(?:d|ment)?\b/i` (or coordinate with the spec author). Low impact (cosmetic miscoloring of a process line). Confidence 0.75.
### F-03: Trim-notice line surfaces in non-TUI (print/json) onUpdate body

- **Severity**: Informational
- **File**: `src/render/live-stream.ts`
- **Line**: 144-156
When the visible body exceeds TAIL_LINES, `flush` prepends a synthetic `{kind:'trim', text:'… N earlier lines trimmed (full log saved at run end) …'}` line to the displayed body. Because `renderBody` emits raw `line.text` in non-TUI modes, this trim notice also appears in print/json/headless output. It is raw text (no ANSI), so AC-05 (byte-clean, zero ANSI) still holds and the regression guard passes. This is purely cosmetic: a UI affordance ('earlier lines trimmed') shows up in headless logs. No action required unless headless cleanliness is desired; if so, suppress the trim notice when `mode !== 'tui'`. The on-disk log (`diskLogText`) is unaffected — it carries the FULL transcript with no trim notice, as intended.
### F-04: Transcript accumulates unbounded in memory across the full run

- **Severity**: Informational
- **File**: `src/render/live-stream.ts`
- **Line**: 119-121
`createLiveStream.transcript` is a grow-only array; only the DISPLAY is rolling-tail while the full transcript is retained for the end-of-run disk log and the 50-line `transcriptTail` snapshot. For a 100+ agent run this can be thousands of lines held in memory until process exit. This is by design (the spec requires 'Preserve the FULL run log to disk' and the rolling tail only governs the visible body), so it is not a defect — but worth noting for future very-large-run scaling. No change recommended for this task.
