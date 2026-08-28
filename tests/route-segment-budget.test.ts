import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requirementsConvergenceNode } from "../src/stages/artifact-convergence.ts";
import { routeBackReentry } from "../src/routing/journal.ts";
import { runHelper } from "../src/helpers.ts";
import type { AgentCall, AgentResult, Budget, ControlObj, HelperCall, PipelineState, SetupControl, StageContext } from "../src/types.ts";

// ─── v0.3.24 S3 ───────────────────────────────────────────────────────────────
// Run 13-04-28: after the bdd→requirements auto route-back re-entry,
// countStageRounds still counted the PRE-route-back requirements rounds, so
// effectiveRoundCap granted the re-entered loop an inflated round budget
// (8+ rounds before the fatal). A route-back re-entry is a REVISION walk, not
// a durable resume: the round budget must reset to segment scope, bounded
// globally by the per-edge jump budget (the anti-ping-pong bound), not by
// replayed-round arithmetic.

function setup(dir: string): SetupControl {
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

function makeCtx(state: PipelineState, writerControl: ControlObj, reviewControl: ControlObj, logs: string[]): StageContext {
	return {
		task: "implement feature",
		options: {},
		state,
		budget: (() => { let calls = 0; return { count: 0, check: () => calls++ < 120, spent() { this.count++; return true; } }; })(),
		log: (line: string) => { logs.push(String(line)); },
		phase() {},
		events: new EventEmitter(),
		results: [],
		async agent(call: AgentCall): Promise<AgentResult> {
			const key = (call.id ?? "").replace(/^pipeline\./, "");
			if (key === "requirementsReview") return { text: "", control: reviewControl };
			return { text: "", control: writerControl };
		},
		async helper(call: HelperCall) { return runHelper(call); },
		async parallel(calls) { return Promise.all(calls.map((call) => call())); },
	};
}

function requirementsControl(): ControlObj {
	return {
		title: "Feature Requirements",
		date: "2026-08-28",
		type: "feature",
		priority: "high",
		executiveSummary: "Build a concrete feature with resolved behavior. " + "summary ".repeat(50),
		acceptanceCriteria: [
			{ id: "AC-01", statement: "Primary behavior works." },
			{ id: "AC-02", statement: "Edge behavior is handled." },
		],
		nonFunctional: ["Performance remains acceptable."],
		openQuestions: [],
	};
}

const neverApprovingReview: ControlObj = {
	verdict: "Changes Requested",
	summary: "own defect persists",
	findings: [{ id: "RR-1", title: "own defect", detail: "keeps rejecting", severity: "high", blocking: true, status: "open" }],
};

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "sd-segment-budget-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("S3 routeBackReentry (pure)", () => {
	it("true when the journal's LAST entry is a route-back to this stage", () => {
		const specDir = join(dir, "docs/specifications/x/");
		mkdirSync(specDir, { recursive: true });
		writeFileSync(join(specDir, "routing-journal.jsonl"), JSON.stringify({ seq: 1, kind: "route-back", from: "bdd", to: "requirements", reason: "t", findingIds: [], resumeFromIndex: 2, invalidated: [], budgetBefore: 0, budgetAfter: 1, at: "2026-08-28T13:13:21Z" }) + "\n");
		expect(routeBackReentry(specDir, "requirements")).toBe(true);
	});

	it("false when the last route-back targets a DIFFERENT stage", () => {
		const specDir = join(dir, "docs/specifications/y/");
		mkdirSync(specDir, { recursive: true });
		writeFileSync(join(specDir, "routing-journal.jsonl"), JSON.stringify({ seq: 1, kind: "route-back", from: "spec", to: "bdd", reason: "t", findingIds: [], resumeFromIndex: 2, invalidated: [], budgetBefore: 0, budgetAfter: 1, at: "2026-08-28T13:13:21Z" }) + "\n");
		expect(routeBackReentry(specDir, "requirements")).toBe(false);
	});

	it("false with no journal / unreadable journal (back-compat)", () => {
		expect(routeBackReentry(join(dir, "nope"), "requirements")).toBe(false);
	});
});

describe("S3 segment-scoped round budget in the convergence node", () => {
	it("a route-back re-entry resets the round budget: the cap fatal names the BASE cap, not the inflated one", async () => {
		const s = setup(dir);
		mkdirSync(s.specDirectory, { recursive: true });
		// Pre-route-back rounds recorded in the resume cache (the inflation source)
		writeFileSync(join(s.specDirectory, ".resume-cache.jsonl"), [
			JSON.stringify({ key: "pipeline.requirements@main#1", result: {} }),
			JSON.stringify({ key: "pipeline.requirements@main#2", result: {} }),
		].join("\n") + "\n");
		// And a journal whose last entry is a route-back into requirements
		writeFileSync(join(s.specDirectory, "routing-journal.jsonl"), JSON.stringify({ seq: 1, kind: "route-back", from: "bdd", to: "requirements", reason: "t", findingIds: [], resumeFromIndex: 2, invalidated: [], budgetBefore: 0, budgetAfter: 1, at: "2026-08-28T13:13:21Z" }) + "\n");

		const state: PipelineState = { setup: s, classify: { taskType: "feature", uiScope: "none", language: "backend", isWebUi: false } };
		const logs: string[] = [];

		await expect(requirementsConvergenceNode.run(state, makeCtx(state, requirementsControl(), neverApprovingReview, logs)))
			.rejects.toThrow(/did not converge within 8 round/);
		expect(logs.join("\n")).toContain("route-back re-entry");
		expect(logs.join("\n")).not.toContain("round budget extended");
	});

	it("WITHOUT a journal entry the resume-extension behavior is preserved (prior + cap)", async () => {
		const s = setup(dir);
		mkdirSync(s.specDirectory, { recursive: true });
		writeFileSync(join(s.specDirectory, ".resume-cache.jsonl"), [
			JSON.stringify({ key: "pipeline.requirements@main#1", result: {} }),
			JSON.stringify({ key: "pipeline.requirements@main#2", result: {} }),
		].join("\n") + "\n");

		const state: PipelineState = { setup: s, classify: { taskType: "feature", uiScope: "none", language: "backend", isWebUi: false } };
		const logs: string[] = [];

		await expect(requirementsConvergenceNode.run(state, makeCtx(state, requirementsControl(), neverApprovingReview, logs)))
			.rejects.toThrow(/did not converge within 10 round/); // min(2+8, 24) = 10 — unchanged resume semantics
	});
});
