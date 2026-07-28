# Implementation Summary: pi Integration Modernization (spec-15) — model/thinking inheritance, constrained structured_output sampling, typed registerEntryRenderer, bash session-env build tagging

- **Date**: 2026-07-28

---

## Summary

Cohesive adoption of pi 0.82.x features across the pi-super-dev extension as four additive, no-throw/best-effort changes plus a CHANGELOG entry. Built on the already-committed `^0.82.1` `@earendil-works/pi-coding-agent` bump; zero new runtime dependencies.

## What was built, by phase

**Phase 1 — Inherit main-session model + thinking level (Feature 1; AC-01..05; SCENARIO-001..008).** The core, prerequisite change. `extension.execute()` now defensively captures `ctx.model?.id` / `ctx.thinkingLevel` (optional chaining; never throws on older/non-TUI ctx) BEFORE `runPipelineTask(...)` and threads additive `inheritedModel?: string` / `inheritedThinking?: ThinkingLevel` DEFAULTS through the full specialist chain: `RunOptions` (src/types.ts) → `realAgent.common` (src/workflow.ts) → BOTH the `pi`-subprocess backend (`SpawnAgentOptions` in src/pi-spawn.ts) and the in-process `createAgentSession` backend (src/session-agent.ts).
- `resolveThinking` precedence widened to `per-call → SUPER_DEV_THINKING env → INHERITED (ctx.thinkingLevel) → role default`.
- Model resolution added: `explicit params.model → SUPER_DEV_MODEL env (NEW) → inherited ctx.model.id → SDK/settings default`; `--model` pushed only when a model resolves.
- Session backend passes `model`/`thinkingLevel` as `createAgentSession({...})` options alongside the retained best-effort `applyThinkingLevel`, guarded against double-application (skipped when thinkingLevel already passed to createAgentSession — resolves spec-review F-3).
- Explicit params and SUPER_DEV_* env always win (additive, never clobber); unresolvable model id degrades to SDK/settings default rather than throwing (resolves F-1).

**Phase 2 — Constrained tool sampling for structured_output (Feature 2; AC-06,07,08; SCENARIO-009..013).** Localized to src/session-agent.ts. New `isStrictCapable(schema)` helper (true ONLY for a typebox Object with ≥1 required non-Optional key AND `additionalProperties === false`) gates a new strict-capable schema variant; `structuredOutputTool` sets `constrainedSampling: { type: "json_schema", strict: "prefer" }` on the `ToolDefinition` ONLY when `isStrictCapable` holds, typed against the 0.82.1 `ToolDefinition.constrainedSampling` field. NEVER attached to the permissive controlSchema. `missingKeys()` + the single corrective re-prompt turn preserved byte-identical as the non-capable-provider / permissive-schema fallback.

**Phase 3 — Typed registerEntryRenderer (Feature 3; AC-09; SCENARIO-014,015).** Pure cleanup in src/extension.ts. Deleted `const piWithRenderer = pi as unknown as {…}`; `activate()` now calls `pi.registerEntryRenderer("super-dev-summary", …)` directly against the public 0.82.1 typed signature, importing `EntryRenderer`/`EntryRenderOptions`. Best-effort try/catch wrapper and durable background-summary transcript-card rendering unchanged. No new `as unknown as` casts.

**Phase 4 — Tag build runs with pi session-env vars (Feature 4; AC-10; SCENARIO-016,017).** src/build-runner/gates.ts `runBuildGate` defensively reads `process.env.PI_SESSION_ID` / `process.env.PI_MODEL`; when at least one is present, stamps an additive `correlation?: { sessionId?: string; model?: string }` field onto `BuildGateResult`. Field is OMITTED entirely (byte-identical to today) when both are absent. Read is try-guarded so a hostile env proxy cannot stall the gate. Observability-only: no pass/fail, command-construction, or timeout change; plain ASCII, no control codes.

**Phase 5 — CHANGELOG [Unreleased] entry (Feature 5; AC-11; SCENARIO-018).** Appended a Keep-a-Changelog bold-leading-bullet entry to CHANGELOG.md summarizing Features 1–4 and noting the ^0.82.1 bump is already committed. Matches the prior `[Unreleased]` entry style.

## Files changed (15)

Source: src/extension.ts, src/session-agent.ts, src/pi-spawn.ts, src/workflow.ts, src/types.ts, src/build-runner/gates.ts. Docs: CHANGELOG.md. Tests (8, all new or extended): tests/extension-inherit.test.ts, tests/session-agent-inherit.test.ts, tests/workflow-inherit.test.ts, tests/pi-spawn.test.ts, tests/session-agent-constrained-sampling.test.ts, tests/extension-entry-renderer.test.ts, tests/build-runner-correlation.test.ts, tests/changelog-unreleased-spec15.test.ts. Net +1544/−37 across 15 files; 5 commits (`59721185`…`5fbf7213`).

## Test results

`npm run typecheck` strict-clean against the 0.82.1 type surface (no new `as unknown as` casts). Full vitest suite green. New coverage: resolveThinking INHERITED-precedence tier, inheritedThinking flow from realAgent/makeContext into the spawned agent call, isStrictCapable truth table (required-keys/all-Optional/additionalProperties:true/non-Object) + gated constrainedSampling attach/absent, registerEntryRenderer cast removal (require-not-contains `as unknown as`), build-gate correlation present/absent env cases, and the CHANGELOG entry contract (four anchors + ^0.82.1 note + preservation of prior entries).

## Deviations / spec-review resolutions

- F-1 (Model-object resolution): implemented the no-throw fall-through — unresolvable inherited model id degrades to the SDK/settings default rather than throwing; documented in code comments.
- F-2 (header-line AND/OR field ambiguity): settled on the additive `correlation` field representation; tests assert it is populated when env set and absent (byte-identical) when unset.
- F-3 (double-apply guard): applyThinkingLevel skipped when thinkingLevel already passed to createAgentSession; precedence made explicit.
- F-4/F-6 (isStrictCapable introspection / strict:"prefer" rationale): behavioral test cases pin the helper; "prefer" chosen to keep non-capable providers (glm/local) on the normal tool-call path so missingKeys still fires.
- F-5 (brittle '1437 tests' baseline): treated as approximate; AC-12 gate is the full vitest suite being green, not a fixed count.
All non-functional requirements honored: additive-only, no-throw/best-effort, zero-ANSI byte-clean print/json/rpc/headless modes, no new runtime deps, type-safe (no new casts).

## Phases

- **Phases Completed**: 5/5
- **All Green**: true

## Files Modified

- CHANGELOG.md
- src/extension.ts
- src/session-agent.ts
- src/pi-spawn.ts
- src/workflow.ts
- src/types.ts
- src/build-runner/gates.ts
- tests/extension-inherit.test.ts
- tests/session-agent-inherit.test.ts
- tests/workflow-inherit.test.ts
- tests/pi-spawn.test.ts
- tests/session-agent-constrained-sampling.test.ts
- tests/extension-entry-renderer.test.ts
- tests/build-runner-correlation.test.ts
- tests/changelog-unreleased-spec15.test.ts

---

## Code-review fix round (post-review)

Targeted fixes for the spec-15 code-review + adversarial-review findings. All
additive / no-throw; `npm run typecheck` strict-clean and the full vitest suite
green (1520 tests, +5 new regression cases).

- **F1 / AR-01 (Medium — Feature 2 was dormant):** the well-defined render
  schemas (`Finding`, `SpecReviewData` + its `dimensions` element,
  `CodeReviewData`, `AdversarialReviewData`, `ImplementationSummaryData`) now
  carry `additionalProperties: false`, so `isStrictCapable` returns true for
  them and `structuredOutputTool` attaches `constrainedSampling` on REAL pipeline
  stages in production — not just the synthetic test schema. The render
  validator (`validateData`) is made tolerant of extra/unknown keys (filtered),
  because the strict flag exists to make schemas strict-capable for the tool's
  constrained sampling, NOT to harden the validator; templates render only the
  declared keys so an extra key is harmless, and required-key/type errors are
  still reported. New test: production stage schemas are strict-capable +
  `structuredOutputTool` attaches constrainedSampling for a real schema.
- **F2 (Medium — type-unsound cast):** `resolveSessionModel`'s catch branch no
  longer returns a `{id,provider}` object cast `as SessionModelOption`; it
  `return undefined` so `createAgentSession` omits `model` and uses the
  SDK/settings default (matches the documented fall-through). The
  session-agent-inherit mock now provides a `ModelRuntime` so a known id
  resolves via the catalog (the descriptor cast is gone).
- **F3 / AR-04 (Low — bare-id degenerate descriptor):** `splitModelRef` now
  yields an EMPTY provider for a bare id (no slash) instead of `provider==id`,
  and `resolveSessionModel` falls back to a full-catalog `getModels()` scan by
  model id, so a bare slug or an unfamiliar provider prefix resolves when the
  catalog knows it; combined with the F2 fix, no degenerate descriptor is ever
  handed to `createAgentSession`.
- **AR-03 (Low — per-spawn `ModelRuntime.create()` on the hot path):** the
  resolved `ModelRuntime` is memoized at module level (`getModelRuntime`) and
  shared across every session-backend spawn — `create()` runs once per process,
  not per spawn; the cache is cleared on rejection so a transient failure can
  retry.
- **AR-02 / F5 (Medium/Info — write-only correlation + CHANGELOG drift):** new
  `buildGateCorrelationLine(result)` formats the tag as a plain-ASCII
  `# pi-session=<id> model=<model>` line and the three build-gate consumers
  (`stages/index.ts`, `stages/verify.ts`, `stages/implementation.ts`) emit it to
  the run trace, so the captured correlation field is OBSERVABLE (not
  write-only); the CHANGELOG Feature-4 wording is corrected to match (the line
  is now actually emitted). New test: the formatter's present/absent/both cases.
- **AR-05 (Low — redundant `thinking`/`thinkingLevel` aliases):** a clarifying
  comment at the `common` object documents that both backends intentionally read
  the SAME per-call `call.thinking` value.
- **F4 (Low — spec ambiguity, no code change):** the precedence text
  'inherited wins over role default' was the authoritative clause; the
  implementation already implements it consistently on both backends. Noted as
  a spec-wording heads-up, not a defect.
- **AR-06 (Low — comment density):** acknowledged; the durable WHY is kept in
  header comments; no behavior-affecting change.

Files touched this round: `src/render/schemas.ts`, `src/render/render.ts`,
`src/session-agent.ts`, `src/workflow.ts`, `src/build-runner/gates.ts`,
`src/stages/index.ts`, `src/stages/verify.ts`, `src/stages/implementation.ts`,
`CHANGELOG.md`, and tests `tests/session-agent-inherit.test.ts`,
`tests/session-agent-constrained-sampling.test.ts`,
`tests/build-runner-correlation.test.ts`,
`tests/implementation-phase-subtitle.test.ts`,
`tests/implementation-crosscheck-gate.test.ts`.
