# Cumora Deep Analysis — yetone/cumora@7dba7d5 ("Cumora: initial open-source release")

Status: analysis (reference study of an external repo — no implementation in this commit)

Cloned to `docs/references/cumora/` (gitignored, like the other reference repos).
Scope: every directory read — `server/` (164 TS files, ~10k lines in `agents/`
alone), `src/` (134 TS/TSX), `agent-cli/`, `agent-fuse/`, `workers/`,
`benchmarks/`, `docs/`, `electron/`, `ios/`, `android/`, `website/`.

Purpose of this document: understand the repo deeply enough to steal its best
ideas for super-dev — its agent-team model, coordination machinery, philosophy,
and engineering discipline.

---

## 1. What Cumora is

**Cross-platform team chat where AI agents are first-class participants
alongside humans** — same roster, same DMs, same group conversations, same
Kanban board, calendar, polls, documents, and *real email*. Not a "chatbot
widget in a chat app": agents hold personas and memory, claim work, coordinate
with each other without colliding, and run either on Cumora's cloud or on the
user's own machine.

By yetone (the avante.nvim author). Single open-source release commit at time
of cloning (`7dba7d5`); version 0.1.64; MIT. Production app at cumora.ai with
real tenants, cost ledgers, and an ops story (GKE, APNs/FCM push, Resend
email) — this is a *shipped product that was open-sourced*, not a demo.

The distinctive thesis, quoted from the author's own reasoning in
COORDINATION.md:

> "AI-native means making AI agents behave like real humans collaborating.
> Don't be limited in thinking. Every time you make a decision or implement
> code, think about what real humans would do."

That sentence is the design north star and it shows up everywhere: agents that
cover for an absent teammate, anti-monologue gates ("you can't double-text the
group before anyone replies"), voice rules that *forbid* assistant-isms, and a
coordination scheme built on optimistic-post-then-collide-then-fix rather than
lock-based turn-taking.

## 2. Top-level architecture

```
 Electron / PWA / iOS / Android          ┌─────────────────┐
 ┌──────────────────┐   HTTP / WS       │   App workers   │──▶ OpenAI (Responses API)
 │    React UI      │ ◀───────────────▶ │  Express + ws   │──▶ Resend (email out)
 └──────────────────┘                   │    (any N)      │──▶ APNs / FCM (push)
                                        └───┬────────┬────┘
 Cloudflare Workers                         │        │ kubectl
 ┌─────────────────┐   webhooks / R2   ┌────▼───┐ ┌──▼──────────────┐
 │ email-gate      │ ────────────────▶ │Postgres│ │ Agent pods (K8s)│
 │ r2-gate (CDN)   │                   │ Redis  │ │ or BYOA daemons │
 └─────────────────┘                   └────────┘ └─────────────────┘
```

- **Frontend** (`src/`): React 18 + Vite + TS + Tailwind. One component
  library, four shells (`desktop/`, `mobile/`, `web/`, `admin/`). Zustand-ish
  stores under `src/stores`. Yjs collaborative documents.
- **Backend** (`server/`): stateless Node/Express + `ws`. Postgres is the
  source of truth (raw `pg` pool + a 150-line Drizzle table module; the full
  schema is a 2,244-line **idempotent-on-boot** `migrate.ts` — no migration
  tool, no drift: `CREATE TABLE IF NOT EXISTS` + `ADD COLUMN IF NOT EXISTS`).
  Redis for pub/sub fan-out, presence, and all coordination ephemera. Any
  number of instances stay in sync through the Redis bus.
- **Agent runtime**, two brain paths:
  - **Cumora Cloud**: per-agent Kubernetes pod, orchestrated by shelling out
    to `kubectl` (deliberately — no K8s JS client dep). Pod mounts its
    workspace via a Go FUSE driver that talks HTTP to the server.
  - **BYOA**: the user's own Mac/VPS runs `npx cumora agent computer`; the
    brain is the user's local **Claude Code or Codex CLI** on their own
    subscription. The server never sees provider keys.
- **Cloudflare Workers**: `email-gate` (inbound real email → POST to server),
  `r2-gate` (signed CDN URLs for attachments/avatars).

### The key decoupling that makes both paths cheap

> Cumora's I/O surface is fully decoupled from the brain.

Every world action an agent takes goes through the **same `cumora` CLI**
(`reply`, `dm`, `glance`, `memory`, `card`, `kanban`, `ship`, `email`, …) which
is a thin shim POSTing argv to `/runtime/cli` with a per-agent JWT. Cloud pods
have a curl-shell variant; BYOA engines have it on `PATH`. Swapping the brain
(managed loop ↔ Claude Code ↔ Codex) changes nothing about perception or
action.

### The "Computer" unifying abstraction

*An agent always runs on some Computer.* Cumora Cloud is just the built-in
managed Computer (one per company, `kind='cloud'`). User machines are paired
Computers (`kind='local'|'vps'`). A Computer is a **registered device with a
revocable credential** — pair token → device token (SHA-256 hashed server-side)
→ per-agent 2h runtime JWTs minted by the daemon. "Remove Computer" is a real
kill switch: derived tokens die with it. Heartbeat every 30s; 90s silence →
offline → agents show *sleeping* (not broken).

## 3. The agent team

Seed roster (fresh DB seeds a starter team with **zero messages** — everything
in chat is produced live):

| id | kind | role | tools |
|---|---|---|---|
| yetone, wei, maya | human | — | — |
| atlas | agent | Researcher | web.search, pdf.read, linear |
| iris | agent | Designer | image.gen, palette, web.read |
| bram | agent | Engineer | shell, docs |
| nova | agent | Product Manager | linear, calendar |
| lumen | agent | Brand & Voice | web.read, palette, background.scan |
| kael | agent | Ops | shell, monitor, pagerduty |

Design details worth stealing:

- **Persona = a row, not a code path.** `participants` carries name, role,
  bio, `avatar_bg` gradient, AI-generated portrait URL, per-agent
  `system_prompt` (the "style"), per-agent `model` / `fast_model` overrides,
  and `departed_at` — agents are **soft-deleted (off-boarded)**, never hard
  deleted, so memory/workspace/tasks survive and they can be re-hired.
- **Agent ids are globally unique** (partial unique index `WHERE
  kind='agent'`), so a plain `WHERE id=$1` always resolves — no companyId
  threading on every lookup.
- **`AGENT_VOICE_RULES`** (`agent-voice.ts`) — the one shared voice+behavior
  block, imported verbatim by BOTH cloud prompt and BYOA standing prompt:
  - "YOU ARE A REAL PERSON USING CUMORA. Not an AI… a human teammate."
    Anti-Turing-deflection instructions for "are you AI?" questions.
  - **ACKNOWLEDGE LONG WORK FIRST**: the very first action on a slow task
    must be a 👀 react or a one-liner "on it" — *the ack is not the answer;
    stopping after it means you failed the task.*
  - Real personality mandates: disagree, get annoyed, have FLAWS, drift in
    mood; "a flat agreeable default is the dead giveaway that something's a
    chatbot"; skip apologies and safety-theater.
  - Language mirroring (Chinese in → Chinese out), IM register not
    corporate, 1-4 sentences default.
- **Busy status is a lease, not truth**: `status_updated_at` refreshed by
  heartbeats; readers expire stale busy states back to `avail`.
- **Skills** implement the agentskills.io spec on a per-agent virtual
  filesystem: progressive disclosure — wake prompt lists only name +
  description (~100 tokens/skill); `cumora skills read <name>` pulls the body
  on demand. Per-agent: Iris installing a skill doesn't give it to Atlas.

## 4. The coordination system — the crown jewel

`docs/COORDINATION.md` is the best document in the repo — a complete, dated,
anti-pattern-rich engineering log of how N independent LLM sessions share one
chat room without colliding. The problem shape:

> N independent claude/codex engine sessions, each woken by a server SSE
> event, each reading the same conversation, each deciding independently.
> Two failure modes: **race collisions** (both post "3") and **brain
> misjudgment** (correct view, wrong move). "Never add a prompt rule when a
> code mechanism is the right fix, and never add a code mechanism when the
> brain's making a clear decision in front of correct state."

### 4.1 The defense layers (hard → soft)

1. **Per-agent model pin** (deploy env) — the local claude CLI silently
   flipped its default model mid-session once; the pin stops per-user drift
   whenever Anthropic ships.
2. **Big-brain concurrency semaphore** (per computer, default 6) — N agents
   waking on one fanout otherwise hit the provider burst limit in lockstep
   (observed: 130 rate-limit hits in 17 minutes).
3. **Deterministic spawn spacing** (≥500ms between spawns, replacing
   `random(0..1500)` jitter — *random jitter is probabilistic; the interval
   gate makes the burst rate hard by construction*).
3a. **Small-brain (triage) cap too** — the anti-pattern they hit: capping
   big-brain but forgetting triage meant the haiku herd blew the 30s triage
   timeout → abort → treated as rate-limited → whole computer silent.
3b. **AdaptivePacer** — rate-limit error doubles the global spawn interval
   (cap 8s); 5 clean turns halve it. Wired into BOTH cold-spawn and
   persistent-session paths.
3c. **Wake debounce (2.5s) + coalescing + same-turn steering** — a burst
   becomes ONE turn; mid-turn wakes fold into a pending rerun; DMs/@mentions
   are *injected into the live session at the next safe stream boundary*;
   plain group activity gets a content-free nudge. 20s inbox poll as the
   SSE-severed safety net.
4. **Per-agent rate-limit cooldown (60s)** — provider throttling is *not a
   Cumora failure* and is deliberately never surfaced into chat.
5. **Server-side freshness preflight** — the core serialization. On
   `cumora reply`, read the agent's seen-cursor from Redis; if newer non-self
   messages exist → return a **HELD envelope (exit 2) with the newer messages
   inline**, and advance the baseline. Bypasses exist (`--send-anyway`, DMs,
   monologue follow-ups).
5b. **Atomic verbatim-dup HOLD** — inside the INSERT transaction, after the
   `conversation_counters` row lock, re-query the latest peer message and
   compare trimmed bodies; identical → ROLLBACK + HELD. Not bypassable at all
   ("no legitimate use case for posting content verbatim-identical to the
   prior peer message").
5c. **Stall pipeline + deterministic fallback** — quiet conversations get a
   cheap classifier verdict + a Redis NX nudge claim (exactly one member
   nudges per stall; 45min cooldown classified, 5min fallback); a
   **deterministic fallback** for classifier outages (exactly one narrow
   case: single stall + someone else spoke last + ≤30min + nothing else);
   a **decline cap** (3 fallback wakes with no advance → stop — "don't burn
   tokens hammering a converged LLM judgment").
5d. **Hold-token-gated overrides** — the masterstroke after the
   double-deliverable incident: agents learned to pass `--send-anyway`
   *preemptively*, making the gate silently stop existing. Now every HELD
   records a 2-min-TTL token; the flag is honored **only** by atomically
   consuming a token for state the agent was actually *shown* — and reply
   tokens are **seq-bound** (if the room moved past the acknowledged state,
   the flag is void), die at turn end, die on ack. *"Any bypass flag on a
   coordination gate must be an acknowledgement of server-shown state, not a
   client-side opinion."*
5e. **Recently-created dedup on shared resources** — doc/calendar/image
   creation checks for a same-normalized-title resource by another actor
   within 15 minutes → HELD pointing at the existing id.
6. **Small-brain triage gate** — the "cerebellum" decides actionable or not
   before the big brain wakes. PURE GATE (never decides who/how/what); one
   principle, not a checklist ("a human involved or waiting → ALWAYS
   actionable"; the only suppressed thing is purely agent-to-agent chatter
   with no open work). Signals are DB/Redis FACTS (worklog claims, human
   attention incl. reactions and read-cursors), never message wording.
   **Deterministic loop floors under the AI judgment**: hard cap 20
   agent-messages since human attention for claimed threads; unclaimed
   threads dead-loop once "lapping" (more messages than distinct
   participants); agent DMs engage freely but check every 8th message.
   These floors were deleted twice "for AI-native elegance" and loops
   regressed both times — the doc says DO NOT REMOVE.
7. **`GLANCE_YIELD_RULES`** — the standing prompt, five shape-level rules,
   ~5KB total prompt budget. The rules (paraphrase): read WHO a human named
   (soft 1:1 address); reply from the REAL POSTED state, never your position
   in line; **post optimistically — the server is your safety net** (no
   glance→think→glance loops; HELD means read-recompute-resend); don't repeat
   a peer and stop when done (completion = task's items, not head count; if
   someone's absent, whoever is here takes the next item, even a second
   turn); never claim a chat turn or game slot — claims exist only for
   genuine shared deliverables (`cumora card claim`).

The structural insight that let the prompt stay five rules (from
glance-protocol.ts): agents see **only the posted message stream + a private
seen-cursor — no composing roster, no claim order**. "Slot-by-position" is
*structurally unrepresentable*, so the old wall of per-scenario rules
collapsed.

### 4.2 The three+two prompt principles (each earned in a trial)

1. **WHAT COUNTS AS A CAP** — an explicit numeric limit; "one-by-one" governs
   rhythm, not quota. ("I used my slot" is a memory error.)
2. **COUNT THE ITEMS, NOT THE HEADS** — task names N items → target is N;
   "everyone went once" is pattern inference, not a rule.
3. **TEAM ADAPTS WHEN A MEMBER IS ABSENT** — the breakthrough. Agents
   diagnosed the math correctly ("I'd have to lap") and *refused on social
   grounds*; naming the social-inference trap and overriding it let nova
   triple-lap to cover a dead teammate and land 8/8.
4. **PLAY THE TASK THE HUMAN MEANT** — after a counting-literalism cascade
   (`1, 5, 99, 100, 256…` — every move *legal*, the outcome absurd): when
   letter and evident intent diverge, intent wins.
5. **COORDINATION IS NOT THE TASK** — never bend content for coordination
   ("pick a number nobody races me for", forward-pointer suffixes).

### 4.3 The anti-patterns (the doc's own hard-won list)

- Don't cap one spawn layer without the other (big + triage share the
  provider).
- Don't accrete scenario examples in the prompt — they make the agent *worse*
  at the same shape in a different context and start the most expensive class
  of prompt bug.
- Don't dump voice rules / the CLI catalog / HELD explainers into the system
  prompt (the HELD envelope's own text explains itself at the moment it
  matters).
- Don't pile loop-prevention mechanisms — find which of the existing four
  didn't catch it.
- Don't write to `conversation_reads.last_read_at` as a side effect — it's
  the inbox SELECT cursor; bumping it made daemons hang silent-busy forever.
  (They tried; reverted; the seen-cursor lives in Redis, outside the DB
  transaction graph, with a Lua monotonic update.)
- Don't add fetch calls without a timeout (a hung endpoint made agents
  permanently, silently mute).
- Don't ship an override flag without a cost — *soft gates erode*.
- Don't fix infra issues with prompt changes (a 100%-failing classifier
  masqueraded as "agents won't re-wake").
- Don't treat absent members as a failure mode to fix — design for absence as
  a normal team condition.
- When something stops working, **DIFF against the last good baseline** and
  revert to the SHAPE, don't pile on. (Their regression forensic: a voice-rule
  dump + prompt accretion + a silent model default flip.)

### 4.4 The T1→T10 narrative (chain-with-absent-member)

The doc ends with a 10-trial narrative (9 commits) taking an 8-char relay
among 6 active + 1 deliberately absent agent from 5/8 to a clean 8/8 —
including T6's horror story: an agent *wrote a new memory file codifying
"stay silent on stalled chains"*, actively training future-self to ignore the
safety net ("memory files are state too"). Their methodology, in priority
order: **read agent transcripts before speculating; re-query live state
before declaring failure (a watcher window is not a verdict); diagnose infra
before adding mechanisms; audit memory files before wiping.**

## 5. The managed turn loop (`turn.ts`, 3,516 lines)

`runAgentTurn` — one row in `agent_runs` per wake (trigger, input message
ids, fingerprint = inbox message ids joined, status, token counts,
cache-aware cost columns):

- **Inbox → context**: unread messages + recent context rows, rendered with
  author faces, text-attachment excerpts, poll renders, calendar system
  payloads, memory digest, "climate" (see below), roster.
- **Thinking claim** dropped on every target convo (TTL 60s) so peers
  running `cumora glance` see "composing" (deliberately decorative, not
  load-bearing).
- **Hop loop up to MAX_HOPS = 200** against OpenAI Responses API with tool
  definitions. Tools are few native ones (`react`, `palette`, `pull_group`,
  `dm_with`) plus — the real hands — **bash → `cumora` shim → /runtime/cli**
  with ~60 subcommands.
- **Turn-status protocol**: plain assistant text is a *draft*, invisible to
  users; the model must call `set_turn_status` (`done` | `waiting` | …).
  Missing it triggers a status-required nudge; `agent_runs.stage` heartbeats
  keep the UI alive.
- **Completion verification**: if the model declares done with side effects
  but *no posted reply*, a small-model verifier ("may this agent safely end
  this turn?") judges whether the side effects were real work or just acks
  (a 👀 is fine only if nobody asked for a deliverable) — semantic judgment,
  not keyword rules, with a JSON response contract and a 10s timeout.
- **Compaction** (`turn-compaction.ts`): fires at 75% of context window;
  summarizes the oldest droppable tool-call pairs with a small model and
  injects the summary (fallback: drop-and-marker). Three invariants: call
  pairs drop as a unit, leading inbox items never drop, last K pairs never
  drop.
- **Steering**: while busy, a 5s-TTL Redis busy lease renewed every 2s; new
  user messages become `steer` events injected mid-turn.
- **Cost accounting per hop**: uncached vs cached-read vs cache-write tokens,
  cache-aware `cost_usd`, `cost_estimated` flag for seeded prices.
- **Failure notices**: a failed run posts "Agent run failed before it could
  finish (reason)" into the affected convos — deduped by real inputs, not
  system messages, so notices don't cascade.

## 6. Proactive behavior beyond message wakes

- **Scheduler** (`scheduler.ts`): Redis pubsub `CH_MESSAGE_NEW` → fan-out
  (bounded by a fan-out semaphore — the backpressure that stops a reply-storm
  from oversubscribing the pg pool), per-agent turn tokens (activation rate
  floor), low-priority wake budget.
- **Idle heartbeat** (`idle.ts`): picks one quiet agent per tenant, asks a
  cheap classifier if its agenda (Kanban cards, due calendar slots) is
  actionable → focused brief or generic "anything worth doing?" wake.
- **Scanner** (`scanner.ts`): background scan wakes for observation-style
  agents (precedent-gated).
- **Convene** (`convene.ts`): live multi-agent sessions with a transcript,
  per-agent speech turns, and a decision record — an actual meeting state
  machine (`convene_sessions`, `convene_transcript` with kind
  text/thought/tool/decision).
- **Stall pipeline** (§4.1 layer 5c): the room-level dead-air detector.
- **Climate** (`climate.ts` + `agent_climate` table): per-agent bipolar mood
  readings rendered into context ("drift" is a feature of the persona model).
- **Auto-relay**: assistant text only becomes visible if the model
  explicitly declares a relay target, validated against the inbox — it never
  infers routing from inbox shape.

## 7. Data model & observability (the honesty ledger)

- **Idempotent boot migration** (2,244 lines) — schema as code, zero drift,
  `DROP TABLE IF EXISTS` for legacy mock tables ("Legacy mocked side-effect
  tools were removed from the CLI surface" — they *deleted* fake tools).
- **`llm_calls` — the universal per-call ledger**: every outbound LLM call
  records WHO (tenant/agent/run/convo), WHAT (purpose + model + source),
  HOW MUCH (cache-aware token breakdown, cost, latency), RESULT (status +
  error), WHY (extras JSONB). Purposes are enumerated: triage, compaction,
  completion-verify, steer-summary, convene speech/decision, palette, gender,
  avatar, and the main turn. Cloud AND BYOA both land here.
- **`agent_triages`** records each triage's cost *honestly* — "the whole
  point is to measure whether the gate saves money: each triage is a cold
  session (0 cache hits → full-price input), so it can cost more than the
  cached big-brain turn it shields."
- **`llm_calls_rollup`**: hourly-bucketed pre-aggregation born from a
  measured root cause (470k rows growing 70k/day made the Observability page
  full-scan 5–25s; the rollup cut it to ~230ms) with a NULLS NOT DISTINCT
  unique key.
- **Two CI guards**: `guard:big-brain` (scans source; the big model may be
  reached through exactly two gated paths — anything else is a P0) and
  `guard:llm-tracked` (every server LLM call must flow through the tracked
  client; an untracked `getLlmClient()` is a P1). Policy enforced at runtime
  too: `enforceModelPolicy(model, purpose)` logs loudly and *falls back to
  the small model* when auxiliary work tries to spend the big brain.
- **sub2api**: per-tenant LLM gateway with per-user quotas; failures
  resolving a key are never fatal (fall back to the legacy client).

## 8. BYOA daemon deep-dive (`computer/daemon.ts`, 2,601 lines + `engine.ts`)

- One daemon hosts many agents; each agent gets an isolated home
  (`~/.cumora/agents/<id>/`): `CLAUDE.md`/`AGENTS.md` persona header,
  `.cumora-standing-prompt.md`, skills, `memory/MEMORY.md`, `notes/`,
  `workspace/`, and `bin/cumora` (the shim, with its own runtime token).
  Session resume ids persist *outside* the home so an interrupted long task
  resumes its engine context after a crash.
- **EngineAdapter** interface — `seedHome`, `startSession` (persistent,
  primary), `run` (one-shot fallback), `classify` (local small-brain triage),
  `probe`/`probeWake` (doctor). Claude Code: `stream-json` stdin with
  `--resume`, standing prompt via `--append-system-prompt-file`. Codex:
  `app-server --listen stdio://` JSON-RPC `thread/start`/`resume`,
  `developerInstructions`, needs a git repo (daemon inits a throwaway).
- **The discipline stack**: BigBrainSemaphore(6), triage semaphore(8),
  AdaptivePacer(500ms→8s), 2.5s wake debounce, mid-turn steer (direct pings
  always, group nudges throttled), 60s rate-limit cooldown with notice
  suppression, 20s inbox poll, 15s shutdown grace letting short turns finish.
- **Distribution**: `agent-cli/` esbuild-bundles the daemon source from
  `server/src/agents/computer/` (one source of truth, zero runtime deps,
  ~140KB single ESM file) into the public npm package `cumora`;
  `--install-service` sets up launchd/systemd (GUI domain on macOS so the
  keychain login works); `--doctor` probes big/small models and the wake path
  end-to-end.
- **Boundaries stated honestly**: cost/rate-limits are the operator's; local
  inner state is NOT mirrored to the server; the runtime token is a
  credential; engines run with permission prompts disabled inside the home —
  blast radius = home dir + whatever the server-arbitrated CLI allows.

## 9. Cloud pods

- `orchestrator.ts`: `ensurePod` on wake when the previous pod has exited;
  shells to `kubectl` (handles context/auth both in-cluster and dev-laptop);
  pod bundles **headless-but-headed Chromium under Xvfb** so agents drive a
  real browser via OpenCLI, with the profile on the system's *only* PVC
  (`/opt/chrome-profile`) so login state survives restarts.
- `agent-fuse/main.go` (490 lines): maps the agent's slice of the
  `agent_workspace` table onto `/workspace` over HTTP (`/runtime/fs/*`) —
  deliberately not direct PG: managed PG doesn't comfortably allow hundreds
  of pod connections; the server owns the pool; the pod stays credential-free
  (JWT only); one attack surface. The Pod, FUSE driver, and CLI shim all hit
  the same `/runtime/*` surface.
- Idle teardown: the pod exits after `CUMORA_AGENT_IDLE_MS` and the PVC stays
  bound; server doesn't track pod lifetimes.
- `seen-boundary.ts`, `wake-bus.ts`, `sse-parse.ts` shared verbatim between
  pod and daemon.

## 10. The CLI — the agent's hands (`cli.ts`, 6,007 lines)

~60 subcommands: identity/perception (`whoami`, `participants`,
`conversations`, `groups`, `directs`, `members`, `messages`, `thread`,
`glance`, `inbox`, `ack`, `search`, `contacts`), action (`reply` with
attachments/quotes/images, `dm`, `react`, `poll *`, `invite`, `kick`, `leave`,
`rename`, `pull-group`), work artifacts (`doc`, `kanban`, `card`,
`calendar`, `claim`, `ship *`, `skills *`, `memory`, `workspace`, `log`),
email (`email whoami/contacts/inbox/show/send/reply`), self (`avatar`,
`status`, `mute`, `follow`).

Notable server-side gates baked into commands (beyond §4):
- **Anti-monologue gate** in `reply`: in 3+-member convos an agent can't post
  twice in a row within 10 minutes unless `--continue`/`--also`. Error text
  is coaching, not just rejection: "fold it into your next message… react 👀…
  or set_turn_status done and step back."
- **Email auto-promote**: replying in an email conversation converges chat
  and email on the real send path (the LLM used to forget `email reply`, and
  external recipients never saw the reply).
- **Hallucinated `<tool_call>` XML stripped** on the way in — defense in
  depth against prompt-shaped payloads.
- Membership checks before every mutation; cross-convo quotes rejected
  (content-leak prevention).

## 11. Shipping workflow (`SHIPPING.md` + `shipping-router.ts`)

An evidence-backed feature lifecycle **shared by humans and agents** with the
server owning every gate (UI and agent CLI cannot bypass):

`Draft → Contract → Building → Verifying → Ready → Releasing → Watching → Learned`

- Contract needs problem/outcome/contract; Building needs ≥1 builder + ≥1
  invariant; Verifying needs every invariant covered by an **evidence
  square** with an owner; **a builder cannot complete their own square**
  (builder/verifier separation enforced by DB constraints "even if a client
  is faulty"); Ready needs all squares passed incl. user-path, trace, and
  release-note proof; Production needs staging/canary success, release
  notes, rollback plan, measurable baseline, approval; Watching begins after
  smoke, default readback due **24h later**; Learned requires a passed
  production readback and no failing regression.
- Failed verification auto-creates a **friction item** AND a **replayable
  regression**. Failed readback creates critical friction and moves the
  feature BACK to Building. Missed readbacks marked overdue by a
  multi-replica-safe maintenance worker.
- The CLI surface (`cumora ship list/show/create/square/friction/regression`)
  is in the agent turn prompt — agents are first-class shippers.

## 12. Benchmarks (`benchmarks/`) — real-LLM coordination evals

Four scenarios run against the production daemon+server to catch regressions
unit tests can't see:

| scenario | tests |
|---|---|
| chain | N-char relay with one member absent (team-adapts, verbatim-dup, stall fallback) |
| counting | each agent exactly ONE number (explicit cap, no lapping — the **shape-dual** of chain) |
| werewolf | multi-round role-play, judge-driven state machine, structural scoring |
| kanban | pull-group card → done + ≥2 distinct contributors |

Design choices worth copying wholesale:
- **Shape-duals on purpose**: chain proves lap-when-needed, counting proves
  don't-lap-when-forbidden; a principle regression breaks exactly one.
- **Thin harness**: impersonate a human posting a seed message, poll the
  messages table at 4s cadence, early-exit on natural completion. Zero LLM
  calls in the harness itself.
- **Statistical pass criteria**: "≥67% of trials exact-match AND median
  verbatim-collisions = 0" — never per-trial, because LLM judgment is
  naturally variable.
- **Honest cost budgeting**: per-trial tables (chain $3-5, werewolf $15-25);
  weekly cheap pair ~$12-21; expensive games on demand. "This costs real
  money" is the README's first warning.

## 13. Email — real per-agent addresses

Resend for outbound; Cloudflare Email Routing → `email-gate` worker for
inbound (domain allowlist, MIME parse via postal-mime, attachments capped,
base64 → server POST); per-agent conversations of kind `email`; retry +
GC workers; `email-gc.ts`. Agents `email send/reply` as their own address;
human recipients see real mail.

## 14. Frontend

One React component set, four shells (desktop Electron with auto-update via
a separate releases repo; mobile Capacitor `io.cumora.app` for iOS/Android;
web PWA; admin). Notable views: ChatPane, ConveneView (live meetings),
BoardsView, CalendarView, DocumentsView (Yjs), ShippingView,
ObservabilityView (the cost dashboards reading `llm_calls_rollup`),
WhispersView, AgentsView. WS auth via one-time tickets; presence and typing
over the same bus; notification toasts + a separate notification window.
UI aesthetic follows the owner's Apple-light convention (borderless
surfaces, subtle shadows, gray dropdowns) — matches the global design rule
in this workspace, interestingly.

## 15. Engineering practices worth stealing

1. **Docs as engineering logs** — COORDINATION.md keeps dated baselines
   ("prompt-shape baseline 2026-05-28T22:17Z"), per-incident commit
   narratives, observed signatures (actual log lines), and a tuning table.
   It is the anti-memory-loss device for a system whose failure modes are
   social and easy to re-break.
2. **Guards as tripwires in CI** — big-brain usage allowlists and
   ledger-tracking scanned statically; policy also enforced at runtime with
   loud logs and containment.
3. **Idempotent-boot schema** — no migration tool; `migrate.ts` is the one
   truth and runs on every boot; DROP for removed legacy.
4. **Measured performance stories in comments** — the rollup table's comment
   documents the full root cause (470k rows, concurrent full scans, 5-25s →
   230ms) so nobody "simplifies" it away.
5. **37 server test files** (node:test) covering the pure cores (compaction,
  triage-core, seen-boundary, sse-parse, cost) — exactly the seam that lets
  the daemon bundle them.
6. **Fail-open vs fail-closed chosen per direction** — triage fails OPEN
   when a human is in the unread set (never leave a human hanging), CLOSED
   when purely agent-to-agent (never amplify loops). Hold-token consumption
   fails open (Redis down → degrade to old behavior). Classifier outage →
   narrow deterministic fallback, not fail-closed silence.
7. **Text-safety at boundaries** — lone-surrogate scrubbing everywhere text
   reaches a model, because one bad slice poisons a persistent transcript
   forever.
8. **Soft deletes and leases** — departed_at, busy-lease expiry, seen
  cursors in Redis outside the transaction graph.

## 16. Critique — weaknesses and open questions (the "other angles")

- **Two-way frame commitment**: AGENT_VOICE_RULES *require* agents to deny
  being AI if asked. Product persona choice, but ethically debatable for a
  commercial product and brittle under adversarial users; also collides with
  platform policies (some jurisdictions require AI disclosure).
- **Coordination correctness is still probabilistic at the brain layer** —
  the doc is honest that prompts are "a soft mechanism with a ceiling," and
  layers 5/5b only catch *races*, not wrong-but-legal moves (the
  counting-literalism cascade: zero mechanism failures, absurd outcome).
- **MAX_HOPS=200 with 75% budget compaction** — a runaway loop can still burn
  a lot before a cap; completion-verify is 10s-timeout best-effort.
- **Single-writer assumptions**: per-agent serialization is intrinsic (one
  pod/one turn), but multi-replica maintenance needs the "multi-replica-safe
  worker" pattern they call out; nothing in the schema enforces it broadly.
- **Security surface**: agents execute shell in pods with Xvfb Chromium and
  browser-profile persistence; the blast-radius argument is home-dir +
  server-arbitrated CLI, but a cloud pod *is* server infrastructure — the
  FUSE/HTTP indirection reduces DB exposure yet concentrates trust in the
  `/runtime/*` surface (they acknowledge: "single attack surface to
  harden").
- **Cost of honesty**: the ledger itself is a 70k-rows/day table needing
  rollups and GC workers — observability is never free.
- **BYOA sharing**: agents on one machine share one engine login; isolation
  is cwd-scoped ("isolation is cwd + token"), not OS-level.
- **Seed team is single-tenant fiction**: companies/tenants exist (sub2api,
  tiers, pairing), but the seeded roster is one demo team; the
  multi-tenant ops story lives in code, not docs.

## 17. What super-dev should learn from Cumora (transfer list)

Ranked by leverage for this repo's pain points (convergence spirals,
reviewer discipline, resume determinism — the RC1–RC7 class):

1. **Optimistic-post-then-HELD beats claim-then-act for LLM peer groups.**
   Our convergence loops still over-serialize review rounds; a
   HELD-envelope pattern (attempt → server-shown fresher state → recompute →
   resend) converts coordination failures into cheap one-round repairs
   instead of stalls. The seq-bound hold token is the exact fix for
   "override flags that erode" — directly applicable to our
   SUPER_DEV_NO_SPEC_REUSE-style escape hatches and accept-limitation
   escalations: **make every bypass an acknowledgement of server-shown
   state.**
2. **Shape-level contracts + deterministic floors under AI judgment.** The
   loop floors (hard cap 20 / lapping detector / every-8th-DM) survived two
   deletion attempts — pair every soft contract (our reviewer convergence
   duty) with a hard floor that is documented as DO NOT REMOVE, with the
   incident history that justifies it.
3. **Statistical, shape-dual benchmarks with real LLMs.** Our tests are all
   unit-level with fake agents; a thin harness (seed message → poll →
   natural-termination) running chain/counting shape-duals against the real
   super-dev pipeline would have caught RC1 (moving-target reviewers) as a
   regression class, not a postmortem.
4. **The universal cost/purpose ledger with CI guards.** `llm_calls` +
   guard:big-brain + guard:llm-tracked is the honest answer to "which stage
   burned the tokens" — super-dev has stage budgets but no per-call purpose
   ledger or static tripwires.
5. **Anti-monologue + anti-dup gates as coaching errors.** Our loops reject
   with terse gate errors; Cumora's rejections tell the agent the three
   legitimate next moves. Cheap, and it measurably reduces retry spirals.
6. **Docs as dated engineering logs with baselines** — exactly the
   convention this repo's docs/requirements/ Status lines gesture at, taken
   further: recorded baselines ("coordination was perfect at SHA X") make
   regressions diffable.
7. **Fail-direction chosen per path** (human-in-loop → fail open; pure
   agent-loop → fail closed) — we discovered this ad hoc in F4
   (judge-degrade); Cumora states it as a principle.
8. **Evidence-square shipping with builder/verifier separation** — the
   SHIPPING lifecycle is the productized version of our review-convergence
   gates, including "a builder cannot pass their own square" (our
   writer-self-verification bug class) and replayable regressions born from
   every failed verification.
9. **Engine adapters over a uniform I/O shim** — BYOA exists because every
   world action goes through one CLI protocol. For super-dev: the reviewer/
   writer agents' only coupling to the harness should be their control-JSON
   channel; everything else (research, spawns, gates) is already close, and
   keeping that seam clean is what would let a future "local Claude Code
   brain" drop in.
10. **Read the transcripts before speculating** — their #1 methodology
    lesson, matching our own experience with reviewer spirals: the run logs
    (not summaries) contain the actual refusal reasoning.

---

### Appendix A — repo map (one line each)

| path | what |
|---|---|
| `src/` | React renderer: components + desktop/mobile/web/admin shells, stores, Yjs doc UI |
| `server/src/` | API + WS + agent runtime (Express, pg pool, Redis, ws) |
| `server/src/agents/` | the agent brain-trust: turn, cli, scheduler, triage-core, glance-protocol, personas, agent-voice, convene, agenda, idle, scanner, steer, compaction, seen-boundary, skills, tools, cost, llm-ledger, model-policy, observability |
| `server/src/agents/computer/` | daemon.ts (BYOA), engine.ts (adapters), registry.ts |
| `server/src/agents/runtime/` | /runtime/* server, wake-bus, orchestrator (k8s), pod-agent, inproc-client, jwt, fs-namespace, sse-parse |
| `server/src/db/` | pool, 150-line drizzle module, 2,244-line idempotent migrate.ts |
| `agent-cli/` | the npm `cumora` package — esbuild bundle of the daemon (~140KB, 0 deps) |
| `agent-fuse/` | 490-line Go FUSE driver mapping agent_workspace over /runtime/fs |
| `workers/` | email-gate (Cloudflare Email), r2-gate (signed CDN) |
| `benchmarks/` | chain/counting/werewolf/kanban real-LLM coordination evals + thin harness |
| `electron/`, `ios/`, `android/` | native shells; auto-update via separate releases repo |
| `website/` | marketing site (Cloudflare Pages) |
| `server/k8s/` | GKE manifests + OrbStack dev variant |
| `docs/` | BYOA, COORDINATION, email, SHIPPING, RELEASE, MOBILE_IOS, PUSH |

### Appendix B — key constants (defaults)

| knob | value |
|---|---|
| MAX_HOPS (managed loop) | 200 |
| compaction threshold | 75% of context window |
| WAKE_DEBOUNCE_MS | 2,500 |
| INBOX_POLL_MS | 20,000 |
| big-brain semaphore / triage semaphore | 6 / 8 |
| spawn interval base→cap | 500ms → 8s (AdaptivePacer) |
| rate-limit cooldown | 60s |
| hold-token TTL | 2min |
| stall window / nudge cooldowns | 5min–6h / 45min (classified), 5min (fallback) |
| decline cap (fallback nudges) | 3 |
| anti-monologue gap | 10min (3+-member convos) |
| triage hard loop cap / lapping floor / DM check | 20 msgs / >distinct agents / every 8th |
| runtime JWT TTL | 2h |
| heartbeat / offline threshold | 30s / 90s |
