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

Applies AFTER R2-F1/R2-F2 land; running v0.4.92 as-committed will fail
the first specialist call (see §7.2).

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
