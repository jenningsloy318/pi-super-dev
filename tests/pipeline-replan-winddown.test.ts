/**
 * F9-C (incident 2026-09-04T14-45-04-784Z second half) — a REPLAN routed
 * mid-run must wind the current pass DOWN, not keep executing a superseded
 * plan. In the incident the marker was set at 11:24 (phase-02 RED unsatisfiable
 * — spec defect) yet the §D loop re-attempted Stage 9 four more times (~4h) and
 * Stage 10 ran 3 full review cycles (~2h) against the already-invalidated spec;
 * the restart at 18:56 then re-ran requirements→spec and the implementation
 * re-did guard fixes Stage 10c had already landed.
 *
 * Research basis: Fox/Gerevini/Long/Serina ICAPS-06 (plan stability — repair
 * early, never execute a dead plan), Nav2 #1395 (replan immediately on
 * invalidation), GitHub Actions cancel-in-progress (cancel superseded runs;
 * stage-aware: verification is safe to skip, state-mutating work is not).
 *
 * The wind-down is deliberately STAGE-AWARE: the in-flight phase finishes its
 * own natural break (no mid-write teardown — partial-preserve stays intact);
 * only the superseded LOOPS (remaining phases, §D re-entry, Stage 10 review)
 * stop. Post-restart, verification re-runs under the revised artifacts.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import type { PipelineState, Stage, StageContext, RunOptions, Budget, HelperResult, AgentCall, AgentResult, ControlObj } from "../src/types.ts";

vi.mock("../src/build-runner.ts", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return {
		...actual,
		runRedCheck: vi.fn((): string => "unknown"),
		runBuildGate: vi.fn(() => ({ pass: true, inScopePass: false, ran: ["npm test"], errors: [] as string[], outOfScopeErrors: [] as string[] })),
		runDeliverableCheck: vi.fn(() => ({ pass: true, missing: [] as string[], ran: [] as string[] })),
		resetDeliverableCheckCache: vi.fn(() => {}),
		deliverablesAlreadyMet: vi.fn(() => false),
	};
});

vi.mock("../src/render/render.ts", () => ({ renderAndWrite: vi.fn() }));

import { replanPending } from "../src/replan/replan.ts";
import { shouldIterateImplementation, shouldRunVerification, verificationSkippedReplanStage } from "../src/stages/index.ts";
import { implementationStage } from "../src/stages/implementation.ts";

describe("F9-C — replanPending", () => {
	it("true iff the marker is set on state", () => {
		expect(replanPending({} as PipelineState)).toBe(false);
		expect(replanPending({ __replan: undefined } as unknown as PipelineState)).toBe(false);
		expect(replanPending({ __replan: { rounds: 1, owners: ["spec"] } } as unknown as PipelineState)).toBe(true);
	});
});

describe("F9-C — §D loop predicate consults the marker", () => {
	const budget = { budget: { check: () => true } };

	it("iterates normally when green is missing and no marker", () => {
		const s = { implementation: { allGreen: false } } as unknown as PipelineState;
		expect(shouldIterateImplementation(s, budget)).toBe(true);
	});

	it("stops on allGreen (pinned)", () => {
		const s = { implementation: { allGreen: true } } as unknown as PipelineState;
		expect(shouldIterateImplementation(s, budget)).toBe(false);
	});

	it("stops when a REPLAN is pending even though phases remain un-green", () => {
		const s = { implementation: { allGreen: false }, __replan: { rounds: 1, owners: ["spec"] } } as unknown as PipelineState;
		expect(shouldIterateImplementation(s, budget)).toBe(false);
	});
});

describe("F9-C — Stage 10 skips when a REPLAN is pending", () => {
	it("shouldRunVerification: implementation present + no marker → runs", () => {
		const s = { implementation: { totalPhases: 2, allGreen: true } } as unknown as PipelineState;
		expect(shouldRunVerification(s)).toBe(true);
	});

	it("shouldRunVerification: implementation present + marker → skipped (named, not silent)", () => {
		const s = { implementation: { totalPhases: 2, allGreen: true }, __replan: { rounds: 1, owners: ["spec"] } } as unknown as PipelineState;
		expect(shouldRunVerification(s)).toBe(false);
	});

	it("the replan-skip notice node is named and logs the skip (P10)", async () => {
		expect(verificationSkippedReplanStage.label).toMatch(/REPLAN pending/i);
		const logs: string[] = [];
		const state = { __replan: { rounds: 1, owners: ["spec"] } } as unknown as PipelineState;
		await verificationSkippedReplanStage.run(state, { log: (m: string) => logs.push(m) } as never);
		expect(logs.some((l) => /Stage 10 skipped — REPLAN round 1 pending/.test(l) && /revised spec after restart/.test(l))).toBe(true);
	});
});

describe("F9-C — implementationStage defers remaining phases once the marker is set", () => {
	function ctxWith(logs: string[], counts: { tdd: number }): StageContext {
		return {
			task: "",
			options: {} as RunOptions,
			state: {} as PipelineState,
			async helper(): Promise<HelperResult> {
				return { value: { languageInstructions: "" }, digest: "" };
			},
			async agent(call: AgentCall): Promise<AgentResult> {
				if (call.agent === "tdd-guide") {
					counts.tdd++;
					return { text: "", control: { testFiles: ["tests/a.test.ts"] } };
				}
				return { text: "", control: {} };
			},
			async parallel(cbs) {
				return Promise.all(cbs.map((c) => c()));
			},
			budget: { count: 0, check: () => true, spent() { this.count++; return true; } } satisfies Budget,
			log(message: string) {
				logs.push(message);
			},
			phase() {},
			events: new EventEmitter(),
			results: [],
		};
	}

	it("marker preset at stage entry → zero phases attempted, named deferral log", async () => {
		const logs: string[] = [];
		const counts = { tdd: 0 };
		const state = {
			setup: {
				worktreePath: "/tmp/sd-f9c",
				specDirectory: "/tmp/sd-f9c-spec",
				defaultBranch: "main",
				language: "frontend",
				isWebUi: false,
				specIdentifier: "f9c",
				worktreeCreated: false,
				initializedRepo: false,
			},
			classify: { taskType: "feature", uiScope: "none", language: "frontend", isWebUi: false },
			spec: { phases: [{ name: "one", description: "x" }, { name: "two", description: "y" }] },
			__replan: { rounds: 1, owners: ["spec"] },
		} as unknown as PipelineState;

		const res = (await (implementationStage as Stage).run(state, ctxWith(logs, counts))) as ControlObj;

		expect(counts.tdd).toBe(0);
		expect(logs.some((l) => /REPLAN pending/i.test(l) && /deferr/i.test(l))).toBe(true);
		expect(res.phasesCompleted ?? 0).toBe(0);
	});
});
