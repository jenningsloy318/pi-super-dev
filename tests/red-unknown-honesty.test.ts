/**
 * v0.3.30 F2 — honest `unknown` RED evidence.
 *
 * Root cause (run 2026-08-28T16-09-12-785Z): the fail-closed guard coerced
 * `unknown-*` evidence into `broken-test`, whose retry template claims
 * "tests did not compile/collect" — while the agent's own gradle run proved
 * 127 tests compiled, ran, and 122 FAILED. The lie misdirected the tdd agent
 * ("fix compilation") and polluted judge inputs. These tests pin the honest
 * contract: unknown stays unknown, gets its OWN reason/hint templates, and
 * never claims compilation failure it did not observe.
 */

import { describe, it, expect } from "vitest";
import { classifyRedEvidence, redEvidenceFailureReasons, redGenerationRetryHint } from "../src/stages/implementation.ts";
import type { RedEvidence } from "../src/stages/implementation.ts";

const BOUNDARY_OK = { classifications: [], forbiddenFiles: [], ambiguousFiles: [], allAllowed: true };

function evidence(over: Partial<RedEvidence>): RedEvidence {
	return {
		phaseId: "phase-01",
		attempt: 1,
		oracleStatus: "unknown",
		testFiles: [],
		changedFiles: [],
		forbiddenFiles: [],
		boundary: BOUNDARY_OK,
		redRetries: 0,
		status: "unknown-no-runner",
		reason: "",
		...over,
	} as RedEvidence;
}

describe("v0.3.30 F2 — classifyRedEvidence keeps unknown honest", () => {
	it("no testFiles → unknown-no-runner (never relabeled broken-test)", () => {
		const e = classifyRedEvidence({ phaseId: "p", attempt: 1, redStatus: "unknown", testFiles: [], changedFiles: [], boundary: BOUNDARY_OK as never, redRetries: 0, alreadySatisfied: false });
		expect(e.status).toBe("unknown-no-runner");
	});

	it("testFiles present but unclassifiable → unknown-unclassified", () => {
		const e = classifyRedEvidence({ phaseId: "p", attempt: 1, redStatus: "unknown", testFiles: ["a/src/test/java/x/ATest.kt"], changedFiles: [], boundary: BOUNDARY_OK as never, redRetries: 0, alreadySatisfied: false });
		expect(e.status).toBe("unknown-unclassified");
	});
});

describe("v0.3.30 F2 — redEvidenceFailureReasons templates", () => {
	it("unknown-no-runner reads red-unverified, not a compile-failure claim", () => {
		const reasons = redEvidenceFailureReasons(evidence({ status: "unknown-no-runner" }));
		expect(reasons.join("; ")).toMatch(/red-unverified/i);
		expect(reasons.join("; ")).toMatch(/no (supported )?test runner/i);
		expect(reasons.join("; ")).not.toMatch(/did not compile/i);
	});

	it("unknown-unclassified discloses the classification gap honestly", () => {
		const reasons = redEvidenceFailureReasons(evidence({ status: "unknown-unclassified", testFiles: ["ATest.kt"] }));
		expect(reasons.join("; ")).toMatch(/red-unverified/i);
		expect(reasons.join("; ")).not.toMatch(/did not compile/i);
	});

	it("genuine broken-test keeps the compile/collect template (pin — no regression)", () => {
		const reasons = redEvidenceFailureReasons(evidence({ status: "broken-test", testFiles: ["ATest.kt"], oracleStatus: "broken" }));
		expect(reasons.join("; ")).toMatch(/red-broken: tests did not compile\/collect/);
	});
});

describe("v0.3.30 F2 — redGenerationRetryHint for unknown evidence", () => {
	it("unknown-no-runner produces a scoped hint: supported runner, no production code, stay in the worktree", () => {
		const hint = redGenerationRetryHint(evidence({ status: "unknown-no-runner" }), { failClosed: true }) ?? "";
		expect(hint).toMatch(/test runner/i);
		expect(hint).toMatch(/do not modify production/i);
		expect(hint).toMatch(/outside (this|the) worktree/i);
	});

	it("unknown-unclassified also produces a hint (so the fail-closed retry loop engages)", () => {
		const hint = redGenerationRetryHint(evidence({ status: "unknown-unclassified" }), { failClosed: true });
		expect(hint).toBeTruthy();
	});

	it("without failClosed the unknown hint stays null (phases without required tests proceed without stalling — P3 contract pin)", () => {
		expect(redGenerationRetryHint(evidence({ status: "unknown-no-runner" }))).toBeNull();
		expect(redGenerationRetryHint(evidence({ status: "unknown-unclassified" }))).toBeNull();
	});
});
