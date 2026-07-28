/**
 * Phase 1 (Feature 1) — Main-session model/thinking inheritance threading (RED tests).
 *
 * AC-01 / AC-03 / AC-05 → SCENARIO-001 (capture + thread inherited DEFAULTS),
 *                          SCENARIO-005 (inherited thinking flows from the
 *                          workflow agent factory through to the spawned agent),
 *                          SCENARIO-006 (inherited thinking reaches BOTH backends).
 *
 * Decision from reading src/workflow.ts: `realAgent` builds ONE shared `common`
 * options object and dispatches it to either `spawnAgent` (subprocess) or
 * `runAgentViaSession` (session). The additive inheritance DEFAULTS must reach
 * BOTH backends through that single `common` seam — so the test asserts the
 * object handed to the backend carries `inheritedModel` / `inheritedThinking`
 * exactly as they arrived on `RunOptions`.
 *
 * Harness mirrors tests/workflow-user-steer.test.ts: both backends are mocked to
 * capture the resolved options object, and knowledge is mocked away so the
 * captured fields are inspectable in isolation. These tests FAIL today because
 * `realAgent`'s `common` object does not yet forward the inherited fields.
 */
import { describe, it, expect, vi } from "vitest";

/** Captured backend options (the `common` object realAgent hands the backend). */
const captured: {
	session?: Record<string, unknown>;
	subprocess?: Record<string, unknown>;
	prompt?: string;
} = {};

vi.mock("../src/session-agent.ts", () => ({
	runAgentViaSession: vi.fn(async (opts: Record<string, unknown>) => {
		captured.session = opts;
		captured.prompt = opts.prompt as string | undefined;
		return { text: "", control: {} };
	}),
	summarizeSlug: vi.fn(async () => "x"),
}));
vi.mock("../src/pi-spawn.ts", () => ({
	spawnAgent: vi.fn(async (opts: Record<string, unknown>) => {
		captured.subprocess = opts;
		captured.prompt = opts.prompt as string | undefined;
		return { text: "", control: {} };
	}),
	isBrowserAgent: vi.fn(() => false),
	needsWebResearch: vi.fn(() => false),
}));
vi.mock("../src/render/knowledge.ts", () => ({
	knowledgeForAgent: vi.fn(() => ""),
}));

import { makeContext } from "../src/workflow.ts";
import type { AgentCall, PipelineState, RunOptions } from "../src/types.ts";

const mkCtx = (state: PipelineState, options: RunOptions = {}) =>
	makeContext(state, "t", options, () => {});

const BASE_CALL: AgentCall = { id: "pipeline.spec", agent: "spec-writer", prompt: "ORIG PROMPT" };

describe("realAgent threads inherited model/thinking into BOTH backend calls (AC-01/AC-03/AC-05, SCENARIO-001/005/006)", () => {
	it("SCENARIO-005/006: options.inheritedThinking flows into the session backend's common object", async () => {
		await mkCtx({}, { inheritedThinking: "xhigh" }).agent(BASE_CALL);
		expect(captured.session).toBeDefined();
		// The additive DEFAULT must reach the backend so a specialist with no
		// per-call/env override inherits the live session's thinking level.
		expect(captured.session!.inheritedThinking).toBe("xhigh");
	});

	it("SCENARIO-001: options.inheritedModel flows into the session backend's common object", async () => {
		await mkCtx({}, { inheritedModel: "openai/gpt-4o" }).agent(BASE_CALL);
		expect(captured.session).toBeDefined();
		expect(captured.session!.inheritedModel).toBe("openai/gpt-4o");
	});

	it("SCENARIO-006: inherited model AND thinking reach the SUBPROCESS backend through the same common seam", async () => {
		// Force the subprocess backend explicitly so both paths are covered.
		await mkCtx({}, { backend: "subprocess", inheritedModel: "glm/glm-5.2", inheritedThinking: "high" }).agent(BASE_CALL);
		expect(captured.subprocess).toBeDefined();
		expect(captured.subprocess!.inheritedModel).toBe("glm/glm-5.2");
		expect(captured.subprocess!.inheritedThinking).toBe("high");
	});

	it("inherited DEFAULTS never clobber the per-call model/thinking override (additive-only)", async () => {
		// AgentCall.model does not exist on AgentCall today (model lives on RunOptions),
		// but per-call `thinking` does — the inherited tier must still be PRESENT on the
		// backend call (it is a DEFAULT) while the per-call override wins downstream.
		await mkCtx({}, { inheritedThinking: "high" }).agent({ ...BASE_CALL, thinking: "off" });
		expect(captured.session).toBeDefined();
		// Inheritance is threaded as a DEFAULT (present), not as a clobber of per-call.
		expect(captured.session!.inheritedThinking).toBe("high");
		expect(captured.session!.thinking).toBe("off");
	});

	it("SCENARIO-002: absent inherited fields do not throw and pass through undefined (older/non-TUI ctx)", async () => {
		// No inheritedModel/inheritedThinking on options → realAgent must still run,
		// and the backend call receives undefined for both (byte-identical baseline).
		await expect(mkCtx({}).agent(BASE_CALL)).resolves.toBeDefined();
		expect(captured.session).toBeDefined();
		expect(captured.session!.inheritedModel).toBeUndefined();
		expect(captured.session!.inheritedThinking).toBeUndefined();
	});
});
