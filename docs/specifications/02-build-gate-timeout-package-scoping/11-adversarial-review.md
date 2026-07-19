# Adversarial Review: Adversarial Review — build-gate timeout & package scoping (Fix 1 + Fix 2)

- **Date**: 2025-11-21
- **Reviewer**: super-dev:adversarial-reviewer
- **Verdict**: PASS

---

The implementation correctly fixes both stated blockers and meets all six acceptance criteria. Fix 1 raises DEFAULT_TIMEOUT_MS to 600_000 and adds a pure, well-tested resolveTimeoutMs(explicit?) that honors SUPER_DEV_BUILD_TIMEOUT_MS (defensive parseInt with NaN/<=0/empty/missing fallback) and threads into the existing spawnSync({timeout}) closure — zero call-site edits, exactly as the task recommended. Fix 2 adds pure parseTestPackages() + scopedCargoTestArgs() helpers and applies -p scoping only when language==='rust' and the list is non-empty, on a shallow copy so detectProjectCommands stays byte-identical. All three call sites (verify.ts:87, implementation.ts:64, index.ts:53) are confirmed unchanged and pass only { signal }; backward compatibility for non-Cargo repos is intact (workspace-wide fallback). Verified locally: `npm run typecheck` clean, 63/63 new unit tests green (timeout + packages + docs). Destructive-action gate: clean — no DROP/rm -rf/force-push/auth-disable; the target repo is explicitly never mutated (scoping is argv-only). No high-severity findings. The issues below are low-to-medium quality concerns that do not risk production, hence PASS rather than CONTEST. Severity inflation is avoided by design.

### ADV-1: Scoping is test-only: cargo build and cargo clippy still run workspace-wide, so the gate stays red on workspaces with a non-compiling/unlinted sibling crate

- **Severity**: medium
- **Lens**: Architect
Fix 2 scopes only the `cargo test` argv (build-runner.ts scopedCargoTestArgs → runBuildGate replaces cmds.test on the shallow copy). The `cargo build --quiet` and `cargo clippy --all-targets --quiet` commands are never scoped, so a workspace where an unrelated crate fails to compile or trips clippy will keep the gate permanently red regardless of SUPER_DEV_BUILD_TEST_PACKAGES. This precisely resolves the *stated* blocker (pre-existing DB-integration *tests*) and satisfies AC-02/AC-03 verbatim, but it is a narrower fix than the prose goal 'so it stays permanently red → review can never reach Approved.' Recommendation: document this boundary explicitly in the JSDoc/README (e.g. 'scopes test only; build/clippy remain workspace-wide') so users don't expect the env var to green a half-broken workspace, or add parallel SUPER_DEV_BUILD_PACKAGES / SUPER_DEV_BUILD_SCOPE that also narrows build+clippy when desired. File: src/build-runner.ts (runBuildGate scoping block ~lines 245-265).
### ADV-2: Duplicate de-duplication logic: parseTestPackages reimplements the module-level dedupePreservingOrder helper

- **Severity**: low
- **Lens**: Minimalist
dedupePreservingOrder() is defined at module scope and used by runBuildGate for the opts.testPackages path, but parseTestPackages() contains its OWN inline Set-based dedupe (the `seen`/`out` loop). Two implementations of the same order-preserving dedupe algorithm now coexist. parseTestPackages could be a one-liner: `return dedupePreservingOrder(raw.split(',').map(s => s.trim()).filter(Boolean))`. Harmless (results agree, both tested) but it is the kind of drift that bites later when one path gets a tweak (e.g. case-folding) and the other doesn't. Recommendation: collapse parseTestPackages onto dedupePreservingOrder. File: src/build-runner.ts.
### ADV-3: Override params opts.timeoutMs / opts.testPackages are exercised only by tests — no production caller passes them

- **Severity**: low
- **Lens**: Minimalist
All three call sites pass { signal } only (confirmed via grep), so opts.timeoutMs and opts.testPackages are dead in the production path and exist purely for unit-testability / hypothetical future use. The task explicitly sanctioned this ('call sites need no change OR can override explicitly'), so it is in-spec, but it is opt-in surface area with a single real consumer (tests). If the 'override explicitly' branch is never wired by a stage, consider dropping the opts and resolving purely from env, or add a one-line call-site note that env is the intended channel. Low because it is sanctioned and tested; flagged for the Minimalist record.
### ADV-4: Lenient parseInt silently accepts malformed env values (e.g. '900abc' → 900, '300s' → 300)

- **Severity**: low
- **Lens**: Skeptic
resolveTimeoutMs uses Number.parseInt(raw, 10), which stops at the first non-digit. So SUPER_DEV_BUILD_TIMEOUT_MS='900abc' resolves to 900ms (not the default) and '300s' (a plausible '300 seconds' typo) resolves to 300ms — both dangerously short and indistinguishable from a valid value. The whitespace-trim case is tested and documented, but trailing-garbage acceptance is not. Recommendation: either validate the full string with Number(raw) / a strict integer regex and fall back on any mismatch, or at minimum add a test asserting '900abc'→default so the behavior is pinned rather than incidental. File: src/build-runner.ts resolveTimeoutMs.
### ADV-5: Pre-existing: flag[key] stays true for commands the detector didn't emit (buildSuccess/allTestsPass reported true when nothing ran)

- **Severity**: low
- **Lens**: Skeptic
Not introduced by this change (it predates Fix 1/2 and is out of the stated scope), but a Skeptic pass through the file notices it: `flag` initializes all three keys to true and is only flipped to false inside exec(). If detectProjectCommands omits cmds.build (e.g. a python repo with no build script), buildSuccess is returned as true even though no build ran. runBuildGate.pass is still correct (driven by errors[]), but the per-field booleans can over-report. The 'greenfield → pass:true, ran:[]' contract documents the empty case; the partial case does not. No action required for this PR; flagging so it is a conscious omission, not an oversight.
