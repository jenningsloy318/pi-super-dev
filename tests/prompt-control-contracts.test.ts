/**
 * Per-prompt control-key contract tests (Fix 2a).
 *
 * Root-cause guard for the v0.1.52 stagnation recurrence: the implementer's
 * `testDefects` challenge channel was unreachable because
 * extractControlKeys comma-split INSIDE the key's annotation shape, dropped the
 * fragment carrying `testDefects`, and leaked `lines` as a phantom key. The
 * v0.1.51 integration tests never caught it because they injected structured
 * testDefects directly into the mocked control — bypassing the prompt↔parser
 * seam entirely.
 *
 * These tests pin the EXACT extracted key set for EVERY build*Prompt that ends
 * with a control line, so the prompt text and the parser can never drift apart
 * silently again. The implementer case additionally asserts parity with the
 * call-site IMPLEMENTER_CONTROL_KEYS (Fix 1a).
 */
import { describe, it, expect } from "vitest";
import {
	buildClassifyPrompt,
	buildRequirementsPrompt,
	buildBddPrompt,
	buildResearchPrompt,
	buildDebugPrompt,
	buildAssessmentPrompt,
	buildDesignPrompt,
	buildPrototypePrompt,
	buildSpecPrompt,
	buildUpstreamReviewPrompt,
	buildSpecReviewPrompt,
	buildTddPrompt,
	buildRedReviewPrompt,
	buildImplementPrompt,
	buildQaPrompt,
	buildImplementationSummaryPrompt,
	buildCodeReviewPrompt,
	buildAdversarialPrompt,
	buildTestsReviewPrompt,
	buildJudgePrompt,
	buildFixPrompt,
	buildUiTestPrompt,
	buildApiTestPrompt,
	buildDocsPrompt,
	buildMergePrompt,
} from "../src/prompts.ts";
import { extractControlKeys } from "../src/control.ts";
import type { SetupControl } from "../src/types.ts";

function mkSetup(language = "frontend"): SetupControl {
	return {
		worktreePath: "/tmp/repo",
		specDirectory: "/tmp/repo/specs/",
		defaultBranch: "main",
		language,
		isWebUi: false,
		specIdentifier: "control-contract",
		worktreeCreated: true,
		initializedRepo: false,
	};
}

const s = mkSetup();

/** Assert the extracted key set for a built prompt equals the intended set. */
function expectKeys(prompt: string, keys: string[]): void {
	expect(extractControlKeys(prompt)).toEqual(keys);
}

describe("control-key contracts: every build*Prompt ↔ extractControlKeys (Fix 2a)", () => {
	it("buildClassifyPrompt", () => {
		expectKeys(buildClassifyPrompt(s, "do a thing"), ["taskType", "uiScope", "rationale"]);
	});

	it("buildRequirementsPrompt", () => {
		expectKeys(buildRequirementsPrompt(s, null, "task"), [
			"title", "date", "type", "priority", "executiveSummary", "acceptanceCriteria", "nonFunctional", "openQuestions",
		]);
	});

	it("buildBddPrompt", () => {
		expectKeys(buildBddPrompt(s, null, "task", null), ["title", "date", "source", "features", "traceability"]);
	});

	it("buildResearchPrompt", () => {
		expectKeys(buildResearchPrompt(s, null, "task", null, null, null), ["title", "date", "summary", "options", "sources", "openIssues"]);
	});

	it("buildDebugPrompt", () => {
		expectKeys(buildDebugPrompt(s, null, "task", null, null), ["title", "date", "summary", "hypotheses", "rootCause", "reproductionSteps"]);
	});

	it("buildAssessmentPrompt", () => {
		expectKeys(buildAssessmentPrompt(s, null, "task", null, null), [
			"title", "date", "summary", "patterns", "recommendations", "filesAssessed", "services",
		]);
	});

	it("buildDesignPrompt — bracket shape [{name, description}] stripped whole, no phantom `name`/`description` keys", () => {
		expectKeys(buildDesignPrompt(s, null, "task", null, null, null, "designer"), [
			"title", "date", "summary", "designer", "modules", "hasNumericConstants",
		]);
	});

	it("buildPrototypePrompt", () => {
		expectKeys(buildPrototypePrompt(s, null, "task", null, [], 1, null), ["title", "date", "summary", "verdict", "measurements", "adjustments"]);
	});

	it("buildSpecPrompt", () => {
		expectKeys(buildSpecPrompt(s, null, "task", null, null, null, null, null, null), [
			"title", "date", "summary", "architecture", "testingStrategy", "acceptanceCriteriaRefs", "scenarioRefs", "phases", "tasks", "reviewResponses", "gate",
		]);
	});

	it("buildUpstreamReviewPrompt", () => {
		expectKeys(buildUpstreamReviewPrompt(s, null, { stage: "requirements", upstream: [] }), [
			"title", "date", "verdict", "summary", "findings", "priorFindingResolutions", "dimensions",
		]);
	});

	it("buildSpecReviewPrompt", () => {
		expectKeys(buildSpecReviewPrompt(s, null, null), [
			"title", "date", "verdict", "summary", "findings", "priorFindingResolutions", "dimensions",
		]);
	});

	it("buildTddPrompt", () => {
		expectKeys(buildTddPrompt(s, null, { name: "p" }, null), ["testsWritten", "testFiles", "allFailing", "summary"]);
	});

	it("buildRedReviewPrompt", () => {
		expectKeys(buildRedReviewPrompt(s, null, { name: "p" }, ["tests/a.test.ts"], [], null, null), ["verdict", "summary", "contradictions"]);
	});

	it("buildImplementPrompt — testDefects present, NO phantom `lines` (the v0.1.52 regression)", () => {
		const prompt = buildImplementPrompt(s, null, { name: "p" }, null, null);
		const keys = extractControlKeys(prompt);
		expect(keys).toEqual(["filesCreated", "filesModified", "filesDeleted", "testsPassCount", "summary", "testDefects"]);
		expect(keys).not.toContain("lines");
	});

	it("buildQaPrompt", () => {
		expectKeys(buildQaPrompt(s, null, { name: "p" }), ["allTestsPass", "buildSuccess", "coveragePercent", "regressions", "summary"]);
	});

	it("buildImplementationSummaryPrompt", () => {
		expectKeys(buildImplementationSummaryPrompt(s, null, null), ["title", "date", "summary", "phasesCompleted", "allGreen", "filesModified"]);
	});

	it("buildCodeReviewPrompt", () => {
		expectKeys(buildCodeReviewPrompt(s, null, "task", null, null), ["title", "date", "verdict", "summary", "findings"]);
	});

	it("buildAdversarialPrompt", () => {
		expectKeys(buildAdversarialPrompt(s, null, "task", null, null), ["title", "date", "verdict", "summary", "findings"]);
	});

	it("buildTestsReviewPrompt (R-2 tests/validation angle)", () => {
		expectKeys(buildTestsReviewPrompt(s, null, "task", null, null), ["title", "date", "verdict", "summary", "findings"]);
	});

	it("buildJudgePrompt (LLM judge routing layer)", () => {
		expectKeys(buildJudgePrompt("scope", "context", ["re-author-tests", "escalate-now"]), ["diagnosis", "route", "confidence", "evidence"]);
	});

	it("buildFixPrompt", () => {
		expectKeys(buildFixPrompt(s, null, [], []), ["filesCreated", "filesModified", "filesDeleted", "fixesApplied", "summary"]);
	});

	it("buildUiTestPrompt — {flow, reason} shape stripped whole", () => {
		expectKeys(buildUiTestPrompt(s, null, null, { baseUrl: "http://x" }), ["pass", "flows", "failures", "summary"]);
	});

	it("buildApiTestPrompt — {method, path, reason} shape stripped whole", () => {
		expectKeys(buildApiTestPrompt(s, null, null, { baseUrl: "http://x" }), ["pass", "cases", "failures", "summary"]);
	});

	it("buildDocsPrompt", () => {
		expectKeys(buildDocsPrompt(s, null, "task", null), ["title", "date", "summary", "docsUpdated", "deviationsDocumented"]);
	});

	it("buildMergePrompt", () => {
		expectKeys(buildMergePrompt(s), ["merged", "commitSha", "mergeCommand", "summary"]);
	});
});

describe("control-key contracts: call-site parity (Fix 1a)", () => {
	it("the implementer call-site contract and the prompt control line extract the SAME keys", () => {
		// IMPLEMENTER_CONTROL_KEYS is module-private in implementation.ts; the
		// call site is the authoritative consumer. Mirror the literal here and
		// assert parity with the built prompt (they must never drift apart).
		const callSiteKeys = ["filesCreated", "filesModified", "filesDeleted", "testsPassCount", "summary", "testDefects"];
		const prompt = buildImplementPrompt(s, null, { name: "p" }, null, null);
		expect(extractControlKeys(prompt)).toEqual(callSiteKeys);
		// The challenge key must survive BOTH paths (v0.1.52: neither had it).
		expect(extractControlKeys(prompt)).toContain("testDefects");
	});
});

describe("extractControlKeys parser hardening (Fix 1e / 2b)", () => {
	it("the EXACT v0.1.52 implementer control line yields the full set including testDefects, no phantom lines", () => {
		const v52Line = "Output <control> JSON with: filesCreated (array), filesModified (array), filesDeleted (array), testsPassCount (number), summary, testDefects (optional array of {testFile, lines, reason} — emit ONLY when you have proven a confirmed RED test is unsatisfiable; omit otherwise).";
		expect(extractControlKeys(v52Line)).toEqual(["filesCreated", "filesModified", "filesDeleted", "testsPassCount", "summary", "testDefects"]);
	});

	it("commas inside parens, braces, and nested combos do not split keys", () => {
		expect(extractControlKeys("Output <control> JSON with: a (see {x, y} note), b (plain), c.")).toEqual(["a", "b", "c"]);
		expect(extractControlKeys("Output <control> JSON with: findings (array of {id, severity, title}) — report each.")).toEqual(["findings"]);
	});

	it("mid-line periods no longer truncate the key list (old [^\\n.]+ bug)", () => {
		expect(extractControlKeys("Output <control> JSON with: a, b.g. note here, c.")).toEqual(["a", "c"]); // b.g. note here → unparseable, dropped+logged
	});

	it("unbalanced paren annotation: the leading identifier is RESCUED (v0.1.52 would have dropped it) and the drift is logged", () => {
		const warned: string[] = [];
		const orig = console.warn;
		console.warn = (msg: string) => warned.push(String(msg));
		try {
			// The exact v0.1.52 shape: the naive comma-split left testDefects on a
			// fragment with an unclosed paren and DROPPED it. The hardened parser
			// keeps the segment whole and rescues the key.
		const keys = extractControlKeys("Output <control> JSON with: ok, broken (unclosed.");
			expect(keys).toEqual(["ok", "broken"]);
			expect(warned.some((w) => w.includes("unbalanced parentheses"))).toBe(true);
		} finally {
			console.warn = orig;
		}
	});

	it("empty/whitespace and identifier-invalid fragments are filtered", () => {
		expect(extractControlKeys("Output <control> JSON with: , , 123bad, good.")).toEqual(["good"]);
		// attached hyphen/period junk still rejects (no silent repair)
		expect(extractControlKeys("Output <control> JSON with: good-key, other.key.")).toEqual([]);
	});
});
