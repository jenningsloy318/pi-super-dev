/**
 * 059 R1A (Wave 2 — presentation/writer layer): deterministic pins for the
 * writer-side additions the engine modules already landed.
 *
 * Covers the handoff items 1-5:
 *   1. Template rendering of every new block (affectsSharedSurfaces intent,
 *      pinOwnership passive projection, amendmentFamily + ATAM-lite tradeoffs,
 *      spec fallback family, review-doc Loci/exempt markers, engine-written
 *      reconciliation section) — INCLUDING omit-when-absent (legacy controls
 *      render without any new marker).
 *   2. Writer prompt content pins (D-R-C writer portion) incl. slice injection.
 *   3. Stamp round-trip: writerContractSlice → stampContractSlice →
 *      readContractSliceStamp feeds the R4 evidence-pair exemption (and
 *      contractValidationContext reuses the stamp); absent stamp = fail-closed.
 *   4/5. Dual design-skip predicate fixtures (designStage routes
 *      architecture-improver for shared-surface bug fixes; empty touched-set
 *      keeps the status-quo skip) + source-contract pins for the
 *      spec-convergence residual wiring.
 */

import { describe, it, expect } from "vitest";
import { artifactConvergenceSources } from "./helpers/artifact-convergence-source.ts";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { render } from "../src/render/template-engine.ts";
import { buildBddPrompt, buildDesignPrompt, buildRequirementsPrompt, buildSpecPrompt } from "../src/prompts.ts";
import { contractSliceView, readContractSliceStamp, stampContractSlice, writerContractSlice } from "../src/review/contract-surface.ts";
import { contractValidationContext } from "../src/review/contract-validators.ts";
import { REVIEWER_DUTY_ROUND, enforceReviewerConvergenceDuty } from "../src/review-findings.ts";
import { specWriterBuildPrompt } from "../src/stages/writers.ts";
import { designStage } from "../src/stages/design.ts";
import { runHelper } from "../src/helpers.ts";
import type { AgentCall, AgentResult, ControlObj, HelperCall, PipelineState, SetupControl, StageContext } from "../src/types.ts";

const tpl = (name: string): string => readFileSync(`src/render/templates/${name}`, "utf8");

// ─── fixtures ────────────────────────────────────────────────────────────────

/** A worktree carrying ONE anchored prose pin: "pinned at exactly 14 members"
 *  over `src/schemas.ts` (the SCENARIO-014 shape, markdown/prose column). */
function pinWorktree(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	mkdirSync(join(dir, "docs/specifications/14-pins/"), { recursive: true });
	mkdirSync(join(dir, "src"), { recursive: true });
	writeFileSync(join(dir, "src/schemas.ts"), "export const REGISTRY = [\n\t// 14 entries — membership pinned by sibling specs\n];\n");
	writeFileSync(join(dir, "docs/specifications/14-pins/spec.md"), "# Dimension 14 baseline\n\nThe registry in `src/schemas.ts` is pinned at exactly 14 members.\n");
	return dir;
}

function mkSetup(dir: string): SetupControl {
	mkdirSync(join(dir, "docs/specifications/001/"), { recursive: true });
	return { worktreePath: dir, specDirectory: `${dir}/docs/specifications/001/`, defaultBranch: "main", language: "backend", isWebUi: false, specIdentifier: "001", worktreeCreated: true, initializedRepo: false };
}

const legacyRequirements = {
	title: "T", date: "2026-09-13", generatedAt: "g", type: "feature", priority: "high",
	executiveSummary: "s",
	acceptanceCriteria: [{ id: "AC-01", statement: "works" }],
	nonFunctional: ["performance stays acceptable"],
};

// ─── 1a. requirements.md.njk — Shared Surfaces (intent) ──────────────────────

describe("059 D-R-W templates — requirements.md.njk", () => {
	it("renders the Shared Surfaces (intent) block from affectsSharedSurfaces", () => {
		const out = render(tpl("requirements.md.njk"), { ...legacyRequirements, affectsSharedSurfaces: ["dimension-14 registry baseline", "src/schemas.ts"] });
		expect(out).toContain("## Shared Surfaces (intent)");
		expect(out).toContain("- dimension-14 registry baseline");
		expect(out).toContain("- src/schemas.ts");
	});

	it("omits the block when absent (legacy render carries no new marker)", () => {
		const out = render(tpl("requirements.md.njk"), legacyRequirements);
		expect(out).not.toContain("Shared Surfaces");
		expect(out).toContain("## Acceptance Criteria");
		expect(out).toContain("- **AC-01**: works");
		expect(out).toContain("## Non-Functional Requirements");
	});

	it("omits the block when the array is empty", () => {
		expect(render(tpl("requirements.md.njk"), { ...legacyRequirements, affectsSharedSurfaces: [] })).not.toContain("Shared Surfaces");
	});
});

// ─── 1b. bdd-scenarios.md.njk — Pin Ownership passive projection ─────────────

describe("059 D-R-W templates — bdd-scenarios.md.njk", () => {
	const legacyScenario = { id: "001", title: "one", acRef: "AC-01", priority: "high", given: "g", when: "w", then: "t" };
	const legacyBdd = { title: "B", date: "d", generatedAt: "g", source: "01-requirements.md", totalScenarios: 2, features: [{ name: "F", scenarios: [legacyScenario] }] };

	it("renders the per-scenario Pin Ownership line as a passive @state projection", () => {
		const out = render(tpl("bdd-scenarios.md.njk"), {
			...legacyBdd,
			features: [{ name: "F", scenarios: [{ ...legacyScenario, pinOwnership: [
				{ pinId: "pin-pe-0000abc", state: "owned", justification: "" },
				{ pinId: "pin-xn-0001def", state: "inherited-frozen", justification: "owner decision 2026-09-13" },
			] }] }],
		});
		expect(out).toContain("- **Pin Ownership**: @owned pin-pe-0000abc; @inherited-frozen pin-xn-0001def — owner decision 2026-09-13");
		// the Given/When/Then body is untouched by the projection
		expect(out).toContain("**Given** g");
	});

	it("omits the line when absent (legacy render carries no new marker)", () => {
		const out = render(tpl("bdd-scenarios.md.njk"), legacyBdd);
		expect(out).not.toContain("Pin Ownership");
		expect(out).toContain("### SCENARIO-001: one");
	});

	it("omits the line when the array is empty and leaves no blank residue", () => {
		const withEmpty = render(tpl("bdd-scenarios.md.njk"), { ...legacyBdd, features: [{ name: "F", scenarios: [{ ...legacyScenario, pinOwnership: [] }] }] });
		expect(withEmpty).not.toContain("Pin Ownership");
		expect(withEmpty).toBe(render(tpl("bdd-scenarios.md.njk"), legacyBdd));
	});
});

// ─── 1c. design.md.njk — Amendment Family + Tradeoffs (ATAM-lite) ────────────

describe("059 D-R-W templates — design.md.njk", () => {
	const legacyDesign = { title: "D", date: "d", generatedAt: "g", designer: "architecture-designer", summary: "s", modules: [{ name: "M", description: "d" }], hasNumericConstants: "no" };

	it("renders the Amendment Family block (moves, structured exemptions, doc updates)", () => {
		const out = render(tpl("design.md.njk"), { ...legacyDesign, amendmentFamily: [
			{ sharedFile: "src/schemas.ts", pinsMoved: ["pin-pe-0000abc"], exemptions: [{ pinId: "pin-xn-0001def", justification: "owner decision" }, { pinId: "pin-ot-0002fff", justification: "" }], docUpdates: ["docs/specifications/20-tool-catalog/README.md"] },
		] });
		expect(out).toContain("## Amendment Family");
		expect(out).toContain("### src/schemas.ts");
		expect(out).toContain("- **Pins moved**: pin-pe-0000abc");
		expect(out).toContain("- **Exemption**: pin-xn-0001def — owner decision");
		expect(out).toContain("- **Exemption**: pin-ot-0002fff — (EMPTY justification — a non-empty legal basis is required)");
		expect(out).toContain("- **Doc updates**: docs/specifications/20-tool-catalog/README.md");
	});

	it("renders the Tradeoffs (ATAM-lite) block", () => {
		const out = render(tpl("design.md.njk"), { ...legacyDesign, tradeoffs: [{ decision: "move the pin", favoredQuality: "consistency", sacrificedQuality: "flexibility", rationale: "the sibling spec freezes membership" }] });
		expect(out).toContain("## Tradeoffs (ATAM-lite)");
		expect(out).toContain("- **move the pin**: favors consistency, sacrifices flexibility — the sibling spec freezes membership");
	});

	it("omits both blocks when absent, and defaults empty arrays to (none)", () => {
		const legacy = render(tpl("design.md.njk"), legacyDesign);
		expect(legacy).not.toContain("Amendment Family");
		expect(legacy).not.toContain("Tradeoffs");
		const withEmptyArrays = render(tpl("design.md.njk"), { ...legacyDesign, amendmentFamily: [{ sharedFile: "src/schemas.ts", pinsMoved: [], exemptions: [], docUpdates: [] }], tradeoffs: [] });
		expect(withEmptyArrays).toContain("### src/schemas.ts");
		expect(withEmptyArrays).toContain("- **Pins moved**: (none)");
		expect(withEmptyArrays).toContain("- **Exemptions**: (none)");
		expect(withEmptyArrays).toContain("- **Doc updates**: (none)");
		expect(withEmptyArrays).not.toContain("## Tradeoffs");
	});
});

// ─── 1d. specification.md.njk — fallback Amendment Family ────────────────────

describe("059 D-R-W templates — specification.md.njk", () => {
	const legacySpec = { title: "S", date: "d", generatedAt: "g", summary: "s", architecture: "a", testingStrategy: "t", acceptanceCriteriaRefs: ["AC-01"], scenarioRefs: ["SCENARIO-001"] };

	it("renders the fallback Amendment Family block when present", () => {
		const out = render(tpl("specification.md.njk"), { ...legacySpec, amendmentFamily: [{ sharedFile: "src/schemas.ts", pinsMoved: ["pin-pe-0000abc"], exemptions: [{ pinId: "pin-xn-0001def", justification: "owner decision" }], docUpdates: [] }] });
		expect(out).toContain("## Amendment Family");
		expect(out).toContain("Stage 6-skip fallback");
		expect(out).toContain("### src/schemas.ts");
		expect(out).toContain("- **Pins moved**: pin-pe-0000abc");
	});

	it("omits the block when absent (legacy render carries no new marker)", () => {
		expect(render(tpl("specification.md.njk"), legacySpec)).not.toContain("Amendment Family");
	});
});

// ─── 1e/1f. review docs — Loci line + exempt marker + reconciliation ─────────

const legacyFinding = { id: "F-1", severity: "high", title: "t", detail: "the detail text", ownerStage: "spec", blocking: true, status: "open" };
const reviewData = { title: "R", date: "d", generatedAt: "g", verdict: "Approved", summary: "s", findings: [legacyFinding], dimensions: [{ name: "Consistency", status: "pass", notes: "n" }] };

describe("059 D-R-E templates — review docs render Loci + evidence-pair marker", () => {
	for (const name of ["spec-review.md.njk", "requirements-review.md.njk", "bdd-review.md.njk", "design-review.md.njk"]) {
		it(`${name}: renders the per-finding Loci line and the exempt marker`, () => {
			const out = render(tpl(name), {
				...reviewData,
				findings: [{ ...legacyFinding, evidenceLoci: [{ file: "src/schemas.ts", line: 12, ref: "pin-pe-0000abc" }, { file: "docs/specifications/14-pins/spec.md" }], evidencePairExempt: true }],
			});
			expect(out).toContain("- **Loci**: src/schemas.ts:12 (pin-pe-0000abc); docs/specifications/14-pins/spec.md");
			expect(out).toContain("**[evidence-pair exempt]**");
			expect(out).toContain("the detail text");
		});

		it(`${name}: omits both when the finding carries neither (legacy render)`, () => {
			const out = render(tpl(name), reviewData);
			expect(out).not.toContain("Loci");
			expect(out).not.toContain("evidence-pair exempt");
			expect(out).toContain("the detail text");
		});

		it(`${name}: empty evidenceLoci array renders no Loci line`, () => {
			expect(render(tpl(name), { ...reviewData, findings: [{ ...legacyFinding, evidenceLoci: [] }] })).not.toContain("Loci");
		});
	}

	it("spec-review.md.njk: renders the engine-written contractInventoryReconciliation section, omit-when-absent", () => {
		const section = "## Contract Inventory Reconciliation (engine-written — deterministic cross-check; D2 must cite this)\n- inventory pins: 1 across 1 protected file(s); unanchored: 0\n- set-inclusion: OK";
		const withSection = render(tpl("spec-review.md.njk"), { ...reviewData, contractInventoryReconciliation: section });
		expect(withSection).toContain("## Contract Inventory Reconciliation (engine-written");
		expect(withSection).toContain("- set-inclusion: OK");
		expect(render(tpl("spec-review.md.njk"), reviewData)).not.toContain("Contract Inventory Reconciliation");
	});
});

// ─── 2. writer prompt content pins (D-R-C writer portion) ────────────────────

const ctl = { language: "backend", isWebUi: false } as unknown as Parameters<typeof buildRequirementsPrompt>[0];
const SLICE_BLOCK = "## Contract Surface Slice — shared baseline pins this change may touch\n- src/schemas.ts: pin-pe-0000abc exactly-n-membership @ docs/specifications/14-pins/spec.md:3 — The registry in `src/schemas.ts` is pinned at exactly 14 members.";

describe("059 D-R-C — buildRequirementsPrompt (W2/W6)", () => {
	it("carries the affectsSharedSurfaces intent instructions, the ADVISORY-labeled EARS line, the W6 self-check, and layerW", () => {
		const p = buildRequirementsPrompt(ctl, null, "t");
		expect(p).toContain("affectsSharedSurfaces");
		expect(p).toContain("INTENT-LEVEL hints");
		expect(p).toContain("ADVISORY — EARS-style syntax (style only; reviewers must NEVER block on non-conformance)");
		expect(p).toContain("## Self-check before returning (059 W6");
		expect(p).toContain('layerW is the literal string "1"');
		expect(p).not.toContain("## Contract Surface Slice — shared baseline pins");
	});

	it("injects the contract-surface slice block when provided (W1)", () => {
		const p = buildRequirementsPrompt(ctl, null, "t", SLICE_BLOCK);
		expect(p).toContain(SLICE_BLOCK);
		expect(p.indexOf("Contract Surface Slice")).toBeGreaterThan(p.indexOf("## Task"));
	});
});

describe("059 D-R-C — buildBddPrompt (W3)", () => {
	it("carries the typed pinOwnership FIELD instructions (never prose tags), transition discipline, and the advisory canon", () => {
		const p = buildBddPrompt(ctl, null, "t", null);
		expect(p).toContain("PIN OWNERSHIP (059 Layer W3)");
		expect(p).toContain("NEVER write @owned/@inherited prose tags");
		expect(p).toContain("inherited-frozen");
		expect(p).toContain("GUARDED TRANSITION");
		expect(p).toContain("ADVISORY — scenario canon (style only; reviewers must never block on non-conformance)");
		expect(p).toContain("one behavior per scenario");
		expect(p).not.toContain("## Contract Surface Slice — shared baseline pins");
	});

	it("injects the contract-surface slice block when provided (W1)", () => {
		const p = buildBddPrompt(ctl, null, "t", null, SLICE_BLOCK);
		expect(p).toContain(SLICE_BLOCK);
	});
});

describe("059 D-R-C — buildDesignPrompt (W4)", () => {
	it("carries the amendmentFamily/tradeoffs block specs and the ATAM-lite advisory", () => {
		const p = buildDesignPrompt(ctl, null, "t", null, null, null, "architecture-designer");
		expect(p).toContain("AMENDMENT FAMILY (059 Layer W4");
		expect(p).toContain("TRADEOFFS (059 Layer W4, ATAM-lite)");
		expect(p).toContain("amendmentFamily");
		expect(p).toContain("ADVISORY on quality judgment");
		expect(p).not.toContain("## Contract Surface Slice — shared baseline pins");
	});

	it("injects the contract-surface slice block when provided (W1)", () => {
		const p = buildDesignPrompt(ctl, null, "t", null, null, null, "architecture-designer", SLICE_BLOCK);
		expect(p).toContain(SLICE_BLOCK);
	});
});

describe("059 D-R-C — buildSpecPrompt (W5)", () => {
	it("carries family propagation, pinId grounding, and the Stage 6-skip fallback declaration", () => {
		const p = buildSpecPrompt(ctl, null, "t", null, null, null, null, null, null);
		expect(p).toContain("AMENDMENT FAMILY PROPAGATION (059 Layer W5)");
		expect(p).toContain("cite ONLY pinIds present in the injected slice");
		expect(p).toContain("STAGE 6-SKIP FALLBACK (059 Layer W5)");
		expect(p).toContain("the specification ITSELF carries the concrete `amendmentFamily`");
		expect(p).not.toContain("## Contract Surface Slice — shared baseline pins");
	});

	it("injects the contract-surface slice block when provided (W1)", () => {
		const p = buildSpecPrompt(ctl, null, "t", null, null, null, null, null, null, "", SLICE_BLOCK);
		expect(p).toContain(SLICE_BLOCK);
	});
});

// ─── 3. stamp round-trip (write→read feeds the R4 duty) ──────────────────────

describe("059 W1 stamp round-trip — the writer's slice feeds the R4 exemption", () => {
	it("writerContractSlice → stampContractSlice → readContractSliceStamp exempts an evidence-pair finding; absent stamp stays fail-closed", () => {
		const dir = pinWorktree("c059-duty-");
		try {
			const slice = writerContractSlice(dir, ["fix the registry in `src/schemas.ts`"]);
			expect(slice).not.toBeNull();
			expect(slice!.files).toContain("src/schemas.ts");
			expect(slice!.pinIds.length).toBeGreaterThan(0);
			const pinId = slice!.pinIds[0]!;

			const state = { setup: { worktreePath: dir } } as unknown as PipelineState;
			stampContractSlice(state as unknown as Record<string, unknown>, "spec", slice!);
			const stamp = readContractSliceStamp(state as unknown as Record<string, unknown>, "spec");
			expect(stamp).toBeDefined();
			expect(contractSliceView(stamp).files).toContain("src/schemas.ts");

			// contractValidationContext REUSES the stamp (the spec writer's slice view) — no re-walk needed.
			const cctx = contractValidationContext(state as unknown as Record<string, unknown>, "spec", ["fix the registry in `src/schemas.ts`"]);
			expect(cctx).not.toBeNull();
			expect(cctx!.slice.files).toContain("src/schemas.ts");

			const finding = { id: "F-1", severity: "medium", title: "pin conflict", detail: "d", ownerStage: "spec", blocking: true, evidenceLoci: [{ file: "src/schemas.ts", line: 1, ref: pinId }, { file: "docs/specifications/14-pins/spec.md", line: 3 }] };
			const review = { verdict: "Changes Requested", findings: [finding] } as unknown as ControlObj;
			const duty = enforceReviewerConvergenceDuty(review, REVIEWER_DUTY_ROUND + 1, {
				stage: "spec",
				knownFindingIds: new Set<string>(),
				knownBlockingFingerprints: new Set<string>(),
				reviewSourceGate: "spec-review",
				worktreePath: dir,
				injectedSlice: readContractSliceStamp(state as unknown as Record<string, unknown>, "spec"),
			});
			expect(duty.exemptCount).toBe(1);
			expect(duty.escalateToJudge).toBe(false);
			const rows = review.findings as Array<{ blocking?: boolean; evidencePairExempt?: boolean }>;
			expect(rows[0]!.evidencePairExempt).toBe(true);
			expect(rows[0]!.blocking).toBe(true); // survives the suppression

			// fail-closed: the SAME finding with NO stamp gets no exemption — downgraded.
			const review2 = { verdict: "Changes Requested", findings: [{ ...finding, evidenceLoci: [...finding.evidenceLoci] }] } as unknown as ControlObj;
			const duty2 = enforceReviewerConvergenceDuty(review2, REVIEWER_DUTY_ROUND + 1, {
				stage: "spec",
				knownFindingIds: new Set<string>(),
				knownBlockingFingerprints: new Set<string>(),
				reviewSourceGate: "spec-review",
				worktreePath: dir,
			});
			expect(duty2.exemptCount).toBe(0);
			const rows2 = review2.findings as Array<{ blocking?: boolean; downgradeReason?: string }>;
			expect(rows2[0]!.blocking).toBe(false);
			expect(rows2[0]!.downgradeReason).toBeTruthy();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	// Adversarial S8 (v0.3.98): the stamp must be produced by the WRITER's own
	// buildPrompt side effect — not by a test calling stampContractSlice by hand.
	it("specWriter.buildPrompt stamps the write-time slice as a real side effect (prompt carries the slice block)", () => {
		const dir = pinWorktree("c059-wstamp-");
		try {
			const state = { setup: { worktreePath: dir }, classify: null, requirements: null, bdd: null, research: null, assessment: null, design: null, prototype: null } as unknown as PipelineState;
			const prompt = specWriterBuildPrompt(state, designCtx(state, "fix the registry in `src/schemas.ts`", []));
			expect(prompt).toContain("Contract Surface Slice");
			const stamp = readContractSliceStamp(state as unknown as Record<string, unknown>, "spec");
			expect(stamp).toBeDefined();
			expect(contractSliceView(stamp).files).toContain("src/schemas.ts");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

// ─── 5. dual design-skip predicate fixtures ─────────────────────────────────

const designControl = { title: "d", date: "2026-09-13", summary: "s", designer: "architecture-improver", layerW: "1", modules: [{ name: "M", description: "d" }], hasNumericConstants: "no" } as unknown as ControlObj;

function designCtx(state: PipelineState, task: string, agents: string[]): StageContext {
	return {
		task, options: {}, state,
		budget: { count: 0, check: () => true, spent() { return true; } },
		log() {}, phase() {}, events: new EventEmitter(), results: [],
		async agent(call: AgentCall): Promise<AgentResult> { agents.push(call.agent ?? ""); return { text: "", control: designControl }; },
		async helper(call: HelperCall) { return runHelper(call); },
		async parallel(calls: unknown[]) { return Promise.all((calls as Array<() => unknown>).map((c) => c())); },
	} as unknown as StageContext;
}

describe("059 §3 R3 delta-5 NEW-3 — dual design-skip predicate (stage arm)", () => {
	it("bug + EMPTY touched-set ⇒ status-quo skip (null, no agent), empty stamp recorded", async () => {
		const dir = mkdtempSync(join(tmpdir(), "c059-skip-"));
		try {
			const s = mkSetup(dir);
			const state = { setup: s, classify: { taskType: "bug", uiScope: "none" } } as unknown as PipelineState;
			const agents: string[] = [];
			const out = await designStage.run(state, designCtx(state, "fix the typo in the readme", agents));
			expect(out).toBeNull();
			expect(agents).toEqual([]);
			const stamp = readContractSliceStamp(state as unknown as Record<string, unknown>, "design");
			expect(stamp).toBeDefined(); // stamped even on the skip path — the node predicate reads it
			expect(stamp!.files.size).toBe(0); // empty touched-set ⇒ the node's skipped predicate stays true
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("bug + NON-EMPTY touched-set ⇒ routes architecture-improver instead of skipping (the authoritative family gate runs)", async () => {
		const dir = pinWorktree("c059-route-");
		try {
			const s = mkSetup(dir);
			const state = { setup: s, classify: { taskType: "bug", uiScope: "none" } } as unknown as PipelineState;
			const agents: string[] = [];
			const out = await designStage.run(state, designCtx(state, "fix the registry handling in `src/schemas.ts`", agents));
			expect(out).toBe(designControl); // the designer RAN
			expect(agents).toEqual(["architecture-improver"]); // dual predicate routing, not a skip
			const stamp = readContractSliceStamp(state as unknown as Record<string, unknown>, "design");
			expect(stamp!.files.has("src/schemas.ts")).toBe(true); // non-empty stamp ⇒ node skipped predicate is FALSE
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("non-bug classification keeps the baseline routing (architecture-designer for a feature)", async () => {
		const dir = mkdtempSync(join(tmpdir(), "c059-feat-"));
		try {
			const s = mkSetup(dir);
			const state = { setup: s, classify: { taskType: "feature", uiScope: "none" } } as unknown as PipelineState;
			const agents: string[] = [];
			const out = await designStage.run(state, designCtx(state, "add a new feature", agents));
			expect(out).toBe(designControl);
			expect(agents).toEqual(["architecture-designer"]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

// ─── source-contract pins (node arm + wiring) ───────────────────────────────

describe("059 R1A residual wiring — source-contract pins", () => {
	it("designConvergenceNode.skipped consults the write-time touched-set stamp (node arm of the dual predicate)", () => {
		const src = artifactConvergenceSources();
		const node = src.slice(src.indexOf("export const designConvergenceNode"));
		expect(node).toContain("readContractSliceStamp");
		expect(node).toContain("stamp.files.size === 0"); // touched-empty ⇒ skip; absent stamp ⇒ status-quo skip
		expect(node.slice(0, 1400)).not.toContain("fastForwardable: true"); // prior pin preserved
	});

	it("writers.ts computes + stamps the write-time slice for requirements/bdd/spec and passes slice.block into the builders", () => {
		const src = readFileSync("src/stages/writers.ts", "utf8");
		expect(src).toContain("writerContractSlice(");
		for (const stage of ["requirements", "bdd", "spec"]) {
			expect(src).toContain(`stampContractSlice(state as Record<string, unknown>, "${stage}", slice)`);
		}
		expect(src).toContain("slice?.block ?? \"\"");
	});

	// NOTE (adversarial S8): source-string pins are REGRESSION TRIWIRES (cheap
	// drift alarms), NOT behavioral proof — the behavioral coverage for the
	// strike-recheck seam lives in the S3 fix and the writer-side stamp test above.
	it("spec-convergence wires the Stage 6-skip fallback validator, the Metadata Strike-1 at the trace seam, and the reconciliation stamping (regression tripwires)", () => {
		const src = readFileSync("src/stages/spec-convergence.ts", "utf8");
		expect(src).toContain("specFamilyFallbackAfterTrace");
		expect(src).toContain("specAmendmentFamilyFindings");
		expect(src).toContain('writerMetadataStrikeKey("spec")');
		expect(src).toContain("writerMetadataRepairFeedback");
		expect(src).toContain("contractInventoryReconciliationSection");
		expect(src).toContain("familyInclusionMismatches");
		expect(src).toContain("contractInventoryReconciliation = section");
	});
});
