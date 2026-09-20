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

## 6. First-pass quality — diagnosis from live run 2026-09-20T07-37-57-688Z

The run converged requirements in 2 rounds, then BDD review found 2 blocking
defects BOTH owned by requirements (BDD26-F01: the spec's mandated edits provably
trip tests/prosperity-contract.test.ts:2798 — the same collision that killed 4
prior implementation attempts; and AC-20/SCENARIO-081 asserting a nonexistent
fallback mechanism), auto-routing bdd→requirements (correct per D1 — the BDD must
not mint backing ACs) and dropping 177 resume rows. The route-back itself is the
system working; the CHURN is in how expensive each discovery+repair cycle is.
Four measured inefficiencies, with fixes:

- **E1 — prior findings injected but never checked as addressed.** Round-1
  requirements got 36 prior blocking findings; the writer addressed most, the
  round-2 review approved — yet the prosperity-guard finding (present in the
  pool as CF-implementation-1nl0mhr) resurfaced only at BDD review, ~80 min and
  3 agent calls later. Fix: writer control gains a per-finding resolution map
  (findingId → artifact loci); a DETERMINISTIC post-write check bounces the
  writer (one bounded pass, no reviewer burn) when an injected blocking finding
  is unaddressed. Seam: prompts.ts controlKeys + artifact-convergence/node.ts.
- **E2 — deterministic validators run advisory-only AFTER the writer.** The
  unknown-pinId and Gate-W lines (16:38:44) are deterministic and cheap but did
  not bounce the writer; the same defects then cost a full 16.6-min reviewer
  pass. Fix: promote designated validator classes (unknown pinId citation,
  own-artifact write-claim contradiction) to a pre-review bounce gate with one
  bounded fix pass (P4: mechanical enforcement instead of advisory). The
  validators already exist — this is wiring, not new code.
- **E3 — full-artifact regeneration for surgical fixes.** The route-back
  carried two precisely-worded amendments but re-ran the whole requirements
  writer (36→24-finding injection) + full review (~25 min). Fix: patch-mode
  writer prompt on route-back — the exact finding recommendations + "changes
  limited to implicated content; everything previously approved preserved
  byte-faithfully" + diff-size expectation in the control block.
- **E4 — reviewer premise-grounding asymmetry.** Requirements review round 2
  verified enumerations but APPROVED AC-20's factually-wrong mechanism premise
  ("falls through the dim:-miss researcher fallback" — the dispatch actually
  fails loud, runtime-dispatch.ts:84,89-117); the BDD reviewer caught it by
  grounding the premise in code. Fix: requirements-reviewer prompt gains the
  explicit rule: every behavioral-premise claim ("preserves X"/"falls through
  Y"/"today's behavior is Z") must be grounded at the named locus before
  approval — enumerations alone do not suffice. (Advisory; E1/E2 are the
  mechanical backstops.)

Order: E2 (cheapest, pure wiring) → E1 (highest value) → E3 → E4.

## 7. Wave-1 increment B — execution plan (anchors established 2026-09-20, v0.4.59 landed the core)

Goal: wire the finding-resolution bounce into the live convergence loop.
Consumes `src/convergence-economy/finding-resolution-gate.ts` (v0.4.59).

1. **Capture the round-1 injected id set** — `src/stages/artifact-convergence/node.ts:214-236`
   builds `round1Lines` from `priorFindingsForInjection` + replan findings and
   logs "N prior-run blocking finding(s) injected at round 1". Capture the
   finding IDS into a round-scoped `injectedBlockingIds: string[]` at the same
   site (both sources carry ids; check their shapes in convergence-ledger.ts
   `priorFindingsForInjection` + the replan rows).
2. **Add the control contract** — `src/prompts.ts:267` (requirements writer),
   `:283` (BDD writer), and the spec/docs writer contracts nearby: append
   `- findingResolutions (optional UNLESS prior findings were injected): array
   of { id: the finding id, loci: string[] (artifact anchors), note: a short
   quote of the finding's remedy language }` + add to the
   "Output <control> JSON with:" line as `findingResolutions?`. Nullable/union
   per 066 grill-4 Q2. Update the stage control schemas (render/schemas.ts)
   and the controlKeys lists where the writers' keys are declared.
3. **Wire the gate** — in the node, right AFTER the writer-agent-error guard
   (`consecutiveWriterAgentErrors = 0;`, ~node.ts:292) and BEFORE validation:
   read the writer control (find where the writer stage result exposes it —
   check stages/writers.ts for the control-bearing result shape), run
   `adjudicateFindingResolutionGate({ injectedIds, resolutions, inheritedGreen? })`;
   on `bounce` and a per-round bounce counter < 1: log the feedback line
   (telemetry: "finding-resolution bounce: N missing ids" — the OTel-isolated
   event naming), re-run `stageTask.run` ONCE with the feedback appended via
   `setArtifactFeedback` (the existing retry-feedback channel — the bounce
   consumes agent budget via the normal dispatch, NOT a convergence round;
   do NOT increment `round`). Second failure path: proceed to validation with
   the missing ids recorded (P10 honest, no second bounce — P8 bound = 1).
4. **Fail-open**: wrap the gate call in try/catch — a gate crash logs
   advisory and proceeds (P5).
5. **Tests**: extend tests/artifact-convergence.test.ts — (a) missing-id →
   one re-dispatch with the feedback, then proceeds; (b) all-mapped → no
   extra dispatch; (c) kill-switch → never re-dispatches; (d) gate crash →
   proceeds; (e) bounce does not consume a convergence round (round counter
   unchanged). Prompt-contract tests pin the new controlKeys (P6).
6. Version v0.4.60; dual gates; suite green.

WS2 (validator bounce) rides the SAME seam one increment later: the
"BDD contract-validator (advisory)" / "Gate-W (advisory)" emitters already
run post-writer — find their emission site (grep `contract-validator
(advisory)` in src/) and route designated classes through the same
one-bounce channel instead of advisory-only.

## 8. WS2 execution plan (anchors established 2026-09-20 22:45; v0.4.61 landed WS1 fully)

Goal: designated deterministic validator classes bounce the writer ONCE
pre-review instead of advisory-only. Receipts: BDD round 1 (16.6-min review
after ~40 advisory unknown-pinId/contradiction findings at 16:38:44), design
round 1 ($1.54 / 17.3 min / 9 contract-claims at 18:20:36).

1. **Emission sites** (all already compute `{blocking, advisory}` via
   `splitContractFindings`): `src/stages/artifact-convergence/validators.ts:100`
   (requirements intent), `:126-128` (BDD pinOwnership + Gate-W),
   `src/stages/artifact-convergence/nodes.ts:61-90` (design contract-validator
   + Gate-W), `src/stages/spec-convergence.ts:186` (spec).
2. **Designated classes** (066 WS2 — the mechanically-checkable, writer-fixable
   set): `/cites unknown pinId/` and `/contradicts a pin in .* OWN artifact/`
   and `/carries a foreign pin/` — regex on the advisory message. Everything
   else stays advisory.
3. **Wiring — reuse the WS1 bounce channel**: the node's WS1 gate block
   (artifact-convergence/node.ts, after `consecutiveWriterAgentErrors = 0`)
   gains a second leg: collect the designated advisories by calling the SAME
   finder functions the validators call (or better: have the validators
   return them via a side-channel — extend `ArtifactValidator` results with
   `bounceErrors?: string[]`), and if non-empty and the per-walk bounce budget
   (shared with WS1, bound 1) is unspent → ONE re-dispatch with the violation
   list via setArtifactFeedback (agent budget, not a round). Second pass:
   proceed with violations attached (P10 log).
   P5: finder crash → advisory-only. Kill-switch:
   `SUPER_DEV_NO_VALIDATOR_BOUNCE` (lazy read, mirror the WS1 pattern).
4. **Tests**: extend tests/artifact-convergence-finding-resolution.test.ts —
   plant a control citing an unknown pinId (the BDD harness at
   tests/artifact-convergence.test.ts:80 `bddControl` shows the pinOwnership
   shape; point one at `pin-does-not-exist`) → exactly 2 writer dispatches;
   mapped/no-violation → 1; kill-switch → 1 with the violation logged.
5. Version bump, dual gates, suite green.

Note: making the classes BLOCKING validation errors instead (the cheaper
wiring) consumes convergence rounds — measured cost today — the WS2 design
explicitly wants the no-round bounce; do not take the shortcut.
