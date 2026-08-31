// v0.3.49 coverage-gate integration (L3 cross-stage lane per
// docs/testing-strategy.md): a REAL temp git repo, a REAL cached runner
// (node --test), REAL coverage measurements across two attempts, and the
// implementer actually writing files — proving the phase CANNOT go green
// below the 85% hard floor, the retry prompt carries the exact per-file
// numbers, and a coverage-raising retry converges.

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { execSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentCall, AgentResult, Budget, ControlObj, HelperResult, PipelineState, RunOptions, Stage, StageContext } from "../src/types.ts";

let redCalls = 0;
vi.mock("../src/build-runner.ts", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return {
		...actual,
		// Context-dependent oracle: the pre-implementation RED check reports RED
		// (the frozen oracle must fail against unimplemented code); every later
		// call (post-implementation re-checks) reports GREEN.
		runRedCheck: vi.fn((): string => (redCalls++ === 0 ? "red" : "green")),
		runBuildGate: vi.fn(() => ({ pass: true, inScopePass: false, ran: ["node --test"], errors: [], outOfScopeErrors: [] })),
		runDeliverableCheck: vi.fn(() => ({ pass: true, missing: [], ran: [] })),
		resetDeliverableCheckCache: vi.fn(() => {}),
	};
});
vi.mock("../src/render/render.ts", () => ({ renderAndWrite: vi.fn() }));

import { implementationStage } from "../src/stages/implementation.ts";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) { try { rmSync(d, { recursive: true, force: true }); } catch { /* ok */ } } });

function git(dir: string, cmd: string): void {
	execSync(`git -c user.email=t@t -c user.name=t ${cmd}`, { cwd: dir, stdio: "pipe" });
}

function makeRepo(): { repo: string; specDir: string } {
	const repo = mkdtempSync(join(tmpdir(), "covit-"));
	dirs.push(repo);
	git(repo, "init -q -b main");
	writeFileSync(join(repo, "README.md"), "seed\n");
	git(repo, "add -A && git commit -qm seed");
	const specDir = join(repo, "docs", "specifications", "covit") + "/";
	mkdirSync(specDir, { recursive: true });
	// The validated runner cache (normally written by runner-discovery).
	writeFileSync(join(specDir, "test-runner.json"), JSON.stringify({
		version: 1,
		command: "node --test --test-reporter=tap tests/big.test.mjs",
		resultFormat: "tap",
		discoveredAt: new Date().toISOString(),
	}));
	mkdirSync(join(repo, "tests"));
	// The RED test (frozen oracle): covers ONLY `covered` from src/big.js.
	writeFileSync(join(repo, "tests", "big.test.mjs"), [
		'import { test } from "node:test";',
		'import assert from "node:assert/strict";',
		'import { covered } from "../src/big.js";',
		'test("covered", () => { assert.equal(covered(1), 2); });',
		"",
	].join("\n"));
	return { repo, specDir };
}

function mkState(repo: string, specDir: string): PipelineState {
	return {
		setup: { worktreePath: repo, specDirectory: specDir, defaultBranch: "main", language: "frontend", isWebUi: false, specIdentifier: "covit", worktreeCreated: true, initializedRepo: true },
		classify: { taskType: "feature", uiScope: "none", language: "frontend", isWebUi: false },
		spec: { phases: [{ name: "Cov", description: "d", deliverables: { requireFiles: ["src/big.js"] } }] },
	} as unknown as PipelineState;
}

function mkCtx(repo: string, opts: { implWrites?: Array<() => void> } = {}): { ctx: StageContext; logs: string[]; implPrompts: string[]; implCalls: () => number } {
	const logs: string[] = [];
	const implPrompts: string[] = [];
	const writeQueue = [...(opts.implWrites ?? [])];
	let implCalls = 0;
	const ctx: StageContext = {
		task: "",
		options: { escalate: async () => undefined } as RunOptions,
		state: {} as PipelineState,
		async helper(): Promise<HelperResult> { return { value: { languageInstructions: "" }, digest: "" }; },
		async agent(call: AgentCall): Promise<AgentResult> {
			if (call.agent === "tdd-guide") return { text: "", control: { testFiles: ["tests/big.test.mjs"] } };
			if (call.agent === "implementer") {
				implCalls++;
				implPrompts.push(call.prompt);
				writeQueue.shift()?.();
				return { text: "", control: { filesCreated: implCalls === 1 ? ["src/big.js"] : [], filesModified: implCalls === 1 ? [] : ["src/big.js"], testDefects: [] } as ControlObj };
			}
			if (call.agent === "code-reviewer") return { text: "", control: { verdict: "strong", summary: "s", contradictions: [] } };
			if (call.agent === "tdd-coverage-classifier") return { text: "", control: { allCovered: true, coveredScenarios: [], missingScenarios: [], summary: "ok" } };
			if (call.agent === "judge") return { text: "", control: null };
			return { text: "", control: {} };
		},
		async parallel(cbs) { return Promise.all(cbs.map((c) => c())); },
		budget: { count: 0, check: () => true, spent() { this.count++; return true; } } satisfies Budget,
		log(m: string) { logs.push(m); },
		phase() {},
		events: new EventEmitter(),
		results: [],
	};
	return { ctx, logs, implPrompts, implCalls: () => implCalls };
}

const writePartial = (repo: string) => () => writeFileSync(join(repo, "src", "big.js"), [
	"export function covered(a) {",
	"  const x = a + 1;",
	"  return x;",
	"}",
	"export function notCovered(a) {",
	"  const y = a * 2;",
	"  const z = y + 1;",
	"  return z;",
	"}",
	"",
].join("\n"));

const writeCoverageTests = (repo: string) => () => writeFileSync(join(repo, "tests", "big-extra.test.mjs"), [
	'import { test } from "node:test";',
	'import assert from "node:assert/strict";',
	'import { notCovered } from "../src/big.js";',
	'test("notCovered", () => { assert.equal(notCovered(2), 5); });',
	"",
].join("\n"));

describe("v0.3.49 — coverage hard gate inside the implementation stage (real repo + real node --test coverage)", () => {
	beforeEach(() => { redCalls = 0; delete process.env.SUPER_DEV_NO_COVERAGE_GATE; });

	it("below the 85% floor the phase is NOT green: the implementer retries with exact per-file numbers and converges once coverage rises", async () => {
		const { repo, specDir } = makeRepo();
		mkdirSync(join(repo, "src"), { recursive: true });
		const r = mkCtx(repo, { implWrites: [writePartial(repo), writeCoverageTests(repo)] });
		await (implementationStage as Stage).run(mkState(repo, specDir), r.ctx);
		const joined = r.logs.join("\n");

		// Attempt 1 measured and rejected.
		expect(joined).toMatch(/coverage-gate BELOW-THRESHOLD \(\d+\.\d+% lines vs ≥85%\)/);
		expect(joined).toContain("coverage-gate PASS");
		// The retry prompt carried the hard-floor block with the file numbers.
		expect(r.implPrompts.length).toBeGreaterThanOrEqual(2);
		expect(r.implPrompts[1]).toContain("Coverage below the hard floor");
		expect(r.implPrompts[1]).toContain("src/big.js");
		expect(r.implPrompts[1]).toContain("% lines vs the ≥85% hard floor");
		// Converged: the phase went green (deterministic commit path logs).
		expect(joined).toMatch(/GREEN on attempt 2/);
		// The suite-wide coverage run saw the retry's NEW test file (file positionals stripped).
		expect(joined.match(/coverage-gate BELOW-THRESHOLD/g)?.length).toBe(1);
	}, 120_000);

	it("SUPER_DEV_NO_COVERAGE_GATE=1 skips the gate entirely", async () => {
		const { repo, specDir } = makeRepo();
		mkdirSync(join(repo, "src"), { recursive: true });
		process.env.SUPER_DEV_NO_COVERAGE_GATE = "1";
		const r = mkCtx(repo, { implWrites: [writePartial(repo)] });
		await (implementationStage as Stage).run(mkState(repo, specDir), r.ctx);
		expect(r.logs.join("\n")).not.toContain("coverage-gate BELOW-THRESHOLD");
		expect(r.implCalls()).toBe(1); // no coverage-driven retry
	}, 120_000);

	it("unmeasurable runner family: phase still greens (fail-open) with a loud ledger advisory", async () => {
		const { repo, specDir } = makeRepo();
		mkdirSync(join(repo, "src"), { recursive: true });
		writeFileSync(join(specDir, "test-runner.json"), JSON.stringify({
			version: 1,
			command: "pytest tests/",
			resultFormat: "console",
			discoveredAt: new Date().toISOString(),
		}));
		const r = mkCtx(repo, { implWrites: [writePartial(repo)] });
		const state = mkState(repo, specDir);
		await (implementationStage as Stage).run(state, r.ctx);
		const joined = r.logs.join("\n");
		expect(joined).toContain("coverage-gate UNMEASURABLE");
		expect(r.implCalls()).toBe(1);
		// The carried-debt advisory is recorded in the in-memory convergence
		// ledger (persistence additionally requires a .task anchor, absent on
		// test tracks by design).
		const led = (state as unknown as { __convergenceLedger?: { findings: Array<{ title?: string }> } }).__convergenceLedger;
		expect(led?.findings.some((f) => (f.title ?? "").includes("coverage gate UNMEASURABLE"))).toBe(true);
	}, 120_000);
});
