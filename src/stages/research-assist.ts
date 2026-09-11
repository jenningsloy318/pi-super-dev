/**
 * v0.3.87 S4(b)+(d) (§9 S4, §10 decision 9, §13 "research-assist" row, §14
 * ADR 6 of docs/requirements/run-2026-09-09-poisoned-baseline-postmortem-
 * v0.3.85.md): the engine-mediated research assist — pure helpers, the
 * output-contract schema, and the append-only ledger.
 *
 * Design (decision 9, all decided 2026-09-10):
 *  - Hybrid engine trigger, implementer corrective rounds ONLY (tdd-guide gets
 *    no assist — ADR 6, implementer-only v1). RED side: `terminalRedTries ≥ 2`
 *    (the existing counter, second RED retry onward). GREEN side: F3's
 *    consecutive-same-FaultClass streak `≥ 2`. Per-phase assist cap 1 (P8): a
 *    second trigger in the same phase proceeds WITHOUT assist, logged honestly.
 *  - The implementer's optional `needsResearch: [{question, why}]` control
 *    field NEVER dispatches by itself — entries are archived (in-memory per
 *    phase) and ENRICH the dispatched question once the engine gate trips.
 *  - Synchronous dispatch BEFORE the next attempt (report-always-accompanies-
 *    execution, never report-only): the stage calls research-agent directly —
 *    REUSED agent, no new agent file (§13: "research-assist" is a CONFIG ROLE
 *    KEY ONLY) — 240s per-call cap, per-call toolBudget from the Group 1
 *    resolution chain (agentToolBudget["research-assist"] ??
 *    agentToolBudget["research-agent"] ?? commonToolBudget ?? none; zero
 *    hardcoded budget numbers in code).
 *  - Failure semantics (P5, checker-class): a failed or timed-out assist
 *    degrades to a `noUsefulSignal` ledger row with the failure reason — it
 *    never touches the v0.3.65 agent-error fuse, never consumes an attempt,
 *    never aborts.
 *  - MCP audit (item d): every assist ledger row records that external
 *    MCP-capable tools were exposed (residual risk: MCP side effects sit
 *    outside the source boundary's worktree view) — one row per assist, no
 *    over-engineering.
 *
 * S1 pairing decision: `ResearchAssistData` stays an INTERNAL non-ControlData
 * schema (NOT exported from render/schemas.ts), so the S1 exhaustiveness guard
 * in tests/control-contract-shapes.test.ts is not triggered; the schema↔consumer
 * pair is pinned by tests/research-assist.test.ts instead (schema-generated
 * minimal instance through the real distiller, the S1 discipline applied at
 * this module's scope).
 *
 * Dependency-light and never-throwing — the same contract class as
 * inherited-red.ts. The stage (implementation.ts) owns the control flow;
 * everything here is pure, a ledger primitive, or the one dispatch wrapper.
 */

import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { Type } from "typebox";
import { resolveToolBudget } from "../agents/agent-runtime.ts";
import type { StageContext } from "../types.ts";

// ── constants (§13: research-assist is a config role key ONLY) ───────────────

/** The config role key the assist dispatch resolves its tool budget under
 *  (resolveToolBudget falls back to `research-agent`, then common, then none).
 *  NO agent file carries this name — the dispatch reuses research-agent. */
export const RESEARCH_ASSIST_ROLE_KEY = "research-assist";

/** Per-call wall-clock cap for one assist dispatch (decision 9: scoped single
 *  question, 240s). A named constant — NOT an env key (a parallel dead key is
 *  exactly the C2 disease); the per-call timeoutMs override is the existing
 *  delegation param seam (AgentCall.timeoutMs → common → request.timeoutMs). */
export const RESEARCH_ASSIST_TIMEOUT_MS = 240_000;

/** GREEN side: the consecutive-same-FaultClass streak that trips the assist
 *  gate (decision 9: "2nd consecutive same-class failure within a phase"). */
export const RESEARCH_ASSIST_GREEN_TRIGGER_STREAK = 2;

/** RED side: terminalRedTries at which the assist gate trips (decision 9:
 *  "second RED retry onward" — the existing counter, ≥2 tries at the terminal
 *  RED-generation failure). */
export const RESEARCH_ASSIST_RED_TRIGGER_TRIES = 2;

/** Bound on the in-memory per-phase needsResearch archive (P8: every channel
 *  that accumulates agent output is bounded). Oldest entries drop first. */
export const RESEARCH_ASSIST_ARCHIVE_CAP = 8;

/** HARD cap on the rendered corrective-channel block (~2KB — decision 9). */
export const RESEARCH_ASSIST_BLOCK_CAP = 2_048;

/** Distillation caps: findings ≤5, recommendation ≤10 lines (decision 9).
 *  The wire schema stays permissive (an overrun is truncated honestly
 *  engine-side, never a schema violation that burns a corrective round). */
export const RESEARCH_ASSIST_MAX_FINDINGS = 5;
export const RESEARCH_ASSIST_MAX_RECOMMENDATION_LINES = 10;

/** Item (d): the per-assist MCP audit note. Static by design — research-agent
 *  loads the web/MCP extension tools on every dispatch, so every assist
 *  exposed external MCP-capable tools; actual per-tool accounting would be the
 *  over-engineering item (d) forbids. */
export const RESEARCH_ASSIST_MCP_AUDIT_NOTE = "external MCP-capable tools were exposed to the research-agent during this assist (web/MCP extensions ride the sd-research-agent registration); residual risk: MCP side effects sit outside the source boundary's worktree view";

// ── the implementer's needsResearch control field ───────────────────────────

/** One archived implementer research request. BOTH fields are mandatory
 *  whenever the array is non-empty (decision 9: an empty `why` is a wish-list
 *  entry, rejected at validation — parseNeedsResearch drops it). */
export interface NeedsResearchEntry {
	question: string;
	why: string;
}

/** Parse the implementer's optional `needsResearch` control field. Defensive
 *  parse of untrusted agent control (the parseTestDefects contract): accepts
 *  only objects with non-empty question AND why — an entry missing either is
 *  DISCARDED (rejected at validation) and named in one honest log line.
 *  Bounded to 6 entries per emit. Never throws. */
export function parseNeedsResearch(control: unknown, log?: (m: string) => void): NeedsResearchEntry[] {
	if (control == null || typeof control !== "object" || Array.isArray(control)) return [];
	const raw = (control as Record<string, unknown>).needsResearch;
	if (!Array.isArray(raw)) return [];
	const out: NeedsResearchEntry[] = [];
	let dropped = 0;
	for (const entry of raw) {
		if (entry == null || typeof entry !== "object" || Array.isArray(entry)) { dropped++; continue; }
		const e = entry as Record<string, unknown>;
		const question = typeof e.question === "string" ? e.question.trim() : "";
		const why = typeof e.why === "string" ? e.why.trim() : "";
		if (!question || !why) { dropped++; continue; }
		out.push({ question, why });
	}
	if (dropped > 0) log?.(`needsResearch: discarded ${dropped} entr(ies) — every entry requires BOTH a non-empty question and a non-empty why (an empty why is a wish-list entry, rejected at validation)`);
	if (out.length > 6) {
		log?.(`needsResearch: bounded to 6 entries (${out.length} emitted) — the trailing entries beyond the bound are discarded`);
		return out.slice(0, 6);
	}
	return out;
}

// ── the research call's OUTPUT contract (internal, non-ControlData) ─────────

/** The distilled assist result the research call returns against (decision 9:
 *  `findings[≤5]{claim, source, applies}`, `recommendation` ≤10 lines,
 *  `noUsefulSignal` honest-empty). The schema itself is deliberately
 *  permissive about counts — the ENGINE-side distillation enforces the caps
 *  and truncates honestly with a marker (a schema-violating overrun would burn
 *  a corrective round for no benefit). */
export const ResearchAssistData = Type.Object({
	findings: Type.Array(Type.Object({
		claim: Type.String({ description: "one-sentence research claim" }),
		source: Type.String({ description: "the URL or tool+query that produced the claim" }),
		applies: Type.String({ description: "how the claim applies to this phase's failure" }),
	})),
	recommendation: Type.String({ description: "the concrete next implementation step (≤10 lines)" }),
	noUsefulSignal: Type.Boolean({ description: "true when the research found nothing useful — never fabricate findings" }),
});

/** The engine-side distilled form (caps enforced). */
export interface DistilledResearchAssist {
	findings: Array<{ claim: string; source: string; applies: string }>;
	recommendation: string;
	noUsefulSignal: boolean;
	/** Findings dropped by the ≤5 cap (rendered as an honest marker). */
	findingsDropped?: number;
	/** Set on the degrade paths (failed/timed-out/unusable call) — the block
	 *  renders an honest note naming it; never fabricated findings. */
	failureReason?: string;
}

const FINDING_CLAIM_CAP = 500;
const FINDING_SOURCE_CAP = 240;
const FINDING_APPLIES_CAP = 400;
const TRUNCATION_MARKER = "…[truncated]";

function capString(value: string, cap: number): string {
	if (value.length <= cap) return value;
	return `${value.slice(0, cap - TRUNCATION_MARKER.length)}${TRUNCATION_MARKER}`;
}

/** Distill the research call's control into the capped assist form. Pure,
 *  defensive, never throws. Caps (engine-enforced, honest markers):
 *  findings ≤5, recommendation ≤10 lines, per-field length bounds. An
 *  unusable shape → null (the wrapper degrades to noUsefulSignal); a
 *  completed call that yielded nothing → `noUsefulSignal: true` (honest-empty,
 *  never fabricated findings). */
export function distillResearchAssistControl(control: unknown): DistilledResearchAssist | null {
	if (control == null || typeof control !== "object" || Array.isArray(control)) return null;
	const c = control as Record<string, unknown>;
	if (!Array.isArray(c.findings) || typeof c.recommendation !== "string" || typeof c.noUsefulSignal !== "boolean") return null;
	const rawFindings = c.findings
		.filter((f): f is Record<string, unknown> => f != null && typeof f === "object" && !Array.isArray(f));
	const findings: DistilledResearchAssist["findings"] = [];
	for (const f of rawFindings.slice(0, RESEARCH_ASSIST_MAX_FINDINGS)) {
		const claim = capString(String(f.claim ?? "").trim(), FINDING_CLAIM_CAP);
		const source = capString(String(f.source ?? "").trim(), FINDING_SOURCE_CAP);
		const applies = capString(String(f.applies ?? "").trim(), FINDING_APPLIES_CAP);
		if (!claim && !source && !applies) continue;
		findings.push({ claim, source, applies });
	}
	const findingsDropped = Math.max(0, c.findings.length - RESEARCH_ASSIST_MAX_FINDINGS);
	const lines = c.recommendation.split("\n");
	const recommendation = lines.length > RESEARCH_ASSIST_MAX_RECOMMENDATION_LINES
		? `${lines.slice(0, RESEARCH_ASSIST_MAX_RECOMMENDATION_LINES).join("\n")}\n${TRUNCATION_MARKER} (recommendation capped at ${RESEARCH_ASSIST_MAX_RECOMMENDATION_LINES} lines)`
		: c.recommendation;
	const noUsefulSignal = c.noUsefulSignal === true || (findings.length === 0 && recommendation.trim() === "");
	return {
		findings,
		recommendation: recommendation.trim(),
		noUsefulSignal,
		...(findingsDropped > 0 ? { findingsDropped } : {}),
	};
}

/** Render the distilled assist into the corrective-prompt block channel.
 *  HARD CAP ~2KB (RESEARCH_ASSIST_BLOCK_CAP) with an honest truncation
 *  marker. `noUsefulSignal: true` renders the honest-empty note (decision 9:
 *  the note still accompanies the attempt — the dispatch is never
 *  report-only); a failure reason renders an honest failure note. Always
 *  returns a non-empty block. */
export function renderResearchAssistBlock(data: DistilledResearchAssist): string {
	const header = "## Research assist (engine-mediated — dispatched before this attempt)";
	let body: string;
	if (data.failureReason) {
		body = `The research assist FAILED and produced no findings — honest note, not a signal: ${data.failureReason}. Proceed on the deterministic failure evidence above.`;
	} else if (data.noUsefulSignal) {
		body = "research found no useful signal for this failure — no research-backed guidance applies. Proceed on the deterministic failure evidence above.";
	} else {
		const parts: string[] = [];
		parts.push("Findings:");
		for (const f of data.findings) {
			parts.push(`- ${f.claim}${f.source ? ` [source: ${f.source}]` : ""}${f.applies ? ` — applies: ${f.applies}` : ""}`);
		}
		if (data.findingsDropped !== undefined && data.findingsDropped > 0) {
			parts.push(`${TRUNCATION_MARKER} (+${data.findingsDropped} finding(s) dropped by the ≤${RESEARCH_ASSIST_MAX_FINDINGS} cap)`);
		}
		if (data.recommendation) parts.push(`Recommendation:\n${data.recommendation}`);
		body = parts.join("\n");
	}
	const note = `One scoped research lookup was dispatched for this retry (trigger + question recorded in research-assists.jsonl). ${RESEARCH_ASSIST_MCP_AUDIT_NOTE}`;
	// v0.3.87 fix round: the cap trims the BODY, never the trailing audit note —
	// the MCP-audit line must ride EVERY block (item d), even when findings fill
	// the whole budget.
	let cappedBody = body;
	if (`${header}\n${cappedBody}\n${note}`.length > RESEARCH_ASSIST_BLOCK_CAP) {
		const marker = `\n…[research assist truncated at the ${RESEARCH_ASSIST_BLOCK_CAP}-char cap — the distilled form is bounded by contract]`;
		const bodyBudget = RESEARCH_ASSIST_BLOCK_CAP - header.length - note.length - marker.length - 2;
		cappedBody = `${cappedBody.slice(0, Math.max(0, bodyBudget))}${marker}`;
	}
	return `${header}\n${cappedBody}\n${note}`;
}

// ── question composition (engine-composed when no needsResearch entries) ────

/** Compose the scoped single question for the assist dispatch. Absent archived
 *  needsResearch entries, the engine composes it from the failure context
 *  (phase, failing targets, last errors, fault class / RED failure reasons);
 *  present entries ENRICH it (appended as "the implementer specifically
 *  asks: …"). Pure. */
export function composeResearchAssistQuestion(args: {
	phaseId: string;
	phaseName: string;
	trigger: "RED" | "GREEN";
	triggerDetail: string;
	contextLines: ReadonlyArray<string>;
	failingTargets: ReadonlyArray<string>;
	needsResearch: ReadonlyArray<NeedsResearchEntry>;
}): string {
	const parts: string[] = [
		`TDD pipeline phase ${args.phaseId} ("${args.phaseName}") is stuck.`,
		`Stuck signal (${args.trigger} side): ${args.triggerDetail}`,
	];
	if (args.failingTargets.length > 0) parts.push(`Failing targets: ${args.failingTargets.slice(0, 6).join(", ")}`);
	if (args.contextLines.length > 0) {
		parts.push("Failure context (engine-recorded order):");
		for (const line of args.contextLines.slice(0, 8)) parts.push(`- ${line}`);
	}
	if (args.needsResearch.length > 0) {
		parts.push("the implementer specifically asks:");
		for (const entry of args.needsResearch.slice(0, 4)) parts.push(`- ${entry.question} (why: ${entry.why})`);
	}
	parts.push("Research ONE focused question that unblocks the next implementation attempt: the specific external knowledge gap (an unfamiliar API/dependency behavior, an error class, a documented constraint) behind the recurring failure. Do not restate the repo's own code — the implementer can read that.");
	return parts.join("\n");
}

/** The assist dispatch's task text (self-contained, mirror of the judge/tdd
 *  prompt conventions: role, scope, question, output contract). */
export function buildResearchAssistPrompt(question: string): string {
	return [
		"## Role",
		"You are the research assist for a TDD pipeline implementer that is stuck on a recurring failure. Answer ONE focused research question with web/MCP lookup tools, then return immediately.",
		"",
		"## Scope discipline",
		"- Lookup-then-return: search/read external sources as needed, then answer. Do NOT edit, write, stage, or delete anything in the repository (the call is source-read-only).",
		"- If nothing useful exists, say so via noUsefulSignal=true — NEVER fabricate findings or sources.",
		"",
		"## Question",
		question,
		"",
		"## Data to return (structured output)",
		`- findings: at most ${RESEARCH_ASSIST_MAX_FINDINGS} items, each {claim, source, applies} — claim is one sentence; source is the real URL or tool+query; applies says how it helps THIS failure`,
		`- recommendation: at most ${RESEARCH_ASSIST_MAX_RECOMMENDATION_LINES} lines — the concrete next implementation step`,
		"- noUsefulSignal: boolean — true when the research found nothing useful",
	].join("\n");
}

// ── the ledger (<specDir>/research-assists.jsonl, append-only) ──────────────

/** The ledger basename — registered in HARNESS_FILE_ROLES with ALL FOUR roles
 *  (specDirBookkeeping + redBoundarySpecScoped + trackerAdvisoryNoise +
 *  phaseCommitExcluded; the NOVEL combo the v0.3.85 fold flagged — per-attempt
 *  scratch must never ride phase commits). */
export const RESEARCH_ASSIST_BASENAME = "research-assists.jsonl";

export type ResearchAssistTriggerSide = "RED" | "GREEN";

/** The GREEN-side armed trigger (phase-loop scope): set at the failure-recording
 *  site when faultClassStreak ≥ RESEARCH_ASSIST_GREEN_TRIGGER_STREAK; consumed
 *  at the NEXT attempt's corrective-prompt assembly. Carries the streak detail
 *  and the triggering attempt's failure reasons (the question context). */
export interface ResearchAssistGreenTrigger {
	triggerDetail: string;
	contextLines: string[];
}

/** The RED-side armed trigger (persisted per phase via the control across §D
 *  iterations): a terminal RED-generation failure with ≥ RED_TRIGGER_TRIES
 *  tries arms the assist for the phase's NEXT implementer round (the §D
 *  re-entry). Carries the try count, the terminal failure reasons, and the RED
 *  targets at failure (the question context). */
export interface ResearchAssistRedArm {
	tries: number;
	detail: string;
	testFiles: string[];
}

/** One row per assist attempt (dispatch). Append-only; never rewritten. */
export interface ResearchAssistLedgerRow {
	ts: string;
	phaseId: string;
	/** The implementer attempt the assist was dispatched before. */
	attempt: number;
	trigger: ResearchAssistTriggerSide;
	triggerDetail: string;
	question: string;
	enrichedByNeedsResearch: boolean;
	outcome: "distilled" | "no-useful-signal" | "failed";
	outcomeSummary: string;
	noUsefulSignal: boolean;
	durationMs: number;
	mcpAudit: string;
}

export function researchAssistLedgerPath(specDir: string): string {
	return join(specDir, RESEARCH_ASSIST_BASENAME);
}

/** Append ONE ledger row. Never throws: a failure degrades to a warning
 *  through `log` (the ledger is the audit channel; the assist block already
 *  accompanied the attempt — bookkeeping never blocks the loop). */
export function appendResearchAssistRow(specDir: string | undefined, row: ResearchAssistLedgerRow, log?: (m: string) => void): void {
	if (!specDir) return;
	try {
		const dir = isAbsolute(specDir) ? specDir : join(process.cwd(), specDir);
		mkdirSync(dir, { recursive: true });
		appendFileSync(researchAssistLedgerPath(dir), JSON.stringify(row) + "\n");
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		try { log?.(`research-assist ledger append failed (continuing; never fatal): ${msg}`); } catch { /* never throw */ }
	}
}

/** All ledger rows (oldest first). `[]` when absent/unreadable. Never throws. */
export function readResearchAssistRows(specDir: string | undefined): ResearchAssistLedgerRow[] {
	if (!specDir) return [];
	try {
		const dir = isAbsolute(specDir) ? specDir : join(process.cwd(), specDir);
		return readFileSync(researchAssistLedgerPath(dir), "utf8")
			.split("\n")
			.filter((line) => line.trim() !== "")
			.map((line) => JSON.parse(line) as ResearchAssistLedgerRow);
	} catch {
		return [];
	}
}

// ── the dispatch (the stage's single seam; never throws — P5) ───────────────

export interface ResearchAssistArgs {
	ctx: StageContext;
	specDirectory: string | undefined;
	phaseId: string;
	phaseName: string;
	attempt: number;
	trigger: ResearchAssistTriggerSide;
	triggerDetail: string;
	contextLines: ReadonlyArray<string>;
	failingTargets: ReadonlyArray<string>;
	needsResearch: ReadonlyArray<NeedsResearchEntry>;
	/** Test seam: config override threaded into resolveToolBudget. Production
	 *  omits it and reads ~/.super-dev/config.json (caps are opt-in policy). */
	toolBudgetConfig?: { commonToolBudget?: unknown; agentToolBudget?: unknown };
}

export interface ResearchAssistOutcome {
	/** The ≤2KB corrective-channel block — ALWAYS non-empty (a failed or
	 *  no-signal assist renders an honest note that still accompanies the
	 *  attempt; report-always-accompanies-execution). */
	block: string;
	row: ResearchAssistLedgerRow;
	/** Whether a per-call toolBudget was resolved and sent (honest logging;
	 *  false = none configured → the field is OMITTED from the dispatch). */
	toolBudgetSent: boolean;
}

/** Dispatch ONE research assist: build the scoped question, call research-
 *  agent directly (REUSED agent — §13: no agent file; 240s per-call cap via
 *  the existing timeoutMs delegation param, per-call toolBudget via the
 *  config-resolved assist budget — omit when none configured), distill the
 *  ResearchAssistData, append the ledger row, and return the corrective block.
 *  NEVER throws and never touches ctx.results (P5 checker-class: a failed or
 *  timed-out assist degrades to a noUsefulSignal row — the v0.3.65 agent-error
 *  fuse, attempt accounting, and the phase loop are all untouched). */
export async function runResearchAssist(args: ResearchAssistArgs): Promise<ResearchAssistOutcome> {
	const startedAt = Date.now();
	const question = composeResearchAssistQuestion({
		phaseId: args.phaseId,
		phaseName: args.phaseName,
		trigger: args.trigger,
		triggerDetail: args.triggerDetail,
		contextLines: args.contextLines,
		failingTargets: args.failingTargets,
		needsResearch: args.needsResearch,
	});
	const budget = resolveToolBudget(RESEARCH_ASSIST_ROLE_KEY, {
		...(args.toolBudgetConfig !== undefined ? { config: args.toolBudgetConfig } : {}),
		warn: (m) => args.ctx.log(m),
	});
	let result: Awaited<ReturnType<StageContext["agent"]>> = { text: "", control: null };
	try {
		result = await args.ctx.agent({
			id: `pipeline.implementation.${args.phaseId}.research-assist.a${args.attempt}`,
			agent: "research-agent",
			accessMode: "source-read-only",
			prompt: buildResearchAssistPrompt(question),
			controlKeys: ["findings", "recommendation", "noUsefulSignal"],
			schema: ResearchAssistData,
			timeoutMs: RESEARCH_ASSIST_TIMEOUT_MS,
			// Group 1 chain: research-assist ?? research-agent ?? common ?? none —
			// absent config sends NO toolBudget (caps strictly opt-in).
			...(budget !== undefined ? { toolBudget: budget } : {}),
		});
	} catch (err) {
		result = { text: "", control: null, error: `research assist threw: ${err instanceof Error ? err.message : String(err)}` };
	}
	let distilled: DistilledResearchAssist | null = null;
	let failureReason = "";
	if (result.error) {
		failureReason = result.error;
	} else {
		distilled = distillResearchAssistControl(result.control);
		if (distilled === null) failureReason = `research call returned no usable ResearchAssistData shape (control=${result.control == null ? "null" : typeof result.control})`;
	}
	if (failureReason) distilled = { findings: [], recommendation: "", noUsefulSignal: true, failureReason };
	const row: ResearchAssistLedgerRow = {
		ts: new Date().toISOString(),
		phaseId: args.phaseId,
		attempt: args.attempt,
		trigger: args.trigger,
		triggerDetail: args.triggerDetail,
		question: question.slice(0, 1200),
		enrichedByNeedsResearch: args.needsResearch.length > 0,
		outcome: failureReason ? (result.error ? "failed" : "no-useful-signal") : (distilled!.noUsefulSignal ? "no-useful-signal" : "distilled"),
		outcomeSummary: failureReason
			? `assist degraded (noUsefulSignal): ${failureReason.slice(0, 300)}`
			: (distilled!.noUsefulSignal
				? "research found no useful signal (honest-empty)"
				: `${distilled!.findings.length} finding(s) distilled into the corrective block`),
		noUsefulSignal: failureReason ? true : distilled!.noUsefulSignal,
		durationMs: Date.now() - startedAt,
		mcpAudit: RESEARCH_ASSIST_MCP_AUDIT_NOTE,
	};
	appendResearchAssistRow(args.specDirectory, row, (m) => args.ctx.log(m));
	return { block: renderResearchAssistBlock(distilled!), row, toolBudgetSent: budget !== undefined };
}
