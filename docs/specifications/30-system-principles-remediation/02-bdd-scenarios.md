The document is saved to `docs/specifications/30-system-principles-remediation/02-bdd-scenarios.md` (31 scenarios, 14/14 ACs covered, bidirectional traceability complete). Returned verbatim below.

---

# BDD Scenarios — Fault-Classified Actuation, Signature Normalization & Reused-Worktree Isolation (Track 30)

**Source:** docs/specifications/30-system-principles-remediation/01-requirements.md (AC-01..AC-14; findings R-01..R-05 applied)
**Rules contract:** docs/specifications/30-system-principles-remediation/00-principles-and-rules.md (R-S1..R-S6, R-N1..R-N8)
**Run under analysis:** `~/.super-dev/runs/2026-08-18T01-02-50-093Z/run.log` (super-dev v0.2.1, 4h39m, cancelled phase 1/4 after 14 attempts)
**Date:** 2026-08-18

**Code observables referenced (grounding):** `BuildGateResult` shape incl. `outOfScopeErrors` / `inScopePass` / `baselineCheck` (src/build-runner/gates.ts:120-175); the synthetic `[baseline-verify] regression — …` block appended to `gate.errors` by `resolveInScopePassWithBaseline` (gates.ts:~546); the green branch `(gate.pass || gate.inScopePass) && deliverableCheck.pass && changeGate.pass && symbolGate.pass && tddOracleFailures.length === 0` and the `failureReasons` assembly (src/stages/implementation.ts:~1600-1900); `normalizeSignatureText` / `failureSignature` / `ProgressSignature` / `repeatedNoProgress` (implementation.ts:~60-130); `JUDGE_ROUTES` incl. `fix-environment` (src/stages/judge.ts:37) and its existing offer at `stage9.red-no-progress` (implementation.ts:~1298); the per-signature baseline memo + `clearBaselineCache` test hook (src/build-runner/baseline.ts:38-80); `reusedTrack` / `options.resumeSpecIdentifier` / `copiedEnvFiles` in `runSetup` (src/setup.ts:480-600); `HARNESS_BOOKKEEPING_FILES` = {events.jsonl, change-tracker.jsonl, implementation-evidence.jsonl, .resume-cache.jsonl, .judge.jsonl, .knowledge.json, .run-lock} and `isHarnessBookkeepingPath` (src/helpers.ts:523-546); kill-switch convention `SUPER_DEV_NO_SPEC_REUSE` / `SUPER_DEV_NO_BOOTSTRAP` (setup.ts:242, 604).

**Fixture provenance (SCENARIO-016/017):** snow failure texts are in-repo fixture replicas of run 01-02-50 — gate `FAIL; [baseline-verify] …` lines at run.log ~851, 944, 1019, 1089, 1194, 1276, 1366, 1461, 1535, 1603, 1697 (attempts 2–12) and the go-test output block at ~755-760 (`FAIL github.com/.../internal/services/snow 14.439s`, `ok … snow/odata 3.695s`, `ok … unittest (cached)`, `[resolve-team] … trackingID=<uuid> … duration=0.000s` JSON log lines, test `TestEnrichment_AreaCandidates_ClusterMatch_MatchType`). Replicas cover every AC-06 noise class; volatile values vary per attempt, discriminating constants (`internal/services/snow`, `TestEnrichment_AreaCandidates_ClusterMatch_MatchType`, `[baseline-verify] regression`, baseline `45b865ef`) are held fixed.

---

## Feature 1 — PRA: Deterministic fault classification before actuator selection

**SCENARIO-001 — Out-of-scope-only regression with green own-scope evidence classifies environmental-blocker** (AC-01 · P0)
- **Given** a GREEN-phase build-gate failure whose `BuildGateResult` has `pass=false`, `outOfScopeErrors.length > 0`, every `gate.errors` entry either an `outOfScopeErrors` member or the synthetic block beginning `[baseline-verify] regression — the failing out-of-scope subject(s) PASS at the merge-base baseline, so the failure is NEW on this branch:` (appended by `resolveInScopePassWithBaseline`), `baselineCheck.status === 'regression'`, and all own-scope evidence booleans green (deliverable-check pass, change-gate pass, symbol-gate pass, tdd-oracle clean)
- **When** the attempt loop classifies the failure before selecting an actuator
- **Then** the classifier — pure TypeScript over `BuildGateResult` + the own-scope booleans, no LLM in the classification floor — returns fault class `environmental-blocker` with legal actuators {quarantine+re-gate, judge} and never implementer re-spawn
- **And** the synthetic `[baseline-verify] …` block is excluded from the failure tally — it is not counted as a product failure

**SCENARIO-002 — Genuine in-scope or mixed failure classifies product-defect and keeps today's retry semantics** (AC-01 · P1)
- **Given** a gate failure where `gate.errors` contains at least one entry that is neither an `outOfScopeErrors` member nor the excluded `[baseline-verify]` synthetic block (a genuine in-scope or mixed failure) with own-scope evidence not green
- **When** the classifier runs
- **Then** the fault class is `product-defect` with legal actuator implementer-fix
- **And** retry semantics are unchanged from the pre-fix tree: the loop re-spawns the implementer with the existing `failureReasons` feedback (`…gate.errors` + missing deliverables + claimed-not-changed + hollow files + tdd-oracle failures) and the existing no-progress detector stays in force

**SCENARIO-003 — Absent baselineCheck never classifies environmental-blocker** (AC-01 · P2)
- **Given** a gate failure with `outOfScopeErrors.length > 0` but `baselineCheck` absent from the result (no baseline verification ran — e.g. gate green, partial out-of-scope, or no default branch) or own-scope evidence not green
- **When** the classifier runs
- **Then** the fault class is `unclassified`, never `environmental-blocker`
- **And** the attempt loop keeps today's semantics for this case (retry + no-progress detection), unchanged by this cycle

**SCENARIO-004 — Environmental blocker handling never increases the implementer's call count** (AC-02 · P0)
- **Given** an `implementation.test.ts`-style harness with stubbed `runBuildGate` seeded to return a regression verdict over out-of-scope-only errors (failing subject `internal/services/snow`, outside the phase's declared scope), `baselineCheck.status === 'regression'`, own-scope evidence green
- **When** the blocker is handled to completion (classification → quarantine+re-gate and/or judge routing)
- **Then** the implementer agent's call count does not increase across blocker handling (spawn count asserted equal before and after)
- **And** no attempt of the loop re-spawns the implementer for that cause

**SCENARIO-005 — Non-empty dirt inventory triggers scoped stash and EXACTLY ONE gate re-run** (AC-03 · P0)
- **Given** the environmental-blocker branch with a non-empty dirt inventory — a foreign tracked modification `internal/services/snow/enrichment.go` predating the phase
- **When** the branch handles the blocker
- **Then** a recoverable quarantine runs: scoped `git stash push -u -- internal/services/snow/enrichment.go` with a ledger record (per AC-12)
- **And** the build gate re-runs EXACTLY ONCE — the `runBuildGate` call count increases by exactly 1 for this blocker, never more
- **And** the re-run does not inherit a baseline verdict memoized against the pre-quarantine worktree (the baseline.ts per-signature memo is invalidated/bypassed for the re-run)

**SCENARIO-006 — Pre-quarantine baseline memo must not feed the post-quarantine re-run** (AC-03 · P0)
- **Given** the baseline verifier already returned `regression` for subjects {`internal/services/snow`} against merge-base on the pre-quarantine worktree, so that verdict sits in the baseline.ts memo cache (keyed per cwd/merge-base/language/sorted-subjects; `clearBaselineCache` exists as the test hook)
- **When** the single post-quarantine gate re-run evaluates the baseline status
- **Then** the memoized pre-quarantine verdict is NOT reused — the outcome reflects the post-quarantine worktree state, observable as: after the foreign snow edits are stashed the re-run's snow result flips (gate errors empty → `pass=true`, or an evidence-backed `inScopePass` with no `[baseline-verify]` regression strip)
- **And** a re-run that still fails does so on freshly computed evidence, never on the stale memo

**SCENARIO-007 — Passing or evidence-backed re-run proceeds green through the existing branch with no further spawns** (AC-03 · P1)
- **Given** the single post-quarantine gate re-run returns `pass=true` OR grants an evidence-backed `inScopePass` (e.g. `baselineCheck.status === 'preexisting'` for remaining out-of-scope failures) with own-scope evidence green
- **When** the loop evaluates phase acceptance
- **Then** the phase proceeds green through the existing `(gate.pass || gate.inScopePass) && deliverableCheck.pass && changeGate.pass && symbolGate.pass && tddOracleFailures.length === 0` branch
- **And** the loop breaks with the existing `Implementation <phaseId> GREEN on attempt N` / `IN-SCOPE GREEN on attempt N` log and no further implementer spawns occur for the phase

**SCENARIO-008 — Dirt inventory contains only genuinely foreign state** (AC-03 · P1)
- **Given** a worktree carrying, simultaneously: a foreign tracked modification `internal/services/snow/enrichment.go`; an untracked `notes.md` at the worktree root; a modified file under the spec-dir prefix `docs/specifications/<track>/…`; harness bookkeeping files inside the spec dir (members of `HARNESS_BOOKKEEPING_FILES`: events.jsonl, change-tracker.jsonl, implementation-evidence.jsonl, .resume-cache.jsonl, .judge.jsonl, .knowledge.json, .run-lock); an env file listed in the run's `copiedEnvFiles`; files within the phase's own declared scope; and the current attempt's change set (the implementer's CLAIMED files (filesCreated/filesModified) UNION the phase's declared scope; gitActual entries outside that set are RC12c-class dirt and ARE quarantineable)
- **When** the environmental-blocker branch computes the dirt inventory
- **Then** the quarantine pathspec contains exactly the foreign paths (`internal/services/snow/enrichment.go`, `notes.md`) — the spec-dir prefix, harness bookkeeping, copied env files, declared scope, and current-attempt change set are never included

**SCENARIO-009 — Current-attempt undeclared edits (RC12c class) count as dirt** (AC-03 · P2)
- **Given** the current attempt's implementer edited `internal/services/auth/handler.go` — a file outside the phase's declared scope that the attempt did not claim in filesCreated/filesModified (the RC12c class)
- **When** the dirt inventory is computed
- **Then** the undeclared edit counts as dirt — the inventory is non-empty and the quarantine+re-gate path proceeds for it

**SCENARIO-010 — No dirt routes to the judge at FIRST occurrence with both evidence packets** (AC-04 · P0)
- **Given** the environmental-blocker branch with an EMPTY dirt inventory (worktree clean of foreign state after exclusions)
- **When** the blocker is handled
- **Then** `runJudge` is invoked at FIRST occurrence with scope `stage9.impl-env-blocker.<phaseId>`
- **And** the judge context carries BOTH evidence packets: the gate failure tail plus the `baselineCheck` status/evidence plus the dirt inventory
- **And** `allowedRoutes` is exactly `["fix-environment"]` — the route already present in `JUDGE_ROUTES` (judge.ts:37) and already offered at `stage9.red-no-progress` (implementation.ts:~1298), here offered at its second boundary with escalate-now always implied
- **And** the judge context includes the one-line prior-fault count read from the track ledger (OQ-3 default)
- **And** never a second identical implementer spawn

**SCENARIO-011 — Still environmentally blocked after the single re-run routes to the judge, budget stays at one** (AC-04 · P1)
- **Given** dirt was quarantined and the EXACTLY-ONE gate re-run is still environmentally blocked (out-of-scope-only failures persist, `baselineCheck.status === 'regression'`, own-scope evidence green)
- **When** the blocker is handled
- **Then** the loop routes to `runJudge` (first judge occurrence for this blocker) with both evidence packets, including the post-re-run failure tail and the quarantine record
- **And** the one-gate-re-run budget stays at exactly 1 — no second automatic quarantine, no second gate re-run (OQ-1 default), and no second identical implementer spawn

**SCENARIO-012 — Unoffered or unverified judge route degrades to escalate** (AC-04 · P2)
- **Given** the judge at the environmental-blocker boundary returns a route that is unoffered or fails verification
- **When** the verdict is applied
- **Then** it degrades to escalate per the existing judge behavior, with escalate-now implied at this boundary
- **And** the HITL escalation surfaces carrying both evidence packets rather than retrying the implementer

**SCENARIO-013 — Environmental-blocker log lines name the fault class and the next action** (AC-05 · P1)
- **Given** an environmental-blocker classification with a non-empty dirt inventory
- **When** the branch logs
- **Then** a line containing `Implementation <phaseId> environmental-blocker: out-of-scope-only failures, baseline=regression, own-scope evidence green — class=environment; next=<quarantine+re-gate>` is emitted, asserted by substring in stage tests
- **And** for the no-dirt / still-blocked-after-re-run paths, the line ends `next=<judge: fix-environment/escalate>` (NFR-2: every new line follows the `class=…; next=…` action-naming pattern)

## Feature 2 — PRB: Normalized failure signatures and anti-windup

**SCENARIO-014 — normalizeSignatureText strips every volatile noise class before the existing collapse/trim/cap** (AC-06 · P0)
- **Given** failure texts containing every noise class: ISO-8601 timestamps with timezone and fractional seconds (`2026-08-18T10:11:42.496069+08:00`), without fractional seconds, and without timezone (`2026-08-18T10:11:42Z`, `2026-08-18 10:11:42`); UUIDs (`76debd8a-9e7c-45f2-9d3a-da1f8dae56f8`, `bc3831c9-9705-43ad-ac26-04c70142f21a`); durations matching `\d+(\.\d+)?(ms|s)\b` (`14.439s`, `3.695s`, `0.000s`, `423ms`); and `(cached)` / `[cached]` markers
- **When** `normalizeSignatureText` processes the texts
- **Then** all volatile noise is stripped BEFORE the existing whitespace-collapse/trim/800-char cap (today's implementation at implementation.ts:~73 performs only the collapse/trim/cap)

**SCENARIO-015 — Noise stripping precedes the 800-char cap so discriminating content survives** (AC-06 · P1)
- **Given** a failure text in which more than 800 characters of timestamps, UUIDs, and durations precede the discriminating content (failing package `internal/services/snow`, failing test `TestEnrichment_AreaCandidates_ClusterMatch_MatchType`, `[baseline-verify] regression`, baseline `45b865ef`)
- **When** the text is normalized
- **Then** the discriminating content remains within the 800-char cap — noise is displaced, never signal (the pre-fix whitespace-only normalizer would have truncated it away)

**SCENARIO-016 — Replaying the 11 identical snow failure texts yields ONE ProgressSignature** (AC-07 · P0)
- **Given** the 11 identical snow failure texts from run 01-02-50 replayed as in-repo fixture replicas (provenance noted in the header; each replica varies ONLY the AC-06 volatile noise — timestamps, UUIDs, durations, cached markers — while the discriminating constants are held fixed), e.g.:

```
backend-service: go test ./... FAILED (exit 1):
{"time":"2026-08-18T10:11:42.496069+08:00","level":"INFO","msg":"[resolve-team] completed trackingID=76debd8a-9e7c-45f2-9d3a-da1f8dae56f8 documentType=message total=2 resolved=1 notFound=1 duration=0.000s","service_name":"backend-service","hostname":"JV4MPQJ4M2"}
FAIL
FAIL	github.com/macotestdashboard/backend-service/internal/services/snow	14.439s
ok  	github.com/macotestdashboard/backend-service/internal/services/snow/odata	3.695s
ok  	github.com/macotestdashboard/backend-service/internal/services/unittest	(cached)
--- FAIL: TestEnrichment_AreaCandidates_ClusterMatch_MatchType (0.31s)
FAIL; [baseline-verify] regression — the failing out-of-scope subject(s) PASS at the merge-base baseline, so the failure is NEW on this branch: pnpm run test (whole suite) PASSES at baseline 45b865ef — the failure is new on this branch [cached]
```
- **When** each replayed attempt's `failureSignature(failureReasons)` is computed and pinned into a `ProgressSignature`
- **Then** ONE identical `ProgressSignature.failure` results across all 11 attempts AND `ProgressSignature.footprint` is constant across the replayed attempts (both components pinned)

**SCENARIO-017 — Second identical occurrence trips anti-windup; no third identical spawn** (AC-07 · P0)
- **Given** the replayed attempts produce identical normalized signatures and `attemptProgressHistory` already contains one entry with the same (`failure`, `footprint`)
- **When** `repeatedNoProgress(history, next)` is evaluated on the second occurrence
- **Then** it trips (the existing `history.some(…)` match) and the existing no-progress path fires: judge at scope `stage9.impl-no-progress.<phaseId>` and/or HITL escalation
- **And** no third identical implementer spawn occurs absent an explicit judge/HITL continue decision

**SCENARIO-018 — Noise-only signature differences MUST compare equal** (AC-08 · P0)
- **Given** two failure texts that differ only in stripped noise — different ISO-8601 timestamps, UUIDs, durations, and cached markers, with identical command label, failing subjects, and error class
- **When** their normalized signatures are compared
- **Then** they compare equal (pinned by unit test)

**SCENARIO-019 — Package/path or error-class differences MUST NOT compare equal** (AC-08 · P0)
- **Given** failure texts that differ in failing package/path (`internal/services/snow` vs `internal/services/auth`) or in error class
- **When** their normalized signatures are compared
- **Then** they do NOT compare equal — no over-normalization (pinned by unit test in both directions together with SCENARIO-018)

## Feature 3 — PRC: Reused-worktree isolation at setup

**SCENARIO-020 — Reused/resumed track with foreign dirt is quarantined and left clean** (AC-09 · P0)
- **Given** a temp-repo test entering a reused track (`reusedTrack === true` from `runSetup`), or equivalently a resumed track (`options.resumeSpecIdentifier` set), whose `worktreePath` carries foreign uncommitted state: a tracked modification to `internal/services/snow/enrichment.go` and an untracked `scratch.txt` at the worktree root
- **When** `runSetup` completes, absent the kill-switch
- **Then** the foreign state was quarantined recoverably via scoped `git stash push -u` with a ledger record (per AC-12)
- **And** `git status --porcelain` in the worktree reports no foreign tracked modifications

**SCENARIO-021 — Setup quarantine excludes spec-dir, bookkeeping, and copied env files; fresh tracks are untouched** (AC-09 · P1)
- **Given** a reused-track entry whose only uncommitted state consists of: modified files under the spec-dir prefix; harness bookkeeping files inside the spec dir (`HARNESS_BOOKKEEPING_FILES` members); and entries of `copiedEnvFiles`
- **When** `runSetup` completes
- **Then** none of those paths appear in the stash pathspec — their worktree state is preserved as-is
- **And** a fresh track entry (neither `reusedTrack` nor `resumeSpecIdentifier`) performs no setup detection-quarantine at all — the detection is scoped to re-entry

**SCENARIO-022 — Setup quarantine log names paths, stash ref, recovery command, and kill-switch** (AC-10 · P1)
- **Given** a setup quarantine occurred (foreign dirt stashed under a stash ref)
- **When** the quarantine is reported
- **Then** a prominent log line names: the quarantined paths, the stash ref, the recovery command `git stash pop`, and the kill-switch `SUPER_DEV_NO_DIRTY_QUARANTINE=1`
- **And** the line follows the existing `SUPER_DEV_NO_SPEC_REUSE` / `SUPER_DEV_NO_BOOTSTRAP` kill-switch logging style in src/setup.ts

**SCENARIO-023 — Kill-switch disables the setup quarantine, leaving the worktree untouched with a detection warning** (AC-11 · P0)
- **Given** `SUPER_DEV_NO_DIRTY_QUARANTINE=1` set in the environment and a reused track carrying foreign uncommitted dirt
- **When** `runSetup` completes
- **Then** no stash is created and the worktree is left untouched
- **And** a detection-warning log is emitted (detection still observes; mutation never runs)

**SCENARIO-024 — Kill-switch also disables the in-loop quarantine** (AC-11 · P0)
- **Given** `SUPER_DEV_NO_DIRTY_QUARANTINE=1` set and a GREEN-phase environmental-blocker with a non-empty dirt inventory
- **When** the blocker branch runs
- **Then** the in-loop quarantine is disabled too — no stash mutation of the worktree occurs
- **And** a detection-warning log is emitted and the branch routes to the judge path (AC-04) instead — every automatic quarantine introduced by this cycle is covered by the single switch

## Feature 4 — PRD: Per-track environmental-fault ledger

**SCENARIO-025 — Quarantine events append one ledger line with exactly the four keys** (AC-12 · P0)
- **Given** any quarantine event (setup-time per AC-09 or in-loop per AC-03)
- **When** the record is written
- **Then** exactly one JSON line is appended to `<specDir>/.environment-faults.jsonl`
- **And** the line's key set is exactly `{kind, paths, stashRef, reason}` with `kind` = `"quarantine"`, `paths` = the quarantined pathspec, `stashRef` = the stash ref, `reason` = a human-readable cause — mirroring the `.resume-cache.jsonl` in-spec-dir precedent

**SCENARIO-026 — Judge environmental verdicts append a verdict-shaped ledger line** (AC-12 · P1)
- **Given** a judge verdict at the environmental-blocker boundary (scope `stage9.impl-env-blocker.<phaseId>`)
- **When** the record is written
- **Then** one JSON line is appended with `kind` = `"judge-environmental"`
- **And** `paths` and `stashRef` are empty/null for verdict records, with `reason` carrying the verdict summary — the key set remains exactly `{kind, paths, stashRef, reason}`

**SCENARIO-027 — Setup surfaces the prior-fault count iff the ledger exists; appends never throw** (AC-12 · P1)
- **Given** a reused track whose specDir contains `.environment-faults.jsonl` with N prior lines
- **When** setup runs on that track
- **Then** setup logs the prior-fault count for the track
- **And** when the file is absent, setup emits no prior-fault line at all
- **And** ledger appends never throw — an append failure degrades per AC-13

## Feature 5 — Safety: never-destructive, kill-switched, degrading quarantine

**SCENARIO-028 — Quarantine is stash-based only and its pathspec never touches in-scope or excluded files** (AC-13 · P0)
- **Given** any quarantine execution (setup or in-loop), with the kill-switch unset
- **When** the quarantine runs
- **Then** the only worktree mutation is the scoped `git stash push -u -- <paths>` — no `checkout`, `reset`, or `clean` is ever invoked
- **And** the pathspec never includes in-scope files or excluded files (spec-dir prefix, harness bookkeeping, copied env files, the phase's declared scope, the current attempt's change set)
- **And** the quarantine never runs when `SUPER_DEV_NO_DIRTY_QUARANTINE=1` is set

**SCENARIO-029 — Quarantine mechanism failure in-loop degrades to warning plus judge, never fatal** (AC-13 · P0)
- **Given** the in-loop quarantine's git invocation fails (git error during the stash)
- **When** the failure is handled
- **Then** the loop degrades to a warning log plus the judge route (AC-04) — the attempt loop does not throw and the never-throwing contract is preserved
- **And** no partial mutation is left unrecorded: nothing was stashed, so no recovery is owed

**SCENARIO-030 — Unwritable ledger degrades to a warning; the flow proceeds, never fatal** (AC-13 · P1)
- **Given** the ledger path `<specDir>/.environment-faults.jsonl` is unwritable (e.g. permissions)
- **When** a quarantine or judge-environmental record append is attempted
- **Then** the append failure degrades to a warning log only
- **And** in-loop the branch proceeds to the judge route and at setup the run proceeds plainly — never fatal

## Feature 6 — Process

**SCENARIO-031 — RED-first tests, clean typecheck, green suite** (AC-14 · P1)
- **Given** the pre-fix tree (v0.2.2, before this cycle's changes)
- **When** the tests for each new behavior of AC-01..AC-13 are executed on it
- **Then** they fail (RED-first — every new behavior's tests fail on the pre-fix tree)
- **And** after the fix lands in the same commit as the version bump to 0.2.3 (NFR-5): `tsc --noEmit` exits clean and the full vitest suite is green

---

## Traceability

| AC | Scenarios | Coverage note |
|---|---|---|
| AC-01 | SCENARIO-001, SCENARIO-002, SCENARIO-003 | golden classification (incl. `[baseline-verify]` exclusion), product-defect alternative, unclassified edge |
| AC-02 | SCENARIO-004 | implementer call-count assertion via stubbed `runBuildGate` |
| AC-03 | SCENARIO-005, SCENARIO-006, SCENARIO-007, SCENARIO-008, SCENARIO-009 | exactly-one re-run, memo invalidation, green-through, inventory exclusions, RC12c edge |
| AC-04 | SCENARIO-010, SCENARIO-011, SCENARIO-012 | judge at first occurrence (no dirt), still-blocked after one re-run, route degradation |
| AC-05 | SCENARIO-013 | `class=…; next=…` substring assertions |
| AC-06 | SCENARIO-014, SCENARIO-015 | all noise classes stripped; strip-before-cap ordering |
| AC-07 | SCENARIO-016, SCENARIO-017 | 11-text replay → one signature (both components); anti-windup on second occurrence |
| AC-08 | SCENARIO-018, SCENARIO-019 | both directions pinned: equal on noise-only, NOT equal on package/error-class |
| AC-09 | SCENARIO-020, SCENARIO-021 | reused/resumed quarantine + porcelain-clean; exclusions and fresh-track boundary |
| AC-10 | SCENARIO-022 | paths + stash ref + `git stash pop` + kill-switch in one prominent log |
| AC-11 | SCENARIO-023, SCENARIO-024 | kill-switch disables BOTH quarantines (setup + in-loop) |
| AC-12 | SCENARIO-025, SCENARIO-026, SCENARIO-027 | exact key set `{kind, paths, stashRef, reason}`; verdict records; prior-count log iff file exists |
| AC-13 | SCENARIO-028, SCENARIO-029, SCENARIO-030 | stash-only + pathspec safety; git-error → warning+judge; unwritable ledger → warning; never fatal |
| AC-14 | SCENARIO-031 | RED-first, `tsc --noEmit` clean, vitest green |

Bidirectional completeness: every AC-01..AC-14 maps to ≥1 scenario above, and every SCENARIO-001..SCENARIO-031 appears in exactly one AC row (SCENARIO-005 references AC-12 for the ledger record; SCENARIO-024 references AC-04 for the judge fallback — both are And-clause cross-references, with primary ownership as tabulated).