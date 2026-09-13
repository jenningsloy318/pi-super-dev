# Reviewer Quality Architecture — closing the upstream escape class (review-side hardening)

Status: draft — awaiting grilling (living artifact)

Parent lineage: run 2026-09-13T03-24-15-047Z (pi-omisis spec-26, SCENARIO-014 escape) → `058-cross-phase-contract-architecture.md` (execution-side hardening: L1–L4; P1 landed in v0.3.96) → this spec. The cross-phase spec hardened plan+execution; this spec records the REVIEWER escape class the same run exposed: the AC-05 ⨯ SCENARIO-041/012/014 contradiction survived 5+ review gates (requirements, bdd ×2 rounds, design ×2 rounds, spec) and was named only by the Stage 9 judge — which read the test files and sibling-spec artifacts no reviewer was given — in 5.7 minutes ($0.0094) after hours of burned implementation attempts.

## 0. Symptom taxonomy (all evidence from run 2026-09-13T03-24-15-047Z)

- **R-A Input blindness (P0)** — the conflicting parties were physically outside every upstream reviewer's declared inputs. The pins live in sibling spec families (`docs/specifications/14-industry-momentum-dimension/`, `20-tool-catalog-python-bridge/`, `13-external-pest-dimension/`) and in test files (`tests/external-contract.test.ts:1837` "src/schemas.ts must stay byte-untouched", `tests/profitability-contract.test.ts:980` SCENARIO-014); reviewer `requires` lists (writers.ts:120–165) contain none of these. No reviewer could have caught it with its given inputs — this is an input-scope defect, not a model-quality defect.
- **R-B Coverage ≠ satisfiability (P0)** — bdd-review approved citing "100% bidirectional traceability" while the doc was unsatisfiable. Traceability is a set-mapping relation (every AC ↔ ≥1 scenario); satisfiability is a pairwise consistency relation over obligations. Both were simultaneously true here; the verdict dimension named one relation and was read as certifying the other.
- **R-C Calibration suppression (P1)** — the shared instruction "Speculation that a change might break something elsewhere is not a finding" (prompts.ts `buildUpstreamReviewPrompt`) suppresses exactly the cross-artifact class; combined with "Convergence duty" (later-round approval pressure) it makes the reviewer structurally unable to raise the one finding that mattered.
- **R-D Dimension dilution (P1)** — spec-review D2 "Consistency" executed as naming/constants/signature consistency (12-spec-review.md D2, verbatim), not obligation consistency. The dimension name promises more than the checklist delivers — an honest-labeling violation (P10) at the dimension level.
- **R-E Maximal-cost detection (P2)** — the only roles mandated to read test bodies are implementers/red-reviewers/judge, all post-entry. Detection cost asymmetry: review-time mechanical check ≈ milliseconds; judge diagnosis after hours of burns.

## 1. First-principles decomposition

1. **Input closure**: a reviewer can only find defects among propositions it can see. For the obligation-pair class (p, ¬p) spanning artifacts, either both loci enter the input window, or a mechanical index must stand in for omniscience.
2. **Relation separation**: mapping checks (coverage/traceability) and consistency checks (satisfiability) are different relations. Verdict dimensions must declare which relation they certify; a passing dimension must never be citable as evidence for the other.
3. **Calibration is budget protection, not truth**: it exists because unbounded blocker streams kill runs (a real prior failure mode). The fix is to scope it — carve an exception for evidence-backed cross-artifact findings — not to remove it.
4. **Hybrid detection**: free-form LLM consistency search over large corpora is unreliable in both directions (misses + false positives). Candidate extraction must be mechanical; the LLM adjudicates candidates and supplies evidence spans. The reviewers' job is what the machine cannot do — never what the machine does better.

## 2. Research grounding

- **Formal conflict theory** — KAOS obstacle analysis (van Lamsweerde, TSE): conflicts arise between goals/requirements from multiple stakeholders and are managed by named tactics (restore, weaken, avoid, guard-introduction). Spec 26's resolution vocabulary maps exactly: the rewritten BDD's transition pin ("exactly 14 before → 15 after, membership pinned not ordinal") is a guard-introduction; amending sibling guards is restore. The spec adopts this vocabulary for reviewer duties.
- **Hybrid contradiction detection** — Wyzer: "language understanding alone produces too many false positives for engineering use"; hybrid (mechanical extraction + LLM adjudication) wins. ContraGen (arXiv:2510.03418): systematic contradiction *generation* + detection in long-form enterprise documents as a benchmarkable task. Evidence-extraction work (arXiv:2601.02627): detectors should output evidence spans for both sides, not bare verdicts.
- **Inspection methodology** — Fagan inspection: defect checklists are historical-defect-derived and evolve with each incident; our fault-classification/post-mortem lineage is that history. Perspective-Based Reading (Basili et al. 1996): perspective-specialized reviewers with scenario-based checklists find more defects than generic review — justifies per-reviewer duties over one shared mega-checklist. ADR review practice: three named review perspectives for decision records.
- **Requirements/BDD quality canons** — ISO/IEC/IEEE 29148 characteristics (unambiguous, complete, feasible, verifiable, consistent…); requirements-smell taxonomies (Nature Sci Rep 2025 multi-label; Gentili 2025; SLR 2024 — mechanical NLP smell detection is the established baseline, ambiguity the dominant smell). BDD canons (Cucumber better-gherkin; declarative vs imperative; scenario overlap; no implementation coupling). Gap none of them cover: baseline-pin satisfiability across specs — the class this spec adds (our SCENARIO-014 escape).
- **Design review** — ATAM (SEI): quality-attribute tradeoff points, sensitivity points, risk themes as the review objects; lightweight industry variants exist (Sahlabadi 2022). Design-review duty: decisions that trade quality attributes must be explicit, not implicit.
- **LLM-judge calibration** — position/length/self-enhancement bias are systematic (Shi 2025; openlayer guide): rubric decomposition and artifact-order neutrality are the mitigations; our findings-shaped output avoids pairwise position bias but must not weight the first-listed artifact.
- **Multi-agent debate caution** — empirical study (arXiv:2503.12029) shows structured debate helps some coding tasks; controlled study ("Can LLM Agents Really Debate?") finds agents tend to converge to agreement without genuine adversarial exchange. Conclusion: do not add naive debate; the existing adversarial gate (fresh context, attack mandate) is the useful form.
- **Self-verification** — Chain-of-Verification (Dhuliawala 2023): draft → generate verification questions → answer independently → revise. Maps to our two-round writer⇄reviewer loops; the inventory slice adds the independent evidence the CoVe loop lacked.
- **SOP validation** — MetaGPT: encoding SOPs into role prompts with structured intermediate artifacts is the validated shape of multi-agent software pipelines — our staged artifacts + structured controls already follow it; this spec extends the reviewers' SOPs, not the pipeline shape.

## 3. System architecture — five review-side moves (complement to cross-phase L1–L4)

### Layer R1 — Contract-surface inventory (mechanical, single source)
A deterministic extractor walks `docs/specifications/*/` artifacts + the test suite and indexes baseline-pin idioms by protected file: `exactly-N` membership pins, `byte-untouched`/porcelain-emptiness assertions, `no-Xth` closure claims, OWNERSHIP_PINS-style tables. Output: `inventory[protectedFile] → Array<{pin, locus(file:line), owningSpec}>`. This is the automated generalization of D-A's optional `repo-invariants.json` (v0.3.96) — same idiom grammar, whole-tree scope, zero hand-maintenance. Fail-open when the tree is absent (DEC-4).

### Layer R2 — Input slices (deterministic injection, additive-only)
Each upstream reviewer receives the inventory **slice** for exactly the shared surfaces its artifact touches (e.g., an AC amending `src/schemas.ts` → the slice of all pins on `src/schemas.ts` and its amendable dependents). Injection lives in the existing prompt builders (`buildUpstreamReviewPrompt`, `buildSpecReviewPrompt`) — the shared choke points — never in per-agent prose copies. Slices are additive: no existing input is removed (DEC-5), so no new blind spots are introduced.

### Layer R3 — Per-reviewer perspective duties (PBR specialization — one to three lines each)
- **requirements-reviewer**: any AC modifying a shared surface (from the slice) must declare its **amendment family** — which sibling pins move, which guards gain exemptions, which docs update. An undeclared shared-surface AC is blocking (ownerStage=requirements).
- **bdd-reviewer**: (a) every baseline-pinning scenario is **owned** — it belongs to this spec's amendment family or is declared `inherited/frozen` with locus; (b) transition pins and static pins must not contradict (a "gains 15th member" scenario cannot coexist with an undeclared static "exactly 14" pin); (c) Cucumber-canonical sweep: declarative style, one behavior per scenario, scenario-overlap, no implementation coupling.
- **design-reviewer**: amendment family ⊇ inventory pins on every touched shared surface (set inclusion against the slice); ATAM-lite: every quality-attribute tradeoff a decision makes is stated (what is traded, for what, why).
- **spec-reviewer**: D2 upgraded from free-form "consistency" to a **mechanical cross-check**: obligations in spec/plan/tasks are reconciled against the slice with loci; a D2 pass must list which slice entries were checked (honest scope, P10).

### Layer R4 — Calibration scoping (evidence-pair exception)
The shared instructions gain one carve-out: **a finding citing both conflicting loci (file:line × file:line) with the contradiction stated is never "speculation"** — the convergence-duty and quality-bar clauses explicitly yield to it. One artifact-order neutrality line: upstream artifacts are listed in pipeline order; reviewers must not weight the first-listed artifact more (position-bias mitigation).

### Layer R5 — Escape-rate measurement (golden contradictions through the existing eval layer)
Golden-case set of **planted contradictions** (ContraGen-style: paired-pin fixtures in synthetic mini-specs, including the exact SCENARIO-014 shape) run through the reviewer suite on every reviewer-prompt or inventory change; escape of a planted contradiction = regression. Uses the v0.3.89–91 eval-layer machinery (golden cases, canary, gate agreement) — no new infrastructure (DEC-6). Reviewer quality is measured, not asserted.

## 4. Decisions (DEC — owner-adjudicable at grill)

- **DEC-1** The architecture doc stays single (rationale + threat model); per-reviewer behavior lands only in code choke points (prompt builders) + the inventory module. No prose distribution, no per-agent doc copies.
- **DEC-2 Hybrid detection**: mechanical extraction produces candidates with loci; LLM adjudicates. LLM free-form corpus search for conflicts is prohibited as a primary mechanism.
- **DEC-3 No reviewer debate**: evidence says naive debate converges to agreement; the adversarial gate already is the useful form. Revisit only with a controlled A/B.
- **DEC-4 Inventory fail-open**: absent spec tree / absent test suite → empty slices, reviewers proceed exactly as today. The failure mode of a broken inventory is the status quo, never worse (P5).
- **DEC-5 Slices are additive-only**: reviewer inputs never shrink. Removing an input requires a separate owner decision with its own escape analysis.
- **DEC-6 Measurement reuses the eval layer** (golden cases + canary + gate agreement). No new eval infrastructure, no new env keys.
- **DEC-7 KAOS resolution vocabulary** (restore / weaken / avoid / guard-introduction) is the shared language for amendment-vs-pin resolutions across writer and reviewer prompts.

## 5. Delta requirements

- **D-R-A** Inventory extractor module (`src/review/contract-surface.ts` candidate): idiom grammar table (enumerated, P2-compliant), tree walk, per-file index, exported pure functions; golden-fixture tests incl. the SCENARIO-014 shape.
- **D-R-B** Prompt-builder deltas: slice injection (R2) + per-reviewer duty lines (R3) + calibration carve-out & order-neutrality line (R4); tests pin the injected sections and their additive-only property.
- **D-R-C** Spec-review D2 re-label and mechanical cross-check wiring (R3/spec), honest scope listing.
- **D-R-D** Golden-contradiction eval set + reviewer-suite runner (R5) wired into the existing eval layer.

## 6. Non-goals

No new reviewer roles; no access-mode changes (reviewers stay source-read-only; DEC-2's mechanical extractor runs in-engine, not in the reviewer); no full-repo inputs to reviewers; no stage renumbering; no change to convergence caps or the judge; no fix to the sibling specs' own artifacts (their pins are legitimate — the duty is on the amending spec to declare its family); no implementation-side changes (covered by 058-cross-phase-contract-architecture.md P2).

## 7. Waves sketch

- **R1 wave** (v0.3.97 candidate): D-R-A + D-R-B + D-R-C — mechanical core + prompt deltas; the SCENARIO-014 fixture is the acceptance gate (the escape class must be caught at review time on the fixture).
- **R2 wave**: D-R-D measurement loop + canary wiring.
- Ordering vs cross-phase **P2** (D-B two-strike + D-D checkpoint rollback): independent surfaces; either may go first per owner.
- Convention: glm-5.3 implementer + dual gemini-3.8-flash gates (code + adversarial), delta re-gate on fix rounds.

## 8. Sources

1. van Lamsweerde, "Handling Obstacles in Goal-Oriented Requirements Engineering" (KAOS obstacle analysis) — https://www-di.inf.puc-rio.br/~julio/TSE-Obstacles.pdf
2. Wyzer, "Contradiction Detection: Why Hybrid Approaches Win" — https://wyzer.it/blog/contradiction-detection-hybrid-approaches
3. "ContraGen: A Multi-Agent Generation Framework for Contradiction Generation and Detection" — https://arxiv.org/html/2510.03418v1
4. "Improved Evidence Extraction for Document Inconsistency Detection" — https://arxiv.org/html/2601.02627v1
5. Basili et al., "The Empirical Investigation of Perspective-Based Reading" — https://www.cs.umd.edu/~mvz/handouts/emp_pbr.pdf
6. "Fagan inspection" — https://en.wikipedia.org/wiki/Fagan_inspection
7. ISO/IEC/IEEE 29148-2018 (requirements quality characteristics) — https://standards.ieee.org/standard/29148-2018.html
8. Gentili et al. 2025, "Practitioners' perceptions on requirements smells" — https://www.sciencedirect.com/science/article/pii/S0950584925001624
9. Alemneh et al. 2024, "Software Requirement Smells and Detection Techniques: A SLR" — https://cit.iict.bas.bg/CIT-2024/v-24-4/10341-Volume24_Issue_4-05_paper.pdf
10. "Multi-label software requirement smells classification" (Nature Sci Rep 2025) — https://www.nature.com/articles/s41598-025-86673-w
11. Cucumber, "Writing better Gherkin" — https://cucumber.io/docs/bdd/better-gherkin/
12. "Declarative vs Imperative Gherkin Scenarios" — https://itsadeliverything.com/declarative-vs-imperative-gherkin-scenarios-for-cucumber
13. SEI CMU, "Architecture Tradeoff Analysis Method (ATAM) Collection" — https://www.sei.cmu.edu/library/architecture-tradeoff-analysis-method-collection/
14. Sahlabadi et al. 2022, "Lightweight Software Architecture Evaluation for Industry" — https://pmc.ncbi.nlm.nih.gov/articles/PMC8838159/
15. Shi et al. 2025, "A Systematic Study of Position Bias in LLM-as-a-Judge" — https://aclanthology.org/2025.ijcnlp-long.18.pdf
16. OpenLayer, "LLM-as-judge: A complete guide" (rubric decomposition, position rotation) — https://www.openlayer.com/blog/llm-as-judge-evaluation-guide
17. "An Empirical Study on Multi-Agent Debate for Coding Tasks" — https://arxiv.org/html/2503.12029v2
18. "Can LLM Agents Really Debate? A Controlled Study" — https://openreview.net/forum?id=qsKo9mdGNu
19. Hong et al., "MetaGPT: Meta Programming for A Multi-Agent Collaborative Framework" — https://arxiv.org/html/2308.00352v7
20. Dhuliawala et al., "Chain-of-Verification Reduces Hallucination in LLMs" — https://arxiv.org/abs/2309.11495
21. ozimmer, "How to review Architectural Decision Records (ADRs)" — https://ozimmer.ch/practices/2023/04/05/ADRReview.html
22. NASA SWEBOK Handbook, Requirements review characteristics — https://swehb.nasa.gov/plugins/viewsource/viewpagesrc.action?pageId=32604505
