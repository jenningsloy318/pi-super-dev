# Implementation Plan: Technical Specification: SUPER_DEV_INHERIT_EXTENSIONS opt-in (spec-17, Gap #3)

- **Date**: 2026-07-22
- **Status**: ✅ COMPLETE — 2/2 phases landed (commits `9be2f363`, `4ed516c4` on `17-goal-super-dev-inherit-extensions`).

---

## Phase 1: Opt-in helper, dual-backend wiring, trade-off comments, and focused tests ✅

Add the exported `inheritExtensions()` env-reader to src/pi-spawn.ts (adjacent to resolveModel/asThinkingLevel), flip both gating expressions in lockstep (`noExtensions: !inheritExtensions()` in src/session-agent.ts:487; `if (!browser && !inheritExtensions()) args.push("--no-extensions")` in src/pi-spawn.ts buildSpawnArgs ~276), add concise determinism-trade-off comments at both wiring points, and add focused vitest tests in tests/pi-spawn.test.ts reusing the local saveEnv() harness (inheritExtensions() truthy/falsy/garbage parsing + buildSpawnArgs flag presence/absence for non-browser vs browser agents across opt-in states). These edits are mutually interdependent — the helper must exist before either wiring references it, and both wirings must land before the tests assert on them, and all three touch overlapping files (pi-spawn.ts carries helper + subprocess wiring; its test file asserts on both) — so they are merged into a single coarse phase to avoid cascade-failure. Covers AC-01..AC-06 and SCENARIO-001..011, SCENARIO-016.
## Phase 2: CHANGELOG Added entry (parallelizable with Phase 1) ✅

Add a new `### Added` bullet under the `[Unreleased]` heading in CHANGELOG.md summarizing the opt-in, whose FIRST bullet is a bold (`**...**`) bullet whose bold-span text carries the contract anchor token `inherit` (e.g. `**Inherit extension-registered providers via SUPER_DEV_INHERIT_EXTENSIONS opt-in (spec-17).**`) so tests/changelog-unreleased-spec15.test.ts's boldBulletAnchored regex (`inherit|model|thinking|constrain|structured-output|registerEntryRenderer|PI_SESSION_ID|PI_MODEL`) matches. Do NOT remove or reorder any previously-matched anchor/bullet. This phase is file-independent from Phase 1 (touches only CHANGELOG.md + its pre-existing contract test) and may be executed in parallel; its deliverable is the contract test staying green. Covers AC-07 and SCENARIO-012.
