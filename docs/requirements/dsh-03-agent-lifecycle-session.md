# dsh-03 — Agent Lifecycle, Session/Event-Sourcing, and Context Management (Deep-Dive)

Status: reference — dsh research series

Repo under analysis (read-only): `docs/references/deepseek-harness` (github.com/deepseek-ai/deepseek-harness, MIT, developer preview).
All paths below are relative to that repo root. Every claim cites a concrete file; type-level claims cite the `type-equiv`/`cordis-catalog` blocks embedded in the subsystem docs, which the repo verifies against source via `pnpm run verify-type-equiv` / `verify-cordis-catalog` (docs/subsystems/core.md §"Repo-wide type patterns").

---

## 1. Overview

dsh's agent machinery is organized around one central decision: **the session log is the single source of truth, and everything the model ever sees is derived from it**.

- `packages/core/session` owns the append-only `SessionEvent` log (`docs/subsystems/session.md` §"`SessionEventMap`").
- `packages/core/agent` owns the public `Agent` handle, the `AgentRegistry`, the durable two-list inbox, and the `agent/*` event vocabulary (`docs/subsystems/core.md` §"The agent handle").
- `packages/core/agent-loop` is the *only* concrete driver: it claims inbox input, opens turns/steps on the log, assembles prompts via `ctx.systemPrompt`, streams via `ctx.llm`, dispatches tools via `ctx.tools`, and appends every model-visible fact back to the log before the next step derives from it (`docs/subsystems/core.md` §"The spine, package by package").
- Around this spine sits a family of *optional capability seams* — subagents, workflow scripts, goals, plan mode, compaction, spill, session projections/queries/titles — each of which extends `SessionEventMap` via declaration merging rather than forking the loop.

The load-bearing invariants (each enforced by code, not convention):

1. **Model-visible means logged** — anything reaching a model request must be reconstructable from the log; a runtime invariant asserts it (`docs/architecture.md` §"Session log").
2. **`seq = log.length` contiguity** — chunks cannot be filtered out of the canonical log, so persistence is byte-faithful replay (`docs/subsystems/session.md` §"Durability contract").
3. **Append is synchronous, JSON-validated, frozen at the source** — a bad event fails at the append site, never during a later flush (`docs/subsystems/session.md` §`Session.append` JSDoc).

---

## 2. Mechanisms

### 2.1 The event vocabulary and its envelope

`SessionEventMap` (docs/subsystems/session.md; source `packages/core/session/src/types.ts:236`) declares the core durable events: `turn/start|end`, `step/start|end`, `user/message`, `assistant/chunk`, `assistant/message`, `tool/call`, `tool/result`, `todo/write`, `request/header`, `request/context`, and `session/end-seed`. Notable details:

- **`SessionEvent` is a proper discriminated union over `type`** — not independent `type`/`data` unions — so `switch (event.type)` narrows `event.data` without casts (`docs/subsystems/session.md` §"`SessionEvent<T>`"). Because the map is merge-extensible, switches must NOT use `assertNever`; a plugin-added variant is a valid unknown value.
- **Conditional surface metadata**: only the three `SurfaceEventType`s (`user/message`, `assistant/message`, `tool/result`) may carry `surfaceOp` and `sourceEventSeqs`; the compiler enforces this at `Session.append()` call sites (same section).
- **`ignorable?: true`** marks an event a reader may safely skip when it does not recognize the type; absence means a reader MUST refuse to reconstruct rather than silently dropping a possibly load-bearing event — the default over-refuses rather than resuming a gutted session (§`SessionEvent` JSDoc).
- **`assistant/message` records every successful provider call**, including content-less and `max-tokens` finishes; empty content stays out of derived history while the durable event keeps usage and `sourceEventSeqs` (including an explicit empty list) — `docs/agent-lifecycle.md` §post-mermaid prose.
- **`tool/call.arguments` is the raw JSON string exactly as the model produced it (unparsed)**; `callId` pairs it with `tool/result`, which may also carry an opaque, JSON-serializable tool-private `meta` presentation payload validated at the source by `isJsonValue` (`docs/subsystems/session.md` §`SessionEventMap`).
- **`request/header` logs the full next-request envelope** (`EpochHeader`: call config + adapter-supplied defaults + rendered system prompt + assembled tool schemas) inside its step before dispatch, so *every conversation request is a pure function of the log* — the "reconstructability Agent Note" is cited in `docs/subsystems/session.md` §"The request header event".
`request/context` logs route capacity separately precisely because folding it into `EpochHeader` would make a capacity change register as a request-envelope `change` (same section).
- **`session/end-seed`** is the durable projection of `firstLiveSeq`: the constructor seed's boundary, whose payload is empty (position and `time` carry the meaning). Readers must locate the LAST one, since a seed already ending in one is not re-marked (`packages/core/session/src/index.ts:539-546`).

### 2.2 The surface: how model history is derived

The ordered **surface** is a projection over the log, not a separate store (`packages/core/session/src/surface.ts:1-11` "Surface layer on top of the session event log: an ordered view of events that produce LLM messages. The append-only log remains the source of truth."):

- `SurfaceOp` is either `'append'` (normal tail) or `{ op: 'replace', start, end }` (an inclusive positional range replacement; `start === end` replaces a single node). The replacer's `sourceEventSeqs` must include every shadowed surface node (`docs/subsystems/session.md` §"Surface types").
- `SurfaceIntent` (surfaceOp + sourceEventSeqs) is REQUIRED on message-producing appends and FORBIDDEN on log-only types — enforced at compile time (§`SurfaceIntent`).
- `deriveMessages()` walks the ordered surface node seqs and folds `deriveEventMessage` per node; **the fold is cached** (each node projected exactly once when first seen;
a `replace` bumps `replaceGeneration` and rebuilds), and the returned messages are SHARED, deep-frozen references into the durable event data, so the cache needs no second deep clone and consumers cannot mutate the log through a projection (§`Session.deriveMessages` JSDoc).
- `deriveEventMessage` (source `packages/core/session/src/surface.ts:83-113`) is the per-node pure function: `user/message` → user message verbatim (with an explicit code comment banning per-type framing reintroduction — framing is caller-owned);
`assistant/message` → assistant message unless content is empty (a max-tokens step's usage-only carrier must not enter the transcript); `tool/result` → a user message carrying a tool-result block; everything else → `null`.
It is exported PUBLIC so external reconstructors and the dev invariant project a log prefix with exactly the same rules as the cache ("cannot disagree with the cache").
- `foldSurface(events)` returns the current node set plus the actual shadowed seqs per replacement (`SurfaceFoldResult`); the live manager (`SessionSurface`) exposes only `nodes` and `replaceGeneration`.
A windowed `SurfaceManager(log, baseSeq?)` can fold a contiguous loaded window where a replacement crossing the window head fails because its declared range is absent (`docs/subsystems/session.md` §"`SessionSurface`").
- The human transcript is deliberately a DIFFERENT projection: it reads append-origin events (`isAppendSurfaceEvent`, `packages/core/session/src/surface.ts:50-58`) because the model surface shadows ranges a summary replaced — a landed replacement would otherwise erase conversation the user already saw.

### 2.3 Append semantics and durability contract

`Session.append` (docs/subsystems/session.md §public API; source `packages/core/session/src/index.ts:579-640`):

- Synchronous; notifies observers via store-owned, module-private publication hooks; the hot path never blocks on I/O (persistence buffers asynchronously). Once the event enters the log, the append is committed; observer failures are logged and contained per listener.
- One recursive pass reads, validates, and copies each nested value once, rejecting BigInt, functions, symbols, `undefined`, `-0`, non-finite numbers, circular references, sparse arrays, and exotic objects (Map/Set/Date/class instances) — "a stateful getter cannot supply one value to validation and another to storage" (§append JSDoc;
`packages/core/session/src/json.ts:188` `isJsonValue`).
- The event log is the durable source of truth, so a bad event fails at the append site rather than later during a backend flush.
- Durability contract: the durable log persists every event losslessly INCLUDING `assistant/chunk`; `seq` must stay contiguous so chunks cannot be filtered out of the canonical log; a backend may choose its own storage encoding as long as `load` returns the exact appended events (§"Durability contract").
- The loop does NOT await a flush at turn boundaries — `dsh-session-checkpoint-policy` owns the per-request durability checkpoint; consumers reading storage after `whenIdle()` flush themselves via `ctx.sessions.flush(session)` (§`turn/end` JSDoc + §`ctx.sessions.flush`).

### 2.4 The turn/step state machine

From `docs/agent-lifecycle.md` (generated Mermaid sequence) and `docs/subsystems/core.md`:

- A **step** is one model request plus the tools it calls; a **turn** is zero or more steps, opened before its first input is claimed and closed once nothing is owed (`docs/architecture.md` §"Turn flow").
- **Inbox semantics**: one inbox, two ordered pending lists (`InboxTarget = 'next-turn' | 'next-step'`, `docs/subsystems/core.md` §agent handle). `Inbox.append/prepend/replace/remove/clear/splice/claim` record normalized durable `agent/inbox/spliced` mutations and reject duplicate pending ids;
`claim(target)` removes the proposed batch (all `next-step` input plus, at a turn boundary, one `next-turn` message) through pure-deletion splices, with the loop separately emitting per-message `agent/inbox/claimed` (source `packages/core/agent/src/inbox.ts:20-71`).
Some messages wake the driver immediately; injected context waits until another message does (`docs/architecture.md` §"Turn flow").
- **`agent/pre-step` (waterfall)** decides what the model sees: listeners rewrite the claimed messages or reject outright (`PreStepDecision = { kind: 'reject' } | { kind: 'enter'; messages: UserMessage[] }`).
A rejected or empty first claim still closes a durable turn that spent no step — the log records the attempt, and the claimed batch stays removed (§"Interception decisions"; `docs/agent-lifecycle.md` alt-branch). The returned decision is authoritative;
claimed messages omitted by the final decision remain removed while input inserted after the claim stays pending.
- **Model request**: `agent/request` waterfall replaces the frozen call config (cannot mutate messages — "model-visible content must use logged channels"); then `llm/stream`; `assistant/chunk*` are appended for token-level replay fidelity; a successful call appends `assistant/message`.
- **Tool dispatch** (docs/tool-execution-pipeline.md): pending calls classified by executionMode run under "barriers and bounded rolling pool, reclassify before start"; `tool/call` is logged BEFORE execution;
the `tools/pre-execute` waterfall (hooks/permission/sandbox) → registered monotonic guards → `ctx.approval` one-shot prompt → `tools/execute` waterfall (timeout/retry/metrics wrap dispatch) → tool body → tool-owned session events → `tools/post-execute` (accept/block/replace/add-context) → registry outer normalization (pipeline/result snapshot throws become isError) → `finalizeContent` (synchronous content-only invariant) → `tools/result` (frozen authoritative outcome) → active-batch `additionalContexts` FIFO injected as `user/message` after recorded tool results.
- **`agent/turn-stopping` (serial, no `next()`)**: the terminal checkpoint when the model owes no response (no live tool calls, no fresh steering).
A listener that objects steers (`agent.steer(...)`) and the machine re-reads its inbox: fresh steering runs another step, none closes the turn — "Data decides, so listener order cannot change the outcome." The inverse (stop a tool loop early) is also data: a tool result carrying `concludesTurn` ends the turn at its step, but never short-circuits already-submitted same-step `additionalContexts` or racing steering (§`agent/turn-stopping` cordis-catalog entry).
- **Why a turn ended**: `TurnEndReasonMap` is a merge-extensible sum: `completed`, `aborted` (with a `TurnEndCancelCause` = live `AgentCancelCause` or `{ kind: 'legacy' }` for imports), `blocked`, `error` (always structured `LlmFailure` facts verbatim or flattened), `max-tokens` (any max-tokens step poisons the whole turn — "the cut-short fact wins over a later continuation"), and `interrupted` — the one reason NO loop emits;
it is synthesized only by crash recovery on reload (`docs/subsystems/session.md` §"`TurnEndReasonMap`").
- **Execution enclosure**: a turn encloses one model-loop execution, not the whole log; plugin-owned log-only events may appear between `turn/end` and the next `turn/start`, consuming seqs without incrementing turn numbers.
Core's invariant companion enforces turn/step numbering, execution-event enclosure, and same-step tool call/result pairing, but does NOT reject unknown events merely because no turn is open (§"Execution enclosure and standalone events").

### 2.5 The agent handle: delivery, cancellation, quiescence

`Agent` (docs/subsystems/core.md §"The agent handle"; source `packages/core/agent/src/types.ts`):

- `send(message, target, wakeup)` is the unified routing primitive; `followup` (queue an ordinary follow-up turn and wake), `steer` (nearest step; idle driver starts a turn, running driver consumes at its next step boundary;
a rejected step leaves steering parked), and `inject` (queue model-facing context for the next pre-step WITHOUT waking) are fixed presets. `followup()` returns no handle — its `MessageId` identifies durable inbox insertion/claim/discard facts, "not a later assistant output or turn ending."
- **Cancellation**: `cancel(cause, options?)` clears queued and steering work (unless `keepInbox`) and aborts the active turn or between-turn task; "the first cause wins for that activity"; with no active activity it is a no-op and does not arm later work.
The cause is a TS-enforced same-process input (`AgentCancelCause`: `user | parent | hook | disposed`);
an active holder copies it into the runtime-only `AbortSignal.reason`, and durable `turn/end` retains only the coarse `{ kind: 'aborted' }` outcome — recording WHO cancelled would require a separate durable event rather than overloading the terminal result (§"Cancellation").
- **Quiescence**: `whenIdle()` "follows replacement work started before the observed driver retires, but does not identify the settlement of any particular message" — the defensive-patterns doc hammers this: async state is not synchronous state;
several queued follow-ups, steering, and injected work may share one `running` interval, so an automation caller that truly owns a run must define its interval explicitly and describe output as interval-wide (docs/defensive-patterns.md §"Async state is not synchronous state").
- `runMaintenance(task)` runs one non-turn maintenance task from the true idle phase, synchronously claimed; later waking input remains in the inbox until the task settles while public status stays `idle`.
- **Status is only `idle | running`**; disposal removes the agent from the registry (it is not a third status). `running` describes the driver-wide drain interval and may span consecutive queued turns (§`AgentStatus`).
- Creation/ownership: `AgentHandle.dispose()` is a CAPABILITY ("among consumers, only the holder can tear this agent down"); the registered factory provider is a structural owner because the scoped agent depends on its service API;
provider unload stops and drains every live handle it made (§"Creation and ownership"). The `setup` callback composes the agent's scoped world while both ids are still unpublished; "a setup rejection, commit throw, or owner disposal rolls the transaction back without publishing either id."

### 2.6 Scoped registration

`packages/core/scope` is a dependency-free library below `session/` and `system-prompt/` in the module graph precisely so they can consume it without a cycle (docs/subsystems/core.md §spine table). `ScopeKey` is an opaque object identity (the loop uses the live `Agent` object as its own key);
`Scoped<T>` is a compile-time brand on the routing receiver `scopeTarget(base, key)`; `Scope` pairs the tagged registration context with `rawDispose` (exact Cordis disposer identity for ordered composite effects) and `dispose()` (public shared quiescence boundary).
`ScopedLayers` keeps an eager global layer plus lazily created exact-scope layers; reads never create layers; a scoped layer is reclaimed only when its complete `ScopeLayer.isEmpty()` (docs/subsystems/scope.md).
This is what makes `session/event`, `agent/*`, and `system-prompt/assemble` dispatch scope-filtered: agent-scoped listeners receive only that agent's traffic.

### 2.7 System-prompt assembly

`ctx.systemPrompt` (`docs/subsystems/system-prompt.md`) contributes: ordered `PromptSection`s (convention: −100 harness identity, 0 deployment persona, 100–199 tool guidance), `PromptContext` dynamic contexts, tool-schema providers, `{{variable}}` providers, and an `assemble(context)` that resolves global+scoped providers, detaches tool parameters, applies canonical ordering, runs the `system-prompt/assemble` waterfall, then restores any effective `complete` section as the sole prompt (more than one effective complete section fails assembly).
A scoped section SHADOWS a global section with the same name. `AssembleContext` is merge-extensible (dsh-agent adds the live `agent` field). The assembled header is logged per-step as `request/header`, which is what makes prompt state reconstructable.

### 2.8 LLM streaming vocabulary

`StreamChunk` is a CLOSED discriminated union (`block-start | text-delta | reasoning-delta | tool-call-delta | block-end | usage | finish`) — `switch` ends with `assertNever`, so adding a variant breaks compilation at every consumer that must handle it;
this contrasts deliberately with the merge-extensible `SessionEvent`/`ContentBlock` unions (docs/subsystems/llm-streaming.md §"`StreamChunk` — the raw protocol"). `block-end` carries the fully-assembled `ContentBlock` so consumers don't re-assemble deltas.
Adapters may throw, but `LlmRuntime.stream()` normalizes failure to a terminal `finish {kind:'error'|'aborted'}` chunk — "consumers [don't have to] guess whether a caught exception came from the provider, a wrapper, chunk logging, or their own assembly" (docs/defensive-patterns.md §"Honor public contracts on BOTH sides").
`Message` carries `id`, `role`, `content: ContentBlock[]`, and a `MessageSource`; `AssistantProvenance.provider/model/replayState` names the producing route and carries adapter-private lossless-JSON replay state.

### 2.9 Read-side machinery: projection, query, reference, title, telemetry

- **session-projection** (`docs/subsystems/session-projection.md`): a domain registers a `ProjectionDefinition` = `init()/apply(state,event)/view(state)` + `schema` + `stateVersion`, all THREE functions synchronous and state plain JSON.
"The framework drives, the domain computes": the registry subscribes to `session/event` once and folds every committed event through every unit; a unit returning the SAME state reference produces zero downstream work (`Object.is`).
`snapshot(session)` is fully synchronous with one `asOfSeq` watermark. `stateVersion` bumps invalidate persisted `(sessionId, key, ver, seq, val)` cache rows so stale rows are discarded instead of forward-applied into garbage;
the cold-read ladder (cached row → persistence `readFrom` tail → registry `restore`) anchors one event BELOW the lowest usable watermark so a shrunk (crash-repaired) log is detected rather than serving stale rows.
- **session-query** (`docs/subsystems/session-query.md`): provider-independent filters (ANDed arrays, ORed values, inclusive ranges), a literal case-insensitive semantic-text scan independent of FTS providers, cursor-paginated full-text search where "query is interpreted as data, never executable FTS syntax", event surface classification (`current | shadowed | log-only`) using the same `foldSurface()` transitions as model-history derivation, and lineage tracing with an explicit completeness discriminant.
- **session-reference** (`docs/subsystems/session-reference.md`): structured cross-session mentions resolved BEFORE enqueue into one aggregated untrusted-context `UserMessage`; self-reference, count limits, and budget failures have stable codes; "Host protocols map these codes … without inspecting prompt bytes."
- **session-title** (`docs/subsystems/session-title.md`): durable latest-wins `session/title` events with `messageSeqs` provenance and a three-way source (`fallback | provider | user`); a user rename PINS the title (automatic scheduling stops);
even the auxiliary title LLM request is recorded event-wise (`SessionTitleLlmRequestEventData`) with exact system/messages/route/maxTokens — again "model-visible means logged", even for side calls.
- **session-telemetry** (`docs/subsystems/session-telemetry.md`): only the first `assistant/chunk` per `(turn, step)` ships (stream-started signal), so wire `seq` gaps are routine and never a loss signal; delivery is best-effort with receivers deduping ledger records on `(session.id, event.seq)`;
the redaction waterfall ships NO rules of its own — "with no listener mounted, records reach the backend exactly as captured, so exported data is precisely as clean as the rules a deployment mounts" — and "redaction applies to the exported copy only — the canonical session log is never rewritten."

### 2.10 Fork/resume

`SessionStore.fork(source, boundary?, childSessionId?)` selects source events through an inclusive `boundary` seq (default: last event), requires the prefix to end OUTSIDE an open turn (rejects rather than clipping silently), and creates a live child with deep-cloned seed events plus child metadata (`parentSession`, `seedLength`, inherited `cwd`) — docs/subsystems/session.md §"Live-session fork API".
`dsh-subagent-fork-in-process` deliberately keeps its own completed-prefix clipping because tool-time delegation usually starts while the parent turn is open.
`ctx.agents.resume()` loads a persisted session and resumes an agent on it through the registered factory (docs/subsystems/core.md §`ctx.agentLoop`);
a seeded session appends `session/end-seed` as its first live write so seed history and live work are distinguishable in stored bytes (§"The end-seed boundary").

### 2.11 Subagents: variety behind one interface

Unlike bash (one executor), `ctx.subagents` is a NAMED PROVIDER REGISTRY where multiple transports coexist — `spawn` (fresh child, no parent history), `fork` (seeded with parent's balanced completed-turn prefix), `acp`, `codex`, `claude-code`, `dsh-sdk` (docs/subsystems/subagent.md §intro). Key contracts:

- **Capability discovery is two-way**: start-time features are static `SubagentCapabilities` flags checked BEFORE a run exists (a request needing a missing capability is rejected loud with `SubagentError('UNSUPPORTED_CAPABILITY')`, "never accepted-then-ignored");
continuable capability is discovered by METHOD PRESENCE (`prepareContinuable` — "TS narrowing as the discovery mechanism").
- **One-shot vs continuable**: a one-shot run is "one disposable foreground delegation with one result, never a durable child handle"; `SubagentResult.stopReason` is merge-extensible, and consumers "treat an unknown terminal reason as a failure".
A continuable child is one durable child Session with at most one process-local **Activation**; the Agent inbox is the ONLY queue ("Every continuation message becomes one `Agent.followup()` FIFO turn … a follow-up cannot redirect a turn already underway");
the manager derives `running/waiting/settled` from Agent quiescence and the owned-child set "rather than maintaining a second execution state machine."
- **Depth and seed reuse existing vocabulary**: delegation depth is durable `SessionHeader.delegationDepth` + merge-extensible `AgentOptions.subagentDepth` ("the seam owns both fields — the loop neither sets nor reads them");
fork seeding is `CreateAgentOptions.seed` threading a balanced completed-turn prefix through `AgentLoop.createAgent → ctx.sessions.prepare({ seed })` — "the same primitive `ctx.agents.resume()` uses".
- **Durable enumeration without resurrection**: `listChildren()`/`listDescendants()` merge the live store with optional persistence (live-preferred) and serve identity by folding the log-only `subagent/descriptor` event last-wins down a three-rung ladder (registry watermark cache → projection-cache row gated by own-suffix seq → one persistence `inspect()` refold);
"The projection fold is the single classification authority."
- **Report vs settled attribution are distinct kinds** (`subagent-report` vs `subagent-settled`) — "a transcript that merged them would credit the child with words it never wrote."

### 2.12 Workflow subsystem

`ctx.workflowEngine` executes a model-written orchestration SCRIPT that starts subagents (docs/subsystems/workflow.md). One engine per context (no named-provider registry). Load-bearing details:

- `meta`/`args` are plain JSON DATA validated against schema BEFORE anything runs — "no script text is ever evaluated to obtain it".
- `result` NEVER rejects: a script failure resolves `stopReason: 'error'`; a cancelled run settles within the engine's bounded grace even if the script never settles (the worker-thread engine force-settles then terminates the worker) — "a consumer awaiting `result` is never wedged past a cancellation".
- **Failure discipline**: hook misuse throws `WorkflowError` with `fatal: true`, and `parallel()`/`pipeline()` RE-THROW fatal errors instead of mapping items to `null` — "a typo'd option must kill the script loudly, never dissolve into something that reads as an ordinary child failure."
- `workflow/*` events are observe-only DATA SNAPSHOTS starting with `WorkflowRunInfo` (never the live run handle), and `workflow/end` deliberately omits the result value "so a listener observing outcomes must not receive a mutable alias of the caller's result."
- Durable Chat records (`tool-workflow/run-start|run-end`) are projected into the parent session without changing execution ownership; an invariant companion validates the pairing protocol on live commit AND on Session load, treating a missing member/run ending at the log tail as "valid interruption evidence rather than corruption."

### 2.13 Plan & goal: same-session objective state as log events

- **Plan mode** (docs/subsystems/plan.md): `plan/mode` is a log-only, whole-value-replace session event;
"the state in force is always a pure fold of the session log, so resume, fork, and compaction recover it with no live mirror." A pending user selection is appended at the next ACCEPTED in-turn `agent/pre-step` (the only append point while running), never forcing continuation.
Plan mode is SOFT guidance — sandbox and approval "enforce restrictions independently; neither reads or writes plan state."
- **Goals** (docs/subsystems/goal.md): every mutation is a durable `goal/change` event carrying either a complete post-mutation `GoalSnapshot` (id/revision/objective/phase/maxGoalRounds) or a clear tombstone;
`GoalRef` (id + revision) gives compare-and-set semantics ("every accepted durable mutation increments the revision"). The durable phase (`active|paused|blocked|complete`) answers what happened to the objective;
process-local `activation` separately answers whether a continuation consumer may start another round — durable vs process-local split again.
Admitted rounds are attributed via `GoalMessageSource { goalId, revision, round }` on user/message events, and "Replay rejects non-positive rounds, gaps, stale revisions, stopped phases, and cap overflow."

### 2.14 Compaction & spill: context-window management

- **Compaction** (docs/subsystems/compaction.md) extends `SessionEventMap` with THREE log-only events (`compaction/start|summary|end`);
`SurfaceEventType` is deliberately NOT extended, so the summary rides a separate `user/message` with `surfaceOp: { op: 'replace', start, end }` — "the only surface mutation performed by summary compaction." The lock brackets the WHOLE operation and releases LAST, so a crash mid-operation becomes a detectable orphaned lock rather than an end that falsely claims success.
`shadowedRange` is a surface-POSITION span, not a numeric interval — after nested replaces, `start` can be GREATER than `end`; `shadowedSeqs` is authoritative. Pressure compaction runs at serial `agent/pre-step` BEFORE request derivation;
failed-request recovery runs through `agent/request-error` and returns a retry action "only when the surface replacement generation advances" (retry loops cannot spin without progress). Region boundaries preserve tool-call/result pairing but NOT whole turns.
The optional tool-result pruner replaces over-budget text middles by Unicode CODE POINT "so a retained boundary cannot split a surrogate pair", each replacement immediately preceded by a `compaction/prune` shadow-price event so pure consumers can subtract it without per-node state.
- **Spill** (docs/subsystems/spill.md): a one-method seam (`saveText`) persisting a tool's oversized text verbatim and returning an opaque branded `SpillLocator` + `retrievalHint` + exact byte count;
the local backend writes under `<root>/session-<sha256(sessionId)>/<random>-<safeName>` with a private 0700 root and exclusive owner-only `'wx'`/0o600 opens "so a planted symlink cannot redirect it" (mirroring docs/defensive-patterns.md §"Never hand untrusted output the ambient environment or predictable paths").
The policy consumer is best-effort: "a save failure keeps the original inline result rather than turning a successful call into an `isError`."

### 2.15 User questions

`ctx.userQuestions.ask` is the provider-neutral vocabulary for human-in-the-loop (docs/subsystems/user-questions.md): stable question ids echoed in answers, presentation-only `intent` ("an intent changes presentation only, never the protocol"), `approve` named rather than positional "so no UI infers the verdict from option order", and a sharp authorization rule: "human interaction is valid only for the exact live runtime root.
Runtime ownership, not durable session lineage, decides this boundary: an owned child has no human answerer and would block forever, while a lineage-bearing session resumed as a new runtime root may ask normally."

---

## 3. Design decisions and trade-offs

1. **Event-source EVERYTHING model-visible (derive, never store).** Upside: replay/fork/resume/telemetry/UI are all pure folds of one log; the "model-visible means logged" runtime invariant makes an unlogged injection structurally impossible.
Cost: every new model-visible input requires a new session event type (`SessionEventMap` merge + render-from-log), and the log only grows — which forces compaction to be a SURFACE projection (`replace` ops) rather than log rewriting, and forces projections/caches (session-projection's `stateVersion` + watermark ladder) to make reads cheap.
docs/architecture.md §"Session log"; docs/subsystems/session.md §"Plugin-contributed log-only events".
2. **Two projections over one log** (model surface vs human transcript). The surface shadows summarized ranges; the transcript reads append-origin events.
This preserves user-visible history across compaction but means "what the model saw" and "what the user saw" genuinely diverge after compaction — a deliberate, documented asymmetry rather than an accident. packages/core/session/src/surface.ts:50-58.
3. **Live control (`agent/*`) vs durable facts (`session/event`) as separate domains.** Status, inbox notifications, waterfalls, and steering are ephemeral; only outcomes are durable.
Trade-off: `agent/status`/`whenIdle()` cannot attribute output to a particular message (defensive-patterns §"Async state is not synchronous state"), so automations must own their intervals explicitly.
The cancellation CAUSE is deliberately runtime-only — the durable record keeps only the coarse aborted fact, because persisting "who" would need its own event.
4.
**Waterfall interception with authoritative decisions.** `agent/pre-step` may reject or wholly replace the entering batch — powerful for compaction/hooks, but the docs stress cooperative listener discipline ("listeners wrapping `next()` preserve downstream messages unless replacement is intentional";
docs/agent-lifecycle.md). `agent/turn-stopping` is deliberately serial without `next()` and resolves everything through DATA (steer vs let-close; `concludesTurn`), so listener order cannot change the outcome — an unusual and clearly reasoned choice.
5. **Merge-extensible unions vs closed unions, chosen per axis.** `SessionEvent`, `ContentBlock`, `MessageSource`, `TurnEndReason`, `SubagentStopReason` are extensible (unknown ⇒ fail-soft or treated-as-failure with `default` arms); `StreamChunk` is closed with `assertNever`.
The trade-off is explicit: extensibility lives exactly where plugins legitimately add vocabulary, and closedness lives where every consumer MUST update. docs/subsystems/core.md §"The `…Map → derived-union` pattern"; llm-streaming §StreamChunk.
6. **Capability discovery: fail-loud flags vs method-presence.** Start-time subagent features are static flags validated BEFORE a run (no accepted-then-ignored degradation); continuable capability is method presence. Both avoid the "silent capability drift" failure mode the harness elsewhere fights (invariants companion, `verify-package-invariants`).
7. **One loop implementation, swappable by construction.** Extension plugins depend on `agent` (the interface), never `agent-loop`; the loop registers its factory via `ctx.agents.setFactory()`. Cost: a level of indirection; benefit: the product loop is replaceable like any plugin (docs/subsystems/core.md §spine).
8. **Durability boundaries are explicit, not ambient.** The loop does not flush at turn boundaries; `ctx.sessions.flush` is the single spelled entry point owned by the store; compaction's manual path flushes a closed attempt before later prompts may derive from the new surface.
Trade-off: consumers that read storage without flushing can see stale state — the contract pushes that responsibility to the caller (session.md §`turn/end`, §`ctx.sessions.flush`).
9. **Seed/live boundary as a durable event** (`session/end-seed`) rather than metadata: seed history and live work are byte-identical otherwise, so standalone open/close brackets (e.g., an orphaned `compaction/start`) become decidable.
Acknowledged limit stated in the docs: "tolerating concurrent writers needs a signal beyond the log" — the event is NOT a liveness signal about other writers.
10. **Telemetry mirrors the log but ships no policy.** First-chunk-only projection keeps the wire light; the redaction waterfall ships zero default rules, making deployment policy the sole determinant of exported-data cleanliness; dedupe is the receiver's job.
Trade-off: out-of-the-box export contains everything unless a deployment mounts rules — a deliberate exposure default inverted at the redaction seam.
11. **Projection framework drives, domains compute.** Synchronous pure units with reference-equality no-ops keep the consistency cut tear-free; the cost is that any async unit is impossible by construction ("an async unit would tear the carriers' consistency cut").
12. **Trade-off acknowledged for HMR/ordered teardown**: `ctx.agents.register` returns the EXACT Cordis disposer because "a composite (generator) effect that owns a teardown ORDER … must yield THIS function so Cordis nests the unregistration at that yield position;
yielding a wrapper would leave it disposing as a concurrent sibling on owner unload, unregistering the agent … while its final turn is still draining" (core.md §`register`). Teardown ordering is a first-class contract throughout (scope.md `rawDispose`;
session store `prepare/enter/announce` split for rollback-safe publication).

---

## 4. Evidence appendix (file paths + anchors)

Primary docs (all relative to repo root):

- `docs/agent-lifecycle.md` — full turn/step Mermaid sequence; inbox splice/claim flow; pre-step rejection semantics; compaction recovery via `agent/request-error` gated on "surface replacement generation".
- `docs/tool-execution-pipeline.md` — tool pipeline flowchart; `tool/call` logged before execution; `additionalContexts` FIFO; `finalizeContent` content-only invariant.
- `docs/subsystems/session.md` — `SessionEventMap` (§"`SessionEventMap`"), envelope + `ignorable` (§"`SessionEvent<T>`"), surface types (`SurfaceEventType`, `SurfaceOp`, `SurfaceIntent`, `SessionSurface`, `SurfaceFoldResult`), `Session` public API (append/deriveMessages/requestHeader/fork), `TurnEndReasonMap`, execution enclosure, end-seed boundary, plugin log-only events, durability contract, `ctx.sessions` catalog (`create/prepare/enter/announce/flush/get/list/fork`) and `session/created|disposed|event|flush` event declarations.
- `docs/subsystems/session-projection.md` — `ProjectionDefinition` (init/apply/view/schema/stateVersion), `ProjectionSnapshot`, change feed, `ctx.sessionProjections` (register/onChanged/snapshot/checkpoint/restoreFloor/viewCheckpoint/restore), `ctx.sessionProjectionCache` (cachedSnapshot/write/coldSnapshot).
- `docs/subsystems/session-query.md` — `SessionEventSurface`, filters, FTS pages, `SessionLineageTrace`, `SessionEventTrace`, error-code union; `ctx.sessionQuery` abstract seam.
- `docs/subsystems/session-reference.md` — `SessionReferenceInput/Candidate`, `PreparedReferencedMessage`, error codes; `ctx.sessionReferenceResolver` (listCandidates/prepare).
- `docs/subsystems/session-telemetry.md` — `SessionTelemetryRecord`, first-chunk-only rule, `SessionTelemetrySink` (emit/flush/shutdown), sharing disclosure, `session-telemetry/record` waterfall.
- `docs/subsystems/session-title.md` — `SessionTitleSource` (fallback/provider/user), `SessionTitleEventData/Snapshot`, `SessionTitleLlmRequestEventData`, `SessionTitleProvider`; `ctx.sessionTitle` (get/rename/refresh/register).
- `docs/subsystems/core.md` — spine table; creation/ownership (`AgentHandle`, `CreateAgentOptions`, setup rollback); `Agent` interface (send/followup/steer/inject/cancel/whenIdle/runMaintenance); `AgentStatus`; inbox (`InboxTarget`, mutation/claim vocabulary); `CancelOptions`/`AgentCancelCause`;
`PreStepDecision`/`RequestErrorAction`; `SessionStartSource`; `…Map → derived-union` pattern; branded IDs; `ctx.agentLoop`, `ctx.agents` (currentInitiator/requireInitiator/withInitiator/withoutInitiator/setFactory/create/resume/register/enter/announce/get/isOwnedBy/list/roots);
full `agent/*` and `agent-loop/config-start-failed` event catalog; `agent-preset/selected`; `ctx.agentPresets` (mount/composeFrom/recompose/standingKeyFor/serviceFor).
- `docs/subsystems/subagent.md` — `SubagentCapabilities`, `SubagentStartRequest`, continuable Activations and `running/waiting/settled`, `SubagentInterruptAuthority`, `SubagentFollowupOptions`, `ContinuableStart`, `CoordinatorMessageSource`, `SubagentReportMessageSource` vs `SubagentSettledMessageSource`, `SubagentResult`, `SubagentStopReasonMap`, `SubagentRun`, `SubagentProvider` (+`prepareContinuable`), depth/seed rules, `listChildren/listDescendants` ladder;
`ctx.subagents` catalog; `subagent/start|end|provider-added|provider-removed`.
- `docs/subsystems/workflow.md` — `WorkflowStartRequest`, `WorkflowMeta`, `WorkflowResult`, `WorkflowRun`, `WorkflowError.fatal` discipline, observe-only events, durable Chat records + invariant; `ctx.workflowEngine`; `workflow/*` event catalog.
- `docs/subsystems/plan.md` — `plan/mode` log-only event, pending-selection append at accepted in-turn pre-step, `PlanModeConfig`, exit tool + `/plan` command; `ctx.planMode.get/set` (`committed|queued|cancelled|noop`).
- `docs/subsystems/goal.md` — `GoalRef`, `GoalPhase`, `GoalBlockReason`, `GoalSnapshot/View`, `GoalMessageSource`, strict replay rejections; `ctx.goals` (get/disarm/create/edit/pause/resume/complete/block/clear) + `goal/changed`.
- `docs/subsystems/compaction.md` — `compaction/*` event table (lock-last rationale), `CompactionResult` (position-span warning), `CompactionTrigger`, manual error codes, pressure/overflow paths, `toolPairingBalancedBefore/After`, pruner types; `ctx.compaction` (compactIfNeeded/compactNow/compactRegion), `ctx.toolResultPruner`.
- `docs/subsystems/spill.md` — `SaveTextSpill`, `SpillOwner` fork-inheritance note, `SpillSource`, `SpillRef`/`SpillLocator`; local backend path shape + 0700/'wx'/0o600; `ctx.spillStore.saveText`.
- `docs/subsystems/user-questions.md` — option/intent/item/request/answer types, provider contract, error taxonomy; `ctx.userQuestions.ask` authorization rule.
- `docs/subsystems/scope.md` — `ScopeKey`, `Scoped<T>`, `Scope` (rawDispose vs dispose), `ScopeLayer`, `ScopedLayers`/`NamedEntries`/`AnonymousEntries`.
- `docs/subsystems/system-prompt.md` — `AssembleContext`, `ToolProviderResult`, `PromptSection` (order conventions, `complete`), `PromptContext`; `ctx.systemPrompt` (section/context/suppressRuntimeContext/tools/variable/assemble); `system-prompt/assemble` waterfall + `system-prompt/change`.
- `docs/subsystems/llm-streaming.md` — `ContentBlockMap`, `AssistantProvenance`, `Message`, `MessageSourceMap`, `ContextForm`/`ContextFormed`, `StreamChunk` closed union, adapter contract.
- `docs/architecture.md` §"Turn flow" + §"Session log" (model-visible-means-logged invariant) + §"Events" (three domains).
- `docs/defensive-patterns.md` — orthogonal outcome reporting; both-sides contract normalization; async-state guard; dispose-to-quiescence; callback containment; scrubbed env/0700 'wx' paths; symlink unlink.

Source anchors (spot-verified):

- `packages/core/session/src/index.ts:33` (surface re-exports), `:539-546` (firstLiveSeq + end-seed append), `:579-640` (append validation/copy), `:710-726` (deriveMessages cache).
- `packages/core/session/src/surface.ts:1-11` (surface-is-a-layer comment), `:17-28` (SURFACE_EVENT_TYPES), `:50-58` (isAppendSurfaceEvent transcript rationale), `:83-113` (deriveEventMessage switch incl. empty-content skip and framing ban comment).
- `packages/core/session/src/types.ts:236` (`SessionEventMap`), `:299` (`todo/write`), `:304` (`request/header`).
- `packages/core/session/src/json.ts:188` (`isJsonValue`).
- `packages/core/agent/src/inbox.ts:20-71` (claimed publication, nextTurn/nextStep, claim pure-deletion splices).
- `packages/core/agent-loop/src/agent.ts`, `packages/core/agent-loop/src/invariant.ts` (loop-owned invariant companion).

Referenced decision records (Agent Notes, `.agents/notes/implemented/…`): session-surface (2026-06-18), compaction capability seam (2026-06-18), capability seams (2026-06-13), subagent seam (2026-06-21), hook bridges (2026-06-30), todo_write (2026-06-29), dynamic workflows (2026-07-05), agent-scope runtime design + scoped layers store (2026-07-12), tool output spill files (2026-07-08), persisted same-session goal domain (2026-07-19), session telemetry otel revival (2026-07-23), durable subagent catalog + list agents (2026-07-22), plan-specific collaboration state (2026-07-22), continuable subagent conversations (2026-07-28), continuable report tool (2026-07-30), followup enqueue and owned runs (2026-07-30), session-projection RFC (`.agents/notes/proposed/architecture/2026-07-27-…`), Claude Code/Codex subagent backends (2026-08-04), subagent list identity projection (2026-08-06), cancel-convergence wake latch (2026-08-07, bug-fix), remove synthetic log-only turns (2026-07-28, simplification), unwrap injected content envelopes (2026-07-20, simplification), vendor rescope (2026-08-10, process), package-owned invariant service (2026-07-19, architecture), agent initiator scope (2026-07-15, architecture).

Review findings (doc-vs-code observations):

- **[low] docs/subsystems/core.md §"Sessions" (prose summary) lists twelve event variants including `steering/message`**, but `SessionEventMap` in `docs/subsystems/session.md` and `packages/core/session/src/types.ts` contains no `steering/message` — steering arrives as an identified `UserMessage` through the inbox and is logged as `user/message`.
The prose summary is stale relative to the authoritative map; the generated catalogs and session.md are correct.
- **[info] `request/context` vs `request/header`**: session.md documents `request/context` (route capacity) as a core member, and it is present in `types.ts`; core.md's twelve-variant enumeration also omits `request/context` and `session/end-seed`. Consumers should treat session.md as authoritative for the event vocabulary.
- **[info] `interrupted` turn-end reason is synthesized by persistence crash recovery only** — verified consistent across session.md (`TurnEndReasonMap`) and the persistence seam reference; no loop code path emits it.

Residual risks / limitations explicitly acknowledged by the docs themselves:

- Concurrent writers over one session log are NOT solved by `session/end-seed` ("tolerating concurrent writers needs a signal beyond the log").
- A plan-mode selection made after a turn's final accepted pre-step "remains process-local and is lost if the process exits before another accepted in-turn pre-step" (docs/subsystems/plan.md, README limitation).
- Telemetry delivery is best-effort; losses and duplicates are expected and receivers must dedupe (session-telemetry.md).
- `whenIdle()`/`agent/status` cannot attribute outcomes to individual messages (defensive-patterns.md); automations must own their intervals.
