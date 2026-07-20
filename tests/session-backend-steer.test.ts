/**
 * Phase 4 — Session-backend best-effort live steer (RED tests).
 * AC-08 → SCENARIO-017 (live steer of the most-recent input when reachable),
 *          SCENARIO-018 (documented no-throw no-op when the handle is absent;
 *                        subprocess + browser agents rely solely on the
 *                        Phase-3 queue path with an identical delivery
 *                        guarantee).
 *
 * Decision recorded from reading src/session-agent.ts: the AgentSession handle
 * is created LOCALLY inside runAgentViaSession (`const { session } = await
 * createAgentSession(...)`, ~line 225) and disposed in its `finally`
 * (`session.dispose()`, ~line 296). It is NEVER returned to, or reachable from,
 * makeContext/realAgent or the input-capture path. So live steer is reachable
 * ONLY through a new additive seam: runAgentViaSession must call an optional
 * `opts.onSteer(steerFn | null)` — handing out a no-throw steer fn bound to the
 * live session when it exposes `steer()`, and `null` on dispose (or when the
 * session lacks `steer()`). The two pure helpers below encode the testable
 * behavior independent of any Phase 1/2/3 work.
 *
 * These tests FAIL today (RED) because `makeSteer` / `createSteerSink` are not
 * yet exported from src/session-agent.ts and runAgentViaSession does not yet
 * consult `opts.onSteer`.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

/* ------------------------------------------------------------------ *
 * Harness: mock the pi SDK + the local helpers session-agent.ts imports
 * so the REAL runAgentViaSession can be exercised without a model, and
 * its (not-yet-implemented) `onSteer` seam can be observed.
 * vi.hoisted keeps the shared steer-handle state reachable from the
 * vi.mock factories (which run before top-level code).
 * ------------------------------------------------------------------ */
const sdk = vi.hoisted(() => {
	const state = { withSteer: true };
	let current: Record<string, unknown> | null = null;
	function buildSession(): Record<string, unknown> {
		const session: Record<string, unknown> = {
			prompt: vi.fn(async () => {}),
			abort: vi.fn(() => {}),
			subscribe: vi.fn(() => () => {}),
			dispose: vi.fn(() => {}),
			messages: [],
		};
		if (state.withSteer) session.steer = vi.fn();
		current = session;
		return session;
	}
	return {
		state,
		buildSession,
		current: () => current,
		reset: () => {
			current = null;
			state.withSteer = true;
		},
	};
});

vi.mock("@earendil-works/pi-coding-agent", () => ({
	createAgentSession: vi.fn(async () => ({ session: sdk.buildSession() })),
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

// Namespace import: `makeSteer` / `createSteerSink` are undefined until
// implemented (no ESM link error), so each assertion fails with a clear
// message in RED rather than aborting the whole file on import.
import * as SessionAgent from "../src/session-agent.ts";

beforeEach(() => sdk.reset());

describe("makeSteer — reachable vs absent handle (SCENARIO-017 / SCENARIO-018)", () => {
	it("returns null when the handle is null/undefined (no-op)", () => {
		expect(SessionAgent.makeSteer(null)).toBeNull();
		expect(SessionAgent.makeSteer(undefined)).toBeNull();
	});

	it("returns null when the handle has no steer() method (documented no-op)", () => {
		expect(SessionAgent.makeSteer({})).toBeNull();
		expect(SessionAgent.makeSteer({ steer: "not-a-fn" })).toBeNull();
	});

	it("returns a forwarder that calls handle.steer(text) when reachable (SCENARIO-017)", () => {
		const handle = { steer: vi.fn() };
		const steer = SessionAgent.makeSteer(handle);
		expect(typeof steer).toBe("function");
		steer!("hello");
		steer!("world");
		expect(handle.steer).toHaveBeenCalledTimes(2);
		expect(handle.steer).toHaveBeenNthCalledWith(1, "hello");
		expect(handle.steer).toHaveBeenNthCalledWith(2, "world");
	});

	it("is no-throw: a handle.steer that throws is swallowed (SCENARIO-018 / AC-09)", () => {
		const handle = { steer: vi.fn(() => { throw new Error("boom"); }) };
		const steer = SessionAgent.makeSteer(handle);
		expect(steer).not.toBeNull();
		expect(() => steer!("x")).not.toThrow();
	});

	it("binds the method so `this` is preserved (the class-handle detachment bug)", () => {
		class LiveSession {
			fgColors = { accent: "cyan" };
			steer(text: string) {
				return `${this.fgColors.accent}:${text}`;
			}
		}
		const handle = new LiveSession();
		const steer = SessionAgent.makeSteer(handle as unknown as { steer: (t: string) => void });
		// If makeSteer took `handle.steer` without binding, `this` detaches and
		// throws "reading 'fgColors'" — the same class-detachment class of bug
		// the stream-theme class-theme regression test guards against.
		expect(() => steer!("nudge")).not.toThrow();
	});
});

describe("createSteerSink — most-recent-only forward + absent no-op (SCENARIO-017 / SCENARIO-018)", () => {
	it("forwards the just-captured text (the most-recent input) to the registered handle, never the queue list (SCENARIO-017)", () => {
		const sink = SessionAgent.createSteerSink();
		const handle = { steer: vi.fn() };
		sink.set(handle);
		// Each capture forwards EXACTLY that input (the most-recent at capture
		// time). The accumulating queue is the Phase-3 injection path's job; the
		// live-steer path bounds context growth by sending one nudge per capture.
		sink.forward("first");
		sink.forward("second");
		expect(handle.steer).toHaveBeenCalledTimes(2);
		expect(handle.steer).toHaveBeenNthCalledWith(1, "first");
		expect(handle.steer).toHaveBeenNthCalledWith(2, "second");
		// Never handed the handle a list/array of inputs:
		for (const c of handle.steer.mock.calls) {
			expect(Array.isArray(c[0])).toBe(false);
		}
	});

	it("is a no-throw no-op before any handle is registered (SCENARIO-018)", () => {
		const sink = SessionAgent.createSteerSink();
		expect(() => sink.forward("orphan")).not.toThrow();
	});

	it("becomes a no-throw no-op again after clear() (mirrors session.dispose onSteer(null)) (SCENARIO-018)", () => {
		const sink = SessionAgent.createSteerSink();
		const handle = { steer: vi.fn() };
		sink.set(handle);
		sink.forward("live");
		expect(handle.steer).toHaveBeenCalledTimes(1);
		sink.clear();
		expect(() => sink.forward("post-clear")).not.toThrow();
		expect(handle.steer).toHaveBeenCalledTimes(1); // not called again
	});
});

describe("runAgentViaSession onSteer seam — session-backend live steer wiring (SCENARIO-017 / SCENARIO-018)", () => {
	it("hands opts.onSteer a no-throw forwarder on creation and null on dispose when the session exposes steer() (SCENARIO-017)", async () => {
		sdk.state.withSteer = true;
		const calls: Array<((text: string) => void) | null> = [];
		const res = await SessionAgent.runAgentViaSession({
			agent: "writer",
			prompt: "do the work",
			cwd: "/tmp",
			onSteer: (fn) => {
				calls.push(fn);
			},
		} as Parameters<typeof SessionAgent.runAgentViaSession>[0]);
		expect(res).toBeDefined();
		// Created with a function, torn down with null.
		expect(calls.length).toBeGreaterThanOrEqual(2);
		expect(typeof calls[0]).toBe("function");
		expect(calls[calls.length - 1]).toBeNull();
		// The handed-out forwarder routes to the live session.steer and is no-throw.
		const session = sdk.current() as { steer?: (t: string) => void };
		expect(typeof session.steer).toBe("function");
		const forward = calls.find((c): c is (text: string) => void => typeof c === "function")!;
		expect(() => forward("nudge-1")).not.toThrow();
		expect(session.steer!).toHaveBeenCalledWith("nudge-1");
	});

	it("calls opts.onSteer(null) (documented no-op) when the session lacks steer(); never hands out a forwarder (SCENARIO-018)", async () => {
		sdk.state.withSteer = false;
		const calls: Array<((text: string) => void) | null> = [];
		await SessionAgent.runAgentViaSession({
			agent: "writer",
			prompt: "do the work",
			cwd: "/tmp",
			onSteer: (fn) => {
				calls.push(fn);
			},
		} as Parameters<typeof SessionAgent.runAgentViaSession>[0]);
		// onSteer MUST have been invoked (so the caller learns the handle is
		// absent), and never with a usable function — queue path still runs.
		expect(calls.length).toBeGreaterThanOrEqual(1);
		expect(calls).toContain(null);
		expect(calls.filter((c) => typeof c === "function")).toHaveLength(0);
		const session = sdk.current() as { steer?: unknown };
		expect(session.steer).toBeUndefined();
	});

	it("treats a forwarder whose underlying session.steer throws as no-throw (best-effort, AC-09)", async () => {
		sdk.state.withSteer = true;
		// Collect EVERY onSteer call: the dispose `finally` hands out `null` AFTER
		// the creation-time forwarder, so a single-slot capture (`forwarder = fn`)
		// would be clobbered to null before these assertions run. Pick the
		// creation-time function (same `.find` shape SCENARIO-017 uses) so the
		// live forwarder itself is exercised against a throwing session.steer.
		const calls: Array<((text: string) => void) | null> = [];
		await SessionAgent.runAgentViaSession({
			agent: "writer",
			prompt: "do the work",
			cwd: "/tmp",
			onSteer: (fn) => {
				calls.push(fn);
			},
		} as Parameters<typeof SessionAgent.runAgentViaSession>[0]);
		const session = sdk.current() as { steer: ReturnType<typeof vi.fn> };
		session.steer.mockImplementation(() => {
			throw new Error("steer blew up mid-turn");
		});
		const forwarder = calls.find((c): c is (text: string) => void => typeof c === "function");
		expect(forwarder).toBeDefined();
		expect(typeof forwarder).toBe("function");
		// A throwing live session must not break the capture path.
		expect(() => forwarder!("anything")).not.toThrow();
	});
});
