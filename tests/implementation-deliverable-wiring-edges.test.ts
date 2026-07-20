/**
 * Phase 3 — AND-semantics wiring EDGE-CASE suite (AC-03 → SCENARIO-011..015).
 *
 * Companion to `tests/implementation-deliverable-wiring.test.ts`. That file
 * covers the core AND-semantics verdict + missing-injection on a SINGLE phase.
 * This file hardens the gaps that the core suite does NOT assert:
 *
 *   1. MULTI-PHASE EARLY-TERMINATION — a deliverable FAIL in phase-1 must
 *      `break` the whole stage so phase-2 is NEVER attempted (no phase-02
 *      agent ids, no extra primitive calls). This is the `allGreen=false; break`
 *      invariant that stops a false-green phase-1 from leaking into phase-2.
 *   2. ATTEMPT-3 BOUNDARY CONVERGENCE — FAIL, FAIL, PASS recovers on the LAST
 *      attempt (exactly 3 primitive calls, GREEN on attempt 3) proving
 *      MAX_ATTEMPTS is not off-by-one.
 *   3. MISSING-BLOCK INJECTION INDEPENDENT OF THE GATE RESULT — the
 *      `## Deliverables still missing` block is injected into the next retry
 *      even when attempt-1's BUILD-GATE itself failed (in-scope), proving the
 *      injection is keyed on the deliverable verdict alone, not the gate's.
 *   4. PER-ATTEMPT FAIL-LOG SURFACES DELIVERABLE REASONS — the
 *      `attempt N/3 FAIL: ...` log line carries each missing entry with the
 *      `deliverable:` prefix so an audit trail exists even on the non-terminal
 *      attempts.
 *
 * Same hermetic harness as the core suite (build-runner + render fully mocked).
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

const mock = vi.hoisted(() => ({
	gateQ: [] as Array<Record<string, unknown>>,
	deliverableQ: [] as Array<Record<string, unknown>>,
	gateCalls: 0,
	deliverableCalls: 0,
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

vi.mock("../src/build-runner.ts", () => ({
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
}));

vi.mock("../src/render/render.ts", () => ({
	renderAndWrite: vi.fn(),
}));

import { implementationStage } from "../src/stages/implementation.ts";

// ─── Fixtures ───────────────────────────────────────────────────────────────

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

/** A genuine IN-SCOPE build-gate failure: pass=false, inScopePass=false. */
const GATE_INSCOPE_FAIL = {
	pass: false,
	buildSuccess: false,
	allTestsPass: true,
	typecheckSuccess: true,
	ran: ["cargo test"],
	errors: ["error[E0425]: cannot find value `fetch_us_data` in scope"],
	outOfScopeErrors: [] as string[],
	inScopePass: false,
};

const DELIVERABLE_PASS = { pass: true, missing: [] as string[], ran: ["tests:list"] };

const DELIVERABLE_FAIL = {
	pass: false,
	missing: ["missing file: src/screen.rs", "missing pattern fetch_us_data in src/screen.rs"],
	ran: ["file:src/screen.rs", "contains:src/screen.rs:fetch_us_data"],
};

const DELIVERABLES = { requireFiles: ["src/screen.rs"] };

const seedGate = (r: Record<string, unknown>, n = 3): void => {
	for (let i = 0; i < n; i++) mock.gateQ.push({ ...r });
};
const seedDeliverable = (r: Record<string, unknown>, n = 3): void => {
	for (let i = 0; i < n; i++) mock.deliverableQ.push({ ...r });
};

function mkState(
	phases: Array<{ name: string; description?: string; deliverables?: unknown }> = [{ name: "Phase A" }],
): PipelineState {
	return {
		setup: {
			worktreePath: "/tmp/sd-deliverable-edges",
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
			if (call.id.includes("summary")) return { text: "", control: null };
			return { text: "", control: {} as ControlObj };
		},
		async parallel(cbs) {
			return Promise.all(cbs.map((c) => c()));
		},
		budget: { count: 0, check: () => true, spent() { this.count++; } } satisfies Budget,
		log(message: string) {
			fake.logs.push(message);
		},
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

describe("Phase 3 — AND-semantics wiring EDGE cases (AC-03)", () => {
	it("multi-phase early-termination: a deliverable FAIL in phase-1 aborts phase-2 entirely (SCENARIO-011 → stage control flow)", async () => {
		// Both primitives fail persistently. Phase-1 burns all 3 attempts and the
		// stage `break`s — phase-2 must NEVER be reached (no phase-02 agents, no
		// extra primitive calls).
		seedGate(GATE_PASS, 6);
		seedDeliverable(DELIVERABLE_FAIL, 6);
		const { ctx, fake } = mkCtx();
		const res = (await (implementationStage as Stage).run(
			mkState([
				{ name: "Phase A", deliverables: DELIVERABLES },
				{ name: "Phase B", deliverables: DELIVERABLES },
			]),
			ctx,
		)) as ControlObj;

		// Phase-2 never started: no agent id references phase-02.
		expect(fake.agentIds.some((id) => id.includes("phase-02"))).toBe(false);
		// Only phase-1's 3 attempts ran each primitive — NOT 6.
		expect(mock.gateCalls).toBe(3);
		expect(mock.deliverableCalls).toBe(3);
		// Stage verdict reflects the abort.
		expect(res.allGreen).toBe(false);
		expect(res.phasesCompleted).toBe(0);
		expect(hasLog(fake.logs, "failed after 3 attempts — terminating early")).toBe(true);
	});

	it("attempt-3 boundary convergence: FAIL, FAIL, PASS recovers GREEN on the LAST attempt (SCENARIO-012/015)", async () => {
		// Persistent green gate; deliverable fails twice then passes on attempt 3.
		seedGate(GATE_PASS, 3);
		mock.deliverableQ.push({ ...DELIVERABLE_FAIL }, { ...DELIVERABLE_FAIL }, { ...DELIVERABLE_PASS });
		const { ctx, fake } = mkCtx();
		const res = (await (implementationStage as Stage).run(
			mkState([{ name: "Phase A", deliverables: DELIVERABLES }]),
			ctx,
		)) as ControlObj;

		// GREEN precisely on attempt 3 — MAX_ATTEMPTS boundary is not off-by-one.
		expect(hasLog(fake.logs, "Implementation phase-01 GREEN on attempt 3")).toBe(true);
		expect(res.phasesCompleted).toBe(1);
		expect(res.allGreen).toBe(true);
		expect(fake.agentIds.some((id) => id.includes("phase-01.commit"))).toBe(true);
		expect(mock.gateCalls).toBe(3);
		expect(mock.deliverableCalls).toBe(3);
	});

	it("missing-block injection is INDEPENDENT of the gate result: in-scope gate FAIL + deliverable FAIL still feeds the block to attempt 2", async () => {
		// attempt-1: gate IN-SCOPE fails AND deliverable fails. attempt-2: both
		// pass. The missing block must reach attempt-2 even though attempt-1's
		// gate (not just its deliverable) failed — proving injection is keyed on
		// the deliverable verdict alone.
		mock.gateQ.push({ ...GATE_INSCOPE_FAIL }, { ...GATE_PASS });
		mock.deliverableQ.push({ ...DELIVERABLE_FAIL }, { ...DELIVERABLE_PASS });
		const { ctx, fake } = mkCtx();
		const res = (await (implementationStage as Stage).run(
			mkState([{ name: "Phase A", deliverables: DELIVERABLES }]),
			ctx,
		)) as ControlObj;

		expect(hasLog(fake.logs, "Implementation phase-01 GREEN on attempt 2")).toBe(true);
		expect(res.allGreen).toBe(true);
		// attempt-2 prompt carries the missing block recovered from attempt-1's
		// deliverable failure — despite attempt-1's gate ALSO having failed.
		const attempt2 = fake.implByAttempt.get(2);
		expect(attempt2, "expected an attempt-2 implementer prompt").toBeDefined();
		expect(attempt2!).toContain("## Deliverables still missing — create/wire these");
		expect(attempt2!).toContain("- missing file: src/screen.rs");
		// attempt-1 prompt was built BEFORE its deliverable check → no block yet.
		expect(fake.implByAttempt.get(1)).not.toContain("Deliverables still missing");
	});

	it("per-attempt FAIL log surfaces each deliverable reason with the `deliverable:` prefix (audit trail)", async () => {
		// Green gate + failing deliverable: every non-terminal attempt's FAIL log
		// must carry the missing reasons (prefixed) so the failure is auditable
		// even when the build-gate itself was green.
		seedGate(GATE_PASS);
		seedDeliverable(DELIVERABLE_FAIL);
		const { ctx, fake } = mkCtx();
		await (implementationStage as Stage).run(mkState([{ name: "Phase A", deliverables: DELIVERABLES }]), ctx);

		// The attempt-1 FAIL line exists and carries the deliverable reasons.
		const attempt1Fail = fake.logs.find((l) => /phase-01 attempt 1\/3 FAIL/.test(l));
		expect(attempt1Fail, "expected a phase-01 attempt-1 FAIL log line").toBeDefined();
		expect(attempt1Fail!).toContain("deliverable: missing file: src/screen.rs");
		expect(attempt1Fail!).toContain("deliverable: missing pattern fetch_us_data in src/screen.rs");
		// The green-gate log precedes the FAIL verdict on the same attempt
		// (gate logged before deliverable-check, which precedes the FAIL line).
		const gateIdx = fake.logs.findIndex((l) => l.includes("phase-01 build-gate PASS"));
		const deliverableIdx = fake.logs.findIndex((l) => l.includes("phase-01 deliverable-check FAIL"));
		const failIdx = fake.logs.findIndex((l) => /phase-01 attempt 1\/3 FAIL/.test(l));
		expect(gateIdx).toBeGreaterThanOrEqual(0);
		expect(deliverableIdx).toBeGreaterThan(gateIdx);
		expect(failIdx).toBeGreaterThan(deliverableIdx);
	});

	it("deliverable FAIL on attempt 1 with a failing gate also surfaces the GATE errors alongside the deliverable reasons in the FAIL log", async () => {
		// Both sources of failure must be joined in the per-attempt FAIL line.
		mock.gateQ.push({ ...GATE_INSCOPE_FAIL }, { ...GATE_PASS }, { ...GATE_PASS });
		mock.deliverableQ.push({ ...DELIVERABLE_FAIL }, { ...DELIVERABLE_PASS }, { ...DELIVERABLE_PASS });
		const { ctx, fake } = mkCtx();
		await (implementationStage as Stage).run(mkState([{ name: "Phase A", deliverables: DELIVERABLES }]), ctx);

		const attempt1Fail = fake.logs.find((l) => /phase-01 attempt 1\/3 FAIL/.test(l));
		expect(attempt1Fail).toBeDefined();
		// BOTH the in-scope gate error AND the deliverable reasons appear.
		expect(attempt1Fail!).toContain("cannot find value");
		expect(attempt1Fail!).toContain("deliverable: missing file: src/screen.rs");
	});
});
