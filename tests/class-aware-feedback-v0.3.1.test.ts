/**
 * v0.3.1 F1–F4 tests: class-aware feedback (defectClass threading,
 * class-sweep directive, evidence passthrough, truncation accounting),
 * reviewer rubric + defectClass duty in prompts, derivation standing rule,
 * and implementer worktree discipline.
 *
 * Root cause (run 2026-08-20T06-19-50-494Z): ONE over-restrictive-validation
 * defect class surfaced one filename family per review round across 4 rounds —
 * site-addressed feedback produces whack-a-mole; the sweep directive widens
 * the handle to the class at the 2nd instance.
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	classSweepRetryFeedback,
	getConvergenceLedger,
	recordConvergenceFindings,
	recordReviewFindingsFromControl,
} from "../src/convergence-ledger.ts";
import { compactReviewFindings as compactSpec } from "../src/stages/spec-convergence.ts";
import { compactReviewFindings as compactArtifact } from "../src/stages/artifact-convergence.ts";
import {
	buildDesignPrompt,
	buildFixPrompt,
	buildImplementPrompt,
	buildSpecPrompt,
	buildSpecReviewPrompt,
	buildUpstreamReviewPrompt,
} from "../src/prompts.ts";
import type { ControlObj, PipelineState, SetupControl } from "../src/types.ts";

function bareState(): PipelineState {
	return { setup: setupCtl(), classify: { taskType: "feature", uiScope: "none", language: "backend", isWebUi: false } };
}

function setupCtl(dir = "/tmp/sd-test"): SetupControl {
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

function reviewWithFindings(findings: Array<Record<string, unknown>>): ControlObj {
	return {
		title: "Review",
		date: "2026-08-20",
		verdict: "Changes Requested",
		summary: "Rejected.",
		findings,
		dimensions: ["Completeness", "Consistency", "Feasibility", "Testability", "Traceability", "Grounding", "Complexity", "Ambiguity"].map((name) => ({ name, status: "fail", notes: "reviewed" })),
	};
}

describe("F1: compactReviewFindings — class tag, evidence passthrough, truncation accounting", () => {
	it("emits class=<name> on class-tagged findings and nothing class-like otherwise", () => {
		const tagged = reviewWithFindings([{ id: "D07-F08", severity: "high", title: "Filename rejected", detail: "stage-<id>.report.md violates the allowlist.", defectClass: "pattern-rejects-registry-keys" }]);
		const lines = compactSpec(tagged);
		expect(lines.some((l) => l.includes("class=pattern-rejects-registry-keys"))).toBe(true);
		const untagged = reviewWithFindings([{ id: "X-1", severity: "high", title: "Some defect", detail: "unrelated" }]);
		for (const line of compactArtifact(untagged)) expect(line).not.toMatch(/\bclass=/);
	});

	it("passes reviewer evidence through (first 2 items, capped at 240 chars with a marker) so the writer can re-verify", () => {
		const long = "e".repeat(300);
		const review = reviewWithFindings([{ id: "E-1", severity: "high", title: "Bad pattern", detail: "d", evidence: [long, "short evidence", "third-not-shown"] }]);
		const joined = compactSpec(review).join("\n");
		expect(joined).toContain("evidence: ");
		expect(joined).toContain("short evidence");
		expect(joined).toContain("…(+60 chars)");
		expect(joined).not.toContain("third-not-shown");
	});

	it("announces omitted findings past the 8-line cap instead of silently dropping them (cumora truncation accounting)", () => {
		const findings = Array.from({ length: 10 }, (_, i) => ({ id: `F-${i}`, severity: "high", title: `Defect ${i}`, detail: "d" }));
		const lines = compactArtifact(reviewWithFindings(findings));
		expect(lines.some((l) => l.includes("(+2 more findings omitted"))).toBe(true);
		// control: at or under the cap there is no omission line
		const under = compactSpec(reviewWithFindings(findings.slice(0, 8)));
		expect(under.some((l) => l.includes("more findings omitted"))).toBe(false);
	});
});

describe("F1: defectClass ledger threading", () => {
	it("recordReviewFindingsFromControl carries defectClass into the ledger", () => {
		const state = bareState();
		recordReviewFindingsFromControl(state, reviewWithFindings([{ id: "A-1", severity: "high", title: "T1", detail: "D1", blocking: true, defectClass: "allowlist-too-strict" }]), { detectedAtStage: "specReview", ownerStage: "spec" });
		expect(getConvergenceLedger(state).findings.some((f) => f.defectClass === "allowlist-too-strict")).toBe(true);
	});

	it("the merge keeps an existing class tag when an incoming re-record omits it", () => {
		const state = bareState();
		recordConvergenceFindings(state, [{ id: "R-1", title: "Same finding", detail: "same detail", severity: "high", blocking: true, defectClass: "colon-in-ids" }], { detectedAtStage: "design" });
		recordConvergenceFindings(state, [{ id: "R-1", title: "Same finding", detail: "same detail", severity: "high", blocking: true }], { detectedAtStage: "design" });
		const row = getConvergenceLedger(state).findings.find((f) => f.id.includes("R-1") || f.title === "Same finding");
		expect(row?.defectClass).toBe("colon-in-ids");
	});
});

describe("F1: classSweepRetryFeedback — the sweep directive fires at the 2nd instance", () => {
	it("returns nothing on an empty or single-instance ledger", () => {
		const state = bareState();
		expect(classSweepRetryFeedback(state, { stage: "spec", gate: "spec-review" })).toEqual([]);
		recordConvergenceFindings(state, [{ id: "S-1", title: "one", detail: "d", severity: "high", blocking: true, defectClass: "solo-class" }], { detectedAtStage: "spec" });
		expect(classSweepRetryFeedback(state, { stage: "spec", gate: "spec-review" })).toEqual([]);
	});

	it("qualifies at 2 findings of the same class and names the class + instance count", () => {
		const state = bareState();
		recordConvergenceFindings(state, [
			{ id: "D07-F08", title: "stage-<id>.report.md rejected", detail: "d", severity: "high", blocking: true, defectClass: "pattern-rejects-registry-keys" },
			{ id: "D07-F10", title: "<id>:<ticker> colons rejected", detail: "d", severity: "high", blocking: true, defectClass: "pattern-rejects-registry-keys" },
			{ id: "OTHER-1", title: "unrelated", detail: "d", severity: "high", blocking: true, defectClass: "different-class" },
		], { detectedAtStage: "design" });
		const directives = classSweepRetryFeedback(state, { stage: "design", gate: "design-review" });
		expect(directives).toHaveLength(1);
		const text = JSON.stringify(directives[0]);
		expect(text).toContain("pattern-rejects-registry-keys");
		expect(text).toContain("SWEEP THE CLASS");
		expect(text).toContain("2 recorded finding");
		expect(text).toContain("enumerate ALL sibling sites");
	});

	it("qualifies on ONE finding re-seen (seenCount ≥ 2) — recurrence without a second id", () => {
		const state = bareState();
		for (let i = 0; i < 2; i++) {
			recordConvergenceFindings(state, [{ id: "R-9", title: "recurring", detail: "d", severity: "high", blocking: true, defectClass: "re-seen-class" }], { detectedAtStage: "spec" });
		}
		const directives = classSweepRetryFeedback(state, { stage: "spec", gate: "spec-review" });
		expect(directives).toHaveLength(1);
		expect(JSON.stringify(directives[0])).toContain("re-seen-class");
	});
});

describe("F3/F1: reviewer prompts carry the rubric + defectClass duty", () => {
	it("buildUpstreamReviewPrompt (design) includes the calibration bar, P0–P3, gate ownership, and the defectClass duty", () => {
		const p = buildUpstreamReviewPrompt(setupCtl(), null, { stage: "design", upstream: [{ label: "Requirements", path: "01-requirements.md" }] });
		expect(p).toContain("Finding quality bar (calibration)");
		expect(p).toContain("P0 (assumption-free defect that breaks implementation outright)");
		expect(p).toContain("Zero findings is a valid, respected outcome");
		expect(p).toContain("Deterministic gates already own");
		expect(p).toContain("defectClass");
		expect(p).toContain("generalization rule");
	});

	it("buildSpecReviewPrompt includes the same rubric block and duty line", () => {
		const p = buildSpecReviewPrompt(setupCtl(), null, { specificationPath: "x" } as ControlObj);
		expect(p).toContain("Finding quality bar (calibration)");
		expect(p).toContain("defectClass");
		expect(p).toContain("Deterministic gates already own");
	});

	it("both reviewer data-to-return contracts list defectClass and confidence", () => {
		const p1 = buildUpstreamReviewPrompt(setupCtl(), null, { stage: "requirements", upstream: [] });
		const p2 = buildSpecReviewPrompt(setupCtl(), null, {} as ControlObj);
		for (const p of [p1, p2]) {
			expect(p).toContain("priorFindingId?, defectClass?, confidence?");
		}
	});
});

describe("F2: derivation standing rule in design/spec writer prompts", () => {
	it("buildDesignPrompt carries the derive-from-registry + enumerated-closure-table rule (v0.3.2 merged it into the contracts-block paragraph)", () => {
		const p = buildDesignPrompt(setupCtl(), null, "design the thing", { docPath: "01.md" } as ControlObj, null, null, "architect");
		expect(p).toContain("derived from the actual source");
		expect(p).toContain("enumerated closure");
		expect(p).toContain("derive, never hand-write");
	});
	it("buildSpecPrompt carries the same rule", () => {
		const p = buildSpecPrompt(setupCtl(), null, "spec the thing", { docPath: "01.md" } as ControlObj, { docPath: "02.md" } as ControlObj, null, null, null);
		expect(p).toContain("DERIVED from the actual registry/source");
	});
});

describe("F4: implementer/fixer worktree discipline", () => {
	const phase = { name: "P1", description: "d", deliverables: {} };
	it("buildImplementPrompt forbids reverting foreign changes and demands naming blockers", () => {
		const p = buildImplementPrompt(setupCtl(), null, phase, null, {} as ControlObj);
		expect(p).toContain("Worktree discipline");
		expect(p).toContain("NEVER revert or delete changes you did not make");
	});
	it("buildFixPrompt carries the same discipline", () => {
		const p = buildFixPrompt(setupCtl(), null, [{ id: "F-1", title: "t" }]);
		expect(p).toContain("Worktree discipline");
		expect(p).toContain("NEVER revert or delete changes you did not make");
	});
});

// The loop-level sweep-injection pin runs through the real spec-convergence
// node (same harness pattern as tests/spec-convergence.test.ts).
import { EventEmitter } from "node:events";
import { specConvergenceNode } from "../src/stages/spec-convergence.ts";
import { runHelper } from "../src/helpers.ts";
import { renderRetryFeedbackBlock, type RetryFeedbackInput } from "../src/retry-feedback.ts";
import type { AgentCall, AgentResult, HelperCall, StageContext } from "../src/types.ts";
import { mkdirSync, writeFileSync } from "node:fs";

function seedDocs(s: SetupControl) {
	mkdirSync(s.specDirectory, { recursive: true });
	writeFileSync(`${s.specDirectory}01-requirements.md`, [
		"# Requirements",
		"## Executive Summary",
		"Build the feature with explicit traceability. " + "details ".repeat(30),
		"## Acceptance Criteria",
		"- AC-01: primary behavior works",
		"- AC-02: edge behavior works",
		"## Non-Functional Requirements",
		"Keep the implementation testable.",
	].join("\n"));
	writeFileSync(`${s.specDirectory}02-bdd-scenarios.md`, [
		"# BDD Scenarios",
		"### SCENARIO-001: primary behavior",
		"**Given** AC-01 setup",
		"**When** the feature runs",
		"**Then** AC-01 is satisfied",
		"References: AC-01",
		"### SCENARIO-002: edge behavior",
		"**Given** AC-02 setup",
		"**When** the edge case runs",
		"**Then** AC-02 is satisfied",
		"References: AC-02",
	].join("\n"));
}

function specControlOk(): ControlObj {
	return {
		title: "Feature Spec",
		date: "2026-08-20",
		summary: "A complete specification. " + "summary ".repeat(35),
		architecture: "Use the existing architecture and preserve module boundaries. " + "architecture ".repeat(25),
		testingStrategy: "Unit tests and integration tests cover each mapped scenario. " + "testing ".repeat(20),
		acceptanceCriteriaRefs: ["AC-01", "AC-02"],
		scenarioRefs: ["SCENARIO-001", "SCENARIO-002"],
		phases: [{ name: "Implementation", description: "Implement and test the behavior.", scenarioRefs: ["SCENARIO-001", "SCENARIO-002"], deliverables: { requireScenarios: ["SCENARIO-001", "SCENARIO-002"] } }],
		tasks: [{ phase: "Implementation", description: "Implement behavior.", scenarioRefs: ["SCENARIO-001", "SCENARIO-002"] }],
	};
}

describe("F1 loop-level: the sweep directive reaches the writer on the 2nd class instance", () => {
	it("round-3 writer feedback contains SWEEP THE CLASS after two same-class rejections", async () => {
		const dir = mkdtempSync(join(tmpdir(), "sd-sweep-"));
		try {
			const s = setupCtl(dir);
			seedDocs(s);
			const state: PipelineState = { setup: s, classify: { taskType: "feature", uiScope: "none", language: "backend", isWebUi: false } };
			const seen: RetryFeedbackInput[][] = [];
			const dims = ["Completeness", "Consistency", "Feasibility", "Testability", "Traceability", "Grounding", "Complexity", "Ambiguity"];
			const reject = (id: string, title: string): ControlObj => ({
				title: "Spec Review", date: "2026-08-20", verdict: "Changes Requested", summary: "Rejected.",
				findings: [{ id, severity: "high", title, detail: `${title} — the pattern rejects this family too.`, ownerStage: "spec", blocking: true, status: "open", recommendation: "Fix the derivation rule.", defectClass: "pattern-rejects-registry-keys" }],
				dimensions: dims.map((name) => ({ name, status: "fail", notes: "n" })),
			});
			const approve: ControlObj = { title: "Spec Review", date: "2026-08-20", verdict: "Approved", summary: "ok", findings: [], dimensions: dims.map((name) => ({ name, status: "pass", notes: "n" })) };
			let specCalls = 0;
			let reviewCalls = 0;
			const stageCtx: StageContext = {
				task: "implement feature",
				options: {},
				state,
				budget: { count: 0, check: () => true, spent() { this.count++; return true; } },
				log() {}, phase() {},
				events: new EventEmitter(),
				results: [],
				async agent(call: AgentCall): Promise<AgentResult> {
					if (call.agent === "spec-writer") {
						const fb = ((state as Record<string, unknown>).__feedback as Record<string, RetryFeedbackInput[]> | undefined)?.spec ?? [];
						seen.push([...fb]);
						specCalls++;
						return { text: "", control: specControlOk() };
					}
					if (call.agent === "spec-reviewer") {
						reviewCalls++;
						return { text: "", control: [reject("D07-F08", "stage report filename rejected"), reject("D07-F10", "colon ids rejected"), approve][Math.min(reviewCalls - 1, 2)] };
					}
					throw new Error(`unexpected agent ${call.agent}`);
				},
				async helper(call: HelperCall) { return runHelper(call); },
				async parallel(calls) { return Promise.all(calls.map((call) => call())); },
			};
			const result = await specConvergenceNode.run(state, stageCtx);
			expect(result.status).toBe("ok");
			expect(seen.length).toBeGreaterThanOrEqual(3);
			// Round-2 feedback (before the 2nd instance is recorded) must NOT sweep…
			expect(renderRetryFeedbackBlock(seen[1])).not.toContain("SWEEP THE CLASS");
			// …and round-3 feedback (after the 2nd instance) MUST.
			expect(renderRetryFeedbackBlock(seen[2])).toContain("SWEEP THE CLASS");
			expect(renderRetryFeedbackBlock(seen[2])).toContain("pattern-rejects-registry-keys");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

// ── sd31 dual-review remediation pins ─────────────────────────────────────────
import { withOmissionNotice, renderRetryFeedbackItem } from "../src/retry-feedback.ts";

describe("sd31 remediation: sweep scoping, retirement, keep-first merge, truncation survival", () => {
	it("SD31-1/F-02: a design-stage class does NOT leak into the spec writer's sweep (stage scoping)", () => {
		const state = bareState();
		recordConvergenceFindings(state, [
			{ id: "D-1", title: "design filename rejected", detail: "d", severity: "high", blocking: true, defectClass: "pattern-rejects-registry-keys" },
			{ id: "D-2", title: "design colon ids rejected", detail: "d", severity: "high", blocking: true, defectClass: "pattern-rejects-registry-keys" },
		], { detectedAtStage: "designReview" });
		expect(classSweepRetryFeedback(state, { stage: "spec", gate: "spec-review" })).toEqual([]);
		const designDirectives = classSweepRetryFeedback(state, { stage: "design", gate: "design-review" });
		expect(designDirectives).toHaveLength(1);
	});

	it("SD31-2/F-04: a class whose every member is verified RETIRES (no directive); one open member keeps it sweepable", () => {
		const state = bareState();
		recordConvergenceFindings(state, [
			{ id: "V-1", title: "t1", detail: "d", severity: "high", blocking: true, status: "verified", defectClass: "swept-class" },
			{ id: "V-2", title: "t2", detail: "d", severity: "high", blocking: false, status: "verified", defectClass: "swept-class" },
			{ id: "O-1", title: "t3", detail: "d", severity: "high", blocking: true, defectClass: "live-class" },
			{ id: "O-2", title: "t4", detail: "d", severity: "high", blocking: true, status: "verified", defectClass: "live-class" },
		], { detectedAtStage: "specReview" });
		const directives = classSweepRetryFeedback(state, { stage: "spec", gate: "spec-review" });
		expect(directives).toHaveLength(1);
		expect(JSON.stringify(directives[0])).toContain("live-class");
		expect(JSON.stringify(directives[0])).not.toContain("swept-class");
	});

	it("SD31-5: a re-record filing a DIFFERENT class name never renames the row (keep-first)", () => {
		const state = bareState();
		recordConvergenceFindings(state, [{ id: "K-1", title: "same", detail: "same", severity: "high", blocking: true, defectClass: "first-class" }], { detectedAtStage: "spec" });
		recordConvergenceFindings(state, [{ id: "K-1", title: "same", detail: "same", severity: "high", blocking: true, defectClass: "renamed-class" }], { detectedAtStage: "spec" });
		const row = getConvergenceLedger(state).findings.find((f) => f.title === "same");
		expect(row?.defectClass).toBe("first-class");
	});

	it("F-03: the non-spec directive names a channel the writer actually has", () => {
		const state = bareState();
		recordConvergenceFindings(state, [
			{ id: "C-1", title: "a", detail: "d", severity: "high", blocking: true, defectClass: "cc" },
			{ id: "C-2", title: "b", detail: "d", severity: "high", blocking: true, defectClass: "cc" },
		], { detectedAtStage: "designReview" });
		const designDirective = JSON.stringify(classSweepRetryFeedback(state, { stage: "design", gate: "design-review" }));
		expect(designDirective).toContain("state the full enumeration explicitly in your document");
	});

	it("SD31-3/F-01: the truncation announcement survives the assembly slice AND the render cap", () => {
		const findings = Array.from({ length: 10 }, (_, i) => ({ id: `F-${i}`, severity: "high", title: `Defect ${i}`, detail: "d" }));
		const errors = compactSpec(reviewWithFindings(findings));
		const notice = errors.find((l) => l.includes("more findings omitted"));
		expect(notice).toBeDefined();
		const missing = withOmissionNotice(errors.slice(0, 8), errors);
		expect(missing).toContain(notice);
		// and the render layer keeps a 9th (notice) line visible instead of folding it into "+1 more"
		const rendered = renderRetryFeedbackItem({ stage: "spec", gate: "spec-review", observed: "o", expected: "e", missing, nextAction: "n" });
		expect(rendered).toContain("more findings omitted");
	});
});
