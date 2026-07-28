# Specification Review: Spec Review: pi Integration Modernization (05-specification.md)

- **Date**: 2026-07-28
- **Author**: super-dev:spec-reviewer

---

## Verdict: APPROVED WITH REVISIONS

Fagan-style content inspection of the pi Integration Modernization specification across 8 dimensions. The spec is exceptionally well-grounded: I verified 11 distinct code/API claims against the actual worktree and the installed @earendil-works/pi-coding-agent@0.82.1 type surface, and all 11 check out (grounding score 100%, well above the 90% HIGH bar). Confirmed: ^0.82.1 is committed in package.json peerDependencies; resolveThinking(agent, perCall?) exists at src/pi-spawn.ts:150 with the exact precedence the spec widens; controlSchema is all-Optional + additionalProperties:true at session-agent.ts:172; missingKeys + the structuredOutputTool schema-fallback exist; the `pi as unknown as { registerEntryRenderer? }` cast exists at extension.ts:656; BuildGateResult exists at build-runner/gates.ts:91; `ToolDefinition.constrainedSampling?: false | ConstrainedSamplingConfig` IS in the 0.82.1 types (extensions/types.d.ts:351); the typed public `registerEntryRenderer<T>(customType, renderer)` IS on ExtensionAPI (types.d.ts:903); createAgentSession options carry thinkingLevel/model; and PI_SESSION_ID/PI_MODEL are present in the 0.82.x bash tool runtime. All 12 ACs (AC-01..12) and all 20 BDD scenarios (SCENARIO-001..020) map cleanly to spec sections via the 5 phases, so the blocking coverage/traceability gate passes. The defects found are Medium/Low ambiguity issues concentrated in Feature 1's session-backend Model-object resolution and Feature 4's dual correlation representation — none are hallucinated references, infeasible architecture, or broken traceability. No critical, no high findings. Verdict: APPROVED WITH REVISIONS.

## Findings

### F-1: Feature 1: model-id → Model-object resolution for the session backend is unspecified

- **Severity**: medium
Feature 1 threads the inherited value as `ctx.model?.id` (a string) and says the session backend passes 'the resolved model via `createAgentSession({ model, thinkingLevel })`'. But createAgentSession's `model` option is typed `Model<any>` (agent-session.d.ts:168 `model: Model<any>`), NOT a string. The subprocess backend can take a bare id via `--model <id>`, but the in-process session backend must resolve the string id to a Model object. The spec's cross-cutting contracts mention 'model-id→Model resolution' as a no-throw capability but never name the resolution API (SDK model registry / getModel), where it is invoked, or its no-throw failure mode. SCENARIO-002/008 reference a 'model-id-cannot-resolve fall-through' yet the spec body defines neither the resolver nor its behavior. Recommendation: name the resolution function and specify that an unresolvable id degrades to the SDK/settings default (byte-identical to today) rather than throwing.
### F-2: Feature 4: 'header line AND/OR correlation field' is an unresolved internal inconsistency

- **Severity**: medium
Feature 4 specifies the correlation tag as 'a `# pi-session=<id> model=<model>` header line AND/OR an additive `correlation?: { sessionId?: string; model?: string }` field on BuildGateResult'. These are two materially different representations with different testability and byte-clean profiles. The Testing Strategy then asserts 'the correlation tag appears in captured output' (SCENARIO-016/017), which is only satisfiable by the header-line approach — a structured field on the result object would NOT appear in 'captured output'. The 'and/or' leaves the implementer to guess and makes SCENARIO-016/017 untestable as written if the field-only path is chosen. Recommendation: pick ONE canonical representation (header line, to satisfy the stated scenario) OR split into two scenarios with distinct assertions.
### F-3: Feature 1: 'resolve thinking ONCE / no double-apply' guard mechanism not specified

- **Severity**: low
Feature 1 asserts thinking is resolved ONCE and the retained best-effort `applyThinkingLevel` is 'guarded against double-application' alongside `createAgentSession({ thinkingLevel })`, and the Testing Strategy demands a test that 'applyThinkingLevel does not double-apply'. But the concrete guard is left to the implementer (e.g. skip applyThinkingLevel when thinkingLevel was passed to createAgentSession, vs. make createAgentSession authoritative and applyThinkingLevel a no-op, vs. a flag). The test asserts a behavior the spec never defines. Recommendation: state the precedence explicitly (e.g. 'when thinkingLevel is passed to createAgentSession, applyThinkingLevel is skipped').
### F-4: Feature 2: isStrictCapable relies on typebox Optional introspection that is not pinned

- **Severity**: low
`isStrictCapable(schema)` is defined as 'true ONLY for a typebox Object with ≥1 required non-Optional key AND additionalProperties === false'. In typebox 1.x (peer dep ^1.1.0), detecting a 'non-Optional' key requires inspecting the `[OptionalKind]` Symbol modifier on each property — a version-dependent, finicky introspection. The spec does not name the typebox guard API (e.g. TypeGuard.TObject + OptionalKind symbol check) the helper must use. The behavioral test cases (required+additionalProperties:false → true, all-Optional → false, additionalProperties:true → false, non-Object → false) pin behavior but not the implementation path. Recommendation: cite the specific typebox introspection so the helper is implementable without reverse-engineering.
### F-5: AC-12 / Testing Strategy: hardcoded '1437 tests' baseline is brittle and unverifiable from the spec

- **Severity**: low
The spec, requirements, and task-list all assert 'existing 1437 tests' as fact (AC-12). This number is plausible (78 test files) but is not confirmable from the spec itself and will drift on the first unrelated test addition, silently invalidating the cited baseline. AC-12's actual gate ('full vitest suite green') does not depend on the exact count. Recommendation: phrase as 'the existing vitest suite' or mark the count as approximate/as-of a commit, to avoid a false-failure impression when the number inevitably changes.
### F-6: Feature 2: constrainedSampling strict='prefer' provider-coverage rationale uncited

- **Severity**: low
Feature 2 chooses `strict: 'prefer'` and relies on the pi-internal contract that non-capable providers fall back to normal tool calling (it names 'glm/local' as non-capable) so the missingKeys corrective re-prompt still earns its keep. This fallback behavior is a pi-internal guarantee the spec depends on but does not cite a source for. The design degrades safely regardless, so impact is low, but the choice of 'prefer' over 'require' is only justified by this unstated contract. Recommendation: cite the pi behavior (or note that 'prefer' is chosen precisely because the design must not break non-capable providers).

## Dimension Reviews

### D1 Completeness

- **Status**: pass-with-notes

4/5. All 12 ACs (AC-01..12) have a spec section and all 20 BDD scenarios (SCENARIO-001..020) are addressed via the 5-phase decomposition. Error handling is pervasively specified (no-throw/best-effort). NFRs (byte-clean zero-ANSI, type-safety, no new casts) covered. Gap: the Model-object resolution path for the session backend (F-1) and the double-apply guard (F-3) are referenced but not defined.
### D2 Consistency

- **Status**: pass-with-notes

4/5. Names are uniform across sections (inheritedModel/inheritedThinking, resolveThinking precedence tiers, controlSchema/missingKeys/isStrictCapable, BuildGateResult/correlation). The one inconsistency is the Feature 4 'header line AND/OR correlation field' dual representation (F-2), which conflicts with its own SCENARIO-016/017 assertion.
### D3 Feasibility

- **Status**: pass-with-notes

4/5. Architecture fits the established two-backend specialist seam; additive option threading mirrors the existing resolveThinking pattern; constrainedSampling and registerEntryRenderer both confirmed present on the 0.82.1 public type surface. Feasibility nuance: createAgentSession wants a Model<any>, not a string id (F-1); isStrictCapable depends on typebox-1.x Symbol introspection (F-4).
### D4 Testability

- **Status**: pass-with-notes

4/5. ACs are measurable; the Testing Strategy maps each phase to concrete unit tests (precedence tiers, isStrictCapable truth table, requireNotContains cast removal, env-set/unset build-tag, CHANGELOG requireContains). Thresholds are mostly behavioral rather than numeric, which is appropriate for a no-output-change refactor. Weak spots: SCENARIO-016/017 assertion depends on the unresolved header-vs-field choice (F-2); 'no double-apply' test asserts unspecified behavior (F-3).
### D5 Traceability

- **Status**: pass

5/5. Unbroken chains: AC-01..05→Feature 1→SCENARIO-001..008; AC-06,07,08→Feature 2→SCENARIO-009..013; AC-09→Feature 3→SCENARIO-014,015; AC-10→Feature 4→SCENARIO-016,017; AC-11→Feature 5→SCENARIO-018; AC-12→cross-cutting→SCENARIO-019,020. The BDD Scenario References section lists all 20; phase data confirms the mapping. Phase ordering (1 before 2/3/4; 5 last) is consistent with shared-file dependencies.
### D6 Grounding

- **Status**: pass

5/5 — 100% (11/11 claims verified). ^0.82.1 committed (package.json); resolveThinking@pi-spawn.ts:150; controlSchema@session-agent.ts:172; missingKeys@session-agent.ts:179; structuredOutputTool schema fallback@session-agent.ts:241; registerEntryRenderer cast@extension.ts:656; BuildGateResult@gates.ts:91; constrainedSampling field@extensions/types.d.ts:351; typed registerEntryRenderer<T>@types.d.ts:903; createAgentSession model/thinkingLevel options@agent-session.d.ts; PI_SESSION_ID/PI_MODEL in bash runtime. No hallucinated references. The single source-unverified claim is the constrainedSampling 'prefer' provider-fallback contract (F-6).
### D7 Complexity

- **Status**: pass

5/5. Five small, independently-shippable, additive changes touching a bounded file set (extension.ts, types.ts, workflow.ts, pi-spawn.ts, session-agent.ts, build-runner/gates.ts, CHANGELOG.md). No new abstractions beyond a tiny isStrictCapable helper; no gold-plating; explicitly preserves the control-flow node algebra and resume cache untouched. Simplest viable approach for each feature.
### D8 Ambiguity

- **Status**: needs-work

3/5. Several load-bearing behaviors are named but not defined: (a) Feature 4 header-vs-field representation (F-2); (b) Feature 1 Model-object resolution + no-throw failure mode (F-1); (c) Feature 1 double-apply guard mechanism (F-3); (d) Feature 2 typebox Optional-introspection path (F-4). State transitions (precedence tiers) ARE explicit, error responses (no-throw) ARE specified, defaults ARE stated. Resolving the four ambiguity findings would raise this to 4-5.
