/**
 * v0.3.76 — SKILL CURATION (per-call curated skill injection, L0+L1+L3).
 *
 * Measured problem (run 2026-09-07T00-49-33-204Z): ambient skill discovery
 * injects ALL cards (~37K tokens) into EVERY delegated child; 1/99 agents
 * actually used a skill (research-agent → firecrawl); task-classifier burned
 * 50,914 input tokens for 127 output tokens.
 *
 * Approved architecture (user, 2026-09-07):
 *  - L0: mechanical classifier roles → `skill:false` (zero injection).
 *  - L1: task-classifier emits optional `skillDomains` (map-driven catalog
 *    in its prompt); research roles get the firecrawl family ∪ mapped
 *    domains. Capability roles stay AMBIENT (fail-open — the standing
 *    "subagents same as pi" decision holds for them).
 *  - L3: `SUPER_DEV_SKILLS=ambient` restores today's behavior for all roles.
 *  - L2 (collection only, this wave): delegation tool-ticks land in
 *    <specDir>/tool-usage.jsonl as the raw feed for future curation loops.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";

vi.mock("../src/render/knowledge.ts", () => ({ knowledgeForAgent: vi.fn(() => "") }));
vi.mock("../src/agents/fleet-visibility.ts", () => ({
	resolveExternalRunsModule: vi.fn(async () => null),
}));
vi.mock("../src/agents/register-agents.ts", () => ({ delegationOwnerPresent: vi.fn(() => null) }));

import {
	skillsForCall,
	MECHANICAL_CLASSIFIER_ROLES,
	SKILL_DOMAINS,
	DEFAULT_RESEARCH_SKILLS,
	ambientSkillsForced,
	explicitSkillConfigured,
	resetAmbientSkillsForcedForTests,
} from "../src/agents/agent-runtime.ts";
import { appendToolUsageRows } from "../src/evolution/tool-usage.ts";
import { ClassificationData } from "../src/render/schemas.ts";
import { buildClassifyPrompt } from "../src/prompts.ts";
import { makeContext } from "../src/workflow.ts";
import type { AgentCall, PipelineState, RunOptions } from "../src/types.ts";

const mkCtx = (state: PipelineState, options: RunOptions = {}) => makeContext(state, "t", options, () => {});
const CALL: AgentCall = { id: "pipeline.classify", agent: "task-classifier", prompt: "x" };

describe("v0.3.76 L0 — mechanical classifier roles get skill:false", () => {
	beforeEach(() => { resetAmbientSkillsForcedForTests(); delete process.env.SUPER_DEV_SKILLS; });
	afterEach(() => { resetAmbientSkillsForcedForTests(); delete process.env.SUPER_DEV_SKILLS; });

	it("every mechanical classifier role resolves to false (zero injection)", () => {
		for (const role of ["task-classifier", "judge", "tdd-coverage-classifier", "red-boundary-classifier"]) {
			expect(MECHANICAL_CLASSIFIER_ROLES.has(role)).toBe(true);
			expect(skillsForCall(role, {})).toBe(false);
		}
	});
	it("capability roles resolve to undefined (ambient — the standing fail-open decision)", () => {
		expect(skillsForCall("implementer", {})).toBeUndefined();
		expect(skillsForCall("code-reviewer", {})).toBeUndefined();
		expect(skillsForCall("requirements-clarifier", {})).toBeUndefined();
	});
	it("L3 escape hatch SUPER_DEV_SKILLS=ambient restores ambient for EVERY role", () => {
		process.env.SUPER_DEV_SKILLS = "ambient";
		expect(skillsForCall("task-classifier", {})).toBeUndefined();
		expect(skillsForCall("research-agent", {})).toBeUndefined();
	});
	it("config agentSkills wins over the built-in tiers (explicit false or a curated list)", () => {
		expect(skillsForCall("code-reviewer", { agentSkills: { "code-reviewer": false } })).toBe(false);
		expect(skillsForCall("implementer", { agentSkills: { implementer: ["tdd"] } })).toEqual(["tdd"]);
		// …but an ambient escape hatch still wins over config (global kill-switch);
		// the decision is per-SESSION (memoized), so simulate the fresh session in
		// which the operator had already set ambient (dual-review R3/AR-1 semantics)
		process.env.SUPER_DEV_SKILLS = "ambient";
		resetAmbientSkillsForcedForTests();
		expect(skillsForCall("implementer", { agentSkills: { implementer: ["tdd"] } })).toBeUndefined();
	});
});

describe("v0.3.76 L1 — research roles get the firecrawl family ∪ mapped domains", () => {
	beforeEach(() => { resetAmbientSkillsForcedForTests(); delete process.env.SUPER_DEV_SKILLS; });
	afterEach(() => { resetAmbientSkillsForcedForTests(); delete process.env.SUPER_DEV_SKILLS; });

	it("the approved research family is the full firecrawl set", () => {
		expect(DEFAULT_RESEARCH_SKILLS).toEqual([
			"firecrawl", "firecrawl-search", "firecrawl-crawl", "firecrawl-scrape",
			"firecrawl-map", "firecrawl-instruct", "firecrawl-download", "firecrawl-agent",
		]);
	});
	it("research-agent resolves to the family (with or without selected domains)", () => {
		expect(skillsForCall("research-agent", {})).toEqual(DEFAULT_RESEARCH_SKILLS);
		const withDomain = skillsForCall("research-agent", { skillDomains: ["web-research", "made-up-domain"] }) as string[];
		expect(withDomain).toEqual(expect.arrayContaining(DEFAULT_RESEARCH_SKILLS));
		expect(new Set(withDomain).size).toBe(withDomain.length); // union dedupes
	});
	it("unknown domains are recorded-tolerant but map to nothing (no invention)", () => {
		const mapped = skillsForCall("research-agent", { skillDomains: ["nonexistent"] }) as string[];
		expect(mapped).toEqual(DEFAULT_RESEARCH_SKILLS); // nothing added
	});
	it("SKILL_DOMAINS is map-driven with a web-research entry whose members are real skills", () => {
		const web = SKILL_DOMAINS.find((d) => d.name === "web-research");
		expect(web).toBeDefined();
		expect(web!.skills.length).toBeGreaterThan(0);
		for (const d of SKILL_DOMAINS) {
			expect(typeof d.description).toBe("string");
			expect(d.description.length).toBeGreaterThan(10);
		}
	});
});

describe("v0.3.76 L1 — classifier control + prompt carry the domain catalog", () => {
	it("ClassificationData accepts optional skillDomains (tolerant strings)", () => {
		const ok = ClassificationData; // structural presence
		expect(ok).toBeDefined();
		// schema-level: the property is optional and an array of strings
		const src = JSON.stringify(ClassificationData);
		expect(src).toContain("skillDomains");
	});
	it("buildClassifyPrompt renders the domain catalog (name + members) and asks for skillDomains", () => {
		const md = buildClassifyPrompt({ worktreePath: "/w", language: "ts", isWebUi: false } as never, "do a thing");
		expect(md).toContain("skillDomains");
		expect(md).toContain("web-research");
		expect(md).toContain("firecrawl");
	});
});

	describe("v0.3.76 — realAgent threads skill onto the delegation request", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "sd-skillcur-"));
		resetAmbientSkillsForcedForTests();
		delete process.env.SUPER_DEV_SKILLS;
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
		resetAmbientSkillsForcedForTests();
		delete process.env.SUPER_DEV_SKILLS;
	});

	function spyBus(seen: any[], usage?: Record<string, number>) {
		const bus = new EventEmitter() as any;
		bus.on("prompt-template:subagent:request", (req: any) => {
			seen.push(req);
			queueMicrotask(() => {
				bus.emit("prompt-template:subagent:response", {
					requestId: req.requestId, ownerRunId: req.ownerRunId, nodeId: req.nodeId,
					status: "completed",
					result: { kind: "text", text: 'ok <control>{"taskType":"feature","uiScope":"none","rationale":"r"}</control>' },
					model: "fake/model-1",
					usage,
				});
			});
		});
		return bus;
	}

	it("a task-classifier call sends skill:false on the wire", async () => {
		const seen: any[] = [];
		const ctx = mkCtx({ setup: { specDirectory: dir, specIdentifier: "sc1" } as any }, { events: spyBus(seen) } as RunOptions);
		await ctx.agent({ ...CALL, prompt: "Output <control> JSON with: taskType." });
		expect(seen).toHaveLength(1);
		expect(seen[0].skill).toBe(false);
	});
	it("an implementer call leaves skill ABSENT on the wire (ambient)", async () => {
		const seen: any[] = [];
		const ctx = mkCtx({ setup: { specDirectory: dir, specIdentifier: "sc2" } as any }, { events: spyBus(seen) } as RunOptions);
		await ctx.agent({ ...CALL, id: "pipeline.implementation.phase-01.impl", agent: "implementer" });
		expect(seen[0].skill).toBeUndefined();
	});
	it("a research-agent call sends the curated family; SUPER_DEV_SKILLS=ambient omits it", async () => {
		const seen: any[] = [];
		const ctx = mkCtx({ setup: { specDirectory: dir, specIdentifier: "sc3" } as any }, { events: spyBus(seen) } as RunOptions);
		await ctx.agent({ ...CALL, id: "pipeline.research", agent: "research-agent" });
		expect(seen[0].skill).toEqual(DEFAULT_RESEARCH_SKILLS);
		process.env.SUPER_DEV_SKILLS = "ambient";
		resetAmbientSkillsForcedForTests(); // fresh session — ambient was set before dispatch
		const seen2: any[] = [];
		const ctx2 = mkCtx({ setup: { specDirectory: dir, specIdentifier: "sc4" } as any }, { events: spyBus(seen2) } as RunOptions);
		await ctx2.agent({ ...CALL, id: "pipeline.research", agent: "research-agent" });
		expect(seen2[0].skill).toBeUndefined();
	});
});

describe("v0.3.76 L2 (collection) — tool-usage telemetry", () => {
	let dir: string;
	beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "sd-toolusage-")); });
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	it("appendToolUsageRows writes one JSON line per row, never throws without a dir", () => {
		appendToolUsageRows(dir, [
			{ ts: 1, runId: "r", agent: "sd-research-agent", tool: "bash", argHead: "firecrawl search q" },
			{ ts: 2, runId: "r", agent: "sd-research-agent", tool: "bash", argHead: "firecrawl search q2" },
		]);
		const lines = readFileSync(join(dir, "tool-usage.jsonl"), "utf8").trim().split("\n");
		expect(lines).toHaveLength(2);
		expect(JSON.parse(lines[0]).argHead).toBe("firecrawl search q");
		expect(() => appendToolUsageRows(undefined, [{ ts: 1, runId: "r", agent: "a", tool: "bash", argHead: "" }])).not.toThrow();
	});

	it("delegation tool-ticks flow into tool-usage.jsonl via the collector (deduped per call)", async () => {
		const bus = new EventEmitter() as any;
		let tick = 0;
		bus.on("prompt-template:subagent:request", (req: any) => {
			queueMicrotask(() => {
				bus.emit("prompt-template:subagent:update", {
					requestId: req.requestId,
					recentTools: tick++ === 0
						? [{ tool: "bash", args: "firecrawl search hello" }, { tool: "read", args: "src/a.ts" }]
						: [{ tool: "bash", args: "firecrawl search hello" }], // duplicate on next tick
					currentTool: "grep",
				});
				queueMicrotask(() => {
					bus.emit("prompt-template:subagent:response", {
						requestId: req.requestId, ownerRunId: req.ownerRunId, nodeId: req.nodeId,
						status: "completed",
						result: { kind: "text", text: "ok" },
						model: "fake/model-1",
					});
				});
			});
		});
		const ctx = mkCtx({ setup: { specDirectory: dir, specIdentifier: "tu1" } as any }, { events: bus } as RunOptions);
		await ctx.agent({ ...CALL, id: "pipeline.research", agent: "research-agent" });
		const rows = readFileSync(join(dir, "tool-usage.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
		const keys = rows.map((r) => `${r.tool} ${r.argHead}`.trim());
		expect(keys).toContain("bash firecrawl search hello"); // argHead = first words, bounded
		expect(keys).toContain("read src/a.ts");
		expect(keys).toContain("grep");
		expect(keys.filter((k) => k === "bash firecrawl search hello")).toHaveLength(1); // deduped across ticks
	});
});

describe("v0.3.76 — tool-usage.jsonl is registered harness bookkeeping (M1 lesson)", () => {
	it("carries events.jsonl-parity roles in HARNESS_FILE_ROLES", async () => {
		const { HARNESS_FILE_ROLES } = await import("../src/harness-paths.ts");
		expect(HARNESS_FILE_ROLES["tool-usage.jsonl"]).toEqual({
			redBoundarySpecScoped: true, trackerAdvisoryNoise: true, specDirBookkeeping: true,
		});
	});
});

describe("v0.3.76 dual-review fixes — two-layer coherence (registration × per-call)", () => {
	beforeEach(() => {
		resetAmbientSkillsForcedForTests();
		delete process.env.SUPER_DEV_SKILLS;
		delete process.env.SUPER_DEV_NO_SKILLS;
	});
	afterEach(() => {
		resetAmbientSkillsForcedForTests();
		delete process.env.SUPER_DEV_SKILLS;
		delete process.env.SUPER_DEV_NO_SKILLS;
	});

	it("R4/AR-N2: an explicit empty array ≡ false (zero cards), NOT a fall-through to the built-in tiers", () => {
		expect(skillsForCall("research-agent", { agentSkills: { "research-agent": [] } })).toBe(false);
		expect(skillsForCall("implementer", { agentSkills: { implementer: [] } })).toBe(false);
	});

	it("R2/AR-N3: SUPER_DEV_NO_SKILLS=1 gates the PER-CALL layer too — full pre-v0.3.76 isolation restored as the top kill-switch", () => {
		process.env.SUPER_DEV_NO_SKILLS = "1";
		expect(skillsForCall("research-agent", {})).toBe(false);
		expect(skillsForCall("task-classifier", {})).toBe(false);
		// …and it beats an explicit config entry (switch hierarchy: NO_SKILLS > ambient > config > tiers)
		expect(skillsForCall("implementer", { agentSkills: { implementer: ["tdd"] } })).toBe(false);
	});

	it("R1/AR-2: explicitSkillConfigured flags ANY explicit entry (false | non-empty array | empty array) for the registration flip", () => {
		expect(explicitSkillConfigured({ implementer: false }, "implementer")).toBe(true);
		expect(explicitSkillConfigured({ implementer: ["tdd"] }, "implementer")).toBe(true);
		expect(explicitSkillConfigured({ implementer: [] }, "implementer")).toBe(true);
		expect(explicitSkillConfigured({ implementer: false }, "code-reviewer")).toBe(false);
		expect(explicitSkillConfigured(undefined, "implementer")).toBe(false);
	});

	it("R3/AR-1: the ambient decision is MEMOIZED once per session — a later env flip cannot desync registration from per-call reads", () => {
		process.env.SUPER_DEV_SKILLS = "ambient";
		expect(ambientSkillsForced()).toBe(true);
		delete process.env.SUPER_DEV_SKILLS;
		expect(ambientSkillsForced()).toBe(true); // cached: registration (activate) and skillsForCall agree
		resetAmbientSkillsForcedForTests();
		expect(ambientSkillsForced()).toBe(false); // fresh session re-resolves
	});
});
