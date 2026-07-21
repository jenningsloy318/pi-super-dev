# Specification Review: Spec Review — Per-Stage Log Sections (spec-12)

- **Date**: 2026-07-21
- **Author**: super-dev:spec-reviewer

---

## Verdict: REVISIONS NEEDED

The spec is architecturally sound and exceptionally well-traced at the AC→scenario level (7/7 ACs covered, 24/24 scenarios mapped, additive types, no new deps, explicit NON-GOALS). The pure-helper discipline (groupByStage with injected statusOf, method-style theme access, byte-clean non-TUI regression) is feasible and matches existing repo patterns. HOWEVER, the grounding dimension fails the 90% bar: three named symbols the spec treats as pre-existing (`customBgFnOf`, `withRealTheme`, and the `toolSuccessBg`/`toolErrorBg` background tokens) are hallucinated or unverified against the actual codebase, and the headline `statusOf`→id→status resolver chain is broken at the `ResultDetails.stages` type boundary (typed `{label,status}` with no `id`). These are not cosmetic — two directly gate the load-bearing AC-04 status-background feature and the entire test harness. No ACs are uncovered (so not REJECTED), but with >3 HIGH findings and a sub-90% grounding score, the verdict is REVISIONS NEEDED before implementation.

## Findings

### F-01: Hallucinated test helper `customBgFnOf` — does not exist in the codebase

- **Severity**: high
Testing Strategy + prior-stage Phase 6 state: 'the existing `customBgFnOf(child)` parity helper (already used for command-bubble assertions) is reused to read the 4th-arg background function per child Text.' Grep across src/ and tests/ finds NO `customBgFnOf`. The actual parity helper is an unexported LOCAL `function n(child)` inside `tests/render/dashboard-result-perkind.test.ts` (used as `n(found!.child)`). An implementer following the spec will search for `customBgFnOf`, fail, and either re-invent or break the AC-04/SCENARIO-015 assertions. Recommendation: rename the reference to the real local `n`, or extract/promote it to a named exported `customBgFnOf` and state that as an explicit sub-task (it is currently NOT 'existing'). Lens: D6 Grounding / D5 Traceability.
### F-02: Hallucinated `withRealTheme` symbol — real harness exports `ln<T>`

- **Severity**: high
Requirements AC-06, NFR 'Theme safety', and spec Testing Strategy all reference `tests/helpers/real-theme.ts#withRealTheme`. That module exports `export function ln<T>(fn: (theme: Theme) => T): T` — there is NO `withRealTheme`. The parity test itself imports `{ ln } from "../helpers/real-theme.ts"` and uses `ln((theme) => theme.bg("toolPendingBg", "x"))`. Recommendation: replace every `withRealTheme` reference with the real `ln` harness (the this-bound generic Theme executor), or add an explicit `withRealTheme` alias task. As written, the referenced symbol cannot be imported. Lens: D6 Grounding.
### F-03: Unverified background tokens `toolSuccessBg` / `toolErrorBg` gate the headline AC-04 feature

- **Severity**: high
AC-04, NFR, and PILLAR 4 pin the entire status-colored-background design on `theme.bg("toolPendingBg"|"toolSuccessBg"|"toolErrorBg")`. Only `toolPendingBg` is referenced anywhere in the repo (once, in `tests/render/real-theme-parity.test.ts`, implying it is a valid real Theme token). `toolSuccessBg` and `toolErrorBg` have ZERO references in src/ or tests/ — their existence in the real pi Theme token set is unverified. If either is absent, AC-04/SCENARIO-015 is infeasible as written and the 'pi-native tool-bubble look' cannot be reproduced via the public API. Recommendation: before implementation, assert all three tokens resolve under the real Theme (extend the existing `ln((theme)=>theme.bg("toolSuccessBg",...))` parity assertion); if any is missing, fall back to the proven single `"n"` token already used by `commandBackground` in `src/render/stream-theme.ts`. Lens: D6 Grounding / D3 Feasibility.
### F-04: Broken `statusOf` traceability — `ResultDetails.stages` has no `id` field

- **Severity**: high
PILLAR 4 specifies a `statusOf` resolver 'mapped id→status' from `details.stages`, and `groupByStage`'s `statusOf?: (stageId)=>string` keys on stageId. But `ResultDetails.stages` is typed `Array<{ label: string; status: string }>` (src/render/dashboard.ts:322) with NO `id`, and `extension.ts` renderResult casts `d.stages` the same way (`Array<{label,status}>`, L462) even though the runtime object built at L429 (`{id,label,status}`) carries `id`. So an id→status Map cannot be constructed from the DECLARED type without a widening the spec never mentions (it only additively widens `transcriptTail`). Recommendation: explicitly widen `ResultDetails.stages` to `Array<{id;label;status}>` (additive, like transcriptTail), OR change the resolver to label→status and document the stageId↔stageLabel equivalence. Note prior-stage Phase 4 already self-contradicts by saying 'mapped stageLabel→status' while the spec body says 'id→status' — pick one and make the type match. Lens: D5 Traceability / D2 Consistency.
### F-05: Requirements↔spec contradiction: AC-01 says `phase(label)` updates the stage; spec resolves via the `stage` event

- **Severity**: medium
Requirements AC-01 states '`phase(label)` updates it on each banner.' The spec (PILLAR 1, SCENARIO-004, research RESOLVED-1) instead resolves stageId from the STRUCTURED `stage` event and RE-TAGS the most-recent phase line to fix the phase-before-stage emit ordering — `phase()` no longer sets the stage. The spec's design is correct and superior, but it silently supersedes a literal AC-01 requirement without flagging the deviation, leaving the traceability chain (AC-01 → spec) inconsistent. Recommendation: amend AC-01's wording to 'the structured `stage` event updates currentStageId/Label; `phase` is re-tagged for ordering' so AC↔spec agree. Lens: D2 Consistency / D5 Traceability.
### F-06: `TOTAL_SECTION_CAP` has no numeric value — testability/ambiguity gap

- **Severity**: medium
AC-03 and the NFR require 'a total cap' / 'TOTAL_CAP' bounding aggregate flush cost so it stays O(visible lines); the spec names `TOTAL_SECTION_CAP` but gives no numeric value anywhere, while sibling constants (`RUNNING_TAIL_LINES=15`, `COMPLETED_TAIL_LINES=3`) ARE numeric. An unquantified cap is not a measurable acceptance criterion (D4) and leaves an ambiguous default (D8). Recommendation: state an explicit value (e.g. cap total rendered section lines) and add a test asserting flush never exceeds it. Lens: D4 Testability / D8 Ambiguity.
### F-07: Stale nodes.ts line citation (L123 vs actual L126)

- **Severity**: low
The spec cites the phase emit at 'nodes.ts L123' and stage at 'L127'. Actual sites: `ctx.events.emit("phase", stage.label)` at src/nodes.ts:126 and `ctx.events.emit("stage", {id,label,status:"running"})` at L127. The load-bearing ORDERING claim (phase strictly before stage) is CORRECT and verified; only the line citation is stale. Recommendation: update to L126/L127. Lens: D6 Grounding (cosmetic).
### F-08: Default `setup` stageId collides with the legacy-fallback sentinel

- **Severity**: low
The default `currentStageId="setup"` (genuine pre-stage entries) and the `groupByStage` legacy/untagged fallback sentinel (`stageId:"setup"`, `stageLabel:"pre-stage"`) are the SAME id. Consequently genuine pre-stage lines and legacy untagged/string entries merge into one indistinguishable 'pre-stage' section. This is acceptable for rendering (matches today's merged behavior, which is the stated goal) but conflates two semantics; a future reader may misread it. Recommendation: one-line note in the spec that this conflation is intentional (fallback deliberately reuses the setup id). Lens: D8 Ambiguity.

## Dimension Reviews

### D1 Completeness

- **Status**: pass

All 7 ACs have a dedicated spec PILLAR; all 24 scenarios mapped to an AC; error/legacy fallback paths specified (SCENARIO-007/017/020); NFRs (perf caps, theme safety, backward-compat, maintainability) all addressed. Minor gaps: TOTAL_SECTION_CAP value unspecified (F-06); ResultDetails.stages id-widening not mentioned (F-04). Score 4/5.
### D2 Consistency

- **Status**: needs_work

stageId↔id↔label mapping has friction: statusOf keys on stageId but ResultDetails.stages is typed by {label,status} with no id (F-04); requirements AC-01 ('phase updates it') contradicts the spec's 'stage-event resolves it' design (F-05); prior-stage Phase 4 says stageLabel→status while spec body says id→status. Terminology otherwise uniform. Score 3/5.
### D3 Feasibility

- **Status**: pass

Architecture fits the existing pure-helper discipline (groupByStage with injected statusOf mirrors stream-theme.ts); phases are explicitly parallelizable on disjoint files; additive type widening; no new runtime deps; no control-flow/change-tracker/backend/widget changes. Only feasibility risk is the unverified toolSuccessBg/toolErrorBg tokens (F-03). Score 4/5.
### D4 Testability

- **Status**: needs_work

ACs are mostly measurable with named numeric constants (RUNNING_TAIL_LINES=15, COMPLETED_TAIL_LINES=3) and a concrete test file list per AC. But TOTAL_SECTION_CAP has no numeric value (F-06), and two referenced test helpers are wrong-named/non-existent (customBgFnOf F-01, withRealTheme F-02), so the stated test strategy cannot be executed verbatim. Score 3/5.
### D5 Traceability

- **Status**: needs_work

The AC→spec→scenario matrix is excellent and explicit (coverage summary 7/7 ACs, 24/24 scenarios, full traceability block). However the statusOf(stageId)→details.stages chain breaks at the type boundary because stages lacks `id` (F-04), and AC-01↔spec diverge on the stage-resolution mechanism (F-05). Score 3/5.
### D6 Grounding

- **Status**: fail

Score ~75-80% (below the 90% bar => HIGH). Verified: TranscriptLine {kind,text} shape, LiveStreamSink surface, nodes.ts phase-before-stage ordering, commandBackground/themeLine/classifyLine, buildResultComponent, ResultDetails.transcriptTail, extension.ts stage handler + dashboardStages, stream-theme-class-theme.test.ts:67, real-theme-parity.test.ts existence, Text 4th-arg customBgFn via commandBackground, toolPendingBg token (via parity test). FAILED/UNVERIFIED: customBgFnOf (F-01), withRealTheme (F-02), toolSuccessBg+toolErrorBg tokens (F-03), details.stages id field (F-04), stale nodes.ts line (F-07). Score 2/5.
### D7 Complexity

- **Status**: pass

Simplest viable approach throughout: additive type widening, dependency-free pure partitioner with injected statusOf (no dashboard import), explicitly rejects a collapse map (RESOLVED-2 'don't over-engineer'), reuses existing themeLine/commandBackground/customBgFn rather than inventing renderers, compact-completed/expanded-running avoids interactive Ctrl+O (correctly deferred as future). File count proportional to the change. No gold-plating. Score 5/5.
### D8 Ambiguity

- **Status**: needs_work

API shapes are mostly defined (TranscriptLine, StageGroup, statusOf signature, additive transcriptTail union). But: TOTAL_SECTION_CAP value unspecified (F-06); statusOf resolver mapping ambiguous id-vs-label (F-04); toolSuccessBg/toolErrorBg token semantics unverified (F-03); default `setup` id intentionally collides with the legacy sentinel (F-08, needs a one-line note). Score 3/5.
