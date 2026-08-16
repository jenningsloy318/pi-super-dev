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
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { maybeTriggerReplan, pendingReplanRequests, consumeReplanRequests, invalidateResumeCache, REPLAN_REQUESTS_FILE, ARTIFACT_REVISIONS_FILE, maxReplanRounds } from "../src/replan/replan.ts";
import { requirementsConvergenceNode } from "../src/stages/artifact-convergence.ts";
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

			// R4: spec + downstream rows dropped; requirements survives.
			const cache = readFileSync(join(d, ".resume-cache.jsonl"), "utf8").trim().split("\n");
			expect(cache).toHaveLength(1);
			expect(cache[0]).toContain("pipeline.requirements@");

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
});
