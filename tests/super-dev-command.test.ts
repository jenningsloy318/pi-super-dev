import { describe, it, expect, vi } from "vitest";

vi.mock("../src/pipeline.ts", () => ({
	runPipelineTask: vi.fn(async () => ({
		status: "success",
		specIdentifier: undefined,
		worktreePath: "/tmp",
		state: {},
		agentsSpawned: 0,
		failedStages: [],
		error: undefined,
	})),
}));

vi.mock("../src/workflow.ts", () => ({ runWorkflow: vi.fn(() => ({})) }));
vi.mock("../src/nodes.ts", () => ({}));
vi.mock("../src/stages/index.ts", () => ({ SUPER_DEV_WORKFLOW: {} }));

vi.mock("../src/pi-spawn.ts", () => ({
	abbreviatePath: vi.fn((p: string) => p),
	spawnAgent: vi.fn(async () => ({ text: "", control: null })),
}));

vi.mock("../src/render/live-stream.js", () => ({
	createLiveStream: vi.fn(() => ({
		sink: { phase: () => {}, log: () => {}, text: () => {}, stage: () => {}, userInput: () => {} },
		finalizeLive: () => {},
		flush: () => {},
		diskLogText: () => "",
		transcriptTail: () => [],
	})),
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
	getRunLogPath: vi.fn(() => ""),
	getConfig: vi.fn(() => ({})),
	superDevEnv: vi.fn((k: string) => process.env[k] || undefined),
}));

vi.mock("../src/render/reflection.ts", () => ({ runReflectionAsync: vi.fn(() => {}) }));
vi.mock("../src/tracking.ts", () => ({ setActiveTracker: vi.fn(() => {}) }));
vi.mock("@earendil-works/pi-tui", () => ({
	Container: class { addChild() {} },
	Text: class {},
}));

import activate, { parseSuperDevCommandArgs } from "../src/extension.ts";

interface CommandDef {
	description?: string;
	handler: (args: unknown, ctx: { ui: { notify: ReturnType<typeof vi.fn> } }) => Promise<void> | void;
}

function setupCommands() {
	const commands = new Map<string, CommandDef>();
	const sendUserMessage = vi.fn();
	const pi: Record<string, unknown> = {
		events: { on: vi.fn(() => () => {}) },
		registerTool: vi.fn(),
		registerCommand: vi.fn((name: string, def: CommandDef) => { commands.set(name, def); }),
		registerShortcut: vi.fn(),
		registerEntryRenderer: vi.fn(),
		getSessionName: vi.fn(() => ""),
		setSessionName: vi.fn(),
		appendEntry: vi.fn(),
		sendMessage: vi.fn(),
		sendUserMessage,
	};
	activate(pi as never);
	return { commands, sendUserMessage };
}

function commandCtx() {
	return { ui: { notify: vi.fn() } };
}

describe("parseSuperDevCommandArgs", () => {
	it("trims /super-dev args for the foreground-only command", () => {
		expect(parseSuperDevCommandArgs(" fix X ")).toEqual({ task: "fix X" });
	});

	it("treats non-leading --bg text as part of the task", () => {
		expect(parseSuperDevCommandArgs("fix --bg X")).toEqual({ task: "fix --bg X" });
	});
});

describe("/super-dev command dispatch", () => {
	it("sends a foreground-only super_dev tool instruction", async () => {
		const { commands, sendUserMessage } = setupCommands();
		const ctx = commandCtx();

		await commands.get("super-dev")!.handler("fix X", ctx);

		expect(ctx.ui.notify).not.toHaveBeenCalled();
		expect(sendUserMessage).toHaveBeenCalledTimes(1);
		const message = sendUserMessage.mock.calls[0][0] as string;
		expect(message).toContain("Use the super_dev tool");
		expect(message).toContain('"task": "fix X"');
		expect(message).not.toContain('"background"');
	});

	it("shows usage instead of dispatching when /super-dev has no task", async () => {
		const { commands, sendUserMessage } = setupCommands();
		const ctx = commandCtx();

		await commands.get("super-dev")!.handler("   ", ctx);

		expect(sendUserMessage).not.toHaveBeenCalled();
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Usage: /super-dev"), "info");
	});

	it("rejects removed background flags instead of dispatching", async () => {
		const { commands, sendUserMessage } = setupCommands();
		const ctx = commandCtx();

		await commands.get("super-dev")!.handler("--bg fix X", ctx);

		expect(sendUserMessage).not.toHaveBeenCalled();
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("removed"), "info");
	});

	it("does not register /super-dev-bg", () => {
		const { commands } = setupCommands();
		expect(commands.has("super-dev-bg")).toBe(false);
	});
});
