/**
 * Phase 3 — AND-semantics deliverable wiring in implementation.ts — TDD suite
 * (AC-03 → SCENARIO-011..015).
 *
 * The build-gate's `gate.pass || gate.inScopePass` is NECESSARY but NOT
 * SUFFICIENT: a phase can compile green while delivering nothing (a
 * never-created file, an unwired call site, a dead `_ => {}` router arm, a
 * missing named test). This suite drives wiring `runDeliverableCheck` into
 * `src/stages/implementation.ts` so the GREEN verdict becomes
 * `(gate.pass || gate.inScopePass) && deliverableCheck.pass`, the
 * PASS/FAIL+missing verdict is logged next to the build-gate log, and the
 * exhaustive `missing` list is fed into the next implementer retry under a
 * `## Deliverables still missing — create/wire these` block, bounded by
 * MAX_ATTEMPTS = 3.
 *
 * Both `runBuildGate` and `runDeliverableCheck` are fully stubbed via
 * `vi.mock("../src/build-runner.ts")` so the stage exercises ONLY its verdict
 * composition + retry-prompt injection logic — no real git/cargo/test listers.
 * `runRedCheck` is stubbed to `"unknown"` (greenfield-safe) so the RED loop
 * issues ZERO re-prompts and proceeds immediately, and `renderAndWrite` is
 * mocked so the suite is fully disk-free. This mirrors the established
 * `tests/implementation-red-loop.test.ts` hermeticity pattern.
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

// ─── Mocks (hoisted before the module under test loads) ─────────────────────
// FIFO queues per primitive so a test can script a per-attempt verdict
// sequence (e.g. attempt-1 FAIL then attempt-2 PASS = recovery path). When a
// queue is empty the primitive returns a clean PASS default (backward-compat /
// absent-deliverables behavior). `gateCalls` / `deliverableCalls` prove the
// AND-semantics wiring actually invokes both primitives and respects
// MAX_ATTEMPTS.
const mock = vi.hoisted(() => ({
	gateQ: [] as Array<Record<string, unknown>>,
	deliverableQ: [] as Array<Record<string, unknown>>,
	gateCalls: 0,
	deliverableCalls: 0,
	// Clean defaults so an empty queue = a green primitive (today's behavior).
	gateDefault: {
		pass: true,
		buildSuccess: true,
		allTestsPass: true,
		typecheckSuccess: true,
		ran: ["cargo test"],
		errors: [] as string[],
		outOfScopeErrors: [] as string[],
		inScopePass: true,
	},
	deliverableDefault: { pass: true, missing: [] as string[], ran: [] as string[] },
}));

vi.mock("../src/build-runner.ts", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return {
		...actual,
	// Greenfield-safe RED oracle → no re-prompts, proceeds immediately.
	runRedCheck: (): string => "unknown",
	runBuildGate: () => {
		mock.gateCalls++;
		const r = mock.gateQ.length ? mock.gateQ.shift()! : mock.gateDefault;
		return { ...r };
	},
	runDeliverableCheck: () => {
		mock.deliverableCalls++;
		const r = mock.deliverableQ.length ? mock.deliverableQ.shift()! : mock.deliverableDefault;
		return { ...r };
	},
	resetDeliverableCheckCache: () => {},
	};
});

// Mock the only other filesystem-writing side effect (the summary render) so
// the suite is fully disk-free and deterministic.
vi.mock("../src/render/render.ts", () => ({
	renderAndWrite: vi.fn(),
}));

import { implementationStage } from "../src/stages/implementation.ts";

// ─── Fixtures ───────────────────────────────────────────────────────────────

/** A clean build-gate PASS (gate.pass true, inScopePass true). */
const GATE_PASS = {
	pass: true,
	buildSuccess: true,
	allTestsPass: true,
	typecheckSuccess: true,
	ran: ["cargo test"],
	errors: [] as string[],
	outOfScopeErrors: [] as string[],
	inScopePass: true,
};

/** Build-gate that fails overall but every failure is OUT-of-scope (inScopePass true). */
const GATESC_INSCOPE_ONLY = {
	pass: false,
	buildSuccess: false,
	allTestsPass: false,
	typecheckSuccess: true,
	ran: ["cargo test"],
	errors: ["pre-existing failure in crates/other/src/lib.rs"],
	outOfScopeErrors: ["crates/other/src/lib.rs FAILED"],
	inScopePass: true,
};

/** A clean deliverable-check PASS — every declared deliverable is present. */
const DELIVERABLE_PASS = {
	pass: true,
	missing: [] as string[],
	ran: ["file:src/screen.rs", "contains:src/screen.rs:fetch_us_data", "tests:list"],
};

/**
 * A deliverable-check FAIL with a representative, EXHAUSTIVE `missing` list
 * (the stockfan-style false-green shape: a never-created file, an unwired call
 * site, a missing named test). Used to assert AND-semantics + missing injection.
 */
const DELIVERABLE_FAIL = {
	pass: false,
	missing: [
		"missing file: src/screen.rs",
		"missing pattern fetch_us_data in src/screen.rs",
		"missing test: screen::fetches_us_market_data",
	],
	ran: ["file:src/screen.rs", "contains:src/screen.rs:fetch_us_data", "tests:list"],
};

/** Push `r` onto the gate queue `n` times (default MAX_ATTEMPTS=3 = persistent). */
const seedGate = (r: Record<string, unknown>, n = 3): void => {
	for (let i = 0; i < n; i++) mock.gateQ.push({ ...r });
};
/** Push `r` onto the deliverable queue `n` times (default MAX_ATTEMPTS=3). */
const seedDeliverable = (r: Record<string, unknown>, n = 3): void => {
	for (let i = 0; i < n; i++) mock.deliverableQ.push({ ...r });
};

function mkState(
	phases: Array<{ name: string; description?: string; deliverables?: unknown }> = [{ name: "Phase A" }],
): PipelineState {
	return {
		setup: {
			// Path is irrelevant — every primitive is mocked.
			worktreePath: "/tmp/sd-deliverable",
			specDirectory: "/tmp/sd",
			defaultBranch: "main",
			language: "frontend",
			isWebUi: false,
			specIdentifier: "10",
			worktreeCreated: false,
			initializedRepo: false,
		},
		classify: { taskType: "bug", uiScope: "none", language: "frontend", isWebUi: false },
		spec: { phases },
	} as unknown as PipelineState;
}

interface FakeCtx {
	logs: string[];
	agentIds: string[];
	implByAttempt: Map<number, string>;
}

/**
 * Fully-scripted StageContext. The agent() closure routes by `call.agent`,
 * records ids + logs, and — critically — captures the implementer prompt keyed
 * by attempt (id ends `.impl.a<N>`) so SCENARIO-012's missing-injection can be
 * asserted without spawning a real agent.
 */
function mkCtx(): { ctx: StageContext; fake: FakeCtx } {
	const fake: FakeCtx = { logs: [], agentIds: [], implByAttempt: new Map() };
	const ctx: StageContext = {
		task: "",
		options: {} as RunOptions,
		state: {} as PipelineState,
		async helper(): Promise<HelperResult> {
			return { value: { languageInstructions: "" }, digest: "" };
		},
		async agent(call: AgentCall): Promise<AgentResult> {
			fake.agentIds.push(call.id);
			if (call.agent === "tdd-guide") {
				return { text: "", control: { testFiles: ["tests/red.test.ts"] } };
			}
			if (call.agent === "implementer") {
				const m = /\.impl\.a(\d+)$/.exec(call.id);
				if (m) fake.implByAttempt.set(Number(m[1]), call.prompt ?? "");
				return { text: "", control: { filesModified: ["src/x.ts"] } };
			}
			// summary render → null control = no-op (render is mocked anyway).
			if (call.id.includes("summary")) return { text: "", control: null };
			return { text: "", control: {} as ControlObj };
		},
		async parallel(cbs) {
			return Promise.all(cbs.map((c) => c()));
		},
		budget: {
			count: 0,
			check: () => true,
			spent() {
				this.count++;
			},
		} satisfies Budget,
		log(message: string) {
			fake.logs.push(message);
		},
		phase() {},
		events: new EventEmitter(),
		results: [],
	};
	return { ctx, fake };
}

const hasLog = (logs: string[], needle: string) => logs.some((l) => l.includes(needle));

beforeEach(() => {
	mock.gateQ.length = 0;
	mock.deliverableQ.length = 0;
	mock.gateCalls = 0;
	mock.deliverableCalls = 0;
});

const DELIVERABLES = { requireFiles: ["src/screen.rs"] };

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("Phase 3 — AND-semantics wiring (AC-03)", () => {
	it("SCENARIO-015: build-green + deliverable PASS → GREEN on attempt 1 (both green)", async () => {
		seedGate(GATE_PASS);
		seedDeliverable(DELIVERABLE_PASS);
		const { ctx, fake } = mkCtx();
		const res = (await (implementationStage as Stage).run(
			mkState([{ name: "Phase A", deliverables: DELIVERABLES }]),
			ctx,
		)) as ControlObj;

		// GREEN on first attempt — BOTH primitives passed.
		expect(hasLog(fake.logs, "Implementation phase-01 GREEN on attempt 1")).toBe(true);
		expect(res.allGreen).toBe(true);
		expect(res.phasesCompleted).toBe(1);
		expect(fake.agentIds.some((id) => id.includes("phase-01.commit"))).toBe(true);
		// Both primitives invoked exactly once (loop broke on attempt 1).
		expect(mock.gateCalls).toBe(1);
		expect(mock.deliverableCalls).toBe(1);
	});

	it("SCENARIO-011: build-green (gate.pass true) + deliverable FAIL → NOT green, no commit (the false-green fix)", async () => {
		seedGate(GATE_PASS);
		seedDeliverable(DELIVERABLE_FAIL);
		const { ctx, fake } = mkCtx();
		const res = (await (implementationStage as Stage).run(
			mkState([{ name: "Phase A", deliverables: DELIVERABLES }]),
			ctx,
		)) as ControlObj;

		// The crux of AND-semantics: a green build-gate does NOT grant green when
		// the deliverable contract is unmet.
		expect(hasLog(fake.logs, "Implementation phase-01 GREEN")).toBe(false);
		expect(hasLog(fake.logs, "IN-SCOPE GREEN")).toBe(false);
		expect(hasLog(fake.logs, "failed after 3 attempts — terminating early")).toBe(true);
		expect(fake.agentIds.some((id) => id.includes("phase-01.commit"))).toBe(false);
		expect(res.allGreen).toBe(false);
		expect(res.phasesCompleted).toBe(0);
		// The AND-ed primitive MUST actually run alongside the gate.
		expect(mock.deliverableCalls).toBeGreaterThan(0);
	});

	it("SCENARIO-013: MAX_ATTEMPTS (3) still bounds the retry when deliverables keep failing", async () => {
		seedGate(GATE_PASS);
		seedDeliverable(DELIVERABLE_FAIL);
		const { ctx } = mkCtx();
		await (implementationStage as Stage).run(
			mkState([{ name: "Phase A", deliverables: DELIVERABLES }]),
			ctx,
		);

		// Exactly 3 attempts of each primitive — never a 4th, never unbounded.
		expect(mock.gateCalls).toBe(3);
		expect(mock.deliverableCalls).toBe(3);
	});

	it("SCENARIO-012: a failed deliverable check feeds `## Deliverables still missing` into the NEXT implementer retry", async () => {
		seedGate(GATE_PASS);
		seedDeliverable(DELIVERABLE_FAIL);
		const { ctx, fake } = mkCtx();
		await (implementationStage as Stage).run(
			mkState([{ name: "Phase A", deliverables: DELIVERABLES }]),
			ctx,
		);

		// Attempt 1's prompt is built BEFORE any deliverable check has run, so it
		// must NOT carry the missing block yet.
		const attempt1 = fake.implByAttempt.get(1);
		expect(attempt1, "expected an attempt-1 implementer prompt").toBeDefined();
		expect(attempt1).not.toContain("Deliverables still missing");

		// Attempt 2's prompt is built AFTER attempt 1's deliverable check failed
		// → it MUST carry the missing block with EVERY exhaustive entry.
		const attempt2 = fake.implByAttempt.get(2);
		expect(attempt2, "expected an attempt-2 implementer prompt").toBeDefined();
		expect(attempt2!).toContain("## Deliverables still missing — create/wire these");
		for (const entry of DELIVERABLE_FAIL.missing) {
			expect(attempt2!).toContain(`- ${entry}`);
		}
	});

	it("SCENARIO-012 (reset): the missing block reflects the MOST RECENT failing attempt only", async () => {
		// All three attempts fail deliverable; the missing list is identical each
		// time, so each retry prompt carries the current missing block.
		seedGate(GATE_PASS);
		seedDeliverable(DELIVERABLE_FAIL);
		const { ctx, fake } = mkCtx();
		await (implementationStage as Stage).run(
			mkState([{ name: "Phase A", deliverables: DELIVERABLES }]),
			ctx,
		);

		const attempt3 = fake.implByAttempt.get(3);
		expect(attempt3, "expected an attempt-3 implementer prompt").toBeDefined();
		// attempt-3 prompt reflects attempt-2's missing list (still failing).
		expect(attempt3!).toContain("## Deliverables still missing — create/wire these");
		expect(attempt3!).toContain("- missing file: src/screen.rs");
	});

	it("SCENARIO-012 (convergence): FAIL then PASS on attempt 2 → GREEN on attempt 2, missing block carried only to attempt 2", async () => {
		// attempt-1 deliverable FAILS (missing injected into attempt-2 prompt);
		// attempt-2 deliverable PASSES → GREEN on attempt 2. Proves the injected
		// guidance actually lets the loop converge instead of resampling blindly.
		seedGate(GATE_PASS, 2);
		mock.deliverableQ.push({ ...DELIVERABLE_FAIL }, { ...DELIVERABLE_PASS });
		const { ctx, fake } = mkCtx();
		const res = (await (implementationStage as Stage).run(
			mkState([{ name: "Phase A", deliverables: DELIVERABLES }]),
			ctx,
		)) as ControlObj;

		expect(hasLog(fake.logs, "Implementation phase-01 GREEN on attempt 2")).toBe(true);
		expect(res.phasesCompleted).toBe(1);
		expect(res.allGreen).toBe(true);
		expect(fake.agentIds.some((id) => id.includes("phase-01.commit"))).toBe(true);
		expect(mock.gateCalls).toBe(2);
		expect(mock.deliverableCalls).toBe(2);
		// attempt-2 prompt carried the missing block recovered from attempt 1.
		expect(fake.implByAttempt.get(2)).toContain("## Deliverables still missing — create/wire these");
	});

	it("SCENARIO-014: phase with NO deliverables → condition reduces to today's behavior (backward compat)", async () => {
		// No deliverable seed → runDeliverableCheck default = PASS, exactly as the
		// real primitive early-returns {pass:true} for an undefined contract.
		seedGate(GATE_PASS);
		const { ctx, fake } = mkCtx();
		const res = (await (implementationStage as Stage).run(
			mkState([{ name: "Phase A" }]), // deliverables: undefined
			ctx,
		)) as ControlObj;

		// No deliverable contract ⇒ behaves EXACTLY as before the wiring:
		// GREEN on attempt 1, commit runs, no termination.
		expect(hasLog(fake.logs, "Implementation phase-01 GREEN on attempt 1")).toBe(true);
		expect(hasLog(fake.logs, "terminating early")).toBe(false);
		expect(fake.agentIds.some((id) => id.includes("phase-01.commit"))).toBe(true);
		expect(res.allGreen).toBe(true);
		expect(res.phasesCompleted).toBe(1);
		expect(mock.gateCalls).toBe(1);
		// The deliverable check is still invoked (backward-compat pass:true) but
		// MUST report PASS with no missing entries — no false-green noise.
		expect(mock.deliverableCalls).toBe(1);
		expect(hasLog(fake.logs, "deliverable-check PASS")).toBe(true);
		expect(hasLog(fake.logs, "deliverable-check FAIL")).toBe(false);
	});

	it("AND-semantics applies to the inScopePass branch too: inScope-only gate + deliverable PASS → IN-SCOPE GREEN", async () => {
		seedGate(GATESC_INSCOPE_ONLY);
		seedDeliverable(DELIVERABLE_PASS);
		const { ctx, fake } = mkCtx();
		const res = (await (implementationStage as Stage).run(
			mkState([{ name: "Phase A", deliverables: DELIVERABLES }]),
			ctx,
		)) as ControlObj;

		// gate.inScopePass still grants green WHEN the deliverable contract holds.
		expect(hasLog(fake.logs, "IN-SCOPE GREEN on attempt 1")).toBe(true);
		expect(res.phasesCompleted).toBe(1);
		expect(res.allGreen).toBe(true);
	});

	it("AND-semantics applies to the inScopePass branch too: inScope-only gate + deliverable FAIL → NOT green", async () => {
		seedGate(GATESC_INSCOPE_ONLY);
		seedDeliverable(DELIVERABLE_FAIL);
		const { ctx, fake } = mkCtx();
		const res = (await (implementationStage as Stage).run(
			mkState([{ name: "Phase A", deliverables: DELIVERABLES }]),
			ctx,
		)) as ControlObj;

		// A missing deliverable MUST block green even when the only gate failures
		// are out-of-scope — the AND is mandatory on BOTH gate branches.
		expect(hasLog(fake.logs, "IN-SCOPE GREEN")).toBe(false);
		expect(res.allGreen).toBe(false);
		expect(res.phasesCompleted).toBe(0);
		expect(hasLog(fake.logs, "failed after 3 attempts — terminating early")).toBe(true);
	});

	it("SCENARIO-011/015 log: the deliverable-check verdict (with missing reasons) is logged next to the build-gate log", async () => {
		seedGate(GATE_PASS);
		seedDeliverable(DELIVERABLE_FAIL);
		const { ctx, fake } = mkCtx();
		await (implementationStage as Stage).run(
			mkState([{ name: "Phase A", deliverables: DELIVERABLES }]),
			ctx,
		);

		// Both the build-gate and deliverable-check verdicts are logged.
		expect(hasLog(fake.logs, "phase-01 build-gate")).toBe(true);
		const failLine = fake.logs.find((l) => l.includes("deliverable-check FAIL"));
		expect(failLine, "expected a deliverable-check FAIL log line").toBeDefined();
		// The missing reasons are surfaced in the log so the failure is auditable.
		expect(failLine!).toContain("missing file: src/screen.rs");
		// Deliverable-check log carries its own verdict token (not just "PASS").
		expect(fake.logs.some((l) => /deliverable-check\s+(PASS|FAIL)/.test(l))).toBe(true);
	});
});
