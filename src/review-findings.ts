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

/** High/critical-class severity vocabulary (shared by the blocking fallback,
 *  the high-severity scan, and the convergence-duty enforcement). Reviewer
 *  severity is free-form LLM text (no schema enum), so the classifier must
 *  cover the common tracker vocabularies — 'major', 'must-fix', 'P0'/'P1',
 *  'S0'/'S1', 'sev0'/'sev1', 'serious' — or genuine late correctness
 *  blockers labeled with them fall outside the high class and get downgraded
 *  to advisory (adversarial G1-SEVERITY-VOCABULARY-GAP). */
const HIGH_SEVERITY_RE = /^(critical|blockers?|fatal|high|errors?|fail(?:ure)?s?|reject(?:ed)?|major|must.?fix(?:es)?|p[01]|s[01]|sev[01]|serious)\b/i;

export function reviewFindingBlocks(finding: Record<string, unknown>): boolean {
	const status = inferReviewFindingStatus(finding);
	if (["verified", "addressed", "resolved", "fixed", "deferred", "non-blocking", "nonblocking"].includes(status)) return false;
	if (status === "needs-human") return true;
	if (typeof finding.blocking === "boolean") return finding.blocking;
	const blockingText = compactReviewText(finding.blocking).toLowerCase();
	if (/^(false|no|n|0|non.?blocking|advisory)$/.test(blockingText)) return false;
	if (/^(true|yes|y|1|blocking|blocker)$/.test(blockingText)) return true;
	const severity = reviewFindingSeverity(finding).toLowerCase();
	return HIGH_SEVERITY_RE.test(severity);
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
		// ONE shared high-class vocabulary for the verdict pin, the duty shield
		// and the high-severity scan (adversarial R2-G1-VERDICT-VOCABULARY-SPLIT:
		// the old narrow inline regex let 'P1'/'major'/'serious' needs-human
		// findings silently approve).
		return reviewFindingHighSeverity(finding);
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

/** Per-finding high/critical-class severity test (the vocabulary shared by
 *  {@link reviewFindingBlocks}' severity fallback and
 *  {@link reviewHasHighSeverityFinding}). */
export function reviewFindingHighSeverity(finding: Record<string, unknown>): boolean {
	return HIGH_SEVERITY_RE.test(reviewFindingSeverity(finding));
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
		return HIGH_SEVERITY_RE.test(reviewFindingSeverity(f));
	});
}

// ─── deterministic convergence-duty enforcement (G1) ─────────────────────────

/** First review round subject to deterministic convergence-duty enforcement.
 *  Rounds 1-2 are free: a fresh review may surface anything (best practice:
 *  >= 2 review passes). From round 3 on, the reviewer's contractual duty —
 *  "no NEW blocking findings unless High/Critical correctness defects" — is
 *  enforced mechanically instead of by prompt compliance (run 08-56 burned 7
 *  rounds on exactly this: priors resolved each round while fresh medium
 *  blockers kept the loop open until the cap killed it). */
export const REVIEWER_DUTY_ROUND = 3;

/** Deterministically enforce the reviewer convergence-duty contract on a
 *  review control BEFORE approval is computed: at round >=
 *  {@link REVIEWER_DUTY_ROUND}, a finding that (a) blocks, (b) carries NO
 *  `priorFindingId` (it is NEW this round — a re-flag of a prior finding is a
 *  reviewer-verified regression/unresolved item and stays blocking), and (c)
 *  is not high/critical-class severity, is downgraded in place to advisory
 *  (`blocking = false` + `downgradeReason`). Needs-human findings are included
 *  in the downgrade: a late-round non-high needs-human note is an attention
 *  request, not a loop-killer. Returns the number downgraded (0 = nothing to
 *  do / round too early). Mutates the control's findings so both the verdict
 *  layer (`reviewHasBlockingFinding`) and the ledger record see the advisory
 *  classification. */
export function enforceReviewerConvergenceDuty(
	review: { findings?: unknown; verdict?: unknown } | undefined,
	reviewRound: number,
	opts: { stage: string; knownFindingIds?: Set<string> },
): number {
	if (!review || reviewRound < REVIEWER_DUTY_ROUND) return 0;
	const findings = (review.findings as Array<Record<string, unknown>> | undefined) ?? [];
	let downgraded = 0;
	for (const f of findings) {
		if (!reviewFindingBlocks(f)) continue; // already advisory/verified
		// Re-flag of a prior finding — a reviewer-verified regression stays
		// blocking. But priorFindingId is free-form reviewer text: an UNKNOWN id
		// must not dodge the enforcement (adversarial G1-PRIORFINDINGID-DODGE),
		// and neither may a re-flag of a DUTY-DOWNGRADED advisory resurrect it
		// as a permanent blocker (adversarial R2-G1-PRIORFINDING-RESURRECTION) —
		// so the shield applies only to ledger ids still classified blocking.
		// A re-flagged advisory is a fresh opinion that must re-earn blocking
		// through High/Critical severity.
		if (f.priorFindingId && (!opts.knownFindingIds || opts.knownFindingIds.has(String(f.priorFindingId)))) continue;
		if (reviewFindingHighSeverity(f)) continue; // High/Critical correctness defect may block late
		f.blocking = false;
		f.downgradeReason = `convergence-duty (${opts.stage}, review round ${reviewRound}): new ${reviewFindingSeverity(f)} finding — late-round blocking is reserved for High/Critical correctness defects; recorded as advisory`;
		downgraded++;
	}
	return downgraded;
}
