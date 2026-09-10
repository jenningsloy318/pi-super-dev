/**
 * v0.3.85 F3 — bounded time and attempts (C5 fix; §9 F3 + §10 decisions 2 & 4
 * of docs/requirements/run-2026-09-09-poisoned-baseline-postmortem-v0.3.85.md).
 *
 * P8 binding — every bound gets a test that PROVOKES it with tiny env values
 * (the SUPER_DEV_JUDGE_TIMEOUT_MS=1 pattern): each loop × its bound × where it
 * is checked:
 *   - attempt cap      SUPER_DEV_MAX_PHASE_ATTEMPTS (default 4)  — before each new implementer attempt, per phase per §D entry
 *   - phase wall       SUPER_DEV_MAX_PHASE_WALL_MS   (default 90min) — before each new implementer attempt, anchored at phase start (resets on §D re-entry)
 *   - run wall fuse    SUPER_DEV_MAX_RUN_WALL_MS     (default 4h, 0=disable) — before each new implementer attempt AND at each phase boundary (wind-down: remaining < trailing-3-attempt median → no new attempt)
 *   - fault recurrence SUPER_DEV_FAULT_RECURRENCE    (default 3)  — at the failure-recording site, GREEN side only
 *
 * Wall-clock provocation: wall time is NOT injectable in the stage, so the
 * tests use tiny budgets (1ms) plus a delayed fake implementer (real timers)
 * — provokable and deterministic within ≥1 attempt. The pure helpers
 * (trailingMedian / runFuseWindDown / deriveRunStatus) get exact-value tests.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Per-call gate/deliverable queues (shifted), mirroring the §D harness.
let gateQ: Array<Record<string, unknown>> = [];
let deliverableQ: Array<Record<string, unknown>> = [];
const PASS_GATE = { pass: true, buildSuccess: true, allTestsPass: true, typecheckSuccess: true, inScopePass: true, errors: [] as string[], outOfScopeErrors: [] as string[], ran: ["npm test"] };
const DELIV_PASS = { pass: true, missing: [] as string[], ran: [] as string[] };

vi.mock("../src/build-runner.ts", async (orig) => {
	const a = (await orig()) as Record<string, unknown>;
	return {
		...a,
		runRedCheck: () => "unknown",
		runBuildGate: () => gateQ.shift() ?? PASS_GATE,
		runDeliverableCheck: () => deliverableQ.shift() ?? DELIV_PASS,
		computeChangeGate: () => ({ pass: true, claimedNotChanged: [], changedNotClaimed: [], advisory: [] }),
		resetDeliverableCheckCache: () => {},
	};
});
vi.mock("../src/render/render.ts", () => ({ renderAndWrite: vi.fn() }));
vi.mock("../src/render/reflection.ts", () => ({ runReflectionAsync: vi.fn() }));
vi.mock("../src/render/user-notes.ts", () => ({ userNotesForAgent: vi.fn(() => "") }));

import { implementationStage, maxPhaseAttempts, phaseWallBudgetMs, faultRecurrenceLimit } from "../src/stages/implementation.ts";
import { runWallFuseMs, trailingMedian, runFuseWindDown, freshRunWallFuseState, markRunWallFuseTripped, readRunWallFuseMarker, type RunWallFuseState } from "../src/wall-fuse.ts";
import { deriveRunStatus, makeContext } from "../src/workflow.ts";
import type { PipelineState, StageContext, RunOptions, AgentResult, AgentCall, ControlObj, HelperResult } from "../src/types.ts";

// ─── fixtures ───────────────────────────────────────────────────────────────

const mkState = (phases: Array<{ name: string; deliverables?: unknown }> = [{ name: "Phase A" }]): PipelineState => ({
	setup: { worktreePath: "/tmp/sd-bounds", specDirectory: "/tmp/sd", defaultBranch: "main", language: "frontend", isWebUi: false, specIdentifier: "b", worktreeCreated: false, initializedRepo: false },
	classify: { taskType: "feature", uiScope: "none", language: "frontend", isWebUi: false },
	spec: { phases },
} as unknown as PipelineState);

/** A genuine IN-SCOPE gate failure → classifyGateFault says `product-defect`
 *  (row 1: a non-out-of-scope error is present). Distinct text per attempt so
 *  the exact (failure, footprint) signature never repeats. */
const prodFail = (n: number) => ({
	pass: false, buildSuccess: false, allTestsPass: false, typecheckSuccess: false, inScopePass: false,
	errors: [`bounds product failure #${n}: error kind ${n}`], outOfScopeErrors: [] as string[], ran: ["npm test"],
});

/** Alternate product/unclassified classes (defeats the recurrence valve at its
 *  default 3) with fresh signatures and fresh footprints — isolates whichever
 *  TIME/attempt bound is under test. Every attempt fails (odd: in-scope gate
 *  error → `product-defect`; even: green gate + failing deliverable → gate.errors
 *  empty → `unclassified`); runDeliverableCheck is called once per attempt, so
 *  one deliverable failure is queued per attempt. Returns the gate queue. */
const alternatingFails = (count: number): Array<Record<string, unknown>> => {
	const gates: Array<Record<string, unknown>> = [];
	for (let i = 1; i <= count; i++) {
		if (i % 2 === 1) gates.push(prodFail(i) as Record<string, unknown>);
		else gates.push({ ...PASS_GATE });
		deliverableQ.push({ pass: false, missing: [`missing file: src/bounds-${i}.ts`], ran: [`file:src/bounds-${i}.ts`] });
	}
	return gates;
};

/** Fresh footprints per attempt (the implementer claims a different file each
 *  time — C5's varying-approach shape). */
const freshImpls = (count: number) => Array.from({ length: count }, (_, i) => ({ control: { filesModified: [`src/bounds-impl-${i + 1}.ts`] } }));

interface CtxOpts {
	/** Real-timer delay applied to every implementer call (wall-clock provocation). */
	implDelayMs?: number;
	/** The run-pass wall-fuse surface (mirrors makeContext's ctx.wallFuse). */
	wallFuse?: RunWallFuseState;
}

const mkCtx = (opts: CtxOpts = {}) => {
	const logs: string[] = [];
	const implCalls: AgentCall[] = [];
	const implQueue = [...freshImpls(12)];
	const ctx: StageContext = {
		task: "bounds", options: {} as RunOptions, state: {} as PipelineState,
		async helper(): Promise<HelperResult> { return { value: { languageInstructions: "" } as ControlObj, digest: "" }; },
		async agent(call): Promise<AgentResult> {
			if (call.agent === "implementer") {
				implCalls.push(call);
				if (opts.implDelayMs) await new Promise<void>((r) => setTimeout(r, opts.implDelayMs));
				const scripted = implQueue.shift();
				return { text: "ok", control: scripted?.control ?? {} };
			}
			return { text: "ok", control: {} };
		},
		parallel: async (cs: Array<() => Promise<AgentResult>>) => Promise.all(cs.map((c) => c())),
		budget: { check: () => true, spent: () => true, count: 0 },
		log: (message: string) => { logs.push(message); }, phase: () => {}, events: { on: () => () => {}, emit: () => {} } as never, results: [],
	};
	if (opts.wallFuse) ctx.wallFuse = opts.wallFuse;
	return { ctx, logs, implCalls };
};

const hasLog = (logs: string[], needle: string) => logs.some((l) => l.includes(needle));

const ENV_KEYS = ["SUPER_DEV_MAX_PHASE_ATTEMPTS", "SUPER_DEV_MAX_PHASE_WALL_MS", "SUPER_DEV_MAX_RUN_WALL_MS", "SUPER_DEV_FAULT_RECURRENCE"] as const;

beforeEach(() => {
	gateQ = [];
	deliverableQ = [];
});
afterEach(() => {
	for (const k of ENV_KEYS) delete process.env[k];
});

// ─── defaults (lazy env readers) ────────────────────────────────────────────

describe("F3 bounds — defaults and env overrides", () => {
	it("defaults per §10 decisions 2 & 4: attempts=4, phase wall=90min, fault recurrence=3, run fuse=4h; run fuse 0 disables", () => {
		expect(maxPhaseAttempts()).toBe(4);
		expect(phaseWallBudgetMs()).toBe(5_400_000);
		expect(faultRecurrenceLimit()).toBe(3);
		expect(runWallFuseMs()).toBe(14_400_000);
		process.env.SUPER_DEV_MAX_RUN_WALL_MS = "0";
		expect(runWallFuseMs()).toBe(0);
		process.env.SUPER_DEV_MAX_RUN_WALL_MS = "3600000";
		expect(runWallFuseMs()).toBe(3_600_000);
		process.env.SUPER_DEV_MAX_PHASE_ATTEMPTS = "2";
		expect(maxPhaseAttempts()).toBe(2);
		process.env.SUPER_DEV_MAX_PHASE_WALL_MS = "1";
		expect(phaseWallBudgetMs()).toBe(1);
		process.env.SUPER_DEV_FAULT_RECURRENCE = "2";
		expect(faultRecurrenceLimit()).toBe(2);
	});
});

// ─── pure helpers ───────────────────────────────────────────────────────────

describe("F3 run-fuse helpers (pure)", () => {
	it("trailingMedian: odd/even windows, no samples, window cap", () => {
		expect(trailingMedian([], 3)).toBeNull();
		expect(trailingMedian([10], 3)).toBe(10);
		expect(trailingMedian([10, 20], 3)).toBe(15);
		expect(trailingMedian([1, 2, 3], 3)).toBe(2);
		expect(trailingMedian([5, 1, 9, 3], 3)).toBe(3); // last 3 = [1,9,3] → sorted [1,3,9] → 3
	});

	it("runFuseWindDown: disabled (0) never blocks; exhausted blocks; median arm blocks when remaining < trailing median; fresh window does not", () => {
		const now = 10_000;
		const fuse = freshRunWallFuseState(1_000);
		expect(runFuseWindDown(fuse, [500], now, 0)).toEqual({ blocked: false, why: "" });
		const exhausted = runFuseWindDown(fuse, [], 6_000, 5_000);
		expect(exhausted.blocked).toBe(true);
		expect(exhausted.why).toContain("run wall budget exhausted");
		// Fix-round 1 fixture arithmetic: the median arm needs remaining < median —
		// median([400,600,800])=600, so startedAt=0 / now=4_500 / cap=5_000 gives
		// remaining 500 < 600 (the old fixture reused startedAt=1_000, making
		// remaining 1_500 ≥ 600 and never exercising the arm).
		const medianFuse = freshRunWallFuseState(0);
		const medianArm = runFuseWindDown(medianFuse, [400, 600, 800], 4_500, 5_000); // remaining 500 < median 600
		expect(medianArm.blocked).toBe(true);
		expect(medianArm.why).toContain("trailing-3-attempt median duration 600ms");
		const funded = runFuseWindDown(medianFuse, [400, 600, 800], 4_300, 5_000); // remaining 700 >= median 600 → the attempt is funded
		expect(funded).toEqual({ blocked: false, why: "" });
	});
});

// ─── attempt cap (P8: tiny env value) ───────────────────────────────────────

describe("F3 attempt cap — SUPER_DEV_MAX_PHASE_ATTEMPTS=2 provocation", () => {
	it("ends the phase partial with the NAMED reason `phase-attempt-cap` after exactly 2 implementer attempts (RED sub-loop not counted; classes alternate so no other bound fires)", async () => {
		process.env.SUPER_DEV_MAX_PHASE_ATTEMPTS = "2";
		gateQ = alternatingFails(6);
		const state = mkState();
		const { ctx, logs, implCalls } = mkCtx();
		const out = (await implementationStage.run(state, ctx)) as unknown as {
			allGreen: boolean; convergenceBlocked?: boolean;
			phaseStatus: Array<{ id: string; status: string }>;
			lastFailures: Array<{ phaseId: string; reasons: string[] }>;
		};

		expect(implCalls).toHaveLength(2); // exactly the cap — attempt 3 never starts
		expect(hasLog(logs, "partial after 2 attempt(s) (phase-attempt-cap) — continuing to the next phase")).toBe(true);
		expect(hasLog(logs, "attempt cap reached (2 implementer attempts per phase per §D entry)")).toBe(true);
		expect(out.allGreen).toBe(false);
		expect(out.phaseStatus[0]).toMatchObject({ id: "phase-01", status: "partial" });
		expect(out.lastFailures[0]!.reasons.some((r) => r.startsWith("phase-attempt-cap:"))).toBe(true);
		// The cap is per-phase, not run-level: it must NOT block §D re-entry.
		expect(out.convergenceBlocked).toBeFalsy();
		// The other bounds did not fire.
		expect(hasLog(logs, "no progress")).toBe(false);
		expect(hasLog(logs, "phase wall budget exhausted")).toBe(false);
	});

	it("resets on §D re-entry: a second stage pass over shared state gets its own 2 attempts (4 total)", async () => {
		process.env.SUPER_DEV_MAX_PHASE_ATTEMPTS = "2";
		const state = mkState();
		const r1 = mkCtx();
		gateQ = alternatingFails(6);
		const out1 = (await implementationStage.run(state, r1.ctx)) as unknown as Record<string, unknown>;
		(state as unknown as Record<string, unknown>).implementation = out1;

		// §D re-entry: fresh failures, fresh cap (beforeEach already reset the queues).
		gateQ = alternatingFails(6);
		const r2 = mkCtx();
		const out2 = (await implementationStage.run(state, r2.ctx)) as unknown as { phaseStatus: Array<{ id: string; status: string }> };
		expect(r1.implCalls).toHaveLength(2);
		expect(r2.implCalls).toHaveLength(2); // the re-entry's OWN attempt budget — the cap counts per §D entry
		expect(out2.phaseStatus[0]).toMatchObject({ id: "phase-01", status: "partial" });
	});
});

// ─── phase wall (P8: tiny env value + delayed fake implementer) ─────────────

describe("F3 phase wall — SUPER_DEV_MAX_PHASE_WALL_MS=1 provocation", () => {
	it("ends the phase partial via the per-phase wall before any other bound (fresh signatures, alternating classes)", async () => {
		process.env.SUPER_DEV_MAX_PHASE_WALL_MS = "1";
		gateQ = alternatingFails(8);
		const { ctx, logs, implCalls } = mkCtx({ implDelayMs: 3 });
		const out = (await implementationStage.run(mkState(), ctx)) as unknown as { allGreen: boolean; phaseStatus: Array<{ id: string; status: string }> };

		expect(implCalls.length).toBeGreaterThanOrEqual(1);
		expect(implCalls.length).toBeLessThanOrEqual(2); // attempt 1 consumes ≥3ms; the 1ms wall blocks attempt 2
		expect(hasLog(logs, "phase wall budget exhausted (1ms since phase start) — ending the phase partial (phase-wall)")).toBe(true);
		expect(hasLog(logs, "partial after")).toBe(true);
		expect(logs.some((l) => /partial after \d+ attempt\(s\) \(phase wall budget exhausted\)/.test(l))).toBe(true);
		expect(out.allGreen).toBe(false);
		expect(out.phaseStatus[0]).toMatchObject({ id: "phase-01", status: "partial" });
		// Isolation: neither the cap (default 4) nor recurrence (default 3) fired.
		expect(hasLog(logs, "phase-attempt-cap")).toBe(false);
		expect(hasLog(logs, "no progress")).toBe(false);
	});
});

// ─── run wall fuse — attempt-level wind-down (P8: small env value) ──────────

describe("F3 run wall fuse — SUPER_DEV_MAX_RUN_WALL_MS=200 provocation (attempt boundary)", () => {
	it("stops starting new attempts once the fuse cannot fund one (remaining < trailing-3-attempt median); phase partial (wall-fuse); state marker set; §D re-entry blocked", async () => {
		process.env.SUPER_DEV_MAX_RUN_WALL_MS = "200";
		process.env.SUPER_DEV_MAX_PHASE_ATTEMPTS = "8"; // isolate the fuse from the cap
		gateQ = alternatingFails(10);
		const state = mkState();
		const { ctx, logs, implCalls } = mkCtx({ implDelayMs: 40 });
		const out = (await implementationStage.run(state, ctx)) as unknown as { allGreen: boolean; convergenceBlocked?: boolean; phaseStatus: Array<{ id: string; status: string }> };

		expect(implCalls.length).toBeGreaterThanOrEqual(1); // at least one attempt ran (0 only if stage entry alone consumed the window)
		expect(implCalls.length).toBeLessThanOrEqual(7); // the fuse fired well before the cap of 8
		expect(logs.some((l) => /wall fuse before attempt \d+ —/.test(l))).toBe(true);
		expect(logs.some((l) => /partial after \d+ attempt\(s\) \(wall-fuse — run wall budget exhausted; resumable by design\)/.test(l))).toBe(true);
		expect(out.allGreen).toBe(false);
		expect(out.convergenceBlocked).toBe(true); // re-entry is pointless this pass — a fresh window exists only on resume
		// The terminal-state channel: the state marker deriveRunStatus reads.
		expect(readRunWallFuseMarker(state)).toBeDefined();
	});
});

// ─── run wall fuse — phase-boundary deferral (injected ctx.wallFuse window) ─

describe("F3 run wall fuse — phase-boundary check (decision 2 wind-down)", () => {
	it("defers the remaining phase(s) at the boundary when remaining < trailing-attempt median — phase-02 never starts, converged phase-01 stays green and committed", async () => {
		process.env.SUPER_DEV_MAX_RUN_WALL_MS = "1000";
		// Inject the run-pass window (the makeContext surface): 500ms already
		// elapsed → ~500ms remaining. Phase-01's attempt (~300ms via the delayed
		// fake implementer) fits; at the phase-02 boundary remaining (~200ms) is
		// below the trailing median (~300ms) → defer.
		const state = mkState([{ name: "Phase A" }, { name: "Phase B" }]);
		const { ctx, logs, implCalls } = mkCtx({ implDelayMs: 300, wallFuse: { startedAt: Date.now() - 500, tripped: false, tripReason: "" } });
		const out = (await implementationStage.run(state, ctx)) as unknown as { allGreen: boolean; convergenceBlocked?: boolean; phasesCompleted: number; phaseStatus: Array<{ id: string; status: string }> };

		expect(implCalls.filter((c) => c.id.includes("phase-01"))).toHaveLength(1); // phase-01 ran and went green
		expect(implCalls.some((c) => c.id.includes("phase-02"))).toBe(false); // deferred — never dispatched
		expect(hasLog(logs, "wall fuse at the phase-02 boundary")).toBe(true);
		expect(hasLog(logs, "deferring remaining phase(s) (1 of 2) to the resumed pass (fresh fuse window); converged phases stay committed")).toBe(true);
		expect(out.phaseStatus).toEqual([{ id: "phase-01", status: "green", attempts: 1 }]); // v0.3.85 S3: peak-attempts field
		expect(out.allGreen).toBe(false);
		expect(out.convergenceBlocked).toBe(true);
		expect(readRunWallFuseMarker(state)).toBeDefined();
	});
});

// ─── fault-category recurrence valve (P8: tiny env value) ───────────────────

describe("F3 failure-category recurrence — SUPER_DEV_FAULT_RECURRENCE=2 provocation", () => {
	it("same FaultClass across 2 consecutive attempts with FRESH footprints trips the existing no-progress valve (C5: exact-signature matching missed this)", async () => {
		process.env.SUPER_DEV_FAULT_RECURRENCE = "2";
		gateQ = [prodFail(1), prodFail(2), prodFail(3)] as Array<Record<string, unknown>>;
		const { ctx, logs, implCalls } = mkCtx();
		const out = (await implementationStage.run(mkState(), ctx)) as unknown as { allGreen: boolean; phaseStatus: Array<{ id: string; status: string }> };

		expect(implCalls).toHaveLength(2); // attempt 2 records product-defect × 2 → valve
		expect(hasLog(logs, "failure-category recurrence (product-defect × 2 consecutive attempts — fresh footprints, same class)")).toBe(true);
		expect(hasLog(logs, "partial after 2 attempt(s) (no progress) — continuing to the next phase")).toBe(true);
		expect(out.allGreen).toBe(false);
		expect(out.phaseStatus[0]).toMatchObject({ id: "phase-01", status: "partial" });
	});

	it("resets on a non-matching FaultClass: alternating product/unclassified never reaches the streak; the loop converges on attempt 4", async () => {
		process.env.SUPER_DEV_FAULT_RECURRENCE = "2";
		gateQ = alternatingFails(3);
		gateQ.push({ ...PASS_GATE });
		const { ctx, logs, implCalls } = mkCtx();
		const out = (await implementationStage.run(mkState(), ctx)) as unknown as { allGreen: boolean };

		expect(implCalls).toHaveLength(4); // p(1), u(1), p(1) — streak never ≥2 — then green
		expect(hasLog(logs, "failure-category recurrence")).toBe(false);
		expect(out.allGreen).toBe(true);
	});
});

// ─── pre-call seam (other stages' convergence loops) ────────────────────────

describe("F3 run wall fuse — pre-call seam (realAgent, the budget-check seam)", () => {
	afterEach(() => { delete process.env.SUPER_DEV_MAX_RUN_WALL_MS; });

	it("fails calls closed with an honest wall-fuse error once the window is spent, and stamps the state marker; ctx.wallFuse is the surfaced window", async () => {
		process.env.SUPER_DEV_MAX_RUN_WALL_MS = "1";
		const state = {} as PipelineState;
		const logs: string[] = [];
		const ctx = makeContext(state, "bounds-seam", {} as RunOptions, (m) => logs.push(m));
		expect(typeof ctx.wallFuse?.startedAt).toBe("number"); // the budget-mirroring surface exists
		await new Promise<void>((r) => setTimeout(r, 3));
		const out = await ctx.agent({ id: "pipeline.x.impl", agent: "implementer", prompt: "p" } as AgentCall);
		expect(out.control).toBeNull();
		expect(out.error).toContain("wall fuse tripped");
		expect(out.error).toContain("SUPER_DEV_MAX_RUN_WALL_MS");
		expect(logs.some((l) => l.includes("wall fuse tripped"))).toBe(true);
		expect(readRunWallFuseMarker(ctx.state)).toBeDefined();
	});
});

// ─── terminal state derivation ──────────────────────────────────────────────

describe("F3 terminal state — deriveRunStatus maps the wall-fuse marker to `partial (wall-fuse)`", () => {
	const fuseState = (): PipelineState => {
		const s = mkState();
		(s as unknown as Record<string, unknown>).implementation = { totalPhases: 2, phasesCompleted: 1, allGreen: false, phaseStatus: [{ id: "phase-01", status: "green" }, { id: "phase-02", status: "partial" }] };
		return s;
	};

	it("not aborted + marker → partial with the named reason (DISTINCT from FatalAbort bug class)", () => {
		const s = fuseState();
		markRunWallFuseTripped(s, 14_400_000, "attempt boundary phase-02 attempt 3: test trip");
		const d = deriveRunStatus({ results: [], state: s, aborted: false });
		expect(d.status).toBe("partial");
		expect(d.statusReasons[0]).toContain("partial (wall-fuse)");
		expect(d.statusReasons[0]).toContain("FRESH fuse window");
	});

	it("aborted via a fuse-blocked agent cascade (non-cancel abortError) + marker → STILL partial (wall-fuse), never failed", () => {
		const s = fuseState();
		markRunWallFuseTripped(s, 14_400_000, "pre-call: test trip");
		const d = deriveRunStatus({ results: [], state: s, aborted: true, abortError: "verification convergence did not converge within 3 round(s)" });
		expect(d.status).toBe("partial");
		expect(d.statusReasons[0]).toContain("partial (wall-fuse)");
	});

	it("user cancellation outranks the marker → failed (the cancel is the terminal fact)", () => {
		const s = fuseState();
		markRunWallFuseTripped(s, 14_400_000, "test trip");
		const d = deriveRunStatus({ results: [], state: s, aborted: true, abortError: "workflow cancelled" });
		expect(d.status).toBe("failed");
	});

	it("a fully-converged run stays success even with a marker (the fuse did not end it); no marker → today's derivation unchanged", () => {
		const green = mkState();
		const g = green as unknown as Record<string, unknown>;
		g.implementation = { totalPhases: 1, phasesCompleted: 1, allGreen: true };
		g.review = { verdict: "Approved" };
		g.buildGate = { pass: true };
		markRunWallFuseTripped(green, 14_400_000, "late trip after convergence");
		const d = deriveRunStatus({ results: [{ id: "x", status: "ok" }], state: green, aborted: false });
		expect(d.status).toBe("success");
		const plain = deriveRunStatus({ results: [], state: fuseState(), aborted: false });
		expect(plain.status).toBe("partial");
		expect(plain.statusReasons.some((r) => r.includes("wall-fuse"))).toBe(false);
	});
});
