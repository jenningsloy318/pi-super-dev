/**
 * R2 (dsh-09 v3 Phase R): deterministic owner classification for replan
 * routing — WHICH owning stage must revise its artifact when a downstream
 * review finds an upstream-owned defect.
 *
 * Two layers:
 *   1. classifyReplanOwnerDeterministic — pure rules (no LLM), priority order:
 *      reviewer-provided ownerStage → specification doc path → artifact file
 *      class → keyword classes. Returns null for residue (→ layer 2).
 *   2. classifyWithReplanLead (lead.ts) — the strong-model replan-lead agent
 *      classifies the residue under judge-style evidence discipline (closed
 *      owner set, confidence floor, byte-verified quotes from the finding
 *      text; non-conforming output degrades to "human", never a guessed route).
 *
 * Owner set rationale: only stages with a CONVERGENCE loop (the ledger-driven
 * writer-revises-per-finding machinery) can consume a revision request —
 * requirements, bdd, research, design, spec. assessment/prototype are
 * single-pass writers without a revision loop; implementation/verification are
 * the code fixer's domain (the existing verify fix loop owns them) and must
 * NEVER be routed here.
 */

export type ReplanOwnerStage = "requirements" | "bdd" | "research" | "design" | "spec";

/** The closed set of stages a replan request may be routed to (R3 consumers). */
export const REPLAN_OWNER_STAGES: readonly ReplanOwnerStage[] = ["requirements", "bdd", "research", "design", "spec"];

export type ReplanOwnerDecisionSource =
	| "reviewer-ownerStage"
	| "doc-path"
	| "file-class"
	| "keyword"
	| "replan-lead"
	| "residue";

export interface ReplanOwnerDecision {
	/** The owning stage, or "human" when no artifact revision may resolve it. */
	owner: ReplanOwnerStage | "human";
	/** True only when a replan restart may act on this decision automatically. */
	routable: boolean;
	/** Which rule produced the decision (audit). */
	source: ReplanOwnerDecisionSource;
	reason: string;
	/** Lead-classified decisions carry the model's confidence. */
	confidence?: number;
}

/** Stages whose findings the code fixer legitimately owns — never replan. */
const FIXER_DOMAIN_STAGES = new Set(["implementation", "verification", "environment"]);

function text(v: unknown): string {
	if (v == null) return "";
	if (typeof v === "object") return JSON.stringify(v);
	return String(v).replace(/\s+/g, " ").trim();
}

function decision(owner: ReplanOwnerStage | "human", routable: boolean, source: ReplanOwnerDecisionSource, reason: string, confidence?: number): ReplanOwnerDecision {
	return confidence === undefined ? { owner, routable, source, reason } : { owner, routable, source, reason, confidence };
}

/**
 * Deterministic classification. PURE — no spawn, no fs, never throws.
 * Returns null when the finding is residue for the replan-lead layer.
 */
export function classifyReplanOwnerDeterministic(finding: Record<string, unknown>): ReplanOwnerDecision | null {
	try {
		// Rule 1 — the reviewer's explicit ownerStage is authoritative.
		const ownerStage = text(finding.ownerStage).toLowerCase();
		if ((REPLAN_OWNER_STAGES as readonly string[]).includes(ownerStage)) {
			return decision(ownerStage as ReplanOwnerStage, true, "reviewer-ownerStage", `reviewer ownerStage: ${ownerStage}`);
		}
		if (FIXER_DOMAIN_STAGES.has(ownerStage)) {
			return decision("human", false, "reviewer-ownerStage", `ownerStage ${ownerStage} is the code fixer's domain — the verify fix loop owns it, not replan`);
		}

		// Rule 2 — a finding citing a specification document routes to the spec
		// writer (contract/protocol corrections are encoded in the spec).
		const file = text(finding.file);
		if (/docs\/specifications\/[\w-]+\.md$/i.test(file) || /-specification\.md$/i.test(file)) {
			return decision("spec", true, "doc-path", `cites the specification artifact: ${file}`);
		}

		// Rule 3 — rendered artifact document classes (NN-<slug>.md in the spec
		// dir; slugs from STAGE_MODELS: requirements, bdd-scenarios,
		// research-report, code-assessment, design, specification).
		if (/docs\/requirements\/|(^|\/)[\w.-]*-requirements\.md$/i.test(file)) {
			return decision("requirements", true, "file-class", `requirements artifact: ${file}`);
		}
		if (/(^|\/)[\w.-]*-bdd-scenarios\.md$/i.test(file)) {
			return decision("bdd", true, "file-class", `BDD artifact: ${file}`);
		}
		if (/(^|\/)[\w.-]*-research-report\.md$/i.test(file)) {
			return decision("research", true, "file-class", `research artifact: ${file}`);
		}
		if (/(^|\/)[\w.-]*-design\.md$/i.test(file)) {
			return decision("design", true, "file-class", `design artifact: ${file}`);
		}

		// Rule 4 — keyword classes over the finding's own text (no file, or an
		// unclassified file: code-level findings can still be spec/design gaps —
		// AR-03-03 "resume protocol undefined" cited code but is a spec gap).
		const blob = `${text(finding.title)}\n${text(finding.detail)}\n${text(finding.recommendation)}`.toLowerCase();
		if (/\b(contract|protocol|api surface|signature|export|resume|restart|idempoten)/.test(blob) && /\b(undefined|ambiguous|ambiguity|contradict|contradiction|mismatch|unspecified|un[- ]?defined)\b/.test(blob)) {
			return decision("spec", true, "keyword", "contract/protocol term marked undefined/ambiguous/contradictory — the spec must define it");
		}
		if (/\b(tolerance|threshold|budget|limit|cap)\b/.test(blob) && /\b(undefined|unspecified|hard[- ]?cod)\b/.test(blob)) {
			return decision("spec", true, "keyword", "threshold/tolerance value undefined or hard-coded without spec backing");
		}
		if (/\b(token|context window|re[- ]?inject|unbounded|carried forward|carry[- ]?over)\b/.test(blob)) {
			return decision("design", true, "keyword", "context/token-budget carrying is a design tradeoff");
		}
		if (/\b(acceptance criteri|acceptance criteria)\b/.test(blob)) {
			return decision("requirements", true, "keyword", "acceptance-criteria-level concern");
		}
		if (/\bscenarios?\b/.test(blob) && /\b(missing|cover|gap|dangling)\b/.test(blob)) {
			return decision("bdd", true, "keyword", "scenario-coverage gap");
		}
		if (/\b(regression|test fail|broken test|behavior change|flaky)\b/.test(blob)) {
			return decision("human", false, "keyword", "implementation-shaped (regression/behavior) — the verify fix loop owns it, not replan");
		}

		// Residue — the replan-lead layer (or, absent it, the human) decides.
		return null;
	} catch {
		// Unreadable finding — never guess; residue for the lead.
		return null;
	}
}
