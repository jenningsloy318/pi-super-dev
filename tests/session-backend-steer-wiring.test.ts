/**
 * Phase 4 (RED) — Session-backend best-effort LIVE STEER: capture-path wiring.
 * AC-08 → SCENARIO-017 (most-recent input is steered live to the running
 *                       session specialist when a handle is reachable),
 *          SCENARIO-018 (no-throw no-op when the handle is absent —
 *                       idle / subprocess / browser backends rely solely on the
 *                       Phase-3 queue path with an IDENTICAL delivery guarantee).
 *
 * Why this file exists alongside tests/session-backend-steer.test.ts:
 *   The sibling file covers the PURE helpers (makeSteer / createSteerSink) and
 *   the runAgentViaSession `onSteer` seam in isolation. It does NOT cover the
 *   spec's actual Phase-4 behavior: "the capture path ADDITIONALLY calls
 *   session.steer(mostRecentText) on capture" — i.e. that interactive input
 *   captured DURING a run reaches the currently-running specialist via the
 *   live-steer forwarder set by the session backend's onSteer seam.
 *
 *   Today (RED) the wiring is INCOMPLETE: `activeSteerForwarder` is DECLARED in
 *   src/extension.ts and READ by the input handler (`try { activeSteerForwarder?.(event.text) }`),
 *   but it is NEVER populated — there is no exported seam to register a
 *   forwarder, and execute() does NOT pass `onSteer` to runPipelineTask. So live
 *   steer is a silent no-op even on the session backend. These tests drive the
 *   missing bridge: an exported `setActiveSteerForwarder(fn | null)` that the
 *   input handler reads, which execute() will wire as
 *   `onSteer: (fn) => setActiveSteerForwarder(fn)` (and `setActiveSteerForwarder(null)`
 *   in the run's finally, mirroring the existing activeRun teardown).
 *
 * Independently testable (no dependency on Phase 2/3 beyond Phase 1's activeRun):
 * a mocked pi.events emitter + the Phase-1 activeRun seam is all that's needed.
 * Every assertion references `setActiveSteerForwarder`, which does NOT exist yet,
 * so the file is RED until the bridge is implemented. The namespace import keeps
 * a missing export a clean "is not a function" failure rather than a crash.
 *
 * Backend split (recorded for the implementation summary):
 *   - session backend: execute() passes onSteer → runPipelineTask → runWorkflow →
 *     runAgentViaSession, which hands out a no-throw forwarder bound to the live
 *     AgentSession (when it exposes steer()). That forwarder is registered here
 *     via setActiveSteerForwarder, so each capture nudges the running specialist
 *     with the MOST-RECENT input only (bounds context growth).
 *   - subprocess backend (and browser agents via isBrowserAgent): execute() does
 *     NOT set a forwarder → setActiveSteerForwarder stays null → live steer is a
 *     documented no-throw no-op; delivery is the Phase-3 queue path's sole job,
 *     with an IDENTICAL guarantee (asserted below: drain() still returns captured
 *     input when no forwarder is registered).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import * as ext from "../src/extension.ts";

// `activate` (default export) + the Phase-1 seams already exist today.
const activate = (ext as any).default as (pi: any) => void;
const setActiveRun = (run: unknown): void => (ext as any).setActiveRun(run);
const createActiveRun = (ctx?: unknown): any => (ext as any).createActiveRun(ctx);

// ── Phase-4 seam under test ──────────────────────────────────────────────
// Does NOT exist yet (RED). When implemented:
//   export function setActiveSteerForwarder(fn: ((text: string) => void) | null) {
//     activeSteerForwarder = fn;
//   }
const setActiveSteerForwarder = (fn: unknown): void =>
	(ext as any).setActiveSteerForwarder(fn);

/** Minimal mock pi: captures the handler registered via events.on("input", h). */
function makeMockPi() {
	const handlers: Record<string, Array<(e: any) => any>> = {};
	const events = {
		on: vi.fn((type: string, h: (e: any) => any) => {
			(handlers[type] ??= []).push(h);
		}),
		/** Drive the registered handler(s) for an event type; returns the last result. */
		emit(type: string, e: any) {
			let last: unknown;
			for (const h of handlers[type] ?? []) last = h(e);
			return last;
		},
	};
	return {
		events,
		registerTool: vi.fn(),
		registerCommand: vi.fn(),
		/** The single input handler activate() registered. */
		inputHandler: (): ((e: any) => any) | undefined => {
			const c = (events.on as any).mock.calls.filter((c: any[]) => c[0] === "input");
			return c.length ? c[c.length - 1][1] : undefined;
		},
	};
}

/** Input event shape the pi "input" channel delivers: { type, text, source }. */
const ev = (text: string, source = "interactive") => ({ type: "input", text, source });

/** Start a run (so the handler's idle guard does not short-circuit) + capture
 *  the installed handler. Returns helpers to drive capture + inspect the queue. */
function startRun(pi: ReturnType<typeof makeMockPi>) {
	setActiveRun(createActiveRun());
	const handler = pi.inputHandler()!;
	const drain = () => (ext as any).getActiveRun?.()?.drain?.() ?? [];
	return { handler, drain };
}

/** Resilient reset so a still-missing export never masks the real assertion. */
const reset = () => {
	try { setActiveSteerForwarder(null); } catch { /* seam not implemented yet — fine for RED */ }
	try { setActiveRun(null); } catch { /* export not implemented yet — fine for RED */ }
};

describe("Phase 4 — capture path forwards the MOST-RECENT input to the live steer forwarder (SCENARIO-017)", () => {
	beforeEach(reset);

	it("forwards the just-captured interactive input to a registered forwarder and reports handled", () => {
		const pi = makeMockPi();
		activate(pi);
		const { handler } = startRun(pi);

		const steer = vi.fn();
		setActiveSteerForwarder(steer);

		const res = handler(ev("pivot to latency budget"));
		// The single most-recent input is steered live to the running specialist…
		expect(steer).toHaveBeenCalledTimes(1);
		expect(steer).toHaveBeenCalledWith("pivot to latency budget");
		// …and pi is told the input was handled (not re-queued as a parent steer).
		expect(res).toEqual({ action: "handled" });
	});

	it("forwards EACH capture as the single most-recent input — never an accumulated list, never re-steers older input", () => {
		const pi = makeMockPi();
		activate(pi);
		const { handler } = startRun(pi);

		const steer = vi.fn();
		setActiveSteerForwarder(steer);

		handler(ev("first nudge"));
		handler(ev("second nudge"));
		handler(ev("third nudge"));

		// One forward per capture (bounds context growth — SCENARIO-017)…
		expect(steer).toHaveBeenCalledTimes(3);
		expect(steer).toHaveBeenNthCalledWith(1, "first nudge");
		expect(steer).toHaveBeenNthCalledWith(2, "second nudge");
		expect(steer).toHaveBeenNthCalledWith(3, "third nudge");
		// …the handle is NEVER handed a list/array (the accumulating queue is the
		// Phase-3 injection path's job, not the live-steer path's):
		for (const call of steer.mock.calls) expect(Array.isArray(call[0])).toBe(false);
	});

	it("does NOT steer non-interactive input — live steer is interactive-only (SCENARIO-005 / SCENARIO-020)", () => {
		const pi = makeMockPi();
		activate(pi);
		const { handler } = startRun(pi);

		const steer = vi.fn();
		setActiveSteerForwarder(steer);

		const res = handler(ev("rpc payload", "rpc"));
		// Non-interactive sources short-circuit BEFORE push/steer → untouched,
		// output byte-identical to today.
		expect(steer).not.toHaveBeenCalled();
		expect(res).toEqual({ action: "continue" });
	});
});

describe("Phase 4 — no-throw no-op when no live handle is reachable (SCENARIO-018 / AC-09)", () => {
	beforeEach(reset);

	it("is a no-throw no-op before any forwarder is registered (idle / subprocess / browser backend)", () => {
		// The no-op is GUARANTEED by the seam existing and being null outside a
		// session run — without the seam there is no way to register a forwarder,
		// so this also pins the seam's presence (RED until exported).
		expect(typeof (ext as any).setActiveSteerForwarder).toBe("function");

		const pi = makeMockPi();
		activate(pi);
		const { handler, drain } = startRun(pi);

		// NO setActiveSteerForwarder call → forwarder is null (subprocess/browser).
		expect(() => handler(ev("captured anyway"))).not.toThrow();
		expect(handler(ev("captured again"))).toEqual({ action: "handled" });

		// …but delivery is STILL guaranteed via the Phase-3 queue path: the captured
		// input is drainable, identical to the session-backend guarantee.
		expect(drain()).toEqual(["captured anyway", "captured again"]);
	});

	it("swallows a throwing forwarder and still reports handled (AC-09 / SCENARIO-006)", () => {
		const pi = makeMockPi();
		activate(pi);
		const { handler } = startRun(pi);

		const throwing = vi.fn(() => { throw new Error("session.steer blew up mid-turn"); });
		setActiveSteerForwarder(throwing);

		// A throwing live session must NEVER break the capture path.
		expect(() => handler(ev("nudge"))).not.toThrow();
		expect(throwing).toHaveBeenCalledTimes(1);
		expect(handler(ev("nudge-2"))).toEqual({ action: "handled" });
	});

	it("reverts to a no-op after the forwarder is cleared — mirrors session.dispose → onSteer(null) (SCENARIO-018)", () => {
		const pi = makeMockPi();
		activate(pi);
		const { handler } = startRun(pi);

		const steer = vi.fn();
		setActiveSteerForwarder(steer);
		handler(ev("while session alive"));
		expect(steer).toHaveBeenCalledTimes(1);

		// The session backend tears the forwarder down on dispose (onSteer(null)).
		setActiveSteerForwarder(null);
		expect(() => handler(ev("after dispose"))).not.toThrow();
		// The disposed session is NOT nudged again…
		expect(steer).toHaveBeenCalledTimes(1);
	});

	it("clears the forwarder on run teardown alongside activeRun (no stale forwarder leaks across runs)", () => {
		const pi = makeMockPi();
		activate(pi);
		const { handler } = startRun(pi);

		const steer = vi.fn();
		setActiveSteerForwarder(steer);
		handler(ev("mid-run"));
		expect(steer).toHaveBeenCalledTimes(1);

		// The run's finally clears BOTH the run context and the forwarder — a stale
		// forwarder must not survive into the next (or idle) run.
		setActiveRun(null);
		setActiveSteerForwarder(null);

		// Idle after teardown: input flows through pi unchanged (SCENARIO-019),
		// and the old specialist is never nudged.
		expect(() => handler(ev("idle input"))).not.toThrow();
		expect(steer).toHaveBeenCalledTimes(1);
		expect(handler(ev("idle input"))).toEqual({ action: "continue" });
	});
});

describe("Phase 4 — backend split is observable at the seam (SCENARIO-017 vs SCENARIO-018)", () => {
	beforeEach(reset);

	it("exposes setActiveSteerForwarder as the bridge the session backend's onSteer seam populates", () => {
		// Drives the implementation to (a) export the seam and (b) wire
		// `onSteer: (fn) => setActiveSteerForwarder(fn)` in execute()'s
		// runPipelineTask call (with setActiveSteerForwarder(null) in finally).
		// Without this bridge the forwarder is never populated and live steer
		// never happens on the session backend — the bug this test pins down.
		expect(typeof (ext as any).setActiveSteerForwarder).toBe("function");

		const pi = makeMockPi();
		activate(pi);
		const { handler } = startRun(pi);
		const steer = vi.fn();
		expect(() => setActiveSteerForwarder(steer)).not.toThrow();
		handler(ev("bridge works"));
		expect(steer).toHaveBeenCalledWith("bridge works");
	});

	it("subprocess/browser backends leave the forwarder null → queue path is the sole, identical guarantee", () => {
		// Encodes the documented split: the seam EXISTS (so the session backend
		// CAN register a forwarder) but subprocess/browser never call it, so live
		// steer is a no-op while the queue path delivers exactly as it does for
		// the session backend (SCENARIO-018). Pins the seam presence (RED).
		expect(typeof (ext as any).setActiveSteerForwarder).toBe("function");

		const pi = makeMockPi();
		activate(pi);
		const { handler, drain } = startRun(pi);
		// No forwarder registered (subprocess/browser):
		handler(ev("queue-delivered"));
		expect(drain()).toEqual(["queue-delivered"]);
	});
});
