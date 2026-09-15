# First-Pass Satisfiability — the Write-Claim Spine

Status: draft — 2026-09-15, grounded in the omisis spec-26 double-replan investigation + ALICE/PlanCompiler research. Awaiting grill, then single-wave implementation.

Parent lineage: 058 (protection intervals), 059 (reviewer quality / contract inventory). This spec is the **closure** of both: it makes write-vs-protect contradictions **deterministically detectable before any implementer runs**, which is the property whose absence caused both replans.

---

## 0. The incidents (one run, two replans, one root cause)

Run `2026-09-14T11-40-21-540Z` (omisis spec-26, v0.4.2 — **with** 058 P2 two-strike + 059 R1A/R1B already landed) replanned twice, both owned by `spec` via `stage9.protection-breach`:

| Replan | Trigger (judge, conf 0.88) | Protected-path source |
|---|---|---|
| 1 (13:10Z) | Phase-02 `requireFiles` mandates creating `python/tests/test_screen_ops.py` (plan :43) while the path is protected | A pin minted from the plan's **own** phase 3–5 prose: *"extends python/tests/test_screen_ops.py; … never touching the registry surface"* — the scanner's `pathTokens[0]` took the **write target** as the protected file |
| 2 (15:34Z) | AC-14 + SCENARIO-021 + task-list :20 mandate editing `docs/requirements/22-public-interface.md` while the engine protects it | A pin minted from the **regenerated** task list (:22), and the spec's `amendmentFamily` declared the file only in `docUpdates` **prose** — the exemption set (built from `sharedFile` fields) never covered it |

Both judge diagnoses verbatim: *"Upstream … contradiction, not an executor fault"* / *"The implementer obeyed the plan both times; re-prompting cannot fix this."* Cost per replan: burned implementer attempts + a judge call + 17–21 resume-cache rows dropped.

**The protection derivations across the run prove the set is a moving target minted from the pipeline's own prose:** pass 1 protected 8 paths (incl. the write target + phantoms `${wiredFile}`, `${pathspec}`); pass 2 protected 3 (incl. the prose-orphaned sibling doc); pass 3 finally exempted it — three spec passes to converge on what one deterministic check computes instantly.

## 1. Root cause — one sentence

**Every seam where the pipeline needs typed paths/pinIds, it instead re-extracts them from untyped prose with a different heuristic — and no gate ever computes the one cross-product that defines the contradiction class: write-mandates × protected-paths ∖ exemptions.**

## 2. Defect table (all code-evidenced)

| # | Defect | Evidence |
|---|---|---|
| D1 | Protection interval enforces pins minted from the **spec's own artifacts** (`extractContractInventory` scans `docs/specifications/**/*.md`, including self); the validator side excludes self-minted pins from demands (`demandablePins(selfArtifactMatch)`) but `deriveProtectionInterval` has no locus filter | run.log derivations 461/1746 vs contract-validators.ts:131 |
| D2 | `pathTokens[0]` over a ±200-char window mints pins from the wrong file: "extends X … never touching Y" protects **X**; template variables (`${wiredFile}`, `${pathspec}`) become phantom protected paths | contract-surface.ts:229 (`literalPathTokens(text, from-200, to+200)`), financials-contract.test.ts:843, prosperity-contract.test.ts:439 |
| D3 | Exemptions apply only to `sharedFile`+pinId entries; writers naturally express amendments in `docUpdates` prose → exemption silently missing | spec-26 `.knowledge.json` entry[12]: `sharedFile: ".gitignore"` with `22-public-interface.md` buried in docUpdates |
| D4 | The spec-review's mechanical reconciliation printed `set-inclusion: MISMATCH`; the LLM verdict still said "fully reconciled … Zero cross-artifact contradictions exist" | 12-spec-review.md:36 vs :123 |
| D5 | Write-mandates × protections is never computed pre-implementation; contradictions surface only via two-strike + judge + replan | both replans routed from `stage9.protection-breach` mid-phase-02 |
| D6 | Two idiom scanners with different grammars: Check 3 (`scanImmutabilityIdioms`, plan text) vs the interval (`extractContractInventory` md/py/ts forms) mint different pins — the entry gate can pass what enforcement enforces | plan-feasibility.ts vs protection-interval.ts |

## 3. Research grounding (why this design, not "better prompts")

- **ALICE** (Gärtner & Göhlich, *Autom Softw Eng* 31:49, 2024): decomposing requirements into `condition⇒effect` constituents and comparing **structurally** reaches 60–75% recall / 83–94% precision on contradiction pairs; **LLM-only review of the same pairs: 0–32% recall, 0% precision on the real-world set**. D4 is not a prompt defect — it is the measured ceiling of prose review.
- **PlanCompiler** (arXiv:2604.13092): an LLM emitting a typed plan that passes deterministic compile-time checks, with **no repair loop**, achieves 92.67% first-pass success vs 62–67% for agentic execution and is 8–77× cheaper per success. The winning shape is *type the claims, check them mechanically, execute once* — exactly the "do it once" objective.
- **Boehm's cost curve**: defect-removal cost escalates 10–100× with phase. Our discovery point (mid-implementation, post-judge) is the most expensive available; the fix moves it to render time.

## 4. Architecture — one spine, four gates

### 4.1 The spine (`src/review/claim-spine.ts` — new module, the single grammar)

```
WriteClaim   { path, verb: create|extend|amend|delete, locus: "<file>:<line>", sourceStage }
ProtectClaim { path, locus, pinId?, family }   // wraps the existing ContractPin
```

`extractWriteClaims(texts, loci)` — deterministic, pure:
- Path tokens validated (`claimPathUsable` + reject `${…}` template forms, bare identifiers, non-path-looking strings — kills D2 phantoms).
- **Verb-context classification**: a token governed by *extends / adds / gains / creates / writes / edits / amends / lands / ships* is a WRITE claim; a token governed by *byte-untouched / never touching / stays clean / immutable / porcelain* is a PROTECT claim. The two grammars never mint the same token in the same statement — the inversion ("extends X … never touching Y" protects X) becomes structurally impossible.
- The SAME extractor feeds Check 3, the inventory, the slice builder, and the interval (kills D6).

### 4.2 Gate W — writer gate (render-time, every stage)

After the writer renders, the engine extracts the draft's write-claims and cross-checks the typed closure rule:

> **Every write-claim path that carries a foreign pin must appear as some `amendmentFamily` entry's `sharedFile`** — `docUpdates` prose paths count as claims (they are extracted), so hiding the file in prose no longer bypasses the exemption grammar (kills D3).

On violation: deterministic validation failure with a repair demand naming both loci (the write claim's locus + the pin's locus), riding the existing render-retry loop (`state.__feedback`). Zero agent cost, sub-second.

### 4.3 Gate R — reviewer gate (verdict-binding reconciliation)

The engine-written Contract Inventory Reconciliation becomes **verdict-binding** (kills D4): while any set-inclusion MISMATCH residual is unresolved in typed form (`pinsMoved` / `exemptions[].pinId`), the stage's control **cannot validate as Approved** — the engine merges mechanical findings as blocking rows into the convergence, exactly like render-validation; the LLM reviewer's prose cannot clear them. The reviewer's role narrows to what ALICE shows LLMs are good at: auditing exemption *justifications* (the legal basis), not detecting the inconsistency.

### 4.4 Gate E — entry gate (Stage 9 entry, the cross-product)

At implementation entry, one deterministic assertion:

```
writeClaims(all stages: requirements ACs, scenarios, design, spec, plan requireFiles, task bullets)
  × protectClaims(inventory, unified grammar, phantoms rejected)
  ∖ exemptions(sharedFile × pinId)
  = ∅      — else HARD BLOCK naming both loci, routed to spec revision
```

This is the check whose absence caused both replans (kills D1, D5). It replaces nothing — Check 3's plan-text scan becomes a thin wrapper over the same extractor (D6 closure). Failures route as **spec revision with mechanical findings**, not replan: the spec stage re-renders with the two-locus contradiction injected as feedback (the render-retry path), costing seconds, not a replan cycle.

### 4.5 Gate I — interval gate (unchanged enforcement, corrected inputs)

`deriveProtectionInterval` keeps its semantics but consumes spine-validated protect-claims: phantoms rejected, self-minted pins only enforced when consistent with the spine (Gate E already guaranteed contradiction-freedom before the interval arms). Two-strike education/judge machinery unchanged — it now only sees genuine executor faults.

## 5. Decisions (DEC — owner-adjudicable)

- **DEC-1** One extractor, four consumers (P6 single grammar). Wrapping is preferred over rewriting: `extractContractInventory` internals adopt the token validator + verb-context classification; Check 3 calls the same functions.
- **DEC-2** Prose is claim-evidence, not exemption-evidence: paths in `docUpdates`/task bullets/AC text are extracted as write-claims and thereby force typed coverage; they never themselves exempt anything (kills the D3 ambiguity from both directions).
- **DEC-3** Gate E failures route to **spec revision** (render-retry, seconds) rather than replan (invalidation + judge + cache drops). Replan remains reserved for findings that need re-planning semantics (scope change, missing stage outputs) — a two-locus write/protect contradiction never does.
- **DEC-4** Reviewer verdicts are prose over a mechanical floor (ALICE grounding): MISMATCH residuals are engine-owned blocking rows; the reviewer cannot approve past them. No reviewer prompt changes required — the floor is not advisory text, it is control validation.
- **DEC-5** Fail-open boundaries preserved: absent inventory tree ⇒ empty protect-claims ⇒ gates W/E pass (zero false positives on clean trees), same DEC-4 posture as 059. Token-validation rejects are logged as scan lines (P10), never silently.
- **DEC-6** Single wave (this is one cohesive invariant; splitting extractor from gates reintroduces the D6 mixed-grammar drift). Tests land with the wave.

## 6. Non-goals

- No SAT/SMT encoding of AC semantics (ALICE's propositional decomposition is over requirement *pairs*; our contradiction class is path-set algebra — set intersection suffices; formal logic would add machinery without catching more of THIS class).
- No change to the judge, two-strike education, or replan machinery (they remain the executor-fault safety net).
- No new agent roles; no prompt-side "be more careful" changes (P4: what must hold is enforced mechanically).
- Not moving rendered reports or state storage (063 owns that family).

## 7. Delta requirements

- **D-F-A claim-spine module** — `extractWriteClaims` + token validator + verb-context classification; `extractContractInventory` internals refactored onto the validated extractor (phantom rejection, inversion guard); Check 3 becomes a consumer.
- **D-F-B writer gate** — post-render typed-closure validation (write-claims ⊆ sharedFile coverage on pinned paths) with repair-demand feedback; runs in every writer's render-retry loop.
- **D-F-C reviewer gate** — set-inclusion residuals become engine-owned blocking rows bound into control validation; Approved-with-MISMATCH becomes structurally impossible.
- **D-F-D entry gate** — the Stage-9-entry cross-product assertion with two-locus findings routed to spec revision.
- **D-F-E acceptance fixtures** (deterministic only, the 059 convention):
  - **Fixture A (replan-1 shape)**: plan whose phase-3 text reads "extends tests/foo.py … never touching the registry" + phase-2 `requireFiles: tests/foo.py` ⇒ interval does NOT protect foo.py; entry gate passes; Gate W flags nothing. (The pin inversion is dead at birth.)
  - **Fixture B (replan-2 shape)**: AC mandates editing a pinned sibling doc; writer declares it only in `docUpdates` prose ⇒ Gate W fails with the repair demand naming both loci; after the sharedFile entry is added ⇒ passes; a review artifact containing an unresolved MISMATCH cannot validate Approved.
  - **Fixture C**: `${wiredFile}` / `${pathspec}` / bare-identifier tokens ⇒ rejected, logged, zero protected phantom.
  - **Fixture D**: self-spec "X stays byte-untouched" with a write-claim also on X ⇒ Gate E blocks with both loci; without the write-claim ⇒ protection stands (legitimate self-protection preserved).
  - **Fixture E (regression)**: the current passing behavior — sibling pins enforced, exemptions honored — byte-identical outcomes on the existing suite.

## 8. Feature ownership

Owns: the claim-spine extractor and its four gates (W/R/E/I inputs). Does NOT own: state storage/location (063), replan mechanics, judge routing, prompt content. Sequence: independent of 063's waves (operates over in-spec artifacts and repo tests either way); lands as its own version bump after (or alongside) 063 S1/S2 — no cross-dependency.

Sources: ALICE — Gärtner & Göhlich, *Automated requirement contradiction detection through formal logic and LLMs*, Autom Softw Eng 31:49 (2024), doi:10.1007/s10515-024-00452-x. PlanCompiler — arXiv:2604.13092 (typed plan + compile-time checks, no repair loop). Boehm — cost-of-change curve (RE/25 studies; NASA NTRS 20100036670).
