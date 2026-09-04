import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bddConvergenceNode, requirementsConvergenceNode, researchConvergenceNode, effectiveRoundCap, MAX_CONVERGENCE_ROUNDS, PROGRESS_EXTENSION_ROUNDS } from "../src/stages/artifact-convergence.ts";
import { reviewVerdictApproves } from "../src/stages/artifact-convergence.ts";
import { NEGATED_APPROVAL_RE } from "../src/review-findings.ts";
import { runHelper } from "../src/helpers.ts";
import { renderRetryFeedbackBlock, type RetryFeedbackInput } from "../src/retry-feedback.ts";
import type { AgentCall, AgentResult, Budget, ControlObj, HelperCall, PipelineState, SetupControl, StageContext } from "../src/types.ts";

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

function budget(maxRounds = 20): Budget {
	// Bounded: the old `check: () => true` let a never-approving reviewer loop
	// forever (→ OOM). 20 is well above the 6-round convergence these scenarios
	// exercise; the MAX_CONVERGENCE_ROUNDS liveness cap is the real backstop.
	let calls = 0;
	return { count: 0, check: () => calls++ < maxRounds, spent() { this.count++; return true; } };
}

function ctx(state: PipelineState, controls: ControlObj[], seen: RetryFeedbackInput[][]): StageContext {
	let writerCalls = 0;
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
			const key = (call.id ?? "").replace(/^pipeline\./, "");
			const fb = ((state as Record<string, unknown>).__feedback as Record<string, RetryFeedbackInput[]> | undefined)?.[key] ?? [];
			seen.push([...fb]);
			// The shift-left reviewer (requirementsReview / bddReview) must APPROVE for
			// the loop to converge once the deterministic gate passes. The pre-review
			// era this file was written for never supplied verdicts, so (after the
			// review-layer regression) it looped forever → OOM. research has NO reviewer.
			if (key === "requirementsReview" || key === "bddReview") {
				return { text: "", control: { verdict: "Approved", summary: "approved", findings: [] } as ControlObj };
			}
			return { text: "", control: controls[Math.min(writerCalls++, controls.length - 1)] };
		},
		async helper(call: HelperCall) { return runHelper(call); },
		async parallel(calls) { return Promise.all(calls.map((call) => call())); },
	};
}

function requirementsControl(openQuestions: string[] = []): ControlObj {
	return {
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
		openQuestions,
	};
}

function bddControl(coverAc02: boolean): ControlObj {
	const scenarios = [
		{ id: "001", title: "primary behavior", acRef: "AC-01", priority: "high", given: "AC-01 setup", when: "the feature runs", then: "AC-01 is satisfied" },
		...(coverAc02 ? [{ id: "002", title: "edge behavior", acRef: "AC-02", priority: "high", given: "AC-02 setup", when: "the edge case runs", then: "AC-02 is satisfied" }] : []),
	];
	return {
		title: "Feature BDD",
		date: "2026-08-10",
		source: "01-requirements.md",
		features: [{ name: "Feature", scenarios }],
		traceability: scenarios.map((scenario) => ({ acId: scenario.acRef, description: scenario.title, scenarios: [`SCENARIO-${scenario.id}`] })),
	};
}

function researchControl(openIssues: string[] = []): ControlObj {
	return {
		title: "Feature Research",
		date: "2026-08-10",
		summary: "Research completed with source-backed recommendations. " + "details ".repeat(25),
		options: [{ name: "Use existing platform pattern", tradeoffs: "Grounded in the platform documentation and keeps implementation small." }],
		sources: [{ title: "Platform Docs", url: "https://example.com/platform-docs" }],
		openIssues,
	};
}

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "sd-artifact-converge-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("artifact convergence nodes", () => {
	it("continues requirements clarification beyond five rounds until open questions are resolved", async () => {
		const s = setup(dir);
		mkdirSync(s.specDirectory, { recursive: true });
		const state: PipelineState = { setup: s, classify: { taskType: "feature", uiScope: "none", language: "backend", isWebUi: false } };
		const seen: RetryFeedbackInput[][] = [];

		const result = await requirementsConvergenceNode.run(
			state,
			ctx(state, [...Array.from({ length: 5 }, () => requirementsControl(["Which behavior should win?"])), requirementsControl([])], seen),
		);

		expect(result.status).toBe("ok");
		expect(result.attempts).toBe(6);
		expect(renderRetryFeedbackBlock(seen[5])).toContain("open question");
		expect(renderRetryFeedbackBlock(seen[5])).not.toContain("/5");
	});

	it("continues BDD convergence beyond five rounds until every requirement AC is covered", async () => {
		const s = setup(dir);
		mkdirSync(s.specDirectory, { recursive: true });
		writeFileSync(`${s.specDirectory}01-requirements.md`, [
			"# Requirements",
			"## Executive Summary",
			"Implement the behavior. " + "details ".repeat(40),
			"## Acceptance Criteria",
			"- AC-01: primary behavior",
			"- AC-02: edge behavior",
			"## Non-Functional Requirements",
			"Performance remains acceptable.",
		].join("\n"));
		const state: PipelineState = { setup: s, requirements: { docPath: `${s.specDirectory}01-requirements.md` } };
		const seen: RetryFeedbackInput[][] = [];

		const result = await bddConvergenceNode.run(
			state,
			ctx(state, [...Array.from({ length: 5 }, () => bddControl(false)), bddControl(true)], seen),
		);

		expect(result.status).toBe("ok");
		expect(result.attempts).toBe(6);
		expect(renderRetryFeedbackBlock(seen[5])).toContain("AC-02");
		expect(renderRetryFeedbackBlock(seen[5])).not.toContain("/5");
	});

	it("continues research beyond five rounds until open issues are source-backed or cleared", async () => {
		const s = setup(dir);
		mkdirSync(s.specDirectory, { recursive: true });
		const state: PipelineState = { setup: s, classify: { taskType: "feature", uiScope: "none", language: "backend", isWebUi: false } };
		const seen: RetryFeedbackInput[][] = [];

		const result = await researchConvergenceNode.run(
			state,
			ctx(state, [...Array.from({ length: 5 }, () => researchControl(["Which protocol version applies?"])), researchControl([])], seen),
		);

		expect(result.status).toBe("ok");
		expect(result.attempts).toBe(6);
		expect(renderRetryFeedbackBlock(seen[5])).toContain("Which protocol version applies");
		expect(renderRetryFeedbackBlock(seen[5])).not.toContain("/5");
	});
});

// ── AC-28 (SCENARIO-057/058): negated approvals never classify as approvals ──
describe("AC-28 (SCENARIO-057): reviewVerdictApproves rejects negated approval verdicts", () => {
	it("negation guard fires BEFORE the approve-family match", () => {
		for (const v of ["not approved", "does not pass", "not passing", "approved: no", "NOT APPROVED", "Does Not Pass"]) {
			expect(reviewVerdictApproves(v), v).toBe(false);
		}
	});
	it("the shared NEGATED_APPROVAL_RE itself matches every negated form and no approve-family form", () => {
		for (const v of ["not approved", "does not pass", "not passing", "approved: no", "never approved", "isn't passing", "NOT APPROVED", "Does Not Pass"]) {
			expect(NEGATED_APPROVAL_RE.test(v), v).toBe(true);
		}
		for (const v of ["Approved", "Approved with Comments", "APPROVED WITH REVISIONS", "PASS", "passing"]) {
			expect(NEGATED_APPROVAL_RE.test(v), v).toBe(false);
		}
	});
});

describe("AC-28 (SCENARIO-058): reviewVerdictApproves keeps the approve family approving", () => {
	it("approve-family verdicts still return true (existing behavior unchanged)", () => {
		for (const v of ["Approved", "Approved with Comments", "APPROVED WITH REVISIONS"]) {
			expect(reviewVerdictApproves(v), v).toBe(true);
		}
	});
});

// ── F2/F3 (adversarial TESTS-MISSING): the round-budget math the convergence
// loops use — resume grants fresh rounds (prior + cap) clamped at 3× the base
// cap, so replay-only resumes fail fast instead of ping-ponging forever.
describe("round-budget math (F2/F3)", () => {
	it("fresh run: effectiveCap = cap", () => {
		expect(effectiveRoundCap(MAX_CONVERGENCE_ROUNDS, 0)).toBe(MAX_CONVERGENCE_ROUNDS);
	});
	it("resume grants fresh rounds: prior + cap", () => {
		expect(effectiveRoundCap(8, 8)).toBe(16);
	});
	it("clamps at 3× the base cap — a replay-happy spec cannot extend forever", () => {
		expect(effectiveRoundCap(8, 40)).toBe(24);
	});
	it("progress extension block is exported and bounded", () => {
		expect(PROGRESS_EXTENSION_ROUNDS).toBeGreaterThan(0);
		expect(PROGRESS_EXTENSION_ROUNDS).toBeLessThanOrEqual(4);
	});
});

// ─── Phase 6 / T6.4 (AC-17): round-cap clamp + fresh-round arming ────────────

import * as artifactConv from "../src/stages/artifact-convergence.ts";
import { resetJudgeBudgets } from "../src/stages/judge.ts";
import { isFatalAbort } from "../src/nodes.ts";

/** Seed `.resume-cache.jsonl` with recorded occurrences per callId — the
 *  persisted count a resumed convergence loop reads via countStageRounds.
 *  Multiple callIds accumulate into ONE file (last write wins would clobber). */
function seedStageRounds(specDir: string, seeds: Array<[callId: string, rounds: number]>): void {
	const rows = seeds.flatMap(([callId, rounds]) =>
		Array.from({ length: rounds }, (_, i) =>
			JSON.stringify({ key: `${callId}@root#${i + 1}`, result: { text: "", control: null } })));
	writeFileSync(join(specDir, ".resume-cache.jsonl"), rows.join("\n") + "\n");
}

interface ScriptedRound {
	/** requirements writer control returned every round. */
	writer: ControlObj;
	/** per-round requirementsReview controls (defaults to an approving verdict). */
	reviews?: ControlObj[];
}

/** A scripted StageContext that counts writer/review/judge agent calls and can
 *  run an unbounded number of rounds (the cap under test is the loop's own). */
function scriptedCtx(
	state: PipelineState,
	rounds: ScriptedRound,
	opts: { maxBudget?: number; judgeControl?: Record<string, unknown> } = {},
): { ctx: StageContext; writerCalls: () => number; reviewCalls: () => number } {
	let writerCalls = 0;
	let reviewCalls = 0;
	// generous: the loop head AND every gate call each consume one budget check
	const maxBudget = opts.maxBudget ?? 400;
	let checks = 0;
	return {
		writerCalls: () => writerCalls,
		reviewCalls: () => reviewCalls,
		ctx: {
			task: "implement feature",
			options: {},
			state,
			budget: { count: 0, check: () => checks++ < maxBudget, spent() { this.count++; return true; } },
			log() {},
			phase() {},
			events: new EventEmitter(),
			results: [],
			async agent(call: AgentCall): Promise<AgentResult> {
				if (call.agent === "judge") {
					return { text: "", control: (opts.judgeControl ?? {}) as ControlObj };
				}
				const key = (call.id ?? "").replace(/^pipeline\./, "");
				if (key === "requirementsReview") {
					reviewCalls++;
					const reviews = rounds.reviews ?? [];
					return { text: "", control: reviews[Math.min(reviewCalls - 1, reviews.length - 1)] ?? { verdict: "Approved", summary: "approved", findings: [] } as ControlObj };
				}
				writerCalls++;
				return { text: "", control: rounds.writer };
			},
			async helper(call: HelperCall) { return runHelper(call); },
			async parallel(calls) { return Promise.all(calls.map((call) => call())); },
		},
	};
}

/** A rejected review round: N new HIGH blocking findings (never duty-downgraded)
 *  plus reviewer-verified resolutions of every finding the previous round raised. */
function rejectingReviewControl(ids: string[], resolvedIds: string[]): ControlObj {
	return {
		verdict: "Changes Requested",
		summary: "blocking correctness defects remain",
		findings: ids.map((id) => ({
			id, severity: "high", title: `High defect ${id}`, detail: `Correctness defect ${id}.`, ownerStage: "requirements",
			blocking: true, status: "open", recommendation: "Fix it.", evidence: ["review evidence"],
		})),
		priorFindingResolutions: resolvedIds.map((id) => ({ findingId: id, status: "verified", response: "resolved", evidence: "ok" })),
	} as ControlObj;
}

describe("AC-17 (SCENARIO-037): effective-cap arithmetic clamps to 3× maxRounds at every step", () => {
	it("effectiveRoundCap(priorRounds) for p ∈ {2,20,24,30} ⇒ {10,24,24,24} (maxRounds 8)", () => {
		expect(artifactConv.effectiveRoundCap(8, 2)).toBe(10);
		expect(artifactConv.effectiveRoundCap(8, 20)).toBe(24);
		expect(artifactConv.effectiveRoundCap(8, 24)).toBe(24);
		expect(artifactConv.effectiveRoundCap(8, 30)).toBe(24);
	});
	it("extendedRoundCap re-clamps the +4 extension to the 3× ceiling — never 28", () => {
		expect(artifactConv.extendedRoundCap(10, 8)).toBe(14);
		expect(artifactConv.extendedRoundCap(22, 8)).toBe(24);
		expect(artifactConv.extendedRoundCap(24, 8)).toBe(24);
	});
	it("MAX_TOTAL_ROUND_MULTIPLE is exported as 3", () => {
		expect(artifactConv.MAX_TOTAL_ROUND_MULTIPLE).toBe(3);
	});
});

describe("AC-17 (SCENARIO-038): the cap fatal fires only after a FRESH post-replay round", () => {
	const savedJudge = process.env.SUPER_DEV_DISABLE_JUDGE;
	beforeEach(() => { process.env.SUPER_DEV_DISABLE_JUDGE = "1"; });
	afterEach(() => {
		if (savedJudge === undefined) delete process.env.SUPER_DEV_DISABLE_JUDGE;
		else process.env.SUPER_DEV_DISABLE_JUDGE = savedJudge;
	});

	it("with priorRounds=24 (effectiveCap=24) the fatal waits for round 26 — one fresh round executes first", async () => {
		const s = setup(dir);
		mkdirSync(s.specDirectory, { recursive: true });
		seedStageRounds(s.specDirectory, [["pipeline.requirements", 24]]);
		const state: PipelineState = { setup: s, classify: { taskType: "feature", uiScope: "none", language: "backend", isWebUi: false } };
		const harness = scriptedCtx(state, { writer: requirementsControl(["Which behavior should win?"]) });
		let caught: unknown;
		try {
			await requirementsConvergenceNode.run(state, harness.ctx);
		} catch (err) { caught = err; }
		expect(isFatalAbort(caught)).toBe(true);
		const message = String((caught as Error).message);
		// The terminal message reports the effective cap.
		expect(message).toContain("did not converge within 24 round(s)");
		// …and it fired only AFTER one FRESH writer round post-replay: rounds 1–24
		// replay, round 25 executes, the fatal is round 26's entry check.
		expect(harness.writerCalls()).toBe(25);
	});
});

describe("AC-17 (SCENARIO-038): the strict-progress extension is never granted on replayed review readings", () => {
	const savedJudge = process.env.SUPER_DEV_DISABLE_JUDGE;
	beforeEach(() => { process.env.SUPER_DEV_DISABLE_JUDGE = "1"; });
	afterEach(() => {
		if (savedJudge === undefined) delete process.env.SUPER_DEV_DISABLE_JUDGE;
		else process.env.SUPER_DEV_DISABLE_JUDGE = savedJudge;
	});

	it("strictly-decreasing replayed readings (2→1) do NOT extend the 3×-clamped cap", async () => {
		const s = setup(dir);
		mkdirSync(s.specDirectory, { recursive: true });
		// 24 recorded writer rounds (effectiveCap = 24) and 30 recorded REVIEW
		// rounds — every review the loop runs here is a cache replay.
		seedStageRounds(s.specDirectory, [["pipeline.requirements", 24], ["pipeline.requirementsReview", 30]]);
		const state: PipelineState = { setup: s, classify: { taskType: "feature", uiScope: "none", language: "backend", isWebUi: false } };
		// Validation passes every round; the review rejects with strictly
		// decreasing own-open counts (2 per round, then 1 at round 24+). Under
		// replay-blind progress tracking that pattern would grant the +4
		// extension (cap 28) — replayed readings carry no fresh information.
		const reviews = Array.from({ length: 30 }, (_, r) => {
			const round = r + 1;
			const count = round >= 25 ? 1 : 2;
			const ids = Array.from({ length: count }, (_, k) => `R${round}-${k + 1}`);
			const priorRound = round - 1;
			const resolved = priorRound >= 1
				? Array.from({ length: priorRound >= 25 ? 1 : 2 }, (_, k) => `R${priorRound}-${k + 1}`)
				: [];
			return rejectingReviewControl(ids, resolved);
		});
		const harness = scriptedCtx(state, { writer: requirementsControl([]), reviews });
		let caught: unknown;
		try {
			await requirementsConvergenceNode.run(state, harness.ctx);
		} catch (err) { caught = err; }
		expect(isFatalAbort(caught)).toBe(true);
		const message = String((caught as Error).message);
		expect(message).toContain("did not converge within 24 round(s)");
		expect(message).not.toContain("within 28 round(s)");
		expect(harness.writerCalls()).toBe(25);
	});
});

describe("AC-17 (+B4/D10): the J10 judge escalate-now fatal reports the EFFECTIVE cap and only fires with real evidence", () => {
	const savedJudge = process.env.SUPER_DEV_DISABLE_JUDGE;
	beforeEach(() => { resetJudgeBudgets(); delete process.env.SUPER_DEV_DISABLE_JUDGE; });
	afterEach(() => {
		if (savedJudge === undefined) delete process.env.SUPER_DEV_DISABLE_JUDGE;
		else process.env.SUPER_DEV_DISABLE_JUDGE = savedJudge;
	});

	function judgeHarness(judgeControl: Record<string, unknown>) {
		const s = setup(dir);
		mkdirSync(s.specDirectory, { recursive: true });
		// 2 recorded rounds → effectiveCap = 10 (≠ maxRounds 8, so the message
		// distinguishes the reported cap).
		seedStageRounds(s.specDirectory, [["pipeline.requirements", 2]]);
		writeFileSync(join(s.worktreePath, "ev.txt"), "ANCHOR_LINE_FOR_JUDGE_EVIDENCE_1234567890\n");
		const state: PipelineState = { setup: s, classify: { taskType: "feature", uiScope: "none", language: "backend", isWebUi: false } };
		return scriptedCtx(state, { writer: requirementsControl(["Which behavior should win?"]) }, { judgeControl });
	}

	it("an evidence-backed escalate-now aborts at the cap round naming the EFFECTIVE cap (10, not 8)", async () => {
		const harness = judgeHarness({
			diagnosis: "the requirements gate is structurally unsatisfiable",
			route: "escalate-now",
			confidence: 0.9,
			evidence: [{ file: "ev.txt", quote: "ANCHOR_LINE_FOR_JUDGE_EVIDENCE_1234567890" }],
		});
		let caught: unknown;
		try {
			await requirementsConvergenceNode.run(stateFor(harness), harness.ctx);
		} catch (err) { caught = err; }
		expect(isFatalAbort(caught)).toBe(true);
		const message = String((caught as Error).message);
		expect(message).toContain("did not converge within 10 round(s)");
		expect(message).not.toContain("within 8 round(s)");
		expect(message).toContain("structurally unsatisfiable");
	});

	it("an evidence-LESS escalate-now falls through to the normal cap path (no early judge fatal)", async () => {
		const harness = judgeHarness({
			diagnosis: "the requirements gate is structurally unsatisfiable",
			route: "escalate-now",
			confidence: 0.9,
			evidence: [],
		});
		let caught: unknown;
		try {
			await requirementsConvergenceNode.run(stateFor(harness), harness.ctx);
		} catch (err) { caught = err; }
		expect(isFatalAbort(caught)).toBe(true);
		const message = String((caught as Error).message);
		// The terminal state is the ROUND CAP fatal, not the judge diagnosis.
		expect(message).toContain("did not converge within 10 round(s)");
		expect(message).not.toContain("structurally unsatisfiable");
		// Rounds 1–10 ran (the judge fired at round 9 and did NOT abort early).
		expect(harness.writerCalls()).toBe(10);
	});
});

/** The scripted harness closes over its own state; expose it for run(). */
function stateFor(harness: { ctx: StageContext }): PipelineState {
	return harness.ctx.state as PipelineState;
}

// ── M3 (v0.3.7): G4 revision-gate wiring — the artifact node fast-forwards ──

describe("M3 G4 wiring (revision-gate green-skip in artifactConvergenceNode)", () => {
	it("re-entry after a jump elsewhere fast-forwards with ZERO agent calls; a revision bump re-runs", async () => {
		const s = setup(dir);
		mkdirSync(s.specDirectory, { recursive: true });
		writeFileSync(`${s.specDirectory}01-requirements.md`, [
			"# Requirements",
			"## Executive Summary",
			"Implement the behavior. " + "details ".repeat(40),
			"## Acceptance Criteria",
			"- AC-01: primary behavior",
			"- AC-02: edge behavior",
			"## Non-Functional Requirements",
			"Performance remains acceptable.",
		].join("\n"));

		// Pass 1: converge BDD normally (records the converged revision).
		const state: PipelineState = { setup: s, requirements: { docPath: `${s.specDirectory}01-requirements.md` } };
		const first = await bddConvergenceNode.run(state, ctx(state, [bddControl(true)], []));
		expect(first.status).toBe("ok");

		// A jump happened ELSEWHERE on the track (journaled) — BDD's own
		// artifact revision is unchanged and no requests target it.
		const { chargeRoutingJump } = await import("../src/routing/journal.ts");
		chargeRoutingJump(s.specDirectory, { from: "spec", to: "requirements", reason: "upstream blocker", findingIds: ["F"], resumeFromIndex: 1, invalidated: ["requirements"], at: new Date().toISOString(), cacheDropped: 1, revisionAfter: 1 });

		// Re-entry: the agent channel must stay SILENT — any call fails the test.
		let agentCalls = 0;
		const log: string[] = [];
		const silentCtx: StageContext = {
			...ctx(state, [], []),
			log: (m: string) => log.push(m),
			async agent() { agentCalls++; throw new Error("fast-forward must not call agents"); },
		};
		const second = await bddConvergenceNode.run(state, silentCtx);
		expect(second.status).toBe("ok");
		expect(second.attempts).toBe(0);
		expect(agentCalls).toBe(0);
		expect(log.some((l) => l.includes("revision-gate FAST-FORWARD"))).toBe(true);

		// Negative control: a later jump TARGETING bdd bumps its revision —
		// the recorded revision no longer matches, so the loop re-runs.
		writeFileSync(`${s.specDirectory}artifact-revisions.json`, JSON.stringify({ bdd: 1 }));
		const third = await bddConvergenceNode.run(state, ctx(state, [bddControl(true)], []));
		expect(third.status).toBe("ok");
		expect(third.attempts).toBeGreaterThan(0);
	});

	it("M3 round-2: research NEVER fast-forwards (fastForwardable unset); design is opted out by source", async () => {
		const s = setup(dir);
		mkdirSync(s.specDirectory, { recursive: true });
		writeFileSync(`${s.specDirectory}01-requirements.md`, [
			"# Requirements",
			"## Executive Summary",
			"Implement the behavior. " + "details ".repeat(40),
			"## Acceptance Criteria",
			"- AC-01: primary behavior",
			"- AC-02: edge behavior",
			"## Non-Functional Requirements",
			"Performance remains acceptable.",
		].join("\n"));
		const state: PipelineState = { setup: s, requirements: { docPath: `${s.specDirectory}01-requirements.md` } };
		const first = await researchConvergenceNode.run(state, ctx(state, [researchControl([])], []));
		expect(first.status).toBe("ok");
		const { chargeRoutingJump } = await import("../src/routing/journal.ts");
		chargeRoutingJump(s.specDirectory, { from: "spec", to: "requirements", reason: "upstream blocker", findingIds: ["F"], resumeFromIndex: 1, invalidated: ["requirements"], at: new Date().toISOString(), cacheDropped: 1, revisionAfter: 1 });
		// Research re-runs its writer loop (agent called again) — no gate.
		const calls: string[] = [];
		const seenCtx: StageContext = {
			...ctx(state, [researchControl([])], []),
			async agent(call: AgentCall) { calls.push(call.agent ?? (call.id ?? "")); return ctx(state, [researchControl([])], []).agent(call); },
		};
		const second = await researchConvergenceNode.run(state, seenCtx);
		expect(second.status).toBe("ok");
		expect(second.attempts).toBeGreaterThan(0);
		expect(calls.length).toBeGreaterThan(0);
		// Design source-pin: designConvergenceNode does NOT set fastForwardable
		// (designComplete is a contract-claims sensor, not a cross-doc gate).
		const src = readFileSync("src/stages/artifact-convergence.ts", "utf8");
		const designNode = src.slice(src.indexOf("export const designConvergenceNode"));
		expect(designNode.slice(0, 1200)).not.toContain("fastForwardable: true");
	});
});

// ── M4 (v0.3.8): the escalation route-back choice drives an INLINE jump ─────
// v0.3.19: the single-routable-owner shape this block exercises now AUTO-ROUTES
// by default (no human wait) — the human decision surface below is live code
// gated by SUPER_DEV_NO_AUTO_ROUTEBACK=1, so these tests pin it with the
// kill-switch set (default-ON behavior is pinned in
// src/stages/artifact-convergence.test.ts v0.3.19 AUTO-ROUTE block).
describe("M4 escalation route-back choice (G6)", () => {
	const savedAutoKill = process.env.SUPER_DEV_NO_AUTO_ROUTEBACK;
	beforeAll(() => { process.env.SUPER_DEV_NO_AUTO_ROUTEBACK = "1"; });
	afterAll(() => {
		if (savedAutoKill === undefined) delete process.env.SUPER_DEV_NO_AUTO_ROUTEBACK;
		else process.env.SUPER_DEV_NO_AUTO_ROUTEBACK = savedAutoKill;
	});
	it("a user-chosen route-back throws RouteBackSignal (inline jump), not a retry round", async () => {
		const s = setup(dir);
		mkdirSync(s.specDirectory, { recursive: true });
		writeFileSync(`${s.specDirectory}01-requirements.md`, [
			"# Requirements",
			"## Executive Summary",
			"Implement the behavior. " + "details ".repeat(40),
			"## Acceptance Criteria",
			"- AC-01: primary behavior",
			"- AC-02: edge behavior",
			"## Non-Functional Requirements",
			"Performance remains acceptable.",
		].join("\n"));
		const state: PipelineState = { setup: s, requirements: { docPath: `${s.specDirectory}01-requirements.md` } };

		const upstreamFinding = [{ id: "REQ-BAD", severity: "high", title: "Requirements contradict semantics", detail: "AC-01 conflicts.", ownerStage: "requirements", blocking: true, status: "open", recommendation: "Fix.", evidence: ["AC-01"] }];
		let escalateCalls = 0;
		let reviewCalls = 0;
		let seenOwner: string | undefined;
		const routeBackCtx: StageContext = {
			...ctx(state, [bddControl(true)], []),
			options: { escalate: async (failure) => {
				escalateCalls++;
				seenOwner = failure.routeBackOwner; // asserted AFTER (a stub throw is swallowed by the never-throw escalation)
				return { choice: "route-back" as const };
			} },
			async agent(call: AgentCall): Promise<AgentResult> {
				if (call.agent === "bdd-reviewer" || (call.id ?? "").endsWith("bddReview")) {
					reviewCalls++;
					return { text: "", control: { verdict: "Changes Requested", summary: "upstream blocker", findings: upstreamFinding } as ControlObj };
				}
				return ctx(state, [bddControl(true)], []).agent(call);
			},
		};
		const log: string[] = [];
		routeBackCtx.log = (m: string) => log.push(m);
		await expect(bddConvergenceNode.run(state, routeBackCtx)).rejects.toSatisfy(
			(err: unknown) => err instanceof Error && err.name === "RouteBackSignal",
		);
		expect(escalateCalls).toBe(1);
		// G6: the failure carried the single routable owner (RED-discriminating:
		// pre-M4 this is undefined and the intercept log below is absent).
		expect(seenOwner).toBe("requirements");
		expect(log.some((l) => l.includes("INLINE route-back") && l.includes("(user-chosen)"))).toBe(true);
		// No replan emulation side effects on the inline path.
		expect((state as Record<string, unknown>).__replan).toBeUndefined();
	});


	it("v0.3.48: a NON-ROUTABLE upstream owner (classify) is downgraded to carried advisory — no escalation, no fatal, the loop converges (run 2026-08-31T02-56 abort chain)", async () => {
		const s = setup(dir);
		mkdirSync(s.specDirectory, { recursive: true });
		writeFileSync(`${s.specDirectory}01-requirements.md`, [
			"# Requirements",
			"## Executive Summary",
			"Implement the behavior. " + "details ".repeat(40),
			"## Acceptance Criteria",
			"- AC-01: primary behavior",
			"- AC-02: edge behavior",
			"## Non-Functional Requirements",
			"Performance remains acceptable.",
		].join("\n"));
		const state: PipelineState = { setup: s, requirements: { docPath: `${s.specDirectory}01-requirements.md` } };

		const classifyFinding = [{ id: "F-CLS-001", severity: "high", title: "UI Scope=none contradicts a UI-heavy deliverable", detail: "Routing metadata mismatch.", ownerStage: "classify", blocking: true, status: "open", recommendation: "Escalate upstream.", evidence: ["uiScope"] }];
		let reviewCalls = 0;
		let escalateCalls = 0;
		const c: StageContext = {
			...ctx(state, [bddControl(true)], []),
			options: { escalate: async () => { escalateCalls++; return { choice: "accept-limitation" as const }; } },
			async agent(call: AgentCall): Promise<AgentResult> {
				if (call.agent === "bdd-reviewer" || (call.id ?? "").endsWith("bddReview")) {
					reviewCalls++;
					if (reviewCalls === 1) return { text: "", control: { verdict: "Changes Requested", summary: "metadata mismatch", findings: classifyFinding } as ControlObj };
					return { text: "", control: { verdict: "Approved", summary: "ok", findings: [] } as ControlObj };
				}
				return ctx(state, [bddControl(true)], []).agent(call);
			},
		};
		const log: string[] = [];
		c.log = (m: string) => log.push(m);
		const out = await bddConvergenceNode.run(state, c);
		expect(out.status).toBe("ok");
		expect(escalateCalls).toBe(0); // RED before v0.3.48: escalation fired → headless FatalAbort
		expect(log.join("\n")).toContain("CARRIED ADVISORY");
		expect(reviewCalls).toBe(2); // round 1 rejected (downgraded), round 2 approved → converged
	});

	it("a route-back choice with an EXHAUSTED edge degrades to the replan emulation (bounded restart)", async () => {
		const s = setup(dir);
		mkdirSync(s.specDirectory, { recursive: true });
		writeFileSync(`${s.specDirectory}01-requirements.md`, [
			"# Requirements",
			"## Executive Summary",
			"Implement the behavior. " + "details ".repeat(40),
			"## Acceptance Criteria",
			"- AC-01: primary behavior",
			"- AC-02: edge behavior",
			"## Non-Functional Requirements",
			"Performance remains acceptable.",
		].join("\n"));
		const state: PipelineState = { setup: s, requirements: { docPath: `${s.specDirectory}01-requirements.md` } };
		// Exhaust the bdd→requirements edge (budget 2).
		const { chargeRoutingJump } = await import("../src/routing/journal.ts");
		const { startRunEpoch } = await import("../src/routing/journal.ts");
		startRunEpoch();
		for (let i = 0; i < 2; i++) {
			chargeRoutingJump(s.specDirectory, { from: "bdd", to: "requirements", reason: "prior", findingIds: ["X"], resumeFromIndex: 1, invalidated: ["requirements"], at: new Date().toISOString(), cacheDropped: 0, revisionAfter: 1 });
		}
		const upstreamFinding = [{ id: "REQ-BAD", severity: "high", title: "Requirements contradict semantics", detail: "AC-01 conflicts.", ownerStage: "requirements", blocking: true, status: "open", recommendation: "Fix.", evidence: ["AC-01"] }];
		const routeBackCtx: StageContext = {
			...ctx(state, [bddControl(true)], []),
			options: { escalate: async () => ({ choice: "route-back" as const }) },
			async agent(call: AgentCall): Promise<AgentResult> {
				if (call.agent === "bdd-reviewer" || (call.id ?? "").endsWith("bddReview")) {
					return { text: "", control: { verdict: "Changes Requested", summary: "upstream blocker", findings: upstreamFinding } as ControlObj };
				}
				return ctx(state, [bddControl(true)], []).agent(call);
			},
		};
		await expect(bddConvergenceNode.run(state, routeBackCtx)).rejects.toSatisfy(
			(err: unknown) => isFatalAbort(err) && /route-back declined \(edge budget exhausted or kill-switch/.test((err as Error).message),
		);
		// M5: the emulation never ran — no marker, no persisted requests.
		expect((state as Record<string, unknown>).__replan).toBeUndefined();
		expect(existsSync(join(s.specDirectory, "replan-requests.json"))).toBe(false);
	});

	it("M4→M5: route-back choice with BOTH paths declined → honest fatal (no silent downgrade)", async () => {
		const s = setup(dir);
		mkdirSync(s.specDirectory, { recursive: true });
		writeFileSync(`${s.specDirectory}01-requirements.md`, [
			"# Requirements",
			"## Executive Summary",
			"Implement the behavior. " + "details ".repeat(40),
			"## Acceptance Criteria",
			"- AC-01: primary behavior",
			"- AC-02: edge behavior",
			"## Non-Functional Requirements",
			"Performance remains acceptable.",
		].join("\n"));
		const state: PipelineState = { setup: s, requirements: { docPath: `${s.specDirectory}01-requirements.md` } };
		// Exhaust the edge AND pre-arm the replan double-trigger guard (the
		// documented early-return that makes triggerReplanForFindings decline —
		// deterministic owner classification routes `requirements` WITHOUT the
		// replan lead, so disabling the lead alone does NOT decline it).
		const { chargeRoutingJump, startRunEpoch } = await import("../src/routing/journal.ts");
		startRunEpoch();
		for (let i = 0; i < 2; i++) {
			chargeRoutingJump(s.specDirectory, { from: "bdd", to: "requirements", reason: "prior", findingIds: ["X"], resumeFromIndex: 1, invalidated: ["requirements"], at: new Date().toISOString(), cacheDropped: 0, revisionAfter: 1 });
		}
		(state as Record<string, unknown>).__replan = { rounds: 1, owners: ["requirements"], source: "already-replanning" };
		try {
			const upstreamFinding = [{ id: "REQ-BAD", severity: "high", title: "Requirements contradict semantics", detail: "AC-01 conflicts.", ownerStage: "requirements", blocking: true, status: "open", recommendation: "Fix.", evidence: ["AC-01"] }];
			const routeBackCtx: StageContext = {
				...ctx(state, [bddControl(true)], []),
				options: { escalate: async () => ({ choice: "route-back" as const }) },
				async agent(call: AgentCall): Promise<AgentResult> {
					if (call.agent === "bdd-reviewer" || (call.id ?? "").endsWith("bddReview")) {
						return { text: "", control: { verdict: "Changes Requested", summary: "upstream blocker", findings: upstreamFinding } as ControlObj };
					}
					return ctx(state, [bddControl(true)], []).agent(call);
				},
			};
			await expect(bddConvergenceNode.run(state, routeBackCtx)).rejects.toSatisfy(
				(err: unknown) => isFatalAbort(err) && /route-back declined \(edge budget exhausted or kill-switch/.test((err as Error).message),
			);
		} finally {
			delete (state as Record<string, unknown>).__replan;
		}
	});
});

// ── M5 (v0.3.9): the interactive decision suppression is DELETED ────────────

describe("M5 — upstream-owned routing is decision-independent", () => {
	// v0.3.19: same kill-switch pin as the M4 block — these tests drive HUMAN
	// decisions (retry-with-guidance / abandon / accept-limitation), which the
	// default auto-route bypasses for the single-owner shape.
	const savedAutoKill = process.env.SUPER_DEV_NO_AUTO_ROUTEBACK;
	beforeAll(() => { process.env.SUPER_DEV_NO_AUTO_ROUTEBACK = "1"; });
	afterAll(() => {
		if (savedAutoKill === undefined) delete process.env.SUPER_DEV_NO_AUTO_ROUTEBACK;
		else process.env.SUPER_DEV_NO_AUTO_ROUTEBACK = savedAutoKill;
	});
	it("a retry-with-guidance choice on an upstream-owned blocker STILL routes (suppression deleted; guidance persisted)", async () => {
		const s = setup(dir);
		mkdirSync(s.specDirectory, { recursive: true });
		writeFileSync(`${s.specDirectory}01-requirements.md`, [
			"# Requirements",
			"## Executive Summary",
			"Implement the behavior. " + "details ".repeat(40),
			"## Acceptance Criteria",
			"- AC-01: primary behavior",
			"- AC-02: edge behavior",
			"## Non-Functional Requirements",
			"Performance remains acceptable.",
		].join("\n"));
		const state: PipelineState = { setup: s, requirements: { docPath: `${s.specDirectory}01-requirements.md` } };
		const upstreamFinding = [{ id: "REQ-M5", severity: "high", title: "Requirements contradict semantics", detail: "AC-01 conflicts.", ownerStage: "requirements", blocking: true, status: "open", recommendation: "Fix.", evidence: ["AC-01"] }];
		const log: string[] = [];
		const ctx5: StageContext = {
			...ctx(state, [bddControl(true)], []),
			options: { escalate: async () => ({ choice: "retry-with-guidance" as const, guidance: "fix AC-01 first" }) },
			async agent(call: AgentCall): Promise<AgentResult> {
				if (call.agent === "bdd-reviewer" || (call.id ?? "").endsWith("bddReview")) {
					return { text: "", control: { verdict: "Changes Requested", summary: "upstream blocker", findings: upstreamFinding } as ControlObj };
				}
				return ctx(state, [bddControl(true)], []).agent(call);
			},
		};
		ctx5.log = (m: string) => log.push(m);
		// Pre-M5 this resolved ok (a retry round — the suppression) and the loop
		// oscillated to the cap. M5: RouteBackSignal.
		await expect(bddConvergenceNode.run(state, ctx5)).rejects.toSatisfy(
			(err: unknown) => err instanceof Error && err.name === "RouteBackSignal",
		);
		expect(log.some((l) => l.includes("routing anyway; guidance persisted for the owner"))).toBe(true);
		// the guidance reached user-notes (the owner reads it at re-entry)
		const notes = JSON.parse(readFileSync(join(s.specDirectory, ".user-notes.json"), "utf8")) as { notes?: Array<{ text?: string }> };
		expect(notes.notes?.some((n) => (n.text ?? "").includes("fix AC-01 first"))).toBe(true);
		// no worktree rollback was applied (M4 contract on the routed path)
		expect((state as Record<string, unknown>).__replan).toBeUndefined();
	});

	it("abandon is respected (fatal), accept-limitation is respected (ok) — genuine human overrides", async () => {
		for (const choice of ["abandon", "accept-limitation"] as const) {
			const s = setup(dir);
			mkdirSync(s.specDirectory, { recursive: true });
			writeFileSync(`${s.specDirectory}01-requirements.md`, [
				"# Requirements",
				"## Executive Summary",
				"Implement the behavior. " + "details ".repeat(40),
				"## Acceptance Criteria",
				"- AC-01: primary behavior",
				"- AC-02: edge behavior",
				"## Non-Functional Requirements",
				"Performance remains acceptable.",
			].join("\n"));
			const state: PipelineState = { setup: s, requirements: { docPath: `${s.specDirectory}01-requirements.md` } };
			const upstreamFinding = [{ id: "REQ-M5b", severity: "high", title: "Requirements contradict semantics", detail: "AC-01 conflicts.", ownerStage: "requirements", blocking: true, status: "open", recommendation: "Fix.", evidence: ["AC-01"] }];
			const ctx5: StageContext = {
				...ctx(state, [bddControl(true)], []),
				options: { escalate: async () => ({ choice }) },
				async agent(call: AgentCall): Promise<AgentResult> {
					if (call.agent === "bdd-reviewer" || (call.id ?? "").endsWith("bddReview")) {
						return { text: "", control: { verdict: "Changes Requested", summary: "upstream blocker", findings: upstreamFinding } as ControlObj };
					}
					return ctx(state, [bddControl(true)], []).agent(call);
				},
			};
			if (choice === "abandon") {
				await expect(bddConvergenceNode.run(state, ctx5)).rejects.toSatisfy(
					(err: unknown) => isFatalAbort(err) && /user abandoned the run/.test((err as Error).message),
				);
			} else {
				const r = await bddConvergenceNode.run(state, ctx5);
				expect(r.status).toBe("ok"); // the human accepted the upstream limitation
			}
		}
	});

	it("headless + declined route-back → honest fatal naming the decline (no marker, no requests file)", async () => {
		const s = setup(dir);
		mkdirSync(s.specDirectory, { recursive: true });
		writeFileSync(`${s.specDirectory}01-requirements.md`, [
			"# Requirements",
			"## Executive Summary",
			"Implement the behavior. " + "details ".repeat(40),
			"## Acceptance Criteria",
			"- AC-01: primary behavior",
			"- AC-02: edge behavior",
			"## Non-Functional Requirements",
			"Performance remains acceptable.",
		].join("\n"));
		const state: PipelineState = { setup: s, requirements: { docPath: `${s.specDirectory}01-requirements.md` } };
		// kill-switch → planner always null → the honest M5 fatal.
		process.env.SUPER_DEV_NO_INLINE_ROUTEBACK = "1";
		try {
			const upstreamFinding = [{ id: "REQ-M5c", severity: "high", title: "Requirements contradict semantics", detail: "AC-01 conflicts.", ownerStage: "requirements", blocking: true, status: "open", recommendation: "Fix.", evidence: ["AC-01"] }];
			const ctx5: StageContext = {
				...ctx(state, [bddControl(true)], []),
				async agent(call: AgentCall): Promise<AgentResult> {
					if (call.agent === "bdd-reviewer" || (call.id ?? "").endsWith("bddReview")) {
						return { text: "", control: { verdict: "Changes Requested", summary: "upstream blocker", findings: upstreamFinding } as ControlObj };
					}
					return ctx(state, [bddControl(true)], []).agent(call);
				},
			};
			await expect(bddConvergenceNode.run(state, ctx5)).rejects.toSatisfy(
				(err: unknown) => isFatalAbort(err) && /route-back declined \(edge budget exhausted or kill-switch/.test((err as Error).message),
			);
			expect((state as Record<string, unknown>).__replan).toBeUndefined();
			expect(existsSync(join(s.specDirectory, "replan-requests.json"))).toBe(false);
		} finally {
			delete process.env.SUPER_DEV_NO_INLINE_ROUTEBACK;
		}
	});
});

// ─── v0.3.65 (incident 2026-09-04T13-45-10): agent-error rounds must never ───
// masquerade as verdicts. A dead writer/reviewer runtime (delegation failure,
// version-skew extension crash, missing model) records a G21 cause:"agent-error"
// row; the convergence loops label it honestly, tolerate up to
// AGENT_ERROR_FATAL_CONSECUTIVE-1 transient FRESH rounds, and FatalAbort with
// the infra error NAMED — never "review rejected", never spinning to the cap.
// Replayed rounds (round ≤ priorRounds) never count toward the fatal.

import { AGENT_ERROR_FATAL_CONSECUTIVE } from "../src/nodes.ts";

/** The incident's verbatim error class: pi-subagents version skew killed every
 *  child with a <250 ms extension-load crash that previously read as an empty
 *  review control → "review rejected". */
const SKEW_ERROR = 'Failed to load extension ".../pi-subagents/src/runs/shared/subagent-prompt-runtime.ts": Failed to load extension: Cannot read properties of undefined (reading \'runtimeAcknowledgements\')';

/** Per-call script entry: a string is an AGENT ERROR return (no control); a
 *  ControlObj is a normal control return. */
type PlanEntry = string | ControlObj;

function agentErrorCtx(
	state: PipelineState,
	writerControl: ControlObj,
	opts: { reviewerPlan?: PlanEntry[]; writerPlan?: PlanEntry[] } = {},
): { ctx: StageContext; logs: string[]; writerCalls: () => number; reviewCalls: () => number } {
	const logs: string[] = [];
	let writerCalls = 0;
	let reviewCalls = 0;
	let checks = 0;
	const approve: ControlObj = { verdict: "Approved", summary: "approved", findings: [] } as ControlObj;
	return {
		logs,
		writerCalls: () => writerCalls,
		reviewCalls: () => reviewCalls,
		ctx: {
			task: "implement feature",
			options: {},
			state,
			budget: { count: 0, check: () => checks++ < 400, spent() { this.count++; return true; } },
			log(message) { logs.push(message); },
			phase() {},
			events: new EventEmitter(),
			results: [],
			async agent(call: AgentCall): Promise<AgentResult> {
				if (call.agent === "judge") return { text: "", control: {} as ControlObj };
				const key = (call.id ?? "").replace(/^pipeline\./, "");
				const isReview = key === "requirementsReview";
				const plan = isReview ? opts.reviewerPlan : opts.writerPlan;
				const calls = isReview ? reviewCalls++ : writerCalls++;
				const fallback: PlanEntry = isReview ? approve : writerControl;
				const entry = plan ? plan[Math.min(calls, plan.length - 1)] : fallback;
				if (typeof entry === "string") return { text: "", control: null, error: entry };
				return { text: "", control: entry };
			},
			async helper(call: HelperCall) { return runHelper(call); },
			async parallel(calls) { return Promise.all(calls.map((call) => call())); },
		},
	};
}

describe("v0.3.65 — agent-error rounds never masquerade as verdicts (incident 2026-09-04T13-45-10)", () => {
	const savedJudge = process.env.SUPER_DEV_DISABLE_JUDGE;
	beforeEach(() => { process.env.SUPER_DEV_DISABLE_JUDGE = "1"; });
	afterEach(() => {
		if (savedJudge === undefined) delete process.env.SUPER_DEV_DISABLE_JUDGE;
		else process.env.SUPER_DEV_DISABLE_JUDGE = savedJudge;
	});

	it("3 consecutive REVIEW agent errors FatalAbort naming the infra error — never 'review rejected', never the round cap", async () => {
		const s = setup(dir);
		mkdirSync(s.specDirectory, { recursive: true });
		const state: PipelineState = { setup: s, classify: { taskType: "feature", uiScope: "none", language: "backend", isWebUi: false } };
		const harness = agentErrorCtx(state, requirementsControl([]), { reviewerPlan: [SKEW_ERROR, SKEW_ERROR, SKEW_ERROR] });
		let caught: unknown;
		try { await requirementsConvergenceNode.run(state, harness.ctx); } catch (err) { caught = err; }
		expect(isFatalAbort(caught)).toBe(true);
		const message = String((caught as Error).message);
		expect(message).toContain("review agent errored 3 consecutive");
		expect(message).toContain("infra failure, not an artifact defect");
		expect(message).toContain("runtimeAcknowledgements");
		// Bounded: exactly 3 review rounds, not 8 (cap) / 24 (extended cap).
		expect(harness.reviewCalls()).toBe(AGENT_ERROR_FATAL_CONSECUTIVE);
		expect(harness.logs.some((l) => l.includes("review agent errored round 2 (2/3 consecutive)"))).toBe(true);
		// The pre-fix masquerade — a dead reviewer logged as a VERDICT rejection — is gone.
		expect(harness.logs.some((l) => l.includes("review rejected"))).toBe(false);
	});

	it("interleaved review errors (never 3 consecutive) converge — the counter resets on every clean review round", async () => {
		const s = setup(dir);
		mkdirSync(s.specDirectory, { recursive: true });
		const state: PipelineState = { setup: s, classify: { taskType: "feature", uiScope: "none", language: "backend", isWebUi: false } };
		const harness = agentErrorCtx(state, requirementsControl([]), {
			reviewerPlan: [
				SKEW_ERROR,
				rejectingReviewControl(["AE-R1"], []),
				SKEW_ERROR,
				rejectingReviewControl(["AE-R2"], ["AE-R1"]),
				SKEW_ERROR,
				{ verdict: "Approved", summary: "approved", findings: [] } as ControlObj,
			],
		});
		const result = await requirementsConvergenceNode.run(state, harness.ctx);
		expect(result.status).toBe("ok");
		expect(result.attempts).toBe(6);
		expect(harness.reviewCalls()).toBe(6);
	});

	it("a NON-RETRYABLE review agent error aborts immediately on round 1 with the environment summary", async () => {
		const s = setup(dir);
		mkdirSync(s.specDirectory, { recursive: true });
		const state: PipelineState = { setup: s, classify: { taskType: "feature", uiScope: "none", language: "backend", isWebUi: false } };
		const harness = agentErrorCtx(state, requirementsControl([]), { reviewerPlan: ["spawn pi ENOENT"] });
		let caught: unknown;
		try { await requirementsConvergenceNode.run(state, harness.ctx); } catch (err) { caught = err; }
		expect(isFatalAbort(caught)).toBe(true);
		expect(String((caught as Error).message)).toContain("non-retryable agent environment failure");
		expect(harness.reviewCalls()).toBe(1);
	});

	it("3 consecutive WRITER agent errors FatalAbort naming the infra error — not masked as validation failures", async () => {
		const s = setup(dir);
		mkdirSync(s.specDirectory, { recursive: true });
		const state: PipelineState = { setup: s, classify: { taskType: "feature", uiScope: "none", language: "backend", isWebUi: false } };
		const harness = agentErrorCtx(state, requirementsControl([]), { writerPlan: [SKEW_ERROR, SKEW_ERROR, SKEW_ERROR] });
		let caught: unknown;
		try { await requirementsConvergenceNode.run(state, harness.ctx); } catch (err) { caught = err; }
		expect(isFatalAbort(caught)).toBe(true);
		const message = String((caught as Error).message);
		expect(message).toContain("writer agent errored 3 consecutive");
		expect(message).toContain("infra failure, not an artifact defect");
		expect(harness.writerCalls()).toBe(AGENT_ERROR_FATAL_CONSECUTIVE);
		// The pre-fix masquerade — the empty control fell to the validators.
		expect(harness.logs.some((l) => l.includes("no artifact produced"))).toBe(false);
		expect(harness.logs.some((l) => l.includes("review rejected"))).toBe(false);
	});

	it("replayed rounds (round ≤ priorRounds) never count toward the fatal — a fixed runtime recovers on resume", async () => {
		const s = setup(dir);
		mkdirSync(s.specDirectory, { recursive: true });
		// 5 recorded writer rounds ⇒ rounds 1–5 are replay-indexed; only rounds
		// 6,7,8 are FRESH error rounds and the third one fatal-aborts.
		seedStageRounds(s.specDirectory, [["pipeline.requirements", 5]]);
		const state: PipelineState = { setup: s, classify: { taskType: "feature", uiScope: "none", language: "backend", isWebUi: false } };
		const harness = agentErrorCtx(state, requirementsControl([]), { reviewerPlan: Array.from({ length: 20 }, () => SKEW_ERROR) });
		let caught: unknown;
		try { await requirementsConvergenceNode.run(state, harness.ctx); } catch (err) { caught = err; }
		expect(isFatalAbort(caught)).toBe(true);
		const message = String((caught as Error).message);
		expect(message).toContain("review agent errored 3 consecutive");
		// Rounds 1–5 replayed (not counted), 6–8 fresh: the 8th round fatals.
		expect(harness.reviewCalls()).toBe(8);
		expect(harness.logs.some((l) => l.includes("replayed — not counted"))).toBe(true);
	});
});
