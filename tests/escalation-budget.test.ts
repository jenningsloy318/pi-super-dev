/**
 * Escalation budget scoping (F-3) — the per-blocker retry budget must be keyed by
 * (kind, stage), not kind alone. Two structurally distinct fatal gates both use
 * kind "gate-exhaustion"; keying by kind alone let the first gate's retries starve
 * the second gate's escalation entirely.
 */
import { describe, it, expect } from "vitest";
import { escalationBudgetRemaining, runEscalation, ESCALATION_RETRY_CAP } from "../src/escalation.ts";
import type { EscalationFailure, PipelineState } from "../src/types.ts";

const failure = (stage: string): EscalationFailure => ({ kind: "gate-exhaustion", stage, message: `blocked at ${stage}` });

describe("escalation budget is scoped per (kind, stage)", () => {
	it("starts at ESCALATION_RETRY_CAP for each distinct stage", () => {
		const state = {} as PipelineState;
		expect(escalationBudgetRemaining(state, failure("requirements"))).toBe(ESCALATION_RETRY_CAP);
		expect(escalationBudgetRemaining(state, failure("spec"))).toBe(ESCALATION_RETRY_CAP);
	});

	it("charging one stage does NOT deplete another stage's budget (F-3)", async () => {
		const state = {} as PipelineState;
		const escalate = async () => ({ choice: "retry-with-guidance" as const });
		// Exhaust the requirements-gate budget entirely.
		for (let i = 0; i < ESCALATION_RETRY_CAP; i++) {
			await runEscalation(state, failure("requirements"), escalate);
		}
		expect(escalationBudgetRemaining(state, failure("requirements"))).toBe(0);
		// The spec gate must still have its full budget — previously it was starved.
		expect(escalationBudgetRemaining(state, failure("spec"))).toBe(ESCALATION_RETRY_CAP);
		const decision = await runEscalation(state, failure("spec"), escalate);
		expect(decision).toBeDefined();
	});

	it("does not invoke escalate once a stage's budget is exhausted", async () => {
		const state = {} as PipelineState;
		let calls = 0;
		const escalate = async () => { calls++; return { choice: "abandon" as const }; };
		for (let i = 0; i < ESCALATION_RETRY_CAP + 2; i++) {
			await runEscalation(state, failure("spec"), escalate);
		}
		expect(calls).toBe(ESCALATION_RETRY_CAP); // capped, not called after exhaustion
	});
});
