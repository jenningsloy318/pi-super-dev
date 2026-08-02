/**
 * Phase P3 — RED enforcement loop edge cases (AC-02 → SCENARIO-006/007/008/009/010).
 *
 * This is the ANTI-HARDCODING strengthening companion to
 * `tests/implementation-red-loop.test.ts`. The sibling suite asserts the RED
 * loop's *structure* (call-counts, the CONFIRMED-red flag, and hard blocking of
 * unconfirmed RED). It does NOT assert the load-bearing DATA-FLOW edges of the
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
 *   6. Cap-exhausted green/broken RED blocks the implementer instead of handing
 *      weak/broken tests to GREEN.
 *   7. The `unknown` implementer prompt states the red was NOT confirmed.
 *   8. RED pollution (production edits during test-authoring) is detected,
 *      written to `implementation-evidence.jsonl`, and rolled back.
 *   9. Already-satisfied green RED can skip implementation only when baseline
 *      deliverables verify.
 *  10. Multi-phase: each phase owns an INDEPENDENT red-oracle loop.
 *
 * Hermeticity mirrors the sibling suite: only side-effecting imports
 * (`runRedCheck`/`runBuildGate`, `renderAndWrite`) are mocked; `ctx.agent` /
 * `ctx.helper` are pure scripted closures. No `pi` subprocess, no network, no
 * disk.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
vi.mock("../src/build-runner.ts", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return {
		...actual,
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
	};
});

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
function mkCtx(opts: { tddControls?: ControlObj[]; onTddCall?: (call: AgentCall, index: number) => void } = {}): { ctx: StageContext; tddCalls: AgentCall[]; implCalls: AgentCall[]; logs: string[] } {
	const queue = [...(opts.tddControls ?? [DEFAULT_TDD_CONTROL])];
	const tddCalls: AgentCall[] = [];
	const implCalls: AgentCall[] = [];
	const logs: string[] = [];
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
				opts.onTddCall?.(call, tddCalls.length);
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
		budget: { count: 0, check: () => true, spent() { this.count++; return true; } } satisfies Budget,
		log(message: string) { logs.push(message); },
		phase() {},
		events: new EventEmitter(),
		results: [],
	};
	return { ctx, tddCalls, implCalls, logs };
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

// ─── 4. Cap-exhausted / unknown implementer behavior ───────────────────────

describe("P3 edges — unconfirmed RED blocks the implementer, unknown still degrades", () => {
	it("cap-exhausted (green) does not call the implementer", async () => {
		redCheck.mockImplementation(() => "green"); // always green → cap exhaustion
		const { ctx, implCalls, logs } = mkCtx();

		await (implementationStage as Stage).run(mkState(), ctx);

		expect(implCalls).toHaveLength(0);
		expect(logs.some((l) => /red-not-confirmed/i.test(l))).toBe(true);
	});

	it("cap-exhausted (broken) does not call the implementer", async () => {
		redCheck.mockImplementation(() => "broken"); // always broken → cap exhaustion
		const { ctx, implCalls, logs } = mkCtx();

		await (implementationStage as Stage).run(mkState(), ctx);

		expect(implCalls).toHaveLength(0);
		expect(logs.some((l) => /red-broken/i.test(l))).toBe(true);
	});

	it("unknown implementer prompt states the red was NOT confirmed (status: unknown)", async () => {
		redCheck.mockImplementation(() => "unknown");
		const { ctx, implCalls } = mkCtx();

		await (implementationStage as Stage).run(mkState(), ctx);

		expect(implCalls[0].prompt).toMatch(/could not be confirmed/i);
		expect(implCalls[0].prompt).toMatch(/unknown/i);
		expect(implCalls[0].prompt).not.toMatch(/CONFIRMED-red|4 retries/i);
	});
});

describe("P3 edges — RED pollution is detected and rolled back", () => {
	it("a RED agent that writes production code is classified polluted-red and never reaches implementer", async () => {
		const dir = mkdtempSync(join(tmpdir(), "sd-red-polluted-"));
		try {
			execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
			execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
			execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });
			mkdirSync(join(dir, "src"), { recursive: true });
			writeFileSync(join(dir, "src", "baseline.ts"), "export const baseline = true;\n");
			execFileSync("git", ["add", "."], { cwd: dir });
			execFileSync("git", ["commit", "-m", "baseline"], { cwd: dir, stdio: "ignore" });
			redCheck.mockImplementation(() => "red");
			const state = mkState();
			state.setup!.worktreePath = dir;
			state.setup!.specDirectory = join(dir, "docs", "specifications", "polluted");
			const { ctx, implCalls, logs } = mkCtx({
				tddControls: [{ testFiles: ["tests/red.test.ts"] }],
				onTddCall: () => writeFileSync(join(dir, "src", "prod.ts"), "export const polluted = true;\n"),
			});

			const res = (await (implementationStage as Stage).run(state, ctx)) as ControlObj;

			expect(implCalls).toHaveLength(0);
			expect(res.allGreen).toBe(false);
			expect(logs.some((l) => /red-polluted/i.test(l))).toBe(true);
			expect(existsSync(join(dir, "src", "prod.ts"))).toBe(false);
			const evidence = readFileSync(join(state.setup!.specDirectory, "implementation-evidence.jsonl"), "utf8");
			expect(evidence).toMatch(/"status":"polluted-red"/);
			expect(evidence).toMatch(/src\/prod\.ts/);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
	it("green RED can only skip implementation when baseline deliverables are already satisfied and verified", async () => {
		const dir = mkdtempSync(join(tmpdir(), "sd-red-satisfied-"));
		try {
			mkdirSync(join(dir, "src"), { recursive: true });
			writeFileSync(join(dir, "src", "existing.ts"), "export const existing = true;\n");
			redCheck.mockImplementation(() => "green");
			const state = mkState();
			state.setup!.worktreePath = dir;
			state.setup!.specDirectory = join(dir, "docs", "specifications", "satisfied");
			(state.spec!.phases as Array<Record<string, unknown>>)[0].deliverables = { requireFiles: ["src/existing.ts"] };
			const { ctx, implCalls, logs } = mkCtx();

			const res = (await (implementationStage as Stage).run(state, ctx)) as ControlObj;

			expect(implCalls).toHaveLength(0);
			expect(res.allGreen).toBe(true);
			expect(res.phasesCompleted).toBe(1);
			expect(logs.some((l) => /RED already-satisfied: build=true, deliverables=true/i.test(l))).toBe(true);
			const evidence = readFileSync(join(state.setup!.specDirectory, "implementation-evidence.jsonl"), "utf8");
			expect(evidence).toMatch(/"status":"green-already-satisfied"/);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
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

	it("a cap-exhausting phase 1 fails fast instead of leaking retry state into phase 2", async () => {
		// Phase 1: five green results (cap-exhausted after MAX_RED_RETRIES=4, i.e.
		// 1 initial + 4 retries = 5 oracle calls). Because unconfirmed RED is now a
		// hard phase gate, phase 2 must not start.
		redCheck
			.mockImplementationOnce(() => "green")
			.mockImplementationOnce(() => "green")
			.mockImplementationOnce(() => "green")
			.mockImplementationOnce(() => "green")
			.mockImplementationOnce(() => "green")
			.mockImplementationOnce(() => "red");
		const { ctx, tddCalls, implCalls, logs } = mkCtx({
			tddControls: [
				{ testFiles: ["p1.test.ts"] }, // phase1 initial
				{ testFiles: ["p1.test.ts"] }, // phase1 retry 1
				{ testFiles: ["p1.test.ts"] }, // phase1 retry 2
				{ testFiles: ["p1.test.ts"] }, // phase1 retry 3
				{ testFiles: ["p1.test.ts"] }, // phase1 retry 4
				{ testFiles: ["p2.test.ts"] }, // would be phase2 initial if phase1 passed
			],
		});

		const res = (await (implementationStage as Stage).run(mkState(2), ctx)) as ControlObj;

		expect(tddCalls).toHaveLength(5);
		expect(implCalls).toHaveLength(0);
		expect(redCheck).toHaveBeenCalledTimes(5);
		expect(res.phasesCompleted).toBe(0);
		expect(res.allGreen).toBe(false);
		expect(logs.some((l) => /red-not-confirmed/i.test(l))).toBe(true);
	});
});
