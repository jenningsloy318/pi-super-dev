# Unsatisfiable RED Tests — Root Cause & Resolution Design

Status: **ANALYSIS / DESIGN — not yet implemented**. Awaiting review.
Author: investigation of run `2026-08-14T02-34-13-863Z` (super-dev v0.1.50).
Sibling docs: `red-review-loop-root-cause-fix.md` (the *test-edit-during-GREEN* loop, fixed in v0.1.43), `convergence-loop-unbounded-cap-fix.md` (v0.1.44).

---

## 1. TL;DR

TDD + TDD-review cannot **guarantee** the RED tests are correct, because the
review only checks assertion *strength* (does the test bind observable
behavior), not *satisfiability* (can any implementation actually pass). When the
RED author writes a test that is internally contradictory or otherwise
impossible to satisfy, the implementer is forbidden from editing it (correct,
v0.1.50) but is given **no channel to report "the test is wrong"**. Its diagnosis
is discarded, the loop re-runs RED blind, reproduces the same contradiction, and
stagnates until no-progress escalation.

**Sticking to the tests is correct** — letting the implementer mutate assertions
to force green is the classic TDD-failure mode ("green suite, broken feature").
But "stick to the tests" is only viable if there is a **release valve**: a
bounded, evidence-backed path to re-author a genuinely-defective test. This doc
designs that valve.

## 2. The concrete failure (v0.1.50 run, pi-omisis spec 01)

Phase `01-interface-contracts-schemas`, single phase, model `glm-5.2`.

The RED author (`tdd-guide`) wrote `tests/omisis.test.ts` containing two
incompatible constraints on the same export `DimensionResultSchema`:

- **Line 338** (SCENARIO-001, a loop over all schemas):
  `expect(typeof schema, "...must be a schema object").toBe("object")`
- **Lines 346 / 410 / 744 / 755** (SCENARIO-020/021): call it as a factory —
  `DimensionResultSchema(Type.Unknown())`

In JavaScript **no value is both `typeof "object"` AND callable** (a function is
`typeof "function"`; `Proxy` over a function is still `"function"`). The
implementer spent **~80 minutes across 4 attempts exhaustively proving this**
(run.log lines 1500, 1634: *"The paradox: `DimensionResultSchema` must be
`typeof "object"` (line 338) AND callable (line 346)"*; it tested
`class extends Function`, `Proxy(function(){}, {apply})`, etc.).

Observed loop (run.log):

| Step | Event | Line |
|------|-------|------|
| RED a1 | red-oracle red; review **NOT STRONG** (weak assertions) → re-author | 879, 909 |
| RED a2 | red-oracle red; review **STRONG** → accepted RED | 966, 1004 |
| Impl attempt 1 | 20 min; build FAIL; post-red red; **reusing accepted RED** | 1273–1316 |
| Impl attempt 2 | 20 min; build FAIL; reusing accepted RED | 1396–1437 |
| Impl attempt 3 | 20 min; build FAIL; reusing accepted RED | 1544–1587 |
| Impl attempt 4 | 20 min; build FAIL; **no-progress escalation** | 1725–1766 |
| RED a5 | RED re-authored **blind** (no implementer evidence) | 1770+ |

Note: v0.1.50 worked as designed here — the implementer did **not** edit the
tests, so RED was **not** invalidated across attempts 1–4 (accepted RED reused).
The stagnation is a *different* failure mode than the one v0.1.43/v0.1.50 closed.

## 3. Root cause — four compounding gaps

1. **RED review checks strength, not satisfiability.** `buildRedReviewPrompt`
   (`src/prompts.ts:376`) judges *only* "does the test assert observable behavior
   with a concrete expected value." A test can be STRONG and yet unsatisfiable
   (the typeof-object ∧ callable contradiction). The review approved it.
2. **No implementer → test-author feedback channel.** The implementer is told
   test files are READ-ONLY (v0.1.50) but has no structured way to *challenge* a
   defective test. Industry guidance is explicit: *"Never modify an assertion to
   make a test pass. **Ask instead.**"* — the "ask" half is missing here.
3. **Implementer reasoning is discarded.** `implementation.ts` never reads the
   implementer agent result's `.text` (grep confirms zero usages). Only
   `control.filesModified` is consumed. So the ~80 min proof of impossibility
   evaporates; it never reaches the re-author prompt, the escalation prompt, or
   the user.
4. **Blind RED re-author on escalation.** The no-progress path
   (`implementation.ts:1466`) drops `acceptedRed = null` and re-runs tdd-guide,
   but passes **none** of the implementer's failure evidence. In a headless run
   (no user guidance) tdd-guide re-authors from scratch and reproduces the same
   contradiction — because the contradiction originates in the spec/AC
   interpretation ("backing schema + Static identity"), not in randomness.

## 4. Why "stick to the tests" is right *and* why it blocks

Letting the implementer weaken assertions to reach green is the canonical
failure: the suite passes, the feature is broken, zero signal (see §5 sources).
The GREEN boundary (implementer cannot edit tests) is correct and must stay.

But "stick to the tests" presupposes the tests are *satisfiable*. TDD's RED step
proves a test **can fail**; it does **not** prove a test **can pass**. For
LLM-authored tests, the dual — *satisfiability* — is not free: the same model
that can write a subtly-contradictory contract can also write one no code can
ever satisfy. With no release valve, an unsatisfiable test is a permanent
deadlock, not a slow implementation.

## 5. Research grounding

- **Agent tests are measurably defective at scale.** A 204,673-file study
  (AIDev dataset) finds ~11.6% of agent-written assertions use non-standard /
  no-op assertion patterns vs ~1.5% for humans; flakiness-candidate rate 0.41 vs
  0.30. Agents beat humans on edge-case coverage but lose on assertion validity.
  *(codewithseb, "Test-Driven Agentic Development".)*
- **The load-bearing rule.** *"Never modify an existing assertion to make a test
  pass. **Ask instead.**"* Without it, "an agent stuck on a red test will
  eventually fix it by editing the assertion — destroying the entire point."
- **Structural role split.** One agent writes tests, a *different* one writes
  implementation, with filesystem permissions enforcing the boundary — "eliminates
  the tautology problem structurally rather than by convention." pi-super-dev
  already does this (RED author vs implementer + GREEN boundary). It eliminates
  *cheating*, not *wrong tests*.
- **Noisy-verifier / verify-repair loops.** Academic work ("Verify, Repair,
  Repeat, or Stop?", arXiv 2607.17641; "Is Three the Magic Number?", 2607.05197)
  formalizes the failure mode: when the verifier (here, the test suite) is itself
  noisy/defective, the verify-repair loop can fail to converge because **the
  target is wrong, not the candidate**. Standard safeguards: bounded caps +
  the ability to **challenge/update the oracle**.
- **Mutation/sufficiency gating.** A test is adequate only if a mutated (broken)
  implementation fails it; symmetrically, a test is acceptable only if *some*
  conforming implementation can pass it.

## 6. Design options

### Option A — Satisfiability gate on RED review (deterministic + LLM)
Add a second RED-review question: *"Is this test internally consistent and
satisfiable by at least one conforming implementation?"* Catch (a) compile/type
errors **in the test file itself**, (b) contradictory assertions on the same
symbol, (c) assertions that pin a property no value can have (e.g. `typeof==="object"` ∧ callable).
- **Deterministic part (cheap, high-precision):** run `tsc --noEmit` on the RED
  test file (against the greenfield stub allowed by the boundary). TS errors *in
  the test* (e.g. the spread-type errors at lines 713–714, 724–725) = the test is
  *broken*, not *red* → re-author, never reach the implementer.
- **LLM part:** a focused "consistency" prompt (separate from the strength
  review) that asks for a concrete satisfiability proof or a named contradiction.
- *Pros:* catches the whole class before the implementer burns budget. *Cons:*
  LLM satisfiability check is imperfect; adds a RED-phase agent call.

### Option B — Implementer "challenge" channel (the missing "ask instead")
Give the implementer a structured control field, e.g. `testDefects`:
`[{ testFile, lineRange, kind: "contradiction"|"unsatisfiable"|"compile-error",
contradiction: "line A asserts X; line B asserts not-X — no value satisfies both",
evidence }]`. Emitting a challenge is **not** a free pass:
- It requires a **concrete contradiction proof** (named lines + why impossible),
  not "I can't do it."
- It routes to a **satisfiability re-review** (Option A's LLM check) on the
  *named* assertions. If the reviewer confirms unsatisfiable → re-author RED with
  the challenge evidence attached. If the reviewer says "no, this is satisfiable,
  the implementer is wrong" → **reject** the challenge and force the implementer
  to continue (with the reviewer's hint).
- *Pros:* directly mirrors the documented best practice; bounded by the reviewer
  gate so it can't become an escape hatch. *Cons:* new control contract + a
  re-review agent call per challenge.

### Option C — Capture & flow implementer evidence (enabler for A/B)
Read the implementer result's `.text` into a short "implementation report"
(last attempt's diagnosis, trimmed). Feed it into (a) the no-progress escalation
`failure.message`/`findings` (so the USER sees the contradiction, not a generic
"no progress") and (b) the RED re-author prompt when escalation drops RED. This
is the cheapest, highest-leverage change and is a prerequisite for B's evidence
flow.
- *Pros:* no behavioral change on its own; pure information flow. Immediately
  improves HITL escalation quality. *Cons:* must trim aggressively to avoid
  context bloat.

### Option D — Bounded RED re-author with evidence (convergence guarantee)
Wrap the RED re-author triggered by B (or by no-progress) in a bounded loop:
max **2** evidence-backed re-authors. After that, **HITL escalation with the full
evidence** (implementer diagnosis + satisfiability verdict), not a silent phase
fail. Caps total cost and guarantees termination.
- *Pros:* guarantees no infinite loop; matches the v0.1.44 liveness-cap pattern.

### Option E — (Rejected) Relax the GREEN boundary to let the implementer fix tests
Allowing the implementer to edit tests to "fix" them reopens the exact failure
mode v0.1.43/v0.1.50 closed (green-by-cheating, circular validation). Rejected.

## 7. Recommendation (minimal viable set)

**Ship C + B + D, and the deterministic half of A.**

1. **C (capture evidence)** — foundational, low-risk. Capture implementer `.text`
   into a trimmed report; surface it in escalation `message`/`findings`.
2. **A-det (deterministic satisfiability floor)** — reject RED tests that don't
   `tsc`-clean on their own file. Catches a large, cheap class before the
   implementer ever runs.
3. **B (challenge channel) + the LLM satisfiability re-review** — the structured
   "ask instead." A challenge is gated by an independent satisfiability verdict,
   so it cannot become an escape hatch.
4. **D (bounded re-author + HITL)** — convergence guarantee; mirrors v0.1.44.

Defer the *proactive* LLM satisfiability review on every RED (the expensive half
of A) initially; rely on B's *reactive* review (only when the implementer
challenges). Reassess after data on how often challenges fire.

## 8. Risks & edge cases

- **Challenge as escape hatch.** Mitigated by the independent satisfiability
  verdict (B). A challenged test the reviewer deems satisfiable returns to the
  implementer with the reviewer's hint, costing one review call but not a re-author.
- **Reviewer also wrong.** The satisfiability reviewer is itself an LLM and can
  miss contradictions (it approved the original test's *strength*). Defense: the
  implementer's named-line contradiction proof is concrete and checkable; the
  deterministic `tsc` floor catches the gross cases; the HITL cap (D) is the
  final backstop.
- **Implementer never realizes the test is wrong.** If glm-5.2 just keeps
  flailing without emitting a challenge, B never fires. Mitigation: the existing
  no-progress escalation already drops RED — C ensures that re-author carries the
  implementer's accumulated failure evidence, which is enough for tdd-guide to
  avoid reproducing the same contradiction.
- **Evidence bloat.** Trim implementer `.text` to the last attempt's key
  diagnosis (≤ ~1KB); route full text to the disk log only.
- **Multi-phase independence.** A challenge is per-phase, like the existing RED
  loop; it must not leak across phases (parity with the per-phase RED isolation
  already tested in `implementation-red-loop-edges.test.ts`).

## 9. Implementation sketch (for the later implement step — NOT now)

- `src/prompts.ts`: add a `testDefects` field to the implementer control schema;
  extend `buildImplementPrompt` with "if you have proven a confirmed RED test is
  unsatisfiable, DO NOT edit it — emit a `testDefects` challenge with named lines
  and the impossibility proof." Add `buildRedSatisfiabilityPrompt` (focused,
  separate from `buildRedReviewPrompt`).
- `src/stages/implementation.ts`: read implementer `.text` into a trimmed
  `implReport`; on `testDefects`, run the satisfiability re-review on the named
  assertions; if unsatisfiable → drop `acceptedRed` and re-author tdd-guide with
  `{ implReport, challenge }` injected into the re-prompt (reuse the existing
  RED re-prompt path at ~line 1043/1087); if satisfiable → reject challenge,
  append the reviewer's hint to the implementer retry feedback. Surface
  `implReport` in the no-progress `failure.message`/`findings` (~line 1453).
- Bound: max 2 challenge-driven re-authors, then HITL escalation (parity with
  `ESCALATION_RETRY_CAP` and the v0.1.44 `MAX_CONVERGENCE_ROUNDS` pattern).
- Tests: extend `implementation-red-loop-edges.test.ts` (implementer emits
  `testDefects` → satisfiability reviewer confirms → RED re-authored with
  evidence; reviewer denies → implementer retried with hint). Extend
  `red-oracle.test.ts`/a new suite for the deterministic `tsc`-clean RED floor.

## 10. Open questions for review

1. Should the deterministic RED `tsc`-clean floor be a hard reject (re-author)
   or a soft signal? (Recommend hard reject — a test that doesn't compile is never
   valid RED.)
2. Cap for challenge-driven re-authors: 2 (recommend) vs 3?
3. Should the satisfiability re-review reuse `code-reviewer` with a different
   prompt, or a distinct agent? (Recommend distinct prompt, same model, to keep
   the agent roster stable.)
4. Does the `testDefects` channel need a corresponding *positive* signal — e.g.
   the implementer must attempt normally for ≥1 full attempt before it may
   challenge (to avoid lazy challenges on attempt 1)?

---

## 11. Research findings (online) — added during implementation

Three comparable systems directly informed the implemented design:

- **`narailabs/claude-agentic-tdd`** — runs Test Writer → RED verify → Code Writer
  → GREEN verify → Spec-Compliance review → **Adversarial review**. Its
  error-handling **Phase D2** is exactly this case: *"After 3+ failed fixes for
  the same issue: STOP. The design may be wrong."* → escalate with options
  **(a) revise the design, (b) revise the test expectations, (c) accept**. Its
  anti-cheat **"Check 3: Correct Failure Type"** distinguishes valid RED
  failures from *broken tests* (SyntaxError/TypeError in the test file itself).
- **`agentic-development/adev-plugin`** — *replaced* the LLM test author with a
  deterministic materializer that renders structured test plans to code, which
  structurally eliminates a class of contradictory tests (a bigger architectural
  change than needed here; noted as a possible future direction).
- **Verify-repair literature** (arXiv 2607.17641, *"Verify, Repair, Repeat, or
  Stop?"*) — formalizes the failure: when the verifier (test suite) is itself
  defective/noisy, the loop cannot converge because **the target is wrong, not
  the candidate**. The safeguard is a bounded cap **+ the ability to
  challenge/update the oracle**, exactly the implement→RED evidence edge added
  here.

## 12. Implemented scope (v0.1.51) — conservative subset of the plan

Shipped the high-value, low-risk core; deferred the riskier pieces (A-det
deterministic `tsc` floor has a greenfield-module nuance; the separate LLM
satisfiability reviewer is redundant given the deterministic gate + HITL
backstop):

- **C (capture diagnosis):** the implementer's optional `testDefects` control
  field is parsed defensively (`parseTestDefects`); a trimmed `.text` tail is
  captured as a fallback/补充. Both are kept per-phase (latest attempt).
- **B-lite (evidence-carrying RED re-author):** when RED is re-authored, the
  implementer's proof is appended to the tdd-guide prompt
  (`formatReauthorEvidence`) — instead of blind re-authoring, which reproduced
  the same contradiction.
- **D (bounded loop + HITL):** a **proactive challenge edge** drops `acceptedRed`
  and re-authors WITH evidence when the implementer emits `testDefects` AND the
  confirmed test is still failing, bounded by `MAX_CHALLENGE_REAUTHORS = 2`
  (env-overridable). After the cap, the existing no-progress/HITL path takes
  over, and the no-progress escalation now carries the implementer's diagnosis
  (structured defects + `.text`) in both the message and findings, so the human
  sees *"implementer reports the RED test is unsatisfiable: …"* instead of a
  generic blocker.

**Gate against abuse:** a challenge requires a *confirmed* RED the implementer
failed against + a named defect with a concrete proof; the re-authored test
still passes the RED strength review; max 2; the no-progress detector guards a
bad-faith loop; HITL is the final backstop. Models that prove the test
unsatisfiable only in `.text` (no structured field) still get that proof routed
to the RED author via the no-progress guided path.

**Deferred:** A-det (deterministic RED `tsc`-clean floor) and the separate
satisfiability re-review agent — documented above for a follow-up after
real-run evidence.
