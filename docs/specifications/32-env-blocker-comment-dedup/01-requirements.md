# Requirements — v0.2.7 polish: run-start snapshot comment + judge-override feedback dedup

Status: analysis & plan
Type: fix (polish)
UI scope: arch (implementation-stage fault routing; no UI)
Source: post-merge review of v0.2.6 (`7df7405`)
Affected: `src/stages/implementation.ts`
Current version: `0.2.6` → target `0.2.7`

## 1. Executive summary
Two non-blocking defects found reviewing the v0.2.6 env-blocker fix:

- **D1 (doc):** the comment at `implementation.ts:1153` reads *"capture the phase-start
  dirt snapshot ONCE, before the first tdd/implementer dispatch"* but no capture happens
  there — the real capture is run-start at line 953, and `sd26-CR-1` deliberately moved
  provenance from per-phase to **run-start**. The stale comment contradicts the shipped
  design and misleads future readers.

- **D2 (behavior, cosmetic):** on the judge `implementer-retry` override path,
  `ownDirtFeedback` is appended to `failureReasons` both directly and nested inside
  `envJudgeOverrideFeedback`, so each undeclared-edit line is duplicated in the
  implementer's retry feedback.

## 2. Acceptance criteria
- AC-1: The `implementation.ts:1153` comment accurately describes the run-start
  (not per-phase) snapshot semantics, consistent with line 953 and sd26-CR-1.
- AC-2: On the judge `implementer-retry` override path with a non-empty `ownDirt`,
  each `out-of-scope edit (this run): <path>` line appears EXACTLY ONCE in the
  implementer retry feedback.
- AC-3: The override diagnosis line and the `ownDirt` lines both still reach the
  implementer (no feedback lost).
- AC-4: The product fall-through path (no judge) is unchanged — `ownDirt` lines
  still appear exactly once there (regression guard).
- AC-5: v0.2.6 behavior and all existing tests stay green; version bump 0.2.6→0.2.7.

## 3. Non-functional
- NFR-1: Minimal surface — one comment + one array edit; no logic/route changes.
- NFR-2: Version bump across `src/version.ts`, `package.json`, `package-lock.json`
  (root+node only; do NOT touch nested third-party dep versions), `tests/version.test.ts`,
  regenerated `docs/ARCHITECTURE.md`.
