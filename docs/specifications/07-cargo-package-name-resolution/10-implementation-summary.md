# Implementation Summary: Resolve real cargo package names in the scope-aware build gate (spec-07)

- **Date**: 2026-07-20

---

## Summary

**Problem:** The scope-aware cargo build gate in `src/build-runner.ts` derived `-p` flags from workspace DIRECTORY names (e.g. `crates/data/` → `data`) instead of real package names (e.g. `stockfan-data`). On any prefixed-crate workspace, `cargo build -p data` fails instantly with `package ID specification 'data' did not match any packages` (exit 101), false-failing every gate attempt before anything compiled — a repair loop can never fix a framework-derived command. Fix 3: the agent self-verification prompts also allowed `--lib`-only evidence, a vacuous-green vector.

**What was built, by phase:**

- **Phase 1 — Metadata resolver + per-cwd cache** (`src/build-runner.ts`): Added exported `resolveCargoPackageNames(cwd, touchedDirs)` plus private `loadCargoMetadata(cwd)` and a module-level `cargoMetadataCache: Map<cwd, CargoMetadataResult>`. The loader spawns `cargo metadata --format-version 1 --no-deps --manifest-path <cwd>/Cargo.toml` via discrete-argv `spawnSync` (no `shell:true`) under the existing `resolveTimeoutMs()` envelope, parses `packages[]` into `{name, manifestDir}`, and memoizes per-cwd (storing either the list or a `{ok:false}` failure sentinel so a missing cargo is not re-spawned). `resolveCargoPackageNames` maps each touched segment to the package whose first `crates/<seg>/` segment in `manifestDir` equals it (manifest-in-subdir safe), dedupes first-seen-order, and per-element / whole-list identity-falls-back to directory names on any failure — the whole body never throws, documented in JSDoc.

- **Phase 2 — Wire resolver into `detectTouchedCargoPackages` + complete touched set**: The existing `git diff` discrete-argv spawn, `/(?:^|\/)crates\/([^/]+)\//` regex, and `dedupePreservingOrder` are byte-identical; the deduped dir segments now pass through `resolveCargoPackageNames(cwd, dirs)` as the FINAL mapping step before return. Because the resolver is identity for dir==name and identity-on-failure, non-cargo/non-git/dir==name paths are byte-identical. The regex already captures `workflows` for `crates/workflows/tests/e2e_*.rs`, so the e2e crate is not dropped. Real names flow unchanged through every `runBuildGate` precedence tier and the unchanged `scopedCargo*` builders → `cargo build -p stockfan-data -p stockfan-tools -p stockfan-workflows --quiet`.

- **Phase 3 — Agent self-verification prompt discipline** (`src/prompts.ts`, parallelizable with 1–2): Added a `RUST_SELF_VERIFY_DISCIPLINE` constant appended to both `buildImplementPrompt` and `buildQaPrompt` instruction arrays — requires `cargo test -p <pkg>` WITHOUT `--lib` (so `tests/` integration binaries run) plus spec-mandated e2e/integration, and explicitly forbids declaring green on `--lib`-only evidence. Prompt-text only; `src/stages/implementation.ts`/`verify.ts`, `nodes.ts`/`workflow.ts`/`pipeline.ts`, and the render/theme layer are untouched.

- **Phase 4 — Regression suite, backward-compat & gate verification**: Ran the full existing build-runner suite unchanged and confirmed dir==name workspaces, non-cargo repos (go/python/node/mixed), and non-git dirs are byte-identical (the metadata tier runs only when `language==='rust'` and a non-empty scope resolves), and that `classifyOutOfScopeErrors` now partitions against REAL names.

**Files changed:**
- MODIFIED: `src/build-runner.ts` (resolver + cache + wiring), `src/prompts.ts` (rust self-verify discipline), `src/build-runner.test.ts` (cache-reset hook for hermetic tests).
- NEW: `tests/build-runner-package-resolution.test.ts` (AC-06 hermetic dir→name / failure-fallback / cache-hit / e2e `-p` tests with `spawnSync` mocked), `tests/build-runner-package-wiring.test.ts`, `tests/build-runner-backward-compat-regression.test.ts`, `tests/prompts-cargo-verify-discipline.test.ts`.

**Test results:** `npm test` → 47 files / 861 tests passed (0 failures), including the theme-method-binding guardrail (`stream-theme-class-theme`). `npm run typecheck` strict-clean. No new runtime dependencies; the only new spawned process is the cached `cargo metadata --no-deps`.

**Deviations from spec:** Minor — the plan specified a single new test file (`build-runner-package-resolution.test.ts`) but four granular test files were created (package-resolution, package-wiring, backward-compat-regression, prompts-cargo-verify-discipline). This strictly exceeds the spec's AC-06 coverage rather than reducing it; all AC-01 through AC-10 are satisfied. No code/control-flow/theme changes beyond the two specified source files.

## Phases

- **Phases Completed**: 4/4
- **All Green**: true

## Files Modified

- src/build-runner.ts
- src/prompts.ts
- src/build-runner.test.ts
- tests/build-runner-package-resolution.test.ts
- tests/build-runner-package-wiring.test.ts
- tests/build-runner-backward-compat-regression.test.ts
- tests/prompts-cargo-verify-discipline.test.ts

---

## Code-Review Fix Round (round 2)

Addressed the review findings on the round-1 implementation. All changes are
minimal and targeted; the full suite stays green (47 files / 862 tests, +1 new
regression test) and `npm run typecheck` is strict-clean.

- **[High] False-green regression in `classifyOutOfScopeErrors`**: after the
  resolver wired REAL cargo names into `testPackages`, a cargo BUILD/CLIPPY
  error block that references the crate via its SOURCE PATH (`crates/data/…`)
  — which cargo does NOT always pair with a rerun `-p <realname>` flag — had its
  DIRECTORY segment (`data`) mismatch the real-name scope (`stockfan-data`) and
  was misclassified out-of-scope → `inScopePass=true` → false green. Added a
  pure `classificationScope(cwd, realNames)` helper that augments the scope with
  each in-scope crate's directory segment (via cached metadata), so BOTH marker
  forms (path segment and rerun flag) match an in-scope crate and neither
  matches an out-of-scope one. Wired into `runBuildGate` only for
  `language==='rust' && non-empty scope`, so non-rust/workspace-wide gates are
  byte-identical. New regression test locks it in.
- **[medium] Multi-crate-per-top-segment matching ambiguity**: `find(...)` was
  order-dependent on `cargo metadata`'s package order. Replaced with
  `matchPackageBySegment()`, which is deterministic and prefers an EXACT crate
  root (`crates/<seg>`) over a nested one (`crates/<seg>/inner`) when several
  members share a top segment.
- **[Low] Metadata spawn inherited the 10-min build timeout**: a hung/missing
  cargo blocked up to 10 minutes before the identity fallback. Added a dedicated
  `cargoMetadataTimeoutMs()` (30s default, `SUPER_DEV_CARGO_METADATA_TIMEOUT_MS`
  override) — a metadata lookup is a cheap manifest-graph read, not a build.
- **[Low] Cache-key / `--manifest-path` skew**: the cache was keyed by
  `resolve(cwd)` while cargo opened `join(cwd,"Cargo.toml")`; relative/symlinked
  `cwd` could cause a duplicate spawn. Now resolves `cwd` ONCE and uses the same
  absolute path for both the key and the argv.
- **[Low] Duplicated `crates/` regex**: `detectTouchedCargoPackages` had an
  inline copy of the module-level `CRATE_SEGMENT_RE`. Now reuses it.
- **[Low] Duplicated fallback dedupe**: the two identity-fallback branches in
  `resolveCargoPackageNames` each repeated the string-filter + dedupe; coalesced
  into a single `strDirs` source of truth.
- **[Low] Prompt discipline broadcast to ALL languages**: `RUST_SELF_VERIFY_
  DISCIPLINE` was appended unconditionally (scoped only by wording). Now
  hard-gated to the setup-detected language (`s.language==='rust'`) via a
  `rustDiscipline(s)` helper, so frontend/python/go prompts no longer carry
  cargo instructions. Updated the two tests that asserted the old broadcast.

**Not changed (accepted, documented design choices):** the process-local cache
keyed by absolute cwd (single pipeline run — `vi.resetModules()`/exit clears it,
so no staleness leaks across runs); the `--manifest-path` workspace-root
assumption (a non-root manifest fails gracefully → identity fallback, AC-08);
and the verbose JSDoc on private helpers (purely stylistic, [info]).
