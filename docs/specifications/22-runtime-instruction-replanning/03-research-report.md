# Research Report: Runtime Instruction Replanning

## Inputs

- Failed run log: `/Users/I336589/.pi/agent/super-dev/runs/2026-08-01T05-46-39-633Z/run.log`
- Stage 9 implementation loop in `src/stages/implementation.ts`
- Runtime-note injection path in `src/workflow.ts` and `src/render/user-notes.ts`

## Findings

The failed run completed only 3/4 implementation phases. The immediate terminal failure was phase 4 deliverables, but the user-reported design issue was deeper: a requirement change added during execution affected the backend/frontend contract, yet the pipeline only applied it where future prompts happened to see it.

Existing implementation convergence intentionally skips phases already marked green in prior passes. That is normally correct, but it becomes stale when runtime user instructions change the requirements after some phases have completed. A late multi-select filter requirement can require backend query params, service filters, route tests, and UI changes; if backend phases are already green, the pipeline may not revisit them.

## Decision

Treat runtime instruction changes as an implementation-plan invalidation signal. The implementation stage records a fingerprint of accumulated runtime notes. If notes change during a run or differ from the prior control, the stage forces another convergence pass and clears previous green phase carry on the next pass.

This is conservative but correct: late requirements can affect any phase, so all phases must be reconsidered unless/until the pipeline has a richer impact analyzer.
