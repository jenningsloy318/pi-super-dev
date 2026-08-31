import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";

/**
 * v0.3.25 L2 — the structured-delegation agent backend.
 *
 * super-dev's agent calls (realAgent → runAgentViaSession/spawnAgent) gain a
 * third execution path: pi-subagents' structured delegation API
 * (`prompt-template:subagent:*` events, same executor as the `subagent`
 * tool). Every call then shows up in pi's Fleet UI with real turns/tools/
 * tokens/output logs, is steerable and stoppable — "the subagent same like
 * pi itself".
 *
 * The contract (from pi-subagents@0.58 docs/extension-api.md):
 *  - request:  { version-less payload with requestId, ownerRunId, nodeId,
 *               agent, task, context: "fresh", cwd, model?, thinking?,
 *               timeoutMs?, result: { kind: "text" } }
 *  - terminal: { requestId, ownerRunId, nodeId, status, result, usage, model }
 *               exactly one per attempt; status invalid_request for malformed
 *  - cancel:   the cancel event with the same identity tuple
 *  - identity: ownerRunId + nodeId is the logical node; a second ACTIVE
 *               attempt gets duplicate_node, but a NEW requestId for the same
 *               node is legal once the previous attempt settled (that is the
 *               corrective re-prompt path).
 */

import {
	type DelegationEventBus,
	type DelegationRequestPayload,
	runAgentViaDelegation,
	SD_AGENT_PREFIX,
	delegationAgentName,
} from "../src/agents/delegation-backend.ts";
import type { AgentProgress, SpawnResult } from "../src/types.ts";

/** A fake pi EventBus recording emitted channels + letting tests reply.
 *  `on` returns a real unsubscribe closure — mirroring pi's bus contract
 *  (and pi-subagents' bridge) where `on()`'s RETURN is the detach handle. */
class FakeBus implements DelegationEventBus {
	readonly emitted: Array<{ channel: string; payload: unknown }> = [];
	private readonly bus = new EventEmitter();
	on(channel: string, handler: (payload: unknown) => void): unknown {
		this.bus.on(channel, handler);
		return () => { this.bus.off(channel, handler); };
	}
	emit(channel: string, payload: unknown): void {
		this.emitted.push({ channel, payload });
		this.bus.emit(channel, payload);
	}
	/** Test-side helper: deliver a payload as if pi-subagents emitted it. */
	deliver(channel: string, payload: unknown): void {
		this.bus.emit(channel, payload);
	}
	listenerCount(channel: string): number {
		return this.bus.listenerCount(channel);
	}
	last(channel: string): unknown {
		for (let i = this.emitted.length - 1; i >= 0; i--) {
			if (this.emitted[i].channel === channel) return this.emitted[i].payload;
		}
		return undefined;
	}
}

/** The REAL bridge result envelope (pi-subagents delegation-adapters.ts
 *  ~364: text results are ALWAYS { kind: "text", text } on the wire). */
function textResult(text: string): { kind: "text"; text: string } {
	return { kind: "text", text };
}

function baseOpts(overrides: Record<string, unknown> = {}): Parameters<typeof runAgentViaDelegation>[0] {
	return {
		agent: "judge",
		prompt: "Diagnose the loop.\n\nOutput <control> JSON with: route, diagnosis.",
		cwd: process.cwd(),
		id: "pipeline.stage9.judge.a1",
		ownerRunId: "spec-17",
		events: undefined as unknown as DelegationEventBus,
		...overrides,
	} as Parameters<typeof runAgentViaDelegation>[0];
}

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "sd-delegation-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("delegationAgentName", () => {
	it("prefixes super-dev specialists with sd- (collision-proof against pi-subagents' own agents)", () => {
		expect(delegationAgentName("judge")).toBe("sd-judge");
		expect(delegationAgentName("requirements-reviewer")).toBe("sd-requirements-reviewer");
	});
	it("is idempotent (an already-prefixed name is not double-prefixed)", () => {
		expect(delegationAgentName("sd-judge")).toBe("sd-judge");
	});
});

describe("runAgentViaDelegation", () => {
	it("emits a well-formed structured delegation request and resolves the SpawnResult from the terminal response", async () => {
		const bus = new FakeBus();
		const progress: string[] = [];
		const onProgress: AgentProgress = { event: (m) => progress.push(m), text: () => {} };

		const pending = runAgentViaDelegation(baseOpts({
			events: bus,
			thinking: "high",
			timeoutMs: 60_000,
			model: "zai-coding-cn/glm-5.3",
			onProgress,
		}) as Parameters<typeof runAgentViaDelegation>[0]);

		// The request must be on the wire BEFORE any response is delivered
		// (evented round-trip, not fire-and-forget).
		await Promise.resolve();
		const req = bus.last("prompt-template:subagent:request") as DelegationRequestPayload;
		expect(req).toBeTruthy();
		expect(req.agent).toBe("sd-judge");
		expect(req.task).toContain("Diagnose the loop");
		expect(req.context).toBe("fresh");
		expect(req.cwd).toBe(process.cwd());
		expect(req.nodeId).toBe("pipeline.stage9.judge.a1");
		expect(req.ownerRunId).toBe("spec-17");
		expect(req.result).toEqual({ kind: "text" });
		expect(req.thinking).toBe("high");
		expect(req.timeoutMs).toBe(60_000);
		expect(req.model).toBe("zai-coding-cn/glm-5.3");
		expect(typeof req.requestId).toBe("string");

		bus.deliver("prompt-template:subagent:response", {
			requestId: req.requestId,
			ownerRunId: req.ownerRunId,
			nodeId: req.nodeId,
			status: "completed",
			model: "zai-coding-cn/glm-5.3",
			result: textResult('Analysis done.\n\n<control>\n{"route":"fix-environment","diagnosis":"port clash"}\n</control>'),
			usage: { turns: 3, toolCalls: 7 },
		});

		const result: SpawnResult = await pending;
		expect(result.error).toBeUndefined();
		expect(result.model).toBe("zai-coding-cn/glm-5.3");
		expect(result.control).toEqual({ route: "fix-environment", diagnosis: "port clash" });
		expect(result.text).toContain("Analysis done");
	});

	it("ignores responses for other requestIds/ownerRunIds (exact identity match)", async () => {
		const bus = new FakeBus();
		const pending = runAgentViaDelegation(baseOpts({ events: bus }) as Parameters<typeof runAgentViaDelegation>[0]);
		await Promise.resolve();
		const req = bus.last("prompt-template:subagent:request") as DelegationRequestPayload;

		bus.deliver("prompt-template:subagent:response", { requestId: "other-id", ownerRunId: req.ownerRunId, nodeId: req.nodeId, status: "completed", result: textResult("x") });
		bus.deliver("prompt-template:subagent:response", { requestId: req.requestId, ownerRunId: "other-run", nodeId: req.nodeId, status: "completed", result: textResult("x") });

		const spy = vi.useFakeTimers();
		bus.deliver("prompt-template:subagent:response", { requestId: req.requestId, ownerRunId: req.ownerRunId, nodeId: req.nodeId, status: "completed", result: textResult("real") });
		vi.useRealTimers();
		const result = await pending;
		expect(result.text).toBe("real");
		expect(result.control).toBeNull();
	});

	it("a non-completed terminal status resolves as an agent error result (never hangs)", async () => {
		const bus = new FakeBus();
		const pending = runAgentViaDelegation(baseOpts({ events: bus }) as Parameters<typeof runAgentViaDelegation>[0]);
		await Promise.resolve();
		const req = bus.last("prompt-template:subagent:request") as DelegationRequestPayload;
		bus.deliver("prompt-template:subagent:response", {
			requestId: req.requestId, ownerRunId: req.ownerRunId, nodeId: req.nodeId,
			status: "failed", error: "child crashed",
		});
		const result = await pending;
		expect(result.error).toContain("child crashed");
		expect(result.control).toBeNull();
	});

	it("invalid_request resolves as an agent error naming the delegation bridge", async () => {
		const bus = new FakeBus();
		const pending = runAgentViaDelegation(baseOpts({ events: bus }) as Parameters<typeof runAgentViaDelegation>[0]);
		await Promise.resolve();
		const req = bus.last("prompt-template:subagent:request") as DelegationRequestPayload;
		bus.deliver("prompt-template:subagent:response", {
			requestId: req.requestId, status: "invalid_request", error: "agent not registered",
		});
		const result = await pending;
		expect(result.error).toContain("agent not registered");
	});

	it("cancels via the cancel event on AbortSignal and resolves as an aborted error", async () => {
		const bus = new FakeBus();
		const controller = new AbortController();
		const pending = runAgentViaDelegation(baseOpts({ events: bus, signal: controller.signal }) as Parameters<typeof runAgentViaDelegation>[0]);
		await Promise.resolve();
		const req = bus.last("prompt-template:subagent:request") as DelegationRequestPayload;
		controller.abort();
		const result = await pending;
		expect(result.error).toContain("abort");
		const cancel = bus.last("prompt-template:subagent:cancel") as DelegationRequestPayload;
		expect(cancel).toBeTruthy();
		expect(cancel.requestId).toBe(req.requestId);
		expect(cancel.ownerRunId).toBe(req.ownerRunId);
		expect(cancel.nodeId).toBe(req.nodeId);
	});

	it("emits cancel and resolves with an error when timeoutMs elapses without a terminal response", async () => {
		const bus = new FakeBus();
		const pending = runAgentViaDelegation(baseOpts({ events: bus, timeoutMs: 40 }) as Parameters<typeof runAgentViaDelegation>[0]);
		const result = await pending;
		expect(result.error).toMatch(/timed out|timeout/i);
		expect(bus.last("prompt-template:subagent:cancel")).toBeTruthy();
	});

	it("forwards delegation progress updates to onProgress.event", async () => {
		const bus = new FakeBus();
		const progress: string[] = [];
		const pending = runAgentViaDelegation(baseOpts({
			events: bus,
			onProgress: { event: (m: string) => progress.push(m), text: () => {} },
		}) as Parameters<typeof runAgentViaDelegation>[0]);
		await Promise.resolve();
		const req = bus.last("prompt-template:subagent:request") as DelegationRequestPayload;
		bus.deliver("prompt-template:subagent:update", { requestId: req.requestId, ownerRunId: req.ownerRunId, nodeId: req.nodeId, currentTool: "read" });
		bus.deliver("prompt-template:subagent:response", { requestId: req.requestId, ownerRunId: req.ownerRunId, nodeId: req.nodeId, status: "completed", result: textResult("done") });
		await pending;
		expect(progress.some((m) => m.includes("read"))).toBe(true);
	});

	it("corrective re-prompt: a text result missing required control keys triggers ONE retry request with the missing keys named", async () => {
		const bus = new FakeBus();
		const pending = runAgentViaDelegation(baseOpts({
			events: bus,
			controlKeys: ["route", "diagnosis"],
		}) as Parameters<typeof runAgentViaDelegation>[0]);

		await Promise.resolve();
		const first = bus.last("prompt-template:subagent:request") as DelegationRequestPayload;
		expect((first as unknown as Record<string, unknown>).controlKeys).toBeUndefined(); // never on the wire — prompt-only contract
		// first attempt: text WITHOUT a control block
		bus.deliver("prompt-template:subagent:response", { requestId: first.requestId, ownerRunId: first.ownerRunId, nodeId: first.nodeId, status: "completed", result: textResult("I looked at it.") });
		await Promise.resolve();
		await Promise.resolve();

		const second = bus.emitted.filter((e) => e.channel === "prompt-template:subagent:request").map((e) => e.payload as DelegationRequestPayload)[1];
		expect(second).toBeTruthy();
		expect(second.requestId).not.toBe(first.requestId);
		expect(second.nodeId).toBe(first.nodeId); // same logical node, new attempt
		expect(second.task).toMatch(/route|diagnosis/);
		expect(second.task.length).toBeGreaterThan(first.task.length); // corrective suffix appended

		bus.deliver("prompt-template:subagent:response", { requestId: second.requestId, ownerRunId: second.ownerRunId, nodeId: second.nodeId, status: "completed", result: textResult('<control>{"route":"re-author-tests","diagnosis":"self-matching regex"}</control>') });
		const result = await pending;
		expect(result.control).toEqual({ route: "re-author-tests", diagnosis: "self-matching regex" });
	});
});

describe("review-2 fixes", () => {
	it("P0: unwraps the { kind: 'text', text } envelope (raw strings stay tolerated)", async () => {
		const bus = new FakeBus();
		const pending = runAgentViaDelegation(baseOpts({ events: bus, controlKeys: ["route"] }) as Parameters<typeof runAgentViaDelegation>[0]);
		await Promise.resolve();
		const req = bus.last("prompt-template:subagent:request") as DelegationRequestPayload;
		bus.deliver("prompt-template:subagent:response", {
			requestId: req.requestId, ownerRunId: req.ownerRunId, nodeId: req.nodeId, status: "completed",
			result: { kind: "text", text: '<control>{"route":"proceed"}</control>' },
		});
		const result = await pending;
		expect(result.control).toEqual({ route: "proceed" });
		expect(result.text).toBe('<control>{"route":"proceed"}</control>');
	});

	it("P1: an already-aborted signal bails BEFORE emitting any request (SD-04 parity)", async () => {
		const bus = new FakeBus();
		const controller = new AbortController();
		controller.abort();
		const result = await runAgentViaDelegation(baseOpts({ events: bus, signal: controller.signal }) as Parameters<typeof runAgentViaDelegation>[0]);
		expect(result.error).toContain("aborted");
		expect(bus.emitted.filter((e) => e.channel === "prompt-template:subagent:request")).toHaveLength(0);
	});

	it("P1: without timeoutMs the role-default backstop rides on the request (never hangs forever)", async () => {
		const bus = new FakeBus();
		const pending = runAgentViaDelegation(baseOpts({ events: bus }) as Parameters<typeof runAgentViaDelegation>[0]);
		await Promise.resolve();
		const req = bus.last("prompt-template:subagent:request") as DelegationRequestPayload;
		expect(req.timeoutMs).toBe(1_200_000); // defaultAgentTimeoutMs("judge") — the 20-min role cap
		bus.deliver("prompt-template:subagent:response", { requestId: req.requestId, ownerRunId: req.ownerRunId, nodeId: req.nodeId, status: "completed", result: textResult("ok") });
		const result = await pending;
		expect(result.error).toBeUndefined();
	});

	it("P1: detaches the response+update listeners via on()'s returned unsubscribe after settle (no listener leaks)", async () => {
		const bus = new FakeBus();
		const pending = runAgentViaDelegation(baseOpts({ events: bus }) as Parameters<typeof runAgentViaDelegation>[0]);
		await Promise.resolve();
		const req = bus.last("prompt-template:subagent:request") as DelegationRequestPayload;
		expect(bus.listenerCount("prompt-template:subagent:response")).toBe(1);
		expect(bus.listenerCount("prompt-template:subagent:update")).toBe(1);
		bus.deliver("prompt-template:subagent:response", { requestId: req.requestId, ownerRunId: req.ownerRunId, nodeId: req.nodeId, status: "completed", result: textResult("ok") });
		await pending;
		expect(bus.listenerCount("prompt-template:subagent:response")).toBe(0);
		expect(bus.listenerCount("prompt-template:subagent:update")).toBe(0);
	});

	it("P1: an empty filesCreated array counts as present (built-in file-list allow-set — no spurious retry)", async () => {
		const bus = new FakeBus();
		const pending = runAgentViaDelegation(baseOpts({
			events: bus,
			prompt: "List files.\n\nOutput <control> JSON with: filesCreated",
			controlKeys: ["filesCreated"],
		}) as Parameters<typeof runAgentViaDelegation>[0]);
		await Promise.resolve();
		const first = bus.last("prompt-template:subagent:request") as DelegationRequestPayload;
		bus.deliver("prompt-template:subagent:response", { requestId: first.requestId, ownerRunId: first.ownerRunId, nodeId: first.nodeId, status: "completed", result: textResult('<control>{"filesCreated":[]}</control>') });
		const result = await pending;
		expect(result.control).toEqual({ filesCreated: [] });
		expect(result.error).toBeUndefined();
		const requests = bus.emitted.filter((e) => e.channel === "prompt-template:subagent:request");
		expect(requests).toHaveLength(1); // no corrective retry fired
	});

	it("P1: allowEmptyArraysFor opts extend the allow-set (custom empty arrays accepted)", async () => {
		const bus = new FakeBus();
		const pending = runAgentViaDelegation(baseOpts({
			events: bus,
			prompt: "Output <control> JSON with: openQuestions",
			controlKeys: ["openQuestions"],
			allowEmptyArraysFor: ["openQuestions"],
		}) as Parameters<typeof runAgentViaDelegation>[0]);
		await Promise.resolve();
		const first = bus.last("prompt-template:subagent:request") as DelegationRequestPayload;
		bus.deliver("prompt-template:subagent:response", { requestId: first.requestId, ownerRunId: first.ownerRunId, nodeId: first.nodeId, status: "completed", result: textResult('<control>{"openQuestions":[]}</control>') });
		const result = await pending;
		expect(result.control).toEqual({ openQuestions: [] });
		expect(bus.emitted.filter((e) => e.channel === "prompt-template:subagent:request")).toHaveLength(1);
	});

	it("P2 (v0.3.43): inherited model rides on the request; the thinking ROLE TIER wins for tiered agents (judge=high)", async () => {
		const bus = new FakeBus();
		const pending = runAgentViaDelegation(baseOpts({
			events: bus,
			inheritedModelObject: { provider: "zai-coding-cn", id: "glm-5.3" },
			inheritedThinking: "medium",
		}) as Parameters<typeof runAgentViaDelegation>[0]);
		await Promise.resolve();
		const req = bus.last("prompt-template:subagent:request") as DelegationRequestPayload;
		expect(req.model).toBe("zai-coding-cn/glm-5.3");
		// "judge" is a REASONING-tier agent — its designed level ("high") must not
		// be lowered by an inherited main-session "medium" (v0.3.43 root-cause fix).
		expect(req.thinking).toBe("high");
		bus.deliver("prompt-template:subagent:response", { requestId: req.requestId, ownerRunId: req.ownerRunId, nodeId: req.nodeId, status: "completed", result: textResult("ok") });
		await pending;
	});

	it("P2 (v0.3.43): UNTIERED agents still inherit the main-session thinking level", async () => {
		const bus = new FakeBus();
		const pending = runAgentViaDelegation(baseOpts({
			agent: "orchestrator",
			events: bus,
			inheritedModelObject: { provider: "zai-coding-cn", id: "glm-5.3" },
			inheritedThinking: "medium",
		}) as Parameters<typeof runAgentViaDelegation>[0]);
		await Promise.resolve();
		const req = bus.last("prompt-template:subagent:request") as DelegationRequestPayload;
		expect(req.model).toBe("zai-coding-cn/glm-5.3");
		expect(req.thinking).toBe("medium");
		bus.deliver("prompt-template:subagent:response", { requestId: req.requestId, ownerRunId: req.ownerRunId, nodeId: req.nodeId, status: "completed", result: textResult("ok") });
		await pending;
	});
});

/**
 * v0.3.28 progress parity — the delegation update events carry far more than
 * the bare tool name (SubagentDelegationUpdate: currentToolArgs, recentOutput,
 * recentTools, model, toolCount, durationMs, tokens; the terminal response
 * carries usage {input, output, turns, toolCalls, durationMs}). The session
 * backend logs `→ tool args…`, the subprocess backend logs `→ summary` + live
 * text; the delegation backend logged ONLY `${agent}: ${tool}` — the run.log
 * went nearly silent under the pi-subagents backend (live run
 * 2026-08-28T16-09-12: every line was `requirements-clarifier: ls`). These
 * tests pin the restored observability.
 */
describe("progress parity (v0.3.28)", () => {
	it("logs the tool WITH its args preview, session-backend style (`→ tool args`)", async () => {
		const bus = new FakeBus();
		const progress: string[] = [];
		const pending = runAgentViaDelegation(baseOpts({
			agent: "requirements-clarifier",
			events: bus,
			onProgress: { event: (m: string) => progress.push(m), text: () => {} },
		}) as Parameters<typeof runAgentViaDelegation>[0]);
		await Promise.resolve();
		const req = bus.last("prompt-template:subagent:request") as DelegationRequestPayload;
		bus.deliver("prompt-template:subagent:update", {
			requestId: req.requestId, ownerRunId: req.ownerRunId, nodeId: req.nodeId,
			currentTool: "read", currentToolArgs: "src/PopupActivity.kt",
		});
		bus.deliver("prompt-template:subagent:response", { requestId: req.requestId, ownerRunId: req.ownerRunId, nodeId: req.nodeId, status: "completed", result: textResult("done") });
		await pending;
		expect(progress).toContain("requirements-clarifier: → read src/PopupActivity.kt");
	});

	it("dedupes rapid identical update ticks (one line per tool call, not per progress tick)", async () => {
		const bus = new FakeBus();
		const progress: string[] = [];
		const pending = runAgentViaDelegation(baseOpts({
			events: bus,
			onProgress: { event: (m: string) => progress.push(m), text: () => {} },
		}) as Parameters<typeof runAgentViaDelegation>[0]);
		await Promise.resolve();
		const req = bus.last("prompt-template:subagent:request") as DelegationRequestPayload;
		for (let i = 0; i < 4; i++) {
			bus.deliver("prompt-template:subagent:update", {
				requestId: req.requestId, ownerRunId: req.ownerRunId, nodeId: req.nodeId,
				currentTool: "bash", currentToolArgs: "git status --porcelain",
			});
		}
		bus.deliver("prompt-template:subagent:update", {
			requestId: req.requestId, ownerRunId: req.ownerRunId, nodeId: req.nodeId,
			currentTool: "bash", currentToolArgs: "git diff --stat",
		});
		bus.deliver("prompt-template:subagent:response", { requestId: req.requestId, ownerRunId: req.ownerRunId, nodeId: req.nodeId, status: "completed", result: textResult("done") });
		await pending;
		const toolLines = progress.filter((m) => m.includes("→ bash"));
		expect(toolLines).toEqual(["judge: → bash git status --porcelain", "judge: → bash git diff --stat"]);
	});

	it("logs a request lifecycle line when the delegation request is emitted", async () => {
		const bus = new FakeBus();
		const progress: string[] = [];
		const pending = runAgentViaDelegation(baseOpts({
			events: bus,
			timeoutMs: 90_000,
			onProgress: { event: (m: string) => progress.push(m), text: () => {} },
		}) as Parameters<typeof runAgentViaDelegation>[0]);
		await Promise.resolve();
		const req = bus.last("prompt-template:subagent:request") as DelegationRequestPayload;
		bus.deliver("prompt-template:subagent:response", { requestId: req.requestId, ownerRunId: req.ownerRunId, nodeId: req.nodeId, status: "completed", result: textResult("done") });
		await pending;
		const start = progress.find((m) => m.startsWith("delegation judge: request"));
		expect(start).toBeTruthy();
		expect(start).toContain("agent=sd-judge");
		expect(start).toContain("timeout=90000ms");
	});

	it("logs a terminal summary line with usage when the response carries it", async () => {
		const bus = new FakeBus();
		const progress: string[] = [];
		const pending = runAgentViaDelegation(baseOpts({
			events: bus,
			onProgress: { event: (m: string) => progress.push(m), text: () => {} },
		}) as Parameters<typeof runAgentViaDelegation>[0]);
		await Promise.resolve();
		const req = bus.last("prompt-template:subagent:request") as DelegationRequestPayload;
		bus.deliver("prompt-template:subagent:response", {
			requestId: req.requestId, ownerRunId: req.ownerRunId, nodeId: req.nodeId,
			status: "completed", result: textResult("done"), model: "zai-coding-cn/glm-5.2",
			usage: { input: 1200, output: 340, turns: 3, toolCalls: 7, durationMs: 45_678, cacheRead: 0, cacheWrite: 0, cost: 0.01 },
		});
		await pending;
		const done = progress.find((m) => m.startsWith("delegation judge: completed"));
		expect(done).toContain("status=completed");
		expect(done).toContain("model=zai-coding-cn/glm-5.2");
		expect(done).toContain("turns=3");
		expect(done).toContain("tools=7");
		expect(done).toContain("tokens=1200/340");
		expect(done).toContain("cache=0/0");
		expect(done).toContain("$0.01");
		expect(done).toContain("duration=45.7s");
	});

	it("terminal without usage still logs a completed line (no usage segment, no crash)", async () => {
		const bus = new FakeBus();
		const progress: string[] = [];
		const pending = runAgentViaDelegation(baseOpts({
			events: bus,
			onProgress: { event: (m: string) => progress.push(m), text: () => {} },
		}) as Parameters<typeof runAgentViaDelegation>[0]);
		await Promise.resolve();
		const req = bus.last("prompt-template:subagent:request") as DelegationRequestPayload;
		bus.deliver("prompt-template:subagent:response", { requestId: req.requestId, ownerRunId: req.ownerRunId, nodeId: req.nodeId, status: "completed", result: textResult("done") });
		await pending;
		const done = progress.find((m) => m.startsWith("delegation judge: completed"));
		expect(done).toBe("delegation judge: completed status=completed");
	});

	it("surfaces tools missed between ticks via the recentTools history diff (pi-prompt-template-model pattern)", async () => {
		const bus = new FakeBus();
		const progress: string[] = [];
		const pending = runAgentViaDelegation(baseOpts({
			events: bus,
			onProgress: { event: (m: string) => progress.push(m), text: () => {} },
		}) as Parameters<typeof runAgentViaDelegation>[0]);
		await Promise.resolve();
		const req = bus.last("prompt-template:subagent:request") as DelegationRequestPayload;
		// Tick 1: one tool visible as current; a second tool already finished.
		bus.deliver("prompt-template:subagent:update", {
			requestId: req.requestId, ownerRunId: req.ownerRunId, nodeId: req.nodeId,
			currentTool: "bash", currentToolArgs: "git log --oneline -3",
			recentTools: [
				{ tool: "read", args: "docs/requirements/fix.md" },
				{ tool: "bash", args: "git log --oneline -3" },
			],
		});
		bus.deliver("prompt-template:subagent:response", { requestId: req.requestId, ownerRunId: req.ownerRunId, nodeId: req.nodeId, status: "completed", result: textResult("done") });
		await pending;
		// BOTH history entries surface — including the read that finished between ticks.
		expect(progress).toContain("judge: → read docs/requirements/fix.md");
		expect(progress).toContain("judge: → bash git log --oneline -3");
		// And no duplicate from the currentTool tick (same tool+args already logged).
		expect(progress.filter((m) => m === "judge: → bash git log --oneline -3")).toHaveLength(1);
	});

	it("logs agent narration output lines (⇢) once per new line, capped — subprocess live-text parity", async () => {
		const bus = new FakeBus();
		const progress: string[] = [];
		const pending = runAgentViaDelegation(baseOpts({
			events: bus,
			onProgress: { event: (m: string) => progress.push(m), text: () => {} },
		}) as Parameters<typeof runAgentViaDelegation>[0]);
		await Promise.resolve();
		const req = bus.last("prompt-template:subagent:request") as DelegationRequestPayload;
		bus.deliver("prompt-template:subagent:update", {
			requestId: req.requestId, ownerRunId: req.ownerRunId, nodeId: req.nodeId,
			currentTool: "bash", currentToolArgs: "ls",
			recentOutputLines: ["Found 14 DictFieldElement entries", "audio elements are dead code"],
		});
		// Same lines again on the next tick — deduped.
		bus.deliver("prompt-template:subagent:update", {
			requestId: req.requestId, ownerRunId: req.ownerRunId, nodeId: req.nodeId,
			currentTool: "bash", currentToolArgs: "ls",
			recentOutputLines: ["Found 14 DictFieldElement entries", "audio elements are dead code"],
		});
		// A NEW line appears.
		bus.deliver("prompt-template:subagent:update", {
			requestId: req.requestId, ownerRunId: req.ownerRunId, nodeId: req.nodeId,
			currentTool: "bash", currentToolArgs: "ls",
			recentOutputLines: ["Found 14 DictFieldElement entries", "audio elements are dead code", "definition maps keyed by display names"],
		});
		bus.deliver("prompt-template:subagent:response", { requestId: req.requestId, ownerRunId: req.ownerRunId, nodeId: req.nodeId, status: "completed", result: textResult("done") });
		await pending;
		expect(progress).toContain("judge: ⇢ Found 14 DictFieldElement entries");
		expect(progress).toContain("judge: ⇢ audio elements are dead code");
		expect(progress).toContain("judge: ⇢ definition maps keyed by display names");
		expect(progress.filter((m) => m === "judge: ⇢ audio elements are dead code")).toHaveLength(1);
	});
});
