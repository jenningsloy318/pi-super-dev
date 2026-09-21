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

## Version pins (verified 2026-09-20)

- pi-subagents: **0.70.1** installed (= npm `latest`; the #2352/#2371 host-SDK
  resolution fix SHIPPED).
- pi: **0.86.1** (mise node 24.15.0 global install).
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

- **2026-09-21** — pi-subagents **0.70.1** (installed 20:51; pi **0.86.1**): the
  HOST-SDK RESOLUTION FIX SHIPPED. #2371 (`resolve host SDK exports correctly`)
  lands upstream's own host-root loader — root precedence (running host →
  explicit override → install tree), manifest+entry+import all validated, bare
  specifier only when no root resolves. Our v0.4.58 `file:` dependency
  (`@earendil-works/pi-coding-agent` in `~/.pi/agent/npm/package.json`) SURVIVED
  the upgrade (symlink intact; probe from child-session's dir resolves) — it now
  merely shadows the fix rather than being load-bearing; keep it until a clean
  run on 0.70.1 proves the upstream path, then retire. #2369 (`apply model
  settings to runtime-registered agents`): mergeRuntimeAgents now applies
  subagent model-tier settings to registered agents when a settings context is
  passed — our per-call model/thinking resolution (precedence A in workflow.ts)
  is unaffected (explicit per-request models outrank discovery-tier settings).
  C1–C6 shapes re-verified against the 0.70.1 tag: delegation event fields,
  result envelope, registration payload, exports map unchanged. STRIKE the
  2026-09-20 host-SDK item's "no npm release carries it yet" after one clean
  live run on 0.70.1.



- **2026-09-20 (later)** — pi-subagents **0.70.0 removed the model-exclusions
  mechanism ENTIRELY** (verified in installed source,
  `src/extension/config.js:188`: "config.modelExclusions was removed; model
  failures are no longer persisted or used for automatic switching" — part of
  #2270 "remove automatic model fallback"; no exclusion store module remains,
  and a config file carrying the key now THROWS at load). Consequences: (a) the
  2026-09-08/09-10 quota-poisoning watch items are HISTORICAL for ≥0.70 — the
  24h-exclusion class cannot recur; a quota 429 is now a plain transient (our
  TRANSIENT_RE ladder + provider reset); (b) the 2026-09-10 local mitigation
  (`~/.pi/agent/extensions/subagent/config.json` with
  `modelExclusions.defaultTtlMs`) is OBSOLETE and MUST NOT be recreated — it
  would crash extension config load on 0.70+ (the file was found empty/absent
  2026-09-20, which is the correct state); (c) our v0.3.82 engine-side
  classification + remedy text for the exclusion envelope is now dead code on
  0.70+ — harmless (the envelope no longer occurs), retained for ≤0.69
  compat. Live observation pending: how the 21:25-21:46 zai quota window
  behaves end-to-end under 0.70 (run 2026-09-20T07-37-57-688Z, spec stage).

- **2026-09-20** — pi-subagents **0.70.0** × pi **0.86.0**: foreground/delegation children
  die instantly with `Cannot find package '@earendil-works/pi-coding-agent' imported from
  …/pi-subagents/src/runs/shared/child-session.js` (run 2026-09-20T06-09-36-327Z: every
  delegated child turns=0 in ~0.3s). ROOT CAUSE (verified end-to-end + byte-reproduced by
  probe): pi 0.86 stopped serving virtual module resolution to extension code, and
  0.70.0's `child-session.ts:133` falls back to the bare
  `import("@earendil-works/pi-coding-agent")`, which cannot resolve from the agent npm
  tree (`~/.pi/agent/npm/node_modules/@earendil-works/` is empty; pi itself lives under
  the mise node tree — not an ancestor for Node resolution). **Fixed upstream 2026-09-19
  by unreleased #2352** (`loadHostPiCodingAgent` — resolves the running pi process's own
  package root and imports by file URL; env override
  `PI_CODING_AGENT_PACKAGE_ROOT`); no npm release carries it yet — re-check
  `npm view pi-subagents version` and strike this entry when ≥0.71 ships. **Local remedy
  APPLIED 2026-09-20** (the 2026-09-05 pi-server pattern):
  `ln -sfn ~/.local/share/mise/installs/node/24.15.0/lib/node_modules/@earendil-works/pi-coding-agent
  ~/.pi/agent/npm/node_modules/@earendil-works/pi-coding-agent` — resolution probe
  verified; live sessions recover on the next delegated call (failed ESM imports are not
  cached). **The bare symlink is NOT durable: pi's startup reconciliation PRUNED it**
  (receipt 2026-09-20 15:00:08 — `~/.pi/agent/npm/package.json` + `node_modules` both
  rebuilt at session start; the `@earendil-works/` scope dir emptied; the failure
  recurred in run 2026-09-20T07-01-08-362Z where v0.4.57's fail-fast worked exactly as
  designed — one real 0.0s failure, then instant sticky-degrade with the remedy).
  **DURABLE remedy applied 15:03 and probe-verified**: `"@earendil-works/pi-coding-agent":
  "file:/home/jenningsl/.local/share/mise/installs/node/24.15.0/lib/node_modules/@earendil-works/pi-coding-agent"`
  declared in `~/.pi/agent/npm/package.json` dependencies + `npm install` there (npm
  installs the file: dep as a symlink PLUS its @earendil-works peers — pi-agent-core,
  pi-ai, pi-tui, chord, pi-telemetry — so the whole import chain resolves; declared deps
  survive pi's reconciliation). Re-check after the next pi restart that the declaration
  survives (if pi ever REGENERATES package.json from settings.json alone, the dep drops
  and the entry-level ask below becomes the only path). Note the file: target is
  node-version-scoped under mise — re-point it after a pi reinstall under a different
  node version. Engine-side (v0.4.57): the ESM wording
  (`Cannot find package '…' imported from …pi-subagents…`) joined the infra-failure
  grammar (`DELEGATION_RUNTIME_EXTENSION_FAILURE_RE` shape C) with its OWN sticky-degrade
  reason + remedy (computed symlink command / #2352 upgrade note), the envelope is
  non-retryable at every `isNonRetryableAgentError` seam, and the RED oracle cycle
  FatalAborts round-1 on it. Also reviewed 0.67→0.70 contract-surface diffs: only
  `f58dfcb` (#2270 "remove automatic model fallback") and `fee92e0` (Herdr saved machines
  for external-cli agents) touch C1–C6 files — #2270 changes the FALLBACK configuration
  surface our model-exclusion envelopes describe ("cannot be replaced by a fallback");
  observed envelopes unchanged on 0.70.0, keep an eye on the wording if it drifts.

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

- **2026-09-11** — pi-subagents **0.67.0** toolBudget verified for v0.3.87 (S4).
  Two upstream gaps discovered while wiring `toolBudget {soft, hard, block}`:
  (1) **no family-scoped counting** — `subagent-prompt-runtime.ts` increments
  `toolCount` on EVERY child tool call; soft/hard are total-call thresholds,
  not external-only counts (super-dev's README recommended values were
  recalibrated 2026-09-11 for this reality; the postmortem's decision-8
  wording assumed external-only counting). Upstream ask: a `countOnly:
  string[]` (or prefix-family) scoping option on toolBudget.
  (2) **block list is exact-name only** — `block.includes(toolName)`; no
  prefix matching, so a `"mcp__"` entry is inert and `mcp__<server>__<tool>`
  direct tools can only be blocked by enumerating exact names (the aggregate
  `mcp` tool is the practical blocking path today; super-dev sends the
  prefix entry anyway so it activates if upstream gains prefix matching).
  Upstream ask: prefix-aware block entries. Neither gap blocks the S4 design
  (block-only-external semantics hold: local tools always retained).

## 2026-09-11 — pi-subagents 0.67 review-lane tool contract (hard-fail on declared-but-unavailable repository tools)

`src/runs/shared/child-tool-plan.ts` — for agent names matching `/\b(?:reviewer|scout)\b/i`, a DECLARED
repository-inspection tool (`REPOSITORY_INSPECTION_TOOLS` = read/grep/find/ls/bash/powershell) that the host
runtime does not provide throws `formatReviewLaneToolContractFailure` — the whole child dies as a lane
infrastructure failure (non-reviewer agents only get the non-fatal prune+warn). Observed live: a super-dev run
launched from a bash-less host session killed every `sd-*-reviewer` child in ~85ms (pi-omisis spec-26,
2026-09-11). super-dev v0.3.92 removes `bash` from READ_ONLY_TOOLS + WILDCARD_READ_ONLY_EXCLUDES accordingly.
Upstream observation (no ask): the hard-fail covers only reviewer|scout names while the declared list that
triggers it comes from the OWNER's registration — owners with read-only reviewer roles should not declare
shell tools they don't require.

## 2026-09-12 — ~~child-path model resolution rejects thinking-suffixed antigravity ids; provider-level exclusion poisoning~~

**SUPERSEDED 2026-09-13** — both the "thinking-suffix" theory and the "npm-only child extension
resolution" framing were artifacts of runtime state, not the code contract. The verified structural
root cause is the next entry (2026-09-13). Retained for history: the observed errors, the exclusion
poisoning kill radius (runs 2026-09-11T14-37 / 2026-09-12T14-09), and the bare-ids-in-config
mitigation — all still accurate observations, wrongly explained.

## 2026-09-13 — pi-subagents 0.67 ROOT CAUSE (verified): foreground/delegation child sessions never load ambient extensions → extension-provided models unresolvable

Verified end-to-end 2026-09-13 (pi-subagents 0.67.0, pi 0.85.1 unchanged since 09-05, so this gap
existed on every prior run too — masked by process runtime state):

- **Mechanism** — `src/runs/shared/child-launch.ts:286`: `const ambientExtensions = input.host ===
  "runner" && !toolPlan.disableAmbientExtensions;` with the doc comment at :109 stating "The parent
  never loads ambient extensions". Foreground (in-process, `host: "parent"`) children — which is what
  the delegation bridge (`extension/index.ts:746-749` → `executeDelegated` → `execute`) and every
  super-dev reviewer lane use — are created with `noExtensions: true` (`child-session.ts:236`) and
  only builtin providers in their ModelRuntime. Any model provided by an EXTENSION (e.g.
  `git:github.com/Rahularya01/pi-antigravity`, later `npm:pi-antigravity` before this fix) is
  unresolvable: `Model "antigravity/gemini-3.8-flash:high" not found. Use --list-models` → P5
  non-retryable agent-environment abort (pi-omisis run 2026-09-13T02-36-58-698Z died at Stage 2B
  requirements-review, reviewer killed in 1.1s).
- **models-store.json is NOT a fallback** — `@earendil-works/pi-ai/dist/models.js:67-76`
  `getModels()` iterates REGISTERED providers only; store entries for unregistered providers are
  never surfaced. Behavioral proof: `pi --no-extensions --list-models` lists **0** antigravity
  models while the store holds all 14; `pi -p --no-extensions --model antigravity/gemini-3.8-flash:high`
  reproduces the child error byte-for-byte.
- **Async/runner children DO work** — `host: "runner"` gets ambient discovery (agent dir, project,
  settings — including git/npm packages). Empirical: three dual-gate reviewers ran on
  `antigravity/gemini-3.8-flash:high` via async spawns the same morning the foreground path aborted.
- **"Why it worked last night" (plausible, not fully reconstructed)** — the process-shared
  ModelRuntime (child-session.ts header: "shares one ModelRuntime across every child it creates";
  `flushQueuedProviderRegistrations` at :176) can retain an antigravity registration flushed by an
  ambient (runner-hosted or host-startup) load. pi-antigravity entered settings.json at 2026-09-12
  23:21; the 23:39 run's reviewers worked; the 10:36 pi restart reset the process and the foreground
  path failed again until the npm install landed.
- **Exclusion-cache compounding (extends the 2026-09-10 item)** — a foreground "not found" failure
  records a model-exclusions entry that (i) blocks the OTHERWISE-WORKING async/runner path pre-spawn
  (one lane's failure poisons the other), (ii) survives on-disk store deletion (in-memory map), and
  (iii) NEW: an already-EXPIRED entry (stated expiry in the past) still blocked a spawn — expired
  entries appear not to be pruned at check time. Suspected upstream bug, add to the ask below.

**Local remedy applied 2026-09-13 (owner)**: `npm:pi-antigravity@0.7.2` installed
(`~/.pi/agent/npm/node_modules/pi-antigravity`), settings.json switched from the git source to the
npm source — children resolve the provider through their own npm discovery; effective next pi
restart (registration reads at activation). **Upstream asks (supersede 2026-09-12's):**
(a) structural — foreground/parent-hosted children should inherit the host's registered provider set
(or load ambient extension MODEL PROVIDERS even when ambient extensions are otherwise disabled —
isolating child TOOLS is reasonable; isolating the model catalog breaks extension-provided models);
(b) prune expired exclusion entries at check time; (c) exclusion granularity per exact model id
(carried over).
