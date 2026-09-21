# The finding-resolution gate's first live run — two defects and the demand-set hygiene spec

Status: approved 2026-09-21 (autonomous directive) — implementing this commit.
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
