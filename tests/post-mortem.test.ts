/**
 * v0.3.69 E2 — POST-MORTEM AGENT (Weng's Agent Debugger, read-only + inbox).
 *
 * Experience observability was the manual gap in the evolution-loop map
 * (plan §9.1): a human+agent session reads run.log on demand. E2 automates
 * the DRAFT half — a read-only sd-post-mortem agent reads run artifacts
 * (paths in, JIT reading), matches the failure against the P1–P10 escape
 * classes, and returns a STRUCTURED finding draft; the ENGINE (never the
 * agent — P4) validates and writes it to docs/findings/inbox/. The Decide
 * gate stays human (E3); the agent can never edit methodology/src/prompts.
 *
 * Contract under test:
 *  - shouldAutoPostMortem: only status!=success AND config postMortem==="auto"
 *    (default manual — safety-first per plan).
 *  - validateFindingDraft: fail-closed (title, ≥1 evidence, rootCauseHypothesis,
 *    prediction{metric,direction} mandatory) — the engine refuses junk.
 *  - renderFindingDraft: deterministic markdown with governance header
 *    (status: draft, advisory-only), evidence quotes w/ sources, prediction.
 *  - writeFindingDraft: inbox file, timestamped slug, never overwrites.
 *  - runPostMortem: delegates sd-post-mortem; a valid control becomes an
 *    inbox draft; agent errors surface honestly (no fabrication).
 *  - registration: post-mortem is a registered read-only agent.
 */
import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";

vi.mock("../src/render/knowledge.ts", () => ({ knowledgeForAgent: vi.fn(() => "") }));
vi.mock("../src/agents/fleet-visibility.ts", () => ({
	resolveExternalRunsModule: vi.fn(async () => false),
	fleetBegin: vi.fn(), fleetUpdate: vi.fn(), fleetFinish: vi.fn(),
}));

import {
	shouldAutoPostMortem,
	validateFindingDraft,
	renderFindingDraft,
	writeFindingDraft,
	runPostMortem,
	type FindingDraft,
} from "../src/evolution/post-mortem.ts";
import { READ_ONLY_AGENTS, REGISTERED_AGENTS } from "../src/agents/register-agents.ts";
import { readFileSync as rf } from "node:fs";

const DRAFT: FindingDraft = {
	title: "Reviewer agent errors masquerade as rejections",
	escapeClass: "P5",
	evidence: [{ source: "run.log:412", quote: "review agent errored round 3 (3/3 consecutive)" }],
	rootCauseHypothesis: "Infra failure counted as artifact verdict (G21 wrap)",
	proposedFix: "FatalAbort on consecutive agent-error rounds with infra error named",
	pinningTest: "3 consecutive error rounds → FatalAbort naming the error",
	prediction: { metric: "agentErrorRounds", direction: "decrease" },
	confidence: "medium",
};

describe("v0.3.69 E2 — post-mortem gating", () => {
	it("auto post-mortem requires status!=success AND postMortem==='auto' (default manual)", () => {
		expect(shouldAutoPostMortem("failed", undefined)).toBe(false);
		expect(shouldAutoPostMortem("failed", "manual")).toBe(false);
		expect(shouldAutoPostMortem("success", "auto")).toBe(false);
		expect(shouldAutoPostMortem("failed", "auto")).toBe(true);
		expect(shouldAutoPostMortem("partial", "auto")).toBe(true);
	});
});

describe("v0.3.69 E2 — draft validation (fail-closed)", () => {
	it("a complete draft passes", () => {
		expect(validateFindingDraft(DRAFT)).toBe(true);
	});
	it("missing title / evidence / hypothesis / prediction are refused", () => {
		expect(validateFindingDraft({ ...DRAFT, title: "" })).toBe(false);
		expect(validateFindingDraft({ ...DRAFT, evidence: [] })).toBe(false);
		expect(validateFindingDraft({ ...DRAFT, rootCauseHypothesis: "" })).toBe(false);
		expect(validateFindingDraft({ ...DRAFT, prediction: undefined })).toBe(false);
		expect(validateFindingDraft({ ...DRAFT, prediction: { metric: "", direction: "decrease" } })).toBe(false);
		expect(validateFindingDraft({ ...DRAFT, prediction: { metric: "agentErrorRounds", direction: "sideways" as never } })).toBe(false);
	});
});

describe("v0.3.69 E2 — deterministic draft rendering + inbox write", () => {
	it("renderFindingDraft carries governance header, evidence, prediction", () => {
		const md = renderFindingDraft(DRAFT, { runId: "run-1", status: "failed" });
		expect(md).toContain("status: draft");
		expect(md).toContain("advisory-only");
		expect(md).toContain(DRAFT.title);
		expect(md).toContain("run.log:412");
		expect(md).toContain("P5");
		expect(md).toContain("prediction: agentErrorRounds decrease");
		expect(md).toContain("run-1");
	});
	it("writeFindingDraft writes a timestamped inbox file, never overwrites", () => {
		const dir = mkdtempSync(join(tmpdir(), "sd-inbox-"));
		try {
			const p1 = writeFindingDraft(dir, DRAFT, { runId: "run-1", status: "failed" });
			expect(existsSync(p1)).toBe(true);
			expect(p1).toContain(join(dir, ""));
			const p2 = writeFindingDraft(dir, DRAFT, { runId: "run-1", status: "failed" });
			expect(p2).not.toBe(p1); // same slug → disambiguated, never overwritten
			expect(readdirSync(dir).filter((f) => f.endsWith(".md"))).toHaveLength(2);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("v0.3.69 E2 — runPostMortem delegation (engine writes, agent never does)", () => {
	function controlBus(control: unknown) {
		const bus = new EventEmitter() as any;
		bus.on("prompt-template:subagent:request", (req: any) => {
			queueMicrotask(() => bus.emit("prompt-template:subagent:response", {
				requestId: req.requestId, ownerRunId: req.ownerRunId, nodeId: req.nodeId,
				status: "completed",
				result: { kind: "text", text: `pm <control>${JSON.stringify(control)}</control>` },
				model: "fake/pm",
			}));
		});
		return bus;
	}
	it("a valid control becomes an inbox draft (engine-written)", async () => {
		const inbox = mkdtempSync(join(tmpdir(), "sd-inbox-"));
		try {
			const out = await runPostMortem({
				events: controlBus(DRAFT) as never,
				inboxDir: inbox,
				runId: "run-pm-1",
				status: "failed",
				metricsRow: { runId: "run-pm-1", status: "failed", agentsSpawned: 9, wallMs: 1000, stages: { failed: 1 }, agentErrorRounds: 3, fatalAborts: 1, usage: { calls: 9, input: 1, output: 1, cost: 0.01 }, ts: 1 },
				artifactPaths: { runLog: "/tmp/run.log", eventsJsonl: "/tmp/events.jsonl", specDir: "/tmp/spec" },
			});
			expect(out.draftPath).toBeDefined();
			const md = readFileSync(out.draftPath!, "utf8");
			expect(md).toContain(DRAFT.title);
			expect(out.error).toBeUndefined();
		} finally {
			rmSync(inbox, { recursive: true, force: true });
		}
	});
	it("agent error surfaces honestly; NO draft is fabricated", async () => {
		const bus = new EventEmitter() as any;
		bus.on("prompt-template:subagent:request", (req: any) => {
			queueMicrotask(() => bus.emit("prompt-template:subagent:response", {
				requestId: req.requestId, ownerRunId: req.ownerRunId, nodeId: req.nodeId,
				status: "failed", error: "model exploded", model: "fake/pm",
			}));
		});
		const inbox = mkdtempSync(join(tmpdir(), "sd-inbox-"));
		try {
			const out = await runPostMortem({
				events: bus as never, inboxDir: inbox, runId: "run-pm-2", status: "failed",
				metricsRow: { runId: "run-pm-2", status: "failed", agentsSpawned: 1, wallMs: 1, stages: {}, agentErrorRounds: 0, fatalAborts: 0, usage: { calls: 0, input: 0, output: 0, cost: 0 }, ts: 1 },
				artifactPaths: { runLog: "/tmp/x", eventsJsonl: "/tmp/y", specDir: "/tmp/z" },
			});
			expect(out.draftPath).toBeUndefined();
			expect(out.error).toBeTruthy();
			expect(readdirSync(inbox)).toHaveLength(0);
		} finally {
			rmSync(inbox, { recursive: true, force: true });
		}
	});
});

describe("v0.3.69 E2 — registration (source contract)", () => {
	it("post-mortem is a REGISTERED read-only agent with a prompt file", () => {
		expect(REGISTERED_AGENTS).toContain("post-mortem");
		expect(READ_ONLY_AGENTS.has("post-mortem")).toBe(true);
		expect(rf("agents/post-mortem.md", "utf8")).toContain("post-mortem");
	});
});
