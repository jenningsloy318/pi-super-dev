# Code Assessment: Codebase Assessment — SUPER_DEV_INHERIT_EXTENSIONS opt-in (Gap #3)

- **Date**: 2026-07-22
- **Author**: super-dev:code-assessor

---

## Executive Summary

pi-super-dev is a pure-TS pi-extension library (ESM, `tsc` build, `vitest` test) that spawns specialist `pi` agents via two backends. The change is tiny and self-contained: add an exported `inheritExtensions()` env-reader in `src/pi-spawn.ts` (mirroring the existing `SUPER_DEV_MODEL`/`SUPER_DEV_THINKING` pattern) and flip two gating expressions — `noExtensions: !inheritExtensions()` in `src/session-agent.ts:487` and `if (!browser && !inheritExtensions()) args.push("--no-extensions")` in `src/pi-spawn.ts:276`. There is NO server/API/UI to run: local verification is `npm run typecheck` (tsc --noEmit, strict) and `npm test` (vitest run). The two backends are already co-located, the env-var + regex-parse helper idiom is established, and the test harness (a local `saveEnv()` snapshot/clear/restore helper + direct `buildSpawnArgs`/function import) is ready to extend. The CHANGELOG has a Keep-a-Changelog contract test (`tests/changelog-unreleased-spec15.test.ts`) whose bold-bullet anchor regex is `(inherit|model|thinking|constrain|structured...|registerEntryRenderer|PI_SESSION_ID|PI_MODEL)` — so the new `### Added` bullet's bold span MUST contain `inherit` (and/or `model`); bare `extensions`/`provider` alone will NOT match.

## Patterns

### Env-var helper idiom (parse + regex + .trim(), exported from pi-spawn.ts)

- **Example**: src/pi-spawn.ts:176-185 (resolveModel reads process.env.SUPER_DEV_MODEL?.trim()) and :155 (asThinkingLevel via /^(...)$/i)
- **Consistency**: High — the proposed inheritExtensions() regex `/^(1|true|yes|on)$/i` on `process.env.SUPER_DEV_INHERIT_EXTENSIONS.trim()` is byte-for-byte the established style; place it next to resolveModel/asThinkingLevel.
### Two-backend gating: session (in-process) vs subprocess (argv flag)

- **Example**: src/session-agent.ts:483-488 (DefaultResourceLoader noExtensions:true) vs src/pi-spawn.ts:276 (if (!browser) args.push("--no-extensions"))
- **Consistency**: Both must flip in lockstep. Session uses noExtensions boolean; subprocess uses the --no-extensions argv flag gated by isBrowserAgent(). Browser agents already omit the flag — preserve that branch exactly.
### Additive, no-throw, byte-identical-when-unset contract

- **Example**: src/pi-spawn.ts:280-291 (Model precedence explicit→env→inherited→default; --model pushed ONLY when a value resolves) and src/session-agent.ts:502-520 (try/catch best-effort model resolve)
- **Consistency**: The opt-in MUST default OFF and produce byte-identical behavior when unset/falsy. Every SUPER_DEV_* tier in this file degrades cleanly to today's baseline — mirror that.
### Vitest env test harness: local saveEnv(...keys) snapshot/clear/restore

- **Example**: tests/pi-spawn.test.ts:194-200 (saveEnv def) and :246-249 (const env=saveEnv(...); beforeEach(env.clear); afterEach(env.restore))
- **Consistency**: Reuse this exact helper for the inheritExtensions() + --no-extensions tests. Import the function under test directly from ../src/pi-spawn.ts (already the pattern).
### buildSpawnArgs argv assertions via toContain/not.toContain + indexOf

- **Example**: tests/pi-spawn.test.ts:257-285 (asserts args.toContain("--model") and args[args.indexOf("--model")+1])
- **Consistency**: For the new --no-extensions test: assert args.toContain("--no-extensions") when OFF/not a browser agent; args.not.toContain("--no-extensions") when ON; and browser agents never contain it regardless. A normal non-browser agent like 'requirements-clarifier' is the existing base fixture.
### CHANGELOG Keep-a-Changelog bold-bullet anchor contract

- **Example**: tests/changelog-unreleased-spec15.test.ts:105-112 (boldBulletAnchored regex requires - **...anchor...**) and :114-117 (must sit under ### Added/Changed/Fixed)
- **Consistency**: New entry goes under a new ### Added block inside [Unreleased] (already two ### Added blocks exist — fine). The bold span text MUST contain an anchor token; use 'inherit'/'model' in the title (e.g. 'Inherit extension-registered providers via SUPER_DEV_INHERIT_EXTENSIONS'). 'extensions'/'provider' alone do NOT satisfy the regex.
### Dual import surface: ts source imported directly in tests (no dist)

- **Example**: tests/pi-spawn.test.ts:10 (import {buildSpawnArgs,...} from "../src/pi-spawn.ts")
- **Consistency**: Tests and intra-src imports use the .ts extension and relative paths; no build step needed to run vitest. inheritExtensions() is imported the same way.

## Files Assessed

- /home/jenningsl/development/personal/jenningsloy318/pi-super-dev/.worktree/17-goal-super-dev-inherit-extensions/package.json
- /home/jenningsl/development/personal/jenningsloy318/pi-super-dev/.worktree/17-goal-super-dev-inherit-extensions/src/pi-spawn.ts
- /home/jenningsl/development/personal/jenningsloy318/pi-super-dev/.worktree/17-goal-super-dev-inherit-extensions/src/session-agent.ts
- /home/jenningsl/development/personal/jenningsloy318/pi-super-dev/.worktree/17-goal-super-dev-inherit-extensions/tests/pi-spawn.test.ts
- /home/jenningsl/development/personal/jenningsloy318/pi-super-dev/.worktree/17-goal-super-dev-inherit-extensions/tests/changelog-unreleased-spec15.test.ts
- /home/jenningsl/development/personal/jenningsloy318/pi-super-dev/.worktree/17-goal-super-dev-inherit-extensions/CHANGELOG.md
- /home/jenningsl/development/personal/jenningsloy318/pi-super-dev/.worktree/17-goal-super-dev-inherit-extensions/README.md

## Recommendations

- Add `inheritExtensions()` in src/pi-spawn.ts adjacent to resolveModel/asThinkingLevel (lines ~155-185) — it is the canonical home for SUPER_DEV_* reads and is already imported by session-agent.ts; export it and import it into session-agent.ts for the noExtensions flip.
- Wire BOTH gates atomically: src/session-agent.ts:487 `noExtensions: !inheritExtensions()` and src/pi-spawn.ts:276 `if (!browser && !inheritExtensions()) args.push("--no-extensions")`. Leave the safety factory in extensionFactories and the browser/research branches untouched; add a one-line comment at each site noting determinism is lost when opted in (intended for extension-registered providers).
- Write tests in tests/pi-spawn.test.ts reusing its local saveEnv() helper (snapshot/clear/restore): (a) inheritExtensions() truthy/falsy parsing incl. '0'/'false'/''/garbage→false; (b) buildSpawnArgs for a non-browser agent ('requirements-clarifier') contains '--no-extensions' when unset, omits it when SUPER_DEV_INHERIT_EXTENSIONS=1, and a browser agent ('qa-agent' via isBrowserAgent) never contains it either way. The session loader is not trivially unit-testable in isolation, so the inheritExtensions() unit test + documented wiring is the accepted bar (per the spec).
- CHANGELOG: add a new `### Added` bullet under `[Unreleased]` whose bold title contains the anchor token `inherit` (e.g. '**Inherit extension-registered providers via SUPER_DEV_INHERIT_EXTENSIONS opt-in (spec-17).**'). Avoid relying on 'extensions'/'provider' as the only keyword — the boldBulletAnchored regex in tests/changelog-unreleased-spec15.test.ts:105 only matches inherit|model|thinking|constrain|structured-output|registerEntryRenderer|PI_SESSION_ID|PI_MODEL.
- Verify locally with `npm run typecheck` (tsc --noEmit, strict) and `npm test` (vitest run). There is no API/UI server to start — this is a library consumed as a pi extension, so the verify-loop's 'bring the app up' step is the test suite itself.
