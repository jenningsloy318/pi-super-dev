/**
 * v0.4.60 WS1 (066 §2) — the finding-resolution bounce, node-level
 * integration. Harness note (commit aa7bbc0e): the ctx is the REAL shape —
 * runHelper-backed validation (a stubbed always-pass helper short-circuits
 * the writer dispatch: 0-dispatch signature) and the reviewer approves so
 * convergence terminates. Contracts:
 *  - an injected blocking finding + a writer control LACKING
 *    findingResolutions → exactly ONE bounce re-dispatch (2 writer calls);
 *  - a control mapping every injected id → no bounce (1 writer call);
 *  - no injected findings → the gate is inert (1 writer call);
 *  - the bounce feedback reaches the re-dispatched writer naming the id.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { requirementsConvergenceNode } from "../src/stages/artifact-convergence/index.ts";
import { runHelper } from "../src/helpers.ts";
import { renderRetryFeedbackBlock, type RetryFeedbackInput } from "../src/retry-feedback.ts";
import type { AgentCall, AgentResult, Budget, ControlObj, HelperCall, PipelineState, SetupControl, StageContext } from "../src/types.ts";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "sd-frgate-")); });
// NO git init: with a repo, stateFileFor's 063 funnel routes harness state to
// the EXTERNAL state root (where nothing is seeded); without one it
// fail-closes to the in-spec path — exactly where the ledger seed lives.
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function setup(): SetupControl {
	return {
		worktreePath: dir,
		specDirectory: `${dir}/docs/specifications/001-test/`,
		defaultBranch: "main",
		language: "backend",
		isWebUi: false,
		specIdentifier: "001-test",
		worktreeCreated: true,
		initializedRepo: false,
	};
}

function budget(maxRounds = 20): Budget {
	let calls = 0;
	return { count: 0, check: () => calls++ < maxRounds, spent() { this.count++; return true; } };
}

const logs: string[] = [];
function ctx(state: PipelineState, controls: ControlObj[], writerFeedback: RetryFeedbackInput[][]): StageContext {
	let writerCalls = 0;
	return {
		task: "implement feature",
		options: {},
		state,
		budget: budget(),
		log(line: string) { logs.push(line); },
		phase() {},
		events: new EventEmitter(),
		results: [],
		async agent(call: AgentCall): Promise<AgentResult> {
			const key = (call.id ?? "").replace(/^pipeline\./, "");
			const fb = ((state as Record<string, unknown>).__feedback as Record<string, RetryFeedbackInput[]> | undefined)?.[key] ?? [];
			if (key === "requirementsReview") {
				return { text: "", control: { verdict: "Approved", summary: "approved", findings: [] } as ControlObj };
			}
			writerFeedback.push([...fb]);
			return { text: "", control: controls[Math.min(writerCalls++, controls.length - 1)] };
		},
		async helper(call: HelperCall) { return runHelper(call); },
		async parallel(calls) { return Promise.all(calls.map((call) => call())); },
	};
}

function seedPriorFinding(specDir: string, id: string): void {
	// anchorTaskHash keys the ledger by the .task file's sha256 (16 hex) —
	// seed both or the read filters the ledger out.
	writeFileSync(join(specDir, ".task"), "implement feature");
	writeFileSync(join(specDir, ".convergence-ledger.json"), JSON.stringify({
		version: 1,
		taskHash: createHash("sha256").update(readFileSync(join(specDir, ".task"), "utf8")).digest("hex").slice(0, 16),
		persistedAt: new Date().toISOString(),
		findings: [{ id, ownerStage: "requirements", title: "prior blocker title", detail: "detail ".repeat(10), severity: "high", evidence: ["e"], recommendation: "address it via the amendment family", status: "open", blocking: true }],
	}));
}

// The exact control shape the existing convergence tests validate against
// (their requirementsControl) + the optional coverage map.
const okRequirements = (withResolutions: boolean): ControlObj => ({
	title: "Feature Requirements",
	date: "2026-08-10",
	type: "feature",
	priority: "high",
	executiveSummary: "Build a concrete feature with resolved behavior. " + "summary ".repeat(50),
	acceptanceCriteria: [
		{ id: "AC-01", statement: "Primary behavior works." },
		{ id: "AC-02", statement: "Edge behavior is handled." },
	],
	nonFunctional: ["Performance remains acceptable."],
	openQuestions: [],
	...(withResolutions ? { findingResolutions: [{ id: "CF-prior-1", loci: ["01-requirements.md#AC-01"], note: "address it via the amendment family" }] } : {}),
});

function stateWith(s: SetupControl): PipelineState {
	return { setup: s, classify: { taskType: "feature", uiScope: "none", language: "backend", isWebUi: false } } as unknown as PipelineState;
}

describe("finding-resolution bounce (WS1, 066 §2) — node integration", () => {
	it("an unaddressed injected finding bounces the writer ONCE, then proceeds (agent budget, not a convergence round)", async () => {
		const s = setup();
		mkdirSync(s.specDirectory, { recursive: true });
		seedPriorFinding(s.specDirectory, "CF-prior-1");
		const state = stateWith(s);
		const wf: RetryFeedbackInput[][] = [];
		const result = await requirementsConvergenceNode.run(state, ctx(state, [okRequirements(false), okRequirements(true)], wf));
		expect(result.status).toBe("ok");
		// dispatch 1 = initial writer (no map) → bounce; dispatch 2 = the map.
		expect(wf.length).toBe(2);
	});

	it("a control mapping every injected id never bounces", async () => {
		const s = setup();
		mkdirSync(s.specDirectory, { recursive: true });
		seedPriorFinding(s.specDirectory, "CF-prior-1");
		const state = stateWith(s);
		const wf: RetryFeedbackInput[][] = [];
		const result = await requirementsConvergenceNode.run(state, ctx(state, [okRequirements(true)], wf));
		expect(result.status).toBe("ok");
		expect(wf.length).toBe(1);
	});

	it("no injected findings → the gate is inert (a control without a map is fine)", async () => {
		const s = setup();
		mkdirSync(s.specDirectory, { recursive: true });
		const state = stateWith(s);
		const wf: RetryFeedbackInput[][] = [];
		const result = await requirementsConvergenceNode.run(state, ctx(state, [okRequirements(false)], wf));
		expect(result.status).toBe("ok");
		expect(wf.length).toBe(1);
	});

	it("the bounce feedback reaches the re-dispatched writer naming the missing id", async () => {
		const s = setup();
		mkdirSync(s.specDirectory, { recursive: true });
		seedPriorFinding(s.specDirectory, "CF-prior-1");
		const state = stateWith(s);
		const wf: RetryFeedbackInput[][] = [];
		await requirementsConvergenceNode.run(state, ctx(state, [okRequirements(false), okRequirements(true)], wf));
		expect(renderRetryFeedbackBlock(wf[1] ?? [])).toContain("CF-prior-1");
	});
});

describe("067 D1/D2 — schema-legal field + demand-set hygiene", () => {
	it("the writer schema DECLARES findingResolutions (the wire can carry the map — 067 D1)", async () => {
		const { RequirementsData } = await import("../src/render/schemas.ts");
		const props = (RequirementsData as unknown as { properties: Record<string, unknown> }).properties;
		expect(props.findingResolutions).toBeDefined();
	});
	it("agent-failed infra markers never enter the demand set (067 D2 — the capture-site filter)", async () => {
		const { designatedBounceFindings } = await import("../src/stages/artifact-convergence/validators.ts");
		// The filter is applied at capture; pin the marker shape it excludes.
		expect(designatedBounceFindings(["x codeReview-agent-failed noise"])).toEqual([]);
		const source = await import("node:fs").then((fs) => fs.readFileSync("src/stages/artifact-convergence/node.ts", "utf8"));
		expect(source).toContain("!/-agent-failed$/");
	});
	it("resume-compat: an OLD control without the field still validates (Optional passes — 067 grill Q4)", async () => {
		const { RequirementsData } = await import("../src/render/schemas.ts");
		const { Value } = await import("typebox/value");
		const oldControl = { title: "t", date: "2026-09-21", type: "feature", priority: "high", layerW: "1", executiveSummary: "s", acceptanceCriteria: [{ id: "AC-01", statement: "s" }, { id: "AC-02", statement: "s" }], nonFunctional: ["n"] };
		expect(Value.Check(RequirementsData, oldControl)).toBe(true);
		const newControl = { ...oldControl, findingResolutions: [{ id: "F1", loci: ["01-requirements.md:1"], note: "quote" }] };
		expect(Value.Check(RequirementsData, newControl)).toBe(true);
	});
});
