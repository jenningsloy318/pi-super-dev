# BDD Scenarios — v0.2.8 no-nonexistent-references

SCENARIO-001: replan-upstream is a closed-set judge route
  Given the JUDGE_ROUTES closed set
  Then it contains "replan-upstream"

SCENARIO-002: replan-upstream requires evidence (not missing-evidence-exempt)
  Given the judge returns route="replan-upstream" with evidence=[]
    And the wiring point offers ["replan-upstream"]
  When runJudge verifies the verdict
  Then the outcome status is "discarded" (the fabrication/consequence guard holds)

SCENARIO-003: an evidence-backed replan-upstream routes
  Given the judge returns route="replan-upstream" with one verbatim-quoted evidence item
    And the wiring point offers ["replan-upstream"] and confidence >= 0.6
  When runJudge verifies the verdict
  Then the outcome status is "routed" with route "replan-upstream"

SCENARIO-004: red-no-progress offers replan-upstream and actuates it
  Given a phase whose RED loop hits the no-progress ceiling
    And the judge routes "replan-upstream" with a grounded diagnosis
  When the red-no-progress handler runs
  Then it attempts the replan circuit (triggerReplanForFindings) for the owning stage
    And when the finding is not routable it falls through to HITL (never throws)

SCENARIO-005: the judge prompt glosses replan-upstream
  Given buildJudgePrompt offered ["replan-upstream"]
  Then the rendered prompt contains a one-line gloss for replan-upstream

SCENARIO-006: writer prompts carry existence/traceability discipline
  Given buildRequirementsPrompt / buildBddPrompt / buildSpecPrompt
  Then requirements forbids asserting a non-existent existing-code baseline
    And bdd forbids minting an AC absent from requirements
    And spec forbids referencing a non-existent scenario/AC/code entity
