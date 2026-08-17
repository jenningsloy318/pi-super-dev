/**
 * R3/R4/R5 (dsh-09 v3 Phase R): the bounded cross-stage replan circuit.
 *
 * - maybeTriggerReplan: routable residue -> replan-requests.json + artifact
 *   revision bump + resume-cache invalidation for owner ∪ downstreamOf(owner)
 *   + __replan marker + audit/ledger events. Non-routable residue, exhausted
 *   budget, and duplicate pending requests all fall through (no restart).
 * - Round-1 injection: an owning convergence node consumes its pending
 *   requests as convergence findings; approval flips them to addressed.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { maybeTriggerReplan, pendingReplanRequests, pendingHumanReplanRequests, consumeReplanRequests, invalidateResumeCache, REPLAN_REQUESTS_FILE, ARTIFACT_REVISIONS_FILE, maxReplanRounds } from "../src/replan/replan.ts";
import { requirementsConvergenceNode } from "../src/stages/artifact-convergence.ts";
import { getConvergenceLedger } from "../src/convergence-ledger.ts";
import { getRetryFeedback } from "../src/retry-feedback.ts";
import type { AgentCall, AgentResult, ControlObj, PipelineState, StageContext } from "../src/types.ts";

function specDir(): string {
	const d = mkdtempSync(join(tmpdir(), "sd-replan-"));
	return d;
}

function stateWith(dir: string, deferred: Array<Record<string, unknown>>): PipelineState {
	return {
		task: "t",
		options: {},
		setup: { worktreePath: dir, specDirectory: dir, defaultBranch: "main", language: "backend", isWebUi: false, specIdentifier: "03-staging", worktreeCreated: false, initializedRepo: false },
		review: { verdict: "Changes Requested", findings: [], deferredFindings: deferred },
	} as unknown as PipelineState;
}

function ctxWith(agent?: StageContext["agent"]): { ctx: StageContext; logs: string[] } {
	const logs: string[] = [];
	return {
		logs,
		ctx: {
			task: "t", options: {}, state: {} as PipelineState,
			budget: { check: () => true, spent: () => true, count: 0 },
			log: (m: string) => logs.push(m),
			phase: () => {},
			events: { on() {}, off() {}, emit() {} },
			results: [],
			signal: undefined,
			async agent(call: AgentCall): Promise<AgentResult> {
				if (agent) return agent(call);
				// Residue lead fallback: human (no confident route) — used by the
				// non-routable tests.
				return { text: "", control: { owner: "human", confidence: 0.9, reason: "product call", evidence: [{ file: "finding", quote: "some text from the finding" }] } as ControlObj };
			},
			async helper() { return { value: { pass: true, errors: [] } as ControlObj, digest: "PASS" }; },
			async parallel() { return []; },
		} as unknown as StageContext,
	};
}

const RESUME_ROWS = [
	'{"key":"pipeline.requirements@root#1","result":{"text":"","control":{}}}',
	'{"key":"pipeline.spec@root#1","result":{"text":"","control":{}}}',
	'{"key":"pipeline.implementation.phase-01.impl.a1@root#1","result":{"text":"","control":{}}}',
	'{"key":"pipeline.verify.code-review@root#1","result":{"text":"","control":{}}}',
	'{"key":"pipeline.docs@root#1","result":{"text":"","control":{}}}',
	// H4 (AC-04/SCENARIO-010): debug/assessment/prototype rows must drop for
	// owners whose downstream set covers them (requirements, design).
	'{"key":"pipeline.debug@root#1","result":{"text":"","control":{}}}',
	'{"key":"pipeline.assessment@root#1","result":{"text":"","control":{}}}',
	'{"key":"pipeline.prototype.r01@root#1","result":{"text":"","control":{}}}',
].join("\n") + "\n";

describe("R3/R4/R5 — maybeTriggerReplan", () => {
	beforeEach(() => { delete process.env.SUPER_DEV_MAX_REPLAN_ROUNDS; });
	afterEach(() => { delete process.env.SUPER_DEV_MAX_REPLAN_ROUNDS; });

	it("routes a spec-owned residue finding: requests file + revision bump + cache invalidation + marker", async () => {
		const d = specDir();
		try {
			writeFileSync(join(d, ".resume-cache.jsonl"), RESUME_ROWS);
			const state = stateWith(d, [{
				id: "AR-03-03", severity: "medium", status: "needs-human", blocking: false,
				title: "Resumable NeedsYou has no resume protocol",
				detail: "the resume contract is undefined for interrupted runs",
				file: "docs/specifications/03-staging-agent-pipeline.md",
			}]);
			const { ctx, logs } = ctxWith();
			const triggered = await maybeTriggerReplan(state, ctx, "03-staging");
			expect(triggered).toBe(true);

			const marker = (state as Record<string, unknown>).__replan as { rounds: number; owners: string[]; invalidationSet: string[] };
			expect(marker.rounds).toBe(1);
			expect(marker.owners).toEqual(["spec"]);
			expect(marker.invalidationSet).toContain("spec");
			expect(marker.invalidationSet).toContain("implementation");
			expect(marker.invalidationSet).toContain("verify");
			expect(marker.invalidationSet).not.toContain("requirements"); // upstream stays replayable

			const requests = JSON.parse(readFileSync(join(d, REPLAN_REQUESTS_FILE), "utf8"));
			expect(requests.rounds).toBe(1);
			expect(requests.requests).toHaveLength(1);
			expect(requests.requests[0].ownerStage).toBe("spec");
			expect(requests.requests[0].status).toBe("pending");
			expect(requests.requests[0].classificationSource).toBe("doc-path");

			const revisions = JSON.parse(readFileSync(join(d, ARTIFACT_REVISIONS_FILE), "utf8"));
			expect(revisions.spec).toBe(1);
			expect(revisions.requirements).toBeUndefined();

			// R4: spec + downstream rows dropped; requirements + the pre-spec
			// debug/assessment/prototype rows survive (spec's downstream set does
			// not cover them — SCENARIO-010's owner=spec counterpart).
			const cache = readFileSync(join(d, ".resume-cache.jsonl"), "utf8").trim().split("\n");
			expect(cache).toHaveLength(4);
			expect(cache[0]).toContain("pipeline.requirements@");
			expect(cache.some((l) => l.includes("pipeline.debug@"))).toBe(true);
			expect(cache.some((l) => l.includes("pipeline.assessment@"))).toBe(true);
			expect(cache.some((l) => l.includes("pipeline.prototype."))).toBe(true);

			expect(existsSync(join(d, ".replan.jsonl"))).toBe(true);
			expect(existsSync(join(d, "events.jsonl"))).toBe(true);
			expect(logs.join("\n")).toContain("REPLAN round 1");
		} finally { rmSync(d, { recursive: true, force: true }); }
	});

	it("non-routable residue falls through (no files, no marker)", async () => {
		const d = specDir();
		try {
			const state = stateWith(d, [{ id: "X1", severity: "low", title: "naming is inconsistent", detail: "cosmetic" }]);
			const { ctx } = ctxWith();
			expect(await maybeTriggerReplan(state, ctx, "run")).toBe(false);
			expect((state as Record<string, unknown>).__replan).toBeUndefined();
			expect(existsSync(join(d, REPLAN_REQUESTS_FILE))).toBe(false);
		} finally { rmSync(d, { recursive: true, force: true }); }
	});

	it("R5 budget: an exhausted rounds counter refuses the restart", async () => {
		const d = specDir();
		try {
			writeFileSync(join(d, REPLAN_REQUESTS_FILE), JSON.stringify({ version: 1, rounds: maxReplanRounds(), requests: [] }));
			const state = stateWith(d, [{
				id: "AR-03-03", severity: "medium", title: "Resumable NeedsYou has no resume protocol",
				file: "docs/specifications/03-staging-agent-pipeline.md",
			}]);
			const { ctx, logs } = ctxWith();
			expect(await maybeTriggerReplan(state, ctx, "run")).toBe(false);
			expect((state as Record<string, unknown>).__replan).toBeUndefined();
			expect(logs.join("\n")).toContain("replan budget exhausted");
		} finally { rmSync(d, { recursive: true, force: true }); }
	});

	it("a finding that is already pending does not trigger a duplicate round", async () => {
		const d = specDir();
		try {
			writeFileSync(join(d, REPLAN_REQUESTS_FILE), JSON.stringify({
				version: 1, rounds: 1,
				requests: [{ id: "AR-03-03", title: "Resumable NeedsYou has no resume protocol", detail: "", severity: "medium", ownerStage: "spec", classificationSource: "doc-path", classificationReason: "r", requestedRevision: "r", fingerprint: "docs/specifications/03-staging-agent-pipeline.md|medium|resumable needsyou has no resume protocol", status: "pending", createdAt: "t" }],
			}));
			const state = stateWith(d, [{
				id: "AR-03-03", severity: "medium", title: "Resumable NeedsYou has no resume protocol",
				file: "docs/specifications/03-staging-agent-pipeline.md",
			}]);
			const { ctx } = ctxWith();
			expect(await maybeTriggerReplan(state, ctx, "run")).toBe(false);
			const requests = JSON.parse(readFileSync(join(d, REPLAN_REQUESTS_FILE), "utf8"));
			expect(requests.rounds).toBe(1); // unchanged
		} finally { rmSync(d, { recursive: true, force: true }); }
	});

	it("invalidateResumeCache keeps unparseable rows (never destroys what it cannot read)", () => {
		const d = specDir();
		try {
			writeFileSync(join(d, ".resume-cache.jsonl"), "garbage-not-json\n" + RESUME_ROWS);
			const dropped = invalidateResumeCache(d, ["spec"]);
			expect(dropped).toBe(1);
			const cache = readFileSync(join(d, ".resume-cache.jsonl"), "utf8").trim().split("\n");
			expect(cache.some((l) => l.includes("garbage-not-json"))).toBe(true);
		} finally { rmSync(d, { recursive: true, force: true }); }
	});

	// ── AC-04 (SCENARIO-010): a replan whose invalidation set covers the
	// debug/assessment/prototype stages drops their seeded rows. owner=requirements
	// covers all three (debug/assessment sit between requirements and spec);
	// owner=design covers prototype (design→prototype→spec) — debug/assessment
	// are UPSTREAM of design and stay replayable per the R4 contract
	// (invalidation = owner ∪ downstreamOf(owner); upstream stays replayable).
	it("AC-04 (SCENARIO-010): owner=requirements replan drops the seeded prototype/debug/assessment rows (whole suffix)", async () => {
		const d = specDir();
		try {
			writeFileSync(join(d, ".resume-cache.jsonl"), RESUME_ROWS);
			const state = stateWith(d, [{
				id: "AR-req-1", severity: "high",
				title: "Acceptance criteria contradict each other",
				detail: "the artifact is internally inconsistent",
				ownerStage: "requirements",
			}]);
			const { ctx } = ctxWith();
			expect(await maybeTriggerReplan(state, ctx, "run")).toBe(true);
			const cache = readFileSync(join(d, ".resume-cache.jsonl"), "utf8").trim().split("\n").filter(Boolean);
			expect(cache.some((l) => l.includes("pipeline.debug@"))).toBe(false);
			expect(cache.some((l) => l.includes("pipeline.assessment@"))).toBe(false);
			expect(cache.some((l) => l.includes("pipeline.prototype."))).toBe(false);
			expect(cache).toHaveLength(0); // requirements invalidates everything downstream
		} finally { rmSync(d, { recursive: true, force: true }); }
	});

	it("AC-04 (SCENARIO-010): owner=design replan drops the seeded prototype row; upstream debug/assessment stay replayable", async () => {
		const d = specDir();
		try {
			writeFileSync(join(d, ".resume-cache.jsonl"), RESUME_ROWS);
			const state = stateWith(d, [{
				id: "AR-des-1", severity: "high",
				title: "Token budget carrying is a design tradeoff",
				detail: "unbounded context re-injection",
				ownerStage: "design",
			}]);
			const { ctx } = ctxWith();
			expect(await maybeTriggerReplan(state, ctx, "run")).toBe(true);
			const cache = readFileSync(join(d, ".resume-cache.jsonl"), "utf8").trim().split("\n").filter(Boolean);
			expect(cache.some((l) => l.includes("pipeline.prototype."))).toBe(false); // design→prototype→spec …
			expect(cache.some((l) => l.includes("pipeline.debug@"))).toBe(true); // upstream of design — replayable
			expect(cache.some((l) => l.includes("pipeline.assessment@"))).toBe(true); // upstream of design — replayable
			expect(cache.some((l) => l.includes("pipeline.requirements@"))).toBe(true);
		} finally { rmSync(d, { recursive: true, force: true }); }
	});

	// ── AC-05 (SCENARIO-011/012): judge + replan-lead resume rows are
	// invalidated on EVERY replan trigger — unconditionally unioned into the
	// prefix set (never short-circuits to 0, even with no owning-stage rows).
	const JUDGE_REPLAN_ROWS = [
		'{"key":"pipeline.judge.spec@root#1","result":{"text":"","control":{}}}',
		'{"key":"pipeline.replan.lead@root#1","result":{"text":"","control":{}}}',
	].join("\n") + "\n";

	it("AC-05 (SCENARIO-011): every replan trigger drops the judge and replan-lead rows (count ≥ 2)", async () => {
		const d = specDir();
		try {
			writeFileSync(join(d, ".resume-cache.jsonl"), RESUME_ROWS + JUDGE_REPLAN_ROWS);
			const state = stateWith(d, [{
				id: "AR-03-03", severity: "medium", title: "Resumable NeedsYou has no resume protocol",
				file: "docs/specifications/03-staging-agent-pipeline.md",
			}]);
			const { ctx } = ctxWith();
			expect(await maybeTriggerReplan(state, ctx, "run")).toBe(true);
			const cache = readFileSync(join(d, ".resume-cache.jsonl"), "utf8");
			expect(cache.includes("pipeline.judge.")).toBe(false);
			expect(cache.includes("pipeline.replan.")).toBe(false);
		} finally { rmSync(d, { recursive: true, force: true }); }
	});

	it("AC-05 (SCENARIO-012): judge/replan invalidation is unconditional even with no owning-stage rows (empty stage list included)", () => {
		const d = specDir();
		try {
			writeFileSync(join(d, ".resume-cache.jsonl"), JUDGE_REPLAN_ROWS);
			// no rows match the owner's stage prefixes — the union still drops both
			expect(invalidateResumeCache(d, ["requirements"])).toBe(2);
			expect(readFileSync(join(d, ".resume-cache.jsonl"), "utf8").trim()).toBe("");
			// and even a degenerate empty stage list never short-circuits to 0
			writeFileSync(join(d, ".resume-cache.jsonl"), JUDGE_REPLAN_ROWS);
			expect(invalidateResumeCache(d, [])).toBe(2);
			expect(readFileSync(join(d, ".resume-cache.jsonl"), "utf8").trim()).toBe("");
		} finally { rmSync(d, { recursive: true, force: true }); }
	});

	// ── B6 (adv-B fix-in-pass): an invalidation that drops 0 rows while matching
	// rows exist is a failure — no __replan; the HITL path runs instead.
	it("B6: invalidation dropping 0 while matching rows exist aborts the replan (no __replan, HITL instead)", async () => {
		const d = specDir();
		try {
			writeFileSync(join(d, ".resume-cache.jsonl"), RESUME_ROWS);
			// make the rewrite fail: the file is unreadable-for-write (root-run
		// caveat aside, chmod 0444 makes writeFileSync throw EACCES) so
			// invalidateResumeCache reads + counts but cannot rewrite → returns 0
			chmodSync(join(d, ".resume-cache.jsonl"), 0o444);
			const state = stateWith(d, [{
				id: "AR-03-03", severity: "medium", title: "Resumable NeedsYou has no resume protocol",
				file: "docs/specifications/03-staging-agent-pipeline.md",
			}]);
			const { ctx, logs } = ctxWith();
			expect(await maybeTriggerReplan(state, ctx, "run")).toBe(false);
			expect((state as Record<string, unknown>).__replan).toBeUndefined(); // no replan marker — HITL instead
			const audit = readFileSync(join(d, ".replan.jsonl"), "utf8");
			expect(audit).toContain("invalidation-failed");
			expect(logs.join("\n")).toContain("invalidation dropped 0 rows while matching rows exist");
		} finally { rmSync(d, { recursive: true, force: true }); }
	});

	// ── T3.4b (code-B/B6 fix-in-pass): a regression of an ALREADY-ADDRESSED
	// finding re-routes (a new request row) instead of falling through to HITL —
	// the fingerprint dedupe does not suppress on an addressed-before-this-run
	// request.
	it("T3.4b: a finding fingerprint matching an addressed-before-this-run request still triggers the replan", async () => {
		const d = specDir();
		try {
			const finding = {
				id: "AR-03-03", severity: "medium",
				title: "Resumable NeedsYou has no resume protocol",
				file: "docs/specifications/03-staging-agent-pipeline.md",
			};
			const fp = `${String(finding.file)}|${String(finding.severity)}|${String(finding.title)}`.toLowerCase().replace(/\s+/g, " ");
			writeFileSync(join(d, REPLAN_REQUESTS_FILE), JSON.stringify({
				version: 1, rounds: 1,
				requests: [{
					id: "AR-03-03", title: finding.title, detail: "", severity: "medium", ownerStage: "spec",
					classificationSource: "doc-path", classificationReason: "r", requestedRevision: "r",
					fingerprint: fp, status: "addressed", addressedAt: "2020-01-01T00:00:00.000Z", createdAt: "2019-01-01T00:00:00.000Z",
				}],
			}));
			// the current run started AFTER the request was addressed (no events
			// ledger in this fixture ⇒ every addressed request predates the run)
			const state = stateWith(d, [finding]);
			const { ctx } = ctxWith();
			expect(await maybeTriggerReplan(state, ctx, "run-2")).toBe(true);
			const requests = JSON.parse(readFileSync(join(d, REPLAN_REQUESTS_FILE), "utf8"));
			expect(requests.rounds).toBe(2); // a NEW replan round fired
			expect(requests.requests).toHaveLength(2); // the regression minted a fresh pending row
			expect(requests.requests.filter((r: { status: string }) => r.status === "pending")).toHaveLength(1);
		} finally { rmSync(d, { recursive: true, force: true }); }
	});

	// ── M10 (AC-20 / SCENARIO-043/044): every deferred finding NOT routed
	// persists machine-readably as an ownerStage:"human" pending row — never
	// consumed by any stage, never part of the invalidation owners set.
	it("AC-20 (SCENARIO-043): 2 routable + 3 needs-human ⇒ 2 stage rows + 3 human rows; human rows never consumed", async () => {
		const d = specDir();
		try {
			const state = stateWith(d, [
				// 2 routable (spec doc-path citations)
				{ id: "R-1", severity: "medium", title: "Contract one is undefined", file: "docs/specifications/03-a-specification.md" },
				{ id: "R-2", severity: "medium", title: "Contract two is undefined", file: "docs/specifications/03-b-specification.md" },
				// 3 needs-human (fixer-domain ownerStage → deterministic human)
				{ id: "H-1", severity: "high", title: "Regression in dispatcher", detail: "behavior change", ownerStage: "implementation" },
				{ id: "H-2", severity: "high", title: "Flaky retry test", detail: "behavior change", ownerStage: "verification" },
				{ id: "H-3", severity: "high", title: "Missing toolchain", detail: "environment", ownerStage: "environment" },
			]);
			const { ctx } = ctxWith();
			expect(await maybeTriggerReplan(state, ctx, "run")).toBe(true);

			const requests = JSON.parse(readFileSync(join(d, REPLAN_REQUESTS_FILE), "utf8"));
			expect(requests.requests).toHaveLength(5); // 2 stage rows + 3 human rows
			const stageRows = requests.requests.filter((r: { ownerStage: string }) => r.ownerStage === "spec");
			const humanRows = requests.requests.filter((r: { ownerStage: string }) => r.ownerStage === "human");
			expect(stageRows).toHaveLength(2);
			expect(humanRows).toHaveLength(3);
			for (const r of humanRows) {
				expect(r.status).toBe("pending");
				expect(r.requestedRevision).toContain("Human decision required");
			}
			// human rows are structurally excluded from consumption + invalidation
			const marker = (state as Record<string, unknown>).__replan as { owners: string[] };
			expect(marker.owners).toEqual(["spec"]);
			expect(consumeReplanRequests(d, "human")).toBe(0);
			expect(pendingHumanReplanRequests(d)).toHaveLength(3);
			expect(pendingHumanReplanRequests(d)[0]!.status).toBe("pending");
			expect(pendingReplanRequests(d, "spec")).toHaveLength(2);
		} finally { rmSync(d, { recursive: true, force: true }); }
	});
});

describe("R3 — convergence-node consumption", () => {
	it("injects pending requests at round 1 and flips them to addressed on approval", async () => {
		const d = specDir();
		try {
			writeFileSync(join(d, REPLAN_REQUESTS_FILE), JSON.stringify({
				version: 1, rounds: 1,
				requests: [{
					id: "AR-01", title: "Acceptance criteria contradict", detail: "AC-02 vs AC-07", severity: "high",
					ownerStage: "requirements", classificationSource: "file-class", classificationReason: "r",
					requestedRevision: "Revise the requirements artifact to resolve: Acceptance criteria contradict. AC-02 vs AC-07",
					fingerprint: "fp1", status: "pending", createdAt: "t",
				}],
			}));
			const logs: string[] = [];
			let writerRounds = 0;
			// realAgent (workflow.ts) prepends the stored retry feedback to every
			// writer prompt; the fake ctx.agent bypasses it, so capture the feedback
			// realAgent would have rendered at the moment the writer is called.
			const capturedFeedback: string[] = [];
			const ctx = {
				task: "t", options: {}, state: {} as PipelineState,
				budget: { check: () => writerRounds < 10, spent: () => true, count: 0 },
				log: (m: string) => logs.push(m),
				phase: () => {},
				events: { on() {}, off() {}, emit() {} },
				results: [],
				signal: undefined,
				async agent(call: AgentCall): Promise<AgentResult> {
					if (call.id === "pipeline.requirements") {
						writerRounds++;
						const fb = getRetryFeedback(state as Record<string, unknown>, "requirements") ?? [];
						for (const item of fb) {
							if (typeof item === "string") { capturedFeedback.push(item); continue; }
							const o = item as { missing?: unknown[]; nextAction?: unknown };
							capturedFeedback.push(...(Array.isArray(o.missing) ? o.missing.map(String) : []), String(o.nextAction ?? ""));
						}
						return { text: "", control: { docPath: "/tmp/x.md", openQuestions: [], acceptanceCriteria: [{ id: "AC-01" }] } as ControlObj };
					}
					if (call.id === "pipeline.requirementsReview") {
						return { text: "", control: { verdict: "Approved", summary: "revised", findings: [] } as ControlObj };
					}
					return { text: "", control: {} as ControlObj };
				},
				async helper() { return { value: { pass: true, errors: [] } as ControlObj, digest: "PASS" }; },
				async parallel() { return []; },
			} as unknown as StageContext;
			const state = {
				task: "t", options: {},
				setup: { worktreePath: d, specDirectory: d, defaultBranch: "main", language: "backend", isWebUi: false, specIdentifier: "01", worktreeCreated: false, initializedRepo: false },
			} as unknown as PipelineState;

			const result = await requirementsConvergenceNode.run(state, ctx);
			expect(result.status).toBe("ok");
			// The writer's round-1 retry feedback (what realAgent renders into its
			// prompt) carried the revision request.
			expect(capturedFeedback.join("\n")).toContain("replan request AR-01");
			expect(logs.join("\n")).toContain("1 replan request(s) injected at round 1");
			// Approval verified the revision -> the request flips to addressed.
			const requests = JSON.parse(readFileSync(join(d, REPLAN_REQUESTS_FILE), "utf8"));
			expect(requests.requests[0].status).toBe("addressed");
			expect(requests.requests[0].addressedAt).toBeTruthy();
			expect(pendingReplanRequests(d, "requirements")).toHaveLength(0);
		} finally { rmSync(d, { recursive: true, force: true }); }
	});

	it("consumeReplanRequests is a no-op without the file / for other stages", () => {
		const d = specDir();
		try {
			expect(consumeReplanRequests(d, "spec")).toBe(0);
			expect(consumeReplanRequests(undefined, "spec")).toBe(0);
			mkdirSync(d, { recursive: true });
			expect(pendingReplanRequests(d, "requirements")).toHaveLength(0);
		} finally { rmSync(d, { recursive: true, force: true }); }
	});

	// ── AC-18 (SCENARIO-039/040, M8 pin flip): a DUTY-OVERRIDE approval is not a
	// reviewer approval — it may converge the loop but must NOT consume the
	// pending replan request nor flip replan-detected findings to verified. Only
	// a GENUINE reviewer approval (reviewVerdictApproves) consumes (the
	// genuine-approval counterpart is pinned by the test above).
	it("AC-18 (SCENARIO-039): duty-override approval does NOT consume a pending replan request", async () => {
		const d = specDir();
		try {
			writeFileSync(join(d, REPLAN_REQUESTS_FILE), JSON.stringify({
				version: 1, rounds: 1,
				requests: [{
					id: "AR-02", title: "Acceptance criteria contradict", detail: "AC-02 vs AC-07", severity: "high",
					ownerStage: "requirements", classificationSource: "file-class", classificationReason: "r",
					requestedRevision: "Revise the requirements artifact to resolve the contradiction.",
					fingerprint: "fp2", status: "pending", createdAt: "t",
				}],
			}));
			const logs: string[] = [];
			let reviewCalls = 0;
			// Round 3 review: "Changes Requested" whose ONLY blocking finding is a NEW
			// unrelated medium finding the convergence duty downgrades — the loop
			// converges via the duty override, NOT a genuine reviewer approval.
			const mediumNew = (id: string) => ({ id, severity: "medium", title: `Polish ${id}`, detail: "Advisory-level nit.", blocking: true, ownerStage: "requirements", status: "open" });
			const reviews = [
				{ verdict: "Changes Requested", summary: "gaps", findings: [mediumNew("M-1")] },
				{ verdict: "Changes Requested", summary: "gaps", findings: [mediumNew("M-2")] },
				{ verdict: "Changes Requested", summary: "gaps", findings: [mediumNew("M-3")] },
			];
			const ctx = {
				task: "t", options: {}, state: {} as PipelineState,
				budget: { check: () => true, spent: () => true, count: 0 },
				log: (m: string) => logs.push(m),
				phase: () => {},
				events: { on() {}, off() {}, emit() {} },
				results: [], signal: undefined,
				async agent(call: AgentCall): Promise<AgentResult> {
					if (call.id === "pipeline.requirements") {
						return { text: "", control: { docPath: "/tmp/x.md", openQuestions: [], acceptanceCriteria: [{ id: "AC-01" }] } as ControlObj };
					}
					if (call.id === "pipeline.requirementsReview") {
						return { text: "", control: reviews[Math.min(reviewCalls++, reviews.length - 1)] as ControlObj };
					}
					return { text: "", control: {} as ControlObj };
				},
				async helper() { return { value: { pass: true, errors: [] } as ControlObj, digest: "PASS" }; },
				async parallel() { return []; },
			} as unknown as StageContext;
			const state = {
				task: "t", options: {},
				setup: { worktreePath: d, specDirectory: d, defaultBranch: "main", language: "backend", isWebUi: false, specIdentifier: "01", worktreeCreated: false, initializedRepo: false },
			} as unknown as PipelineState;

			const result = await requirementsConvergenceNode.run(state, ctx);
			expect(result.status).toBe("ok");
			expect(logs.join("\n")).toContain("convergence duty enforced"); // the duty override path ran
			// the request must STILL be pending — no consumption without a genuine approval
			const requests = JSON.parse(readFileSync(join(d, REPLAN_REQUESTS_FILE), "utf8"));
			expect(requests.requests[0].status).toBe("pending");
			expect(requests.requests[0].addressedAt).toBeUndefined();
			expect(pendingReplanRequests(d, "requirements")).toHaveLength(1);
			// a replan-detected finding is NOT flipped to verified by the override
			const replanFinding = getConvergenceLedger(state).findings.find((f) => f.id === "replan-AR-02");
			expect(replanFinding).toBeDefined();
			expect(replanFinding?.status).not.toBe("verified");
		} finally { rmSync(d, { recursive: true, force: true }); }
	});
});
