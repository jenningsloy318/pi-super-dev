/**
 * W-1/W-2 soft-deadline wrap-up (docs/requirements/llm-judge-routing-layer.md §1.4).
 *
 * Regression for the observed total-loss timeouts (BDD round 1 of run
 * 2026-08-14T14-48-07: 480s of work discarded with control=no). At 80% of the
 * wall clock the session backend must abort exploration and hand the SAME
 * session one wrap-up turn whose only job is to deliver the structured_output.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const sdk = vi.hoisted(() => {
	let promptCalls: string[] = [];
	let structuredTool: { execute: (id: string, params: Record<string, unknown>) => Promise<unknown> } | undefined;
	const output = { title: "T", date: "2026-08-15", verdict: "Approved", summary: "s", findings: [] };
	let mode: "never" | "wrapup-only" | "delayed-then-wrapup" = "wrapup-only";
	const pendingRejecters = new Set<(err: Error) => void>();
	let hangMode: "none" | "first" | "all" = "none";
	function reset() {
		promptCalls = [];
		structuredTool = undefined;
		mode = "wrapup-only";
		hangMode = "none";
		pendingRejecters.clear();
	}
	function buildSession() {
		return {
			prompt: vi.fn(async (prompt: string) => {
				promptCalls.push(prompt);
				const isWrapUp = /DEADLINE REACHED/.test(prompt) || /soft deadline while still exploring/.test(prompt);
				const shouldHang = hangMode === "all" || (hangMode !== "none" && !isWrapUp && promptCalls.length === 1);
				if (hangMode !== "none" && (shouldHang || (isWrapUp && mode === "never"))) {
					// Simulate an in-flight turn the abort must reject: the session SDK
					// rejects the pending prompt when abort() is called.
					await new Promise<never>((_, reject) => {
						pendingRejecters.add(reject);
					});
				}
				if (isWrapUp || promptCalls.length === 2) {
					if (mode === "wrapup-only") {
						await structuredTool?.execute("tool-1", output);
					}
					// mode "never": wrap-up hangs above until the hard timeout aborts it
				}
			}),
			abort: vi.fn(() => {
				for (const reject of [...pendingRejecters]) {
					reject(new Error("aborted"));
					pendingRejecters.delete(reject);
				}
			}),
			subscribe: vi.fn(() => () => {}),
			dispose: vi.fn(() => {}),
			messages: [],
		};
	}
	return {
		reset,
		buildSession,
		setMode: (m: typeof mode) => { mode = m; },
		hangFirstPrompt: () => { hangMode = "first"; },
		hangAll: () => { hangMode = "all"; },
		setCreateOpts: (opts: Record<string, unknown>) => {
			structuredTool = (opts.customTools as Array<{ name?: string; execute?: unknown }>).find((t) => t.name === "structured_output") as typeof structuredTool;
		},
		promptCalls: () => promptCalls,
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
vi.mock("../src/control.ts", () => ({
	extractControl: vi.fn(() => null),
	missingControlKeys: vi.fn((captured: Record<string, unknown> | null | undefined, keys: string[]) => {
		if (!captured) return keys;
		return keys.filter((k) => {
			const v = captured[k];
			return v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0);
		});
	}),
}));
vi.mock("../src/setup.ts", () => ({ sanitizeSlug: vi.fn((s: string) => s) }));
vi.mock("../src/safety.ts", () => ({ createSafetyExtensionFactory: vi.fn(() => () => ({ name: "safety", activate: () => ({}) })) }));
vi.mock("../src/render/super-dev-dir.ts", () => ({ getTracesDir: vi.fn(() => "/tmp/traces") }));

import { runAgentViaSession } from "../src/session-agent.ts";

describe("session soft-deadline wrap-up (W-1/W-2)", () => {
	beforeEach(() => sdk.reset());

	it("converts a hung exploration into a delivered control via the wrap-up turn", async () => {
		sdk.setMode("wrapup-only");
		sdk.hangFirstPrompt();
		const events: string[] = [];
		const result = await runAgentViaSession({
			agent: "bdd-scenario-writer",
			id: "pipeline.bdd",
			prompt: "write BDD scenarios",
			cwd: "/tmp",
			controlKeys: ["title", "date", "verdict", "summary", "findings"],
			timeoutMs: 1_000, // soft deadline at 800ms
			onProgress: { event: (m) => { events.push(m); }, text: () => {} },
		});
		expect(events.some((e) => e.includes("soft deadline reached"))).toBe(true);
		expect(events.some((e) => e.includes("wrap-up prompt (soft deadline)"))).toBe(true);
		expect(sdk.promptCalls().length).toBeGreaterThanOrEqual(2);
		expect(sdk.promptCalls()[1]).toContain("DEADLINE REACHED");
		expect(result.control).toEqual(sdk.output());
		expect(result.error).toBeUndefined();
	}, 10_000);

	it("keeps the plain corrective re-prompt when the first turn returns normally (no soft deadline)", async () => {
		sdk.setMode("wrapup-only");
		const events: string[] = [];
		const result = await runAgentViaSession({
			agent: "bdd-scenario-writer",
			id: "pipeline.bdd",
			prompt: "write BDD scenarios",
			cwd: "/tmp",
			controlKeys: ["title", "date", "verdict", "summary", "findings"],
			timeoutMs: 30_000,
			onProgress: { event: (m) => { events.push(m); }, text: () => {} },
		});
		expect(events.some((e) => e.includes("soft deadline"))).toBe(false);
		expect(events.some((e) => e.includes("corrective re-prompt (no structured_output)"))).toBe(true);
		expect(result.control).toEqual(sdk.output());
	}, 10_000);

	it("a silent wrap-up still hard-times-out exactly as before (no budget laundering)", async () => {
		sdk.setMode("never");
		sdk.hangAll();
		const result = await runAgentViaSession({
			agent: "bdd-scenario-writer",
			id: "pipeline.bdd",
			prompt: "write BDD scenarios",
			cwd: "/tmp",
			controlKeys: ["title", "date", "verdict", "summary", "findings"],
			timeoutMs: 800, // soft at 560ms (70% role), wrap-up silent, hard at 800ms
			onProgress: { event: () => {}, text: () => {} },
		});
		expect(result.control).toBeNull();
		expect(result.error).toContain("timed out");
	}, 10_000);
});

describe("F-E: role-scoped wrap-up fraction + partial-emission instruction", () => {
	beforeEach(() => sdk.reset());

	it("a control-heavy writer role wraps up at 70% of the wall clock (not 80%)", async () => {
		vi.useFakeTimers();
		try {
			sdk.setMode("wrapup-only");
			sdk.hangFirstPrompt();
			const events: string[] = [];
			const pending = runAgentViaSession({
				agent: "bdd-scenario-writer",
				id: "pipeline.bdd",
				prompt: "write BDD scenarios",
				cwd: "/tmp",
				controlKeys: ["title", "date", "verdict", "summary", "findings"],
				timeoutMs: 1_000, // soft deadline at 700ms for this role
				onProgress: { event: (m) => { events.push(m); }, text: () => {} },
			});
			await vi.advanceTimersByTimeAsync(690);
			expect(events.some((e) => e.includes("soft deadline reached"))).toBe(false); // not yet
			await vi.advanceTimersByTimeAsync(20); // 710ms — past the 70% point, before 80%
			expect(events.some((e) => e.includes("soft deadline reached"))).toBe(true);
			expect(events.some((e) => e.includes("wrap-up at 70%"))).toBe(true);
			const result = await pending;
			expect(result.control).toEqual(sdk.output());
		} finally {
			vi.useRealTimers();
		}
	}, 10_000);

	it("a non-writer role keeps the 80% wrap-up point", async () => {
		vi.useFakeTimers();
		try {
			sdk.setMode("wrapup-only");
			sdk.hangFirstPrompt();
			const events: string[] = [];
			const pending = runAgentViaSession({
				agent: "code-reviewer",
				id: "pipeline.review",
				prompt: "review",
				cwd: "/tmp",
				controlKeys: ["title", "date", "verdict", "summary", "findings"],
				timeoutMs: 1_000, // soft deadline at 800ms for this role
				onProgress: { event: (m) => { events.push(m); }, text: () => {} },
			});
			await vi.advanceTimersByTimeAsync(750);
			expect(events.some((e) => e.includes("soft deadline reached"))).toBe(false); // 70%+ but not 80% yet
			await vi.advanceTimersByTimeAsync(60); // 810ms — past 80%
			expect(events.some((e) => e.includes("soft deadline reached"))).toBe(true);
			expect(events.some((e) => e.includes("wrap-up at 80%"))).toBe(true);
			const result = await pending;
			expect(result.control).toEqual(sdk.output());
		} finally {
			vi.useRealTimers();
		}
	}, 10_000);

	it("the wrap-up prompt demands partial emission — never silent completionism", async () => {
		sdk.setMode("wrapup-only");
		sdk.hangFirstPrompt();
		const events: string[] = [];
		const result = await runAgentViaSession({
			agent: "spec-writer",
			id: "pipeline.spec",
			prompt: "write the spec",
			cwd: "/tmp",
			controlKeys: ["title", "date", "verdict", "summary", "findings"],
			timeoutMs: 1_000,
			onProgress: { event: (m) => { events.push(m); }, text: () => {} },
		});
		expect(result.control).toEqual(sdk.output());
		const wrapUp = sdk.promptCalls().find((p) => p.includes("DEADLINE REACHED"));
		expect(wrapUp).toBeTruthy();
		expect(wrapUp).toContain("partial sections are acceptable");
		expect(wrapUp).toContain("the next round will complete what is missing");
	}, 10_000);
});
