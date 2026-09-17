/**
 * 059 R2 / D-R-D (§3 R5, §5 D-R-D — v0.4.1 candidate) — the OFFLINE
 * reviewer-measurement harness: golden-contradiction fixtures + a thin prompt
 * RUNNER + a PURE finding-level attribution SCORER.
 *
 * DEC-6 (amended, binding): coarse verdict-string agreement is REJECTED as the
 * oracle (false-agreement — the SCENARIO-014 contradiction survived 5+ review
 * gates that all "agreed"). A CATCH is a BLOCKING finding whose evidenceLoci
 * (or an explicit file:line pinId mention in its prose) covers the fixture's
 * KNOWN planted locus (059 §3 R5: "pass iff a blocking finding cites the
 * planted pinId/locus"). Rejection for unrelated reasons is a FAILURE —
 * exactly the CoVe-style closure that makes a "Changes Requested" verdict with
 * no attributable finding score ZERO.
 *
 * Layout (mirrors the landed eval-layer module conventions —
 * src/evolution/eval-stage.ts / eval-layer/index.ts, v0.3.89-91):
 *   - golden fixtures: INLINE, deterministic data (the SCENARIO-014 shape —
 *     an AC amendment conflicting with exactly-N membership pins + a porcelain
 *     byte-untouched pin — plus two sibling-shape variants);
 *   - RUNNER (prepareReviewerHarnessCase): materializes the fixture worktree,
 *     extracts the inventory, builds the injected slice, and renders the
 *     reviewer prompt via the LANDED builders — a thin driver. NO live-LLM
 *     dispatch happens in tests; the offline driver owns any real dispatch;
 *   - SCORER (findingCoversPlantedLocus / scoreReviewerResponse /
 *     aggregateEscapeRate): PURE — structured-loci attribution with a bounded
 *     line tolerance, a pinId-ref arm, a file:line prose fallback, and a
 *     deliberate file-only PARTIAL-locus miss (fail-closed attribution). The
 *     verdict field is never read;
 *   - reviewerHarnessRows: the additive `scorerKind: "reviewer-harness"` eval
 *     rows for σ-band tracking (DATA ONLY — the offline driver owns emission;
 *     the gate decision uses ATTRIBUTION, never these verdict strings; the
 *     in-pipeline eval layer is untouched, 059 §6 offline-by-design).
 *
 * Runs on every reviewer-prompt, validator, or grammar-table change (059 §3 R5).
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { buildContractSlice, extractContractInventory, type ContractInventory, type ContractSlice } from "../review/contract-surface/index.ts";
import { buildSpecReviewPrompt, buildUpstreamReviewPrompt } from "../prompts.ts";
import { reviewFindingBlocks } from "../review-findings.ts";
import type { Classification, SetupControl } from "../types.ts";

// ─── fixture corpus (deterministic, inline) ──────────────────────────────────

/** The KNOWN locus of a fixture's planted contradiction: the pinning statement
 *  the artifact's amendment conflicts with (repo-relative file + 1-based line,
 *  optionally the pinId when the driver knows it). */
export interface PlantedLocus {
	file: string;
	line: number;
	pinId?: string;
}

/** Which reviewer prompt the harness renders for the fixture. */
export type HarnessReviewer = "requirements" | "bdd" | "design" | "spec";

export interface ContradictionFixture {
	id: string;
	description: string;
	/** The synthetic worktree the extractor walks: repo-relative path → content. */
	files: Record<string, string>;
	/** The artifact text under review — carries the planted amendment whose
	 *  contradiction with a baseline pin has the KNOWN locus below. */
	artifactText: string;
	reviewer: HarnessReviewer;
	/** Where the contradiction lives (the pin the amendment conflicts with). */
	plantedLocus: PlantedLocus;
}

/** The RAW SCENARIO-014 porcelain shape (run 2026-09-13T03-24-15-047Z,
 *  tests/profitability-contract.test.ts:1837 lineage) — porcelain pathspec +
 *  byte-untouched message; the porcelain pin lands at line 6. */
const SCENARIO_014_PORCELAIN_TEST = [
	'import { execSync } from "node:child_process";',
	'import { expect, it } from "vitest";',
	"",
	'it("SCENARIO-014 the frozen contract holds", () => {',
	'\tconst dirty = execSync("git status --porcelain -- src/schemas.ts").toString();',
	'\texpect(dirty, "src/schemas.ts must stay byte-untouched").toBe("");',
	"});",
].join("\n");

/** fx-1 — the spec's named golden shape: an AC amendment moving a pinned
 *  exactly-14 membership baseline to 15 while the porcelain test freezes the
 *  same file byte-untouched (the exact class that survived 5+ review gates). */
const FX_1_SCENARIO_014: ContradictionFixture = {
	id: "scenario-014-ac-vs-exactly-n",
	description: "AC-05 amends the dimension registry to a 15th member while sibling specs pin exactly-14 membership and the porcelain suite freezes src/schemas.ts byte-untouched",
	files: {
		"src/schemas.ts": "export const DIMENSION_REGISTRY = [\n\t// 14 entries — membership pinned by sibling specs (13/14/20)\n];\n",
		"docs/specifications/14-industry-momentum-dimension/01-requirements.md": [
			"# Dimension 14 — Industry Momentum baseline",
			"",
			"The dimension registry in `src/schemas.ts` is pinned at exactly 14 members.",
			"",
		].join("\n"),
		"tests/profitability-contract.test.ts": SCENARIO_014_PORCELAIN_TEST,
	},
	artifactText: [
		"# Requirements — profitability dimension override",
		"",
		"AC-05: The dimension registry in src/schemas.ts gains a 15th member (profitability), moving the pinned baseline from exactly 14 members to 15.",
	].join("\n"),
	reviewer: "requirements",
	plantedLocus: { file: "docs/specifications/14-industry-momentum-dimension/01-requirements.md", line: 3 },
};

/** fx-2 — porcelain-only variant: a BDD scenario edits the frozen file while
 *  the porcelain suite holds it byte-untouched (planted locus = the test pin). */
const FX_2_PORCELAIN_VS_EDIT: ContradictionFixture = {
	id: "porcelain-untouched-vs-bdd-edit",
	description: "SCENARIO-041 asserts the registry in src/schemas.ts reaches 15 members while the porcelain suite freezes src/schemas.ts byte-untouched",
	files: {
		"src/schemas.ts": "export const DIMENSION_REGISTRY = [\n\t// 14 entries — membership pinned by sibling specs (13/14/20)\n];\n",
		"tests/profitability-contract.test.ts": SCENARIO_014_PORCELAIN_TEST,
	},
	artifactText: [
		"# BDD — profitability scenarios",
		"",
		"SCENARIO-041: GIVEN the registry in src/schemas.ts WHEN the profitability dimension is added THEN the registry contains 15 members.",
	].join("\n"),
	reviewer: "bdd",
	plantedLocus: { file: "tests/profitability-contract.test.ts", line: 6 },
};

/** fx-3 — no-Xth closure variant: a spec phase adds a new registry entry while
 *  the sibling spec declares the registry gains no new member (prose column). */
const FX_3_NO_XTH_VS_SPEC_PHASE: ContradictionFixture = {
	id: "no-xth-closure-vs-spec-phase",
	description: "Phase 1 of the specification adds a new registry entry to src/registry.ts while the sibling spec pins that the registry gains no new member",
	files: {
		"src/registry.ts": "export const DIMENSION_REGISTRY = [];\n",
		"docs/specifications/13-external-pest-dimension/01-requirements.md": [
			"# Dimension 13 — External Pest baseline",
			"",
			"The dimension registry in `src/registry.ts` gains no new member.",
			"",
		].join("\n"),
	},
	artifactText: [
		"# Specification — dimension tooling",
		"",
		"Phase 1 adds the profitability dimension as a new registry entry in src/registry.ts.",
	].join("\n"),
	reviewer: "spec",
	plantedLocus: { file: "docs/specifications/13-external-pest-dimension/01-requirements.md", line: 3 },
};

/** The v1 golden-contradiction corpus (closed set; additions require a fixture
 *  whose planted locus the corpus-sanity invariant verifies — 059 §5 D-R-D). */
export const CONTRADICTION_FIXTURES: readonly ContradictionFixture[] = [
	FX_1_SCENARIO_014,
	FX_2_PORCELAIN_VS_EDIT,
	FX_3_NO_XTH_VS_SPEC_PHASE,
];

// ─── the scorer (PURE — the DEC-6 oracle) ────────────────────────────────────

/** DEC-6 line tolerance: an LLM line cite drifting a few lines around the
 *  planted statement still attributes; a cite beyond the window does NOT
 *  (out-of-range = miss — attribution must stay strict). */
export const REVIEWER_HARNESS_LINE_TOLERANCE = 3;

const compactText = (v: unknown): string => {
	if (v == null || typeof v === "object") return "";
	return String(v).replace(/\s+/g, " ").trim();
};

const numericLine = (v: unknown): number | undefined => {
	if (typeof v === "number" && Number.isFinite(v)) return v;
	if (typeof v === "string" && /^\d+$/.test(v.trim())) return Number(v.trim());
	return undefined;
};

/** Does ONE finding cover the planted locus? Coverage (any arm):
 *   - a structured evidenceLocus whose `ref` equals the planted pinId (the
 *     pinId IS the grounded claim — file need not match), or
 *   - an evidenceLocus on the planted FILE with a line within
 *     REVIEWER_HARNESS_LINE_TOLERANCE of the planted line, or
 *   - an explicit `file:line` (or pinId) mention in the finding prose.
 *  A file-only locus (right file, no line, no pinId) is a PARTIAL locus — NOT
 *  a catch: fail-closed attribution (DEC-6 — weak coverage must not score). */
export function findingCoversPlantedLocus(finding: Record<string, unknown>, planted: PlantedLocus, tolerance = REVIEWER_HARNESS_LINE_TOLERANCE, slicePinIds?: ReadonlySet<string>): boolean {
	// A5 slice-grounding: a planted pinId the reviewer never saw (slice-cap
	// truncation or stamp drift) can only be cited by hallucination or prompt
	// leakage — when the caller supplies the injected slice's pinIds, pinId
	// coverage requires the pin to have actually been IN the slice.
	if (planted.pinId !== undefined && slicePinIds !== undefined && !slicePinIds.has(planted.pinId)) return false;
	const loci = Array.isArray(finding.evidenceLoci) ? finding.evidenceLoci : [];
	for (const row of loci) {
		if (!row || typeof row !== "object" || Array.isArray(row)) continue;
		const l = row as { file?: unknown; line?: unknown; ref?: unknown };
		const ref = typeof l.ref === "string" ? l.ref.trim() : "";
		if (planted.pinId !== undefined && ref === planted.pinId) return true;
		if (typeof l.file !== "string" || l.file.trim().replace(/\\/g, "/").replace(/^\.\//, "") !== planted.file) continue;
		const line = numericLine(l.line);
		if (line !== undefined && Math.abs(line - planted.line) <= tolerance) return true;
		// file matched but neither line nor pinId — partial locus, keep looking.
	}
	const prose = `${compactText(finding.title)}\n${compactText(finding.detail)}`;
	if (prose.includes(`${planted.file}:${planted.line}`)) return true;
	if (planted.pinId !== undefined && prose.includes(planted.pinId)) return true;
	return false;
}

export interface HarnessCatchResult {
	/** True iff ≥1 BLOCKING finding attributed the planted locus. */
	caught: boolean;
	/** Indices (into the response's findings array) of the catching findings —
	 *  the attribution evidence, so an aggregate never hides WHICH finding
	 *  scored. */
	catchingFindings: number[];
}

/** Score ONE reviewer response against ONE planted locus. A catch is a
 *  BLOCKING finding (the landed reviewFindingBlocks reader — explicit flag /
 *  high-severity fallback / verified-deferred discount; 059 §3 R5: "pass iff a
 *  blocking finding cites the planted pinId/locus") whose loci cover the
 *  planted locus. The `verdict` field is NEVER READ (DEC-6): a "Changes
 *  Requested" verdict with no attributable blocking finding is an ESCAPE, and
 *  verdict agreement scores zero by construction. */
export function scoreReviewerResponse(
	review: { verdict?: unknown; findings?: unknown } | undefined,
	planted: PlantedLocus,
	tolerance = REVIEWER_HARNESS_LINE_TOLERANCE,
	slicePinIds?: ReadonlySet<string>,
): HarnessCatchResult {
	const findings = Array.isArray(review?.findings) ? (review!.findings as Array<Record<string, unknown>>) : [];
	const catchingFindings: number[] = [];
	findings.forEach((f, i) => {
		if (f && typeof f === "object" && reviewFindingBlocks(f) && findingCoversPlantedLocus(f, planted, tolerance, slicePinIds)) catchingFindings.push(i);
	});
	return { caught: catchingFindings.length > 0, catchingFindings };
}

export interface HarnessAggregate {
	total: number;
	caught: number;
	/** caught/total — 0 on an empty corpus (no observations). */
	catchRate: number;
	/** (total − caught)/total — the ESCAPE rate: a planted contradiction no
	 *  finding attributed. 0 on an empty corpus. */
	escapeRate: number;
}

/** Aggregate the corpus: escape-rate = escapes/total, derived from
 *  caught/total (the brief's "escape-rate = caught/total" names the INPUT
 *  fraction; the escape metric itself is its complement — 059 §3 R5's
 *  escape-rate semantics: an escape is a MISSED planted contradiction). */
export function aggregateEscapeRate(results: Array<{ caught: boolean }>): HarnessAggregate {
	const total = results.length;
	const caught = results.filter((r) => r.caught).length;
	const catchRate = total === 0 ? 0 : caught / total;
	return { total, caught, catchRate, escapeRate: total === 0 ? 0 : 1 - catchRate };
}

/** One additive eval row (059 §3 R5): the verdict rows emitted for σ-band
 *  tracking with `scorerKind: "reviewer-harness"`. DATA ONLY — the offline
 *  driver owns emission (the in-pipeline eval layer is untouched; §6
 *  offline-by-design). Confidence is 1 (deterministic scorer, ranking-only per
 *  the eval-layer convention); the GATE decision is attribution-based
 *  (aggregateEscapeRate), never these strings. */
export function reviewerHarnessRows(cases: Array<{ fixture: ContradictionFixture; result: HarnessCatchResult }>): Array<{ caseId: string; caseVersion: number; verdict: string; confidence: number; scorerKind: "reviewer-harness" }> {
	return cases.map(({ fixture, result }) => ({
		caseId: fixture.id,
		caseVersion: 1,
		verdict: result.caught ? "caught" : "escaped",
		confidence: 1,
		scorerKind: "reviewer-harness" as const,
	}));
}

// ─── corpus sanity (deterministic — never trust the fixture's own claim) ─────

/** Verify one fixture's planted locus against the ACTUAL extractor output for
 *  its materialized tree: the named file exists, the line is within the file's
 *  line count, and a real pin sits at exactly `file:line`. Pure w.r.t. the
 *  passed inventory (the caller materialized the tree). */
export function fixturePlantedLocusPresent(fixture: ContradictionFixture, inventory: ContractInventory): { ok: boolean; problems: string[] } {
	const problems: string[] = [];
	const content = fixture.files[fixture.plantedLocus.file];
	if (content === undefined) problems.push(`planted file ${fixture.plantedLocus.file} is not in the fixture's files`);
	else if (content.split("\n").length < fixture.plantedLocus.line) problems.push(`planted line ${fixture.plantedLocus.line} exceeds ${fixture.plantedLocus.file}'s line count (${content.split("\n").length})`);
	const locus = `${fixture.plantedLocus.file}:${fixture.plantedLocus.line}`;
	const allPins = [...inventory.protectedFiles.values()].flat();
	if (!allPins.some((p) => p.locus === locus && p.resolutionState === "active")) problems.push(`no active inventory pin at ${locus}`);
	return { ok: problems.length === 0, problems };
}

// ─── the runner (thin driver — no LLM dispatch) ──────────────────────────────

/** Materialize the fixture's synthetic worktree under `dir` (idempotent:
 *  plain overwrites; deterministic order). */
export function materializeContradictionFixture(fixture: ContradictionFixture, dir: string): void {
	for (const [rel, content] of Object.entries(fixture.files)) {
		const p = join(dir, rel);
		mkdirSync(dirname(p), { recursive: true });
		writeFileSync(p, content);
	}
}

export interface PreparedHarnessCase {
	fixture: ContradictionFixture;
	/** The rendered reviewer prompt — exactly what a live dispatch would send
	 *  (landed builders + the injected slice). */
	prompt: string;
	plantedLocus: PlantedLocus;
	/** The injected contract-surface slice for this case (what the reviewer
	 *  saw; the offline driver compares findings against it + the locus).
	 *  The driver MUST score via `scoreReviewerResponse(review, planted,
	 *  tolerance, new Set(prepared.slice.pinIds))` — the A5 grounding makes
	 *  pinId coverage require the pin to have been in the injected slice. */
	slice: ContractSlice;
}

/** The thin runner: materialize the fixture worktree, extract the inventory
 *  (fresh walk), build the injected slice from the artifact text (059 §3 R2
 *  touched-set), and render the reviewer prompt via the LANDED builders —
 *  buildUpstreamReviewPrompt (requirements/bdd/design) or buildSpecReviewPrompt.
 *  Deterministic; NO live-LLM call ever happens here (tests pin the prompt,
 *  the slice, and the planted locus; the offline driver owns real dispatch). */
export function prepareReviewerHarnessCase(fixture: ContradictionFixture, dir: string): PreparedHarnessCase {
	materializeContradictionFixture(fixture, dir);
	const inventory = extractContractInventory(dir);
	const slice = buildContractSlice({ inventory, texts: [fixture.artifactText] });
	const setup: SetupControl = {
		worktreePath: dir,
		specDirectory: join(dir, "docs/specifications/001/"),
		defaultBranch: "main",
		language: "backend",
		isWebUi: false,
		specIdentifier: "001",
		worktreeCreated: true,
		initializedRepo: false,
	};
	const classify = null as Classification | null;
	const sliceBlock = slice.empty ? "" : slice.block;
	const prompt = fixture.reviewer === "spec"
		? buildSpecReviewPrompt(setup, classify, null, sliceBlock)
		: buildUpstreamReviewPrompt(setup, classify, {
			stage: fixture.reviewer,
			docPath: "docs/specifications/001/01-artifact.md",
			upstream: [],
			contractSliceBlock: sliceBlock,
		});
	return { fixture, prompt, plantedLocus: fixture.plantedLocus, slice };
}
