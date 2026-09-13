# Routing Architecture — Why Route-Back Failed Three Times, and the Design That Fixes It

Status: M1–M5 implemented (M1 v0.3.5, M2 v0.3.6, M3 v0.3.7, M4 v0.3.8, M5 v0.3.9) — migration complete

## The incident, in one paragraph

The BDD reviewer filed a P1 finding owned by `requirements` (AC-03 references a
per-finding `verdict` field that does not exist on the closed `FindingSchema` —
fixtures un-constructible; the BDD writer structurally cannot fix it). The loop
correctly detected `UPSTREAM-OWNED blocker` and escalated. The user replied
"route back to requirment stage". The harness recorded the reply verbatim,
classified it as `retry-with-guidance` — the only vocabulary it has for "keep
going" — and re-ran the **BDD writer**. The round-2 writer read the guidance,
read the requirements doc, and *said out loud*: "The requirements doc still
contains AC-03's phantom per-finding `verdict` phrasing — **the upstream was
not amended**." Everyone in the system understood the instruction; the
architecture had no edge to carry it.

## Research synthesis (full-text sources)

### swe-agent — the retry/route decision is a first-class controller object
`AbstractRetryLoop` (sweagent/agent/reviewer.py) sits BETWEEN the reviewer and
the agent: `retry()`, `on_submit()`, `on_model_query()`, `on_attempt_started()`,
`get_best()`, `get_forwarded_vars()`. The reviewer only judges; the loop OWNs
the continue/stop decision, with budgets as constructor arguments
(`min_budget_for_new_attempt`, `cost_limit`). Two composable strategies
(score-threshold, LLM-chooser+preselector). **Lesson: judging, deciding, and
executing are three separate roles; the decision role is an object with an
interface, not a branch inside the escalation UI.**

### LangGraph — back-edges are native, humans edit state and name the next node
Interrupts (docs.langchain.com, read in full): `interrupt()` checkpoints state;
`Command(resume=...)` returns INTO the node; **conditional edges route to ANY
node, including earlier ones**; the review-and-edit pattern has the human EDIT
graph state before continuing; re-validation uses a conditional edge that loops
back to the same node. The graph is cyclic by design — "route back to node X"
is one edge traversal, not an exception + restart + cache-replay.
**Lesson: routing must be a graph edge, and a human resume may name the
destination node.**

### Plan-then-Execute at scale (arxiv 2509.08646, §7 read in full)
A DEDICATED replan node runs after each execution step, receiving (objective,
original plan, full history of steps + outcomes), and decides
continue / re-plan / done — with conditional edges doing the routing. Verifier
and Refiner are SEPARATE roles ("the Planner may take over the role of the
Refiner" is an explicitly noted degenerate case). HITL empirically works at
EXECUTION decisions, not at plan-editing. Fallback branches can be embedded in
the plan graph so local pivots don't need full replans.
**Lesson: one replan point with total visibility beats scattered repair
branches; humans are good at picking among concrete next actions.**

### OpenAI Agents SDK — handoffs are control transfers, and loops are the known failure
Handoffs transfer control + context to a named agent; the community threads
("looping handoffs") show unconstrained back-and-forth handoffs are THE
classic livelock. The SDK's answer is constraints on who may hand off to whom.
**Lesson: routing needs an edge budget / allowed-edge set, or route-back
becomes ping-pong.**

### cumora (prior full read) — shape rules, server-side gates, tokenized intent
"Never add a prompt rule when a code mechanism is the right fix." Bypass flags
must acknowledge server-shown state (seq-bound tokens). Glance protocol: five
shape-level rules, no scenario clauses.
**Lesson: the user's route-back reply is a ROUTING COMMAND, not guidance text;
commands need a typed channel, not a free-text field.**

### MetaGPT (search + prior reads) — routing by message type, not pipeline position
Roles subscribe to message types; a published artifact of type X triggers the
role that consumes X. Route-back is degenerately natural: re-publish a
requirements-type message and the requirements role re-fires.
**Lesson: destination-addressed artifacts (ownerStage) make routing a lookup,
not a search.**

## Why our three implementations didn't work — root causes

We built route-back three times: F1 replan wiring (v0.1.98), G3/G4 judge
arbitration + guidance re-entry (v0.2.6), persisted ledger + round-1
injection (v0.3.3). All real, all partial. Four structural reasons:

**R1 — Routing decisions are scattered across five mechanisms with five
vocabularies.** Escalation choices (`retry/revise/accept/abandon`), judge
routes (`re-author/challenge/fix-env/implementer-retry/continue/escalate`),
the replan circuit (implicit, fires on no-decision), retry decisions,
convergence-loop internal branches. Each has its own trigger, budget, and
persistence. None composes. "Route back to requirements" maps to none of them.

**R2 — The pipeline is a fixed SEQUENCE, not a graph.** `src/graph/edges.ts`
has a verified DAG with `downstreamOf()` — used ONLY for cache invalidation,
never for control flow. There are no back-edges in the execution model, so
every route-back is EMULATED: FatalAbort + `__replan` marker + run restart +
resume-cache replay. Each of our three implementations patches one leak in
that emulation (this incident: the interactive-decision path bypasses the
replan trigger at artifact-convergence.ts:672 — `if (!decisionApplied &&
upstreamOwned.length > 0)`).

**R3 — The human vocabulary predates routing.** The escalation options are
retry-policy verbs, not routing verbs. Any decision at all sets
`decisionApplied = true`, which SUPPRESSES the automatic route-back — the
user answering at all defeats the mechanism. (A headless run on the same
blocker would have routed back correctly.)

**R4 — Ownership is recorded but unroutable.** Every finding carries
`ownerStage`; the ledger persists. But "go to owner" is not an action any
component can invoke — it's a side effect of the replan circuit firing under
narrow conditions. swe-agent's lesson applied: the judge/ledger/reviewer all
produce opinions; nobody owns the DECISION.

## The design

### A. One Router, one vocabulary (the swe-agent lesson)
A single decision point — `routeBlocker(state, blocker, source)` returning a
normalized **RoutingCommand**:

```ts
type RoutingCommand =
  | { action: "retry"; stage: StageId; feedback: string[] }        // same stage
  | { action: "route-back"; stage: StageId; findings: Finding[] }   // graph back-edge
  | { action: "escalate"; blocker; reason }
  | { action: "accept-limitation" }
  | { action: "abort"; reason };
```

Every producer maps onto it: reviewer upstream-owned findings → `route-back`
(owner from the ledger, the MetaGPT lookup lesson); judge routes → the same
enum; cap exhaustion with progress → `retry` with feedback; the REPLAN circuit
becomes just the persistence/auto-restart layer under `route-back`. The router
owns edge budgets (per (from,to) pair, cumora/OpenAI loop-prevention lesson)
and refuses unbounded back-edges by degrading to `escalate`.

### B. The human surface speaks the same vocabulary (the LangGraph lesson)
When upstream-owned blockers exist, the escalation select offers
**"Route back to <owner stage> (recommended)"** first — the owner is already
in the ledger. The guidance text field survives as payload on the command
(reaches the target stage's prompt), never as the routing mechanism. A
dismissed/timeout escalation in the upstream-owned case defaults to
`route-back` (today it suppresses it). `retry-with-guidance` remains offered
but is documented as same-stage.

### C. Back-edges as real control flow (Phase 3, the structural fix)
Make the stage graph cyclic at the executor level: a convergence node that
cannot resolve an upstream-owned blocker returns `route-back`; the pipeline
re-enters the owning stage's convergence node IN-PROCESS (its round-1 already
injects persisted ledger findings — v0.3.3's L1 makes the owner see the exact
blocker), then continues forward through `downstreamOf(owner)` re-runs. No
FatalAbort, no run restart, no cache-replay window. The v0.3.3 ledger +
artifact-revisions become the state-carry across the back-edge (LangGraph's
checkpoint analogy).

### D. Phasing (each independently shippable)
- **P1 (small, honest fix of the incident):** add `route-back` to the
  escalation vocabulary + option list; on upstream-owned blockers a
  route-back decision (or a dismissed escalation) drives the EXISTING replan
  circuit instead of same-stage retry. ~small diff, closes the exact bug.
- **P2 (unify):** introduce RoutingCommand + the Router; map judge routes and
  escalation onto it; per-edge budgets; escalation UI offers route-back with
  the ledger owner.
- **P3 (structural):** in-process graph back-edges; retire the
  FatalAbort/restart emulation for route-backs; replan survives only as the
  cross-RUN persistence story.

## P3 gradual migration — the stepwise plan

Grounding discovery: the pipeline is ALREADY a node-algebra interpreter
(`task()`/`sequence()`/`branch()`/`loop()` in src/stages/index.ts). §D's
implementation loop proves in-process re-entry with state carry works in
production. So P3 = give the existing interpreter a JUMP, not build a new
engine. Five independently-shippable increments, one version commit each,
full repo discipline per step (plan-doc delta, RED-first tests, dual review,
bump, CHANGELOG). Flag-off behavior must stay byte-identical at every step.

### M1 (v0.3.5) — RoutingCommand + signal, zero behavior change
- New module `src/routing/router.ts`: the `RoutingCommand` union, the
  per-edge budget ledger, and `RouteBackSignal` (an Error subclass shaped
  like FatalAbort so propagation is airtight through tryCatch/sequence).
- Pure classification: map today's five mechanisms onto the enum in a
  table functions `classifyEscalationChoice` / `classifyJudgeRoute` /
  `classifyFindingRoute` — NO callers change yet.
- Tests: unit (classification truth table, budget arithmetic).
- Exit criterion: tsc + suite green; zero production call sites.

### M2 (v0.3.6) — driver catches the signal for ONE pilot edge, flag OFF
- The pipeline driver (runPipelineTask) wraps stage execution in a
  catch for RouteBackSignal. On catch (only when
  SUPER_DEV_INLINE_ROUTEBACK=1): append to the routing journal, re-enter
  the owning convergence node in-process with the findings injected as
  round-1 feedback (ledger round-1 injection from v0.3.3 already does
  this), then continue the forward walk with green-skip guards.
- Pilot edge: bdd → requirements (the incident edge). Default OFF.
- Tests: RED-first — synthetic upstream-owned blocker with flag on:
  requirements writer re-invoked same-process, no FatalAbort, no
  `__replan` marker, journal written; flag off reproduces today's
  emulation exactly (golden equivalence).

### M3 (v0.3.7) — pilot flips default-ON (the incident-closing step)
- Default ON for bdd→requirements and spec→upstream; kill-switch
  SUPER_DEV_NO_INLINE_ROUTEBACK=1 falls back to the FatalAbort+replan
  emulation (which stays fully intact as the fallback path).
- Per-edge budget: 2 per (from,to) pair per run, persisted; exhaustion
  degrades to escalate (never ping-pong — OpenAI/cumora lesson).
- Forward re-walk reuses edges.ts `downstreamOf()` + artifact-revisions
  counters — same table as cache invalidation, now steering control flow.
  Convergence nodes whose artifacts are unchanged AND previously approved
  AND carry no new findings fast-forward (cheap deterministic gates only).
- Resume fidelity: the routing journal is persisted; on resume the driver
  honors recorded jumps during the cache-hit replay phase, then continues
  live (LangGraph checkpoint/Command analogy — never re-derive a past
  routing decision from nondeterministic replayed reviews).
- Tests: incident replay end-to-end (fake agents), budget exhaustion,
  kill-switch fallback, resume-with-journal replay.

### M4 (v0.3.8) — generalize all producers
- artifact-convergence, spec-convergence, implementation env-blocker
  (G3 implementer-retry folds into RoutingCommand), and verify's
  maybeTriggerReplan all EMIT RoutingCommand instead of their bespoke
  paths. Escalation UI gains "Route back to ⟨owner⟩ (recommended)" as a
  first-class choice wired to the same signal; a dismissed/timeout
  upstream-owned escalation defaults to route-back (kills the
  decisionApplied suppression class for the inline path).
- Tests: per-producer mapping pins + escalation-choice pins.

### M5 (v0.3.9) — retire the emulation for routing
- FatalAbort + `__replan` + auto-restart remain ONLY for genuine
  cross-run interruptions (cancel, process death). replan-requests.json
  survives as audit + cross-run resume record. Delete the interactive
  decision suppression entirely. Docs/ARCHITECTURE regenerated.

### Cross-cutting invariants (checked at EVERY step)
1. Flag-off golden equivalence: scripted fake-agent run, event streams
   byte-identical before/after (this is what makes the migration gradual
   AND revertible).
2. Resume-cache stability: memoization keys `callId@scope#N` unchanged;
   journal + append-only cache compose (fresh calls append occurrences).
3. Single source of truth: edges.ts serves BOTH invalidation and walk order.
4. Observability: every jump emits route.requested/route.taken events with
   edge id, budget remaining — debuggable from the run log alone.

### Second-pass research review — five missing pieces (added after M1–M5)

Sources: durable-execution deep-dive (vadim.blog, full read — cites LangGraph
node-re-execution semantics, the Crab semantics-aware checkpoint/restore study
arxiv 2604.28138, Blueprint First arxiv 2508.02721); Diagrid on
checkpoints-vs-durable-execution; Temporal idempotency/event-history pages.

**MP1 — Journal write ordering must be SYNC-before-re-entry.** A jump record
is written durably BEFORE the owning stage re-enters, and it carries the
post-jump resume-cache occurrence offsets. Without this, a crash mid-re-entry
leaves the journal saying "jumped bdd→requirements" while the cache holds
partial rounds of the re-entered writer — resume then cannot tell whether the
re-entry completed. Rule: crash between journal write and re-entry completion
→ resume fast-forwards using journal + recorded cache offsets. (LangGraph:
'nodes re-execute on resume'; pick durability mode by consequence-of-loss —
jump records are 'sync' class.)

**MP2 — Budgets are checked from persisted state, never memory.** The
per-edge budget read that gates a jump must load from the persisted journal,
not an in-process counter. The exactly-once-send lesson: a duplicate guard is
only real if it reads persisted state (two resumes of the same run must see
the same budget remaining). Memory-only budgets silently re-arm on resume —
the same failure class as the pre-sd26 guidance grant.

**MP3 — Router code obeys a determinism contract.** The three classifiers
(`classifyEscalationChoice`, `classifyJudgeRoute`, `classifyFindingRoute`)
and the budget arithmetic are pure functions of (state, finding, persisted
journal) — no wall-clock, no randomness, no environment reads. On resume,
replayed decisions must follow the same code path to the same answer
(Temporal's deterministic-workflow rule); a nondeterministic router makes the
journal and the replay disagree, which is worse than no journal.

**MP4 — Semantics-aware journaling: journal only jumps and budget
consumption.** Crab's finding (75%+ of agent turns carry no recovery-relevant
state; blanket checkpointing is waste) applies directly: fast-forwards,
green-skips, and ordinary convergence rounds are NOT journaled — only the
routing decisions that change the walk. Keeps the journal small enough to
audit by eye.

**MP5 — Escalation pauses are checkpointed state, not blocked threads.**
Already half-true (escalation-report.md + user-notes), but M4's
route-back-aware escalation must persist the OFFERED choices + owner + budget
state so a resume re-renders the same decision surface instead of silently
re-arming or dead-lettering (the run-05-09 dead-letter class). Also honors
the Diagrid warning: concurrent resumes need the run lock — already held.

### Validation this pass added
Three independent sources now converge on the Router design itself:
Blueprint First, Model Second (deterministic control flow out of the model,
+10.1pp over baselines); Temporal (event history + deterministic replay —
exactly what journal + resume-cache already are); LangGraph (conditional
edges + interrupt/Command). No source contradicts the M1–M5 shape. The plan
was missing only the durability contracts above.

### Code deep-analysis — eight gaps found (third pass, code-anchored)

Audited: nodes.ts (task/sequence/loop), pipeline.ts driver, stages/index.ts
composition, artifact-convergence.ts:645-675 incident seam, convergence-ledger.ts
persistence, resume.ts occurrence keys, implementation.ts §D green-skip.

**G1 — There is NO jump primitive; M2 must build an addressable walker.**
`sequence()` (nodes.ts:232) iterates a fixed array composed once at module
load (stages/index.ts:129); `loop()` (nodes.ts:362) re-runs ONE node only —
the §D precedent cannot generalize. Two viable shapes:
(a) **sub-walk**: export the stage list as an addressable array; the walker
slices `children[indexOf(owner)..]` and runs the slice — predicates (isBug,
canMerge, hasImplementation) read state and re-evaluate correctly mid-walk;
pre-owner stages never re-run at all. (b) full re-walk = in-process resume
via cache replay. **Choose (a) sub-walk** — cheaper, no replay dependence.
M2 amended accordingly.

**G2 — RouteBackSignal must extend FatalAbort.** task() (nodes.ts:196-210)
re-throws only `isFatalAbort(err)` or `stage.fatal`; sequence() re-throws
FatalAbort through tolerant mode. Subclassing FatalAbort makes propagation
airtight through every combinator (one 2-line guard added in gate()'s
never-throw escalation catch — the sole swallow point, review round-2). The walker
catches it ABOVE root.run — before runWorkflow's summary derivation
(workflow.ts:630 replan-status branch), so inline jumps never end the run.

**G3 — Journal must record walk POSITION, not just the edge.** After the
owner re-converges, the forward walk resumes at owner+1 through end
(downstreamOf(owner) re-runs with green-skip; the original thrower is inside
that range). Journal entry: {edge: thrower→owner, resumeFromIndex,
invalidated: downstreamOf(owner), budgetBefore/After}.

**G4 — Green-skip guards do not exist for doc stages.** §D's phaseStatus
carry is implementation-only (implementation.ts:961-997). Requirements/BDD/
design/spec convergence nodes have NO "already converged + artifact revision
unchanged + no new findings → fast-forward" guard. M3 must BUILD a
revision-gate helper reading artifact-revisions.json (counters already exist
from replan R4 invalidation). This is real work the plan underestimated.

**G5 — Re-entry MUST drop the owner's cached rounds.** replan's
invalidateResumeCache already drops owner + downstreamOf(owner) rows via
STAGE_CALL_PREFIXES — the walker reuses it verbatim. Without this the
re-entered writer memoization-replays its old rounds (keyed
`callId@scope#N`, resume.ts:167-183) and reproduces the identical doc.
Intended consequence: priorRounds resets to 0 → fresh 8-round budget
(effectiveCap math already tolerates this).

**G6 — Escalation surface seam inventory.** ESCALATE_OPTIONS (hard/soft)
and mapEscalateChoice in extension.ts/escalation.ts must gain
`route-back:<owner>`; artifact-convergence's decision branch (645-675) maps
it to a RouteBackSignal throw; headless-no-decision in the upstream-owned
case flips from replan-emulation to inline route-back at M3 default-on.
MP5's persisted offered-choices record slots in here.

**G7 — What migrates from process-local to journal-authoritative.**
`__replan` marker, replanRestarts counter, escalation retry budget are all
process-local today. M5 makes the journal the single persisted authority
for route-back state; `__replan` survives only for genuine cross-run aborts.

**G8 — Golden-equivalence tests need two fixtures.** Flag-on runs emit
EXTRA stage records (ctx.results, stage events) for re-entered stages —
byte-identical equivalence holds only flag-OFF. The test contract: flag-off
stream ≡ pre-change stream (exact); flag-on stream ≡ flag-off + expected
delta records (structural compare), so both directions stay pinned.

### Amendments to M1–M5 from these gaps
- M1: RoutingCommand gains `resumeFromIndex`/`invalidated` on route-back
  (G3); RouteBackSignal specified as FatalAbort subclass (G2).
- M2: sub-walk design (G1) replaces "re-enter the owning node"; walker owns
  cache invalidation (G5); two-fixture equivalence contract (G8).
- M3: revision-gate green-skip helper is a named deliverable (G4).
- M4: escalation seam work item (G6).
- M5: journal-authoritative migration list (G7).

## Explicitly out of scope
Full DAG-parallel execution (LLMCompiler) — orthogonal; dynamic plan rewriting
(the replan node here only re-enters owning stages, it does not regenerate the
stage list); auto-approving route-backs without budget (the escalation path
stays available at budget exhaustion).

## Traceability
- Incident log: ~/.super-dev/runs/2026-08-21T03-23-47-913Z/run.log (bdd round 2,
  11:47:26 writer quote) + escalation-report.md (Choice: retry-with-guidance,
  Guidance: "route back to requirment stage").
- Prior implementations: v0.1.98 F1 (commit b99def83), v0.2.6 G3/G4 (7df74054),
  v0.3.3 ledger (c01a831a).
- Research: swe-agent reviewer.py (full read); LangGraph interrupts doc (full);
  arxiv 2509.08646 §7 (full); OpenAI Agents SDK handoffs + community loop
  threads; cumora coordination docs (prior full read); MetaGPT message-type
  routing.


## M3 design details (v0.3.7)

**Default-ON semantics.** `inlineRouteBackEnabled()` flips to default TRUE.
Kill-switch: `SUPER_DEV_NO_INLINE_ROUTEBACK=1` (alias
`SUPER_DEV_INLINE_ROUTEBACK=0`) restores the replan emulation byte-identical.
The G8 invariant transfers: flag-off equivalence becomes KILL-SWITCH
equivalence — same fixture, same assertion, env flipped.

**Pilot edges widen to the two incident classes:** `bdd→<upstream>` (run
03-23-47: phantom AC in requirements blocking BDD round 1) and
`spec→<upstream>` (runs 05-48/06-02: spec-review upstream blockers). The
planner still requires exactly ONE distinct routable strictly-upstream owner;
spec-convergence gains the same throw-site in its upstream-signature-repeat
branch (the one existing seam — after the 2-round identical-signature
trigger, BEFORE triggerReplanForFindings).

**G4 revision-gate green-skip** (`src/routing/revision-gate.ts`):
- `recordConvergedRevision(state, stageId, specDir)` — called by BOTH
  convergence loops at genuine approval (incl. duty-override; NOT
  accept-limitation, which is a user-forced pass with open blockers).
  Stores `{ revision }` on `state.__convergedRevisions[stageId]` where
  revision = the stage's CURRENT artifact-revisions.json counter.
- `revisionGateFastForward(state, ctx, stageId, specDir, validate)` —
  returns true (and logs) when ALL hold:
  1. a routing journal exists with ≥1 entry (provably inert on
     never-jumped runs — G8 byte-identity preserved),
  2. `__convergedRevisions[stageId]` exists (converged earlier in THIS
     process — the thrower never records, the owner's recorded revision
     was just bumped → both re-run),
  3. current revision == recorded revision (this stage was not re-owned),
  4. ZERO pending replan requests target this stage,
  5. the stage's cheap DETERMINISTIC validator passes on the existing
     state control — agent-free. (Round-2 honesty: this is a genuine
     re-check ONLY for cross-doc trace gates, so the gate is
     OPT-IN per node via `fastForwardable: true` — set for requirements
     and bdd, whose validators re-read CURRENT upstream docs. research has
     no validator; design's designComplete is a contract-claims sensor that
     does NOT re-check against upstream — both conservatively re-run.)
  On true the node returns `{ status: "ok", attempts: 0 }` WITHOUT any
  writer/reviewer call and re-records the revision (idempotent).
- Beneficiary analysis (corrected round-2): the sub-walk re-runs owner..end;
  stages BETWEEN owner and thrower all converged in pass 1 — for
  `spec→requirements` that is bdd, research, assessment, design, prototype.
  G4 fast-forwards exactly bdd (trace gate); assessment/prototype are plain
  writers with no convergence gate; research/design re-run by design.

**Resume fidelity (MP1, round-2 design).** Per-run budget epochs are
process-local, which would re-arm a crashed run's consumed edge budget on
resume. The walker entry CANNOT seed (it runs before setup — state.setup is
empty there; the round-1 resumedTrack-on-walker approach was dead code,
caught by both reviewers). Fix: chargeRoutingJump persists the epoch it
budgeted under to `routing-epoch.json` (best-effort, beside the journal);
the SETUP stage — the first seam with both the spec dir and the resume
identity — calls `seedRunEpochFromJournal(specDirectory)` on an explicit
`--resume`, seeding the crashed run's epoch start so ALL its jumps count
(the last-entry fallback covers a missing epoch file; a missing journal
means a fresh epoch). Fresh runs keep per-run semantics unchanged. No other
resume machinery is needed: the jump's persisted effects (cache drop +
pending requests + revision bump + journal) ARE the resume record; a crash
anywhere in the ordered protocol leaves a consistent prefix.

**M3 test additions:** kill-switch equivalence (was flag-off), spec throw-site
e2e, G4 fast-forward (bdd skips agent calls after a jump; research/design
re-run — fastForwardable is opt-in; second-jump owner does NOT
fast-forward), G4 inertness without a journal, resume epoch seeding
(routing-epoch.json: a crashed run's jumps ALL consume the resumed budget;
spec-convergence also fast-forwards via its trace gate), incident replay
end-to-end (fake agents: bdd round-1 upstream blocker → jump → requirements
revises → bdd converges → downstream proceeds).

## M2 review record (rounds 1–2)

Round 1 (Changes Requested / CONTEST): T3.4b dedupe regression (pending-only
suppression + pre-run-addressed re-injection), per-run budget epoch (journal
`at`-filtered via startRunEpoch; seq from maxSeq), B6 guard, decline-path
degradation to the replan emulation, planner blocking/pilot-edge gates,
specConvergenceNode id, route.taken/declined run events.

Round 2 (both Changes Requested): R2-1/F-B injection reordered BEFORE the
journal charge; R2-2/F-A decline FatalAbort now carries the canonical
"REPLAN at round cap" literal so the workflow boundary derives status replan
and auto-resume fires; R2-3 pending-rows fallback tier (the emulation's own
dedupe can no longer strand a decline); R2-4 order-dependent pin fixed;
R2-5 torn-boundary healing in chargeRoutingJump (mirrors runlog); R2-10
revisions precheck + B6 dry probe BEFORE any mutation (a declined jump
leaves counters, cache, journal untouched).

### Accepted, documented (not fixed in M2)
- **F-C sub-walk green-skip vs restart emulation**: the sub-walk re-enters
  implementation with the persisted phaseStatus carry (green phases skip),
  while a restart re-implements. For the FIRST jump on the pilot edge
  (bdd→requirements) this is structurally unreachable — implementation has
  not run when BDD is still converging; a SECOND jump (edge budget 2) could
  reach a post-implementation thrower in-process, where the carry is the
  SAFER behavior anyway (green phases skip; failed phases re-attempt with
  prior reasons). The revision-gate deliverable (M3, G4) makes the skip
  revision-gated instead of carry-gated.
- **R2-6 epoch re-arm on resume**: per-run budget re-arms by design; cross-run
  jump cycling is bounded by the replan auto-resume cap (maxReplanRounds)
  because every restart path terminates REPLAN and consumes replanRestarts.
- **R2-8 module-global epoch**: assumes serial runWorkflow per process —
  guaranteed by the spec-dir run lock; concurrent invocations would clobber
  the budget window.
- **F-E ISO-string epoch compare**: same-format Zulu strings compare
  lexicographically correctly; a mixed-precision clock could mis-scope one
  boundary millisecond (accepted).
- **F-D +2 revision skew** when a decline falls back to the emulation after
  a bump: conservative for invalidation, skews the audit counter by one.

## M2 review record (round 3)

Verify-only round: all nine round-2 remediations VERIFIED. Residuals fixed
after round 3: V-1 stale module header rewritten to the actual protocol
order; adversarial F-1 dead dry-probe removed and the B6 guard moved to the
REAL post-call result (0-drop + surviving rows → decline before the journal
charge — pinned with a read-only cache); adversarial F-2 (high, pre-existing)
the two sibling replan terminals in artifact-convergence/spec-convergence now
carry the canonical "REPLAN at round cap" literal so every replan path
auto-resumes (source-grep pin); V-4/F-3 `rounds: 1` in the pending-tier
marker + tier-2 and B6 pins added; F-4 disposition wording corrected above.

## M2 review record (round 4) — final

Verify-only: **code-reviewer approved; adversarial PASS.** Residuals were
cosmetic and are fixed: R4-2 over-indented block in artifact-convergence
re-aligned; R4-1 RED-first counts recorded here — final-state verification
`git stash -- src/` → tests/routing-walker.test.ts: **11 fix-specific tests
fail on pre-fix src, 14 controls pass on both trees**; 25/25 after restore.
Full suite 167 files / 2688 passed + 3 skipped; tsc clean.

## M3 review record (round 1)

Both reviewers CHANGES-REQUESTED; convergent findings, all remediated:
- **R4 dead resume seeding (both, high)** — state.setup is EMPTY at walker
  entry, so the resumedTrack branch never ran in production. Fixed: the
  SETUP stage seeds (first seam with specDir + resume identity); the walker
  entry keeps only the fresh default; SetupControl.resumedTrack removed.
- **R4 epoch undercount (both, medium)** — seeding from the journal's LAST
  entry counted only that entry, re-arming all but the final jump of a
  multi-jump crashed run. Fixed: chargeRoutingJump persists the budgeted
  epoch to routing-epoch.json; resume seeds that exact epoch (pinned).
- **R2 validator gap (both, medium)** — condition 5's "re-checks against
  CURRENT upstream" was false for design (designComplete is a contract
  sensor) and research (no validator). Fixed: fastForwardable opt-in
  (requirements + bdd only); research/design pins prove they re-run.
- R6 stale comments, test env hygiene, package.json em-dash byte restore,
  doc beneficiary overstatement — all fixed.

## M3 review record (round 2) — final

Code-reviewer CHANGES-REQUESTED (1 medium + 5 low), adversarial PASS (5
low). All residuals fixed: the plan doc's inverted research/design claim
corrected; the round-2 pin moved inside its describe, retitled to what it
exercises (research re-run + a design opt-out source-pin); the remaining
stale flag comments swept (artifact-convergence throw site, index.ts pilot
edge); the leftover SetupControl import dropped; the test dead-loop and the
revision-gate dead parameter removed. Dispositioned: adv-R2-4 (a stale
epoch file next to an EMPTY journal is already ignored — journal-empty →
fresh epoch in seedRunEpochFromJournal; a non-empty journal from prior
aborted runs counting conservatively is the intended never-re-arm
direction). RED-first final-state counts recorded: `git stash -- src/` →
16 fix-specific tests fail pre-fix across routing-walker /
spec-convergence / artifact-convergence, 58 controls pass; 74/74 restored.

## M3 review record (round 3) — final

Verify-only: **code-reviewer APPROVED; adversarial PASS.** Residuals were
info/low and are fixed: revisionGateFastForward's unused parameter dropped;
the three "flag ON" comment/title vocabulary spots updated to the M3
default-active wording; the M2-era planner describe retitle; the design
source-pin window widened to 1200 chars; and the previously un-pinned
specConvergenceNode fast-forward gained a direct behavior pin (re-entry
after a journaled jump → ok, attempts 0, zero agent calls, FAST-FORWARD
log). Final: 167 files / 2705 passed + 3 skipped; tsc clean; RED-first
final-state re-check across the three files: 17 fix-specific failures
pre-fix, 58 controls pass (75 tests).

## M4 design details (v0.3.8)

**Planner generalization.** planInlineRouteBack drops the pilot `from`
allowlist. Producers that THROW: artifact-convergence
(requirements/bdd/research/design), spec-convergence, and verify
(round-1 M4-H1: verify records its deferred findings into the convergence
ledger BEFORE throwing, so the walker's round-1 injection and decline
fallback both find them — without this the owner re-enters blind).
Implementation does NOT throw: it CONSUMES the vocabulary (the G3 fold —
see below). The single-distinct-strictly-upstream-routable-owner +
per-edge-budget + blocking-only conditions are unchanged (they were always
the safety); the allowlist was only pilot honesty. The thrower never needs
to be addressable — only the TARGET (an upstream convergence node) is, and
all five are (M2 ids).

**Escalation surface (G6).** EscalationChoice gains `"route-back"`;
EscalationFailure gains optional `routeBackOwner` — set by
artifact-convergence when the upstream-owned set holds exactly ONE
routable owner. When set, the interactive options gain
`"Route back to ⟨owner⟩ (recommended)"` FIRST (both soft and hard lists);
mapEscalateChoice maps it to `{ choice: "route-back" }`. The
artifact-convergence decision branch intercepts the choice BEFORE the
retry/accept/abandon handling: plan → throw RouteBackSignal; planner null
(budget) → the replan emulation (bounded restart), and if that also
declines → an honest FatalAbort (never silently degrade a user choice).
applyRetryDecision is untouched — it already acts only on
retry-with-guidance.

**Dismissed/timeout default.** The `!decisionApplied && upstreamOwned`
branch has been inline-first since M3 (headless = no decision = default
route-back); generalizing the planner extends it to research/design
thrown sites. requirements keeps no route (nothing precedes it in
REPLAN_OWNER_STAGES).

**Verify inline-first (blocked-on-decisions).** At the R-3 dead-state
seam, BEFORE maybeTriggerReplan: the deferred findings (which carry
ownerStage — cross-stage ownership is exactly why they were deferred) feed
planInlineRouteBack("verify", …); a command throws RouteBackSignal for the
walker. The replan emulation stays the fallback (multi-owner, budget
exhausted, kill-switch).

**Implementation env-blocker G3 fold.** The judge-override branch now
additionally requires classifyJudgeRoute(verdict.route) === "retry" —
DEFENSE-IN-DEPTH, not tautology removal (round-1 review): the explicit
route check guards against an UNOFFERED retry-classified route
(re-author-tests/challenge-test classify to "retry" but are never offered
at the env-blocker scope), while the classifier agreement pins the shared
vocabulary so route semantics and the override cannot drift apart
silently. Zero behavior change.

**Accepted asymmetries (round-1 review, dispositioned).** (a) The
routeBackOwner OFFER gate is stricter than the planner's: the whole
upstream-owned set must be one routable owner, while the planner filters
routable owners from mixed sets — mixed sets jump headless (the M3
default) but never offer the interactive option; conservative by design.
(b) Verify→upstream sub-walks do not re-execute implementation (the loop
predicate sees the stale allGreen carry) — parity with the emulation's
green-skip carry. (c) offeredChoices persists for every interactive
escalation, not only route-back ones; headless runs omit it (sound).

**MP5 (persisted offered choices).** escalation-report.md records the
routeBackOwner and the offered choice list when route-back was offered, so
a resume/re-read reconstructs the decision surface.

**M4 test additions:** planner-scope pins (research→requirements,
design→bdd, verify→spec); escalation-option pins (offered+recommended
ordering, mapping); artifact-convergence route-back-choice pin (choice →
RouteBackSignal; planner-null → emulation; both-null → FatalAbort);
applyRetryDecision no-op pin; verify inline-first pin; G3
classifier-source pin; report-content pin.

## M4 review record (round 1)

Code-reviewer CHANGES-REQUESTED, adversarial CONTEST. Remediated:
- **M4-H1 (high)** — verify-originated jumps injected zero replan requests
  (deferred findings live outside the convergence ledger): the verify throw
  site now RECORDS the jumped findings into the ledger first (round-1
  injection + decline fallback both find them).
- Missing pins added: applyRetryDecision no-op for route-back; the
  both-decline honest-fatal arm (exercised via the documented __replan
  double-trigger guard — deterministic owner classification routes
  `requirements` without the replan lead, so disabling the lead alone was
  insufficient).
- The intercept pin made RED-discriminating (routeBackOwner + "user chose
  route-back" log asserted AFTER the rejection — stub-internal assertions
  are swallowed by the never-throw escalation, so the old form passed
  pre-fix through the headless default).
- G3 fold comment + doc reworded (implementation consumes, does not throw;
  the fold is defense-in-depth, not tautology removal); router.ts stale
  M1-era comment fixed; option-gate asymmetry and verify-sub-walk
  implementation-skip documented as accepted.

## M4 review record (round 2) — final

**Code-reviewer APPROVED; adversarial PASS.** Residuals fixed:
R2-M4-L1 router docstring reworded (gate()'s escalation path is NOT
unified); R2-M4-L2 the no-op pin now exercises guidance-present +
rollback-eligible inputs and asserts no on-disk user-notes write;
R2-M4-L3/R2-F2 CHANGELOG counts corrected to 12 pins / 12 pre-fix
failures; R2-M4-I1 the honest-fatal test moved inside its describe;
R3-F3 the honest-fatal message no longer hardcodes "edge budget
exhausted"; R2-F1 a behavioral pin proves the H1 ledger recording is
load-bearing (ledger row DF-77 owner=spec blocking=true after the
verify-originated jump); R2-F4 detectedAtStage aligned to the file's
"verification" convention. Final: 168 files / 2719 passed + 3 skipped;
tsc clean; RED-first final-state: 13 fix-specific failures pre-fix, 119 controls pass (132 tests).

## M5 design details (v0.3.9) — the emulation retires for routing

**Interactive decision suppression — DELETED.** In the escalation block
the genuine human overrides are respected first (`abandon` → fatal,
`accept-limitation` → proceed ok); everything else — a user-chosen
route-back, retry-with-guidance, revise-manually, and the headless
no-decision — takes the SAME routing path for upstream-owned blockers.
The run-03-23-47 interactive sibling (user picks retry-with-guidance on
an upstream-owned blocker → the writer retries → oscillates → cap) is
dead: routing is decision-independent. When a retry-with-guidance
decision is in hand on the routed path, the guidance is persisted via
appendUserNotes (the owner reads it at re-entry) — but applyRetryDecision
is NOT called (M4 contract: no worktree rollback on the routed path).

**Emulation retired at the owner-addressable sites.**
artifact-convergence (escalation block + round-cap), spec-convergence
(round-cap + signature-persistence), and verify (blocked-on-decisions)
lose their triggerReplanForFindings calls: inline jump or honest
terminal. A declined jump (budget exhausted / kill-switch / scope) ends
the escalation-adjacent path with an honest FatalAbort naming the edge —
per the plan's out-of-scope note, "the escalation path stays available at
budget exhaustion" (it fired just above), and NO automatic process
restart remains. The walker's decline path loses its
create-new-requests emulation tier the same way (it rethrows the signal —
itself a FatalAbort subclass, G2).

**What legitimately remains of the replan machinery** (the plan's
"audit + cross-run resume record"): (1) the walker's PENDING-ROWS tier —
persisted replan-requests.json rows from an earlier/interrupted run are
consumed by a restart (genuine cross-run resume); (2) the
implementation-RED site (judge route replan-upstream): its finding
carries NO structured ownerStage — the owner is resolved by the replan
LEAD (an LLM call), which the deterministic inline planner structurally
cannot serve; documented as the accepted M5 exception; (3) extension
auto-resume while status=replan, serving (1)/(2) and genuinely
interrupted runs. The maybeTriggerReplan verify wrapper was DELETED
(production-dead after M5); triggerReplanForFindings is the only
production caller's entry (RED site), with its tests exercising the
generalized API directly.

**Owner-less residue disposition (review round-1 R5).** Verify's
deferred findings WITHOUT a structured ownerStage could once be resolved
by the replan lead via maybeTriggerReplan; M5 narrows routing to
structured owners, so owner-less residue surfaces to the
blocked-on-decisions human boundary (the [deferred: …] titles carry it)
instead of an automatic restart. The lead path remains reachable for the
RED-site exception and genuine resume. Accepted narrowing: structured
ownership is the routing contract; unstructured residue is human work.

**Accepted M5 trades (dispositioned).** (a) Kill-switch semantics
change: SUPER_DEV_NO_INLINE_ROUTEBACK=1 now means "no automatic
route-back" (escalation surface / honest fatal) instead of
"byte-identical emulation" — G8's flag-off≡pre-change promise is
superseded by completion (the flag-on vs flag-off STRUCTURAL equivalence
tests survive; the kill-switch planner-null pin survives). (b)
Multi-owner routable sets still decline (single-owner planner is the
pinned safety): verify's multi-owner deferred residue lands on the
blocked-on-decisions human boundary instead of an auto-restart; the
sequential most-upstream-owner jump is a documented follow-up, not M5.
(c) Budget-exhausted persistence loops end at the human boundary rather
than borrowing the emulation's extra bounded restarts — one bounded
mechanism (per-edge journal budget) instead of two.

**M5 test additions/updates:** suppression-deleted pin (retry-with-
guidance on an upstream-owned blocker STILL throws RouteBackSignal);
abandon/accept-limitation respected; headless declined → honest fatal
with NO __replan marker and NO replan-requests.json write; walker
decline → signal rethrow (emulation tier gone) while the pending-rows
tier still restarts; spec-convergence kill-switch pin updated to the
honest cap fatal; verify maybeTriggerReplan deleted (source pin) with
multi-owner → dead-state; implementation keeps exactly one
triggerReplanForFindings call (source pin).

## M5 review record (round 1) — residuals fixed

**Code-reviewer CHANGES-REQUESTED, adversarial CONTEST — both verified the
behavior correct** (suppression fully deleted with abandon/accept-limitation
the complete respected-override set; the escalation-budget gate conditions
only runEscalation, never routing). Residuals remediated:
- Stale "byte-identical emulation" claims rewritten (walker header + the
  kill-switch comment; the plan's cross-cutting invariants and M1-era
  kill-switch line are historical records of the pre-M5 contract and the M5
  design section supersedes them).
- maybeTriggerReplan DELETED (production-dead) — its tests retargeted at the
  generalized triggerReplanForFindings.
- Walker decline pin's tautological assertion replaced with the concrete
  RouteBackSignal name check.
- The honest-fatal message no longer overclaims ("offered when available").
- Owner-less-residue narrowing dispositioned in code + doc (structured
  ownership is the routing contract; owner-less residue is human work).
- Unused isRouteBackSignal import dropped from artifact-convergence.
Final: 168 files / 2724 passed + 3 skipped; tsc clean; RED-first final-state:
9 fix-specific failures pre-fix, 109 controls pass.
