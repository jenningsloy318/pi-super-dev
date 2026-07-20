# Behavior Scenarios: Cargo Package Name Resolution for Scope-Aware Build Gate

- **Date**: 2026-07-20
- **Author**: super-dev:bdd-scenario-writer
- **Source**: /home/jenningsl/development/personal/jenningsloy318/pi-super-dev/.worktree/07-cargo-package-name-resolution/docs/specifications/07-cargo-package-name-resolution/01-requirements.md
- **Total Scenarios**: 24

---
## Feature: Cargo Package Name Resolution

### SCENARIO-001: Resolver maps a touched crate directory to its real package name via workspace metadata

- **Acceptance Criteria**: AC-01
- **Priority**: high

**Given** a Rust workspace where the crate directory crates/data/ maps to the package stockfan-data according to its Cargo.toml manifest_path
**When** the package-name resolver is given the touched directory segment 'data' for that working directory
**Then** it returns the real package name 'stockfan-data' derived by comparing the touched crates/<dir>/ path against each workspace package's manifest parent directory
**And** the metadata is obtained from cargo metadata --format-version 1 --no-deps --manifest-path <cwd>/Cargo.toml via discrete argv spawnSync with no shell:true
**And** the returned names are deduped and in first-seen order
### SCENARIO-002: Resolver matches a package whose manifest lives in a subdirectory

- **Acceptance Criteria**: AC-01
- **Priority**: medium

**Given** a workspace package whose Cargo.toml resides in a subdirectory relative to its crate directory
**When** the resolver maps the corresponding touched directory to a package name
**Then** it matches using the directory that contains the package's Cargo.toml and returns the correct package name
### SCENARIO-003: Metadata failure degrades to the directory-name identity list instead of throwing

- **Acceptance Criteria**: AC-02
- **Priority**: high

**Given** cargo metadata fails to run for any reason (spawn error, non-zero exit, timeout, missing cargo, or malformed JSON)
**When** the resolver is invoked for that working directory
**Then** it returns the input touched directory names verbatim as an identity list
**And** the resolver never throws under any failure path
**And** the fallback behavior is documented in a JSDoc comment
**And** a simple dir==name workspace and a non-cargo dir degrade to today's behavior identically
### SCENARIO-004: A touched directory with no matching package falls back safely

- **Acceptance Criteria**: AC-02
- **Priority**: medium

**Given** a touched directory segment that has no corresponding package in the workspace metadata
**When** the resolver cannot find a matching package for that directory
**Then** it degrades to returning that directory's name without raising an error
## Feature: Per-Process Metadata Cache

### SCENARIO-005: A repeated resolver call for the same working directory reuses the cached metadata

- **Acceptance Criteria**: AC-03
- **Priority**: medium

**Given** the resolver has already run cargo metadata for a given working directory within the current process
**When** the resolver is invoked again for that same working directory
**Then** the cached metadata result is reused and cargo metadata is not spawned a second time
**And** a single gate run that calls the resolver multiple times spawns cargo metadata at most once per cwd
### SCENARIO-006: The cache is process-local and never persists across runs

- **Acceptance Criteria**: AC-03
- **Priority**: low

**Given** a previous run that populated the metadata cache
**When** a new run starts in a fresh process
**Then** the cache does not carry over and the metadata is re-resolved fresh to avoid stale results
## Feature: Scope-Aware Cargo Gate Uses Real Package Names

### SCENARIO-007: The touched-crate detector returns real package names for a prefixed-crate workspace

- **Acceptance Criteria**: AC-04
- **Priority**: high

**Given** a Rust workspace whose directories data/tools/workflows map to packages stockfan-data/stockfan-tools/stockfan-workflows and a git diff touching those crates
**When** detectTouchedCargoPackages runs its git diff --name-only collection, regex, and dedupe then maps the directory segments through the metadata resolver
**Then** it returns the real package names ['stockfan-data','stockfan-tools','stockfan-workflows'] producing cargo build/test/clippy -p stockfan-data -p stockfan-tools -p stockfan-workflows end-to-end via the unchanged scopedCargoArgs builders
**And** the existing git-diff spawn, regex (?:^|/)crates/([^/]+)/, and dedupe logic is preserved
**And** the metadata resolution is applied as the final mapping step only
### SCENARIO-008: Multiple files in the same crate produce one crate entry in first-seen order

- **Acceptance Criteria**: AC-04
- **Priority**: medium

**Given** several touched files all within the same crate directory across several crates
**When** the detector collects and resolves the touched crate set
**Then** each crate appears exactly once across the build/test/clippy args in first-seen order
### SCENARIO-009: A touched e2e test file in the workflows crate includes that crate in the scope

- **Acceptance Criteria**: AC-05
- **Priority**: high

**Given** a git diff touching crates/workflows/tests/e2e_*.rs in a workspace where workflows maps to stockfan-workflows
**When** the touched-set extraction resolves directory segments to package names
**Then** stockfan-workflows appears in the resolved scope
**And** spec-mandated integration/e2e tests in that touched crate run via cargo test -p stockfan-workflows
**And** no touched crate is dropped from the scope
## Feature: Agent Self-Verification Prompts

### SCENARIO-010: Implementation and verify prompts require full package tests, not lib-only

- **Acceptance Criteria**: AC-07
- **Priority**: high

**Given** the implementation and verify self-verification prompt builders
**When** an agent self-verifies a Rust package per the prompt text
**Then** the prompt requires cargo test -p <pkg> with no --lib flag plus any spec-mandated e2e/integration target
**And** the authoritative prompt text lives in src/prompts.ts used by src/stages/implementation.ts and src/stages/verify.ts
**And** the change is prompt-text only with no control-flow, nodes, workflow, or pipeline change
### SCENARIO-011: Lib-only verification evidence is not accepted as a green

- **Acceptance Criteria**: AC-07
- **Priority**: medium

**Given** an agent produces verification evidence limited to cargo test -p <pkg> --lib
**When** the agent attempts to declare success per the prompt
**Then** the prompt instructs that --lib-only evidence is insufficient
**And** the instruction explicitly states that --lib skips the tests/ integration binaries
## Feature: Backward Compatibility and Regression Safety

### SCENARIO-012: A dir-equals-name workspace is unchanged after the fix

- **Acceptance Criteria**: AC-08
- **Priority**: high

**Given** a Rust workspace where each crate directory name equals its package name
**When** the resolver maps directories to package names
**Then** it produces an identity no-op mapping with output byte-identical to today's behavior
**And** all existing scope-aware tests pass unchanged (touched-crates, autoscope, inscope-classification, scoped-args, packages, nonregression, timeout, docs)
### SCENARIO-013: Non-cargo and non-git repositories behave identically to before

- **Acceptance Criteria**: AC-08
- **Priority**: medium

**Given** a go, python, node, or mixed-language repository, or a non-git directory
**When** the build gate runs
**Then** the metadata tier does not execute and behavior is identical to today
**And** the metadata resolution tier runs only when the language is rust and a non-empty scope resolves, exactly as today
### SCENARIO-014: Strict typecheck and the full test suite pass with no new runtime dependencies

- **Acceptance Criteria**: AC-10
- **Priority**: high

**Given** the completed changes to build-runner and prompt builders plus the new tests
**When** npm run typecheck and npm test are executed
**Then** both pass with no new runtime dependencies added
**And** the only new spawned process is cargo metadata --no-deps, cached per cwd per run
**And** nodes.ts, workflow.ts, pipeline.ts, and the rendering layer remain untouched
## Feature: Theme Method-Binding Preservation

### SCENARIO-015: Any new rendering uses method-style theme calls and no new tokens

- **Acceptance Criteria**: AC-09
- **Priority**: medium

**Given** any new or modified rendering code in the touched files
**When** theme text styling is applied
**Then** it invokes the theme method-style as theme.fg(...) or via a wrapper const fg=(c,t)=>theme.fg(c,t) and never destructures theme.fg
**And** no new theme tokens are introduced
**And** tests/stream-theme-class-theme.test.ts still passes
## Feature: Hermetic Unit Test Coverage

### SCENARIO-016: Unit tests cover resolution, fallback, caching, and end-to-end args with stubbed spawnSync

- **Acceptance Criteria**: AC-06
- **Priority**: high

**Given** node:child_process.spawnSync is mocked for determinism
**When** the new unit test suite runs
**Then** it verifies dir-to-name resolution against stubbed cargo metadata JSON with prefixed names and a manifest-in-subdir package, the metadata-failure fallback to the dir-name identity list, the cache-hit single-spawn behavior across two resolver calls for the same cwd, and correct -p flags produced end-to-end through scopedCargoArgs for a dir-not-equal-name workspace
**And** the tests are hermetic and do not depend on a real cargo or a real repository
## Feature: Security - Argument Hygiene

### SCENARIO-017: Package names flow as discrete argv elements with no shell interpretation

- **Acceptance Criteria**: AC-01
- **Priority**: medium

**Given** package names derived from workspace metadata
**When** they are passed to cargo build/test/clippy commands
**Then** they flow as discrete argv elements through spawnSync with no shell:true
**And** no metadata-derived string ever reaches a shell, matching the existing spawn pattern in detectTouchedCargoPackages/runBuildGate
## Feature: Reliability - Never-Throw Gate

### SCENARIO-018: The gate itself never throws and preserves safe empty or workspace-wide semantics

- **Acceptance Criteria**: AC-02
- **Priority**: high

**Given** any failure path in the metadata resolver or the gate (spawn error, non-zero exit, timeout, missing cargo, malformed JSON, no matching package)
**When** the gate reaches that failure path
**Then** it degrades gracefully to the documented dir-name identity fallback preserving today's safe []/workspace-wide semantics
**And** a non-cargo or non-git repo behaves identically to before
### SCENARIO-019: The --lib prohibition does not change gate control flow

- **Acceptance Criteria**: AC-02
- **Priority**: low

**Given** the prompt-only Fix 3 changes
**When** the deterministic gate runs its out-of-scope classifier
**Then** control flow is unchanged and the classifier still never grants a false green
**And** the --lib prohibition removes the vacuous-green vector without weakening the gate
## Feature: Performance - Bounded Metadata Spawn

### SCENARIO-020: The single new spawned process is bounded by the existing timeout envelope and memoized per cwd

- **Acceptance Criteria**: AC-03
- **Priority**: medium

**Given** a gate run that resolves cargo package names
**When** the metadata spawn is invoked
**Then** cargo metadata --no-deps is bounded by the existing timeout envelope and memoized per cwd so the gate spawns it at most once
**And** the cache is process-local and never persisted across runs to avoid staleness
## Feature: Correctness - End-to-End Scope Flags

### SCENARIO-021: A prefixed-crate workspace produces correct -p flags through every scoped arg builder

- **Acceptance Criteria**: AC-04
- **Priority**: medium

**Given** a workspace where directories data/tools/workflows map to stockfan-data/stockfan-tools/stockfan-workflows
**When** scopedCargoArgs, scopedCargoBuildArgs, scopedCargoTestArgs, and scopedCargoClippyArgs consume the resolved package names
**Then** each builder emits -p stockfan-data -p stockfan-tools -p stockfan-workflows
**And** the arg builders themselves remain unchanged; only their input package names change
### SCENARIO-022: Deduplication is preserved across the resolution mapping

- **Acceptance Criteria**: AC-04
- **Priority**: low

**Given** multiple touched files resolving to the same package name
**When** the resolver maps and dedupes the directory set
**Then** each package appears exactly once in first-seen order in the resulting args
## Feature: Out-of-Scope Strategy Preservation

### SCENARIO-023: The touched-crate scoping strategy remains the default and is not switched to workspace-wide

- **Acceptance Criteria**: AC-08
- **Priority**: medium

**Given** the scope-aware build gate after the fixes
**When** the gate decides its scoping strategy
**Then** touched-crate scoping remains the default strategy and is not switched to workspace-wide
**And** the fixes only correct names and complete the touched set, not the scoping strategy
### SCENARIO-024: The rendering layer and theme tokens are untouched

- **Acceptance Criteria**: AC-09
- **Priority**: low

**Given** the completed changes confined to src/build-runner.ts and prompt text in src/prompts.ts plus new tests
**When** the change set is reviewed
**Then** nodes.ts, workflow.ts, pipeline.ts, and the rendering layer are untouched
**And** no new theme tokens are introduced
---

## Traceability

- **AC-01**: resolveCargoPackageNames(cwd, touchedDirs) maps each touched crates/<dir>/ segment to the workspace package whose manifest_path parent directory matches, returning real package names deduped and in first-seen order. → SCENARIO-001, SCENARIO-002, SCENARIO-017
- **AC-02**: Never-throw + fallback chain: on any failure the resolver returns the input touched directory names verbatim (identity); documented in JSDoc. → SCENARIO-003, SCENARIO-004, SCENARIO-018, SCENARIO-019
- **AC-03**: Per-cwd in-memory cache memoizes cargo metadata output so a gate run spawns it at most once per cwd; process-local, never persisted. → SCENARIO-005, SCENARIO-006, SCENARIO-020
- **AC-04**: detectTouchedCargoPackages keeps existing git diff + regex + dedupe and passes dirs through resolveCargoPackageNames as the final step, returning real package names. → SCENARIO-007, SCENARIO-008, SCENARIO-021, SCENARIO-022
- **AC-05**: A touched crates/workflows/tests/e2e_*.rs makes stockfan-workflows appear in the resolved scope; no touched crate is dropped. → SCENARIO-009
- **AC-06**: Hermetic unit tests (spawnSync mocked) covering resolution, fallback, cache hit, and end-to-end -p flags through scopedCargoArgs. → SCENARIO-016
- **AC-07**: Fix 3 prompt-only: implementation/verify prompts require cargo test -p <pkg> with no --lib flag plus spec-mandated e2e/integration; forbid --lib-only green. → SCENARIO-010, SCENARIO-011
- **AC-08**: No regression: all existing scope-aware tests pass unchanged; dir==name, non-cargo, non-git repos remain byte-identical; metadata tier runs only for rust with non-empty scope. → SCENARIO-012, SCENARIO-013, SCENARIO-023
- **AC-09**: Theme method-binding preserved: method-style theme.fg(...); never destructure; no new tokens; rendering layer untouched. → SCENARIO-015, SCENARIO-024
- **AC-10**: npm run typecheck passes (strict-clean) and npm test passes (existing + new) with no new runtime deps; only new spawned process is cargo metadata --no-deps cached per cwd. → SCENARIO-014

## Coverage Summary

- **Total Acceptance Criteria**: 10
- **Covered by Scenarios**: 10
- **Uncovered**: 0
- **Total Scenarios**: 24
