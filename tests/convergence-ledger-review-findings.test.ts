import { describe, expect, it } from "vitest";
import { blockingConvergenceFindings, getConvergenceLedger, markConvergenceFindingsAddressedFromResponses, markConvergenceFindingsVerified, recordReviewFindingsFromControl } from "../src/convergence-ledger.ts";
import { enforceReviewerConvergenceDuty, reviewFindingBlocksVerdict, reviewFindingHighSeverity } from "../src/review-findings.ts";
import type { PipelineState } from "../src/types.ts";

describe("convergence ledger review finding taxonomy", () => {
	it("records verified and explicitly non-blocking review findings without making them blockers", () => {
		const state = {} as PipelineState;

		recordReviewFindingsFromControl(state, {
			verdict: "Changes Requested",
			findings: [
				{
					id: "skeptic-auth-url-secret-logging",
					severity: "high",
					status: "verified",
					blocking: false,
					title: "Prior finding verified: auth-route URL-carried secrets are no longer logged",
					detail: "Verified response to prior rejection: the raw auth URL logging issue has been addressed.",
				},
				{
					id: "CR-001",
					severity: "Medium",
					status: "open",
					blocking: false,
					title: "SCENARIO-006 test does not verify real persisted/cookie TTL alignment",
					detail: "A follow-up test-strength finding that the reviewer marked non-blocking.",
				},
			],
		}, { detectedAtStage: "verification", ownerStage: "implementation", sourceGate: "verification-review" });

		const ledger = getConvergenceLedger(state);
		expect(ledger.findings).toHaveLength(2);
		expect(ledger.findings.map((finding) => [finding.id, finding.status, finding.blocking])).toEqual([
			["skeptic-auth-url-secret-logging", "verified", false],
			["CR-001", "open", false],
		]);
		expect(blockingConvergenceFindings(state)).toEqual([]);
	});

	it("keeps needs-human findings blocking", () => {
		const state = {} as PipelineState;

		recordReviewFindingsFromControl(state, {
			verdict: "Changes Requested",
			findings: [{ id: "AMB-1", severity: "Medium", status: "needs-human", blocking: true, title: "Spec ambiguity", detail: "Human guidance is required." }],
		}, { detectedAtStage: "verification", ownerStage: "implementation", sourceGate: "verification-review" });

		expect(blockingConvergenceFindings(state).map((finding) => finding.id)).toEqual(["AMB-1"]);
	});

	// Semantics (review-finding clarification): a writer's `reviewResponses` marks
	// a finding `addressed` — the writer's CLAIM, not a confirmed fix. It stays
	// blocking (re-surfaced to the reviewer) until the reviewer VERIFIES it. Only
	// a `verified`/`deferred` status clears it from the blocking set. This matches
	// the spec-convergence "keep prior findings until verified" contract.
	it("an addressed finding STAYS blocking (writer claim) until verified; verified clears it", () => {
		const state = {} as PipelineState;
		recordReviewFindingsFromControl(state, {
			verdict: "Changes Requested",
			findings: [{ id: "F1", severity: "high", status: "open", blocking: true, title: "AC-01 not measurable", detail: "add a concrete assertion" }],
		}, { detectedAtStage: "requirementsReview", ownerStage: "requirements", sourceGate: "requirements-review" });
		expect(blockingConvergenceFindings(state).map((f) => f.id)).toEqual(["F1"]);

		// Writer claims F1 addressed → status addressed, but STILL blocking (unverified).
		const n = markConvergenceFindingsAddressedFromResponses(state, [{ findingId: "F1", status: "addressed", response: "clarified AC-01" }]);
		expect(n).toBe(1);
		expect(getConvergenceLedger(state).findings[0]!.status).toBe("addressed");
		expect(blockingConvergenceFindings(state).map((f) => f.id)).toEqual(["F1"]);

		// Reviewer VERIFIES F1 → it leaves the blocking set.
		markConvergenceFindingsVerified(state, (f) => f.id === "F1");
		expect(getConvergenceLedger(state).findings[0]!.status).toBe("verified");
		expect(blockingConvergenceFindings(state)).toEqual([]);
	});

	// Regression (review-finding round 3): a WRITER response cannot self-verify a
	// blocker out of the set — `verified`/`deferred` from a writer is clamped to
	// `addressed`. Only a REVIEWER response (`source: "reviewer"`) may verify/defer.
	it("clamps a writer's verified/deferred claim to addressed; reviewer verify clears", () => {
		const state = {} as PipelineState;
		recordReviewFindingsFromControl(state, {
			verdict: "Changes Requested",
			findings: [{ id: "F1", severity: "high", status: "open", blocking: true, title: "AC-01 not measurable", detail: "fix it" }],
		}, { detectedAtStage: "requirementsReview", ownerStage: "requirements", sourceGate: "requirements-review" });

		// Writer CLAIMS verified → clamped to addressed, STILL blocking.
		markConvergenceFindingsAddressedFromResponses(state, [{ findingId: "F1", status: "verified", response: "I fixed it, trust me" }], "writer");
		expect(getConvergenceLedger(state).findings[0]!.status).toBe("addressed");
		expect(blockingConvergenceFindings(state).map((f) => f.id)).toEqual(["F1"]);

		// Writer CLAIMS deferred → also clamped to addressed, STILL blocking.
		markConvergenceFindingsAddressedFromResponses(state, [{ findingId: "F1", status: "deferred", response: "not important" }], "writer");
		expect(getConvergenceLedger(state).findings[0]!.status).toBe("addressed");
		expect(blockingConvergenceFindings(state).map((f) => f.id)).toEqual(["F1"]);

		// Reviewer VERIFIES via priorFindingResolutions → clears it.
		markConvergenceFindingsAddressedFromResponses(state, [{ findingId: "F1", status: "verified", response: "confirmed resolved" }], "reviewer");
		expect(getConvergenceLedger(state).findings[0]!.status).toBe("verified");
		expect(blockingConvergenceFindings(state)).toEqual([]);
	});
});

describe("enforceReviewerConvergenceDuty (G1)", () => {
	const medium = (id: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
		id, severity: "medium", title: `Finding ${id}`, detail: "detail", blocking: true, status: "open", ...extra,
	});

	it("does nothing before REVIEWER_DUTY_ROUND", () => {
		const review = { verdict: "Changes Requested", findings: [medium("M-1")] };
		expect(enforceReviewerConvergenceDuty(review, 2, { stage: "spec" })).toBe(0);
		expect(review.findings![0]).toMatchObject({ blocking: true });
	});

	it("downgrades NEW non-High blocking findings at review round >= 3", () => {
		const review = { verdict: "Changes Requested", findings: [medium("M-1"), medium("L-1", { severity: "low" })] };
		const n = enforceReviewerConvergenceDuty(review, 3, { stage: "spec" });
		expect(n).toBe(2);
		expect(review.findings![0]).toMatchObject({ blocking: false });
		expect(String(review.findings![0].downgradeReason)).toContain("convergence-duty");
		expect(review.findings![1]).toMatchObject({ blocking: false });
	});

	it("keeps High/Critical-class findings blocking at late rounds", () => {
		const review = { verdict: "Changes Requested", findings: [medium("H-1", { severity: "high" }), medium("C-1", { severity: "critical" })] };
		expect(enforceReviewerConvergenceDuty(review, 5, { stage: "bdd" })).toBe(0);
		expect(review.findings![0]).toMatchObject({ blocking: true });
		expect(review.findings![1]).toMatchObject({ blocking: true });
	});

	it("keeps re-flags of KNOWN prior findings (priorFindingId validated against the ledger) blocking", () => {
		const known = new Set(["PRIOR-9"]);
		const review = { verdict: "Changes Requested", findings: [medium("R-1", { priorFindingId: "PRIOR-9" })] };
		expect(enforceReviewerConvergenceDuty(review, 4, { stage: "spec", knownFindingIds: known })).toBe(0);
		expect(review.findings![0]).toMatchObject({ blocking: true });
	});

	it("an UNKNOWN priorFindingId cannot dodge the downgrade (hallucinated reference)", () => {
		const known = new Set(["PRIOR-9"]);
		const review = { verdict: "Changes Requested", findings: [medium("D-1", { priorFindingId: "REQ-999-DOES-NOT-EXIST" })] };
		expect(enforceReviewerConvergenceDuty(review, 4, { stage: "spec", knownFindingIds: known })).toBe(1);
		expect(review.findings![0]).toMatchObject({ blocking: false });
	});

	it("R2: flagless needs-human with extended-vocab severity PINS the verdict layer (shared vocabulary)", () => {
		// reviewFindingBlocksVerdict previously kept the narrow inline regex —
		// 'P1'/'major'/'serious' needs-human findings without an explicit
		// blocking flag silently approved (adversarial R2-G1-VERDICT-VOCABULARY-SPLIT)
		for (const severity of ["P1", "major", "must-fix", "serious", "S1", "sev1"]) {
			const f = { severity, status: "needs-human", title: "decision", detail: "needs a human" };
			expect(reviewFindingBlocksVerdict(f), severity).toBe(true);
		}
	});

	it("R2: boundary-anchored high-class vocabulary — prefix false positives excluded", () => {
		for (const severity of ["majorly cosmetic", "highly minor", "P10", "S12"]) {
			expect(reviewFindingHighSeverity({ severity }), severity).toBe(false);
		}
		for (const severity of ["major", "P1", "S0", "sev1", "errors", "failure", "rejected", "must fix", "Critical", "HIGH"]) {
			expect(reviewFindingHighSeverity({ severity }), severity).toBe(true);
		}
	});

	it("R2: a re-flag of a DUTY-DOWNGRADED advisory is NOT shielded (no resurrection)", () => {
		// the ledger row for the downgraded advisory is blocking=false → its id
		// is not in the blocking-class knownFindingIds set → the re-flag must
		// re-earn blocking through High/Critical severity or be downgraded
		const downgradedAdvisoryIds = new Set<string>(); // filtered out upstream
		const review = { verdict: "Changes Requested", findings: [medium("RES-1", { priorFindingId: "ADVISORY-5" })] };
		expect(enforceReviewerConvergenceDuty(review, 5, { stage: "spec", knownFindingIds: downgradedAdvisoryIds })).toBe(1);
		expect(review.findings![0]).toMatchObject({ blocking: false });
	});

	it("recognizes common tracker high-class severity vocabulary (major, P1, must-fix)", () => {
		const review = { verdict: "Changes Requested", findings: [
			medium("MJ-1", { severity: "major" }),
			medium("P1-1", { severity: "P1" }),
			medium("MF-1", { severity: "must-fix" }),
			medium("SR-1", { severity: "serious" }),
		] };
		expect(enforceReviewerConvergenceDuty(review, 5, { stage: "requirements" })).toBe(0);
		for (const f of review.findings as Array<Record<string, unknown>>) expect(f.blocking).toBe(true);
	});

	it("downgrades late needs-human findings that are not high-class", () => {
		const review = { verdict: "Changes Requested", findings: [medium("NH-1", { status: "needs-human", severity: "medium" })] };
		expect(enforceReviewerConvergenceDuty(review, 3, { stage: "spec" })).toBe(1);
		expect(review.findings![0]).toMatchObject({ blocking: false });
	});

	it("leaves advisory and undefined controls untouched", () => {
		const review = { verdict: "Changes Requested", findings: [medium("A-1", { blocking: false })] };
		expect(enforceReviewerConvergenceDuty(review, 8, { stage: "spec" })).toBe(0);
		expect(enforceReviewerConvergenceDuty(undefined, 8, { stage: "spec" })).toBe(0);
	});
});
