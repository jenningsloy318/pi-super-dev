/**
 * Phase 2 (Per-agent thinking configuration) — RED tests.
 *
 * These pin the intended contract for the thinking-level feature:
 *  - thinkingForAgent(agent): role-based default level
 *  - resolveThinking(agent, perCall?): per-call → SUPER_DEV_THINKING env → role
 *  - buildSpawnArgs appends "--thinking <resolved>" to the subprocess argv
 *  - applyThinkingLevel(session, level): best-effort session.setThinkingLevel,
 *    tolerant of a missing/throwing method (never fails the run)
 *
 * They typecheck against the real source (types/exports exist) but FAIL at
 * runtime because the implementations are still RED-phase stubs.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { thinkingForAgent, resolveThinking, buildSpawnArgs, type ThinkingLevel } from "../src/pi-spawn.ts";
import { applyThinkingLevel } from "../src/session-agent.ts";

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

describe("buildSpawnArgs appends --thinking <resolved-level>", () => {
	const OLD = process.env.SUPER_DEV_THINKING;
	beforeEach(() => { delete process.env.SUPER_DEV_THINKING; });
	afterEach(() => {
		if (OLD === undefined) delete process.env.SUPER_DEV_THINKING;
		else process.env.SUPER_DEV_THINKING = OLD;
	});

	it("includes --thinking with the role-resolved level", () => {
		const args = buildSpawnArgs({ agent: "code-reviewer", prompt: "x", cwd: "/tmp" }, "/tmp/a.md");
		expect(args).toContain("--thinking");
		expect(args[args.indexOf("--thinking") + 1]).toBe("high");
	});
	it("honors a per-call thinking override in the argv", () => {
		const args = buildSpawnArgs({ agent: "code-reviewer", prompt: "x", cwd: "/tmp", thinking: "off" }, "/tmp/a.md");
		expect(args).toContain("--thinking");
		expect(args[args.indexOf("--thinking") + 1]).toBe("off");
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
