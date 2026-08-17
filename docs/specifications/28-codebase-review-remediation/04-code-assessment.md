# Code Assessment — Spec 28 Remediation: AC-01…AC-35 mapped to `pi-super-dev` @ v0.1.99

## Summary

**Repo shape** (verified against working tree): TypeScript ESM, `tsc` strict, `vitest` (130 test files under `tests/`, colocated unit tests inside `src/` e.g. `src/tracking.test.ts`, `src/stages/artifact-convergence.test.ts`). Entry: `src/extension.ts` (pi tool `super_dev`) → `src/pipeline.ts` → `src/workflow.ts` → `src/stages/index.ts` skeleton (`STAGE_IDS` in `src/graph/edges.ts:34`). No API/UI server of its own — this is a pi extension package; `npx vitest run`, `npm run typecheck` (`tsc --noEmit`), `npm test`. Conventions to mirror: never-throw helpers with `try/catch` fallbacks, incident-comment blocks citing run IDs, drift-guard "tripwire" tests that `readFileSync` the source and grep it (`tests/graph-edges.test.ts:56-67`, `tests/implementation-red-loop-edges.test.ts`), and pinned regression tests named after finding ids (e.g. RC-3, F2, F5, G1).

**Verification result**: every AC-01…AC-35 premise was checked against the actual source. **33 of 35 map cleanly**; the code base matches the dossier's descriptions (line refs are within ±10 lines everywhere). Material drift/contradictions found — see final section — most importantly: AC-22's "exit code 4" clause doesn't fit `classifyRedStatus`'s signature; AC-20's `ownerStage: "human"` collides with the closed `ReplanOwnerStage` type; AC-10 will break `tests/verification-fix-commit.test.ts` fixtures that call `commitWorktreeChanges` in plain (main-checkout) temp repos; and AC-04's drift guard will additionally flag `pipeline.classify` (`src/stages/writers.ts:281`), which the dossier never mentions. No AC is better solved by deleting code than by its named fix — the only deletion item is the disposition-level dead `waitForEvent` (`src/nodes.ts:624-646`, zero callers, confirmed), and `phaseTestDeliverableErrors` (dead, confirmed — only `tests/doc-validators.test.ts:244-273` exercises it) must be **wired**, not deleted, per AC-11.

## Phase plan

Ordered by (dependency, risk, severity). H-items (AC-01…AC-10) all land in Phases 1–3 except AC-06, which is dependency-chained behind AC-19 (Phase 4).

**Phase 1 — Approval-chain integrity** (AC-01, AC-28, AC-35, AC-34, AC-18)
Pure-function fixes in one semantic cluster (verdict classifiers → status inference → duty/ledger merge → replan consumption). All are table-testable with no fixtures. AC-18 depends on nothing but touches the same `artifact-convergence.ts`/`spec-convergence.ts` approval sites as AC-34, so they land together. This is the highest-value, lowest-blast-radius start; it closes the H1 merge bypass first.

**Phase 2 — Secrets & worktree fail-closed** (AC-07 → AC-08, AC-09 → AC-10)
Fail-closed guards; two file pairs (`helpers.ts`/`setup.ts`). AC-09 must land before AC-10 (fail-closed worktree-add removes most in-place exposure that AC-10 guards). AC-07 before AC-08 (detection before prevention). Note AC-10's test churn (see drift D7).

**Phase 3 — Track state & resume-cache correctness** (AC-02 + AC-21 together, AC-04 + AC-05 together, AC-30 last)
Same `src/setup.ts` continuation branch and same `STAGE_CALL_PREFIXES` map. AC-21 consumes AC-02's preserve-path flag. AC-30's lock adds basename exemptions in `helpers.ts`/`tracking.ts` — land after AC-04/05 so the exemption set is touched once.

**Phase 4 — Doc-validator / render gate integrity** (AC-19 → AC-13 → AC-25 → AC-26 → AC-11 → AC-27 → AC-14)
All in `src/doc-validators.ts` + `src/render/`. AC-19 (normalizePhases preserves `scenarioRefs`/`deliverables`) must precede AC-11 and AC-06, both of which read those fields. AC-13/AC-25 both rewrite `stripNonNormativeSections`' fence/heading machinery — one commit. AC-26 consumes AC-13's stripping. AC-27 (schema pattern) is independent but gates render fixtures — audit-heavy, keep late in the phase. AC-14 is template-only.

**Phase 5 — Implementation/TDD loop correctness** (AC-15, AC-22, AC-32, AC-03, AC-06 last)
`tracking.ts` pair (AC-15, AC-32) then oracle (AC-22), then liveness (AC-03 — trivially small, can be pulled into Phase 1 if desired), then AC-06 which depends on AC-19 (Phase 4) and interacts with AC-11.

**Phase 6 — Process/extension robustness + prompts** (AC-12+AC-23, AC-24, AC-17, AC-29, AC-33, AC-31 last)
Independent subsystems (pi-spawn, lifecycle, extension/reflection, user-notes). AC-17 is independent of Phase 1's edits but shares `artifact-convergence.ts` — sequenced here to avoid conflicts. AC-31 (prompt fencing) touches every builder in `src/prompts.ts` and therefore every prompt-pinning test — highest test-churn item in the spec, deliberately last.

## Per-AC assessment

**AC-01 — PASS verdict downgrade**
- Change: `src/helpers.ts:234` in `normalizeReviewVerdict` (fn at :226) — replace the unconditional `if (raw === "PASS") return { verdict: "Approved", … }` with the same guard as the approve-family branch at :249-251 (`reviewHasBlockingVerdictFinding(review) || reviewHasHighSeverityFinding(review)` — both already imported at helpers.ts:9).
- Current: `PASS` returns `Approved` unconditionally. Required: `PASS` + open blocking/high finding → `"Changes Requested"`.
- Test: `tests/helpers.test.ts` — extend the PASS block at :114-115 / the merge cases at :161-288 (all currently use `PASS, findings: []`). Fixture: `{verdict:"PASS", findings:[{severity:"high",status:"open",blocking:true,file:"src/routes/users.ts",ownerStage:"implementation"}]}` → merged verdict `"Changes Requested"`.
- Risk: `tests/helpers.test.ts:115` (PASS-with-no-findings must stay `Approved` — keep green). Blast: local to `merge-review-verdicts`/`gate-review`; downstream verify-loop routing benefits. No deps.

**AC-02 — Referenced-spec path preserves knowledge/notes**
- Change: `src/setup.ts:346-355` (`taskSpecIdentifier` branch in `runSetup`) — set `reusedTrack = true` (flag declared :336; the clear is at :409-416).
- Current: task naming `docs/specifications/<id>` reuses the track but doesn't set the preserve flag → `clearKnowledge`/`clearUserNotes` (:414-415) wipe it. Required: that path skips the clear.
- Test: `tests/setup.test.ts` — mirror the "reuse preserves the track's knowledge and user notes" test at :257. Fixture: temp git repo, `docs/specifications/07-x/.knowledge.json` + `.user-notes.json`, task string `"continue the work in docs/specifications/07-x"` → both files byte-identical.
- Risk: fresh-run-clear pins in `tests/setup.test.ts` (must stay: fresh allocation still clears). Blast: local to setup, but changes downstream stage state on every referenced-spec run. Deps: pairs with AC-21 (same branch — see AC-21's collision note).

**AC-03 — GREEN loop detects A↔B recurrence**
- Change: `src/stages/implementation.ts:101-104` `repeatedNoProgress` — compare against ANY history entry (`history.some(h => h.failure === next.failure && h.footprint === next.footprint)`), mirroring the RED fix `redProgressHistory.includes(signature)` at :1197. Signature pushed at :1668; no-progress branch (judge J9-b / HITL) at :1670+.
- Current: only `history[history.length-1]` is compared → oscillation runs to budget death. Required: non-consecutive recurrence trips the judge/HITL boundary.
- Test: new case in `tests/implementation-convergence-loop.test.ts` mirroring `tests/implementation-red-loop.test.ts:441` ("RC-3: stops an A-B-A-B OSCILLATION"). Fixture: implementer attempts whose `failureSignature` alternates A/B (two distinct gate-error sets) with distinct footprints per attempt; assert the no-progress log/judge call fires within a few attempts, not at budget exhaustion.
- Risk: legitimate alternating-progress phases now escalate earlier; `tests/implementation-convergence-loop.test.ts` consecutive-identical pins; `tests/implementation-stage9-smoke.test.ts`. Blast: implementation phase loop + judge routing (J9-b) — no cross-stage effect. No deps (can be pulled into Phase 1).

**AC-04 — Resume-cache invalidation covers prototype/debug/assessment + drift guard**
- Change: `src/replan/replan.ts:111-126` `STAGE_CALL_PREFIXES` — add `debug: ["pipeline.debug"]`, `assessment: ["pipeline.assessment"]`, `prototype: ["pipeline.prototype."]` (emission sites: `src/nodes.ts:724` writer ids via `writers.ts:38/47`, `src/stages/prototype.ts:94`).
- Current: those stages map to `[]` (line 134 flatMap) → their cache rows survive every replan. Required: rows dropped when the stage is in `downstreamOf(owner)`.
- Test: (a) new `tests/replan-stage-prefix-edges.test.ts` — enumerate `pipeline.` literals in `src/stages/**` + `src/replan/**` (style of `tests/graph-edges.test.ts:56` tripwires / `tests/implementation-red-loop-edges.test.ts`) and assert each literal is covered by its owning stage's prefix or explicitly `[]`; (b) extend `tests/replan-restart.test.ts` `RESUME_ROWS` (:58) with `pipeline.debug@root#1`, `pipeline.assessment@root#1`, `pipeline.prototype.r01@root#1` and assert dropped for owner=requirements.
- Risk: `tests/replan-restart.test.ts` row-count assertions; the drift guard will also flag `pipeline.classify` (see Drift D2) and requires an explicit entry. Blast: replan invalidation + auto-resume replay across 3 stages. Deps: lands with AC-05 (same map/function).

**AC-05 — Judge/replan-lead rows always invalidated**
- Change: `src/replan/replan.ts:130-159` `invalidateResumeCache` — unconditionally union `["pipeline.judge.", "pipeline.replan."]` into `prefixes` (ids emitted at `src/stages/judge.ts:212`, `src/replan/lead.ts:109`).
- Current: no stage owns those prefixes → stale diagnoses replay post-replan. Required: every replan trigger drops them.
- Test: `tests/replan-restart.test.ts` — seed `pipeline.judge.<scope>@root#1` and `pipeline.replan.lead@root#1`; any `triggerReplanForFindings` success drops both.
- Risk: none named (no test seeds those rows today); conservative direction. Blast: judge freshness on restart only. Deps: same commit as AC-04.

**AC-06 — RED coverage expectations read task.scenarioRefs**
- Change: `src/stages/implementation.ts:175-190` `expectedScenariosForPhase` (+ `phaseTaskDescriptions` :167-173) — merge `task.scenarioRefs` for `task.phase === phaseName` (mirror `phaseScenarioRefsFor`, `src/prompts.ts:73-79`); fall back to full `spec.scenarioRefs` only when phase- AND task-level refs are both empty. Sole call site :864.
- Current: task refs never read → fallback to the FULL BDD set whenever phase refs are absent → unsatisfiable coverage-incomplete retry loop (`tddCoverageRetryHint` :197-210). Required: expected set = task-mapped subset.
- Test: new case in `tests/implementation-red-loop.test.ts` (or `tests/implementation-tdd-rust-wiring.test.ts` style) — multi-phase spec where only `tasks[].scenarioRefs` map scenarios; assert phase-1 expected set = its subset, not all scenarios (assert via the coverage verifier's missing-list / retry hint content).
- Risk: fixtures that rely on whole-spec fallback; interplay with AC-19 (task refs must survive `normalizePhases`/control) and AC-11 (phase mapping errors). Blast: implementation RED coverage gate + RED loop. Deps: **after AC-19**; conceptually after AC-11.

**AC-07 — Cleanup scan blocks every copied env variant**
- Change: `src/helpers.ts:384` `SENSITIVE_RE` — replace the env entries (`/\.env$/`, `/\.env\.local$/`, `/\.env\.production$/`) with one derived from `isEnvFile` (`src/setup.ts:40-44`, currently unexported — export it or move the predicate to a shared module) — i.e. any basename `/^\.env(\..+)?$/` except example/template/sample. Scan loop at :553-558.
- Current: `.env.development`/`.env.staging`/`.env.prod`/`.env.ci` match nothing → merge carries secrets. Required: those in `gitCarriedFiles` → `blocked: true`.
- Test: `tests/cleanup-sensitive-scan.test.ts` — `featureRepo()` fixture, commit `apps/web/.env.development` (and the other variants) on the feature branch → blocked; `.env.example` → not blocked; untracked copies still never block (existing pin).
- Risk: existing untracked-copy non-blocking pins must stay green (they do — scan is git-carried). Blast: cleanup gate only (blocked → run partial via `workflow.ts` cleanupBlocked). Deps: before AC-08 (same predicate export).

**AC-08 — Copied env files can never be staged**
- Change: `src/setup.ts:51-74` `copyEnvFilesToWorktree` — append each copied rel path to the worktree-local exclude file (resolve via `git -C <worktree> rev-parse --git-path info.exclude`).
- Current: copied env files are untracked-but-stageable → `git add -A` (`src/helpers.ts:447`) commits them. Required: excluded so `commitWorktreeChanges`, fix commits, merge commits never carry them.
- Test: new `tests/setup-env-exclude.test.ts` (or extend `tests/setup.test.ts`) — fixture repo with untracked-unignored `.env.development`; after copy + `commitWorktreeChanges`, path not staged/committed and `git check-ignore` reports it.
- Risk: integration tests that copy envs into worktrees and expect them present on disk (still present — only ignore state changes); merge-verify dirty-tree checks unaffected (untracked). Blast: setup + all pipeline commits. Deps: after AC-07; independent of AC-10 (belt-and-braces).

**AC-09 — Worktree-add failure fail-closed**
- Change: `src/setup.ts:269-278` `createOrReuseWorktree` — on `git worktree add` failure: `git worktree prune`, retry once, then throw from `runSetup` with the git stderr tail + `git worktree prune` hint. Remove the silent `return { worktreePath: cwd, worktreeCreated: false }` fallback.
- Current: any worktree-add failure silently runs the whole pipeline in the user's main checkout. Required: reject with actionable error; `skipWorktree` runs unaffected (pre-init at :315-327 keeps non-git dirs unreachable).
- Test: `tests/setup.test.ts` new case — create branch+worktree, delete the `.worktree/<id>` dir without prune → `runSetup` rejects with stderr surfaced; no in-place state produced.
- Risk: any test relying on in-place fallback after a failed add (none found — happy path + explicit `skipWorktree` only); `tests/setup.test.ts` layout tests. Blast: setup stage + tool entry (behavior change: error instead of in-place run — intended). Deps: before AC-10.

**AC-10 — commitWorktreeChanges refuses main-checkout `git add -A`**
- Change: `src/helpers.ts:433-457` `commitWorktreeChanges` — add option (e.g. `allowMainCheckout`), detect main checkout via `git rev-parse --git-dir` vs `--git-common-dir`; equal + no opt-in → `{committed:false, error:"refusing to commit in the main checkout"}` before `git add -A` (:447). Opt-in set only by `skipWorktree` callers.
- Current: commits with `git add -A` wherever pointed. Required: refuses in main checkout unless explicitly opted in.
- Test: `tests/verification-fix-commit.test.ts` — dirty main-checkout fixture → refused, index untouched; linked-worktree fixture → commits as today; opt-in honored.
- Risk: **HIGH test churn** — existing fixtures in `tests/verification-fix-commit.test.ts` (and any other suite calling this fn) run in plain temp repos (main checkouts); they must convert to real `git worktree add` fixtures or pass the opt-in. Blast: verify fix commits, escalation commits, merge path. Deps: after AC-09. See Drift D7.

**AC-11 — Wire phaseTestDeliverableErrors into gate-spec-trace**
- Change: `src/doc-validators.ts:230` in `specTraceabilityErrors` — after `errors.push(...phaseIndependenceErrors(phases, tasks))`, append `errors.push(...phaseTestDeliverableErrors(phases, tasks))` (`phases`/`tasks` already in scope at :228-229; function at :285).
- Current: `phaseTestDeliverableErrors` has zero production callers (dead code; only `tests/doc-validators.test.ts:244-273`). Required: deterministic gate failure for scenario-mapped phases with no `requireScenarios`/`requireTests`.
- Test: end-to-end in `tests/requirements-bdd-gate.test.ts` or `tests/pipeline-gates.test.ts` via `runHelper("gate-spec-trace", …)` — spec control with a scenario-mapped phase (via tasks) declaring neither deliverable → gate fails.
- Risk: every existing spec fixture whose phases map scenarios but declare no test deliverable now fails gate-spec-trace — audit `tests/doc-validators.test.ts`, `tests/pipeline-gates.test.ts`, `tests/spec-convergence.test.ts`, `tests/upstream-review-integration.test.ts` fixtures. Blast: spec convergence loop (extra rounds possible on real runs). Deps: after AC-19 (deliverables must survive normalization for the gate to see them).

**AC-12 — UTF-8-exact subprocess streaming + final-line parse**
- Change: `src/pi-spawn.ts:466-545` `runPi` — `child.stdout.setEncoding("utf8")` (and stderr) right after spawn (:465), or `StringDecoder`; `close` handler (:538) parses a non-empty residual `lineBuf` as a final NDJSON line before giving up.
- Current: per-chunk `lineBuf += c.toString("utf8")` (:493) corrupts split codepoints; residual final line dropped. Required: byte-exact reassembly; newline-less final `message_end` parsed.
- Test: `tests/pi-spawn.test.ts` / `tests/pi-spawn-control-retry.test.ts` — emit two `data` Buffers splitting a JSONL line mid-codepoint (e.g. an emoji inside the assistant text/control block) → reconstructed line byte-identical, control intact; newline-less final line still parsed.
- Risk: existing single-Buffer tests unaffected; LINE_CAP logic string-based (fine). Blast: subprocess backend only (`SUPER_DEV_BACKEND=subprocess`, browser/web agents). No deps.

**AC-13 — CommonMark fence pairing in stripNonNormativeSections**
- Change: `src/doc-validators.ts:100-124` — replace the boolean toggle at :106 with (fenceChar, fenceLen) tracking; closing line must use same char and ≥ length; an unclosed fence is implicitly closed by a `NON_NORMATIVE_SECTION_RE` heading match (fail-safe strip).
- Current: any ```/~~~ line flips `inFence` → leaks/swallows sections, re-opening the AC-/SCENARIO- self-referential trap. Required: nested/mixed/unclosed fences handled per CommonMark.
- Test: `tests/doc-validators.test.ts` (existing single-fence pin at :568-576) + new: `~~~`-outer/```-inner; ````-outer/```-inner; unclosed ``` before `## Prior Review Responses` still strips (no token leak).
- Risk: `tests/doc-validators.test.ts` strip pins. Blast: all doc-gate token extraction (spec + BDD via AC-26). Deps: same commit as AC-25 (same function); before AC-26.

**AC-14 — BDD coverage summary computed or omitted**
- Change: `src/render/templates/bdd-scenarios.md.njk:36-42` + `src/render/render.ts:62-72` `augmentData` — compute `covered` = distinct AC ids referenced by ≥1 `scenario.acRef` ∩ AC set; `Uncovered` = actual difference; omit the whole Coverage Summary block when `traceability` absent/empty.
- Current: renders literal `Covered: {{ totalACs }}` / `Uncovered: 0` where `totalACs = traceability?.length ?? 0` (render.ts:69) — self-reports full coverage always. Required: computed numbers or no block.
- Test: `tests/render.test.ts` — render `bdd` with 20 scenarios, no `traceability` → no coverage line; partial traceability → `Uncovered: N` equals computed difference.
- Risk: `tests/render.test.ts` bdd output pins; `tests/docs-contracts.test.ts` may pin template sections. Blast: rendered doc text only (gates use `bddTraceabilityErrors`, unaffected). No deps.

**AC-15 — Tracker path parity (quotepath + Windows separators)**
- Change: `src/tracking.ts:128` — `s.replace(/\\\\/gu, "/")` (matches TWO backslashes) → `/\\/gu` (one), aligning with `tests/test-artifacts.ts:83`'s `normalizePath`; `gitSpawn` (:387-400) — prepend `-c core.quotepath=false` to every invocation (`["-c","core.quotepath=false","-C",this.worktreePath,...argv]`) so :328/:333 emit raw paths.
- Current: non-ASCII/quoted paths C-quoted by git never match claims → false `claimedNotChanged` → false-red change-gate loop; single-backslash Windows paths never normalized. Required: like-for-like comparison.
- Test: `tests/tracking.test.ts` / `tests/change-tracker-nonregression.test.ts` — `normalizeTrackerPath("src\\team\\types.ts") === "src/team/types.ts"`; real-git fixture creating `src/图表.ts`, claiming it → `computeCrossCheck.claimedNotChanged` empty (verdict `ok`).
- Risk: existing pins on double-backslash conversion (superset — stays green); `tests/compute-change-gate.test.ts`. Blast: phase change gate (implementation loop). Deps: none; sibling of AC-32.

**AC-16 — readSpecDoc spec-dir containment**
- Change: `src/doc-validators.ts:356-376` `readSpecDoc` — `resolve(specDir, p)` accepted only when it starts with `specRoot + sep` (mirroring `src/render/user-notes.ts:83`); else log once and fall through to the glob.
- Current: any existing filesystem path from LLM control is read verbatim (wrong-CWD relative resolution, out-of-repo reads, old-run doc substitution). Required: contained paths only.
- Test: `tests/doc-validators.test.ts` + `tests/doc-path-idempotency.test.ts` — `docPath` pointing at an existing file outside specDir returns the globbed doc; relative `docPath` resolves against specDir, never process CWD.
- Risk: **audit existing fixtures** — any test passing a real tmpdir docPath that is not inside its specDir breaks (`doc-validators`, `helpers`, `requirements-bdd-gate`, `upstream-review-integration` tests often write docs to a temp dir and pass absolute paths — many will need `specDirectory` set to the doc's parent). Blast: every doc gate. No deps.

**AC-17 — Extension re-clamped to 3× ceiling; fresh-round arming**
- Change: `src/stages/artifact-convergence.ts:331-339` — `effectiveCap = Math.min(effectiveCap + PROGRESS_EXTENSION_ROUNDS, maxRounds * MAX_TOTAL_ROUND_MULTIPLE)`; keep `effectiveRoundCap` (:258-259) but guarantee `effectiveCap` never exceeds `3 × maxRounds` even when `priorRounds ≥ 3×cap`; arm the extension only after the first FRESH (cache-miss) review reading (reset `prevOwnOpen/lastOwnOpen` to ∞ until a fresh reading; replay must not grant it); fatal message already reports `effectiveCap` at :357 (the J10 judge FatalAbort at :323 still says `maxRounds` — fix per adv-B/B4 disposition).
- Current: `effectiveCap += 4` unclamped (:337) → multi-resume runs exceed 3× or die during replay with zero fresh rounds. Required: ceiling always wins; extension only on fresh progress; ≥1 fresh round before fatal.
- Test: `tests/artifact-convergence.test.ts` (existing `effectiveRoundCap` pins :174-184 stay valid) + new simulated multi-resume loop test: `priorRounds ≥ 24` for cap 8 → fatal only after ≥1 fresh writer round; `effectiveCap === 24` at `priorRounds ≥ 24`; extension never granted on replayed readings.
- Risk: convergence-loop tests around the cap/extension (`tests/artifact-convergence.test.ts`, `tests/spec-convergence.test.ts`). Blast: all four artifact-convergence loops' termination. Deps: independent; sequenced Phase 6 to avoid conflicts with AC-18/34 edits in the same file.

**AC-18 — Replan requests consumed only on genuine approval**
- Change: `src/stages/artifact-convergence.ts:483` — compute `genuineApproval = reviewVerdictApproves(reviewControl?.verdict)` (drop the `|| downgraded > 0` term for this signal only) and gate `consumeReplanRequests` (:567) and the verified-flip for `detectedAtStage === "replan"` findings (:563 predicate) on it; mirror in `src/stages/spec-convergence.ts` — `genuineApproval = review.pass`, gate :294 consumption and the :286 flip's replan branch.
- Current: duty-override (`downgraded > 0`) counts as approval → replan requests flip to `addressed` with nobody verifying. Required: duty override may converge the loop but never consume/close a request.
- Test: update `tests/replan-restart.test.ts:157-225` (NFR-1-sanctioned pin flip, citing M8): pending request + round-3 verdict `"Changes Requested"` whose only blocking finding is a NEW unrelated medium item (downgraded) → request stays `pending`. Add the same shape to `tests/spec-convergence.test.ts`.
- Risk: `tests/replan-restart.test.ts` (pin flip), `tests/spec-convergence.test.ts` approval paths. Blast: replan lifecycle + both convergence loops. Deps: none hard; land after AC-34 (same files, adjacent logic) to keep diffs reviewable.

**AC-19 — normalizePhases preserves fields on every coercible shape**
- Change: `src/doc-validators.ts:430-431` branch (b) — return `[{ ...obj, name: obj.name.trim(), description: typeof obj.description === "string" ? obj.description : "" }]`; string coercion (:437-443) — split on newlines/semicolons/bullets only (remove `,` from the split set).
- Current: single-object phase drops `scenarioRefs`/`deliverables`; one-line comma strings create phantom phases. Required: fields round-trip; `"Phase A, Phase B"` → one phase.
- Test: `tests/doc-validators.test.ts` normalizePhases describe — `{name, description, scenarioRefs, deliverables}` round-trips all fields; comma-line yields 1 phase.
- Risk: existing normalizePhases pins (comma-split, reconstructed `{name, description}` shape) and `helpers.ts gateSpecTrace` coercible-shape tests (F6 zero-round contract) — audit for deep-equality on the reconstructed object. Blast: spec gate + implementation phase/deliverable reads. Deps: **before AC-06 and AC-11**.

**AC-20 — Non-routable deferred findings survive replan**
- Change: `src/stages/verify.ts:1205-1215` dead-state path — when `maybeTriggerReplan` (:1207) fires, persist the non-routable deferred/needs-human findings into `replan-requests.json` as `ownerStage: "human"`, `status: "pending"` (extend `triggerReplanForFindings` in `src/replan/replan.ts:212-340` or write alongside); `consumeReplanRequests` (:353-374) never consumes `ownerStage === "human"` rows; remove `deferred.slice(0, 6)` (:1213) and the escalation visibility caps (:940, :951 `findings.slice(0, 12)`; also :887-888, :914, :942 deferred caps).
- Current: non-routable items exist nowhere machine-readable once replan fires; HITL visibility capped at 6/12. Required: all deferred items persisted + fully listed in `__stagnated`.
- Test: `tests/verify.test.ts` + `tests/replan-restart.test.ts` — verdict `"Changes Requested"` with 2 routable + 3 needs-human findings → `replan-requests.json` holds 2 stage rows + 3 human rows; HITL path `__stagnated.findings` lists all deferred items.
- Risk: `tests/replan-owners.test.ts` (closed `REPLAN_OWNER_STAGES` — see Drift D4: `ReplanOwnerStage` at `src/replan/owners.ts:23` excludes `"human"`; widen the persisted field's type, not the classifier's), request-count assertions, extension resume-log tests. Blast: replan persistence + verify HITL + extension resume. Deps: after AC-18 (consumption semantics) and AC-04/05 (same file cluster).

**AC-21 — Fresh entry truncates stale resume cache**
- Change: `src/setup.ts` `runSetup` — on non-resume entry into an existing track (`reusedTrack === true` or the `taskSpecIdentifier` path), truncate `<specDirectory>/.resume-cache.jsonl` (write `""` — mirrors `clearKnowledge` semantics; do NOT use `clearResumeCache` in `src/resume.ts:66-74`, it also writes the `.complete` marker); `options.resumeSpecIdentifier` keeps the cache intact.
- Current: occurrence counters start empty → fresh `#1` rows appended next to a dead run's `#2/#3`; `loadResumeCache` last-wins (`src/resume.ts:50-64`) replays stale rows. Required: superseding run never mixes generations.
- Test: `tests/setup.test.ts` + `tests/resume.test.ts` — seeded `pipeline.requirements@root#2/#3` rows gone after a fresh referenced-spec entry; preserved after a resume entry.
- Risk: `findReusableSpec` eligibility uses `isResumable` (non-empty cache, `src/resume.ts:88`) — truncate AFTER selection, never before; resume-path tests. Blast: setup + resume replay. Deps: same commit as AC-02 (same branch; AC-02 sets the flag AC-21 keys on).

**AC-22 — pytest usage errors are broken, not red**
- Change: `src/build-runner/gates.ts:1119-1128` python branch of `classifyRedStatus` (fn at :1102) — return `"broken"` for `ERROR: file or directory not found`, `ERROR: usage`; require a failure marker (`/^FAILED\b/m`, `/AssertionError/`, `/^E\s{2,}/m`, `/\d+ failed/`) before `"red"`; drop the bare `/\berror\b/` red.
- Current: `/\bfailed\b/ || /\berror\b/` → any usage error (exit 4, phantom test path) blesses RED. Required: infra failure ≠ RED.
- Test: `tests/red-oracle.test.ts` — pytest output `ERROR: file or directory not found: tests/test_x.py` → `broken`, never `red`. Fixture shape: direct `classifyRedStatus("python", out, false)` calls (export it or test via the red-check path).
- Risk: `tests/red-oracle.test.ts` python pins relying on the loose `error` match. Blast: RED oracle → RED boundary → implementation RED loop. Deps: none. **Note the exit-code-4 clause needs a signature/ctx change** — see Drift D3.

**AC-23 — SIGTERM→SIGKILL escalation + bounded settle**
- Change: `src/pi-spawn.ts:483` (abort path) and :486-490 (timeout path) — after SIGTERM arm `SIGTERM_GRACE_MS = 10_000` watchdog → `child.kill("SIGKILL")`; settle the promise within `SETTLE_GRACE_MS = 5_000` of the kill (resolve/reject with `"killed after SIGTERM+SIGKILL"`) so pipe-holding grandchildren can't stall the `close`-only settlement (:538). Export both constants (NFR-3).
- Current: SIGTERM only; promise settles only on `close` → hangs possible. Required: bounded termination.
- Test: `tests/pi-spawn.test.ts` — fake child ignoring SIGTERM; `runPi` settles with the kill error within the bound; cleanup (temp dir removal) runs.
- Risk: timeout-path tests asserting the current `"timed out"` resolution shape. Blast: subprocess backend abort/timeout only. Deps: with AC-12 (same function).

**AC-24 — Service teardown SIGKILL + abortable readiness**
- Change: `src/stages/lifecycle.ts:131-141` `stopService` — SIGTERM to the group, then SIGKILL to the group after a grace constant; `waitForReady` (:56) — accept an `AbortSignal`, pass to `fetch`, break the poll loop on abort; `tryStartService` (:208) — check the signal between candidates.
- Current: one SIGTERM then give up; polling continues up to ~12s × candidates after abort. Required: forced teardown; abort-aware bringup.
- Test: `tests/lifecycle.test.ts` — server script trapping SIGTERM → SIGKILLed (port released); aborted signal stops polling within one iteration.
- Risk: `tests/lifecycle.test.ts` real-server fixtures (must tolerate group-SIGKILL). Blast: verify integration bringup/teardown. No deps.

**AC-25 — Non-normative heading vocabulary + honest comment**
- Change: `src/doc-validators.ts:91` `NON_NORMATIVE_SECTION_RE` — accept optional word-led qualifier (`## Evidence Notes for Phase 2`, `## Prior Review Responses Round 3`) and heading levels 1–4 (`#{1,4}`), keeping the closed-set anchor so `## Convergence Criteria` never strips; rewrite the stale comment at :82-90 (it claims "for Phase 2" strips — it doesn't).
- Current: word decorations and H1/H4 headings don't strip (verified: regex terminates with `(?:\s*[(:—–-].*)?$`). Required: decorated variants strip; comment states the rule.
- Test: `tests/doc-validators.test.ts:543-557` — **pin flip** (NFR-1/OQ-2 sanctioned, cite M14): both decorated variants strip; `## Convergence Criteria` still does not.
- Risk: the pin flip itself; over-stripping guard is the `Convergence Criteria` test. Blast: all doc-gate token extraction. Deps: same commit as AC-13; before AC-26.

**AC-26 — gate-bdd runs on stripped content**
- Change: `src/doc-validators.ts:168-181` `bddTraceabilityErrors` — apply `stripNonNormativeSections` to both inputs (or at the call site `src/helpers.ts:133`).
- Current: raw content — BDD prose quoting a removed AC trips the dangling check. Required: parity with `specTraceabilityErrors` (:183-186).
- Test: `tests/requirements-bdd-gate.test.ts` or `tests/doc-validators.test.ts` — BDD doc with `## Evidence Notes` quoting dangling `AC-99` → no dangling-AC error.
- Risk: gate-bdd fixtures with response sections (currently pass — only break if they quote dangling ACs, which is the point). Blast: gate-bdd only. Deps: after AC-13 (strip correctness).

**AC-27 — Schema rejects unparseable AC ids**
- Change: `src/render/schemas.ts:51` `AcceptanceCriterion.id` and :20 `BddScenario.acRef` — add `Type.Pattern(/^AC-\d{2,}$/)`.
- Current: any string passes render; the BDD gate then fails on missing AC-NN tokens (render-accepts/gate-rejects divergence). Required: `renderAndWrite` fails validation (retry with feedback) before a doc is written.
- Test: `tests/render.test.ts` — requirements control with ids `["1","2"]` fails validation; `["AC-01","AC-02"]` passes and renders gate-parseable tokens.
- Risk: **fixture audit** — any suite emitting 1-digit AC ids (`AC-1`) now fails render; check requirements/bdd fixtures in `tests/render.test.ts`, `tests/requirements-bdd-gate.test.ts`, workflow-level fixtures. Blast: requirements/BDD render + spec convergence rounds. No deps.

**AC-28 — Negated verdicts never approve**
- Change: `src/stages/artifact-convergence.ts:238-243` `reviewVerdictApproves` and `src/doc-validators.ts:461-469` `isApprovedVerdict` — add the negation guard (`\b(not|never|no|cannot|can't|won't|doesn't?|does not|isn't)\s+(approved?|pass(?:ing|es|ed)?|accepted?)\b`, plus `approved?\s*[:=]\s*no`) before the approve-family match.
- Current: "not approved"/"does not pass" match `\b(approved|pass|accept)\b` → approve. Required: negations return false; approve family unchanged.
- Test: verdict tables in `tests/artifact-convergence.test.ts` + `tests/doc-validators.test.ts` (and the `isApprovedVerdict` cases feeding `gate-spec-review`/`gate-review`): `{"not approved","does not pass","not passing","approved: no"}` → false; `{"Approved","Approved with Comments","APPROVED WITH REVISIONS"}` → true.
- Risk: verdict-vocabulary pins in doc-validators/helpers tests (e.g. `REVISIONS NEEDED` rejection cases stay green). Blast: upstream reviews + spec review gate + merge-verdicts fallback. Deps: with AC-01 (same semantic cluster; different files).

**AC-29 — Second execute refused; run dir captured once**
- Change: `src/extension.ts:663-668` — replace the `if (activeRun != null) setActiveRun(null)` discard with an `inFlight` guard returning an `isError` ToolRunResult ("a super-dev run is already active"); clear in the existing `finally` (:768-784 already nulls `activeRun`/tracker). Thread the run dir once: `src/render/reflection.ts:27-40` `runReflectionAsync`/`runReflection` capture the dir at entry and pass it explicitly to `updateStats`/`cleanupOldRuns`/`auditAppend` (currently lazy `getAuditPath()` after awaits); `src/render/super-dev-dir.ts` `startRun` no longer read mid-flight.
- Current: overlapping execute silently steals input routing + tracker; async reflection writes stats/audit into run B's files. Required: refuse second run; per-run-captured paths.
- Test: `tests/extension-*.test.ts` (entry-renderer/inherit/escalation) — in-flight second execute refused, first run's routing untouched; reflection completing after a second `startRun` writes to run A's files (new focused test in `tests/render/super-dev-dir.test.ts` or a reflection test).
- Risk: extension tests that call execute twice sequentially (fine — flag clears in finally); `tests/self-improving.test.ts` (reflection). Blast: tool entry + reflection/stats. Deps: none.

**AC-30 — Spec-dir run lock**
- Change: `src/setup.ts` `runSetup` — acquire `<specDirectory>/.run-lock` via `openSync(…, "wx")` (pid+timestamp); live pid (`process.kill(pid, 0)`) → actionable error naming the holder; stale → replace; remove in the run's `finally` (extension.ts :768 finally or stage teardown). Add `.run-lock` to `HARNESS_BOOKKEEPING_FILES` (`src/helpers.ts:461-468`) and `INTERNAL_RUNTIME_CLAIM_BASENAMES` (`src/tracking.ts:140`) so it never trips gates or the dirty-tree check.
- Current: two terminals can resume the same spec dir — interleaved ledgers, lost knowledge updates. Required: exclusive lock with stale stealing.
- Test: `tests/setup.test.ts` — live-pid lock → clear error; dead-pid lock → stolen; lock absent after a completed run.
- Risk: any test invoking `runSetup` on a shared dir (tests use mkdtemp — safe); parallel vitest workers each get their own dir. Blast: setup + gate exemption sets. Deps: after AC-04/05 (single touch of exemption sets is nice-to-have, not required).

**AC-31 — Untrusted text fenced in every prompt**
- Change: `src/prompts.ts` — all ~12 builders interpolating `ctx.task` raw (`buildClassifyPrompt`:142, `buildRequirementsPrompt`:159, `buildBddPrompt`:162, `buildResearchPrompt`:167, `buildDebugPrompt`:186, `buildAssessmentPrompt`:191, `buildDesignPrompt`:195, `buildPrototypePrompt`:213, `buildSpecPrompt`:221, `buildCodeReviewPrompt`:441, `buildAdversarialPrompt`:444, `buildTestsReviewPrompt`:457) + `renderRetryFeedbackBlock` (`src/retry-feedback.ts:47+`) + judge/TDD-coverage snippet interpolation — wrap untrusted content (task, finding title/detail, file snippets) in a labeled DATA fence with a standing preamble line; fence length escalation: 4 backticks when the payload contains a 3-backtick run, `max(4, longest+1)` otherwise; strip/neutralize `^#` heading lines outside the fence.
- Current: raw interpolation — task text is structurally indistinguishable from harness instructions (only `summarizeSlug` quotes it, `src/session-agent.ts:425`). Required: data/instruction separation that untrusted text cannot break.
- Test: `tests/prompts.test.ts` + `tests/prompt-control-contracts.test.ts` — task containing `\n## Instructions\n…` AND a literal ``` fence run appears wholly inside the escalated fence with the preamble present in EVERY builder's output; no raw `## ` heading and no payload ``` line outside it.
- Risk: **largest test churn in the spec** — every exact-output prompt pin: `tests/prompts.test.ts`, `tests/prompts-tdd-*.test.ts`, `tests/prompts-cargo-verify-discipline.test.ts`, `tests/prompt-control-contracts.test.ts`, plus golden strings inside workflow/stage tests. Blast: all agent prompts (semantics unchanged for benign tasks). Deps: last (isolates churn).

**AC-32 — Gitignored claims downgrade to advisory**
- Change: `src/tracking.ts:494-510` `computeCrossCheck` — a claimed path that exists on disk and is git-ignored (`git check-ignore -- <path>`) → recorded in a new `ignoredVerified: string[]` advisory field, never `claimedNotChanged`; tracked-but-unchanged stays `claimed-miss`.
- Current: git never lists ignored files → permanent false `claimed-miss` → phase retry deadlock. Required: existence-verified advisory for ignored paths.
- Test: `tests/compute-change-gate.test.ts` + `tests/change-tracker-nonregression.test.ts` — gitignored `public/schema.json` created + claimed → no claimed-miss, advisory recorded; non-ignored unchanged claim → still claimed-miss.
- Risk: `computeCrossCheck` is synchronous (`spawnSync` gitSpawn — `check-ignore` fits but adds per-path spawns; batch with `git check-ignore --stdin` if needed); pinned claimed-miss verdicts for genuinely missing files stay green. Blast: phase change gate (false-red fix). Deps: sibling of AC-15 (same file; land together).

**AC-33 — Mid-run notes size-capped**
- Change: `src/render/user-notes.ts:127` `appendUserNotes` (drain/persist time) — truncate to `MAX_USER_NOTE_BYTES = 16_384` bytes: first 8192 + `\n…[truncated N bytes]…\n` + last 8192; export the constant; `userNotesForAgent` (:164) then never injects more.
- Current: unbounded notes persisted and prepended to every subsequent prompt (`workflow.ts` drain). Required: head+tail capped form everywhere.
- Test: `tests/user-notes.test.ts` — 1 MB note persists as the truncated form; injected block contains only that form.
- Risk: `tests/user-notes.test.ts` exact round-trip pins (short notes unchanged — stay green). Blast: prompts + extension drain. No deps.

**AC-34 — Duty/merge never de-fang a blocking restatement**
- Change: (a) `src/review-findings.ts:157-181` `enforceReviewerConvergenceDuty` — extend the shield at :175: treat as re-flag (skip downgrade) any finding whose convergence fingerprint (same `ownerStage+sourceGate+title+detail` inputs as `src/convergence-ledger.ts:232`) matches a currently-blocking ledger finding, or whose own `id` is in `knownFindingIds`; (b) `src/convergence-ledger.ts:282-297` merge — preserve MAX severity class and `blocking = true` if either side blocks (no last-write-wins clearing at :284-285).
- Current: a verbatim restatement with drifted severity "medium" is downgraded, then the fingerprint merge overwrites the high blocker to advisory → loop approves with an unresolved defect. Required: restatements stay blocking; merges never weaken.
- Test: `tests/convergence-ledger-review-findings.test.ts` + `tests/spec-convergence.test.ts` — high blocking blocker restated verbatim at round ≥3 with severity "medium" stays blocking; loop does not approve.
- Risk: ledger merge pins (last-write-wins cases), `R2-G1-PRIORFINDING-RESURRECTION` regression tests (re-flagged advisory re-earning blocking — keep green; the shield change must not resurrect advisories). Blast: convergence duty + ledger + approval in both convergence files. Deps: with AC-35 (same module); before AC-18 review-ordering.

**AC-35 — Explicit signals outrank inferred prose status**
- Change: `src/review-findings.ts:43-55` `reviewFindingBlocks` — the clearing-status checks (`verified/addressed/resolved/fixed/deferred…`) use only the EXPLICIT status (`normalizeReviewFindingStatus(finding.status)`); `inferReviewFindingStatus` prose scan (:20-31) applies only when the finding has neither an explicit status nor `blocking === true` nor a high-class severity. Mirror in `reviewFindingBlocksVerdict` (:66-82) if it inherits the inference.
- Current: `{severity:"critical", blocking:true, title:"Deferred: …"}` (no status) infers `deferred` → non-blocking. Required: explicit blocking flag + high severity win; inference only for signal-free findings.
- Test: `tests/convergence-ledger-review-findings.test.ts` — `{severity:"critical",blocking:true,title:"Deferred: purge job lacks a dry-run guard"}` stays blocking; a prose-verified finding with no explicit signals still infers as today.
- Risk: `triageReviewFindings` (`src/helpers.ts:320-368`) calls `inferReviewFindingStatus` directly — status-only there, unaffected; existing inference pins. Blast: verdict pinning, triage, duty. Deps: with AC-34.

## Drift / contradiction findings

- **D1 — AC-34 cites `convergence-ledger.ts:186` for the fingerprint; the actual `stableHash` fingerprint is at `convergence-ledger.ts:232`, and the merge overwrite is at :282-297 (dossier said 222-236).** Line drift only; the premise holds.
- **D2 — AC-04's drift guard will flag `pipeline.classify` (`src/stages/writers.ts:281`), which the dossier never mentions.** It matches no prefix. Functionally harmless (`classify` is never inside a `downstreamOf(owner)` set — its only inbound edge is `setup→classify`, and owners are ≥ requirements), but the guard as specified requires an explicit `classify: ["pipeline.classify"]` (or deliberate `[]`) entry — decide and pin it.
- **D3 — AC-22's "exit code 4" clause doesn't fit the current signature**: `classifyRedStatus(language, combined, ok, ctx?)` (`src/build-runner/gates.ts:1102`) receives only the boolean `ok`; the exit status lives at the call site (`gates.ts:1460`, `r.status`). Either extend the signature/ctx with `exitCode`, or implement exit-4 detection purely via the `ERROR: file or directory not found` / `ERROR: usage` markers (pytest prints both) — recommend the marker-only route to avoid a signature change rippling through `tests/red-oracle.test.ts`.
- **D4 — AC-20's `ownerStage: "human"` collides with the closed type**: `ReplanOwnerStage = "requirements" | "bdd" | "research" | "design" | "spec"` (`src/replan/owners.ts:23`); the classifier's `owner` may be `"human"` but the routable filter (`replan.ts:276`) excludes it and `ReplanRequest.ownerStage` is typed `ReplanOwnerStage`. The human rows need the persisted field widened (e.g. `ReplanOwnerStage | "human"`) without admitting "human" into `REPLAN_OWNER_STAGES` routing.
- **D5 — AC-20 names two visibility caps; the file has five.** `verify.ts:1213` (`deferred.slice(0,6)`), plus `:887-888` (`deferredVisibility` slice(0,6)), `:914`/`:942` (`slice(0,8)`), and `:940`/`:951` (`findings.slice(0,12)` in escalation evidence/`__stagnated`). Implement "remove the caps" against all five sites or the contract is only half-delivered.
- **D6 — AC-10 vs existing fixtures (contradiction, not code drift)**: `commitWorktreeChanges` is called in tests against ordinary `git init` temp dirs — i.e. main checkouts. The refusal default will fail those unless fixtures move to real `git worktree add` layouts or pass the opt-in. Budget test-churn for `tests/verification-fix-commit.test.ts` (and audit `tests/merge-verify.test.ts`).
- **D7 — AC-16 similarly will break fixtures** that pass absolute docPaths living outside the fabricated `specDirectory` (doc-validators/helpers/requirements-bdd-gate tests). Each such test needs its spec dir set to the doc's parent (the glob then finds it) — behavior-correct, fixture-visible.
- **D8 — AC-27's `/^AC-\d{2,}$/` is stricter than the gates' own extractor** (`/\bAC-(\d+)\b/` normalizes any digit count, `doc-validators.ts:66-68`). That asymmetry is intentional (render rejects what gates tolerate today), but any fixture emitting `AC-1` breaks; audit before landing.
- **D9 — Dead-code / premise check**: no AC is better solved by deleting code than by its named change. The only deletion is disposition-level: `waitForEvent` (`src/nodes.ts:624-646`) — confirmed zero production callers, leaks its abort listener; delete + drop its export (NFR-5 names it). `phaseTestDeliverableErrors` is dead **and must be wired, not deleted** (AC-11). AC-09 is the one AC implemented partly by *deleting* a branch (the silent in-place fallback) — consistent with the fail-closed recommendation.
- **D10 — AC-17's "terminal message reports the effective cap" is already true for the round-cap fatal** (`artifact-convergence.ts:357` uses `effectiveCap`); the offender is the **J10 judge escalate-now fatal at :323**, which still reports `maxRounds` — that line (plus the adv-B/B4 evidence requirement for cap-judge escalation) is the actual fix target.
- **D11 — Dossier H1's downstream refs check out** (`verify.ts` `fixStepReview` at :775; `reviewApproved` logic in the attempt loop at :1198-1200), and `pipeline.integration.*` call-ids (`verify.ts:445,1067,1091,1139`) are already covered by the existing `verify` prefix — no gap there beyond the AC-04/05 items.
- **D12 — Test-count reference**: `01-requirements.md` says "146 files / 2141 tests"; the tree currently has ~130 files under `tests/` plus colocated `src/*.test.ts` — re-count at implementation time for the NFR-2 wording.