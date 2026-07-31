# Specification: Silent-Failure Hardening

## Goals

- Eliminate false-green success paths in implementation, review, integration, and final summary reporting.
- Make every failure mode visible to both the LLM and the user.
- Preserve tolerant pipeline behavior where useful, but derive final status from actual gate evidence.
- Keep changes deterministic and unit-testable.

## Requirements

### AC-01 Review output fail-closed

If code-reviewer or adversarial-reviewer fails, times out, omits structured output, returns an empty object, or returns no verdict, Stage 10 MUST NOT treat that reviewer as approved.

Expected outcome:
- Stage task returns a synthetic review control with `verdict: "Changes Requested"`.
- Synthetic finding explains the missing/failed review.
- `merge-review-verdicts` defaults missing/invalid reviews to non-approved.
- Adversarial `PASS|CONTEST|REJECT` verdicts are normalized to approved/changes/blocking semantics.

### AC-02 Build gates affect loops and final status

The review loop MUST only exit successfully when review is approved and deterministic build gate is green.

The integration loop MUST only pass when integration tests, review, and build gate are green.

Final `RunSummary.status` MUST be `partial` or `failed` when any known hard gate failed (`buildGate`, `preMergeBuild`, or `integration`) or merge was required but not confirmed.

### AC-03 Tool execution failure uses Pi contract

The `super_dev` custom tool MUST throw for fatal tool-level failures instead of returning a non-standard `isError` field.

### AC-04 Implementation no-op skip is resume-only and verified

A fresh run MUST NOT skip a phase just because declared files/patterns already exist.

An explicit resume run MAY skip a phase only if:
- deliverables are already present,
- deterministic build gate passes or in-scope passes,
- full deliverable check passes.

When skipped, phase status MUST be marked green.

### AC-05 Agent budget is hard-enforced

Before any specialist spawn, the workflow MUST check `maxAgents`. If exhausted, it must fail visibly and not spawn another agent.

Task-level budget exhaustion MUST be recorded as failed, not skipped.

### AC-06 Integration testing cannot pass vacuously

Stage 11 MUST track expected API/UI roles per attempt.

A role expected by bringup MUST produce a fresh passing test control in the same attempt. Missing/skipped expected tests count as failure.

No detected API/UI roles MUST be reported as explicit `notApplicable`, not as a pass based on missing test objects.

### AC-07 `skipStages` is honored

Leaf tasks MUST honor `RunOptions.skipStages` by matching:
- stage id (`codeReview`, `requirements`, etc.),
- full stage label,
- leading stage number from labels like `Stage 10a — Code Review`.

Stage 1/setup MUST remain non-skippable.

## Non-goals

- Do not port `super-dev.workflow.js`.
- Do not implement the entire ready-plugin tracking JSON oracle in this patch.
- Do not add visual-verifier stage in this patch; that is a larger feature parity gap.

## Acceptance tests

- Missing review output merges to `Changes Requested` with findings.
- Adversarial `PASS` maps to approved; `REJECT` maps to blocking.
- Final workflow status is partial for missing review, failed pre-merge build, or failed integration.
- Fresh implementation does not no-op skip existing deliverables.
- Resume no-op skip verifies and marks green.
- `maxAgents=0` rejects the first agent spawn.
- `skipStages` skips matched leaf tasks.
- Integration helper requires fresh expected API/UI pass results and is false when no roles exist.
