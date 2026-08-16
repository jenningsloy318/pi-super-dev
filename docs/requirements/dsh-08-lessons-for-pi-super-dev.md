# dsh-08 — What pi-super-dev Can Learn from DeepSeek Harness

Status: synthesized from dsh-01…dsh-07 + direct reading of the vendored repo (`docs/references/deepseek-harness`), the Cordis paper, and the Orange Book.
Audience: pi-super-dev maintainers. Every lesson maps to a concrete pi-super-dev mechanism and file.
Companion reports: dsh-01 (architecture), dsh-02 (Cordis paper), dsh-03 (agent lifecycle/session), dsh-04 (security), dsh-05 (extension ecosystem), dsh-06 (engineering process), dsh-07 (Orange Book field report).

---

## 0. Framing: two harnesses, two bets

DeepSeek Harness (dsh) and pi-super-dev solve overlapping problems with opposite center of gravity:

| Axis | dsh | pi-super-dev |
|---|---|---|
| Core bet | Everything is a plugin (runtime composability; Cordis proves unload/reload safety) | Verify, never trust (deterministic oracles around an LLM pipeline) |
| Unit of extension | Cordis plugin claiming a `ctx.<key>` seam | Stage/task node inside a fixed pipeline composition |
| Model-visible state | Append-only `SessionEvent` log — "model-visible means logged" | Structured control objects + audit.jsonl + resume-cache |
| Loop control | Event waterfalls (`agent/pre-step`, `agent/turn-stopping`) | Deterministic gates, round caps, stagnation, judge routing |
| Scale | 219 packages, ~50 capability seams, 688 decision notes | ~40 src files, one extension, sequential fix workflow |

The lessons below are selected for *transferability into pi-super-dev's bet*, not for imitation of dsh's. Where dsh's approach would fight our design, that is stated explicitly (§4).

## 1. High-value adoptions (recommended, ordered)

### L-1. Package-owned runtime invariants registry (`ctx.invariants` pattern)

dsh mechanism (dsh-01 §"invariants", `docs/subsystems/invariants.md`): every workspace package publishes a `./invariant` companion plugin registering assertions under its exact npm name. The registry owns selection (allow/blocklist), name reservation (duplicates throw), and package-attributed failure (`InvariantError` with `packageName`). The decisive discipline: a package with nothing checkable must export an EMPTY installer whose leading comment starts `No runtime invariant:` **and explains why, package-specifically**. A mechanical gate (`pnpm run verify-package-invariants`) rejects generated markers, unexplained empties, and wiring gaps. Assertions may target authoritative event streams or mutable data — never service/method presence.

pi-super-dev mapping: our bug classes are exactly "invariant violated silently" — R-5's liveness regression (findingsSignature emptied ⇒ unbounded loop, shipped because validation piped through `tail`), the `merged:"true"` string bypass, the dead `hasNumericConstants === true` gate, the testDefects schema-drop. Today each fix lands as scattered guards + tests. The dsh pattern would give us:

- `src/invariants.ts`: a registry where each stage module registers checks (e.g. verify-stage: "review loop terminates within budget OR breaks via a named exit"; implementation-stage: "an accepted RED with all-green phases cannot coexist with dropped control keys"; merge-stage: "`state.merge.merged === true` implies `verification` contains 'git-confirmed'").
- Every stage module must register at least one check or carry a `No runtime invariant:` explanation comment — enforced by a contract test that walks the stage registry, mirroring `verify-package-invariants`.
- Failures are module-attributed and fatal-loud, not console.warn.

Cost: low (registry + one contract test). Payoff: the "silent dead gate" class (three occurrences this month) becomes structurally impossible to reintroduce without writing an explanation a reviewer sees in the diff.

### L-2. Decision records with a rejection lifecycle (Agent Notes)

dsh mechanism (dsh-06): `.agents/notes/{proposed,implemented,rejected,archived}/<category>/YYYY-MM-DD-<slug>.md` — 688 notes. Rejected notes are first-class: they record the proposal, the evaluation, and the refusal rationale (e.g. `2026-07-26-evaluate-landstrip-for-windows-sandbox-rung.md`). The Orange Book builds its recurring "they wanted to do X, then didn't" column directly from these (dsh-07) — rejected designs are treated as PRODUCT knowledge, not noise.

pi-super-dev mapping: `docs/requirements/` holds plan docs but no state lifecycle; refuted ideas (the workspace sub-claim we refuted by probe, the "feed deferred findings back into reviewer prompts" design killed by agreeableness-bias research, Fix C boundary relaxation) live only in reflections. A lightweight convention:

- Every plan doc gains a `Status:` header: `proposed | approved | implemented (<commit>) | rejected (<reason>) | superseded-by (<doc>)`.
- Rejections get their own short note (proposal → why evaluated → why refused → what would revisit it). Our repo-wide audit's "refuted/refined-claims section" is already this shape — it just isn't systematic.

Cost: trivial. Payoff: future agents (and us) stop re-proposing dead ends; the audit showed we ourselves re-derived "escalate + maxRounds+=3 vs direct FatalAbort" three times.

### L-3. Postmortems as institutional rule-formation (`docs/postmortem/` + defensive-patterns)

dsh mechanism (dsh-06): four postmortems, each ending in a named rule inside `docs/defensive-patterns.md` ("Hard-won bug-class rules: each pattern below is a class of defect that actually shipped or nearly shipped here, stated as the rule that prevents its recurrence"). The rules are short, imperative, and story-backed: "Report orthogonal outcomes independently" (a process timed out AND exited 0); "Dispose must reach quiescence" (kills issued but not awaited); "Contain callback exceptions in the dispatcher"; "Never hand untrusted output the ambient environment"; "Unlink link-shaped paths".

pi-super-dev mapping: our equivalent incidents exist (validation-pipe exit-code trap hit twice — R-5 and a17f5e6c; the regex-delete of gates.ts during Fix B; the python-edit indentation failures) but live in session reflections, not the repo. Concretely: create `docs/postmortem/NNNN-<slug>.md` for the R-5 liveness ship (already the best candidate — it has root cause, two trigger instances, and the fix rule "full-suite validation must capture vitest's own exit code; never pipe unguarded"), and extract `docs/defensive-patterns.md` with our first five rules:

1. Validation exit codes come from the tool, not the pipe (R-5, a17f5e6c).
2. Never strict-compare LLM-typed booleans/numbers — read through `toBool`/`toNumber` at the boundary (merged:"true", lines:"808", dead hasNumericConstants).
3. A structural change that can empty a loop's termination driver must ship with a liveness test of the emptied state (R-5 demote ⇒ empty signature).
4. Whole-output regex extraction answers "mentioned", never "failed" — classify from failure statements only (greenfield sibling veto; maps to dsh's "honor public contracts on BOTH sides").
5. Module-load-time env capture is untestable — read env lazily (MAX_CHALLENGE_REAUTHORS, judge cap).

Cost: trivial. Payoff: these rules are precisely the ones we keep re-learning.

### L-4. Generated, verified architecture documentation

dsh mechanism (dsh-01 §7): the module graph, capability-seam table, event producer/consumer matrix, tool catalog, persistence catalog, and config catalog are GENERATED from the TypeScript program by `scripts/gen-*.ts`, byte-verified in `doc-sync` gates with `BEGIN GENERATED — do not edit` markers. The event matrix even lists undeclared event strings found in source. Graph atlas classifies every diagram generated/hybrid/curated and states its maintenance mode.

pi-super-dev mapping: we already have the seed — `tests/build-runner-docs.test.ts` asserts README contains `SUPER_DEV_BUILD_TIMEOUT_MS` etc., and `tests/prompt-control-contracts.test.ts` pins control-key sets. But README's architecture tree, stage table, env-var table, and agent-role list are hand-maintained and rotted before (v0.1.25 vs v0.1.71). The dsh pattern says: invert it — write `scripts/gen-arch-docs.ts` that derives (a) the stage list from `src/stages/index.ts` composition, (b) the env-var table from a single source-of-truth constant module, (c) the agent-role → backend → model-resolution table from `resolveAgentModel` inputs, and emits README sections between markers; a `verify-arch-docs` test fails CI on drift. Our version.test.ts pin is exactly this pattern for one field — generalize it.

Cost: moderate (one generator + markers). Payoff: the README-staleness class dies; docs become build artifacts.

### L-5. Mode-tagged event/callback contracts (`@mode` + waterfall discipline)

dsh mechanism (dsh-01 §5, dsh-02 §2.7): every typed event declares a dispatch mode (emit/waterfall/parallel/serial/bail) as part of its PUBLIC contract; a generated catalog checks declarations against dispatch sites. The waterfall rule is codified: "a waterfall listener that only observes or annotates MUST call `next()`; returning without it is a deliberate short-circuit. Forgetting next() in a logging listener silently swallows the default behavior for everyone downstream."

pi-super-dev mapping: our seam-equivalents are the AgentCall option hooks (`escalate`, `runRedCheck`, injected `baselineVerify`, judge routing) and the stage event emitter (`phase`/`stage`/`gate-exhaustion`). None carry a declared contract — the stranded-banner TUI bug was exactly an undeclared-contract mismatch between two emitters (nodes.ts phase label vs extension.ts stage label). Adoption: tag every event/hook with a one-line JSDoc contract (`@mode observe` = must not return a decision; `@mode decide` = short-circuit allowed) and add a lint-ish test that greps for untagged emissions. Cheap, catches the "helper accidentally swallows downstream default" class.

### L-6. "Model-visible means logged" — one durable event log as the projection source

dsh mechanism (dsh-03): the append-only `SessionEvent` log is the single source of truth; `deriveMessages()` projects model history from it; a runtime invariant asserts that anything reaching a model request is reconstructable from the log; fork/resume/telemetry/titles ALL derive from the same stream; `SESSION_FORMAT_VERSION = 0` states "no compatibility implied".

pi-super-dev mapping: our model-visible facts are scattered — resume-cache.jsonl (implementer controls), audit.jsonl (structured outputs), run.log (human), .knowledge.json, .judge.jsonl. The implementer's TEXT proof in v0.1.52 was recoverable only by grepping a resume-cache key; "attempt 1's proof is never persisted across attempts" was a design gap we noted. Adoption path (not a rewrite): standardize ONE append-only per-run `events.jsonl` with a typed envelope (`{seq, time, type, stage, data}`) that every stage APPENDS to (controls, oracle outputs, judge calls, escalations), and make resume/escalation/docs read from it. The generateAt stamping fix (0.1.74) was this instinct applied to docs; generalize to the run itself. Version the envelope (`RUN_LOG_VERSION`), pre-1.0 honesty like dsh.

Cost: moderate. Payoff: postmortems stop requiring archaeology (`grep -c "testDefects" run-dir` would be a jq query); cross-attempt persistence (the v0.1.52 "attempt 1 proof lost" gap) becomes natural.

### L-7. Turn/step/round vocabulary + inbox wake semantics

dsh mechanism (dsh-01 §5, dsh-03): a precise loop hierarchy — step (one model request + its tools) ⊂ turn (zero+ steps; opens before first input claim, closes when nothing is owed) ⊂ round (outer policy iteration). Input reaches the driver through ONE inbox; some messages wake immediately, injected context WAITS until another message does. A rejected or empty first claim still closes a durable turn that spent no step — "the log records the attempt".

pi-super-dev mapping: our Stage 9 attempt loop and Stage 10 review loop lack this vocabulary; escalations conflate "the attempt timed out" with "the turn had no work". The wake-semantics rule answers a real question we hit: when the judge's `continue` route threads `judgeGuidance` into the next implementer prompt — that is dsh's "injected context waits in the inbox"; our W-1 wrap-up turn is "a follow-up wakes the session". Writing our loop states as an explicit step/turn/attempt/round table in `docs/` (and naming loop exits — we already name `__stagnated`, `dead-state`, `ROUND CAP`) would make future liveness reasoning routine instead of heroic.

## 2. Medium-value adoptions (situational)

### M-1. Capability seams with three declared roles

dsh's Definition/Provider/Consumer discipline (`docs/glossary.md` §capability-seam) — including "a package may combine roles, but one role alone is not a seam" — is why one `ctx.fs` provider swap moves Bash/PTY/LSP. pi-super-dev's seams exist but implicit: agent backend (session/subprocess behind `realAgent`), RED oracle runner (`runTool` injectable), baseline verifier (`baselineVerify` injectable). Formalizing them as typed triads would mainly help the research-agent backend problem (v0.1.66: research forced to subprocess, model invisible there — a seam whose Definition forgot to include "model visibility" in its contract). Situational because our seam count is small.

### M-2. Whole-row patch semantics for config layering

dsh patches replace a row's ENTIRE config — no deep merge, deliberately: "composition, flag derivation, and config dumps cannot drift from what boots". Our `getConfig` merges DEFAULT_CONFIG over user JSON (partial files work). The dsh lesson is not to drop merging but to ensure a dump path exists: a `super-dev --dump-config` equivalent that prints the EFFECTIVE resolved config (model per role, backend, caps, env) would have made the v0.1.66 research-model failure diagnosable in one command instead of a session of archaeology.

### M-3. Fail-loud boot audit

dsh's `assertEntriesLoaded/Activated` turn silent partial plugin trees into startup rejections naming every unresolved entry. pi-super-dev's Stage 1 Setup is already fail-loud on essentials; the gap is feature-level: judge degrades SILENTLY by design (INV-6), baseline check degrades silently, skills/lang-profiles load best-effort. Those are deliberate (production availability), but we lack the middle ground dsh has: a boot-time DIAGNOSTIC line listing every degraded subsystem ("judge: degraded (reason)", "baseline: disabled (env)") so a degraded run is visible without DEBUG. One log line each; cheap.

### M-4. Bilingual docs discipline

dsh ships `.zh.md` twins for every doc with a `verify-translation-pairing` gate. Not applicable to pi-super-dev today (English-only), but if the user base is bilingual (ours is — the maintainer works in Chinese), the pattern of pairing-verified translations beats ad-hoc translation drift.

## 3. What the Orange Book adds (field evidence, not design)

From dsh-07 (the independent non-coder teardown within 24h of release):

- **PTC cost inversion**: letting the model write orchestration programs raised fixed overhead ~9% for 5-utterance/15-op tasks — delegation is not free even when it saves turns. Direct read-across to our judge routing: judge calls are cheap per se, but each routed retry restarts a 1200s-budget implementer; our per-signature budget of 2 already respects this — keep it.
- **"Repo has it ≠ installed has it"**: dsh's 35 out-of-tree extension packages confuse users expecting bundled features. pi-super-dev's equivalent: our subprocess research backend loads ONLY pi-web-access + pi-mcp-adapter — capability present in the host session is absent in spawned agents. We fixed the symptom (README backend-visibility caveat); the general rule is to surface each agent's EFFECTIVE capability set at spawn time (one log line).
- **100% coverage, still crashes**: the editor-connect crash with all-green suites is the strongest external validation of our own validation-defect lesson — coverage is not liveness; exit-code-honest full runs are (dsh-06 postmortem culture institutionalizes exactly this).

## 4. What NOT to copy (stated trade-offs)

1. **Everything-is-a-plugin indirection.** 219 packages, key-based lookup, ~50 seams for a harness whose competition ships as one binary. Our pipeline is a fixed composition; converting stages to plugins would trade our strongest property (a legible, deterministic straight-line pipeline) for flexibility we do not need. dsh itself pays real costs: generated catalogs exist BECAUSE the graph exceeds human comprehension.
2. **Process ceremony at dsh scale.** 688 notes, four doc gates, pairing verification — appropriate for an AI-written, rapidly-churning public framework; disproportionate for our 40-file extension. Take the note LIFECYCLE (L-2), not the volume.
3. **Runtime HMR.** Cordis's hot reload is provably safe and irrelevant to us: our runs are 30–90 minute one-shots where restart costs one resume (we already have spec-level resume).
4. **Nominal, unversioned linking.** dsh's own paper lists this as an open problem; our imports are typed and compiled — do not adopt stringly service keys.
5. **Silent cycles / permanent PENDING.** A cost of their dependency model, not a feature.

## 5. Adoption priority table

| # | Lesson | Effort | Value | First concrete step |
|---|---|---|---|---|
| L-3 | Postmortems + defensive-patterns doc | trivial | immediate | write `docs/postmortem/0001-r5-validation-pipe.md` + `docs/defensive-patterns.md` (5 rules above) |
| L-2 | Plan-doc status lifecycle + rejection notes | trivial | high | add `Status:` headers; write first 2 rejection notes |
| L-1 | Invariants registry + explain-or-assert contract test | low | high (kills silent-dead-gate class) | `src/invariants.ts` + per-stage companion + contract test |
| M-3 | Degraded-subsystem boot diagnostics | trivial | medium | one log line per degraded subsystem in Stage 1 |
| L-5 | `@mode` tags on events/hooks + untagged-emission test | low | medium | JSDoc contract on `escalate`, judge routes, stage events |
| L-4 | Generated README architecture sections | medium | high over time | `scripts/gen-arch-docs.ts` with GENERATED markers + verify test |
| M-2 | `--dump-config` effective-config dump | low | medium | print resolved agentModels/backends/caps at Setup |
| L-6 | Unified append-only run event log | medium-high | high | typed envelope + append from stages; consumers migrate incrementally |
| L-7 | Step/turn/attempt/round vocabulary doc | trivial | medium | one docs page + naming pass over loop exits |
| M-1 | Seam triads formalization | low | situational | type the agent-backend + oracle-runner seams |

## 6. Evidence index

- dsh-01-architecture-overview.md — plugin substrate, boot composition, core spine, events, seams, module graph, 10 design decisions.
- dsh-02-cordis-paradigm-paper.md — formal semantics (revertible effects, reactive coeffects, Γ∞, calculus, metatheory), implementation mapping, critical assessment (incl. the three transferable lessons that seeded L-4/L-5/M-2 here).
- dsh-03…dsh-07 — lifecycle/session detail, security, ecosystem, process, field report (see each report's own evidence appendix).
- Direct reads: `docs/architecture.md`, `docs/cordis-primer.md`, `docs/subsystems/invariants.md`, `docs/defensive-patterns.md`, `docs/rescope.md`, READMEs, paper §1–§3, `/tmp/dsh-paper.txt`, `/tmp/dsh-orange-book.txt`.
