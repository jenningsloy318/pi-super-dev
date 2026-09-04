/**
 * Phase 3 (Feature 3) — typed registerEntryRenderer (RED→GREEN tests).
 *
 * AC-09 → SCENARIO-014 (native transcript-card renderers are registered
 *          DIRECTLY through the typed public `pi.registerEntryRenderer` API —
 *          the `pi as unknown as { registerEntryRenderer?: … }` capability cast
 *          is GONE), and the durable run-card rendering behavior is preserved;
 *          SCENARIO-015 (a failure during renderer registration is swallowed by
 *          the best-effort try/catch guard and activation continues without
 *          aborting the run).
 *
 * Harness mirrors tests/extension-inherit.test.ts: the heavy transitive import
 * graph of src/extension.ts (pipeline / workflow engine / node algebra / render
 * modules / pi-tui Container+Text) is mocked so the REAL `activate(pi)` runs
 * without a model or a TUI, and the registered entry renderer + commands are
 * observed directly.
 */
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// The exact source under test is asserted (requireNotContains / requireContains)
// so the removal of the capability cast is enforced as a regression gate that
// cannot be silently reintroduced (the spec's recommended Phase-3 assertion).
const EXTENSION_SRC = readFileSync(
	fileURLToPath(new URL("../src/extension.ts", import.meta.url)),
	"utf8",
);

// The pi-tui Container/Text mocks capture every added child (the renderer builds
// a Container of Text children) so the preserved rendering behavior is verified
// end-to-end without pulling in the real TUI.
const tui = vi.hoisted(() => {
	const created: Array<{ kind: "Container" } | { kind: "Text"; text: string }> = [];
	return {
		reset: () => { created.length = 0; },
		record: (c: { kind: "Container" } | { kind: "Text"; text: string }) => { created.push(c); },
		created: () => created,
	};
});

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

// Re-exports in extension.ts would otherwise pull in the real engine graph.
vi.mock("../src/workflow.ts", () => ({ runWorkflow: vi.fn(() => ({})) }));
vi.mock("../src/nodes.ts", () => ({}));
vi.mock("../src/stages/index.ts", () => ({ SUPER_DEV_WORKFLOW: {} }));

vi.mock("../src/agents/agent-runtime.ts", async (importOriginal) => ({
	...await importOriginal<typeof import("../src/agents/agent-runtime.ts")>(),
	abbreviatePath: vi.fn((p: string) => p),
	spawnAgent: vi.fn(async () => ({ text: "", control: null })),
}));

vi.mock("../src/render/live-stream.js", () => ({
	createLiveStream: vi.fn(() => ({
		sink: { phase: () => {}, log: () => {}, text: () => {}, stage: () => {} },
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
	startRun: vi.fn(() => "runs/test-run"),
	// AC-29 (Phase 6): run-dir path-for helper threaded from the captured dir.
	runLogPathFor: vi.fn(() => ""),
	getRunLogPath: vi.fn(() => ""),
	getConfig: vi.fn(() => ({})),
	superDevEnv: vi.fn((k: string) => process.env[k] || undefined),
}));

vi.mock("../src/render/reflection.ts", () => ({ runReflectionAsync: vi.fn(() => {}) }));
vi.mock("../src/tracking.ts", () => ({ setActiveTracker: vi.fn(() => {}) }));

vi.mock("@earendil-works/pi-tui", () => ({
	Container: class {
		children: unknown[] = [];
		addChild(c: unknown) { this.children.push(c); }
	},
	Text: class {
		text: string;
		constructor(text: string) { this.text = text; tui.record({ kind: "Text", text }); }
	},
}));

import activate from "../src/extension.ts";

interface CapturedRenderer {
	customType: string;
	renderer: (...args: unknown[]) => unknown;
}

function setup(opts: { registerEntryRendererThrows?: boolean } = {}) {
	const registerEntryRenderer: CapturedRenderer[] = [];
	const registerCommand: string[] = [];
	const pi: Record<string, unknown> = {
		events: { on: vi.fn(() => () => {}) },
		on: vi.fn(() => () => {}), // v0.3.60 R1: typed pi.on channel
		registerTool: vi.fn(),
		registerCommand: vi.fn((name: string) => { registerCommand.push(name); }),
		registerShortcut: vi.fn(),
		registerEntryRenderer: opts.registerEntryRendererThrows
			? vi.fn(() => { throw new Error("renderer registration unavailable"); })
			: vi.fn((customType: string, renderer: (...a: unknown[]) => unknown) => {
				registerEntryRenderer.push({ customType, renderer });
			}),
		getSessionName: vi.fn(() => ""),
		setSessionName: vi.fn(),
		appendEntry: vi.fn(),
		sendMessage: vi.fn(),
		sendUserMessage: vi.fn(),
	};
	activate(pi as never);
	return { registerEntryRenderer, registerCommand };
}

describe("Phase 3 (Feature 3 / AC-09) — typed registerEntryRenderer", () => {
	describe("SCENARIO-014: the renderer is registered through the typed public API (no capability cast)", () => {
		it("the source no longer declares the `piWithRenderer` capability alias", () => {
			expect(EXTENSION_SRC).not.toContain("piWithRenderer");
		});

		it("the source no longer casts `pi` through an unsafe `as unknown as` capability type", () => {
			expect(EXTENSION_SRC).not.toContain("as unknown as");
		});

		it("the source no longer declares the narrow `registerEntryRenderer?:` capability shape", () => {
			expect(EXTENSION_SRC).not.toMatch(/registerEntryRenderer\?:/);
		});

		it('the source calls the typed public API directly for the run renderer', () => {
			expect(EXTENSION_SRC).toContain('pi.registerEntryRenderer("super-dev-run"');
		});

		it("activate(pi) registers native entry renderers for run events and accepted runtime instructions", () => {
			const { registerEntryRenderer } = setup();
			expect(registerEntryRenderer.map((r) => r.customType)).toEqual(expect.arrayContaining(["super-dev-instruction", "super-dev-run"]));
			expect(registerEntryRenderer.map((r) => r.customType)).not.toContain("super-dev-summary");
			expect(typeof registerEntryRenderer.find((r) => r.customType === "super-dev-instruction")?.renderer).toBe("function");
			expect(typeof registerEntryRenderer.find((r) => r.customType === "super-dev-run")?.renderer).toBe("function");
		});

		it("the registered run renderer renders a durable foreground run transcript card", () => {
			tui.reset();
			const { registerEntryRenderer } = setup();
			const { renderer } = registerEntryRenderer.find((r) => r.customType === "super-dev-run")!;
			const theme: { bold: (t: string) => string; fg: (c: string, t: string) => string } = {
				bold: (t) => `*${t}*`,
				fg: (_c, t) => t,
			};
			const out = renderer(
				{ data: { status: "started", task: "fix X", at: 1_779_999_200_000 } },
				{ expanded: true },
				theme,
			) as { children: Array<{ text: string }> };
			expect(out).toBeTruthy();
			expect(Array.isArray(out.children)).toBe(true);
			const texts = out.children.map((c) => c.text);
			expect(texts[0]).toContain("super-dev run started");
			expect(texts[0]).not.toContain("background");
			expect(texts[1]).toBe("fix X");
		});
	});

	describe("SCENARIO-015: a renderer-registration failure degrades gracefully", () => {
		it("a thrown error inside registerEntryRenderer is swallowed and activation does not throw", () => {
			expect(() => setup({ registerEntryRendererThrows: true })).not.toThrow();
		});

		it("activation still registers the main `super-dev` command when the renderer throws (continues)", () => {
			const { registerCommand } = setup({ registerEntryRendererThrows: true });
			expect(registerCommand).toContain("super-dev");
			expect(registerCommand).not.toContain("super-dev-stop");
		});
	});
});
