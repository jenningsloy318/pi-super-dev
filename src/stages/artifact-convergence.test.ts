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
import { requirementsConvergenceNode } from "./artifact-convergence.ts";

// The reviewer's control object lands under state.requirementsReview via the
// task() wrapper (state[stage.id] = result). The deterministic validator
// (requirementsComplete) reads state.requirements + a gate helper; we stub the
// helper to always pass so the loop reaches the review step every round.

interface Script {
	/** Per-round reviewer control objects (verdict + findings). */
	reviews: Array<ControlObj>;
	logs: string[];
	writerRounds: number;
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
				return { text: "", control: { docPath: "/tmp/spec/01-requirements.md", openQuestions: [], acceptanceCriteria: [{ id: "AC-01" }, { id: "AC-02" }] } as ControlObj };
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
});
