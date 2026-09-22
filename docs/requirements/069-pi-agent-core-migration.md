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

## 4. Migration plan (direct cutover — delegation deleted in the same wave)

**Wave 1 (replace + delete)**: a `PiAgentCoreBackend` implementing the
existing `SpawnResult` contract, using `new Agent(...)` per call with
per-role `initialState` + shared `streamFn`/pi-ai instance. In the SAME
commit: delete the delegation backend (`src/agents/delegation-backend.ts`),
the registration machinery (`src/agents/register-agents.ts`), the
event-bus dependency, the runtime-agent-registration events, and the C1–C6
upstream-watch items. The extension's peerDependency moves from
`pi-subagents` to `@earendil-works/pi-agent-core` (pinned exact) +
`@earendil-works/pi-ai` (pinned exact). NO dual-backend — the user's
directive: the delegation path is deleted, not kept as fallback.

**Wave 2 (optimization — the 8→3 hour path)**:
- WS7's parallel review fan-out becomes trivial: `Promise.all([new Agent(...),
  new Agent(...), new Agent(...)])` — no delegation owner bottleneck.
- The 145 min of harness gaps shrink: no registration handshake, no event
  round-trip, no child-session resolution.
- The spec stage's 18-round loop: the finish-turn hook gives us
  deterministic stop conditions the delegation layer can't express.

## 4.5 Grill round 1 (2026-09-22) — research + code-analysis folded

| # | Sev | Question | Answer |
|---|---|---|---|
| Q1 | HIGH | Where does `streamFn` come from? | `ctx.modelRegistry.streamSimple.bind(ctx.modelRegistry)` — the ExtensionContext exposes the host's ModelRuntime facade with request-time auth (host's auth.json credentials, not env vars). The pi-agent-core default (`getDefaultStreamFn()`) only reads env keys (`ZAI_API_KEY`) — must be OVERRIDDEN with the host's registry binding. The maintainers explicitly sanction extension-level Agent construction (sdk.js:19-22 comment). |
| Q2 | HIGH | Tool format: built-in or custom? | SDK re-exports factories: `createReadTool, createBashTool, createEditTool, createWriteTool, createGrepTool, createFindTool, createLsTool` (dist/core/sdk.d.ts). Import from `@earendil-works/pi-coding-agent`, not agent-core. Custom tools: pi-ai `Tool` interface with TypeBox `parameters` + `execute()`. |
| Q3 | HIGH | One-shot Agent per specialist call: overhead? | CONFIRMED correct pattern — pi-subagents 0.70.1 does exactly this (`src/watchdog/review.js:285-297`). Constructor allocates only state/queues/listeners (no provider client). Share `streamFn` + tool array across Agents; hoist once. AgentHarness is NOT for this (it's interactive/long-lived session machinery with lanes/compaction). |
| Q4 | HIGH | Can an extension import pi-agent-core? | YES — the extension loader's `getAliases()` maps `@earendil-works/pi-agent-core` to the host's copy (loader.js), and `virtual-modules.js` embeds the same for bundled builds. jiti resolution base is the HOST loader. No own runtime dep needed. BUT: needs a `devDependency` in OUR package.json for tsc/vitest to resolve (runtime uses the host's copy — expect API drift between the pinned dev version and the host). |
| Q5 | MED | `beforeToolCall` can only block, not modify args | Confirmed: `BeforeToolCallResult = {block?: boolean, reason?: string, terminate?: boolean}` — no modified-args field. Arg-level enforcement (path restriction, etc.) moves INTO the tool's `execute()` (our own tool wrappers). |
| Q6 | MED | `finishTurn` semantics vs our P8 valves | `finishTurn` fires after each assistant turn; `{action:"end"}` stops. Cross-turn no-progress needs our own state in the adapter (signature history, attempt counters). |

**Key architecture decisions confirmed by the research:**

1. `streamFn` = `ctx.modelRegistry.streamSimple.bind(ctx.modelRegistry)` — carries the host's auth (auth.json), not env vars.
2. Tools from `@earendil-works/pi-coding-agent` SDK re-exports (createReadTool etc.), NOT from agent-core directly.
3. One-shot `new Agent(...)` per call — same pattern pi-subagents itself uses internally.
4. Extension import works via the host's alias map; add `devDependency` for repo-level typecheck.
5. Import discipline: `Agent`/`StreamFn` from agent-core; everything else from the documented `pi-coding-agent`/`pi-ai` entries (the tintinweb/pi-subagents lesson: reaching into agent-core's internals broke under strict resolvers).

## 4.7 Grill round 2 (2026-09-22) — implementation-detail frontier

| # | Sev | Question | Answer |
|---|---|---|---|
| Q1 | HIGH | Concurrent Agents sharing streamFn safe? | YES — structurally safe. Every Agent field is instance-scoped; no module-level mutable state; each run creates its own AbortController; per-request auth (serialized credential writes via per-provider promise-chain mutex); no connection pool or token bucket. Genuine hazard: provider-side rate-limit amplification — N shards fire N simultaneous requests, each retries 429s independently. Mitigate: cap shard width or stagger. |
| Q2 | HIGH | Result extraction API? | pi-subagents' own pattern: `state.messages.findLast(m => m.role === "assistant")` (review.js:317). Text = `content.filter(c => c.type === "text").map(c => c.text).join("")`. Caveat: on abort/error, a synthesized assistant message with `stopReason: "aborted"|"error"` and EMPTY content is pushed — always check stopReason before parsing. Cleaner: subscribe to `agent_end` event → `event.messages` (the run's messages, not global tail). |
| Q3 | HIGH | Abort/timeout? | `agent.abort()` (no reason param). Pattern: `setTimeout(() => agent.abort(), ms); await agent.waitForIdle(); clearTimeout(timer)` then read trailing message's stopReason. Post-abort state is clean: transcript ends with aborted-marker message, waitForIdle resolves. Tool execute() receives AbortSignal — tools that honor it stop; tools that ignore it are awaited to completion (loop checks between tools). CRITICAL: never fire-and-forget abort — always await waitForIdle before reading state (pi#2716: raw abort during bash crashed Node via unhandled AbortError). |
| Q4 | HIGH | devDependency version drift? | Already the repo's pattern: `peerDependencies: "*"` (runtime = host's copy via alias map), devDeps pinned for tsc/vitest. Add two guards: (a) host floor check at extension load, (b) contract tests asserting the exact Agent surface used (abort signature, agent_end.messages, stopReason values). Verified: 0.82→0.87 drift on Agent/state/agent_end surfaces is NIL. Avoid runtime instanceof against devDep classes (two copies make them lie). |
| Q5 | MED | agent_end listener settlement | waitForIdle resolves after ALL awaited listeners settle — keep subscribe listeners lightweight or synchronous |
| Q6 | MED | AbortSignal ownership | agent.signal getter exposes the ACTIVE run's controller; abort() fires it; our own setTimeout wrapper owns the timing |

**Key new patterns for the adapter:**
- Result extraction: prefer agent_end subscription collector (`event.messages`) over trailing-message scan; fallback scan MUST check stopReason
- Timeout: setTimeout(abort) + await waitForIdle + clearTimeout — never abort-then-immediately-read
- Concurrency: Promise.all one-shot Agents is safe; cap shard width for provider rate limits
- Version drift: peerDependencies "*" + devDeps pinned + contract tests on the exact API surface

## 4.9 Grill round 3 (2026-09-22) — deletion-and-integration frontier

| # | Sev | Question | Answer |
|---|---|---|---|
| Q1 | HIGH | What do we lose when pi-subagents is deleted? | NET LOSS = Fleet UI rows only (cosmetic; display-only best-effort). Our own watchdog.ts uses only node:child_process (stays). Background machinery: never used. pi-subagents' server-side toolBudget: must re-implement (counter in afterToolCall). Child extension loading: we ALREADY have agent-runtime/{extensions,config-extensions}.ts using SDK's createAgentSession. Structured-output validation: we already have our own (structured-output.ts). |
| Q2 | HIGH | ThinkingLevel values? | core: "off"\|"minimal"\|"low"\|"medium"\|"high"\|"xhigh"\|"max" — exact match with our THINKING_LEVELS (thinking.ts:23). Per-request via SimpleStreamOptions.reasoning. Clamp via pi-ai's clampThinkingLevel (getSupportedThinkingLevels also exported). 1:1 port. |
| Q3 | HIGH | Usage/token tracking? | On every assistant message: `usage: Usage` {input, output, cacheRead, cacheWrite, reasoning?, totalTokens, cost:{input,output,cacheRead,cacheWrite,total}}. After waitForIdle: sum over role==="assistant" messages; turns = assistant count; toolCalls = toolCall content parts count; durationMs = our own timing. No aggregation helper exists — we write a simple reduce. Richer than pi-subagents' terminal events (per-turn deltas for free). |
| Q4 | HIGH | Model string → Model<Api>? | `ctx.modelRegistry.find(provider, modelId)` after `await ctx.modelRegistry.refresh()`. Split "zai-coding-cn/glm-5.3-flash" on first "/" → provider + modelId; ":high" suffix stays OUR convention → strip before find, feed to thinkingLevel. Guard undefined return — fail loudly. |
| Q5 | MED | The extension-loading path for child agents | Already exists: agent-runtime/extensions.ts + config-extensions.ts call createAgentSession + DefaultResourceLoader from the SDK — the deleted session backend's loader. Direct reuse. |
| Q6 | MED | toolBudget enforcement | pi-subagents' server-side validation disappears. Re-implement: counter in afterToolCall (our existing toolBudget config surface stays; the enforcement point moves). |

## 4.11 Grill round 4 (2026-09-22) — failure modes and edge cases (code-analysis; research quota-blocked)

| # | Sev | Question | Answer |
|---|---|---|---|
| Q1 | HIGH | Extension lifecycle: in-flight Agents at session end? | Agent has NO dispose/cleanup (only reset()). Adapter must abort+waitForIdle all active Agents on deactivate; without this, a hanging streamFn hangs the process (issue #2381 class). |
| Q2 | HIGH | Model rotation between prompt() calls? | AgentState.model is mutable ("Active model used for future turns"). Reassigning takes effect on next streamFn call. Model changes are NOT announced to the model (unlike tool changes via declareToolChanges). Our one-shot pattern never needs mid-Agent rotation — retry = new Agent. |
| Q3 | HIGH | Hanging streamFn: Agent has NO internal timeout guard | grep timeout/watchdog/hang in agent.d.ts + agent-loop.js = zero. The ONLY escape is external agent.abort(). Adapter MUST wrap every prompt() in setTimeout(abort, timeoutMs) + await waitForIdle() + clearTimeout — no exceptions. |
| Q4 | HIGH | Context window overflow with 30-60k prompts? | Model.contextWindow + Model.maxTokens exist in pi-ai types, but agent-core has NO truncation/compaction (compaction lives in AgentHarness — we don't use it). For one-shot calls: 30-60k prompt + 128k+ context = safe. On overflow: provider returns error (stopReason: "error" + errorMessage). Adapter should pre-check contextWindow and fail early with a clear message. |
| Q5 | MED | Adapter obligations (new, from Q1-Q4 synthesis) | The adapter contract gains three hard invariants: (1) EVERY prompt() is timeout-wrapped — no bare calls; (2) deactivate aborts + waits all active Agents; (3) contextWindow pre-check before prompt. These are mechanical, not advisory (P4). |

## 4.13 Grill round 5 (2026-09-22) — the adapter integration surface (convergence sweep; GRILL CLOSED)

| # | Sev | Question | Answer |
|---|---|---|---|
| Q1 | HIGH | Shared tool instances across Agents? | YES — create once, share across N Agents. Factories are stateless-per-call (module constants only; bash spawns fresh shell per execute; no persistent state). The global file-mutation queue (withFileMutationQueue) serializes same-file writes across ALL Agents in the process — a cross-Agent safety IMPROVEMENT. Caveat: pin version + one concurrent contract test (the guarantee is structural, not documented). |
| Q2 | HIGH | Extension loading (pi-web-access etc.)? | **The genuine architectural constraint of the migration.** Raw Agent has NO extension surface. Three paths: (1) createAgentSession for extension-needing children (the SDK path — officially documented, but reintroduces session-manager coupling), (2) hand-rolled ResourceLoader + merge tools into initialState (re-implements AgentSession — wiring risk), (3) call extension tool surfaces directly as custom tools. RECOMMENDATION: hybrid — raw Agent for plain coding specialists; createAgentSession children ONLY where pi-web-access/pi-mcp-adapter are required (research-agent, qa-agent). |
| Q3 | MED | Structured output? | NO response-schema API in the base Agent. The pi-native pattern is a typed TOOL: one `structured_output` AgentTool whose parameters IS the schema; the child calls it to finish; validated args from the tool result. For strict enforcement: constrainedSampling {type:"json_schema", strict:"require"} on the tool (per-model support). Our <control> text-extraction pattern also works (zero change). |
| Q4 | HIGH | Multi-turn tool use automatic? | YES — agent-loop.js:84-130: outer while(true), inner while(hasMoreToolCalls): stream → filter toolCalls → execute batch → push results → continue. 20-50 turns = one await. NO built-in max-turns knob (disclosed gap — our finishTurn hook bounds it). |
| Q5 | MED | Adapter integration surface | The full parameter mapping: agent(role) → prompt+tools; prompt(text) → agent.prompt(input); model(string) → registry.find; cwd → tool factory param + Agent working dir; timeoutMs → setTimeout(abort); signal → agent.abort; returns SpawnResult (contract unchanged). |

**Round 5 verdict: GRILL CLOSED.** Five rounds (R1 architecture → R2 implementation → R3 integration → R4 failure modes → R5 adapter surface), 30 findings, zero open questions. 069 is implementation-ready.

## 4.15 Grill round 6 (2026-09-22) — ripple effects and performance model (with local benchmarks)

| # | Sev | Question | Answer |
|---|---|---|---|
| Q1 | HIGH | Hybrid Agent + createAgentSession resource contention? | NO contention — raw Agent is provider-agnostic (we inject streamFn from modelRegistry); createAgentSession builds a new ModelRuntime per call unless passed in. No shared connection pool (each stream constructs a fresh SDK client; undici pool is process-global and shared). Benchmark: shared runtime+loader = 4.6 ms/session; fresh everything = 116 ms/session. MUST hoist ONE ModelRuntime + ONE ResourceLoader to pipeline scope and pass into every createAgentSession child. |
| Q2 | HIGH | Error shapes from direct Agent? | stopReason: "error" + flat errorMessage string on the trailing assistant message (provider HTTP errors, quota, model-not-found as 404). Tool errors → error tool results (isError:true), loop continues. Context overflow → isContextOverflow() helper (25+ provider patterns). CLASSIFICATION RULE: by stopReason + overflow helper + substring containment — NEVER on exact strings (errorMessage is lossy; upstream discussion #3363 on structured diagnostics). |
| Q3 | HIGH | Per-call latency saving? | MEASURED: delegation event round-trip = microseconds (in-process function calls). Session machinery (fresh runtime + noExtensions loader + session) = ~120-150 ms/child. Ambient-extension loading = ~4,150-4,330 ms (dominated by extension discovery). Against multi-second LLM calls: 120 ms is 1-5% (real but secondary). The speed gain comes from REVIEW PARALLELIZATION (259→86 min) and GAP REDUCTION, NOT from delegation overhead elimination. |
| Q4 | HIGH | createAgentSession per-session overhead? | 4.6 ms one-shot (shared runtime+loader+inMemory session) vs 116 ms+ (defaults) vs seconds (extensions ON). Lightweight IFF hoisted. Residual risk: shared loader means extension module state is process-wide — extension-needing specialists assuming per-child isolation will break. |
| Q5 | MED | Resume cache compatibility? | SpawnResult shape unchanged — resume cache compatible; no new salt needed (backend switch is transparent to the cache). |
| Q6 | MED | The 8→3h performance model (corrected) | ~173 min from review parallelization + ~65 min from gap reduction (145→80) = ~4h total saving. Delegation overhead elimination contributes <2 min (84 × ~1.5s). The migration's value = STABILITY (delete the seam-failure class: 4 dead runs) + PARALLELIZATION (Promise.all) + CONTROL (finishTurn), not single-call latency. |

## 4.17 Grill round 7 (2026-09-22) — the last mile: existing machinery's survival

| # | Sev | Question | Answer |
|---|---|---|---|
| Q1 | HIGH | Mid-run steering: steer() or existing injection? | EXISTING INJECTION — our mid-run guidance is queue + inject-into-next-prompt, NOT real-time steering. agent.steer() queues until the entire tool batch finishes (drained only at loop start and after turn_end — no mid-batch poll in installed 0.82.1). Our pattern needs zero change. If future live-steering needed: hold Agent handle, call steer(), expect delivery at next turn boundary. "Stop this" = abort() + fresh dispatch with guidance folded in. |
| Q2 | HIGH | Child guards (commit 63L + safety 181L) migration? | PORT 1:1 to beforeToolCall — both guards use exactly pi.on("tool_call")+{block:true,reason}, the same semantics as the Agent's beforeToolCall hook. isCommitClassGitCommand is already an exported pure function (zero imports — direct import into adapter). Safety-guard's ctx.cwd becomes an adapter closure. MUST wrap in try/catch → undefined (fail-open) — a guard crash now affects the PARENT process, not an isolated child. The v0.3.73 HEAD-drift detective net stays as compensating control. |
| Q3 | MED | Post-mortem/eval direct imports? | ONLY post-mortem.ts imports runAgentViaDelegation directly (one line to change). eval-stage.ts uses a structural seam (EvalAgentDispatch) and receives ctx.agent from workflow — no direct import, just the workflow seam rewire. Both are full specialist dispatch (multi-turn tool use) — NOT lightweight complete() calls. |
| Q4 | MED | realAgent simplification | 86 lines → ~30 lines (60% reduction): 21 delegation-specific lines (degrade/host-sdk/version-skew/fleet) all deleted. Error taxonomy simplifies from 6 regex patterns on delegation strings to stopReason + overflow helper. |
| Q5 | MED | Skills injection mechanism | skillsForCall → append skill text to initialState.systemPrompt (pure prompt assembly, no new mechanism). |

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
