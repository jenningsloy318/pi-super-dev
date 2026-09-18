/**
 * The GREEN-boundary oracle — contract test for the v0.4.42 extraction
 * (increment 14 of the stage.ts split, the last control-flow-dense region).
 *
 * THE OUTCOME CONTRACT (3 arms): `green` (the upsert/emit/failure-cleanup
 * side effects ALREADY ran in-module — the caller only sets green=true and
 * breaks), `handoff-routed` (F4 routed; the arm carries the append message;
 * the caller owns terminalStopReason/attemptErrors/break), `continue`
 * (carries tddOracleFailures + coverageResult + the PHASE-scoped coverageGap
 * carry the next attempt's implementer prompt reads). The two F4 Tier-3 arms
 * stay FatalAbort throws.
 *
 * Real git repos for the restore; runCoverageGate mocked for verdict control.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";

vi.mock("../src/build-runner/coverage-gate.ts", async (importOriginal) => {
	const orig = await importOriginal<typeof import("../src/build-runner/coverage-gate.ts")>();
	return {
		...orig,
		runCoverageGate: vi.fn(() => ({ status: "measured", threshold: 85, perFile: [], detail: "mock" } as never)),
	};
});

vi.mock("../src/replan/replan.ts", async (importOriginal) => {
	const orig = await importOriginal<typeof import("../src/replan/replan.ts")>();
	return {
		...orig,
		triggerReplanForFindings: vi.fn(async () => true),
	};
});

import { runGreenBoundaryOracle } from "../src/stages/implementation/green-boundary.ts";
import { runCoverageGate } from "../src/build-runner/coverage-gate.ts";
import { triggerReplanForFindings } from "../src/replan/replan.ts";
import { FatalAbort } from "../src/nodes.ts";
import type { PipelineState, StageContext } from "../src/types.ts";

const coverageMock = vi.mocked(runCoverageGate);
const replanMock = vi.mocked(triggerReplanForFindings);

const repos: string[] = [];

function makeRepo(prefix: string): string {
	const repo = mkdtempSync(join(tmpdir(), prefix));
	const git = (...args: string[]) => spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
	git("init", "-q");
	git("config", "user.email", "t@t");
	git("config", "user.name", "t");
	mkdirSync(join(repo, "tests"));
	writeFileSync(join(repo, "tests/prod.test.ts"), "test('a', () => {});\n");
	git("add", "-A");
	git("commit", "-qm", "seed");
	repos.push(repo);
	return repo;
}

const ctxOf = (out: { logs: string[] }): StageContext => ({
	task: "t", options: {}, state: {} as PipelineState,
	budget: { count: 0, check: () => true, spent: () => true },
	log: (line: string) => { out.logs.push(line); }, phase: () => {}, events: new EventEmitter(), results: [],
} as unknown as StageContext);

const greenGate = { pass: true, buildSuccess: true, allTestsPass: true, typecheckSuccess: true, inScopePass: false, ran: ["m"], errors: [], outOfScopeErrors: [], baselineCheck: undefined };

const baseInput = (over: Record<string, unknown> = {}) => ({
	ctx: ctxOf({ logs: [] }),
	state: {} as PipelineState,
	worktreePath: "",
	specDirectory: undefined as string | undefined,
	defaultBranch: undefined as string | undefined,
	specIdentifier: "spec-x",
	phaseId: "phase-02",
	attempt: 1,
	phases: [
		{ name: "p1", deliverables: { requireFiles: ["src/one.ts"] } },
		{ name: "p2", deliverables: { requireFiles: ["src/two.ts"] } },
	] as Array<Record<string, unknown>>,
	idx: 1,
	phaseStatus: [{ id: "phase-01", status: "partial" }] as never,
	lastFailures: [{ phaseId: "phase-01", reasons: ["r"] }],
	acceptedRed: null as never,
	confirmedRedTargets: true,
	testFiles: ["tests/prod.test.ts"],
	redTestSnapshot: new Map<string, string | null>(),
	runnerSpec: null,
	covConventionsSpec: null,
	gate: greenGate,
	deliverablePass: true,
	changePass: true,
	symbolPass: true,
	declaredScope: new Set<string>(["src/two.ts"]),
	bridgedRequireFiles: [],
	projectStructured: { filesCreated: [], filesModified: [], filesDeleted: [] },
	replanAlreadyPending: false,
	runFuseTripped: false,
	emitPhaseStatus: () => {},
	announceActivity: () => {},
	attemptDetail: (n: number) => `attempt ${n}`,
	...over,
});

beforeEach(() => { vi.clearAllMocks(); replanMock.mockResolvedValue(true); });
afterEach(() => { for (const r of repos.splice(0)) rmSync(r, { recursive: true, force: true }); });

describe("green-boundary oracle (v0.4.42 increment-14 extraction)", () => {
	it("all gates green → the `green` arm, side effects ALREADY applied (upsert + emit + failure cleanup)", async () => {
		const repo = makeRepo("sd-gb-green-");
		const emitted: string[] = [];
		const status: Array<{ id: string; status: string }> = [{ id: "phase-01", status: "partial" }];
		const failures = [{ phaseId: "phase-02", reasons: ["old"] }];
		const out = await runGreenBoundaryOracle(baseInput({
			worktreePath: repo,
			phaseStatus: status as never,
			lastFailures: failures,
			emitPhaseStatus: (s: string) => emitted.push(s),
		}) as never);
		expect(out.kind).toBe("green");
		expect(status.some((e) => e.id === "phase-02" && e.status === "green")).toBe(true); // upsert ran in-module
		expect(emitted).toEqual(["ok"]); // emit ran in-module
		expect(failures.some((f) => f.phaseId === "phase-02")).toBe(false); // splice ran in-module
	});

	it("a still-red oracle → the `continue` arm carrying tddOracleFailures (never green)", async () => {
		const repo = makeRepo("sd-gb-red-");
		const out = await runGreenBoundaryOracle(baseInput({ worktreePath: repo, gate: { ...greenGate, pass: false, inScopePass: false } }) as never);
		expect(out.kind).toBe("continue");
		// build failed → the coverage gate never ran (broken builds never pay it)
		expect(coverageMock).not.toHaveBeenCalled();
	});

	it("GREEN-phase corruption of a confirmed RED test → RESTORED on disk + the failure entry (no regeneration)", async () => {
		const repo = makeRepo("sd-gb-corrupt-");
		const snapshot = new Map([["tests/prod.test.ts", "test('honest RED', () => { expect(1).toBe(2); });\n"]]);
		writeFileSync(join(repo, "tests/prod.test.ts"), "test('SABOTAGED', () => {});\n"); // implementer edit
		const out = await runGreenBoundaryOracle(baseInput({
			worktreePath: repo,
			acceptedRed: { testFiles: ["tests/prod.test.ts"] } as never,
			redTestSnapshot: snapshot,
			// no prior partial owns this file → F4 can never fire (today's behavior)
			phaseStatus: [] as never,
			lastFailures: [],
		}) as never);
		expect(readFileSync(join(repo, "tests/prod.test.ts"), "utf8")).toContain("honest RED"); // restored
		if (out.kind === "continue") {
			expect(out.tddOracleFailures[0]).toMatch(/^tdd-tests-modified-during-green: tests\/prod\.test\.ts/);
		} else throw new Error("expected continue");
	});

	it("F4 arm A: a restored test file belonging to a PRIOR PARTIAL phase → handoff-routed (sub-cap fresh)", async () => {
		const repo = makeRepo("sd-gb-f4-");
		const snapshot = new Map([["tests/prod.test.ts", "test('red', () => {});\n"]]);
		writeFileSync(join(repo, "tests/prod.test.ts"), "EDITED\n");
		// phase-01 (prior, PARTIAL) declares the test file → arm A match
		const phases = [
			{ name: "p1", deliverables: { requireFiles: ["src/one.ts", "tests/prod.test.ts"] } },
			{ name: "p2", deliverables: { requireFiles: ["src/two.ts"] } },
		];
		const specDir = mkdtempSync(join(tmpdir(), "sd-gb-spec-"));
		repos.push(specDir);
		const out = await runGreenBoundaryOracle(baseInput({
			worktreePath: repo,
			specDirectory: specDir,
			acceptedRed: { testFiles: ["tests/prod.test.ts"] } as never,
			redTestSnapshot: snapshot,
			phases: phases as never,
			phaseStatus: [{ id: "phase-01", status: "partial" }] as never,
			lastFailures: [{ phaseId: "phase-01", reasons: ["r"] }],
		}) as never);
		expect(out.kind).toBe("handoff-routed");
		if (out.kind !== "handoff-routed") throw new Error("narrow");
		expect(out.attemptErrorsAppend).toContain("declared-handoff (f4)");
		expect(out.attemptErrorsAppend).toContain("sourcePhase:phase-01");
		expect(replanMock).toHaveBeenCalledTimes(1);
	});

	it("F4 sub-cap already spent → Tier 3 FatalAbort (stop-the-line, no retry loop)", async () => {
		const repo = makeRepo("sd-gb-f4cap-");
		const specDir = mkdtempSync(join(tmpdir(), "sd-gb-speccap-"));
		repos.push(specDir);
		// seed one source:inherited-red row → the sub-cap is spent
		writeFileSync(join(specDir, "replan-requests.json"), JSON.stringify({ version: 1, rounds: 1, requests: [{ source: "inherited-red", status: "routed" }] }));
		const snapshot = new Map([["tests/prod.test.ts", "test('red', () => {});\n"]]);
		writeFileSync(join(repo, "tests/prod.test.ts"), "EDITED\n");
		const phases = [
			{ name: "p1", deliverables: { requireFiles: ["src/one.ts", "tests/prod.test.ts"] } },
			{ name: "p2", deliverables: { requireFiles: ["src/two.ts"] } },
		];
		await expect(runGreenBoundaryOracle(baseInput({
			worktreePath: repo,
			specDirectory: specDir,
			acceptedRed: { testFiles: ["tests/prod.test.ts"] } as never,
			redTestSnapshot: snapshot,
			phases: phases as never,
			phaseStatus: [{ id: "phase-01", status: "partial" }] as never,
			lastFailures: [{ phaseId: "phase-01", reasons: ["r"] }],
		}) as never)).rejects.toBeInstanceOf(FatalAbort);
	});

	it("F4 replan DECLINED → handoff-unavailable FatalAbort", async () => {
		const repo = makeRepo("sd-gb-f4no-");
		replanMock.mockResolvedValue(false);
		const snapshot = new Map([["tests/prod.test.ts", "test('red', () => {});\n"]]);
		writeFileSync(join(repo, "tests/prod.test.ts"), "EDITED\n");
		const phases = [
			{ name: "p1", deliverables: { requireFiles: ["src/one.ts", "tests/prod.test.ts"] } },
			{ name: "p2", deliverables: { requireFiles: ["src/two.ts"] } },
		];
		await expect(runGreenBoundaryOracle(baseInput({
			worktreePath: repo,
			specDirectory: mkdtempSync(join(tmpdir(), "sd-gb-specno-")),
			acceptedRed: { testFiles: ["tests/prod.test.ts"] } as never,
			redTestSnapshot: snapshot,
			phases: phases as never,
			phaseStatus: [{ id: "phase-01", status: "partial" }] as never,
			lastFailures: [{ phaseId: "phase-01", reasons: ["r"] }],
		}) as never)).rejects.toThrow(/declared handoff unavailable/);
	});

	it("the coverage gate: below-threshold → the `continue` arm with the populated coverageGap carry", async () => {
		const repo = makeRepo("sd-gb-cov-");
		coverageMock.mockReturnValueOnce({ status: "below-threshold", threshold: 85, linesPct: 42.3, perFile: [{ file: "src/two.ts", linesPct: 42.3 }], detail: "mock low" } as never);
		// a live phase-scoped runnerSpec makes covRunnerSpec non-null so the gate actually runs
		const out = await runGreenBoundaryOracle(baseInput({ worktreePath: repo, runnerSpec: { command: ["node", "--test"], targets: ["tests"] } as never }) as never);
		expect(out.kind).toBe("continue");
		if (out.kind !== "continue") throw new Error("narrow");
		expect(out.coverageResult?.status).toBe("below-threshold");
		expect(out.coverageGapOut[0]).toContain("42.3% lines vs the ≥85% hard floor");
		expect(out.coverageGapOut.some((l) => l.startsWith("src/two.ts:"))).toBe(true);
	});

	it("coverage UNMEASURABLE (no runner at all) → still green: loud carried debt, never a dead-lock", async () => {
		const repo = makeRepo("sd-gb-unm-");
		const out = await runGreenBoundaryOracle(baseInput({ worktreePath: repo, runnerSpec: null, covConventionsSpec: null }) as never);
		expect(out.kind).toBe("green"); // unmeasurable never blocks
		expect(coverageMock).not.toHaveBeenCalled(); // no runner → the no-runner branch, not the gate
	});

	it("a tddOracle failure blocks coverage entirely (the gate runs ONLY when every other gate is green)", async () => {
		const repo = makeRepo("sd-gb-order-");
		const snapshot = new Map([["tests/prod.test.ts", "test('red', () => { expect(1).toBe(2); });\n"]]);
		writeFileSync(join(repo, "tests/prod.test.ts"), "SABOTAGE\n");
		const out = await runGreenBoundaryOracle(baseInput({
			worktreePath: repo,
			acceptedRed: { testFiles: ["tests/prod.test.ts"] } as never,
			redTestSnapshot: snapshot,
			phaseStatus: [] as never,
			lastFailures: [],
		}) as never);
		expect(out.kind).toBe("continue");
		expect(coverageMock).not.toHaveBeenCalled(); // the tdd failure preempted the coverage cost
	});
});
