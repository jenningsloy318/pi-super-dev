# Specification: Technical Specification: pi Integration Modernization — Main-Session Model/Thinking Inheritance, Constrained Sampling for structured_output, Typed registerEntryRenderer, and Bash Session-Env Build Tagging

- **Date**: 2026-07-28

---

## Summary

Modernize the pi-super-dev pi-extension on the already-bumped `@earendil-works/pi-coding-agent@^0.82.1` toolchain in five cohesive, independently-shippable changes. (1) HIGHEST leverage: every spawned specialist inherits the live main session's model + thinking level, threaded as additive `inheritedModel`/`inheritedThinking` DEFAULTS through the existing option chain (extension.execute → RunOptions → realAgent.common → both backends), with explicit params and SUPER_DEV_* env still winning and a widened `resolveThinking`/model precedence chain. (2) Adopt pi 0.82.0 `ToolDefinition.constrainedSampling: { type: "json_schema", strict: "prefer" }` on the `structured_output` tool, gated by a small `isStrictCapable(schema)` helper, while keeping `missingKeys()` + the single corrective re-prompt as the non-capable-provider/permissive-schema fallback. (3) Delete the `registerEntryRenderer` `as unknown as` capability cast now that it is typed on the 0.82.1 public API. (4) Tag build-gate runs with pi's `PI_SESSION_ID`/`PI_MODEL` env vars for parallel-run correlation (observability-only). (5) CHANGELOG. Every change preserves the load-bearing no-throw/best-effort discipline and the print/json/rpc/headless zero-ANSI byte-clean contract; all changes are additive and never clobber an explicit user/LLM/env override. Verification is `npm run typecheck` strict-clean + the full vitest suite (1437 + new tests) green.

## Architecture

pi-super-dev is an ESM TypeScript *pi-extension* package that runs INSIDE the `pi` agent and executes a 13-stage dev pipeline by spawning specialist `pi` agents. The change set is layered across the existing specialist-execution architecture without touching the control-flow node algebra (`nodes.ts`), the resume cache, or the pipeline stage structure.

SPECIALIST EXECUTION SEAM. The architecture to extend is: `extension.ts` registers the `super_dev` tool + `/super-dev` command; its `execute()` calls `runPipelineTask(task, {...})` (`pipeline.ts`) which carries a single `RunOptions` object (src/types.ts) down to `makeContext`/`realAgent` in `workflow.ts`. `realAgent` builds ONE shared `common` options object and dispatches to one of TWO backends: `spawnAgent` (`pi-spawn.ts`, raw `pi` subprocess, NDJSON stdout, `<control>` text) or `runAgentViaSession` (`session-agent.ts`, in-process `createAgentSession`, schema-validated `structured_output` tool). The `common` object deliberately carries cross-backend fields (e.g. `controlKeys` "Ignored by the subprocess backend … so the same common options object can feed both backends"), so ADDITIVE option fields propagate to both backends for free — this is the core seam for Feature 1.

FEATURE 1 — MODEL/THINKING INHERITANCE (the load-bearing change). Today `extension.execute()` never reads `ctx.model` / `ctx.thinkingLevel`, so specialists resolve model and thinking independently (explicit param → SUPER_DEV_* env → role default). The fix threads two additive DEFAULTS — `inheritedModel?: string` and `inheritedThinking?: ThinkingLevel` — through the full chain: (a) capture `ctx.model?.id` and `ctx.thinkingLevel` defensively (optional chaining; never throw on older/non-TUI ctx) inside `execute()` BEFORE `runPipelineTask(...)` and pass them as `inheritedModel`/`inheritedThinking` in the options; (b) add both fields to `RunOptions` (additive, optional); (c) forward them from `realAgent`'s `common` object; (d) `SpawnAgentOptions`/`SessionAgentOptions` gain the same additive fields. THINKING: widen `resolveThinking(agent, perCall?, inherited?)` precedence to `per-call → SUPER_DEV_THINKING env → INHERITED (ctx.thinkingLevel) → role default`, and resolve thinking ONCE so the session backend does not double-apply. MODEL: precedence `explicit opts.model → SUPER_DEV_MODEL env (NEW) → inherited ctx.model.id → SDK/settings default`, preserving the existing `buildSpawnArgs` rule that `--model` is pushed ONLY when a model resolves. Session backend: pass the resolved model via `createAgentSession({ model, thinkingLevel })` (the canonical 0.82.x option path) as a SECOND line of defense alongside the retained best-effort `applyThinkingLevel(session, …)`, guarded against double-application. Inheritance is ADDITIVE-only — it never overrides an explicit `params.model`, a `SUPER_DEV_MODEL`/`SUPER_DEV_THINKING` env var, or a per-call override; older ctx (no model/thinking) degrades byte-identically to today.

FEATURE 2 — CONSTRAINED SAMPLING. `session-agent.ts` carries a structured-output workaround (`controlSchema(keys)` declares keys as `Optional(Type.Any())` with `additionalProperties: true`; `missingKeys()` + a single corrective re-prompt turn self-heal partial fills) precisely because models do not reliably fill schemas. pi 0.82.0 added `ToolDefinition.constrainedSampling?: false | { type: "json_schema"; strict: "prefer" | "require" }`. The fix introduces a strict-capable schema variant (`Type.Object({ …required typed keys… }, { additionalProperties: false })`) and a small `isStrictCapable(schema)` helper (true ONLY for a typebox Object with ≥1 required non-Optional key AND `additionalProperties === false`). `structuredOutputTool` sets `constrainedSampling: { type: "json_schema", strict: "prefer" }` ONLY when `isStrictCapable` holds (typed against the 0.82.1 `ToolDefinition`); it is NEVER attached to a permissive schema (the current all-Optional controlSchema, or any open/unknown-key schema), avoiding provider no-ops/confusion. The permissive controlSchema + `missingKeys()` corrective re-prompt machinery is PRESERVED byte-identical as the fallback for non-capable providers (glm/local) and permissive schemas — strict `prefer` falls back to normal tool calling there, so the corrective path still earns its keep.

FEATURE 3 — TYPED registerEntryRenderer (pure cleanup). `extension.ts` casts `pi as unknown as { registerEntryRenderer?: … }` because the method was absent from the pinned 0.80.3 type surface. As of 0.82.1 it is public on `ExtensionAPI`: `registerEntryRenderer<T>(customType: string, renderer: EntryRenderer<T>): void`. The cast is deleted and `pi.registerEntryRenderer("super-dev-summary", …)` is called directly with proper types (importing `EntryRenderer`/`EntryRenderOptions` from `@earendil-works/pi-coding-agent` where helpful), keeping the existing try/catch best-effort guard and the durable background-summary transcript-card rendering.

FEATURE 4 — BASH SESSION-ENV TAGGING (observability-only). pi 0.82.0 exposes `PI_SESSION_ID`, `PI_SESSION_FILE`, `PI_PROVIDER`, `PI_MODEL`, `PI_REASONING_LEVEL` to commands run by built-in bash tools. `build-runner/gates.ts` `runBuildGate`/`BuildGateResult` capture build/test/typecheck stdout/stderr. The fix reads `process.env.PI_SESSION_ID` and `process.env.PI_MODEL` DEFENSIVELY and, when present, includes them as a plain-ASCII correlation tag in the captured build-run metadata (a `# pi-session=<id> model=<model>` header line and/or an additive `correlation?: { sessionId?: string; model?: string }` field on `BuildGateResult`). No-throw when absent; byte-identical when absent; does NOT alter gate pass/fail logic, command construction, or timeout behavior.

CROSS-CUTTING CONTRACTS. (1) No-throw/best-effort: every new capability read (ctx.model/thinking, model-id→Model resolution, createAgentSession options, constrainedSampling gating, PI_* env reads, registerEntryRenderer) is try/catch-guarded or feature-detected and degrades to current behavior. (2) Zero-ANSI byte-clean for print/json/rpc/headless: all new output (PI_* correlation tags, constrainedSampling is tool metadata not output) is plain ASCII with no control codes and touches no rendering in non-TUI modes. (3) Type safety: no new `as unknown as` casts; constrainedSampling typed against `ToolDefinition`; registerEntryRenderer uses the public typed API.

## Testing Strategy

Verification is `npm run typecheck` strict-clean against the 0.82.1 type surface plus the full vitest suite (existing 1437 tests + new tests) green. Tests live in `tests/*.test.ts` and colocated `src/*.test.ts` following the established `describe`/`it`/`expect` + env-mutation + tmpdir-fixture shape. Every phase is independently testable.

Phase 1 (model/thinking inheritance): unit-test the widened precedence — extend `tests/pi-spawn.test.ts` with a `resolveThinking` test asserting the new INHERITED tier sits ABOVE the role default but BELOW per-call and SUPER_DEV_THINKING env (set/reset env vars per case). Add a workflow-level test (`tests/workflow.test.ts`) asserting `inheritedThinking` flows from `makeContext`/`realAgent`'s `common` object into the spawned agent call. Add a session-backend assertion that `createAgentSession` receives `model`/`thinkingLevel` when an inherited value resolves and that `applyThinkingLevel` does not double-apply. Cover the older/non-TUI ctx case (no model/thinking → no throw, current behavior) and the model-id-cannot-resolve fall-through (SCENARIO-002, SCENARIO-008).

Phase 2 (constrained sampling): unit-test `isStrictCapable` for required-keys + `additionalProperties:false` (true), all-Optional (false), `additionalProperties:true` (false), and non-Object schemas (false). Test that `constrainedSampling: { type:"json_schema", strict:"prefer" }` is attached to the `structured_output` tool ONLY when `isStrictCapable` is true and ABSENT (byte-identical to today) otherwise, including the existing permissive controlSchema (SCENARIO-009..013). Assert `missingKeys()` + the corrective re-prompt remain unchanged as the fallback.

Phase 3 (typed registerEntryRenderer): no behavioral test needed beyond typecheck-clean (no `as unknown as` cast for the renderer) and the existing try/catch best-effort guard; assert via `requireNotContains` that the `piWithRenderer` cast is gone and the direct typed call is present (SCENARIO-014, SCENARIO-015).

Phase 4 (build tagging): focused `tests/build-runner.test.ts` case — set `PI_SESSION_ID`/`PI_MODEL`, run the gate, assert the correlation tag appears in captured output and gate pass/fail is unchanged; unset them and assert byte-identical output (SCENARIO-016, SCENARIO-017).

Phase 5 (docs): `requireContains` on CHANGELOG.md for the `[Unreleased]` entry summarizing Features 1–4 (SCENARIO-018).

Cross-cutting (AC-12, SCENARIO-019/020): after each phase, `npm run typecheck` strict-clean and `npm test` green; no new `as unknown as` casts; print/json/rpc/headless output stays byte-identical (no control characters); inheritance never clobbers an explicit user/LLM/env override. NOTE: this is a TypeScript/vitest (frontend) project, NOT a Rust/cargo workspace, so there are no cargo packages, no `cargo test --workspace`, and no Rust integration targets — the build gate below is empty by design and the real verification gate is `npm run typecheck && npm test` (vitest) as described here and in the phase deliverables.

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
- SCENARIO-019
- SCENARIO-020

## Deviations from Specification

All five features shipped exactly as specified; AC-01..AC-11 are met. The following are clarifying deviations and post-code-review resolutions documented for traceability. None change the public acceptance criteria.

### DEV-1 — Feature 2 made effective on real production schemas (post-review F-1 / AR-01)
- **Original text**: "Provide a strict-capable schema variant for stages with well-defined keys." Initially only a synthetic test schema was strict-capable; the real review/implementation stage schemas remained all-permissive, so `constrainedSampling` was dormant in production.
- **Changed text**: The well-defined render schemas (`Finding`, `SpecReviewData` + its `dimensions` element, `CodeReviewData`, `AdversarialReviewData`, `ImplementationSummaryData`) now carry `additionalProperties: false`, making `isStrictCapable` return true for them. The render validator (`validateData`) was made tolerant of extra/unknown keys (filtered) so closing schemas for constrained sampling does NOT harden the validator (templates render only declared keys; required-key/type errors are still reported).
- **Reason**: AC-06..08 require the model to be CONSTRAINED on capable providers — dormant `constrainedSampling` would have left the corrective re-prompt firing on every stage.
- **Impact**: Additive; only the review/implementation stage schemas close to strict-capable. Other stage schemas stay permissive → byte-identical. Non-capable providers keep the `missingKeys()` corrective fallback.

### DEV-2 — Model-id resolution falls through silently instead of throwing (post-review F-2)
- **Original text**: "Pass the resolved model via the SDK's `model` option when an explicit-or-inherited model is available."
- **Changed text**: `resolveSessionModel`'s catch branch `return undefined` (no longer returns a cast descriptor), so `createAgentSession` OMITS `model` and uses the SDK/settings default when the inherited id cannot resolve. A module-level `getModelRuntime()` cache memoizes `ModelRuntime.create()` once per process (AR-03).
- **Reason**: The no-throw best-effort discipline requires an unresolvable inherited model id to degrade rather than throw; the type-unsound cast is removed (F-2).
- **Impact**: Older/non-TUI or catalog-unknown model ids now silently fall through to the SDK/settings default; identical fallback behavior for all other providers.

### DEV-3 — Bare-id model descriptors resolve via full-catalog scan (post-review F-3 / AR-04)
- **Original text**: Implicit assumption that `ctx.model.id` maps cleanly to a `(provider, id)` pair.
- **Changed text**: `splitModelRef` yields an EMPTY provider for a bare id (no slash) instead of `provider==id`; `resolveSessionModel` falls back to a full-catalog `getModels()` scan by model id. Combined with DEV-2, no degenerate descriptor is ever handed to `createAgentSession`.
- **Reason**: Prevents handing `createAgentSession` a malformed `{id, provider:id}` descriptor.
- **Impact**: Additive; bare slugs and unfamiliar provider prefixes now resolve when the catalog knows them; known cases unchanged.

### DEV-4 — Build correlation is OBSERVABLE, not write-only (post-review AR-02 / F-5)
- **Original text**: "include `PI_SESSION_ID` and `PI_MODEL` in any build-run log/trace/artifact metadata the build gate writes (e.g. a header line in the captured build log, or a field in any structured trace it emits)."
- **Changed text**: Both representations are emitted: an additive `correlation?: { sessionId?: string; model?: string }` field on `BuildGateResult` AND a plain-ASCII `# pi-session=<id> model=<model>` header line via `buildGateCorrelationLine(result)`, emitted to the run trace at all three build-gate consumers (`stages/index.ts`, `stages/verify.ts`, `stages/implementation.ts`).
- **Reason**: A write-only field that nothing reads is zero observability value; the line makes the tag actually observable for parallel-run correlation.
- **Impact**: Observability-only; field is OMITTED entirely (byte-identical to today) when both env vars are absent. No gate pass/fail / command / timeout change. The CHANGELOG Feature-4 wording was corrected to match.

### DEV-5 — Double-application guard for thinking level (post-review F-3 spec-review)
- **Original text**: "Also pass `thinkingLevel` directly as a `createAgentSession` option as a second line of defense alongside the existing `applyThinkingLevel(session, ...)` call."
- **Changed text**: The retained best-effort `applyThinkingLevel(session, ...)` is guarded with `if (!creationThinking) applyThinkingLevel(...)` so the level is applied exactly once when `thinkingLevel` is already passed to `createAgentSession`.
- **Reason**: Avoids double-applying thinking level across the two seams.
- **Impact**: None for capable runtimes; older runtimes still get the best-effort `applyThinkingLevel` path.

### DEV-6 — Spec-ambiguity note: inherited thinking uses pure precedence, no max-floor (code review F-1)
- **Original text**: "a thinking level no LOWER than the role default would have been (inherited wins over role default, but per-call/env still win)."
- **Changed text**: The implementation follows the MORE detailed precedence chain in the Feature-1 body (per-call → SUPER_DEV_THINKING → INHERITED → role default) with pure replacement and NO `max(inherited, role default)` floor. So a reasoning role inheriting a `low`/`medium` level from the main session thinks BELOW its role default.
- **Reason**: The two clauses conflict; the detailed precedence chain is treated as authoritative (the user explicitly chose the level for their session; inheritance is the feature). Logged as a spec-clarification, NOT a code defect — confidence 0.6 in the original review.
- **Impact**: Behavioral on edge cases only. A reasoning-heavy role (code-reviewer / adversarial-reviewer / spec-writer, default `high`) inheriting `low`/`medium`/`minimal` will think at that inherited level. If a floor is later desired, resolve as `max(inherited, thinkingForAgent(agent))` via the `THINKING_LEVELS` ordinal. No change made in this run.
