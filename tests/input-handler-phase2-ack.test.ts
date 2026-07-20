/**
 * Phase 2 (RED) tests — ActiveRun.push() ACK surfaces (AC-04 / AC-07).
 *
 * Scope (from the implementation plan + spec testing strategy):
 *   Wire `ActiveRun.push(text)` to update THREE TUI-only ACK surfaces, each
 *   guarded by `ctx?.mode === "tui"` and wrapped best-effort try/catch:
 *     (a) status pill  : ctx.ui.setStatus("super-dev-input", "📥 queued: <preview ~60ch>")
 *     (b) dashboard    : a `📥 N mid-run input(s)` count line (pending-yet-to-be-injected)
 *     (c) transcript   : a user-input line via the live stream's userInput(text) sink
 *
 *   The `"super-dev-input"` status key is cleared in the execute() `finally`
 *   (SCENARIO-010); non-TUI modes never call setStatus/setWidget for this
 *   feature (SCENARIO-012 / SCENARIO-020).
 *
 * WIRING CONTRACT this file pins down (the natural seam given execute() already
 * holds a local `stream` handle and calls `createActiveRun(ctx)`):
 *   `createActiveRun(ctx?, stream?)` — Phase 2 adds the optional `stream`
 *   (a LiveStreamHandle) so push() can reach `stream.sink.userInput(text)`.
 *   Passing no `stream` keeps Phase 1 behavior (queue + no ACK) intact, so the
 *   existing Phase 1 tests stay green.
 *
 * These tests reference behavior that DOES NOT EXIST YET:
 *   - push() does NOT currently call setStatus / push a transcript line, and
 *     `createActiveRun` ignores its 2nd arg → the ACK assertions FAIL (RED).
 *
 * Coverage:
 *   AC-04 → SCENARIO-008 (TUI push surfaces pill + count + transcript)
 *   AC-04 → SCENARIO-010 (status key pill on a known key)
 *   AC-04 → SCENARIO-012 (non-TUI / no-ctx → NO ACK calls, still queues)
 *   AC-07 → SCENARIO-009 (the transcript line flows through the sink)
 *
 * Dashboard count: the decoupled observable is "N pushes → N pending user-input
 * inputs tracked" (one transcript line each + queue.length === N). How the
 * dashboard RENDER surfaces `📥 N mid-run input(s)` is an impl detail of
 * execute()'s renderDashboard() closure (untestable in isolation); this file
 * asserts the count the dashboard would read.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import * as ext from "../src/extension.ts";
import { createLiveStream } from "../src/render/live-stream.ts";

const createActiveRun = (ctx?: unknown, stream?: unknown): any =>
	(ext as any).createActiveRun(ctx, stream);
const setActiveRun = (run: unknown): void => (ext as any).setActiveRun(run);

/** A minimal TUI mock ctx: spies on ui.setStatus / setWidget. */
function makeCtx(mode: string | undefined) {
	const setStatus = vi.fn();
	const setWidget = vi.fn();
	return {
		mode,
		ui: { setStatus, setWidget },
	};
}

/** Reset module singleton between tests so no state leaks across cases. */
const resetRun = () => {
	try {
		setActiveRun(null);
	} catch {
		/* export not implemented yet — fine for RED */
	}
};

describe("Phase 2 — push() ACK surfaces in TUI mode (AC-04 / SCENARIO-008 / SCENARIO-010)", () => {
	beforeEach(resetRun);

	it("push(text) sets the 'super-dev-input' status pill with the queued preview", () => {
		const ctx = makeCtx("tui");
		const stream = createLiveStream({ mode: "tui" });
		const run = createActiveRun(ctx, stream);
		run.push("focus on the auth bug");
		expect(ctx.ui.setStatus).toHaveBeenCalledTimes(1);
		const [key, value] = ctx.ui.setStatus.mock.calls[0];
		expect(key).toBe("super-dev-input");
		expect(value).toMatch(/^📥 queued: /);
		expect(value).toContain("focus on the auth bug");
	});

	it("push(text) writes a user-input transcript line via the live stream sink", () => {
		const ctx = makeCtx("tui");
		const stream = createLiveStream({ mode: "tui" });
		const run = createActiveRun(ctx, stream);
		run.push("steer toward tests");
		expect(stream.getTranscript()).toContainEqual({
			kind: "user-input",
			text: "📥 steer toward tests",
		});
	});

	it("the pill preview is ellipsized for long input (~60 chars)", () => {
		const ctx = makeCtx("tui");
		const stream = createLiveStream({ mode: "tui" });
		const run = createActiveRun(ctx, stream);
		const long = "x".repeat(200);
		run.push(long);
		const value = ctx.ui.setStatus.mock.calls[0][1] as string;
		// preview must be bounded — the full 200-char input must NOT appear verbatim.
		expect(value.length).toBeLessThan(120);
		expect(value).not.toContain("x".repeat(100));
		expect(value).toMatch(/^📥 queued: /);
	});

	it("push() still enqueues the text for drain() (ACK does not consume the queue)", () => {
		const ctx = makeCtx("tui");
		const stream = createLiveStream({ mode: "tui" });
		const run = createActiveRun(ctx, stream);
		run.push("first");
		run.push("second");
		// The count the dashboard reads (pending-yet-to-be-injected) === queue length.
		expect(run.queue.length).toBe(2);
		expect(run.drain()).toEqual(["first", "second"]);
	});

	it("count signal: N pushes produce N user-input transcript lines", () => {
		const ctx = makeCtx("tui");
		const stream = createLiveStream({ mode: "tui" });
		const run = createActiveRun(ctx, stream);
		run.push("a");
		run.push("b");
		run.push("c");
		const count = stream.getTranscript().filter((l) => l.kind === "user-input").length;
		expect(count).toBe(3);
	});
});

describe("Phase 2 — push() ACK is TUI-only (AC-04 / SCENARIO-012 / SCENARIO-020)", () => {
	beforeEach(resetRun);

	for (const mode of ["print", "json", "headless"]) {
		it(`non-TUI mode '${mode}' → NO setStatus pill and NO transcript line`, () => {
			const ctx = makeCtx(mode);
			const stream = createLiveStream({ mode });
			const run = createActiveRun(ctx, stream);
			run.push("hello");
			expect(ctx.ui.setStatus).not.toHaveBeenCalled();
			expect(
				stream.getTranscript().some((l) => l.kind === "user-input"),
			).toBe(false);
			// input is still captured for later injection (delivery guarantee is backend-independent).
			expect(run.drain()).toEqual(["hello"]);
		});
	}

	it("undefined mode (no ctx.mode) → NO ACK calls, still queues", () => {
		const ctx = makeCtx(undefined);
		const stream = createLiveStream({});
		const run = createActiveRun(ctx, stream);
		run.push("queued silently");
		expect(ctx.ui.setStatus).not.toHaveBeenCalled();
		expect(run.drain()).toEqual(["queued silently"]);
	});

	it("no ctx at all (Phase 1 idle-shape run) → push() never throws, still queues", () => {
		const run = createActiveRun();
		expect(() => run.push("ctxless")).not.toThrow();
		expect(run.drain()).toEqual(["ctxless"]);
	});

	it("no stream attached → push() never throws, still queues (Phase 1 compat)", () => {
		const ctx = makeCtx("tui");
		const run = createActiveRun(ctx); // 2nd arg omitted
		expect(() => run.push("no-stream")).not.toThrow();
		expect(ctx.ui.setStatus).not.toHaveBeenCalled(); // no sink → no transcript, no pill needed
		expect(run.drain()).toEqual(["no-stream"]);
	});
});

describe("Phase 2 — push() ACK is best-effort / no-throw (AC-04 / SCENARIO-006)", () => {
	beforeEach(resetRun);

	it("a throwing setStatus is swallowed — push() still queues and never throws", () => {
		const ctx = makeCtx("tui");
		ctx.ui.setStatus = vi.fn(() => {
			throw new Error("status boom");
		});
		const stream = createLiveStream({ mode: "tui" });
		const run = createActiveRun(ctx, stream);
		expect(() => run.push("resilient")).not.toThrow();
		expect(run.drain()).toEqual(["resilient"]); // captured despite ACK failure
	});

	it("a throwing userInput sink is swallowed — push() still queues", () => {
		const ctx = makeCtx("tui");
		const stream = createLiveStream({ mode: "tui" });
		// Sabotage the sink so the transcript push throws.
		(stream.sink as any).userInput = () => {
			throw new Error("sink boom");
		};
		const run = createActiveRun(ctx, stream);
		expect(() => run.push("resilient-2")).not.toThrow();
		expect(run.drain()).toEqual(["resilient-2"]);
	});
});

describe("Phase 2 — empty/whitespace input is never ACK'd or queued (AC-04 / SCENARIO-007)", () => {
	beforeEach(resetRun);

	it("empty / whitespace-only text → no pill, no transcript line, queue empty", () => {
		const ctx = makeCtx("tui");
		const stream = createLiveStream({ mode: "tui" });
		const run = createActiveRun(ctx, stream);
		for (const blank of ["", "   ", "\n\t  "]) {
			expect(() => run.push(blank)).not.toThrow();
		}
		expect(ctx.ui.setStatus).not.toHaveBeenCalled();
		expect(stream.getTranscript().some((l) => l.kind === "user-input")).toBe(false);
		expect(run.drain()).toEqual([]); // no spurious guidance entry
	});
});
