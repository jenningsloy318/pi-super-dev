# Architecture: migrate from pi-subagents to @earendil-works/pi-agent-core

Status: proposed (research-backed; the migration decision and rollout plan). Lineage:
replaces the C1–C6 contract-surface watch (docs/upstream-watch.md) with a
first-party foundation. Evidence: four registration-failure runs
(2026-09-21T14-27 through 15-19, 19/19 Unknown-agent each) + the first
healthy run's 8-hour wall (2026-09-21T15-30-29).

---

## 0. Why (the receipts)

| Incident class | Root cause | pi-subagents mechanism | Cost |
|---|---|---|---|
| Registration rejection | Upstream removes a definition field (completionGuard, #2356) | `validateDefinition`'s supported-set is a moving target | 4 dead runs × 19 calls each |
| Host-SDK resolution | pi 0.86 stopped serving virtual module resolution to extension code | `resolveInstalledPiPackageRoot` walks the install tree at runtime | 1 dead run + symlink workaround |
| Version skew | `*` peer-deps resolved against whatever the host loaded | `child-session.js` finds the host's pi packages at spawn time | 3 incidents (2026-09-04/05) |
| **Common factor** | **The delegation seam**: two packages negotiating at runtime through events, field validation, and package resolution | | **Every breakage was at this seam, never in the core agent machinery** |

## 1. What pi-agent-core gives us (verified locally, 0.87.0 installed)

- **`Agent` class**: stateful wrapper owning the transcript, tool execution,
  and lifecycle events (`agent_start` → `agent_end`). Constructed with
  `initialState: { systemPrompt, model, thinkingLevel, tools, messages }`,
  a `streamFn`, and hooks:
  - `beforeToolCall` → **the mechanical tool gate** (our P4 enforcement layer:
    block out-of-scope tools deterministically, no prompt advisory)
  - `afterToolCall` → result amendment or `terminate`
  - `finishTurn: {action: "end"|"continue"}` → **the no-progress valve** (our
    bounded-loop machinery: own the continue/stop decision deterministically)
  - `prepareRequest` → per-call model/thinking resolution
- **`agentLoop` / `agentLoopContinue`**: low-level async-event-stream loop.
- **`AgentHarness`**: mid-level with lanes, compaction, skills.
- **Session persistence**: `StorageBackedSession`, `MemorySessionRepo`,
  `JsonlSessionRepo`, fork/commit.
- **SDK level** (pi-coding-agent, not agent-core itself):
  `createAgentSession({ model, tools, customTools, sessionManager,
  modelRuntime })` — the ergonomic entry point for child sessions with
  tool sets.

**Naming correction from the research**: `AgentSession`, `createAgentSession`,
and `ModelRuntime` are exported by the **pi-coding-agent SDK**, not by
pi-agent-core directly. pi-agent-core exports `Agent`, `agentLoop`,
`AgentHarness`, and session persistence primitives.

## 2. The proposed architecture

```
BEFORE (today):
pi-super-dev → events.emit(delegation-request) → pi-subagents owner
  → validateDefinition → registerRuntimeAgent → child-session.ts
  → resolveInstalledPiPackageRoot → import host SDK → Agent
  → streamFn → pi-ai → provider

AFTER (proposed):
pi-super-dev → new Agent({ initialState, streamFn, hooks })
  → pi-ai (pinned in OUR package.json) → provider
```

**What this deletes**: the event protocol, the registration handshake, the
field validation, the host-package resolution, the version-skew surface.
**What this keeps**: everything deterministic in OUR code (tools gates,
finish-turn valves, budgets, gates — all our wave-1/3 machinery).

## 3. The mapping (our machinery → agent-core hooks)

| pi-super-dev mechanism | pi-subagents today | pi-agent-core after |
|---|---|---|
| Per-role tool allowlist | `tools: [...]` in registration definition | `initialState.tools` + `beforeToolCall` blocking |
| Read-only enforcement | `excludeTools` + engine-side source boundary | `beforeToolCall` returns `{block: true}` for write tools |
| Timeout | `timeoutMs` on the delegation request | Our own `AbortController` + `agent.abort()` |
| Model/thinking per role | `model` field on the delegation request | `initialState.model` + `prepareRequest` |
| Completion semantics | delegation `status=completed` | `agent_end` event + `waitForIdle()` |
| Steering (mid-run user input) | delegation `steer` event | `agent.steer()` |
| Progress events | delegation progress events | `agent.subscribe()` lifecycle events |
| Turn budget | `toolBudget` on registration | Our own counter in `afterToolCall` |
| Skills | `inheritSkills` + per-call `skill` | `initialState.messages` injection (our own) |
| Extensions (web tools etc.) | `extensions` on registration | Load in OUR process, pass tools directly |

## 4. Migration plan (incremental, dual-backend)

**Wave 1 (adapter)**: a `PiAgentCoreBackend` implementing our existing
`AgentBackend` interface (the same shape `runAgentViaDelegation` satisfies).
Uses `new Agent(...)` per call with per-role `initialState`. The existing
delegation backend stays as fallback (`SUPER_DEV_BACKEND=delegation`); the
new one activates with `SUPER_DEV_BACKEND=agent-core`.

**Wave 2 (cleanup)**: delete the delegation backend, the registration
machinery, the event-bus dependency, and the C1–C6 watch items. The
extension's peerDependency moves from `pi-subagents` to
`@earendil-works/pi-agent-core` (pinned exact version).

**Wave 3 (optimization — the 8→3 hour path)**:
- WS7's parallel review fan-out becomes trivial: `Promise.all([new Agent(...),
  new Agent(...), new Agent(...)])` — no delegation owner bottleneck.
- The 145 min of harness gaps shrink: no registration handshake, no event
  round-trip, no child-session resolution.
- The spec stage's 18-round loop: the finish-turn hook gives us
  deterministic stop conditions the delegation layer can't express.

## 5. Risks and mitigations

| Risk | Mitigation |
|---|---|
| pi-agent-core is 0.x (5 breaking changes in 0.87.0 alone) | Pin exact version in OUR package.json (not `*`); changelog-watch at every session start (our existing upstream-watch discipline) |
| Duplicated provider catalogs (our pinned pi-ai vs the host's) | Accept for self-contained Agents; share via `modelRuntime` if the SDK surface allows |
| Loss of Fleet UI visibility | The delegation events fed pi-subagents' Fleet dashboard; agent-core has no equivalent — our own progress events + run-log remain the surfaces |
| Loss of `advertise:` prompt visibility | Non-critical; our specialist prompts are already self-contained |
| Unknown unknowns in a first migration | The dual-backend design means the delegation path stays available; switch is per-run via env |

## 6. The stability argument (the honest picture)

pi-agent-core changes **slightly less often** (48 releases/4 months vs 135/9
months) and **far more predictably** (disciplined changelog with before/after
migration snippets; repo pins exact deps + sets min-release-age=2). But the
real stability gain is **deleting the seam**: our four registration failures
were all at the pi-subagents delegation protocol boundary — field
validation, host-package resolution, version negotiation — never in the core
agent machinery. Coding directly against `Agent` + `streamFn` + hooks
removes that boundary entirely.

## 7. Non-goals

- No change to the 14-stage pipeline architecture, the convergence economy
  machinery (WS0-WS7), or the deterministic gates — those are ours and they
  stay.
- No subprocess isolation (the official subagent example's pattern) — that's
  a separate escalation if in-process proves insufficient.
