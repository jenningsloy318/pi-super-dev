# docs/requirements — Creation → Implementation Index

Status: index — chronological history of every doc in this directory (created → what happened)

Numbering: every filename carries an `NNN-` prefix = its **global creation order** (`001-` = oldest, 2026-07-03; ascending = the chronological order of the tables below). A new doc takes the next free number at creation and is never renumbered — numbers are stable identifiers, not rankings.

Maintenance rule: when a new doc lands in `docs/requirements/`, take the next `NNN-` number, append one row to the right era; when a doc's Status changes (grill verdict, implementation wave), update its Outcome cell in the same commit. Outcome versions cite the implementing release (see `CHANGELOG.md` for wave detail).

Scope: 62 docs — 58 committed + 4 in flight (marked ⚠ below). Eras: **Jul** research foundations → **Aug** postmortem-driven hardening (v0.1.x → v0.3.17) → **Sep** eval layer + live-run postmortems + architecture programs.

---

## Era 1 — 2026-07 · Research foundations (3)

| Created | Doc | Kind | Outcome |
|---|---|---|---|
| 07-03 | 001-pi-extens-workflow-claude.md | reference | Pi extension-API research; standalone-orchestration feasibility note |
| 07-22 | 002-graph-engineering.md | reference | Research note; later an input to dsh-09 R1 |
| 07-22 | 003-improvement.md | reference | External article note (graph engineering) |

## Era 2 — 2026-08-01…15 · Early hardening, v0.1.x (11)

| Created | Doc | Kind | Outcome |
|---|---|---|---|
| 08-01 | 004-agent-team-runtime.md | reference | Research note; input to dsh-09 R2/P2 |
| 08-03 | 005-super-dev-workflow-hardening.md | spec | Implemented — rolling hardening 08-01…08-15 (49d13958, de133d19, 3106dc5…) |
| 08-03 | 006-foreground-pi-tui-research.md | reference | TUI behavior research note |
| 08-13 | 007-red-review-loop-root-cause-fix.md | postmortem+fix | Implemented — v0.1.43 (de133d19) |
| 08-13 | 008-convergence-loop-unbounded-cap-fix.md | postmortem+fix | Implemented — v0.1.44 (574e7968), MAX_CONVERGENCE_ROUNDS=8 |
| 08-14 | 012-repo-wide-pipeline-blocker-audit.md | audit | Implemented — v0.1.58 (866e9355, 195542ee, c431bdc5, 3088e3a2); B-6 lenient-degrade decision |
| 08-14 | 011-stagnation-recurrence-testdefects-channel-root-cause.md | postmortem | ANALYSIS ONLY — fix plan (§7) idle |
| 08-14 | 009-unsatisfiable-red-test-resolution.md | analysis/design | NOT implemented — awaiting review |
| 08-14 | 010-stick-logs.md | user note | Reference — sticky TUI shipped (0c035a21) |
| 08-14 | 013-pi-review-loop-learnings.md | learnings | Implemented (3088e3a2, fac1993f, bec0a868, 56da5ffc, 585f50da); R-6 deferred |
| 08-15 | 014-llm-judge-routing-layer.md | proposal | PROPOSAL — awaiting user approval; no source changes |

## Era 3 — 2026-08-16…31 · Postmortem-driven waves + dsh study, v0.1.98 → v0.3.17 (37)

| Created | Doc | Kind | Outcome |
|---|---|---|---|
| 08-16 | 015-run-2026-08-15T13-45-02-boolean-drift-greenfield-extraction-fix.md | postmortem+fix | RESEARCHED — boolean-normalization guard shipped in Stage 14B merge-verify (A-2); doc fix-plan idle |
| 08-16 | 027-postmortem-0001-verify-loop-dead-state.md | postmortem | Implemented — case 1 v0.1.43 (de133d19), case 2 v0.1.75–0.1.76 |
| 08-16 | 026-defensive-patterns.md | rules | Reference rules; each cites its enforcing tests |
| 08-16 | 016-dsh-00-index.md … dsh-08 (9 files) | reference | DeepSeek Harness study series (postmortem→rules convention originates in dsh-06) |
| 08-16 | 025-dsh-09-convergence-plan.md | plan | Implemented — v3 Phase F (7dd18363…) + R1–R5 (4257…) |
| 08-17 | 028-convergence-team-dynamics-root-cause-fixes.md | postmortem+fix | Implemented — v0.1.98 (b99def83) |
| 08-17 | 029-deterministic-convergence-duty-and-spec-reuse.md | spec | Implemented — v0.1.99 (441b97df) |
| 08-18 | 030-cumora-deep-analysis.md | analysis | Reference study of external repo |
| 08-18 | 031-cumora-transfer-plan.md | proposal | PROPOSED — pending decision on items |
| 08-18 | 032-implementation-stage-harness-defects-rc8-rc12.md | postmortem+fix | Implemented — v0.2.2 (bb68cbd5) |
| 08-19 | 033-judge-resilience-v0.2.4.md | spec | Implemented — v0.2.4 (41922404) |
| 08-19 | 034-env-blocker-provenance-arbitration-v0.2.6.md | spec | Implemented — v0.2.6 (7df74054) |
| 08-19 | 035-subprocess-spawn-resilience-v0.2.10.md | spec | Implemented — v0.2.10 (b0538176) |
| 08-20 | 038-judge-challenge-test-exemption-v0.2.11.md | spec | Implemented — v0.2.11 (5edf5429) |
| 08-20 | 036-harness-constraint-comparison.md | research | 4-harness comparative study — no implementation |
| 08-20 | 037-harness-research-and-v0.3.0-architecture.md | spec | Implemented — **v0.3.0 re-architecture** (5edf5429, b0bd757a) |
| 08-20 | 040-class-aware-feedback-and-reviewer-calibration-v0.3.1.md | spec | Implemented — v0.3.1 (091dfb33) |
| 08-20 | 041-contract-claims-layer-v0.3.2.md | spec | Implemented — v0.3.2 (a28dd6a5) |
| 08-20 | 042-ledger-persistence-completion-audit-v0.3.3.md | spec | Implemented — v0.3.3 (c01a831a) |
| 08-20 | 039-reference-repos-full-read-v0.3.x.md | analysis | Full-read reference study — no implementation |
| 08-21 | 043-shape-dual-benchmark-v0.3.4.md | spec | Implemented — v0.3.4 (db286875) |
| 08-21 | 044-routing-architecture-routeback.md | architecture | Implemented — M1–M5 (v0.3.5…v0.3.9) |
| 08-22 | 045-verify-resume-fidelity-v0.3.10.md | spec | Implemented — v0.3.10 (4c97dbe1) |
| 08-22 | 047-sweep3-findings-dossier.md | audit | Consolidated — remediation via v0.3.11 |
| 08-22 | 046-codebase-sweep3-v0.3.11.md | spec | Implemented — v0.3.11 (a82b6687) |
| 08-23 | 048-spec-reuse-numeral-guard-v0.3.12.md | spec | Implemented — v0.3.12 (f38d1921) |
| 08-23 | 049-config-env-settings-v0.3.15.md | spec | Implemented — v0.3.15 (7958a334) |
| 08-24 | 050-red-timeout-honesty-v0.3.16.md | spec | Implemented — v0.3.16 (eeb8d3e6) |
| 08-26 | 051-conftest-hollow-guard-exemption-v0.3.17.md | spec | Implemented — v0.3.17 (3427bc51) |

## Era 4 — 2026-09 · Eval layer + live-run postmortems + architecture programs (9)

| Created | Doc | Kind | Outcome |
|---|---|---|---|
| 09-10 | 052-run-2026-09-09-poisoned-baseline-postmortem-v0.3.85.md | postmortem+fix | Implemented — v0.3.85 wave (F1–F5 + S1–S3) |
| 09-11 | 056-eval.md | source material | ABSORBED into 055-sdlc-tips-adoption.md (DEC-13) |
| 09-11 | 054-question.md | Q&A | ANSWERED (async-subagent spawn question, grill pass 2) |
| 09-11 | 053-code-review-full-codebase-2026-09-10.md | review report | 18 findings (2C/6H/7M/3L) — input to subsequent waves |
| 09-11 | 055-sdlc-tips-adoption.md | spec | Implemented — **v0.3.89 / v0.3.90 / v0.3.91** (P1 eval-layer, P2 dual scorers, P3 flywheel+firewall) |
| 09-13 | 057-run-2026-09-12T15-16-29-042Z-antigravity-model-exclusion-root-cause.md | postmortem | Postmortem complete — operator remediation (npm pi-antigravity); durable fixes in v0.3.95 (thinking-fidelity); upstream-watch errata 9b3bcd3b |
| 09-13 | 058-cross-phase-contract-architecture.md | architecture | Implemented — P1 **v0.3.96** (D-A+D-C), P3 **v0.3.97** (D-E ledger superseding), P2 **v0.3.99** (D-B two-strike + D-D checkpoint rollback) |
| 09-13 | 059-reviewer-quality-architecture.md | architecture | Implemented — R1A **v0.3.98** (inventory + writer declaration + R4 exemption), R1B/R2 **v0.4.1** (reviewer slice injection + offline harness), **v0.4.2** (demand-set laws hotfix) |
| 09-14 | 061-ai-workflow-vs-harness-engineering.md | reference | Saved from Medium (@june-in-exile) — AI 工作流 vs. Harness Engineering (11-step loop, test lock, attempt budget, 9 quality gates) + deepset grounding: 5 harness layers, externalize memory/skills/protocols, 4-way failure classification, constrain-more-not-less |
| 09-15 | 062-temporal.md | reference | Online research — Temporal durable execution vs. our resume/checkpoint/convergence machinery; 8 stealable patterns (L1–L8), Cursor case study with hard numbers |
| 09-15 | 063-external-state-store.md | architecture | Draft — decouple state from the content tree (Option A, `~/.super-dev/state/<project-key>/<spec-id>/`); class-driven durability R/M/H/E; fixes the v0.4.3 truncation class + the $59 orphan class |

## In flight

| Doc | Note |
|---|---|
| ⚠ 060-communitcation-mechanism.md | Parallel-session draft — grounded against the OpenAI Agents SDK orchestration/handoffs guides: agents-as-tools vs handoffs, guardrail-scope asymmetry, code orchestration patterns |
| ⚠ 064-cora-skill.md | COBRA-Skills paper study (arXiv:2609.11682) — contextual-bandit eval allocation, no-inherited-reward, scheduled log-spaced evolution; 4 transferable lessons |

---

## Feature ownership (post-decoupling, 2026-09-15)

The 09-15 doc family (060/061/063/064) overlaps on three things: `.knowledge.json`
externalization, `messages.jsonl` as a state channel, and the
attempt-budget/failure-classification machinery. A decoupling pass on 2026-09-15
assigned every feature to exactly **one** owner so the units can be implemented
sequizontally without contention. 060/061/064 are **references** (own nothing
implementable, supply rationale); **063 is the only spec.**

### Ownership table

| Feature | Owner | Status | Consumers / rationale source |
|---|---|---|---|
| External state location + `stateFile()` resolver + registry split + migration + orphan reconciliation + `findResumableSpec` external scan | **063** (D-S-A…E) | spec, READY-pending-grill | 061 §5 ("state outside the message stream"), 060 §5 (channel descriptions) |
| `.knowledge.json` *file location* | **063** (Class R) | part of the above | — |
| `.knowledge.json` *extraction semantics* (control objects → prompt slices) | existing behavior (`knowledge.ts`) | not a feature | 060 §5 documents it |
| `.knowledge.json` Check-3 `amendmentFamily` exemption *logic* | existing behavior (`protection-interval.ts:94`, `plan-feasibility.ts:448`) | not a feature — but 063 D-S-B must redirect these two reads | 063 DEC-5 (corrected) |
| `messages.jsonl` *file location* | **063** (Class H) | part of the state family | — |
| `messages.jsonl` *bus protocol* (sender/receiver/subject/`inReplyTo`, ledger double-write) | existing behavior (`team/messages.ts`) | not a feature | 060 documents it |
| Wall fuses / `repeatedNoProgress` / two-strike intervals / fault classes | existing behavior + **058** | not in this family | 061 §6 supplies the external rationale; 061's "1:1 map" claim corrected to "shape only" |
| Anchor superseding (no inherited green stamp) | **058/059** | existing | 064 lesson 2 is justification, not a feature |
| Eval layer + 059 R5 reviewer harness | **059** | existing | 064 lesson 3 would consume it |
| Guardrail-scope asymmetry audit | *candidate future spec* | rationale in 060 §2 | test-only wave; depends on nothing |
| Progressive tool disclosure / prompt-slice budget | *candidate future spec* | rationale in 061 §5 | — |
| Bandit-driven eval allocation | *candidate future spec* | rationale in 064 §5 | needs an embedding model; depends on 063 S2 |

### Sequential implementation order

1. **063 Wave S1** — `state-root.ts` + registry split + acceptance gates; `.resume-cache.jsonl` migrated as the live proof. (Class M, the incident class.)
2. **063 Wave S2** — the remaining resolution sites (including the two `.knowledge.json` engine reads) + migration/reconciliation + `findResumableSpec`.
3. **060-derived audit** (candidate) — guardrail-scope asymmetry; test-only, no dependency on 1–2.
4. **061-derived** (candidate) — progressive tool disclosure.
5. **064-derived** (candidate) — bandit-driven eval allocation; depends on 2.

Units 3–5 are rationale-only in their source docs; each becomes a numbered spec
before implementation. Nothing in the family is implementable before S2 except
unit 3, which is test-only.
