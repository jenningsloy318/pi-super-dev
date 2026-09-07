# F-2026-09-07 — Stale model-exclusion cache poisoned every delegated child while the parent kept working

- **Incident run**: `~/.super-dev/runs/2026-09-07T14-10-39-259Z` (22:10–22:12 +08)
- **Class**: upstream pi-subagents defect × our missing error classification (P5/P10 adjacent)
- **Fixed in**: v0.3.77

## Timeline

| Time (+08) | Event |
|---|---|
| 15:11:49 | 5h zai-coding-cn coding-plan window caps. A delegated child's `glm-5.3` call 429s (`code 1308, 已达到 5 小时的使用上限… 19:05:39 重置`). pi-subagents `recordModelFailure` records a **24h** exclusion (`DEFAULT_MODEL_EXCLUSION_TTL_MS`) — the provider's own ~4h reset hint embedded in the reason string is ignored. |
| 15:12:36 | Same for `glm-5.3-flash`. Both entries live in the process's in-memory registry (loaded once, **never re-read mid-process**). |
| 19:05:39 | Provider resets the quota. Parent-session direct calls on `glm-5.3` work from here on — **pi core never consults pi-subagents' exclusion registry.** |
| ~19:25–19:34 | An unrelated pi process (ollama session) rewrites `/tmp/pi-subagents-uid-1000/model-exclusions.json` from its own stale in-memory snapshot (lost update) — the zai entries vanish from disk. Irrelevant to the poisoned process, which never re-reads disk anyway. |
| 22:10 | New super-dev run: `glm-5.3-flash` classifier call fails in ~ms (local throw, no API call), falls back deterministically (flagged). `glm-5.3` writer calls fail the same way. |
| 22:10:39–22:12:10 | Each writer call burns **4 transient backoff retries** (the cached reason contains `429`, so `TRANSIENT_RE` matches) — retrying a process-local cache hit can never succeed — then the convergence loop counts 3 consecutive agent-error rounds and FatalAborts (v0.3.65 machinery worked as designed; pre-v0.3.65 this spun 16 fake-rejection rounds). |

## Root cause chain

1. `model-exclusions.ts` `recordModelFailure`: flat 24h TTL regardless of the provider reset hint in the 429 body.
2. Registry is loaded/recorded once per process, never refreshed — a quota that resets hours later cannot un-poison the process.
3. `throwForExplicitModelExclusion` fails **every** delegated call with an explicit model pin instantly and locally.
4. pi-super-dev side: the exclusion envelope with a **429-shaped reason** escaped `NON_RETRYABLE_AGENT_RE` (which matched only the model-not-found reason shape) and matched `TRANSIENT_RE` instead → pointless retries + 3-round burn before the honest FatalAbort.

## The two-code-path proof (same machine, same model, same moment)

- Parent pi session → `zai-coding-cn/glm-5.3` directly: **works** (this conversation).
- Delegated children in the same process → pinned `glm-5.3`: instant local throw replaying a 7-hour-old 429 whose own reset time is long past.

## Fix (v0.3.77)

- The **envelope** `is excluded and cannot be replaced by a fallback` — not the cached reason — is the non-retryable signature. Added to `NON_RETRYABLE_AGENT_RE`.
- `runWithTransientRetry` already checks non-retryable **before** transient (workflow.ts), so this single classification kills both the 4× backoff burn and the 3-round convergence burn: round-1 FatalAbort.
- `nonRetryableAgentSummary` appends an engine-authored remedy for exclusion hits: "stale in-process model-exclusion cache … Restart pi to clear it, then re-run."
- Remedies for the user in the wild: **restart pi** (fresh registry load; the on-disk file had already lost the stale entries via the lost-update rewrite, but do not rely on that accident).

## Upstream issues (to report)

1. `recordModelFailure` should honor a parseable reset time in quota-429 bodies (zai ships one) instead of a flat 24h.
2. The in-process registry never re-reads disk and other processes rewrite it from stale snapshots (lost update) — exclusion state should be cross-process coherent or per-call-fresh.
