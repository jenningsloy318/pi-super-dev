/**
 * P2 (dsh-09 v3 Phase P): the full team/RACI map — WHO owns every pipeline
 * deliverable, extending R2's minimal stage-owners with the complete
 * Responsible/Accountable/Consulted/Informed matrix.
 *
 *   Responsible  — the agent role that PRODUCES the deliverable (must have an
 *                  agents/<role>.md definition; validated at setup).
 *   Accountable  — the pipeline stage whose convergence loop owns acceptance
 *                  (the R3 replan owner set is exactly this column for the
 *                  artifact stages).
 *   Consulted    — the reviewer roles whose verdict gates acceptance.
 *   Informed     — derived from src/graph/edges.ts downstreamOf() (single
 *                  source of truth; never duplicated here).
 *
 * Drift guards (tests/team-raci.test.ts): every non-setup skeleton stage has a
 * row; every Responsible role resolves to an agents/<role>.md file; the
 * Accountable artifact stages equal REPLAN_OWNER_STAGES; Informed is always
 * the live edges.ts projection.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { agentsDirectory } from "../agents.ts";
import { downstreamOf } from "../graph/edges.ts";
import { REPLAN_OWNER_STAGES, type ReplanOwnerStage } from "../replan/owners.ts";

export interface RaciRow {
	stage: string;
	/** The producing agent role (agents/<role>.md must exist). */
	responsible: string;
	/** The stage whose convergence/acceptance loop owns the deliverable. */
	accountable: string;
	/** Reviewer roles gating acceptance (empty for deterministic-only stages). */
	consulted: string[];
}

/** The static R/A/C columns; Informed is computed (never duplicated). */
export const RACI_TABLE: readonly RaciRow[] = [
	{ stage: "setup", responsible: "orchestrator", accountable: "setup", consulted: [] },
	{ stage: "classify", responsible: "task-classifier", accountable: "classify", consulted: [] },
	{ stage: "requirements", responsible: "requirements-clarifier", accountable: "requirements", consulted: ["requirements-reviewer"] },
	{ stage: "bdd", responsible: "bdd-scenario-writer", accountable: "bdd", consulted: ["bdd-reviewer"] },
	{ stage: "research", responsible: "research-agent", accountable: "research", consulted: [] },
	{ stage: "debug", responsible: "debug-analyzer", accountable: "debug", consulted: [] },
	{ stage: "assessment", responsible: "code-assessor", accountable: "assessment", consulted: [] },
	{ stage: "design", responsible: "architecture-designer", accountable: "design", consulted: ["design-reviewer"] },
	{ stage: "prototype", responsible: "prototype-runner", accountable: "prototype", consulted: [] },
	{ stage: "spec", responsible: "spec-writer", accountable: "spec", consulted: ["spec-reviewer"] },
	{ stage: "implementation", responsible: "implementer", accountable: "implementation", consulted: ["tdd-guide", "red-boundary-classifier", "tdd-coverage-classifier"] },
	{ stage: "verify", responsible: "code-reviewer", accountable: "verify", consulted: ["adversarial-reviewer", "judge"] },
	{ stage: "docs", responsible: "docs-executor", accountable: "docs", consulted: [] },
	{ stage: "preMergeBuild", responsible: "orchestrator", accountable: "preMergeBuild", consulted: [] },
	{ stage: "cleanup", responsible: "orchestrator", accountable: "cleanup", consulted: [] },
	{ stage: "merge", responsible: "orchestrator", accountable: "merge-verify", consulted: [] },
	{ stage: "merge-verify", responsible: "orchestrator", accountable: "merge-verify", consulted: [] },
];

/** The Informed column: who a revised/failed stage's outcome reaches (live
 *  projection over the dependency graph — D3's invalidation set). */
export function informedOf(stage: string): string[] {
	return downstreamOf(stage);
}

export interface TeamReadinessIssue {
	stage: string;
	role: string;
	problem: "missing-agent-definition";
}

/** Setup validation (P2): every Responsible role must resolve to an
 *  agents/<role>.md file. Pure + deterministic — the degraded-boot diagnostic
 *  that catches a renamed/deleted role before the run discovers it mid-flight. */
export function validateTeamReadiness(): TeamReadinessIssue[] {
	const issues: TeamReadinessIssue[] = [];
	const dir = agentsDirectory();
	for (const row of RACI_TABLE) {
		if (!existsSync(join(dir, `${row.responsible}.md`))) {
			issues.push({ stage: row.stage, role: row.responsible, problem: "missing-agent-definition" });
		}
	}
	return issues;
}

/** The replan-owner column over the table: accountable stages that own an
 *  artifact convergence loop (must equal REPLAN_OWNER_STAGES — drift guard). */
export function raciReplanOwners(): ReplanOwnerStage[] {
	const owners = new Set<ReplanOwnerStage>();
	for (const row of RACI_TABLE) {
		if ((REPLAN_OWNER_STAGES as readonly string[]).includes(row.accountable)) {
			owners.add(row.accountable as ReplanOwnerStage);
		}
	}
	return [...owners].sort();
}
