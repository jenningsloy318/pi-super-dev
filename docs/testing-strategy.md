# Testing Strategy — pi-super-dev

**Version 1.0 · 2026-08-31 · written after the v0.3.32–v0.3.45 incident wave.**

This document is the engine's testing contract. It exists because of a repeated,
measured failure pattern: **mock-based tests passed while live runs failed**.
Between 2026-08-30 and 2026-08-31, thirteen production defects shipped through a
green 3,000-test suite. Every one of them was reproducible in principle by a
test — the tests simply did not model what the engine actually faces. This
document turns each incident class into a rule, a layer, or a banned pattern.

---

## 1. Principles

1. **A test must be able to fail for the bug it pins.** If a fixture encodes
   the *ideal* shape of the world (schema-valid controls, plain commands, ASCII
   paths, instant agents), it cannot fail for the *real* shape. Before writing
   a fixture, ask: *what did the live input actually look like?*
2. **Incidents become fixtures (retrospective discipline).** Every live defect
   must leave a permanent artifact in the suite — a corpus payload, a real-repo
   test, or a log-contract pin — before the fix is considered closed. A fix
   without a regression test is an open fix.
3. **Machine independence.** The suite and the engine must produce identical
   results on any machine: no dependence on the developer's global `git`
   (`core.quotepath`), `npm`, locale, or network state. If a tool invocation is
   parsed, it is invoked through engine-controlled flags (`-z`, `-c
   core.quotepath=false`, `--`) so user config cannot change the byte shape.
4. **Mocks model behavior, never erase surface.** A mocked module must expose
   the real module's full export surface (spread `importOriginal`), overriding
   only the functions under test. Anything else breaks the moment the SUT adds
   an import (see §2, class A).
5. **Determinism is the oracle.** Exit codes, byte-exact strings, and parsed
   structures — never prose — decide pass/fail (Build-Runner Architecture).
   Tests assert the same class of evidence the engine itself gates on.

---

## 2. Failure taxonomy — what the green suite missed

Each row is a shipped defect, why the suite could not catch it, and the
structural counter-measure now in force.

| # | Class | Incident (version) | Why mocks missed it | Counter-measure |
|---|-------|--------------------|---------------------|-----------------|
| A | **Mock surface drift** | 39 tests red after `splitModelThinking` export added (v0.3.45); 13 files partial-mocked `pi-spawn.ts` | Mock factories hardcode an *assumed* export surface; the SUT's new import is `undefined` in the mock | §4.1 mock hygiene rule; all 13 files converted to `importOriginal` spread |
| B | **Idealized model output** | 7 drift classes in a row: prose in array slots, objects in string slots, nulls for "N/A", boolean words, singleton arrays (v0.3.32–0.3.39; runs pi-omisis, cosmic-clock, AnkiQuick) | Fixtures used schema-valid controls; real GLM emits prose/objects where schemas want scalars | §3 L1 live corpus; render-boundary normalization pinned per class |
| C | **Idealized toolchain invocation** | `cd dir && …` ENOENT (v0.3.38); `npm exec` swallowed `--reporter` (v0.3.41) | Runner tests invoked idealized plain commands; no test ran real `npm exec` or shell compounds | §3 L2 real-tool lane; proposals executed, not string-matched |
| D | **Cross-phase state** | phase-1 runner cache judged phase 2, false `red-not-confirmed` (v0.3.40) | No test drove the real phase loop twice with different test files and the real `test-runner.json` | §3 L3 lifecycle tests; cache files real on disk |
| E | **Machine-dependent parsing** | porcelain v1 C-quotes space paths on every machine, non-ASCII on `core.quotepath=true` machines (v0.3.45); only this dev box's global config masked it | All git fixtures used ASCII paths; suite passed *because of* the dev machine's config | §3 L4 real-git lane with `core.quotepath=true` pinned locally; engine moved to `-z` |
| F | **Instant-agent blindness** | 20-min implementer timeouts (v0.3.42), intercom detaches (v0.3.36), join infinite loop (v0.3.43) | `ctx.agent` mocks return instantly; no test models timeout classes, detach errors, or real budget interplay | §3 L5 behavioral doubles; loop-bound tests; timeout plumbing pinned per backend |
| G | **Log/audit untruthfulness** | aborted stages logged `status=ok`; fallback-derived control indistinguishable from agent output (open) | Tests assert happy-path log lines only | §3 L6 log-contract + audit-truth tests (open item, see §5) |
| H | **Config lifecycle drift** | `agentModels` snapshot-at-run vs `agentThinking` lazy-read (v0.3.44); suffix-thinking lazy while model snapshot (v0.3.45) | No test pins *when* each config key is read | §3 L6 config-lifecycle contract; documented per key |
| I | **Release mechanics** | version bump missed in 1 of 5 files, red suite after release (v0.3.32, v0.3.33) | 5 files carry the version by hand; alignment test exists but is reactive | release checklist (§4.4); single-source version is the open fix (§5) |
| K | **Multi-defect orchestration chains** | run 2026-08-31T01-47-05 + poisoned resume 02-56-26: reviewer embedded HTML markup (`<a class="card "`) in a control evidence string — unescaped inner quotes broke JSON.parse; the 22-min review was discarded; the corrective retry re-ran and its still-unparsed output was CACHED as a permanent error row; resume replayed the poisoned row instantly into an upstream-owned (owner=classify — NOT in the routable set) escalation → headless HITL → abort | (a) parse-boundary had no quote-repair class, (b) cache replay never re-tried extraction, (c) the escalation predicate treated non-routable owners as route candidates, (d) the error message ("missing control keys") misdiagnosed a parse failure | L1 corpus (first fixture: the exact payload); `repairUnescapedQuotes` in control.ts; replay-time re-extraction in resume.ts; non-routable upstream owners downgraded to carried advisory; honest unparseable-control error text |

---

## 3. Layered test model

### L0 — Pure contract tests (existing, keep)
Pure functions (`resolveThinking`, `resolveAgentModel`, `splitModelThinking`,
`runnerCoversTargets`, coercion walks). Fast, exhaustive, byte-exact. These are
necessary but demonstrably insufficient — every class-B/C/E defect shipped
*through* green L0 tests.

### L1 — Live corpus replay (new; highest value per incident)
`tests/fixtures/live-corpus/` holds **real agent payloads captured from live
runs**. A corpus test loads every file and asserts the engine's render
boundary produces either (a) a valid render, or (b) the *expected* located
errors for deliberately-invalid entries.

- **Collection SOP**: when a live run exposes a new drift class, extract the
  raw control from the run's `.resume-cache.jsonl` (or `run.log` narration)
  before the cache is consumed, drop it in the corpus with a comment naming the
  run id, and pin it. The v0.3.32–39 payloads embedded inline in
  `render.test.ts` are the seed set; new captures go to the corpus directory,
  not inline.
- **Corpus beats creativity**: any hand-invented "weird payload" is a guess;
  a captured payload is evidence.

### L2 — Real-toolchain lane (exists for runners; extend)
Tests execute the real tools through the real resolvers in temp dirs:

- `node --test` TAP suites really run (runner-discovery tests already do this);
- shell compounds (`cd X && …`), `npm exec`/`npx` flag-guard forms, suite-wide
  commands;
- **never** assert on command *strings* when the observable behavior
  (exit code, TAP stdout) is assertable.

New cases must be added when a run log shows a novel proposal shape, at the
same moment the engine learns to handle it.

### L3 — Cross-stage lifecycle tests (extend)
Stateful machinery is tested by driving the real machinery across its real
state transitions on real disk: phase 1 → phase 2 with distinct test files and
the real `test-runner.json` cache; review rounds across a real convergence
ledger; resume replay of a populated cache. Mocking at the stage boundary is
allowed; mocking the *state files* is not.

### L4 — Real-git lane (exists; is now mandatory for every porcelain consumer)
Every code path that parses `git status`/`diff` output is tested against real
temp repositories, and every test repo **pins `core.quotepath=true`** to
simulate a default machine, plus at least one fixture with: a 中文 directory,
a space-containing path, a tracked modification (` M` — the leading-space
trap), a rename record, and an untracked scratch basename. Canonical reader:
`porcelainEntries()` (`-z`, never quotes). Any new porcelain consumer uses it
instead of hand-rolling a line parser.

### L5 — Behavioral agent doubles (extend the scripted-agent pattern)
Higher-fidelity `ctx.agent` fakes that can: fail validation N times then pass,
time out (short, real timers), return infra-error strings
(`Detached for intercom coordination`), emit corpus drift, return
missing-control-key controls (exercising the delegation corrective re-prompt).
Loop bounds (retry caps, join-rejection caps, no-progress detectors) get one
test each that *would hang* without the bound — a hanging test proves the bound
exists.

### L6 — Log & config contracts (new)
- **Log contract**: the grep-stable lines operators rely on
  (`red-review-rejected`, `deterministic-phase-commit`, convergence round
  lines) are pinned byte-exact in a dedicated test file — already partially
  true; consolidate.
- **Audit truth** (open): `audit.jsonl` / `events.jsonl` must not record
  `status=ok` for stages that aborted, errored, or fell back (see §5 gap 2).
- **Config lifecycle**: one table-driven test pins, per config key, whether it
  is snapshot-at-run-start or lazy-per-dispatch, so the inconsistency cannot
  grow silently.

### L7 — On-demand E2E smoke (opt-in)
`describe.skipIf(!process.env.SUPER_DEV_E2E)`: a micro task (one phase, temp
git repo) through the full extension→engine→delegation path with real model
calls. Excluded from the default suite (cost/latency); run before releases and
whenever the delegation contract changes. This is the only layer that can see
class-F contract drift between pi, pi-subagents, and the engine.

---

## 3b. Test categories (v0.3.49 — user mandate 2026-08-31)

Tests are CATEGORIZED, both in this extension's own suite and in the target
programs super-dev develops. Categories follow the integration-scope axis
(Fowler pyramid / Testing Trophy), not file age or author.

### This extension's own suite (suffix convention — NEW files)
| Category | Suffix | Scope | Scripts |
|---|---|---|---|
| unit | `*.unit.test.ts` | pure functions, coercion walks, parsers — no spawns, no fs | `npm run test:unit` |
| contract | `*.contract.test.ts` | prompt/control/schema three-way invariants, log formats | `npm run test:contract` |
| integration | `*.integration.test.ts` | one real dependency (git repo, node toolchain) | `npm run test:integration` |
| pipeline | `*.pipeline.test.ts` | stage-level convergence loops with scripted agents | `npm run test:pipeline` |
| e2e | `*.e2e.test.ts` | full pipeline smoke, `SUPER_DEV_E2E`-gated | — |

Existing 208 files are NOT renamed (churn > value); the convention applies to
new files and migrations happen opportunistically. The coverage hard gate
(vitest.config.ts thresholds 85/80) runs on the whole suite regardless of
category.

### Target programs (the TDD pipeline's output)
The tdd-guide prompt (v0.3.49) authors RED suites as a categorized pyramid:
**unit** (pure logic, 100% aim), **integration** (wiring; only external
boundaries stubbed), **scenario** (one test per owned SCENARIO-NNN, tag
verbatim in the test name). Category-appropriate file naming is instructed
per project idiom.

The **coverage hard gate** enforces the quality floor deterministically
post-GREEN (`src/build-runner/coverage-gate.ts`):
- ≥85% lines across the phase's production files (declared ∪ claimed ∪
  required, minus test files), default `SUPER_DEV_COVERAGE_THRESHOLD`;
- measured by re-running the validated cached runner with coverage
  instrumented (vitest json-summary / `node --test
  --experimental-test-coverage` TAP / `go test -coverprofile`), suite-wide
  (file-scoped positionals stripped so coverage-retry tests are picked up);
- below floor → the implementer retries with exact per-file numbers;
  unmeasurable family → loud non-blocking ledger advisory (never silently
  green, never a dead-lock); `SUPER_DEV_NO_COVERAGE_GATE=1` disables.

Ground-truth notes: `node --test`'s TAP table reports single-line function
bodies as covered lines (V8 span attribution) — funcs% is logged alongside;
flags placed AFTER the first positional are silently ignored by node (the
gate inserts them before).

## 4. Hard conventions

### 4.1 Mock hygiene (mandatory)
```ts
// BANNED: partial factory — erases the module surface
vi.mock("../src/pi-spawn.ts", () => ({ spawnAgent: vi.fn(...) }));

// REQUIRED: spread originals, override behavior only
vi.mock("../src/pi-spawn.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/pi-spawn.ts")>();
  return { ...actual, spawnAgent: vi.fn(...) };
});
```
A PR that adds a partial factory is invalid. (All 13 offending files were
converted in v0.3.45.)

### 4.2 Realism rules
- Git: L4 rules (real repo, quotepath=true pinned, unicode/space/rename/` M`).
- Toolchain: L2 rules (execute, don't string-match).
- Model output: prefer corpus payloads over invented ones.

### 4.3 Incident closure checklist
A live incident is closed only when: root cause identified in code (not
symptom), fix landed, and a test exists that **fails on the pre-fix engine**
(re-verify once by stashing the fix if cheap).

### 4.4 Release checklist (per AGENTS.md version policy)
Bump `src/version.ts`, `package.json`, **both** `package-lock.json` version
fields (root + `packages[""]`), `tests/version.test.ts`; regenerate
`docs/ARCHITECTURE.md` **after** the bump; then run the full suite and commit
with exact pass/fail counts in hand — never gate the commit on a
`grep "Tests "` chain (v0.3.37 shipped a red test that way).

---

## 5. Gap register (prioritized, living)

| # | Gap | Risk | Status / next step |
|---|-----|------|--------------------|
| 1 | `tracking.ts` porcelain consumer parses v1 lines (space-paths get C-quoted even with `quotepath=false`); `fault-classification.ts` and `implementation.ts:298` (trackerOutofScopeEdits) also v1 + best-effort unquote | change-gate false `claimed-miss` for space/unicode paths | migrate all three to the shared `porcelainEntries()` `-z` reader; add L4 fixtures for each |
| 2 | Audit-trail truthfulness: aborted/errored stages can log `status=ok`; fallback-derived control indistinguishable from agent output | operators/judges reason over false evidence | engine fix + L6 tests; until then audit output must not gate verification (known limitation) |
| 3 | Config lifecycle inconsistency: `agentModels` model resolution snapshots at run start; `agentThinking` and the `agentModels` `:level` suffix are lazy per dispatch | mid-run config edits apply asymmetrically | decide one semantics (recommend: all-lazy) and pin with L6 table test |
| 4 | Corpus directory not yet created; seed payloads still inline in `render.test.ts` | drift-class regression coverage is real but scattered | **STARTED (v0.3.48)** — `tests/fixtures/live-corpus/` created with the cosmic-clock unescaped-quote review payload + `tests/live-corpus.test.ts` loader; migrate inline payloads incrementally |
| 5 | No L7 E2E smoke lane | delegation-contract drift invisible until a live run | add `SUPER_DEV_E2E`-gated micro-run |
| 6 | Timeout plumbing per backend asserted only at unit level | another 20-min-timeout class ships silently | L5 test driving the delegation backend with a short real timeout end-to-end |
| 7 | Version is duplicated across 5 files | red suite after releases (happened twice) | single-source `src/version.ts` consumed by scripts/tests; generate the rest |
| 8 | Coercion walks (`coerceSchemaStrings` etc.) lack property tests (idempotence, never-crash, valid-input byte-preservation) | normalization may corrupt exotic-but-valid inputs | fast-check property suite over schema×payload pairs |

---

## 6. Banned patterns

1. Partial mock factories without `importOriginal` spread (§4.1).
2. Parsing `git` output without `-z` or an engine-pinned `-c core.quotepath=false`,
   or testing such parsing only with ASCII paths.
3. Asserting tool behavior by matching command strings when executing them is
   possible.
4. Hand-invented "weird model output" fixtures where a captured payload exists.
5. Committing on a `grep`-gated test summary; committing without exact counts.
6. Timing-sensitive assertions without real timers or without pinning the
   timeout constant under test.
7. Closing a live incident without a would-fail-before regression test.

---

## 7. Health metrics

- **Escape rate**: live defects per release that no test could have caught →
  target ≤ 1 per release after L1/L4 land, 0 for repeat classes (a repeat of a
  *registered* class is a process failure, not bad luck).
- **Corpus growth**: new captured payloads per release ≥ new drift classes
  observed (nothing observed goes unpinned).
- **Suite truthfulness**: every red suite investigation must classify the
  failure as (a) real regression, (b) stale contract → update, or (c) mock
  artifact → fix the mock (class (c) should trend to zero under §4.1).
