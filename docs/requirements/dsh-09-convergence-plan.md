# dsh-09 — Convergence Plan v2: verified, atomic, testable

Status: PROPOSAL v2 — rewritten after code-level verification pass. Awaiting user approval.
Version baseline: 0.1.74.
Supersedes: the first draft of this file (three of its claims were wrong — see §0).
Inputs: dsh-00..dsh-08, `agent-team-runtime.md`, `graph-engineering.md`, the loop-line docs (all implemented), plus a full verification pass over `src/nodes.ts`, `src/stages/*.ts`, `src/workflow.ts`, `src/render/*.ts` and existing specs 22/23/24.

---

## 0. Corrections from the v1 draft (why v2 exists)

The v1 draft was written from memory of the research docs. Code verification disproved three claims:

1. **"BDD ∥ Research is dependency-free parallelism" — WRONG.** `buildResearchPrompt` (`src/prompts.ts:164-165`) reads `state.bdd` and instructs "Read the Requirements and BDD Scenarios docs above first, then derive the 2-4 research questions". Research deliberately consumes BDD. Parallelizing would degrade research-question derivation (BDD adds edge-case structure beyond the requirements ACs it is derived from). v2 demotes this to an optional experiment behind a config flag (§5).
2. **"Add parallelism to the review fan-out" — ALREADY DONE.** `reviewStep = parallel([...])` (`src/stages/verify.ts:633`) already runs code-review + tests-review + adversarial-review concurrently, and api/ui tests likewise (`verify.ts:1082`). The pipeline is already parallel where it matters.
3. **"Build the runtime-change-replan protocol" — 80% ALREADY EXISTS.** Spec 22 (`docs/specifications/22-runtime-instruction-replanning/`) is implemented: `runtimeInstructionFingerprint` (`src/stages/implementation.ts:644`) + start/end fingerprint comparison (`:847-856, :1843-1856`) invalidates already-green phase carry when instructions change mid-run. AND `.user-notes.json` is injected into EVERY subsequent agent prompt (`src/workflow.ts:311-313`), so not-yet-run stages already see new instructions. The only genuinely missing piece is *recording* instruction events for observability. v2 cuts D5 down to that.

Additional verified facts the plan builds on:

- `auditAppend` infrastructure exists (per-run `~/.super-dev/runs/<ts>/audit.jsonl`, best-effort, never throws — `src/render/super-dev-dir.ts:104-112`).
- The **spec dir is already the durable-state home**: `.knowledge.json`, `.user-notes.json`, `change-tracker.jsonl`, `.judge.jsonl` all live there. A new `events.jsonl` fits the established pattern (`.judge.jsonl` at `src/stages/judge.ts:186` is the direct precedent).
- `task()` (`src/nodes.ts:158-226`) already emits stage events + audit entries at stage granularity; `realAgent` (`src/workflow.ts:~295-340`) is the single agent-granularity choke point; `runBuildGate`/`runRedCheck` are centralized functions (edit once, not per call site).
- 27 stage ids are statically enumerable from `src/stages/*.ts` — an invariants contract test needs no runtime magic.
- `parallel()` has a duplicate-id guard and sibling-cancellation (`src/nodes.ts:310-352`) — safe for the optional experiment.
- OTel GenAI semantic conventions exist (Development status: spans `create_agent`/`invoke_agent {name}`, attributes `gen_ai.operation.name`, `gen_ai.provider.name`, `gen_ai.agent.name`…). Our ledger is a durable run log, not telemetry — we keep a simple envelope but name fields so a future OTel bridge is a mechanical mapping.

## 1. What the converged research actually supports

Four lines, one foundation each contributes to:

| Line | Verified contribution | Plan element |
|---|---|---|
| dsh-03 (SessionEvent log) | One append-only ledger; consumers are folds; "model-visible means logged"; projections with watermarks | P1 ledger |
| dsh-06 (process) | Decision-record lifecycle; postmortem → named rules; package-owned invariants + mechanical completeness gate | P0, P1.7 |
| agent-team-runtime (IMACS/bMAS/CodexLoom) | WHO/HOW/ALGORITHM split; RACI; blackboard-as-events; messages with causality + closure pressure | P2, P3.1 |
| graph-engineering | "Which dependencies are real vs habitual"; explicit edges; local failure isolation | P3.3 edges table |
| Loop line (ours, implemented) | The verification spine (gates/judge/stagnation/triage) — the asset to keep unchanged and make event-emitting | P1.2-1.5 |

Anti-scope (unchanged from dsh-08 §4, re-confirmed): no plugin substrate, no runtime HMR, no free-form agent chat, no adaptive routing (needs ledger telemetry first), no LangGraph-style reducers (sequential joins serialize appends), no stage-level context compaction (subprocess-per-stage already isolates context).

## 2. The atomic plan

Conventions for every commit: full typecheck (`npx tsc --noEmit`), affected suites + FULL suite with vitest's own exit code captured (no unguarded pipes — defensive rule #1), version bump in `src/version.ts` + `package.json` + `package-lock.json` + `tests/version.test.ts` in the same commit (AGENTS.md rule), one logical change per commit.

### P0 — Process foundations (docs + one tiny code commit; zero pipeline risk)

**P0.1 Postmortem 0001 + defensive-patterns doc** — docs only.
- Files: `docs/postmortem/0001-r5-validation-pipe.md` (the R-5 liveness ship: root cause, the two trigger commits 585f50da/a17f5e6c, fix rule), `docs/defensive-patterns.md` with the five verified rules: (1) validation exit codes come from the tool, never the pipe; (2) never strict-compare LLM-typed booleans — normalize at the boundary (toBool precedent); (3) a change that can empty a loop's termination driver ships with a liveness test of the emptied state; (4) whole-output regex extraction answers "mentioned", never "failed"; (5) env config is read lazily, never captured at module import (two incidents).
- Test: new `tests/docs-contracts.test.ts` — asserts both files exist; defensive-patterns contains ≥5 numbered rules; postmortem has Root cause/Impact/Rule sections.
- Version bump: yes (repo rule: any change to the extension's docs that tests assert on; keep consistent).

**P0.2 Plan-doc status lifecycle** — docs only.
- Add `Status:` line to every `docs/requirements/*.md` (proposed | approved | implemented (<commit>) | rejected (<reason>) | superseded-by (<doc>)); write the first two rejection notes (`docs/requirements/rejected-2026-08-16-escalate-retry-vs-direct-fatalabort.md`, `rejected-...-deferred-lists-in-reviewer-prompts.md`) from the recorded decisions.
- Test: extend `tests/docs-contracts.test.ts` — every `docs/requirements/*.md` has a `Status:` line matching the enum.

**P0.3 Loop vocabulary page** — docs only.
- `docs/loop-vocabulary.md`: step / turn / attempt / round as used by THIS pipeline (RED try, impl attempt, convergence round, review round), the named loop exits (`__stagnated`, dead-state break, ROUND CAP, no-progress, budget-exhausted, oscillation) with the file:line each fires from, and the dsh turn/step/round mapping for cross-reference.
- Test: docs-contracts asserts the page lists all 6 exit names (grep) — cheap drift guard.

**P0.4 Degraded-boot diagnostics** — one small code commit.
- New pure function `summarizeDegradedBoot(cfg, env)` in `src/workflow.ts` (or a tiny new `src/boot-diagnostics.ts`): returns lines for each degraded subsystem — judge disabled (`SUPER_DEV_DISABLE_JUDGE`), baseline disabled (`SUPER_DEV_DISABLE_BASELINE_CHECK`), research forced to subprocess backend with its effective model, wrap-up unavailable, any agentModels entry pointing at a host-session-only provider for a subprocess-forced role (the v0.1.66 class, detectable statically from config + the WEB_RESEARCH_AGENTS list).
- Wire: `extension.ts execute()` logs the lines after makeContext, before pipeline start.
- Test: `tests/boot-diagnostics.test.ts` — env-flag combos → exact expected lines; empty case → no lines; never throws.

### P1 — Event ledger (the foundation; every later phase consumes it)

**P1.1 Ledger core** — new module, no wiring yet.
- `src/runlog.ts`: `RUN_LOG_VERSION = 1`; `interface RunEvent { seq, time, runId, stage?, agent?, type, data }`; `appendRunEvent(specDir, evt)` (reads last line for next seq — single-process appends, joins serialize; mkdir best-effort; never throws, mirrors auditAppend semantics); `readRunEvents(specDir)` (tolerant of a torn last line); `foldEvents` helper.
- Event type registry (string-literal union + per-type payload interfaces): `run.started/completed`, `stage.started/completed/failed/skipped`, `agent.called` {agent, model, backend, durationMs, control, error?}, `gate.checked` {gate, pass, ran, errors≤2000ch}, `judge.called` {scope, route, status}, `escalation.raised/resolved` {stage, kind, message≤1000}, `message.sent/replied`, `instruction.received` {text≤2000}, `topic.snapshot`.
- Test: `tests/runlog.test.ts` — append/read roundtrip; seq monotonic across multiple appends; torn-line tolerance (write half a JSON line, read skips it); empty/undefined specDir no-ops; RUN_LOG_VERSION in first event.
- Note: naming kept simple and stable; a future OTel bridge maps `agent.called`→`invoke_agent`, `stage.*`→workflow spans mechanically.

**P1.2 Stage events** — wire `task()`.
- `src/nodes.ts task()`: after the existing `auditAppend`, call `appendRunEvent(state.setup?.specDirectory, {type:'stage.started'...})` and `stage.completed/failed/skipped` with `{durationMs, error?}`. One edit site; audit.jsonl keeps working (dual-write during transition, per OQ1).
- Test: extend `tests/nodes.test.ts` — run a task with `state.setup.specDirectory` set to a tmp dir; assert events.jsonl contains started+completed with correct stage id; skipped path emits skipped; no specDir → no file, no throw.

**P1.3 Agent events** — wire `realAgent`.
- `src/workflow.ts realAgent` finally-block: append `agent.called` with agent role, resolved model, backend, durationMs, control object (as audit does today — structured, bounded by schema), error tail ≤500ch.
- Test: extend `tests/workflow.test.ts` with a scripted agent; assert one `agent.called` event per call with correct role/model/backend; control null on failure still records.

**P1.4 Gate events** — wire the two centralized runners.
- `runBuildGate` (`src/build-runner/gates.ts`): append `gate.checked` on every return path (pass/fail/ran-empty). One function, all five call sites inherit. Same for `runRedCheck`. specDirectory threading: gates know cwd only — thread via new optional opt (the B-6 defaultBranch precedent; call sites already have state.setup).
- Test: extend `tests/red-oracle.test.ts` + `tests/baseline-verify.test.ts` — oracle runs produce gate.checked events; no-specDir (unit tests) stays silent.

**P1.5 Judge events** — dual-write.
- `src/stages/judge.ts` where `.judge.jsonl` appends (`:186`): also `appendRunEvent` type `judge.called`. `.judge.jsonl` unchanged (compat).
- Test: `tests/judge.test.ts` extension — runJudge with tmp spec dir produces both files; event data matches the jsonl entry.

**P1.6 Replay proof** — the P1 acceptance test.
- Test: `tests/runlog-replay.test.ts` — run the existing mini-pipeline harness (workflow.test.ts style, mocked agents, tmp spec dir) end-to-end; then (a) fold events → per-stage status map equals `ctx.results`; (b) seq strictly monotonic; (c) every agent call has exactly one agent.called; (d) re-running the fold is deterministic (pure function).
- This single test pins the ledger's core promise: postmortems become `jq` queries; nothing needs resume-cache archaeology.

**P1.7 Invariants registry** — the dsh-06 pattern, sized for us.
- `src/invariants.ts`: `interface InvariantCheck { stageId, name, check: (events, state) => {ok, detail} }` + `NO_INVARIANT(stageId, reason)` marker + `registerInvariants()` called once at workflow start collecting checks from stage modules. Checks are pure folds over the ledger + final state — the incident list becomes checks: (1) merge.merged===true ⇒ a gate.checked(pass) or dedicated merge-verified event exists (the "true"-string class); (2) implementation allGreen ⇒ every phase's last gate.checked pass (dead-gate class); (3) run.completed ⇒ every started stage has a terminal event (the R-5 emptied-loop class); (4) escalation.raised ⇒ message present in run summary; (5) agent.called with error ⇒ next event is a retry/stagnation/escalation (no silent swallow).
- Runner: workflow finally-block; failures → loud `❌ INVARIANT` log lines + run summary section (not throw — diagnostics; the mechanical contract test below is the enforcement).
- Contract test: `tests/invariants-contract.test.ts` — grep stage ids from `src/stages/*.ts` (`id: "..."`), assert every id is either registered or has an explicit `NO_INVARIANT` with a non-empty reason. This is the dsh "explain-or-assert" discipline; a new stage cannot ship unwatched.
- Tests: unit tests per check (feed synthetic event streams — pass and fail shapes).

### P2 — Team layer (WHO; static validated config, no LLM)

**P2.1 Team + RACI module.**
- `src/team/types.ts` (Profile: identity/domain/scope/inputs/outputs/escalation), `src/team/default-team.ts` (6 owners: requirements, design, implementation, verification, docs, release — the deliverable-shaped set; the 11-role split deferred until a spec exercises it), `src/team/raci.ts` (deliverable→{R,A,C,I} map over the 8 rendered docs + implementation phases + merge; `validateTeam()` — exactly one A per deliverable, all owners exist in profiles, no orphan deliverables).
- Test: `tests/team.test.ts` — happy path validates; duplicate-A fails; unknown owner fails; missing deliverable fails; profiles structurally complete (every field non-empty).

**P2.2 Setup integration + event.**
- `setupStage`: call `validateTeam(defaultTeam)` — failure is fatal (fail-loud, dsh boot-audit pattern); log "Team OK: 6 owners"; append `team.configured` event (owner list + RACI digest).
- Test: extend `tests/setup.test.ts` — valid team passes; sabotaged team (test injects duplicate-A) aborts the run; event present.

**P2.3 Topic projection.**
- `src/runlog/projections.ts`: `deriveTopic(events)` → `{specId, lastBrief, openMessages[], needsYou[], owners}` — pure fold; `writeTopicSnapshot(specDir)` writes `topic.json` (human-readable cache; regenerable, never authoritative).
- Test: `tests/topic-projection.test.ts` — synthetic streams (messages sent/replied, escalations) → correct open/closed partition; byte-identical rebuild from same events (the P1.6 determinism promise at projection level); snapshot file matches fold output.

### P3 — Messages + edges (HOW + graph data; honest scope after spec-22 discovery)

**P3.1 Team messages with causality and closure pressure.**
- Message = ledger event `message.sent` {id, senderRole, receiverRole, kind: request|reply|notify, requiresResponse, subject, body≤4000, artifactRefs, inReplyTo?} + `message.replied` referencing id. Append-only; delivery at the next checkpoint: `messagesForAgent(specDir, role)` renders unanswered messages addressed to a role into that agent's prompt (new block in `realAgent` prompt assembly, beside the existing user-notes injection — same checkpoint mechanics, `src/workflow.ts:303-313` precedent).
- Closure pressure: `deriveTopic` marks `requiresResponse` messages unanswered after the receiver's stage completed → `message.overdue` surfaced in Needs-You/escalation prompt (the agent-team-runtime closure requirement, mechanically enforced).
- First senders: escalations (judge no-progress, stagnation) message the accountable owner per RACI — replacing nothing, adding a durable, addressed record alongside the existing HITL prompt.
- Test: `tests/messages.test.ts` — send/reply lifecycle; delivery lands in receiver prompt exactly once (scripted-agent workflow test); overdue detection after stage completion; reply closes it.

**P3.2 Instruction events (the honest remnant of D5).**
- At the drain point (`realAgent` → `appendUserNotes`), also append `instruction.received` {text≤2000, source}. Spec-22's fingerprint invalidation already handles correctness; upstream stages already see notes via prompt injection. Classification (none|hint|requirement|…) and upstream-stage invalidation are deferred until ledger telemetry shows a real miss — recorded as a rejection note with that reason (P0.2 mechanism), not silently dropped.
- Test: workflow-user-steer.test.ts extension — typed instruction produces exactly one instruction.received event.

**P3.3 Dependency-edges table (graph-engineering's concrete landing).**
- `src/graph/edges.ts`: static `const EDGES: {from, to, rationale}[]` for the 27-stage skeleton, derived from the VERIFIED prompt reads (the §0 corrections table is its source of truth: bdd←requirements; research←requirements,bdd; debug←requirements,research; assessment←research,debug?; design←requirements,research,assessment; spec←requirements,bdd,research,assessment,design,prototype; …).
- Test: `tests/graph-edges.test.ts` — (a) every non-setup stage has ≥1 inbound edge; (b) acyclic (topological sort succeeds); (c) spot-check three edges against actual prompt signatures (the test greps `buildResearchPrompt` args — a build-time tripwire if someone adds a dependency without updating the table, exactly the drift class the edges table exists to prevent).
- Consumers now: docs render (README architecture section input, feeds P4.1) + topic projection context. Future consumer: any replan widening.

### P4 — Generated docs (kills the README-rot class)

**P4.1 Env registry + generated tables.**
- `src/env-registry.ts`: single source `{name, default, description}` for the 15 SUPER_DEV_* vars (grep-verified against source; test cross-checks count).
- `scripts/gen-arch-docs.ts`: emits README sections between `<!-- BEGIN GENERATED arch -->` markers — stage table (from stage exports + edges), env-var table (from registry), agent-role→backend→model-resolution table (from resolveAgentModel inputs). `tests/arch-docs.test.ts` runs the generator in-process and asserts README bytes between markers match regeneration (doc-sync gate, dsh-01 §7 pattern).
- One manual step: first run inserts markers + regenerates; afterwards drift fails CI.

### Deferred experiments (explicit, with decision criteria — not in the plan's critical path)

- **E1 BDD ∥ Research** behind `SUPER_DEV_PARALLEL_BDD_RESEARCH=1`: prompt change (research derives questions from requirements ACs only when BDD absent: `bdd?.docPath ?? "not yet written — derive questions from requirements acceptance criteria"`), `parallel([bddConvergence, researchConvergence])`, join appends in branch order. Decision criteria: only if P1 ledger telemetry shows research+BDD wall-clock is a material fraction of runs AND a quality A/B (same spec, sequential vs parallel, compare design-review findings count) shows no regression. Cost if wrong: weaker research questions (edge-case coverage loss).
- **E2 debug ∥ assessment** (bug path): both single-round writers, assessment's debug input is optional. Value ≈ minutes; only if E1 lands and the pattern proves out.
- **E3 instruction classification** (LLM-based): deferred per P3.2; revisit when ledger shows instructions that fingerprint-invalidation mishandled (e.g. pure design clarifications needlessly re-running all phases).

## 3. Testability summary (every phase has a machine gate)

| Phase | Machine gate |
|---|---|
| P0 | docs-contracts.test.ts (existence, structure, status lines, exit names) |
| P1 | runlog.test.ts (core), nodes/workflow/red-oracle/judge extensions (wiring), runlog-replay.test.ts (end-to-end fold ≡ results), invariants-contract.test.ts (explain-or-assert coverage) |
| P2 | team.test.ts, setup.test.ts (fail-loud), topic-projection.test.ts (deterministic rebuild) |
| P3 | messages.test.ts (lifecycle+delivery+overdue), user-steer extension, graph-edges.test.ts (coverage+acyclicity+signature tripwires) |
| P4 | arch-docs.test.ts (byte-verified regeneration), env cross-check |

## 4. Sequencing & effort

Order is dependency-ordered, not preference: P0 (1-2 days) → P1 (≈1 week, 7 commits) → P2 (2-3 days) → P3 (2-3 days) → P4 (2 days). Each commit independently green; each phase ends with a full-suite run + version bump + (from P1.2 on) its own events in the ledger — dogfooding from day one. Total ≈ 2.5-3 weeks part-time.

Interleaving rule: P0.4 and P4 are independent of P1; they can slot anywhere. P2/P3 strictly after P1.6 (they consume the ledger). No phase touches the verification spine's decision logic — it only gains event emission (P1.4-1.5) and an invariant watch layer (P1.7); gates/judge/stagnation semantics stay byte-identical (guarded by existing suites).

## 5. Open questions (recommendations; decide before P1)

- **OQ1 audit.jsonl fate**: recommend dual-write through P1, then keep audit.jsonl as a run-dir convenience projection (it already has a consumer: postmortem tooling) — never delete, never make it authoritative. Alternative (kill it at P1.6) saves writes but breaks existing habits for zero gain.
- **OQ2 event granularity of agent text**: recommend control object + error tail only (audit parity), NOT full text (size; text already recoverable via resume-cache when needed). If postmortems keep needing full text, add `agent.called.detail` events later behind a size cap.
- **OQ3 invariants failure semantics**: log + summary section (recommended — diagnostics first, matching dsh's runtime-invariants philosophy of attributable loud signals) vs fatal abort. Fatal is tempting for check (3) (unterminated stage) but would turn a telemetry gap into a run-killer; start loud-non-fatal, promote individual checks to fatal only after a month of clean telemetry.
- **OQ4 E1 default**: recommend OFF (quality risk unknown); the flag exists so the experiment is one env var, not a code change.

## 6. Success criteria (each machine-checkable)

1. `jq` over a production run's `events.jsonl` answers: who did what (agent.called per role), what each gate decided, why each escalation fired — no resume-cache archaeology (P1.6 test is the proxy).
2. `topic.json` rebuilds byte-identically from events (P2.3 test).
3. A message sent to a role appears in that role's next prompt exactly once; unanswered requiresResponse messages surface as overdue (P3.1 tests).
4. Adding a new stage without an invariants entry or explicit reason fails CI (P1.7 contract test).
5. Editing a prompt to add a stage dependency without updating edges.ts fails CI (P3.3 tripwire test).
6. README stage/env/role tables cannot rot (P4 byte-verify).
7. Zero behavioral change to gate/judge/loop decisions — pinned by the existing 2000+ test suite passing unmodified.
