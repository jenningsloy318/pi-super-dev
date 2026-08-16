# dsh-09 — Convergence Plan v3: sad-path team on a pipeline skeleton

Status: implemented — v3 Phase F (7dd18363, 302ae9b2, 2dabe216, fbefca47), R1–R5 (4257e2ca, d45c96d9, e1e8cde8), P1 (d0f8cbed..c50fbd21); R6 acceptance re-run pending; P2/P3.1/P4 in progress.
Version baseline: 0.1.74.
Inputs: dsh-00..dsh-08, `agent-team-runtime.md`, `graph-engineering.md`, the loop-line docs (all implemented), a full code-level verification pass, postmortem evidence from run 2026-08-16T01-00-35-613Z (spec 03-staging, pi-omisis), and the architecture discussion it prompted.

---

## 0. Corrections from the v1 draft (kept from v2)

The v1 draft was written from memory of the research docs. Code verification disproved three claims:

1. **"BDD ∥ Research is dependency-free parallelism" — WRONG.** `buildResearchPrompt` (`src/prompts.ts:164-165`) reads `state.bdd` and instructs "Read the Requirements and BDD Scenarios docs above first, then derive the 2-4 research questions". Research deliberately consumes BDD. Parallelizing would degrade research-question derivation. Demoted to deferred experiment E1.
2. **"Add parallelism to the review fan-out" — ALREADY DONE.** `reviewStep = parallel([...])` (`src/stages/verify.ts:633`); api/ui tests likewise (`verify.ts:1082`).
3. **"Build the runtime-change-replan protocol" — 80% ALREADY EXISTS** for runtime *instructions*. Spec 22 is implemented: `runtimeInstructionFingerprint` (`src/stages/implementation.ts:644`) + start/end comparison (`:847-856, :1843-1856`) invalidates green-phase carry when instructions change mid-run; `.user-notes.json` is injected into every subsequent agent prompt (`src/workflow.ts:311-313`).

Verified facts the plan builds on:

- `auditAppend` exists (per-run `~/.super-dev/runs/<ts>/audit.jsonl`, best-effort, never throws — `src/render/super-dev-dir.ts:104-112`).
- The spec dir is the durable-state home (`.knowledge.json`, `.user-notes.json`, `change-tracker.jsonl`, `.judge.jsonl`, `implementation-evidence.jsonl`, convergence reports) — new files follow this pattern.
- `task()` (`src/nodes.ts:158-226`) is the single stage-granularity choke point; `realAgent` (`src/workflow.ts`) the single agent-granularity one; `runBuildGate`/`runRedCheck` are centralized.
- 27 stage ids are statically enumerable from `src/stages/*.ts`.
- `parallel()` has a duplicate-id guard and sibling-cancellation (`src/nodes.ts:310-352`).
- The convergence ledger (`src/convergence-ledger.ts`) already implements finding→owner-stage recording + `markConvergenceFindingsAddressedFromResponses` — the writer-revises-per-finding loop inside every artifact-convergence node is mature.
- Resume is memoized replay over a deterministic stage graph (the strongest resume story available); green-phase carry skips still-green work on re-entry.

## 0.5 Trigger: production run 2026-08-16T01-00-35-613Z (why v3 promotes the replan edge)

Run: pi-omisis spec 03-staging (v0.1.74), 1h47m, ended **PARTIAL** at Stage 10. Verified evidence chain from run.log + audit.jsonl + rendered reports:

1. Attempt 1: `review=Changes Requested build=fail` on finding F-01/AR-03-01 (real defect: spec-02's closed-set export pin not updated for spec-03's new export). Fix round repaired it (159→160 tests green) — **but the fix was left uncommitted in the worktree** (`M tests/persistence.test.ts`); no commit step exists after `reviewFix`, and the adversarial reviewer itself warned "must ship with the merge". mergeVerify checks branch geometry only, never worktree cleanliness.
2. Attempt 2: codeReview **Approved** (2 verified findings), testsReview **Approved**, adversarial **CONTEST** (blocker verified fixed; residue = 4 medium/low design-level findings). The only needs-human finding (AR-03-02) tripped `reviewFindingBlocks`' needs-human⇒blocking rule → CONTEST pinned "Changes Requested". Meanwhile R-1 triage (correctly) deferred the same needs-human finding — the verdict layer demanded changes **no code fixer is allowed to make**.
3. All 5 residual findings are **design/spec-level** (resume protocol undefined by spec, unbounded re-injection as a design tradeoff, ±0.10 tolerance hardcoding vs spec ambiguity) — none is an implementation bug. The pipeline has **no back edge** from verify to spec/design: dead-state break fired, verdict unapproved, findings empty → PARTIAL.
4. The dead-state break **reused the stagnation report template**, producing a misdiagnosis ("the same findings recurred... fix the implementation" — pointing at the direction the pipeline itself refuses to fix).
5. Earlier in the run, BDD round 1 lost 480s wholesale: the W-1 soft deadline fired at 384s, the agent said "I have enough context to compose the scenarios now", but 96s of grace was not enough to emit the 43-scenario control JSON (round 2 needed 138s for the same emission); hard timeout discarded everything. The wrap-up prompt asked it to "call structured_output now" but not to **emit partial content**, and 20% grace is empirically too short for large writer controls.

Second production occurrence of the class (first: v0.1.52, implementation-stage discovery of a spec-level contradiction; this: verify-stage discovery of design-level defects). v2 deferred replan "until ledger telemetry shows a real miss" — this run **is** the miss. Per the plan's own criterion, the bounded cross-stage replan edge is promoted to a first-class phase.

## 0.6 Recorded architecture decisions (user, 2026-08-16)

- **D1 — Pipeline skeleton + sad-path team.** The happy path stays a deterministic pipeline (verifiable, resumable, auditable). Team behavior is added only on the sad path: when verify/implementation discovers upstream-owned defects, a bounded replan circuit routes them back to their owning stage. Full team-ification (lead dispatching the normal path) is explicitly rejected: judge quality is the system ceiling and judge-layer failures — not worker failures — caused both observed deadlocks; every LLM freedom in this repo's history eventually needed a deterministic cap; resume/audit rest on the deterministic skeleton. A controlled A/B (pipeline+replan vs full team on one spec) may be run later using the Phase-P1 ledger, data permitting.
- **D2 — Strong model for the replan lead.** A new `replan-lead` agent role (distinct from `judge`): judge is cheap/frequent (2 per signature), replan-lead is rare (0-2 per run) but its routing decision determines the whole back edge. Mapped via the existing `agentModels` mechanism — user maps it to the strongest model. Zero new configuration code. Same evidence discipline as judge: byte-verified file quotes, confidence floor, non-conforming output degrades to HITL, never a guessed route.
- **D3 — Dependency-graph FULL invalidation.** When an upstream artifact is revised via the replan edge, all stages reachable from the owning stage in the edges graph are invalidated (green-phase carry + replay cache). Wasteful-but-safe first; the ledger measures the actual rework-was-unchanged ratio; incremental invalidation is a data-gated later refinement.

## 1. What the converged research supports (kept from v2, plus the trigger framing)

| Line | Verified contribution | Plan element |
|---|---|---|
| dsh-03 (SessionEvent log) | One append-only ledger; consumers are folds; deterministic replay beats in-place mutation | P1 ledger; R3 restart mechanism |
| dsh-06 (process) | Postmortem → named rules; explain-or-assert invariants | P0, P1.7 |
| agent-team-runtime | WHO/HOW/ALGORITHM split; RACI ownership; closure pressure | R2 owner map, P2, P3.1 |
| graph-engineering | Explicit dependency edges; bounded feedback loops | R1 edges table (also the D3 invalidation graph) |
| Loop line (ours) | The verification spine — keep unchanged, make event-emitting | P1.2-1.5 |

Anti-scope (unchanged): no plugin substrate, no runtime HMR, no free-form agent chat, no LLM-dispatched happy path, no LangGraph-style graph executor for the main flow (R-mech-1 documents the future upgrade path), no stage-level context compaction.

## 2. The atomic plan

Conventions (every commit): full typecheck; affected suites + FULL suite with vitest's own exit code (no unguarded pipes); version bump in `src/version.ts` + `package.json` + `package-lock.json` + `tests/version.test.ts` in the same commit; one logical change per commit.

### Phase F — immediate run-response fixes (independent of all other phases; days 1-2)

Each is a direct answer to a verified defect in run 2026-08-16T01-00-35; none depends on the plan's other phases.

**F-A needs-human verdict/triage contradiction.** Today `reviewFindingBlocks` maps needs-human⇒blocking, so a CONTEST/"Changes Requested" verdict stays pinned by a finding that R-1 triage simultaneously defers to a human — an unactionable verdict that dead-ends. Fix: at verdict normalization (`normalizeReviewVerdict`, `src/helpers.ts`), a needs-human finding no longer pins "Changes Requested" through the blocking path; instead the merged verdict carries a distinct residue marker (e.g. `verdict` stays approvable-if-otherwise-clean, and `s.review.needsHumanFindings` records the items). Escalation/reporting for this residue says "awaiting human decision", never "fix the implementation". The fixer never receives them. Cross-stage/blocking/open-high findings keep today's pinning semantics untouched.
- Tests: `tests/helpers.test.ts` extension (CONTEST + needs-human-only residue → "Approved with Comments"-class verdict with residue recorded; open-high still pins; blocking still pins); stagnation/verify-loop-gating fixtures asserting the new report kind.

**F-B deterministic commit after reviewFix + clean-worktree merge verification.** (i) In `verificationConvergenceNode` after a review fix that changed state (`fixChanged`), deterministically `git add -A && git commit -m "fix(verify): address review findings (round N)"` in the worktree — no LLM, mirroring the verify-never-trust convention (the implementation stage's LLM commit agent stays as-is for phases). (ii) `mergeVerifyTask` additionally rejects `merged:true` when `git status --porcelain` is non-empty in the worktree at merge time (uncommitted changes would not ship) — rewrite to `merged:false` with reason, so the run reports partial, never a silently-lossy success.
- Tests: `tests/merge-verify.test.ts` extension (dirty worktree → unverified; committed → verified, real tmp git repos); verify-loop test asserting the post-fix commit exists after a scripted fix round.

**F-C honest dead-state report.** The dead-state break currently reuses the stagnation template. Fix: distinct report kind `blocked-on-decisions` (own section in stagnation-report.md / escalation-report.md and the HITL prompt): "review not approved; N findings remain, all deferred (advisory / needs-human / cross-stage); no code fixer can act; awaiting human decision or replan routing". Never claims recurrence; lists each deferred item with its deferral reason. (Superseded in practice once Phase R routes routable items — but the unroutable residue keeps this honest report.)
- Tests: render/escalation-report test — dead-state shape renders the new kind; stagnation shape unchanged.

**F-E wrap-up emission + grace for large writer controls.** (i) Wrap-up prompt wording: "emit the structured output NOW with whatever you have — partial sections are acceptable; do NOT keep exploring; the next round will complete missing sections" (convergence retry feedback already names what's missing). (ii) Grace window for control-heavy writer roles (bdd/requirements/spec writers) extended from 20% to 30% of timeout (BDD r1 evidence: needed ~138s to emit after wrap-up, had 96s). Constants role-scoped, not global.
- Tests: `tests/session-agent-soft-deadline.test.ts` extension — wrap-up prompt text contains the partial-emission instruction; grace constant per role-class; hard timeout still rules at 100%.

### Phase R — bounded cross-stage replan edge (the structural answer; days 3-9)

The sad-path team circuit. Design principle: **restart-based back edge** (R-mech-2), not in-run edge mutation — deterministic replay over run boundaries reuses resume, green-carry, and the existing convergence revision loop; each replan is a clean, auditable run boundary.

**R1 — dependency-edges table** (= v2 P3.3, unchanged, now also the D3 invalidation graph).
- `src/graph/edges.ts`: static `EDGES: {from, to, rationale}[]` for the 27-stage skeleton from the verified prompt reads (bdd←requirements; research←requirements,bdd; debug←requirements,research; assessment←research,debug?; design←requirements,research,assessment; spec←requirements,bdd,research,assessment,design,prototype; implementation←spec; verify←implementation,spec; docs/cleanup/merge←verify).
- Test: `tests/graph-edges.test.ts` — every non-setup stage has ≥1 inbound edge; acyclic (topo sort); three signature tripwires (grep `buildResearchPrompt` args etc. — adding a prompt dependency without updating the table fails CI); exported `downstreamOf(stageId)` reachability helper tested.

**R2 — owner classification (minimal WHO; v2 P2.1 subset absorbed here).**
- `src/replan/owners.ts`: deterministic classifier first — (a) reviewer-provided `ownerStage` honored; (b) finding citing `docs/specifications/NN-*.md` routes to that artifact's stage; (c) file-path class (docs/specifications vs docs/requirements vs src vs tests) + keyword classes (contract/protocol/ambiguity/threshold-undefined → spec/design; unbounded/token-budget → design; behavior/regression → implementation). Residue → **`replan-lead`** (new agent role, D2 strong model, judge-style evidence discipline: byte-verified quotes, confidence ≥0.6, closed owner set, non-conforming → unroutable→HITL). Output per finding: `{ownerStage | "human" | "unroutable", routable, reason, evidence?}`.
- Test: `tests/replan-owners.test.ts` — deterministic cases (each rule, pass and fail); lead-classifier mocked (routable / human / degraded); closed-set enforcement; never throws.

**R3 — revision-request persistence + REPLAN restart (R-mech-2).**
- When the dead-state break (or F-A's needs-human residue at loop exit) contains ≥1 routable finding: write `replan-requests.json` to the spec dir (array of {finding, ownerStage, evidence, requestedRevision, originatedRunId}) + an invalidation set (R4); end the run with status `replan` (a first-class terminal status beside success/partial/failed — extension.ts run summary explains: "N finding(s) routed back to <stages>; auto-resuming"). If auto-resume is enabled (config, default ON — OQ6), the extension immediately re-invokes the pipeline on the same spec id (the existing resume path).
- On the next run, each owning convergence node reads `replan-requests.json` at round 1 and injects its items as convergence-ledger findings with `detectedAtStage: replan` — the **existing** writer-revises-per-finding machinery (recordReviewFindingsFromControl → retry feedback → reviewer verifies resolution) does the revision; no new revision loop is built.
- Requests are consumed (marked addressed in the file) only when the owning reviewer verifies the resolution — the ledger's existing `markConvergenceFindingsAddressedFromResponses` semantics.
- Test: `tests/replan-restart.test.ts` — dead-state with a routable finding produces the file + replan status; a scripted next-run convergence node consumes its item as a ledger finding; addressed-marking only on reviewer verification; unroutable/human residue does NOT trigger restart (stays HITL with F-C's honest report).

**R4 — dependency-graph full invalidation (D3).**
- Mechanism: per-artifact `revision` counter persisted in the spec dir (`artifact-revisions.json`: {requirements: 2, spec: 3, ...}); each replan-confirmed revision of an owning artifact bumps its counter. Green-phase carry and replay cache entries record the counter values they were computed against; on resume, any entry whose upstream counters differ is invalidated and re-runs. `downstreamOf(owner)` (R1) defines which counters each entry depends on. This generalizes spec-22's instruction fingerprint to upstream-artifact revisions, reusing its proven invalidation seam.
- Test: `tests/replan-invalidation.test.ts` — bumping `spec` invalidates implementation green-carry + verify replay but NOT requirements/bdd artifacts; bumping `requirements` invalidates the full downstream chain; no bump → full carry preserved (the spec-22 no-change fast path stays byte-identical).

**R5 — back-edge budget + escalation beyond.**
- `MAX_REPLAN_ROUNDS = 2` per spec (env `SUPER_DEV_MAX_REPLAN_ROUNDS`, lazy read — defensive rule #5), persisted in the spec dir with the requests file. A third routable occurrence of the same finding fingerprint → no restart; HITL with the honest F-C report + replan history (which rounds, which owners, what changed). Every replan decision appends to `.judge.jsonl`-style audit (`replan.jsonl` in spec dir; ledger events once P1 lands).
- Test: budget exhaustion path (3rd occurrence → HITL, no restart); counter reset on new finding fingerprint; lazy env read overridable in tests.

**R6 — acceptance: re-run spec 03-staging.** The machine-checkable exit criterion for Phase R: re-running the same task must route an AR-03-03-class finding (resume-protocol-undefined) to spec convergence, revise the spec, invalidate downstream per D3, re-implement, and converge — no dead-state PARTIAL, no human intervention. Plus full existing suite green (verification-spine semantics unchanged on the happy path).

### Phase P — the v2 plan, resequenced (weeks 2-3; content unchanged except noted)

- **P1 event ledger** (7 commits as in v2: core, task/realAgent/gates/judge wiring, replay proof, invariants registry+contract test). P1.1 (core) ideally lands before R3 so replan events are ledgered from day one — acceptable to land just after if sequencing demands; R3 audits to `replan.jsonl` meanwhile. New event types added to the P1.1 registry: `replan.requested/routed/resumed` {findings, owners, invalidationSet}, `artifact.revised` {artifact, revision}.
- **P0 process foundations** (postmortem 0001 gains a second case study: this run's needs-human contradiction + uncommitted fix round; defensive-patterns rule 6: a verdict pin and a triage defer must never disagree about who can act; plan-doc Status lifecycle; loop vocabulary; degraded-boot diagnostics).
- **P2 full team/RACI** (P2.1's deliverable→owner map now extends R2's minimal stage-owners; setup validation; topic projection).
- **P3 messages + instructions** (P3.1 unchanged; P3.2 unchanged; P3.3 absorbed by R1).
- **P4 generated docs** (unchanged; the stage table now renders from edges.ts which exists since R1).

### Deferred experiments (unchanged: E1, E2, E3) + new

- **E4 full-team A/B** (from D1): one spec, two runs — pipeline+R vs a lead-dispatched 3-role team — compared on gates-passed, residual findings, cost, loops, human interventions. Only with P1 ledger data; not before Phase P completes.

## 3. Testability summary

| Phase | Machine gate |
|---|---|
| F | helpers/merge-verify/escalation-report/soft-deadline suite extensions (per-fix, listed above) |
| R | graph-edges, replan-owners, replan-restart, replan-invalidation tests + R6 acceptance re-run |
| P1 | runlog core/wiring/replay-proof + invariants contract test |
| P0/P2/P3/P4 | as in v2 (docs-contracts, team, messages, arch-docs) |

## 4. Sequencing & effort

F (days 1-2, 4 commits) → R1+R2 (days 3-4) → P1.1 ledger core (day 5, parallel) → R3-R6 (days 5-9) → P1 rest + P0 (week 2) → P2/P3.1/P4 (week 3). R6's acceptance re-run closes Phase R. Every commit independently green; the verification spine's decision semantics change only in F-A (verdict residue split — pinned by tests) and gain the R circuit at run boundaries (happy path byte-identical, guarded by the existing 2000+ suite).

## 5. Open questions

- **OQ1-OQ4** (kept from v2: audit.jsonl dual-write; agent-text granularity; invariants loud-not-fatal; E1 default OFF).
- **OQ5 replan budget value**: recommend 2 (consistent with MAX_CHALLENGE_REAUTHORS=2 and ESCALATION_RETRY_CAP=2); adjustable via env.
- **OQ6 auto-resume default**: recommend ON (unattended operation is a primary use case; a replan restart is cheap and auditable), with `SUPER_DEV_REPLAN_MANUAL=1` opting into confirm-first. Alternative: default manual for the first two real replans, then flip to auto.

## 6. Success criteria

1-7 from v2 unchanged, plus:
8. A verify-stage finding owned by spec/design is routed back, the owning artifact is revised, downstream invalidated per D3, and the run converges — proven by R6's re-run of spec 03-staging with zero human intervention.
9. needs-human residue never pins an unactionable "Changes Requested" verdict, and its reports say "awaiting human decision", never "fix the implementation" (F-A/F-C tests).
10. No review fix ever ships uncommitted (F-B merge-verify dirty-worktree rejection).
