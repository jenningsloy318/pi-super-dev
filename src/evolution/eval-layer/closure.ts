/**
 * EVAL LAYER (P1) — golden-case dataset + rubric artifacts + validation-gate
 * machinery (docs/requirements/055-sdlc-tips-adoption.md — the ratified spec).
 *
 * What landed here and why (spec citations):
 *   D1 / DEC-5 / DEC-6 — golden cases: labelled scenario → expected-verdict
 *         pairs living in ~/.super-dev/evals/cases/ (user-local, NEVER
 *         in-repo; cold start = empty, mirroring learned.ts). One case per
 *         *.json file; seven fields (id/title/source/target/scenario/
 *         expected/caseVersion); expected.verdict is validated against the
 *         DEC-6 verdict-enum CLOSURE TABLE built from the REAL runtime
 *         vocabularies imported from their owners (P6 single grammar — no
 *         re-typed string copies anywhere in this module).
 *   D2 / DEC-7 / §8.2 — rubric artifacts: one file per rubricId under
 *         ~/.super-dev/evals/rubrics/; assertion-level boolean + 0..1
 *         confidence. The 0..1 confidence is a RANKING-ONLY signal, never a
 *         probability (verbalized-confidence miscalibration, §8.2) — encoded
 *         in the Rubric type docs, and the gate's calibration mapping below
 *         is the honest bridge from ranking to empirical accuracy.
 *   §8.1 — every scenario embeds a literal canary GUID (makeCanary(id)):
 *         the contamination tripwire — a learned-index entry quoting the
 *         canary proves golden-case leakage into a measured agent's context.
 *   D7 / DEC-13① / L2 / L3 — the validation-gate harness (this file's second
 *         half): maintainer hand labels under ~/.super-dev/evals/labels/,
 *         agreement computation with a confidence→accuracy calibration
 *         mapping (reliability diagram, §8.2), bootstrap percentile CIs
 *         (§8.5), and the gatePasses policy that gates D4② proposal
 *         drafting. P1 ships the MACHINERY; the gate EXECUTES in P2 when the
 *         scorers land — nothing here is wired into workflow.ts/stages yet.
 *
 * Loading doctrine (DEC-5, mirrors learned.ts): cold start is an EMPTY
 * dataset, never an error; every validation failure is LOUD per case (file +
 * field + reason) and skips that case — never a silent bad load, never a
 * crash. Data are personal calibration assets: not versioned, lost on
 * reinstall (accepted; the mandatory in-repo `source` anchor is the rebuild
 * path).
 *
 * Seeding doctrine (DEC-7): seed-phase cases and rubrics are HANDWRITTEN by
 * the maintainer. This module auto-generates ZERO content — the template
 * writers emit only validator-passing skeletons (canary pre-embedded) for
 * the maintainer to fill.
 *
 * Review round (owner-adjudicated F1–F10, applied verbatim): three-arm
 *       target grammar (compound "stage|agent" | stage-only | agent-only —
 *       judge is an agent, never a stage); rubric dimension mustNot optional
 *       on the wire; scorer-row dedup with honest duplicate accounting; gate
 *       n=0 checked before n<8; bootstrap CI only at n ≥
 *       GATE_MIN_MATCHED_PAIRS; conservative target→verdict-family mapping
 *       (fail-open default) via TARGET_VERDICT_FAMILIES; id/rubricId must
 *       equal the file basename; source anchors stat+realpath-verified;
 *       template writes use flag "wx"; optional caseSet stamp + caseSetOf
 *       layer derivation.
 */
import { resolve } from "node:path";
import { makeCanary } from "../eval-shared.ts";
import { STAGE_IDS } from "../../graph/edges.ts";
import { REGISTERED_AGENTS } from "../../agents/register-agents.ts";
import { REVIEW_VERDICT_VALUES } from "../../helpers.ts";
import { PROTOTYPE_VERDICT_VALUES } from "../../stages/prototype.ts";
import { JUDGE_EVAL_VERDICT_VALUES } from "../../stages/judge.ts";
import { FAULT_CLASS_VALUES } from "../../fault-classification.ts";

// ─── DEC-6 verdict closure table ────────────────────────────────────────────

/**
 * The verdict-enum closure table (DEC-6): golden-case `expected.verdict` (and
 * gate hand labels) may hold ONLY values from this set. Composition — every
 * family imported from the module that owns it:
 *   - REVIEW_VERDICT_VALUES       convergence-review verdicts (helpers.ts
 *                                 VERDICT_RANK keys: the normalized set every
 *                                 reviewer output folds into)
 *   - PROTOTYPE_VERDICT_VALUES    prototype pass/fail closed enum
 *                                 (stages/prototype.ts; schemas.ts unions the
 *                                 same literals)
 *   - JUDGE_EVAL_VERDICT_VALUES   judge accepted/discarded meter semantics
 *                                 (stages/judge.ts)
 *   - FAULT_CLASS_VALUES          fault classification table
 *                                 (fault-classification.ts FaultClass)
 * Verdict comparison is therefore ZERO-LLM (deterministic membership);
 * semantic mustHold/mustNot assertions belong to the scorer LM.
 */
export const VERDICT_CLOSURE: readonly string[] = [
	...REVIEW_VERDICT_VALUES,
	...PROTOTYPE_VERDICT_VALUES,
	...JUDGE_EVAL_VERDICT_VALUES,
	...FAULT_CLASS_VALUES,
];

/** Closed target sets for the `stage|agent` field (DEC-6): pipeline stage ids
 *  (graph/edges.ts STAGE_IDS) and agent names (register-agents.ts
 *  REGISTERED_AGENTS). Exported for tests and P2 filtering. */
export const TARGET_STAGES: readonly string[] = STAGE_IDS;
export const TARGET_AGENTS: readonly string[] = REGISTERED_AGENTS;

/** The one separator accepted inside a target string. ASCII only — the spec's
 *  DEC-6 "stage｜agent" typography normalizes to plain "|" for data. */
export const TARGET_SEPARATOR = "|";

// ─── F6 target→verdict-family mapping (conservative, fail-open default) ─────

/** The four verdict families of the DEC-6 closure — one per owning
 *  vocabulary. */
export type VerdictFamily = "review" | "prototype" | "judge" | "fault";

/** Family → its REAL runtime vocabulary (the same imports the closure is
 *  composed from — single grammar). */
export const VERDICT_FAMILY_VALUES: Readonly<Record<VerdictFamily, readonly string[]>> = {
	review: REVIEW_VERDICT_VALUES,
	prototype: PROTOTYPE_VERDICT_VALUES,
	judge: JUDGE_EVAL_VERDICT_VALUES,
	fault: FAULT_CLASS_VALUES,
};

/**
 * F6 conservative mapping (owner ruling, fail-open default): target arms that
 * resolve to a KNOWN verdict family.
 *   stage arms: prototype → prototype; the convergence-review stages
 *     (requirements, bdd, research, design, spec, verify, docs) → review;
 *   agent arms: prototype-runner → prototype; judge → judge (agent-only
 *     `target: "judge"` is the natural home for judge-verdict cases — judge
 *     is an agent, never a stage); red-boundary-classifier and
 *     tdd-coverage-classifier → fault; ANY agent ending in agentSuffix
 *     ("-reviewer") → review.
 * Stages/agents NOT listed here resolve to NOTHING — such a target is
 * "unmapped" and admits the FULL closure (documented fail-open: the P1
 * loader must not invent vocabulary restrictions the P2 scoring surface has
 * not ratified; P2 scoring surfaces the rest).
 */
export const TARGET_VERDICT_FAMILIES: {
	readonly stage: Readonly<Partial<Record<string, VerdictFamily>>>;
	readonly agent: Readonly<Partial<Record<string, VerdictFamily>>>;
	readonly agentSuffix: string;
} = {
	stage: {
		prototype: "prototype",
		requirements: "review",
		bdd: "review",
		research: "review",
		design: "review",
		spec: "review",
		verify: "review",
		docs: "review",
	},
	agent: {
		"prototype-runner": "prototype",
		judge: "judge",
		"red-boundary-classifier": "fault",
		"tdd-coverage-classifier": "fault",
	},
	agentSuffix: "-reviewer",
};

/** The families a target's arms resolve to (deduped; stage arm first).
 *  An EMPTY result means the target is unmapped → the full closure applies. */
export function targetVerdictFamilies(target: { stage?: string; agent?: string }): VerdictFamily[] {
	const families = new Set<VerdictFamily>();
	if (target.stage !== undefined) {
		const family = TARGET_VERDICT_FAMILIES.stage[target.stage];
		if (family !== undefined) families.add(family);
	}
	if (target.agent !== undefined) {
		const listed = TARGET_VERDICT_FAMILIES.agent[target.agent];
		const family = listed !== undefined ? listed : (target.agent.endsWith(TARGET_VERDICT_FAMILIES.agentSuffix) ? "review" : undefined);
		if (family !== undefined) families.add(family);
	}
	return [...families];
}

/** The verdict admission set for a target: the UNION of its arms' families
 *  (a compound target admits what EITHER arm admits); an unmapped target
 *  (empty resolution) fail-opens to the full DEC-6 closure. */
export function allowedVerdictsForTarget(target: { stage?: string; agent?: string }): readonly string[] {
	const families = targetVerdictFamilies(target);
	if (families.length === 0) return VERDICT_CLOSURE;
	const out = new Set<string>();
	for (const family of families) {
		for (const value of VERDICT_FAMILY_VALUES[family]) out.add(value);
	}
	return [...out];
}

// ─── §8.1 canary (moved to the leaf eval-shared.ts in P3 so the learned-index
// injection seam can share the SAME derivation without an import cycle;
// re-exported here — the historical import surface — and used below.) ─────

export { makeCanary } from "../eval-shared.ts";
