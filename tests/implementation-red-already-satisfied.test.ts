/**
 * F8 (incident 2026-09-04T14-45-04-784Z, Stage 9 phase 5) — the stale-baseline
 * half of the already-satisfied escape defect.
 *
 * `baselineDeliverablesSatisfied` is snapshotted at phase-attempt ENTRY; the
 * classifier consumed it at oracle time. In the incident, phase 5's ENTIRE
 * contains-only contract was satisfied on disk by the time the re-entries ran
 * (sibling commits dbdeb16/962ea41/bf0687d), yet every green RED-oracle was
 * classified `green-weak-test` → `red-not-confirmed` → retry → RED cleanup →
 * re-entry recomputes the same false baseline — 16 spins, 3.5h, one no-progress
 * escalation, on a SATISFIABLE phase.
 *
 * Contract under test: when the oracle is GREEN and the entry baseline was
 * false, the classifier input must re-evaluate the deliverable contract LIVE
 * at oracle time. Classification order is unchanged: polluted-red still wins
 * over already-satisfied (a RED-phase production edit can never masquerade),
 * and the Already-satisfied verification node re-runs build gate + deliverable
 * check deterministically before anything is accepted.
 *
 * Hermeticity: mirrors tests/implementation-red-loop.test.ts — the only
 * side-effecting imports of the stage are mocked (build-runner barrel + render),
 * `ctx.agent`/`ctx.helper` are scripted closures, no disk, no LLM.
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

import { implementationStage, classifyRedEvidence } from "../src/stages/implementation.ts";
import { runRedCheck, deliverablesAlreadyMet } from "../src/build-runner.ts";

const redCheck = runRedCheck as unknown as ReturnType<typeof vi.fn>;
const dam = deliverablesAlreadyMet as unknown as ReturnType<typeof vi.fn>;

/** The incident phase shape: contains-only contract, NO requireFiles. */
const CONTAINS_ONLY: DeliverableContract = {
	requireContains: [
		{ file: "tests/omisis-script-registry.test.ts", pattern: "CLOSED_THIRTEEN" },
		{ file: "python/tests/test_roles_determinism.py", pattern: "\"macro\":\\s*\"fetcher-bridge\"" },
	],
};

function mkState(): PipelineState {
	return {
		setup: {
			worktreePath: "/tmp/sd-red-already",
			specDirectory: "/tmp/sd",
			defaultBranch: "main",
			language: "frontend",
			isWebUi: false,
			specIdentifier: "f8",
			worktreeCreated: false,
			initializedRepo: false,
		},
		classify: { taskType: "feature", uiScope: "none", language: "frontend", isWebUi: false },
		spec: {
			phases: [{ name: "macro-registry-amendment", description: "registry closure", deliverables: CONTAINS_ONLY }],
		},
	} as unknown as PipelineState;
}

function mkCtx(opts: { budgetCheck?: () => boolean } = {}): { ctx: StageContext; logs: string[]; tdd: number; impl: number } {
	const logs: string[] = [];
	const calls = { tdd: 0, impl: 0 };
	const ctx: StageContext = {
		task: "",
		options: {} as RunOptions,
		state: {} as PipelineState,
		async helper(): Promise<HelperResult> {
			return { value: { languageInstructions: "" }, digest: "" };
		},
		async agent(call: AgentCall): Promise<AgentResult> {
			if (call.agent === "tdd-guide") {
				calls.tdd++;
				return { text: "", control: { testFiles: ["tests/omisis-script-registry.test.ts", "python/tests/test_roles_determinism.py"] } };
			}
			if (call.agent === "implementer") {
				calls.impl++;
				return { text: "", control: { filesModified: ["tests/omisis-script-registry.test.ts"] } };
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
			check: opts.budgetCheck ?? (() => true),
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
	return { ctx, logs, ...calls };
}

beforeEach(() => {
	redCheck.mockReset();
	dam.mockReset();
	redCheck.mockImplementation((_cwd: string, _targets: string[], opts?: { onResult?: (diagnostic: unknown) => void }) => {
		opts?.onResult?.({
			plan: { cwd: "/tmp/sd-red-already", argv: ["npm", "exec", "vitest", "--", "run", "tests/omisis-script-registry.test.ts"] },
			language: "backend",
			status: "green",
			exitCode: 0,
			signal: null,
			outputTail: "ok 1 - registry closure",
		});
		return "green";
	});
	dam.mockImplementation(() => false);
});

describe("F8 — oracle-time deliverable re-check routes green to already-satisfied", () => {
	it("incident class: baseline false at entry, contract satisfied by oracle time → converge via already-satisfied, NOT red-not-confirmed", async () => {
		// Call 1 = entry baseline (false: deliverables land after entry);
		// call 2 = the oracle-time LIVE re-check (true: everything satisfied).
		const q = [false, true];
		dam.mockImplementation(() => q.shift() ?? false);

		const { ctx, logs } = mkCtx();
		const res = (await (implementationStage as Stage).run(mkState(), ctx)) as ControlObj;

		// Converged on attempt 1: phase green via the Already-satisfied path.
		expect(res.phasesCompleted).toBe(1);
		expect(logs.some((l) => /red-oracle: green/.test(l))).toBe(true);
		expect(logs.some((l) => /RED already-satisfied: build=true, deliverables=true/.test(l))).toBe(true);
		// The honest flip is visible in the log (P10).
		expect(logs.some((l) => /oracle-time deliverable re-check: satisfied/.test(l))).toBe(true);
		// The incident's failure signature is ABSENT: no fake re-author loop.
		expect(logs.some((l) => /red-not-confirmed/.test(l))).toBe(false);
		expect(logs.some((l) => /RED generation retry/.test(l))).toBe(false);
		// Deliverables were consulted exactly twice: baseline + live re-check.
		expect(dam).toHaveBeenCalledTimes(2);
	});

	it("baseline true at entry (pre-existing path): still converges, no oracle-time re-check call", async () => {
		dam.mockImplementation(() => true);
		const { ctx, logs } = mkCtx();
		const res = (await (implementationStage as Stage).run(mkState(), ctx)) as ControlObj;

		expect(res.phasesCompleted).toBe(1);
		expect(logs.some((l) => /RED already-satisfied: build=true, deliverables=true/.test(l))).toBe(true);
		expect(logs.some((l) => /red-not-confirmed/.test(l))).toBe(false);
		expect(dam).toHaveBeenCalledTimes(1); // baseline only — no redundant re-check
	});

	it("misroute guard: contract NOT satisfied even live → red-not-confirmed retries still fire (green is not blanket-accepted)", async () => {
		dam.mockImplementation(() => false);
		let n = 0;
		const { ctx, logs } = mkCtx({ budgetCheck: () => n++ < 8 });

		const res = (await (implementationStage as Stage).run(mkState(), ctx)) as ControlObj;

		expect(res.phasesCompleted).toBe(0);
		expect(logs.some((l) => /red-not-confirmed/.test(l))).toBe(true);
		expect(logs.some((l) => /already-satisfied/.test(l))).toBe(false);
	});
});

describe("F8 — classification order pin (pollution can never masquerade as satisfied)", () => {
	it("classifyRedEvidence: forbidden files win over green + alreadySatisfied", () => {
		const evidence = classifyRedEvidence({
			phaseId: "phase-05",
			attempt: 1,
			redStatus: "green",
			testFiles: ["tests/x.test.ts"],
			changedFiles: ["src/schemas.ts"],
			boundary: { forbiddenFiles: ["src/schemas.ts"], approvedScaffold: [] } as never,
			redRetries: 0,
			alreadySatisfied: true,
		});
		expect(evidence.status).toBe("polluted-red");
	});

	it("classifyRedEvidence: green + alreadySatisfied (clean boundary) → green-already-satisfied", () => {
		const evidence = classifyRedEvidence({
			phaseId: "phase-05",
			attempt: 1,
			redStatus: "green",
			testFiles: ["tests/x.test.ts"],
			changedFiles: [],
			boundary: { forbiddenFiles: [], approvedScaffold: [] } as never,
			redRetries: 0,
			alreadySatisfied: true,
		});
		expect(evidence.status).toBe("green-already-satisfied");
	});
});
