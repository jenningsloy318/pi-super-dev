# Codebase Sweep-3 Remediation — v0.3.11

Status: implemented (this commit — v0.3.11)

"> **Completion record:** BLOCKER+HIGH groups G1-G11 all fixed. MEDIUM: G12, G13, G14, G15, G16, G17, G19, G20, G21(CR-1-corrected to record-not-throw), G23(with CR-3 alias map), G24, G26, G28, G30(ingest side), G31, G32, G35, G36, G37, G39, G40, G41, G43 fixed; G18 (skeleton dedup), G25/G27 (resume-layout edges), G29 (scenario-id schema parity — gates stay the authority), G33 (legacy judge wiring), G38 (tripwire coverage — CI-only) dispositioned documented. LOWs fixed in-pass: SETUP-2 lock fd, A-CORE-7 backend doc, E-E6 ≥2 AC, SETUP-4 banner honesty; the rest of the LOWs documented in the dossier. NEW tests: sweep3-phase1/2/3 (G1-G13/G44 pinned RED-first); later phases rely on the full existing suite + reviewer verification (no per-phase RED suites — an honest gap this record acknowledges). Final: tsc clean, 172 files / 2766 tests green. Round-2 dual review (code CR-1..11, adversarial AR1/AR2) remediated: G35 terminal marker + non-blocking row, G21 record-not-throw, G39 scope parser, G6 full threading (cargo tiers, red-check, re-gate), G23 alias map, CR-7 bookkeeping reset, AR2-4 statusReasons surfaced, AR1-5 replay build skip, AR2-5 spec cap-judge scope, CR-8 strict-positive both branches. Dispositioned no-change: CR-9 (fingerprint migration — stale rows age out; documented), AR2-6 (residual maxBuffer in non-gate paths — follow-up), CR-10 folded into G35 fix.

**Input:** docs/requirements/sweep3-findings-dossier.md (12 reviewer agents, 110 findings, 45 canonical groups G1-G46, every fix-group independently re-verified in code by the parent).
**Scope decision (user):** the tail (docs/preMergeBuild/cleanup/merge/merge-verify) stays fail-closed — no loops, no route-back added there. Everything else is fixed under the established process (RED-first tests → implement → dual review → commit). G9 is fixed as a *status-derivation* fix (absent buildGate must not be vacuous success) — that is tail-adjacent honesty, not a tail loop.

## Phase plan (dependency order)

### Phase 1 — Escalation safety & run-status honesty
- **G4** applyRetryDecision's rollback must NEVER run against the main checkout: when `worktreePath` is absent or equals the cwd (skipWorktree), log-and-skip the rollback (guidance still persists). RED: retry-with-guidance on skipWorktree run leaves working tree untouched.
- **G3** workflow.ts failedStages becomes LAST-status-per-stage: later success of the same stage id replaces the failure. RED: a stage that fails then converges derives success.
- **G9** `success` requires an AFFIRMATIVE buildGate (pass===true); absent buildGate downgrades to partial with an honest reason. RED: no buildGate → not success.
- **G22** __stagnated marker is cleared/ignored once the run ends success; formatSummary never prints ✅+⚠ together.

### Phase 2 — RED oracle & build-gate correctness (gates.ts/scope.ts/detect.ts)
- **G1 (blocker)** go branch: map targets → package dirs via the existing `goPackageArg` (dedupe); root-only when no dir. RED: probe fixture — file-target GREEN reference resolves via package form.
- **G11-B2** rust fallback resolves `-p` names via resolveCargoPackageNames.
- **G11-B1** resolveIntegrationStems restricted to targets under a `tests/` dir of a cargo package (else scoped `-p` fallback).
- **G11-B7** npmRedCheckPlans root fallback uses pmExec for vitest (never bare `vitest`).
- **G11-B5** moduleBuildPlans no longer suppressed by root-scripts absence (nested plans run when manifests exist).
- **G5** all gate-side spawnSync get maxBuffer 64MB (match setup.ts precedent).
- **G12** tolerantMatch alias relaxation anchored to a real alias form (`\bh\.[A-Za-z]`).
- **G13** stripCommentsAndBlanks strips `#` lines ONLY for #comment languages (py/ruby/sh/yaml/toml); Rust/C/JS keep `#` lines.
- **G39** Go FAIL-line parsers unified on the baseline.ts fixed form.
- **G44** RED boundary spec-token allow narrowed to real spec-dir path shapes.

### Phase 3 — Scoping plumbing
- **G6** runBuildGate threads `defaultBranch` into every touchedFilePaths consumer (classifyOutOfScopeNpmErrors, moduleBuildPlans, projectDirsFromEvidence callers). RED: repo whose default branch is not main → touched set includes committed diff.
- **G40** classifyFileSubjects regression inference only on parsed vitest/jest output (fallback runs raw subject comparison only).

### Phase 4 — Verify boundary (verify.ts)
- **G2** the outer verification-convergence deferred boundary (inline route-back + blocked-on-decisions) is gated on fresh evidence: a replayed review result (memoized cache-hit) may not arm the throw/marker — same arms discipline as the inner classifier (reviewReplayArms family; exportable).
- **G35** blocked-on-decisions writes a convergence-ledger record (kind blocked-on-decisions, non-blocking, verified=false) and marks the attempt terminal in __verificationAttempts.
- **G33** J10-a/J10-b stagnation judges fire on the WIRED convergence nodes (both review and verify), not only legacy reviewLoopUntil.
- **G34** Stage-10 reviewer prompts (buildReviewerPrompt family) request ownerStage for cross-stage findings (prompt contract matches router contract).

### Phase 5 — Routing & convergence machinery
- **G15** resetJudgeBudgets called at run start (runPipelineTask entry / workflow run begin) — budgets are per-run.
- **G16** addressed-residue re-injection preserves blocking until verified (normalizeFinding: addressed ⇒ keep blocking=true).
- **G17** spec-convergence cap path calls the J10-c judge (same wiring as artifact-convergence).
- **G19** replan/route run events carry the RUN id (run dir), not specIdentifier.
- **G23** duty shield fingerprint normalizes ownerStage (lowercase/trim/alias map to canonical stage ids).
- **G36** replan fingerprint includes detail hash + owner.
- **G37** router's high-severity scan imports the shared HIGH_SEVERITY_RE; the ONE-vocabulary layer fully wired or deleted.
- **G32** bumpOwnerRevision returns/throws on write failure so the walker decline guard can fire.

### Phase 6 — Spawn / resume / setup
- **G7** corrective respawn recomputes the taskFile when the corrective prompt exceeds TASK_ARG_LIMIT (and reuses the same temp dir).
- **G8** harness-bookkeeping excludes (.run-lock, .convergence-ledger.json) are written to info/exclude UNCONDITIONALLY (not only when env files were copied).
- **G24** corrective prompt fences prior assistant output (DATA_FENCE_PREAMBLE discipline).
- **G25** referenced-spec re-entry clears a stale .complete marker; referenced spec dirs resolve across worktree/in-place layouts.
- **G26** session backend honors bare model-id override (warn when dropped is impossible now).
- **G27** findResumableSpec returns the winning layout and specDirFor respects it.

### Phase 7 — Render / observability
- **G10** updateStats runs exactly once per run; audit path captured before the reflection await.
- **G28** PARTITION_INPUT_CAP never drops pinned sticky lifecycle lines (cap applies to non-pinned only; comment updated to match).
- **G29** render schemas pin scenario ids/refs to the same ^SCENARIO-\d{3,}$ family the gates enforce; coverage matching normalizes zero-pad.
- **G30** ImplementationSummaryData.allGreen/phasesCompleted become booleans (tolerant string ingest, boolean emit).
- **G31** .knowledge.json/.user-notes.json writes are atomic (tmp+rename).
- **G43** escalation-report: budget-exhausted path writes a report; filename carries the blocker kind (last-wins → per-kind).

### Phase 8 — Structural dedup + in-pass lows + release
- **G18** convergence skeleton dedup: specConvergenceNode reuses artifactConvergenceNode with spec-specific options (validator/judge/trace hooks) — behavior-pinned by existing suites.
- Lows fixed in-pass: A CORE-5 torn runlog line, A CORE-7 backend default doc, B SETUP-2 lock fd close, B SETUP-4 reuse banner honesty, C CONV-6 declined-fatal wording, C CONV-7 judge event stage, D IMPLGATES-7 gitStatusPaths quotepath=false, D IMPLGATES-8 remove dead convergenceBlockReason reader or wire it, E E-6 requirements ≥2 AC fallback parity.
- Dispositioned (no change): G38 tripwire coverage (extend to all 30 edges in a follow-up — CI-only surface), B RESUME-2 O(n²) (bounded by cache size in practice), B NOTES-1 mode (single-user host), remaining lows/info documented in the dossier.
- Release: version 0.3.11 across src/version.ts, package.json (2-space), package-lock.json, tests/version.test.ts, docs/ARCHITECTURE.md regenerate, CHANGELOG Unreleased bullet.

## Verification
- Per phase: new tests RED-first (fail on pre-fix code, pass after), tsc --noEmit clean, phase suite green.
- Final: full vitest suite, dual code-reviewer + adversarial-reviewer on the change set, remediate, commit under generating-commit-messages skill.

## Review outcome

**Round 1** (12 agents over 6 domains; 110 findings → 45 groups): every blocker+high group fixed before round 2; verdicts Changes Requested ×11, CONTEST ×1.

**Round 2 dual** (code CR-1..11, adversarial AR1/AR2 — both Changes Requested/CONTEST): all confirmed findings remediated — G21 corrected to record-not-throw, G35 terminal marker + persisted non-blocking ledger row, G39 parser, G6 full threading (cargo tiers, RED oracle, re-gate, deliverablesAlreadyMet), G23 exact-mirror alias map, CR-7 pathspec-glob bookkeeping reset (empirically verified unstaging nested spec-dir files), AR2-4 statusReasons surfaced on RunSummary + close-out log, AR1-5 replay build-skip, AR2-5 spec cap-judge scope, CR-R2-6 metadata maxBuffer, CR-R2-7 no-op-check scoping, CR-R2-3 same-id ok-row masking guard, CR-R2-5 real phase-3 tests (G39 false-capture pin + G6 plumbing). CR-8 rescoped to the pinned partial-match contract (in-code note). Dispositioned no-change: CR-9/AR2-6 residual (documented), CRR2-3 write-only terminal marker (reader lands with the resume work), AR2-2 folded into the persistence fix.

**Final gates:** tsc --noEmit clean; 172 files / 2768 tests green (+2 over round 2).
