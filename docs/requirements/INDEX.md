# docs/requirements — Creation → Implementation Index

Status: index — chronological history of every doc in this directory (created → what happened)

Numbering: every filename carries an `NNN-` prefix = its **global creation order** (`001-` = oldest, 2026-07-03; ascending = the chronological order of the tables below). A new doc takes the next free number at creation and is never renumbered — numbers are stable identifiers, not rankings.

Maintenance rule: when a new doc lands in `docs/requirements/`, take the next `NNN-` number, append one row to the right era; when a doc's Status changes (grill verdict, implementation wave), update its Outcome cell in the same commit. Outcome versions cite the implementing release (see `CHANGELOG.md` for wave detail).

Scope: 60 docs — 58 committed + 2 in flight (marked ⚠ below). Eras: **Jul** research foundations → **Aug** postmortem-driven hardening (v0.1.x → v0.3.17) → **Sep** eval layer + live-run postmortems + architecture programs.

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

## Era 4 — 2026-09 · Eval layer + live-run postmortems + architecture programs (8)

| Created | Doc | Kind | Outcome |
|---|---|---|---|
| 09-10 | 052-run-2026-09-09-poisoned-baseline-postmortem-v0.3.85.md | postmortem+fix | Implemented — v0.3.85 wave (F1–F5 + S1–S3) |
| 09-11 | 056-eval.md | source material | ABSORBED into 055-sdlc-tips-adoption.md (DEC-13) |
| 09-11 | 054-question.md | Q&A | ANSWERED (async-subagent spawn question, grill pass 2) |
| 09-11 | 053-code-review-full-codebase-2026-09-10.md | review report | 18 findings (2C/6H/7M/3L) — input to subsequent waves |
| 09-11 | 055-sdlc-tips-adoption.md | spec | Implemented — **v0.3.89 / v0.3.90 / v0.3.91** (P1 eval-layer, P2 dual scorers, P3 flywheel+firewall) |
| 09-13 | 057-run-2026-09-12T15-16-29-042Z-antigravity-model-exclusion-root-cause.md | postmortem | Postmortem complete — operator remediation (npm pi-antigravity); durable fixes in v0.3.95 (thinking-fidelity); upstream-watch errata 9b3bcd3b |
| 09-13 | 058-cross-phase-contract-architecture.md | architecture | Grilled ×3 → P1 implemented **v0.3.96** (4d45025a, D-A+D-C); **P2 (D-B+D-D) pending** |
| 09-13 | 059-reviewer-quality-architecture.md | architecture | Draft — awaiting grill; review-side escape class (R-A…R-E, layers R1–R5) |

## In flight

| Doc | Note |
|---|---|
| ⚠ 060-communitcation-mechanism.md | Parallel-session draft — untracked (intentional filename), numbered by position not git history |
| 059-reviewer-quality-architecture.md | Committed (dabe0f96); grill round 1 verdict NOT-READY (conditional) — fold pending |
