/**
 * v0.3.84 — duplicate_node incident class (run 2026-09-08T23-27-36-732Z).
 *
 * Root cause (three co-factors, all pinned to file:line):
 *  1. delegation-backend.ts composed nodeId as `pipeline.${agent}` —
 *     DETERMINISTIC per agent, so a retry of the same agent reuses the exact
 *     (ownerRunId, nodeId) identity tuple. The header comment claimed "the
 *     per-call id" but no call-unique component ever existed.
 *  2. pi-subagents rejects a delegation whose (ownerRunId, nodeId) is still
 *     ACTIVE with terminal status `duplicate_node`, and cancel-settle is
 *     ASYNC (controller.abort → in-flight child rejects → finally removes the
 *     node) — observed settle window < 1s.
 *  3. Our timeout wrapper cancels at timeoutMs + 2s grace — BEFORE
 *     pi-subagents' internal child deadline whenever child-start skew
 *     exceeds the 2s grace — and the convergence loop re-dispatched the next
 *     round 182ms later: cancel-in-flight + instant retry + colliding id =
 *     `duplicate_node`, which the v0.3.65 fuse counted as the 3rd
 *     consecutive agent error → FatalAbort.
 *
 * Class fix:
 *  - nodeId is per-ATTEMPT unique (`base@requestId`) — a fresh attempt can
 *    never collide with a still-settling one, whatever fired first.
 *  - belt-and-suspenders: one bounded backoff retry on a duplicate_node
 *    terminal (the attempt never started — 43ms rejection, no usage burned),
 *    SUPER_DEV_DUPLICATE_NODE_RETRY_MS default 2000, exactly one retry.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { runAgentViaDelegation } from "../src/agents/delegation-backend.ts";

/** Fake bus playing the pi-subagents owner; `answer(nth, req)` returns a
 *  terminal for the nth request so tests can script retry sequences —
 *  returning undefined NEVER answers (lets timeout/cancel paths fire). */
function bus(answer: (nth: number, req: any) => any, onLog?: (line: string) => void) {
	const b = new EventEmitter() as any;
	const requests: any[] = [];
	const cancels: any[] = [];
	b.on("prompt-template:subagent:request", (req: any) => {
		const nth = requests.length;
		requests.push(req);
		const reply = answer(nth, req);
		if (reply !== undefined) queueMicrotask(() => b.emit("prompt-template:subagent:response", {
			requestId: req.requestId, ownerRunId: req.ownerRunId, nodeId: req.nodeId,
			...reply,
		}));
	});
	b.on("prompt-template:subagent:cancel", (p: any) => cancels.push(p));
	const progress = { event: (m: string) => onLog?.(m) };
	return { b, requests, cancels, progress };
}

const OPTS = (b: any, progress: any, extra: Record<string, unknown> = {}) => ({
	agent: "spec-writer", prompt: "WRITE THE SPEC", cwd: "/tmp",
	controlKeys: ["verdict"], events: b, ownerRunId: "run-1", onProgress: progress,
	...extra,
} as any);

const completedText = (text: string) => ({ status: "completed", result: { kind: "text", text }, model: "fake/m" });
const CONTROL_OK = 'ok <control>{"verdict":"approve"}</control>';

describe("v0.3.84 — per-attempt unique nodeIds (incident 2026-09-08T23-27-36)", () => {
	it("two sequential calls of the SAME agent get DIFFERENT nodeIds, each embedding its own requestId", async () => {
		const { b, requests, progress } = bus(() => completedText(CONTROL_OK));
		await runAgentViaDelegation(OPTS(b, progress));
		await runAgentViaDelegation(OPTS(b, progress));
		expect(requests.length).toBe(2);
		expect(requests[0].nodeId).not.toBe(requests[1].nodeId);
		expect(requests[0].nodeId).toContain("@");
		expect(requests[0].nodeId).toContain(requests[0].requestId);
		expect(requests[1].nodeId).toContain(requests[1].requestId);
	});

	it("the logical base stays in the prefix: default `pipeline.<agent>@…`, caller id `<id>@…`", async () => {
		const d = bus(() => completedText(CONTROL_OK));
		await runAgentViaDelegation(OPTS(d.b, d.progress));
		expect(d.requests[0].nodeId.startsWith("pipeline.spec-writer@")).toBe(true);

		const c = bus(() => completedText(CONTROL_OK));
		await runAgentViaDelegation(OPTS(c.b, c.progress, { id: "n1" }));
		expect(c.requests[0].nodeId.startsWith("n1@")).toBe(true);
	});

	it("a corrective re-attempt (missing control key) also gets a fresh nodeId", async () => {
		const { b, requests, progress } = bus((nth) =>
			nth === 0 ? completedText("no control here") : completedText(CONTROL_OK));
		const r = await runAgentViaDelegation(OPTS(b, progress));
		expect(r.error).toBeUndefined();
		expect(requests.length).toBe(2);
		expect(requests[0].nodeId).not.toBe(requests[1].nodeId);
	});

	it("the cancel event carries the EXACT composed nodeId of the request it kills", async () => {
		const { b, requests, cancels, progress } = bus(() => undefined);
		const r = await runAgentViaDelegation(OPTS(b, progress, { timeoutMs: 40 }));
		expect(r.error).toContain("timed out after 40ms");
		expect(cancels.length).toBe(1);
		expect(cancels[0].nodeId).toBe(requests[0].nodeId);
		expect(cancels[0].requestId).toBe(requests[0].requestId);
	});
});

describe("v0.3.84 — duplicate_node bounded retry (belt-and-suspenders)", () => {
	beforeEach(() => { process.env.SUPER_DEV_DUPLICATE_NODE_RETRY_MS = "0"; });
	afterEach(() => { delete process.env.SUPER_DEV_DUPLICATE_NODE_RETRY_MS; });

	it("a duplicate_node terminal retries ONCE after backoff and succeeds", async () => {
		const lines: string[] = [];
		const { b, requests } = bus((nth) =>
			nth === 0 ? { status: "duplicate_node" } : completedText(CONTROL_OK));
		const r = await runAgentViaDelegation(OPTS(b, { event: (m: string) => lines.push(m) }));
		expect(r.error).toBeUndefined();
		expect(r.control).toEqual({ verdict: "approve" });
		expect(requests.length).toBe(2);
		// the retry re-sends the ORIGINAL task (no corrective suffix)
		expect(requests[1].task).toBe(requests[0].task);
		expect(lines.some((l) => l.includes("duplicate_node") && l.includes("retry"))).toBe(true);
	});

	it("duplicate_node TWICE stays bounded: exactly one retry, then the honest error", async () => {
		const { b, requests, progress } = bus(() => ({ status: "duplicate_node" }));
		const r = await runAgentViaDelegation(OPTS(b, progress));
		expect(requests.length).toBe(2);
		expect(r.error).toContain("delegation ended with status duplicate_node");
	});

	it("a completed first attempt never pays the backoff (single request)", async () => {
		const { b, requests, progress } = bus(() => completedText(CONTROL_OK));
		const r = await runAgentViaDelegation(OPTS(b, progress));
		expect(requests.length).toBe(1);
		expect(r.error).toBeUndefined();
	});

	it("C2: a garbage-huge retry knob is CLAMPED to 60s and an aborted parent cuts the sleep — retry skipped, honest duplicate error (dual review 2026-09-09)", async () => {
		// the incident's own unblock value (3600000) must NOT hang the call for an hour:
		// the announced backoff is clamped to 60000ms, and aborting 20ms in returns fast.
		process.env.SUPER_DEV_DUPLICATE_NODE_RETRY_MS = "3600000";
		const lines: string[] = [];
		const { b, requests } = bus((nth) =>
			nth === 0 ? { status: "duplicate_node" } : completedText(CONTROL_OK));
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 20);
		const t0 = Date.now();
		const r = await runAgentViaDelegation(OPTS(b, { event: (m: string) => lines.push(m) }, { signal: controller.signal }));
		expect(Date.now() - t0).toBeLessThan(5_000);
		expect(lines.some((l) => l.includes("after 60000ms backoff"))).toBe(true);
		expect(lines.some((l) => l.includes("3600000"))).toBe(false);
		// aborted parent skips the retry: only the rejected first attempt exists
		expect(requests.length).toBe(1);
		expect(r.error).toContain("duplicate_node");
		expect(r.control).toBeNull();
	});
});
