# Implementation Summary: Cargo Build-Gate Validation — scope-aware gate hardening (08-cargo-build-gate-validation)

- **Date**: 2026-07-20
- **Status**: BLOCKED / NOT GREEN (code review round 13 = `13-code-review.md` verdict: Blocked; `npm test` is RED)
- **Review verdict**: Blocked — 8 findings (CR-001..CR-008), 2 Critical

---

## TL;DR

The four defect layers (B/C/D/E) were **substantively built** but the run **did not converge**: the full suite is RED (`npm test` → 21 failures across 6 files), the latest code review is **Blocked**, and three of the headline fixes are **inert or broken in production**:

- Layer C's `validatePackageNames` was wired to run over **all** precedence tiers (spec/env/opt/auto), which invalidates every existing test that asserts a bare package name without a matching `cargo metadata` member mock. Layer E was supposed to reconcile those tests but only **2** of the ~6 affected test files were edited.
- Layer D's spec prompt (`buildSpecPrompt` in `src/prompts.ts`) was **never updated**, so no real spec-writer run emits `gate` → `state.spec?.gate` is always `undefined` → the entire gate-contract precedence tier is dead wiring in production (the schema/type/threading are present but unreachable).
- Layer D's `gate.integration` targets are validated as **package names** (always dropped for paths like `crates/workflows/tests/e2e_x.rs`) and, when they survive, are appended to the `-p` list rather than emitted as `cargo test --test <stem>`. The motivating stockfan e2e is therefore **not** covered by Layer D.

Layer B (untracked union) and the Layer C **core** (drop-unresolved, metadata-fail→`[]`, never-throw degrade-to-workspace-wide) are correct and well-documented; `npm run typecheck` is strict-clean. The blocker is behavioral + test + prompt, not type-level.

## What the spec required (4 defect layers on `src/build-runner.ts`)

- **Layer B (P2)**: include UNTRACKED files by unioning `git ls-files --others --exclude-standard` with `git diff --merge-base` so mandated e2e crates aren't dropped. → **AC-01**
- **Layer C (P1)**: defense-in-depth — DROP unresolved dirs and return `[]` on metadata failure (removing the two identity fallbacks that produced the invalid `-p data` crash), plus a final `validatePackageNames()` re-check before any `-p` flag. → **AC-02, AC-03**
- **Layer D (P3)**: optional spec-declared `gate` contract threaded `SpecificationData` → `RunOptions` → `runBuildGate` as a new top precedence tier. → **AC-04..08**
- **Layer E (P4)**: correct the test suite that still encoded the dir==name bug; + P5 regression/typecheck gates. → **AC-09, AC-10, AC-11, AC-12**

## What was actually built (uncommitted, in worktree — `git status` vs `main`)

| File | Change | Layer | Status |
|---|---|---|---|
| `src/build-runner.ts` | +258/-~lines: `detectTouchedCargoPackages` untracked union (B); `resolveCargoPackageNames` hardened — whole-list + per-element identity fallbacks removed, metadata-fail→`[]`, try/catch→`[]` (C); new `validatePackageNames(cwd, names)` helper wired into `runBuildGate`; gate precedence tier + integration append (D runtime) | B,C,D | Built; **D integration path broken** (CR-004) |
| `src/render/schemas.ts` | +10: optional `gate: { packages?, workspace?, integration? }` added to `SpecificationData` | D | Built |
| `src/types.ts` | +6: `gate?` added to `RunOptions` | D | Built |
| `src/stages/implementation.ts` | thread `state.spec?.gate` → `RunOptions.gate` | D | Built (but upstream prompt emits nothing) |
| `src/stages/index.ts` | thread `state.spec?.gate` → `RunOptions.gate` | D | Built (but upstream prompt emits nothing) |
| `src/stages/verify.ts` | thread `state.spec?.gate` → `RunOptions.gate` | D | Built (but upstream prompt emits nothing) |
| `src/prompts.ts` `buildSpecPrompt` | **NOT edited** — no `gate` in "Data to return", no instruction | D | **MISSING (CR-003)** — Layer D dead in production |
| `tests/build-runner-resolver-validation.test.ts` | NEW, 27 tests — P1 unit surface for AC-02/AC-03 + validator wiring | E (P1 part) | Added; green in isolation |
| `tests/build-runner-package-wiring.test.ts` | MODIFIED — reconciled to validator wiring | E | Edited |
| `tests/build-runner-touched-crates.test.ts` | MODIFIED (partial) — but spawn-count assertion `toHaveLength(1)` still fails (CR-002) | E | Edited; still RED |
| `tests/build-runner-package-resolution.test.ts` | DELETED (517 lines) | E | Removed |
| `tests/build-runner-autoscope.test.ts` (note: real filename; spec/task text calls it `...-autospace...`) | **NOT modified** — still asserts `-p data`, single git spawn, `{ signal }`-only purity | E | **MISSING (CR-005)** — SCENARIO-006/007/008/017 still RED |
| `tests/build-runner-inscope-classification.test.ts`, `tests/build-runner-packages.test.ts`, `src/build-runner.test.ts` | **NOT modified** — still pass bare names with no metadata mock | E | **MISSING (CR-001)** — RED |

## Verification results

- **`npm run typecheck`** (tsc `--noEmit`, strict): **PASS** (strict-clean). No `any`, no unchecked access; the optional `gate` field and helpers type-check.
- **`npm test`** (vitest run): **RED.** Latest measured: `6 failed | 41 passed (47)` files, **`21 failed | 837 passed (858)` tests** (~14s). Failures cluster in: `build-runner-resolver-validation.test.ts`, `build-runner-touched-crates.test.ts`, `build-runner-autospace.test.ts`* (→ `autoscope`), `build-runner-inscope-classification.test.ts`, `build-runner-packages.test.ts`, `src/build-runner.test.ts`. Root cause is uniformly Layer C validator widening env/opt/auto candidate sets to `[]`→workspace-wide when the test's `cargo metadata` mock lacks the asserted member.

  \* SCENARIO reviewer SR-01: the spec/task text names `build-runner-autospace.test.ts`; the **real** file on disk is `build-runner-autoscope.test.ts`.

## Phases

- **Phases Completed**: 0/5 formally (no phase reached a green acceptance gate). P1 Layer-C core is built + unit-green-in-isolation (27/27) but regresses the broader suite; P2 built but broke the spawn-count contract; P3 schema/type/threading built but the prompt is un-wired and integration is broken; P4 largely un-done; P5 fails (suite RED).
- **All Green**: **false** (typecheck green; tests RED).

## Deviations from spec (documented for reviewers / next run)

1. **Layer D is dead wiring in production (CR-003, AC-04 partial).** The specification prompt `buildSpecPrompt` (`src/prompts.ts`) was never updated to instruct declaring `gate` or to list it under "Data to return". As shipped, `state.spec?.gate` is always `undefined`, so the three call-site threads carry nothing and the headline gate-contract precedence tier never fires from a real run. Schema/type/threading are present but unreachable. **Required to unblock**: add `gate` to the prompt's data-to-return list + a one-line instruction for Rust/backend features.
2. **Layer D `gate.integration` is non-functional (CR-004, AC-04/AC-06).** In `runBuildGate`, `gate.integration` is validated via `validatePackageNames` against the workspace member-NAME set, but integration targets are file paths (`crates/workflows/tests/e2e_x.rs`) → always dropped. Even if they survived they are appended to the `-p` list rather than emitted as `cargo test --test <stem>` with a filesystem-stat validation. The motivating stockfan e2e is **not** covered by Layer D. **Required to unblock**: derive stem (basename minus `.rs`, or token-with-separator) → emit `cargo test --test <stem>` validated by `stat(<memberDir>/tests/<stem>.rs)`.
3. **Layer E largely un-done (CR-005, AC-09/AC-05).** Only `build-runner-package-wiring.test.ts` was edited and `build-runner-resolver-validation.test.ts` added. The file the spec explicitly names (`tests/build-runner-autospace.test.ts`, real name `...-autoscope...`) plus `src/build-runner.test.ts`, `inscope-classification`, `packages` were left encoding the old contract → RED.
4. **Layer B broke the spawn-count contract (CR-002).** The untracked union correctly adds a second git spawn, but `tests/build-runner-touched-crates.test.ts:258` and `build-runner-autospace.test.ts` SCENARIO-006 assert exactly ONE git spawn → fail. The union behavior is correct; the assertions are stale.
5. **No runBuildGate-level gate-contract test (CR-006, AC-05).** Zero test files pass `gate:{...}` to `runBuildGate`. The workspace short-circuit, spec>env>auto precedence, and integration append are untested at the integration level; combined with CR-003/CR-004, regressions in the gate branch would be invisible.
6. **Explicit env/opt overrides silently discarded when metadata unavailable (CR-007).** When `cargo metadata` fails, `validatePackageNames` returns `[]` and the validator pass widens an operator's explicit `opts.testPackages` / `SUPER_DEV_BUILD_TEST_PACKAGES` override to workspace-wide — a behavior change for the env/opt tiers (previously honored verbatim; cargo would surface an invalid name itself). `runBuildGate` has no log sink, so the drop is invisible. Spec endorsed "drop unknowns" but also required a single log line.
7. **`gate.workspace===true` short-circuit is fragile (CR-008).** A later `dedupe([...testPackages, ...gateIntegration])` can re-populate `testPackages` after the workspace short-circuit set it to `[]`, turning a workspace-wide decision into a scoped `-p <integration>` gate — contradicting "workspace ignores packages". Latent today only because integration targets are always dropped (CR-004).
8. **Spec review grounding findings (carried, from `09-spec-review.md`):** SR-01 spec Architecture references non-existent `build-runner-autospace.test.ts` (real file: `autoscope`); SR-02 references helpers `partitionErrorsByScope`/`isGreenForScope` that do **not** exist in `src/` or `tests/`; SR-03 under-enumerated Layer E test-correction scope (~6 sibling files, not 1); SR-04 multi-package `memberDir` stat for integration targets is ambiguous.

## Files Modified (verified via `git status` vs `main`)

- src/build-runner.ts
- src/render/schemas.ts
- src/stages/implementation.ts
- src/stages/index.ts
- src/stages/verify.ts
- src/types.ts
- tests/build-runner-package-wiring.test.ts
- tests/build-runner-touched-crates.test.ts
- tests/build-runner-resolver-validation.test.ts (new)
- tests/build-runner-package-resolution.test.ts (deleted)

**Not yet committed** — all changes are uncommitted in the worktree (no `spec-08-*` commits exist; `main..HEAD` is empty; the worktree sits on the spec-07 merge `8b8f677b`). A `commit-work` stage is still required, but **only after** the suite is green.

## Bottom line

Layer C resolver hardening + validator + 27-test unit suite and Layer B untracked union are built and the core logic is correct. BUT the run is frozen RED: Layer D is dead wiring (prompt un-wired, integration broken), Layer E test corrections landed on only 2 of ~6 affected files, the suite shows **21 failures / 6 files**, and code review round 13 is **Blocked**. To merge: wire `buildSpecPrompt` (CR-003), fix the integration stem/`--test` path (CR-004), complete Layer E across all affected test files incl. the `autospace`→`autoscope` file (CR-001/CR-002/CR-005/CR-006), surface dropped-name logging (CR-007), and re-assert the workspace short-circuit after the integration union (CR-008). Then re-run `npm test` to green and re-commit with the code.
