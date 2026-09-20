/**
 * Run 2026-09-19T04-50-49-552Z — the already-satisfied-wall circuit breaker.
 *
 * THE INCIDENT: spec-26 phases 2–6 each burned 3–4 full attempts against an
 * IDENTICAL wall — deliverables verified satisfied on disk (`deliverables=true`)
 * while the full-suite build gate stayed red (`build=false`) on out-of-scope
 * regressions new on the branch (a pinned `src/schemas.ts` + registry census
 * tests). The honest tdd-guide no-op ("nothing to author, already green") was
 * rejected by the acceptance layer (correct P4), F9-A correctly routed to the
 * already-satisfied verification, and the verification then failed on the SAME
 * gate errors — but the already-fail outcome carried raw gate errors with NO
 * recurrence semantics, so every §D pass and every later phase re-dispatched
 * agents that provably could not change the outcome: ≈40 dispatches, ~$50,
 * 16h, ended only by the run wall fuse.
 *
 * CONTRACT UNDER TEST:
 *  - `alreadySatisfiedWallSignature` — deterministic signature of the REAL
 *    gate failures (synthetic [baseline-verify] annotation stripped, ANSI
 *    stripped, whitespace collapsed, sorted/deduped, capped); "" when only
 *    the annotation exists.
 *  - The already-fail arm RECORDS the wall signature on the phase's durable
 *    PhaseStatusEntry (first occurrence: named block NOT yet fired).
 *  - Recurrence blocks: the same signature observed again — by THIS phase in
 *    a prior §D pass, or by a DIFFERENT non-green phase — ends the phase
 *    partial with the NAMED reason `already-satisfied-blocked`.
 *  - A phase that later went GREEN erases its wall (never blocks on it).
 *  - Missing deliverables carry NO signature (actionable by RED/GREEN — the
 *    pre-fix retry semantics are preserved verbatim).
 *
 * Hermeticity: mirrors tests/implementation-red-already-satisfied.test.ts —
 * build-runner barrel + render mocked, scripted ctx.agent closures, no disk,
 * no LLM.
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
import type { DeliverableContract } from "../src/build-runner.ts";

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
		deliverablesAlreadyMet: vi.fn(() => false),
	};
});

vi.mock("../src/render/render.ts", () => ({
	renderAndWrite: vi.fn(),
}));

import { implementationStage } from "../src/stages/implementation/index.ts";
import { alreadySatisfiedWallSignature } from "../src/stages/implementation/red-acceptance.ts";
import { BASELINE_VERIFY_ERROR_PREFIX } from "../src/build-runner/gates/build-gate.ts";
import { runRedCheck, runBuildGate, runDeliverableCheck, deliverablesAlreadyMet } from "../src/build-runner.ts";

const redCheck = runRedCheck as unknown as ReturnType<typeof vi.fn>;
const gate = runBuildGate as unknown as ReturnType<typeof vi.fn>;
const deliverable = runDeliverableCheck as unknown as ReturnType<typeof vi.fn>;
const dam = deliverablesAlreadyMet as unknown as ReturnType<typeof vi.fn>;

const CONTAINS_ONLY: DeliverableContract = {
	requireContains: [
		{ file: "python/omisis/screen.py", pattern: "fetcher-bridge" },
		{ file: "src/schemas.ts", pattern: "screen" },
	],
};

/** The incident's wall: pinned-file + registry census failures, new on branch. */
const WALL_ERRORS = [
	"❯ tests/profitability-contract.test.ts:986:60\n   expect(dirty, \"src/schemas.ts must stay byte-untouched\").toBe(\"\")",
	"FAILED tests/test_catalyst_module_registry.py::test_scenario_012_module_files_stay_one_to_one_with_the_registry",
	"FAILED tests/test_macro_module_registry.py::test_scenario_044_registry_membership_gains_macro_not_ordinal",
];
const WALL_SYNTH = `${BASELINE_VERIFY_ERROR_PREFIX} vitest run tests/profitability-contract.test.ts PASSES at baseline ca5fcde3 — the failure is new on this branch`;

function mkState(priorPhaseStatus?: Array<{ id: string; status: string; alreadySatisfiedWallSig?: string }>): PipelineState {
	return {
		setup: {
			worktreePath: "/tmp/sd-wall",
			specDirectory: "/tmp/sd",
			defaultBranch: "main",
			language: "frontend",
			isWebUi: false,
			specIdentifier: "wall",
			worktreeCreated: false,
			initializedRepo: false,
		},
		classify: { taskType: "feature", uiScope: "none", language: "frontend", isWebUi: false },
		spec: {
			phases: [{ name: "screen-module-registry-lockstep", description: "registry closure", deliverables: CONTAINS_ONLY }],
		},
		...(priorPhaseStatus ? { implementation: { phaseStatus: priorPhaseStatus } } : {}),
	} as unknown as PipelineState;
}

function mkCtx(): { ctx: StageContext; logs: string[] } {
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
				return { text: "", control: { testFiles: ["python/tests/test_screen_ops.py"] } };
			}
			if (call.agent === "code-reviewer") {
				return { text: "", control: { verdict: "strong", summary: "ok", contradictions: [] } };
			}
			if (call.agent === "tdd-coverage-classifier") {
				return { text: "", control: { allCovered: true, coveredScenarios: [], missingScenarios: [], summary: "covered" } };
			}
			return { text: "", control: {} };
		},
		async parallel(cbs) {
			return Promise.all(cbs.map((c) => c()));
		},
		budget: {
			count: 0,
			check: () => true,
			spent() {
				this.count++;
				return true;
			},
		} satisfies Budget,
		log(message: string) {
			logs.push(message);
		},
		phase() {},
		events: new EventEmitter(),
		results: [],
	};
	return { ctx, logs };
}

beforeEach(() => {
	redCheck.mockReset();
	gate.mockReset();
	deliverable.mockReset();
	dam.mockReset();
	// Deliverables satisfied from entry (the F8 baseline-true route); the RED
	// oracle runs green on the claimed file → green-already-satisfied → the
	// Already-satisfied verification runs build gate + deliverable check.
	redCheck.mockImplementation((_cwd: string, targets: string[], opts?: { onResult?: (diagnostic: unknown) => void }) => {
		if (!targets.length) return "unknown";
		opts?.onResult?.({
			plan: { cwd: "/tmp/sd-wall", argv: ["npm", "exec", "vitest", "--", "run", "python/tests/test_screen_ops.py"] },
			language: "backend",
			status: "green",
			exitCode: 0,
			signal: null,
			outputTail: "ok 1 - registry closure",
		});
		return "green";
	});
	dam.mockImplementation(() => true);
	deliverable.mockImplementation(() => ({ pass: true, missing: [], ran: [] }));
});

describe("alreadySatisfiedWallSignature — deterministic wall identity", () => {
	it("strips the synthetic [baseline-verify] annotation and normalizes real blocks (ANSI, whitespace, sort, dedupe)", () => {
		const a = alreadySatisfiedWallSignature([...WALL_ERRORS, WALL_SYNTH]);
		const b = alreadySatisfiedWallSignature([WALL_SYNTH, WALL_ERRORS[2], WALL_ERRORS[0], WALL_ERRORS[1]]);
		expect(a).toBe(b);
		// The 200-char total cap (lastFailureSig parity) keeps the leading sorted
		// subjects — determinism + annotation-stripping are the contract.
		expect(a).toContain("test_scenario_012_module_files_stay_one_to_one");
		expect(a).not.toContain("baseline-verify");
	});

	it("returns \"\" when nothing REAL failed (annotation-only) — treated as no signature", () => {
		expect(alreadySatisfiedWallSignature([WALL_SYNTH])).toBe("");
		expect(alreadySatisfiedWallSignature([])).toBe("");
	});

	it("caps each block at 160 chars and the total at 200", () => {
		const long = "x".repeat(400);
		const sig = alreadySatisfiedWallSignature([long, long, long + "!"]);
		expect(sig.length).toBeLessThanOrEqual(200);
	});
});

describe("already-satisfied wall — first occurrence records, does not block", () => {
	it("deliverables=true + build=false: phase ends partial, signature recorded durably, no named block yet", async () => {
		gate.mockImplementation(() => ({ pass: false, inScopePass: false, ran: ["npm test"], errors: [...WALL_ERRORS, WALL_SYNTH], outOfScopeErrors: WALL_ERRORS }));

		const { ctx, logs } = mkCtx();
		const res = (await (implementationStage as Stage).run(mkState(), ctx)) as ControlObj;

		expect(logs.some((l) => /RED already-satisfied: build=false, deliverables=true/.test(l))).toBe(true);
		expect(logs.some((l) => /RED already-satisfied verification FAIL/.test(l))).toBe(true);
		// First occurrence: recorded but NOT blocked — the named wall line is absent.
		expect(logs.some((l) => /already-satisfied wall:/.test(l))).toBe(false);
		const entries = (res.phaseStatus ?? []) as Array<{ id: string; alreadySatisfiedWallSig?: string }>;
		expect(entries[0]?.alreadySatisfiedWallSig).toBe(alreadySatisfiedWallSignature([...WALL_ERRORS, WALL_SYNTH]));
	});
});

describe("already-satisfied wall — recurrence blocks (the incident's loop killer)", () => {
	it("same signature in a prior §D pass of THIS phase → already-satisfied-blocked, no re-dispatch burn", async () => {
		gate.mockImplementation(() => ({ pass: false, inScopePass: false, ran: ["npm test"], errors: [...WALL_ERRORS, WALL_SYNTH], outOfScopeErrors: WALL_ERRORS }));
		const sig = alreadySatisfiedWallSignature([...WALL_ERRORS, WALL_SYNTH]);

		const { ctx, logs } = mkCtx();
		const res = (await (implementationStage as Stage).run(mkState([{ id: "phase-01", status: "partial", alreadySatisfiedWallSig: sig }]), ctx)) as ControlObj;

		expect(logs.some((l) => /already-satisfied wall: same failing subject\(s\) as a prior convergence pass of this phase/.test(l))).toBe(true);
		expect(logs.some((l) => /already-satisfied-blocked — deliverables satisfied but the build gate stays red/.test(l))).toBe(true);
		const failures = (res.lastFailures ?? []) as Array<{ phaseId: string; reasons: string[] }>;
		expect(failures[0]?.reasons.some((r) => r.startsWith("already-satisfied-blocked:"))).toBe(true);
	});

	it("cross-phase: a DIFFERENT non-green phase's signature blocks at first occurrence", async () => {
		gate.mockImplementation(() => ({ pass: false, inScopePass: false, ran: ["npm test"], errors: [...WALL_ERRORS, WALL_SYNTH], outOfScopeErrors: WALL_ERRORS }));
		const sig = alreadySatisfiedWallSignature([...WALL_ERRORS, WALL_SYNTH]);

		const { ctx, logs } = mkCtx();
		await (implementationStage as Stage).run(mkState([{ id: "phase-02", status: "partial", alreadySatisfiedWallSig: sig }]), ctx);

		expect(logs.some((l) => /already-satisfied wall: same failing subject\(s\) as phase phase-02/.test(l))).toBe(true);
	});

	it("a phase that later went GREEN erases its wall — the same signature does NOT block", async () => {
		gate.mockImplementation(() => ({ pass: false, inScopePass: false, ran: ["npm test"], errors: [...WALL_ERRORS, WALL_SYNTH], outOfScopeErrors: WALL_ERRORS }));
		const sig = alreadySatisfiedWallSignature([...WALL_ERRORS, WALL_SYNTH]);

		const { ctx, logs } = mkCtx();
		const res = (await (implementationStage as Stage).run(mkState([{ id: "phase-02", status: "green", alreadySatisfiedWallSig: sig }]), ctx)) as ControlObj;

		expect(logs.some((l) => /already-satisfied wall:/.test(l))).toBe(false);
		// Still a first-occurrence record on THIS phase (durable for later passes).
		const entries = (res.phaseStatus ?? []) as Array<{ id: string; alreadySatisfiedWallSig?: string }>;
		expect(entries[0]?.alreadySatisfiedWallSig).toBe(sig);
	});

	it("a DIFFERENT signature is new information — first occurrence semantics, no block", async () => {
		gate.mockImplementation(() => ({ pass: false, inScopePass: false, ran: ["npm test"], errors: [...WALL_ERRORS, WALL_SYNTH], outOfScopeErrors: WALL_ERRORS }));
		const otherSig = "entirely different failing subject";

		const { ctx, logs } = mkCtx();
		await (implementationStage as Stage).run(mkState([{ id: "phase-01", status: "partial", alreadySatisfiedWallSig: otherSig }]), ctx);

		expect(logs.some((l) => /already-satisfied wall:/.test(l))).toBe(false);
	});
});

describe("already-satisfied wall — missing deliverables keep the pre-fix semantics", () => {
	it("deliverables=false: already-fail carries NO signature — no wall field recorded, no block", async () => {
		gate.mockImplementation(() => ({ pass: false, inScopePass: false, ran: ["npm test"], errors: [...WALL_ERRORS, WALL_SYNTH], outOfScopeErrors: WALL_ERRORS }));
		deliverable.mockImplementation(() => ({ pass: false, missing: ["deliverable: python/omisis/screen.py"], ran: [] }));

		const { ctx, logs } = mkCtx();
		const res = (await (implementationStage as Stage).run(mkState([{ id: "phase-01", status: "partial", alreadySatisfiedWallSig: "whatever" }]), ctx)) as ControlObj;

		expect(logs.some((l) => /already-satisfied wall:/.test(l))).toBe(false);
		// The arm wrote NO new signature; the tail's carry-over keeps the PRIOR
		// pass's stale value (field semantics: last wall observed for the phase —
		// a later pass re-observing that same wall is still a recurrence).
		const entries = (res.phaseStatus ?? []) as Array<{ id: string; alreadySatisfiedWallSig?: string }>;
		expect(entries[0]?.alreadySatisfiedWallSig).toBe("whatever");
	});
});
