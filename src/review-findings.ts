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

export function reviewHasFindings(review: { findings?: unknown } | undefined): boolean {
	return Array.isArray(review?.findings) && review.findings.length > 0;
}

export function reviewHasBlockingFinding(review: { findings?: unknown } | undefined): boolean {
	const findings = (review?.findings as Array<Record<string, unknown>> | undefined) ?? [];
	return findings.some(reviewFindingBlocks);
}
