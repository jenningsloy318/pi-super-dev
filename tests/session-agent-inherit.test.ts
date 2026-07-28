/**
 * Phase 1 (Feature 1) — Session-backend model/thinking inheritance (RED tests).
 *
 * AC-04 → SCENARIO-007 (createAgentSession launched with the resolved model +
 *          thinkingLevel as creation options; the best-effort applyThinkingLevel
 *          is retained but guarded against double-application),
 *          SCENARIO-002 (an older/non-TUI context with no model/thinking
 *          degrades to current behavior — no throw),
 *          SCENARIO-008 (an inherited model id that cannot be resolved to a
 *          concrete model falls back to the SDK/settings default without
 *          throwing).
 *
 * Harness mirrors tests/session-backend-steer.test.ts: the pi SDK is mocked so
 * the REAL `runAgentViaSession` runs without a model, and the options handed to
 * `createAgentSession` (plus the session's `setThinkingLevel` calls) are
 * observed directly. These tests FAIL today because `runAgentViaSession` does
 * not yet pass `model` / `thinkingLevel` to `createAgentSession` (it only
 * best-effort calls applyThinkingLevel with the role-default-resolved level).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/* ------------------------------------------------------------------ *
 * Harness: mock the pi SDK + the local helpers session-agent.ts imports
 * so the REAL runAgentViaSession can be exercised without a model, and
 * the (not-yet-implemented) model/thinkingLevel creation options can be
 * observed. vi.hoisted keeps the captured options reachable from the
 * vi.mock factory (which runs before top-level code).
 * ------------------------------------------------------------------ */
const sdk = vi.hoisted(() => {
	let createOpts: Record<string, unknown> | null = null;
	let thinkingCalls: string[] = [];
	function buildSession(): Record<string, unknown> {
		return {
			prompt: vi.fn(async () => {}),
			abort: vi.fn(() => {}),
			subscribe: vi.fn(() => () => {}),
			dispose: vi.fn(() => {}),
			messages: [],
			// Spy used to assert no double-application of the thinking level.
			setThinkingLevel: vi.fn((level: string) => { thinkingCalls.push(level); }),
		};
	}
	return {
		buildSession,
		setCreateOpts: (o: Record<string, unknown>) => { createOpts = o; },
		createOpts: () => createOpts,
		thinkingCalls: () => thinkingCalls,
		reset: () => { createOpts = null; thinkingCalls = []; },
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
}));
vi.mock("../src/agents.ts", () => ({ loadAgentPrompt: vi.fn(() => "SYSTEM-PROMPT") }));
vi.mock("../src/control.ts", () => ({ extractControl: vi.fn(() => null) }));
vi.mock("../src/setup.ts", () => ({ sanitizeSlug: vi.fn((s: string) => s) }));
vi.mock("../src/safety.ts", () => ({
	createSafetyExtensionFactory: vi.fn(() => () => ({ name: "safety", activate: () => ({}) })),
}));
vi.mock("../src/render/super-dev-dir.ts", () => ({ getTracesDir: vi.fn(() => "/tmp/traces") }));

import * as SessionAgent from "../src/session-agent.ts";

const saveEnv = (...keys: string[]) => {
	const snapshot: Record<string, string | undefined> = {};
	for (const k of keys) snapshot[k] = process.env[k];
	return {
		clear: () => { for (const k of keys) delete process.env[k]; },
		restore: () => {
			for (const k of keys) {
				if (snapshot[k] === undefined) delete process.env[k];
				else process.env[k] = snapshot[k] as string;
			}
		},
	};
};

describe("runAgentViaSession passes resolved model + thinkingLevel to createAgentSession (AC-04 / SCENARIO-007)", () => {
	const env = saveEnv("SUPER_DEV_THINKING", "SUPER_DEV_MODEL");
	beforeEach(() => { env.clear(); sdk.reset(); });
	afterEach(env.restore);

	it("inherited thinking level reaches createAgentSession as a thinkingLevel option when no per-call/env override", async () => {
		// "spec-writer" role default is "high"; inherited "xhigh" must win over it.
		await SessionAgent.runAgentViaSession({
			agent: "spec-writer", prompt: "do the work", cwd: "/tmp", inheritedThinking: "xhigh",
		} as Parameters<typeof SessionAgent.runAgentViaSession>[0]);
		const opts = sdk.createOpts();
		expect(opts).toBeDefined();
		expect(opts!.thinkingLevel).toBe("xhigh");
	});

	it("per-call thinkingLevel wins over the inherited level (precedence: per-call > inherited)", async () => {
		await SessionAgent.runAgentViaSession({
			agent: "spec-writer", prompt: "do the work", cwd: "/tmp",
			thinkingLevel: "low", inheritedThinking: "xhigh",
		} as Parameters<typeof SessionAgent.runAgentViaSession>[0]);
		const opts = sdk.createOpts();
		expect(opts).toBeDefined();
		expect(opts!.thinkingLevel).toBe("low");
	});

	it("SUPER_DEV_THINKING env wins over the inherited level (precedence: env > inherited)", async () => {
		process.env.SUPER_DEV_THINKING = "medium";
		await SessionAgent.runAgentViaSession({
			agent: "spec-writer", prompt: "do the work", cwd: "/tmp", inheritedThinking: "xhigh",
		} as Parameters<typeof SessionAgent.runAgentViaSession>[0]);
		const opts = sdk.createOpts();
		expect(opts).toBeDefined();
		expect(opts!.thinkingLevel).toBe("medium");
	});

	it("an explicit model reaches createAgentSession as a `model` option", async () => {
		await SessionAgent.runAgentViaSession({
			agent: "spec-writer", prompt: "do the work", cwd: "/tmp", model: "openai/gpt-4o",
		} as Parameters<typeof SessionAgent.runAgentViaSession>[0]);
		const opts = sdk.createOpts();
		expect(opts).toBeDefined();
		expect(opts!.model).toBeDefined();
	});

	it("an inherited model id reaches createAgentSession as a `model` option when no explicit override", async () => {
		await SessionAgent.runAgentViaSession({
			agent: "spec-writer", prompt: "do the work", cwd: "/tmp", inheritedModel: "openai/gpt-4o",
		} as Parameters<typeof SessionAgent.runAgentViaSession>[0]);
		const opts = sdk.createOpts();
		expect(opts).toBeDefined();
		expect(opts!.model).toBeDefined();
	});
});

describe("no double-application of the thinking level (AC-04 / SCENARIO-007)", () => {
	const env = saveEnv("SUPER_DEV_THINKING", "SUPER_DEV_MODEL");
	beforeEach(() => { env.clear(); sdk.reset(); });
	afterEach(env.restore);

	it("session.setThinkingLevel is never called more than once for a single run", async () => {
		await SessionAgent.runAgentViaSession({
			agent: "spec-writer", prompt: "do the work", cwd: "/tmp", inheritedThinking: "xhigh",
		} as Parameters<typeof SessionAgent.runAgentViaSession>[0]);
		// The canonical path is now createAgentSession({ thinkingLevel }); the
		// retained best-effort applyThinkingLevel must not RE-apply (double).
		expect(sdk.thinkingCalls().length).toBeLessThanOrEqual(1);
	});
});

describe("runAgentViaSession degrades without throwing (AC-01 / AC-04 / SCENARIO-002, SCENARIO-008)", () => {
	const env = saveEnv("SUPER_DEV_THINKING", "SUPER_DEV_MODEL");
	beforeEach(() => { env.clear(); sdk.reset(); });
	afterEach(env.restore);

	it("SCENARIO-002: a context with no model/thinking at all does not throw and passes neither option", async () => {
		const res = await SessionAgent.runAgentViaSession({
			agent: "spec-writer", prompt: "do the work", cwd: "/tmp",
		} as Parameters<typeof SessionAgent.runAgentViaSession>[0]);
		expect(res).toBeDefined();
		const opts = sdk.createOpts();
		expect(opts).toBeDefined();
		// Byte-identical baseline: neither creation option is set when nothing resolves.
		expect(opts!.model).toBeUndefined();
		expect(opts!.thinkingLevel).toBeUndefined();
	});

	it("SCENARIO-008: an inherited model id that cannot be resolved completes without throwing", async () => {
		// In the mocked SDK there is no real model registry, so an inherited id
		// cannot resolve to a Model<any> — the run must fall through (no throw).
		const res = await SessionAgent.runAgentViaSession({
			agent: "spec-writer", prompt: "do the work", cwd: "/tmp", inheritedModel: "unresolvable/provider-id",
		} as Parameters<typeof SessionAgent.runAgentViaSession>[0]);
		expect(res).toBeDefined();
		// The run must not surface an error / abort when the inherited id cannot resolve.
		expect(res.error).toBeUndefined();
	});
});
