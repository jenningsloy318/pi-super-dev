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
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import {
	reviewLoopUntil,
	reviewStageNode,
	integrationLoopNode,
	verificationConvergenceNode,
	testFailuresSignature,
} from "../src/stages/verify.ts";
import { runHelper } from "../src/helpers.ts";
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

function convergenceCtx(agent: StageContext["agent"], logs: string[] = []): StageContext {
	return {
		task: "implement feature",
		options: {},
		state: {} as PipelineState,
		agent,
		helper: runHelper,
		parallel: async (calls: Array<() => Promise<unknown>>) => Promise.all(calls.map((f) => f())) as never,
		budget: { check: () => true, spent: () => true, count: 0 },
		log: (m: string) => logs.push(m),
		phase: () => {},
		events: new EventEmitter(),
		results: [],
	} as unknown as StageContext;
}

function stateWithApi(): PipelineState {
	return {
		setup: tmpWorktree(),
		classify: { taskType: "feature", uiScope: "none", language: "backend", isWebUi: false },
		implementation: { totalPhases: 1, phasesCompleted: 1, allGreen: true },
		assessment: {
			services: {
				api: {
					cmd: `${process.execPath} -e "require('http').createServer((req,res)=>res.end('ok')).listen(process.env.PORT)"`,
					portEnv: "PORT",
					readyPath: "/",
				},
			},
		},
	} as unknown as PipelineState;
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
		ctx.agent = async (call: AgentCall) => {
			counts[call.agent] = (counts[call.agent] ?? 0) + 1;
			if (call.agent === "api-tester") {
				return { text: "", control: { pass: false, failures: [{ id: "e1", file: "a.spec.ts", title: "boom", message: "expected 200" }] } };
			}
			return { text: "", control: {} };
		};
		const state = {
			setup: tmpWorktree(),
			assessment: {
				services: {
					api: {
						cmd: `${process.execPath} -e "require('http').createServer((req,res)=>res.end('ok')).listen(process.env.PORT)"`,
						portEnv: "PORT",
						readyPath: "/",
					},
				},
			},
			review: { verdict: "Changes Requested", findings: [] },
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

		// 5 loop rounds each run reviewStep (code-reviewer) once → 5, plus the
		// GAP D epilogue's single final reviewStep → 6 total.
		expect(counts["code-reviewer"]).toBe(6);
	});
});

// ─── Unified verification convergence ──────────────────────────────────────

describe("verificationConvergenceNode", () => {
	it("fixes review findings, then re-reviews before integration runs", async () => {
		let codeReviewCalls = 0;
		let fixCalls = 0;
		let apiCalls = 0;
		const state = stateWithApi();
		const ctx = convergenceCtx(async (call: AgentCall) => {
			if (call.agent === "code-reviewer") {
				codeReviewCalls += 1;
				if (codeReviewCalls === 1) {
					return { text: "", control: { title: "Review", date: "2026-08-07", verdict: "Changes Requested", summary: "fix", findings: [{ id: "F1", severity: "high", title: "Bug", detail: "bad", file: "src/a.ts" }] } };
				}
				return { text: "", control: { title: "Review", date: "2026-08-07", verdict: "Approved", summary: "ok", findings: [] } };
			}
			if (call.agent === "adversarial-reviewer") {
				return { text: "", control: { title: "Adv", date: "2026-08-07", verdict: "PASS", summary: "ok", findings: [] } };
			}
			if (call.agent === "implementer") {
				fixCalls += 1;
				return { text: "", control: { filesCreated: [], filesModified: ["src/a.ts"], filesDeleted: [], fixesApplied: 1, summary: "fixed" } };
			}
			if (call.agent === "api-tester") {
				apiCalls += 1;
				expect(codeReviewCalls).toBeGreaterThanOrEqual(2);
				return { text: "", control: { title: "API", date: "2026-08-07", pass: true, cases: 1, failures: [], summary: "ok" } };
			}
			return { text: "", control: {} };
		});

		const result = await verificationConvergenceNode.run(state, ctx);

		expect(result.status).toBe("ok");
		expect(codeReviewCalls).toBe(2);
		expect(fixCalls).toBe(1);
		expect(apiCalls).toBe(1);
		expect(state.integration?.status).toBe("passed");
	});

	it("fixes integration failures, then re-reviews before re-testing", async () => {
		let codeReviewCalls = 0;
		let fixCalls = 0;
		let apiCalls = 0;
		const state = stateWithApi();
		const ctx = convergenceCtx(async (call: AgentCall) => {
			if (call.agent === "code-reviewer") {
				codeReviewCalls += 1;
				return { text: "", control: { title: "Review", date: "2026-08-07", verdict: "Approved", summary: "ok", findings: [] } };
			}
			if (call.agent === "adversarial-reviewer") {
				return { text: "", control: { title: "Adv", date: "2026-08-07", verdict: "PASS", summary: "ok", findings: [] } };
			}
			if (call.agent === "api-tester") {
				apiCalls += 1;
				if (apiCalls === 1) {
					return { text: "", control: { title: "API", date: "2026-08-07", pass: false, cases: 1, failures: [{ method: "GET", path: "/", reason: "expected 200" }], summary: "fail" } };
				}
				expect(codeReviewCalls).toBe(2);
				return { text: "", control: { title: "API", date: "2026-08-07", pass: true, cases: 1, failures: [], summary: "ok" } };
			}
			if (call.agent === "implementer") {
				fixCalls += 1;
				return { text: "", control: { filesCreated: [], filesModified: ["src/a.ts"], filesDeleted: [], fixesApplied: 1, summary: "fixed" } };
			}
			return { text: "", control: {} };
		});

		const result = await verificationConvergenceNode.run(state, ctx);

		expect(result.status).toBe("ok");
		expect(codeReviewCalls).toBe(2);
		expect(apiCalls).toBe(2);
		expect(fixCalls).toBe(1);
		expect(state.integration?.status).toBe("passed");
	});

	it("does not carry stale integration failures into the next review/build attempt", async () => {
		let codeReviewCalls = 0;
		let fixCalls = 0;
		let apiCalls = 0;
		const state = stateWithApi();
		const ctx = convergenceCtx(async (call: AgentCall) => {
			if (call.agent === "code-reviewer") {
				codeReviewCalls += 1;
				if (codeReviewCalls === 2) {
					return { text: "", control: { title: "Review", date: "2026-08-07", verdict: "Changes Requested", summary: "new review issue", findings: [{ id: "R2", severity: "high", title: "Regression", detail: "bad", file: "src/a.ts" }] } };
				}
				return { text: "", control: { title: "Review", date: "2026-08-07", verdict: "Approved", summary: "ok", findings: [] } };
			}
			if (call.agent === "adversarial-reviewer") {
				return { text: "", control: { title: "Adv", date: "2026-08-07", verdict: "PASS", summary: "ok", findings: [] } };
			}
			if (call.agent === "api-tester") {
				apiCalls += 1;
				if (apiCalls === 1) {
					return { text: "", control: { title: "API", date: "2026-08-07", pass: false, cases: 1, failures: [{ method: "GET", path: "/", reason: "expected 200" }], summary: "fail" } };
				}
				return { text: "", control: { title: "API", date: "2026-08-07", pass: true, cases: 1, failures: [], summary: "ok" } };
			}
			if (call.agent === "implementer") {
				fixCalls += 1;
				return { text: "", control: { filesCreated: [], filesModified: ["src/a.ts"], filesDeleted: [], fixesApplied: 1, summary: "fixed" } };
			}
			return { text: "", control: {} };
		});

		const result = await verificationConvergenceNode.run(state, ctx);

		expect(result.status).toBe("ok");
		expect(codeReviewCalls).toBe(3);
		expect(apiCalls).toBe(2);
		expect(fixCalls).toBe(2);
		const attempts = (state as Record<string, unknown>).__verificationAttempts as Array<{ reviewFindings?: number; integrationStatus?: string }>;
		expect(attempts).toHaveLength(3);
		expect(attempts[1]).toMatchObject({ reviewFindings: 1 });
		expect(attempts[1]?.integrationStatus).toBeUndefined();
		expect(state.integration?.status).toBe("passed");
	});

	it("does not run a final unreviewed fix when max attempts are exhausted", async () => {
		let codeReviewCalls = 0;
		let fixCalls = 0;
		const state = { setup: tmpWorktree(), implementation: { totalPhases: 1, phasesCompleted: 1, allGreen: true } } as unknown as PipelineState;
		const ctx = convergenceCtx(async (call: AgentCall) => {
			if (call.agent === "code-reviewer") {
				codeReviewCalls += 1;
				const remaining = Math.max(1, 6 - codeReviewCalls);
				return { text: "", control: { title: "Review", date: "2026-08-07", verdict: "Changes Requested", summary: "fail", findings: mkFindings(remaining, `r${codeReviewCalls}`) } };
			}
			if (call.agent === "adversarial-reviewer") {
				return { text: "", control: { title: "Adv", date: "2026-08-07", verdict: "PASS", summary: "ok", findings: [] } };
			}
			if (call.agent === "implementer") {
				fixCalls += 1;
				return { text: "", control: { filesCreated: [], filesModified: ["src/a.ts"], filesDeleted: [], fixesApplied: 1, summary: "fixed" } };
			}
			return { text: "", control: {} };
		});

		const result = await verificationConvergenceNode.run(state, ctx);

		expect(result.status).toBe("failed");
		expect(codeReviewCalls).toBe(5);
		expect(fixCalls).toBe(4);
		const attempts = (state as Record<string, unknown>).__verificationAttempts as unknown[];
		expect(attempts).toHaveLength(5);
	});

	it("rejects integration tester writes to production files instead of routing them to implementer", async () => {
		let fixCalls = 0;
		const state = stateWithApi();
		const cwd = state.setup!.worktreePath;
		execFileSync("git", ["init"], { cwd, stdio: "ignore" });
		const ctx = convergenceCtx(async (call: AgentCall) => {
			if (call.agent === "code-reviewer") {
				return { text: "", control: { title: "Review", date: "2026-08-07", verdict: "Approved", summary: "ok", findings: [] } };
			}
			if (call.agent === "adversarial-reviewer") {
				return { text: "", control: { title: "Adv", date: "2026-08-07", verdict: "PASS", summary: "ok", findings: [] } };
			}
			if (call.agent === "api-tester") {
				mkdirSync(join(cwd, "src"), { recursive: true });
				writeFileSync(join(cwd, "src", "prod.ts"), "export const changedByTester = true;\n");
				return { text: "", control: { title: "API", date: "2026-08-07", pass: true, cases: 1, failures: [], summary: "ok" } };
			}
			if (call.agent === "red-boundary-classifier") {
				return {
					text: "",
					control: {
						classifications: [{ path: "src/prod.ts", category: "production", confidence: 0.99, reason: "source implementation file" }],
						forbiddenFiles: ["src/prod.ts"],
						ambiguousFiles: [],
						allAllowed: false,
					},
				};
			}
			if (call.agent === "implementer") {
				fixCalls += 1;
				return { text: "", control: { filesCreated: [], filesModified: [], filesDeleted: [], fixesApplied: 1, summary: "should not run" } };
			}
			return { text: "", control: {} };
		});

		const result = await verificationConvergenceNode.run(state, ctx);

		expect(result.status).toBe("failed");
		expect(String(result.error)).toContain("integration tester modified implementation files");
		expect(fixCalls).toBe(0);
		expect(state.integration?.summary).toContain("src/prod.ts");
	});
});
