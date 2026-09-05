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
import { superDevEnv } from "../render/super-dev-dir.ts";
import { isAbsolute, join } from "node:path";
import { classifyReplanOwnerDeterministic, type ReplanOwnerDecision, type ReplanOwnerStage, REPLAN_OWNER_STAGES } from "./owners.ts";
import { classifyReplanOwner } from "./lead.ts";
import { downstreamOf } from "../graph/edges.ts";
import { sendMessage, replyTo, pendingMessagesFor } from "../team/messages.ts";
import { appendRunEvent, readRunEvents } from "../runlog.ts";
import type { PipelineState, StageContext } from "../types.ts";

export const REPLAN_REQUESTS_FILE = "replan-requests.json";
export const ARTIFACT_REVISIONS_FILE = "artifact-revisions.json";
export const REPLAN_AUDIT_FILE = ".replan.jsonl";
const RESUME_CACHE_FILE = ".resume-cache.jsonl";

/** R5: replan restarts per spec (beside MAX_CHALLENGE_REAUTHORS=2 and
 *  ESCALATION_RETRY_CAP=2). Lazy env read (defensive rule #5). */
export const maxReplanRounds = (): number => {
	const n = Number.parseInt(superDevEnv("SUPER_DEV_MAX_REPLAN_ROUNDS") ?? "", 10);
	return Number.isFinite(n) && n > 0 ? n : 2;
};

// ─── file shapes ────────────────────────────────────────────────────────────

export interface ReplanRequest {
	id: string;
	title: string;
	detail: string;
	file?: string;
	severity: string;
	/** Owning stage — a routable convergence-loop stage, or "human" for the
	 *  deferred findings no machine owner may act on (D4/AC-20: the routing
	 *  closed set REPLAN_OWNER_STAGES is untouched; human rows are never
	 *  consumed by any stage — they persist for the HITL boundary). */
	ownerStage: ReplanOwnerStage | "human";
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

/** M2 inline route-back (routing-architecture plan): persist `findings` as
 *  PENDING replan requests owned by `owner` — the re-entered owning
 *  convergence node picks them up at round 1 via pendingReplanRequests()
 *  (the v0.3.3 ledger injection), so the sub-walk's revision work is
 *  prompted WITHOUT the terminal replan/auto-resume circuit. Dedupes by
 *  fingerprint against existing rows (a re-blocked finding whose request is
 *  still pending is NOT double-injected). Returns the number appended. */
export function appendRouteBackRequests(
	specDir: string,
	owner: ReplanOwnerStage,
	findings: Array<Record<string, unknown>>,
	originatedRunId: string,
): number {
	try {
		const requestsPath = specPath(specDir, REPLAN_REQUESTS_FILE);
		const file = readJson<ReplanRequestsFile>(requestsPath, { version: 1, rounds: 0, requests: [] });
		const now = new Date().toISOString();
		// T3.4b semantics (review round-1 F-1/F-2): a PENDING request, or one
		// addressed DURING this run (a consume echo), suppresses re-injection; a
		// request addressed BEFORE this run is a REGRESSION target and MUST
		// re-inject — mirrors triggerReplanForFindings' suppressesReroute.
		const runStart = runStartedAt(specDir, originatedRunId);
		const suppresses = (r: ReplanRequest): boolean =>
			r.status !== "addressed" || (runStart !== "" && String(r.addressedAt ?? "") >= runStart);
		let appended = 0;
		for (const finding of findings) {
			const fp = fingerprintFinding(finding);
			if (file.requests.some((r) => r.fingerprint === fp && suppresses(r))) continue;
			const title = String(finding.title ?? finding.id ?? "upstream finding");
			file.requests.push({
				id: `rb-${String(finding.id ?? fp.slice(0, 24))}`,
				title,
				detail: String(finding.detail ?? ""),
				file: finding.file !== undefined ? String(finding.file) : undefined,
				severity: String(finding.severity ?? "medium"),
				ownerStage: owner,
				classificationSource: "route-back",
				classificationReason: "inline route-back (M2 pilot): upstream-owned blocker surfaced downstream",
				requestedRevision: `Revise the ${owner} artifact to resolve: ${title}. ${String(finding.recommendation ?? finding.detail ?? "")}`.trim(),
				fingerprint: fp,
				status: "pending",
				originatedRunId,
				createdAt: now,
			});
			appended++;
		}
		if (appended > 0 && !writeJson(requestsPath, file)) return -1; // write FAILURE — distinct from 0-dedupe
		return appended;
	} catch {
		return -1;
	}
}

// ─── R4: stage → resume-cache call-id prefixes ──────────────────────────────

/** AC-05: prefixes invalidated on EVERY replan trigger regardless of owner —
 *  judge and replan-lead output is downstream of any revised artifact, so its
 *  resume rows must always drop (and the prefix set is never empty, so the
 *  invalidation never short-circuits to 0). Exported for the drift-guard
 *  tripwire (tests/replan-stage-prefix-edges.test.ts). */
export const ALWAYS_INVALIDATED_PREFIXES = ["pipeline.judge.", "pipeline.replan."] as const;

/** Which resume-cache entry call-ids belong to each stage. The cache keys are
 *  `pipeline.<callId>@<scope>#<n>`; a stage is invalidated by dropping every
 *  entry whose call-id starts with one of its prefixes (writer + reviewer +
 *  internal sub-calls). Deterministic-only stages map to [] (no cache rows).
 *  Exported (NFR-3) for the SCENARIO-009 source-grep drift-guard tripwire.
 *
 *  H4 (AC-04): debug/assessment/prototype writers emit `pipeline.debug`,
 *  `pipeline.assessment`, `pipeline.prototype.r<NN>` (writers.ts writerTask
 *  ids + prototype.ts:94) — all inside downstreamOf(owner) for every owner
 *  ≥ requirements, so their rows must drop with the suffix.
 *  `classify: []` is DELIBERATE (D2): classify's only inbound edge is
 *  setup→classify; it is never inside downstreamOf(owner) for owners ≥
 *  requirements, so its rows are stage-local diagnostics. */
export const STAGE_CALL_PREFIXES: Record<string, string[]> = {
	requirements: ["pipeline.requirements"],
	bdd: ["pipeline.bdd"],
	research: ["pipeline.research"],
	debug: ["pipeline.debug"],
	assessment: ["pipeline.assessment"],
	design: ["pipeline.design"],
	prototype: ["pipeline.prototype."],
	spec: ["pipeline.spec"],
	implementation: ["pipeline.implementation."],
	verify: ["pipeline.verify.", "pipeline.review.fix", "pipeline.integration."],
	docs: ["pipeline.docs"],
	preMergeBuild: [],
	classify: [],
	cleanup: ["pipeline.cleanup"],
	merge: ["pipeline.merge"],
	"merge-verify": [],
};

/** Drop resume-cache rows for the invalidated stages (R4). Returns how many
 *  rows were dropped. Best-effort: a failure to rewrite leaves the cache
 *  intact — the restart then replays more than intended (safe, just slower:
 *  replay never produces WRONG results, only repeat calls).
 *  AC-05 (SCENARIO-011/012): judge + replan-lead prefixes are unconditionally
 *  unioned in — the set is never empty and the invalidation never
 *  short-circuits to 0. */
export function invalidateResumeCache(specDir: string, stages: string[]): number {
	try {
		const path = specPath(specDir, RESUME_CACHE_FILE);
		if (!existsSync(path)) return 0;
		const prefixes = [...new Set([...stages.flatMap((s) => STAGE_CALL_PREFIXES[s] ?? []), ...ALWAYS_INVALIDATED_PREFIXES])];
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
	// Sweep-3 G36: detail hash + owner join the fingerprint — pre-fix two
	// DISTINCT blockers sharing file|severity|title (different root causes in
	// the detail, or different owning stages) deduped into one request and the
	// second was silently dropped from round-1 injection.
	const detailHash = String(f.detail ?? "");
	let h = 5381;
	for (let i = 0; i < detailHash.length; i++) h = ((h << 5) + h) ^ detailHash.charCodeAt(i);
	const owner = String(f.ownerStage ?? "").toLowerCase().trim();
	return `${String(f.file ?? "")}|${String(f.severity ?? "")}|${String(f.title ?? "")}|${(h >>> 0).toString(36)}|${owner}`.toLowerCase().replace(/\s+/g, " ");
}

function appendAudit(specDir: string, entry: Record<string, unknown>): void {
	try {
		const dir = isAbsolute(specDir) ? specDir : join(process.cwd(), specDir);
		mkdirSync(dir, { recursive: true });
		appendFileSync(join(dir, REPLAN_AUDIT_FILE), JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n");
	} catch { /* best-effort */ }
}

/** B6 (adv-B fix-in-pass): do rows for the invalidation set's stages still
 *  exist in the cache? (invalidateResumeCache returning 0 while this is true
 *  means the rewrite failed — the restart would replay stale judge/replan/
 *  downstream state.) Never throws. */
/** Exported for the routing walker's B6 guard (M2 review F-3): an
 *  invalidation that dropped 0 rows while matching rows exist is a FAILURE. */
export function resumeCacheHasRowsFor(specDir: string, stages: string[]): boolean {
	try {
		const path = specPath(specDir, RESUME_CACHE_FILE);
		if (!existsSync(path)) return false;
		const prefixes = [...new Set(stages.flatMap((s) => STAGE_CALL_PREFIXES[s] ?? []))];
		if (prefixes.length === 0) return false;
		for (const line of readFileSync(path, "utf8").split("\n")) {
			const trimmed = line.trim();
			if (!trimmed) continue;
			try {
				const entry = JSON.parse(trimmed) as { key?: string };
				const callId = String(entry.key ?? "").split("@")[0];
				if (prefixes.some((p) => callId.startsWith(p))) return true;
			} catch { /* unparseable row — not evidence of a surviving match */ }
		}
		return false;
	} catch {
		return false;
	}
}

/** T3.4b (code-B/B6 fix-in-pass): the current run's start time — the
 *  `run.started` event of `runId` in the run ledger (falls back to the newest
 *  run.started, then to "" — an unknown start treats every addressed request
 *  as addressed-before-this-run, the re-route-biased side). */
function runStartedAt(specDir: string, runId: string): string {
	try {
		const events = readRunEvents(specDir);
		const mine = events.filter((e) => e.type === "run.started" && e.runId === runId);
		const evt = mine.length > 0 ? mine[mine.length - 1] : [...events].reverse().find((e) => e.type === "run.started");
		return evt?.time ?? "";
	} catch {
		return "";
	}
}

/** F9 (v0.3.67): a REPLAN round routed mid-run sets the `__replan` marker —
 * the current pass must WIND DOWN (remaining phases, §D re-entry, Stage 10)
 * instead of executing a superseded plan until workflow end (incident
 * 2026-09-04T14-45-04-784Z burned ~7.5h between marker and restart). */
export function replanPending(state: PipelineState): boolean {
	return Boolean((state as Record<string, unknown>).__replan);
}

/**
 * Attempt to route the blocked-on-decisions residue back to its owning stages
 * and mark the run for a replan restart. Returns true when the run should end
 * with status "replan" (extension auto-resumes). On any failure — or when
 * nothing is routable / the R5 budget is exhausted — returns false and the
 * caller falls through to today's honest HITL path (F-C). NEVER throws.
 *
 * F1 (RC3, runs 2026-08-17T08-56-53-706Z / 08-09-34-515Z): the general core is
 * now `triggerReplanForFindings` — the CONVERGENCE loops (requirements/bdd/
 * research/design/spec) call it directly with their upstream-owned blocking
 * findings when HITL escalation yields no decision (headless) or at round-cap
 * exhaustion. This is the missing route-back edge: a reviewer finding owned by
 * an upstream artifact re-enters that stage's convergence loop instead of
 * oscillating in the loop that cannot fix it.
 */
/** F1: the generalized replan trigger — route ANY finding set (verify residue,
 * convergence-loop upstream blockers) back to its owning stages. Sets the
 * `__replan` marker on success so workflow.ts derives terminal status "replan"
 * (which precedes the aborted→failed branch) and the extension auto-resumes
 * with the owner + downstreamOf(owner) resume-cache rows invalidated. */
export async function triggerReplanForFindings(
	state: PipelineState,
	ctx: StageContext,
	findings: Array<Record<string, unknown>>,
	sourceStage: string,
	originatedRunId: string,
): Promise<boolean> {
	const setup = state.setup;
	if (!setup?.specDirectory) return false;
	// Never double-fire within one run (the marker flips the terminal status).
	if ((state as Record<string, unknown>).__replan) return false;
	try {
		const candidates = findings;
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
		// T3.4b (code-B): the fingerprint dedupe must NOT suppress on a request
		// that was addressed BEFORE this run started — a matching finding NOW is a
		// REGRESSION of an already-addressed finding and re-routes (a new request
		// row) instead of falling through to HITL. A request addressed DURING this
		// run (addressedAt ≥ run start) still suppresses (same-run consume echo).
		const runStart = runStartedAt(setup.specDirectory, originatedRunId);
		/** true when the request still suppresses re-routing: pending, or addressed
		 *  DURING this run (a same-run consume echo). An addressed request from
		 *  BEFORE the run start is a regression target — it must NOT suppress. */
		const suppressesReroute = (r: ReplanRequest): boolean =>
			r.status !== "addressed" || (runStart !== "" && String(r.addressedAt ?? "") >= runStart);
		const existingByFp = new Map(file.requests.filter(suppressesReroute).map((r) => [r.fingerprint, r]));
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
		// M10 (AC-20/SCENARIO-043): every classified finding NOT routed survives
		// machine-readably as an ownerStage:"human" pending row — the HITL path
		// carries the complete deferred list instead of silently dropping it.
		// Human rows do not count toward newRequests (they never drive a restart);
		// when ZERO findings are routable the function already returned false
		// above (the HITL path carries the list from the review state itself).
		const humanRequests: ReplanRequest[] = [];
		for (const { finding, decision } of classified) {
			if (routable.some((r) => r.finding === finding)) continue;
			const fp = fingerprintFinding(finding);
			if (existingByFp.has(fp) || file.requests.some((r) => r.fingerprint === fp)) continue; // already persisted (pending or human)
			humanRequests.push({
				id: String(finding.id ?? fp.slice(0, 24)),
				title: String(finding.title ?? finding.id ?? "deferred finding"),
				detail: String(finding.detail ?? ""),
				file: finding.file !== undefined ? String(finding.file) : undefined,
				severity: String(finding.severity ?? "medium"),
				ownerStage: "human",
				classificationSource: decision.source,
				classificationReason: decision.reason,
				requestedRevision: `Human decision required: ${String(finding.title ?? "")}. ${String(finding.recommendation ?? finding.detail ?? "")}`.trim(),
				fingerprint: fp,
				status: "pending",
				originatedRunId,
				createdAt: now,
			});
		}
		file.requests.push(...humanRequests);
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
		// Human rows are structurally excluded — no stage consumes them, so no
		// stage's cache is invalidated on their account (AC-20).
		const owners = [...new Set(file.requests.filter((r) => r.status === "pending" && r.ownerStage !== "human").map((r) => r.ownerStage))];
		const invalidationSet = [...new Set(owners.flatMap((o) => [o, ...downstreamOf(o)]))];
		const revisionsPath = specPath(setup.specDirectory, ARTIFACT_REVISIONS_FILE);
		const revisions = readJson<Record<string, number>>(revisionsPath, {});
		for (const owner of owners) revisions[owner] = (revisions[owner] ?? 0) + 1;
		writeJson(revisionsPath, revisions);
		const dropped = invalidateResumeCache(setup.specDirectory, invalidationSet);
		// B6 (adv-B): an invalidation that dropped 0 rows while matching rows
		// exist is a FAILURE — a restart would replay the stale suffix. Abort the
		// replan (no __replan) so the honest HITL path runs instead.
		if (dropped === 0 && resumeCacheHasRowsFor(setup.specDirectory, invalidationSet)) {
			appendAudit(setup.specDirectory, { event: "invalidation-failed", invalidationSet });
			ctx.log("Stage 10: resume-cache invalidation dropped 0 rows while matching rows exist — replan aborted, falling through to the human boundary");
			return false;
		}

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
		appendRunEvent(setup.specDirectory, { runId: originatedRunId, stage: sourceStage, type: "replan.requested", data: { findings: routable.length, originatedRunId } });
		appendRunEvent(setup.specDirectory, { runId: originatedRunId, stage: sourceStage, type: "replan.routed", data: routedData });
		for (const owner of owners) {
			appendRunEvent(setup.specDirectory, { runId: originatedRunId, type: "artifact.revised", data: { artifact: owner, revision: revisions[owner] } });
		}

		(state as Record<string, unknown>).__replan = {
			rounds: file.rounds,
			owners,
			newRequests: newRequests.length,
			invalidationSet,
		} satisfies ReplanMarker;
		ctx.log(`REPLAN round ${file.rounds} (${sourceStage}) — ${newRequests.length} finding(s) routed back to ${owners.join(", ")}; invalidated ${invalidationSet.length} stage(s) (${dropped} resume rows) — the run will restart and the owning stages will revise`);
		// P3.1: the WHO-channel alongside the structured requests — each owning
		// stage gets a durable message; the owning convergence loop replies when
		// its reviewer verifies the revision (consumeReplanRequests).
		for (const owner of owners) {
			sendMessage(setup.specDirectory, {
				senderRole: sourceStage,
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

/** Pending replan requests owned by `stage` (round-1 injection input).
 *  Human rows are structurally excluded — they are never injected into any
 *  convergence loop (AC-20). */
export function pendingReplanRequests(specDir: string | undefined, stage: string): ReplanRequest[] {
	if (!specDir) return [];
	const file = readJson<ReplanRequestsFile>(specPath(specDir, REPLAN_REQUESTS_FILE), { version: 1, rounds: 0, requests: [] });
	return file.requests.filter((r) => r.status === "pending" && r.ownerStage === stage && r.ownerStage !== "human");
}

/** AC-20 (SCENARIO-043/044): the pending HUMAN-owned deferred rows — surfaced
 *  on resume (extension replan-restart log) so the user sees what awaits their
 *  decision; never consumed by any stage. */
export function pendingHumanReplanRequests(specDir: string | undefined): ReplanRequest[] {
	if (!specDir) return [];
	const file = readJson<ReplanRequestsFile>(specPath(specDir, REPLAN_REQUESTS_FILE), { version: 1, rounds: 0, requests: [] });
	return file.requests.filter((r) => r.status === "pending" && r.ownerStage === "human");
}

/** Flip this stage's pending requests to addressed (called on approval — the
 *  owning reviewer verified the revision; requests are NEVER marked on the
 *  writer's say-so alone, mirroring the convergence-ledger contract). Human
 *  rows are NEVER consumed by any stage (AC-20). Also replies to the stage's
 *  pending P3.1 messages (the WHO-channel lifecycle tracks the request
 *  lifecycle). */
export function consumeReplanRequests(specDir: string | undefined, stage: string): number {
	if (!specDir) return 0;
	try {
		const path = specPath(specDir, REPLAN_REQUESTS_FILE);
		const file = readJson<ReplanRequestsFile>(path, { version: 1, rounds: 0, requests: [] });
		let n = 0;
		for (const r of file.requests) {
			if (r.status === "pending" && r.ownerStage === stage && r.ownerStage !== "human") {
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
