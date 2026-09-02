/**
 * Step-stamp resolution for pipelined-step attribution (v0.3.58).
 *
 * Pure companion to src/step-scope.ts: given a step scope captured off the
 * emitting async chain, decide whether the emission can be attributed to its
 * own dashboard section. The guard is deliberately strict — attribution is
 * only safe while the step's occurrence row is actively RUNNING:
 *
 *   - unknown step id (event not yet arrived / foreign run) → undefined
 *   - row already terminal (lines emitted after the step ended — the F3 join
 *     site, engine gate verdicts) → undefined (cursor is authoritative there,
 *     and it points at the step that legitimately owns those lines)
 *
 * Everything else keeps the cursor stamp, so serial stages (convergence,
 * requirements → close-out) behave exactly as before.
 */

import type { StageStamp } from "./live-stream.js";

/**
 * Resolve a step-scoped emission to its dashboard section stamp.
 *
 * @param step            the emitting chain's step scope (raw, unsuffixed id)
 * @param activeDisplayId the occurrence-resolved display id currently ACTIVE
 *                        for the step's raw id (e.g. `…step-05` or `…step-05#2`),
 *                        or undefined when none is active
 * @param status          that active row's status, when known
 * @returns the stamp to apply, or undefined to fall back to the global cursor
 */
export function stepOccurrenceStamp(
	step: { stageId: string; stageLabel: string },
	activeDisplayId: string | undefined,
	status: string | undefined,
): StageStamp | undefined {
	if (!activeDisplayId || status !== "running") return undefined;
	return { stageId: activeDisplayId, stageLabel: step.stageLabel };
}
