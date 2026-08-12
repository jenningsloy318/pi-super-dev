/**
 * Smoke + integration test for the upstream review→fix convergence loop.
 *
 * Unlike artifact-convergence.test.ts (pure control-flow, no disk), this drives
 * the requirements convergence node end-to-end through the REAL render pipeline
 * against a REAL temp project directory: the fake agents return schema-conforming
 * data, so `writerTask`/`renderAndWrite` actually validate, render, and WRITE the
 * `NN-<slug>.md` files to disk — proving the whole chain (schema → template →
 * doc-path reservation → reviewer doc) is wired correctly.
 *
 * Asserts:
 *  - the requirements doc AND the requirements-review doc are written to disk,
 *    numbered and named as `NN-requirements.md` / `NN-requirements-review.md`;
 *  - a reject→fix→approve cycle re-writes the SAME files in place (no index drift);
 *  - the review doc content reflects the reviewer's verdict + findings.
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, readdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentCall, AgentResult, ControlObj, PipelineState, StageContext } from "../src/types.ts";
import { requirementsConvergenceNode } from "../src/stages/artifact-convergence.ts";

let specDir = "";
let worktree = "";

afterEach(() => {
	for (const d of [specDir, worktree]) {
		if (d && existsSync(d)) rmSync(d, { recursive: true, force: true });
	}
	specDir = worktree = "";
});

function makeState(): PipelineState {
	worktree = mkdtempSync(join(tmpdir(), "sd-wt-"));
	specDir = mkdtempSync(join(tmpdir(), "sd-spec-")) + "/"; // trailing slash: specDoc concatenates
	return {
		task: "add a CSV export feature",
		options: {} as never,
		setup: {
			worktreePath: worktree,
			specDirectory: specDir,
			defaultBranch: "main",
			language: "backend",
			isWebUi: false,
			specIdentifier: "01",
			worktreeCreated: false,
			initializedRepo: false,
		},
		classify: { taskType: "feature", uiScope: "none", language: "backend", isWebUi: false },
	} as unknown as PipelineState;
}

/** A REQUIREMENTS control object that conforms to RequirementsData. */
const requirementsData = (): ControlObj => ({
	title: "CSV Export",
	date: "2026-08-12",
	type: "feature",
	priority: "high",
	executiveSummary: "Export the report as CSV.",
	acceptanceCriteria: [
		{ id: "AC-01", statement: "User can trigger a CSV export." },
		{ id: "AC-02", statement: "Exported CSV includes all visible columns." },
	],
	nonFunctional: ["Export completes within 2s for 10k rows."],
	openQuestions: [],
} as ControlObj);

/** A REQUIREMENTS-REVIEW control object that conforms to RequirementsReviewData. */
const reviewData = (verdict: string, blocking: boolean): ControlObj => ({
	title: "Requirements Review — CSV Export",
	date: "2026-08-12",
	verdict,
	summary: blocking ? "One acceptance criterion is not measurable." : "Requirements are testable and complete.",
	findings: blocking
		? [{ id: "RR-01", severity: "high", title: "AC-01 lacks a measurable outcome", detail: "define the exact trigger + observable result", blocking: true, ownerStage: "requirements", status: "open", recommendation: "add a concrete assertion" }]
		: [],
	dimensions: [
		{ name: "Testability", status: blocking ? "fail" : "pass", notes: "AC measurability" },
		{ name: "Completeness", status: "pass", notes: "error paths present" },
	],
} as ControlObj);

function makeCtx(reviews: ControlObj[], logs: string[]): StageContext {
	let rounds = 0;
	let writerRounds = 0;
	return {
		task: "add a CSV export feature",
		options: {}, // no escalate → loop keeps going until reviewer approves
		state: {} as PipelineState,
		budget: { check: () => rounds++ < 80, spent: () => true, count: 0 },
		log: (m: string) => logs.push(m),
		phase: () => {},
		events: { on() {}, off() {}, emit() {} },
		results: [],
		signal: undefined,
		async agent(call: AgentCall): Promise<AgentResult> {
			if (call.id === "pipeline.requirements") {
				writerRounds++;
				return { text: "", control: requirementsData() };
			}
			if (call.id === "pipeline.requirementsReview") {
				const idx = Math.min(writerRounds - 1, reviews.length - 1);
				return { text: "", control: reviews[idx] };
			}
			return { text: "", control: {} as ControlObj };
		},
		// gate-requirements: the doc is on disk (writerTask rendered it), so the real
		// helper would pass; return pass:true to isolate the review layer.
		async helper() {
			return { value: { pass: true, errors: [] } as ControlObj, digest: "PASS" };
		},
		async parallel() {
			return [];
		},
	} as unknown as StageContext;
}

const docsIn = (dir: string) => readdirSync(dir).filter((f) => /^\d{2}-.+\.md$/.test(f)).sort();

describe("integration: upstream requirements review writes real docs (smoke)", () => {
	it("SMOKE — approve in one round: requirements + requirements-review docs are written", async () => {
		const logs: string[] = [];
		const state = makeState();
		const ctx = makeCtx([reviewData("Approved", false)], logs);
		const result = await requirementsConvergenceNode.run(state, ctx);

		expect(result.status).toBe("ok");
		const docs = docsIn(specDir);
		// Exactly two numbered docs: the requirements artifact and its review.
		expect(docs.some((d) => /^\d{2}-requirements\.md$/.test(d))).toBe(true);
		expect(docs.some((d) => /^\d{2}-requirements-review\.md$/.test(d))).toBe(true);

		const reviewFile = docs.find((d) => /-requirements-review\.md$/.test(d))!;
		const body = readFileSync(join(specDir, reviewFile), "utf8");
		expect(body).toContain("Approved");
	});

	it("INTEGRATION — reject→fix→approve re-writes the SAME files in place (no index drift)", async () => {
		const logs: string[] = [];
		const state = makeState();
		const ctx = makeCtx([reviewData("Changes Requested", true), reviewData("Approved", false)], logs);
		const result = await requirementsConvergenceNode.run(state, ctx);

		expect(result.status).toBe("ok");
		const docs = docsIn(specDir);
		// Still exactly ONE requirements doc and ONE review doc despite two rounds —
		// the idempotent doc-path reservation overwrote in place, no NN drift.
		expect(docs.filter((d) => /-requirements\.md$/.test(d)).length).toBe(1);
		expect(docs.filter((d) => /-requirements-review\.md$/.test(d)).length).toBe(1);

		// The final review doc on disk is the APPROVED one (the fix cycle converged).
		const reviewFile = docs.find((d) => /-requirements-review\.md$/.test(d))!;
		const body = readFileSync(join(specDir, reviewFile), "utf8");
		expect(body).toContain("Approved");
		expect(body).not.toContain("AC-01 lacks a measurable outcome");
	});
});
