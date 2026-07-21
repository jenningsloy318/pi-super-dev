# Comprehensive Implementation Plan: Self-Improving Pipeline

## Architecture Overview

Three layers from the Anthropic article, adapted to our pipeline:

```
Layer 1: Memory Management     → .knowledge.md (within-run) + learned.md (cross-run)
Layer 2: Production Guardrails → render pipeline (permission isolation) + audit trail (versioning)
Layer 3: Dreaming (Reflection) → post-run agent: audit → score → learned.md → index rebuild
```

## File Layout

```
~/.pi/agent/super-dev/                      # USER-LEVEL (cross-run, cross-project)
├── config.json                             #   toggles + thresholds
├── learned.md                              #   scored lessons (source of truth, append-only)
├── learned-index.json                      #   generated index (byAgent/byStage/byLang/topOverall)
├── learned-archive.md                      #   purged entries (cold storage)
├── runs/
│   └── <timestamp>-<specId>/               #   per-run directory (self-contained)
│       ├── run.log                          #     human-readable transcript
│       ├── audit.jsonl                      #     structured per-stage audit trail
│       └── reflection.md                    #     what the reflection agent found
├── traces/                                 #   SUPER_DEV_DEBUG per-agent traces
│   └── <timestamp>-<agentId>.json
└── stats.json                              #   aggregate cross-run statistics

<worktree>/docs/specifications/<spec>/      # SPEC-LEVEL (within-run)
├── 01-requirements.md                      #   rendered docs (human-readable)
├── 02-bdd-scenarios.md
├── ...
└── .knowledge.md                           #   auto-accumulated raw data (agent-readable)
```

## Implementation Phases

### Phase 1: Directory + Config + Audit Trail (foundation)

**Goal:** centralize all super-dev data at `~/.pi/agent/super-dev/`; write structured
audit trail per stage; move existing logs/traces here.

**Files to create:**
- `src/render/super-dev-dir.ts` — resolves `~/.pi/agent/super-dev/`, creates dirs,
  reads/writes `config.json` with defaults, manages paths for runs/traces/learned.

**Files to modify:**
- `src/extension.ts` — redirect `.super-dev-logs/` from project cwd to
  `~/.pi/agent/super-dev/runs/<ts>-<spec>/run.log`.
- `src/session-agent.ts` — redirect `dumpTrace` from `$TMPDIR/super-dev-debug/`
  to `~/.pi/agent/super-dev/traces/`.
- `src/nodes.ts` `task()` — after each stage run, append to `audit.jsonl`:
  ```jsonl
  {"ts":"...","stage":"requirements","agent":"requirements-clarifier","attempt":1,"durationMs":34000,"gate":{"pass":true,"errors":[]},"control":{"acCount":"5"},"turns":4,"backend":"session"}
  ```
- `src/nodes.ts` `gate()` — after each validation, append the gate result
  (pass/fail + errors + attempt number).

**Tests:**
- Directory creation + config defaults.
- Audit JSONL format (one line per stage execution).
- run.log redirect.

**No behavior change for the user** — just file locations move.

---

### Phase 2: `.knowledge.md` Auto-Accumulation (within-run memory)

**Goal:** after each stage completes, append its control object's key fields to
`.knowledge.md` in the spec directory. Downstream agents read ONE file for all
prior stages' raw data.

**Files to create:**
- `src/render/knowledge.ts` — `appendToKnowledge(specDir, stageId, control)` +
  `formatControlSection(stageId, control)` — serializes the control's key
  structured fields (ACs, scenarios, phases, patterns, services, verdict,
  summary) into a compact markdown section.

**Files to modify:**
- `src/render/render.ts` `renderAndWrite()` — after writing the doc, call
  `appendToKnowledge(setup.specDirectory, stageId, control)`.
- `src/stages/setup.ts` — at pipeline start, clear `.knowledge.md` (fresh run).
- `src/prompts.ts` — in `ctxBlock()` or each `build*Prompt`, add a one-liner:
  `"Read docs/specifications/<spec>/.knowledge.md for all prior stages' key data."`

**Format per section:**
```markdown
## Stage: requirements (2026-07-05T09:17:41Z)
**Agent**: requirements-clarifier
**ACs**: AC-01: Fetch precipitation; AC-02: Sum values; AC-03: Render
**NFRs**: Performance (<100ms), Security
**Summary**: Add YTD rain total using Open-Meteo Archive API.
```

**Tests:**
- `appendToKnowledge` writes correct format.
- Multiple stages accumulate in order.
- `.knowledge.md` cleared at setup.

**Guarantees completeness:** data comes from control objects (raw structured
output), not summaries. Exact AC text, exact scenario IDs, exact phase names.

---

### Phase 3: `learned.md` + Index + `loadAgentPrompt` Injection (cross-run memory)

**Goal:** load top-scored lessons from `learned-index.json` and inject into every
agent's system prompt. Agent sees top-3 full + top-10 index + file path for grep.

**Files to create:**
- `src/render/learned.ts` — `loadLearnedLessons(agentName, lang)`:
  reads `learned-index.json` → filters by `byAgent[name]` + `byLang[lang|any]`
  → sorts by score → returns formatted string (top-3 full + top-10 index + path).

**Files to modify:**
- `src/agents.ts` `loadAgentPrompt()` — after loading the agent's `.md`, call
  `loadLearnedLessons(name, lang)` and append the result. Lang comes from
  `process.env.SUPER_DEV_LANG` (set by the pipeline from `classify.language`)
  or defaults to "any".

**Injection format (always ~2KB, regardless of total entries):**
```
## Lessons from past runs (top-scored, pre-loaded)
### [score:51] Spec phases-as-string
Spec agent returns phases as a string. Check prompt's field description.
### [score:42] API-test .env not loaded
Express servers need PORT env injection.
### [score:35] Requirements omit NFR
GLM-5.1 omits non-functional requirements. List ≥1 NFR.

## More lessons (grep for details)
File: ~/.pi/agent/super-dev/learned.md
- [score:24] Debug hypotheses too vague
- [score:18] Code-review verdict lowercase
- [score:12] BDD scenarioCount as string
... and 3 more
```

**Tests:**
- Empty `learned-index.json` → no injection (graceful).
- Populated index → top-3 full + top-10 index format.
- Filtering by agent name + language.

---

### Phase 4: Reflection Agent (the "dreaming" loop)

**Goal:** after pipeline completes, spawn a reflection agent that reads the audit
trail, identifies patterns, scores them, and updates `learned.md` +
`learned-index.json`.

**Files to create:**
- `agents/reflection.md` — agent prompt: "Read the audit trail at <path>.
  Identify patterns (retries, errors, timing). Score each:
  `score = frequency × 10 + impact × 5 + recency + severity × 3`. Read
  `learned.md` for dedup (if pattern exists → increment frequency). Append
  new/updated entries. Purge entries with score < minScoreToKeep →
  `learned-archive.md`. Rebuild `learned-index.json`. Write `reflection.md`
  summary."
- `src/render/reflection.ts` — `runReflection(auditPath, superDevDir, config)`:
  spawns the reflection agent via `runAgentViaSession`, passing the audit path +
  learned paths. Non-blocking (async, doesn't delay the user's result).

**Files to modify:**
- `src/extension.ts` — after `runPipelineTask` completes, if
  `config.reflectionEnabled`, spawn the reflection agent asynchronously
  (fire-and-forget with a timeout).

**Scoring formula:**
```
score = frequency × 10 + impact × 5 + recency + severity × 3

frequency:  times this pattern appeared across ALL runs (1, 2, 3, ...)
impact:     0=info, 1=retry, 2=gate-fail, 3=pipeline-abort
recency:    3=today, 2=this-week, 1=this-month, 0=older
severity:   1=low, 2=medium, 3=high, 4=critical
```

**`learned.md` format (append-only source of truth):**
```markdown
## [score:51] [agent:spec-writer] [stage:spec] [lang:any] [freq:3] [impact:gate-fail] [severity:high] [date:2026-07-05]
Spec agent returns phases as a string. normalizePhases coerces at runtime.
```

**`learned-index.json` format (generated, rebuilt):**
```json
{
  "totalEntries": 42,
  "entries": { "spec-phases-string": { "title": "...", "score": 51, "tags": {...}, "line": 3, "summary": "..." } },
  "byAgent": { "spec-writer": ["spec-phases-string"] },
  "byStage": { "spec": ["spec-phases-string"] },
  "byLang": { "any": ["spec-phases-string"] },
  "topOverall": ["spec-phases-string"]
}
```

**Tests:**
- Reflection agent mock: given an audit trail with a retry, produces a scored
  entry in `learned.md`.
- Index rebuild: parse `learned.md` → generate `learned-index.json`.
- Dedup: existing pattern → frequency incremented, not duplicated.
- Purge: score < threshold → moved to archive.

---

### Phase 5: Upstream Structured Injection (progressive disclosure)

**Goal:** inject exact ACs/scenarios/phases from upstream control objects into
downstream prompts (not vague summaries). `.knowledge.md` provides the
comprehensive fallback.

**Files to create:**
- `src/render/upstream.ts` — `upstreamStructured(label, control)`:
  formats the control's key fields (acceptanceCriteria, features.scenarios,
  phases, patterns, verdict, services) into a compact prompt section.

**Files to modify:**
- `src/prompts.ts` — replace bare `- Requirements: ${docPath}` with
  `upstreamStructured("Requirements", state.requirements)` in each
  `build*Prompt`. Each prompt gets the exact structured data from upstream +
  the full doc path (for prose/detail) + the `.knowledge.md` reference.

**Injection format:**
```
- Requirements:
  AC-01: Fetch precipitation data from Open-Meteo Archive API
  AC-02: Sum precipitation values from Jan 1 to today
  AC-03: Render the total below the forecast grid
  AC-04: Support metric and imperial units
  AC-05: Degrade gracefully on API failure
  NFRs: Performance (<100ms), Security (no API key)
  Full doc: /path/to/01-requirements.md
```

**Tests:**
- `upstreamStructured` formats ACs correctly.
- Missing control → "N/A" gracefully.
- Each `build*Prompt` includes the structured upstream data.

---

### Phase 6: Cleanup + Retention + Stats

**Goal:** periodic cleanup of old runs/traces; update aggregate stats.

**Files to modify:**
- `src/render/reflection.ts` — after updating `learned.md`, the reflection
  agent also:
  - Deletes run dirs older than `runRetentionDays`.
  - Deletes traces older than `traceRetentionDays`.
  - Purges `learned.md` entries with score < `minScoreToKeep`.
  - Updates `stats.json` (totalRuns++, avgAttempts per stage, etc.).

**Tests:**
- Old runs deleted after threshold.
- Low-score entries archived.
- Stats updated correctly.

---

## Phase Summary

| Phase | What | Effort | Depends on |
|---|---|---|---|
| **1. Directory + Audit** | Centralize files; write audit JSONL | Medium | Nothing |
| **2. `.knowledge.md`** | Auto-accumulate raw data per stage | Small | Phase 1 (for paths) |
| **3. `learned.md` Injection** | Load top-N lessons into agent prompts | Small | Phase 1 (for paths) |
| **4. Reflection Agent** | Post-run: audit → score → learned.md | Medium | Phases 1 + 3 |
| **5. Upstream Injection** | Exact structured data in prompts | Small | Phase 2 (complementary) |
| **6. Cleanup + Stats** | Retention + aggregate stats | Small | Phases 1 + 4 |

**Recommended order:** 1 → 2 → 3 → 5 → 4 → 6

(Phases 2, 3, 5 are independent and small. Phase 4 depends on 1 + 3. Phase 6
depends on 4.)

## What This Delivers

| Article principle | Our implementation |
|---|---|
| Memory as structured files | `.knowledge.md` (within-run) + `learned.md` (cross-run) |
| Agent self-retrieval (bash/grep) | Agents grep `learned.md` + `.knowledge.md` |
| Progressive disclosure | Tier 1: upstream injection (~500B) → Tier 2: `.knowledge.md` (~3KB) → Tier 3: full docs → Tier 4: `learned.md` top-3 + index |
| Permission isolation | Render pipeline (agent returns data, pipeline writes doc) |
| Versioning | Git (docs) + append-only (learned.md) + audit trail (JSONL) |
| Offline reflection | Post-run agent: audit → patterns → score → learned.md |
| Cross-run learning | `loadAgentPrompt` injects top-scored lessons from `learned-index.json` |
| Self-cleaning | Score decay → purge → archive; retention limits on runs/traces |

## Key Design Decisions

1. **`.knowledge.md` is auto-generated from control objects** — not written by
   agents. Guarantees completeness (exact AC text, scenario IDs, phase names).
   ~30 lines of code.

2. **`learned.md` is append-only** — reflection agent appends/updates, never
   rewrites. Prevents corruption. Old entries decay (score → 0) and get archived.

3. **`learned-index.json` is disposable** — can always be rebuilt from
   `learned.md`. The pipeline reads the JSON (fast O(1) lookup); never parses
   the markdown at runtime.

4. **Injection is always capped** — top-3 full + top-10 index, regardless of
   total entries. ~2KB constant. Filtering by agent name + language.

5. **Upstream injection uses structured data, not summaries** — exact AC text
   from `control.acceptanceCriteria[].statement`. Not a vague paraphrase.

6. **Reflection is async, non-blocking** — user sees the pipeline result
   immediately. Reflection runs in the background with a timeout.
