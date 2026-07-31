# Implementation Summary: Silent-Failure Hardening

## Implemented fixes

- Review failures now fail closed in `src/stages/verify.ts`.
  - Reviewer agent errors, missing control objects, and missing verdicts become synthetic `Changes Requested` reviews.
  - Synthetic high-severity findings make the failure visible to the review/fix loop.

- Review verdict merging now fails closed in `src/helpers.ts`.
  - Missing/empty/invalid review sources no longer default to `Approved`.
  - Adversarial `PASS`, `CONTEST`, and `REJECT` are normalized into the existing review verdict ordering.

- Build and integration gates now affect loop exits and final status.
  - Stage 10 exits only when review is approved and build gate is green.
  - Stage 11 success requires integration tests, review approval, and build gate success.
  - `runWorkflow()` now reports partial/failed when known hard gates fail, review is missing, integration fails, or merge was expected but not confirmed.

- Pi tool failure signaling now follows the documented contract.
  - `super_dev` throws on empty tasks and fatal pipeline failures instead of returning non-standard `isError` fields.

- Implementation no-op skips are now safe.
  - Fresh runs no longer skip phases just because deliverables already exist.
  - Resume no-op skips run build + deliverable verification and mark phase status green only on success.

- Agent budget is hard-enforced.
  - `workflow.ts` checks `maxAgents` before every agent spawn.
  - Task-start budget exhaustion is a failed task, not a skipped task.

- Integration testing is no longer vacuous.
  - Bringup records expected API/UI roles.
  - Each integration attempt clears stale API/UI state.
  - Expected roles must produce fresh passing test controls.
  - No detected surface is explicit `integration.notApplicable`.

- `skipStages` is now honored for leaf tasks.
  - Supports stage id, full label, and leading stage number parsed from labels.
  - Setup remains non-skippable.

## Tests added/updated

- `tests/helpers.test.ts`
- `tests/workflow.test.ts`
- `tests/nodes.test.ts`
- `tests/verify.test.ts`
- `tests/workflow-feedback.test.ts`
- `src/stages/implementation.test.ts`

## Validation

- `npm run typecheck` passes.
- Targeted regression suite passes (7 files, 85 tests):
  - `tests/helpers.test.ts`
  - `tests/nodes.test.ts`
  - `tests/verify.test.ts`
  - `tests/workflow.test.ts`
  - `tests/workflow-feedback.test.ts`
  - `src/stages/implementation.test.ts`
  - `tests/lifecycle.test.ts`

Full `npm test` status: all non-fixture tests passed, but `tests/render.test.ts` has 4 pre-existing environment-specific failures because it references absent absolute stockfan fixture paths under `/home/jenningsl/...`.
