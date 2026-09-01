/**
 * v0.3.56 F7 — the session backend skipped tiered thinking resolution whenever
 * creation thinking (explicit-or-inherited) resolved: a parent session at
 * :max ran tiered classifiers and config.agentThinking overrides at max under
 * the session backend, while the subprocess/delegation backends clamped them
 * (documented precedence: per-call → env → config.agentThinking → :level
 * suffix → role tier → inherited → medium).
 *
 * Escape class D (implicit cross-backend contract); defense layer L5
 * behavioral double (mocked SDK, REAL runAgentViaSession — same harness as
 * tests/session-agent-inherit.test.ts).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const sdk = vi.hoisted(() => {
	let createOpts: Record<string, unknown> | null = null;
	let thinkingCalls: string[] = [];
	return {
		buildSession: () => ({
			prompt: vi.fn(async () => {}),
			abort: vi.fn(() => {}),
			subscribe: vi.fn(() => () => {}),
			dispose: vi.fn(() => {}),
			messages: [],
			setThinkingLevel: vi.fn((level: string) => { thinkingCalls.push(level); }),
		}),
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
	DefaultResourceLoader: vi.fn(function (this: { reload: () => Promise<void> }) { this.reload = async () => {}; }),
	SessionManager: { inMemory: vi.fn(() => ({})) },
	SettingsManager: { create: vi.fn(() => ({})) },
	ModelRuntime: { create: vi.fn(async () => ({ getModel: vi.fn(() => undefined), getModels: vi.fn(() => []) })) },
}));

vi.mock("../src/setup.ts", () => ({ sanitizeSlug: vi.fn((s: string) => s) }));
vi.mock("../src/safety.ts", () => ({ createSafetyExtensionFactory: vi.fn(() => () => ({ name: "safety", activate: () => ({}) })) }));
// F7 subject: config.agentThinking must reach the session backend. getConfig is
// mocked (SUPER_DEV_DIR is a hardcoded const — not env-redirectable).
vi.mock("../src/render/super-dev-dir.ts", async (importOriginal) => {
	// Mock hygiene (docs/testing-strategy.md class B): spread the ORIGINAL
	// module so unrelated exports (getLearnedIndexPath, getConfigPath, …) stay
	// real — a hand-enumerated factory breaks whenever super-dev-dir grows an
	// export. getConfig is overridden (SUPER_DEV_DIR is a hardcoded const — not
	// env-redirectable), so the tier resolution stays hermetic.
	const actual = await importOriginal<typeof import("../src/render/super-dev-dir.ts")>();
	return {
		...actual,
		getTracesDir: vi.fn(() => "/tmp/traces"),
		superDevEnv: vi.fn((k: string) => process.env[k] || undefined),
		getConfig: vi.fn(() => ({ agentThinking: { implementer: "low" } })),
	};
});

import * as SessionAgent from "../src/session-agent.ts";

const saveEnv = (...keys: string[]) => {
	const snapshot: Record<string, string | undefined> = {};
	for (const k of keys) snapshot[k] = process.env[k];
	return {
		clear: () => { for (const k of keys) delete process.env[k]; },
		restore: () => { for (const k of keys) { if (snapshot[k] === undefined) delete process.env[k]; else process.env[k] = snapshot[k] as string; } },
	};
};

describe("session-backend thinking parity — config tiers apply even when creation got the inherited level (F7)", () => {
	const env = saveEnv("SUPER_DEV_THINKING", "SUPER_DEV_MODEL");
	beforeEach(() => { env.clear(); sdk.reset(); });
	afterEach(env.restore);

	it("config.agentThinking tier overrides an inherited :max creation level (the F7 defect)", async () => {
		// Pre-fix: creationThinking = inherited "xhigh" → the guard skipped
		// resolveThinking entirely → implementer ran at xhigh (never "low").
		await SessionAgent.runAgentViaSession({
			agent: "implementer", prompt: "work", cwd: "/tmp", inheritedThinking: "xhigh",
		} as Parameters<typeof SessionAgent.runAgentViaSession>[0]);
		expect(sdk.thinkingCalls()).toContain("low");
	});

	it("a role-tiered agent is clamped below the inherited level (parity with subprocess backend)", async () => {
		// "task-classifier" role tier is LOW (CLASSIFIER_AGENTS, SCENARIO-006) and
		// carries no config override here: inherited xhigh must NOT win.
		await SessionAgent.runAgentViaSession({
			agent: "task-classifier", prompt: "work", cwd: "/tmp", inheritedThinking: "xhigh",
		} as Parameters<typeof SessionAgent.runAgentViaSession>[0]);
		expect(sdk.thinkingCalls()).toContain("low");
	});

	it("an untiered agent with NO config override still inherits (no over-application)", async () => {
		// "requirements-clarifier" has NO tier (untiered agents inherit by design);
		// getConfig has no override → resolved equals the creation level →
		// applyThinkingLevel is skipped (no double-apply).
		await SessionAgent.runAgentViaSession({
			agent: "requirements-clarifier", prompt: "work", cwd: "/tmp", inheritedThinking: "xhigh",
		} as Parameters<typeof SessionAgent.runAgentViaSession>[0]);
		expect(sdk.thinkingCalls()).toEqual([]);
	});

	it("per-call thinking equal to creation still applies exactly once", async () => {
		await SessionAgent.runAgentViaSession({
			agent: "spec-writer", prompt: "work", cwd: "/tmp",
			thinkingLevel: "low", inheritedThinking: "xhigh",
		} as Parameters<typeof SessionAgent.runAgentViaSession>[0]);
		expect(sdk.thinkingCalls()).toEqual([]);
		expect(sdk.createOpts()?.thinkingLevel).toBe("low");
	});
});
