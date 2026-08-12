/**
 * Upstream review+fix convergence loop (shift-left Fagan inspection).
 *
 * These tests exercise `artifactConvergenceNode`'s NEW optional review layer and
 * its HITL stall escalation, using the requirements convergence node as the
 * representative case (bdd/design share the same code path). The writer + reviewer
 * agents and the deterministic validator are faked so only the loop's control
 * flow is under test — no real agents, no disk writes.
 *
 * Covered:
 *  - approved verdict + no blocking findings ⇒ converge in one round.
 *  - non-approved verdict ⇒ re-run the writer with review feedback, then converge
 *    once the reviewer approves.
 *  - a blocking finding that RECURS unchanged ⇒ STALL ⇒ escalate to the user;
 *    an `accept-limitation` decision converges the loop.
 *  - no escalate callback wired ⇒ the loop keeps looping (never blocks), and a
 *    later approval still converges (additive baseline).
 */
import { describe, it, expect, vi } from "vitest";
import type { AgentCall, AgentResult, ControlObj, PipelineState, StageContext, Escalate } from "../types.ts";
import { requirementsConvergenceNode, designConvergenceNode } from "./artifact-convergence.ts";

// The reviewer's control object lands under state.requirementsReview via the
// task() wrapper (state[stage.id] = result). The deterministic validator
// (requirementsComplete) reads state.requirements + a gate helper; we stub the
// helper to always pass so the loop reaches the review step every round.

interface Script {
	/** Per-round reviewer control objects (verdict + findings). */
	reviews: Array<ControlObj>;
	logs: string[];
	writerRounds: number;
	/** Optional per-round EXTRA fields merged into the writer's control object
	 *  (e.g. reviewResponses). Index = writerRounds-1, clamped to the last entry. */
	writerExtras?: Array<Record<string, unknown>>;
}

function makeState(): PipelineState {
	return {
		task: "add feature X",
		options: {} as never,
		setup: {
			worktreePath: "/tmp/wt",
			specDirectory: "/tmp/spec",
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

function makeCtx(script: Script, escalate?: Escalate, opts?: { maxRounds?: number }): StageContext {
	const maxRounds = opts?.maxRounds ?? 60;
	let rounds = 0;
	return {
		task: "add feature X",
		options: { escalate },
		state: {} as PipelineState,
		budget: { check: () => rounds++ < maxRounds, spent: () => true, count: 0 },
		log: (m: string) => script.logs.push(m),
		phase: () => {},
		events: { on() {}, off() {}, emit() {} },
		results: [],
		signal: undefined,
		async agent(call: AgentCall): Promise<AgentResult> {
			if (call.id === "pipeline.requirements") {
				script.writerRounds++;
				// A valid requirements control: no open questions so the deterministic
				// validator passes. docPath present so the reviewer prompt is grounded.
				const extras = script.writerExtras ? script.writerExtras[Math.min(script.writerRounds - 1, script.writerExtras.length - 1)] : undefined;
				return { text: "", control: { docPath: "/tmp/spec/01-requirements.md", openQuestions: [], acceptanceCriteria: [{ id: "AC-01" }, { id: "AC-02" }], ...extras } as ControlObj };
			}
			if (call.id === "pipeline.requirementsReview") {
				const idx = Math.min(script.writerRounds - 1, script.reviews.length - 1);
				return { text: "", control: script.reviews[idx] };
			}
			return { text: "", control: {} as ControlObj };
		},
		async helper() {
			// gate-requirements always passes (deterministic validation is not under test).
			return { value: { pass: true, errors: [] } as ControlObj, digest: "PASS" };
		},
		async parallel() {
			return [];
		},
	} as unknown as StageContext;
}

const approved: ControlObj = { verdict: "Approved", summary: "clean", findings: [] } as ControlObj;
const changesRequested = (id: string): ControlObj => ({
	verdict: "Changes Requested",
	summary: "gaps",
	findings: [{ id, severity: "high", title: `blocking ${id}`, detail: `detail ${id}`, blocking: true, ownerStage: "requirements", status: "open" }],
} as ControlObj);
/** Verdict names a revision but carries ONLY a non-blocking low suggestion —
 *  the reviewer contract says this is a PASS ("suggestion 放行"). */
const approvedWithRevisions: ControlObj = {
	verdict: "Approved with Revisions",
	summary: "minor nit only",
	findings: [{ id: "S1", severity: "low", title: "rename for clarity", detail: "cosmetic", blocking: false, ownerStage: "requirements", status: "open" }],
} as ControlObj;

const hasLog = (logs: string[], needle: string) => logs.some((l) => l.includes(needle));

describe("artifactConvergenceNode — upstream review layer", () => {
	it("approved verdict + no blocking findings ⇒ converges in one round", async () => {
		const script: Script = { reviews: [approved], logs: [], writerRounds: 0 };
		const ctx = makeCtx(script);
		const result = await requirementsConvergenceNode.run(makeState(), ctx);
		expect(result.status).toBe("ok");
		expect(script.writerRounds).toBe(1);
		expect(hasLog(script.logs, "review approved")).toBe(true);
	});

	it("non-approved verdict ⇒ re-runs writer, converges once the reviewer approves", async () => {
		const script: Script = { reviews: [changesRequested("F1"), approved], logs: [], writerRounds: 0 };
		const ctx = makeCtx(script);
		const result = await requirementsConvergenceNode.run(makeState(), ctx);
		expect(result.status).toBe("ok");
		expect(script.writerRounds).toBe(2); // rejected once, then approved
		expect(hasLog(script.logs, "review rejected")).toBe(true);
	});

	it("recurring blocking finding ⇒ STALL ⇒ escalates; accept-limitation converges", async () => {
		// Same finding id/title/detail every round ⇒ identical fingerprint ⇒ stall.
		const script: Script = { reviews: [changesRequested("F1"), changesRequested("F1"), changesRequested("F1")], logs: [], writerRounds: 0 };
		const escalate = vi.fn<Escalate>().mockResolvedValue({ choice: "accept-limitation" });
		const ctx = makeCtx(script, escalate);
		const result = await requirementsConvergenceNode.run(makeState(), ctx);
		expect(result.status).toBe("ok");
		expect(escalate).toHaveBeenCalledTimes(1);
		expect(escalate.mock.calls[0]![0].kind).toBe("stagnation");
		expect(hasLog(script.logs, "STALL detected")).toBe(true);
		expect(hasLog(script.logs, "accepted the limitation")).toBe(true);
	});

	it("no escalate wired ⇒ never blocks; a later approval still converges", async () => {
		const script: Script = { reviews: [changesRequested("F1"), changesRequested("F1"), approved], logs: [], writerRounds: 0 };
		const ctx = makeCtx(script);
		const result = await requirementsConvergenceNode.run(makeState(), ctx);
		expect(result.status).toBe("ok");
		expect(script.writerRounds).toBe(3);
	});

	// Regression (review-finding #2): "APPROVED WITH REVISIONS" carrying ONLY a
	// non-blocking suggestion must PASS. The strict isApprovedVerdict rejected any
	// verdict containing "revision", so a suggestion-only review span to budget
	// exhaustion. reviewVerdictApproves now honors the reviewer contract.
	it("verdict 'Approved with Revisions' + only a non-blocking suggestion ⇒ converges (suggestion 放行)", async () => {
		const script: Script = { reviews: [approvedWithRevisions], logs: [], writerRounds: 0 };
		const ctx = makeCtx(script);
		const result = await requirementsConvergenceNode.run(makeState(), ctx);
		expect(result.status).toBe("ok");
		expect(script.writerRounds).toBe(1);
		expect(hasLog(script.logs, "review approved")).toBe(true);
	});

	// Regression (review-finding #3): the writer's reviewResponses must be applied
	// to the convergence ledger so an addressed prior finding stops being injected
	// as an active blocker. Round 1 rejects with F1; round 2 the writer responds
	// {findingId:F1,status:addressed} AND the reviewer approves. Convergence must
	// occur without F1 lingering as a blocker.
	it("writer reviewResponses mark a prior finding addressed in the ledger", async () => {
		const script: Script = {
			reviews: [changesRequested("F1"), approved],
			logs: [],
			writerRounds: 0,
			writerExtras: [{}, { reviewResponses: [{ findingId: "F1", status: "addressed", response: "clarified AC-01", ownerStage: "requirements" }] }],
		};
		const ctx = makeCtx(script);
		const result = await requirementsConvergenceNode.run(makeState(), ctx);
		expect(result.status).toBe("ok");
		expect(hasLog(script.logs, "writer response matrix addressed 1 prior finding")).toBe(true);
	});
});

// --- design-specific: skip vs failure (review-finding #1) -------------------
// designStage returns null both when it is intentionally skipped (bug fix) AND
// when a selected designer times out. designConvergenceNode must distinguish
// them by CLASSIFICATION: taskType==="bug" ⇒ skip+converge; otherwise a null
// design is a FAILURE ⇒ retry, never a silent bypass of the design review gate.
function makeDesignCtx(opts: { taskType: string; designerReturnsNull: boolean; reviews: ControlObj[]; logs: string[]; maxRounds?: number }): StageContext {
	let rounds = 0;
	let designRounds = 0;
	return {
		task: "t",
		options: {},
		state: {} as PipelineState,
		budget: { check: () => rounds++ < (opts.maxRounds ?? 40), spent: () => true, count: 0 },
		log: (m: string) => opts.logs.push(m),
		phase: () => {},
		events: { on() {}, off() {}, emit() {} },
		results: [],
		signal: undefined,
		async agent(call: AgentCall): Promise<AgentResult> {
			if (call.id === "pipeline.design") {
				designRounds++;
				if (opts.designerReturnsNull) return { text: "", control: null, error: "timeout" };
				return { text: "", control: { docPath: "/tmp/spec/06-design.md", modules: [{ name: "M", description: "d" }] } as ControlObj };
			}
			if (call.id === "pipeline.designReview") {
				const idx = Math.min(designRounds - 1, opts.reviews.length - 1);
				return { text: "", control: opts.reviews[idx] };
			}
			return { text: "", control: {} as ControlObj };
		},
		async helper(call: { name: string }) {
			// route-designer: a bug fix returns NO designer (skip); otherwise a designer.
			if (call.name === "route-designer") {
				return opts.taskType === "bug"
					? { value: { designerAgent: null, reason: "Bug fixes do not redesign" } as ControlObj, digest: "" }
					: { value: { designerAgent: "architecture-designer", reason: "feature" } as ControlObj, digest: "" };
			}
			return { value: { pass: true, errors: [] } as ControlObj, digest: "PASS" };
		},
		async parallel() {
			return [];
		},
	} as unknown as StageContext;
}

function designState(taskType: string): PipelineState {
	return {
		task: "t",
		options: {} as never,
		setup: { worktreePath: "/tmp/wt", specDirectory: "/tmp/spec", defaultBranch: "main", language: "backend", isWebUi: false, specIdentifier: "01", worktreeCreated: false, initializedRepo: false },
		classify: { taskType, uiScope: "none", language: "backend", isWebUi: false },
	} as unknown as PipelineState;
}

describe("designConvergenceNode — skip vs designer-failure (review-finding #1)", () => {
	it("bug fix ⇒ intentional skip ⇒ converges WITHOUT running design review", async () => {
		const logs: string[] = [];
		const ctx = makeDesignCtx({ taskType: "bug", designerReturnsNull: false, reviews: [approved], logs });
		const result = await designConvergenceNode.run(designState("bug"), ctx);
		expect(result.status).toBe("ok");
		expect(hasLog(logs, "skipped (no artifact produced)")).toBe(true);
		expect(hasLog(logs, "review approved")).toBe(false); // review never ran
	});

	it("feature + designer returns null (timeout) ⇒ NOT a skip ⇒ retries, does not bypass the gate", async () => {
		const logs: string[] = [];
		// designer times out the first round, succeeds the second, then review approves.
		let call = 0;
		const ctx = {
			task: "t",
			options: {},
			state: {} as PipelineState,
			budget: { check: (() => { let r = 0; return () => r++ < 40; })(), spent: () => true, count: 0 },
			log: (m: string) => logs.push(m),
			phase: () => {},
			events: { on() {}, off() {}, emit() {} },
			results: [],
			signal: undefined,
			async agent(c: AgentCall): Promise<AgentResult> {
				if (c.id === "pipeline.design") {
					call++;
					if (call === 1) return { text: "", control: null, error: "timeout" };
					return { text: "", control: { docPath: "/tmp/spec/06-design.md", modules: [{ name: "M", description: "d" }] } as ControlObj };
				}
				if (c.id === "pipeline.designReview") return { text: "", control: approved };
				return { text: "", control: {} as ControlObj };
			},
			async helper(c: { name: string }) {
				if (c.name === "route-designer") return { value: { designerAgent: "architecture-designer", reason: "feature" } as ControlObj, digest: "" };
				return { value: { pass: true, errors: [] } as ControlObj, digest: "PASS" };
			},
			async parallel() { return []; },
		} as unknown as StageContext;
		const result = await designConvergenceNode.run(designState("feature"), ctx);
		expect(result.status).toBe("ok");
		// The timeout round is a FAILURE (retried), NOT a silent skip.
		expect(hasLog(logs, "no artifact produced")).toBe(true);
		expect(hasLog(logs, "skipped (no artifact produced)")).toBe(false);
		expect(hasLog(logs, "review approved")).toBe(true); // gate DID run after the retry
		expect(call).toBe(2); // designer re-ran
	});
});
