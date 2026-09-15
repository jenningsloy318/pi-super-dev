# First-Pass Satisfiability — the Write-Claim Spine

Status: v3 — implementer wave landed + dual gates (glm-5.3-flash: Code FAIL 1H+4, Adversarial REJECT 3B+6A) folded; all deterministic, 4132/4132 green. (Prior: grill round 1 NOT-READY(conditional) 3H+5M+1L folded.) Parent lineage: 058 (protection intervals), 059 (reviewer quality / contract inventory). This spec is the **closure** of both: it makes write-vs-protect contradictions **deterministically detectable before any implementer attempt burns**, which is the property whose absence caused both replans of run `2026-09-14T11-40-21-540Z`.

---

## 0. The incidents (one run, two replans, one root cause)

Run `2026-09-14T11-40-21-540Z` (omisis spec-26, v0.4.2 — **with** 058 P2 + 059 R1A/R1B already landed) replanned twice, both owned by `spec` via `stage9.protection-breach`, conf 0.88, `resumeRowsDropped` 17/21:

| Replan | Trigger | Protected-path source |
|---|---|---|
| 1 (13:10:13Z) | Phase-02 `requireFiles` mandates creating `python/tests/test_screen_ops.py` (plan :43) while the path is protected | A pin minted from the plan's **own** phase 3–5 prose: *"extends python/tests/test_screen_ops.py; … never touching the registry surface"* — `pathTokens[0]` took the **write target** as the protected file |
| 2 (15:34:53Z) | AC-14 + SCENARIO-021 + task-list :20 mandate editing `docs/requirements/22-public-interface.md` while the engine protects it | A pin minted from the **regenerated task list** (11-task-list.md:22, written 22:19) — and the spec's `amendmentFamily` declared the file only in `docUpdates` **prose**, so the exemption set (built from `sharedFile`) missed it |

Both judge diagnoses verbatim: *"Upstream … contradiction, not an executor fault."* The three protection derivations across the run (run.log 20:30:38.300 / 22:22:25.651 / 01:29:23.744) prove the protected set is a moving target minted from the pipeline's own regenerated prose: pass 1 protected 8 paths (incl. the write target + phantoms `${wiredFile}`, `${pathspec}`); pass 2 protected 3 (incl. the prose-orphaned sibling doc); pass 3 finally exempted it.

## 1. Root cause — one sentence

**Every seam where the pipeline needs typed paths/pinIds it instead re-extracts them from untyped prose with a different heuristic — and no gate ever computes, over a fresh walk, the one cross-product that defines the contradiction class: write-mandates × protected-paths ∖ exemptions.**

## 2. Defect table (code-evidenced; amended per grill round 1)

| # | Defect | Evidence |
|---|---|---|
| D1 | Protection interval enforces pins minted from the spec's **own artifacts** with no locus filter, while the validator side excludes self-minted pins from demands | `deriveProtectionInterval` vs `demandablePins(selfArtifactMatch)`; run derivations 461/1746 |
| D2 | Pin **resolution** takes the first path token from a wide window / bare pathspec arm: "extends X … never touching Y" protects **X**; template variables (`${wiredFile}`, `${pathspec}`) become phantom protected paths. **Arm correction (grill MED-1):** the phantoms enter via `porcelainPathspecAfter` (plan-feasibility.ts arm) AND `literalPathTokens(from-200, to+200)` (contract-surface.ts:229) — token validation must apply at **pin resolution** (`hit.pathTokens[0]` and the composed scanner path) to cover both arms | financials-contract.test.ts:843, prosperity-contract.test.ts:439 |
| D3 | Exemptions apply only to `sharedFile`+pinId; writers express amendments in `docUpdates` prose → exemption silently missing (3 spec passes to converge) | spec-26 `.knowledge.json` stages.spec.data.amendmentFamily entry[12] |
| **D4 (amended)** | "Approved with MISMATCH visible" was **three stacked sub-mechanisms**, of which reviewer-override is the least load-bearing (grill HIGH-1): (a) the reconciliation is **prose stamped after the gate** — the approval predicate never reads `mismatches.length` (spec-convergence.ts approval block: `approved = (review.pass \|\| …) && verdictBlocking === 0`, reconciliation stamped at 20:30:37.887, approval at .890); (b) `specAmendmentFamilyFindings` returns `[]` whenever **design declared a family** — the spec-side set-inclusion never ran; (c) **decisive:** the mismatch set is computed from the writer's INPUT-slice stamp (`contractValidationContext(state, "spec", [task, requirements, …])`, `readContractSliceStamp`) — the replan-2 pin was minted from the task list written at 22:19, after the ~20:30 stamp, so **no validator could see it**: at approval time the file was not an inventory key at all | spec-convergence.ts; contract-validators.ts design-declared skip; contract-surface.ts `touchedProtectedFiles`; derivation timeline |
| D5 | The write×protect cross-product is computed nowhere pre-implementation; contradictions surface only via two-strike + judge + replan | both replans routed from `stage9.protection-breach` |
| D6 | Two idiom grammars with different mint conditions: Check 3 requires porcelain+wording co-presence (test files) vs `scanPorcelainMd` minting on **wording alone** (prose) — the entry gate can pass what enforcement enforces | plan-feasibility.ts vs contract-surface.ts:214 |
| D7 (new, grill MED-3) | The `.knowledge.json` `amendmentFamily` read is **already duplicated** across two fail-closed readers (`approvedAmendmentSharedFiles`, `readAmendmentFamilySharedFiles`) — a P6 drift this spec must absorb, not extend | protection-interval.ts, plan-feasibility.ts |

## 3. Research grounding

- **ALICE** (Gärtner & Göhlich, *Autom Softw Eng* 31:49, 2024): structural `condition⇒effect` decomposition reaches 60–75% recall / 83–94% precision on requirement contradiction pairs; LLM-only review: 0–32% recall (0% precision on the real-world set). D4 is a measured ceiling, not a prompt defect.
- **PlanCompiler** (arXiv:2604.13092): typed plan + deterministic compile-time checks, **no repair loop**: 92.67% first-pass vs 62–67% agentic; 8–77× cheaper. The winning shape: type the claims, check mechanically, execute once.
- **Boehm's cost curve**: defect-removal cost escalates 10–100× with phase; our discovery point (mid-implementation, post-judge) is the most expensive available.

## 4. Architecture — one spine, four gates (timing pinned per grill HIGH-1)

### 4.1 The spine (`src/review/claim-spine.ts` — the single grammar, P6)

```
WriteClaim   { path, verb: create|extend|amend|delete, locus, sourceStage }
ProtectClaim { path, locus, pinId?, family }   // wraps the existing ContractPin
```

`extractWriteClaims(texts, loci, conceptMap)` — deterministic, pure; the **write side consumes `inventory.mapping`/`concepts`** (grill MED-2) so concept-references ("spec 22's package layout gains …") mint claims via the same mapping the protect side already uses.

**Enumerated grammar table (P2 binding — all mainstream forms, verified against the run's own sentences):**

| Form | Example (verbatim from the run) | Classification |
|---|---|---|
| Verb-governed write | "**docs/requirements/22-public-interface.md** §4 **gains** the data/cache note" (the verbatim rooted form — F-5 fold: the v2 table abbreviated the path; bare ambiguous tokens are dropped conservatively) | WRITE(docs/requirements/22-public-interface.md) |
| Path-token precondition | a token counts only when repo-rooted (src/, tests/, docs/, python/, …) or symmetrically quoted | bare ambiguous tokens mint nothing (precision over recall) |
| Verb-governed protect | "src/stages.ts, src/orchestrator.ts, src/screen-phase1.ts **stay byte-untouched**" | PROTECT(all three — **list governance**: the qualifier governs every token in its list/segment, not `pathTokens[0]`) |
| Post-positioned protect qualifier | "the deliverable requireNotContains guard **pins** python/omisis/_fetchers.py **byte-untouched**" | PROTECT(_fetchers.py) — "pins … byte-untouched" added to the protect verb grammar; nearest-qualifier association, backward-looking |
| Mixed single sentence | one WRITE ("gains") + one PROTECT ("pins … byte-untouched") in one sentence (comma or semicolon) | **both** claims mint; the between-guard rejects a protect association when a WRITE VERB or sentence ender sits between token and qualifier (B1 fold). **Same token both-governed ⇒ BOTH mint** (A3 fold): the self-contradiction stays visible to Gate E instead of being hidden by a protect-only resolution |
| List context | "Files edited: src/runtime-dispatch.ts, src/tools/data_analyst.ts, tests/…test.ts (NEW), docs/…07-staged-execution.md" | WRITE(every listed token — list governance again) |
| Negation | "must not gain", "without touching X" | no claim (guard: negated verb ⇒ token is NOT a write claim) |
| Noun form | "the byte-untouched guard" | no protect claim from the noun alone (adjective must govern a path token) |
| Concept reference | "spec 22's package layout gains the note" (no literal path) | WRITE(mapping["package layout"]) via conceptMap |
| Template/invalid token | `${wiredFile}`, `${pathspec}`, bare identifiers | **rejected at pin resolution** — validation applies at `hit.pathTokens[0]` AND the `porcelainPathspecAfter` arm (D2 correction) |

### 4.2 Gate W — writer gate (authoring stages, **fresh post-render walk**)

Runs after render for **authoring stages only** (requirements/bdd/design/spec writers and the plan/task rendering inside the spec stage — **not review writers**, whose drafts quote plan prose; quoted write-mandates must not mint claims at the review stage — grill MED-5). The engine walks the just-written artifacts **fresh** (not the input-slice stamp — the grill HIGH-1(c) hole), extracts write-claims, and enforces the typed-closure rule:

> Every write-claim path that carries a foreign pin must appear as some `amendmentFamily` entry's `sharedFile`.

`docUpdates` prose paths count as claims (extracted), so prose cannot bypass the exemption grammar (kills D3). On violation: deterministic validation failure with a repair demand naming both loci (claim locus + pin locus), riding the existing render-retry loop (`state.__feedback`). **P8 bound (named, grill MED-4):** the convergence round cap (`MAX_CONVERGENCE_ROUNDS = 8`) with the strict-progress extension; two legal escapes for genuinely unsatisfiable closure — drop the write-claim (the spec stage owns the artifact) or declare the `sharedFile` entry with a justification (audited by Gate R).

### 4.3 Gate R — verdict-binding **demandable-set** validation (grill HIGH-3 scoped)

The blocking scope is the **demandable set** — `demandablePins(slice, inventory, selfArtifactMatch)` semantics: self-minted pins excluded, slice-visible pins only (the 2026-09-14 whack-a-mole carve-outs preserved). Concretely:

1. The approval predicate **reads the validator findings** (`specAmendmentFamilyFindings` / `designAmendmentFamilyFindings` kind:"blocking" rows) — Approved-with-unresolved-demandable-blocking becomes structurally impossible (fixes D4(a)).
2. The **design-declared skip** in `specAmendmentFamilyFindings` is conditioned: design having declared a family skips the spec-side *declaration* demand only when the design family covers the spec's fresh write-claims (fixes D4(b)).
3. The reconciliation prose remains an advisory rendering; the **binding set is the typed validator output**, refreshed with the Gate W post-render walk (fixes D4(c) jointly with Gate W).

The reviewer's role narrows to auditing exemption **justifications** (ALICE: what LLMs are good at).

### 4.4 Gate E — entry gate (Stage 9 entry, fresh walk, honest routing)

One deterministic assertion over the entry-time fresh walk:

```
writeClaims(requirements ACs, scenarios, design, spec, plan requireFiles, task bullets)
  × protectClaims(fresh inventory, unified grammar, phantoms rejected, self-minted included)
  ∖ exemptions(sharedFile × pinId)
  = ∅   — else HARD BLOCK naming both loci
```

Self-minted pins are **included** here (D1): a spec that writes X and protects X is caught at entry regardless of which artifact minted the pin. **Routing (DEC-3 amended per grill HIGH-2):** initially via the **existing replan machinery** (route replan-upstream with the two-locus mechanical finding) — correct though slower: no implementer attempt burns, no judge call needed for diagnosis (the finding IS the diagnosis), cost is the replan cycle itself. A follow-up routing wave wires `RouteBackSignal({from: "implementation", to: "spec"})` into the inline walker (`withInlineRouteBack` exists; the throw site is new) to trade the restart for an inline jump ("minutes not cycles" — never "seconds"; the v1 claim is withdrawn). **Scan-cap behavior (grill LOW):** when `MAX_SCAN_FILES` truncates the walk, Gate E emits a loud P10 scan line and treats protectClaims as partial-but-authoritative (no fail-open of the whole gate; contradictions found in the partial walk still block; the cap is surfaced, never silent).

### 4.5 Gate I — interval gate (unchanged enforcement, corrected inputs)

`deriveProtectionInterval` consumes spine-validated protect-claims: phantoms rejected at resolution, list-governed multi-target protections correct. Two-strike education/judge machinery unchanged — it now only sees genuine executor faults.

## 5. Decisions (amended per grill)

- **DEC-1** One extractor, four consumers; token validation applies at pin **resolution** (both arms); the grammar table in §4.1 is binding (P2).
- **DEC-2** Prose is claim-evidence, never exemption-evidence.
- **DEC-3 (amended)** Gate E routes via existing replan machinery first (correct, slower); the inline `RouteBackSignal` throw site is a follow-up routing wave. Cost honesty: entry-block ≈ one replan cycle *without* burned implementer attempts, judge diagnosis calls, or two-strike escalation; inline-jump follow-up reduces it further.
- **DEC-4 (amended)** Verdict-binding binds the **demandable set** (validator output), not the raw reconciliation residual; raw-residual binding deadlocks clean runs (grill HIGH-3).
- **DEC-5** Fail-open boundaries preserved (absent tree ⇒ empty claims ⇒ gates pass); token-validation rejects and scan caps are loud scan lines (P10).
- **DEC-6 (amended)** Two waves: **core wave** (D-F-A…D-F-E — extractor + four gates + read unification; cohesion preserves the single-grammar invariant) and a **follow-up routing wave** (the walker throw site). The core wave lands as one version bump.
- **DEC-7 (new)** D-F-A **unifies the `.knowledge.json` amendmentFamily read into one exported helper**, absorbing the two existing duplicated readers (D7) — this is the condition under which 065-before-063 minimizes rework (063 then redirects one site).

## 6. Non-goals

- No SAT/SMT encoding of AC semantics (the contradiction class is path-set algebra; formal logic adds machinery without catching more of THIS class).
- No change to judge, two-strike education, replan invalidation semantics, prompts, agent skills, or model routing.
- Not moving rendered reports or state storage (063 owns that family; see §8).

## 7. Delta requirements

- **D-F-A claim-spine module + read unification** — `extractWriteClaims` (grammar table above, conceptMap-fed) + resolution-time token validation + the single exported `.knowledge.json` amendmentFamily reader replacing both duplicated readers; `extractContractInventory` internals adopt the validated extractor; Check 3 becomes a consumer.
- **D-F-B writer gate** — post-render fresh-walk typed-closure validation on authoring stages, repair-demand feedback, P8 bounds named.
- **D-F-C reviewer gate** — approval predicate consumes validator blocking rows; design-declared skip conditioned; demandable-set scope.
- **D-F-D entry gate** — the Stage-9-entry cross-product with two-locus findings via existing replan routing; scan-cap loud partial semantics.
- **D-F-F plan compile-time checks (added post-grill, the implement/tdd-retry reducer)** — over the typed plan control: forward-file-reference resolvability (clause targets exist on disk or are an earlier/equal phase's requireFiles output), requireScenarios resolvability, AC write-set coverage. **D-F-F(b) create-collision DROPPED (gate B3)**: phases execute strictly sequentially, so two phases declaring the same NEW file is the canonical create-then-extend TDD handoff — the check banned a legal plan shape. Revisit only when the plan grows a parallel-groups field. All mechanical, all at spec render + entry.
- **D-F-E acceptance fixtures** (deterministic):
  - **A** replan-1 shape: "extends tests/foo.py … never touching the registry" + phase-2 `requireFiles: tests/foo.py` ⇒ no protection mints on foo.py (inversion dead); entry gate passes.
  - **B** replan-2 shape: AC mandates a pinned sibling doc declared only in `docUpdates` ⇒ Gate W fails with both loci; after the sharedFile entry ⇒ passes; Approved-with-unresolved-demandable-blocking impossible.
  - **C** phantoms: `${wiredFile}` / `${pathspec}` / bare identifiers rejected at **both** resolution arms.
  - **D** self-contradiction: self-spec "X stays byte-untouched" + write-claim on X ⇒ Gate E blocks with both loci; without the write-claim ⇒ protection stands.
  - **E** regression: current passing behavior byte-identical.
  - **F (new)** starved-slice temporal case: a pin minted from the task list *after* the input-slice stamp still reaches Gate W (fresh post-render walk) and Gate E (entry walk).
  - **G (new)** concept-reference write claim via conceptMap.
  - **H (new)** Gate R non-blocking residual: self-minted + beyond-slice-cap pins do NOT block (demandable-set scope).
  - **I (new)** routing: Gate E finding rides the replan path with the mechanical two-locus diagnosis (no judge call).
  - **J (new)** grammar rows: negation ("must not gain"), noun form, list context, post-positioned qualifier — each classified per the §4.1 table.
  - **K (new)** scan-cap: truncated walk ⇒ loud partial semantics.
  - **L (new)** D-F-F: forward-reference phase DAG, overlapping parallel write-sets, unresolvable requireScenarios, uncovered AC write-mandate — each blocked with loci.

## 8. Sequencing (amended per grill MED-3; replaces v1's "no cross-dependency")

The seam is real: Gates W/E read `.knowledge.json` `amendmentFamily`; 063 relocates that file. **DEC-7 is the condition**: with the read unified into one helper, 065-first leaves 063's D-S-B exactly one new site to redirect (the helper), and 063-first would leave 065 writing readers it must immediately re-point. Order:

1. **060 mini-wave** (accessMode pin tests + fail-open loud notice) — only if touch-disjoint from the Gate E wiring; else after 065.
2. **065 core wave** (D-F-A…D-F-E + D-F-F) — the active-cost-first priority: every complex run risks the replan class.
3. **065 follow-up routing wave** (RouteBackSignal throw site).
4. **063 S1 → S2** — redirecting the unified family-read helper in S2's census.
5. Parked: 061 disclosure, 064 bandit (INDEX triggers).

### Gate-fold rulings (2026-09-15, dual glm-5.3-flash gates)

- **A4 (documented decision):** Gate W runs ADVISORY at requirements/bdd (intent stages — 059 W2: the typed family is a design/spec home) and BLOCKING at design/spec. The W-strict (full-inventory closure; repair = declare sharedFile, satisfiable without slice visibility) vs R-loose (demandable set) asymmetry is deliberate: W's repair never needs pin-level visibility, R's verdict does.
- **A5:** Gate E's replan-unavailable fallback is a **FatalAbort HARD BLOCK** naming the contradictions — executing a proven-contradictory plan punishes everything downstream. (The v0.3.85 log-and-proceed fallback is superseded for this gate.)
- **A6:** a malformed amendmentFamily entry surfaces at Gate W as a blocking repair demand ("while ANY entry is malformed, Gate E honors ZERO exemptions") — the two fail-closed semantics unified toward strict-void-all with the repair at the writer.
- **F-4 residual hole (found by the fix round's own fixtures):** `scanPorcelainTs` composed the OLD silent-dropping scanner and fed the raw pathspec straight into pathTokens — the `${wiredFile}` phantoms entered the inventory through THAT arm, not literalPathTokens. Fixed: the ts arm composes `scanImmutabilityIdiomsWithRejects`, filters unusable pathspecs, and surfaces rejects as P10 scan lines; `python/` added to the md arm's rooted-prefix set (single spelling with the spine).

Sources: ALICE — doi:10.1007/s10515-024-00452-x. PlanCompiler — arXiv:2604.13092. Boehm — cost-of-change curve (NASA NTRS 20100036670).
