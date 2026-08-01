# BDD Scenarios: Runtime Instruction Replanning

## SCENARIO-001 — Existing behavior without new notes

Given phase 1 is green and phase 2 failed in a prior convergence pass
When implementation reruns with no runtime instruction changes
Then phase 1 is skipped
And phase 2 is retried.

## SCENARIO-002 — Runtime note arrives during implementation

Given phase 1 has already run in the current implementation pass
When a user runtime instruction is persisted before the pass finishes
Then the implementation stage reports `allGreen=false`
And marks the control as invalidated by runtime instructions.

## SCENARIO-003 — Next pass reruns earlier phases

Given the previous implementation control was invalidated by runtime instructions
When implementation runs again
Then previously-green phase carry is cleared
And phase 1 runs again with the accumulated runtime instruction available to prompts.

## SCENARIO-004 — No infinite loop

Given the invalidated pass has been rerun
And no new runtime instruction arrives during that rerun
Then implementation may return `allGreen=true`.
