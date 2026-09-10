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

- **2026-09-10** — model-exclusions store (see 2026-09-08 item 1): confirmed in practice
  that deleting the on-disk store (`<tmp>/pi-subagents-uid-<uid>/model-exclusions.json`)
  does NOT heal a RUNNING pi session — `model-exclusions.ts` loads once per process
  (`loaded` flag); `reloadFromDisk()` exists but nothing calls it automatically. Live
  instance: glm-5.3 + glm-5.3-flash recorded 429 at 09:14/09:21 UTC, provider reset was
  09:46 UTC, store file removed mid-session, yet both models stayed blocked (explicit
  requests hard-throw, inherited resolution reports "no usable subagent models") until
  the 24h TTL or a process restart. Full remedy remains: quit pi → delete store file →
  restart (restart alone also suffices when the file is already gone). Upstream ask
  unchanged (parse provider reset hint / cap TTL); additionally a reload-on-miss or
  documented operator refresh hook would remove the restart requirement.

- **2026-09-10 (later)** — checked upstream **0.67.0** release notes + source against the
  model-exclusions TTL ask: **partially addressed, not fixed by default**. What landed
  (already in our on-disk 0.66.0): `modelExclusions.defaultTtlMs` config key
  (`<agentDir>/extensions/subagent/config.json`, validated finite positive, applied at
  extension registration via `applyModelExclusionsConfig`, and `shortenExisting: true`
  when configured — so a configured TTL ALSO shortens already-cached exclusions at
  load); `PI_MODEL_EXCLUSIONS_PATH` env to relocate the store; auth-class exclusions
  auto-invalidate when `auth.json` mtime changes. Still NOT fixed: default TTL remains
  24h (zai's 5h quota window still over-cached out of the box); no provider
  reset-hint parsing (no retryAfter/resetAt logic anywhere); `reloadFromDisk()` still
  has no production caller; TTL config applies only at pi startup (no mid-session
  re-apply). Mitigation deployed locally: wrote `~/.pi/agent/extensions/subagent/
  config.json` with `modelExclusions.defaultTtlMs = 18000000` (5h, matching the zai
  window) — takes effect at next pi restart, which also shortens any pre-existing
  entries. 0.67.0 also bumps launch contracts to v3 / launch-binding projections to v2
  (digest changes; saved runs still resume) — watch item C-digest on next upgrade.
  Environment state: pi 0.85.1 = npm latest (current); pi-subagents disk 0.66.0 vs
  npm 0.67.0; current pi process started 17:02 today, in-memory = disk = 0.66.0, no
  skew.

- **2026-09-07** — pi-subagents **0.66.0** installed (2026-09-06 release, on disk 08-09-07).
  Reviewed full changelog against C1–C6: zero contract-surface changes (delegation
  event fields, result envelope kinds, runtime-agent-register payload, exports map
  all unchanged). Additive only: agent registration gains optional `advertise:`
  (prompt visibility), read-only 429 fallback continuation, named workflows for
  trusted extensions. **STRUCK the 2026-09-05 background-children watch** — 0.66.0
  #1944 fixes background launches on stable pi 0.85.1 without experimental
  packages, exactly the upstream gap we documented. Version-skew note: sessions
  started before 2026-09-07 08:48 hold 0.65.x in memory vs 0.66.0 on disk; the
  0.64 CLI-spawn skew class does not apply to 0.65+ in-process foreground
  children, and v0.3.72 skew guards (shapes A/B) remain the backstop.

- **2026-09-05** — ~~OPEN WATCH: pi-subagents 0.65.1 × pi 0.85.1 background children
  broken upstream.~~ **RESOLVED 2026-09-07 by 0.66.0 (#1944)** — kept for history.
  Background/async children required `@earendil-works/pi-server`
  (+`/unix`) and `@earendil-works/pi-client/unix` resolvable from the **pi package
  root** (`resolveHostPeerAliases`, `runs/background/runner-aliases.ts:123` — walks
  only the pi install tree). pi 0.85.1 declares neither as a dependency and does not
  ship them; pi-subagents' band-aid (`findHostPeerPackageDir` from the extension
  root) applies to **exactly pi 0.85.0 only** ("Pi 0.85.0 omitted this runtime
  dependency. Never extend this exact version contract"); `pi-client` is installed
  nowhere on this machine. Impact on us: **NONE for the pipeline** — every
  pi-super-dev delegation is foreground/in-process (v0.4.0 single backend), verified
  live. Only interactive `async` subagent fan-out in pi sessions fails (detached
  runner crash: `Cannot find module .../watchdog/register-main` chain). Workaround if
  async spawns are needed locally: symlink `~/.pi/agent/npm/node_modules/@earendil-works/pi-server`
  (0.85.0, exports `./unix` ✓) and an installed `@earendil-works/pi-client` into the
  mise pi tree's `node_modules/@earendil-works/`. Remove this item when pi-subagents
  extends the resolution to 0.85.x hosts or pi ships the packages.

- **2026-09-08** — pi-subagents **0.66.0**: TWO upstream gaps found via the
  2026-09-08T05-30-30-723Z incident + the v0.3.82 dual review. (1) **Persisted
  model-exclusions poison restarts**: 0.66.0 flushes the model-exclusion store
  to `<tmp>/pi-subagents-uid-<uid>/model-exclusions.json` and RELOADS it at
  startup; only auth-shaped entries self-invalidate (auth.json mtime), while
  quota 429 entries ride the flat 24h `DEFAULT_MODEL_EXCLUSION_TTL_MS` and
  IGNORE the provider's own reset hint (zai: "将在 … 重置" — user-confirmed
  local time). A 5-hour quota window therefore poisons every fresh process
  for 24h (incident: quota reset 20:12, exclusions live until next 08:15;
  manual remediation = quit pi, delete the store file, restart). Upstream
  ask: parse the provider reset hint and cap the TTL (the auth-mtime
  precedent already exists in `invalidateAuthExclusions`). Engine-side
  mitigation shipped in v0.3.82 (`assessQuotaReset` + persistence-aware
  remedy). (2) **`pi.getAllTools()` throws during extension activation**
  (notInitialized stub until `_bindExtensionCore`, which runs after every
  extension factory) and package load order follows the settings.json
  `packages` array (NOT alphabetical) — extensions cannot enumerate tools at
  activation. Engine-side workaround shipped in v0.3.82
  (`registerSuperDevAgentsDeferred`: first `session_start` + 15s fallback).
  Upstream ask: a documented activation-safe tool-enumeration API.

- **2026-09-08** — pi-subagents **0.66.0** on disk (installed 2026-09-07 08:48).
  Verified live from a pi session started 2026-09-04 (in-memory 0.65.x): foreground
  in-process child delegation WORKS (builtin implementer "OK" probe) and background
  async workflow children spawn (runs.run fan-out) — no version-skew crash class
  observed across the 0.65.x→0.66.0 boundary so far. `codex-exec`/`claude-code`
  external-CLI children fail on their OWN auth (401 against api.openai.com), not on
  the delegation machinery — ops note only. Re-check C1-C6 contract surfaces against
  0.66.0 source when changelog access is available (npm/github fetch blocked
  historically; AnySearch first).

- **2026-08-29** — checked after "pi-subagents updated today" report. No new npm
  release (0.58.0 remains latest, published 2026-08-27T04:57Z). Main gained 10
  unreleased commits (through `1f2abe1`): turnBudget/defaultTurnBudget removals
  (unused by us), optional `allowNestedSubagents`, fleet display hardening,
  validatePositiveInteger hardening. C1/C3 byte-identical; uuid-vs-path fix
  (v0.3.27) still correct against both installed and latest main.
