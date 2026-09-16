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
 * - `neverGitTracked`       — v0.4.3: MUST never be git-tracked inside a
 *                             worktree. super-dev's own git machinery resets
 *                             tracked files (`deterministicPhaseCommit`'s
 *                             `git add -A` snapshots them; the checkpoint
 *                             rollback's `git reset --hard` restores their
 *                             committed content), so a tracked ledger is a
 *                             silently truncated ledger — run
 *                             2026-09-15T08-13-05-056Z lost the prototype
 *                             round + phases-02..05 resume rows exactly this
 *                             way. Setup untracks + info/exclude-ignores
 *                             every basename carrying this flag (worktree
 *                             runs only; in-place runs warn and mutate
 *                             nothing). Rendered *.md reports are DELIBERATELY
 *                             not flagged: they re-render from cached controls
 *                             on every replay, and riding the phase commits
 *                             keeps the human-readable evidence trail.
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
	/** helpers.ts verify write-boundary / merge-verify exclusion set: names the
	 *  harness writes INSIDE the run's spec directory (a same-named file
	 *  elsewhere is NOT exempt — position-aware, checked at the consumer). */
	specDirBookkeeping?: boolean;
	/** v0.4.3: setup untracks + git-ignores this basename (worktree runs) —
	 *  see the role semantics above. Consumers: runtime-state-git.ts
	 *  (untrack+ignore), implementation.ts deterministicPhaseCommit
	 *  (defense-in-depth commit exclusion). */
	neverGitTracked?: boolean;
	/** 063 S1 (D-S-C): the basename's DURABLE home is the EXTERNAL state root
	 *  (~/.super-dev/state/<project-key>/<spec-id>/) — the neverGitTracked
	 *  UNION contract is unchanged in S1 (the fail-closed in-spec fallback and
	 *  the H4 contained-geometry case still need in-tree exclusion); S2
	 *  derives the exclusion set from stateExternal ∪ renderedReport and the
	 *  membership shrinks to the residual in-tree set. */
	stateExternal?: boolean;
	/** 063 S1 (D-S-C): rendered report that stays IN-TREE (content/evidence,
	 *  DEC-4) — the residual exclusion set once S2 completes the split. */
	renderedReport?: boolean;
	/** Phase commits never ride these basenames (per-attempt scratch, not
	 *  durable phase evidence — implementation.ts deterministic committer). */
	phaseCommitExcluded?: boolean;
}

export const HARNESS_FILE_ROLES: Record<string, HarnessFileRole> = {
	// ── RED-boundary, any path (run-owned evidence/scratch written mid-RED) ──
	"implementation-evidence.jsonl": { redBoundaryAnywhere: true, trackerAdvisoryNoise: true, specDirBookkeeping: true, neverGitTracked: true },
	"change-tracker.jsonl": { redBoundaryAnywhere: true, trackerAdvisoryNoise: true, specDirBookkeeping: true, neverGitTracked: true },
	".resume-cache.jsonl": { redBoundaryAnywhere: true, internalRuntimeClaim: true, specDirBookkeeping: true, neverGitTracked: true, stateExternal: true },
	".run-lock": { internalRuntimeClaim: true, specDirBookkeeping: true, neverGitTracked: true, stateExternal: true },
	".task": { specDirBookkeeping: true, neverGitTracked: true },
	".complete": { specDirBookkeeping: true, neverGitTracked: true },
	".user-notes.json": { redBoundaryAnywhere: true, trackerAdvisoryNoise: true, neverGitTracked: true },
	".judge.jsonl": { redBoundaryAnywhere: true, trackerAdvisoryNoise: true, specDirBookkeeping: true, phaseCommitExcluded: true, neverGitTracked: true },
	".knowledge.json": { trackerAdvisoryNoise: true, specDirBookkeeping: true, neverGitTracked: true },
	"test-runner.json": { redBoundaryAnywhere: true, specDirBookkeeping: true, phaseCommitExcluded: true, neverGitTracked: true },
	"stagnation-report.md": { redBoundaryAnywhere: true, renderedReport: true },
	"escalation-report.md": { redBoundaryAnywhere: true, trackerAdvisoryNoise: true, renderedReport: true },
	"escalation-report-stagnation.md": { redBoundaryAnywhere: true, renderedReport: true },
	"api-test-report.md": { redBoundaryAnywhere: true },
	"ui-test-report.md": { redBoundaryAnywhere: true },

	// ── RED-boundary, SPEC-SCOPED only (ledgers the run appends inside the
	//    spec dir mid-RED). Deliberately narrower than the tracker role: a
	//    production file with the same basename OUTSIDE docs/specifications/
	//    stays flagged for RED (position-aware — pinned by tests). Note
	//    events.jsonl is ALSO trackerAdvisoryNoise-anywhere: the tracker
	//    advisory filter has no position semantics of its own for this name.
	"events.jsonl": { redBoundarySpecScoped: true, trackerAdvisoryNoise: true, specDirBookkeeping: true, neverGitTracked: true },
	"run-metrics.jsonl": { redBoundarySpecScoped: true, neverGitTracked: true },
	"audit.jsonl": { redBoundarySpecScoped: true, neverGitTracked: true },
	"routing-journal.jsonl": { redBoundarySpecScoped: true, neverGitTracked: true },
	"routing-epoch.json": { redBoundarySpecScoped: true, neverGitTracked: true },
	"replan-requests.json": { redBoundarySpecScoped: true, neverGitTracked: true },
	".replan.jsonl": { redBoundarySpecScoped: true, neverGitTracked: true },
	"artifact-revisions.json": { redBoundarySpecScoped: true, neverGitTracked: true },
	"completion-audit.md": { redBoundarySpecScoped: true, specDirBookkeeping: true , renderedReport: true },
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
	"usage-calls.jsonl": { redBoundarySpecScoped: true, trackerAdvisoryNoise: true, specDirBookkeeping: true, neverGitTracked: true },
	"usage-report.md": { redBoundarySpecScoped: true, specDirBookkeeping: true , renderedReport: true },
	// P2 (v0.3.90, D5): the eval-stage run report — usage-report.md parity
	// (close-out render only, inside the spec dir; the dataset rows live
	// user-local under ~/.super-dev/evals/, never in the repo worktree).
	"eval-report.md": { redBoundarySpecScoped: true, specDirBookkeeping: true , renderedReport: true },
	// v0.3.76 L2: per-call tool-tick telemetry (events.jsonl parity — appended
	// mid-RED on every delegation update tick).
	"tool-usage.jsonl": { redBoundarySpecScoped: true, trackerAdvisoryNoise: true, specDirBookkeeping: true, neverGitTracked: true },
	// v0.3.85 F2/F4: the inherited-red ladder's append-only tally/audit ledger
	// (events.jsonl parity — engine-appended inside the spec dir at phase
	// boundaries and handoffs; rides phase commits as durable evidence).
	// v0.4.3: that "rides phase commits" convention is precisely what let the
	// checkpoint rollback revert it — neverGitTracked supersedes the old
	// comment (the ledger belongs to the RUN, not to the repo history).
	".inherited-red.jsonl": { redBoundarySpecScoped: true, trackerAdvisoryNoise: true, specDirBookkeeping: true, neverGitTracked: true },
	// v0.4.3: the environmental-fault ledger (fault-classification.ts, engine-
	// appended inside the spec dir — found unregistered in the
	// 2026-09-15T08-13-05-056Z sweep; events.jsonl parity + neverGitTracked).
	".environment-faults.jsonl": { redBoundarySpecScoped: true, trackerAdvisoryNoise: true, specDirBookkeeping: true, neverGitTracked: true },
	// v0.3.87 S4(b) (decision 9): the research-assist ledger — the NOVEL four-role
	// combo the v0.3.85 grill fold flagged (accuracy note: .judge.jsonl carries
	// redBoundaryAnywhere rather than SpecScoped; test-runner.json carries three
	// roles without trackerAdvisoryNoise). Appended engine-side inside the spec
	// dir mid-attempt (specDirBookkeeping + redBoundarySpecScoped +
	// trackerAdvisoryNoise), but it is PER-ATTEMPT SCRATCH, never durable phase
	// evidence — phaseCommitExcluded keeps it off the deterministic phase commit
	// (the .judge.jsonl/test-runner.json precedent).
	"research-assists.jsonl": { redBoundarySpecScoped: true, trackerAdvisoryNoise: true, specDirBookkeeping: true, phaseCommitExcluded: true, neverGitTracked: true },
	".convergence-ledger.json": { specDirBookkeeping: true, neverGitTracked: true },
	// v0.4.3: found unregistered in the 2026-09-15T08-13-05-056Z worktree —
	// engine-written but invisible to every role consumer. Registered here so
	// the untrack/ignore sweep covers them too (P6: one canonical registry).
	"messages.jsonl": { specDirBookkeeping: true, neverGitTracked: true },
};

/** Derive the basename set for one role — the ONLY way consumers build sets. */
export function harnessBasenames(role: keyof HarnessFileRole): Set<string> {
	const out = new Set<string>();
	for (const [name, roles] of Object.entries(HARNESS_FILE_ROLES)) {
		if (roles[role]) out.add(name);
	}
	return out;
}
