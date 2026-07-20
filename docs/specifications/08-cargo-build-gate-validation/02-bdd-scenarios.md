# Behavior Scenarios: Scope-Aware Cargo Build Gate: Untracked Inclusion, Validation, and Spec-Declared Gate Contract

- **Date**: 2026-07-20
- **Author**: super-dev:bdd-scenario-writer
- **Source**: docs/specifications/08-cargo-build-gate-validation/01-requirements.md
- **Total Scenarios**: 38

---
## Feature: Include untracked files in the touched surface (Layer B)

### SCENARIO-001: Untracked file under a crate contributes its package to scope

- **Acceptance Criteria**: AC-01
- **Priority**: high

**Given** a cargo workspace where the only change is a new, untracked file under crates/workflows/tests/
**When** the touched package surface is computed
**Then** the workflows crate appears in scope because untracked files are unioned with tracked changes
**And** and the workflows package is carried into the scoped build gate
### SCENARIO-002: Tracked and untracked changes are unioned before extracting crate directories

- **Acceptance Criteria**: AC-01
- **Priority**: high

**Given** tracked changes under crates/data and untracked changes under crates/tools
**When** the touched package surface is computed
**Then** both the data and tools crates appear in scope
**And** and the untracked-files source contributes even when the tracked-changes source also succeeds
### SCENARIO-003: A failing git source contributes nothing rather than throwing

- **Acceptance Criteria**: AC-01
- **Priority**: high

**Given** a directory that is not a git repository or a base reference that cannot be resolved
**When** the touched package surface is computed
**Then** the failing source contributes nothing to the union
**And** and no error is raised
**And** and the gate degrades gracefully toward a wider scope
## Feature: Resolver validation — never emit an invalid package flag (Layer C)

### SCENARIO-004: A directory whose name resolves to a known member is emitted

- **Acceptance Criteria**: AC-02
- **Priority**: high

**Given** a touched crate directory crates/data and a workspace where crates/data maps to the member package stockfan-data
**When** package names are resolved
**Then** the resolved name stockfan-data is emitted
### SCENARIO-005: A directory with no matching member is dropped, not emitted as its raw name

- **Acceptance Criteria**: AC-02
- **Priority**: critical

**Given** a touched crate directory crates/data and a workspace that contains no member matching that directory
**When** package names are resolved
**Then** the unresolved directory is discarded
**And** and no package flag carrying the raw directory name is ever produced
### SCENARIO-006: Cargo manifest failure widens to workspace-wide instead of guessing names

- **Acceptance Criteria**: AC-02
- **Priority**: critical

**Given** a repository where the cargo manifest is missing, times out, exits non-zero, or is malformed
**When** package names are resolved
**Then** the resolver returns an empty list rather than the touched directory names
**And** and the gate widens to a workspace-wide scope
**And** and no error is raised
### SCENARIO-007: Every candidate name is validated against known members before any flag is built

- **Acceptance Criteria**: AC-03
- **Priority**: critical

**Given** candidate package names arriving from any source (spec-declared, environment, or auto-detected)
**When** scoped gate arguments are constructed
**Then** each candidate is kept only if it is a known cargo member
**And** and an unknown candidate is silently dropped
**And** and the opaque 'package ID specification did not match' failure can no longer occur
### SCENARIO-008: An empty surviving set after validation widens to workspace-wide

- **Acceptance Criteria**: AC-03
- **Priority**: high

**Given** every candidate name fails member validation
**When** scoped gate arguments are constructed
**Then** the resulting package set is empty
**And** and the gate widens to a workspace-wide scope
**And** and no invalid package flag is emitted
## Feature: Spec-declared gate contract schema and prompt (Layer D)

### SCENARIO-009: A specification may optionally declare a gate contract

- **Acceptance Criteria**: AC-04
- **Priority**: high

**Given** a backend or integration feature specification
**When** the specification is produced
**Then** an optional gate contract is allowed on the specification output
**And** and the contract carries optional packages, a workspace flag, and integration targets
### SCENARIO-010: Omitting the gate contract leaves behavior unchanged

- **Acceptance Criteria**: AC-04
- **Priority**: high

**Given** a trivial or non-backend specification that declares no gate contract
**When** the specification is consumed
**Then** the behavior is identical to today
**And** and auto-detection continues to apply
### SCENARIO-011: The specification prompt instructs authors to declare a gate for backend features

- **Acceptance Criteria**: AC-05
- **Priority**: medium

**Given** a backend or integration feature being specified
**When** the specification prompt is rendered
**Then** the author is instructed to name the packages whose tests must pass
**And** and whether a workspace-wide scope is required
**And** and any e2e or integration target paths
### SCENARIO-012: The specification prompt permits omitting the gate for trivial features

- **Acceptance Criteria**: AC-05
- **Priority**: low

**Given** a non-backend or trivial feature being specified
**When** the specification prompt is rendered
**Then** the author is permitted to omit the gate contract
**And** and auto-detection applies in the absence of a declaration
## Feature: Gate contract threading and precedence (Layer D)

### SCENARIO-013: Spec-declared packages take precedence over environment and auto-detection

- **Acceptance Criteria**: AC-07
- **Priority**: high

**Given** a specification declaring gate packages and an environment variable also setting packages
**When** the build gate selects its scope
**Then** the spec-declared packages are used
**And** and the environment and auto-detected sources are ignored
### SCENARIO-014: A gate.workspace declaration short-circuits to workspace-wide

- **Acceptance Criteria**: AC-07
- **Priority**: high

**Given** a specification declaring gate.workspace as true
**When** the build gate selects its scope
**Then** the gate runs workspace-wide
**And** and any declared packages are ignored
### SCENARIO-015: Environment packages are used when no spec contract is declared

- **Acceptance Criteria**: AC-07
- **Priority**: medium

**Given** no spec gate contract and an environment variable setting packages
**When** the build gate selects its scope
**Then** the environment packages are used
**And** and auto-detection is skipped
### SCENARIO-016: Corrected auto-detection applies when no higher source is present

- **Acceptance Criteria**: AC-07
- **Priority**: medium

**Given** no spec gate contract and no environment packages
**When** the build gate selects its scope
**Then** the corrected auto-detection (untracked union plus validation) determines the scope
**And** and a failed resolution widens to workspace-wide
### SCENARIO-017: Integration targets are appended regardless of the chosen scope

- **Acceptance Criteria**: AC-07
- **Priority**: high

**Given** a specification declaring integration targets alongside scoped packages
**When** the build gate constructs its test invocation
**Then** the integration targets are appended on top of the scoped packages
**And** and the additional test targets run as part of the gate
### SCENARIO-018: Declared packages are validated before use and unknown ones are dropped

- **Acceptance Criteria**: AC-08
- **Priority**: high

**Given** a specification declaring packages where some are not known cargo members
**When** the build gate validates the declared names
**Then** the unknown names are dropped
**And** and a clear log line records each dropped name
**And** and no invalid package flag is emitted
### SCENARIO-019: An integration target with a source-file path is run as a named test target

- **Acceptance Criteria**: AC-08
- **Priority**: medium

**Given** an integration target declared as a path ending in .rs
**When** the build gate constructs the test invocation
**Then** the target is treated as a named test target derived from the file
### SCENARIO-020: All declared packages unknown to metadata widens to workspace-wide

- **Acceptance Criteria**: AC-07
- **Priority**: high

**Given** a spec contract whose every declared package fails member validation
**When** the build gate selects its scope
**Then** the surviving package set is empty
**And** and the gate widens to workspace-wide
### SCENARIO-021: The gate contract is threaded from the specification through run options

- **Acceptance Criteria**: AC-06
- **Priority**: high

**Given** a specification output that carries a gate contract
**When** the build gate is invoked
**Then** the gate contract is read from the specification and passed through run options into the gate
## Feature: Test suite correctness (Layer E)

### SCENARIO-022: Prefixed-name workspace resolves directory names to prefixed members

- **Acceptance Criteria**: AC-09
- **Priority**: high

**Given** a fixture workspace where crates/data maps to stockfan-data, crates/tools to stockfan-tools, and crates/workflows to stockfan-workflows
**When** the gate is run with those three touched directories
**Then** the captured arguments carry stockfan-data, stockfan-tools, and stockfan-workflows
**And** and none of them carry the raw directory name data
### SCENARIO-023: An untracked-only workflows change keeps workflows in scope

- **Acceptance Criteria**: AC-09
- **Priority**: high

**Given** a fixture where the only crates/workflows change is an untracked tests file surfaced through the untracked-files source
**When** the gate is run
**Then** stockfan-workflows still appears in the captured scope
### SCENARIO-024: A directory resolving to no member is dropped from scope

- **Acceptance Criteria**: AC-09
- **Priority**: high

**Given** a fixture where a touched directory resolves to no member package
**When** the gate is run
**Then** the unresolved directory is dropped
**And** and when every directory is unresolved the gate widens to workspace-wide arguments
### SCENARIO-025: A spec-declared gate contract drives the scope and appends integration

- **Acceptance Criteria**: AC-09
- **Priority**: high

**Given** run options declaring packages stockfan-data and stockfan-workflows and an integration target
**When** the gate is run
**Then** the gate uses the validated declared packages
**And** and appends the integration target to the test invocation
**And** and ignores auto-detected scope
## Feature: End-to-end stockfan shape

### SCENARIO-026: Touched data/tools/workflows with an untracked e2e resolves to three prefixed packages

- **Acceptance Criteria**: AC-10
- **Priority**: critical

**Given** touched directories data, tools, and workflows and an untracked e2e test under crates/workflows/tests/
**When** the build gate constructs its build, test, and clippy arguments
**Then** all three captured argument sets carry stockfan-data, stockfan-tools, and stockfan-workflows
**And** and the workflows crate is included via the untracked-file union
## Feature: Quality gates

### SCENARIO-027: Strict type checking passes

- **Acceptance Criteria**: AC-11
- **Priority**: high

**Given** the corrected source and tests in place
**When** strict type checking runs
**Then** it passes with no errors
### SCENARIO-028: The full test suite passes after corrections

- **Acceptance Criteria**: AC-11
- **Priority**: high

**Given** the corrected assertions and the new spec-declared-gate-contract test
**When** the test suite runs
**Then** all tests pass
**And** and the corrected assertions no longer encode the original bug
## Feature: Backward compatibility and no regression

### SCENARIO-029: A non-cargo repository behaves exactly as before

- **Acceptance Criteria**: AC-12
- **Priority**: high

**Given** a repository that is not a cargo workspace
**When** the build gate runs
**Then** the output is byte-identical to today
### SCENARIO-030: A non-git directory behaves exactly as before

- **Acceptance Criteria**: AC-12
- **Priority**: high

**Given** a working directory that is not a git repository
**When** the build gate runs
**Then** the output is byte-identical to today
### SCENARIO-031: A repository with no gate contract keeps auto-detection as the default

- **Acceptance Criteria**: AC-12
- **Priority**: high

**Given** a repository and specification that declare no gate contract
**When** the build gate runs
**Then** auto-detection remains the default strategy
**And** and the default is not switched to workspace-wide
### SCENARIO-032: Scope classification still partitions results correctly

- **Acceptance Criteria**: AC-12
- **Priority**: medium

**Given** gate output with in-scope and out-of-scope results
**When** the results are classified
**Then** in-scope and out-of-scope partitioning still works as before
### SCENARIO-033: Theme rendering remains method-bound and does not regress

- **Acceptance Criteria**: AC-12
- **Priority**: medium

**Given** any prompt or render change that touches theme
**When** theme methods are invoked
**Then** methods are called style-bound rather than destructured
**And** and the theme class regression test still passes
## Feature: Security and robustness invariants

### SCENARIO-034: No gate component ever raises an error

- **Acceptance Criteria**: AC-02
- **Priority**: critical

**Given** any failure in the git helpers, the metadata resolver, the validator, or the gate
**When** the failure is encountered
**Then** the component degrades toward a wider scope
**And** and no error propagates to the caller
### SCENARIO-035: Spawned commands never reach a shell

- **Acceptance Criteria**: AC-02
- **Priority**: high

**Given** git or metadata commands spawned during resolution
**When** the commands execute
**Then** each runs as a discrete argument list without a shell
**And** and package and path data never reaches shell interpretation
### SCENARIO-036: Metadata is only spawned when there is something to resolve

- **Acceptance Criteria**: AC-02
- **Priority**: medium

**Given** an empty touched input
**When** package names are resolved
**Then** the metadata command is not spawned
**And** and the result short-circuits without spawning
## Feature: Performance invariants

### SCENARIO-037: Metadata is cached per working directory

- **Acceptance Criteria**: AC-01
- **Priority**: medium

**Given** repeated resolutions against the same working directory
**When** package names are resolved
**Then** the cargo metadata result is served from cache rather than respawned
### SCENARIO-038: Only one new untracked-files spawn occurs

- **Acceptance Criteria**: AC-01
- **Priority**: medium

**Given** a working directory with touched changes
**When** the touched surface is computed
**Then** a single untracked-files source is consulted within the existing timeout envelope
**And** and no new runtime dependencies are introduced
---

## Traceability

- **AC-01**: Union tracked changes (git diff --merge-base) with untracked files (git ls-files --others --exclude-standard) before extracting crate dirs; either source failing contributes nothing rather than throwing. → SCENARIO-001, SCENARIO-002, SCENARIO-003, SCENARIO-038
- **AC-02**: resolveCargoPackageNames drops unresolved dirs (no identity fallback); metadata failure returns [] so the gate widens to workspace-wide; never throws. → SCENARIO-004, SCENARIO-005, SCENARIO-006, SCENARIO-034, SCENARIO-035, SCENARIO-036
- **AC-03**: Final validation gate inside runBuildGate confirms each candidate name is a known member before building any -p flag; empty surviving set widens to workspace-wide; applies to all sources. → SCENARIO-007, SCENARIO-008, SCENARIO-034
- **AC-04**: Specification-stage schema gains optional gate: { packages?, workspace?, integration? } on SpecificationData; backward compatible when omitted. → SCENARIO-009, SCENARIO-010
- **AC-05**: Specification prompt instructs agents to declare gate for backend/integration features; permits omitting for trivial specs. → SCENARIO-011, SCENARIO-012
- **AC-06**: RunOptions gains gate?: { packages?, workspace?, integration? }; implementation.ts/verify.ts/index.ts read state.spec?.gate and pass through. → SCENARIO-021
- **AC-07**: Precedence spec gate.packages -> env -> auto-detect -> workspace-wide; gate.workspace short-circuits; integration appended; empty-after-validation degrades to workspace-wide. → SCENARIO-013, SCENARIO-014, SCENARIO-015, SCENARIO-016, SCENARIO-017, SCENARIO-020
- **AC-08**: Declared gate.packages validated against metadata member map; unknown dropped with a clear log line; integration targets appended to the test command. → SCENARIO-018, SCENARIO-019
- **AC-09**: tests/build-runner-autoscope.test.ts corrected: prefixed fixture, untracked-file case, drop-unresolved case, and new spec-declared-gate-contract test. → SCENARIO-022, SCENARIO-023, SCENARIO-024, SCENARIO-025
- **AC-10**: End-to-end stockfan shape: data/tools/workflows with untracked e2e resolves to three prefixed packages across build/test/clippy and includes workflows via untracked union. → SCENARIO-026
- **AC-11**: npm run typecheck passes strict-clean; npm test passes after the test corrections in AC-09. → SCENARIO-027, SCENARIO-028
- **AC-12**: No regression: non-cargo/non-git/no-gate-contract byte-identical; scope classification still works; default stays auto-detect; theme method-binding not regressed. → SCENARIO-029, SCENARIO-030, SCENARIO-031, SCENARIO-032, SCENARIO-033

## Coverage Summary

- **Total Acceptance Criteria**: 12
- **Covered by Scenarios**: 12
- **Uncovered**: 0
- **Total Scenarios**: 38
