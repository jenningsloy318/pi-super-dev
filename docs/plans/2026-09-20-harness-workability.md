# Harness workability — diagnosis and improvement plan (2026-09-20)

Trigger: "we didn't make this extension workable" — a full-review session over the code,
all 141 `~/.super-dev/runs` logs, ARCHITECTURE.md, the upstream contract surface
(pi 0.86.0 × pi-subagents 0.70.0), and external harness best-practices research.

## 1. What the run corpus actually shows

141 runs (2026-08-21 → 2026-09-20). **Not one run reached `success`.** The terminal
failures cluster into five classes:

| Class | Runs (examples) | Status |
|---|---|---|
| Host-SDK module resolution (pi 0.86 × pi-subagents ≤0.70) | 2026-09-20T06-09 | **OPEN — today's blocker, fixed this session** |
| Agent-budget exhaustion (`budget exhausted before stage start`) | 09-09, 09-14, 09-19 | OPEN — design gap (Fix B) |
| Model-exclusion cache poisoning (quota 429 → 24h exclusion) | 09-08 ×3, 09-13 ×2, 09-14 ×3 | Mitigated engine-side (v0.3.82+, `assessQuotaReset`) + local TTL config; upstream ask open |
| Extension-provided models unresolvable in foreground children | 09-11 → 09-13 chain | Root-caused 2026-09-13; local remedy (npm:pi-antigravity) applied |
| User aborts / parent signal / `pi-subagents not active` mid-upgrade | assorted | Transient/ops |

Environment facts established this session:

- pi-subagents **0.70.0 installed 2026-09-20 11:29 +08** (from 0.67.0); pi is **0.86.0**.
- 0.70.0 `child-session.ts:133` lazily `import("@earendil-works/pi-coding-agent")`.
  pi 0.86 no longer serves virtual module resolution to extension code, and the
  agent npm tree (`~/.pi/agent/npm/node_modules/@earendil-works/`) does not contain
  the package (pi lives under the mise node tree, not an ancestor for Node
  resolution) → **every delegated child dies in ~0.3s with
  `Cannot find package '@earendil-works/pi-coding-agent' imported from …/pi-subagents/src/runs/shared/child-session.js`**.
- Fixed upstream 2026-09-19 by unreleased #2352 (`loadHostPiCodingAgent` — resolves
  the host package root and imports by file URL); no npm release contains it yet
  (v0.70.0 is latest).
- **Local remedy applied (this session, verified by probe)**:
  `ln -sfn ~/.local/share/mise/installs/node/24.15.0/lib/node_modules/@earendil-works/pi-coding-agent ~/.pi/agent/npm/node_modules/@earendil-works/pi-coding-agent`
  — the documented workaround pattern from the 2026-09-05 pi-server gap. Failed ESM
  imports are not cached, so live sessions recover on the next delegated call.

## 2. Why the harness burned a full retry ladder against a 0.3s deterministic failure

Run 2026-09-20T06-09: the RED loop retried 4 tries, armed research-assist, and
dispatched judge calls — every one dying instantly — before the oscillation
detector stopped it. Escape class: the infra-failure grammar in
`DELEGATION_RUNTIME_EXTENSION_FAILURE_RE` (delegation-backend.ts:188) enumerates the
CJS wording (`Cannot find module '…pi-subagents…'`) but not the **ESM** wording
(`Cannot find package '…' imported from …/pi-subagents/…`), so neither the sticky
whole-backend degrade nor any `isNonRetryableAgentError` consumer (gate round-1
abort, spec/artifact-convergence FatalAbort) fired, and the RED loop has no
non-retryable check at its fail-closed seam at all.

## 3. External best-practices grounding (research digest)

The repo already implements the industry core: deterministic oracles decide
everything (SWE-bench methodology; Anthropic "show evidence"), append-only event
ledger + replay resume (OpenHands/Temporal), bounded loops with signature history
(P8), retryable/non-retryable classification, judge ≠ generator, HITL escalation
budgets. The two gaps the corpus exposes map directly onto reported practice:

1. *"Classify failures retryable vs non-retryable BEFORE any retry; short-circuit
   non-retryable classes"* (n8n/Temporal `non_retryable_error_types`) → Fix A.
2. *"Every limit gets a defined terminal state with salvage semantics — a cost
   ceiling ends in `exit_cost` with the diff submitted, never an exception pile"*
   (mini-swe-agent autosubmit; cf. our own wall-fuse `partial (wall-fuse)`) → Fix B.

Full research report with primary-source URLs lives in the session transcript;
key references: SWE-agent ACI docs (arXiv:2405.15793), OpenHands SDK paper
(arXiv:2511.03690), mini-swe-agent (65% @ SWE-bench Verified in ~100 lines),
Anthropic Claude Code best practices + "writing tools for agents", Manus context
engineering (KV-cache 10x, keep-failures-in-context), DEI ensemble/judge paper
(arXiv:2408.07060).

## 4. Fixes (this session)

### Fix A — host-SDK/module-resolution infra class (class-level, P0)

1. `delegation-backend.ts`: extend the infra-failure predicate with the ESM form
   `Cannot find package '<pkg>' imported from <…pi-subagents…>` (importer must name
   pi-subagents so unrelated package errors stay non-sticky). The sticky degrade
   now carries a REASON message, so the new class fails fast with ITS remedy
   instead of the (wrong-for-this-class) version-skew restart text.
2. `agent-errors.ts`: the same envelope joins `NON_RETRYABLE_AGENT_RE`, and
   `nonRetryableAgentSummary` grows the remedy branch: upgrade pi-subagents once a
   release with upstream #2352 ships, or symlink the missing package into the
   agent npm tree (command computed from the live pi process's own package root
   when discoverable), then re-run. Every existing consumer (gate round-1 abort,
   spec/artifact-convergence FatalAbort) inherits the class.
3. `red-oracle-cycle.ts` R1 fail-closed seam: a non-retryable `tddError` now throws
   `FatalAbort(nonRetryableAgentSummary(...))` — the RED loop stops dispatching
   agents that provably cannot start (today: 4 tries + judge + research-arm).
4. Tests: predicate table (today's exact envelope; negative: non-pi-subagents
   importer), sticky-reason plumbing, non-retryable classification + remedy text,
   RED-loop FatalAbort.

### Fix B — agent-budget terminal state (design gap, P1)

Mirror the wall-fuse pattern (v0.3.85 F3) for the spawn budget: when
`ctx.budget.check()` first fails at stage start, stamp a first-trip-wins
`__agentBudget` marker on state; `deriveRunStatus` maps it to the terminal state
`partial (agent-budget)` with the fresh-budget resume note — resumable BY DESIGN,
deliberately distinct from a bug-class failure, exactly like `partial (wall-fuse)`.
A fully-converged run still reads success. Tests: first-trip-wins, terminal-state
derivation, success precedence.

### Fix C — docs/watch

- `docs/upstream-watch.md`: drift-log entry for 0.67→0.70 + pi 0.86 (the
  resolution gap, unreleased #2352, the symlink remedy, `remove automatic model
  fallback` #2270 touching the exclusion envelope docs); version pins updated.
- `README.md` requirements: the pi-subagents ≤0.70 × pi ≥0.86 incompatibility +
  remedy.

## 5. Deferred backlog (ranked, not this session)

1. **End-to-end green run** — the corpus has zero completed runs; after Fixes A/B
   the next spec run should be driven to `success` and its residuals fixed.
2. Budget headroom telemetry — surface projected agent-call demand per remaining
   stage at resume time (research: defined terminal states want defined budgets).
3. Judge position-swap/self-preference mitigations if judge misrouting recurs.
4. Oracle self-audit (OpenAI's SWE-bench-Verified retirement lesson): periodically
   verify the deterministic gates themselves against a known-good spec.
5. Upstream asks already filed in upstream-watch.md (exclusion TTL cap, activation-
   safe tool enumeration, foreground-child provider inheritance).
