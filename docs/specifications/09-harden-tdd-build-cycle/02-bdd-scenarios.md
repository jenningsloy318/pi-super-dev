# Behavior Scenarios: Harden super-dev TDD/implement/build cycle: RED oracle, no-`--lib` parity, scope-aware npm gate, render-layer test parity

- **Date**: 2026-07-20
- **Author**: super-dev:bdd-scenario-writer
- **Source**: docs/specifications/09-harden-tdd-build-cycle/01-requirements.md
- **Total Scenarios**: 22

---
## Feature: RED Oracle: runRedCheck

### SCENARIO-001: Tests that compile and have at least one failure classify as red

- **Acceptance Criteria**: AC-01
- **Priority**: critical

**Given** a project with a detected test runner and a tdd-guide that reported one or more test file targets
**When** runRedCheck runs the test command scoped to those targets and the suite compiles/collects and at least one test fails
**Then** the function returns the status "red" indicating the desired pre-implementation state
**And** and the invocation uses the per-language command (cargo test -p <pkg> --test <stem> per stem, vitest run <files>, npm test -- <files>, or pytest <files>)
**And** and the timeout envelope comes from resolveTimeoutMs
### SCENARIO-002: Tests that all pass classify as green (weak or already-implemented)

- **Acceptance Criteria**: AC-01
- **Priority**: high

**Given** a project with a detected test runner and reported test file targets
**When** runRedCheck runs the scoped test command and every collected test passes
**Then** the function returns "green" so the caller knows the tests do not yet genuinely fail
### SCENARIO-003: A compile or collection error classifies as broken (defective test)

- **Acceptance Criteria**: AC-01
- **Priority**: high

**Given** a project with a detected test runner and reported test file targets
**When** the scoped test command fails before any test runs due to a compile or collection error
**Then** the function returns "broken" distinguishing a defective test from a genuine red
### SCENARIO-004: No runner or no targets classifies as unknown and never blocks

- **Acceptance Criteria**: AC-01
- **Priority**: critical

**Given** a greenfield repo with no detectable test runner, no test targets reported, or parse ambiguity
**When** runRedCheck is invoked
**Then** the function returns "unknown"
**And** and the caller proceeds exactly as today without aborting the pipeline
### SCENARIO-005: Any error during execution degrades instead of throwing

- **Acceptance Criteria**: AC-01
- **Priority**: critical

**Given** a project where the spawn or parsing would otherwise raise
**When** runRedCheck encounters a spawn failure, timeout, or unparseable output
**Then** the function never throws and instead returns a conservative status
**And** and no new spawn is made for greenfield repos so the pipeline cannot stall
## Feature: RED Enforcement in the Implementation Stage

### SCENARIO-006: Confirmed-red tests let the implementer proceed

- **Acceptance Criteria**: AC-02
- **Priority**: critical

**Given** the tdd-guide agent has reported its test files inside the attempt loop
**When** runRedCheck returns "red"
**Then** the stage proceeds directly to the implementer without re-prompting the tdd-guide
**And** and the implementer prompt is informed that the tests are confirmed-red so its goal is to make them green
**And** and the outcome is logged as Implementation ${phaseId} red-oracle: red (ran: …)
### SCENARIO-007: Green or broken tests trigger a bounded tdd-guide re-prompt

- **Acceptance Criteria**: AC-02
- **Priority**: high

**Given** runRedCheck returns "green" or "broken"
**When** the retry count has not exceeded MAX_RED_RETRIES (2)
**Then** the stage re-prompts the tdd-guide to write genuinely-failing, non-broken tests
**And** and re-runs runRedCheck against the new test files
**And** and logs each red-oracle outcome
### SCENARIO-008: Unknown status proceeds immediately and never stalls

- **Acceptance Criteria**: AC-02
- **Priority**: critical

**Given** runRedCheck returns "unknown" for a greenfield or ambiguous project
**When** the stage evaluates the status
**Then** it proceeds to the implementer immediately without any re-prompt
**And** and backward-compatible greenfield behavior is preserved
### SCENARIO-009: Retry-cap exhaustion proceeds with a loud warning rather than blocking

- **Acceptance Criteria**: AC-02
- **Priority**: high

**Given** runRedCheck still returns "green" or "broken" after MAX_RED_RETRIES (2) re-prompts
**When** the retry budget is exhausted
**Then** the stage proceeds to the implementer with a loud warning that tests are not confirmed-red
**And** and the worst-case cost per phase is bounded (2 tdd-guide + 2 red-check + 1 implementer + build-gate) and never infinite
### SCENARIO-010: Outer attempt and commit structure is unchanged

- **Acceptance Criteria**: AC-02
- **Priority**: medium

**Given** the RED enforcement loop is in place
**When** the stage completes a phase
**Then** the outer MAX_ATTEMPTS (3) structure and the gate.pass || gate.inScopePass commit condition remain unchanged
## Feature: No-`--lib` Parity in TDD and Implement Prompts

### SCENARIO-011: The TDD prompt forbids --lib-only Rust self-verification

- **Acceptance Criteria**: AC-03
- **Priority**: high

**Given** a Rust project whose spec language is rust
**When** buildTddPrompt constructs the prompt
**Then** the prompt instructs running cargo test -p <pkg> WITHOUT the --lib flag so the tests/ integration binaries run during the RED phase
**And** and the prompt requires running any spec-mandated integration target via cargo test --test <stem>
**And** and the same rustDiscipline helper is shared with buildImplementPrompt so both builders emit the identical no-`--lib` source string
## Feature: Scope-aware npm/vitest/jest Build Gate

### SCENARIO-012: A pre-existing failure in an untouched test file is classified out-of-scope

- **Acceptance Criteria**: AC-04
- **Priority**: high

**Given** an npm/vitest/jest project whose branch did not touch a particular test file and that file fails in the suite
**When** runBuildGate runs the tests and the suite fails
**Then** the failing test file is parsed from runner output and classified as out-of-scope because it is absent from the touched-file set
**And** and outOfScopeErrors is populated and inScopePass becomes true when no in-scope file fails
**And** and the touched-file set is computed via the shared touchedFilePaths(cwd, baseRef) helper reusing the existing git diff + ls-files union
### SCENARIO-013: A failure in a touched test file remains in-scope and blocks

- **Acceptance Criteria**: AC-04
- **Priority**: high

**Given** an npm/vitest/jest project whose branch modified a test file that fails in the suite
**When** runBuildGate runs the tests and the suite fails
**Then** the failing test file is classified as in-scope and inScopePass stays false
**And** and the repo with only in-scope failures still blocks the gate correctly
### SCENARIO-014: Parse ambiguity degrades conservatively to in-scope

- **Acceptance Criteria**: AC-04
- **Priority**: critical

**Given** an npm/vitest/jest project whose failing-test output cannot be parsed into file paths
**When** runBuildGate classifies the failure
**Then** it treats the failure as in-scope rather than granting a false green
**And** and the function never throws on parse, git, or spawn errors
### SCENARIO-015: Cargo in-scope classification is unchanged byte-for-byte

- **Acceptance Criteria**: AC-04
- **Priority**: medium

**Given** the generalized in-scope path is introduced for non-cargo runners
**When** a cargo project is gated
**Then** the existing cargo inScopePass behavior remains identical to before
## Feature: Render-layer Test Parity against the real Theme

### SCENARIO-016: The whole render layer is exercised against the real class-based Theme

- **Acceptance Criteria**: AC-05
- **Priority**: high

**Given** the withRealTheme helper that calls initTheme and passes the real proxy Theme
**When** themeLine, commandBackground, buildResultComponent, packDashboardLines, and createDashboardWidgetFactory's output are run through withRealTheme
**Then** each completes without throwing and produces ANSI output
**And** and the regression generalizes the existing stream-theme-class-theme test across the entire render layer
### SCENARIO-017: The parity helper never destructures Theme methods

- **Acceptance Criteria**: AC-05
- **Priority**: critical

**Given** a caller using withRealTheme to exercise a theme-consuming function
**When** it accesses the theme inside the callback
**Then** it uses method-style theme.fg(...) or a wrapper rather than destructuring
**And** and the this.fgColors crash class is therefore exposed deterministically by the real proxy
**And** and a detached method call that would crash at runtime is caught by the parity test
### SCENARIO-018: The parity convention is documented for future modules

- **Acceptance Criteria**: AC-05
- **Priority**: medium

**Given** a future render-layer module wrapping a framework type behind a structural interface
**When** a developer consults the testing convention
**Then** docs/testing-parity.md requires at least one parity test using withRealTheme/initTheme
**And** and mock-only coverage of a class-based dependency is documented as a known false-green
## Feature: Backward Compatibility, Type Safety, and Green Tests

### SCENARIO-019: Greenfield and unchanged repos behave exactly as before

- **Acceptance Criteria**: AC-06
- **Priority**: critical

**Given** a greenfield repo with no runner or a repo whose suite has no failures
**When** runRedCheck and runBuildGate execute
**Then** runRedCheck returns unknown and proceeds as today and the no-failure repo is unchanged
**And** and cargo inScopePass is unchanged
**And** and an npm repo with only in-scope failures still blocks correctly
### SCENARIO-020: The codebase is TypeScript strict-clean and the full suite is green

- **Acceptance Criteria**: AC-06
- **Priority**: critical

**Given** the change including helper-signature updates that affect existing tests
**When** npm run typecheck and npm test are run
**Then** typecheck is strict-clean with no any leaks across the new boundaries
**And** and the existing build-runner suite (scoped-args, touched-crates, autoscope, inscope-classification, resolver-validation, nonregression, package-wiring) plus the new red-oracle, parity, and npm-inscope suites are all green
**And** and new helpers reuse the existing typed interfaces ProjectCommands, BuildGateResult, and GateOptions
## Feature: No Regression to Existing Pipeline Behaviors

### SCENARIO-021: Existing render, gating, mid-run input, and artifact behaviors are preserved

- **Acceptance Criteria**: AC-07
- **Priority**: critical

**Given** the hardened TDD/implement/build cycle change is complete
**When** the pipeline runs end-to-end
**Then** the dashboard widget, themed stream, scope-aware cargo gate, mid-run input injection, and Markdown section 3 artifacts behave unchanged
**And** and the subprocess/session backend and control-flow engine (nodes.ts/workflow.ts/pipeline.ts) are untouched
**And** and MAX_ATTEMPTS (3) and the Stage 10 review / Stage 11 integration structure are unchanged
**And** and no new runtime dependencies are introduced
### SCENARIO-022: Every new gate, oracle, and git helper degrades instead of aborting the pipeline

- **Acceptance Criteria**: AC-07
- **Priority**: high

**Given** a scenario that would otherwise raise in a new helper
**When** the red oracle, npm in-scope parser, or git helper encounters an error or ambiguity
**Then** it degrades (unknown -> proceed; ambiguity -> conservative in-scope; git/spawn error -> empty touched set -> in-scope)
**And** and no path stalls or aborts except the existing genuine in-scope gate failure after MAX_ATTEMPTS
---

## Traceability

- **AC-01**: runRedCheck(cwd, testTargets, opts) exists with status red/green/broken/unknown, per-language invocation, never-throws, unknown-proceeds. → SCENARIO-001, SCENARIO-002, SCENARIO-003, SCENARIO-004, SCENARIO-005
- **AC-02**: implementation.ts enforces RED: re-prompts tdd-guide on green/broken (<=MAX_RED_RETRIES), proceeds on red/unknown, logs outcomes, never stalls. → SCENARIO-006, SCENARIO-007, SCENARIO-008, SCENARIO-009, SCENARIO-010
- **AC-03**: buildTddPrompt mirrors no-`--lib` discipline and requires full cargo test -p + integration targets, shared with buildImplementPrompt. → SCENARIO-011
- **AC-04**: runBuildGate classifies npm/vitest/jest failures in/out-of-scope via touched-file union; inScopePass/outOfScopeErrors populated for non-cargo; conservative on ambiguity; cargo unchanged. → SCENARIO-012, SCENARIO-013, SCENARIO-014, SCENARIO-015
- **AC-05**: tests/helpers/real-theme.ts + tests/render/real-theme-parity.test.ts exercise the whole render layer against the real Theme; docs/testing-parity.md documents the convention. → SCENARIO-016, SCENARIO-017, SCENARIO-018
- **AC-06**: Backward compatibility preserved; typecheck strict-clean; npm test ALL green (existing suite updated + new suites). → SCENARIO-019, SCENARIO-020
- **AC-07**: No regression to existing behaviors; no change to backend/engine, MAX_ATTEMPTS, or review/integration structure; no new runtime deps. → SCENARIO-021, SCENARIO-022

## Coverage Summary

- **Total Acceptance Criteria**: 7
- **Covered by Scenarios**: 7
- **Uncovered**: 0
- **Total Scenarios**: 22
