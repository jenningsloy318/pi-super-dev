# Code Assessment: Codebase Assessment — build-gate timeout & package-scoping fix (pi-super-dev)

- **Date**: 2026-07-19
- **Author**: super-dev:code-assessor

---

## Executive Summary

pi-super-dev is an ESM TypeScript pi-extension (package.json "type":"module", tsconfig strict, build=tsc, typecheck=tsc --noEmit, test=vitest run). The build-gate lives entirely in src/build-runner.ts: a pure manifest detector `detectProjectCommands(cwd)` plus one side-effecting runner `runBuildGate(cwd, opts)` that spawnSyncs build/test/typecheck and collects real pass/fail + stderr tails. The two harness defects are localized to this file: (1) a hardcoded `DEFAULT_TIMEOUT_MS = 120_000` (line 22) resolved via `opts.timeoutMs ?? DEFAULT_TIMEOUT_MS` (line 160) and threaded into `spawnSync({ timeout })` (~line 173); (2) a workspace-wide Cargo test argv `["cargo","test","--quiet"]` (line 85) with no `-p` scoping. Three call sites (verify.ts:87, implementation.ts:64, index.ts:53) all pass ONLY `{ signal: ctx.signal }` — no timeoutMs — so making the helper read the env internally means ZERO call-site changes, matching the repo's established `process.env.SUPER_DEV_* ?? default` inline pattern (workflow.ts:103, session-agent.ts:295). The fix is backward-compatible, needs no new runtime deps, and follows existing vitest/tmpProj test conventions. There is no API/UI server to bring up — this is a library/extension consumed by pi; verification is `npm run typecheck` + `npm test`.

## Patterns

### Env-var config with SUPER_DEV_ prefix + inline default

- **Example**: src/workflow.ts:103 — `options.backend ?? (process.env.SUPER_DEV_BACKEND as ... ?? "session")`; src/session-agent.ts:295 — `process.env.SUPER_DEV_DEBUG`
- **Consistency**: High/established convention. The spec's SUPER_DEV_BUILD_TIMEOUT_MS / SUPER_DEV_BUILD_TEST_PACKAGES fit this exact shape. Parse defensively with `?? fallback`; do NOT introduce a new config-loader module.
### Single spawn-executing gate with timeout resolution via opts ?? const

- **Example**: src/build-runner.ts:158-160 — `runBuildGate(cwd, opts={timeoutMs?,signal?})`; `const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS`; spawnSync({cwd, timeout: timeoutMs}) inside the `exec` closure (~line 173)
- **Consistency**: Definitive. Fix 1 = resolve timeout from env HERE when opts.timeoutMs is undefined and bump default to 600_000. No second execution path exists.
### Pure detector / side-effecting runner split

- **Example**: src/build-runner.ts:54 detectProjectCommands(cwd) returns {language, build?, test?, typecheck?, ran[]} (Cargo at lines 84-87); runBuildGate is the only file-touching code
- **Consistency**: Hard rule. Helpers stay pure; build-runner is the documented exception (see file header JSDoc). -p scoping must be applied in runBuildGate (or a new pure helper it calls), NOT by mutating detectProjectCommands.
### Call sites pass only { signal } — no per-site timeout config

- **Example**: src/stages/verify.ts:87, src/stages/implementation.ts:64, src/stages/index.ts:53 — all three: `runBuildGate(path, { signal: ctx.signal })`
- **Consistency**: All three identical. Confirms the recommended mechanism (helper reads env internally) requires zero call-site edits; explicit override can still be threaded via the existing optional `timeoutMs`.
### Error reporting: string[] with `${label} FAILED (reason): <stderr tail>`

- **Example**: src/build-runner.ts exec closure — handles r.error / r.status!==0 / r.signal; `errors.push(`${label} FAILED (${reason})${tail?...":\n"+tail:``}`)`; STDERR_TAIL_LINES=12
- **Consistency**: Stable shape consumed by stages (buildGate.errors fed into reviewFix prompt at index.ts:~88). Preserve it; a scoped/longer command just flows through unchanged.
### Flat vitest test dir, self-contained tmpdirs, exact-argv assertions

- **Example**: tests/build-runner.test.ts — describe/it/expect; tmpProj() via mkdtempSync; asserts `expect(c.test).toEqual(["cargo","test","--quiet"])` (lines 27-31)
- **Consistency**: Strong: new tests go in tests/build-runner.test.ts mirroring tmpProj/describe. CRITICAL — line 27 asserts the EXACT cargo test argv, so do NOT mutate detectProjectCommands' test field (would break this); assert scoping on a separately-exported argv-building helper instead.
### JSDoc block comments document non-fatal/invariant behavior

- **Example**: src/build-runner.ts header + each fn has `/** ... */`; e.g. 'Non-fatal when no commands are detectable'
- **Consistency**: Add a comment documenting the two SUPER_DEV_* env vars and their fallback semantics on the new resolver/helper, matching existing tone.

## Files Assessed

- src/build-runner.ts
- src/stages/verify.ts
- src/stages/implementation.ts
- src/stages/index.ts
- tests/build-runner.test.ts
- package.json
- src/workflow.ts
- src/session-agent.ts
- README.md

## Recommendations

- Resolve the timeout INSIDE runBuildGate: add a `resolveTimeout()` that reads `parseInt(process.env.SUPER_DEV_BUILD_TIMEOUT_MS ?? '', 10)` and falls back to a new `DEFAULT_TIMEOUT_MS = 600_000` on NaN/<=0. Keep DEFAULT_TIMEOUT_MS exported (forward-compat; only internal refs exist today but the spec asks for it). Because all 3 call sites omit timeoutMs, this needs zero stage edits — matches the established SUPER_DEV_* inline-default pattern.
- Apply -p scoping in runBuildGate (NOT detectProjectCommands): when `opts.testPackages` is set OR `process.env.SUPER_DEV_BUILD_TEST_PACKAGES` (comma-split, trimmed, filtered) is set, build the cargo test argv as `["cargo","test", ...packages.flatMap(p=>["-p",p]), "--quiet"]`. Empty/unset → unchanged `cargo test --quiet`. This preserves the exact-argv assertion at tests/build-runner.test.ts:27 and keeps backward compatibility for non-Cargo repos (only branch when language==='rust').
- Add tests to tests/build-runner.test.ts using the existing tmpProj/describe style: (a) resolveTimeout fallback for undefined/NaN/0/negative/valid; (b) a pure `scopedTestArgs(cmds, packages)` helper asserting `["cargo","test","-p","a","-p","b","--quiet"]` and unchanged-when-empty. Export the helper so it is unit-testable without spawning cargo.
- Do NOT touch nodes.ts/workflow.ts/pipeline.ts/render templates (constraint). Keep the ProjectCommands/BuildGateResult interfaces as-is or only ADD optional fields (testPackages) — widening is safe; narrowing breaks consumers. README has NO config section today (grep empty), so adding one is optional — prefer the in-code JSDoc comment per existing convention.
