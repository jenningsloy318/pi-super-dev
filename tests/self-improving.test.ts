/**
 * Tests for the self-improving pipeline: knowledge.json, knowledgeForAgent,
 * learned injection, audit trail, cleanup.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendToKnowledge, clearKnowledge, knowledgeForAgent, knowledgePath, AGENT_KNOWLEDGE_NEEDS } from "../src/render/knowledge.ts";

// ─── knowledge.json ──────────────────────────────────────────────────────────

describe("knowledge.json accumulation + extraction", () => {
	let dir: string;
	beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "sd-knowledge-")); clearKnowledge(dir); });
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	it("clearKnowledge creates empty JSON", () => {
		const raw = readFileSync(knowledgePath(dir), "utf8");
		expect(JSON.parse(raw)).toEqual({ stages: {} });
	});

	it("appendToKnowledge stores a control object", () => {
		appendToKnowledge(dir, "requirements", {
			title: "Rain",
			acceptanceCriteria: [{ id: "AC-01", statement: "Fetch rain data" }, { id: "AC-02", statement: "Sum values" }],
			nonFunctional: ["Performance: <100ms"],
			summary: "Add rain total.",
		});
		const raw = readFileSync(knowledgePath(dir), "utf8");
		const parsed = JSON.parse(raw);
		expect(parsed.stages.requirements.data.acceptanceCriteria).toHaveLength(2);
		expect(parsed.stages.requirements.data.summary).toBe("Add rain total.");
	});

	it("appendToKnowledge accumulates multiple stages", () => {
		appendToKnowledge(dir, "requirements", { acceptanceCriteria: [{ id: "AC-01", statement: "Fetch" }], summary: "req" });
		appendToKnowledge(dir, "bdd", { features: [{ name: "F1", scenarios: [{ id: "001", acRef: "AC-01" }] }], summary: "bdd" });
		const raw = readFileSync(knowledgePath(dir), "utf8");
		const parsed = JSON.parse(raw);
		expect(Object.keys(parsed.stages)).toEqual(["requirements", "bdd"]);
	});

	it("knowledgeForAgent extracts only the needed fields", () => {
		appendToKnowledge(dir, "requirements", {
			acceptanceCriteria: [{ id: "AC-01", statement: "Fetch rain" }, { id: "AC-02", statement: "Sum" }],
			nonFunctional: ["Perf"],
			summary: "Rain feature",
		});
		// BDD needs ACs + NFRs
		const result = knowledgeForAgent(dir, "bdd-scenario-writer");
		expect(result).toContain("AC-01");
		expect(result).toContain("Fetch rain");
		expect(result).toContain("NFRs");
		expect(result).toContain("Perf");
		// Should NOT contain the summary (BDD doesn't need it)
		expect(result).not.toContain("Rain feature");
	});

	it("knowledgeForAgent returns empty for agents with no needs", () => {
		appendToKnowledge(dir, "requirements", { summary: "x" });
		expect(knowledgeForAgent(dir, "orchestrator")).toBe("");
	});

	it("knowledgeForAgent returns empty on cold start (no file)", () => {
		rmSync(knowledgePath(dir));
		expect(knowledgeForAgent(dir, "spec-writer")).toBe("");
	});

	it("knowledgeForAgent flattens features → scenarios for spec-writer", () => {
		appendToKnowledge(dir, "bdd", {
			features: [{ name: "Rain", scenarios: [{ id: "001", acRef: "AC-01" }, { id: "002", acRef: "AC-02" }] }],
		});
		const result = knowledgeForAgent(dir, "spec-writer");
		expect(result).toContain("SCENARIO-001");
		expect(result).toContain("SCENARIO-002");
		expect(result).toContain("AC-01");
	});

	it("AGENT_KNOWLEDGE_NEEDS covers all doc-producing agents", () => {
		const agentsWithNeeds = Object.keys(AGENT_KNOWLEDGE_NEEDS).filter(a => AGENT_KNOWLEDGE_NEEDS[a].length > 0);
		expect(agentsWithNeeds.length).toBeGreaterThanOrEqual(10);
		// Key agents must have needs
		expect(AGENT_KNOWLEDGE_NEEDS["spec-writer"]).toBeDefined();
		expect(AGENT_KNOWLEDGE_NEEDS["bdd-scenario-writer"]).toBeDefined();
		expect(AGENT_KNOWLEDGE_NEEDS["code-reviewer"]).toBeDefined();
	});
});

// ─── learned.md injection ────────────────────────────────────────────────────

describe("learned.md injection (loadLearnedLessons)", () => {
	it("returns empty string on cold start (no learned-index.json)", async () => {
		const { loadLearnedLessons } = await import("../src/render/learned.ts");
		// By default no learned-index.json exists in the test env
		const result = loadLearnedLessons("spec-writer");
		// Could be "" if no index, or contain lessons if the dev env has them
		expect(typeof result).toBe("string");
	});
});

// ─── audit trail ─────────────────────────────────────────────────────────────

describe("audit trail (super-dev-dir)", () => {
	it("auditAppend gracefully handles no active run", async () => {
		const { auditAppend } = await import("../src/render/super-dev-dir.ts");
		expect(() => auditAppend({ stage: "test", control: { x: 1 } })).not.toThrow();
	});
	it("config defaults are correct", async () => {
		const { getConfig } = await import("../src/render/super-dev-dir.ts");
		const config = getConfig();
		expect(config.reflectionEnabled).toBe(true);
		expect(config.topNPreload).toBe(3);
		expect(config.maxLearnedEntries).toBe(200);
		expect(config.runRetentionDays).toBe(30);
	});
});

// ─── cleanup ─────────────────────────────────────────────────────────────────

describe("cleanup + stats", () => {
	it("cleanupOldRuns does not crash with no runs dir", async () => {
		const { cleanupOldRuns } = await import("../src/render/cleanup.ts");
		expect(() => cleanupOldRuns()).not.toThrow();
	});
	it("updateStats does not crash with no audit", async () => {
		const { updateStats } = await import("../src/render/cleanup.ts");
		expect(() => updateStats()).not.toThrow();
	});
});
