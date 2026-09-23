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

- [ ] Run log header shows v0.4.92+
- [ ] No "modelRegistry not yet available" or "host context not set" errors
- [ ] First agent call completes with `delegation .*: completed` (pi-agent-core path)
- [ ] `ModelRuntime.create()` error (if any) names the auth.json/models.json issue
