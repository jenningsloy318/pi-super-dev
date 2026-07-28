/**
 * Phase 1 — escalation primitive types (spec-18 / AC-01 → SCENARIO-001, SCENARIO-002).
 *
 * The types in `src/types.ts` are pure additions with NO runtime behavior, so
 * this file exercises them as: (a) compile-time shapes (the import + `expectTypeOf`
 * assertions prove the exact field/union shape), and (b) runtime construction
 * (proves objects carrying the types hold the intended closed set of values).
 *
 * Coverage matrix:
 *   - SCENARIO-001 / AC-01 — `EscalationFailure` carries rich, live blocker
 *     context (kind/stage/message/specDirectory/worktreePath/findings/severity).
 *   - SCENARIO-002 / AC-01 — `EscalationChoice` is a CLOSED set of exactly the
 *     four recovery actions; a retry-with-guidance decision may carry guidance.
 *   - P1.T2 / AC-01 — `RunOptions.escalate?: Escalate` is reachable as
 *     `ctx.options.escalate` with ZERO edits to src/workflow.ts, because
 *     `StageContext.options` IS `RunOptions`.
 *   - Escalate is async, never-throws-by-contract (returns `EscalationDecision | undefined`).
 */

import { describe, it, expect, expectTypeOf } from "vitest";

import type {
	EscalationKind,
	EscalationSeverity,
	EscalationFinding,
	EscalationFailure,
	EscalationChoice,
	EscalationDecision,
	Escalate,
	RunOptions,
	StageContext,
} from "../src/types.ts";

// ── SCENARIO-001 / AC-01 — EscalationFailure carries rich, live context ─────

describe("EscalationFailure — rich live blocker context (SCENARIO-001 / AC-01)", () => {
	it("accepts a fully-populated failure carrying every rich-context field", () => {
		const failure: EscalationFailure = {
			kind: "gate-exhaustion",
			stage: "build-gate",
			message: "Build gate exhausted 3 attempts",
			specDirectory: "/tmp/spec-18",
			worktreePath: "/tmp/worktree",
			findings: [
				{ file: "src/a.ts", severity: "high", title: "type error" },
				{ file: null, severity: null, title: null },
			],
			severity: "hard",
		};
		expect(failure.kind).toBe("gate-exhaustion");
		expect(failure.stage).toBe("build-gate");
		expect(failure.message.length).toBeGreaterThan(0);
		expect(failure.specDirectory).toBe("/tmp/spec-18");
		expect(failure.worktreePath).toBe("/tmp/worktree");
		expect(failure.findings).toHaveLength(2);
		expect(failure.severity).toBe("hard");
	});

	it("accepts a minimal stagnation failure (only the required kind+message)", () => {
		const failure: EscalationFailure = {
			kind: "stagnation",
			message: "Review loop is stuck",
		};
		expect(failure.kind).toBe("stagnation");
		expect(failure.findings).toBeUndefined();
		expect(failure.severity).toBeUndefined();
	});

	it("kind is exactly the three documented blocker kinds", () => {
		const kinds: EscalationKind[] = ["stagnation", "gate-exhaustion", "design-conflict"];
		expect(kinds).toHaveLength(3);
		expect(new Set(kinds).size).toBe(3);
	});

	it("severity is exactly soft | hard", () => {
		const severities: EscalationSeverity[] = ["soft", "hard"];
		expect(severities).toEqual(["soft", "hard"]);
	});

	// Compile-time shape: every optional field has the right type.
	expectTypeOf<EscalationFailure>().toMatchTypeOf<{
		kind: EscalationKind;
		message: string;
		stage?: string;
		specDirectory?: string;
		worktreePath?: string;
		findings?: EscalationFinding[];
		severity?: EscalationSeverity;
	}>();
});

// ── SCENARIO-002 / AC-01 — closed decision set + optional guidance ──────────

describe("EscalationDecision / EscalationChoice — closed set (SCENARIO-002 / AC-01)", () => {
	it("choice is EXACTLY the four documented recovery actions (closed set)", () => {
		const choices: EscalationChoice[] = [
			"retry-with-guidance",
			"revise-manually",
			"accept-limitation",
			"abandon",
		];
		expect(choices).toHaveLength(4);
		expect(new Set(choices).size).toBe(4);
	});

	it("a retry-with-guidance decision MAY carry free-text guidance", () => {
		const decision: EscalationDecision = {
			choice: "retry-with-guidance",
			guidance: "Fix the off-by-one in parseLine before retrying.",
		};
		expect(decision.choice).toBe("retry-with-guidance");
		expect(typeof decision.guidance).toBe("string");
	});

	it("a non-retry decision carries no guidance (guidance is optional)", () => {
		const abandon: EscalationDecision = { choice: "abandon" };
		const revise: EscalationDecision = { choice: "revise-manually" };
		expect(abandon.guidance).toBeUndefined();
		expect(revise.guidance).toBeUndefined();
	});

	it("every choice value constructs a valid EscalationDecision", () => {
		const decisions: EscalationDecision[] = [
			{ choice: "retry-with-guidance" },
			{ choice: "revise-manually" },
			{ choice: "accept-limitation" },
			{ choice: "abandon" },
		];
		expect(decisions.map((d) => d.choice)).toEqual([
			"retry-with-guidance",
			"revise-manually",
			"accept-limitation",
			"abandon",
		]);
	});
});

// ── P1.T2 / AC-01 — RunOptions.escalate reachable as ctx.options.escalate ────

describe("RunOptions.escalate — reachable as ctx.options.escalate (P1.T2 / AC-01)", () => {
	it("RunOptions accepts an optional escalate callback", () => {
		const cb: Escalate = async () => ({ choice: "abandon" });
		const options: RunOptions = { escalate: cb };
		expect(typeof options.escalate).toBe("function");
	});

	it("RunOptions.escalate may be omitted (additive — byte-identical baseline)", () => {
		const options: RunOptions = {};
		expect(options.escalate).toBeUndefined();
	});

	it("escalate is an async function returning EscalationDecision | undefined", async () => {
		const cb: Escalate = async (failure) => {
			// Proves the impl receives the failure payload.
			expect(failure.kind).toBe("stagnation");
			return { choice: "retry-with-guidance", guidance: "retry hint" };
		};
		const decision = await cb({ kind: "stagnation", message: "stuck" });
		expect(decision?.choice).toBe("retry-with-guidance");

		const dismissive: Escalate = async () => undefined;
		expect(await dismissive({ kind: "gate-exhaustion", message: "x" })).toBeUndefined();
	});

	// The crux of P1.T2: ctx.options IS RunOptions, so escalate is reachable
	// with NO workflow.ts edit. Asserted purely at the type level.
	expectTypeOf<StageContext["options"]>().toEqualTypeOf<RunOptions>();
	expectTypeOf<StageContext["options"]["escalate"]>().toEqualTypeOf<Escalate | undefined>();
});
