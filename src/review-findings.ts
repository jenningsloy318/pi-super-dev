export type NormalizedReviewFindingStatus = "open" | "addressed" | "verified" | "deferred" | "needs-human" | string;

export function compactReviewText(value: unknown): string {
	if (value == null) return "";
	if (Array.isArray(value)) return value.map(compactReviewText).filter(Boolean).join("; ");
	if (typeof value === "object") return JSON.stringify(value);
	return String(value).replace(/\s+/g, " ").trim();
}

export function normalizeReviewFindingStatus(value: unknown): NormalizedReviewFindingStatus {
	const raw = compactReviewText(value).toLowerCase().replace(/[\s_-]+/g, "-");
	if (["open", "new", "unresolved", "regressed", "blocking"].includes(raw)) return "open";
	if (["addressed", "fixed", "resolved", "responded"].includes(raw)) return "addressed";
	if (["verified", "closed", "approved", "pass", "passed"].includes(raw)) return "verified";
	if (["deferred", "accepted", "nonblocking", "non-blocking", "advisory"].includes(raw)) return "deferred";
	if (["needs-human", "needshuman", "human", "unclear", "blocked"].includes(raw)) return "needs-human";
	return raw;
}

export function inferReviewFindingStatus(finding: Record<string, unknown>, fallback: NormalizedReviewFindingStatus = "open"): NormalizedReviewFindingStatus {
	const explicit = normalizeReviewFindingStatus(finding.status);
	if (explicit) return explicit;
	const text = `${compactReviewText(finding.title)}\n${compactReviewText(finding.detail)}`.toLowerCase();
	if (/\b(prior finding verified|verified response|verified fixed|verified.*fixed|no longer logged|no longer present|has been addressed|is addressed)\b/.test(text)) return "verified";
	if (/\b(deferred|non[-\s]?blocking|advisory)\b/.test(text)) return "deferred";
	if (/\b(needs human|needshuman|human decision|human guidance|unclear|ambiguous)\b/.test(text)) return "needs-human";
	return fallback;
}

export function reviewFindingSeverity(finding: Record<string, unknown>, fallback = "medium"): string {
	return compactReviewText(finding.severity) || fallback;
}

export function reviewFindingBlocks(finding: Record<string, unknown>): boolean {
	const status = inferReviewFindingStatus(finding);
	if (["verified", "addressed", "resolved", "fixed", "deferred", "non-blocking", "nonblocking"].includes(status)) return false;
	if (status === "needs-human") return true;
	if (typeof finding.blocking === "boolean") return finding.blocking;
	const blockingText = compactReviewText(finding.blocking).toLowerCase();
	if (/^(false|no|n|0|non.?blocking|advisory)$/.test(blockingText)) return false;
	if (/^(true|yes|y|1|blocking|blocker)$/.test(blockingText)) return true;
	const severity = reviewFindingSeverity(finding).toLowerCase();
	return /^(critical|blocker|fatal|high|error|fail|reject)/.test(severity);
}

/** Verdict-layer blocking test (F-A). `needs-human` is a WHO classification
 *  — an attention-set marker saying "the human must decide this" — NOT a HOW
 *  severity. The unconditional needs-human⇒blocking promotion in
 *  {@link reviewFindingBlocks} is correct for routing (the fixer must never
 *  receive such a finding) but wrong for verdict pinning: it produced the
 *  verified contradiction where the verdict layer demanded changes ("Changes
 *  Requested" pinned by a medium non-blocking needs-human note) while the
 *  R-1 triage layer simultaneously deferred the same finding to the human —
 *  an unactionable verdict that dead-ended the verify loop. For VERDICT
 *  pinning a needs-human finding blocks only when the reviewer's own signals
 *  say so: an explicit `blocking` flag, or a high/critical-class severity
 *  (mirroring GitHub: a COMMENT review never blocks the merge; only
 *  REQUEST_CHANGES does — and Gerrit: the attention set is independent of
 *  blocking labels). Every non-needs-human status delegates to
 *  {@link reviewFindingBlocks} unchanged. */
export function reviewFindingBlocksVerdict(finding: Record<string, unknown>): boolean {
	const status = inferReviewFindingStatus(finding);
	if (status === "needs-human") {
		if (typeof finding.blocking === "boolean") return finding.blocking;
		const blockingText = compactReviewText(finding.blocking).toLowerCase();
		if (/^(true|yes|y|1|blocking|blocker)$/.test(blockingText)) return true;
		if (/^(false|no|n|0|non.?blocking|advisory)$/.test(blockingText)) return false;
		return /^(critical|blocker|fatal|high|error|fail|reject)/.test(reviewFindingSeverity(finding).toLowerCase());
	}
	return reviewFindingBlocks(finding);
}

export function reviewHasFindings(review: { findings?: unknown } | undefined): boolean {
	return Array.isArray(review?.findings) && review.findings.length > 0;
}

export function reviewHasBlockingFinding(review: { findings?: unknown } | undefined): boolean {
	const findings = (review?.findings as Array<Record<string, unknown>> | undefined) ?? [];
	return findings.some(reviewFindingBlocks);
}

/** Verdict-layer blocking scan (F-A): like {@link reviewHasBlockingFinding}
 *  but keyed on {@link reviewFindingBlocksVerdict} — needs-human findings pin
 *  the verdict only through their own blocking flag / high severity, never
 *  through the status alone. */
export function reviewHasBlockingVerdictFinding(review: { findings?: unknown } | undefined): boolean {
	const findings = (review?.findings as Array<Record<string, unknown>> | undefined) ?? [];
	return findings.some(reviewFindingBlocksVerdict);
}

/** All needs-human findings not already in a verified-class state — the
 *  "awaiting human decision" residue, surfaced (never fixed) regardless of
 *  whether it pinned the verdict. */
export function reviewNeedsHumanFindings(review: { findings?: unknown } | undefined): Array<Record<string, unknown>> {
	const findings = (review?.findings as Array<Record<string, unknown>> | undefined) ?? [];
	return findings.filter((f) => inferReviewFindingStatus(f) === "needs-human");
}

/** True when any OPEN finding carries a high/critical-class severity, regardless
 *  of its per-finding `blocking` flag. Findings already verified/addressed/
 *  resolved/deferred no longer count — a resolved high note must not keep the
 *  verdict pinned at Changes Requested. Severity vocabulary mirrors the
 *  blocking-fallback list in {@link reviewFindingBlocks} (critical | blocker |
 *  fatal | high | error | fail | reject, case-insensitive prefix). */
export function reviewHasHighSeverityFinding(review: { findings?: unknown } | undefined): boolean {
	const findings = (review?.findings as Array<Record<string, unknown>> | undefined) ?? [];
	return findings.some((f) => {
		const status = inferReviewFindingStatus(f);
		if (["verified", "addressed", "resolved", "fixed", "deferred"].includes(status)) return false;
		return /^(critical|blocker|fatal|high|error|fail|reject)/.test(reviewFindingSeverity(f).toLowerCase());
	});
}
