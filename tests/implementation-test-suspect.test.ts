/**
 * J3 (v0.2.4, run 2026-08-19T03-16-50-261Z): deterministic test-suspect advisory
 * at the GREEN-loop no-progress terminal boundary.
 *
 * Evidence class: two implementer attempts failed identically on `npm run test`
 * while the phase's accepted RED targets stayed red (`tdd-targets-still-red`) —
 * the born-broken-RED shape (an unsatisfiable `.sort()` collation literal). The
 * judge timed out, headless HITL no-ops, and the old terminal stop never named
 * the most likely cause.
 *
 * Contract (advisory only — "a test that fails consistently is not flaky, it is
 * broken"; never auto-trigger a re-author):
 *   - stop log gains a `[test-suspect: …]` marker when still-red is in the
 *     failure evidence;
 *   - the escalation message gains the DETERMINISTIC TEST-SUSPECT SIGNAL block
 *     (only when the implementer reported no structured testDefects);
 *   - the escalation findings carry a `test-suspect (deterministic)` entry;
 *   - a no-progress stop WITHOUT still-red evidence carries none of these.
 *
 * Harness: tests/signature-noise.test.ts pattern (scripted runRedCheck +
 * sequenced runBuildGate, real Stage 9 attempt loop, hermetic).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	AgentCall,
	AgentResult,
	Budget,
	HelperResult,
	PipelineState,
	RunOptions,
	Stage,
	StageContext,
} from "../src/types.ts";

vi.mock("../src/build-runner.ts", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return {
		...actual,
		runRedCheck: vi.fn((): string => "red"),
		runBuildGate: vi.fn(() => ({ pass: true, inScopePass: false, ran: ["npm test"], errors: [], outOfScopeErrors: [] })),
		runDeliverableCheck: vi.fn(() => ({ pass: true, missing: [] as string[], ran: [] as string[] })),
		resetDeliverableCheckCache: vi.fn(() => {}),
	};
});

vi.mock("../src/render/render.ts", () => ({ renderAndWrite: vi.fn() }));

import { implementationStage } from "../src/stages/implementation.ts";
import { runRedCheck, runBuildGate, type RedCheckDiagnostic, type RedStatus } from "../src/build-runner.ts";
import { resetJudgeBudgets } from "../src/stages/judge.ts";

const redCheck = vi.mocked(runRedCheck);
const buildGate = vi.mocked(runBuildGate);

let wt: string;

function mkState(): PipelineState {
	return {
		setup: {
			worktreePath: wt,
			specDirectory: join(wt, "docs/specifications/test-suspect"),
			defaultBranch: "main",
			language: "frontend",
			isWebUi: false,
			specIdentifier: "test-suspect",
			worktreeCreated: false,
			initializedRepo: false,
		},
		classify: { taskType: "feature", uiScope: "none", language: "frontend", isWebUi: false },
		spec: { phases: [{ name: "Phase 1" }] },
	} as unknown as PipelineState;
}

interface CapturedCalls {
	impl: AgentCall[];
	logs: string[];
	escalations: Array<{ kind: string; message: string; findings: Array<{ title: string }> }>;
}

function mkCtx(): { ctx: StageContext; calls: CapturedCalls } {
	const calls: CapturedCalls = { impl: [], logs: [], escalations: [] };
	const escalate = (async (failure: { kind: string; message: string; findings: Array<{ title: string }> }) => {
		calls.escalations.push(failure);
		return undefined;
	}) as unknown as RunOptions["escalate"];
	const ctx: StageContext = {
		task: "",
		options: { escalate } as RunOptions,
		state: {} as PipelineState,
		async helper(): Promise<HelperResult> { return { value: { languageInstructions: "" }, digest: "" }; },
		async agent(call: AgentCall): Promise<AgentResult> {
			if (call.agent === "tdd-guide") return { text: "", control: { testFiles: ["tests/red.test.ts"] } };
			if (call.agent === "implementer") {
				calls.impl.push(call);
				return { text: "", control: { filesModified: ["src/x.ts"] } };
			}
			if (call.agent === "judge") return { text: "", control: null };
			if (call.agent === "tdd-coverage-classifier") return { text: "", control: { allCovered: true, coveredScenarios: [], missingScenarios: [], summary: "covered" } };
			if (call.agent === "code-reviewer") return { text: "", control: { verdict: "strong", summary: "ok", contradictions: [] } };
			return { text: "ok", control: {} };
		},
		parallel: async (cs: Array<() => Promise<AgentResult>>) => Promise.all(cs.map((c) => c())),
		budget: { check: () => true, spent: () => true, count: 0 } satisfies Budget,
		log: (m: string) => calls.logs.push(m),
		phase: () => {},
		events: new EventEmitter(),
		results: [],
	};
	return { ctx, calls };
}

/** Identical failing gate errors on every attempt (constant failure signature). */
function gateAlwaysFails(): void {
	buildGate.mockImplementation(() => ({
		pass: false,
		inScopePass: false,
		ran: ["npm test"],
		errors: ["npm run test FAILED (exit 1): FAIL tests/staged-knowledge-store.test.ts > SCENARIO-006"],
		outOfScopeErrors: [],
	}) as never);
}

/** Script runRedCheck statuses per call (repeating the last). */
function redSeq(...statuses: RedStatus[]): void {
	let i = 0;
	redCheck.mockImplementation((_cwd: string, _targets: string[], opts?: { onResult?: (diagnostic: RedCheckDiagnostic) => void }) => {
		const s = statuses[Math.min(i, statuses.length - 1)] ?? "unknown";
		i++;
		opts?.onResult?.({
			plan: { cwd: wt, argv: ["vitest", "run", "tests/red.test.ts"] },
			language: "backend",
			status: s,
			exitCode: s === "green" ? 0 : 1,
			signal: null,
			outputTail: s === "green" ? "ok" : "FAIL tests/red.test.ts",
		});
		return s;
	});
}

beforeEach(() => {
	resetJudgeBudgets();
	delete process.env.SUPER_DEV_DISABLE_JUDGE;
	redCheck.mockReset();
	buildGate.mockReset();
	wt = mkdtempSync(join(tmpdir(), "sd-testsuspect-"));
	mkdirSync(join(wt, "tests"), { recursive: true });
	writeFileSync(join(wt, "tests", "red.test.ts"), `import { store } from "../src/store";\nexpect(Object.keys(store).sort()).toEqual(["resolve", "行业面", "基本面"]); // born-broken collation literal (run 2026-08-19T03-16-50-261Z)\n`);
});

afterEach(() => {
	try { rmSync(wt, { recursive: true, force: true }); } catch { /* tmp */ }
});

describe("J3 — deterministic test-suspect advisory at the no-progress stop", () => {
	it("FIX: still-red across identical no-progress attempts surfaces the test-suspect advisory (log, message, findings)", async () => {
		// RED-gen red (accepted), then post-red-oracle STAYS red on both attempts:
		// the born-broken-RED shape.
		redSeq("red", "red", "red");
		gateAlwaysFails();
		const { ctx, calls } = mkCtx();

		await (implementationStage as Stage).run(mkState(), ctx);

		expect(calls.logs.some((l) => /stopped after repeated no-progress failure on attempt 2/.test(l))).toBe(true);
		expect(calls.logs.some((l) => l.includes("stopped after repeated no-progress") && l.includes("[test-suspect:"))).toBe(true);
		expect(calls.escalations.length).toBeGreaterThan(0);
		expect(calls.escalations[0]!.message).toContain("DETERMINISTIC TEST-SUSPECT SIGNAL");
		expect(calls.escalations[0]!.message).toContain("re-author the RED");
		expect(calls.escalations[0]!.findings.some((f) => f.title.startsWith("test-suspect (deterministic)"))).toBe(true);
	}, 20_000);

	it("CONTROL: no still-red evidence (RED targets went green post-impl) carries NO advisory", async () => {
		// RED-gen red (accepted), post-red-oracle GREEN on both attempts — the
		// gate failure alone recurs (a genuine product defect, not a test defect).
		redSeq("red", "green", "green");
		gateAlwaysFails();
		const { ctx, calls } = mkCtx();

		await (implementationStage as Stage).run(mkState(), ctx);

		expect(calls.logs.some((l) => /stopped after repeated no-progress failure on attempt 2/.test(l))).toBe(true);
		expect(calls.logs.some((l) => l.includes("[test-suspect:"))).toBe(false);
		expect(calls.escalations.length === 0 || !calls.escalations[0]!.message.includes("DETERMINISTIC TEST-SUSPECT SIGNAL")).toBe(true);
		expect(calls.escalations.length === 0 || !calls.escalations[0]!.findings.some((f) => f.title.startsWith("test-suspect"))).toBe(true);
	}, 20_000);
});
