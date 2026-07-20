# Code Assessment: Codebase Assessment — Theme-separated stream & result rendering (04-theme-stream-content-kinds)

- **Date**: 2025-01-01
- **Author**: super-dev:code-assessor

---

## Executive Summary

pi-super-dev is a self-contained pi-extension (ESM, `"type":"module"`, strict TS, NodeNext). It registers a single `super_dev` tool whose `execute()` streams a rolling-tail live log via a `ProgressSink` and whose `renderResult` builds a pi-native 3-section Container. The change is scoped to three files: new pure module `src/render/stream-theme.ts`, `src/extension.ts` (tag+theme the live stream + carry kinds end-to-end), and `src/render/dashboard.ts` (per-kind §1 rendering with tool-bubble backgrounds). All stream content already funnels through exactly three sink methods (`phase`/`log`/`text`) at workflow.ts:84-86, so classification happens at the sink layer with zero upstream edits. The codebase has a strong, well-established 'pure, TUI-context-free presentation helper with optional `theme?` for graceful-degrade' pattern (see dashboard.ts) that this change should mirror exactly. No new runtime deps; tests are LLM-free vitest units using a token-marker mock theme. NO STANDALONE SERVER: this is a TS library/extension loaded into the Pi TUI — there is no HTTP API or UI dev server to bring up, so `services` is empty ({}). The relevant 'run' commands are `npm run typecheck` (tsc --noEmit) and `npm test` (vitest run) for verification, and `pi -e .` then `/super-dev <task>` to exercise it live inside the Pi TUI.

## Patterns

### Pure, TUI-context-free presentation helpers with optional theme (graceful-degrade)

- **Example**: src/render/dashboard.ts — statusGlyph(status, theme?) / buildResultComponent(details, theme?) / DashboardTheme interface (lines ~58-80, ~250-290): helpers take optional `theme?`, return raw uncolored text when absent, declared via METHOD-syntax interface so the real Theme satisfies it bivariantly AND a lightweight mock works in tests.
- **Consistency**: Canonical and load-bearing — dashboard.ts docstring explicitly promises 'Pure, TUI-context-free'. The new stream-theme.ts MUST follow this shape (classifyLine/themeLine/commandBackground all pure, theme optional).
### DashboardTheme structural interface extended as needed (fg + optional bold)

- **Example**: src/render/dashboard.ts:58-61 — `export interface DashboardTheme { fg(token:string,text:string):string; bold?(text:string):string; }`
- **Consistency**: The new module must extend this same interface (add optional `bg?(color,text)` + extra fg tokens like thinkingText/toolTitle) rather than inventing a parallel type, so the real `Theme` still structurally satisfies it and the test mock keeps working.
### Test pattern: vitest, token-marker mock theme, co-located RED-first tests, .js imports

- **Example**: src/render/dashboard.test.ts:1-60 — `mockTheme()` returns `{ fg: (token,text) => \`<${token}>${text}\` }` so assertions verify WHICH token was applied without parsing ANSI; imports from `./dashboard.js` (NodeNext ESM).
- **Consistency**: Stream-theme tests should reuse this exact mock — assert `themeLine('command', '→ x', mock) === '<toolTitle>…'` style, and assert `themeLine('command','→ x', undefined) === '→ x'` for the no-ANSI regression (AC-5).
### TUI-only guard before any themed side-effect; non-TUI = raw text

- **Example**: src/extension.ts renderDashboard() `if (ctx?.mode !== 'tui') return;` (the widget guard), and dashboard-widget wiring comments citing AC-09/AC-10; theme resolved from `ctx?.ui?.theme` inside execute(), and passed as 3rd arg `renderResult(result,_opts,theme)`.
- **Consistency**: The live-stream theming in flush() MUST gate on `ctx?.mode === 'tui'` and resolve `ctx?.ui?.theme`; when not TUI, emit raw joined text. This is the AC-5 no-ANSI-leak guarantee for print/json/headless/RPC.
### pi-tui Container/Text/Markdown composition; Text 4th-arg customBgFn applies per-line BACKGROUND

- **Example**: src/render/dashboard.ts buildResultComponent/buildDashboardWidget — `new Text(line, 1, 0)` children added to a `Container`; §3 uses `new Markdown(..., getMarkdownTheme())`.
- **Consistency**: renderResult §1 must give command lines a `new Text(themedLine, 0, 0, commandBackground(kind, theme))` so they get toolPendingBg/toolSuccessBg — this 4th-arg customBgFn is exactly how a line gets the pi-native tool-bubble bg. Container/Markdown imports come from @earendil-works/pi-tui.
### ProgressSink is the single content bridge; classify at the sink layer only

- **Example**: src/types.ts ProgressSink interface (phase/log/text); src/extension.ts sink impl pushes to `transcript`/`live`; src/workflow.ts:84-86 routes event/text through log()/text().
- **Consistency**: The fix must NOT touch nodes.ts/workflow.ts/session-agent.ts/pi-spawn.ts. `sink.log` → push `{kind:classifyLine(message), text}`, `sink.phase` → `{kind:'phase', text:'▶ '+label}`, `sink.text`'s live → kind 'thinking'. Source emit sites (session-agent.ts:122 `→ `, :277 `↻ `, pi-spawn.ts:172 `→ `) stay untouched — classifyLine reads their prefixes.
### ANSI-safe width helpers already exist — reuse them

- **Example**: src/render/dashboard.ts truncLine(text, maxWidth) (ANSI-aware, re-applies active SGR before ellipsis), visibleWidth from pi-tui.
- **Consistency**: Any stream line that could exceed terminal width should go through truncLine so themed (ANSI-wrapped) lines don't break — do not hand-roll truncation in stream-theme.ts.

## Files Assessed

- package.json
- tsconfig.json
- README.md
- src/extension.ts
- src/render/dashboard.ts
- src/render/dashboard.test.ts
- src/types.ts
- src/workflow.ts

## Recommendations

- Create `src/render/stream-theme.ts` as PURE helpers mirroring dashboard.ts: export `LineKind` (the 10 kinds), `classifyLine(text)`, `themeLine(kind, text, theme?)`, `commandBackground(kind, theme?)`. Extend the existing `DashboardTheme` interface (don't fork it) with optional `bg?(color, text)` + the extra fg tokens (thinkingText, toolTitle, etc.); keep every `theme` param optional so undefined→raw text (graceful-degrade). Order classifyLine's prefix checks precisely as the spec lists them (command-done BEFORE command; phase ▶; error ❌/contains; warning ⚠/stagnant; success PASS/GREEN/✓; FAIL/✗; trim marker; indented/plain→log).
- In `src/extension.ts`: change `transcript: string[]` → `Array<{kind:LineKind; text:string}>`; tag in the three sink methods (phase→'phase', log→classifyLine, text-live→'thinking'); update `finalizeLive`, `flush` (the trim-notice line is kind 'trim'), the disk `writeFileSync(transcript...)`, and `details.transcriptTail` (carry kinds). In `flush()`, ONLY when `ctx?.mode === 'tui'`, resolve `ctx?.ui?.theme` and style each line via `themeLine` before joining — otherwise join raw text. Keep TAIL_LINES rolling-tail behavior intact.
- In `src/render/dashboard.ts`: widen `ResultDetails.transcriptTail` to `Array<{kind:LineKind;text:string}>` (tolerate a plain string[] slipping through). In `buildResultComponent` §1, render each tail line with `themeLine(line.kind, line.text, theme)` and give COMMAND/command-done lines a `new Text(styled, 0, 0, commandBackground(line.kind, theme))` for the tool-bubble bg; keep §2 (bold header + stageIcon rows) and §3 (Markdown summary) untouched. Leave the streaming fallback (`if (!d.stages?.length) return new Text(...)`) as-is so print/json/headless regress nothing.
- Tests: add `src/render/stream-theme.test.ts` covering each LineKind→correct token (reuse the `<token>` mockTheme from dashboard.test.ts) + the undefined-theme→raw-text no-ANSI case (AC-5); extend dashboard-result coverage to assert command lines carry a customBgFn and phase/error/thinking get their tokens. Run `npm run typecheck` and `npm test` — both must stay green. The guaranteed-correct per-line backgrounds live in renderResult's Container Text customBgFn (AC-3); full per-line bg in the streaming onUpdate view is best-effort/terminal-dependent — note this in the implementation summary.
