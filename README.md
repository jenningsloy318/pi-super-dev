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
- **Restart pi after a model-quota cap clears** (v0.3.77): pi-subagents caches
  quota-429s as 24h model exclusions in-process and never re-reads them, so
  after the provider resets the quota the parent session keeps working while
  every delegated child with a pinned model fails instantly with `… is
  excluded and cannot be replaced by a fallback`. super-dev classifies that
  envelope as non-retryable (no transient-retry burn, round-1 FatalAbort) and
  names the restart remedy in the abort message.

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
│    ├─ implementation.ts     RED/GREEN TDD loop, challenge channel
│    ├─ verify.ts             review fan-out, fix loop, integration
│    ├─ artifact-convergence.ts  write→validate→review convergence loops (2B/2C/3/6B)
│    ├─ spec-convergence.ts   spec loop
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
- **Common extensions for every capability agent (v0.3.78):** the config keys
  `commonExtensions` and `agentExtensions` in `~/.super-dev/config.json` ride
  the additive `subagentOnlyExtensions` registration channel (the same one
  the implementer/tdd-guide commit guard uses) — they never disable anything.
  `commonExtensions` (package names, `npm:` prefix optional) is merged into
  EVERY capability agent; mechanical one-shot classifiers (`task-classifier`,
  `judge`, the red-boundary and tdd-coverage classifiers) are excluded — a
  single tiny call gains nothing from per-child context bundles or tool
  cards. `agentExtensions` adds per-role entries merged with the hardcoded
  role sets (never replacing them) — the extension-side twin of `agentSkills`.
  Typical set: `nowledge-mem-pi` (auto-syncs every child transcript to
  Nowledge Mem), `pi-lsp` (edit-diagnostics hooks + `lsp_*` tools),
  `pi-blackhole` (`recall` tool + compaction). Extension HOOKS always fire
  in children; extension TOOLS merge onto the registration allowlist
  MECHANICALLY (v0.3.82: declaring the package in `commonExtensions` /
  `agentExtensions` is sufficient — every tool the loaded extension
  registered is attributed to its package at activation and added to each
  declaring agent's allowlist; no separate tool-name list to maintain). Extension loading never touches skills: capability agents keep
  their ambient on-demand skill cards (v0.3.76), so a child can carry all
  three extensions and still lazy-load any SKILL.md it needs. Entries resolve
  once at activation (restart pi after editing); a missing package logs one
  WARN and is skipped.
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
v0.3.64 deleted the first two from the production path — their shared
utilities moved to `src/agents/agent-runtime.ts` — while the session
executor's bench copy (`src/bench/session-agent.ts`, dev tooling never used
by the pipeline) lingered until v0.3.88 removed it; delegation is the only
executor. The `agentBackend` config key, `SUPER_DEV_BACKEND` env, and the
tool's `backend` parameter are gone (the parameter is still accepted but
ignored for legacy callers). The end-of-run reflection agent also delegates
(visible in Fleet); without an event bus (tests) reflection skips with a
named audit row instead of silently doing nothing.

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
  task(setupStage),                          // worktree, spec dir, bootstraps
  task(classifyStage),                       // task type / language routing
  requirementsConvergenceNode,               // write → review → fix loop
  bddConvergenceNode,                        // AC-coverage scenario loop
  researchConvergenceNode,                   // online ambiguity loop
  branch(isBug, { yes: task(debugWriter) }), // bug fixes only
  task(assessmentWriter),                    // code assessment
  designConvergenceNode,                     // design → review loop
  task(prototypeStage),                      // prototype (when needed)
  specConvergenceNode,                       // spec → trace gate → review
  loop(                                      // per-phase TDD until allGreen
    { while: (s,c) => !implAllGreen(s) && !implConvergenceBlocked(s) && c.budget.check() },
    task(implementationStage)),
  branch(hasImplementation,                  // review/build/integration
    { yes: verificationConvergenceNode }),   //         convergence (restarts at review
                                             //         after every fix)
  branch(hasVerifiedImplementation, {
    yes: sequence([
      task(docsWriter),                      // source-read-only close-out
      task(preMergeBuildStage),              //         hard build gate before cleanup
      task(cleanupTask),                     // dependency cleanup + scan
      branch(canMerge, { yes: sequence([     // merge (LLM performs it…)
        task(mergeWriter),
        task(mergeVerifyTask),               // …git deterministically verifies)
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

**Phase-green triple gate (implementation).** A phase is GREEN only when

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

**RED/GREEN TDD oracle (implementation, cross-language).** The RED check runs the
scoped test command from the conventions table and classifies STRICTLY from
structured evidence (JUnit XML / TAP / go-test-JSON / declared count lines)
plus the exit code: red / green / broken / unknown — console prose never
classifies (the Bazel principle; see *Universal test verification* below). A
greenfield suite whose tests cannot even compile is honestly `unknown` and
routes through the judge's `allow-scaffold` escape instead of a regex
shortcut. The RED boundary classifier (`red-boundary-classifier`) rejects
production-file edits during RED.

**RED review with joint-satisfiability screening (implementation).** A Tier-2
reviewer (`code-reviewer`) judges the RED suite for behavior-binding
assertions, tautologies, and scenario coverage — and must additionally check
that **at least one conforming implementation could pass ALL tests
simultaneously**, reporting `contradictions[]` with an impossibility proof
(`[]` = none, never omitted). Named contradictions override even a STRONG
verdict and route back to tdd-guide with the proof inlined — closing the
"unsatisfiable RED suite accepted as strong, implementer doomed" failure
class.

**testDefects challenge channel (implementation).** When the implementer *proves* a
confirmed RED test is unsatisfiable (internal contradiction), it reports
structured `testDefects {testFile, lines, reason}` (always emitted, `[]` when
none). The stage then drops `acceptedRed` and re-runs tdd-guide *with the
implementer's diagnosis* — bounded by `SUPER_DEV_MAX_CHALLENGE_REAUTHORS`
(default 2) — instead of blind re-authoring the same contradiction.

**Verification review fan-out + deterministic triage.** Three parallel reviewers
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

**Out-of-scope regression baseline (implementation/verification gates).** Pre-existing failures
in *untouched* test files would historically be excused wholesale. Now, when
out-of-scope failures are the only failures, the gate re-runs those failing
subjects in a temp detached worktree at the **merge-base** of the default
branch: subjects that **pass at the baseline** prove the failure is NEW on
this branch → inScopePass flips to false with a `[baseline-verify] regression`
error block. Cached per (repo, merge-base); never throws;
`SUPER_DEV_DISABLE_BASELINE_CHECK=1` escapes. Ambiguous outcomes degrade to
the historical lenient pass.

**Fault-classified actuation + reused-worktree hygiene (implementation/setup).** On
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
log), the §D loop stops re-attempting, and verification skips with a named notice —
no more executing a superseded spec for hours before the restart (research
basis: Fox et al. ICAPS-06 plan stability; Nav2 replan-immediately-on-
invalidation; CI cancel-in-progress).

**Merge verification (deterministic follow-up).** The merge agent *performs* the merge
(instructed to merge from the main checkout — inside a linked worktree it
structurally cannot advance the checked-out default branch), but the run only
*claims* `merged: true` after a deterministic git check re-derives it
(`git merge-base --is-ancestor` of feature head in default head; reported
commit SHA exists). Unverified claims are rewritten to `merged: false` with
concrete reasons; the run reports `partial`, never success.

**Sensitive-file scan (cleanup stage).** Cleanup scans only **git-carried** files
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
| requirements/bdd/research/design/spec convergence | budget + 8-round cap + stall escalation (≤2 retries per `kind:stage`) |
| Implementation RED retries | `SUPER_DEV_MAX_RED_RETRIES` (default 6) + no-progress + oscillation detection |
| Implementation challenge re-authors | default 2 (`SUPER_DEV_MAX_CHALLENGE_REAUTHORS`) |
| Implementation/verification per-attempt fix loops | budget + recurring-signature no-progress (any earlier attempt) |
| Verification review loop | approval (verdict AND build green) + stagnation (identical non-empty findings signature) + **dead-state breaks**: no actionable findings with a green gate (or absent gate after one full round) breaks for HITL |
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
non-empty evidence field, not only verbatim quotes. In implementation, the RED
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
  (v0.3.73 run-audit fixes: quarantined red-review verdicts are salvaged when
  every violated path attributes to the concurrent implementer; tests-review
  artifacts render; agent-failed findings close on later success; reviewers
  get the 30-min timeout tier; the global run-metrics ledger is test-hermetic;
  spec-dir bookkeeping no longer trips red-polluted; self-commit prohibition.)
  (v0.3.74 design wave over those root classes: the harness-file basenames
  live in ONE canonical registry (`src/harness-paths.ts`) instead of four
  parallel Set literals; the `task()` auto-render net guarantees every
  control-bearing stage leaves an artifact even when its manual render call
  is forgotten; the three timeout tiers are operator-tunable via
  `SUPER_DEV_CODE/REVIEW/DEFAULT_TIMEOUT_MS` (no reload needed — read per
  call; sub-second values are rejected as unit mistakes); and the two writer
  agents carry a commit-guard child extension that BLOCKS commit-class git
  invocations (commit/merge/rebase/cherry-pick/stash/revert/pull/push/am;
  read-only forms like `git merge-base` and `git stash list` pass) at the pi
  tool_call layer — registered via `subagentOnlyExtensions` so the child's
  AMBIENT extension discovery (user MCP tools) stays intact
  (`SUPER_DEV_NO_COMMIT_GUARD=1` to disable; the v0.3.73 HEAD-drift detector
  stays as the fail-open detective net). Since v0.3.86 every delegated agent
  ALSO carries the safety guard on the same channel (dangerous-bash denylist +
  protected-file overwrite blocking; `SUPER_DEV_NO_SAFETY_GUARD=1` to disable)
  — previously those rules only loaded in the bench harness.)
  (v0.3.84 duplicate-node incident class: every delegation attempt now
  carries a per-attempt unique nodeId (`base@requestId`) — a cancelled or
  timed-out predecessor that is still settling can never collide with its
  successor's id, which is what aborted run 2026-09-08T23-27-36 via
  `duplicate_node` → 3-consecutive fuse; a duplicate_node terminal also gets
  ONE bounded backoff retry (`SUPER_DEV_DUPLICATE_NODE_RETRY_MS`, the attempt
  never started so the retry is free); spec-writer moves to its own 30-min
  heavy-writer tier (`SUPER_DEV_WRITER_TIMEOUT_MS`) — it writes all three
  docs in one call and ran at 90-100% of the 20-min default; and the vitest
  suite pins `SUPER_DEV_NO_CONFIG_ENV=1` so a developer's real config.env can
  never leak into default-asserting tests.)
  (v0.3.72 review fixes: corrective rounds and transient retries sum EVERY
  attempt's usage — the fuse can no longer under-count spend; a set-but-
  unparseable fuse value WARNs loudly once per variable instead of silently
  disarming.)
- **Harvest (`run-metrics.jsonl`)**: at run end ONE deterministic JSON row per
  run lands in `<specDir>/run-metrics.jsonl` (status, agentsSpawned, wallMs,
  stage-status histogram, `agentErrorRounds`, `fatalAborts`, usage totals,
  timestamp). Best-effort observability: never throws, never gates. This is
  the closing-the-loop feed the σ-band monitor (v0.3.69) reads instead of
  hand-mining multi-thousand-line prose run logs.
- **Attribution dashboard (v0.3.75)**: "where did the money go" is answered by
  three artifacts, all best-effort and never run-gating:
  `<specDir>/usage-calls.jsonl` — one JSON row per TERMINAL call (id, agent,
  model, status/error, tokens, cache, cost, duration, `runId`); failed calls
  are recorded even without usage. `<specDir>/usage-report.md` — the rendered
  dashboard: totals with cache-hit share, a per-stage table and a per-agent
  table (both cost-sorted), the top-10 most expensive calls, and a
  "fixed floor" line (the cheapest observed prompt ≈ the ambient skill list +
  tools + system prompt overhead — multiply by calls for the run's fixed
  cost). The run log gets a compact one-line summary. Stage keys collapse
  retry/attempt suffixes (`.aN`/`.tN`/`.rNN`) so re-work aggregates under one
  row; resume passes each render their own report (prior rows stay in the
  ledger under their `runId`). This is the yardstick the v0.3.76 skill
  curation effect is measured against.

## Review finding discipline & plan Risks/Proof (v0.3.71)

Review outputs feed writer re-prompt rounds, so verbose low-signal findings
inflate every downstream round (SDLC REVIEW.md play: "cap the nits"). Both
reviewer prompts (`code-reviewer`, `adversarial-reviewer`) now carry a
**Finding Discipline** section: Important-vs-Nit definitions, at most 3 nits
(nits suppressed entirely when blocking findings exist), a do-not-report list
(lint-covered, unevidenced hypotheticals, tests for unchanged behavior, TODOs
unless risk-related, code restatement), and file:line + severity + one-line
fix output discipline. Plans gain per-phase **Risks** (concrete failure
modes) and **Proof** (which gate/test command/deliverable clause proves
completion) — optional fields, bounded to 3 one-liners, never padded; old
specs and resume replays stay valid.

## Phase ownership, commit fusion, plan memory (v0.3.80)

Wave B of the spec-25 root-cause program (`docs/findings/deep-analysis-2026-09-08-spec25.md`):

- **B1 ownership grammar** — a phase's "own scope" (what the phase-boundary leak guard treats as legitimately editable) and the plan validator's "writable set" now derive from ONE canonical clause grammar (`phaseClauseFiles`: requireFiles/contains/notContains/tests). Co-declaring a shared file in BOTH phases is the legal handoff; the BLOCKING leak revert now carries a ROUTE TO APPROVAL (declare the file, or revise the plan's ordering) per the playbook's blocking-hook rule; the spec prompt teaches the grammar to the plan writer.
- **B2 stage-close re-verification (commit fusion)** — a phase ending PARTIAL with its work already landed (gate-window expiry, absorbed work) is re-verified at stage close: live deliverable check per partial phase + one stage-level build gate; satisfied phases flip GREEN honestly. Judge-owned environmental stops are excluded (their resolution is env/judge-owned).
- **B3 plan memory** — fresh runs on a spec dir with replan history inject the persisted replan requests as HARD CONSTRAINTS into the spec-writer prompt, so a re-derived plan does not re-introduce the shapes a prior REPLAN revised away.

## Serving-copy freshness + eval stability (v0.3.81)

Wave C of the spec-25 program: the extension stamps its serving version at every activation and warns (fire-and-forget, never blocks) when the installed copy is behind its `origin/main` — the 2026-09-04T14-10 incident class where a fixed bug kept running live because the serving copy lagged the repo. The version was already stamped into every `run.log` header; now the mismatch is loud at startup. Also: the incident eval suite (`npm run evals`) is flake-free — the v0.3.28 session-backend narration test's waitFor-attach race was replaced with a creation-time harness hook.

## Resume cache: errors are never replayed (v0.3.83)

The resume memoizer (`.resume-cache.jsonl` in the spec dir, append-only,
last-wins) exists to make completed work free on resume — a replayed success
makes zero model calls. Before v0.3.83 it cached failures the same way: a
quota wall (2026-09-08, spec 25) wrote four pure-error rows, and every later
resume replayed the 16:15 error verbatim forever — quota resets, exclusion-store
deletions, and pi restarts are all invisible to a replay that spends nothing.
The failure masqueraded as a fresh "it failed again" with an `expires:`
timestamp that was just text inside the error string, never parsed or compared.

Two cuts close the class. **Read side (heals existing caches):** a cached hit
that is an error — with or without a control — first tries the v0.3.48 text
recovery (kept — a parse-boundary improvement can revive an errored row into a
success); when nothing is recoverable the row is treated as a MISS and the
call re-runs live (honest log: `cached agent error NOT replayed; re-running
live`), and the fresh row shadows the error row in the last-wins log — no
manual cache surgery, and old poisoned cache files self-heal on first resume.
A control riding an error is the first attempt's schema-violating object
(the corrective-retry strain, delegation-backend 505/508) — certified invalid
by the engine, so it is discarded rather than replayed. **Write side (no new
poison):** a pure failure (error, no control, no body text) is never persisted
— failure is not a result, it is the absence of one; errors WITH body text
remain cacheable (the recovery path's raw material), with any accompanying
invalid control stripped from the persisted copy only (the live caller keeps
it); and an all-pure-failure pass still touches an inert tombstone row so the
track stays resumable. **Round accounting (dual-review fix):** error rows are
holes, not banked work — `countStageRounds` counts successful rows only, so
the live re-runs a poisoned cache performs count as FRESH rounds for the
3-consecutive agent-error FatalAbort and the round budget (a poisoned k-round
cache can no longer re-spend k uncounted live calls per resume while infra
stays down). Success replay, the v0.3.48 recovery precedence, the replay
guard, and the 3-consecutive live-failure FatalAbort are all unchanged.
Time-based failures (quota windows, transient infra) now self-heal by
construction: each resume retries the poisoned call exactly once live;
success takes over.

## Structured delegation (v0.3.70)

Every stage call carries a TypeBox schema (`STAGE_MODELS`), and since v0.3.70
the delegation backend honors it (decision D7 Option C — industry converged on
enforce-when-schema; plan: docs/plans/2026-09-05-v0.3.68-hardening-plan.md §5):

- **Wire**: schema-carrying calls send `result:{kind:"structured",schema}` —
  the child gains a `structured_output` tool validated AT CALL TIME in its own
  conversation (pi-subagents 0.65), so an invalid value is repaired in-turn
  without burning a delegation round. Verified live: a real zai glm-5.3 child
  called `structured_output` (1 turn, 1 tool) and the value arrived validated.
- **Engine stays authoritative (P5)**: whatever arrives — structured value or
  parsed `<control>` prose — is re-validated with TypeBox `Value.Errors`
  (`typebox/value`, aliased by pi's extension loader). The corrective re-prompt
  now names the exact JSON-pointer violations (`/verdict: must be equal to one
  of the allowed values`) instead of only missing-key names — the industry
  validate→repair pattern; still bounded to one corrective round.
- **Never fatal (P4)**: two automatic sticky per-process degrades fall back to
  text mode (schema rides the prompt, engine validation unchanged) — an owner
  that rejects the structured fields (in-memory 0.64 bridge after `pi update`),
  and 3 consecutive `structured_output_failed` terminals. Each WARNs once.
  (v0.3.72: the invalid_request matcher must NAME the unsupported delegation
  field — an error merely containing the word "structured" no longer degrades.)
- **Escape hatch**: `SUPER_DEV_STRUCTURED=0` opts out entirely (default ON).
- **Known upstream gap (watched)**: pi-subagents 0.65.x background/async children
  require `@earendil-works/pi-server`/`pi-client` resolvable from the pi package
  root, which pi 0.85.1 hosts lack — interactive `async` subagent fan-out fails.
  pi-super-dev's pipeline children are foreground/in-process and unaffected
  (see `docs/upstream-watch.md`, 2026-09-05 entry).
  The flag is scheduled for removal two versions after the mode stabilizes.
- **Coverage audit (§5.2.5)**: every `controlKeys` call site now carries a
  schema — judge (`route` enum: a free-text route is now a correctable
  violation, not a silently misrouted one), tdd-coverage-classifier,
  red-boundary/file classifiers. P6 dynamic cross-check pins the judge route
  union against `stages/judge.ts JUDGE_ROUTES`.

## Plan feasibility & escape-valve integrity (v0.3.79)

Root cause class (spec-25 deep analysis, `docs/findings/deep-analysis-2026-09-08-spec25.md`): the machinery executed plans it had never validated for feasibility, on a single-worktree ownership model that horizontal specs structurally violate, through stage-local loops whose only escape valve (the judge) failed closed — so the same infeasibility surfaced at a different stage each run.

- **Plan-feasibility validator** (`src/stages/plan-feasibility.ts`, deterministic, zero-LLM) runs at implementation entry: cross-phase identifier contradictions (an earlier phase's test clause needs an identifier the plan positions in a later phase's production file — every satisfiable fix trips the BLOCKING boundary guard) and requireContains/requireNotContains same-file same-pattern conflicts route **REPLAN before any phase executes**; shared-file coupling and missing vitest coverage tooling surface as advisories first.
- **Execution-time contradiction fast-fail**: a phase whose repeated no-progress signature coincides with observed BLOCKING phase-boundary reverts arms a contradiction frame at the no-progress valve — `replan-upstream` is offered to the judge, and a routed verdict triggers the replan machinery instead of blind retries (run 14-14 burned 6 attempts ≈2h before its generic valve fired).
- **Judge evidence failures never silently discard**: one corrective re-call feeds the verification failures back into the prompt; a corrective verdict that verifies routes normally; one that still fails **escalates with the diagnosis preserved** (the fabrication guard stands — an unverified verdict never routes on its claimed route; the only floor is escalate).
- **Stagnation routes by finding class**: reviewer infra non-completions ("X review did not complete") never arm the stagnation stop; a genuine content stop first asks the judge once whether the blockers are within the stage's authority or plan/spec-owned — a `replan-upstream` verdict becomes a REPLAN instead of a human-decision PARTIAL.

## The auto-continuous evolution loop (v0.3.69)

The harness's fix lifecycle (findings → class-level tests → version) has
always been human-governed; v0.3.69 automates the MEASURE–DETECT–DIAGNOSE half
so degradation is caught by machinery, not by whoever next reads a 4k-line
run log (plan: docs/plans/2026-09-05-v0.3.68-hardening-plan.md §9):

| Aspect | Mechanism |
|---|---|
| Measure | every run appends one JSON row to `<specDir>/run-metrics.jsonl` AND the global `<super-dev-dir>/run-metrics.jsonl` (W2 v0.3.68 + E1) |
| Detect | **E1 σ-band monitor** — median+MAD robust bands per metric at close-out; ≥8 prior runs before banding; 1σ logged / 2σ post-mortem flag / 3σ outlier surfaced; zero LLM |
| Diagnose | **E2 post-mortem agent** — read-only `sd-post-mortem` reads run artifacts (paths in, JIT reading), matches the P1–P10 escape classes, returns a STRUCTURED draft; the ENGINE (never the agent) validates + writes it to `docs/findings/inbox/`. Auto-invoked only when `postMortem: "auto"` in `~/.super-dev/config.json` and the run was not a success (default manual) |
| Decide | **E3 triage** — `npm run triage` (zero-LLM): list drafts, approve → moves to `docs/findings/` with an approved status header; the fix lifecycle takes over. The human gate is non-negotiable |
| Prove | **E4 evals** — `npm run evals` runs the incident-pinned behavioral suites (`v0.3.*` test names); run it after ANY model/config change (`agentModels`, `agentThinking`) before trusting a long run. **E5 prediction ledger** — findings carry `prediction: <metric> <direction>`; the close-out checker compares recent-vs-baseline medians (n≥3 each) and appends supported/refuted verdicts (never overwriting) |

Governance guardrails (Arize tiers): drafts land in inbox only; persistent
changes always flow through the human fix lifecycle; the post-mortem agent is
read-only; no agent may edit gates, methodology, or evals; rollback = git.

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
	"commonExtensions": ["nowledge-mem-pi", "pi-lsp", "pi-blackhole"],
	"agentExtensions": { "ui-tester": ["..."] },
	"allTools": false,
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

`commonExtensions` (v0.3.78): extension packages EVERY capability agent
loads as a delegated child, via the additive `subagentOnlyExtensions`
registration channel. Values are installed package names (the `npm:` prefix
is optional and stripped). Entries are resolved to absolute entry paths from
the `~/.pi/agent/npm/node_modules/<pkg>` package manifests ONCE at activation
— **edits require a pi restart** (same as `agentSkills`). A missing package
logs one WARN and is skipped; the run continues. Example — auto-sync every
child transcript to Nowledge Mem and give children LSP tools + blackhole
recall:

```json
"commonExtensions": ["nowledge-mem-pi", "pi-lsp", "pi-blackhole"]
```

`agentExtensions` (v0.3.78): per-role extension additions, merged with the
hardcoded role extension sets (`research-agent` web packages,
`qa-agent`/`ui-tester` browser package) — never replacing them. Bare role
keys are canonical; `sd-`-prefixed keys are also accepted. Same resolution
and restart semantics. Example:
`"agentExtensions": { "ui-tester": ["some-future-ext"] }`.

`allTools` / `agentAllTools` (v0.3.82): extension TOOLS are merged onto
each declaring agent's allowlist MECHANICALLY — declaring the package in
`commonExtensions` / `agentExtensions` is sufficient, no separate tool-name
list exists (the old `commonExtensionTools` / `agentExtensionTools` keys
were removed; leftovers in an existing config.json are ignored harmlessly).
The index is built once, DEFERRED to the first `session_start` (calling
`pi.getAllTools()` during extension activation throws — pi binds action
methods only after every extension loads; and package load order follows the
settings.json `packages` array, so late-listed packages are invisible to an
activation-time snapshot). Tools that register lazily (per-server
`mcp__*` direct tools) are outside any one-shot snapshot — the `mcp` proxy
merges mechanically; for the full direct set use the all-tools mode.
The trade-off: tool granularity is per-package (all of a declared extension's
tools), not per-tool. To unpin entirely, set the all-tools MODE — `allTools:
true` (every capability agent; mechanical classifiers excluded, same scope
predicate as `commonExtensions`) or `"agentAllTools": { "<role>": true }`
(any role, explicit beats scope; `sd-`-prefixed keys accepted). When active,
registration OMITS the `tools` pin — the only correct "all tools", since
pi's allowlist is an exact-match Set — so the child sees every tool:
role built-ins, all extension tools, and every present or future
`mcp__<server>__<tool>` direct tool. The mode re-excludes `super_dev` (the
recursion guard: unpinned children keep ambient extension loading and would
otherwise carry an ACTIVE super_dev tool), `powershell`, and — for read-only
roles — the write family (the binding read-only enforcement stays the
engine-side source boundary). Host-specific residual: any OTHER ambient
extension registering pipeline-class tools (on this machine `stock_analysis`,
`omisis_analyze`) is NOT excluded — the mode trusts the operator; extend the
exclusion list in `src/agents/register-agents.ts` if you run `allTools` on a
host that installs such packages. Example:

```json
"allTools": false,
"agentAllTools": { "research-agent": true }
```

Malformed config values (wrong-type arrays, unknown packages) never crash
registration: each logs one WARN naming the key/package and is skipped —
loud fallback, never a dead pipeline.

`commonToolBudget` / `agentToolBudget` (v0.3.87): tool-call budget caps for
delegated agents — the mechanical backstop behind the external-resource
discipline (the prompt side lives in the agents' prompt files). Values are
POLICY and live in config only — **no budget number is hardcoded in the
extension**. **Requires pi-subagents ≥ 0.65** (native
`toolBudget { soft, hard, block }` on the agent registration): a pre-0.65
owner rejects the field — every agent registration fails loudly with
`agent registration rejected for sd-<name>` and the existing structured-
degrade machinery reports it per call; upgrade pi-subagents (no super-dev
code path is involved). Caps are STRICTLY OPT-IN: absent config sends no
`toolBudget` at all.

```json
"commonToolBudget": { "soft": 15, "hard": 30 },
"agentToolBudget": {
	"implementer": { "soft": 40, "hard": 80 },
	"tdd-guide": { "soft": 40, "hard": 80 },
	"research-agent": { "soft": 100, "hard": 250 },
	"research-assist": { "soft": 15, "hard": 30 }
}
```

Resolution: `agentToolBudget[role]` > `commonToolBudget` > none. Bare role
keys are canonical; `sd-`-prefixed keys are accepted. `research-assist` is
a CONFIG ROLE KEY ONLY (assist dispatches reuse `research-agent`; no agent
file exists): its chain is `agentToolBudget["research-assist"]` >
`agentToolBudget["research-agent"]` > `commonToolBudget` > none.
Mechanical one-shot classifiers (`task-classifier`, `judge`,
`tdd-coverage-classifier`, `red-boundary-classifier`) NEVER get a budget —
even with an explicit entry (firmer than the extensions scope predicate).
Values must be exactly `{ "soft": n, "hard": n }` (positive integers,
soft ≤ hard, no other keys); a malformed value or container logs one WARN
naming the key and is treated as absent — loud fallback, never a crash.
Registration reads config once at activation — **edits require a pi
restart** (same as `agentSkills` / `commonExtensions`).

Counting/blocking semantics (verified against pi-subagents 0.67): at the
`soft` threshold the child is nudged to finalize; past `hard`, ONLY the five
external exploration families are blocked — `web_search`, `fetch_content`,
`get_search_content`, `source_check`, and the MCP family (`mcp` plus the
`mcp__` prefix entry for `mcp__<server>__<tool>` direct tools) — so local
coding tools (read/edit/bash/`lsp_*`/blackhole/mem) are retained and the
child can always finish with final text. Note that upstream counts EVERY
child tool call toward the soft/hard thresholds (no family-scoped counting
exists in 0.67); read the numbers as total-call thresholds at which
external exploration gets cut off — the block-only-external-families
property is what makes the cap discipline browsing, not coding.

RECOMMENDED values (documentation only — nothing applies without config):

| Role | soft | hard | Rationale |
|---|---|---|---|
| implementer / tdd-guide | 40 | 80 | total-call thresholds (see semantics above): coding agents routinely make 20-60 LOCAL calls per attempt — the cap is runaway insurance for browsing, never a coding constraint |
| capability default (`commonToolBudget`) | 15 | 30 | doc writers/analyzers: local headroom for reads/greps, external cut early |
| research-agent | 100 | 250 | dedicated-research sanity ceiling — observed dedicated passes run 50-90 tool calls; runaway insurance, never a discipline constraint |
| research-assist | 15 | 30 | per-call scoped single question (240s cap anyway) |

Calibration (recalibrated 2026-09-11): the postmortem's original single-digit
values assumed external-only counting; upstream 0.67 counts EVERY tool call,
so the numbers above are total-call thresholds sized so that local coding
work is never constrained — only external exploration gets cut off. LangGraph's
3-4× recursion-headroom rule and production all-tools budgets (12-25) informed
the capability-default tier; dedicated research agents run 80-160 searches
(Gemini calibration), which is why research-agent's ceiling sits far above
the coding default.

**Engine-mediated research assist (v0.3.87, S4)** —

When the implementer gets stuck, the ENGINE — not the implementer — decides
when research is warranted, dispatches it, and carries the distilled result
into the next corrective prompt (report always accompanies execution, never
report-only):

- **Trigger** (hybrid): the 2nd consecutive same-class failure — RED-side
 (`terminalRedTries ≥ 2` at the terminal RED-generation boundary, armed for
 the §D re-entry's first attempt) or GREEN-side (`faultClassStreak ≥ 2` on
 the F3 counter). At most **1 assist per phase ever** (persists across §D
 re-entries); a spent cap logs an honest skip. Only the implementer gets
 assists — tdd-guide keeps quick-lookup (ADR 6; extension deferred to
 E-wave evidence).
- **Enrichment, never dispatch**: the implementer control's optional
 `needsResearch: [{question, why}]` (both fields required, ≤6/emit) is
 ARCHIVED until a trigger trips, then appended to the engine-composed scoped
 question. It never dispatches by itself.
- **Dispatch**: synchronous, before the carrying attempt's implementer call;
 reuses `research-agent` (source-read-only, 240s cap, per-call toolBudget from
 the `research-assist` config chain — see the table above).
- **Injection**: engine-side distillation caps the result — ≤5 findings
 `{claim, source, applies}`, ≤10-line recommendation, ~2KB block into the
 corrective channel; `noUsefulSignal` renders an honest-empty note that still
 accompanies the attempt.
- **Failure semantics (P5)**: a failed/timed-out assist degrades to a
 `noUsefulSignal` row — no agent-error-fuse touch, no attempt consumed, no
 abort. Budget exhaustion skips the assist with an honest log.
- **Ledger**: one row per dispatch in `<specDir>/research-assists.jsonl`
 (trigger, question, enrichment flag, outcome, duration, MCP-exposure audit —
 MCP side effects sit outside the source boundary's worktree view; residual
 risk recorded, one row per assist). Excluded from phase commits.

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
| `SUPER_DEV_MAX_RED_RETRIES` | `6` | Implementation RED generation retry cap |
| `SUPER_DEV_MAX_PHASE_ATTEMPTS` | `4` | implementer attempts per phase per §D entry; RED sub-loop retries excluded (v0.3.85 F3) |
| `SUPER_DEV_FAULT_RECURRENCE` | `3` | consecutive same-FaultClass attempts that trip the no-progress valve even with fresh footprints (v0.3.85 F3) |
| `SUPER_DEV_MAX_PHASE_WALL_MS` | `5400000` | per-phase wall budget (90min), resets on each §D re-entry (v0.3.85 F3) |
| `SUPER_DEV_MAX_RUN_WALL_MS` | `14400000` | run-pass wall fuse (4h) with graceful wind-down — `0` disables; terminal `partial (wall-fuse)` is resumable with a fresh window (v0.3.85 F3/decision 2) |
| `SUPER_DEV_MAX_RED_JUDGE_ROUTES` | `3` | routed judge interventions per phase before only `fix-environment` remains |
| `SUPER_DEV_MAX_CHALLENGE_REAUTHORS` | `2` | implementer-driven RED re-author cap |
| `SUPER_DEV_MAX_JUDGE_CALLS` | `12` | judge calls per run (2 per signature) |
| `SUPER_DEV_MAX_RUN_COST` | — | run-wide cost fuse in USD (fail-closed pre-call; see Usage governance) |
| `SUPER_DEV_MAX_RUN_TOKENS` | — | run-wide token fuse, input+output (fail-closed pre-call; see Usage governance) |
| `SUPER_DEV_WRITER_TIMEOUT_MS` | `1800000` | heavy-writer timeout tier — spec-writer produces all three spec docs in one call (v0.3.84) |
| `SUPER_DEV_DUPLICATE_NODE_RETRY_MS` | `2000` | backoff before the single duplicate_node delegation retry, clamped to 60s (v0.3.84) |
| `SUPER_DEV_NO_CONFIG_ENV` | — | `1` = test-hermeticity kill switch: `superDevEnv` ignores `config.json`'s `env` map entirely (set by the vitest setup; never set in production) |
| `SUPER_DEV_JUDGE_TIMEOUT_MS` | `1200000` | judge wall-clock budget per call — dedicated 20-min tier, raised from 480s after two 480s discards in run 2026-09-09 (v0.3.85; retry-on-timeout consumes the 2nd signature slot) |
| `SUPER_DEV_DISABLE_JUDGE` | — | `1` = kill switch, judge degrades instantly |
| `SUPER_DEV_DISABLE_BASELINE_CHECK` | — | `1` = skip merge-base regression verification |
| `SUPER_DEV_SKIP_DEP_BOOTSTRAP` | — | `1` = skip dependency bootstraps in build-gate command discovery |
| `SUPER_DEV_NO_BOOTSTRAP` | — | `1` = skip the setup-time dependency bootstrap (npm ci etc.) in fresh worktrees |
| `SUPER_DEV_COVERAGE_THRESHOLD` | `85` | line-coverage hard floor (%) for the TARGET program's phase production files, measured post-GREEN from the validated runner (v0.3.49) |
| `SUPER_DEV_NO_COVERAGE_GATE` | — | `1` = skip the target-program coverage hard gate entirely |
| `SUPER_DEV_NO_WATCHDOG` | — | `1` = disable the external delegation watchdog (detached watcher that records a frozen host loop; v0.3.57) |
| `SUPER_DEV_BOOTSTRAP_TIMEOUT_MS` | `600000` | setup dependency-bootstrap timeout |
| `SUPER_DEV_NO_DIRTY_QUARANTINE` | — | `1` = kill switch, disable automatic foreign-dirt quarantine (setup reuse + the implementation env-blocker) |
| `SUPER_DEV_MAX_REPLAN_ROUNDS` | `2` | replan auto-resume rounds per spec |
| `SUPER_DEV_REPLAN_MANUAL` | — | `1` = keep single runs (disable replan auto-resume) |
| `SUPER_DEV_DISABLE_REPLAN_LEAD` | — | `1` = skip the replan-lead enrichment agent |
| `SUPER_DEV_NO_INLINE_ROUTEBACK` | — | `1` = disable inline (in-loop) upstream route-back |
| `SUPER_DEV_INLINE_ROUTEBACK` | `1` | `0` = alias for disabling inline route-back |
| `SUPER_DEV_NO_AUTO_ROUTEBACK` | — | `1` = restore the HITL prompt for single-owner upstream blockers (v0.3.19 auto-routes them by default) |
| `SUPER_DEV_AUTO_ROUTEBACK` | `1` | `0` = alias for disabling auto-route (same as the kill-switch above) |
| `SUPER_DEV_MAX_INLINE_JUMPS` | `4` | cap on inline route-back jumps per journal |
| `SUPER_DEV_NO_VERIFY_REPLAY_GUARD` | — | `1` = disable the verification replay guard |
| `SUPER_DEV_NO_SPEC_REUSE` | — | `1` = disable spec-track reuse (fresh allocation every run) |
| `SUPER_DEV_NO_SKILLS` | — | `1` = zero skill cards on EVERY layer for delegated children (registration `inheritSkills:false` AND per-call curated sets suppressed) — pre-v0.2.10 full isolation (top kill-switch) |
| `SUPER_DEV_SKILLS` | — | `ambient` = restore full ambient skill injection for EVERY delegated child (opt-OUT escape hatch for v0.3.76 curation; classifiers/research otherwise register `inheritSkills:false` + curated per-call sets; also settable via the config.json env map, resolved once per session) |
| `SUPER_DEV_ALLOW_OVERLAP` | — | `1` = override the cross-instance run guard (set after a `/reload` orphaned a still-running pipeline) and force a new run; also settable via the config.json env map (v0.3.61) |
| `SUPER_DEV_BUILD_TIMEOUT_MS` | `600000` | per-command build-gate timeout |
| `SUPER_DEV_BUILD_TEST_PACKAGES` | auto | comma-separated cargo crate names to scope build/test/clippy (`""` = force workspace-wide) |
| `SUPER_DEV_GATE_BASE_REF` | `main` | git ref for auto-detecting touched crates |
| `SUPER_DEV_CARGO_METADATA_TIMEOUT_MS` | `30000` | cargo metadata lookup timeout |
| `SUPER_DEV_TRANSIENT_RETRY_MS` | `2000,4000,…` | transient agent-error retry envelope (comma-separated backoff delays) |
| `SUPER_DEV_SERVICE_CMD_ALLOWLIST` | — | comma-separated EXTRA first-token service launchers for the verification bringup allowlist (model-discovered `cmd` must start with a standard launcher — npm/pnpm/yarn/bun run/start/dev verbs, node/deno/vite/next/npx/caddy/serve/http-server, `python -m http.server`, cargo/go run; anything else is refused with an honest log and the pipeline degrades to no-live-service, never punishing the work) |
| `SUPER_DEV_NO_SAFETY_GUARD` | — | `1` = kill switch for the delegated-child safety guard (dangerous-bash denylist + protected-file writes, loaded via `subagentOnlyExtensions` for every agent alongside the commit guard) |
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
Verification reviewers `code-reviewer` / `adversarial-reviewer` — plus the **judge**
role can be mapped here. Two details worth knowing:

- The **tests/validation review angle** (the tests/validation angle, runs when the spec declares
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
