/**
 * Artifact convergence — the shared write→validate→review→fix loop driver for the
 * pre-implementation stages (requirements, bdd, research, design). Split at
 * v0.4.17e into validators / feedback / rounds / node / nodes.
 */
import { gateValidator, task } from "../../nodes.ts";
import type { PipelineState, Stage, StageContext } from "../../types.ts";
import { bddPinOwnershipFindings, contractValidationContext, requirementsIntentFindings, selfSpecArtifactMatcher, splitContractFindings, stageWriteClaimGate } from "../../review/contract-validators.ts";
import { type ConvergenceOwnerStage } from "../../convergence-ledger.ts";

export type ArtifactValidator = (state: PipelineState, ctx: StageContext) => Promise<{ pass: boolean; errors: string[] }> | { pass: boolean; errors: string[] };

/** Hard liveness ceiling for every artifact-convergence loop (requirements, bdd,
 *  research, design). Termination normally comes from reviewer approval, the
 *  stall/HITL escalation path, or the global run budget — but a stochastic
 *  reviewer that never approves (and never stalls) would otherwise loop until the
 *  global budget exhausts (and a test with budget.check=()=>true loops forever →
 *  OOM). This cap is the unconditional floor: it FatalAborts exactly like the
 *  global-budget-exhaustion path, deliberately WITHOUT consuming the shared
 *  `stagnation:<feedbackKey>` escalation budget. See
 *  docs/requirements/008-convergence-loop-unbounded-cap-fix.md. */
export const MAX_CONVERGENCE_ROUNDS = 8;

/** Optional Fagan-style LLM review step layered on top of the deterministic
 *  validate (shift-left): after the artifact passes its deterministic gate, a
 *  reviewer agent judges CONTENT quality across stage-specific dimensions and
 *  returns a verdict. A non-approved verdict (or any blocking finding) feeds the
 *  review findings back into the next writer attempt — same convergence loop, so
 *  a reviewer-only retry can never masquerade as a fix. When the SAME blocking
 *  findings recur unchanged (a stall), the run escalates to the user (HITL). */
export interface ArtifactReviewOptions {
	/** The reviewer writer stage (e.g. requirementsReviewWriter). */
	stage: Stage;
	/** State key its control object lands under (e.g. "requirementsReview"). */
	reviewStateKey: string;
	/** Owning stage for recorded findings (e.g. "requirements"). */
	ownerStage: ConvergenceOwnerStage;
}

export interface ArtifactConvergenceOptions {
	stage: Stage;
	feedbackKey: "requirements" | "bdd" | "research" | "design";
	/** Deterministic validator. OPTIONAL: since v0.3.2 the design stage carries
	 *  `designComplete` (contract-claims sensor — a no-op when the design
	 *  declares no contracts); research still omits this. */
	validate?: ArtifactValidator;
	expected: string;
	nextAction: string;
	ownerForError?: (error: string) => ConvergenceOwnerStage;
	/** OPTIONAL upstream review+fix step. Absent ⇒ deterministic-validate-only
	 *  (byte-identical to today, e.g. research). */
	review?: ArtifactReviewOptions;
	/** OPTIONAL skip predicate: when it returns true after the writer runs, the
	 *  stage produced no artifact (e.g. design skipped for a bug fix) and the node
	 *  converges immediately without review. */
	skipped?: (state: PipelineState) => boolean;
	/** OPTIONAL override of the hard round ceiling (default MAX_CONVERGENCE_ROUNDS).
	 *  Tests use a small value to assert the cap fires; production leaves it unset.
	 *  The cap is a liveness floor, not a quality target. */
	maxRounds?: number;
	/** M3 G4 (review round-1): OPT-IN to the revision-gate fast-forward. Set
	 *  ONLY where `validate` is a genuine CROSS-DOC trace gate that re-reads
	 *  CURRENT upstream state (requirements/bdd). research has no validator;
	 *  design's designComplete is a contract-claims sensor that does NOT
	 *  re-check against upstream — both stay OUT (conservative re-run). */
	fastForwardable?: boolean;
}

function validResearchSourceCount(r: { sources?: unknown }): number {
	const sources = Array.isArray(r.sources) ? r.sources : [];
	return sources.filter((source) => {
		if (!source || typeof source !== "object" || Array.isArray(source)) return false;
		const url = (source as { url?: unknown }).url;
		return typeof url === "string" && /^https?:\/\//i.test(url.trim());
	}).length;
}

function researchUnavailableDisclosure(r: Record<string, unknown>): boolean {
	const options = Array.isArray(r.options) ? r.options : [];
	const text = [
		r.summary,
		...options.map((o) => typeof o === "object" && o !== null ? `${(o as { name?: unknown }).name ?? ""} ${(o as { tradeoffs?: unknown }).tradeoffs ?? ""}` : o),
	]
		.map((v) => String(v ?? ""))
		.join("\n")
		.toLowerCase();
	const unavailable = /(?:web|search|mcp|firecrawl|anysearch|tavily|tinyfish|network|provider|tool)[\w\s/-]{0,80}(?:unavailable|not configured|unauthorized|failed|blocked|disabled)/i.test(text);
	const unverified = /\bunverified\b|\bnot verified\b|\bunsupported by sources\b/i.test(text);
	return unavailable && unverified;
}

export const requirementsComplete: ArtifactValidator = async (s: PipelineState, ctx: StageContext) => {
	const base = await gateValidator("gate-requirements", "write-requirements", "requirements")(s, ctx);
	// 059 R1A R3(c): affectsSharedSurfaces intent consistency — ADVISORY at 2B
	// (HIGH-1: requirements legitimately may not know; blocking moves down-stack
	// to design-review). Never blocks the loop.
	const contractCtx = contractValidationContext(s as Record<string, unknown>, "requirements", [ctx.task, JSON.stringify(s.requirements ?? {})]);
	if (contractCtx) {
		for (const a of splitContractFindings(requirementsIntentFindings({ control: s.requirements as Record<string, unknown> | undefined, slice: contractCtx.slice })).advisory) {
			ctx.log(`Requirements contract-validator (advisory): ${a}`);
		}
		// 065 D-F-B (Gate W, intent level — advisory at 2B per 059 W2: the typed
		// family is a design/spec home; requirements findings feed forward).
		for (const f of stageWriteClaimGate({ stage: "requirements", level: "intent", state: s as Record<string, unknown>, control: s.requirements as Record<string, unknown> | undefined, docGlobs: ["*-requirements.md"] })) {
			ctx.log(`Requirements Gate-W (${f.kind}): ${f.message.slice(0, 200)}`);
		}
	}
	const req = s.requirements as ({ openQuestions?: unknown[] } & Record<string, unknown>) | undefined;
	const open = Array.isArray(req?.openQuestions) ? req.openQuestions : [];
	if (open.length === 0) return base;
	const preview = open.slice(0, 3).map((o) => String(o).slice(0, 100)).join("; ");
	ctx.log(`Requirements: ${open.length} open question(s) remain; continuing requirements clarification: ${preview}`);
	return {
		pass: false,
		errors: [...base.errors, `requirements left ${open.length} open question(s): ${preview}`],
	};
};

export const bddComplete: ArtifactValidator = async (s: PipelineState, ctx: StageContext) => {
	const base = await gateValidator("gate-bdd", "write-bdd", "bdd")(s, ctx);
	// 059 R1A R3(b): pinOwnership AST validator — the typed control field,
	// NEVER rendered-markdown regex (grill R6 HIGH-2, P1/P6). No context
	// (no worktree / no stamp) ⇒ no-op (fail-open harmless).
	const contractCtx = contractValidationContext(s as Record<string, unknown>, "bdd", [ctx.task, JSON.stringify(s.bdd ?? {})]);
	if (contractCtx) {
		const { blocking, advisory } = splitContractFindings(bddPinOwnershipFindings({ control: s.bdd as Record<string, unknown> | undefined, slice: contractCtx.slice, inventory: contractCtx.inventory, selfArtifactMatch: selfSpecArtifactMatcher(s.setup?.specDirectory, "-bdd-scenarios.md") }));
		for (const a of advisory) ctx.log(`BDD contract-validator (advisory): ${a}`);
		// 065 D-F-B (Gate W, intent level — advisory at 2C; blocking moves to the
		// concrete home at design/spec).
		for (const f of stageWriteClaimGate({ stage: "bdd", level: "intent", state: s as Record<string, unknown>, control: s.bdd as Record<string, unknown> | undefined, docGlobs: ["*-bdd-scenarios.md"] })) {
			ctx.log(`BDD Gate-W (${f.kind}): ${f.message.slice(0, 200)}`);
		}
		if (blocking.length > 0) return { pass: false, errors: [...base.errors, ...blocking] };
	}
	return base;
};

/** A research report is complete only when it exists and leaves no answerable
 *  open issues. `openIssues` is reserved for concrete ambiguities that another
 *  research pass should try to resolve; generic caveats and unresolvable limits
 *  belong in the summary/options instead. It must also include real researched
 *  sources unless the report explicitly records unavailable web/search tooling
 *  and marks its claims unverified. */
export const researchComplete: ArtifactValidator = async (s: PipelineState, ctx: StageContext) => {
	const r = s.research as ({ docPath?: string; openIssues?: unknown[]; sources?: unknown } & Record<string, unknown>) | undefined;
	if (!r || !r.docPath) {
		ctx.log("Research: no report produced (agent returned nothing or timed out)");
		return { pass: false, errors: ["no research report produced (agent returned nothing or timed out)"] };
	}
	const sourceCount = validResearchSourceCount(r);
	if (sourceCount === 0 && !researchUnavailableDisclosure(r)) {
		ctx.log("Research: no real source URLs and no explicit web-tool-unavailable/unverified disclosure");
		return { pass: false, errors: ["research must include at least one real http(s) source URL, or explicitly disclose that web/search tools were unavailable and mark claims unverified"] };
	}
	const open = (r.openIssues as unknown[]) ?? [];
	if (open.length > 0) {
		const preview = open.slice(0, 3).map((o) => String(o).slice(0, 80)).join("; ");
		ctx.log(`Research: ${open.length} answerable open issue(s) remain; continuing research: ${preview}`);
		return { pass: false, errors: [`research left ${open.length} answerable open issue(s): ${preview}`] };
	}
	return { pass: true, errors: [] };
};
