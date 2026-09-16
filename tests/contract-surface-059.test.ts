/**
 * 059 R1A deterministic acceptance tests — D-R-A extractor (golden fixtures
 * incl. the SCENARIO-014 shape + the §3 grammar-table rows), D-R-B validators
 * (set-inclusion pass/fail, pinOwnership AST, pre-W degrade, Strike-1
 * classifier), the R4 evidence-pair exemption (disk-existence, slice
 * membership, bound ≤1, escalateToJudge), and the Check 3 amendmentFamily
 * exemption consumer (exemption fixture + malformed-knowledge fail-closed).
 * Deterministic only — no LLM-behavior claims (059 §7 R1A gate).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { artifactConvergenceSources } from "./helpers/artifact-convergence-source.ts";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
	buildContractSlice,
	extractContractInventory,
	CONTRACT_SLICE_TRUNCATION_MARKER,
	CONTRACT_INVENTORY_ERROR_BANNER,
	mintPinId,
} from "../src/review/contract-surface.ts";
import {
	bddPinOwnershipFindings,
	designAmendmentFamilyFindings,
	isWriterMetadataRejection,
	requirementsIntentFindings,
	selfSpecArtifactMatcher,
	splitContractFindings,
} from "../src/review/contract-validators.ts";
import { enforceReviewerConvergenceDuty } from "../src/review-findings.ts";
import { planFeasibilityFindings } from "../src/stages/plan-feasibility.ts";
import type { PlanPhase } from "../src/stages/plan-feasibility.ts";
import { CONTRACT_CONFLICT_SCOPE } from "../src/review/contract-conflict-consumer.ts";
import { readFileSync } from "node:fs";
import { implementationSources } from "./helpers/implementation-source.ts";

let wt: string;
beforeEach(() => {
	wt = mkdtempSync(join(tmpdir(), "sd-059-contract-"));
});
afterEach(() => {
	try { rmSync(wt, { recursive: true, force: true }); } catch { /* tmp */ }
});

function writeWt(rel: string, content: string): void {
	const p = join(wt, rel);
	mkdirSync(dirname(p), { recursive: true });
	writeFileSync(p, content);
}

/** The RAW run-2026-09-13T03-24-15-047Z SCENARIO-014 shape (porcelain
 * pathspec + byte-untouched message) — the spec's named golden fixture. */
const SCENARIO_14_TEST = [
	'import { execSync } from "node:child_process";',
	'import { expect, it } from "vitest";',
	"",
	'it("SCENARIO-014 the frozen contract holds", () => {',
	'\tconst dirty = execSync("git status --porcelain -- src/schemas.ts").toString();',
	'\texpect(dirty, "src/schemas.ts must stay byte-untouched").toBe("");',
	"});",
].join("\n");

const GRAMMAR_TABLE_TEST = [
	'import { expect, it } from "vitest";',
	'import { DIMENSION_REGISTRY, SPEC_OWNERS } from "../src/registry.ts";',
	"",
	'it("registry is closed", () => {',
	"\texpect(DIMENSION_REGISTRY.length, \"src/registry.ts is pinned at exactly 14 members\").toBe(14);",
	'\texpect(DIMENSION_REGISTRY).not.toContain("industry-momentum-15");',
	"\texpect(SPEC_OWNERS).toEqual({ a: 13, b: 14 });",
	"});",
].join("\n");

const GRAMMAR_TABLE_PY = [
	"import subprocess",
	"",
	"def test_frozen():",
	'\tout = subprocess.check_output(["git", "status", "--porcelain", "--", "src/schemas.ts"]).decode()',
	'\tassert out == ""',
	"def test_registry_closed():",
	"\tassert len(REGISTRY) == 14",
	'\tassert "fifteenth" not in REGISTRY',
].join("\n");

const GRAMMAR_TABLE_MD = [
	"# Shared contract baselines",
	"",
	"- `src/schemas.ts` stays byte-untouched in git — working tree clean for it after every phase.",
	"- The dimension registry is pinned at exactly 14 members (a closed set of 14); it gains no new member.",
	"- OWNER '14' owns the profitability rows.",
	"- The prose pin with no path lives here: the gazornenplatz table is immutable.",
].join("\n");

function inventoryOf(): ReturnType<typeof extractContractInventory> {
	return extractContractInventory(wt);
}

describe("059 D-R-A — contract-surface extractor golden fixtures", () => {
	it("SCENARIO-014 shape: porcelain + byte-untouched + pathspec keys src/schemas.ts as porcelain-emptiness", () => {
		writeWt("tests/profitability-contract.test.ts", SCENARIO_14_TEST);
		const inv = inventoryOf();
		const pins = inv.protectedFiles.get("src/schemas.ts") ?? [];
		expect(pins.length).toBeGreaterThanOrEqual(1);
		const pe = pins.find((p) => p.idiomFamily === "porcelain-emptiness");
		expect(pe).toBeDefined();
		expect(pe!.via).toBe("ts-test");
		expect(pe!.locus).toBe("tests/profitability-contract.test.ts:6");
		expect(pe!.resolutionState).toBe("active");
		expect(pe!.statement).toContain("byte-untouched");
	});

	it("§3 grammar table (TS column): exactly-N membership, no-Xth closure, ownership table rows", () => {
		writeWt("src/registry.ts", "export const DIMENSION_REGISTRY = [];\nexport const SPEC_OWNERS = { a: 13, b: 14 };\n");
		writeWt("tests/registry.test.ts", GRAMMAR_TABLE_TEST);
		const inv = inventoryOf();
		const all = [...inv.protectedFiles.values()].flat();
		expect(all.some((p) => p.idiomFamily === "exactly-n-membership" && p.statement.includes("toBe(14)"))).toBe(true);
		expect(all.some((p) => p.idiomFamily === "no-xth-closure" && p.statement.includes("not.toContain"))).toBe(true);
		expect(all.some((p) => p.idiomFamily === "ownership-table")).toBe(true);
		// The ownership EXPORT self-anchors: src/registry.ts is itself protected.
		expect((inv.protectedFiles.get("src/registry.ts") ?? []).some((p) => p.idiomFamily === "ownership-table")).toBe(true);
	});

	it("§3 grammar table (Python column): subprocess porcelain + assert == \"\", len == N, not-in", () => {
		writeWt("tests/test_contract.py", GRAMMAR_TABLE_PY);
		const inv = inventoryOf();
		const all = [...inv.protectedFiles.values()].flat();
		expect(all.some((p) => p.idiomFamily === "porcelain-emptiness" && p.via === "python-test" && p.statement.includes("--porcelain"))).toBe(true);
		expect(all.some((p) => p.idiomFamily === "exactly-n-membership" && p.via === "python-test")).toBe(true);
		expect(all.some((p) => p.idiomFamily === "no-xth-closure" && p.via === "python-test")).toBe(true);
	});

	it("§3 grammar table (Markdown column): byte-untouched, exactly-N, gains-no-new-member, OWNER '14'", () => {
		writeWt("docs/specifications/13-external-pest-dimension/01-requirements.md", GRAMMAR_TABLE_MD);
		const inv = inventoryOf();
		const all = [...inv.protectedFiles.values()].flat();
		expect(all.some((p) => p.idiomFamily === "porcelain-emptiness" && p.via === "markdown-prose")).toBe(true);
		expect(all.some((p) => p.idiomFamily === "exactly-n-membership" && p.statement.toLowerCase().includes("exactly 14"))).toBe(true);
		expect(all.some((p) => p.idiomFamily === "no-xth-closure" && p.statement.includes("no new member"))).toBe(true);
		expect(all.some((p) => p.idiomFamily === "ownership-table" && p.statement.includes("OWNER '14'"))).toBe(true);
		// The prose pin with NO path token is unanchored — listed, never dropped (P10).
		expect(inv.unanchored.some((p) => p.statement.includes("gazornenplatz"))).toBe(true);
	});

	it("repo-invariants.json pins[] anchors a legacy prose pin (backwards-compatible envelope; `protected` noted, not indexed)", () => {
		writeWt("docs/specifications/20-tool-catalog/01-requirements.md", "The gazornenplatz table is immutable.\n");
		writeWt("repo-invariants.json", JSON.stringify({
			protected: ["src/schemas.ts"],
			pins: [{ protectedFile: "src/gazornenplatz.ts", pin: "gazornenplatx table is immutable".replace("platx", "platz"), anchor: "docs/specifications/20-tool-catalog/01-requirements.md" }],
		}));
		const inv = inventoryOf();
		expect((inv.protectedFiles.get("src/gazornenplatz.ts") ?? []).some((p) => p.via === "repo-invariants")).toBe(true);
		expect(inv.scanLines.some((l) => l.startsWith("docs/specifications/20-tool-catalog/01-requirements.md:"))).toBe(true);
	});

	it("deterministic: same tree ⇒ same pinIds (sorted traversal, sorted pins)", () => {
		writeWt("tests/a.test.ts", SCENARIO_14_TEST);
		writeWt("tests/b.test.ts", GRAMMAR_TABLE_TEST);
		const a = inventoryOf();
		const b = inventoryOf();
		expect([...a.protectedFiles.keys()]).toEqual([...b.protectedFiles.keys()]);
		expect(JSON.stringify([...a.protectedFiles.entries()].map(([k, v]) => [k, v.map((p) => p.pinId)]))).toBe(JSON.stringify([...b.protectedFiles.entries()].map(([k, v]) => [k, v.map((p) => p.pinId)])));
	});

	it("pinId minting is stable and content-derived", () => {
		const id1 = mintPinId("porcelain-emptiness", "tests/x.test.ts:6", "wording");
		expect(id1).toBe(mintPinId("porcelain-emptiness", "tests/x.test.ts:6", "wording"));
		expect(id1).toMatch(/^pin-pe-[0-9a-z]{7}$/);
	});

	it("absent tree ⇒ silent fail-open (empty inventory, no errors)", () => {
		const inv = inventoryOf();
		expect(inv.protectedFiles.size).toBe(0);
		expect(inv.unanchored).toHaveLength(0);
		expect(inv.errors).toHaveLength(0);
	});
});

describe("059 R2/W1 — slice construction", () => {
	it("touched-set via literal path token in the artifact text; unanchored + unmapped-concept lines; empty touched-set ⇒ omitted", () => {
		writeWt("tests/profitability-contract.test.ts", SCENARIO_14_TEST);
		writeWt("docs/specifications/13-x/01-requirements.md", "The gazornenplatz table is immutable and `src/schemas.ts` is pinned at exactly 14 members.\n(Context: migration guidance lives in the sibling documents and their appendices.)\n(Context: rollout sequencing is described alongside the delivery checkpoints.)\n(Context: the review cadence mirrors the acceptance walkthrough schedule.)\nThe frobnicator table is immutable.\n");
		writeWt("repo-invariants.json", JSON.stringify({ concepts: ["pricing-grid"] }));
		const inv = inventoryOf();
		const touched = buildContractSlice({ inventory: inv, texts: ["we will edit src/schemas.ts and the pricing-grid"] });
		expect(touched.empty).toBe(false);
		expect(touched.block).toContain("src/schemas.ts:");
		expect(touched.block).toContain("unanchored:");
		expect(touched.block).toContain("unmapped-concept: pricing-grid");
		const untouched = buildContractSlice({ inventory: inv, texts: ["an unrelated task about documentation only"] });
		expect(untouched.empty).toBe(true);
		expect(untouched.block).toBe("");
	});

	it("15-pin / 60-line cap with the located truncation indicator", () => {
		// Backtick-SYMMETRIC path tokens (the landed scanner's B-1 quote guard:
		// a token must open AND close with the same quote character).
		const lines = ['import { execSync } from "node:child_process";', 'const dirty = execSync("git status --porcelain").toString();'];
		for (let i = 0; i < 30; i++) lines.push(`it("p${i}", () => { expect(dirty, "\`src/file${i}.ts\` must stay byte-untouched").toBe(""); });`);
		writeWt("tests/many.test.ts", lines.join("\n"));
		const inv = inventoryOf();
		const corpus = Array.from({ length: 30 }, (_, i) => `src/file${i}.ts`).join(" ");
		const slice = buildContractSlice({ inventory: inv, texts: [`touch ${corpus}`] });
		expect(slice.pinCount).toBeGreaterThan(CONTRACT_SLICE_TRUNCATION_AT);
		expect(slice.truncated).toBe(true);
		expect(slice.block.split("\n").length).toBeLessThanOrEqual(60);
		expect(slice.block.trim().split("\n").pop()).toBe(CONTRACT_SLICE_TRUNCATION_MARKER);
	});

	it("DEC-4: extraction error on an existing tree renders the fail-loud banner even with an empty touched-set", () => {
		writeWt("repo-invariants.json", "{not json");
		const inv = inventoryOf();
		expect(inv.errors.length).toBeGreaterThan(0);
		const slice = buildContractSlice({ inventory: inv, texts: ["unrelated"] });
		expect(slice.empty).toBe(false);
		expect(slice.block).toContain(CONTRACT_INVENTORY_ERROR_BANNER);
	});
});

const CONTRACT_SLICE_TRUNCATION_AT = 15;

describe("059 D-R-B — validators (fixtures: pass/fail, AST, pre-W, Strike-1)", () => {
	function ctx059(texts: string[]) {
		const inventory = extractContractInventory(wt);
		const slice = buildContractSlice({ inventory, texts });
		return { inventory, slice };
	}

	it("set-inclusion FAIL: design declares no family on a touched surface with pins (blocking, ownerStage=design)", () => {
		writeWt("tests/profitability-contract.test.ts", SCENARIO_14_TEST);
		const { inventory, slice } = ctx059(["edit src/schemas.ts"]);
		const findings = designAmendmentFamilyFindings({ control: { layerW: "1" }, slice, inventory });
		const { blocking } = splitContractFindings(findings);
		expect(blocking.length).toBeGreaterThan(0);
		expect(blocking[0]).toContain("no amendmentFamily");
	});

	it("set-inclusion PASS: pinsMoved covers the slice pin", () => {
		writeWt("tests/profitability-contract.test.ts", SCENARIO_14_TEST);
		const { inventory, slice } = ctx059(["edit src/schemas.ts"]);
		const pinId = (inventory.protectedFiles.get("src/schemas.ts") ?? [])[0].pinId;
		const findings = designAmendmentFamilyFindings({
			control: { layerW: "1", amendmentFamily: [{ sharedFile: "src/schemas.ts", pinsMoved: [pinId], exemptions: [], docUpdates: [] }] },
			slice,
			inventory,
		});
		expect(splitContractFindings(findings).blocking).toHaveLength(0);
	});

	it("set-inclusion FAIL: exemption with EMPTY justification is blocking (delta-4 DEFECT-3)", () => {
		writeWt("tests/profitability-contract.test.ts", SCENARIO_14_TEST);
		const { inventory, slice } = ctx059(["edit src/schemas.ts"]);
		const pinId = (inventory.protectedFiles.get("src/schemas.ts") ?? [])[0].pinId;
		const findings = designAmendmentFamilyFindings({
			control: { layerW: "1", amendmentFamily: [{ sharedFile: "src/schemas.ts", pinsMoved: [], exemptions: [{ pinId, justification: " " }], docUpdates: [] }] },
			slice,
			inventory,
		});
		const { blocking } = splitContractFindings(findings);
		expect(blocking.some((b) => b.includes("EMPTY justification"))).toBe(true);
	});

	it("pre-W degrade: no layerW stamp ⇒ blocking findings become advisory + the P10 banner", () => {
		writeWt("tests/profitability-contract.test.ts", SCENARIO_14_TEST);
		const { inventory, slice } = ctx059(["edit src/schemas.ts"]);
		const findings = designAmendmentFamilyFindings({ control: {}, slice, inventory });
		const { blocking, advisory } = splitContractFindings(findings);
		expect(blocking).toHaveLength(0);
		expect(advisory.some((a) => a.includes("[layer-w: pre-W artifact — validation advisory; see 059 §3 R3]"))).toBe(true);
	});

	it("pinOwnership AST: unowned pin on a touched surface is blocking; inherited-frozen without justification is blocking; malformed state is [contract-metadata]", () => {
		writeWt("tests/profitability-contract.test.ts", SCENARIO_14_TEST);
		const { inventory, slice } = ctx059(["edit src/schemas.ts"]);
		const pinId = (inventory.protectedFiles.get("src/schemas.ts") ?? [])[0].pinId;
		const noOwnership = bddPinOwnershipFindings({ control: { layerW: "1", features: [{ name: "f", scenarios: [{ id: "001", title: "t", acRef: "AC-01", priority: "high", given: "g", when: "w", then: "th" }] }] }, slice, inventory });
		expect(splitContractFindings(noOwnership).blocking.some((b) => b.includes("UNOWNED"))).toBe(true);
		const frozenNoJust = bddPinOwnershipFindings({ control: { layerW: "1", features: [{ name: "f", scenarios: [{ id: "001", title: "t", acRef: "AC-01", priority: "high", given: "g", when: "w", then: "th", pinOwnership: [{ pinId, state: "inherited-frozen", justification: "" }] }] }] }, slice, inventory });
		expect(splitContractFindings(frozenNoJust).blocking.some((b) => b.includes("[contract-metadata]") && b.includes("EMPTY justification"))).toBe(true);
		const badState = bddPinOwnershipFindings({ control: { layerW: "1", features: [{ name: "f", scenarios: [{ id: "001", title: "t", acRef: "AC-01", priority: "high", given: "g", when: "w", then: "th", pinOwnership: [{ pinId, state: "frozen", justification: "x" }] }] }] }, slice, inventory });
		expect(splitContractFindings(badState).blocking.some((b) => b.includes("[contract-metadata]"))).toBe(true);
		const owned = bddPinOwnershipFindings({ control: { layerW: "1", features: [{ name: "f", scenarios: [{ id: "001", title: "t", acRef: "AC-01", priority: "high", given: "g", when: "w", then: "th", pinOwnership: [{ pinId, state: "owned", justification: "amend per AC-02" }] }] }] }, slice, inventory });
		expect(splitContractFindings(owned).blocking).toHaveLength(0);
	});

	// ── class fix, run 2026-09-14T00-59-16-373Z: convergence demand-set laws ──
	// Research grounding: ratchet/baseline pattern (SonarQube new-code, Semgrep
	// --baseline-commit, detekt baseline.xml), verifier-is-a-function (the
	// demand set must not depend on the artifact under edit), and monotone
	// fixpoint frameworks (Kildall — termination needs D(n+1) ⊆ D(n)).

	it("DEMAND LAW 1 (bounded visibility): pins beyond the injected-slice cap are NEVER blocking — one advisory discloses them", () => {
		// 20 pinning test files on src/schemas.ts — the slice caps at 15.
		for (let i = 0; i < 20; i++) writeWt(`tests/census-${i}.test.ts`, [
			"import { describe, it, expect } from \"vitest\";",
			"import { execSync } from \"node:child_process\";",
			"describe(`census ${i}`, () => {",
			"  it(`schemas.ts is porcelain-clean ${i}`, () => {",
			"    const out = execSync(\"git status --porcelain -- src/schemas.ts\").toString().trim();",
			`    expect(out, \"src/schemas.ts must stay byte-untouched ${i}\").toBe(\"\");`,
			"  });",
			"});",
			"",
		].join("\n"));
		const { inventory, slice } = ctx059(["edit src/schemas.ts"]);
		expect(inventory.protectedFiles.get("src/schemas.ts")!.length).toBe(20);
		expect(slice.pinIds.length).toBeLessThanOrEqual(15);
		const findings = bddPinOwnershipFindings({ control: { layerW: "1", features: [] }, slice, inventory });
		const { blocking, advisory } = splitContractFindings(findings);
		// Every blocking demand IS in the writer's slice (writer-visible).
		const blockingIds = blocking.map((b) => b.match(/pin-[a-z]{2}-[0-9a-z]+/)?.[0]).filter(Boolean) as string[];
		expect(blockingIds.length).toBeGreaterThan(0);
		for (const id of blockingIds) expect(slice.pinIds).toContain(id);
		expect(blockingIds.length).toBe(new Set(blockingIds).size);
		// Exactly ONE advisory disclosing the beyond-cap remainder — never blocking.
		expect(advisory.filter((x) => x.includes("exceed the injected slice cap"))).toHaveLength(1);
	});

	it("DEMAND LAW 2 (self-referential exclusion): pins minted from the stage's OWN artifact are not demandable — declaring them can never be required", () => {
		// The spec's own BDD doc carries porcelain-idiom prose (what the writer's
		// remediation looks like) — round 2 of the failed run demanded exactly
		// such a pin (03-bdd-scenarios.md:145).
		writeWt("tests/profitability-contract.test.ts", SCENARIO_14_TEST);
		writeWt("docs/specifications/26-capability-backend-substrate/03-bdd-scenarios.md", [
			"# BDD",
			"",
			"The registry in `src/schemas.ts` stays byte-untouched; `git status --porcelain -- src/schemas.ts` is empty after the change.",
			"",
		].join("\n"));
		const { inventory, slice } = ctx059(["edit src/schemas.ts"]);
		// Production shape: specDirectory is ABSOLUTE (setup.ts:755) while loci
		// are repo-relative — the matcher must bridge (A1).
		const selfMatcher = selfSpecArtifactMatcher("/home/u/repo/.worktrees/26-a/docs/specifications/26-capability-backend-substrate/", "-bdd-scenarios.md");
		expect(selfMatcher!("docs/specifications/26-capability-backend-substrate/03-bdd-scenarios.md")).toBe(true); // file part only — demandablePins splits locus first
		expect(selfMatcher!("docs/specifications/26-capability-backend-substrate/01-requirements.md")).toBe(false); // own spec, OTHER artifact family stays demandable
		expect(selfMatcher!("docs/specifications/24-other/03-bdd-scenarios.md")).toBe(false);
		const selfPin = (inventory.protectedFiles.get("src/schemas.ts") ?? []).find((p) => p.locus.startsWith("docs/specifications/26-capability-backend-substrate/03-bdd-scenarios.md:"));
		expect(selfPin).toBeDefined();
		const findings = bddPinOwnershipFindings({ control: { layerW: "1", features: [] }, slice, inventory, selfArtifactMatch: selfMatcher });
		const { blocking } = splitContractFindings(findings);
		expect(blocking.some((b) => b.includes(selfPin!.pinId))).toBe(false);
		// Without the matcher (legacy callers), the pin stays demandable —
		// the exclusion is an opt-in refinement, not a silent weakening.
		const legacy = bddPinOwnershipFindings({ control: { layerW: "1", features: [] }, slice, inventory });
		expect(splitContractFindings(legacy).blocking.some((b) => b.includes(selfPin!.pinId))).toBe(slice.pinIds.includes(selfPin!.pinId));
	});

	it("DEMAND LAW 3 (monotone progress + SELF-MINTING): per-round re-walk with a growing own-BDD-doc — declarations must SHRINK demands even though the writer's own prose re-mints pins (A5: fails on pre-fix code)", () => {
		for (let i = 0; i < 4; i++) writeWt(`tests/prog-${i}.test.ts`, [
			"import { describe, it, expect } from \"vitest\";",
			"import { execSync } from \"node:child_process\";",
			"describe(`p ${i}`, () => {",
			"  it(`porcelain ${i}`, () => {",
			"    const out = execSync(\"git status --porcelain -- src/schemas.ts\").toString().trim();",
			`    expect(out, \"src/schemas.ts stays byte-untouched ${i}\").toBe(\"\");`,
			"  });",
			"});",
			"",
		].join("\n"));
		const selfMatcher = selfSpecArtifactMatcher("/tmp/wt-a/docs/specifications/26-a/", "-bdd-scenarios.md"); // production shape: ABSOLUTE dir (setup.ts:755)
		const demandIds = (control: Record<string, unknown>) => {
			const inventory = extractContractInventory(wt); // FRESH walk each round — the live mechanism
			const slice = buildContractSlice({ inventory, texts: ["edit src/schemas.ts"] });
			const { blocking } = splitContractFindings(bddPinOwnershipFindings({ control, slice, inventory, selfArtifactMatch: selfMatcher }));
			return { ids: blocking.map((b) => b.match(/pin-[a-z]{2}-[0-9a-z]+/)?.[0]).filter(Boolean) as string[] };
		};
		// Round 1: nothing declared → demands on the test-file pins.
		const r1 = demandIds({ layerW: "1", features: [] });
		expect(r1.ids.length).toBeGreaterThan(0);
		// The writer declares r1 demands — its OWN BDD prose (ownership
		// statements naming src/schemas.ts + baseline idioms) lands on disk,
		// exactly like the failed run's 03-bdd-scenarios.md:145.
		writeWt("docs/specifications/26-a/03-bdd-scenarios.md", [
			"# BDD",
			...r1.ids.map((id, i) => `${i + 3}. The registry in \`src/schemas.ts\` is pinned at exactly 14 members — ownership of ${id} declared here (byte-untouched after the guarded append).`),
			"",
		].join("\n"));
		// Round 2: the writer DECLARES round-1's demands (honest compliance) in
		// the artifact AND in the typed control, while its own prose re-mints
		// new self-pins on disk. With the self-exclusion the demand set still
		// SHRINKS (Kildall); pre-fix code (full-inventory demand) resurrects
		// demands here — the whack-a-mole the failed run died in.
		const declared = { layerW: "1", features: [{ name: "f", scenarios: r1.ids.map((pinId, j) => ({ id: String(100 + j), title: "t", acRef: "AC-01", priority: "high", given: "g", when: "w", then: "th", pinOwnership: [{ pinId, state: "owned", justification: "amend per AC-02" }] })) }] };
		const r2 = demandIds(declared);
		expect(r2.ids.length).toBeLessThan(r1.ids.length);
		// Round 3: declare everything the slice surfaced → converged.
		const inventory3 = extractContractInventory(wt);
		const slice3 = buildContractSlice({ inventory: inventory3, texts: ["edit src/schemas.ts"] });
		const allDeclared = { layerW: "1", features: [{ name: "f", scenarios: slice3.pinIds.map((pinId, j) => ({ id: String(200 + j), title: "t", acRef: "AC-01", priority: "high", given: "g", when: "w", then: "th", pinOwnership: [{ pinId, state: "owned", justification: "amend per AC-02" }] })) }] };
		const r3 = demandIds(allDeclared);
		expect(r3.ids).toHaveLength(0);
		// Sanity: WITHOUT the matcher the self-minted pins WOULD be demanded —
		// proving the fixture actually reproduces the live failure shape.
		const inventory2 = extractContractInventory(wt);
		const slice2 = buildContractSlice({ inventory: inventory2, texts: ["edit src/schemas.ts"] });
		const legacy = splitContractFindings(bddPinOwnershipFindings({ control: { layerW: "1", features: [] }, slice: slice2, inventory: inventory2 })).blocking;
		const legacyIds = legacy.map((b) => b.match(/pin-[a-z]{2}-[0-9a-z]+/)?.[0]).filter(Boolean) as string[];
		expect(legacyIds.some((id) => !r1.ids.includes(id))).toBe(true);
	});

	it("requirements intent check is ADVISORY-only at 2B (HIGH-1)", () => {
		writeWt("tests/profitability-contract.test.ts", SCENARIO_14_TEST);
		const { inventory, slice } = ctx059(["edit src/schemas.ts"]);
		const findings = requirementsIntentFindings({ control: {}, slice });
		const { blocking, advisory } = splitContractFindings(findings);
		expect(blocking).toHaveLength(0);
		expect(advisory.length).toBe(1);
	});

	it("Strike-1 classifier: metadata-shaped errors only; substantive errors do not qualify", () => {
		expect(isWriterMetadataRejection(["amendmentFamily[0]: must be array"])).toBe(true);
		expect(isWriterMetadataRejection(["[contract-metadata] design amendmentFamily[0]: sharedFile must be a non-empty repo-relative path"])).toBe(true);
		expect(isWriterMetadataRejection(["features[].scenarios[].pinOwnership[1].state: must be string"])).toBe(true);
		expect(isWriterMetadataRejection(["phases must be a non-empty array"])).toBe(false);
		expect(isWriterMetadataRejection(["amendmentFamily[0]: must be array", "phases must be a non-empty array"])).toBe(false);
		expect(isWriterMetadataRejection([])).toBe(false);
	});
});

describe("059 R4 — evidence-pair exemption (verified + bounded + escalated)", () => {
	function reviewWith(loci: unknown[], ownerStage = "bdd") {
		type DutyFinding = { id: string; severity: string; title: string; detail: string; ownerStage: string; blocking: boolean; evidenceLoci: unknown; evidencePairExempt?: boolean; exemptionReason?: string };
		const findings: DutyFinding[] = loci.map((l, i) => ({ id: `F-${i + 1}`, severity: "medium", title: `t${i + 1}`, detail: `d${i + 1}`, ownerStage, blocking: true, evidenceLoci: l }));
		return { verdict: "Changes Requested", findings };
	}

	it("no exemption without worktreePath/slice opts (fail-closed harmless) — return shape extends to {downgraded, exemptCount, escalateToJudge}", () => {
		const review = reviewWith([{ file: "tests/a.test.ts", line: 1 }, { file: "src/x.ts" }]);
		const r = enforceReviewerConvergenceDuty(review, 3, { stage: "spec" });
		expect(r).toEqual({ downgraded: 2, exemptCount: 0, escalateToJudge: false });
		expect(review.findings[0].evidencePairExempt).toBeUndefined();
	});

	it("≥2 loci on disk AND ≥1 in the slice ⇒ survives suppression (stamped, not downgraded)", () => {
		writeWt("tests/profitability-contract.test.ts", SCENARIO_14_TEST);
		const inv = inventoryOf();
		const pin = (inv.protectedFiles.get("src/schemas.ts") ?? [])[0];
		writeWt("src/schemas.ts", "export const PLACEHOLDER = 1;\n");
		const slice = { files: new Set(["src/schemas.ts"]), pinIds: new Set<string>([String(pin.pinId)]) };
		const review = reviewWith([[
			{ file: "tests/profitability-contract.test.ts", line: 6, ref: pin.pinId },
			{ file: "src/schemas.ts", line: 1 },
		]]);
		const r = enforceReviewerConvergenceDuty(review, 3, { stage: "spec", worktreePath: wt, injectedSlice: slice });
		expect(r.downgraded).toBe(0);
		expect(r.exemptCount).toBe(1);
		expect(r.escalateToJudge).toBe(false);
		expect(review.findings[0].evidencePairExempt).toBe(true);
		expect(review.findings[0].exemptionReason).toContain("evidence-pair");
	});

	it("loci NOT on disk ⇒ no exemption (downgraded normally)", () => {
		const review = reviewWith([[{ file: "tests/missing.test.ts", line: 6 }, { file: "src/nope.ts", line: 1 }]]);
		const r = enforceReviewerConvergenceDuty(review, 3, { stage: "spec", worktreePath: wt, injectedSlice: { files: new Set(["src/nope.ts"]), pinIds: new Set() } });
		expect(r.exemptCount).toBe(0);
		expect(r.downgraded).toBe(1);
		expect(review.findings[0].blocking).toBe(false);
	});

	it("loci on disk but NOT in the slice ⇒ no exemption (slice membership is required)", () => {
		writeWt("tests/other.test.ts", "it('x', () => {});\nit('y', () => {});\n");
		const review = reviewWith([[{ file: "tests/other.test.ts", line: 1 }, { file: "tests/other.test.ts", line: 2 }]]);
		const r = enforceReviewerConvergenceDuty(review, 3, { stage: "spec", worktreePath: wt, injectedSlice: { files: new Set(["src/schemas.ts"]), pinIds: new Set() } });
		expect(r.exemptCount).toBe(0);
		expect(r.downgraded).toBe(1);
	});

	it("line stated beyond the file's line count ⇒ locus does not exist on disk", () => {
		writeWt("tests/short.test.ts", "one line only\n");
		const review = reviewWith([{ file: "tests/short.test.ts", line: 99 }, { file: "tests/short.test.ts", line: 1 }]);
		const r = enforceReviewerConvergenceDuty(review, 3, { stage: "spec", worktreePath: wt, injectedSlice: { files: new Set(["tests/short.test.ts"]), pinIds: new Set() } });
		// verified = only the line-1 locus (1 < 2) ⇒ no exemption
		expect(r.exemptCount).toBe(0);
	});

	it("bound ≤1: the SECOND eligible finding is downgraded and sets escalateToJudge", () => {
		writeWt("tests/profitability-contract.test.ts", SCENARIO_14_TEST);
		writeWt("tests/second.test.ts", "a\nb\n");
		const slice = { files: new Set(["tests/profitability-contract.test.ts", "tests/second.test.ts"]), pinIds: new Set<string>() };
		const review = reviewWith([
			[{ file: "tests/profitability-contract.test.ts", line: 6 }, { file: "tests/second.test.ts", line: 1 }],
			[{ file: "tests/profitability-contract.test.ts", line: 5 }, { file: "tests/second.test.ts", line: 2 }],
		]);
		const r = enforceReviewerConvergenceDuty(review, 3, { stage: "spec", worktreePath: wt, injectedSlice: slice });
		expect(r.exemptCount).toBe(2);
		expect(r.escalateToJudge).toBe(true);
		expect(review.findings[0].evidencePairExempt).toBe(true);
		expect(review.findings[1].evidencePairExempt).toBeUndefined();
		expect(review.findings[1].blocking).toBe(false); // excess falls through to the downgrade
	});

	it("early rounds are untouched (REVIEWER_DUTY_ROUND) — exemption only applies where suppression would", () => {
		const review = reviewWith([{ file: "tests/a.test.ts", line: 1 }, { file: "src/x.ts" }]);
		const r = enforceReviewerConvergenceDuty(review, 2, { stage: "spec", worktreePath: wt, injectedSlice: { files: new Set(["tests/a.test.ts"]), pinIds: new Set() } });
		expect(r).toEqual({ downgraded: 0, exemptCount: 0, escalateToJudge: false });
	});
});

describe("059 D-R-B(g) — consumer wiring source pins (routes + refusal)", () => {
	it("the consumer calls the judge with scope stage9.contract-conflict and allowedRoutes EXACTLY [\"replan-upstream\"]", () => {
		const src = readFileSync(new URL("../src/review/contract-conflict-consumer.ts", import.meta.url), "utf8");
		expect(src).toContain(`export const CONTRACT_CONFLICT_SCOPE = "stage9.contract-conflict"`);
		expect(src).toContain(`allowedRoutes: ["replan-upstream"],`);
		expect(src).not.toContain(`allowedRoutes: ["replan-upstream",`);
	});

	it("escalate-now consumer-refusal: the FatalAbort branch is NOT executed for this trigger (routes back / degrades honestly)", () => {
		const src = readFileSync(new URL("../src/review/contract-conflict-consumer.ts", import.meta.url), "utf8");
		expect(src).toContain("REFUSED for the contract-conflict trigger — no FatalAbort on this route");
		expect(src).not.toMatch(/throw new FatalAbort/);
	});

	it("both convergence loops consume the flag and thread worktreePath + injectedSlice into the duty seam", () => {
		const ac = artifactConvergenceSources();
		const sc = readFileSync(new URL("../src/stages/spec-convergence.ts", import.meta.url), "utf8");
		for (const src of [ac, sc]) {
			expect(src).toContain("duty.escalateToJudge) await consumeContractConflictEscalation");
			expect(src).toContain("worktreePath: state.setup?.worktreePath");
			expect(src).toContain("injectedSlice: readContractSliceStamp(");
		}
	});

	it("the strike-1 state key is writerMetadataRetryUsed:<stage> (disjoint from 058's phaseProtectionStrikes)", () => {
		const src = readFileSync(new URL("../src/review/contract-validators.ts", import.meta.url), "utf8");
		expect(src).toContain("writerMetadataRetryUsed:${stage}");
		expect(src).not.toContain("phaseProtectionStrikes:"); // key-form disjointness (doc-comment mentions carry no colon)
	});

	it("CONTRACT_CONFLICT_SCOPE is importable and stable", () => {
		expect(CONTRACT_CONFLICT_SCOPE).toBe("stage9.contract-conflict");
	});
});

describe("059 — Check 3 amendmentFamily exemption consumer (.knowledge.json seam, fail-closed)", () => {
	const PHASES: PlanPhase[] = [
		{ name: "p-tests", deliverables: { requireTests: ["tests/profitability-contract.test.ts"] } },
		{ name: "p-screen-wiring", deliverables: { requireFiles: ["src/schemas.ts"] } },
	];

	it("amendment fixture BYPASSES Check 3 (design family wins; honest exemption scan line)", () => {
		writeWt("tests/profitability-contract.test.ts", SCENARIO_14_TEST);
		writeWt(".knowledge.json", JSON.stringify({ stages: { design: { timestamp: "t", agent: "a", data: { amendmentFamily: [{ sharedFile: "src/schemas.ts", pinsMoved: ["pin-x"], exemptions: [], docUpdates: [] }] } } } }));
		const report = planFeasibilityFindings(PHASES, wt, join(wt, ""));
		expect(report.contradictions.filter((c) => c.kind === "protection-threat")).toHaveLength(0);
		expect(report.protectionScan.some((l) => l.startsWith("check3 exemption:") && l.includes("src/schemas.ts"))).toBe(true);
	});

	it("spec family is the Stage 6-skip fallback source when design declares none", () => {
		writeWt("tests/profitability-contract.test.ts", SCENARIO_14_TEST);
		writeWt(".knowledge.json", JSON.stringify({ stages: { spec: { timestamp: "t", agent: "a", data: { amendmentFamily: [{ sharedFile: "src/schemas.ts", pinsMoved: [], exemptions: [{ pinId: "pin-x", justification: "owner-approved" }], docUpdates: [] }] } } } }));
		const report = planFeasibilityFindings(PHASES, wt, join(wt, ""));
		expect(report.contradictions.filter((c) => c.kind === "protection-threat")).toHaveLength(0);
	});

	it("malformed knowledge ⇒ ZERO exemptions (P1 behavior unchanged — threat fires)", () => {
		writeWt("tests/profitability-contract.test.ts", SCENARIO_14_TEST);
		writeWt(".knowledge.json", "{not json");
		const report = planFeasibilityFindings(PHASES, wt, join(wt, ""));
		expect(report.contradictions.filter((c) => c.kind === "protection-threat")).toHaveLength(1);
		expect(report.protectionScan.some((l) => l.includes("unparseable") && l.includes("fail-closed"))).toBe(true);
	});

	it("malformed family entry (empty sharedFile) ⇒ zero exemptions, threat fires", () => {
		writeWt("tests/profitability-contract.test.ts", SCENARIO_14_TEST);
		writeWt(".knowledge.json", JSON.stringify({ stages: { design: { data: { amendmentFamily: [{ sharedFile: "", pinsMoved: [], exemptions: [], docUpdates: [] }] } } } }));
		const report = planFeasibilityFindings(PHASES, wt, join(wt, ""));
		expect(report.contradictions.filter((c) => c.kind === "protection-threat")).toHaveLength(1);
		expect(report.protectionScan.some((l) => l.includes("malformed amendmentFamily entry"))).toBe(true);
	});

	it("no specDirectory ⇒ landed behavior unchanged (threat fires, no knowledge read)", () => {
		writeWt("tests/profitability-contract.test.ts", SCENARIO_14_TEST);
		writeWt(".knowledge.json", JSON.stringify({ stages: { design: { data: { amendmentFamily: [{ sharedFile: "src/schemas.ts", pinsMoved: [], exemptions: [], docUpdates: [] }] } } } }));
		const report = planFeasibilityFindings(PHASES, wt);
		expect(report.contradictions.filter((c) => c.kind === "protection-threat")).toHaveLength(1);
		expect(report.protectionScan.some((l) => l.startsWith("check3 exemption:"))).toBe(false);
	});

	it("implementation call site passes setup.specDirectory (059 §6 handoff contract)", () => {
		const src = implementationSources();
		expect(src).toContain("planFeasibilityFindings(phases, setup.worktreePath, setup.specDirectory)");
	});
});
