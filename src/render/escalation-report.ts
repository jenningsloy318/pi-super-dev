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
		writeFileSync(join(specDirectory, "escalation-report.md"), lines.join("\n") + "\n");
	} catch {
		/* best-effort: a report write failure must never abort the run. */
	}
}
