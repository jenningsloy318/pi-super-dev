/**
 * Wave P1 D-C (docs/requirements/058-cross-phase-contract-architecture.md Layer 3,
 * DEC-3) — the tightened attempt governor, pinned BEHAVIORALLY through the
 * real Stage 9 attempt loop (the signature-noise harness pattern: build-runner
 * scripted per call, everything else real).
 *
 * Bounds under test (P8, documented in implementation.ts at the valve):
 *   - plateau at the 2nd recorded attempt of the current signature window when
 *     the (failure, footprint) pair is identical (existing repeatedNoProgress),
 *     OR the landed change set is empty (NEW zero-change plateau);
 *   - a FRESH footprint survives to attempt 3 (faultRecurrenceLimit) — the
 *     scaffold-with-fresh-footprint shape;
 *   - hard cap maxPhaseAttempts()=4 stands for genuinely new signatures;
 *   - cross-scope contract conflicts (the failure cites a test file declared
 *     requireTests of ANOTHER phase, outside the current phase's own scope)
 *     route the judge on FIRST occurrence — the budget is never consumed on an
 *     unsatisfiable goal; same-scope citations keep the normal loop.
 *   - P10: every failed attempt logs the governor's deltas (signature, footprint,
 *     scope attribution); every route names what it saw.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

// ─── Mocks (signature-noise pattern: the stage's only side-effecting imports)
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

import { implementationStage, maxPhaseAttempts } from "../src/stages/implementation/index.ts";
import { runRedCheck, runBuildGate, type RedCheckDiagnostic } from "../src/build-runner.ts";
import { resetJudgeBudgets } from "../src/stages/judge.ts";

const redCheck = vi.mocked(runRedCheck);
const buildGate = vi.mocked(runBuildGate);

let wt: string;

/** The cross-phase contract plan (D-C's requireTests mapping): phase-01 owns
 * its own RED file; phase-02's requireTests owns the profitability contract —
 * the run-2026-09-13 S-A shape, one scope apart. */
const CROSS_SCOPE_PHASES = [
	{ name: "phase-01", description: "wiring", deliverables: { requireTests: ["tests/red.test.ts"] } },
	{ name: "phase-02", description: "contracts", deliverables: { requireTests: ["tests/profitability-contract.test.ts"] } },
];

/** Single-phase control plan: the citation target is the CURRENT phase's own
 * requireTests scope (same-scope by construction — isolates the plateau
 * valves from the cross-scope route). */
const SINGLE_PHASE = [
	{ name: "phase-01", description: "wiring", deliverables: { requireTests: ["tests/red.test.ts"] } },
];

/** Gate error shape whose FAIL line sits at LINE START (the jest-family
 * failing-file marker extractFailingTestFilePaths parses). */
const failCiting = (testFile: string, label: string): string =>
	`npm test FAILED (exit 1):\nFAIL ${testFile} > ${label}`;

function mkState(phases: Array<Record<string, unknown>> = CROSS_SCOPE_PHASES): PipelineState {
	return {
		setup: {
			worktreePath: wt,
			specDirectory: join(wt, "docs", "specifications", "gov-plateau"),
			defaultBranch: "main",
			language: "frontend",
			isWebUi: false,
			specIdentifier: "gov-plateau",
			worktreeCreated: false,
			initializedRepo: false,
		},
		classify: { taskType: "bug", uiScope: "none", language: "frontend", isWebUi: false },
		spec: { phases },
	} as unknown as PipelineState;
}

interface CapturedCalls {
	impl: AgentCall[];
	judge: AgentCall[];
	logs: string[];
	escalations: Array<{ kind: string; message: string }>;
}

function mkCtx(opts: { maxImplAttempts?: number } = {}): { ctx: StageContext; calls: CapturedCalls } {
	const calls: CapturedCalls = { impl: [], judge: [], logs: [], escalations: [] };
	const escalate = (async (failure: { kind: string; message: string }) => {
		calls.escalations.push(failure);
		return undefined; // dismissed — the honest terminal path
	}) as unknown as RunOptions["escalate"];
	const ctx: StageContext = {
		task: "",
		options: { escalate } as RunOptions,
		state: {} as PipelineState,
		async helper(): Promise<HelperResult> {
			return { value: { languageInstructions: "" }, digest: "" };
		},
		async agent(call: AgentCall): Promise<AgentResult> {
			if (call.agent === "tdd-guide") {
				return { text: "", control: { testFiles: ["tests/red.test.ts"] } };
			}
			if (call.agent === "implementer") {
				calls.impl.push(call);
				// Scripted per dispatch: the claimed change set drives the footprint.
				const claims = implClaimsQueue.length ? implClaimsQueue.shift()! : implClaimsDefault;
				return { text: "", control: claims };
			}
			if (call.agent === "judge") {
				calls.judge.push(call);
				return { text: "", control: null }; // degraded → HITL floor (today's machinery)
			}
			if (call.agent === "tdd-coverage-classifier") {
				return { text: "", control: { allCovered: true, coveredScenarios: [], missingScenarios: [], summary: "covered" } };
			}
			if (call.agent === "code-reviewer") {
				return { text: "", control: { verdict: "strong", summary: "ok", contradictions: [] } };
			}
			return { text: "", control: {} };
		},
		async parallel(cbs) {
			return Promise.all(cbs.map((c) => c()));
		},
		budget: {
			count: 0,
			check: () => calls.impl.length < (opts.maxImplAttempts ?? 12),
			spent() {
				this.count++;
				return true;
			},
		} satisfies Budget,
		log(m: string) {
			calls.logs.push(m);
		},
		phase() {},
		events: new EventEmitter(),
		results: [],
	};
	return { ctx, calls };
}

// ─── Scriptable fixtures ─────────────────────────────────────────────────────

/** Per-dispatch implementer claimed change sets (FIFO; default when drained). */
let implClaimsQueue: Array<ControlObj> = [];
let implClaimsDefault: ControlObj = { filesCreated: [], filesModified: ["src/x.ts"], filesDeleted: [] };

/** Seed runBuildGate with per-call error texts (repeating the last). */
function gateSeq(errorsPerAttempt: string[]): void {
	let i = 0;
	buildGate.mockImplementation(() => {
		const errors = errorsPerAttempt[Math.min(i, errorsPerAttempt.length - 1)];
		i++;
		return { pass: false, inScopePass: false, ran: ["mock"], errors: [errors], outOfScopeErrors: [] } as never;
	});
}

const EMPTY_CLAIMS: ControlObj = { filesCreated: [], filesModified: [], filesDeleted: [] };
const claims = (file: string): ControlObj => ({ filesCreated: [], filesModified: [file], filesDeleted: [] });

beforeEach(() => {
	resetJudgeBudgets();
	delete process.env.SUPER_DEV_DISABLE_JUDGE;
	delete process.env.SUPER_DEV_FAULT_RECURRENCE;
	redCheck.mockReset();
	buildGate.mockReset();
	implClaimsQueue = [];
	implClaimsDefault = claims("src/x.ts");
	wt = mkdtempSync(join(tmpdir(), "sd-govplateau-"));
	mkdirSync(join(wt, "tests"), { recursive: true });
	writeFileSync(join(wt, "tests", "red.test.ts"), `import { save } from "../src/save";\nexpect(save(1)).toBe(2); // D-C governor fixture\n`);
	redCheck.mockImplementation((_cwd: string, _targets: string[], opts?: { onResult?: (diagnostic: RedCheckDiagnostic) => void }) => {
		opts?.onResult?.({
			plan: { cwd: wt, argv: ["vitest", "run", "tests/red.test.ts"] },
			language: "backend",
			status: "red",
			exitCode: 1,
			signal: null,
			outputTail: "FAIL tests/red.test.ts > save",
		});
		return "red";
	});
});

afterEach(() => {
	// adv gate B-5: env mutations must not leak across test files sharing a worker
	delete process.env.SUPER_DEV_FAULT_RECURRENCE;
	delete process.env.SUPER_DEV_DISABLE_JUDGE;
	try { rmSync(wt, { recursive: true, force: true }); } catch { /* tmp */ }
});

describe("Wave P1 D-C — attempt governor plateau + cross-scope routing", () => {
	it("(e) identical (failure, footprint) pair ×2 → the valve routes the judge at attempt 2", async () => {
		gateSeq([failCiting("tests/red.test.ts", "case A"), failCiting("tests/red.test.ts", "case A")]);
		implClaimsDefault = claims("src/x.ts");
		const { ctx, calls } = mkCtx();
		await (implementationStage as Stage).run(mkState(SINGLE_PHASE), ctx);

		expect(calls.logs.some((l) => /stopped after repeated no-progress failure on attempt 2/.test(l))).toBe(true);
		expect(calls.judge).toHaveLength(1);
		expect(calls.judge[0]!.prompt).toContain("stage9.impl-no-progress.phase-01");
		expect(calls.impl).toHaveLength(2);
		// P10: the per-attempt governor line logged the identical-pair repeat.
		expect(calls.logs.some((l) => /attempt 2 governor: signature repeat/.test(l))).toBe(true);
	}, 20_000);

	it("(f1) a FRESH footprint survives to attempt 3 (fault-category recurrence), not the attempt-2 plateau", async () => {
		// Identical FAILURE signature (same errors every attempt) but a FRESH
		// footprint each attempt — the two-step-scaffold shape: the pair is
		// never identical, so the plateau must NOT fire at attempt 2.
		gateSeq([failCiting("tests/red.test.ts", "case A"), failCiting("tests/red.test.ts", "case A"), failCiting("tests/red.test.ts", "case A")]);
		implClaimsQueue = [claims("src/a1.ts"), claims("src/a2.ts"), claims("src/a3.ts")];
		const { ctx, calls } = mkCtx();
		await (implementationStage as Stage).run(mkState(SINGLE_PHASE), ctx);

		expect(calls.logs.some((l) => /attempt 2 governor: signature fresh/.test(l))).toBe(true);
		expect(calls.logs.some((l) => /stopped after failure-category recurrence \(product-defect × 3 consecutive attempts/.test(l))).toBe(true);
		expect(calls.logs.some((l) => /stopped after .* on attempt 3/.test(l))).toBe(true);
		expect(calls.impl).toHaveLength(3);
		expect(calls.judge).toHaveLength(1);
	}, 20_000);

	it("(f2) hard cap stands at 4 for genuinely new signatures (fresh failure AND fresh footprint every attempt)", async () => {
		expect(maxPhaseAttempts()).toBe(4); // unchanged by this wave
		// Recurrence disabled so ONLY the cap can bound the loop; five distinct
		// failure signatures + fresh footprints = no valve can fire.
		process.env.SUPER_DEV_FAULT_RECURRENCE = "99";
		gateSeq([
			failCiting("tests/red.test.ts", "case 1"),
			failCiting("tests/red.test.ts", "case 2"),
			failCiting("tests/red.test.ts", "case 3"),
			failCiting("tests/red.test.ts", "case 4"),
			failCiting("tests/red.test.ts", "case 5"),
		]);
		implClaimsQueue = [claims("src/b1.ts"), claims("src/b2.ts"), claims("src/b3.ts"), claims("src/b4.ts"), claims("src/b5.ts")];
		const { ctx, calls } = mkCtx();
		await (implementationStage as Stage).run(mkState(SINGLE_PHASE), ctx);

		expect(calls.logs.some((l) => /attempt cap reached \(4 implementer attempts/.test(l))).toBe(true);
		expect(calls.impl).toHaveLength(4);
		expect(calls.judge).toHaveLength(0);
	}, 20_000);

	it("(g) a zero-change attempt (fresh failure signature, empty landed change set) escalates at attempt 2", async () => {
		// Distinct error texts ⇒ distinct failure signatures ⇒ repeatedNoProgress
		// CANNOT fire; only the zero-change plateau can trip at attempt 2.
		gateSeq([failCiting("tests/red.test.ts", "case A"), failCiting("tests/red.test.ts", "case B")]);
		implClaimsQueue = [claims("src/a.ts"), EMPTY_CLAIMS];
		const { ctx, calls } = mkCtx();
		await (implementationStage as Stage).run(mkState(SINGLE_PHASE), ctx);
		expect(calls.logs.some((l) => /stopped after zero-change plateau .* on attempt 2/.test(l))).toBe(true);
		expect(calls.logs.some((l) => /attempt 2 governor: .* footprint EMPTY \(zero landed file changes\)/.test(l))).toBe(true);
		expect(calls.judge).toHaveLength(1);
		expect(calls.impl).toHaveLength(2);
	}, 20_000);

	it("(g′) P8 bound: the FIRST attempt of a window is never a plateau — a lone zero-change attempt keeps the normal loop", async () => {
		gateSeq([failCiting("tests/red.test.ts", "case A")]);
		implClaimsDefault = EMPTY_CLAIMS;
		const { ctx, calls } = mkCtx({ maxImplAttempts: 1 });
		await (implementationStage as Stage).run(mkState(SINGLE_PHASE), ctx);

		expect(calls.judge).toHaveLength(0);
		expect(calls.logs.some((l) => /zero-change plateau/.test(l) && l.includes("stopped after"))).toBe(false);
		expect(calls.logs.some((l) => /budget exhausted/.test(l))).toBe(true);
	}, 20_000);

	it("(h) cross-scope test citation → judge routed IMMEDIATELY on the first occurrence (attempt 1), replan-upstream offered", async () => {
		gateSeq([failCiting("tests/profitability-contract.test.ts", "SCENARIO-014 keeps src/schemas.ts byte-untouched")]);
		implClaimsDefault = claims("src/x.ts");
		// Budget 1: phase-01's single dispatch is the run's whole question — the
		// route must fire at the attempt-1 boundary, before any second spawn.
		const { ctx, calls } = mkCtx({ maxImplAttempts: 1 });
		await (implementationStage as Stage).run(mkState(), ctx);

		const phase1Impl = calls.impl.filter((c) => (c.prompt ?? "").includes("- Phase: phase-01"));
		expect(phase1Impl).toHaveLength(1); // the budget was NOT consumed past the first occurrence
		expect(calls.impl).toHaveLength(1);
		expect(calls.judge).toHaveLength(1);
		expect(calls.judge[0]!.prompt).toContain("stage9.impl-no-progress.phase-01");
		expect(calls.judge[0]!.prompt).toContain("Cross-scope contract conflict");
		expect(calls.judge[0]!.prompt).toContain("tests/profitability-contract.test.ts — declared requireTests of phase-02");
		expect(calls.judge[0]!.prompt).toContain("- replan-upstream"); // the offered route set
		// P10: scope attribution logged at the attempt AND named in the stop.
		expect(calls.logs.some((l) => /CROSS-SCOPE: tests\/profitability-contract\.test\.ts \(requireTests of phase-02\)/.test(l))).toBe(true);
		expect(calls.logs.some((l) => /stopped after cross-scope contract conflict .* on attempt 1/.test(l))).toBe(true);
		// The HITL surface carries the attribution too (judge degraded → floor).
		expect(calls.escalations.length).toBeGreaterThanOrEqual(1);
		expect(calls.escalations[0]!.message).toContain("THIS FAILURE CITES TEST FILE(S) DECLARED BY ANOTHER PHASE");
	}, 20_000);

	it("(i) a same-scope citation does NOT route early — the normal loop runs (budget stop, no judge)", async () => {
		// The cited file is phase-01's OWN requireTests scope: same-scope by the
		// canonical phaseClauseFiles grammar; fresh failure signatures per attempt.
		gateSeq([failCiting("tests/red.test.ts", "case A"), failCiting("tests/red.test.ts", "case B")]);
		implClaimsQueue = [claims("src/a.ts"), claims("src/b.ts")];
		const { ctx, calls } = mkCtx({ maxImplAttempts: 2 });
		await (implementationStage as Stage).run(mkState(), ctx);
		expect(calls.judge).toHaveLength(0);
		expect(calls.impl).toHaveLength(2);
		expect(calls.logs.some((l) => /budget exhausted/.test(l))).toBe(true);
		expect(calls.logs.some((l) => /CROSS-SCOPE/.test(l))).toBe(false);
		// P10: the honest same-scope attribution is logged, not just the absence.
		expect(calls.logs.some((l) => /governor: .* citations same-scope or unattributable/.test(l))).toBe(true);
	}, 20_000);

	// ── pure helpers (exported; the stage wiring above exercises them live) ──

	it("landedFootprintIsEmpty: all-empty change classes ⇒ true; anything else ⇒ false (never throws)", async () => {
		const { landedFootprintIsEmpty, crossScopeTestCitations, crossScopeContractConflictFrame } = await import("../src/stages/implementation/index.ts");
		expect(landedFootprintIsEmpty('{"created":[],"modified":[],"deleted":[]}')).toBe(true);
		expect(landedFootprintIsEmpty('{"created":["a.ts"],"modified":[],"deleted":[]}')).toBe(false);
		expect(landedFootprintIsEmpty('{"modified":["a.ts"],"created":[],"deleted":[]}')).toBe(false);
		expect(landedFootprintIsEmpty('{"deleted":["a.ts"],"created":[],"modified":[]}')).toBe(false);
		expect(landedFootprintIsEmpty("not json")).toBe(false);
		expect(landedFootprintIsEmpty('{"created":null}')).toBe(false);
		// the structuredFootprint key family + absent-key-as-empty (supervisor unify)
		expect(landedFootprintIsEmpty('{"filesCreated":[],"filesModified":[],"filesDeleted":[]}')).toBe(true);
		expect(landedFootprintIsEmpty('{"filesCreated":["a.ts"]}')).toBe(false);
		expect(landedFootprintIsEmpty("{}")).toBe(true);
	});

	it("crossScopeTestCitations (pure): cross-phase requireTests ownership, co-declared files are same-scope, indices respected", async () => {
		const { crossScopeTestCitations } = await import("../src/stages/implementation/index.ts");
		const phases = [
			{ name: "p1", deliverables: { requireTests: ["tests/own.test.ts"], requireContains: [{ file: "src/shared.ts", pattern: "X" }] } },
			{ name: "p2", deliverables: { requireTests: ["tests/foreign.test.ts"] } },
			{ name: "p3", deliverables: { requireTests: ["tests/co-owned.test.ts"] } },
			{ name: "p4", deliverables: { requireTests: ["tests/co-owned.test.ts"] } },
		];
		// p1 citing the foreign file → conflict owned by p2.
		expect(crossScopeTestCitations(["tests/foreign.test.ts"], phases, 0)).toEqual([{ file: "tests/foreign.test.ts", ownerPhases: ["p2"] }]);
		// p1 citing its own file → same-scope, no conflict.
		expect(crossScopeTestCitations(["tests/own.test.ts"], phases, 0)).toEqual([]);
		// a file the current phase co-declares through ANY clause form is same-scope.
		expect(crossScopeTestCitations(["src/shared.ts", "tests/foreign.test.ts"], phases, 0)).toEqual([{ file: "tests/foreign.test.ts", ownerPhases: ["p2"] }]);
		// p3 citing co-owned.test.ts — it declared it itself → same-scope.
		expect(crossScopeTestCitations(["tests/co-owned.test.ts"], phases, 2)).toEqual([]);
		// p2 citing co-owned.test.ts (owned by p3+p4, not p2) → conflict, both owners.
		expect(crossScopeTestCitations(["tests/co-owned.test.ts"], phases, 1)).toEqual([{ file: "tests/co-owned.test.ts", ownerPhases: ["p3", "p4"] }]);
		// normalization parity (./, backslashes) and emptiness.
		expect(crossScopeTestCitations(["./tests/foreign.test.ts"], phases, 0)).toEqual([{ file: "tests/foreign.test.ts", ownerPhases: ["p2"] }]);
		expect(crossScopeTestCitations([], phases, 0)).toEqual([]);
		expect(crossScopeTestCitations(["tests/nowhere.test.ts"], phases, 0)).toEqual([]);
	});

	it("crossScopeContractConflictFrame (pure): names the phase, every citation and owning phase; offers replan-upstream", async () => {
		const { crossScopeContractConflictFrame } = await import("../src/stages/implementation/index.ts");
		const frame = crossScopeContractConflictFrame({
			phaseId: "phase-01",
			phaseName: "wiring",
			citations: [{ file: "tests/profitability-contract.test.ts", ownerPhases: ["phase-02"] }],
		});
		expect(frame.context).toContain("phase-01 (wiring)");
		expect(frame.context).toContain("tests/profitability-contract.test.ts — declared requireTests of phase-02");
		expect(frame.context).toContain("replan-upstream");
		expect(frame.allowedRoutes).toEqual(["replan-upstream", "challenge-test", "re-author-tests", "continue"]);
	});
});
