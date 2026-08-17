# Convergence Loop Team Dynamics — Root-Cause Fixes

Status: implemented (this commit — v0.1.98)

Date: 2026-08-17 · Version target: 0.1.98

## Evidence base

`~/.super-dev/runs/2026-08-17T*` (STEP E2E Test Dashboard on `macotestdashboard`):
11 runs, ~10.75 h, **zero reached Stage 9 Implementation**. Failure modes:

| RC | Symptom (runs) | Mechanism (code) |
|---|---|---|
| RC1 | BDD loop burned 8 rounds, each resolving prior findings + raising 1 new one, then FATAL (02:16) | Cap counts rounds, not progress; terminal action is FatalAbort; reviewer has no convergence duty |
| RC2 | Resume replayed the identical failure in 4 s — guidance never reached an agent (02:47, 06:02) | `createMemoizingAgent` occurrence counter is process-local; resumed run replays rounds 1..8 then hits `round > cap` before any fresh call |
| RC3 | Upstream-owned blockers (owner=requirements) spun BDD rounds 5–8 headless; design loop looped; user cancelled (08:56, 08:09) | `makeEscalate` headless → returns `undefined` → loop silently continues; `ownerStage` recorded but nothing routes back; replan circuit exists but is wired ONLY to Stage 10 verify |
| RC4 | Judge diagnosed "owned by requirements, loop has no authority" twice → `verdict DISCARDED — route "escalate-now" requires at least 1 evidence item` (08:56) | `verifyJudgeEvidence` discards escalate-now verdicts with zero evidence — the exact route that needs no quotes |
| RC5 | Trace gate failed 8× on `AC-24, AC-27, AC-29` which existed only in Prior-Review-Responses prose explaining their removal (04:20, 05:46, 05:48) | `specTraceabilityErrors` regexes the WHOLE rendered doc including response/evidence prose; retry feedback re-quotes the tokens so the writer re-emits them |
| RC6 | `spec.phases must be a non-empty array` ×5 rounds ≈ 25 min (06:39) | Malformed control JSON; no coercion; corrective re-prompt lacks the exact shape |
| RC7 | `APPROVED WITH REVISIONS` + zero blocking findings → rejected → FATAL (05-verification run 00:52) | `isApprovedVerdict` blanket-rejects any verdict containing "revision" |

## Research grounding

- **Infinite agentic loops** (arXiv 2607.01641, IAL-Scan): a bound is only effective at the runtime scope of the feedback path; detect state signals (growth/fix progress) rather than relying on model self-termination; caps+timeouts on repair paths.
- **Refine-n-Judge** (arXiv 2508.01543): judge pairwise-preference stop + hard cap; judge self-consistency collapses toward ~50% after ~4 refinement rounds → late-round "new blocking findings" are noise-prone; stop/approve when refinement no longer improves.
- **Verification-loop practice** (industry): hard cap 5–6 rounds, separate reviewer prompts, oscillation avoidance, two-pass review.
- **Durable execution** (AWS/Temporal): checkpoint only successful work; replay resumes AFTER the failure with fresh execution; branch on checkpointed (persisted) state, not process-local counters.
- **Plan-and-execute replan** (LangGraph): replan node + conditional edge re-enters planning WITHOUT re-executing completed steps — converged stages replay, invalidated suffix re-runs (exactly the existing R3/R4 replan circuit design).
- **Convergence-stall rule** (AgenticFlow/aiwatch): same finding category 3 consecutive rounds → stop the loop and address the root cause (our signature-stall detection).

## Key insight

The repo ALREADY contains a bounded cross-stage replan circuit (`src/replan/replan.ts`):
R2 owner classification → R3 persisted `replan-requests.json` + run status `replan` → extension auto-resume → R4 resume-cache invalidation for owner + `downstreamOf(owner)` → R5 budget (2). The owning convergence nodes already inject pending requests at round 1 and verify them on approval. **It is only triggered from Stage 10 verify.** The single highest-leverage fix is wiring it into the convergence loops' upstream-owned-blocker and cap-exhaustion paths.

## Fixes

### F1 (RC3) — Wire the replan circuit into convergence loops
- Extract `triggerReplanForFindings(state, ctx, findings, sourceStage, runId)` from `maybeTriggerReplan` (which becomes a verify-only wrapper reading `review.deferredFindings`).
- `artifact-convergence.ts`: upstream-owned branch — when HITL escalation yields NO decision (headless/dismissed/budget-exhausted) → attempt replan with the upstream blocking findings; on success `throw FatalAbort(...replan...)` — the `__replan` marker makes `workflow.ts` derive status `replan` (it already precedes the aborted→failed branch) and the extension auto-resumes. At ROUND CAP: if upstream blocking findings exist → replan before the fatal.
- `spec-convergence.ts`: track the upstream-owned blocking signature; if non-empty and unchanged across 2 consecutive review rounds → replan (the spec writer had its chance in round 1 of that pair). At cap: same replan-first rule.
- Guard: never double-trigger (`__replan` early return in the trigger core).

### F2 (RC1) — Progress-aware round caps + reviewer convergence duty
- Track the stage's own open-blocking count per round. At cap: if the last round shows strict progress (count strictly decreased) and the loop hasn't extended yet → extend by +4 once (bounded by the research-backed hard ceiling: never more than 3× base cap overall).
- Reviewer prompts (`buildUpstreamReviewPrompt`, `buildSpecReviewPrompt`) gain an explicit convergence contract: do not introduce NEW blocking findings in later rounds unless High/Critical correctness defects that would break implementation; when prior blocking findings are resolved and only advisory items remain, return Approved/Approved-with-Comments; never re-flag resolved findings unless regressed (use priorFindingId).

### F3 (RC2) — Resume continues past the failed round (durable-execution semantics)
- `resume.ts`: `createMemoizingAgent` seeds occurrence counters from the preloaded cache (max `#N` per `callId@scope`) — the resumed run replays rounds 1..k as cache hits and the k+1-th call is FRESH (the persisted state is the branch input, matching AWS determinism guidance).
- Convergence loops read `countStageRounds(specDir, writerCallId)` once at entry; effective cap = `min(priorRounds + maxRounds, 3 × maxRounds)` so each resume grants a fresh round budget with a hard cumulative ceiling. Converged stages still replay and approve without extra rounds.

### F4 (RC4) — Judge: escalate-now without evidence degrades to escalate, never discard
- `verifyJudgeEvidence` failure with `route === "escalate-now"` → log `unverified escalate accepted` and treat as `escalate` (the diagnosis is the product; evidence quotes are only mandatory for continue/keep-going routes). Fabricated-evidence `continue` verdicts still discard.

### F5 (RC5) — Trace gate reads normative sections only
- New `stripNonNormativeSections()` in `doc-validators.ts`: drop `## Prior Review Responses`, `## Review Responses`, `## Convergence*` sections (heading → next `## `) before AC-/SCENARIO-id extraction in `specTraceabilityErrors` (applied symmetrically to spec and BDD content).
- `setSpecFeedback` guidance addition: refer to out-of-range identifiers generically ("out-of-range AC") — never re-quote the tokens.

### F6 (RC6) — Structural repair for malformed spec control output
- `normalizePhases` coercion: `{phases:[…]}` wrapper, numeric-key object maps, single-phase object.
- `spec-convergence.ts`: after 2 consecutive IDENTICAL structural errors, append an exact-JSON repair block (phases/tasks shape) to the retry feedback.

### F7 (RC7) — One approve-verdict contract everywhere
- `isApprovedVerdict` accepts approve-family verdicts ("Approved with Revisions", "Approved with minor revisions") while still rejecting explicit rejections ("REVISIONS NEEDED", "Changes Requested", "Rejected", …); blocking findings remain independently blocking (AND-ed at call sites, mirroring `reviewVerdictApproves`).
- `normalizeReviewVerdict`/`VERDICT_RANK`: fold approve-family variants into "Approved with Comments".

## Verification
- Unit tests per fix (new cases in existing suites: `artifact-convergence.test.ts`, `spec-convergence` tests, `resume`/`replan` tests, `judge` tests, `doc-validators` tests, `helpers` gate tests).
- `npm run typecheck` + `vitest run` green.
- Version 0.1.97 → 0.1.98 (`src/version.ts`, `package.json`, `package-lock.json`) in the same commit.

## Review outcome (2026-08-17)

Both in-repo reviewers ran on the working tree (spawned per pi-spawn contract:
role file as system prompt, `--mode json`, source-read-only).

**adversarial-reviewer — CONTEST** (terminated cleanly): confirmed the
termination story (double-bounded replan auto-resume, cache-key prefix
semantics, FatalAbort+`__replan` ordering) and found 3 defects + 5 low risks:
- F7-GATE-BYPASS (high): gate-spec-review tests only the verdict — approve-family
  verdicts with blocking findings would pass. **Fixed**: spec-convergence now ANDs
  `!reviewHasBlockingFinding(state.specReview)` (mirrors artifact-convergence).
- F6-HINT-DEAD-CODE (medium): tolerant-reader note still failed the gate; repair
  hint keyed on a string the coercion stopped emitting. **Fixed**: coercible
  shapes PASS gate-spec-trace outright; writerTask normalizes the control BEFORE
  render (normalizeSpecControl) so docs regenerate and control/docs/implementation
  agree; repair hint retained for uncoercible shapes.
- TESTS-MISSING (medium): **Fixed** — F1/F2/F3/F4/F7 unit tests added.
- Low risks fixed: F2-STALE-PROGRESS (invalidate the progress signal on every
  non-review round + require two finite readings), F5-HEADING-FRAGILITY
  (closed-set heading match + fenced-code transparency).

**code-reviewer — Changes Requested** (completed): "all seven root-cause fixes
are genuinely implemented and the new tests are faithful and discriminating";
4 medium findings, all fixed:
- R1: F2 invalidation missed on review-agent-failed/no-artifact paths. **Fixed**.
- R2: render schema rejected coercible controls → stale docs silently pass gates.
  **Fixed** via writerTask `normalizeControl` hook (normalizeSpecControl).
- R3: convergence-duty contract missing from buildUpstreamReviewPrompt (first
  edit had silently failed). **Fixed**.
- R4: cached judge verdict replays its FatalAbort before the F3 fresh-round
  budget is reached. **Fixed**: the judge now fires at `effectiveCap - 1`.
- R5 (low): over-broad heading prefixes + fence edge. **Fixed** (closed set).

Suite: 146 files / 2115 tests green; typecheck clean.
