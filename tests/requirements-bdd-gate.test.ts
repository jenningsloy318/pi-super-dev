import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gate, gateValidator, task } from "../src/nodes.ts";
import { runHelper } from "../src/helpers.ts";
import type { AgentCall, AgentResult, Budget, HelperCall, PipelineState, SetupControl, Stage, StageContext } from "../src/types.ts";

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

function ctx(): StageContext {
	const budget: Budget = { count: 0, check: () => true, spent() { this.count++; return true; } };
	return {
		task: "write BDD",
		options: {},
		state: {},
		budget,
		log() {},
		phase() {},
		events: new EventEmitter(),
		results: [],
		async agent(_call: AgentCall): Promise<AgentResult> { throw new Error("agent should not run"); },
		async helper(call: HelperCall) { return runHelper(call); },
		async parallel(calls) { return Promise.all(calls.map((call) => call())); },
	};
}

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "sd-req-bdd-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("requirements -> BDD gate convergence", () => {
	it("retries the BDD writer with missing-AC feedback until every requirement is covered", async () => {
		const s = setup(dir);
		mkdirSync(s.specDirectory, { recursive: true });
		writeFileSync(`${s.specDirectory}01-requirements.md`, [
			"# Requirements",
			"## Executive Summary",
			"Implement the behavior. " + "details ".repeat(25),
			"## Acceptance Criteria",
			"- AC-01: primary behavior",
			"- AC-02: edge behavior",
			"## Non-Functional Requirements",
			"Keep it testable.",
		].join("\n"));

		let attempts = 0;
		const feedbackSeen: string[][] = [];
		const bddWriter: Stage = {
			id: "bdd",
			label: "BDD",
			async run(state) {
				attempts++;
				const feedback = ((state as Record<string, unknown>).__feedback as Record<string, string[]> | undefined)?.bdd ?? [];
				feedbackSeen.push([...feedback]);
				const coversAc02 = feedback.some((line) => line.includes("AC-02"));
				writeFileSync(`${s.specDirectory}02-bdd-scenarios.md`, [
					"# BDD Scenarios",
					"### SCENARIO-001: primary behavior",
					"**Given** AC-01 setup",
					"**When** the user runs the primary behavior",
					"**Then** AC-01 is satisfied",
					"References: AC-01",
					...(coversAc02 ? [
						"### SCENARIO-002: edge behavior",
						"**Given** AC-02 setup",
						"**When** the user runs the edge behavior",
						"**Then** AC-02 is satisfied",
						"References: AC-02",
					] : []),
				].join("\n"));
				return { docPath: `${s.specDirectory}02-bdd-scenarios.md` };
			},
		};

		const state: PipelineState = { setup: s };
		const result = await gate(
			{ validate: gateValidator("gate-bdd", "write-bdd", "bdd"), feedbackKey: "bdd", attempts: 2, fatal: true },
			task(bddWriter),
		).run(state, ctx());

		expect(result.status).toBe("ok");
		expect(attempts).toBe(2);
		expect(feedbackSeen[0]).toEqual([]);
		expect(feedbackSeen[1].join("\n")).toContain("AC-02");
		expect(((state as Record<string, unknown>).__feedback as Record<string, string[]> | undefined)?.bdd).toBeUndefined();
	});
});
