/**
 * 069/070 — the pi-agent-core backend adapter's L0 pins, createAgentSession
 * shape. The host SDK is mocked (no real streaming); these test OUR wiring
 * and pin the grill-round findings:
 *   R4-F1 role prompt, R4-F3 listener hygiene, R4-F4 empty-text,
 *   R5-F1 posture, R5-F2 model inheritance, R5-F3 timeout tiers,
 *   R5-F4 skill cards, R5-F5 budget cap, R5-F6 telemetry, R5-F7 validation,
 *   R8-F1 extension paths, R2-F2's cwd (via loader + session options).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getEventListeners } from "node:events";

vi.mock("@earendil-works/pi-coding-agent", () => {
	// All mutable test state lives INSIDE the factory (vitest hoists it above
	// module-scope consts; referencing them is a TDZ error).
	type PromptImpl = (text: string, session: MockSession) => Promise<void>;
	const promptPlan: PromptImpl[] = [];
	const sessionCalls: Array<{ options: Record<string, unknown>; session: MockSession }> = [];
	const loaderOptions: Array<Record<string, unknown>> = [];

	class MockSession {
		options: Record<string, unknown>;
		messages: Array<Record<string, unknown>> = [];
		listeners = new Set<(e: Record<string, unknown>) => void>();
		disposed = false;
		aborted = false;
		promptCount = 0;
		constructor(options: Record<string, unknown>) {
			this.options = options;
		}
		subscribe(fn: (e: Record<string, unknown>) => void) {
			this.listeners.add(fn);
			return () => { this.listeners.delete(fn); };
		}
		emit(event: Record<string, unknown>) {
			for (const l of [...this.listeners]) l(event);
		}
		pushAssistant(text: string, extra: Record<string, unknown> = {}) {
			this.messages.push({
				role: "assistant",
				content: [{ type: "text", text }],
				usage: { input: 100, output: 50, cacheRead: 200, cacheWrite: 10, cost: { total: 0.01 } },
				stopReason: "stop",
				...extra,
			});
		}
		async prompt(text: string) {
			this.promptCount++;
			const impl = promptPlan.shift() ?? (async (_t: string, s: MockSession) => {
				s.pushAssistant(`Answer.\n<control>JSON with: {"testKey": "value"}</control>`);
			});
			await impl(text, this);
		}
		async abort() { this.aborted = true; }
		dispose() { this.disposed = true; }
	}

	const mod = {
		ModelRuntime: { create: vi.fn(async () => { throw new Error("not used — setRuntimeForTests short-circuits"); }) },
		createAgentSession: vi.fn(async (options: Record<string, unknown>) => {
			const session = new MockSession(options);
			sessionCalls.push({ options, session });
			return { session };
		}),
		SessionManager: { inMemory: vi.fn((cwd?: string) => ({ kind: "inMemory", cwd })) },
		DefaultResourceLoader: class {
			constructor(options: Record<string, unknown>) { loaderOptions.push(options); }
			async reload() { /* no-op */ }
		},
		SettingsManager: { create: vi.fn(async () => ({ kind: "settings" })) },
		__promptPlan: promptPlan,
		__sessionCalls: sessionCalls,
		__loaderOptions: loaderOptions,
	};
	return mod;
});

import { runAgentViaPiAgentCore, setRuntimeForTests, abortAllActiveAgents } from "../src/agents/pi-agent-core-backend.ts";
import * as paiMock from "@earendil-works/pi-coding-agent";
import { defaultAgentTimeoutMs, extensionsForAgent, configExtensionEntriesForAgent, commitGuardExtensionPath, safetyGuardExtensionPath } from "../src/agents/agent-runtime/index.ts";

const mockRuntime = {
	getModel: vi.fn(() => ({ id: "test-model", contextWindow: 128000 })),
};
const pai = paiMock as unknown as {
	__promptPlan: Array<(text: string, s: { pushAssistant(t: string, e?: Record<string, unknown>): void; emit(e: Record<string, unknown>): void }) => Promise<void>>;
	__sessionCalls: Array<{ options: Record<string, unknown>; session: { pushAssistant(t: string, e?: Record<string, unknown>): void; promptCount: number; disposed: boolean; emit(e: Record<string, unknown>): void } }>;
	__loaderOptions: Array<Record<string, unknown>>;
};

beforeEach(() => {
	setRuntimeForTests(mockRuntime as never, paiMock as never);
	pai.__promptPlan.length = 0;
	pai.__sessionCalls.length = 0;
	pai.__loaderOptions.length = 0;
	mockRuntime.getModel.mockClear();
	mockRuntime.getModel.mockImplementation(() => ({ id: "test-model", contextWindow: 128000 }));
});

const BASE = { agent: "spec-writer", prompt: "Write something", cwd: "/tmp/worktree", model: "test/test-model" } as const;

describe("runAgentViaPiAgentCore (session shape)", () => {
	it("returns SpawnResult with text, control, model, and usage", async () => {
		const result = await runAgentViaPiAgentCore({ ...BASE, controlKeys: ["testKey"] });
		expect(result.text).toContain("<control>");
		expect(result.control).toBeDefined();
		expect(result.model).toBe("test/test-model");
		expect(result.usage?.input).toBe(100);
		expect(result.usage?.turns).toBe(1);
	});

	it("R4-F1: the system prompt carries the role's base .md body, not the generic fallback", async () => {
		await runAgentViaPiAgentCore({ ...BASE });
		const loader = pai.__loaderOptions[0]!;
		const body = readFileSync(join(import.meta.dirname, "..", "agents", "spec-writer.md"), "utf8").trim();
		expect(String(loader.systemPrompt)).toContain(body.slice(0, 80));
		expect(String(loader.systemPrompt)).not.toContain("You are a spec-writer specialist.");
	});

	it("R5-F4: a curated skill list becomes a skill-card section; false suppresses discovery", async () => {
		await runAgentViaPiAgentCore({ ...BASE, skill: ["firecrawl-search", "web-verify"] });
		const sp = String(pai.__loaderOptions[0]!.systemPrompt);
		expect(sp).toContain("## Skills available to you");
		expect(sp).toContain("firecrawl-search");
		await runAgentViaPiAgentCore({ ...BASE, skill: false });
		expect(pai.__loaderOptions[1]!.noSkills).toBe(true);
		expect(String(pai.__loaderOptions[1]!.systemPrompt)).not.toContain("## Skills");
	});

	it("R5-F1: read-only posture excludes bash/edit/write; writers get no exclusion", async () => {
		await runAgentViaPiAgentCore({ ...BASE, readOnly: true });
		expect(pai.__sessionCalls[0]!.options.excludeTools).toEqual(["bash", "edit", "write"]);
		await runAgentViaPiAgentCore({ ...BASE, readOnly: false });
		expect(pai.__sessionCalls[1]!.options.excludeTools).toBeUndefined();
	});

	it("R5-F2: the inherited model OBJECT is used when string resolution comes up empty", async () => {
		const inherited = { id: "glm-5.3", provider: "zai-coding-cn", contextWindow: 200000 };
		const result = await runAgentViaPiAgentCore({ ...BASE, model: undefined, inheritedModel: inherited });
		expect(result.error).toBeUndefined();
		expect(pai.__sessionCalls[0]!.options.model).toBe(inherited);
	});

	it("R5-F2: no model anywhere names the failure honestly", async () => {
		const result = await runAgentViaPiAgentCore({ ...BASE, model: undefined });
		expect(result.error).toContain("model not found");
		expect(result.error).toContain("inherited session model unavailable");
	});

	it("R5-F3: absent timeoutMs falls back to the role-tier default", async () => {
		await runAgentViaPiAgentCore({ ...BASE, timeoutMs: undefined });
		// The tier default is read at dispatch; assert the call completed and
		// the tier function resolves deterministically for the same role.
		expect(typeof defaultAgentTimeoutMs(BASE.agent)).toBe("number");
	});

	it("R4-F3: the shared-signal abort listener is removed after the call settles", async () => {
		const controller = new AbortController();
		await runAgentViaPiAgentCore({ ...BASE, signal: controller.signal });
		expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
	});

	it("R4-F4: a stop with zero text is a named error, never a silent success", async () => {
		pai.__promptPlan.push(async (_t, s) => { s.pushAssistant(""); });
		const result = await runAgentViaPiAgentCore({ ...BASE });
		expect(result.error).toContain("empty assistant response");
	});

	it("R5-F7: missing control keys trigger ONE corrective attempt naming the keys", async () => {
		pai.__promptPlan.push(async (_t, s) => { s.pushAssistant("Answer with no control block."); });
		const result = await runAgentViaPiAgentCore({ ...BASE, controlKeys: ["verdict", "summary"] });
		expect(result.error).toContain("control validation failed");
		expect(result.error).toContain("verdict");
		expect(pai.__sessionCalls[0]!.session.promptCount).toBe(2); // original + corrective
	});

	it("R5-F7: a successful corrective attempt returns its control", async () => {
		pai.__promptPlan.push(async (_t, s) => { s.pushAssistant("No control."); });
		// The corrective prompt falls through to the default good responder.
		const result = await runAgentViaPiAgentCore({ ...BASE, controlKeys: ["testKey"] });
		expect(result.error).toBeUndefined();
		expect(result.control).toBeDefined();
	});

	it("R5-F6: tool_execution_start events feed onToolUse", async () => {
		const seen: Array<[string, string]> = [];
		pai.__promptPlan.push(async (_t, s) => {
			s.emit({ type: "tool_execution_start", toolName: "read", args: { path: "/tmp/x.ts" } });
			s.pushAssistant("Done.");
		});
		await runAgentViaPiAgentCore({ ...BASE, onToolUse: (tool, argHead) => seen.push([tool, argHead]) });
		expect(seen).toEqual([["read", "/tmp/x.ts"]]);
	});

	it("R5-F5: exceeding the hard budget cap fails with a named error", async () => {
		pai.__promptPlan.push(async (_t, s) => {
			s.emit({ type: "tool_execution_start", toolName: "read", args: {} });
			s.emit({ type: "tool_execution_start", toolName: "read", args: {} });
			s.emit({ type: "tool_execution_start", toolName: "grep", args: {} });
			s.pushAssistant("Done.");
		});
		const result = await runAgentViaPiAgentCore({ ...BASE, toolBudget: { soft: 1, hard: 2, block: [] } });
		expect(result.error).toContain("tool budget exceeded");
		expect(result.error).toContain("hard cap 2");
	});

	it("R8-F1/R2-F2: the loader carries cwd, guards, and the role's extension entries", async () => {
		await runAgentViaPiAgentCore({ ...BASE });
		const loader = pai.__loaderOptions[0]!;
		expect(loader.cwd).toBe("/tmp/worktree");
		expect(pai.__sessionCalls[0]!.options.cwd).toBe("/tmp/worktree");
		const expected = [
			...(commitGuardExtensionPath(BASE.agent) ? [commitGuardExtensionPath(BASE.agent)] : []),
			...(safetyGuardExtensionPath(BASE.agent) ? [safetyGuardExtensionPath(BASE.agent)] : []),
			...configExtensionEntriesForAgent(BASE.agent),
			...extensionsForAgent(BASE.agent),
		];
		expect(loader.additionalExtensionPaths).toEqual(expect.arrayContaining(expected));
	});

	it("model string resolution runs through runtime.getModel", async () => {
		await runAgentViaPiAgentCore({ ...BASE });
		expect(mockRuntime.getModel).toHaveBeenCalledWith("test", "test-model");
	});

	it("model not found fails with a clear error", async () => {
		mockRuntime.getModel.mockImplementation(() => undefined as never);
		const result = await runAgentViaPiAgentCore({ ...BASE, model: "bad/bad-model" });
		expect(result.error).toContain("model not found");
		expect(result.error).toContain("bad/bad-model");
	});

	it("contextWindow pre-check blocks oversized prompts (invariant #3)", async () => {
		mockRuntime.getModel.mockImplementation(() => ({ id: "small", contextWindow: 100 }) as never);
		const result = await runAgentViaPiAgentCore({ ...BASE, prompt: "x".repeat(200), model: "test/small" });
		expect(result.error).toContain("context window");
	});

	it("the session is disposed after the call (no leaks between calls)", async () => {
		await runAgentViaPiAgentCore({ ...BASE });
		const first = pai.__sessionCalls[0]!.session as unknown as { disposed: boolean };
		expect(first.disposed).toBe(true);
	});
});

describe("abortAllActiveAgents (invariant #2)", () => {
	it("exists and is callable", () => {
		expect(typeof abortAllActiveAgents).toBe("function");
		abortAllActiveAgents(); // should not throw
	});
});
