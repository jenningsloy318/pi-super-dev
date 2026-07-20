# Behavior Scenarios: Per-phase Deliverable Assertions for the Build Gate

- **Date**: 2026-07-21
- **Author**: super-dev:bdd-scenario-writer
- **Source**: /home/jenningsl/development/personal/jenningsloy318/pi-super-dev/.worktree/10-build-gate-deliverable-assertions/docs/specifications/10-build-gate-deliverable-assertions/01-requirements.md
- **Total Scenarios**: 25

---
## Feature: Deliverable Check Function

### SCENARIO-001: All declared deliverables present reports pass

- **Acceptance Criteria**: AC-01
- **Priority**: high

**Given** a phase declares a deliverable contract whose required files exist, whose required patterns are present, whose forbidden patterns are absent, and whose required tests are found in the project test list
**When** the deliverable check runs against the phase's worktree
**Then** it reports pass equals true
**And** the missing list is empty
**And** the ran list records every check performed
### SCENARIO-002: Missing required file fails with a clear reason

- **Acceptance Criteria**: AC-01
- **Priority**: high

**Given** a phase declares a required file path that does not exist relative to the worktree
**When** the deliverable check runs
**Then** it reports pass equals false
**And** the missing list contains the reason 'missing file: <path>'
### SCENARIO-003: Absent required pattern fails with a clear reason

- **Acceptance Criteria**: AC-01
- **Priority**: high

**Given** a phase declares a required-contains pattern that does not match the file's contents
**When** the deliverable check runs
**Then** it reports pass equals false
**And** the missing list contains 'missing pattern <pattern> in <file>'
### SCENARIO-004: Forbidden pattern still present fails with a clear reason

- **Acceptance Criteria**: AC-01
- **Priority**: high

**Given** a phase declares a forbidden pattern that still appears in the file
**When** the deliverable check runs
**Then** it reports pass equals false
**And** the missing list contains 'forbidden pattern <pattern> still present in <file>'
### SCENARIO-005: Missing required test fails with a clear reason

- **Acceptance Criteria**: AC-01
- **Priority**: high

**Given** a phase declares a required test name that is absent from the collected project test list
**When** the deliverable check runs
**Then** it reports pass equals false
**And** the missing list contains 'missing test: <name>'
### SCENARIO-006: Test names match tolerantly by substring or regex

- **Acceptance Criteria**: AC-01
- **Priority**: medium

**Given** a phase declares a required test name that is a substring of a collected test path
**When** the deliverable check matches declared test names
**Then** the test is treated as present rather than missing
**And** the documented matching rule treats the name as a regex when it parses, otherwise as a substring
**And** a match by either interpretation satisfies the requirement
### SCENARIO-007: No supported test runner degrades requireTests without blocking existence or grep checks

- **Acceptance Criteria**: AC-01
- **Priority**: medium

**Given** a repository exposes no supported test runner
**When** a phase declares requireTests alongside requireFiles and requireContains
**Then** the check records 'test-list unavailable' for the test sub-check
**And** the existence and grep sub-checks are still enforced
**And** the check does not crash the gate over the unavailable runner
### SCENARIO-008: Unreadable file never throws the check

- **Acceptance Criteria**: AC-01
- **Priority**: high

**Given** a phase declares a required-contains check against a file that cannot be read
**When** the deliverable check runs
**Then** it records 'unreadable: <path>' and continues
**And** no exception propagates to the caller
**And** remaining sub-checks are still evaluated
### SCENARIO-009: Test-list subprocess spawns at most once per worktree per run

- **Acceptance Criteria**: AC-01
- **Priority**: medium

**Given** several phases in one implementation run share the same worktree
**When** requireTests is evaluated for each phase
**Then** the test-listing subprocess spawns no more than once for the whole run
**And** later phases reuse the cached test list
### SCENARIO-010: Deliverable check is unit-tested across all sub-check cases

- **Acceptance Criteria**: AC-02
- **Priority**: high

**Given** the deliverable-check test suite exercising a temporary worktree
**When** the suite runs
**Then** it covers existing and missing files, present and absent patterns, a forbidden-pattern hit, missing and present tests, an unreadable file, and the no-runner-skip case
**And** it asserts the exact reason strings in the missing list
**And** it asserts the ran list records the checks performed
## Feature: Phase Completion AND-Semantics

### SCENARIO-011: Build-green phase with missing deliverables is not green

- **Acceptance Criteria**: AC-03
- **Priority**: critical

**Given** a phase whose in-scope build and tests pass but whose declared deliverables are missing
**When** the implementation stage computes the phase verdict
**Then** the phase is marked not green
**And** green equals false even though the build-gate passed or passed in scope
### SCENARIO-012: Missing deliverables are fed into the next implementer attempt

- **Acceptance Criteria**: AC-03
- **Priority**: high

**Given** a phase is build-green but fails its deliverable check
**When** the implementation stage retries the implementer
**Then** the implementer receives an additive 'Deliverables still missing' instruction block listing the missing deliverables
**And** the existing build-gate error block is still emitted when it also applies
### SCENARIO-013: Deliverable failures respect the maximum attempt budget

- **Acceptance Criteria**: AC-03
- **Priority**: medium

**Given** a phase's deliverables remain missing across retries
**When** the maximum number of attempts is reached
**Then** the stage stops retrying that phase
**And** the phase remains not green
### SCENARIO-014: Phase without declared deliverables is unchanged

- **Acceptance Criteria**: AC-03
- **Priority**: high

**Given** a phase that declares no deliverables
**When** the phase is evaluated
**Then** the deliverable check passes trivially
**And** today's build-green behavior is preserved
**And** no deliverable subprocess or log noise is introduced
### SCENARIO-015: Deliverable verdict is logged clearly

- **Acceptance Criteria**: AC-03
- **Priority**: low

**Given** a phase whose deliverable check has just completed
**When** the stage records the verdict
**Then** a single log line states the PASS or FAIL outcome
**And** the missing entries are joined with semicolons or reported as none
### SCENARIO-016: False-green stockfan regression is blocked when deliverables are absent

- **Acceptance Criteria**: AC-06
- **Priority**: critical

**Given** a stockfan-style phase declaring required files, a required wiring pattern, a forbidden wiring pattern, and a required test, all absent
**When** the combined phase verdict is computed alongside a passing stub build-gate
**Then** the deliverable check reports pass equals false
**And** the combined phase verdict is not green despite the green build-gate
### SCENARIO-017: Same phase is green when deliverables are present

- **Acceptance Criteria**: AC-06
- **Priority**: high

**Given** the same stockfan-style phase with all deliverables now present
**When** the combined phase verdict is computed
**Then** the deliverable check reports pass equals true
**And** the combined phase verdict is green
## Feature: Specification Prompt Elicitation

### SCENARIO-018: Spec prompt instructs declaring non-compiler-checkable deliverables

- **Acceptance Criteria**: AC-04
- **Priority**: high

**Given** a specification phase whose deliverable is not detectable by the compiler, such as creating a file, wiring a call site, making a new source reachable, or adding a named test
**When** the spec author follows the build-specification prompt
**Then** the author declares deliverables using requireFiles, requireContains, requireNotContains, and requireTests as applicable
**And** the prompt explains that deliverables are combined with build-green to define phase completion
**And** the phases item accepts an optional deliverables field
## Feature: Specification Schema Extension

### SCENARIO-019: Schema accepts the optional deliverables object on phases

- **Acceptance Criteria**: AC-05
- **Priority**: high

**Given** a specification whose phases include an optional deliverables object
**When** the specification schema validates the data
**Then** the deliverables object is accepted
**And** the existing specification registration, template, and additional docs remain unchanged
### SCENARIO-020: Specifications without deliverables validate unchanged

- **Acceptance Criteria**: AC-05
- **Priority**: medium

**Given** a specification whose phases declare no deliverables
**When** the schema validates the data
**Then** validation behaves identically to before the change
## Feature: Backward Compatibility, Scope, and Theme Safety

### SCENARIO-021: Existing deliverable-free specifications behave identically

- **Acceptance Criteria**: AC-07
- **Priority**: high

**Given** an existing specification that declares no deliverables
**When** a build runs with the new logic
**Then** the run behaves byte-for-byte like the prior behavior
**And** no additional subprocess is spawned
**And** the phase verdict logic is unchanged
### SCENARIO-022: Change stays within the permitted scope of files

- **Acceptance Criteria**: AC-07
- **Priority**: high

**Given** the deliverable-assertion change
**When** it is applied to the repository
**Then** only the build-runner, implementation stage, spec prompt, and specification schema plus the phase-normalizing helper are touched
**And** control-flow, review, integration, and backend selection are left unchanged
### SCENARIO-023: Theme instances are used method-style and guards stay green

- **Acceptance Criteria**: AC-07
- **Priority**: high

**Given** code that interacts with pi Theme instances
**When** the change is applied
**Then** theme methods are called rather than destructured
**And** the theme-class and real-theme-parity guards remain green
### SCENARIO-024: Typecheck and full test suite are green

- **Acceptance Criteria**: AC-07
- **Priority**: critical

**Given** the repository after the change
**When** the typecheck and the full test suite run
**Then** the typecheck is strict-clean with no new errors
**And** all pre-existing suites remain green
**And** the new deliverable-check, AND-wiring, and spec-prompt tests pass
### SCENARIO-025: No regression to prior build-gate capabilities

- **Acceptance Criteria**: AC-07
- **Priority**: high

**Given** the prior red-check, in-scope detection, scope-aware cargo gate, themed stream, mid-run input, and dashboard capabilities
**When** the deliverable-assertion change is applied
**Then** each prior capability continues to behave as before
---

## Traceability

- **AC-01**: runDeliverableCheck enforces requireFiles/requireContains/requireNotContains/requireTests with tolerant matching, caches the test-list spawn, returns {pass,missing,ran}, and never throws → SCENARIO-001, SCENARIO-002, SCENARIO-003, SCENARIO-004, SCENARIO-005, SCENARIO-006, SCENARIO-007, SCENARIO-008, SCENARIO-009
- **AC-02**: runDeliverableCheck is unit-tested across all sub-check cases with exact reason strings and ran-list assertions → SCENARIO-010
- **AC-03**: implementation.ts computes green as build-green AND deliverable-check pass, feeds missing deliverables into retries, logs, respects MAX_ATTEMPTS, never throws, and no-ops when deliverables are absent → SCENARIO-011, SCENARIO-012, SCENARIO-013, SCENARIO-014, SCENARIO-015
- **AC-04**: buildSpecPrompt instructs declaring per-phase deliverables and accepts phases[].deliverables → SCENARIO-018
- **AC-05**: SpecificationData schema accepts optional phases[].deliverables while leaving existing registration, template, and docs unchanged → SCENARIO-019, SCENARIO-020
- **AC-06**: Regression test simulating the stockfan false-green proves AND-semantics both ways at the checker and wiring level → SCENARIO-016, SCENARIO-017
- **AC-07**: typecheck strict-clean and full test suite green with no regressions; scope, theme safety, and backward compatibility preserved → SCENARIO-021, SCENARIO-022, SCENARIO-023, SCENARIO-024, SCENARIO-025

## Coverage Summary

- **Total Acceptance Criteria**: 7
- **Covered by Scenarios**: 7
- **Uncovered**: 0
- **Total Scenarios**: 25
