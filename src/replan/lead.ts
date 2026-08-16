/**
 * R2 (dsh-09 v3 Phase R): the replan-lead classifier — the strong-model LLM
 * layer behind the deterministic rules (D2). Rare by design (0-2 calls per
 * run): it sees only the residue the deterministic rules cannot route, and its
 * ONE decision determines the direction of the whole replan back edge.
 *
 * Discipline mirrors the judge (judge.ts):
 *   - closed owner set (REPLAN_OWNER_STAGES + "human"); anything else → human;
 *   - confidence floor 0.6; below → human (never a guessed route);
 *   - evidence = 1-3 {file, quote} items whose quote (8-200 chars) must
 *     byte-occur in the finding text blob supplied to the model (classification
 *     quotes the input, not the worktree — the worktree may legitimately lack
 *     the artifact the finding says is MISSING); unverified → human;
 *   - any agent failure degrades to {owner:"human"} — the lead must never
 *     become a new deadlock source;
 *   - kill switch SUPER_DEV_DISABLE_REPLAN_LEAD=1.
 *
 * Inert until R3 wires it into the replan decision path.
 */

import { buildReplanOwnerPrompt } from "../prompts.ts";
import { REPLAN_OWNER_STAGES, type ReplanOwnerDecision, type ReplanOwnerStage } from "./owners.ts";
import type { StageContext } from "../types.ts";

export const REPLAN_LEAD_CONTROL_KEYS = ["owner", "confidence", "reason", "evidence"] as const;

const MIN_CONFIDENCE = 0.6;
const LEAD_TIMEOUT_MS = 120_000;
const REASON_MAX_CHARS = 400;
const QUOTE_MIN = 8;
const QUOTE_MAX = 200;
const MAX_EVIDENCE_ITEMS = 3;

export interface LeadEvidence {
	file: string;
	quote: string;
}

export interface LeadClassifyArgs {
	/** The residue finding (already failed deterministic classification). */
	finding: Record<string, unknown>;
	/** Optional extra context rendered into the prompt (run id, stage, verdict). */
	context?: string;
}

function text(v: unknown): string {
	if (v == null) return "";
	if (typeof v === "object") return JSON.stringify(v);
	return String(v).replace(/\s+/g, " ").trim();
}

/** The text blob quotes are verified against: everything the model was shown. */
export function findingTextBlob(finding: Record<string, unknown>, context?: string): string {
	return [
		text(finding.id), text(finding.title), text(finding.detail),
		text(finding.file), text(finding.ownerStage), text(finding.recommendation),
		Array.isArray(finding.evidence) ? finding.evidence.map(text).join("\n") : "",
		context ?? "",
	].join("\n");
}

const human = (source: "replan-lead" | "residue", reason: string): ReplanOwnerDecision =>
	({ owner: "human", routable: false, source, reason });

/** Pure validation of a lead control object; exported for unit tests. */
export function parseLeadControl(control: Record<string, unknown> | null): { owner: ReplanOwnerStage | "human"; confidence: number; reason: string; evidence: LeadEvidence[] } | null {
	if (!control) return null;
	const ownerRaw = text(control.owner).toLowerCase();
	if (ownerRaw !== "human" && !(REPLAN_OWNER_STAGES as readonly string[]).includes(ownerRaw)) return null;
	const confidenceNum = Number(control.confidence);
	const confidence = Number.isFinite(confidenceNum) ? Math.min(1, Math.max(0, confidenceNum)) : 0;
	const reason = text(control.reason).slice(0, REASON_MAX_CHARS);
	const evidence: LeadEvidence[] = (Array.isArray(control.evidence) ? control.evidence : [])
		.slice(0, MAX_EVIDENCE_ITEMS)
		.map((e) => {
			const o = (e ?? {}) as Record<string, unknown>;
			return { file: text(o.file), quote: String(o.quote ?? "") };
		})
		.filter((e) => e.file || e.quote);
	return { owner: ownerRaw as ReplanOwnerStage | "human", confidence, reason, evidence };
}

/** Verify each evidence quote byte-occurs in the supplied finding text. */
export function verifyLeadEvidence(evidence: LeadEvidence[], blob: string): string[] {
	const failures: string[] = [];
	if (evidence.length < 1) failures.push("at least 1 evidence item is required");
	for (const [i, ev] of evidence.entries()) {
		if (!ev.file) { failures.push(`evidence[${i}]: empty file`); continue; }
		if (ev.quote.length < QUOTE_MIN || ev.quote.length > QUOTE_MAX) {
			failures.push(`evidence[${i}]: quote length ${ev.quote.length} outside ${QUOTE_MIN}-${QUOTE_MAX}`);
			continue;
		}
		if (!blob.includes(ev.quote)) failures.push(`evidence[${i}]: quote not found in the finding text`);
	}
	return failures;
}

/**
 * Deterministic-first owner classification with the replan-lead fallback.
 * NEVER throws. The deterministic layer runs first (owners.ts); only its null
 * residue reaches the agent.
 */
export async function classifyReplanOwner(ctx: StageContext, args: LeadClassifyArgs): Promise<ReplanOwnerDecision> {
	if (process.env.SUPER_DEV_DISABLE_REPLAN_LEAD === "1") {
		return human("residue", "replan-lead disabled (SUPER_DEV_DISABLE_REPLAN_LEAD)");
	}
	try {
		const r = await ctx.agent({
			id: "pipeline.replan.lead",
			agent: "replan-lead",
			accessMode: "source-read-only",
			controlKeys: [...REPLAN_LEAD_CONTROL_KEYS],
			allowEmptyArraysFor: ["evidence"],
			timeoutMs: LEAD_TIMEOUT_MS,
			prompt: buildReplanOwnerPrompt(args.finding, args.context),
		});
		const parsed = r.error ? null : parseLeadControl(r.control as Record<string, unknown> | null);
		if (!parsed) return human("replan-lead", r.error ? `lead agent failed: ${r.error}` : "lead produced no valid control — degrading to human");
		if (parsed.owner === "human") {
			return { owner: "human", routable: false, source: "replan-lead", reason: parsed.reason || "lead routed to human", confidence: parsed.confidence };
		}
		if (parsed.confidence < MIN_CONFIDENCE) {
			return { owner: "human", routable: false, source: "replan-lead", reason: `lead confidence ${parsed.confidence} below ${MIN_CONFIDENCE} — degrading to human`, confidence: parsed.confidence };
		}
		const blob = findingTextBlob(args.finding, args.context);
		const failures = verifyLeadEvidence(parsed.evidence, blob);
		if (failures.length > 0) {
			return { owner: "human", routable: false, source: "replan-lead", reason: `lead evidence failed verification (${failures[0]}) — degrading to human`, confidence: parsed.confidence };
		}
		return { owner: parsed.owner, routable: true, source: "replan-lead", reason: parsed.reason || "lead classification", confidence: parsed.confidence };
	} catch (err) {
		return human("replan-lead", `lead classifier threw (${err instanceof Error ? err.message : String(err)}) — degrading to human`);
	}
}
