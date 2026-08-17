# Task List — Whole-Codebase Review Remediation (Spec 28)

- **Date:** 2026-08-17
- **Source:** `05-technical-specification.md` (§Architecture = exact designs; §Tasks = scope). One block per work item with its file inventory. Every SCENARIO-001…071 maps to exactly one task (fix-in-pass/release tasks carry no scenario).
- **Convention:** `C` = create, `M` = modify, `D` = delete. Paths relative to repo root. Tests are red-first (NFR-1); pin flips cite their finding ids.

---

**T1.1 · Phase 1 · AC-01 — PASS verdict downgrade**
- **src:** M `src/helpers.ts` — `normalizeReviewVerdict` PASS branch routes through `reviewHasBlockingVerdictFinding(review) || reviewHasHighSeverityFinding(review)`.
- **tests:** M `tests/helpers.test.ts` — PASS+blocking-high ⇒ `"Changes Requested"`; PASS clean ⇒ `"Approved"` (existing pin stays); PASS vs `Approved` parity case.
- scenarioRefs: SCENARIO-001, SCENARIO-002, SCENARIO-003

**T1.2 · Phase 1 · AC-28 — Negated-verdict guard**
- **src:** M `src/review-findings.ts` (+export `NEGATED_APPROVAL_RE`); M `src/stages/artifact-convergence.ts` (`reviewVerdictApproves` guard); M `src/doc-validators.ts` (`isApprovedVerdict` guard + import).
- **tests:** M `tests/artifact-convergence.test.ts`, M `tests/doc-validators.test.ts` — negation table → false; approve-family table → true.
- scenarioRefs: SCENARIO-057, SCENARIO-058

**T1.3 · Phase 1 · AC-35 — Explicit signals outrank prose inference**
- **src:** M `src/review-findings.ts` — `reviewFindingBlocks` status resolution (`hasExplicitStatus`/`explicitHighSignal` path); doc comment on `reviewFindingBlocksVerdict` inheritance.
- **tests:** M `tests/convergence-ledger-review-findings.test.ts` — `{severity:"critical",blocking:true,title:"Deferred: …"}` blocks; signal-free prose inference unchanged.
- scenarioRefs: SCENARIO-070, SCENARIO-071

**T1.4 · Phase 1 · AC-34 (+B7, +B8) — Duty restatement shield + ledger merge strength**
- **src:** M `src/review-findings.ts` (+export `reviewFindingFingerprint`); M `src/convergence-ledger.ts` (normalizeFinding uses it; delete local `stableHash`; merge preserves max severity class + `blocking ||`; import `reviewFindingHighSeverity`); M `src/review-findings.ts` `enforceReviewerConvergenceDuty` (opts `knownBlockingFingerprints`/`reviewSourceGate`; own-id + fingerprint shields); M `src/stages/artifact-convergence.ts` + `src/stages/spec-convergence.ts` (duty call sites pass the fingerprint set + source gate; B8 review-doc re-render after enforcement).
- **tests:** M `tests/convergence-ledger-review-findings.test.ts` (verbatim medium restatement stays blocking; merge keeps high/blocking; `R2-G1-PRIORFINDING-RESURRECTION` + `P10`/`majorly cosmetic` pins stay green), M `tests/spec-convergence.test.ts`.
- scenarioRefs: SCENARIO-068, SCENARIO-069

**T1.5 · Phase 1 · AC-18 — Genuine-approval replan consumption gating**
- **src:** M `src/stages/artifact-convergence.ts` (`genuineApproval` + gated verified-flip/consumption); M `src/stages/spec-convergence.ts` (`genuineApproval = review.pass` mirror).
- **tests:** M `tests/replan-restart.test.ts` (pin flip at :157–225, commit cites M8; genuine-approval counterpart), M `tests/spec-convergence.test.ts`.
- scenarioRefs: SCENARIO-039, SCENARIO-040

---

**T2.1 · Phase 2 · AC-07 — Cleanup blocks every copied env variant**
- **src:** M `src/setup.ts` (`export function isEnvFile`); M `src/helpers.ts` (+`ENV_VARIANT_BASENAME_RE`, +`blocksCleanupEnvBasename`, `SENSITIVE_RE` env entries removed, both scan loops use the predicate; import from setup.ts).
- **tests:** M `tests/cleanup-sensitive-scan.test.ts` — committed `.env.development`/`.env.staging`/`.env.prod`/`.env.ci` ⇒ blocked; `.env.example` ⇒ not; untracked-copy pins stay green.
- scenarioRefs: SCENARIO-015, SCENARIO-016

**T2.2 · Phase 2 · AC-08 (ISS-01) — Copied env files excluded from staging**
- **src:** M `src/setup.ts` — `excludeCopiedEnvFiles(worktreeRoot, copiedRelPaths)` (common-dir `info/exclude`, idempotent, header once) + call after `copyEnvFilesToWorktree`; imports `appendFileSync`.
- **tests:** C `tests/setup-env-exclude.test.ts` — real-git fixture: untracked-unignored `.env.development`; copy + `commitWorktreeChanges` ⇒ still `??`, not in commit, `check-ignore` exit 0; fix + merge commits exclude it too; idempotent append.
- scenarioRefs: SCENARIO-017, SCENARIO-018

**T2.3 · Phase 2 · AC-09 — Worktree-add fail-closed**
- **src:** M `src/setup.ts` — `gitWithStderr` helper; `createOrReuseWorktree` prune + one retry + throw (`git worktree prune` + stderr tail); delete the in-place fallback return.
- **tests:** M `tests/setup.test.ts` — stale-registration reject (stderr surfaced, no in-place state); prune-recovers variant (exactly one prune+retry); `skipWorktree` unaffected.
- scenarioRefs: SCENARIO-019, SCENARIO-020, SCENARIO-021

**T2.4 · Phase 2 · AC-10 — Main-checkout commit refusal**
- **src:** M `src/helpers.ts` — `commitWorktreeChanges(cwd, message, opts)` + `--git-dir`/`--git-common-dir` guard before `git add -A` (`"refusing to commit in the main checkout"`); M `src/stages/verify.ts` (:431 call site threads `{ allowMainCheckout: state.setup?.worktreeCreated !== true }`).
- **tests:** M `tests/verification-fix-commit.test.ts` (D6: worktree fixtures + opt-in cases; refusal leaves index untouched; linked-worktree commits unchanged); audit M `tests/merge-verify.test.ts`.
- scenarioRefs: SCENARIO-022, SCENARIO-023, SCENARIO-024

---

**T3.1 · Phase 3 · AC-02 — Referenced-spec entry preserves the track**
- **src:** M `src/setup.ts` — `reusedTrack = true;` in the `taskSpecIdentifier` branch.
- **tests:** M `tests/setup.test.ts` — mirror of :257 (knowledge + user-notes byte-identical on re-entry; `reusedTrack === true`); fresh-track clear pin stays green.
- scenarioRefs: SCENARIO-004, SCENARIO-005

**T3.2 · Phase 3 · AC-21 (+R8) — Fresh entry truncates the stale cache**
- **src:** M `src/setup.ts` — guarded truncation of `.resume-cache.jsonl` on non-resume entry into an existing track (`reusedTrack || taskSpecIdentifier`, `existsSync` guard, after selection); M `src/resume.ts` — `appendResumeResult` torn-line repair (prepend `\n` when non-empty and last byte ≠ `\n`); `loadResumeCache` warns once per skipped corrupt line.
- **tests:** M `tests/setup.test.ts` (seeded `#2/#3` rows gone after fresh referenced-spec entry; preserved after resume), M `tests/resume.test.ts` (torn `{"key":…` + good line ⇒ good line survives as its own row).
- scenarioRefs: SCENARIO-045, SCENARIO-046

**T3.3 · Phase 3 · AC-04 — Prefix coverage + drift guard**
- **src:** M `src/replan/replan.ts` — `STAGE_CALL_PREFIXES` gains `debug`/`assessment`/`prototype` prefixes + deliberate `classify: []` (comment cites D2).
- **tests:** C `tests/replan-stage-prefix-edges.test.ts` (source-grep tripwire over `src/stages/**` + `src/replan/**`, templates normalized, uncovered list empty); M `tests/replan-restart.test.ts` (`RESUME_ROWS` + prototype/debug/assessment rows; dropped for owner=requirements and design).
- scenarioRefs: SCENARIO-008, SCENARIO-009, SCENARIO-010

**T3.4 · Phase 3 · AC-05 (+B6) — Unconditional judge/replan invalidation**
- **src:** M `src/replan/replan.ts` — `invalidateResumeCache` prefixes union `["pipeline.judge.", "pipeline.replan."]` (delete the dead empty-return); `triggerReplanForFindings` B6 zero-drop guard + local `resumeCacheHasRowsFor`.
- **tests:** M `tests/replan-restart.test.ts` — seeded `pipeline.judge.spec@root#1` + `pipeline.replan.lead@root#1` dropped on every trigger (incl. no-owner-rows case); B6 shape ⇒ no `__replan`.
- scenarioRefs: SCENARIO-011, SCENARIO-012

**T3.5 · Phase 3 · AC-20 (D4, D5) — Deferred findings survive the replan boundary**
- **src:** M `src/replan/replan.ts` — `ReplanRequest.ownerStage: ReplanOwnerStage | "human"`; human-row persistence in `triggerReplanForFindings`; `pendingReplanRequests`/`consumeReplanRequests`/owners filter exclude `"human"`; +export `pendingHumanReplanRequests`; M `src/replan/owners.ts` (no routing change — type comment only); M `src/stages/verify.ts` — remove the five visibility caps (`:888, :914, :940, :942, :951, :1213`); M `src/extension.ts` — replan-restart block logs pending human rows.
- **tests:** M `tests/verify.test.ts` (2 routable + 3 needs-human ⇒ 2 stage rows + 3 human rows; human rows never consumed; `__stagnated.findings` lists all deferred), M `tests/replan-restart.test.ts`, M `tests/replan-owners.test.ts` (closed routing set unchanged).
- scenarioRefs: SCENARIO-043, SCENARIO-044

**T3.6 · Phase 3 · AC-30 — Spec-dir run lock**
- **src:** M `src/setup.ts` — `RUN_LOCK_BASENAME`, `readLockHolder`, `isPidAlive`, `acquireRunLock` (wx + live-pid throw naming the holder + self-pid/stale steal), `releaseHeldRunLock`, acquire after `mkdirSync(specDirectory)`; M `src/pipeline.ts` — `finally { releaseHeldRunLock(); }`; M `src/extension.ts` — belt-and-braces release in doRun finally; M `src/helpers.ts` — `".run-lock"` in `HARNESS_BOOKKEEPING_FILES`; M `src/tracking.ts` — `".run-lock"` in `INTERNAL_RUNTIME_CLAIM_BASENAMES`.
- **tests:** M `tests/setup.test.ts` — live-pid lock ⇒ error naming pid; dead-pid lock stolen; lock absent after a completed run; exempt from gates + dirty-tree.
- scenarioRefs: SCENARIO-061, SCENARIO-062

---

**T4.1 · Phase 4 · AC-19 — Phase coercion fidelity**
- **src:** M `src/doc-validators.ts` — `normalizePhases` single-object spread; string split drops `,`.
- **tests:** M `tests/doc-validators.test.ts` — round-trip `{name, description, scenarioRefs, deliverables}`; `"Phase A, Phase B"` ⇒ 1 phase; audit coercible-shape pins (helpers/writers).
- scenarioRefs: SCENARIO-041, SCENARIO-042

**T4.2 · Phase 4 · AC-13 + AC-25 — Fence pairing + heading vocabulary**
- **src:** M `src/doc-validators.ts` — `FENCE_OPEN_RE`; `fence: {char, len}` tracking with same-char ≥len close + non-normative-heading implicit close; widened + exported `NON_NORMATIVE_SECTION_RE` (`#{1,4}`, word-led qualifier set, decoration alternative); rewritten :82–90 comment.
- **tests:** M `tests/doc-validators.test.ts` — `~~~`/``` nesting; ````/``` nesting; unclosed fence before `## Prior Review Responses`; H1/H4 decorated variants; **M14 pin flip at :543–557 (commit cites M14/OQ-2)**; `## Convergence Criteria` non-strip pin kept.
- scenarioRefs: SCENARIO-028, SCENARIO-029, SCENARIO-030, SCENARIO-052, SCENARIO-053

**T4.3 · Phase 4 · AC-26 — gate-bdd on stripped content**
- **src:** M `src/doc-validators.ts` — `bddTraceabilityErrors` strips both inputs.
- **tests:** M `tests/requirements-bdd-gate.test.ts` — `AC-99` inside `## Evidence Notes` ⇒ no dangling-AC error.
- scenarioRefs: SCENARIO-054

**T4.4 · Phase 4 · AC-11 — Wire the deliverable guard**
- **src:** M `src/doc-validators.ts` — `specTraceabilityErrors` appends `phaseTestDeliverableErrors(phases, tasks)` after `phaseIndependenceErrors`.
- **tests:** M `tests/pipeline-gates.test.ts` / M `tests/requirements-bdd-gate.test.ts` — end-to-end `gate-spec-trace` failure naming the phase; audit spec fixtures (`tests/spec-convergence.test.ts`, `tests/upstream-review-integration.test.ts`, `tests/spec-deliverable-declaration.test.ts`).
- scenarioRefs: SCENARIO-025

**T4.5 · Phase 4 · AC-27 — Render schema AC-id patterns**
- **src:** M `src/render/schemas.ts` — `Type.Pattern(/^AC-\d{2,}$/)` on `AcceptanceCriterion.id` + `BddScenario.acRef`.
- **tests:** M `tests/render.test.ts` — `["1","2"]` fails validation, no doc written; `["AC-01","AC-02"]` passes + gate-parseable tokens; audit 1-digit-id fixtures (D8).
- scenarioRefs: SCENARIO-055, SCENARIO-056

**T4.6 · Phase 4 · AC-16 — readSpecDoc containment**
- **src:** M `src/doc-validators.ts` — `readSpecDoc` spec-root resolution + `startsWith(specRoot + sep)` + single `[doc-validators] readSpecDoc: ignoring` warn + glob fall-through; imports `resolve, sep`.
- **tests:** M `tests/doc-validators.test.ts`, M `tests/doc-path-idempotency.test.ts` — outside docPath ignored for the glob; relative docPath against specDir, never CWD; D7 fixture audit.
- scenarioRefs: SCENARIO-035, SCENARIO-036

**T4.7 · Phase 4 · AC-14 — Computed BDD coverage summary**
- **src:** M `src/render/render.ts` — `augmentData("bdd")` computes `acSet`/`coveredAcCount`/`uncoveredAcIds`; M `src/render/templates/bdd-scenarios.md.njk` — block gated on traceability presence; literal self-report lines deleted.
- **tests:** M `tests/render.test.ts` — 20 scenarios + no traceability ⇒ no coverage block; partial ⇒ `Covered by Scenarios: 3` / `Uncovered: 2`; audit `tests/docs-contracts.test.ts`.
- scenarioRefs: SCENARIO-031, SCENARIO-032

---

**T5.1 · Phase 5 · AC-15 (+D-1) — Tracker path parity**
- **src:** M `src/tracking.ts` — `gitSpawn` prepends `-c core.quotepath=false`; `normalizeTrackerPath` `/\\/gu`.
- **tests:** M `tests/tracking.test.ts`, M `tests/change-tracker-nonregression.test.ts` — `src\team\types.ts` normalization; real-git `src/图表.ts` claim ⇒ `claimedNotChanged` empty, verdict `ok`; double-backslash superset pins stay green.
- scenarioRefs: SCENARIO-033, SCENARIO-034

**T5.2 · Phase 5 · AC-32 — Gitignored claims advisory**
- **src:** M `src/tracking.ts` — `CrossCheck.ignoredVerified: string[]`; `checkIgnored` (`git check-ignore --`, exit 0); exists-on-disk branch in `computeCrossCheck`; verdict unchanged.
- **tests:** M `tests/compute-change-gate.test.ts` (+ `tests/change-tracker-nonregression.test.ts`) — gitignored `public/schema.json` ⇒ advisory, no claimed-miss; non-ignored unchanged claim ⇒ still claimed-miss.
- scenarioRefs: SCENARIO-065, SCENARIO-066

**T5.3 · Phase 5 · AC-22 (+R7) — RED oracle discipline**
- **src:** M `src/build-runner/gates.ts` — python branch: usage/collection `broken` markers, red only on failure markers, bare `/\berror\b/` deleted; npm branch: `/❯/` marker deleted.
- **tests:** M `tests/red-oracle.test.ts` — usage-error/exit-4-shape outputs ⇒ `broken`; bare `error` ⇒ `unknown`; `FAILED …` ⇒ `red`; npm cases without `❯` still red.
- scenarioRefs: SCENARIO-047, SCENARIO-048

**T5.4 · Phase 5 · AC-03 — GREEN-loop recurrence**
- **src:** M `src/stages/implementation.ts` — `repeatedNoProgress` matches any history entry.
- **tests:** M `tests/implementation-convergence-loop.test.ts` — A→B→A→B trips no-progress within the mirror of `tests/implementation-red-loop.test.ts:441`; A,B,C,D does not; consecutive-identical + `tests/implementation-stage9-smoke.test.ts` stay green.
- scenarioRefs: SCENARIO-006, SCENARIO-007

**T5.5 · Phase 5 · AC-06 — Task-level scenario mapping**
- **src:** M `src/stages/implementation.ts` — `expectedScenariosForPhase` merges `task.scenarioRefs` (`task.phase === phaseName`); fallback only when phase- AND task-level refs are both empty.
- **tests:** M `tests/implementation-red-loop.test.ts` — multi-phase spec mapped only via `tasks[].scenarioRefs` ⇒ per-phase task subsets (asserted via the coverage verifier's missing-list / `tddCoverageRetryHint` content).
- scenarioRefs: SCENARIO-013, SCENARIO-014

---

**T6.1 · Phase 6 · AC-12 — UTF-8-exact streaming + final line**
- **src:** M `src/pi-spawn.ts` — `setEncoding("utf8")` on both streams; `data` handlers take strings; `processLine` extraction; `close` parses a non-empty residual `lineBuf`.
- **tests:** M `tests/pi-spawn.test.ts` (+ `tests/pi-spawn-control-retry.test.ts` audit) — mid-codepoint split reassembles byte-identically; newline-less final `message_end` parsed.
- scenarioRefs: SCENARIO-026, SCENARIO-027

**T6.2 · Phase 6 · AC-23 — Kill ladder + bounded settle**
- **src:** M `src/pi-spawn.ts` — +export `SIGTERM_GRACE_MS = 10_000`, `SETTLE_GRACE_MS = 5_000`; `terminateChild` on abort + timeout; settle-backstop reject (`killed after SIGTERM+SIGKILL`); `cleanup` clears all timers.
- **tests:** M `tests/pi-spawn.test.ts` — SIGTERM-ignoring fake child settles within the bound (abort + timeout variants); cleanup runs; existing `"timed out"` resolution shapes stay green where applicable.
- scenarioRefs: SCENARIO-049

**T6.3 · Phase 6 · AC-24 — Service teardown + abortable readiness**
- **src:** M `src/stages/lifecycle.ts` — `stopService` group-SIGKILL escalation after `SIGTERM_GRACE_MS` (aliveness-checked, unrefed timer); `waitForReady(url, timeoutMs, signal?)` abort-aware fetch; `startService` opts `signal`; `tryStartService` between-candidate checks; `bringupTask` passes `ctx.signal`.
- **tests:** M `tests/lifecycle.test.ts` — SIGTERM-trapping server killed, ESRCH + port rebinding; aborted polling stops within one iteration; `tryStartService` abort shape.
- scenarioRefs: SCENARIO-050, SCENARIO-051

**T6.4 · Phase 6 · AC-17 (+B4, D10) — Round accounting clamp + fresh arming**
- **src:** M `src/stages/artifact-convergence.ts` — +export `MAX_TOTAL_ROUND_MULTIPLE`, `extendedRoundCap`; extension site uses it; cap block gated `round > priorRounds + 1`; `priorReviewRounds` fresh-review tracker gating; J10 fatal reports `effectiveCap` + requires non-empty evidence; M `src/stages/spec-convergence.ts` — all four mirrors.
- **tests:** M `tests/artifact-convergence.test.ts` (existing `:174–184` pins stay; arithmetic table p ∈ {2,20,24,30}; extension {10→14, 22→24, never 28}; simulated multi-resume fatal-after-fresh + message contains `24`), M `tests/spec-convergence.test.ts`.
- scenarioRefs: SCENARIO-037, SCENARIO-038

**T6.5 · Phase 6 · AC-29 (+D-8) — Serialized execute + run-dir capture**
- **src:** M `src/extension.ts` — `inFlight` guard + `a super-dev run is already active` refusal; delete the singleton discard; `const runDir = startRun()` threaded (log path, `runReflectionAsync(runDir)`); finally: `inFlight = false`, `releaseHeldRunLock()`, `updateStats()` + `cleanupOldRuns()` (D-8); M `src/render/super-dev-dir.ts` — +`runLogPathFor`/`auditPathFor`/`reflectionPathFor`; `auditAppend(entry, runDir?)` mode 0600; M `src/render/reflection.ts` — `runReflectionAsync(runDir?)`/`runReflection(runDir)` capture at entry.
- **tests:** M `tests/extension-entry-renderer.test.ts`, M `tests/extension-inherit.test.ts`, M `src/extension.escalation.test.ts`, M `tests/self-improving.test.ts` (audit), C/M reflection test (run-A reflection after run-B `startRun` writes run-A files).
- scenarioRefs: SCENARIO-059, SCENARIO-060

**T6.6 · Phase 6 · AC-33 (+D-4) — User-note size cap**
- **src:** M `src/render/user-notes.ts` — +export `MAX_USER_NOTE_BYTES = 16_384`; `capUserNoteBytes` (8192 head + `…[truncated N bytes]…` + 8192 tail); applied in `appendUserNotes`; D-4: `persistImage` applies spec-root containment to ABSOLUTE attachment paths too.
- **tests:** M `tests/user-notes.test.ts` — 1 MB note ⇒ capped head+tail form persisted + injected; short notes byte-identical; D-4 pinning test: an absolute out-of-specDir attachment path is rejected with the existing notice.
- scenarioRefs: SCENARIO-067

**T6.7 · Phase 6 · AC-31 — Untrusted-text fencing in prompts**
- **src:** M `src/prompts.ts` — +export `DATA_FENCE_PREAMBLE`, `fenceUntrusted` (`max(4, longest backtick run + 1)`); wire the 13 task embedders + `buildJudgePrompt` context + `buildTddPrompt`/`buildRedReviewPrompt` phase-task blocks + `buildFixPrompt` finding/test-failure lists + priorResponses blocks (`buildUpstreamReviewPrompt`/`buildSpecReviewPrompt`) + `buildReplanOwnerPrompt` finding block; M `src/retry-feedback.ts` — `renderRetryFeedbackBlock` fences the item list.
- **tests:** M `tests/prompts.test.ts`, M `tests/prompt-control-contracts.test.ts`, M `tests/prompts-tdd-deliverable-names.test.ts`, M `tests/prompts-tdd-rust-discipline.test.ts`, M `tests/prompts-cargo-verify-discipline.test.ts` — preamble in every builder; fence-hostile task wholly inside the escalated fence; 5-backtick ⇒ 6-backtick fence; no raw `## ` heading / payload ``` line outside; regenerate exact-output pins.
- scenarioRefs: SCENARIO-063, SCENARIO-064

---

**T7.1 · Phase 7 · SD-04 — Abort-listener registration guard**
- **src:** M `src/pi-spawn.ts`, M `src/session-agent.ts` — synchronous `signal?.aborted` checks before/after spawn/listener registration.
- **tests:** M `tests/pi-spawn.test.ts`, M `tests/session-agent.test.ts` (pinning test, NFR-6).
- scenarioRefs: (none)

**T7.2 · Phase 7 · SD-05 — accept-limitation ⇒ partial**
- **src:** M `src/stages/artifact-convergence.ts` (+ any fatal-gate acceptance site) — record `state.__acceptedLimitations`; M `src/workflow.ts` — status derives `partial`, never `success`, when set.
- **tests:** M `tests/workflow.test.ts` (pinning test).
- scenarioRefs: (none)

**T7.3 · Phase 7 · SD-07 — Delete dead `waitForEvent`**
- **src:** D `waitForEvent` + `WaitForEventOptions` from `src/nodes.ts` (export list updated).
- **tests:** M `tests/nodes.test.ts` — no import site / grep tripwire; commit message states the atomic delete (NFR-1).
- scenarioRefs: (none)

**T7.4 · Phase 7 · A-03 — `__replan` status not-aborted**
- **src:** M `src/workflow.ts` — `status = "replan"` only when `!aborted` (or the abort is the replan FatalAbort).
- **tests:** M `tests/workflow.test.ts` (pinning test).
- scenarioRefs: (none)

**T7.5 · Phase 7 · A-04 — writerTask budget sentinel**
- **src:** M `src/nodes.ts` — `writerTask` budget-exhaustion returns a skipped/failed sentinel, never `undefined` recorded as `ok`.
- **tests:** M `tests/nodes.test.ts` (pinning test).
- scenarioRefs: (none)

**T7.6 · Phase 7 · A-05 — sleep abort-listener removal**
- **src:** M `src/workflow.ts` (`sleepMs`) + any sibling sleep — listener removed in `finally` on normal resolution.
- **tests:** M `tests/workflow.test.ts` (listener-count pinning test).
- scenarioRefs: (none)

**T7.7 · Phase 7 · B3 + B5 — Judge-path fix-in-pass**
- **src:** M `src/stages/judge.ts` — B3: evidence-less `continue` verdicts route with an explicit audit line; B5: `verifyJudgeEvidence` realpath containment for relative evidence paths (`..` escapes rejected; absolute-path allowance documented).
- **tests:** M `tests/judge.test.ts` — `../outside.txt` under a worktree root fails; `src/foo.ts` passes; continue-route audit line.
- scenarioRefs: (none)

**T7.8 · Phase 7 · R6 — Reuse-token verbatim + score log**
- **src:** M `src/setup.ts` — slug numeric tokens must appear verbatim in the task text for token-containment reuse; the reuse decision logs its score.
- **tests:** M `tests/setup.test.ts` (pinning test).
- scenarioRefs: (none)

**T7.9 · Phase 7 · D-5 — Runlog durability**
- **src:** M `src/runlog.ts` — `lastSeq` cached in memory per specDir (tailProbe only on the first append after process start); uniform payload bound on all `RunEventInput` emitters.
- **tests:** M `tests/runlog.test.ts`, M `tests/runlog-invariants.test.ts` (pinning tests).
- scenarioRefs: (none)

**T7.10 · Phase 7 · NFR-2/3/4 — Release v0.1.100**
- **src:** M `package.json` (0.1.99 → 0.1.100), M `CHANGELOG.md` (`[Unreleased]` → Keep-a-Changelog `### Fixed` bullets, bold-anchored, one per AC group).
- **tests:** M/audit `tests/version.test.ts` + the `tests/changelog-unreleased-*.test.ts` pattern; full `npx vitest run` (exit 0, re-counted per D12) + `npx tsc --noEmit` strict-clean.
- scenarioRefs: (none)

---

## Coverage ledger

- Scenarios 001–071 → exactly one task each (see T-blocks). ✔ 71/71
- AC-01…AC-35 → each owned by exactly one task (folded dispositions noted in that task's header). ✔ 35/35
- Fix-in-pass dispositions: B4→T6.4 · B5→T7.7 · B6→T3.4 · B7/B8→T1.4 · R7→T5.3 · R8→T3.2 · D-1→T5.1 · D-9(waitForEvent)→T7.3 · SD-04→T7.1 · SD-05→T7.2 · A-03→T7.4 · A-04→T7.5 · A-05→T7.6 · B3→T7.7 · R6→T7.8 · D-4→T6.6 · D-5→T7.9 · D-8→T6.5 · adv-C/F5→T4.2. ✔ all disposition items placed
- Deferred items (SD-06, SD-08, D-6, D-10, E5, OQ-1) are out of scope by `01-requirements.md`. ✔
