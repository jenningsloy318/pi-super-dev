/**
 * v0.3.95 FIX B1 (run-2026-09-12T15-16-29-042Z §5.1) — the workflow start log
 * prints the SAME resolved thinking value the delegation dispatches. The old
 * label chain (perCall ?? inherited ?? SUPER_DEV_THINKING ?? "role-default")
 * was a stale, incomplete mirror of resolveThinking: it missed
 * config.agentThinking[role], the config.agentModels `:level` suffix, and the
 * role tier, and ordered env AFTER inherited. The operator observed
 * "thinking=max" in the run log while the child actually dispatched :high from
 * the config suffix — the exact scenario pinned below.
 *
 * Backend mocked (no pi event bus); config injected via the getConfig mock
 * (hermeticity pattern of tests/thinking-config.test.ts).
 */
import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const configState: { agentModels?: Record<string, string> } = {};
const { delegationMock } = vi.hoisted(() => ({
	delegationMock: vi.fn(async () => ({
		text: "done",
		control: { verdict: "Approved" },
		model: "antigravity/gemini-3.8-flash",
	})),
}));
vi.mock("../src/agents/delegation-backend.ts", async (importOriginal) => ({
	...await importOriginal<typeof import("../src/agents/delegation-backend.ts")>(),
	runAgentViaDelegation: delegationMock,
}));
vi.mock("../src/render/super-dev-dir.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/render/super-dev-dir.ts")>();
	return {
		...actual,
		getConfig: () => ({ ...actual.DEFAULT_CONFIG, ...configState }),
	};
});

import { runWorkflow } from "../src/workflow.ts";
import { sequence, task } from "../src/nodes.ts";
import type { PipelineState, Stage, StageContext, Workflow } from "../src/types.ts";

function fakeSetupStage(specDir: string): Stage {
	return {
		id: "setup",
		label: "Setup",
		async run(_state: PipelineState, _ctx: StageContext) {
			return { worktreePath: specDir, specDirectory: specDir, defaultBranch: "main", language: "backend", isWebUi: false, specIdentifier: "26-test", worktreeCreated: false, initializedRepo: false } as never;
		},
	};
}

/** Run a one-agent workflow and capture every progress log line. */
async function runOneAgentCall(agent: string, runOptions: Record<string, unknown> = {}): Promise<string[]> {
	const d = mkdtempSync(join(tmpdir(), "sd-logfid-"));
	const lines: string[] = [];
	try {
		const agentStage: Stage = {
			id: "review",
			label: "Review",
			async run(_s: PipelineState, ctx: StageContext) {
				await ctx.agent({ id: "pipeline.review.caller", agent, prompt: "do work" });
				return {} as never;
			},
		};
		const wf: Workflow = { id: "t", root: sequence([task(fakeSetupStage(d)), task(agentStage)]) } as unknown as Workflow;
		await runWorkflow(wf, "t", {
			maxAgents: 2,
			events: {} as never,
			progress: {
				phase: () => {},
				log: (m: string) => lines.push(m),
				text: () => {},
			} as never,
			...runOptions,
		});
		return lines;
	} finally {
		rmSync(d, { recursive: true, force: true });
	}
}

function startLine(lines: string[]): string | undefined {
	return lines.find((l) => l.includes(": start agent=") && l.includes("backend=pi-subagents"));
}

describe("workflow start-log thinking fidelity (v0.3.95 FIX B1)", () => {
	it("THE OPERATOR SCENARIO: config agentModels :high suffix + inherited max → the log prints thinking=high", async () => {
		delete process.env.SUPER_DEV_THINKING;
		configState.agentModels = { "requirements-reviewer": "antigravity/gemini-3.8-flash:high" };
		const lines = await runOneAgentCall("requirements-reviewer", { inheritedThinking: "max" });
		const line = startLine(lines);
		expect(line).toBeTruthy();
		// the resolved level the dispatch actually uses (config suffix beats inheritance)
		expect(line).toContain("thinking=high");
		expect(line).not.toContain("thinking=max");
		// and the model is the suffix-stripped bare id
		expect(line).toContain("model=antigravity/gemini-3.8-flash");
		expect(line).toContain("agent=requirements-reviewer");
	});

	it("no overrides at all → the resolved medium default prints (\"role-default\" is gone as a label)", async () => {
		delete process.env.SUPER_DEV_THINKING;
		configState.agentModels = undefined;
		const lines = await runOneAgentCall("requirements-reviewer", {});
		const line = startLine(lines);
		expect(line).toBeTruthy();
		expect(line).toContain("thinking=medium");
		expect(line).not.toContain("thinking=role-default");
	});

	it("the role tier prints for tiered roles (code-reviewer → high), still beating inheritance", async () => {
		delete process.env.SUPER_DEV_THINKING;
		configState.agentModels = undefined;
		const lines = await runOneAgentCall("code-reviewer", { inheritedThinking: "low" });
		const line = startLine(lines);
		expect(line).toBeTruthy();
		expect(line).toContain("thinking=high");
	});
});
