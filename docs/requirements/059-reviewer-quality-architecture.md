# Reviewer Quality Architecture — closing the upstream escape class (review-side hardening)

Status: draft ×2 (grill round 1 NOT-READY(conditional) folded — v2; owner-proxy rulings on DEC-4/DEC-6 marked ⚖, overridable)

Parent lineage: run 2026-09-13T03-24-15-047Z (pi-omisis spec-26, SCENARIO-014 escape) → `058-cross-phase-contract-architecture.md` (execution-side hardening: L1–L4; P1 landed in v0.3.96) → this spec. The cross-phase spec hardened plan+execution; this spec records the REVIEWER escape class the same run exposed: the AC-05 ⨯ SCENARIO-041/012/014 contradiction survived 5+ review gates (requirements, bdd ×2 rounds, design ×2 rounds, spec) and was named only by the Stage 9 judge — which read the test files and sibling-spec artifacts no reviewer was given — in 5.7 minutes ($0.0094) after hours of burned implementation attempts.

Grill round 1 (gemini-3.8-flash, fresh context): NOT-READY(conditional); folds applied in v2: (i) R3 duties anchored in machine-readable controls + engine-side deterministic validators — prompt text stays advisory, enforcement is code (HIGH-1/DRIFT-2: `enforceReviewerConvergenceDuty` at `src/review-findings.ts:245–288` is the engine seam any carve-out must live at); (ii) DEC-6 amended — coarse verdict-string agreement is a false-agreement oracle; D-R-D is a minimal dedicated reviewer harness with finding-level planted-locus attribution, "no new infrastructure" claim dropped (HIGH-2/DRIFT-1: `eval-stage.ts` METRIC_TARGET has no review targets, `eval-layer.ts:1060` agrees on verdict strings only); (iii) R1 gains the P2 enumerated idiom-grammar table + explicit path-resolution rule for prose pins in legacy siblings (HIGH-3; §6 non-goal of not editing sibling specs kept — a mapping file carries the anchors); (iv) R4 carve-out is mechanically verified (loci exist on disk ∧ ≥1 locus in the injected slice) and bounded (≤1 exempt finding per late round, excess escalates to judge) (HIGH-4); (v) R2 touched-set gets a deterministic algorithm + fallback (MED-1); (vi) DEC-4 split: absent-tree = silent fail-open; extraction-error = fail-loud banner (MED-2 ⚖); (vii) waves split R1A/R1B, LLM-behavior gating deferred to the R2 harness (MED-3); (viii) writers.ts citation corrected to 110–175 (LOW-1).

## 0. Symptom taxonomy (all evidence from run 2026-09-13T03-24-15-047Z)

- **R-A Input blindness (P0)** — the conflicting parties were physically outside every upstream reviewer's declared inputs. The pins live in sibling spec families (`docs/specifications/14-industry-momentum-dimension/`, `20-tool-catalog-python-bridge/`, `13-external-pest-dimension/`) and in test files (`tests/external-contract.test.ts:1837` "src/schemas.ts must stay byte-untouched", `tests/profitability-contract.test.ts:980` SCENARIO-014); reviewer `requires` lists (`src/stages/writers.ts:110–175`) contain none of these. No reviewer could have caught it with its given inputs — an input-scope defect, not a model-quality defect.
- **R-B Coverage ≠ satisfiability (P0)** — bdd-review approved citing "100% bidirectional traceability" while the doc was unsatisfiable. Traceability is a set-mapping relation; satisfiability is a pairwise consistency relation over obligations. Verdict dimensions must declare which relation they certify.
- **R-C Calibration suppression (P1)** — the shared instruction "Speculation that a change might break something elsewhere is not a finding" (`buildUpstreamReviewPrompt`) suppresses exactly the cross-artifact class. Note (grill DRIFT-2): convergence duty is ALSO enforced mechanically by `enforceReviewerConvergenceDuty` (`src/review-findings.ts:245–288`, strips blocking status from new non-High findings in later rounds) — so any R4 fix must change engine behavior, not just prompt text, or the engine wipes the fix.
- **R-D Dimension dilution (P1)** — spec-review D2 "Consistency" executed as naming/constants/signature consistency (12-spec-review.md D2, verbatim), not obligation consistency. Honest-labeling violation at the dimension level (P10).
- **R-E Maximal-cost detection (P2)** — the only roles mandated to read test bodies are implementers/red-reviewers/judge, all post-entry.

## 1. First-principles decomposition

1. **Input closure**: a reviewer can only find defects among propositions it can see. For the obligation-pair class (p, ¬p) spanning artifacts, either both loci enter the input window, or a mechanical index must stand in for omniscience.
2. **Relation separation**: mapping checks (coverage/traceability) and consistency checks (satisfiability) are different relations. A passing dimension must never be citable as evidence for the other.
3. **Calibration is budget protection, not truth**: scope it with a mechanically verified exception; do not remove it (removal re-opens the blocker-storm failure mode), and do not implement the exception in prompt text only (the engine enforcer overrides blocking flags — DRIFT-2).
4. **Hybrid detection**: candidate extraction is mechanical; the LLM adjudicates candidates with evidence spans. Every "duty" that must hold gets a deterministic validator; reviewer prose duties guide, validators enforce (P4).

## 2. Research grounding

- **Formal conflict theory** — KAOS obstacle analysis (van Lamsweerde, TSE): conflicts between goals from multiple stakeholders are managed by named tactics (restore, weaken, avoid, guard-introduction). Spec 26's resolution vocabulary maps exactly: the rewritten BDD's transition pin ("exactly 14 before → 15 after, membership pinned not ordinal") is a guard-introduction; amending sibling guards is restore. DEC-7 adopts this vocabulary.
- **Hybrid contradiction detection** — Wyzer: "language understanding alone produces too many false positives"; hybrid (mechanical extraction + LLM adjudication) wins. ContraGen (arXiv:2510.03418): contradiction generation+detection as a benchmarkable task — grounds R5's golden fixtures. Evidence-extraction work (arXiv:2601.02627): detectors output evidence spans for both sides, not bare verdicts — grounds the finding-level attribution requirement.
- **Inspection methodology** — Fagan: defect checklists derived from incident history (our fault-classification/post-mortem lineage). Perspective-Based Reading (Basili 1996): perspective-specialized reviewers with scenario-based checklists outperform generic review — grounds per-reviewer duties over one mega-checklist. ADR review practice: named review perspectives for decision records.
- **Requirements/BDD canons** — ISO/IEC/IEEE 29148 characteristics; requirements-smell taxonomies (Nature Sci Rep 2025; Gentili 2025; SLR 2024 — mechanical smell detection is the established baseline). BDD canons (Cucumber better-gherkin; declarative vs imperative; scenario overlap; no implementation coupling). Gap none cover: baseline-pin satisfiability across specs — this spec's added class.
- **Design review** — ATAM (SEI): tradeoff/sensitivity points as review objects; lightweight industry variants (Sahlabadi 2022).
- **LLM-judge calibration** — position/length/self-enhancement bias are systematic (Shi 2025; openlayer guide): rubric decomposition + artifact-order neutrality. Coarse verdict-string agreement is explicitly a weak oracle — grounds HIGH-2's finding-level attribution.
- **Multi-agent debate caution** — empirical study (arXiv:2503.12029) vs controlled study ("Can LLM Agents Really Debate?"): naive debate converges to agreement; the fresh-context adversarial gate is the useful form. DEC-3.
- **Self-verification** — Chain-of-Verification (Dhuliawala 2023): the inventory slice supplies the independent evidence the CoVe loop lacked.
- **SOP validation** — MetaGPT: SOPs in role prompts with structured intermediate artifacts — our staged shape; this spec extends reviewer SOPs, not the pipeline.

## 3. System architecture — five review-side moves (complement to cross-phase L1–L4)

### Layer R1 — Contract-surface inventory (mechanical, single source)
A deterministic extractor walks `docs/specifications/*/` artifacts + the test suite and indexes baseline pins by protected file: `inventory[protectedFile] → Array<{pinId, idiomFamily, locus(file:line), owningSpec, resolutionState}>`.

**Idiom grammar (P2 — enumerated, v1 scope; additions require a grammar-table row + fixture pair):**

| Family | TS/JS test form | Python test form | Markdown/prose form (spec artifacts) |
|---|---|---|---|
| porcelain-emptiness | `git status --porcelain` + `toBe("")`/`length` 0 assertions on a path arg | `subprocess` git + `assert == ""` | "stays byte-untouched in git", "working tree clean for X" |
| exactly-N membership | `toHaveLength(N)` / `toEqual([...N items])` over a registry export | `len(REGISTRY) == N` | "pinned at exactly N members", "closed set of N" |
| no-Xth closure | missing-member assertions (`not.toContain("x")`) | `assert "x" not in …` | "no fifteenth module", "gains no new member" |
| ownership table | exported `OWNERSHIP_PINS`/`*_OWNERS` compared verbatim | dict-equality asserts | "OWNER '14'", ownership-table rows |

**Path-resolution rule (HIGH-3):** a pin enters the inventory keyed by a protected file ONLY via (a) a literal path token in the pinning statement, or (b) an entry in `repo-invariants.json` (the D-A v0.3.96 file, generalized: `[{protectedFile, pin, anchor}]`) maintained at the repo root for legacy prose pins — legacy sibling specs are NOT edited (§6). Unresolvable pins are listed in the slice header as `unanchored:` lines (honest visibility, P10) and are never silently dropped. Extraction timing: fresh read at each review-stage dispatch (no cache between stages; deterministic traversal order, so same tree → same slice).

### Layer R2 — Input slices (deterministic injection, additive-only)
**Touched-set algorithm (MED-1):** `touched(artifact) = { k ∈ inventory keys : k appears as a literal path/backtick token in the artifact }` ∪ `{ k : k ∈ invariantsMapping[concept] for a concept named in the artifact }`. Slice = touched keys' pins + their 1-hop import dependents (from the extractor's import graph of the touched files). If the artifact names a shared concept with no path and no mapping entry, the slice header carries `unmapped-concept: <name>` (honest gap, never a silent empty slice). Injection lives in the existing prompt builders (`buildUpstreamReviewPrompt`, `buildSpecReviewPrompt`); slices are additive-only (DEC-5).

### Layer R3 — Per-reviewer duties (PBR specialization) — advisory text + mandatory engine validators
Each duty ships as a pair: (prompt line, deterministic validator run in-engine at stage assembly or review-findings assembly). The validator's output is rendered INTO the prompt (so the reviewer sees machine findings, not self-derives them):
- **requirements-reviewer**: duty — any AC modifying a touched shared surface declares an **amendment family**. Validator — machine-readable `amendmentFamily` block in the artifact's structured control (rendered via the existing renderAndWrite control pipeline, not free prose); blocks stage progression when a touched shared surface has no family declaration (ownerStage=requirements).
- **bdd-reviewer**: duty — every baseline-pinning scenario is owned (this spec's family) or declared `inherited/frozen` with anchor. Validator — parses scenario tags `@owned(<pinId>)` / `@inherited(<pinId>)` against the slice; unowned pins on touched surfaces are blocking (ownerStage=bdd). Plus prose sweep duties (declarative style, scenario overlap, no implementation coupling) — advisory only, honestly labeled.
- **design-reviewer**: duty — family ⊇ pins on touched surfaces (set inclusion). Validator — deterministic set-inclusion check (family entries from the requirements control vs slice pinIds); the LLM reviews the design's tradeoff quality (ATAM-lite), never the inclusion itself.
- **spec-reviewer**: D2 re-labeled honestly as "LLM consistency checklist (naming/constants/signatures)" + a new engine-rendered **inventory reconciliation section** (the deterministic cross-check result) that D2's pass/fail must cite. D4 testability unchanged.

### Layer R4 — Calibration scoping (engine seam, verified + bounded)
Implemented in `enforceReviewerConvergenceDuty` (`src/review-findings.ts`), not in prompt text: a finding qualifies for the **evidence-pair exemption** iff (a) both cited loci exist on disk at the stated file:line, and (b) ≥1 locus belongs to the stage's injected slice (pin id or protected file). Exempt findings survive late-round suppression; **bounded** at 1 exempt finding per review round — a second exemption in the same round escalates to the judge instead of blocking (blocker-storm fuse preserved, HIGH-4). Prompt text adds the matching instruction + artifact-order neutrality line (do not weight the first-listed upstream artifact).

### Layer R5 — Escape-rate measurement (dedicated minimal harness; DEC-6 amended ⚖)
Offline harness (NOT the in-pipeline eval stage): for each golden fixture (planted contradiction in a synthetic mini-spec, incl. the exact SCENARIO-014 shape), dispatch the reviewer agent fresh, and score **finding-level attribution** — pass iff a blocking finding cites the planted pinId/locus (CoVe-style: rejection for unrelated reasons is a FAILURE, closing the false-agreement oracle). Verdict rows are still emitted to the eval layer as `scorerKind: "reviewer-harness"` rows for σ-band tracking (additive schema extension), but the gate decision uses attribution, not verdict strings. Runs on every reviewer-prompt, validator, or grammar-table change.

## 4. Decisions (DEC — owner-adjudicable at grill)

- **DEC-1** Architecture doc stays single; per-reviewer behavior lands only in code choke points (prompt builders, validators, `review-findings.ts` seam) + the inventory module.
- **DEC-2** Hybrid detection: mechanical extraction produces candidates with loci; LLM adjudicates. LLM free-form corpus conflict search is prohibited as a primary mechanism.
- **DEC-3** No reviewer debate (controlled-study evidence); the adversarial gate is the useful form.
- **DEC-4 ⚖ (grill: owner-decidable → proxy ruling)** Two distinct failure modes: **absent tree/suite → silent fail-open** (status quo, never worse); **extraction ERROR on an existing tree → fail-loud**: engine error log + `[contract-inventory: extraction failed — review slice incomplete]` banner injected into the affected prompts. Silent blinding on a present tree violates P10.
- **DEC-5** Slices are additive-only; reviewer inputs never shrink without a separate owner decision.
- **DEC-6 ⚖ (grill: owner-decidable → proxy ruling)** Coarse verdict-string agreement is rejected as the oracle (false-agreement). D-R-D is a dedicated minimal offline harness with finding-level planted-locus attribution; eval-layer integration is additive rows only. The "no new infrastructure" claim is withdrawn.
- **DEC-7** KAOS resolution vocabulary (restore / weaken / avoid / guard-introduction) is the shared language for amendment-vs-pin resolutions across writer and reviewer prompts.

## 5. Delta requirements

- **D-R-A** Inventory extractor (`src/review/contract-surface.ts` candidate): grammar-table-driven extraction (§3 table), traversal, per-file index, invariants.json + mapping file loading, unanchored/unmapped reporting; golden-fixture unit tests incl. the SCENARIO-014 shape.
- **D-R-B** Validators + engine seam: amendment-family control schema + per-stage validators (R3), `enforceReviewerConvergenceDuty` verified-bounded exemption (R4); source-contract tests pin the seam.
- **D-R-C** Prompt-builder deltas: slice injection + duty lines + order-neutrality line; tests pin injection shapes and additive-only property.
- **D-R-E** Reviewer report schema delta (the ONLY strongly-typed addition): findings[] gains optional `evidenceLoci: Array<{file, line?, ref?}>` — machine-verified by the R4 seam (loci exist on disk ∧ ≥1 locus ∈ stage slice; absent ⇒ no exemption eligibility, fail-closed harmless) and required by the R5 attribution scorer. Rendered reports add the `Loci:` line, the engine-written Contract Inventory Reconciliation section (spec-review), and the `[evidence-pair exempt]` marker. Verdict vocabulary, controlKeys, dimensions structure, and all prose-inference helpers unchanged (additive-only, DEC-5 shape).
- **D-R-D** Offline reviewer harness + golden fixtures + finding-level attribution scorer + additive `reviewer-harness` eval rows.

## 6. Non-goals

No new reviewer roles; no access-mode changes (reviewers stay source-read-only; the extractor runs in-engine); no full-repo reviewer inputs; no stage renumbering; no change to convergence caps or the judge; **no edits to legacy sibling specs' artifacts** (their pins are legitimate; unanchored prose pins are carried via `repo-invariants.json`/mapping file + honest `unanchored:` listing instead); no implementation-side changes (covered by `058-cross-phase-contract-architecture.md` P2); no in-pipeline reviewer scoring at run close-out (R5 is offline by design).

## 7. Waves sketch

- **R1A wave** (v0.3.97 candidate): D-R-A + D-R-B — extractor, validators, engine seam; **deterministic unit/fixture tests are the only acceptance gate** (no LLM behavior claims).
- **R1B wave**: D-R-C — prompt deltas (slices + duty lines + R4 instruction), gated by injection-shape tests; live reviewer catch-rate is explicitly NOT an R1B gate.
- **R2 wave**: D-R-D — offline harness + fixtures; the planted-SCENARIO-014 catch becomes an enforced gate here.
- Ordering vs cross-phase **P2** (D-B two-strike + D-D rollback): independent surfaces; either may go first per owner.
- Convention: glm-5.3 implementer + dual gemini-3.8-flash gates (code + adversarial), delta re-gate on fix rounds.

## 8. Sources

1. van Lamsweerde, "Handling Obstacles in Goal-Oriented Requirements Engineering" (KAOS) — https://www-di.inf.puc-rio.br/~julio/TSE-Obstacles.pdf
2. Wyzer, "Contradiction Detection: Why Hybrid Approaches Win" — https://wyzer.it/blog/contradiction-detection-hybrid-approaches
3. "ContraGen: A Multi-Agent Generation Framework for Contradiction Generation and Detection" — https://arxiv.org/html/2510.03418v1
4. "Improved Evidence Extraction for Document Inconsistency Detection" — https://arxiv.org/html/2601.02627v1
5. Basili et al., "The Empirical Investigation of Perspective-Based Reading" — https://www.cs.umd.edu/~mvz/handouts/emp_pbr.pdf
6. "Fagan inspection" — https://en.wikipedia.org/wiki/Fagan_inspection
7. ISO/IEC/IEEE 29148-2018 — https://standards.ieee.org/standard/29148-2018.html
8. Gentili et al. 2025, "Practitioners' perceptions on requirements smells" — https://www.sciencedirect.com/science/article/pii/S0950584925001624
9. Alemneh et al. 2024, "Software Requirement Smells and Detection Techniques: A SLR" — https://cit.iict.bas.bg/CIT-2024/v-24-4/10341-Volume24_Issue_4-05_paper.pdf
10. "Multi-label software requirement smells classification" (Nature Sci Rep 2025) — https://www.nature.com/articles/s41598-025-86673-w
11. Cucumber, "Writing better Gherkin" — https://cucumber.io/docs/bdd/better-gherkin/
12. "Declarative vs Imperative Gherkin Scenarios" — https://itsadeliverything.com/declarative-vs-imperative-gherkin-scenarios-for-cucumber
13. SEI CMU, "ATAM Collection" — https://www.sei.cmu.edu/library/architecture-tradeoff-analysis-method-collection/
14. Sahlabadi et al. 2022, "Lightweight Software Architecture Evaluation for Industry" — https://pmc.ncbi.nlm.nih.gov/articles/PMC8838159/
15. Shi et al. 2025, "A Systematic Study of Position Bias in LLM-as-a-Judge" — https://aclanthology.org/2025.ijcnlp-long.18.pdf
16. OpenLayer, "LLM-as-judge: A complete guide" — https://www.openlayer.com/blog/llm-as-judge-evaluation-guide
17. "An Empirical Study on Multi-Agent Debate for Coding Tasks" — https://arxiv.org/html/2503.12029v2
18. "Can LLM Agents Really Debate? A Controlled Study" — https://openreview.net/forum?id=qsKo9mdGNu
19. Hong et al., "MetaGPT" — https://arxiv.org/html/2308.00352v7
20. Dhuliawala et al., "Chain-of-Verification Reduces Hallucination in LLMs" — https://arxiv.org/abs/2309.11495
21. ozimmer, "How to review Architectural Decision Records (ADRs)" — https://ozimmer.ch/practices/2023/04/05/ADRReview.html
22. NASA SWEBOK Handbook, Requirements review characteristics — https://swehb.nasa.gov/plugins/viewsource/viewpagesrc.action?pageId=32604505
