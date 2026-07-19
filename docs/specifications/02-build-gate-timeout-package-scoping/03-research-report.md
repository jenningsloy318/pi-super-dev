# Research Report: Build-gate timeout env-config + Cargo `-p` test-scoping: resolution of the 4 open issues

- **Date**: 2025-07-19
- **Author**: super-dev:research-agent

---

## Summary

All four previously-open issues (ISS-001..ISS-004) are resolved with direct code/Node evidence, clearing the research gate. (1) Timeout: Node's spawnSync({timeout}) kills the child on expiry with a reliable `error.code === "ETIMEDOUT"`, `status: null`, `signal: "SIGTERM"` — confirmed by a local Node v24.15.0 repro, not just docs — so the 120s hardcoded default (src/build-runner.ts:22) is the sole culprit. It is raised to 600_000 and made env-configurable via SUPER_DEV_BUILD_TIMEOUT_MS, resolved inside runBuildGate so all three call sites (which pass only `{ signal: ctx.signal }`: index.ts:53, implementation.ts:64, verify.ts:87) need zero change (satisfies AC-05). (2) Scoping: cargo's `-p/--package [<SPEC>]` is repeatable (`cargo test -p a -p b --quiet`); SUPER_DEV_BUILD_TEST_PACKAGES (comma-list) maps to repeated -p flags for language==='rust' only, falling back to workspace-wide `cargo test --quiet` when unset (backward-compatible, AC-03/AC-06). Precedence `opts.testPackages > env > workspace-wide` keeps the helper unit-testable without env mutation (AC-02/AC-04). ISS-001 resolved: the per-command (not per-stage) nature is documented in a new README "Configuration" section + code comment (a clean workspace may occupy the stage ~3× this value). ISS-002 resolved-as-flagged: spawnSync is blocking by design and consistent with the existing harness; the documented future async path is child_process.spawn + Promise.race vs setTimeout (or extending the already-present `opts.signal` AbortController plumbing). ISS-003 resolved: the local repro proves `r.error.code === 'ETIMEDOUT'` is a reliable discriminator, making the one-line "timed out after Nms (raise SUPER_DEV_BUILD_TIMEOUT_MS)" branch cheap and actionable — recommended polish. ISS-004 resolved: `DEFAULT_TIMEOUT_MS` is a NON-exported bare const referenced only in build-runner.ts (lines 22, 160), no test asserts on 120_000, and `opts.timeoutMs ?? DEFAULT_TIMEOUT_MS` preserves the override path, so raising to 600_000 is safe. The fix mutates only harness argv + timeout; the target repo is never touched (AC-09).

## Options Considered

### Resolve timeout + scoping internally in build-runner.ts (env-read inside the helper); call sites unchanged

Zero call-site churn — verify.ts:87, implementation.ts:64, index.ts:53 already pass only `{ signal: ctx.signal }`, so reading SUPER_DEV_BUILD_TIMEOUT_MS / SUPER_DEV_BUILD_TEST_PACKAGES internally satisfies AC-03/AC-05 with no stage edits, minimizing diff against the 'pure TS change to build-runner.ts' constraint. Single parse site (defensive parseInt with NaN/<=0 fallback to 600_000; comma-list trim/filter/dedupe) avoids duplication. Cost: env reads are implicit/global, slightly harder to discover — mitigated by a code comment at the DEFAULT_TIMEOUT_MS site (AC-10) and keeping explicit `opts.testPackages`/`opts.timeoutMs` overrides for unit tests (AC-02/AC-04). Recommended path.
### Resolve env at each call site and pass { timeoutMs, testPackages } explicitly

More visible/explicit per stage. But duplicates env-parsing across 3 call sites, directly contradicts AC-05 ('call sites require NO change'), and bloats the diff. Rejected.
### Cargo scoping via repeatable `-p pkg -p pkg` flags (vs single `-p a,b`)

Repeatable `-p` is universally supported across cargo versions and maps 1:1 from a parsed list (one flag per package). Comma-joined `-p a,b` only works on newer cargo and is more fragile to parse/escape. Recommended form: `cargo test -p pkg1 -p pkg2 --quiet` (--quiet retained), with empty/unset -> `cargo test --quiet` unchanged (AC-03/AC-06).
### Add the optional ETIMEDOUT-discriminator branch (ISS-003 polish)

Local Node v24 repro confirms `r.error.code === 'ETIMEDOUT'` (status:null, signal:SIGTERM) is a stable discriminator, so a one-line branch emitting e.g. `${label} TIMED OUT after ${timeoutMs}ms (raise SUPER_DEV_BUILD_TIMEOUT_MS)` makes Stage-9 abort messages immediately actionable. Very low cost, no AC risk. Recommended to include; if strictly minimizing scope it can be deferred (not in any AC).
