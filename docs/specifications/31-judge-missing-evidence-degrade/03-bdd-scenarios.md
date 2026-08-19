# BDD Scenarios — Judge missing-evidence degrade

Feature: The RED no-progress diagnostic judge must actuate a sound
`re-author-tests` / `fix-environment` diagnosis even when the judge attached no
machine-verifiable evidence, while still discarding fabricated or malformed
evidence.

---

SCENARIO-001: re-author-tests with empty evidence routes (does not discard)
  Given the judge returns route="re-author-tests" with evidence=[]
    And the wiring point offers ["re-author-tests"]
    And confidence >= 0.6
  When runJudge verifies the verdict
  Then the outcome status is "routed"
    And the verdict route is "re-author-tests"
    And the audit line documents the INV-2 missing-evidence exemption

SCENARIO-002: fix-environment with empty evidence routes (does not discard)
  Given the judge returns route="fix-environment" with evidence=[]
    And the wiring point offers ["fix-environment"]
    And confidence >= 0.6
  When runJudge verifies the verdict
  Then the outcome status is "routed"
    And the verdict route is "fix-environment"

SCENARIO-003: fabricated quote on re-author-tests still discards
  Given the judge returns route="re-author-tests" with one evidence item whose
        quote does not byte-occur in the file or captured outputs
  When runJudge verifies the verdict
  Then the outcome status is "discarded"
    And the fabrication guard is unchanged

SCENARIO-004: malformed (all-empty) evidence on re-author-tests still discards
  Given the judge returns route="re-author-tests" with evidence=[{file:"",quote:""}]
  When runJudge verifies the verdict
  Then the outcome status is "discarded"
    And the discard reason mentions "malformed"

SCENARIO-005: challenge-test with empty evidence still discards (not exempt)
  Given the judge returns route="challenge-test" with evidence=[]
    And the wiring point offers ["challenge-test"]
  When runJudge verifies the verdict
  Then the outcome status is "discarded"

SCENARIO-006: below-confidence exempt route still escalates
  Given the judge returns route="re-author-tests" with evidence=[] and confidence 0.3
    And the wiring point offers ["re-author-tests"]
  When runJudge verifies the verdict
  Then the outcome status is "escalate"
    And the escalated route is "escalate-now"

SCENARIO-007: escalate-now empty-evidence degrade unchanged (regression guard)
  Given the judge returns route="escalate-now" with evidence=[]
  When runJudge verifies the verdict
  Then the outcome status is "escalate"
