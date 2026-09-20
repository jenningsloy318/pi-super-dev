# Convergence Economy — first-pass acceptance and verification cost

Status: proposed — grill rounds 1+2 folded (6H+5M, then 5H+4M+1L; answers in §5, research-backed).
Lineage: sibling of 065
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
per-id rows, never prose. **Anti-gaming (grill H3, FBI/CHERRL-backed):** the
writer's self-filled table is WEAK evidence — evaluator LLMs "did not adjust
their scores for perturbed responses despite correctly identifying the
perturbations in their explanations" (FBI, EMNLP 2024,
aclanthology.org/2024.emnlp-main.911.pdf) and a compliance declaration in the
output reliably fools a judge (CHERRL, arxiv.org/abs/2606.04923). The gate is
therefore three-layered: (a) the harness resolves every cited locus
mechanically (path/anchor exists; de-anchored — it derives its own expectation
before reading the map); (b) the REVIEWER deep-verifies a random subset of
coverage rows per round (Rubric Dropout, arxiv.org/abs/2608.11669) with a
PROTECTED never-dropped set (blocking-finding classes — the ones that
historically killed runs); (c) the note field must quote the remedy language
of the finding it claims to address. **Audit selection is SEALED (grill-2
Q1):** the deep-verification subset is committed AFTER artifact submission,
derived from a source the writer cannot bias (commit-reveal,
arxiv.org/abs/2504.03936; hash(unbiasable-run-randomness ∩ artifact-rev)) —
a deterministic rotating roster is the weakest option, exactly the structure
the adaptive reward-hacking literature says gets learned (METR 2025-06:
training against an observable policy yields "cheating in more clever ways";
metr.org/blog/2025-06-05-recent-reward-hacking/). **WS1 × WS6 composition
(grill-2 Q4):** the coverage map is itself cache-keyed — findings whose
addressing loci are unchanged since a verified map inherit green (a WS5 hit);
the writer maps only the DELTA; the gate checks
`injected − (mapped ∪ inheritedGreen) ≠ ∅`. **Protected-set derivation
(grill-2 Q7):** never-dropped classes are DERIVED — all convergence-ledger
findings with historical blocking=true, severity≥high, plus the fixed
anchor-grammar core — configurable with a floor the config cannot lower.

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
verified by fresh lookups, never draft re-reading. **Two-layer support
verification (grill-2 Q5):** mechanical resolution gives ~100% recall on
"anchor nonexistent" and ~zero discrimination on "anchor SUPPORTS the claim"
(the partial-support failure mode — CAQA, ACL 2025: 25 attribution evaluators
systematically fail exactly there, arxiv.org/abs/2401.14640); so premise-class
claims additionally pass an NLI/LLM support-derivation layer (~78–90%
human-agreement per ALCE, arxiv.org/abs/2305.14627 — the Anthropic
CitationAgent separation pattern), and the verdict's tier records WHICH layer
verified it (feeds WS5's strength tiers).

**WS4 — Rejection memory (Reflexion).** Each reviewer rejection persists as
structured lessons (defect class + locus + rule) injected into the writer's
re-submission AND recorded in the convergence ledger for future rounds/stages.
The convergence ledger already carries findings; this adds the
writer-conditioning leg.

**WS5 — Claim-level verdict cache (kills the ~50 min re-verification).** The
reviewer emits per-claim verdict rows; the convergence node stores a review
ledger keyed content-addressed. **Claim enumeration is DETERMINISTIC (grill
H1):** the harness enumerates the claim set from the anchor grammar it already
parses (AC-*/SCENARIO-* ids, pinId citations, file:line anchors); the reviewer
supplies verdicts for THAT set only; a claim with no verdict row is NOT green
(fail-closed — a lazy reviewer's vacuous rows cannot mint green). **Cache key
(grill H5):** `hash(claim_text, cited_file_hashes, resolved model id + thinking
level, rubric-section version)` — the full resolution tuple, not the configured
one; the rubric stays byte-stable at the prompt PREFIX and evidence appends at
the tail, so verdict-cache flushes and KV-prefix stability stop fighting.
**Consistency class is NEVER sampled (grill H2):** cross-claim contradictions
(today's AC-20 × SCENARIO-081/082 class) get an always-run scope — the
deterministic cross-reference checks that already exist, plus an adjacency
rule: an unchanged claim re-verifies when it shares a cited entity with any
changed claim. **Re-verification policy (grill H6/H7 — replaces the earlier
10% assertion, which has NO industry precedent; disclosed absent from
Bazel/Turborepo/Develocity/GitHub docs):** sound-by-construction keys +
entry signing (the Turborepo HMAC pattern,
turborepo.dev/docs/reference/configuration); deterministic re-verification on
dependency change (the merge-queue contract: GitHub required checks re-run on
the merged state, docs.github.com merge-queue — soundness preferred over
economy even at 2× cost); and a Develocity-style **same-fingerprint
re-execution** probe (develocity.ai/product/flaky-tests-detection): identical
keys are periodically re-verified and the DISAGREEMENT rate is the cache's
distrust signal — plus a small protected always-checked invariant set.
**Adjacency depth (grill H6):** the reverse-dependency closure over the
claim/citation graph is the envelope (Meta PTS: transitive closure ≈ 25% of
tests is the safety envelope, engineering.fb.com 2018; 52–58% of real bug
fixes are multi-entity with 66–76% syntactically related co-changes, ICSME
2018) — NOT k-hop or same-module; statistical pruning inside the closure is
the optional economy (PTS runs a third of it at >99.9% catch), off by default.
**Fingerprint-probe budget is a zero-acceptance sampling plan (grill-2 Q2):**
the probe audits n cached-green verdicts per round with the Squeglia c=0 rule
— `n ≥ ln(β)/ln(1−p)` independent of lot size (confidence scales with
absolute n, not fraction); defaults β=0.10, p=5% ⇒ n≈45 (β=0.05, p=2% ⇒
n≈148); ONE defective cached verdict rejects the LOT: the whole round's cache
is re-verified (the c=0 property; acceptance-sampling lineage ANSI/ASQ Z1.4,
Dodge-Romig, Cleanroom — asq.org/quality-resources/z14-z19). Caveat: the
direct application to LLM-CI auditing is thin (one 2026 practitioner essay +
the Cleanroom lineage; disclosed) — the parameters are measured, not settled.
**Verification-strength tiers (grill-2 Q3):** verdict rows carry their tier —
`full` / `adjacent-closure` / `sampled` / `mechanical-only` — and the probe
budget spends disproportionately on the weaker tiers (the Develocity
FLAKY-classification and Bazel `--cache_test_results=auto` precedents: cached
states carry different trust). **Cached-fail never replays (Bazel auto):**
only PASSES are cache-replayable; a failure always re-executes.
**Ledger write rules (grill-2 Q6):** keys carry the content hash of verified
inputs (claim text + anchor + artifact digest) AND the pipeline position (the
AI21 collision pattern, ai21.com/blog/caching-in-agentic-llm-pipelines/);
writes are idempotent-if-deterministic, FIRST-WRITE-WINS; same-key divergence
is a producer-nondeterminism signal routed to audit, never overwritten
(Bazel/Gradle remote-cache precedent); shard replicas emit CANDIDATE rows and
only the round's orchestrator COMMITS (single trusted writer per key); the
append-only runlog invariants (INV-L1..L6) extend to the ledger.

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
abandon × merge). **Merge rule (grill Q8 — majority voting is the
worst-supported option):** for accept/reject verdicts, **minority veto** — ANY
dissenting shard escalates the contested claims to one tie-break pass
(measured: 14-validator minority-veto reaches 2.8% max error vs 14.8% for
majority at TPR 95.5%, arxiv.org/abs/2510.11822; inter-judge agreement is
chance-level for defect judging — κ 0.07–0.16 in co-creation settings,
arxiv.org/abs/2604.27727 — so dissent is signal, not noise). Cross-cutting
invariants are checked by an independent, de-anchored pass (derive the
expected answer before reading the artifact — collapses false positives
0.719→0.012, arxiv.org/abs/2607.05904; the Anthropic CitationAgent pattern,
anthropic.com/engineering/multi-agent-research-system). A cached "pass" that
survived only because shards were anchored identically is INVALID — replica
disagreement drops the cache entry and escalates. (b) Deterministic pre-flight
assembles the grounding fact-sheet (existence checks, registry counts, line
anchors for pinned ids) — reviewer turns drop from verification legwork to
judgment; fact-sheet format is byte-stable across rounds (KV-cache). (c)
Calibration: writers thinking=high (not max) with an evidence-of-read floor;
mechanical grounding tier routable to a cheaper model via `config.agentModels`.

**Metrics (first-class, WS0).** Log per stage: first-pass acceptance rate,
attempts-per-acceptance (target: beat the ~2.1 production baseline), review
minutes per accepted artifact, verdict-cache hit rate, bounce-gate save count.
Surface in the usage report (the σ-band flywheel already reads run logs).

## 3. Rollout order and acceptance criteria

| Wave | Contents | Accepts |
|---|---|---|
| 1 (v0.4.59) | WS1 + WS2 for ALL writer roles (doc writers + implementer/tdd-guide coverage controls; deliverable-declaration bounce) + metrics | injected-finding coverage gaps bounce pre-review in every stage family; unknown-pinId/write-contradiction classes bounce pre-review; each bounce bounded at 1 |
| 2 (v0.4.60) | WS5 + WS6 both loops (doc claim ledger; verify-loop file-level green cache; route-back/fix-loop patch-mode) | round ≥2 reviews verify delta + adjacency-closure + fingerprint-probe only; unchanged non-adjacent content never re-derived; writers emit scoped diffs |
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
  failure; **replica-disagreement-must-invalidate** canary added by grill H2)
  is the fail-closed direction; cache poisoning (Bazel hazard) is excluded by
  keying on content hashes + the resolution tuple + entry signing, tested by
  mutation.
- **P3**: WS7 ships with the shard × {reject, abandon, late} × merge-state table
  and per-cell tests; the minority-veto merge rule gets a dissent-provoking
  test.
- **P6**: the cache key recipe lives in ONE module; the rubric-version stamp
  derives from the same constant the reviewer prompt builder uses.
- **Grill-added**: rubric-dropout rotation is SEEDED and logged (a run's
  audited subset must be reconstructable); the protected never-dropped set is
  pinned by test (a blocking-finding class can never rotate out).

## 5. Grill round 1 (2026-09-20) — findings and resolutions

Adversarial pass over this spec (grill-with-docs protocol); four factual
questions answered by a dedicated research pass (citations inline above).

| # | Sev | Finding | Resolution |
|---|---|---|---|
| H1 | HIGH | "Claim" undefined; free-form reviewer rows could mint vacuous green | Claim set is deterministically enumerated from the anchor grammar; no verdict row ⇒ not green (WS5) |
| H2 | HIGH | Cross-claim contradictions escape per-claim caching | Consistency class never sampled: deterministic cross-refs + shared-cited-entity adjacency always re-verified (WS5) |
| H3 | HIGH | Coverage gate gameable ("tick-and-flick"; FBI/CHERRL show self-certification fools judges) | Three-layer gate: mechanical locus resolution (de-anchored) + reviewer deep-verifies rotating 30–50% subset with protected blocking set + remedy-quote note field (WS1) |
| H4 | HIGH | One-bounce economics asserted, not derived | Bounce consumes agent-call budget, NOT convergence rounds (≤2 writer calls/round); validator precision is a wave-1 metric with demote-to-advisory tripwire (~70%) |
| H5 | HIGH | Cache key omitted the resolution tuple (model+thinking per-call); KV-prefix vs. version-flush tension | Full resolution tuple in the key; rubric-stable prefix + append-only evidence (WS5) |
| H6 | HIGH | Verify-loop green cache unsound for cross-file defects | Reverse-dependency closure is the envelope (Meta PTS; ICSME 2018 co-change data); k-hop rejected; pruning off by default (WS5) |
| M7 | MED | 10% sampling asserted | NO industry standard exists (disclosed); replaced by signed keys + dependency-change re-verify + same-fingerprint disagreement probe + protected invariants (WS5) |
| M8 | MED | Shard-merge policy unnamed | Minority veto (any dissent escalates) — strongest measured support; majority explicitly rejected (WS7) |
| M9 | MED | Rejection memory could go stale | Lessons tagged with artifact rev; dropped on route-back rewrite (WS4) |
| M10 | MED | WS6 diff-confinement not mechanically checkable | Soft-check (diff-size expectation) + reviewer-scoped-to-delta is the enforcement; documented as advisory (WS6) |
| M11 | MED | Metrics unmeasurable as written | WS0 = derivation from existing audit.jsonl rows + delegation terminal lines + one σ-band per metric; no new instrumentation (Metrics) |

The one user-frontier question (adjacency depth: direct importers vs. k-hop)
was resolved by evidence — transitive closure, pruning optional — leaving no
open decisions from this round.

### Grill round 2 (2026-09-20) — findings and resolutions

The frontier round 1 unblocked; five factual questions answered by a second
research pass (citations inline above).

| # | Sev | Finding | Resolution |
|---|---|---|---|
| Q1 | HIGH | Audit rotation as specified (seeded, logged) is learnable — adaptive reward hacking exploits observable policy (METR) | Sealed commit-reveal: subset committed AFTER submission from an unbiasable source; deterministic rosters rejected (WS1) |
| Q2 | HIGH | Audit budget numbers hand-picked | Zero-acceptance plan: n ≥ ln(β)/ln(1−p), defaults n≈45 (β=0.10, p=5%); one defect ⇒ whole-lot re-verify (WS5) |
| Q3 | HIGH | All verdicts cached with equal trust | Verification-strength tiers (full/adjacent-closure/sampled/mechanical-only); probe budget weighted to weak tiers; cached-fail never replays (WS5) |
| Q4 | HIGH | WS1×WS6 conflict: full re-map vs patch-mode | Coverage map is cache-keyed; inherited-green findings exempt; gate checks mapped ∪ inheritedGreen (WS1) |
| Q5 | HIGH | Anchor-exists ≠ anchor-supports | Two-layer verification: mechanical resolution + NLI/LLM support-derivation for premise-class claims; tier records the layer (WS3) |
| Q6 | MED | Ledger write races (3 concurrent reviewers) | Content-hash + pipeline-position keys; first-write-wins; divergence→audit; orchestrator-only commits (WS5) |
| Q7 | MED | Protected set undefined | Derived from historical blocking/high findings + anchor-grammar core; config floor (WS1) |
| Q8 | MED | Metrics cold-start | N=3 pre-wave-1 baseline runs required; the live 07-37 run is N=1 (Metrics) |
| Q9 | MED | Rubric-version flush hits in-flight runs | Rubric version pins PER RUN at start (WS5) |
| Q10 | LOW | Crystallized vocabulary unwritten | Glossary §7 added |

## 6. Risks and honest limits

- The claim-level verdict cache is a novel synthesis (no published precedent
  found); hit-rate assumptions are unvalidated — instrument first (WS0), and
  let wave 2 land only if measured re-verification share stays >30%.
- **Checklist self-certification is weak evidence** (FBI/CHERRL — a writer's
  "addressed" declaration can fool even a good judge): WS1's three-layer gate
  exists because of this; the writer's map alone never blocks anything green.
- **No industry-standard re-verification sampling rate exists** (disclosed by
  research): the fingerprint-probe + dependency-trigger policy is our own
  synthesis on the Develocity/merge-queue precedents — treat its parameters
  as measured, not settled.
- Fan-out costs ~15× tokens per review (Anthropic's number) — it must ride on
  WS5/WS7b shrinking the review first, or it multiplies cost; and majority
  voting among shards is explicitly REJECTED (measured worst option).
- Intrinsic self-critique can hurt (Huang et al.) — every writer-side self-check
  in this design is tool-interactive or deterministic, never introspection-only.
- Cascade escalation pays twice — measure before routing verification down-tier.
- Degradations must leave the happy path byte-identical (defensive rule 7).

## 7. Glossary (terms minted by this spec)

- **Claim** — the atomic verification unit: an anchor-grammar element (AC-*/SCENARIO-* id, pinId citation, file:line premise) mechanically enumerated from an artifact by the harness; reviewers supply verdicts for the enumerated set only.
- **Verdict row** — one (claim, verdict, evidence, tier) record a reviewer emits for an enumerated claim.
- **Green manifest** — the set of claims whose cached verdict rows hit under unchanged keys for the current round.
- **Adjacency closure** — the reverse-dependency closure over the claim/citation graph; unchanged claims inside the closure of a change are always re-verified.
- **Fingerprint probe** — the periodic re-verification of identical cache keys whose disagreement rate is the cache's distrust signal (zero-acceptance plan: n ≥ ln(β)/ln(1−p)).
- **Protected set** — coverage-row classes never dropped from deep verification: derived from historical blocking/high-severity findings plus the anchor-grammar core.
- **Verification-strength tier** — full / adjacent-closure / sampled / mechanical-only; the layer that produced a verdict, carried on its row and weighting probe budgets.
- **Sealed audit seed** — the deep-verification subset selector, committed after artifact submission from an unbiasable source (commit-reveal).
- **Coverage row** — one `findingResolutions` entry: {finding id, loci, remedy-quote note}.
- **Inherited green** — a finding whose addressing loci are unchanged since a verified coverage map; exempt from re-mapping under patch-mode.
