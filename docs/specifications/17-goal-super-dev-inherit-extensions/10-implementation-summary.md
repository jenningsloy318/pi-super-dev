# Implementation Summary: Spec-17: SUPER_DEV_INHERIT_EXTENSIONS opt-in (inherit extension-registered providers in spawned specialists)

- **Date**: 2026-07-28

---

## Summary

## What was built

A new **default-OFF env-var opt-in** (`SUPER_DEV_INHERIT_EXTENSIONS`) that lets specialist `pi` agents spawned by the pipeline load ambient (global + project) extensions. This closes a regression-gap left by spec-15's model-inheritance work: the parent's full `ctx.model` object is now passed to children, but when that model resolves from an *extension-registered* provider (e.g. a `pi.registerProvider(...)` extension), the child's fresh, extension-suppressed runtime couldn't resolve it and silently degraded to the settings default. The opt-in lifts extension suppression in BOTH backends so extension-sourced providers become visible — strictly additive, byte-identical to today when unset.

### Phase 1 — Opt-in helper, dual-backend wiring, trade-off comments, focused tests (commit `9be2f363`)
- **`src/pi-spawn.ts`**: added exported `inheritExtensions(): boolean` adjacent to the existing `SUPER_DEV_MODEL`/`SUPER_DEV_THINKING` env reads. Recognizes `1|true|yes|on` (case-insensitive, whitespace-trimmed); everything else (unset/empty/`0`/`false`/`off`/`no`/garbage) degrades to OFF **without throwing** (`Boolean(env && …)` short-circuits before `.trim()` so malformed input can never raise). Mirrors the existing `.trim()` + anchored-regex idiom.
- **Subprocess backend** (`buildSpawnArgs`): guard changed from `if (!browser)` → `if (!browser && !inheritExtensions())` before pushing `--no-extensions`. Browser-capable agents remain invariant (never get `--no-extensions`) in both opt-in states; the explicit `-e` research-extension path and `--tools` allowlist are untouched.
- **Session backend** (`src/session-agent.ts`): imported `inheritExtensions` and flipped the `DefaultResourceLoader` option from `noExtensions: true` → `noExtensions: !inheritExtensions()`. The inline **safety extension factory stays in `extensionFactories` either way** — child remains guarded in all states.
- **Trade-off comments** added at both wiring points documenting the determinism/isolation cost (child pulls in EVERY user global extension, potentially super-dev itself — but spawned specialists receive no interactive input, so opting in cannot self-trigger the pipeline).
- **Tests** (`tests/pi-spawn.test.ts`, +81 lines): unit tests for `inheritExtensions()` parsing (truthy incl. mixed-case/padded; falsy unset/empty/`0`/`false`/`off`/`no`/garbage → false, none throw), and `buildSpawnArgs` assertions that a normal agent (`requirements-clarifier`) gets `--no-extensions` when OFF and omits it when `=1`, while browser-capable agents omit it in BOTH states. Reuses the existing `saveEnv(["SUPER_DEV_INHERIT_EXTENSIONS"])` harness.

### Phase 2 — CHANGELOG entry (parallelizable, commit `4ed516c4`)
- **`CHANGELOG.md`**: added a new `[Unreleased]` → `### Added` bullet whose first bullet is `**bold**` and contains the `inherit` anchor: *"Inherit extension-registered providers via SUPER_DEV_INHERIT_EXTENSIONS opt-in (spec-17)."* No prior bullets removed/reordered — the `tests/changelog-unreleased-spec15.test.ts` contract test stays green (12/12).

## Test results
- `npm run typecheck` (`tsc --noEmit`): **strict-clean** (no output) against the `^0.82.1` type surface.
- Full `npm test` (vitest): **96 files / 1551 tests, all passing** (incl. the 12 changelog-contract tests and the expanded 56 pi-spawn tests).
- Non-goals honored: opt-in defaults OFF (isolation/determinism never changes unless the env var is explicitly set); safety factory, the `inheritedModelObject` model-inheritance path, control-flow node algebra, resume cache, and pipeline stage structure are untouched; every no-throw/best-effort guard and the print/json/rpc/headless zero-ANSI contract preserved.

## Deviations
- **None functional.** Every AC-01..AC-09 is covered by the implementation + tests + changelog.
- **Tracking artifact note:** the spec-dir `change-tracker.jsonl` records operations with an empty/`?` `path` field, which is why the upstream control reported `filesModified: none`. The real modified files are unambiguous from the two git commits (listed below) — this is the known empty-control failure class in learned.md, not a missing change. Worktree is otherwise clean (only the untracked spec docs directory remains, as expected at this stage).

## Files changed (git-confirmed)
1. `src/pi-spawn.ts` — new `inheritExtensions()` helper + `buildSpawnArgs` guard + trade-off comments.
2. `src/session-agent.ts` — import + `DefaultResourceLoader` `noExtensions: !inheritExtensions()` + trade-off comment.
3. `tests/pi-spawn.test.ts` — `inheritExtensions()` + `buildSpawnArgs` opt-in state tests.
4. `CHANGELOG.md` — spec-17 `### Added` entry.

## Phases

- **Phases Completed**: 2/2
- **All Green**: true

## Files Modified

- src/pi-spawn.ts
- src/session-agent.ts
- tests/pi-spawn.test.ts
- CHANGELOG.md
