# 00 — Principles Research and Rule Synthesis

Status: research (input stage of the manual pipeline — no implementation in this document)

Run under analysis: `~/.super-dev/runs/2026-08-18T01-02-50-093Z/run.log` (STEP E2E dashboard,
super-dev v0.2.1, macOS target repo, 4h39m, cancelled at phase 1/4 after 14 attempts).

Method: starting from the observed defects (RC13 un-actionable environmental verdict, RC14
signature never matching, RC12d reused-worktree dirt), we derive the *class* of each defect
using three layers of principles — first principles, systems principles, and principles from
neighboring engineering disciplines — then state each as an enforceable RULE and map every
rule back to concrete code-level fixes.

---

## Part 1 — First principles (what the pipeline fundamentally IS)

Strip the pipeline to its essence and rebuild from facts:

| # | First principle | Statement | Consequence |
|---|---|---|---|
| F-1 | **The pipeline is a controller** | It transforms (task, repo, environment) into (committed code, evidence). It senses (gates, tests, git state), decides (routing, verdicts), and acts (spawns, retries, commits). | Every design question is a control question: what is sensed, who decides, what actuates. |
| F-2 | **The environment is an input, not a constant** | Worktree contents, node_modules, uncommitted edits, and baseline state are inputs to every test run. If they are not pinned, outputs are not attributable. | "New on this branch" is only meaningful when the branch's environment is a pure function of committed state. |
| F-3 | **A retry is a bet that the next attempt differs** | Re-running an actuator is only rational if something changed between attempts (new feedback, new code, new environment). An identical attempt on an identical state is pure cost. | Loops must detect "nothing changed" and refuse to re-bet. |
| F-4 | **Evidence is only as good as its provenance** | A test result identifies (command, environment, inputs) — not just pass/fail. Two probes of *different environments* can disagree without either being wrong. | Contradictory evidence must be adjudicated by provenance rank, not ignored or averaged. |
| F-5 | **The whole is committed, not the phase** | A phase can be perfect and the commit still broken; a phase can be imperfect and the commit fine. Phase acceptance and repo hygiene are different claims. | They need different owners and different gates. |

## Part 2 — Systems principles

| # | Systems principle | Source | Statement | RULE |
|---|---|---|---|---|
| S-1 | **Requisite variety** | Ashby (cybernetics; pespmc1.vub.ac.be/REQVAR.html) | "Only variety can absorb variety": a regulator must have at least as many distinct responses as the disturbance classes it faces, otherwise it transmits disturbance into the system. | **R-S1: the failure-response set must cover the failure-class set.** One actuator (re-spawn implementer) facing ≥3 fault classes (product / environment / pre-existing noise) violates this. |
| S-2 | **Common vs special cause** | Shewhart/Deming (SPC; funnel experiment) | Most variation is built into the system (common cause); reacting to it as if assignable (special cause) is *tampering* and increases variance. | **R-S2: classify variation before acting on it.** An environmental failure treated as an implementer defect is tampering — the 11 identical retries are the funnel experiment reproduced. |
| S-3 | **Unsafe control action** | Leveson, STAMP (ptolemy.berkeley.edu/projects/cps/Unsafe_Control_Actions.html) | Accidents come not only from component failure but from *control actions that are unsafe in context* — including applying the right action to the wrong process variable. | **R-S3: audit the routing, not just the components.** "Send failure → implementer" is an unsafe control action when the failure variable is the environment. |
| S-4 | **End-to-end argument** | Saltzer/Reed/Clark (MIT, web.mit.edu/saltzer/www/publications/endtoend/endtoend.pdf) | Checks placed low in a system are incomplete and sometimes harmful; correctness ultimately belongs at the end-to-end level that understands the intent. | **R-S4: phase acceptance = scoped, intent-level evidence; whole-repo checks are integration telemetry owned downstream.** A whole-suite gate cannot overrule scoped-green phase evidence without adjudication. |
| S-5 | **Feedback loop closure** | control theory | Open-loop control applies the same action regardless of outcome; closed-loop updates the internal model from the last outcome before acting again. | **R-S5: every retry must consume the previous attempt's classified outcome.** Attempt N+1 may not be spawned while attempt N's outcome is unclassified-identical. |
| S-6 | **Anti-windup / budget** | control theory (integrator windup, backoff) | An unbounded integrator saturated by a persistent error makes recovery worse; systems clamp accumulation and back off. | **R-S6: bounded accumulation per failure signature — repetition must degrade to escalation, not accumulate.** |

## Part 3 — Neighboring-discipline principles (beyond first/systems)

| # | Principle | Source | Statement | RULE |
|---|---|---|---|---|
| N-1 | **Jidoka / andon** | Toyota Production System | Automation with a human touch: detect abnormality, *stop the line*, escalate immediately to someone empowered to fix the class of problem. | **R-N1: an abnormality the current actuator cannot fix stops the line at first occurrence** and routes to the empowered arbiter (judge/HITL), not attempt 14. |
| N-2 | **Actionable signals** | SRE (alert fatigue, error budgets — Google SRE) | An alert that names no action trains operators to ignore it; every page must be symptom-based, runbook-linked. | **R-N2: every gate verdict names its fault class and the legal next actions.** "regression — new on this branch" with no routing statement is a non-actionable alert. |
| N-3 | **Fault/error/failure taxonomy** | Avizienis/Laprie/Randell (dependability) | A fault (cause) may or may not activate into an error (state) and then a failure (observable); fault removal, forecast, and *tolerance* are distinct treatments. | **R-N3: treat each class with its own mechanism** — product faults get code changes; environment faults get isolation/quarantine; ageing faults get tracking. Never one mechanism for all. |
| N-4 | **Hermetic builds** | Bazel/Nix practice (beza1e1.tuxen.de/hermetic_builds.html) | Build/test outcomes must depend only on declared inputs; unpinned environment state makes results unattributable and cache-poisoning possible. | **R-N4: before attributing a failure to the branch, the worktree must be provably clean of foreign inputs.** |
| N-5 | **Isolation levels / ACID** | database theory | Concurrent/sequential operations on shared state without isolation produce dirty reads — one operation observes another's uncommitted effects. | **R-N5: runs sharing one worktree must isolate: each run starts from committed state; foreign uncommitted state is detected and quarantined (recoverably).** |
| N-6 | **Idempotency of recovery actions** | distributed systems | A recovery action applied twice must not corrupt; quarantines/stashes must be recorded, reversible, and single-instance. | **R-N6: quarantine is recorded (ledger), reversible (stash ref), and never silently destructive.** |
| N-7 | **Double-loop learning** | Argyris (organizational learning) | Single-loop learning corrects actions against fixed assumptions; double-loop questions the assumptions (here: the gate set and routing table themselves). | **R-N7: recurring environmental faults persist to a per-track ledger** so later runs and setup can challenge assumptions ("snow is known-dirty"). |
| N-8 | **Least authority** | security (POLA) | Give each component only the authority it needs; the implementer should neither need nor be able to edit unrelated packages to satisfy a whole-repo gate. | **R-N8: gates must not create incentives to widen scope.** A whole-suite failure must never be fixable by touching out-of-scope code. |

## Part 4 — The rules, consolidated (the contract this remediation enforces)

1. **R-S1 Variety**: failure classes {product-defect, environment-defect, pre-existing-noise} each own a distinct actuator: implementer-fix / quarantine+re-gate / record-and-proceed.
2. **R-S2 No tampering**: classification happens before actuation; environmental failures never re-spawn the implementer.
3. **R-S3 Routing audit**: the gate→actuator routing table is explicit, tested, and the object of review (not just the gate logic).
4. **R-S4 End-to-end acceptance**: scoped-green phase evidence cannot be vetoed by out-of-scope whole-suite failures without adjudication.
5. **R-S5 Closed loop**: an attempt may not be re-spawned while the previous failure is unclassified or classified-identical (normalized signature match).
6. **R-S6 Anti-windup**: same normalized signature twice → escalate (judge/HITL); never a third identical spawn.
7. **R-N1 Andon**: un-actionable-by-current-actuator abnormality escalates at first occurrence.
8. **R-N2 Actionable verdicts**: every gate failure message names its class and next actions.
9. **R-N3 Taxonomy**: environment faults are treated by isolation, not by code change.
10. **R-N4 Hermeticity**: "new on this branch" is only claimed after foreign worktree state is excluded (clean-of-dirt check).
11. **R-N5 Isolation**: re-entered/resumed tracks detect and recoverably quarantine out-of-scope dirt at setup (kill-switched).
12. **R-N6 Recorded recovery**: every quarantine is logged (paths, stash ref) and reversible.
13. **R-N7 Double loop**: environmental faults append to a per-track ledger consumed by later runs' judge context.
14. **R-N8 No scope-widening incentives**: no gate verdict may be resolvable by editing out-of-scope code.

## Part 5 — The deeper issue (principles applied to run 01-02-50)

The RC13/RC14/RC12d symptoms are one structural defect viewed from three angles:

> **Stage 9 is an open-loop retry controller with one actuator, actuating against all fault
> classes, on an unpinned, shared, non-hermetic environment, with unarbitrated evidence
> sources.**

Unrolled:

- **One actuator** (re-spawn implementer) vs three fault classes → violates R-S1 (variety).
  The snow failure was an environment-defect; the only available response was a
  product-fault response. Eleven tampering iterations (R-S2), burning ~3h of model time and
  zero information.
- **Open loop** (R-S5): attempt N+1 was spawned regardless of attempt N's classified
  outcome; the normalized content of failures 2–12 was identical, but the signature hash
  saw volatile noise (timestamps, tracking IDs, durations, cache markers), so even the
  cycle detector that exists never fired → also R-S6 windup.
- **Non-hermetic shared environment** (R-N4/N5): the reused worktree carried prior runs'
  uncommitted out-of-scope edits (`snow/enrichment.go` et al.). Baseline-verify correctly
  computed "passes at clean merge-base" → correctly refused the lenient pass → but the
  verdict had nowhere to go (R-N1 violated: no andon). The implementer's contrary stash
  probe (which keeps untracked files) probed a *different environment* — two oracles
  disagreeing because evidence is environment-relative (F-4) with no arbiter.
- **Gate placement** (R-S4): a whole-repo gate vetoed a scoped-green phase, creating the
  scope-widening incentive (R-N8) that produced the dirty edits in the *first* place
  (run 15-07's auth-service type shims). The defect feeds itself across runs.
- **Non-actionable verdicts** (R-N2): "regression — new on this branch" names no action.

### Fix set derived from the rules (implemented by this track)

| Fix | Rules | Content |
|---|---|---|
| **PRA — Fault classification & actuator routing** | R-S1..S4, N1, N2, N8 | Deterministic layer between build-gate failure and actuation: out-of-scope-only failure + own-scope green + baseline=regression is an *environmental blocker* — never re-spawn the implementer; instead (a) if out-of-scope uncommitted dirt exists → recoverable quarantine + one gate re-run; (b) else or still-failing → judge with both evidence packets at first occurrence; gate messages name class + next actions. |
| **PRB — Normalized signatures & anti-windup** | R-S5, S6 | Normalize failure signatures (command label + failing subjects + error class; strip timestamps/IDs/durations/cache markers). Two identical normalized signatures → no third identical spawn; escalate. |
| **PRC — Reuse hygiene (isolation)** | R-N4, N5, N6 | On re-entering a reused/resumed track: detect foreign uncommitted state (outside spec dir + harness bookkeeping), quarantine recoverably (scoped `git stash push -u` with ledger record), kill-switch `SUPER_DEV_NO_DIRTY_QUARANTINE=1`, prominent log. |
| **PRD — Environmental fault ledger** | R-N7 | Quarantines and judge environmental verdicts append to `<specDir>/.environment-faults.jsonl`; setup and judge contexts surface prior counts. |

Deliberately out of scope (recorded as dispositions): making builds fully hermetic (Nix-style
pinning of toolchains), demoting whole-suite gates to pure telemetry (kept as adjudicated
regression detectors per R-S4), and cross-run cache poisoning forensics.

---

## Provenance

- Ashby, *An Introduction to Cybernetics* — law of requisite variety (pespmc1.vub.ac.be/REQVAR.html).
- Shewhart/Deming — common/special cause, tampering, funnel experiment (en.wikipedia.org/wiki/Common_cause_and_special_cause_(statistics)).
- Leveson, *STAMP/STPA* — unsafe control actions taxonomy (ptolemy.berkeley.edu/projects/cps/Unsafe_Control_Actions.html).
- Saltzer, Reed & Clark, *End-to-End Arguments in System Design* (web.mit.edu/saltzer/www/publications/endtoend/endtoend.pdf).
- Zwinkau, *How to do hermetic builds* (beza1e1.tuxen.de/hermetic_builds.html); Bazel/Nix documentation.
- Toyota Production System — jidoka, andon cord (lean6sigmahub.com; IT Revolution, "The Andon Cord").
- Google SRE — actionable alerts, error budgets (Google SRE book; Conf42 SRE 2025, "Tackling Alert Fatigue with SLOs").
- Control theory — integrator windup / anti-windup, exponential backoff.
- Argyris — single-/double-loop learning (en.wikipedia.org/wiki/Double-loop_learning).
- Avizienis, Laprie, Randelle — *Basic Concepts and Taxonomy of Dependable and Secure Computing* (fault/error/failure).

---

## Part 6 — Principle-embedding map (which principle belongs in which stage/agent)

Beyond fixing run 01-02-50, the 14 rules are architecture guidance for the extension itself.
Per stage: what is ALREADY embedded (with commit/version), what is PROPOSED (not yet built),
and the design intent. ✓ = shipped, ○ = proposed.

### Stage 1 — Setup (`src/setup.ts`)
| Principle | State | Embedding |
|---|---|---|
| R-N4 Hermeticity | ◐ v0.2.2 | Dependency bootstrap (F12a) pins the toolchain half. Missing: environment provenance stamp — record worktree HEAD, dirt state, lockfile hash into `<specDir>/.environment.json` so every later verdict can cite its environment (F-2). |
| R-N5 Isolation | ✓ this track | PRC quarantine on track re-entry. |
| R-N7 Double-loop | ✓ this track | PRD environment-fault ledger read at setup (prior-fault count logged). |
| R-S2 Classify before actuating | ○ | Pre-flight fingerprint: run scoped smoke of packages the spec will touch; record known-red ones into the ledger BEFORE phase work, so "pre-existing" is established at entry rather than discovered at attempt N. |

### Stage 2 — Classify (`task-classifier`)
| Principle | State | Embedding |
|---|---|---|
| R-N3 Taxonomy | ◐ v0.2.2 | Declaration-shaped vs behavior-shaped contract tagging exists implicitly (F11 TASK-CONTRACT PRECEDENCE). Missing: emit it as structured output at classification time so TDD prompts inherit it mechanically. |
| R-S1 Variety | ○ | Tag task complexity class (greenfield/existing-repo/hybrid) → pre-selects actuator set + expected round budgets. |

### Stages 3–4 — Requirements / BDD (writer + reviewer loops)
| Principle | State | Embedding |
|---|---|---|
| R-N2 Actionable | ◐ | ACs must name their verification method (already enforced by requirementsContentErrors requiring ACs; strengthen: each AC carries `verified-by: <gate name>` so no AC is unverifiable by construction). |
| R-S4 End-to-end | ◐ v0.1.99+ | Reviewer duty contract + late-round downgrade prevent gate-vs-intent drift. Missing: when a reviewer finding contradicts an approved AC, the AC wins by default (intent authority) — needs an explicit precedence note in both reviewer prompts. |
| R-N8 No scope-widening | ○ | BDD scenarios must not invent observables the requirements never state (reviewer already checks; make it a deterministic bddTraceabilityErrors class). |

### Stages 5–7 — Research / Assess / Design
| Principle | State | Embedding |
|---|---|---|
| F-4 Evidence provenance | ○ | Research/assess claims carry source citations (URL/commit/file:line) — the dossier format already does this for reviews; formalize as a required field in their structured output. |
| R-S1 Variety | ○ | Design phase must enumerate the failure classes of the target change and name a detection mechanism for each (mini-FMEA); design-reviewer checks the coverage ratio. |

### Stage 8 — Spec convergence (`spec-writer` + `spec-reviewer`)
| Principle | State | Embedding |
|---|---|---|
| R-S6 Anti-windup | ✓ v0.1.98 | Progress-aware caps + effectiveRoundCap clamp. |
| R-S5 Closed loop | ✓ v0.1.98 | F6 structural repair (normalizePhases + coach hint) closes the empty-control loop. |
| R-S2 No tampering | ✓ v0.1.99 | Deterministic reviewer-duty downgrade (G1). |
| R-N2 Actionable | ◐ v0.2.2 | Coach-style errors (RC8/RC9). Missing: writer-side — every schema rejection should embed a minimal legal example (RC6 partially does this for phases). |

### Stage 9 — Implementation (tdd-guide, implementer, classifiers)
| Principle | State | Embedding |
|---|---|---|
| R-S1 Variety | ✓ this track | PRA multi-actuator routing (product→implementer, environment→quarantine/judge, noise→record). |
| R-S5/S6 | ✓ this track | PRB normalized signatures + identical-signature refusal. |
| R-N1 Andon | ✓ this track | First-occurrence judge routing for un-actionable states. |
| R-N8 Least authority | ◐ v0.2.2 | Out-of-scope edit detector (RC12c) observes; missing: enforcement — pass out-of-scope paths as a forbidden-edit list into the implementer prompt (advisory → contract). |
| R-N3 Taxonomy | ◐ v0.2.2 | RED evidence classes (review-weak vs green-weak vs broken). Missing: tdd-guide receives the class of its last rejection, not just the reason. |

### Stage 10 — Verify (adversarial/code/api reviewers)
| Principle | State | Embedding |
|---|---|---|
| R-S4 End-to-end | ✓ v0.2.2 | Whole-suite regression vs scoped phase acceptance now adjudicated (baseline-verify). |
| R-N7 Double-loop | ○ | Verify findings should update the per-track ledger even on green runs (ageing faults: "this package rots") — currently only failures land anywhere. |

### Cross-cutting — Judge
| Principle | State | Embedding |
|---|---|---|
| R-S3 Routing audit | ○ | Judge today diagnoses *content*; add a standing question: "was the correct actuator invoked?" — an unsafe-control-action check. Cheap: one extra prompt line + a `misrouted` route that terminates the loop instead of retrying it. |
| F-4 Provenance rank | ○ | When two evidence sources disagree (baseline-verify vs implementer probe), judge must rank by provenance (clean checkout > stash probe > claim) instead of ignoring the conflict. |

### Cross-cutting — Replan / Escalation
| Principle | State | Embedding |
|---|---|---|
| R-N6 Idempotent recovery | ◐ v0.1.98 | Replan requests dedupe by fingerprint; addressed-before-run re-routing landed (T3.4b). |
| R-N1 Andon | ◐ v0.2.1 | Headless escalation writes escalation-report.md (silent no-op closed). Missing: headless mode should default to route-back replan instead of terminal abort (already partially true). |

### Cross-cutting — Cost & benchmarks (cumora transfer plan P-05/P-06)
| Principle | State | Embedding |
|---|---|---|
| Per-call purpose ledger | ○ | P-05: llm_calls-equivalent in run dir + CI tripwire test. Makes the 3h-of-identical-retries cost class visible in real time. |
| Statistical shape-dual benchmarks | ○ | P-06: converges-when-should / holds-firm-when-should harness under SUPER_DEV_BENCH=1 — the only systematic catch for regressions like "signature never matched". |
| Minimal prompts / shape-level rules | ✓ cumora doc | Prompts carry shape rules, never scenario examples (both reviewer prompts conform). |

### Priority order for embedding (cost × leverage)
1. **Judge routing-audit question** (R-S3) — one prompt line + one route; catches the entire RC13 class forever.
2. **Environment provenance stamp** (F-2/N4) — small deterministic write at setup; every later arbitration cites it.
3. **Pre-flight package fingerprint** (R-S2) — moves "pre-existing" discovery from attempt N to entry.
4. **Per-call cost ledger** (P-05) — observability that funds all future prioritization.
5. **Forbidden-edit contract in implementer prompt** (R-N8) — turns RC12c's advisory into a prompt-level contract.
6. **AC verification-method field** (R-N2) — closes unverifiable-AC drift at birth.
