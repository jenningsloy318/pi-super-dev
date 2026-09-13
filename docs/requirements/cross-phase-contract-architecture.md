# Cross-Phase Contract Conflict Architecture — systemic hardening of the implementation convergence loop

Status: draft ×3 (delta re-gate 2026-09-13 — P1 READY; P2 unblocked by NEW-2 ruling = downstream-green INVALIDATION on rollback; advisories NEW-1/NEW-3 folded. Owner-proxy, overridable)

Parent lineage: `run-2026-09-09-poisoned-baseline-postmortem-v0.3.85.md` → `docs/findings/deep-analysis-2026-09-08-spec25.md` (plan-feasibility, de65969e) → this spec. The spec-25 family found "machinery executed plans never validated for feasibility"; this spec records the NEXT escape class of the same family — **plan-level contract contradictions that feasibility v1 cannot see**, discovered live in run 2026-09-13T03-24-15-047Z (pi-omisis spec-26).

Grill round 1 (gemini-3.8-flash, fresh context): verdict NOT-READY; verdict-driven revisions: (i) D-A circularity broken by a mechanical invariants pre-scanner (Fork 1B); (ii) Layer-2 contradiction resolved by two-strike bounded defense (Fork 2B); (iii) D-C reframed onto the existing footprint-aware governor — Huang applies to signature-only loops, TDD suites ARE sound feedback (Fork 3B); (iv) Layer 4 replaced by git checkpoint rollback (Fork 4B); (v) two DRIFTs corrected (existing `repeatedNoProgress` governor; spec-25 worktree characterization); (vi) S-C count 6→7.

## 0. Symptom taxonomy (all evidence from run 2026-09-13T03-24-15-047Z)

- **S-A — unsatisfiable cross-contract (the deep one).** Phase 2/8 re-entry, 16:24 build-gate FAIL (`npm run test` exit 1) at `tests/profitability-contract.test.ts:986` (`expect(dirty, "src/schemas.ts must stay byte-untouched").toBe("")` over `git status --porcelain`). The implementer's own diagnosis (16:25, verbatim): *"SCENARIO-014 requires src/schemas.ts to be byte-untouched in git, while other tests require screen in PYTHON_SCRIPTS"*. Two acceptance sources impose contradictory postconditions on one path. No executor quality fixes an inconsistent contract; only the plan/spec owner can.
- **S-B — stage-level convergence cascade on a contaminated shared worktree.** Stage 9 pass 1 ended `status=partial` (16:03, 175m) with only **3/8 phases green**; attempt 2 resumed from Phase 2 (`resuming convergence iteration (3/8 phases already green)`) **into a worktree already mutated by phases 3-8's landed work** — later-phase artifacts contaminated earlier phases' re-convergence ground.
- **S-C — pipelined-review read-skew race.** **7×** `source-read-only boundary violation (quarantined, not restored — concurrent writer)` across phases 01/03/05/06/08 + one on attempt-2 re-entry: the parallel red-reviewer read files the concurrent implementer then modified. **7/7 salvaged** by claim attribution (v0.3.54); zero correctness impact. Frequency ∝ implementer speed × reviewer window (`:high` thinking ⇒ long reviews).
- **S-D — phase-7 partial** after 3 attempts (deterministic-dispatch-wiring), work preserved via git stash, stage continued per design. The partial-preserve + stash path worked.

## 1. First-principles decomposition

First principles: a multi-phase TDD pipeline is **a plan whose steps are transactions over shared state, verified by contracts**. Three properties must hold and each failure class above is one property broken:

1. **Satisfiability** — the conjunction of all phases' postconditions and all spec-level invariants must be consistent. S-A breaks this: `{schemas.ts immutable} ∧ {schemas.ts edited} = ⊥`. No executor quality fixes an inconsistent contract. **Detection must be mechanical** (P4): the incident's own assertion was machine-detectable (`git status --porcelain` + an immutability message), so the excuse "we cannot parse arbitrary tests" only covers arbitrary tests, not this idiomatic class.
2. **Isolation of protection** — a declared protection must be **enforced at write time**, and a re-walk must execute against the baseline its contracts assume. S-A's late discovery and S-B's contamination are both protection/isolation gaps (one static, one structural).
3. **Progress-classified iteration** — a retry loop is justified only while the attempt produces NEW signal. In TDD the test suite is SOUND external feedback, so Huang et al. (§2.1) does NOT condemn ordinary retry loops here; it condemns **loops whose signal cannot improve the outcome** — identical failure AND identical change footprint (the fix is not addressing the failure), or goals that are unsatisfiable by contract (S-A). The engine already encodes this: `repeatedNoProgress` (failure + footprint 2-tuple) + `faultRecurrenceLimit` (v0.3.85). The gap is that contract-conflict-class failures ride the same budget as fixable ones.

## 2. Research grounding

- **2.1 Self-correction limits** — Huang et al., *Large Language Models Cannot Self-Correct Reasoning Yet* (ICLR 2024, arXiv:2310.01798): intrinsic self-correction without external feedback fails and can degrade. Application ruling (grill round 1): TDD suites are sound external feedback, so this grounds **(a)** plateau semantics only when signal is genuinely static (failure + footprint unchanged) and **(b)** immediate escalation for contract-contradiction failures, where no attempt can produce improving signal.
- **2.2 Threat/clobbering in partial-order planning** — Veloso & Blythe 1994; classical POP: a step overwriting a condition required by another step is a clobbering **threat** against a **causal link**; detected at plan-validation time; resolved by ordering or the plan is invalid. Implication: "SCENARIO-014 protects schemas.ts" is a causal link; any phase writing schemas.ts is a threat — **decidable at Stage 9 entry, statically** (Fork 1B supplies the mechanical extraction).
- **2.3 Hermetic builds** — Bazel hermeticity: actions declare inputs/outputs; conflicts are analysis-time errors. Grounds per-phase `writes[]` declarations and the checkpoint model.
- **2.4 Multi-agent SDLC pipelines (MetaGPT/ChatDev class)** — waterfall role chains propagate artifacts downstream with no sound cross-phase contradiction detection. The differentiator is a real conflict detector + state isolation, not more agents.

## 3. System architecture — four layers (v2, post-grill)

### Layer 1 — Plan-time satisfiability (static, zero-LLM)
Two mechanical sources feed the threat intersection:
1. **Invariants pre-scanner** (Fork 1B): a lightweight regex/AST pre-pass over the spec-declared test files at Stage 9 entry, extracting the idiomatic immutability class (`git status --porcelain -- <path>` + immutability message wording: `byte-untouched`, `must stay untouched`, equivalents). This is deterministic (P4) and catches the SCENARIO-014 shape where it actually lives. Known-risk: idiom coverage — the scanner publishes its detected-idiom list per run (P10) so silent misses are visible.
2. **Explicit declarations**: optional `repo-invariants.json` (or spec clauses) for invariants the idiom scanner cannot express.
Threat intersection: {extracted/declared protected paths} ⨯ {phase write sets} → **REPLAN at Stage 9 entry** naming each (protecting source ⨯ writing phase) pair.

### Layer 2 — Execution-time protection intervals (two-strike bounded defense)
Phases carry `protects[]` derived from the SAME Layer-1 sources (mechanically extracted — never LLM-declared, per P1). Reaction is bounded (P8), resolving the grill's §3-vs-§5 contradiction:
- **Strike 1 (in-loop, zero attempt cost):** the runner detects a protected-path edit before the build gate, reverts the edit, and injects the protecting clause verbatim into the implementer's corrective context. The attempt does not count against the phase budget (it is an environment-corrected dispatch, not a judged failure).
- **Strike 2 (same phase):** a second protected-path write routes to Judge escalation with named scope (`stage9.protection-breach`), allowed routes `[replan-upstream, challenge-test]` — a test demanding immutability may itself be the wrong contract; the judge can rule either way.
No unbudgeted loop exists: exactly two strikes, then a judged route.

### Layer 3 — Progress-classified iteration (tighten the existing governor, don't replace it)
Builds ON `repeatedNoProgress` (failure + footprint 2-tuple) and `faultRecurrenceLimit` (v0.3.85) — the grill's DRIFT correction: the governor already exists in `implementation.ts`; the delta is tightening + extending coverage:
- **Plateau at attempt 2** when BOTH failure signature AND git footprint are identical to the prior attempt (zero new signal), or when an attempt lands zero file changes.
- **A fresh git footprint buys attempt 3** (two-step scaffolds are legitimate; footprint is the progress evidence).
- **Hard cap 4** remains for genuinely new-signature progress.
- **Contract-conflict routing (S-A class):** when a phase's failure cites a test/contract belonging to ANOTHER phase's scope (attributable via the same claim-attribution machinery as S-C salvage), route to Judge/REPLAN immediately — do not consume the budget on an unsatisfiable goal.

### Layer 4 — Git checkpoint rollback at convergence re-entry (replaces global re-verify)
The deterministic per-phase commits (v0.3.43) already form a checkpoint chain. On stage-level convergence re-entry at Phase K:
- **Rollback target: `latestGreenCommitBefore(K) ?? stageEntryBaselineCommit`** (NEW-3: K=1 and partial-predecessor cases formally defined) — the clean baseline Phase K's contracts assume; downstream UNCOMMITTED mutations are preserved in stashes (S-D path).
- **Downstream committed phases (NEW-2 ruling): green stamps for phases K+1..N are INVALIDATED on rollback.** Their deterministic commits certify a tree that no longer exists after the reset (per-phase commits are detached from the new HEAD); keeping their green stamps while skipping them (the `status === "green" → continue` walk) would silently drop their code. Invalidated phases re-execute through the normal convergence walk — gates + commits re-established on the new K. The cherry-pick-preserved alternative was considered and DEFERRED: cherry-picking downstream commits ahead of a re-authored K invites conflict resolution by LLM (exactly the class this spec removes), and stale green stamps are false evidence (P5). Cost is bounded by the convergence walk itself and the run wall fuse.
- This structurally dissolves S-B contamination: phase K never converges against later-phase artifacts.
- Cost ≈ one `git reset --hard` + stash bookkeeping (seconds), replacing the aborted "full global re-verify + deepest-broken-phase search" design (grill Finding 5: ambiguous, high-latency, and unnecessary once isolation exists).

## 4. Decisions (DEC — owner-adjudicable at grill)

- **DEC-1 (adopted from 2.2):** cross-phase conflicts are POP threats (protects ⨯ writes); one shared grammar module feeds Layer 1 and Layer 2 (P6).
- **DEC-2 (amended, Fork 1B):** protection sources are MECHANICAL — idiom pre-scanner + explicit invariants file. LLM-prose advisories are NOT a protection source (P4). The former DEC-5 "advisory on unparseable claims" is DROPPED (untestable — grill Finding 7).
- **DEC-3 (amended, Fork 3B):** plateau = failure+footprint identical (or zero-change) at attempt 2; footprint-fresh extends to 3; cap 4. Huang applies to static-signal loops only; TDD suites are sound feedback.
- **DEC-4 (unchanged, count 7):** the pipelined read-skew race is ACCEPTED — salvage-by-claim-attribution is sound and self-limiting (per-phase disable after 2 violations). Optional knob deferred: red-reviewer `:medium` pin to shrink windows.
- **DEC-5 → REPLACED by DEC-6 (Fork 4B):** convergence re-entry uses **git checkpoint rollback** to the last-green-phase commit; worktree isolation remains NOT adopted (per-phase worktrees), but state isolation is achieved by checkpoints on the EXISTING single worktree + per-phase commits — no new infrastructure, honors the spec-25 single-worktree ownership model.
- **DEC-7 (compliance):** the layered design is audited against the constitution: P1 (protections mechanically extracted, never LLM-declared), P4 (scanner is mechanical; prompt guidance only extends idiom coverage), P6 (one grammar module shared by Layers 1-2), P8 (two-strike bound; plateau bound; checkpoint rollback bound).

## 5. Delta requirements

- **D-A (Layer 1):** feasibility grammar v2 — idiom pre-scanner + invariants file + threat intersection; REPLAN-at-entry naming (protecting source ⨯ writing phase) pairs. Acceptance: a fixture containing the run-2026-09-13 idiomatic assertion (`git status --porcelain` + immutability message) WITHOUT any named clause is caught statically — **the fixture must NOT hand-hold the scanner** (grill circularity fixed).
- **D-B (Layer 2):** mechanically-derived `protects[]` + two-strike defense (strike 1 revert+educate at zero attempt cost; strike 2 Judge escalation). **Timing (NEW-1): strike-1 detection is a SYNCHRONOUS ENGINE CHOKE POINT evaluated strictly after child-agent return and RED-review join, immediately before build-gate dispatch — never a filesystem watcher or concurrent hook** (a watcher would re-introduce the S-C race inside the protection mechanism itself). Acceptance: strike-1 fixture reverts the edit and does not consume budget; strike-2 fixture routes to Judge with scope `stage9.protection-breach`; a third write is impossible to loop on (strike 2 always routes).
- **D-C (Layer 3):** tighten `repeatedNoProgress` — plateau-at-2 on failure+footprint identity or zero-change; footprint-fresh → attempt 3; cap 4; cross-scope contract-conflict failures route to Judge/REPLAN immediately. Acceptance: three fixtures (identical-pair plateau, scaffold-with-fresh-footprint survives to 3, cross-scope citation routes immediately).
- **D-D (Layer 4):** checkpoint rollback at convergence re-entry. Target = `latestGreenCommitBefore(K) ?? stageEntryBaselineCommit` (NEW-3). **Downstream green invalidation (NEW-2): phases K+1..N marked green in a prior pass lose their stamps on rollback and re-execute** (their detached deterministic commits are documented as abandoned; recovery is re-execution, not cherry-pick — deferred optimization recorded in §3 Layer 4). Acceptance: fixture where later phases contaminate phase K's ground re-enters K on its clean baseline; phase K's gates see exactly the K-1 tree; a downstream green phase's files are ABSENT after rollback and restored only by its re-execution (the silent-loss case is pinned by test).

## 6. Non-goals (corrected per grill)

- No web-search tools for implementer/tdd children (sandbox discipline; needsResearch → research-agent is the only external-knowledge path — correctly unused in the incident run).
- No synchronous (de-pipelined) review regression; the read-skew race stays accepted (DEC-4).
- **No per-phase worktrees** — but NOT for the reason v1 stated. Correction (grill DRIFT): the spec-25 analysis declared horizontal specs *inevitable* ("not a bug; it is the work") and deferred worktrees to a Wave-B evaluation — it did not reject them. This spec instead adopts **git checkpoint rollback** (DEC-6) as the isolation mechanism: it reuses the existing per-phase commit chain, adds zero new infrastructure, and dissolves the S-B contamination without a second worktree dimension.
- No change to the boundary-violation quarantine/salvage mechanics (7/7 salvaged).

## 7. Waves sketch

- **P1:** D-A + D-C (detection/routing only; builds on existing governor; no new failure modes).
- **P2:** D-B + D-D (protection intervals + checkpoint rollback).

## 8. Sources

- Huang et al., *Large Language Models Cannot Self-Correct Reasoning Yet*, ICLR 2024, arXiv:2310.01798.
- Veloso & Blythe, *Linkability and Pruning in Partial-Order Planning* (1994); Cambridge AI course notes; UT CS343 POP slides.
- Bazel docs — *Hermetic builds*.
- MetaGPT / ChatDev (waterfall multi-agent SDLC; downstream artifact propagation without sound conflict detection).
- Live corpus: run 2026-09-13T03-24-15-047Z (run.log lines 734-3951: 7 boundary-violation throws + salvage lines; 3588-3800: partial stage, convergence resume, SCENARIO-014 conflict).
- Grill round 1: gemini-3.8-flash fresh-context review (NOT-READY; forks 1B/2B/3B/4B adopted; drifts corrected: existing `repeatedNoProgress` governor acknowledged; spec-25 worktree characterization fixed).
- Delta re-gate: gemini-3.8-flash fresh-context review — **P1 READY; all round-1 findings verified CLOSED with citations** (forks, DRIFTs, LOW, DEC-7 P1/P4/P6/P8/P10; deterministicPhaseCommit chain existence verified at implementation.ts:1714-1770/4760-4780; strike-1 race-freedom verified at the post-join pre-build-gate choke point). P2 blocked on NEW-2 → resolved by the downstream-invalidation ruling above; NEW-1/NEW-3 folded.
