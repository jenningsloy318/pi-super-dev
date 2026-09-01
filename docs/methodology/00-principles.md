# Engineering Principles — the Constitution

Every principle here is grounded in a real defect from this repo's history (415 commits,
20 fix releases in 3 days). These are not aspirations; they are the rules that would have
prevented those defects. Each rule states: the principle, the incident receipts, and the
mechanical check that enforces it.

## P1 — The LLM is an untrusted input source

Every control object, runner command, and structured output an agent emits crosses a
deterministic validation boundary. The core never trusts shape, grammar, or self-reports.

- Receipts: $-masked render errors (v0.3.32), 5 drift-coercion releases (v0.3.33–0.3.39),
  unescaped-quote JSON (v0.3.48), reviewer self-report vacuous passes (v0.3.0).
- Enforcement: schema-validate every control; deterministic oracles decide pass/fail;
  an agent "saying done" is never a gate.

## P2 — Enumerate the input grammar; never sample it

When we accept externally-shaped text (shell commands, JSON controls, git output), the
grammar must be enumerated from the toolchain's documented space up front — not extended
one live failure at a time.

- Receipts: runner-command grammar fixed 4 times (v0.3.38 `cd &&`, v0.3.40 scoping,
  v0.3.41 npm exec, v0.3.50 globs, v0.3.52 package-globs + selectors); control-key
  optionality (v0.3.47); porcelain quoting (v0.3.46).
- Enforcement: before shipping any parser of external text, write the enumeration table
  (every mainstream form per toolchain) and a test per row. A third fix to the same
  grammar is a process failure — stop and enumerate.

## P3 — Concurrency changes require failure-path enumeration

Adding concurrency means enumerating: every promise's rejection path, who awaits it and
when, every shared file's writer set and snapshot/restore interactions, and a bound on
every loop the concurrency can re-enter.

- Receipts: v0.3.43 pipelining produced an unhandledRejection crash (fixed v0.3.51), a
  join-rejection infinite loop (fixed in-release), a snapshot-restore race that wipes
  concurrent implementer writes (observed live 2026-09-01 phase-11), and a reviewer
  misbehavior amplifier (8+ live boundary violations burning GREEN work).
- Enforcement: a concurrency PR ships with a written failure-path table (promise ×
  {reject, abandon, late-resolve} × shared-resource conflicts × loop-bound) and tests
  per cell. No exceptions.

## P4 — A prompt is advisory; enforcement is mechanical

Instructions in prompts reduce frequency, never guarantee compliance. Anything that MUST
hold needs a mechanical mechanism (tool restriction, sandbox, or a design that stays
correct when the instruction is ignored).

- Receipts: intercom detach (v0.3.36 autonomy clause — worked for that agent class),
  RED-reviewer READ-ONLY header (v0.3.51) violated 8+ times live on 2026-09-01,
  costing 3 phases.
- Enforcement: for every "the agent must never X", name the mechanism that makes X
  harmless or impossible when it happens anyway. If the answer is "the prompt says so",
  the design is not done.

## P5 — Fail-closed is for evidence about the work; fail-open is for failures of the judge

When a checker fails, distinguish: (a) evidence that the WORK is bad → fail-closed;
(b) the CHECKER itself failed (timeout, boundary violation, spawn error) → do not punish
the work; degrade the checker to advisory and keep deterministic gates authoritative.

- Receipts: reviewer boundary violations discarded correct GREEN work 4× on phase-05
  alone (2026-09-01); a classifier infra error aborted a run because a non-routable
  owner was treated as a blocker (v0.3.48); delegation infra errors cached as poison
  (v0.3.48).
- Enforcement: every checker-failure branch names which of (a)/(b) it is, with a test
  per branch.

## P6 — Cross-module contracts get cross-checked, not remembered

Any contract spanning >1 file (prompt line ↔ schema ↔ key extractor; call site ↔
function signature) drifts silently. Write dynamic/AST cross-check tests so drift fails
CI, and keep shared values in one scope/constant.

- Receipts: priorFindingResolutions 3-way mismatch (v0.3.47, 22m52s burned);
  post-RED oracle call sites missing the runner param because `runnerSpec` was
  block-scoped out of reach (found 2026-09-01, phases 01/02 burned ~1h).
- Enforcement: invariant tests that derive both sides independently and compare;
  block-scope review rule — a value needed by ≥2 call sites of a loop must be declared
  at their common ancestor scope.

## P7 — Fix the class, not the instance

Every fix must name its escape class (why tests didn't catch it) and add the class-level
defense. A fix that only makes this instance pass is rejected in review.

- Receipts: string-coercion started per-field (v0.3.32), then became schema-driven
  (v0.3.33) — the good pattern. Runner grammar never got the same treatment until
  v0.3.52 — the bad pattern, 4 releases later.
- Enforcement: PR template field "escape class + class-level defense"; reviewer rejects
  instance-only fixes.

## P8 — Every loop and every budget has a proven bound

Any retry/continue path must provably terminate: signature history, hard ceiling, or
budget — with a test that provokes the bound.

- Receipts: join-rejection infinite loop (v0.3.43, found only by a >40min hung suite);
  A→B→A→B livelock evading adjacent-signature comparison (fixed with seen-any history).
- Enforcement: `continue` inside a loop requires a comment naming its bound; a test
  that reaches the bound.

## P9 — Machine-independent, environment-realist tests

Tests must pin the environments that actually exist: real git repos (quotepath, quoting,
renames), real runners (npm exec flag rules, PATH), real TAP/XML output — not idealized
strings.

- Receipts: trim-mangled porcelain paths ('eed.txt'), npm exec swallowing --reporter,
  node CLI flag position after positionals, vitest ENOENT under spawnSync.
- Enforcement: L2 (real toolchain) + L4 (real git) lanes per docs/testing-strategy.md;
  environment assumptions asserted, not presumed.

## P10 — Evidence trails must be honest and located

Errors carry exact locations; logs state what actually ran; unknowns are reported as
unknowns; discarded work names what was discarded. A lying log is worse than no log.

- Receipts: `$: must be array` ×7 masking (v0.3.32), `ran: []` vs claimed files,
  review-weak timeout hints, "still missing control keys" for an unparseable control
  (v0.3.48 split UNPARSEABLE vs absent).
- Enforcement: located-error format tests; gate lines always include `(ran: …)`;
  `unknown` never coerced to a stronger status.
