/**
 * P4 (dsh-09 v3 Phase P): the generated architecture doc — rendered FROM the
 * code's own source-of-truth tables (src/graph/edges.ts + src/team/raci.ts),
 * never hand-edited. tests/arch-doc.test.ts pins the committed file to the
 * render output, so the doc cannot drift from the implementation; regen via
 * `npm run arch:doc`.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { EDGES, STAGE_IDS, downstreamOf, inboundEdges } from "../graph/edges.ts";
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
	lines.push("## Where the semantics live");
	lines.push("");
	lines.push("- Loop vocabulary + degradation ladder: `docs/requirements/postmortem-0001-verify-loop-dead-state.md`");
	lines.push("- Named defensive rules: `docs/requirements/defensive-patterns.md`");
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
