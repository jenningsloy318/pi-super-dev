# Architecture — the Invariants That Hold the System Together

The pipeline is: untrusted LLM specialists → deterministic validation boundary →
deterministic state machine (gates, oracles, ledgers) → durable artifacts. Everything
below serves that shape.

## A1. Deterministic core, probabilistic edge

LLM calls happen at the edge (specialists). Decisions that gate progress — RED/GREEN,
deliverable existence, coverage, scope, parse/validity — are deterministic code. An LLM
may PROPOSE (runner commands, diagnoses, fixes); the machine VERIFIES by execution or
parsing before the proposal becomes state.

- Never move a gate decision into a prompt ("just ask the agent if tests pass").
- Never let an agent's self-report bypass an oracle. (This is the founding principle of
  v0.3.0 and it must never regress.)

## A2. One authoritative oracle per question

For each question — "are the tests red?", "does the build pass?", "is coverage ≥85%?",
"do deliverables exist?" — there is exactly one authority, and every call site reaches it
through the same complete configuration. The post-RED oracle bug (2026-09-01) was two
call sites of `runRedCheck` with different effective power (one had the cached runner,
one couldn't reach it). Rule: when a helper takes optional capability parameters
(runner, diagnostics, signal), call sites are audited as a set — an AST test asserts
parity, or the capability is threaded through a context object that cannot be partially
applied.

## A3. State machines are explicit and bounded

Every loop (RED tries, attempts, convergence re-entries, join rejections) declares:
its progress signature, its bound (count/history/budget), and its terminal path. The
phase loop's partial-preserve path (`preservePartialPhase`) is the model: bounded
re-entries, same-signature detection, stash-preserved best attempt, honest partial
status.

## A4. Files are single-writer per window

Any file has at most one active writer per pipeline window (phase attempt). Read-only
roles (reviewers) are enforced mechanically where possible; where a read-only role can
still violate (bash), its violation handling must be fail-open (P5) and its snapshot/
restore must never race a concurrent writer (concurrency checklist item 3). When a
role violates read-only twice, it loses concurrency for that scope.

## A5. Tolerant boundary, strict core

Drift repair (coercion) happens at the boundary, is schema-driven (never per-field hand
maps when a schema walk suffices), never rewrites values that already validate (unions
are skipped), and leaves unknown shapes located for retry feedback. The repair chain is
ordered: prune-nulls → string-walk (string/array/boolean slots) → prose-array
normalization. Two mechanisms for one drift direction is a smell — string→array should
be schema-driven like the reverse direction.

## A6. Contracts are declared once and cross-checked

- Control-key contract: prompt line ↔ schema optionality ↔ extractor — one dynamic
  invariant test (v0.3.47 pattern), extended to ALL stages automatically (derive the
  stage list from `STAGE_MODELS`, never hand-maintain it).
- Gate contract: every oracle line logs `(ran: …)`; every status is honest (`unknown`
  never upgraded).
- Evidence contract: controls, diagnostics, and ledgers are append-only; resume replays
  re-extract with the CURRENT parser (v0.3.48 recovery pattern) so parse improvements
  heal poisoned rows.

## A7. Environment realism

Spawn through one helper family (quote-aware splitting, PATH setup, flag-order rules,
timeout tiers). Machine-dependent behavior (quoting, quotepath, PATH, CLI flag
positions) is pinned by real-repo tests. When a runner command is agent-proposed, it is
machine-validated by execution before caching (v0.3.30 Layer C), and its scoping grammar
is enumerated (P2).

## A8. Cost is an architecture constraint

Throughput work (thinking tiers, pipelining, deterministic commits) must not add
correctness debt: each optimization ships with its FMEA (P3) and its kill-switch env
(SUPER_DEV_LLM_COMMITS, SUPER_DEV_NO_COVERAGE_GATE, SUPER_DEV_NO_AUTO_ROUTEBACK are the
precedents). Every new agent call needs: role tier (thinking), timeout tier, and a
reason it cannot be deterministic code.

## A9. Honest partials

The run never lies about incompleteness: failed phases are `partial` with reasons,
best attempts are preserved (stash), the summary names unconverged work (never-zero
principle, v0.3.0). Re-entry skips green work and seeds retries with prior failure
reasons — the convergence iteration is a first-class architecture concept, not a hack.
