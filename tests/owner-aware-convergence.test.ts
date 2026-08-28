import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requirementsConvergenceNode, judgeEscalateEvidencePresent } from "../src/stages/artifact-convergence.ts";
import { reviewBlockingVerdictFindings } from "../src/review-findings.ts";
import { carriedConvergenceFindings, getConvergenceLedger, isActionableOwnerStage, persistConvergenceLedger, priorFindingsForInjection, recordConvergenceFindings } from "../src/convergence-ledger.ts";
import { ARTIFACT_REVISIONS_FILE, pendingReplanRequests } from "../src/replan/replan.ts";
import { runHelper } from "../src/helpers.ts";
import type { AgentCall, AgentResult, Budget, ControlObj, HelperCall, PipelineState, SetupControl, StageContext } from "../src/types.ts";

// ─── v0.3.24 S1/S2 harness ───────────────────────────────────────────────────
// Run 2026-08-28T13-04-28-485Z (spec 21) deadlocked: after a v0.3.19 auto
// route-back bdd→requirements re-entry, the requirements loop was rejected for
// 6 straight rounds ONLY on bdd-owned blocking findings (owner-blind approval
// gate), including a literal "Approved" verdict at round 7, until ROUND CAP 8
// FATAL'd the run. The wait-for-graph is a cycle: the requirements loop waits
// on bdd-owned findings; the bdd stage waits for requirements to converge.
// These tests pin the owner-aware fix: a loop may only be pinned by findings
// its own stage (or an upstream route) can act on; downstream-owned findings
// are carried debt that persists in the ledger and re-injects at the owner's
// round 1 (the v0.3.3 machinery — how the debt reached requirements at all).

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

function boundedBudget(maxRounds: number): Budget {
	let calls = 0;
	return { count: 0, check: () => calls++ < maxRounds, spent() { this.count++; return true; } };
}

function makeCtx(state: PipelineState, writerControls: ControlObj[], reviewControl: ControlObj | undefined, logs: string[], maxRounds = 120): StageContext {
	let writerCalls = 0;
	return {
		task: "implement feature",
		options: {},
		state,
		budget: boundedBudget(maxRounds),
		log: (line: string) => { logs.push(String(line)); },
		phase() {},
		events: new EventEmitter(),
		results: [],
		async agent(call: AgentCall): Promise<AgentResult> {
			const key = (call.id ?? "").replace(/^pipeline\./, "");
			if (key === "requirementsReview") return { text: "", control: reviewControl ?? { verdict: "Approved", summary: "approved", findings: [] } as ControlObj };
			return { text: "", control: writerControls[Math.min(writerCalls++, writerControls.length - 1)] };
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

function bddOwnedFindings(): Array<Record<string, unknown>> {
	return [
		{
			id: "RR5-F-001",
			priorFindingId: "BDD-F-001",
			title: "03-bdd-scenarios.md is stale relative to amended AC-10",
			detail: "SCENARIO-029 is vacuously satisfiable; regenerate with >=1 undisconfirmed HypothesisTree leaf.",
			severity: "high",
			blocking: true,
			status: "open",
			ownerStage: "bdd",
		},
		{
			id: "RR5-F-002",
			priorFindingId: "BDD-F-002",
			title: "SCENARIO-036 Given contradicts amended AC-13; AC-07 write-block scenario missing",
			detail: "The read-only-role Given must be replaced and an AC-07 run-time write-block scenario added.",
			severity: "high",
			blocking: true,
			status: "open",
			ownerStage: "bdd",
		},
	];
}

function seedLedgerWithBddDebt(state: PipelineState): void {
	recordConvergenceFindings(state, bddOwnedFindings().map((f) => ({
		id: f.priorFindingId,
		ownerStage: "bdd",
		title: f.title,
		detail: f.detail,
		severity: "high",
		blocking: true,
		status: "open",
	})), { detectedAtStage: "requirementsReview", ownerStage: "requirements", sourceGate: "bdd-review" });
}

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "sd-owner-aware-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

// ─── pure helpers ─────────────────────────────────────────────────────────────

describe("S1 pure helpers", () => {
	it("isActionableOwnerStage: own/upstream/unknown owners are actionable, downstream is carried", () => {
		expect(isActionableOwnerStage("requirements", "requirements")).toBe(true);
		expect(isActionableOwnerStage("classify", "requirements")).toBe(true); // upstream
		expect(isActionableOwnerStage("environment", "requirements")).toBe(true); // environment blocks everywhere
		expect(isActionableOwnerStage(undefined, "requirements")).toBe(true); // missing owner defaults to own (no laundering)
		expect(isActionableOwnerStage("garbage-owner-label", "requirements")).toBe(true); // unknown owner → own (conservative)
		expect(isActionableOwnerStage("bdd", "requirements")).toBe(false); // downstream → carried
		expect(isActionableOwnerStage("implementation", "spec")).toBe(false); // downstream of spec → carried
	});

	it("reviewBlockingVerdictFindings lists exactly the verdict-pinning findings", () => {
		const review = {
			findings: [
				{ id: "A", blocking: true, status: "open", severity: "high" },
				{ id: "B", blocking: false, status: "open", severity: "low" },
				{ id: "C", blocking: true, status: "verified", severity: "high" },
			],
		};
		const blocking = reviewBlockingVerdictFindings(review);
		expect(blocking.map((f) => f.id)).toEqual(["A"]);
	});

	it("carriedConvergenceFindings returns only downstream-owned open blocking rows", () => {
		const state = { __convergenceLedger: undefined } as unknown as PipelineState;
		recordConvergenceFindings(state, [
			{ id: "OWN-1", ownerStage: "requirements", title: "own", blocking: true, status: "open" },
			{ id: "UP-1", ownerStage: "classify", title: "upstream", blocking: true, status: "open" },
			{ id: "DOWN-1", ownerStage: "bdd", title: "downstream", blocking: true, status: "open" },
			{ id: "DOWN-2", ownerStage: "implementation", title: "downstream advisory", blocking: false, status: "open" },
		], { detectedAtStage: "requirementsReview", ownerStage: "requirements" });
		const carried = carriedConvergenceFindings(state, "requirements");
		expect(carried.map((f) => f.id)).toEqual(["DOWN-1"]);
	});
});

describe("S4-4 judge escalate-now evidence gate accepts non-quote evidence", () => {
	it("quote evidence still works", () => {
		expect(judgeEscalateEvidencePresent([{ quote: "verbatim text" }])).toBe(true);
	});
	it("note/text/detail evidence now counts (run 13-04-28 round 6: actionable diagnosis discarded as evidence-less)", () => {
		expect(judgeEscalateEvidencePresent([{ note: "the bdd stage owns both blockers" }])).toBe(true);
		expect(judgeEscalateEvidencePresent([{ text: "diagnosis" }])).toBe(true);
		expect(judgeEscalateEvidencePresent([{ detail: "diagnosis" }])).toBe(true);
	});
	it("empty/whitespace-only evidence does not count", () => {
		expect(judgeEscalateEvidencePresent([])).toBe(false);
		expect(judgeEscalateEvidencePresent([{ quote: "   " }])).toBe(false);
		expect(judgeEscalateEvidencePresent([{ }])).toBe(false);
	});
});

// ─── node-level loop behavior ────────────────────────────────────────────────

describe("S1/S2 requirements convergence: owner-aware approval + carried exit", () => {
	it("a literal Approved verdict with only bdd-owned blocking findings converges (run 13-04-28 round-7 shape)", async () => {
		const s = setup(dir);
		mkdirSync(s.specDirectory, { recursive: true });
		const state: PipelineState = { setup: s, classify: { taskType: "feature", uiScope: "none", language: "backend", isWebUi: false } };
		seedLedgerWithBddDebt(state);
		const logs: string[] = [];
		const review: ControlObj = {
			verdict: "Approved",
			summary: "requirements side discharged; remaining work is bdd regeneration",
			findings: bddOwnedFindings(),
		};

		const result = await requirementsConvergenceNode.run(state, makeCtx(state, [requirementsControl()], review, logs));

		expect(result.status).toBe("ok");
		expect(result.attempts).toBe(1);
		// the carried debt must SURVIVE approval (not verified-flipped) so the
		// walk re-injects it at the bdd stage's round 1
		const ledgerRows = getConvergenceLedger(state).findings.filter((f) => f.ownerStage === "bdd");
		expect(ledgerRows.length).toBeGreaterThan(0);
		expect(ledgerRows.every((f) => f.status !== "verified" && f.blocking)).toBe(true);
	});

	it("a Changes-Requested verdict whose ONLY blockers are bdd-owned exits converged-carried instead of spinning to the cap", async () => {
		const s = setup(dir);
		mkdirSync(s.specDirectory, { recursive: true });
		const state: PipelineState = { setup: s, classify: { taskType: "feature", uiScope: "none", language: "backend", isWebUi: false } };
		seedLedgerWithBddDebt(state);
		const logs: string[] = [];
		const review: ControlObj = {
			verdict: "Changes Requested",
			summary: "NO requirements change — route this round to the bdd stage to regenerate 03-bdd-scenarios.md",
			findings: bddOwnedFindings(),
		};

		const result = await requirementsConvergenceNode.run(state, makeCtx(state, [requirementsControl()], review, logs));

		expect(result.status).toBe("ok");
		// exits at the FIRST all-downstream round (run 13-04-28 burned 8 rounds here)
		expect(result.attempts).toBe(1);
		expect(logs.join("\n")).toContain("CONVERGED-CARRIED");
		// debt persists unresolved for the owner stage
		const carried = getConvergenceLedger(state).findings.filter((f) => f.ownerStage === "bdd");
		expect(carried.length).toBeGreaterThan(0);
		expect(carried.every((f) => f.status !== "verified" && f.blocking)).toBe(true);
	});

	it("mixed findings: own-owned defect still rejects; once resolved, the carried bdd debt exits", async () => {
		const s = setup(dir);
		mkdirSync(s.specDirectory, { recursive: true });
		const state: PipelineState = { setup: s, classify: { taskType: "feature", uiScope: "none", language: "backend", isWebUi: false } };
		seedLedgerWithBddDebt(state);
		const logs: string[] = [];
		const round1: ControlObj = {
			verdict: "Changes Requested",
			summary: "fix AC-03",
			findings: [
				...bddOwnedFindings(),
				{ id: "RR5-F-003", title: "AC-03 presumes dead audio code", detail: "audio triggers are unreachable", severity: "high", blocking: true, status: "open" },
			],
		};
		const round2: ControlObj = {
			verdict: "Changes Requested",
			summary: "requirements fixed; bdd regeneration outstanding",
			findings: bddOwnedFindings(),
			priorFindingResolutions: [
				{ findingId: "RR5-F-003", status: "verified", note: "AC-03 rewritten without the dead audio presumption" },
			],
		};

		let reviewRound = 0;
		const ctx: StageContext = (() => {
			const base = makeCtx(state, [requirementsControl(), requirementsControl()], round1, logs);
			const origAgent = base.agent.bind(base);
			return {
				...base,
				async agent(call: AgentCall): Promise<AgentResult> {
					if ((call.id ?? "").includes("requirementsReview")) {
						reviewRound++;
						return { text: "", control: reviewRound === 1 ? round1 : round2 };
					}
					return origAgent(call);
				},
			};
		})();

		const result = await requirementsConvergenceNode.run(state, ctx);

		expect(result.status).toBe("ok");
		expect(result.attempts).toBe(2);
		expect(logs.join("\n")).toContain("CONVERGED-CARRIED");
	});

	it("an own-owned blocking finding still rejects to the honest round cap (no over-carrying)", async () => {
		const s = setup(dir);
		mkdirSync(s.specDirectory, { recursive: true });
		const state: PipelineState = { setup: s, classify: { taskType: "feature", uiScope: "none", language: "backend", isWebUi: false } };
		const logs: string[] = [];
		const review: ControlObj = {
			verdict: "Changes Requested",
			summary: "requirements defect persists",
			findings: [{ id: "RR5-F-003", title: "AC-03 presumes dead audio code", detail: "unreachable", severity: "high", blocking: true, status: "open" }],
		};

		await expect(requirementsConvergenceNode.run(state, makeCtx(state, [requirementsControl()], review, logs)))
			.rejects.toThrow(/did not converge within \d+ round/);
	});

	it("an APPROVED-WITH-REVISIONS verdict carrying an OWN-owned blocking finding still rejects (actionable blockers keep pinning)", async () => {
		const s = setup(dir);
		mkdirSync(s.specDirectory, { recursive: true });
		const state: PipelineState = { setup: s, classify: { taskType: "feature", uiScope: "none", language: "backend", isWebUi: false } };
		const logs: string[] = [];
		const review: ControlObj = {
			verdict: "APPROVED WITH REVISIONS",
			summary: "high blocker rides along",
			findings: [{ id: "RR6-F-001", title: "Un-grounded requirement", detail: "cites dead code", severity: "high", blocking: true, status: "open", ownerStage: "requirements" }],
		};

		await expect(requirementsConvergenceNode.run(state, makeCtx(state, [requirementsControl()], review, logs)))
			.rejects.toThrow(/did not converge within \d+ round/);
		expect(logs.join("\n")).not.toContain("CONVERGED-CARRIED");
	});
});

// ─── v0.3.24 review-2 P1: the carried exit must DELIVER the debt ─────────────
// The exit's contract is "the walk continues to the owner stage, where they
// re-inject at its round 1" — but the revision-gate fast-forward can skip the
// owner's round 1 entirely (journal exists + owner converged earlier + owner
// revision unchanged + no pending replan requests), and recordConvergedRevision
// on a CARRIED exit made the never-approved artifact green-skippable. The fix:
// persist the carried rows as PENDING REPLAN REQUESTS for the owner (defeats
// fast-forward condition 4 and drives the owner's round-1 injection), bump the
// owner's revision counter (defeats condition 3), and never record convergence
// for the exiting stage (defeats condition 2).

describe("carried-exit debt delivery (review-2 finding 1)", () => {
	it("the carried exit persists pending replan requests for the downstream owner and bumps its revision", async () => {
		const s = setup(dir);
		mkdirSync(s.specDirectory, { recursive: true });
		const state: PipelineState = { setup: s, classify: { taskType: "feature", uiScope: "none", language: "backend", isWebUi: false } };
		seedLedgerWithBddDebt(state);
		const logs: string[] = [];
		const review: ControlObj = { verdict: "Changes Requested", summary: "route to bdd", findings: bddOwnedFindings() };

		const result = await requirementsConvergenceNode.run(state, makeCtx(state, [requirementsControl()], review, logs));

		expect(result.status).toBe("ok");
		// (4) pending replan requests for the owner defeat the fast-forward and
		// deliver the debt at the owner's round 1 (the v0.3.3 seam).
		const pending = pendingReplanRequests(s.specDirectory, "bdd");
		expect(pending.length).toBeGreaterThan(0);
		// (3) the owner's revision counter is bumped — its earlier convergence
		// record (if any) is stale, so the owner re-runs and re-validates.
		const revisions = JSON.parse(readFileSync(join(s.specDirectory, ARTIFACT_REVISIONS_FILE), "utf8")) as Record<string, number>;
		expect((revisions.bdd ?? 0)).toBeGreaterThan(0);
		// (2) the EXITING stage was never approved — no converged revision may be
		// recorded for it (a later sub-walk must not green-skip requirements).
		expect(revisions.requirements).toBeUndefined();
		expect(((state as PipelineState & { __convergedRevisions?: Record<string, unknown> }).__convergedRevisions ?? {}).requirements).toBeUndefined();
	});

	it("priorFindingsForInjection returns ALL unresolved rows — the 8-row cap cannot launder restart residue", async () => {
		const s = setup(dir);
		mkdirSync(s.specDirectory, { recursive: true });
		writeFileSync(join(s.specDirectory, ".task"), "task anchor for residue", "utf8");
		const state: PipelineState = { setup: s, classify: { taskType: "feature", uiScope: "none", language: "backend", isWebUi: false } };
		recordConvergenceFindings(state, Array.from({ length: 10 }, (_, i) => ({
			id: `RES-${i}`,
			ownerStage: "requirements",
			title: `residue ${i}`,
			detail: "unresolved blocking row from a prior run",
			severity: "high",
			blocking: true,
			status: "open",
		})), { detectedAtStage: "requirementsReview", ownerStage: "requirements", sourceGate: "prior" });
		persistConvergenceLedger(state);

		const prior = priorFindingsForInjection(s.specDirectory);
		expect(prior.findings.length).toBe(10);
		expect(prior.omitted).toBe(0);
	});
});
