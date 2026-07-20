/**
 * Phase 1 (RED) tests — Run-state singleton & once-registered input listener.
 *
 * Scope of this phase (from the implementation plan + spec testing strategy):
 *   AC-01 → SCENARIO-001  (register listener exactly once in activate())
 *   AC-02 → SCENARIO-002, -003  (activeRun singleton lifecycle; no-op when null)
 *   AC-03 → SCENARIO-004, -005, -006, -007  (handled iff active+interactive;
 *                                             non-interactive/empty guards; no-throw)
 *   AC-05 → SCENARIO-013  (ActiveRun.drain() atomic return-and-clear)
 *
 * These tests drive a MOCKED `pi.events` emitter — no pi host, no dependency on
 * Phase 2 (ACK surfaces) or Phase 3 (provider wiring). The handler is captured
 * from the emitter (the SAME fn production `activate(pi)` installs), not via a
 * separately-exported symbol, so register-once + behavior are exercised together.
 *
 * The tests reference exports from src/extension.ts that DO NOT EXIST YET:
 *   - `createActiveRun(ctx?)`   → factory for the module-scoped ActiveRun
 *   - `setActiveRun(run | null)`→ set/clear the module singleton (execute entry/finally)
 *   - `getActiveRun()`          → read the module singleton
 *   - `pi.events.on("input", h)`→ registered EXACTLY ONCE inside activate(pi)
 *
 * ActiveRun contract asserted: { queue: string[]; push(text); drain() }
 *   - push(text) stores text; empty/whitespace-only is NOT stored (SCENARIO-007)
 *   - drain() atomically returns + clears the queue (SCENARIO-013)
 *   - ACK surfaces (status pill / dashboard / transcript) are Phase 2 — NOT here.
 *
 * Namespace import is used deliberately so a missing export is an undefined
 * binding (clean RED "is not a function") rather than a transform-time crash.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import * as ext from "../src/extension.ts";

// `activate` is the default export and already exists today.
const activate = (ext as any).default as (pi: any) => void;

// Thin wrappers around not-yet-existing exports. Each throws clearly when the
// export is absent (RED); when implemented they just forward.
const setActiveRun = (run: unknown): void => (ext as any).setActiveRun(run);
const getActiveRun = (): unknown => (ext as any).getActiveRun();
const createActiveRun = (ctx?: unknown): any => (ext as any).createActiveRun(ctx);

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
	const inputCalls = () =>
		(events.on as any).mock.calls.filter((c: any[]) => c[0] === "input");
	return {
		events,
		registerTool: vi.fn(),
		registerCommand: vi.fn(),
		inputHandler: (): ((e: any) => any) | undefined => {
			const c = inputCalls();
			return c.length ? c[c.length - 1][1] : undefined;
		},
		inputRegistrationCount: (): number => inputCalls().length,
	};
}

/** Input event shape the pi "input" channel delivers: { type, text, source }. */
const ev = (text: string, source: string) => ({ type: "input", text, source });

/** Resilient reset so a still-missing export never masks the real assertion. */
const resetRun = () => {
	try {
		setActiveRun(null);
	} catch {
		/* export not implemented yet — fine for RED */
	}
};

describe("Phase 1 — input listener registered once at activation (AC-01 / SCENARIO-001)", () => {
	beforeEach(resetRun);

	it("activate registers pi.events.on('input', handler) exactly once", () => {
		const pi = makeMockPi();
		activate(pi);
		expect(pi.inputRegistrationCount()).toBe(1);
		expect(pi.inputHandler()).toBeTypeOf("function");
	});

	it("starting additional runs never creates extra listeners (no leak across runs)", () => {
		const pi = makeMockPi();
		activate(pi);
		const H = pi.inputHandler()!;
		// run A: set activeRun → handler fires → finally clears
		setActiveRun(createActiveRun());
		H(ev("a", "interactive"));
		setActiveRun(null);
		// run B: a second execute() cycle
		setActiveRun(createActiveRun());
		H(ev("b", "interactive"));
		setActiveRun(null);
		// The listener is module-lifetime, bound once in activate — never per-run.
		expect(pi.inputRegistrationCount()).toBe(1);
		expect(H).toBe(pi.inputHandler()); // same handler instance across runs
	});
});

describe("Phase 1 — activeRun singleton lifecycle (AC-02 / SCENARIO-002)", () => {
	beforeEach(resetRun);

	it("is null when idle; present while a run is active; discarded on finally", () => {
		expect(getActiveRun()).toBeNull();

		const run = createActiveRun();
		setActiveRun(run); // execute() entry
		expect(getActiveRun()).toBe(run);

		setActiveRun(null); // the existing execute() finally discard (with setWidget)
		expect(getActiveRun()).toBeNull();
	});

	it("each run gets a fresh queue — captured text never leaks into a later run", () => {
		const r1 = createActiveRun();
		r1.push("leftover from run 1");
		setActiveRun(r1);
		setActiveRun(null); // run 1 ends

		const r2 = createActiveRun();
		setActiveRun(r2); // run 2 starts
		expect(r2.drain()).toEqual([]); // r1's leftover did NOT bleed in
		setActiveRun(null);
	});

	it("handler is a no-op returning {action:'continue'} whenever activeRun is null", () => {
		const pi = makeMockPi();
		activate(pi);
		const H = pi.inputHandler()!;
		expect(getActiveRun()).toBeNull();
		expect(H(ev("ignored", "interactive"))).toEqual({ action: "continue" });
		expect(getActiveRun()).toBeNull(); // still idle — nothing captured
	});
});

describe("Phase 1 — source & active-run guards (AC-03 / SCENARIO-004..-007)", () => {
	let pi: ReturnType<typeof makeMockPi>;
	let H: (e: any) => any;
	beforeEach(() => {
		resetRun();
		pi = makeMockPi();
		activate(pi);
		H = pi.inputHandler()!;
	});

	it("SCENARIO-004: active run + interactive → handled and the text is queued", () => {
		const run = createActiveRun();
		setActiveRun(run);
		const res = H(ev("focus on the auth bug", "interactive"));
		expect(res).toEqual({ action: "handled" });
		expect(run.drain()).toEqual(["focus on the auth bug"]); // pi does NOT re-queue it
		setActiveRun(null);
	});

	it("SCENARIO-005: active run + source 'rpc' → continue, queue untouched", () => {
		const run = createActiveRun();
		setActiveRun(run);
		expect(H(ev("rpc payload", "rpc"))).toEqual({ action: "continue" });
		expect(run.drain()).toEqual([]);
		setActiveRun(null);
	});

	it("SCENARIO-005: active run + source 'extension' → continue, queue untouched", () => {
		const run = createActiveRun();
		setActiveRun(run);
		expect(H(ev("extension payload", "extension"))).toEqual({ action: "continue" });
		expect(run.drain()).toEqual([]);
		setActiveRun(null);
	});

	it("SCENARIO-003: no active run + interactive → continue, nothing captured", () => {
		expect(getActiveRun()).toBeNull();
		expect(H(ev("hello", "interactive"))).toEqual({ action: "continue" });
	});

	it("SCENARIO-006: a push that throws is swallowed → handler returns continue, never throws", () => {
		const run = createActiveRun();
		run.push = () => {
			throw new Error("capture boom");
		};
		setActiveRun(run);
		let res: unknown;
		expect(() => {
			res = H(ev("x", "interactive"));
		}).not.toThrow();
		expect(res).toEqual({ action: "continue" }); // safe fallback; run state intact
		setActiveRun(null);
	});

	it("SCENARIO-007: empty / whitespace-only interactive input is never queued", () => {
		const run = createActiveRun();
		setActiveRun(run);
		for (const blank of ["", "   ", "\n\t  "]) {
			expect(() => H(ev(blank, "interactive"))).not.toThrow();
		}
		expect(run.drain()).toEqual([]); // no spurious guidance entry
		setActiveRun(null);
	});
});

describe("Phase 1 — drain() atomic return-and-clear (AC-05 / SCENARIO-013)", () => {
	beforeEach(resetRun);

	it("returns all pending inputs together and clears the queue", () => {
		const run = createActiveRun();
		run.push("first");
		run.push("second");
		expect(run.drain()).toEqual(["first", "second"]);
	});

	it("a second drain returns nothing until new input arrives", () => {
		const run = createActiveRun();
		run.push("only");
		run.drain(); // drains once
		expect(run.drain()).toEqual([]); // cleared — never double-injected
		run.push("after");
		expect(run.drain()).toEqual(["after"]); // only newly captured input
	});
});
