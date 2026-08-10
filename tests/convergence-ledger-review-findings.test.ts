import { describe, expect, it } from "vitest";
import { blockingConvergenceFindings, getConvergenceLedger, recordReviewFindingsFromControl } from "../src/convergence-ledger.ts";
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
});
