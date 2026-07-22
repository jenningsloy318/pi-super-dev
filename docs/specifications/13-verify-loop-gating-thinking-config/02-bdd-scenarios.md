# Behavior Scenarios: Verify-Loop Gating & Per-Agent Thinking Configuration

- **Date**: 2026-07-22
- **Author**: super-dev:bdd-scenario-writer
- **Source**: ./docs/specifications/13-verify-loop-gating-thinking-config/01-requirements.md
- **Total Scenarios**: 29

---
## Feature: Stage 11 Integration Loop Stagnation Detection (GAP A)

### SCENARIO-001: Integration loop detects oscillation when the same failing signature repeats

- **Acceptance Criteria**: AC-01
- **Priority**: high

**Given** the integration loop is retrying against a set of test failures that produces a stable, non-empty failure signature
**When** the same failure signature recurs on two consecutive rounds
**Then** the loop breaks early before reaching its round cap
**And** a stagnation record is captured describing the rounds, the failing signature, and a bounded list of failures
**And** a non-fatal diagnostic message is logged
**And** the pipeline continues without aborting
### SCENARIO-002: Integration loop continues while failures keep changing

- **Acceptance Criteria**: AC-01
- **Priority**: medium

**Given** the integration loop is retrying and each round yields a different set of test failures
**When** no failure signature repeats across consecutive rounds
**Then** the loop continues retrying up to its unchanged maximum round cap
**And** no premature stagnation record is set
### SCENARIO-003: Integration loop ignores empty signatures for stagnation

- **Acceptance Criteria**: AC-01
- **Priority**: medium

**Given** the integration loop observes no test failures on consecutive rounds, producing an empty failure signature
**When** the empty signature repeats
**Then** the loop does not treat repeated empty signatures as stagnation
**And** the maximum round cap remains unchanged and is respected
### SCENARIO-004: Stagnation failure list is bounded

- **Acceptance Criteria**: AC-01
- **Priority**: low

**Given** the integration loop reaches stagnation while a very large number of test failures are present
**When** the stagnation record is captured
**Then** the recorded list of failures is bounded to a limited number of entries
**And** the recorded signature still reflects the full sorted failure set
## Feature: Stage 10 Review Loop Build-Gate Gating (GAP B)

### SCENARIO-005: Review loop exits successfully when approved and build is green

- **Acceptance Criteria**: AC-02
- **Priority**: high

**Given** the review has been approved and the deterministic build gate reports green
**When** the review loop evaluates its exit condition
**Then** the loop terminates successfully
**And** the pipeline advances to the downstream merge gate
### SCENARIO-006: Review loop keeps looping when approved but build is red

- **Acceptance Criteria**: AC-02
- **Priority**: high

**Given** the review has been approved but the deterministic build gate reports red
**When** the review loop evaluates its exit condition
**Then** the loop does not terminate on approval alone
**And** the loop continues retrying until stagnation or the maximum round cap is reached
### SCENARIO-007: Review loop exits non-fatally when stagnant regardless of build state

- **Acceptance Criteria**: AC-02
- **Priority**: high

**Given** the review loop has detected stagnation while the build gate is still red
**When** the loop evaluates its exit condition
**Then** the loop short-circuits and exits without aborting the pipeline
**And** the exit is treated as non-fatal
### SCENARIO-008: Review loop exhaustion remains non-fatal

- **Acceptance Criteria**: AC-02
- **Priority**: medium

**Given** the review loop remains approved-with-red-build or unresolved across all rounds
**When** the loop reaches its maximum round cap
**Then** the loop exits without throwing
**And** the pipeline continues in a tolerant manner
## Feature: Count-Based Convergence Trigger (GAP C)

### SCENARIO-009: Stagnation triggers when finding count does not decrease

- **Acceptance Criteria**: AC-03
- **Priority**: high

**Given** a review or integration loop where the finding count stays the same across two consecutive rounds
**When** the count is observed to be non-decreasing (for example five findings then five findings)
**Then** the loop is treated as stagnant
**And** the loop exits non-fatally
### SCENARIO-010: Stagnation triggers on scope drift when finding count expands

- **Acceptance Criteria**: AC-03
- **Priority**: medium

**Given** a loop where the finding count increases across consecutive rounds
**When** the count grows (for example five findings then six findings)
**Then** the loop is treated as stagnant due to non-decreasing count
### SCENARIO-011: Genuine convergence does not trigger stagnation

- **Acceptance Criteria**: AC-03
- **Priority**: high

**Given** a loop where the finding count steadily decreases across rounds (five then three then one)
**When** the count is evaluated for stagnation
**Then** the loop is not treated as stagnant
**And** the loop is allowed to continue converging
### SCENARIO-012: Identical-signature trigger still applies alongside count trigger

- **Acceptance Criteria**: AC-03
- **Priority**: medium

**Given** a loop where the finding signature is byte-identical across two consecutive rounds
**When** either the identical-signature condition or the non-decreasing-count condition is met
**Then** the loop is treated as stagnant
## Feature: Terminal Re-Review at Exhaustion (GAP D)

### SCENARIO-013: Final re-review runs after review-loop exhaustion

- **Acceptance Criteria**: AC-04
- **Priority**: high

**Given** the Stage 10 review loop exits due to reaching its maximum round cap rather than by approval or stagnation
**When** the loop concludes
**Then** exactly one final review step runs so the review state reflects the latest fixed code
**And** no additional fix step is performed
**And** the downstream merge gate reads the refreshed review state
### SCENARIO-014: No final re-review when loop exits by approval or stagnation

- **Acceptance Criteria**: AC-04
- **Priority**: medium

**Given** the review loop exits because it was approved or because stagnation was detected
**When** the loop concludes
**Then** no additional terminal re-review is performed
### SCENARIO-015: Final re-review respects the remaining budget

- **Acceptance Criteria**: AC-04
- **Priority**: medium

**Given** the review loop exits by exhaustion but the available budget is depleted
**When** the terminal re-review is considered
**Then** the re-review is skipped or gated by the budget check
**And** the step remains non-fatal and never aborts the pipeline
## Feature: Per-Agent Thinking Level Mapping (THINKING CONFIG)

### SCENARIO-016: Reasoning-heavy agents map to high thinking

- **Acceptance Criteria**: AC-05
- **Priority**: high

**Given** an agent classified as reasoning-heavy such as design, spec-writer, adversarial-reviewer, code-reviewer, debugger, or assessment
**When** the thinking level for the agent is resolved
**Then** the resolved level is high
### SCENARIO-017: Implementation agents map to medium thinking

- **Acceptance Criteria**: AC-05
- **Priority**: medium

**Given** an implementation-oriented agent such as implementer or tdd-guide
**When** the thinking level for the agent is resolved
**Then** the resolved level is medium
### SCENARIO-018: Mechanical agents map to minimal or off thinking

- **Acceptance Criteria**: AC-05
- **Priority**: medium

**Given** a mechanical agent such as commit, slug summarizer, or cleanup
**When** the thinking level for the agent is resolved
**Then** the resolved level is minimal or off
### SCENARIO-019: Unclassified agents fall back to a sane default

- **Acceptance Criteria**: AC-05
- **Priority**: medium

**Given** an agent not matching any specific role classification
**When** the thinking level for the agent is resolved
**Then** the resolved level is the sane default (medium)
## Feature: Thinking Level Override Precedence (THINKING CONFIG)

### SCENARIO-020: Per-call thinking override takes highest precedence

- **Acceptance Criteria**: AC-06
- **Priority**: high

**Given** an agent call that specifies an explicit per-call thinking level while an environment override and a role default also exist
**When** the effective thinking level is resolved
**Then** the per-call thinking level is used
### SCENARIO-021: Environment override takes precedence over role default

- **Acceptance Criteria**: AC-06
- **Priority**: high

**Given** the global thinking environment override is set and no per-call override is provided
**When** the effective thinking level is resolved
**Then** the environment override level is used instead of the role default
### SCENARIO-022: Role default applies when no overrides are present

- **Acceptance Criteria**: AC-06
- **Priority**: medium

**Given** neither a per-call override nor an environment override is provided
**When** the effective thinking level is resolved
**Then** the role-based default level for the agent is used
## Feature: Thinking Level Backend Application (THINKING CONFIG)

### SCENARIO-023: Subprocess backend passes the resolved thinking level

- **Acceptance Criteria**: AC-07
- **Priority**: high

**Given** an agent is spawned via the subprocess backend with a resolved thinking level
**When** the spawn arguments are constructed
**Then** the arguments include the thinking flag set to the resolved level
### SCENARIO-024: Session backend applies the thinking level best-effort

- **Acceptance Criteria**: AC-07
- **Priority**: high

**Given** an agent is run via the session backend with a threaded thinking level
**When** the agent session has been created and before prompting
**Then** the session thinking level is set using the resolved level
### SCENARIO-025: Session backend tolerates missing or clamped thinking support

- **Acceptance Criteria**: AC-07
- **Priority**: high

**Given** a session backend runtime that lacks the thinking-level method or clamps the level to model capability
**When** the thinking level is applied
**Then** the failure is swallowed and the agent proceeds to prompting without aborting
**And** the set-thinking-level call is wrapped so any error is non-fatal
## Feature: Verification & Safety (Cross-Cutting)

### SCENARIO-026: Strict type check passes with zero errors

- **Acceptance Criteria**: AC-08
- **Priority**: high

**Given** the completed implementation under TypeScript strict mode
**When** the type checker is run
**Then** compilation completes with zero errors
### SCENARIO-027: All existing and new tests pass

- **Acceptance Criteria**: AC-08
- **Priority**: high

**Given** the completed implementation with new unit tests added
**When** the test suite is run
**Then** all previously passing tests plus the new tests pass green
### SCENARIO-028: New loop-exit paths never abort the pipeline

- **Acceptance Criteria**: AC-08
- **Priority**: high

**Given** any of the newly added stagnation, exhaustion, terminal re-review, or thinking-config paths
**When** an exit or error condition is reached
**Then** the path completes non-fatally without throwing to abort the tolerant pipeline
### SCENARIO-029: Unrelated runtime artifacts are left untouched

- **Acceptance Criteria**: AC-08
- **Priority**: medium

**Given** the change set for the verify-loop and thinking-config work
**When** the changes are applied
**Then** unrelated runtime artifacts such as change-tracker records are not modified
**And** the repository's heavy explanatory-comment convention is preserved
---

## Traceability

- **AC-01**: GAP A: Stage 11 integration loop stagnation/oscillation detection with bounded record and non-fatal log. → SCENARIO-001, SCENARIO-002, SCENARIO-003, SCENARIO-004
- **AC-02**: GAP B: Stage 10 review loop exits only when approved AND build-green; stagnation and exhaustion stay non-fatal. → SCENARIO-005, SCENARIO-006, SCENARIO-007, SCENARIO-008
- **AC-03**: GAP C: non-decreasing finding/failure count triggers stagnation in addition to identical-signature; convergence does not. → SCENARIO-009, SCENARIO-010, SCENARIO-011, SCENARIO-012
- **AC-04**: GAP D: one final re-review at exhaustion, no extra fix, budget-checked, non-fatal. → SCENARIO-013, SCENARIO-014, SCENARIO-015
- **AC-05**: Thinking config role mapping to thinking levels. → SCENARIO-016, SCENARIO-017, SCENARIO-018, SCENARIO-019
- **AC-06**: Thinking config override precedence: per-call > env > role default. → SCENARIO-020, SCENARIO-021, SCENARIO-022
- **AC-07**: Thinking config backends: subprocess flag and session best-effort set. → SCENARIO-023, SCENARIO-024, SCENARIO-025
- **AC-08**: Verification & safety: type check, tests, non-fatal paths, untouched artifacts. → SCENARIO-026, SCENARIO-027, SCENARIO-028, SCENARIO-029

## Coverage Summary

- **Total Acceptance Criteria**: 8
- **Covered by Scenarios**: 8
- **Uncovered**: 0
- **Total Scenarios**: 29
