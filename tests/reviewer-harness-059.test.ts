/**
 * 059 R2 / D-R-D (Wave 4 — v0.4.1 candidate): deterministic pins for the
 * OFFLINE reviewer-measurement harness (src/eval/reviewer-harness.ts):
 *   - the PURE attribution scorer: hit / miss / partial-locus (file-only) /
 *     out-of-range line tolerance / pinId-ref arm / file:line prose fallback;
 *   - the DEC-6 no-verdict-agreement property (a verdict-only "catch" scores
 *     zero — the verdict field is never read);
 *   - fixture-corpus sanity: every fixture's planted locus exists as a REAL
 *     extractor pin in its own materialized tree;
 *   - escape-rate aggregation math;
 *   - the runner renders reviewer prompts via the LANDED builders with the
 *     injected slice (deterministic, NO live-LLM calls — 059 §5 D-R-D).
 */

import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractContractInventory } from "../src/review/contract-surface/index.ts";
import {
	CONTRADICTION_FIXTURES,
	aggregateEscapeRate,
	fixturePlantedLocusPresent,
	findingCoversPlantedLocus,
	materializeContradictionFixture,
	prepareReviewerHarnessCase,
	reviewerHarnessRows,
	REVIEWER_HARNESS_LINE_TOLERANCE,
	scoreReviewerResponse,
} from "../src/eval/reviewer-harness.ts";

const PLANTED = { file: "docs/specifications/14-industry-momentum-dimension/01-requirements.md", line: 10 };
const PLANTED_WITH_PIN = { ...PLANTED, pinId: "pin-xn-0000abc" };

// ─── scorer unit tests (PURE — the DEC-6 oracle) ─────────────────────────────

describe("059 R2 — finding-level attribution scorer", () => {
	it("HIT: a structured evidenceLocus on the planted file at the planted line catches", () => {
		expect(findingCoversPlantedLocus({ evidenceLoci: [{ file: PLANTED.file, line: 10 }] }, PLANTED)).toBe(true);
	});

	it("HIT: a line cite within the tolerance window still attributes (LLM line drift)", () => {
		expect(findingCoversPlantedLocus({ evidenceLoci: [{ file: PLANTED.file, line: 10 + REVIEWER_HARNESS_LINE_TOLERANCE }] }, PLANTED)).toBe(true);
		expect(findingCoversPlantedLocus({ evidenceLoci: [{ file: PLANTED.file, line: 10 - REVIEWER_HARNESS_LINE_TOLERANCE }] }, PLANTED)).toBe(true);
	});

	it("A5 slice-grounding: a planted pinId absent from the injected slice can NEVER score (truncation/leakage guard)", () => {
		const finding = { title: "conflict", detail: `contradicts pin ${PLANTED_WITH_PIN.pinId}`, blocking: true };
		// No slice supplied (legacy callers): pinId coverage stands.
		expect(scoreReviewerResponse({ findings: [finding] }, PLANTED_WITH_PIN).caught).toBe(true);
		// Pin NOT in the injected slice (truncated / drifted): hallucinated or
		// leaked pinId citations score a MISS — the reviewer never saw it.
		expect(scoreReviewerResponse({ findings: [finding] }, PLANTED_WITH_PIN, REVIEWER_HARNESS_LINE_TOLERANCE, new Set(["pin-other-1"])).caught).toBe(false);
		// Pin IN the slice: the citation is legitimate and scores.
		expect(scoreReviewerResponse({ findings: [finding] }, PLANTED_WITH_PIN, REVIEWER_HARNESS_LINE_TOLERANCE, new Set(["pin-other-1", PLANTED_WITH_PIN.pinId!])).caught).toBe(true);
		// The structured ref arm is grounded too (same early-return guard).
		const refFinding = { title: "conflict", detail: "see pin", blocking: true, evidenceLoci: [{ ref: PLANTED_WITH_PIN.pinId }] };
		expect(scoreReviewerResponse({ findings: [refFinding] }, PLANTED_WITH_PIN, REVIEWER_HARNESS_LINE_TOLERANCE, new Set(["pin-other-1"])).caught).toBe(false);
		expect(scoreReviewerResponse({ findings: [refFinding] }, PLANTED_WITH_PIN, REVIEWER_HARNESS_LINE_TOLERANCE, new Set([PLANTED_WITH_PIN.pinId!])).caught).toBe(true);
		// The file:line arm is grounded too — without the pin in the slice even
		// an exact file:line cite of the planted locus is a miss.
		const locFinding = { title: "conflict", detail: "see docs", blocking: true, evidenceLoci: [{ file: PLANTED_WITH_PIN.file, line: 10 }] };
		expect(scoreReviewerResponse({ findings: [locFinding] }, PLANTED_WITH_PIN, REVIEWER_HARNESS_LINE_TOLERANCE, new Set(["pin-other-1"])).caught).toBe(false);
		expect(scoreReviewerResponse({ findings: [locFinding] }, PLANTED_WITH_PIN, REVIEWER_HARNESS_LINE_TOLERANCE, new Set([PLANTED_WITH_PIN.pinId!])).caught).toBe(true);
	});

	it("OUT-OF-RANGE: a line cite beyond the tolerance window does NOT catch", () => {
		expect(findingCoversPlantedLocus({ evidenceLoci: [{ file: PLANTED.file, line: 10 + REVIEWER_HARNESS_LINE_TOLERANCE + 1 }] }, PLANTED)).toBe(false);
		expect(findingCoversPlantedLocus({ evidenceLoci: [{ file: PLANTED.file, line: 3 }] }, PLANTED)).toBe(false);
	});

	it("PARTIAL LOCUS: file-only coverage (no line, no pinId) does NOT catch — fail-closed attribution", () => {
		expect(findingCoversPlantedLocus({ evidenceLoci: [{ file: PLANTED.file }, { file: "tests/other.test.ts", line: 1 }] }, PLANTED)).toBe(false);
	});

	it("MISS: loci on a different file do not catch", () => {
		expect(findingCoversPlantedLocus({ evidenceLoci: [{ file: "tests/unrelated.test.ts", line: 10 }, { file: "docs/other.md", line: 10 }] }, PLANTED)).toBe(false);
	});

	it("HIT (pinId arm): an evidenceLocus ref equal to the planted pinId catches even off-file", () => {
		expect(findingCoversPlantedLocus({ evidenceLoci: [{ file: "src/schemas.ts", line: 1, ref: "pin-xn-0000abc" }] }, PLANTED_WITH_PIN)).toBe(true);
		// a ref that is NOT the planted pinId contributes nothing
		expect(findingCoversPlantedLocus({ evidenceLoci: [{ file: "src/schemas.ts", line: 1, ref: "pin-pe-other" }] }, PLANTED_WITH_PIN)).toBe(false);
	});

	it("HIT (prose fallback): an explicit file:line mention in the finding detail catches", () => {
		expect(findingCoversPlantedLocus({ title: "pin conflict", detail: `contradicts the pin at ${PLANTED.file}:10` }, PLANTED)).toBe(true);
		expect(findingCoversPlantedLocus({ title: "pin conflict", detail: `cites ${PLANTED_WITH_PIN.pinId} from the sibling spec` }, PLANTED_WITH_PIN)).toBe(true);
		// prose naming only the file (no line, no pinId) is a partial locus — miss
		expect(findingCoversPlantedLocus({ title: "pin conflict", detail: `see ${PLANTED.file}` }, PLANTED)).toBe(false);
	});

	it("numeric-string lines are tolerated like numeric lines", () => {
		expect(findingCoversPlantedLocus({ evidenceLoci: [{ file: PLANTED.file, line: "11" }] }, PLANTED)).toBe(true);
	});

	it("junk evidenceLoci rows (non-objects / arrays / non-string files) are skipped without throwing", () => {
		expect(findingCoversPlantedLocus({ evidenceLoci: [null, 42, ["docs/x.md"], { file: 7, line: 10 }, { file: `./${PLANTED.file}`, line: 10 }] }, PLANTED)).toBe(true); // the "./"-prefixed normalized locus still hits
		expect(findingCoversPlantedLocus({ evidenceLoci: [null, 42, ["docs/x.md"], { file: 7, line: 10 }] }, PLANTED)).toBe(false);
	});
});

// ─── DEC-6: never verdict-agreement ──────────────────────────────────────────

describe("059 R2 — DEC-6 no-verdict-agreement pin", () => {
	it("a verdict-only \"catch\" scores ZERO: Changes Requested with no attributable finding is an escape", () => {
		const res = scoreReviewerResponse(
			{ verdict: "Changes Requested", findings: [{ id: "F-1", severity: "high", title: "naming drift", detail: "inconsistent verb tense", blocking: true }] },
			PLANTED,
		);
		expect(res.caught).toBe(false);
		expect(res.catchingFindings).toEqual([]);
	});

	it("the verdict field is never read: identical findings under opposite verdicts score identically", () => {
		const findings = [{ id: "F-1", severity: "high", blocking: true, detail: `contradicts ${PLANTED.file}:10`, evidenceLoci: [{ file: PLANTED.file, line: 10 }] }];
		const rejected = scoreReviewerResponse({ verdict: "Changes Requested", findings }, PLANTED);
		const approved = scoreReviewerResponse({ verdict: "Approved", findings }, PLANTED);
		expect(rejected).toEqual(approved);
		expect(rejected.caught).toBe(true);
		expect(rejected.catchingFindings).toEqual([0]);
	});

	it("059 §3 R5: only a BLOCKING finding catches — an advisory (blocking:false) finding citing the locus does not", () => {
		const advisory = { id: "F-1", severity: "medium", blocking: false, detail: `contradicts ${PLANTED.file}:10`, evidenceLoci: [{ file: PLANTED.file, line: 10 }] };
		expect(scoreReviewerResponse({ verdict: "Changes Requested", findings: [advisory] }, PLANTED).caught).toBe(false);
		// the same finding with blocking=true catches (the coverage geometry is unchanged — only the blocking gate differs)
		expect(scoreReviewerResponse({ verdict: "Changes Requested", findings: [{ ...advisory, blocking: true }] }, PLANTED).caught).toBe(true);
		// the landed high-severity fallback still blocks without an explicit flag
		expect(scoreReviewerResponse({ verdict: "Changes Requested", findings: [{ ...advisory, blocking: undefined, severity: "high" }] }, PLANTED).caught).toBe(true);
	});

	it("the scorer reports WHICH findings caught (attribution evidence, not a bare boolean)", () => {
		const res = scoreReviewerResponse(
			{
				verdict: "Changes Requested",
				findings: [
					{ id: "F-1", blocking: true, detail: "unrelated" },
					{ id: "F-2", blocking: true, evidenceLoci: [{ file: PLANTED.file, line: 10 }] },
					{ id: "F-3", blocking: true, evidenceLoci: [{ file: PLANTED.file, line: 12 }] },
				],
			},
			PLANTED,
		);
		expect(res.caught).toBe(true);
		expect(res.catchingFindings).toEqual([1, 2]);
	});
});

// ─── fixture corpus sanity (deterministic) ───────────────────────────────────

describe("059 R2 — golden-contradiction fixture corpus sanity", () => {
	it("the corpus is the closed 3-fixture v1 set (SCENARIO-014 shape + two sibling variants)", () => {
		expect(CONTRADICTION_FIXTURES.map((f) => f.id)).toEqual([
			"scenario-014-ac-vs-exactly-n",
			"porcelain-untouched-vs-bdd-edit",
			"no-xth-closure-vs-spec-phase",
		]);
	});

	it("every fixture's planted locus exists as a REAL active pin in its own materialized tree", () => {
		for (const fixture of CONTRADICTION_FIXTURES) {
			const dir = mkdtempSync(join(tmpdir(), "sd-059-r2-fx-"));
			try {
				materializeContradictionFixture(fixture, dir);
				const check = fixturePlantedLocusPresent(fixture, extractContractInventory(dir));
				expect(check.problems).toEqual([]);
				expect(check.ok).toBe(true);
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		}
	});

	it("sanity FAILS honestly on a fixture whose planted file is absent from its tree (missing-file branch)", () => {
		const fixture = CONTRADICTION_FIXTURES[0]!;
		const check = fixturePlantedLocusPresent(
			{ ...fixture, plantedLocus: { file: "docs/specifications/missing/01-requirements.md", line: 3 } },
			{ protectedFiles: new Map(), unanchored: [], errors: [], scanLines: [], mapping: new Map(), concepts: new Set(), counts: { specArtifacts: 0, testFiles: 0 } },
		);
		expect(check.ok).toBe(false);
		expect(check.problems.some((p) => p.includes("docs/specifications/missing/01-requirements.md"))).toBe(true);
	});

	it("sanity FAILS honestly on a fixture whose planted locus is wrong (the invariant is not vacuous)", () => {
		const fixture = CONTRADICTION_FIXTURES[0]!;
		const dir = mkdtempSync(join(tmpdir(), "sd-059-r2-bad-"));
		try {
			materializeContradictionFixture(fixture, dir);
			const check = fixturePlantedLocusPresent({ ...fixture, plantedLocus: { file: fixture.plantedLocus.file, line: 99 } }, extractContractInventory(dir));
			expect(check.ok).toBe(false);
			expect(check.problems.some((p) => p.includes("line 99"))).toBe(true);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

// ─── escape-rate aggregation math ────────────────────────────────────────────

describe("059 R2 — escape-rate aggregation math", () => {
	it("caught/total drives both fractions: 2 of 3 caught ⇒ catchRate 2/3, escapeRate 1/3", () => {
		const agg = aggregateEscapeRate([{ caught: true }, { caught: true }, { caught: false }]);
		expect(agg.total).toBe(3);
		expect(agg.caught).toBe(2);
		expect(agg.catchRate).toBeCloseTo(2 / 3, 10);
		expect(agg.escapeRate).toBeCloseTo(1 / 3, 10);
	});

	it("all-caught ⇒ escapeRate 0; all-escaped ⇒ escapeRate 1", () => {
		expect(aggregateEscapeRate([{ caught: true }, { caught: true }]).escapeRate).toBe(0);
		expect(aggregateEscapeRate([{ caught: false }]).escapeRate).toBe(1);
	});

	it("empty corpus ⇒ 0/0/0 (no observations, no fabricated escape)", () => {
		expect(aggregateEscapeRate([])).toEqual({ total: 0, caught: 0, catchRate: 0, escapeRate: 0 });
	});
});

// ─── the runner (thin driver — landed builders, no LLM calls) ────────────────

describe("059 R2 — runner renders reviewer prompts via the landed builders", () => {
	it("fx-1 (SCENARIO-014 shape): the requirements-review prompt carries the injected slice with BOTH conflicting pins + the cross-check + duty lines", () => {
		const fixture = CONTRADICTION_FIXTURES[0]!;
		const dir = mkdtempSync(join(tmpdir(), "sd-059-r2-run-"));
		try {
			const prepared = prepareReviewerHarnessCase(fixture, dir);
			expect(prepared.slice.files).toContain("src/schemas.ts");
			expect(prepared.slice.pinIds.length).toBeGreaterThanOrEqual(2); // exactly-N membership + porcelain byte-untouched
			expect(prepared.prompt).toContain("## Contract Surface Slice — shared baseline pins this change may touch");
			expect(prepared.prompt).toContain(`@ ${fixture.plantedLocus.file}:3`);
			expect(prepared.prompt).toContain("exactly-n-membership");
			expect(prepared.prompt).toContain("porcelain-emptiness");
			expect(prepared.prompt).toContain("Cross-check every claim in the reviewed artifact against these pins; pinIds are grounded claims");
			expect(prepared.prompt).toContain("via intent-level affectsSharedSurfaces hints");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("fx-3 routes through buildSpecReviewPrompt and carries the D2 reconciliation duty line", () => {
		const fixture = CONTRADICTION_FIXTURES[2]!;
		const dir = mkdtempSync(join(tmpdir(), "sd-059-r2-spec-"));
		try {
			const prepared = prepareReviewerHarnessCase(fixture, dir);
			expect(prepared.slice.files).toContain("src/registry.ts");
			expect(prepared.prompt).toContain("## Specification to Review");
			expect(prepared.prompt).toContain("## Contract Surface Slice");
			expect(prepared.prompt).toContain("no-xth-closure");
			expect(prepared.prompt).toContain("D2 Consistency dimension is the cross-artifact obligation-consistency check");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("deterministic: same fixture + same tree ⇒ byte-identical prompt (no LLM, no clock)", () => {
		const fixture = CONTRADICTION_FIXTURES[1]!;
		const dir = mkdtempSync(join(tmpdir(), "sd-059-r2-det-"));
		try {
			const a = prepareReviewerHarnessCase(fixture, dir);
			const b = prepareReviewerHarnessCase(fixture, dir);
			expect(a.prompt).toBe(b.prompt);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("fail-closed: a pin-free fixture renders a prompt with NO slice section (both builder branches)", () => {
		for (const reviewer of ["requirements", "spec"] as const) {
			const dir = mkdtempSync(join(tmpdir(), "sd-059-r2-closed-"));
			try {
				const synthetic = {
					id: `synthetic-pin-free-${reviewer}`,
					description: "no baseline pins anywhere — nothing to inject",
					files: { "src/thing.ts": "export const x = 1;\n" },
					artifactText: "An ordinary task description with no shared-surface pins.",
					reviewer,
					plantedLocus: { file: "src/thing.ts", line: 1 },
				};
				const prepared = prepareReviewerHarnessCase(synthetic, dir);
				expect(prepared.slice.empty).toBe(true);
				expect(prepared.prompt).not.toContain("## Contract Surface Slice");
				expect(prepared.prompt).not.toContain("Cross-check every claim in the reviewed artifact against these pins");
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		}
	});
});

// ─── additive eval rows (data only) ──────────────────────────────────────────

describe("059 R2 — additive reviewer-harness eval rows", () => {
	it("shapes scorerKind \"reviewer-harness\" rows from attribution results (caught/escaped, confidence 1)", () => {
		const fixture = CONTRADICTION_FIXTURES[0]!;
		const rows = reviewerHarnessRows([
			{ fixture, result: { caught: true, catchingFindings: [0] } },
			{ fixture, result: { caught: false, catchingFindings: [] } },
		]);
		expect(rows).toEqual([
			{ caseId: "scenario-014-ac-vs-exactly-n", caseVersion: 1, verdict: "caught", confidence: 1, scorerKind: "reviewer-harness" },
			{ caseId: "scenario-014-ac-vs-exactly-n", caseVersion: 1, verdict: "escaped", confidence: 1, scorerKind: "reviewer-harness" },
		]);
	});
});
