# How We Design — Design Discipline

Design happens on paper (or in the incident doc) before code. A design is not done when
it works on the happy path; it is done when its failure modes are enumerated and each has
an owner.

## 1. Write the contract first (Design by Contract)

For every new function/module/stage, write — in the file, as doc comments —
preconditions, postconditions, and invariants. Contracts name types, ownership (who may
mutate), failure semantics (throw vs degraded return), and idempotency.

- Every exported function gets a doc comment stating failure semantics. This repo's
  best code (`runRedCheck`, `pruneNulls`, `resolveRunnerCommand`) already does this;
  the defects live where the contract was implicit (`redCheckOptions` runner param,
  join rejection semantics).
- If two functions must agree (caller/callee, producer/consumer), the contract says so
  AND a cross-check test enforces it (P6).

## 2. FMEA — enumerate failure modes BEFORE building

For each new mechanism, list failure modes × effect × detection × prevention:

- What does it do when the agent errors? Times out? Returns garbage? Refuses?
- What does it do when the filesystem/git disagrees with the model's claims?
- What does it do when run twice (retry)? When re-entered (convergence iteration)?
  When resumed in a new process (cache replay)?
- What does it do when two things run at once (if anything is concurrent)?

The v0.3.43 pipelining FMEA would have had rows: "review promise rejects before join"
(unhandledRejection — killed the run), "review keeps rejecting" (loop bound), "reviewer
edits a file the implementer is writing" (restore race), "reviewer disobeys read-only"
(amplifier). All four were live defects within 24h. An hour of FMEA would have listed
all four; the fixes then ship WITH the feature, not as 0.3.44–0.3.53.

## 3. Pre-mortem

Before merging a design: write "it is one week later and this change caused the worst
incident this quarter — what happened?" If you cannot name at least three plausible
stories, you have not understood your own design. Convert each story into either a test,
a guard, or a documented accepted risk.

## 4. Concurrency design checklist (blocks merge when adding concurrency)

1. Every promise: who awaits it, and what happens if it rejects before that? After it?
2. Every abandoned promise path (early `continue`, attempt restart, phase break): is it
   aborted via signal, awaited, or explicitly dropped — and is a dropped one harmless?
3. Every shared file/resource: full writer list; snapshot/restore interactions; who wins
   on conflict; can a restore from A wipe a concurrent write from B?
4. Every loop the concurrency can re-enter: what is its proven bound?
5. Which failure kinds are evidence-about-work (fail-closed) vs checker-failures
   (fail-open, P5)?

## 5. Grammar design (for anything parsing external text)

Enumerate the source grammar from authoritative references (toolchain docs) before
writing the parser. Deliverable: an enumeration table (form → example → expected
behavior). The parser implements the table; the tests pin every row. When a new form
appears live, add it to the TABLE first, then the parser, then the test — and check
whether sibling forms were missed (the v0.3.52 review found 3 sibling forms the same day).

## 6. Semantics of rejection (checker design)

Every checker/verdict path is classified at design time:

- STRONG / evidence-clean → proceed
- WEAK / advisory → proceed with recorded advisory (never silently)
- CONTRADICTION (evidence about the work being wrong) → fail-closed, with discard
  semantics that name exactly what is discarded and what is kept
- CHECKER-FAILURE (timeout, boundary violation, spawn error, unparseable) → fail-open:
  keep the work, degrade to deterministic gates, count separately, disable the checker
  for this scope after N failures (it is broken, not the work)

Mixing these categories — e.g. treating a reviewer's own boundary violation as evidence
against the implementer — is a design defect even when every test passes.

## 7. Scope and ownership of shared state

A value consumed by ≥2 code paths is declared at their common ancestor scope, or exported
from a single owner module. Block-scoping a shared dependency where one call site can't
reach it is how the post-RED oracle silently lost the runner (P6). Shared mutable file
state gets one writer per phase/section; anything else is concurrency (checklist §4).

## 8. Versioning and rollout awareness

The engine snapshots per process; every release notes which live runs pick it up (new
processes only). Config precedence must state its snapshot point (per-run vs lazy-read)
— the v0.3.44/0.3.45 split (lazy thinking, snapshotted models) is documented, not
accidental.
