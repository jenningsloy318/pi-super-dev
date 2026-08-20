# Class-Aware Feedback + Reviewer Calibration — v0.3.1

Status: implemented (this commit — v0.3.1)

Grounding: reference-repos-full-read-v0.3.x.md (Parts 7–8) + the recovered WS-2/WS-3
designs (session research synthesis #3675) + the user's v0.3.0 architecture
(feedback-not-verdict philosophy — every item here improves FEEDBACK QUALITY or
SPAWN ROBUSTNESS; no new arbitration, no new gates-that-block).

Root cause being treated (run 2026-08-20T06-19-50-494Z, design stage): ONE
systemic defect class (over-restrictive artifact-name validation) surfaced one
filename family per round across 4 review rounds — D07-F08
(`stage-<id>.report.md`/`run.json`/`.knowledge.json`), F10 (`<id>:<ticker>`
colons), F11-class (`METHODOLOGIES` underscore keys `earnings_surprise`,
`deep_research`). Site-addressed feedback predicts exactly this whack-a-mole
(Self-Correction Illusion: agents correct what they can name as a discrete
external referent; the handle was site-local so the fix was site-local).
Research: refinement projects toward the refiner's framing (RSI §3.1) — each
revision satisfies the finding's letter, not the artifact's systemic defect.

## F1 (WS-2) — class-aware feedback

1. `defectClass` optional string on the review `Finding` schema
   (src/render/schemas.ts), `ConvergenceFinding`/`ConvergenceFindingInput`
   (src/convergence-ledger.ts), threaded through `recordReviewFindingsFromControl`
   and `normalizeFinding`; the ledger merge carries it like `downgradeReason`
   (existing row adopts; no semantic conflict possible — class is descriptive).
2. Reviewer duty line (both upstream + spec review prompts, ONE shape-level
   line, cumora discipline — no scenario examples): when a defect GENERALIZES,
   tag it with a short stable `defectClass` name and state the generalization
   rule in the detail; do not enumerate every instance.
3. Both `compactReviewFindings` (artifact-convergence + spec-convergence):
   - emit `class=<defectClass>` on the compact line when present;
   - include evidence (first 2 items, each capped at 240 chars with a
     `…(+N chars)` marker) so the writer can re-verify the way the reviewer
     falsified it (Mirror-Loop: grounding the revision restores progress);
   - truncation accounting (cumora): when findings exceed the 8-line cap,
     announce `…(+N more findings omitted — see the review document)` instead
     of silently dropping them.
4. `defectClassSweepDirectives(state, stageKey)` exported from
   convergence-ledger.ts: groups ledger findings by `defectClass`; a class
   qualifies when it owns ≥2 ledger findings OR one finding with seenCount ≥2;
   emits the sweep directive naming the class, the instance count, and the
   instance titles (compact). Injected by BOTH convergence loops on every
   review-rejected round (appended as an extra RetryFeedback item after
   convergenceRetryFeedback): "SWEEP THE CLASS — enumerate ALL sibling sites
   of this class in the artifact, fix every one, and list the enumeration in
   reviewResponses." This triggers at the 2nd instance, not at stagnation.

## F2 (WS-3) — derivation standing rule (feedforward guide)

One standing rule added to `buildDesignPrompt` and `buildSpecPrompt` writer
prompts: paired generate/validate contracts (patterns, allowlists, filename
conventions, key sets) must be DERIVED from the actual registry/source via a
stated rule and shipped with the enumerated closure table — never hand-written
on both sides. (Böckeler: guides without sensors are never verified; sensors
without guides repeat mistakes — the sensor lands in v0.4.0 WS-1.)

## F3 (F-R1) — reviewer rubric calibration (both reviewer prompts)

A compact "Finding quality bar" block, adapted from Codex's production review
rubric to artifact review:

- Discrete, actionable defect in THIS artifact's scope; the fix is reachable
  by this stage; introduced-in-or-surviving-in the current revision
  (upstream-rooted defects go via ownerStage, not duplicate re-flagging).
- Provable impact: name the specific section/scenario/AC/contract affected —
  speculation that a change *might* break something is not a finding.
- Match the artifact's established rigor; do not demand precision the
  surrounding document never had.
- One finding per distinct defect — merge same-location same-remedy candidates.
- Severity vocabulary P0–P3 with fixed semantics: P0 = assumption-free defect
  that breaks implementation outright; P1 = urgent correctness; P2 = normal;
  P3 = low/advisory. (P0/P1 already feed the existing HIGH_SEVERITY_RE
  high-class scan — p0/p1 are enumerated tokens there.)
- Emit `confidence` (0..1) on every finding (schema field exists).
- Zero findings is a valid, respected outcome — prefer it over nits; an
  approval with residual risks noted beats a padded blocker list.
- Gate ownership: these are deterministically checked and must NOT be
  re-flagged (unless the gate itself is wrong): id formats and bidirectional
  AC/SCENARIO coverage (trace gates), phases shape, review-doc dimension
  shape, deliverable file-existence/contains checks, verdict vocabulary.
  Spend reviewer attention where nothing else checks.

## F4 (F-R2) — implementer dirty-worktree hard rules

Two lines in `buildImplementPrompt` + `buildFixPrompt`: the worktree may
contain changes you did not make (other phases' committed work, harness
artifacts, prior-run leftovers) — NEVER revert or delete changes you did not
make; when an unexpected foreign change blocks your work, name it in the
summary (testDefects when it blocks tests) instead of fixing around it
silently. (Codex production rule, adapted; complements the deterministic
RC12c out-of-scope tracker.)

## F5 — spawn exit-settle hardening (cumora lesson, the one real gap)

`runPiRpc` resolves the abnormal-exit path on `child.on("close")`. Cumora's
lesson (production): grandchildren inherit the pipes, so `close` may NEVER
fire after the child exits — aborted/abnormal turns must settle on `exit`.
The turn timeout bounds the hang, but the honest signal should not wait for
it. Fix: on `child.on("exit")`, when `!settledMain`, schedule the same
close-path settle after SETTLE_GRACE_MS (cancelable when `close` does fire).
The rest of the cumora-critical subset is verified already present:
abort-check-after-register (`if (signal?.aborted) onAbort()` closes the
registration window), line-carry across chunks + flush-at-close (`lineBuf`
newline split + close-flush ingest), per-turn RPC deadlines with pending-map
release (driver timer deletes the pending entry).

## Non-goals

No new gates, no new loops or panels, no judge/arbitration changes (v0.3.0
philosophy intact — these items only enrich retry feedback and prompts), no
WS-1 contract-claims checker (v0.4.0), no WS-4 cross-run ledger (v0.4.1), no
prompt deletions this version.

## Verification plan

RED-first: `git stash src/` then run the new tests — the F1 class-sweep,
defectClass-threading, evidence-passthrough, truncation-accounting, rubric-
presence, dirty-worktree-presence, and F5 exit-settle tests must fail on
pre-fix code; control tests (unchanged compact format without defectClass,
close-still-settles) stay green. Full suite + tsc. Version bump set
0.3.0 → 0.3.1 (src/version.ts, package.json 2-space, package-lock 2-space,
tests/version.test.ts, docs/ARCHITECTURE.md regen, CHANGELOG Unreleased
bullet). Dual code-reviewer + adversarial-reviewer, remediate, commit under
the generating-commit-messages discipline.

## Review outcome (dual systematic review)

Code-reviewer: CHANGES REQUESTED — SD31-1 (P1) sweep stage-unscoped; SD31-2
(P2) sweep never retires; SD31-3 (P2) truncation announcement re-cut by the
assembly slice; SD31-4 (P3) exit-settle drops the residual line buffer;
SD31-5 (P3) merge allows class rename; SD31-6 (P3) duty line said
"High/Critical" while the rubric mandates P0–P3; SD31-7 (P3) duplicated
`### Changed` heading; SD31-8 (P3) control test's trailing advance asserted
nothing. Adversarial: CONTEST — F-01 (P2) same truncation cut; F-02 (P2) same
stage leak; F-03 (P2) sweep demanded `reviewResponses`, a field only the spec
writer's schema carries; F-04 (P3) same retire gap; F-05 (P3) gate-ownership
list named spec-surface gates to the design reviewer; F-06 (P3) residual
buffer + pipe handles; F-07 (P3) untracked plan/tests (added to the commit).

All remediated: `classSweepRetryFeedback` scopes by stage family (a
review-suffix-stripping family mapper lands `designReview`/`specReview` under
`design`/`spec`) and retires classes whose every member is verified/deferred;
the directive channel is stage-aware (spec → reviewResponses, others → state
the enumeration in the document); the ledger merge adopts a class only into a
class-less row (keep-first, rename-proof); `withOmissionNotice` re-attaches
the announcement past the assembly slice and the missing-render cap rose to 9
so the notice line stays visible; the exit-settle path flushes the residual
stdout buffer before disposing; the duty lines say P0/P1 (High/Critical); the
gate-ownership list is per-surface (upstream reviewers no longer told about
spec-surface gates); the CHANGELOG duplicate heading removed; the control test
asserts no second settle event. Five remediation pins + the F5 flush pin added
(suite: 21 in the class-aware file, 7 in the rpc-run file).

Final gates: tsc strict-clean; full suite green except the 3 pre-existing
environment-dependent failures reproduced on clean HEAD.
