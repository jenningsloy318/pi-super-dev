import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname } from "node:path";
import { localTimestamp } from "./render/time.ts";
import { inferReviewFindingStatus, reviewFindingBlocks, reviewFindingFingerprint, reviewFindingHighSeverity } from "./review-findings.ts";
import type { RetryFeedback } from "./retry-feedback.ts";
import type { ControlObj, PipelineState } from "./types.ts";

export type ConvergenceOwnerStage =
	| "setup"
	| "classify"
	| "requirements"
	| "bdd"
	| "research"
	| "debug"
	| "assessment"
	| "design"
	| "prototype"
	| "spec"
	| "specReview"
	| "implementation"
	| "verification"
	| "docs"
	| "cleanup"
	| "merge"
	| "environment";

export type ConvergenceFindingStatus = "open" | "addressed" | "verified" | "deferred" | "needs-human";

export interface ConvergenceFinding {
	id: string;
	fingerprint: string;
	detectedAtStage: string;
	ownerStage: ConvergenceOwnerStage;
	severity: string;
	blocking: boolean;
	status: ConvergenceFindingStatus;
	title: string;
	detail: string;
	evidence: string[];
	recommendation?: string;
	invalidatesStages: ConvergenceOwnerStage[];
	sourceGate?: string;
	priorFindingId?: string;
	/** Present when the deterministic convergence-duty layer downgraded a
	 *  late-round NEW non-High blocking finding to advisory — persisted so the
	 *  ledger distinguishes a duty-enforced advisory from a reviewer-authored
	 *  one (code-review G1-DOWNGRADE-AUDIT-LOSS). */
	downgradeReason?: string;
	/** v0.3.1 F1: short stable class name (reviewer-filed) when this finding
	 *  is one instance of a generalizing defect class — drives the
	 *  deterministic class-sweep directive at the 2nd instance. */
	defectClass?: string;
	firstSeenAt: string;
	lastSeenAt: string;
	seenCount: number;
	responses?: ConvergenceFindingResponse[];
}

export interface ConvergenceFindingInput {
	id?: unknown;
	detectedAtStage?: unknown;
	ownerStage?: unknown;
	severity?: unknown;
	blocking?: unknown;
	status?: unknown;
	title?: unknown;
	detail?: unknown;
	evidence?: unknown;
	downgradeReason?: unknown;
	recommendation?: unknown;
	invalidatesStages?: unknown;
	sourceGate?: unknown;
	priorFindingId?: unknown;
	defectClass?: unknown;
}

export interface ConvergenceFindingResponse {
	findingId: string;
	status: ConvergenceFindingStatus;
	response: string;
	evidence?: string;
	ownerStage?: ConvergenceOwnerStage;
	at: string;
}

export interface ConvergenceLedger {
	version: 1;
	findings: ConvergenceFinding[];
}

const ORDER: ConvergenceOwnerStage[] = [
	"setup",
	"classify",
	"requirements",
	"bdd",
	"research",
	"debug",
	"assessment",
	"design",
	"prototype",
	"spec",
	"specReview",
	"implementation",
	"verification",
	"docs",
	"cleanup",
	"merge",
];

const STAGE_ORDER = new Map<ConvergenceOwnerStage, number>(ORDER.map((stage, index) => [stage, index + 1]));

const KNOWN_STAGES = new Set<ConvergenceOwnerStage>([...ORDER, "environment"]);

function asText(value: unknown, fallback = ""): string {
	if (value == null) return fallback;
	if (Array.isArray(value)) return value.map((v) => asText(v)).filter(Boolean).join("; ");
	if (typeof value === "object") return JSON.stringify(value);
	return String(value);
}

function compact(value: unknown, fallback = ""): string {
	return asText(value, fallback).replace(/\s+/g, " ").trim();
}

function asEvidence(value: unknown): string[] {
	if (value == null) return [];
	const raw = Array.isArray(value) ? value : [value];
	return raw.map((v) => compact(v)).filter(Boolean).slice(0, 12);
}

export function normalizeConvergenceStage(value: unknown, fallback: ConvergenceOwnerStage): ConvergenceOwnerStage {
	const raw = compact(value).toLowerCase().replace(/[\s_-]+/g, "");
	const aliases: Record<string, ConvergenceOwnerStage> = {
		setup: "setup",
		prestage: "setup",
		classify: "classify",
		classification: "classify",
		requirement: "requirements",
		requirements: "requirements",
		bdd: "bdd",
		scenario: "bdd",
		scenarios: "bdd",
		research: "research",
		debug: "debug",
		debuganalysis: "debug",
		assessment: "assessment",
		codeassessment: "assessment",
		design: "design",
		prototype: "prototype",
		spec: "spec",
		specification: "spec",
		specreview: "specReview",
		review: "verification",
		implementation: "implementation",
		implement: "implementation",
		verification: "verification",
		verify: "verification",
		integration: "verification",
		docs: "docs",
		documentation: "docs",
		cleanup: "cleanup",
		merge: "merge",
		environment: "environment",
		env: "environment",
	};
	return aliases[raw] ?? fallback;
}

function normalizeStatus(value: unknown, fallback: ConvergenceFindingStatus): ConvergenceFindingStatus {
	const raw = compact(value).toLowerCase().replace(/[\s_-]+/g, "");
	if (["open", "new", "unresolved", "regressed", "blocking"].includes(raw)) return "open";
	if (["addressed", "fixed", "resolved", "responded"].includes(raw)) return "addressed";
	if (["verified", "closed", "approved", "pass", "passed"].includes(raw)) return "verified";
	if (["deferred", "accepted", "nonblocking"].includes(raw)) return "deferred";
	if (["needshuman", "human", "unclear", "blocked"].includes(raw)) return "needs-human";
	return fallback;
}

function normalizeBlocking(value: unknown, severity: string): boolean {
	if (typeof value === "boolean") return value;
	const raw = compact(value).toLowerCase();
	if (/^(false|no|n|0|non.?blocking|advisory)$/.test(raw)) return false;
	if (/^(true|yes|y|1|blocking|blocker)$/.test(raw)) return true;
	return /critical|blocker|fatal|high|error|fail|reject/i.test(severity);
}

function downstreamFrom(stage: ConvergenceOwnerStage): ConvergenceOwnerStage[] {
	if (stage === "environment") return [...ORDER];
	const start = STAGE_ORDER.get(stage);
	if (!start) return [];
	return ORDER.filter((candidate) => (STAGE_ORDER.get(candidate) ?? 0) > start);
}

function normalizeInvalidates(value: unknown, ownerStage: ConvergenceOwnerStage): ConvergenceOwnerStage[] {
	const raw = Array.isArray(value) ? value : [];
	const explicit = raw
		.map((stage) => normalizeConvergenceStage(stage, ownerStage))
		.filter((stage) => stage !== ownerStage && KNOWN_STAGES.has(stage));
	return explicit.length ? [...new Set(explicit)] : downstreamFrom(ownerStage);
}

function ledger(state: PipelineState): ConvergenceLedger {
	const existing = (state as Record<string, unknown>).__convergenceLedger;
	if (existing && typeof existing === "object" && !Array.isArray(existing)) {
		const candidate = existing as Partial<ConvergenceLedger>;
		if (Array.isArray(candidate.findings)) return candidate as ConvergenceLedger;
	}
	const created: ConvergenceLedger = { version: 1, findings: [] };
	(state as Record<string, unknown>).__convergenceLedger = created;
	return created;
}

export function getConvergenceLedger(state: PipelineState): ConvergenceLedger {
	return ledger(state);
}

// ─── v0.3.3 L1: persisted ledger (cumora: state that outlives the loop) ────────

export const CONVERGENCE_LEDGER_FILE = ".convergence-ledger.json";

interface PersistedLedger {
	version: 1;
	taskHash: string;
	persistedAt: string;
	findings: ConvergenceFinding[];
}

/** The task key is the spec dir's `.task` anchor (SPEC_TASK_ANCHOR in
 *  setup.ts — the ORIGINAL task text, stable across restarts; mirrored here
 *  rather than imported to avoid a cycle). Absent anchor hashes to "" — both
 *  sides apply the same rule so they always agree. */
function anchorTaskHash(specDir: string): string | null {
	// sd33 ADV-SD33-1/CODE-SD33-8: a missing anchor returns NULL — never a
	// constant hash. Two different tasks on a legacy track (or two test
	// fixtures sharing a fixed spec dir) must never cross-inject through the
	// hash("") collision; no anchor ⇒ no keying ⇒ no injection.
	try {
		const text = readFileSync(`${specDir.endsWith("/") ? specDir : specDir + "/"}.task`, "utf8");
		return createHash("sha256").update(text).digest("hex").slice(0, 16);
	} catch {
		return null;
	}
}

/** Best-effort persist of the in-memory ledger into the spec dir. Never
 *  throws (a persistence failure must never kill the run); the file is
 *  harness bookkeeping (HARNESS_BOOKKEEPING_FILES + git-excluded), never
 *  agent work. taskText keys the file so a DIFFERENT task on the same track
 *  never inherits the old task's findings. */
export function persistConvergenceLedger(state: PipelineState): void {
	try {
		const dir = state.setup?.specDirectory;
		if (!dir) return;
		const store = ledger(state);
		const anchor = anchorTaskHash(dir);
		if (anchor === null) return; // no .task anchor ⇒ do not persist (test/legacy tracks)
		const payload: PersistedLedger = {
			version: 1,
			taskHash: anchor,
			persistedAt: localTimestamp(),
			findings: store.findings,
		};
		const base = dir.endsWith("/") ? dir : dir + "/";
		mkdirSync(dirname(base.slice(0, -1)), { recursive: true });
		// sd33 CODE-SD33-7: atomic temp+rename — a torn write must never leave a
		// corrupt ledger that kills the NEXT run's injection.
		const tmp = `${base}${CONVERGENCE_LEDGER_FILE}.tmp`;
		writeFileSync(tmp, JSON.stringify(payload), "utf8");
		renameSync(tmp, `${base}${CONVERGENCE_LEDGER_FILE}`);
	} catch { /* best-effort — resume then starts from an empty ledger, as today */ }
}

/** Unresolved BLOCKING findings from a prior run's persisted ledger, for
 *  round-1 injection in the convergence loops (the same seam as pending
 *  replan requests). Guards: absent/corrupt file → []; taskHash mismatch
 *  (a different task on the track) → []; duty-downgraded advisories and
 *  non-blocking rows are skipped; capped at 8 with the remainder counted. */
export function priorFindingsForInjection(specDir: string | undefined): { findings: ConvergenceFinding[]; omitted: number } {
	try {
		if (!specDir) return { findings: [], omitted: 0 };
		const path = `${specDir.endsWith("/") ? specDir : specDir + "/"}${CONVERGENCE_LEDGER_FILE}`;
		if (!existsSync(path)) return { findings: [], omitted: 0 };
		const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<PersistedLedger>;
		const anchor = anchorTaskHash(specDir);
		if (anchor === null || raw?.version !== 1 || !Array.isArray(raw.findings) || raw.taskHash !== anchor) {
			return { findings: [], omitted: 0 };
		}
		// Ledger semantics: "addressed" rows are writer claims awaiting reviewer
		// verification — non-blocking in the ledger, but across a restart nobody
		// will verify the claim, so they are injected as residue too.
		const unresolved = raw.findings.filter((f) =>
			f && typeof f === "object" && !f.downgradeReason &&
			(f.status === "open" || f.status === "needs-human"
				? f.blocking === true
				: f.status === "addressed"));
		return { findings: unresolved.slice(0, 8), omitted: Math.max(0, unresolved.length - 8) };
	} catch {
		return { findings: [], omitted: 0 };
	}
}



/** True only for downgrade reasons produced by the DETERMINISTIC convergence
 *  duty layer (enforceReviewerConvergenceDuty's exact "convergence-duty ("
 *  prefix). LLM-shaped reasons (a forged reviewer field) do not qualify —
 *  provenance gating per adversarial F-01 on the spec-28 review. */
export function isDutyDowngradeReason(reason: unknown): boolean {
	return typeof reason === "string" && reason.startsWith("convergence-duty (");
}

function normalizeFinding(input: ConvergenceFindingInput, defaults: { detectedAtStage: string; ownerStage: ConvergenceOwnerStage; sourceGate?: string }): ConvergenceFinding {
	const ownerStage = normalizeConvergenceStage(input.ownerStage, defaults.ownerStage);
	const detectedAtStage = compact(input.detectedAtStage, defaults.detectedAtStage) || defaults.detectedAtStage;
	const severity = compact(input.severity, "high") || "high";
	const title = compact(input.title, compact(input.detail, "Convergence finding")) || "Convergence finding";
	const detail = compact(input.detail, title) || title;
	const evidence = asEvidence(input.evidence);
	const sourceGate = compact(input.sourceGate, defaults.sourceGate ?? "") || undefined;
	const inferredStatus = inferReviewFindingStatus(input as Record<string, unknown>, "open");
	const status = normalizeStatus(input.status, inferredStatus === "verified" || inferredStatus === "deferred" || inferredStatus === "needs-human" ? inferredStatus : "open");
	// A duty-enforced downgrade is authoritative even for needs-human findings
	// (adversarial G1-NEEDSHUMAN-REPROMOTION): without this the normalize path
	// re-promotes a downgraded late needs-human note to blocking, partially
	// defeating the enforcement on mixed reject rounds.
	const downgraded = isDutyDowngradeReason(input.downgradeReason);
	const blocking = downgraded ? false : ["addressed", "verified", "deferred"].includes(status) ? false : status === "needs-human" ? true : typeof input.blocking === "boolean" ? input.blocking : reviewFindingBlocks(input as Record<string, unknown>) || normalizeBlocking(input.blocking, severity);
	const fingerprint = reviewFindingFingerprint(ownerStage, sourceGate, title, detail);
	const rawId = compact(input.id);
	const id = rawId || `CF-${ownerStage}-${fingerprint}`;
	const now = localTimestamp();
	return {
		id,
		fingerprint,
		detectedAtStage,
		ownerStage,
		severity,
		blocking,
		status,
		title,
		detail,
		evidence,
		recommendation: compact(input.recommendation) || undefined,
		invalidatesStages: normalizeInvalidates(input.invalidatesStages, ownerStage),
		sourceGate,
		priorFindingId: compact(input.priorFindingId) || undefined,
		defectClass: compact(input.defectClass) || undefined,
		downgradeReason: compact(input.downgradeReason) || undefined,
		firstSeenAt: now,
		lastSeenAt: now,
		seenCount: 1,
	};
}

function mergeUnique(existing: string[], incoming: string[]): string[] {
	return [...new Set([...existing, ...incoming].filter(Boolean))];
}

export function recordConvergenceFindings(
	state: PipelineState,
	inputs: ConvergenceFindingInput | ConvergenceFindingInput[],
	defaults: { detectedAtStage: string; ownerStage?: ConvergenceOwnerStage; sourceGate?: string } = { detectedAtStage: "unknown" },
): ConvergenceFinding[] {
	const records = Array.isArray(inputs) ? inputs : [inputs];
	const store = ledger(state);
	const written: ConvergenceFinding[] = [];
	for (const input of records) {
		const normalized = normalizeFinding(input, {
			detectedAtStage: defaults.detectedAtStage,
			ownerStage: defaults.ownerStage ?? normalizeConvergenceStage(defaults.detectedAtStage, "implementation"),
			sourceGate: defaults.sourceGate,
		});
		const existing = store.findings.find((finding) =>
			finding.id === normalized.id ||
			finding.fingerprint === normalized.fingerprint ||
			(normalized.priorFindingId ? finding.id === normalized.priorFindingId : false),
		);
		if (existing) {
			existing.detectedAtStage = normalized.detectedAtStage;
			existing.ownerStage = normalized.ownerStage;
			// M22(b) (SCENARIO-069): a duplicate merge must never WEAKEN a blocker —
			// keep the max severity class (an incoming high-class severity upgrades;
			// a high-class existing severity is never downgraded) and blocking = true
			// if either side blocks. No last-write-wins clearing of an unresolved
			// blocker. EXCEPTION (deviation noted in the phase report): an incoming
			// record carrying a duty-enforced downgradeReason is the deterministic
			// duty layer's authoritative advisory classification — it MUST clear the
			// blocking flag (mirrors normalizeFinding's G1-NEEDSHUMAN-REPROMOTION
			// authority), or a downgraded re-record could never de-fang the row and
			// the pinned late needs-human convergence would regress.
			if (reviewFindingHighSeverity({ severity: normalized.severity }) && !reviewFindingHighSeverity({ severity: existing.severity })) existing.severity = normalized.severity;
			// Adversarial F-01 (spec-28 review): the merge exception is gated on the
			// DUTY-LAYER provenance format — only the deterministic enforcement
			// produces "convergence-duty (" reasons. An LLM-shaped/forged
			// downgradeReason cannot de-fang a live blocking ledger row.
			existing.blocking = isDutyDowngradeReason(normalized.downgradeReason) ? false : existing.blocking || normalized.blocking;
			existing.status = normalized.status === "verified" ? "verified" : normalized.status === "deferred" ? "deferred" : normalized.status === "needs-human" ? "needs-human" : "open";
			existing.title = normalized.title;
			existing.detail = normalized.detail;
			existing.evidence = mergeUnique(existing.evidence, normalized.evidence).slice(0, 16);
			existing.recommendation = normalized.recommendation ?? existing.recommendation;
			existing.invalidatesStages = mergeUnique(existing.invalidatesStages, normalized.invalidatesStages) as ConvergenceOwnerStage[];
			existing.sourceGate = normalized.sourceGate ?? existing.sourceGate;
			existing.priorFindingId = normalized.priorFindingId ?? existing.priorFindingId;
			// v0.3.1 F1: the class is descriptive — an incoming record ADOPTS a class
			// only when the row has none. Keep-first (sd31-SD31-5): a re-record filing
			// a DIFFERENT class name must never rename the row, or a class loses an
			// instance and the 2-instance sweep trigger undercounts.
			if (!existing.defectClass && normalized.defectClass) existing.defectClass = normalized.defectClass;
			if (normalized.downgradeReason) existing.downgradeReason = normalized.downgradeReason;
			else if (normalized.blocking) existing.downgradeReason = undefined; // re-flagged blocking clears the stale downgrade
			existing.lastSeenAt = localTimestamp();
			existing.seenCount += 1;
			written.push(existing);
		} else {
			store.findings.push(normalized);
			written.push(normalized);
		}
	}
	persistConvergenceLedger(state);
	return written;
}

/** v0.3.3: the one unresolved-BLOCKING predicate (open/needs-human, blocking,
 *  no duty downgrade) — shared by the completion audit's anomaly check and
 *  anything else that needs "blockers that were never resolved". */
export function unresolvedBlockingConvergenceFindings(state: PipelineState): ConvergenceFinding[] {
	return ledger(state).findings.filter((f) =>
		["open", "needs-human"].includes(f.status) && f.blocking === true && !f.downgradeReason);
}

export function activeConvergenceFindings(state: PipelineState): ConvergenceFinding[] {
	return ledger(state).findings.filter((finding) => ["open", "addressed", "needs-human"].includes(finding.status));
}

/**
 * Findings that BLOCK progress and are surfaced in retry feedback / stagnation.
 *
 * `addressed` is INTENTIONALLY still blocking: it is the WRITER'S CLAIM that a
 * finding is resolved, not a confirmed fix. It stays in the retry feedback so
 * the reviewer re-checks it, and only leaves the blocking set when the reviewer
 * VERIFIES it (`markConvergenceFindingsVerified` → `verified`) or explicitly
 * defers it. This mirrors the spec-convergence contract ("keep prior findings
 * in the retry prompt until verified") — a writer must not self-clear a blocker
 * by merely asserting it addressed. `needs-human` also stays blocking.
 */
export function blockingConvergenceFindings(state: PipelineState): ConvergenceFinding[] {
	return activeConvergenceFindings(state).filter((finding) => finding.blocking);
}

export function ownerPrecedes(ownerStage: ConvergenceOwnerStage, currentStage: ConvergenceOwnerStage): boolean {
	if (ownerStage === "environment") return true;
	return (STAGE_ORDER.get(ownerStage) ?? Number.MAX_SAFE_INTEGER) < (STAGE_ORDER.get(currentStage) ?? Number.MAX_SAFE_INTEGER);
}

/**
 * Apply a response matrix (writer `reviewResponses` OR reviewer
 * `priorFindingResolutions`) to the ledger.
 *
 * `source` encodes WHO is speaking, which bounds how far a response may advance
 * a finding's status:
 *  - `"writer"` (default): a writer response is only a CLAIM. `verified` and
 *    `deferred` are CLAMPED to `addressed` — a writer must not self-clear a
 *    blocker; it stays blocking until a reviewer verifies it (matches the
 *    documented "keep prior findings until verified" contract).
 *  - `"reviewer"`: the reviewer is the verification authority, so `verified`
 *    and `deferred` are honored and clear the blocker.
 */
export function markConvergenceFindingsAddressedFromResponses(
	state: PipelineState,
	responsesValue: unknown,
	source: "writer" | "reviewer" = "writer",
): number {
	const responses = Array.isArray(responsesValue) ? responsesValue as Array<Record<string, unknown>> : [];
	let count = 0;
	for (const response of responses) {
		const findingId = compact(response.findingId ?? response.id ?? response.priorFindingId);
		if (!findingId) continue;
		const status = normalizeStatus(response.status, "addressed");
		const finding = ledger(state).findings.find((candidate) => candidate.id === findingId || candidate.priorFindingId === findingId);
		if (!finding) continue;
		// Only a reviewer may VERIFY/DEFER a finding out of the blocking set. A
		// writer's verified/deferred claim is clamped to `addressed` (still blocking).
		finding.status = source === "reviewer"
			? (status === "verified" ? "verified" : status === "deferred" ? "deferred" : "addressed")
			: "addressed";
		finding.lastSeenAt = localTimestamp();
		const entry: ConvergenceFindingResponse = {
			findingId,
			status: finding.status,
			response: compact(response.response ?? response.summary ?? response.detail, "addressed in rewritten artifact"),
			evidence: compact(response.evidence) || undefined,
			ownerStage: normalizeConvergenceStage(response.ownerStage, finding.ownerStage),
			at: localTimestamp(),
		};
		finding.responses = [...(finding.responses ?? []), entry];
		count++;
	}
	persistConvergenceLedger(state);
	return count;
}

export function markConvergenceFindingsVerified(state: PipelineState, predicate: (finding: ConvergenceFinding) => boolean): number {
	let count = 0;
	for (const finding of ledger(state).findings) {
		if (!predicate(finding)) continue;
		if (["open", "addressed", "needs-human"].includes(finding.status)) {
			finding.status = "verified";
			finding.lastSeenAt = localTimestamp();
			count++;
		}
	}
	persistConvergenceLedger(state);
	return count;
}

export function recordReviewFindingsFromControl(
	state: PipelineState,
	review: ControlObj | undefined,
	defaults: { detectedAtStage: string; ownerStage?: ConvergenceOwnerStage; sourceGate?: string },
): ConvergenceFinding[] {
	const findings = Array.isArray(review?.findings) ? review.findings as Array<Record<string, unknown>> : [];
	return recordConvergenceFindings(
		state,
		findings.map((finding) => ({
			id: finding.id,
			detectedAtStage: defaults.detectedAtStage,
			ownerStage: finding.ownerStage,
			severity: finding.severity,
			blocking: finding.blocking,
			status: finding.status,
			title: finding.title,
			detail: finding.detail,
			evidence: finding.evidence,
			recommendation: finding.recommendation,
			priorFindingId: finding.priorFindingId,
			defectClass: finding.defectClass,
			downgradeReason: finding.downgradeReason,
			sourceGate: defaults.sourceGate,
		})),
		{ detectedAtStage: defaults.detectedAtStage, ownerStage: defaults.ownerStage ?? "spec", sourceGate: defaults.sourceGate },
	);
}

export function convergenceRetryFeedback(
	state: PipelineState,
	args: { stage: string; currentStage?: ConvergenceOwnerStage; attempt?: number; gate: string; maxItems?: number },
): RetryFeedback[] {
	const current = args.currentStage ?? normalizeConvergenceStage(args.stage, "implementation");
	return blockingConvergenceFindings(state).slice(0, args.maxItems ?? 8).map((finding) => {
		const upstream = ownerPrecedes(finding.ownerStage, current);
		const invalidates = finding.invalidatesStages.length ? ` invalidates=${finding.invalidatesStages.join(",")}` : "";
		return {
			stage: args.stage,
			attempt: args.attempt,
			gate: args.gate,
			location: `convergence-ledger/${finding.id}`,
			observed: `[${finding.status}] owner=${finding.ownerStage}${upstream ? " upstream" : ""}${invalidates}; ${finding.detail}`,
			expected: "the owning artifact is revised and downstream artifacts explicitly respond to this finding before retrying",
			missing: [finding.title, ...finding.evidence].filter(Boolean).slice(0, 8),
			diagnostics: [
				`severity=${finding.severity} blocking=${finding.blocking} firstSeen=${finding.firstSeenAt} lastSeen=${finding.lastSeenAt} seen=${finding.seenCount}`,
				finding.recommendation ? `recommendation=${finding.recommendation}` : "",
			].filter(Boolean),
			nextAction: upstream
				? `Do not silently retry only ${current}. Either repair the upstream ${finding.ownerStage} artifact or write an explicit response proving this downstream rewrite fully resolves ${finding.id}.`
				: `Resolve ${finding.id} in the current artifact and include a reviewResponses entry naming this finding id.`,
		} satisfies RetryFeedback;
	});
}

/**
 * v0.3.1 F1 (WS-2): class-sweep retry feedback. Site-addressed feedback
 * produces whack-a-mole on generalizing defect classes (run 2026-08-20T06-19-50-494Z:
 * ONE over-restrictive-validation class surfaced one filename family per round across
 * 4 rounds). This widens the handle to the class: a `defectClass` that owns ≥2 ledger
 * findings, or one finding re-seen (seenCount ≥ 2), injects a deterministic SWEEP
 * directive at the 2nd instance — not at stagnation round 4.
 *
 * Review remediation (sd31-SD31-1/F-02, SD31-2/F-04): scoped to ONE stage — only
 * findings detected in this stage's review family (detectedAtStage normalizes to the
 * stage) participate, so a design-stage class never leaks into the spec writer's
 * retry prompt; and a class RETIRES once every member finding is verified/deferred
 * (a fully-verified class was swept — re-sweeping it every later rejection is noise).
 */
export function classSweepRetryFeedback(
	state: PipelineState,
	args: { stage: string; gate: string; attempt?: number },
): RetryFeedback[] {
	// Stage-family scoping (sd31-SD31-1/F-02): findings are recorded under the
	// stage's REVIEW key ("designReview", "specReview", …) while callers pass
	// the writer stage ("design", "spec"); strip a trailing "review" so both
	// sides land in the same family before normalizeConvergenceStage.
	const familyOf = (value: unknown): ConvergenceOwnerStage =>
		normalizeConvergenceStage(String(value ?? "").toLowerCase().replace(/review+$/, ""), "implementation");
	const stage = familyOf(args.stage);
	const responsesChannel = stage === "spec"
		? "list the full enumeration in your reviewResponses"
		: "state the full enumeration explicitly in your document (and in reviewResponses when your schema carries it)";
	const byClass = new Map<string, { count: number; seenTotal: number; active: boolean; titles: string[] }>();
	for (const finding of ledger(state).findings) {
		if (!finding.defectClass) continue;
		// Stage scoping: only THIS stage's review family participates.
		if (familyOf(finding.detectedAtStage) !== stage) continue;
		const entry = byClass.get(finding.defectClass) ?? { count: 0, seenTotal: 0, active: false, titles: [] };
		entry.count += 1;
		entry.seenTotal += finding.seenCount;
		// Retirement: a class stays sweepable while ANY member is still open,
		// addressed (writer claim, unverified), or needs-human.
		if (["open", "addressed", "needs-human"].includes(finding.status)) entry.active = true;
		if (entry.titles.length < 3) entry.titles.push(finding.title);
		byClass.set(finding.defectClass, entry);
	}
	const directives: RetryFeedback[] = [];
	for (const [defectClass, entry] of byClass) {
		// Retired: every member verified/deferred — the class was swept and confirmed.
		if (!entry.active) continue;
		// Qualify at the 2nd instance (≥2 findings) OR one finding seen ≥2 rounds.
		if (entry.count < 2 && entry.seenTotal < 2) continue;
		directives.push({
			stage: args.stage,
			attempt: args.attempt,
			gate: args.gate,
			location: `defect-class/${defectClass}`,
			observed: `Defect class "${defectClass}" has now produced ${entry.count} recorded finding(s) across ${entry.seenTotal} sighting(s) — instances include: ${entry.titles.join("; ")}.`,
			expected: "every sibling site of this class in the artifact is fixed in ONE revision, not just the cited instances",
			missing: [
				`SWEEP THE CLASS "${defectClass}": enumerate ALL sibling sites in this artifact the class rule applies to (not only the ones reviewers cited), fix every one, and ${responsesChannel}.`,
			],
			diagnostics: [`class findings=${entry.count} total sightings=${entry.seenTotal}`],
			nextAction: "A site-local fix WILL re-occur as a fresh instance of the same class next round — enumerate the class, do not patch the example.",
		} satisfies RetryFeedback);
	}
	return directives;
}
