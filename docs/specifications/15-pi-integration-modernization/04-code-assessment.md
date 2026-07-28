# Code Assessment: Codebase Assessment: pi-integration-modernization (pi-super-dev)

- **Date**: 2026-07-28
- **Author**: super-dev:code-assessor

---

## Executive Summary

pi-super-dev is an ESM TypeScript *pi-extension* package (not a standalone app — it runs INSIDE the `pi` agent). The change set modernizes the pi integration on the already-bumped `@earendil-works/pi-coding-agent@^0.82.1` / `@earendil-works/pi-tui@^0.82.1` / `typebox@1.1.38` toolchain. Architecture: `extension.ts` registers the `super_dev` tool + `/super-dev` command + entry renderer; `pipeline.ts` → `workflow.ts` (the `realAgent` seam) → a two-backend specialist layer (`pi-spawn.ts` subprocess vs `session-agent.ts` in-process `createAgentSession`); control-flow node algebra in `nodes.ts` (DO NOT TOUCH). The dominant, load-bearing convention is **no-throw best-effort**: every capability is try/catch-guarded or feature-detected, precedence chains are documented verbatim in JSDoc, and a single shared `common` options object is threaded to BOTH backends so additive option fields propagate for free. The implementation is low-risk: it mirrors an already-established 4-step precedence resolver (`resolveThinking`) and an already-existing additive option pattern; the only genuinely new surface is `ToolDefinition.constrainedSampling` (0.82.0) and the typed `registerEntryRenderer`. There is NO API/UI server to bring up — verification is `npm run typecheck` + `npm test` (vitest), both already green (1437 tests).

## Patterns

### No-throw / best-effort discipline (load-bearing)

- **Example**: src/session-agent.ts:124 (applyThinkingLevel wraps session.setThinkingLevel in try/catch, `/* best-effort */`); src/extension.ts:656 (registerEntryRenderer wrapped in try/catch); src/workflow.ts:198 (realAgent swallows budget-exhausted + transient-retry failures)
- **Consistency**: Pervasive and load-bearing. Every external/pi-API call and every capability read is guarded by try/catch with a `/* best-effort */` or `/* ignore */` comment. New code (env reads, createAgentSession options, constrainedSampling) MUST follow this — never throw.
### Documented precedence-chain resolvers for env/override resolution

- **Example**: src/pi-spawn.ts:150 `resolveThinking(agent, perCall?)` — `per-call → SUPER_DEV_THINKING env → role default`, with the exact order stated in the JSDoc one line above
- **Consistency**: Canonical pattern to mirror for BOTH the thinking inheritance widening (per-call → env → INHERITED → role default) and the model precedence (explicit → SUPER_DEV_MODEL env → inherited ctx.model.id → SDK default). Copy the JSDoc verbatim-stating-the-order style.
### Single shared `common` options object fed to BOTH backends

- **Example**: src/workflow.ts:155-198 `realAgent` builds one `common` object then `backend === "session" ? runAgentViaSession(common) : spawnAgent(common)`; both interfaces deliberately accept cross-backend fields (SpawnAgentOptions.controlKeys 'Ignored by the subprocess backend … so the same common options object can feed both backends', pi-spawn.ts:174-177)
- **Consistency**: The seam to extend. Additive fields (inheritedModel/inheritedThinking) added to RunOptions (types.ts:276) → SpawnAgentOptions (pi-spawn.ts:170) + SessionAgentOptions (session-agent.ts:137) → `common` in realAgent propagate to both backends automatically. Do NOT fork per-backend.
### typebox schemas: permissive default + explicit strict variant

- **Example**: src/session-agent.ts:172 `controlSchema(keys)` = `Type.Object({ [k]: Type.Optional(Type.Any()) }, { additionalProperties: true })`
- **Consistency**: Feature 2: build a strict-capable sibling `Type.Object({…required typed…}, { additionalProperties: false })` and gate `constrainedSampling: { type:'json_schema', strict:'prefer' }` on an `isStrictCapable(schema)` helper co-located with controlSchema. Keep the permissive shape as the ONLY fallback for unknown-key schemas.
### SUPER_DEV_* env-var convention with defensive process.env reads

- **Example**: src/build-runner/gates.ts:77 `process.env.SUPER_DEV_BUILD_TIMEOUT_MS`; src/pi-spawn.ts:152 `process.env.SUPER_DEV_THINKING`; src/workflow.ts:197 `process.env.SUPER_DEV_BACKEND`
- **Consistency**: Feature 1 (add SUPER_DEV_MODEL) and Feature 4 (PI_SESSION_ID/PI_MODEL) follow this exactly: read `process.env.X` directly, guard undefined/NaN, never throw. Feature 4 reuses the SDK-injected `PI_*` vars (different prefix by design — they're pi's, not super-dev's).
### TUI-only guards for any ANSI/widget/setStatus call; print/json/rpc/headless stay byte-clean

- **Example**: src/extension.ts renderDashboard `if (ctx?.mode !== "tui") return;` before every setWidget/setStatus/setWorkingMessage; live-stream classifies per-kind at the sink and emits raw `line.text` (zero ANSI) in non-TUI modes (AC-08/AC-09)
- **Consistency**: Inherited model/thinking + constrainedSampling touch NO rendering, so this contract is preserved automatically — but any logging of PI_* tags (Feature 4) must be plain ASCII with no color codes.
### Barrel re-export to split large modules

- **Example**: src/build-runner.ts:14-16 `export * from "./build-runner/{detect,scope,gates}.ts"`
- **Consistency**: If Feature 4 grows, a `build-runner/tagging.ts` sub-module re-exported via the barrel is the established split pattern — but a small env-read inline in gates.ts is fine too.
### Vitest test layout: tests/*.test.ts + colocated src/*.test.ts

- **Example**: tests/pi-spawn.test.ts:8-30 (`describe`/`it`/`expect` from 'vitest', env-var set/reset, mkdtempSync fixtures); src/build-runner.test.ts (colocated); 1437 tests total
- **Consistency**: New tests (resolveThinking precedence with inherited tier; workflow inheritedThinking flow; isStrictCapable + constrainedSampling gating; build-gate PI_* tagging) go in the matching tests/ file (extend tests/pi-spawn.test.ts, tests/session-agent.test.ts, tests/build-runner.test.ts) following the same `describe`/`it`/`expect` + env-mutation + tmpdir-fixture shape.

## Files Assessed

- package.json
- README.md
- CHANGELOG.md
- tsconfig.json
- src/extension.ts
- src/pipeline.ts
- src/workflow.ts
- src/types.ts
- src/pi-spawn.ts
- src/session-agent.ts
- src/build-runner.ts
- src/build-runner/gates.ts
- src/nodes.ts
- tests/pi-spawn.test.ts
- tests/session-agent.test.ts

## Recommendations

- Feature 1 (HIGHEST leverage): capture `ctx.model?.id` and `ctx.thinkingLevel` inside `super_dev.execute()` in src/extension.ts:379 — defensively (older/non-TUI ctx returns undefined → current behavior). Thread them as `inheritedModel`/`inheritedThinking` through `runPipelineTask({...})` (src/extension.ts:514) → RunOptions (src/types.ts:276, additive) → `realAgent`'s `common` object (src/workflow.ts:155) → SpawnAgentOptions/SessionAgentOptions. In src/pi-spawn.ts:150 WIDEN `resolveThinking` to `(agent, perCall?, inherited?)` with order `per-call → SUPER_DEV_THINKING → INHERITED → role default`; add `SUPER_DEV_MODEL` env handling in buildSpawnArgs (src/pi-spawn.ts:238) with order `opts.model → SUPER_DEV_MODEL → inherited → fall-through` (keep `--model` only pushed when a model resolves). Mirror resolveThinking's exact JSDoc-precedence style.
- Feature 1 (session backend): in src/session-agent.ts:369 `createAgentSession({...})` ADD `model:` (SDK accepts `model?: Model<any>` — pass the resolved id/Model) and `thinkingLevel:` as the canonical path; KEEP the existing `applyThinkingLevel(session, …)` call (src/session-agent.ts:382) as best-effort defense but resolve the level ONCE and guard against double-application (e.g. only call applyThinkingLevel when createAgentSession's option path is unavailable, or make it idempotent). Resolve the resolved level via the widened resolveThinking so both backends share one precedence function.
- Feature 2: in src/session-agent.ts add `isStrictCapable(schema)` next to `controlSchema` (src/session-agent.ts:172) — returns true only when the schema has at least one REQUIRED (non-Optional) key AND `additionalProperties === false`. In `structuredOutputTool` (src/session-agent.ts:230) set `constrainedSampling: { type: 'json_schema', strict: 'prefer' }` ONLY when isStrictCapable(opts.schema ?? controlSchema(keys)) holds. Provide a strict-capable `Type.Object({...required typed keys...}, { additionalProperties: false })` builder for stages with well-defined keys; keep the current permissive controlSchema as the fallback. KEEP `missingKeys` (src/session-agent.ts:179) + the single corrective re-prompt (src/session-agent.ts:431) byte-identical as the non-capable-provider fallback — do NOT delete.
- Feature 3 (pure cleanup): in src/extension.ts:656 DELETE `const piWithRenderer = pi as unknown as {...}` and call `pi.registerEntryRenderer('super-dev-summary', (entry, _opts, theme) => {...})` directly (public on ExtensionAPI as of 0.82.1: `registerEntryRenderer<T>(customType: string, renderer: EntryRenderer<T>)`). Import `EntryRenderer`/`EntryRenderOptions` from '@earendil-works/pi-coding-agent' for the param types. KEEP the existing try/catch best-effort wrapper around the call.
- Feature 4: in src/build-runner/gates.ts runBuildGate (~return at src/build-runner/gates.ts:320) defensively read `process.env.PI_SESSION_ID` and `process.env.PI_MODEL`; when present, prepend a plain-ASCII header line (e.g. `# pi-session=<id> model=<model>`) to the captured log/errors surface and/or add an optional additive `correlation?: { sessionId?: string; model?: string }` field to BuildGateResult (src/build-runner/gates.ts:91). Observability-only — never change pass/fail logic or command construction; no-op when the env vars are absent. Add a focused test in tests/build-runner.test.ts setting both env vars and asserting the tag appears.
- Feature 5: append a concise `[Unreleased]` CHANGELOG.md entry (src already follows Keep-a-Changelog at the top of CHANGELOG.md:5) summarizing Features 1–4 and noting the ^0.82.1 dependency bump is already committed. Match the bold-leading-bullet prose style of the existing `[Unreleased]` entries.
