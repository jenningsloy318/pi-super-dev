# Cross-Phase Contract Conflict Architecture — systemic hardening of the implementation convergence loop

Status: draft (systemic analysis of run 2026-09-13T03-24-15-047Z + online research folded; awaiting grilling — living artifact)

Parent lineage: `run-2026-09-09-poisoned-baseline-postmortem-v0.3.85.md` → `docs/findings/deep-analysis-2026-09-08-spec25.md` (plan-feasibility, de65969e) → this spec. The spec-25 family found "machinery executed plans never validated for feasibility"; this spec records the NEXT escape class of the same family — **plan-level contract contradictions that feasibility v1 cannot see**, discovered live in run 2026-09-13T03-24-15-047Z (pi-omisis spec-26).

## 0. Symptom taxonomy (all evidence from run 2026-09-13T03-24-15-047Z)

- **S-A — unsatisfiable cross-contract (the deep one).** Phase 2/8 re-entry, 16:24 build-gate FAIL (`npm run test` exit 1). The implementer's own diagnosis (16:25, verbatim): *"tests/profitability-contract.test.ts SCENARIO-014 requires src/schemas.ts to be byte-untouched in git, while other tests require [it modified]"*. Two acceptance sources impose contradictory postconditions on one path. No amount of implementer retries can satisfy both; the loop burns attempts against an impossible goal.
- **S-B — stage-level convergence cascade.** Stage 9 pass 1 ended `status=partial` (16:03, 175m) with only **3/8 phases green**; attempt 2 resumed from Phase 2 (`resuming convergence iteration (3/8 phases already green)`). One unsatisfiable/failed phase poisoned the pass; the re-walk must re-converge phases whose ground was mutated by later-phase work.
- **S-C — pipelined-review read-skew race.** 6× `source-read-only boundary violation (quarantined, not restored — concurrent writer)` across phases 01/03/05/06/08: the parallel red-reviewer read files the concurrent implementer then modified. 6/6 salvaged by claim attribution (v0.3.54); zero correctness impact. Frequency ∝ implementer speed × reviewer window (`:high` thinking ⇒ long reviews).
- **S-D — phase-7 partial** after 3 attempts (deterministic-dispatch-wiring), work preserved via git stash, stage continued per design. The partial-preserve + stash path worked.

## 1. First-principles decomposition

First principles: a multi-phase TDD pipeline is **a plan whose steps are transactions over shared state, verified by contracts**. Three properties must hold and each failure class above is one property broken:

1. **Satisfiability** — the conjunction of all phases' postconditions and all spec-level invariants must be consistent. S-A breaks this: `{schemas.ts immutable} ∧ {schemas.ts edited} = ⊥`. No executor quality fixes an inconsistent contract; only the plan/spec owner can.
2. **Isolation of protection** — when a contract declares a path immutable, that protection must be *enforced mechanically at write time*, not *discovered by a failing test 3 hours later*. S-A's late discovery + S-C's quarantine are both protection-detection gaps (one at plan layer, one tolerated by design).
3. **Progress-classified iteration** — a retry loop is justified only while each attempt yields a NEW failure signature. S-B's cascade and the 4-attempt burns on S-A-grade goals are self-correction without new signal. Research grounding (§2.1): LLM self-correction without sound external feedback does not converge and can degrade — the correct action on a repeated identical failure is ESCALATION, not retry #4.

## 2. Research grounding

- **2.1 Self-correction limits** — Huang et al., *Large Language Models Cannot Self-Correct Reasoning Yet* (ICLR 2024, arXiv:2310.01798): intrinsic self-correction without external feedback fails and can degrade performance; correction works only against sound external feedback. Implication: attempt loops must be driven by **new failure signatures** (sound feedback), and a repeated identical signature is the loop telling us the goal may be unsatisfiable — escalate, don't re-prompt.
- **2.2 Threat/clobbering in partial-order planning** — classical POP theory (Veloso & Blythe 1994; Cambridge AI notes; UT POP slides): a step that overwrites a condition required by another step is a **clobbering threat** against its **causal link**; threats are detected at plan-validation time and resolved by ordering (promotion/demotion) or render the plan invalid. Implication: "SCENARIO-014 protects schemas.ts" is a causal link; any phase writing schemas.ts is a threat — **this is decidable at Stage 9 entry, statically**.
- **2.3 Hermetic builds** — Bazel hermeticity model: actions declare inputs/outputs; conflicts are analysis-time errors, never execution-time surprises. Implication: phases should declare `writes[]` and `protects[]`; write-to-protected is an analysis-time (or at worst first-write-time) REPLAN route, not a 4-attempt burn.
- **2.4 Multi-agent SDLC pipelines (MetaGPT/ChatDev class)** — waterfall role chains propagate artifacts downstream with no sound cross-phase contradiction detection; contradictions surface at the executing role. Confirms the gap is systemic in this product class, not a super-dev-local oversight — and that the differentiator is a real conflict detector, not more agents.

## 3. System architecture — four layers

### Layer 1 — Plan-time satisfiability (static, zero-LLM)
Extend `src/stages/plan-feasibility.ts` (grammar v2): in addition to v1's identifier/contains conflicts, parse the SPEC + plan's **test-contract immutability claims** (byte-untouched / must-not-modify / protected-path assertions — however the spec-writer encodes them, e.g. SCENARIO-014's "byte-untouched in git") and intersect with all phases' declared write sets. A protection × write intersection = **clobbering threat** → route REPLAN at Stage 9 entry with the named pair (protecting clause ⨯ writing phase). This is DEC-able without LLM cost: the contradiction is textual.

### Layer 2 — Execution-time protection intervals
Phases declare `protects[]` (invariant paths for this phase's window) alongside `writes[]`. The runner treats a write to a path protected by ANY active clause as an immediate named-conflict route (REPLAN/judge), not an attempt-burn: the implementer's corrective prompt carries the protecting clause verbatim. First occurrence educates; it never consumes the 4-attempt budget because it is not a quality defect.

### Layer 3 — Progress-classified iteration (plateau semantics)
Generalize the failure-signature machinery: per attempt, compute the failure-signature delta. Same signature on consecutive attempts ⇒ **plateau** ⇒ escalate (REPLAN/judge) at attempt 2 — not attempt 4 (Huang 2.1). New signature ⇒ real progress ⇒ continue to the cap. The stagnation detector (`priorBlockingSignature`) already exists for one path; this promotes it to a general iteration governor.

### Layer 4 — Global-invariant re-walk
Stage-level convergence re-entry (`resuming convergence iteration`) must first re-verify **whole-tree global contracts** (full build + suite + every spec-level immutability) and enter the re-walk at the DEEPEST broken phase, skipping phases whose green still holds under global re-verification. Rationale: later phases mutate ground under earlier phases' contracts (S-B cascade); per-phase green stamps alone are read-skew-prone (the transactional analogy: per-item stamps, serializability not checked).

## 4. Decisions (DEC — owner-adjudicable at grill)

- **DEC-1 (adopted from 2.2):** model cross-phase conflicts as POP threats (protects ⨯ writes), not ad-hoc string heuristics. Grammar lives in one module; the feasibility validator and the runner Layer-2 check share it (P6).
- **DEC-2 (scope ruling):** Layer 1 parses only STRUCTURED contract sources (spec clauses, plan task fields, tdd-guide RED-test headers). Reading arbitrary test-file assertion bodies (SCENARIO-014 lives in a hand-written omisis test) is explicitly OUT of scope for v1 — the spec-writer guidance gains a rule instead: immutability invariants MUST be expressed as named spec clauses, never as raw test assertions (see DEC-5).
- **DEC-3 (plateau cap):** plateau escalation at attempt 2 for identical-signature failures; cap 4 remains for new-signature progress. Rationale: 2.1 — retry without new signal is noise; the measured run shows real fixes did produce new signatures each round (TypeError → build-annotations → …), so honest progress is detectable.
- **DEC-4 (race acceptance):** S-C (pipelined read-skew) is ACCEPTED as-is — salvage-by-claim-attribution is sound and self-limiting (per-phase disable after 2 violations). No synchronous-review regression. Optional future knob: red-reviewer `:medium` pin to shrink the window (cost/latency trade — deferred).
- **DEC-5 (spec-writer contract):** add to spec-writer/plan guidance: immutability invariants must be declarative named clauses (machine-checkable), never raw assertions buried in hand-written tests; the feasibility validator treats unnamed immutability claims it cannot parse as an ADVISORY naming the risk.

## 5. Delta requirements

- **D-A (Layer 1):** feasibility grammar v2 — protection-claims parsing + threat intersection; REPLAN-at-entry with named (protecting clause ⨯ writing phase) pairs. Acceptance: the run-2026-09-13 conflict shape (byte-untouched ⨯ phase writing schemas.ts) is caught statically on a fixture spec.
- **D-B (Layer 2):** `protects[]` on phase contracts + runner enforcement (write-to-protected ⇒ named-conflict REPLAN route, zero attempt consumption). Acceptance: forced fixture violates protection once → routes REPLAN; attempt budget untouched.
- **D-C (Layer 3):** signature-delta iteration governor — plateau escalation at attempt 2; generalizes the stagnation detector to all convergence sites (artifact/spec/implementation attempts). Acceptance: identical-signature fixture escalates at 2; new-signature fixture reaches cap 4.
- **D-D (Layer 4):** re-walk global-invariant gate + deepest-broken-phase entry. Acceptance: fixture where a later phase breaks an earlier contract re-enters at the later phase; untouched phases skip via global re-verification.

## 6. Non-goals

- No web-search tools for implementer/tdd children (sandbox discipline stands; needsResearch → research-agent remains the only external-knowledge path — correctly unused this run: all failures were local-mechanics or contract-conflict classes).
- No synchronous (de-pipelined) review regression; no per-phase worktrees (spec-25 analysis already rejected horizontal specs on this model).
- No change to the boundary-violation quarantine/salvage mechanics (working as designed; DEC-4).

## 7. Waves sketch

- **P1:** D-A + D-C (pure detection/routing; no new failure modes; the two highest-value layers).
- **P2:** D-B + D-D (declarative protection model + global re-walk semantics).

## 8. Sources

- Huang et al., *Large Language Models Cannot Self-Correct Reasoning Yet*, ICLR 2024, arXiv:2310.01798.
- Veloso & Blythe, *Linkability and Pruning in Partial-Order Planning* (1994); Cambridge AI course notes (threat/clobbering/causal links); UT CS343 POP slides.
- Bazel docs — *Hermetic builds* (declared inputs/outputs, analysis-time conflict detection).
- MetaGPT / ChatDev (waterfall multi-agent SDLC; downstream artifact propagation without sound conflict detection).
- Live corpus: run 2026-09-13T03-24-15-047Z (run.log lines 3590-3800; verbatim implementer conflict diagnosis at 16:25).
