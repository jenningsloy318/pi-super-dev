# Judge Resilience — timeout budget, retry-on-timeout, test-suspect advisory (v0.2.4)

Status: implemented (this commit — v0.2.4)

## Evidence

Run `2026-08-19T03-16-50-261Z` (super-dev v0.2.3, pi-omisis track 07-staged-execution,
resume) died PARTIAL 1/9 in Phase 2 (staged-knowledge-store):

1. Two implementer attempts failed on `npm run test` with a born-broken RED test —
   `tests/staged-knowledge-store.test.ts:239` expects
   `["resolve", "行业面", "基本面"]` after `.sort()`, but UTF-16 code-unit order sorts
   基 (U+57FA) before 行 (U+884C), so the expected literal is unreachable by any
   correct implementation (`tdd-targets-still-red` honestly logged both attempts).
2. The impl-no-progress judge — the exact circuit breaker designed to route
   `re-author-tests` for a defective RED — **timed out at the hardcoded 120s wall**
   (`session ... soft deadline reached (wrap-up at 80% of timeout)`, then
   `timeout after 120000ms; aborting agent session`, `control=no`).
3. The timeout returned `{ status: "degraded" }` and the per-signature budget slot
   was consumed (`signatureCalls.set(sigKey, used + 1)` runs before the agent call),
   so call 2/2 never happened — the phase-01 environmental judge needed 71s on the
   same model with a comparable 19K-char prompt; this call was still exploring at
   the 80% soft deadline.
4. Degraded → no routed branch → headless HITL no-op → terminal stop whose message
   never names the most likely cause: the RED itself is unsatisfiable.

## Research grounding (online, 2026-08-19)

- **Durable-execution engines treat timeouts as retryable, distinct from
  non-retryable business errors.** Temporal retries activities on any exception
  (timeouts included) until the retry policy is exhausted; `non_retryable_error_types`
  is the explicit opt-out for deterministic failures ("mark errors as non-retryable
  when retrying would be wasteful or harmful"), and `MaximumAttempts` counts timed-out
  attempts — a timeout consumes an attempt and the next attempt still runs
  (docs.temporal.io, retry-policies + failures reference). Step Functions gives
  `States.Timeout` and `States.TaskFailed` **separate** Retry/Catch handlers.
- **The major LLM SDKs default to generous per-request timeouts with 2 retries,
  and timeouts are explicitly retryable.** OpenAI and Anthropic SDKs ship
  DEFAULT_TIMEOUT = 600s and DEFAULT_MAX_RETRIES = 2 with exponential backoff;
  Anthropic added 408 Request Timeout to the retryable set by explicit commit
  (anthropic-sdk-python f1e2c4c). Our 120s cap on a multi-tool agentic judge call
  is 5× tighter than the single-request industry default.
- **LLM latency is structurally heavy-tailed.** P50/P99 ratios around 35× are the
  documented shape, not outliers ("a slow LLM response is not a failure — the model
  is still generating"); a timeout set near the observed median tail kills real
  diagnoses. Observed here: 71s typical judge vs >120s tail on the same prompt class.
- **Agent frameworks compose per-node timeouts WITH retry policies and classify
  failure kinds.** LangGraph 1.2: `NodeTimeoutError` clears partial writes and hands
  control to the retry policy; retry policies retry temporary failures (timeouts,
  transient outages) and skip logic errors. LangGraph also distinguishes
  `run_timeout` (wall clock) from `idle_timeout` (reset while tokens flow) — the
  latter is the longer-term ideal for streaming LLM calls.
- **Test-defect classification is a recognized failure class, and classifiers must
  stay advisory at the human boundary.** "A test that fails consistently on a
  specific branch is not flaky — it is broken" (FlakyGuard); self-healing systems'
  critical layer is classifying implementation-drift vs genuine regression
  (Autonoma); and "never let an AutoClassifier silently quarantine a genuine bug …
  route real-regression labels straight to a human" (qaskills 2026 guide). Google's
  internal data: most retried-failure volume is test-side, which is why CI systems
  isolate (quarantine) rather than silently pass or silently delete.

## Fixes

### J1 — configurable, longer judge timeout

`JUDGE_TIMEOUT_MS` (const, `src/stages/judge.ts`) becomes a lazy
`judgeTimeoutMs()` honoring `SUPER_DEV_JUDGE_TIMEOUT_MS` (same pattern as
`maxCallsPerRun`), default raised `120_000 → 240_000`. Rationale: the cap's stated
purpose ("diagnosis must be fast, never block a loop") is preserved — 4 minutes is
still bounded — while the observed heavy-tailed judge latency (~71s typical,
>120s tail) fits inside the wall with ~3.4× headroom over typical and still 40% of
the 600s SDK industry default. Temporal's Schedule-to-Close analog (bound total
duration, not per-attempt) is honored by the existing per-run budget.

Evaluated and deferred: LangGraph-style `idle_timeout` (reset while tokens stream)
is the better long-term shape but lives in the shared session-agent timeout
machinery used by every agent; out of scope for this fix (the existing soft-deadline
wrap-up at 80% already provides graceful drain).

### J2 — retry-once-on-timeout within the existing per-signature budget

In `runJudgeInner`, when an attempt fails as a timeout and a per-signature slot
remains (`used + 1 < MAX_CALLS_PER_SIGNATURE`) and the run budget allows it, retry
the agent call once immediately, consuming the second signature slot
(Temporal-faithful: a timed-out attempt counts toward `MaximumAttempts`; the budget
is attempts, not verdicts). Timeout classification uses one shared
`isTimeoutMessage` predicate (unanchored `timed out after|timeout after`) applied
to BOTH failure surfaces: resolved `{error}` results (session backend; pi-spawn
partial output) and THROWN errors (pi-spawn's no-assistant-text timeout rejects
with `agent timed out after Ns` — review F-1, both reviewers), which the attempt
wrapper absorbs into one shape before the retry decision. The timed-out attempt is
audited (`{error, attempt: 1, retried: true}`) BEFORE the retry issues so every
agent call is durably logged (INV-5, review F-2). Log
`judge <scope>: timeout on attempt 1 — retrying (attempt 2/<max>)`. A second
timeout (or a non-timeout infra error such as a spawn/binary failure —
deterministic, "non-retryable" per Temporal guidance) degrades as today, with the
attempt count recorded in the audit line.

Evaluated and rejected: **refund-on-timeout** (decrement the signature counter) —
unfaithful to every reference system (attempts count, refunds don't exist), and it
would let one signature drive up to 4 agent calls (2 timeouts × refund + 2 verdicts),
doubling cost with no evidence the second full pair helps. Evaluated and skipped:
inter-attempt backoff (SDK default 0.5s+jitter) — the first call is hard-aborted
before the retry issues (no duplicate in-flight request, the tail-at-scale hazard),
and 0.5s against a 240s attempt is noise.

### J3 — deterministic test-suspect advisory at the no-progress terminal boundary

When the GREEN-loop no-progress path reaches its terminal stop (headless, dismissed,
or judge-degraded) and the failure evidence contains `tdd-targets-still-red` (the
phase's RED targets never went green across the repeated attempts while the
implementer actively changed code — the consistent-failure test-defect signature),
the stop log line, the escalation `message`, and the escalation `findings` gain an
explicit advisory: the RED itself may be unsatisfiable; legal next actions are
re-author the RED with this failure evidence, fix the environment, or accept the
limitation. The wording claims only what the identical-signature condition
proves ("never went green across repeated no-progress attempts"), not that the
implementer changed code (review F-2/F-3 — an empty-footprint stall would make
"while the implementation changed" an unverified inference). Deterministic floor
only — it never auto-triggers a re-author
("never let an AutoClassifier silently quarantine a genuine bug"); it makes the
stop honest about the most likely cause so the human decision (or a
resume-with-guidance note) is informed. When the implementer already reported
structured `testDefects`, the existing UNSATISFIABLE text leads and the message
suffix is suppressed (the findings entry still records the deterministic signal).

## Non-goals

- No change to judge prompt, routes, or evidence verification (F4 semantics intact).
- No automatic re-author on still-red signatures without a judge verdict — the judge
  remains the actuator for that judgment; J1+J2 make it reliably present.
- No RED-review change (the born-broken CJK sort literal passed strength review;
  collation math in review is out of scope) and no idle-timeout rework.
- The one-line track-07 test fix (`.sort()` collation literal) lives in the
  pi-omisis worktree, not this repo.

## Verification

- RED-first: fix-specific tests were run against pre-fix code and failed for the
  fix-specific reason (J1 default/env override absent → 120000 observed; J2 no
  retry, single call on timeout; J3 no advisory marker), while negative controls
  (verdict-producing calls consume exactly one slot; non-timeout infra errors never
  retry; still-red-absent stops carry no advisory) pass on both trees.
- `npx tsc --noEmit` clean; full `npx vitest run` green; version bumped to 0.2.4
  across `src/version.ts`, `package.json`, `package-lock.json`,
  `tests/version.test.ts`, with `docs/ARCHITECTURE.md` regenerated and a CHANGELOG
  Unreleased bullet.

## Review outcome (dual systematic review, 2026-08-19)

Both reviewers returned **Approved with Comments** (code-reviewer: 1 low + 3 info;
adversarial: 1 medium + 1 low + 3 info), independently reproducing the RED-first
claims and the full green suite. Remediations applied before commit:

- **F-1 (both, convergent)**: pi-spawn's no-output timeout REJECTS (`agent timed
  out after Ns`) rather than resolving with `{error}` — the original
  `startsWith("timed out after")` predicate missed it. Fixed with the shared
  `isTimeoutMessage` predicate applied to resolved errors AND thrown errors (the
  attempt wrapper absorbs throws), pinned by thrown-timeout retry and
  thrown-non-timeout no-retry tests (both fix-specific RED-verified).
- **F-2 (code) / F-3 (adv)**: retry-then-success under-reported in `.judge.jsonl`
  (two agent calls, one audit line). Fixed by auditing the timed-out attempt
  before the retry issues; the thrown-attempt degrade also carries `attempts`.
- **J3 wording (both)**: "while the implementation changed" was an unverified
  inference in the empty-footprint edge; softened to "across repeated no-progress
  attempts".
- **F-4 (code) / F-5 (adv, info)**: stale `0.1.46` test title parameterized to
  `SUPER_DEV_EXTENSION_VERSION`; **F-4 (adv)**: the version-bump script had
  re-escaped the package.json em-dash — literal restored.
