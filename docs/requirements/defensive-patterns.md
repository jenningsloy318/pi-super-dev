# Defensive Patterns — named rules from postmortems

Status: implemented (this commit; each rule cites its enforcing tests). Each rule names its originating incident (the dsh-06 convention: postmortem → named rules; every rule is explain-or-assert — it either cites why it exists or is backed by a machine check).

These rules are load-bearing for code review in this repository: a change that violates one of them is wrong even when its tests pass.

## The rules

1. **Lazy env reads** — env-derived configuration is read per call, never captured at module import (a top-level `const X = process.env…` cannot be overridden by tests; bit MAX_CHALLENGE_REAUTHORS and MAX_JUDGE_CALLS). Assert: tests overriding env after import pass.
2. **The exit code is vitest's** — full-suite validation captures vitest's own exit code; piping test output through `tail`/`grep` and echoing the pipe's status reports `0` forever (shipped a hidden liveness regression as 585f50da; recurred as a missed embedded-version-string bump in 7dd18363's aftermath).
3. **Version bumps are four-file, string-global** — `src/version.ts`, `package.json`, `package-lock.json` (BOTH root version fields), and `tests/version.test.ts` (including `v<version>` embedded strings) update in the SAME commit; a first-match-only sed leaves stale pins that fail later, not sooner.
4. **Tests that script findings materialize cited files** — a finding whose `file` cites a path absent from the test's worktree is demoted by design (R-5); a test asserting such findings stay actionable must create the files.
5. **Probes over prose** — toolchain behavior claims (exit codes, stderr bytes, flags) are verified by byte-level local probes; documentation-based claims proved unreliable (source_check confidence 0.20 on the same questions).
6. **A verdict pin and a triage defer must never disagree about who can act** — the layer that DECIDES the verdict (pin) and the layer that ROUTES the finding (fixer vs human) must key on the same semantics. The needs-human marker is a WHO classification: it must keep the finding away from the fixer (routing) while never, by itself, pinning "Changes Requested" (verdict) — otherwise the loop demands changes no component is allowed to make (run 2026-08-16T01-00-35; fixed F-A). Assert: `reviewFindingBlocksVerdict` vs `reviewFindingBlocks` contract tests.
7. **Sad-path machinery leaves the happy path byte-identical** — every degrade/fallback (judge, replan-lead, replan trigger, ledger) is additive and no-ops on the paths that existed before it; guarded by the full suite, not by spot checks.

## Plan-doc Status lifecycle (dsh-08 L-2, applied)

Every document under `docs/requirements/` carries a `Status:` line within its first five lines, one of:

- `reference — <one-line nature>` (research/notes; no lifecycle action)
- `proposed` / `approved`
- `implemented (<commit-sha or range>)`
- `rejected (<reason, one line>)`
- `superseded-by (<doc>)`

Moving a doc between states is a real edit with its commit named — `implemented` claims must cite the implementing commit. Enforced by `tests/docs-contracts.test.ts`.

## Where the loops live (index)

Loop termination semantics are defined in `postmortem-0001-verify-loop-dead-state.md` (vocabulary + degradation ladder). The dependency graph and invalidation sets live in `src/graph/edges.ts`. The replan circuit lives in `src/replan/`. The event ledger and its invariants live in `src/runlog.ts`.
