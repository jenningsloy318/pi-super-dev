/**
 * The RED oracle cycle — contract test for the v0.4.47 extraction
 * (increment 19 of the stage.ts split, the record-builder half of the RED
 * loop body).
 *
 * THE CONTRACTS: the wide record carries every per-try binding (the
 * classification results, the nullable retry hint, the in-flight review
 * promise, and the three cross-try runner lets); the v0.3.40 runner-cache
 * scope guard nulls + un-caches a stale-scoped runner; the R1 fail-closed
 * guard keeps unknown honest; the Tier 1 hollow-assertion guard flips
 * red-behavior-failure to green-weak-test with the teaching hint; the Tier 2
 * review launches UNAWAITED (with the rejection marked handled); and the
 * v0.3.16 F4 timeout hint prefixes the honest death cause + the disk state.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import type { PipelineState, StageContext } from "../src/types.ts";

vi.mock("../src/build-runner.ts", async (importOriginal) => {
	const orig = await importOriginal<typeof import("../src/build-runner.ts")>();
	return {
		...orig,
		runRedCheck: vi.fn((): string => "red"),
		deliverablesAlreadyMet: vi.fn((): boolean => false),
	};
});

vi.mock("../src/stages/implementation/red-evidence.ts", async (importOriginal) => {
	const orig = await importOriginal<typeof import("../src/stages/implementation/red-evidence.ts")>();
	return {
		...orig,
		resolveRedBoundary: vi.fn(async () => ({ allAllowed: true, forbiddenFiles: [] as string[], ambiguousFiles: [] as string[], classifications: [] as unknown[], allowedScaffold: [] as string[] }) as never),
		resolveTddScenarioCoverage: vi.fn(async () => ({ allCovered: true, expectedScenarios: [], coveredScenarios: [], missingScenarios: [], summary: "ok" }) as never),
	};
});

import { runRedOracleCycle, type RedOracleCycleInput } from "../src/stages/implementation/red-oracle-cycle.ts";
import { runRedCheck, deliverablesAlreadyMet } from "../src/build-runner.ts";

const redCheckMock = vi.mocked(runRedCheck);
const alreadyMetMock = vi.mocked(deliverablesAlreadyMet);

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

const ctxOf = (logs: string[], agent?: unknown): StageContext => ({
	task: "t", options: {}, state: {} as PipelineState,
	budget: { count: 0, check: () => true, spent: () => true },
	log: (line: string) => logs.push(line), phase: () => {}, events: new EventEmitter(), results: [],
	agent: agent ?? (async () => ({ control: {} })),
} as unknown as StageContext);

const baseInput = (over: Partial<RedOracleCycleInput> = {}): RedOracleCycleInput => ({
	ctx: ctxOf([]),
	state: { classify: null, spec: null, bdd: null } as unknown as PipelineState,
	setup: { worktreePath: "", specDirectory: "", defaultBranch: undefined, language: "typescript" } as never,
	worktreePath: "",
	specDirectory: "",
	language: "typescript",
	phaseId: "phase-01",
	phaseName: "wire",
	phase: { name: "wire", deliverables: {} } as never,
	attempt: 1,
	retries: 0,
	redTryDetail: "attempt 1, try 1",
	tddError: undefined,
	tddNotCompleted: false,
	testFiles: ["tests/prod.test.ts"],
	lastClaimedTestFiles: [],
	redDiagnostics: [],
	redBaseline: new Set<string>(),
	runnerSpec: null,
	runnerDiscoveryTried: false,
	covConventionsSpec: null,
	expectedScenarios: [],
	phaseDeliverables: undefined,
	baselineDeliverablesSatisfied: false,
	redScaffoldApproved: new Set<string>(),
	phaseReviewViolations: 0,
	announceActivity: () => {},
	runStep: async <T,>(_l: string, _d: string | undefined, _ok: (r: T) => boolean, fn: () => Promise<T>) => fn(),
	...over,
});

beforeEach(() => { vi.clearAllMocks(); redCheckMock.mockReturnValue("red" as never); alreadyMetMock.mockReturnValue(false as never); });
afterEach(() => { for (const r of repos.splice(0)) rmSync(r, { recursive: true, force: true }); });

describe("red oracle cycle (v0.4.47 increment-19 extraction)", () => {
	it("a red-behavior-failure classification → the record carries it + the stock retry hint", async () => {
		const repo = makeRepo("sd-oc-red-");
		const out = await runRedOracleCycle(baseInput({ worktreePath: repo, setup: { worktreePath: repo, specDirectory: "", defaultBranch: undefined, language: "typescript" } as never }));
		expect(out.redStatus).toBe("red");
		expect(out.redEvidence.status).toBe("red-behavior-failure");
		expect(out.retryHint).toBeNull(); // redGenerationRetryHint returns null on red-behavior-failure (513f1524 N2 — was vacuous)
		expect(out.redFailClosedUnknown).toBe(false);
		expect(out.redReviewInFlight).not.toBeNull(); // Tier 2 launched
		expect(out.runnerSpec).toBeNull();
	});

	it("the R1 fail-closed guard: unknown + requiresTests (scenarios) → honest unknown with the RED-not-confirmed reason", async () => {
		const repo = makeRepo("sd-oc-fc-");
		redCheckMock.mockReturnValue("unknown" as never);
		const out = await runRedOracleCycle(baseInput({
			worktreePath: repo,
			setup: { worktreePath: repo, specDirectory: "", defaultBranch: undefined, language: "typescript" } as never,
			expectedScenarios: ["SCENARIO-001"],
		}));
		expect(out.redFailClosedUnknown).toBe(true);
		expect(out.redEvidence.reason).toContain("RED not confirmed:");
		expect(["unknown-unclassified", "unknown-no-runner"]).toContain(out.redEvidence.status); // stays honest (v0.3.30 F2)
	});

	it("unknown WITHOUT requiresTests and WITHOUT an agent error → NOT fail-closed (the P3 fall-through)", async () => {
		const repo = makeRepo("sd-oc-p3-");
		redCheckMock.mockReturnValue("unknown" as never);
		const out = await runRedOracleCycle(baseInput({ worktreePath: repo, setup: { worktreePath: repo, specDirectory: "", defaultBranch: undefined, language: "typescript" } as never }));
		expect(out.redFailClosedUnknown).toBe(false);
	});

	it("F9-A: a no-edit-completion error + LIVE deliverable re-check satisfied → green-already-satisfied (the machine decides)", async () => {
		const repo = makeRepo("sd-oc-f9a-");
		redCheckMock.mockReturnValue("unknown" as never);
		alreadyMetMock.mockReturnValue(true as never);
		const out = await runRedOracleCycle(baseInput({
			worktreePath: repo,
			setup: { worktreePath: repo, specDirectory: "", defaultBranch: undefined, language: "typescript" } as never,
			tddError: "child completed without making edits (MISSING_IMPLEMENTATION_MUTATION_MESSAGE)", // satisfies the real isNoEditCompletion regex
			tddNotCompleted: true,
			expectedScenarios: ["SCENARIO-001"],
			phaseDeliverables: { requireFiles: ["src/prod.ts"] } as never,
		}));
		expect(out.redEvidence.status).toBe("green-already-satisfied");
	});

	it("the Tier 1 hollow guard: a red test with NO assertion → green-weak-test + the teaching hint", async () => {
		const repo = makeRepo("sd-oc-hollow-");
		writeFileSync(join(repo, "tests/prod.test.ts"), "test('a', () => { /* no assertion */ });\n");
		const out = await runRedOracleCycle(baseInput({ worktreePath: repo, setup: { worktreePath: repo, specDirectory: "", defaultBranch: undefined, language: "typescript" } as never }));
		expect(out.redEvidence.status).toBe("green-weak-test");
		expect(out.redEvidence.reason).toContain("hollow RED test(s)");
		expect(out.retryHint).toContain("contain no recognizable assertion");
		expect(out.redReviewInFlight).toBeNull(); // the hint preempted Tier 2
	});

	it("the v0.3.40 scope guard: a runner that cannot execute this phase's tests is nulled + un-cached (513f1524 N1 — real spec dir + removal asserted)", async () => {
		const repo = makeRepo("sd-oc-scope-");
		const specDir = mkdtempSync(join(tmpdir(), "sd-oc-spec-"));
		repos.push(specDir);
		writeFileSync(join(specDir, "test-runner.json"), JSON.stringify({ version: 1, command: "node --test tests/other.test.mjs" }));
		const out = await runRedOracleCycle(baseInput({
			worktreePath: repo,
			setup: { worktreePath: repo, specDirectory: specDir, defaultBranch: undefined, language: "typescript" } as never,
			specDirectory: specDir,
			runnerSpec: { version: 1, command: "node --test tests/other.test.mjs", targets: ["tests/other.test.mjs"], resultFormat: "tap" as const, discoveredAt: "t" } as never,
		}));
		expect(out.runnerSpec).toBeNull();
		expect(out.runnerDiscoveryTried).toBe(false); // re-armed for rediscovery
		expect(existsSync(join(specDir, "test-runner.json"))).toBe(false); // the cache file was removed
	});

	it("the v0.3.16 F4 timeout hint: an agent-death try prefixes the honest death cause + the disk state", async () => {
		const repo = makeRepo("sd-oc-death-");
		redCheckMock.mockReturnValue("unknown" as never);
		const out = await runRedOracleCycle(baseInput({
			worktreePath: repo,
			setup: { worktreePath: repo, specDirectory: "", defaultBranch: undefined, language: "typescript" } as never,
			tddError: "timed out after 480s",
			tddNotCompleted: true,
			expectedScenarios: ["SCENARIO-001"],
			lastClaimedTestFiles: ["tests/prod.test.ts"], // the prior try's claim — the disk probe unions it
		}));
		expect(out.retryHint).toContain("PREVIOUS TRY DIED AT THE WALL CLOCK");
		expect(out.retryHint).toContain("You ran out of TIME, not correctness.");
		expect(out.retryHint).toContain("tests/prod.test.ts exist(s)"); // the disk probe found the seeded file
	});

	it("the F8 oracle-time re-check: green oracle + satisfied deliverables routes to already-satisfied verification", async () => {
		const repo = makeRepo("sd-oc-f8-");
		redCheckMock.mockReturnValue("green" as never);
		alreadyMetMock.mockReturnValue(true as never);
		const out = await runRedOracleCycle(baseInput({
			worktreePath: repo,
			setup: { worktreePath: repo, specDirectory: "", defaultBranch: undefined, language: "typescript" } as never,
			phaseDeliverables: { requireFiles: ["src/prod.ts"] } as never,
		}));
		expect(out.redEvidence.status).toBe("green-already-satisfied");
	});

	it("Tier 2 with the violations cap spent (2) → no review launched, deterministic gates carry the decision", async () => {
		const repo = makeRepo("sd-oc-cap-");
		const out = await runRedOracleCycle(baseInput({
			worktreePath: repo,
			setup: { worktreePath: repo, specDirectory: "", defaultBranch: undefined, language: "typescript" } as never,
			phaseReviewViolations: 2,
		}));
		expect(out.redReviewInFlight).toBeNull();
	});

	it("the launched review promise has its rejection marked handled (the v0.3.51 unhandledRejection lesson)", async () => {
		const repo = makeRepo("sd-oc-review-");
		const rejecting = async () => { throw new Error("boundary violation"); };
		const out = await runRedOracleCycle(baseInput({
			ctx: ctxOf([], rejecting),
			worktreePath: repo,
			setup: { worktreePath: repo, specDirectory: "", defaultBranch: undefined, language: "typescript" } as never,
		}));
		expect(out.redReviewInFlight).not.toBeNull();
		// give the microtask queue a tick — an unhandled rejection would throw here
		await new Promise((r) => setTimeout(r, 10));
	});
});
