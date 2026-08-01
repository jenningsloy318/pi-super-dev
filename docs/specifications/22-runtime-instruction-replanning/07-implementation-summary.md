# Implementation Summary: Runtime Instruction Replanning

## Implemented

- Added `runtimeInstructionFingerprint()` in `src/stages/implementation.ts`.
- Stage 9 now records runtime instruction fingerprint in implementation control.
- If accumulated runtime instructions differ from the prior implementation control, carried green phases are invalidated and rerun.
- If runtime instructions arrive during an implementation pass, the stage forces `allGreen=false` and marks `invalidatedByRuntimeInstructions=true`, causing the outer convergence loop to rerun all phases with the new instructions visible from phase 1.

## Tests

Updated `tests/implementation-convergence-loop.test.ts`:

- Existing no-change behavior still skips previously green phases.
- New regression simulates a runtime note arriving during phase 1, verifies the first pass is invalidated, and verifies the next pass reruns phase 1 and phase 2.
- Added regression for the subtle case where the note is drained by the implementation-summary spawn after all phase work; this now still invalidates the pass.

## Validation

Passed:

```bash
npm run typecheck
npm test -- tests/implementation-convergence-loop.test.ts tests/setup.test.ts
```

Result: 2 test files, 11 tests passed.
