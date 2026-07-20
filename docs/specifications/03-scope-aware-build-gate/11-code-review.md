# Code Review: Code Review — Scope-Aware Build Gate (spec 03)

- **Date**: 2026-07-19
- **Author**: super-dev:code-reviewer
- **Verdict**: Approved

---

## Verdict: Approved

Reviewed the scope-aware build-gate implementation (src/build-runner.ts + src/stages/implementation.ts + 6 new test files) against the 7 acceptance criteria and 29 scenarios. `npm run typecheck` (tsc --noEmit, strict) is clean and the full suite is green (38 files, 674 tests). All ACs are met: AC-01 `detectTouchedCargoPackages` (never-throws, discrete-argv git spawn, correct path→pkg mapping/dedupe/order, base-ref precedence); AC-02 four-tier package-set precedence with the git-diff spawn skipped when a higher tier supplies a value; AC-03 `BuildGateResult` carries additive `outOfScopeErrors` + `inScopePass`, with both `--> crates/<pkg>/` and `-p <pkg>` markers recognized and the command label's own `-p` correctly excluded from classification; AC-04 the retry loop treats `pass || inScopePass` as GREEN and only terminates-early on genuine in-scope failures; AC-05 `scopedCargoTestArgs` preserved byte-identical with new `scopedCargoBuildArgs`/`scopedCargoClippyArgs` siblings; AC-06/07 comprehensive new tests + gates pass. The four-tier precedence, empty-set byte-identical fallback, never-throw contract, and additive-only `BuildGateResult` are all correctly implemented and the change is genuinely backward-compatible (non-Cargo / non-git / no-touched-crates paths produce identical argvs and results modulo two additive fields). Security is solid: no `shell:true` anywhere, `baseRef`/package names flow as discrete argv elements (no injection surface), no secrets in logs. One Medium defect found: the IN-SCOPE GREEN log extractor in implementation.ts re-scans the FULL error block (label + tail) for `-p <pkg>` markers and so re-admits the scoped command label's own `-p <pkg>`, producing a misleading "ignored out-of-scope crates: data,compute" log that lists the IN-SCOPE crate as ignored. This is observability-only (the gate verdict itself is correct because the classifier in build-runner.ts properly excludes the label via flagRegion slicing), but it directly contradicts the feature's semantic intent and is untested because the stage-test fixture omits the real label+tail block shape. Recommend a follow-up to either reuse `classifyOutOfScopeErrors`'s extraction (DRY) or apply the same ` FAILED (` flagRegion slice in `cratesFromErrors`. No Critical or High issues; verdict Approved.

## Findings

### F-01: IN-SCOPE GREEN log lists the in-scope crate among "ignored out-of-scope crates" (test/prod gap)

- **Severity**: Medium
- **File**: `src/stages/implementation.ts`
- **Line**: 20-32
`cratesFromErrors(gate.outOfScopeErrors)` re-scans the WHOLE error block with `pkgRe = /(?:^|\s)-p\s+(\S+)/g` to populate the `(crates: …)` portion of the IN-SCOPE GREEN log. But `runBuildGate` assembles each error block as `${label} FAILED (${reason}):\n${tail}` where the label is e.g. `cargo build -p data --quiet` — i.e. the block STRING still carries the scoped command's own `-p data`. So for a real out-of-scope failure the extractor collects BOTH `data` (from the label) and `compute` (from the tail), and the log prints `pre-existing out-of-scope failure(s) ignored (crates: data,compute)`. That lists `data` — the active in-scope crate — as an ignored pre-existing crate, which is exactly the distinction the whole feature exists to make and is the operator's only window into why a phase committed despite failures. The gate VERDICT is unaffected because `classifyOutOfScopeErrors` in build-runner.ts carefully excludes the label by scanning `-p` only on the post-` FAILED (` flagRegion; `cratesFromErrors` does NOT replicate that exclusion, so the two are inconsistent. The bug is untested: the stage-test fixture `GATE_INSCOPE_PASS` uses a bare `"error[E0308]: ... --> crates/compute/..."` string with no label, so `cratesFromErrors` happens to yield only `compute` and the assertion `toContain("compute")` passes — but a fixture matching the real label+tail shape (e.g. `"cargo build -p data --quiet FAILED (exit 101):\n  --> crates/compute/src/jobs.rs:42:10"`) would expose `data` in the output. Suggested fix: in `cratesFromErrors`, apply the same `indexOf(" FAILED (")` flagRegion slice before running `pkgRe` (scan pathRe on the whole block, scan pkgRe only on the tail), or — better — export a single `referencedCrates(block)` helper from build-runner.ts and reuse it in both the classifier and the log extractor to eliminate the duplicated regex logic that caused the divergence. Add a stage test whose fixture carries the real label+tail shape to pin the contract.
### F-02: Duplicated crate-extraction regex across build-runner.ts and implementation.ts (DRY)

- **Severity**: Low
- **File**: `src/stages/implementation.ts`
- **Line**: 26-27
`cratesFromErrors` duplicates `pathRe = /crates\/([^/]+)\//g` and a `-p` extractor that already live (with subtly different, label-aware semantics) in `classifyOutOfScopeErrors`. This duplication is the root cause of F-01: the two drifted (the classifier gained flagRegion slicing; the log extractor did not). Consolidating into one shared, exported helper would prevent future drift and shrink the surface. Non-blocking; mention as cleanup.
### F-03: git-diff spawn is not AbortSignal/timeout-aware

- **Severity**: Low
- **File**: `src/build-runner.ts`
- **Line**: 165-176
`detectTouchedCargoPackages` calls `spawnSync("git", [...], { encoding: "utf8" })` with no `timeout` and does not consult `opts.signal` (the helper signature doesn't take opts). `runBuildGate`'s other spawns honor both `resolveTimeoutMs()` and `opts.signal?.aborted`. In practice `git diff --merge-base <ref> --name-only` is fast and bounded so this is a negligible real-world risk, and the spec explicitly permits exactly this one extra spawn. Noting only for completeness: if a base ref triggers an expensive merge-base walk on a huge repo, or git hangs, the gate would block longer than the configured per-command timeout. Acceptable as-is; consider passing a conservative timeout (e.g. a few seconds) in a future pass.
