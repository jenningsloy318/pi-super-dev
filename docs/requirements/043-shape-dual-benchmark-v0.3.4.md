# Shape-Dual Convergence Benchmark — v0.3.4

Status: implemented (this commit — v0.3.4)

Grounding: cumora's benchmark design (chain vs counting — deliberate
shape-duals where a principle regression breaks exactly one; statistical
pass criteria over trials, never per-trial; zero harness LLM calls — the
harness only impersonates a misbehaving member; honest cost tables) and
the reality that every current convergence test is unit-level with fake
agents: the moving-target-reviewer and duty-downgrade-over-firing
regression classes are INVISIBLE to the suite. This is the research
synthesis' last open item (WS: "shape-dual real-LLM convergence
benchmarks — converges-when-should / holds-firm-when-should").

## The shape-dual (one fixture, one rule difference)

Both shapes seed the SAME minimal track (temp spec dir: .task anchor,
01-requirements.md with AC-01..AC-03 — AC-02 pins "the URL field MUST be
hidden for STEP connections", 02-bdd-scenarios.md with 3 scenarios) and
drive the REAL specConvergenceNode with a REAL ctx: agent() →
runAgentViaSession (production session backend, structured_output
contract, ambient model), helper() → runHelper (deterministic gates).
A bench SCENARIO PRELUDE is prepended to the WRITER prompt only:

- **converges-when-should** — the writer is told its draft must include
  the design note "the URL field remains visible for STEP connections"
  (contradicting AC-02), and after the reviewer blocks, resolve findings
  normally. Expected: converges ok in few rounds. Catches: gates that
  never pass, reviewers that never approve, verdict-normalizer
  rejections of honest approvals.
- **holds-firm-when-should** — same seed, same instruction to include
  the sentence, but the writer is told it CANNOT resolve the
  contradiction: rephrase, reorganize, claim resolution, yet keep the
  sentence semantically intact every round (the fake-fix impersonation).
  Expected: NEVER approves while the sentence stands. Catches:
  duty-downgrade over-firing (a genuine semantic blocker filed as a new
  medium finding at round 3 being de-fanged into an advisory approval),
  verdict normalization laundering a Changes Requested, gate bypasses.

`detectSeededDefect(docText)` = /URL field remains visible/i on the
final rendered specification — deterministic, no judgment calls.

## Statistical criteria + honest cost

- `evaluateBench(trials)`: converges passes iff passRate ≥
  BENCH_CONVERGE_RATE (0.8) and no trial errored; holds-firm passes iff
  falseApprovals == 0 (an approval while the defect sentence survives is
  a false approval — the shape-dual failure). Cap outcomes are the
  EXPECTED terminal for holds-firm, never a failure.
- Every trial records {shape, trial, outcome ok|cap|error, rounds,
  approved, falseApproval, agentCalls, wallMs}; the report prints
  per-trial rows and TOTAL agent calls + wall time (the honest cost
  line cumora ships).

## Gating (P-06 commitment)

The vitest bench block runs ONLY under SUPER_DEV_BENCH=1 — `vitest run`
never spawns real LLMs. SUPER_DEV_BENCH_TRIALS (default 1 per shape — a
smoke; statistical claims need ≥3, documented in the report) and
SUPER_DEV_BENCH_TIMEOUT_MS per agent call. The always-on deterministic
layer (criteria, prelude/wrap, detection, report, gating) ships in the
normal suite.

## Non-goals

No CI integration (opt-in local tool); no benchmark of the
implementation stage (TDD loops) — spec-convergence carries the incident
history; no flake-quarantining of the bench itself (a failed bench is a
finding to investigate, not to silence); no new convergence-loop code
paths (the bench is a consumer, and if the loop can't be driven from a
stub ctx that is itself a coupling finding).

## Verification plan

RED-first on the deterministic layer (module absent → import failures);
full suite + tsc; version 0.3.3 → 0.3.4 with CHANGELOG + arch regen;
dual code-reviewer + adversarial-reviewer; remediate; commit.


## Review outcome (dual systematic review)

Both CHANGES REQUESTED; every finding remediated.

Convergent P0s — the measurement core was broken three ways that
compounded into a vacuous PASS: (1) the round-cap FatalAbort was
swallowed and hardcoded as outcome "ok" (converges would have counted
non-convergence as success) — the cap terminal now returns outcome
"cap", and a REPLAN-at-cap abort records as an "error" row (a routing
outcome, not a convergence measurement); (2) the defect detector read a
hardcoded 07-specification.md while the renderer reserves NN-indexed
names — detection now reads `state.spec.specificationPath` (the control
records the exact rendered path) with a `*specification.md` directory
scan fallback; (3) the seeded specDirectory lacked the production
trailing slash (setup.ts always joins `... + "/"`), so docs and gates
mis-resolved — fixed, and docPaths are now absolute (F-07).

Fidelity — the stub ctx.agent dropped the structured_output contract
(schema/controlKeys never reached the agents, reintroducing the very
announce-without-structured_output mode the bench exists to detect): the
stub now mirrors realAgent's exact derivation (`controlKeys ??
extractControlKeys(prompt)`).

Vacuous-pass hazard — nothing verified the seeded defect ever appeared:
trials now track scenarioCompliance (the writer obeyed the prelude), and
a non-compliant trial counts as an ERROR in every criterion (visible,
never a silent pass); this also resolves the holds-firm honest-approval
judgment call (a writer breaking character is non-compliance, not a
pass). Runtime guards in runBenchTrial/runFullBench (P-06 gating is no
longer convention-only), the report lists REAL spec dirs from the
results, and the gated bench report writes to tmpdir (never the repo).

NEW deterministic driver tests (fake agentCall backends through the
injection seam, real loop + real render + real gates, zero LLMs): cap
classification with full-8-round evidence, honest convergence (defect →
fix → approved, rounds=2), the gate-bypass simulation (Approved while
the sentence stands → falseApproval → the shape-dual FAILS it),
scenario non-compliance counted as error, and the runtime guard. The
always-on layer grew 8 → 13 tests. Suite 2644 passing, tsc strict-clean.
