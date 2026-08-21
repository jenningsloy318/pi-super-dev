import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { specConvergenceNode } from "../src/stages/spec-convergence.ts";
import { REPLAN_REQUESTS_FILE } from "../src/replan/replan.ts";
import { runHelper } from "../src/helpers.ts";
import { getConvergenceLedger } from "../src/convergence-ledger.ts";
import { readFileSync, existsSync } from "node:fs";
import { isFatalAbort } from "../src/nodes.ts";
import { renderRetryFeedbackBlock, type RetryFeedbackInput } from "../src/retry-feedback.ts";
import type { AgentCall, AgentResult, Budget, ControlObj, HelperCall, PipelineState, SetupControl, StageContext } from "../src/types.ts";

const dims = ["Completeness", "Consistency", "Feasibility", "Testability", "Traceability", "Grounding", "Complexity", "Ambiguity"];

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

function seedDocs(s: SetupControl) {
	mkdirSync(s.specDirectory, { recursive: true });
	writeFileSync(`${s.specDirectory}01-requirements.md`, [
		"# Requirements",
		"## Executive Summary",
		"Build the feature with explicit traceability. " + "details ".repeat(30),
		"## Acceptance Criteria",
		"- AC-01: primary behavior works",
		"- AC-02: edge behavior works",
		"## Non-Functional Requirements",
		"Keep the implementation testable.",
	].join("\n"));
	writeFileSync(`${s.specDirectory}02-bdd-scenarios.md`, [
		"# BDD Scenarios",
		"### SCENARIO-001: primary behavior",
		"**Given** AC-01 setup",
		"**When** the feature runs",
		"**Then** AC-01 is satisfied",
		"References: AC-01",
		"### SCENARIO-002: edge behavior",
		"**Given** AC-02 setup",
		"**When** the edge case runs",
		"**Then** AC-02 is satisfied",
		"References: AC-02",
	].join("\n"));
}

function specControl(refs: string[], mappedRefs = refs, acRefs = ["AC-01", "AC-02"]): ControlObj {
	return {
		title: "Feature Spec",
		date: "2026-08-07",
		summary: "A complete specification. " + "summary ".repeat(35),
		architecture: "Use the existing architecture and preserve module boundaries. " + "architecture ".repeat(25),
		testingStrategy: "Unit tests and integration tests cover each mapped scenario. " + "testing ".repeat(20),
		acceptanceCriteriaRefs: acRefs,
		scenarioRefs: refs,
		// AC-11 audit: the deliverable guard is wired into gate-spec-trace, so a
		// scenario-mapped phase needs a test deliverable for this gate-clean fixture.
		phases: [{ name: "Implementation", description: "Implement and test the behavior.", scenarioRefs: mappedRefs, deliverables: { requireScenarios: mappedRefs } }],
		tasks: [{ phase: "Implementation", description: "Implement behavior for mapped scenarios.", scenarioRefs: mappedRefs }],
	};
}

function specControlWithResponses(responses: Array<Record<string, unknown>>): ControlObj {
	return { ...specControl(["SCENARIO-001", "SCENARIO-002"]), reviewResponses: responses };
}

function reviewControl(verdict: string, findings: Array<Record<string, unknown>> = []): ControlObj {
	return {
		title: "Spec Review",
		date: "2026-08-07",
		verdict,
		summary: verdict === "Approved" ? "Spec is complete." : "Spec needs correction.",
		findings,
		dimensions: dims.map((name) => ({ name, status: verdict === "Approved" ? "pass" : "fail", notes: `${name} reviewed.` })),
	};
}

function budget(): Budget {
	return { count: 0, check: () => true, spent() { this.count++; return true; } };
}

function ctx(state: PipelineState, specControls: ControlObj[], reviewControls: ControlObj[], seenSpecFeedback: RetryFeedbackInput[][]): StageContext {
	let specCalls = 0;
	let reviewCalls = 0;
	return {
		task: "implement feature",
		options: {},
		state,
		budget: budget(),
		log() {},
		phase() {},
		events: new EventEmitter(),
		results: [],
		async agent(call: AgentCall): Promise<AgentResult> {
			if (call.agent === "spec-writer") {
				const fb = ((state as Record<string, unknown>).__feedback as Record<string, RetryFeedbackInput[]> | undefined)?.spec ?? [];
				seenSpecFeedback.push([...fb]);
				return { text: "", control: specControls[Math.min(specCalls++, specControls.length - 1)] };
			}
			if (call.agent === "spec-reviewer") {
				return { text: "", control: reviewControls[Math.min(reviewCalls++, reviewControls.length - 1)] };
			}
			throw new Error(`unexpected agent ${call.agent}`);
		},
		async helper(call: HelperCall) { return runHelper(call); },
		async parallel(calls) { return Promise.all(calls.map((call) => call())); },
	};
}

let dir: string;
const savedNoInline = process.env.SUPER_DEV_NO_INLINE_ROUTEBACK;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "sd-spec-converge-")); });
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
	if (savedNoInline === undefined) delete process.env.SUPER_DEV_NO_INLINE_ROUTEBACK;
	else process.env.SUPER_DEV_NO_INLINE_ROUTEBACK = savedNoInline;
});

describe("specConvergenceNode", () => {
	it("feeds spec-review findings back into the next spec-writer attempt", async () => {
		const s = setup(dir);
		seedDocs(s);
		const state: PipelineState = { setup: s, classify: { taskType: "feature", uiScope: "none", language: "backend", isWebUi: false } };
		const seen: RetryFeedbackInput[][] = [];

		const result = await specConvergenceNode.run(
			state,
			ctx(
				state,
				[specControl(["SCENARIO-001", "SCENARIO-002"]), specControl(["SCENARIO-001", "SCENARIO-002"])],
				[
					reviewControl("Changes Requested", [{ id: "TRACE-1", severity: "high", title: "Traceability gap", detail: "Clarify AC-02 scenario mapping." }]),
					reviewControl("Approved"),
				],
				seen,
			),
		);

		expect(result.status).toBe("ok");
		expect(result.attempts).toBe(2);
		expect(seen[0]).toEqual([]);
		const renderedFeedback = renderRetryFeedbackBlock(seen[1]);
		expect(renderedFeedback).toContain("The latest specification was rejected by spec review");
		expect(renderedFeedback).not.toContain("1/5");
		expect(renderedFeedback).toContain("Traceability gap");
		expect(((state as Record<string, unknown>).__feedback as Record<string, string[]> | undefined)?.spec).toBeUndefined();
	});

	it("G1: downgrades NEW non-High blockers from round 3 and converges on a downgrade-approval", async () => {
		const s = setup(dir);
		seedDocs(s);
		const state: PipelineState = { setup: s, classify: { taskType: "feature", uiScope: "none", language: "backend", isWebUi: false } };
		const seen: RetryFeedbackInput[][] = [];
		const mediumNew = (id: string): Record<string, unknown> => ({
			id, severity: "medium", title: `Polish ${id}`, detail: "Advisory-level nit.", ownerStage: "spec", blocking: true, status: "open", recommendation: "Optional.", evidence: ["review evidence"],
		});
		const result = await specConvergenceNode.run(
			state,
			ctx(
				state,
				Array.from({ length: 3 }, () => specControl(["SCENARIO-001", "SCENARIO-002"])),
				[
					reviewControl("Changes Requested", [mediumNew("POLISH-1")]),
					reviewControl("Changes Requested", [mediumNew("POLISH-2")]),
					reviewControl("Changes Requested", [mediumNew("POLISH-3")]),
				],
				seen,
			),
		);

		// Rounds 1-2: NEW medium blockers are legitimate — rejected with feedback.
		// Round 3: same shape, but the convergence duty downgrades them to
		// advisory and the loop MUST converge instead of burning to the cap.
		expect(result.status).toBe("ok");
		expect(result.attempts).toBe(3);
		const ledger = getConvergenceLedger(state);
		const recorded = ledger.findings.find((f) => f.id === "POLISH-3");
		expect(recorded).toBeDefined();
		expect(recorded?.blocking).toBe(false);
		// duty-enforced advisories stay distinguishable from reviewer-verified
		// resolutions (audit trail): not flipped to verified, reason persisted
		expect(recorded?.status).not.toBe("verified");
		expect(String(recorded?.downgradeReason ?? "")).toContain("convergence-duty");
	});

	it("G1/R-GATE: a downgrade-approval does NOT override review-doc shape errors", async () => {
		const s = setup(dir);
		seedDocs(s);
		const state: PipelineState = { setup: s, classify: { taskType: "feature", uiScope: "none", language: "backend", isWebUi: false } };
		const seen: RetryFeedbackInput[][] = [];
		const mediumNew = (id: string): Record<string, unknown> => ({
			id, severity: "medium", title: `Polish ${id}`, detail: "Advisory-level nit.", ownerStage: "spec", blocking: true, status: "open", recommendation: "Optional.", evidence: ["review evidence"],
		});
		const partialDims = (verdict: string, findings: Array<Record<string, unknown>>): ControlObj => ({
			...reviewControl(verdict, findings),
			// only 7 of 8 required dimensions → the review DOC fails the shape
			// gate regardless of verdict wording
			dimensions: dims.slice(0, 7).map((name) => ({ name, status: "fail", notes: `${name} reviewed.` })),
		});
		const result = await specConvergenceNode.run(
			state,
			ctx(
				state,
				Array.from({ length: 4 }, () => specControl(["SCENARIO-001", "SCENARIO-002"])),
				[
					partialDims("Changes Requested", [mediumNew("S-1")]),
					partialDims("Changes Requested", [mediumNew("S-2")]),
					partialDims("Changes Requested", [mediumNew("S-3")]),
					reviewControl("Approved"),
				],
				seen,
			),
		);
		// the shape failure rejects even with downgraded findings — the override
		// applies ONLY to verdict wording, never to gate errors
		expect(result.status).toBe("ok");
		expect(result.attempts).toBe(4);
		// revert canary (adversarial R2-TESTS-NON-DISCRIMINATING): the shape
		// error, not the verdict, kept round 2 open — its feedback names the
		// missing dimension
		expect(renderRetryFeedbackBlock(seen[2])).toMatch(/dimension|spec review/i);
	});

	it("G1: validation-failure rounds do not consume the reviewer's free early passes", async () => {
		const s = setup(dir);
		seedDocs(s);
		const state: PipelineState = { setup: s, classify: { taskType: "feature", uiScope: "none", language: "backend", isWebUi: false } };
		const seen: RetryFeedbackInput[][] = [];
		const mediumNew = (id: string): Record<string, unknown> => ({
			id, severity: "medium", title: `Gap ${id}`, detail: "Coverage gap.", ownerStage: "spec", blocking: true, status: "open", recommendation: "Fix.", evidence: ["review evidence"],
		});
		const dangling = (refs: string[]): ControlObj => specControl(refs, refs);
		const result = await specConvergenceNode.run(
			state,
			ctx(
				state,
				[
					dangling(["SCENARIO-999"]), // round 1: trace gate fails — no review runs
					dangling(["SCENARIO-998"]), // round 2: trace gate fails — no review runs
					specControl(["SCENARIO-001", "SCENARIO-002"]),
					specControl(["SCENARIO-001", "SCENARIO-002"]),
				],
				[
					// loop round 3 is the reviewer's FIRST pass (reviewRound=1):
					// NEW medium blockers stay blocking — no downgrade yet
					reviewControl("Changes Requested", [mediumNew("GAP-1")]),
					reviewControl("Approved"),
				],
				seen,
			),
		);
		expect(result.status).toBe("ok");
		expect(result.attempts).toBe(4);
		// the first review pass (loop round 3) legitimately rejected with its
		// finding intact — seen[3] is the feedback state before the round-4
		// writer, i.e. the round-3 REVIEW feedback
		expect(renderRetryFeedbackBlock(seen[3])).toContain("Gap GAP-1");
	});

	it("G1: a late non-high needs-human note converges instead of killing the loop", async () => {
		const s = setup(dir);
		seedDocs(s);
		const state: PipelineState = { setup: s, classify: { taskType: "feature", uiScope: "none", language: "backend", isWebUi: false } };
		const seen: RetryFeedbackInput[][] = [];
		const needsHuman = (id: string): Record<string, unknown> => ({
			id, severity: "medium", title: "Product decision needed", detail: "AC wording requires a human decision.", ownerStage: "spec", blocking: true, status: "needs-human", recommendation: "Ask the user.", evidence: ["review evidence"],
		});
		const result = await specConvergenceNode.run(
			state,
			ctx(
				state,
				Array.from({ length: 3 }, () => specControl(["SCENARIO-001", "SCENARIO-002"])),
				[
					reviewControl("Changes Requested", [needsHuman("NH-1")]),
					reviewControl("Changes Requested", [needsHuman("NH-2")]),
					reviewControl("Changes Requested", [needsHuman("NH-3")]),
				],
				seen,
			),
		);
		// round 3 (review pass 3): the needs-human note is downgraded to
		// advisory and — via the F-A verdict-pinning gate — no longer pins the
		// verdict; the loop converges instead of spinning to the round cap
		expect(result.status).toBe("ok");
		expect(result.attempts).toBe(3);
		// NH-1/2/3 share title+detail → one merged ledger row (fingerprint key)
		const recorded = getConvergenceLedger(state).findings.find((f) => f.title === "Product decision needed");
		expect(recorded).toBeDefined();
		expect(recorded?.blocking).toBe(false);
		expect(String(recorded?.downgradeReason ?? "")).toContain("convergence-duty");
	});

	it("continues spec/review convergence beyond the shared workflow attempt count", async () => {
		const s = setup(dir);
		seedDocs(s);
		const state: PipelineState = { setup: s, classify: { taskType: "feature", uiScope: "none", language: "backend", isWebUi: false } };
		const seen: RetryFeedbackInput[][] = [];
		const result = await specConvergenceNode.run(
			state,
			ctx(
				state,
				Array.from({ length: 6 }, () => specControl(["SCENARIO-001", "SCENARIO-002"])),
				[
					...Array.from({ length: 5 }, (_, i) => reviewControl("Changes Requested", [{ id: `AMB-${i + 1}`, severity: "high", title: `Ambiguity ${i + 1}`, detail: "Clarify before implementation.", ownerStage: "spec", blocking: true, status: "open", recommendation: "Resolve ambiguity.", evidence: ["review evidence"] }])),
					reviewControl("Approved"),
				],
				seen,
			),
		);

		expect(result.status).toBe("ok");
		expect(result.attempts).toBe(6);
		expect(seen).toHaveLength(6);
		expect(renderRetryFeedbackBlock(seen[5])).toContain("Ambiguity 5");
		expect(renderRetryFeedbackBlock(seen[5])).not.toContain("/5");
	});

	it("does not run spec review until deterministic traceability passes", async () => {
		const s = setup(dir);
		seedDocs(s);
		const state: PipelineState = { setup: s, classify: { taskType: "feature", uiScope: "none", language: "backend", isWebUi: false } };
		const seen: RetryFeedbackInput[][] = [];

		const result = await specConvergenceNode.run(
			state,
			ctx(
				state,
				[
					specControl(["SCENARIO-001"], ["SCENARIO-001"], ["AC-01"]),
					specControl(["SCENARIO-001", "SCENARIO-002"]),
				],
				[reviewControl("Approved")],
				seen,
			),
		);

		expect(result.status).toBe("ok");
		expect(result.attempts).toBe(2);
		const renderedFeedback = renderRetryFeedbackBlock(seen[1]);
		expect(renderedFeedback).toContain("deterministic trace gate");
		expect(renderedFeedback).toContain("SCENARIO-002");
		expect(renderedFeedback).toContain("AC-02");
	});

	it("keeps prior spec-review findings in the ledger-backed retry prompt until verified", async () => {
		const s = setup(dir);
		seedDocs(s);
		const state: PipelineState = { setup: s, classify: { taskType: "feature", uiScope: "none", language: "backend", isWebUi: false } };
		const seen: RetryFeedbackInput[][] = [];

		const result = await specConvergenceNode.run(
			state,
			ctx(
				state,
				[
					specControl(["SCENARIO-001", "SCENARIO-002"]),
					specControlWithResponses([{ findingId: "TRACE-1", status: "addressed", response: "Mapped AC-02 to SCENARIO-002.", evidence: "phase scenarioRefs", ownerStage: "spec" }]),
					specControlWithResponses([
						{ findingId: "TRACE-1", status: "addressed", response: "Mapped AC-02 to SCENARIO-002.", evidence: "phase scenarioRefs", ownerStage: "spec" },
						{ findingId: "GROUND-2", status: "addressed", response: "Named the concrete route file.", evidence: "deliverables", ownerStage: "spec" },
					]),
				],
				[
					reviewControl("Changes Requested", [{ id: "TRACE-1", severity: "high", title: "Traceability gap", detail: "Clarify AC-02 scenario mapping.", ownerStage: "spec", blocking: true, status: "open", recommendation: "Map AC-02 to work.", evidence: ["AC-02 missing"] }]),
					reviewControl("Changes Requested", [{ id: "GROUND-2", severity: "high", title: "Wrong route file", detail: "Specific route exists and must be named.", ownerStage: "spec", blocking: true, status: "open", recommendation: "Use concrete route path.", evidence: ["refresh/route.ts exists"] }]),
					reviewControl("Approved"),
				],
				seen,
			),
		);

		expect(result.status).toBe("ok");
		expect(result.attempts).toBe(3);
		const secondAttemptFeedback = renderRetryFeedbackBlock(seen[1]);
		expect(secondAttemptFeedback).toContain("TRACE-1");
		const thirdAttemptFeedback = renderRetryFeedbackBlock(seen[2]);
		expect(thirdAttemptFeedback).toContain("TRACE-1");
		expect(thirdAttemptFeedback).toContain("GROUND-2");
		const ledger = getConvergenceLedger(state);
		expect(ledger.findings.find((f) => f.id === "TRACE-1")?.status).toBe("verified");
		expect(ledger.findings.find((f) => f.id === "GROUND-2")?.status).toBe("verified");
	});

	it("surfaces upstream-owned review findings instead of losing their owner routing", async () => {
		const s = setup(dir);
		seedDocs(s);
		const state: PipelineState = { setup: s, classify: { taskType: "feature", uiScope: "none", language: "backend", isWebUi: false } };
		const seen: RetryFeedbackInput[][] = [];

		const result = await specConvergenceNode.run(
			state,
			ctx(
				state,
				[specControl(["SCENARIO-001", "SCENARIO-002"]), specControl(["SCENARIO-001", "SCENARIO-002"])],
				[
					reviewControl("Changes Requested", [{ id: "BDD-1", severity: "high", title: "BDD example missing", detail: "BDD does not define the refresh-cookie edge case.", ownerStage: "bdd", blocking: true, status: "open", recommendation: "Add the missing BDD scenario before spec locks phases.", evidence: ["no SCENARIO for refresh-cookie edge"] }]),
					reviewControl("Approved"),
				],
				seen,
			),
		);

		expect(result.status).toBe("ok");
		const renderedFeedback = renderRetryFeedbackBlock(seen[1]);
		expect(renderedFeedback).toContain("BDD-1");
		expect(renderedFeedback).toContain("owner=bdd upstream");
		const finding = getConvergenceLedger(state).findings.find((f) => f.id === "BDD-1");
		expect(finding?.ownerStage).toBe("bdd");
		expect(finding?.invalidatesStages).toContain("spec");
		expect(finding?.invalidatesStages).toContain("implementation");
	});

	// ── F7 (adversarial F7-GATE-BYPASS): an approve-family verdict carrying a
	// blocking finding must NOT converge the spec — the gate tests only the
	// verdict wording; the loop ANDs !reviewHasBlockingFinding.
	it("does NOT approve on 'APPROVED WITH REVISIONS' when a blocking finding rides along", async () => {
		const s = setup(dir);
		seedDocs(s);
		const state: PipelineState = { setup: s, classify: { taskType: "feature", uiScope: "none", language: "backend", isWebUi: false } };
		const seen: RetryFeedbackInput[][] = [];
		const blocking = [{ id: "SR-HIGH-1", severity: "high", title: "Un-grounded route", detail: "The spec names a route that does not exist.", ownerStage: "spec", blocking: true, status: "open", recommendation: "Name a real route.", evidence: ["router has no such route"] }];

		const result = await specConvergenceNode.run(
			state,
			ctx(
				state,
				[specControl(["SCENARIO-001", "SCENARIO-002"]), specControl(["SCENARIO-001", "SCENARIO-002"])],
				[reviewControl("APPROVED WITH REVISIONS", blocking), reviewControl("Approved")],
				seen,
			),
		);

		expect(result.status).toBe("ok");
		expect(result.attempts).toBe(2);
		const renderedFeedback = renderRetryFeedbackBlock(seen[1]);
		expect(renderedFeedback).toContain("SR-HIGH-1");
		expect(getConvergenceLedger(state).findings.find((f) => f.id === "SR-HIGH-1")?.status).toBe("verified");
	});

	// ── F1 (RC3): the same upstream-owned blocking finding across 2 consecutive
	// review rounds routes back via the replan circuit instead of spinning to the
	// round cap (run 2026-08-17T05-48/06-02 died exactly this way).
	it("M5: kill-switch + unchanged upstream-owned blocker → honest round-cap fatal (emulation retired)", async () => {
		process.env.SUPER_DEV_NO_INLINE_ROUTEBACK = "1";
		const s = setup(dir);
		seedDocs(s);
		const state: PipelineState = { setup: s, classify: { taskType: "feature", uiScope: "none", language: "backend", isWebUi: false } };
		const seen: RetryFeedbackInput[][] = [];
		const upstreamFinding = [{ id: "REQ-CONTRA-1", severity: "high", title: "Requirements contradict failed-only semantics", detail: "AC-11 and AC-19 disagree on status=SUCCESS rows.", ownerStage: "requirements", blocking: true, status: "open", recommendation: "Resolve the precedence in requirements.", evidence: ["AC-11 vs AC-19"] }];

		await expect(specConvergenceNode.run(
			state,
			ctx(
				state,
				[specControl(["SCENARIO-001", "SCENARIO-002"]), specControl(["SCENARIO-001", "SCENARIO-002"])],
				[reviewControl("Changes Requested", upstreamFinding), reviewControl("Changes Requested", upstreamFinding)],
				seen,
			),
		)).rejects.toSatisfy((err: unknown) => isFatalAbort(err) && /did not converge within/.test((err as Error).message));

		// M5: the emulation never ran — no marker, no persisted requests.
		expect((state as Record<string, unknown>).__replan).toBeUndefined();
		expect(existsSync(`${s.specDirectory}replan-requests.json`)).toBe(false);
	});

	// ── M3 (v0.3.7): default-ON — the SAME shape now throws RouteBackSignal for
	// the walker (spec→requirements pilot edge) instead of the replan emulation.
	it("M3: default-ON — the unchanged upstream-owned blocker throws RouteBackSignal (inline route-back)", async () => {
		delete process.env.SUPER_DEV_NO_INLINE_ROUTEBACK;
		const s = setup(dir);
		seedDocs(s);
		const state: PipelineState = { setup: s, classify: { taskType: "feature", uiScope: "none", language: "backend", isWebUi: false } };
		const seen: RetryFeedbackInput[][] = [];
		const upstreamFinding = [{ id: "REQ-CONTRA-1", severity: "high", title: "Requirements contradict failed-only semantics", detail: "AC-11 and AC-19 disagree on status=SUCCESS rows.", ownerStage: "requirements", blocking: true, status: "open", recommendation: "Resolve the precedence in requirements.", evidence: ["AC-11 vs AC-19"] }];

		await expect(specConvergenceNode.run(
			state,
			ctx(
				state,
				[specControl(["SCENARIO-001", "SCENARIO-002"]), specControl(["SCENARIO-001", "SCENARIO-002"])],
				[reviewControl("Changes Requested", upstreamFinding), reviewControl("Changes Requested", upstreamFinding)],
				seen,
			),
		)).rejects.toSatisfy((err: unknown) => err instanceof Error && err.name === "RouteBackSignal");

		// The signal carries the pilot command — NOT the replan side effects.
		expect((state as Record<string, unknown>).__replan).toBeUndefined();
		expect(existsSync(`${s.specDirectory}replan-requests.json`)).toBe(false);
	});

	// ── AC-34 (SCENARIO-068): a round-3 verbatim restatement of a blocking
	// ledger finding recorded by an earlier review round is NOT duty-downgraded —
	// the convergence fingerprint shield keeps it blocking, so the loop rejects
	// round 3 and only a genuine later approval (round 4) converges it.
	it("AC-34: a verbatim restatement of a live blocking review finding stays blocking at round 3 (fingerprint shield)", async () => {
		const s = setup(dir);
		seedDocs(s);
		const state: PipelineState = { setup: s, classify: { taskType: "feature", uiScope: "none", language: "backend", isWebUi: false } };
		const seen: RetryFeedbackInput[][] = [];
		const restated = (id: string): Record<string, unknown> => ({
			id, severity: "medium", title: "Same traceability gap", detail: "The exact same gap restated verbatim.", ownerStage: "spec", blocking: true, status: "open", recommendation: "Fix.", evidence: ["review evidence"],
		});
		const result = await specConvergenceNode.run(
			state,
			ctx(
				state,
				Array.from({ length: 4 }, () => specControl(["SCENARIO-001", "SCENARIO-002"])),
				[
					reviewControl("Changes Requested", [restated("GAP-SAME")]),
					reviewControl("Changes Requested", [restated("GAP-SAME")]),
					reviewControl("Changes Requested", [restated("GAP-SAME")]),
					reviewControl("Approved"),
				],
				seen,
			),
		);
		// Round 3 is the reviewer's 3rd pass: the duty layer would downgrade this
		// NEW medium blocker — but it is a verbatim restatement of the blocking
		// finding rounds 1-2 recorded into the ledger (fingerprint match), so it
		// stays blocking, the review rejects, and convergence needs round 4.
		expect(result.status).toBe("ok");
		expect(result.attempts).toBe(4);
		expect(getConvergenceLedger(state).findings.some((f) => f.id === "GAP-SAME")).toBe(true);
	});

	// ── B8 (fix-in-pass, SCENARIO-068): after enforceReviewerConvergenceDuty
	// mutates the review control, the owning stage re-renders the review doc
	// (per-slug reuse, idempotent) so the artifact matches enforced
	// classifications — a downgraded finding no longer renders as blocking.
	it("B8: the spec-review doc is re-rendered after duty enforcement (downgraded finding no longer rendered as Blocking)", async () => {
		const s = setup(dir);
		seedDocs(s);
		const state: PipelineState = { setup: s, classify: { taskType: "feature", uiScope: "none", language: "backend", isWebUi: false } };
		const seen: RetryFeedbackInput[][] = [];
		const mediumNew = (id: string): Record<string, unknown> => ({
			id, severity: "medium", title: `Polish ${id}`, detail: "Advisory-level nit.", ownerStage: "spec", blocking: true, status: "open", recommendation: "Optional.", evidence: ["review evidence"],
		});
		const result = await specConvergenceNode.run(
			state,
			ctx(
				state,
				Array.from({ length: 3 }, () => specControl(["SCENARIO-001", "SCENARIO-002"])),
				[
					reviewControl("Changes Requested", [mediumNew("P-1")]),
					reviewControl("Changes Requested", [mediumNew("P-2")]),
					reviewControl("Changes Requested", [mediumNew("P-3")]),
				],
				seen,
			),
		);
		expect(result.status).toBe("ok");
		expect(result.attempts).toBe(3); // round-3 duty downgrade converges the loop
			const reviewDoc = readFileSync(join(s.specDirectory, "06-spec-review.md"), "utf8");
		expect(reviewDoc).toContain("Polish P-3");
		// enforced classification: P-3 was downgraded to advisory — the re-rendered
		// artifact must not carry the stale "**Blocking**: true" line.
		expect(reviewDoc).not.toMatch(/\*\*Blocking\*\*: true/);
	});

	// ── AC-18 (SCENARIO-039/040, M8): replan consumption is gated on GENUINE
	// approval at the spec-convergence site too — a duty-override approval
	// (review.pass false, only downgraded NEW medium findings) converges the loop
	// but leaves the pending spec request untouched; a genuine approval consumes.
	it("AC-18: spec duty-override approval does NOT consume the pending replan request; genuine approval does", async () => {
		const run = async (reviews: ControlObj[], genuine: boolean): Promise<{ status: string; attempts?: number | undefined }> => {
			const s = setup(dir);
			seedDocs(s);
			mkdirSync(s.specDirectory, { recursive: true });
			writeFileSync(join(s.specDirectory, REPLAN_REQUESTS_FILE), JSON.stringify({
				version: 1, rounds: 1,
				requests: [{
					id: "SR-01", title: "Phases contradict", detail: "Phase 1 vs Phase 2", severity: "high",
					ownerStage: "spec", classificationSource: "file-class", classificationReason: "r",
					requestedRevision: "Revise the specification to resolve the contradiction.",
					fingerprint: "fp-spec-1", status: "pending", createdAt: "t",
				}],
			}));
			const state: PipelineState = { setup: s, classify: { taskType: "feature", uiScope: "none", language: "backend", isWebUi: false } };
			const seen: RetryFeedbackInput[][] = [];
			const result = await specConvergenceNode.run(
				state,
				ctx(
					state,
					Array.from({ length: 4 }, () => specControl(["SCENARIO-001", "SCENARIO-002"])),
					reviews,
					seen,
				),
			);
			const requests = JSON.parse(readFileSync(join(s.specDirectory, REPLAN_REQUESTS_FILE), "utf8")) as { requests: Array<{ status: string; addressedAt?: string }> };
			// SCENARIO-039 shape: round-3 "Changes Requested" with only a downgraded NEW
			// medium finding — the request stays pending.
			if (!genuine) {
				expect(requests.requests[0]!.status).toBe("pending");
				expect(requests.requests[0]!.addressedAt).toBeUndefined();
				const replanFinding = getConvergenceLedger(state).findings.find((f) => f.id === "replan-SR-01");
				expect(replanFinding).toBeDefined();
				expect(replanFinding?.status).not.toBe("verified");
			} else {
				// SCENARIO-040 shape: genuine reviewer approval consumes the request.
				expect(requests.requests[0]!.status).toBe("addressed");
				expect(requests.requests[0]!.addressedAt).toBeTruthy();
			}
			return result;
		};
		// duty-override shape: rounds 1-3 rejected with distinct NEW medium findings;
		// round 3 converges via the downgrade override (review.pass stays false).
		const mediumNew = (id: string): Record<string, unknown> => ({
			id, severity: "medium", title: `Polish ${id}`, detail: "Advisory-level nit.", ownerStage: "spec", blocking: true, status: "open", recommendation: "Optional.", evidence: ["review evidence"],
		});
		const overrideRun = await run([
			reviewControl("Changes Requested", [mediumNew("Q-1")]),
			reviewControl("Changes Requested", [mediumNew("Q-2")]),
			reviewControl("Changes Requested", [mediumNew("Q-3")]),
		], false);
		expect(overrideRun.status).toBe("ok");
		expect(overrideRun.attempts).toBe(3);
		// genuine-approval counterpart: a real Approved verdict consumes the request.
		const genuineRun = await run([reviewControl("Approved")], true);
		expect(genuineRun.status).toBe("ok");
		expect(genuineRun.attempts).toBe(1);
	});
});

// ─── Phase 6 / T6.4 (AC-17): shared round-cap clamp + fresh-round arming ─────

import { extendedRoundCap, MAX_TOTAL_ROUND_MULTIPLE } from "../src/stages/artifact-convergence.ts";

/** Seed `.resume-cache.jsonl` with recorded occurrences per callId. */
function seedSpecStageRounds(specDir: string, seeds: Array<[callId: string, rounds: number]>): void {
	const rows = seeds.flatMap(([callId, rounds]) =>
		Array.from({ length: rounds }, (_, i) =>
			JSON.stringify({ key: `${callId}@root#${i + 1}`, result: { text: "", control: null } })));
	writeFileSync(join(specDir, ".resume-cache.jsonl"), rows.join("\n") + "\n");
}

describe("AC-17 (SCENARIO-037/038): spec convergence shares the clamped round accounting", () => {
	it("the shared extension helper re-clamps to the 3× ceiling (arithmetic parity)", () => {
		expect(MAX_TOTAL_ROUND_MULTIPLE).toBe(3);
		expect(extendedRoundCap(10, 8)).toBe(14);
		expect(extendedRoundCap(22, 8)).toBe(24);
	});

	it("with priorRounds=24 (effectiveCap=24) the fatal waits for one FRESH round post-replay", async () => {
		const s = setup(dir);
		seedDocs(s);
		seedSpecStageRounds(s.specDirectory, [["pipeline.spec", 24], ["pipeline.specReview", 24]]);
		const state: PipelineState = { setup: s, classify: { taskType: "feature", uiScope: "none", language: "backend", isWebUi: false } };
		let specCalls = 0;
		// The trace gate fails every round (a dangling scenario ref) — the loop
		// can only terminate at the round cap.
		const dangling = specControl(["SCENARIO-999"], [], ["AC-01", "AC-02"]);
		const scripted: StageContext = {
			...ctx(state, [dangling], [reviewControl("Approved")], []),
			async agent(call: AgentCall): Promise<AgentResult> {
				if (call.agent === "spec-writer") { specCalls++; return { text: "", control: dangling }; }
				return { text: "", control: reviewControl("Approved") };
			},
		};
		let caught: unknown;
		try {
			await specConvergenceNode.run(state, scripted);
		} catch (err) { caught = err; }
		expect(isFatalAbort(caught)).toBe(true);
		const message = String((caught as Error).message);
		expect(message).toContain("within 24 round(s)");
		// Rounds 1–24 replay, round 25 is the first FRESH writer round, the fatal
		// is round 26's entry check — the loop never dies mid-replay.
		expect(specCalls).toBe(25);
	});
});

describe("M3 G4 wiring in specConvergenceNode (revision-gate fast-forward)", () => {
	it("re-entry after a journaled jump elsewhere fast-forwards with ZERO agent calls", async () => {
		const s = setup(dir);
		seedDocs(s);
		const state: PipelineState = { setup: s, classify: { taskType: "feature", uiScope: "none", language: "backend", isWebUi: false } };
		// Pass 1: converge (records the spec's revision).
		const first = await specConvergenceNode.run(state, ctx(state, [specControl(["SCENARIO-001", "SCENARIO-002"])], [reviewControl("Approved")], []));
		expect(first.status).toBe("ok");

		// A jump happened elsewhere (journaled) — spec's revision unchanged,
		// no pending requests, and the trace gate re-validates the artifact.
		const { chargeRoutingJump } = await import("../src/routing/journal.ts");
		chargeRoutingJump(s.specDirectory, { from: "bdd", to: "requirements", reason: "upstream blocker", findingIds: ["F"], resumeFromIndex: 1, invalidated: ["requirements"], at: new Date().toISOString(), cacheDropped: 1, revisionAfter: 1 });

		let agentCalls = 0;
		const log: string[] = [];
		const seen: RetryFeedbackInput[][] = [];
		const silentCtx: StageContext = {
			...ctx(state, [], [], seen),
			log: (m: string) => log.push(m),
			async agent() { agentCalls++; throw new Error("fast-forward must not call agents"); },
		};
		const second = await specConvergenceNode.run(state, silentCtx);
		expect(second.status).toBe("ok");
		expect(second.attempts).toBe(0);
		expect(agentCalls).toBe(0);
		expect(log.some((l) => l.includes("revision-gate FAST-FORWARD"))).toBe(true);
	});
});
