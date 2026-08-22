# Whole-Codebase Round-3 Sweep — Findings Dossier (post v0.3.10)

Status: consolidated (remediation in progress — see docs/requirements/codebase-sweep-3-v0.3.11.md)

**Source:** 12 reviewer agents (6 domains × code-reviewer/adversarial-reviewer), spawned fresh-context on main @ 4c97dbe1 (v0.3.10), raw verdicts at /tmp/sdsweep3/all-verdicts.json. **110 raw findings → 45 canonical groups.** Every group below was independently re-verified in code by the parent session (anchors cited per group in the plan doc). Groups are ordered blocker → high → medium → low; each fix lands under v0.3.11 with RED-first tests unless explicitly dispositioned.

## BLOCKER

| G | Title | Sources | Verified evidence |
|---|-------|---------|-------------------|
| G1 | Go RED oracle passes raw FILE targets to `go test` — in-package tests can never confirm RED nor reach GREEN | D-code IMPL-1 | gates.ts:1636 `["go","test",...targets]`; live probe: `go test pkg/prod_test.go` builds synthetic `command-line-arguments` package — test referencing a DEFINED symbol still fails `undefined` (GREEN unreachable), while `go test ./pkg` passes. `goPackageArg()` helper exists (~:1656) but the go branch never uses it. |

## HIGH

| G | Title | Sources | Verified evidence |
|---|-------|---------|-------------------|
| G2 | Outer verification-convergence boundary (deferred route-back throw + blocked-on-decisions) is not replay-guarded | E-code E-1 | verify.ts:1364-1388 runs per attempt on REPLAYED review results (memoized cache-hit reviews reproduce deferredFindings); v0.3.10's reviewReplayArms guards only the inner signature classifier (:1015-1085). Walker journal re-check bounds the jump; the human boundary has no such bound. |
| G3 | Run-status derivation is ever-failed: a converged-after-failure run can never be `success` | A-code CORE-2 | workflow.ts:599-607 first-failure dedupe over ctx.results; :659 requires failedStages empty for success; convergence loops record per-round results (task() per round). |
| G4 | "Retry with guidance" performs undisclosed `git reset --hard` + `git clean -fd` — the user's LIVE CHECKOUT when skipWorktree | A-code CORE-1 | escalation.ts:91-105 → tracking.ts:200-218; live sites nodes.ts:542, artifact-convergence.ts:685/721, verify.ts:1175, implementation.ts:1553/2532. Excludes only spec-dir artifacts. |
| G5 | All build-gate/RED-oracle/test-lister spawns use Node default 1MB maxBuffer | D-code IMPL-2 | gates.ts:371/725/1655/2100 spawnSync without maxBuffer; 64MB precedent at setup.ts:687. ENOBUFS → unknown/stall. |
| G6 | setup.defaultBranch never reaches touchedFilePaths — scoping degrades to untracked-only on non-main repos | D-code IMPL-3, D-adv IMPLGATES-2 | scope.ts:77 `baseRef ?? env ?? "main"`; runBuildGate gets opts.defaultBranch (gates.ts:779) but classifyOutOfScopeNpmErrors (:804) and moduleBuildPlans (:467) call touchedFilePaths(cwd) bare. |
| G7 | json-fallback corrective respawn drops taskFile and re-checks nothing — retry argv re-enters the EDR kill class | B-adv SPAWN-1 | pi-spawn.ts:626-637: retryOpts spreads opts (taskFile not recomputed for the LONGER corrective prompt). |
| G8 | git-exclude guard for harness bookkeeping is dead unless env files were copied — `git add -A` commits .run-lock/.resume-cache/ledger | B-code DOMB-1, B-adv SETUP-1 | setup.ts:100 `if (copiedRelPaths.length===0) return;` gates the whole exclude write incl. .run-lock/.convergence-ledger.json (:115-119). |
| G9 | Absent buildGate is a vacuous pass: run can be `success` with zero deterministic build verification and close-out skipped | A-adv CORE-1 | workflow.ts:107 `const build = s.buildGate as {pass?:boolean}` — undefined.buildGate sails through `hardGateFailed` checks; stages/index.ts:52-70 runs preMergeBuild only later. |
| G10 | updateStats runs twice per run and re-reads the module-global audit path after the reflection await — double-counts runs, misattributes audits across overlapping runs | F-adv F-1, F-code RENDER-1 | reflection.ts (AC-29 claim vs two call sites; path read after await). |
| G11 | Audit-documented RED/build-gate defects remain unfixed while the audit doc claims implemented | D-adv IMPLGATES-1 | repo-wide-pipeline-blocker-audit.md header "Status: implemented" vs B-1 (stem restriction absent — resolveIntegrationStems accepts any existing path), B-2 (runRedCheck never calls resolveCargoPackageNames), B-5 (moduleBuildPlans returns [] when root lacks scripts — vacuous green), B-7 (npmRedCheckPlans fallback spawns bare `vitest` without pm-exec), B-3 (root go multi-dir file targets). |

## MEDIUM

| G | Title | Sources |
|---|-------|---------|
| G12 | tolerantMatch one-letter-alias relaxation unanchored — any pattern containing `h.` silently widened | D-code IMPL-4, D-adv IMPLGATES-3 |
| G13 | stripCommentsAndBlanks strips `#` lines for ALL code files — Rust `#[attr]`, C `#include`, JS `#private` invisible to deliverable matching | D-adv IMPLGATES-4, E-code E-2 |
| G14 | buildUiTestPrompt labels the implementation plan/spec as "BDD Scenarios"; integration prompt headers UI failures under "API Test Failures" | E-code E-3, E-adv E-7 |
| G15 | Judge budgets process-scoped, never reset per run — INV-3 bleeds across in-process replan auto-resumes | C-code CONV-1, C-adv C-1 |
| G16 | Prior-run 'addressed' residue re-injection drops blocking flag (addressed stays blocking until verified) | C-code CONV-3 |
| G17 | J10-c convergence-cap judge wired only in artifact-convergence; spec-convergence cap fatal undiagnosable | C-code CONV-4, C-adv C-2 |
| G18 | Convergence-loop skeleton duplicated artifact/spec — drift already visible | C-code CONV-5 |
| G19 | replan.resumed / route.taken / route.declined events use runId=specIdentifier — INV-L4/L5 violated | A-code CORE-3, A-adv CORE-3 |
| G20 | task() emits terminal stage events without stage.started on skip/budget paths — INV-L6 checker fails | A-adv CORE-4 |
| G21 | writerTask records ok with empty control on agent error — ungated writers (debug/assessment/docs) fail silently green | A-adv CORE-5, A-code CORE-4 |
| G22 | success-status run can carry live __stagnated marker — ✅ + ⚠ printed together, HITL prompts on completed run | A-adv CORE-2 |
| G23 | duty restatement shield fingerprints RAW ownerStage — alias spellings de-fang blockers | C-code CONV-2 |
| G24 | json-fallback corrective respawn embeds prior assistant output unfenced (AC-31 hole) | B-code DOMB-2, B-adv SPAWN-2 |
| G25 | Referenced-spec re-entry strands track: stale .complete never cleared; worktree-layout specs unreferencable | B-code DOMB-3 |
| G26 | Bare model-id override silently dropped by session backend; start log misreports | B-code DOMB-4 |
| G27 | findResumableSpec discards layout; specDirFor prefers worktree unconditionally — cross-layout resume loads wrong cache | B-adv RESUME-1 |
| G28 | PARTITION_INPUT_CAP drops pinned sticky lifecycle lines on >4000-line runs (comment claims never) | F-adv F-2, F-code RENDER-5 |
| G29 | Scenario-id parity: render schemas accept free-form ids/refs the deterministic gates reject (AC-27 class, un-fixed for scenarios); coverage exact-match false Uncovered | F-adv F-3/F-4, F-code RENDER-3 |
| G30 | ImplementationSummaryData.allGreen/phasesCompleted still String-only — boolean-drift class drops docs | F-adv F-5 |
| G31 | Non-atomic JSON persistence: torn write resets .knowledge.json/.user-notes.json to empty | F-adv F-6 |
| G32 | bumpOwnerRevision swallows write failures — walker decline guard can never fire | C-adv C-5 |
| G33 | J10-a/J10-b stagnation judge wired only into production-dead legacy reviewLoopUntil | E-adv E-1 |
| G34 | Stage-10 cross-stage routing depends on ownerStage, which no reviewer prompt requests | E-adv E-2 |
| G35 | blocked-on-decisions human boundary leaves no convergence-ledger record; terminal attempt unmarked | E-code E-4 |
| G36 | Replan/route-back fingerprint omits detail+owner — distinct blockers deduped | C-adv C-3 |
| G37 | Router 'ONE vocabulary' half-unwired; its high-severity regex forked from shared HIGH_SEVERITY_RE | C-adv C-4 |
| G38 | edges.ts drift tripwires pin only 11/30 edges | A-adv CORE-6 |
| G39 | Duplicated Go FAIL-line parsers diverged (scope.ts keeps the documented-buggy \s+ form) | D-adv IMPLGATES-5 |
| G40 | classifyFileSubjects infers regression from partially-unparsed baseline output on non-vitest fallback | D-adv IMPLGATES-9 |
| G41 | G4 guidance-reentry machinery vestigial; "this stop is terminal" log now false | D-code IMPL-5 |
| G43 | escalation-report: budget-exhausted blockers write no report; fixed filename overwritten per blocker | F-code RENDER-2 |
| G44 | RED boundary deterministically false-allows any path containing token 'spec'/'specs' | F-code RENDER-4 |

## LOW / INFO (fix in-pass where mechanical; else disposition in plan doc)

G45 duplicated template-loading + dead renderFile (F RENDER-6); G46 unwired dashboard machinery (F RENDER-7); plus the per-domain lows recorded in /tmp/sdsweep3/all-verdicts.json: runlog torn-line unparseable (A CORE-5), completion-audit merge boolean (A CORE-6), backend default doc (A CORE-7), safety denylist rm -rf /usr (A CORE-8), revise-manually collapse (A CORE-9), lock fd leak (B SETUP-2), lock TOCTOU (B SETUP-3), reuse banner dishonest (B SETUP-4), dead extension-resolution (B SPAWN-3), O(n²) resume append (B RESUME-2), notes 0644 (B NOTES-1), route-declined misattribution (C CONV-6), judge event stage misattribution (C CONV-7), rollback commit:null (C CONV-8), edge-budget invariant (C CONV-9), walker literal (C CONV-10), baseline worktree leak (D IMPLGATES-6), gitStatusPaths quotepath (D IMPLGATES-7), dead convergenceBlockReason (D IMPLGATES-8), depBootstrapCache (D IMPL-6), crate-marker regex drift (D IMPL-7), task-budget staleness (E E-4), dead gate helpers (E E-5), requirements ≥1 vs ≥2 AC (E E-6), legacy trio drift (E E-8), RENDER-8 classifyLine prose (accepted).
