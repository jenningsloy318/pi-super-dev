# Convergence Economy — first-pass acceptance and verification cost

Status: proposed (research + design; no code yet). Lineage: sibling of 065
(first-pass satisfiability). 065 makes the spec's write-claims deterministically
checkable BEFORE any implementer attempt; this doc makes the write→review
convergence loop itself cheap and first-pass accurate — the two compose: 065
guards satisfiability, 066 guards economy. Evidence base: live run
`2026-09-20T07-37-57-688Z` (the first run of the v0.4.57/v0.4.58 harness) plus
two deep-research passes (2026-09-20) whose citations appear inline.

---

## 0. The measured problem (receipts, live run 2026-09-20T07-37-57-688Z)

The harness worked: requirements converged (2 rounds), BDD review found two
genuine requirements-owned defects (BDD26-F01 — the prosperity scope-guard
collision that killed 4 prior implementation attempts; AC-20/SCENARIO-081's
nonexistent fallback mechanism), and the auto-route `bdd→requirements` was
correct per D1. The problem is what each cycle COST:

| Call | turns/tools | duration | shape |
|---|---|---|---|
| requirements-clarifier r1 | 25/42 | 910s | interactive ~36s/turn |
| requirements-reviewer r1 | 16/32 | 1048s | interactive ~65s/turn |
| bdd-scenario-writer r1 | 4/10 | 624s | GENERATION ~156s/turn (thinking=max, 43k out) |
| bdd-reviewer r1 | 21/34 | 995s | interactive ~47s/turn |

- 121 min elapsed, **112 min inside model calls (92%)** — the harness itself is
  8%; this is not stalls, it is call-count × latency × turns.
- Of the 112 min: **~50 min re-verification** of claims unchanged since the prior
  round (every review round re-derives everything; no verdict memory); **~50 min
  rework** from four first-pass quality gaps; **~12 min net-new accepted content**.
- The four gaps (E1–E4):
  - **E1** — 36 prior blocking findings injected at write time; nothing verifies
    per-finding coverage, so an unaddressed one (CF-implementation-1nl0mhr)
    resurfaced at BDD review, ~80 min and 3 agent calls later.
  - **E2** — deterministic validators (unknown-pinId citations, Gate-W
    write-claim contradictions, ~40 findings at 16:38:44) run ADVISORY after the
    writer; the same defect class then cost a full 16.6-min reviewer pass.
  - **E3** — route-back carried two precisely-worded amendments but re-ran the
    whole requirements writer + full review (~25 min for a two-paragraph patch,
    177 resume rows dropped).
  - **E4** — requirements review r2 verified enumerations but APPROVED AC-20's
    factually wrong mechanism premise; the BDD reviewer caught it by grounding
    the premise in code (runtime-dispatch.ts:84,89-117). Reviewer asymmetry.

## 1. Research grounding

### 1.1 First-pass acceptance (writer side)

- **External critique beats intrinsic** — the load-bearing caveat for every
  self-check design: intrinsic self-correction (re-reading one's draft)
  frequently DEGRADES performance (Huang et al., ICLR 2024,
  arxiv.org/abs/2310.01798); critique with external tools is where gains appear
  (CRITIC, arxiv.org/abs/2305.11738; Self-Debugging, arxiv.org/abs/2304.05128).
  Self-Refine's ~20% avg improvement (arxiv.org/abs/2303.17651) is real but the
  strong variant is tool-interactive, draft-independent.
- **CoVe's independent answering** (arxiv.org/abs/2309.11495): premises must be
  verified by fresh lookups against the source, NOT by re-reading the draft —
  exactly the discipline AC-20's false premise lacked.
- **Checklists work at phase boundaries when short and verifiable**: the WHO
  surgical checklist RCT cut deaths 1.5%→0.8% and complications 11%→7%
  (nejm.org/doi/full/10.1056/NEJMsa0810119); Degani & Wiener (Human Factors 1993,
  ntrs.nasa.gov/citations/19930068509) — checklist efficacy degrades with length
  and prose-blob form. A per-finding-id coverage table is the verifiable form.
- **Mechanical gates at the write boundary prevent error propagation**:
  SWE-agent's lint-gated edits (invalid edit discarded, error fed back) ablate
  to −3pp resolve rate when removed (arxiv.org/html/2405.15793v1); Claude Code
  hooks are the same pattern productized — exit 2 blocks, stderr teaches
  (code.claude.com/docs/en/hooks-guide); Aider auto-lints every edit and feeds
  lint/test output into the next turn (aider.chat/docs/usage/lint-test.html).
- **Reflexion** (arxiv.org/abs/2303.11366): rejections persisted as structured
  lessons lift re-attempt success (91% vs 80% pass@1 on HumanEval).
- **Benchmark reality**: production-scale OpenHands corpus ≈ 2.1 attempts per
  accepted solution (nebius.com/blog/posts/openhands-trajectories-with-qwen3-coder-480b);
  no published pipeline measures first-pass acceptance of spec artifacts — we
  must instrument our own.

### 1.2 Verification economy (reviewer side)

- **Content-addressed verdict caching is the transferable contract**: Bazel
  action keys hash EVERY input that can affect the output INCLUDING the
  toolchain (bazel.build/remote/caching); rustc's red-green algorithm makes
  verified-ness transitive over a dependency graph (incremental compilation);
  test impact analysis reruns only tests intersecting the change
  (pytest-testmon, Jest --onlyChanged; Meta's predictive test selection,
  engineering.fb.com 2018). Applied: a claim verdict is cacheable under
  `hash(claim_text, cited_file_content_hashes, reviewer_prompt_version,
  model_version)` — the last two fields are what homegrown caches forget.
  **No published system caches claim-level LLM verification verdicts** (closest
  analogs: diff-scoped review products, CodeRabbit's graph+diff review) — this
  is a novel synthesis; hit-rate assumptions must be validated empirically.
- **Diff-scoped review is the norm**: GitHub/Copilot review caps and scopes to
  the diff (github.com/orgs/community/discussions/199986); SWE-bench grades
  against curated FAIL_TO_PASS + PASS_TO_PASS subsets, never the full suite
  (swebench.com/original.html) — the PASS_TO_PASS analog is a small regression
  battery of previously-green claims re-sampled each round.
- **Surgical edits are what make delta verification possible at all**: if the
  writer regenerates the artifact, every claim's hash changes and the cache
  never hits. Amp's old_string/new_string patch tool
  (ampcode.com/notes/how-to-build-an-agent) and RepairAgent's strategy-iterative
  repair (software-lab.org/publications/icse2025_RepairAgent.pdf) are the shapes.
- **Parallel fan-out**: Anthropic's multi-agent research system (3–5 workers,
  concurrent tools) cut research time up to 90%; token usage alone explained 80%
  of performance variance; multi-agent cost ~15× tokens
  (anthropic.com/engineering/multi-agent-research-system). Shard by claim-group
  with a synthesis pass; cross-cutting invariants stay with the orchestrator.
- **Pre-computed evidence bundles**: deterministic pre-flight resolving each
  cited file/line/symbol into a fact-sheet turns 30 tool calls into 1 read —
  deterministic, cacheable, hashable (CodeRabbit context engineering,
  coderabbit.ai/blog/context-engineering-ai-code-reviews). KV-cache-stable
  prefixes + append-only evidence are a 10× cost lever (Manus,
  manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus).
- **Cascades**: route mechanical grounding checks down-tier (FrugalGPT up to
  98% cost cut on 2023 benchmarks; RouteLLM ~95% quality at ~15% frontier
  traffic) — "a cascade pays twice when it escalates", so measure escalation.
- **Loop bounds**: convergence is not correctness — the verifier's strictness,
  not round count, is the quality control (subhadipmitra.com/blog/2026/
  loop-engineering-verifier/); semantic early stopping reports ~38% token cuts
  (arxiv.org/html/2606.27009v1, single paper — weak evidence).

## 2. Architecture — seven workstreams (seams named)

**SCOPE — every agent role, not just the doc stages.** The receipts in §0 come
from stage 2, but the mechanisms apply pipeline-wide. Nothing in this spec is
stage-2-only; each workstream names its per-role seams below. The applicability
matrix (role × workstream):

| Agent role (stage family) | WS1 coverage gate | WS2 validator bounce | WS3 anchors | WS4 rejection memory | WS5 verdict cache | WS6 patch-mode | WS7 fan-out/facts/calib |
|---|---|---|---|---|---|---|---|
| doc writers: requirements-clarifier, bdd-scenario-writer, spec-writer, docs-executor (2B/2C/3/6B) | ✔ control `findingResolutions` | ✔ Gate-W/pinId classes | ✔ | ✔ ledger lessons | ✔ claim ledger | ✔ route-back patch-mode | ✔ fact-sheet |
| doc reviewers: requirements/bdd/spec/docs-reviewer | — (reviewer emits claim rows instead) | ✔ their OWN findings get deterministically triaged before blocking | judges anchors | ✔ | ✔ green manifest + delta | — | ✔ fan-out K=3 |
| implementation: tdd-guide, implementer (RED/GREEN loop) | ✔ control maps injected replan/inherited-red/prior-phase findings → phases/scenarios addressing them | ✔ already strongest in repo (build-runner oracle runs pre-review); EXTEND to deliverable-declaration bounce (tracking.ts claim-vs-actual mismatch bounces before reviewer burn) | ✔ premise anchors in test plans | ✔ redJudgeDiagnosis + no-progress signatures already persist; generalize as lessons into the NEXT phase's prompts | ✔ GREEN re-verify: unchanged-phase ratchet already exists (red-snapshot); ADD verify-side file-level green cache (below) | ✔ phase-local edits (phase-rollback already scopes) | ✔ runner-discovery cached; thinking floor for writers |
| verify: code-reviewer, adversarial-reviewer, tests-reviewer | — reviewers, not writers | ✔ findings deterministically triaged (review-findings.ts) before fix-loop burn | judges anchors | ✔ fix-loop carries finding ids; unaddressed-id bounce | ✔ **re-review after fixes sees ONLY changed files + green manifest of unchanged files** (today each fix round re-reviews everything) | ✔ fix-loop edits scoped to finding loci | ✔ biggest fan-out win: 3 reviewers already run — shard their scopes, merge |
| judge | — | — | — | ✔ routing rationale persisted (already) | ✔ signature-level: identical stall signature reuses prior route within budget | — | ✔ (cheap tier already) |
| auxiliary dispatches: research-assist, debug-analyzer, runner-discovery | — | — | ✔ commands carry verified anchors | — | ✔ runner-discovery already cached | — | — |

The two NEW pipeline-wide items this matrix adds beyond the doc-stage wiring:
**implementer finding-coverage control** (WS1 column: the implementation prompts
inject replan findings + inherited-red rows + prior-phase blockers — same
unaddressed-id escape E1 exists there; the v0.4.56 already-satisfied-wall and
no-progress valve detect the SYMPTOM after ~3 burned attempts) and the
**verify-loop file-level green cache** (WS5 column: after a fix round, unchanged
files re-review from scratch today — the same 35–50% re-verification waste,
at the most expensive reviews in the pipeline).

**WS1 — Findings coverage gate (kills E1).** The writer's control block gains
`findingResolutions: [{id, loci, note}]` covering EVERY injected blocking
finding id. Deterministic post-write check: `injectedIds − mappedIds ≠ ∅` → ONE
bounce carrying the missing ids back to the writer (bounded, P8: max 1 bounce;
P5: validator crash → advisory, review proceeds). Seam: `prompts.ts`
(controlKeys + prompt text), `stages/artifact-convergence/node.ts`,
`render/schemas.ts`. Checklist-design rule (Degani & Wiener): the table is
per-id rows, never prose.

**WS2 — Pre-review validator bounce (kills E2).** Promote designated
deterministic validator classes — unknown-pinId citations, own-artifact
write-claim contradictions (the Gate-W family) — from post-hoc advisory to a
pre-review gate: violations bounce the writer once with the violation list;
second pass proceeds to review WITH violations attached (honest, P10). The
validators already exist (`review/contract-validators.ts`); this is wiring.
Defect-class split (research §1.1): mechanical classes bounce; premise/soundness
classes stay with the LLM reviewer.

**WS3 — Read-before-write anchors (kills E4's writer half).** Every code-behavior
premise in an artifact must carry a file:line anchor produced by a read in the
same session; the WS2 gate resolves anchors mechanically (path exists, line in
range); the reviewer judges interpretation only. CoVe discipline: premises
verified by fresh lookups, never draft re-reading.

**WS4 — Rejection memory (Reflexion).** Each reviewer rejection persists as
structured lessons (defect class + locus + rule) injected into the writer's
re-submission AND recorded in the convergence ledger for future rounds/stages.
The convergence ledger already carries findings; this adds the
writer-conditioning leg.

**WS5 — Claim-level verdict cache (kills the ~50 min re-verification).** The
reviewer emits per-claim verdict rows (id, artifact loci, cited files, verdict,
evidence summary) — it already does per-finding CF adjudication; generalize to
artifact claims. The convergence node stores a review ledger keyed
content-addressed: `hash(claim_text, cited_file_hashes, reviewer_prompt_version,
model_version)`. Next round: the reviewer prompt receives the green manifest
(claims whose keys hit) + the delta claims to verify fresh + a PASS_TO_PASS
regression sample (~10% of green claims re-verified adversarially — the
verifier-strictness guard). Invalidation is total (Bazel contract): prompt/model
version bumps flush the ledger. Canary test: a defect planted in a CHANGED locus
must always be caught; a green-claim manifest that skips a changed locus fails.

**WS6 — Surgical patch-mode on route-back (kills E3, enables WS5).** When
route-back findings are precise, the writer prompt switches to patch-mode: the
exact recommendations + "changes limited to implicated regions; previously
approved content preserved" + a diff-scope expectation in the control block.
Unchanged claims keep their hashes → WS5 hits. (The 17:20 BDD writer already
preserved scenarios from the prior artifact by instruction; this makes it the
mechanism, with the diff-scope checked, not hoped for.)

**WS7 — Parallel review fan-out + pre-flight fact-sheet + calibration.** (a)
Shard review into K≈3 claim-groups, concurrent reviewer children
(`maxConcurrency` is already 3), orchestrator merges verdicts and owns
cross-cutting invariants; P3 failure-path table required (shard × reject ×
abandon × merge). (b) Deterministic pre-flight assembles the grounding
fact-sheet (existence checks, registry counts, line anchors for pinned ids) —
reviewer turns drop from verification legwork to judgment; fact-sheet format is
byte-stable across rounds (KV-cache). (c) Calibration: writers thinking=high
(not max) with an evidence-of-read floor; mechanical grounding tier routable to
a cheaper model via `config.agentModels`.

**Metrics (first-class, WS0).** Log per stage: first-pass acceptance rate,
attempts-per-acceptance (target: beat the ~2.1 production baseline), review
minutes per accepted artifact, verdict-cache hit rate, bounce-gate save count.
Surface in the usage report (the σ-band flywheel already reads run logs).

## 3. Rollout order and acceptance criteria

| Wave | Contents | Accepts |
|---|---|---|
| 1 (v0.4.59) | WS1 + WS2 for ALL writer roles (doc writers + implementer/tdd-guide coverage controls; deliverable-declaration bounce) + metrics | injected-finding coverage gaps bounce pre-review in every stage family; unknown-pinId/write-contradiction classes bounce pre-review; each bounce bounded at 1 |
| 2 (v0.4.60) | WS5 + WS6 both loops (doc claim ledger; verify-loop file-level green cache; route-back/fix-loop patch-mode) | round ≥2 reviews AND re-reviews verify delta + 10% green-sample only; unchanged content never re-derived; writers emit scoped diffs |
| 3 (v0.4.61) | WS3 + WS4 all writers/reviewers | premise anchors resolve mechanically everywhere; rejections persist as cross-stage lessons |
| 4 | WS7 | review wall-clock ≤ ⅓ of serial baseline at equal defect-detection on the canary battery, BOTH the doc reviews and the verify fan-out |

Global criteria, measured on the next omisis spec runs, PER ROLE (not per
stage): attempts-per-acceptance ≤ 1.5 for every agent role (from today's ~2-3;
production baseline ~2.1); first-pass acceptance ≥ 50% for every writer role;
review minutes per accepted artifact ≤ ½ baseline; whole-run wall-clock ≤ 1
wall-fuse window for a 6-phase spec; zero loss of verification strictness ON
CHANGED CONTENT (canary battery green); suite green throughout (dual gates per
the landing discipline).

## 4. Test strategy (per the constitution)

- **P2**: enumerate the writer-control grammar table (findingResolutions shapes,
  anchor forms) before parsing it; a test per row.
- **P8**: every bounce loop bounded (1) with a provoking test.
- **P5**: validator crash → advisory fail-open, review proceeds; test per branch.
- **P1**: green manifests are OUR record, not the work's claim — the canary
  battery (planted defects in changed loci; changed-locus-skipped-manifest
  failure) is the fail-closed direction; cache poisoning (Bazel hazard) is
  excluded by keying on content hashes + prompt/model versions, tested by
  mutation.
- **P3**: WS7 ships with the shard × {reject, abandon, late} × merge-state table
  and per-cell tests.
- **P6**: the cache key recipe lives in ONE module; reviewer prompt version is
  stamped from the same constant the prompts derive from.

## 5. Risks and honest limits

- The claim-level verdict cache is a novel synthesis (no published precedent
  found); hit-rate assumptions are unvalidated — instrument first (WS0), and
  let wave 2 land only if measured re-verification share stays >30%.
- Fan-out costs ~15× tokens per review (Anthropic's number) — it must ride on
  WS5/WS7b shrinking the review first, or it multiplies cost.
- Intrinsic self-critique can hurt (Huang et al.) — every writer-side self-check
  in this design is tool-interactive or deterministic, never introspection-only.
- Cascade escalation pays twice — measure before routing verification down-tier.
- Degradations must leave the happy path byte-identical (defensive rule 7).
