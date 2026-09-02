/**
 * Step-scope attribution (v0.3.58 — pipelined-step line grouping).
 *
 * Root cause this module fixes (live run 2026-09-02T00-12-23-714Z, phase-03):
 * with v0.3.43 pipelining the RED review step runs CONCURRENTLY with the
 * Implementation step. The live stream's stage cursor is a single mutable
 * "most recent stage event" register, so 21ms after the Implementation step
 * opens, every still-streaming RED-review line (the code-reviewer's tool
 * calls, its verdict control) is stamped with the Implementation step and
 * renders inside its card — the user-visible "why is Implementation running a
 * code-review agent?" confusion. The inverse leak also exists: after the
 * review's terminal event moves the cursor back, post-join implementation
 * lines would land in the review's card.
 *
 * Fix class: stage attribution must come from the EMITTING async chain, not
 * from a mutable cursor. Each implementation step wraps its whole body in
 * {@link runInStepScope}; every log/phase/text emission inside that chain
 * (agent activity, delegation child lines, gate diagnostics) reads the store
 * with {@link currentStepScope} and is stamped with its OWN step. AsyncLocalStorage
 * propagates across awaits and interleaving, so two concurrent steps keep
 * distinct stores with no cross-talk — exactly the concurrency checklist's
 * "attribute per chain, never per global" rule.
 *
 * The store carries the RAW step id (e.g. `implementation.phase-03.step-05`).
 * Occurrence resolution (the `#N` display suffix) happens at the extension
 * seam, which owns that state; see src/render/stage-occurrence.ts.
 */

import { AsyncLocalStorage } from "node:async_hooks";

/** Identity of the implementation step whose async chain is emitting. */
export type StepScopeInfo = {
	/** RAW step stage id (no occurrence suffix), matching the `stage` event
	 *  id emitted by the step's own `emitStep` call. */
	stageId: string;
	/** Human step label, matching the dashboard row label (e.g.
	 *  `· RED review (attempt 1, try 1)`). */
	stageLabel: string;
};

const storage = new AsyncLocalStorage<StepScopeInfo>();

/** Run `fn` with `info` as the step-attribution store for fn's ENTIRE async
 *  chain — every await, callback, and continuation keeps this store until the
 *  chain ends, regardless of other steps interleaving on the same event loop. */
export function runInStepScope<T>(info: StepScopeInfo, fn: () => T): T {
	return storage.run(info, fn);
}

/** The calling async chain's step scope, or `undefined` outside any step
 *  (convergence stages, the phase loop itself, engine setup — those keep the
 *  cursor-based stamping, which was always correct for serial stages). */
export function currentStepScope(): StepScopeInfo | undefined {
	return storage.getStore();
}
