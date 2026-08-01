# Requirements: Runtime Instruction Replanning

## Problem

A user may add a requirement while super-dev is already executing. The current runtime-note path injects the note into future specialist prompts, but already-green implementation phases can be skipped by the convergence carry. If a late requirement affects backend/API design and an earlier backend phase is already green, only later frontend phases may incorporate the change.

Observed failure mode: a late requirement changed filters to dropdown-backed multi-select filters. The frontend moved toward multi-select UX, but backend contracts/filter handling remained single-value because earlier backend phases were already complete.

## Acceptance Criteria

- **AC-01 Detect changed runtime instructions**: Stage 9 implementation records a fingerprint of accumulated runtime user instructions.
- **AC-02 Invalidate stale phase carry**: If runtime instructions changed since the previous implementation control, previously-green phase carry is cleared and phases rerun.
- **AC-03 Mid-implementation changes trigger another pass**: If runtime instructions arrive during an implementation pass, the pass returns `allGreen=false` even if build/deliverable gates pass, forcing the outer convergence loop to re-enter with the new instructions visible from phase 1.
- **AC-04 Avoid infinite reruns**: If no further runtime instructions arrive on the next pass, the stage can return `allGreen=true` normally.
- **AC-05 Preserve existing convergence**: Without runtime instruction changes, already-green phases still skip on later convergence passes.
