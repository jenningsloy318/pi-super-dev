/**
 * v0.3.64 — delegation-ONLY specialist execution (L2) and FleetView visibility
 * wrapping (L1) in realAgent.
 *
 * The session and subprocess backends were deleted in v0.3.64 (pi-subagents is
 * a hard requirement). Contract under test:
 *  - an event bus on RunOptions routes EVERY call through
 *    runAgentViaDelegation (a structured-delegation request appears on the
 *    bus, and its terminal response becomes the agent result) — including
 *    browser and web-research roles, whose extension tools now ride the sd-*
 *    registration's per-agent `extensions` (verified live against
 *    pi-subagents 0.64 and 0.65 on 2026-09-04).
 *  - NO event bus (standalone CLI) fails CLOSED with an actionable per-call
 *    error naming extension mode — never a crash, never a silent fallback.
 *  - owner absent (no pi-subagents in the process) fails CLOSED with the
 *    install remedy; no delegation request is ever emitted (20-min hang
 *    prevented, v0.3.26 origin).
 *  - the version-skew class (v0.3.63: `pi update` swapped the package under a
 *    live session) fails CLOSED with the restart remedy AND is sticky: later
 *    calls fail fast without emitting a request (2026-09-04 incident: every
 *    agent of two stages died in ~5s each).
 *  - an "Unknown agent" answer surfaces as the call's error (delegation
 *    attempted once — NOT sticky; the registration seam re-registers on pi
 *    restart).
 *  - regardless of execution path, an agent call publishes a FleetView
 *    external run (register + terminal update) when visibility inputs are
 *    available, and never when they are not.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";

const captured: {
	delegationRequests: any[];
} = { delegationRequests: [] };

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
 *  (never probed) must NOT fail — only a definite `false` does. */
const ownerProbe = vi.hoisted(() => ({ present: null as boolean | null }));
vi.mock("../src/agents/register-agents.ts", () => ({
	delegationOwnerPresent: vi.fn(() => ownerProbe.present),
}));

import { makeContext } from "../src/workflow.ts";
import { isDelegationRuntimeExtensionFailure, resetDelegationBackendDegradeForTests } from "../src/agents/delegation-backend.ts";
import type { AgentCall, PipelineState, RunOptions } from "../src/types.ts";

const mkCtx = (state: PipelineState, options: RunOptions = {}) =>
	makeContext(state, "t", options, () => {});

const CALL: AgentCall = { id: "pipeline.judge.a1", agent: "judge", prompt: "ORIG PROMPT\n\nOutput <control> JSON with: route." };

/** A fake pi EventEmitter that ALSO plays the pi-subagents owner: every
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

describe("delegation-only specialist execution (v0.3.64)", () => {
	beforeEach(() => {
		// v0.3.63: the version-skew fail-fast is sticky module state — reset it
		// so tests are order-independent.
		resetDelegationBackendDegradeForTests();
		ownerProbe.present = null;
	});

	it("routes every specialist call through the delegation bridge when an event bus is present", async () => {
		captured.delegationRequests = [];
		const { bus } = ownerBus();
		const result = await mkCtx({ setup: { specIdentifier: "spec-t1" } as any }, { events: bus } as RunOptions).agent(CALL);
		expect(captured.delegationRequests.length).toBeGreaterThanOrEqual(1);
		expect(captured.delegationRequests[0].agent).toBe("sd-judge");
		expect(captured.delegationRequests[0].task).toContain("ORIG PROMPT");
		expect(captured.delegationRequests[0].ownerRunId).toBeTruthy();
		expect(result.control).toEqual({ route: "escalate-now" });
		expect(result.model).toBe("fake/model-1");
	});

	it("fails CLOSED without an event bus (standalone CLI) — actionable error, never a crash", async () => {
		captured.delegationRequests = [];
		const result = await mkCtx({}, {} as RunOptions).agent(CALL);
		expect(captured.delegationRequests).toHaveLength(0);
		expect(result.error).toContain("extension mode");
		expect(result.control).toBeNull();
	});

	it("browser and web-research agents DELEGATE like every other role — their extension tools ride the registration's per-agent extensions (v0.3.64; verified live on 0.64 and 0.65, 2026-09-04)", async () => {
		captured.delegationRequests = [];
		const { bus } = ownerBus();
		await mkCtx({}, { events: bus } as RunOptions).agent({ ...CALL, agent: "ui-tester" });
		await mkCtx({}, { events: bus } as RunOptions).agent({ ...CALL, agent: "research-agent" });
		expect(captured.delegationRequests.filter((r: any) => r.agent === "sd-ui-tester")).toHaveLength(1);
		expect(captured.delegationRequests.filter((r: any) => r.agent === "sd-research-agent")).toHaveLength(1);
	});

	it("fails CLOSED with the install remedy when the registration handshake found no pi-subagents owner (20-min hang prevented)", async () => {
		ownerProbe.present = false;
		captured.delegationRequests = [];
		const { bus } = ownerBus();
		const result = await mkCtx({ setup: { specIdentifier: "spec-t3" } as any }, { events: bus } as RunOptions).agent(CALL);
		expect(captured.delegationRequests).toHaveLength(0); // never even asked
		expect(result.error).toContain("pi install npm:pi-subagents");
		expect(result.control).toBeNull();
	});

	it("an 'Unknown agent' answer surfaces as the call's error (no fallback backend since v0.3.64) and is NOT sticky (run 2026-08-28T15-50-08 origin)", async () => {
		captured.delegationRequests = [];
		const { bus } = failingOwnerBus("Unknown agent: sd-task-classifier");
		const result = await mkCtx({ setup: { specIdentifier: "spec-t1" } as any }, { events: bus } as RunOptions).agent(CALL);
		expect(captured.delegationRequests.length).toBeGreaterThanOrEqual(1); // delegation WAS tried
		expect(result.error).toContain("Unknown agent");
		// Not sticky: a later call attempts delegation again (a restart may have
		// re-registered the roster).
		captured.delegationRequests = [];
		await mkCtx({ setup: { specIdentifier: "spec-t1" } as any }, { events: bus } as RunOptions).agent(CALL);
		expect(captured.delegationRequests.length).toBeGreaterThanOrEqual(1);
	});

	it("other delegation errors surface as the call's error (real failures stay visible)", async () => {
		captured.delegationRequests = [];
		const { bus } = failingOwnerBus("spawn crashed: oom");
		const result = await mkCtx({ setup: { specIdentifier: "spec-t2" } as any }, { events: bus } as RunOptions).agent(CALL);
		expect(result.error).toContain("oom");
	});

	it("a version-skew runtime-extension failure fails CLOSED with the restart remedy AND is sticky (2026-09-04 incident: every agent of two stages died in ~5s)", async () => {
		captured.delegationRequests = [];
		// Byte-identical shape to the 2026-09-04 14:57 run.log error: an in-memory
		// 0.64 bridge spawned `pi` CLI children with -e pointing at the on-disk
		// 0.65 subagent-prompt-runtime.ts whose activate signature gained a config.
		const skewError = 'Failed to load extension "/home/jenningsl/.pi/agent/npm/node_modules/pi-subagents/src/runs/shared/subagent-prompt-runtime.ts": Failed to load extension: Cannot read properties of undefined (reading \'runtimeAcknowledgements\')';
		const { bus } = failingOwnerBus(skewError);
		// Call 1: delegation attempted once, fails with the named remedy.
		const first = await mkCtx({ setup: { specIdentifier: "spec-skew" } as any }, { events: bus } as RunOptions).agent(CALL);
		expect(captured.delegationRequests).toHaveLength(1);
		expect(first.error).toContain("Restart pi");
		// Call 2: sticky — no second delegation request (no per-call 5s burn).
		captured.delegationRequests = [];
		const second = await mkCtx({ setup: { specIdentifier: "spec-skew" } as any }, { events: bus } as RunOptions).agent(CALL);
		expect(captured.delegationRequests).toHaveLength(0);
		expect(second.error).toContain("Restart pi");
	});

	it("an extension-load failure OUTSIDE pi-subagents' package is NOT the version-skew class (error stays visible, not sticky)", async () => {
		captured.delegationRequests = [];
		const { bus } = failingOwnerBus('Failed to load extension "/tmp/repro-cwd/other-extension.js": Failed to load extension: boom');
		const result = await mkCtx({ setup: { specIdentifier: "spec-t4" } as any }, { events: bus } as RunOptions).agent(CALL);
		expect(result.error).toContain("other-extension.js");
	});
});

describe("delegation version-skew classifier (v0.3.63)", () => {
	it("matches the production byte shape (pi CLI -e startup failure inside pi-subagents' own files)", () => {
		expect(isDelegationRuntimeExtensionFailure('Error: Failed to load extension "/home/jenningsl/.pi/agent/npm/node_modules/pi-subagents/src/runs/shared/subagent-prompt-runtime.ts": Failed to load extension: Cannot read properties of undefined (reading \'runtimeAcknowledgements\')')).toBe(true);
	});
	it("matches any pi-subagents-internal extension path, not just prompt-runtime", () => {
		expect(isDelegationRuntimeExtensionFailure('Failed to load extension "/x/y/pi-subagents/src/runs/shared/fast-mode-extension.ts": anything')).toBe(true);
	});
	it("rejects non-pi-subagents extension failures", () => {
		expect(isDelegationRuntimeExtensionFailure('Failed to load extension "/tmp/foo.ts": boom')).toBe(false);
	});
	it("rejects ordinary errors and empty input", () => {
		expect(isDelegationRuntimeExtensionFailure("spawn crashed: oom")).toBe(false);
		expect(isDelegationRuntimeExtensionFailure("Unknown agent: sd-x")).toBe(false);
		expect(isDelegationRuntimeExtensionFailure(undefined)).toBe(false);
		expect(isDelegationRuntimeExtensionFailure("")).toBe(false);
	});
});

describe("FleetView visibility wrap (v0.3.25 L1)", () => {
		it("registers an external run and records the terminal state for every agent call (sessionId present)", async () => {
			fleet.begun = []; fleet.updated = []; fleet.finished = [];
			const { bus } = ownerBus('ok <control>{"a":1}</control>');
			const result = await mkCtx({ setup: { specIdentifier: "spec-t1" } as any }, { sessionId: "sess-1", events: bus } as RunOptions).agent(CALL);
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
		it("records the terminal row as failed with the error preview when the backend errors", async () => {
			fleet.begun = []; fleet.updated = []; fleet.finished = [];
			const { bus } = failingOwnerBus("child crashed");
			await mkCtx({ setup: { specIdentifier: "spec-t1" } as any }, { sessionId: "sess-2", events: bus } as RunOptions).agent(CALL);
			expect(fleet.finished).toHaveLength(1);
			expect(fleet.finished[0].state).toBe("failed");
			expect(String(fleet.finished[0].preview)).toContain("child crashed");
		});
	});
