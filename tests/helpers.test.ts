/**
 * Unit tests for the deterministic helpers and the control-JSON parser.
 * No LLM, no subprocesses.
 */

import { describe, it, expect } from "vitest";
import { runHelper } from "../src/helpers.ts";
import { extractControl, findLastJsonObject } from "../src/control.ts";
import { reviewFindingBlocks, reviewFindingBlocksVerdict, reviewHasBlockingFinding, reviewHasBlockingVerdictFinding } from "../src/review-findings.ts";

describe("review-findings: verdict-layer blocking (F-A)", () => {
	it("routing semantics unchanged — needs-human still blocks the fixer-facing scan", () => {
		const f = { severity: "medium", status: "needs-human", blocking: false, title: "x" };
		expect(reviewFindingBlocks(f)).toBe(true);
		expect(reviewHasBlockingFinding({ findings: [f] })).toBe(true);
	});
	it("verdict semantics — a medium non-blocking needs-human finding does not pin", () => {
		const f = { severity: "medium", status: "needs-human", blocking: false, title: "x" };
		expect(reviewFindingBlocksVerdict(f)).toBe(false);
		expect(reviewHasBlockingVerdictFinding({ findings: [f] })).toBe(false);
	});
	it("verdict semantics — needs-human pins via its own blocking flag", () => {
		expect(reviewFindingBlocksVerdict({ severity: "medium", status: "needs-human", blocking: true })).toBe(true);
		expect(reviewFindingBlocksVerdict({ severity: "medium", status: "needs-human", blocking: "yes" })).toBe(true);
		expect(reviewFindingBlocksVerdict({ severity: "medium", status: "needs-human", blocking: false })).toBe(false);
	});
	it("verdict semantics — needs-human severity fallback applies only when the blocking flag is absent (flag wins, same as open)", () => {
		// Explicit flag wins (existing reviewFindingBlocks invariant): the high
		// pin for blocking:false findings is carried by reviewHasHighSeverityFinding
		// at the verdict layer, not by the blocking scan.
		expect(reviewFindingBlocksVerdict({ severity: "high", status: "needs-human", blocking: false })).toBe(false);
		expect(reviewFindingBlocksVerdict({ severity: "critical", status: "needs-human" })).toBe(true);
		expect(reviewFindingBlocksVerdict({ severity: "high", status: "needs-human" })).toBe(true);
		expect(reviewFindingBlocksVerdict({ severity: "medium", status: "needs-human" })).toBe(false);
	});
	it("non-needs-human statuses delegate to reviewFindingBlocks unchanged (flag wins over severity)", () => {
		expect(reviewFindingBlocksVerdict({ severity: "high", status: "open", blocking: false })).toBe(false);
		expect(reviewFindingBlocksVerdict({ severity: "high", status: "open" })).toBe(true);
		expect(reviewFindingBlocksVerdict({ severity: "medium", status: "open", blocking: true })).toBe(true);
		expect(reviewFindingBlocksVerdict({ severity: "medium", status: "open", blocking: false })).toBe(false);
		expect(reviewFindingBlocksVerdict({ severity: "high", status: "verified" })).toBe(false);
		expect(reviewFindingBlocksVerdict({ severity: "high", status: "deferred" })).toBe(false);
	});
});

describe("helpers: classify-task", () => {
	it("classifies a fix as a bug", async () => {
		const r = await runHelper({ name: "classify-task", sources: { setup: { language: "rust", isWebUi: false } }, options: { runtimeTask: "fix the login crash" } });
		expect(r.value.taskType).toBe("bug");
	});
	it("classifies a refactor", async () => {
		const r = await runHelper({ name: "classify-task", sources: { setup: { language: "go", isWebUi: false } }, options: { runtimeTask: "refactor the database layer" } });
		expect(r.value.taskType).toBe("refactor");
	});
	it("classifies a feature with web UI", async () => {
		const r = await runHelper({ name: "classify-task", sources: { setup: { language: "frontend", isWebUi: true } }, options: { runtimeTask: "add a profile page" } });
		expect(r.value.taskType).toBe("feature");
		expect(r.value.uiScope).toBe("ui+arch");
	});
});

describe("helpers: gates", () => {
	it("gate-requirements passes on a well-formed control", async () => {
		const r = await runHelper({ name: "gate-requirements", sources: { "write-requirements": { docPath: "/x.md", acCount: 2, summary: "s", featureName: "f" } } });
		expect(r.value.pass).toBe(true);
	});
	it("gate-requirements fails when acceptance criteria missing", async () => {
		const r = await runHelper({ name: "gate-requirements", sources: { "write-requirements": { docPath: "/x.md", summary: "s", featureName: "f" } } });
		expect(r.value.pass).toBe(false);
	});
	it("gate-spec-review passes only on Approved variants", async () => {
		const ok = await runHelper({ name: "gate-spec-review", sources: { "review-spec": { verdict: "Approved with Comments" } } });
		expect(ok.value.pass).toBe(true);
		const bad = await runHelper({ name: "gate-spec-review", sources: { "review-spec": { verdict: "Changes Requested" } } });
		expect(bad.value.pass).toBe(false);
	});
});

describe("helpers: routing", () => {
	it("route-designer skips design for bugs", async () => {
		const r = await runHelper({ name: "route-designer", sources: { "classify-task": { taskType: "bug", uiScope: "none" } } });
		expect(r.value.designerAgent).toBeNull();
	});
	it("route-designer picks product-designer for ui+arch", async () => {
		const r = await runHelper({ name: "route-designer", sources: { "classify-task": { taskType: "feature", uiScope: "ui+arch" } } });
		expect(r.value.designerAgent).toBe("product-designer");
	});
	it("merge-review-verdicts takes the stricter verdict", async () => {
		const r = await runHelper({ name: "merge-review-verdicts", sources: { "code-review": { verdict: "Approved" }, "adversarial-review": { verdict: "Changes Requested", findings: [{ severity: "high" }] } } });
		expect(r.value.verdict).toBe("Changes Requested");
		expect((r.value.findings as unknown[]).length).toBe(1);
	});
	it("merge-review-verdicts never defaults missing reviewer output to approval", async () => {
		const r = await runHelper({ name: "merge-review-verdicts", sources: { "code-review": {}, "adversarial-review": {} } });
		expect(r.value.verdict).toBe("Changes Requested");
		expect((r.value.findings as unknown[]).length).toBeGreaterThan(0);
	});
	it("merge-review-verdicts maps adversarial PASS/CONTEST/REJECT to calibrated gate semantics", async () => {
		const pass = await runHelper({ name: "merge-review-verdicts", sources: { "code-review": { verdict: "Approved" }, "adversarial-review": { verdict: "PASS" } } });
		expect(pass.value.verdict).toBe("Approved");
		const contest = await runHelper({ name: "merge-review-verdicts", sources: { "code-review": { verdict: "Approved" }, "adversarial-review": { verdict: "CONTEST", findings: [{ severity: "medium", title: "quality concern" }] } } });
		expect(contest.value.verdict).toBe("Approved with Comments");
		// R-1: advisory (non-blocking, below high) CONTEST findings move to the
		// deferred ledger — they no longer drive the fix loop.
		expect((contest.value.findings as unknown[]).length).toBe(0);
		expect((contest.value.deferredFindings as unknown[]).length).toBe(1);
		const highContest = await runHelper({ name: "merge-review-verdicts", sources: { "code-review": { verdict: "Approved" }, "adversarial-review": { verdict: "CONTEST", findings: [{ severity: "high", title: "blocking concern" }] } } });
		expect(highContest.value.verdict).toBe("Changes Requested");
		const reject = await runHelper({ name: "merge-review-verdicts", sources: { "code-review": { verdict: "Approved" }, "adversarial-review": { verdict: "REJECT" } } });
		expect(reject.value.verdict).toBe("Blocked");
	});
	it("merge-review-verdicts does not let a verified prior high-severity note block CONTEST", async () => {
		const r = await runHelper({
			name: "merge-review-verdicts",
			sources: {
				"code-review": { verdict: "Approved" },
				"adversarial-review": {
					verdict: "CONTEST",
					findings: [{
						id: "skeptic-auth-url-secret-logging",
						severity: "high",
						title: "Prior finding verified: auth-route URL-carried secrets are no longer logged",
						detail: "Verified response to prior rejection: raw auth URL logging has been addressed.",
					}],
				},
			},
		});
		expect(r.value.verdict).toBe("Approved with Comments");
	});
	it("merge-review-verdicts downgrades Changes Requested when every finding is non-blocking", async () => {
		const r = await runHelper({
			name: "merge-review-verdicts",
			sources: {
				"code-review": {
					verdict: "Changes Requested",
					findings: [{
						id: "CR-001",
						severity: "Medium",
						status: "open",
						blocking: false,
						title: "Synthetic test should become stronger",
						detail: "Useful follow-up, but not a merge blocker for the current fix.",
					}],
				},
				"adversarial-review": { verdict: "PASS", findings: [] },
			},
		});
		expect(r.value.verdict).toBe("Approved with Comments");
	});
	it("merge-review-verdicts KEEPS Changes Requested when an open High finding is non-blocking (severity fallback beats the blocking flag)", async () => {
		const r = await runHelper({
			name: "merge-review-verdicts",
			sources: {
				"code-review": {
					verdict: "Changes Requested",
					findings: [{
						id: "CR-1",
						severity: "High",
						status: "open",
						blocking: false,
						title: "Race in cache invalidation",
						detail: "Must fix before merge per reviewer's explicit request.",
					}],
				},
				"adversarial-review": { verdict: "PASS", findings: [] },
			},
		});
		expect(r.value.verdict).toBe("Changes Requested");
	});
	it("merge-review-verdicts still downgrades when the only High finding is already verified", async () => {
		const r = await runHelper({
			name: "merge-review-verdicts",
			sources: {
				"code-review": {
					verdict: "Changes Requested",
					findings: [{
						id: "CR-1",
						severity: "High",
						status: "verified",
						blocking: false,
						title: "Previously flagged race",
						detail: "Confirmed fixed in this revision.",
					}],
				},
				"adversarial-review": { verdict: "PASS", findings: [] },
			},
		});
		expect(r.value.verdict).toBe("Approved with Comments");
	});
	it("merge-review-verdicts keeps CONTEST blocking on an open High finding even without the blocking flag", async () => {
		const r = await runHelper({
			name: "merge-review-verdicts",
			sources: {
				"code-review": { verdict: "Approved" },
				"adversarial-review": { verdict: "CONTEST", findings: [{ severity: "High", status: "open", blocking: false, title: "data-loss shape" }] },
			},
		});
		expect(r.value.verdict).toBe("Changes Requested");
	});
	it("merge-review-verdicts keeps Changes Requested when a Critical finding is non-blocking", async () => {
		const r = await runHelper({
			name: "merge-review-verdicts",
			sources: {
				"code-review": {
					verdict: "Changes Requested",
					findings: [{ severity: "Critical", status: "open", blocking: false, title: "SQL injection" }],
				},
				"adversarial-review": { verdict: "PASS", findings: [] },
			},
		});
		expect(r.value.verdict).toBe("Changes Requested");
	});
	it("merge-review-verdicts keeps Changes Requested when a finding is explicitly blocking", async () => {
		const r = await runHelper({
			name: "merge-review-verdicts",
			sources: {
				"code-review": {
					verdict: "Changes Requested",
					findings: [{ severity: "Medium", status: "needs-human", blocking: true, title: "Spec ambiguity", detail: "Requires human decision." }],
				},
				"adversarial-review": { verdict: "PASS", findings: [] },
			},
		});
		expect(r.value.verdict).toBe("Changes Requested");
	});

	// ── F-A: needs-human is a WHO class, not a verdict pin ────────────────────
	// Production regression: run 2026-08-16T01-00-35-613Z (spec 03-staging)
	// attempt 2 — code/tests Approved, adversarial CONTEST with a single
	// medium needs-human non-blocking finding (AR-03-02). The old
	// needs-human⇒blocking promotion pinned "Changes Requested" while R-1
	// triage deferred the same finding to the human — an unactionable verdict
	// that dead-ended the verify loop into a PARTIAL.
	it("merge-review-verdicts does NOT pin Changes Requested on a medium non-blocking needs-human finding (CONTEST residue)", async () => {
		const r = await runHelper({
			name: "merge-review-verdicts",
			sources: {
				"code-review": { verdict: "Approved", findings: [] },
				"adversarial-review": {
					verdict: "CONTEST",
					findings: [{ id: "AR-03-02", severity: "medium", status: "needs-human", blocking: false, title: "Default dispatcher behavior unverified", detail: "Human should confirm intent." }],
				},
			},
		});
		expect(r.value.verdict).toBe("Approved with Comments");
		expect(r.value.findings).toEqual([]);
		const deferred = r.value.deferredFindings as Array<Record<string, unknown>>;
		const needsHuman = r.value.needsHumanFindings as Array<Record<string, unknown>>;
		expect(deferred).toHaveLength(1);
		expect(deferred[0].deferralReason).toBe("needs human verification");
		expect(needsHuman).toHaveLength(1);
		expect(needsHuman[0].id).toBe("AR-03-02");
	});

	it("merge-review-verdicts does NOT flip an Approved verdict on a non-blocking needs-human finding", async () => {
		const r = await runHelper({
			name: "merge-review-verdicts",
			sources: {
				"code-review": { verdict: "Approved", findings: [{ severity: "low", status: "needs-human", title: "Prefer enum over string?" }] },
				"adversarial-review": { verdict: "PASS", findings: [] },
			},
		});
		expect(r.value.verdict).toBe("Approved");
		expect((r.value.needsHumanFindings as unknown[]).length).toBe(1);
	});

	it("merge-review-verdicts downgrades Changes Requested to Approved with Comments when the only pin was a non-blocking needs-human finding", async () => {
		const r = await runHelper({
			name: "merge-review-verdicts",
			sources: {
				"code-review": { verdict: "Changes Requested", findings: [{ severity: "medium", status: "needs-human", blocking: false, title: "Tolerance source ambiguity" }] },
				"adversarial-review": { verdict: "PASS", findings: [] },
			},
		});
		expect(r.value.verdict).toBe("Approved with Comments");
	});

	it("merge-review-verdicts KEEPS Changes Requested when a needs-human finding is high severity (severity fallback still pins)", async () => {
		const r = await runHelper({
			name: "merge-review-verdicts",
			sources: {
				"code-review": { verdict: "CONTEST", findings: [{ severity: "High", status: "needs-human", blocking: false, title: "Security posture needs a human call" }] },
				"adversarial-review": { verdict: "PASS", findings: [] },
			},
		});
		expect(r.value.verdict).toBe("Changes Requested");
	});

	it("merge-review-verdicts: needs-human blocking text 'yes' still pins the verdict", async () => {
		const r = await runHelper({
			name: "merge-review-verdicts",
			sources: {
				"code-review": { verdict: "CONTEST", findings: [{ severity: "medium", status: "needs-human", blocking: "yes", title: "Merge only after human confirms" }] },
				"adversarial-review": { verdict: "PASS", findings: [] },
			},
		});
		expect(r.value.verdict).toBe("Changes Requested");
	});
});

describe("control parser", () => {
	it("extracts <control> tag JSON", () => {
		const out = extractControl("Here is the result.\n<control>{\"docPath\":\"/a.md\",\"acCount\":2}</control>\n");
		expect(out?.docPath).toBe("/a.md");
	});
	it("extracts fenced json block", () => {
		const out = extractControl("blah\n```json\n{\"verdict\":\"Approved\"}\n```\n");
		expect(out?.verdict).toBe("Approved");
	});
	it("extracts the last balanced object", () => {
		expect(findLastJsonObject("noise {\"a\":1} more {\"b\":2}")).toBe('{"b":2}');
	});
	it("returns null when no JSON present", () => {
		expect(extractControl("just prose, nothing structural")).toBeNull();
	});
	it("tolerates trailing commas", () => {
		const out = extractControl('```json\n{"a":1, "b":2,}\n```');
		expect(out?.a).toBe(1);
	});
});

describe("R-1 merge-layer finding triage", () => {
	const f = (over: Record<string, unknown>) => ({ id: "F", severity: "low", title: "T", detail: "d", file: "a.ts", ...over });

	it("drops verified/resolved confirmations from the fix loop", async () => {
		const r = await runHelper({
			name: "merge-review-verdicts",
			sources: {
				"code-review": { verdict: "Changes Requested", findings: [f({ id: "V1", status: "verified", severity: "high" }), f({ id: "V2", status: "resolved", blocking: true })] },
				"adversarial-review": { verdict: "PASS", findings: [] },
			},
		});
		expect(r.value.findings).toHaveLength(0);
		expect(r.value.deferredFindings).toHaveLength(0);
	});

	it("routes open blocking/high findings to fix-now and advisory to the ledger", async () => {
		const r = await runHelper({
			name: "merge-review-verdicts",
			sources: {
				"code-review": {
					verdict: "Changes Requested",
					findings: [
						f({ id: "B1", severity: "high", blocking: false }),
						f({ id: "A1", severity: "low", blocking: false }),
						f({ id: "B2", severity: "medium", blocking: true }),
					],
				},
				"adversarial-review": { verdict: "PASS", findings: [] },
			},
		});
		const ids = (r.value.findings as Array<{ id: string }>).map((x) => x.id).sort();
		expect(ids).toEqual(["B1", "B2"]);
		const ledger = r.value.deferredFindings as Array<{ id: string; deferralReason: string }>;
		expect(ledger.map((x) => x.id)).toEqual(["A1"]);
		expect(ledger[0].deferralReason).toContain("advisory");
	});

	it("defers needs-human and cross-stage findings even when blocking/high", async () => {
		const r = await runHelper({
			name: "merge-review-verdicts",
			sources: {
				"code-review": {
					verdict: "Changes Requested",
					findings: [
						f({ id: "H1", severity: "high", blocking: true, status: "needs-human" }),
						f({ id: "X1", severity: "high", blocking: true, ownerStage: "requirements" }),
						f({ id: "I1", severity: "high", blocking: true, ownerStage: "implementation" }),
					],
				},
				"adversarial-review": { verdict: "PASS", findings: [] },
			},
		});
		expect((r.value.findings as Array<{ id: string }>).map((x) => x.id)).toEqual(["I1"]);
		const ledger = r.value.deferredFindings as Array<{ id: string; deferralReason: string }>;
		const byId = new Map(ledger.map((x) => [x.id, x.deferralReason]));
		expect(byId.get("H1")).toContain("needs human");
		expect(byId.get("X1")).toContain("cross-stage");
	});

	it("keeps explicit status=deferred findings out of the fix loop", async () => {
		const r = await runHelper({
			name: "merge-review-verdicts",
			sources: {
				"code-review": { verdict: "Changes Requested", findings: [f({ id: "D1", severity: "high", status: "deferred" })] },
				"adversarial-review": { verdict: "PASS", findings: [] },
			},
		});
		expect(r.value.findings).toHaveLength(0);
		expect(r.value.deferredFindings).toHaveLength(1);
	});
});

describe("R-2 optional tests-review merge source", () => {
	it("absent tests-review source keeps the two-source verdict unchanged", async () => {
		const r = await runHelper({ name: "merge-review-verdicts", sources: { "code-review": { verdict: "Approved", findings: [] }, "adversarial-review": { verdict: "PASS", findings: [] } } });
		expect(r.value.verdict).toBe("Approved");
	});
	it("present tests-review source joins the strictest-verdict ranking", async () => {
		const r = await runHelper({
			name: "merge-review-verdicts",
			sources: {
				"code-review": { verdict: "Approved", findings: [] },
				"adversarial-review": { verdict: "PASS", findings: [] },
				"tests-review": { verdict: "Changes Requested", findings: [{ id: "TR-1", severity: "high", title: "missing scenario binding", blocking: true }] },
			},
		});
		expect(r.value.verdict).toBe("Changes Requested");
		expect((r.value.findings as Array<{ id?: string }>).some((f) => f.id === "TR-1")).toBe(true);
	});
	it("empty-object tests-review source is ignored (skip marker shape)", async () => {
		const r = await runHelper({
			name: "merge-review-verdicts",
			sources: { "code-review": { verdict: "Approved", findings: [] }, "adversarial-review": { verdict: "PASS", findings: [] }, "tests-review": {} },
		});
		expect(r.value.verdict).toBe("Approved");
	});
});

// ─── check-prototype-needed: boolean control drift (run 2026-08-15T13-45-02 postmortem) ──
// The design render schema types hasNumericConstants as STRING, so the design
// agent emits "true"/"yes"; the old consumer `=== true` could NEVER fire and the
// prototype-needed gate was dead from this signal. Tolerant read via toBool.
describe("check-prototype-needed — boolean drift tolerance", () => {
	it('string "true" now triggers the prototype gate (was dead)', async () => {
		const r = await runHelper({ name: "check-prototype-needed", sources: { design: { hasNumericConstants: "true", modules: [{ constants: ["MAX_RETRY=3"] }] } } });
		expect(r.value.needed).toBe(true);
		expect(r.value.constants).toEqual(["MAX_RETRY=3"]);
	});
	it('string "yes" and boolean true both trigger', async () => {
		const yes = await runHelper({ name: "check-prototype-needed", sources: { design: { hasNumericConstants: "yes" } } });
		expect(yes.value.needed).toBe(true);
		const bool = await runHelper({ name: "check-prototype-needed", sources: { design: { hasNumericConstants: true } } });
		expect(bool.value.needed).toBe(true);
	});
	it('string "false" / boolean false / absent stay not-needed', async () => {
		for (const v of ["false", false, undefined]) {
			const r = await runHelper({ name: "check-prototype-needed", sources: { design: { hasNumericConstants: v } } });
			expect(r.value.needed).toBe(false);
		}
	});
});
