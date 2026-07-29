# Behavior Scenarios: HITL Escalation — Pause, Ask, and Continue on Unrecoverable Blockers

- **Date**: 2026-07-28
- **Author**: super-dev:bdd-scenario-writer
- **Source**: /home/jenningsl/development/personal/jenningsloy318/pi-super-dev/.worktree/18-hitl-escalation-pause-continue/docs/specifications/18-hitl-escalation-pause-continue/01-requirements.md
- **Total Scenarios**: 25

---
## Feature: Escalation Callback Contract & Threading

### SCENARIO-001: Escalation carries rich, live blocker context

- **Acceptance Criteria**: AC-01
- **Priority**: high

**Given** a running pipeline that has reached an unrecoverable blocker
**When** the pipeline escalates the blocker to the user
**Then** the escalation carries the blocker kind (stagnation, gate exhaustion, or design conflict), the originating stage, a human-readable message, and the current specification and worktree locations
**And** the run context is still live at the moment of escalation, before any abort loses it
**And** the escalation callback is reachable from every node and stage of the pipeline
### SCENARIO-002: User decisions form a closed set with optional guidance

- **Acceptance Criteria**: AC-01
- **Priority**: high

**Given** an escalated blocker presented to the user
**When** the user responds
**Then** the response is exactly one of retry-with-guidance, revise-manually, accept-limitation, or abandon
**And** a retry-with-guidance response may carry free-text guidance
### SCENARIO-003: A dismissed or timed-out prompt yields no decision and never throws

- **Acceptance Criteria**: AC-02
- **Priority**: high

**Given** an interactive escalation prompt presented to the user
**When** the user dismisses the prompt or it times out
**Then** the escalation resolves to no decision
**And** the pipeline never throws as a result of the dismissal or timeout
**And** a prompt carries a bounded timeout so a forgotten prompt cannot hang the run
## Feature: Fatal-Gate Exhaustion Firing Point

### SCENARIO-004: A fatal gate pauses to ask the user before abandoning

- **Acceptance Criteria**: AC-03
- **Priority**: high

**Given** a fatal gate that has exhausted its attempts
**When** an escalation callback is available
**Then** the pipeline pauses to ask the user before abandoning the run
**And** the user's decision governs whether the run continues or aborts
### SCENARIO-005: A retry decision re-runs the fatal gate inline

- **Acceptance Criteria**: AC-03
- **Priority**: medium

**Given** a fatal gate paused for escalation
**When** the user chooses to retry
**Then** the gate is retried inline rather than aborting
**And** the retried gate is evaluated fresh rather than served from a prior cached result
### SCENARIO-006: Without an escalation callback, a fatal gate aborts as before

- **Acceptance Criteria**: AC-03
- **Priority**: medium

**Given** a fatal gate that has exhausted its attempts
**When** no escalation callback is available
**Then** the run aborts exactly as it did before escalation was introduced
## Feature: Verify-Loop Stagnation Firing Point

### SCENARIO-007: Verify-loop stagnation pauses the run inline

- **Acceptance Criteria**: AC-04
- **Priority**: high

**Given** a verify loop that has stagnated
**When** stagnation is detected
**Then** the pipeline pauses inline to ask how to proceed
**And** a retry decision lets the loop continue rather than break
**And** the stagnation findings are conveyed with the escalation
### SCENARIO-008: Test-loop stagnation pauses the run the same way

- **Acceptance Criteria**: AC-04
- **Priority**: medium

**Given** an integration loop that has stagnated on tests
**When** test stagnation is detected
**Then** the pipeline pauses inline to ask how to proceed
**And** both stagnation points behave consistently
### SCENARIO-009: A stagnation with no decision breaks the loop as before

- **Acceptance Criteria**: AC-04
- **Priority**: medium

**Given** a stagnated verify loop paused for escalation
**When** the escalation yields no decision
**Then** the loop breaks as it did before escalation was introduced
## Feature: Recovery — Retry With Guidance

### SCENARIO-010: A retry-with-guidance decision rolls back, records guidance, and resumes

- **Acceptance Criteria**: AC-05
- **Priority**: high

**Given** an escalated blocker the user chose to retry with guidance
**When** the pipeline acts on the decision
**Then** the in-progress work is rolled back, the guidance is recorded for the specialist, and the failed stage is retried inline
**And** the rollback is strictly confined to the super-dev worktree and never touches the user's main checkout
**And** the run continues inline rather than aborting and requiring a re-run
### SCENARIO-011: Recorded guidance shapes the next specialist attempt

- **Acceptance Criteria**: AC-05
- **Priority**: medium

**Given** guidance recorded from a retry decision
**When** the failed stage is retried
**Then** the specialist receives the guidance as part of its next attempt
**And** the persisted guidance is bounded so the specialist prompt cannot be overwhelmed
### SCENARIO-012: A rollback or guidance-write failure still allows a retry

- **Acceptance Criteria**: AC-05
- **Priority**: medium

**Given** a retry-with-guidance decision whose rollback or guidance write fails
**When** the pipeline acts on the decision
**Then** the failed stage is still retried
**And** the failure is reported rather than crashing the run
## Feature: Recovery — Revise, Accept, and Abandon

### SCENARIO-013: A revise-manually decision ends the run cleanly with instructions

- **Acceptance Criteria**: AC-06
- **Priority**: medium

**Given** an escalated blocker the user chose to revise manually
**When** the pipeline acts on the decision
**Then** the run ends as a clean partial run
**And** the report tells the user exactly what to change
### SCENARIO-014: An accept-limitation decision records the limitation and continues, only for soft blocks

- **Acceptance Criteria**: AC-06
- **Priority**: medium

**Given** an escalated soft blocker the user chose to accept as a limitation
**When** the pipeline acts on the decision
**Then** the limitation is recorded and the run continues past it
**And** this choice is offered only for soft blocks and never for hard build failures
### SCENARIO-015: An abandon decision aborts the run

- **Acceptance Criteria**: AC-06
- **Priority**: medium

**Given** an escalated blocker the user chose to abandon
**When** the pipeline acts on the decision
**Then** the run aborts and is recorded as failed
**And** the user's choice is the single source of which recovery branch runs
## Feature: Escalation Report & Observability

### SCENARIO-016: Every escalation produces a durable report

- **Acceptance Criteria**: AC-07
- **Priority**: high

**Given** an escalation handled in any mode
**When** the escalation is processed
**Then** a durable report describing the blocker and the user's decision is written to the specification directory
**And** every escalation also surfaces an audit log line
**And** the report includes the prior stagnation report body where applicable
### SCENARIO-017: A non-interactive escalation still reports and then fails as before

- **Acceptance Criteria**: AC-07
- **Priority**: medium

**Given** a non-interactive escalation that yields no decision
**When** the escalation is processed
**Then** the report is still written and the run proceeds to fail exactly as it did before
**And** interactive escalation is strictly additive to today's behavior
## Feature: Default-On and No-Prompt in Automation

### SCENARIO-018: An interactive session escalates by default

- **Acceptance Criteria**: AC-08
- **Priority**: high

**Given** an interactive session in which the user interface is available
**When** an unrecoverable blocker is reached
**Then** the run pauses for a decision by default
**And** no opt-in configuration is required to get a pause in an interactive session
### SCENARIO-019: A non-interactive session never blocks on a decision

- **Acceptance Criteria**: AC-08
- **Priority**: high

**Given** a print, JSON, headless, RPC-headless, or automation run
**When** an unrecoverable blocker is reached
**Then** the run never blocks on a decision prompt
**And** the run falls back to the report-and-fail path
**And** no new prompt can fire in automation, test, or headless modes
## Feature: Bounded Retry

### SCENARIO-020: Retry-with-guidance is capped

- **Acceptance Criteria**: AC-09
- **Priority**: high

**Given** repeated retry-with-guidance decisions for the same blocker
**When** the escalation-retry cap is reached
**Then** no further retries are attempted for that blocker
**And** the run cannot loop indefinitely
**And** the run cannot spend unbounded specialist-agent budget
### SCENARIO-021: After the cap, the run falls back to revise or abandon

- **Acceptance Criteria**: AC-09
- **Priority**: medium

**Given** the escalation-retry cap reached for a blocker
**When** the run would otherwise retry again
**Then** the run falls back to revise-manually or abandon
## Feature: No-Throw / Best-Effort Resilience

### SCENARIO-022: Any escalation-path failure degrades to fail-with-report

- **Acceptance Criteria**: AC-10
- **Priority**: high

**Given** any step of the escalation path that can fail
**When** that step fails
**Then** the run degrades to fail-with-report
**And** the escalation callback, the rollback, and the report-write are each individually protected
### SCENARIO-023: Specific misbehaviors cannot crash the run

- **Acceptance Criteria**: AC-10
- **Priority**: medium

**Given** a misbehaving prompt, a missing or non-git worktree, or a report write failure
**When** that misbehavior occurs during escalation
**Then** the run continues to degrade gracefully and is not aborted by the misbehavior
## Feature: Tests & Build

### SCENARIO-024: The escalation behavior is covered by focused tests

- **Acceptance Criteria**: AC-11
- **Priority**: high

**Given** the escalation contract and recovery wiring
**When** the focused tests run
**Then** the callback contract, the rollback-then-retry wiring, the default-on guard, the bounded-retry fallback, and the no-throw behavior are each exercised
**And** interactive and headless escalation paths are both covered
### SCENARIO-025: The build stays green with a changelog entry

- **Acceptance Criteria**: AC-12
- **Priority**: medium

**Given** the escalation feature implemented
**When** the project is built and tested
**Then** the strict typecheck passes and the full test suite is green
**And** a concise changelog entry records the added capability under the unreleased additions
---

## Traceability

- **AC-01**: EscalationFailure / EscalationDecision / Escalate types and RunOptions.escalate threading → SCENARIO-001, SCENARIO-002
- **AC-02**: extension.ts supplies escalate; ctx.ui.select/input guarded by ctx.hasUI, try/catch, never throws → SCENARIO-003
- **AC-03**: Fatal-gate exhaustion fires escalate inline before FatalAbort → SCENARIO-004, SCENARIO-005, SCENARIO-006
- **AC-04**: Verify-loop stagnation fires escalate inline so the loop can continue → SCENARIO-007, SCENARIO-008, SCENARIO-009
- **AC-05**: retry-with-guidance: rollback + appendUserNotes + inline retry; guidance flows via drain → SCENARIO-010, SCENARIO-011, SCENARIO-012
- **AC-06**: revise-manually / accept-limitation / abandon recovery branches; choice is single source → SCENARIO-013, SCENARIO-014, SCENARIO-015
- **AC-07**: escalation-report.md always written; non-interactive proceeds to fail as today (additive) → SCENARIO-016, SCENARIO-017
- **AC-08**: Default-on for interactive; print/json/rpc-headless/headless never block → SCENARIO-018, SCENARIO-019
- **AC-09**: Bounded escalation-retry cap prevents infinite loops / unbounded spend → SCENARIO-020, SCENARIO-021
- **AC-10**: No-throw / best-effort across callback, rollback, and report-write → SCENARIO-022, SCENARIO-023
- **AC-11**: Focused tests: contract, rollback-then-retry, default-on guard, bounded retry, no-throw → SCENARIO-024
- **AC-12**: Strict typecheck clean; full test suite green; concise CHANGELOG [Unreleased] ### Added entry → SCENARIO-025

## Coverage Summary

- **Total Acceptance Criteria**: 12
- **Covered by Scenarios**: 12
- **Uncovered**: 0
- **Total Scenarios**: 25
