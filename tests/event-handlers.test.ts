import { describe, expect, it, vi } from "vitest";
import { adjudicateInputEvent, reportSessionShutdown, instructionForEntry } from "../src/extension/event-handlers.ts";
import type { ActiveRun } from "../src/extension/run-state.ts";

type FixtureCall = [text: string, images: unknown, meta: unknown];
function runOf(
	pushImpl: (text: string, images: unknown, meta: unknown) => { id: string; text: string; images: unknown[] } | null,
	queue: Array<{ id: string; text: string }> = [{ id: "x", text: "t" }],
): { run: ActiveRun; calls: FixtureCall[] } {
	// The push APPENDS to the fixture queue (adversarial F1): a pre-push
	// queue.length read in the adjudicator lands one shy of the post-push
	// depth and fails the payload assertion below. calls[] records every
	// invocation (the spy surface the wrapper hides).
	const calls: FixtureCall[] = [];
	const run = {
		queue,
		push: (text: string, images: unknown, meta: unknown) => {
			calls.push([text, images, meta]);
			const instruction = pushImpl(text, images, meta);
			if (instruction !== null) queue.push({ id: String(queue.length + 1), text });
			return instruction;
		},
	} as unknown as ActiveRun;
	return { run, calls };
}

describe("extension/event-handlers — wave 3 increment 5 (input adjudication + shutdown report)", () => {
	it("idle (no run): continue, always", () => {
		expect(adjudicateInputEvent(null, { source: "interactive", text: "hello" })).toMatchObject({ action: "continue" });
	});

	it("non-interactive sources are never captured (rpc/extension/print/json/headless)", () => {
		const { run, calls } = runOf(() => null);
		for (const source of ["rpc", "extension", "print", "json", "headless"]) {
			expect(adjudicateInputEvent(run, { source, text: "hello" })).toMatchObject({ action: "continue" });
		}
		expect(calls).toHaveLength(0);
	});

	it("slash commands pass through so /reload, /model keep working mid-run", () => {
		const { run, calls } = runOf(() => null);
		expect(adjudicateInputEvent(run, { source: "interactive", text: "  /model glm-5.3" })).toMatchObject({ action: "continue" });
		expect(calls).toHaveLength(0);
	});

	it("the parent: escape strips the prefix and transforms to the parent agent", () => {
		const { run, calls } = runOf(() => null);
		expect(adjudicateInputEvent(run, { source: "interactive", text: "  parent: stop the run" })).toEqual({ action: "transform", text: "stop the run" });
		expect(adjudicateInputEvent(run, { source: "interactive", text: "parent:" })).toMatchObject({ action: "continue" }); // empty payload: continue
		expect(calls).toHaveLength(0);
	});

	it("interactive mid-run text is CAPTURED: push + handled, the instruction + queue depth ride the result", () => {
		const instruction = { id: "ui-1", text: "fix the colors", images: [] } as never;
		const { run, calls } = runOf(() => instruction);
		const out = adjudicateInputEvent(run, { source: "interactive", text: "fix the colors", images: [{ mediaType: "image/png", path: "/x.png" }], streamingBehavior: "steer" });
		// queue was 1 pre-push, 2 post-push — the payload must read the POST-push depth (adversarial F1)
		expect(out).toEqual({ action: "handled", instruction, queued: 2 });
		expect(calls).toEqual([["fix the colors", [{ mediaType: "image/png", path: "/x.png" }], { source: "interactive", streamingBehavior: "steer" }]]);
	});

	it("a missing/blank text never crashes (coerced; push decides via its own empty guard)", () => {
		const { run } = runOf(() => null);
		expect(adjudicateInputEvent(run, { source: "interactive", text: undefined }).action).toBe("handled");
	});

	it("a throwing push degrades to continue (SCENARIO-006/023 — the run always completes)", () => {
		const { run } = runOf(() => { throw new Error("boom"); });
		expect(adjudicateInputEvent(run, { source: "interactive", text: "hi" })).toEqual({ action: "continue" });
	});

	it("instructionForEntry strips image bytes to the telemetry triple", () => {
		const entry = instructionForEntry({ id: "i", text: "t", images: [{ mediaType: "image/png", path: "/a.png", label: "L", data: "HUGE" } as never] } as never);
		expect(entry.images).toEqual([{ mediaType: "image/png", path: "/a.png", label: "L" }]);
	});

	it("reportSessionShutdown: the in-flight line names the guard's run dir; dropped work lines name kind+dir; dispose runs", () => {
		const appendEntry = vi.fn();
		let disposed = false;
		const settled = Promise.resolve();
		const clear = vi.fn();
		reportSessionShutdown(
			{ appendEntry },
			{ reason: "user quit" },
			{
				inFlight: true,
				activeRun: { queue: [] },
				getRunGuard: () => ({ runDir: "/runs/r1" }),
				pendingBackgroundWork: () => [[settled, { runDir: "/runs/r1", kind: "post-mortem" }]],
				clearPendingBackgroundWork: clear,
				disposeAgents: () => { disposed = true; },
			},
		);
		const lines = appendEntry.mock.calls.map((c) => c[1].line as string);
		expect(lines[0]).toContain("STILL IN FLIGHT (run dir: /runs/r1)");
		expect(lines[1]).toContain("post-run post-mortem for /runs/r1 was in flight and is DROPPED");
		expect(disposed).toBe(true);
		expect(clear).toHaveBeenCalledTimes(1); // adversarial F2: a forgetful clear fails
	});
});
