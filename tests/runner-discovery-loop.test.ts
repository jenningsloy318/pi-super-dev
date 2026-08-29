/**
 * v0.3.30 Layer C wiring — the RED loop consults the runner cache / performs
 * ONE discovery agent call at the first fail-closed unknown, validates the
 * proposal, caches it, and threads it into runRedCheck (opts.runner).
 *
 * Loop harness mirrors tests/implementation-red-loop-edges.test.ts.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentCall, Budget, ControlObj, PipelineState, RunOptions, Stage, StageContext } from "../src/types.ts";

vi.mock("../src/build-runner.ts", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return {
		...actual,
		runRedCheck: vi.fn((): string => "unknown"),
		runBuildGate: vi.fn(() => ({ pass: true, inScopePass: false, ran: ["npm test"], errors: [], outOfScopeErrors: [] })),
		runDeliverableCheck: vi.fn(() => ({ pass: true, missing: [], ran: [] })),
		resetDeliverableCheckCache: vi.fn(() => {}),
	};
});
vi.mock("../src/render/render.ts", () => ({ renderAndWrite: vi.fn() }));

import { implementationStage } from "../src/stages/implementation.ts";
import { runRedCheck } from "../src/build-runner.ts";
const redCheck = runRedCheck as unknown as ReturnType<typeof vi.fn>;

let specDir = "";
let worktree = "";
beforeEach(() => {
	specDir = mkdtempSync(join(tmpdir(), "sd-loopdisc-"));
	worktree = mkdtempSync(join(tmpdir(), "sd-loopdisc-wt-")); // real dir — the discovery validator spawns inside it
	vi.clearAllMocks();
	redCheck.mockImplementation(() => "unknown");
});
afterEach(() => {
	try { rmSync(specDir, { recursive: true, force: true }); } catch { /* best effort */ }
	try { rmSync(worktree, { recursive: true, force: true }); } catch { /* best effort */ }
});

function mkState(): PipelineState {
	return {
		setup: {
			worktreePath: worktree,
			specDirectory: specDir,
			defaultBranch: "main",
			language: "gradle",
			isWebUi: false,
			specIdentifier: "loopdisc",
			worktreeCreated: false,
			initializedRepo: false,
		},
		classify: { taskType: "bug", uiScope: "none", language: "gradle", isWebUi: false },
		spec: { phases: [{ name: "P1", description: "discovery", deliverables: { requireTests: ["ATest"] } }] },
	} as unknown as PipelineState;
}

const TDD_CONTROL: ControlObj = { testFiles: ["src/__tests__/a.test.mjs"] };
const TAP_COMMAND = `node -e "console.log('TAP version 13\\nok 1 a\\nnot ok 2 b')"`;

function mkCtx(opts: { discoveryControl?: ControlObj | null } = {}): { ctx: StageContext; tddPrompts: string[]; discoveryCalls: AgentCall[]; redCheckOpts: Array<Record<string, unknown>>; logs: string[] } {
	const tddPrompts: string[] = [];
	const discoveryCalls: AgentCall[] = [];
	const redCheckOpts: Array<Record<string, unknown>> = [];
	const logs: string[] = [];
	const ctx: StageContext = {
		task: "",
		options: {} as RunOptions,
		state: {} as PipelineState,
		async helper() { return { value: {}, digest: "" } as never; },
		async agent(call: AgentCall) {
			if (call.agent === "tdd-guide") {
				tddPrompts.push(call.prompt);
				return { text: "", control: TDD_CONTROL };
			}
			if (call.id.includes("runner-discovery")) {
				discoveryCalls.push(call);
				return { text: "", control: opts.discoveryControl === undefined ? { command: TAP_COMMAND, resultFormat: "tap" } : opts.discoveryControl };
			}
			if (call.agent === "judge") return { text: "", control: null };
			if (call.agent === "code-reviewer") return { text: "", control: { verdict: "strong", summary: "ok" } };
			return { text: "", control: {} };
		},
		async parallel(cbs) { return Promise.all(cbs.map((c) => c())); },
		budget: { count: 0, check: () => true, spent() { this.count++; return true; } } satisfies Budget,
		log(message: string) { logs.push(message); },
		phase() {},
		events: new EventEmitter(),
		results: [],
	};
	// capture the third argument (opts) of every runRedCheck call
	redCheck.mockImplementation((_cwd: string, _targets: string[], redOpts?: Record<string, unknown>) => {
		redCheckOpts.push(redOpts ?? {});
		return "unknown";
	});
	return { ctx, tddPrompts, discoveryCalls, redCheckOpts, logs };
}

describe("v0.3.30 C — RED-loop discovery wiring", () => {
	it("at the first fail-closed unknown: ONE discovery agent call, validated, cached, threaded into runRedCheck opts", async () => {
		const { ctx, discoveryCalls, redCheckOpts, logs } = mkCtx();
		await (implementationStage as Stage).run(mkState(), ctx);
		expect(discoveryCalls.length).toBe(1);
		// the proposal was validated (machine verification) and cached
		const cachePath = join(specDir, "test-runner.json");
		expect(existsSync(cachePath)).toBe(true);
		const cached = JSON.parse(readFileSync(cachePath, "utf8")) as { command: string };
		expect(cached.command).toBe(TAP_COMMAND);
		// every runRedCheck AFTER the discovery carries the runner spec
		const withRunner = redCheckOpts.filter((o) => o && typeof o === "object" && "runner" in o);
		expect(withRunner.length).toBeGreaterThanOrEqual(1);
		expect(logs.join("\n")).toMatch(/runner-discovery/i);
	}, 120_000);

	it("a cached spec from a prior run is used WITHOUT any discovery agent call", async () => {
		const { ctx, discoveryCalls, redCheckOpts } = mkCtx();
		const { writeCachedTestRunner } = await import("../src/build-runner/runner-discovery.ts");
		writeCachedTestRunner(specDir, { version: 1, command: "./vendor/bin/pest", resultFormat: "tap", discoveredAt: "2026-08-29T00:00:00Z" });
		await (implementationStage as Stage).run(mkState(), ctx);
		expect(discoveryCalls.length).toBe(0);
		const withRunner = redCheckOpts.filter((o) => o && typeof o === "object" && "runner" in o);
		expect(withRunner.length).toBeGreaterThanOrEqual(1);
		expect((withRunner[0].runner as { command: string }).command).toBe("./vendor/bin/pest");
	}, 120_000);

	it("a rejected proposal (no agent control) is one-shot: no second discovery call, honest unknown continues", async () => {
		const { ctx, discoveryCalls } = mkCtx({ discoveryControl: null });
		const res = (await (implementationStage as Stage).run(mkState(), ctx)) as ControlObj;
		expect(discoveryCalls.length).toBe(1);
		expect(existsSync(join(specDir, "test-runner.json"))).toBe(false);
		expect(String(res?.status ?? "")).not.toBe("ok");
	}, 120_000);
});
