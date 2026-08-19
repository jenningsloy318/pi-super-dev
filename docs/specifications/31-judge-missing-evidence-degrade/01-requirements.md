# Requirements — Judge missing-evidence degrade for diagnosis-driven recovery routes

Status: analysis & plan
Type: fix
UI scope: arch (judge routing logic; no UI)
Source of failure: run `~/.super-dev/runs/2026-08-19T02-01-12-840Z/run.log`
Affected file: `src/stages/judge.ts` (evidence-verification / route-actuation gate)
Current version: `0.2.4` → target `0.2.5`

---

## 1. Executive summary

Run `2026-08-19T02-01-12-840Z` failed `PARTIAL — 0/7 phases`, dead-stopped in
Phase 1 RED generation with `terminalStopReason = "no-progress"`.

The RED tests were valid (compiled, ran, failed for the intended reason, scenario
coverage passed) but the RED *strength* review kept returning NOT STRONG. After the
retry ceiling, the diagnostic **judge** escape valve fired at wiring point
`stage9.red-no-progress.phase-01` (routes offered: `re-author-tests`,
`fix-environment`). The judge diagnosed correctly — a test-quality defect, not an
environment/unsatisfiability problem — and chose `re-author-tests`.

But the verdict was **DISCARDED**:

```
judge stage9.red-no-progress.phase-01: verdict DISCARDED — evidence verification
failed: route "re-author-tests" requires at least 1 evidence item
```

The judge attached **zero evidence items**. `verifyJudgeEvidence` requires ≥1 for
any non-`continue` route, so the sound diagnosis was thrown away → fell through to
terminal no-progress → HITL escalation (unavailable in a headless run) → the whole
run died at 0/7.

v0.2.4 fixed a *different* judge failure (timeouts + a test-suspect advisory) from a
different run and did **not** touch this discard path.

## 2. Root cause

The missing-evidence *degrade* is gated to `escalate-now` only (F4/RC4). For the
RED no-progress recovery routes `re-author-tests` and `fix-environment`, a
missing-evidence verdict still hard-discards. Because these are the only non-HITL
exits from the RED strength livelock, discarding leaves the run with no viable
recovery and it fails at 0/7.

The design principle already established for `escalate-now` applies equally here:
**the diagnosis is the actionable product**; evidence quotes exist to guard against
*fabrication*, not to make a sound diagnosis load-bearing. `re-author-tests` and
`fix-environment` never acquit a gate (INV-1 — the harness re-runs deterministic
authoring/environment work) and are bounded by the per-signature judge budget
(INV-3). So a *missing*-evidence verdict on these routes is safe to actuate.

## 3. Acceptance criteria

- AC-1: A `re-author-tests` verdict with an EMPTY evidence array ROUTES (status
  `routed`, route preserved) instead of discarding, so the RED loop restarts with
  the diagnosis.
- AC-2: A `fix-environment` verdict with an EMPTY evidence array ROUTES likewise.
- AC-3: A `re-author-tests`/`fix-environment` verdict with a FABRICATED quote
  (quote not present in file/outputs) STILL DISCARDS — the fabrication guard is
  unchanged.
- AC-4: A `re-author-tests`/`fix-environment` verdict with MALFORMED evidence
  (all items empty/whitespace) STILL DISCARDS (B4 class preserved).
- AC-5: `challenge-test` with empty evidence STILL DISCARDS (it can remove an
  already-accepted RED gate — conservative; not exempt).
- AC-6: A missing-evidence exempt route below the confidence floor STILL escalates
  (the confidence gate is applied after the evidence gate, unchanged).
- AC-7: The exemption is recorded EXPLICITLY in `.judge.jsonl` (a routed entry
  with a documented INV-2 exemption reason) — never silent.
- AC-8: `escalate-now` missing-evidence degrade (F4) and all existing judge tests
  remain green.

## 4. Non-functional

- NFR-1: No new deadlock source; the change only widens a proven degrade class.
- NFR-2: Minimal surface — one gate branch in `runJudgeInner`; no prompt/route-set
  changes.
- NFR-3: Version bump v0.2.4 → v0.2.5 across `src/version.ts`, `package.json`,
  `package-lock.json` in the same commit (AGENTS.md).

## 5. Open questions

- None blocking. `challenge-test` is intentionally left non-exempt because it can
  drop an accepted RED gate; only the two bounded re-run routes are widened.
