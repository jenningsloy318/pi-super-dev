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
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readdirSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentCall, AgentResult, ControlObj, PipelineState, StageContext, Escalate } from "../types.ts";
import { requirementsConvergenceNode, designConvergenceNode, bddConvergenceNode, MAX_CONVERGENCE_ROUNDS } from "./artifact-convergence.ts";
import { RouteBackSignal } from "../routing/router.ts";

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
				// v0.3.32: also RENDER-VALID (title/date/…/statement) — a rejected render
				// now fails the round (stale-doc hole closed), so a render-invalid
				// fixture can no longer stand in for a converged writer.
				const extras = script.writerExtras ? script.writerExtras[Math.min(script.writerRounds - 1, script.writerExtras.length - 1)] : undefined;
				return { text: "", control: { docPath: "/tmp/spec/01-requirements.md", title: "R", date: "2026-08-30", type: "feature", priority: "high", executiveSummary: "s", openQuestions: [], nonFunctional: [], acceptanceCriteria: [{ id: "AC-01", statement: "s1" }, { id: "AC-02", statement: "s2" }], ...extras } as ControlObj };
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
/** A blocking finding owned by an UPSTREAM stage (classify) that the requirements
 *  writer structurally cannot fix — e.g. a scope/routing mismatch. */
const upstreamOwned = (id: string): ControlObj => ({
	verdict: "Changes Requested",
	summary: "scope mismatch",
	findings: [{ id, severity: "high", title: `scope mismatch ${id}`, detail: `UI Scope=none but task needs UI ${id}`, blocking: true, ownerStage: "classify", status: "open" }],
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

	it("v0.3.48: upstream-owned (classify) blocking finding ⇒ downgraded to CARRIED ADVISORY (classify is not routable mid-run), the loop converges — run 2026-08-31T02-56 abort chain", async () => {
		// OLD contract (pre-v0.3.48): escalate IMMEDIATELY — but classify is NOT in
		// REPLAN_OWNER_STAGES, so planInlineRouteBack can never route it and a
		// headless escalation aborts the whole run (the 2026-08-31T02-56 incident:
		// uiScope=none fallback metadata → owner=classify → "route-back declined"
		// → fatal). The routable-owner escalation contract lives in
		// tests/artifact-convergence.test.ts (route-back tests). Here: the finding
		// the artifact cannot fix becomes loud carried debt, never a fatal.
		const script: Script = { reviews: [upstreamOwned("REQ-SCOPE"), approved], logs: [], writerRounds: 0 };
		const escalate = vi.fn<Escalate>().mockResolvedValue({ choice: "accept-limitation" });
		const ctx = makeCtx(script, escalate);
		const result = await requirementsConvergenceNode.run(makeState(), ctx);
		expect(result.status).toBe("ok");
		expect(escalate).toHaveBeenCalledTimes(0); // RED pre-fix: 1 (headless → FatalAbort chain)
		expect(script.writerRounds).toBe(2); // round 1 rejected (finding downgraded), round 2 approved
		expect(hasLog(script.logs, "CARRIED ADVISORY")).toBe(true);
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

// --- liveness: hard round cap (convergence-loop-unbounded-cap-fix) ---------
// A stochastic reviewer that NEVER approves (and never stalls — a fresh finding
// each round) must be GUARANTEED to stop at the MAX_CONVERGENCE_ROUNDS cap, not
// loop until the global budget exhausts (the pre-cap OOM root cause). The cap
// FatalAborts like the budget-exhaustion path and must NOT escalate (so it does
// not consume the stall path's shared stagnation budget).
describe("artifactConvergenceNode — liveness round cap", () => {
	it("a node that never converges FatalAborts at MAX_CONVERGENCE_ROUNDS (never loops forever)", async () => {
		const rejectEvery = (n: number): ControlObj => ({
			verdict: "Changes Requested",
			summary: "no",
			findings: [{ id: `F${n}`, severity: "high", title: `gap ${n}`, detail: `d${n}`, blocking: true, ownerStage: "requirements", status: "open" }],
		} as ControlObj);
		// Fresh finding id each round ⇒ distinct fingerprint ⇒ no stall, no escalation.
		const reviews = Array.from({ length: 20 }, (_, i) => rejectEvery(i + 1));
		const script: Script = { reviews, logs: [], writerRounds: 0 };
		const ctx = makeCtx(script); // no escalate wired
		await expect(requirementsConvergenceNode.run(makeState(), ctx)).rejects.toThrow(
			new RegExp(`did not converge within ${MAX_CONVERGENCE_ROUNDS} round\\(s\\)`),
		);
		expect(script.writerRounds).toBe(MAX_CONVERGENCE_ROUNDS); // ran N full rounds, aborted at the start of round N+1
		expect(hasLog(script.logs, "ROUND CAP")).toBe(true);
	});
});

// --- design-specific: skip vs failure (review-finding #1) -------------------
// designStage returns null both when it is intentionally skipped (bug fix) AND
// when a selected designer times out. designConvergenceNode must distinguish
// them by CLASSIFICATION: taskType==="bug" ⇒ skip+converge; otherwise a null
// design is a FAILURE ⇒ retry, never a silent bypass of the design review gate.
// design is a FAILURE ⇒ retry, never a silent bypass of the design review gate.
// These use a REAL temp spec dir so renderAndWrite actually validates + writes
// the NN-design.md (Fix A: a control that fails schema/render writes no doc and
// must NOT pass the gate).
const VALID_DESIGN = { title: "D", date: "2026-08-12", summary: "s", designer: "architecture-designer", modules: [{ name: "M", description: "d" }], hasNumericConstants: "no" };

function designState(taskType: string, specDir: string, worktree: string): PipelineState {
	return {
		task: "t",
		options: {} as never,
		setup: { worktreePath: worktree, specDirectory: specDir, defaultBranch: "main", language: "backend", isWebUi: false, specIdentifier: "01", worktreeCreated: false, initializedRepo: false },
		classify: { taskType, uiScope: "none", language: "backend", isWebUi: false },
	} as unknown as PipelineState;
}

/** designControls: per-round `pipeline.design` control (null = timeout). */
function makeDesignCtx(opts: { designControls: Array<Record<string, unknown> | null>; reviews: ControlObj[]; logs: string[]; taskType?: string; maxRounds?: number; escalate?: Escalate }): StageContext {
	let rounds = 0;
	let designRounds = 0;
	let reviewRounds = 0;
	return {
		task: "t",
		options: { escalate: opts.escalate },
		state: {} as PipelineState,
		budget: { check: () => rounds++ < (opts.maxRounds ?? 40), spent: () => true, count: 0 },
		log: (m: string) => opts.logs.push(m),
		phase: () => {},
		events: { on() {}, off() {}, emit() {} },
		results: [],
		signal: undefined,
		async agent(call: AgentCall): Promise<AgentResult> {
			if (call.id === "pipeline.design") {
				const ctrl = opts.designControls[Math.min(designRounds, opts.designControls.length - 1)];
				designRounds++;
				return ctrl == null ? { text: "", control: null, error: "timeout" } : { text: "", control: ctrl as ControlObj };
			}
			if (call.id === "pipeline.designReview") {
				const ctrl = opts.reviews[Math.min(reviewRounds, opts.reviews.length - 1)];
				reviewRounds++;
				return { text: "", control: ctrl };
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

describe("designConvergenceNode — skip vs designer-failure (review-finding #1)", () => {
	let specDir = "";
	let worktree = "";
	beforeEach(() => {
		worktree = mkdtempSync(join(tmpdir(), "sd-dwt-"));
		specDir = mkdtempSync(join(tmpdir(), "sd-dspec-")) + "/";
	});
	afterEach(() => {
		for (const d of [specDir, worktree]) if (d && existsSync(d)) rmSync(d, { recursive: true, force: true });
		specDir = worktree = "";
	});

	it("bug fix ⇒ intentional skip ⇒ converges WITHOUT running design review", async () => {
		const logs: string[] = [];
		const ctx = makeDesignCtx({ taskType: "bug", designControls: [VALID_DESIGN], reviews: [approved], logs });
		const result = await designConvergenceNode.run(designState("bug", specDir, worktree), ctx);
		expect(result.status).toBe("ok");
		expect(hasLog(logs, "skipped (no artifact produced)")).toBe(true);
		expect(hasLog(logs, "review approved")).toBe(false); // review never ran
	});

	it("feature + designer returns null (timeout) ⇒ NOT a skip ⇒ retries, does not bypass the gate", async () => {
		const logs: string[] = [];
		// timeout round 1, valid design round 2, then review approves.
		const ctx = makeDesignCtx({ taskType: "feature", designControls: [null, { ...VALID_DESIGN }], reviews: [approved], logs });
		const result = await designConvergenceNode.run(designState("feature", specDir, worktree), ctx);
		expect(result.status).toBe("ok");
		expect(hasLog(logs, "no artifact produced")).toBe(true);
		expect(hasLog(logs, "skipped (no artifact produced)")).toBe(false);
		expect(hasLog(logs, "review approved")).toBe(true); // gate DID run after the retry
	});

	// Fix A (review-finding: renderAndWrite null ignored): an INCOMPLETE control
	// passes result.control != null but FAILS schema/render, so NO NN-design.md is
	// written. This must be a failure→retry, NOT a silent gate bypass.
	it("feature + control that fails schema/render (no design doc) ⇒ retries, does not approve on a phantom design", async () => {
		const logs: string[] = [];
		// round 1: control present but missing required fields (modules/designer) →
		// renderAndWrite returns null, no doc written. round 2: valid → doc written.
		const incomplete = { title: "only a title" };
		const ctx = makeDesignCtx({ taskType: "feature", designControls: [incomplete, { ...VALID_DESIGN }], reviews: [approved], logs });
		const result = await designConvergenceNode.run(designState("feature", specDir, worktree), ctx);
		expect(result.status).toBe("ok");
		// The incomplete round wrote NO doc and was retried, not approved.
		expect(hasLog(logs, "failed schema/render")).toBe(true);
		// Exactly one design doc exists on disk (from the valid round).
		expect(readdirSync(specDir).filter((f) => /-design\.md$/.test(f)).length).toBe(1);
	});

	// v0.3.32 (runs 2026-08-30T00-10-34-032Z aborted / 03-23-40-576Z 8 wasted
	// rounds): the empty-artifact branch told the retrying designer only "no
	// artifact (empty/failed output)" while the exact schema errors sat in the
	// run log. The designer mutated unrelated content every round and the judge
	// escalated on a guess. The recorded render errors must now reach BOTH the
	// round-failure log line AND the retry feedback block the next prompt embeds.
	it("schema/render rejection feeds the EXACT field errors into the round log and retry feedback, not just 'no artifact'", async () => {
		const logs: string[] = [];
		const incomplete = { title: "only a title" }; // missing required keys → render fails
		const state = designState("feature", specDir, worktree);
		// The SAME failing control every round: never converges, so the feedback
		// survives the abort (a converged loop clears it) and can be inspected.
		const ctx = makeDesignCtx({ taskType: "feature", designControls: [incomplete], reviews: [approved], logs });
		await expect(designConvergenceNode.run(state, ctx)).rejects.toThrow(/did not converge/);
		// Round-1 failure line names the schema error (located, actionable).
		expect(logs.some((l) => l.includes("no artifact produced round 1") && l.includes("must have required properties"))).toBe(true);
		// The retry feedback (workflow.ts realAgent prepends state.__feedback["design"]
		// to the next designer prompt) carries the exact errors too.
		const fb = (state as unknown as { __feedback?: Record<string, unknown> }).__feedback?.["design"];
		expect(JSON.stringify(fb)).toContain("must have required properties");
		// The recorded slot is consumed each round — it never leaks verbatim.
		expect((state as Record<string, unknown>).__renderErrors).toBeUndefined();
	});

	// v0.3.32 prose-drift companion: a control whose ONLY defect is
	// alternativesConsidered[].alternatives as one prose string previously failed
	// render → retried forever. It must now RENDER and converge round 1.
	it("design control with alternatives-as-prose-string renders and converges (no retry)", async () => {
		const logs: string[] = [];
		const drifted = { ...VALID_DESIGN, alternativesConsidered: [{ decision: "d", chosen: "c", rationale: "r", alternatives: "(a) other — rejected: slower" }] };
		const state = designState("feature", specDir, worktree);
		const ctx = makeDesignCtx({ taskType: "feature", designControls: [drifted], reviews: [approved], logs });
		const result = await designConvergenceNode.run(state, ctx);
		expect(result.status).toBe("ok");
		expect(hasLog(logs, "no artifact produced")).toBe(false);
		expect(hasLog(logs, "review approved")).toBe(true);
		expect(readdirSync(specDir).filter((f) => /-design\.md$/.test(f)).length).toBe(1);
	});
});

// --- v0.3.19: AUTO-ROUTE upstream-owned blockers (no HITL wait) -------------
// Run 2026-08-27T00-59-52 (17-stock-analysis-angles): the BDD review surfaced
// BDD-F-001 owner=requirements with a crisp, unambiguous recommendation; the
// loop escalated to HITL only for the user to click "route back" — a full
// human round-trip confirming a decision the blocker analysis had already
// made. Now: exactly ONE routable strictly-upstream owner + per-edge jump
// budget ⇒ RouteBackSignal DIRECTLY (escalation report records the
// machine-taken route-back-auto decision for audit). Ambiguous shapes
// (multi-owner, non-routable, budget-exhausted) and SUPER_DEV_NO_AUTO_ROUTEBACK=1
// keep the HITL prompt byte-identically.
describe("artifactConvergenceNode — AUTO-ROUTE upstream-owned blockers (v0.3.19)", () => {
	const savedKill = process.env.SUPER_DEV_NO_AUTO_ROUTEBACK;
	afterEach(() => {
		if (savedKill === undefined) delete process.env.SUPER_DEV_NO_AUTO_ROUTEBACK;
		else process.env.SUPER_DEV_NO_AUTO_ROUTEBACK = savedKill;
	});

	/** The incident shape: a BDD review blocking finding owned by requirements
	 *  (requirements strictly precedes bdd in STAGE_IDS). */
	const ownedByRequirements = (id: string): ControlObj => ({
		verdict: "Changes Requested",
		summary: "upstream ambiguity",
		findings: [{ id, severity: "high", title: `AC-04(b) required-ness undecided`, detail: `detail ${id}`, blocking: true, ownerStage: "requirements", status: "open" }],
	} as ControlObj);

	function bddState(specDir: string): PipelineState {
		return {
			task: "t",
			options: {} as never,
			setup: { worktreePath: "/tmp/wt", specDirectory: specDir, defaultBranch: "main", language: "backend", isWebUi: false, specIdentifier: "01", worktreeCreated: false, initializedRepo: false },
			classify: { taskType: "feature", uiScope: "none", language: "backend", isWebUi: false },
		} as unknown as PipelineState;
	}

	function makeBddCtx(logs: string[], reviews: ControlObj[], escalate?: Escalate): StageContext {
		let rounds = 0;
		let reviewRounds = 0;
		return {
			task: "t",
			options: { escalate },
			state: {} as PipelineState,
			budget: { check: () => rounds++ < 40, spent: () => true, count: 0 },
			log: (m: string) => logs.push(m),
			phase: () => {},
			events: { on() {}, off() {}, emit() {} },
			results: [],
			signal: undefined,
			async agent(call: AgentCall): Promise<AgentResult> {
				if (call.id === "pipeline.bddReview") {
					const ctrl = reviews[Math.min(reviewRounds, reviews.length - 1)];
					reviewRounds++;
					return { text: "", control: ctrl };
				}
				// v0.3.32: render-valid bdd control (see makeCtx note) — a rejected
				// render now fails the round instead of converging on a stale doc.
				return { text: "", control: { docPath: "/tmp/spec/03-bdd.md", title: "B", date: "2026-08-30", source: "./01-requirements.md", features: [{ name: "f", scenarios: [{ id: "001", title: "t", acRef: "AC-01", priority: "high", given: "g", when: "w", then: "then" }] }] } as ControlObj };
			},
			async helper() {
				return { value: { pass: true, errors: [] } as ControlObj, digest: "PASS" };
			},
			async parallel() {
				return [];
			},
		} as unknown as StageContext;
	}

	it("T1 (the incident): single routable upstream owner ⇒ RouteBackSignal WITHOUT the HITL wait", async () => {
		const specDir = mkdtempSync(join(tmpdir(), "sd-autorb-")) + "/";
		const logs: string[] = [];
		// Sentinel: had the code consulted HITL, "abandon" would FatalAbort —
		// both assertions below fail together if the wait is back.
		const escalate = vi.fn<Escalate>().mockResolvedValue({ choice: "abandon" });
		try {
			await expect(bddConvergenceNode.run(bddState(specDir), makeBddCtx(logs, [ownedByRequirements("BDD-F-001")], escalate))).rejects.toThrow(RouteBackSignal);
			expect(escalate).not.toHaveBeenCalled();
			expect(hasLog(logs, "AUTO-ROUTE bdd→requirements")).toBe(true);
			expect(hasLog(logs, "escalating to user (HITL)")).toBe(false);
		} finally { rmSync(specDir, { recursive: true, force: true }); }
	});

	it("T2: the escalation report records the machine-taken route-back-auto decision (audit)", async () => {
		const specDir = mkdtempSync(join(tmpdir(), "sd-autorb2-")) + "/";
		const logs: string[] = [];
		try {
			await expect(bddConvergenceNode.run(bddState(specDir), makeBddCtx(logs, [ownedByRequirements("BDD-F-001")]))).rejects.toThrow(RouteBackSignal);
			const report = readFileSync(join(specDir, "escalation-report.md"), "utf8");
			expect(report).toContain("route-back-auto");
			expect(report).toContain("routed without HITL");
			expect(report).toContain("BDD-F-001");
		} finally { rmSync(specDir, { recursive: true, force: true }); }
	});

	it("T3 (kill-switch): SUPER_DEV_NO_AUTO_ROUTEBACK=1 restores the HITL round-trip", async () => {
		process.env.SUPER_DEV_NO_AUTO_ROUTEBACK = "1";
		const specDir = mkdtempSync(join(tmpdir(), "sd-autorb3-")) + "/";
		const logs: string[] = [];
		const escalate = vi.fn<Escalate>().mockResolvedValue({ choice: "route-back" });
		try {
			await expect(bddConvergenceNode.run(bddState(specDir), makeBddCtx(logs, [ownedByRequirements("BDD-F-001")], escalate))).rejects.toThrow(RouteBackSignal);
			expect(escalate).toHaveBeenCalledTimes(1);
			expect(hasLog(logs, "escalating to user (HITL)")).toBe(true);
			expect(hasLog(logs, "(user-chosen)")).toBe(true);
			expect(hasLog(logs, "AUTO-ROUTE")).toBe(false);
		} finally { rmSync(specDir, { recursive: true, force: true }); }
	});

	it("T4: multi-owner blockers keep HITL (no single unambiguous owner to trust)", async () => {
		const worktree = mkdtempSync(join(tmpdir(), "sd-autorb4-"));
		const specDir = mkdtempSync(join(tmpdir(), "sd-autorb4s-")) + "/";
		const logs: string[] = [];
		// requirements AND research both routable + strictly upstream of design →
		// planInlineRouteBack declines (owners.size 2) → HITL fires as before.
		const multiOwner: ControlObj = {
			verdict: "Changes Requested",
			summary: "two upstream owners",
			findings: [
				{ id: "D1", severity: "high", title: "gap one", detail: "d1", blocking: true, ownerStage: "requirements", status: "open" },
				{ id: "D2", severity: "high", title: "gap two", detail: "d2", blocking: true, ownerStage: "research", status: "open" },
			],
		} as ControlObj;
		const escalate = vi.fn<Escalate>().mockResolvedValue({ choice: "accept-limitation" });
		try {
			const ctx = makeDesignCtx({ taskType: "feature", designControls: [VALID_DESIGN], reviews: [multiOwner], logs, escalate });
			const result = await designConvergenceNode.run(designState("feature", specDir, worktree), ctx);
			expect(result.status).toBe("ok"); // accept-limitation converged the loop
			expect(escalate).toHaveBeenCalledTimes(1);
			expect(hasLog(logs, "AUTO-ROUTE")).toBe(false);
			expect(hasLog(logs, "escalating to user (HITL)")).toBe(true);
		} finally {
			rmSync(specDir, { recursive: true, force: true });
			rmSync(worktree, { recursive: true, force: true });
		}
	});
});
