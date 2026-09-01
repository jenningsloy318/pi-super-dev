# How We Analyze — Incident Protocol

No fix starts with editing code. It starts with this protocol. Skipping steps is how the
same class came back 4 times (runner grammar) and how pipelining shipped with 4 latent
defects.

## 1. Reproduce with the engine's own machinery

Before touching code: reproduce the failure using the repo's own validators/parsers
(vite-node importing the real function, the real fixture payload from the resume cache).
"Probably" is not a root cause.

- Good: the v0.3.32 diagnosis replayed the actual failing design controls through
  `Value.Errors` and found the true failing field (`alternativesConsidered[].alternatives`)
  — the judge's hasNumericConstants theory was wrong.
- Bad: accepting the judge's diagnosis because it sounded plausible.

## 2. Build the evidence chain from artifacts, not memory

Pull the actual payloads (`.resume-cache.jsonl` before it is consumed, `run.log` lines,
`audit.jsonl`, git state in the worktree). Timestamps + code lines + payloads, or it
didn't happen.

## 3. Five Whys — with artifact checks at every step

Each "why" must be answered with an artifact (log line, code line, payload), never with
an assumption. Stop at the step where a different design/contract would have prevented
the failure — that is the root cause, not the proximate bug.

## 4. Classify the escape — why didn't our tests catch it?

Every incident gets an escape class (see taxonomy below) recorded in the defect ledger.
The escape class determines which test layer gets the new regression test.

## 5. Lift to the class — design the class-level fix

Ask: what is the full space of this failure class? Enumerate it (all drift directions,
all grammar forms, all call sites, all rejection kinds). Fix the class; pin the whole
enumeration with tests; delete any now-dead special cases.

## 6. Write the ledger entry

`docs/methodology/defect-ledger.md` (append-only): date, version, symptom, root cause,
escape class, class-level defense, live cost (minutes/tokens). Review the ledger monthly:
any class with ≥3 entries gets a standing design rule.

## Escape-class taxonomy (from this repo's history)

| Class | Meaning | Receipts (fix releases) | Defense layer |
|---|---|---|---|
| A. Idealized fixtures | fixtures use shapes models never emit | v0.3.32–0.3.39 drift coercion | L1 live-corpus replay (real payloads as fixtures) |
| B. Unenumerated grammar | external text parsed with partial grammar | v0.3.38/40/41/50/52 runner commands; v0.3.47 control keys; v0.3.46 porcelain | grammar enumeration table + per-form tests |
| C. Unenumerated concurrency | promise paths / shared-file writers not mapped | v0.3.43→0.3.51 crash, restore race, reject loop | failure-path table + join-bound tests |
| D. Implicit contracts | cross-file contracts drift silently | v0.3.47 3-way key contract; post-RED oracle missing runner (scoping) | dynamic cross-check tests; AST call-site checks |
| E. Prompt-as-enforcement | compliance assumed from instructions | v0.3.36 detach; v0.3.51 READ-ONLY violated 8× | mechanical enforcement + fail-open (P4/P5) |
| F. Environment realism | tool/machine behavior differs from assumption | v0.3.41/0.3.49 npm exec + PATH + flag order; v0.3.46 quotepath; v0.3.42 timeouts | L2/L4 real-toolchain lanes |
| G. Lifecycle/state | cache/resume/re-entry interactions across processes | v0.3.40 stale runner across phases; v0.3.48 poisoned resume rows; engine-snapshot-per-process | cross-stage lifecycle tests (L3) + resume replay tests |

## Anti-patterns (each one caused a shipped defect)

- "The fix is obvious, I'll just patch it" → instance-only fixes (P7).
- "The judge/agent said X was the cause" → unverified diagnosis (step 1).
- "I'll add the test after the fix" → the test gets written against the fix, not the
  failure; escape class never gets named.
- "It's just one more form of the same parser" → grammar by accretion (P2). The third
  occurrence means STOP and enumerate.
- "Prompt it to behave" → E-class (P4).
