/**
 * R2 (dsh-09 v3 Phase R): owner classification for replan routing.
 *
 * Layer 1 (pure rules): each rule, positive and negative. Layer 2 (replan-
 * lead): mocked agent — routed / low-confidence / bad-evidence / failed / env-
 * disabled. Closed-set enforcement and never-throws invariants throughout.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { classifyReplanOwnerDeterministic, REPLAN_OWNER_STAGES } from "../src/replan/owners.ts";
import { classifyReplanOwner, parseLeadControl, verifyLeadEvidence, findingTextBlob } from "../src/replan/lead.ts";
import type { ReplanRequest } from "../src/replan/replan.ts";
import type { StageContext } from "../src/types.ts";

// ── D4 (AC-20 / T3.5) type pins: `ReplanRequest.ownerStage` is WIDENED to
// `ReplanOwnerStage | "human"` (deferred findings persist as human-owned rows)
// while `REPLAN_OWNER_STAGES` — the routing closed set — is UNTOUCHED ("human"
// is not a routable consumer).
describe("D4 type pins — ReplanRequest.ownerStage widened, routing set closed", () => {
	it('a ReplanRequest may carry ownerStage: "human" (compile-time + runtime shape)', () => {
		const row: ReplanRequest = {
			id: "H-1", title: "deferred finding", detail: "", severity: "high",
			ownerStage: "human",
			classificationSource: "keyword", classificationReason: "fixer domain",
			requestedRevision: "Human decision required: deferred finding",
			fingerprint: "fp", status: "pending", createdAt: "2026-08-17T00:00:00.000Z",
		};
		expect(row.ownerStage).toBe("human");
		expect(row.status).toBe("pending");
	});

	it('REPLAN_OWNER_STAGES stays the closed five-stage routing set (never gains "human")', () => {
		expect([...REPLAN_OWNER_STAGES]).toEqual(["requirements", "bdd", "research", "design", "spec"]);
		expect((REPLAN_OWNER_STAGES as readonly string[]).includes("human")).toBe(false);
	});
});

describe("R2 layer 1 — deterministic owner classification", () => {
	// Rule 1: reviewer ownerStage is authoritative.
	it("routes on an explicit artifact ownerStage", () => {
		for (const stage of REPLAN_OWNER_STAGES) {
			const d = classifyReplanOwnerDeterministic({ ownerStage: stage, title: "anything" });
			expect(d?.owner, stage).toBe(stage);
			expect(d?.routable).toBe(true);
			expect(d?.source).toBe("reviewer-ownerStage");
		}
	});
	it("never replans a fixer-domain ownerStage", () => {
		for (const stage of ["implementation", "verification", "environment"]) {
			const d = classifyReplanOwnerDeterministic({ ownerStage: stage, title: "x" });
			expect(d?.owner).toBe("human");
			expect(d?.routable).toBe(false);
		}
	});

	// Rule 2: specification doc citation → spec (the AR-03-03 shape).
	it("routes a specification-doc citation to spec", () => {
		const d = classifyReplanOwnerDeterministic({ file: "docs/specifications/03-staging-agent-pipeline.md", title: "Resumable NeedsYou has no resume protocol" });
		expect(d?.owner).toBe("spec");
		expect(d?.source).toBe("doc-path");
	});

	// Rule 3: rendered artifact classes (NN-<slug>.md, real STAGE_MODELS slugs).
	it("routes rendered artifact document classes", () => {
		expect(classifyReplanOwnerDeterministic({ file: "docs/specifications/01-x/02-requirements.md" })?.owner).toBe("requirements");
		expect(classifyReplanOwnerDeterministic({ file: "docs/requirements/01-interface-contracts.md" })?.owner).toBe("requirements");
		expect(classifyReplanOwnerDeterministic({ file: "docs/specifications/01-x/03-bdd-scenarios.md" })?.owner).toBe("bdd");
		expect(classifyReplanOwnerDeterministic({ file: "docs/specifications/01-x/04-research-report.md" })?.owner).toBe("research");
		expect(classifyReplanOwnerDeterministic({ file: "docs/specifications/01-x/05-design.md" })?.owner).toBe("design");
	});

	// Rule 4: keyword classes — the no-file shapes from run 2026-08-16T01-00-35.
	it("keyword: undefined protocol/contract → spec (AR-03-03 shape)", () => {
		const d = classifyReplanOwnerDeterministic({ title: "Resumable NeedsYou has no resume protocol defined", detail: "the contract for resuming is undefined" });
		expect(d?.owner).toBe("spec");
		expect(d?.source).toBe("keyword");
	});
	it("keyword: unbounded re-injection → design (AR-03-05 shape)", () => {
		const d = classifyReplanOwnerDeterministic({ title: "Re-injection carries unbounded context forward each round", detail: "token budget tradeoff" });
		expect(d?.owner).toBe("design");
	});
	it("keyword: hard-coded tolerance without spec backing → spec (AR-03-06 shape)", () => {
		const d = classifyReplanOwnerDeterministic({ title: "±0.10 tolerance hard-coded", detail: "the threshold is unspecified in the spec" });
		expect(d?.owner).toBe("spec");
	});
	it("keyword: regression-shaped → fixer domain, never replan", () => {
		const d = classifyReplanOwnerDeterministic({ title: "behavior regression in dispatcher" });
		expect(d?.owner).toBe("human");
		expect(d?.routable).toBe(false);
	});
	it("keyword: scenario coverage gap → bdd; acceptance criteria → requirements", () => {
		expect(classifyReplanOwnerDeterministic({ title: "edge-case scenarios missing for AC-07 coverage" })?.owner).toBe("bdd");
		expect(classifyReplanOwnerDeterministic({ title: "acceptance criteria contradict each other" })?.owner).toBe("requirements");
	});

	// Residue.
	it("returns null (residue → lead) for unclassifiable shapes, incl. src-file citations", () => {
		expect(classifyReplanOwnerDeterministic({ title: "naming is inconsistent" })).toBeNull();
		expect(classifyReplanOwnerDeterministic({ file: "src/dispatcher.ts", title: "naming is inconsistent across modules" })).toBeNull();
	});
	it("never throws on garbage input", () => {
		expect(classifyReplanOwnerDeterministic({})).toBeNull();
		expect(classifyReplanOwnerDeterministic(null as unknown as Record<string, unknown>)).toBeNull();
	});
});

describe("R2 layer 2 — replan-lead classifier", () => {
	const finding = { id: "AR-03-03", title: "Resumable NeedsYou has no resume protocol", detail: "the resume contract is undefined for interrupted runs", file: "src/staging.ts" };

	const mkCtx = (control: Record<string, unknown> | null, error?: string) =>
		({
			agent: vi.fn(async () => ({ control, error, text: "" })),
			log: () => {},
		}) as unknown as StageContext;

	beforeEach(() => { delete process.env.SUPER_DEV_DISABLE_REPLAN_LEAD; });
	afterEach(() => { delete process.env.SUPER_DEV_DISABLE_REPLAN_LEAD; });

	it("routes a confident, evidence-verified lead verdict", async () => {
		const ctx = mkCtx({
			owner: "spec",
			confidence: 0.9,
			reason: "the resume protocol is a spec-level contract",
			evidence: [{ file: "src/staging.ts", quote: "Resumable NeedsYou has no resume protocol" }],
		});
		const d = await classifyReplanOwner(ctx, { finding });
		expect(d.owner).toBe("spec");
		expect(d.routable).toBe(true);
		expect(d.source).toBe("replan-lead");
		expect(d.confidence).toBe(0.9);
	});

	it("degrades to human on low confidence", async () => {
		const ctx = mkCtx({ owner: "spec", confidence: 0.4, reason: "guessing", evidence: [{ file: "f", quote: "Resumable NeedsYou has no resume protocol" }] });
		const d = await classifyReplanOwner(ctx, { finding });
		expect(d.owner).toBe("human");
		expect(d.routable).toBe(false);
		expect(d.reason).toContain("below 0.6");
	});

	it("degrades to human when the evidence quote is fabricated", async () => {
		const ctx = mkCtx({ owner: "design", confidence: 0.95, reason: "r", evidence: [{ file: "f", quote: "THIS QUOTE APPEARS NOWHERE IN THE FINDING TEXT" }] });
		const d = await classifyReplanOwner(ctx, { finding });
		expect(d.owner).toBe("human");
		expect(d.reason).toContain("failed verification");
	});

	it("degrades to human when the agent fails or emits an owner outside the closed set", async () => {
		expect((await classifyReplanOwner(mkCtx(null, "model boom"), { finding })).owner).toBe("human");
		expect((await classifyReplanOwner(mkCtx({ owner: "implementation", confidence: 0.9, reason: "r", evidence: [{ file: "f", quote: "Resumable NeedsYou has no resume protocol" }] }), { finding })).owner).toBe("human");
	});

	it("honors the kill switch without calling the agent", async () => {
		process.env.SUPER_DEV_DISABLE_REPLAN_LEAD = "1";
		const agent = vi.fn(async () => ({ control: {}, error: undefined, text: "" }));
		const d = await classifyReplanOwner({ agent } as unknown as StageContext, { finding });
		expect(d.owner).toBe("human");
		expect(agent).not.toHaveBeenCalled();
	});

	it("parseLeadControl + verifyLeadEvidence unit contracts", () => {
		expect(parseLeadControl(null)).toBeNull();
		expect(parseLeadControl({ owner: "nonsense" })).toBeNull();
		const blob = findingTextBlob(finding, "ctx line");
		expect(blob).toContain("Resumable NeedsYou");
		expect(verifyLeadEvidence([{ file: "f", quote: "Resumable NeedsYou has no resume protocol" }], blob)).toEqual([]);
		expect(verifyLeadEvidence([], blob)).toHaveLength(1);
		expect(verifyLeadEvidence([{ file: "f", quote: "short" }], blob)[0]).toContain("outside 8-200");
	});
});
