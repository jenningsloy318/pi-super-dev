/**
 * v0.3.30 F3 — fix-environment restart containment in the RED loop.
 *
 * Root cause (run 2026-08-28T16-09-12-785Z try 4): a judge fix-environment
 * verdict restarts the RED loop with a hint that says "repair the toolchain/
 * dependency availability first (install or bootstrap what is missing)". When
 * the environment gap is HARNESS-side (no Gradle runner in the oracle), that
 * hint sent the tdd agent full-disk hunting the harness source (`find /`,
 * `grep -rln /home/jenningsl`, reading /tmp/jiti bundles) — a scope escape —
 * and there is no cap on fix-environment restarts.
 *
 * Contract pinned here:
 *   - the fix-environment hint scopes the repair INSIDE the worktree and
 *     forbids touching anything outside it;
 *   - at most MAX_RED_ENV_RESTARTS (default 1) fix-environment restarts are
 *     granted; the NEXT fix-environment verdict terminates the loop with the
 *     honest reason `environment-blocked` instead of another blind restart;
 *   - the implementer is never reached.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { AgentCall, Budget, ControlObj, PipelineState, RunOptions, Stage, StageContext } from "../src/types.ts";

vi.mock("../src/build-runner.ts", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return {
		...actual,
		runRedCheck: vi.fn((): string => "unknown"),
		runBuildGate: vi.fn(() => ({ pass: true, inScopePass: false, ran: ["npm test"], errors: [], outOfScopeErrors: [] })),
		runDeliverableCheck: vi.fn(() => ({ pass: true, missing: [], ran: [] })),
		resetDeliverableCheckCache: vi.fn(() => {}),
	};
});
vi.mock("../src/render/render.ts", () => ({ renderAndWrite: vi.fn() }));

import { implementationStage } from "../src/stages/implementation.ts";

function mkState(): PipelineState {
	return {
		setup: {
			worktreePath: "/tmp/sd-env-cap",
			specDirectory: "/tmp/sd-env-cap-spec",
			defaultBranch: "main",
			language: "gradle",
			isWebUi: false,
			specIdentifier: "envcap",
			worktreeCreated: false,
			initializedRepo: false,
		},
		classify: { taskType: "bug", uiScope: "none", language: "gradle", isWebUi: false },
		spec: {
			phases: [{ name: "P1", description: "env cap", deliverables: { requireTests: ["ATest"] } }],
		},
	};
}

const TDD_CONTROL: ControlObj = { testFiles: ["app/src/test/java/com/x/ATest.kt"] };
const ENV_VERDICT: ControlObj = {
	route: "fix-environment",
	diagnosis: "The deterministic red-oracle has NO runner for this project: zero test plans, oracle unknown every try.",
	confidence: 0.93,
	evidence: [],
};

function mkCtx(judgeQueue: ControlObj[], tddControl: ControlObj = TDD_CONTROL): { ctx: StageContext; tddPrompts: string[]; judgeCalls: number; logs: string[] } {
	const tddPrompts: string[] = [];
	let judgeCalls = 0;
	const logs: string[] = [];
	const ctx: StageContext = {
		task: "",
		options: {} as RunOptions,
		state: {} as PipelineState,
		async helper() { return { value: {}, digest: "" } as never; },
		async agent(call: AgentCall) {
			if (call.agent === "tdd-guide") {
				tddPrompts.push(call.prompt);
				return { text: "", control: tddControl };
			}
			if (call.agent === "judge") {
				judgeCalls++;
				return { text: "", control: judgeQueue.shift() ?? null };
			}
			if (call.agent === "code-reviewer") return { text: "", control: { verdict: "strong", summary: "ok" } };
			return { text: "", control: {} };
		},
		async parallel(cbs) { return Promise.all(cbs.map((c) => c())); },
		budget: { count: 0, check: () => true, spent() { this.count++; return true; } } satisfies Budget,
		log(message: string) { logs.push(message); },
		phase() {},
		events: new EventEmitter(),
		results: [],
	};
	return { ctx, tddPrompts, get judgeCalls() { return judgeCalls; }, logs };
}

describe("v0.3.30 F3 — fix-environment restart containment", () => {
	// note (review-2 F13): each test uses a DISTINCT testFiles path so the RED
	// evidence signatures differ and the judge's module-level per-signature
	// consult budget stays isolated per test — reorder-safe and isolation-safe.	
	beforeEach(() => { vi.clearAllMocks(); });

	it("grants exactly one fix-environment restart, then terminates with environment-blocked (no third judge consult loop)", async () => {
		const { ctx, tddPrompts, logs } = mkCtx([ENV_VERDICT, ENV_VERDICT, ENV_VERDICT]);
		const res = (await (implementationStage as Stage).run(mkState(), ctx)) as ControlObj;
		// try1 (plain unknown retry) + try2..3 (sig repeat → judge #1 → restart) + try4
		// (sig repeat → judge #2 → TERMINAL). The loop must stop at 4 tdd spawns.
		expect(tddPrompts.length).toBe(4);
		expect(logs.join("\n")).toMatch(/environment-blocked/);
		expect(String(res?.status ?? "")).not.toBe("ok");
	});

	it("the restart hint scopes the repair INSIDE the worktree and forbids external modification", async () => {
		// distinct signature from test 1 (the judge keeps a module-level
		// per-signature consult budget that test 1 already spent on ATest)
		const { ctx, tddPrompts } = mkCtx([ENV_VERDICT, ENV_VERDICT], { testFiles: ["app/src/test/java/com/x/BTest.kt"] });
		await (implementationStage as Stage).run(mkState(), ctx);
		// try 3 runs with the judge-diagnosis hint appended
		const hinted = tddPrompts[2] ?? "";
		expect(hinted).toMatch(/INSIDE (this|the) worktree/i);
		expect(hinted).toMatch(/do NOT (hunt|search|modify|touch)/i);
	});
});
