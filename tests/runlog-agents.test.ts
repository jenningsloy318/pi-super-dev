/**
 * P1.3 (dsh-09 v3 Phase P): agent.called events. Every realAgent outcome —
 * success, throw, and budget-starved refusal — lands in events.jsonl with a
 * bounded control summary (keys + verdict/pass scalars only; the full control
 * stays in audit.jsonl + the resume cache).
 *
 * Backend modules are mocked so no pi session/subprocess is ever created.
 */
import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { sessionMock } = vi.hoisted(() => ({
	sessionMock: vi.fn(async (call: { agent: string }) => ({
		text: "done",
		control: { verdict: "Approved", findings: [], extra: { deep: true } },
		model: "provider/model-x",
	})),
}));
vi.mock("../src/session-agent.ts", () => ({ runAgentViaSession: sessionMock }));
vi.mock("../src/pi-spawn.ts", () => ({
	spawnAgent: vi.fn(async () => ({ text: "", control: null })),
	isBrowserAgent: vi.fn(() => false),
	needsWebResearch: vi.fn(() => false),
}));

import { runWorkflow } from "../src/workflow.ts";
import { sequence, task } from "../src/nodes.ts";
import { readRunEvents } from "../src/runlog.ts";
import type { PipelineState, Stage, StageContext, Workflow } from "../src/types.ts";

function setupStage(specDir: string): Stage {
	return {
		id: "setup",
		label: "Setup",
		async run() {
			return { worktreePath: specDir, specDirectory: specDir, defaultBranch: "main", language: "backend", isWebUi: false, specIdentifier: "01-test", worktreeCreated: false, initializedRepo: false } as never;
		},
	};
}

describe("agent.called ledger events (P1.3)", () => {
	it("records success (bounded control summary), throw, and budget-starved refusal", async () => {
		const d = mkdtempSync(join(tmpdir(), "sd-p13-"));
		try {
			// The mock throws only for the "throw please" call — deterministic
			// per-prompt dispatch (mockImplementationOnce ordering is global, not
			// per-test-arrangement).
			sessionMock.mockImplementation(async (call: { agent: string; prompt?: string }) => {
				if (String(call.prompt).includes("throw please")) throw new Error("backend exploded");
				return { text: "done", control: { verdict: "Approved", findings: [], extra: { deep: true } }, model: "provider/model-x" };
			});
			const agentStage: Stage = {
				id: "research",
				label: "Research",
				async run(_s: PipelineState, ctx: StageContext) {
					// 1st call: succeeds (mocked session backend).
					const ok = await ctx.agent({ id: "pipeline.research.writer", agent: "implementer", prompt: "do work" });
					expect(ok.control?.verdict).toBe("Approved");
					// 2nd call: the mocked backend throws.
					try {
						await ctx.agent({ id: "pipeline.research.boom", agent: "implementer", prompt: "throw please" });
					} catch { /* expected */ }
					return { done: 2 } as never;
				},
			};
			const wf: Workflow = { id: "t", root: sequence([task(setupStage(d)), task(agentStage)]) } as unknown as Workflow;
			await runWorkflow(wf, "t", { maxAgents: 2 });

			const events = readRunEvents(d).filter((e) => e.type === "agent.called");
			expect(events.length).toBeGreaterThanOrEqual(2);
			// Success: bounded control summary — keys present, verdict scalar kept,
			// deep payloads dropped.
			const success = events.find((e) => String(e.data.model) === "provider/model-x");
			expect(success?.agent).toBe("implementer");
			expect(success?.stage).toBe("research.writer");
			expect(success?.data.backend).toBe("session");
			expect(success?.data.durationMs).toBeGreaterThanOrEqual(0);
			const control = success?.data.control as Record<string, unknown>;
			expect(control.keys).toContain("verdict");
			expect(control.verdict).toBe("Approved");
			expect(JSON.stringify(control)).not.toContain("deep"); // bounded
			// Throw: error string recorded, no control.
			const threw = events.find((e) => String(e.data.error).includes("backend exploded"));
			expect(threw?.agent).toBe("implementer");
			expect(threw?.data.control).toBeFalsy();
		} finally {
			rmSync(d, { recursive: true, force: true });
		}
	});

	it("records the budget-starved refusal as agent.called with the honest error", async () => {
		const d = mkdtempSync(join(tmpdir(), "sd-p13b-"));
		try {
			const agentStage: Stage = {
				id: "research",
				label: "Research",
				async run(_s: PipelineState, ctx: StageContext) {
					// First call consumes the single reservation; the second is starved.
					await ctx.agent({ id: "pipeline.research.first", agent: "implementer", prompt: "x" });
					const r = await ctx.agent({ id: "pipeline.research.starved", agent: "implementer", prompt: "x" });
					expect(r.error).toContain("budget exhausted");
					return {} as never;
				},
			};
			const wf: Workflow = { id: "t", root: sequence([task(setupStage(d)), task(agentStage)]) } as unknown as Workflow;
			await runWorkflow(wf, "t", { maxAgents: 1 });
			const events = readRunEvents(d).filter((e) => e.type === "agent.called");
			expect(events).toHaveLength(2); // first succeeded, second starved
			const starved = events.find((e) => String(e.data.error ?? "").includes("budget exhausted"));
			expect(starved).toBeTruthy();
			expect(starved?.data.durationMs).toBe(0);
			expect(starved?.data.control).toBeFalsy(); // no phantom control on a refusal
		} finally {
			rmSync(d, { recursive: true, force: true });
		}
	});
});
