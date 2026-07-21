# Behavior Scenarios: Git Change-Tracker Cross-Check Gate

- **Date**: 2026-07-21
- **Author**: super-dev:bdd-scenario-writer
- **Source**: /home/jenningsl/development/personal/jenningsloy318/pi-super-dev/.worktree/11-git-change-tracker-crosscheck-gate/docs/specifications/11-git-change-tracker-crosscheck-gate/01-requirements.md
- **Total Scenarios**: 20

---
## Feature: ChangeTracker Module — baseline, delta, cross-check, durable file

### SCENARIO-001: Baseline captured when a stage or phase begins

- **Acceptance Criteria**: AC-01
- **Priority**: high

**Given** A change tracker initialized for a worktree under version control
**When** tracking begins for a unit (a stage or a phase)
**Then** the current git revision and the working-tree state are captured as the baseline for that unit
**And** And that baseline is held pending until the unit ends
### SCENARIO-002: Actual changes are computed and classified at unit end

- **Acceptance Criteria**: AC-01
- **Priority**: high

**Given** A unit whose baseline was captured at its start
**When** the unit ends along with the set of file changes the agent claimed
**Then** the set of files actually changed since the baseline is computed from git
**And** And each changed file is classified as created, modified, or deleted
**And** And committed changes and uncommitted or untracked changes are both included
### SCENARIO-003: Cross-check separates vacuous claims from unreported edits

- **Acceptance Criteria**: AC-01
- **Priority**: high

**Given** A unit ends with a structured set of claimed file changes
**When** the claimed set is cross-checked against what git shows
**Then** files the unit claimed to change but that git shows unchanged are flagged as claimed-but-not-changed
**And** And files git shows changed that the unit did not report are flagged as changed-but-not-claimed
### SCENARIO-004: Every event is appended to a single durable tracking file

- **Acceptance Criteria**: AC-01
- **Priority**: high

**Given** A run that has produced several begin and end events
**When** each event is recorded
**Then** one line is appended per event to a single durable file located in the spec directory
**And** And no previously written line is ever overwritten or lost
**And** And each end record carries the actual changes, the claimed changes, the cross-check flags, and a verdict
## Feature: Never-Throw Resilience — git unavailable and ambiguous parses

### SCENARIO-005: Git unavailability is recorded without aborting the run

- **Acceptance Criteria**: AC-02
- **Priority**: critical

**Given** A worktree where git is not available or a git command fails
**When** the tracker attempts a snapshot
**Then** the tracker records that git is unavailable
**And** And the run continues without throwing
**And** And the phase is not blocked by the infrastructure failure
### SCENARIO-006: Ambiguous parse resolved conservatively

- **Acceptance Criteria**: AC-02
- **Priority**: medium

**Given** A claimed file whose git status cannot be clearly resolved
**When** the cross-check classifies the claim
**Then** the claim is treated as not-changed only when git clearly shows no change
**And** And no false failure is introduced by parsing ambiguity
### SCENARIO-007: Begin and end events bracket a unit completely

- **Acceptance Criteria**: AC-03
- **Priority**: medium

**Given** A unit that has a captured baseline
**When** the unit ends
**Then** a start record and an end record are both present in the tracking file
**And** And multiple end events across a run each append their own line without collision
## Feature: Stage and Phase Bracketing — every stage, nested phases

### SCENARIO-008: Every stage produces a start and an end record

- **Acceptance Criteria**: AC-04
- **Priority**: high

**Given** A pipeline composed of several stages
**When** the pipeline runs
**Then** each stage contributes a stage-start record followed by a stage-end record in the tracking file
### SCENARIO-009: Implementation phases are nested inside their stage records in order

- **Acceptance Criteria**: AC-04
- **Priority**: high

**Given** An implementation stage that executes several phases
**When** the stage runs
**Then** phase-start and phase-end records appear nested between the stage-start and stage-end records in the correct order
**And** And each phase bracket wraps its attempt loop
### SCENARIO-010: Tracker state is scoped to a single run

- **Acceptance Criteria**: AC-05
- **Priority**: medium

**Given** A tracker established as a per-run singleton at run entry using the spec directory and worktree path
**When** the run ends
**Then** the tracker is cleared
**And** And no tracking state leaks into a subsequent run
## Feature: Structured Change Reporting — claimed create/modify/delete

### SCENARIO-011: Code-mutating agents report created, modified, and deleted files

- **Acceptance Criteria**: AC-06
- **Priority**: high

**Given** An implementer or review/fix agent that changes files
**When** the agent reports its changes
**Then** it reports separate sets of created, modified, and deleted files
**And** And the report is flagged as subject to git cross-check
**And** And claiming a file the agent did not change is stated to fail the phase
### SCENARIO-012: Legacy flat change list is still accepted

- **Acceptance Criteria**: AC-06
- **Priority**: medium

**Given** An agent that returns only a legacy flat list of modified files
**When** the structured set is parsed
**Then** the legacy list is accepted and normalized without error
**And** And the run does not regress for agents that have not adopted the structured contract
## Feature: Git Cross-Check Gate — false-green killer

### SCENARIO-013: Phase stays not-green when a claimed file was never changed

- **Acceptance Criteria**: AC-08
- **Priority**: critical

**Given** A phase whose agent claimed to create or modify a file that was never created or wired
**When** git shows that file was not changed
**Then** the change gate fails
**And** And the phase is not green even when the build gate and deliverable check both pass
**And** And the historical false-green where a phase claims a file that never exists becomes impossible
### SCENARIO-014: Unreported edits never fail a phase

- **Acceptance Criteria**: AC-07
- **Priority**: high

**Given** A phase where git shows edits the agent did not report
**When** the cross-check runs
**Then** the unreported edits are logged as advisory only
**And** And the change gate is not failed by under-reporting
### SCENARIO-015: Missing claimed changes trigger a targeted retry within budget

- **Acceptance Criteria**: AC-07
- **Priority**: high

**Given** A phase that failed the change gate because of claimed-but-not-changed files
**When** the phase retries
**Then** the missing files are surfaced to the next attempt as changes that must actually be created or wired
**And** And the retry respects the maximum attempt count
### SCENARIO-016: Phase with no claimed changes passes the gate trivially

- **Acceptance Criteria**: AC-07
- **Priority**: low

**Given** A phase that claims no created or modified files
**When** the change gate is evaluated
**Then** the gate passes without blocking
### SCENARIO-017: Gate does not block when git infrastructure is unavailable

- **Acceptance Criteria**: AC-07
- **Priority**: high

**Given** A phase evaluated where git is unavailable
**When** the change gate is computed
**Then** the gate passes so the phase is not blocked by infrastructure failure
**And** And the gate never throws
## Feature: Deliverable Assertion Bridge — tracking reinforces spec-10

### SCENARIO-018: Claimed created files are enforced as required deliverables

- **Acceptance Criteria**: AC-09
- **Priority**: high

**Given** A phase that claims to have created a set of files
**When** the deliverable check is prepared
**Then** the claimed created files are unioned with any spec-declared required files
**And** And each claimed created file must exist or the deliverable check fails
### SCENARIO-019: Actual changes are surfaced as concise run evidence

- **Acceptance Criteria**: AC-10
- **Priority**: medium

**Given** A phase whose end record captured the real git changes
**When** the run produces its summary
**Then** a concise count of created, modified, and deleted files is surfaced as evidence
**And** And the existing summary consumers continue to work from the structured set
## Feature: Quality and Non-Regression — typecheck, tests, theme parity

### SCENARIO-020: Typecheck and the full suite remain green with no regressions

- **Acceptance Criteria**: AC-11
- **Priority**: critical

**Given** The repository after the change tracker is integrated
**When** the typecheck and the full test suite run
**Then** the typecheck is clean and every test passes
**And** And the red check, deliverable check, npm in-scope classification, themed stream, mid-run input, dashboard, and theme-parity behaviors do not regress
**And** And the pi Theme methods are called method-style and never destructured
---

## Traceability

- **AC-01**: ChangeTracker: begin snapshots baseline; end computes git delta (committed UNION uncommitted), classifies created/modified/deleted, cross-checks vs claimed into claimedNotChanged/changedNotClaimed, appends one jsonl line; reuses spawnSync + dedupePreservingOrder git-union patterns. → SCENARIO-001, SCENARIO-002, SCENARIO-003, SCENARIO-004
- **AC-02**: Never-throws: every git op try/caught; git failure records {gitUnavailable:true} and returns a non-blocking record; conservative parse treats a claim as not-changed only when git clearly shows no change. → SCENARIO-005, SCENARIO-006
- **AC-03**: Unit tests (mocked git) cover classification, claimedNotChanged vs changedNotClaimed, git-unavailable record-and-continue, begin/end bracketing emits start+end records, append-only jsonl. → SCENARIO-004, SCENARIO-005, SCENARIO-007
- **AC-04**: All stages bracketed (stage start+end); implementation phases additionally bracketed (phase start+end) via minimal-touch event/runner seam; nested order asserted by a synthetic-pipeline test. → SCENARIO-008, SCENARIO-009
- **AC-05**: Tracker threaded via one consistent module-level per-run singleton mirroring activeRun, set at execute() entry from state.setup, cleared in finally; no leak between runs. → SCENARIO-010
- **AC-06**: buildImplementPrompt + review/fix prompt change output contract to filesCreated/filesModified/filesDeleted with git-cross-check instruction; implementation.ts parses the structured set but tolerates legacy flat filesModified. → SCENARIO-011, SCENARIO-012
- **AC-07**: changeGate computed after build+deliverable gates: pass===false iff claimedNotChanged non-empty; changedNotClaimed advisory-only; failures fed into retry via existing channel respecting MAX_ATTEMPTS; git-unavailable -> pass=true; never throws. → SCENARIO-014, SCENARIO-015, SCENARIO-016, SCENARIO-017
- **AC-08**: Regression test: phase claiming filesCreated:[X] where git shows no new file -> changeGate.pass===false -> phase not green even if build and deliverable pass; false-green impossible. → SCENARIO-013
- **AC-09**: Before runDeliverableCheck, claimed.filesCreated is unioned with spec-declared deliverables.requireFiles so a claimed-created file must exist. → SCENARIO-018
- **AC-10**: Phase end-record gitActual surfaced as a 'N files changed (C/M/D)' summary line; flat filesModified accumulation derived from the structured set so existing summary writer keeps working. → SCENARIO-019
- **AC-11**: npm run typecheck clean; npm test all green (existing + new); no regression to runRedCheck, runDeliverableCheck, npm in-scope, scope-aware cargo gate, themed stream, mid-run input, dashboard, real-theme parity; pi Theme called method-style, never destructured. → SCENARIO-020

## Coverage Summary

- **Total Acceptance Criteria**: 11
- **Covered by Scenarios**: 11
- **Uncovered**: 0
- **Total Scenarios**: 20
