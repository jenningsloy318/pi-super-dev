/**
 * Phase 1 strengthening tests — additional edge-case coverage for the
 * Run-state singleton & once-registered input listener.
 *
 * This file COMPLEMENTS tests/input-handler.test.ts (which covers AC-01,
 * AC-02, AC-03, AC-05 → SCENARIO-001..-007, -013). It adds the gaps the
 * primary suite does not assert, all of which are in-scope for Phase 1
 * (no dependency on Phase 2 ACK surfaces or Phase 3 provider wiring):
 *
 *   - `createActiveRun(ctx)` STORES ctx on the ActiveRun (Phase 1 binds ctx so
 *     the Phase 2 ACK surfaces can read `activeRun.ctx` — the binding itself
 *     is Phase 1).
 *   - The handler reads the module singleton LAZILY at call-time, NOT a
 *     registration-time snapshot (the whole point of binding once + a mutable
 *     singleton — otherwise re-runs could never capture input).
 *   - push() accumulates in FIFO order across 3+ inputs.
 *   - push() coerces non-string input defensively (null/undefined/number)
 *     and still applies the empty-guard (SCENARIO-007 robustness).
 *   - The handler survives a MALFORMED event (no `text` / no `source` field)
 *     and returns {action:'continue'} without throwing (no-throw fallback).
 *   - drain() returns a fresh empty array for a brand-new run and a DISTINCT
 *     array reference each call (atomic clear, no aliasing of the live queue).
 *
 * All assertions reference src/extension.ts exports: `createActiveRun`,
 * `setActiveRun`, `getActiveRun`, and the handler `pi.events.on("input")`
 * installs. Namespace import is used so a missing export surfaces as a clean
 * undefined rather than a transform-time crash.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import * as ext from "../src/extension.ts";

const activate = (ext as any).default as (pi: any) => void;
const setActiveRun = (run: unknown): void => (ext as any).setActiveRun(run);
const getActiveRun = (): unknown => (ext as any).getActiveRun();
const createActiveRun = (ctx?: unknown): any => (ext as any).createActiveRun(ctx);

function makeMockPi() {
	const handlers: Record<string, Array<(e: any) => any>> = {};
	const events = {
		on: vi.fn((type: string, h: (e: any) => any) => {
			(handlers[type] ??= []).push(h);
		}),
		emit(type: string, e: any) {
			let last: unknown;
			for (const h of handlers[type] ?? []) last = h(e);
			return last;
		},
	};
	const inputCalls = () => (events.on as any).mock.calls.filter((c: any[]) => c[0] === "input");
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

const ev = (text: string, source: string) => ({ type: "input", text, source });

const resetRun = () => {
	try {
		setActiveRun(null);
	} catch {
		/* export missing — RED-safe */
	}
};

describe("Phase 1 coverage — createActiveRun binds ctx (Phase 1 storage contract)", () => {
	beforeEach(resetRun);

	it("createActiveRun(ctx) stores the supplied ctx on the ActiveRun", () => {
		const ctx = { mode: "tui", ui: { setStatus: vi.fn() } };
		const run = createActiveRun(ctx);
		expect(run.ctx).toBe(ctx);
	});

	it("createActiveRun() without ctx leaves ctx undefined (non-TUI / pre-capture)", () => {
		const run = createActiveRun();
		expect(run.ctx).toBeUndefined();
	});

	it("a fresh ActiveRun always starts with an empty queue", () => {
		const run = createActiveRun();
		expect(Array.isArray(run.queue)).toBe(true);
		expect(run.drain()).toEqual([]);
	});
});

describe("Phase 1 coverage — handler reads the singleton LAZILY at call-time", () => {
	beforeEach(resetRun);

	it("handler registered while idle still captures input once a run starts later", () => {
		const pi = makeMockPi();
		activate(pi); // registers the listener while activeRun is null
		const H = pi.inputHandler()!;
		expect(getActiveRun()).toBeNull(); // idle at bind time

		// Start a run AFTER registration — the handler must read the CURRENT
		// singleton value, not a bind-time snapshot.
		const run = createActiveRun();
		setActiveRun(run);
		const res = H(ev("late-start input", "interactive"));
		expect(res).toEqual({ action: "handled" });
		expect(run.drain()).toEqual(["late-start input"]);
		setActiveRun(null);
	});

	it("handler that returned {action:'continue'} when idle returns {action:'handled'} for the SAME call shape once a run is active", () => {
		const pi = makeMockPi();
		activate(pi);
		const H = pi.inputHandler()!;
		// Idle: identical event → continue
		expect(H(ev("same text", "interactive"))).toEqual({ action: "continue" });
		// Active: identical event → handled
		const run = createActiveRun();
		setActiveRun(run);
		expect(H(ev("same text", "interactive"))).toEqual({ action: "handled" });
		expect(run.drain()).toEqual(["same text"]);
		setActiveRun(null);
	});
});

describe("Phase 1 coverage — push() ordering & defensive coercion", () => {
	beforeEach(resetRun);

	it("push preserves FIFO insertion order across many inputs", () => {
		const run = createActiveRun();
		for (const t of ["alpha", "beta", "gamma", "delta", "epsilon"]) run.push(t);
		expect(run.drain()).toEqual(["alpha", "beta", "gamma", "delta", "epsilon"]);
	});

	it("push coerces a numeric value to its string form", () => {
		const run = createActiveRun();
		run.push(42 as unknown as string);
		expect(run.drain()).toEqual(["42"]);
	});

	it("push coerces null/undefined to empty and skips them (empty-guard)", () => {
		const run = createActiveRun();
		run.push(null as unknown as string);
		run.push(undefined as unknown as string);
		expect(run.drain()).toEqual([]); // SCENARIO-007 robustness on coerced blanks
	});

	it("push trims surrounding whitespace before storing (no leading/trailing noise)", () => {
		const run = createActiveRun();
		run.push("  keep the middle  ");
		expect(run.drain()).toEqual(["keep the middle"]);
	});

	it("push only trims — internal whitespace and newlines are preserved", () => {
		const run = createActiveRun();
		run.push("line one\nline two   with   gaps");
		expect(run.drain()).toEqual(["line one\nline two   with   gaps"]);
	});
});

describe("Phase 1 coverage — handler survives malformed events (no-throw fallback)", () => {
	beforeEach(resetRun);

	it("event missing `source` → continue, nothing captured (undefined !== 'interactive')", () => {
		const pi = makeMockPi();
		activate(pi);
		const H = pi.inputHandler()!;
		const run = createActiveRun();
		setActiveRun(run);
		let res: unknown;
		expect(() => {
			res = H({ type: "input", text: "no source" });
		}).not.toThrow();
		expect(res).toEqual({ action: "continue" });
		expect(run.drain()).toEqual([]);
		setActiveRun(null);
	});

	it("event missing `text` → handled is returned but nothing is queued (blank coerced)", () => {
		const pi = makeMockPi();
		activate(pi);
		const H = pi.inputHandler()!;
		const run = createActiveRun();
		setActiveRun(run);
		// text undefined → coerced to "" → empty-guard skips → but it WAS
		// interactive, so the handler still signals handled (pi must not
		// re-queue a blank). The queue stays empty.
		const res = H({ type: "input", source: "interactive" });
		expect(res).toEqual({ action: "handled" });
		expect(run.drain()).toEqual([]);
		setActiveRun(null);
	});

	it("completely empty event object → continue, no throw", () => {
		const pi = makeMockPi();
		activate(pi);
		const H = pi.inputHandler()!;
		const run = createActiveRun();
		setActiveRun(run);
		expect(() => H({})).not.toThrow();
		expect(H({})).toEqual({ action: "continue" }); // no source
		expect(run.drain()).toEqual([]);
		setActiveRun(null);
	});
});

describe("Phase 1 coverage — drain() atomicity & aliasing guarantees", () => {
	beforeEach(resetRun);

	it("drain() returns a DISTINCT array reference each call (not an alias of the live queue)", () => {
		const run = createActiveRun();
		run.push("a");
		const first = run.drain();
		run.push("b");
		const second = run.drain();
		expect(first).not.toBe(second); // fresh arrays, no shared identity
		expect(first).toEqual(["a"]);
		expect(second).toEqual(["b"]);
	});

	it("drain() does NOT mutate the array it already returned when more input is pushed", () => {
		const run = createActiveRun();
		run.push("first");
		const snapshot = run.drain();
		run.push("second");
		run.drain();
		// The earlier-returned array must be untouched by later activity.
		expect(snapshot).toEqual(["first"]);
	});

	it("mutating the returned drain() array does not corrupt the active queue", () => {
		const run = createActiveRun();
		run.push("real");
		const out = run.drain();
		out.push("injected-by-test");
		// queue already cleared by drain; pushing into the returned array must
		// not sneak "injected-by-test" back into the live queue.
		run.push("next");
		expect(run.drain()).toEqual(["next"]);
		expect(run.drain()).not.toContain("injected-by-test");
	});
});
