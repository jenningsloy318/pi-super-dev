/**
 * Phase 1 (Feature 1) — extension.execute() main-session capture (RED→GREEN tests).
 *
 * AC-01 → SCENARIO-001 (capture ctx.model (full object) + ctx.thinkingLevel BEFORE
 *          runPipelineTask and thread them as additive `inheritedModelObject` /
 *          `inheritedThinking` defaults),
 *          SCENARIO-002 (an older/non-TUI ctx that exposes no model/thinking
 *          does not throw and threads undefined for both — byte-identical
 *          baseline), and the additive-only contract (an explicit `params.model`
 *          still wins downstream; the inherited tier is threaded as a DEFAULT,
 *          not a clobber).
 *
 * Harness: the heavy transitive import graph of src/extension.ts (the pipeline,
 * the workflow engine, the node algebra, the render / dashboard / live-stream /
 * reflection / tracking modules, and pi-tui's Container/Text) is mocked so the
 * REAL `activate(pi)` + the registered tool's `execute` run without a model or a
 * TUI, and the options handed to `runPipelineTask` are observed directly.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

/* vi.hoisted keeps the captured runPipelineTask options reachable from the mock
 * factory (which runs before top-level code). */
const cap = vi.hoisted(() => {
	let opts: Record<string, unknown> | null = null;
	return {
		setOpts: (o: Record<string, unknown>) => { opts = o; },
		opts: () => opts,
		reset: () => { opts = null; },
	};
});

vi.mock("../src/pipeline.ts", () => ({
	runPipelineTask: vi.fn(async (task: string, options: Record<string, unknown> = {}) => {
		cap.setOpts(options);
		if (task.includes("[emit-stage]")) {
			const progress = options.progress as { stage?: (info: Record<string, unknown>) => void; log?: (message: string) => void } | undefined;
			progress?.stage?.({ id: "requirements", label: "Requirements", status: "running" });
			progress?.log?.("background log still visible");
		}
		// Minimal valid RunSummary so formatSummary / handleStagnation don't throw:
		// no `__stagnated` on state → handleStagnation returns early.
		return {
			status: "success",
			specIdentifier: undefined,
			worktreePath: "/tmp",
			state: {},
			agentsSpawned: 0,
			failedStages: [],
			error: undefined,
		};
	}),
}));

// The re-exports in extension.ts (runWorkflow / SUPER_DEV_WORKFLOW / nodes) would
// otherwise pull in the real engine graph — stub them so the SUT is extension.ts.
vi.mock("../src/workflow.ts", () => ({ runWorkflow: vi.fn(() => ({})) }));
vi.mock("../src/nodes.ts", () => ({}));
vi.mock("../src/stages/index.ts", () => ({ SUPER_DEV_WORKFLOW: {} }));

vi.mock("../src/pi-spawn.ts", () => ({
	abbreviatePath: vi.fn((p: string) => p),
	spawnAgent: vi.fn(async () => ({ text: "", control: null })),
}));

vi.mock("../src/render/live-stream.js", () => ({
	createLiveStream: vi.fn((opts: { onUpdate?: (body: string) => void } = {}) => {
		let body = "";
		return {
			sink: {
				phase: (label: string) => { body += `▶ ${label}\n`; },
				log: (message: string) => { body += `${message}\n`; },
				text: (partial: string) => { body += `${partial}\n`; },
				stage: () => {},
			},
			finalizeLive: () => {},
			flush: () => { opts.onUpdate?.(body); },
			diskLogText: () => body,
			transcriptTail: () => [],
		};
	}),
}));

vi.mock("../src/render/dashboard.ts", () => ({
	packDashboardLines: vi.fn(() => []),
	padTruncate: vi.fn((s: string) => s),
	truncateActivity: vi.fn((s: string) => s),
	buildDashboardWidget: vi.fn(() => ({})),
	createDashboardWidgetFactory: vi.fn(() => () => ({})),
	buildResultComponent: vi.fn(() => ({})),
}));

vi.mock("../src/render/super-dev-dir.ts", () => ({
	ensureSuperDevDirs: vi.fn(() => {}),
	startRun: vi.fn(() => {}),
	// Empty path → the `if (logPath)` writeFileSync is skipped (no disk touch).
	getRunLogPath: vi.fn(() => ""),
	getConfig: vi.fn(() => ({})),
}));

vi.mock("../src/render/reflection.ts", () => ({ runReflectionAsync: vi.fn(() => {}) }));
vi.mock("../src/tracking.ts", () => ({ setActiveTracker: vi.fn(() => {}) }));
vi.mock("@earendil-works/pi-tui", () => ({
	Container: class { addChild() {} },
	Text: class {},
}));

import activate from "../src/extension.ts";

/** Build a minimal mock `pi` (ExtensionAPI) and capture the registered tool def. */
function setupTool() {
	const toolDefHolder: { def?: { execute: (...args: unknown[]) => Promise<unknown> } } = {};
	const pi: Record<string, unknown> = {
		events: { on: vi.fn(() => () => {}) },
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
	return { pi, execute: toolDefHolder.def!.execute };
}

describe("extension.execute() threads ctx.model/thinking into runPipelineTask as inherited defaults (AC-01 / SCENARIO-001)", () => {
	beforeEach(cap.reset);

	it("SCENARIO-001: a ctx with a live model + thinking level is captured and threaded as inheritedModelObject/inheritedThinking", async () => {
		const { execute } = setupTool();
		await execute(
			"call-1",
			{ task: "build the thing" },
			undefined, // signal — foreground blocking path (mode != tui)
			undefined, // onUpdate
			// ctx exposes the live main-session model id + thinking level.
			{ mode: undefined, model: { id: "gpt-4o", provider: "openai" }, thinkingLevel: "xhigh" },
		);
		const opts = cap.opts();
		expect(opts).toBeDefined();
		expect(opts!.inheritedModelObject).toEqual({ id: "gpt-4o", provider: "openai" });
		expect(opts!.inheritedThinking).toBe("xhigh");
	});

	it("the captured inherited tier is ADDITIVE: an explicit params.model is still passed AND the inherited defaults are threaded (no clobber at this seam)", async () => {
		const { execute } = setupTool();
		await execute(
			"call-2",
			{ task: "build the thing", model: "anthropic/claude-opus-4-5" },
			undefined,
			undefined,
			{ mode: undefined, model: { id: "gpt-4o", provider: "openai" }, thinkingLevel: "high" },
		);
		const opts = cap.opts();
		expect(opts).toBeDefined();
		// Explicit param still reaches the pipeline; the inherited tier is threaded
		// alongside as a DEFAULT (it loses downstream, but is present for specialists
		// that supply no explicit model).
		expect(opts!.model).toBe("anthropic/claude-opus-4-5");
		expect(opts!.inheritedModelObject).toEqual({ id: "gpt-4o", provider: "openai" });
		expect(opts!.inheritedThinking).toBe("high");
	});
	it("SCENARIO-003: ctx with TUI ui but missing mode still defaults to foreground", async () => {
		const { execute } = setupTool();
		const turnController = new AbortController();
		const res = await execute(
			"call-fg",
			{ task: "build the thing" },
			turnController.signal,
			undefined,
			{
				mode: undefined,
				ui: {
					setWidget: vi.fn(),
					setWorkingMessage: vi.fn(),
					setStatus: vi.fn(),
					notify: vi.fn(),
				},
			},
		) as { content?: Array<{ type: "text"; text: string }> };
		expect(res.content?.[0]?.text).toContain("super-dev pipeline complete");
		const opts = cap.opts();
		expect(opts).toBeDefined();
		expect(opts!.signal).toBe(turnController.signal);
	});
	it("SCENARIO-004: explicit background:true in TUI detaches with its own background signal", async () => {
		const { execute } = setupTool();
		const turnController = new AbortController();
		const res = await execute(
			"call-bg",
			{ task: "build the thing", background: true },
			turnController.signal,
			undefined,
			{
				mode: undefined,
				ui: {
					setWidget: vi.fn(),
					setWorkingMessage: vi.fn(),
					setStatus: vi.fn(),
					notify: vi.fn(),
				},
			},
		) as { content?: Array<{ type: "text"; text: string }> };
		await Promise.resolve();
		expect(res.content?.[0]?.text).toContain("started in the background");
		const opts = cap.opts();
		expect(opts).toBeDefined();
		expect(opts!.signal).toBeDefined();
		expect(opts!.signal).not.toBe(turnController.signal);
	});
	it("does not write stage progress to the TUI footer/status line", async () => {
		const { execute } = setupTool();
		const setStatus = vi.fn();
		await execute(
			"call-status",
			{ task: "[emit-stage] build the thing", background: false },
			undefined,
			undefined,
			{ mode: "tui", ui: { setWidget: vi.fn(), setWorkingMessage: vi.fn(), setStatus, notify: vi.fn() } },
		);
		expect(setStatus).not.toHaveBeenCalledWith("super-dev", expect.stringContaining("stages"));
		expect(setStatus).not.toHaveBeenCalledWith("super-dev", undefined);
	});
	it("keeps background TUI runs prompt-quiet while showing dashboard progress", async () => {
		const { execute } = setupTool();
		const ui = {
			setWidget: vi.fn(),
			setWorkingMessage: vi.fn(),
			setStatus: vi.fn(),
			notify: vi.fn(),
		};
		const onUpdate = vi.fn();
		const res = await execute(
			"call-bg-quiet",
			{ task: "[emit-stage] build the thing", background: true },
			new AbortController().signal,
			onUpdate,
			{ mode: "tui", ui },
		) as { content?: Array<{ type: "text"; text: string }> };
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(res.content?.[0]?.text).toContain("Live progress shows in the dashboard widget");
		expect(ui.setWidget).toHaveBeenCalledWith("super-dev", expect.anything(), { placement: "aboveEditor" });
		expect(ui.setWorkingMessage).not.toHaveBeenCalled();
		expect(ui.setStatus).not.toHaveBeenCalledWith("super-dev", expect.anything());
		expect(ui.setStatus).not.toHaveBeenCalledWith("super-dev-input", expect.anything());
		expect(onUpdate).not.toHaveBeenCalled();
	});
});

describe("extension.execute() degrades when the ctx exposes no model/thinking (AC-01 / SCENARIO-002)", () => {
	beforeEach(cap.reset);

	it("SCENARIO-002: a ctx with NO model/thinking does not throw and threads undefined for both inherited fields", async () => {
		const { execute } = setupTool();
		// Older / non-TUI ctx exposes neither model nor thinkingLevel.
		const res = await execute("call-3", { task: "build the thing" }, undefined, undefined, { mode: undefined });
		expect(res).toBeDefined();
		const opts = cap.opts();
		expect(opts).toBeDefined();
		// Byte-identical baseline: undefined inherited fields lose to every tier.
		expect(opts!.inheritedModelObject).toBeUndefined();
		expect(opts!.inheritedThinking).toBeUndefined();
	});

	it("SCENARIO-002: a ctx where ctx.model has no id (or is absent) threads no inherited model and never throws", async () => {
		const { execute } = setupTool();
		const res = await execute("call-4", { task: "build the thing" }, undefined, undefined, { mode: undefined, model: {} });
		expect(res).toBeDefined();
		const opts = cap.opts();
		expect(opts).toBeDefined();
		expect(opts!.inheritedModelObject).toBeUndefined();
	});
});
