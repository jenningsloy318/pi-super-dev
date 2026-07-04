# Deep audit: systemic issues in the super-dev pipeline

**Date:** 2026-07-04 · **Method:** re-read session-agent.ts, nodes.ts (gate/loop/
retry/parallel/map), workflow.ts, stages/{index,writers,implementation}.ts, all
agents/*.md, helpers.ts gates — plus two real-model verify runs.

## What is verified WORKING (this branch)

- **Per-stage `structured_output` schema** (extractControlKeys → declared keys):
  requirements and BDD agents now return ALL declared keys on real glm-5.1 calls.
- **Doc-content gates** (ported from super-dev-plugin definitions.mjs): gate-bdd
  PASSES on a real 19KB/33-scenario BDD doc even though `scenarioCount` came back
  as the *string* `"33"` and `edgeCasesCovered` as a JSON string. Content is
  authoritative; the self-reported control object is only a fallback. This is the
  correct fix for the original "26 scenarios written, gate failed" false negative.

## Confirmed code bugs (to fix now)

### B1. Corrective re-prompt fires on a FALSE premise
`runAgentViaSession`: `missing = missingKeys(afterFirst, keys)` where `afterFirst`
is `undefined` when `structured_output` was **never called** → `missing` = all keys
→ it sends *"Your previous structured_output was missing required keys: …"* to an
agent that never called the tool at all. Confusing + wasteful, and for an agent
that simply didn't finish it can't help. **Fix:** only fire when `capture.called`.

### B2. Corrective re-prompt OVERWRITES instead of merging
The `structured_output` execute does `capture.value = params`. If the corrective
turn returns only the previously-missing keys, the keys that WERE present in the
first call are lost. **Fix:** `capture.value = { ...capture.value, ...params }`.

### B3. `filesModified` is never populated (implementation.ts)
`const filesModified: string[] = []` is declared and returned in the control, but
nothing ever pushes to it — the implementer agent's `filesModified` is discarded
(only `qa.control` feeds the build gate). The implementation summary always
reports an empty file list. **Fix:** capture the implementer result and accumulate.

## Systemic / robustness issues (the real lesson)

### S1. Model non-determinism is the dominant failure mode
Two identical BDD verify runs: one returned `control: null` + no doc; the next
wrote 33 scenarios and passed. glm-5.1 occasionally produces *nothing* for a
complex multi-step task. The pipeline must tolerate this — which is what
`gate({ attempts: 3 })` is for — but each attempt is a **cold** session that
re-does all the work and can fail the same way. We pay 3× cost and learn nothing
from the failure.

### S2. No observability of WHY an agent failed
Sessions use `SessionManager.inMemory` → zero logs unless `SUPER_DEV_DEBUG=1`.
A timeout, a thrown error, and "the model just stopped" all look identical
(`control: null`) in a normal run. This whack-a-mole is *because* we couldn't see
inside. **Fix:** always surface the failure reason (timeout vs error vs
empty-and-asked-a-question) in `writerTask`'s log, including a snippet of the last
assistant text when there's no control and no error.

### S3. `gate-build` trusts the agent's self-report
`gateBuild` checks `qa.buildSuccess` / `qa.allTestsPass` — booleans the qa-agent
*claims*. The original has a real `gate-build` that runs the project's test/build
command. A model can lie ("allTestsPass: true"). **Fix (tier-3 follow-up):** run
the actual build/test in the worktree (detect npm/cargo/go/etc.) instead of
trusting the control object. (The content-gate approach doesn't apply here —
there's no doc to read; the artifact is a passing test run.)

### S4. Timeouts are stage-blind
Default 300s. BDD wrote 19KB across 7 turns and took a while; heavier stages
(implementation, spec with 3 docs) can exceed it. A timeout returns `control: null`
indistinguishable from "did nothing" (see S2). **Fix:** stage-aware timeouts (or a
larger default for known-heavy stages) + always tag the result `error` on timeout
(already done) so S2's surfacing can report it.

### S5. Cold gate retries don't carry feedback
When a gate fails, the retry is a fresh session with the original prompt — it
doesn't know *why* the previous attempt failed (e.g. "your BDD doc had no
SCENARIO-NN ids"). The original gate engine returned structured errors; feeding
those back into the retry would make the 3 attempts actually converge. **Fix
(future):** pass the gate's `errors[]` into the retry prompt.

## Non-issues (checked, OK)

- Interactive-agent mismatch: only `requirements-clarifier.md` uses interview
  language; bdd-scenario-writer / implementer / spec-writer are pure writers. The
  schema fix covers the requirements case.
- `parallel` code-review branches write distinct state keys (codeReview vs
  adversarialReview) → no race.
- `loop`/`retry`/`gate` control-flow is correct (re-read nodes.ts).

## Plan
Fix B1, B2, B3 + S2 (surfacing) now in this branch — they're clear, low-risk, and
directly reduce the whack-a-mole. S3 (real build gate) and S5 (feedback retries)
are valuable follow-ups but larger; defer. Verify with unit tests (the model path
is already proven by the two real runs).
