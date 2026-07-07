# Gap Implementation Research — What to Port, What to Skip

**Date:** 2026-07-06
**Question:** Of the gaps identified in
`rewrite-review-vs-super-dev-plugin.md`, which should be implemented —
one, some, or all — and in what order?
**Method:** primary-source evidence gathering (Pi extension API docs, both
codebases, the original plugin's hook scripts and pivot protocol, the
rewrite's spawn/session architecture) + authoritative external source
(Claude Code Hooks reference). Note: web search was unavailable during
research (Exa out of credits, Gemini rate-limited), so external claims are
grounded in the official Claude Code docs fetch + established knowledge of
the agentic-coding ecosystem (SWE-agent, Aider, OpenHands), with
confidence levels marked.

---

## TL;DR — Verdict matrix

| # | Gap | Verdict | Effort | Value | Tier |
|---|-----|---------|--------|-------|------|
| **A** | **Deterministic gate-build** (NEW — found during research) | **DO NOW** | S | **High** | 1 |
| 4.3 | Safety hooks: `block-dangerous` + `protect-files` | **DO NOW** (partial) | M | High | 1 |
| 4.6 | Verify-loop **stagnation detection** | **DO NOW** | S | High | 1 |
| 4.1 | Language specialist agents | **DO (enrich, don't replicate)** | M | Med | 2 |
| 4.4 | Reference corpus (protocol docs) | **DO (docs only)** | S | Med | 2 |
| 4.6′ | Full 9-step **pivot protocol** | **DEFER** | L | Low-Med | 3 |
| 4.8 | Usage report command | DEFER | S | Low | 3 |
| 4.2 | Skill library (30 skills) | **SKIP** | — | Low | 3 |
| 4.7 | Team-lead execution path | **SKIP** | — | Low | 3 |
| 4.5 | Multi-platform manifests | SKIP (by design) | — | — | 3 |
| — | Auto-test-on-edit (`run-tests` hook) | **SKIP** (covered by A) | — | — | 3 |
| — | Auto-checkpoint (`Stop` hook) | SKIP (covered by worktree) | — | — | 3 |

**Bottom line:** Do **not** port everything. Implement **3 high-leverage
items now** (Tier 1), **3 medium items next** (Tier 2), and **skip 6**.
The rewrite's architecture already covers several "gaps" via different,
better mechanisms; the gaps that matter are the ones that fix *correctness
signals* (gate-build) and *safety* (block-dangerous), not the ones that
replicate the plugin's breadth (40+ agents, 30 skills, dual execution).

---

## Tier 1 — DO NOW (high value, low/medium effort)

### Gap A — Deterministic gate-build  ★ highest leverage

**The problem (found during this research):** The rewrite's `gate-build`
helper trusts the QA agent's **self-reported** `buildSuccess` and
`allTestsPass`:

```ts
// src/helpers.ts — current gate-build
if (!toBool(qa.buildSuccess)) errors.push("Build failed");
if (!toBool(qa.allTestsPass)) errors.push("Tests failing");
```

This is a **vacuous-pass risk**: a QA agent that reports green when it
isn't (or didn't actually run anything) passes the gate. The verify-loop's
`approvedAndGreen` convergence signal is only as trustworthy as this
self-report.

**The original does it deterministically.** `super-dev-plugin/scripts/utils/
gate-build.mjs` actually spawns `npm run build`, `npm test`, `tsc --noEmit`
(cargo/go/python equivalents) and checks exit codes. This is the proven
design.

**Evidence this matters:** Claude Code's own `TaskCompleted` hook docs show
the canonical pattern is to run tests and block on failure, not trust
self-report. The SWE-bench agent literature (SWE-agent, OpenHands) treats
observable test results as the *convergence signal* — the rewrite's
`verify.ts` comments explicitly cite this ("observable test results are the
convergence signal"), but the implementation undercuts it by trusting
self-report at the build gate.

**Approach (small):**
- Port the deterministic runner as a new helper, e.g. `gate-build-deterministic`,
  in `src/helpers.ts`: detect project type (reuse `setup.ts:detectLanguage`
  logic), spawn build + test + typecheck, capture pass/fail + last N lines
  of stderr.
- Wire `implementation.ts` and `verify.ts` to call it instead of (or in
  addition to) trusting `qa.allTestsPass`.
- ~150 LOC + tests. Pure helper, fully feasible, no new dependencies.

**Confidence: High.** Primary-source code in both repos.

---

### Gap 4.3 — Safety hooks: `block-dangerous` + `protect-files`

**The problem:** A spawned implementer/QA agent can run `rm -rf /`, force-
push, drop tables, `curl | sh`, or overwrite `.env`/`.pem` files. Today
nothing stops it except the agent's own judgment. The original blocks these
via Claude Code `PreToolUse` hooks (denylist regex + protected-file
patterns). Claude Code's hooks reference confirms `PreToolUse` blocking is
**the standard safety pattern** — its canonical example is literally
blocking `rm -rf`.

**Pi has the hook surface — but there's an architectural catch.** Pi's
extension API offers `tool_call` (can `{block:true}` + mutate input = PreToolUse),
`tool_result` (can modify = PostToolUse), and `agent_end`/`session_shutdown`
(= Stop). **However**: non-browser specialists are spawned with
`--no-extensions` (`src/pi-spawn.ts:buildSpawnArgs`), so a host-level
`tool_call` hook would **not** fire inside specialist subprocesses. The
host's own tool usage is minimal (the pipeline delegates to specialists),
so a host-only hook would protect almost nothing.

**Three feasible enforcement points:**

1. **Session backend (default) — wrap the bash tool.**
   `session-agent.ts` builds tools via `createCodingTools(opts.cwd)`. Insert
   a `bash` wrapper that runs the denylist before delegating, and a
   `write`/`edit` wrapper that checks protected-file patterns. This gives
   **hard enforcement** for the default backend. ~120 LOC.
2. **Subprocess backend — inject a safety preamble** into the specialist
   system prompt (`loadAgentPrompt` + prepend). Soft guardrail (the model
   *should* refuse), defense-in-depth alongside the worktree isolation.
   Cheap.
3. **Both — ship a tiny `pi-super-dev-safety` extension** and drop
   `--no-extensions` for specialists so the hook loads. Strongest but
   reduces isolation (subprocess can now call `subagent`, etc.). **Not
   recommended** unless combined with a tighter `--tools` allowlist.

**Recommendation:** Do (1) + (2). Port the denylist and protected-file
patterns verbatim from the original (`scripts/hooks/block-dangerous.mjs`,
`protect-files.mjs`) — they're battle-tested regex sets. This closes the
biggest operational risk without sacrificing isolation.

**Value: High** (prevents catastrophic, unrecoverable actions in worktrees
that could escape to the main checkout). **Effort: M.**

**Confidence: High** (Pi API docs read directly; original hook code
inspected; spawn flags confirmed).

---

### Gap 4.6 — Verify-loop stagnation detection

**The problem:** The rewrite's `verifyNode` runs `loop({until:
approvedAndGreen, times: 4}, …)` with **no stagnation detection**. If the
same review findings repeat across iterations, the loop fixes them, re-
reviews, gets the same findings, fixes again — burning all 4 rounds on
non-convergence. The original detects this ("signature stagnation: if the
SAME set of files+severities is reported on iteration 2 as on iteration 1")
and pivots.

**Evidence this matters:** Non-convergence detection is a recognized
termination heuristic in agentic-coding loops. SWE-agent and similar
agents use bounded action budgets and detect stalls; without it, loops
degenerate into "do the same thing expecting different results."

**Approach (small):**
- In `verify.ts`, track a findings signature (sorted `file+severity+rule`
  tuples, hashed) per iteration into `state.__reviewSignatures`.
- Add a predicate `stagnating = signatures[iter] === signatures[iter-1]`.
- Change the loop's exit to also break (non-fatal) on `stagnating`, logging
  "review findings stagnant across iterations — surfacing to user instead
  of re-fixing."
- ~40 LOC, no new nodes (uses existing `loop` + a predicate).

**Recommendation:** Do this **now**; defer the full 9-step pivot protocol
(Tier 3). Stagnation detection is the cheap, high-frequency part; the
expensive pivot-with-redesign is the rare part.

**Value: High** (prevents wasted iterations; gives the user an honest
signal that the loop is stuck). **Effort: S.**

**Confidence: High.**

---

## Tier 2 — DO NEXT (medium value, medium effort)

### Gap 4.1 — Language specialists: enrich, don't replicate

**Finding:** The rewrite's `route-specialist` helper **already injects
per-language instructions** into the generic implementer:

```ts
// src/helpers.ts — LANG_INSTRUCTIONS
rust: "Follow Rust Edition 2024 idioms. Use thiserror for errors, tokio for async. … Run cargo clippy and cargo test.",
go:   "Follow Go 1.24+ idioms. … Run go vet and go test ./...",
```

So the language gap is **partially closed by design** — the architecture
chose prompt augmentation over separate agent files. The dedicated agents
in the plugin (e.g. `golang-developer.md`, 100 lines) are *richer*
(iter.Seq iterators, enhanced ServeMux, slog, errgroup, code samples,
80% coverage rule, mandatory `*_test.go` organization).

**Evidence (research Q4):** Whether per-language specialist agents
measurably outperform a strong generalist with good context is unsettled.
Modern frontier models carry strong language knowledge; the marginal value
of a dedicated agent is the **project-specific guardrails** (exact build/
test/lint commands, coverage thresholds, file-organization rules), not the
generic idioms. Those guardrails are exactly what's in the dedicated agents
and what's thinly represented in `LANG_INSTRUCTIONS`.

**Recommendation:** **Don't** add 8 agent files. **Do** enrich
`LANG_INSTRUCTIONS` by distilling each dedicated agent's guardrails (build
command, test command, lint command, coverage threshold, file-org rule,
2-3 top idioms) into a richer per-language block. ~1-2 days. This captures
~80% of the dedicated-agent value at ~10% of the maintenance cost.

**Skip** mobile/desktop specialists (android/ios/macos/windows) until
`setup.ts:detectLanguage` learns those stacks — there's no routing target
for them today.

**Value: Med. Effort: M. Confidence: Med** (the "specialist vs generalist"
question is the one with thinnest hard evidence; the enrichment approach is
low-risk regardless).

---

### Gap 4.4 — Reference corpus: port protocol docs (not templates)

**Finding:** The render pipeline **absorbs the templates** (Gap 4.4 is
largely obsolete for templates). Reflection **generates lessons
dynamically** (supersedes the static `lessons-learned/`). What's genuinely
missing as shipped reference is the **protocol docs** that encode design
intent: `pivot-protocol.md`, `iteration-loops.md`, `verification-gates.md`,
`document-naming.md`.

**Recommendation:** Port those 3-4 protocol docs into `docs/` as
contributor-facing reference. They (a) document *why* the pipeline behaves
as it does, aiding contributors; (b) give the `reflection` agent grounding
to read; (c) cost almost nothing. Do **not** port the template `.md.j2`
files (render pipeline owns this) or the static lessons (reflection owns
this).

**Value: Med. Effort: S. Confidence: High.**

---

### Gap 4.6′ (lite) — Simple pivot escalation

Not the full 9-step protocol (Tier 3), but: when stagnation detection
(Tier 1) fires, surface a structured diagnostic to the user (findings,
what was tried, suggestion to revise the spec) rather than silently
finishing with partial results. This is the user-facing half of the pivot
protocol without the automated spec-redraft machinery. ~50 LOC using Pi's
`ctx.ui` / the existing progress channel.

**Value: Med. Effort: S. Confidence: High.**

---

## Tier 3 — SKIP or DEFER (low value, or covered better another way)

### Gap 4.2 — Skill library (30 skills) → SKIP

**Evidence:** 24 of the 30 plugin skills are **thin agent-invoker
wrappers** (`/super-dev:tdd` → invokes `tdd-guide` agent; `/super-dev:code-
review` → invokes `code-reviewer`). In Pi, the agents are already
discoverable and the single `super_dev` tool + `skipStages` covers staged
invocation. Pi's ecosystem *already ships* rich standalone skills
(`tdd`, `code-review-expert`, `diagnose`, `react-dev`, `next-best-practices`,
`database-schema-designer`, `mermaid-diagrams`, …) that overlap the plugin's
`golang`, `test-coverage`, `improve-architecture`, `research` skills.

The 2-3 skills with genuine standalone value (`security-review` checklist,
`build-fix` loop) are better expressed as deterministic helpers (Gap A
covers build-fix) or agent preamble than as separate skill packages.

**Recommendation: SKIP** unless a user specifically asks for a standalone
capability. Maintenance cost (30 skill files across two ecosystems) isn't
justified by the breadth.

**Confidence: Med-High.**

---

### Gap 4.7 — Team-lead execution path → SKIP

**Evidence (research Q1):** The isolated-context model (each specialist a
fresh subprocess/session) is a **deliberate, defensible architecture
choice**. Its wins: reproducibility, no context contamination between
specialists, natural parallelism, hard memory bounds, auditability (each
agent's trace is independent). Its cost: higher per-stage latency, no
shared long context. The plugin's team-lead path traded those for lower
latency and shared context.

Adding a team-lead path would **double the execution surface** (two
runners to maintain, two consistency models) for marginal latency gains.
The rewrite's value proposition is the deterministic, isolated pipeline;
a team-lead path dilutes that. **Skip.** If latency becomes a real
complaint, the cheaper fix is `maxConcurrency` tuning and the session
backend (already default), not a second execution model.

**Confidence: Med-High.**

---

### Auto-test-on-edit (`run-tests` hook) → SKIP (covered by Gap A)

**Evidence:** The original's `run-tests.mjs` is **opt-in**
(`SUPER_DEV_TEST_ON_EDIT=1`) precisely because running tests after every
edit is expensive and latency-heavy. Claude Code's own docs recommend the
**async** variant for this reason. The rewrite already runs tests at the
*right checkpoints*: per-phase in `implementation.ts` (via gate-build) and
in the verify-loop. **Gap A (deterministic gate-build) is the better
answer** — it runs tests at structured convergence points rather than
after every keystroke. Skip the hook.

**Confidence: High.**

---

### Auto-checkpoint (`Stop` hook) → SKIP (covered by worktree)

**Evidence:** The original's `auto-checkpoint.mjs` does `git stash create`
on Stop to preserve uncommitted WIP. The rewrite **already uses git
worktrees** for isolation **and commits on green** per implementation
phase (`implementation.ts:buildCommitPrompt`). Worktree isolation means
uncommitted WIP survives a crash regardless (it's in the worktree, not
lost). The marginal value of stash-checkpoints is low. **Skip.**

**Confidence: High.**

---

### Gap 4.5 — Multi-platform manifests → SKIP (by design)

Pi-only is the stated scope. Not a regression for Pi users.

---

### Gap 4.6′ (full) — 9-step pivot protocol → DEFER

**Evidence:** The pivot protocol is real and well-motivated (born from the
spec-29 postmortem: 3 ad-hoc pivots, ~6 hours, no audit trail). **But** its
trigger is rare ("spec is internally consistent but produces wrong outcomes
in production cases") and it's heavy: requires `visual-verifier` artifacts,
mandatory `AskUserQuestion` human-in-loop, spec redraft + re-review,
historical banners, AC reconciliation. Wiring all of this is a large
effort for an infrequent failure mode.

The Tier-1 stagnation detection + Tier-2 simple escalation capture the
high-frequency value (detect stuck loops, tell the user) without the heavy
machinery. **Defer the full protocol** until there's evidence (from the
reflection loop's `learned.md`) that spec-faithful-but-wrong is actually
occurring in practice.

**Confidence: Med.**

---

### Gap 4.8 — Usage report → DEFER (nice-to-have)

`stats.json` already collects aggregate data via reflection. A
`/super-dev report` command reading it is ~50 LOC. Low priority; do it if
a user asks. **Confidence: High.**

---

## Suggested implementation order

1. **Gap A — deterministic gate-build** (fixes the convergence signal;
   unblocks trusting the verify-loop). ~1 day.
2. **Gap 4.3 — safety wrappers** (session-backend bash/write wrappers +
   subprocess preamble). ~1-2 days.
3. **Gap 4.6 — stagnation detection** in verify-loop. ~half day.
4. *(ship v0.2.0 — "trustworthy convergence + safety")*
5. **Gap 4.1 — enrich LANG_INSTRUCTIONS** from the dedicated agents. ~1-2 days.
6. **Gap 4.4 + 4.6′-lite — port protocol docs + simple escalation UI.** ~1 day.
7. *(ship v0.2.1)*
8. Re-evaluate Tier 3 against `learned.md` evidence after ~1 month of real
   usage. Decide then whether the full pivot protocol or skill packaging
   is justified by observed failure modes.

---

## What I did NOT find evidence for (honest limitations)

- **No fresh benchmark data** on specialist-vs-generalist agent quality
  (research Q4) — search providers were down. The "enrich, don't
  replicate" recommendation is the low-risk choice *regardless* of the
  answer, so this gap doesn't block the recommendation.
- **No fresh SWE-bench convergence-budget data** (research Q3/7). The
  stagnation-detection recommendation rests on general loop-design
  principles + the original's documented design, not a new benchmark.
- The **full pivot protocol's real-world frequency** is unknown for *this*
  codebase — the recommendation explicitly defers it pending `learned.md`
  evidence rather than guessing.

If rigorous external evidence for Q3/Q4/Q7 becomes important, re-run the
researcher subagent when search providers are back online (Exa credits /
Perplexity key / Gemini quota).
