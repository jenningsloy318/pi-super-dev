# Implementation Plan: Runtime Instruction Replanning

1. Import `userNotesForAgent` into `implementationStage`.
2. Add `runtimeInstructionFingerprint()` helper.
3. At implementation start, compare prior/current fingerprints and invalidation flag.
4. Clear carried `phaseStatus` and `lastFailures` when runtime instructions invalidate the prior carry.
5. At implementation end, detect instruction changes during the pass and force `allGreen=false` for one more convergence pass.
6. Add convergence-loop regression test that simulates a user note arriving during phase 1 and verifies the next pass reruns phase 1 and phase 2.
7. Run typecheck and targeted tests.
