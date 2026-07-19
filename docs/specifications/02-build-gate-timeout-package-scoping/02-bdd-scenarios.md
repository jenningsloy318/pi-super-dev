# Behavior Scenarios: Build-gate: configurable timeout + per-package test scoping

- **Date**: 2025-11-20
- **Author**: super-dev:bdd-scenario-writer
- **Source**: /home/jenningsl/development/personal/jenningsloy318/pi-super-dev/.worktree/02-build-gate-timeout-package-scoping/docs/specifications/02-build-gate-timeout-package-scoping/01-requirements.md
- **Total Scenarios**: 17

---
## Feature: Build-gate timeout configuration

### SCENARIO-001: Valid timeout env var is honored

- **Acceptance Criteria**: AC-01
- **Priority**: high

**Given** the operator has set SUPER_DEV_BUILD_TIMEOUT_MS to a valid positive integer
**When** the build gate runs the build, test, and typecheck commands of a slow-compiling workspace
**Then** each command is allowed that many milliseconds before timing out via spawnSync
**And** the resolved value threads into the timeout option of every spawned command
### SCENARIO-002: Malformed or invalid timeout values fall back to the default

- **Acceptance Criteria**: AC-01
- **Priority**: high

**Given** SUPER_DEV_BUILD_TIMEOUT_MS is unset, empty, non-numeric, NaN, zero, or negative
**When** the build gate resolves the timeout
**Then** the timeout falls back to the 600_000ms default without raising an error
### SCENARIO-003: Default timeout ceiling is raised to ten minutes

- **Acceptance Criteria**: AC-02
- **Priority**: high

**Given** SUPER_DEV_BUILD_TIMEOUT_MS is unset and no explicit timeout option is provided
**When** the build gate resolves the timeout
**Then** the default ceiling is 600_000ms rather than the legacy 120_000ms
### SCENARIO-004: Explicit timeout option overrides env var and default

- **Acceptance Criteria**: AC-02
- **Priority**: medium

**Given** runBuildGate is invoked with an explicit opts.timeoutMs
**When** the build gate resolves the timeout
**Then** the explicit value takes precedence over both the env var and the default
**And** preserving unit-testability with short timeouts
### SCENARIO-005: Slow workspace no longer false-fails on compile time

- **Acceptance Criteria**: AC-01
- **Priority**: high

**Given** a Rust workspace whose clean cargo build exceeds two minutes
**When** the build gate runs with the raised default timeout
**Then** the commands complete within the budget instead of being aborted by ETIMEDOUT
**And** Stage 9 is no longer falsely aborted by a harness timeout on legitimate code
## Feature: Per-package test scoping

### SCENARIO-006: Package env var scopes cargo test to listed crates

- **Acceptance Criteria**: AC-03
- **Priority**: high

**Given** a Rust workspace with SUPER_DEV_BUILD_TEST_PACKAGES set to a comma-separated list of crate names
**When** the build gate constructs the test command
**Then** the command scopes the test run to each listed package with one -p flag per package
**And** the --quiet flag is retained
**And** pre-existing unscoped DB-integration tests are excluded so the gate can reach green
### SCENARIO-007: Package env var is parsed defensively

- **Acceptance Criteria**: AC-03
- **Priority**: medium

**Given** SUPER_DEV_BUILD_TEST_PACKAGES contains whitespace, duplicate entries, or trailing commas
**When** the build gate parses the package list
**Then** entries are trimmed, empties filtered out, and duplicates collapsed before command construction
### SCENARIO-008: Explicit testPackages parameter overrides the env var

- **Acceptance Criteria**: AC-04
- **Priority**: high

**Given** runBuildGate is invoked with an opts.testPackages array
**When** the build gate resolves the test scope for a Rust workspace
**Then** the parameter value is used for scoping regardless of the SUPER_DEV_BUILD_TEST_PACKAGES env var
### SCENARIO-009: Absent scope falls back to current workspace-wide behavior

- **Acceptance Criteria**: AC-03
- **Priority**: medium

**Given** neither opts.testPackages nor SUPER_DEV_BUILD_TEST_PACKAGES is provided
**When** the build gate runs in a Rust workspace
**Then** the test command remains the unchanged workspace-wide cargo test --quiet
## Feature: Backward compatibility and non-regression

### SCENARIO-010: Non-Rust repositories are unaffected by package scoping

- **Acceptance Criteria**: AC-06
- **Priority**: high

**Given** a non-Rust repository such as go, python, node, or a mixed stack
**When** SUPER_DEV_BUILD_TEST_PACKAGES is set
**Then** the detected build, test, and typecheck commands are identical to the current behavior
**And** no -p scoping is applied to non-Rust stacks
### SCENARIO-011: Greenfield repo with no manifest still passes

- **Acceptance Criteria**: AC-06
- **Priority**: medium

**Given** a repository with no build manifest
**When** the build gate runs
**Then** it reports a pass with an empty list of executed commands
### SCENARIO-012: Existing stage call sites require no changes

- **Acceptance Criteria**: AC-05
- **Priority**: high

**Given** the three existing stage call sites invoke runBuildGate passing only their abort signal
**When** the build gate runs after the fix
**Then** the stages inherit the new default timeout and env-driven scoping without code changes
**And** their existing call signatures remain unchanged
### SCENARIO-013: The target repository is never mutated

- **Acceptance Criteria**: AC-09
- **Priority**: high

**Given** the build gate is running against a workspace under test
**When** the gate scopes the test command or applies the timeout
**Then** no files in the target repository are modified, ignored, or quarantined
**And** no #[ignore] attributes are inserted
**And** no tests are auto-quarantined
### SCENARIO-014: Package names are never passed through a shell

- **Acceptance Criteria**: AC-04
- **Priority**: medium

**Given** package names originating from the env var or parameter
**When** the build gate constructs the command
**Then** the argv is built as a string array passed directly to spawnSync with no shell interpolation
## Feature: Quality gate and documentation

### SCENARIO-015: Focused unit tests cover the new behavior

- **Acceptance Criteria**: AC-07
- **Priority**: medium

**Given** the test suite is executed
**When** the new build-runner tests run
**Then** they assert the timeout env-parsing fallback, the -p scoping command construction, and parameter-overrides-env
**And** tests are deterministic and avoid invoking real cargo by asserting on argv construction
### SCENARIO-016: Typecheck and test suites pass with no new dependencies

- **Acceptance Criteria**: AC-08
- **Priority**: high

**Given** the project's typecheck and test commands are run under strict mode
**When** the change is applied
**Then** both pass cleanly with zero errors
**And** no new runtime dependencies are added to package.json
### SCENARIO-017: Both env vars are documented

- **Acceptance Criteria**: AC-10
- **Priority**: low

**Given** the configuration surface is inspected
**When** an operator reads the source or README
**Then** both env vars are documented in a code comment at the resolution site and in a new README Configuration section with examples for a Rust workspace
---

## Traceability

- **AC-01**: SUPER_DEV_BUILD_TIMEOUT_MS honored, parsed defensively (missing/empty/NaN/<=0 → 600_000ms), threads into every spawnSync timeout. → SCENARIO-001, SCENARIO-002, SCENARIO-005
- **AC-02**: Default timeout constant raised to 600_000; explicit opts.timeoutMs still overrides env/default. → SCENARIO-003, SCENARIO-004
- **AC-03**: SUPER_DEV_BUILD_TEST_PACKAGES (comma-list) produces cargo test -p pkg1 -p pkg2 --quiet for rust; empty/unset → unchanged. → SCENARIO-006, SCENARIO-007, SCENARIO-009
- **AC-04**: opts.testPackages overrides env var and produces the same -p scoping for rust. → SCENARIO-008, SCENARIO-014
- **AC-05**: Three stage call sites need no change to inherit new default timeout and env-driven scoping. → SCENARIO-012
- **AC-06**: Non-Cargo repos unaffected: scoping only for language==='rust'; greenfield still pass:true, ran:[]. → SCENARIO-010, SCENARIO-011
- **AC-07**: Focused unit tests for env-parsing fallback, -p scoping construction, and opt.testPackages override. → SCENARIO-015
- **AC-08**: npm run typecheck passes; npm test passes including new tests; no new runtime deps. → SCENARIO-016
- **AC-09**: Target repo never mutated; only argv + timeout change, no #[ignore]/quarantine/file modification. → SCENARIO-013
- **AC-10**: Both env vars documented in code comment at resolution site and new README Configuration section. → SCENARIO-017

## Coverage Summary

- **Total Acceptance Criteria**: 10
- **Covered by Scenarios**: 10
- **Uncovered**: 0
- **Total Scenarios**: 17
