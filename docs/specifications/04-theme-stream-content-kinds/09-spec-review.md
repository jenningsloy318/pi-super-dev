# Specification Review: Spec Review: pi-native Stream Content-Kind Theming (04-theme-stream-content-kinds)

- **Date**: 2025-07-20
- **Author**: super-dev:spec-reviewer

---

## Verdict: REVISIONS NEEDED

The specification is technically sound and exceptionally well-grounded — every load-bearing reference (file paths, line numbers, the pi-tui Text 4th `customBgFn` argument, the real Theme tokens `toolTitle`/`toolSuccessBg`/`toolPendingBg`/`thinkingText`, and the exact stream-content prefixes `→ `/`→ structured_output ✓`/`↻ ` produced by session-agent.ts:122/:143/:277 and pi-spawn.ts:172) was verified against the actual codebase and is accurate. The layered architecture (pure stream-theme module + sink-layer tagging + render-time tool-bubble Text) is feasible and adds no dependencies. However, the spec is NOT acceptance-testable as written: AC-01..AC-10 and BDD SCENARIO-001..018 are referenced by ID throughout (16+ times) but NEVER DEFINED — no acceptance-criteria table and no Given/When/Then content, so the AC→spec→scenario traceability chain cannot be constructed from this document alone (only inferable from the out-of-band phase descriptions). Three smaller gaps remain: the backward-tolerant `transcriptTail` union type is under-specified, `classifyLine` behavior on empty/multiline input is undefined, and the live-stream "best-effort tool-bubble background" conflates a joined-string body with a Text-component `customBgFn` rendering path. Grounding score: ~100% on load-bearing claims (16/16 verified, 0 hallucinated). Fix the AC/scenario definitions and the three ambiguities and this is approvable.

## Findings

### F1: Acceptance criteria (AC-01..AC-10) and BDD scenarios (SCENARIO-001..018) are referenced 16+ times but never defined

- **Severity**: high
The spec invokes 'AC-01..AC-10' and 'SCENARIO-001..018' pervasively (Summary, Testing Strategy, BDD Scenario References, Phases) but contains NO acceptance-criteria table and NO Given/When/Then scenario content — only a bare list of 18 scenario IDs. A reviewer or implementer reading only this document cannot determine what AC-04 requires, which scenario satisfies it, or what observable condition proves it. This breaks the D5 traceability chain (AC→spec section→scenario) and makes the 'Acceptance is met when AC-01..AC-10 are each demonstrable from a passing assertion' clause unverifiable. The out-of-band Phase descriptions (Phase1=AC01-03/SCN001-007, Phase2=AC04-06/SCN008-013, Phase3=AC07/SCN014, Phase4=AC08-10/SCN015-018) partially bridge the gap but are not part of this spec. RECOMMENDATION: add an explicit AC table (ID → measurable condition → covering spec section → scenario ID) and at least a one-line Given/When/Then per scenario. Until the ACs exist as defined entities, this is functionally 'uncovered ACs'.
### F2: Backward-tolerant transcriptTail type is under-specified (union vs runtime narrowing)

- **Severity**: medium
Architecture(2) states ResultDetails.transcriptTail (dashboard.ts:292, currently `transcriptTail?: string[]`) changes to `Array<{ kind: LineKind; text: string }>` 'with a backward-tolerant consumer: a plain string element defaults to kind "log"'. It is left ambiguous whether the DECLARED type is a union (`Array<{kind,text} | string>`) or `Array<{kind,text}>` with the consumer doing `typeof line === 'string'` runtime narrowing on an `unknown`-ish element. The existing dashboard-result test (dashboard-result.test.ts:79) already feeds `transcriptTail: [...]`; the spec must state which so strict typecheck stays clean. RECOMMENDATION: declare `transcriptTail?: Array<{ kind: LineKind; text: string } | string>` and specify the narrowing rule explicitly in both extension.ts:295 and dashboard.ts:292.
### F3: classifyLine behavior on empty string and embedded newlines is undefined

- **Severity**: medium
classifyLine(text: string): LineKind has a precedence ladder ending in 'leading indented or plain text → log', but never defines (a) the result for an empty string ('' after trim), and (b) behavior when sink.log is called with a multi-line message (the body would contain embedded '\n', and the `→ ` prefix check would only see the first line). The test plan covers 'one assertion per LineKind' but omits these two edge cases. RECOMMENDATION: specify empty-string → 'log' (or 'trim') and either (i) classify only the first line and note multiline is split upstream, or (ii) split-and-classify. Add an assertion for each.
### F4: Live-stream 'best-effort tool-bubble background' conflates a joined-string body with the Text customBgFn path

- **Severity**: medium
Architecture(3) says in flush() 'command lines additionally get a best-effort tool-bubble background (terminal-dependent — guaranteed-correct backgrounds live in renderResult's Container Text customBgFn)'. But flush() builds a JOINED STRING passed to onUpdate — there is no Text component to receive the 4th `customBgFn` argument there. The customBgFn (commandBackground) is inherently a pi-tui Text-constructor concept and only applies in renderResult/buildResultComponent. The live path can only embed theme.bg() ANSI inline, which is a different mechanism from commandBackground's returned function. The spec should state explicitly how (or whether) command backgrounds appear in the LIVE stream, or explicitly defer all backgrounds to renderResult. As written it reads as if commandBackground is reused in flush, which is not type-correct.
### F5: command-done classification hard-couples to the literal 'structured_output ✓' produced by summarize() with no fragility note or coupling test

- **Severity**: low
classifyLine's command-done rule matches the exact string `→ structured_output ✓`, which only exists because session-agent.ts:143 (summarize) returns 'structured_output ✓' for the structured_output tool and session-agent.ts:122 prepends '→ '. This is a latent cross-file coupling: if summarize() is renamed/refactored, command-done silently degrades to plain command (no test failure unless a dedicated coupling assertion exists). The design (sink-layer prefix classification) inherently requires this, but the spec should (a) note the coupling explicitly and (b) add a regression test pinning that summarize('structured_output', ...) === 'structured_output ✓'.

## Dimension Reviews

### D1 Completeness

- **Status**: NEEDS WORK

Score 2/5. Testing strategy is detailed and three-layered, but the 10 acceptance criteria and 18 BDD scenarios are referenced by ID only and never defined — the core completeness requirement (every AC has a spec section) cannot be discharged. classifyLine empty/multiline edge cases are unspecified. Error-handling path (❌ catch) and NFR 'zero ANSI in non-TUI' ARE covered well.
### D2 Consistency

- **Status**: WARNING

Score 4/5. Terminology, LineKind names, and token strings are uniform across sections. The one inconsistency is the live-stream 'best-effort background' phrasing, which blurs the joined-string onUpdate body vs the Text customBgFn render path (F4).
### D3 Feasibility

- **Status**: PASS

Score 4/5. Strongly feasible. VERIFIED: pi-tui Text constructor accepts the 4th `customBgFn` arg; real Theme exposes fg('toolTitle'/'thinkingText'/...) and bg('toolSuccessBg'/'toolPendingBg'); emit sites already produce the → /↻ /→ structured_output ✓ prefixes the classifier relies on. Pure module imports only the structural DashboardTheme shape (no TUI runtime) — no circular deps. Extension of DashboardTheme with optional bg() is non-breaking. Only F4's live-background wording needs sharpening.
### D4 Testability

- **Status**: WARNING

Score 3/5. The per-kind unit assertions, no-ANSI-leak regex (/\x1b\[/i), and customBgFn-non-undefined checks are concrete and testable. But because ACs are undefined (F1), they are not individually measurable; the only numeric threshold stated is 'zero ANSI escape bytes'. Numeric acceptance thresholds for the ACs are absent.
### D5 Traceability

- **Status**: NEEDS WORK

Score 2/5. AC→spec→scenario chain is broken: neither AC-01..AC-10 nor SCENARIO-001..018 have defined content in this document (F1). The phase-level mapping supplied out-of-band partially restores it but is not part of the spec. F5 flags an undocumented cross-file coupling between classifyLine and session-agent.ts:143. Grounding of code references themselves is excellent (see D6).
### D6 Grounding

- **Status**: PASS

Score 5/5 (~100% on load-bearing claims). Verified against codebase: extension.ts:158 transcript string[], :229 sink.log '  ' indent, :262 disk write transcript.join('\n'), :278 transcriptTail slice(-50), :295 local type; dashboard.ts:31 DashboardTheme, :292 transcriptTail?: string[], :338-343 §1 loop; pi-tui text.d.ts constructor(text?,paddingX?,paddingY?,customBgFn?); Theme tokens toolTitle (ls/grep/write.js), toolSuccessBg/toolPendingBg (edit.js bg()), thinkingText (theme files); emit prefixes → (session-agent.ts:122, pi-spawn.ts:172), structured_output ✓ (session-agent.ts:137-148 summarize), ↻ (session-agent.ts:277). Zero hallucinated references.
### D7 Complexity

- **Status**: PASS

Score 5/5. Minimal footprint: 3 source files (1 new pure module + 2 edits) + 3 test files. No new dependencies. Pure classification logic isolated from TUI runtime (unit-testable with a structural mock). Backward-compatible shape change with consumer tolerance. Simplest viable approach that satisfies the byte-clean non-TUI contract.
### D8 Ambiguity

- **Status**: WARNING

Score 3/5. Most defaults ARE stated (undefined theme → raw text/zero ANSI; plain string → kind 'log'; precedence order is explicit). Gaps: transcriptTail union type (F2), classifyLine empty/multiline (F3), and live-background mechanism (F4). State transitions for transcript kind tagging are explicit and correct.
