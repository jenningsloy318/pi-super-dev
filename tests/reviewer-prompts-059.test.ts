/**
 * 059 R1B (Wave 4 — D-R-C reviewer portion): deterministic pins for the
 * reviewer-side slice injection + per-reviewer duty lines in
 * buildUpstreamReviewPrompt / buildSpecReviewPrompt, the writers.ts
 * stamp→slice plumbing (readContractSliceStamp → reviewerContractSliceBlock),
 * and the additive-only property (landed prompt pins unchanged).
 * Deterministic only — live reviewer catch-rate is explicitly NOT an R1B gate
 * (059 §7); the R2 harness measures it offline.
 */

import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSpecReviewPrompt, buildUpstreamReviewPrompt } from "../src/prompts.ts";
import { CONTRACT_INVENTORY_ERROR_BANNER, stampContractSlice, writerContractSlice } from "../src/review/contract-surface.ts";
import { reviewerContractSliceBlock } from "../src/stages/writers.ts";
import type { PipelineState, SetupControl } from "../src/types.ts";

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

const ctl = { language: "backend", isWebUi: false } as unknown as SetupControl;

const SLICE_BLOCK = "## Contract Surface Slice — shared baseline pins this change may touch\n- src/schemas.ts: pin-xn-0000abc exactly-n-membership @ docs/specifications/14-pins/spec.md:3 — The registry in `src/schemas.ts` is pinned at exactly 14 members.";

/** Distinctive substrings of the three per-reviewer duty lines (exclusivity
 *  pins: each stage carries exactly its own line). */
const DUTY = {
	requirements: "via intent-level affectsSharedSurfaces hints",
	bdd: "or be marked inherited-frozen with a non-empty justification",
	design: "must cover (⊇ set-inclusion) ALL inventory pins on touched shared surfaces",
} as const;

const CROSSCHECK_LINE = "Cross-check every claim in the reviewed artifact against these pins; pinIds are grounded claims";
const EVIDENCE_PAIR_LINE = "cite evidenceLoci [{file, line?, ref?}] for BOTH sides of the conflict";
const ORDER_NEUTRALITY_LINE = "Artifact-order neutrality: weigh every upstream artifact equally";

// ─── buildUpstreamReviewPrompt — slice injection ─────────────────────────────

describe("059 R1B — buildUpstreamReviewPrompt slice injection", () => {
	it("injects the slice section (block + the one cross-check instruction line) when contractSliceBlock is provided", () => {
		const p = buildUpstreamReviewPrompt(ctl, null, { stage: "requirements", upstream: [], contractSliceBlock: SLICE_BLOCK });
		expect(p).toContain(SLICE_BLOCK);
		expect(p).toContain(CROSSCHECK_LINE);
		// placed after the artifact header / prior responses, before Instructions
		expect(p.indexOf("Contract Surface Slice")).toBeGreaterThan(p.indexOf("## requirements artifact to review"));
		expect(p.indexOf("Contract Surface Slice")).toBeLessThan(p.indexOf("## Instructions"));
	});

	it("omits the section entirely when the block is absent/empty (fail-closed harmless)", () => {
		for (const stage of ["requirements", "bdd", "design"] as const) {
			const p = buildUpstreamReviewPrompt(ctl, null, { stage, upstream: [] });
			expect(p).not.toContain("## Contract Surface Slice");
			expect(p).not.toContain(CROSSCHECK_LINE);
		}
	});

	it("the injected slice rides the untrusted-data fence (AC-31 — pin statements are sibling-prose, hostile-origin text)", () => {
		const p = buildUpstreamReviewPrompt(ctl, null, { stage: "requirements", upstream: [], contractSliceBlock: SLICE_BLOCK });
		expect(p).toContain("untrusted contract surface slice");
		expect(p).toContain("- src/schemas.ts: pin-xn-0000abc exactly-n-membership");
		expect(p).toContain(CROSSCHECK_LINE);
		const spec = buildSpecReviewPrompt({ language: "backend", isWebUi: false } as unknown as SetupControl, null, null, SLICE_BLOCK);
		expect(spec).toContain("untrusted contract surface slice");
	});
});

// ─── buildUpstreamReviewPrompt — duty lines + R4 + order-neutrality ──────────

describe("059 R1B — per-reviewer duty lines (one line each, specialized)", () => {
	it("requirements: exactly its own checklist line (bdd/design lines absent)", () => {
		const p = buildUpstreamReviewPrompt(ctl, null, { stage: "requirements", upstream: [] });
		expect(p).toContain(`Reviewer checklist (059 §3 R3): verify every AC declaring shared-file changes declares its amendment family — at this stage ${DUTY.requirements}`);
		expect(p).not.toContain(DUTY.bdd);
		expect(p).not.toContain(DUTY.design);
	});

	it("bdd: exactly its own checklist line (requirements/design lines absent)", () => {
		const p = buildUpstreamReviewPrompt(ctl, null, { stage: "bdd", upstream: [] });
		expect(p).toContain(`every baseline-pinning scenario must belong to this spec's amendment family (pinOwnership state='owned') ${DUTY.bdd}`);
		expect(p).not.toContain(DUTY.requirements);
		expect(p).not.toContain(DUTY.design);
	});

	it("design: exactly its own checklist line (requirements/bdd lines absent)", () => {
		const p = buildUpstreamReviewPrompt(ctl, null, { stage: "design", upstream: [] });
		expect(p).toContain(`the declared amendmentFamily ${DUTY.design}`);
		expect(p).not.toContain(DUTY.requirements);
		expect(p).not.toContain(DUTY.bdd);
	});

	it("every stage carries the R4 evidence-pair instruction and the artifact-order neutrality line", () => {
		for (const stage of ["requirements", "bdd", "design"] as const) {
			const p = buildUpstreamReviewPrompt(ctl, null, { stage, upstream: [] });
			expect(p).toContain(EVIDENCE_PAIR_LINE);
			expect(p).toContain(ORDER_NEUTRALITY_LINE);
		}
	});

	it("additive-only: landed upstream-review prompt pins unchanged", () => {
		const p = buildUpstreamReviewPrompt(ctl, null, { stage: "design", upstream: [{ label: "Requirements", path: "01-requirements.md" }] });
		expect(p).toContain("Speculation that a change might break something elsewhere is not a finding"); // R-C calibration line untouched
		expect(p).toContain("Use verdict 'Changes Requested' when any blocking finding exists");
		expect(p).toContain("Convergence duty (review-loop contract)");
		expect(p).toContain("## Data to return");
		expect(p).toContain("Output <control> JSON with: title, date, verdict, summary, findings, priorFindingResolutions?, dimensions.");
	});
});

// ─── buildSpecReviewPrompt — slice + D2 duty + R4 + order-neutrality ─────────

describe("059 R1B — buildSpecReviewPrompt (slice + D2 upgrade)", () => {
	it("injects the slice section via the additive 4th param (block + cross-check line); omitted when empty", () => {
		const withSlice = buildSpecReviewPrompt(ctl, null, null, SLICE_BLOCK);
		expect(withSlice).toContain(SLICE_BLOCK);
		expect(withSlice).toContain(CROSSCHECK_LINE);
		expect(withSlice.indexOf("Contract Surface Slice")).toBeGreaterThan(withSlice.indexOf("## Specification to Review"));
		expect(withSlice.indexOf("Contract Surface Slice")).toBeLessThan(withSlice.indexOf("## Instructions"));
		const without = buildSpecReviewPrompt(ctl, null, null);
		expect(without).not.toContain("## Contract Surface Slice");
		expect(without).not.toContain(CROSSCHECK_LINE);
	});

	it("the D2 duty line references the engine-written reconciliation section — never duplicates it inline", () => {
		const p = buildSpecReviewPrompt(ctl, null, null);
		expect(p).toContain("D2 Consistency dimension is the cross-artifact obligation-consistency check");
		expect(p).toContain("Contract Inventory Reconciliation section rendered into the review document");
		// reference, not duplicate: the engine-written section itself (rendered into
		// the review DOC by spec-convergence) never appears in the prompt.
		expect(p).not.toContain("## Contract Inventory Reconciliation (engine-written");
		expect(p).not.toContain("set-inclusion: OK");
	});

	it("carries the R4 evidence-pair instruction and the order-neutrality line", () => {
		const p = buildSpecReviewPrompt(ctl, null, null);
		expect(p).toContain(EVIDENCE_PAIR_LINE);
		expect(p).toContain(ORDER_NEUTRALITY_LINE);
	});

	it("additive-only: landed spec-review prompt pins unchanged", () => {
		const p = buildSpecReviewPrompt(ctl, null, { specificationPath: "/tmp/s.md", phaseCount: 2 });
		expect(p).toContain("Review the specification across these 8 required quality dimensions: Completeness, Consistency, Feasibility, Testability, Traceability, Grounding, Complexity, and Ambiguity.");
		expect(p).toContain("Testability specifically:");
		expect(p).toContain("Speculation that a change might break something elsewhere is not a finding");
		expect(p).toContain("Output <control> JSON with: title, date, verdict, summary, findings, priorFindingResolutions?, dimensions.");
	});
});

// ─── writers.ts stamp→slice plumbing ─────────────────────────────────────────

describe("059 R1B — reviewerContractSliceBlock (stamp → reviewer slice)", () => {
	it("re-renders the writer's stamped slice from a real worktree (header + pin line + locus)", () => {
		const dir = pinWorktree("c059-r1b-");
		try {
			const state = { setup: { worktreePath: dir } } as unknown as PipelineState;
			const slice = writerContractSlice(dir, ["fix the registry in `src/schemas.ts`"]);
			expect(slice).not.toBeNull();
			stampContractSlice(state as unknown as Record<string, unknown>, "requirements", slice!);
			const block = reviewerContractSliceBlock(state, "requirements");
			expect(block).toContain("## Contract Surface Slice — shared baseline pins this change may touch");
			expect(block).toContain("- src/schemas.ts: pin-");
			expect(block).toContain("@ docs/specifications/14-pins/spec.md:3");
			expect(block).toContain("exactly-n-membership");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("tree drift between write and review ⇒ \"\" (stamp-fidelity guard — never a silent partial slice)", () => {
		const dir = pinWorktree("c059-r1b-drift-");
		try {
			const state = { setup: { worktreePath: dir } } as unknown as PipelineState;
			const slice = writerContractSlice(dir, ["fix the registry in `src/schemas.ts`"]);
			expect(slice).not.toBeNull();
			const drifted = { ...slice!, pinIds: [...slice!.pinIds, "pin-drifted-ghost"] };
			stampContractSlice(state as unknown as Record<string, unknown>, "requirements", drifted);
			expect(reviewerContractSliceBlock(state, "requirements")).toBe("");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("carries the DEC-4 fail-loud banner when the fresh walk reports extraction errors", () => {
		const dir = pinWorktree("c059-r1b-err-");
		try {
			// a present-but-unparseable repo-invariants.json is a DEC-4 error line.
			writeFileSync(join(dir, "repo-invariants.json"), "{oops");
			const state = { setup: { worktreePath: dir } } as unknown as PipelineState;
			const slice = writerContractSlice(dir, ["fix the registry in `src/schemas.ts`"]);
			expect(slice).not.toBeNull();
			stampContractSlice(state as unknown as Record<string, unknown>, "spec", slice!);
			const block = reviewerContractSliceBlock(state, "spec");
			expect(block).toContain(CONTRACT_INVENTORY_ERROR_BANNER);
			expect(block).toContain("- extraction:");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("no stamp / empty touched-set stamp / absent worktree ⇒ \"\" (fail-closed harmless, the S5 degrade policy)", () => {
		const dir = pinWorktree("c059-r1b-closed-");
		try {
			const state = { setup: { worktreePath: dir } } as unknown as PipelineState;
			expect(reviewerContractSliceBlock(state, "requirements")).toBe(""); // no stamp
			const empty = writerContractSlice(dir, ["unrelated task touching nothing shared"]);
			expect(empty).not.toBeNull();
			stampContractSlice(state as unknown as Record<string, unknown>, "requirements", empty!);
			expect(reviewerContractSliceBlock(state, "requirements")).toBe(""); // stamped but empty touched-set
			expect(reviewerContractSliceBlock({ setup: undefined } as unknown as PipelineState, "requirements")).toBe(""); // absent worktree
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("end-to-end: the rendered requirements-review prompt carries slice + cross-check + its duty line from a stamped state", () => {
		const dir = pinWorktree("c059-r1b-e2e-");
		try {
			const state = { setup: { worktreePath: dir }, classify: null } as unknown as PipelineState;
			const slice = writerContractSlice(dir, ["fix the registry in `src/schemas.ts`"]);
			stampContractSlice(state as unknown as Record<string, unknown>, "requirements", slice!);
			const prompt = buildUpstreamReviewPrompt((state.setup as SetupControl), null, {
				stage: "requirements",
				docPath: "docs/specifications/14-pins/01-requirements.md",
				upstream: [],
				contractSliceBlock: reviewerContractSliceBlock(state, "requirements"),
			});
			expect(prompt).toContain("## Contract Surface Slice — shared baseline pins this change may touch");
			expect(prompt).toContain("- src/schemas.ts: pin-");
			expect(prompt).toContain(CROSSCHECK_LINE);
			expect(prompt).toContain(DUTY.requirements);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	// NOTE: source-string pins are REGRESSION TRIPIWIRES (cheap drift alarms),
	// NOT behavioral proof — the behavioral coverage is the tests above
	// (mirrors the landed S8 note in contract-writers-059.test.ts).
	it("all four reviewer wrappers pass the stamped slice block (source-contract tripwires)", () => {
		const src = readFileSync("src/stages/writers.ts", "utf8");
		for (const stage of ["requirements", "bdd", "design"]) {
			expect(src).toContain(`contractSliceBlock: reviewerContractSliceBlock(state, "${stage}")`);
		}
		expect(src).toContain('P.buildSpecReviewPrompt(S(state), state.classify ?? null, state.spec ?? null, reviewerContractSliceBlock(state, "spec"))');
	});
});
