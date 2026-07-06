/**
 * `.knowledge.md` — auto-accumulated within-run knowledge base.
 *
 * After each stage completes, its control object's KEY STRUCTURED FIELDS are
 * appended to `.knowledge.md` in the spec directory. Downstream agents read ONE
 * file for ALL prior stages' raw data (exact ACs, scenario IDs, phase names,
 * patterns, services) — not vague summaries.
 *
 * This is the completeness guarantee for progressive disclosure: the data comes
 * from the agents' own structured_output (control objects), not from parsed
 * markdown or hand-written summaries.
 */

import { appendFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

/** Get the .knowledge.md path for a spec directory. */
export function knowledgePath(specDir: string): string {
	return join(specDir, ".knowledge.md");
}

/** Clear .knowledge.md at pipeline start (fresh run). */
export function clearKnowledge(specDir: string): void {
	try { writeFileSync(knowledgePath(specDir), `# Knowledge Base\n\nAuto-accumulated from each stage's structured output.\n\n`); } catch { /* best-effort */ }
}

/** Format a control object's key fields into a compact knowledge section. */
function formatSection(stageId: string, control: Record<string, unknown>): string {
	const ts = new Date().toISOString().replace(/\.\d+Z$/, "Z");
	const lines: string[] = [`## Stage: ${stageId} (${ts})`];

	// Acceptance criteria (requirements)
	const acs = control.acceptanceCriteria as Array<{ id?: string; statement?: string }> | undefined;
	if (acs?.length) lines.push(`**ACs**: ${acs.map((a) => `${a.id ?? "?"}: ${a.statement ?? ""}`).join("; ")}`);

	// Scenarios (BDD) — flatten features → scenarios
	const features = control.features as Array<{ name?: string; scenarios: Array<{ id?: string; title?: string; acRef?: string }> }> | undefined;
	if (features?.length) {
		const scenarios = features.flatMap((f) => f.scenarios ?? []);
		if (scenarios.length) lines.push(`**Scenarios**: ${scenarios.length} — ${scenarios.map((s) => `SCENARIO-${s.id ?? "?"} (${s.acRef ?? "?"})`).join(", ")}`);
	}

	// Phases (spec)
	const phases = control.phases as Array<{ name?: string; description?: string }> | undefined;
	if (phases?.length) lines.push(`**Phases**: ${phases.map((p, i) => `Phase ${i + 1}: ${p.name ?? "?"}`).join("; ")}`);

	// Patterns (assessment)
	const patterns = control.patterns as Array<{ name?: string; example?: string; consistency?: string }> | undefined;
	if (patterns?.length) lines.push(`**Patterns**: ${patterns.map((p) => `${p.name ?? "?"} (${p.example ?? "?"})`).join("; ")}`);

	// Files assessed (assessment)
	const files = control.filesAssessed as string[] | undefined;
	if (files?.length) lines.push(`**Files**: ${files.join(", ")}`);

	// Services (assessment — for bringup)
	const services = control.services as { api?: { cmd?: string }; ui?: { cmd?: string } } | undefined;
	if (services?.api?.cmd) lines.push(`**Services**: api=${services.api.cmd}`);
	if (services?.ui?.cmd) lines.push(`**UI**: ${services.ui.cmd}`);

	// Verdict (reviews)
	if (control.verdict) lines.push(`**Verdict**: ${control.verdict}`);

	// Findings count (reviews)
	const findings = control.findings as unknown[] | undefined;
	if (findings?.length) lines.push(`**Findings**: ${findings.length}`);

	// Test results (api/ui test)
	if (control.pass !== undefined) lines.push(`**Pass**: ${control.pass}`);
	if (control.cases !== undefined) lines.push(`**Cases**: ${control.cases}`);
	if (control.flows !== undefined) lines.push(`**Flows**: ${control.flows}`);

	// Summary (all stages)
	if (control.summary) lines.push(`**Summary**: ${control.summary}`);

	return lines.length > 1 ? lines.join("\n") : "";
}

/** Append a stage's control data to .knowledge.md (called by renderAndWrite). */
export function appendToKnowledge(specDir: string, stageId: string, control: Record<string, unknown> | null): void {
	if (!control) return;
	const section = formatSection(stageId, control);
	if (!section) return;
	try { appendFileSync(knowledgePath(specDir), `\n${section}\n`); } catch { /* best-effort */ }
}
