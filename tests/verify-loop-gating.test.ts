/**
 * Phase 1 — Verify-loop gating (GAP A/B/C/D). RED tests: they drive the
 * exported Stage 10 predicates/nodes and the Stage 11 integration loop with
 * synthetic PipelineState + a stub StageContext (budget.check→true, no-op
 * agent, log capture). They must TYPECHECK against src/stages/verify.ts and
 * FAIL against the current (un-gated) behavior.
 *
 * GAP A: testFailuresSignature + Stage 11 test-failure stagnation (__testStagnated).
 * GAP B: reviewLoopUntil requires reviewApproved AND buildGreen to exit.
 * GAP C: non-decreasing finding/failure count triggers stagnation (both detectors).
 * GAP D: one final budget-checked reviewStep at Stage 10 max-rounds exhaustion.
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import {
	reviewLoopUntil,
	reviewStageNode,
	integrationLoopNode,
	testFailuresSignature,
} from "../src/stages/verify.ts";
import type { AgentCall, PipelineState, StageContext } from "../src/types.ts";

// ─── helpers ─────────────────────────────────────────────────────────────────

/** Minimal ctx for the pure `reviewLoopUntil` predicate (only ctx.log is read). */
const logCtx = (): StageContext =>
	({ log: () => {}, task: "", options: {}, state: {} as PipelineState } as unknown as StageContext);

/** Distinct review findings; `tag` guarantees a fresh file signature per round. */
const mkFindings = (n: number, tag: string) =>
	Array.from({ length: n }, (_, i) => ({ id: `${tag}-${i}`, severity: "high", title: "T", detail: "d", file: `${tag}-${i}.ts` }));

/** Full ctx for driving the review / integration NODES. Counts agent calls
 *  per role and returns a never-approved merged verdict so the loops iterate. */
function driveCtx(counts: Record<string, number>): StageContext {
	return {
		task: "",
		options: {},
		state: {} as PipelineState,
		async agent(call: AgentCall) {
			counts[call.agent] = (counts[call.agent] ?? 0) + 1;
			return { text: "", control: {} };
		},
		async helper() {
			return { value: { verdict: "Changes Requested", findings: [] } };
		},
		async parallel(calls: Array<() => Promise<unknown>>) {
			return Promise.all(calls.map((f) => f())) as never;
		},
		budget: { check: () => true },
		log: () => {},
		phase: () => {},
		events: new EventEmitter(),
		results: [],
	} as unknown as StageContext;
}

/** Fresh empty worktree so the deterministic build gate detects no commands. */
const tmpWorktree = () => {
	const dir = mkdtempSync(join(tmpdir(), "verify-gate-"));
	return { worktreePath: dir, specDirectory: dir } as unknown as PipelineState["setup"];
};

// ─── GAP A — test-failure signature + Stage 11 stagnation ─────────────────────

describe("GAP A — test-failure stagnation", () => {
	it("builds a stable, order-independent signature over api+ui failures", () => {
		const empty = { apiTest: { failures: [] }, uiTest: { failures: [] } } as unknown as PipelineState;
		expect(testFailuresSignature(empty)).toBe("");

		const a = {
			apiTest: { failures: [{ file: "a.spec.ts", title: "X" }, { file: "b.spec.ts", title: "Y" }] },
			uiTest: { failures: [{ file: "u.spec.ts", title: "Z" }] },
		} as unknown as PipelineState;
		const b = {
			apiTest: { failures: [{ file: "b.spec.ts", title: "Y" }, { file: "a.spec.ts", title: "X" }] },
			uiTest: { failures: [{ file: "u.spec.ts", title: "Z" }] },
		} as unknown as PipelineState;

		const sig = testFailuresSignature(a);
		expect(sig).not.toBe("");
		expect(testFailuresSignature(b)).toBe(sig); // order-independent
	});

	it("writes state.__testStagnated when the same failures repeat across rounds (non-fatal)", async () => {
		const counts: Record<string, number> = {};
		const ctx = driveCtx(counts);
		const state = {
			setup: tmpWorktree(),
			review: { verdict: "Changes Requested", findings: [] },
			// Pre-seeded: api-test step self-skips (no service) so this persists every round.
			apiTest: { pass: false, failures: [{ id: "e1", file: "a.spec.ts", title: "boom", message: "expected 200" }] },
		} as unknown as PipelineState;

		// Must never throw, even at exhaustion.
		await expect(integrationLoopNode.run(state, ctx)).resolves.toBeDefined();

		const stagnated = (state as Record<string, unknown>).__testStagnated as
			| { rounds: number; signature: string; failures: unknown[] }
			| undefined;
		expect(stagnated).toBeDefined();
		expect(stagnated!.signature).not.toBe("");
		expect(stagnated!.failures.length).toBeLessThanOrEqual(12);
	});
});

// ─── GAP B — review exit requires approval AND green build ────────────────────

describe("GAP B — build-gated Stage 10 exit", () => {
	it("exits (true) only when review approved AND build gate green", async () => {
		const green = { review: { verdict: "Approved", findings: [] }, buildGate: { pass: true } } as unknown as PipelineState;
		expect(await reviewLoopUntil(green, logCtx())).toBe(true);

		// Approved but build RED → must keep looping (false), not exit.
		const red = { review: { verdict: "Approved", findings: [] }, buildGate: { pass: false } } as unknown as PipelineState;
		expect(await reviewLoopUntil(red, logCtx())).toBe(false);
	});
});

// ─── GAP C — non-decreasing count stagnation (both detectors) ─────────────────

describe("GAP C — count-based stagnation", () => {
	it("treats a non-decreasing finding count as stagnant but lets converging runs proceed", async () => {
		// 5 → 5 (different files, same count) → stagnant on round 2.
		const s = { review: { verdict: "Changes Requested", findings: mkFindings(5, "r1") } } as unknown as PipelineState;
		expect(await reviewLoopUntil(s, logCtx())).toBe(false); // round 1: nothing to compare
		s.review = { verdict: "Changes Requested", findings: mkFindings(5, "r2") }; // fresh sig, count 5→5
		expect(await reviewLoopUntil(s, logCtx())).toBe(true);

		// 5 → 6 (scope drift) → also stagnant.
		const drift = { review: { verdict: "Changes Requested", findings: mkFindings(5, "d1") } } as unknown as PipelineState;
		expect(await reviewLoopUntil(drift, logCtx())).toBe(false);
		drift.review = { verdict: "Changes Requested", findings: mkFindings(6, "d2") };
		expect(await reviewLoopUntil(drift, logCtx())).toBe(true);

		// 5 → 3 → 1 (converging) must NOT trigger stagnation.
		const conv = { review: { verdict: "Changes Requested", findings: mkFindings(5, "c1") } } as unknown as PipelineState;
		expect(await reviewLoopUntil(conv, logCtx())).toBe(false);
		conv.review = { verdict: "Changes Requested", findings: mkFindings(3, "c2") };
		expect(await reviewLoopUntil(conv, logCtx())).toBe(false);
		conv.review = { verdict: "Changes Requested", findings: mkFindings(1, "c3") };
		expect(await reviewLoopUntil(conv, logCtx())).toBe(false);
	});

	it("records the per-round finding counts alongside the signature history", async () => {
		const s = { review: { verdict: "Changes Requested", findings: mkFindings(4, "k") } } as unknown as PipelineState;
		await reviewLoopUntil(s, logCtx());
		const recorded = (s as Record<string, unknown>).__reviewCounts;
		expect(Array.isArray(recorded)).toBe(true);
		expect(recorded).toEqual([4]);
	});
});

// ─── GAP D — final review at Stage 10 max-rounds exhaustion ───────────────────

describe("GAP D — exhaustion epilogue", () => {
	it("runs exactly one extra reviewStep after the loop exhausts (never approved, never stagnant)", async () => {
		const counts: Record<string, number> = {};
		const ctx = driveCtx(counts);
		const state = {
			setup: tmpWorktree(),
			review: { verdict: "Changes Requested", findings: [] }, // empty findings → never stagnant
		} as unknown as PipelineState;

		await expect(reviewStageNode.run(state, ctx)).resolves.toBeDefined();

		// 3 loop rounds each run reviewStep (code-reviewer) once → 3, plus the
		// GAP D epilogue's single final reviewStep → 4 total.
		expect(counts["code-reviewer"]).toBe(4);
	});
});
