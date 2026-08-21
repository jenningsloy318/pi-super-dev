/**
 * Phase 1 of the unified verify-loop: the verify node is a loop that runs BOTH
 * reviewers (code-review + adversarial) in parallel → merge → fix. This guards
 * the structure so Phase 2 (adding the api/ui test step) doesn't accidentally
 * drop a reviewer or break the loop shape.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { integrationTestsGreen, integrationOutcome, expectedIntegrationRoles, integrationLoopNode, reviewLoopNode, reviewLoopUntil, verificationConvergenceNode, findingsSignature } from "../src/stages/verify.ts";
import { runHelper } from "../src/helpers.ts";
import type { AgentCall, AgentResult, ControlObj, PipelineState, StageContext } from "../src/types.ts";

describe("reviewLoopNode (Phase 1)", () => {
	it("is a loop node (review → fix, iterating until approved)", () => {
		expect(reviewLoopNode.kind).toBe("loop");
		expect(typeof reviewLoopNode.run).toBe("function");
	});
});

describe("review loop exit predicate", () => {
	const ctx = { log: () => {} } as never;
	it("requires both approval and build green", async () => {
		expect(await reviewLoopUntil({ review: { verdict: "Approved" }, buildGate: { pass: false } } as PipelineState, ctx)).toBe(false);
		expect(await reviewLoopUntil({ review: { verdict: "Approved" }, buildGate: { pass: true } } as PipelineState, ctx)).toBe(true);
	});
});

describe("integrationLoopNode", () => {
	it("does not convert a failed bringup/test block into notApplicable success", async () => {
		const state = { review: { verdict: "Approved" }, buildGate: { pass: true } } as PipelineState;
		const ctx: StageContext = {
			task: "t",
			options: {},
			state,
			agent: async (): Promise<AgentResult> => ({ text: "", control: {} }),
			helper: async () => ({ value: {}, digest: "" }),
			parallel: async (calls) => Promise.all(calls.map((call) => call())),
			budget: { count: 0, check: () => false, spent() { this.count++; return false; } },
			log: () => {},
			phase: () => {},
			events: new EventEmitter(),
			results: [],
		};
		const r = await integrationLoopNode.run(state, ctx);
		expect(r.status).toBe("failed");
		expect(state.integration?.pass).toBe(false);
		expect(state.integration?.notApplicable).toBeUndefined();
	});
});

describe("integration test verdict helpers", () => {
	it("does not pass vacuously when no API/UI test was expected or produced", () => {
		expect(integrationTestsGreen({} as PipelineState)).toBe(false);
	});
	it("requires every expected integration role to produce a fresh pass", () => {
		expect(integrationTestsGreen({ integrationExpectedTests: ["api"] } as PipelineState)).toBe(false);
		expect(integrationTestsGreen({ integrationExpectedTests: ["api"], apiTest: { pass: true } } as PipelineState)).toBe(true);
		expect(integrationTestsGreen({ integrationExpectedTests: ["api", "ui"], apiTest: { pass: true } } as PipelineState)).toBe(false);
		expect(integrationTestsGreen({ integrationExpectedTests: ["api", "ui"], apiTest: { pass: true }, uiTest: { pass: "PASS" } } as PipelineState)).toBe(true);
	});
	it("uses explicit expected roles instead of stale old test objects", () => {
		const state = { integrationExpectedTests: [], apiTest: { pass: false }, uiTest: { pass: false } } as unknown as PipelineState;
		expect(expectedIntegrationRoles(state)).toEqual([]);
		expect(integrationTestsGreen(state)).toBe(false);
	});
	it("classifies integration outcomes with explicit non-vacuous statuses", () => {
		expect(integrationOutcome({} as PipelineState)).toMatchObject({ status: "skipped-not-applicable", pass: true });
		expect(integrationOutcome({ integrationExpectedTests: ["api"] } as PipelineState)).toMatchObject({ status: "unknown-runner-unavailable", pass: false });
		expect(integrationOutcome({ integrationExpectedTests: ["api"], apiTest: { pass: false, skipped: true, failures: [{ reason: "service(s) not ready: api" }] } } as unknown as PipelineState)).toMatchObject({ status: "skipped-service-unavailable", pass: false });
		expect(integrationOutcome({ integrationExpectedTests: ["api"], apiTest: { pass: false, failures: [{ message: "expected 200" }] } } as unknown as PipelineState)).toMatchObject({ status: "failed", pass: false });
		expect(integrationOutcome({ integrationExpectedTests: ["api"], apiTest: { pass: true } } as PipelineState)).toMatchObject({ status: "passed", pass: true });
	});
});

// ── M10/D5 (AC-20 / SCENARIO-044): the deferred/escalation visibility caps are
// REMOVED — `__stagnated.findings` and the judge-context lists carry the
// COMPLETE deferred/recurring lists (the unrelated build-error truncation and
// escalation-record summary caps are out of contract and stay).
describe("deferred-finding visibility caps removed (AC-20, D5)", () => {
	const mkDeferred = (n: number) => Array.from({ length: n }, (_, i) => ({
		id: `D-${i}`, severity: "low", title: `advisory number ${i}`,
		deferralReason: "advisory (non-blocking, below high)",
	}));

	/** ctx whose judge agent records every prompt and always discards. */
	const judgePromptCtx = (prompts: string[]): StageContext =>
		({
			log: () => {},
			task: "", options: {}, state: {} as PipelineState,
			async agent(call: AgentCall): Promise<AgentResult> {
				if (call.id.startsWith("pipeline.judge.")) prompts.push(call.prompt);
				return { text: "", control: null };
			},
			async helper() { return { value: {}, digest: "" }; },
			async parallel(calls: Array<() => Promise<unknown>>) { return Promise.all(calls.map((f) => f())) as never; },
			budget: { check: () => true, spent: () => true, count: 0 },
			phase: () => {},
			events: new EventEmitter(),
			results: [],
		}) as unknown as StageContext;

	it("dead-state __stagnated.findings lists ALL deferred items with [deferred: …] titles (no slice(0,6))", async () => {
		const s = {
			review: { verdict: "Changes Requested", findings: [], deferredFindings: mkDeferred(15) },
			buildGate: { pass: true, ran: [], errors: [] },
		} as unknown as PipelineState;
		const prompts: string[] = [];
		expect(await reviewLoopUntil(s, judgePromptCtx(prompts))).toBe(true);
		const stag = (s as Record<string, unknown>).__stagnated as { findings?: Array<{ title?: string }> };
		expect(stag?.findings).toHaveLength(15);
		for (const f of stag?.findings ?? []) expect(f.title).toContain("[deferred:");
		// the judge context carries the COMPLETE deferred ledger (no slice(0,8))
		expect(prompts.length).toBeGreaterThan(0);
		for (let i = 0; i < 15; i++) expect(prompts.join("\n")).toContain(`advisory number ${i}`);
	});

	it("stagnation __stagnated.findings lists ALL recurring + deferred items (no 6/8/12 caps)", async () => {
		const findings = Array.from({ length: 15 }, (_, i) => ({
			id: `F-${i}`, severity: "high", title: `Recurring ${i}`, detail: "d", file: `f-${i}.ts`,
		}));
		const s = {
			review: { verdict: "Changes Requested", findings, deferredFindings: mkDeferred(15) },
			buildGate: { pass: true, ran: [], errors: [] },
		} as unknown as PipelineState;
		const sig = findingsSignature(s);
		(s as Record<string, unknown>).__reviewSignatures = [sig, sig]; // 2 prior identical rounds → next push is stagnant
		const prompts: string[] = [];
		expect(await reviewLoopUntil(s, judgePromptCtx(prompts))).toBe(true);
		const stag = (s as Record<string, unknown>).__stagnated as { findings?: Array<{ title?: string }> };
		expect(stag?.findings).toHaveLength(30); // 15 recurring + 15 deferred — no caps
		for (let i = 0; i < 15; i++) expect(stag?.findings?.some((f) => f.title === `Recurring ${i}`)).toBe(true);
		for (let i = 0; i < 15; i++) expect(stag?.findings?.some((f) => f.title?.includes(`advisory number ${i}`))).toBe(true);
		// the judge context carries the COMPLETE recurring list (no slice(0,12))
		expect(prompts.join("\n")).toContain("Recurring 14");
	});

	it("verificationConvergenceNode dead state carries ALL deferred items (the :1213 slice(0,6) is gone)", async () => {
		const priorReplanLead = process.env.SUPER_DEV_DISABLE_REPLAN_LEAD;
		process.env.SUPER_DEV_DISABLE_REPLAN_LEAD = "1"; // residue → human → no replan → HITL dead state
		const dir = mkdtempSync(join(tmpdir(), "sd-verify-d5-"));
		try {
			const state: PipelineState = {
				task: "implement feature",
				options: {},
				setup: { worktreePath: dir, specDirectory: join(dir, "docs/specifications/01-d5") + "/" },
				classify: { taskType: "feature", uiScope: "none", language: "backend", isWebUi: false },
				implementation: { totalPhases: 1, phasesCompleted: 1, allGreen: true },
			} as unknown as PipelineState;
			mkdirSync(state.setup!.specDirectory, { recursive: true });
			const ghostFindings = Array.from({ length: 15 }, (_, i) => ({
				id: `G-${i}`, severity: "high", title: `naming is inconsistent ${i}`, detail: "cosmetic",
				file: `ghost-${i}.ts`, // does not exist → R-5 demotes to the deferred ledger
			}));
			const ctx: StageContext = {
				task: "implement feature", options: {}, state,
				async agent(call: AgentCall): Promise<AgentResult> {
					if (call.agent === "code-reviewer") {
						return { text: "", control: { title: "Review", date: "2026-08-17", verdict: "Changes Requested", summary: "fix", findings: ghostFindings } as ControlObj };
					}
					if (call.agent === "adversarial-reviewer") {
						return { text: "", control: { title: "Adv", date: "2026-08-17", verdict: "PASS", summary: "ok", findings: [] } as ControlObj };
					}
					return { text: "", control: null };
				},
				helper: runHelper,
				async parallel(calls: Array<() => Promise<unknown>>) { return Promise.all(calls.map((f) => f())) as never; },
				budget: { check: () => true, spent: () => true, count: 0 },
				log: () => {}, phase: () => {}, events: new EventEmitter(), results: [],
			} as unknown as StageContext;
			const result = await verificationConvergenceNode.run(state, ctx);
			expect(result.status).toBe("ok");
			const review = state.review as { findings?: unknown[]; deferredFindings?: Array<Record<string, unknown>> };
			expect(review.findings).toHaveLength(0); // all demoted (the dead-state premise)
			expect(review.deferredFindings).toHaveLength(15);
			const stag = (state as Record<string, unknown>).__stagnated as { kind?: string; findings?: Array<{ title?: string }> };
			expect(stag?.kind).toBe("blocked-on-decisions");
			expect(stag?.findings).toHaveLength(15); // was slice(0, 6)
			for (let i = 0; i < 15; i++) expect(stag?.findings?.some((f) => f.title?.includes(`naming is inconsistent ${i}`))).toBe(true);
			for (const f of stag?.findings ?? []) expect(f.title).toContain("[deferred:");
		} finally {
			rmSync(dir, { recursive: true, force: true });
			if (priorReplanLead === undefined) delete process.env.SUPER_DEV_DISABLE_REPLAN_LEAD;
			else process.env.SUPER_DEV_DISABLE_REPLAN_LEAD = priorReplanLead;
		}
	});
});

// ── M4 (v0.3.8): verify inline-first — deferred findings drive a jump ───────

describe("M4 verify inline-first (blocked-on-decisions seam)", () => {
	it("a single routable upstream owner in the deferred set throws RouteBackSignal before the replan emulation", async () => {
		const dir = mkdtempSync(join(tmpdir(), "sd-verify-m4-"));
		try {
			const specDir = join(dir, "docs/specifications/01-m4") + "/";
			const state: PipelineState = {
				task: "implement feature",
				options: {},
				setup: { worktreePath: dir, specDirectory: specDir },
				classify: { taskType: "feature", uiScope: "none", language: "backend", isWebUi: false },
				implementation: { totalPhases: 1, phasesCompleted: 1, allGreen: true },
			} as unknown as PipelineState;
			mkdirSync(specDir, { recursive: true });
			// Deferred findings owned by SPEC (cross-stage ownership is exactly why
			// they were deferred) — one routable upstream owner from "verify".
			const deferredOwned = Array.from({ length: 3 }, (_, i) => ({
				id: `DF-${i}`, severity: "medium", title: `spec gap ${i}`, detail: "owned upstream",
				ownerStage: "spec", blocking: true,
			}));
			const ctx: StageContext = {
				task: "implement feature", options: {}, state,
				async agent(call: AgentCall): Promise<AgentResult> {
					if (call.agent === "code-reviewer") {
						// findings with nonexistent files → R-5 demotes ALL to deferred
						return { text: "", control: { title: "Review", date: "2026-08-17", verdict: "Changes Requested", summary: "fix", findings: deferredOwned.map((f) => ({ ...f, file: `ghost-${f.id}.ts` })) } as ControlObj };
					}
					if (call.agent === "adversarial-reviewer") {
						return { text: "", control: { title: "Adv", date: "2026-08-17", verdict: "PASS", summary: "ok", findings: [] } as ControlObj };
					}
					return { text: "", control: null };
				},
				helper: runHelper,
				async parallel(calls: Array<() => Promise<unknown>>) { return Promise.all(calls.map((f) => f())) as never; },
				budget: { check: () => true, spent: () => true, count: 0 },
				log: () => {}, phase: () => {}, events: new EventEmitter(), results: [],
			} as unknown as StageContext;
			await expect(verificationConvergenceNode.run(state, ctx)).rejects.toSatisfy(
				(err: unknown) => err instanceof Error && err.name === "RouteBackSignal",
			);
			// The journal recorded the verify→spec edge (the walker would have
			// charged it; here the signal escaped directly to the test).
			expect((state as Record<string, unknown>).__replan).toBeUndefined();
			const stag = (state as Record<string, unknown>).__stagnated;
			expect(stag).toBeUndefined(); // the dead-state path never ran
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

// ── M4 round-2: the ledger recording is behaviorally load-bearing ───────────

describe("M4 round-2 pin — deleting the verify ledger recording must fail this test", () => {
	it("the jumped deferred findings ARE in the convergence ledger with ownerStage (walker injection source)", async () => {
		const dir = mkdtempSync(join(tmpdir(), "sd-verify-m4b-"));
		try {
			const specDir = join(dir, "docs/specifications/01-m4b") + "/";
			const state: PipelineState = {
				task: "implement feature",
				options: {},
				setup: { worktreePath: dir, specDirectory: specDir },
				classify: { taskType: "feature", uiScope: "none", language: "backend", isWebUi: false },
				implementation: { totalPhases: 1, phasesCompleted: 1, allGreen: true },
			} as unknown as PipelineState;
			mkdirSync(specDir, { recursive: true });
			const deferredOwned = [{ id: "DF-77", severity: "medium", title: "spec gap", detail: "owned upstream", ownerStage: "spec", blocking: true }];
			const ctx: StageContext = {
				task: "implement feature", options: {}, state,
				async agent(call: AgentCall): Promise<AgentResult> {
					if (call.agent === "code-reviewer") {
						return { text: "", control: { title: "Review", date: "2026-08-17", verdict: "Changes Requested", summary: "fix", findings: deferredOwned.map((f) => ({ ...f, file: `ghost-${f.id}.ts` })) } as ControlObj };
					}
					if (call.agent === "adversarial-reviewer") {
						return { text: "", control: { title: "Adv", date: "2026-08-17", verdict: "PASS", summary: "ok", findings: [] } as ControlObj };
					}
					return { text: "", control: null };
				},
				helper: runHelper,
				async parallel(calls: Array<() => Promise<unknown>>) { return Promise.all(calls.map((f) => f())) as never; },
				budget: { check: () => true, spent: () => true, count: 0 },
				log: () => {}, phase: () => {}, events: new EventEmitter(), results: [],
			} as unknown as StageContext;
			let thrown: unknown;
			try { await verificationConvergenceNode.run(state, ctx); } catch (e) { thrown = e; }
			expect((thrown as Error)?.name).toBe("RouteBackSignal");
			// THE pin: the ledger carries the jumped finding — remove the
			// recordConvergenceFindings call and this fails.
			const ledger = (state as Record<string, unknown>).__convergenceLedger as { findings?: Array<{ id?: string; ownerStage?: string; blocking?: boolean }> } | undefined;
			const row = ledger?.findings?.find((f) => f.id === "DF-77");
			expect(row).toBeDefined();
			expect(row?.ownerStage).toBe("spec");
			expect(row?.blocking).toBe(true);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
