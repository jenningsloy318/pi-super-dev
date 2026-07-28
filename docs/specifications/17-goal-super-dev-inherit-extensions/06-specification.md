# Specification: Technical Specification: SUPER_DEV_INHERIT_EXTENSIONS opt-in (spec-17, Gap #3)

- **Date**: 2026-07-22

---

## Summary

Add a default-OFF, env-var opt-in `SUPER_DEV_INHERIT_EXTENSIONS` so specialist `pi` agents spawned by pi-super-dev can load ambient (global + project) extensions — restoring visibility to extension-registered providers/models for users whose model stack depends on them. The change is additive, no-throw, and byte-identical to current behavior when unset or falsy. It consists of (1) a tiny exported helper `inheritExtensions()` placed alongside the existing `SUPER_DEV_MODEL`/`SUPER_DEV_THINKING`/`SUPER_DEV_BACKEND` env reads in `src/pi-spawn.ts`; (2) flipping two gating expressions in lockstep — `noExtensions: !inheritExtensions()` in the session backend (`src/session-agent.ts:487`) and `if (!browser && !inheritExtensions()) args.push("--no-extensions")` in the subprocess backend (`src/pi-spawn.ts` ~276); (3) concise trade-off comments at both wiring points; (4) focused vitest tests reusing the existing `saveEnv()` harness; and (5) a `[Unreleased]` `### Added` CHANGELOG bullet whose bold span carries the contract anchor `inherit`. No server/API/UI runs; local verification is `npm run typecheck` (tsc strict) + `npm test` (vitest). All 9 ACs / 16 BDD scenarios are addressed; the safety factory, the `inheritedModelObject` model-inheritance path, the control-flow node algebra, the resume cache, the pipeline stage structure, every no-throw best-effort guard, and the print/json/rpc/headless zero-ANSI contract are explicitly untouched.

## Architecture

pi-super-dev is a pure-TypeScript pi-extension library (ESM, `tsc` build, `vitest` run) that spawns specialist `pi` agents through two backends. Both backends deliberately suppress ambient extensions for determinism + isolation, supplying only an inline safety extension factory — but recent model-inheritance work passes the parent's full `ctx.model` object to children, which silently fails when the user's *active* model resolves from an extension-registered provider (the child's fresh runtime has no such provider registered). This spec closes that gap with an opt-in escape hatch rather than changing the default isolation.

Backend 1 — session (in-process). `runAgentViaSession()` in `src/session-agent.ts` (~line 487) constructs a `DefaultResourceLoader` with `noExtensions: true` and `extensionFactories: [createSafetyExtensionFactory()]`. The fix changes the boolean to `noExtensions: !inheritExtensions()` (imported from `./pi-spawn.ts`). With the opt-in OFF this evaluates to `true` (byte-identical baseline: ambient extensions suppressed, inline safety factory still loads via `extensionFactories`). With it ON it evaluates to `false`, so `DefaultResourceLoader` performs ambient global+project extension discovery while the safety factory remains registered unchanged. The surrounding model-resolution, thinking-level, no-throw try/catch, and capture logic are not modified.

Backend 2 — subprocess (argv). `buildSpawnArgs()` in `src/pi-spawn.ts` (~line 276) currently does `if (!browser) args.push("--no-extensions");`, where `browser = isBrowserAgent(opts.agent)`. The fix becomes `if (!browser && !inheritExtensions()) args.push("--no-extensions");`. Browser-capable agents already omit the flag so `pi-browser-cdp-extension` loads; the opt-in never touches the `!browser` branch, so browser-agent behavior is invariant in both opt-in states. Web-research agents continue to KEEP `--no-extensions` and load only their two extensions via repeatable `-e <path>` — that explicit `-e` path is also unaffected. Model precedence (`--model` pushed only when a value resolves: explicit → `SUPER_DEV_MODEL` → inherited `provider/id` → default) and thinking precedence are untouched.

The helper. `inheritExtensions()` lives in `src/pi-spawn.ts` adjacent to `resolveModel`/`asThinkingLevel`/`asBackend` (~lines 155-185), the canonical home for `SUPER_DEV_*` reads and already imported by `session-agent.ts`. Signature: `export function inheritExtensions(): boolean`. Body: `return Boolean(process.env.SUPER_DEV_INHERIT_EXTENSIONS && /^(1|true|yes|on)$/i.test(process.env.SUPER_DEV_INHERIT_EXTENSIONS.trim()));` — mirroring the established `.trim()` + anchored `/^(...)$/i` idiom. It returns `true` only for `1|true|yes|on` (case-insensitive, whitespace-trimmed) and `false` for unset/empty/`0`/`false`/garbage. The leading `Boolean(env && regex.test(...))` is a no-throw best-effort guard: if the env var is undefined the `&&` short-circuits to `false` without ever calling `.trim()`.

Cross-cutting contract. The feature is strictly additive and default-OFF: when the env var is unset or falsy, both backends produce byte-identical argv/loader construction to today. Every existing no-throw best-effort guard, the additive model-resolution precedence, and the print/json/rpc/headless zero-ANSI output contract are preserved. Because spawned specialists receive no interactive user input, opting in cannot cause the pipeline to self-trigger even if super-dev itself is among the loaded user extensions — that nuance is documented at both wiring points as the explicit determinism trade-off. Non-goals (safety factory internals, `inheritedModelObject` path, control-flow node algebra, resume cache, pipeline stage structure) are explicitly excluded from the diff.

## Testing Strategy

There is no server/UI to boot — the verify loop IS the test suite. Two test surfaces, both in `tests/pi-spawn.test.ts`, reusing the file's existing local `saveEnv(...keys)` snapshot/clear/restore harness (defined ~line 194, wired via `beforeEach(env.clear)`/`afterEach(env.restore)` ~246-249) and direct `import { buildSpawnArgs, ... } from "../src/pi-spawn.ts"`.

(1) `inheritExtensions()` parsing unit test — import the helper directly. Assert ENABLED for every recognized truthy token (`1`, `true`, `yes`, `on`), including mixed case (`True`, `On`) and surrounding-whitespace padding (`  YES  `). Assert DISABLED for unset, empty string, `0`, `false`, and unrecognized/garbage (`off`, `no`, `2`, `maybe`, `random`). The `saveEnv(["SUPER_DEV_INHERIT_EXTENSIONS"])` helper guarantees isolation between cases and a clean restore (addresses SCENARIO-001/002/003/011/016 — malformed inputs degrade to OFF without throwing).

(2) `buildSpawnArgs` flag-presence test — assert on a normal non-browser specialist fixture (e.g. `'requirements-clarifier'`) that the returned argv `toContain("--no-extensions")` when the opt-in is unset, and `not.toContain("--no-extensions")` when `SUPER_DEV_INHERIT_EXTENSIONS=1`. Then assert a browser-capable agent (the one `isBrowserAgent` already matches, e.g. a QA/browser fixture) `not.toContain("--no-extensions")` in BOTH opt-in states — proving browser-agent behavior is invariant (SCENARIO-004/005/006/010). Use the established `args.indexOf("--no-extensions")` style for any positional assertions.

(3) Session-backend coverage — `DefaultResourceLoader` construction inside `runAgentViaSession` is not trivially isolatable (it depends on `SettingsManager`/agentDir/cwd), so per the acceptance bar the `inheritExtensions()` unit test plus the documented `noExtensions: !inheritExtensions()` wiring (asserted via phase deliverables) is the accepted coverage; no separate session-loader unit test is required. The subprocess `buildSpawnArgs` test transitively exercises the shared helper both backends depend on.

(4) CHANGELOG contract — `tests/changelog-unreleased-spec15.test.ts` enforces a Keep-a-Changelog bold-bullet anchor regex whose token set is `inherit|model|thinking|constrain|structured-output|registerEntryRenderer|PI_SESSION_ID|PI_MODEL`. The new `### Added` bullet's bold span text MUST contain `inherit` (e.g. `**Inherit extension-registered providers via SUPER_DEV_INHERIT_EXTENSIONS opt-in (spec-17).**`); `extensions`/`provider` alone do NOT satisfy the regex. The test must remain green and no previously-matched anchor/bullet may be removed or reordered (SCENARIO-012).

Final quality gate (cross-phase): `npm run typecheck` strict-clean against `@earendil-works/pi-coding-agent@^0.82.1`, and full `npm test` green (existing + new). A diff review confirms the non-goals (safety factory, `inheritedModelObject` path, control-flow node algebra, resume cache, pipeline stage structure) and the zero-ANSI contract are untouched (SCENARIO-013/015).

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

## Deviations from Specification

**Status: no functional deviations.** The shipped implementation matches `06-specification.md` byte-for-byte across every documented contract (helper body, both wiring expressions, trade-off comments, test surfaces, CHANGELOG anchor, quality gate). Review surfaced only Low/Info/medium *quality* findings — none altered behavior or any acceptance criterion. Deviations are recorded for traceability; no AC-01..AC-09 was relaxed, reinterpreted, or unmet.

| ID | Kind | Original (spec) | Actual (shipped) | Reason / Impact |
|---|---|---|---|---|
| DEV-01 (from CR F-01 / AR-06) | Comment accuracy — *not applied* | `buildSpawnArgs` comment asserts research-agent isolation as a constant invariant | Same comment shipped; the isolation claim only holds when the opt-in is OFF (when ON, research agents also load ambient extensions) | Documentation-only Low finding. No AC references comment wording; behavior is correct. Filed for a future hygiene pass; left as-is to keep the diff byte-identical to the reviewed/approved change. |
| DEV-02 (from CR F-02 / AR-02) | CHANGELOG verbosity — *not applied* | Spec requested a "concise" `### Added` entry | Entry is a ~400-word run-on sentence | AC-07 only requires the `**bold**` `inherit` anchor + env-var presence, both satisfied; the spec-15 + spec-17 contract tests stay green (12/12 each). Kept verbose to maximize discoverability; trimming is non-blocking. |
| DEV-03 (from AR-01) | Session-backend test coverage — *accepted by AC escape clause* | Spec's testing strategy explicitly sanctioned "the `inheritExtensions()` unit test + documented wiring is sufficient" when the loader is not unit-testable in isolation | The `DefaultResourceLoader` `noExtensions` value is asserted only transitively via the shared `inheritExtensions()` unit test (no direct session-loader assertion) | AC-06 escape clause holds by the spec's own wording. The subprocess `buildSpawnArgs` matrix fully covers the shared helper both backends depend on. Non-blocking; a direct session-loader assertion is a recommended future hardening, not a deviation. |
| DEV-04 (from AR-03) | Self-trigger safety claim — *language is an expectation, not a regression-tested guarantee* | Comments state the pipeline "cannot self-trigger" when super-dev is loaded as an ambient extension | Shipped as-is (calibrated expectation, not regression-tested) | Claim is almost certainly true (specialists run one fixed-prompt turn with no slash-command dispatch path) but unverified. No AC mandates verification. Low; deferred. |
| DEV-05 (from AR-04/F-03/AR-05) | Documentation hygiene — *informational* | Trade-off prose is triplicated; no observability log; token/context-inflation cost under-documented | Shipped as-is | All Low/Info; none affect any AC or behavior. The other `SUPER_DEV_*` toggles follow the same no-log pattern, so the opt-in is consistent with the codebase. |

**Net impact on acceptance criteria:** none. AC-01..AC-09 are fully satisfied by commit `9be2f363` (helper + dual-backend wiring + comments + tests) and commit `4ed516c4` (CHANGELOG anchor). The quality-gate AC-08/AC-09 is met: `npm run typecheck` strict-clean; `npm test` 96 files / 1551 tests green.
