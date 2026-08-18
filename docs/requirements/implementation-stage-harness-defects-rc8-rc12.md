# Implementation-stage harness defects RC8–RC12 (mac runs 10-39 / 15-07)

Status: implemented (this commit — v0.2.2)

Analysis of the two macOS STEP E2E dashboard runs (v0.1.97) that reached
Stage 9 after the rethink docs fixed the content layer. Both died inside the
implementation stage on harness-level defects that remain in current main.

## Evidence table

| RC | Run | Observed | Root cause (current code) |
|----|-----|----------|---------------------------|
| RC8 | 10-39 phase-2 | Oracle said `red` every round; logs/judge read `red-not-confirmed: tests passed before implementation` | RED-review rejection force-sets `status:"green-weak-test"` (implementation.ts:1192,1196); `redEvidenceFailureReasons` prints a fixed false template and discards `e.reason` (:277) into the log, the judge context (:1231), and convergence findings |
| RC9 | 15-07 phase-1 | `missing pattern SCENARIO-00[1-9]` ×3 identical while the file contained SCENARIO-003..009 | `deliverableMatchText` matches code files comment-stripped (gates.ts:1697); Go test names cannot contain `-` so the tags were comments; buildTddPrompt explicitly told the author "in a test title, **a comment**, or a tag constant" is acceptable — prompt contract and deterministic gate contradict |
| RC10 | 10-39 phase-2 | Behavior-level tests referencing `MigrateStepE2E`/`models.StepProcess*` → `undefined:` compile errors → `broken` forever | `isGoGreenfieldBuildFailure` only accepts greenfield when the failing package dir is test-only (`goDirHasOnlyTestFiles`); cross-package/same-package missing symbols in an EXISTING package never qualify |
| RC11 | 10-39 phase-2 | Spec tasks demanded declaration observables ("must declare type X"); RED review demanded behavior tests ("persist rows and read back"); writer caught in an unsatisfiable oscillation | buildRedReviewPrompt has no task-contract precedence rule; reviewer standard overrides the spec's explicit contract with no code mechanism to reconcile |
| RC12 | both | Implementer edited unrelated files (auth-service type shims, snow, report) | Fresh worktree has no dependency install → whole-monorepo build fails on auth-service (`TS2307 better-auth`) → implementer "fixes" unrelated packages; nothing records out-of-scope edits |

The judge was correct in both runs ("oracle/pipeline classification conflict",
"harness/deliverable-check mismatch") — F4/v0.1.98 evidence verification worked;
the evidence itself lied (RC8) or the loop had no legal next action (RC9).

## Fix designs

### F8 — honest RED evidence statuses (RC8)
- New `RedEvidenceStatus` value `"review-weak"`. The two review-rejection paths
  (contradictions, not-strong) set it instead of `green-weak-test`.
- `redEvidenceFailureReasons`: `review-weak` → `red-review-rejected: <reason>`;
  `green-weak-test` now prefers `e.reason` (hollow-test case) over the fixed
  template; the canonical oracle-green reason is kept verbatim.
- Line-1291 restore check includes `review-weak` (review-rejected tests must
  still be reverted before re-authoring).
- The tdd-guide re-prompt already carried the true reviewer summary (the 1192/
  1196 overwrite); with the status split, the log, judge context, HITL
  escalation, and convergence ledger all read the same truth.

### F9 — deliverable comment-blindness (RC9)
- gates.ts contains-check: when the stripped match fails but the RAW text
  matches, emit `missing pattern … matched only inside comments — comments are
  stripped before matching; put the tag in a string literal or test title`
  (still a failure — the semantic gate is unchanged; the error becomes honest
  and actionable).
- buildTddPrompt requiredScenarios contract drops "a comment" and states
  explicitly that comments are stripped before matching.

### F10 — Go cross-module greenfield RED (RC10)
- Extend `isGoGreenfieldBuildFailure` with a third shape: all error lines are
  `undefined: <ref>` in `_test.go` files (dir not test-only) AND every
  referenced symbol has NO top-level declaration in any non-test `.go` file of
  the module → greenfield red. A typo'd reference to an EXISTING symbol still
  finds its declaration → stays `broken` (safe direction).
- Post-review hardening: QUALIFIED refs (`alias.Symbol`) count only when the
  failing test files import that alias from a path INSIDE the module
  (alias-guard; external-package symbols stay `broken`); the typo guard is a
  levenshtein≤2 near-miss against declared top-level names (length ≥ 5) —
  accepted trade-off: a genuinely new symbol within distance 2 of an existing
  name stays broken and surfaces as broken-test (safe direction).

### F11 — task-contract precedence in RED review (RC11)
- buildRedReviewPrompt gains a precedence rule: the phase's task rows and
  deliverables define the observable; when a task's observable is explicitly
  declaration/source-level, a test binding THAT declared observable is
  behavior-binding for the review — do not demand a different observable the
  task never states; report a contradiction only when the contract itself is
  unsatisfiable.
- buildTddPrompt mirrors it: match the test level to the task's stated
  observable.

### F12 — worktree hygiene (RC12)
- 12a: best-effort dependency bootstrap when a package-manager lockfile exists
  and the worktree root has no `node_modules` (pnpm/npm/yarn/bun, frozen
  lockfile, `--prefer-offline` where applicable; yarn classic vs Berry
  distinguished by `.yarnrc.yml`; 64MB maxBuffer). Kill-switch
  `SUPER_DEV_NO_BOOTSTRAP=1`; timeout `SUPER_DEV_BOOTSTRAP_TIMEOUT_MS`
  (default 600000). Failure logs a warning and never blocks. Known limitation
  (accepted): the sync install blocks the event loop for its duration and a
  timeout kills only the direct child — setup is deliberately synchronous/
  deterministic; the env knob bounds it.
- 12b: build-gate scoping to affected packages is OUT OF SCOPE (documented
  limitation — the whole-monorepo build stays the cross-regression oracle).
- 12c: GREEN-phase out-of-scope edit detection: worktree-dirty files outside
  the phase's SPEC-declared deliverable files (requireFiles + requireContains
  file entries — the implementer's OWN claims are deliberately NOT scope, so
  claiming a file cannot hide it) and outside this phase's RED test files
  (legitimately dirty during GREEN) are recorded as a low, non-blocking
  convergence finding (ownerStage implementation) and logged — observability,
  not a block. Porcelain rename entries take the NEW path; C-quoted paths are
  unquoted; bookkeeping paths (spec dir, .run-lock, internal runtime claims)
  are excluded.

## Verification
- tests/implementation-rc8-rc12.test.ts (17 tests, RED-first verified — 8 fail
  on the pre-fix tree): review-weak log/reason paths, green-weak back-compat,
  comment-only contains error (go + ts + absent-pattern fixtures), prompt
  contract lines (review + tdd), Go greenfield shape-3 (declared-nowhere →
  red; typo → broken; external package → broken; non-top-level usage → red),
  bootstrap log evidence + kill-switch, out-of-scope porcelain semantics
  (line split, RED-file exclusion, rename new-path, quoted paths, no blob).
- Full `tsc --noEmit` + `vitest run` (2362 tests, 150 files).
- Version bump 0.2.1 → 0.2.2 (src/version.ts, package.json,
  package-lock.json, tests/version.test.ts, docs/ARCHITECTURE.md regen) +
  CHANGELOG Unreleased Fixed bullet.

## Review outcome
Dual systematic review (code-reviewer + adversarial-reviewer, spawned
read-only on the diff). Both returned CHANGES REQUESTED; every blocking/high
and medium finding was remediated before commit:
- F-1 (both, ~0.98): porcelain parser split on a literal `\n` (python-heredoc
  escaping artifact) making the detector emit a garbage blob — fixed with a
  real newline split + a no-blob regression pin in the new test.
- F-2/F-3: RED test files flagged every healthy phase; implementer self-claims
  used as scope — scope basis is now spec-declared deliverables only, RED test
  files excluded, self-claims excluded.
- RC10 F-3/F-4: external-package undefined refs could classify greenfield —
  import-alias guard added (external → broken); near-miss typo trade-off
  documented.
- RC12a F-5/F-6: yarn classic got Berry flags (always failed) — classic/Berry
  distinguished; maxBuffer 64MB; sync-block limitation documented.
- Hygiene: package.json indentation churn reverted (1-line diff), CHANGELOG
  entry added, doc Verification section aligned with the real test inventory,
  RC8 reason literals de-duplicated via CANONICAL_GREEN_WEAK_REASON, RC11 WEAK
  definition reconciled with the precedence rule.
- Accepted/documented: levenshtein near-miss keeps genuinely-new near-named
  symbols broken (safe direction); bootstrap sync-block + child-kill scope;
  implementation-evidence.jsonl not extended with review-weak (pre-existing
  ordering, info-level).
