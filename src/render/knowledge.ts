/**
 * `.knowledge.json` — auto-accumulated within-run knowledge base (JSON format).
 *
 * After each stage completes, its control object is stored as JSON. The pipeline
 * extracts ONLY the fields each downstream agent needs (declarative mapping) and
 * injects them into the agent's prompt (option C). The agent never reads the file.
 *
 * Why JSON (not markdown):
 * - JSON.parse is reliable (no regex parsing of **FieldName**: patterns).
 * - Field-path navigation is trivial (obj.stage.data.field).
 * - TS can type the structure.
 * - jq is sufficient for human inspection.
 * - The agent doesn't read it — the pipeline extracts + injects.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

interface KnowledgeFile {
	stages: Record<string, {
		timestamp: string;
		agent: string;
		data: Record<string, unknown>;
	}>;
}

const EMPTY: KnowledgeFile = { stages: {} };

/** Path to .knowledge.json in a spec directory. */
export function knowledgePath(specDir: string): string {
	return join(specDir, ".knowledge.json");
}

/** Clear knowledge at pipeline start (fresh run). */
export function clearKnowledge(specDir: string): void {
	try { writeFileSync(knowledgePath(specDir), JSON.stringify(EMPTY, null, 2) + "\n"); } catch { /* best-effort */ }
}

/** Store a stage's control object into .knowledge.json (read-modify-write).
 *  Called by renderAndWrite after the doc is rendered. */
export function appendToKnowledge(specDir: string, stageId: string, control: Record<string, unknown> | null): void {
	if (!control) return;
	const path = knowledgePath(specDir);
	let knowledge: KnowledgeFile;
	try { knowledge = JSON.parse(readFileSync(path, "utf8")); } catch { knowledge = { stages: {} }; }
	knowledge.stages[stageId] = {
		timestamp: new Date().toISOString(),
		agent: String(control.agent ?? stageId),
		data: control,
	};
	try { writeFileSync(path, JSON.stringify(knowledge, null, 2) + "\n"); } catch { /* best-effort */ }
}

// ─── Per-agent extraction (option C) ─────────────────────────────────────────

/** Declarative: agent → which fields from which prior stages it needs.
 *  { stage, path (dot-notation into the control object), label (prompt label) } */
interface KnowledgeNeed { stage: string; path: string; label: string }

export const AGENT_KNOWLEDGE_NEEDS: Record<string, KnowledgeNeed[]> = {
	"bdd-scenario-writer":  [{ stage: "requirements", path: "acceptanceCriteria", label: "ACs" }, { stage: "requirements", path: "nonFunctional", label: "NFRs" }],
	"research-agent":        [{ stage: "requirements", path: "acceptanceCriteria", label: "ACs" }],
	"debug-analyzer":        [{ stage: "requirements", path: "acceptanceCriteria", label: "ACs" }],
	"architecture-designer": [{ stage: "requirements", path: "acceptanceCriteria", label: "ACs" }, { stage: "code-assessment", path: "patterns", label: "Patterns" }],
	"product-designer":      [{ stage: "requirements", path: "acceptanceCriteria", label: "ACs" }],
	"ui-ux-designer":        [{ stage: "requirements", path: "acceptanceCriteria", label: "ACs" }],
	"architecture-improver": [{ stage: "requirements", path: "acceptanceCriteria", label: "ACs" }],
	"spec-writer":           [{ stage: "requirements", path: "acceptanceCriteria", label: "ACs" }, { stage: "bdd", path: "features", label: "Scenarios" }, { stage: "code-assessment", path: "patterns", label: "Patterns" }, { stage: "code-assessment", path: "services", label: "Services" }],
	"spec-reviewer":         [{ stage: "spec", path: "phases", label: "Phases" }, { stage: "spec", path: "summary", label: "Summary" }],
	"tdd-guide":             [{ stage: "spec", path: "phases", label: "Phases" }],
	"implementer":           [{ stage: "spec", path: "phases", label: "Phases" }, { stage: "code-assessment", path: "patterns", label: "Patterns" }],
	"qa-agent":              [{ stage: "spec", path: "phases", label: "Phases" }],
	"code-reviewer":         [{ stage: "spec", path: "phases", label: "Phases" }, { stage: "spec", path: "summary", label: "Summary" }],
	"adversarial-reviewer":  [{ stage: "spec", path: "phases", label: "Phases" }],
	"api-tester":            [{ stage: "bdd", path: "features", label: "Scenarios" }, { stage: "code-assessment", path: "services", label: "Services" }],
	"ui-tester":             [{ stage: "bdd", path: "features", label: "Scenarios" }, { stage: "code-assessment", path: "services", label: "Services" }],
	"docs-executor":         [{ stage: "spec", path: "phases", label: "Phases" }, { stage: "spec", path: "summary", label: "Summary" }],
	"prototype-runner":      [{ stage: "design", path: "modules", label: "Modules" }],
};

/** Navigate a dot-notation path into an object: "a.b.c" → obj.a.b.c */
function navigatePath(obj: unknown, path: string): unknown {
	return path.split(".").reduce<unknown>((curr, key) => (curr as Record<string, unknown>)?.[key], obj);
}

/** Format a value compactly for prompt injection. */
function formatValue(value: unknown): string {
	if (value == null) return "";
	if (typeof value === "string") return value;
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	if (Array.isArray(value)) return value.map(formatItem).filter(Boolean).join("; ");
	if (typeof value === "object") return JSON.stringify(value);
	return String(value);
}

/** Format a single array item — handles common control-object shapes. */
function formatItem(item: unknown): string {
	if (typeof item === "string") return item;
	if (item && typeof item === "object") {
		const obj = item as Record<string, unknown>;
		if (Array.isArray(obj.scenarios)) {
			return (obj.scenarios as Array<Record<string, unknown>>)
				.map((s) => `SCENARIO-${s.id} (${s.acRef})`).join(", ");
		}
		const id = obj.id ?? obj.name ?? "";
		const desc = obj.statement ?? obj.description ?? obj.example ?? obj.title ?? obj.cmd ?? "";
		return id ? `${id}: ${desc}` : String(desc);
	}
	return String(item);
}

/** Extract ONLY the fields this agent needs from .knowledge.json. Returns a
 *  compact string for prompt injection. Empty if file doesn't exist or agent
 *  has no declared needs. */
export function knowledgeForAgent(specDir: string, agentName: string): string {
	const needs = AGENT_KNOWLEDGE_NEEDS[agentName];
	if (!needs?.length) return "";

	let knowledge: KnowledgeFile;
	try { knowledge = JSON.parse(readFileSync(knowledgePath(specDir), "utf8")); } catch { return ""; }

	const lines: string[] = [];
	for (const { stage, path, label } of needs) {
		const stageData = knowledge.stages[stage]?.data;
		if (!stageData) continue;
		const value = navigatePath(stageData, path);
		const formatted = formatValue(value);
		if (formatted) lines.push(`- ${label}: ${formatted}`);
	}
	return lines.length > 0 ? lines.join("\n") : "";
}
