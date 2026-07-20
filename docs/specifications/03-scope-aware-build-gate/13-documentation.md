# Documentation: docs-executor: scope-aware build-gate documentation update (spec-03)

- **Date**: 2026-07-20

---

## Summary

Updated all spec-directory documents to reflect the completed scope-aware build-gate implementation (6 phases, 6 commits 89bdc763–003c88b3, +3517/−32 across 9 files). Implementation is approved (code review APPROVED, 674 tests green, tsc --noEmit clean) with adversarial review CONTEST documenting non-blocking quality concerns. (1) 08-task-list.md — all 19 tasks marked [x] complete with per-task commit hashes, AC/SCENARIO coverage, and a full file-change block (+line counts). (2) 07-implementation-plan.md — all 6 phases marked ✅ COMPLETE with status, commit refs, and dependency notes. (3) 10-implementation-summary.md — expanded from a stub into the full development story: summary, phases, files modified, key decisions (four-tier precedence + [] sentinel, byte-identical backward compat, conservative classifier, command-label exclusion, two-file scope limit), challenges, and a deviations section (D-01…D-07) including the deferred baseline-diff future-work note. (4) 06-specification.md — appended a 'Deviations & Known Limitations (post-implementation)' section (DEF-01…DEF-08) cross-linking each verified deviation to its code-review/adversarial-review finding with original text, implementation, reason, and impact. (5) README.md — rewrote the build-gate Configuration section: fixed the broken SUPER_DEV_BUILD_TEST_PACKAGES example (was 'crates/api,crates/store', an invalid cargo package spec per AR-04) to bare names, documented the new scope-aware behavior (auto-detection of touched crates, build+test+clippy scoping, in-scope classification), and added the new SUPER_DEV_GATE_BASE_REF env var + four-tier precedence. Other spec files (01-requirements ACs all met, 02-BDD scenarios all mapped, 03-research/04-debug/05-code-assessment historical, 09-spec-review passed) needed no change; 11-code-review and 12-adversarial-review are reviewer records and were left intact. verify.ts and the control-flow engine were intentionally untouched (constraint honored).

## Documentation Updates

- **Docs Updated**: docs/specifications/03-scope-aware-build-gate/08-task-list.md (marked all 19 tasks complete with commit hashes + AC/SCENARIO coverage + file-change block); docs/specifications/03-scope-aware-build-gate/07-implementation-plan.md (all 6 phases marked COMPLETE); docs/specifications/03-scope-aware-build-gate/10-implementation-summary.md (expanded into full dev story: summary, phases, files, decisions, challenges, deviations D-01..D-07); docs/specifications/03-scope-aware-build-gate/06-specification.md (appended 'Deviations & Known Limitations' section DEF-01..DEF-08 cross-linked to code/adversarial review findings); README.md (rewrote build-gate Configuration section: fixed broken SUPER_DEV_BUILD_TEST_PACKAGES example per AR-04, documented scope-aware auto-detection + SUPER_DEV_GATE_BASE_REF + four-tier precedence + in-scope classification)

## Deviations Documented

- DEF-01 / D-01: Full baseline-diff (#3) deferred by design — in-scope classification covers the common case; baseline-diff remains future work for no-marker and dependency-cascade failures (spec Out-of-scope; adversarial AR-03)
- DEF-02 / D-02: in-scope verdict wired into only 1 of 3 gate consumers (implementation.ts Stage 9.2); verify.ts gate and Stage 10 reviewFix still key off full errors, so the false-abort relocates to Stage 9/10 (adversarial AR-01, high) — two-file constraint honored
- DEF-03 / D-03: classifier depends on crates/<pkg>/ or -p <pkg> markers surviving a 12-line tail; pre-existing failing TESTS in untouched crates often lack both markers and are misclassified IN-SCOPE (adversarial AR-02, high)
- DEF-04 / D-04: parseTestPackages does not strip crates/ prefix, so the documented example 'crates/api,crates/store' produced an invalid cargo spec; README example corrected to bare 'api,store', module docstring still needs a follow-up (adversarial AR-04, medium)
- DEF-05 / D-05: auto-detection only matches crates/<pkg>/ layout and defaults base ref to main; top-level member dirs, members=["*"], and master/trunk default branches silently fall back to workspace-wide with no log signal (adversarial AR-05, medium)
- DEF-06 / D-06: IN-SCOPE GREEN log extractor cratesFromErrors re-scans the full block incl. the command label, so it lists the in-scope crate among 'ignored' crates — observability-only, gate verdict correct (code-review F-01, medium)
- DEF-07 / D-07: detectTouchedCargoPackages git-diff spawn is not AbortSignal/timeout-aware — acceptable as-is, negligible risk (code-review F-03, low)
- DEF-08: git diff re-spawned on every runBuildGate call (up to ~3×N per run) — pure waste, not a correctness issue (adversarial AR-07, low)
