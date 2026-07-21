# Adversarial Review: Adversarial Review — Per-Stage Log Sections (spec-12)

- **Date**: 2025-07-22
- **Reviewer**: super-dev:adversarial-reviewer
- **Verdict**: CONTEST

---

Reviewed the spec-12 per-stage-log-sections implementation across live-stream.ts (sink tagging + per-stage flush sections), stage-grouping.ts (pure partitioner), dashboard.ts (per-stage §1 blocks + customBgFn backgrounds), stream-theme.ts (shared statusFgToken), and extension.ts (stream.sink.stage(info) wiring + id-tagged details.stages). Verification: `npm run typecheck` is strict-clean; `npm test` is fully green (1361/1361 across 80 files, including the new per-stage/grouping/section tests). The linchpin AC-05 wiring is correct and verified — `details.stages` is built with `id` (extension.ts:437) so the buildResultComponent `statusOf` resolver actually resolves; `stream.sink` is in scope at the single wiring point (extension.ts:392). Backward-compatible legacy fallback (groupByStage sentinel + hasStageTags gate) and the no-ANSI non-TUI contract are intact. Destructive-action gate: PASS (pure render code, no irreversible ops). No production-failure, data-loss, or security-breach risk found, so this is not a REJECT. However, several medium-severity quality concerns warrant an author response before merge: an unthrottled per-log flush that now runs a full groupByStage+render on every line; a fragile heuristic in the sink's phase-line re-tag; a layering inversion (the shared DashboardTheme type lives in the dashboard aggregator and is consumed by lower-level primitives); an over-engineered four-knob cap system; and comment density well past the point of diminishing returns.

### ADV-01: flush() runs the full groupByStage + section-stack render on EVERY log/phase line (unthrottled hot path)

- **Severity**: medium
- **Lens**: Skeptic
In extension.ts the `log` and `phase` handlers call `flush()` directly (lines 373-374: `renderDashboardThrottled()` is used for the dashboard widget, but `flush()` itself is NOT throttled). Pre-change, flush joined a bounded tail string; now each call partitions up to PARTITION_INPUT_CAP (4000) entries via groupByStage, synthesizes empty-stage headers, themes every line, and re-joins. On a chatty implementation stage emitting thousands of log lines this is O(4000) work per emitted line. The caps bound the worst case so it won't hang, but the per-log cost has materially increased on the streaming hot path. Recommend throttling flush() the same way renderDashboard is throttled, or debouncing section-stack renders. file: src/extension.ts:373-374, src/render/live-stream.ts flushSectionStack.
### ADV-02: sink stage() re-tag relies on a magic scan-back window of 4 — silent mis-grouping if control-flow emit ordering changes

- **Severity**: medium
- **Lens**: Skeptic
The phase-before-stage correction (RESOLVED-1) scans back `Math.max(0, transcript.length - 4)` entries to find the most-recent matching phase line and re-tag it. This is an undocumented, un-enforced coupling between sink internals and control-flow's emit ordering: if control-flow ever emits >4 entries between `phase(▶ Stage N)` and `stage:{running}` (e.g. several interim log commits or finalizeLive pushes), the phase banner silently retains the PREVIOUS stage's tag and lands in the wrong section. Today control-flow guarantees adjacency so it works, but the assumption lives only in a comment. Recommend either (a) documenting the invariant as a contract on the sink.stage() JSDoc and adding a regression test that injects N>4 intervening entries to pin the failure mode, or (b) tracking the last phase line index explicitly instead of scanning. file: src/render/live-stream.ts sink.stage().
### ADV-03: Layering inversion: shared DashboardTheme type is defined in dashboard.ts and consumed by lower-level primitives

- **Severity**: medium
- **Lens**: Architect
`DashboardTheme` (the theme contract now used by 3+ modules) is declared in dashboard.ts. As a result `stream-theme.ts` — a pure low-level theming primitive — does `import type { DashboardTheme } from "./dashboard.js"`, and `live-stream.ts` depends on `./dashboard.js` for BOTH the type and the `runningGlyph` VALUE. The stream-theme→dashboard side is `import type` (erased, so no runtime cycle and typecheck is clean), but it still inverts the natural layering: primitives should not reach into an aggregator module for a shared contract. Recommend hoisting `DashboardTheme` (and arguably the shared `runningGlyph`/`RUNNING_FRAMES` glyphs) into a neutral module (e.g. a `theme-types.ts` or into stream-theme.ts) so the dependency arrow points the right way. file: src/render/stream-theme.ts:25, src/render/live-stream.ts:31, src/render/dashboard.ts (DashboardTheme decl).
### ADV-04: dashboard.ts is becoming a grab-bag: widget factory + result component + shared theme type + glyph/trunc utilities co-located

- **Severity**: low
- **Lens**: Architect
dashboard.ts now holds: the live-dashboard widget factory (createDashboardWidgetFactory/buildDashboardWidget), the completed-run result view (buildResultComponent + ResultDetails), the DashboardTheme type, the runningGlyph/runningSeed/RUNNING_FRAMES animation primitives, and the truncLine/padTruncate/truncateActivity utilities. Two distinct rendering surfaces (live widget vs completed-run result) plus shared infrastructure share one module, and every per-stage change lands here. Cohesion is declining. Consider splitting `dashboard-widget.ts` from `dashboard-result.ts` (with the shared theme-type/glyphs factored out per ADV-03). file: src/render/dashboard.ts.
### ADV-05: Duplicated empty-stage synthesis + divergent expand/compact policy between the live and result surfaces

- **Severity**: low
- **Lens**: Architect
The 'synthesize a header-only group for a stage that emitted a stage event but zero log lines' logic is implemented TWICE: in live-stream.ts (stageMeta iteration) and in dashboard.ts (details.stages iteration). The expand/compact policies also differ and are not obviously consistent: the live view caps running at RUNNING_TAIL_LINES=15 and completed at COMPLETED_TAIL_LINES=3, while the result view expands ALL lines for failed/running and shows only the last 1 line for completed. These two surfaces will drift independently over time. Recommend extracting a shared 'stage presentation policy' helper, or at minimum documenting that the two are intentionally different. file: src/render/live-stream.ts flushSectionStack, src/render/dashboard.ts buildResultComponent.
### ADV-06: Four-knob cap system + 'drop-whole-leading-sections' accounting is over-engineered for the actual 13-stage scale

- **Severity**: medium
- **Lens**: Minimalist
The live body is bounded by FOUR interlocking constants (RUNNING_TAIL_LINES=15, COMPLETED_TAIL_LINES=3, TOTAL_SECTION_CAP=400, PARTITION_INPUT_CAP=4000) plus a loop that drops whole leading sections while re-counting emitted separators ('this section + the separator after it'). The spec itself flags the 100-stage pathological case as hypothetical; the real pipeline is 13 stages. This is a lot of moving machinery — and a non-trivial accounting loop with a comment correcting a prior off-by-one — to defend against a case that does not occur in production. One aggregate cap (or simply trusting per-stage caps) would likely suffice. Recommend simplifying to at most two knobs and deleting the section-dropping accounting unless a concrete large-run workload is shown. file: src/render/live-stream.ts constants + flushSectionStack aggregate-cap loop.
### ADV-07: Comment density ~50%+ with spec-ID archaeology (RESOLVED-x, SCENARIO-xxx, AC-xx) — token-expensive and reader-hostile

- **Severity**: medium
- **Lens**: Minimalist
live-stream.ts (~580 lines) and dashboard.ts carry extensive prose in which nearly every constant and branch cites spec scenario/resolution IDs meaningful only to the spec author (e.g. 'research RESOLVED-1', 'SCENARIO-012', 'AC-04/AC-05'). This is well past the point of diminishing returns: it inflates the files for reviewers and LLMs, and the cross-references will rot as the spec doc evolves. Keep the 'why' (especially the method-style theme.fg class-`this` gotcha, which is genuinely load-bearing) and drop the spec-archaeology. file: src/render/live-stream.ts, src/render/dashboard.ts throughout.
### ADV-08: Dual flush paths (flushRollingTail vs flushSectionStack) gated by stageReceived — the sentinel group could unify them

- **Severity**: low
- **Lens**: Minimalist
flush() branches on `stageReceived`: pre-first-stage-event it emits the legacy rolling-tail joined text; after, the per-stage section stack. This produces a visible mid-run discontinuity (flat transcript → sectioned headers) and duplicates the trim-notice logic. Since groupByStage already coalesces everything into a single sentinel 'setup'/'pre-stage' group when no stage tags are present, a single section-stack path (sentinel group renders as one section) would remove the branch, the duplicated trim logic, and the mid-run visual jump. file: src/render/live-stream.ts flush()/flushRollingTail/flushSectionStack.
### ADV-09: Cosmetic glyph/color mismatch in result view for untracked (undefined) status

- **Severity**: low
- **Lens**: Skeptic
In buildResultComponent, an untracked stage (status undefined) renders via stageBlockGlyph(undefined) → '·' (a dim neutral dot) but is COLORED via statusThemeToken(undefined) → statusFgToken(undefined) → 'accent' (the running/in-progress color). So the glyph says 'neutral' while the color says 'running'. The streaming view is internally consistent here (accent header + animated/● glyph). The result view's choice is defensible (do-not-mask-as-ok) but the glyph and color disagree. Recommend stageBlockGlyph(undefined) returning a glyph that matches the accent/in-progress intent (e.g. '●'), or documenting the intentional split. file: src/render/dashboard.ts stageBlockGlyph + statusThemeToken.
