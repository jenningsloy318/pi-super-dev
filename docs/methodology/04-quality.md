# How We Guarantee Quality — the Test and Release System

Coverage is a floor, not a strategy (85% lines/80% branches are the hard gate; the
strategy is docs/testing-strategy.md). This file defines what makes a change DONE.

## 1. The definition of done for any fix

1. Reproduced with the engine's own machinery (artifact-level, not narrative).
2. Root cause named with file:line + the escape class (01-analysis.md taxonomy).
3. Class-level fix: the whole enumerated class is handled, not the instance.
4. Regression tests at the layer the escape class demands:
   - Class A (idealized fixtures) → L1 live-corpus fixture from the REAL payload.
   - Class B (grammar) → a row per enumerated grammar form.
   - Class C (concurrency) → failure-path table + per-cell tests (rejection before
     join, abandonment, late resolution, bound provocation).
   - Class D (contracts) → dynamic cross-check test (both sides derived independently).
   - Class E (enforcement) → test proving the failure path is HARMLESS when the
     instruction is ignored.
   - Class F (environment) → real-toolchain/real-git test (L2/L4).
   - Class G (lifecycle) → cross-stage/resume replay test (L3).
5. Full suite green WITH coverage thresholds; tsc clean; version bumped (AGENTS.md
   rules); arch doc regenerated.

## 2. AST/call-site contract tests (cheap, high yield)

Mechanical checks that need no execution:
- Every call site of a capability-taking helper (`redCheckOptions(...)`) passes the
  capability parameters — or is on an explicit allowlist with a comment.
- Every `continue` inside a retry loop has a bound comment in the same block
  (`MAX_*` constant referenced).
- Every `STAGE_MODELS` stage appears in the control-contract invariant test.
These run in vitest like any test (read the source file, assert patterns). They catch
the D-class defects that unit tests structurally cannot.

## 3. Property tests for parsers and coercers

For each tolerant parser/coercer, state properties that must hold for ALL inputs:
- Coercion never changes a value that already validates (unions skipped).
- Repair never makes a parseable input unparseable; well-formed input is byte-identical.
- Extract-then-validate is idempotent (extracting twice equals extracting once).
Use fast-check (or a small hand-rolled generator) over the grammar enumeration table.

## 4. Lanes (per docs/testing-strategy.md, operationalized)

- L0 pure unit — default.
- L1 live-corpus — REAL payloads from `.resume-cache.jsonl` captured BEFORE consumption;
  fixture naming `YYYY-MM-DD-<incident>.<ext>`; every A-class fix starts here.
- L2 real toolchain — actual node/npm/go spawn in temp dirs (npm exec flag rules,
  PATH, flag order).
- L3 cross-stage lifecycle — real temp git repo + multi-attempt flows (coverage gate,
  pipelining, deterministic commit lanes are the model).
- L4 real git — pinned repo-local `core.quotepath=true`, 中文/space/rename paths.
- L5 behavioral doubles — agents that fail/misbehave per the failure-path table, with
  would-hang bounds.
- L7 E2E — opt-in (SUPER_DEV_E2E=1), small real run with a scripted model.

## 5. Review checklist (what a reviewer of a PR must verify)

- Escape class named; class-level defense present (P7).
- New concurrency → failure-path table attached (P3) — reject without it.
- New external-text parsing → enumeration table attached (P2).
- New "agent must never X" → mechanical-harmlessness answer (P4).
- Checker-failure branches classified fail-open vs fail-closed (P5).
- Shared values declared at common-ancestor scope (P6).
- Log lines honest: `(ran: …)`, located errors, discarded-work names (P10).
- Version bump + arch doc + coverage gate (release rules in AGENTS.md).

## 6. Release ritual (unchanged from AGENTS.md, restated for completeness)

Version in src/version.ts + package.json + package-lock.json (both fields) +
tests/version.test.ts; regenerate docs/ARCHITECTURE.md; full suite WITH coverage
counts verified by exact pass/fail numbers (a grep for "Tests" once committed a red
release — verify counts, then commit); push origin; sync the installed checkout
(git pull --ff-only in ~/.pi/agent/git/github.com/jenningsloy318/pi-super-dev).

## 7. Live-run monitoring duty

Engine fixes only reach new processes. After every release during a live run:
note which version the run started on, predict which live defects remain until
stop+resume, and tell the user the expected burn. Never claim a live run is fixed by
a release it cannot see.
