# The ModelRuntime access fix — four failed approaches, one correct pattern

Status: implemented (this commit, v0.4.92). Lineage: 069 (pi-agent-core migration).
Receipts: four dead runs (2026-09-23T01-32, 02-03, 14-33, 15-03), each
4/4 agents failing in <40ms.

---

## 0. The problem

pi-super-dev's pi-agent-core backend needs a `streamFn` for the Agent class
and a model-resolution function. Four approaches all failed with
"host context not set" or "modelRegistry not yet available".

## 1. Root cause (all four failures)

`modelRegistry` lives on **ExtensionContext** (types.d.ts:222), NOT on
**ExtensionAPI** (what the extension factory receives). These are two
different interfaces:

```
ExtensionAPI (what the factory receives)     ExtensionContext (internal)
├── on(event, handler)                      ├── cwd
├── registerTool(...)                       ├── sessionManager
├── appendEntry(...)                        ├── modelRegistry  ← HERE
├── ui.notify(...)                          └── ...
└── ...
    (NO modelRegistry)
```

Every approach tried to read `pi.modelRegistry` from the ExtensionAPI
parameter — a property that simply doesn't exist on that interface.

## 2. The four failed approaches

| # | Approach | Why it failed |
|---|---|---|
| 1 (v0.4.87) | Eager: `pi.modelRegistry` at activation | `_bindExtensionCore` hasn't run; but more fundamentally, modelRegistry is never ON this object |
| 2 (v0.4.89) | Deferred: session_start + 15s fallback | Same root cause — modelRegistry never appears on ExtensionAPI regardless of timing |
| 3 (v0.4.90) | Lazy: resolve at each agent call | Still reading `piRef.modelRegistry` — still undefined because the property doesn't exist on ExtensionAPI |
| 4 (v0.4.91) | Attempted ModelRuntime.create() but the code patch failed silently — the old resolveHost code was committed | The git checkout + Python patch approach left the file in a mixed state |

## 3. The correct pattern (from pi-subagents source)

pi-subagents' own `child-session.js:200-215` is the production-verified
pattern:

```javascript
// 1. Load the pi-coding-agent MODULE (not the ExtensionAPI parameter)
const pi = await loadPiCodingAgent();

// 2. Call the STATIC method on the module
const modelRuntime = await pi.ModelRuntime.create();

// 3. Use the runtime directly
const streamFn = modelRuntime.streamSimple.bind(modelRuntime);
const model = modelRuntime.getModel(provider, modelId);
```

`ModelRuntime.create()` is a static factory method on the pi-coding-agent
module that reads `~/.pi/agent/auth.json`, `models.json`, and
`models-store.json`. It is completely independent of ExtensionAPI timing,
interface confusion, or _bindExtensionCore scheduling.

## 4. The fix (implemented in v0.4.92)

In `src/agents/pi-agent-core-backend.ts`:

```typescript
// Replace HostContext/piRef/resolveHost with:
interface ResolvedRuntime {
    streamSimple: (...args: unknown[]) => unknown;
    getModel(provider: string, modelId: string): unknown;
}

let cachedRuntime: ResolvedRuntime | undefined;

async function getRuntime(): Promise<ResolvedRuntime | undefined> {
    if (cachedRuntime) return cachedRuntime;
    const pai = await import("@earendil-works/pi-coding-agent");
    const rt = await pai.ModelRuntime.create();
    cachedRuntime = rt;
    return rt;
}
```

Tool factories also resolve lazily from the same module import. Extension.ts
needs NO host-context wiring at all — only `abortAllActiveAgents()` on
session_shutdown (the adapter's invariant #2).

## 5. Lesson (the P7 class)

**When a module-level static method exists on the package, use it — don't
try to extract a runtime-managed instance from a callback parameter.**
The ExtensionAPI parameter is a callback-scoped view of the extension
surface; ModelRuntime is a module-level factory that works independently.

## 6. Verification checklist (for the next live run)

Applies AFTER the approved open findings land (R2-F1/F2 §7, R4-F1..F4
§8, R5-F1..F7 §9); running v0.4.92 as-committed fails the first
specialist call (§7.2) and, past that, every call of a
no-explicit-model run (§9.2).

- [ ] Run log header shows the version carrying §7.2/§7.3
- [ ] No "modelRegistry not yet available" or "host context not set" errors
- [ ] First agent call completes (pi-agent-core path)
- [ ] `ModelRuntime.create()` error (if any) names the auth.json/models.json issue

---

## 7. Grill round 2 — source-verified API audit (OPEN findings)

Every API assumption audited against the installed host 0.87.1 copies
(the exact code jiti loads), cross-checked with the official README and
the earendil-works/pi wiki. Findings below are **open** — implementation
awaits approval.

### 7.1 Verified correct (no change needed)

| Assumption | Evidence |
|---|---|
| `ModelRuntime.create()` static exists | host dist/core/model-runtime.d.ts:53 |
| `getModel(providerId, modelId): Model \| undefined` | model-runtime.d.ts:65 — 2-arg, returns undefined (adapter guards it) |
| Loader aliases BOTH `pi-coding-agent` AND `pi-agent-core` to host copies | host loader.js:53,63 — Agent and ModelRuntime are both host 0.87.1; no dual-instance hazard despite devDep 0.87.0 |
| `AgentOptions { initialState?, streamFn, beforeToolCall? }` | pi-agent-core agent.d.ts `AgentOptions` |
| `prompt(string)`, `waitForIdle()`, `abort()`, `state.messages` | agent.d.ts:80,104,110,114 |
| `BeforeToolCallResult { block?, reason?, terminate? }` — our guard shape | types.d.ts:41-49 |
| `stopReason` union includes `"error" \| "aborted"` | pi-ai types.d.ts:292 |
| `ThinkingLevel` includes `"high"`, `"max"` | pi-agent-core types.d.ts:296 |
| `Model.contextWindow: number` | pi-ai types.d.ts:823 |

### 7.2 R2-F1 (P0, OPEN): streamFn is passed UNBOUND — kills the first call

v0.4.92 line: `streamFn: runtime.streamSimple as never`. Three-level
proof from the installed sources:

1. `streamSimple`'s body calls `await this.prepareRequest(model, options)`
   (host model-runtime.js:462-466).
2. pi-agent-core's `runLoop` invokes the streamFn as a **bare function** —
   `streamFunction(config.model, llmContext, {...})` — and ESM is strict
   mode, so `this` is `undefined` inside the unbound method →
   `TypeError: Cannot read properties of undefined (reading 'prepareRequest')`.
3. The official README binds in **all four** examples
   (`streamFn: models.streamSimple.bind(models)`, README lines 32/238/451/553);
   the earendil-works/pi wiki confirms the bind is required.

**Proposed fix:** `streamFn: runtime.streamSimple.bind(runtime) as never`.
**Proposed regression test:** capture the options handed to `Agent`; pin
the `bound ` name prefix AND the behavioral property (invoking the
captured fn routes `this` to the runtime object).
**Note:** spec §3 quoted the bind and the implementation dropped it — see
the lesson in §7.5.

### 7.3 R2-F2 (P0, OPEN): read-only tool factories called without cwd

All seven factories have been `(cwd: string, options?)` since pi 0.68.0
(the cwd-less prebuilt exports were removed — a documented breaking
change; confirmed in the tools/*.d.ts signatures and the 0.68.0
changelog via the repo wiki). v0.4.92 calls `createReadTool()`,
`createGrepTool()`, `createFindTool()`, `createLsTool()` with **no cwd** —
every read-only specialist would resolve paths against the pi process
cwd instead of the target worktree (`.worktree/26-…`), and any
`path.resolve(cwd, …)` inside the tool throws on `undefined`.

**Proposed fix:** pass `opts.cwd` to all seven factories.
**Proposed regression test:** mock the SDK module; assert each of the
seven factories received the call's cwd verbatim.

### 7.4 P3 observations (documented, no action proposed yet)

- `stopReason: "length"` (output truncated by maxTokens) is currently
  treated as success — the extractResult guard only flags `error`/`aborted`.
  If live runs show silently-truncated artifacts, extend the guard.
- `beforeToolCall` supports `terminate: true` (stop after this batch when
  every result in the batch terminates) — the commit guard could set it to
  stop a child that keeps hammering blocked git verbs. Not wired.
- devDeps sit at ^0.87.0 while the host runs 0.87.1 — runtime uses the
  host copies via the loader alias map, so this is type-drift only;
  bump devDeps opportunistically.

### 7.5 The class lesson (P7)

The v0.4.92 fix was root-caused against pi-subagents'
`ModelRuntime.create()` access path but the adapter body was written
without reading the SDK's own usage examples. "Access path correct, call
convention wrong" — a `.bind()` the README writes in every example — is
still a dead run. Spec §3 HAD the bind; the implementation dropped it.
Corollary: when a spec quotes a reference pattern, the implementation
must be diffed against that quote, not just against its intent.

---

## 8. Grill round 4 — execution-semantics audit (OPEN findings)

(Round numbering follows the session's grill passes; the §7 audit was the
pass before this one.) Sources: the host 0.87.1 dist (agent.js,
runWithLifecycle, pi-ai models.js), our own workflow.ts / extension.ts,
the pi CHANGELOG, npm, and the earendil-works/pi wiki. Findings are
**open** — no code changed.

### 8.1 R4-F1 (P0, OPEN): the role-prompt machinery is missing entirely

The adapter builds its system prompt as
`opts.systemPrompt ?? "You are a ${opts.agent} specialist."` — and the
workflow dispatch (workflow.ts:415-427) passes `systemPrompt: undefined`
under the comment "the adapter loads the role prompt". **The adapter
loads nothing**: it has no `loadAgentBasePrompt` import. Consequences on
the pi-agent-core path:

- Every specialist runs on a generic one-line system prompt instead of
  its `agents/<name>.md` body — the declared single source of truth
  (register-agents.ts header; the delegation path registered each
  specialist with that body via the runtime-agent-register contract).
- Lost with it: the role's output contract (the `<control>` JSON
  discipline `extractControl` depends on), the READING DISCIPLINE
  section, verification gates, and format contracts.
- Per-call injections (lessons, skill cards) survive — they ride the
  task prompt (`common.prompt` from `assembleAgentCall`) — but the base
  body does not.
- Expected live symptom: control extraction frequently returns null →
  stage-level bounces and multi-attempt behavior — the exact regression
  class this whole effort exists to eliminate.

**Proposed fix:** in the adapter, `systemPrompt =
opts.systemPrompt ?? loadAgentBasePrompt(opts.agent) ?? generic`, using
the existing `loadAgentBasePrompt` export from `src/agents.ts` (one
source of truth, same as every other backend). **Proposed regression
test:** dispatch a known role (e.g. `spec-writer`) and assert the Agent's
`initialState.systemPrompt` contains the spec-writer .md body's opening
line, not the generic fallback.

### 8.2 R4-F2 (P2, OPEN): thinkingLevel passed raw — silent tier divergence

The delegation backend clamps before dispatch
(`clampThinkingToModel(provider, modelId, level)`,
delegation-backend.ts:388); the adapter imports the clamp but never calls
it and hands `opts.thinking` straight to `initialState.thinkingLevel`,
which the loop config passes as `reasoning` to the stream
(agent.js createLoopConfig).

Wiki + source reading: providers clamp internally in *some*
streamSimple implementations (google-vertex, google-generative-ai,
openai-codex-responses are the wiki-named ones) and ignore reasoning on
`reasoning: false` models — so this does not crash everywhere. But the
behavior for a custom OpenAI-compatible provider (the live run uses
`zai-coding-cn/glm-5.3`) is unverified, and where clamping does happen
it is silent: the ledger's thinking label reports the configured tier
while the model ran another.

**Proposed fix:** clamp explicitly with the SDK's own
`clampThinkingLevel(resolvedModel, level)` — exported from
`@earendil-works/pi-ai` root (models.d.ts:196, and `pi-ai` is already a
declared peerDependency). Deterministic across ALL providers, restores
parity with the delegation path, and works off the Model object the
adapter already holds (no agentDir catalog read).

### 8.3 R4-F3 (P2, OPEN): run-level AbortSignal listener accumulation

`extension.ts:573` passes ONE run-level signal into `doRun`; the adapter
does `opts.signal?.addEventListener("abort", …, { once: true })` per
specialist call and never removes the listener on success (`{once:true}`
only removes it when it FIRES — a successful run never fires it). A full
pipeline makes on the order of a hundred-plus specialist calls:

- Node warns past 10 listeners on one signal
  (`MaxListenersExceededWarning`).
- Each listener closure retains its (finished) Agent — and each Agent
  retains the full transcript including the ~58k-char task prompts — for
  the entire run. Memory bloat on exactly the long runs we care about.

**Proposed fix:** capture the handler, `removeEventListener` it in the
existing `finally` cleanup next to `activeAgents.delete(agent)`.
**Proposed regression test:** dispatch N calls on one shared signal;
assert `getEventListeners(signal).length === 0` after all settle.

### 8.4 R4-F4 (P2, OPEN): empty-text responses report success

`extractResult` returns `{ text: "", error: undefined }` when the last
assistant message has `stopReason: "stop"` but zero text blocks. The
caller sees a successful call with empty output; the failure surfaces
only as a downstream validator bounce — one full retry cycle spent on a
result we could have named at the source.

**Proposed fix:** if the joined text is empty and stopReason is not
error/aborted, return `error: "empty assistant response (stopReason=…)"`.
**Proposed regression test:** mock a text-less final assistant message;
assert the SpawnResult carries the error.

### 8.5 Verified correct this round (no change)

| Question | Answer | Evidence |
|---|---|---|
| Does `await prompt()` cover the whole run? | Yes — it awaits `runWithLifecycle(runAgentLoop …)`; `waitForIdle()` after it is redundant-but-harmless (returns an already-resolved promise) | agent.js `prompt`/`runPromptMessages`/`waitForIdle` |
| Does the timeout actually rescue a hung call? | Yes — `abort()` aborts the internal controller; `runWithLifecycle` catches, `handleRunFailure`, `finishRun()` resolves; the loop synthesizes stopReason `"aborted"` which our guard maps to an error | agent.js `runWithLifecycle`/`abort` |
| 0.87.0→0.87.1 delta | Model-catalog + provider fixes only; nothing on ModelRuntime/Agent/tool-factory/StreamFn surfaces | host CHANGELOG 0.87.1 |
| Upstream newer than host? | No — npm latest is 0.87.1 for BOTH pi-coding-agent and pi-agent-core (host == latest) | `npm view` 2026-09-23 |
| 0.87.0 breaking changes vs adapter | Not applicable — adapter uses no `shouldStopAfterTurn`, no AgentSession, no state assignment (read-only `state.messages`) | CHANGELOG 0.87.0; adapter source |

### 8.6 P3 observations (documented, no action proposed)

- **Credential staleness:** a cached ModelRuntime does NOT pick up
  auth.json changes; `refresh()` is the intended mechanism (wiki).
  Long-lived pi sessions with OAuth rotation could 401 with no recovery.
  Remedy when needed: on an auth-failure error from a specialist call,
  drop `cachedRuntime` and retry once with a fresh `create()`.
- **Char-vs-token gate:** the invariant-#3 pre-check compares
  `prompt.length` (chars) against `contextWindow` (tokens) — fires ~4x
  early for ASCII text, roughly right for CJK, and ignores the system
  prompt. Acceptable as a coarse gate; do not tighten without a
  tokenizer.
- devDep type-drift (^0.87.0 vs host 0.87.1) — unchanged from §7.4.

### 8.7 Round-4 frontier after this pass

The adapter's remaining unknowns are live-run behaviors no static read
settles (stream error shapes from the zai provider, actual token
accounting, tool-result flows through guards). Two more static passes
would re-tread §7/§8 ground. Recommendation: land R2-F1/R2-F2/R4-F1
(plus the P2s if approved) and spend the next pass on the first live
log instead.

*(Superseded by round 5: one more static pass — the call-site parity
audit — found four more gaps, §9 below. The live-log recommendation
stands AFTER the §9 set lands.)*

---

## 9. Grill round 5 — call-site parity audit (OPEN findings)

Rounds 2/4 audited the adapter against the SDK. Round 5 audits the
DISPATCH SITE (workflow.ts:414-428) against the delegation call that
sits beside it: everything `common` carries that the pi-agent-core
branch drops. Sources: our workflow.ts / agent-call-assembly.ts /
register-agents.ts / extension.ts / delegation-backend.ts, host dist
tool schemas, pi-subagents 0.71 source, and the earendil-works/pi wiki.
Findings are **open** — no code changed.

### 9.1 R5-F1 (P1, OPEN): accessMode ignored — 32 of 52 read-only roles get write tools

The delegation call receives `common.accessMode` (per-call, from
`call.accessMode ?? "write"` in agent-call-assembly.ts:118 — the value
the engine's source-boundary machinery keys off at workflow.ts:312-321).
The core branch instead re-derives read-onlyness from a NAME HEURISTIC
invented for 069: `readOnlyRole(agent)` = name contains
review/classifier/judge (workflow.ts:172-174).

The authoritative set is `READ_ONLY_AGENTS` (register-agents.ts:71) —
52 members. Only 20 match the heuristic. The other **32** — including
`requirements-clarifier`, `code-assessor`, `debug-analyzer`,
`post-mortem`, `reflection`, `replan-lead`, and the four design-stage
specialists — would receive bash/edit/write on the pi-agent-core path.
Read-only posture is engine-side (P4: the source boundary is the
enforcement), but the delegation child ALSO had no mutation tools; the
new path hands 32 read-only roles a live mutation surface they never
had, and their prompts assume they cannot mutate.

**Proposed fix:** pass `readOnly: common.accessMode === "source-read-only"`
(the same per-call source of truth delegation uses); delete the
heuristic. **Proposed regression test:** for each READ_ONLY_AGENTS
member, dispatch and assert the tool list contains no bash/edit/write.

### 9.2 R5-F2 (P0, OPEN): model inheritance dropped — no-explicit-model runs fail EVERY call

`resolveAgentModel` (workflow.ts:194-203) returns `string | undefined`;
it is undefined whenever the call has no model, no role config
(`~/.super-dev` agentModels), and no `options.model`. `options.model`
is `params.model` from the tool invocation (extension.ts:406) —
OPTIONAL. The delegation backend's fallback chain is
`opts.model ?? resolveModel(undefined) ?? inheritedModelObject`
(delegation-backend.ts:444), where `inheritedModelObject` is the LIVE
main-session model object (extension.ts:389-395).

The core branch threads NONE of this: it passes
`model: resolveAgentModel(...)` and drops both `common.inheritedModelObject`
and `common.inheritedThinking`. With no explicit model configured — the
common invocation — the adapter receives `undefined`, splits `""`, calls
`getModel("", "")`, and returns `model not found: (provider=, id=)` for
every specialist call of the run.

**Proposed fix:** thread the inheritance into the core dispatch.
**SCENARIO-001 trap (must respect):** the inherited fallback must use
the FULL object — a bare `provider/id` re-resolution ambiguously
matched a different provider's same-named model (the opencode
mis-resolution bug; extension.ts:383-386 comment). The adapter should
accept an optional inherited Model OBJECT and use it directly when
string resolution comes up empty, not re-resolve a string.
`inheritedThinking` (ctx.thinkingLevel) rides the same fix — the
adapter's `?? "medium"` default silently ignores the session tier
delegation threaded (P3 sub-note).

### 9.3 R5-F3 (P2, OPEN): timeout tiers and env knobs dead on the new path

Delegation applies the role-tier backstop:
`opts.timeoutMs ?? defaultAgentTimeoutMs(opts.agent)`
(delegation-backend.ts:627) — code-writing / review / heavy-writer /
default tiers, each env-overridable (SUPER_DEV_CODE_TIMEOUT_MS,
SUPER_DEV_REVIEW_TIMEOUT_MS, SUPER_DEV_WRITER_TIMEOUT_MS,
SUPER_DEV_AGENT_DEFAULT_TIMEOUT_MS; runtime.ts:115-127). The adapter
hardcodes `opts.timeoutMs ?? 1_800_000` (30 minutes flat): review-tier
agents lose their shorter bound, code agents may lose a longer one,
and all four env knobs silently stop working.

**Proposed fix:** `opts.timeoutMs ?? defaultAgentTimeoutMs(opts.agent)`
in the adapter (import already sits beside it in agent-runtime).

### 9.4 R5-F4 (P2, OPEN): skill curation dropped — zero cards, always

The workflow computes `callSkill = skillsForCall(call.agent, …)`
(v0.3.76 L0/L1: config agentSkills, classifier-selected domains,
kill-switches) and passes it ONLY to the delegation call. The core
branch drops the field — and the adapter has no skills mechanism at
all. Net behavior on the new path: neither curated NOR ambient — ZERO
skill cards for every role; SUPER_DEV_SKILLS=ambient,
SUPER_DEV_NO_SKILLS, and config agentSkills all become no-ops.

Wiki-confirmed constraint: skills attach to AgentSession's
DefaultResourceLoader, not to a raw Agent — the sanctioned raw-Agent
delivery is system-prompt injection (the formatSkillsForPrompt
approach — exactly what our own registration did: "system-prompt skill
list + `read` of SKILL.md").

**Proposed fix:** fold the curated card list into the adapter's system
prompt (names + one-line descriptions + the read-the-card instruction),
respecting false = none / undefined = ambient-list semantics.
**Proposed regression test:** dispatch with a curated skill list and
assert the system prompt names the cards; dispatch with `false` and
assert none.

### 9.5 R5-F5 (P2, OPEN): toolBudget dropped — the header claims a counter that does not exist

The adapter's header comment says beforeToolCall carries "our tool
budget counter"; `guardBeforeToolCall` contains no counting. The
delegation path resolves per-role/per-call budgets
(`common.toolBudget`, v0.3.87 S4) and pi-subagents enforces them
child-side — soft nudge past the soft limit, hard block at the hard
limit with a recognizable message (pi-subagents tool-budget.d.ts).
Wiki-confirmed: `beforeToolCall` returning `{block: true, reason}` is
the sanctioned enforcement hook for a raw Agent.

**Proposed fix:** count tool calls in the adapter's beforeToolCall;
resolve the budget via the existing registration-level defaults +
`opts.toolBudget` override; emit the soft nudge as the block reason
one call early and hard-block at the cap (terminate: true available to
stop the batch).

### 9.6 R5-F6 (P3, OPEN): tool-usage telemetry blind

The delegation branch wires `onToolUse` → per-call toolCounts →
`appendToolUsageRows` ledger flush (workflow.ts:398-410). The core
branch returns before any of it — no tool-usage rows on the new path.
P10 (logs are honest) + the ledger economy lose their per-tool
visibility. Fix rides R5-F5's counter: an onToolUse-equivalent callback
on the adapter, flushed by the same finally.

### 9.7 R5-F7 (P2, OPEN): structured mode dropped

Delegation carries `result: {kind: "structured", schema}` — the child
gains a structured_output tool and engine-side validation runs
(v0.3.70 W3, the anti-bounce machinery). The core branch passes only
`controlKeys`; `call.schema` and `allowEmptyArraysFor` never reach the
adapter. Output reliability regresses to prose+`<control>`-only —
exactly the validator-bounce/attempt-multiplication class the
convergence economy exists to suppress. **Proposed fix (two-step):**
minimum — thread `allowEmptyArraysFor` into `extractControl` for parity;
full — a structured-output tool in the adapter's tool list validated
against `call.schema` before accepting the final message.

### 9.8 Verified correct this round (no change)

| Question | Answer | Evidence |
|---|---|---|
| Guard input field names | bash reads `args.command`; write/edit read `args.path` — the guards' field names are right | host bash.js:27 (`command: Type.String`), write.d.ts:5 / edit.d.ts:6 (`path`) |
| Access + language directives | They ride the task prompt (`promptWithAccess` → `promptWithLanguage` = `common.prompt`) — survive on the core path | agent-call-assembly.ts:130-140 |
| beforeToolCall as budget hook | Sanctioned (block: true) — R5-F5's fix path is upstream-blessed | pi-agent-core types.d.ts:41-49; wiki |
| Skills on raw Agent | Not built-in; prompt injection is the sanctioned path — R5-F4's fix shape | wiki (DefaultResourceLoader/skills) |

### 9.9 Round-5 frontier

The call-site parity inventory is now complete: every field `common`
carries is either threaded (prompt, cwd, model-string, thinking,
timeoutMs, signal, controlKeys) or accounted for as an open finding
(accessMode→F1, inherited model/thinking→F2, tier timeouts→F3, skill→F4,
toolBudget→F5, onToolUse→F6, schema/allowEmptyArraysFor→F7). Remaining
unknowns are live-run behaviors (provider stream error shapes, token
accounting) — the next grill should be the first live log, AFTER the
approved R2+R4+R5 set lands.

---

## 10. Grill round 6 — failure-path and context parity (OPEN findings)

Round 6 audits the paths nobody had opened yet: what happens when the
provider FAILS mid-call, and what context the delegation child silently
inherited that a raw Agent never sees. Sources: pi-ai
provider-retry/models/types, pi-coding-agent settings-manager +
agent-session + sdk, pi-subagents subagent-prompt-runtime, our
agent-retry.ts / agent-errors.ts / extension.ts. Findings are **open** —
no code changed.

### 10.1 R6-F1 (P1, OPEN): transient-error resilience collapsed to one regex

Three retry layers existed on the delegation path; the raw-Agent path
keeps none of the first two:

1. **Provider layer** — `retryProviderRequest` wraps every SDK call
   with `maxRetries: 0` hard-set on the client, retrying only
   `options.maxRetries` times (pi-ai utils/provider-retry.js:
   `maxRetries ?? 0`). createAgentSession threads
   `providerRetrySettings.maxRetries` into request options
   (sdk.js:187); the raw Agent's `createLoopConfig` threads
   `maxRetryDelayMs` but NEVER `maxRetries` — the count is unreachable
   from the Agent constructor. Default on our path: **zero provider
   retries**.
2. **Session layer** — `AgentSession._willRetryAfterAgentEnd`
   (agent-session.js:630+) re-prompts when the last assistant message
   is a retryable error, `retry.maxRetries ?? 3` by default
   (settings-manager.js:620). Raw Agent has no session wrapper: **no
   turn retry**.
3. **Workflow layer** — our `runWithTransientRetry` (4 backoffs inside
   one logical call) survives — but it classifies by REGEX over the
   surfaced error string (agent-retry.ts:28 TRANSIENT_RE:
   429/rate.?limit/overload/5xx codes/ECONNRESET/ETIMEDOUT/socket hang
   up), calibrated on DELEGATION error envelopes. Raw SDK messages can
   miss it — undici's `TypeError: fetch failed` wrapper carries its
   cause out-of-band and matches nothing in the regex → classified
   hard → a stage attempt burns on a transient network blip.

Net: one transient 429 either never matches (hard failure, attempt
burned) or matches and costs a FULL specialist re-run (re-reading,
re-thinking) where the session layer would have re-issued the failed
request only.

**Proposed fix (two-part):** (a) wrap the streamFn to inject
`{ ...opts, maxRetries: N, maxRetryDelayMs: M }` (settings parity or
constants) so the provider layer retries in-request — upstream-shaped,
restores layer 1; (b) on the first live log, validate TRANSIENT_RE
against the actual raw error strings and extend the misses (candidate:
`fetch failed`) — extend by EVIDENCE, not by guess. **Proposed
regression test:** the injected streamFn options carry maxRetries.

### 10.2 R6-F2 (P2, OPEN): project-context inheritance dropped (AGENTS.md et al.)

pi-subagents children default
`inheritProjectContext ?? true` (subagent-prompt-runtime.js:552): the
parent session's project context files — the target repo's AGENTS.md
conventions among them — were REWRITTEN into every child's system
prompt. Our delegation requests never set it false. The raw-Agent
adapter loads nothing: specialists lose the repo-convention context
that framed every previous backend's output. (Same default family:
`inheritGlobalContext ?? true`, `inheritSkills ?? true` — the skills
half already logged as R5-F4.)

**Proposed fix:** fold the worktree's AGENTS.md (bounded head excerpt)
into the adapter's system-prompt assembly — the same assembly R4-F1
introduces; one mechanism, two inputs (role body + project context).
**Proposed regression test:** dispatch in a cwd with a fixture
AGENTS.md; assert its heading appears in `initialState.systemPrompt`.

### 10.3 Verified correct this round (no change)

| Question | Answer | Evidence |
|---|---|---|
| `abortAllActiveAgents` wired? | Yes — session_shutdown (extension.ts:179); pi's extension lifecycle has NO separate deactivate event, so this satisfies invariant #2's intent (wording: the "+ waits" half is fire-and-forget — P3 polish below) | extension.ts:176-180; host extensions/types.d.ts event union |
| Adapter usage field names | `input/output/cacheRead/cacheWrite/cost.total` all real on pi-ai `Usage`; every assistant message carries one, so the turn-sum is sound | pi-ai types.d.ts `Usage`, `AssistantMessage.usage` |
| Shared cachedRuntime across parallel Agents | Safe by upstream design — one ModelRuntime per process is pi's own architecture (pi-subagents `sharedRuntime` for background children; AgentSession shares one runtime app-wide); per-request `prepareRequest` is read-only over the snapshot | pi-subagents child-session.js:204-210; model-runtime.js |
| SpawnResult contract match | text/control/model?/error?/usage? — adapter returns exactly these; usage-merge + budget-fuse consumers read the same fields | src/types.ts `SpawnResult`; agent-retry.ts:57 |
| Repo precedent for listener hygiene | `sleepMs` already removes its once-listener on normal resolution (A-05/NFR-6) — R4-F3's fix has an in-repo pattern to copy | agent-retry.ts:12-23 |

### 10.4 P3 observations (documented, no action proposed)

- **Abort-without-wait:** `abortAllActiveAgents` fires aborts and
  returns; the invariant's "waits" half would need a bounded
  `Promise.allSettled(agents.map(waitForIdle))` — worth folding into
  the R4-F3 cleanup fix, not standalone.
- **Dropped usage richness:** pi-ai also reports `reasoning` (thinking
  tokens), `totalTokens`, `cacheWrite1h` — the economy's thinking-label
  honesty and cost telemetry could carry them; additive only.
- **TRANSIENT_RE gaps:** see 10.1(b) — extend only against live-log
  evidence.

### 10.5 Round-6 frontier

Round 6 proved static passes still pay (two more parity gaps, §10.1-2)
— the §9.9 "live log next" call was premature. With failure-path and
context-inheritance now audited, the static surface is exhausted to the
same depth as the four previous rounds: every seam (SDK API, dispatch
fields, execution semantics, failure paths, context inheritance) has
one audit pass. The open set stands at **3 P0s, 2 P1s, 8 P2s, 4 P3s**
across §7-§10. Recommendation unchanged in shape but firmer: land the
approved set, then grill the first live log — round 7's target is the
run.log, not the source.
