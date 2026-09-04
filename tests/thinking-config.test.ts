/**
 * Phase 2 (Per-agent thinking configuration) — RED tests.
 *
 * These pin the intended contract for the thinking-level feature:
 *  - thinkingForAgent(agent): role-based default level
 *  - resolveThinking(agent, perCall?): per-call → SUPER_DEV_THINKING env → role
 *  - (subprocess argv case deleted with the subprocess backend in v0.3.64)
 *  - applyThinkingLevel(session, level): best-effort session.setThinkingLevel,
 *    tolerant of a missing/throwing method (never fails the run)
 *
 * They typecheck against the real source (types/exports exist) but FAIL at
 * runtime because the implementations are still RED-phase stubs.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { thinkingForAgent, resolveThinking, type ThinkingLevel } from "../src/agents/agent-runtime.ts";
import { applyThinkingLevel } from "../src/agents/agent-runtime.ts";
vi.mock("../src/render/super-dev-dir.ts", async (importOriginal) => {
	// v0.3.44 hermetic pin: resolveThinking now reads config.agentThinking
	// lazily; pin getConfig to DEFAULT_CONFIG so these precedence tests never
	// depend on (or break on) the real ~/.super-dev/config.json.
	const actual = await importOriginal<typeof import("../src/render/super-dev-dir.ts")>();
	return { ...actual, getConfig: () => actual.DEFAULT_CONFIG };
});

describe("thinkingForAgent role mapping", () => {
	it("maps reasoning-heavy agents to 'high'", () => {
		for (const a of ["design", "spec-writer", "adversarial-reviewer", "code-reviewer", "debug", "debugger", "assessment"]) {
			expect(thinkingForAgent(a), a).toBe("high");
		}
	});
	it("maps code-writing agents to 'medium'", () => {
		expect(thinkingForAgent("implementer")).toBe("medium");
		expect(thinkingForAgent("tdd-guide")).toBe("medium");
	});
	it("maps mechanical bookkeeping agents to a minimal/off level", () => {
		for (const a of ["commit", "orchestrator-commit", "cleanup"]) {
			expect(["minimal", "off"], a).toContain(thinkingForAgent(a));
		}
	});
	it("defaults unknown agents to 'medium'", () => {
		expect(thinkingForAgent("totally-unknown-agent")).toBe("medium");
	});
	it("only ever returns a valid ThinkingLevel", () => {
		const valid: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
		for (const a of ["design", "implementer", "commit", "unknown"]) {
			expect(valid).toContain(thinkingForAgent(a));
		}
	});
});

describe("resolveThinking precedence (per-call → env → role)", () => {
	const OLD = process.env.SUPER_DEV_THINKING;
	beforeEach(() => { delete process.env.SUPER_DEV_THINKING; });
	afterEach(() => {
		if (OLD === undefined) delete process.env.SUPER_DEV_THINKING;
		else process.env.SUPER_DEV_THINKING = OLD;
	});

	it("per-call override wins over both env and role default", () => {
		process.env.SUPER_DEV_THINKING = "low";
		expect(resolveThinking("code-reviewer", "max")).toBe("max");
	});
	it("env override wins over the role default when no per-call override", () => {
		process.env.SUPER_DEV_THINKING = "low";
		expect(resolveThinking("code-reviewer")).toBe("low");
	});
	it("falls back to the role default when neither override is present", () => {
		expect(resolveThinking("code-reviewer")).toBe("high");
		expect(resolveThinking("implementer")).toBe("medium");
	});
});


describe("applyThinkingLevel (session backend tolerance)", () => {
	it("calls setThinkingLevel with the resolved level on a capable session", () => {
		const calls: string[] = [];
		const session = { setThinkingLevel: (l: string) => { calls.push(l); } };
		expect(() => applyThinkingLevel(session, "high")).not.toThrow();
		expect(calls).toEqual(["high"]);
	});
	it("tolerates a session missing setThinkingLevel (older runtime)", () => {
		expect(() => applyThinkingLevel({}, "high")).not.toThrow();
	});
	it("tolerates setThinkingLevel throwing (unsupported/clamped level)", () => {
		const session = { setThinkingLevel: () => { throw new Error("unsupported"); } };
		expect(() => applyThinkingLevel(session, "high")).not.toThrow();
	});
	it("no-ops when the level is undefined", () => {
		const calls: string[] = [];
		const session = { setThinkingLevel: (l: string) => { calls.push(l); } };
		expect(() => applyThinkingLevel(session, undefined)).not.toThrow();
		expect(calls).toEqual([]);
	});
});
