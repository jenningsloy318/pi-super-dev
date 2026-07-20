# Specification: Technical Specification: pi-native Stream Content-Kind Theming for super-dev Live Stream + Result Render

- **Date**: 2025-07-20

---

## Summary

Today the super-dev live stream and final result render flatten every content kind (commands, thinking, process logs, phase markers, errors, corrective notices, success/failure keywords) into one undifferentiated text block. This spec makes the stream render like pi-native: a new pure module `src/render/stream-theme.ts` classifies each line into one of 10 `LineKind` values and maps each kind to the real pi Theme tokens (foreground colors AND dedicated backgrounds for tool bubbles). The classification happens entirely at the sink layer in `src/extension.ts` (no upstream emit-site changes — all content already funnels through `sink.phase/log/text`), the live `onUpdate` body is themed per-kind in TUI mode only (raw text in print/json/RPC/headless to stay byte-clean), the on-disk log stays grep-friendly raw text, and `renderResult`/`buildResultComponent` §1 renders commands as tool-bubble `Text` (via the pi-tui 4th `customBgFn` argument), thinking in `thinkingText`, phase markers in accent/bold, and errors in error red. `transcript` and `transcriptTail` carry `{kind,text}` end-to-end (sink → flush → details → renderResult). Backward-compatible, strict-clean TypeScript, no new dependencies, no changes to nodes/workflow/pipeline/stages/session-agent/pi-spawn/render templates.

## Architecture

The change is confined to three TypeScript files plus tests, and is layered so the pure logic is fully unit-testable with a structural theme mock and never imports TUI runtime types.

(1) NEW MODULE — src/render/stream-theme.ts. Exports `type LineKind = "phase" | "command" | "command-done" | "corrective" | "log" | "log-success" | "log-warning" | "log-error" | "thinking" | "error" | "trim"` and three pure functions: `classifyLine(text: string): LineKind`, `themeLine(kind: LineKind, text: string, theme?: DashboardTheme): string`, and `commandBackground(kind: LineKind, theme?: DashboardTheme): ((t: string) => string) | undefined`. The module imports only the structural `DashboardTheme` shape (re-exported/extended from dashboard.ts) — never the real `Theme` runtime type — so it is unit-testable with a mock. classifyLine is the single classification authority; it FIRST trims leading whitespace (because sink.log stores lines with a leading `  ` indent at extension.ts:229, so a command `→ …` arrives stored as `  → …`), then matches prefixes/keywords in a strict precedence order: `→ structured_output ✓` (+success marker) → command-done BEFORE the generic `→ ` → command (order is mandatory: command-done is a specialisation of command); `↻ ` → corrective; `▶ ` → phase; `❌` OR `failed after` OR `did NOT complete` → error; `⚠` OR `/stagnan/i` → log-warning; `\bPASS\b`/`GREEN`/`✓`/`passed`/`complete` → log-success; `FAIL`/`✗`/`\berror\b` → log-error; the `… earlier lines trimmed` marker → trim; leading indented or plain text → log. (thinking is NOT classified — it is tagged directly by sink.text.) themeLine maps each kind to the exact pi-native token: phase→fg("accent",bold(text)); command→fg("toolTitle",bold(name))+" "+fg("dim",rest) where name/rest split on the first space; command-done→fg("toolTitle",bold(text)); corrective→fg("warning",text); log→fg("text",text) but INDENTED logs →fg("dim",text); log-success→fg("success",text); log-warning→fg("warning",text); log-error→fg("error",text); thinking→fg("thinkingText",text); error→fg("error",bold(text)); trim→fg("muted",text). commandBackground returns theme.bg("toolPendingBg",_) for command, theme.bg("toolSuccessBg",_) for command-done, undefined otherwise. CRITICAL graceful-degrade contract: when `theme` is undefined, themeLine returns the raw text unchanged (zero ANSI) and commandBackground returns undefined — this is the print/json/headless/RPC contract.

(2) src/render/dashboard.ts — DashboardTheme + buildResultComponent. The existing `DashboardTheme` interface (dashboard.ts:31) is extended with an OPTIONAL member `bg?(token: string, text: string): string` (and keeps `fg` + optional `bold`); the token strings "toolTitle"/"thinkingText"/"toolPendingBg"/"toolSuccessBg" are passed through to the real Theme unchanged, and the existing `fg("success"/"error"/"accent"/"dim"/"text"/"warning"/"muted")` call sites are unaffected, so no other caller breaks. The `ResultDetails.transcriptTail` field changes from `string[]` to `Array<{ kind: LineKind; text: string }>` with a backward-tolerant consumer: a plain `string` element defaults to kind "log". In `buildResultComponent` §1 (dashboard.ts:338-343), each tail line is styled via `themeLine(line.kind, line.text, theme)`; COMMAND and COMMAND-DONE lines are emitted as `new Text(styled, 0, 0, commandBackground(line.kind, theme))` so pi-tui Text's 4th `customBgFn` argument paints the per-line tool-bubble background. §2 (bold stage header + `stageIcon` rows) and §3 (Markdown summary via `getMarkdownTheme`) stay byte-identical. Net visual: commands pop as tool bubbles, thinking renders in thinkingText, phase markers in accent/bold, errors in error red.

(3) src/extension.ts — tag + theme the LIVE stream. `transcript: string[]` (extension.ts:158) → `Array<{ kind: LineKind; text: string }>`. `finalizeLive()` pushes `{ kind: "thinking", text: live }`. `sink.phase(label)` pushes `{ kind: "phase", text: \`▶ ${label}\` }`. `sink.log(message)` pushes `{ kind: classifyLine(message), text: message }`. `flush()` still enforces the rolling tail (TAIL_LINES=400) and the trim-notice line, now pushed as `{ kind: "trim", text: "… N earlier lines trimmed (full log saved at run end) …" }`. In flush(), when `ctx?.mode === "tui"`, each line is styled via `themeLine(line.kind, line.text, ctx?.ui?.theme)` before joining for the live onUpdate body, and command lines additionally get a best-effort tool-bubble background (terminal-dependent — guaranteed-correct backgrounds live in renderResult's Container Text customBgFn). When NOT in tui mode, flush emits the RAW `line.text` joined by newlines so print/json/RPC output stays byte-clean and ANSI-free. The on-disk log write (extension.ts:262) writes raw `line.text` only (no ANSI, no kind prefix) so saved logs stay grep-friendly. The final `details.transcriptTail` (extension.ts:278) becomes `Array<{ kind: LineKind; text: string }>` built from the last 50 transcript entries; the local `ResultDetails`-like type declaration at extension.ts:295 is updated to match. renderResult already receives `theme: Theme` and already delegates to buildResultComponent — it needs no logic change beyond consuming the new transcriptTail shape (the consumer tolerance lives in buildResultComponent).

Cross-cutting contracts: (a) classification is the ONLY classification authority (one place, tested); (b) ANSI appears ONLY when a real theme is present AND ctx is TUI; (c) the sink/bridge (workflow.ts:84-86) and all emit sites (session-agent.ts:122/:277, pi-spawn.ts:172) are NOT edited — every kind is captured by prefix-matching at the sink layer.

## Testing Strategy

Three layers of tests, all pure (no real TUI, no real pi runtime), plus the strict typecheck and the existing suite as a regression gate.

(A) New stream-theme unit tests (src/render/stream-theme.test.ts) — cover classifyLine with one assertion per LineKind, including the precedence-critical `→ structured_output ✓` BEFORE the generic `→ ` command rule, the leading-whitespace trim (a stored `  → cmd` classifies as command), and every error/warning/success keyword (`❌`, "failed after", "did NOT complete", `⚠`, "stagnant", PASS/GREEN/✓/passed/complete, FAIL/✗/error). Cover themeLine for EACH kind asserting the correct fg token (toolTitle/thinkingText/accent/text/dim/success/warning/error/muted) and bold wrapping where specified, plus the split-name/rest rule for command. Cover themeLine's undefined-theme graceful-degrade: EVERY kind returns the raw text byte-for-byte with zero ANSI escape bytes. Cover commandBackground: command→toolPendingBg, command-done→toolSuccessBg, every other kind→undefined, and undefined theme→undefined.

(B) New render-per-kind test — drives `buildResultComponent` with a `transcriptTail` containing one entry of each kind (including the plain-string backward-tolerance case) and asserts: COMMAND and COMMAND-DONE lines were emitted as `Text` instances carrying a non-undefined `customBgFn` (the 4th constructor arg), while thinking/phase/error/log lines carry their respective fg tokens and NO customBgFn.

(C) New no-ANSI-leak regression test — simulates the print/json/headless path by driving the sink through phase/log/text events with NO theme (theme undefined), then asserts the joined live onUpdate body equals the raw joined `line.text` with ZERO ANSI escape bytes (regex /\\x1b\\[/i must not match), AND the on-disk log string likewise contains zero ANSI. A mirrored TUI-mode assertion (theme present) confirms the body DOES contain expected fg tokens, proving the gating is on theme+mode, not always-on.

(D) Existing suite as regression gate — npm test must keep passing for dashboard-widget, dashboard-wiring, dashboard-result, and render tests (the §1/§2/§3 layout and the Markdown §3 summary must not regress). The change is designed so existing tests that feed plain `string[]` transcriptTail keep passing via the backward-tolerant plain-string→kind "log" default.

(E) Final gate — `npm run typecheck` strict-clean (the `transcript`/`transcriptTail` shape change and the DashboardTheme optional `bg` addition must typecheck across extension.ts, dashboard.ts, and stream-theme.ts) AND `npm test` green (existing + new). Acceptance is met when AC-01..AC-10 are each demonstrable from a passing assertion.

## BDD Scenario References

- SCENARIO-001
- SCENARIO-002
- SCENARIO-003
- SCENARIO-004
- SCENARIO-005
- SCENARIO-006
- SCENARIO-007
- SCENARIO-008
- SCENARIO-009
- SCENARIO-010
- SCENARIO-011
- SCENARIO-012
- SCENARIO-013
- SCENARIO-014
- SCENARIO-015
- SCENARIO-016
- SCENARIO-017
- SCENARIO-018

---

## Implementation Deviations (recorded post-implementation)

### DEV-04-1: Live-stream logic extracted into `src/render/live-stream.ts` (net-neutral refactor)

- **Original (spec text):** Phase 2 described the transcript/`sink`/`flush`/`finalizeLive`/disk-log logic living **inline** in `src/extension.ts`, as closures inside the real `execute()` path.
- **Changed (implemented):** That logic was extracted into a NEW pure, dependency-free module `src/render/live-stream.ts` exporting `createLiveStream({...})`, `TranscriptLine`, plus `diskLogText()` / `transcriptTail()` / `finalizeLive` / `flush` / `sink` accessors. `extension.ts` now imports and drives it (throttling + dashboard widget remain in `extension.ts` on top of the returned handle).
- **Reason:** The real `execute()` path spawns `pi` children and runs the 13-stage pipeline, so it cannot be driven in a unit test. The Testing Strategy (C) requires driving "the sink through phase/log/text events" in isolation. Extracting the factory makes the no-ANSI-leak + TUI-mode mirror regression tests (`src/render/regression-guard.test.ts`, `src/render/live-stream.test.ts`) deterministic and hermetic.
- **Impact:** Pure structural refactor — byte-identical runtime behavior (same classification precedence, same mode-gating, same rolling-tail, same raw disk log, same `{kind,text}` tail). **No functional deviation; no change to any AC.** Files-touched inventory grows by one new source module + one new test file (both additive).

### DEV-04-2: Files-touched inventory expanded (additive only)

- **Original (spec text / Phase 4 cross-check):** `created: src/render/stream-theme.ts, src/render/stream-theme.test.ts; modified: src/extension.ts, src/render/dashboard.ts, src/render/dashboard-result.test.ts; deleted: none.`
- **Changed (implemented):** Also created `src/render/live-stream.ts`, `src/render/live-stream.test.ts`, `src/render/dashboard-result-perkind.test.ts`, `src/render/regression-guard.test.ts` (see DEV-04-1 for the live-stream rationale; the per-kind + regression-guard tests are the dedicated Phase 3 / Phase 4 coverage). `package-lock.json` updated.
- **Reason:** Testability and explicit per-phase coverage isolation.
- **Impact:** Additive only — no in-scope file was changed contrary to the constraints (nodes.ts / workflow.ts / pipeline.ts / stages/* / session-agent.ts / pi-spawn.ts / render templates all untouched). **No functional deviation.**

### Notes

- **Best-effort per-line backgrounds in the STREAMING (`onUpdate`) view are terminal-dependent** — the spec's Out-of-scope note is honored: the guaranteed-correct tool-bubble backgrounds live in `renderResult`'s Container `Text` `customBgFn` (Phase 3). The live stream paints fg per-kind in TUI mode and attempts command `bg` best-effort.
- **Non-TUI output is byte-clean** — print/json/RPC/headless emit raw `line.text` with ZERO ANSI (regression-guard test enforces this; AC-08).
