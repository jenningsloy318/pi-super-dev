# Code Assessment: Codebase Assessment — Cargo Package Name Resolution (build-runner gate + verify prompts)

- **Date**: 2026-07-20
- **Author**: super-dev:code-assessor

---

## Executive Summary

pi-super-dev is a pure-TypeScript pi-extension (strict, ESM, `type: module`) implementing a 13-stage development pipeline. There is NO running API/UI server — it is a library consumed by the `pi` CLI, so verification is `npm run typecheck` + `npm test` (vitest), not a live service. The target of this fix is `src/build-runner.ts`, the "deterministic build/test/typecheck gate — the HARD test oracle" that spawns real cargo/git commands and is consumed by Stages 9/9.2/11. The confirmed bug: `detectTouchedCargoPackages` (src/build-runner.ts:161-181) returns workspace DIRECTORY names (`crates/<seg>/` → `<seg>`), which `scopedCargoArgs` (src/build-runner.ts:213-228) passes verbatim as `-p <name>`; cargo rejects these on any workspace that prefixes crate names. Fix 1 adds a `cargo metadata --no-deps` resolver mapping dir→real-package-name; Fix 2 verifies the full touched set survives; Fix 3 is a prompt change. Key localization finding: the actual prompt TEXT does not live in `src/stages/implementation.ts`/`verify.ts` (they only orchestrate agents + append build-gate failure strings) — it lives in the pure prompt builders in `src/prompts.ts` (`buildImplementPrompt` ~line 95, `buildImplementationSummaryPrompt` ~line 98), so Fix 3 must edit `src/prompts.ts`, with the idiomatic injection point being the Language-Specific Instructions block (`li`/`lang`) already threaded into `buildImplementPrompt`. All three fixes are additive and fit existing patterns: the module already centralizes spawnSync behind a single import (src/build-runner.ts:18), stubs it in tests via `vi.mock("node:child_process")` (tests/build-runner-touched-crates.test.ts:33-37), and follows a strict never-throw safe-degradation + pure-helper convention. No new runtime deps, no server to bring up. SERVICES NOTE: this package has no API or UI server entrypoint — it is a CLI library (package.json scripts: build/typecheck/test only; no start/dev/serve, no PORT env, no health endpoint). The verify-loop should NOT attempt to bring up a service; gate green is determined solely by `npm run typecheck` (tsc --noEmit) and `npm test` (vitest run) both passing.

## Patterns

### Side-effecting module: single `spawnSync` import, pure argv helpers, never-throw

- **Example**: src/build-runner.ts:18 (import), src/build-runner.ts:161-181 (`detectTouchedCargoPackages` wraps entire body in try/catch returning [] on any failure)
- **Consistency**: Strict and uniform across the module. Every spawn-based function (detectTouchedCargoPackages) is fully try/caught and returns a safe empty value; argv builders (scopedCargoArgs family, src/build-runner.ts:213-276) are pure & side-effect-free. The new `resolveCargoPackageNames` MUST follow both: never throw (degrade to dir-name fallback), and keep scopedCargoArgs pure.
### spawnSync stubbing in tests via vi.mock — assert argv from mock.calls

- **Example**: tests/build-runner-touched-crates.test.ts:33-37 (`vi.mock("node:child_process", () => ({ spawnSync: vi.fn() }))`), tests/build-runner-touched-crates.test.ts:44,230 (`const spawn = spawnSync as ...; spawn.mockReturnValue({...}); spawn.mock.calls[0]?.[1])
- **Consistency**: Canonical and mandatory — real git/cargo must NEVER run in CI. New tests for `resolveCargoPackageNames` (cargo metadata stub, cache-hit, failure fallback) and the end-to-end `-p` flag test should reuse this exact mock pattern and assert discrete argv elements (named `cargo`, no `shell:true`).
### runBuildGate FOUR-tier precedence (opts > env > autodetect(rust-only) > workspace-wide)

- **Example**: src/build-runner.ts:540-554 (opts.testPackages → SUPER_DEV_BUILD_TEST_PACKAGES → detectTouchedCargoPackages only when cmds0.language==='rust' → []), src/build-runner.ts:561-566 (shallow-copy cmds with scoped argv when rust + non-empty)
- **Consistency**: Central architectural invariant. Fix 1/2 must slot `resolveCargoPackageNames` INSIDE `detectTouchedCargoPackages` (tier iii, rust-only) — do not add a new tier or change precedence. The git-diff spawn stays the only spawn in tier iii; cargo metadata becomes the second cached spawn.
### dedupePreservingOrder + first-seen order everywhere

- **Example**: src/build-runner.ts:99 (`dedupePreservingOrder`), src/build-runner.ts:179 (`return dedupePreservingOrder(pkgs)`)
- **Consistency**: Order-preserving dedupe is THE convention for package sets. The metadata resolver must dedupe + preserve first-seen order of touched dirs, and the cache must be keyed by cwd only (never across runs).
### Prompt builders are PURE string-array.join functions in src/prompts.ts (NOT in stages/)

- **Example**: src/prompts.ts:95 (buildImplementPrompt — array.join with `li` Language-Specific block injection) and src/prompts.ts:98 (buildImplementationSummaryPrompt — 'Run the full test suite and verify build succeeds'), consumed in src/stages/implementation.ts:10,73-77,122
- **Consistency**: Strong and uniform: stages orchestrate (call ctx.agent, append build-gate error strings src/stages/verify.ts:106,219) while ALL prompt text lives in src/prompts.ts as `[ctxBlock(s,c), '', '## Phase', ...].join('\n')`. Fix 3 (--lib ban + full cargo test -p <pkg> requirement) belongs in src/prompts.ts, ideally injected via the existing Language-Specific Instructions `lang`/`li` variable so cargo guidance is scoped to rust workspaces.
### JSDoc-heavy exports with SCENARIO-NNNN test cross-references and 'NEVER throws / byte-identical' guarantees

- **Example**: src/build-runner.ts:30-86 (DEFAULT_TIMEOUT_MS doc referencing SCENARIO-007/006/008/014/020/022/023), src/build-runner.ts:140-160 (detectTouchedCargoPackages doc)
- **Consistency**: Every exported function carries rich JSDoc citing the exact test scenarios that pin its contract and explicit safe-degradation guarantees. New `resolveCargoPackageNames` export should match this: document the cargo metadata mapping, the dir-name fallback chain, the per-cwd cache, and reference the new test scenarios.

## Files Assessed

- src/build-runner.ts
- src/stages/implementation.ts
- src/stages/verify.ts
- src/prompts.ts
- tests/build-runner-touched-crates.test.ts
- tests/build-runner-scoped-args.test.ts
- package.json
- README.md

## Recommendations

- Implement Fix 1 inside `src/build-runner.ts` exactly as the patterns dictate: add `export function resolveCargoPackageNames(cwd: string, touchedDirs: string[]): string[]` that spawns `cargo metadata --format-version 1 --no-deps --manifest-path <cwd>/Cargo.toml` via the module's existing single `spawnSync` import (src/build-runner.ts:18), with the SAME bounded-timeout + `encoding:'utf8'` envelope, parses JSON, maps each touched `crates/<dir>/` to the workspace package whose `manifest_path` parent dir matches `crates/<dir>/`, and returns dedupePreservingOrder'd real names (src/build-runner.ts:99). Wire it as the final mapping step at the end of `detectTouchedCargoPackages` (src/build-runner.ts:179) BEFORE the dedupe return — pass the collected dir segments through it. Add a per-cwd in-process Map cache keyed by cwd holding the parsed metadata (spawn at most once per cwd per run).
- Honor the never-throw + fallback invariant explicitly: if cargo metadata fails / times out / cargo not installed / matches nothing, `resolveCargoPackageNames` MUST return the touchedDirs unchanged (current dir-name behavior), wrapped in try/catch — this is the same safe-degradation contract as `detectTouchedCargoPackages` (src/build-runner.ts:140-160). This guarantees backward compatibility (dir==name workspaces, non-cargo/non-git repos) and acceptance criterion #7.
- For Fix 3, edit `src/prompts.ts` — NOT src/stages/implementation.ts or verify.ts (those only orchestrate). The `--lib` ban + full `cargo test -p <pkg>` + spec-mandated e2e requirement belongs in `buildImplementPrompt` (src/prompts.ts:95) and/or `buildImplementationSummaryPrompt` (src/prompts.ts:98), and the idiomatic injection point is the existing Language-Specific Instructions variable `li`/`lang` already joined into buildImplementPrompt (so cargo guidance is gated to rust workspaces only, matching the gate's `cmds0.language === 'rust'` guard at src/build-runner.ts:550,561).
- Write tests in `tests/build-runner-*.test.ts` reusing the exact `vi.mock("node:child_process", ...)` stub pattern (tests/build-runner-touched-crates.test.ts:33-37), asserting argv via `spawn.mock.calls[0]?.[1]`. Cover: (a) dir→prefixed-name resolution against a stubbed `cargo metadata` JSON (manifest_path in a nested subdir); (b) metadata-failure/empty/non-match → dir-name fallback; (c) cache hit asserts the metadata spawn fires once even when resolveCargoPackageNames is called twice for the same cwd; (d) end-to-end `scopedCargoArgs('test', resolveCargoPackageNames(...), ['--quiet'])` yields `-p stockfan-data -p stockfan-tools -p stockfan-workflows` for the stockfan dir shape. Assert the mock receives `cargo metadata` with discrete argv (named 'cargo', no `shell:true`) to mirror SCENARIO-020/014 conventions.
