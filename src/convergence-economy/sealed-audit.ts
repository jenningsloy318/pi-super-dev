/**
 * The SEALED AUDIT SUBSET (066 WS1 layer b; 067 R6-Q1 named it the missing
 * layer; round 7 grilled the design before implementation).
 *
 * Anti-gaming middle layer of the three-layer coverage gate: the writer's
 * self-filled findingResolutions map is WEAK evidence (FBI/EMNLP 2024:
 * evaluators name defects in explanations yet still pass them; CHERRL: a
 * compliance declaration fools judges). The reviewer therefore deep-verifies
 * a random SUBSET of rows — selected AFTER submission from a source the
 * writer cannot predict (the seal token), committed by the LOG LINE ITSELF
 * (the writer never sees the run log mid-flight; post-hoc anyone recomputes
 * hash(sealToken, id) and reproduces the selection — ordering in the
 * append-only log proves the selection predates the reviewer's dispatch).
 *
 * Protected set (never sampled out): unresolved blocking findings with
 * severity high/P0/P1/critical from the convergence ledger + the fixed
 * anchor-grammar core — resolved findings leave the protected set as the
 * ledger updates (it cannot balloon).
 *
 * Census below minRows; fraction per Rubric Dropout (30–50%).
 * Pure: token in, selection out; deterministic and reconstructable.
 */

import { createHash } from "node:crypto";
import type { FindingResolution } from "./finding-resolution-gate.ts";

export interface SealedAuditSelection {
	/** The rows selected for deep verification (protected ∪ sampled). */
	audited: FindingResolution[];
	/** Rows not selected (informational for the log). */
	skipped: FindingResolution[];
	/** The seal token — logged BEFORE the reviewer dispatch; the commitment. */
	sealToken: string;
	/** Deterministic ranking digest per row (auditable reconstruction). */
	digests: Record<string, string>;
}

export function mkSealToken(): string {
	return `sd-audit-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function digest(token: string, id: string): string {
	return createHash("sha256").update(`${token}\u0000${id}`).digest("hex").slice(0, 16);
}

/** The protected id set: unresolved blocking high-severity ledger findings.
 * Resolved rows leave (status verified/addressed/superseded) — the set
 * tracks open risk, so it cannot balloon across rounds. */
export function protectedAuditIds(findings: readonly { id?: unknown; blocking?: unknown; severity?: unknown; status?: unknown }[]): Set<string> {
	const out = new Set<string>();
	for (const f of findings) {
		if (!f || typeof f !== "object") continue;
		const id = typeof f.id === "string" ? f.id : "";
		const sev = typeof f.severity === "string" ? f.severity.toLowerCase() : "";
		const status = typeof f.status === "string" ? f.status : "";
		if (!id) continue;
		if (status === "verified" || status === "addressed" || status === "superseded") continue;
		if (f.blocking !== true) continue;
		if (sev === "high" || sev === "p0" || sev === "p1" || sev === "critical") out.add(id);
	}
	return out;
}

/** Deterministic, reconstructable subset selection: rank every row by
 * sha256(sealToken, id), take the top ceil(fraction·N); protected ids join
 * unconditionally; census below minRows. Never throws. */
export function selectSealedAuditSubset(input: {
	rows: readonly FindingResolution[];
	seal: string;
	protectedIds: ReadonlySet<string>;
	fraction?: number;
	minRows?: number;
}): SealedAuditSelection {
	const fraction = input.fraction ?? 0.4;
	const minRows = input.minRows ?? 3;
	const digests: Record<string, string> = {};
	const ranked = [...input.rows].map((r) => {
		const d = digest(input.seal, r.id);
		digests[r.id] = d;
		return { row: r, d };
	}).sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : 0));
	const target = Math.max(minRows, Math.ceil(ranked.length * fraction));
	const audited: FindingResolution[] = [];
	const skipped: FindingResolution[] = [];
	for (const { row } of ranked) {
		const isAudited = audited.length < target || input.protectedIds.has(row.id);
		if (isAudited || input.protectedIds.has(row.id)) audited.push(row);
		else skipped.push(row);
	}
	return { audited, skipped, sealToken: input.seal, digests };
}

/** The commitment log line — the selection IS sealed by being logged before
 * the reviewer dispatch (append-only ordering is the proof). */
export function sealedAuditLogLine(sel: SealedAuditSelection): string {
	return `sealed audit: seal=${sel.sealToken} rows=${sel.audited.length}/${sel.audited.length + sel.skipped.length} audited ids=${sel.audited.map((r) => r.id).join(",")} — selection predates the reviewer dispatch (recompute sha256(seal,id) ranking to verify; protected ids unconditional)`;
}

/** The reviewer rubric block: stable header (KV-prefix friendly) + the
 * audited rows with their claims + the per-row verdict requirement. The
 * verdicts ride the EXISTING priorFindingResolutions control field
 * (findingId + status + response + evidence — the schema already exists). */
export function sealedAuditPromptBlock(sel: SealedAuditSelection): string {
	if (sel.audited.length === 0) return "";
	const lines = sel.audited.map((r) => JSON.stringify({ findingId: r.id, claimedLoci: r.loci, claimedNote: r.note }));
	return [
		"## Sealed audit subset (deep-verify each row — a claim is NOT verified by being present)",
		"For EVERY row below: re-derive from the artifact and code whether the claimed resolution ACTUALLY resolves the finding. Emit a priorFindingResolutions entry for each: findingId, status (verified | open), response (what you found), evidence (a VERBATIM quote from the cited locus — a bare pass/fail with no quote is not an audit).",
		...lines,
	].join("\n");
}

// ── The node↔prompt seam: the selected block rides the state (set by the
// node AFTER deterministic validation passes, i.e., after submission; the
// prompt builders append it verbatim — stable header first for KV-friendry
// prefixes). Absent block ⇒ no section (stages without coverage maps are
// untouched).

const STATE_KEY = "__sealedAuditBlock";

export function setSealedAuditBlock(state: { [key: string]: unknown }, block: string): void {
	if (block) state[STATE_KEY] = block;
	else delete state[STATE_KEY];
}

export function sealedAuditBlockFrom(state: { [key: string]: unknown }): string {
	const v = state[STATE_KEY];
	return typeof v === "string" ? v : "";
}

// ── R7 research confirmation (Q2: verbatim quotes must be MACHINE-CHECKED —
// Rulers: verdicts tied to extractive evidence that is mechanically checked;
// a required-but-unchecked quote field is still rubber-stampable).

export interface AuditQuoteVerification {
	/** Audited rows whose priorFindingResolutions evidence quote appears
	 * verbatim in the rendered artifact. */
	verified: string[];
	/** Rows whose evidence quote does NOT appear (rubber-stamp signature:
	 * absent response OR quote ≠ substring of the artifact). */
	failed: string[];
	/** Audited rows the reviewer's control never answered at all. */
	unanswered: string[];
}

/** Deterministic post-review check: every audited row MUST have a
 * priorFindingResolutions entry whose evidence string occurs verbatim in
 * the artifact text. Pure (artifact text in); never throws. */
export function verifyAuditQuotes(input: {
	auditedIds: readonly string[];
	artifactText: string;
	resolutions: ReadonlyArray<{ findingId?: unknown; evidence?: unknown; response?: unknown }>;
}): AuditQuoteVerification {
	const byId = new Map<string, { evidence?: unknown; response?: unknown }>();
	for (const r of input.resolutions) {
		if (r && typeof r === "object" && typeof r.findingId === "string") byId.set(r.findingId, r);
	}
	const verified: string[] = [];
	const failed: string[] = [];
	const unanswered: string[] = [];
	for (const id of input.auditedIds) {
		const r = byId.get(id);
		if (!r) { unanswered.push(id); continue; }
		const q = typeof r.evidence === "string" ? r.evidence.trim() : "";
		if (q.length >= 8 && input.artifactText.includes(q)) verified.push(id);
		else failed.push(id);
	}
	return { verified, failed, unanswered };
}
