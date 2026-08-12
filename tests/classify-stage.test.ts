/**
 * Stage 2A classifier — LLM-first with deterministic fallback.
 *
 * The old classifier was a shallow keyword regex that misread compound tasks
 * ("add an upload page with error handling" → bug/none because it matched the
 * word "error"). classifyStage now runs the `task-classifier` LLM agent and
 * falls back to the deterministic `classify-task` helper only when the agent
 * produces nothing — so routing always has a value.
 */
import { describe, it, expect } from "vitest";
import type { AgentCall, AgentResult, ControlObj, PipelineState, StageContext } from "../src/types.ts";
import { classifyStage } from "../src/stages/writers.ts";

function makeState(): PipelineState {
	return {
		task: "Add an upload page with error handling and a chart, plus the ingestion API",
		options: {} as never,
		setup: {
			worktreePath: "/tmp/wt", specDirectory: "/tmp/spec/", defaultBranch: "main",
			language: "frontend", isWebUi: false, specIdentifier: "01", worktreeCreated: false, initializedRepo: false,
		},
	} as unknown as PipelineState;
}

function makeCtx(opts: { agentControl: ControlObj | null; agentError?: string; agentThrows?: string; budget?: boolean; logs: string[] }): StageContext {
	return {
		task: "Add an upload page with error handling and a chart, plus the ingestion API",
		options: {},
		state: {} as PipelineState,
		budget: { check: () => opts.budget ?? true, spent: () => true, count: 0 },
		log: (m: string) => opts.logs.push(m),
		phase: () => {},
		events: { on() {}, off() {}, emit() {} },
		results: [],
		signal: undefined,
		async agent(_call: AgentCall): Promise<AgentResult> {
			if (opts.agentThrows) throw new Error(opts.agentThrows);
			return { text: "", control: opts.agentControl, error: opts.agentError };
		},
		async helper() {
			// deterministic classify-task: the regex would say bug/none for this task.
			return { value: { taskType: "bug", uiScope: "none", language: "frontend", isWebUi: false, skipStages: [] } as ControlObj, digest: "" };
		},
		async parallel() { return []; },
	} as unknown as StageContext;
}

describe("classifyStage — LLM-first with deterministic fallback", () => {
	it("uses the LLM classifier result (feature/ui+arch), overriding the regex's bug/none", async () => {
		const logs: string[] = [];
		const ctx = makeCtx({ agentControl: { taskType: "feature", uiScope: "ui+arch", rationale: "upload page + chart + ingestion API" } as ControlObj, logs });
		const c = (await classifyStage.run(makeState(), ctx)) as Record<string, unknown>;
		expect(c.taskType).toBe("feature");
		expect(c.uiScope).toBe("ui+arch");
		expect(c.language).toBe("frontend"); // setup-derived fields preserved
		expect(logs.some((l) => l.includes("classify: taskType=feature uiScope=ui+arch"))).toBe(true);
	});

	it("falls back to the deterministic classification when the LLM returns nothing", async () => {
		const logs: string[] = [];
		const ctx = makeCtx({ agentControl: null, agentError: "timeout", logs });
		const c = (await classifyStage.run(makeState(), ctx)) as Record<string, unknown>;
		expect(c.taskType).toBe("bug"); // the regex fallback value
		expect(c.uiScope).toBe("none");
		expect(logs.some((l) => l.includes("deterministic fallback"))).toBe(true);
	});

	it("falls back (no agent call) when the budget is exhausted", async () => {
		const logs: string[] = [];
		const ctx = makeCtx({ agentControl: { taskType: "feature", uiScope: "ui+arch", rationale: "x" } as ControlObj, budget: false, logs });
		const c = (await classifyStage.run(makeState(), ctx)) as Record<string, unknown>;
		expect(c.taskType).toBe("bug"); // budget exhausted → deterministic value, LLM not consulted
		expect(logs.some((l) => l.includes("budget exhausted"))).toBe(true);
	});

	it("falls back (does NOT throw) when the classifier agent throws an ordinary error", async () => {
		// The classifier is a routing convenience: an ordinary backend/session
		// exception must degrade to the deterministic classification, NOT fail Stage 2A
		// and leave state.classify missing (which recreates the bad routing context).
		const logs: string[] = [];
		const ctx = makeCtx({ agentControl: null, agentThrows: "session backend exploded", logs });
		const c = (await classifyStage.run(makeState(), ctx)) as Record<string, unknown>;
		expect(c.taskType).toBe("bug");
		expect(c.uiScope).toBe("none");
		expect(logs.some((l) => l.includes("classifier threw") && l.includes("session backend exploded"))).toBe(true);
	});

	it("RETHROWS a source-read-only boundary violation (safety error, never swallowed)", async () => {
		// A read-only classifier that mutated project files is a SAFETY failure: the
		// convenience fallback must NOT swallow it — the pipeline must stop.
		const logs: string[] = [];
		const ctx = makeCtx({ agentControl: null, agentThrows: "source-read-only boundary violation: modified project files (src/x.ts)", logs });
		await expect(classifyStage.run(makeState(), ctx)).rejects.toThrow(/source-read-only boundary violation/);
	});
});
