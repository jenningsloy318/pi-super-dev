/**
 * The tdd dispatch + claim discipline — contract test for the v0.4.46
 * extraction (increment 18 of the stage.ts split, the RED oracle pipeline
 * head re-sliced at the dispatch/oracle seam).
 *
 * THE CONTRACTS: the v0.3.16 F1 claim discipline (a non-completed agent
 * produced NOTHING this try — the previous claim is DISCARDED, the log
 * annotates it; a completed agent's new claim updates the carry), the legacy
 * fallback (control-bearing path with absent testFiles keeps the prior
 * claim), the tddId naming (first try vs red-retry), the step-glyph error
 * reflection, and the HEAD-drift advisory on a real repo (a self-commit
 * during the call is detected + recorded, never blocking).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import type { PipelineState, StageContext } from "../src/types.ts";

vi.mock("../src/convergence-ledger.ts", async (importOriginal) => {
	const orig = await importOriginal<typeof import("../src/convergence-ledger.ts")>();
	return {
		...orig,
		recordConvergenceFindings: vi.fn(),
	};
});

import { dispatchRedTdd, type RedTddDispatchInput } from "../src/stages/implementation/red-tdd-dispatch.ts";
import { recordConvergenceFindings } from "../src/convergence-ledger.ts";

const recordMock = vi.mocked(recordConvergenceFindings);

const repos: string[] = [];
function makeRepo(prefix: string): string {
	const repo = mkdtempSync(join(tmpdir(), prefix));
	const git = (...args: string[]) => spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
	git("init", "-q");
	git("config", "user.email", "t@t");
	git("config", "user.name", "t");
	mkdirSync(join(repo, "src"));
	writeFileSync(join(repo, "src/seed.ts"), "export const S = 1;\n");
	git("add", "-A");
	git("commit", "-qm", "seed");
	repos.push(repo);
	return repo;
}

const ctxOf = (agent?: unknown): StageContext => ({
	task: "t", options: {}, state: {} as PipelineState,
	budget: { count: 0, check: () => true, spent: () => true },
	log: () => {}, phase: () => {}, events: new EventEmitter(), results: [],
	agent: agent ?? (async () => ({ control: {} })),
} as unknown as StageContext);

const baseInput = (over: Partial<RedTddDispatchInput> = {}): RedTddDispatchInput => ({
	ctx: ctxOf(),
	state: { classify: null, spec: null, bdd: null } as unknown as PipelineState,
	setup: { worktreePath: "", specDirectory: "", defaultBranch: undefined } as never,
	phase: { name: "p1", description: "d" } as never,
	phaseId: "phase-01",
	attempt: 1,
	retries: 0,
	redTryDetail: "attempt 1, try 1",
	redHint: "",
	reauthorEvidence: "",
	lang: "",
	testFiles: [],
	announceActivity: () => {},
	emitStep: () => {},
	inStepScope: async (_seq: number, _label: string, fn: () => Promise<unknown>) => fn() as never,
	nextStepSeq: () => 1,
	...over,
});

beforeEach(() => { vi.clearAllMocks(); });
afterEach(() => { for (const r of repos.splice(0)) rmSync(r, { recursive: true, force: true }); });

describe("red tdd dispatch (v0.4.46 increment-18 extraction)", () => {
	it("a completed agent's new claim updates the carry + lastClaimedTestFiles", async () => {
		const logs: string[] = [];
		const ctx = ctxOf(async () => ({ control: { testFiles: ["tests/new.test.ts"], summary: "authored" } }));
		ctx.log = (l: string) => logs.push(l);
		const out = await dispatchRedTdd(baseInput({ ctx, setup: { worktreePath: makeRepo("sd-td-claim-"), specDirectory: "", defaultBranch: undefined } as never }));
		expect(out.tddNotCompleted).toBe(false);
		expect(out.testFiles).toEqual(["tests/new.test.ts"]);
		expect(out.lastClaimedTestFiles).toEqual(["tests/new.test.ts"]);
		expect(logs.some((l) => l.includes("tdd-guide (try 1): test files=tests/new.test.ts") && l.includes("— authored"))).toBe(true);
	});

	it("the v0.3.16 F1 discipline: an ERRORED agent → the previous claim DISCARDED + the annotation", async () => {
		const logs: string[] = [];
		const ctx = ctxOf(async () => ({ control: null, error: "timed out" }));
		ctx.log = (l: string) => logs.push(l);
		const out = await dispatchRedTdd(baseInput({ ctx, testFiles: ["tests/old.test.ts"] }));
		expect(out.tddNotCompleted).toBe(true);
		expect(out.testFiles).toEqual([]); // the ghost-file lesson: never oracle stale state
		expect(out.lastClaimedTestFiles).toBeNull(); // the prior carry is NOT overwritten
		expect(logs.some((l) => l.includes("error=timed out") && l.includes("(agent did not complete — previous claim discarded)"))).toBe(true);
	});

	it("the legacy fallback: a completed control with ABSENT testFiles keeps the prior claim", async () => {
		const ctx = ctxOf(async () => ({ control: { summary: "no files listed" } }));
		const out = await dispatchRedTdd(baseInput({ ctx, testFiles: ["tests/prior.test.ts"] }));
		expect(out.tddNotCompleted).toBe(false);
		expect(out.testFiles).toEqual(["tests/prior.test.ts"]);
	});

	it("the tddId naming: first try vs red-retry", async () => {
		const calls: Array<Record<string, unknown>> = [];
		const ctx = ctxOf(async (a: Record<string, unknown>) => { calls.push(a); return { control: {} }; });
		await dispatchRedTdd(baseInput({ ctx, retries: 0 }));
		await dispatchRedTdd(baseInput({ ctx, retries: 2 }));
		expect(calls[0]!.id).toBe("pipeline.implementation.phase-01.tdd.a1");
		expect(calls[1]!.id).toBe("pipeline.implementation.phase-01.tdd.red2.a1");
	});

	it("the HEAD-drift advisory: a self-commit DURING the call is detected + recorded, never blocking", async () => {
		const repo = makeRepo("sd-td-drift-");
		const ctx = ctxOf(async () => {
			// the agent self-commits before resolving
			writeFileSync(join(repo, "src/landed.ts"), "export const L = 1;\n");
			spawnSync("git", ["-C", repo, "add", "-A"], { encoding: "utf8" });
			spawnSync("git", ["-C", repo, "commit", "-qm", "self-commit"], { encoding: "utf8" });
			return { control: { testFiles: ["tests/x.test.ts"] } };
		});
		const logs: string[] = [];
		ctx.log = (l: string) => logs.push(l);
		const state = baseInput().state;
		const out = await dispatchRedTdd(baseInput({ ctx, state, setup: { worktreePath: repo, specDirectory: "", defaultBranch: undefined } as never }));
		expect(out.tddNotCompleted).toBe(false); // the advisory never blocks
		expect(logs.some((l) => l.includes("advisory: tdd-guide self-commit detected"))).toBe(true);
		expect(recordMock).toHaveBeenCalledTimes(1);
		expect(recordMock.mock.calls[0]![1]).toMatchObject({ severity: "low", blocking: false, sourceGate: "self-commit" });
		// 5c3442da nit 1: the state identity + the routing options
		expect(recordMock).toHaveBeenCalledWith(state, expect.objectContaining({ severity: "low" }), { detectedAtStage: "implementation", ownerStage: "implementation", sourceGate: "self-commit" });
	});

	it("no HEAD drift → no advisory, no ledger row", async () => {
		const repo = makeRepo("sd-td-clean-");
		const out = await dispatchRedTdd(baseInput({ ctx: ctxOf(async () => ({ control: { testFiles: ["tests/x.test.ts"] } })), setup: { worktreePath: repo, specDirectory: "", defaultBranch: undefined } as never }));
		expect(out.tddNotCompleted).toBe(false);
		expect(recordMock).not.toHaveBeenCalled();
	});

	it("the step glyph reflects an errored call (failed, not ok)", async () => {
		const steps: Array<[string, string]> = [];
		const ctx = ctxOf(async () => ({ control: null, error: "x" }));
		await dispatchRedTdd(baseInput({
			ctx,
			emitStep: (label: string, status: string) => steps.push([label, status]),
		}));
		expect(steps).toEqual([["TDD RED (attempt 1, try 1)", "running"], ["TDD RED (attempt 1, try 1)", "failed"]]);
	});
});
