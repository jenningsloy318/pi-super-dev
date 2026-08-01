# Code Assessment: Runtime Instruction Replanning

## Files assessed

- `src/stages/implementation.ts`
- `src/render/user-notes.ts`
- `src/workflow.ts`
- `tests/implementation-convergence-loop.test.ts`

## Existing behavior

`implementationStage` carries `phaseStatus` and `lastFailures` from `state.implementation`. Green phases are skipped on later convergence passes to avoid churn.

`workflow.ts` persists runtime user instructions at each agent boundary and `userNotesForAgent()` injects accumulated notes into prompts.

## Gap

There is no link between changed runtime user instructions and the `phaseStatus` carry. Therefore green phases can remain skipped even though the requirement surface changed after they ran.

## Fix seam

Use `userNotesForAgent(specDirectory)` as the canonical accumulated runtime instruction text. Compute a stable fingerprint before and after implementation stage execution.

- Previous fingerprint differs from current fingerprint → clear carried phase status and failures.
- Fingerprint changes during the stage → return `allGreen=false` and mark invalidation.

## Risk

This can rerun more work than strictly necessary. That is acceptable for now because it is safer than shipping a backend/frontend contract mismatch. A future impact analyzer can narrow reruns to affected phases.
