# dsh-00 — DeepSeek Harness Study Series: Index

Status: reference — study-series index

A deep-dive study of DeepSeek Harness (`dsh`), the Cordis plugin framework underneath
it, its academic paper, and the independent Orange Book field report. Produced to
extract transferable engineering lessons for pi-super-dev.

## Source material (local, under `docs/references/`)

| Source | Location | Nature |
|---|---|---|
| dsh repo (MIT, developer preview) | `docs/references/deepseek-harness` | 219 packages, 120+ docs, 688 decision notes, 4 postmortems |
| Orange Book (花叔, v260814, CC BY-NC-SA) | `docs/references/deepseek-harness-orange-book` | Independent 24-hour teardown by a non-coder (zh) |
| Cordis paper (Shi/Zhang/Cui, PKU & DeepSeek) | `docs/references/cordiverse-paper/paper.pdf` | "A Programming Paradigm for Spatiotemporal Composability" |
| Quickstart (fetched page) | `docs/references/quickstart.html` | Official docs quickstart mirror |

Sources are local clones/mirrors for reference only and are deliberately NOT
committed (nested git trees, third-party licenses).

## Reports (this series)

| # | File | Focus | Primary evidence |
|---|---|---|---|
| 01 | `dsh-01-architecture-overview.md` | Everything-is-a-plugin substrate; profiles/bundles/patch boot composition; core spine; three event domains; capability seams; module graph; 10 design decisions with trade-offs | `docs/architecture.md`, generated catalogs, bundle/boot READMEs |
| 02 | `dsh-02-cordis-paradigm-paper.md` | The paper in full: revertible effects, reactive coeffects, unified context Γ∞, component calculus, metatheory (recovery exactness, ordering, progress, confluence), theory→runtime mapping, critical assessment incl. when NOT to use | paper §1–8, vendored `vendor/cordis/src/*`, cordis-api docs |
| 03 | `dsh-03-agent-lifecycle-session.md` | Turn/step state machine; append-only SessionEvent log; "model-visible means logged"; deriveMessages projection; fork/resume; subagent providers; plan/goal; compaction & spill; user-questions; cancellation & recovery | `docs/agent-lifecycle.md`, `docs/subsystems/{session*,core,subagent,plan,goal,compaction,spill,...}.md` |
| 04 | `dsh-04-security-sandbox-approval.md` | Sandbox rung ladder; approval seam (fail-closed); permission presets; credentials & env scrubbing; defensive-patterns rules with motivating bug stories; rejected designs (landstrip etc.) | `docs/subsystems/{sandbox,approval,permission-presets,credentials,fs,subprocess}.md`, postmortems 0002/0004, rejected notes |
| 05 | `dsh-05-extension-ecosystem-tools.md` | Tool pipeline (pre-execute → guards → approval → execute → post-execute); skills/MCP/commands/jobs; api-gateway; conversation nodes; in-tree vs out-of-tree distribution; developer experience; trade-offs | `docs/capability-seams.md`, cookbook/*, `docs/user/develop/*` |
| 06 | `dsh-06-engineering-philosophy-process.md` | Agent Note lifecycle (proposed/implemented/rejected/archived); postmortem culture; package-owned runtime invariants + mechanical gate; testing philosophy; bilingual docs discipline; vendoring/rescope; AI-written-codebase evidence | AGENTS.md files, `docs/testing.md`, all 4 postmortems, 688 notes census |
| 07 | `dsh-07-orange-book-field-report.md` | The field test: boot manifest, system prompt internals, PTC cost inversion (+9% fixed overhead), creation mode (model builds its own tool in 19 steps), permission experiments, per-task cost accounting, code archaeology (12,293 commits/64 days), "they wanted to, then didn't" rejected-design catalog | full Orange Book text (zh → en report) |
| 08 | `dsh-08-lessons-for-pi-super-dev.md` | **The synthesis**: L-1..L-7 adoptions (invariants registry, decision lifecycle, postmortems→rules, generated docs, mode-tagged contracts, unified event log, loop vocabulary), M-1..M-4 situational, what NOT to copy, priority table | dsh-01..07 + pi-super-dev's own incident history |

## Reading order

- **Want the takeaways only**: dsh-08 (§1 priority table) — 10 minutes.
- **Want the architecture**: dsh-01 → dsh-03 → dsh-05.
- **Want the theory**: dsh-02 (paper) — the metatheory and its critique.
- **Want security**: dsh-04.
- **Want process lessons**: dsh-06 + dsh-07 §144 (note institution).
- **Want field evidence**: dsh-07.
