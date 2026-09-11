Status: ANSWERED (grill pass 2, 2026-09-11 — async-subagent question deep-verified against pi-subagents 0.67 source; no code changes)

# What's the difference between how super-dev spawns subagents vs how pi does with async — can we use the same?

**Short answer:** they share the same substrate — child `pi` processes via pi-subagents (super-dev's active backend; the codebase also retains the legacy in-process session and raw-subprocess backends, `delegation-backend.ts:4-5`) — but they are two different *contracts* on top of it. Unifying the spawner would buy little; what differs is orchestration, lifecycle, and who decides continuation.

**pi-native subagents (what this session uses for grill/review/implement groups):**
- General delegation primitive: parent LLM session spawns a child with an arbitrary task, optional skill(s) (per-call `skill` param), model override, fresh/fork context, tool allowlist.
- `async: true` = detached background run with a durable status dir + a *native completion notification* that wakes the parent session; `async: false` blocks the parent.
- Interactive lifecycle: supervisor channel (`contact_supervisor` — one-question-at-a-time HITL), steer/resume for live or finished runs, intercom between sessions, artifacts and session logs.
- Budgets: optional per-child toolBudget/usageBudget; the parent agent is the orchestrator.

**super-dev's agent spawning (agent-runtime.ts, sd-* roles):**
- Engine-driven pipeline roles: each call carries a role prompt + TypeBox control schema + structured-output parser, wrapped in harness machinery (gates, TDD boundary, judge verification, convergence loops, replan circuit).
- No interactivity mid-stage by design: no supervisor channel exists in any sd-* path — deterministic gates and the judge route outcomes instead (P4: prompts advisory, enforcement mechanical). The human is reached only at *terminal boundaries* as soft-HITL escalations (judge `fix-environment` → `next=<human: escalate>`, no-progress, the F5 judge+human fallback).
- Async semantics are *awaited* calls inside stages, bounded per tier (code 30min / review 30min / writer 30min / default 20min incl. judge as of v0.3.85, `agent-runtime.ts:758-833`) and globally by the **maxAgents spawn budget only** (`types.ts:227-237` — `check()/spent()/count`; there is NO cost or token budget in the engine — token/cost are *observed* per call in `usage-calls.jsonl` per the v0.3.75 attribution-first doctrine, never enforced), plus the run wall fuse (`partial (wall-fuse)` wind-down, v0.3.85) and per-child toolBudget (v0.3.87). The ENGINE decides continuation, not a parent LLM.
- Lifecycle is the run's: resume cache, phase commits, HARNESS_FILE_ROLES ledger discipline.

## Grill pass 2 — the real question: can the engine use pi's *async* subagents (this session's worker/reviewer pattern)?

**Verified against pi-subagents 0.67 source (2026-09-11): it already does, at the machinery level. The only difference is who waits.**

The full chain, code by code:

1. super-dev emits `prompt-template:subagent:request` with a `SubagentDelegationRequest` (`delegation-backend.ts` — mirrored locally, no runtime import, per the no-runtime-import contract rule).
2. pi-subagents' bridge (`src/slash/prompt-template-bridge.ts:182`) validates the request, keys the attempt `(requestId, ownerRunId, nodeId)`, rejects still-ACTIVE duplicates (`duplicate_node` — the v0.3.84 incident class), creates a per-attempt `AbortController`, emits STARTED, then **`await executor.executeDelegated(requestId, params, signal, ctx, onUpdate)`** (`extension/index.ts:746-749`) — the SAME foreground subagent-executor that serves the `subagent` tool's children. Progress flows back as UPDATE events (currentTool, recentTools, narration lines — all consumed by super-dev since v0.3.28); the terminal state returns as one RESPONSE event → `SpawnResult`.
3. So the child execution is **already asynchronous and event-surfaced end-to-end**. super-dev's `await` is purely the *client-side* choice to wrap the terminal event in a Promise — the exact same execution the async tool run gets, minus the detached-run wrapper.

**What the async tool path has that the delegation path does not** (the actual delta):

| Capability | async tool run (`async: true`) | delegation request (today) |
|---|---|---|
| child executor | same `subagent-executor` | same — verified |
| progress events | yes | yes (UPDATE events, consumed) |
| usage accounting | yes | yes (`SubagentDelegationUsage`) |
| cancel/timeout | yes | yes (cancel event + AbortController) |
| Fleet rows / attribution | yes | yes |
| **durable run dir** (status.json/events.jsonl, survives parent death) | yes | **no** — in-memory attempt registry only |
| **native completion wake** (parent session notified) | yes | **no** — caller awaits the terminal event |
| steer/resume mid-run | yes | only via the pi UI on the child session, never engine-initiated |

**Why the engine chose the awaited wrapper — and why that is correct for now:**

- The pipeline's nodes ARE awaited promises by contract; the DAG (`parallel`/`map`/`loop`) already expresses every concurrency the stage gates allow (e.g. the 3-way review fan-out). There is no conversation to keep responsive — the pipeline is the parent's only job, so "don't block the parent" buys nothing.
- Budgets, tier timeouts, the agent-error fuse, and the run wall fuse are enforceable *precisely because* every call is awaited (P3/P8). Detached children would spend after budget death unless every loop re-enumerated late-completion paths — a full P3 failure-path re-write.
- An steerable-by-default engine child is the P1/P4 hazard (oracle/gate discipline) — kept off by design.

**What adopting detached-runs semantics would really take (the §11-era fork, now concrete):**

1. **Upstream gap**: `SubagentDelegationRequest` (pi-subagents `src/api/delegation.ts`) has **no async/detached flag** — the delegation API cannot request durable-run semantics today. Engine adoption means either (a) an upstream ask — "async/detached flag on SubagentDelegationRequest, engine consumers get status-dir-backed children + a completion event" — or (b) super-dev bypassing the delegation transport for the runs API directly (a rewrite of delegation-backend's transport layer).
2. **What it would buy**: engine-crash durability (live children outlive the extension process; resume reattaches instead of re-running — a crash-only-replay posture), first-class steerability (hazard, opt-in only), per-specialist session artifacts.
3. **What it would cost**: wake plumbing through the node algebra, budget/fuse re-plumbing for late completions, and re-proving every P3 failure-path table the v0.3.85 wave just closed.

**Verdict: same machinery — already in use; same async contract — not available through the delegation API, not wanted by the engine's current design, and properly an §11-era decision with a concrete upstream ask.** (Doc nit found while reading: `delegation-backend.ts`'s header still says the mirror is "versioned against pi-subagents@0.58.0" while the install is 0.67 — the fields have been re-verified through S4 (toolBudget) but the version note is stale; fix opportunistically at the next touch of that file.)

**"Can we use the same?" (surfaces, not governance):** it keeps happening where it makes sense — the extension channel (`commonExtensions`/`agentExtensions`, live since v0.3.78) serves super-dev capability agents through the same extension set, and **v0.3.87's S4 made per-child `toolBudget` + the five-family external-exploration block list literally the same config-resolved mechanism on both sides** (zero hardcoded numbers). The skills channel remains a real divergence: super-dev's curated/ambient tiers + `SUPER_DEV_SKILLS` vs pi-native's per-call `skill` param. What should NOT be unified blindly: pi-subagents' interactive steering exists to serve a human-in-the-loop parent; super-dev's agents must stay mechanically governed (P1/P4) — an sd-implementer that could be steered ad-hoc mid-phase would break phase-commit and RED-oracle discipline (the same hazard class the 09-09 postmortem's C-family escape taxonomy exists to prevent; no version-number citation — the original "v0.3.43-era" reference was fabricated and removed in grill pass 1). Full spawner unification is an §11-era architecture question, not a v0.3.85 one.
