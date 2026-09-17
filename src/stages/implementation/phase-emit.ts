/**
 * Stage 9 — the per-phase step/status emission toolkit (extracted from
 * stage.ts at v0.4.27).
 *
 * Every phase of the §D convergence walk owns one of these: it renders the
 * phase row (level 2) and its step rows (level 3) on the dashboard, and — via
 * runInStepScope — pins the attribution of every line emitted by that step's
 * async chain so pipelined steps (v0.3.58) cannot steal each other's cursor.
 *
 * A factory rather than plain module functions because two pieces of state are
 * per-phase mutable: the lifecycle-started flag (announceActivity fires the
 * running row once) and the step sequence counter. The counter is shared with
 * the two manual step sites (the TDD RED window and the implementer window),
 * which call nextStepSeq() so their level-3 rows sequence with runStep's.
 */
import type { StageContext } from "../../types.ts";
import { runInStepScope } from "../../step-scope.ts";
import { pad } from "./red-evidence.ts";

export interface PhaseStatusKit {
	emitPhaseStatus: (status: "running" | "ok" | "failed" | "skipped" | "partial") => void;
	ensurePhaseRunning: () => void;
	announceActivity: (activity?: string, detail?: string) => void;
	emitStep: (label: string, status: "running" | "ok" | "failed", seq: number) => void;
	runStep: <T>(label: string, detail: string | undefined, okIf: (r: T) => boolean, fn: () => Promise<T>) => Promise<T>;
	inStepScope: <T>(seq: number, stepLabel: string, fn: () => Promise<T>) => Promise<T>;
	attemptDetail: (attempt: number, extra?: string) => string;
	nextStepSeq: () => number;
}

export function createPhaseStatusKit(
	ctx: StageContext,
	phase: { phaseId: string; phaseLabel: string; phaseHeadline: string },
): PhaseStatusKit {
	const { phaseId, phaseLabel, phaseHeadline } = phase;
			let phaseLifecycleStarted = false;
			const emitPhaseStatus = (status: "running" | "ok" | "failed" | "skipped" | "partial") => {
				ctx.events.emit("stage", {
					id: `implementation.${phaseId}`,
					label: phaseLabel,
					status,
					kind: "phase",
					parentId: "implementation",
				});
			};
			const ensurePhaseRunning = () => {
				if (phaseLifecycleStarted) return;
				phaseLifecycleStarted = true;
				emitPhaseStatus("running");
			};
			const announceActivity = (activity?: string, detail?: string) => {
				const suffix = activity ? ` — ${activity}${detail ? ` (${detail})` : ""}` : "";
				ctx.phase(`${phaseHeadline}${suffix}`);
			};
			// Level-3 (step) dashboard rows: nested under the phase row so the
			// implementation stage shows stage → phase → step. Each step (and retry)
			// persists as its own row with its own ok/failed glyph (full audit trail).
			// `seq` disambiguates repeated step labels across attempts/retries so a new
			// row is emitted per occurrence rather than overwriting the prior one.
			let stepSeq = 0;
			const nextStepSeq = (): number => ++stepSeq;
			const emitStep = (label: string, status: "running" | "ok" | "failed", seq: number): void => {
				ctx.events.emit("stage", {
					id: `implementation.${phaseId}.step-${pad(seq)}`,
					label: `· ${label}`,
					status,
					kind: "step",
					parentId: `implementation.${phaseId}`,
				});
			};
			/** Announce + run a phase step: emits a running level-3 row, runs `fn`,
			 *  then marks the row ok/failed by `okIf(result)`. Returns fn's result.
			 *  v0.3.58 pipelining attribution: the ENTIRE step body (announce,
			 *  lifecycle events, agent calls, delegation child lines) runs inside
			 *  runInStepScope, so every line emitted by this step's async chain is
			 *  stamped with THIS step's identity — a concurrently-running step (F3
			 *  pipelined RED review vs implementer) no longer steals the other's
			 *  lines via the global stage cursor. The raw id (no occurrence suffix)
			 *  matches emitStep's id; the extension seam resolves the display id. */
			const runStep = async <T>(label: string, detail: string | undefined, okIf: (r: T) => boolean, fn: () => Promise<T>): Promise<T> => {
				const seq = ++stepSeq;
				const stepLabel = `${label}${detail ? ` (${detail})` : ""}`;
				return runInStepScope({ stageId: `implementation.${phaseId}.step-${pad(seq)}`, stageLabel: `· ${stepLabel}` }, async () => {
					announceActivity(label, detail);
					emitStep(stepLabel, "running", seq);
					try {
						const r = await fn();
						emitStep(stepLabel, okIf(r) ? "ok" : "failed", seq);
						return r;
					} catch (err) {
						emitStep(stepLabel, "failed", seq);
						throw err;
					}
				});
			};
			/** v0.3.59 review P1 (class fix): manual step sites attribute their
			 *  emissions per-chain with the SAME identity scheme as runStep — these
			 *  sites drive announce/terminal emitStep by hand (custom okIf logic),
			 *  but their async chains MUST carry the step scope or the pipelined
			 *  inverse leak persists (implementer lines landing in the RED review's
			 *  card once the review's terminal event moves the cursor back). */
			const inStepScope = <T>(seq: number, stepLabel: string, fn: () => Promise<T>): Promise<T> =>
				runInStepScope({ stageId: `implementation.${phaseId}.step-${pad(seq)}`, stageLabel: `· ${stepLabel}` }, fn);
			const attemptDetail = (attempt: number, extra?: string) =>
				[`attempt ${attempt}`, extra].filter(Boolean).join(", ");

	return {
		emitPhaseStatus,
		ensurePhaseRunning,
		announceActivity,
		emitStep,
		runStep,
		inStepScope,
		attemptDetail,
		nextStepSeq,
	};
}
