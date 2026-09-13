# LLM Judge Routing Layer — Deterministic Loops with a Diagnostic Escape Valve

Status: PROPOSAL — awaiting user approval. No source changes yet.

Version baseline: 0.1.66 (post B-6 / R-1 / R-2 / R-4 / R-5).

## 0. Problem — why deterministic loops deadlock

Every deadlock this repository has shipped shares one structure:

```
failure ∉ { enumerated classes }  →  status = unknown / identical signature
                                →  retry the SAME doomed action
                                →  live-lock until budget / stagnation / HITL
```

Cases (all verified in production runs):

1. **RED greenfield deadlock** — `classifyRedStatus` did not know module-not-found →
   `unknown` → re-prompt tdd-guide with the same prompt (fixed 0.1.43/0.1.54 by
   enumeration; the *class* of failure remains: any future un-enumerated toolchain
   output repeats the pattern).
2. **v0.1.52 unsatisfiable-RED stagnation** — the failure was not in any enumerated
   class; attempt 2 re-ran a doomed 1200s implementer. The implementer's *own text*
   contained a 9-minute impossibility proof, but no mechanism read it (fixed only
   partially by Fix 3/5: the tail is *displayed* to the human, and Fix 5 detects the
   proof via a **regex over prose** — `/unsatisfiab|contradict/i` — the same fragile
   enumeration disease).
3. **Stage 10 stagnation** — identical findings signature ×2 breaks the loop even
   when the *reason* the fixer cannot converge is diagnosable (e.g. spec-level
   contradiction owned upstream, environment missing a tool, two reviewers
   disagreeing on unverifiable criteria).
4. **v0.1.66 production run 2026-08-14T14-48-07** (Stage 3, NEW class —
   infrastructure/config error treated as retryable): `research-agent` is
   force-routed to the SUBPROCESS backend (bare `pi --no-extensions` + only
   pi-web-access/pi-mcp-adapter). The configured model
   `antigravity/gemini-3.7-flash` is provided by a host-session provider
   extension the subprocess cannot see → `Model "..." not found` exit 1 in
   1.5s, retried identically for all 8 rounds → ROUND CAP FatalAbort. The same
   model worked fine on the session backend in Stages 2B/2C. Two lessons:
   (a) deterministic PERMANENT errors must never enter a retry loop — no
   diagnosis is needed, the stderr is self-describing; (b) backend model
   parity must be validated before work starts, not discovered at round 8.
   Separately, BDD round 1 burned 480s and lost ALL work at hard timeout
   (round 2 redid everything) — the wrap-up/grace mechanism (§1.4) recovers
   exactly this class.

Root cause, first principles: in the `unknown` state the loop has **no second source
of information**. Deterministic code can only *recognize*, not *diagnose*. LLMs can
diagnose un-enumerated categories — but must never be allowed to *acquit*.

## 1. Design — judgment routes, code verifies

### 1.1 The layering

```
Layer 0  deterministic fast path (unchanged): known patterns → instant verdict
Layer 1  LLM judge (NEW): fires ONLY when Layer 0 signals unknown / stagnation /
         repeated no-progress. Fresh-context, read-only, bounded budget.
Layer 2  HITL (unchanged): judge exhausted or route = escalate-now
```

### 1.2 Safety invariants (non-negotiable)

- **INV-1 The judge routes, never acquits.** Gate pass/fail stays 100% deterministic
  (RED oracle, build gate, B-6 baseline, A-2 merge-verify). The judge picks one route
  from a **closed set** compiled in code:

  ```
  type JudgeRoute =
    | "re-author-tests"      // drop acceptedRed, re-run tdd-guide with diagnosis
    | "challenge-test"       // route via the EXISTING testDefects challenge channel
    | "fix-environment"      // bootstrap/toolchain repair, then retry once
    | "continue"             // judged transient; loop retries unchanged
    | "escalate-now";        // straight to HITL with the diagnosis attached
  ```

  The LLM cannot invent a route, cannot mark a gate green, cannot waive a finding.

- **INV-2 Evidence must be machine-verifiable.** Every judge verdict must carry
  `evidence: [{ file, quote }]` (1–5 items). Deterministic post-check:
  - `file` exists under the worktree (reuses the R-5 worktree-only check — process
    cwd is never consulted);
  - `quote` (8–200 chars) byte-occurs in that file OR in the captured oracle/agent
    output tail supplied to the judge.
  A verdict failing verification is discarded → route falls back to `escalate-now`
  (never to a permissive route). This is the direct countermeasure to
  agreeableness bias / fabrication.

- **INV-3 Judge budget is independent and small.** Per failure-signature: at most
  `MAX_JUDGE_CALLS_PER_SIGNATURE = 2` (module const, env-overridable
  `SUPER_DEV_MAX_JUDGE_CALLS`). Global: `MAX_JUDGE_CALLS_PER_RUN = 12`. Judge calls
  never consume the implementer/reviewer attempt budget and vice versa.

- **INV-4 Fresh context, read-only.** The judge agent gets a self-contained prompt
  (oracle output, relevant file tails, attempt history *summaries* — not prior
  conversation), `access: "source-read-only"`, model from STAGE_MODELS with a
  dedicated entry (`judge`) so it can differ from implementer/reviewer models.

- **INV-5 Full audit trail.** Every judge call: prompt hash, control capture, quote
  verification result, chosen route → `run.log` + spec-dir `.judge.jsonl` (same
  convention as `.resume-cache.jsonl`).

### 1.3 Judge control schema

```
controlKeys: diagnosis, route, confidence, evidence
  diagnosis: string (≤ 600 chars) — what category of failure this actually is
  route:     JudgeRoute (closed enum; unknown value → discard → escalate-now)
  confidence: number 0..1 (route taken only if ≥ 0.6, else escalate-now)
  evidence:  array of { file, quote } — verified per INV-2
```

Structured-output + corrective re-prompt already exist (missingControlKeys).
`evidence` is `allowEmptyArraysFor`-exempt ONLY for `route = "continue"`; every
other route requires ≥ 1 verified evidence item.

### 1.4 Wrap-up + grace (adopted from pi-subagents `turnBudget`; applies to ALL agent calls)

pi-subagents' `turnBudget: { maxTurns, graceTurns }` demonstrates the right
shape: at the budget boundary the child is FIRST asked to wrap up and emit its
structured output, and only after `graceTurns` further turns is it interrupted
— partial output is preserved. Our current hard 1200s/480s kills destroy
structured output (`control=no`) and all intermediate work (v0.1.52 impl
attempt 2; this run's BDD round 1).

Design:

- **W-1 soft deadline**: at ~80% of an agent call's timeout, inject a wrap-up
  message into the SAME session/backend channel (the corrective re-prompt
  machinery proves both backends accept mid-session message injection):
  "Deadline approaching. Stop exploration now, finalize your answer, and call
  structured_output with what you have."
- **W-2 grace window**: hard kill only after the remaining 20% elapses with no
  structured output. On subprocess backend this maps to a second stdin/stderr
  pipe write or SIGTERM-first-then-SIGKILL (SIGTERM lets pi flush a final
  message; verify empirically).
- **W-3 partial capture**: whatever `.text` exists at kill time is already
  returned by session-agent today; subprocess backend must match (it currently
  discards on timeout — parity gap).
- Cap: wrap-up injection at most once per agent call; a call that still
  produces nothing after grace fails as today (no budget laundering).

### 1.5 Layer 0.5 — permanent-error fast-fail (NEW, motivated by case §0.4)

Before any judge involvement, deterministic classification at the agent-call
boundary (session-agent.ts + pi-spawn.ts):

- **P-1 permanent stderr classifier**: patterns like
  `Model "..." not found` / `Use --list-models` / provider auth-quota-exceeded
  / `extension not found` classify the failure PERMANENT_INFRA. Permanent
  errors bypass retry/convergence loops entirely: immediate FatalAbort (or
  HITL if interactive) with the verbatim stderr and an actionable hint
  ("model X is not visible to the subprocess backend; either configure a
  subprocess-visible model for research-agent or install the provider
  extension via -e"). Patterns are additive and each carries a remediation
  hint; unknown stderr stays retryable (today's behavior).
- **P-2 startup model-parity check**: during Stage 1 Setup, for every role
  routed to the subprocess backend, resolve its configured model and verify
  visibility to the bare subprocess (`pi --mode json --list-models` once,
  cached per model id). Fail the run at setup with a precise message instead
  of round-8 discovery. Session-backend roles need no check (host session is
  the source of truth).

The judge layer explicitly does NOT handle these: a self-describing permanent
error needs zero diagnosis, and the judge itself might be unspawnable for the
same infra reason (see INV-6).

### 1.6 Judge self-hosting (INV-6)

The judge MUST run on a backend whose model parity is validated: default to
the SESSION backend (host session always has the host's own configured models)
unless P-2 validated a subprocess model. If the judge call itself fails on
infrastructure, degrade silently to today's behavior at that wiring point and
log `judge infra-failed (degraded)` — never let the diagnosis mechanism become
a new deadlock source.

## 2. Wiring points

### 2.1 Stage 9 — Implementation (`src/stages/implementation.ts`)

**J9-a: RED-loop unknown ×2** (anchor: the RED retry loop, `terminalStopReason`
handling near lines 1187–1275). When `redStatus === "unknown"` twice with the same
failure signature: judge input = oracle stdout tail (8 KB), test file contents,
tdd-guide `.text` tail, `git status --porcelain`, directory tree (depth 2).
Routes: `re-author-tests` (with diagnosis appended to retryHint),
`fix-environment`, `escalate-now`. Expected effect: the greenfield-class deadlock
pattern converges in one judge call even for languages/outputs we have not
enumerated.

**J9-b: no-progress pre-escalation diagnosis** (anchor: `repeatedNoProgress`
line 99; escalation message assembly after line 1424+; this SUPERSEDES Fix 5's
`UNSATISFIABLE_TEXT_RE` prose regex — the regex stays as a Layer-0 fast path, the
judge becomes the authoritative classifier). When 2 consecutive implementer
attempts have identical failure+footprint: judge input = implementer `.text` tails
(all attempts — attempt 1's proof is currently never persisted across attempts;
the fix threads them), failing test output, `testFiles`. Routes:
`challenge-test` (routes through the EXISTING `testDefects` challenge edge with
the diagnosis as the reason — evidence-verified), `re-author-tests`,
`continue`, `escalate-now`. The v0.1.52 shape (attempt 1 carries a real
impossibility proof) then auto-routes to re-author in ~1 judge call instead of a
doomed 1200s attempt 2.

**J9-c: challenge re-author quality gate is unchanged** — the judge never bypasses
`MAX_CHALLENGE_REAUTHORS`; it only makes each re-author carry a verified diagnosis.

### 2.2 Stage 10 — Verify review loop (`src/stages/verify.ts`)

**J10-a: stagnation diagnosis** (anchor: `reviewLoopUntil` line 806, the
`if (stagnant)` branch ~line 841). Before setting `__stagnated`, one judge call:
input = the 2 identical rounds' findings (with file/severity/title/status),
fixer diff summary, build gate output, deferred ledger. Routes:
- `challenge-test` — findings reveal the *tests themselves* are contradictory or
  unverifiable (cross-checks R-2's tests-review angle);
- `escalate-now` — default; BUT the `__stagnated` payload gains `diagnosis` +
  `evidence`, which the escalation prompt (Fix 3 formatting) already renders —
  the human sees "why stuck", not just "stuck";
- `continue` (conf < 0.6 path) — one extra fixer round with diagnosis appended to
  `buildFixPrompt` guidance, then hard stagnation.

**J10-b: no-actionable-findings diagnosis** (anchor: the R-1 shortcut branch
~line 828). Same treatment: judge classifies the deferred/needs-human residue —
cross-stage blocker (route `escalate-now` with owner attribution), advisory noise
(`continue` → one more round then exit via existing AwC path), or spec-level
contradiction (`challenge-test`).

**J10-c: convergence-cap pre-abort diagnosis** (anchor: `MAX_CONVERGENCE_ROUNDS`
in artifact-convergence/spec-convergence — Stage 2B/2C, listed here for
completeness since it feeds Stage 10 inputs). At round `MAX-2`, a judge call
whose diagnosis is inlined into the FatalAbort/HITL message. Routes limited to
`escalate-now` / `continue` (writer-level fixes stay with the existing weak-verdict
machinery).

### 2.3 What the judge NEVER touches

Merge verification (A-2), baseline regression verdicts (B-6), sensitive-file scan
(A-3), review verdict merging (R-1 triage buckets), RED acceptance itself,
`reviewApproved` / `buildGreen`. All remain pure code.

## 3. Agent + prompt assets

- `src/agents/judge.md` — role file with R-4-style evidence discipline: cite
  file:line + verbatim quotes; never propose edits; explicitly told it CANNOT
  approve anything, only classify + route; if genuinely uncertain → low confidence.
- `buildJudgePrompt(scope, inputs)` in `src/prompts.ts` with a standard control
  line (covered by `tests/prompt-control-contracts.test.ts` — key set pinned:
  `diagnosis, route, confidence, evidence`).
- `STAGE_MODELS.judge` schema in `src/render/schemas.ts`.
- Router module `src/stages/judge.ts`: `runJudge(ctx, scope, inputs)` — owns the
  budget maps (signature → count), evidence verification, route fallback,
  `.judge.jsonl` append. Stages 9/10 import only this.

## 4. Tests

1. Unit: route closed-set enforcement (bogus route → escalate-now), evidence
   verification (quote byte-match, worktree-only path resolution, 8–200 chars),
   budget exhaustion, `confidence < 0.6` fallback.
2. Stage 9 integration (tests/implementation-red-loop.test.ts pattern): unknown×2
   fires exactly one judge call; judge `re-author-tests` drops acceptedRed and
   re-prompts tdd-guide with diagnosis; judge `challenge-test` threads diagnosis
   into the existing challenge edge; judge exhaust → existing HITL unchanged.
3. Stage 10 integration (tests/stagnation.test.ts pattern): stagnation with judge
   diagnosis lands in `__stagnated.findings` + escalation prompt; J10-b residue
   classification; convergence-cap message carries the diagnosis.
4. Contract: prompt key-set pin; `.judge.jsonl` audit lines.
5. W/P-layer: P-1 classifier unit tests (permanent vs retryable stderr,
   verbatim-stderr propagation, bypass of convergence loop); P-2 parity check
   (subprocess --list-models mocked ok/missing, setup-time fail-fast);
   W-1/W-2 (wrap-up injected at 80%, exactly once; grace then kill; subprocess
   partial-text capture parity); BDD-timeout regression (round 1 wrap-up
   yields usable artifact instead of total loss).
6. Full-suite regression gate + version bump per repo convention.

## 5. Rollout

Single feature branch of work, but landed as four commits:
1. `src/stages/judge.ts` + agent/schema/prompt + unit tests (inert until wired);
2. Layer-0.5 hardening first — P-1 permanent-error fast-fail + P-2 startup
   model-parity check + W wrap-up/grace (all deterministic, zero LLM risk,
   independently valuable; fixes the v0.1.66 run's exact failure class);
3. Stage 9 wiring (J9-a/J9-b) + tests;
4. Stage 10 wiring (J10-a/J10-b/J10-c) + tests.
Kill switch: `SUPER_DEV_DISABLE_JUDGE=1` → all wiring points no-op to today's
behavior (like B-6's escape hatch).

## 6. Cost model

Judge call ≈ one read-only reviewer turn (~30–90s, ~50k tokens) vs. one doomed
implementer attempt (1200s cap, full worktree write access). Pays for itself the
first time any un-enumerated failure class appears; costs nothing on the happy
path (only fires on unknown/stagnation/no-progress).

## 7. Open questions for the user

- OQ1: judge model — reuse `code-reviewer`'s (gemini-3.7-flash, fast) or dedicate
  a stronger model (diagnosis quality is the whole point; recommend the strongest
  configured model, it runs rarely)?
- OQ2: J9-b `continue` route — allow or restrict to escalate-now? (A wrong
  `continue` costs one more implementer attempt; recommend allowing, capped by
  judge budget 2.)
- OQ3: should J10-a `challenge-test` at Stage 10 also write the deferred
  finding into the testDefects channel for audit even when the run is not in
  a RED phase (recommend yes, logging-only)?
- OQ4 (from the v0.1.66 run): for P-1 permanent infra errors, pure fail-fast or
  auto-fallback to a validated available model first (recommend fail-fast —
  silent model substitution changes agent behavior the user configured;
  surface the mismatch at setup instead).
- OQ5: immediate repair for the user's current setup: `antigravity/gemini-3.7-flash`
  is session-provider-only; research-agent needs a subprocess-visible model
  (or the antigravity provider extension added to RESEARCH_EXTENSION_PACKAGES
  if it is loadable standalone). This is a user config decision, not code.
