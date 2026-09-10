/**
 * v0.3.85 F5 — the RED-phase assertion ratchet (C3 fix; §9 F5, §14 ADR 10 of
 * docs/requirements/run-2026-09-09-poisoned-baseline-postmortem-v0.3.85.md).
 *
 * The C3 defect: during RED the boundary LEGALLY admits edits to pre-existing
 * test files (the GREEN-side test-edit ban is v0.3.43), and the 09-09 phase-1
 * tdd-guide answered an "unsatisfiable RED" by gutting 3 pre-existing guard
 * suites — the oracle went green and the phase misrouted. F5: a pre-existing
 * test file's assertion-surface count must never decrease vs its pre-edit HEAD
 * state; a decrease is the NEW unaccepted-RED class `weakened-preexisting-test`
 * riding the existing revert + corrective-hint + bounded-retry machinery
 * (MAX_RED_RETRIES, NOT counted against F3's phase attempt cap), escalating on
 * exhaustion / persistent weakening via triggerReplanForFindings with
 * source:"red-weakening" + sourcePhase (ADR 8's fourth pool consumer, NO
 * inherited-red sub-cap; ADR 10: retry first — the hint teaches a legal
 * alternative — unlike F4's provably-futile immediate escalation).
 *
 * Hermeticity: pure grammar/comparator rows first, then stage-level
 * walkthroughs per tests/implementation-inherited-red.test.ts (mocked
 * build-runner barrel + REAL temp git repos so HEAD reads, porcelain, and the
 * scoped revert are all real). No LLM, no network.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { BuildGateResult } from "../src/build-runner.ts";
import type { AgentCall, AgentResult, HelperResult, PipelineState, RunOptions, Stage, StageContext } from "../src/types.ts";
import type { RedEvidence } from "../src/stages/implementation.ts";

vi.mock("../src/build-runner.ts", async (orig) => {
	const a = (await orig()) as Record<string, unknown>;
	return {
		...a,
		runRedCheck: vi.fn((): string => "red"),
		runBuildGate: vi.fn((): Partial<BuildGateResult> => PASS_GATE),
		runDeliverableCheck: vi.fn(() => DELIV_PASS),
		computeChangeGate: vi.fn(() => ({ pass: true, claimedNotChanged: [], changedNotClaimed: [], advisory: [] })),
		resetDeliverableCheckCache: vi.fn(() => {}),
		deliverablesAlreadyMet: vi.fn(() => false),
	};
});
vi.mock("../src/render/render.ts", () => ({ renderAndWrite: vi.fn() }));
vi.mock("../src/render/reflection.ts", () => ({ runReflectionAsync: vi.fn() }));
vi.mock("../src/render/user-notes.ts", () => ({ userNotesForAgent: vi.fn(() => "") }));

import { assertionSurfaceCount, weakenedAssertionSurfaces, redGenerationRetryHint, redEvidenceFailureReasons, implementationStage } from "../src/stages/implementation.ts";
import { runRedCheck, deliverablesAlreadyMet } from "../src/build-runner.ts";
import { deriveRunStatus } from "../src/workflow.ts";
import { REPLAN_REQUESTS_FILE } from "../src/replan/replan.ts";
import { countInheritedRedOccurrences } from "../src/stages/inherited-red.ts";

const redCheck = vi.mocked(runRedCheck);
const dam = vi.mocked(deliverablesAlreadyMet);
/** Per-test-file-key oracle call counts (the keyed RED/GREEN mock's state). */
const redCalls = new Map<string, number>();

const PASS_GATE: Partial<BuildGateResult> = { pass: true, buildSuccess: true, allTestsPass: true, typecheckSuccess: true, inScopePass: true, ran: ["mock"], errors: [], outOfScopeErrors: [] };
const DELIV_PASS = { pass: true, missing: [] as string[], ran: [] as string[] };

// ─── pure: the assertion-surface grammar (P2 — rows, not one form) ──────────

describe("F5 grammar — assertionSurfaceCount", () => {
	it("counts each marker occurrence: JS/TS test declarations + expect calls", () => {
		expect(assertionSurfaceCount("it('a', () => { expect(1).toBe(1); });\nit('b', () => { expect(2).toBe(2); });")).toBe(4);
		expect(assertionSurfaceCount("test('a', () => { expect(1).toBe(1); });")).toBe(2);
	});
	it("counts pytest asserts and Rust assert! / assert_eq! (word-start `assert`); python `def test_x():` carries NO declaration marker — its surface rides the asserts", () => {
		expect(assertionSurfaceCount("def test_x():\n    assert f() == 1")).toBe(1);
		expect(assertionSurfaceCount("assert!(f());\nassert_eq!(f(), 1);")).toBe(2);
	});
	it("counts SCENARIO ids case-sensitively (the harness's uppercase id grammar)", () => {
		expect(assertionSurfaceCount("// SCENARIO-001 SCENARIO-002\n// scenario-003 Scenario: lower")).toBe(2);
	});
	it("allows whitespace before the paren (`it (`) and skips prose words (submit/commit)", () => {
		expect(assertionSurfaceCount("it ('spaced', () => {});")).toBe(1);
		expect(assertionSurfaceCount("submit(1); commit(2); emit(3);")).toBe(0);
	});
	it("documented fail-open rows: markers inside comments and prose words like `expected` COUNT (comment-stripping is deliberately skipped)", () => {
		expect(assertionSurfaceCount("// it( was removed, expect nothing")).toBe(2);
		expect(assertionSurfaceCount("const expected = await getValue();")).toBe(1);
	});
	it("out-of-grammar forms do not count: describe/test.skip declarations carry no declaration marker", () => {
		expect(assertionSurfaceCount("describe('x', () => {});")).toBe(0);
		expect(assertionSurfaceCount("test.skip('x', () => { expect(1).toBe(1); });")).toBe(1); // only the inner expect
	});
	it("empty content is surface 0", () => {
		expect(assertionSurfaceCount("")).toBe(0);
	});
});

describe("F5 predicate — weakenedAssertionSurfaces", () => {
	it("flags a strict decrease with its before→after counts", () => {
		expect(weakenedAssertionSurfaces([{ path: "tests/g.test.ts", before: "it(1); it(2); expect(3);", after: "it(1);" }]))
			.toEqual([{ path: "tests/g.test.ts", before: 3, after: 1 }]);
	});
	it("increase is LEGAL (adding assertions to a pre-existing file) and equal passes", () => {
		expect(weakenedAssertionSurfaces([
			{ path: "a.test.ts", before: "it(1);", after: "it(1); expect(2); expect(3);" },
			{ path: "b.test.ts", before: "it(1); expect(2);", after: "test('x'); expect(2);" },
		])).toEqual([]);
	});
	it("a NEW file (before null) is exempt — it survives the ratchet and the revert", () => {
		expect(weakenedAssertionSurfaces([{ path: "tests/new.test.ts", before: null, after: "" }])).toEqual([]);
	});
	it("deleting a pre-existing test file counts as surface 0 (a decrease when HEAD had markers)", () => {
		expect(weakenedAssertionSurfaces([{ path: "tests/gone.test.ts", before: "it(1); expect(2);", after: null }]))
			.toEqual([{ path: "tests/gone.test.ts", before: 2, after: 0 }]);
	});
});

// ─── pure: the rejection class's hint + reason templates ────────────────────

function mkEvidence(partial: Partial<RedEvidence>): RedEvidence {
	return { phaseId: "phase-01", attempt: 1, status: "weakened-preexisting-test", oracleStatus: "red", testFiles: ["tests/guards.test.ts"], changedFiles: ["tests/guards.test.ts"], forbiddenFiles: [], redRetries: 1, ...partial };
}

describe("F5 hint + failure reason templates", () => {
	it("the corrective hint carries the exact adjudicated semantics: (a) no decrease, (b) independent NEW file, (c) spec amendment via the declared route", () => {
		const hint = redGenerationRetryHint(mkEvidence({ weakenedFiles: [{ path: "tests/guards.test.ts", before: 14, after: 10 }] })) ?? "";
		expect(hint).toContain("RED assertion ratchet rejected the previous test set");
		expect(hint).toContain("must not decrease");
		expect(hint).toContain("independent NEW test file");
		expect(hint).toContain("SPEC AMENDMENT");
		expect(hint).toContain("declared route");
		expect(hint).toContain("tests/guards.test.ts (14→10 markers)");
	});
	it("the failure reason names the class and the legal route", () => {
		const reasons = redEvidenceFailureReasons(mkEvidence({ weakenedFiles: [{ path: "tests/guards.test.ts", before: 14, after: 10 }], reason: "pre-existing test assertion surface decreased: tests/guards.test.ts 14→10" }));
		expect(reasons[0]).toContain("red-weakened-preexisting:");
		expect(reasons[0]).toContain("tests/guards.test.ts 14→10");
	});
});

// ─── stage-level walkthroughs (real git repos) ──────────────────────────────

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", "stdio": ["ignore", "pipe", "pipe"] }).trim();
}

/** The frozen guard suite: 7 `it(` + 7 `expect` → assertion surface 14. */
const GUARD_LINES = Array.from({ length: 7 }, (_, i) => `it('guard ${i}', () => { expect(guard${i}()).toBe(${i}); });`);
const GUARD_HEAD = `${GUARD_LINES.join("\n")}\n`;
/** A weakened variant keeping only the first k guard lines → surface 2k. */
const weakenedGuard = (k: number): string => `${GUARD_LINES.slice(0, k).join("\n")}\n`;
const GUARD_PATH = "tests/guards.test.ts";
const NEW_RED_PATH = "tests/independent-red.test.ts";
const NEW_RED_CONTENT = "import { feature } from '../src/feature';\nit('the missing behavior fails', () => { expect(feature()).toBe(42); });\n";

function mkRepo(): string {
	const wt = mkdtempSync(join(tmpdir(), "sd-f5-"));
	git(wt, "init", "-q", "-b", "main");
	git(wt, "config", "user.email", "t@t");
	git(wt, "config", "user.name", "t");
	mkdirSync(join(wt, "tests"), { recursive: true });
	writeFileSync(join(wt, GUARD_PATH), GUARD_HEAD);
	git(wt, "add", "-A");
	git(wt, "commit", "-qm", "frozen guards");
	return wt;
}

const repos: string[] = [];
const dirs: string[] = [];
function mkSpecDir(): string {
	const d = mkdtempSync(join(tmpdir(), "sd-f5-spec-"));
	dirs.push(d);
	return d;
}

interface TddTry {
	/** Files the tdd-guide claims as its RED targets. */
	testFiles: string[];
	/** Disk writes performed when this tdd-guide call runs (real side effects). */
	writeFiles?: Array<{ path: string; content: string }>;
}

function mkState(wt: string, specDir: string): PipelineState {
	return {
		task: "f5",
		options: {},
		setup: { worktreePath: wt, specDirectory: specDir, defaultBranch: "main", language: "frontend", isWebUi: false, specIdentifier: "f5-test", worktreeCreated: false, initializedRepo: false },
		classify: { taskType: "feature", uiScope: "none", language: "frontend", isWebUi: false },
		spec: { phases: [{ name: "P1", deliverables: { requireFiles: ["src/prod.ts"] } }] },
	} as unknown as PipelineState;
}

function mkCtx(wt: string, tries: TddTry[]) {
	const logs: string[] = [];
	const tddCalls: AgentCall[] = [];
	const implCalls: AgentCall[] = [];
	/** Observed disk state at the START of each tdd-guide call (mid-flight probes). */
	const diskAtTdd: Array<{ guard: string | null; newFile: boolean }> = [];
	const queue = [...tries];
	const ctx: StageContext = {
		task: "f5", options: {} as RunOptions, state: {} as PipelineState,
		async helper(): Promise<HelperResult> { return { value: { languageInstructions: "" }, digest: "" }; },
		async agent(call: AgentCall): Promise<AgentResult> {
			if (call.agent === "tdd-guide") {
				tddCalls.push(call);
				diskAtTdd.push({ guard: existsSync(join(wt, GUARD_PATH)) ? readFileSync(join(wt, GUARD_PATH), "utf8") : null, newFile: existsSync(join(wt, NEW_RED_PATH)) });
				const step = queue.length > 1 ? queue.shift()! : (queue[0] ?? { testFiles: [NEW_RED_PATH] });
				for (const w of step.writeFiles ?? []) {
					mkdirSync(dirname(join(wt, w.path)), { recursive: true });
					writeFileSync(join(wt, w.path), w.content);
				}
				return { text: "", control: { testFiles: step.testFiles } };
			}
			if (call.agent === "implementer") {
				implCalls.push(call);
				return { text: "ok", control: { filesModified: ["src/prod.ts"] } };
			}
			if (call.agent === "code-reviewer") {
				return { text: "", control: { verdict: "strong", summary: "ok", contradictions: [] } };
			}
			return { text: "ok", control: {} };
		},
		async parallel(cs: Array<() => Promise<AgentResult>>) { return Promise.all(cs.map((c) => c())); },
		budget: { check: () => true, spent: () => true, count: 0 },
		log: (m: string) => logs.push(m),
		phase: () => {},
		events: { on: () => () => {}, emit: () => {} } as never,
		results: [],
	};
	return { ctx, logs, tddCalls, implCalls, diskAtTdd };
}

const hasLog = (logs: string[], needle: string) => logs.some((l) => l.includes(needle));

beforeEach(() => {
	redCheck.mockReset();
	// Keyed oracle (the implementation-inherited-red.test.ts pattern): the FIRST
	// run against a given test-file set is RED (the fresh RED), every later run
	// GREEN (post-implementer re-checks must see the made-green targets).
	redCheck.mockImplementation((_cwd: string, testFiles: string[]) => {
		const key = testFiles.join(",");
		const n = (redCalls.get(key) ?? 0) + 1;
		redCalls.set(key, n);
		return n === 1 ? "red" : "green";
	});
	redCalls.clear();
	dam.mockReset();
	dam.mockImplementation(() => false);
});
afterEach(() => {
	delete process.env.SUPER_DEV_MAX_PHASE_ATTEMPTS;
	delete process.env.SUPER_DEV_MAX_REPLAN_ROUNDS;
	for (const r of repos.splice(0)) rmSync(r, { recursive: true, force: true });
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const readReplanRequests = (specDir: string): { rounds: number; requests: Array<Record<string, unknown>> } =>
	JSON.parse(readFileSync(join(specDir, REPLAN_REQUESTS_FILE), "utf8"));

describe("F5 stage walkthroughs — reject, revert scope, recover", () => {
	it("decrease detected at ACCEPTANCE → rejected as weakened-preexisting-test with the class named, the corrective hint fed to the retry, and the guard restored", async () => {
		const wt = mkRepo(); repos.push(wt);
		const specDir = mkSpecDir();
		const { ctx, logs, tddCalls, implCalls, diskAtTdd } = mkCtx(wt, [
			// try 1: weakens the guard AND authors an independent file (the salvage
			// case — the scoped revert must keep the independent work)
			{ testFiles: [GUARD_PATH, NEW_RED_PATH], writeFiles: [{ path: GUARD_PATH, content: weakenedGuard(5) }, { path: NEW_RED_PATH, content: NEW_RED_CONTENT }] },
			{ testFiles: [NEW_RED_PATH], writeFiles: [{ path: NEW_RED_PATH, content: NEW_RED_CONTENT }] }, // try 2: the legal route alone
		]);

		const out = (await (implementationStage as Stage).run(mkState(wt, specDir), ctx)) as unknown as { allGreen: boolean; phaseStatus: Array<{ id: string; status: string }> };

		// The rejection + its class name.
		expect(hasLog(logs, "RED assertion ratchet: REJECTED — weakened pre-existing test file(s) tests/guards.test.ts (14→10 markers)")).toBe(true);
		expect(hasLog(logs, "red-weakened-preexisting: tests/guards.test.ts 14→10")).toBe(true);
		// The oracle was RED on the weakened set — the ratchet fired at ACCEPTANCE
		// anyway (the still-red partial-weakening shape the 09-09 incident class
		// generalizes to; a weakened oracle can NEVER reach GREEN).
		expect(logs.some((l) => /red-oracle: red/.test(l))).toBe(true);
		// The corrective hint rode the retry prompt with the (a)/(b)/(c) semantics.
		expect(tddCalls).toHaveLength(2);
		expect(tddCalls[1]!.prompt).toContain("RED assertion ratchet rejected the previous test set");
		expect(tddCalls[1]!.prompt).toContain("must not decrease");
		expect(tddCalls[1]!.prompt).toContain("independent NEW test file");
		expect(tddCalls[1]!.prompt).toContain("SPEC AMENDMENT");
		// SCOPED revert: at try 2's start the guard is byte-identical to HEAD...
		expect(diskAtTdd[1]!.guard).toBe(GUARD_HEAD);
		// ...and the try-1 independent file SURVIVED the revert (salvageability).
		expect(diskAtTdd[1]!.newFile).toBe(true);
		// The recovery converged: one implementer attempt, phase green, guard intact.
		expect(implCalls).toHaveLength(1);
		expect(out.phaseStatus[0]).toMatchObject({ id: "phase-01", status: "green" });
		expect(readFileSync(join(wt, GUARD_PATH), "utf8")).toBe(GUARD_HEAD);
	}, 20_000);

	it("increase is legal: ADDING assertions to the pre-existing guard during RED stays accepted (no ratchet rejection)", async () => {
		const wt = mkRepo(); repos.push(wt);
		const specDir = mkSpecDir();
		const strengthened = `${GUARD_HEAD}it('guard extra', () => { expect(extra()).toBe(1); });\n`;
		const { ctx, logs, tddCalls, implCalls } = mkCtx(wt, [
			{ testFiles: [GUARD_PATH], writeFiles: [{ path: GUARD_PATH, content: strengthened }] },
		]);

		const out = (await (implementationStage as Stage).run(mkState(wt, specDir), ctx)) as unknown as { phaseStatus: Array<{ id: string; status: string }> };

		expect(logs.some((l) => l.includes("RED assertion ratchet"))).toBe(false);
		expect(tddCalls).toHaveLength(1);
		expect(implCalls).toHaveLength(1);
		expect(out.phaseStatus[0]).toMatchObject({ status: "green" });
		expect(readFileSync(join(wt, GUARD_PATH), "utf8")).toBe(strengthened); // the legal edit survived
	}, 20_000);

	it("the NEW-file happy path is unchanged: a fresh independent RED is accepted with zero ratchet activity", async () => {
		const wt = mkRepo(); repos.push(wt);
		const specDir = mkSpecDir();
		const { ctx, logs, implCalls } = mkCtx(wt, [
			{ testFiles: [NEW_RED_PATH], writeFiles: [{ path: NEW_RED_PATH, content: NEW_RED_CONTENT }] },
		]);

		const out = (await (implementationStage as Stage).run(mkState(wt, specDir), ctx)) as unknown as { phaseStatus: Array<{ id: string; status: string }> };

		expect(logs.some((l) => l.includes("ratchet"))).toBe(false);
		expect(implCalls).toHaveLength(1);
		expect(out.phaseStatus[0]).toMatchObject({ status: "green" });
	}, 20_000);

	it("acceptance-time guarantee: a weakened try cannot reach GREEN even via the already-satisfied route (the 09-09 misroute shape)", async () => {
		const wt = mkRepo(); repos.push(wt);
		const specDir = mkSpecDir();
		redCheck.mockImplementation(() => "green"); // gutted guards now pass
		dam.mockImplementation(() => true); // deliverables already satisfied — the misroute bait
		const { ctx, logs, tddCalls, diskAtTdd } = mkCtx(wt, [
			{ testFiles: [GUARD_PATH], writeFiles: [{ path: GUARD_PATH, content: weakenedGuard(3) }] }, // try 1: the gut
			{ testFiles: [NEW_RED_PATH], writeFiles: [{ path: NEW_RED_PATH, content: NEW_RED_CONTENT }] }, // try 2: legal recovery
		]);

		const out = (await (implementationStage as Stage).run(mkState(wt, specDir), ctx)) as unknown as { phaseStatus: Array<{ id: string; status: string }> };

		// The weakened try was REJECTED before the already-satisfied node could
		// accept it (try 1 never logged the verification route)...
		expect(hasLog(logs, "RED assertion ratchet: REJECTED")).toBe(true);
		expect(diskAtTdd[1]!.guard).toBe(GUARD_HEAD); // the gut was reverted before try 2
		// ...and the run still converged GREEN once the RED was authored legally.
		expect(tddCalls).toHaveLength(2);
		expect(logs.filter((l) => l.includes("RED already-satisfied: build=true")).length).toBe(1); // try 2 only
		expect(out.phaseStatus[0]).toMatchObject({ status: "green" });
		expect(readFileSync(join(wt, GUARD_PATH), "utf8")).toBe(GUARD_HEAD);
	}, 20_000);

	it("RED retries are NOT counted against the phase attempt cap (cap=1 still converges after a ratchet retry)", async () => {
		process.env.SUPER_DEV_MAX_PHASE_ATTEMPTS = "1";
		const wt = mkRepo(); repos.push(wt);
		const specDir = mkSpecDir();
		const { ctx, logs, implCalls } = mkCtx(wt, [
			{ testFiles: [GUARD_PATH], writeFiles: [{ path: GUARD_PATH, content: weakenedGuard(4) }] },
			{ testFiles: [NEW_RED_PATH], writeFiles: [{ path: NEW_RED_PATH, content: NEW_RED_CONTENT }] },
		]);

		const out = (await (implementationStage as Stage).run(mkState(wt, specDir), ctx)) as unknown as { phaseStatus: Array<{ id: string; status: string }> };

		expect(logs.some((l) => l.includes("RED generation retry 1"))).toBe(true); // the ratchet retry happened
		expect(implCalls).toHaveLength(1); // ...but consumed NO implementer attempt
		expect(logs.some((l) => l.includes("phase-attempt-cap"))).toBe(false);
		expect(out.phaseStatus[0]).toMatchObject({ status: "green" });
	}, 20_000);
});

describe("F5 escalation — exhaustion / persistent weakening → declared handoff", () => {
	/** Six tries weakening to DISTINCT surfaces (12,10,8,6,4,2) — every signature
	 *  fresh, so only the MAX_RED_RETRIES ceiling (default 6) can fire. */
	const exhaustingTries = (): TddTry[] => [6, 5, 4, 3, 2, 1].map((k) => ({
		testFiles: [GUARD_PATH],
		writeFiles: [{ path: GUARD_PATH, content: weakenedGuard(k) }],
	}));

	it("RED-retry exhaustion routes the declared handoff: row shape, ONE pool round, run ends replan, named partial reason", async () => {
		redCheck.mockImplementation(() => "red"); // every try stays RED: the ratchet fires each try, signatures stay fresh
		const wt = mkRepo(); repos.push(wt);
		const specDir = mkSpecDir();
		const { ctx, logs, tddCalls, implCalls } = mkCtx(wt, exhaustingTries());

		const state = mkState(wt, specDir);
		const out = (await (implementationStage as Stage).run(state, ctx)) as unknown as { phaseStatus: Array<{ id: string; status: string }> };

		expect(tddCalls).toHaveLength(6); // the ceiling, not a signature repeat
		expect(implCalls).toHaveLength(0); // the implementer NEVER ran on a weakened oracle
		expect(hasLog(logs, "F5 red-weakening escalation: RED retries exhausted (6 tries)")).toBe(true);
		// The row: ownerStage spec + the DISTINCT red-weakening tag + sourcePhase.
		const file = readReplanRequests(specDir);
		expect(file.rounds).toBe(1); // ONE round of the shared SUPER_DEV_MAX_REPLAN_ROUNDS pool
		expect(file.requests).toHaveLength(1);
		expect(file.requests[0]).toMatchObject({ ownerStage: "spec", source: "red-weakening", sourcePhase: "phase-01", status: "pending" });
		// Run-level terminal state: replan (the declared route), phase partial named.
		expect((state as Record<string, unknown>).__replan).toBeDefined();
		expect(deriveRunStatus({ results: [], state, aborted: false }).status).toBe("replan");
		expect(logs.some((l) => /partial \(RED generation stopped after 6 tries in attempt 1 \(red-weakening — declared handoff routed; the run ends status replan\)\)/.test(l))).toBe(true);
		expect(out.phaseStatus[0]).toMatchObject({ id: "phase-01", status: "partial" });
		// Deterministic scoped cleanup ran at escalation: the guard is HEAD again.
		expect(readFileSync(join(wt, GUARD_PATH), "utf8")).toBe(GUARD_HEAD);
		// NO inherited-red machinery was touched (no sub-cap interaction).
		expect(countInheritedRedOccurrences(specDir)).toBe(0);
	}, 20_000);

	it("persistent weakening (the SAME weakened signature recurred) escalates on the second try", async () => {
		redCheck.mockImplementation(() => "red");
		const wt = mkRepo(); repos.push(wt);
		const specDir = mkSpecDir();
		const { ctx, logs, tddCalls } = mkCtx(wt, [
			{ testFiles: [GUARD_PATH], writeFiles: [{ path: GUARD_PATH, content: weakenedGuard(2) }] },
			{ testFiles: [GUARD_PATH], writeFiles: [{ path: GUARD_PATH, content: weakenedGuard(2) }] },
		]);

		const state = mkState(wt, specDir);
		await (implementationStage as Stage).run(state, ctx);

		expect(tddCalls).toHaveLength(2); // seenBefore, not the ceiling
		expect(hasLog(logs, "F5 red-weakening escalation")).toBe(true);
		const file = readReplanRequests(specDir);
		expect(file.requests[0]).toMatchObject({ source: "red-weakening", sourcePhase: "phase-01" });
	}, 20_000);

	it("no inherited-red sub-cap interaction: F5 routes with a pending inherited-red row already on the ledger (sub-cap spent), consuming the SECOND pool round", async () => {
		redCheck.mockImplementation(() => "red");
		const wt = mkRepo(); repos.push(wt);
		const specDir = mkSpecDir();
		// Seed the ledger: an inherited-red handoff row already exists (F2/F4's
		// single ≤1 sub-cap is SPENT) and ONE pool round is already consumed.
		mkdirSync(specDir, { recursive: true });
		writeFileSync(join(specDir, REPLAN_REQUESTS_FILE), JSON.stringify({
			version: 1,
			rounds: 1,
			requests: [{
				id: "prior-ir-handoff", title: "prior inherited-red declared handoff", detail: "seeded", severity: "high",
				ownerStage: "spec", source: "inherited-red", sourcePhase: "phase-01", fingerprint: "seed-f5-no-collision-000000",
				status: "pending", requestedRevision: "seeded", classificationSource: "deterministic", classificationReason: "seeded",
			}],
		}));
		const { ctx, logs } = mkCtx(wt, [
			{ testFiles: [GUARD_PATH], writeFiles: [{ path: GUARD_PATH, content: weakenedGuard(2) }] },
			{ testFiles: [GUARD_PATH], writeFiles: [{ path: GUARD_PATH, content: weakenedGuard(2) }] },
		]);

		const state = mkState(wt, specDir);
		await (implementationStage as Stage).run(state, ctx);

		// The sub-cap NEVER consulted F5: the red-weakening row routed anyway.
		expect(hasLog(logs, "F5 red-weakening escalation")).toBe(true);
		expect(logs.some((l) => /inherited-red (Tier|boundary|second occurrence)/.test(l))).toBe(false); // the F2/F4 ladder never engaged
		const file = readReplanRequests(specDir);
		expect(file.rounds).toBe(2); // the shared pool consumed its second (last default) round
		expect(file.requests).toHaveLength(2);
		expect(file.requests.find((r) => r.source === "red-weakening")).toMatchObject({ sourcePhase: "phase-01", ownerStage: "spec" });
	}, 20_000);
});
