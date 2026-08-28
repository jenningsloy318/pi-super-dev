/**
 * v0.3.25 — backend selection for the pi-subagents delegation backend (L2)
 * and FleetView visibility wrapping (L1) in realAgent.
 *
 * Contract under test:
 *  - `backend: "pi-subagents"` + an event bus on RunOptions routes the call
 *    through runAgentViaDelegation (a structured-delegation request appears
 *    on the bus, and its terminal response becomes the agent result).
 *  - `backend: "pi-subagents"` WITHOUT an event bus (standalone CLI) is a
 *    graceful fallback to the session backend — never a crash.
 *  - browser/web-research agents keep their forced subprocess routing even
 *    under the pi-subagents backend.
 *  - regardless of backend, an agent call publishes a FleetView external run
 *    (register + terminal update) when visibility inputs are available, and
 *    never when they are not.
 */
import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";

const captured: {
	session?: Record<string, unknown>;
	subprocess?: Record<string, unknown>;
	delegationRequests: any[];
} = { delegationRequests: [] };

vi.mock("../src/session-agent.ts", () => ({
	runAgentViaSession: vi.fn(async (opts: Record<string, unknown>) => {
		captured.session = opts;
		return { text: 'ok <control>{"a":1}</control>', control: { a: 1 } };
	}),
	summarizeSlug: vi.fn(async () => "x"),
}));
vi.mock("../src/pi-spawn.ts", () => ({
	spawnAgent: vi.fn(async (opts: Record<string, unknown>) => {
		captured.subprocess = opts;
		return { text: "ok", control: {} };
	}),
	isBrowserAgent: vi.fn((agent: string) => agent === "ui-tester"),
	needsWebResearch: vi.fn((agent: string) => agent === "research-agent"),
	// delegation-backend imports these — provide honest stubs (review-2 P1).
	defaultAgentTimeoutMs: vi.fn(() => 1_200_000),
	resolveModel: vi.fn(() => undefined),
	resolveThinking: vi.fn(() => undefined),
}));
vi.mock("../src/render/knowledge.ts", () => ({
	knowledgeForAgent: vi.fn(() => ""),
}));

/** Fleet-visibility capture (review-2 finding 11): realAgent must publish a
 *  register/terminal pair per call when visibility inputs exist, and stay
 *  silent when they do not (CLI mode = no sessionId). */
const fleet = vi.hoisted(() => ({
	begun: [] as Array<Record<string, unknown>>,
	updated: [] as string[],
	finished: [] as Array<{ id: string; state: string; preview?: string }>,
}));
vi.mock("../src/agents/fleet-visibility.ts", () => ({
	resolveExternalRunsModule: vi.fn(async () => true),
	fleetBegin: vi.fn((_mod: unknown, run: Record<string, unknown>) => { fleet.begun.push(run); }),
	fleetUpdate: vi.fn((_mod: unknown, _sid: string, _id: string, m: string) => { fleet.updated.push(m); }),
	fleetFinish: vi.fn((_mod: unknown, _sid: string, _id: string, r: { state: string; preview?: string }) => { fleet.finished.push({ id: _id, ...r }); }),
}));

/** v0.3.26 owner-presence probe: controllable per test. Default `null`
 *  (never probed) must NOT degrade — only a definite `false` does. */
const ownerProbe = vi.hoisted(() => ({ present: null as boolean | null }));
vi.mock("../src/agents/register-agents.ts", () => ({
	delegationOwnerPresent: vi.fn(() => ownerProbe.present),
}));

import { makeContext } from "../src/workflow.ts";
import type { AgentCall, PipelineState, RunOptions } from "../src/types.ts";

const mkCtx = (state: PipelineState, options: RunOptions = {}) =>
	makeContext(state, "t", options, () => {});

const CALL: AgentCall = { id: "pipeline.judge.a1", agent: "judge", prompt: "ORIG PROMPT\n\nOutput <control> JSON with: route." };

/** A fake pi EventBus that ALSO plays the pi-subagents owner: every
 *  delegation request is answered with a terminal response (result in the
 *  REAL { kind: "text", text } envelope shape — review-2 P0). */
function ownerBus(resultText = 'done <control>{"route":"escalate-now"}</control>') {
	const bus = new EventEmitter() as any;
	const requests: any[] = [];
	bus.on("prompt-template:subagent:request", (req: any) => {
		requests.push(req);
		captured.delegationRequests.push(req);
		queueMicrotask(() => {
			bus.emit("prompt-template:subagent:response", {
				requestId: req.requestId, ownerRunId: req.ownerRunId, nodeId: req.nodeId,
				status: "completed", result: { kind: "text", text: resultText }, model: "fake/model-1",
			});
		});
	});
	return { bus, requests };
}

/** An owner that answers every delegation request with a FAILED terminal. */
function failingOwnerBus(error: string) {
	const bus = new EventEmitter() as any;
	bus.on("prompt-template:subagent:request", (req: any) => {
		captured.delegationRequests.push(req);
		queueMicrotask(() => {
			bus.emit("prompt-template:subagent:response", {
				requestId: req.requestId, ownerRunId: req.ownerRunId, nodeId: req.nodeId,
				status: "failed", error,
			});
		});
	});
	return { bus };
}

describe("backend selection: pi-subagents delegation", () => {
	it("routes through the delegation bridge when backend=pi-subagents and an event bus is present", async () => {
		captured.delegationRequests = [];
		const { bus } = ownerBus();
		const result = await mkCtx({ setup: { specIdentifier: "spec-t1" } as any }, {
			backend: "pi-subagents",
			events: bus,
		} as RunOptions).agent(CALL);
		expect(captured.delegationRequests.length).toBeGreaterThanOrEqual(1);
		expect(captured.delegationRequests[0].agent).toBe("sd-judge");
		expect(captured.delegationRequests[0].task).toContain("ORIG PROMPT");
		expect(captured.delegationRequests[0].ownerRunId).toBeTruthy();
		expect(result.control).toEqual({ route: "escalate-now" });
		expect(result.model).toBe("fake/model-1");
		expect(captured.session).toBeUndefined(); // did NOT fall back
	});

	it("falls back to the session backend without an event bus (standalone CLI) — no crash, real result", async () => {
		delete captured.session;
		const result = await mkCtx({}, { backend: "pi-subagents" } as RunOptions).agent(CALL);
		expect(captured.session).toBeDefined();
		expect(result.control).toEqual({ a: 1 });
	});

	it("browser and web-research agents stay on the forced subprocess backend even under pi-subagents", async () => {
		delete captured.subprocess;
		const { bus } = ownerBus();
		await mkCtx({}, { backend: "pi-subagents", events: bus } as RunOptions).agent({ ...CALL, agent: "ui-tester" });
		expect(captured.subprocess).toBeDefined();
		expect(captured.delegationRequests.filter((r: any) => r.agent === "sd-ui-tester")).toHaveLength(0);
	});

	it("SUPER_DEV_BACKEND=pi-subagents selects the delegation backend via env", async () => {
		captured.delegationRequests = [];
		process.env.SUPER_DEV_BACKEND = "pi-subagents";
		try {
			const { bus } = ownerBus();
			await mkCtx({}, { events: bus } as RunOptions).agent(CALL);
			expect(captured.delegationRequests.length).toBeGreaterThanOrEqual(1);
		} finally {
			delete process.env.SUPER_DEV_BACKEND;
		}
	});

	it("degrades to the session backend when delegation answers 'Unknown agent' — must not burn convergence rounds (run 2026-08-28T15-50-08: 8 requirements rounds lost in ~2.5s)", async () => {
		ownerProbe.present = null; // probe unknown → delegation still attempted
		captured.delegationRequests = [];
		delete captured.session;
		const { bus } = failingOwnerBus("Unknown agent: sd-task-classifier");
		const result = await mkCtx({ setup: { specIdentifier: "spec-t1" } as any }, { backend: "pi-subagents", events: bus } as RunOptions).agent(CALL);
		expect(captured.delegationRequests.length).toBeGreaterThanOrEqual(1); // delegation WAS tried
		expect(captured.session).toBeDefined(); // ...then degraded to session
		expect(result.control).toEqual({ a: 1 }); // session result surfaced, no error
	});

	it("degrades EVERY call to session without emitting a request when the registration handshake found no pi-subagents owner (20-min hang prevented)", async () => {
		ownerProbe.present = false;
		captured.delegationRequests = [];
		delete captured.session;
		const { bus } = ownerBus();
		const result = await mkCtx({ setup: { specIdentifier: "spec-t3" } as any }, { backend: "pi-subagents", events: bus } as RunOptions).agent(CALL);
		expect(captured.delegationRequests).toHaveLength(0); // never even asked
		expect(captured.session).toBeDefined();
		expect(result.control).toEqual({ a: 1 });
		ownerProbe.present = null;
	});

	it("other delegation errors do NOT trigger the session fallback (real failures stay visible)", async () => {
		captured.delegationRequests = [];
		delete captured.session;
		const { bus } = failingOwnerBus("spawn crashed: oom");
		const result = await mkCtx({ setup: { specIdentifier: "spec-t2" } as any }, { backend: "pi-subagents", events: bus } as RunOptions).agent(CALL);
		expect(captured.session).toBeUndefined();
		expect(result.error).toContain("oom");
	});
});

describe("FleetView visibility wrap (v0.3.25 L1)", () => {
		it("registers an external run and records the terminal state for every agent call (sessionId present)", async () => {
			fleet.begun = []; fleet.updated = []; fleet.finished = [];
			const result = await mkCtx({ setup: { specIdentifier: "spec-t1" } as any }, { sessionId: "sess-1" } as RunOptions).agent(CALL);
			expect(result.control).toEqual({ a: 1 });
			expect(fleet.begun).toHaveLength(1);
			expect(fleet.begun[0].source).toBe("super-dev");
			expect(fleet.begun[0].id).toBe("pipeline.judge.a1");
			expect(fleet.begun[0].label).toBe("judge");
			expect(fleet.finished).toHaveLength(1);
			expect(fleet.finished[0].id).toBe("pipeline.judge.a1");
			expect(fleet.finished[0].state).toBe("completed");
			expect(String(fleet.finished[0].preview)).toContain('"a":1');
		});

		it("stays completely silent without a sessionId (CLI mode — no visibility inputs)", async () => {
			fleet.begun = []; fleet.updated = []; fleet.finished = [];
			await mkCtx({}, {} as RunOptions).agent(CALL);
			expect(fleet.begun).toHaveLength(0);
			expect(fleet.finished).toHaveLength(0);
		});

		it("records the terminal row as failed with the error preview when the backend errors", async () => {
			fleet.begun = []; fleet.updated = []; fleet.finished = [];
			const { bus } = ownerBus();
			bus.on("prompt-template:subagent:request", () => {
				throw new Error("owner exploded");
			});
			// remove the default owner handler? EventEmitter keeps both listeners;
			// instead use a bus that never answers and a tiny timeout via a failing
			// agent: simplest — mock session backend to error.
			const { runAgentViaSession } = await import("../src/session-agent.ts");
			(runAgentViaSession as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => ({ text: "", control: null, error: "child crashed" }));
			await mkCtx({}, { sessionId: "sess-2" } as RunOptions).agent(CALL);
			expect(fleet.finished).toHaveLength(1);
			expect(fleet.finished[0].state).toBe("failed");
			expect(String(fleet.finished[0].preview)).toContain("child crashed");
		});
	});
