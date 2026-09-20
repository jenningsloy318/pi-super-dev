/**
 * P4 (dsh-09 v3 Phase P): the generated architecture doc — rendered FROM the
 * code's own source-of-truth tables (src/graph/edges.ts + src/team/raci.ts),
 * never hand-edited. tests/arch-doc.test.ts pins the committed file to the
 * render output, so the doc cannot drift from the implementation; regen via
 * `npm run arch:doc`.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { EDGES, STAGE_IDS, downstreamOf} from "../graph/edges.ts";
import { RACI_TABLE, informedOf } from "../team/raci.ts";
import { SUPER_DEV_EXTENSION_VERSION } from "../version.ts";

export function renderArchitectureDoc(): string {
	const lines: string[] = [];
	lines.push("# Architecture (generated)");
	lines.push("");
	lines.push(`> Generated from \`src/graph/edges.ts\` + \`src/team/raci.ts\` at v${SUPER_DEV_EXTENSION_VERSION} — do not edit by hand; run \`npm run arch:doc\`.`);
	lines.push("");
	lines.push("## Stage table (RACI over the skeleton)");
	lines.push("");
	lines.push("| Stage | Responsible (produces) | Accountable (owns acceptance) | Consulted (gate) | Informed (downstream) |");
	lines.push("|---|---|---|---|---|");
	for (const row of RACI_TABLE) {
		const informed = informedOf(row.stage);
		lines.push(`| \`${row.stage}\` | \`${row.responsible}\` | \`${row.accountable}\` | ${row.consulted.length ? row.consulted.map((c) => `\`${c}\``).join(", ") : "—"} | ${informed.length} ${informed.length ? `(${informed.slice(0, 4).map((s) => `\`${s}\``).join(", ")}${informed.length > 4 ? ", …" : ""})` : "(terminal)"} |`);
	}
	lines.push("");
	lines.push("## Dependency edges (verified prompt reads + composition adjacencies)");
	lines.push("");
	lines.push("| Upstream | Downstream | Why the edge is real |");
	lines.push("|---|---|---|");
	for (const e of EDGES) {
		lines.push(`| \`${e.from}\` | \`${e.to}\` | ${e.rationale} |`);
	}
	lines.push("");
	lines.push("## Invalidation sets (D3 — downstreamOf, full reachability)");
	lines.push("");
	for (const id of STAGE_IDS) {
		const d = downstreamOf(id);
		lines.push(`- \`${id}\` → ${d.length ? d.map((s) => `\`${s}\``).join(" ") : "_(terminal)_"}`);
	}
	lines.push("");
	lines.push("## Code architecture (the v0.4.34-v0.4.55 split — module map)");
	lines.push("");
	lines.push("> The five former giants were decomposed under the AGENTS.md granularity standard");
	lines.push("> (one reason to change per module; loop skeletons and wiring cores kept where the");
	lines.push("> wrong-seam signals applied). Every extraction was byte-faithful with dual gates.");
	lines.push("");
	lines.push("| Former giant | Now | Composition kept |");
	lines.push("|---|---|---|");
	lines.push('| `stages/implementation/stage.ts` (3,038 → 1,375) | 28 single-reason modules under `src/stages/implementation/` — dispatchers (implementer-prompt, implementer-dispatch, red-tdd-dispatch), record builders (red-oracle-cycle, gate-suite, phase-entry), adjudicators (protection-gate, inherited-red-ladder, env-blocker-regate/judge, no-progress-valve, green-boundary, red-retry-ladder, red-acceptance), boundary closers (phase-tail, stage-close-reverify, phase-entry) | the attempt-loop skeleton, P3 run-state guards, the let-cascade, outcome interpretation |');
	lines.push('| `workflow.ts` (1,522 → 942) | `src/workflow/` — source-boundary, usage-accounting, run-status, agent-retry, pre-call-fuses, agent-call-assembly | makeContext/realAgent dispatch + terminal try/catch, runWorkflow (closure-dense by design) |');
	lines.push('| `extension.ts` (1,237 → 658) | `src/extension/` — escalation, run-presentation, run-state, tool-args, event-handlers | doRun execute core, pi registrations, renderers/panel |');
	lines.push('| `setup.ts` (1,042 → 326) | `src/setup/` — env-files, spec-identity, run-lock, worktree-git, bootstrap | runSetup + SetupOptions + detectLanguage |');
	lines.push('| `red-evidence.ts` (1,060 → 667) | `red-snapshot.ts` (snapshot/ratchet/restore) + `red-boundary.ts` (the two RED-gate agent adjudications) | the signatures/citations/porcelain/reasons/caps flat library core |');
	lines.push("");
	lines.push("Cross-cutting foundations (each a leaf or choke point, unchanged by the splits):");
	lines.push("");
	lines.push("- `src/nodes.ts` — the control-flow node algebra (task/sequence/branch/parallel/loop/retry/gate/map/wait/tryCatch); `FatalAbort` + `RouteBackSignal` propagation contracts");
	lines.push("- `src/tracking.ts` — the change tracker (never-throw, conservative parse, the false-green killer cross-check) + `rollbackWorktreeTo`");
	lines.push("- `src/harness-paths.ts` — the SINGLE canonical registry of harness-file roles (red-boundary / advisory-noise / claim-exempt / neverGitTracked / stateExternal); consumers derive sets, never declare literals");
	lines.push("- `src/state/state-root.ts` — the external-state funnel `stateFileFor` (fail-closed, realpath-canonicalized project keys) + one-time migration + orphan sweep");
	lines.push("- `src/runlog.ts` — the append-only events ledger (INV-L1..L6, torn-line healing, payload bounds)");
	lines.push("- `src/convergence-ledger.ts` — findings lifecycle (writer claims vs reviewer verification, duty downgrades with provenance gating, superseded orphaned anchors)");
	lines.push("- `src/control.ts` — `<control>` extraction (decoy guards, unescaped-quote repair, depth-aware key parsing)");
	lines.push("- `src/resume.ts` — durable-execution replay (structural cache keys, poisoned-row recovery, error rows never replayed)");
	lines.push("- `src/agent-errors.ts` — non-retryable classification incl. the persisted model-exclusion store diagnosis (TZ-validated quota hints) + the host-SDK resolution remedy");
	lines.push("- `src/fault-classification.ts` — the deterministic fault floor (environmental vs product vs unclassified) + the never-destructive dirt quarantine");
	lines.push("- `src/wall-fuse.ts` — the per-run-pass wall budget (first-trip-wins marker, trailing-median wind-down)");
	lines.push("- `src/agent-budget-fuse.ts` — the spawn-budget terminal marker (partial (agent-budget), first-trip-wins, fresh budget per resumed pass)");
	lines.push("- `src/routing/router.ts` — the ONE routing vocabulary (continue/retry/route-back/escalate/accept-limitation/abort) every decision mechanism maps onto");
	lines.push("");
	lines.push("## Where the semantics live");
	lines.push("");
	lines.push("- Loop vocabulary + degradation ladder: `docs/requirements/027-postmortem-0001-verify-loop-dead-state.md`");
	lines.push("- Named defensive rules: `docs/requirements/026-defensive-patterns.md`");
	lines.push("- Event ledger + invariants: `src/runlog.ts` (INV-L1..L6)");
	lines.push("- Replan circuit: `src/replan/` (requests, owner classification, R5 budget)");
	lines.push("- Deterministic gates: `src/build-runner/`");
	return lines.join("\n") + "\n";
}

export function writeArchitectureDoc(): string {
	const path = join(import.meta.dirname, "..", "..", "docs", "ARCHITECTURE.md");
	writeFileSync(path, renderArchitectureDoc());
	return path;
}

// Run directly: node src/render/arch-doc.ts
if (process.argv[1] && import.meta.filename === new URL(`file://${process.argv[1]}`).pathname) {
	console.log(`wrote ${writeArchitectureDoc()}`);
}
