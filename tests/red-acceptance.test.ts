/**
 * The RED acceptance boundary — contract test for the v0.4.45 extraction
 * (increment 17 of the stage.ts split).
 *
 * THE OUTCOME CONTRACT (6 arms): `red-weakening-partial` (the F5 routed
 * handoff — the caller sets the red-generation terminal pair and breaks),
 * `no-evidence`, `already-green` (the side-effect trio ran in-module),
 * `already-fail` (attemptErrors + missingDeliverables), `red-terminal`
 * (attemptErrors + terminalRedTries + the budget-overridden stop reason,
 * with the research-assist ARMING applied in-module on the by-ref record),
 * and `accepted` (the acceptedRed context + the fresh confirmed-RED
 * snapshot; the caller clears reauthorEvidence and falls through).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import type { PipelineState, StageContext } from "../src/types.ts";
import type { RedEvidence } from "../src/stages/implementation/red-evidence.ts";

vi.mock("../src/build-runner.ts", async (importOriginal) => {
	const orig = await importOriginal<typeof import("../src/build-runner.ts")>();
	return {
		...orig,
		runBuildGate: vi.fn(() => ({ pass: true, buildSuccess: true, allTestsPass: true, typecheckSuccess: true, inScopePass: false, ran: ["m"], errors: [], outOfScopeErrors: [], baselineCheck: undefined })),
		runDeliverableCheck: vi.fn(() => ({ pass: true, missing: [], ran: [] })),
	};
});

vi.mock("../src/stages/implementation/red-evidence.ts", async (importOriginal) => {
	const orig = await importOriginal<typeof import("../src/stages/implementation/red-evidence.ts")>();
	return {
		...orig,
		restoreUnacceptedRedChanges: vi.fn(),
	};
});

import { adjudicateRedAcceptance } from "../src/stages/implementation/red-acceptance.ts";
import { runBuildGate, runDeliverableCheck } from "../src/build-runner.ts";
import { restoreUnacceptedRedChanges } from "../src/stages/implementation/red-evidence.ts";
import { RESEARCH_ASSIST_RED_TRIGGER_TRIES } from "../src/stages/research-assist.ts";

const buildGateMock = vi.mocked(runBuildGate);
const deliverableMock = vi.mocked(runDeliverableCheck);
const restoreMock = vi.mocked(restoreUnacceptedRedChanges);

const repos: string[] = [];
function makeRepo(prefix: string): string {
	const repo = mkdtempSync(join(tmpdir(), prefix));
	const git = (...args: string[]) => spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
	git("init", "-q");
	git("config", "user.email", "t@t");
	git("config", "user.name", "t");
	mkdirSync(join(repo, "tests"));
	writeFileSync(join(repo, "tests/prod.test.ts"), "test('a', () => { expect(1).toBe(2); });\n");
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

const redEvidence: RedEvidence = { status: "red-behavior-failure", reason: "assertions fail", testFiles: ["tests/prod.test.ts"], changedFiles: ["tests/prod.test.ts"], forbiddenFiles: [] } as unknown as RedEvidence;

const baseInput = (over: Partial<Parameters<typeof adjudicateRedAcceptance>[0]> = {}): Parameters<typeof adjudicateRedAcceptance>[0] => ({
	ctx: ctxOf({ logs: [] }),
	state: {} as PipelineState,
	worktreePath: "",
	defaultBranch: undefined,
	phaseId: "phase-01",
	attempt: 1,
	terminalStopReason: "failed",
	retries: 0,
	redEvidence,
	redStatus: "red",
	testFiles: ["tests/prod.test.ts"],
	redChangedFiles: ["tests/prod.test.ts"],
	redFailClosedUnknown: false,
	phaseDeliverables: undefined,
	phaseStatus: [] as never,
	lastFailures: [] as never,
	phaseResearchAssistUsed: {},
	redAssistArmed: {},
	attemptDetail: (n: number) => `attempt ${n}`,
	announceActivity: () => {},
	emitPhaseStatus: () => {},
	...over,
});

beforeEach(() => { vi.clearAllMocks(); buildGateMock.mockReturnValue({ pass: true, buildSuccess: true, allTestsPass: true, typecheckSuccess: true, inScopePass: false, ran: ["m"], errors: [], outOfScopeErrors: [], baselineCheck: undefined }); deliverableMock.mockReturnValue({ pass: true, missing: [], ran: [] }); });
afterEach(() => { for (const r of repos.splice(0)) rmSync(r, { recursive: true, force: true }); });

describe("red acceptance (v0.4.45 increment-17 extraction)", () => {
	it("a ROUTED red-weakening handoff → red-weakening-partial with terminalRedTries = retries+1 (the scoped revert already ran at the escalation site)", () => {
		const out = adjudicateRedAcceptance(baseInput({ terminalStopReason: "red-weakening", retries: 5 }));
		expect(out.kind).toBe("red-weakening-partial");
		if (out.kind !== "red-weakening-partial") throw new Error("narrow");
		expect(out.terminalRedTries).toBe(6);
		expect(restoreMock).not.toHaveBeenCalled(); // never the full revert here
	});

	it("no evidence → no-evidence (the zero-tries terminal)", () => {
		const logs: string[] = [];
		const out = adjudicateRedAcceptance(baseInput({ ctx: ctxOf({ logs }), redEvidence: null }));
		expect(out.kind).toBe("no-evidence");
		expect(logs.some((l) => l.includes("RED generation failed after 0 tries"))).toBe(true);
	});

	it("already-satisfied + both gates pass → already-green with the side-effect trio applied in-module", () => {
		const status: Array<{ id: string; status: string }> = [{ id: "phase-01", status: "partial" }];
		const failures = [{ phaseId: "phase-01", reasons: ["old"] }];
		const emitted: string[] = [];
		const out = adjudicateRedAcceptance(baseInput({
			redEvidence: { ...redEvidence, status: "green-already-satisfied" } as RedEvidence,
			phaseStatus: status as never,
			lastFailures: failures as never,
			emitPhaseStatus: (s: string) => emitted.push(s),
		}));
		expect(out.kind).toBe("already-green");
		expect(status.some((e) => e.id === "phase-01" && e.status === "green")).toBe(true); // upsert ran
		expect(emitted).toEqual(["ok"]); // emit ran
		expect(failures.some((f) => f.phaseId === "phase-01")).toBe(false); // splice ran
	});

	it("already-satisfied + gate FAIL → already-fail carrying the gate errors + missing deliverables", () => {
		buildGateMock.mockReturnValueOnce({ pass: false, buildSuccess: false, allTestsPass: false, typecheckSuccess: false, inScopePass: false, ran: ["m"], errors: ["tsc broke"], outOfScopeErrors: [], baselineCheck: undefined });
		deliverableMock.mockReturnValueOnce({ pass: false, missing: ["src/gone.ts"], ran: [] });
		const logs: string[] = [];
		const out = adjudicateRedAcceptance(baseInput({
			ctx: ctxOf({ logs }),
			redEvidence: { ...redEvidence, status: "green-already-satisfied" } as RedEvidence,
		}));
		expect(out.kind).toBe("already-fail");
		if (out.kind !== "already-fail") throw new Error("narrow");
		expect(out.attemptErrors).toEqual(["tsc broke"]);
		expect(out.missingDeliverables).toEqual(["src/gone.ts"]);
		expect(logs.some((l) => l.includes("already-satisfied verification FAIL: tsc broke; deliverable: src/gone.ts"))).toBe(true);
	});

	it("the already-satisfied deliverable check wires skipTests from the gate verdict", () => {
		buildGateMock.mockReturnValueOnce({ pass: false, buildSuccess: false, allTestsPass: false, typecheckSuccess: false, inScopePass: false, ran: ["m"], errors: ["e"], outOfScopeErrors: [], baselineCheck: undefined });
		adjudicateRedAcceptance(baseInput({ redEvidence: { ...redEvidence, status: "green-already-satisfied" } as RedEvidence }));
		expect(deliverableMock.mock.calls[0]![2]).toMatchObject({ skipTests: true });
	});

	it("terminal RED failures (fail-closed) → red-terminal: the full revert, the stop-reason budget override, and the three log lines", () => {
		const logs: string[] = [];
		const out = adjudicateRedAcceptance(baseInput({
			ctx: ctxOf({ logs }),
			retries: 1,
			redFailClosedUnknown: true,
			redEvidence: { ...redEvidence, status: "unknown-no-runner", reason: "no runner" } as RedEvidence,
		}));
		expect(out.kind).toBe("red-terminal");
		if (out.kind !== "red-terminal") throw new Error("narrow");
		expect(out.terminalRedTries).toBe(2);
		expect(out.terminalStopReason).toBe("failed"); // the budget override (ctx.budget.check() true)
		expect(restoreMock).toHaveBeenCalledTimes(1);
		expect(logs.some((l) => l.includes("RED generation stopped after 2 tries"))).toBe(true);
		expect(logs.some((l) => l.includes("RED gate FAIL:"))).toBe(true);
	});

	it("the budget override: exhausted budget flips to budget + the (budget exhausted) suffix; no-progress is PRESERVED verbatim (7f682af4 F2)", () => {
		// exhausted budget → the override flips to "budget"
		const logs: string[] = [];
		const out = adjudicateRedAcceptance(baseInput({
			ctx: { ...ctxOf({ logs }), budget: { count: 0, check: () => false, spent: () => false } } as never,
			retries: 1,
			redFailClosedUnknown: true,
			redEvidence: { ...redEvidence, status: "unknown-no-runner", reason: "no runner" } as unknown as RedEvidence,
		}));
		expect(out.kind).toBe("red-terminal");
		if (out.kind !== "red-terminal") throw new Error("narrow");
		expect(out.terminalStopReason).toBe("budget");
		expect(logs.some((l) => l.includes("(budget exhausted)"))).toBe(true);
		// no-progress is PRESERVED (never overridden)
		const out2 = adjudicateRedAcceptance(baseInput({
			retries: 1,
			redFailClosedUnknown: true,
			terminalStopReason: "no-progress",
			redEvidence: { ...redEvidence, status: "unknown-no-runner", reason: "no runner" } as unknown as RedEvidence,
		}));
		if (out2.kind !== "red-terminal") throw new Error("narrow2");
		expect(out2.terminalStopReason).toBe("no-progress");
	});

	it("red-unverified WITHOUT fail-closed is NOT terminal — the P3 fall-through to acceptance", () => {
		const out = adjudicateRedAcceptance(baseInput({
			redEvidence: { ...redEvidence, status: "unknown-no-runner", reason: "no runner" } as RedEvidence,
			redFailClosedUnknown: false,
		}));
		expect(out.kind).toBe("accepted");
	});

	it("a terminal with ≥ RESEARCH_ASSIST_RED_TRIGGER_TRIES tries ARMS the assist (by-ref record); a spent cap does NOT", () => {
		const armed: Record<string, { tries: number }> = {};
		const logs: string[] = [];
		const out = adjudicateRedAcceptance(baseInput({
			ctx: ctxOf({ logs }),
			retries: RESEARCH_ASSIST_RED_TRIGGER_TRIES - 1,
			redFailClosedUnknown: true,
			redEvidence: { ...redEvidence, status: "unknown-no-runner", reason: "no runner" } as unknown as RedEvidence,
			redAssistArmed: armed as never,
		}));
		expect(out.kind).toBe("red-terminal");
		expect(armed["phase-01"]).toMatchObject({ tries: RESEARCH_ASSIST_RED_TRIGGER_TRIES });
		expect(logs.some((l) => l.includes("research-assist ARMED"))).toBe(true);
		// the spent cap: no re-arm, the honest log
		const logs2: string[] = [];
		const armed2: Record<string, { tries: number }> = {};
		adjudicateRedAcceptance(baseInput({
			ctx: ctxOf({ logs: logs2 }),
			retries: RESEARCH_ASSIST_RED_TRIGGER_TRIES - 1,
			redFailClosedUnknown: true,
			redEvidence: { ...redEvidence, status: "unknown-no-runner", reason: "no runner" } as unknown as RedEvidence,
			phaseResearchAssistUsed: { "phase-01": true },
			redAssistArmed: armed2 as never,
		}));
		expect(armed2["phase-01"]).toBeUndefined();
		expect(logs2.some((l) => l.includes("assist cap already spent"))).toBe(true);
	});

	it("acceptance: acceptedRed carries the copies + the fresh confirmed-RED snapshot from disk", () => {
		const repo = makeRepo("sd-ra-accept-");
		const out = adjudicateRedAcceptance(baseInput({ worktreePath: repo }));
		expect(out.kind).toBe("accepted");
		if (out.kind !== "accepted") throw new Error("narrow");
		expect(out.acceptedRed.status).toBe("red");
		expect(out.acceptedRed.testFiles).toEqual(["tests/prod.test.ts"]);
		expect(out.redTestSnapshot).not.toBeNull();
		expect(out.redTestSnapshot!.get("tests/prod.test.ts")).toContain("expect(1).toBe(2)");
	});

	it("acceptance with a non-red status → redTestSnapshot is NULL (the caller preserves the prior phase-hoisted snapshot — 8c5d07bc F1)", () => {
		const repo = makeRepo("sd-ra-nonred-");
		const out = adjudicateRedAcceptance(baseInput({ worktreePath: repo, redStatus: "unknown" }));
		expect(out.kind).toBe("accepted");
		if (out.kind !== "accepted") throw new Error("narrow");
		// NOT an empty map: an unconditional rebind would blind the GREEN-boundary
		// oracle's changedSinceSnapshot to implementer edits of the prior confirmed RED
		expect(out.redTestSnapshot).toBeNull();
	});
});
