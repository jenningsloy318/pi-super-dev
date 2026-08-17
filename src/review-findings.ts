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
 *  to advisory (adversarial G1-SEVERITY-VOCABULARY-GAP).
 *  adv-B/B8: UNANCHORED word-boundary alternation — a high-class token
 *  ANYWHERE in the severity string classifies high, so compound severities
 *  ('medium-high', 'very high', 'correctness-critical') do not slip under the
 *  old ^ prefix anchor. The trailing \b still excludes prefix false
 *  positives ('majorly cosmetic', 'P10', 'S12', 'highly minor'). */
const HIGH_SEVERITY_RE = /(critical|blockers?|fatal|high|errors?|fail(?:ure)?s?|reject(?:ed)?|major|must.?fix(?:es)?|p[01]|s[01]|sev[01]|serious)\b/i;

/** M17 (SCENARIO-057/058): negated approvals never classify as approvals.
 *  Evaluated BEFORE the approve-family match so "not approved" /
 *  "does not pass" / "not passing" / "approved: no" cannot pass the
 *  \b(approved|pass|accept)\b heuristic ("unapproved" is already safe — no
 *  word boundary). Shared by reviewVerdictApproves (artifact-convergence.ts)
 *  and isApprovedVerdict (doc-validators.ts). */
export const NEGATED_APPROVAL_RE = /\b(?:not|never|no|cannot|can'?t|won'?t|doesn'?t|does\s+not|isn'?t)\s+(?:approved?|pass(?:ing|es|ed)?|accepted?)\b|approved?\s*[:=]\s*no/i;

export function reviewFindingBlocks(finding: Record<string, unknown>): boolean {
	// M23 (SCENARIO-070/071): explicit signals outrank prose inference. The prose
	// scan inside inferReviewFindingStatus runs ONLY when the finding carries
	// neither an explicit status field nor blocking === true — a "Deferred: …"
	// title can no longer de-fang a finding carrying an explicit blocking flag.
	// When such an explicit signal exists, the status is the normalized status
	// field only ("" when absent — never a prose guess); the high-class severity
	// vocabulary still blocks via the severity fallback below whenever the prose
	// scan does not clear the finding.
	// DEVIATION from spec §A (noted in the phase report): the architecture's
	// literal `blocking === true || reviewFindingHighSeverity(finding)` signal
	// flips the pinned CONTEST verified-note behavior (tests/helpers.test.ts
	// "does not let a verified prior high-severity note block CONTEST" — a
	// prose-verified finding with high severity and no blocking flag must stay
	// non-blocking), which NFR-1 forbids flipping; M23's attack shapes all carry
	// blocking === true, so the scenario contract is fully satisfied either way.
	const hasExplicitStatus = typeof finding.status === "string" && finding.status.trim() !== "";
	// Code-review F-1 (spec-28): a high-class severity is itself an EXPLICIT
	// signal (AC-35 / spec §A) — `{severity: "critical", title: "Deferred: …"}`
	// with no status/blocking flag must not be prose-inferred to deferred.
	const hasExplicitHighSeverity = reviewFindingHighSeverity(finding);
	const status = hasExplicitStatus || finding.blocking === true || hasExplicitHighSeverity
		? normalizeReviewFindingStatus(finding.status) // "" when absent — never a prose guess
		: inferReviewFindingStatus(finding);
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
 *  {@link reviewFindingBlocks} unchanged — including its M23/AC-35 explicit-
 *  signal precedence (an explicit status or blocking flag outranks the prose
 *  scan), so the fix is inherited here without change. */
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

/** M22/R-01 (SCENARIO-068): the convergence fingerprint — the SAME
 *  ownerStage+sourceGate+title+detail inputs the ledger records, hashed
 *  identically to the ledger's historical stableHash so pre-record enforcement
 *  can match restatements. Moved here from convergence-ledger.ts (the reverse
 *  import would be circular); byte-identical semantics. */
export function reviewFindingFingerprint(ownerStage: string, sourceGate: string | undefined, title: string, detail: string): string {
	let hash = 5381;
	const input = [ownerStage, sourceGate ?? "", title, detail].join("\n").toLowerCase();
	for (let i = 0; i < input.length; i++) hash = ((hash << 5) + hash) ^ input.charCodeAt(i);
	return (hash >>> 0).toString(36).padStart(7, "0");
}

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
	opts: {
		stage: string;
		knownFindingIds?: Set<string>;
		/** M22 (SCENARIO-068): fingerprints of currently-blocking ledger findings —
		 *  a review finding matching one is a RESTATEMENT, not a new finding. */
		knownBlockingFingerprints?: Set<string>;
		/** The sourceGate the caller records review findings under (e.g.
		 *  "requirements-review" / "spec-review") — fingerprint input. */
		reviewSourceGate?: string;
	},
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
		// B7 (SCENARIO-068): own-id re-flag shield — a finding whose OWN id is a
		// currently-blocking ledger id is a re-raise of a live blocker, not a NEW
		// finding; the duty layer must not downgrade it.
		if (opts.knownFindingIds?.has(String(f.id))) continue;
		// M22 (SCENARIO-068): verbatim restatement shield — a review finding whose
		// convergence fingerprint matches a currently-blocking ledger finding is a
		// RESTATEMENT of a live blocker (same ownerStage/sourceGate/title/detail
		// the ledger recorded), never a NEW finding the duty layer may downgrade.
		// DEVIATION from spec §C (noted in the phase report): needs-human findings
		// are EXEMPT — the G1 duty contract deliberately downgrades late
		// non-high needs-human notes ("an attention request, not a loop-killer");
		// shielding a recurring needs-human restatement would keep the loop open
		// forever (the exact run-08-56 spiral the duty layer exists to stop, pinned
		// by tests/spec-convergence.test.ts "a late non-high needs-human note
		// converges instead of killing the loop").
		if (opts.knownBlockingFingerprints && opts.reviewSourceGate && inferReviewFindingStatus(f) !== "needs-human") {
			const candidate = reviewFindingFingerprint(compactReviewText(f.ownerStage), opts.reviewSourceGate, compactReviewText(f.title), compactReviewText(f.detail));
			if (opts.knownBlockingFingerprints.has(candidate)) continue;
		}
		if (reviewFindingHighSeverity(f)) continue; // High/Critical correctness defect may block late
		f.blocking = false;
		f.downgradeReason = `convergence-duty (${opts.stage}, review round ${reviewRound}): new ${reviewFindingSeverity(f)} finding — late-round blocking is reserved for High/Critical correctness defects; recorded as advisory`;
		downgraded++;
	}
	return downgraded;
}
