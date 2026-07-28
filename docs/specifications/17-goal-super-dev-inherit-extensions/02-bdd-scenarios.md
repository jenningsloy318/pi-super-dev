# Behavior Scenarios: SUPER_DEV_INHERIT_EXTENSIONS Opt-in (Gap #3)

- **Date**: 2025-11-19
- **Author**: super-dev:bdd-scenario-writer
- **Source**: /home/jenningsl/development/personal/jenningsloy318/pi-super-dev/.worktree/17-goal-super-dev-inherit-extensions/docs/specifications/17-goal-super-dev-inherit-extensions/01-requirements.md
- **Total Scenarios**: 16

---
## Feature: Extension-Inheritance Opt-in Parsing (inheritExtensions helper)

### SCENARIO-001: A recognized truthy opt-in token enables extension inheritance

- **Acceptance Criteria**: AC-01
- **Priority**: high

**Given** the SUPER_DEV_INHERIT_EXTENSIONS opt-in is set to a recognized truthy token (one of 1, true, yes, or on)
**When** a specialist is spawned
**Then** the inheritance helper reports inheritance as ENABLED so ambient extensions are eligible to load in that specialist
### SCENARIO-002: Truthiness is tolerant of letter case and surrounding whitespace

- **Acceptance Criteria**: AC-01
- **Priority**: medium

**Given** the opt-in token is supplied in mixed case with surrounding whitespace (for example "  YES  " or "On")
**When** the inheritance helper parses the opt-in
**Then** inheritance is still reported as ENABLED
### SCENARIO-003: An absent, empty, false, or unrecognized value leaves inheritance OFF

- **Acceptance Criteria**: AC-01
- **Priority**: high

**Given** the opt-in is unset, empty, or set to a false or unrecognized value (0, false, off-equivalent, or arbitrary garbage)
**When** the inheritance helper parses the opt-in
**Then** inheritance is reported as DISABLED, matching the existing isolated default
## Feature: Subprocess Backend Isolation Control

### SCENARIO-004: With the opt-in OFF, a non-browser specialist stays extension-free (byte-identical baseline)

- **Acceptance Criteria**: AC-02
- **Priority**: critical

**Given** the opt-in is OFF and a non-browser specialist is requested
**When** the subprocess backend prepares the specialist's launch arguments
**Then** the specialist is launched with ambient extensions suppressed, identical to the current behavior
### SCENARIO-005: With the opt-in ON, a non-browser specialist loads ambient extensions

- **Acceptance Criteria**: AC-02
- **Priority**: high

**Given** the opt-in is ON and a non-browser specialist is requested
**When** the subprocess backend prepares the specialist's launch arguments
**Then** ambient extension suppression is omitted so the user's global and project extensions load in that specialist
### SCENARIO-006: A browser-capable specialist never has extensions suppressed regardless of the opt-in

- **Acceptance Criteria**: AC-04
- **Priority**: high

**Given** a browser-capable specialist is requested, in either opt-in state
**When** the subprocess backend prepares the specialist's launch arguments
**Then** ambient extension suppression is never applied to that specialist
**And** this behavior is unchanged by the opt-in in either direction
## Feature: Session Backend Isolation Control

### SCENARIO-007: With the opt-in OFF, the session specialist loads only the inline safety factory (byte-identical baseline)

- **Acceptance Criteria**: AC-03
- **Priority**: critical

**Given** the opt-in is OFF and a session-backend specialist is created
**When** the resource loader for the specialist is constructed
**Then** ambient extensions remain suppressed while the inline safety factory still loads, identical to the current behavior
### SCENARIO-008: With the opt-in ON, the session specialist loads ambient extensions alongside the safety factory

- **Acceptance Criteria**: AC-03
- **Priority**: high

**Given** the opt-in is ON and a session-backend specialist is created
**When** the resource loader for the specialist is constructed
**Then** ambient global and project extensions are loaded
**And** the inline safety factory continues to load unchanged
## Feature: Trade-off Documentation at Wiring Points

### SCENARIO-009: Each wiring point documents the determinism trade-off and intended use

- **Acceptance Criteria**: AC-05
- **Priority**: medium

**Given** the source at both the subprocess guard and the session-backend loader
**When** a maintainer reads the wiring point
**Then** a concise comment explains that opting in loses determinism because the child loads ALL user extensions
**And** the comment notes that specialists receive no user input so they will not self-trigger the pipeline
**And** the comment states the opt-in is intended for users whose model stack depends on an extension-registered provider
## Feature: Focused Test Coverage

### SCENARIO-010: The subprocess flag presence is asserted per opt-in state and agent type

- **Acceptance Criteria**: AC-06
- **Priority**: high

**Given** focused subprocess-backend tests exist for extension suppression
**When** the tests assert on a non-browser specialist across opt-in OFF and ON
**Then** suppression is present when OFF and absent when ON
**And** the tests assert browser-capable specialists never receive suppression regardless of the opt-in
### SCENARIO-011: The parsing helper is unit-tested for truthy and falsy inputs

- **Acceptance Criteria**: AC-06
- **Priority**: high

**Given** a unit test for the inheritance parsing helper
**When** it exercises truthy tokens (including mixed case and padded) and falsy inputs (unset, 0, false, empty, garbage)
**Then** it reports ENABLED for every recognized truthy token and DISABLED for every falsy or unrecognized input
## Feature: CHANGELOG Contract

### SCENARIO-012: A new Added entry summarizes the opt-in without breaking the existing contract

- **Acceptance Criteria**: AC-07
- **Priority**: medium

**Given** the CHANGELOG's [Unreleased] section under ### Added
**When** the opt-in is documented
**Then** the first new bullet is a bold bullet whose text contains an anchor such as inherit, extensions, or provider
**And** the changelog contract test remains green
**And** the previously matched anchors and bullets are not removed or reordered
## Feature: Quality Gates

### SCENARIO-013: Typecheck is strict-clean and the full test suite is green

- **Acceptance Criteria**: AC-08
- **Priority**: critical

**Given** the repository on the ^0.82.1 type surface
**When** the typecheck and the full test suite (existing plus new) are run
**Then** typecheck is strict-clean and every test passes
## Feature: Non-Goals and Boundary Preservation

### SCENARIO-014: The isolation boundary is preserved unless the user explicitly opts in

- **Acceptance Criteria**: AC-09
- **Priority**: critical

**Given** the opt-in is not explicitly set
**When** any specialist is spawned through either backend
**Then** current isolation and determinism behavior is unchanged byte-for-byte
### SCENARIO-015: Unchanged subsystems and output contracts remain untouched

- **Acceptance Criteria**: AC-09
- **Priority**: high

**Given** the change is applied
**When** the diff is reviewed
**Then** the safety factory, the inherited model object path, the control-flow node algebra, the resume cache, and the pipeline stage structure are all untouched
**And** every existing no-throw best-effort guard is preserved
**And** print, json, rpc, and headless output remain zero-ANSI byte-clean
### SCENARIO-016: A malformed opt-in degrades cleanly to the OFF behavior rather than erroring

- **Acceptance Criteria**: AC-09
- **Priority**: medium

**Given** the opt-in is set to a malformed or garbage value
**When** a specialist is spawned through either backend
**Then** the no-throw best-effort guard treats the value as OFF and the specialist behaves identically to the isolated default
---

## Traceability

- **AC-01**: Exported inheritExtensions() helper returns true only for truthy tokens (1/true/yes/on, case-insensitive, trimmed) and false otherwise → SCENARIO-001, SCENARIO-002, SCENARIO-003
- **AC-02**: Subprocess buildSpawnArgs guard becomes (!browser && !inheritExtensions()); OFF byte-identical, ON omits suppression → SCENARIO-004, SCENARIO-005, SCENARIO-006
- **AC-03**: Session DefaultResourceLoader uses noExtensions: !inheritExtensions(); safety factory unchanged → SCENARIO-007, SCENARIO-008
- **AC-04**: Browser-agent behavior unchanged in both opt-in states → SCENARIO-006
- **AC-05**: Trade-off comments present at both wiring points → SCENARIO-009
- **AC-06**: Focused tests for subprocess flag presence and inheritExtensions() parsing → SCENARIO-010, SCENARIO-011
- **AC-07**: [Unreleased] Added bold-bullet entry with anchor; changelog contract test stays green → SCENARIO-012
- **AC-08**: npm run typecheck strict-clean; full npm test green → SCENARIO-013
- **AC-09**: Non-goals honored: default OFF, untouched subsystems, preserved guards and zero-ANSI contract → SCENARIO-014, SCENARIO-015, SCENARIO-016

## Coverage Summary

- **Total Acceptance Criteria**: 9
- **Covered by Scenarios**: 9
- **Uncovered**: 0
- **Total Scenarios**: 16
