# Implementation Plan: Silent-Failure Hardening

## Phase 1 — Review fail-closed

1. Add review-control validation in `src/stages/verify.ts`.
2. Convert review agent errors/missing controls to synthetic `Changes Requested` controls.
3. Harden `merge-review-verdicts` in `src/helpers.ts`.
4. Add helper tests for missing/invalid review output and adversarial verdict mapping.

## Phase 2 — Build and final status gates

1. Update Stage 10 loop exit predicate to require review approval plus build green.
2. Make review fix path run when a previous build gate failed.
3. Update Stage 11 success checks to require build green.
4. Update `runWorkflow()` status derivation for hard-gate failures and missing review.
5. Add workflow status regression tests.

## Phase 3 — Pi tool error contract

1. Replace returned `isError` fields with thrown errors in `src/extension.ts` for fatal failures.
2. Keep partial summaries as normal returns with explicit partial status in content/details.

## Phase 4 — Implementation no-op safety

1. Restrict no-op skip to explicit resume runs.
2. Verify resume no-op with build gate and full deliverable check.
3. Mark verified skipped phase green and clear prior failures.
4. Add fresh/resume no-op regression tests.

## Phase 5 — Budget and skipStages

1. Enforce `maxAgents` centrally in `workflow.ts` before every spawn.
2. Treat task-start budget exhaustion as failed.
3. Add `skipStages` support in `task(stage)` for id/label/stage-number matching.
4. Add budget and skip tests.

## Phase 6 — Integration attempt state

1. Record expected API/UI integration roles in bringup.
2. Clear API/UI/service/expected-role state before each integration attempt.
3. Require a fresh pass for every expected role.
4. Mark no detected surface as explicit `integration.notApplicable`.
5. Mark skipped expected service tests as failed test controls.
6. Add integration helper tests.

## Phase 7 — Validate

1. Run typecheck.
2. Run targeted regression tests.
3. Run full test suite and document any unrelated fixture/environment failures.
