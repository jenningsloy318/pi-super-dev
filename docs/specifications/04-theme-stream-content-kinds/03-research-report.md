# Research Report: Theme the super-dev stream + result by content kind, using pi-native Theme tokens (incl. backgrounds)

- **Date**: 2026-07-20
- **Author**: super-dev:research-agent

---

## Summary

The implementation gap is confirmed against source: today the live `flush()` (extension.ts:172) joins the transcript as one raw string with NO theme access, and `buildResultComponent` §1 (dashboard.ts:338-343) renders every tail line uniformly as `fg("dim", line)` — so commands, thinking, phase banners, logs, and errors are visually indistinguishable. The pi-native Theme API required to fix this is verified in the installed `theme.d.ts` (SRC-01): `fg(color,text)`/`bg(color,text)` exist, `ThemeColor` includes `thinkingText`/`toolTitle`/`accent`/`success`/`error`/`warning`/`dim`/`text`/`muted`, and `ThemeBg` exposes exactly `toolPendingBg`/`toolSuccessBg`/`toolErrorBg` plus `customMessageBg`/`userMessageBg`/`selectedBg`. The pi-tui `Text` 4th-arg `customBgFn?: (text)=>string` (SRC-02) is the real, type-exact mechanism for per-line tool-bubble backgrounds. Every stream line already funnels through exactly three sink methods (SRC-03), so a pure `classifyLine(text): LineKind` at the sink layer captures the full taxonomy with zero upstream changes — this is the central best practice (BP-01). The decisive engineering constraint is the headless/print/json/RPC byte-clean contract: theme MUST be optional everywhere and identity-degrade, and the implementer MUST keep SEPARATE raw-vs-themed join paths rather than theme-then-strip ANSI (BP-02; this is the explicit ISS-01 resolution — a buggy strip regex risks ANSI leakage). The cleanest, lowest-risk design is a pure `src/render/stream-theme.ts` module exporting `classifyLine`/`themeLine`/`commandBackground` with the existing `DashboardTheme` widened by an optional `bg` token, carrying `Array<{kind,text}>` end-to-end through `transcript`→`flush`→`details.transcriptTail`→renderResult, and applying backgrounds ONLY via the result Container's `Text` customBgFn (guaranteed), with streaming-inline backgrounds explicitly best-effort/terminal-dependent by design.

## Options Considered

### Pure stream-theme module + tagged {kind,text} transcript + Text-customBgFn bubbles (RECOMMENDED)

Aligns with every AC and all resolved issues. Pros: classifyLine/themeLine/commandBackground are pure and unit-testable with a structural theme mock; the headless contract is protected by identity-degrade + separate raw join paths (BP-02); tool-bubble backgrounds are guaranteed-correct in renderResult via pi-tui Text's 4th-arg customBgFn (SRC-02); no upstream/emit-site edits needed (BP-01). Cons: touches transcript shape across extension.ts→details→dashboard.ts (the type widening at dashboard.ts:290 must accept {kind,text} and stay backward-tolerant to stray strings via a typeof guard — already specced as ISS-04). This is the only option that satisfies all 10 ACs without violating the out-of-scope constraints.
### Tag kind at emit-site (session-agent.ts / pi-spawn.ts) instead of classifying at the sink

Would be more type-accurate (each emitter knows its own kind). Cons: explicitly OUT OF SCOPE — the task forbids touching session-agent.ts, pi-spawn.ts, workflow.ts, nodes.ts; requires restructuring the 3-method bridge contract. The bridge already routes everything through sink.phase/log/text, so classification-by-prefix at the sink captures the full taxonomy (verified emit prefixes: '→ structured_output ✓', '→ ', '↻ ', '▶ ', '❌'). Rejected.
### Theme-then-strip: single themed join + regex strip of \x1b[ bytes for non-TUI

Pros: one code path, less type plumbing. Cons: FORBIDDEN by the resolved ISS-01 — the implementer MUST use separate themed-vs-raw join paths, never join-then-strip, because any strip-regex bug silently leaks ANSI into print/json/headless output and saved logs (BP-02). The on-disk write (extension.ts:262) and non-TUI flush (extension.ts:175-180) must each join raw line.text independently. Rejected as a regression risk.
### Parallel arrays (string[] transcript + LineKind[] kinds) instead of tagged objects

Pros: transcript stays string[] so a few existing consumers need no change. Cons: index-drift / length-mismatch bugs; details.transcriptTail needs paired kinds anyway; makes the kind↔text binding implicit and error-prone. The tagged {kind,text} array (Option 1) is strictly safer and barely more invasive. Rejected as inferior.

## Open Issues

- By-design limitation (not a blocker): per-line tool-bubble BACKGROUNDS are guaranteed-correct ONLY in renderResult's Container Text customBgFn. In the streaming onUpdate view, inline theme.bg is terminal-dependent and best-effort; the task explicitly accepts this and requires it be noted in the implementation summary. Foreground separation (toolTitle/thinkingText/accent/error) IS guaranteed in both paths.
- Verify-before-merge only: the streaming onUpdate body, when theme.bg is best-effort-applied to a command line, must not corrupt the TAIL_LINES rolling-window accounting or the '… N earlier lines trimmed …' trim-notice line (which must be kind 'trim' and counted once). Implementer should keep the tail/trim logic operating on the {kind,text} array BEFORE any per-line styling.
