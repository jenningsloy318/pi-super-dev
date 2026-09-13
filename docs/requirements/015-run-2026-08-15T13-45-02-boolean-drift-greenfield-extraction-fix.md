# Postmortem + Fix Plan — Run 2026-08-15T13-45-02-387Z: boolean control drift & greenfield extraction veto

Status: RESEARCHED — awaiting implementation (user approved research → plan → fix).
Version baseline: 0.1.71 (post d4c32c66).
Target: two commits, 0.1.72 (Fix A) and 0.1.73 (Fix B).

---

## 0. Context: what the run proved

The first production run in the repo's history to traverse the full pipeline end to
end (all 14 stage families, 2/2 phases green, 115/115 tests, real merge landed on
main as aa77509). All recent defenses worked as designed in production for the
first time: R-2 third review angle fired and Approved; R-1 triage dropped 7
`verified` findings and deferred advisories; C-5 correctly downgraded a
non-blocking "Changes Requested" to "Approved with Comments"; RED review performed
joint-satisfiability screening ("STRONG (no contradictions)"); W-1 soft deadline
fired twice and rescued one of two; the judge correctly stayed at zero calls.

Two deterministic bugs surfaced. Both are narrow, both are the kind the pipeline's
own "verify, never trust" doctrine exists to catch — and one of them defeated that
doctrine's newest layer.

---

## 1. Bug A — `merged: "true"` (string) bypassed merge verification

### 1.1 Evidence chain (production bytes)

1. The merge agent's structured output (audit.jsonl, stage `merge`) contains
   `"merged": "true"` — a STRING, not a boolean. `controlSchema` declares every
   control key as `Optional(Type.Any)`, so nothing constrains the type.
2. `mergeVerifyTask` (src/stages/writers.ts:165) opens with
   `if (!merge || merge.merged !== true) return { status: "ok" }` →
   `"true" !== true` → **Stage 14B silently skipped** (17 ms, zero log lines —
   exactly what the run log shows).
3. `workflow.ts` `mergeNotConfirmed` (~line 533) computes
   `(state.merge as { merged?: boolean }).merged !== true` → same strict
   comparison → `status = "partial"`.
4. Net effect on this run: a genuinely successful merge was reported PARTIAL, and
   the A-2 deterministic verification layer (built precisely to re-derive
   `merged` claims from git) never ran. Had the self-report been a LIE, the skip
   would have been silent too — but the `partial` status direction remains
   fail-safe (no false success).

Independent ground truth verified by hand: `aa77509` is on main; the merge agent
followed the worktree-geometry protocol exactly (commit leftovers →
`git -C <main> merge --no-ff` → self-run `is-ancestor`). The reflection's "CLEAN
SUCCESS" verdict is correct; the workflow's PARTIAL is a misreport.

### 1.2 Systematic audit — the boolean-drift family

All strict boolean comparisons on values an LLM can influence were enumerated:

| Site | Field | Producer | Schema | State |
|---|---|---|---|---|
| writers.ts:165 + workflow.ts mergeNotConfirmed | `merge.merged` | merge agent control | none (Type.Any) | **BYPASSED this run** |
| helpers.ts:67 `checkPrototypeNeeded` | `design.hasNumericConstants` | design agent control | `Type.String()` (schemas.ts:200) | **DEAD** — schema forces a string, consumer requires `=== true`, so the prototype-needed gate can never fire from this signal |
| render schemas.ts ApiTestData.pass / UiTestData.pass | `apiTest/uiTest.pass` | test agents | `Type.String()` | **C-F3 (known audit item)** — consumers are tolerant (`passTrue`), but a boolean `pass` fails `Value.Errors` → renderAndWrite returns null → the whole report doc is silently dropped |
| verify.ts passTrue consumers | `pass` | — | — | already tolerant (correct) |
| findings.blocking | review agents | — | — | already coerced (reviewFindingBlocks, R-1) |
| allGreen / pass / blocked / convergenceBlocked / worktreeCreated | pipeline code | code-set | — | safe (never LLM-typed) |

Third real-world occurrence of the drift class (v0.1.52 `lines: "808"` phantom;
R-1's `blocking` string coercions; now `merged: "true"`).

### 1.3 Research

- House precedent (doc-validators.ts:336): "Metadata gates … coerce
  string↔number↔boolean so a model returning \"13\"/\"true\" doesn't trip them" —
  `toBool` already exists and is exported (`/^(true|yes|y|1|pass)$/i`).
- Three near-duplicate implementations exist: `toBool`, `passTrue` (verify.ts:465,
  missing `y`), and the inline coercion in `reviewFindingBlocks`. Same-family
  fragmentation is how drift bugs ship.
- Online (AnySearch, 2026): industry guidance for LLM structured output treats
  "wrong booleans and nulls" as a known drift class; recommended posture is a
  permissive parse at the boundary followed by explicit normalization — stricter
  schemas (constrained decoding) reduce but do not eliminate it, and the retry
  reflex is more expensive than a salvage/normalize pass. Tolerant-read +
  normalize at trust boundaries is the correct primary defense; schema-level
  strictness is optional hardening only.

### 1.4 Fix A design

**A1 — one canonical coercion.** `toBool` (doc-validators.ts) stays the single
implementation for control-level booleans. Replace verify.ts's local `passTrue`
with `toBool` (strict superset: adds `y`). `reviewFindingBlocks` keeps its
finding-specific vocabulary (unchanged).

**A2 — merge.merged.** In `mergeVerifyTask`: read via `toBool(merge.merged)`; when
the raw value was not a boolean but normalizes truthy, log loudly
(`merge self-report merged=<raw> (string) — normalized to true`) so drift is
observable in run.log; proceed to git verification as normal. In `workflow.ts`
`mergeNotConfirmed`: same `toBool`. A truthy-string claim that git FAILS to
confirm is still rewritten to `merged:false` — the trust direction never weakens.

**A3 — checkPrototypeNeeded.** `toBool(design.hasNumericConstants)` replaces
`=== true` (un-deads the prototype gate).

**A4 — render schema unions (C-F3 for these fields).**
`DesignData.hasNumericConstants`, `ApiTestData.pass`, `UiTestData.pass` become
`Type.Union([Type.String(), Type.Boolean()])` so a boolean no longer drops the
whole rendered doc. Nunjucks interpolation renders booleans as `true`/`false`
strings — templates unchanged.

Deliberately NOT done: `Type.Boolean()` enforcement in controlSchema (structured
output contract). Rationale: the tolerant reader already fully protects both
consumers; schema strictness would add corrective-re-prompt cost on a control the
pipeline re-derives from git anyway. Documented as optional hardening.

### 1.5 Fix A tests

- `tests/merge-verify.test.ts`: string `"true"` claim → verification RUNS and
  confirms against a real worktree (log contains the normalization note);
  string `"false"` → untouched (nothing claimed); boolean `true` → unchanged
  behavior.
- `tests/workflow-status.test.ts` (or the workflow suite covering mergeNotConfirmed):
  string `"true"` + verified merge → success path not misreported partial.
- `tests/helpers.test.ts`: `checkPrototypeNeeded` with string `"true"`/`"yes"` →
  needed:true; `"false"`/boolean → prior behavior.
- render schema suite: boolean `pass` renders the api-test report doc instead of
  dropping it.

---

## 2. Bug B — greenfield RED vetoed by an existing sibling import

### 2.1 Evidence chain

RED try 1 of phase 1 wrote a textbook greenfield suite: it imports the EXISTING
`../src/schemas.ts` (landed by spec 01) and the NOT-YET-CREATED
`../src/persistence.ts`. vitest 3.2.6 fails collection with the standard
module-not-found error AND prints the importing file's source frame (lines 75–77),
which textually contains BOTH specifiers.

- `isGreenfieldModuleMissing` (gates.ts:893) calls
  `extractRelativeSpecifiers(out)` which regex-scans the WHOLE output — including
  the source frame — and collects every `./`/`../` path it sees (here: schemas.ts
  AND persistence.ts).
- The final gate `specs.every(spec => !relativeModuleExists(...))` demands ALL of
  them be absent. `schemas.ts` exists → `every` is false → not greenfield → the
  later `/failed to load|Cannot find module/i` rule classifies **broken**.
- Run log: try 1 `red-oracle: broken` → 11-minute tdd-guide re-author (try 2
  self-rescued by wrapping the import in a dynamic `loadSurfaceModule` helper so
  the suite collects and fails at runtime → classified red). The loop converged,
  but at the cost of a wasted retry and a weaker test shape (dynamic import
  indirection the agent was forced into).

Reproduced with the classifier itself using the exact production tail bytes:
`PROD-REPRO-STATUS: broken` (probe against real `runRedCheck`, worktree with
`src/schemas.ts` present, `src/persistence.ts` absent).

Why the existing suite never caught it: the synthetic greenfield fixture's output
contains only ONE specifier; no fixture has a legitimate existing sibling import
in the printed source frame — which is the NORMAL shape for any spec that builds
on top of previously landed modules (exactly the multi-spec repository pattern
this pipeline is used for).

### 2.2 Root cause, stated once

The detector extracts "specifiers mentioned anywhere in the output" but its
semantic question is "which specifier FAILED to resolve". Vitest/jest error
statements answer that question directly; source frames and surrounding text
answer a different one. The python/go/rust detectors (Fix 6) already parse
failure statements only — npm is the odd one out; this fix is design parity.

### 2.3 Fix B design

Replace `extractRelativeSpecifiers(out)` with failure-statement-only extraction
`extractFailedSpecifiers(out)` returning `{ spec, importer? }` pairs from:

1. `Cannot find module '<spec>' imported from '<importer>'` (vitest/rollup)
2. `Cannot find module '<spec>' from '<importer>'` (jest)
3. `Failed to load url <spec> (resolved id: …) in <importer>` (vite-node)
4. `Could not resolve '<spec>' from '<importer>'` (rollup)
5. absolute-path specifiers (node ERR_MODULE_NOT_FOUND `Cannot find module
   '</abs/path>' imported from …`) — existence checked directly with existsSync

Resolution + guards:

- Base directory: the importer's dirname when the importer path is absolute
  (normal case); fallback to `[cwd, ...targets.map(dirname)]` when no importer is
  captured (current behavior preserved for older fixtures).
- Greenfield requires: ≥1 failure statement naming a RELATIVE specifier; EVERY
  relative specifier named in failure statements resolves to an absent file.
- NEW guard: if any failure statement names a BARE specifier (no `./`/`../`,
  not absolute) → NOT greenfield (a dependency resolution problem stays broken).
- Existing gates unchanged: `SyntaxError` / `No test files found` / `Cannot find
  package` → not greenfield; `Failed to load config from …` produces no failure
  statement match → falls through to broken (existing contract test preserved).
- Existing-module-in-failure-statement (file present on disk) → broken —
  conservative direction identical to today.

### 2.4 Fix B tests

- PRODUCTION BYTES regression: the exact run-2026-08-15T13-45-02 try-1 tail (with
  the existing `../src/schemas.ts` sibling in the source frame) → **red**.
- Existing sibling + missing target, but the FAILURE statement names the EXISTING
  module → broken (conservative guard intact).
- jest format `Cannot find module '../src/x' from 'tests/x.test.js'` → red.
- Absolute-path ERR_MODULE_NOT_FOUND format → red.
- Bare-specifier failure (`Cannot find module 'lodash-crazy'`) → broken.
- Config-load failure (`Failed to load config from …`) → broken (existing test).
- Whole existing red-oracle suite (47 tests) green — no regression.

---

## 3. Validation & rollout

Per-commit: full `npx vitest run` with vitest's own exit code (no output pipes),
`tsc --noEmit`, version bump in `src/version.ts` + `package.json` +
`package-lock.json` (global replace — two root version fields) +
`tests/version.test.ts` in the SAME commit, per AGENTS.md and the R-5 lesson.

- Commit 1 (0.1.72): Fix A — `fix(merge): tolerate and normalize boolean control drift`
- Commit 2 (0.1.73): Fix B — `fix(red-oracle): greenfield detection from failure statements only`

## 4. Out of scope (recorded)

- research `openQuestions` empty-array optionality drift (C-F1, self-heals in
  seconds — accepted inefficiency).
- Research-stage 480 s role timeout (reflection recommends ≥720 s — a config
  decision, not a code bug; flagged to user separately).
- Schema-level `Type.Boolean()` enforcement for `merged` (optional hardening,
  see §1.4).
- `verify: skip test — service(s) not ready: api` message chain vs bringup "no
  services" (GAP-G adjacent, cosmetic, no behavior defect).
