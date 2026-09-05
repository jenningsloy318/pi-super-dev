# pi-super-dev

A **self-contained**, modular development pipeline for the [Pi coding
agent](https://github.com/earendil-works/pi-coding-agent), built on a
composable **control-flow node algebra** (branch / parallel / loop / retry /
gate / map / wait).

Runs the super-dev workflow — requirements → BDD → research → [debug] →
assessment → design → [prototype] → spec → spec-review → TDD implementation →
verification convergence → docs → cleanup → merge (git-verified) — by spawning
specialist `pi` subagents (31 role files, 24 spawned across the stages,
including a bounded **LLM judge** that routes at deadlock boundaries).
**No dependency on `@agwab/pi-workflow` or any other external workflow
engine.** Supports **node, python, go, rust, and JVM (Gradle/Maven)** projects: RED/GREEN oracles,
build gates, dependency bootstraps, and structured-evidence classification are cross-language.

The design principle throughout is **verify, never trust**: every LLM
self-report (tests pass, files written, merge done) is re-derived by
deterministic code before the pipeline believes it.

## Requirements

- **pi** (this extension runs inside a pi session).
- **pi-subagents** — a HARD requirement since v0.3.64: every specialist call
  runs through its structured-delegation executor (the same machinery as
  pi's `subagent` tool), and browser/web-research tools ride per-agent
  extension registrations. Install with `pi install npm:pi-subagents` and restart
  pi. Without it, runs fail closed with exactly this instruction.
- **Restart pi after any pi-subagents upgrade/downgrade**: a live session
  holding an older in-memory bridge against a newer on-disk package fails
  every delegated call at startup (version skew; super-dev detects it, fails
  fast with this remedy, and never hangs).

## Install

Install it from **npm** or **GitHub** (your choice):

```bash
# 1) npm — published package
pi install npm:pi-super-dev

# 2) GitHub — latest on the default branch
pi install git:github.com/jenningsloy318/pi-super-dev
#    …or pinned to a release tag:
pi install git:github.com/jenningsloy318/pi-super-dev@v0.1.2
```

Try it without installing (temporary, this run only):

```bash
pi -e npm:pi-super-dev
pi -e git:github.com/jenningsloy318/pi-super-dev
# from a local checkout:
pi -e /path/to/pi-super-dev
```

Project-scoped install (writes `.pi/settings.json` instead of user settings, so
your team shares it):

```bash
pi install -l npm:pi-super-dev
```

Requires the [Pi coding agent](https://github.com/earendil-works/pi-coding-agent).
`pi install` runs `npm install`, but this package has only `peerDependencies`
(pi bundles them), so there's nothing extra to download.

## Use

```text
# From the pi TUI:
/super-dev implement user authentication with OAuth2

# Or directly via the tool call the agent will make:
super_dev({ task: "fix the crash on large file upload" })
```

Tool options: `skipWorktree`, `skipStages`, `model`, `maxAgents`.

Super-dev runs in the foreground. Detached/background slash-command flags and
stop commands are no longer supported.

### Mid-run input

While a run is active, everything you type (except slash commands) is captured
as mid-run guidance and injected into every subsequent specialist stage. To
reach the PARENT agent instead, prefix the message with `parent:` — the prefix
is stripped and the rest is delivered as a normal parent-agent turn:

```text
parent: how far along is this run?
```

## Extension version metadata

The runtime-visible version lives in `src/version.ts` (`SUPER_DEV_EXTENSION_VERSION`)
and is mirrored in `package.json` and `package-lock.json` — all three are bumped
in the same commit as any change that touches the extension. The foreground
stream and run log print the same value (`super-dev v<version>` on line 1).

Versioning rule: every commit that changes the extension increments the patch
number. Patch values run from `1` to `99`; after `99`, increment the minor
number and reset patch to `1`. Minor values follow the same `1` to `99` rollover;
after minor `99`, increment major and reset minor/patch to `1`.

## Architecture

```
extension.ts ──► registers super_dev tool + /super-dev command,
│                escalation HITL prompts, blocker-detail surfacing
▼
workflow.ts ──► runWorkflow: budget, events, agent-call fan-out, model resolution
│               (call.model → config.agentModels[role] → global --model)
▼
stages/index.ts ──► the pipeline expressed with control nodes
│
├─ nodes.ts              control-flow algebra (below)
├─ stages/               one module per stage family
│    ├─ setup.ts, writers.ts (stages 1–8, 12–14B), design.ts, prototype.ts
│    ├─ implementation.ts     Stage 9: RED/GREEN TDD loop, challenge channel
│    ├─ verify.ts             Stage 10/11: review fan-out, fix loop, integration
│    ├─ artifact-convergence.ts  write→validate→review convergence loops (2B/2C/3/6B)
│    ├─ spec-convergence.ts   Stage 7/8 spec loop
│    ├─ judge.ts              LLM judge routing (Stages 9/10 wiring points)
│    └─ lifecycle.ts          service bring-up/teardown for integration tests
├─ build-runner/         deterministic build/test/typecheck oracle
│    ├─ detect.ts        per-language project/command detection (npm, uv/pip,
│    │                   go, cargo) + dependency bootstraps
│    ├─ gates.ts         language-blind RED/GREEN oracle engine (structured evidence only)
│    ├─ scope.ts         out-of-scope failure classification (touched files)
│    └─ baseline.ts      merge-base baseline runs (B-6 regression verification)
├─ agents/agent-runtime.ts  shared agent-execution runtime: model/thinking
│                        resolution, per-role extension packages, timeouts
├─ prompts.ts            prompt builders (control-key contracts are unit-pinned)
├─ control.ts            tolerant <control> JSON key extraction
├─ helpers.ts            12 deterministic helpers (classify, gates, routing,
│                        merge-review-verdicts triage)
├─ review-findings.ts    finding predicates (blocks/high-severity/verified)
├─ escalation.ts         bounded HITL retry ladder (2 retries per kind:stage)
├─ tracking.ts           git change-tracker (claimed-vs-actual cross-check)
├─ render/               TUI dashboard, per-stage live stream, MD report
│                        rendering, learned-memory, escalation reports
└─ agents/               31 specialist role files (+ agents/lang/{go,python,rust,backend,frontend}.md
                         — language profiles distilled from JetBrains Modern Go
                         Guidelines, Trail of Bits modern-python, and Microsoft
                         Pragmatic Rust Guidelines; Go reference vendored at
                         docs/references/go-modern-guidelines)
```

### The agent backend: pi-subagents delegation (v0.3.64 — the only one)

**pi-subagents is a hard requirement.** Every specialist call is executed by
pi-subagents' structured-delegation executor — the SAME machinery as the
`subagent` tool. Install it and restart pi before using super-dev:

```
pi install npm:pi-subagents
```

(If super-dev runs without it, every specialist call fails closed with exactly
this instruction in the error; the run never hangs.)

- Each call appears in pi's Fleet UI with real turns/tool uses/tokens/output
  logs, is live-steerable and stoppable, and is attributed to your pi session.
  The specialists register as first-class `sd-*` agents at extension
  activation (`sd-judge`, `sd-implementer`, …) with the `agents/*.md` system
  prompts and the read-only/coding tool split.
- **Browser and web-research roles load their tools via per-agent
  `extensions`** in the registration (v0.3.64): `research-agent` gets
  `pi-web-access` + `pi-mcp-adapter` (web tools + MCP gateway),
  `qa-agent`/`ui-tester` get `pi-browser-cdp-extension` (`browser_execute`).
  Verified live against pi-subagents 0.64 (spawned CLI children, `-e` args)
  and 0.65 (in-process children, explicit extension paths) on 2026-09-04 —
  the delegated child's tool list contains `web_search`, `fetch_content`,
  `browser_execute`, etc. Declaring extensions disables AMBIENT discovery for
  that child (the same isolation these roles always had).
- Text results flow through the identical `<control>` parser, so stages see
  byte-identical results — including one bounded corrective re-prompt for
  missing control keys.
- **Fail-closed infra classes (never silent, never the work's fault):**
  - *No pi-subagents owner in the process* → the run refuses with the install
    instruction (activation logs the ERROR too; v0.3.26 originally added the
    degrade, v0.3.64 makes it an honest hard requirement).
  - *Version skew* (v0.3.63, observed 0.64→0.65.0 on 2026-09-04): `pi update`
    swapping the pi-subagents package under a LIVE pi session leaves the older
    bridge in memory; its children die at startup (~5 s each) with
    `Failed to load extension "…pi-subagents…"…`. super-dev detects that
    package-scoped signature, fails the call with the remedy, and arms a
    STICKY fail-fast: later calls return the same remedy instantly instead of
    burning 5 s on the dead child. **Restart pi after any pi-subagents
    upgrade/downgrade.**
  - *Unknown agent* → the call's error names the re-register remedy (restart
    pi re-registers the roster; registrations are captured at activation —
    edit `agents/*.md` and run `/reload` or restart pi to refresh them).
- **FleetView visibility** (v0.3.25, always-on in extension mode): every
  specialist call also publishes a display-only external run in pi's Fleet UI
  (live `currentAction`, terminal state, preview) through
  `pi-subagents/external-runs`. Best-effort by contract: a missing registry
  or registry error is a silent no-op.
  **Viewing notes** (v0.3.27): records are registered with the session FILE
  path (`getSessionFile() ?? getSessionId()`), mirroring pi-subagents' own
  fleet filter. Open the Fleet view (`Ctrl+Alt+F`) **in the pi session that
  started the run** — foreground state is per-process. Each call is a real
  foreground subagent run (full turns/tools/tokens, live transcript under
  `<session-dir>/subagent-artifacts/`); the "Async Result" panel lists only
  async runs and never shows these.

**History**: v0.2.10–v0.3.x shipped three backends (session = in-process SDK
sessions, subprocess = isolated `pi` CLI children, pi-subagents = this one).
v0.3.64 deleted the first two — their shared utilities moved to
`src/agents/agent-runtime.ts`, and the session executor survives verbatim ONLY
as the standalone convergence bench harness (`src/bench/session-agent.ts`, dev
tooling never used by the pipeline). The `agentBackend` config key,
`SUPER_DEV_BACKEND` env, and the tool's `backend` parameter are gone (the
parameter is still accepted but ignored for legacy callers). The end-of-run
reflection agent also delegates (visible in Fleet); without an event bus
(bench/tests) reflection skips with a named audit row instead of silently
doing nothing.

**Full-field progress parity (v0.3.28)**: run.log reads uniformly. Tool lines
`label: → tool args…`, narration lines `label: ⇢ <text>`, and a terminal
summary per call — `delegation <label>: completed status=completed model=…
turns=N tools=N tokens=in/out cache=r/w $cost duration=Xs` — aggregated from
the delegation terminal response's `usage`.

Role timeouts: 480 s default, 1200 s for code-writing roles (`implementer`,
`tdd-guide`) whose deliverable is real edits to large files.

### Control-flow node algebra (`src/nodes.ts`)

| Node                              | Purpose                                                            |
|-----------------------------------|--------------------------------------------------------------------|
| `task(stage)`                     | Leaf — runs a `Stage`, stores return value at `state[stage.id]`    |
| `sequence([...], {tolerant?})`    | Ordered composition — fail-fast by default, tolerant continues     |
| `branch(pred, {yes, no?})`        | Conditional — take one path or skip                                |
| `choose([{when, run}, ...])`      | Multi-way switch — first matching case                             |
| `parallel([...], {into?, join?})` | Fork-join — run branches concurrently, merge results               |
| `loop({while?, until?, times?})`  | Iterate a body until a condition holds                             |
| `retry({attempts, backoff?})`     | Re-run a node on failure (AWS Step Functions "Retry" semantics)    |
| `gate({validate, attempts})`      | Write → validate → re-write (quality-gate loop for LLM outputs)    |
| `map({over, as, concurrency?})`   | Fan out a body over a collection                                   |
| `wait(ms)`                        | Time synchronization                                               |
| `tryCatch(body, {catch, finally})`| Error boundary (catches thrown fatal-task errors)                  |
| `noop()`                          | Identity                                                           |

Grounded in [AWS Step Functions ASL](https://states-language.net/), the [Workflow Control Patterns](http://workflowpatterns.com/) taxonomy (van der Aalst), Temporal workflows, and LangGraph.

### The pipeline (`src/stages/index.ts`)

```ts
sequence([
  task(setupStage),                          // Stage 1  worktree, spec dir, bootstraps
  task(classifyStage),                       // Stage 2A task type / language routing
  requirementsConvergenceNode,               // Stage 2B write → review → fix loop
  bddConvergenceNode,                        // Stage 2C AC-coverage scenario loop
  researchConvergenceNode,                   // Stage 3  online ambiguity loop
  branch(isBug, { yes: task(debugWriter) }), // Stage 4  bug fixes only
  task(assessmentWriter),                    // Stage 5  code assessment
  designConvergenceNode,                     // Stage 6A/6B design → review loop
  task(prototypeStage),                      // Stage 6C prototype (when needed)
  specConvergenceNode,                       // Stage 7/8 spec → trace gate → review
  loop(                                      // Stage 9  per-phase TDD until allGreen
    { while: (s,c) => !implAllGreen(s) && !implConvergenceBlocked(s) && c.budget.check() },
    task(implementationStage)),
  branch(hasImplementation,                  // Stage 10 review/build/integration
    { yes: verificationConvergenceNode }),   //         convergence (restarts at review
                                             //         after every fix)
  branch(hasVerifiedImplementation, {
    yes: sequence([
      task(docsWriter),                      // Stage 12 source-read-only close-out
      task(preMergeBuildStage),              //         hard build gate before cleanup
      task(cleanupTask),                     // Stage 13 dependency cleanup + scan
      branch(canMerge, { yes: sequence([     // Stage 14 merge (LLM performs it…)
        task(mergeWriter),
        task(mergeVerifyTask),               // Stage 14B …git deterministically verifies)
      ]) }),
    ]),
  }),
], { tolerant: true })
```

The runner (`workflow.ts`) never changes. Compose your own pipeline by
importing the node builders and stages — see the exports at the bottom of
`src/stages/index.ts`.

## The trust model: deterministic verification layers

Every claim an LLM makes is re-derived by code. The layers, in pipeline order:

**Phase-green triple gate (Stage 9).** A phase is GREEN only when

```
(gate.pass || gate.inScopePass) && deliverableCheck.pass && changeGate.pass
```

`deliverableCheck` asserts spec-declared files/symbols exist
(`requireFiles`, `requireExports`, `requireTests`, `requireScenarios`). The
**git change-tracker** (`src/tracking.ts`) brackets every stage and phase with
a git snapshot into an append-only `<specDir>/change-tracker.jsonl` and
cross-checks the implementer's claimed `{filesCreated, filesModified,
filesDeleted}` against git reality: **claimed-but-unchanged hard-fails** (fed
back as `## Claimed changes not present in git`), git-edits-under-reported
stays advisory. Never throws; degrades to pass when git is unavailable.

**RED/GREEN TDD oracle (Stage 9, cross-language).** The RED check runs the
scoped test command from the conventions table and classifies STRICTLY from
structured evidence (JUnit XML / TAP / go-test-JSON / declared count lines)
plus the exit code: red / green / broken / unknown — console prose never
classifies (the Bazel principle; see *Universal test verification* below). A
greenfield suite whose tests cannot even compile is honestly `unknown` and
routes through the judge's `allow-scaffold` escape instead of a regex
shortcut. The RED boundary classifier (`red-boundary-classifier`) rejects
production-file edits during RED.

**RED review with joint-satisfiability screening (Stage 9).** A Tier-2
reviewer (`code-reviewer`) judges the RED suite for behavior-binding
assertions, tautologies, and scenario coverage — and must additionally check
that **at least one conforming implementation could pass ALL tests
simultaneously**, reporting `contradictions[]` with an impossibility proof
(`[]` = none, never omitted). Named contradictions override even a STRONG
verdict and route back to tdd-guide with the proof inlined — closing the
"unsatisfiable RED suite accepted as strong, implementer doomed" failure
class.

**testDefects challenge channel (Stage 9).** When the implementer *proves* a
confirmed RED test is unsatisfiable (internal contradiction), it reports
structured `testDefects {testFile, lines, reason}` (always emitted, `[]` when
none). The stage then drops `acceptedRed` and re-runs tdd-guide *with the
implementer's diagnosis* — bounded by `SUPER_DEV_MAX_CHALLENGE_REAUTHORS`
(default 2) — instead of blind re-authoring the same contradiction.

**Stage 10 review fan-out + deterministic triage.** Three parallel reviewers
(code, adversarial, and — when the spec declares test deliverables —
tests/coverage, reusing the `code-reviewer` role) feed
`merge-review-verdicts`, which triages every finding deterministically:

- `fixNow` (drives the fix loop): open AND (blocking OR high/critical)
- `deferredFindings` ledger (logged, surfaced at escalation/docs, never fed
  back into reviewer prompts): advisory items, needs-human, cross-stage
  ownerStage findings, explicit reviewer deferrals
- dropped: `verified`/`resolved` confirmations of already-fixed priors

Reviewers follow **evidence discipline** (`agents/code-reviewer.md`): every
finding cites file:line evidence, locations are checked before citing,
blocking=true only when it must stop the merge, and "everything looks good" is
said plainly. Post-merge, a finding citing a `file` that does not exist in the
worktree is demoted to the ledger (R-5) — the fixer never hunts fabricated
paths. Verdict normalization keeps a **Changes Requested** verdict pinned when
open high-severity findings exist (no silent downgrade to "Approved with
Comments") — and the adversarial reviewer's literal `PASS` verdict passes
through the same guard, never a silent approval past a blocking finding.

**Out-of-scope regression baseline (Stage 9/10 gates).** Pre-existing failures
in *untouched* test files would historically be excused wholesale. Now, when
out-of-scope failures are the only failures, the gate re-runs those failing
subjects in a temp detached worktree at the **merge-base** of the default
branch: subjects that **pass at the baseline** prove the failure is NEW on
this branch → inScopePass flips to false with a `[baseline-verify] regression`
error block. Cached per (repo, merge-base); never throws;
`SUPER_DEV_DISABLE_BASELINE_CHECK=1` escapes. Ambiguous outcomes degrade to
the historical lenient pass.

**Fault-classified actuation + reused-worktree hygiene (Stage 9/Stage 1).** On
every build-gate failure a deterministic classifier (pure TypeScript, no LLM,
`src/fault-classification.ts`) runs before actuator selection: out-of-scope-only
failures + a regression verdict + green own-scope evidence ⇒
`environmental-blocker`, which never re-spawns the implementer. Foreign
uncommitted state (git actual outside the implementer's claimed files ∪ declared
scope ∪ harness bookkeeping) is quarantined via a scoped `git stash push -u`
(recoverable with `git stash pop`, recorded as one JSON line in
`<specDir>/.environment-faults.jsonl`), the gate re-runs exactly once with the
baseline memo cleared, and a still-blocked phase routes to the judge
(`fix-environment`) at first occurrence. The same quarantine runs at setup on
re-entered (reused/resumed) tracks so prior runs' dirt cannot poison this run's
gates; fresh tracks and the main checkout are never touched. Kill switch
`SUPER_DEV_NO_DIRTY_QUARANTINE=1`. Failure-signature comparison also strips
volatile noise (timestamps, UUIDs, durations, `(cached)` markers) before the
800-char cap, so identical failures trip the no-progress detector instead of
hashing differently every attempt.

**Convergence round caps.** All artifact-convergence loops (requirements, BDD,
research, design) and the spec loop run under `MAX_CONVERGENCE_ROUNDS = 8` —
a liveness floor that FatalAborts exactly like budget exhaustion, one round
before which the judge may diagnose (below).

**Agent-error rounds never masquerade as verdicts (v0.3.65).** A writer or
reviewer AGENT error (delegation failure, version-skew extension crash,
missing model) records a G21 `cause:"agent-error"` row and is labeled honestly
(`✗ review agent errored round N (k/3 consecutive)`) — never counted as a
"review rejected" verdict or masked behind validation messages. Two transient
rounds retry (G21's original tolerance); the third consecutive FRESH round
FatalAborts with the infra error named (`… infra failure, not an artifact
defect (last error: …)`), so a dead runtime burns 3 fast rounds instead of
spinning the full cap (incident 2026-09-04T13-45-10 burned 16 of 18 design
rounds as fake rejections). Non-retryable environment errors
(`isNonRetryableAgentError`) abort immediately; replayed resume rounds never
count, so a fixed runtime recovers.

**Already-satisfied is reachable for every contract shape (v0.3.66).** The RED
loop's already-satisfied escape now evaluates every deliverable-contract clause
kind (`requireFiles`, `requireContains`, `requireNotContains`, `requireScenarios`)
and re-checks the contract LIVE at oracle time when the RED oracle is green but
the attempt-entry baseline was false. Previously a contract without
`requireFiles` (contains/scenarios-only — incident 2026-09-04T14-45-04-784Z
phase 5, whose entire contract was verifiably satisfied on disk by sibling
commits) could NEVER classify `green-already-satisfied`: every green oracle was
misrouted to `red-not-confirmed` retries → RED cleanup erased the authored
test-file deliverables → re-entry recomputed the same false baseline — 16 spins,
~3.5h, one no-progress escalation on a satisfiable phase. Classification order
is unchanged: `polluted-red` still wins first, so a RED-phase production edit
cannot masquerade as satisfied, and the Already-satisfied verification node
re-runs the build gate + deliverable check deterministically before accepting.
The resume no-op fast path inherits the same clause coverage.

**No-op completions, honest unknown reasons, and REPLAN wind-down (v0.3.67).**
Three coupled classes from the same incident's second half: (1) pi-subagents'
child-acceptance layer rejects an implementation-intent child that completes
WITHOUT file edits — correct enforcement (self-report is never evidence), but in
an already-satisfied phase a verification-only completion is the RIGHT outcome;
the rejection now routes through the deterministic live deliverable re-check →
Already-satisfied verification (machine decides, fail-closed otherwise) instead
of looping `red-unverified` (21 rejected tdd calls burned hours). (2) When the
RED oracle is unknown because the AGENT died or was no-edit-rejected, the retry
reason/hint now LEAD with that true cause — the old canned "no supported test
runner was available" asserted a false environment defect that sent agents
re-verifying runners and judges reading harness source. (3) A REPLAN round
routed mid-run now WINDS THE PASS DOWN: remaining phases are deferred (named
log), the §D loop stops re-attempting, and Stage 10 skips with a named notice —
no more executing a superseded spec for hours before the restart (research
basis: Fox et al. ICAPS-06 plan stability; Nav2 replan-immediately-on-
invalidation; CI cancel-in-progress).

**Merge verification (Stage 14B).** The merge agent *performs* the merge
(instructed to merge from the main checkout — inside a linked worktree it
structurally cannot advance the checked-out default branch), but the run only
*claims* `merged: true` after a deterministic git check re-derives it
(`git merge-base --is-ancestor` of feature head in default head; reported
commit SHA exists). Unverified claims are rewritten to `merged: false` with
concrete reasons; the run reports `partial`, never success.

**Sensitive-file scan (Stage 13).** Cleanup scans only **git-carried** files
(diff vs the default-branch merge-base plus staged/unstaged tracked diffs) for
secrets patterns — untracked files (including pipeline-copied `.env`) never
block. A blocked merge yields an honest `partial` status with the reason, not
a silent success.

## The LLM judge routing layer (`src/stages/judge.ts`)

Deterministic loops are safe but inflexible: an unanticipated state can only
repeat the same doomed action. The judge adds bounded LLM judgment at the
deadlock boundaries **without** weakening any guarantee:

- **Closed route set** — the judge can route to `re-author-tests`,
  `challenge-test`, `fix-environment`, `continue`, or `escalate-now`. It can
  **never** grant pass/green or extend a cap. Diagnosis-only points
  (escalate-now) explain *why* a loop stopped.
- **Byte-verified evidence** — every verdict must cite 1–5 `{file, quote}`
  items whose 8–200 char quotes must byte-occur in the cited worktree file or
  the supplied oracle/agent output tail. Failed verification discards the
  verdict to `escalate-now`, never to a permissive route. Route is honored
  only at confidence ≥ 0.6.
- **Wiring points** — J9-a: RED no-progress (re-author-tests /
  fix-environment with the diagnosis, else escalate). J9-b: implementer
  no-progress pre-HITL (challenge-test synthesizes a structured defect through
  the existing channel; continue threads one-shot guidance). J10-a/J10-b:
  stagnation / no-actionable breaks carry a verified diagnosis as the leading
  escalation finding ("why", not just "what"). J10-c: one round before the
  convergence cap, the judge may abort early with a diagnosis.
- **Budgets & audit** — max 2 calls per failure signature, 12 per run
  (`SUPER_DEV_MAX_JUDGE_CALLS`); every call appends `.judge.jsonl` in the spec
  dir and logs to run.log. Kill switch `SUPER_DEV_DISABLE_JUDGE=1`; judge
  infra failure degrades silently to today's behavior (INV-6).

## Liveness: how every loop terminates

| Loop | Bounds |
|---|---|
| Stage 2B/2C/3/6B/7 convergence | budget + 8-round cap + stall escalation (≤2 retries per `kind:stage`) |
| Stage 9 RED retries | `SUPER_DEV_MAX_RED_RETRIES` (default 6) + no-progress + oscillation detection |
| Stage 9 challenge re-authors | default 2 (`SUPER_DEV_MAX_CHALLENGE_REAUTHORS`) |
| Stage 9/10 per-attempt fix loops | budget + recurring-signature no-progress (any earlier attempt) |
| Stage 10 review loop | approval (verdict AND build green) + stagnation (identical non-empty findings signature) + **dead-state breaks**: no actionable findings with a green gate (or absent gate after one full round) breaks for HITL |
| Global agent budget | `maxAgents` (default per run options) |
| Global cost/token fuse | `SUPER_DEV_MAX_RUN_COST` / `SUPER_DEV_MAX_RUN_TOKENS` — per-call fail-closed (v0.3.68; see below) |

The escalation ladder is three layers: **Layer 0** deterministic fast paths
and gates → **Layer 1** the judge (above) → **Layer 2** HITL (`escalation:
"interactive"` in config prompts with the full blocker message, stage/kind/
severity, findings, and any judge diagnosis; headless runs degrade to
informative reports — `stagnation-report.md` / `escalation-report.md` in the
spec dir).

**Auto-route (v0.3.19, default ON):** when a convergence blocker's own analysis
already resolves to exactly ONE routable strictly-upstream owner (e.g. a BDD
review finding `owner=requirements`) and the per-edge jump budget allows it,
the loop routes back DIRECTLY — no human round-trip. The decision is recorded
as `route-back-auto` in the escalation report for audit. Ambiguous shapes
(multiple owners, non-routable owner, exhausted edge budget) still escalate to
HITL, and `SUPER_DEV_NO_AUTO_ROUTEBACK=1` restores the human prompt for the
single-owner shape too. Auto-routing composes with the inline route-back caps
(`SUPER_DEV_MAX_INLINE_JUMPS`, per-edge journal budgets), so it can never loop
unbounded.

**Universal test verification (v0.3.30, rewritten v0.3.31 — zero per-language
oracle code).** Deep research (Bazel test encyclopedia, SWE-Factory FSE'26,
gotestsum, cargo-nextest/pytest/vitest docs) validated the design: *exit code
is the only authoritative gate; console prose never classifies* (Bazel:
"writing any of the strings PASS or FAIL to stdout has no significance");
per-test detail comes from structured channels the runner itself can emit.
Three levels:

1. **Structured classification — the ONLY status decision.** `runRedCheck`
   collects evidence per the runner's declared channel: fresh JUnit XML from
   conventional result dirs or an explicit harness-owned temp path (`--junitxml=`),
   TAP on stdout (`node --test --test-reporter=tap`, `vitest --reporter=tap`),
   `go test -json` events, or a declared count-line pattern (vitest/jest
   summaries, cargo's `test result: …` lines — parser-as-data). Counts decide:
   tests>0 with failures/errors → red, clean+exit 0 → green, zero tests+
   failing exit → broken. **No structured evidence → `unknown`, always** — a
   failing exit cannot be told red from broken without per-test evidence, and
   a passing exit cannot be told green from a scope miss. The old per-language
   regex chains and greenfield predicates are deleted.
2. **Conventions as data — the single per-ecosystem seam**
   (`src/build-runner/conventions.ts`): rows declare manifest anchors, target
   transforms (npm owning-package + RC-1 recursive-script guard, go package
   dirs, cargo integration stems, JVM `--tests <FQN>`/`-Dtest=<FQN>` per class,
   android `testDebugUnitTest`) and each row's structured channel. The engine
   (`gates.ts runRedCheck`) is language-blind; adding or fixing a stack means
   editing convention data, never engine code.
3. **Agent-proposed runners for unknown stacks ("LLM proposes, machine
   verifies, cache reuses")** — when no convention matches, ONE
   `runner-discovery` call proposes a command under a mandatory structured-
   evidence contract (JUnit XML / TAP / go-JSON); the harness EXECUTES the
   proposal and machine-verifies parseable evidence, then caches the validated
   spec (`test-runner.json`) for every later oracle run. The LLM never decides
   pass/fail.

Related honesty fixes shipped with it: `unknown` oracle evidence keeps its own
`red-unverified` reason/hint (no more "tests did not compile/collect" lies),
judge `fix-environment` restarts are capped (`SUPER_DEV_MAX_RED_ENV_RESTARTS`,
default 1) and terminate as `environment-blocked` beyond that, and `.judge.jsonl`
no longer pollutes the RED boundary. A greenfield compile failure (tests
reference symbols that do not exist yet) is now honestly `unknown` — the
fail-closed loop routes it to the judge's `allow-scaffold` / `fix-environment`
routes instead of a regex shortcut blessing a phantom RED.

**Owner-aware convergence + converged-carried exits (v0.3.24):** a route-back
jump adds a BACK edge to the stage graph, and a re-entered loop can be handed
blocking findings owned by a stage DOWNSTREAM of it — work that loop
structurally cannot perform (a wait-for-graph cycle). The verdict gates in
both convergence loops are therefore owner-aware: blocking findings owned by
the current stage or upstream pin the verdict exactly as before, while
downstream-owned blockers are **carried debt** — they stay open in
`.convergence-ledger.json`, do not keep the current loop open, and are
**delivered deterministically**: pending replan requests + a revision bump
for the owner (when routable) defeat the revision-gate fast-forward and
re-inject at the owner's round 1; non-routable owners keep the ledger rows,
which inject into every subsequent agent prompt (disclosed in the log).
When a review rejects but every remaining blocker is downstream-owned, the
loop exits **CONVERGED-CARRIED** (logged) and the walk continues to the owner.
Findings with a missing/unknown owner label normalize to the current stage
(conservative — no laundering a blocker out of a loop by inventing an owner).
Route-back re-entries also reset the round budget to segment scope (the jump
budget bounds cycles), and the judge's escalate-now evidence gate accepts any
non-empty evidence field, not only verbatim quotes. In Stage 9, the RED
boundary evaluator's path matching is suffix-tolerant (absolute-path echoes
land), the RED evidence signature excludes harness bookkeeping so oscillation
detection actually fires, RED cleanup never `git clean`s harness files, and
the post-cap judge floor keeps both late recovery routes
(`fix-environment` + `allow-scaffold`).

## Usage governance & run metrics (v0.3.68)

Multi-agent runs spend ~15× a chat session's tokens (Anthropic's production
figure), so usage is a first-class governance surface, not a log decoration:

- **Accounting**: every delegated call's terminal usage block (turns, tool
  calls, input/output/cache tokens, cost, duration) is threaded from the
  pi-subagents response into the run-scoped accumulator (`ctx.usage` — totals
  + per-agent `sd-*` split) and lands in the **RunSummary `usage` block**.
  Absent usage is never fabricated (P10).
- **Fuses (fail-closed, 方案 A)**: `SUPER_DEV_MAX_RUN_COST` (USD) and
  `SUPER_DEV_MAX_RUN_TOKENS` (input+output) are checked BEFORE each call
  launches. The call that lands at/over the cap still completes and is counted
  honestly — the NEXT call fails closed naming the fuse and the spent/limit
  numbers. Tripped-fuse rows are `cause:"agent-error"` rows, so the v0.3.65
  machinery winds the run down deterministically (FatalAbort after 3
  consecutive) with zero further agent spend while close-out (summary, audit,
  metrics) still runs — resume-safe (raise or unset the fuse, resume).
- **Harvest (`run-metrics.jsonl`)**: at run end ONE deterministic JSON row per
  run lands in `<specDir>/run-metrics.jsonl` (status, agentsSpawned, wallMs,
  stage-status histogram, `agentErrorRounds`, `fatalAborts`, usage totals,
  timestamp). Best-effort observability: never throws, never gates. This is
  the closing-the-loop feed the σ-band monitor (v0.3.69) reads instead of
  hand-mining multi-thousand-line prose run logs.

## Configuration

Super-dev stores user-level runtime data under `~/.super-dev/`:

- `config.json` (below)
- `runs/<timestamp>/run.log` + `audit.jsonl` + `reflection.md`
- `learned.md`, `learned-index.json`, `stats.json` (cross-run learned memory)
- `traces/`

`config.json` fields (defaults shown; `env` and `agentModels` are the commonly
set keys — see the next two sections):

```json
{
	"reflectionEnabled": true,
	"topNPreload": 3,
	"indexListSize": 10,
	"maxLearnedEntries": 200,
	"minScoreToKeep": 3,
	"archiveAfterDays": 90,
	"runRetentionDays": 30,
	"traceRetentionDays": 7,
	"escalation": "informative",
	"language": "english",
	"agentModels": { "...": "..." },
	"agentThinking": { "...": "..." },
	"env": { "SUPER_DEV_...": "..." }
}
```

`escalation`: `"informative"` (default — non-blocking diagnostics in the run
summary; headless-safe) or `"interactive"` (additionally prompt a 3-option
select when stagnation fires in TUI/RPC mode).

`agentThinking`: per-agent thinking-level overrides (v0.3.44). Keys are agent
role names (`"implementer"`, `"tdd-guide"`, `"code-reviewer"`, ...); values
are one of `"off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"`.
A configured level beats the built-in role tier but stays below
`SUPER_DEV_THINKING` (global kill-switch) and per-call overrides. Invalid
values are ignored. Read lazily per agent dispatch, so a config edit applies
to later agent calls even mid-run. Example — run a hard codebase's implementer
at `high` while keeping everything else on its default tier:

```json
"agentThinking": { "implementer": "high", "requirements-clarifier": "low" }
```

`agentModels` entries may also carry a `:level` thinking suffix (v0.3.45) —
set the model and its thinking together: `"implementer":
"zai-coding-cn/glm-5.3:high"`. The suffix is stripped before the model id is
used (all backends receive the bare id) and applied at the same config tier:
it beats the built-in role tier, but a dedicated `agentThinking` entry wins
when both are set, and `SUPER_DEV_THINKING` / per-call overrides still beat
both. A colon suffix that is not a valid level word (`provider/model:latest`)
is left intact.

`language`: the natural language **every agent-written artifact** is produced
in — spec docs, reports, escalation/stagnation reports, `learned.md` /
`reflection.md` history, audit/ledger text, and commit messages — regardless
of the language of the task or repository (default `"english"`; any string,
normalized to trimmed lowercase). A one-off run can override it with
`SUPER_DEV_LANGUAGE` (env or the `env` map), which beats the config key.
Use it when your task text is not English but you want English artifacts:
no more UTF-8/Chinese-character output to decode.

Build-gate tuning (full table in the next section): `SUPER_DEV_BUILD_TIMEOUT_MS`
raises the per-command build-gate timeout (default `600000`), and
`SUPER_DEV_BUILD_TEST_PACKAGES` scopes cargo build/test/clippy to named crates
(`""` = force workspace-wide). Rust-workspace example:

```bash
export SUPER_DEV_BUILD_TIMEOUT_MS=900000
export SUPER_DEV_BUILD_TEST_PACKAGES="api,store"
cargo test -p api -p store
```

### Environment variables (`env` map)

Every user-facing `SUPER_DEV_*` tunable — timeouts, budgets, kill-switches,
model/backend selectors — is also settable **persistently in `config.json`**
under the `env` map, for launches that have no shell environment (GUI-launched
pi sessions):

```json
{
	"env": {
		"SUPER_DEV_JUDGE_TIMEOUT_MS": "240000",
		"SUPER_DEV_MAX_REPLAN_ROUNDS": "3"
	}
}
```

Precedence per key: `process.env` (non-empty) > `config.json` `env` map
(non-empty string) > built-in default — so a one-off shell override always
beats the persistent file. An empty-string `process.env` value is treated as
unset (it cannot mask a configured value). Exception: the build gate's
`SUPER_DEV_BUILD_TEST_PACKAGES=""` escape hatch ("set-but-empty = force
workspace-wide, skip auto-detect") still consults the raw env var. Excluded
from the map: `SUPER_DEV_DIR` (bootstrap) and subprocess IPC / release-tooling
plumbing variables. Values are read lazily per call; a config edit mid-run is
observed by later lookups (mtime-cached).

All keys, defaults, and purposes:

| Variable | Default | Purpose |
|---|---|---|
| `SUPER_DEV_MODEL` | — | global model override (per-role `agentModels` wins) |
| `SUPER_DEV_LANGUAGE` | `english` | output language for every agent-written artifact (beats `config.json` `language`) |
| `SUPER_DEV_THINKING` | — | per-agent thinking level override (beats role tiers and inheritance) |
| `SUPER_DEV_MAX_RED_RETRIES` | `6` | Stage 9 RED generation retry cap |
| `SUPER_DEV_MAX_RED_JUDGE_ROUTES` | `3` | routed judge interventions per phase before only `fix-environment` remains |
| `SUPER_DEV_MAX_CHALLENGE_REAUTHORS` | `2` | implementer-driven RED re-author cap |
| `SUPER_DEV_MAX_JUDGE_CALLS` | `12` | judge calls per run (2 per signature) |
| `SUPER_DEV_MAX_RUN_COST` | — | run-wide cost fuse in USD (fail-closed pre-call; see Usage governance) |
| `SUPER_DEV_MAX_RUN_TOKENS` | — | run-wide token fuse, input+output (fail-closed pre-call; see Usage governance) |
| `SUPER_DEV_JUDGE_TIMEOUT_MS` | `480000` | judge wall-clock budget per call (retry-on-timeout consumes the 2nd signature slot) |
| `SUPER_DEV_DISABLE_JUDGE` | — | `1` = kill switch, judge degrades instantly |
| `SUPER_DEV_DISABLE_BASELINE_CHECK` | — | `1` = skip merge-base regression verification |
| `SUPER_DEV_SKIP_DEP_BOOTSTRAP` | — | `1` = skip dependency bootstraps in build-gate command discovery |
| `SUPER_DEV_NO_BOOTSTRAP` | — | `1` = skip the setup-time dependency bootstrap (npm ci etc.) in fresh worktrees |
| `SUPER_DEV_COVERAGE_THRESHOLD` | `85` | line-coverage hard floor (%) for the TARGET program's phase production files, measured post-GREEN from the validated runner (v0.3.49) |
| `SUPER_DEV_NO_COVERAGE_GATE` | — | `1` = skip the target-program coverage hard gate entirely |
| `SUPER_DEV_NO_WATCHDOG` | — | `1` = disable the external delegation watchdog (detached watcher that records a frozen host loop; v0.3.57) |
| `SUPER_DEV_BOOTSTRAP_TIMEOUT_MS` | `600000` | setup dependency-bootstrap timeout |
| `SUPER_DEV_NO_DIRTY_QUARANTINE` | — | `1` = kill switch, disable automatic foreign-dirt quarantine (setup reuse + Stage 9 env-blocker) |
| `SUPER_DEV_MAX_REPLAN_ROUNDS` | `2` | replan auto-resume rounds per spec |
| `SUPER_DEV_REPLAN_MANUAL` | — | `1` = keep single runs (disable replan auto-resume) |
| `SUPER_DEV_DISABLE_REPLAN_LEAD` | — | `1` = skip the replan-lead enrichment agent |
| `SUPER_DEV_NO_INLINE_ROUTEBACK` | — | `1` = disable inline (in-loop) upstream route-back |
| `SUPER_DEV_INLINE_ROUTEBACK` | `1` | `0` = alias for disabling inline route-back |
| `SUPER_DEV_NO_AUTO_ROUTEBACK` | — | `1` = restore the HITL prompt for single-owner upstream blockers (v0.3.19 auto-routes them by default) |
| `SUPER_DEV_AUTO_ROUTEBACK` | `1` | `0` = alias for disabling auto-route (same as the kill-switch above) |
| `SUPER_DEV_MAX_INLINE_JUMPS` | `4` | cap on inline route-back jumps per journal |
| `SUPER_DEV_NO_VERIFY_REPLAY_GUARD` | — | `1` = disable the Stage 10 replay guard |
| `SUPER_DEV_NO_SPEC_REUSE` | — | `1` = disable spec-track reuse (fresh allocation every run) |
| `SUPER_DEV_NO_SKILLS` | — | `1` = disable skill inheritance for delegated children (registration `inheritSkills:false`) — pre-v0.2.10 isolation |
| `SUPER_DEV_ALLOW_OVERLAP` | — | `1` = override the cross-instance run guard (set after a `/reload` orphaned a still-running pipeline) and force a new run; also settable via the config.json env map (v0.3.61) |
| `SUPER_DEV_BUILD_TIMEOUT_MS` | `600000` | per-command build-gate timeout |
| `SUPER_DEV_BUILD_TEST_PACKAGES` | auto | comma-separated cargo crate names to scope build/test/clippy (`""` = force workspace-wide) |
| `SUPER_DEV_GATE_BASE_REF` | `main` | git ref for auto-detecting touched crates |
| `SUPER_DEV_CARGO_METADATA_TIMEOUT_MS` | `30000` | cargo metadata lookup timeout |
| `SUPER_DEV_TRANSIENT_RETRY_MS` | `2000,4000,…` | transient agent-error retry envelope (comma-separated backoff delays) |
| `SUPER_DEV_BENCH` | — | `1` = enable the real-LLM convergence benchmark harness (SUPER_DEV_BENCH_TRIALS=1 implied) |
| `SUPER_DEV_BENCH_TRIALS` | `1` | trials per benchmark shape (≥3 for statistical claims) |
| `SUPER_DEV_BENCH_TIMEOUT_MS` | `900000` | per-trial benchmark timeout |
| `SUPER_DEV_DEBUG` | — | debug logging |

Every entry above can be exported in the shell (traditional behavior,
unchanged) **or** placed in the `config.json` `env` map.

The four `*_MS`/`*_PACKAGES`/`*_BASE_REF` variables tune the Rust-aware build
gate **without editing any stage call site**:

```bash
SUPER_DEV_BUILD_TIMEOUT_MS=900000 \
SUPER_DEV_BUILD_TEST_PACKAGES="api,store" \
SUPER_DEV_GATE_BASE_REF=develop \
  pi super-dev fix "add OAuth2 login"
```

Package-set **precedence** (highest → lowest): explicit `opts` argument →
`SUPER_DEV_BUILD_TEST_PACKAGES` (expanded into `-p <name>` flags on every cargo
build/test/clippy invocation) → auto-detected touched crates →
workspace-wide. The auto-detect path diffs against the base ref, maps every
`crates/<dir>/…` path to its directory, and resolves each to the **real cargo
package name** via a cached `cargo metadata --no-deps` lookup (prefixed-crate
workspaces resolve correctly — `crates/data/` → `stockfan-data`). Crate names
are bare package names, **not paths**. On any git/cargo error, empty diff, or
non-`crates/<pkg>/` layout it returns `[]` and the gate falls back to
workspace-wide behavior. The build gate is scope-aware beyond cargo, too: Rust
workspaces with touched nested modules also run the owning module's local
commands (`<module>: <command>` in the log), and pre-existing out-of-scope
failures are ignorable (`gate.pass || gate.inScopePass`) — now subject to the
merge-base baseline check above.

Internals: timeout resolution in `resolveTimeoutMs()`, package scoping in
`scopedCargoArgs()` family, directory→package resolution in
`resolveCargoPackageNames()`, auto-detection in `detectTouchedCargoPackages()`,
in-scope classification in `classifyOutOfScopeErrors()` (all under
`src/build-runner/`). See the JSDoc on `DEFAULT_TIMEOUT_MS` for the full
timeout fallback matrix.

### Cross-model review (`config.json` → `agentModels`)

By default every specialist agent runs on the same model. To review code with a
*different* model than the one that wrote it (so no output is graded by its own
author — a stronger review signal), map agent roles to models:

```json
{
  "agentModels": {
    "code-reviewer": "openai/gpt-5.4",
    "adversarial-reviewer": "google/gemini-3-pro",
    "spec-reviewer": "openai/gpt-5.4",
    "requirements-reviewer": "openai/gpt-5.4",
    "bdd-reviewer": "openai/gpt-5.4",
    "design-reviewer": "google/gemini-3-pro",
    "judge": "openai/gpt-5.4"
  }
}
```

All six reviewer roles — the three **shift-left reviewers** (`requirements-reviewer`,
`bdd-reviewer`, `design-reviewer`), the spec-stage `spec-reviewer`, and the two
Stage 10 reviewers `code-reviewer` / `adversarial-reviewer` — plus the **judge**
role can be mapped here. Two details worth knowing:

- The **tests/validation review angle** (Stage 10a2, runs when the spec declares
  `requireTests`/`requireScenarios` deliverables) reuses the `code-reviewer`
  role, so it follows that mapping automatically — no separate key.
- The **judge** (LLM judge routing layer, Stages 9/10) runs at most 2 calls per
  failure signature / 12 per run and always degrades silently to today's
  behavior when unavailable, so mapping it to a strong model is cheap and safe.
  The judge only ever routes within a closed set (`re-author-tests`,
  `challenge-test`, `fix-environment`, `continue`, `escalate-now`) — it can
  never grant a pass/green. Unmapped, it falls back to role-default resolution.

The upstream **shift-left reviewers** (`requirements-reviewer`, `bdd-reviewer`,
`design-reviewer`) apply Fagan-style inspection to each artifact as it is written
— catching ambiguity, coverage gaps, and undefined interface contracts at the
source instead of letting them cascade into the spec. Each runs in its stage's
convergence loop (write → review → fix), renders its own `NN-<slug>-review.md`,
and — like the other reviewers — can be mapped to a different model here.

Values are qualified `provider/id` strings. This **overrides** a one-off global
`--model`/`SUPER_DEV_MODEL` for the listed roles (a cross-model policy should not
be silently undone by a temporary flag); unlisted roles are unaffected. The
resolved model per agent is shown on each `agent … start … model=…` log line.

**Backend visibility caveat:** a mapped model must be resolvable by the backend
the role runs on. Reviewers and the judge run in the host pi session, so any
provider extension active there works. `research-agent` is isolated into bare
`pi` subprocesses (only `pi-web-access` + `pi-mcp-adapter` loaded), so mapping
it to a model supplied by a host-session-only extension fails fast with
`Model … not found` — map it only to models the stock `pi` CLI can see.

## Testing

```bash
npm run typecheck   # tsc --noEmit
npm test            # vitest — hermetic, no pi spawns, no network
```

130+ test files cover the control-flow algebra semantics, deterministic
helpers and gates (with byte-level toolchain output fixtures probed from real
pytest/go/cargo), control-JSON parsing and per-prompt control-key contracts,
RED/GREEN classification per language, judge budgets and evidence
verification, review triage, baseline verification against real tmp git
repos, merge verification against real linked worktrees, the TUI render
layer, and workflow composition integrity. The testing contract itself —
layered model, mock-hygiene rules, real-repo/real-toolchain lanes, the live
payload corpus convention, and the prioritized gap register — is documented
in [docs/testing-strategy.md](docs/testing-strategy.md).

## License

MIT
