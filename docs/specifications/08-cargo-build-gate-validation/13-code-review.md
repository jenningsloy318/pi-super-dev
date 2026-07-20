# Code Review: Code Review — Scope-aware Cargo Build Gate (Layers B–E)

- **Date**: 2026-07-20
- **Author**: super-dev:code-reviewer
- **Verdict**: Blocked

---

## Verdict: Blocked

Reviewed the scope-aware build-gate fix against the 08-cargo-build-gate-validation spec. The CORE logic is sound and well-documented: Layer B (untracked union via `git ls-files --others --exclude-standard`) and Layer C (resolver DROPS unresolved dirs, returns [] on metadata failure, `validatePackageNames` re-checks every candidate, discrete-argv `spawnSync` with no shell, per-cwd metadata cache, never-throw degrade-to-workspace-wide) are implemented correctly, and `npm run typecheck` is strict-clean. HOWEVER the change is BLOCKED: the central verification claim is FALSE — `npm test` is RED with 46 failures across 8 files, so AC-07 ("npm test passes") is not met. Root cause: Layer C's validator now also runs over the `opts.testPackages` and `SUPER_DEV_BUILD_TEST_PACKAGES` tiers, which invalidates every existing test that asserts a bare package name (`api`/`data`/`store`) without a matching `cargo metadata` member mock; Layer E was supposed to correct those tests but only ONE file (`build-runner-package-wiring.test.ts`) was edited and one new file added — the file the spec explicitly named (`tests/build-runner-autospace.test.ts`) plus `src/build-runner.test.ts`, `inscope-classification`, `packages`, and `touched-crates` were left encoding the old contract. Two Layer D runtime paths are also inert: (1) the specification prompt `buildSpecPrompt` was never updated to instruct declaring `gate` or list it under "Data to return", so `state.spec?.gate` is always undefined in production — the entire gate-contract precedence tier is dead wiring; (2) `gate.integration` targets are validated as PACKAGE NAMES (so a path like `crates/workflows/tests/e2e_x.rs` is always dropped) and, even if they survived, are appended to the `-p` list rather than emitted as `cargo test --test <stem>` as the spec requires — the motivating stockfan e2e is therefore not covered. No runBuildGate-level test passes `gate:` at all (AC-05). Until the suite is green, the prompt instructs `gate`, integration emits `--test <stem>`, and Layer E corrections land on all affected files, this cannot merge.

## Findings

### CR-001: Test suite is RED — AC-07 false; the stated verification ('npm test all green') did not pass

- **Severity**: Critical
- **File**: `src/build-runner.ts`
- **Line**: runBuildGate validator pass
`npm test` fails with 46 failures across 8 test files. Root cause: the Layer C validator now also runs over the `opts.testPackages` and `SUPER_DEV_BUILD_TEST_PACKAGES` tiers (the trailing `if (language==='rust' && testPackages.length>0) testPackages = validatePackageNames(...)` in runBuildGate). Every existing test that passes a bare package name (`api`, `data`, `store`, `crates/core`) without a `cargo metadata` mock that includes that exact member now resolves to [] and produces workspace-wide argvs instead of `-p <name>`, so SCENARIO-006/007/008/017 and the inscope/packages tests fail. Layer E was supposed to correct these but only `tests/build-runner-package-wiring.test.ts` was edited. Fix: give every affected test a metadata fixture that lists the asserted member (or assert workspace-wide where intended), then re-run to green. typecheck is clean; only the behavioral+test layer is broken.
### CR-002: Layer B broke the spawn-count contract asserted by existing tests

- **Severity**: Critical
- **File**: `src/build-runner.ts`
- **Line**: detectTouchedCargoPackages
Layer B correctly adds a second git spawn (`git ls-files --others --exclude-standard`) inside `detectTouchedCargoPackages`, but `tests/build-runner-touched-crates.test.ts:258` asserts `spawn.mock.calls.toHaveLength(1)` and `tests/build-runner-autospace.test.ts` SCENARIO-006 asserts 'exactly ONE git-diff spawn'. Both now see 2 spawns and fail. Fix: update those assertions to expect two git spawns (diff + untracked union) and re-state the union contract.
### CR-003: Spec prompt buildSpecPrompt was NOT updated — Layer D is dead wiring in production (AC-04 partial)

- **Severity**: High
- **File**: `src/prompts.ts`
- **Line**: 79
AC-04 requires the specification prompt to instruct agents to declare `gate` for backend/integration features. `buildSpecPrompt` (prompts.ts:79) still lists only title/date/summary/architecture/testingStrategy/scenarioRefs/phases/tasks under '## Data to return' and has no `gate` instruction. Consequently a real spec-writer run never emits `gate`, so `state.spec?.gate` is always undefined, the three call-site threads (`implementation.ts`, `verify.ts`, `index.ts`) carry nothing, and the gate-contract precedence tier — the headline Layer D fix — never fires in production. The schema/type/threading were added but are unreachable without the prompt. Fix: add `gate` to the data-to-return list plus a one-line instruction to declare it (cargo packages whose tests must pass, workspace-wide flag, e2e/integration target path) for Rust/backend features.
### CR-004: gate.integration is non-functional: targets validated as package names and appended to -p, never emitted as `cargo test --test <stem>` (AC-04/AC-06)

- **Severity**: High
- **File**: `src/build-runner.ts`
- **Line**: runBuildGate gateIntegration
In runBuildGate, `gateIntegration = validatePackageNames(cwd, gate.integration)` validates integration targets against the workspace member-NAME set. Integration targets are file paths (e.g. `crates/workflows/tests/e2e_x.rs`), which are never member names → always dropped → `gateIntegration=[]`, so the e2e never runs. Even if a target survived, it is appended to the `-p` package list (dedupe union), but the spec requires deriving a stem (basename minus `.rs`, or token-with-separator) and emitting an additional `cargo test --test <stem>` invocation validated by a filesystem stat of `<memberDir>/tests/<stem>.rs`. Neither the stem-derivation nor the `--test` path exists. The motivating stockfan e2e case is therefore not covered by Layer D. Fix: implement stem derivation → `cargo test --test <stem>` with stat-based validation.
### CR-005: Layer E largely un-done: tests/build-runner-autospace.test.ts still encodes the original dir==name bug

- **Severity**: High
- **File**: `tests/build-runner-autospace.test.ts`
- **Line**: 124
AC-09/AC-05 and Layer E explicitly name `tests/build-runner-autospace.test.ts` for correction (flip `-p data`→`-p stockfan-*`, add untracked-file/drop-unresolved/gate-contract/precedence cases). git status shows that file was NOT modified; only `build-runner-package-wiring.test.ts` was edited and `build-runner-resolver-validation.test.ts` added. The autospace file's SCENARIO-006/007/008/017 assertions still expect `-p data`, single git spawn, and `{ signal }`-only purity, and now fail. Fix: apply the documented Layer E corrections to this file (and the duplicated `src/build-runner.test.ts`).
### CR-006: No runBuildGate-level test for the gate contract (AC-05 not met)

- **Severity**: Medium
- **File**: `tests/build-runner-resolver-validation.test.ts`
- **Line**: 531
Grep across all test files finds zero calls passing `gate:{...}` to `runBuildGate`. The `gate.workspace===true` short-circuit, the spec>env>auto precedence, and integration appending are untested at the integration level; only `validatePackageNames` is unit-tested in isolation. Since the gate runtime branch is both untested and (per CR-003/CR-004) unreachable from a real run, regressions here would be invisible. Fix: add a gate-contract test driving `runBuildGate` through each precedence tier plus the workspace short-circuit and an integration target.
### CR-007: Explicit opt/env overrides silently discarded when metadata unavailable; dropped names never logged

- **Severity**: Medium
- **File**: `src/build-runner.ts`
- **Line**: runBuildGate validator pass
When `cargo metadata` fails on a rust repo, `validatePackageNames` returns [] and the trailing validator pass widens an operator's explicit `opts.testPackages` / `SUPER_DEV_BUILD_TEST_PACKAGES` override to workspace-wide. Previously that explicit override was honored verbatim (cargo would surface an invalid name itself). This is a behavior change for the env/opt tiers that the spec endorsed ('drop unknowns') but also required 'dropping unknowns with a single log line' — runBuildGate has no log sink and emits nothing, so the drop is invisible. Fix: either honor explicit user intent when metadata is unavailable, or surface dropped names via the returned result/a log callback, and document the change.
### CR-008: gate.workspace short-circuit can be resurrected by the integration append

- **Severity**: Low
- **File**: `src/build-runner.ts`
- **Line**: runBuildGate integration union
`gate.workspace===true` sets testPackages=[], but the later `dedupe([...testPackages, ...gateIntegration])` re-populates it; a surviving integration target would then turn a workspace-wide decision into a scoped `-p <integration>` gate, contradicting 'workspace ignores packages'. Latent today only because integration targets are always dropped (CR-004), but the ordering is fragile. Fix: re-assert `gate.workspace===true` after the union, or compute integration as separate test invocations independent of the `-p` set.
