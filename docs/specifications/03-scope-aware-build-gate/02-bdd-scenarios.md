# Behavior Scenarios: Scope-Aware Build Gate — auto-scope cargo gate to touched crates and stop false-aborting on pre-existing out-of-scope failures

- **Date**: 2026-07-20
- **Author**: super-dev:bdd-scenario-writer
- **Source**: docs/specifications/03-scope-aware-build-gate/01-requirements.md
- **Total Scenarios**: 29

---
## Feature: Auto-detection of cargo crates touched by the branch

### SCENARIO-001: Touched-crate detection maps changed crate paths to package names preserving order

- **Acceptance Criteria**: AC-01
- **Priority**: high

**Given** a git worktree whose current branch changed files under crates/data/ and crates/api/ relative to base ref main
**When** the build gate derives the touched cargo package set
**Then** the resolved set is [data, api] in first-seen order with duplicates removed
### SCENARIO-002: Base ref can be overridden via the environment

- **Acceptance Criteria**: AC-01
- **Priority**: medium

**Given** the environment variable SUPER_DEV_GATE_BASE_REF is set to develop
**When** touched-crate detection runs
**Then** the branch is compared against develop instead of the default main
### SCENARIO-003: Git failures, empty diffs, and non-crate-only diffs degrade safely to workspace-wide

- **Acceptance Criteria**: AC-01
- **Priority**: high

**Given** a non-git directory, a missing base ref, an empty diff, or a diff containing only non-crate paths
**When** touched-crate detection runs
**Then** the resolved set is empty
**And** the helper never throws an exception
**And** the gate falls back to workspace-wide behavior
## Feature: Scoped cargo argv construction for build, test, and clippy

### SCENARIO-004: Scoped helpers emit per-package -p flags with preserved extra flags

- **Acceptance Criteria**: AC-02
- **Priority**: high

**Given** a non-empty resolved package set {data, api}
**When** the scoped build, test, and clippy argvs are constructed
**Then** each argv starts with its cargo subcommand followed by -p data -p api and the expected extra flags
**And** the test argv keeps the --quiet flag
**And** the clippy argv keeps --all-targets and --quiet
**And** the build argv carries --quiet
**And** the existing scopedCargoTestArgs callers and tests remain unchanged
### SCENARIO-005: Empty package set produces byte-identical workspace-wide argvs

- **Acceptance Criteria**: AC-02
- **Priority**: medium

**Given** an empty resolved package set
**When** the three scoped helpers construct their argvs
**Then** the build, test, and clippy argvs are byte-identical to today's workspace-wide forms
**And** cargo build --quiet
**And** cargo test --quiet
**And** cargo clippy --all-targets --quiet
## Feature: All-three-command gate scoping with precedence

### SCENARIO-006: Build, test, and clippy are all scoped to touched crates when nothing is overridden

- **Acceptance Criteria**: AC-03
- **Priority**: high

**Given** a cargo workspace whose branch touched crates/data and no explicit or environment package override is provided
**When** the build gate resolves the command set
**Then** the build, test, and typecheck (clippy) argvs all carry the -p data scoping on the shallow command copy
### SCENARIO-007: Higher-precedence package sources skip auto-detection and win

- **Acceptance Criteria**: AC-03
- **Priority**: high

**Given** explicit test packages, an explicit empty array, or the SUPER_DEV_BUILD_TEST_PACKAGES environment variable is present
**When** the build gate resolves the scoped package set
**Then** the higher-precedence source is used and touched-crate detection is not run at all
**And** an explicit empty array forces workspace-wide
**And** auto-detection is never invoked when an override exists
### SCENARIO-008: Empty resolved scope leaves all three commands workspace-wide and unchanged

- **Acceptance Criteria**: AC-03
- **Priority**: medium

**Given** an empty resolved package set
**When** the build gate builds its command object
**Then** the build, test, and typecheck argvs are byte-identical to the detected project commands
## Feature: In-scope failure classification on gate result

### SCENARIO-009: All-out-of-scope failures yield an in-scope pass

- **Acceptance Criteria**: AC-04
- **Priority**: high

**Given** a failed gate whose collected errors all reference crates outside the resolved scoped set {data}, such as crates/compute/
**When** the gate classifies each error block
**Then** every error is recorded as out-of-scope
**And** outOfScopeErrors holds all of them
**And** inScopePass is true because every failure is pre-existing/out-of-scope
### SCENARIO-010: Any in-scope failure prevents an in-scope pass

- **Acceptance Criteria**: AC-04
- **Priority**: high

**Given** a failed gate whose errors include at least one referencing a scoped crate, e.g. crates/data/
**When** the gate classifies the errors
**Then** that error is classified as in-scope
**And** inScopePass is false (no false green)
**And** errors in crates/compute/ alongside the in-scope one are still recorded in outOfScopeErrors
### SCENARIO-011: Ambiguous or malformed errors are treated conservatively as in-scope

- **Acceptance Criteria**: AC-04
- **Priority**: medium

**Given** an error block that cannot be reliably mapped to any crate, or malformed classifier output
**When** the gate classifies it
**Then** the error is treated as in-scope rather than granting a false green
**And** the classifier never throws
**And** a passing gate sets inScopePass true and skips classification as a no-op
## Feature: Implementation retry loop treats in-scope pass as phase green

### SCENARIO-012: Out-of-scope-only failures are treated as phase green without early termination

- **Acceptance Criteria**: AC-05
- **Priority**: high

**Given** a phase whose gate reports inScopePass true with several pre-existing out-of-scope failures
**When** the implementation retry loop decides the phase verdict
**Then** the phase is considered green
**And** the gate call signature passed to the worktree is unchanged (scoping derived internally)
**And** the log states IN-SCOPE GREEN with the count of ignored out-of-scope failures and their crates
**And** the loop does not waste further attempts
### SCENARIO-013: Genuine in-scope failures still terminate the stage early

- **Acceptance Criteria**: AC-05
- **Priority**: high

**Given** a phase whose gate fails with at least one in-scope error on every attempt up to the maximum
**When** the maximum number of attempts is reached without pass or inScopePass
**Then** the stage terminates early reporting failure after the attempts
**And** allGreen is set false and remaining phases do not run
**And** early termination fires only on genuine in-scope failures
### SCENARIO-014: A cleanly passing gate is green via pass regardless of classification

- **Acceptance Criteria**: AC-05
- **Priority**: medium

**Given** a phase whose gate passes outright
**When** the retry loop checks the verdict
**Then** the phase is green via pass and proceeds normally
## Feature: Backward compatibility and non-regression

### SCENARIO-015: Non-cargo, non-git, and unset-config repos behave identically to today

- **Acceptance Criteria**: AC-06
- **Priority**: high

**Given** a non-cargo repository, a non-git directory, a repo with no touched crates, or all environment overrides unset
**When** the build gate runs
**Then** the gate argvs and result are identical to today's behavior
**And** the only differences are the two additive result fields
**And** project-command detection purity is preserved (overrides apply only on the shallow copy)
**And** the in-scope classification never blocks when there are no failures or no scoping is active
### SCENARIO-016: Workspace-wide scope never grants an in-scope pass the old code would not

- **Acceptance Criteria**: AC-06
- **Priority**: medium

**Given** a workspace-wide (empty-scoped) gate run
**When** failures occur
**Then** every failure counts as in-scope so inScopePass stays false
**And** current abort semantics are preserved
**And** non-scoped runs cannot gain a green they would not have had
## Feature: Tests, type-safety, and build hygiene

### SCENARIO-017: New co-located tests cover detection, argv construction, classification, and integration

- **Acceptance Criteria**: AC-07
- **Priority**: high

**Given** the new build-runner and implementation tests covering touched-crate detection, scoped argv construction, in-scope classification, and a stubbed runBuildGate integration
**When** the test suite runs
**Then** both existing and new tests pass
### SCENARIO-018: Strict typecheck and full test run pass with no new dependencies

- **Acceptance Criteria**: AC-07
- **Priority**: high

**Given** the strict TypeScript project with no new runtime dependencies or spawned processes beyond the existing gate commands plus one git diff --name-only
**When** typecheck and tests run
**Then** npm run typecheck (tsc --noEmit, strict) and npm test (vitest run) both succeed
**And** no new runtime dependencies are introduced
**And** no new processes beyond existing gate commands plus one git diff --name-only
### SCENARIO-019: Constraint isolation is maintained

- **Acceptance Criteria**: AC-07
- **Priority**: medium

**Given** a change limited to src/build-runner.ts, src/stages/implementation.ts, and tests
**When** the change set is reviewed
**Then** nodes.ts, workflow.ts, pipeline.ts, render templates, and the control-flow engine remain untouched
**And** the target repository is never mutated by the gate
## Feature: Performance and safety guardrails

### SCENARIO-020: Auto-scoping adds at most one git diff per gate and reduces wall-time on monorepos

- **Acceptance Criteria**: AC-01
- **Priority**: medium

**Given** a large monorepo with a higher-precedence package source absent
**When** the gate runs with auto-detected touched crates
**Then** at most one additional git diff --name-only spawn occurs
**And** the git-diff helper uses the existing bounded spawnSync pattern, never an unbounded shell
**And** the three scoped cargo commands reduce overall wall-time versus workspace-wide
### SCENARIO-021: Robustness helpers never throw and always degrade safely

- **Acceptance Criteria**: AC-04
- **Priority**: medium

**Given** any git error, malformed classifier output, or regex ambiguity during detection or classification
**When** the gate continues
**Then** it degrades to workspace-wide behavior or a conservative in-scope classification
**And** the helper and classifier never throw
**And** the contract of never false-aborting on green and never false-passing on broken is preserved
## Feature: Known edge cases and explicitly out-of-scope work

### SCENARIO-022: Uncommitted brand-new crate relies on fallback classification rather than detection

- **Acceptance Criteria**: AC-01
- **Priority**: low

**Given** an implementer created a new crate that has not yet been committed before the first gate attempt
**When** touched-crate detection runs against committed changes
**Then** the new crate is not in the resolved set
**And** the in-scope fallback classification still protects against false-abort
**And** this remains a documented known edge case
### SCENARIO-023: Full main-baseline diff gating is explicitly deferred to future work

- **Acceptance Criteria**: AC-01
- **Priority**: low

**Given** the current in-scope classification approach
**When** the implementation summary is written
**Then** running the gate on main and subtracting baselines is noted as a future enhancement rather than implemented this pass
**And** default-branch auto-detection beyond the literal main default is also noted as future work
## Feature: Retry-loop error feedback surfacing (recommended)

### SCENARIO-024: Genuine in-scope failures are the only errors fed back to the implementer

- **Acceptance Criteria**: AC-04
- **Priority**: low

**Given** a gate run with mixed in-scope and out-of-scope failures during a genuine in-scope retry
**When** the implementer's next attempt receives its error context
**Then** only the in-scope subset is surfaced for fixing
**And** pre-existing out-of-scope noise is excluded from the feedback
**And** when inScopePass is the reason for green, no further attempt is made, avoiding fix-loop waste
## Feature: In-scope log clarity

### SCENARIO-025: In-scope green is logged with the ignored crate list

- **Acceptance Criteria**: AC-05
- **Priority**: medium

**Given** a phase that is green via inScopePass on attempt N
**When** the retry loop records the verdict
**Then** the log message identifies the phase and attempt, states IN-SCOPE GREEN, and lists the count and comma-separated crate names of ignored pre-existing out-of-scope failures
**And** the message format matches: Implementation <phaseId> IN-SCOPE GREEN on attempt <attempt> — <count> pre-existing out-of-scope failure(s) ignored (crates: <list>)
## Feature: Full baseline-diff gating deferred (explicit out-of-scope)

### SCENARIO-026: Baseline subtraction on main is not implemented this pass

- **Acceptance Criteria**: AC-06
- **Priority**: low

**Given** the recommendation to ship the cheaper in-scope classification now
**When** work is completed
**Then** full baseline-diff gating is documented as future work in the implementation summary
**And** no baseline-diff code paths are introduced
**And** the in-scope classification covers the common case more cheaply
## Feature: Non-regression of existing scopedCargoTestArgs

### SCENARIO-027: Existing scopedCargoTestArgs callers behave identically via the shared helper

- **Acceptance Criteria**: AC-05
- **Priority**: high

**Given** existing call sites and tests for scopedCargoTestArgs in verify.ts and implementation.ts
**When** scopedCargoTestArgs is reimplemented as a thin wrapper over the shared scopedCargoArgs
**Then** those callers and tests continue to pass without modification
**And** scopedCargoTestArgs(packages) returns scopedCargoArgs("test", packages, ["--quiet"])
**And** new scopedCargoBuildArgs and scopedCargoClippyArgs are added without changing the existing function's contract
## Feature: Error path extraction robustness

### SCENARIO-028: Both source-path and -p package markers are recognized when classifying

- **Acceptance Criteria**: AC-04
- **Priority**: medium

**Given** cargo error blocks that reference crates via crates/<pkg>/ path segments inside --> <path> markers and via -p <pkg> markers in test-failure lines
**When** the classifier extracts referenced crates
**Then** all referenced crates from both marker styles are considered when deciding in- vs out-of-scope
**And** an error is out-of-scope only when every referenced crate is outside the scoped set
**And** an error touching at least one scoped crate is in-scope
## Feature: TypeScript strictness

### SCENARIO-029: Strict mode type-clean across the changed files

- **Acceptance Criteria**: AC-07
- **Priority**: high

**Given** the strict tsconfig and the new BuildGateResult fields plus the new helper signatures
**When** tsc --noEmit runs under strict mode
**Then** no type errors are reported in build-runner.ts, implementation.ts, or their tests
---

## Traceability

- **AC-01**: detectTouchedCargoPackages(cwd, baseRef?) spawns git diff --merge-base <baseRef> --name-only, maps crates/<pkg>/ lines to packages, dedupes preserving order, returns [] on any git error/empty/non-crate diff, never throws; runBuildGate auto-derives the scoped set when no override is given. → SCENARIO-001, SCENARIO-002, SCENARIO-003, SCENARIO-020, SCENARIO-022, SCENARIO-023
- **AC-02**: Generalize scopedCargoTestArgs into scopedCargoArgs(subcommand, packages, extraArgs?); keep scopedCargoTestArgs as a thin wrapper and add scopedCargoBuildArgs and scopedCargoClippyArgs; empty set yields byte-identical workspace-wide argvs. → SCENARIO-004, SCENARIO-005
- **AC-03**: In runBuildGate, override build/test/typecheck on the shallow cmds copy when rust and non-empty scope; empty scope stays byte-identical; precedence explicit -> SUPER_DEV_BUILD_TEST_PACKAGES -> touched crates -> workspace-wide; detection skipped when higher source present. → SCENARIO-006, SCENARIO-007, SCENARIO-008
- **AC-04**: Extend BuildGateResult with outOfScopeErrors and inScopePass; classify errors via crates/<pkg>/ and -p <pkg> markers; inScopePass true only when all failures are out-of-scope; classifier never throws and treats ambiguity as in-scope. → SCENARIO-009, SCENARIO-010, SCENARIO-011, SCENARIO-021, SCENARIO-024, SCENARIO-028
- **AC-05**: implementation.ts retry loop: phase is GREEN when gate.pass || gate.inScopePass; IN-SCOPE GREEN logged; early-terminate only on genuine in-scope failures after MAX_ATTEMPTS; runBuildGate call signature unchanged; existing scopedCargoTestArgs callers/tests unchanged. → SCENARIO-012, SCENARIO-013, SCENARIO-014, SCENARIO-025, SCENARIO-027
- **AC-06**: Backward compatibility: non-Cargo/non-git/no-touched/unset-env runs identical to today modulo additive fields; workspace-wide never grants inScopePass; detectProjectCommands purity preserved; full baseline-diff gating deferred. → SCENARIO-015, SCENARIO-016, SCENARIO-026
- **AC-07**: New co-located tests covering detection, argv construction, classification, and a stubbed runBuildGate integration; npm run typecheck (strict) and npm test (vitest) pass; no new deps/processes; constraint isolation maintained. → SCENARIO-017, SCENARIO-018, SCENARIO-019, SCENARIO-029

## Coverage Summary

- **Total Acceptance Criteria**: 7
- **Covered by Scenarios**: 7
- **Uncovered**: 0
- **Total Scenarios**: 29
