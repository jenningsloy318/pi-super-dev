# Implementation Plan: Scope-aware Cargo Build Gate: Untracked Inclusion, Defense-in-Depth Validation, and Spec-Declared Gate Contract

- **Date**: 2026-07-20

---

## Phase 1: P1-resolver-validation

Layer C defense-in-depth: harden resolveCargoPackageNames to DROP unresolved dirs (remove both identity fallbacks) and return [] on metadata failure, plus add a validatePackageNames helper reusing the cached metadata and wire it into runBuildGate so every candidate name is re-checked before any -p flag is built. Independently testable: resolveCargoPackageNames returns [] on metadata failure, drops unknown dirs; the validator drops invalid names and widens to workspace-wide on empty surviving set. AC-02, AC-03; SCENARIO-004..008, 034..036.
## Phase 2: P2-untracked-union

Layer B touched-surface union: extend detectTouchedCargoPackages to concatenate a second git spawn (`git -C <cwd> ls-files --others --exclude-standard`) with the existing `--merge-base` stdout before extracting crates/<seg>/ segments, with either command failing contributing nothing. Independently testable: an untracked-only change under crates/workflows/ still yields the workflows crate. PARALLELIZABLE with P1 (no shared dependency). AC-01; SCENARIO-001..003, 037, 038.
## Phase 3: P3-gate-contract

Layer D spec-declared gate contract: add optional `gate` to SpecificationData (schemas.ts) and RunOptions (types.ts), instruct the specification prompt to declare it for backend/integration features, thread `state.spec?.gate` through the three stage call sites, and implement the new top precedence tier (gate.workspace short-circuit → validated gate.packages → env → auto-detect → workspace-wide) plus appended integration targets. DEPENDS ON P1 (validator reuse). Independently testable: a RunOptions.gate value drives scope, validates names, and appends integration. AC-04..08; SCENARIO-009..021.
## Phase 4: P4-tests-and-e2e

Layer E test suite correction plus end-to-end: rewrite tests/build-runner-autospace.test.ts to a prefixed-workspace fixture, flip existing assertions from -p data to -p stockfan-*, add untracked-file/drop-unresolved/spec-gate-contract/precedence cases, and add the end-to-end stockfan-shape test. DEPENDS ON P1, P2, P3. Independently testable: vitest green with corrected + new assertions. AC-09, AC-10; SCENARIO-022..026.
## Phase 5: P5-regression-gates

Regression and quality gates: run npm run typecheck (strict-clean) and npm test (all green), verify non-cargo / non-git / no-gate-contract output is byte-identical to today with the DEFAULT strategy staying auto-detect (not switched to workspace-wide), confirm partitionErrorsByScope/isGreenForScope still work, and confirm the theme method-binding test stays green with no touches to nodes.ts/workflow.ts/pipeline.ts/render templates/control-flow. DEPENDS ON all prior phases. Independently testable: typecheck + full suite green + regression checklist satisfied. AC-11, AC-12; SCENARIO-027..033.
