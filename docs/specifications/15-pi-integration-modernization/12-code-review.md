# Code Review: Code Review — spec-15: pi Integration Modernization (model/thinking inheritance, constrained structured_output sampling, typed registerEntryRenderer, build session-env tagging)

- **Date**: 2026-07-24
- **Author**: super-dev:code-reviewer
- **Verdict**: Approved

---

## Verdict: Approved

All five features are implemented cohesively and match the detailed precedence/contract spec. Verified: `npm run typecheck` is strict-clean against the 0.82.1 type surface; targeted vitest suites for inheritance (pi-spawn), constrained sampling, and build correlation pass (72/72); the `registerEntryRenderer` `as unknown as` capability cast is deleted and replaced with a typed `pi.registerEntryRenderer(...)` call (the remaining `as unknown as` occurrences are all in tests or unrelated render-error narrowing). Dimension scores: Correctness 4/5, Security 5/5, Performance 4/5, Concurrency 4/5, Maintainability 4/5, Testability 5/5, Error Handling 5/5, Data Integrity 4/5, Observability 5/5.

Feature 1 (highest leverage): `ctx.model?.id` / `ctx.thinkingLevel` are captured defensively in `extension.execute()` before `runPipelineTask`, threaded as additive `inheritedModel`/`inheritedThinking` DEFAULTS through `RunOptions → realAgent.common → both backends`. `resolveThinking` precedence is correctly widened (per-call → SUPER_DEV_THINKING → INHERITED → role default); `resolveModel` adds the NEW SUPER_DEV_MODEL tier (explicit → env → inherited → SDK default); `--model` is pushed only when a model resolves. The session backend passes `model` + `thinkingLevel` as `createAgentSession` options alongside a retained `applyThinkingLevel`, with a clean double-application guard (`if (!creationThinking) applyThinkingLevel(...)`). Model-id resolution no-throws and falls through to the SDK/settings default when the catalog can't resolve it (SCENARIO-008). Older/non-TUI ctx degrades byte-identically. AC-01..05 / SCENARIO-001..008 met.

Feature 2: `isStrictCapable(schema)` correctly returns true ONLY for a typebox Object with `additionalProperties === false` (exact `!== false` check, so undefined/true permissive schemas are excluded) AND ≥1 required non-Optional key. `constrainedSampling: { type: "json_schema", strict: "prefer" }` is attached to the `structured_output` ToolDefinition solely on that gate; the all-Optional `controlSchema` + `missingKeys()` + single corrective re-prompt are preserved byte-identical as the fallback. Only the review/implementation stage schemas (SpecReview/CodeReview/AdversarialReview/ImplementationSummary + nested Finding/dimensions) were closed to be strict-capable; the remaining stage schemas stay permissive → byte-identical. AC-06..08 / SCENARIO-009..013 met.

Feature 3: renderer registered via the typed public API; best-effort try/catch retained. Feature 4: `PI_SESSION_ID`/`PI_MODEL` read defensively (try-guarded against a hostile `process.env` proxy), omitted entirely when both absent (byte-identical), and emitted as a plain-ASCII `# pi-session=… model=…` line to the run trace at all three build-gate sites plus an additive `correlation` field on `BuildGateResult`. No pass/fail/command/timeout change. AC-10 / SCENARIO-016..017 met. Feature 5: CHANGELOG `[Unreleased]` entry present in Keep-a-Changelog style covering Features 1–4 + the already-committed bump. AC-11 / SCENARIO-018 met.

No Critical or High issues. Three Low-severity items below (one spec-clarification, one intentional validation weakening worth confirming, one minor inefficiency) — none block approval.

## Findings

### F-1: Spec ambiguity: "no lower than role default" vs implemented pure inherited-wins precedence

- **Severity**: Low
- **File**: `src/pi-spawn.ts`
- **Line**: resolveThinking/resolveExplicitThinking
Feature 1's acceptance says spawned specialists use "a thinking level no LOWER than the role default would have been (inherited wins over role default…)". These two clauses conflict when an inherited level is LOWER than a role default — e.g. a reasoning role (code-reviewer/adversarial-reviewer/design/spec-writer, default "high") inheriting "medium"/"low"/"minimal" from the main session. The implementation (`resolveThinking`/`resolveExplicitThinking` in src/pi-spawn.ts and the `creationThinking` path in src/session-agent.ts) follows the MORE detailed/explicit precedence chain in the Feature 1 body (per-call → SUPER_DEV_THINKING → INHERITED → role default) with pure replacement and NO max-floor, so such a role will think BELOW its role default. This is a defensible reading (the user explicitly chose a low level for their session and inheritance is the feature), and matches the detailed precedence spec, but if the "no lower" intent was real the reasoning-heavy stages could regress on quality. Failure scenario: user runs `/super-dev` from a session pinned to `low` thinking → code-reviewer/adversarial-reviewer think at `low` instead of `high`, weakening the review loop. Suggested fix: confirm with the spec author which clause is authoritative; if a floor is intended, resolve the effective level as `max(inherited, thinkingForAgent(agent))` (via the THINKING_LEVELS ordinal) instead of pure replacement. Confidence 0.6 (UNCERTAIN — genuinely spec-ambiguous).
### F-2: Render validator now silently swallows additionalProperties errors (intentional, but a gate weakening)

- **Severity**: Low
- **File**: `src/render/render.ts`
- **Line**: 51
`validateData` in src/render/render.ts adds `if (e.message === "must not have additional properties") continue;`, so any schema with `additionalProperties:false` no longer fails the render/gate when the agent over-fills it. The rationale (strict-capable review/implementation schemas carry that flag for constrained sampling, and templates only render declared keys) is sound and the change is documented, but it applies UNCONDITIONALLY to every closed schema regardless of provider capability. On a non-capable provider (glm/local) where `strict:"prefer"` is not enforced, an agent returning extra keys on e.g. CodeReviewData now passes validation silently rather than surfacing as a gate error. Practical impact is low because templates ignore extras and downstream consumers read only declared keys, and required-key/type errors are still reported — but it is a net reduction in the gate's signal. Suggested fix: keep the swallow (it is needed) but consider also emitting a debug-level notice when an additionalProperties violation is dropped, so the gate retains observability without failing. Confidence 0.7.
### F-3: missingKeys() checks prompt-extracted keys while constrained sampling enforces schema-required keys — can spuriously fire the corrective re-prompt

- **Severity**: Low
- **File**: `src/session-agent.ts`
- **Line**: structuredOutputTool/runAgentViaSession corrective block
In `structuredOutputTool`, the tool description and the `missingKeys()` corrective-re-prompt gate use `keys` (prompt-extracted via `extractControlKeys`), while `constrainedSampling` (when attached) constrains the SCHEMA's required keys. For strict-capable stages these two key sets can diverge (e.g. the prompt lists `title,date,verdict,summary,findings` but the schema also requires nested Finding `id/severity/title/detail`). On a capable provider the model is forced to fill all schema-required keys, yet `missingKeys()` may still report a prompt-declared key as missing and trigger the corrective turn — slightly contradicting AC-07's "corrective re-prompt should rarely fire" on capable providers. Harmless (the corrective re-prompt is a safe no-op that just asks for the already-present object again) but wasteful. Suggested fix: when `isStrictCapable(effective)` holds, derive the `missingKeys` check from the schema's `required` array instead of the prompt-extracted keys (or union them). Confidence 0.6.
### F-4: Module-level ModelRuntime cache is process-wide; correct for production, note for test isolation

- **Severity**: Informational
- **File**: `src/session-agent.ts`
- **Line**: getModelRuntime
`getModelRuntime()` caches `ModelRuntime.create()` at module scope (cleared only on rejection). This is correct for production (the model catalog is immutable per process and shared across every session-backend spawn, avoiding per-spawn catalog cost), but it means tests that exercise `resolveSessionModel` share one real catalog unless the cache is reset. No production bug; flagging only so future test authors know to clear `runtimeCache` or mock at a higher seam if they need deterministic catalog behavior. Confidence 0.8.
