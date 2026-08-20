# Full-Read Reference Study — All docs/references Repos

Status: analysis (reference study — no implementation in this commit)

Method: full read-through of every reference repo's documentation, architecture
notes, agent-instruction files, prompts, and the most relevant source modules
(not commit deltas): deepseek-harness (README, AGENTS.md, architecture.md,
docs/AGENTS.md, .agents/notes/README.md, defensive-patterns.md, testing.md,
subsystems/core.md, subsystems/agent-team.md, guard/repeat-tool-reminder source,
dsh-code-review + dsh-prose-standard skills), codex (review rubric, goals
completion-audit, compact, gpt-5.2 main prompt, core README), swe-agent (ACI,
architecture, templates, demonstrations), astryx (README, .github/instructions),
cumora (previously deep-analyzed + this cycle's 30 fix commits read in full),
cordiverse-paper (revertible-effects formalization), orange-book (structure +
user-perspective chapters). Companion to harness-research-and-v0.3.0-architecture.md.

## Part 1 — deepseek-harness (the richest transfer source)

### 1.1 Agent Notes: gate-enforced design-doc lifecycle

`.agents/notes/` holds 1,451 design notes, and the whole system is enforced by
deterministic gates (`verify-agent-note-format`, classification tree gate,
`verify-archived-agent-notes` with hash manifests):

- Path-encoded lifecycle × class: `proposed|implemented|rejected` ×
  `feature|bug-fix|simplification|architecture|process|testing`. The gate
  rejects other folders.
- Each lifecycle has a canonical skeleton. The gate **rejects proposal-speak in
  implemented notes** (`## Proposal`, `## Plan`, `## Acceptance criteria` may
  not appear; Decision is present tense).
- **Implemented notes are kept current with what shipped** — when code moves a
  file/renames a package/changes a default, the note updates in the same PR.
  Doc drift is not tolerated; it is gate-audited (via type-equiv anchors, below).
- **Alternatives considered is mandatory**: "a decision recorded without what
  it beat invites re-litigation — the failure Agent Notes exist to prevent."
- **Never edit a note into a different decision** — supersede with a new note,
  cross-link both, consolidate only under strict rationale-preservation rules.
- Frozen archive: sealed triplets (en/zh/sidecar), append-only manifest, never
  edited, never authority for current behavior.
- Rejected notes are kept only while they prevent a plausible mistake.

Mapping to us: our docs-contracts Status line is a seedling of this. The full
system upgrades our plan docs and stage docs at once — see F-R5.

### 1.2 The deterministic doc↔code gate family

Beyond verify-type-equivalence (already cited in the v0.3.0 research), the full
read surfaced the complete family and its philosophy:

- `verify-md-links` — every cross-reference is a relative Markdown path; dead
  targets and dead `#fragment` anchors fail the build.
- `verify-doc-budgets` — word ceilings per standing doc (root AGENTS.md ≤1600,
  architecture ≤1800…), with a documented escalation ladder (relocate →
  condense → raise-with-justification).
- Generated catalogs (tool/config/persistence/module-graph) are freshness-gated:
  a stale generated region fails doc-sync.
- The **slop checklist** is a named, auditable list: same rule in two homes;
  narrated history ("previously/now/no longer"); implementation-status
  annotations; hand-restated catalogs; reasoning transcripts; paragraph walls;
  emphasis inflation; spec-speak in implemented notes.
- "Match evidence to the surface: focused tests for behavior, snapshots for
  model output, doc-sync for docs, build/hygiene for published paths, real-API
  e2e for provider behavior. Never default to the full suite."

### 1.3 The reviewer/gate division of labor, stated explicitly

From dsh-code-review SKILL: "**omit issues already enforced by a green gate**";
"This skill is guidance, not a complete checklist"; "a short review with one
substantiated blocker is better than a list of nits"; "Treat disagreement with
an Agent Note as a design discussion, not an automatic veto"; test-strength
review ("assertions fail on the intended regression… never trusting an agent's
report"); "follow every denial path to the operation that executes it".

This is the missing sentence in our reviewer prompts: run 06-19's four-round
death spiral was reviewers hand-simulating a filename-allowlist check that a
gate should own. Reviewers must be told what gates already own so they spend
their semantic attention where nothing else can.

### 1.4 repeat-tool-reminder: a production loop-hygiene guard

Advisory per-agent repeat-call detector, escalation thresholds [3,5,8]:
gentle reminder first, then detailed reminder naming tool + run length +
canonical arguments. Mechanics worth copying:

- Chain key = (tool name, deep-key-sorted canonicalized arguments). Property
  order never defeats detection.
- Observe-and-enrich, never veto — the reminder rides both allowed and blocked
  decisions.
- **Denied calls count too** — "a model hammering a denied call is exactly the
  loop worth breaking."
- A user interjection resets the chain: repetition across human input is not a
  loop.
- Preview-capped arguments in the reminder; the detection key always compares
  the full canonical string.

### 1.5 Waterfall arbitration for recovery ownership

`agent/request-error` is a waterfall where **a listener that owns recovery
returns `{kind:'retry'}` without calling `next()`**; the default `undefined`
leaves the failure terminal. First owner wins; everyone else delegates. This is
a clean general shape for our classifier/judge/escalation arbitration — better
than chained if-branches: each recovery owner is an independent listener that
either claims the failure or delegates.

### 1.6 Event-sourced coordination state (foldTeam)

Agent Teams derives roster, task board, and mailbox **by replaying the root
session log** (`foldTeam()`); nothing coordination-related is stored outside
the log. Specifics:

- Durable mailbox = queued-minus-delivered: a message is acknowledged only
  after its target's inbox item or user message is durable; recovery = replay
  minus delivered.
- Target-side dedup by folding the message source (id + sender) across inbox
  and history.
- Task DAG with compare-and-set `revision` incrementing per mutation;
  `blockedBy` must stay acyclic and name non-deleted tasks.
- `writeScopes` are advisory path prefixes, not locks.
- `interrupt` cancels the turn without clearing the inbox.

This is the architectural answer to our confirmed defect (run 05-09-21-800Z:
in-memory convergence-ledger routing lost on resume). We already persist
events.jsonl per spec dir — the ledger should be a fold over it.

### 1.7 Testing doctrine (worth adopting verbatim where it names our rules)

- "Verify the world, not the self-report: an e2e assertion re-runs the command
  or re-reads the file externally; a keyword probe on the agent's own output
  lets a cheating agent pass."
- "A guard only guards if the regression actually fails it: introduce the
  regression, watch red, revert." (Our RED-first discipline, stated better.)
- "An uncovered line is often dead code the gate is correctly flagging for
  deletion."
- "A no-key test proves plumbing; only a with-key run proves the agent works"
  — with self-skipping with-key suites so keyless CI stays green. (Inference
  is cheap for them; for us this legitimizes the shape-dual real-model tier.)
- Snapshot policy: one scenario pins full prompt content; all other fixtures
  tokenize it so an edit churns one line.

### 1.8 Defensive patterns (each names a shipped bug class)

Report orthogonal outcomes independently (timeout AND exit 0); honor public
contracts on both sides (normalize before returning); async state is not
synchronous state (`whenIdle` is not the settlement of any particular message;
handle "nothing to wait for" explicitly); dispose must reach quiescence (kill →
await exit; close listeners before killing); contain callback exceptions in the
dispatcher; scrub env for spawned commands; unlink link-shaped paths.

### 1.9 Other standing rules with direct mappings

- "Misconfiguration fails loud at the earliest resolvable point; never silently
  skip a missing referent." → names our spec-stage deliverable pre-flight.
- "Model-visible ⟺ logged: anything that reaches a model request must be
  reconstructable from the session log; a runtime invariant asserts it."
- "No hardcoded tunables in plugins" (DEFAULT_* is not configurability).
- Postmortems are a first-class doc tier (incident → causal chain → prevention).
- Orange-book (user perspective) confirms the failure class we must avoid:
  composition errors fail silently ("stuck at loading, no signal") — no
  indefinite silent waits anywhere.

## Part 2 — codex

### 2.1 The review rubric (directly liftable)

The production reviewer prompt is a calibrated finding filter:

- 8-point is-it-a-bug test, including: "fixing it does not demand rigor not
  present in the rest of the codebase"; "the bug was introduced in the commit
  (pre-existing bugs should not be flagged)"; "no unstated assumptions about
  intent"; "**not enough to speculate that a change may disrupt another part of
  the codebase — one must identify the parts that are provably affected**";
  "clearly not just an intentional change".
- Comment discipline: one paragraph, matter-of-fact, no flattery, code chunks
  ≤3 lines, severity honestly communicated.
- Output-all-qualifying-findings but **"if there is no finding a person would
  definitely love to see and fix, prefer outputting no findings."**
- Priority vocabulary P0–P3 with fixed semantics — P0 "only for universal
  issues that do not depend on any assumptions about the inputs"; numeric
  priority field + per-finding confidence_score in the JSON.
- A separate `overall_correctness` verdict that explicitly ignores non-blocking
  nits (style, formatting, typos, docs).
- Rule attribution with anti-fabrication ("do not fabricate citations").
- Deduplicate findings by changed location and defect/remedy.

### 2.2 The completion audit (goals continuation prompt)

Production text for exactly our verify/final-gate semantics: "treat completion
as unproven"; "derive concrete requirements… for every explicit requirement,
identify the authoritative evidence that would prove it, then inspect current
state"; "match the verification scope to the requirement's scope; do not use a
narrow check to support a broad claim"; "treat uncertain or indirect evidence
as not achieved"; "do not substitute a narrower, safer, smaller,
easier-to-test solution because it is more likely to pass current tests"; "an
edit is aligned only if it makes the requested final state more true"; "the
audit must prove completion, not merely fail to find obvious remaining work".
Also budget-exhaustion behavior: "do not start new substantive work — wrap up
this turn, summarize progress, leave a clear next step."

### 2.3 The main agent prompt (80 lines for a frontier model)

Brevity discipline again; plus two hard rules our implementer prompts lack:
- Dirty worktree: "NEVER revert existing changes you did not make… if there
  are unrelated changes, don't revert them; if unexpected changes appear, STOP
  IMMEDIATELY and ask."
- Findings-first review default with explicit no-findings statement including
  residual risks.
- Plan tool: skip for the easiest ~25%; no single-step plans; update after
  each completed subtask.

## Part 3 — swe-agent

- **ACI design principles** (paper-validated): a linter runs on every edit and
  invalid edits do not apply (the ancestral form of pre-write validation);
  100-line file viewer window; search lists matching filenames only (more
  context per match "proved too confusing"); empty output gets an explicit
  "ran successfully, no output" acknowledgment.
- **Format-error handling with history rewrite**: on a malformed response, a
  format-error template is shown; if the next response is correct, the
  message history is updated so the format-error turn is not kept; two
  consecutive malformed responses terminate the episode.
- **Demonstrations as curated trajectories**: completed runs converted to
  editable YAML demos, replayable (`run-replay`) to verify they still work —
  few-shot from real episodes rather than invented examples.
- The project's own headline lesson: superseded by mini-swe-agent (same
  performance, much simpler) — third independent confirmation of our
  no-new-panels non-goals.

## Part 4 — astryx

- Path-scoped instruction files (`.github/instructions/*.instructions.md` with
  `applyTo:` globs): review instructions load contextually per file class —
  "one home per fact" applied to agent instructions.
- **Accuracy gate**: "verify every checkable claim against the current branch;
  one confirmed verifiable error is blocking" — and unverifiable claims do not
  gate, they are marked "needs confirmation". Reviewers with repo access are
  told to grep the source "rather than trusting the prose".
- Triage by blast radius: shared-component diffs get the standard path,
  contained single-page diffs the fast path; the reviewer states the triage.
- "Do not detect AI vs human — judge observable writing quality." Verdicts
  must be verifiable and actionable.
- Repo-header SYNC CONTRACT: "Architecture changes require documentation
  updates" — doc-sync as the stated contract.

## Part 5 — cumora (30 new fixes, read in full)

Process-machinery lessons already folded into the v0.3.1 hardening slice: RPC
deadlines ("a fetch that never settles cannot be caught"), teardown symmetry
(one lifetime AbortController; settle aborted children on `exit` not `close`;
`if (signal.aborted) onAbort()` right after listener registration), stream-json
line-carry across pipe chunks + StringDecoder + flush-at-close (silent JSON
loss → usage under-reported, session-id sniff misses, next spawn without
resume = context loss), clean-EOF backoff (ladder resets only after a
connection stayed up), truncation accounting (per-source budgets, announce
every eviction with its exact count — "dropping unread in silence is what makes
the loss unrecoverable"), shim stdout write-completion exit, handshake-failure
teardown (a rejected handshake must not leave a live child posting as the
agent), anchored kill predicates.

## Part 6 — cordiverse-paper + orange-book

- Cordis formalizes **revertible effects** (every context transformation
  carries a runtime-tracked inverse) and **reactive coeffects** (dependency
  declaration with reactive resolution) — the theory under our replan
  full-invalidation (coarse-grained inverse) and STAGE dependency graph.
- Orange-book (non-coder's full walkthrough of dsh): cost accounting read from
  the session log line-by-line (validates the per-call cost ledger backlog);
  the silent-failure theme (mis-composed plugin stuck at loading with no
  signal) — liveness signals on every wait.

## Part 7 — Synthesis: what changes in the plan

Our core diagnosis is unchanged (semantic claims in artifacts are
machine-checkable but unchecked until implementation; feedback addresses
sites, not classes). The full read adds four structural inputs:

1. **The division of labor must be explicit in the prompts** — gates own the
   mechanically checkable; reviewers own the semantic and are told to omit
   what gates enforce (dsh) and to prefer no findings (codex). Our moving-target
   deaths came from reviewers doing gate work by hand.
2. **The review rubric is a solved problem** — Codex's filter + priorities +
   confidence + separate overall verdict is a production-calibrated answer to
   severity inflation and speculative blockers; adopt, don't invent.
3. **Coordination state should be event-sourced** — dsh's foldTeam proves the
   pattern at production scale; our in-memory ledger is the known defect.
4. **Doc lifecycle itself is gateable** — skeletons, spec-speak rejection,
   kept-current anchors, alternatives mandate. Our plan docs' line-number
   anchors drift because nothing checks them; symbol-anchored equivalence
   checking is the fix.

## Part 8 — The refined complete 0.3.x plan

(F-numbers extend the WS-x set from harness-research-and-v0.3.0-architecture.md.)

### v0.3.1 — Class-aware feedback + reviewer rubric + critical spawn hardening

1. F-WS2 defect classes + class-sweep directive (as designed), with cumora
   truncation accounting in compactReviewFindings (per-finding budgets, every
   eviction announced with its count).
2. F-WS3 derivation standing rule (as designed).
3. **F-R1 reviewer rubric adoption** — port into buildUpstreamReviewPrompt /
   buildSpecReviewPrompt: the 8-point bug filter (esp. provable-impact-only,
  pre-existing-excluded, rigor-matching); P0–P3 vocabulary with fixed
   semantics (P0 only assumption-free universal defects); per-finding
   confidence (schema field exists — make reviewers emit it); no-findings
   calibration ("prefer no findings over nits"); dedupe by location +
   defect/remedy; "omit issues a deterministic gate already enforces — the
   gate list is included in the prompt so the reviewer knows what is owned."
4. **F-R2 implementer hard rules** — dirty-worktree discipline ("never revert
   changes you did not make; unexpected foreign changes → stop and report, do
   not fix around them") into implementer prompts.
5. Cumora-critical subset for the v0.3.0 RPC layer: abort-check-after-register,
   exit-not-close settle, line-carry + flush-at-close verification, RPC
   deadlines with busy-release.

### v0.3.2 — Contract-Claims Layer (dsh verify-* pattern, adapted)

1. F-WS1 design-stage contracts gate (as designed; the enumerated-closure
   check is exactly dsh's type-equivalence discipline applied to design
   artifacts).
2. F-WS4 spec-stage deliverable pre-flight ("fail loud at the earliest
   resolvable point; never silently skip a missing referent" is the design
   principle, now with its name).
3. AC verifiedBy classification + BDD boundary lint (as designed).
4. **F-R5 doc-lifecycle gates (Agent-Notes-style)**: extend docs-contracts —
   lifecycle skeletons for plan docs; gate-reject spec-speak in
   `Status: implemented` docs ("should", migration plans, acceptance
   checklists); alternatives-considered required; **symbol-anchored
   verification**: plan docs cite source symbols (function/type/export names)
   not line numbers, and a gate checks the symbols still exist with the cited
   shape (killing anchor drift mechanically).

### v0.3.3 — Event-sourced ledger + cross-run classes + env-keyed validity

1. **F-R3 event-sourced convergence ledger** — convergence state becomes a
   fold over the spec dir's events.jsonl (foldLedger, mirroring foldTeam):
   resume-durable, replay-reconstructable, dedup by finding fingerprint folded
   across rounds. The 05-09 in-memory-routing-loss class dies permanently.
   (Paired with model-visible ⟺ logged: everything a writer sees in retry
   feedback is reconstructable from the log.)
2. F-WS5 cross-run defect-class ledger + summary-stage promotion suggestion
   (as designed).
3. F-R6 environment-keyed resume validity (as designed; codex's
   sandbox-level-in-cache-key is the same principle).
4. **F-R4 completion audit in verify** — port the codex completion-audit text
   (evidence-per-requirement, scope-matching, uncertain-evidence-is-not-
   achieved, no-narrower-substitution) into the verify prompt and
   finalSafetyReReview; budget-exhaustion = graceful wrap-up, never mid-work
   abort.
5. Optional then-or-later: with-key real-model smoke tier (self-skipping,
   shape-dual converges/holds-firm benchmark promoted from backlog P-06).

### Non-goals (reconfirmed by three independent sources)

No reviewer panels, no new loops, no topology changes, no self-applied harness
mutations, no scenario examples in standing prompts (shape-level rules only —
cumora; demonstrations-as-trajectories is a separate SWE-agent mechanism, not
adopted for standing prompts).

### Sequence

v0.3.1 (feedback + rubric + spawn hardening — small, immediate) → v0.3.2
(contract-claims + doc-lifecycle gates) → restart spec-07 (design converges
round 1–2 with the gate enumerating the whole class) → v0.3.3 (event-sourced
ledger + verify audit) after the restart is healthy. Every version under the
full discipline: plan doc, RED-first tests, dual code-reviewer +
adversarial-reviewer, version bump set, CHANGELOG, commit.
