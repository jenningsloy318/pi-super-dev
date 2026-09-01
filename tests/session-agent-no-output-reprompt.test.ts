/**
 * Regression for the BDD no-doc failure: a doc writer can return from its first
 * turn without calling structured_output at all. The session backend should not
 * immediately hand that empty result to the outer gate; it should issue one
 * same-session, tool-only corrective prompt so the agent can use the context it
 * already read and produce the renderable control object.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const sdk = vi.hoisted(() => {
	let promptCalls: string[] = [];
	let createOpts: Record<string, unknown> | undefined;
	let structuredTool: { execute: (id: string, params: Record<string, unknown>) => Promise<unknown> } | undefined;
	const output = {
		title: "BDD scenarios",
		date: "2026-08-02",
		source: "01-requirements.md",
		features: [{ name: "Analytics", scenarios: [{ id: "001", title: "page view", acRef: "AC-01", priority: "high", given: "a user", when: "route changes", then: "event is emitted" }] }],
		traceability: [{ acId: "AC-01", description: "page view", scenarios: ["SCENARIO-001"] }],
	};
	function reset() {
		promptCalls = [];
		createOpts = undefined;
		structuredTool = undefined;
	}
	function buildSession() {
		return {
			prompt: vi.fn(async (prompt: string) => {
				promptCalls.push(prompt);
				// First turn simulates the observed failure: returns normally but never
				// calls structured_output. Corrective turn must call it.
				if (promptCalls.length === 2) {
					await structuredTool?.execute("tool-1", output);
				}
			}),
			abort: vi.fn(() => {}),
			subscribe: vi.fn(() => () => {}),
			dispose: vi.fn(() => {}),
			messages: [],
		};
	}
	return {
		reset,
		buildSession,
		setCreateOpts: (opts: Record<string, unknown>) => {
			createOpts = opts;
			structuredTool = (opts.customTools as Array<{ name?: string; execute?: unknown }>).find((t) => t.name === "structured_output") as typeof structuredTool;
		},
		promptCalls: () => promptCalls,
		createOpts: () => createOpts,
		output: () => output,
	};
});

vi.mock("@earendil-works/pi-coding-agent", () => ({
	createAgentSession: vi.fn(async (opts: Record<string, unknown> = {}) => {
		sdk.setCreateOpts(opts);
		return { session: sdk.buildSession() };
	}),
	createCodingTools: vi.fn(() => []),
	defineTool: vi.fn((def: unknown) => def),
	getAgentDir: vi.fn(() => "/tmp/agentdir"),
	DefaultResourceLoader: vi.fn(function (this: { reload: () => Promise<void> }) {
		this.reload = async () => {};
	}),
	SessionManager: { inMemory: vi.fn(() => ({})) },
	SettingsManager: { create: vi.fn(() => ({})) },
	ModelRuntime: { create: vi.fn(async () => ({ getModel: vi.fn(() => undefined), getModels: vi.fn(() => []) })) },
}));
vi.mock("../src/agents.ts", () => ({ loadAgentPrompt: vi.fn(() => "SYSTEM-PROMPT") }));
vi.mock("../src/control.ts", async (importOriginal) => {
	// Mock hygiene (docs/testing-strategy.md class B): spread the ORIGINAL
	// module so new exports (e.g. DEFAULT_EMPTY_ARRAY_OK) stay real instead
	// of breaking this file whenever control.ts grows an export.
	const actual = await importOriginal<typeof import("../src/control.ts")>();
	return {
		...actual,
		extractControl: vi.fn(() => null),
		missingControlKeys: vi.fn((captured: Record<string, unknown> | null | undefined, keys: string[]) => {
			if (!captured) return keys;
			return keys.filter((k) => {
				const v = captured[k];
				return v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0);
			});
		}),
	};
});
vi.mock("../src/setup.ts", () => ({ sanitizeSlug: vi.fn((s: string) => s) }));
vi.mock("../src/safety.ts", () => ({ createSafetyExtensionFactory: vi.fn(() => () => ({ name: "safety", activate: () => ({}) })) }));
vi.mock("../src/render/super-dev-dir.ts", () => ({ getTracesDir: vi.fn(() => "/tmp/traces"), superDevEnv: vi.fn(() => undefined) }));

import { runAgentViaSession } from "../src/session-agent.ts";

describe("runAgentViaSession no-output corrective prompt", () => {
	beforeEach(() => sdk.reset());

	it("reprompts once in the same session when the first turn never calls structured_output", async () => {
		const events: string[] = [];
		const result = await runAgentViaSession({
			agent: "bdd-scenario-writer",
			id: "pipeline.bdd",
			prompt: "write BDD scenarios",
			cwd: "/tmp",
			controlKeys: ["title", "date", "source", "features", "traceability"],
			onProgress: { event: (m) => { events.push(m); }, text: () => {} },
		});

		expect(sdk.promptCalls()).toHaveLength(2);
		expect(sdk.promptCalls()[1]).toContain("Corrective Re-Prompt");
		expect(sdk.promptCalls()[1]).toContain("gate=required-structured-output");
		expect(sdk.promptCalls()[1]).toContain("ended without calling the required structured_output tool");
		expect(events).toContain("↻ pipeline.bdd: corrective re-prompt (no structured_output)");
		expect(result.error).toBeUndefined();
		expect(result.control).toEqual(sdk.output());
		expect(sdk.createOpts()).toBeDefined();
	});
});
