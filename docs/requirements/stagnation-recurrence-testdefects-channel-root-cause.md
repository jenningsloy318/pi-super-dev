# Stagnation Recurrence (run 2026-08-14T07-23-57-126Z) — Root-Cause Analysis

Status: ANALYSIS ONLY — no source changes proposed as applied. Fix plan in §7.
Amended in a third pass (§7.7): full cross-language audit (node/python/go/rust) of every implementation/verify stage step; new Fixes 6, 6b, 7, 8.
Reviewed and amended in a second pass (§7.6): Fix 1 was expanded (1a–1e)
from new evidence — the actually-captured implementer control object and the
optionality-enforcement mechanics of both backends — because naive key
declaration would have introduced a corrective-re-prompt loop.
Run: `~/.super-dev/runs/2026-08-14T07-23-57-126Z/` (super-dev v0.1.52, target repo
pi-omisis, worktree `01-interface-contracts-schema-validators`, implementer model
`zai-coding-cn/glm-5.2`, RED reviewer `antigravity/gemini-3.7-flash`).

---

## 1. Executive summary

The user-facing symptom: the implementation phase hit the no-progress stagnation
escalation again ("made no progress across consecutive attempts"), despite the
v0.1.51 fix that was supposed to route the implementer's unsatisfiable-test proof
back to the RED author.

What actually happened, in one paragraph:

1. The tdd-guide authored a RED suite that is **provably unsatisfiable**
   (SCENARIO-029 contradicts SCENARIO-016 — formal proof in §3.1). The RED
   reviewer judged it STRONG because it only evaluates assertion *strength*,
   never joint *satisfiability*.
2. The implementer **found and proved the contradiction** — twice, in its
   reasoning text ("My proof is now airtight", "the provably-unsatisfiable
   SCENARIO-029"). This is exactly the scenario the v0.1.51 challenge channel
   was built for.
3. But the challenge channel was **dead on arrival in real runs**: the
   `testDefects` control key never reached the session's structured_output
   schema, because `extractControlKeys` (src/control.ts:59) mangles the
   implementer prompt's control line. The comma inside
   `testDefects (optional array of {testFile, lines, reason} …)` splits the
   segment; the fragment carrying `testDefects` has an unclosed paren and is
   rejected, while the inner word `lines` leaks through as a phantom key. The
   run log proves it live (`controlKeys=…,summary,lines` — no `testDefects`),
   and the actually-captured control object (recovered from the worktree's
   `.resume-cache.jsonl`) proves both directions at once: the model filled
   exactly the six declared keys — **including the phantom `"lines":"808"`** —
   and could only mention "reported in testDefects" inside `summary`, because
   an undeclared key is invisible to the model's output contract.
4. With `implDefects` structurally empty, neither the automated challenge edge
   (`src/stages/implementation.ts:1530`) nor the evidence-bearing escalation
   message (`:1568`) could fire. The `.text` fallback exists but only inside
   the retry-with-guidance branch — i.e. only *after* a user guesses
   "retry-with-guidance" from a generic message that never mentions the proof.
5. The no-progress detector then correctly escalated (generic message +
   vitest findings — the screenshot the user saw). Liveness worked; evidence
   routing did not.

So: **the v0.1.51 design was right, its wiring was broken by a one-line parser
it never tested, and the escalation UX hides the one fact the user needed to
decide.** Three independent defects, each sufficient to cause the recurrence:
a parser bug (new), a decision-support gap (design), and the still-reactive
satisfiability screening (known gap, now with a second real-world occurrence).

---

## 2. Run timeline (evidence)

All times 2026-08-14 +08:00, from `run.log` (1058 lines) and the worktree.

| Time | Event | Evidence (run.log line) |
|---|---|---|
| 16:33:01 | Phase 1/3 starts: `schema-validators-and-validate-functions` | 597 |
| 16:33:01 | tdd-guide spawn — `controlKeys=testsWritten,testFiles,allFailing,summary` | 602 |
| 16:46:29 | tdd-guide ends — elapsed **807s**, authored ~640-line test file | 684 |
| 16:46:30–56 | RED oracle (red), boundary, scenario coverage, RED review | 686–701 |
| 16:47:49 | RED review verdict: **STRONG** — "determinism + runtime budget" enumerated, no satisfiability check | 717–721 |
| 16:47:49 | Implementer attempt 1 spawn — `controlKeys=filesCreated,filesModified,filesDeleted,testsPassCount,summary,lines` (**no testDefects**) | 724 |
| 16:55:57 | Implementer: "Everything passes except SCENARIO-029 … appears to contain an internal contradiction with SCENARIO-016" | 742 |
| 16:56:42 | Implementer: "My proof is now airtight … The sole failure — SCENARIO-029 — is **provably unsatisfiable**"; structured_output captured (`control=yes`) — fills exactly the 6 declared keys (incl. phantom `"lines":"808"`), **no `testDefects`** (§3.2a) | 752 |
| 16:57:13 | Attempt 1 FAIL: post-RED oracle still red at `schemas-validators.test.ts:606`; `tdd-targets-still-red` | 897 |
| 16:57:13 | Attempt 2: RED reused (no challenge edge — `implDefects` empty) | 910–913 |
| 16:57:18–17:02 | Implementer attempt 2 re-derives the same proof from scratch (probing + docstring edits, then reverts them) | 916–1046 |
| 17:02:38–17:18 | Attempt 2 **hangs ~15.5 min** in/after an `npm test` pipeline, then **times out at 1200s with `control=no`** — its final message (the proof, cut off mid-sentence) never delivered as structured output; attempt evaluated from disk state | 1045 |
| 17:18:12 | Attempt 2 post-RED oracle: **byte-identical failure** at :606 → identical failure signature across 2 attempts → `repeatedNoProgress` | 1056–1058 |
| — | No-progress stagnation → HITL escalation, generic message + vitest findings (user's screenshot); run halted pending decision | escalation.ts via implementation.ts:1560+ |

Cost of the broken channel: ~35 implementer-minutes — attempt 2 re-proved what
attempt 1 had already proven (because attempt 1's proof was discarded), and then
timed out on top. Note: attempt 2's `impl.control` was `null` (timeout), so even
a perfect parser could not have rescued attempt 2; the channel must work on
**attempt 1** (Fix 1) or the proof must be surfaced to the human (Fix 3) for
this run shape to converge.

---

## 3. Root-cause chain — four layers

### 3.1 The RED test suite is provably unsatisfiable (test-authoring defect)

`tests/schemas-validators.test.ts` SCENARIO-029 (lines ~591–609):

```ts
const s = staging({ stage: "maturity", penetrationRate: 1.5 });
const d = dimResult({ score: 11, weightedScore: 99, verdict: "pass", evidence: [] });
const samples: string[][] = [];
for (let i = 0; i < N; i++) {          // N = 5000
  samples.push(validateStaging(s));     // even indices
  samples.push(validateDimensionResult(d)); // odd indices
}
const first = JSON.stringify(samples[0]);   // = staging errors
expect(samples.every((x) => JSON.stringify(x) === first)).toBe(true);
```

The determinism assertion compares **every** sample to `samples[0]` — including
the dimension-result samples — so it demands
`validateDimensionResult(d) ≡ validateStaging(s)` byte-for-byte.

SCENARIO-016 (same fixtures, lines ~496–510) pins the opposite:

- `stageErrs.some(/penetrationRate/i)` = true, `stageErrs.some(/maturityBranch/i)` = true,
  and `stageErrs.some(/G2|G4|G17/)` = **false** → `stageErrs` contains zero
  G4-bearing strings;
- `dimErrs.some(/G4/)` = **true** (§4 G4 token via validateFailLoud concat) →
  `dimErrs` contains at least one G4-bearing string.

Formal contradiction: SCENARIO-029 ⇒ `dimErrs ≡ stageErrs` (byte-identical);
SCENARIO-016 ⇒ `dimErrs` contains a G4 string ∧ `stageErrs` contains none.
No implementation satisfies both. ∎

(The authoring bug is a classic interleaved-array indexing error — the intended
semantics was per-validator determinism, e.g. comparing even-to-even and
odd-to-odd, or `samples.filter((_, i) => i % 2)` per validator.)

### 3.2 L0 — the structured challenge channel was never offered (parser defect, NEW)

Data flow of the channel:

```
buildImplementerPrompt (src/prompts.ts:429, control line ends with
  "…summary, testDefects (optional array of {testFile, lines, reason} — …).")
  → workflow.ts:314  controlKeys = call.controlKeys ?? extractControlKeys(prompt)
  → control.ts:59    extractControlKeys
  → session-agent.ts:157 controlSchema(keys)   // DECLARED keys drive model output
  → implementation.ts:1355 implDefects = parseTestDefects(impl.control)
  → implementation.ts:1530 challenge edge / :1568 escalation evidence
```

`extractControlKeys`:

```ts
const m = prompt.match(/<control>\s*JSON\s*with:\s*([^\n.]+)/i);
return m[1].split(",")                       // ← splits INSIDE {testFile, lines, reason}
  .map((s) => s.replace(/\([^)]*\)/g, "").trim()) // ← fragment's paren never closes → not stripped
  .filter((s) => /^[A-Za-z_][\w]*$/.test(s));     // ← fragment fails identifier test → dropped
```

Reproduced byte-for-byte against the shipped prompt line:

```
extracted keys: ['filesCreated','filesModified','filesDeleted','testsPassCount','summary','lines']
```

- `testDefects` is **dropped** (its fragment is `testDefects (optional array of {testFile`
  — unclosed paren, fails the identifier filter).
- `lines` **leaks in** as a phantom key (from inside the brace shape).
- The live run log (impl.a1 line 724, impl.a2 line 915) shows exactly this key
  set — the bug is confirmed in production, not just in a probe.

Why the schema matters: `controlSchema` builds the structured_output tool schema
from these keys. The module comment is explicit — "a schema that declared only
`summary` made GLM return only `summary`": **declaration is what makes the model
fill a key.** `additionalProperties: true` means emitting `testDefects` was not
*rejected*, but an undeclared key is invisible to the model's contract. GLM-5.2
followed the declared six keys and never emitted `testDefects`, even though it
had airtight proof in its reasoning.

Why v0.1.51's validation missed this: the prompt tests assert the challenge
*text* is present; the challenge-edge integration tests inject structured
`testDefects` into the mocked control directly — **bypassing
extractControlKeys/controlSchema entirely**. The seam between the mocked unit
boundary and the real session path was never tested. (tests/control.test.ts has
4 extractControlKeys cases; none has a comma inside a parenthetical/brace.)

Fragility inventory of this parser (all pre-existing, one now load-bearing):
- comma-split inside `(…)`/`{…}` shapes (the v0.1.51 casualty);
- `[^\n.]` capture stops at any `.` — a control line containing "e.g." or a
  decimal truncates the key list;
- unclosed-paren fragments silently dropped rather than surfaced;
- inner shape words leak as phantom keys (observed: `lines`).

#### 3.2a The captured control object (round-2 evidence, decisive)

The implementer's actual attempt-1 structured output, recovered from the
worktree's `docs/specifications/…/.resume-cache.jsonl`:

```json
{"filesCreated":"[]","filesModified":"[\"src/schemas.ts\"]","filesDeleted":"[]",
 "testsPassCount":"45",
 "summary":"… The single failing test (SCENARIO-029) is a proven unsatisfiable test defect (internal contradiction with SCENARIO-016) — reported in testDefects, not an implementation gap.",
 "lines":"808"}
```

This single object proves both directions of the failure at once:

- **declared keys get filled** — including the phantom `lines`, which the model
  dutifully filled with `"808"` (the line count of src/schemas.ts) even though
  no consumer reads it;
- **undeclared keys are never emitted** — the model had an airtight proof and
  *believed* it was reporting it ("reported in testDefects" in `summary`), but
  the key was not in its output contract, so the structured channel stayed
  empty.

(`testDefects` appears **zero times** in the entire run directory — logs,
audit, artifacts.)

### 3.3 L1 — the escalation hides the proof even when it exists (decision-support gap)

With `implDefects` empty:

- `implementation.ts:1568` message: the `THE IMPLEMENTER REPORTS THE RED TEST IS
  UNSATISFIABLE: …` clause is gated on `implDefects.length` → user sees the
  generic "often an unsatisfiable RED test…" line with **no evidence that a
  proof exists**.
- `findings` likewise carry only structured defects.
- The `.text` fallback (`implTextTail`, captured at :1356 via
  `trimImplementerText`, 1200-char tail — and it *did* contain the proof in
  both attempts) is used **only** inside the retry-with-guidance branch
  (`reauthorEvidence = formatReauthorEvidence(implDefects, implTextTail)`).

Net effect: the one decision that would have self-healed the loop
(retry-with-guidance → re-author with evidence) could only be chosen **blindly**.
The information existed in-process and was not surfaced at the decision point.
This is a violation of evidence conservation at the human boundary (§4, I3).

### 3.4 L2 — satisfiability is still screened only reactively (known gap, 2nd occurrence)

The RED reviewer (gemini-3.7-flash, 53s) mapped all 24 scenarios, verified
behavior-binding assertions, no tautologies — and explicitly enumerated
"SCENARIO-027–031: … determinism + runtime budget …" — then judged STRONG.
Strength review cannot catch a *joint* contradiction between two strong tests;
nothing in `buildRedReviewPrompt`/`RED_REVIEW_SCHEMA` asks the question. The
cost asymmetry is brutal: the reviewer had the whole file and could plausibly
have found the 016-vs-029 contradiction; instead the pipeline paid 807s (tdd) +
53s (review) + ~30 min (two implementer attempts re-proving it) + a human
interruption.

### 3.5 Why the loop converged on HITL rather than any self-healing edge

Control-flow trace of the terminal path (implementation.ts):

1. Attempt 1 gates: build ✓, deliverable ✓, symbol ✓, post-RED oracle **red**
   → `tddOracleFailures` → attempt FAIL.
2. Challenge edge (:1530): `acceptedRed && implDefects.length && …` →
   `implDefects = []` → skip. (Missing-test-deliverable reroute: N/A.)
3. Progress signature: failure identical to (future) attempt 2, footprint
   changed (docstring edits) → attempt 2 runs.
4. Attempt 2: **timed out at 1200s with `control=no`** (hung ~15.5 min in/after
   an `npm test` pipeline; its final message — the proof, cut off mid-sentence
   — never became structured output). The stage then evaluated the attempt from
   DISK state: build-gate FAIL, post-RED oracle **byte-identical failure** →
   identical failure signature, changed footprint → `repeatedNoProgress` = true.
5. Escalation (:1560): generic message (per §3.3) → HITL → run halted.

Consequence for fix design: on timeout the session backend still returns
`text` (the last assistant message — a2's partial proof was captured that
way), but `control` is null because structured_output was never called, so
`implDefects` is [] for a2 and the challenge edge reads only the CURRENT
attempt's defects — a1's proof was never persisted across attempts. Any fix
that only improves attempt-2+ handling cannot save this run shape: the channel
must work on **attempt 1** (Fix 1), or the human must see the proof
(Fix 3 surfaces `implTextTail`, which is non-empty for BOTH attempts — a1's
from its completed turn, a2's from its aborted turn).

Every individual component behaved as coded; the *composition* lost the signal.
Liveness held (bounded, escalated, nothing spun); correctness of the evidence
route did not.

---

## 4. First-principles system analysis

Model the pipeline as a system of **contracts over stringly-typed boundaries**
with **evidence-carrying feedback loops**. The failure is best understood as
contract drift + a broken feedback edge, not as any single wrong line.

### 4.1 The contracts (and which broke)

| # | Contract | Mechanism | Status |
|---|---|---|---|
| C1 | prompt tail ↔ controlKeys parser | prose line parsed by regex (control.ts) | **BROKEN** — v0.1.51 edited one side of a two-sided stringly contract with no joint test |
| C2 | controlKeys ↔ structured_output schema | session-agent declares keys | holds, but propagates C1's corruption faithfully (phantom `lines` included) |
| C3 | schema ↔ model behavior | "declared keys get filled" (documented empirically) | held — model filled exactly the 6 declared keys |
| C4 | implementer ↔ challenge channel | prompt text + optional key | text half held (proof written), structured half unreachable via C1 |
| C5 | escalation ↔ human | message + findings | **BROKEN** — carries only structured evidence, discards in-process text evidence |

C1 is the archetype of the whole failure class: **two components coupled by an
informal prose protocol, changed independently, with the coupling itself
untested.** The codebase already knows the better pattern — explicit
`controlKeys` at the call site (verify.ts:430, implementation.ts:380/437) — but
the implementer AgentCall relies on parsing.

### 4.2 System properties, checked one by one

- **Liveness (termination):** ✅ Held. No unbounded loop; stagnation detector
  fired after 2 identical-failure attempts with changed footprint; escalation
  bounded by ESCALATION_RETRY_CAP. (The v0.1.44 cap work did its job.)
- **Observability:** ✅ Held — and it is *why* this diagnosis took minutes, not
  hours: the `controlKeys=` field in the spawn log exposed the dead channel
  directly. Lesson: keep logging derived contracts at their derivation point.
- **Evidence conservation:** ❌ Broke twice. (a) Attempt 1's proof was discarded
  (implDefects empty ⇒ nothing carried forward), forcing attempt 2 to re-derive
  it at full cost. (b) The proof never crossed the human boundary (§3.3). In a
  system whose core value proposition is "route hard-won diagnostic evidence to
  the right consumer", evidence discard is the primary failure mode — more
  dangerous than a crash, because it *looks* like orderly degradation.
- **Feedback-loop closure:** ❌ The implement→tdd edge exists in code
  (challenge + guided re-author) but was unreachable. A feedback edge that
  cannot fire is worse than an absent one: it suppresses the search for the real
  gap ("we already fixed that") — exactly the user's reaction.
- **Defense in depth:** ❌ All evidence-routing layers depended on ONE signal
  (structured `testDefects`). No layer independently consumed `.text`. Single
  point of failure at the *evidence source*, not at a consumer.
- **Cost asymmetry (screening vs repair):** ❌ A 53s review pass could have
  caught what 30 min of implementer time + a human interruption later
  established. Satisfiability screening at RED-accept is the highest-leverage
  missing control point.

### 4.3 Why the v0.1.51 fix was structurally insufficient (honest post-mortem)

The fix treated the loop as a *control-flow* problem (add the edge, bound it,
gate it) and validated it with mocks at the unit seams. But the edge's *sensor*
(the structured key) crossed three boundaries the tests never exercised
end-to-end: prompt → parser → schema → model. A control loop with an
unreachable sensor is indistinguishable from no loop. The general lesson for
this codebase: **any feature triggered by a structured control key needs a
contract test over the full prompt→extractControlKeys path** (cheap: one test
per build*Prompt), and load-bearing AgentCalls should declare `controlKeys`
explicitly rather than inherit prose parsing.

---

## 5. What DID work (credit where due)

- The implementer model (glm-5.2) produced a correct, rigorous unsatisfiability
  proof — twice. The v0.1.51 *prompt* contract (explain the channel in text)
  reached the model; only the return channel was missing.
- RED authoring, boundary, coverage, strength review, all gates, and the
  post-RED oracle all functioned; the failure was isolated and reproducible.
- Stagnation detection + HITL with real findings (vitest output) — the
  escalation *content* fix from earlier work showed up verbatim.
- run.log/streaming made a no-guess diagnosis possible.

---

## 6. Interlocking failure diagram

```
tdd-guide authors contradictory suite (3.1)
        │
RED review: strength-only ⇒ STRONG (3.4)          ← missed catch #1
        │
implementer PROVES unsatisfiable (in .text) ✓
        │
        ├── structured testDefects ✗  ── C1 parser drops key (3.2)   ← root
        │                                        └─ schema never declares it (C2/C3)
        │
challenge edge: implDefects.length=0 ⇒ inert (3.5)                  ← missed catch #2
        │
attempt 2 re-proves (evidence discarded, ~21 min)
        │
no-progress stagnation ⇒ escalation
        └── message/findings: structured-only ⇒ generic (3.3)        ← missed catch #3
                │
            human sees "blocker", no proof, run halted
```

Three independent misses, any one of which would have saved the run.

---

## 7. Fix plan (proposed, NOT implemented)

### Fix 1 (critical): make the implementer control contract explicit, optional-safe, and parser-proof

> AMENDED in review round 2. The original 1a alone is INCOMPLETE AND HAZARDOUS:
> both backends enforce every declared key as REQUIRED. Declaring `testDefects`
> without the companion changes below would make every normal green run (where
> the implementer legitimately has no defects to report) fail key-completeness
> and trigger a corrective re-prompt loop — trading one stagnation for another.

**The optionality mechanism (as-is in the code):**
- session backend (session-agent.ts:577): `missingControlKeys` flags a key as
  missing when it is undefined OR an empty array, UNLESS allow-listed in the
  hardcoded `emptyArrayOk = new Set(["filesCreated","filesModified","filesDeleted"])`.
  A missing key triggers exactly one corrective re-prompt.
- subprocess backend (pi-spawn.ts:325/343): `controlError` /
  `buildSubprocessCorrectivePrompt` call `missingControlKeys` with **no options**
  — every declared key is unconditionally required; a miss is an error and a
  corrective retry.
- Online research corroborates the shape: do not rely on silently-omitted
  optional fields in structured output; represent "no value" explicitly (empty
  array / null) so the contract stays checkable.

1a. **Declare `controlKeys` explicitly on the implementer AgentCall**
(implementation.ts:1341, parity with verify.ts:430):
`["filesCreated","filesModified","filesDeleted","testsPassCount","summary","testDefects"]`.
This removes the load-bearing dependency on prose parsing entirely — the
stringly contract becomes a typed one at the call site.

1b. **Prompt contract flip: "emit `[]` when none" instead of "omit otherwise"**
(prompts.ts:429). The control line's testDefects clause becomes e.g.
`testDefects (array of {testFile, lines, reason} — ALWAYS emit; use [] when you
have no proven unsatisfiable test)`. Together with 1c/1d this makes absence a
detectable, correct state rather than a re-prompt trigger.

1c. **Allow-list `testDefects` for emptiness** in the session backend: add it to
`emptyArrayOk` (session-agent.ts:577). Note `missingControlKeys` still requires
the key to be PRESENT (undefined ≠ `[]`) — which is exactly what we want: the
model must emit the key; an empty array is a valid value.

1d. **Thread `allowEmptyArraysFor` through the subprocess backend**: add an
optional option to pi-spawn's control checks (controlError /
withControlError / buildSubprocessCorrectivePrompt call sites), default
unchanged for all other stages; the implementer spawn passes
`["filesCreated","filesModified","filesDeleted","testDefects"]`.

1e. **Harden `extractControlKeys`** for every other caller: split the captured
list on commas at nesting depth 0 (respect `(`/`)` and `{`/`}`), then strip one
balanced parenthetical per segment; reject-and-*log* unparseable fragments
(surfacing drift instead of silently dropping keys). Replace the `[^
.]+`
capture with end-of-line capture and strip only a trailing sentence-final `.`.

**Blast radius of 1e (audited, benign but must be pinned by tests):** the
review prompts (prompts.ts:262/271/439/442 etc.) currently extract PHANTOM keys
from inside `findings [{id, severity, title, …}]` shapes — e.g. the spec-review
line yields `title, date, verdict, summary, findings, priorFindingResolutions,
dimensions` PLUS phantoms like `id`, `severity`, `detail`, `status`,
`recommendation`, `evidence`. After 1e these become the clean intended sets.
No consumer breaks (consumers read the real keys; `additionalProperties: true`
tolerated the phantoms and will tolerate their absence), but Fix 2 must pin the
NEW clean key sets so the change is deliberate, not accidental.

### Fix 2 (critical): contract regression tests

2a. For EVERY `build*Prompt` with a control line, assert the exact extracted
key set (`extractControlKeys(buildX(...))`), including the implementer's
`testDefects` (post-1a the call-site keys are authoritative, but the prompt line
and parser must still agree for every OTHER stage). This is the joint test whose
absence caused this recurrence; it converts C1 from informal to enforced. Pin
the post-1e clean sets (see blast-radius note above).

2b. Parser unit cases: comma inside parens, comma inside braces, nested shapes,
"e.g." mid-line, unclosed paren (must surface, not silently drop). Include the
exact v0.1.52 implementer control line as a regression fixture (must yield the
full set INCLUDING `testDefects`, no phantom `lines`) — plus the post-1b
rewritten line.

2c. Optionality-mechanism tests: session `missingKeys` with
`allowEmptyArraysFor` containing `testDefects` (absent → still missing;
`[]` → OK); pi-spawn controlError with and without the new option (default
behavior unchanged for other stages).

### Fix 3 (high): evidence conservation at the human boundary

In the no-progress escalation (implementation.ts:1560+): when `implDefects` is
empty but `implTextTail` is non-empty, append a bounded "Implementer's latest
diagnosis (reasoning tail):" block to the message and a `title:
"implementer diagnosis: <first line>"` finding. The user must never have to
guess that a proof exists. (Reuse `trimImplementerText`'s 1200-char bound; raw
text, no interpretation.) Round-2 note: `implTextTail` is available even when
an attempt timed out with `control=no` — the session backend still returns the
last assistant text, and both attempts in this run ended with the proof in
their text — so this fix covers the timeout path too (see §3.5).

### Fix 4 (recommended): proactive satisfiability screening at RED review

Extend `RED_REVIEW_SCHEMA`/`buildRedReviewPrompt` with a joint-consistency
question — e.g. `contradictions: [{ tests, lines, proof }]` with the instruction
"verify at least one conforming implementation could pass ALL tests
simultaneously; name a witness or report contradictions". Route non-empty
contradictions to the tdd-guide re-author (same retry machinery as weak
verdicts). This moves the catch from ~30 min post-implementation to ~1 min at
review time, and this run is the second real-world instance proving the need.
Cost note: one extra review dimension on an existing 53s pass; false positives
are bounded by the same re-author loop that already exists.

### Fix 5 (optional): cheap text-proof heuristic for the challenge edge

If `implDefects` is empty but the text tail matches proof markers
(/unsatisfiab|contradict|cannot be satisfied/i) AND the attempt failed against
a confirmed RED, log an advisory and include the tail in Fix 3's message even
earlier. Do NOT auto-trigger re-author from text alone (abuse/precision risk —
`.text` is always present; the no-progress guard exists precisely because of
that).

### Non-goals / rejected alternatives

- Relaxing the RED boundary or letting the implementer edit tests — unchanged,
  correctly rejected before.
- Deterministic (non-LLM) satisfiability checking — undecidable in general;
  not worth a partial special-case now.
- Raising MAX_CHALLENGE_REAUTHORS or attempt counts — the caps are not the
  problem; the sensor is.

### Validation plan

- Unit: control.test.ts cases (2b); per-prompt key-set contract tests (2a);
  optionality tests (2c).
- Integration: challenge-edge suite extended with an end-to-end variant that
  builds the REAL implementer prompt and asserts (i) the call-site controlKeys
  contain `testDefects`, (ii) `extractControlKeys` on the same prompt also
  yields it (call site and prompt line can never drift apart again), and (iii)
  the escalation message contains the text tail when structured defects are
  absent.
- No-regression guard for 1c/1d: a green-path implementer control containing
  `testDefects: []` triggers NO corrective re-prompt in either backend; an
  implementer control missing the key entirely still does.
- Replay: this run's fixtures (SCENARIO-016 + 029) as a regression fixture for
  Fix 4's reviewer prompt (accepting that LLM output is nondeterministic, assert
  on schema + routing, not on the verdict).
- Full suite + typecheck + version bump per AGENTS.md.

### 7.6 Review round 2 — amendments and new evidence (2026-08-14)

Recorded for traceability; the sections above already incorporate them.

- **A. Fix 1 expanded (1a→1a–1e).** New finding: both backends treat every
  declared key as required (session `emptyArrayOk` allow-list is hardcoded and
  only covers file-list keys; pi-spawn has no exemption mechanism at all).
  Naive declaration of `testDefects` would have caused a corrective re-prompt
  on every normal green run. Remediation: explicit `[]` contract (1b) +
  emptiness allow-listing (1c) + subprocess option threading (1d).
- **B. Timeline corrected.** Attempt 2 did not "re-derive in ~21 min" — it
  re-derived by 17:02, then HUNG ~15.5 min in an `npm test` pipeline and timed
  out at 1200s with `control=no`; the attempt was evaluated from disk state.
  Because a2's structured output never existed, only attempt-1 fixes (or
  Fix 3's surfaced proof) can save this run shape.
- **C. Parser blast radius documented.** All 21 control lines in prompts.ts
  audited; review prompts currently extract phantom keys from `findings […]`
  shapes. Post-1e sets must be pinned by Fix 2a (change is deliberate and
  consumer-safe).
- **D. Prior open question 1 answered.** The phantom `lines:"808"` lives only
  in `.resume-cache.jsonl` (a replay cache); no consumer reads `lines`.
  Transient — no artifact cleanup needed.
- **E. Research round 2.** Structured-output guidance confirms "optional means
  omit" is unreliable; explicit empty-container values are the robust pattern
  (matches 1b/1c). LLM-judge literature supports dedicated consistency/
  satisfiability review dimensions (supports Fix 4) while cautioning that
  self-review without external evidence degrades — hence Fix 4 asks for a
  WITNESS or a named contradiction, not a vibe.

---

## 7.7 Cross-language audit — every implementation/verify stage step (round 3)

The extension targets node/npm, python, go, and rust repos (plus mixed
monorepos via owner-scoped plans). Every language-sensitive step was audited
against the code; verdicts and gaps:

| # | Step (code) | node | python | go | rust | Verdict |
|---|---|---|---|---|---|---|
| 1 | detectProjectCommands (detect.ts) | ok | GAP-E | ok | ok | python runner detection too strict |
| 2 | dependency bootstrap (gates.ts:312) | ok | GAP-F | ok (go mod download) | ok (cargo self-fetches) | uv missing |
| 3 | RED oracle plan builders | ok | ok | ok (pkg-dir args avoid go file-arg trap) | ok (--test stem) | — |
| 4 | classifyRedStatus greenfield detection | ok (0.1.43) | GAP-A | GAP-A | GAP-A | npm-only |
| 5 | RED boundary path tokens (test-artifacts.ts) | ok | ok (tests/, test_*.py) | ok (foo_test.go) | ok (top-level tests/) | B2: profile conflicts |
| 6 | test lister (requireTests) | ok | ok (--collect-only) | ok (-list .) | ok (-- --list) | — |
| 7 | deliverables + comment-strip | ok | ok (#) | ok (//) | ok | — |
| 8 | symbol gate (hollow shells) | ok | ok | ok | ok | — |
| 9 | runBuildGate | ok | ok (test+mypy by design) | ok | ok (scoped -p) | — |
| 10 | post-RED oracle | ok | inherits GAP-A | inherits | inherits | — |
| 11 | testDefects challenge channel | language-neutral JSON — but UNREACHABLE pre-GREEN in python/go/rust until GAP-A is fixed (never reaches acceptedRed) |
| 12 | no-progress/stagnation/escalation | language-neutral | — | — | — | — |
| 13 | agents/lang/*.md profiles | ok | ok | ok | GAP-B2 | rust unit-test placement breaks RED |
| 14 | prompts (TDD/implementer/QA) | ok | GAP-C | GAP-C | GAP-C | npm-centric wording; greenfield clause contradicts oracle for 3 languages post-0.1.43 |
| 15 | verify-loop gates | reuse runBuildGate — ok for all | — | — | — | — |
| 16 | integration bringup detectServices (lifecycle.ts) | ok | GAP-G | GAP-G | GAP-G | node-only heuristic; LLM-discovered fallback exists |
| 17 | mixed monorepos ownerRedCheckPlans | per-owner classify — inherits GAP-A per owner; fixed automatically by Fix 6 |

**GAP-A (critical):** greenfield RED detection (0.1.43's isGreenfieldModuleMissing)
exists ONLY in the npm branch of classifyRedStatus. python `ERROR collecting` +
ModuleNotFoundError, go `# pkg ... undefined:` / `[build failed]`, rust
`error[E0432]`/`E0583`/`couldn't read src/lib.rs` all classify `broken`
today. Two consequences: (1) a greenfield phase in these languages can never
reach acceptedRed → the testDefects challenge channel (Fixes 1–5) is
unreachable → the pre-0.1.43 deadlock; (2) the 0.1.43 TDD prompt clause ("a
test that fails because its import of the not-yet-created module cannot be
resolved is a valid RED") now CONTRADICTS the oracle for 3 of 4 languages.
Research (rs4ts.dev, sbmueller.de, SO 13522950/417735/55327185): in compiled
languages a test failing to compile because the SUT does not exist is widely
treated as valid first-step RED; stub-free discipline is what the boundary
already enforces → extend the detectors, not relax the boundary.

**GAP-B2 (rust):** agents/lang/rust.md mandates unit tests in
`src/<module>/tests/*.rs` via `#[cfg(test)] mod tests;` declared in the parent
module — but declaring the mod requires editing a production file (RED boundary
rejects it) and the oracle only runs top-level `tests/<stem>.rs` integration
binaries. During RED the author must use top-level `tests/` only (compiles as
a separate crate, zero production edits — rust-lang docs ch11-03);
src-placed unit tests come during GREEN.

**GAP-C (prompts):** implementer full-suite line says `npm test` / `cargo test`
only; TDD deliverables guidance says `it(...)`/`test(...)` (vitest/jest) —
misleads pytest (`def test_*`), go (`func TestXxx`), rust (`#[test] fn`)
authors. The deterministic gates are language-neutral; only the wording lies.

**GAP-E (severe):** python branch of detectProjectCommands detects pytest ONLY
via pytest.ini/tox.ini/pytest-config-sections — not requirements.txt /
pyproject dependencies / conftest.py. A plain repo → cmds.test undefined →
RED oracle `unknown` → post-RED `tdd-targets-unverified-after-implementation`
→ EVERY attempt fails forever: a stagnation loop with no code cause, exactly
this run's shape with a different sensor. Research (pytest docs): pytest is
zero-config by design (discovers test_*.py with no config file) → defaulting
to `pytest -q` for python repos without a configured runner is the de-facto
standard.

**GAP-F (minor):** bootstrap handles poetry.lock/Pipfile/requirements+.venv but
not uv.lock (`uv sync`) — while agents/lang/python.md says uv is preferred.

**GAP-G (documented limitation, no code change):** detectServices only
heuristically detects node API/UI services; the assessment stage's
LLM-discovered service spec remains the cross-language fallback.

### New fixes (round 3)

**Fix 6 (co-critical with Fix 1): greenfield RED parity for python/go/rust.**
Extend classifyRedStatus with per-language greenfield detectors using the SAME
filesystem-existence discriminator as npm (distinguishes "module under test not
created yet" from "genuinely broken test"):
- python: `ERROR collecting` + `ModuleNotFoundError: No module named 'X'`
  → red iff X's module (X.py / X/__init__.py) is absent from cwd, cwd/src,
  cwd/tests; present → broken. SyntaxError anywhere → broken (checked first).
- go: `# <pkgpath> ... undefined: Ident` / `[build failed]` / absent-package
  import → red iff every failing package dir under the module contains ONLY
  *_test.go (zero production .go) or is absent; any production .go present
  → broken.
- rust: `error[E0432] unresolved import <crate>::<rest>` / `error[E0583] file
  not found for module` / `couldn't read src/lib.rs` → red iff the referenced
  module file is absent (or lib.rs/main.rs absent for a greenfield crate);
  external-crate E0432 (leading segment ≠ package name) → broken.
MANDATORY before implementation: empirical byte-level probes per toolchain
(all locally available: pytest 8.3.5, go 1.26.3, cargo 1.95.0) capturing exact
output for the greenfield case AND the module-exists case — same methodology
as the vitest 3.2.6 probe in 0.1.43. Tests: tests/red-oracle.test.ts
tmpProj-pattern cases per language (greenfield → red; exists → broken).

**Fix 6b (GAP-E):** python runner detection also recognizes pytest in
requirements.txt / pyproject.toml dependency text and conftest.py presence;
when a python repo has NO configured runner at all, default cmds.test =
["pytest","-q"] (zero-config discovery; honest ENOENT surfaces if pytest is
truly absent rather than silent unknown).

**Fix 7 (GAP-C + B2):** language-scoped prompt wording via the s.language
mechanism (as rustDiscipline does): full-suite command enumerated per language;
test-naming guidance names all four conventions; rust RED-placement note
(top-level tests/ during RED; src unit tests during GREEN) in the profile and
TDD prompt.

**Fix 8 (GAP-F):** add uv.lock → `uv sync` to buildDependencyBootstraps.

### Validation plan (round 3 extension)

- Per-toolchain probe deliverables (exact captured output archived in the
  commit message or test fixtures) before Fix 6 detectors land.
- Post-fix property: for every language, the TDD prompt's greenfield-RED
  clause and the oracle's classification AGREE (test: greenfield fixture per
  language → classifyRedStatus = red).
- detect tests: python repo with only requirements.txt listing pytest → test
  cmd present; bare python repo → default pytest; rust/go/node unaffected.
- bootstrap test: uv.lock dir → uv sync planned.

## 8. Open questions

1. ~~Should the phantom `lines` key be cleaned from any persisted run
   artifacts?~~ **Answered (round 2):** transient — it lives only in
   `.resume-cache.jsonl`; no consumer reads `lines`. No cleanup needed.
2. ~~Does any OTHER build*Prompt control line contain a comma-bearing shape or
   an embedded period today?~~ **Answered (round 2 audit of all 21 control
   lines):** yes — every `findings [{…}]`-style review line extracts phantom
   keys today (documented in §7 Fix 1e blast-radius note; pinned by Fix 2a).
3. Retry-with-guidance guidance persistence: when the user does choose it, does
   the guidance + reauthorEvidence actually reach tdd-guide on the next pass
   (path exists in code — implementation.ts:1586 sets reauthorEvidence inside
   the retry-with-guidance branch, consumed at :1007; not yet observed in a
   real run)?
4. (New, round 2) Attempt-2's 15.5-minute hang inside `npm test | grep | head`
   is a separate implementer-runtime concern (shell pipeline buffering?). Not
   in scope for the channel fix, but worth watching — a timeout there discards
   the structured turn entirely (control=no), which is what made attempt 2
   unevidence-able.

---

## 9. Bottom line

The stagnation "recurrence" is not the no-progress detector misfiring — it is
the **challenge channel failing silently at its sensor**. The v0.1.51 loop-edge
design was correct; its input contract (the control-line prose ↔ parser pairing)
broke the moment the feature shipped, and nothing tested that pairing. The
round-2 review strengthened this from "inferred" to "proven" (the captured
control object filled the phantom key and not the real one), and found that the
obvious fix (declare the key) would itself have failed without the optionality
companion changes — the system's key-completeness enforcement punishes optional
keys unless emptiness is explicitly contracted.

Fix 1 (a–e) makes the channel physically reachable and optionality-safe;
Fix 2 keeps it that way forever; Fix 3 guarantees the human always sees the
proof even when the structured channel fails again in some novel way; Fix 4
moves the catch upstream to where it is ~30× cheaper. With 1–3, this exact run
would have converged unattended on attempt 1: GLM-5.2's airtight attempt-1
proof would have flown through the declared `testDefects` key → challenge edge
→ tdd-guide re-author with evidence — no second implementer attempt, no 20-minute
timeout, no human interruption.
