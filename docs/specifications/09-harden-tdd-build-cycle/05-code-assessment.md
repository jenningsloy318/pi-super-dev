# Code Assessment: Codebase Assessment — Hardening the super-dev TDD/Build Cycle (RED oracle, npm in-scope gate, test-parity)

- **Date**: 2025-01-15
- **Author**: super-dev:code-assessor

---

## Executive Summary

pi-super-dev is a self-contained, composable control-flow pipeline (13 stages, ~21 spawned pi subagents) packaged as a pi extension/library. The hardening work is concentrated in three modules: `src/build-runner.ts` (the deterministic build/test/typecheck "hard oracle", 1111 lines), `src/stages/implementation.ts` (Stage 9 per-phase TDD loop), and `src/prompts.ts` (prompt builders), plus the render layer (`src/render/dashboard.ts`, `src/render/stream-theme.ts`) for the Theme parity fix. The codebase has a strong, consistent NEVER-THROW / degrade-to-safe-default discipline (every git/cargo/spawn helper returns `[]` or a conservative verdict on any ambiguity) and a clean scoped-argv + `spawnSync({cwd,timeout,encoding})` envelope — `runRedCheck` and the npm in-scope classifier should reuse `detectProjectCommands`, `resolveTimeoutMs`, `resolveIntegrationStems`, and a shared `touchedFilePaths` extracted from `detectTouchedCargoPackages`. KEY DELTAS to note: (1) Gap 3 is PARTIALLY done — `RUST_SELF_VERIFY_DISCIPLINE` already forbids `--lib`-only in `buildImplementPrompt` (rust-gated), but `buildTddPrompt` does NOT have it; that's the real gap. (2) The existing Theme regression test (`tests/stream-theme-class-theme.test.ts`) only fakes a `ClassTheme` + calls `initTheme()` for the markdown global — it does NOT obtain the REAL pi Theme proxy object, so `withRealTheme` must first discover the real accessor from `@earendil-works/pi-coding-agent`'s exports. (3) vitest includes BOTH `tests/**/*.test.ts` AND `src/**/*.test.ts`, and tsconfig `include:["src","tests"]`, so new `tests/helpers/*` and `tests/render/*.test.ts` files are valid without config changes. There is NO long-running API/UI server — the repo is a library; verification is `npm test` (vitest run) + `npm run typecheck` (tsc --noEmit). No new runtime deps permitted.

## Patterns

### NEVER-THROW / degrade-to-safe-default (the dominant invariant)

- **Example**: src/build-runner.ts:485 (detectTouchedCargoPackages wraps git spawns in try/catch → []); :414 (resolveIntegrationStems skips unresolvable); :687 (classifyOutOfScopeErrors conservative on ambiguity); :932 (runBuildGate non-fatal when nothing detected)
- **Consistency**: Pervasive and load-bearing. EVERY new helper (runRedCheck, touchedFilePaths, npm failing-file parser) MUST wrap its whole body in try/catch and return a safe default (unknown / [] / in-scope) on any spawn error, parse ambiguity, or missing runner. This is the single most important convention to mirror; the acceptance criteria re-state it four times.
### Per-language project detection via detectProjectCommands

- **Example**: src/build-runner.ts:852 — returns ProjectCommands with `language` (rust|go|python|frontend|backend|mixed), per-language argv arrays, a `ran` label set, and for npm a `pm` field (detectPm at :842)
- **Consistency**: runRedCheck must branch on `cmds.language` exactly like runBuildGate does (cargo → `-p <pkg> --test <stem>`; npm → `pm run test -- <files>` / direct `vitest run`; pytest → `pytest <files>`). Reuse this rather than re-detecting manifests. Never assume a runner exists — greenfield returns `{language:'mixed',ran:[]}` → red status 'unknown'.
### Scoped-argv helpers + spawnSync envelope

- **Example**: src/build-runner.ts:612 (scopedCargoTestArgs), :567 (scopedCargoArgs), :84 (resolveTimeoutMs reads SUPER_DEV_BUILD_TIMEOUT_MS), spawnSync called at :1034 as spawnSync(argv[0], argv.slice(1), {cwd, timeout: timeoutMs, encoding:'utf8'})
- **Consistency**: runRedCheck must (a) derive cargo test-binary stems from tdd-guide testFiles via resolveIntegrationStems (:414), (b) invoke per-stem `cargo test -p <pkg> --test <stem>` or npm/pytest scoped form, (c) run inside resolveTimeoutMs(opts.timeoutMs). Do NOT introduce a new timeout resolution path.
### Git union for the touched-file set (basis for in-scope classification)

- **Example**: src/build-runner.ts:498-501 — detectTouchedCargoPackages spawns `git -C <cwd> diff --merge-base <ref> --name-only` AND `git -C <cwd> ls-files --others --exclude-standard`, concatenates stdouts (base-ref precedence: arg > SUPER_DEV_GATE_BASE_REF > 'main')
- **Consistency**: Gap 4 (npm in-scope) needs the SAME touched set but as raw FILE PATHS, not crate segments. Extract a shared `touchedFilePaths(cwd, baseRef?)` returning the diff+untracked line union; refactor detectTouchedCargoPackages to map crate segments over it (no behavior change), and have the npm classifier consume the path union directly. Keeps the 'bounded git spawns' invariant — no new git processes beyond this union.
### In-scope / out-of-scope error partitioning (cargo today; generalize to npm)

- **Example**: src/build-runner.ts:687 (classifyOutOfScopeErrors), :780-801 (BuildGateResult.inScopePass + outOfScopeErrors fields), :1098-1100 (inScopePass = pass || all-failures-out-of-scope)
- **Consistency**: implementation.ts:93 already treats `gate.pass || gate.inScopePass` as green, so generalizing inScopePass to npm needs NO stage change. Reuse the BuildGateResult fields verbatim. CRITICAL conservative rule from the cargo path: a no-marker / mixed / ambiguous error stays in `errors` and is NEVER promoted to outOfScope (never grants a false green) — npm in-scope MUST mirror this: parse ambiguity → in-scope.
### Prompt builders: array-join + ctxBlock + language-gated append constants

- **Example**: src/prompts.ts — buildTddPrompt (~:135) and buildImplementPrompt (~:170) join string arrays with \n; RUST_SELF_VERIFY_DISCIPLINE const (~:155) + rustDiscipline(s) gate (returns '' unless s.language==='rust') appended to buildImplementPrompt
- **Consistency**: GAP 3 DELTA: the no-`--lib`/full-`cargo test -p` rule ALREADY exists for buildImplementPrompt (gated to rust via s.language). The actual missing piece is the SAME rule in buildTddPrompt (it takes a `langInstructions` param but the rust rule is NOT appended). Add a rust-gated rule there so RED checks cover integration tests. buildTddPrompt also returns {testsWritten,testFiles,allFailing} — implementation.ts must READ those.
### Stage control surface (ctx.agent / ctx.helper / ctx.log)

- **Example**: src/stages/implementation.ts:70 (ctx.agent({id, agent:'tdd-guide', prompt}) — result DISCARDED today, the bug), :77 (implementer agent), :84 (runBuildGate called synchronously), :93 (gate.pass||gate.inScopePass), :14 imports GateOptions from build-runner
- **Consistency**: runRedCheck wires in here: capture the tdd-guide agent's `.control` ({testFiles}), call runRedCheck(worktree, testFiles), loop re-prompting tdd-guide on green/broken (≤MAX_RED_RETRIES=2 WITHIN the existing attempt; MAX_ATTEMPTS stays 3), log each red-oracle status, proceed on red|unknown. State accessed via state.spec?.gate; normalizePhases guards control shape.
### Test conventions: vitest + vi.mock child_process + colocated & top-level tests

- **Example**: src/build-runner.test.ts:39-40 — vi.mock('node:child_process', () => ({ spawnSync:(cmd,argv)=>{...} })) with a module-level mock-state object reset per test; vitest.config.ts includes ['tests/**/*.test.ts','src/**/*.test.ts']; tsconfig.json include:['src','tests']
- **Consistency**: runRedCheck unit tests (per-status red/green/broken/unknown) MUST use this exact vi.mock spawnSync stub pattern. New files tests/helpers/real-theme.ts and tests/render/real-theme-parity.test.ts are valid WITHOUT config edits (vitest globs tests/**, tsconfig includes tests). The implementation.ts retry-loop test can stub runRedCheck the same way.
### Class-based Theme regression guard (the fgColors bug class)

- **Example**: tests/stream-theme-class-theme.test.ts — defines a local ClassTheme with this.fgColors Map, calls initTheme() in beforeAll, asserts themeLine/commandBackground/buildResultComponent don't throw when called method-style against a class theme
- **Consistency**: Gap 2 generalizes this. BUT NOTE: the existing test FAKE-builds a ClassTheme — it does NOT obtain the REAL pi Theme proxy from @earendil-works/pi-coding-agent (it only calls initTheme() to seed the markdown global). withRealTheme must discover the real proxy accessor (e.g. getTheme()/useTheme/return value of initTheme) BEFORE writing tests/helpers/real-theme.ts. Render targets to exercise: themeLine, commandBackground (src/render/stream-theme.ts:139,206); buildResultComponent, packDashboardLines, createDashboardWidgetFactory (src/render/dashboard.ts:360,208,295). NEVER destructure theme methods (this.fgColors) — always theme.fg(...) method-style; keep this regression test green.

## Files Assessed

- package.json
- README.md
- tsconfig.json
- vitest.config.ts
- src/build-runner.ts
- src/stages/implementation.ts
- src/prompts.ts
- src/render/dashboard.ts
- src/render/stream-theme.ts
- src/build-runner.test.ts
- tests/stream-theme-class-theme.test.ts

## Recommendations

- Model runRedCheck(cwd, testTargets, opts) directly on runBuildGate's skeleton (src/build-runner.ts:932): detectProjectCommands(cwd) → branch on cmds.language → build scoped argv (cargo: resolveIntegrationStems(testTargets) → per-stem `cargo test -p <pkg> --test <stem>`; npm: `pm run test -- <files>` or direct `vitest run <files>`; pytest: `pytest <files>`) → spawnSync({cwd, timeout:resolveTimeoutMs(opts.timeoutMs), encoding:'utf8'}) → classify stdout/exit into ONE of red|green|broken|unknown. Wrap the ENTIRE body in try/catch; return 'unknown' on no runner, empty testTargets, spawn error, or parse ambiguity. Define a RedCheckOptions sharing {timeoutMs?, signal?} with GateOptions; export a `type RedStatus`.
- Extract `touchedFilePaths(cwd, baseRef?): string[]` from detectTouchedCargoPackages (src/build-runner.ts:498-501) — it returns the raw union of `git diff --merge-base <ref> --name-only` + `git ls-files --others --exclude-standard` lines (never throws, [] on any error). Refactor detectTouchedCargoPackages to map CRATE_SEGMENT_RE over touchedFilePaths (zero behavior change, keeps the 9 touched-crates tests green). The npm in-scope classifier then consumes the raw path union — no new git spawns.
- For npm/vitest/jest in-scope (Gap 4): add `parseFailingNpmTestFiles(combinedOutput): string[]` matching vitest `❯ <path>` and jest `FAIL <path>` markers. In runBuildGate, when an npm-family test step failed, compute touched = touchedFilePaths(cwd, SUPER_DEV_GATE_BASE_REF/opts.baseRef), classify each failing file OUT-of-scope if NOT in touched, populate BuildGateResult.outOfScopeErrors + set inScopePass exactly like the cargo path (:1098-1100). On ANY parse ambiguity (unrecognized runner output, path that doesn't resolve), treat as IN-SCOPE (conservative — never a false green). Unit-test with a stubbed failing-test stdout (mirror src/build-runner.test.ts:39 vi.mock).
- Gap 3 is mostly done: RUST_SELF_VERIFY_DISCIPLINE already forbids --lib-only in buildImplementPrompt (rust-gated via rustDiscipline(s)). The real delta is buildTddPrompt — add the SAME no-`--lib`/full-`cargo test -p` + integration-target rule there (it accepts a langInstructions param but currently receives no rust discipline). This makes the RED phase itself run the tests/ integration binaries, so runRedCheck's red verdict covers integration, not just lib unit tests.
- In implementation.ts (src/stages/implementation.ts:70): capture the tdd-guide agent's `.control` → {testFiles}. Introduce MAX_RED_RETRIES=2 INSIDE the existing attempt loop (do NOT change MAX_ATTEMPTS=3). Loop: while status==='green'|'broken', re-prompt tdd-guide with a hint ('your tests passed already / failed to compile — write genuinely-failing, non-broken tests') up to the cap. Proceed on 'red'|'unknown'. Log `Implementation ${phaseId} red-oracle: ${status} (ran: …)` each iteration. Augment the implementer prompt with 'tests confirmed-red; goal is to green them'. Never stall: unknown + retry-cap both proceed with a loud warning.
- Before writing tests/helpers/real-theme.ts, DISCOVER the real pi Theme proxy accessor (the existing tests/stream-theme-class-theme.test.ts only fakes ClassTheme + calls initTheme() for the markdown global; it never gets the real proxy). Check @earendil-works/pi-coding-agent exports (likely getTheme()/useTheme() or a return value from initTheme()). withRealTheme<T>(fn:(theme:Theme)=>T) should initTheme() (idempotent) then hand the REAL proxy to fn so the WHOLE render layer (themeLine, commandBackground, buildResultComponent, packDashboardLines, createDashboardWidgetFactory output) is exercised against the real class-based Theme. Call theme.fg(...) method-style only.
- Keep backward compatibility provable: greenfield (no runner/no tests) → runRedCheck 'unknown' → proceeds exactly as today; repos with no test failures → runRedCheck 'green' (no longer a proceed on its own — but that only triggers a re-prompt, and after MAX_RED_RETRIES it proceeds with a warning, so a greenfield-with-incidental-green-tests repo is unaffected in the end state); cargo inScopePass behavior untouched. Run `npm test` AND `npm run typecheck` to green before finishing — the build-runner suite is large (scoped-args, touched-crates, autoscope, inscope-classification, resolver-validation, nonregression, package-wiring, timeout, backward-compat-regression) and any helper-signature refactor MUST keep them green or update them in the same change.
