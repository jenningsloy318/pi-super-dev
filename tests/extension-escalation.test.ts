/**
 * Phase 6 / T6.5 (AC-29 + D-8): serialized execute() + run-dir capture.
 *
 * SCENARIO-059 — a second execute() while a run is in flight is REJECTED
 *   without clobbering the active singleton (the module-global run dir is not
 *   reset, the first run's input routing completes untouched).
 * SCENARIO-060 — a late reflection writes to the ORIGINATING run's files: run
 *   dirs are captured once at start; reflection/audit paths are computed from
 *   the threaded run dir, never re-read from the module global after an await.
 *
 * Harness mirrors tests/extension-inherit.test.ts: the heavy transitive graph of
 * src/extension.ts is mocked (pipeline/workflow/nodes/stages/session-agent/
 * pi-tui/node:os homedir → a fake ~/.super-dev), while super-dev-dir.ts,
 * reflection.ts and cleanup.ts stay REAL so the path threading is observed
 * against genuine filesystem state.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, readFileSync, writeFileSync, existsSync, statSync, rmSync } from "node:fs";
import { join } from "node:path";

const { FAKE_HOME, FAKE_SUPER_DEV } = vi.hoisted(() => {
	const home = "/tmp/sd-ext-escalation-home";
	return { FAKE_HOME: home, FAKE_SUPER_DEV: home + "/.super-dev" };
});

/** Gate for the in-flight runPipelineTask promise (kept reachable from mocks). */
const gate = vi.hoisted(() => ({
	started: false,
	resolveRun: (_summary: unknown) => {},
}));

/** Gate for the reflection agent promise (capture the prompt; settle on demand). */
const agentGate = vi.hoisted(() => ({
	prompt: "",
	resolveAgent: (_v: unknown) => {},
	rejectAgent: (_e: unknown) => {},
}));

vi.mock("node:os", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:os")>();
	// homedir → fake home so the REAL super-dev-dir.ts resolves under /tmp;
	// tmpdir stays real (temp fixtures elsewhere keep working).
	return { ...actual, homedir: () => FAKE_HOME };
});

vi.mock("../src/pipeline.ts", () => ({
	runPipelineTask: vi.fn((_task: string, _options: Record<string, unknown> = {}) =>
		new Promise((resolve) => {
			gate.started = true;
			gate.resolveRun = resolve;
		})),
}));

// Stub the re-exported engine graph so activate() loads without the engine.
vi.mock("../src/workflow.ts", () => ({ runWorkflow: vi.fn(() => ({})) }));
vi.mock("../src/nodes.ts", () => ({}));
vi.mock("../src/stages/index.ts", () => ({ SUPER_DEV_WORKFLOW: {} }));

vi.mock("../src/session-agent.ts", () => ({
	runAgentViaSession: vi.fn((opts: { prompt: string }) =>
		new Promise((resolve, reject) => {
			agentGate.prompt = opts.prompt;
			agentGate.resolveAgent = resolve;
			agentGate.rejectAgent = reject;
		})),
}));

vi.mock("@earendil-works/pi-tui", () => ({
	Container: class { addChild() {} },
	Text: class {},
	Markdown: class {},
	visibleWidth: (s: string) => s.length,
}));

import activate from "../src/extension.ts";
import { getActiveRun } from "../src/extension.ts";
import {
	startRun,
	auditAppend,
	runLogPathFor,
	auditPathFor,
	reflectionPathFor,
	getRunDir,
} from "../src/render/super-dev-dir.ts";
import { runReflectionAsync } from "../src/render/reflection.ts";
import * as cleanupMod from "../src/render/cleanup.ts";

const SUMMARY = {
	status: "success",
	specIdentifier: undefined,
	worktreePath: "/tmp",
	state: {},
	agentsSpawned: 0,
	failedStages: [],
	error: undefined,
};

function setupTool() {
	const toolDefHolder: { def?: { execute: (...args: unknown[]) => Promise<unknown> } } = {};
	const pi: Record<string, unknown> = {
		events: { on: vi.fn(() => () => {}) },
		on: vi.fn(() => () => {}), // v0.3.60 R1: typed pi.on channel
		registerTool: vi.fn((def: unknown) => { toolDefHolder.def = def as typeof toolDefHolder.def; }),
		registerCommand: vi.fn(),
		registerShortcut: vi.fn(),
		registerEntryRenderer: vi.fn(),
		getSessionName: vi.fn(() => ""),
		setSessionName: vi.fn(),
		appendEntry: vi.fn(),
		sendMessage: vi.fn(),
		sendUserMessage: vi.fn(),
	};
	activate(pi as never);
	return { execute: toolDefHolder.def!.execute };
}

const until = async (pred: () => boolean, ms = 3_000) => {
	const deadline = Date.now() + ms;
	while (!pred()) {
		if (Date.now() > deadline) throw new Error("condition not reached in time");
		await new Promise((r) => setTimeout(r, 10));
	}
};

describe("AC-29 (SCENARIO-059): a second execute while a run is in flight is rejected without clobbering", () => {
	beforeEach(() => {
		mkdirSync(FAKE_SUPER_DEV, { recursive: true });
		gate.started = false;
	});
	afterEach(async () => {
		// Drain any in-flight run so module state (inFlight) is clean for the
		// next test.
		if (gate.started) {
			gate.resolveRun(SUMMARY);
			await new Promise((r) => setTimeout(r, 20));
		}
		rmSync(FAKE_HOME, { recursive: true, force: true });
	});

	it("returns an isError refusal naming the active run and never touches the singleton", async () => {
		const { execute } = setupTool();
		const first = execute("call-1", { task: "run one" }, undefined, undefined, { mode: undefined });
		await until(() => gate.started);
		const runA = getActiveRun();
		expect(runA).not.toBeNull();

		const second = (await execute("call-2", { task: "run two" }, undefined, undefined, { mode: undefined })) as {
			isError: boolean;
			content: Array<{ type: "text"; text: string }>;
		};
		expect(second.isError).toBe(true);
		expect(second.content[0]?.text).toContain("a super-dev run is already active");

		// The active singleton is NOT discarded and the first run's input routing
		// still works — the refusal clobbered nothing.
		expect(getActiveRun()).toBe(runA);
		expect(runA!.push("mid-run steering")).not.toBeNull();
		expect(runA!.drain()).toEqual(["mid-run steering"]);

		gate.resolveRun(SUMMARY);
		await first;
	});

	it("the guard clears in finally — a THIRD execute after the first run completes proceeds normally", async () => {
		const { execute } = setupTool();
		const first = execute("call-a", { task: "run one" }, undefined, undefined, { mode: undefined });
		await until(() => gate.started);
		const second = (await execute("call-b", { task: "run two" }, undefined, undefined, { mode: undefined })) as { isError: boolean };
		expect(second.isError).toBe(true);

		gate.resolveRun(SUMMARY);
		await first;

		gate.started = false;
		const third = execute("call-c", { task: "run three" }, undefined, undefined, { mode: undefined });
		await until(() => gate.started);
		gate.resolveRun(SUMMARY);
		const result = (await third) as { isError: boolean };
		expect(result.isError).toBe(false); // NOT refused — inFlight cleared
	}, 10_000);

	it("D-8: the doRun finally runs updateStats + cleanupOldRuns best-effort", async () => {
		const statsSpy = vi.spyOn(cleanupMod, "updateStats").mockImplementation(() => {});
		const cleanupSpy = vi.spyOn(cleanupMod, "cleanupOldRuns").mockImplementation(() => ({ deletedRuns: 0, deletedTraces: 0 }));
		try {
			const { execute } = setupTool();
			const first = execute("call-d8", { task: "run one" }, undefined, undefined, { mode: undefined });
			await until(() => gate.started);
			statsSpy.mockClear();
			cleanupSpy.mockClear();
			gate.resolveRun(SUMMARY);
			await first;
			expect(statsSpy).toHaveBeenCalledTimes(1);
			expect(cleanupSpy).toHaveBeenCalledTimes(1);
		} finally {
			statsSpy.mockRestore();
			cleanupSpy.mockRestore();
		}
	});
});

describe("AC-29 path threading: run-dir path-for helpers + threaded auditAppend", () => {
	beforeEach(() => mkdirSync(FAKE_SUPER_DEV, { recursive: true }));
	afterEach(() => rmSync(FAKE_HOME, { recursive: true, force: true }));

	it("runLogPathFor/auditPathFor/reflectionPathFor resolve inside the given run dir", () => {
		const runDir = join(FAKE_SUPER_DEV, "runs", "runX");
		expect(runLogPathFor(runDir)).toBe(join(runDir, "run.log"));
		expect(auditPathFor(runDir)).toBe(join(runDir, "audit.jsonl"));
		expect(reflectionPathFor(runDir)).toBe(join(runDir, "reflection.md"));
	});

	it("auditAppend(entry, runDir) prefers the threaded dir over the module-global run dir (and writes 0600)", () => {
		const runA = join(FAKE_SUPER_DEV, "runs", "runA");
		const runB = join(FAKE_SUPER_DEV, "runs", "runB");
		mkdirSync(runA, { recursive: true });
		mkdirSync(runB, { recursive: true });
		startRun(); // module-global currentRunDir = a fresh ts dir
		expect(getRunDir()).not.toBe(runA);
		auditAppend({ stage: "threaded" }, runA);
		expect(existsSync(auditPathFor(runA))).toBe(true);
		expect(existsSync(auditPathFor(runB))).toBe(false);
		const line = JSON.parse(readFileSync(auditPathFor(runA), "utf8").trim()) as { stage: string };
		expect(line.stage).toBe("threaded");
		expect(statSync(auditPathFor(runA)).mode & 0o777).toBe(0o600);
	});
});

describe("AC-29 (SCENARIO-060): a late reflection writes to the ORIGINATING run's files", () => {
	beforeEach(() => mkdirSync(FAKE_SUPER_DEV, { recursive: true }));
	afterEach(() => rmSync(FAKE_HOME, { recursive: true, force: true }));

	it("reflection paths are captured at entry — run B starting mid-flight never redirects run A", async () => {
		// Run A exists with an audit trail.
		const runA = join(FAKE_SUPER_DEV, "runs", "runA");
		mkdirSync(runA, { recursive: true });
		writeFileSync(auditPathFor(runA), JSON.stringify({ stage: "requirements", gate: { pass: false, errors: ["x"] } }) + "\n");

		runReflectionAsync(runA); // gated reflection agent — still in flight
		await until(() => agentGate.prompt.length > 0);
		// The task's audit path was resolved from run A AT ENTRY.
		expect(agentGate.prompt).toContain(auditPathFor(runA));
		expect(agentGate.prompt).toContain("Reflection summary");

		// Run B starts BEFORE run A's reflection agent finishes.
		const runB = startRun();
		expect(runB).not.toBe(runA);

		// The reflection agent for run A completes AFTER run B started — its
		// audit failure line must land under run A's directory, never run B's.
		agentGate.rejectAgent(new Error("reflection agent crashed"));
		await until(() => readFileSync(auditPathFor(runA), "utf8").includes("reflection"));
		const lines = readFileSync(auditPathFor(runA), "utf8").trim().split("\n");
		const last = JSON.parse(lines[lines.length - 1]!) as { stage: string; error: string };
		expect(last.stage).toBe("reflection");
		expect(last.error).toContain("reflection agent crashed");
		expect(existsSync(auditPathFor(runB))).toBe(false);
	}, 10_000);
});
