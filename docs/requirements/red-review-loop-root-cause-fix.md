# Requirements — Fix the stuck RED→review→implement loop (root-cause)

Status: implemented (de133d19, v0.1.43)

> **Status:** Analysis & plan (not yet implemented).
> **Source of failure:** run `~/.super-dev/runs/2026-08-12T23-05-28-534Z/`
> (and the earlier `2026-08-12T12-37-45-239Z/`).
> **Affected stage:** Stage 9 — Implementation, the per-phase TDD RED oracle +
> boundary loop (`src/stages/implementation.ts`, `src/build-runner/gates.ts`).
> **Current version:** `0.1.42` → target `0.1.43`.

---

## 1. Executive summary

The implementation RED phase has been stuck in a non-converging loop across many
runs and ~40 "fix" commits. Prior fixes (oscillation detection, fail-closed
gates, RED-quality gates, monorepo scoping) **bounded** the burn or made it
**halt faster**, but never made the loop **converge**, because they tightened
strictness without resolving the underlying contradictions.

This analysis identifies **three independently-sufficient root causes** that
compound to produce the spin. Two are concrete bugs; the third is a
**contract contradiction** between the TDD prompt and the RED oracle. All three
are reproduced byte-for-byte against the actual run logs and against a live
vitest 2.1.9 project.

The plan fixes all three with surgical, test-backed changes, then aligns the
prompt to the oracle so agents stop generating the workaround that triggers the
contradiction.

---

## 2. Evidence (from run logs + live reproduction)

### Run `2026-08-12T23-05-28-534Z` — the smoking gun

The tdd-guide agent (model `glm-5.2`) wrote a correct test file
`src/persistence.test.ts` for a **greenfield** module `src/persistence.ts` and
verified it with a bare positional arg:

```
[07:48:12] → $ npx vitest run src/persistence.test.ts            # agent's OWN run
[07:48:44] RED state confirmed: the test suite fails to collect solely because
           `src/persistence.ts` does not yet exist ... (module resolution of
           `./persistence`).
```

The harness RED **oracle** then ran the same target but with a malformed argv:

```
[07:49:01] Implementation phase-01 RED test plan: ... cmd=npm exec vitest run
           "[\"src/persistence.test.ts\"]"            ← single argv element: the
                                                      literal STRING  ["src/persistence.test.ts"]
[07:49:01] ... No test files found, exiting with code 1   → status=broken
```

That **exact** malformed command recurred on try 1, try 2, and try 3. On try 3
the oscillation detector halted it ("a prior failure state recurred after 3
tries") after burning **24.3 min (1,459,706 ms)** — `0/2 phases completed`.

### Live reproductions (this investigation, vitest 2.1.9)

**Bug A — malformed target.** The argv element `["src/persistence.test.ts"]`
(a JSON-array string) reproduces `No test files found` verbatim:
```
$ npm exec vitest run '["src/persistence.test.ts"]'
filter: ["src/persistence.test.ts"]   ← vitest positional filter is SUBSTRING-INCLUSION
...                                   ← on the file PATH; no path contains  [ " ... ]
No test files found, exiting with code 1
```
Confirmed against the vitest CLI docs: positional args match by **substring
inclusion on the test file path** — so a literal `[...]` string matches nothing.

**Bug B — greenfield import classified as broken.** A correct bare-arg run of a
test that imports a not-yet-existing module produces:
```
FAIL  src/persistence.test.ts [ src/persistence.test.ts ]
Error: Failed to load url ./persistence (resolved id: ./persistence) in
      /.../src/persistence.test.ts. Does the file exist?
Test Files  1 failed (1)
      Tests  no tests
```
The current classifier (`/failed to load/i` → `broken`) calls this **broken**,
yet the TDD prompt explicitly states the opposite contract (see §4).

**Valid RED (for contrast).** With a minimal stub present (correct types,
deliberately-wrong behavior), the same command yields a genuine red:
```
Test Files  1 failed (1)     Tests  1 failed (1)   →  matches /Tests:\s+\d+\s*failed/i → RED
```

### Run `2026-08-12T12-37-45-239Z` — same orchestrator defect, second trigger

The earlier run aborted after **132.8 min** because a dependency install inside
the RED step rewrote `node_modules/`, the production-diff detector flagged every
installed file, and that diff reproduced identically every retry. Reflection
correctly concluded both runs are **the same orchestrator defect** ("retrying a
non-recoverable RED state") with two different implementer-side triggers. The
node_modules trigger has since been addressed; the **target-malformation +
greenfield-classification triggers of the later run are still open** and are the
subject of this doc.

---

## 3. First-principles + systems analysis

### 3.1 What the loop is supposed to do

Per `docs/reference/iteration-loops.md` and the TDD prompt, the per-phase RED
oracle must answer one question with observable evidence:

> *Did the tdd-guide-authored test FAIL for the intended missing behavior?*

On **red** → proceed to the implementer ("make them green").
On **unknown** → proceed without stalling (greenfield/no-runner).
On **green**/**broken** → targeted re-prompt of tdd-guide, bounded by
no-progress/oscillation detection, then hard-fail.

The convergence signal is the **deterministic oracle**, not an agent self-report.

### 3.2 The control loop as a feedback system

```
tdd-guide ──► control.testFiles ──► normalize ──► runRedCheck(oracle)
        ▲                                              │
        │ status hint + diagnostics                    ▼
        └──────────────────── classifyRedEvidence ◄── RedStatus
                              │            │
                              ▼            ▼
                  redEvidenceSignature   resolveRedBoundary
                  (oscillation guard)    (production-pollution guard)
```

For convergence, **every node in this loop must be correct and mutually
consistent**. The three bugs each break a different node, and crucially **any
one of them alone is sufficient to prevent convergence** for a greenfield module
— which is exactly why fixing them one-at-a-time (the prior pattern) never
worked.

### 3.3 Why prior attempts failed (the meta-bug)

The commit history shows a recurring pattern: each fix **added strictness or
detection** —
`RED-loop livelock — oscillation detection (RC-3)`,
`fail-closed hardening of RED test-integrity gates (R1-R5)`,
`honor non-blocking review findings`,
`make artifact ambiguity convergence budget-bounded`, etc.

These are all **symptom suppressors**: they make the loop *halt* sooner or
*block* more firmly, but none questioned whether the **strictness itself is
achievable** for a greenfield module. The RED phase simultaneously demands:

1. the test must **collect and RUN** (oracle strictness), AND
2. the test must **typecheck against the real source** (prompt contract), AND
3. RED may touch **only test files** (boundary policy).

For a module that does not exist yet, **(1)+(2) require the module to exist**,
but **(3) forbids creating it**. The three requirements are **mutually
unsatisfiable** for greenfield. Tightening any one deepens the contradiction.
The first-principles fix is to **resolve the contradiction**, not add another
detector.

---

## 4. The three root causes

### Bug A — Agent control array arrives as a JSON string; `normalizeStringArray`
wraps the whole blob as one filename  *(CRITICAL — the immediate spin)*

**Where:** `src/stages/implementation.ts:633` `normalizeStringArray`.

**Mechanism:** Models (here `glm-5.2`, but it is provider-agnostic LLM
shape-drift) sometimes serialize an array-typed control field as a JSON-encoded
string:
```json
{ "testFiles": "[\"src/persistence.test.ts\"]" }
```
The current helper:
```ts
if (typeof v === "string" && v.trim()) return [v.trim()];   // wraps the WHOLE blob
```
turns that into `["[\"src/persistence.test.ts\"]"]` — a single-element array
whose only entry is the literal string `["src/persistence.test.ts"]`. That
element flows unchanged through `runRedCheck` → `npmRedCheckPlans` →
`relTarget` → `pmExec(...)` and becomes the argv tail
`["src/persistence.test.ts"]`. Vitest's positional filter is **substring
inclusion on the path**, so this matches **no** file → `No test files found`
→ `broken`, deterministically, on **every** retry, regardless of what the agent
actually wrote.

**Why the agent's own run looked fine:** the agent ran `npx vitest run
src/persistence.test.ts` (bare) — a *different* argv — and saw a real failure.
The oracle's argv is built by the harness from the (corrupted) `testFiles`, so
the agent and the oracle disagreed.

**Proof it is the target, not the file:** in try 2 the agent created both the
stub `src/persistence.ts` **and** `src/persistence.test.ts`; the bare-arg run
gave `16/16 failed` (valid RED), but the oracle's malformed-argv run still said
`No test files found`. The file existed; only the argv was broken.

### Bug B — `classifyRedStatus` treats a greenfield "module not found" as `broken`,
contradicting the TDD prompt's own contract  *(blocks convergence after A is fixed)*

**Where:** `src/build-runner/gates.ts` `classifyRedStatus` (npm-family branch).

**Current logic:**
```ts
if (/SyntaxError/i.test(out) || /failed to load/i.test(out)
    || /No test files found/i.test(out) || /ERR_MODULE_NOT_FOUND/i.test(out)
    || /Cannot find package/i.test(out)) return "broken";
```

A test that imports a not-yet-created module emits `Failed to load url
./persistence ... Does the file exist?` → matches `/failed to load/i` →
`broken`. But the TDD prompt (`src/prompts.ts` `buildTddPrompt`) states the
**opposite** contract:

> "A RED run that compiles/collects and fails because the implementation is
> missing or behavior is not implemented yet is valid."

So the **oracle and the prompt disagree** about the textbook greenfield RED.
After Bug A is fixed, this is precisely what spins the loop: every correct
greenfield test is `broken`, the agent's only escape (a stub) is rejected by the
boundary (Bug-C path, §5), and the signatures repeat → halt.

### Bug C-residual — The greenfield escape (a minimal module stub) is rejected by
the RED boundary as production pollution  *(the oscillation partner)*

**Where:** `src/test-artifacts.ts` boundary classifier + `buildRedBoundaryPrompt`
+ `src/stages/implementation.ts:422` `resolveRedBoundary`.

Because Bug B forbids the no-stub greenfield RED, the agent reaches for the only
valid escape from the "must RUN" gate: a **minimal type-stub** of the module
under test (correct signatures, deliberately-failing behavior). In the run this
was classified `src/persistence.ts: ambiguous:deny:fallback:0.00` → `polluted-red`
→ the stub **and** the test were `git checkout`'d away, re-creating the
missing-module state → next try `broken` again → `broken ↔ polluted` oscillation.

This is a **symptom of Bug B**, not an independent gate defect: once the oracle
accepts the no-stub greenfield RED (Bug B fix), the agent no longer needs a stub,
so the boundary never sees one. §5 explains why the boundary is left strict.

### Bonus alignment — `toStringArray`/`stringArray` silently drop JSON strings

`src/prompts.ts:40` `toStringArray` and `src/test-artifacts.ts:107` `stringArray`
return `[]` for any non-array input, so a JSON-stringified `requireTests` would
silently vanish (a *different* failure: the deliverable gate then can't match).
Not the loop cause, but the same shape-drift class. Out of scope for this fix;
noted for awareness.

---

## 5. Proposed fixes

Three coordinated changes (A, B, D) make the loop **converge**; C is deliberately
left strict (with a documented residual). Each is isolated and testable.

### Fix A — `normalizeStringArray` decodes JSON-array strings (top-level and array-wrapped)

**File:** `src/stages/implementation.ts:633`.

**Change:** handle both bare JSON strings (`"[\"src/a.ts\"]"`) and array-wrapped JSON strings (`["[\"src/a.ts\"]"]`).

```ts
function normalizeStringElement(s: string): string[] {
	const trimmed = s.trim();
	if (!trimmed) return [];
	if (trimmed[0] === "[") {
		try {
			const parsed: unknown = JSON.parse(trimmed);
			if (Array.isArray(parsed)) {
				return parsed.flatMap((x) => (typeof x === "string" ? normalizeStringElement(x) : []));
			}
		} catch {
			/* not valid JSON → fall through to bare-string wrap */
		}
	}
	return [trimmed];
}

export function normalizeStringArray(v: unknown): string[] {
	if (Array.isArray(v)) {
		return v.flatMap((item) => (typeof item === "string" ? normalizeStringElement(item) : []));
	}
	if (typeof v === "string") {
		return normalizeStringElement(v);
	}
	return [];
}
```

**Backward compatibility (vs `tests/normalize-string-array.test.ts`):**
- real `string[]` → unchanged ✓
- bare path `"crates/foo/tests/bar.rs"` → doesn't start with `[` → wrapped ✓
- `"  spaced.rs  "` → trimmed, no `[` → wrapped ✓
- `""` / whitespace → `[]` ✓
- object/number/null → `[]` ✓
- NEW: `'["a.ts","b.ts"]'` → `["a.ts","b.ts"]` ✓
- NEW: `['["a.ts","b.ts"]']` (array wrapped in JSON string) → `["a.ts","b.ts"]` ✓


**Defense-in-depth (optional, recommended):** add a `normalizeTestTargets`
guard at `runRedCheck` entry that re-applies the same JSON-decode to each
target string, so a future caller that bypasses `normalizeStringArray` is still
safe. Low cost, high robustness.

### Fix B — Greenfield "module not found" is a valid RED (oracle ⇔ prompt alignment)

**File:** `src/build-runner/gates.ts` — `classifyRedStatus` (add an optional
context arg) + a new pure helper `isGreenfieldModuleMissing`; thread `plan.cwd`
from the call site in `runRedCheck`.

**Principle:** a test that fails *only* because it imports a **relative** project
module that **does not exist yet** is failing because *the implementation is
missing* — exactly the greenfield RED the prompt calls valid. A genuine
collection failure (config load, a **bare** package miss, a syntax error, an
existing module that throws at import) stays `broken`.

**npm-family classification (revised):**
```ts
if (/SyntaxError/i.test(out)) return "broken";          // test/source syntax error
if (/No test files found/i.test(out)) return "broken";  // filter matched nothing
if (/Cannot find package/i.test(out)) return "broken";  // missing external dep (bare)
if (isGreenfieldModuleMissing(out, ctx?.cwd)) return "red";   // NEW: module-under-test absent
if (/failed to load|ERR_MODULE_NOT_FOUND|Cannot find module/i.test(out)) return "broken"; // other
if (ok) return "green";
if (/❯|^✖\s+|^FAIL\s+|failing tests|AssertionError|Tests:?\s+\d+\s*failed/i.test(out)) return "red";
return "unknown";
```

**`isGreenfieldModuleMissing(combined, cwd?, targets?)` logic (pure, filesystem-aware):**
1. Gate: only proceed if the output shows a module-resolution failure
   (`Failed to load url | Cannot find module | ERR_MODULE_NOT_FOUND | Could not
   resolve | does the file exist | not found`). Otherwise `false` (→ caller's
   other branches decide).
2. If a `SyntaxError` is present → `false` (the test itself is broken).
3. Extract candidate **relative** specifiers (`./…`, `../…`) from the output.
   If **none** → `false` (a bare-package miss like `Cannot find package 'x'` has
   no relative specifier → stays broken).
4. With `cwd`: check whether ANY extracted relative specifier resolves to an
   **existing** source file relative to `cwd` or relative to the directory of any
   target in `targets`. If all candidate relative specifiers resolve to **absent**
   files → return `true` (greenfield RED). If any resolves to an existing file →
   return `false` (an existing module that failed to load → broken). Without
   `cwd`: fall back to text-only `true` (relative specifier + resolution failure
   + no syntax error ⇒ greenfield).

**Why this is safe — compatibility with `tests/red-oracle.test.ts`:**
| existing case | output | new result | OK? |
|---|---|---|---|
| SyntaxError collection failure | `SyntaxError: …` | broken | ✓ unchanged (checked first) |
| **failed to load CONFIG** | `failed to load config from /x/vitest.config.ts` | broken | ✓ no `Failed to load url`, no relative specifier → not greenfield → `/failed to load/` → broken |
| No test files found | `No test files found…` | broken | ✓ unchanged |
| `❯`/`Tests: N failed` + exit≠0 | `…Tests 1 failed…` | red | ✓ unchanged |
| exit 0 | `…passed…` | green | ✓ unchanged |
| NEW: greenfield import | `Failed to load url ./persistence … Does the file exist?` (file absent) | **red** | new behavior |
| NEW: greenfield but module EXISTS | same output but `./persistence.ts` exists | broken | conservative (a *real* load failure) |

The discriminating power comes from **(a)** the exact wording (`Failed to load
url <rel>` vs `failed to load config <abs>`) and **(b)** the filesystem check.
The two NEW rows are the added test cases.

### Fix D — Align the TDD prompt with the oracle (stop generating the Bug-C stub)

**File:** `src/prompts.ts` `buildTddPrompt` (the two "typecheck against the real
source" / "compiles/collects" lines).

**Rationale:** Bug B makes the no-stub greenfield RED valid, so the agent must be
**told** that — otherwise models keep authoring the stub workaround (the exact
behavior the run exhibited), re-triggering the Bug-C boundary rejection even
though it is no longer necessary.

**Change (text-only, no control-flow):** clarify that for a **brand-new module**,
a test that fails because its import of the not-yet-created module cannot be
resolved is a **valid RED**, and the agent must **not** create a production stub
to satisfy "must run". The existing "references a non-existent property/type
unrelated to the intended public contract is BROKEN" guarantee is preserved
(that refers to a *broken* reference against *existing* code, not the absent
module under test).

**Backward compatibility:** the `prompts-tdd-deliverable-names.test.ts` suite
asserts `requireTests` names render verbatim and the `FORBIDDEN` wording is
present — both are preserved (the edit is to adjacent guidance lines). The full
`tests/prompts*.test.ts` suite must pass; verify during implementation.

### Fix C — NOT changed (left strict), with a documented residual

The RED boundary (`classifyObviousRedPath` + agent classifier) stays strict:
RED may still touch only test/support/runtime artifacts. After A+B+D the agent
no longer needs a stub, so this never fires for the greenfield path. **Residual
risk:** an agent that ignores the Fix-D guidance and authors a stub anyway will
hit `polluted-red` once (stub reverted), then retry without it and converge via
Fix B on the next try — bounded, non-fatal, well within `MAX_RED_RETRIES` (6).
Relaxing the boundary is deliberately avoided: it is the riskiest change
(production-pollution false-negatives) and is not required for convergence. The
residual is accepted and documented.

---

## 6. Acceptance criteria

The fix is complete only when **all** hold:

1. **A — target integrity.** Given an agent control `testFiles` that arrives as
   the JSON string `'["src/persistence.test.ts"]'`, `normalizeStringArray`
   returns `["src/persistence.test.ts"]`, and the oracle's logged command is
   `… vitest run src/persistence.test.ts` (no `[`, no inner quotes).
2. **B — greenfield RED.** Given vitest output
   `Failed to load url ./persistence … Does the file exist?` where
   `./persistence` resolves to no source file, `runRedCheck` returns `"red"`.
3. **B — non-regression.** The config-load case (`failed to load config from …`)
   and `No test files found` still return `"broken"`; `SyntaxError` still
   `broken`; `Tests: N failed` still `red`.
4. **B — conservative guard.** The same greenfield output but with the module
   file present returns `"broken"` (a real load failure is never mis-read as
   greenfield).
5. **D — prompt/oracle agreement.** `buildTddPrompt` states the greenfield-RED
   rule and forbids the production stub; existing prompt assertions still pass.
6. **Loop convergence (integration).** A scripted RED-loop test where the oracle
   returns `red` on the first greenfield try proceeds to the implementer in a
   single RED attempt (no oscillation, no polluted-red).
7. **Suite green.** `npm test` (all existing suites, especially
   `red-oracle`, `implementation-red-loop`, `implementation-red-loop-edges`,
   `normalize-string-array`, `prompts*`) passes with no regressions.
8. **Version + manifest.** `src/version.ts`, `package.json`, `package-lock.json`
   all read `0.1.43` in the same commit (per `AGENTS.md`).

---

## 7. Test plan (new cases)

- `tests/normalize-string-array.test.ts` — add:
  - `'["src/persistence.test.ts"]'` → `["src/persistence.test.ts"]`
  - `'["a.ts", 42, "b.ts"]'` → `["a.ts","b.ts"]` (non-strings dropped)
  - `'[\"x\"]'` (single) → `["x"]`; malformed `'[abc'` → `["[abc"]` (falls back)
- `tests/red-oracle.test.ts` — add an npm-family block:
  - greenfield output + absent module file (real tmp dir) → `"red"`
  - same output + module file present → `"broken"`
  - config-load output still → `"broken"` (re-assert adjacent to new cases)
- (optional) integration: a focused test in
  `tests/implementation-red-loop-edges.test.ts` showing a greenfield `red`
  oracle proceeds to the implementer without a polluted-red detour.

---

## 8. Risks & mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| Fix B mis-reads a *real* load failure as greenfield | low | filesystem check requires the relative module to be **absent**; existing module → `broken` (acceptance #4). SyntaxError checked first. |
| Fix B breaks the config-load `broken` test | low | wording discriminator (`Failed to load url <rel>` vs `failed to load config`) + no-relative-specifier → not greenfield (acceptance #3). |
| Fix D weakens "typecheck" discipline, lazy RED tests slip | low | Tier-2 RED-review (code-reviewer) + scenario-coverage gate still enforce assertion strength & SCENARIO tags on the test text; those are unchanged. |
| A model still returns a non-JSON malformed string | low | optional `normalizeTestTargets` guard at `runRedCheck` entry (defense-in-depth). |
| An agent still authors a stub (Bug-C residual) | medium | bounded to one wasted retry; non-fatal; documented. Not fixing C avoids the larger regression risk. |
| Python/Rust/Go greenfield not addressed | accepted | the failing run (and the proven mechanism) is npm/TS; the principle extends but the detection differs per language — out of scope here, flagged for follow-up. |

---

## 9. Implementation checklist (single commit)

1. `src/stages/implementation.ts` — Fix A in `normalizeStringArray` (+ optional
   `normalizeTestTargets` + call in `runRedCheck`).
2. `src/build-runner/gates.ts` — Fix B: `isGreenfieldModuleMissing` helper,
   `classifyRedStatus(…, ctx?)`, thread `plan.cwd` from the `runRedCheck` loop.
3. `src/prompts.ts` — Fix D: greenfield-RED clause in `buildTddPrompt`.
4. Tests per §7.
5. `src/version.ts` `0.1.42 → 0.1.43`; align `package.json` + `package-lock.json`.
6. Add a `CHANGELOG.md` unreleased entry summarizing A/B/D.
7. `npm test` green; manual sanity: re-trace the failing run's argv through the
   fixed `normalizeStringArray` and confirm the oracle command is bare-positional.

---

## 10. Why this will work where the prior 40 fixes didn't

- It fixes **all three** loop nodes, not one — so no remaining node can keep it
  spinning (the exact failure mode of one-at-a-time patches).
- It **resolves** the greenfield strictness contradiction instead of adding
  another detector/halter (the prior meta-pattern).
- Every change is **backed by a byte-for-byte reproduction** and a **non-regression
  assertion against the existing suite**, so it cannot silently re-open a closed
  failure mode.
- It aligns the **oracle and the prompt** to a single, explicit greenfield-RED
  contract — the contradiction between them was the structural defect underneath
  every prior symptom.
