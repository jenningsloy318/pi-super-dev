# Code Assessment: Codebase Assessment: Scope-Aware Build Gate (pi-super-dev)

- **Date**: 2026-07-20
- **Author**: super-dev:code-assessor

---

## Executive Summary

pi-super-dev is a TypeScript pi-extension (ESM, `"type":"module"`, strict tsconfig, NodeNext module resolution) — a 13-stage development pipeline orchestrator, NOT a running server. The target change is scoped to two files: `src/build-runner.ts` (the deterministic build/test/typecheck gate, a spawnSync-based side-effecting module) and `src/stages/implementation.ts` (Stage 9 per-phase TDD loop that consumes the gate). The codebase has an exceptionally well-established pattern to follow: commit 97fc4df6 already added timeout + test-scoping via a clean precedence chain (explicit opts → env var → default) implemented as PURE, fully-documented, unit-testable helpers (`resolveTimeoutMs`, `parseTestPackages`, `scopedCargoTestArgs`) plus a SHALLOW-COPY scoping step in `runBuildGate` that keeps `detectProjectCommands` byte-identical. The required work is a faithful generalization of that exact pattern: (1) add `detectTouchedCargoPackages` (one `git diff --name-only`, never throws), (2) generalize `scopedCargoTestArgs`→`scopedCargoArgs(subcommand,...)` + build/clippy wrappers, (3) scope all three rust argvs (build/test/typecheck) instead of only `:301`'s test, (4) extend `BuildGateResult` with `outOfScopeErrors`+`inScopePass` and make implementation.ts treat `inScopePass` as GREEN. Tests are vitest, test-first (RED-phase), AC/SCENARIO-tagged describe blocks, with `tmpProj`/`withEnv` helpers and assertions reading `result.ran` (argv joined pre-spawn). Verification is `npm run typecheck` + `npm test` — there is NO API/UI server to start (services omitted). Backward compatibility is paramount: every fallback (non-rust, non-git, no touched crates, unset env) must remain byte-identical to today.

## Patterns

### Pure helper + precedence chain (explicit opt → env → default)

- **Example**: src/build-runner.ts:80-92 (resolveTimeoutMs) and :289-292 (testPackages resolution: `opts.testPackages !== undefined ? dedupePreservingOrder(opts.testPackages) : parseTestPackages(process.env.SUPER_DEV_BUILD_TEST_PACKAGES)`)
- **Consistency**: Canonical and consistent. Every tunable (timeout, test-packages) follows the same shape: a pure exported resolver, an env var documented in the module's top JSDoc, and explicit opts taking precedence including `[]` as a deliberate 'force default' signal. The new git-base-ref (`SUPER_DEV_GATE_BASE_REF`, default "main") and the auto-detected-touched-crates precedence tier MUST be added in this same style.
### Shallow-copy scoping keeps detectProjectCommands pure/byte-identical

- **Example**: src/build-runner.ts:299-301 (`cmds0.language === "rust" && testPackages.length > 0 && cmds0.test ? { ...cmds0, test: scopedCargoTestArgs(testPackages) } : cmds0`)
- **Consistency**: Strict invariant with a dedicated regression test (build-runner-packages.test.ts 'detectProjectCommands stays pure'). Generalizing to scope build+test+typecheck MUST preserve this: build the scoped copy by spreading cmds0 and overriding the three keys, never mutate cmds0, and when the package set is empty the result must equal cmds0 exactly. Inspect detectProjectCommands's Cargo.toml branch (:206-214) for the exact base argvs: build=["cargo","build","--quiet"], test=["cargo","test","--quiet"], typecheck=["cargo","clippy","--all-targets","--quiet"].
### spawnSync argv as discrete tokens (shell-safe, joined into ran[])

- **Example**: src/build-runner.ts:142-150 (scopedCargoTestArgs returns [...packages.flatMap(p=>["-p",p]),"--quiet"]) and :309 (`const r = spawnSync(argv[0], argv.slice(1), {cwd,timeout,encoding})`)
- **Consistency**: No `shell:true` anywhere; malicious names survive verbatim (SCENARIO-014 test). result.ran records `argv.join(" ")` BEFORE spawnSync (:308) so scoped argvs are assertable even when cargo is ENOENT — the new scoped build/clippy integration test should read result.ran exactly like the existing test-scope tests do.
### Never-throw defensive helpers; degrade to safe default

- **Example**: src/build-runner.ts:182-186 (readMaybe try/catch returns "") and :289-301 (empty/garbage → workspace-wide)
- **Consistency**: Consistent across the module. detectTouchedCargoPackages MUST follow: wrap the git diff in try/catch, and on ANY git error / empty stdout / non-crate paths return [] (→ workspace-wide fallback). inScopePass classifier must likewise never throw.
### Test-first vitest, AC/SCENARIO-tagged, env save/restore, no real toolchain

- **Example**: tests/build-runner-packages.test.ts:24-32 (tmpProj + withEnv helpers) and :193-280 (runBuildGate precedence tests read result.ran)
- **Consistency**: Established and uniform. New tests for touched-crate detection, scoped build/test/clippy argv construction, in-scope classification, and the git-diff-mocked runBuildGate integration MUST match this style: tmpProj() to make a throwaway dir, writeFileSync for manifests, withEnv() to save/restore SUPER_DEV_* env vars, describe names tagged 'AC-NN', and assert via result.ran/errors rather than spawning real cargo/git where possible. For the git-diff mock, prefer an in-tree fake 'crates/<pkg>/' layout in a tmp git repo OR spy on spawnSync per the existing pi-spawn.test.ts mocking approach.
### Stage retry loop: bounded attempts, feed prior errors forward, terminate-early on genuine failure

- **Example**: src/stages/implementation.ts:43-78 (for attempt 1..3 → tdd → impl → runBuildGate → break on gate.pass; `attemptErrors = gate.errors` threaded into next attempt's prompt at :55-58; :74-78 break on `!green`)
- **Consistency**: Single canonical consumer. The change is minimal: line :64 result must be read for both `.pass` and `.inScopePass`; line :66-73 log block gains an IN-SCOPE GREEN branch; line :74 `if(!green)` becomes the ONLY termination, where green = gate.pass || gate.inScopePass. Keep ControlObj shape stable (phasesCompleted/totalPhases/allGreen/filesModified/summary) — prior lessons flag malformed control as a top failure cause.

## Files Assessed

- src/build-runner.ts
- src/stages/implementation.ts
- tests/build-runner-packages.test.ts
- package.json
- tsconfig.json
- vitest.config.ts
- README.md

## Recommendations

- Mirror commit 97fc4df6's structure exactly: export detectTouchedCargoPackages, scopedCargoArgs(subcommand,packages,extraArgs?), scopedCargoBuildArgs, scopedCargoClippyArgs as pure JSDoc'd helpers; keep scopedCargoTestArgs as a 1-line wrapper so its existing tests (build-runner-packages.test.ts:111-160) still pass unchanged. Put the SUPER_DEV_GATE_BASE_REF doc block next to the SUPER_DEV_BUILD_TEST_PACKAGES block in the module top-comment so the precedence story (explicit → env → auto-touched → workspace-wide) reads as one narrative.
- For the three-command scoping, build ONE scoped cmds object in runBuildGate: `if (cmds0.language==='rust' && packages.length>0) cmds = { ...cmds0, build: scopedCargoBuildArgs(packages), test: scopedCargoTestArgs(packages), typecheck: scopedCargoClippyArgs(packages) } else cmds = cmds0`. This keeps the empty-packages path byte-identical (cmds0) and satisfies the 'non-crate paths / non-git → [] → workspace-wide' acceptance criterion with zero extra branching.
- Implement the in-scope classifier as a pure helper classifyGateErrors(errors, scopedPackages): { inScopeErrors, outOfScopeErrors } keyed off two regexes: `crates/<pkg>/` from `--> path`/failure-line paths AND `-p <pkg>` markers — and only classify a line OUT-OF-SCOPE when EVERY matched crate is absent from scopedPackages. Compute inScopePass = !pass && errors.length>0 && inScopeErrors.length===0. Add it to BuildGateResult as additive fields so non-rust/non-failure paths are unaffected (inScopePass irrelevant when pass:true).
- In implementation.ts make the smallest possible edit: `const green = gate.pass || gate.inScopePass;` computed right after the runBuildGate call (:64-66), add an explicit IN-SCOPE GREEN log line naming the ignored crates, and leave the `if(!green){...break;}` structure intact. Do NOT touch ControlObj, the budget check, the phase loop, or filesModified aggregation — the malformed-control lessons (filesModified char-split) make minimalism here a hard safety constraint. Add future-work note on full main-baseline-diff (#3) only in the implementation summary doc, not code.
