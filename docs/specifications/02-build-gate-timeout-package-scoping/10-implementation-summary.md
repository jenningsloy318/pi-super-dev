# Implementation Summary: Build-gate: configurable timeout + per-package test scoping

- **Date**: 2026-07-19

---

## Summary

## What was built

A pure-TypeScript, backward-compatible fix for two harness-side defects in pi-super-dev's deterministic build-gate (`src/build-runner.ts`) that caused false FAILs on Rust and other slow-compiling workspaces, aborting Stage 9 (verify) and blocking Stage 11 (merge). The fix changes only HOW the harness *invokes* commands (argv + timeout) — the target repo is never mutated.

### Phase 1 — Configurable per-command timeout (Fix 1)
- Raised exported `DEFAULT_TIMEOUT_MS` from `120_000` → `600_000` (10 min) so a clean `cargo build+test+clippy` no longer ETIMEDOUTs.
- Added exported pure helper `resolveTimeoutMs(explicit?: number): number` with precedence: explicit finite-positive opt → `parseInt(process.env.SUPER_DEV_BUILD_TIMEOUT_MS)` → `DEFAULT_TIMEOUT_MS`. Missing/empty/NaN/`<=0` env values fall back to the default.
- `runBuildGate` now resolves its timeout via `resolveTimeoutMs(opts.timeoutMs)`; the value threads unchanged into every `spawnSync(..., { timeout })` in the `exec` closure, so build/test/typecheck each inherit it.
- All three stage call sites (`verify.ts:87`, `implementation.ts:64`, `index.ts:53`) remain `runBuildGate(path, { signal: ctx.signal })` — they inherit the higher default + env override automatically with zero edits.

### Phase 2 — Per-package Cargo test scoping (Fix 2)
- Added two exported pure helpers: `parseTestPackages(raw?: string): string[]` (split/trim/filter-empty/dedupe-preserving-order) and `scopedCargoTestArgs(packages: string[]): string[]` (non-empty → `["cargo","test","-p",a,"-p",b,"--quiet"]`; empty → unchanged `["cargo","test","--quiet"]`).
- Added optional `opts.testPackages?: string[]` to `runBuildGate`'s options type (interface widening, safe). Precedence (AC-04): explicit `opts.testPackages` (even `[]`, which forces workspace-wide) wins over env; else `SUPER_DEV_BUILD_TEST_PACKAGES` is consulted; else workspace-wide.
- Scoping is applied only when `language === "rust"` AND the resolved packages array is non-empty, on a **shallow copy** of the detected commands — so `detectProjectCommands` stays byte-for-byte pure (its existing `expect(c.test).toEqual(["cargo","test","--quiet"])` regression test still passes) and go/python/mixed/greenfield stacks are unaffected. argv is always a `string[]` handed to `spawnSync` with no `shell:true`, so package names are never shell-interpolated.

### Phase 3 — Documentation + contract tests
- New README "Configuration" section documenting both env vars with Rust-workspace examples; JSDoc at the resolution site.
- Added 3 focused test files asserting on argv construction / pure-resolver outputs (no real cargo spawned): `resolveTimeoutMs` fallback matrix, `parseTestPackages`, `scopedCargoTestArgs`, explicit-vs-env precedence, non-rust non-regression, shell-safety, and the unchanged-detector regression guard.

## Files changed (vs main)
- `src/build-runner.ts` — core fix (+150/-4): new exports + scoping/timeout resolution.
- `tests/build-runner-timeout.test.ts` (new, 19 tests) — AC-01/AC-02/AC-05.
- `tests/build-runner-packages.test.ts` (new, 28 tests) — AC-03/AC-04/AC-06 + SCENARIO-006..011/014.
- `tests/build-runner-docs.test.ts` (new, 16 tests) — README/JSDoc + call-site-non-mutation contract (AC-05/AC-10/SCENARIO-012).
- `README.md` — new Configuration section (AC-10/SCENARIO-017).
- `docs/specifications/02-build-gate-timeout-package-scoping/` — requirements, BDD scenarios, research, debug analysis, code assessment, spec, plan, task list, review (workflow artifacts).

## Test results — ALL GREEN
- `vitest run` on the 3 new test files: **63/63 passed** (1.45s, hermetic).
- `tsc --noEmit` (strict): **exit 0**, zero type errors.
- `git diff main -- package.json`: **empty** — no new runtime dependencies.
- All 3 stage call sites confirmed unchanged (SCENARIO-012).

## Deviations from spec
None **blocking** — Code Review verdict **Approved** (see `12-code-review.md`). All acceptance criteria AC-01..AC-10 and scenarios SCENARIO-001..017 are satisfied exactly as specified. `detectProjectCommands` purity preserved (key invariant). Three out-of-scope / informational follow-ups are recorded as DEV-01..DEV-03 in `06-specification.md` (Post-Implementation Deviations): (1) AbortSignal not threaded into `spawnSync` — pre-existing, amplified by the higher 10-min default; the constraints forbade touching the control-flow engine so this was intentionally left for a follow-up; (2) two dedupe paths (`dedupePreservingOrder` vs inline in `parseTestPackages`) — DRY observation, behaviorally equivalent and verified by tests; (3) generic non-rust scoping (npm/pnpm/go) intentionally deferred per the spec's surgical-fix recommendation — the env-var + `opts.testPackages` plumbing is generic enough to extend later without an API change.

## Phases

- **Phases Completed**: 3/3
- **All Green**: true
- **Code Review**: Approved (Stage 12, no blockers)
- **Docs**: Updated in Stage 11 (DOCS_COMPLETE)

## Files Modified

- src/build-runner.ts
- tests/build-runner-timeout.test.ts
- tests/build-runner-packages.test.ts
- tests/build-runner-docs.test.ts
- README.md
