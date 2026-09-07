/**
 * v0.3.74 P1-a — the SINGLE canonical registry of the harness's own
 * bookkeeping/evidence file basenames (M6 class, run
 * 2026-09-05T23-09-55-596Z).
 *
 * Before this module the same names lived in FOUR parallel `new Set([...])`
 * literals across TWO files (tracking.ts ×2, test-artifacts.ts ×2) —
 * `events.jsonl` sat in one list and not another, and that drift fired twice
 * as red-polluted RED retries ("red-polluted: RED phase changed production
 * file(s): docs/…/events.jsonl"). A new bookkeeping file added to k<4 lists
 * regresses silently. Here every basename is declared ONCE with per-consumer
 * role flags; the consumers derive their sets and may not declare literals of
 * their own (pinned by tests/harness-path-registry.test.ts — golden-set
 * equality + no-drift source scan).
 *
 * Role semantics (deliberately NOT identical — the semantic DIFFERENCES are
 * the point, e.g. `events.jsonl` is advisory-noise anywhere for the tracker
 * but RED-boundary-exempt only inside the spec dir):
 *
 * - `redBoundaryAnywhere`   — exempt from the RED write-boundary wherever the
 *                             basename appears (test-artifacts).
 * - `redBoundarySpecScoped` — exempt from the RED write-boundary ONLY under
 *                             docs/specifications/ (test-artifacts). A repo
 *                             file with the same basename elsewhere stays
 *                             production (position-aware).
 * - `trackerAdvisoryNoise`  — excluded from tracking's changed-not-claimed
 *                             ADVISORY wherever it appears. NEVER applied to
 *                             claimedNotChanged (the false-green killer).
 * - `internalRuntimeClaim`  — claim-exempt: git-untrackable runtime artifacts
 *                             a claim may legitimately name (tracking).
 */

export interface HarnessFileRole {
	/** RED write-boundary exemption, wherever the basename appears. */
	redBoundaryAnywhere?: boolean;
	/** RED write-boundary exemption, only under docs/specifications/. */
	redBoundarySpecScoped?: boolean;
	/** Tracking changed-not-claimed ADVISORY noise filter, wherever it appears. */
	trackerAdvisoryNoise?: boolean;
	/** Claim-exempt for git-untrackable runtime artifacts. */
	internalRuntimeClaim?: boolean;
	/** helpers.ts verify write-boundary / merge-verify exemption set: names the
	 *  harness writes INSIDE the run's spec directory (a same-named file
	 *  elsewhere is NOT exempt — position-aware, checked at the consumer). */
	specDirBookkeeping?: boolean;
	/** Phase commits never ride these basenames (per-attempt scratch, not
	 *  durable phase evidence — implementation.ts deterministic committer). */
	phaseCommitExcluded?: boolean;
}

export const HARNESS_FILE_ROLES: Record<string, HarnessFileRole> = {
	// ── RED-boundary, any path (run-owned evidence/scratch written mid-RED) ──
	"implementation-evidence.jsonl": { redBoundaryAnywhere: true, trackerAdvisoryNoise: true, specDirBookkeeping: true },
	"change-tracker.jsonl": { redBoundaryAnywhere: true, trackerAdvisoryNoise: true, specDirBookkeeping: true },
	".resume-cache.jsonl": { redBoundaryAnywhere: true, internalRuntimeClaim: true, specDirBookkeeping: true },
	".run-lock": { internalRuntimeClaim: true, specDirBookkeeping: true },
	".user-notes.json": { redBoundaryAnywhere: true, trackerAdvisoryNoise: true },
	".judge.jsonl": { redBoundaryAnywhere: true, trackerAdvisoryNoise: true, specDirBookkeeping: true, phaseCommitExcluded: true },
	".knowledge.json": { trackerAdvisoryNoise: true, specDirBookkeeping: true },
	"test-runner.json": { redBoundaryAnywhere: true, specDirBookkeeping: true, phaseCommitExcluded: true },
	"stagnation-report.md": { redBoundaryAnywhere: true },
	"escalation-report.md": { redBoundaryAnywhere: true, trackerAdvisoryNoise: true },
	"escalation-report-stagnation.md": { redBoundaryAnywhere: true },
	"api-test-report.md": { redBoundaryAnywhere: true },
	"ui-test-report.md": { redBoundaryAnywhere: true },

	// ── RED-boundary, SPEC-SCOPED only (ledgers the run appends inside the
	//    spec dir mid-RED). Deliberately narrower than the tracker role: a
	//    production file with the same basename OUTSIDE docs/specifications/
	//    stays flagged for RED (position-aware — pinned by tests). Note
	//    events.jsonl is ALSO trackerAdvisoryNoise-anywhere: the tracker
	//    advisory filter has no position semantics of its own for this name.
	"events.jsonl": { redBoundarySpecScoped: true, trackerAdvisoryNoise: true, specDirBookkeeping: true },
	"run-metrics.jsonl": { redBoundarySpecScoped: true },
	"audit.jsonl": { redBoundarySpecScoped: true },
	"routing-journal.jsonl": { redBoundarySpecScoped: true },
	"routing-epoch.json": { redBoundarySpecScoped: true },
	"replan-requests.json": { redBoundarySpecScoped: true },
	"artifact-revisions.json": { redBoundarySpecScoped: true },
	"completion-audit.md": { redBoundarySpecScoped: true, specDirBookkeeping: true },
	// v0.3.75 W1 usage-attribution artifacts. Dual-review BLOCKER (both
	// reviewers, independent): shipping these WITHOUT registry entries
	// regressed the exact M6 class this registry exists to kill — merge-verify
	// flagged its own ledger (every merged run downgraded to PARTIAL: tracked-
	// modified usage-calls.jsonl is not exempt) and the RED boundary read the
	// per-call engine appends as production writes (polluted-red retries /
	// wasted boundary-evaluator dispatches — the events.jsonl incident shape).
	// Parity: usage-calls.jsonl == events.jsonl (per-call append mid-RED,
	// tracker advisory noise anywhere); usage-report.md == completion-audit.md
	// (close-out render only).
	"usage-calls.jsonl": { redBoundarySpecScoped: true, trackerAdvisoryNoise: true, specDirBookkeeping: true },
	"usage-report.md": { redBoundarySpecScoped: true, specDirBookkeeping: true },
	".convergence-ledger.json": { specDirBookkeeping: true },
};

/** Derive the basename set for one role — the ONLY way consumers build sets. */
export function harnessBasenames(role: keyof HarnessFileRole): Set<string> {
	const out = new Set<string>();
	for (const [name, roles] of Object.entries(HARNESS_FILE_ROLES)) {
		if (roles[role]) out.add(name);
	}
	return out;
}
