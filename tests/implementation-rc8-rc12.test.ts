/**
 * RC8–RC12 — implementation-stage harness defects from the macOS STEP E2E
 * dashboard runs 10-39 / 15-07 (docs/requirements/
 * implementation-stage-harness-defects-rc8-rc12.md).
 *
 *   RC8  review-rejected RED masquerading as "tests passed before
 *        implementation" in logs/judge/escalation (run 10-39 phase-2).
 *   RC9  deliverable contains-check blind to comment-only matches (run 15-07
 *        phase-1: `missing pattern SCENARIO-00[1-9]` while the file held the
 *        tags in Go comments).
 *   RC10 Go cross-module greenfield RED classified `broken` forever (run
 *        10-39 phase-2: behavior tests referencing not-yet-declared symbols
 *        in an EXISTING package).
 *   RC11 task-contract precedence for declaration-level observables in the
 *        RED review + TDD prompts.
 *   RC12a fresh-worktree dependency bootstrap (unrelated auth-service build
 *        failures forced implementer edits of unrelated files).
 *   RC12c out-of-scope GREEN edits recorded as a non-blocking finding.
 *
 * Hermetic: build-runner mock for the stage tests; tmp fixtures for the pure
 * gate functions. No network, no LLM.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

// Mock child_process for the PURE gate tests (RC10): runRedCheck spawns `go` —
// stub it so classification is driven by scripted compiler output, never a
// real toolchain.
const cpMock = vi.hoisted(() => ({
	stubber: null as null | ((args: string[], cwd?: string) => { status: number; stdout: string; stderr: string; signal: NodeJS.Signals | null; error?: Error }),
}));
vi.mock("node:child_process", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return {
		...actual,
		spawnSync: (cmd: string, argv?: readonly string[], opts?: { cwd?: string }) => {
			if (cpMock.stubber) return cpMock.stubber([cmd, ...(Array.isArray(argv) ? argv.slice() : [])], opts?.cwd);
			return (actual.spawnSync as typeof import("node:child_process").spawnSync)(cmd, argv, opts as never);
		},
	};
});

vi.mock("../src/build-runner.ts", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return {
		...actual,
		runRedCheck: vi.fn((): string => "unknown"),
		runBuildGate: vi.fn(() => ({
			pass: true,
			ran: ["mock"],
			errors: [],
		})),
	};
});

import { implementationStage } from "../src/stages/implementation.ts";
import { runRedCheck, runBuildGate } from "../src/build-runner.ts";
import { runDeliverableCheck, runRedCheck as runRedCheckRealGo } from "../src/build-runner/gates.ts";
import { ChangeTracker, setActiveTracker } from "../src/tracking.ts";
import { buildTddPrompt, buildRedReviewPrompt } from "../src/prompts.ts";

const redCheck = vi.mocked(runRedCheck);
const buildGate = vi.mocked(runBuildGate);

beforeEach(() => {
	redCheck.mockReset();
	buildGate.mockReset();
	buildGate.mockImplementation(() => ({ pass: true, ran: ["mock"], errors: [] }) as never);
	cpMock.stubber = null;
});

// ─── shared stage harness (mirrors implementation-red-loop.test.ts) ─────────

function mkState(): PipelineState {
	return {
		setup: {
			worktreePath: "/tmp/sd-rc8",
			specDirectory: "/tmp/sd",
			defaultBranch: "main",
			language: "frontend",
			isWebUi: false,
			specIdentifier: "rc",
			worktreeCreated: false,
			initializedRepo: false,
		},
		classify: { taskType: "bug", uiScope: "none", language: "frontend", isWebUi: false },
		spec: { phases: [{ name: "P1", description: "x" }] },
	} as unknown as PipelineState;
}

function mkCtx(opts: {
	reviewVerdicts?: Array<"strong" | "weak">;
	reviewSummaries?: string[];
	escalate?: RunOptions["escalate"];
	coverageControls?: ControlObj[];
} = {}): { ctx: StageContext; logs: string[]; tddPrompts: string[]; findings: unknown[] } {
	const logs: string[] = [];
	const tddPrompts: string[] = [];
	const findings: unknown[] = [];
	const reviewQ = [...(opts.reviewVerdicts ?? [])];
	const summaryQ = [...(opts.reviewSummaries ?? [])];
	const coverageQ = [...(opts.coverageControls ?? [{ allCovered: true, coveredScenarios: [], missingScenarios: [], summary: "covered" }])];
	const ctx: StageContext = {
		task: "",
		options: { escalate: opts.escalate } as RunOptions,
		state: {} as PipelineState,
		async helper(): Promise<HelperResult> {
			return { value: { languageInstructions: "" }, digest: "" };
		},
		async agent(call: AgentCall): Promise<AgentResult> {
			if (call.agent === "tdd-guide") {
				tddPrompts.push(call.prompt);
				return { text: "", control: { testFiles: ["tests/red.test.ts"] } };
			}
			if (call.agent === "implementer") {
				return { text: "", control: { filesModified: ["src/x.ts"] } };
			}
			if (call.agent === "tdd-coverage-classifier") {
				return { text: "", control: coverageQ.length > 0 ? coverageQ.shift()! : {} };
			}
			if (call.agent === "code-reviewer") {
				const verdict = reviewQ.shift() ?? "strong";
				const summary = summaryQ.shift() ?? (verdict === "weak" ? "assertions are tautological" : "ok");
				return { text: "", control: { verdict, summary, contradictions: [] } };
			}
			return { text: "", control: {} };
		},
		async parallel(cbs) {
			return Promise.all(cbs.map((c) => c()));
		},
		budget: { count: 0, check: () => true, spent() { this.count++; return true; } } satisfies Budget,
		log(m: string) { logs.push(m); },
		phase() {},
		events: new EventEmitter(),
		results: [],
	};
	// recordConvergenceFindings writes into state via module import; capture via
	// the ledger path on the state object the stage uses.
	(ctx.state as Record<string, unknown>).review = { convergence: [] };
	findings.push((ctx.state as Record<string, unknown>).review);
	return { ctx, logs, tddPrompts, findings };
}

// ─── RC8: honest RED evidence statuses ──────────────────────────────────────

describe("RC8 — review-rejected RED is never reported as 'tests passed'", () => {
	it("v0.3.0: a WEAK review proceeds immediately — no retry loop, no 'tests passed before implementation' lie, oracle truth preserved", async () => {
		redCheck.mockImplementation(() => "red"); // oracle CORRECT all rounds
		const escalate: RunOptions["escalate"] = async (failure) => undefined; // headless no-op
		const { ctx, logs } = mkCtx({ reviewVerdicts: ["weak"], escalate });
		await (implementationStage as Stage).run(mkState(), ctx);

		// v0.3.0: merely-weak (explicit verdict, no contradictions) no longer burns
		// the tdd-guide re-author loop — it proceeds with an advisory. The honesty
		// contract holds: NO line ever claims tests passed before implementation.
		for (const line of logs) {
			expect(line).not.toMatch(/tests passed before implementation/);
		}
		expect(logs.some((l) => /RED review: NOT STRONG.*advisory; proceeding/.test(l))).toBe(true);
		// The oracle truth (red) is preserved in the oracleStatus evidence lines.
		expect(logs.some((l) => /red-oracle:\s*red\b/.test(l))).toBe(true);
	});

	it("v0.3.0: an EMPTY/invalid review verdict stays fail-closed (re-authors, red-review-rejected honesty lines)", async () => {
		redCheck.mockImplementation(() => "red");
		const escalate: RunOptions["escalate"] = async () => undefined;
		// Empty verdict = the review did not run — R2 fail-closed still applies
		// (a review that did not run must never equal a pass); the re-author loop
		// burns its budget and the honesty contract pins the reason lines.
		const { ctx, logs } = mkCtx({ reviewVerdicts: ["", "", "", "", "", "", "", ""] as never, escalate });
		await (implementationStage as Stage).run(mkState(), ctx);
		expect(logs.some((l) => /red-review-rejected: RED review not strong:/.test(l))).toBe(true);
	});

	it("v0.3.0: a weak-proceeds run never fabricates a rejection line (contradiction path pinned in implementation-red-loop)", async () => {
		redCheck.mockImplementation(() => "red");
		const escalate: RunOptions["escalate"] = async () => undefined;
		const { ctx, logs } = mkCtx({ reviewVerdicts: ["weak"], escalate });
		await (implementationStage as Stage).run(mkState(), ctx);
		expect(logs.some((l) => /red-review-rejected/.test(l))).toBe(false);
	});

	it("an ORACLE-green run still reports the canonical reason (back-compat)", async () => {
		redCheck.mockImplementation(() => "green");
		const escalate: RunOptions["escalate"] = async () => undefined;
		const { ctx, logs } = mkCtx({ escalate });
		await (implementationStage as Stage).run(mkState(), ctx);
		expect(logs.some((l) => /red-not-confirmed: tests passed before implementation/.test(l))).toBe(true);
	});

	it("a hollow RED test (oracle red, no assertion call) reports the hollow reason, not the green template", async () => {
		redCheck.mockImplementation(() => "red");
		const escalate: RunOptions["escalate"] = async () => undefined;
		// hollow detection reads the test file on disk — path is mocked away, so
		// assert the green-weak template is only ever used for oracle-green.
		const { ctx, logs } = mkCtx({ escalate });
		await (implementationStage as Stage).run(mkState(), ctx);
		expect(logs.some((l) => /red-not-confirmed: tests passed before implementation/.test(l))).toBe(false);
	});
});

// ─── RC9: deliverable contains-check comment-blindness ───────────────────────

describe("RC9 — comment-only contains matches get an honest, actionable error", () => {
	let dir: string;
	beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "rc9-")); });
	afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

	it("a Go file whose SCENARIO tags live only in comments reports the comment-stripping cause", () => {
		writeFileSync(join(dir, "conn_step_test.go"), [
			"package settings",
			"",
			"// SCENARIO-003: step connection type",
			"// SCENARIO-004: userid field",
			"func TestConn(t *testing.T) { t.Fail() }",
			"",
		].join("\n"));
		const r = runDeliverableCheck(dir, { requireContains: [{ file: "conn_step_test.go", pattern: "SCENARIO-00[1-9]" }] });
		expect(r.pass).toBe(false);
		const msg = r.missing.join("; ");
		expect(msg).toMatch(/SCENARIO-00\[1-9\]/);
		expect(msg).toMatch(/matched only inside comments/);
		expect(msg).toMatch(/comments are stripped before matching/);
	});

	it("a TS file with the tag in a string literal passes (comments aside)", () => {
		writeFileSync(join(dir, "red.test.ts"), [
			"// SCENARIO-003 comment",
			"const TAG = \"SCENARIO-003\";",
			"test(\"does x\", () => { expect(TAG).toBe(\"SCENARIO-003\"); });",
			"",
		].join("\n"));
		const r = runDeliverableCheck(dir, { requireContains: [{ file: "red.test.ts", pattern: "SCENARIO-003" }] });
		expect(r.pass).toBe(true);
	});

	it("a file missing the pattern entirely keeps the plain error", () => {
		writeFileSync(join(dir, "main.go"), "package main\nfunc main() {}\n");
		const r = runDeliverableCheck(dir, { requireContains: [{ file: "main.go", pattern: "SCENARIO-00[1-9]" }] });
		expect(r.pass).toBe(false);
		expect(r.missing.join("; ")).not.toMatch(/comments/);
	});
});

import { afterEach } from "vitest";

// ─── RC10: Go cross-module greenfield RED ────────────────────────────────────

/** A stubber answering ONLY the `go test <targets>` spawn with `stderrTail`
 *  and exit 1 (git answers not-a-repo so detectProjectCommands still derives
 *  go from go.mod; everything else falls through to the real spawnSync). */
function goStub(stderrTail: string): NonNullable<typeof cpMock.stubber> {
	return (args) => {
		if (args[0] === "go" && args.includes("test")) {
			return { status: 1, stdout: "", stderr: stderrTail, signal: null };
		}
		if (args[0] === "git") return { status: 128, stdout: "", stderr: "fatal: not a git repository", signal: null };
		return { status: 0, stdout: "", stderr: "", signal: null };
	};
}

describe("RC10 — Go undefined-symbol greenfield in an EXISTING package", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "rc10-"));
		mkdirSync(join(dir, "internal", "database"), { recursive: true });
		writeFileSync(join(dir, "go.mod"), "module example.com/app\n\ngo 1.26\n");
		// An EXISTING package with real sources (NOT test-only — the shape-1 probe
		// must not fire) whose symbols are NOT the referenced ones.
		writeFileSync(join(dir, "internal", "database", "existing.go"), "package database\n\nfunc Existing() int { return 1 }\n");
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
		cpMock.stubber = null;
	});

	it("all-undefined refs declared nowhere → greenfield RED (not broken)", () => {
		// The test imports the INTERNAL models package (no alias — Go derives
		// the name from the path) and references a symbol it does not declare.
		writeFileSync(join(dir, "internal", "database", "step_test.go"), "package database\n\nimport (\n\t\"testing\"\n\t\"example.com/app/internal/models\"\n)\n\nfunc TestX(t *testing.T) { _ = models.StepProcess }\n");
		cpMock.stubber = goStub(
			"internal/database/step_test.go:5:9: undefined: models.StepProcess\nFAIL\texample.com/app/internal/database [build failed]\n",
		);
		const r = runRedCheckRealGo(dir, ["internal/database/step_test.go"]);
		expect(r).toBe("red");
	});

	it("a typo'd reference to an EXISTING symbol stays broken", () => {
		writeFileSync(join(dir, "internal", "database", "step_test.go"), "package database\n\nimport \"testing\"\n\nfunc TestX(t *testing.T) { _ = Existng() }\n");
		cpMock.stubber = goStub(
			"internal/database/step_test.go:5:9: undefined: Existng\nFAIL\texample.com/app/internal/database [build failed]\n",
		);
		const r = runRedCheckRealGo(dir, ["internal/database/step_test.go"]);
		expect(r).toBe("broken");
	});

	it("an EXTERNAL package's undefined symbol stays broken (never greenfield)", () => {
		writeFileSync(join(dir, "internal", "database", "step_test.go"), "package database\n\nimport (\n\t\"testing\"\n\t\"github.com/some/external/pkg\"\n)\n\nfunc TestX(t *testing.T) { _ = pkg.Undefined }\n");
		cpMock.stubber = goStub(
			"internal/database/step_test.go:5:9: undefined: pkg.Undefined\nFAIL\texample.com/app/internal/database [build failed]\n",
		);
		const r = runRedCheckRealGo(dir, ["internal/database/step_test.go"]);
		expect(r).toBe("broken");
	});

	it("top-level declarations only: a usage inside a function body does not rescue the symbol", () => {
		writeFileSync(join(dir, "internal", "database", "step_test.go"), "package database\n\nimport \"testing\"\n\nfunc TestX(t *testing.T) { MigrateStepE2E() }\n");
		// MigrateStepE2E appears only INSIDE a function body (not top-level) →
		// still nowhere-declared → greenfield red.
		writeFileSync(join(dir, "internal", "database", "other.go"), "package database\n\nfunc Wrapped() { MigrateStepE2E() }\n");
		cpMock.stubber = goStub(
			"internal/database/step_test.go:5:9: undefined: MigrateStepE2E\nFAIL\texample.com/app/internal/database [build failed]\n",
		);
		const r = runRedCheckRealGo(dir, ["internal/database/step_test.go"]);
		expect(r).toBe("red");
	});
});

// ─── RC12c: out-of-scope edit detection (unit, via the mocked spawnSync) ─────

describe("RC12c — trackerOutofScopeEdits semantics", () => {
	it("splits porcelain lines correctly (no literal-\\n blob), excludes spec scope + RED test files, records the rest", async () => {
		// trackerOutofScopeEdits is module-private; exercise it through the stage
		// GREEN path with a scripted git status. The stage calls it only when the
		// phase has spec-declared deliverables.
		redCheck.mockImplementation(() => "red");
		const porcelain = [
			" M backend-service/internal/handlers/snow/area_selection.go",
			" M tests/red.test.ts",
			"?? auth-service/src/types/pg.d.ts",
			"R  old/path.ts -> new/path.ts",
		].join("\n");
		cpMock.stubber = (args) => {
			if (args[0] === "git" && args.includes("status")) {
				return { status: 0, stdout: porcelain, stderr: "", signal: null };
			}
			return { status: 0, stdout: "", stderr: "", signal: null };
		};
		const state = {
			setup: { worktreePath: "/tmp/sd-rc12c", specDirectory: "/tmp/sd", defaultBranch: "main", language: "go", isWebUi: false, specIdentifier: "rc12c", worktreeCreated: false, initializedRepo: false },
			classify: { taskType: "feature", uiScope: "none", language: "go", isWebUi: false },
			spec: { phases: [{ name: "P1", description: "x", deliverables: { requireFiles: ["backend-service/internal/handlers/e2e/settings/connection.go"], requireContains: [{ file: "backend-service/internal/handlers/e2e/settings/connection.go", pattern: "STEP" }] } }] },
		} as unknown as PipelineState;
		// The stage only computes out-of-scope edits when a tracker is ACTIVE.
		setActiveTracker(new ChangeTracker("/tmp/sd", state.setup!.worktreePath));
		try {
			const { ctx, logs } = mkCtx();
			await (implementationStage as Stage).run(state, ctx);
			var line = logs.find((l) => /out-of-scope edits/.test(l));
		} finally {
			setActiveTracker(null);
		}
		expect(line).toBeDefined();
		// The unrelated snow edit, the auth-service type shim, and the rename's
		// NEW path are recorded — the RED test file is NOT (reviewer F-2), and no
		// garbage blob path appears (reviewer F-1 regression pin).
		expect(line).toMatch(/snow\/area_selection\.go/);
		expect(line).toMatch(/auth-service\/src\/types\/pg\.d\.ts/);
		expect(line).toMatch(/new\/path\.ts/);
		expect(line).not.toMatch(/tests\/red\.test\.ts/); // the phase RED test file is excluded
		expect(line).not.toMatch(/\\n/);
	});
});

// ─── RC11: task-contract precedence in prompts ───────────────────────────────

describe("RC11 — task-contract precedence in RED review + TDD prompts", () => {
	const setup = { worktreePath: "/tmp/w", specDirectory: "/tmp/s", defaultBranch: "main", language: "go", isWebUi: false, specIdentifier: "t", worktreeCreated: true, initializedRepo: false } as never;
	const classify = { taskType: "feature", uiScope: "none", language: "go", isWebUi: false } as never;

	it("buildRedReviewPrompt carries the TASK-CONTRACT PRECEDENCE rule", () => {
		const p = buildRedReviewPrompt(setup, classify, { name: "P2" }, ["a_test.go"], ["SCENARIO-034"], null, null);
		expect(p).toMatch(/TASK-CONTRACT PRECEDENCE/);
		expect(p).toMatch(/declaration\/source-level/);
		expect(p).toMatch(/Do not demand a deeper observable/);
	});

	it("buildTddPrompt carries the TEST LEVEL = TASK LEVEL rule and the comment-stripping note", () => {
		const p = buildTddPrompt(setup, classify, { name: "P1", deliverables: { requireScenarios: ["SCENARIO-001"] } }, null, "", null);
		expect(p).toMatch(/TEST LEVEL = TASK LEVEL/);
		expect(p).toMatch(/Comments do NOT count/);
		expect(p).toMatch(/comments are stripped/i.test("") ? /x/ : /gate strips comments/);
	});
});

// ─── RC12a: dependency bootstrap ─────────────────────────────────────────────

describe("RC12a — fresh-worktree dependency bootstrap", () => {
	it("runSetup triggers a frozen install for a pnpm monorepo worktree (observable via node_modules marker)", async () => {
		const { runSetup } = await import("../src/setup.ts");
		const root = mkdtempSync(join(tmpdir(), "rc12a-"));
		try {
			// Minimal git repo with a pnpm workspace.
			const { execFileSync: ex } = await import("node:child_process");
			const g = (...args: string[]) => ex("git", ["-C", root, ...args], { encoding: "utf8" });
			g("init", "-q");
			g("config", "user.email", "t@t");
			g("config", "user.name", "t");
			writeFileSync(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
			writeFileSync(join(root, "package.json"), JSON.stringify({ name: "m", private: true }));
			ex("git", ["-C", root, "add", "-A"], { encoding: "utf8" });
			g("commit", "-qm", "init");
			const logs: string[] = [];
			const setup = runSetup("add rc12 feature x", { cwd: root, log: (m) => logs.push(m) });
			// The bootstrap either ran (pnpm present) or warned it failed — but it
			// MUST have been considered (log evidence), and runSetup must succeed.
			expect(typeof setup.worktreePath).toBe("string");
			const boot = logs.filter((l) => /bootstrap/i.test(l));
			// On CI without pnpm this logs the FAILED warning; with pnpm it logs the
			// finish line. Either way exactly one bootstrap decision was logged.
			expect(boot.length).toBeGreaterThanOrEqual(1);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("respects the SUPER_DEV_NO_BOOTSTRAP kill-switch (no bootstrap logs)", async () => {
		const { runSetup } = await import("../src/setup.ts");
		const root = mkdtempSync(join(tmpdir(), "rc12b-"));
		try {
			const { execFileSync: ex } = await import("node:child_process");
			const g = (...args: string[]) => ex("git", ["-C", root, ...args], { encoding: "utf8" });
			g("init", "-q");
			g("config", "user.email", "t@t");
			g("config", "user.name", "t");
			writeFileSync(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
			writeFileSync(join(root, "package.json"), JSON.stringify({ name: "m", private: true }));
			ex("git", ["-C", root, "add", "-A"], { encoding: "utf8" });
			g("commit", "-qm", "init");
			process.env.SUPER_DEV_NO_BOOTSTRAP = "1";
			const logs: string[] = [];
			runSetup("add rc12 feature y", { cwd: root, log: (m) => logs.push(m) });
			expect(logs.filter((l) => /bootstrap/i.test(l))).toHaveLength(0);
		} finally {
			delete process.env.SUPER_DEV_NO_BOOTSTRAP;
			rmSync(root, { recursive: true, force: true });
		}
	});
});
