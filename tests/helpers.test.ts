/**
 * Unit tests for the deterministic helpers and the control-JSON parser.
 * No LLM, no subprocesses.
 */

import { describe, it, expect } from "vitest";
import { runHelper } from "../src/helpers.ts";
import { extractControl, findLastJsonObject } from "../src/control.ts";

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
		expect((contest.value.findings as unknown[]).length).toBe(1);
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
