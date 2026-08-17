import { localTimestamp } from "./render/time.ts";
import { inferReviewFindingStatus, reviewFindingBlocks } from "./review-findings.ts";
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

function stableHash(input: string): string {
	let hash = 5381;
	for (let i = 0; i < input.length; i++) hash = ((hash << 5) + hash) ^ input.charCodeAt(i);
	return (hash >>> 0).toString(36).padStart(7, "0");
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
	const downgraded = typeof input.downgradeReason === "string" && input.downgradeReason.length > 0;
	const blocking = downgraded ? false : ["addressed", "verified", "deferred"].includes(status) ? false : status === "needs-human" ? true : typeof input.blocking === "boolean" ? input.blocking : reviewFindingBlocks(input as Record<string, unknown>) || normalizeBlocking(input.blocking, severity);
	const fingerprint = stableHash([ownerStage, sourceGate ?? "", title, detail].join("\n").toLowerCase());
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
			existing.severity = normalized.severity;
			existing.blocking = normalized.blocking;
			existing.status = normalized.status === "verified" ? "verified" : normalized.status === "deferred" ? "deferred" : normalized.status === "needs-human" ? "needs-human" : "open";
			existing.title = normalized.title;
			existing.detail = normalized.detail;
			existing.evidence = mergeUnique(existing.evidence, normalized.evidence).slice(0, 16);
			existing.recommendation = normalized.recommendation ?? existing.recommendation;
			existing.invalidatesStages = mergeUnique(existing.invalidatesStages, normalized.invalidatesStages) as ConvergenceOwnerStage[];
			existing.sourceGate = normalized.sourceGate ?? existing.sourceGate;
			existing.priorFindingId = normalized.priorFindingId ?? existing.priorFindingId;
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
	return written;
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
