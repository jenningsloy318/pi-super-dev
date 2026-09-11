/**
 * v0.3.87 S4(b)+(d) — the engine-mediated research assist (§9 S4, §10
 * decision 9, §13, §14 ADR 6 of docs/requirements/run-2026-09-09-poisoned-
 * baseline-postmortem-v0.3.85.md).
 *
 * P8 + P5 + P1 binding — every behavior gets a test that provokes it:
 *   - trigger sides: RED ≥2 terminal tries (§D re-entry dispatch), GREEN
 *     faultClassStreak ≥2 (next-attempt dispatch), NEITHER below threshold
 *     (needsResearch present + gate cold → NO dispatch, entries archived);
 *   - dispatch seam: 240s per-call timeoutMs + the resolved assist toolBudget
 *     (config-sourced; absent → OMITTED from the call);
 *   - injection: ≤2KB block via the EXISTING corrective-prompt channel
 *     (implParts), noUsefulSignal honest-empty that still accompanies;
 *   - per-phase cap 1: a second trigger proceeds WITHOUT assist, logged
 *     honestly (persists across §D re-entries via the control);
 *   - failure semantics (P5): a failed/timed-out assist degrades to a
 *     noUsefulSignal ledger row — the v0.3.65 agent-error fuse is untouched
 *     (no ctx.results row), no attempt consumed, no abort;
 *   - ledger rows (shape, four-role registry + phase-commit exclusion);
 *   - implementer schema validation (question+why mandatory when non-empty;
 *     tdd-guide's control line carries NO such field);
 *   - ResearchAssistData caps enforcement + the S1 pairing decision (the
 *     schema is INTERNAL/non-ControlData — pinned HERE, not in
 *     control-contract-shapes.test.ts).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Value } from "typebox/value";
import type { TSchema } from "typebox";

// ─── stage mocks (the implementation-bounds.test.ts harness pattern) ───────

let gateQ: Array<Record<string, unknown>> = [];
let deliverableQ: Array<Record<string, unknown>> = [];
const PASS_GATE = { pass: true, buildSuccess: true, allTestsPass: true, typecheckSuccess: true, inScopePass: true, errors: [] as string[], outOfScopeErrors: [] as string[], ran: ["npm test"] };
const DELIV_PASS = { pass: true, missing: [] as string[], ran: [] as string[] };
/** Scriptable runRedCheck result (entry-granular for the RED-side tests). */
let redStatusScripted = "unknown";

vi.mock("../src/build-runner.ts", async (orig) => {
	const a = (await orig()) as Record<string, unknown>;
	return {
		...a,
		runRedCheck: () => redStatusScripted,
		runBuildGate: () => gateQ.shift() ?? PASS_GATE,
		runDeliverableCheck: () => deliverableQ.shift() ?? DELIV_PASS,
		computeChangeGate: () => ({ pass: true, claimedNotChanged: [], changedNotClaimed: [], advisory: [] }),
		resetDeliverableCheckCache: () => {},
	};
});
vi.mock("../src/render/render.ts", () => ({ renderAndWrite: vi.fn() }));
vi.mock("../src/render/reflection.ts", () => ({ runReflectionAsync: vi.fn() }));
vi.mock("../src/render/user-notes.ts", () => ({ userNotesForAgent: vi.fn(() => "") }));

import { implementationStage } from "../src/stages/implementation.ts";
import {
	RESEARCH_ASSIST_ARCHIVE_CAP,
	RESEARCH_ASSIST_BASENAME,
	RESEARCH_ASSIST_BLOCK_CAP,
	RESEARCH_ASSIST_GREEN_TRIGGER_STREAK,
	RESEARCH_ASSIST_MAX_FINDINGS,
	RESEARCH_ASSIST_MAX_RECOMMENDATION_LINES,
	RESEARCH_ASSIST_MCP_AUDIT_NOTE,
	RESEARCH_ASSIST_RED_TRIGGER_TRIES,
	RESEARCH_ASSIST_ROLE_KEY,
	RESEARCH_ASSIST_TIMEOUT_MS,
	ResearchAssistData,
	appendResearchAssistRow,
	composeResearchAssistQuestion,
	distillResearchAssistControl,
	parseNeedsResearch,
	readResearchAssistRows,
	renderResearchAssistBlock,
	researchAssistLedgerPath,
	runResearchAssist,
} from "../src/stages/research-assist.ts";
import { EXTERNAL_EXPLORATION_BLOCK_LIST } from "../src/agents/agent-runtime.ts";
import type { AgentCall, AgentResult, ControlObj, HelperResult, PipelineState, RunOptions, StageContext } from "../src/types.ts";

// ─── pure-helper fixtures ───────────────────────────────────────────────────

const VALID_ASSIST_CONTROL = {
	findings: [{ claim: "lib X v2 requires async init", source: "https://example.com/x-v2-migration", applies: "phase-02 init must await before first use" }],
	recommendation: "await the initializer in the phase-02 module factory before the first call.",
	noUsefulSignal: false,
};

// ─── parseNeedsResearch: question+why BOTH mandatory when non-empty ─────────

describe("needsResearch control parsing (decision 9: the enrichment field)", () => {
	it("valid entries parse; malformed entries (missing question OR why, empty strings, non-objects) are DISCARDED with one honest log line", () => {
		const logs: string[] = [];
		const out = parseNeedsResearch({
			needsResearch: [
				{ question: "does lib X v2 need async init?", why: "the failure is an uninitialized handle on first use" },
				{ question: "no why given" },
				{ why: "no question given" },
				{ question: "", why: "" },
				"garbage",
				null,
				{ question: "  trimmed  ", why: "  ok  " },
			],
		}, (m) => logs.push(m));
		expect(out).toEqual([
			{ question: "does lib X v2 need async init?", why: "the failure is an uninitialized handle on first use" },
			{ question: "trimmed", why: "ok" },
		]);
		expect(logs).toHaveLength(1);
		expect(logs[0]).toContain("discarded 5");
		expect(logs[0]).toContain("non-empty why");
	});

	it("absent/non-array/malformed control → [] (never throws)", () => {
		expect(parseNeedsResearch(null)).toEqual([]);
		expect(parseNeedsResearch("x")).toEqual([]);
		expect(parseNeedsResearch({ needsResearch: "not-an-array" })).toEqual([]);
		expect(parseNeedsResearch({ needsResearch: [] })).toEqual([]);
	});

	it("bounded to 6 entries per emit (P8)", () => {
		const logs: string[] = [];
		const many = Array.from({ length: 9 }, (_, i) => ({ question: `q${i}`, why: `w${i}` }));
		expect(parseNeedsResearch({ needsResearch: many }, (m) => logs.push(m))).toHaveLength(6);
		expect(logs[0]).toContain("bounded to 6");
	});
});

// ─── ResearchAssistData: caps enforcement + the S1 pairing decision ─────────

describe("ResearchAssistData — output contract + engine-side distillation caps", () => {
	it("S1 pairing decision: the schema is INTERNAL to research-assist.ts (NOT a render/schemas.ts export; no *ControlData name → the S1 exhaustiveness guard does not apply); the schema↔consumer pair is pinned HERE", () => {
		const schemasSrc = readFileSync("src/render/schemas.ts", "utf8");
		expect(schemasSrc, "ResearchAssistData must not move into render/schemas.ts without adding the S1 standalone pairing").not.toContain("ResearchAssistData");
	});

	it("S1 discipline applied at module scope: a schema-generated minimal instance flows through the REAL consumer without error", () => {
		const generated = Value.Create(ResearchAssistData) as { findings: unknown[]; recommendation: string; noUsefulSignal: boolean };
		expect(generated.findings).toEqual([]);
		const distilled = distillResearchAssistControl(generated);
		// Create yields empty strings + [] — a completed call that distilled
		// nothing is the honest-empty degrade, never fabricated findings.
		expect(distilled).not.toBeNull();
		expect(distilled!.noUsefulSignal).toBe(true);
		const itemsNode = (ResearchAssistData as unknown as { properties: { findings: { items: TSchema } } }).properties.findings.items;
		const item = Value.Create(itemsNode) as { claim: string; source: string; applies: string };
		// Create yields all-empty strings for unbounded fields — an all-empty
		// finding is honestly DROPPED (it is not a finding; never fabricate).
		const withEmpty = distillResearchAssistControl({ findings: [item], recommendation: generated.recommendation, noUsefulSignal: false });
		expect(withEmpty!.findings).toHaveLength(0);
		// a schema-generated instance carrying a real claim flows through intact.
		const withItem = distillResearchAssistControl({ findings: [{ ...item, claim: "claim: the API requires an async initializer", source: "tool: web_search docs", applies: "call init() before first use" }], recommendation: generated.recommendation, noUsefulSignal: false });
		expect(withItem!.findings).toHaveLength(1);
	});

	it("findings capped at 5 with an honest dropped-count marker; per-field length caps truncate with a marker", () => {
		const findings = Array.from({ length: 8 }, (_, i) => ({ claim: `claim ${i}`, source: `s${i}`, applies: `a${i}` }));
		const distilled = distillResearchAssistControl({ findings, recommendation: "r", noUsefulSignal: false })!;
		expect(distilled.findings).toHaveLength(RESEARCH_ASSIST_MAX_FINDINGS);
		expect(distilled.findingsDropped).toBe(3);
		const block = renderResearchAssistBlock(distilled);
		expect(block).toContain("+3 finding(s) dropped");
		const longClaim = distillResearchAssistControl({ findings: [{ claim: "c".repeat(600), source: "s", applies: "a" }], recommendation: "r", noUsefulSignal: false })!;
		expect(longClaim.findings[0]!.claim.endsWith("…[truncated]")).toBe(true);
		expect(longClaim.findings[0]!.claim.length).toBeLessThanOrEqual(500);
	});

	it("recommendation capped at 10 lines with an honest marker; unusable control → null; empty yield → noUsefulSignal degrade", () => {
		const eleven = Array.from({ length: 11 }, (_, i) => `line ${i}`).join("\n");
		const distilled = distillResearchAssistControl({ findings: [], recommendation: eleven, noUsefulSignal: false })!;
		expect(distilled.recommendation.split("\n").length).toBe(RESEARCH_ASSIST_MAX_RECOMMENDATION_LINES + 1); // 10 lines + the marker line
		expect(distilled.recommendation).toContain("capped at 10 lines");
		expect(distillResearchAssistControl(null)).toBeNull();
		expect(distillResearchAssistControl("text")).toBeNull();
		expect(distillResearchAssistControl({ findings: "no" })).toBeNull();
		const empty = distillResearchAssistControl({ findings: [], recommendation: "", noUsefulSignal: false })!;
		expect(empty.noUsefulSignal).toBe(true);
	});
});

// ─── block rendering: ≤2KB hard cap + honest-empty notes ────────────────────

describe("renderResearchAssistBlock — the corrective-channel block", () => {
	it("distilled findings render; the block is capped at RESEARCH_ASSIST_BLOCK_CAP with an honest marker; the MCP-audit note rides every block", () => {
		const big = distillResearchAssistControl({
			findings: Array.from({ length: 5 }, (_, i) => ({ claim: `claim ${i} `.repeat(40), source: `source ${i} `.repeat(20), applies: `applies ${i} `.repeat(30) })),
			recommendation: Array.from({ length: 10 }, (_, i) => `recommendation line ${i} with plenty of filler text`).join("\n"),
			noUsefulSignal: false,
		})!;
		const block = renderResearchAssistBlock(big);
		expect(block.length).toBeLessThanOrEqual(RESEARCH_ASSIST_BLOCK_CAP + 200); // marker line fits inside the cap
		expect(block).toContain("## Research assist (engine-mediated — dispatched before this attempt)");
		expect(block).toContain(RESEARCH_ASSIST_MCP_AUDIT_NOTE.split(";")[0]!);
		const oversized = renderResearchAssistBlock(distillResearchAssistControl({
			findings: Array.from({ length: 5 }, () => ({ claim: "c".repeat(500), source: "s".repeat(240), applies: "a".repeat(400) })),
			recommendation: Array.from({ length: 10 }, () => "r".repeat(120)).join("\n"),
			noUsefulSignal: false,
		})!);
		expect(oversized.length).toBeLessThanOrEqual(RESEARCH_ASSIST_BLOCK_CAP);
		expect(oversized).toContain("truncated at the 2048-char cap");
	});

	it("noUsefulSignal renders the honest-empty note that STILL accompanies the attempt; a failure reason renders an honest failure note — both non-empty", () => {
		const empty = renderResearchAssistBlock({ findings: [], recommendation: "", noUsefulSignal: true });
		expect(empty).toContain("research found no useful signal");
		expect(empty.length).toBeGreaterThan(0);
		const failed = renderResearchAssistBlock({ findings: [], recommendation: "", noUsefulSignal: true, failureReason: "timed out after 240000ms" });
		expect(failed).toContain("FAILED");
		expect(failed).toContain("timed out after 240000ms");
	});
});

// ─── question composition ───────────────────────────────────────────────────

describe("composeResearchAssistQuestion — engine-composed context + needsResearch enrichment", () => {
	const base = {
		phaseId: "phase-02",
		phaseName: "Auth wiring",
		trigger: "GREEN" as const,
		triggerDetail: "fault-class product-defect × 2 consecutive attempt(s)",
		contextLines: ["boom: compile error"],
		failingTargets: ["tests/auth.test.ts"],
	};

	it("absent entries: the engine composes the scoped question from the failure context (phase, targets, errors, class)", () => {
		const q = composeResearchAssistQuestion({ ...base, needsResearch: [] });
		expect(q).toContain("phase-02");
		expect(q).toContain("product-defect × 2");
		expect(q).toContain("tests/auth.test.ts");
		expect(q).toContain("boom: compile error");
		expect(q).not.toContain("the implementer specifically asks:");
	});

	it("present entries ENRICH the question (appended as 'the implementer specifically asks: …')", () => {
		const q = composeResearchAssistQuestion({ ...base, needsResearch: [{ question: "does lib X v2 need async init?", why: "uninitialized handle on first use" }] });
		expect(q).toContain("the implementer specifically asks:");
		expect(q).toContain("does lib X v2 need async init?");
		expect(q).toContain("why: uninitialized handle on first use");
	});
});

// ─── the dispatch (runResearchAssist) — seam params + P5 failure semantics ──

/** A minimal fake StageContext that records every agent call. */
function mkAssistCtx(agentImpl?: (call: AgentCall) => Promise<AgentResult> | AgentResult): { ctx: StageContext; calls: AgentCall[]; logs: string[]; results: unknown[] } {
	const calls: AgentCall[] = [];
	const logs: string[] = [];
	const results: unknown[] = [];
	const ctx = {
		task: "t",
		options: {} as RunOptions,
		state: {} as PipelineState,
		budget: { check: () => true, spent: () => true, count: 0 },
		log: (m: string) => { logs.push(m); },
		phase: () => {},
		events: { on: () => () => {}, emit: () => {} },
		results,
		agent: async (call: AgentCall): Promise<AgentResult> => {
			calls.push(call);
			return agentImpl ? await agentImpl(call) : { text: "", control: null };
		},
		helper: async (): Promise<HelperResult> => ({ value: { languageInstructions: "" } as ControlObj, digest: "" }),
		parallel: async (cs: Array<() => Promise<AgentResult>>) => Promise.all(cs.map((c) => c())),
	} as unknown as StageContext;
	return { ctx, calls, logs, results };
}

const assistArgs = (overrides: Partial<Parameters<typeof runResearchAssist>[0]> = {}) => ({
	ctx: undefined as unknown as StageContext,
	specDirectory: undefined as string | undefined,
	phaseId: "phase-02",
	phaseName: "Auth wiring",
	attempt: 3,
	trigger: "GREEN" as const,
	triggerDetail: "fault-class product-defect × 2 consecutive attempt(s)",
	contextLines: ["boom: compile error"],
	failingTargets: ["tests/auth.test.ts"],
	needsResearch: [],
	...overrides,
});

describe("runResearchAssist — the synchronous dispatch seam", () => {
	let specDir = "";
	beforeEach(() => { specDir = mkdtempSync(join(tmpdir(), "sd-assist-")); });
	afterEach(() => { try { rmSync(specDir, { recursive: true, force: true }); } catch { /* tmp */ } });

	it("dispatch carries research-agent (REUSED agent), source-read-only, 240s per-call timeoutMs, the ResearchAssistData schema — and the ledger row lands", async () => {
		const { ctx, calls } = mkAssistCtx(() => ({ text: "", control: { ...VALID_ASSIST_CONTROL } }));
		// toolBudgetConfig: {} pins the hermetic empty config — the REAL config
		// is never read in tests (caps are opt-in policy, machine-dependent).
		const out = await runResearchAssist(assistArgs({ ctx, specDirectory: specDir, toolBudgetConfig: {}, needsResearch: [{ question: "q?", why: "w" }] }));
		expect(calls).toHaveLength(1);
		const call = calls[0]!;
		expect(call.agent).toBe("research-agent"); // §13: no sd-research-assist agent exists — the dispatch reuses research-agent
		expect(call.id).toContain("research-assist");
		expect(call.accessMode).toBe("source-read-only");
		expect(call.timeoutMs).toBe(RESEARCH_ASSIST_TIMEOUT_MS);
		expect(call.timeoutMs).toBe(240_000);
		expect(call.schema).toBe(ResearchAssistData);
		expect(call.prompt).toContain("the implementer specifically asks:");
		// the ledger row (one row per assist attempt)
		const rows = readResearchAssistRows(specDir);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			phaseId: "phase-02",
			attempt: 3,
			trigger: "GREEN",
			enrichedByNeedsResearch: true,
			outcome: "distilled",
			noUsefulSignal: false,
			mcpAudit: RESEARCH_ASSIST_MCP_AUDIT_NOTE,
		});
		expect(typeof rows[0]!.durationMs).toBe("number");
		expect(rows[0]!.question).toContain("the implementer specifically asks:");
		expect(existsSync(researchAssistLedgerPath(specDir))).toBe(true);
		expect(out.block).toContain("lib X v2 requires async init"); // distilled findings render
		expect(out.toolBudgetSent).toBe(false); // empty config → no budget resolved → OMITTED from the call
		expect(call.toolBudget).toBeUndefined();
	});

	it("per-call toolBudget = the resolved assist budget (research-assist → research-agent → common → omitted); config-sourced, never hardcoded", async () => {
		// agentToolBudget["research-assist"] wins
		{
			const { ctx, calls } = mkAssistCtx(() => ({ text: "", control: { ...VALID_ASSIST_CONTROL } }));
			const out = await runResearchAssist(assistArgs({ ctx, specDirectory: specDir, toolBudgetConfig: { agentToolBudget: { "research-assist": { soft: 6, hard: 20 } } } }));
			expect(calls[0]!.toolBudget).toEqual({ soft: 6, hard: 20, block: [...EXTERNAL_EXPLORATION_BLOCK_LIST] });
			expect(out.toolBudgetSent).toBe(true);
		}
		// falls back to research-agent's entry before common
		{
			const { ctx, calls } = mkAssistCtx(() => ({ text: "", control: { ...VALID_ASSIST_CONTROL } }));
			await runResearchAssist(assistArgs({ ctx, specDirectory: specDir, toolBudgetConfig: { commonToolBudget: { soft: 2, hard: 4 }, agentToolBudget: { "research-agent": { soft: 30, hard: 100 } } } }));
			expect(calls[0]!.toolBudget).toEqual({ soft: 30, hard: 100, block: [...EXTERNAL_EXPLORATION_BLOCK_LIST] });
		}
		// common applies when neither assist key is configured
		{
			const { ctx, calls } = mkAssistCtx(() => ({ text: "", control: { ...VALID_ASSIST_CONTROL } }));
			await runResearchAssist(assistArgs({ ctx, specDirectory: specDir, toolBudgetConfig: { commonToolBudget: { soft: 2, hard: 4 } } }));
			expect(calls[0]!.toolBudget).toEqual({ soft: 2, hard: 4, block: [...EXTERNAL_EXPLORATION_BLOCK_LIST] });
		}
		// absent config → OMITTED from the call (caps strictly opt-in)
		{
			const { ctx, calls } = mkAssistCtx(() => ({ text: "", control: { ...VALID_ASSIST_CONTROL } }));
			await runResearchAssist(assistArgs({ ctx, specDirectory: specDir, toolBudgetConfig: {} }));
			expect(calls[0]!.toolBudget).toBeUndefined();
		}
	});

	it("P5 failure semantics: a FAILED assist degrades to a noUsefulSignal ledger row with the failure reason — no throw, no ctx.results row (the v0.3.65 agent-error fuse never sees it), and an honest block still accompanies the attempt", async () => {
		const { ctx, calls, results } = mkAssistCtx(() => ({ text: "", control: null, error: "agent timed out after 240000ms (delegation)" }));
		const out = await runResearchAssist(assistArgs({ ctx, specDirectory: specDir }));
		expect(calls).toHaveLength(1);
		expect(results).toHaveLength(0); // no cause:"agent-error" row is ever pushed — the fuse cannot count it
		const rows = readResearchAssistRows(specDir);
		expect(rows[0]!.outcome).toBe("failed");
		expect(rows[0]!.noUsefulSignal).toBe(true);
		expect(rows[0]!.outcomeSummary).toContain("timed out after 240000ms");
		expect(out.block).toContain("FAILED");
	});

	it("a THROWING agent call degrades identically (never throws through)", async () => {
		const { ctx, results } = mkAssistCtx(() => { throw new Error("delegation bridge exploded"); });
		const out = await runResearchAssist(assistArgs({ ctx, specDirectory: specDir }));
		expect(out.row.outcome).toBe("failed");
		expect(out.row.outcomeSummary).toContain("delegation bridge exploded");
		expect(results).toHaveLength(0);
	});

	it("a completed no-signal answer → outcome no-useful-signal, honest-empty block", async () => {
		const { ctx } = mkAssistCtx(() => ({ text: "", control: { findings: [], recommendation: "", noUsefulSignal: true } }));
		const out = await runResearchAssist(assistArgs({ ctx, specDirectory: specDir }));
		expect(out.row.outcome).toBe("no-useful-signal");
		expect(out.row.noUsefulSignal).toBe(true);
		expect(out.block).toContain("research found no useful signal");
	});
});

// ─── ledger primitives ──────────────────────────────────────────────────────

describe("the research-assists.jsonl ledger", () => {
	it("append is append-only (never rewritten) and read round-trips; absent/unreadable → []", () => {
		const dir = mkdtempSync(join(tmpdir(), "sd-assist-ledger-"));
		try {
			expect(readResearchAssistRows(dir)).toEqual([]);
			const row = { ts: "2026-09-11T00:00:00.000Z", phaseId: "phase-01", attempt: 1, trigger: "RED" as const, triggerDetail: "d", question: "q", enrichedByNeedsResearch: false, outcome: "distilled" as const, outcomeSummary: "s", noUsefulSignal: false, durationMs: 5, mcpAudit: RESEARCH_ASSIST_MCP_AUDIT_NOTE };
			appendResearchAssistRow(dir, row);
			appendResearchAssistRow(dir, { ...row, attempt: 2 });
			expect(readResearchAssistRows(dir).map((r) => r.attempt)).toEqual([1, 2]);
			expect(readResearchAssistRows(join(dir, "nonexistent"))).toEqual([]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("the basename is registered in HARNESS_FILE_ROLES with ALL FOUR roles (the NOVEL combo — pinned in harness-path-registry.test.ts goldens too)", async () => {
		const { HARNESS_FILE_ROLES } = await import("../src/harness-paths.ts");
		expect(HARNESS_FILE_ROLES[RESEARCH_ASSIST_BASENAME]).toEqual({
			redBoundarySpecScoped: true,
			trackerAdvisoryNoise: true,
			specDirBookkeeping: true,
			phaseCommitExcluded: true,
		});
		// phase-commit exclusion: the deterministic committer derives its set from
		// the same registry role (implementation.ts PHASE_COMMIT_EXCLUDED_BASENAMES).
		const implSrc = readFileSync("src/stages/implementation.ts", "utf8");
		expect(implSrc).toContain('harnessBasenames("phaseCommitExcluded")');
	});
});

// ─── stage-level wiring (the attempt loop) ──────────────────────────────────

/** A genuine IN-SCOPE gate failure → classifyGateFault says `product-defect`
 *  (the implementation-bounds prodFail fixture). */
const prodFail = (n: number) => ({
	pass: false, buildSuccess: false, allTestsPass: false, typecheckSuccess: false, inScopePass: false,
	errors: [`assist product failure #${n}: error kind ${n}`], outOfScopeErrors: [] as string[], ran: ["npm test"],
});

interface StageCtxOpts {
	/** Scripted implementer controls, consumed in order (last repeats). */
	implResults?: Array<{ text?: string; control: ControlObj }>;
	/** Research-assist agent results, consumed in order (last repeats). */
	researchResults?: Array<{ control: ControlObj | null; error?: string }>;
}

function mkStageState(specDir: string): PipelineState {
	return {
		setup: { worktreePath: join(specDir, "wt"), specDirectory: specDir, defaultBranch: "main", language: "frontend", isWebUi: false, specIdentifier: "assist", worktreeCreated: false, initializedRepo: false },
		classify: { taskType: "feature", uiScope: "none", language: "frontend", isWebUi: false },
		spec: { phases: [{ name: "Phase A" }] },
	} as unknown as PipelineState;
}

/** Stage harness: routes agents like the bounds fixture, plus research-agent
 *  capture. Returns every agent call in ORDER (so dispatch-before-attempt is
 *  assertable by index). */
function mkStageCtx(opts: StageCtxOpts = {}): { ctx: StageContext; implCalls: AgentCall[]; researchCalls: AgentCall[]; allCalls: Array<{ agent: string; id: string }>; logs: string[] } {
	const implCalls: AgentCall[] = [];
	const researchCalls: AgentCall[] = [];
	const allCalls: Array<{ agent: string; id: string }> = [];
	const logs: string[] = [];
	const implQueue = [...(opts.implResults ?? [])];
	const researchQueue = [...(opts.researchResults ?? [{ control: { ...VALID_ASSIST_CONTROL } }])];
	const ctx: StageContext = {
		task: "assist", options: {} as RunOptions, state: {} as PipelineState,
		async helper(): Promise<HelperResult> { return { value: { languageInstructions: "" } as ControlObj, digest: "" }; },
		async agent(call): Promise<AgentResult> {
			allCalls.push({ agent: call.agent, id: call.id });
			if (call.agent === "implementer") {
				implCalls.push(call);
				const scripted = implQueue.length > 0 ? implQueue.shift()! : { control: {} };
				return { text: scripted.text ?? "", control: scripted.control };
			}
			if (call.agent === "research-agent") {
				researchCalls.push(call);
				const scripted = researchQueue.length > 0 ? researchQueue.shift()! : { control: null };
				return { text: "", control: scripted.control, ...(scripted.error ? { error: scripted.error } : {}) };
			}
			return { text: "", control: {} };
		},
		parallel: async (cs: Array<() => Promise<AgentResult>>) => Promise.all(cs.map((c) => c())),
		budget: { check: () => true, spent: () => true, count: 0 },
		log: (message: string) => { logs.push(message); }, phase: () => {}, events: { on: () => () => {}, emit: () => {} } as never, results: [],
	};
	return { ctx, implCalls, researchCalls, allCalls, logs };
}

/** Fresh footprints per attempt + a needsResearch entry every attempt. */
const stuckImpls = (count: number) => Array.from({ length: count }, (_, i) => ({
	control: { filesModified: [`src/assist-impl-${i + 1}.ts`], needsResearch: [{ question: `does lib X v${i + 2} need async init?`, why: "uninitialized handle on first use" }] },
}));

describe("stage wiring — GREEN side trigger (faultClassStreak ≥ 2)", () => {
	let specDir = "";
	beforeEach(() => {
		specDir = mkdtempSync(join(tmpdir(), "sd-assist-green-"));
		gateQ = [];
		deliverableQ = [];
		redStatusScripted = "unknown";
	});
	afterEach(() => {
		rmSync(specDir, { recursive: true, force: true });
		for (const k of ["SUPER_DEV_FAULT_RECURRENCE", "SUPER_DEV_MAX_PHASE_ATTEMPTS", "SUPER_DEV_MAX_RED_RETRIES"]) delete process.env[k];
	});

	it("streak ≥2 dispatches the assist BEFORE the next implementer attempt, which CARRIES the block; the assist consumes no attempt; the ledger row records GREEN + enrichment", async () => {
		gateQ = [prodFail(1), prodFail(2), prodFail(3)] as Array<Record<string, unknown>>;
		const { ctx, implCalls, researchCalls, allCalls, logs } = mkStageCtx({ implResults: stuckImpls(3) });
		await implementationStage.run(mkStageState(specDir), ctx);

		expect(implCalls).toHaveLength(3); // attempts 1..3 — the assist did NOT consume an attempt
		expect(researchCalls).toHaveLength(1); // exactly ONE assist (per-phase cap)
		const research = researchCalls[0]!;
		expect(research.timeoutMs).toBe(240_000);
		expect(research.agent).toBe("research-agent");
		expect(research.accessMode).toBe("source-read-only");
		// dispatch ordering: AFTER implementer attempt 2, BEFORE attempt 3 (report-always-accompanies-execution)
		const idxImpl2 = allCalls.findIndex((c) => c.agent === "implementer" && c.id.includes(".a2"));
		const idxImpl3 = allCalls.findIndex((c) => c.agent === "implementer" && c.id.includes(".a3"));
		const idxResearch = allCalls.findIndex((c) => c.agent === "research-agent");
		expect(idxImpl2).toBeGreaterThan(-1);
		expect(idxImpl3).toBeGreaterThan(idxImpl2);
		expect(idxResearch).toBeGreaterThan(idxImpl2);
		expect(idxResearch).toBeLessThan(idxImpl3);
		// the block rides the EXISTING corrective-prompt channel (implParts → prompt)
		expect(implCalls[2]!.prompt).toContain("## Research assist (engine-mediated — dispatched before this attempt)");
		expect(implCalls[2]!.prompt).toContain("lib X v2 requires async init");
		expect(implCalls[0]!.prompt).not.toContain("## Research assist"); // attempt 1: gate cold
		expect(implCalls[1]!.prompt).not.toContain("## Research assist"); // attempt 2: streak was still 1 when it started
		// the enriched question reached the research call
		expect(research.prompt).toContain("the implementer specifically asks:");
		// ledger row
		const rows = readResearchAssistRows(specDir);
		expect(rows).toHaveLength(1);
		expect(rows[0]!.trigger).toBe("GREEN");
		expect(rows[0]!.triggerDetail).toContain("product-defect × 2");
		expect(rows[0]!.enrichedByNeedsResearch).toBe(true);
		expect(rows[0]!.outcome).toBe("distilled");
		expect(logs.some((l) => l.includes("research-assist ARMED (GREEN: fault-class product-defect × 2)"))).toBe(true);
	});

	it("NEITHER side below threshold: needsResearch present + gate cold → NO dispatch (entries archived only) — the field never dispatches by itself", async () => {
		gateQ = [prodFail(1), { ...PASS_GATE }] as Array<Record<string, unknown>>; // attempt 1 fails, attempt 2 green — streak never ≥2
		const { ctx, implCalls, researchCalls, logs } = mkStageCtx({ implResults: stuckImpls(2) });
		const out = (await implementationStage.run(mkStageState(specDir), ctx)) as unknown as { allGreen: boolean };
		expect(out.allGreen).toBe(true);
		expect(researchCalls).toHaveLength(0); // archived, never dispatched
		expect(readResearchAssistRows(specDir)).toHaveLength(0);
		expect(logs.some((l) => l.includes("needsResearch: 1 entr(ies) archived"))).toBe(true);
		expect(implCalls.every((c) => !c.prompt.includes("## Research assist"))).toBe(true);
	});

	it("per-phase cap 1 (P8): a second trigger in the same phase proceeds WITHOUT assist, logged honestly", async () => {
		process.env.SUPER_DEV_FAULT_RECURRENCE = "6"; // keep the no-progress valve open past the cap window
		gateQ = [prodFail(1), prodFail(2), prodFail(3), prodFail(4)] as Array<Record<string, unknown>>;
		const { ctx, researchCalls, logs } = mkStageCtx({ implResults: stuckImpls(4) });
		await implementationStage.run(mkStageState(specDir), ctx);
		expect(researchCalls).toHaveLength(1); // streak 2 dispatched at attempt 3; streak 3 and 4 → cap spent
		expect(logs.filter((l) => l.includes("per-phase assist cap already spent")).length).toBeGreaterThanOrEqual(1);
		expect(readResearchAssistRows(specDir)).toHaveLength(1);
	});
});

describe("stage wiring — RED side trigger (terminalRedTries ≥ 2, §D re-entry dispatch)", () => {
	let specDir = "";
	beforeEach(() => {
		specDir = mkdtempSync(join(tmpdir(), "sd-assist-red-"));
		gateQ = [];
		deliverableQ = [];
		redStatusScripted = "unknown";
	});
	afterEach(() => {
		rmSync(specDir, { recursive: true, force: true });
		for (const k of ["SUPER_DEV_FAULT_RECURRENCE", "SUPER_DEV_MAX_PHASE_ATTEMPTS", "SUPER_DEV_MAX_RED_RETRIES"]) delete process.env[k];
	});

	it("entry 1 arms (NO dispatch — the phase ends before any implementer round); the §D re-entry dispatches BEFORE its first implementer attempt, which carries the block; the cap then persists across re-entries", async () => {
		// NOTE: SUPER_DEV_MAX_RED_RETRIES is a module-load constant (default 6) —
		// the RED sub-loop burns its tries and breaks terminally either way; the
		// terminal count is asserted by REGEX, never an exact number.
		redStatusScripted = "green"; // raw red-check PASSES every try = weak RED → green-weak-test re-prompt retries → terminal redFailures block (the arm site)

		// ── entry 1: terminal RED failure (≥2 tries) → ARM, no dispatch ──
		const state = mkStageState(specDir);
		const r1 = mkStageCtx();
		const out1 = (await implementationStage.run(state, r1.ctx)) as unknown as Record<string, unknown>;
		expect(r1.researchCalls).toHaveLength(0); // never dispatched at the terminal boundary (no report-only)
		expect(r1.logs.some((l) => /research-assist ARMED \(RED: \d+ terminal RED trie\(s\)\)/.test(l))).toBe(true);
		(state as unknown as Record<string, unknown>).implementation = out1;

		// ── entry 2 (§D re-entry): RED accepts, the armed assist dispatches before attempt 1 ──
		process.env.SUPER_DEV_MAX_PHASE_ATTEMPTS = "1";
		redStatusScripted = "unknown"; // RED accepts (unverified, non-fail-closed — the fixture convention)
		gateQ = [prodFail(1)] as Array<Record<string, unknown>>; // the attempt fails → phase partial again
		const r2 = mkStageCtx({ implResults: [{ control: { filesModified: ["src/a.ts"], needsResearch: [] } }] });
		const out2 = (await implementationStage.run(state, r2.ctx)) as unknown as Record<string, unknown>;
		expect(r2.researchCalls).toHaveLength(1);
		const research = r2.researchCalls[0]!;
		expect(research.timeoutMs).toBe(240_000);
		expect(research.prompt).toMatch(/RED generation stuck — \d+ terminal RED trie\(s\) in a prior pass/);
		// dispatch BEFORE the re-entry's first implementer attempt
		const idxImpl1 = r2.allCalls.findIndex((c) => c.agent === "implementer");
		const idxResearch = r2.allCalls.findIndex((c) => c.agent === "research-agent");
		expect(idxImpl1).toBeGreaterThan(-1);
		expect(idxResearch).toBeLessThan(idxImpl1);
		expect(r2.implCalls[0]!.prompt).toContain("## Research assist");
		const rows = readResearchAssistRows(specDir);
		expect(rows).toHaveLength(1);
		expect(rows[0]!.trigger).toBe("RED");
		expect(rows[0]!.attempt).toBe(1);

		// ── entry 3: terminal RED failure AGAIN → trigger trips but the cap is
		//    spent (persisted per phase via the control) → honest log, NO dispatch ──
		(state as unknown as Record<string, unknown>).implementation = out2;
		delete process.env.SUPER_DEV_MAX_PHASE_ATTEMPTS;
		redStatusScripted = "green";
		const r3 = mkStageCtx();
		await implementationStage.run(state, r3.ctx);
		expect(r3.researchCalls).toHaveLength(0);
		expect(r3.logs.some((l) => l.includes("per-phase assist cap already spent"))).toBe(true);
		expect(readResearchAssistRows(specDir)).toHaveLength(1); // still exactly one row — no second assist ever dispatched
	});
});

describe("stage wiring — assist failure inside the loop (P5)", () => {
	let specDir = "";
	beforeEach(() => {
		specDir = mkdtempSync(join(tmpdir(), "sd-assist-fail-"));
		gateQ = [];
		deliverableQ = [];
		redStatusScripted = "unknown";
	});
	afterEach(() => {
		rmSync(specDir, { recursive: true, force: true });
		for (const k of ["SUPER_DEV_FAULT_RECURRENCE", "SUPER_DEV_MAX_PHASE_ATTEMPTS", "SUPER_DEV_MAX_RED_RETRIES"]) delete process.env[k];
	});

	it("a timed-out assist degrades to a noUsefulSignal ledger row: the attempt still runs carrying the honest note, ctx.results stays clean (fuse untouched), no abort", async () => {
		gateQ = [prodFail(1), prodFail(2), prodFail(3)] as Array<Record<string, unknown>>;
		const { ctx, implCalls, researchCalls, logs } = mkStageCtx({
			implResults: stuckImpls(3),
			researchResults: [{ control: null, error: "agent timed out after 240000ms (delegation)" }],
		});
		const out = (await implementationStage.run(mkStageState(specDir), ctx)) as unknown as { allGreen: boolean };
		expect(researchCalls).toHaveLength(1);
		expect(implCalls).toHaveLength(3); // attempt 3 ran — the failure consumed no attempt
		expect(implCalls[2]!.prompt).toContain("## Research assist");
		expect(implCalls[2]!.prompt).toContain("FAILED"); // the honest failure note accompanied the attempt
		const rows = readResearchAssistRows(specDir);
		expect(rows).toHaveLength(1);
		expect(rows[0]!.outcome).toBe("failed");
		expect(rows[0]!.noUsefulSignal).toBe(true);
		expect(rows[0]!.outcomeSummary).toContain("timed out after 240000ms");
		expect(logs.some((l) => l.includes("research-assist complete (before attempt 3): outcome=failed"))).toBe(true);
		expect(out.allGreen).toBe(false); // partial — the phase loop proceeded normally, no abort
	});
});

// ─── constants sanity (zero magic numbers hidden in the loop) ───────────────

describe("trigger constants (decision 9 — named, not magic)", () => {
	it("RED ≥2 terminal tries, GREEN ≥2 streak, 240s cap, archive cap 8, role key is config-only", () => {
		expect(RESEARCH_ASSIST_RED_TRIGGER_TRIES).toBe(2);
		expect(RESEARCH_ASSIST_GREEN_TRIGGER_STREAK).toBe(2);
		expect(RESEARCH_ASSIST_TIMEOUT_MS).toBe(240_000);
		expect(RESEARCH_ASSIST_ARCHIVE_CAP).toBe(8);
		expect(RESEARCH_ASSIST_ROLE_KEY).toBe("research-assist");
	});
});
