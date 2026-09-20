/**
 * v0.4.57 — the ESM host-SDK resolution failure class (run
 * 2026-09-20T06-09-36-327Z: pi 0.86 × pi-subagents 0.70.0, every delegated
 * child dying in ~0.3s with `Cannot find package
 * '@earendil-works/pi-coding-agent' imported from …/pi-subagents/…`).
 *
 * THE CONTRACTS:
 *  - the infra-failure grammar accepts the ESM "Cannot find PACKAGE … imported
 *    from <pi-subagents>" rendering (the pre-fix regex enumerated only the CJS
 *    "Cannot find module" form, so the sticky backend degrade never armed);
 *  - the sticky degrade now carries a REASON — the host-SDK class fails fast
 *    with ITS remedy (symlink / upstream #2352 upgrade), not the version-skew
 *    "restart pi" text that is wrong for this class; first mark wins;
 *  - the envelope is NON-RETRYABLE at every isNonRetryableAgentError seam, and
 *    the summary names the class remedy;
 *  - the RED oracle cycle throws FatalAbort round-1 on a non-retryable tdd
 *    dispatch error instead of riding the retry ladder (the run burned 4 tries
 *    + judge dispatches + a research-arm against the identical 0.3s failure);
 *  - unrelated package-resolution errors (importer NOT inside pi-subagents)
 *    stay non-sticky and retryable — the class boundary is the importer path.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";

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

import {
	isDelegationRuntimeExtensionFailure,
	isDelegationHostSdkResolutionFailure,
	delegationHostSdkResolutionError,
	delegationBackendDegraded,
	delegationBackendDegradeMessage,
	markDelegationBackendDegraded,
	resetDelegationBackendDegradeForTests,
	DELEGATION_VERSION_SKEW_ERROR,
} from "../src/agents/delegation-backend.ts";
import { isNonRetryableAgentError, nonRetryableAgentSummary, isHostSdkResolutionFailure, hostSdkResolutionRemedy, resolveHostPiPackageRoot } from "../src/agent-errors.ts";
import { FatalAbort } from "../src/nodes.ts";
import { runRedOracleCycle, type RedOracleCycleInput } from "../src/stages/implementation/red-oracle-cycle.ts";
import type { PipelineState, StageContext } from "../src/types.ts";

/** Byte-shape of the live 2026-09-20 envelope (delegation wrapper included). */
const LIVE_ENVELOPE = "delegation ended with status failed: Cannot find package '@earendil-works/pi-coding-agent' imported from /home/jenningsl/.pi/agent/npm/node_modules/pi-subagents/src/runs/shared/child-session.js";
const CJS_FORM = "Cannot find module '/home/jenningsl/.pi/agent/npm/node_modules/pi-subagents/src/runs/shared/watchdog/register-main.js'";
const EXTENSION_LOAD_FORM = 'Failed to load extension "/home/jenningsl/.pi/agent/npm/node_modules/pi-subagents/src/runs/shared/subagent-prompt-runtime.ts": Cannot read properties of undefined';
const UNRELATED_PACKAGE_FORM = "Cannot find package 'left-pad' imported from /tmp/some-other-project/dist/index.js";

beforeEach(() => {
	resetDelegationBackendDegradeForTests();
});

describe("infra-failure grammar accepts the ESM host-SDK rendering (v0.4.57 shape C)", () => {
	it("the live envelope matches BOTH the generic infra predicate and the host-SDK subclass", () => {
		expect(isDelegationRuntimeExtensionFailure(LIVE_ENVELOPE)).toBe(true);
		expect(isDelegationHostSdkResolutionFailure(LIVE_ENVELOPE)).toBe(true);
	});
	it("the pre-existing CJS module form stays generic-true, subclass-false (its remedy is the reinstall class)", () => {
		expect(isDelegationRuntimeExtensionFailure(CJS_FORM)).toBe(true);
		expect(isDelegationHostSdkResolutionFailure(CJS_FORM)).toBe(false);
	});
	it("the version-skew extension-load form stays generic-true, subclass-false", () => {
		expect(isDelegationRuntimeExtensionFailure(EXTENSION_LOAD_FORM)).toBe(true);
		expect(isDelegationHostSdkResolutionFailure(EXTENSION_LOAD_FORM)).toBe(false);
	});
	it("a package error whose importer is NOT inside pi-subagents stays non-sticky (class boundary = the importer path)", () => {
		expect(isDelegationRuntimeExtensionFailure(UNRELATED_PACKAGE_FORM)).toBe(false);
		expect(isDelegationHostSdkResolutionFailure(UNRELATED_PACKAGE_FORM)).toBe(false);
	});
	it("empty/undefined never match", () => {
		expect(isDelegationRuntimeExtensionFailure(undefined)).toBe(false);
		expect(isDelegationRuntimeExtensionFailure("")).toBe(false);
		expect(isDelegationHostSdkResolutionFailure(undefined)).toBe(false);
	});
});

describe("sticky degrade carries the class-correct reason (first mark wins)", () => {
	it("marking with the host-sdk reason makes the message the fail-fast text; the default mark keeps version skew", () => {
		markDelegationBackendDegraded(delegationHostSdkResolutionError(LIVE_ENVELOPE));
		expect(delegationBackendDegraded()).toBe(true);
		expect(delegationBackendDegradeMessage()).toContain("#2352");
		expect(delegationBackendDegradeMessage()).not.toContain("version skew");
		resetDelegationBackendDegradeForTests();
		markDelegationBackendDegraded();
		expect(delegationBackendDegradeMessage()).toBe(DELEGATION_VERSION_SKEW_ERROR);
	});
	it("first mark wins — a later mark never rewrites the remedy", () => {
		markDelegationBackendDegraded(DELEGATION_VERSION_SKEW_ERROR);
		markDelegationBackendDegraded(delegationHostSdkResolutionError(LIVE_ENVELOPE));
		expect(delegationBackendDegradeMessage()).toBe(DELEGATION_VERSION_SKEW_ERROR);
	});
	it("reset clears the degrade", () => {
		markDelegationBackendDegraded();
		resetDelegationBackendDegradeForTests();
		expect(delegationBackendDegraded()).toBe(false);
		expect(delegationBackendDegradeMessage()).toBe("");
	});
});

describe("the host-SDK degrade/summary text names the real remedies", () => {
	it("delegationHostSdkResolutionError names the degraded backend + the upstream fix", () => {
		const text = delegationHostSdkResolutionError(LIVE_ENVELOPE);
		expect(text).toContain("degraded");
		expect(text).toContain("#2352");
		expect(text).toContain("@earendil-works/pi-coding-agent");
	});
	it("the shared remedy carries the upgrade path even when the local pi root is not discoverable (test process)", () => {
		const text = hostSdkResolutionRemedy(LIVE_ENVELOPE);
		expect(text).toContain("pi-subagents");
		expect(text).toContain("virtual module resolution");
	});
	it("nonRetryableAgentSummary appends the host-SDK remedy (not the generic runtime advice alone)", () => {
		const summary = nonRetryableAgentSummary(LIVE_ENVELOPE);
		expect(summary).toContain("non-retryable agent environment failure");
		expect(summary).toContain("#2352");
	});
});

describe("agent-errors classification", () => {
	it("the live envelope is non-retryable", () => {
		expect(isNonRetryableAgentError(LIVE_ENVELOPE)).toBe(true);
	});
	it("an unrelated package error stays retryable-classified (no pi-subagents importer)", () => {
		expect(isNonRetryableAgentError(UNRELATED_PACKAGE_FORM)).toBe(false);
	});
	it("isHostSdkResolutionFailure matches the subclass only", () => {
		expect(isHostSdkResolutionFailure(LIVE_ENVELOPE)).toBe(true);
		expect(isHostSdkResolutionFailure(CJS_FORM)).toBe(false);
		expect(isHostSdkResolutionFailure(UNRELATED_PACKAGE_FORM)).toBe(false);
	});
});

describe("resolveHostPiPackageRoot (advisory probe)", () => {
	it("walks up from the entry to the @earendil-works/pi-coding-agent package root", () => {
		const repo = mkdtempSync(join(tmpdir(), "sd-hsdk-root-"));
		const pkgDir = join(repo, "lib", "node_modules", "@earendil-works", "pi-coding-agent");
		mkdirSync(join(pkgDir, "dist", "bundle"), { recursive: true });
		writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: "0.86.0" }));
		writeFileSync(join(pkgDir, "dist", "bundle", "cli.js"), "");
		expect(resolveHostPiPackageRoot(join(pkgDir, "dist", "bundle", "cli.js"))).toBe(pkgDir);
		rmSync(repo, { recursive: true, force: true });
	});
	it("returns undefined for an entry outside any matching package", () => {
		expect(resolveHostPiPackageRoot("/usr/local/bin/something-else.js")).toBeUndefined();
		expect(resolveHostPiPackageRoot(undefined)).toBeUndefined();
	});
});

describe("RED oracle cycle kills non-retryable tdd errors round-1 (v0.4.57)", () => {
	const repos: string[] = [];
	const makeRepo = (): string => {
		const repo = mkdtempSync(join(tmpdir(), "sd-oc-hsdk-"));
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
	};
	const ctxOf = (): StageContext => ({
		task: "t", options: {}, state: {} as PipelineState,
		budget: { count: 0, check: () => true, spent: () => true },
		log: () => {}, phase: () => {}, events: new EventEmitter(), results: [],
		agent: async () => ({ control: {} }),
	} as unknown as StageContext);
	const baseInput = (over: Partial<RedOracleCycleInput>): RedOracleCycleInput => ({
		ctx: ctxOf(),
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
	it("a host-SDK tdd dispatch error throws FatalAbort with the class summary — no ladder, no judge dispatch", async () => {
		const repo = makeRepo();
		await expect(runRedOracleCycle(baseInput({
			worktreePath: repo,
			setup: { worktreePath: repo, specDirectory: "", defaultBranch: undefined, language: "typescript" } as never,
			tddError: LIVE_ENVELOPE,
			tddNotCompleted: true,
			testFiles: [],
		}))).rejects.toMatchObject({ message: expect.stringContaining("#2352") });
	});
	it("a model-exclusion tdd dispatch error (the other known non-retryable class) also throws FatalAbort round-1", async () => {
		const repo = makeRepo();
		await expect(runRedOracleCycle(baseInput({
			worktreePath: repo,
			setup: { worktreePath: repo, specDirectory: "", defaultBranch: undefined, language: "typescript" } as never,
			tddError: "delegation ended with status failed: Requested subagent model 'zai-coding-cn/glm-5.3-flash' is excluded and cannot be replaced by a fallback",
			tddNotCompleted: true,
			testFiles: [],
		}))).rejects.toBeInstanceOf(FatalAbort);
	});
	it("a RETRYABLE tdd error (plain 429) does NOT throw — the ladder still owns it", async () => {
		const repo = makeRepo();
		const out = await runRedOracleCycle(baseInput({
			worktreePath: repo,
			setup: { worktreePath: repo, specDirectory: "", defaultBranch: undefined, language: "typescript" } as never,
			tddError: "delegation ended with status failed: 429 rate limit exceeded",
			tddNotCompleted: true,
			testFiles: [],
		}));
		expect(out.redEvidence.status).toBeDefined();
	});
	afterEach(() => { for (const r of repos.splice(0)) rmSync(r, { recursive: true, force: true }); });
});
