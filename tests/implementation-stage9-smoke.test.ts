import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentCall, AgentResult, Budget, ControlObj, HelperResult, PipelineState, RunOptions, StageContext } from "../src/types.ts";

vi.mock("../src/render/render.ts", () => ({ renderAndWrite: vi.fn() }));

import { implementationStage } from "../src/stages/implementation.ts";

function makeTinyProject(): { root: string; specDir: string } {
	const root = mkdtempSync(join(tmpdir(), "sd-stage9-smoke-"));
	mkdirSync(join(root, "src"), { recursive: true });
	mkdirSync(join(root, "node_modules"));
	const specDir = join(root, "docs", "specifications", "stage9-smoke");
	mkdirSync(specDir, { recursive: true });
	writeFileSync(join(root, "package.json"), JSON.stringify({
		name: "stage9-smoke",
		private: true,
		scripts: {
			build: "node --check src/math.js",
			test: "node --test src/*.test.js",
		},
	}, null, 2));
	writeFileSync(join(root, "src", "math.js"), "function add(a, b) { return a - b; }\nmodule.exports = { add };\n");
	return { root, specDir };
}

function stateFor(root: string, specDir: string): PipelineState {
	return {
		setup: {
			worktreePath: root,
			specDirectory: specDir,
			defaultBranch: "main",
			language: "backend",
			isWebUi: false,
			specIdentifier: "stage9-smoke",
			worktreeCreated: false,
			initializedRepo: false,
		},
		classify: { taskType: "feature", uiScope: "none", language: "backend", isWebUi: false },
		spec: { phases: [{ name: "Tiny add", description: "Make add return a sum" }] },
	} as unknown as PipelineState;
}

function contextFor(root: string): { ctx: StageContext; calls: { tdd: AgentCall[]; impl: AgentCall[]; logs: string[] } } {
	const calls = { tdd: [] as AgentCall[], impl: [] as AgentCall[], logs: [] as string[] };
	const budget: Budget = { count: 0, check: () => true, spent() { this.count++; return true; } };
	const ctx: StageContext = {
		task: "stage9 smoke",
		options: {} as RunOptions,
		state: {} as PipelineState,
		async helper(): Promise<HelperResult> {
			return { value: { languageInstructions: "" }, digest: "" };
		},
		async agent(call: AgentCall): Promise<AgentResult> {
			if (call.agent === "tdd-guide") {
				calls.tdd.push(call);
				const testPath = join(root, "src", "math.test.js");
				if (!call.prompt.includes("RED runner diagnostics from the last oracle run")) {
					writeFileSync(testPath, "require('node:test');\nthrow new SyntaxError('stage9-smoke-syntax-marker');\n");
				} else {
					writeFileSync(testPath, [
						"const test = require('node:test');",
						"const assert = require('node:assert/strict');",
						"const { add } = require('./math.js');",
						"test('add sums numbers', () => assert.equal(add(2, 3), 5));",
						"",
					].join("\n"));
				}
				return { text: "", control: { testFiles: ["src/math.test.js"] } };
			}
			if (call.agent === "implementer") {
				calls.impl.push(call);
				writeFileSync(join(root, "src", "math.js"), "function add(a, b) { return a + b; }\nmodule.exports = { add };\n");
				return { text: "", control: { filesCreated: [], filesModified: ["src/math.js"], filesDeleted: [] } };
			}
			return { text: "", control: {} };
		},
		async parallel(cbs) { return Promise.all(cbs.map((cb) => cb())); },
		budget,
		log(message: string) { calls.logs.push(message); },
		phase() {},
		events: new EventEmitter(),
		results: [],
	};
	return { ctx, calls };
}

describe("Stage 9 direct smoke", () => {
	it("recovers from a broken RED test using runner diagnostics, then implements to green", async () => {
		const { root, specDir } = makeTinyProject();
		try {
			const state = stateFor(root, specDir);
			const { ctx, calls } = contextFor(root);

			const result = await implementationStage.run(state, ctx) as ControlObj;

			expect(result.allGreen).toBe(true);
			expect(result.phasesCompleted).toBe(1);
			expect(calls.tdd).toHaveLength(2);
			expect(calls.tdd[1]!.prompt).toContain("RED runner diagnostics from the last oracle run");
			expect(calls.impl).toHaveLength(1);
			expect(calls.logs.some((line) => line.includes("RED runner diagnostic") && line.includes("status=broken") && line.includes("tail=")), calls.logs.join("\n")).toBe(true);
			expect(calls.logs.some((line) => line.includes("Implementation phase-01 GREEN on attempt 1"))).toBe(true);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	}, 20_000);
});
