/**
 * v0.3.85 F2/F4 — stage-level tier-ladder walkthroughs + the F4 door
 * (tests/implementation-inherited-red.test.ts).
 *
 * The F2 ladder replaces C1's blind forward-continue at the partial boundary
 * with attribution-keyed stop-the-line (§9 F2, §10 decision 3, §14 ADR 9);
 * F4 is the door in the C4 fence (§9 F4, §14 ADR 8/10). Harness per
 * tests/implementation-bounds.test.ts (mocked build-runner barrel + queued
 * gate/deliverable seeds) + REAL temp git repos (the dirt-provenance fixtures
 * — tests/implementation-env-blocker.test.ts pattern) so porcelain, phase-start
 * snapshots, and the Tier-0 git revert are all real. No LLM, no network.
 *
 * Covered:
 *   - Tier 0 own-leak revert + retry (budget consumed) and at exhausted budget;
 *   - Tier 1 flake-clear green-through that does NOT consume the occurrence
 *     tally (a later boundary still routes occurrence 1);
 *   - Tier 2 row shape + pool consumption + deriveRunStatus "replan";
 *   - Tier 3 FatalAbort naming failing subjects + owning prior phase, with the
 *     sub-cap NON-RESETTING across a simulated resume (two stage invocations,
 *     one spec dir);
 *   - the absent-baselineCheck exclusion (not inherited-red);
 *   - F4 arm-A match / arm-B match / no-prior-partial / spent sub-cap, and
 *     immediacy (fires on the restore, not at attempt exhaustion);
 *   - the validator hard-fail scoped to inherited-red restart states only.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { BuildGateResult } from "../src/build-runner.ts";
import { BASELINE_VERIFY_ERROR_PREFIX } from "../src/build-runner/gates.ts";
import type { AgentCall, AgentResult, HelperResult, PipelineState, RunOptions, StageContext } from "../src/types.ts";

vi.mock("../src/build-runner.ts", async (orig) => {
	const a = (await orig()) as Record<string, unknown>;
	return {
		...a,
		runRedCheck: vi.fn((_wt: string, testFiles: string[]) => {
			const key = testFiles.join(",");
			const n = (redCalls.get(key) ?? 0) + 1;
			redCalls.set(key, n);
			return n === 1 ? "red" : "green";
		}),
		runBuildGate: vi.fn(() => gateQ.shift() ?? PASS_GATE),
		runDeliverableCheck: vi.fn(() => deliverableQ.shift() ?? DELIV_PASS),
		computeChangeGate: vi.fn(() => ({ pass: true, claimedNotChanged: [], changedNotClaimed: [], advisory: [] })),
		resetDeliverableCheckCache: vi.fn(() => {}),
	};
});
vi.mock("../src/render/render.ts", () => ({ renderAndWrite: vi.fn() }));
vi.mock("../src/render/reflection.ts", () => ({ runReflectionAsync: vi.fn() }));
vi.mock("../src/render/user-notes.ts", () => ({ userNotesForAgent: vi.fn(() => "") }));

import { implementationStage } from "../src/stages/implementation.ts";
import { runBuildGate } from "../src/build-runner.ts";
import { deriveRunStatus } from "../src/workflow.ts";
import { REPLAN_REQUESTS_FILE } from "../src/replan/replan.ts";
import { countInheritedRedOccurrences, inheritedRedFlakeTally, readInheritedRedEvents } from "../src/stages/inherited-red.ts";

const buildGate = vi.mocked(runBuildGate);

// ─── queues + seeds ─────────────────────────────────────────────────────────

let gateQ: Array<Partial<BuildGateResult>> = [];
let deliverableQ: Array<Record<string, unknown>> = [];
const redCalls = new Map<string, number>();

const PASS_GATE: Partial<BuildGateResult> = { pass: true, buildSuccess: true, allTestsPass: true, typecheckSuccess: true, inScopePass: true, ran: ["mock"], errors: [], outOfScopeErrors: [] };
const DELIV_PASS = { pass: true, missing: [] as string[], ran: [] as string[] };

const BASELINE_SHA = "45b865ef";
const SYNTHETIC = `${BASELINE_VERIFY_ERROR_PREFIX} npm run test (whole suite) PASSES at baseline ${BASELINE_SHA} — the failure is new on this branch`;
/** The C1 poison subject: the census lockstep test, out-of-scope for the
 *  current phase, failing NEW on branch (regression). */
const CENSUS_BLOCK = "FAIL tests/census-mirror.test.ts\nError: census lockstep violated — mirrors must amend atomically";

/** The inherited-red boundary shape: gate red, out-of-scope-only + synthetic,
 *  baseline=regression, own-scope green (deliverables/change/symbol mocked
 *  pass; post-RED oracle green via the keyed runRedCheck mock). */
const IR_GATE: Partial<BuildGateResult> = {
	pass: false, buildSuccess: false, allTestsPass: false, typecheckSuccess: false, inScopePass: false,
	ran: ["mock"],
	errors: [CENSUS_BLOCK, SYNTHETIC],
	outOfScopeErrors: [CENSUS_BLOCK],
	baselineCheck: { status: "regression", evidence: `npm run test (whole suite) PASSES at baseline ${BASELINE_SHA}` },
};

/** A genuine in-scope product failure (phase-01's poison-source seed). */
const prodFail = (n: number): Partial<BuildGateResult> => ({
	pass: false, buildSuccess: false, allTestsPass: false, typecheckSuccess: false, inScopePass: false,
	ran: ["mock"],
	errors: [`product failure #${n}: in-scope build error kind ${n}`],
	outOfScopeErrors: [],
});

// ─── real-git fixtures ──────────────────────────────────────────────────────

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

const CENSUS_CONTENT = `import { mirrors } from "../src/mirrors";\nexpect(mirrors()).toBe(17); // census lockstep\n`;
const UNDECLARED_CONTENT = "export const UNDECLARED = 1;\n";

/** A real committed repo carrying the census lockstep test + an undeclared
 *  production file (the Tier-0 own-leak revert target). */
function mkRepo(): string {
	const wt = mkdtempSync(join(tmpdir(), "sd-ir-"));
	git(wt, "init", "-q", "-b", "main");
	git(wt, "config", "user.email", "t@t");
	git(wt, "config", "user.name", "t");
	const files: Record<string, string> = {
		"tests/census-mirror.test.ts": CENSUS_CONTENT,
		"src/undeclared.ts": UNDECLARED_CONTENT,
	};
	for (const [rel, content] of Object.entries(files)) {
		mkdirSync(dirname(join(wt, rel)), { recursive: true });
		writeFileSync(join(wt, rel), content);
	}
	git(wt, "add", "-A");
	git(wt, "commit", "-qm", "init");
	return wt;
}

const repos: string[] = [];
const dirs: string[] = [];
function mkSpecDir(): string {
	const d = mkdtempSync(join(tmpdir(), "sd-ir-spec-"));
	dirs.push(d);
	return d;
}

// ─── ctx harness ────────────────────────────────────────────────────────────

interface ImplStep {
	control?: Record<string, unknown>;
	/** Disk writes performed when this implementer call runs (real side effects). */
	writeFiles?: Array<{ path: string; content: string }>;
}

interface HarnessOpts {
	/** Which test file tdd-guide claims per phase (default tests/red-<phase>.test.ts). */
	tddFiles?: Record<string, string[]>;
}

function mkState(wt: string, specDir: string, phases: Array<Record<string, unknown>>): PipelineState {
	return {
		task: "ir",
		options: {},
		setup: { worktreePath: wt, specDirectory: specDir, defaultBranch: "main", language: "frontend", isWebUi: false, specIdentifier: "ir-test", worktreeCreated: false, initializedRepo: false },
		classify: { taskType: "feature", uiScope: "none", language: "frontend", isWebUi: false },
		spec: { phases },
	} as unknown as PipelineState;
}

function mkCtx(wt: string, implSteps: ImplStep[], opts: HarnessOpts = {}) {
	const logs: string[] = [];
	const implCalls: AgentCall[] = [];
	const tddFiles = opts.tddFiles ?? {};
	const ctx: StageContext = {
		task: "ir", options: {} as RunOptions, state: {} as PipelineState,
		async helper(): Promise<HelperResult> { return { value: { languageInstructions: "" }, digest: "" }; },
		async agent(call: AgentCall): Promise<AgentResult> {
			if (call.agent === "tdd-guide") {
				const phaseId = /implementation\.(phase-\d+)\./.exec(call.id)?.[1] ?? "phase-01";
				return { text: "", control: { testFiles: tddFiles[phaseId] ?? [`tests/red-${phaseId}.test.ts`] } };
			}
			if (call.agent === "implementer") {
				implCalls.push(call);
				const step = implSteps.shift() ?? {};
				for (const w of step.writeFiles ?? []) {
					mkdirSync(dirname(join(wt, w.path)), { recursive: true });
					writeFileSync(join(wt, w.path), w.content);
				}
				return { text: "ok", control: step.control ?? { filesModified: [`src/${Math.random().toString(36).slice(2, 8)}.ts`] } };
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
	return { ctx, logs, implCalls };
}

const hasLog = (logs: string[], needle: string) => logs.some((l) => l.includes(needle));

beforeEach(() => {
	gateQ = [];
	deliverableQ = [];
	redCalls.clear();
	buildGate.mockClear();
});
afterEach(() => {
	delete process.env.SUPER_DEV_MAX_PHASE_ATTEMPTS;
	delete process.env.SUPER_DEV_MAX_REPLAN_ROUNDS;
	for (const r of repos.splice(0)) rmSync(r, { recursive: true, force: true });
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const readReplanRequests = (specDir: string): { rounds: number; requests: Array<Record<string, unknown>> } =>
	JSON.parse(readFileSync(join(specDir, REPLAN_REQUESTS_FILE), "utf8"));

// ─── F2 Tier 0 ──────────────────────────────────────────────────────────────

describe("F2 Tier 0 — own-leak revert + retry (regression + clean-at-phase-start)", () => {
	it("reverts the phase's undeclared out-of-scope edit (deterministic git restore) and retries CONSUMING an attempt; the retry goes green", async () => {
		const wt = mkRepo(); repos.push(wt);
		const specDir = mkSpecDir();
		gateQ = [IR_GATE, PASS_GATE];
		const steps: ImplStep[] = [
			{ control: { filesModified: ["src/claimed.ts"] }, writeFiles: [{ path: "src/undeclared.ts", content: "export const UNDECLARED = 2;\n" }] }, // attempt 1: the own leak
			{ control: { filesModified: ["src/fixed.ts"] } }, // attempt 2: clean
		];
		const { ctx, logs, implCalls } = mkCtx(wt, steps);
		const state = mkState(wt, specDir, [{ name: "P1", deliverables: { requireFiles: ["src/prod.ts"] } }]);
		const out = (await implementationStage.run(state, ctx)) as unknown as { allGreen: boolean; phaseStatus: Array<{ id: string; status: string }> };

		expect(implCalls).toHaveLength(2); // Tier 0's retry consumed an attempt
		expect(hasLog(logs, "inherited-red Tier 0 (own-leak)")).toBe(true);
		expect(hasLog(logs, "REVERTED 1 tracked undeclared out-of-scope path(s) (src/undeclared.ts)")).toBe(true);
		expect(hasLog(logs, "retrying (the phase's own attempt budget is consumed")).toBe(true);
		expect(readFileSync(join(wt, "src/undeclared.ts"), "utf8")).toBe(UNDECLARED_CONTENT); // the REAL git revert
		expect(out.phaseStatus[0]).toMatchObject({ id: "phase-01", status: "green" });
		expect(out.allGreen).toBe(true);
		// Tier-0 boundaries are metrics-only: ZERO occurrence rows, no handoff.
		expect(countInheritedRedOccurrences(specDir)).toBe(0);
		expect((state as Record<string, unknown>).__replan).toBeUndefined();
	}, 20_000);

	it("executes the revert even at EXHAUSTED attempt budget — the phase then ends phase-attempt-cap partial and boundary logic proceeds (no tally)", async () => {
		process.env.SUPER_DEV_MAX_PHASE_ATTEMPTS = "1";
		const wt = mkRepo(); repos.push(wt);
		const specDir = mkSpecDir();
		gateQ = [IR_GATE];
		const steps: ImplStep[] = [
			{ control: { filesModified: ["src/claimed.ts"] }, writeFiles: [{ path: "src/undeclared.ts", content: "export const UNDECLARED = 3;\n" }] },
		];
		const { ctx, logs, implCalls } = mkCtx(wt, steps);
		const state = mkState(wt, specDir, [{ name: "P1", deliverables: { requireFiles: ["src/prod.ts"] } }, { name: "P2" }]);
		const out = (await implementationStage.run(state, ctx)) as unknown as { phaseStatus: Array<{ id: string; status: string }> };

		// FIX ROUND 2 (3): TWO implementer calls are the contract here — the
		// capped attempt 1 (the Tier-0 boundary; NO retry: the phase's own budget
		// is spent) PLUS phase-02's own attempt (the phase list carries a second
		// phase and boundary logic PROCEEDS to it — that forward-continue is
		// exactly what this test pins).
		expect(implCalls).toHaveLength(2); // P1's single capped attempt + P2's implementer call (forward-continue)
		expect(hasLog(logs, "the revert still ran; the phase ends partial and boundary logic proceeds")).toBe(true);
		expect(readFileSync(join(wt, "src/undeclared.ts"), "utf8")).toBe(UNDECLARED_CONTENT);
		expect(logs.some((l) => /partial after 1 attempt\(s\) \(phase-attempt-cap\)/.test(l))).toBe(true);
		expect(out.phaseStatus[0]).toMatchObject({ id: "phase-01", status: "partial" });
		expect(countInheritedRedOccurrences(specDir)).toBe(0);
	}, 20_000);
});

// ─── F2 Tier 1 + Tier 2 (the C1 walkthrough) ────────────────────────────────

describe("F2 Tier 1/2 — the C1 walkthrough (phase-01 poison, phase-02 inherits)", () => {
	beforeEach(() => { process.env.SUPER_DEV_MAX_PHASE_ATTEMPTS = "2"; });
	/** Phase-01 goes partial on product failures while its implementer modifies
	 *  the census test (the C1 poison); phase-02's declared scope is elsewhere. */
	const c1Phases = (): Array<Record<string, unknown>> => [
		{ name: "P1", deliverables: { requireFiles: ["src/p1.ts"] } },
		{ name: "P2", deliverables: { requireFiles: ["src/p2.ts"] } },
	];
	const poisonStep = (): ImplStep => ({ control: { filesModified: ["src/p1-impl.ts"] }, writeFiles: [{ path: "tests/census-mirror.test.ts", content: CENSUS_CONTENT.replace("17", "18") }] });

	it("Tier 1 flake-clear does NOT consume the tally: phase-02 goes GREEN via the re-run, and a LATER boundary still routes occurrence 1", async () => {
		const wt = mkRepo(); repos.push(wt);
		const specDir = mkSpecDir();
		gateQ = [prodFail(1), prodFail(2), IR_GATE, PASS_GATE, IR_GATE]; // P1×2, P2 gate + flake re-run GREEN, P3 gate (grant spent → no re-run)
		const steps: ImplStep[] = [poisonStep(), { control: { filesModified: ["src/p2-a.ts"] } }, { control: { filesModified: ["src/p2-b.ts"] } }, { control: { filesModified: ["src/p3.ts"] } }];
		const { ctx, logs } = mkCtx(wt, steps);
		const state = mkState(wt, specDir, [...c1Phases(), { name: "P3", deliverables: { requireFiles: ["src/p3.ts"] } }]);
		const out = (await implementationStage.run(state, ctx)) as unknown as { phaseStatus: Array<{ id: string; status: string }> };

		// Phase-02: flake-cleared GREEN through the re-run. The adjudicated
		// semantics, pinned on the LEDGER CONTENT: a Tier-1-flake-cleared boundary
		// writes ONLY its metrics-only flake-rerun row — NEVER an occurrence row
		// (occurrence rows exist exclusively for evaluations reaching the Tier-2
		// decision, which phase-03's later boundary legitimately is).
		expect(hasLog(logs, "inherited-red Tier 1 (flake filter): deterministic full-gate re-run → GREEN")).toBe(true);
		expect(logs.some((l) => /GREEN via inherited-red Tier 1 flake filter on attempt 1/.test(l))).toBe(true);
		expect(out.phaseStatus.find((p) => p.id === "phase-02")?.status).toBe("green");
		expect(inheritedRedFlakeTally(specDir)).toBe(1);
		const ledgerRows = readInheritedRedEvents(specDir);
		expect(ledgerRows.filter((r) => r.event === "flake-rerun")).toHaveLength(1);
		expect(ledgerRows.filter((r) => r.event === "flake-rerun")[0]).toMatchObject({ phaseId: "phase-02", outcome: "flake-cleared" });
		// Phase-03: grant spent → classification stands → Tier 2 occurrence 1 → handoff.
		expect(hasLog(logs, "per-run grant already spent")).toBe(true);
		expect(hasLog(logs, "inherited-red Tier 2 (declared handoff): occurrence 1")).toBe(true);
		expect(countInheritedRedOccurrences(specDir)).toBe(1);
		expect(ledgerRows.filter((r) => r.event === "occurrence")).toHaveLength(1); // ONLY the Tier-2-reaching evaluation
		expect(ledgerRows.filter((r) => r.event === "occurrence")[0]).toMatchObject({ phaseId: "phase-03", outcome: "tier2-handoff-routed" });
	}, 20_000);

	it("Tier 2 declared handoff: row shape (ownerStage spec + source/sourcePhase), ONE pool round, run ends status replan, remaining phases deferred", async () => {
		const wt = mkRepo(); repos.push(wt);
		const specDir = mkSpecDir();
		gateQ = [prodFail(1), prodFail(2), IR_GATE, IR_GATE]; // P1×2, P2 gate + flake re-run still RED
		const steps: ImplStep[] = [poisonStep(), { control: { filesModified: ["src/p2-a.ts"] } }, { control: { filesModified: ["src/p2-b.ts"] } }];
		const { ctx, logs } = mkCtx(wt, steps);
		const state = mkState(wt, specDir, [...c1Phases(), { name: "P3" }]);
		const out = (await implementationStage.run(state, ctx)) as unknown as { phaseStatus: Array<{ id: string; status: string }> };

		expect(hasLog(logs, "inherited-red Tier 1 (flake filter): deterministic full-gate re-run → RED")).toBe(true);
		expect(hasLog(logs, "inherited-red Tier 2 (declared handoff): occurrence 1")).toBe(true);
		expect(logs.some((l) => /partial after 1 attempt\(s\) \(inherited-red — declared handoff routed; the run ends status replan\)/.test(l))).toBe(true);
		// The row: ownerStage spec, source inherited-red, sourcePhase the F2 boundary phase.
		const file = readReplanRequests(specDir);
		expect(file.rounds).toBe(1); // ONE round of the shared SUPER_DEV_MAX_REPLAN_ROUNDS pool
		expect(file.requests).toHaveLength(1);
		expect(file.requests[0]).toMatchObject({ ownerStage: "spec", source: "inherited-red", sourcePhase: "phase-02", status: "pending" });
		// The run-level terminal state: replan (R3 first-class), remaining phase deferred.
		expect((state as Record<string, unknown>).__replan).toBeDefined();
		expect(deriveRunStatus({ results: [], state, aborted: false }).status).toBe("replan");
		expect(hasLog(logs, "REPLAN pending — deferring remaining phase(s) (1 of 3)")).toBe(true);
		expect(out.phaseStatus.find((p) => p.id === "phase-02")?.status).toBe("partial");
		expect(countInheritedRedOccurrences(specDir)).toBe(1);
	}, 20_000);

	it("the absent-baselineCheck exclusion: NO attribution evidence → today's behavior, no ladder, no ledger rows", async () => {
		const wt = mkRepo(); repos.push(wt);
		const specDir = mkSpecDir();
		const noBaseline: Partial<BuildGateResult> = { ...IR_GATE, baselineCheck: undefined };
		gateQ = [noBaseline, noBaseline];
		const { ctx, logs } = mkCtx(wt, [{ control: { filesModified: ["src/x.ts"] } }, { control: { filesModified: ["src/y.ts"] } }]);
		const state = mkState(wt, specDir, [{ name: "P1", deliverables: { requireFiles: ["src/prod.ts"] } }]);
		const out = (await implementationStage.run(state, ctx)) as unknown as { phaseStatus: Array<{ id: string; status: string }> };

		expect(logs.some((l) => l.includes("inherited-red"))).toBe(false);
		expect(out.phaseStatus[0]).toMatchObject({ id: "phase-01", status: "partial" });
		expect(countInheritedRedOccurrences(specDir)).toBe(0);
		expect((state as Record<string, unknown>).__replan).toBeUndefined();
	}, 20_000);
});

// ─── F2 Tier 3 — sub-cap non-reset across a simulated resume ────────────────

describe("F2 Tier 3 — second occurrence FatalAbort; sub-cap NON-RESETTING across resume", () => {
	beforeEach(() => { process.env.SUPER_DEV_MAX_PHASE_ATTEMPTS = "2"; });

	it("run 1 routes the handoff (sub-cap spent); run 2 (same spec dir, fresh state) hits the boundary again → FatalAbort naming subjects + owning prior phase; no second row", async () => {
		const wt = mkRepo(); repos.push(wt);
		const specDir = mkSpecDir();
		const phases = (): Array<Record<string, unknown>> => [
			{ name: "P1", deliverables: { requireFiles: ["tests/census-mirror.test.ts"] } }, // Arm A scope owner → the OWNING PRIOR PHASE is nameable
			{ name: "P2", deliverables: { requireFiles: ["src/p2.ts"] } },
		];

		// Run 1: the handoff routes.
		gateQ = [prodFail(1), prodFail(2), IR_GATE, IR_GATE];
		const r1 = mkCtx(wt, [ { control: { filesModified: ["src/p1-impl.ts"] }, writeFiles: [{ path: "tests/census-mirror.test.ts", content: CENSUS_CONTENT.replace("17", "19") }] }, { control: { filesModified: ["src/p2-a.ts"] } }, { control: { filesModified: ["src/p2-b.ts"] } }]);
		const state1 = mkState(wt, specDir, phases());
		const out1 = (await implementationStage.run(state1, r1.ctx)) as unknown as { phaseStatus: Array<{ id: string; status: string }> };
		expect(out1.phaseStatus.find((p) => p.id === "phase-02")?.status).toBe("partial");
		expect(readReplanRequests(specDir).requests).toHaveLength(1);

		// FIX ROUND 2 (4): RESET the poisoned tree between the two runs. Run 1's
		// census modification persists (worktreeCreated:false → no preserve-stash),
		// and a resumed run 2 that STARTS with that dirt would route phase-02's
		// boundary into the v0.2.6 G1 ENV-BLOCKER branch (run-start FOREIGN dirt →
		// foreignDirtCount>0 → quarantine/re-gate), which owns that boundary BY
		// DESIGN and correctly excludes the F2 ladder — so no Tier 3 could ever
		// fire there. A real resume starts from a checked-out tree: reset the
		// tracked census file, let run 2's P1 re-poison MID-PHASE (so at P2 it is
		// pre-PHASE dirt, NOT run-start dirt), and the F2 ladder then owns the
		// boundary: the sub-cap is already spent by run 1's persisted row →
		// Tier 3 FatalAbort.
		execFileSync("git", ["-C", wt, "restore", "--", "tests/census-mirror.test.ts"], { encoding: "utf8" });

		// Run 2 (the simulated resume): fresh state, SAME spec dir — the ledger row persists.
		redCalls.clear();
		gateQ = [prodFail(3), prodFail(4), IR_GATE, IR_GATE];
		const r2 = mkCtx(wt, [ { control: { filesModified: ["src/p1-impl2.ts"] }, writeFiles: [{ path: "tests/census-mirror.test.ts", content: CENSUS_CONTENT.replace("17", "20") }] }, { control: { filesModified: ["src/p2-c.ts"] } }, { control: { filesModified: ["src/p2-d.ts"] } }]);
		const state2 = mkState(wt, specDir, phases());
		let caught: Error | undefined;
		try { await implementationStage.run(state2, r2.ctx); } catch (e) { caught = e as Error; }
		expect(caught).toBeDefined();
		expect(caught!.name).toBe("FatalAbort");
		expect(caught!.message).toMatch(/inherited-red second occurrence at phase-02/);
		expect(r2.logs.some((l) => l.includes("inherited-red Tier 3: SECOND OCCURRENCE"))).toBe(true);
		// The FatalAbort names the failing subjects + the owning prior phase.
		expect(caught!.message).toContain("tests/census-mirror.test.ts");
		expect(caught!.message).toContain("phase-01");
		// No second handoff row was written (Tier 3 throws before routing).
		expect(readReplanRequests(specDir).requests).toHaveLength(1);
		expect(countInheritedRedOccurrences(specDir)).toBe(2); // occurrence 1 (routed) + occurrence 2 (fatal)
	}, 20_000);
});

// ─── F4 — the door in the fence ─────────────────────────────────────────────

describe("F4 — door in the fence (the GREEN-boundary restore scope match)", () => {
	beforeEach(() => { process.env.SUPER_DEV_MAX_PHASE_ATTEMPTS = "2"; });
	/** phase-01 partial (product failures ×2, attempt cap 2); phase-02's tdd
	 *  claims the CENSUS test and its implementer EDITS it during GREEN. */
	const f4Setup = () => {
		const wt = mkRepo(); repos.push(wt);
		const specDir = mkSpecDir();
		gateQ = [prodFail(1), prodFail(2), PASS_GATE];
		const steps: ImplStep[] = [
			{ control: { filesModified: ["src/p1.ts"] } },
			{ control: { filesModified: ["src/p1-2.ts"] } },
			{ control: { filesModified: ["src/p2-impl.ts"] }, writeFiles: [{ path: "tests/census-mirror.test.ts", content: CENSUS_CONTENT.replace("17", "42") }] },
		];
		return { wt, specDir, steps };
	};

	it("ARM A match → IMMEDIATE declared handoff on the restore (no attempt exhaustion): row carries handoffArm arm-a + sourcePhase phase-01; phase-02 partial declared-handoff (f4); run ends replan", async () => {
		const { wt, specDir, steps } = f4Setup();
		const phases = [
			{ name: "P1", deliverables: { requireFiles: ["tests/census-mirror.test.ts"] } }, // prior partial scope owner (arm A)
			{ name: "P2", deliverables: { requireFiles: ["src/p2.ts"] } },
			{ name: "P3" },
		];
		const { ctx, logs, implCalls } = mkCtx(wt, steps, { tddFiles: { "phase-02": ["tests/census-mirror.test.ts"] } });
		const state = mkState(wt, specDir, phases);
		const out = (await implementationStage.run(state, ctx)) as unknown as { phaseStatus: Array<{ id: string; status: string }> };

		// IMMEDIACY: phase-02 got exactly ONE implementer attempt — the handoff
		// fired on the restore, not at attempt exhaustion.
		expect(implCalls.filter((c) => c.id.includes("phase-02"))).toHaveLength(1);
		expect(hasLog(logs, "RESTORED 1/1 (tests/census-mirror.test.ts)")).toBe(true);
		expect(hasLog(logs, "F4 door-in-the-fence: IMMEDIATE declared handoff")).toBe(true);
		expect(hasLog(logs, "match prior partial phase phase-01's scope (arm A: declared clause files)")).toBe(true);
		expect(logs.some((l) => /partial after 1 attempt\(s\) \(declared-handoff \(f4\) — the run ends status replan\)/.test(l))).toBe(true);
		expect(out.phaseStatus.find((p) => p.id === "phase-02")?.status).toBe("partial");
		const file = readReplanRequests(specDir);
		expect(file.requests[0]).toMatchObject({ ownerStage: "spec", source: "inherited-red", sourcePhase: "phase-01", handoffArm: "arm-a", status: "pending" });
		expect((state as Record<string, unknown>).__replan).toBeDefined();
		expect(deriveRunStatus({ results: [], state, aborted: false }).status).toBe("replan");
		expect(hasLog(logs, "REPLAN pending — deferring remaining phase(s) (1 of 3)")).toBe(true);
	}, 20_000);

	it("ARM B match (recorded failing-test path containment): prior partial phase WITHOUT clause-file ownership still fires via its lastFailures record", async () => {
		const { wt, specDir, steps } = f4Setup();
		// phase-01 records census as a FAILING test file in its lastFailures (gate
		// error text rides attemptErrors → lastFailuresUpsert); texts differ per
		// attempt so the exact-signature no-progress valve stays out of the way.
		gateQ[0] = { ...prodFail(1), errors: ["tdd-targets-still-red: tests/census-mirror.test.ts (a)"] };
		gateQ[1] = { ...prodFail(2), errors: ["tdd-targets-still-red: tests/census-mirror.test.ts (b)"] };
		const phases = [
			{ name: "P1", deliverables: { requireFiles: ["src/p1-unrelated.ts"] } }, // NO clause-file ownership → arm B
			{ name: "P2", deliverables: { requireFiles: ["src/p2.ts"] } },
		];
		const { ctx, logs, implCalls } = mkCtx(wt, steps, { tddFiles: { "phase-02": ["tests/census-mirror.test.ts"] } });
		const state = mkState(wt, specDir, phases);
		const out = (await implementationStage.run(state, ctx)) as unknown as { phaseStatus: Array<{ id: string; status: string }> };

		expect(implCalls.filter((c) => c.id.includes("phase-02"))).toHaveLength(1);
		expect(hasLog(logs, "F4 door-in-the-fence: IMMEDIATE declared handoff")).toBe(true);
		expect(hasLog(logs, "arm B: recorded failing-test paths")).toBe(true);
		const file = readReplanRequests(specDir);
		expect(file.requests[0]).toMatchObject({ source: "inherited-red", sourcePhase: "phase-01", handoffArm: "arm-b" });
		expect(out.phaseStatus.find((p) => p.id === "phase-02")?.status).toBe("partial");
	}, 20_000);

	it("NO prior partial phase → F4 never fires: today's behavior (restore + forceful retry feedback; the attempt fails and the phase recovers next attempt)", async () => {
		const wt = mkRepo(); repos.push(wt);
		const specDir = mkSpecDir();
		gateQ = [PASS_GATE, PASS_GATE];
		const steps: ImplStep[] = [
			{ control: { filesModified: ["src/p1-a.ts"] }, writeFiles: [{ path: "tests/census-mirror.test.ts", content: CENSUS_CONTENT.replace("17", "99") }] }, // attempt 1: edits the RED test
			{ control: { filesModified: ["src/p1-b.ts"] } }, // attempt 2: clean
		];
		const { ctx, logs, implCalls } = mkCtx(wt, steps, { tddFiles: { "phase-01": ["tests/census-mirror.test.ts"] } });
		const state = mkState(wt, specDir, [{ name: "P1", deliverables: { requireFiles: ["src/p1.ts"] } }]);
		const out = (await implementationStage.run(state, ctx)) as unknown as { allGreen: boolean; phaseStatus: Array<{ id: string; status: string }> };

		expect(hasLog(logs, "RESTORED 1/1 (tests/census-mirror.test.ts)")).toBe(true);
		// Today's forceful retry feedback rides the NEXT implementer's PROMPT
		// (implementationRetrySection), not the log channel.
		expect(implCalls[1]!.prompt).toContain("STOP editing the test files — they are READ-ONLY during GREEN");
		expect(hasLog(logs, "F4 door-in-the-fence")).toBe(false);
		expect(implCalls).toHaveLength(2); // attempt 2 ran (no handoff shortcut)
		expect(out.phaseStatus[0]).toMatchObject({ id: "phase-01", status: "green" });
		expect((state as Record<string, unknown>).__replan).toBeUndefined();
	}, 20_000);

	it("sub-cap already spent → Tier 3 FatalAbort (no second handoff row)", async () => {
		const { wt, specDir, steps } = f4Setup();
		// Pre-spend the sub-cap: one prior inherited-red row (any status) in the ledger.
		writeFileSync(join(specDir, REPLAN_REQUESTS_FILE), JSON.stringify({
			version: 1, rounds: 1,
			requests: [{ id: "ir-1", title: "prior handoff", detail: "d", severity: "high", ownerStage: "spec", classificationSource: "reviewer-ownerStage", classificationReason: "r", requestedRevision: "rr", fingerprint: "f", status: "addressed", source: "inherited-red", sourcePhase: "phase-01", createdAt: "now" }],
		}));
		const phases = [
			{ name: "P1", deliverables: { requireFiles: ["tests/census-mirror.test.ts"] } },
			{ name: "P2", deliverables: { requireFiles: ["src/p2.ts"] } },
		];
		const { ctx, logs } = mkCtx(wt, steps, { tddFiles: { "phase-02": ["tests/census-mirror.test.ts"] } });
		const state = mkState(wt, specDir, phases);
		await expect(implementationStage.run(state, ctx)).rejects.toThrow(/inherited-red sub-cap spent at phase-02 F4/);
		expect(hasLog(logs, "inherited-red sub-cap already spent (1 row(s))")).toBe(true);
		expect(readReplanRequests(specDir).requests).toHaveLength(1); // unchanged — append-only ledger, no second row
	}, 20_000);
});

// ─── the validator override (§10 decision 3, grill pass 3) ──────────────────

describe("F2 validator override — hard-fail ONLY for inherited-red restart states", () => {
	// FIX ROUND 1 (E): pin the replan pool size so "pool exhausted" is
	// DETERMINISTIC regardless of any ambient SUPER_DEV_MAX_REPLAN_ROUNDS —
	// with rounds=cap the trigger returns false and the override must fire.
	beforeEach(() => { process.env.SUPER_DEV_MAX_REPLAN_ROUNDS = "1"; });
	/** requireContains + requireNotContents on the same file+pattern → a
	 *  deterministic plan-feasibility contradiction (plan-feasibility Check 1). */
	const contradictoryPhases = (): Array<Record<string, unknown>> => [{
		name: "P1",
		deliverables: {
			requireContains: [{ file: "src/x.ts", pattern: "FOO" }],
			requireNotContains: [{ file: "src/x.ts", pattern: "FOO" }],
		},
	}];

	const seedPendingIrRow = (specDir: string, rounds: number) => {
		writeFileSync(join(specDir, REPLAN_REQUESTS_FILE), JSON.stringify({
			version: 1, rounds,
			requests: [{ id: "ir-1", title: "prior handoff", detail: "d", severity: "high", ownerStage: "spec", classificationSource: "reviewer-ownerStage", classificationReason: "r", requestedRevision: "rr", fingerprint: "f", status: "pending", source: "inherited-red", sourcePhase: "phase-02", createdAt: "now" }],
		}));
	};

	it("pending inherited-red rows + replan unavailable (pool exhausted) → FatalAbort naming the validator findings (no retry loop)", async () => {
		const wt = mkRepo(); repos.push(wt);
		const specDir = mkSpecDir();
		seedPendingIrRow(specDir, 1); // rounds 1/1 — the shared pool is spent
		gateQ = [PASS_GATE];
		const { ctx, logs } = mkCtx(wt, [{ control: { filesModified: ["src/x.ts"] } }]);
		const state = mkState(wt, specDir, contradictoryPhases());
		let caught: Error | undefined;
		try { await implementationStage.run(state, ctx); } catch (e) { caught = e as Error; }
		expect(caught).toBeDefined();
		expect(caught!.name).toBe("FatalAbort");
		expect(caught!.message).toMatch(/inherited-red restart failed plan validation/);
		expect(caught!.message).toContain("requireContains"); // names the validator findings
		expect(hasLog(logs, "routing Tier 3 FatalAbort naming the validator findings (no retry loop; v0.3.85 F2 validator override)")).toBe(true);
	}, 20_000);

	it("WITHOUT pending inherited-red rows: today's log-and-proceed stands (pool exhausted, no throw, phases run)", async () => {
		const wt = mkRepo(); repos.push(wt);
		const specDir = mkSpecDir();
		writeFileSync(join(specDir, REPLAN_REQUESTS_FILE), JSON.stringify({ version: 1, rounds: 1, requests: [] }));
		gateQ = [PASS_GATE];
		const { ctx, logs } = mkCtx(wt, [{ control: { filesModified: ["src/x.ts"] } }]);
		const state = mkState(wt, specDir, contradictoryPhases());
		const out = (await implementationStage.run(state, ctx)) as unknown as { phaseStatus: Array<{ id: string; status: string }> };
		expect(hasLog(logs, "proceeding with the contradictions logged")).toBe(true);
		expect(out.phaseStatus[0]).toMatchObject({ id: "phase-01", status: "green" });
	}, 20_000);

	it("pending inherited-red rows with the pool AVAILABLE → the contradictions route a normal replan (the override must not fire when replan can)", async () => {
		const wt = mkRepo(); repos.push(wt);
		const specDir = mkSpecDir();
		seedPendingIrRow(specDir, 0); // pool has rounds left
		gateQ = [];
		const { ctx, logs } = mkCtx(wt, []);
		const state = mkState(wt, specDir, contradictoryPhases());
		const out = (await implementationStage.run(state, ctx)) as unknown as { phasesCompleted: number };
		expect(hasLog(logs, "routed to REPLAN before executing any phase")).toBe(true);
		expect(hasLog(logs, "proceeding with the contradictions logged")).toBe(false);
		expect(out.phasesCompleted).toBe(0);
		expect((state as Record<string, unknown>).__replan).toBeDefined();
	}, 20_000);
});
