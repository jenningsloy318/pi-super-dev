# The registration retry's spread defect — four runs, one line

Status: implemented (2460a2fe, v0.4.85). Lineage: the C5 contract surface
(upstream-watch); the fix chain v0.4.82→85. Receipts: runs
2026-09-21T14-27, 14-50, 15-09, 15-19 (19/19 Unknown-agent each).

---

## 0. The failure chain (what each version got wrong)

| Version | Diagnosis | What shipped | What was still wrong |
|---|---|---|---|
| v0.4.82 | 0.70.1 removed completionGuard (#2356) | Owner-version-conditional field (`minor <= 70`) | Off-by-one: 0.70.**1** has minor=70 too — the field still flew |
| v0.4.83 | No diagnostics in run log | Unknown-agent diagnostics line (ownerPresent + rejection texts) | No fix yet, but the next run NAMED the cause |
| v0.4.84 | Diagnostics confirmed: still "unknown fields: completionGuard" | Class fix: strip rejected fields + retry once | **The retry's `{ ...request }` spread copied the FIRST attempt's `result: {ok:false}` — the owner's listener guards on `result !== undefined` (treats it as already-answered) and silently dropped the retry** |
| v0.4.85 | The spread defect | One-line fix: destructure the first result out before spreading | — (verified end-to-end against the real 0.70.1 listener) |

## 1. Root cause (both bugs, one lesson)

The 0.70.1 listener's protocol: a request object arrives via
`events.emit(RUNTIME_AGENT_REGISTER_EVENT, request)`; the listener writes
its answer INTO `request.result` (a synchronous out-param pattern); it
SKIPS any request whose `result` is already set (idempotency guard).

**Bug 1 (v0.4.82)**: a hardcoded version boundary can be wrong at the patch
level — `minor <= 70` cannot distinguish 0.70.0 from 0.70.1.

**Bug 2 (v0.4.84)**: when a protocol uses a sentinel field's ABSENCE as a
signal ("no result yet = process me"), spreading the previous attempt's
envelope into the retry carries the sentinel FORWARD, and the retry is
silently dropped.

**The lesson (P7)**: never spread a protocol envelope into a retry —
construct fresh, or destructure the sentinel out. And never hardcode a
version boundary where a strip-and-retry can self-heal.

## 2. The fix (one line)

```typescript
// BEFORE (v0.4.84 — the spread carried result forward):
const retryRequest = { ...request, definition: pruned };  // result: {ok:false} rides along

// AFTER (v0.4.85):
const { result: _firstResult, ...freshRequest } = request;  // strip the sentinel
const retryRequest = { ...freshRequest, definition: pruned };
```

## 3. Verification

End-to-end against the REAL installed 0.70.1
`registerRuntimeAgentEventListener` (not a mock): first attempt rejected
with "unknown fields: completionGuard" → retry (without the spread result)
ACCEPTED.
