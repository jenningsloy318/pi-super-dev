/**
 * Stage 9 — Implementation retry loop, Phase 5 (AC-05).
 *
 * In-scope verdict: the phase must go GREEN when `gate.pass || gate.inScopePass`,
 * logging the ignored pre-existing out-of-scope failures, and terminate-early
 * ONLY on genuine in-scope failures (neither pass nor inScopePass after
 * MAX_ATTEMPTS). Covers AC-05 → SCENARIO-012/013/014/025/027.
 *
 * `runBuildGate` is fully stubbed via `vi.mock("../build-runner.ts")` so the
 * stage exercises only its retry/verdict logic — no real git/cargo. The ctx
 * `agent`/`helper`/`budget`/`log` primitives are fakes; `log` lines are captured
 * for assertion. No real agents spawn; no disk writes (summary returns
 * control:null so renderAndWrite is a no-op).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { PipelineState, StageContext, AgentCall, AgentResult, ControlObj } from "../types.ts";

// --- runBuildGate stub ------------------------------------------------------
// The factory is hoisted so it is in place before the module under test loads.
// Each test seeds `mock.result` (single value) or `mock.results` (per-attempt
// queue) to drive the verdict branch under test.
const mock = vi.hoisted(() => ({
	result: null as null | Record<string, unknown>,
	results: null as null | Record<string, unknown>[],
	calls: 0,
}));

vi.mock("../build-runner.ts", () => ({
	// RED oracle (Gap 1b/AC-02): the stage now calls runRedCheck on the
	// tdd-guide result's `testFiles`. Stub it to "unknown" — the greenfield-safe
	// status — so the RED loop issues ZERO re-prompts and proceeds immediately,
	// keeping these in-scope-verdict assertions (gate call counts, log lines)
	// exactly as before the RED loop was wired. See tests/implementation-red-loop*.test.ts
	// for the RED-loop-specific runRedCheck scripting.
	runRedCheck: (_cwd: string, _targets?: unknown, _opts?: unknown): string => "unknown",
	runBuildGate: (_cwd: string, _opts?: unknown) => {
		mock.calls++;
		if (mock.results && mock.results.length) return mock.results.shift();
		if (mock.result) return { ...mock.result };
		return { pass: true, buildSuccess: true, allTestsPass: true, typecheckSuccess: true, ran: [], errors: [], outOfScopeErrors: [], inScopePass: true };
	},
}));

import { implementationStage } from "./implementation.ts";

// --- fixture gate results ---------------------------------------------------
/** A clean PASS (gate.pass true) — normal GREEN path. SCENARIO-014. */
const GATE_PASS = {
	pass: true,
	buildSuccess: true,
	allTestsPass: true,
	typecheckSuccess: true,
	ran: ["cargo build", "cargo test", "cargo clippy"],
	errors: [],
	outOfScopeErrors: [],
	inScopePass: true,
};
/**
 * Gate failed but EVERY failure is a pre-existing out-of-scope crate (e.g.
 * `compute`, never touched by this branch) → inScopePass true. SCENARIO-012/025.
 */
const GATE_INSCOPE_PASS = {
	pass: false,
	buildSuccess: false,
	allTestsPass: false,
	typecheckSuccess: false,
	ran: ["cargo build", "cargo test", "cargo clippy"],
	errors: ["error[E0308]: mismatched types --> crates/compute/src/jobs.rs:42:10"],
	outOfScopeErrors: ["error[E0308]: mismatched types --> crates/compute/src/jobs.rs:42:10"],
	inScopePass: true,
};
/** Gate failed on a genuine IN-SCOPE crate (`data` was touched) → real FAIL. */
const GATE_GENUINE_FAIL = {
	pass: false,
	buildSuccess: false,
	allTestsPass: false,
	typecheckSuccess: false,
	ran: ["cargo build", "cargo test", "cargo clippy"],
	errors: ["error[E0308]: mismatched types --> crates/data/src/lib.rs:7:3"],
	outOfScopeErrors: [],
	inScopePass: false,
};

// --- fake ctx / state -------------------------------------------------------
interface FakeCtx {
	logs: string[];
	agentIds: string[];
}

/** Build a minimal PipelineState with one or more phases. */
function makeState(phases: Array<{ name: string; description?: string }>): PipelineState {
	return {
		task: "t",
		options: {} as never,
		setup: {
			worktreePath: "/tmp/fake-worktree",
			specDirectory: "/tmp/fake-spec",
			defaultBranch: "main",
			language: "frontend",
			isWebUi: false,
			specIdentifier: "03",
			worktreeCreated: false,
			initializedRepo: false,
		},
		classify: { taskType: "bug", uiScope: "none", language: "frontend", isWebUi: false },
		spec: { phases },
	} as unknown as PipelineState;
}

/** Build a fake StageContext that records logs + agent ids and never spawns. */
function makeCtx(): { ctx: StageContext; fake: FakeCtx } {
	const fake: FakeCtx = { logs: [], agentIds: [] };
	const ctx = {
		task: "t",
		options: {},
		state: {} as PipelineState,
		budget: { check: () => true, spent: () => {}, count: 0 },
		log: (m: string) => {
			fake.logs.push(m);
		},
		events: { on() {}, off() {}, emit() {} },
		results: [],
		signal: undefined,
		async agent(call: AgentCall): Promise<AgentResult> {
			fake.agentIds.push(call.id);
			// summary renders via renderAndWrite → return null control so it is a
			// no-op (no disk write, no validation noise).
			if (call.id.includes("summary")) return { text: "", control: null };
			// implementer reports files modified.
			if (call.agent === "implementer") return { text: "", control: { filesModified: ["src/foo.ts"] } };
			return { text: "", control: {} as ControlObj };
		},
		async helper() {
			return { value: { languageInstructions: "" } as ControlObj, digest: "" };
		},
		async parallel() {
			return [];
		},
	} as unknown as StageContext;
	return { ctx, fake };
}

const hasLog = (logs: string[], needle: string) => logs.some((l) => l.includes(needle));

beforeEach(() => {
	mock.result = null;
	mock.results = null;
	mock.calls = 0;
});

describe("implementationStage retry loop — in-scope verdict (AC-05)", () => {
	it("SCENARIO-014: gate.pass true → normal GREEN, no IN-SCOPE log, commit runs", async () => {
		mock.result = GATE_PASS;
		const { ctx, fake } = makeCtx();
		const control = (await implementationStage.run(makeState([{ name: "Phase A" }]), ctx)) as Record<string, unknown>;

		// GREEN on first attempt via the pass path.
		expect(hasLog(fake.logs, "Implementation phase-01 GREEN on attempt 1")).toBe(true);
		// Must NOT emit the in-scope variant when the gate truly passed.
		expect(hasLog(fake.logs, "IN-SCOPE GREEN")).toBe(false);
		// No early termination.
		expect(hasLog(fake.logs, "terminating early")).toBe(false);
		// Commit ran and the phase completed green.
		expect(fake.agentIds.some((id) => id.includes("phase-01.commit"))).toBe(true);
		expect(control.allGreen).toBe(true);
		expect(control.phasesCompleted).toBe(1);
		expect(control.totalPhases).toBe(1);
		expect(mock.calls).toBe(1);
	});

	it("SCENARIO-012/025: gate.inScopePass true (pass false) → IN-SCOPE GREEN, proceeds, commit runs", async () => {
		mock.result = GATE_INSCOPE_PASS;
		const { ctx, fake } = makeCtx();
		const control = (await implementationStage.run(makeState([{ name: "Phase A" }]), ctx)) as Record<string, unknown>;

		// Distinct IN-SCOPE GREEN log naming the count + the out-of-scope crate.
		const inScopeLine = fake.logs.find((l) => l.includes("IN-SCOPE GREEN"));
		expect(inScopeLine, "expected an IN-SCOPE GREEN log line").toBeDefined();
		expect(inScopeLine!).toMatch(/Implementation phase-01 IN-SCOPE GREEN on attempt 1/);
		expect(inScopeLine!).toMatch(/1 pre-existing out-of-scope failure\(s\) ignored/);
		expect(inScopeLine!).toContain("compute");
		// Did NOT terminate early on a pre-existing-only failure.
		expect(hasLog(fake.logs, "terminating early")).toBe(false);
		// Commit proceeded → the phase is treated as green.
		expect(fake.agentIds.some((id) => id.includes("phase-01.commit"))).toBe(true);
		expect(control.allGreen).toBe(true);
		expect(control.phasesCompleted).toBe(1);
		// Green broke the loop on attempt 1 → exactly one gate invocation.
		expect(mock.calls).toBe(1);
	});

	it("SCENARIO-013/027: genuine in-scope failures (neither pass nor inScopePass) → terminate early, allGreen false, no commit", async () => {
		mock.result = GATE_GENUINE_FAIL;
		const { ctx, fake } = makeCtx();
		const control = (await implementationStage.run(makeState([{ name: "Phase A" }]), ctx)) as Record<string, unknown>;

		// All 3 attempts were exhausted on a genuine in-scope failure.
		expect(hasLog(fake.logs, "terminating early")).toBe(true);
		expect(hasLog(fake.logs, "failed after 3 attempts")).toBe(true);
		// inScopePass never granted a green here → no IN-SCOPE GREEN line.
		expect(hasLog(fake.logs, "IN-SCOPE GREEN")).toBe(false);
		// No commit for a genuinely broken phase.
		expect(fake.agentIds.some((id) => id.includes("phase-01.commit"))).toBe(false);
		expect(control.allGreen).toBe(false);
		expect(control.phasesCompleted).toBe(0);
		// 3 attempts ⇒ 3 gate invocations.
		expect(mock.calls).toBe(3);
	});

	it("SCENARIO-013: terminate-early breaks the phase loop — later phases never run", async () => {
		mock.result = GATE_GENUINE_FAIL;
		const { ctx, fake } = makeCtx();
		const control = (await implementationStage.run(makeState([{ name: "Phase A" }, { name: "Phase B" }]), ctx)) as Record<string, unknown>;

		expect(hasLog(fake.logs, "terminating early")).toBe(true);
		expect(control.allGreen).toBe(false);
		expect(control.phasesCompleted).toBe(0);
		expect(control.totalPhases).toBe(2);
		// Phase 2's implementer never spawned once phase 1 aborted.
		expect(fake.agentIds.some((id) => id.includes("phase-02"))).toBe(false);
	});

	it("SCENARIO-025: attempt 1 genuine-fail, attempt 2 inScopePass → green on attempt 2 (retry-then-in-scope)", async () => {
		mock.results = [GATE_GENUINE_FAIL, GATE_INSCOPE_PASS];
		const { ctx, fake } = makeCtx();
		const control = (await implementationStage.run(makeState([{ name: "Phase A" }]), ctx)) as Record<string, unknown>;

		// Second attempt flipped to an in-scope green → proceed, no termination.
		const inScopeLine = fake.logs.find((l) => l.includes("IN-SCOPE GREEN"));
		expect(inScopeLine).toBeDefined();
		expect(inScopeLine!).toMatch(/on attempt 2/);
		expect(hasLog(fake.logs, "terminating early")).toBe(false);
		expect(fake.agentIds.some((id) => id.includes("phase-01.commit"))).toBe(true);
		expect(control.allGreen).toBe(true);
		expect(control.phasesCompleted).toBe(1);
		expect(mock.calls).toBe(2);
	});

	it("pass-path precedence: when both pass and inScopePass are true, emit the normal GREEN line (not IN-SCOPE)", async () => {
		// GATE_PASS already has inScopePass:true; the verdict must prefer the
		// pass branch so the log stays the plain "GREEN" message.
		mock.result = GATE_PASS;
		const { ctx, fake } = makeCtx();
		await implementationStage.run(makeState([{ name: "Phase A" }]), ctx);
		expect(hasLog(fake.logs, "GREEN on attempt 1")).toBe(true);
		expect(hasLog(fake.logs, "IN-SCOPE GREEN")).toBe(false);
	});
});
