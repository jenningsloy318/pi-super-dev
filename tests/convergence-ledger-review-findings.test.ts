import { describe, expect, it } from "vitest";
import { blockingConvergenceFindings, getConvergenceLedger, markConvergenceFindingsAddressedFromResponses, markConvergenceFindingsVerified, recordReviewFindingsFromControl } from "../src/convergence-ledger.ts";
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
});
