# Run 2026-09-12T15-16-29-042Z — antigravity/gemini-3.8-flash model-exclusion root cause
Status: postmortem complete (2026-09-12) — operator config remediation applied; durable fixes tracked as v0.3.95 wave (slug + thinking clamp/log fidelity)

- **Task:** `implement @docs/requirements/26-capability-backends.md` (pi-omisis repo)
- **Spec:** `26-docs-requirements-26-capability-backends`
- **Outcome:** aborted at Stage 2B Requirements Review, 235ms into the reviewer
  delegation — non-retryable "agent environment failure" (model exclusion).
- **Run log:** `~/.super-dev/runs/2026-09-12T15-16-29-042Z/run.log`
- **Cost before abort:** $0.0362 (classify $0.0011, requirements $0.0350)

## 1. Incident

`super_dev` was invoked; the pipeline created the worktree
`.worktree/26-docs-requirements-26-capability-backends`, classified (feature),
completed Stage 2B Requirements (10m27s, glm-5.3-flash:high, rendered
`01-requirements.md` 15,689 bytes), then died instantly on the reviewer:

```
delegation requirements-reviewer: request agent=sd-requirements-reviewer
  model=antigravity/gemini-3.8-flash timeout=1800000ms
delegation requirements-reviewer: terminal status=failed   (216ms later)
Workflow "super-dev" aborted: non-retryable agent environment failure:
  Requested subagent model 'antigravity/gemini-3.8-flash' is excluded and cannot
  be replaced by a fallback (reason: Model "antigravity/gemini-3.8-flash:max"
  not found. Use --list-models to see available models.;
  expires: 2026-09-12T19:53:10.580Z)
```

## 2. Root-cause chain

1. **Reviewer model is configured without a thinking suffix.**
   `~/.super-dev/config.json` `agentModels` pins seven roles to bare
   `antigravity/gemini-3.8-flash` (code/adversarial/spec/requirements/bdd/design
   reviewer + judge). The zai entries by contrast pin suffixes
   (`zai-coding-cn/glm-5.3-flash:high`, `...:low`) — the antigravity ones don't.

2. **`requirements-reviewer` has no thinking tier, so it inherits the parent
   session's level.** `delegation-backend.ts:325-327` resolves
   `resolveThinking(agent, perCall, inherited)` per
   `agent-runtime.ts:715-724`:
   `per-call → SUPER_DEV_THINKING env → config.agentThinking[role] →
   config.agentModels[role] :level suffix → ROLE TIER → inherited → medium`.
   `REASONING_AGENTS` (`agent-runtime.ts:577-588`) contains only
   design / spec-writer / **adversarial-reviewer** / **code-reviewer** / debug /
   assessment / **judge** — it does NOT contain `requirements-reviewer`,
   `spec-reviewer`, `bdd-reviewer`, or `design-reviewer`. With no per-call, env,
   agentThinking, or suffix configured, the four untiered reviewers fall through
   to `inheritedThinking` — the pi main session's thinking level (`max` here).
   Tiered roles got lucky: `adversarial-reviewer`/`code-reviewer`/`judge` would
   dispatch `:high` and work on the same config.

3. **`gemini-3.8-flash` does not support `max`.** The antigravity catalog
   (`~/.pi/agent/antigravity-model-catalog.json`) maps thinking levels
   `low/medium/high` only; `off/minimal/xhigh/max` map to `null`.
   pi-subagents attaches the suffix in `async-execution.ts`
   (`applyThinkingSuffix(primaryModel, effectiveThinking, ...)`) and the
   provider rejects the resulting id `antigravity/gemini-3.8-flash:max`
   ("Model not found. Use --list-models").

4. **The failure is cached as a model exclusion keyed on the BARE model id.**
   `recordModelFailure` (`model-exclusions.ts:208`) stores
   `{provider: "antigravity", modelId: "gemini-3.8-flash"}` — the `:max` suffix
   is stripped, so the exclusion matches the model at EVERY thinking level.
   The 5h TTL comes from `~/.pi/agent/extensions/subagent/config.json`
   (`modelExclusions.defaultTtlMs: 18000000`), overriding the 24h default —
   the error text's "flat 24h TTL" wording is stale. Store file:
   `/tmp/pi-subagents-uid-1000/model-exclusions.json`.
   (`recordedAt 14:53:10Z` — an earlier dispatch recorded it ~23min BEFORE this
   run started at 15:16:29Z; this run consumed the cached entry, not the live
   failure. Expires `19:53:10Z`.)

5. **Every later explicit request for the model hard-fails in-process.**
   The gate `throwForExplicitModelExclusion` (`model-fallback.ts:336-341`,
   called at :380 and :483) runs PARENT-side (this pi process — the failure
   returned in 216ms with no child spawned) against a one-shot in-memory load
   (`ensureLoaded`, `model-exclusions.ts:128` — `loaded` flag never resets).
   So the model is blocked for this process's lifetime regardless of thinking
   level, until the TTL lapses.

6. **The existing stale-exclusion bypass is NOT wired to this gate.**
   `ignoreStaleModelUnavailableExclusion` (`model-fallback.ts:331-334`) does
   exactly the right thing — ignores "model not found"-shaped exclusions when
   the BASE model is in the current registry (`gemini-3.8-flash` is) — but it is
   only passed as `ignoreExclusion` into fallback filtering
   (`model-fallback.ts:516`), never into `throwForExplicitModelExclusion`.
   `clearExclusions()` and `reloadFromDisk()` are exported with **zero callers**
   in the package — dead test hooks with no runtime surface.

7. **The tool-level `model` param cannot rescue the run.** `resolveAgentModel`
   precedence is `call.model → agentModels[role] → globalModel`
   (`workflow.ts:394,403-410`) — the config entry beats the tool param, so the
   fix has to land in `~/.super-dev/config.json`.

## 3. Key facts

| Fact | Value | Source |
|---|---|---|
| Excluded model | `antigravity/gemini-3.8-flash` (bare id, any thinking) | store file |
| Reason | `Model "...flash:max" not found` (suffix invalid, base model valid) | store file |
| TTL | 5h (configured), expires 2026-09-12T19:53:10Z | `extensions/subagent/config.json` |
| In-memory copy | lives for the pi process lifetime; restart + file clear both required | `model-exclusions.ts:128` |
| Thinking map (3.8-flash) | low/medium/high only; max→null | antigravity-model-catalog.json |
| Untiered reviewers (inherit max) | requirements-, spec-, bdd-, design-reviewer | `agent-runtime.ts:577` |
| Config suffix precedence | beats role tier AND inherited level | `agent-runtime.ts:715-724` |
| Config re-read | lazy per dispatch — no restart needed for config.json edits | `agent-runtime.ts:676` |

## 4. Remedies

### 4.1 Operator fix (config) — APPLIED 2026-09-12

**Status: applied.** All seven antigravity entries in `~/.super-dev/config.json`
now carry the `:high` suffix (verified by re-reading the file). Applies to the
next dispatch without a pi restart.

Pin a supported level on every antigravity entry in `~/.super-dev/config.json`
(the `:high` suffix is the max supported by this model and outranks both the
role tier and session inheritance):

```diff
-   "code-reviewer": "antigravity/gemini-3.8-flash",
-   "adversarial-reviewer": "antigravity/gemini-3.8-flash",
-   "spec-reviewer": "antigravity/gemini-3.8-flash",
-   "requirements-reviewer": "antigravity/gemini-3.8-flash",
-   "bdd-reviewer": "antigravity/gemini-3.8-flash",
-   "design-reviewer": "antigravity/gemini-3.8-flash",
-   "judge": "antigravity/gemini-3.8-flash"
+   "code-reviewer": "antigravity/gemini-3.8-flash:high",
+   "adversarial-reviewer": "antigravity/gemini-3.8-flash:high",
+   "spec-reviewer": "antigravity/gemini-3.8-flash:high",
+   "requirements-reviewer": "antigravity/gemini-3.8-flash:high",
+   "bdd-reviewer": "antigravity/gemini-3.8-flash:high",
+   "design-reviewer": "antigravity/gemini-3.8-flash:high",
+   "judge": "antigravity/gemini-3.8-flash:high"
```

Config edits apply to later dispatches without a pi restart (`getConfig` is
lazily read per call) — but the stale in-process exclusion still blocks this
model until cleared (see 4.2).

### 4.2 Unblocking the current session (pick one)

| Option | Steps | Trade-off |
|---|---|---|
| A. Restart + clear (documented remedy) | apply 4.1, delete `/tmp/pi-subagents-uid-1000/model-exclusions.json` (or just its entry), quit + restart pi, resume | clean; costs a session restart |
| B. Wait out the TTL | apply 4.1, resume after 19:53:10Z (~4.4h from abort) | no restart; run sits idle for hours |
| C. Switch reviewer model now | point the 7 roles at a non-excluded model (e.g. `antigravity/gemini-3.7-flash:high`, same family, in catalog, not excluded) and resume immediately | no restart; changes reviewer model mid-fleet |
| D. `agentThinking` map | add `"agentThinking": {"requirements-reviewer": "high", ...}` instead of suffixes | equivalent to 4.1 (suffix is the colocated sugar); still needs A/B/C for the cache |

### 4.3 Resume mechanics

- `super_dev` with `resume: true` (auto-picks this most-recent interrupted run)
  or `resumeSpecId: "26-docs-requirements-26-capability-backends"`.
- Stage 2B Requirements is DONE and preserved — do not redo: the clarifier
  (glm-5.3-flash:high, 20 turns, 47 tool calls, 120k/23k tokens) rendered
  `docs/specifications/26-docs-requirements-26-capability-backends/01-requirements.md`
  in the worktree and already corrected spec drift found during grounding:
  spec 26's "13th/14th/15th" registry ordinals are stale (catalyst took the
  14th slot) → requirement reworded membership-based 14→17; AC-28a/AC-28b
  renumbered AC-31/AC-32 (validator requires strictly numeric ids).
- Worktree `.worktree/26-docs-requirements-26-capability-backends` already
  exists with the rendered artifacts, eval-report.md, usage-report.md.

## 5. Durable engineering fixes (candidates)

1. **super-dev: validate thinking against the model's map before dispatch**
   (fail-loud at invocation start, matching the repo's fail-closed direction).
   The dispatch seam (`workflow.ts` / `delegation-backend.ts`) knows both the
   resolved model and the effective thinking; a model whose
   `thinkingLevelMap[level] === null` should surface a config error at run
   START (or dispatch), not die mid-run as a provider "not found" that then
   poisons a 5h cache. The catalog data is already available
   (`~/.pi/agent/antigravity-model-catalog.json` shape, `findModelInfo` in
   pi-subagents).
2. **super-dev: tier the four untiered reviewers** (`requirements-reviewer`,
   `spec-reviewer`, `bdd-reviewer`, `design-reviewer`) — either add them to
   `REASONING_AGENTS` (→ "high") or document that reviewer roles must always
   resolve an explicit level. Root cause #2 is silent inheritance from an
   arbitrary parent-session level; the v0.3.43 tier system was built exactly to
   prevent `:max` parent inflation of specialists (its own comment:
   ~1.5M of 2.36M output tokens wasted across two runs) but left these four
   roles unlisted.
3. **pi-subagents: key "not found" exclusions correctly.**
   `ignoreStaleModelUnavailableExclusion` already encodes the right predicate —
   wire it into `throwForExplicitModelExclusion` (or into `findModelExclusion`)
   so an exclusion recorded from an invalid `model:level` combination does not
   block the valid base model. Alternatively record such failures under the
   full suffixed id, or skip recording when the base model is in the registry
   and only the suffix was invalid.
4. **pi-subagents: expose the cache-clear hooks.** `clearExclusions()` /
   `reloadFromDisk()` are exported with no callers; wiring one to a tool or
   honoring mid-process file deletion would remove the restart requirement
   entirely (currently: restart alone is insufficient AND file-clearing alone
   is insufficient — both are needed, which the error message does convey).
5. **pi-subagents: stale error-message text.** The abort message claims a
   "flat 24h TTL" while the effective TTL is configurable (5h here) — minor,
   but it misleads operators sizing the wait-out option.

## 6. Evidence index

- Run log: `~/.super-dev/runs/2026-09-12T15-16-29-042Z/run.log`
- Exclusion store: `/tmp/pi-subagents-uid-1000/model-exclusions.json`
- TTL config: `~/.pi/agent/extensions/subagent/config.json`
- Model catalog: `~/.pi/agent/antigravity-model-catalog.json` (3.8-flash:
  `thinkingLevelMap {off:null, minimal:null, low:"low", medium:"medium",
  high:"high", xhigh:null, max:null}`)
- super-dev: `src/agents/agent-runtime.ts:577-588,715-724`;
  `src/agents/delegation-backend.ts:316-327`; `src/workflow.ts:394-410,672-677`;
  `~/.super-dev/config.json`
- pi-subagents: `src/runs/shared/model-exclusions.ts:128,208,240,345`;
  `src/runs/shared/model-fallback.ts:331-341,380,483,516`;
  `src/runs/background/async-execution.ts:1693-1704`
