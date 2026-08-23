/**
 * Stage 6C — Prototype (conditional + loop).
 * Self-contained task: only runs when the design declares numeric constants
 * (decided by check-prototype-needed); loops until a PASS verdict, repeated
 * no-progress evidence, the round cap, or global budget exhaustion.
 *
 * Postmortem 0001 case 3 (run 2026-08-16T06-06-20, 28+ rounds): the loop's
 * only semantic exit compared the RAW verdict string against exact lowercase
 * "pass" while the model emitted PASS-with-prose, PROTOTYPE_COMPLETE,
 * _WITH_CAVEATS, _SKIPPED… 28 rounds, none equal — the actor announced
 * "TERMINAL" at round 23 while the harness kept re-asking, until budget death.
 * Termination semantics contradicted action semantics, the same genus as the
 * RED-loop deadlock.
 *
 * The fix is three independent layers (any one alone stops the runaway):
 *   1. SOURCE: PrototypeData.verdict is a closed enum (pass|fail) reaching
 *      structured_output, so conforming models cannot drift;
 *   2. BOUNDARY: normalizePrototypeVerdict maps the real-world vocabulary
 *      (observed corpus pinned in tests) to pass|fail|unknown;
 *   3. LIVENESS: a hard MAX_PROTOTYPE_ROUNDS cap plus a prose-free
 *      no-progress signature — no unmatched string can ever be the only exit.
 */

import type { ControlObj, Stage } from "../types.ts";
import { buildPrototypePrompt } from "../prompts.ts";
import { renderAndWrite } from "../render/render.ts";
import { STAGE_MODELS } from "../render/schemas.ts";

const pad = (n: number) => String(n).padStart(2, "0");

/** Liveness floor (same convention as MAX_CONVERGENCE_ROUNDS): no prototype
 *  loop may run unboundedly, whatever the verdict vocabulary does. */
export const MAX_PROTOTYPE_ROUNDS = 6;

const FAIL_PREFIXES = ["FAIL", "PROTOTYPE_FAILED", "FAILED", "REJECT", "REJECTED", "INCOMPLETE", "ABORT"];
const PASS_PREFIXES = ["PASS", "PROTOTYPE_COMPLETE", "COMPLETE", "COMPLETED", "PROTOTYPE_SKIPPED", "SUCCESS"];

/**
 * Boundary normalization (conservative cascade — exact vocabulary first, then
 * word-level; NEVER fuzzy). PROTOTYPE_SKIPPED counts as pass: it is the agent's
 * "skip-clean, proceed" recommendation and the stage already gated on
 * check-prototype-needed; the report carries the rationale to spec. Unknown
 * returns "unknown" — the loop retries with evidence, bounded by the cap.
 */
export function normalizePrototypeVerdict(verdict: unknown): "pass" | "fail" | "unknown" {
	const v = String(verdict ?? "").trim();
	if (!v) return "unknown";
	const upper = v.toUpperCase();
	// Prefix wins: the verdict WORD leads the field, and the observed corpus has
	// pass-leading verdicts whose PROSE mentions a documented FAIL artifact
	// (round 2 of the runaway run). Word-level fallback applies only to
	// unprefixed strings; the round cap bounds any misread either way.
	for (const p of FAIL_PREFIXES) if (upper.startsWith(p)) return "fail";
	for (const p of PASS_PREFIXES) if (upper.startsWith(p)) return "pass";
	if (/\bFAIL(ED)?\b/.test(upper)) return "fail";
	if (/\b(PASS|COMPLETE|SUCCESS)\b/.test(upper)) return "pass";
	return "unknown";
}

function prototypeSignature(control: ControlObj | null): string {
	if (!control) return "no-control";
	const c = control as Record<string, unknown>;
	// Deliberately NO summary: prose changes every round (round numbers, temp
	// file names) and masked the no-progress signal for 28 rounds. The signature
	// is the normalized verdict plus the sorted measurement/adjustment facts.
	return JSON.stringify({
		verdict: normalizePrototypeVerdict(c.verdict),
		measurements: Array.isArray(c.measurements) ? c.measurements.map((v) => String(v)).sort() : [],
		adjustments: Array.isArray(c.adjustments) ? c.adjustments.map((v) => String(v)).sort() : [],
	});
}

export const prototypeStage: Stage = {
	id: "prototype",
	label: "Stage 6C — Prototype",
	async run(state, ctx) {
		const design = state.design ?? null;
		if (!design) return null;
		const check = await ctx.helper({ name: "check-prototype-needed", sources: { design } });
		if (!check.value.needed) {
			ctx.log("Prototype not needed — no numeric constants to validate");
			return null;
		}
		const constants = (check.value.constants as string[]) ?? [];
		const setup = state.setup!;
		let last: ControlObj | null = null;
		const signatures: string[] = [];
		for (let round = 1; ctx.budget.check(); round++) {
			if (round > MAX_PROTOTYPE_ROUNDS) {
				ctx.log(`Prototype stopped at the round cap (${MAX_PROTOTYPE_ROUNDS}) — verdict ${last ? normalizePrototypeVerdict(last.verdict) : "none"}; the report stands as evidence for the spec stage`);
				break;
			}
			const result = await ctx.agent({
				id: `pipeline.prototype.r${pad(round)}`,
				agent: "prototype-runner",
				accessMode: "source-read-only",
				prompt: buildPrototypePrompt(setup, state.classify ?? null, ctx.task, design, constants, round, last),
				schema: STAGE_MODELS["prototype"]?.schema,
			});
			renderAndWrite(setup, (m) => ctx.log(m), "prototype", result.control as Record<string, unknown> | null);
			last = result.control ?? null;
			const kind = normalizePrototypeVerdict(last?.verdict);
			if (kind === "pass") {
				ctx.log(`Prototype validation PASS on round ${round}`);
				return last;
			}
			const signature = prototypeSignature(last);
			const noProgress = signatures[signatures.length - 1] === signature;
			signatures.push(signature);
			ctx.log(`Prototype round ${round}: verdict=${String(last?.verdict ?? "unknown")} (normalized: ${kind})`);
			if (noProgress) {
				ctx.log(`Prototype stopped after repeated no-progress evidence on round ${round}`);
				break;
			}
		}
		if (!ctx.budget.check()) ctx.log("Prototype stopped because the global agent budget was exhausted");
		return last;
	},
};
