/**
 * Always-write escalation report (spec-18 / AC-01, SCENARIO-001).
 *
 * Generalizes `handleStagnation`'s report body into a reusable writer that
 * `makeEscalate` invokes for EVERY blocker (baseline, all modes — TUI/RPC and
 * print/json/headless alike). Writes `escalation-report.md` into the run's spec
 * directory, capturing the failure (kind/stage/message/severity/findings) and
 * the user's decision (choice + guidance) so a dismissed/headless run still
 * leaves a durable, human-inspectable record.
 *
 * Contract (AC-01 / SCENARIO-012): NEVER throws — a write failure (unwritable
 * dir, missing path) degrades to a silent no-op so the run always completes.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { EscalationDecision, EscalationFailure } from "../types.ts";

/**
 * Write `escalation-report.md` for the given failure + decision.
 *
 * @param failure the blocker the pipeline hit (carries specDirectory).
 * @param decision the user's chosen recovery (undefined in headless/dismissed).
 * @param specDirectory where to write (derived from failure.specDirectory by
 *   `makeEscalate`); `undefined` ⇒ no-op (never throws).
 */
export function writeEscalationReport(
	failure: EscalationFailure,
	decision: EscalationDecision | undefined,
	specDirectory: string | undefined,
): void {
	if (!specDirectory) return;
	try {
		const lines: string[] = [];
		lines.push("# Escalation report");
		lines.push("");
		lines.push(`- **Kind:** ${failure.kind}`);
		if (failure.stage) lines.push(`- **Stage:** ${failure.stage}`);
		if (failure.severity) lines.push(`- **Severity:** ${failure.severity}`);
		if (failure.worktreePath) lines.push(`- **Worktree:** ${failure.worktreePath}`);
		// M4 routing (G6/MP5): the route-back surface is part of the record.
		if (failure.routeBackOwner) lines.push(`- **Route-back owner:** ${failure.routeBackOwner}`);
		if (failure.offeredChoices && failure.offeredChoices.length > 0) {
			lines.push(`- **Offered choices:** ${failure.offeredChoices.join(" | ")}`);
		}
		lines.push("");
		lines.push("## Message");
		lines.push("");
		lines.push(failure.message);
		const findings = failure.findings ?? [];
		if (findings.length > 0) {
			lines.push("");
			lines.push("## Findings");
			lines.push("");
			for (const f of findings) {
				const sev = f.severity ?? "?";
				const file = f.file ? `\`${f.file}\` ` : "";
				const title = f.title ?? "";
				lines.push(`- [${sev}] ${file}${title}`);
			}
		}
		if (decision) {
			lines.push("");
			lines.push("## Decision");
			lines.push("");
			lines.push(`- **Choice:** ${decision.choice}`);
			if (decision.guidance) {
				lines.push("");
				lines.push("### Guidance");
				lines.push("");
				lines.push(decision.guidance);
			}
		}
		// Sweep-3 G43: per-KIND filename — the old fixed name was overwritten per
		// blocker, so a multi-blocker run kept only the LAST record. The canonical
		// bare name stays as the LATEST snapshot (compat with readers/tests), and
		// the kind-stamped copy preserves each blocker's full record.
		const body = lines.join("\n") + "\n";
		writeFileSync(join(specDirectory, "escalation-report.md"), body);
		const kindTag = String(failure.kind || "unknown").replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 60);
		writeFileSync(join(specDirectory, `escalation-report-${kindTag}.md`), body);
	} catch {
		/* best-effort: a report write failure must never abort the run. */
	}
}
