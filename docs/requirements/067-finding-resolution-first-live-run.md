# The finding-resolution gate's first live run — two defects and the demand-set hygiene spec

Status: implemented (v0.4.72–v0.4.79; six grill rounds folded + the sealed-audit layer designed in round 7 and implemented). Lineage below.
Lineage: child of 066 (convergence economy, WS1). Evidence: live run
`2026-09-20T23-42-17-331Z` (v0.4.71 — the first run carrying the full
wave-1 machinery).

---

## 0. What the live run actually showed (receipts, verbatim)

The machinery FIRED — this is not "improved nothing"; it is two named
defects plus one structural observation:

1. **07:54:00 — the WS1 bounce fired for real**: `coverage bounce: 27
   injected blocking finding(s) have no resolution row — … one bounded
   writer re-dispatch follows (agent budget, not a convergence round)`.
   Round 1's writer was re-dispatched with the exact missing-id list.
2. **08:28:56 / 08:55:17 — the gate reports `35 unaddressed… (bounce
   spent)` then `27 unaddressed… (bounce spent)`**: the writer NEVER
   emitted a complete `findingResolutions` map — not on the bounced
   re-dispatch, not on later rounds (partial emission only: 8 of 35 ids
   addressed by round 2's log arithmetic).
3. The injected set contains **infra-residue finding ids that no artifact
   can address**: `codeReview-agent-failed`, `adversarialReview-agent-failed`,
   `testsReview-agent-failed` — delegation-infrastructure failure markers
   from prior runs persisted by the ledger (convergence-ledger.ts:702-717
   mints exactly this `${kind}-agent-failed` class).

Honest structural note for §0 of the record: this run's requirements churn
is NOT all waste — round 1's review found a genuine settled-contract
fidelity defect (AC-07 clause-drop), round 2's review verified the fix
clause-by-clause AND caught a NEW defect the repair itself introduced
(guard-union-misidentified: AC-12's false "no guard pins src/reviewer.ts").
That is real reviewer value. The economic failure is that the bounce could
not do its job (defects D1/D2 below), so the coverage gap rode every round
as logged noise.

## 1. Root causes (defect table)

| # | Defect | Evidence |
|---|---|---|
| D1 | **The writer control SCHEMAS cannot carry `findingResolutions`.** The requirements/BDD/spec writer stages validate controls against TypeBox `STAGE_MODELS` (render/schemas.ts:187 `RequirementsData` et al.) and the delegation request carries `result:{kind:"structured",schema}` (delegation-backend.ts:436) — the structured contract constrains what the model can emit. I added the field to the PROMPT text (v0.4.60) but NOT to the schemas: an output field the schema does not declare is dropped/unemittable. The gate therefore demands a field the wire format forbids — the bounce asks for the impossible. | schemas.ts:187-204 (no findingResolutions); delegation-backend.ts:294-296,436; the 08:28 log (writer partial emission only where the render path happens to pass unknown keys through) |
| D2 | **The demand set is polluted with non-addressable residue.** `${kind}-agent-failed` findings are delegation-INFRASTRUCTURE markers (the ledger's own docstring: a later valid review control clears them). No artifact revision can "address" `codeReview-agent-failed` — demanding a resolution row for it permanently poisons the gate's arithmetic and the bounce's instruction list. | convergence-ledger.ts:702-717; the 07:54 bounce list includes all three agent-failed ids verbatim |
| D3 | (design gap, not a live defect yet) **The schema-version stamp** (066 grill-4 Q2: cached/validated controls carry a schema version) does not exist yet — adding fields to closed schemas changes downstream render/validator expectations silently. | 066 §2 WS1 |

## 2. Fix design

1. **Schemas (kills D1)**: `render/schemas.ts` gains a shared
   `FindingResolutionEntry` TypeBox object
   (`{ id: string, loci: string[], note: string }`, `additionalProperties:
   false`) and each doc-writer schema (RequirementsData, BddData, SpecData)
   gains `findingResolutions: Type.Optional(Type.Array(FindingResolutionEntry))`
   — nullable/union per 066 grill-4 Q2; absence stays legal (a run with no
   injected findings never demands rows).
2. **Demand-set hygiene (kills D2)**: the gate's injected set filters
   non-addressable classes — ids matching `${kind}-agent-failed` (the
   ledger's infra markers) are EXCLUDED from `round1InjectedIds` at capture
   time (they remain injected as FEEDBACK lines — the writer still sees the
   history — they just cannot be demanded as resolvable content). The filter
   lives at the capture site, not inside the gate, so the gate's contract
   stays "every injected id is addressable".
3. **Prompt note (completes D1)**: the three writer contracts' finding-
   resolutions line drops "REQUIRED when injected feedback names … lines"
   wording ambiguity in favor of the exact rule already stated (emit rows
   for injected CONTENT finding ids; infra markers like agent-failed are
   context, never demanded).
4. **Per-field re-measurement (066 grill-4 Q2)**: after the schema change,
   the canary battery (when it exists) re-measures the EXISTING fields'
   accuracy — recorded as the standing obligation, not solved here.

## 2.5 Grill round 1 (2026-09-21) — folded (2H+3M, research-backed)

| # | Sev | Finding | Resolution |
|---|---|---|---|
| Q1 | HIGH | Is the demand filter wrong — should downstream-owned findings (14 CF-spec ids demanded of the requirements writer) route out? | **NO — 067's original filter stands.** The convergent rule across DOORS suspect-links / DO-178C CCB / agile missed-requirement practice / 2024-26 AI triage is ADJUDICATED ORIGIN-BASED routing: the reviewer compares the downstream artifact against the upstream criterion — if the downstream CORRECTLY implements the current spec (the escape is spec-permitted), upstream revision is MANDATORY; if it violates an adequate criterion, the fix stays downstream. This run PROVED the adjudication works: the reviewer verified "the eight CF-implementation convergence findings are now answered by requirement (AC-09/10/11/12)". Strict owner-stage routing would have blocked exactly those answers; automatic upstream-preference would churn every implementation bug into requirements. Content findings stay in the demand set regardless of owner; only non-content markers filter (D2). |
| Q2 | HIGH | Type.Optional() is ILLEGAL on OpenAI strict mode (400); Anthropic recommends required-with-default as the cheapest grammar | The repo's Optional pattern (affectsSharedSurfaces, openQuestions) is PROVEN on THIS bridge (zai/glm via pi-subagents — not OpenAI strict mode), so Optional stands; documented migration rule: if the bridge ever moves to a strict-mode provider, the field becomes required-with-[]-default (empty is a meaningful expected state — the research's preferred shape for defaultable fields). |
| Q3 | MED | 27-row emission may tax sibling-field quality (schema complexity ↔ accuracy, ExtractBench/Anthropic state-space) | Keep 067's no-truncation position (measure first) — the two-sided rule warns required-non-nullable FABRICATES when data is absent; truncation is a measured follow-up, not a preemptive double-change. |
| Q4 | MED | Resume-replay safety argument absent | Argued + pinned: resume replays stage RESULTS, not controls; old results lack the field → Optional passes; the field exists only on NEW emissions. |
| Q5 | LOW | Schema-version stamp deferred twice | Named: folds into the WS5 wiring increment together with the resume contract-salt (066 round-4 Q3) — one schema-identity change, one commit. |

## 2.7 Grill round 2 (2026-09-21) — folded (code-analysis + dependency-check + research)

| # | Sev | Finding | Resolution |
|---|---|---|---|
| Q1 | HIGH | One malformed row rejects the WHOLE control (closed entry → schemaViolationErrors → full corrective re-emission for one bad row) — duplicate defense vs the gate's row-level semantics at higher cost | **Row-seam strict, array-seam lenient** (ExtractBench: whole-payload strict = catastrophic, 62%→0; row strict kills ~30% of failure classes cheaply): a pre-strip normalization runs parseFindingResolutions on the control BEFORE schema validation — malformed rows are stripped and degrade to "unmapped id" (the bounce's exact semantics); the clean array enters the schema check. Implemented this commit. |
| Q2 | HIGH | Is Optional wire-legal here? | Code-analysis closed: structured mode is ENGINE-side validated (pi-subagents in-child; unsupported → fail-open text mode) — NOT provider strict API; repo precedent production-proven. Migration rule stands for strict-mode providers. |
| Q3 | HIGH | Render/auto-render/controlKeys dependencies | Code-analysis closed: renderAndWrite validates against STAGE_MODELS (Optional passes old+new); njk ignores unknown fields; controlKeys is the REQUIRED list — findingResolutions is conditional and must NOT join it. Argument pinned. |
| Q4 | HIGH | Strict-vs-lenient row validation (research) | Confirms Q1's rule verbatim: "enforce strictness at the row seam, leniency at the array seam" (arxiv.org/abs/2602.12247); strictness is syntactic only — 15-25pt validate-vs-correct gap means the id-set diff stays the real gate (arxiv.org/abs/2604.25359). |
| Q5 | HIGH | 27-row enumeration drop-off (research) | "Judging Is Not Enumerating" (arxiv.org/abs/2608.01000): authored sets omit-first (19-42% of oracle members; omissions resist audit; over-inclusion detected 6-7× more than omission) — **mechanical id-set diffing is the only reliable gate** (exactly WS1); **repair beats rejection 3.3-10.6× in yield** — the bounce's re-dispatch feedback upgrades to "add rows ONLY for the missing ids; change nothing else" (patch-mode scoping); Attention Overflow (arxiv.org/abs/2407.13481): 27 uniform 3-field rows sit far below the ~128-item repetition onset — single-call emission is within capability; chunking deferred. |

## 2.9 Grill round 3 (2026-09-21) — the implemented state's internal consistency (code-analysis; no new research needed — all on already-researched ground)

| # | Sev | Finding | Resolution |
|---|---|---|---|
| R3-Q1 | HIGH | The v0.4.74 strip checked controlNorm but RETURNED the original control — renderAndWrite's STAGE_MODELS validation re-saw the malformed rows and could reject the whole control there (the pre-strip was bypassed) | All success/corrective return paths now carry controlNorm — the stripped array is what flows downstream (this commit) |
| R3-Q2 | HIGH | "~P% caught pre-review" was a proxy, not first-pass acceptance | REAL metric per the SWE-bench convention: first-pass acceptance = walks approved at review round 1 / reviewed walks, derived from the ✓-approved-round lines; the summary names both counts |
| R3-Q3 | HIGH | The spec walk lacked the WS1 gate (deferred twice) | Wired: round1InjectedIds capture (agent-failed filtered) + the bounded bounce leg at the trace-passed seam, scoped repair feedback (this commit) |
| R3-Q4 | MED | Empty-array path coherence unpinned | Pinned semantics: writer emits [] → controlKeys' empty-array-ok passes → the gate sees zero mapped ids → bounce owns it |
| R3-Q5 | MED | Schema-version stamp deferred a third time | CLOSED: CONTROL_SCHEMA_VERSION = "2" in schemas.ts — the single constant the resume contract-salt (066 r4 Q3) consumes |
| R3-Q6 | LOW | Grill numbering collided across rounds | Round-3 rows prefixed R3- |

## 2.11 Grill round 4 (2026-09-21) — two-flag drift + the spec stage's invisible approvals

| # | Sev | Finding | Resolution |
|---|---|---|---|
| R4-Q1 | HIGH | v0.4.64 and v0.4.75 had ACCIDENTALLY declared TWO walk-scoped bounce flags in the spec node (specWriterBounceSpent + specWriterResolutionBounceSpent) — the spec walk could bounce twice, violating the documented shared-budget bound-1 (066 §2 P8) | Unified into ONE specWriterBounceSpent across both legs (this commit) |
| R4-Q2 | HIGH | The economy metrics' approval regex matched "✓ review approved round N" — but the SPEC stage logs "✓ trace + review approved round N": the run's most expensive stage was INVISIBLE to reviewedWalks/firstPassApprovals | Regex covers the trace + review wording (pinned both shapes) |
| R4-Q3 | MED | The WS3 anchor leg skipped SILENTLY when the bounce budget was spent — unresolved loci unreported (a P10 gap, not a design change) | The spent-budget branch logs the gap honestly before proceeding |
| R4-Q4 | MED | Round 3 promised an empty-array pin that was never actually added | Added: [] maps nothing → bounce owns it; both approval wordings count |

## 2.13 Grill round 5 (2026-09-21) — the convergence sweep: GRILL CLOSED

| # | Sev | Finding | Resolution |
|---|---|---|---|
| R5-Q1 | — | Flag-duplication sweep | CLEAN: exactly one walk-scoped budget per node (round-4 fix holds; now tripwire-pinned) |
| R5-Q2 | MED | The WS3 anchor leg was absent from the spec walk (spec writers' loci unchecked) | Wired: the same resolveAnchors predicate (spec-dir/worktree/cwd relative) on the shared budget, honest spent-budget log (this commit) |
| R5-Q3 | MED | CONTROL_SCHEMA_VERSION had ZERO consumers and ZERO pins — a constant nobody reads drifts silently | Value-pinned (a bump now fails the pin — a deliberate act); the resume-salt consumer lands with WS5 wiring as documented |
| R5-Q4 | MED | The round-4 unified-budget fix had no pin | Source-scan tripwire: exactly one budget declaration per node, the drifted name at zero (the round-4 drift class can never silently recur) |
| R5-Q5 | LOW | Prompt-bloat note: lessons + patch directive + round1 lines + bounce feedback all ride the round-1 prompt un-budgeted | Advisory, recorded; the WS7 prompt-size budget owns it when wired |

**Verdict: GRILL CONVERGED.** Rounds 4-5 found only implementation drift and
missing pins — no design defects since round 2. 067 is grill-closed with
five folded rounds (2H+3M, 5, 6, 4, 5 findings); further adversarial effort
belongs on the NEXT live run's receipts (the economy line on v0.4.77+ is
the full-chain measurement), not on this document.

## 2.15 Grill round 6 (2026-09-21) — cross-spec consistency (066↔067) + pre-registered predictions

| # | Sev | Finding | Resolution |
|---|---|---|---|
| R6-Q1 | HIGH | 066 WS1 promises a THREE-layer anti-gaming gate; layer (b) — the SEALED AUDIT SUBSET (the reviewer deep-verifies a committed-after-submission random subset of coverage rows, protected set never dropped) — exists ONLY in docblocks. Zero implementation: the gate is really two-layer + the reviewer's natural behavior. FBI/CHERRL say the writer's self-map is weak evidence; without layer (b) a sophisticated gaming attempt (loci exist, remedy quoted, still wrong) has no dedicated defense. | **Named as THE remaining gap** — its own increment (reviewer-prompt rubric change + commit-reveal subset selection + protected-set derivation), NOT rushed wiring here. Tracked as the wave-1 residual alongside WS5/WS7 wiring. |
| R6-Q2 | HIGH | Round 5 closed the grill but the spec is not FALSIFIABLE — no pre-registered predictions for the next live run | §4 added below: falsifiable economy-line predictions for v0.4.77+ runs |
| R6-Q3 | MED | lessonsForWriter filtered only superseded — VERIFIED/ADDRESSED findings still taught stale lessons (context rot; a resolved defect teaching "avoid X" misleads later writers) | Resolved statuses excluded (pinned) |
| R6-Q4 | MED | WS6 patch-mode honored only advisorially; no presence pin | Accepted (066 grill-2 M10 design); directive presence pinned in v0.4.69's tests |
| R6-Q5 | LOW | The flywheel's σ-bands don't yet track firstPassAcceptance | Deferred to the WS0 flywheel touchpoint (with the metrics' other σ-band rows) |

## 2.16 Pre-registered predictions (falsifiable — the round-5 verdict's receipts surface)

For the next live run on v0.4.77+ over the SAME spec (26-capability-backend-substrate):

- P1: requirements + BDD combined consume ≤ 8 writer attempts (the 07-37 run: 10) and ≤ 2 bounces each.
- P2: FIRST-PASS ACCEPTANCE (the economy line, now spec-visible) ≥ 1/4 doc walks approved at round 1 (the 07-37 run: 0/3).
- P3: the spec stage's cost share < 55% (07-37: 55% — the schema fix lets the writer carry the map on the FIRST dispatch).
- P4: no `unaddressed (bounce spent)` line persists past round 2 (07-37: every round).

A miss on P2-P4 with the machinery firing is a NEW receipt class → reopen the
grill with it; a miss on P1 alone may be task-difficulty (adjudicated per the
round-1 Q1 rule).

## 2.17 Grill round 7 (2026-09-21) — the sealed-audit design grill + implementation

| # | Finding | Design answer (implemented v0.4.79) |
|---|---|---|
| Q1 | The unbiasable randomness source | mkSealToken(): crypto-random, generated AFTER submission (validation-passed seam); the LOG LINE is the commitment (append-only ordering — the writer never sees the log mid-flight; anyone recomputes sha256(seal,id) post-hoc) |
| Q2 | Where the seal lives / auditability | sealedAuditLogLine names seal + count + ids + the reconstruction recipe |
| Q3 | Verdict shape (anti-rubber-stamp) | Per-row priorFindingResolutions entries with a REQUIRED verbatim evidence quote — a bare pass is not an audit (the schema field already existed) |
| Q4 | Protected set | unresolved blocking high/P0/P1/critical ledger findings (resolved rows LEAVE — cannot balloon) + unconditional inclusion past the sampled target |
| Q5 | Subset size | fraction 0.4 default, census below minRows 3 |
| Q6 | The auditor | the stage's existing reviewer; the block rides the shared buildUpstreamReviewPrompt/buildSpecReviewPrompt tails (stable header first — KV); stages without coverage maps untouched |

Research-pending confirmations (commit-reveal mechanics, verdict elicitation, protected-set precedents) fold on the agent's return; the design answers stand on the round-1/2 research base either way.

## 3. Test obligations

- Schema lane: render a requirements control WITH findingResolutions → the
  validator accepts and the gate reads the rows (extends the v0.4.61
  integration test's control shape).
- Hygiene lane: an injected set containing `codeReview-agent-failed` never
  appears in the gate's demand (unit pin at the capture helper).
- The 066 grill round-1 H3 layering is unchanged: the writer's map remains
  WEAK evidence; the sealed-audit subset is the strong layer.

## 4. Non-goals

- No change to the bounce budget (P8 bound 1 stands — with D1 fixed the
  FIRST dispatch can carry rows; the bounce exists for the forgetful case).
- No wave-2 activation (the gate measurement still needs a clean live run).
