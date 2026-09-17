import { bddComplete, requirementsComplete, researchComplete } from "./validators.ts";
import { artifactConvergenceNode } from "./node.ts";
import { ArtifactValidator } from "./validators.ts";
/** nodes — the four stage convergence-node wirings (split from artifact-convergence.ts at v0.4.17e). */
import { task } from "../../nodes.ts";
import type { ControlObj, PipelineState, Stage, StageContext } from "../../types.ts";
import {readStateSliceStamp } from "../../review/contract-surface/index.ts";
import { contractValidationContext, designAmendmentFamilyFindings, selfSpecArtifactMatcher, splitContractFindings, stageWriteClaimGate } from "../../review/contract-validators.ts";
import { designContractsErrors, readSpecDoc } from "../../doc-validators.ts";
import { bddReviewWriter, bddWriter, designReviewWriter, requirementsReviewWriter, requirementsWriter, researchWriter } from "../writers.ts";
import { designStage } from "../design.ts";
export const requirementsConvergenceNode = artifactConvergenceNode({
	fastForwardable: true,
	stage: requirementsWriter,
	feedbackKey: "requirements",
	validate: requirementsComplete,
	expected: "An implementation-ready requirements document with concrete AC-NN acceptance criteria, non-functional requirements, and no unresolved open questions.",
	nextAction: "Rewrite the requirements artifact to resolve every open question into explicit acceptance criteria or non-functional constraints before calling structured_output.",
	review: { stage: requirementsReviewWriter, reviewStateKey: "requirementsReview", ownerStage: "requirements" },
});

export const bddConvergenceNode = artifactConvergenceNode({
	fastForwardable: true,
	stage: bddWriter,
	feedbackKey: "bdd",
	validate: bddComplete,
	expected: "BDD scenarios that cover every requirements AC-NN with no dangling acceptance-criteria references.",
	nextAction: "Rewrite the complete BDD artifact so every AC-NN has scenario coverage, preserving valid scenarios and adding the missing edge/error paths before calling structured_output.",
	review: { stage: bddReviewWriter, reviewStateKey: "bddReview", ownerStage: "bdd" },
});

export const researchConvergenceNode = artifactConvergenceNode({
	stage: researchWriter,
	feedbackKey: "research",
	validate: researchComplete,
	expected: "A source-backed research report with every answerable open issue resolved before downstream assessment/spec work starts.",
	nextAction: "Continue online research until each open issue is answered with source evidence. If a question is genuinely unresolvable because tools are unavailable, explicitly disclose that and mark affected claims unverified instead of leaving it in openIssues.",
});

/** v0.3.2 C1: the design stage's deterministic sensor. Historically the design
 *  had NO deterministic gate (quality judged only by the reviewer) — which is
 *  exactly how run 2026-08-20T06-19-50-494Z died: a machine-checkable contract
 *  inconsistency (over-restrictive artifact-name validation) was discovered by
 *  the reviewer one filename family per round across 4 rounds. When the design
 *  control DECLARES contract claims, this validator checks internal consistency
 *  (pattern compiles; every enumerated value matches its own pattern — ALL
 *  violations at once; source anchor exists; uniqueness holds) AND that the
 *  rendered doc actually carries the Contract Claims section (the
 *  control-had-data-the-template-dropped class, run 2026-08-12). No claims ⇒
 *  pass unchanged (backward-compatible). */
export const designComplete: ArtifactValidator = async (s: PipelineState, ctx: StageContext) => {
	const control = s.design as ControlObj | undefined;
	const rawClaims = (control as { contracts?: unknown } | undefined)?.contracts;
	if (!Array.isArray(rawClaims) || rawClaims.length === 0) {
		// v0.3.2 no-claims fast path preserved — but the 059 family check still
		// runs when a contract-surface context exists (touched surfaces may carry
		// pins even when the design declares no contract claims).
		const contractCtx = contractValidationContext(s as Record<string, unknown>, "design", [ctx.task, JSON.stringify(s.requirements ?? {})]);
		if (contractCtx) {
			const { blocking, advisory } = splitContractFindings(designAmendmentFamilyFindings({ control: control as Record<string, unknown> | undefined, slice: contractCtx.slice, inventory: contractCtx.inventory, selfArtifactMatch: selfSpecArtifactMatcher(s.setup?.specDirectory, "-design.md") }));
			for (const a of advisory) ctx.log(`Design contract-validator (advisory): ${a}`);
			if (blocking.length > 0) {
				ctx.log(`Design amendment-family: ${blocking.length} set-inclusion error(s): ${blocking.slice(0, 2).join("; ")}`);
				return { pass: false, errors: blocking };
			}
		}
		// 065 D-F-B (Gate W, CONCRETE — blocking at design, the typed-family home
		// per 059 W4/grill R6 HIGH-1): fresh post-render walk over the design doc.
		const designGateWNoClaims = stageWriteClaimGate({ stage: "design", level: "concrete", state: s as Record<string, unknown>, control: control as Record<string, unknown> | undefined, docGlobs: ["*-design.md"] });
		for (const a of designGateWNoClaims.filter((f) => f.kind === "advisory")) ctx.log(`Design Gate-W (advisory): ${a.message.slice(0, 200)}`);
		const designGateWNoClaimsBlocking = designGateWNoClaims.filter((f) => f.kind === "blocking").map((f) => f.message);
		if (designGateWNoClaimsBlocking.length > 0) {
			ctx.log(`Design Gate-W: ${designGateWNoClaimsBlocking.length} typed-closure error(s): ${designGateWNoClaimsBlocking.slice(0, 2).join("; ")}`);
			return { pass: false, errors: designGateWNoClaimsBlocking };
		}
		return { pass: true, errors: [] };
	}
	const worktreePath = s.setup?.worktreePath ?? "";
	const errors = designContractsErrors(control, worktreePath);
	// 059 R1A R3(a): DesignData.amendmentFamily ⊇ pins set-inclusion — the
	// AUTHORITATIVE declaration check (blocking, ownerStage=design).
	const contractCtx = contractValidationContext(s as Record<string, unknown>, "design", [ctx.task, JSON.stringify(s.requirements ?? {})]);
	if (contractCtx) {
		const { blocking, advisory } = splitContractFindings(designAmendmentFamilyFindings({ control: control as Record<string, unknown> | undefined, slice: contractCtx.slice, inventory: contractCtx.inventory, selfArtifactMatch: selfSpecArtifactMatcher(s.setup?.specDirectory, "-design.md") }));
			for (const a of advisory) ctx.log(`Design contract-validator (advisory): ${a}`);
			errors.push(...blocking);
	}
	// 065 D-F-B (Gate W, CONCRETE — blocking at design; the with-claims path).
	for (const f of stageWriteClaimGate({ stage: "design", level: "concrete", state: s as Record<string, unknown>, control: control as Record<string, unknown> | undefined, docGlobs: ["*-design.md"] })) {
		if (f.kind === "advisory") ctx.log(`Design Gate-W (advisory): ${f.message.slice(0, 200)}`);
		else errors.push(f.message);
	}
	// Rendered-doc parity: the reviewer reads the RENDERED design — a contracts
	// block the template dropped makes the reviewer blind and the loop spin.
	const doc = readSpecDoc(s.setup?.specDirectory ?? "", control, "*-design.md");
	if (doc && !doc.content.includes("## Contract Claims")) {
		errors.push("design declares contract claims but the rendered design doc has no '## Contract Claims' section — the enumeration must be visible to the reviewer");
	}
	if (errors.length) ctx.log(`Design contracts: ${errors.length} contract-claim error(s): ${errors.slice(0, 2).join("; ")}`);
	return { pass: errors.length === 0, errors };
};

/** Stage 6 design convergence: since v0.3.2 the design carries ONE deterministic
 *  sensor (`designComplete` — contract-claims consistency; a no-op when the
 *  design declares no contracts); overall quality is judged by the
 *  design-reviewer's Fagan-style inspection, and it may be
 *  SKIPPED entirely for bug fixes — in which case it produces no artifact and
 *  converges immediately. Otherwise it loops write → review → fix until the
 *  design-reviewer approves (or a stall escalates to the user). */
export const designConvergenceNode = artifactConvergenceNode({
	stage: designStage,
	feedbackKey: "design",
	// v0.3.2 C1: contract-claims sensor (no-op when the design declares none).
	validate: designComplete,
	expected: "A design with defined interface contracts, grounded/feasible architecture, and no requirement/design conflicts, ready for the spec to consume.",
	nextAction: "Revise the design so every module has a defined input/output/error contract, every referenced integration point is grounded in the actual codebase, and it satisfies every requirement without unjustified complexity, before calling structured_output.",
	// Intentional skip is decided by CLASSIFICATION (bug fixes are not redesigned),
	// NOT by `!s.design` — otherwise a designer that timed out (also leaving
	// state.design undefined) would be mistaken for a skip and bypass the review
	// gate. For a non-bug task, an absent design means the designer FAILED → retry.
	//
	// 059 §3 R3 delta-5 NEW-3 (dual skip predicate, node arm): a bug
	// classification only skips when the design stage's write-time touched-set
	// stamp is EMPTY. A non-empty stamp means designStage routed the
	// architecture-improver (it never skipped) — an absent design there is a
	// designer FAILURE to retry, never a skip. An ABSENT stamp (pre-W resume,
	// walk failure) = status-quo skip — backwards compatible.
	skipped: (s) => {
		if (s.classify?.taskType !== "bug") return false;
		// v0.4.16 (atria gate AV4): this is a ROUTING decision about the CURRENT
		// tree — read the FRESH state stamp the design stage just stamped (it
		// stamps even on its skip path, design.ts:30), NOT the persisted disk
		// stamp. v0.4.14's preservation made readContractSliceStamp disk-first,
		// which newly routed this predicate off a possibly-stale persisted stamp
		// (unsafe direction: a stale EMPTY stamp skips design REVIEW for an
		// artifact that landed; a stale NON-empty one burns a null-producing
		// stage to the cap). Disk-first stays with contractValidationContext.
		const stamp = readStateSliceStamp(s as Record<string, unknown>, "design");
		// Adversarial S4b (v0.3.98): fail CLOSED — an absent stamp (extraction
		// error, pre-W resume) must NOT skip design; running it is the safe
		// direction (P5: more scrutiny, never less, when uncertain).
		if (!stamp) return false;
		return stamp.files.size === 0;
	},
	review: { stage: designReviewWriter, reviewStateKey: "designReview", ownerStage: "design" },
});
