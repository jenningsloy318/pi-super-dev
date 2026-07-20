/**
 * Phase P3 — RED enforcement loop edge cases (AC-02 → SCENARIO-006/007/008/009/010).
 *
 * This is the ANTI-HARDCODING strengthening companion to
 * `tests/implementation-red-loop.test.ts`. The sibling suite asserts the RED
 * loop's *structure* (call-counts, the CONFIRMED-red flag, the WARNING line).
 * It does NOT assert the load-bearing DATA-FLOW edges of the AC-02 contract,
 * so a shortcut implementation that ignored `control.testFiles` entirely, that
 * appended a fixed re-prompt suffix regardless of status, or that re-ran the
 * oracle against STALE test files would still pass the sibling suite. These
 * tests invalidate every such shortcut:
 *
 *   1. `control.testFiles` is CAPTURED and passed verbatim as runRedCheck's
 *      2nd argument (Gap 1b: "the result is no longer discarded").
 *   2. testFiles degrade to `[]` when tdd-guide returns none (never throws).
 *   3. Each status-specific re-prompt carries the EXACT hint wording for its
 *      status (green → "PASSED already"/"GENUINELY fails"; broken →
 *      "compile/collect") — not a generic one-size hint.
 *   4. A retry's NEW `control.testFiles` propagate to the NEXT runRedCheck
 *      call (not the stale original set).
 *   5. A retry that returns no testFiles falls back to the PRIOR testFiles.
 *   6. The cap-exhausted implementer prompt names the residual status AND the
 *      `2` retry count verbatim (so the green-phase agent is not told a lie).
 *   7. The `unknown` implementer prompt states the red was NOT confirmed.
 *   8. Multi-phase: each phase owns an INDEPENDENT red-oracle loop.
 *
 * Hermeticity mirrors the sibling suite: only side-effecting imports
 * (`runRedCheck`/`runBuildGate`, `renderAndWrite`) are mocked; `ctx.agent` /
 * `ctx.helper` are pure scripted closures. No `pi` subprocess, no network, no
 * disk.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import type {
	AgentCall,
	AgentResult,
	Budget,
	ControlObj,
	HelperResult,
	PipelineState,
	RunOptions,
	Stage,
	StageContext,
} from "../src/types.ts";

// ─── Mocks ──────────────────────────────────────────────────────────────────
vi.mock("../src/build-runner.ts", () => ({
	runRedCheck: vi.fn((): string => "unknown"),
	runBuildGate: vi.fn(() => ({
		pass: true,
		inScopePass: false,
		ran: ["npm test"],
		errors: [] as string[],
		outOfScopeErrors: [] as string[],
	})),
	runDeliverableCheck: vi.fn(() => ({ pass: true, missing: [] as string[], ran: [] as string[] })),
	resetDeliverableCheckCache: vi.fn(() => {}),
}));

vi.mock("../src/render/render.ts", () => ({
	renderAndWrite: vi.fn(),
}));

import { implementationStage } from "../src/stages/implementation.ts";
import { runRedCheck, runBuildGate } from "../src/build-runner.ts";

const redCheck = runRedCheck as unknown as ReturnType<typeof vi.fn>;
const buildGate = runBuildGate as unknown as ReturnType<typeof vi.fn>;

const DEFAULT_TDD_CONTROL: ControlObj = { testFiles: ["tests/red.test.ts"] };

// ─── Fixtures ───────────────────────────────────────────────────────────────

function mkState(phaseCount = 1): PipelineState {
	const phases = Array.from({ length: phaseCount }, (_, i) => ({
		name: `P${i + 1}`,
		description: `phase ${i + 1}`,
	}));
	return {
		setup: {
			worktreePath: "/tmp/sd-red-loop",
			specDirectory: "/tmp/sd",
			defaultBranch: "main",
			language: "frontend",
			isWebUi: false,
			specIdentifier: "p3",
			worktreeCreated: false,
			initializedRepo: false,
		},
		classify: { taskType: "bug", uiScope: "none", language: "frontend", isWebUi: false },
		spec: { phases },
	};
}

/**
 * Scripted StageContext whose `agent()` closure serves a SEQUENCE of distinct
 * tdd-guide controls (one per tdd-guide call, in order), so we can assert that
 * a retry's NEW control.testFiles actually propagate to the next oracle call.
 */
function mkCtx(opts: { tddControls?: ControlObj[] } = {}): { ctx: StageContext; tddCalls: AgentCall[]; implCalls: AgentCall[] } {
	const queue = [...(opts.tddControls ?? [DEFAULT_TDD_CONTROL])];
	const tddCalls: AgentCall[] = [];
	const implCalls: AgentCall[] = [];
	const ctx: StageContext = {
		task: "",
		options: {} as RunOptions,
		state: {} as PipelineState,
		async helper(): Promise<HelperResult> {
			return { value: { languageInstructions: "" }, digest: "" };
		},
		async agent(call: AgentCall): Promise<AgentResult> {
			if (call.agent === "tdd-guide") {
				tddCalls.push(call);
				const next = queue.length > 1 ? queue.shift()! : (queue[0] ?? DEFAULT_TDD_CONTROL);
				return { text: "", control: next };
			}
			if (call.agent === "implementer") {
				implCalls.push(call);
				return { text: "", control: { filesModified: ["src/x.ts"] } };
			}
			return { text: "", control: {} };
		},
		async parallel(cbs) {
			return Promise.all(cbs.map((c) => c()));
		},
		budget: { count: 0, check: () => true, spent() { this.count++; } } satisfies Budget,
		log() {},
		events: new EventEmitter(),
		results: [],
	};
	return { ctx, tddCalls, implCalls };
}

beforeEach(() => {
	redCheck.mockReset();
	buildGate.mockReset();
	redCheck.mockImplementation(() => "unknown");
	buildGate.mockImplementation(() => ({
		pass: true,
		inScopePass: false,
		ran: ["npm test"],
		errors: [],
		outOfScopeErrors: [],
	}));
});

// ─── 1. testFiles are captured and passed as runRedCheck's 2nd arg ──────────

describe("P3 edges — control.testFiles is captured and forwarded to runRedCheck (Gap 1b core)", () => {
	it("passes the tdd-guide control.testFiles verbatim as runRedCheck's 2nd argument", async () => {
		const files = ["tests/a.test.ts", "tests/b.test.ts", "src/c.spec.ts"];
		redCheck.mockImplementation(() => "red");
		const { ctx } = mkCtx({ tddControls: [{ testFiles: files }] });

		await (implementationStage as Stage).run(mkState(), ctx);

		expect(redCheck).toHaveBeenCalledTimes(1);
		// arg0 = worktreePath, arg1 = the captured testFiles, arg2 = opts
		expect(redCheck.mock.calls[0][0]).toBe("/tmp/sd-red-loop");
		expect(redCheck.mock.calls[0][1]).toEqual(files);
		expect(redCheck.mock.calls[0][2]).toMatchObject({ signal: undefined });
	});

	it("defaults testFiles to [] when tdd-guide returns no testFiles (degrade, never throw)", async () => {
		redCheck.mockImplementation(() => "unknown");
		const { ctx } = mkCtx({ tddControls: [{}] }); // no testFiles key

		await (implementationStage as Stage).run(mkState(), ctx);

		expect(redCheck).toHaveBeenCalledTimes(1);
		expect(redCheck.mock.calls[0][1]).toEqual([]);
	});
});

// ─── 2. Status-specific re-prompt hint wording ──────────────────────────────

describe("P3 edges — re-prompt tdd-guide carries the EXACT status-specific hint", () => {
	it("green → re-prompt appends the 'PASSED already / GENUINELY fails' hint", async () => {
		redCheck.mockImplementationOnce(() => "green").mockImplementationOnce(() => "red");
		const { ctx, tddCalls } = mkCtx({ tddControls: [{ testFiles: ["a.ts"] }, { testFiles: ["a.ts"] }] });

		await (implementationStage as Stage).run(mkState(), ctx);

		expect(tddCalls).toHaveLength(2);
		expect(tddCalls[0].prompt).not.toMatch(/PASSED already|GENUINELY/i); // initial: no hint
		expect(tddCalls[1].prompt).toMatch(/PASSED already/i);
		expect(tddCalls[1].prompt).toMatch(/GENUINELY/i);
	});

	it("broken → re-prompt appends the 'compile/collect' hint (distinct from the green hint)", async () => {
		redCheck.mockImplementationOnce(() => "broken").mockImplementationOnce(() => "red");
		const { ctx, tddCalls } = mkCtx({ tddControls: [{ testFiles: ["a.ts"] }, { testFiles: ["a.ts"] }] });

		await (implementationStage as Stage).run(mkState(), ctx);

		expect(tddCalls).toHaveLength(2);
		expect(tddCalls[1].prompt).toMatch(/compile\/collect/i);
		// The broken hint must NOT reuse the green hint text.
		expect(tddCalls[1].prompt).not.toMatch(/PASSED already/i);
	});
});

// ─── 3. Retry propagates NEW testFiles / falls back to prior ────────────────

describe("P3 edges — a retry's new control.testFiles propagate to the next oracle call", () => {
	it("uses the retry's NEW testFiles for the 2nd runRedCheck call (not the stale original)", async () => {
		redCheck.mockImplementationOnce(() => "green").mockImplementationOnce(() => "red");
		const { ctx } = mkCtx({
			tddControls: [{ testFiles: ["first.test.ts"] }, { testFiles: ["second.test.ts", "third.test.ts"] }],
		});

		await (implementationStage as Stage).run(mkState(), ctx);

		expect(redCheck).toHaveBeenCalledTimes(2);
		expect(redCheck.mock.calls[0][1]).toEqual(["first.test.ts"]);
		expect(redCheck.mock.calls[1][1]).toEqual(["second.test.ts", "third.test.ts"]);
	});

	it("falls back to the PRIOR testFiles when a retry returns no testFiles", async () => {
		redCheck.mockImplementationOnce(() => "green").mockImplementationOnce(() => "red");
		const { ctx } = mkCtx({
			tddControls: [{ testFiles: ["original.test.ts"] }, {}], // retry: no testFiles
		});

		await (implementationStage as Stage).run(mkState(), ctx);

		expect(redCheck).toHaveBeenCalledTimes(2);
		expect(redCheck.mock.calls[0][1]).toEqual(["original.test.ts"]);
		expect(redCheck.mock.calls[1][1]).toEqual(["original.test.ts"]); // fallback
	});
});

// ─── 4. Cap-exhausted / unknown implementer prompt wording ──────────────────

describe("P3 edges — implementer prompt reports the verified residual status exactly", () => {
	it("cap-exhausted (green) names '2 retries' and the green status; is NOT 'CONFIRMED-red'", async () => {
		redCheck.mockImplementation(() => "green"); // always green → cap exhaustion
		const { ctx, implCalls } = mkCtx();

		await (implementationStage as Stage).run(mkState(), ctx);

		expect(implCalls).toHaveLength(1);
		expect(implCalls[0].prompt).toMatch(/2 retries/i);
		expect(implCalls[0].prompt).toMatch(/still green/i);
		expect(implCalls[0].prompt).not.toMatch(/CONFIRMED-red/i);
	});

	it("cap-exhausted (broken) names '2 retries' and the broken status", async () => {
		redCheck.mockImplementation(() => "broken"); // always broken → cap exhaustion
		const { ctx, implCalls } = mkCtx();

		await (implementationStage as Stage).run(mkState(), ctx);

		expect(implCalls[0].prompt).toMatch(/2 retries/i);
		expect(implCalls[0].prompt).toMatch(/still broken/i);
	});

	it("unknown implementer prompt states the red was NOT confirmed (status: unknown)", async () => {
		redCheck.mockImplementation(() => "unknown");
		const { ctx, implCalls } = mkCtx();

		await (implementationStage as Stage).run(mkState(), ctx);

		expect(implCalls[0].prompt).toMatch(/could not be confirmed/i);
		expect(implCalls[0].prompt).toMatch(/unknown/i);
		expect(implCalls[0].prompt).not.toMatch(/CONFIRMED-red|2 retries/i);
	});
});

// ─── 5. Multi-phase isolation ───────────────────────────────────────────────

describe("P3 edges — each phase owns an independent red-oracle loop", () => {
	it("two phases each run their OWN red-oracle loop (per-phase testFiles, per-phase oracle)", async () => {
		// Both phases go red immediately.
		redCheck.mockImplementation(() => "red");
		const { ctx, tddCalls, implCalls } = mkCtx({
			tddControls: [{ testFiles: ["phase1.test.ts"] }, { testFiles: ["phase2.test.ts"] }],
		});

		await (implementationStage as Stage).run(mkState(2), ctx);

		// One initial tdd-guide call per phase, one oracle per phase, one impl per phase.
		expect(tddCalls).toHaveLength(2);
		expect(implCalls).toHaveLength(2);
		expect(redCheck).toHaveBeenCalledTimes(2);
		// Each phase's oracle was fed that phase's OWN testFiles.
		expect(redCheck.mock.calls[0][1]).toEqual(["phase1.test.ts"]);
		expect(redCheck.mock.calls[1][1]).toEqual(["phase2.test.ts"]);
	});

	it("a cap-exhausting phase 1 does NOT leak its retry state into phase 2 (phase 2 starts fresh)", async () => {
		// Phase 1: green→green→green (cap-exhausted after MAX_RED_RETRIES=2, i.e.
		// 1 initial + 2 retries = 3 oracle calls). Phase 2: red immediately (1 call).
		// Oracle call sequence: green, green, green (phase1), red (phase2) = 4 calls.
		redCheck
			.mockImplementationOnce(() => "green")
			.mockImplementationOnce(() => "green")
			.mockImplementationOnce(() => "green")
			.mockImplementationOnce(() => "red");
		const { ctx, tddCalls } = mkCtx({
			tddControls: [
				{ testFiles: ["p1.test.ts"] }, // phase1 initial
				{ testFiles: ["p1.test.ts"] }, // phase1 retry 1
				{ testFiles: ["p1.test.ts"] }, // phase1 retry 2
				{ testFiles: ["p2.test.ts"] }, // phase2 initial
			],
		});

		await (implementationStage as Stage).run(mkState(2), ctx);

		// phase1: initial + 2 retries = 3 tdd calls; phase2: initial only = 1.
		// Total 4 tdd-guide calls; the retry counter must have RESET between phases.
		expect(tddCalls).toHaveLength(4);
		// 4 oracle calls: 3 (phase1 cap) + 1 (phase2 red).
		expect(redCheck).toHaveBeenCalledTimes(4);
		expect(redCheck.mock.calls[3][1]).toEqual(["p2.test.ts"]);
	});
});
