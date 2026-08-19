# BDD Scenarios — v0.2.7 polish

SCENARIO-001: judge implementer-retry override does not duplicate ownDirt feedback
  Given foreign pre-phase dirt makes the classifier say environmental-blocker
    And the dirty-quarantine kill-switch is set (quarantine skipped → judge called)
    And the implementer wrote an undeclared out-of-scope edit this phase (ownDirt)
    And the judge routes "implementer-retry"
  When the implementer is re-spawned with the override feedback
  Then the retry prompt contains "out-of-scope edit (this run): <path>" exactly once
    And the retry prompt also contains the judge override diagnosis line

SCENARIO-002: product fall-through still names ownDirt exactly once (regression guard)
  Given a clean-at-start tree and an undeclared out-of-scope edit this phase
  When the failure classifies product (no judge) and the implementer retries
  Then the retry prompt contains "out-of-scope edit (this run): <path>" exactly once
