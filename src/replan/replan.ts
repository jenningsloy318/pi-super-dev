/**
 * R3/R4/R5 (dsh-09 v3 Phase R): the bounded cross-stage replan circuit —
 * the sad-path "team" edge on the pipeline skeleton.
 *
 * When verification dead-states on upstream-owned defects (F-C's
 * blocked-on-decisions residue), the circuit:
 *   R2 — classifies each deferred/needs-human finding (deterministic rules
 *        first, replan-lead fallback);
 *   R3 — persists routable ones to `replan-requests.json` in the spec dir and
 *        ends the run with status "replan" (a first-class terminal status);
 *        the extension auto-resumes (OQ6 default ON). On the restart, each
 *        owning convergence node injects its pending requests as
 *        convergence-ledger findings at round 1 — the EXISTING
 *        writer-revises-per-finding machinery performs the revision. Requests
 *        flip to "addressed" only when the owning loop approves after revision.
 *   R4 — dependency-graph FULL invalidation (user decision D3): bumps the
 *        per-artifact revision counter (`artifact-revisions.json`) and drops
 *        resume-cache entries for the owner + `downstreamOf(owner)` stages, so
 *        the restart re-runs exactly the invalidated suffix while upstream
 *        completed stages replay from cache (R-mech-2: restart-based back
 *        edge — deterministic replay over run boundaries).
 *   R5 — bounded: MAX_REPLAN_ROUNDS=2 per spec (env SUPER_DEV_MAX_REPLAN_ROUNDS,
 *        lazy read); beyond it the run falls through to today's honest HITL
 *        (F-C) with the replan history attached.
 *
 * Audited to `replan.jsonl` in the spec dir and the P1.1 event ledger. NEVER
 * throws — a replan failure degrades to today's blocked-on-decisions path.
 */

import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { classifyReplanOwnerDeterministic, type ReplanOwnerDecision, type ReplanOwnerStage, REPLAN_OWNER_STAGES } from "./owners.ts";
import { classifyReplanOwner } from "./lead.ts";
import { downstreamOf } from "../graph/edges.ts";
import { sendMessage, replyTo, pendingMessagesFor } from "../team/messages.ts";
import { appendRunEvent } from "../runlog.ts";
import type { PipelineState, StageContext } from "../types.ts";

export const REPLAN_REQUESTS_FILE = "replan-requests.json";
export const ARTIFACT_REVISIONS_FILE = "artifact-revisions.json";
export const REPLAN_AUDIT_FILE = ".replan.jsonl";
const RESUME_CACHE_FILE = ".resume-cache.jsonl";

/** R5: replan restarts per spec (beside MAX_CHALLENGE_REAUTHORS=2 and
 *  ESCALATION_RETRY_CAP=2). Lazy env read (defensive rule #5). */
export const maxReplanRounds = (): number => {
	const n = Number.parseInt(process.env.SUPER_DEV_MAX_REPLAN_ROUNDS ?? "", 10);
	return Number.isFinite(n) && n > 0 ? n : 2;
};

// ─── file shapes ────────────────────────────────────────────────────────────

export interface ReplanRequest {
	id: string;
	title: string;
	detail: string;
	file?: string;
	severity: string;
	/** Owning stage (closed set) — the convergence node that must revise. */
	ownerStage: ReplanOwnerStage;
	/** How this finding was classified (R2 source + reason, audit). */
	classificationSource: string;
	classificationReason: string;
	/** Human-readable revision ask rendered into the owning writer's prompt. */
	requestedRevision: string;
	fingerprint: string;
	status: "pending" | "addressed";
	addressedAt?: string;
	originatedRunId?: string;
	createdAt: string;
}

export interface ReplanRequestsFile {
	version: 1;
	/** R5 budget: how many replan restarts this spec has already performed. */
	rounds: number;
	requests: ReplanRequest[];
}

// ─── small fs helpers (best-effort, never throw) ────────────────────────────

function specPath(specDir: string, name: string): string {
	return join(isAbsolute(specDir) ? specDir : join(process.cwd(), specDir), name);
}

function readJson<T>(path: string, fallback: T): T {
	try {
		if (!existsSync(path)) return fallback;
		return JSON.parse(readFileSync(path, "utf8")) as T;
	} catch {
		return fallback;
	}
}

function writeJson(path: string, value: unknown): boolean {
	try {
		mkdirSync(join(path, ".."), { recursive: true });
		writeFileSync(path, JSON.stringify(value, null, "\t") + "\n");
		return true;
	} catch {
		return false;
	}
}

// ─── R4: stage → resume-cache call-id prefixes ──────────────────────────────

/** Which resume-cache entry call-ids belong to each stage. The cache keys are
 *  `pipeline.<callId>@<scope>#<n>`; a stage is invalidated by dropping every
 *  entry whose call-id starts with one of its prefixes (writer + reviewer +
 *  internal sub-calls). Deterministic-only stages map to [] (no cache rows). */
const STAGE_CALL_PREFIXES: Record<string, string[]> = {
	requirements: ["pipeline.requirements"],
	bdd: ["pipeline.bdd"],
	research: ["pipeline.research"],
	design: ["pipeline.design"],
	spec: ["pipeline.spec"],
	implementation: ["pipeline.implementation."],
	verify: ["pipeline.verify.", "pipeline.review.fix", "pipeline.integration."],
	docs: ["pipeline.docs"],
	preMergeBuild: [],
	cleanup: ["pipeline.cleanup"],
	merge: ["pipeline.merge"],
	"merge-verify": [],
};

/** Drop resume-cache rows for the invalidated stages (R4). Returns how many
 *  rows were dropped. Best-effort: a failure to rewrite leaves the cache
 *  intact — the restart then replays more than intended (safe, just slower:
 *  replay never produces WRONG results, only repeat calls). */
export function invalidateResumeCache(specDir: string, stages: string[]): number {
	try {
		const path = specPath(specDir, RESUME_CACHE_FILE);
		if (!existsSync(path)) return 0;
		const prefixes = stages.flatMap((s) => STAGE_CALL_PREFIXES[s] ?? []);
		if (prefixes.length === 0) return 0;
		const lines = readFileSync(path, "utf8").split("\n").filter((l) => l.trim());
		const kept: string[] = [];
		let dropped = 0;
		for (const line of lines) {
			try {
				const entry = JSON.parse(line) as { key?: string };
				const callId = String(entry.key ?? "").split("@")[0];
				if (prefixes.some((p) => callId.startsWith(p))) {
					dropped++;
					continue;
				}
			} catch { /* unparseable row — keep (never destroy what we cannot read) */ }
			kept.push(line);
		}
		if (dropped > 0) writeFileSync(path, kept.length ? kept.join("\n") + "\n" : "");
		return dropped;
	} catch {
		return 0;
	}
}

// ─── the trigger (R3 entry point) ───────────────────────────────────────────

export interface ReplanMarker {
	rounds: number;
	owners: string[];
	newRequests: number;
	invalidationSet: string[];
}

const classifyOwnerOf = (finding: Record<string, unknown>): string => {
	// Cheap re-derivation for message bodies only — the AUTHORITATIVE owner is
	// the persisted request's ownerStage (computed by the full R2 classifier).
	const ownerStage = String(finding.ownerStage ?? "").toLowerCase();
	return ownerStage || "spec";
};

function fingerprintFinding(f: Record<string, unknown>): string {
	return `${String(f.file ?? "")}|${String(f.severity ?? "")}|${String(f.title ?? "")}`.toLowerCase().replace(/\s+/g, " ");
}

function appendAudit(specDir: string, entry: Record<string, unknown>): void {
	try {
		const dir = isAbsolute(specDir) ? specDir : join(process.cwd(), specDir);
		mkdirSync(dir, { recursive: true });
		appendFileSync(join(dir, REPLAN_AUDIT_FILE), JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n");
	} catch { /* best-effort */ }
}

/**
 * Attempt to route the blocked-on-decisions residue back to its owning stages
 * and mark the run for a replan restart. Returns true when the run should end
 * with status "replan" (extension auto-resumes). On any failure — or when
 * nothing is routable / the R5 budget is exhausted — returns false and the
 * caller falls through to today's honest HITL path (F-C). NEVER throws.
 */
export async function maybeTriggerReplan(state: PipelineState, ctx: StageContext, originatedRunId: string): Promise<boolean> {
	const setup = state.setup;
	if (!setup?.specDirectory) return false;
	try {
		const review = state.review as { deferredFindings?: Array<Record<string, unknown>> } | undefined;
		const candidates = review?.deferredFindings ?? [];
		if (candidates.length === 0) return false;

		// R2: classify each residue finding (deterministic first; lead fallback).
		const classified: Array<{ finding: Record<string, unknown>; decision: ReplanOwnerDecision }> = [];
		for (const finding of candidates) {
			let decision = classifyReplanOwnerDeterministic(finding);
			if (decision === null) {
				decision = await classifyReplanOwner(ctx, { finding });
			}
			classified.push({ finding, decision });
		}
		const routable = classified.filter((c) => c.decision.routable && (REPLAN_OWNER_STAGES as readonly string[]).includes(c.decision.owner));
		if (routable.length === 0) {
			appendAudit(setup.specDirectory, { event: "no-routable-findings", candidates: classified.length });
			return false;
		}

		// R5 budget check.
		const requestsPath = specPath(setup.specDirectory, REPLAN_REQUESTS_FILE);
		const file = readJson<ReplanRequestsFile>(requestsPath, { version: 1, rounds: 0, requests: [] });
		if (file.rounds >= maxReplanRounds()) {
			ctx.log(`Stage 10: replan budget exhausted (${file.rounds}/${maxReplanRounds()} restarts) — falling through to the human boundary with the replan history`);
			appendAudit(setup.specDirectory, { event: "budget-exhausted", rounds: file.rounds, routable: routable.length });
			return false;
		}

		// R3: persist the requests (merge with existing pending; dedupe by fingerprint).
		const now = new Date().toISOString();
		const existingByFp = new Map(file.requests.map((r) => [r.fingerprint, r]));
		const newRequests: ReplanRequest[] = [];
		for (const { finding, decision } of routable) {
			const fp = fingerprintFinding(finding);
			if (existingByFp.has(fp)) continue; // already requested — still pending or addressed
			const title = String(finding.title ?? finding.id ?? "upstream finding");
			const request: ReplanRequest = {
				id: String(finding.id ?? fp.slice(0, 24)),
				title,
				detail: String(finding.detail ?? ""),
				file: finding.file !== undefined ? String(finding.file) : undefined,
				severity: String(finding.severity ?? "medium"),
				ownerStage: decision.owner as ReplanOwnerStage,
				classificationSource: decision.source,
				classificationReason: decision.reason,
				requestedRevision: `Revise the ${decision.owner} artifact to resolve: ${title}. ${String(finding.recommendation ?? finding.detail ?? "")}`.trim(),
				fingerprint: fp,
				status: "pending",
				originatedRunId,
				createdAt: now,
			};
			file.requests.push(request);
			newRequests.push(request);
		}
		if (newRequests.length === 0) {
			// Every routable finding was already requested before and none has been
			// addressed — that is a stall on the owning stage, not a fresh round.
			ctx.log("Stage 10: all routable findings already have pending replan requests — falling through to the human boundary");
			appendAudit(setup.specDirectory, { event: "duplicate-requests", routable: routable.length });
			return false;
		}
		file.rounds += 1;
		if (!writeJson(requestsPath, file)) return false;

		// R4: full invalidation for every revised owner (union of downstream sets).
		const owners = [...new Set(file.requests.filter((r) => r.status === "pending").map((r) => r.ownerStage))];
		const invalidationSet = [...new Set(owners.flatMap((o) => [o, ...downstreamOf(o)]))];
		const revisionsPath = specPath(setup.specDirectory, ARTIFACT_REVISIONS_FILE);
		const revisions = readJson<Record<string, number>>(revisionsPath, {});
		for (const owner of owners) revisions[owner] = (revisions[owner] ?? 0) + 1;
		writeJson(revisionsPath, revisions);
		const dropped = invalidateResumeCache(setup.specDirectory, invalidationSet);

		// Audit + ledger.
		const routedData = {
			findings: routable.map(({ finding, decision }) => ({
				id: String(finding.id ?? ""),
				owner: decision.owner,
				routable: decision.routable,
				source: decision.source,
				reason: decision.reason,
			})),
			invalidationSet,
		};
		appendAudit(setup.specDirectory, { event: "replan-requested", ...routedData, rounds: file.rounds, resumeRowsDropped: dropped });
		appendRunEvent(setup.specDirectory, { runId: originatedRunId, stage: "verify", type: "replan.requested", data: { findings: routable.length, originatedRunId } });
		appendRunEvent(setup.specDirectory, { runId: originatedRunId, stage: "verify", type: "replan.routed", data: routedData });
		for (const owner of owners) {
			appendRunEvent(setup.specDirectory, { runId: originatedRunId, type: "artifact.revised", data: { artifact: owner, revision: revisions[owner] } });
		}

		(state as Record<string, unknown>).__replan = {
			rounds: file.rounds,
			owners,
			newRequests: newRequests.length,
			invalidationSet,
		} satisfies ReplanMarker;
		ctx.log(`Stage 10: REPLAN round ${file.rounds} — ${newRequests.length} finding(s) routed back to ${owners.join(", ")}; invalidated ${invalidationSet.length} stage(s) (${dropped} resume rows) — the run will restart and the owning stages will revise`);
		// P3.1: the WHO-channel alongside the structured requests — each owning
		// stage gets a durable message; the owning convergence loop replies when
		// its reviewer verifies the revision (consumeReplanRequests).
		for (const owner of owners) {
			sendMessage(setup.specDirectory, {
				senderRole: "verify",
				receiverRole: owner,
				subject: `replan round ${file.rounds}: revise ${owner} artifact (${newRequests.filter((r) => r.ownerStage === owner).length} finding(s))`,
				body: routable.filter(({ finding }) => classifyOwnerOf(finding) === owner).map(({ finding }) => String(finding.title ?? "")).slice(0, 8).join("; "),
			}, originatedRunId);
		}
		return true;
	} catch (err) {
		appendAudit(setup.specDirectory, { event: "error", error: err instanceof Error ? err.message : String(err) });
		return false;
	}
}

// ─── R3 consumption: the owning convergence node side ───────────────────────

/** Pending replan requests owned by `stage` (round-1 injection input). */
export function pendingReplanRequests(specDir: string | undefined, stage: string): ReplanRequest[] {
	if (!specDir) return [];
	const file = readJson<ReplanRequestsFile>(specPath(specDir, REPLAN_REQUESTS_FILE), { version: 1, rounds: 0, requests: [] });
	return file.requests.filter((r) => r.status === "pending" && r.ownerStage === stage);
}

/** Flip this stage's pending requests to addressed (called on approval — the
 *  owning reviewer verified the revision; requests are NEVER marked on the
 *  writer's say-so alone, mirroring the convergence-ledger contract). Also
 *  replies to the stage's pending P3.1 messages (the WHO-channel lifecycle
 *  tracks the request lifecycle). */
export function consumeReplanRequests(specDir: string | undefined, stage: string): number {
	if (!specDir) return 0;
	try {
		const path = specPath(specDir, REPLAN_REQUESTS_FILE);
		const file = readJson<ReplanRequestsFile>(path, { version: 1, rounds: 0, requests: [] });
		let n = 0;
		for (const r of file.requests) {
			if (r.status === "pending" && r.ownerStage === stage) {
				r.status = "addressed";
				r.addressedAt = new Date().toISOString();
				n++;
			}
		}
		if (n > 0) {
			writeJson(path, file);
			for (const pending of pendingMessagesFor(specDir, stage)) {
				replyTo(specDir, pending.id, { senderRole: stage, subject: `revision verified by ${stage} review`, body: `${n} request(s) addressed` });
			}
		}
		return n;
	} catch {
		return 0;
	}
}
