# Upstream Watch: pi-subagents / pi contract surface

This file records every upstream contract pi-super-dev depends on, the pinned
versions it was verified against, and the re-check procedure to run whenever
pi or pi-subagents updates. It exists so a future session can answer
"did upstream change break us?" with file-level evidence instead of guesses.

## Contract surface

| # | Contract | Upstream anchor | Our consumer | Notes |
|---|----------|-----------------|--------------|-------|
| C1 | Session identity precedence | `src/shared/session-identity.ts` — `resolveCurrentSessionId = getSessionFile() ?? getSessionId()` | `resolvePiSessionIdentity` in `src/agents/fleet-visibility.ts` (v0.3.27) | On pi 0.84.3 `getSessionFile()` returns the session **file path**; registering external runs under the uuid is invisible (exact-match filter). We mirror the precedence; the helper is not exported by their package, so an import is not possible. |
| C2 | Fleet external-run filter | `src/tui/fleet.ts:283-285` — `snapshotExternalRuns(state.currentSessionId)` exact match | sessionId passed to `fleetBegin` from `src/extension.ts` | Any change to filter semantics (fuzzy match, prefix, both ids) would relax/correct our mirror automatically only if precedence stays; re-verify C1 together with this. |
| C3 | External-runs module resolution | package exports map `'pi-subagents/external-runs' -> src/api/external-runs.ts` | `resolveExternalRunsModule` in `src/agents/fleet-visibility.ts` | Bare specifier FAILS under pi's jiti loader from git-installed extensions (alias map covers only pi core packages). Absolute path `~/.pi/agent/npm/node_modules/pi-subagents/src/api/external-runs.ts` (or `PI_SUBAGENTS_ROOT`) works — jiti transpiles .ts directly. Registry state is shared via `globalThis[Symbol.for(...)]`, so duplicate module instances still converge. |
| C4 | Delegation event contract | `src/api/delegation.ts` — events `prompt-template:subagent:request/response/cancel`; request fields `requestId/ownerRunId/nodeId/agent/task/context/cwd/model?/thinking?/timeoutMs?/result`; terminal statuses | `DelegationRequestPayload` / `DelegationTerminalResponse` (local types) + `runAgentViaDelegation` in `src/agents/delegation-backend.ts` | Completed text results arrive as the envelope `{kind:"text",text}` — `textOf` unwraps it (v0.3.26 Review-2 P0). Unreleased main (1f2abe1, 2026-08-28) removed `turnBudget` + `turn_budget_exhausted` — we never used either, zero impact. |
| C5 | Runtime agent registration validation | `src/agents/runtime-agent-registry.ts` — `validateString` requires `systemPrompt` non-empty with **no leading/trailing whitespace** | `loadAgentBasePrompt` trims (v0.3.26; run 2026-08-28T15-50-08 lost 30/32 registrations to trailing newlines before this) | Unreleased main adds optional `allowNestedSubagents` and removes `defaultTurnBudget`; neither affects our `{name, description, systemPrompt, tools}` payload. `allowNestedSubagents` is a future option if sd-* specialists ever need to fan out. |
| C6 | Result envelope shape | `src/api/delegation-adapters.ts:364-375` | `textOf` in `src/agents/delegation-backend.ts` | If a new result kind appears, `textOf` must handle or honestly error it. |

## Version pins (verified 2026-08-29)

- pi-subagents: **0.58.0** installed (`~/.pi/agent/npm/node_modules/pi-subagents`) = npm `latest`.
  Unreleased main `1f2abe1` has 10 commits after the 0.58.0 tag (all 2026-08-28);
  verified zero drift on C1/C3 and only non-impacting changes on C2/C4/C5.
- pi: **0.84.3** — `getSessionId()` returns a uuid, `getSessionFile()` returns the
  session file path. A Pi session id IS the session file path per upstream source
  comments; the docs example calling `getSessionId()` is broken on this version —
  that upstream doc bug does not affect us because we mirror the runtime resolver,
  not the docs.
- Reference clone: `docs/references/pi-subagents` (gitignored, shallow). Refresh
  with `git fetch origin` before any comparison; compare against origin/main.

## Re-check procedure

Run whenever pi or pi-subagents updates (or before cutting a release that touches
`src/agents/`):

```bash
# 1. Is there a new release?
npm view pi-subagents version
npm view pi-subagents dist-tags

# 2. Any unreleased commits on main?
cd docs/references/pi-subagents && git fetch origin
git log --oneline HEAD..origin/main

# 3. Did the contract files move? (installed 0.58.x vs latest main)
NPM=~/.pi/agent/npm/node_modules/pi-subagents
for f in src/shared/session-identity.ts src/api/external-runs.ts \
         src/api/delegation.ts src/tui/fleet.ts src/agents/runtime-agent-registry.ts; do
  diff -q "$NPM/$f" "docs/references/pi-subagents/$f" >/dev/null 2>&1 \
    && echo "SAME  $f" || echo "DIFF  $f"
done
```

If a file reports DIFF, act per contract:

- **C1/C2 (`session-identity.ts` / `fleet.ts` filter)** — update
  `resolvePiSessionIdentity` in `src/agents/fleet-visibility.ts` to mirror the new
  precedence and update `tests/fleet-visibility.test.ts`. This is the uuid-vs-path
  mirror; a precedence flip here makes every external Fleet row invisible.
- **C4 (`delegation.ts`)** — align `DelegationRequestPayload` /
  `DelegationTerminalResponse` local types in `src/agents/delegation-backend.ts`;
  check `textOf` envelope handling (C6).
- **C5 (`runtime-agent-registry.ts`)** — re-check `validateString`-family rules
  against our registration payload in `src/agents/register-agents.ts` and the
  trim in `loadAgentBasePrompt`.
- **C3 (exports map)** — re-run the resolution probe if the module path moves.

## Drift log

- **2026-08-29** — checked after "pi-subagents updated today" report. No new npm
  release (0.58.0 remains latest, published 2026-08-27T04:57Z). Main gained 10
  unreleased commits (through `1f2abe1`): turnBudget/defaultTurnBudget removals
  (unused by us), optional `allowNestedSubagents`, fleet display hardening,
  validatePositiveInteger hardening. C1/C3 byte-identical; uuid-vs-path fix
  (v0.3.27) still correct against both installed and latest main.
